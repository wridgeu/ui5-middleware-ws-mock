# UI5 Tooling v5 support

Branch: `feat/ui5-cli-5-alpha-support`. Date: 2026-07-17.

Goal: run the middleware under `@ui5/cli` 5 (currently `5.0.0-alpha.6`, the `next`
dist-tag) and support UI5 Tooling **4 and 5 from a single package line**, without
bundling or peer-depending on the CLI.

## Why this is not a rewrite

The package declares **no `@ui5/*` dependency**: not in `dependencies`,
`devDependencies`, or `peerDependencies`. Its coupling to the tooling is entirely
at runtime and narrow:

- the extension declares `specVersion: "4.0"` in `ui5.yaml`;
- the factory consumes `log`, `options.configuration`, `resources`, and
  `middlewareUtil.getProject().getRootPath()` / `.getSourcePath()`;
- it reaches the underlying HTTP server through the `ui5-utils-express` hook
  (`app.listen` monkey-patch + `router.stack` slotting).

So "v5 compatibility" is a question of whether that runtime contract still holds,
not a dependency bump.

## Findings (against 5.0.0-alpha.6)

| Contract point                                                  | v4 (4.0.x)          | v5 (5.0.0-alpha.6)       | Impact                                |
| --------------------------------------------------------------- | ------------------- | ------------------------ | ------------------------------------- |
| `@ui5/server` Express major                                     | Express `4.22.1`    | Express `4.22.2`         | Hook trick unaffected.                |
| `specVersion: "4.0"` acceptance                                 | accepted            | accepted                 | No `ui5.yaml` change.                 |
| `MiddlewareUtil` (`getProject`, `getRootPath`, `getSourcePath`) | present             | present                  | Path resolution unchanged.            |
| Native TS handler loading (type strip)                          | Node ≥ 22.18        | Node ≥ 22.18             | Handlers load unchanged.              |
| Engine floor (`engines.node`)                                   | `≥ 20.11 \|\| ≥ 22` | `^22.20.0 \|\| >=24.0.0` | **Only breaking change** (see below). |

Everything the middleware touches is stable across the two majors. The single
consequential difference is the CLI's engine requirement rising to
`^22.20.0 || >=24.0.0`.

## Validation

`test/e2e/run-v5-validation.mjs` (run via `npm run validate:v5`) boots a real
`ui5 serve` under the alpha CLI with the packed middleware and asserts, over a
live WebSocket:

- plain-mode echo (`onConnect` greeting + `onMessage` echo),
- a parametrized route (`ctx.params.userId` from `/ws/notify/:userId`),
- PCP subprotocol negotiation and framing (`v10.pcp.sap.com`).

All three pass under `@ui5/cli 5.0.0-alpha.6` on Node 24 (Windows and Linux). A
`.github/workflows/v5-validation.yml` job runs it on every PR (informational
while the CLI is a moving alpha) plus weekly, so a breaking alpha surfaces on its
own. The 114-test unit suite is unchanged and green.

## Decision

1. **Do not depend on the CLI.** Neither bundle it (`dependencies` would ship a
   redundant ~500-package copy the host already has) nor peer-depend on it (the
   host is guaranteed present, and no ecosystem middleware such as
   `ui5-middleware-simpleproxy`, `ui5-middleware-livereload`, or
   `ui5-tooling-transpile` declares such a peer).
   The supported range lives in docs (README badges + compatibility matrix) and
   in the e2e harness's `UI5_CLI_VERSION`.
2. **Keep `specVersion: "4.0"`.** It is accepted by both majors, so one package
   line serves `@ui5/cli` 4.x and 5.x.
3. **Raise `engines.node` to `^22.20.0 || >=24.0.0`.** This aligns the floor with
   `@ui5/cli` 5 and is the sole breaking change of the release. Consumers on Node
   22.18/22.19 with `@ui5/cli` 4.x stay on `0.5.x`.

## GA finalization checklist (this PR is a draft until then)

- [ ] Bump the e2e default `UI5_CLI_VERSION` from `^5.0.0-alpha.6` to `^5.0.0`.
- [ ] Re-run `npm run validate:v5` and confirm the three checks still pass.
- [ ] Flip `.github/workflows/v5-validation.yml` from `continue-on-error: true`
      to required.
- [ ] Land as a breaking release (conventional-commit `!` + `BREAKING CHANGE:`
      footer for the Node floor) so release-please cuts the version and the
      changelog records the v4-vs-v5 boundary.
