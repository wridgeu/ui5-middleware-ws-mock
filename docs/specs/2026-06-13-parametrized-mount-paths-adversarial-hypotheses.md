# Adversarial test validation — parametrized mount paths

Branch: `feat/parametrized-mount-paths`. Date: 2026-06-13.

Goal: prove the green suite (92 tests) is not lying. Two angles:

1. **Non-feature paths** (literal match, plain/PCP, lifecycle, error handling) still genuinely covered.
2. **New feature** (path-to-regexp, `ctx.params`, first-match-wins, malformed-encoding fall-through, invalid-pattern disabling) genuinely tested — not passing for the wrong reason.

Runner chain: `npm test` → `vitest run` (exit code propagates). Mock of `ui5-utils-express/lib/hook.js` via `vi.mock`; `fireHook` throws if the factory never registered a callback (guards against a silently-unwired hook).

## Hypotheses

| #   | Hypothesis (how green could be lying)                              | Injected fault                                                | Expected                                            | Result |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------------- | --------------------------------------------------- | ------ |
| H0  | Runner exit code does not propagate; a real failure reports green  | Break one source behavior so a test fails                     | `npm test` exits non-zero                           |        |
| H1  | `ctx.params` extraction is not actually asserted (feature vacuous) | `matchRoute` returns `params: {}` instead of `result.params`  | named/optional/wildcard/percent tests fail          |        |
| H2  | Percent-decoding not really checked                                | n/a — covered by H1 (params dropped) + decode is library-side | café test fails under H1                            |        |
| H3  | First-match-wins / declaration order not asserted                  | Iterate `routes` in reverse in `matchRoute`                   | declaration-order + duplicate tests fail            |        |
| H4  | Malformed `%`-encoding handling vacuous (catch never proven)       | Remove the try/catch in `matchRoute` (let decode throw)       | `%ZZ` verbose-log test fails (waitForLog times out) |        |
| H5  | Invalid-pattern disabling vacuous (only log asserted)              | Rethrow compile error instead of capturing `matchError`       | invalid-pattern test fails (factory rejects)        |        |
| H6  | Literal (non-feature) match path silently broken but green         | `matchRoute` never returns a match (always null)              | literal/echo/PCP/lifecycle tests fail en masse      |        |
| H7  | Plain-mode send not asserted (non-feature vacuous)                 | `writeRaw` becomes a no-op                                    | echo / plain tests fail                             |        |
| H8  | Disabled-route skip at upgrade time unproven (line 405 uncovered)  | Coverage gap — no connection attempt to a disabled route      | documented as gap                                   |        |
| H9  | Suite can pass while executing ZERO tests                          | Point include glob at bogus path                              | vitest fails "No test files found"                  |        |

## Coverage baseline (pre-mutation)

`middleware.ts`: 92.4% stmts / 89.06% branch / 93.66% lines. Thresholds (90/85/90/90) pass.
Uncovered: log `silly`/`perf` passthroughs (188,190); `ws.close`/`terminate` throw catches (212,220); `toUtf8` Array/ArrayBuffer branches (254-256); disabled-route `continue` (405); `wss` `error`+`wsClientError` handlers (487,496-506); unparseable-URL catch (513-516). All pre-existing except 405 (feature).

## Results

| #   | Fault injected                             | Observed                                                             | Verdict                                  |
| --- | ------------------------------------------ | -------------------------------------------------------------------- | ---------------------------------------- |
| H0  | (via H1) any source break                  | `npm test` exit code = **1**                                         | CONFIRMED — exit propagates              |
| H1  | `matchRoute` returns `params: {}`          | 5 feature tests RED (named, percent, optional, wildcard, decl-order) | CONFIRMED — params assertions live       |
| H2  | (via H1)                                   | café/percent test RED                                                | CONFIRMED                                |
| H3  | reverse iteration in `matchRoute`          | decl-order + duplicate-mountPath tests RED (live timeouts)           | CONFIRMED — first-match-wins asserted    |
| H4  | change verbose log keyword                 | `%ZZ` malformed-encoding test RED                                    | CONFIRMED — assertion is specific & live |
| H5  | rethrow compile error instead of capturing | invalid-pattern test RED (factory rejects)                           | CONFIRMED                                |
| H6  | (covered transitively by H1/H7)            | —                                                                    | n/a                                      |
| H7  | `writeRaw` no-op (plain+PCP send)          | **25 non-feature tests RED**                                         | CONFIRMED — non-feature assertions live  |
| H8  | line 405 disabled-route skip uncovered     | confirmed gap → **test added & adversarially verified**              | FIXED                                    |
| H9  | runner pointed at bogus path               | vitest exits **1** ("No test files found")                           | CONFIRMED — never passes empty           |

All faults reverted; `git status` clean apart from this doc + the one added test.

## Findings applied

- **Closed the one feature-path gap (H8):** strengthened _"an invalid mountPath pattern is disabled … and never matches"_ to actually connect and assert fall-through to a coexisting upgrade listener. This executes `matchRoute`'s disabled-route skip (line 405) and makes the test's own "never matches" claim verified rather than aspirational. Mutation-checked: breaking the skip turns the test RED (15s timeout).

## Follow-up: closing the pre-existing non-feature gaps (judged case-by-case)

The remaining `middleware.ts` gaps were all pre-existing and off the feature path. Triaged by "does a test here assert a real contract reachable through the public surface, or is it coverage-theater?":

**Added (5 tests, all adversarially confirmed live — each mutation turns exactly its test RED):**

- `ws.close` / `ws.terminate` synchronous-throw catches (212, 220) — real defensive guarantee; the suite already tested the identical `ws.send`-throw via `send-throws.ts`. New fixtures `close-throws.ts` / `terminate-throws.ts`. Liveness: mutating the warn message → both RED.
- `toUtf8` `Buffer[]` (fragments) and `ArrayBuffer` branches (255, 256) — documented robustness feature; reachable by setting `ctx.ws.binaryType` in a handler. New fixture `echo-binarytype.ts` (`?bt=`). Liveness: making each branch return a sentinel → the matching test RED, while the pre-existing single-`Buffer` test stayed green (clean attribution).
- `silly`/`perf` log passthroughs (188, 190) — instead of two vacuous per-level forwarders, added one test asserting a real unverified contract: the scoped logger applies the route prefix at _every_ level. New fixture `log-levels.ts`. Liveness: mutating `silly→verbose` → RED.

**Deliberately NOT added (would be coverage-theater):**

- `WebSocketServer` `'error'` handler (487) — _now covered incidentally_ by the throw-fixtures' socket errors.
- `'wsClientError'` 400 path (496-505) — already covered by the pre-existing raw-TCP `probeMalformedUpgrade` test.
- `else socket.destroy()` (506) — needs a non-writable socket at the instant `wsClientError` fires; non-deterministic.
- Unparseable-URL catch (515-516) + the `req?.url ?? …` nullish fallbacks (496/513 right-hand side) — `new URL(req.url, base)` does not throw for any request target a real client (or Node's HTTP parser) will produce; reachable only by white-box stubbing. Pure defensive edges.

Coverage after follow-up: middleware.ts **97.46% stmts / 95.31% branch / 97.88% lines** (was 93.03/90.62/93.66). Only 506 and 515-516 remain uncovered — exactly the unreachable micro-branches above. 97 tests pass.
