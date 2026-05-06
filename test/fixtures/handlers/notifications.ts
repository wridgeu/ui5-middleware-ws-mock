import type { WebSocketHandler } from "../../../src/types.js";

/**
 * Demo handler covering the lifecycle hooks the middleware exposes:
 *
 *   - `onConnect` sends `HELLO`
 *   - `onMessage` interprets the body as an application command (`DISCONNECT`
 *     → clean close 1001; `TERMINATE` → hard kill, client sees 1006)
 *   - `onClose` logs the close code + reason
 *
 * The "command in the body" shape is application-level: the middleware itself
 * does not parse, route, or interpret payloads.
 */
const handler: WebSocketHandler = {
	onConnect: (ctx) => {
		const remote = ctx.req.socket.remoteAddress ?? "unknown";
		ctx.log.info(`connect from ${remote}`);
		ctx.send("HELLO");
	},

	onMessage: (ctx, message) => {
		const body = typeof message === "string" ? message : message.body;
		if (body === "DISCONNECT") {
			ctx.log.info("DISCONNECT requested; closing with 1001");
			ctx.close(1001, "requested");
			return;
		}
		if (body === "TERMINATE") {
			ctx.log.info("TERMINATE requested; killing socket");
			ctx.terminate();
			return;
		}
		ctx.log.verbose(`unhandled body=${body}`);
	},

	onClose: (ctx, code, reason) => {
		ctx.log.info(`disconnect ${code}${reason ? ` ${reason}` : ""}`);
	},
};

export default handler;
