import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { connect as netConnect } from "node:net";
import { resolve as resolvePath } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import {
	startServer,
	fireHook,
	resetHookCapture,
	setHookCapture,
	createMiddlewareUtil,
	expectFallThrough,
} from "./helpers/server.js";
import { createCapturedLogger } from "./helpers/logger.js";
import { waitForLog, waitForMessages, waitForOpen } from "./helpers/wait.js";
import { decode, encode } from "../src/pcp.js";

vi.mock("ui5-utils-express/lib/hook.js", () => ({
	default: (
		_name: string,
		callback: (args: { server: unknown; app?: unknown; options?: unknown }) => void,
	) => {
		// Forward to the helper-side capture. Cast through unknown because the
		// helper types `server` as http.Server; the runtime payload matches.
		setHookCapture(callback as Parameters<typeof setHookCapture>[0]);
		return (_req: unknown, _res: unknown, next: () => void) => next();
	},
}));

// Imported AFTER vi.mock so the mocked hook is what the factory sees.
const { default: wsMock } = await import("../src/middleware.js");

const REPO_ROOT = resolvePath(import.meta.dirname, "..");

// Setup is file-scoped so every `describe` module below shares one server
// lifecycle and the `buildFactoryArgs` helper. The modules are siblings (not
// nested) to keep each `it` at its current indentation.
let serverHandle: Awaited<ReturnType<typeof startServer>>;

beforeEach(async () => {
	resetHookCapture();
	serverHandle = await startServer();
});

afterEach(async () => {
	await serverHandle.close();
});

function buildFactoryArgs(handlerRelative: string, mountPath: string) {
	const { log, entries } = createCapturedLogger();
	return {
		log,
		entries,
		options: {
			configuration: {
				routes: [{ mountPath, handler: handlerRelative }],
			},
		},
		middlewareUtil: createMiddlewareUtil(REPO_ROOT),
	};
}

describe("ws-mock middleware: wire layer (plain and PCP)", () => {
	it("logs handler load as verbose detail and the listening banner at info", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/echo.ts", "/ws/echo");
		await wsMock(args);
		fireHook(serverHandle.server);

		// The per-route load line is verbose detail (surfaced via `ui5 serve
		// --verbose`), not default-level noise; the listening banner stays at info.
		const loaded = args.entries.find(
			(e) => e.level === "verbose" && String(e.args[0]).includes("handler loaded"),
		);
		expect(loaded).toBeDefined();
		expect(
			args.entries.some(
				(e) => e.level === "info" && String(e.args[0]).includes("handler loaded"),
			),
		).toBe(false);

		const listening = args.entries.find(
			(e) => e.level === "info" && String(e.args[0]).includes("listening for upgrades"),
		);
		expect(listening).toBeDefined();
	});

	it("plain mode: ctx.send writes the message verbatim and onMessage receives raw strings", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/echo.ts", "/ws/echo");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/echo`);
		const ready = waitForMessages(ws, 1);
		await waitForOpen(ws);
		expect(ws.protocol).toBe("");

		const readyMsgs = await ready;
		expect(readyMsgs[0]).toBe("READY");

		const echoBack = waitForMessages(ws, 1);
		ws.send("foo");
		const echoMsgs = await echoBack;
		expect(echoMsgs[0]).toBe("ECHO:foo");

		ws.close();
	});

	it("PCP mode: ctx.send wraps in a default PCP frame and onMessage decodes inbound frames", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/echo.ts", "/ws/echo");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/echo`, "v10.pcp.sap.com");
		const ready = waitForMessages(ws, 1);
		await waitForOpen(ws);
		expect(ws.protocol).toBe("v10.pcp.sap.com");

		const readyMsgs = await ready;
		const readyDecoded = decode(readyMsgs[0]!);
		expect(readyDecoded.fields["pcp-action"]).toBe("MESSAGE");
		expect(readyDecoded.fields["pcp-body-type"]).toBe("text");
		expect(readyDecoded.body).toBe("READY");

		const echoBack = waitForMessages(ws, 1);
		ws.send(encode({ fields: { correlationId: "abc" }, body: "foo" }));
		const echoMsgs = await echoBack;
		const echoDecoded = decode(echoMsgs[0]!);
		expect(echoDecoded.body).toBe("ECHO:foo");

		ws.close();
	});

	it("PCP mode: ctx.send body is written verbatim with no JSON quoting", async () => {
		// Regression: previously ctx.send ran JSON.stringify(data), so a string
		// payload arrived on the wire wrapped in quotes (`"foo"` instead of
		// `foo`), which a real `SapPcpWebSocket` peer never undoes. The strict
		// equality below would fail under the old behavior because the body
		// would arrive as `ECHO:"foo"` (extra quotes from the stringify pass).
		const args = buildFactoryArgs("test/fixtures/handlers/echo.ts", "/ws/echo");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/echo`, "v10.pcp.sap.com");
		const ready = waitForMessages(ws, 1);
		await waitForOpen(ws);
		await ready;

		const reply = waitForMessages(ws, 1);
		ws.send(encode({ body: "foo" }));
		const replyMsgs = await reply;
		expect(decode(replyMsgs[0]!).body).toBe("ECHO:foo");

		ws.close();
	});

	it("PCP mode: bodies containing `:` and `\\n` round-trip unmodified (PCP escapes only headers, not bodies)", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/echo.ts", "/ws/echo");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/echo`, "v10.pcp.sap.com");
		const ready = waitForMessages(ws, 1);
		await waitForOpen(ws);
		await ready;

		const tricky = "k:v\nline2\\back";
		const reply = waitForMessages(ws, 1);
		ws.send(encode({ body: tricky }));
		const replyMsgs = await reply;
		expect(decode(replyMsgs[0]!).body).toBe(`ECHO:${tricky}`);

		ws.close();
	});

	it("PCP mode: ctx.send accepts EncodeOptions and emits a custom frame end-to-end", async () => {
		// Verifies the typed-send surface: `ctx.send` narrows to `string |
		// EncodeOptions` once `ctx.mode === "pcp"`, and the middleware calls
		// `encode()` internally so the handler never imports it.
		const args = buildFactoryArgs("test/fixtures/handlers/pcp-typed-send.ts", "/ws/typed");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/typed`, "v10.pcp.sap.com");
		const expectTwo = waitForMessages(ws, 2);
		await waitForOpen(ws);

		const [helloRaw, welcomeRaw] = await expectTwo;
		const hello = decode(helloRaw!);
		expect(hello.fields["pcp-action"]).toBe("MESSAGE");
		expect(hello.body).toBe("HELLO");

		const welcome = decode(welcomeRaw!);
		expect(welcome.fields["pcp-action"]).toBe("WELCOME");
		expect(welcome.fields["pcp-body-type"]).toBe("text");
		expect(welcome.fields["sessionId"]).toBe("abc-123");
		expect(welcome.body).toBe("hello, pcp");

		const pong = waitForMessages(ws, 1);
		ws.send(encode({ body: "PING" }));
		const [pongRaw] = await pong;
		const pongFrame = decode(pongRaw!);
		expect(pongFrame.fields["pcp-action"]).toBe("PONG");
		expect(pongFrame.body).toBe("");

		ws.close();
	});

	it("PCP mode: encode errors raised from ctx.send are caught by the handler-invocation wrapper", async () => {
		// `ctx.send({ fields: { "": "x" } })` triggers encode()'s empty-name
		// throw. The middleware does not swallow it inside `send`; the throw
		// propagates back through the `invoke` wrapper, which logs at error
		// and keeps the connection open.
		const args = buildFactoryArgs(
			"test/fixtures/handlers/pcp-send-bad-field.ts",
			"/ws/badfield",
		);
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(
			`ws://127.0.0.1:${serverHandle.port}/ws/badfield`,
			"v10.pcp.sap.com",
		);
		await waitForOpen(ws);

		await waitForLog(
			args.entries,
			(e) =>
				e.level === "error" &&
				String(e.args.join(" ")).includes("onConnect threw") &&
				String(e.args.join(" ")).includes("non-empty"),
		);
		expect(ws.readyState).toBe(WebSocket.OPEN);

		ws.close();
	});

	it("PCP mode: handlers can build custom PCP frames via encode + ctx.ws.send", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/echo.ts", "/ws/echo");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/echo`, "v10.pcp.sap.com");
		const ready = waitForMessages(ws, 1);
		await waitForOpen(ws);
		await ready;

		// Send a frame with custom action and extra fields; verify the handler
		// sees both via the decoded PcpFrame and that the body round-trips.
		const reply = waitForMessages(ws, 1);
		ws.send(encode({ action: "EVENT", fields: { name: "alice" }, body: "payload" }));
		const replyMsgs = await reply;
		expect(decode(replyMsgs[0]!).body).toBe("ECHO:payload");

		ws.close();
	});
});

describe("ws-mock middleware: handler resilience and inbound handling", () => {
	it("drops frames silently when no onMessage is defined", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/no-onmessage.ts", "/ws/no-onmessage");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/no-onmessage`);
		await waitForOpen(ws);

		ws.send("hello");
		await waitForLog(
			args.entries,
			(e) => e.level === "verbose" && String(e.args.join(" ")).includes("dropped frame"),
		);
		expect(ws.readyState).toBe(WebSocket.OPEN);

		ws.close();
	});

	it("warns when ctx.send is called on a non-open socket", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/close-then-send.ts", "/ws/closesend");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/closesend`);
		await new Promise<void>((resolve) => {
			ws.once("open", resolve);
			ws.once("close", () => resolve());
		});

		await waitForLog(
			args.entries,
			(e) => e.level === "warn" && String(e.args.join(" ")).includes("non-open socket"),
		);
	});

	it("logs onConnect throws without closing the connection", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/onconnect-throws.ts", "/ws/cthrow");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/cthrow`);
		await waitForOpen(ws);

		await waitForLog(
			args.entries,
			(e) => e.level === "error" && String(e.args.join(" ")).includes("onConnect threw"),
		);
		expect(ws.readyState).toBe(WebSocket.OPEN);

		ws.close();
	});

	it("swallows synchronous ws.send throws and keeps the connection alive", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/send-throws.ts", "/ws/sthrow");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/sthrow`);
		await waitForOpen(ws);

		await waitForLog(
			args.entries,
			(e) => e.level === "error" && String(e.args.join(" ")).includes("ws.send threw"),
		);
		expect(ws.readyState).toBe(WebSocket.OPEN);

		ws.close();
	});

	it("logs async handler rejections without closing the connection", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/throws-async.ts", "/ws/aboom");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/aboom`);
		await waitForOpen(ws);

		ws.send("trigger");
		await waitForLog(
			args.entries,
			(e) => e.level === "error" && String(e.args.join(" ")).includes("rejected"),
		);
		expect(ws.readyState).toBe(WebSocket.OPEN);

		ws.close();
	});

	it("logs sync handler throws without closing the connection", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/throws-sync.ts", "/ws/sboom");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/sboom`);
		await waitForOpen(ws);

		ws.send("trigger");
		await waitForLog(
			args.entries,
			(e) => e.level === "error" && String(e.args.join(" ")).includes("threw"),
		);
		expect(ws.readyState).toBe(WebSocket.OPEN);

		ws.close();
	});

	it("closes with 1011 when handler module fails to import", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/broken-import.ts", "/ws/broken");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/broken`);
		const closure = await new Promise<{ code: number; reason: string }>((resolve) => {
			ws.on("close", (code, reasonBuf) =>
				resolve({ code, reason: reasonBuf.toString("utf8") }),
			);
		});
		expect(closure.code).toBe(1011);
		expect(closure.reason).toContain("handler unavailable");
	});

	it("attaches an error listener even on refused connections, so a late ws error doesn't crash the process", async () => {
		// Regression: a 'error' emitted on a refused-connection ws (e.g. from
		// a malformed inbound frame racing the 1011 close) used to crash.
		const capturedSockets: WebSocket[] = [];
		const spy = vi
			.spyOn(WebSocketServer.prototype, "handleUpgrade")
			.mockImplementation(function (this: WebSocketServer, req, socket, head, cb) {
				const original = WebSocketServer.prototype.handleUpgrade;
				spy.mockRestore();
				original.call(this, req, socket, head, (ws, request) => {
					capturedSockets.push(ws);
					cb(ws, request);
				});
			});
		try {
			const args = buildFactoryArgs("test/fixtures/handlers/broken-import.ts", "/ws/broken");
			await wsMock(args);
			fireHook(serverHandle.server);

			const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/broken`);
			await new Promise<void>((resolve) => ws.on("close", () => resolve()));

			expect(capturedSockets.length).toBe(1);
			const serverSocket = capturedSockets[0]!;
			expect(serverSocket.listenerCount("error")).toBeGreaterThan(0);
			expect(() =>
				serverSocket.emit("error", new Error("synthetic post-close error")),
			).not.toThrow();
		} finally {
			spy.mockRestore();
		}
	});

	it("closes with 1011 when handler module has no default export", async () => {
		const args = buildFactoryArgs(
			"test/fixtures/handlers/no-default-export.ts",
			"/ws/no-default",
		);
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/no-default`);
		const closure = await new Promise<{ code: number; reason: string }>((resolve) => {
			ws.on("close", (code, reasonBuf) =>
				resolve({ code, reason: reasonBuf.toString("utf8") }),
			);
		});
		expect(closure.code).toBe(1011);
		expect(closure.reason).toContain("handler unavailable");
	});

	it("closes with 1011 even when the client offered the PCP subprotocol", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/broken-import.ts", "/ws/broken-pcp");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(
			`ws://127.0.0.1:${serverHandle.port}/ws/broken-pcp`,
			"v10.pcp.sap.com",
		);
		const closure = await new Promise<{ code: number; reason: string; protocol: string }>(
			(resolve) => {
				ws.on("close", (code, reasonBuf) =>
					resolve({
						code,
						reason: reasonBuf.toString("utf8"),
						protocol: ws.protocol,
					}),
				);
			},
		);
		expect(closure.protocol).toBe("v10.pcp.sap.com");
		expect(closure.code).toBe(1011);
		expect(closure.reason).toContain("handler unavailable");
	});

	it("forwards async onMessage results without spurious error logs", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/async-echo.ts", "/ws/async");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/async`);
		const ready = waitForMessages(ws, 1);
		await waitForOpen(ws);
		expect((await ready)[0]).toBe("READY");

		const echo = waitForMessages(ws, 1);
		ws.send("ping");
		expect((await echo)[0]).toBe("ECHO:ping");

		const errors = args.entries.filter((e) => e.level === "error");
		expect(errors).toEqual([]);

		ws.close();
	});

	it("PCP mode: header-less inbound frames decode as body-only and log a verbose warning", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/echo.ts", "/ws/echo");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/echo`, "v10.pcp.sap.com");
		const ready = waitForMessages(ws, 1);
		await waitForOpen(ws);
		await ready;

		// Per SapPcpWebSocket's fallback, decode of a header-less frame yields
		// { fields: {}, body: <raw> }, so the echo handler sees the raw bytes.
		const reply = waitForMessages(ws, 1);
		ws.send("just-a-body");
		expect(decode((await reply)[0]!).body).toBe("ECHO:just-a-body");

		await waitForLog(
			args.entries,
			(e) =>
				e.level === "verbose" &&
				String(e.args.join(" ")).includes("missing LFLF separator"),
		);

		ws.close();
	});

	it("plain mode: binary inbound frames are decoded as utf-8 and echoed back", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/echo.ts", "/ws/echo");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/echo`);
		const ready = waitForMessages(ws, 1);
		await waitForOpen(ws);
		await ready;

		const echo = waitForMessages(ws, 1);
		ws.send(Buffer.from("héllo", "utf8"));
		expect((await echo)[0]).toBe("ECHO:héllo");

		ws.close();
	});
});

describe("ws-mock middleware: routing, negotiation, and lifecycle", () => {
	it("isolates routes by mountPath and lets unrelated upgrades fall through", async () => {
		const { log, entries } = createCapturedLogger();
		await wsMock({
			log,
			options: {
				configuration: {
					routes: [
						{ mountPath: "/ws/a", handler: "test/fixtures/handlers/echo.ts" },
						{ mountPath: "/ws/b", handler: "test/fixtures/handlers/echo.ts" },
					],
				},
			},
			middlewareUtil: createMiddlewareUtil(REPO_ROOT),
		});
		fireHook(serverHandle.server);

		// Stand-in for a coexisting middleware (e.g. livereload's WS channel):
		// it completes the handshake for any path ws-mock didn't claim.
		const fallThrough = expectFallThrough(serverHandle.server, "/ws/c");

		// Route /ws/a accepts (handled by ws-mock).
		const wsA = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/a`);
		await waitForOpen(wsA);
		wsA.close();

		// Route /ws/c is not declared on ws-mock. Opening it should fall
		// through to the test-side listener, which completes the handshake
		// and then closes cleanly.
		const wsC = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/c`);
		await waitForOpen(wsC);
		const observedPath = await fallThrough.occurred;
		expect(observedPath).toBe("/ws/c");
		wsC.close();
		fallThrough.close();

		// Per-route connect log; the startup banner's "/ws/a" mention alone
		// would still pass even if isolation were broken.
		expect(
			entries.some(
				(e) =>
					e.level === "info" &&
					String(e.args[0]).includes("[ws-mock:/ws/a]") &&
					String(e.args.join(" ")).includes("connect"),
			),
		).toBe(true);
	});

	it("rejects clients offering only an unknown subprotocol", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/echo.ts", "/ws/echo");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(
			`ws://127.0.0.1:${serverHandle.port}/ws/echo`,
			"unknown.subprotocol.example",
		);
		const errored = await new Promise<boolean>((resolve) => {
			ws.once("error", () => resolve(true));
			ws.once("open", () => resolve(false));
		});
		expect(errored).toBe(true);
	});

	it("invokes onClose with code and reason from a clean close", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/notifications.ts", "/ws/notif");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/notif`);
		const hello = waitForMessages(ws, 1);
		await waitForOpen(ws);
		await hello;
		ws.close(1000, "bye");

		await waitForLog(
			args.entries,
			(e) => e.level === "info" && String(e.args.join(" ")).includes("disconnect 1000 bye"),
		);
	});

	it("ctx.terminate produces a 1006 close on the client and invokes onClose", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/notifications.ts", "/ws/notif");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/notif`);
		const hello = waitForMessages(ws, 1);
		await waitForOpen(ws);
		await hello;
		const closePromise = new Promise<number>((resolve) =>
			ws.on("close", (code) => resolve(code)),
		);
		ws.send("TERMINATE");
		const code = await closePromise;
		expect(code).toBe(1006);

		await waitForLog(
			args.entries,
			(e) => e.level === "info" && String(e.args.join(" ")).includes("disconnect 1006"),
		);
	});
});

describe("ws-mock middleware: parametrized mount paths", () => {
	// Builds factory args for a single parametrized route backed by the
	// params-echo fixture, which sends `JSON.stringify(ctx.params)` on connect.
	function paramsRoute(mountPath: string) {
		const { log, entries } = createCapturedLogger();
		return {
			log,
			entries,
			options: {
				configuration: {
					routes: [{ mountPath, handler: "test/fixtures/handlers/params-echo.ts" }],
				},
			},
			middlewareUtil: createMiddlewareUtil(REPO_ROOT),
		};
	}

	// Connects, reads the single connect frame, and returns the parsed params.
	async function connectAndReadParams(path: string): Promise<Record<string, string | string[]>> {
		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}${path}`);
		const ready = waitForMessages(ws, 1);
		await waitForOpen(ws);
		const [raw] = await ready;
		ws.close();
		return JSON.parse(raw!) as Record<string, string | string[]>;
	}

	it("a literal mountPath still matches and yields empty params", async () => {
		const args = paramsRoute("/ws/echo");
		await wsMock(args);
		fireHook(serverHandle.server);

		expect(await connectAndReadParams("/ws/echo")).toEqual({});
	});

	it("matching is case-sensitive: a differently cased pathname is left for other middleware", async () => {
		// `path-to-regexp` defaults to case-insensitive; the middleware compiles
		// with `sensitive: true` to preserve the pre-parametrized exact-match
		// behavior. A `/WS/ECHO` upgrade must therefore NOT be claimed by the
		// `/ws/echo` route — it falls through to a coexisting listener (stand-in
		// for another middleware). Without `sensitive: true` ws-mock would claim
		// it and the fixture would reply with params, so this would hang/fail.
		const args = paramsRoute("/ws/echo");
		await wsMock(args);
		fireHook(serverHandle.server);

		const fallThrough = expectFallThrough(serverHandle.server, "/WS/ECHO");

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/WS/ECHO`);
		await waitForOpen(ws);
		expect(await fallThrough.occurred).toBe("/WS/ECHO");
		ws.close();
		fallThrough.close();
	});

	it("a trailing slash is tolerated: /ws/echo also matches /ws/echo/", async () => {
		// Trailing-slash tolerance is the documented `path-to-regexp` default and
		// is deliberately kept (only case-sensitivity is overridden). A `/ws/echo/`
		// upgrade must be claimed by the `/ws/echo` route and yield empty params.
		const args = paramsRoute("/ws/echo");
		await wsMock(args);
		fireHook(serverHandle.server);

		expect(await connectAndReadParams("/ws/echo/")).toEqual({});
	});

	it("a single named parameter is extracted onto ctx.params", async () => {
		const args = paramsRoute("/ws/notifications/:userId");
		await wsMock(args);
		fireHook(serverHandle.server);

		expect(await connectAndReadParams("/ws/notifications/42")).toEqual({ userId: "42" });
	});

	it("percent-encoded parameter values are decoded", async () => {
		const args = paramsRoute("/ws/u/:name");
		await wsMock(args);
		fireHook(serverHandle.server);

		// %C3%A9 -> é; the matcher decodes via decodeURIComponent.
		expect(await connectAndReadParams("/ws/u/caf%C3%A9")).toEqual({ name: "café" });
	});

	it("an optional segment is present when supplied and absent otherwise", async () => {
		const args = paramsRoute("/ws/feed{/:topic}");
		await wsMock(args);
		fireHook(serverHandle.server);

		expect(await connectAndReadParams("/ws/feed/news")).toEqual({ topic: "news" });
		expect(await connectAndReadParams("/ws/feed")).toEqual({});
	});

	it("a named wildcard captures the remaining segments as a string array", async () => {
		const args = paramsRoute("/ws/files/*splat");
		await wsMock(args);
		fireHook(serverHandle.server);

		expect(await connectAndReadParams("/ws/files/a/b/c")).toEqual({ splat: ["a", "b", "c"] });
	});

	it("routes match in declaration order: an earlier parametrized route shadows a later literal one", async () => {
		// Declaration order: the parametrized `/ws/:kind` precedes the literal
		// `/ws/exact`. First-match-wins means a request for `/ws/exact` is served
		// by the parametrized route (params { kind: "exact" }), not the literal
		// one (whose echo handler would have replied READY).
		const { log } = createCapturedLogger();
		await wsMock({
			log,
			options: {
				configuration: {
					routes: [
						{
							mountPath: "/ws/:kind",
							handler: "test/fixtures/handlers/params-echo.ts",
						},
						{ mountPath: "/ws/exact", handler: "test/fixtures/handlers/echo.ts" },
					],
				},
			},
			middlewareUtil: createMiddlewareUtil(REPO_ROOT),
		});
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/exact`);
		const ready = waitForMessages(ws, 1);
		await waitForOpen(ws);
		const [raw] = await ready;
		expect(JSON.parse(raw!)).toEqual({ kind: "exact" });

		ws.close();
	});

	it("a pathname matching no route is left for other middleware (silent pass-through)", async () => {
		const args = paramsRoute("/ws/notifications/:userId");
		await wsMock(args);
		fireHook(serverHandle.server);

		// A coexisting upgrade listener (stand-in for another middleware) that
		// completes the handshake for the unmatched path. If ws-mock falls
		// through cleanly, this listener observes the upgrade.
		const fallThrough = expectFallThrough(serverHandle.server, "/ws/unrelated");

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/unrelated`);
		await waitForOpen(ws);
		expect(await fallThrough.occurred).toBe("/ws/unrelated");
		ws.close();
		fallThrough.close();
	});

	it("a malformed percent-encoded pathname is skipped without crashing (logs verbose, falls through)", async () => {
		const args = paramsRoute("/ws/u/:name");
		await wsMock(args);
		fireHook(serverHandle.server);

		// ws-mock falls through on the unmatched (malformed) path, leaving the
		// socket half-open. A trailing upgrade listener destroys it so the
		// server can close cleanly in afterEach; it runs after ws-mock's listener.
		serverHandle.server.on("upgrade", (req, socket) => {
			if ((req.url ?? "").includes("%ZZ")) socket.destroy();
		});

		// `%ZZ` is an invalid escape; the matcher's decodeURIComponent throws.
		// matchRoute swallows it, logs at verbose, and returns no match.
		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/u/%ZZ`);
		ws.on("error", () => {});

		await waitForLog(
			args.entries,
			(e) =>
				e.level === "verbose" &&
				String(e.args.join(" ")).includes("malformed percent-encoding"),
		);
	});

	it("an invalid mountPath pattern is disabled at startup with an error log and never matches", async () => {
		// Legacy `:opt?` syntax is rejected by path-to-regexp v8 (optionality is
		// `{...}`). The route compiles to null, is logged at error, and the
		// factory still resolves; the handler itself loads fine.
		const args = paramsRoute("/ws/:bad?");
		await wsMock(args);
		fireHook(serverHandle.server);

		const disabled = args.entries.find(
			(e) =>
				e.level === "error" &&
				String(e.args.join(" ")).includes("invalid mountPath pattern"),
		);
		expect(disabled).toBeDefined();

		// ...and at upgrade time the disabled route is skipped by matchRoute, so
		// a connection falls through to other middleware rather than being claimed
		// (or crashing). A coexisting listener stands in for that other middleware.
		const fallThrough = expectFallThrough(serverHandle.server, "/ws/anything");

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/anything`);
		await waitForOpen(ws);
		expect(await fallThrough.occurred).toBe("/ws/anything");
		ws.close();
		fallThrough.close();
	});

	it("logs the matched pathname and extracted params on the connect line", async () => {
		const args = paramsRoute("/ws/notifications/:userId");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/notifications/42`);
		await waitForOpen(ws);

		await waitForLog(
			args.entries,
			(e) =>
				e.level === "info" &&
				String(e.args.join(" ")).includes("connect") &&
				String(e.args.join(" ")).includes("path=/ws/notifications/42") &&
				String(e.args.join(" ")).includes(`"userId":"42"`),
		);

		ws.close();
	});

	it("omits the params suffix from the connect line for a literal route", async () => {
		// A literal mountPath yields empty params, so the connect line carries the
		// path but no `params=` noise.
		const args = paramsRoute("/ws/echo");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/echo`);
		await waitForOpen(ws);

		await waitForLog(
			args.entries,
			(e) =>
				e.level === "info" &&
				String(e.args.join(" ")).includes("connect (mode=") &&
				String(e.args.join(" ")).includes("path=/ws/echo"),
		);
		const connectLine = args.entries.find(
			(e) => e.level === "info" && String(e.args.join(" ")).includes("connect (mode="),
		);
		expect(String(connectLine?.args.join(" "))).not.toContain("params=");

		ws.close();
	});

	it("warns that a mountPath without a static prefix breaks coexistence", async () => {
		// `/{*splat}` matches every upgrade path from the root, so it would claim
		// upgrades meant for other listeners (livereload). The scoped route is
		// declared first so the catch-all (last) does not also trip the shadow
		// warning, isolating the prefix check to exactly one entry.
		const { log, entries } = createCapturedLogger();
		await wsMock({
			log,
			options: {
				configuration: {
					routes: [
						{ mountPath: "/ws/scoped", handler: "test/fixtures/handlers/echo.ts" },
						{ mountPath: "/{*splat}", handler: "test/fixtures/handlers/echo.ts" },
					],
				},
			},
			middlewareUtil: createMiddlewareUtil(REPO_ROOT),
		});

		const warned = entries.filter(
			(e) =>
				e.level === "warn" &&
				String(e.args.join(" ")).includes("no leading static segment"),
		);
		expect(warned).toHaveLength(1);
		expect(String(warned[0]!.args.join(" "))).toContain("[ws-mock:/{*splat}]");
	});

	it("warns that a route shadowed by an earlier pattern is unreachable", async () => {
		// Declaration order puts the broad `/ws/:kind` before the specific
		// `/ws/exact`; first-match-wins makes the literal route dead.
		const { log, entries } = createCapturedLogger();
		await wsMock({
			log,
			options: {
				configuration: {
					routes: [
						{
							mountPath: "/ws/:kind",
							handler: "test/fixtures/handlers/params-echo.ts",
						},
						{ mountPath: "/ws/exact", handler: "test/fixtures/handlers/echo.ts" },
					],
				},
			},
			middlewareUtil: createMiddlewareUtil(REPO_ROOT),
		});

		const shadow = entries.find(
			(e) =>
				e.level === "warn" &&
				String(e.args.join(" ")).includes("[ws-mock:/ws/exact]") &&
				String(e.args.join(" ")).includes("unreachable") &&
				String(e.args.join(" ")).includes("/ws/:kind"),
		);
		expect(shadow).toBeDefined();
		// The earlier broad route itself is reachable and not flagged.
		const falsePositive = entries.find(
			(e) =>
				e.level === "warn" &&
				String(e.args.join(" ")).includes("[ws-mock:/ws/:kind]") &&
				String(e.args.join(" ")).includes("unreachable"),
		);
		expect(falsePositive).toBeUndefined();
	});

	it("does not warn about shadowing for disjoint sibling routes", async () => {
		// `/ws/a` and `/ws/b` cannot match the same path; neither shadows the
		// other, so the heuristic must stay silent (no false positives).
		const { log, entries } = createCapturedLogger();
		await wsMock({
			log,
			options: {
				configuration: {
					routes: [
						{ mountPath: "/ws/a", handler: "test/fixtures/handlers/echo.ts" },
						{ mountPath: "/ws/b", handler: "test/fixtures/handlers/echo.ts" },
					],
				},
			},
			middlewareUtil: createMiddlewareUtil(REPO_ROOT),
		});

		const shadow = entries.find(
			(e) => e.level === "warn" && String(e.args.join(" ")).includes("unreachable"),
		);
		expect(shadow).toBeUndefined();
	});

	it("warns when a mountPath declares duplicate parameter names", async () => {
		// path-to-regexp v8 compiles `/ws/:id/:id` without error but keeps only
		// the last `:id`, silently dropping the first segment's value.
		const args = paramsRoute("/ws/:id/:id");
		await wsMock(args);

		const dup = args.entries.find(
			(e) =>
				e.level === "warn" &&
				String(e.args.join(" ")).includes("duplicate parameter name") &&
				String(e.args.join(" ")).includes("id"),
		);
		expect(dup).toBeDefined();
	});
});

describe("ws-mock middleware: configuration and handler resolution", () => {
	it("warns when no routes are configured", async () => {
		const { log, entries } = createCapturedLogger();
		await wsMock({
			log,
			options: { configuration: { routes: [] } },
			middlewareUtil: createMiddlewareUtil(REPO_ROOT),
		});
		// Fire the hook so the empty-mountPaths fallback ("(none)") path runs.
		fireHook(serverHandle.server);
		const warning = entries.find(
			(e) => e.level === "warn" && String(e.args.join(" ")).includes("no routes configured"),
		);
		expect(warning).toBeDefined();
		const listening = entries.find(
			(e) => e.level === "info" && String(e.args.join(" ")).includes("(none)"),
		);
		expect(listening).toBeDefined();
	});

	it("warns when duplicate mountPaths are declared and the earlier route wins (first-match-wins)", async () => {
		const { log, entries } = createCapturedLogger();
		await wsMock({
			log,
			options: {
				configuration: {
					routes: [
						{
							mountPath: "/ws/dup",
							handler: "test/fixtures/handlers/notifications.ts",
						},
						{
							mountPath: "/ws/dup",
							handler: "test/fixtures/handlers/echo.ts",
						},
					],
				},
			},
			middlewareUtil: createMiddlewareUtil(REPO_ROOT),
		});
		fireHook(serverHandle.server);

		const warning = entries.find(
			(e) => e.level === "warn" && String(e.args.join(" ")).includes("duplicate mountPath"),
		);
		expect(warning).toBeDefined();

		// Routes match in declaration order, first-match-wins, so the earlier
		// route (notifications.ts) wins and the later echo.ts entry is shadowed.
		// notifications.ts's onConnect sends HELLO, not echo.ts's READY, so
		// observing HELLO confirms the earlier route serviced the connection.
		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/dup`);
		const first = waitForMessages(ws, 1);
		await waitForOpen(ws);
		const messages = await first;
		expect(messages[0]).toBe("HELLO");

		ws.close();
	});

	it("warns when configuration is omitted entirely", async () => {
		const { log, entries } = createCapturedLogger();
		await wsMock({
			log,
			options: {},
			middlewareUtil: createMiddlewareUtil(REPO_ROOT),
		});
		const warning = entries.find(
			(e) => e.level === "warn" && String(e.args.join(" ")).includes("no routes configured"),
		);
		expect(warning).toBeDefined();
	});

	// Regression: `@ui5/logger`'s Logger is a class whose level methods read
	// `this` (`this._emitOrLog`). Pulling a method out and calling it bare
	// strips the receiver and crashes with `Cannot read properties of
	// undefined (reading '_emitOrLog')`. The capture-helper logger is built
	// from arrow functions so it never tripped this; the class-based logger
	// below exercises the receiver requirement.
	it("defaults handler resolution to the project's source path: a bare handler under sourcePath roundtrips a WebSocket connection", async () => {
		// Set sourcePath to <repo>/test and configure a bare handler relative
		// to it. If resolution defaults to the source path (correct), the echo
		// handler loads and the client receives READY + ECHO:ping. If it ever
		// fell back to the project root, '<repo>/fixtures/handlers/echo.ts'
		// would not exist and the upgrade would be refused with close code 1011.
		const sourcePath = resolvePath(REPO_ROOT, "test");
		const { log } = createCapturedLogger();
		await wsMock({
			log,
			options: {
				configuration: {
					routes: [{ mountPath: "/ws/srcdef", handler: "fixtures/handlers/echo.ts" }],
				},
			},
			middlewareUtil: createMiddlewareUtil(REPO_ROOT, sourcePath),
		});
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/srcdef`);
		const ready = waitForMessages(ws, 1);
		await waitForOpen(ws);
		expect((await ready)[0]).toBe("READY");

		const echoBack = waitForMessages(ws, 1);
		ws.send("ping");
		expect((await echoBack)[0]).toBe("ECHO:ping");

		ws.close();
	});

	it("configuration.rootPath rebases handler resolution from the project root and overrides the source path", async () => {
		// sourcePath is intentionally wrong (no 'webapp/' in this repo). The
		// handler value is given relative to rootPath: "test/fixtures". If the
		// override weren't honored, the load would fail and the upgrade close.
		const wrongSourcePath = resolvePath(REPO_ROOT, "webapp");
		const { log } = createCapturedLogger();
		await wsMock({
			log,
			options: {
				configuration: {
					rootPath: "test/fixtures",
					routes: [{ mountPath: "/ws/rooted", handler: "handlers/echo.ts" }],
				},
			},
			middlewareUtil: createMiddlewareUtil(REPO_ROOT, wrongSourcePath),
		});
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/rooted`);
		const ready = waitForMessages(ws, 1);
		await waitForOpen(ws);
		expect((await ready)[0]).toBe("READY");

		ws.close();
	});

	it("Module-type projects: factory rejects when getSourcePath throws and no rootPath is configured", async () => {
		// In @ui5/project v4, only the Module Project type throws from
		// getSourcePath (Application returns webapp/, Library/ThemeLibrary
		// return src/). The throw must propagate so the misconfiguration
		// surfaces loudly; the documented escape hatch is configuration.rootPath.
		const getSourcePath = vi.fn(() => {
			throw new Error("Projects of type module have more than one source path");
		});
		await expect(
			wsMock({
				log: createCapturedLogger().log,
				options: {
					configuration: {
						// Handler value is irrelevant; resolution throws before
						// any handler module is touched.
						routes: [{ mountPath: "/ws/throws", handler: "irrelevant.ts" }],
					},
				},
				middlewareUtil: {
					getProject: () => ({
						getRootPath: () => REPO_ROOT,
						getSourcePath,
					}),
				},
			}),
		).rejects.toThrow(/more than one source path/);
		expect(getSourcePath).toHaveBeenCalledTimes(1);
	});

	it("Module-type projects: rootPath override skips getSourcePath and the handler is reachable", async () => {
		// Companion to the previous test: with rootPath set, getSourcePath()
		// must never be called, so a project type that throws from it still
		// loads cleanly. Proves both with a spy (call count == 0) and an
		// end-to-end WebSocket roundtrip.
		const getSourcePath = vi.fn(() => {
			throw new Error("Projects of type module have more than one source path");
		});
		const { log } = createCapturedLogger();
		await wsMock({
			log,
			options: {
				configuration: {
					rootPath: "test/fixtures",
					routes: [{ mountPath: "/ws/escaped", handler: "handlers/echo.ts" }],
				},
			},
			middlewareUtil: {
				getProject: () => ({
					getRootPath: () => REPO_ROOT,
					getSourcePath,
				}),
			},
		});
		expect(getSourcePath).not.toHaveBeenCalled();
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/escaped`);
		const ready = waitForMessages(ws, 1);
		await waitForOpen(ws);
		expect((await ready)[0]).toBe("READY");

		ws.close();
	});

	it("empty routes is a no-op: factory resolves on a Module-type project without calling getSourcePath", async () => {
		// Behavioral guarantee: a middleware declaration with zero routes (a
		// documented no-op) must not crash on Module-type projects. The shape
		// of that crash, pre-fix, was an eager call into getSourcePath() that
		// threw. We assert (a) the factory resolves cleanly, (b) the spy is
		// never invoked. Whether getProject()/getRootPath() are called too is
		// an implementation detail we don't bind to.
		const getSourcePath = vi.fn(() => {
			throw new Error("Projects of type module have more than one source path");
		});
		await expect(
			wsMock({
				log: createCapturedLogger().log,
				options: { configuration: { routes: [] } },
				middlewareUtil: {
					getProject: () => ({
						getRootPath: () => REPO_ROOT,
						getSourcePath,
					}),
				},
			}),
		).resolves.toBeDefined();
		expect(getSourcePath).not.toHaveBeenCalled();
	});

	it("the listening banner lists only routes that compiled (disabled routes excluded)", async () => {
		// `/ws/:bad?` fails to compile (v8 rejects `?`), so it is disabled and
		// never listens; the banner must advertise only the live `/ws/ok` route.
		const { log, entries } = createCapturedLogger();
		await wsMock({
			log,
			options: {
				configuration: {
					routes: [
						{ mountPath: "/ws/ok", handler: "test/fixtures/handlers/echo.ts" },
						{ mountPath: "/ws/:bad?", handler: "test/fixtures/handlers/echo.ts" },
					],
				},
			},
			middlewareUtil: createMiddlewareUtil(REPO_ROOT),
		});
		fireHook(serverHandle.server);

		const banner = entries.find(
			(e) =>
				e.level === "info" &&
				String(e.args.join(" ")).includes("listening for upgrades on"),
		);
		expect(banner).toBeDefined();
		const text = String(banner!.args.join(" "));
		expect(text).toContain("/ws/ok");
		expect(text).not.toContain(":bad?");
	});
});

describe("ws-mock middleware: logging and error notification", () => {
	it("ctx.log.verbose invokes the host logger's verbose method with the correct `this`", async () => {
		const calls: { level: string; args: unknown[]; this: unknown }[] = [];
		class ClassLogger {
			private readonly state = "logger-instance";
			silly(...args: unknown[]): void {
				if (this.state !== "logger-instance") throw new TypeError("silly: bad this");
				calls.push({ level: "silly", args, this: this });
			}
			verbose(...args: unknown[]): void {
				if (this.state !== "logger-instance") throw new TypeError("verbose: bad this");
				calls.push({ level: "verbose", args, this: this });
			}
			perf(...args: unknown[]): void {
				if (this.state !== "logger-instance") throw new TypeError("perf: bad this");
				calls.push({ level: "perf", args, this: this });
			}
			info(...args: unknown[]): void {
				if (this.state !== "logger-instance") throw new TypeError("info: bad this");
				calls.push({ level: "info", args, this: this });
			}
			warn(...args: unknown[]): void {
				if (this.state !== "logger-instance") throw new TypeError("warn: bad this");
				calls.push({ level: "warn", args, this: this });
			}
			error(...args: unknown[]): void {
				if (this.state !== "logger-instance") throw new TypeError("error: bad this");
				calls.push({ level: "error", args, this: this });
			}
		}
		const classLog = new ClassLogger();
		await wsMock({
			log: classLog,
			options: {
				configuration: {
					routes: [
						{
							mountPath: "/ws/no-onmessage",
							handler: "test/fixtures/handlers/no-onmessage.ts",
						},
					],
				},
			},
			middlewareUtil: createMiddlewareUtil(REPO_ROOT),
		});
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/no-onmessage`);
		await waitForOpen(ws);
		ws.send("hello");
		await vi.waitFor(() =>
			expect(
				calls.find(
					(c) =>
						c.level === "verbose" && String(c.args.join(" ")).includes("dropped frame"),
				),
			).toBeDefined(),
		);
		const verboseCall = calls.find((c) => c.level === "verbose");
		expect(verboseCall?.this).toBe(classLog);

		ws.close();
	});

	it("onError fires for synchronous handler throws", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/onerror-sync-throw.ts", "/ws/oesync");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/oesync`);
		await waitForOpen(ws);
		ws.send("trigger");

		await waitForLog(
			args.entries,
			(e) =>
				e.level === "info" && String(e.args.join(" ")).includes("onError:sync sync-boom"),
		);
		expect(ws.readyState).toBe(WebSocket.OPEN);

		ws.close();
	});

	it("onError fires for asynchronous handler rejections", async () => {
		const args = buildFactoryArgs(
			"test/fixtures/handlers/onerror-async-reject.ts",
			"/ws/oeasync",
		);
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/oeasync`);
		await waitForOpen(ws);
		ws.send("trigger");

		await waitForLog(
			args.entries,
			(e) =>
				e.level === "info" && String(e.args.join(" ")).includes("onError:async async-boom"),
		);
		expect(ws.readyState).toBe(WebSocket.OPEN);

		ws.close();
	});

	it("onError fires for transport-level ws 'error' events", async () => {
		const args = buildFactoryArgs(
			"test/fixtures/handlers/onerror-socket-error.ts",
			"/ws/oesock",
		);
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/oesock`);
		// Swallow the client-side error that surfaces when the server closes the
		// connection with 1002; an unhandled `'error'` would crash the test.
		ws.on("error", () => {});
		await waitForOpen(ws);

		// RFC 6455 §5.1: clients MUST mask every frame. Bypass ws's masking by
		// writing raw bytes to the underlying TCP socket: FIN=1, opcode=text(1)
		// (0x81), MASK=0, payload-len=2 (0x02), body=`hi` (0x68 0x69). The
		// server's receiver detects the missing MASK bit and emits `'error'` on
		// the server-side WebSocket, which our listener surfaces through
		// `onError` before the server closes with 1002.
		const unmaskedTextFrame = Buffer.from([0x81, 0x02, 0x68, 0x69]);
		// ws exposes the underlying TCP socket as `_socket`; there is no public alternative.
		// oxlint-disable-next-line no-underscore-dangle
		const clientSocket = (ws as unknown as { _socket: import("node:net").Socket })._socket;
		clientSocket.write(unmaskedTextFrame);

		await waitForLog(
			args.entries,
			(e) => e.level === "info" && String(e.args.join(" ")).includes("onError:socket"),
		);
		const sawSocketErrorLog = args.entries.some(
			(e) => e.level === "error" && String(e.args.join(" ")).includes("socket error:"),
		);
		expect(sawSocketErrorLog).toBe(true);
	});

	it("onError fires when ctx.send's encode() throws (PCP empty field name)", async () => {
		const args = buildFactoryArgs(
			"test/fixtures/handlers/onerror-encode-throw.ts",
			"/ws/oeencode",
		);
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(
			`ws://127.0.0.1:${serverHandle.port}/ws/oeencode`,
			"v10.pcp.sap.com",
		);
		await waitForOpen(ws);

		await waitForLog(
			args.entries,
			(e) =>
				e.level === "info" &&
				String(e.args.join(" ")).includes("onError:encode") &&
				String(e.args.join(" ")).includes("non-empty"),
		);
		expect(ws.readyState).toBe(WebSocket.OPEN);

		ws.close();
	});

	// Regression: adding a `wsClientError` listener silences ws's default
	// `abortHandshake` call (see abortHandshakeOrEmitwsClientError in
	// node_modules/ws/lib/websocket-server.js). Once we listen, we own the
	// cleanup; if we only log, the TCP socket dangles. These tests send
	// malformed upgrades from raw TCP and verify the socket closes within a
	// tight window (a regression manifests as the close-race losing to the
	// fallback timer).
	async function probeMalformedUpgrade(rawRequest: string): Promise<{
		response: string;
		closedInMs: number;
		destroyed: boolean;
	}> {
		const sock = netConnect({ host: "127.0.0.1", port: serverHandle.port });
		await new Promise<void>((resolve, reject) => {
			sock.once("connect", () => resolve());
			sock.once("error", reject);
		});
		const start = Date.now();
		const chunks: Buffer[] = [];
		sock.on("data", (c) => chunks.push(c));
		sock.write(rawRequest);

		const closeRace = await Promise.race([
			new Promise<"closed">((resolve) => sock.once("close", () => resolve("closed"))),
			new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1000)),
		]);
		if (closeRace === "timeout") {
			sock.destroy();
			throw new Error(
				"socket did not close within 1s: wsClientError listener leaked the socket",
			);
		}
		return {
			response: Buffer.concat(chunks).toString("utf8"),
			closedInMs: Date.now() - start,
			destroyed: sock.destroyed,
		};
	}

	it("pre-handshake error (missing Sec-WebSocket-Key) logs and closes the socket fast", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/echo.ts", "/ws/echo");
		await wsMock(args);
		fireHook(serverHandle.server);

		const result = await probeMalformedUpgrade(
			"GET /ws/echo HTTP/1.1\r\n" +
				"Host: 127.0.0.1\r\n" +
				"Upgrade: websocket\r\n" +
				"Connection: Upgrade\r\n" +
				"Sec-WebSocket-Version: 13\r\n" +
				"\r\n",
		);

		expect(result.response).toMatch(/^HTTP\/1\.1 400\b/);
		expect(result.response).toMatch(/Sec-WebSocket-Key/);
		expect(result.destroyed).toBe(true);
		expect(result.closedInMs).toBeLessThan(500);

		await waitForLog(
			args.entries,
			(e) =>
				e.level === "warn" &&
				String(e.args.join(" ")).includes("pre-handshake client error"),
		);
	});

	it("pre-handshake error (non-GET method) also closes the socket without leaking", async () => {
		// Distinct ws code path from the missing-key case (abortHandshakeOrEmit
		// is called from a different call site for `req.method !== 'GET'`).
		const args = buildFactoryArgs("test/fixtures/handlers/echo.ts", "/ws/echo");
		await wsMock(args);
		fireHook(serverHandle.server);

		const result = await probeMalformedUpgrade(
			"POST /ws/echo HTTP/1.1\r\n" +
				"Host: 127.0.0.1\r\n" +
				"Upgrade: websocket\r\n" +
				"Connection: Upgrade\r\n" +
				"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
				"Sec-WebSocket-Version: 13\r\n" +
				"\r\n",
		);

		expect(result.response).toMatch(/^HTTP\/1\.1 400\b/);
		expect(result.destroyed).toBe(true);
		expect(result.closedInMs).toBeLessThan(500);
	});

	it("onError throws are logged and do not re-enter the hook", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/onerror-throws.ts", "/ws/oeloop");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/oeloop`);
		await waitForOpen(ws);
		ws.send("trigger");

		await waitForLog(
			args.entries,
			(e) => e.level === "error" && String(e.args.join(" ")).includes("onError threw"),
		);
		// `onMessage threw` (original) and `onError threw` (hook) each fire
		// exactly once. If recursion leaked, multiple `onError threw` lines
		// would appear.
		const onErrorThrewCount = args.entries.filter(
			(e) => e.level === "error" && String(e.args.join(" ")).includes("onError threw"),
		).length;
		expect(onErrorThrewCount).toBe(1);
		expect(ws.readyState).toBe(WebSocket.OPEN);

		ws.close();
	});
});

describe("ws-mock middleware: ctx.data bag", () => {
	it("ctx.data starts empty and persists across onConnect and onMessage frames", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/counter-data.ts", "/ws/counter");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/counter`);
		const ready = waitForMessages(ws, 1);
		await waitForOpen(ws);
		// onConnect observed the bag the middleware created: an empty object.
		expect((await ready)[0]).toBe("init:empty=true");

		// Three frames; the count survives because every callback shares one bag.
		const counts = waitForMessages(ws, 3);
		ws.send("a");
		ws.send("b");
		ws.send("c");
		expect(await counts).toEqual(["count=1", "count=2", "count=3"]);

		ws.close();
	});

	it("ctx.data is isolated per connection", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/counter-data.ts", "/ws/counter");
		await wsMock(args);
		fireHook(serverHandle.server);

		const wsA = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/counter`);
		const readyA = waitForMessages(wsA, 1);
		await waitForOpen(wsA);
		await readyA;

		const wsB = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/counter`);
		const readyB = waitForMessages(wsB, 1);
		await waitForOpen(wsB);
		await readyB;

		// A advances twice; B's bag must be untouched and start fresh at 1.
		const aCounts = waitForMessages(wsA, 2);
		wsA.send("x");
		wsA.send("y");
		expect(await aCounts).toEqual(["count=1", "count=2"]);

		const bCount = waitForMessages(wsB, 1);
		wsB.send("x");
		expect(await bCount).toEqual(["count=1"]);

		wsA.close();
		wsB.close();
	});

	it("the same ctx.data reaches the onClose hook", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/counter-data.ts", "/ws/counter");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/counter`);
		const ready = waitForMessages(ws, 1);
		await waitForOpen(ws);
		await ready;

		const counts = waitForMessages(ws, 2);
		ws.send("a");
		ws.send("b");
		await counts;

		ws.close();
		// onClose reads ctx.data.count and logs it; the value proves the close
		// hook saw the same bag the message frames mutated.
		await waitForLog(
			args.entries,
			(e) => e.level === "info" && String(e.args.join(" ")).includes("final count=2"),
		);
	});
});

describe("ws-mock middleware: defensive paths (non-feature)", () => {
	it("a synchronous ws.close throw is caught and logged at warn (connection survives)", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/close-throws.ts", "/ws/cthrow");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/cthrow`);
		ws.on("error", () => {});
		await waitForOpen(ws);

		await waitForLog(
			args.entries,
			(e) => e.level === "warn" && String(e.args.join(" ")).includes("ws.close threw"),
		);

		ws.terminate();
	});

	it("a synchronous ws.terminate throw is caught and logged at warn", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/terminate-throws.ts", "/ws/tthrow");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/tthrow`);
		ws.on("error", () => {});
		await waitForOpen(ws);

		await waitForLog(
			args.entries,
			(e) => e.level === "warn" && String(e.args.join(" ")).includes("ws.terminate threw"),
		);

		ws.terminate();
	});

	it("inbound ArrayBuffer frames are normalized to utf-8 (binaryType=arraybuffer)", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/echo-binarytype.ts", "/ws/bin");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/bin?bt=arraybuffer`);
		await waitForOpen(ws);
		const echo = waitForMessages(ws, 1);
		ws.send(Buffer.from("héllo", "utf8"));
		expect((await echo)[0]).toBe("ECHO:héllo");

		ws.close();
	});

	it("inbound fragmented (Buffer[]) frames are normalized to utf-8 (binaryType=fragments)", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/echo-binarytype.ts", "/ws/bin");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/bin?bt=fragments`);
		await waitForOpen(ws);
		const echo = waitForMessages(ws, 1);
		ws.send(Buffer.from("héllo", "utf8"));
		expect((await echo)[0]).toBe("ECHO:héllo");

		ws.close();
	});

	it("the scoped logger forwards every level to the host logger with the route prefix", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/log-levels.ts", "/ws/loglevels");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/loglevels`);
		await waitForOpen(ws);

		const prefix = "[ws-mock:/ws/loglevels]";
		// silly and perf have no other call site in the middleware; assert all six
		// levels reach the host logger and carry the route prefix as the first arg.
		for (const [level, line] of [
			["silly", "silly-line"],
			["perf", "perf-line"],
			["verbose", "verbose-line"],
			["info", "info-line"],
			["warn", "warn-line"],
			["error", "error-line"],
		] as const) {
			await waitForLog(
				args.entries,
				(e) => e.level === level && e.args[0] === prefix && e.args.includes(line),
			);
		}

		ws.close();
	});
});
