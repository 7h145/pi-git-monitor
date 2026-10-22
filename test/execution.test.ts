import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { GitExecutions } from "../src/execution.ts";
import { deferred, flush } from "./helpers.ts";

const result: ExecResult = { code: 0, stdout: "", stderr: "", killed: false };
const job = () => deferred<ExecResult>();

function fixture() {
	const jobs: ReturnType<typeof job>[] = [], commands: string[] = [];
	let running = 0, maximum = 0;
	const owner = new GitExecutions(command => {
		const pending = job();jobs.push(pending);commands.push(command);
		running++;maximum = Math.max(maximum, running);
		void pending.promise.then(() => { running--; }, () => { running--; });
		return pending.promise;
	});
	return { owner, jobs, commands, maximum: () => maximum };
}

test("execution slots are held until the executor settles", async () => {
	const f = fixture();
	const tasks = Array.from({ length: 6 }, (_, i) => f.owner.exec(String(i), []));
	try {
		await flush();assert.equal(f.jobs.length, 2);
		for (let i = 0; i < tasks.length; i++) {
			await flush();f.jobs[i].resolve(result);
		}
		await Promise.all(tasks);await f.owner.drain();
		assert.equal(f.maximum(), 2);
		assert.deepEqual(f.commands, ["0", "1", "2", "3", "4", "5"]);
	} finally {
		// Release queued calls too if an assertion failed partway through.
		for (let i = 0; i < tasks.length; i++) { for (const pending of f.jobs) pending.resolve(result);await flush(); }
		await Promise.allSettled(tasks);
	}
});

test("aborted slot waiters never execute or consume a later available slot", async () => {
	const f = fixture(), controller = new AbortController();
	const tasks = [f.owner.exec("one", []), f.owner.exec("two", [])];
	const cancelled = f.owner.exec("cancelled", [], { signal: controller.signal });
	const rejected = assert.rejects(cancelled, { name: "AbortError" });
	tasks.push(f.owner.exec("next", []));
	try {
		await flush();assert.equal(f.jobs.length, 2);
		controller.abort();await rejected;
		f.jobs[0].resolve(result);await flush();
		assert.deepEqual(f.commands, ["one", "two", "next"]);
	} finally {
		controller.abort();await rejected;
		for (let i = 0; i < tasks.length; i++) { for (const pending of f.jobs) pending.resolve(result);await flush(); }
		await Promise.allSettled(tasks);await f.owner.drain();
	}
});

test("drain waits for every execution and absorbs executor rejection", async () => {
	const f = fixture();
	const first = f.owner.exec("one", []), second = f.owner.exec("two", []);
	const rejected = assert.rejects(first, /failed/);
	let drained = false;
	const drain = f.owner.drain().then(() => { drained = true; });
	try {
		await flush();assert.equal(drained, false);
		f.jobs[0].reject(new Error("failed"));await rejected;await flush();
		assert.equal(drained, false);
		f.jobs[1].resolve(result);await second;await drain;
		assert.equal(drained, true);
	} finally {
		for (const pending of f.jobs) pending.resolve(result);
		await Promise.allSettled([first, second, drain]);
	}
});

test("each call reserves a slot even when an adapter reuses a promise", async () => {
	const pending = job();let calls = 0;
	const owner = new GitExecutions(() => { calls++;return pending.promise; });
	const tasks = Array.from({ length: 3 }, () => owner.exec("git", []));
	try { await flush();assert.equal(calls, 2); }
	finally { pending.resolve(result);await Promise.all(tasks);await owner.drain(); }
	assert.equal(calls, 3);
});

test("synchronous executor errors release slots and do not break drain", async () => {
	const owner = new GitExecutions(() => { throw new Error("cannot spawn"); });
	await Promise.all(Array.from({ length: 4 }, () => assert.rejects(owner.exec("git", []), /cannot spawn/)));
	await owner.drain();
});

test("abort before the executor is invoked prevents spawning", async () => {
	let calls = 0;
	const owner = new GitExecutions(async () => { calls++;return result; });
	const controller = new AbortController();
	const task = owner.exec("git", [], { signal: controller.signal });
	controller.abort();
	await assert.rejects(task, { name: "AbortError" });await owner.drain();
	assert.equal(calls, 0);
});
