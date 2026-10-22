import type { ExecResult } from "@earendil-works/pi-coding-agent";
import type { Exec } from "./git.ts";

/** Own actual executions across request deadlines and session replacement. */
export class GitExecutions {
	private readonly running = new Set<Promise<ExecResult>>();
	private readonly waiting = new Set<() => void>();
	private readonly run: Exec;
	constructor(run: Exec) { this.run = run; }

	readonly exec: Exec = async (command, args, options) => {
		const signal = options?.signal;
		signal?.throwIfAborted();
		while (this.running.size >= 2) {
			await this.waitForSlot(signal);
			signal?.throwIfAborted();
		}
		// Reserve this call's slot before invoking the executor.
		const task = Promise.resolve().then(() => {
			signal?.throwIfAborted();
			return this.run(command, args, options);
		});
		this.running.add(task);
		const finished = () => {
			this.running.delete(task);
			for (const resume of this.waiting) resume();
		};
		void task.then(finished, finished);
		return task;
	};

	/** Call after aborting sessions, so queued work cannot start during cleanup. */
	async drain(): Promise<void> {
		// A waiting deadline here would allow the host to exit before reaping Git.
		while (this.running.size) await Promise.allSettled(this.running);
	}

	private waitForSlot(signal: AbortSignal | undefined): Promise<void> {
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				this.waiting.delete(available);
				signal?.removeEventListener("abort", aborted);
			};
			const available = () => { cleanup(); resolve(); };
			const aborted = () => { cleanup(); reject(signal?.reason); };
			this.waiting.add(available);
			signal?.addEventListener("abort", aborted, { once: true });
			if (signal?.aborted) aborted();
		});
	}
}
