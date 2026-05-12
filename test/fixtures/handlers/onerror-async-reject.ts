import type { WebSocketHandler } from "../../../src/types.js";

/**
 * `onMessage` rejects asynchronously; `onError` records the propagated error.
 * Verifies the fan-out from `invoke()` to the `onError` hook for async
 * rejections (the `.catch()` path inside `invoke`).
 */
const handler: WebSocketHandler = {
	onMessage: async () => {
		await Promise.resolve();
		throw new Error("async-boom");
	},
	onError: (ctx, err) => {
		ctx.log.info(`onError:async ${(err as Error).message}`);
	},
};

export default handler;
