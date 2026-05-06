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
		// `foo`). The handler now hands `message` straight to ctx.send and the
		// body bytes are exactly what the handler emitted.
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
		const decoded = decode(replyMsgs[0]!);
		expect(decoded.body).toBe("ECHO:foo");
		expect(decoded.body).not.toContain('"');

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
			(e) => e.level === "debug" && String(e.args.join(" ")).includes("dropped frame"),
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
			(e) => e.level === "info" && String(e.args.join(" ")).includes("disconnect 1000"),
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
});
