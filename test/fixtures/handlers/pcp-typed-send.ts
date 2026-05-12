import type { WebSocketHandler } from "../../../src/types.js";

/**
 * Fixture exercising `ctx.send` end-to-end in PCP mode:
 *
 *   - `ctx.send("HELLO")` writes a default-framed PCP message.
 *   - `ctx.send({ action, fields, body })` writes a custom-action frame.
 *   - Inbound `"PING"` triggers a `PONG` reply with an empty body.
 */
const handler: WebSocketHandler = {
	onConnect: (ctx) => {
		ctx.send("HELLO");
		if (ctx.mode === "pcp") {
			ctx.send({
				action: "WELCOME",
				bodyType: "text",
				fields: { sessionId: "abc-123" },
				body: "hello, pcp",
			});
		}
	},

	onMessage: (ctx, message) => {
		const body = typeof message === "string" ? message : message.body;
		if (ctx.mode === "pcp" && body === "PING") {
			ctx.send({ action: "PONG", body: "" });
			return;
		}
		ctx.send(body);
	},
};

export default handler;
