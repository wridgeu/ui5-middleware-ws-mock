import type { WebSocketHandler } from "../../../src/types.js";

/**
 * Triggers `encode()`'s "PCP field names must be non-empty" throw from inside
 * `ctx.send`. The middleware does not swallow this; the handler-invocation
 * wrapper catches it, logs at `error`, and leaves the connection open.
 */
const handler: WebSocketHandler = {
	onConnect: (ctx) => {
		if (ctx.mode !== "pcp") return;
		ctx.send({ fields: { "": "x" }, body: "y" });
	},
};

export default handler;
