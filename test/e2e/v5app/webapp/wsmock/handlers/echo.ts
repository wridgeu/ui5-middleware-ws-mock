import type { WebSocketHandler } from "ui5-middleware-ws-mock";

// Plain-mode echo plus a PCP-negotiation probe: `onConnect` greets, `onMessage`
// echoes the body back. The e2e runner asserts both the plain frames and, when
// the client offers `v10.pcp.sap.com`, the PCP-framed greeting.
const handler: WebSocketHandler = {
	onConnect: (ctx) => ctx.send("HELLO"),
	onMessage: (ctx, message) => {
		const body = typeof message === "string" ? message : message.body;
		ctx.send(`echo:${body}`);
	},
};

export default handler;
