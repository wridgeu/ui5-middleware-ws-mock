# e2e: real `ui5 serve` validation

The unit suite drives the middleware factory with a structural stand-in for the
UI5 tooling harness. It proves the middleware's own logic but never boots a real
`ui5 serve`, so it cannot catch a break in the runtime contract the tooling
provides: the factory parameters, `specVersion` acceptance, or the
`ui5-utils-express` hook that reaches the underlying HTTP server.

This harness closes that gap. [`run-v5-validation.mjs`](run-v5-validation.mjs):

1. builds and packs the middleware from the repo root,
2. copies the [`v5app/`](v5app) fixture to a temp directory and installs
   `@ui5/cli` plus the packed tarball into the copy,
3. boots `ui5 serve` against it, and
4. connects real WebSocket clients to assert plain-mode echo, a parametrized
   route (`ctx.params`), and PCP subprotocol negotiation.

## Run it

```bash
npm run validate:v5
```

Environment knobs:

| Variable          | Default          | Purpose                                                  |
| ----------------- | ---------------- | -------------------------------------------------------- |
| `UI5_CLI_VERSION` | `^5.0.0-alpha.6` | npm version or dist-tag of `@ui5/cli` to install.        |
| `KEEP_TMP`        | unset            | Set to `1` to leave the temp app in place for debugging. |

The middleware declares no `@ui5/*` dependency (the host `ui5 serve` process
provides the runtime), so the CLI version under test lives in this harness, not
in `package.json`. Point `UI5_CLI_VERSION` at the alpha today; bump the default
to the GA release once it ships and re-run to re-validate.
