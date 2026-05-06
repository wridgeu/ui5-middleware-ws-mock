export interface CapturedLog {
	level: "silly" | "verbose" | "perf" | "info" | "warn" | "error";
	args: unknown[];
}

export function createCapturedLogger(): {
	log: {
		silly: (...args: unknown[]) => void;
		verbose: (...args: unknown[]) => void;
		perf: (...args: unknown[]) => void;
		info: (...args: unknown[]) => void;
		warn: (...args: unknown[]) => void;
		error: (...args: unknown[]) => void;
	};
	entries: CapturedLog[];
} {
	const entries: CapturedLog[] = [];
	const log = {
		silly: (...args: unknown[]) => entries.push({ level: "silly", args }),
		verbose: (...args: unknown[]) => entries.push({ level: "verbose", args }),
		perf: (...args: unknown[]) => entries.push({ level: "perf", args }),
		info: (...args: unknown[]) => entries.push({ level: "info", args }),
		warn: (...args: unknown[]) => entries.push({ level: "warn", args }),
		error: (...args: unknown[]) => entries.push({ level: "error", args }),
	};
	return { log, entries };
}
