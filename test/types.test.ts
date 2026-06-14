import { describe, expectTypeOf, it } from "vitest";

import type {
	EncodeOptions,
	PcpWebSocketContext,
	PlainWebSocketContext,
	RouteParams,
	WebSocketContext,
	WebSocketHandler,
} from "../src/index.js";

interface CounterState {
	count: number;
	userId?: string;
}

/**
 * Type-level regression tests for the discriminated `ctx.send` surface and
 * the single-mode narrowing patterns documented in the README. The assertions
 * live in the types and are enforced only by `npm run typecheck` (`tsc
 * --noEmit` covers the test tree, including this file). `vitest run` executes
 * the file but does not type-check it, so the `expectTypeOf` calls are runtime
 * no-ops; a broken contract would stay green under `npm test` alone. CI
 * guards the contract because `npm run check` runs the typecheck gate.
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

describe("ctx.data bag", () => {
	it("defaults to a loose Record when no type argument is supplied", () => {
		expectTypeOf<WebSocketContext["data"]>().toEqualTypeOf<Record<string, unknown>>();
		expectTypeOf<PlainWebSocketContext["data"]>().toEqualTypeOf<Record<string, unknown>>();
		expectTypeOf<PcpWebSocketContext["data"]>().toEqualTypeOf<Record<string, unknown>>();
	});

	it("threads the type argument into data on every branch", () => {
		expectTypeOf<WebSocketContext<CounterState>["data"]>().toEqualTypeOf<CounterState>();
		expectTypeOf<PlainWebSocketContext<CounterState>["data"]>().toEqualTypeOf<CounterState>();
		expectTypeOf<PcpWebSocketContext<CounterState>["data"]>().toEqualTypeOf<CounterState>();
	});

	it("preserves TData when narrowing on ctx.mode (the issue #16 blocker)", () => {
		// Mirror `if (ctx.mode === "pcp")` at the type level. The narrow must
		// keep `data` typed as `CounterState`, not collapse it to the default.
		type Narrowed<M extends WebSocketContext["mode"]> = Extract<
			WebSocketContext<CounterState>,
			{ mode: M }
		>;
		expectTypeOf<Narrowed<"pcp">>().toEqualTypeOf<PcpWebSocketContext<CounterState>>();
		expectTypeOf<Narrowed<"plain">>().toEqualTypeOf<PlainWebSocketContext<CounterState>>();
		expectTypeOf<Narrowed<"pcp">["data"]>().toEqualTypeOf<CounterState>();
		expectTypeOf<Narrowed<"plain">["data"]>().toEqualTypeOf<CounterState>();
	});

	it("flows TData from WebSocketHandler into every callback's ctx", () => {
		type Handler = WebSocketHandler<CounterState>;
		expectTypeOf<NonNullable<Handler["onConnect"]>>()
			.parameter(0)
			.toEqualTypeOf<WebSocketContext<CounterState>>();
		expectTypeOf<NonNullable<Handler["onMessage"]>>()
			.parameter(0)
			.toEqualTypeOf<WebSocketContext<CounterState>>();
		expectTypeOf<NonNullable<Handler["onClose"]>>()
			.parameter(0)
			.toEqualTypeOf<WebSocketContext<CounterState>>();
		expectTypeOf<NonNullable<Handler["onError"]>>()
			.parameter(0)
			.toEqualTypeOf<WebSocketContext<CounterState>>();
	});
});

describe("ctx.params", () => {
	it("is the public RouteParams record on every branch", () => {
		// `RouteParams` is the percent-decoded string/string[] map surfaced on
		// `ctx.params`; it is re-exported from the package root so consumers can
		// name it. The shape assertion guards the definition itself.
		expectTypeOf<RouteParams>().toEqualTypeOf<Record<string, string | string[]>>();
		expectTypeOf<WebSocketContext["params"]>().toEqualTypeOf<RouteParams>();
		expectTypeOf<PlainWebSocketContext["params"]>().toEqualTypeOf<RouteParams>();
		expectTypeOf<PcpWebSocketContext["params"]>().toEqualTypeOf<RouteParams>();
	});

	it("is independent of TData and survives narrowing on ctx.mode", () => {
		// `params` is a plain field (not parameterized by TData), so it stays
		// `RouteParams` after both the `<TData>` instantiation and the
		// `if (ctx.mode === "pcp")` narrow.
		type Narrowed<M extends WebSocketContext["mode"]> = Extract<
			WebSocketContext<CounterState>,
			{ mode: M }
		>;
		expectTypeOf<WebSocketContext<CounterState>["params"]>().toEqualTypeOf<RouteParams>();
		expectTypeOf<Narrowed<"pcp">["params"]>().toEqualTypeOf<RouteParams>();
		expectTypeOf<Narrowed<"plain">["params"]>().toEqualTypeOf<RouteParams>();
	});
});
