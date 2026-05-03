import type { WebSocketHandler } from "../../../src/types.js";

const handler: WebSocketHandler = {
	onConnect: (ctx) => {
		const obj: Record<string, unknown> = {};
		obj.self = obj; // circular ref → JSON.stringify throws
		ctx.send({ action: "BAD", data: obj });
		ctx.send({ action: "OK", data: { ping: true } }); // proves connection survived
	},
};

export default handler;
