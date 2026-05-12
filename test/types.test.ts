import { describe, expectTypeOf, it } from "vitest";

import type {
	EncodeOptions,
	PcpWebSocketContext,
	PlainWebSocketContext,
	WebSocketContext,
	WebSocketHandler,
} from "../src/index.js";

/**
 * Type-level regression tests for the discriminated `ctx.send` surface and
 * the single-mode narrowing patterns documented in the README. These checks
 * run under `npm test` (Vitest evaluates the file) and under
 * `npm run typecheck` (`tsc --noEmit` covers the test tree). Either gate is
 * sufficient to catch a contract regression; running both is belt + braces.
 *
 * The runtime `it()` bodies are no-ops; the assertions live in the types.
 */

describe("ctx.send surface", () => {
	it("plain-mode send accepts string only", () => {
		expectTypeOf<PlainWebSocketContext["send"]>().toEqualTypeOf<(m: string) => void>();
	});

	it("pcp-mode send accepts string or EncodeOptions", () => {
		expectTypeOf<PcpWebSocketContext["send"]>().toEqualTypeOf<
			(m: string | EncodeOptions) => void
		>();
	});

	it("mode is the union discriminant", () => {
		expectTypeOf<PlainWebSocketContext["mode"]>().toEqualTypeOf<"plain">();
		expectTypeOf<PcpWebSocketContext["mode"]>().toEqualTypeOf<"pcp">();
		expectTypeOf<WebSocketContext["mode"]>().toEqualTypeOf<"plain" | "pcp">();
	});

	it("WebSocketContext is the union of the two named branches", () => {
		expectTypeOf<WebSocketContext>().toEqualTypeOf<
			PlainWebSocketContext | PcpWebSocketContext
		>();
	});
});

describe("narrowing", () => {
	it("narrowing on ctx.mode unlocks the EncodeOptions overload", () => {
		// Use a `Extract` helper to mirror what `if (ctx.mode === "pcp")`
		// does to the union at the type level, without touching a runtime
		// value.
		type Narrowed<M extends WebSocketContext["mode"]> = Extract<WebSocketContext, { mode: M }>;
		expectTypeOf<Narrowed<"pcp">>().toEqualTypeOf<PcpWebSocketContext>();
		expectTypeOf<Narrowed<"plain">>().toEqualTypeOf<PlainWebSocketContext>();
		expectTypeOf<Narrowed<"pcp">["send"]>()
			.parameter(0)
			.toEqualTypeOf<string | EncodeOptions>();
		expectTypeOf<Narrowed<"plain">["send"]>().parameter(0).toEqualTypeOf<string>();
	});

	it("function-property contravariance forbids narrowing the param", () => {
		// `WebSocketHandler.onConnect` is declared as a function PROPERTY (not
		// a method shorthand); under `strictFunctionTypes` function-property
		// parameters are checked contravariantly. A handler that only accepts
		// `PcpWebSocketContext` is therefore NOT assignable to the public
		// handler contract. The `@ts-expect-error` directive below is the test:
		// if this assignment ever becomes legal, the directive fails.
		const bad: WebSocketHandler = {
			// @ts-expect-error -- param contravariance forbids narrowing here
			onConnect: (ctx: PcpWebSocketContext) => ctx.send({ body: "x" }),
		};
		expectTypeOf(bad).toMatchTypeOf<WebSocketHandler>();
	});
});
