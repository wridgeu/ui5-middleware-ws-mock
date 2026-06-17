import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";

type HookCallback = (args: { server: Server; app?: unknown; options?: unknown }) => void;

let capturedHookCallback: HookCallback | null = null;

/**
 * Registers the hook callback that the mocked `ui5-utils-express/lib/hook.js`
 * received from the middleware factory. The vi.mock declaration lives in the
 * test file (so vitest's hoisting picks it up) and forwards the callback here.
 */
export function setHookCapture(callback: HookCallback): void {
	capturedHookCallback = callback;
}

export async function startServer(): Promise<{
	server: Server;
	port: number;
	close: () => Promise<void>;
}> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	return {
		server,
		port,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			}),
	};
}

export function fireHook(server: Server): void {
	if (!capturedHookCallback) {
		throw new Error("middleware factory did not register a hook callback");
	}
	capturedHookCallback({ server });
}

export function resetHookCapture(): void {
	capturedHookCallback = null;
}

/**
 * Stands in for a coexisting upgrade listener (another middleware, e.g.
 * livereload's WS channel). Attaches a second `'upgrade'` listener that
 * completes the handshake only for `pathname`; if ws-mock falls through
 * cleanly on an upgrade it did not claim, this listener observes it and
 * `occurred` resolves with the pathname. Call `close()` in the test to detach
 * the listener and shut its `WebSocketServer` down.
 */
export function expectFallThrough(
	server: Server,
	pathname: string,
): { occurred: Promise<string>; close: () => void } {
	const wss = new WebSocketServer({ noServer: true });
	let resolve!: (path: string) => void;
	const occurred = new Promise<string>((r) => {
		resolve = r;
	});
	const onUpgrade = (
		req: import("node:http").IncomingMessage,
		socket: import("node:stream").Duplex,
		head: Buffer,
	): void => {
		const p = new URL(req.url ?? "/", "http://localhost").pathname;
		if (p !== pathname) return;
		wss.handleUpgrade(req, socket, head, (ws) => {
			resolve(p);
			ws.close();
		});
	};
	server.on("upgrade", onUpgrade);
	return {
		occurred,
		close: () => {
			server.off("upgrade", onUpgrade);
			wss.close();
		},
	};
}

/**
 * Structural stand-in for `@ui5/server`'s `MiddlewareUtil` exposing both
 * `getRootPath()` and `getSourcePath()`. `sourcePath` defaults to `rootPath`
 * so callers that don't care about the distinction keep working.
 */
export function createMiddlewareUtil(
	rootPath: string,
	sourcePath: string = rootPath,
): {
	getProject(): { getRootPath(): string; getSourcePath(): string };
} {
	return {
		getProject: () => ({
			getRootPath: () => rootPath,
			getSourcePath: () => sourcePath,
		}),
	};
}
