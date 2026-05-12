import type { WebSocketHandler } from "../../../src/types.js";

/**
 * `onMessage` throws, and `onError` itself throws while handling it.
 * Verifies the recursion guard inside `invoke`: a throwing `onError` must be
 * logged once and never re-enter the hook.
 */
const handler: WebSocketHandler = {
	onMessage: () => {
		throw new Error("original");
	},
	onError: () => {
		throw new Error("hook-itself-threw");
	},
};

export default handler;
