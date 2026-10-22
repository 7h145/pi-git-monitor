import type { GitStatus } from "../src/git.ts";
import type { Dependencies } from "../src/session.ts";
import { execFile } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { Exec } from "../src/git.ts";

export const exec: Exec = (command, args, options) => new Promise(resolve => {
	execFile(command, args, { signal: options?.signal, timeout: options?.timeout, maxBuffer: 8 * 1024 * 1024 },
		(error, stdout, stderr) => resolve({ stdout, stderr,
			code: error ? typeof error.code === "number" ? error.code : 1 : 0,
			killed: Boolean(error && "killed" in error && error.killed) }));
});
export async function temporary(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pi-workspace-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}
export async function git(root: string, ...args: string[]) {
	// Disposable commits must not launch detached maintenance processes.
	const result = await exec("git", ["-c", "maintenance.auto=false", "-C", root, ...args]);
	if (result.code) throw new Error(result.stderr);
	return result.stdout;
}
export async function repository(root: string) {
	await mkdir(root, { recursive: true });
	await git(root, "init", "-q", "-b", "main");
	await writeFile(join(root, "tracked"), "base\n");
	await git(root, "add", "tracked");
	await git(root, "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "base");
	return root;
}
export function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
export const flush = async () => { for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

export const clean: GitStatus = { branch: "main", changes: [] };
export function fakeDependencies(): Dependencies {
	return { exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
		discover: async (_exec, cwd) => ({ root: cwd, repositories: [{ path: cwd, label: "workspace" }], issues: [] }),
		readStatus: async () => ({ status: clean }), probe: async () => ({ readOnly: false }) };
}
