import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, ExecResult } from "@earendil-works/pi-coding-agent";
import { readStatus } from "../src/git.ts";
import { setup } from "../pi-git-monitor.ts";
import { fakeDependencies, clean, deferred, flush } from "./helpers.ts";
function fixture(t: TestContext, mode = "tui", root?: string) {
	const deps = fakeDependencies();
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => void | Promise<void>>();
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	const flags = new Map<string, unknown>();const views: string[][] = [];
	const statuses = new Map<string, string | undefined>();const notifications: string[] = [];
	let discoveries = 0, scans = 0, probes = 0, idle = true, custom = 0, currentTheme = "initial";
	const discover = deps.discover;deps.discover = (...args) => { discoveries++;return discover(...args); };
	const readStatus = deps.readStatus;deps.readStatus = (...args) => { scans++;return readStatus(...args); };
	const probe = deps.probe;deps.probe = (...args) => { probes++;return probe(...args); };
	const ctx = { mode, hasUI: mode === "tui" || mode === "rpc", cwd: "/synthetic", isIdle: () => idle,
		ui: { theme: { fg: (color: string, text: string) => `${currentTheme}:${color}:${text}` },
			setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
			notify: (message: string) => notifications.push(message),
			custom: async (factory: any) => {
				custom++;
				const view = factory({ terminal: { rows: 24 }, requestRender() {} }, ctx.ui.theme, {}, () => {});
				views.push(view.render(110));
			} } } as unknown as ExtensionCommandContext;
	const api = { on: (event: string, handler: any) => handlers.set(event, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerFlag: (name: string, flag: unknown) => flags.set(name, flag),
		getFlag: (name: string) => name === "git-monitor-root" ? root : undefined } as unknown as ExtensionAPI;
	// Keep test overrides live while production setup captures its dependencies.
	setup(api, { exec: (...args) => deps.exec(...args), discover: (...args) => deps.discover(...args),
		readStatus: (...args) => deps.readStatus(...args), probe: (...args) => deps.probe(...args) });
	t.after(() => handlers.get("session_shutdown")!({}, ctx));
	return { ctx, deps, statuses, notifications, handlers, commands, flags, views,
		start: () => handlers.get("session_start")!({}, ctx),
		command: (args = "") => commands.get("git-monitor")!.handler(args, ctx),
		completions: (prefix: string) => commands.get("git-monitor")!.getArgumentCompletions?.(prefix),
		counts: () => ({ discoveries, scans, probes, custom }),
		idle: (value: boolean) => { idle = value; }, theme: (value: string) => { currentTheme = value; },
		status: () => statuses.get("footer-compositor:right:10:git-monitor-status") };
}
test("startup displays aggregate; idle polling uses cached membership", async t => {
	t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 10_000 });
	const f = fixture(t);f.start();await flush();assert.equal(f.status(), "initial:success:git 1 clean");
	t.mock.timers.tick(15_000);await flush();assert.deepEqual(f.counts(), { discoveries: 1, scans: 2, probes: 1, custom: 0 });
});
test("read results do not scan; mutation bursts are debounced", async t => {
	t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 10_000 });
	const f = fixture(t);f.start();await flush();
	f.handlers.get("tool_result")!({ toolName: "read", isError: false }, f.ctx);
	t.mock.timers.tick(500);await flush();assert.equal(f.counts().scans, 1);
	for (let i = 0; i < 10; i++) f.handlers.get("tool_result")!({ toolName: "write", isError: false }, f.ctx);
	t.mock.timers.tick(499);await flush();assert.equal(f.counts().scans, 1);
	t.mock.timers.tick(1);await flush();assert.equal(f.counts().scans, 2);
});
test("busy-state cache becomes stale and theme updates without Git requests", async t => {
	t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 10_000 });
	const f = fixture(t);f.start();await flush();f.idle(false);f.theme("changed");
	t.mock.timers.tick(60_000);await flush();assert.equal(f.status(), "changed:warning:git 1 clean?");
	assert.equal(f.counts().scans, 1);
});
test("commands refresh membership and probe; monitor opens read-only view", async t => {
	const f = fixture(t);f.start();await flush();await f.command();
	assert.deepEqual(f.counts(), { discoveries: 2, scans: 2, probes: 2, custom: 1 });
	await f.command("status");assert.match(f.notifications[0], /git 1 clean/);
});
test("pending manual command cannot notify or open a view after shutdown", async t => {
	const f = fixture(t);f.start();await flush();const pending = deferred<{ status: typeof clean }>();f.deps.readStatus = () => pending.promise;
	const command = f.command();await flush();f.handlers.get("session_shutdown")!({}, f.ctx);await command;
	assert.equal(f.notifications.length, 0);assert.equal(f.counts().custom, 0);
	pending.resolve({ status: clean });await flush();assert.equal(f.status(), undefined);
});
test("repeated startup owns one timer and independent session work", async t => {
	t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 10_000 });
	const f = fixture(t);f.start();await flush();f.start();await flush();
	t.mock.timers.tick(15_000);await flush();assert.equal(f.counts().scans, 3);
});
for (const mode of ["rpc", "json", "print"]) {
	test(`no automatic work or status in ${mode}`, async t => {
		const f = fixture(t, mode);f.start();await flush();
		assert.deepEqual(f.counts(), { discoveries: 0, scans: 0, probes: 0, custom: 0 });
		assert.equal(f.statuses.size, 0);
		if (mode === "rpc") { await f.command();assert.match(f.notifications[0], /Workspace/);assert.equal(f.statuses.size, 0); }
		else { await assert.rejects(f.command(), /requires TUI or RPC/);assert.equal(f.counts().scans, 0); }
	});
}
test("explicit root is resolved once relative to startup cwd", async t => {
	const f = fixture(t, "rpc", "..");let root: string | undefined;
	const discover = f.deps.discover;f.deps.discover = (...args) => { root = args[2];return discover(...args); };
	f.start();await f.command();assert.equal(root, "/");
});
test("unknown repository arguments do not scan arbitrary paths or open a view", async t => {
	const f = fixture(t, "rpc");f.start();await f.command("view /not-in-inventory");
	assert.match(f.notifications[0], /not in this workspace/);assert.equal(f.counts().custom, 0);
});

test("only the monitor command and root flag are registered", t => {
	const f = fixture(t);
	assert.deepEqual([...f.commands.keys()], ["git-monitor"]);
	assert.deepEqual([...f.flags.keys()], ["git-monitor-root"]);
});
test("Tab completes long and short subcommands without scanning", async t => {
	const f = fixture(t);
	assert.deepEqual((await f.completions(""))?.map(item => item.value), ["view", "v", "status", "s"]);
	assert.deepEqual((await f.completions("v"))?.map(item => item.value), ["view", "v"]);
	assert.deepEqual((await f.completions("s"))?.map(item => item.value), ["status", "s"]);
	assert.equal(await f.completions("view "), null);
	assert.deepEqual(f.counts(), { discoveries: 0, scans: 0, probes: 0, custom: 0 });
});
for (const action of ["view", "v", "status", "s"]) {
	test(`${action} refreshes and opens the correct output in TUI`, async t => {
		const f = fixture(t);f.start();await flush();await f.command(action);
		assert.deepEqual(f.counts(), { discoveries: 2, scans: 2, probes: 2,
			custom: action === "view" || action === "v" ? 1 : 0 });
		if (action === "view" || action === "v") assert.match(f.views[0].join("\n"), /Workspace: \/synthetic/);
		else assert.match(f.notifications[0], /git 1 clean/);
	});
	test(`${action} can select a repository named status`, async t => {
		const f = fixture(t);f.deps.discover = async () => ({ root: "/synthetic", issues: [],
			repositories: [{ path: "/synthetic/status", label: "status" }] });
		await f.command(`${action} status`);
		if (action === "view" || action === "v") assert.match(f.views[0].join("\n"), /Repository: status/);
		else assert.ok(f.notifications[0].startsWith("/synthetic/status\n"));
	});
	test(`${action} preserves spaces in repository paths`, async t => {
		const f = fixture(t, "rpc");f.deps.discover = async () => ({ root: "/synthetic", issues: [],
			repositories: [{ path: "/synthetic/my  product", label: "my  product" }] });
		await f.command(`  ${action}\t/synthetic/my  product  `);
		assert.ok(f.notifications[0].startsWith("/synthetic/my  product\n"));
		assert.equal(f.counts().custom, 0);
	});
	test(`${action} cannot publish late output after shutdown`, async t => {
		const f = fixture(t);const pending = deferred<{ status: typeof clean }>();f.deps.readStatus = () => pending.promise;
		const command = f.command(action);await flush();f.handlers.get("session_shutdown")!({}, f.ctx);await command;
		pending.resolve({ status: clean });await flush();
		assert.equal(f.notifications.length, 0);assert.equal(f.counts().custom, 0);assert.equal(f.status(), undefined);
	});
	for (const mode of ["print", "json"]) {
		test(`${action} rejects ${mode} mode before scanning`, async t => {
			const f = fixture(t, mode);await assert.rejects(f.command(action), /requires TUI or RPC/);
			assert.deepEqual(f.counts(), { discoveries: 0, scans: 0, probes: 0, custom: 0 });
		});
	}
}
test("invalid verbs and bare repository arguments show usage without scanning", async t => {
	const f = fixture(t);
	for (const args of ["show", "refresh", "product", "viewed"]) await f.command(args);
	assert.equal(f.notifications.length, 4);assert.ok(f.notifications.every(text => text.startsWith("Usage: /git-monitor")));
	assert.deepEqual(f.counts(), { discoveries: 0, scans: 0, probes: 0, custom: 0 });
});
test("status and s print the same report, view and v render the same snapshot", async t => {
	const f = fixture(t);
	await f.command("status");await f.command("s");assert.equal(f.notifications[0], f.notifications[1]);
	await f.command("view");await f.command("v");assert.deepEqual(f.views[0], f.views[1]);
});

test("shutdown releases request waiters but awaits the underlying execution", async t => {
	const f = fixture(t), pending = deferred<ExecResult>();let signal: AbortSignal | undefined;
	f.deps.readStatus = readStatus;
	f.deps.exec = (_command, _args, options) => { signal = options?.signal;return pending.promise; };
	f.start();await flush();assert.ok(signal);
	let done = false;
	const shutdown = Promise.resolve(f.handlers.get("session_shutdown")!({}, f.ctx)).then(() => { done = true; });
	try {
		await flush();assert.equal(signal.aborted, true);assert.equal(done, false);
		assert.equal(f.status(), undefined);
		pending.resolve({ code: 0, stdout: "", stderr: "", killed: true });
		await shutdown;assert.equal(done, true);
		await f.handlers.get("session_shutdown")!({}, f.ctx);
		assert.equal(f.status(), undefined);
	} finally { pending.resolve({ code: 1, stdout: "", stderr: "", killed: true });await shutdown; }
});

test("expired requests retain execution slots and remain owned at shutdown", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture(t), jobs: ReturnType<typeof deferred<ExecResult>>[] = [];
	f.deps.readStatus = readStatus;
	f.deps.exec = () => { const job = deferred<ExecResult>();jobs.push(job);return job.promise; };
	let shutdown: Promise<void> | undefined;
	try {
		f.start();await flush();assert.equal(jobs.length, 1);
		t.mock.timers.tick(2_000);await flush();
		const second = f.command("status");await flush();assert.equal(jobs.length, 2);
		t.mock.timers.tick(2_000);await second;
		const third = f.command("status");await flush();
		assert.equal(jobs.length, 2, "timed-out executions still occupy both slots");
		t.mock.timers.tick(2_000);await third;
		let done = false;
		shutdown = Promise.resolve(f.handlers.get("session_shutdown")!({}, f.ctx)).then(() => { done = true; });
		await flush();assert.equal(done, false);
		jobs[0].resolve({ code: 1, stdout: "", stderr: "", killed: true });
		await flush();assert.equal(done, false);assert.equal(jobs.length, 2);
		jobs[1].resolve({ code: 1, stdout: "", stderr: "", killed: true });
		await shutdown;assert.equal(done, true);assert.equal(jobs.length, 2);
	} finally {
		for (const job of jobs) job.resolve({ code: 1, stdout: "", stderr: "", killed: true });
		await shutdown;
	}
});

test("shutdown also drains executions belonging to replaced sessions", async t => {
	const f = fixture(t), jobs: ReturnType<typeof deferred<ExecResult>>[] = [], signals: AbortSignal[] = [];
	f.deps.readStatus = readStatus;
	f.deps.exec = (_command, _args, options) => {
		signals.push(options!.signal!);const job = deferred<ExecResult>();jobs.push(job);return job.promise;
	};
	let shutdown: Promise<void> | undefined;
	try {
		f.start();await flush();f.start();await flush();
		assert.equal(jobs.length, 2);assert.equal(signals[0].aborted, true);
		let done = false;
		shutdown = Promise.resolve(f.handlers.get("session_shutdown")!({}, f.ctx)).then(() => { done = true; });
		assert.equal(signals[1].aborted, true);
		jobs[1].resolve({ code: 1, stdout: "", stderr: "", killed: true });
		await flush();assert.equal(done, false, "the old session's execution is still outstanding");
		jobs[0].resolve({ code: 1, stdout: "", stderr: "", killed: true });
		await shutdown;assert.equal(done, true);assert.equal(f.status(), undefined);
	} finally {
		for (const job of jobs) job.resolve({ code: 1, stdout: "", stderr: "", killed: true });
		await shutdown;
	}
});

test("status cleanup errors cannot bypass execution draining", async t => {
	const f = fixture(t), pending = deferred<ExecResult>();
	f.deps.readStatus = readStatus;f.deps.exec = () => pending.promise;
	f.start();await flush();
	const setStatus = f.ctx.ui.setStatus;
	f.ctx.ui.setStatus = () => { throw new Error("UI already stopped"); };
	let done = false;
	const rejected = assert.rejects(Promise.resolve(f.handlers.get("session_shutdown")!({}, f.ctx)), /UI already stopped/)
		.then(() => { done = true; });
	try {
		await flush();assert.equal(done, false);
		pending.resolve({ code: 1, stdout: "", stderr: "", killed: true });
		await rejected;assert.equal(done, true);
	} finally {
		f.ctx.ui.setStatus = setStatus;
		pending.resolve({ code: 1, stdout: "", stderr: "", killed: true });await rejected;
	}
});
