import type { WebSocketHandler } from "../../../src/types.js";

/**
 * `onConnect` triggers `encode()`'s empty-field-name throw inside `ctx.send`.
 * Verifies the fan-out reaches `onError` when the throw originates from the
 * PCP encode path rather than handler code directly.
 */
const handler: WebSocketHandler = {
	onConnect: (ctx) => {
		if (ctx.mode !== "pcp") return;
		ctx.send({ fields: { "": "x" }, body: "y" });
	},
	onError: (ctx, err) => {
		ctx.log.info(`onError:encode ${(err as Error).message}`);
	},
};

export default handler;
