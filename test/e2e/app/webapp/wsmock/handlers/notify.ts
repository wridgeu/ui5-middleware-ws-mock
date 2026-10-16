import type { WebSocketHandler } from "ui5-middleware-ws-mock";

// Parametrized route: proves `ctx.params` is populated from the `:userId`
// segment of the mount path under the v5-alpha tooling.
const handler: WebSocketHandler = {
	onConnect: (ctx) => {
		const userId = typeof ctx.params.userId === "string" ? ctx.params.userId : "?";
		ctx.send(`subscribed:${userId}`);
	},
};

export default handler;
