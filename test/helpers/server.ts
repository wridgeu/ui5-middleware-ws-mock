import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

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

export function createMiddlewareUtil(rootPath: string): {
	getProject(): { getRootPath(): string };
} {
	return {
		getProject: () => ({ getRootPath: () => rootPath }),
	};
}
