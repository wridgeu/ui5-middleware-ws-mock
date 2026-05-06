import type { WebSocketHandler } from "../../../src/types.js";

/**
 * Handler with no `onMessage`. Inbound frames hit the drop-with-debug-log
 * path inside the middleware.
 */
const handler: WebSocketHandler = {
	onConnect: (ctx) => {
		ctx.log.info("connected");
	},
};

export default handler;
