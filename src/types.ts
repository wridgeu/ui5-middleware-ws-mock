import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import type { EncodeOptions } from "./pcp.js";

/**
 * Negotiated wire mode for a connection. `"pcp"` when the client offered
 * `v10.pcp.sap.com`; `"plain"` otherwise. Snapshot at the handshake; fixed
 * for the lifetime of the connection.
 */
export type WebSocketMode = "pcp" | "plain";

/**
 * Fields shared by every per-connection context, regardless of negotiated
 * mode. The mode-specific shape adds `mode` and a `send` whose accepted
 * payload differs (see `PlainWebSocketContext` / `PcpWebSocketContext`).
 */
interface WebSocketContextBase {
	/** Raw `ws` instance. Required for any framing the helper methods do not cover. */
	ws: WebSocket;
	/** The HTTP upgrade request. Useful for `url`, `headers`, and `socket.remoteAddress`. */
	req: IncomingMessage;
	/** Scoped logger, prefixed with `[ws-mock:<mountPath>]`. */
	log: WebSocketLog;
	/**
	 * Close the connection with an optional code + reason. The default code
	 * is 1000 (Normal Closure).
	 */
	close: (code?: number, reason?: string) => void;
	/** Hard-kill the underlying socket without a close handshake (client sees 1006). */
	terminate: () => void;
}

/**
 * Connection context when the client did not offer `v10.pcp.sap.com`. The
 * middleware does not frame the wire: `ctx.send(message)` writes the string
 * through `ws.send` verbatim.
 *
 * Non-open sockets and synchronous `ws.send` throws are logged and swallowed;
 * `send` never throws.
 */
export interface PlainWebSocketContext extends WebSocketContextBase {
	mode: "plain";
	/** Write `message` to the wire unchanged. */
	send: (message: string) => void;
}

/**
 * Connection context when the subprotocol negotiated to PCP. `send` accepts
 * either a string (treated as the body of a default
 * `pcp-action:MESSAGE` / `pcp-body-type:text` frame) or a full
 * `EncodeOptions` to drive a custom action, body-type, or extra header
 * fields. The middleware calls `encode()` internally, so handlers do not
 * need to import it for the common cases.
 *
 * For framings the public encoder does not cover (a non-PCP wire format on
 * the same socket, custom separator handling, etc.) reach for `ctx.ws.send`
 * with a pre-built wire string.
 *
 * Non-open sockets and synchronous `ws.send` throws are logged and swallowed.
 * `encode()` throws on empty PCP field names; that throw propagates out of
 * `send` and is caught by the handler-invocation wrapper (logged at `error`,
 * connection stays open).
 */
export interface PcpWebSocketContext extends WebSocketContextBase {
	mode: "pcp";
	/**
	 * Send a PCP frame.
	 *
	 *   - `send("hello")` is shorthand for `encode({ body: "hello" })` (default
	 *     action / body-type, no extra fields).
	 *   - `send({ action, bodyType, fields, body })` calls `encode(options)`
	 *     with whatever subset of fields the caller supplied.
	 */
	send: (message: string | EncodeOptions) => void;
}

/**
 * Per-connection context handed to every handler callback. Discriminated on
 * `mode`: narrow with `if (ctx.mode === "pcp") { ... }` to unlock the
 * `EncodeOptions` overload of `send`.
 *
 * `mode` is snapshot at the WebSocket upgrade based on the subprotocol the
 * server and client negotiated. It does not change for the lifetime of the
 * connection.
 */
export type WebSocketContext = PlainWebSocketContext | PcpWebSocketContext;

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
	 * Defaults to the UI5 project's source path: `webapp/` for Application
	 * projects, `src/` for Library and ThemeLibrary projects (honoring any
	 * overrides under `resources.configuration.paths` in `ui5.yaml`). Set
	 * this for handlers next to `ui5.yaml` (`rootPath: "."`), under a test
	 * layout (`rootPath: "test/wsmock"`), or on Module-type projects (whose
	 * `getSourcePath()` throws because a Module has no single source path).
	 */
	rootPath?: string;
}
