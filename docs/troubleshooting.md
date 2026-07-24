# Troubleshooting

## `another daemon is already running`

The PID file at `~/.agent-workflow/.daemon.lock` is held. Either run
`agent-workflow stop` first, or — if the file is stale (process is gone) —
delete it manually:

```bash
rm ~/.agent-workflow/.daemon.lock
```

`agent-workflow status` will tell you whether the lock's PID is alive.

## OpenCode shows `not found`, `unlaunchable`, or `protocol incompatible`

OpenCode is optional and never prevents the daemon from starting. There is no
minimum, maximum, or exact supported OpenCode version. `--version` output is
telemetry only, including non-semver output.

- `not found`: the configured path/PATH token does not resolve.
- `unlaunchable`: the selected file cannot be executed or frozen into the
  private run snapshot.
- `protocol incompatible`: the binary launched, but its direct API behavior
  does not satisfy the current `opencode-direct-v1` codec.
- `containment blocked`: `sandboxMode=enforce` was selected and the active
  platform provider does not satisfy the required containment capabilities.
- `degraded`: `sandboxMode=warn` permits execution without the missing
  containment guarantees; the UI and lifecycle alert state exactly what is
  missing.

Select a specific binary when PATH is not the intended one:

```bash
agent-workflow config set opencodePath /absolute/path/to/opencode
```

Then use Settings → Runtime → Test. Upgrading or downgrading OpenCode is one
possible fix for a real protocol incompatibility, but version ordering itself
is never the admission decision.

## `task-cannot-start` / worktree errors

The launcher creates a `git worktree` at
`~/.agent-workflow/worktrees/<repo-slug>/<task-id>` before running anything.
If the repo has uncommitted state on the requested base branch, the worktree
add can fail. Resolutions:

- Commit or stash in the source repo first.
- Pick a different base branch in the launcher (the dropdown shows local
  branches; you can also paste a commit SHA).

Old worktrees from cancelled tasks accumulate under
`~/.agent-workflow/worktrees/`. Settings → **GC → Auto-GC merged worktrees**
sweeps them hourly; you can also delete the directory manually after a task
reaches a terminal state.

## Browser cannot reach the daemon

The default `bindHost` is `127.0.0.1` (loopback only). To bind to all
interfaces (e.g. for SSH tunneling from another host):

```bash
agent-workflow config set bindHost 0.0.0.0
agent-workflow config set bindPort 7700
agent-workflow stop && agent-workflow start
```

The Settings page now shows a **restart required** banner when you change
either field.

The token is **not** firewall-grade auth. Don't expose the daemon on the
public internet; tunnel via SSH or run it inside a private network.

## A node hangs / never finishes

The daemon enforces three limits per `~.agent-workflow/config.json`:

- `defaultPerNodeTimeoutMs` (30 min) — exceeded → node SIGTERM'd, run row
  marked `failed` with `node-timeout: exceeded Nms`.
- `defaultPerTaskMaxDurationMs` (1 h) — exceeded → task cancelled, summary
  `task-time-limit-exceeded`.
- `defaultPerTaskMaxTotalTokens` (0 = off) — exceeded → task cancelled,
  summary `task-token-limit-exceeded`.

Cancel a stuck task explicitly from the UI's task detail page (status flips
to `canceled`, worktree is preserved) or via
`POST /api/tasks/:id/cancel`.

## Resume after daemon crash

On daemon start, any task still in `running` is flipped to `interrupted`
with `errorSummary=daemon-restart`, and every in-flight `node_run` is
flipped to `interrupted` too. Use the task detail page's **Resume** button
to re-run from where it stopped — each retried node is rolled back to its
`pre_snapshot` (a `git stash create` SHA recorded before the node started).

## Where did my events go?

The events table is capped at `eventsArchiveThresholds.globalRows`
(default 1M) and per-node-run rows at `perNodeRunRows` (default 50k). An
hourly background ticker archives the oldest rows to JSONL files under
`~/.agent-workflow/logs/<task-id>/<node-run-id>.jsonl`. The events API
stitches archive + DB transparently — you should not notice except as a
slight pause when scrolling very long event lists.

## Backups

`agent-workflow backup` (or the Settings page button) writes a single
`tar.gz` to `~/.agent-workflow/backups/agent-workflow-<ISO-timestamp>.tar.gz`
containing:

- `db.sqlite` (via SQLite `VACUUM INTO`, point-in-time consistent)
- `config.json`
- `skills/` (managed skills' full trees)
- `workflows/*.yaml` (re-exported from the DB)

Explicitly **not** included: `worktrees/`, `runs/`, `logs/`, `token`.
Restore by extracting into a fresh `~/.agent-workflow/` and starting the
daemon.

## Verbose logs

```bash
agent-workflow config set logLevel debug
agent-workflow stop && agent-workflow start
# or
LOG_LEVEL=debug agent-workflow start    # one-off override
```

Daemon logs land in `~/.agent-workflow/logs/daemon.log` (10 MiB × 5 rotated).
