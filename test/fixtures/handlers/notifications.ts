import type { WebSocketHandler } from "../../../src/types.js";

/**
 * Demo WebSocket handler wired at `/ws/notifications`.
 *
 * The action set mirrors what the `WebSocketDemo` view exercises:
 *   - HELLO: pushed on connect with the negotiated subprotocol mode
 *   - PING: round-trips the payload back as PONG (liveness)
 *   - DISCONNECT: closes with 1001 so the client's RetryStrategy reconnects
 *   - TERMINATE: hard-kills the socket (client observes 1006)
 *   - ORDER_UPDATE: echoes the payload as ORDER_UPDATE_ACK
 *
 * The file stays free of the middleware's internal imports; it only needs
 * the public `WebSocketHandler` / `WebSocketContext` types.
 */
const handler: WebSocketHandler = {
	onConnect: (ctx) => {
		const remote = ctx.req.socket.remoteAddress ?? "unknown";
		ctx.log.info(`connect from ${remote}`);
		ctx.send({
			action: "HELLO",
			data: { greeting: "hi", mode: ctx.mode, at: new Date().toISOString() },
		});
	},

	actions: {
		PING: (ctx, data) => {
			ctx.send({ action: "PONG", data });
		},

		DISCONNECT: (ctx) => {
			ctx.log.info("DISCONNECT requested; closing with 1001");
			ctx.close(1001, "requested");
		},

		TERMINATE: (ctx) => {
			ctx.log.info("TERMINATE requested; killing socket");
			ctx.terminate();
		},

		ORDER_UPDATE: (ctx, data) => {
			ctx.send({ action: "ORDER_UPDATE_ACK", data });
		},
	},

	onMessage: (ctx, frame) => {
		ctx.log.debug(`unhandled frame (action=${frame.action ?? "(none)"}, raw=${frame.raw})`);
	},

	onClose: (ctx, code, reason) => {
		ctx.log.info(`disconnect ${code}${reason ? ` ${reason}` : ""}`);
	},
};

export default handler;
