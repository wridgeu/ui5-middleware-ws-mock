import type {
	PcpWebSocketContext,
	WebSocketContext,
	WebSocketHandler,
} from "../../../src/types.js";

/**
 * Type-only contract lock for the discriminated-union `ctx.send` surface and
 * the single-mode narrowing patterns documented in the README. Not executed
 * at runtime. The `@ts-expect-error` lines fail the typecheck if the surface
 * ever stops rejecting them, so a regression here is caught by
 * `npm run typecheck`, not by manual review.
 */

function assertPcp(ctx: WebSocketContext): asserts ctx is PcpWebSocketContext {
	if (ctx.mode !== "pcp") throw new Error("expected PCP route");
}

const handler: WebSocketHandler = {
	onConnect: (ctx) => {
		// String is in both branches: legal without narrowing.
		ctx.send("ok");

		// EncodeOptions without narrowing must NOT be legal. If the next line
		// stops erroring, `@ts-expect-error` itself becomes the error.
		// @ts-expect-error -- ctx is the un-narrowed union; only string is allowed
		ctx.send({ action: "X", body: "y" });

		if (ctx.mode === "pcp") {
			// Discriminant narrow unlocks the EncodeOptions overload.
			ctx.send({ action: "X", body: "y" });
		}
	},

	onMessage: (ctx) => {
		// Early-return narrow (README "Asserting a single mode" — pattern 1).
		// After the throw, ctx is narrowed to PcpWebSocketContext.
		if (ctx.mode !== "pcp") throw new Error("requires PCP");
		ctx.send({ action: "POST_THROW", body: "narrowed" });
	},

	onClose: (ctx) => {
		// `asserts` helper (README "Asserting a single mode" — pattern 1 variant).
		assertPcp(ctx);
		ctx.send({ action: "POST_ASSERT", body: "narrowed" });

		// Inline cast (README "Asserting a single mode" — pattern 2).
		const c = ctx as PcpWebSocketContext;
		c.send({ action: "POST_CAST", body: "narrowed" });
	},
};

// Parameter-narrowing variant must NOT compile (README NOTE callout). If this
// becomes legal one day, the directive flags the change at typecheck.
export const paramNarrowIsRejected: WebSocketHandler = {
	// @ts-expect-error -- function-property contravariance forbids narrowing the param
	onConnect: (ctx: PcpWebSocketContext) => {
		ctx.send({ action: "X", body: "y" });
	},
};

export default handler;
