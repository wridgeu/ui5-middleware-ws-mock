import type { WebSocketHandler } from "../../../src/types.js";

/**
 * Forces the underlying `ws` socket into a non-default `binaryType` (read from
 * the `?bt=` query of the upgrade URL) so that inbound binary frames reach the
 * middleware as `Buffer[]` (`fragments`) or `ArrayBuffer` (`arraybuffer`)
 * rather than the default single `Buffer`. Echoes the middleware-decoded
 * (utf-8) message so a test can assert `toUtf8` normalized it correctly.
 */
const handler: WebSocketHandler = {
	onConnect: (ctx) => {
		const bt = new URL(ctx.req.url ?? "/", "http://localhost").searchParams.get("bt");
		if (bt === "fragments" || bt === "arraybuffer" || bt === "nodebuffer") {
			ctx.ws.binaryType = bt;
		}
	},
	onMessage: (ctx, message) => {
		ctx.send(`ECHO:${message as string}`);
	},
};

export default handler;
