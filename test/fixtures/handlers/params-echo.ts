import type { WebSocketHandler } from "../../../src/types.js";

/**
 * Reports the route parameters extracted from the matched `mountPath`. Sends
 * the JSON-serialized `ctx.params` on connect so a test can assert that named
 * segments, optional segments, and wildcards land on `ctx.params` as expected.
 */
const handler: WebSocketHandler = {
	onConnect: (ctx) => {
		ctx.send(JSON.stringify(ctx.params));
	},
};

export default handler;
