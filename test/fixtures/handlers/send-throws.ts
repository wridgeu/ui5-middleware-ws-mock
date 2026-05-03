import type { WebSocketHandler } from "../../../src/types.js";

/**
 * Replaces `ctx.ws.send` with a synchronous-throw stub before calling
 * `ctx.send`, exercising the inner try/catch around `ws.send` in the
 * middleware (separate from the outer encode/stringify try/catch).
 */
const handler: WebSocketHandler = {
	onConnect: (ctx) => {
		const ws = ctx.ws as unknown as { send: (data: string) => void };
		ws.send = () => {
			throw new Error("synthetic ws.send failure");
		};
		ctx.send({ action: "X", data: { tag: 1 } });
	},
};

export default handler;
