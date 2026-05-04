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

	it("round-trips action frames in plain mode", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/echo.ts", "/ws/echo");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/echo`);
		const ready = waitForMessages(ws, 1);
		await new Promise<void>((resolve) => ws.once("open", resolve));
		expect(ws.protocol).toBe("");

		const readyMsgs = await ready;
		expect(readyMsgs[0]).toContain('"action":"READY"');

		const echoBack = waitForMessages(ws, 1);
		ws.send(JSON.stringify({ action: "PING", data: { n: 1 } }));
		const echoMsgs = await echoBack;
		expect(echoMsgs[0]).toContain('"action":"ECHO"');
		expect(echoMsgs[0]).toContain('"n":1');

		ws.close();
	});

	it("round-trips action frames in PCP mode", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/echo.ts", "/ws/echo");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/echo`, "v10.pcp.sap.com");
		const ready = waitForMessages(ws, 1);
		await new Promise<void>((resolve) => ws.once("open", resolve));
		expect(ws.protocol).toBe("v10.pcp.sap.com");

		const readyMsgs = await ready;
		expect(readyMsgs[0]).toContain("pcp-action:MESSAGE");
		expect(readyMsgs[0]).toContain("action:READY");

		const echoBack = waitForMessages(ws, 1);
		ws.send('pcp-action:MESSAGE\npcp-body-type:text\naction:PING\n\n{"n":1}');
		const echoMsgs = await echoBack;
		expect(echoMsgs[0]).toContain("action:ECHO");
		expect(echoMsgs[0]).toContain('"n":1');

		ws.close();
	});

	it("dispatches to actions[name] when frame matches", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/notifications.ts", "/ws/notif");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/notif`);
		const ready = waitForMessages(ws, 1);
		await new Promise<void>((resolve) => ws.once("open", resolve));
		await ready;

		const pong = waitForMessages(ws, 1);
		ws.send(JSON.stringify({ action: "PING", data: { n: 7 } }));
		const pongMsgs = await pong;
		expect(pongMsgs[0]).toContain('"action":"PONG"');
		expect(pongMsgs[0]).toContain('"n":7');

		ws.close();
	});

	it("falls through to onMessage when action does not match", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/notifications.ts", "/ws/notif");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/notif`);
		await new Promise<void>((resolve) => ws.once("open", resolve));

		ws.send(JSON.stringify({ action: "UNKNOWN", data: 1 }));
		await waitForLog(
			args.entries,
			(e) => e.level === "debug" && String(e.args.join(" ")).includes("unhandled frame"),
		);

		ws.close();
	});

	it("drops frames silently when no action match and no onMessage", async () => {
		// throws-sync.ts has only actions.BOOM and no onMessage, so an unrecognized
		// action exercises the drop-with-debug-log path. Send a non-JSON payload
		// so frame.action is undefined and the "(none)" branch runs.
		const args = buildFactoryArgs("test/fixtures/handlers/throws-sync.ts", "/ws/sboom");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/sboom`);
		await new Promise<void>((resolve) => ws.once("open", resolve));

		ws.send("not-json-no-action");
		await waitForLog(
			args.entries,
			(e) => e.level === "debug" && String(e.args.join(" ")).includes("dropped frame"),
		);
		await waitForLog(
			args.entries,
			(e) => e.level === "debug" && String(e.args.join(" ")).includes("(none)"),
		);
		expect(ws.readyState).toBe(WebSocket.OPEN);

		ws.close();
	});

	it("swallows JSON.stringify errors in ctx.send and keeps the connection alive", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/circular-send.ts", "/ws/circ");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/circ`);
		const okFrame = waitForMessages(ws, 1);
		await new Promise<void>((resolve) => ws.once("open", resolve));

		// The middleware logger is prefix-aware: args[0] is "[ws-mock:<mountPath>]"
		// and the "send failed" message lands in subsequent args. Match the joined
		// argument list rather than args[0].
		await waitForLog(
			args.entries,
			(e) => e.level === "error" && String(e.args.join(" ")).includes("send failed"),
		);

		const msgs = await okFrame;
		expect(msgs.some((m) => m.includes('"action":"OK"'))).toBe(true);
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

		ws.send(JSON.stringify({ action: "BOOM", data: null }));
		await waitForLog(
			args.entries,
			(e) => e.level === "error" && String(e.args.join(" ")).includes("rejected"),
		);
		expect(ws.readyState).toBe(WebSocket.OPEN);

		ws.close();
	});

	it("logs sync handler throws without closing the connection", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/throws-sync.ts", "/ws/sboom2");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/sboom2`);
		await new Promise<void>((resolve) => ws.once("open", resolve));

		ws.send(JSON.stringify({ action: "BOOM", data: null }));
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

		expect(entries.some((e) => String(e.args[0]).includes("/ws/a"))).toBe(true);
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

	it("invokes onClose with code and reason from a normal close", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/notifications.ts", "/ws/notif");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/notif`);
		await new Promise<void>((resolve) => ws.once("open", resolve));
		ws.close(1000, "bye");

		await waitForLog(
			args.entries,
			(e) => e.level === "info" && String(e.args.join(" ")).includes("disconnect 1000"),
		);
	});

	it("ctx.terminate produces a 1006 close on the client and invokes onClose", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/notifications.ts", "/ws/notif");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/notif`);
		await new Promise<void>((resolve) => ws.once("open", resolve));
		const closePromise = new Promise<number>((resolve) =>
			ws.on("close", (code) => resolve(code)),
		);
		ws.send(JSON.stringify({ action: "TERMINATE", data: null }));
		const code = await closePromise;
		expect(code).toBe(1006);

		await waitForLog(
			args.entries,
			(e) => e.level === "info" && String(e.args.join(" ")).includes("disconnect 1006"),
		);
	});

	it("plain mode: treats malformed JSON as a raw-only frame", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/notifications.ts", "/ws/notif");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/notif`);
		await new Promise<void>((resolve) => ws.once("open", resolve));

		ws.send("not-json-at-all");
		await waitForLog(
			args.entries,
			(e) => e.level === "debug" && String(e.args.join(" ")).includes("(none)"),
		);

		ws.close();
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

	it("ctx.send produces an empty body when frame.data is omitted", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/no-data.ts", "/ws/nd");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/nd`);
		const ready = waitForMessages(ws, 1);
		await new Promise<void>((resolve) => ws.once("open", resolve));
		const messages = await ready;

		// Plain mode: data property is omitted from JSON.stringify output.
		expect(messages[0]).toContain('"action":"READY"');
		expect(messages[0]).not.toContain('"data"');
		ws.close();
	});

	it("PCP mode: passes through bodies that look like JSON but fail to parse", async () => {
		// Body starting with "{" matches the looksLikeJson rule but does not parse.
		// parseBodyPayload's catch returns the raw body; echo.ts replies with it.
		const args = buildFactoryArgs("test/fixtures/handlers/echo.ts", "/ws/echo");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/echo`, "v10.pcp.sap.com");
		const ready = waitForMessages(ws, 1);
		await new Promise<void>((resolve) => ws.once("open", resolve));
		await ready;

		const reply = waitForMessages(ws, 1);
		ws.send("pcp-action:MESSAGE\npcp-body-type:text\naction:ECHO\n\n{not-json");
		const replyMsgs = await reply;
		expect(replyMsgs[0]).toContain("{not-json");

		ws.close();
	});

	it("PCP mode: decodes scalar JSON bodies", async () => {
		const args = buildFactoryArgs("test/fixtures/handlers/echo.ts", "/ws/echo");
		await wsMock(args);
		fireHook(serverHandle.server);

		const ws = new WebSocket(`ws://127.0.0.1:${serverHandle.port}/ws/echo`, "v10.pcp.sap.com");
		const ready = waitForMessages(ws, 1);
		await new Promise<void>((resolve) => ws.once("open", resolve));
		await ready;

		// Body is a JSON number; first char "4" matches the digit rule.
		const reply = waitForMessages(ws, 1);
		ws.send("pcp-action:MESSAGE\npcp-body-type:text\naction:ECHO\n\n42");
		const replyMsgs = await reply;
		// echo.ts replies with the data as-is, parsed as JSON number 42.
		expect(replyMsgs[0]).toContain("42");

		ws.close();
	});
});
