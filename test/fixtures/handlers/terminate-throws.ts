import type { WebSocketHandler } from "../../../src/types.js";

/**
 * Replaces `ctx.ws.terminate` with a synchronous-throw stub before calling
 * `ctx.terminate`, exercising the inner try/catch around `ws.terminate` in the
 * middleware (mirrors `send-throws.ts` for the terminate path).
 */
const handler: WebSocketHandler = {
	onConnect: (ctx) => {
		const ws = ctx.ws as unknown as { terminate: () => void };
		ws.terminate = () => {
			throw new Error("synthetic ws.terminate failure");
		};
		ctx.terminate();
	},
};

export default handler;
