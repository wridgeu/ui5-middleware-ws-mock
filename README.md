<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License"></a>
  <a href="https://www.npmjs.com/package/ui5-middleware-ws-mock"><img src="https://img.shields.io/npm/v/ui5-middleware-ws-mock.svg" alt="npm"></a>
  <a href="https://npmx.dev/package/ui5-middleware-ws-mock"><img src="https://img.shields.io/npm/v/ui5-middleware-ws-mock?label=npmx.dev&color=0a0a0a" alt="npmx"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node-%E2%89%A522.18-green.svg" alt="Node"></a>
  <a href="https://ui5.github.io/cli/stable/pages/Configuration/"><img src="https://img.shields.io/badge/UI5%20Tooling%20specVersion-4.0-blue.svg" alt="UI5 Tooling specVersion"></a>
  <a href="https://www.npmjs.com/package/@ui5/cli"><img src="https://img.shields.io/badge/%40ui5%2Fcli-%E2%89%A54.0.0-blue.svg" alt="UI5 CLI"></a>
</p>

<h1 align="center">ui5-middleware-ws-mock</h1>

A UI5 custom server middleware that mocks WebSocket endpoints alongside the rest of the `ui5 serve` stack. It registers under `customMiddleware` in `ui5.yaml`, hooks the underlying HTTP server's `upgrade` event, optionally negotiates the SAP Push Channel Protocol (PCP) `v10.pcp.sap.com` subprotocol, and routes each WebSocket connection to a per-route handler module supplied by the consuming application.

The transport is plain WebSocket. When the client offers it, the middleware also speaks WebSocket framed under SAP's PCP v1.0 subprotocol. The middleware does not impose a payload contract beyond that wire layer: handlers may exchange JSON, plain text, base64, or any other payload format with their clients. One optional convention, **action routing**, is layered on top to simplify the common named-message-to-callback pattern; it is opt-in and documented in its own section below.

> [!NOTE]
> Much of this repository was authored hands-off, through speech-to-text dictation paired with AI coding assistance, during post-surgery recovery with only one hand. That said, the majority of the implementation is grounded in pre-existing patterns from the UI5 ecosystem (notably Peter Muessig's work credited below) and conventional Node / WebSocket / PCP techniques that were ported, refactored, and hardened. It was partially "vibe-coded". There can be hallucinations missed during review or simple consumption-side bugs; no software is perfect. Feel free to open an issue or a PR and fix them directly.

## What it does

- Listens for HTTP upgrade requests on the paths declared in `ui5.yaml`.
- Negotiates the PCP v1.0 subprotocol when the client offers it; otherwise runs in plain WebSocket mode. Handlers see `ctx.mode` but write mode-agnostic code.
- Loads one handler module per route at startup (TypeScript or JavaScript).
- Decodes inbound frames per mode and dispatches them via the optional action-routing convention, falling back to a catch-all `onMessage` for anything else.
- Encodes outbound frames in PCP or plain JSON envelope per connection, byte-compatible with `sap.ui.core.ws.SapPcpWebSocket`.
- Logs handler failures, malformed frames, and non-open-socket sends without crashing `ui5 serve` or the connection.

## What it does not do

- Does not expose an arbitrary Express middleware. HTTP-level middleware should be registered as a separate `customMiddleware` entry.
- Does not support multiple handler modules per route. Each route resolves to exactly one handler file. Composition belongs inside the handler module.
- Does not support dynamic or parametrized mount paths. `mountPath` is matched against the request pathname literally. UI5-style route patterns with optional or mandatory parameters (`{param}`, `:optional?`, etc.) are not supported. Per-resource routing should be derived from `req.url` inside the handler.
- Does not persist state across server restarts.
- Does not mock any specific business protocol. The action-routing shape is a convention, not a contract; payload semantics are entirely consumer-defined.
- Does not proxy to a real backend. For proxying, use [`ui5-middleware-simpleproxy`](https://www.npmjs.com/package/ui5-middleware-simpleproxy) or `fiori-tools-proxy`.

## Quick start

1. Install:

    ```bash
    npm install --save-dev ui5-middleware-ws-mock
    ```

2. Register under `server.customMiddleware` in `ui5.yaml`:

    ```yaml
    server:
        customMiddleware:
            - name: ui5-middleware-ws-mock
              afterMiddleware: compression
              configuration:
                  routes:
                      - mountPath: /ws/foo
                        handler: ./wsmock/handlers/foo.ts
    ```

    Clients connect to `ws://<host>:<port><mountPath>`. `handler` resolves relative to the directory containing `ui5.yaml`.

    The middleware's `kind: extension` declaration ships in the package and is auto-discovered by `@ui5/server`; no separate extension file is required in the consuming application.

3. Write a handler module at `./wsmock/handlers/foo.ts`. `default`-export a `WebSocketHandler`:

    ```typescript
    import type { WebSocketHandler } from "ui5-middleware-ws-mock";

    const handler: WebSocketHandler = {
    	onConnect: (ctx) => ctx.send({ action: "HELLO", data: {} }),
    	actions: {
    		FOO_REQUEST: (ctx, data) => ctx.send({ action: "FOO_REPLY", data }),
    	},
    	onClose: (ctx, code) => ctx.log.info(`close ${code}`),
    };

    export default handler;
    ```

    The handler runs in the `ui5 serve` Node process; action names like `FOO_REQUEST` are application-defined.

4. Run `npm start`. The server log prints one pair of lines per configured route:

    ```text
    [ws-mock:/ws/foo] handler loaded from ./wsmock/handlers/foo.ts
    [ws-mock] listening for upgrades on: /ws/foo
    ```

> [!TIP]
> **Restart `ui5 serve` after editing configuration or handlers.** Livereload covers `webapp/`-side code only. Changes to `ui5.yaml` (new routes, renamed mount paths) and changes to handler modules are picked up at the next server boot. To automate this, run `ui5 serve` under a process supervisor such as `tsx watch` or `nodemon --watch <handlers-dir>`.

## Configuration

The `configuration` block under the `customMiddleware` entry accepts:

| Key                  | Type               | Required | Description                                                                                                                                                |
| -------------------- | ------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routes`             | `WebSocketRoute[]` | yes      | One entry per mount path. Each entry declares a path and the file that provides the handler module.                                                        |
| `routes[].mountPath` | `string`           | yes      | Path such as `/ws/foo`. Matched against the upgrade request pathname literally; no parameter patterns. Clients connect to `ws://<host>:<port><mountPath>`. |
| `routes[].handler`   | `string`           | yes      | Path to the handler module, resolved relative to the directory containing `ui5.yaml`. Exactly one handler per route.                                       |

A minimal single-route configuration:

```yaml
configuration:
    routes:
        - mountPath: /ws/foo
          handler: ./wsmock/handlers/foo.ts
```

Multiple routes in the same middleware entry are supported. Each route loads its own handler module:

```yaml
configuration:
    routes:
        - mountPath: /ws/foo
          handler: ./wsmock/handlers/foo.ts
        - mountPath: /ws/bar
          handler: ./wsmock/handlers/bar.ts
```

## Wire layer: WebSocket and PCP

The middleware speaks WebSocket. When the connecting client offers the `v10.pcp.sap.com` subprotocol, the middleware also speaks PCP framing. That is the entire wire-level contract.

- **Plain WebSocket.** A frame is whatever bytes the peers exchanged. The middleware imposes no specific shape.
- **PCP.** Frames are split into header fields and a body, per the [SAP PCP v1.0 spec](https://community.sap.com/t5/application-development-and-automation-blog-posts/specification-of-the-push-channel-protocol-pcp/ba-p/13137541). Negotiation happens once per connection at the handshake; every frame on the connection is PCP-framed in both directions thereafter.

Either mode can carry any payload format (JSON objects, opaque text, base64-encoded bytes, line-delimited records, etc.); the decoded body is forwarded to the handler unchanged.

The PCP v1.0 codec is implemented in [`src/pcp.ts`](src/pcp.ts); the `ws` package itself has no PCP awareness.

## Action routing (an opinionated convention, opt-in)

On top of the raw wire, the middleware exposes **one** opinionated convention to simplify the common case of mapping an inbound message name to a callback. The convention is opt-in and entirely optional: handlers that do not declare an `actions` map are unaffected, and a handler may use only `onMessage` to read `frame.raw` and ignore action routing completely.

The convention treats a frame as carrying a routing key called `action`:

- **PCP mode.** `action` is read from the PCP custom header field named `action`.
- **Plain mode.** `action` is read from a JSON envelope of the form `{ "action": "<name>", "data": <payload> }` placed in the body.

Action routing is not part of WebSocket and not part of PCP; both are pure transport. It is a dispatch layer added by this middleware and reflects one specific opinion about how to structure mock messages. Consumers who prefer a different shape should bypass it and decode `frame.raw` inside `onMessage`. The same `{ action, data }` shape is what `ctx.send` produces in the outbound direction, so a client that speaks the convention sees a symmetric contract on both sides; clients that do not are unaffected.

### Dispatch precedence

1. The middleware decodes the frame per the negotiated `ctx.mode` (PCP or plain).
2. If the decoded `action` matches a key in `actions`, that callback runs and only that callback. `data` is passed as the second argument.
3. Otherwise, if `onMessage` is defined, it runs with the full decoded frame (`action`, `data`, `raw`). Useful for catch-all logging or framing the action-routing convention does not cover.
4. Otherwise the frame is dropped with a debug log.

## Handler API

A handler module default-exports an object implementing `WebSocketHandler` (defined in [`src/types.ts`](src/types.ts)):

```typescript
export interface WebSocketHandler {
	onConnect?: (ctx: WebSocketContext) => void | Promise<void>;
	onMessage?: (ctx: WebSocketContext, frame: WebSocketInboundFrame) => void | Promise<void>;
	onClose?: (ctx: WebSocketContext, code: number, reason: string) => void | Promise<void>;
	actions?: Record<string, (ctx: WebSocketContext, data: unknown) => void | Promise<void>>;
}
```

All callbacks are optional. A handler that only implements `onMessage` (treating every frame as opaque) is valid; so is a handler that only implements `actions`. Any callback may be `async`; the middleware awaits returned promises and logs rejections through `ctx.log.error` without closing the connection.

### `WebSocketContext`

Every callback receives a `WebSocketContext` (defined in [`src/types.ts`](src/types.ts)):

| Field       | Type                       | Description                                                                                                                            |
| ----------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `ws`        | `WebSocket`                | Raw `ws` instance. Escape hatch for behavior the helper methods do not cover.                                                          |
| `req`       | `http.IncomingMessage`     | The HTTP upgrade request. Useful for `url`, `headers`, `socket.remoteAddress`.                                                         |
| `mode`      | `"pcp" \| "plain"`         | Negotiated at the handshake. Handlers rarely need to branch on this; `ctx.send` is mode-agnostic.                                      |
| `log`       | `WebSocketLog`             | Scoped logger prefixed with `[ws-mock:<mountPath>]`. Methods: `info`, `warn`, `error`, `debug`.                                        |
| `send`      | `(frame) => void`          | Send a frame using the action-routing convention. See the shape below. Errors are logged and swallowed; callers never observe a throw. |
| `close`     | `(code?, reason?) => void` | Close the connection with optional code (default 1000) and reason.                                                                     |
| `terminate` | `() => void`               | Hard-kill the socket without a close handshake. The client observes code 1006.                                                         |

If the underlying logger does not implement `debug` (older `@ui5/logger` versions), debug calls land at `info` level. Consumers can filter by the `[ws-mock:<mountPath>]` prefix or by log message content.

### `ctx.send(frame)`

```typescript
ctx.send({ action: "FOO_REPLY", data: { t: 42 } });
```

`ctx.send` is the action-routing convention's outbound counterpart. The payload is wrapped in the mode-appropriate wire format:

- **PCP mode.** A PCP frame with `pcp-action:MESSAGE`, the application-level `action:<name>` custom header field, and the JSON-serialized `data` as the body. The body carries the payload; the routing metadata lives in header fields, per the PCP v1.0 spec. Byte-compatible with `SapPcpWebSocket`.
- **Plain mode.** The JSON envelope `{ "action": "FOO_REPLY", "data": { "t": 42 } }`. Plain `WebSocket` has no header channel, so the routing key is folded into the body.

The same handler code works in both modes. Frames that do not fit the action-routing shape can be sent through the raw escape hatch `ctx.ws.send(...)` directly.

### Inbound frame decoding

`WebSocketInboundFrame` (passed to `onMessage`):

| Field    | Type                  | Description                                                                                                                                     |
| -------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `action` | `string \| undefined` | Decoded action name when the frame carries one under the convention; otherwise `undefined`.                                                     |
| `data`   | `unknown`             | Decoded payload. `undefined` when the frame has no body. Best-effort `JSON.parse` of the body, falling back to the raw string on parse failure. |
| `raw`    | `string`              | Raw frame body as it arrived on the wire.                                                                                                       |

Per-mode contract:

- **PCP mode.** The decoder reads `action` from the PCP custom header field named `action`. The body is exposed as `data` after a best-effort `JSON.parse`: empty body becomes `undefined`; otherwise the body is JSON-parsed and a parse failure yields the raw string. Structured objects and JSON scalars (`null`, numbers, booleans, strings) decode symmetrically with the plain-mode parser; opaque text or base64 blobs pass through unchanged.
- **Plain mode.** The decoder parses the body as JSON and expects the envelope `{ action, data }`. `action` must be a string; missing or non-string `action` leaves the frame without a routing key (the handler's `onMessage` continues to receive it via the `raw` field). Missing `data` remains `undefined`.

## Writing handlers for custom scenarios

The handler API is intentionally minimal. Custom logic lives entirely inside the callbacks the handler provides. Common patterns:

### Stateful per-connection handlers

Per-connection state belongs in a `WeakMap` keyed by `ctx`; the entry is collected automatically when the connection ends.

```typescript
const state = new WeakMap<WebSocketContext, { count: number }>();

const handler: WebSocketHandler = {
	onConnect: (ctx) => {
		state.set(ctx, { count: 0 });
		ctx.send({ action: "HELLO", data: {} });
	},
	actions: {
		FOO_BUMP: (ctx, data) => {
			const s = state.get(ctx);
			if (!s) return;
			s.count += 1;
			ctx.send({
				action: "FOO_BUMPED",
				data: { ...(data as object), n: s.count },
			});
		},
	},
};
```

### Shared state across connections

```typescript
const subscribers = new Set<WebSocketContext>();

const handler: WebSocketHandler = {
	onConnect: (ctx) => {
		subscribers.add(ctx);
	},
	onClose: (ctx) => {
		subscribers.delete(ctx);
	},
	actions: {
		FOO_BROADCAST: (_ctx, data) => {
			for (const sub of subscribers) sub.send({ action: "FOO_EVENT", data });
		},
	},
};
```

### Periodic push

```typescript
const handler: WebSocketHandler = {
	onConnect: (ctx) => {
		const timer = setInterval(() => {
			ctx.send({ action: "FOO_TICK", data: { at: Date.now() } });
		}, 1000);
		ctx.ws.on("close", () => clearInterval(timer));
	},
};
```

### Simulating backend latency

```typescript
// inside `actions`
FOO_SLOW: async (ctx, data) => {
	await new Promise((r) => setTimeout(r, 500));
	ctx.send({ action: "FOO_SLOW_ACK", data });
},
```

### Forcing disconnects for retry-strategy testing

```typescript
// inside `actions`
FOO_DISCONNECT: (ctx) => ctx.close(1001, "requested"), // clean close, client sees 1001
FOO_TERMINATE: (ctx) => ctx.terminate(),               // abrupt, client sees 1006
```

### Catch-all logging alongside `actions`

`actions` handles known message names; `onMessage` runs for anything that does not match a key in `actions` (per the dispatch precedence above). Combining the two is useful while a contract is still in flux: known traffic is served, unknown traffic is logged instead of silently dropped.

```typescript
const handler: WebSocketHandler = {
	actions: {
		FOO: (ctx, data) => ctx.send({ action: "FOO_ACK", data }),
	},
	onMessage: (ctx, frame) => {
		ctx.log.warn(`unhandled action=${frame.action ?? "(none)"} raw=${frame.raw}`);
	},
};
```

### Opting out of action routing

```typescript
const handler: WebSocketHandler = {
	onMessage: (ctx, frame) => {
		ctx.log.debug(`raw frame: ${frame.raw}`);
		ctx.ws.send(`echo:${frame.raw}`);
	},
};
```

## PCP negotiation

Negotiation runs once per connection at the handshake. The middleware constructs its `WebSocketServer` with:

```typescript
handleProtocols: (protocols) => (protocols.has("v10.pcp.sap.com") ? "v10.pcp.sap.com" : false);
```

Clients that offer `v10.pcp.sap.com` receive it back, pinning the connection into PCP mode; encoding and decoding then go through the codec in [`src/pcp.ts`](src/pcp.ts). Clients that offer no subprotocol (plain `WebSocket`) receive no subprotocol back. Clients that offer something else fail their own handshake per RFC 6455 §4.2.2, because no echo is returned for unrecognized subprotocols.

After the handshake, `ws.protocol` is either `"v10.pcp.sap.com"` or `""`, and the middleware snapshots that value into `ctx.mode`. The mode is fixed for the lifetime of the connection. Per-frame branching is not required in handler code.

## Error handling

Every failure site is caught and logged through the route-scoped logger (`[ws-mock:<mountPath>]`). The connection stays open unless the handler explicitly closes it.

| Site                                         | Policy                                                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `JSON.stringify(data)` in `ctx.send`         | try/catch; log at `error`; drop the frame.                                                           |
| `pcp.encode(...)` in `ctx.send`              | same try/catch (encoder throws on empty field names per spec).                                       |
| `ws.send` on a non-open socket               | pre-check `ws.readyState === OPEN`; skip with a `warn` when not.                                     |
| `ws.send` throws synchronously               | caught around the call; log at `error`; connection is left to close via `ws`'s own error handling.   |
| Malformed inbound JSON (plain mode)          | synthesize `{ action: undefined, data: undefined, raw }`; `onMessage` receives it.                   |
| Malformed inbound PCP frame                  | decoder returns partial data; handlers see best-effort `action` / `data`.                            |
| Handler sync throw                           | caught; log at `error`; connection stays open.                                                       |
| Handler async rejection                      | `.catch(err => ctx.log.error(...))`; connection stays open.                                          |
| Dynamic `import(handler)` failure at startup | logged at `error`; the route accepts the upgrade then closes with code 1011 (Internal Server Error). |

> [!NOTE]
> **Restart the server before debugging.** Handler modules are imported once at startup and cached for the process lifetime; symptoms such as an action that never fires, a route that 404s after a `ui5.yaml` edit, or a handler change that does not appear to take effect are typically resolved by stopping `ui5 serve` and starting it again.

## How it works under the hood

UI5 tooling's custom-middleware API does not expose the underlying HTTP server, which is required to hook the `upgrade` event. The middleware works around that using the [`ui5-utils-express/lib/hook`](https://github.com/ui5-community/ui5-ecosystem-showcase/blob/main/packages/ui5-utils-express/lib/hook.js) helper from the UI5 ecosystem showcase.

### The three phases of startup

`ui5 serve` walks a distinct sequence traceable in the `@ui5/server` source.

**Phase 1: factory invocation (at startup).**

1. `@ui5/server` reads `ui5.yaml`, finds the `customMiddleware` entry and the matching `kind: extension, type: server-middleware` declaration.
2. It performs `await import(pathToFileURL(middleware.path))` and resolves the `default` export, which is the `wsMock` factory (an async function).
3. It calls `await factory({ log, options, middlewareUtil, resources })`. The factory reads `options.configuration.routes`, loads each handler module via dynamic `import()`, and returns the result of `hook(...)`.

**Phase 2: mount (before the server listens).**

4. `@ui5/server` registers the returned function in the Express app via `app.use(mountPath, fn)`.
5. Express sees that `fn` exposes `handle`, `set`, and `emit` methods and treats it as a sub-app. It fires `fn.emit("mount", app)` to notify the sub-app of its parent.
6. The `emit` implementation inside the `hook` helper captures the parent `app`, records the current `app._router.stack.length` (middleware position), and monkey-patches `app.listen`.

**Phase 3: listen (server start).**

7. `@ui5/server` calls `app.listen(port, host, cb)`.
8. The patched `listen` runs the original (which creates and starts the HTTP server), captures the returned `server`, then invokes the registered callback with `{ app, server, on, use, options }`.
9. Inside the callback the middleware constructs its `WebSocketServer` with `{ noServer: true, handleProtocols: ... }` and registers `server.on("upgrade", ...)`.

From that point on, every incoming upgrade request flows through the middleware's listener; matching pathnames are dispatched via `wss.handleUpgrade(req, socket, head, cb)`, and non-matching requests return silently so other upgrade listeners (for example `ui5-middleware-livereload`'s WS channel) see the event next.

### Why the workaround is necessary

`@ui5/server`'s `MiddlewareUtil` exposes `getPathname`, `getMimeInfo`, `getProject`, `getDependencies`, and `resourceFactory`. There is no `getServer()` or `getApp()`. The only path to the underlying HTTP server from inside a custom middleware is to observe Express's startup events directly.

### Coexistence safety

Two independent concerns:

**HTTP middleware chain order.** Determined by `afterMiddleware:` / `beforeMiddleware:` declarations. The `hook` helper respects this: it captures the middleware position at mount time and re-slots any middleware the consumer adds via its `use` callback. The middleware itself does not contribute HTTP-level middleware; the inner function is a pass-through (`next()`), so the HTTP request chain is untouched.

**Upgrade event coexistence.** Node's `http.Server` is an `EventEmitter`; multiple listeners attach to `"upgrade"` and each one decides whether the request belongs to it. The safe pattern is:

1. Inspect `req.url` to determine whether the request matches a configured route.
2. If yes, call `wss.handleUpgrade(req, socket, head, cb)`.
3. If no, **return without performing any side effect**. Do not log, destroy the socket, or write a response. Other upgrade listeners run next.

The middleware follows this pattern. Other libraries that hook `"upgrade"` on the same server coexist without interference.

### The tricks, named

- **Mount event capture.** Express's public API fires `"mount"` on a sub-app as part of `app.use(subApp)`. Any object with `handle`, `set`, and `emit` methods is accepted as a sub-app. The hook returns exactly that shape and receives the parent `app` reference for free.
- **`app.listen` monkey-patching.** The hook replaces `app.listen` with a wrapper that calls the original, captures the returned server, and fires a callback. Necessary because no event for "server is about to listen" reaches a sub-app.
- **`WebSocketServer({ noServer: true })`.** Tells `ws` not to attach itself to any HTTP server; handshakes are fed in manually via `handleUpgrade`. Multiple `WebSocketServer` instances on the same HTTP server can coexist this way.

### Tradeoff vs. a standalone Node WebSocket server

An alternative architecture is a standalone Node process listening on a separate port, with the UI served over the regular `ui5 serve`. The integrated approach trades:

- **Same-origin.** The WebSocket endpoint is served from the same host and port as the UI. No CORS issues, no cross-origin cookies, no second process to manage.
- **Shared lifecycle.** `npm start` boots everything; Ctrl-C stops everything. A standalone server requires separate orchestration.
- **Proxy-friendliness.** Anything that proxies to `ui5 serve` (BTP destinations, reverse proxies, Fiori Tools Preview) automatically covers the WS endpoint.

The cost is the coupling to the hook trick. A future UI5 tooling major bump that breaks the hook breaks this middleware with it; a standalone-server alternative would not be affected. For local development mocks, that is an acceptable tradeoff.

## Limitations

- **Handler modules are imported once at server start.** Each route's handler is loaded via dynamic `import()` during `ui5 serve` startup; the module is then cached in Node's ESM loader for the process lifetime. Picking up handler edits requires a `ui5 serve` restart. A process supervisor such as `tsx watch` or `nodemon --watch <handlers-dir>` automates this. Adding the handler directory to `ui5-middleware-livereload`'s `watchPath` reloads the browser when files change but does not restart the server.
- **One handler module per route.** No chaining or composition is performed by the middleware. Layered behavior should be composed inside the handler module.
- **No dynamic / parametrized mount paths.** `mountPath` is matched literally against the incoming request pathname. UI5-style route patterns with optional or mandatory parameters are not supported. Per-resource routing should be derived from `req.url` (query string or path segments) inside the handler.
- **`ts-node` interference.** `sap-fe-mockserver` registers a global `ts-node` hook that hijacks `require()` for `.ts` files. Handler modules are loaded via dynamic `import()` to sidestep the hook.
- **Requires specVersion 3.0+** on the middleware extension to use `middlewareUtil.getProject().getRootPath()` for resolving handler paths. This middleware declares `specVersion: "4.0"`.

## Related

- [Specification of the Push Channel Protocol (PCP)](https://community.sap.com/t5/application-development-and-automation-blog-posts/specification-of-the-push-channel-protocol-pcp/ba-p/13137541): SAP's PCP v1.0 wire-format spec that [`src/pcp.ts`](src/pcp.ts) implements.
- [`ui5-utils-express/lib/hook.js`](https://github.com/ui5-community/ui5-ecosystem-showcase/blob/main/packages/ui5-utils-express/lib/hook.js): the helper used to obtain the underlying HTTP server.
- [`ui5-lib-misc-util` § websocket](https://github.com/wridgeu/ui5-lib-misc-util/blob/main/packages/lib/README.md#websocket): an example UI5 client that talks to this middleware. The middleware is transport-agnostic and works with any WebSocket client; this is one such client.

## Contributing

Issues and pull requests are welcome. Anything goes: bug reports, feature ideas, questions about the design, or notes from using the middleware in a real project. For larger changes, a quick issue first to sketch the approach avoids wasted work.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (enforced via `commitlint`). Before submitting a PR, run `npm run check` to cover formatting, linting, and type-checks, and `npm test` for the vitest suite.

## Credits

> [!NOTE]
> The pattern of hosting a WebSocket endpoint alongside `ui5 serve`, and the technique used to obtain the underlying HTTP server from inside the UI5 tooling lifecycle, originate from prior work by Peter Muessig in the UI5 community ecosystem. This package adds a per-route mock dispatch model with PCP negotiation on top of that foundation.

- [`ui5-middleware-websocket`](https://github.com/ui5-community/ui5-ecosystem-showcase/tree/main/packages/ui5-middleware-websocket) by Peter Muessig: generic WebSocket transport for `ui5 serve`. Different scope from this package (no per-route handler dispatch, no PCP framing); the original demonstration that hosting a WebSocket endpoint inside `ui5 serve` is feasible.
- [`ui5-utils-express`](https://github.com/ui5-community/ui5-ecosystem-showcase/tree/main/packages/ui5-utils-express) by Peter Muessig: the `lib/hook` helper this middleware depends on to obtain the underlying HTTP server from inside a UI5 custom middleware factory.
