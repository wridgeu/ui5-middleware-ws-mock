import type { WebSocketHandler } from "../../../src/types.js";

const handler: WebSocketHandler = {
	onConnect: (ctx) => {
		// `data` deliberately omitted to exercise the `frame.data === undefined`
		// branch in ctx.send (serializes to an empty body in PCP, to `data: undefined`
		// stripped by JSON.stringify in plain mode).
		ctx.send({ action: "READY" });
	},
};

export default handler;
