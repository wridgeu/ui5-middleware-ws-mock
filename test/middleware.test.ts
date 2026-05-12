import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolve as resolvePath } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import {
	startServer,
	fireHook,
	resetHookCapture,
	setHookCapture,
	createMiddlewareUtil,
} from "./helpers/server.js";
import { createCapturedLogger } from "./helpers/logger.js";
import { waitForLog, waitForMessages } from "./helpers/wait.js";
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

describe("ws-mock middleware", () => {
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

	it("reports handler load and listens on the mountPath", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/echo.ts", "/ws/echo");
		await wsMock(args);
		fireHook(serverHandle.server);

		const loaded = args.entries.find(
			(e) => e.level === "info" && String(e.args[0]).includes("handler loaded"),
		);
		expect(loaded).toBeDefined();

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
		await new Promise<void>((resolve) => ws.once("open", resolve));
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
		await new Promise<void>((resolve) => ws.once("open", resolve));
		expect(ws.protocol).toBe("v10.pcp.sap.com");

		const readyMsgs = await ready;
		const readyDecoded = decode(readyMsgs[0]!);
		expect(readyDecoded.pcpFields["pcp-action"]).toBe("MESSAGE");
		expect(readyDecoded.pcpFields["pcp-body-type"]).toBe("text");
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
		await new Promise<void>((resolve) => ws.once("open", resolve));
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
		await new Promise<void>((resolve) => ws.once("open", resolve));
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
		await new Promise<void>((resolve) => ws.once("open", resolve));

		const [helloRaw, welcomeRaw] = await expectTwo;
		const hello = decode(helloRaw!);
		expect(hello.pcpFields["pcp-action"]).toBe("MESSAGE");
		expect(hello.body).toBe("HELLO");

		const welcome = decode(welcomeRaw!);
		expect(welcome.pcpFields["pcp-action"]).toBe("WELCOME");
		expect(welcome.pcpFields["pcp-body-type"]).toBe("text");
		expect(welcome.pcpFields["sessionId"]).toBe("abc-123");
		expect(welcome.body).toBe("hello, pcp");

		const pong = waitForMessages(ws, 1);
		ws.send(encode({ body: "PING" }));
		const [pongRaw] = await pong;
		const pongFrame = decode(pongRaw!);
		expect(pongFrame.pcpFields["pcp-action"]).toBe("PONG");
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
		await new Promise<void>((resolve) => ws.once("open", resolve));

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
		await new Promise<void>((resolve) => ws.once("open", resolve));
		await ready;

		// Send a frame with custom action and extra fields; verify the handler
		// sees both via the decoded PcpFrame and that the body round-trips.
		const reply = waitForMessages(ws, 1);
		ws.send(encode({ action: "EVENT", fields: { name: "alice" }, body: "payload" }));
		const replyMsgs = await reply;
		expect(decode(replyMsgs[0]!).body).toBe("ECHO:payload");

		ws.close();
	});

	it("drops frames silently when no onMessage is defined", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/no-onmessage.ts", "/ws/no-onmessage");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/no-onmessage`);
		await new Promise<void>((resolve) => ws.once("open", resolve));

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
		await new Promise<void>((resolve) => ws.once("open", resolve));

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
		await new Promise<void>((resolve) => ws.once("open", resolve));

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
		await new Promise<void>((resolve) => ws.once("open", resolve));

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
		await new Promise<void>((resolve) => ws.once("open", resolve));

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
		await new Promise<void>((resolve) => ws.once("open", resolve));
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
		await new Promise<void>((resolve) => ws.once("open", resolve));
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
		await new Promise<void>((resolve) => ws.once("open", resolve));
		await ready;

		const echo = waitForMessages(ws, 1);
		ws.send(Buffer.from("héllo", "utf8"));
		expect((await echo)[0]).toBe("ECHO:héllo");

		ws.close();
	});

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
		// a second upgrade listener that completes the handshake for any path
		// ws-mock didn't claim. If ws-mock falls through cleanly, this listener
		// observes the upgrade and the test's fallthroughOccurred Promise
		// resolves.
		const fallthroughWss = new WebSocketServer({ noServer: true });
		let fallthroughResolve: ((path: string) => void) | null = null;
		const fallthroughOccurred = new Promise<string>((resolve) => {
			fallthroughResolve = resolve;
		});
		serverHandle.server.on("upgrade", (req, socket, head) => {
			// Only react to the unrelated path; the matched routes are already
			// handled synchronously by ws-mock's listener.
			const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
			if (pathname !== "/ws/c") return;
			fallthroughWss.handleUpgrade(req, socket, head, (ws) => {
				fallthroughResolve?.(pathname);
				ws.close();
			});
		});

		// Route /ws/a accepts (handled by ws-mock).
		const wsA = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/a`);
		await new Promise<void>((resolve) => wsA.once("open", resolve));
		wsA.close();

		// Route /ws/c is not declared on ws-mock. Opening it should fall
		// through to the test-side listener, which completes the handshake
		// and then closes cleanly.
		const wsC = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/c`);
		await new Promise<void>((resolve) => wsC.once("open", resolve));
		const observedPath = await fallthroughOccurred;
		expect(observedPath).toBe("/ws/c");
		wsC.close();
		fallthroughWss.close();

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
		await new Promise<void>((resolve) => ws.once("open", resolve));
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
		await new Promise<void>((resolve) => ws.once("open", resolve));
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

	it("warns when duplicate mountPaths are declared and the later route wins", async () => {
		const { log, entries } = createCapturedLogger();
		await wsMock({
			log,
			options: {
				configuration: {
					routes: [
						{ mountPath: "/ws/dup", handler: "test/fixtures/handlers/echo.ts" },
						{
							mountPath: "/ws/dup",
							handler: "test/fixtures/handlers/notifications.ts",
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

		// The later route (notifications.ts) wins. Its onConnect sends HELLO,
		// not echo.ts's READY, so observing HELLO confirms the override.
		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/dup`);
		const first = waitForMessages(ws, 1);
		await new Promise<void>((resolve) => ws.once("open", resolve));
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
		await new Promise<void>((resolve) => ws.once("open", resolve));
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
		await new Promise<void>((resolve) => ws.once("open", resolve));
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
						// Handler value is irrelevant — resolution throws before
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
		await new Promise<void>((resolve) => ws.once("open", resolve));
		expect((await ready)[0]).toBe("READY");

		ws.close();
	});

	it("empty routes is a no-op: factory resolves on a Module-type project without calling getSourcePath", async () => {
		// Behavioral guarantee: a middleware declaration with zero routes (a
		// documented no-op) must not crash on Module-type projects. The shape
		// of that crash, pre-fix, was an eager call into getSourcePath() that
		// threw. We assert (a) the factory resolves cleanly, (b) the spy is
		// never invoked. Whether getProject()/getRootPath() are called too is
		// an implementation detail — we don't bind to it.
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
		await new Promise<void>((resolve) => ws.once("open", resolve));
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
});
