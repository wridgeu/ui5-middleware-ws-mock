import type { WebSocketHandler } from "../../../src/types.js";

/**
 * Connect-and-echo handler. Sends `READY` on connect; replies to each inbound
 * frame with `ECHO:<original body>` so a test can confirm bytes round-trip
 * unmodified through `ctx.send` and the decoder.
 */
const handler: WebSocketHandler = {
	onConnect: (ctx) => {
		ctx.send("READY");
	},
	onMessage: (ctx, message) => {
		const body = typeof message === "string" ? message : message.body;
		ctx.send(`ECHO:${body}`);
	},
};

export default handler;
