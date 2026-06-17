import type { WebSocketHandler } from "../../../src/types.js";

/**
 * Replaces `ctx.ws.close` with a synchronous-throw stub before calling
 * `ctx.close`, exercising the inner try/catch around `ws.close` in the
 * middleware (mirrors `send-throws.ts` for the close path).
 */
const handler: WebSocketHandler = {
	onConnect: (ctx) => {
		const ws = ctx.ws as unknown as { close: (code?: number, reason?: string) => void };
		ws.close = () => {
			throw new Error("synthetic ws.close failure");
		};
		ctx.close();
	},
};

export default handler;
