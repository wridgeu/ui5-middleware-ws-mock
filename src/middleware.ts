/**
 * UI5 custom server middleware factory. Exposes per-route WebSocket mocking
 * via a handler-module pattern similar to `sap-fe-mockserver`'s mockdata
 * handlers.
 *
 * Registers one `WebSocketServer` (in `noServer` mode) for the whole ui5
 * serve process. The server's `upgrade` event is hooked via the community
 * utility `ui5-utils-express/lib/hook` (which intercepts `app.listen` to
 * grab the underlying HTTP server; see the hook source for the full trick).
 * On each upgrade we match the request's pathname against our route table —
 * `path-to-regexp` patterns tried in declaration order, first match wins —
 * and on a match hand the socket to `wss.handleUpgrade`, exposing any
 * extracted path parameters on `ctx.params`. A pathname that matches no route
 * (or whose percent-encoding cannot be decoded) is left unclaimed so other
 * middleware (fe-mockserver etc.) can handle it. Unparseable urls log at
 * verbose and bail too.
 *
 * PCP subprotocol negotiation is declared via `handleProtocols` at
 * WebSocketServer construction: if the client offered `v10.pcp.sap.com` we
 * echo it, otherwise we let the connection proceed with no subprotocol.
 * `ws.protocol` after the handshake decides per-connection encoding mode.
 *
 * The middleware is transport-only beyond the wire layer: plain frames are
 * forwarded as raw strings, PCP frames are decoded into `{ fields, body }`.
 * Path-level routing (pattern matching, `ctx.params`) is handled here;
 * application-level routing (named messages → callbacks) and payload encoding
 * remain the handler's job.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { IncomingMessage, Server } from "node:http";
import { Buffer } from "node:buffer";
import { WebSocketServer, type WebSocket } from "ws";
import {
	match as compilePath,
	parse as parsePattern,
	type MatchFunction,
	type Token,
} from "path-to-regexp";
// @ts-expect-error -- ui5-utils-express ships no type declarations; the module is a thin
// server-listening hook that returns a UI5-compatible middleware factory.
import hook from "ui5-utils-express/lib/hook.js";

import type {
	InboundMessage,
	RouteParams,
	WebSocketContext,
	WebSocketHandler,
	WebSocketLog,
	WebSocketMiddlewareConfiguration,
	WebSocketMode,
	WebSocketRoute,
} from "./types.js";
import { decode, encode, SUBPROTOCOL, type EncodeOptions } from "./pcp.js";

interface LoadedRoute {
	route: WebSocketRoute;
	/** Absolute path the handler module was (or would have been) loaded from. */
	absolutePath: string;
	handler: WebSocketHandler | null;
	loadError?: unknown;
	/**
	 * `mountPath` compiled into a `path-to-regexp` matcher, or `null` if the
	 * pattern failed to compile (`matchError` is set; the route can never match).
	 */
	match: MatchFunction<RouteParams> | null;
	/** Error thrown while compiling `mountPath`, if any. */
	matchError?: unknown;
	/**
	 * Parsed `mountPath` tokens, reused for the startup pattern-shape diagnostics.
	 * Empty when the pattern failed to parse (`matchError` is set).
	 */
	tokens: Token[];
}

/** A route matched against an upgrade pathname, with its extracted params. */
interface MatchedRoute {
	entry: LoadedRoute;
	params: RouteParams;
}

interface FactoryParameters {
	/**
	 * `@ui5/logger/Logger` instance the UI5 tooling passes in. `@ui5/logger`
	 * ships no types, so we describe a structural subset matching the six v4
	 * level methods (`silly`, `verbose`, `perf`, `info`, `warn`, `error`).
	 * Versions older than v4 are not supported.
	 */
	log: WebSocketLog;
	options: {
		/** Value of `customMiddleware[].configuration` as declared in `ui5.yaml`. */
		configuration?: Partial<WebSocketMiddlewareConfiguration>;
		/** Middleware name from `ui5.yaml` (unused here; UI5 tooling always provides it). */
		middlewareName?: string;
	};
	/**
	 * `@ui5/server/middleware/MiddlewareUtil` instance (specVersion 3.0+).
	 * Structural subset; @ui5/server ships no type declarations. We use
	 * `getRootPath()` to anchor a `rootPath` override and `getSourcePath()`
	 * as the default handler root.
	 */
	middlewareUtil: {
		getProject(): {
			getRootPath(): string;
			getSourcePath(): string;
		};
	};
}

interface HookCallbackArgs {
	server: Server;
}

/** Route-scoped log prefix, e.g. `[ws-mock:/ws/foo]`. */
function routeTag(mountPath: string): string {
	return `[ws-mock:${mountPath}]`;
}

/**
 * True when `mountPath` has no leading static segment, so its matcher claims
 * upgrade paths from the URL root rather than under a literal prefix. Such a
 * route (e.g. `/{*splat}`, `/:kind`) silently swallows upgrades meant for other
 * listeners (ui5-middleware-livereload's WS channel etc.), defeating the
 * coexistence contract. A bare-root literal (`/`) is scoped (it matches only
 * `/`), so it is not flagged.
 */
function lacksStaticPrefix(tokens: Token[]): boolean {
	const first = tokens[0];
	if (!first || first.type !== "text") return true; // opens with a dynamic part
	if (/[^/]/.test(first.value)) return false; // has a real literal segment
	return tokens.length > 1; // root-only literal followed by a dynamic part
}

/** Param/wildcard names that appear more than once in the pattern (any depth). */
function duplicateParamNames(tokens: Token[]): string[] {
	const seen = new Set<string>();
	const dupes = new Set<string>();
	const walk = (ts: Token[]): void => {
		for (const token of ts) {
			if (token.type === "param" || token.type === "wildcard") {
				if (seen.has(token.name)) dupes.add(token.name);
				else seen.add(token.name);
			} else if (token.type === "group") {
				walk(token.tokens);
			}
		}
	};
	walk(tokens);
	return [...dupes];
}

/**
 * Resolves the effective root that `routes[].handler` paths resolve against:
 *
 *   1. `configuration.rootPath` (if set): resolved relative to the project root.
 *      `"."` keeps the legacy project-root behavior; absolute paths pass through.
 *   2. Otherwise: the UI5 project's source path. Per `@ui5/project` v4:
 *      Application returns `<root>/<webappPath>` (defaults to `webapp`),
 *      Library and ThemeLibrary return `<root>/<srcPath>` (defaults to `src`),
 *      and Module throws (it has more than one source path). On Module
 *      projects the throw propagates; set `configuration.rootPath` to bypass.
 */
function resolveHandlerRoot(
	project: ReturnType<FactoryParameters["middlewareUtil"]["getProject"]>,
	rootPathOverride: string | undefined,
): string {
	if (rootPathOverride !== undefined) {
		return resolve(project.getRootPath(), rootPathOverride);
	}
	return project.getSourcePath();
}

/**
 * Builds the per-route record: compiles the `mountPath` into a
 * `path-to-regexp` matcher and eagerly imports the handler module. Both
 * failures are captured (`matchError` / `loadError`) rather than thrown, so an
 * invalid pattern or a broken handler surfaces as a startup log plus a disabled
 * or self-closing route instead of crashing `ui5 serve`.
 */
async function loadHandler(handlerRoot: string, route: WebSocketRoute): Promise<LoadedRoute> {
	const absolutePath = resolve(handlerRoot, route.handler);

	// Parse and compile the mount path once at startup. An invalid pattern (e.g.
	// legacy `:opt?` syntax that v8 rejects) makes `parsePattern` throw; capture
	// it so the route is disabled with a startup error instead of crashing
	// `ui5 serve`. The matcher is compiled from the same `TokenData`, and the
	// tokens are kept for the startup pattern-shape diagnostics, so the pattern
	// is parsed exactly once.
	let match: MatchFunction<RouteParams> | null = null;
	let matchError: unknown;
	let tokens: Token[] = [];
	try {
		const parsed = parsePattern(route.mountPath);
		tokens = parsed.tokens;
		// `sensitive: true` keeps matching case-sensitive. `path-to-regexp`
		// defaults to case-insensitive, but the pre-parametrized middleware did an
		// exact string compare, so an upgrade to `/WS/ECHO` never matched a
		// `/ws/echo` route. Preserving that avoids silently claiming differently
		// cased upgrades meant for other listeners (the coexistence contract
		// `lacksStaticPrefix` also guards). Trailing-slash tolerance is left at the
		// library default (`/ws/echo` also matches `/ws/echo/`), as documented.
		match = compilePath<RouteParams>(parsed, { sensitive: true });
	} catch (err) {
		matchError = err;
	}

	try {
		const mod = (await import(pathToFileURL(absolutePath).href)) as {
			default?: WebSocketHandler;
		};
		if (!mod.default) {
			return {
				route,
				absolutePath,
				handler: null,
				match,
				matchError,
				tokens,
				loadError: new Error(`handler module ${route.handler} has no default export`),
			};
		}
		return { route, absolutePath, handler: mod.default, match, matchError, tokens };
	} catch (loadError) {
		return { route, absolutePath, handler: null, match, matchError, tokens, loadError };
	}
}

/**
 * Builds the `ctx` object handed to every handler callback. `close`,
 * `terminate`, and plain-mode `send` are self-contained and never throw:
 * closed sockets and synchronous `ws.send` / `ws.close` / `ws.terminate`
 * throws are caught here and routed to the prefix-aware logger. PCP-mode
 * `send` is the one exception: it calls `encode()`, and an empty field name
 * makes `encode()` throw. That throw is intentionally not caught here (see
 * below) so it surfaces to the handler-invocation wrapper as the caller's
 * mistake.
 */
function createContext(
	ws: WebSocket,
	req: IncomingMessage,
	mode: WebSocketMode,
	params: RouteParams,
	prefix: string,
	baseLog: FactoryParameters["log"],
): WebSocketContext {
	// `@ui5/logger`'s Logger is a class whose level methods rely on `this`
	// (`this._emitOrLog`); pulling a method out and calling it bare strips
	// the receiver and crashes. Always invoke through `baseLog`.
	const log: WebSocketLog = {
		silly: (...a: unknown[]) => baseLog.silly(prefix, ...a),
		verbose: (...a: unknown[]) => baseLog.verbose(prefix, ...a),
		perf: (...a: unknown[]) => baseLog.perf(prefix, ...a),
		info: (...a: unknown[]) => baseLog.info(prefix, ...a),
		warn: (...a: unknown[]) => baseLog.warn(prefix, ...a),
		error: (...a: unknown[]) => baseLog.error(prefix, ...a),
	};

	const writeRaw = (wire: string): void => {
		if (ws.readyState !== ws.OPEN) {
			log.warn(`send on non-open socket (state=${ws.readyState})`);
			return;
		}
		try {
			ws.send(wire);
		} catch (err) {
			log.error("ws.send threw:", err);
		}
	};

	const close = (code = 1000, reason = ""): void => {
		try {
			ws.close(code, reason);
		} catch (err) {
			log.warn(`ws.close threw (code=${code}):`, err);
		}
	};

	const terminate = (): void => {
		try {
			ws.terminate();
		} catch (err) {
			log.warn(`ws.terminate threw:`, err);
		}
	};

	// Per-connection scratch bag. One object per `createContext` call (one per
	// connection), shared by reference across every callback for this socket.
	// Typed loosely here; the handler narrows it via `WebSocketHandler<TData>`.
	const data: Record<string, unknown> = {};

	if (mode === "pcp") {
		// `encode()` only throws on empty field names. The string overload
		// cannot produce that; the `EncodeOptions` overload can, but the throw
		// is the caller's mistake (an empty key in `fields`), so it surfaces to
		// the handler-invocation wrapper instead of being swallowed here.
		const send = (message: string | EncodeOptions): void => {
			const options: EncodeOptions =
				typeof message === "string" ? { body: message } : message;
			writeRaw(encode(options));
		};
		return { ws, req, mode, params, log, data, send, close, terminate };
	}

	const send = (message: string): void => writeRaw(message);
	return { ws, req, mode, params, log, data, send, close, terminate };
}

/**
 * Normalizes a `ws` message payload to a UTF-8 string. `ws` delivers
 * `Buffer | ArrayBuffer | Buffer[]` (`WebSocket.RawData`) depending on
 * `binaryType` and whether the frame is fragmented. We accept all three so
 * the middleware keeps working if a consumer flips `binaryType` upstream of
 * us; the default (`nodebuffer`) always produces a single `Buffer`.
 */
function toUtf8(payload: WebSocket.RawData): string {
	if (Buffer.isBuffer(payload)) return payload.toString("utf8");
	if (Array.isArray(payload)) return Buffer.concat(payload).toString("utf8");
	return Buffer.from(payload).toString("utf8");
}

/**
 * Decodes an inbound frame per the negotiated mode.
 *
 *   - plain: forwarded verbatim as a string.
 *   - pcp:   `decode()` is best-effort. Frames missing the LFLF separator
 *            land as a body-only `PcpFrame` with empty `fields`, matching
 *            `SapPcpWebSocket`'s fallback. We surface that fallback at
 *            verbose so operators can tell a malformed frame from an
 *            empty-headers frame.
 */
function decodeMessage(raw: string, mode: WebSocketMode, log: WebSocketLog): InboundMessage {
	if (mode === "pcp") {
		if (!raw.includes("\n\n")) {
			log.verbose("malformed PCP frame: missing LFLF separator; treating as body-only");
		}
		const { pcpFields, body } = decode(raw);
		return { fields: pcpFields, body };
	}
	return raw;
}

/**
 * Runs `fn` and routes a synchronous throw or an async rejection to `onFail`,
 * tagged with which one occurred. Centralizing the sync/async catch here keeps
 * callers from repeating the try/catch-plus-`.catch()` dance.
 */
function settle(
	fn: () => void | Promise<void>,
	onFail: (err: unknown, kind: "threw" | "rejected") => void,
): void {
	try {
		const result = fn();
		if (result && typeof result.then === "function") {
			result.catch((err: unknown) => onFail(err, "rejected"));
		}
	} catch (err) {
		onFail(err, "threw");
	}
}

/**
 * Runs the handler's optional `onError` hook and logs a failure originating
 * from the hook itself. Because the hook runs through `settle` whose `onFail`
 * only logs, re-entry is structurally impossible: `onError` is never invoked
 * from inside its own failure path.
 */
function notifyError(
	ctx: WebSocketContext,
	onError: WebSocketHandler["onError"],
	err: unknown,
): void {
	if (!onError) return;
	settle(
		() => onError(ctx, err),
		(hookErr, kind) => ctx.log.error(`onError ${kind}:`, hookErr),
	);
}

/**
 * Awaits a possibly-async handler callback, logs the failure, and fans it out
 * to the handler's optional `onError` hook via `notifyError`.
 */
function invoke(
	name: string,
	ctx: WebSocketContext,
	onError: WebSocketHandler["onError"],
	fn: () => void | Promise<void>,
): void {
	settle(fn, (err, kind) => {
		ctx.log.error(`${name} ${kind}:`, err);
		notifyError(ctx, onError, err);
	});
}

/**
 * Wires a single post-upgrade connection to its handler. Inbound frames are
 * forwarded to `onMessage`; handler failures are logged and do not close the
 * connection.
 */
function attachConnection(
	ws: WebSocket,
	req: IncomingMessage,
	matched: MatchedRoute,
	pathname: string,
	baseLog: FactoryParameters["log"],
): void {
	const { entry: loaded, params } = matched;
	const prefix = routeTag(loaded.route.mountPath);

	// An always-on `'error'` listener is required: Node's EventEmitter contract
	// crashes the process on an unlistened `'error'`, and `ws` can emit one for
	// transport faults (malformed inbound frames, post-close races, etc.).
	if (!loaded.handler) {
		ws.on("error", (err) => baseLog.error(`${prefix} socket error:`, err));
		baseLog.error(`${prefix} refusing connection: handler failed to load`, loaded.loadError);
		ws.close(1011, "handler unavailable");
		return;
	}
	const mode: WebSocketMode = ws.protocol === SUBPROTOCOL ? "pcp" : "plain";
	const ctx = createContext(ws, req, mode, params, prefix, baseLog);
	const { onConnect, onMessage, onClose, onError } = loaded.handler;
	ws.on("error", (err) => {
		ctx.log.error("socket error:", err);
		notifyError(ctx, onError, err);
	});

	// Surface the concrete request pathname (and any extracted params) so a
	// parametrized route's actual match is visible when debugging routing.
	const paramsSuffix = Object.keys(params).length > 0 ? ` params=${JSON.stringify(params)}` : "";
	ctx.log.info(`connect (mode=${mode}) path=${pathname}${paramsSuffix}`);

	if (onConnect) {
		invoke("onConnect", ctx, onError, () => onConnect(ctx));
	}

	ws.on("message", (payload: WebSocket.RawData) => {
		const raw = toUtf8(payload);
		const message = decodeMessage(raw, mode, ctx.log);
		if (onMessage) {
			invoke("onMessage", ctx, onError, () => onMessage(ctx, message));
			return;
		}
		ctx.log.verbose("dropped frame (no onMessage)");
	});

	ws.on("close", (code, reasonBuf) => {
		const reason = reasonBuf.toString("utf8");
		ctx.log.info(`close ${code} ${reason}`);
		if (onClose) {
			invoke("onClose", ctx, onError, () => onClose(ctx, code, reason));
		}
	});
}

/**
 * Finds the first route whose compiled `mountPath` matches `pathname`, in
 * declaration order (first-match-wins). Returns the matched route together with
 * the extracted, percent-decoded `params`, or `null` when nothing matches.
 *
 * `path-to-regexp`'s matcher decodes params with `decodeURIComponent`, which
 * throws on malformed `%`-sequences (e.g. `%ZZ`). A throw is treated as a
 * non-match for that route — logged at verbose — so a malformed URL never
 * crashes the upgrade handler; matching continues with the remaining routes.
 */
function matchRoute(
	routes: LoadedRoute[],
	pathname: string,
	log: WebSocketLog,
): MatchedRoute | null {
	for (const entry of routes) {
		if (!entry.match) continue;
		try {
			const result = entry.match(pathname);
			if (result) return { entry, params: result.params };
		} catch (err) {
			log.verbose(
				`${routeTag(entry.route.mountPath)} ignoring ${pathname}: ` +
					`match threw (malformed percent-encoding?):`,
				err,
			);
		}
	}
	return null;
}

/**
 * Emits the per-route startup log lines for the loaded route table, walked in
 * declaration order (the order that decides first-match-wins). A successful
 * handler load is per-route detail, logged at `verbose` (visible with
 * `ui5 serve --verbose`); a failed load and an invalid, disabled pattern are
 * logged at `error`. It then warns about three first-match-wins footguns that
 * exact-string matching could not produce:
 *
 *   - a duplicate `mountPath` shadowed by an earlier identical entry;
 *   - a pattern with no leading static segment, which matches from the URL root
 *     and would steal upgrades from coexisting listeners (livereload etc.);
 *   - a route made unreachable by an earlier, broader pattern.
 *
 * Every hazard is a warning, never a refusal: the routes still function, but the
 * configuration is most likely a mistake.
 */
function reportRouteDiagnostics(loaded: LoadedRoute[], log: WebSocketLog): void {
	// Track the paths already seen (exact-duplicate detection) and the routes
	// declared earlier (shadowing probe); both accumulate across the walk.
	const seenPaths = new Set<string>();
	const earlier: LoadedRoute[] = [];
	for (const entry of loaded) {
		const tag = routeTag(entry.route.mountPath);
		if (entry.handler) {
			log.verbose(
				`${tag} handler loaded from ${entry.route.handler} (${entry.absolutePath})`,
			);
		} else {
			log.error(
				`${tag} handler load failed from ${entry.route.handler} (${entry.absolutePath}):`,
				entry.loadError,
			);
		}
		if (entry.matchError) {
			log.error(`${tag} invalid mountPath pattern; route disabled:`, entry.matchError);
		}
		if (seenPaths.has(entry.route.mountPath)) {
			log.warn(
				`[ws-mock] duplicate mountPath ${entry.route.mountPath}; ` +
					`earlier route wins, this entry is shadowed`,
			);
		}
		seenPaths.add(entry.route.mountPath);

		// Pattern-shape diagnostics only apply to routes that actually compiled.
		// All are warnings: the route still functions, but the config is likely a
		// mistake (a coexistence hazard, a dead route, or a dropped param value).
		if (entry.match) {
			const tokens = entry.tokens;
			if (lacksStaticPrefix(tokens)) {
				log.warn(
					`${tag} mountPath has no leading static segment, so it matches upgrade ` +
						`paths from the URL root and will claim them from other upgrade listeners ` +
						`(e.g. ui5-middleware-livereload). Add a literal prefix such as /ws/... to scope it.`,
				);
			}
			const dupes = duplicateParamNames(tokens);
			if (dupes.length > 0) {
				log.warn(
					`${tag} mountPath declares duplicate parameter name(s): ${dupes.join(", ")}; ` +
						`path-to-regexp keeps only the last occurrence, so the earlier value is dropped.`,
				);
			}
			// First-match-wins means an earlier pattern that already matches this
			// route's path makes this route unreachable. Probe the (string) mountPath
			// against each earlier matcher; a throw (e.g. a stray %-escape) is
			// inconclusive, so skip it.
			for (const prior of earlier) {
				if (!prior.match || prior.route.mountPath === entry.route.mountPath) continue;
				try {
					if (prior.match(entry.route.mountPath)) {
						log.warn(
							`${tag} mountPath is unreachable: it is shadowed by the earlier route ` +
								`${prior.route.mountPath} (first match wins). List more specific routes first.`,
						);
						break;
					}
				} catch {
					continue;
				}
			}
		}
		earlier.push(entry);
	}
}

/**
 * UI5 custom-middleware factory. Returns a middleware function that the
 * `ui5-utils-express/lib/hook` utility turns into a server-listening
 * callback. The returned middleware is otherwise a pass-through; WebSocket
 * upgrade requests bypass the HTTP middleware chain entirely.
 */
export default async function wsMock({
	log,
	options,
	middlewareUtil,
}: FactoryParameters): Promise<unknown> {
	const routes = options.configuration?.routes ?? [];
	if (routes.length === 0) {
		log.warn("[ws-mock] no routes configured; middleware is a no-op");
	}

	// Anchor handler resolution at the project's source path (or the configured
	// rootPath override) so paths are independent of where `ui5 serve` was
	// launched from. See `resolveHandlerRoot` for the precedence rules.
	// Resolve lazily: with no routes there's nothing to load, and skipping the
	// resolve avoids crashing on Module-type projects (whose getSourcePath()
	// throws) when this middleware is declared but unused.
	const loaded: LoadedRoute[] = [];
	if (routes.length > 0) {
		const project = middlewareUtil.getProject();
		const handlerRoot = resolveHandlerRoot(project, options.configuration?.rootPath);
		log.verbose(`[ws-mock] resolving handler paths against ${handlerRoot}`);
		loaded.push(...(await Promise.all(routes.map((r) => loadHandler(handlerRoot, r)))));
	}

	// Report load status and warn about first-match-wins configuration hazards.
	// Order is preserved (not collapsed into a path-keyed map) because matching
	// is declaration-order, first-match-wins.
	reportRouteDiagnostics(loaded, log);

	return hook("ui5-middleware-ws-mock", ({ server }: HookCallbackArgs) => {
		const wss = new WebSocketServer({
			noServer: true,
			handleProtocols: (protocols: Set<string>): string | false =>
				protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false,
		});

		// `'error'` on a `WebSocketServer` is rare in `noServer` mode (the
		// HTTP server, not us, owns the listening socket) but Node's
		// EventEmitter contract crashes the process on an unlistened `'error'`,
		// so register a logger as cheap insurance.
		wss.on("error", (err) => log.error("[ws-mock] WebSocketServer error:", err));

		// `'wsClientError'` fires for pre-handshake failures (malformed upgrade
		// frames, key validation, non-GET methods). Unlistened, ws's default
		// `abortHandshake` cleans up correctly but silently; we attach purely
		// to surface a `warn` line in the UI5 terminal. Attaching transfers
		// cleanup ownership, so `socket.end(...)` below mirrors ws's response
		// shape (status, `Connection: close`, length, `finish` then destroy).
		wss.on("wsClientError", (err, socket, req) => {
			log.warn(`[ws-mock] pre-handshake client error on ${req?.url ?? "?"}:`, err);
			if (socket.writable) {
				const body = err.message;
				socket.once("finish", () => socket.destroy());
				socket.end(
					`HTTP/1.1 400 Bad Request\r\nConnection: close\r\n` +
						`Content-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
						body,
				);
			} else {
				socket.destroy();
			}
		});

		server.on("upgrade", (req, socket, head) => {
			let pathname: string;
			try {
				pathname = new URL(req.url ?? "/", "http://localhost").pathname;
			} catch (err) {
				log.verbose(`[ws-mock] ignoring upgrade with unparseable url=${req.url}:`, err);
				return;
			}
			const matched = matchRoute(loaded, pathname, log);
			if (!matched) return;
			wss.handleUpgrade(req, socket, head, (ws) =>
				attachConnection(ws, req, matched, pathname, log),
			);
		});

		// List only routes that can actually match; a route whose pattern failed
		// to compile is disabled and never listens, so advertising it here misleads.
		const mountPaths =
			loaded
				.filter((entry) => entry.match)
				.map((entry) => entry.route.mountPath)
				.join(", ") || "(none)";
		log.info(`[ws-mock] listening for upgrades on: ${mountPaths}`);
	});
}
