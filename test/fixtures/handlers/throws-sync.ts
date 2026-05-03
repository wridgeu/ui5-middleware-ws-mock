import type { WebSocketHandler } from "../../../src/types.js";

const handler: WebSocketHandler = {
	actions: {
		BOOM: () => {
			throw new Error("synchronous boom");
		},
	},
};

export default handler;
