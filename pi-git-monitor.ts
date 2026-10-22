/** pi-git-monitor
 *
 * Purpose: summarize the owning and product Git worktrees, with a read-only
 * /git-monitor overview and an optional working-directory (ro) marker.
 *
 * Strategy: discover shallowly, collect local Git status with bounded parallel
 * requests, and publish through Pi's public status API. Each session owns its
 * work and queue; no late result may update a replacement session.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI Codex (5.6)
 * License: MIT
 * Version: 0.1
 * Date: 2026-07-16
 * Last verified with Pi: 1.1.0
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { dependencies, WorkspaceSession, type Dependencies } from "./src/session.ts";
import { GitExecutions } from "./src/execution.ts";
import { details, overview, summary } from "./src/format.ts";
import { WorkspaceView } from "./src/view.ts";

const LEFT_KEY = "footer-compositor:left:10:git-monitor-read-only";
const RIGHT_KEY = "footer-compositor:right:10:git-monitor-status";
const SUBCOMMANDS = ["view", "v", "status", "s"];
const USAGE = "Usage: /git-monitor [view|v|status|s] [repository name or full path]";
const POLL_MS = 15_000;
const STALE_MS = 60_000;
const DEBOUNCE_MS = 500;

export default function gitMonitor(pi: ExtensionAPI) { setup(pi, dependencies(pi.exec.bind(pi))); }

/** Dependency injection is used only by the regression tests. */
export function setup(pi: ExtensionAPI, deps: Dependencies) {
	// This owner outlives individual sessions and their request waiters.
	const executions = new GitExecutions(deps.exec);
	const sessionDeps = { ...deps, exec: executions.exec };
	let session: WorkspaceSession | undefined;
	let latestCtx: ExtensionContext | undefined;
	let displayTimer: ReturnType<typeof setInterval> | undefined;
	let debounce: ReturnType<typeof setTimeout> | undefined;
	let nextPoll = 0;
	let configuredRoot: string | undefined;
	let rootResolved = false;
	const published = new Map<string, string | undefined>();
	pi.registerFlag("git-monitor-root", { type: "string", description: "Root for Git repository discovery (relative to startup cwd)" });

	function setStatus(ctx: ExtensionContext, key: string, text: string | undefined) {
		if (published.has(key) && published.get(key) === text) return;
		published.set(key, text);
		ctx.ui.setStatus(key, text);
	}
	function publish(ctx: ExtensionContext) {
		if (ctx.mode !== "tui" || !session || session.closed) return;
		const snapshot = session.snapshot;
		setStatus(ctx, LEFT_KEY, snapshot?.writability.readOnly ? ctx.ui.theme.fg("warning", "(ro)") : undefined);
		const value = snapshot ? summary(snapshot) : undefined;
		const stale = snapshot && Date.now() - snapshot.updatedAt >= STALE_MS;
		setStatus(ctx, RIGHT_KEY, value ? ctx.ui.theme.fg(stale ? "warning" : value.color, value.text + (stale ? "?" : "")) : undefined);
	}
	function dispose() {
		session?.stop();
		session = undefined;
		latestCtx = undefined;
		if (displayTimer) clearInterval(displayTimer);
		if (debounce) clearTimeout(debounce);
		displayTimer = debounce = undefined;
		published.clear();
	}
	function start(ctx: ExtensionContext) {
		dispose();
		if (!rootResolved) {
			const flag = pi.getFlag("git-monitor-root");
			configuredRoot = typeof flag === "string" && flag ? resolve(ctx.cwd, flag) : undefined;
			rootResolved = true;
		}
		latestCtx = ctx;
		const current = new WorkspaceSession(ctx.cwd, configuredRoot, sessionDeps, () => {
			if (session === current && latestCtx) publish(latestCtx);
		});
		session = current;
		nextPoll = Date.now() + POLL_MS;
		if (ctx.mode === "tui") {
			setStatus(ctx, LEFT_KEY, undefined);
			setStatus(ctx, RIGHT_KEY, undefined);
			void current.request({ discover: true, probe: true }).catch(() => {});
			displayTimer = setInterval(() => {
				const ctx = latestCtx;
				if (!ctx || session !== current || current.closed) return;
				publish(ctx);
				if (Date.now() >= nextPoll && !current.busy && ctx.isIdle()) {
					nextPoll = Date.now() + POLL_MS;
					void current.request().catch(() => {});
				}
			}, 1_000);
			displayTimer.unref();
		}
	}
	function currentSession(ctx: ExtensionContext) {
		if (!session || session.closed || session.cwd !== ctx.cwd) start(ctx);
		latestCtx = ctx;
		return session!;
	}
	function schedule(ctx: ExtensionContext) {
		if (ctx.mode !== "tui" || !session || session.closed) return;
		const current = currentSession(ctx);
		if (debounce) clearTimeout(debounce);
		debounce = setTimeout(() => {
			debounce = undefined;
			if (session !== current || current.closed) return;
			nextPoll = Date.now() + POLL_MS;
			void current.request().catch(() => {});
		}, DEBOUNCE_MS);
		debounce.unref();
	}
	pi.on("session_start", (_event, ctx) => start(ctx));
	pi.on("tool_result", (event, ctx) => {
		if (!event.isError && ["write", "edit", "bash", "codemode"].includes(event.toolName)) schedule(ctx);
	});
	pi.on("agent_settled", (_event, ctx) => schedule(ctx));
	pi.on("session_shutdown", async (_event, ctx) => {
		dispose();
		try {
			if (ctx.mode === "tui") {
				ctx.ui.setStatus(LEFT_KEY, undefined);
				ctx.ui.setStatus(RIGHT_KEY, undefined);
			}
		} finally {
			await executions.drain();
		}
	});

	async function command(args: string, ctx: ExtensionContext) {
		if (!ctx.hasUI) throw new Error("/git-monitor requires TUI or RPC mode; no workspace scan was started");
		// Only split the verb: repository names and paths can contain spaces.
		const parsed = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
		const action = parsed?.[1] ?? "view";
		if (!SUBCOMMANDS.includes(action)) { ctx.ui.notify(USAGE, "warning"); return; }
		const name = parsed?.[2]?.trim();
		const current = currentSession(ctx);
		try {
			const snapshot = await current.request({ discover: true, probe: true });
			if (session !== current || current.closed) return;
			nextPoll = Date.now() + POLL_MS;
			const index = name ? snapshot.repositories.findIndex(repo => repo.label === name || repo.path === name) : undefined;
			if (index === -1) { ctx.ui.notify("Repository not in this workspace. Run /git-monitor to see repository names.", "warning"); return; }
			if (action === "status" || action === "s" || ctx.mode === "rpc") {
				ctx.ui.notify((index === undefined ? overview(snapshot) : details(snapshot.repositories[index])).join("\n"), "info");
				return;
			}
			await ctx.ui.custom<void>((tui, theme, _keys, done) =>
				new WorkspaceView(snapshot, theme, () => tui.terminal.rows, () => tui.requestRender(), () => done(), index));
		} catch {
			if (session === current && !current.closed) ctx.ui.notify("Workspace refresh failed", "error");
		}
	}
	pi.registerCommand("git-monitor", {
		description: "Refresh Git repositories: view/v opens a snapshot; status/s prints a report (optional repository)",
		getArgumentCompletions: prefix => {
			const matches = SUBCOMMANDS.filter(value => value.startsWith(prefix));
			return matches.length ? matches.map(value => ({ value, label: value })) : null;
		},
		handler: command,
	});
}
