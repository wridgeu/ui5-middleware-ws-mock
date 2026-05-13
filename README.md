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

The transport is plain WebSocket. When the client offers it, the middleware also speaks WebSocket framed under SAP's PCP v1.0 subprotocol. The middleware is transport-only beyond that wire layer: plain frames pass through as raw bytes, PCP frames are decoded into header fields and a body, and any payload semantics (JSON, base64, line-delimited records, opaque text) are entirely the handler's choice.

> [!NOTE]
> Much of this repository was authored hands-off, through speech-to-text dictation paired with AI coding assistance, during post-surgery recovery with only one hand. That said, the majority of the implementation is grounded in pre-existing patterns from the UI5 ecosystem (notably Peter Muessig's work credited below) and conventional Node / WebSocket / PCP techniques that were ported, refactored, and hardened. It was partially "vibe-coded". There can be hallucinations missed during review or simple consumption-side bugs; no software is perfect. Feel free to open an issue or a PR and fix them directly.

## What it does

- Listens for HTTP upgrade requests on the paths declared in `ui5.yaml`.
- Negotiates the PCP v1.0 subprotocol when the client offers it; otherwise runs in plain WebSocket mode. Handlers see `ctx.mode` and branch on it where needed.
- Loads one handler module per route at startup (TypeScript or JavaScript).
- Forwards every inbound frame to the handler's `onMessage`. In plain mode the handler receives the raw frame string; in PCP mode it receives a decoded `{ fields, body }` object with the wire bytes preserved verbatim.
- Provides `ctx.send(message)` for outbound writes. Plain mode writes the string verbatim. PCP mode accepts either a string (wrapped in a default `pcp-action:MESSAGE` / `pcp-body-type:text` frame) or an `EncodeOptions` object (the middleware calls `encode()` internally). The TypeScript surface narrows on `ctx.mode` so the `EncodeOptions` overload is only offered to PCP-mode call sites. For framings the public encoder does not cover, fall back to `ctx.ws.send` with a pre-built wire string.
- Logs handler failures, malformed frames, and non-open-socket sends without crashing `ui5 serve` or the connection.

## What it does not do

- Does not expose an arbitrary Express middleware. HTTP-level middleware should be registered as a separate `customMiddleware` entry.
- Does not support multiple handler modules per route. Each route resolves to exactly one handler file. Composition belongs inside the handler module.
- Does not support dynamic or parametrized mount paths. `mountPath` is matched against the request pathname literally. UI5-style route patterns with optional or mandatory parameters (`{param}`, `:optional?`, etc.) are not supported. Per-resource routing should be derived from `req.url` inside the handler.
- Does not persist state across server restarts.
- Does not impose a payload contract. Named-message dispatch ("action routing"), JSON envelopes, and any other application-level convention are the handler's responsibility; the middleware ships nothing of the kind.
- Does not proxy to a real backend. For proxying, use [`ui5-middleware-simpleproxy`](https://www.npmjs.com/package/ui5-middleware-simpleproxy) or `fiori-tools-proxy`.

## Prerequisites

- **Node.js** ≥ 22.18 (declared in `engines`; required for the native TypeScript type stripping the handler loader relies on when handlers are authored in TS).
- **`@ui5/cli`** ≥ 4.0.0 (this middleware declares `specVersion: "4.0"`; older CLI versions reject the extension).
- A UI5 project of `kind: project`, `type: application` / `library` / `themeLibrary`. `Module`-type projects need `configuration.rootPath` because they have no single source path.
- TypeScript is not required to use the middleware; handlers may be plain `.js` files. If you write handlers in TypeScript, Node ≥ 22.18 runs them directly via native type stripping; no `ts-node` step is needed.

## Version compatibility

| `ui5-middleware-ws-mock` | UI5 Tooling specVersion | `@ui5/cli` | Node      | TypeScript (optional) |
| ------------------------ | ----------------------- | ---------- | --------- | --------------------- |
| `0.x`                    | `4.0`                   | `≥ 4.0.0`  | `≥ 22.18` | `~ 6.0`               |

Pre-1.0 the public types and the middleware configuration shape may change in minor releases. Note that for `0.x` versions npm semver treats the minor as the major: `^0.3.0` and `~0.3.0` resolve to the same range (`>=0.3.0 <0.4.0`), so either form pins to the current minor.

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
                        handler: wsmock/handlers/foo.ts
    ```

    Clients connect to `ws://<host>:<port><mountPath>`. `handler` resolves under the UI5 project's source path (typically `webapp/`), so the example above loads `<project>/webapp/wsmock/handlers/foo.ts`. For handlers outside the source folder, set `configuration.rootPath` (see [Configuration](#configuration)).

    The middleware's `kind: extension` declaration ships in the package and is auto-discovered by `@ui5/server`; no separate extension file is required in the consuming application.

3. Write a handler module at `webapp/wsmock/handlers/foo.ts`. `default`-export a `WebSocketHandler`:

    ```typescript
    import type { WebSocketHandler } from "ui5-middleware-ws-mock";

    const handler: WebSocketHandler = {
    	onConnect: (ctx) => ctx.send("HELLO"),
    	onMessage: (ctx, message) => {
    		const body = typeof message === "string" ? message : message.body;
    		ctx.send(`echo:${body}`);
    	},
    	onClose: (ctx, code) => ctx.log.info(`close ${code}`),
    };

    export default handler;
    ```

    The handler runs in the `ui5 serve` Node process. `message` is a `string` in plain mode and `{ fields, body }` in PCP mode; the handler narrows on `typeof` (or on `ctx.mode`).

4. Run `npm start`. The server log prints one pair of lines per configured route:

    ```text
    [ws-mock] resolving handler paths against /abs/path/to/project/webapp
    [ws-mock:/ws/foo] handler loaded from wsmock/handlers/foo.ts (/abs/path/to/project/webapp/wsmock/handlers/foo.ts)
    [ws-mock] listening for upgrades on: /ws/foo
    ```

    The first line is logged at `verbose` and shows the effective root path; the per-route line also includes the absolute resolved path, so a handler load failure points directly at the file the middleware tried to import.

> [!TIP]
> Handlers and `ui5.yaml` edits require a `ui5 serve` restart; livereload only covers `webapp/`-side code. See [Limitations](#limitations) for the supervisor pattern that automates it.

## Configuration

The `configuration` block under the `customMiddleware` entry accepts:

| Key                  | Type               | Required | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rootPath`           | `string`           | no       | Override the root directory that `routes[].handler` paths resolve against. Resolved relative to the project root (the directory containing `ui5.yaml`); absolute paths are honored as-is. Defaults to the UI5 project's source path: `webapp/` for Application projects, `src/` for Library/ThemeLibrary projects (honoring any overrides under `resources.configuration.paths`). Module-type projects have no single source path, so `rootPath` is required there. |
| `routes`             | `WebSocketRoute[]` | yes      | One entry per mount path. Each entry declares a path and the file that provides the handler module.                                                                                                                                                                                                                                                                                                                                                                 |
| `routes[].mountPath` | `string`           | yes      | Path such as `/ws/foo`. Matched against the upgrade request pathname literally; no parameter patterns. Clients connect to `ws://<host>:<port><mountPath>`.                                                                                                                                                                                                                                                                                                          |
| `routes[].handler`   | `string`           | yes      | Path to the handler module, resolved against the effective root (see `rootPath` above). Absolute paths are honored as-is. Exactly one handler per route.                                                                                                                                                                                                                                                                                                            |

### `rootPath` resolution matrix

The same `handler` value resolves to a different file depending on `rootPath`. All four forms are legal; pick the one that fits your project layout. Assume a project rooted at `<project>/` (the directory containing `ui5.yaml`).

**Default (no `rootPath`).** Handler paths resolve under the UI5 source path: `<project>/webapp/` for Application projects, `<project>/src/` for Library/ThemeLibrary. Best fit for handlers that ship inside the deployed app:

```yaml
configuration:
    routes:
        - mountPath: /ws/foo
          handler: wsmock/handlers/foo.ts
# loads <project>/webapp/wsmock/handlers/foo.ts
```

**`rootPath: "."`.** Resolves from the project root (where `ui5.yaml` lives). Best fit when handlers live alongside `ui5.yaml`, not inside `webapp/`:

```yaml
configuration:
    rootPath: "."
    routes:
        - mountPath: /ws/foo
          handler: wsmock/handlers/foo.ts
# loads <project>/wsmock/handlers/foo.ts
```

**Relative `rootPath`.** Resolves under a subdirectory of the project root. Best fit for keeping mocks alongside other test artifacts:

```yaml
configuration:
    rootPath: test/wsmock
    routes:
        - mountPath: /ws/foo
          handler: handlers/foo.ts
# loads <project>/test/wsmock/handlers/foo.ts
```

**Absolute `rootPath`.** Resolves verbatim, ignoring the project root. Best fit for handler bundles shared across multiple apps in a monorepo:

```yaml
configuration:
    rootPath: /shared/wsmocks
    routes:
        - mountPath: /ws/foo
          handler: foo.ts
# loads /shared/wsmocks/foo.ts
```

On Windows, quote absolute paths to keep YAML happy: `rootPath: "C:/shared/wsmocks"` (forward slashes work fine; backslashes need to be doubled or the string quoted).

### Multiple routes

Multiple routes in the same middleware entry share the resolved root. Each loads its own handler:

```yaml
configuration:
    routes:
        - mountPath: /ws/foo
          handler: wsmock/handlers/foo.ts
        - mountPath: /ws/bar
          handler: wsmock/handlers/bar.ts
```

## Wire layer: WebSocket and PCP

The middleware speaks WebSocket. When the connecting client offers the `v10.pcp.sap.com` subprotocol, the middleware also speaks PCP framing. That is the entire wire-level contract.

- **Plain WebSocket.** A frame is whatever bytes the peers exchanged. The middleware imposes no specific shape; `onMessage` receives the raw frame string.
- **PCP.** Frames are split into header fields and a body, per the [SAP PCP v1.0 spec](https://community.sap.com/t5/application-development-and-automation-blog-posts/specification-of-the-push-channel-protocol-pcp/ba-p/13137541). Negotiation happens once per connection at the handshake; every frame on the connection is PCP-framed in both directions thereafter. `onMessage` receives a decoded `{ fields, body }` object with the body bytes preserved verbatim.

Either mode can carry any payload format (JSON objects, opaque text, base64-encoded bytes, line-delimited records, etc.). The middleware never JSON-parses the body, never wraps outbound payloads in an envelope, and never invents routing keys; whatever framing or encoding the peers agree on lives entirely in handler code.

The PCP v1.0 codec is implemented in [`src/pcp.ts`](src/pcp.ts) and re-exported from the package root as `encode` / `decode` / `pcpEscape` / `pcpUnescape` / `SUBPROTOCOL`; the `ws` package itself has no PCP awareness. Handlers should prefer `ctx.send` (which calls `encode` internally) for outbound writes from inside a handler callback; the standalone `encode` / `decode` exports are intended for code that does not have a `WebSocketContext` to hand (fixtures, test harnesses, fan-out workers that hold only a raw `WebSocket`, etc.).

### Negotiation

Negotiation is per connection, not per route. The same `mountPath` can serve a PCP client and a plain client at the same time; each connection negotiates independently at its own handshake, and the handler reads the outcome through that connection's `ctx.mode`.

The middleware constructs its `WebSocketServer` with:

```typescript
handleProtocols: (protocols) => (protocols.has("v10.pcp.sap.com") ? "v10.pcp.sap.com" : false);
```

Clients that offer `v10.pcp.sap.com` get it echoed back and run in PCP mode; encoding and decoding go through the codec in [`src/pcp.ts`](src/pcp.ts). Clients that offer no subprotocol (plain `WebSocket`) get no subprotocol back and run in plain mode. Clients that offer only some other subprotocol fail their own handshake per RFC 6455 §4.2.2, because no echo is returned for unrecognized subprotocols.

After the handshake, `ws.protocol` is either `"v10.pcp.sap.com"` or `""`, and the middleware snapshots that value into `ctx.mode`. The mode is fixed for the lifetime of that connection. If a route should only ever serve one mode, enforce it with a guard inside the handler. See [Asserting a single mode](#asserting-a-single-mode).

### Backpressure and payload limits

The middleware does not throttle or buffer-cap. Two `ws`-level defaults are worth knowing about when a handler pushes high-frequency frames or accepts large inbound payloads:

- **Backpressure.** A slow or stalled peer cannot acknowledge frames as fast as the handler produces them; the unsent bytes accumulate in `ws.bufferedAmount`. Handlers that periodically push (`setInterval`, change-detection loops, fan-out subscriber sets) should sample `ctx.ws.bufferedAmount` and skip a tick when it grows past a threshold:

    ```typescript
    onConnect: (ctx) => {
    	const timer = setInterval(() => {
    		if (ctx.ws.bufferedAmount > 1_000_000) return; // ~1 MiB unsent
    		ctx.send(`tick at ${Date.now()}`);
    	}, 100);
    	ctx.ws.on("close", () => clearInterval(timer));
    };
    ```

- **`maxPayload` default.** Inbound frames larger than `ws`'s default `maxPayload` (100 MiB) are rejected at the WebSocket layer before reaching `onMessage`; the connection is closed with code 1009 (`Message Too Big`). The middleware does not expose a knob to override this. For mock scenarios this ceiling is almost always far above realistic test payloads.

## Handler API

A handler module default-exports an object implementing `WebSocketHandler` (defined in [`src/types.ts`](src/types.ts)):

```typescript
export interface WebSocketHandler {
	onConnect?: (ctx: WebSocketContext) => void | Promise<void>;
	onMessage?: (ctx: WebSocketContext, message: InboundMessage) => void | Promise<void>;
	onClose?: (ctx: WebSocketContext, code: number, reason: string) => void | Promise<void>;
	onError?: (ctx: WebSocketContext, err: unknown) => void | Promise<void>;
}

export type InboundMessage = string | PcpFrame;

export interface PcpFrame {
	fields: Record<string, string>; // includes pcp-action, pcp-body-type
	body: string; // raw body bytes as utf-8
}
```

All callbacks are optional. A handler that only implements `onMessage` is valid; so is a handler that only implements `onConnect` (e.g. a periodic-push fixture that never reads inbound traffic). Frames that arrive when no `onMessage` is defined are dropped with a `verbose` log. Any callback may be `async`; the middleware awaits returned promises and logs rejections through `ctx.log.error` without closing the connection.

`onError` fires whenever the middleware catches an error from this connection: a sync throw or async rejection from any other callback, an `encode()` failure raised inside `ctx.send` (PCP mode), or a `'error'` event on the underlying `ws` socket. The error is always logged first; the hook is an additional notification, not a replacement. A throw from `onError` itself is logged once and does not re-enter the hook.

### `WebSocketContext`

`WebSocketContext` is a discriminated union on `mode` (defined in [`src/types.ts`](src/types.ts)). Every callback receives one of the two members (`PlainWebSocketContext` or `PcpWebSocketContext`, both re-exported from the package root). TypeScript narrows the union on `ctx.mode === "pcp"` / `"plain"`, which unlocks the appropriate `send` signature:

| Field       | Type                                                                                    | Description                                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ws`        | `WebSocket`                                                                             | Raw `ws` instance. Required for any framing the helper methods do not cover.                                                                                 |
| `req`       | `http.IncomingMessage`                                                                  | The HTTP upgrade request. Useful for `url`, `headers`, `socket.remoteAddress`.                                                                               |
| `mode`      | `"pcp" \| "plain"`                                                                      | Negotiated at the handshake; fixed for the lifetime of the connection. Discriminant for the union; narrow on it to interpret `message` and choose `send`.    |
| `log`       | `WebSocketLog`                                                                          | Scoped logger prefixed with `[ws-mock:<mountPath>]`. Methods mirror `@ui5/logger`'s level names: `silly`, `verbose`, `perf`, `info`, `warn`, `error`.        |
| `send`      | plain: `(message: string) => void`<br>pcp: `(message: string \| EncodeOptions) => void` | Send a frame. Plain mode writes the bytes through `ws.send` unchanged. PCP mode accepts a string (wrapped in a default frame) or `EncodeOptions`. See below. |
| `close`     | `(code?, reason?) => void`                                                              | Close the connection with optional code (default 1000) and reason.                                                                                           |
| `terminate` | `() => void`                                                                            | Hard-kill the socket without a close handshake. The client observes code 1006.                                                                               |

Calling `ctx.send("text")` is legal in either branch because `string` is in both signatures, so call sites that do not need PCP-specific framing do not need to narrow first. Calling `ctx.send({ action: "...", body: "..." })` requires the PCP narrow.

Consumers can filter logs by the `[ws-mock:<mountPath>]` prefix or by log message content.

### `ctx.send(message)`

The string overload behaves the same way in both modes; the `EncodeOptions` overload is PCP-only.

```typescript
ctx.send("HELLO");

if (ctx.mode === "pcp") {
	ctx.send({
		action: "EVENT",
		bodyType: "text",
		fields: { correlationId: "abc" },
		body: "payload",
	});
}
```

The middleware does not interpret the bytes:

- **Plain mode.** `message` is written through `ws.send` unchanged.
- **PCP mode, string.** `message` is wrapped in a default PCP frame (`pcp-action:MESSAGE`, `pcp-body-type:text`, no extra header fields) with `message` as the body.
- **PCP mode, `EncodeOptions`.** The middleware calls `encode(message)` internally and writes the resulting wire string. `EncodeOptions` is re-exported from the package root.

`ctx.send` never throws; failure cases (closed socket, `ws.send` throw, `encode()` throw on an empty PCP field name) are summarized in [Error handling](#error-handling).

For binary payloads, base64-encode the bytes and pass `bodyType: "binary"`:

```typescript
if (ctx.mode === "pcp") {
	ctx.send({ bodyType: "binary", body: someBuffer.toString("base64") });
}
```

For framing the public encoder cannot express (alternate separator handling, raw non-PCP wire formats, etc.), fall back to `ctx.ws.send` with a pre-built wire string. `encode` is re-exported from the package root for that purpose.

### Asserting a single mode

When a route is single-mode by contract (a PCP-only endpoint where any plain client is a bug, for instance), narrowing on `ctx.mode` at every call site adds noise. Two type-safe patterns let you skip the per-call narrow. Both rely on the named branches of the discriminated union (`PlainWebSocketContext` / `PcpWebSocketContext`), which are re-exported from the package root alongside `WebSocketContext`.

**Early-return narrow (recommended).** A single guard at the top of the callback rejects a wrong-mode client and narrows `ctx` for the rest of the function body. Closing the connection is the loud part; a bare `throw` would only log under the handler-invocation wrapper and leave the wrong-mode client connected:

```typescript
import type { WebSocketHandler } from "ui5-middleware-ws-mock";

const handler: WebSocketHandler = {
	onConnect: (ctx) => {
		if (ctx.mode !== "pcp") {
			ctx.log.warn(`rejecting non-PCP client (mode=${ctx.mode})`);
			ctx.close(1008, "route requires PCP subprotocol"); // 1008 = Policy Violation
			return;
		}
		// ctx is narrowed to PcpWebSocketContext for the rest of the body.
		ctx.send({ action: "HELLO", body: "" });
	},
};

export default handler;
```

If the same assumption recurs across handlers, factor it into a TypeScript `asserts` helper. The predicate gives the same compile-time narrowing as the inline `if/return` (the runtime close is then the caller's responsibility, or the helper can call `ctx.close` and `throw` so the wrapper logs once before the connection drops):

```typescript
import type {
	PcpWebSocketContext,
	WebSocketContext,
	WebSocketHandler,
} from "ui5-middleware-ws-mock";

function assertPcp(ctx: WebSocketContext): asserts ctx is PcpWebSocketContext {
	if (ctx.mode !== "pcp") {
		ctx.close(1008, "route requires PCP subprotocol");
		throw new Error(`expected PCP route, got mode=${ctx.mode}`);
	}
}

const handler: WebSocketHandler = {
	onConnect: (ctx) => {
		assertPcp(ctx);
		ctx.send({ action: "HELLO", body: "" });
	},
};

export default handler;
```

Direct parameter narrowing (`onConnect: (ctx: PcpWebSocketContext) => …`) is rejected by TypeScript; see [Troubleshooting](#troubleshooting) for the exact error and why. A `ctx as PcpWebSocketContext` cast is not recommended either: it strips the runtime check the early-return pattern gives you. On a misnegotiated (plain-mode) connection the cast lets a handler call `ctx.send({ action, body })`, which plain mode's `(message: string) => void` receives as a non-string. `ws.send` then transmits the object's stringified form (typically `[object Object]`), so the peer sees a malformed frame rather than a clean negotiation failure.

### Inbound `message`

`InboundMessage` is `string | PcpFrame`:

- **Plain mode.** `message` is the raw frame body as it arrived on the wire.
- **PCP mode.** `message` is `{ fields, body }`. `fields` includes `pcp-action`, `pcp-body-type`, and every application-defined header field. `body` is the body bytes as a UTF-8 string with no JSON parsing or other interpretation.

Handlers narrow with `typeof message === "string"` (or `ctx.mode === "plain"`) before reading.

## Writing handlers for custom scenarios

Custom logic lives entirely inside the callbacks the handler provides.

### Named-message dispatch ("action routing") in user-land

The middleware does not ship action routing. If you want a `name → callback` map, build it in two lines on top of `onMessage`:

```typescript
import type { WebSocketHandler, WebSocketContext } from "ui5-middleware-ws-mock";

type Action = (ctx: WebSocketContext, body: string) => void;

const actions: Record<string, Action> = {
	PING: (ctx, body) => reply(ctx, "PONG", body),
	BAR: (ctx, body) => reply(ctx, "BAR_REPLY", body),
};

function reply(ctx: WebSocketContext, action: string, body: string): void {
	if (ctx.mode === "pcp") {
		ctx.send({ fields: { action }, body });
	} else {
		ctx.send(`${action}:${body}`); // pick whichever plain-mode framing your client speaks
	}
}

const handler: WebSocketHandler = {
	onMessage: (ctx, message) => {
		let action: string | undefined;
		let body: string;
		if (typeof message === "string") {
			const idx = message.indexOf(":");
			action = idx >= 0 ? message.slice(0, idx) : message;
			body = idx >= 0 ? message.slice(idx + 1) : "";
		} else {
			action = message.fields.action;
			body = message.body;
		}
		const fn = action ? actions[action] : undefined;
		if (fn) fn(ctx, body);
		else ctx.log.verbose(`unhandled action=${action ?? "(none)"}`);
	},
};

export default handler;
```

The plain-mode wire shape (`ACTION:body` here) is whatever your client speaks; pick to match.

### Stateful per-connection handlers

Per-connection state belongs in a `WeakMap` keyed by `ctx`; the entry is collected automatically when the connection ends.

```typescript
const state = new WeakMap<WebSocketContext, { count: number }>();

const handler: WebSocketHandler = {
	onConnect: (ctx) => {
		state.set(ctx, { count: 0 });
		ctx.send("HELLO");
	},
	onMessage: (ctx) => {
		const s = state.get(ctx);
		if (!s) return;
		s.count += 1;
		ctx.send(`count=${s.count}`);
	},
};
```

### Shared state across connections

```typescript
const subscribers = new Set<WebSocketContext>();

const handler: WebSocketHandler = {
	onConnect: (ctx) => subscribers.add(ctx),
	onClose: (ctx) => subscribers.delete(ctx),
	onMessage: (_ctx, message) => {
		const body = typeof message === "string" ? message : message.body;
		for (const sub of subscribers) sub.send(`event:${body}`);
	},
};
```

### Periodic push

```typescript
const handler: WebSocketHandler = {
	onConnect: (ctx) => {
		const timer = setInterval(() => {
			ctx.send(`tick at ${Date.now()}`);
		}, 1000);
		ctx.ws.on("close", () => clearInterval(timer));
	},
};
```

### Simulating backend latency

```typescript
const handler: WebSocketHandler = {
	onMessage: async (ctx, message) => {
		await new Promise((r) => setTimeout(r, 500));
		const body = typeof message === "string" ? message : message.body;
		ctx.send(`ack:${body}`);
	},
};
```

### Forcing disconnects for retry-strategy testing

```typescript
const handler: WebSocketHandler = {
	onMessage: (ctx, message) => {
		const body = typeof message === "string" ? message : message.body;
		if (body === "DISCONNECT") return ctx.close(1001, "requested"); // clean close
		if (body === "TERMINATE") return ctx.terminate(); // abrupt; client sees 1006
	},
};
```

## Error handling

Every failure site is caught and logged through the route-scoped logger (`[ws-mock:<mountPath>]`). The connection stays open unless the handler explicitly closes it.

| Site                                         | Policy                                                                                                                                                                                                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ws.send` on a non-open socket               | pre-check `ws.readyState === OPEN`; skip with a `warn` when not.                                                                                                                                                                                      |
| `ws.send` throws synchronously               | caught around the call; log at `error`; connection is left to close via `ws`'s own error handling.                                                                                                                                                    |
| `ws`-level `'error'` event                   | always-on listener attached at the top of `attachConnection`; log at `error`. Required to keep a misbehaving peer (invalid UTF-8, oversize payload, malformed frame) from crashing `ui5 serve` via Node's EventEmitter contract.                      |
| Malformed inbound PCP frame                  | decoder returns partial data; `onMessage` sees best-effort `fields` / `body` (empty `fields` if the LFLF separator is missing, mirroring `SapPcpWebSocket`). The fallback also logs at `verbose` so it's distinguishable from an empty-headers frame. |
| Handler sync throw                           | caught; log at `error`; connection stays open.                                                                                                                                                                                                        |
| Handler async rejection                      | `.catch(err => ctx.log.error(...))`; connection stays open.                                                                                                                                                                                           |
| Dynamic `import(handler)` failure at startup | logged at `error`; the route accepts the upgrade then closes with code 1011 (Internal Server Error).                                                                                                                                                  |
| Unparseable upgrade URL                      | `try { new URL(req.url, ...) } catch` bails without claiming the upgrade so other listeners get a shot; log at `verbose`.                                                                                                                             |

`ctx.send` does not wrap `encode()` in a try/catch. The string overload cannot trigger `encode`'s only error condition (empty field name). The `EncodeOptions` overload can, but the throw belongs to the caller's mistake (an empty key in `fields`); handlers that pass user-controlled field names are responsible for guarding against it.

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
- **Requires specVersion 3.0+** on the middleware extension to use `middlewareUtil.getProject().getRootPath()` (and `getSourcePath()`) for resolving handler paths. This middleware declares `specVersion: "4.0"`.

## Troubleshooting

**A handler edit didn't take effect.** Handler modules are imported once at server start and cached for the process lifetime. Stop `ui5 serve` and start it again, or run it under a supervisor (`tsx watch`, `nodemon --watch <handlers-dir>`) that restarts the whole process on changes. See [Limitations](#limitations).

**The client disconnects with code 1011.** The handler module failed to load (syntax error, missing default export, import that threw). The middleware accepts the upgrade then closes with `1011 Internal Server Error`; the failure is also logged at server start with the absolute file path the middleware tried to import. Fix the module and restart the server.

**The client disconnects with code 1006.** This is the "no close frame received" code, emitted by the client when the TCP connection drops without a clean WebSocket close. Most often: the server process exited (handler `throw` that wasn't caught; almost everything inside the middleware is caught, but raw `ctx.ws.on(...)` listeners on the underlying socket are the handler's own to guard), or `ctx.terminate()` was called.

**The client offers a subprotocol and the handshake fails.** Only `v10.pcp.sap.com` is recognized. Any other offered subprotocol receives no echo from the server; per RFC 6455 §4.2.2 the client fails its own handshake. Plain `WebSocket` clients that offer no subprotocol succeed and run in plain mode.

**Custom `pcp-XXX` header disappears in PCP mode.** `pcp-*` is a reserved prefix in the PCP spec. The encoder silently drops `pcp-*` keys from `EncodeOptions.fields`; the two reserved fields go through the dedicated `action` and `bodyType` options instead. Application-defined header names should not start with `pcp-`.

**`Types of parameters 'ctx' and 'ctx' are incompatible.`** A handler typed as `onConnect: (ctx: PcpWebSocketContext) => …` will not assign to `WebSocketHandler`. TypeScript checks function-property parameters contravariantly under `strictFunctionTypes`, so a callback that only accepts `PcpWebSocketContext` is structurally incompatible with the middleware's contract of invoking your handler with whichever mode the connection negotiated. Use the early-return narrow or `asserts` helper documented under [Asserting a single mode](#asserting-a-single-mode).

**TypeScript can't find this package's types from my consuming project.** The package is published ESM-only: `dist/index.d.ts` is exposed under the `types`/`default` export conditions only, with no `require` condition and no `.d.cts` shadow. In a CommonJS resolution context (`"module": "commonjs"`/`"node10"`, or `"node16"`/`"nodenext"` with `"type": "commonjs"` or none in the importer's nearest `package.json`), a plain `import type` does not resolve. Three workarounds:

- **Per-import override.** `import type { … } from "ui5-middleware-ws-mock" with { "resolution-mode": "import" };` tells `tsc` to resolve the specifier as if the importing file were ESM.
- **ESM the consuming project.** Set `"type": "module"` in its `package.json` and `"module": "nodenext"` / `"moduleResolution": "nodenext"` in its `tsconfig.json`.
- **Bundler-mode resolution.** Set `"moduleResolution": "bundler"` when a bundler (Vite, esbuild, etc.) loads modules.

This package does not ship a `.d.cts` shadow; the ecosystem is moving to ESM and a CJS resolution context is not a goal here.

## Related

- [Specification of the Push Channel Protocol (PCP)](https://community.sap.com/t5/application-development-and-automation-blog-posts/specification-of-the-push-channel-protocol-pcp/ba-p/13137541): SAP's PCP v1.0 wire-format spec that [`src/pcp.ts`](src/pcp.ts) implements.
- [`ui5-utils-express/lib/hook.js`](https://github.com/ui5-community/ui5-ecosystem-showcase/blob/main/packages/ui5-utils-express/lib/hook.js): the helper used to obtain the underlying HTTP server.
- [`ui5-lib-misc-util` § websocket](https://github.com/wridgeu/ui5-lib-misc-util/blob/main/packages/lib/README.md#websocket): an example UI5 client that talks to this middleware. The middleware is transport-agnostic and works with any WebSocket client; this is one such client.

## Contributing

Issues and pull requests are welcome. Anything goes: bug reports, feature ideas, questions about the design, or notes from using the middleware in a real project. For larger changes, a quick issue first to sketch the approach avoids wasted work.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (enforced via `commitlint`). Before submitting a PR, run `npm run check` to cover formatting, linting, and type-checks, and `npm test` for the vitest suite.

## License

MIT. See [LICENSE](LICENSE).

## Credits

> [!NOTE]
> The pattern of hosting a WebSocket endpoint alongside `ui5 serve`, and the technique used to obtain the underlying HTTP server from inside the UI5 tooling lifecycle, originate from prior work by Peter Muessig in the UI5 community ecosystem. This package adds a per-route mock dispatch model with PCP negotiation on top of that foundation.

- [`ui5-middleware-websocket`](https://github.com/ui5-community/ui5-ecosystem-showcase/tree/main/packages/ui5-middleware-websocket) by Peter Muessig: generic WebSocket transport for `ui5 serve`. Different scope from this package (no per-route handler dispatch, no PCP framing); the original demonstration that hosting a WebSocket endpoint inside `ui5 serve` is feasible.
- [`ui5-utils-express`](https://github.com/ui5-community/ui5-ecosystem-showcase/tree/main/packages/ui5-utils-express) by Peter Muessig: the `lib/hook` helper this middleware depends on to obtain the underlying HTTP server from inside a UI5 custom middleware factory.
