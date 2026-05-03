import type { WebSocketHandler } from "../../../src/types.js";

/**
 * Demo handler wired at `/ws/notifications-broken`.
 *
 * Terminates the socket immediately on connect. The client observes close
 * code 1006, RetryStrategy schedules a reconnect, and the cycle repeats
 * until `maxAttempts` is reached. The WebSocket demo view uses this route
 * to drive the retry strategy to exhaustion in a few seconds and surface
 * the `retryMaxAttemptsReached` event in the UI.
 */
const handler: WebSocketHandler = {
	onConnect: (ctx) => {
		ctx.log.info("notifications-broken: terminating immediately to drive retry exhaustion");
		ctx.terminate();
	},
};

export default handler;
