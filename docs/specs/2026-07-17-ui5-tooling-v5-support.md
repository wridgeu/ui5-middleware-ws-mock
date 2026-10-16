# UI5 Tooling v5 support

Status: **draft, tracking the `@ui5/cli` 5 pre-release** (`next` dist-tag,
`5.0.0-alpha.13` at the time of writing, 2026-10-16). `latest` is still 4.0.x.
Finish this once `@ui5/cli` 5 is released; the checklist is at the end.

Goal: support UI5 Tooling **4 and 5 from a single package line**, without bundling
or peer-depending on the CLI.

## How the middleware gets at the HTTP server

A WebSocket upgrade never passes through the Express middleware chain; it is an
`'upgrade'` event on the Node `http.Server`. The middleware therefore needs the
server object. UI5 Tooling does not hand it to custom middleware, so we use
[`ui5-utils-express/lib/hook.js`](https://github.com/petermuessig/ui5-utils-express),
which returns a function that Express treats as a mountable sub-app. When Express
mounts it, the hook receives the `mount` event, wraps `app.listen`, and calls our
callback with the `http.Server` once the app listens. That works because UI5 Tooling
4 builds the server as `express().listen(...)`.

Coupling to the tooling is otherwise small: `specVersion: "4.0"`, the factory
params (`log`, `options.configuration`, `middlewareUtil`) and that hook. The package
declares no `@ui5/*` dependency (a `dependencies` entry would ship a ~500-package
copy of a CLI the host already provides, and no comparable middleware such as
`ui5-middleware-simpleproxy` or `ui5-tooling-transpile` declares a peer), so the
supported range is documented and enforced by the CI matrix instead.

## What changed in v5 and what broke

| Contract point                                                  | v4 (`4.0.x`)                                      | v5 (`5.0.0-alpha.13`)                                                                                      | Effect                                                                                                               |
| --------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| HTTP server creation                                            | `express().listen()`                              | `Supervisor` calls `http.createServer(dispatcher)`; the per-stack `express()` app is **never listened on** | **Breaks the hook**: `app.listen` is never called, so our callback never fires and no upgrade listener is attached.  |
| Express                                                         | 4.x                                               | 5.x                                                                                                        | Handled: the hook already reads `app.router`.                                                                        |
| How the hook's function is invoked                              | mounted as a sub-app (`handle` / `emit('mount')`) | **called directly** as `fn(req, res, next)`                                                                | The hook's direct-call path looks for `req.app.server`, finds nothing and logs `Failed to hook into current server`. |
| `specVersion: "4.0"`                                            | accepted                                          | accepted                                                                                                   | None.                                                                                                                |
| `MiddlewareUtil` (`getProject`, `getRootPath`, `getSourcePath`) | present                                           | present                                                                                                    | None.                                                                                                                |
| Re-initialization                                               | n/a                                               | the server re-creates the serving stack (and so the middleware) against the **same** `http.Server`         | A naive attach would stack a second `'upgrade'` listener.                                                            |
| `engines.node`                                                  | `>= 20.11 \|\| >= 22`                             | `^22.20.0 \|\| >=24.0.0`                                                                                   | Floor of this package raised to match.                                                                               |

An earlier version of this document concluded "the contract is stable across the two
majors". That was verified against `5.0.0-alpha.6`, which still used `app.listen`.
The server layer was rewritten in `5.0.0-alpha.7` (UI5/cli PR 1478, 2026-08-05: a
`Supervisor` that re-creates the serving stack behind one stable `http.Server`). The
symptom is that handlers load (the startup log looks healthy) but WebSocket connects
get no upgrade, because nothing listens for `'upgrade'`.

## What was tried

1. **Keep the hook unchanged (the alpha.6 approach).** Works on alpha.6, fails on
   alpha.13: the callback never fires. The e2e harness reported all three checks
   failing (it originally hung; it now times out per check).
2. **Pass a request-path callback as the hook's third argument**
   (`hook(name, cb, middleware)`; the hook's `handle` delegates to it). Failed on v5:
   v5 calls the returned function directly instead of going through `handle`, so the
   third argument is never reached and only the `Failed to hook` error is logged.
3. **Take the server from `req.socket.server` on the first request and attach
   there.** Prototyped by replacing the hook entirely, then productized. Works on
   alpha.13.

## Current implementation (`src/middleware.ts`)

- `attach(server)` holds all upgrade handling (the former hook callback body).
- The factory still calls the hook (v4 attaches at listen time through it) and keeps
  the hook's mount protocol (`handle`, `set`, `emit`) via `Object.assign`, but the
  returned function's **direct-call** behaviour is replaced by `attachFromRequest`:
  it reads `req.socket.server` and attaches if this instance has not attached to that
  server yet. That is the path v5 exercises.
- `attachedInstances` (a `WeakMap<Server, Map<entry name, dispose>>`) makes a re-created instance
  dispose the previous one (remove its `'upgrade'` listener, restore `server.close`,
  terminate its clients) before attaching, so a v5 re-initialization does not stack
  listeners or keep stale routes.
- The e2e harness does an HTTP `GET /index.html` before opening sockets, as a real
  page would.

### Known limitations

- **A WebSocket opened before any HTTP request reaches the middleware is not served
  under v5.** The server is only discovered from the first request's socket. A UI5
  page loads over HTTP first, so this is normally invisible. A bare client that
  connects first is not upgraded: it hangs while another upgrade listener (the
  built-in live reload) is registered, and otherwise receives an ordinary non-101
  HTTP response (observed on Node 26; other versions not checked).
- **Re-initialization has a stale window.** After a `ui5.yaml` / `package.json` change
  the server re-creates the stack, but the new instance only attaches on the next HTTP
  request. Until then the old routes keep working and new ones are not served; on
  attach the old instance is disposed and its open mock clients are dropped with
  `terminate()` (close code 1006), not a clean close. Edits under `webapp/` do not
  re-initialize. Observed on alpha.13: the listener count stays at live reload + ours
  after repeated re-initializations (no pile-up).
- **No `Origin` check** (as before); v5's built-in live reload does require a token.
  See the README limitation.
- Two `customMiddleware` entries of this package coexist (they are keyed by the entry
  name UI5 assigns); only a re-created instance with the same name replaces the old one.
- Relies on `req.socket.server`, a property of Node's `net.Socket` that the type
  definitions do not declare. v5 has no HTTP/2 mode (`--https` replaced it and
  works). On v4 `--h2` exits on Node 24+; on older Node (spdy) the `app.listen` hook
  does not fire either, so that mode already had the first-request limitation.
- The v5 internals described above are alpha-stage and may change again; the CI
  `next` leg exists to catch that.

### Option evaluated: attach at listen time (not adopted)

To remove the "WebSocket before first HTTP request" limitation, a `diagnostics_channel`
prototype (`tracing:net.server.listen:asyncEnd`, plus the `ui5.server-listening`
process event for the port) was tried on v4 and on 5.0.0-alpha.13:

- Attaching to the first http/https server that listens is **unsafe** on v5: it picks
  the live reload server (port 35729) or another plugin's server.
- Matching the port from `ui5.server-listening` fixes that. A gap of about 3-7 ms
  between listen and announcement remains. It leaks after a v5 stack rebuild unless the
  server is remembered at module level, and it picks the wrong server when two servers
  share a port number across IPv4/IPv6, unless the bind address is matched too.
- Untested: v4 https/h2, a failing rebuild, browsers.

Judged not worth the reliance on tooling internals for a limitation that only affects
clients connecting before the page loads. Revisit if v5 ships a supported API.

## Validation

`test/e2e/run-cli-validation.mjs` (`npm run validate:cli`) installs the packed
middleware next to a real `@ui5/cli`, boots `ui5 serve` and asserts over live
WebSockets: an HTTP page load, plain-mode echo, a parametrized route
(`/ws/notify/:userId`) and PCP negotiation.
`.github/workflows/cli-validation.yml` runs it for `latest` and `next` (informational
while v5 is a pre-release) on Node 24, Linux and Windows, on pull requests that touch
the code and on demand. There is deliberately no schedule, so a new `@ui5/cli` release
that breaks the contract is only noticed on the next PR or manual run.

Last local result (2026-10-16, Node 26): all checks pass on `@ui5/cli` 4.0.71 and
5.0.0-alpha.13. Unit tests cover the request-path attach, per-server
de-duplication, replacement of a re-created instance, and that later requests do
not disturb open mock connections.

## Decision

1. **Do not depend on the CLI** (see above).
2. **Keep `specVersion: "4.0"`**; both majors accept it.
3. **Raise `engines.node` to `^22.20.0 || >=24.0.0`.** Aligns with `@ui5/cli` 5 and
   is the one breaking change. Consumers on Node 22.18/22.19 stay on the previous
   release line.

## Checklist before this leaves draft (once `@ui5/cli` 5 is released)

- [ ] Re-run `npm run validate:cli` with `UI5_CLI_VERSION` set to the released 5.x
      and to the last 4.x; all checks green on both.
- [ ] Re-check the mechanism against the release: does the server still avoid
      `app.listen`, and is `req.socket.server` still the server? Look for a
      supported API that exposes the server (or upgrade handling) to custom
      middleware and prefer it over the socket lookup.
- [ ] Decide what to do about the "WebSocket before first HTTP request" limitation
      (document it, or use the supported API from the previous item).
- [ ] Check `ui5 serve --h2` and re-initialization (edit `ui5.yaml` while serving)
      manually.
- [ ] Make the `next` CI leg required (or point the legs at the released 5.x and a
      pinned `^4`).
- [ ] Land as a breaking release: conventional commit `feat!:` with a
      `BREAKING CHANGE:` footer for the Node floor.
