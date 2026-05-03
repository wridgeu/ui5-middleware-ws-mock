export interface CapturedLog {
	level: "info" | "warn" | "error" | "debug";
	args: unknown[];
}

export function createCapturedLogger(): {
	log: {
		info: (...args: unknown[]) => void;
		warn: (...args: unknown[]) => void;
		error: (...args: unknown[]) => void;
		debug: (...args: unknown[]) => void;
	};
	entries: CapturedLog[];
} {
	const entries: CapturedLog[] = [];
	const log = {
		info: (...args: unknown[]) => entries.push({ level: "info", args }),
		warn: (...args: unknown[]) => entries.push({ level: "warn", args }),
		error: (...args: unknown[]) => entries.push({ level: "error", args }),
		debug: (...args: unknown[]) => entries.push({ level: "debug", args }),
	};
	return { log, entries };
}
