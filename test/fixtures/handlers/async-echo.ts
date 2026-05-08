import type { WebSocketHandler } from "../../../src/types.js";

const handler: WebSocketHandler = {
	onConnect: async (ctx) => {
		await Promise.resolve();
		ctx.send("READY");
	},
	onMessage: async (ctx, message) => {
		await Promise.resolve();
		const body = typeof message === "string" ? message : message.body;
		ctx.send(`ECHO:${body}`);
	},
};

export default handler;
