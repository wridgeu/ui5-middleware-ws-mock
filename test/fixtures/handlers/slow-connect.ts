import type { WebSocketHandler } from "../../../src/types.js";

/**
 * Async `onConnect` that fills `ctx.data` after a delay. `onMessage`, `onClose`
 * and `onError` report what they see, so a test can prove they ran after it settled.
 */
const handler: WebSocketHandler<{ ready?: boolean }> = {
	onConnect: async (ctx) => {
		await new Promise((r) => setTimeout(r, 30));
		ctx.data.ready = true;
	},
	onMessage: (ctx) => {
		ctx.send(`ready=${ctx.data.ready}`);
	},
	onError: (ctx) => {
		ctx.log.warn(`onError ready=${ctx.data.ready}`);
	},
	onClose: (ctx) => {
		ctx.log.info(`closed ready=${ctx.data.ready}`);
	},
};

export default handler;
