import type { WebSocketHandler } from "../../../src/types.js";

/** Calls `ctx.close()` with no arguments on the first frame, to pin the default close code. */
const handler: WebSocketHandler = {
	onMessage: (ctx) => {
		ctx.close();
	},
};

export default handler;
