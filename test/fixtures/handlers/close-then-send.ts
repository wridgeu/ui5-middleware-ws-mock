import type { WebSocketHandler } from "../../../src/types.js";

/**
 * Closes the connection on connect, then immediately calls `ctx.send`. The
 * `close()` flips `ws.readyState` from OPEN to CLOSING synchronously, so the
 * subsequent `send` exercises the non-open-socket warn path inside
 * `createContext`.
 */
const handler: WebSocketHandler = {
	onConnect: (ctx) => {
		ctx.close(1000, "bye");
		ctx.send("late");
	},
};

export default handler;
