import type { WebSocketHandler } from "../../../src/types.js";

/**
 * Records `onError` invocations. Pair with a test that provokes a real
 * transport-level protocol violation (e.g. an unmasked client frame) so that
 * `ws` emits `'error'` on the server-side socket. Verifies the middleware's
 * `ws.on('error', ...)` listener surfaces that through `onError`, a distinct
 * code path from the `invoke()` wrapper that catches handler throws.
 */
const handler: WebSocketHandler = {
	onError: (ctx, err) => {
		ctx.log.info(`onError:socket ${(err as Error).message}`);
	},
};

export default handler;
