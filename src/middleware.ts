/**
 * UI5 custom server middleware factory. Exposes per-route WebSocket mocking
 * via a handler-module pattern similar to `sap-fe-mockserver`'s mockdata
 * handlers.
 *
 * Registers one `WebSocketServer` (in `noServer` mode) for the whole ui5
 * serve process. The server's `upgrade` event is hooked via the community
 * utility `ui5-utils-express/lib/hook` (which intercepts `app.listen` to
 * grab the underlying HTTP server; see the hook source for the full trick).
 * On each upgrade we check the request's pathname against our route table,
 * hand the socket to `wss.handleUpgrade` if we own it, and otherwise bail
 * without claiming the upgrade so other middleware (fe-mockserver etc.)
 * can handle the request. Unparseable urls log at verbose and bail too.
 *
 * PCP subprotocol negotiation is declared via `handleProtocols` at
 * WebSocketServer construction: if the client offered `v10.pcp.sap.com` we
 * echo it, otherwise we let the connection proceed with no subprotocol.
 * `ws.protocol` after the handshake decides per-connection encoding mode.
 *
 * The middleware is transport-only beyond the wire layer: plain frames are
 * forwarded as raw strings, PCP frames are decoded into `{ fields, body }`.
 * Application-level routing and payload encoding are the handler's job.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { IncomingMessage, Server } from "node:http";
import { Buffer } from "node:buffer";
import { WebSocketServer, type WebSocket } from "ws";
import { match as compilePath, type MatchFunction } from "path-to-regexp";
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
 * Eagerly loads a handler module. Failures are captured so the route can
 * respond with a sensible close code at upgrade time instead of crashing
 * `ui5 serve`.
 */
async function loadHandler(handlerRoot: string, route: WebSocketRoute): Promise<LoadedRoute> {
	const absolutePath = resolve(handlerRoot, route.handler);

	// Compile the mount path once at startup. An invalid pattern (e.g. legacy
	// `:opt?` syntax that v8 rejects) makes `compilePath` throw; capture it so the
	// route is disabled with a startup error instead of crashing `ui5 serve`.
	let match: MatchFunction<RouteParams> | null = null;
	let matchError: unknown;
	try {
		match = compilePath<RouteParams>(route.mountPath);
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
				loadError: new Error(`handler module ${route.handler} has no default export`),
			};
		}
		return { route, absolutePath, handler: mod.default, match, matchError };
	} catch (loadError) {
		return { route, absolutePath, handler: null, match, matchError, loadError };
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
	loaded: LoadedRoute,
	params: RouteParams,
	baseLog: FactoryParameters["log"],
): void {
	const prefix = `[ws-mock:${loaded.route.mountPath}]`;

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

	ctx.log.info(`connect (mode=${mode})`);

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
): { entry: LoadedRoute; params: RouteParams } | null {
	for (const entry of routes) {
		if (!entry.match) continue;
		try {
			const result = entry.match(pathname);
			if (result) return { entry, params: result.params };
		} catch (err) {
			log.verbose(
				`[ws-mock:${entry.route.mountPath}] ignoring ${pathname}: ` +
					`match threw (malformed percent-encoding?):`,
				err,
			);
		}
	}
	return null;
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

	// Routes are matched in declaration order (first-match-wins), so keep the
	// configured order rather than collapsing into a path-keyed map. An exact
	// duplicate mountPath is shadowed by the earlier entry and can never match.
	const seenPaths = new Set<string>();
	for (const entry of loaded) {
		const tag = `[ws-mock:${entry.route.mountPath}]`;
		if (entry.handler) {
			log.info(`${tag} handler loaded from ${entry.route.handler} (${entry.absolutePath})`);
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
	}

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
				attachConnection(ws, req, matched.entry, matched.params, log),
			);
		});

		const mountPaths = routes.map((r) => r.mountPath).join(", ") || "(none)";
		log.info(`[ws-mock] listening for upgrades on: ${mountPaths}`);
	});
}
