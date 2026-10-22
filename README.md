# pi-git-monitor

Shows where work needs attention across a workspace's Git repositories.
The footer gives a compact summary; `/git-monitor` opens a read-only overview
with branch, working-tree and locally known upstream status.

Previously published as `pi-footer-workspace`; the command, root flag and config
filename now use `git-monitor`. Replace the old installation and, if present,
rename `.pi/workspace.json` to `.pi/git-monitor.json` when migrating.

This is useful when Pi runs in an outer development repository and the products
live in separate repositories underneath it. Product repositories are discovered
even if the outer repository ignores them. The extension also retains a small
`(ro)` marker for a working directory that cannot be written to, such as a
read-only container mount.

## Installation and first use

Requires **Pi 1.0.2 or newer** and Git on `PATH`.

Install this extension from GitHub:

```bash
pi install git:github.com/7h145/pi-git-monitor
```

For first-line footer placement, also install the optional
[`pi-footer-compositor`](https://github.com/7h145/pi-footer-compositor):

```bash
pi install git:github.com/7h145/pi-footer-compositor
```

These are personal/global installs. Add `-l` to each command for project-local
installs. The compositor is not installed automatically; without it, Pi shows
the same values on its ordinary extension-status line. This extension uses only
Pi's public status API and does not patch or replace the footer.

Run `/reload` after installing or updating while Pi is running, then run:

```text
/git-monitor
```

The view lists discovered repositories. Use **↑/↓** or **j/k** to select one,
**Enter** to see its path and changed files, and **Esc** or **q** to go back or
close. **PgUp/PgDn** move through longer lists; **n** opens workspace notices,
including discovery and writability errors. Details and notices wrap long lines
and can be scrolled.

To try a local checkout without installing, run from its root:

```bash
pi --no-extensions -e .
```

This loads only the checkout's extension, without the optional compositor or
duplicate installed copies. Then run `/git-monitor`.

## Workspace scope

By default, the workspace root is the Git worktree containing Pi's working
directory. If there is no containing worktree, it is the working directory
itself. Discovery includes:

- the worktree containing that root, if any;
- Git worktrees in the root's **immediate child directories**.

It does not recursively crawl deeper directories or follow child-directory
symlinks automatically. Linked worktrees and submodules with a `.git` file are
recognized. Different linked worktrees remain separate; aliases to the same
worktree are counted once. Bare repositories are not working trees and are not
included.

Starting Pi inside a product scopes the overview to that product, not to its
siblings. To keep the larger workspace visible, specify its root:

```bash
cd /stage/product
pi --git-monitor-root /stage
```

The flag is registered by this extension, so the extension must be loaded.
Relative flag paths resolve against Pi's startup working directory.

### Include or exclude repositories

Create `.pi/git-monitor.json` under the **workspace root**: the directory selected
by `--git-monitor-root`, or by default the Git worktree containing Pi's working
directory (the working directory itself if it is outside Git).

```json
{
  "include": ["components/service", "../shared-library"],
  "exclude": ["archived-product"]
}
```

Relative paths in both lists resolve against that workspace root, **not the
`.pi` directory**. For example, with `--git-monitor-root /stage`, the file is
`/stage/.pi/git-monitor.json`, and the entries above resolve to:

- `components/service` → `/stage/components/service`;
- `../shared-library` → `/shared-library`;
- `archived-product` → `/stage/archived-product`.

This base stays `/stage` even when Pi starts inside `/stage/product`. Absolute
paths are used directly. Entries identify exact worktree roots, not glob
patterns. Includes can opt into deeper paths, symlinked paths or repositories
outside the root. Exclusions override both automatic discovery and includes.
If the root is a worktree, excluding `"."` removes it but leaves its products.

The file is optional; both lists default to empty. Unknown settings, invalid
JSON and invalid path lists are reported rather than silently ignored. A missing
or invalid included repository is a discovery notice. Run `/git-monitor` after
changing the configuration or adding/removing a repository.

## Footer summary

Examples:

```text
git 6 clean
git 2/6 dirty
git 2/6 dirty, 1 unknown
```

The denominator is the number of identified worktrees, including the outer
repository unless excluded. “Dirty” means at least one changed or untracked
path. “Unknown” means a known repository's current status could not be obtained;
it is never assumed clean.

`scope ?` means discovery was incomplete, so the identified repositories may
not cover the configured workspace. If no roots could be identified, the footer
shows `git scope ?`. With no repositories and no discovery errors, no Git
segment is shown.

Clean summaries use Pi's success color, dirty or unknown summaries use its
warning color, and a repository with conflicts makes the summary use its error
color. A trailing `?`, such as `git 6 clean?`, means the snapshot is at least
one minute old. Theme styling and snapshot age are checked once per second,
without additional Git requests.

The `(ro)` marker describes **Pi's working directory**, not the workspace root
selected by the flag and not every product mount. It is checked at startup, when
the working directory changes and on manual refresh. The probe briefly creates
and removes a unique file there. Permission/read-only failures show `(ro)`;
other probe failures and cleanup failures appear in workspace notices.

## Inspecting repositories

`/git-monitor` refreshes discovery, Git status and writability before opening a
snapshot. It waits for its own refresh, including when another scan is running.
The view does not update underneath you; close and reopen it for a new snapshot.

The overview shows repository names, branches, working-tree state and upstream
state. Select a repository for its full path and changes. A path changed in both
the index and worktree counts once; untracked files are counted individually,
including files beneath untracked directories. The extension explicitly requests
untracked files even if `status.showUntrackedFiles` hides them in ordinary
`git status` output. Ignored files remain ignored.

Changed-file details show Git's two status columns: **index / worktree**.
`.` means unchanged, `?` untracked, `M` modified, `A` added, `D` deleted,
`R` renamed, `C` copied, `T` type changed, and `U` unmerged. Rename details
also show the original path. Control characters in paths are escaped for display.

Every command refreshes before displaying its snapshot:

| Command | Output |
|---|---|
| `/git-monitor` | Interactive overview |
| `/git-monitor view` or `/git-monitor v` | Interactive overview |
| `/git-monitor view <repo>` or `/git-monitor v <repo>` | Interactive repository details |
| `/git-monitor status` or `/git-monitor s` | Textual overview |
| `/git-monitor status <repo>` or `/git-monitor s <repo>` | Textual repository details |

`<repo>` is a displayed repository name or full path. Everything after the
subcommand is the selector, so names and paths containing spaces need no quotes.
Tab completes the long and short subcommands. Explicit subcommands also let you
select a repository named `status`, for example `/git-monitor v status`.

Ahead/behind counts use **local tracking refs**. The extension does not fetch,
so “up to date” is not a claim about the remote's present state. No upstream
is shown as `—`; unavailable counts or Git failures are shown explicitly.

## Refresh behavior and limits

In TUI mode, known repositories are refreshed every 15 seconds while Pi is
idle. File-changing built-in tools, `codemode` and the settled-agent event
schedule a refresh after a 500 ms debounce. Ordinary read-tool results do not.
Polls reuse the discovered repository list. Startup and manual commands repeat
discovery; if initial discovery fails entirely, polling retries it until a list
is available.

At most two Git executions remain outstanding per loaded extension, including
executions whose requests have already timed out or whose sessions were replaced.
Git requests have a two-second waiting deadline, including any wait for an
execution slot; interrupted, failed or malformed results are not presented as
clean. Background failures do not produce repeated notifications.

Each session owns its queue and cached data. Shutdown, replacement and reload
abort pending Git requests, release waiting commands and suppress late output.
The shutdown handler also waits for the underlying executions to finish, so Pi
can reap its Git children before exiting or unloading the extension. This includes
executions left outstanding by earlier deadlines or replaced sessions. A pending
filesystem probe can still finish its cleanup afterward.

The two-second request deadline is not a shutdown deadline. If Git or Pi's
execution helper does not finish after cancellation, shutdown can remain waiting.
Forcibly terminating Pi can bypass cleanup and leave orphaned children.

Filesystem operations are subject to the filesystem's own responsiveness; the
Git deadline is not a deadline for the entire workspace refresh. Large worktrees
and many untracked files can make scans expensive. Discovery notices, Git
failures and stale snapshots remain visible rather than implying a complete,
fresh result.

RPC mode supports manual commands through notifications. `/git-monitor`,
`view`/`v` and `status`/`s` all return a textual overview, or details when a
repository is specified. RPC performs no automatic polling and publishes no
footer status. Print and JSON modes reject commands before scanning because
their UI output would not be visible.

All Git commands inspect local state with optional index updates disabled.
The extension does not stage, commit, switch, push or fetch, does not send
workspace data to a model, and does not read changed-file contents or diffs. The only
working-directory write is its temporary writability probe. It also reads the
optional configuration file.

## Migrating from pi-assorted

If the legacy [`pi-assorted`](https://github.com/7h145/pi-assorted) collection is
installed, disable its workspace extension before installing this standalone
version to avoid duplicate registration.

Run `pi config` in a terminal. Under the collection's Extensions entries,
uncheck `pi-footer-workspace/pi-footer-workspace.ts` with Space. Changes are
saved immediately; Esc closes the dialog. For a project-local collection, use
`pi config -l` from that project and select `[-]` (project unload).

If installing the compositor separately, also disable its
`pi-footer-compositor/pi-footer-compositor.ts` collection entry. Do not run the
older standalone `footer-status.ts` patch alongside the compositor.

See Pi's [resource settings reference](https://pi.dev/docs/latest/settings#resources)
for details.

## Development

Use Node.js 24 or newer:

```bash
npm ci
npm run check
```

`check` runs strict TypeScript checks and Node's regression tests. Tests use
disposable local Git repositories, Pi's execution helper and synthetic failures;
they do not fetch or contact a model provider. Disposable commits disable automatic
maintenance to avoid detached background jobs. The Linux process-lifecycle test
uses `mkfifo` from coreutils to hold a Git request pending during shutdown; it is
skipped on other platforms. CI runs these checks on Node.js 24 with Pi SDKs 1.0.2
and 1.1.0.

The entry point registers flags, commands and lifecycle hooks. `src/discovery.ts`
owns workspace scope and configuration, `src/git.ts` collects and parses Git
status, `src/execution.ts` retains and limits underlying executions across
sessions, `src/session.ts` owns requests and cancellation, and `src/view.ts`
renders the read-only snapshot. `src/probe.ts` limits cleanup to probes it created.

## Last confirmed working

| Date | Code revision | Pi | Node.js | Platform | Git |
|---|---|---|---|---|---|
| 2026-10-11 | `3cdaea1` | `1.1.0` | `26.10.0` | Linux x64 | `2.47.3` |

**Checked:** 68 automated regression tests and type checking; isolated scripted
regular/fullscreen TUI with actual disposable Git repositories, with and without
the compositor. Checks covered multi-repository summaries, the explicit root
from inside a product, a read-only working directory, command navigation,
escaped filenames, resizing, notices, reload and exit. Manual RPC reports also
passed; print/JSON mode guards were checked by automated tests. Type checking
and all 68 tests additionally passed with Pi SDKs 1.0.2 and 1.1.0 on Node.js
24.21.0. Fault cases used synthetic failures; no remote or model was contacted.

One known-working configuration, not a supported-version range.
