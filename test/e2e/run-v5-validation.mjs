// End-to-end validation that the middleware works under a given @ui5/cli major.
//
// Why this exists: the unit suite (test/middleware.test.ts) drives the factory
// with a structural stand-in for the UI5 tooling harness. It proves the
// middleware's own logic but never boots a real `ui5 serve`, so it cannot catch
// a break in the runtime contract the tooling provides (the factory params, the
// specVersion acceptance, or the `ui5-utils-express` hook that reaches the HTTP
// server). This harness closes that gap: it installs the packed middleware next
// to a real @ui5/cli, boots the server, and exercises the WebSocket wire.
//
// It is deliberately CLI-version agnostic. Point UI5_CLI_VERSION at the alpha
// today and at the GA release once it ships; the same script re-validates. The
// middleware declares no @ui5/* dependency (the host provides the runtime), so
// the version under test lives here, not in package.json.
//
// Usage: node test/e2e/run-v5-validation.mjs
//   UI5_CLI_VERSION  npm version/dist-tag to install (default: ^5.0.0-alpha.6)
//   KEEP_TMP=1       leave the temp app in place for inspection

import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const FIXTURE = join(HERE, "v5app");
const CLI_VERSION = process.env.UI5_CLI_VERSION ?? "^5.0.0-alpha.6";
const KEEP_TMP = process.env.KEEP_TMP === "1";
const READY_TIMEOUT_MS = 90_000;
const IS_WINDOWS = process.platform === "win32";
// On Windows npm is a `.cmd` shim, which Node 20.12+ refuses to spawn without a
// shell. All args here are internal (fixed flags + a temp tarball path), so the
// DEP0190 shell-escaping caveat does not apply.
const NPM = "npm";

function run(cmd, args, opts = {}) {
	const res = spawnSync(cmd, args, { stdio: "inherit", shell: IS_WINDOWS, ...opts });
	if (res.status !== 0) {
		throw new Error(`${cmd} ${args.join(" ")} exited with ${res.status ?? res.signal}`);
	}
	return res;
}

// Pack the middleware from the repo root into `dir`, returning the tarball path.
function packMiddleware(dir) {
	const res = spawnSync(NPM, ["pack", "--pack-destination", dir, "--json"], {
		cwd: REPO_ROOT,
		shell: IS_WINDOWS,
		encoding: "utf8",
	});
	if (res.status !== 0) {
		process.stderr.write(res.stderr ?? "");
		throw new Error(`npm pack failed with ${res.status}`);
	}
	const filename = JSON.parse(res.stdout)[0].filename;
	return join(dir, filename);
}

// Boot `ui5 serve` in `cwd`; resolve with { child, url } once it reports ready.
function bootServer(cwd) {
	const ui5Bin = join(cwd, "node_modules", "@ui5", "cli", "bin", "ui5.cjs");
	const child = spawn(process.execPath, [ui5Bin, "serve", "--port", "0"], {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let buffer = "";
	return new Promise((resolveReady, rejectReady) => {
		const timer = setTimeout(() => {
			rejectReady(
				new Error(`server did not become ready within ${READY_TIMEOUT_MS}ms\n${buffer}`),
			);
		}, READY_TIMEOUT_MS);
		const onData = (chunk) => {
			buffer += chunk.toString();
			const match = buffer.match(/URL:\s*(http:\/\/[^\s]+)/);
			if (match && /Server started/.test(buffer)) {
				clearTimeout(timer);
				resolveReady({ child, url: match[1], log: () => buffer });
			}
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.once("exit", (code) => {
			clearTimeout(timer);
			rejectReady(new Error(`server exited early (code ${code})\n${buffer}`));
		});
	});
}

function stopServer(child) {
	if (!child || child.exitCode !== null) return;
	if (IS_WINDOWS) {
		spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
	} else {
		child.kill("SIGTERM");
	}
}

function nextEvent(ws, event) {
	return new Promise((res, rej) => {
		ws.once(event, res);
		ws.once("error", rej);
	});
}

async function assertPlainEcho(wsBase) {
	const ws = new WebSocket(`${wsBase}/ws/echo`);
	await nextEvent(ws, "open");
	const hello = String(await nextEvent(ws, "message"));
	ws.send("ping");
	const echo = String(await nextEvent(ws, "message"));
	ws.close();
	return check(
		"plain /ws/echo",
		hello === "HELLO" && echo === "echo:ping",
		`hello=${hello} echo=${echo}`,
	);
}

async function assertParams(wsBase) {
	const ws = new WebSocket(`${wsBase}/ws/notify/42`);
	await nextEvent(ws, "open");
	const msg = String(await nextEvent(ws, "message"));
	ws.close();
	return check("params /ws/notify/:userId", msg === "subscribed:42", `msg=${msg}`);
}

async function assertPcp(wsBase) {
	const ws = new WebSocket(`${wsBase}/ws/echo`, ["v10.pcp.sap.com"]);
	await nextEvent(ws, "open");
	const negotiated = ws.protocol;
	const frame = String(await nextEvent(ws, "message"));
	ws.close();
	const ok =
		negotiated === "v10.pcp.sap.com" && frame.includes("pcp-action") && frame.includes("HELLO");
	return check("pcp negotiation", ok, `proto=${negotiated} frame=${JSON.stringify(frame)}`);
}

const failures = [];
function check(name, pass, detail) {
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}  -- ${detail}`);
	if (!pass) failures.push(name);
	return pass;
}

async function main() {
	console.log(`[v5-validation] @ui5/cli version under test: ${CLI_VERSION}`);
	console.log(`[v5-validation] node ${process.version}`);

	// Build the current source so the pack ships fresh dist output.
	run(NPM, ["run", "build"], { cwd: REPO_ROOT });

	const tmp = mkdtempSync(join(tmpdir(), "wsmock-v5-"));
	const app = join(tmp, "app");
	try {
		cpSync(FIXTURE, app, { recursive: true });
		const tarball = packMiddleware(tmp);

		console.log(
			`[v5-validation] installing @ui5/cli@${CLI_VERSION} + packed middleware into ${app}`,
		);
		// Save to devDependencies (not --no-save): UI5 tooling discovers a custom
		// middleware extension from the project's declared dependencies, so a
		// package present only in node_modules is reported as "not found".
		run(
			NPM,
			[
				"install",
				"--save-dev",
				"--no-audit",
				"--no-fund",
				`@ui5/cli@${CLI_VERSION}`,
				tarball,
			],
			{ cwd: app },
		);

		const installed = JSON.parse(
			readFileSync(join(app, "node_modules", "@ui5", "cli", "package.json"), "utf8"),
		).version;
		console.log(`[v5-validation] resolved @ui5/cli to ${installed}`);

		const { child, url } = await bootServer(app);
		const wsBase = url.replace(/^http/, "ws").replace(/\/$/, "");
		console.log(`[v5-validation] server ready at ${url}`);
		try {
			await assertPlainEcho(wsBase);
			await assertParams(wsBase);
			await assertPcp(wsBase);
		} finally {
			stopServer(child);
		}
	} finally {
		if (KEEP_TMP) {
			console.log(`[v5-validation] KEEP_TMP set; left temp app at ${app}`);
		} else {
			rmSync(tmp, { recursive: true, force: true });
		}
	}

	if (failures.length > 0) {
		console.error(`\n[v5-validation] FAILED: ${failures.join(", ")}`);
		process.exit(1);
	}
	console.log(`\n[v5-validation] all checks passed under @ui5/cli ${CLI_VERSION}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
