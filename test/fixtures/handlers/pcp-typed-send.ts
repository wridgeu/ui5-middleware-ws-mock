import type { WebSocketHandler } from "../../../src/types.js";

/**
 * Spike fixture for the typed `ctx.send` overload.
 *
 *   - String calls stay legal in both modes (mode-erased call sites compile).
 *   - PCP-only calls (custom action, body-type, fields) become legal once
 *     `ctx.mode === "pcp"` narrows the discriminated union.
 *   - The middleware calls `encode()` internally, so handlers no longer have
 *     to import it for the common cases.
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
