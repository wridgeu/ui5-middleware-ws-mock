import type { WebSocketHandler } from "../../../src/types.js";

interface CounterState {
	count: number;
}

/**
 * Per-connection counter that lives entirely in `ctx.data`, exercising the
 * typed bag end to end:
 *
 *   - onConnect reports whether the bag began empty, then seeds `count = 0`.
 *   - onMessage increments and echoes the running count. `ctx.data.count += 1`
 *     compiles with no cast, which is the point of `WebSocketHandler<TData>`.
 *   - onClose logs the final count so a log assertion can confirm the same bag
 *     reached the close hook.
 *
 * The runtime test drives two connections in parallel to prove the bags are
 * isolated per connection.
 */
const handler: WebSocketHandler<CounterState> = {
	onConnect: (ctx) => {
		ctx.send(`init:empty=${Object.keys(ctx.data).length === 0}`);
		ctx.data.count = 0;
	},
	onMessage: (ctx) => {
		ctx.data.count += 1;
		ctx.send(`count=${ctx.data.count}`);
	},
	onClose: (ctx) => {
		ctx.log.info(`final count=${ctx.data.count}`);
	},
};

export default handler;
