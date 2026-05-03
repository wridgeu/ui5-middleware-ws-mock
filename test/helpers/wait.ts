import type { WebSocket } from "ws";
import type { CapturedLog } from "./logger.js";

/**
 * Resolve once the captured-log entries array contains an entry matching the
 * predicate, or reject after `timeoutMs`. Polls every 5ms.
 */
export async function waitForLog(
	entries: CapturedLog[],
	predicate: (entry: CapturedLog) => boolean,
	timeoutMs = 1000,
): Promise<CapturedLog> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const hit = entries.find(predicate);
		if (hit) return hit;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error(
		`waitForLog: timeout after ${timeoutMs}ms; entries=${JSON.stringify(entries.map((e) => ({ level: e.level, args: e.args.map(String) })))}`,
	);
}

/**
 * Resolve once at least `count` messages have arrived on `ws`, or reject
 * after `timeoutMs`. Returns all messages received during the wait window
 * (strings; assumes utf-8 text frames, which is what the middleware emits).
 */
export async function waitForMessages(
	ws: WebSocket,
	count: number,
	timeoutMs = 1000,
): Promise<string[]> {
	const out: string[] = [];
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			ws.off("message", onMessage);
			reject(new Error(`waitForMessages: got ${out.length}/${count} after ${timeoutMs}ms`));
		}, timeoutMs);
		const onMessage = (data: WebSocket.RawData) => {
			out.push(data.toString("utf8"));
			if (out.length >= count) {
				clearTimeout(timer);
				ws.off("message", onMessage);
				resolve(out);
			}
		};
		ws.on("message", onMessage);
	});
}
