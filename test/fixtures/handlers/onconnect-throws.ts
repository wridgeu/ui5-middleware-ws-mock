import type { WebSocketHandler } from "../../../src/types.js";

const handler: WebSocketHandler = {
	onConnect: () => {
		throw new Error("onConnect boom");
	},
};

export default handler;
