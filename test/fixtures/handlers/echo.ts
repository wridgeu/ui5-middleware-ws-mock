import type { WebSocketHandler } from "../../../src/types.js";

const handler: WebSocketHandler = {
	onConnect: (ctx) => {
		ctx.send({ action: "READY", data: { mode: ctx.mode } });
	},
	onMessage: (ctx, frame) => {
		ctx.send({ action: "ECHO", data: frame.data ?? frame.raw });
	},
};

export default handler;
