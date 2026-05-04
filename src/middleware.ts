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
 * silently so other middleware (fe-mockserver etc.) can handle the request.
 *
 * PCP subprotocol negotiation is declared via `handleProtocols` at
 * WebSocketServer construction: if the client offered `v10.pcp.sap.com` we
 * echo it, otherwise we let the connection proceed with no subprotocol.
 * `ws.protocol` after the handshake decides per-connection encoding mode.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
// @ts-expect-error -- ui5-utils-express ships no type declarations; the module is a thin
// server-listening hook that returns a UI5-compatible middleware factory.
import hook from "ui5-utils-express/lib/hook.js";

import type {
	WebSocketContext,
	WebSocketHandler,
	WebSocketInboundFrame,
	WebSocketLog,
	WebSocketMiddlewareConfiguration,
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
	 * `@ui5/logger/Logger` instance the UI5 tooling passes in. Structural
	 * subset: `@ui5/logger` ships no type declarations, so we describe only
	 * the levels we use. `debug` is optional because older logger versions
	 * do not expose it; `createContext` falls back to `info` when it's
	 * missing.
	 */
	log: {
		info: (...args: unknown[]) => void;
		warn: (...args: unknown[]) => void;
		error: (...args: unknown[]) => void;
		debug?: (...args: unknown[]) => void;
	};
	options: {
		/** Value of `customMiddleware[].configuration` as declared in `ui5.yaml`. */
		configuration?: Partial<WebSocketMiddlewareConfiguration>;
		/** Middleware name from `ui5.yaml` (unused here; UI5 tooling always provides it). */
		middlewareName?: string;
	};
	/**
	 * `@ui5/server/middleware/MiddlewareUtil` instance. Structural subset:
	 * @ui5/server ships no type declarations we can pull in. We only use
	 * `getProject().getRootPath()` (available since specVersion 3.0) to
	 * resolve handler paths relative to the project root; the util exposes
	 * more methods per the UI5 tooling docs.
	 */
	middlewareUtil: {
		getProject(): { getRootPath(): string };
	};
}

interface HookCallbackArgs {
	app: unknown;
	server: Server;
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
async function loadHandler(projectRoot: string, route: WebSocketRoute): Promise<LoadedRoute> {
	const absolute = resolve(projectRoot, route.handler);
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
 * / `terminate` are self-contained and never throw: stringify failures,
 * closed sockets, and encoder errors are caught here and routed to the
 * prefix-aware logger.
 */
function createContext(
	ws: WebSocket,
	req: IncomingMessage,
	mode: "pcp" | "plain",
	prefix: string,
	baseLog: FactoryParameters["log"],
): WebSocketContext {
	const log: WebSocketLog = {
		info: (...a: unknown[]) => baseLog.info(prefix, ...a),
		warn: (...a: unknown[]) => baseLog.warn(prefix, ...a),
		error: (...a: unknown[]) => baseLog.error(prefix, ...a),
		debug: (...a: unknown[]) => (baseLog.debug ?? baseLog.info)(prefix, ...a),
	};

	const send = (frame: { action: string; data?: unknown }): void => {
		if (ws.readyState !== ws.OPEN) {
			log.warn(`send on non-open socket (state=${ws.readyState}, action=${frame.action})`);
			return;
		}
		let wire: string;
		try {
			const serialized = frame.data === undefined ? "" : JSON.stringify(frame.data ?? null);
			if (mode === "pcp") {
				// Spec-aligned PCP: `action` is a custom header field, the
				// body carries the payload. No JSON envelope wrapping.
				wire = encode({ fields: { action: frame.action }, body: serialized });
			} else {
				// Plain WebSocket has no header channel, so we serialize the
				// routing info into the body using the library's default
				// envelope `{ action, data }` (matches WebSocketService's
				// default receive-side parser).
				wire = JSON.stringify({ action: frame.action, data: frame.data });
			}
		} catch (err) {
			log.error(`send failed (action=${frame.action}):`, err);
			return;
		}
		try {
			ws.send(wire);
		} catch (err) {
			log.error(`ws.send threw (action=${frame.action}):`, err);
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
 * Decodes an inbound frame per the negotiated mode. Malformed input is
 * tolerated: the decoder returns a frame with `raw` populated and
 * `action` / `data` left undefined so `onMessage` can see the raw body.
 */
function decodeFrame(raw: string, mode: "pcp" | "plain"): WebSocketInboundFrame {
	if (mode === "pcp") {
		// Spec-aligned PCP: the application-level routing `action` arrives
		// as a custom PCP header field; the body is the payload. Parse the
		// body as JSON when it looks like JSON, otherwise expose it as the
		// raw string. No JSON-envelope-in-body heuristic.
		const { pcpFields, body } = decode(raw);
		const action = pcpFields["action"];
		const data = parseBodyPayload(body);
		return { action, data, raw };
	}
	// Plain WebSocket has no header channel, so the envelope `{ action, data }`
	// is the library's default wire contract for action-routed frames. Missing
	// keys stay `undefined`; the envelope is not treated as payload.
	try {
		const envelope = JSON.parse(raw) as { action?: unknown; data?: unknown };
		const action = typeof envelope.action === "string" ? envelope.action : undefined;
		return { action, data: envelope.data, raw };
	} catch {
		return { raw };
	}
}

/**
 * Best-effort body decoding for PCP frames. Empty body becomes `undefined`;
 * otherwise try `JSON.parse`, falling back to the raw string on parse
 * failure. This decodes structured payloads and JSON scalars (`null`,
 * numbers, booleans, strings) symmetrically with the plain-mode
 * `{ action, data }` parser on the client, and passes opaque text or
 * Base64 blobs through unchanged.
 */
function parseBodyPayload(body: string): unknown {
	if (body === "") return undefined;
	try {
		return JSON.parse(body);
	} catch {
		return body;
	}
}

/** Awaits a possibly-async handler callback and logs rejections. */
function invoke(name: string, ctx: WebSocketContext, fn: () => void | Promise<void>): void {
	try {
		const result = fn();
		if (result && typeof (result as Promise<void>).then === "function") {
			(result as Promise<void>).catch((err: unknown) =>
				ctx.log.error(`${name} rejected:`, err),
			);
		}
	} catch (err) {
		ctx.log.error(`${name} threw:`, err);
	}
}

/**
 * Wires a single post-upgrade connection to its handler. Handles the
 * dispatch-precedence rules (`actions[name]` > `onMessage` > drop) and makes
 * sure handler failures do not close the connection.
 */
function attachConnection(
	ws: WebSocket,
	req: IncomingMessage,
	loaded: LoadedRoute,
	baseLog: FactoryParameters["log"],
): void {
	const prefix = `[ws-mock:${loaded.route.mountPath}]`;
	if (!loaded.handler) {
		baseLog.error(`${prefix} refusing connection: handler failed to load`, loaded.loadError);
		ws.close(1011, "handler unavailable");
		return;
	}
	const mode: "pcp" | "plain" = ws.protocol === SUBPROTOCOL ? "pcp" : "plain";
	const ctx = createContext(ws, req, mode, prefix, baseLog);
	const handler = loaded.handler;

	ctx.log.info(`connect (mode=${mode})`);

	if (handler.onConnect) {
		invoke("onConnect", ctx, () => handler.onConnect!(ctx));
	}

	ws.on("message", (payload) => {
		const raw = typeof payload === "string" ? payload : payload.toString("utf8");
		const frame = decodeFrame(raw, mode);

		if (frame.action && handler.actions?.[frame.action]) {
			invoke(`action:${frame.action}`, ctx, () =>
				handler.actions![frame.action!]!(ctx, frame.data),
			);
			return;
		}
		if (handler.onMessage) {
			invoke("onMessage", ctx, () => handler.onMessage!(ctx, frame));
			return;
		}
		ctx.log.debug(`dropped frame (action=${frame.action ?? "(none)"})`);
	});

	ws.on("close", (code, reasonBuf) => {
		const reason = reasonBuf ? reasonBuf.toString("utf8") : "";
		ctx.log.info(`close ${code} ${reason}`);
		if (handler.onClose) {
			invoke("onClose", ctx, () => handler.onClose!(ctx, code, reason));
		}
	});

	ws.on("error", (err) => ctx.log.error("socket error:", err));
}

/**
 * UI5 custom-middleware factory. Returns a middleware function that the
 * `ui5-utils-express/lib/hook` utility turns into a server-listening
 * callback. The returned middleware is otherwise a pass-through; WebSocket
 * upgrade requests bypass the HTTP middleware chain entirely.
 */
export default async function wsMock({ log, options, middlewareUtil }: FactoryParameters) {
	const routes = options.configuration?.routes ?? [];
	if (routes.length === 0) {
		log.warn("[ws-mock] no routes configured; middleware is a no-op");
	}

	// Use the project's declared root (ui5.yaml location) rather than
	// `process.cwd()` so relative `handler:` paths resolve correctly regardless
	// of which directory `ui5 serve` was launched from. Requires specVersion
	// 3.0+ for `middlewareUtil.getProject()`; this extension is 4.0.
	const projectRoot = middlewareUtil.getProject().getRootPath();
	const loaded: LoadedRoute[] = await Promise.all(routes.map((r) => loadHandler(projectRoot, r)));
	for (const entry of loaded) {
		if (entry.handler) {
			log.info(
				`[ws-mock:${entry.route.mountPath}] handler loaded from ${entry.route.handler}`,
			);
		} else {
			log.error(
				`[ws-mock:${entry.route.mountPath}] handler load failed from ${entry.route.handler}:`,
				entry.loadError,
			);
		}
	}
	const byPath = new Map<string, LoadedRoute>(
		loaded.map((entry) => [entry.route.mountPath, entry]),
	);

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
			} catch {
				return; // malformed request, let other handlers decide
			}
			const entry = byPath.get(pathname);
			if (!entry) return;
			wss.handleUpgrade(req, socket, head, (ws) => attachConnection(ws, req, entry, log));
		});

		const mountPaths = routes.map((r) => r.mountPath).join(", ") || "(none)";
		log.info(`[ws-mock] listening for upgrades on: ${mountPaths}`);
	});
}
