/* eslint-disable no-unused-vars, no-unused-expressions, @typescript-eslint/no-namespace, @typescript-eslint/no-unused-vars -- research scratch; namespaces and helper bindings exist to host independent variants, not to be consumed at runtime */

/**
 * Research scratch: alternative typings for the mode-dependent `send` overload.
 *
 * Each `namespace` is one candidate variant. The same probes run against every
 * variant; `@ts-expect-error` annotations reflect the COMPILER's actual
 * behavior (not the desired behavior). If a variant fails to enforce a
 * constraint, the lack of an error here is itself the finding.
 *
 * Probes:
 *   P1. ctx.send("x") compiles in the un-narrowed context
 *   P2. ctx.send({...EncodeOptions}) is REJECTED in the un-narrowed context
 *   P3. ctx.send({...}) compiles after `ctx.mode === "pcp"` narrow
 *   P4. ctx.send({...}) is REJECTED after `ctx.mode === "plain"` narrow
 *   P5. Plain-mode-typed helper rejects options
 *   P6. The middleware can construct the correct send impl per runtime mode
 *
 * Run: `tsc --noEmit -p research/tsconfig.json` — should typecheck clean.
 */

interface WS {
	readyState: number;
	OPEN: number;
	send(data: string): void;
}
interface Req {
	url: string;
}

interface EncodeOptions {
	action?: string;
	bodyType?: string;
	fields?: Record<string, string>;
	body?: string;
}
declare function encode(opts?: EncodeOptions): string;
declare const ws: WS;
declare const req: Req;

// ============================================================================
// VARIANT A — Discriminated union (the chosen impl). Baseline.
// Verdict: passes ALL probes.
// ============================================================================
namespace VariantA_DiscriminatedUnion {
	interface Base {
		ws: WS;
		req: Req;
	}
	interface Plain extends Base {
		mode: "plain";
		send: (m: string) => void;
	}
	interface Pcp extends Base {
		mode: "pcp";
		send: (m: string | EncodeOptions) => void;
	}
	type Ctx = Plain | Pcp;

	declare const ctx: Ctx;

	ctx.send("x"); // P1 OK

	// @ts-expect-error -- P2: options reject without narrow
	ctx.send({ action: "X", body: "y" });

	if (ctx.mode === "pcp") {
		ctx.send({ action: "X", body: "y" }); // P3 OK
	}

	if (ctx.mode === "plain") {
		// @ts-expect-error -- P4
		ctx.send({ action: "X", body: "y" });
	}

	function helper(c: Plain) {
		c.send("ok");
		// @ts-expect-error -- P5
		c.send({ action: "X", body: "y" });
	}
	declare const p: Plain;
	helper(p);

	function build(mode: "plain" | "pcp"): Ctx {
		if (mode === "pcp") {
			return {
				ws,
				req,
				mode: "pcp",
				send: (m: string | EncodeOptions) =>
					ws.send(encode(typeof m === "string" ? { body: m } : m)),
			};
		}
		return { ws, req, mode: "plain", send: (m: string) => ws.send(m) };
	}
	build("plain"); // P6 OK
}

// ============================================================================
// VARIANT B — Plain method overloads on a single (non-union) Ctx.
// Verdict: FAILS P2. Overload-by-argument-shape lets options through with no
// regard for `mode`. The whole point of mode-driven gating is lost.
// ============================================================================
namespace VariantB_PlainOverloads {
	interface Ctx {
		ws: WS;
		req: Req;
		mode: "plain" | "pcp";
		send(message: string): void;
		send(message: EncodeOptions): void;
	}
	declare const ctx: Ctx;

	ctx.send("x"); // P1 OK
	ctx.send({ action: "X", body: "y" }); // ← P2 FAILS: this compiles, defeating the goal
	// P3, P4, P5 untestable — no narrowing flows through.

	// Even if you wanted to guard at runtime, the compiler has already
	// permitted misuse. Variant B is unsuitable.
}

// ============================================================================
// VARIANT C — `this`-typed method overloads.
// Verdict: FAILS P1. With `this: Plain` and `this: Pcp` overloads, the
// un-narrowed union `Plain | Pcp` matches NEITHER `this` — so even
// `ctx.send("x")` is rejected before the consumer narrows. That's the
// opposite trade-off of variant A and unusable as a default API.
// ============================================================================
namespace VariantC_ThisTypedOverloads {
	interface Base {
		ws: WS;
		req: Req;
	}
	interface Plain extends Base {
		mode: "plain";
	}
	interface Pcp extends Base {
		mode: "pcp";
	}

	interface SendHost {
		send(this: Plain & SendHost, message: string): void;
		send(this: Pcp & SendHost, message: string | EncodeOptions): void;
	}

	type CtxWithSend = (Plain | Pcp) & SendHost;
	declare const ctx: CtxWithSend;

	// @ts-expect-error -- P1 FAILS: union `this` matches neither overload
	ctx.send("x");

	if (ctx.mode === "pcp") {
		ctx.send({ action: "X", body: "y" }); // P3 works once narrowed
	}
	if (ctx.mode === "plain") {
		ctx.send("ok"); // P1 works once narrowed
	}

	// The fix (move `send` onto Plain/Pcp directly) is variant A.
}

// ============================================================================
// VARIANT D — Generic over mode: WebSocketContext<M>.
// Verdict: COLLAPSES to A. A non-generic handler must accept `Ctx<"plain"> |
// Ctx<"pcp">`, which is structurally identical to variant A. A generic handler
// (`<M extends Mode>`) cannot benefit from narrowing — `ctx.mode === "pcp"`
// does not re-solve `M`, so `ctx.send` keeps its original type.
// ============================================================================
namespace VariantD_GenericMode {
	type Mode = "plain" | "pcp";
	type SendFor<M extends Mode> = M extends "pcp"
		? (m: string | EncodeOptions) => void
		: (m: string) => void;

	interface Ctx<M extends Mode> {
		ws: WS;
		req: Req;
		mode: M;
		send: SendFor<M>;
	}

	function onConnectGeneric<M extends Mode>(ctx: Ctx<M>) {
		ctx.send("x"); // P1 OK

		// @ts-expect-error -- P2: un-narrowed M
		ctx.send({ action: "X", body: "y" });

		if (ctx.mode === "pcp") {
			// Narrowing on `mode` does NOT narrow `M`.
			// @ts-expect-error -- generic param not re-solved by property narrow
			ctx.send({ action: "X", body: "y" });
		}
	}
	onConnectGeneric;

	type EffectiveCtx = Ctx<"plain"> | Ctx<"pcp">;
	declare const ctxU: EffectiveCtx;
	ctxU.send("ok");
	if (ctxU.mode === "pcp") {
		ctxU.send({ action: "X", body: "y" }); // identical to variant A
	}
}

// ============================================================================
// VARIANT E — Two separate methods: sendText + sendPcp.
// Verdict: passes all probes via property existence, not narrowing.
// Different trade-off: simple to type, but the API surface is wider and
// PCP-string convenience is lost (no auto-wrap of "x" into a default frame
// unless you also keep sendText behaving differently per mode).
// ============================================================================
namespace VariantE_TwoMethods {
	interface Base {
		ws: WS;
		req: Req;
		sendText: (m: string) => void;
	}
	interface Plain extends Base {
		mode: "plain";
	}
	interface Pcp extends Base {
		mode: "pcp";
		sendPcp: (m: EncodeOptions) => void;
	}
	type Ctx = Plain | Pcp;

	declare const ctx: Ctx;

	ctx.sendText("x"); // P1' OK

	// @ts-expect-error -- P2': sendPcp not on union (only on Pcp)
	ctx.sendPcp({ action: "X", body: "y" });

	if (ctx.mode === "pcp") {
		ctx.sendPcp({ action: "X", body: "y" }); // P3' OK
	}

	if (ctx.mode === "plain") {
		// @ts-expect-error -- P4': sendPcp not on Plain
		ctx.sendPcp({ action: "X", body: "y" });
	}

	function helper(c: Plain) {
		c.sendText("ok");
		// @ts-expect-error -- P5'
		c.sendPcp({});
	}
	declare const p: Plain;
	helper(p);
}

// ============================================================================
// VARIANT F — Branded types on `mode`.
// Verdict: COLLAPSES to A + extra friction. Brands have no runtime
// representation, so consumers need user-defined type guards everywhere a
// plain `===` would have sufficed. Generic `Ctx<M>` brings back the D-style
// erasure problem on top.
// ============================================================================
namespace VariantF_Branded {
	type Branded<T, B extends string> = T & { readonly __brand: B };
	type PlainMode = Branded<"plain", "plain">;
	type PcpMode = Branded<"pcp", "pcp">;
	type AnyMode = PlainMode | PcpMode;

	type SendFor<M> = M extends PcpMode ? (m: string | EncodeOptions) => void : (m: string) => void;

	interface Ctx<M extends AnyMode = AnyMode> {
		ws: WS;
		req: Req;
		mode: M;
		send: SendFor<M>;
	}

	// User-defined guard on the CONTEXT (not the brand), because brand-narrow
	// does not flow through the conditional type.
	function isPcpCtx(c: Ctx<PlainMode> | Ctx<PcpMode>): c is Ctx<PcpMode> {
		return c.mode === ("pcp" as PcpMode);
	}

	declare const ctx: Ctx<PlainMode> | Ctx<PcpMode>;
	ctx.send("ok"); // P1 OK

	if (isPcpCtx(ctx)) {
		ctx.send({ action: "X", body: "y" }); // works only via the helper
	}
	// Net cost: every consumer imports `isPcpCtx`. No benefit over variant A.
}

// ============================================================================
// VARIANT G — Class with overloaded `send` method.
// Verdict: FAILS P2 — identical to variant B. Overloads do not consult
// `this.mode`. Runtime guards in the implementation can catch misuse, but
// the goal is COMPILE-TIME prevention.
// ============================================================================
namespace VariantG_ClassOverloads {
	class Ctx {
		readonly mode: "plain" | "pcp";
		constructor(mode: "plain" | "pcp") {
			this.mode = mode;
		}
		send(message: string): void;
		send(message: EncodeOptions): void;
		send(message: string | EncodeOptions): void {
			if (this.mode === "pcp") {
				ws.send(encode(typeof message === "string" ? { body: message } : message));
			} else if (typeof message === "string") {
				ws.send(message);
			} else {
				throw new Error("plain mode: options not allowed at runtime");
			}
		}
	}
	const ctx = new Ctx("plain");
	ctx.send("ok");
	ctx.send({ action: "X", body: "y" }); // ← P2 FAILS at type level
}

// ============================================================================
// VARIANT H — Generic send method with `this`-typing and conditional return.
// Verdict: FAILS P2 and P4. `send<T extends Mode>(this: Ctx & { mode: T },
// message: T extends "pcp" ? string | EncodeOptions : string)` lets TS pick
// `T = "pcp"` eagerly to fit the argument, so options sneak through even
// without narrowing.
// ============================================================================
namespace VariantH_GenericSendMethod {
	type Mode = "plain" | "pcp";
	interface Ctx {
		ws: WS;
		req: Req;
		mode: Mode;
		send<T extends Mode>(
			this: Ctx & { mode: T },
			message: T extends "pcp" ? string | EncodeOptions : string,
		): void;
	}

	declare const ctx: Ctx;

	ctx.send("x"); // P1 OK
	ctx.send({ action: "X", body: "y" }); // ← P2 FAILS

	if (ctx.mode === "pcp") {
		ctx.send({ action: "X", body: "y" }); // P3 OK
	}
	if (ctx.mode === "plain") {
		ctx.send({ action: "X", body: "y" }); // ← P4 FAILS too
	}
}
