import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";

/**
 * Negotiated wire mode for a connection. `"pcp"` when the client offered
 * `v10.pcp.sap.com`; `"plain"` otherwise. Snapshot at the handshake; fixed
 * for the lifetime of the connection.
 */
export type WebSocketMode = "pcp" | "plain";

/**
 * Per-connection context handed to every handler callback.
 *
 * `mode` is snapshot at the WebSocket upgrade based on the subprotocol the
 * server and client negotiated. It does not change for the lifetime of the
 * connection. Handlers branch on it to read inbound messages and to choose
 * an outbound framing strategy.
 */
export interface WebSocketContext {
	/** Raw `ws` instance. Required for any framing the helper methods do not cover. */
	ws: WebSocket;
	/** The HTTP upgrade request. Useful for `url`, `headers`, and `socket.remoteAddress`. */
	req: IncomingMessage;
	/** `"pcp"` when the client offered `v10.pcp.sap.com`, `"plain"` otherwise. */
	mode: WebSocketMode;
	/** Scoped logger, prefixed with `[ws-mock:<mountPath>]`. */
	log: WebSocketLog;
	/**
	 * Send a text message. The middleware does not interpret the bytes:
	 *
	 *   - plain mode: `message` is written through `ws.send` unchanged.
	 *   - pcp mode:   `message` is wrapped in a default PCP frame
	 *                 (`pcp-action:MESSAGE`, `pcp-body-type:text`, no extra
	 *                 header fields) with `message` as the body.
	 *
	 * For PCP frames with a non-default `pcp-action`, `pcp-body-type` (e.g.
	 * `binary`), or extra header fields, build the wire string with the
	 * exported `encode()` and call `ctx.ws.send(...)` directly.
	 *
	 * Non-open sockets and synchronous `ws.send` throws are logged and
	 * swallowed; callers never see a throw from this method.
	 */
	send: (message: string) => void;
	/**
	 * Close the connection with an optional code + reason. The default code
	 * is 1000 (Normal Closure).
	 */
	close: (code?: number, reason?: string) => void;
	/** Hard-kill the underlying socket without a close handshake (client sees 1006). */
	terminate: () => void;
}

/**
 * Scoped logger handed to every handler callback through `ctx.log`. Each call
 * is prefixed with the route's `[ws-mock:<mountPath>]` tag so output stays
 * distinguishable when multiple routes are mounted. Backed by the
 * `@ui5/logger/Logger` instance the UI5 tooling hands to the middleware
 * factory; the six methods below mirror `@ui5/logger`'s level names in
 * priority order (lowest → highest). The `silent` level intentionally has no
 * method, matching upstream.
 */
export interface WebSocketLog {
	/** Lowest-priority trace; suppressed by default. */
	silly: (...args: unknown[]) => void;
	/** Verbose trace; prefer for per-frame logs that would be noisy at `info`. */
	verbose: (...args: unknown[]) => void;
	/** Performance-oriented log; suppressed below the `perf` level. */
	perf: (...args: unknown[]) => void;
	/** Informational message. */
	info: (...args: unknown[]) => void;
	/** Warning: something unusual happened but the connection is continuing. */
	warn: (...args: unknown[]) => void;
	/** Error: consumer bug, transport failure, or infrastructure issue. */
	error: (...args: unknown[]) => void;
}

/**
 * Decoded PCP frame handed to `onMessage` when `ctx.mode === "pcp"`.
 *
 * `fields` is a flat key/value map of every PCP header field on the wire,
 * including `pcp-action` and `pcp-body-type`. `body` is the body bytes as a
 * UTF-8 string; the middleware never JSON-parses or otherwise interprets it.
 * Application-defined payload semantics (JSON, base64, line-delimited records,
 * opaque text) are entirely up to the handler.
 */
export interface PcpFrame {
	fields: Record<string, string>;
	body: string;
}

/**
 * Inbound message handed to `onMessage`. The runtime shape is determined by
 * `ctx.mode`:
 *
 *   - plain: the raw frame string as it arrived on the wire.
 *   - pcp:   a decoded `{ fields, body }` object.
 *
 * Handlers narrow on `ctx.mode` (or `typeof message`) before reading.
 */
export type InboundMessage = string | PcpFrame;

/**
 * Handler module shape. Consumers export a `WebSocketHandler` as `default`
 * from a file whose path is referenced by the `handler:` entry in the
 * middleware's `configuration.routes`.
 *
 * The middleware is transport-only: it negotiates plain vs. PCP, decodes PCP
 * frames into `{ fields, body }`, and forwards every inbound frame to
 * `onMessage`. Application-level routing (named messages → callbacks),
 * payload encoding (JSON, base64, etc.), and any other contract beyond the
 * wire layer are the handler's responsibility.
 *
 * Any hook may return a `Promise`; the middleware awaits it and logs
 * rejections via `ctx.log.error`. The connection is not closed on failure
 * unless the handler calls `ctx.close` or `ctx.terminate` explicitly.
 */
export interface WebSocketHandler {
	/**
	 * Called once per successful WebSocket upgrade, after subprotocol
	 * negotiation has settled `ctx.mode`. Typical use: send a HELLO frame or
	 * hydrate per-connection state.
	 */
	onConnect?: (ctx: WebSocketContext) => void | Promise<void>;
	/**
	 * Called for every inbound frame on this connection. `message` is the raw
	 * frame string in plain mode and a decoded `PcpFrame` in PCP mode;
	 * handlers branch on `ctx.mode` (or `typeof message`) to read it.
	 *
	 * Frames that arrive with no `onMessage` defined are dropped with a
	 * `verbose` log.
	 */
	onMessage?: (ctx: WebSocketContext, message: InboundMessage) => void | Promise<void>;
	/**
	 * Called after the WebSocket is closed (either peer). `code` is the close
	 * code, `reason` is the utf-8 reason string (empty when none was sent).
	 */
	onClose?: (ctx: WebSocketContext, code: number, reason: string) => void | Promise<void>;
}

/** Shape of a single entry in the middleware's `configuration.routes` list. */
export interface WebSocketRoute {
	/** Express-style mount path, e.g. `/ws/foo`. */
	mountPath: string;
	/**
	 * Path to the handler module, resolved against the middleware's effective
	 * root path. The default root is the UI5 project's source path (typically
	 * `webapp/`, honoring any custom `resources.configuration.paths.webapp`
	 * from `ui5.yaml`); set `configuration.rootPath` to override.
	 */
	handler: string;
}

/** The `configuration:` block expected under the custom middleware entry. */
export interface WebSocketMiddlewareConfiguration {
	/**
	 * One entry per mounted WebSocket endpoint. Each route declares its mount
	 * path and the handler module that drives it.
	 */
	routes: WebSocketRoute[];
	/**
	 * Override the root that `routes[].handler` paths resolve against.
	 * Resolved relative to the project root (the directory containing
	 * `ui5.yaml`); absolute paths pass through.
	 *
	 * Defaults to the UI5 project's source path (typically `webapp/` for
	 * Application projects). Set this for handlers next to `ui5.yaml`
	 * (`rootPath: "."`), under a test layout (`rootPath: "test/wsmock"`),
	 * or on non-Application project types where `getSourcePath()` is unavailable.
	 */
	rootPath?: string;
}
