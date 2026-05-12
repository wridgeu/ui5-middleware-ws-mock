import type { WebSocketHandler } from "../../../src/types.js";

/**
 * `onMessage` throws synchronously; `onError` records the propagated error.
 * Verifies the fan-out from `invoke()` to the `onError` hook for sync throws.
 */
const handler: WebSocketHandler = {
	onMessage: () => {
		throw new Error("sync-boom");
	},
	onError: (ctx, err) => {
		ctx.log.info(`onError:sync ${(err as Error).message}`);
	},
};

export default handler;
