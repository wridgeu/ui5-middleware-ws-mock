import type { WebSocketHandler } from "../../../src/types.js";

/**
 * Emits one log line at every `ctx.log` level on connect, so a test can assert
 * the scoped logger forwards each level to the host logger with the route
 * prefix applied. `silly` and `perf` have no other call site in the middleware.
 */
const handler: WebSocketHandler = {
	onConnect: (ctx) => {
		ctx.log.silly("silly-line");
		ctx.log.perf("perf-line");
		ctx.log.verbose("verbose-line");
		ctx.log.info("info-line");
		ctx.log.warn("warn-line");
		ctx.log.error("error-line");
	},
};

export default handler;
