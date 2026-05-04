import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";

/**
 * Per-connection context handed to every handler callback.
 *
 * `mode` is snapshot at the WebSocket upgrade based on the subprotocol the
 * server and client negotiated. It does not change for the lifetime of the
 * connection; handlers that need branching behavior (e.g. logging mode) can
 * read it, but `send` / `close` / `terminate` are mode-agnostic.
 */
export interface WebSocketContext {
	/** Raw `ws` instance. Escape hatch for behavior the helper methods do not cover. */
	ws: WebSocket;
	/** The HTTP upgrade request. Useful for `url`, `headers`, and `socket.remoteAddress`. */
	req: IncomingMessage;
	/** `"pcp"` when the client offered `v10.pcp.sap.com`, `"plain"` otherwise. */
	mode: "pcp" | "plain";
	/** Scoped logger, prefixed with `[ws-mock:<mountPath>]`. */
	log: WebSocketLog;
	/**
	 * Send an action frame to this connection. In `pcp` mode the middleware
	 * encodes the frame as a PCP message with `action` set as a custom
	 * header field and the serialized `data` as the body (spec-aligned).
	 * In `plain` mode the envelope `{ action, data }` is serialized into
	 * the frame body; the client's default `WebSocketService` parser
	 * recognizes the same shape.
	 *
	 * Non-open sockets and `JSON.stringify` failures are logged and swallowed;
	 * callers never see a throw from this method.
	 */
	send: (frame: { action: string; data?: unknown }) => void;
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
 * factory, with `debug` falling back to `info` when the host logger does not
 * expose one.
 */
export interface WebSocketLog {
	/** Informational message. */
	info: (...args: unknown[]) => void;
	/** Warning: something unusual happened but the connection is continuing. */
	warn: (...args: unknown[]) => void;
	/** Error: consumer bug, transport failure, or infrastructure issue. */
	error: (...args: unknown[]) => void;
	/** Verbose trace; prefer for per-frame logs that would be noisy at `info`. */
	debug: (...args: unknown[]) => void;
}

/**
 * Shape of a decoded inbound frame passed to `onMessage`.
 *
 * `action` and `data` are best-effort: they are populated when the frame
 * decodes cleanly in the current mode. `raw` is always present.
 */
export interface WebSocketInboundFrame {
	action?: string;
	data?: unknown;
	raw: string;
}

/**
 * Handler module shape. Consumers export a `WebSocketHandler` as `default` from a
 * file whose path is referenced by the `handler:` entry in the middleware's
 * `configuration.routes`.
 *
 * Dispatch precedence for inbound frames:
 *   1. If the decoded `action` matches a key in `actions`, that callback runs
 *      (and only that callback). `data` is the decoded payload.
 *   2. Otherwise `onMessage` runs if defined, receiving the full decoded
 *      frame plus the raw body.
 *   3. Otherwise the frame is dropped with a debug log.
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
	 * Fallback for inbound frames whose decoded `action` does not match any
	 * key in `actions`. Receives the decoded frame plus the raw body so the
	 * handler can opt into custom parsing. Not called when an `actions` entry
	 * matches.
	 */
	onMessage?: (ctx: WebSocketContext, frame: WebSocketInboundFrame) => void | Promise<void>;
	/**
	 * Called after the WebSocket is closed (either peer). `code` is the close
	 * code, `reason` is the utf-8 reason string (empty when none was sent).
	 */
	onClose?: (ctx: WebSocketContext, code: number, reason: string) => void | Promise<void>;
	/**
	 * Action-name-to-callback map. When an inbound frame's decoded `action`
	 * matches a key, its callback runs and `onMessage` is not invoked. The
	 * callback receives the decoded `data` payload as-is.
	 */
	actions?: Record<string, (ctx: WebSocketContext, data: unknown) => void | Promise<void>>;
}

/** Shape of a single entry in the middleware's `configuration.routes` list. */
export interface WebSocketRoute {
	/** Express-style mount path, e.g. `/ws/notifications`. */
	mountPath: string;
	/**
	 * Path to the handler module, relative to the project root (the directory
	 * containing `ui5.yaml`).
	 */
	handler: string;
}

/** The `configuration:` block expected under the custom middleware entry. */
export interface WebSocketMiddlewareConfiguration {
	routes: WebSocketRoute[];
}
