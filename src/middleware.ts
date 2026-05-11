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
import { WebSocketServer, type WebSocket } from "ws";
// @ts-expect-error -- ui5-utils-express ships no type declarations; the module is a thin
// server-listening hook that returns a UI5-compatible middleware factory.
import hook from "ui5-utils-express/lib/hook.js";

import type {
	InboundMessage,
	WebSocketContext,
	WebSocketHandler,
	WebSocketLog,
	WebSocketMiddlewareConfiguration,
	WebSocketMode,
	WebSocketRoute,
} from "./types.js";
import { decode, encode, SUBPROTOCOL } from "./pcp.js";

interface LoadedRoute {
	route: WebSocketRoute;
	handler: WebSocketHandler | null;
	loadError?: unknown;
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
	 * `@ui5/server/middleware/MiddlewareUtil` instance. Structural subset:
	 * @ui5/server ships no type declarations we can pull in. We use
	 * `getProject().getRootPath()` to anchor a `rootPath` override, and prefer
	 * `getProject().getSourcePath()` (both available since specVersion 3.0)
	 * as the default root — typically `<root>/webapp/`, honoring any custom
	 * `resources.configuration.paths.webapp` from `ui5.yaml`. The util
	 * exposes more methods per the UI5 tooling docs.
	 */
	middlewareUtil: {
		getProject(): {
			getRootPath(): string;
			getSourcePath?(): string;
		};
	};
}

interface HookCallbackArgs {
	app: unknown;
	server: Server;
}

/**
 * Resolves the effective root directory that `routes[].handler` paths are
 * resolved against.
 *
 *   1. `configuration.rootPath` (if set): resolved relative to the project root,
 *      so `"."` keeps the legacy project-root behavior and `"test/wsmock"`
 *      rebases under that subfolder. Absolute paths pass through.
 *   2. Otherwise: the UI5 project's source path — typically `<root>/webapp/`,
 *      and honoring any `resources.configuration.paths.webapp` override in
 *      `ui5.yaml`.
 *   3. Fallback: the project root, if a custom `MiddlewareUtil` shim does not
 *      expose `getSourcePath()`.
 */
function resolveHandlerRoot(
	project: ReturnType<FactoryParameters["middlewareUtil"]["getProject"]>,
	rootPathOverride: string | undefined,
): string {
	const projectRoot = project.getRootPath();
	if (rootPathOverride !== undefined) {
		return resolve(projectRoot, rootPathOverride);
	}
	if (typeof project.getSourcePath === "function") {
		return project.getSourcePath();
	}
	return projectRoot;
}

/**
 * Eagerly loads a handler module. Failures are captured so the route can
 * respond with a sensible close code at upgrade time instead of crashing
 * `ui5 serve`.
 *
 * Uses dynamic `import()` (not `require()`) because the demo package declares
 * `"type": "module"` and `sap-fe-mockserver` installs a `ts-node` hook that
 * intercepts `require()` for `.ts` files and tries to load them as CJS. Going
 * through `import()` sidesteps the hook and uses Node's native type stripping.
 */
async function loadHandler(handlerRoot: string, route: WebSocketRoute): Promise<LoadedRoute> {
	const absolute = resolve(handlerRoot, route.handler);
	try {
		const mod = (await import(pathToFileURL(absolute).href)) as {
			default?: WebSocketHandler;
		};
		if (!mod.default) {
			return {
				route,
				handler: null,
				loadError: new Error(`handler module ${route.handler} has no default export`),
			};
		}
		return { route, handler: mod.default };
	} catch (loadError) {
		return { route, handler: null, loadError };
	}
}

/**
 * Builds the `ctx` object handed to every handler callback. `send` / `close`
 * / `terminate` are self-contained and never throw: closed sockets and
 * synchronous `ws.send` / `ws.close` / `ws.terminate` throws are caught here
 * and routed to the prefix-aware logger.
 */
function createContext(
	ws: WebSocket,
	req: IncomingMessage,
	mode: WebSocketMode,
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

	const send = (message: string): void => {
		if (ws.readyState !== ws.OPEN) {
			log.warn(`send on non-open socket (state=${ws.readyState})`);
			return;
		}
		// In PCP mode the helper wraps `message` in a default frame
		// (`pcp-action:MESSAGE`, `pcp-body-type:text`, no extra fields).
		// `encode()` only throws on empty field names, which this call site
		// cannot produce, so the call is unguarded. Custom PCP framing
		// (other actions, binary body-type, additional header fields) is
		// the handler's job via `encode()` and `ctx.ws.send`.
		const wire = mode === "pcp" ? encode({ body: message }) : message;
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

	return { ws, req, mode, log, send, close, terminate };
}

/**
 * Decodes an inbound frame per the negotiated mode.
 *
 *   - plain: forwarded verbatim as a string.
 *   - pcp:   `decode()` is best-effort — frames missing the LFLF separator
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

/** Awaits a possibly-async handler callback and logs rejections. */
function invoke(name: string, ctx: WebSocketContext, fn: () => void | Promise<void>): void {
	try {
		const result = fn();
		if (result && typeof result.then === "function") {
			result.catch((err: unknown) => ctx.log.error(`${name} rejected:`, err));
		}
	} catch (err) {
		ctx.log.error(`${name} threw:`, err);
	}
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
	baseLog: FactoryParameters["log"],
): void {
	const prefix = `[ws-mock:${loaded.route.mountPath}]`;
	// Register before any early-return: ws emits 'error' synchronously on
	// malformed inbound frames; an unlistened emit crashes the process.
	ws.on("error", (err) => baseLog.error(`${prefix} socket error:`, err));

	if (!loaded.handler) {
		baseLog.error(`${prefix} refusing connection: handler failed to load`, loaded.loadError);
		ws.close(1011, "handler unavailable");
		return;
	}
	const mode: WebSocketMode = ws.protocol === SUBPROTOCOL ? "pcp" : "plain";
	const ctx = createContext(ws, req, mode, prefix, baseLog);
	const { onConnect, onMessage, onClose } = loaded.handler;

	ctx.log.info(`connect (mode=${mode})`);

	if (onConnect) {
		invoke("onConnect", ctx, () => onConnect(ctx));
	}

	ws.on("message", (payload) => {
		const raw = typeof payload === "string" ? payload : payload.toString("utf8");
		const message = decodeMessage(raw, mode, ctx.log);
		if (onMessage) {
			invoke("onMessage", ctx, () => onMessage(ctx, message));
			return;
		}
		ctx.log.verbose("dropped frame (no onMessage)");
	});

	ws.on("close", (code, reasonBuf) => {
		const reason = reasonBuf ? reasonBuf.toString("utf8") : "";
		ctx.log.info(`close ${code} ${reason}`);
		if (onClose) {
			invoke("onClose", ctx, () => onClose(ctx, code, reason));
		}
	});
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

	// Anchor handler resolution at the project's declared root (specVersion 3.0+;
	// this extension is 4.0) so paths are independent of where `ui5 serve` was
	// launched from. The effective root — and the fallbacks for older shims —
	// are documented on `resolveHandlerRoot`.
	const project = middlewareUtil.getProject();
	const handlerRoot = resolveHandlerRoot(project, options.configuration?.rootPath);
	log.verbose(`[ws-mock] resolving handler paths against ${handlerRoot}`);
	const loaded: LoadedRoute[] = await Promise.all(routes.map((r) => loadHandler(handlerRoot, r)));
	for (const entry of loaded) {
		const absolute = resolve(handlerRoot, entry.route.handler);
		if (entry.handler) {
			log.info(
				`[ws-mock:${entry.route.mountPath}] handler loaded from ${entry.route.handler} (${absolute})`,
			);
		} else {
			log.error(
				`[ws-mock:${entry.route.mountPath}] handler load failed from ${entry.route.handler} (${absolute}):`,
				entry.loadError,
			);
		}
	}
	const byPath = new Map<string, LoadedRoute>();
	for (const entry of loaded) {
		if (byPath.has(entry.route.mountPath)) {
			log.warn(`[ws-mock] duplicate mountPath ${entry.route.mountPath}; later route wins`);
		}
		byPath.set(entry.route.mountPath, entry);
	}

	return hook("ui5-middleware-ws-mock", ({ server }: HookCallbackArgs) => {
		const wss = new WebSocketServer({
			noServer: true,
			handleProtocols: (protocols: Set<string>): string | false =>
				protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false,
		});

		server.on("upgrade", (req, socket, head) => {
			let pathname: string;
			try {
				pathname = new URL(req.url ?? "/", "http://localhost").pathname;
			} catch (err) {
				log.verbose(`[ws-mock] ignoring upgrade with unparseable url=${req.url}:`, err);
				return;
			}
			const entry = byPath.get(pathname);
			if (!entry) return;
			wss.handleUpgrade(req, socket, head, (ws) => attachConnection(ws, req, entry, log));
		});

		const mountPaths = routes.map((r) => r.mountPath).join(", ") || "(none)";
		log.info(`[ws-mock] listening for upgrades on: ${mountPaths}`);
	});
}
