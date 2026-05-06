import type { WebSocketHandler } from "../../../src/types.js";

const handler: WebSocketHandler = {
	onMessage: () => {
		throw new Error("synchronous boom");
	},
};

export default handler;
