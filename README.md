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
- Does not impose a payload contract. Named-message dispatch ("action routing"), JSON envelopes, and any other application-level convention are the handler's responsibility — the middleware ships nothing of the kind.
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
> **Restart `ui5 serve` after editing configuration or handlers.** Livereload covers `webapp/`-side code only. Changes to `ui5.yaml` (new routes, renamed mount paths) and changes to handler modules are picked up at the next server boot. To automate this, run `ui5 serve` under a process supervisor such as `tsx watch` or `nodemon --watch <handlers-dir>`.

## TypeScript: importing types from a CommonJS-context project

This package is published ESM-only. The runtime declares `"type": "module"` and `dist/index.d.ts` is exposed under the `types` and `default` export conditions only, with no `require` condition and no `.d.cts` shadow. When the importing file is resolved in a CommonJS context (typical with `"module": "commonjs"` or `"node10"`, and with `"node16"`/`"nodenext"` when the importing file's nearest `package.json` declares `"type": "commonjs"` or omits it), `tsc` cannot pick up an ESM-only type declaration via a plain `import type`. The standard workaround is the `resolution-mode` import attribute:

```typescript
import type { PcpFrame, WebSocketHandler } from "ui5-middleware-ws-mock" with {
	"resolution-mode": "import",
};
```

The attribute tells `tsc` to resolve the specifier as if the importing file were ESM. Two settings avoid needing it altogether:

- **Make the consuming TS context ESM.** Set `"type": "module"` in the consuming project's `package.json` and `"module": "nodenext"` plus `"moduleResolution": "nodenext"` in its `tsconfig.json`.
- **Use `"moduleResolution": "bundler"`** when a bundler (Vite, esbuild, etc.) handles module loading. Bundler-mode resolution does not enforce the ESM/CJS split.

This package does not ship a `.d.cts` shadow. The JavaScript ecosystem is moving to ESM, and supporting a CJS resolution context is not a goal here.

## Configuration

The `configuration` block under the `customMiddleware` entry accepts:

| Key                  | Type               | Required | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------- | ------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rootPath`           | `string`           | no       | Override the root directory that `routes[].handler` paths resolve against. Resolved relative to the project root (the directory containing `ui5.yaml`); absolute paths are honored as-is. Defaults to the UI5 project's source path — `webapp/` for Application projects, `src/` for Library/ThemeLibrary projects (honoring any overrides under `resources.configuration.paths`). Module-type projects have no single source path, so `rootPath` is required there. |
| `routes`             | `WebSocketRoute[]` | yes      | One entry per mount path. Each entry declares a path and the file that provides the handler module.                                                                                                                                                                                                                                                                                                                                                                  |
| `routes[].mountPath` | `string`           | yes      | Path such as `/ws/foo`. Matched against the upgrade request pathname literally; no parameter patterns. Clients connect to `ws://<host>:<port><mountPath>`.                                                                                                                                                                                                                                                                                                           |
| `routes[].handler`   | `string`           | yes      | Path to the handler module, resolved against the effective root (see `rootPath` above). Absolute paths are honored as-is. Exactly one handler per route.                                                                                                                                                                                                                                                                                                             |

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

## Handler API

A handler module default-exports an object implementing `WebSocketHandler` (defined in [`src/types.ts`](src/types.ts)):

```typescript
export interface WebSocketHandler {
	onConnect?: (ctx: WebSocketContext) => void | Promise<void>;
	onMessage?: (ctx: WebSocketContext, message: InboundMessage) => void | Promise<void>;
	onClose?: (ctx: WebSocketContext, code: number, reason: string) => void | Promise<void>;
}

export type InboundMessage = string | PcpFrame;

export interface PcpFrame {
	fields: Record<string, string>; // includes pcp-action, pcp-body-type
	body: string; // raw body bytes as utf-8
}
```

All callbacks are optional. A handler that only implements `onMessage` is valid; so is a handler that only implements `onConnect` (e.g. a periodic-push fixture that never reads inbound traffic). Frames that arrive when no `onMessage` is defined are dropped with a `verbose` log. Any callback may be `async`; the middleware awaits returned promises and logs rejections through `ctx.log.error` without closing the connection.

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

Non-open sockets and synchronous `ws.send` throws are logged and swallowed; callers never observe a throw.

For binary payloads, base64-encode the bytes and pass `bodyType: "binary"`:

```typescript
if (ctx.mode === "pcp") {
	ctx.send({ bodyType: "binary", body: someBuffer.toString("base64") });
}
```

For framing the public encoder cannot express (alternate separator handling, raw non-PCP wire formats, etc.), fall back to `ctx.ws.send` with a pre-built wire string. `encode` is re-exported from the package root for that purpose.

### Asserting a single mode

When a route is single-mode by contract (a PCP-only endpoint where any plain client is a bug, for instance), narrowing on `ctx.mode` at every call site adds noise. Two patterns let you skip the per-call narrow. Both rely on the named branches of the discriminated union (`PlainWebSocketContext` / `PcpWebSocketContext`), which are re-exported from the package root alongside `WebSocketContext`.

**Early-return narrow (recommended).** A single guard at the top of the callback fails loudly on a wrong assumption and narrows `ctx` for the rest of the function body:

```typescript
import type { WebSocketHandler } from "ui5-middleware-ws-mock";

const handler: WebSocketHandler = {
	onConnect: (ctx) => {
		if (ctx.mode !== "pcp") throw new Error("route requires PCP subprotocol");
		// ctx is narrowed to PcpWebSocketContext for the rest of the body.
		ctx.send({ action: "HELLO", body: "" });
	},
};

export default handler;
```

If the same assumption recurs across handlers, factor it into a TypeScript `asserts` helper. The predicate has the same narrowing effect as the inline `if/throw` but is reusable:

```typescript
import type {
	PcpWebSocketContext,
	WebSocketContext,
	WebSocketHandler,
} from "ui5-middleware-ws-mock";

function assertPcp(ctx: WebSocketContext): asserts ctx is PcpWebSocketContext {
	if (ctx.mode !== "pcp") throw new Error("expected PCP route");
}

const handler: WebSocketHandler = {
	onConnect: (ctx) => {
		assertPcp(ctx);
		ctx.send({ action: "HELLO", body: "" });
	},
};

export default handler;
```

**Inline cast.** If you accept the runtime exposure described below, cast `ctx` directly. The cast has no runtime effect; it only changes what TypeScript sees:

```typescript
import type { PcpWebSocketContext, WebSocketHandler } from "ui5-middleware-ws-mock";

const handler: WebSocketHandler = {
	onConnect: (ctx) => {
		const c = ctx as PcpWebSocketContext;
		c.send({ action: "HELLO", body: "" });
	},
};

export default handler;
```

This is a load-bearing claim, not a verified fact. If the connection turns out plain at runtime (a client that omits the `v10.pcp.sap.com` subprotocol, say), `c.send({...})` passes the object through to the plain-mode `send` impl that expects a string; `ws.send` then rejects or stringifies it, and the client sees a malformed frame instead of a clean failure. The cast is acceptable when the deployment layer (ingress, gateway, client-side enforcement) prevents non-PCP clients from reaching the route; otherwise prefer the early-return form.

> [!NOTE]
> You cannot narrow the parameter type directly: `onConnect: (ctx: PcpWebSocketContext) => …` fails to assign to `WebSocketHandler` because TypeScript checks function-property parameter types contravariantly under `strictFunctionTypes`. A handler that only accepts `PcpWebSocketContext` is structurally incompatible with the middleware's contract of calling your handler with whichever mode the connection negotiated. The cast and assertion forms above are the only ways to express "single-mode" inside the existing handler signature.

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

## PCP negotiation

Negotiation runs once per connection at the handshake. The middleware constructs its `WebSocketServer` with:

```typescript
handleProtocols: (protocols) => (protocols.has("v10.pcp.sap.com") ? "v10.pcp.sap.com" : false);
```

Clients that offer `v10.pcp.sap.com` receive it back, pinning the connection into PCP mode; encoding and decoding then go through the codec in [`src/pcp.ts`](src/pcp.ts). Clients that offer no subprotocol (plain `WebSocket`) receive no subprotocol back. Clients that offer something else fail their own handshake per RFC 6455 §4.2.2, because no echo is returned for unrecognized subprotocols.

After the handshake, `ws.protocol` is either `"v10.pcp.sap.com"` or `""`, and the middleware snapshots that value into `ctx.mode`. The mode is fixed for the lifetime of the connection.

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

`ctx.send` does not wrap `encode()` in a try/catch. The string-sugar path cannot trigger `encode`'s only error condition (empty field name). The `EncodeOptions` path can, but the throw belongs to the caller's mistake (an empty key in `fields`); handlers that pass user-controlled field names are responsible for guarding against it.

> [!NOTE]
> **Restart the server before debugging.** Handler modules are imported once at startup and cached for the process lifetime; symptoms such as a route that 404s after a `ui5.yaml` edit, or a handler change that does not appear to take effect, are typically resolved by stopping `ui5 serve` and starting it again.

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
- **Requires specVersion 3.0+** on the middleware extension to use `middlewareUtil.getProject().getRootPath()` (and `getSourcePath()`) for resolving handler paths. This middleware declares `specVersion: "4.0"`.

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
