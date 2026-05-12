import type { WebSocketHandler } from "../../../src/types.js";

/**
 * Type-only contract lock for the discriminated-union `ctx.send` surface.
 * Not executed at runtime. The `@ts-expect-error` lines fail the typecheck if
 * the surface ever stops rejecting them, so a regression here is caught by
 * `npm run typecheck`, not by manual review.
 */
const handler: WebSocketHandler = {
	onConnect: (ctx) => {
		// String is in both branches: legal without narrowing.
		ctx.send("ok");

		// EncodeOptions without narrowing must NOT be legal. If the next line
		// stops erroring, `@ts-expect-error` itself becomes the error.
		// @ts-expect-error -- ctx is the un-narrowed union; only string is allowed
		ctx.send({ action: "X", body: "y" });

		if (ctx.mode === "pcp") {
			// Narrowing unlocks the EncodeOptions overload.
			ctx.send({ action: "X", body: "y" });
		}
	},
};

export default handler;
