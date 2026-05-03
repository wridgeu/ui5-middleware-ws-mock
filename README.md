<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License"></a>
  <a href="https://www.npmjs.com/package/ui5-middleware-ws-mock"><img src="https://img.shields.io/npm/v/ui5-middleware-ws-mock.svg" alt="npm"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node-%E2%89%A522-green.svg" alt="Node"></a>
</p>

<h1 align="center">ui5-middleware-ws-mock</h1>

A UI5 custom server middleware that mocks WebSocket endpoints alongside the rest of the `ui5 serve` stack. Registers under `customMiddleware` in `ui5.yaml`, hooks the underlying HTTP server's `upgrade` event, negotiates the SAP Push Channel Protocol (PCP) `v10.pcp.sap.com` subprotocol transparently, and routes each WebSocket connection to a per-route handler module that consumers ship in their own app.

Companion client-side library: [`ui5-lib-misc-util` § websocket](https://github.com/wridgeu/ui5-lib-misc-util/blob/main/packages/lib/README.md#websocket). The middleware is transport-agnostic. It works with any WebSocket client; the `WebSocketService` is one such client.

## What it does

- Listens for HTTP upgrade requests on paths declared in `ui5.yaml`.
- Negotiates the PCP v1.0 subprotocol when the client offers it; otherwise
  runs in plain WebSocket mode. Handlers see `ctx.mode` but write
  mode-agnostic code.
- Loads handler modules (TypeScript or JavaScript) per route at startup and
  dispatches inbound frames to them via an `actions[name]` map plus a
  catch-all `onMessage`.
- Encodes outbound frames in PCP or plain JSON envelope per connection,
  byte-compatible with `sap.ui.core.ws.SapPcpWebSocket`.
- Logs handler failures, malformed frames, and non-open-socket sends
  without crashing `ui5 serve` or the connection.

## What it does not do

- It does not expose an arbitrary Express middleware. If you need
  HTTP-level middleware, register a separate `customMiddleware` entry.
- It does not persist state across server restarts. `ui5 serve` reload
  covers `webapp/` only; changes to handler modules require a manual restart.
- It does not mock any specific business protocol. The action dispatch
  table and envelope format are the contract; what a handler does with the
  payload is entirely consumer-defined.
- It does not proxy to a real backend. For proxying, use
  [`ui5-middleware-simpleproxy`](https://www.npmjs.com/package/ui5-middleware-simpleproxy)
  or `fiori-tools-proxy`.

## Quick start

1. Install:

    ```bash
    npm install --save-dev ui5-middleware-ws-mock
    ```

2. Register under `server.customMiddleware` in your `ui5.yaml`:

    ```yaml
    server:
        customMiddleware:
            - name: ui5-middleware-ws-mock
              afterMiddleware: compression
              configuration:
                  routes:
                      - mountPath: /ws/notifications
                        handler: ./wsmock/wsdata/notifications.ts
    ```

    The middleware's `kind: extension` declaration ships in the package and is auto-discovered by `@ui5/server`; no separate extension file is needed in your app.

3. Write a handler module. `default`-export a `WebSocketHandler`:

    ```typescript
    // wsmock/wsdata/notifications.ts
    import type { WebSocketHandler } from "ui5-middleware-ws-mock";

    const handler: WebSocketHandler = {
    	onConnect: (ctx) => ctx.send({ action: "HELLO", data: {} }),
    	actions: {
    		PING: (ctx, data) => ctx.send({ action: "PONG", data }),
    	},
    	onClose: (ctx, code) => ctx.log.info(`close ${code}`),
    };

    export default handler;
    ```

    > TypeScript handler modules use Node's native type stripping; this requires Node >= 22.18. See Limitations for the full caveat list.

4. Run `npm start`. The server log prints
   `[ws-mock:/ws/notifications] handler loaded from ./wsmock/wsdata/notifications.ts`
   followed by `[ws-mock] listening for upgrades on: /ws/notifications`.

## Configuration

The `configuration` block under the `customMiddleware` entry accepts:

| Key                  | Type               | Required | Description                                                                                            |
| -------------------- | ------------------ | -------- | ------------------------------------------------------------------------------------------------------ |
| `routes`             | `WebSocketRoute[]` | yes      | One entry per mount path. Each entry declares a path and the file that provides the handler module.    |
| `routes[].mountPath` | `string`           | yes      | Express-style path such as `/ws/notifications`. Clients connect to `ws://localhost:<port><mountPath>`. |
| `routes[].handler`   | `string`           | yes      | Path to the handler module, resolved relative to the directory containing your `ui5.yaml`.             |

A minimal single-route configuration:

```yaml
configuration:
    routes:
        - mountPath: /ws/notifications
          handler: ./wsmock/wsdata/notifications.ts
```

Multiple routes in the same middleware entry are supported:

```yaml
configuration:
    routes:
        - mountPath: /ws/notifications
          handler: ./wsmock/wsdata/notifications.ts
        - mountPath: /ws/events
          handler: ./wsmock/wsdata/events.ts
```

## Handler API

A handler module default-exports an object implementing `WebSocketHandler`
(defined in [`src/types.ts`](src/types.ts)):

```typescript
export interface WebSocketHandler {
	onConnect?: (ctx: WebSocketContext) => void | Promise<void>;
	onMessage?: (ctx: WebSocketContext, frame: WebSocketInboundFrame) => void | Promise<void>;
	onClose?: (ctx: WebSocketContext, code: number, reason: string) => void | Promise<void>;
	actions?: Record<string, (ctx: WebSocketContext, data: unknown) => void | Promise<void>>;
}
```

All callbacks are optional. A handler that only implements `actions` still
works. Any callback may be `async`; the middleware awaits returned
promises and logs rejections through `ctx.log.error` without closing the
connection.

### Dispatch precedence for inbound frames

1. The middleware decodes the frame per the negotiated `ctx.mode` (PCP or
   plain).
2. If the decoded `action` matches a key in `actions`, that callback runs
   and only that callback. `data` is passed as the second argument.
3. Otherwise, if `onMessage` is defined, it runs with the full decoded
   frame (`action`, `data`, `raw`). Useful for catch-all logging or
   custom framing the default decoder does not understand.
4. Otherwise the frame is dropped with a debug log.

### `WebSocketContext`

Every callback receives a `WebSocketContext` (defined in [`src/types.ts`](src/types.ts)):

| Field       | Type                       | Description                                                                                            |
| ----------- | -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ws`        | `WebSocket`                | Raw `ws` instance. Escape hatch for behavior the helper methods do not cover.                          |
| `req`       | `http.IncomingMessage`     | The HTTP upgrade request. Useful for `url`, `headers`, `socket.remoteAddress`.                         |
| `mode`      | `"pcp" \| "plain"`         | Negotiated at the handshake. Handlers rarely need to branch on this; `ctx.send` is mode-agnostic.      |
| `log`       | `WebSocketLog`             | Scoped logger prefixed with `[ws-mock:<mountPath>]`. Methods: `info`, `warn`, `error`, `debug`.        |
| `send`      | `(frame) => void`          | Send an action frame. See the shape below. Errors are logged and swallowed; callers never see a throw. |
| `close`     | `(code?, reason?) => void` | Close the connection with optional code (default 1000) and reason.                                     |
| `terminate` | `() => void`               | Hard-kill the socket without a close handshake. The client observes code 1006.                         |

If the underlying logger does not implement `debug` (older `@ui5/logger` versions), debug calls land at `info` level. Consumers can filter by the `[ws-mock:<mountPath>]` prefix or by log message content.

### `ctx.send(frame)`

```typescript
ctx.send({ action: "PONG", data: { t: 42 } });
```

The payload is wrapped in the mode-appropriate wire format:

- **PCP mode:** a PCP frame with `pcp-action:MESSAGE`, the
  application-level `action:<name>` custom header field, and the
  JSON-serialized `data` as the body. Spec-aligned per the PCP v1.0 wire
  format: routing metadata lives in header fields, the body holds the
  payload. Byte-compatible with `SapPcpWebSocket`.
- **Plain mode:** the JSON envelope `{ "action": "PONG", "data": { "t": 42 } }`.
  Plain `WebSocket` has no header channel, so the library serializes the
  envelope into the body; the client's default `WebSocketService` parser
  reads the same shape.

Same handler code works in both modes.

### Inbound frame decoding

`WebSocketInboundFrame` (passed to `onMessage`):

| Field    | Type                  | Description                                                                                                               |
| -------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `action` | `string \| undefined` | Decoded action name if the frame carries one; otherwise `undefined`.                                                      |
| `data`   | `unknown`             | Decoded payload. `undefined` when the frame has no body. JSON-parsed when the body looks like JSON, raw string otherwise. |
| `raw`    | `string`              | Raw frame body as it arrived on the wire.                                                                                 |

Per-mode contract:

- **PCP mode:** the decoder reads `action` from the PCP custom header
  field `action` (what `SapPcpWebSocket.send(body, { action })` and
  `WebSocketActionRouter.sendAction` both emit). The body is exposed as
  `data` after a best-effort `JSON.parse`: empty body becomes
  `undefined`; otherwise the body is JSON-parsed and a parse failure
  yields the raw string. This lets PCP payloads carry structured objects
  as well as JSON scalars (`null`, numbers, booleans, strings)
  symmetrically with the plain-mode `{ action, data }` parser, and
  passes opaque text or Base64 blobs through unchanged.
- **Plain mode:** the decoder parses the body as JSON and expects the
  envelope `{ action, data }`. `action` must be a string; missing or
  non-string `action` leaves the frame without a routing key (handler's
  `onMessage` still sees it via the `raw` field). Missing `data` stays
  `undefined`.

## Writing handlers for custom scenarios

The shape of the API is deliberately narrow. Custom logic lives entirely
inside the callbacks the handler provides. A few common patterns:

### Stateful per-connection handlers

Per-connection state belongs in a `WeakMap` keyed by `ctx`; the entry is
collected automatically when the connection ends.

```typescript
const state = new WeakMap<WebSocketContext, { pings: number }>();

const handler: WebSocketHandler = {
	onConnect: (ctx) => {
		state.set(ctx, { pings: 0 });
		ctx.send({ action: "HELLO", data: {} });
	},
	actions: {
		PING: (ctx, data) => {
			const s = state.get(ctx);
			if (!s) return;
			s.pings += 1;
			ctx.send({ action: "PONG", data: { ...(data as object), n: s.pings } });
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
		BROADCAST: (_ctx, data) => {
			for (const sub of subscribers) sub.send({ action: "EVENT", data });
		},
	},
};
```

### Periodic push

```typescript
const handler: WebSocketHandler = {
	onConnect: (ctx) => {
		const timer = setInterval(() => {
			ctx.send({ action: "TICK", data: { at: Date.now() } });
		}, 1000);
		ctx.ws.on("close", () => clearInterval(timer));
	},
};
```

### Simulating backend latency

```typescript
actions: {
    SLOW_READ: async (ctx, data) => {
        await new Promise((r) => setTimeout(r, 500));
        ctx.send({ action: "SLOW_READ_ACK", data });
    },
},
```

### Forcing disconnects for retry-strategy testing

```typescript
actions: {
    DISCONNECT: (ctx) => ctx.close(1001, "requested"),  // clean close, client sees 1001
    TERMINATE:  (ctx) => ctx.terminate(),               // abrupt, client sees 1006
},
```

### Falling back to raw frames

```typescript
onMessage: (ctx, frame) => {
    if (frame.action) return; // already dispatched elsewhere
    ctx.log.debug(`custom frame: ${frame.raw}`);
    ctx.send({ action: "ECHO_RAW", data: frame.raw });
},
```

## PCP negotiation

Handled once per connection, at the handshake. The middleware constructs
its `WebSocketServer` with:

```typescript
handleProtocols: (protocols) => (protocols.has("v10.pcp.sap.com") ? "v10.pcp.sap.com" : false);
```

Clients that offer `v10.pcp.sap.com` get it echoed, pinning the
connection into PCP mode; the middleware then drives encoding and
decoding through its own [`src/pcp.ts`](src/pcp.ts) codec (the `ws` npm package
itself has no PCP awareness). Clients that offer no subprotocol (plain
`WebSocket`) get no subprotocol back. Clients that offer something else
fail their own handshake per RFC 6455 §4.2.2, because we do not echo
anything we do not understand.

After the handshake, `ws.protocol` is either `"v10.pcp.sap.com"` or `""`,
and the middleware snapshots that into `ctx.mode`. The mode is fixed for
the lifetime of the connection. No per-frame branching is needed in
handler code.

## Error handling

Every failure site is caught and logged through the route-scoped logger
(`[ws-mock:<mountPath>]`). The connection stays open unless the handler
explicitly closes it.

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

## How it works under the hood

This is the interesting part. UI5 tooling's custom-middleware API does not
give you access to the HTTP server, which is what you need to hook
`upgrade`. The middleware works around that using the
[`ui5-utils-express/lib/hook`](https://github.com/ui5-community/ui5-ecosystem-showcase/blob/main/packages/ui5-utils-express/lib/hook.js)
helper from the UI5 ecosystem showcase. The banner at the top of that
file literally says "BLACK MAGIC" with "NO WARRANTY"; the rest of this
section explains why.

### The three phases of startup

`ui5 serve` walks a distinct sequence that you can trace in the
`@ui5/server` source.

**Phase 1: factory invocation (at startup).**

1. `@ui5/server` reads `ui5.yaml`, finds the `customMiddleware` entry and
   the matching `kind: extension, type: server-middleware` declaration.
2. It does `await import(pathToFileURL(middleware.path))` and pulls the
   `default` export. This is our `wsmock` factory (an async function).
3. It calls `await factory({ log, options, middlewareUtil, resources })`.
   Our factory reads `options.configuration.routes`, loads each handler
   module via dynamic `import()`, and returns the result of `hook(...)`.

**Phase 2: mount (before the server listens).**

4. `@ui5/server` registers the returned function in the Express app via
   `app.use(mountPath, ourFn)`.
5. Express sees that `ourFn` has `handle`, `set`, `emit` methods and
   treats it as a sub-app. It fires `ourFn.emit("mount", app)` to tell
   the sub-app about its parent.
6. Our `emit` implementation, inside the `hook` helper, captures the
   parent `app`, remembers the current `app._router.stack.length`
   (middleware position), and monkey-patches `app.listen`.

**Phase 3: listen (server start).**

7. `@ui5/server` eventually calls `app.listen(port, host, cb)`.
8. Our patched `listen` runs the original (which creates and starts the
   HTTP server), captures the returned `server`, then invokes our
   callback with `{ app, server, on, use, options }`.
9. Inside the callback the middleware creates its `WebSocketServer` with
   `{ noServer: true, handleProtocols: … }` and registers
   `server.on("upgrade", …)`.

From this point on, every incoming upgrade request passes through our
handler; if the pathname matches one of our mounted routes we call
`wss.handleUpgrade(req, socket, head, cb)`, otherwise we return silently
so other upgrade listeners (for example `ui5-middleware-livereload`'s WS
channel) see the event next.

### Why the workaround is necessary

`@ui5/server`'s `MiddlewareUtil` exposes `getPathname`, `getMimeInfo`,
`getProject`, `getDependencies`, and `resourceFactory`. There is no
`getServer()` or `getApp()`. The only way to obtain the server from
inside a custom middleware today is to observe Express's startup events
yourself.

### Why it is safe for coexistence

Two independent concerns, handled differently:

**HTTP middleware chain order.** Set by your `afterMiddleware:` /
`beforeMiddleware:` declarations. The `hook` helper respects this: it
captures the middleware position at mount time and re-slots any
middleware the consumer adds via its `use` callback. Our factory does
not add HTTP-level middleware at all; the inner function is a
pass-through (`next()`), so the HTTP request chain is completely
untouched by this middleware.

**Upgrade event coexistence.** Node's `http.Server` is an
`EventEmitter`; multiple listeners attach to `"upgrade"` and each one
decides whether the request is theirs. The safe pattern is:

1. Inspect `req.url` to determine if the request is for one of your
   routes.
2. If yes, call `wss.handleUpgrade(req, socket, head, cb)`.
3. If no, **return without doing anything**. Do not log, do not destroy
   the socket, do not write any response. Other upgrade listeners will
   run next.

The middleware does exactly this. Other libraries that also hook
`"upgrade"` on the same server coexist without interference.

### The tricks, named

- **Mount event capture.** Express's public API fires `"mount"` on a
  sub-app as part of `app.use(subApp)`. Any object with `handle`, `set`,
  and `emit` methods is accepted as a sub-app. The hook returns exactly
  that shape so it can receive the parent `app` reference for free.
- **`app.listen` monkey-patching.** The hook replaces `app.listen` with
  a wrapper that calls the original, grabs the returned server, and
  fires a callback. This is necessary because there is no event for
  "server is about to listen" that a sub-app receives.
- **`WebSocketServer({ noServer: true })`.** Tells `ws` not to attach
  itself to any HTTP server, so we feed it handshakes manually via
  `handleUpgrade`. Multiple `WebSocketServer` instances on the same
  HTTP server can coexist this way.

### Why you might still prefer this over a standalone Node WS server

Alternatives exist, most obviously: run a standalone Node process that
listens on a separate port and serve the UI over the regular ui5 serve.
Tradeoffs:

- **Same-origin.** The middleware serves the WS endpoint on the same
  host and port as the UI. No CORS issues, no cross-origin cookies, no
  second process to manage.
- **Shared lifecycle.** `npm start` boots everything; Ctrl-C stops
  everything. A standalone server would need orchestration.
- **Proxy-friendly.** Anything that proxies to `ui5 serve` (BTP
  destinations, reverse proxies, Fiori Tools Preview) automatically
  covers the WS endpoint.

The cost is the coupling to the hook trick. If the trick breaks on a
future UI5 tooling major bump, this middleware breaks with it; the
standalone-server alternative would not. For a local dev mock that is an
acceptable risk.

## Limitations

- **Handler modules are imported once at server start.** The middleware loads each route's handler via dynamic `import()` during `ui5 serve` startup; the module is then cached in Node's ESM loader for the process lifetime. To pick up handler edits without a manual server restart, run `ui5 serve` under a process supervisor (`tsx watch`, `nodemon --watch <handlers-dir>`). Adding the handler directory to `ui5-middleware-livereload`'s `watchPath` reloads the browser when files change but does not restart the server, so the new handler code is not picked up until you do.
- **TypeScript handler modules rely on Node's native type stripping.**
  Works on Node 22.18+ with no flags; older Node would need a `tsx` /
  `ts-node` wrapper. The repo already requires Node >= 22.
- **`ts-node` interference** (registered globally by `sap-fe-mockserver`)
  hijacks `require()` for `.ts` files. Handler modules are loaded via
  dynamic `import()` to sidestep that hook.
- **Requires specVersion 3.0+** on the middleware extension to use
  `middlewareUtil.getProject().getRootPath()` for resolving handler
  paths. This middleware declares `specVersion: "4.0"`.

## Related

- [`ui5-lib-misc-util` § websocket](https://github.com/wridgeu/ui5-lib-misc-util/blob/main/packages/lib/README.md#websocket): library API reference for `WebSocketService`, the companion client-side WebSocket service that pairs naturally with this middleware.
- [`ui5-utils-express/lib/hook.js`](https://github.com/ui5-community/ui5-ecosystem-showcase/blob/main/packages/ui5-utils-express/lib/hook.js):
  the "black magic" helper we depend on.
- [Specification of the Push Channel Protocol (PCP)](https://community.sap.com/t5/application-development-and-automation-blog-posts/specification-of-the-push-channel-protocol-pcp/ba-p/13137541):
  SAP's PCP v1.0 wire-format spec that [`src/pcp.ts`](src/pcp.ts) implements.

## Credits

- [`ui5-middleware-websocket`](https://github.com/ui5-community/ui5-ecosystem-showcase/tree/main/packages/ui5-middleware-websocket) by Peter Muessig: an established precedent in the UI5 ecosystem for serving WebSockets alongside `ui5 serve`. Different scope (generic WebSocket transport for Express integration; this middleware is a per-route mock with PCP negotiation and a handler-dispatch model), but the original demonstration that the pattern is feasible at all.
- [`ui5-utils-express`](https://github.com/ui5-community/ui5-ecosystem-showcase/tree/main/packages/ui5-utils-express) by Peter Muessig: the `lib/hook` helper this middleware depends on to capture the underlying HTTP server from inside the UI5 tooling lifecycle. The "BLACK MAGIC NO WARRANTY" banner at the top of that file is honest, and we get to stand on its shoulders.
