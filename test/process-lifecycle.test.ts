import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import type { ExtensionAPI, ExtensionContext, ExecResult } from "@earendil-works/pi-coding-agent";
import gitMonitor from "../pi-git-monitor.ts";
import type { Exec } from "../src/git.ts";
import { deferred, git, temporary } from "./helpers.ts";

// Exercise the SDK helper behind pi.exec, not the execFile test adapter.
// The helper is not a public export; production code uses only pi.exec.
const { execCommand } = await import(new URL("./core/exec.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
	execCommand(command: string, args: string[], cwd: string, options?: Parameters<Exec>[2]): Promise<ExecResult>;
};

test("shutdown awaits a real Git child executed by Pi before returning", { skip: process.platform !== "linux", timeout: 10_000 }, async t => {
	// The SDK's otherwise referenced five-second escalation timer need not keep
	// this test worker alive after Git has exited. Signals and reaping are real.
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const root = await temporary(t);
	await git(root, "init", "-q", "-b", "main");
	await new Promise<void>((resolve, reject) => execFile("mkfifo", [`${root}/.git/index`], error => error ? reject(error) : resolve()));
	const started = deferred<void>();
	const pending = new Set<Promise<ExecResult>>();
	let statusFinished = false;
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const ctx = { cwd: root, mode: "tui", isIdle: () => true,
		ui: { setStatus() {}, theme: { fg: (_color: string, text: string) => text } } } as unknown as ExtensionContext;
	gitMonitor({
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
		registerFlag() {}, registerCommand() {}, getFlag() {},
		exec: (command: string, args: string[], options: Parameters<Exec>[2]) => {
			const task = execCommand(command, args, root, options);
			pending.add(task);
			void task.then(() => { pending.delete(task); if (args.includes("status")) statusFinished = true; });
			if (args.includes("status")) started.resolve();
			return task;
		},
	} as unknown as ExtensionAPI);
	try {
		handlers.get("session_start")!({}, ctx);
		await started.promise;
		await handlers.get("session_shutdown")!({}, ctx);
		assert.equal(pending.size, 0, "the host may exit as soon as this handler returns");
		assert.equal(statusFinished, true, "Pi must have observed the direct Git child's exit");
	} finally {
		await handlers.get("session_shutdown")!({}, ctx);
		// Also reap on an assertion failure, including when testing the old bug.
		await Promise.allSettled(pending);
	}
});
