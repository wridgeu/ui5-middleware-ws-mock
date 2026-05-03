import type { WebSocketHandler } from "../../../src/types.js";

const handler: WebSocketHandler = {
	actions: {
		BOOM: async () => {
			await Promise.resolve();
			throw new Error("asynchronous boom");
		},
	},
};

export default handler;
