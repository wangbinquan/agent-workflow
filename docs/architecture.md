# Architecture

A 1-minute overview of how the daemon turns a workflow into a tree of
`opencode` subprocesses. Full detail (with diagrams) lives in
[`design/design.md`](../design/design.md); this file is the operator's
version.

## Processes

```
┌────────────────────────────────────────────────────────────────────┐
│  agent-workflow daemon (one Bun process)                           │
│                                                                    │
│   Hono HTTP/WS  ──┐                       ┌── per-task scheduler   │
│                   │                       │     (level-parallel    │
│  React SPA       Drizzle ──── SQLite      │      Kahn over DAG)    │
│  (embedded in    (WAL + busy_timeout)     │                        │
│   the binary)                              ▼                        │
│                              spawn opencode subprocess per node    │
│                                  (cwd = task worktree)             │
└────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                ┌────────────────────────────────────┐
                │ opencode CLI                       │
                │   OPENCODE_CONFIG_CONTENT=<agent>  │
                │   OPENCODE_CONFIG_DIR=<runs/…>     │
                │   cwd=<worktrees/repo/task/>       │
                └────────────────────────────────────┘
```

- **One daemon per machine.** A PID-file lock at `~/.agent-workflow/.daemon.lock`
  enforces single-instance; `agent-workflow stop` SIGTERMs it.
- **One `opencode` subprocess per node run.** The platform never reuses a
  process across nodes. Audit-style fan-out launches N parallel subprocesses,
  each with its own narrow context.
- **No subagent inside opencode.** All inter-agent message passing happens at
  the framework layer — that is the whole point of this project.

## Data model

Eight SQLite tables (see `packages/backend/src/db/schema.ts`):

| Table              | Purpose                                                    |
| ------------------ | ---------------------------------------------------------- |
| `agents`           | Frontmatter fields + body markdown. DB is the source.      |
| `skills`           | Name + path index. **Files on disk are the source.**       |
| `workflows`        | `definition` JSON blob + auto-incrementing `version`       |
| `tasks`            | One per launch: workflow snapshot, status, worktree path   |
| `node_runs`        | One row per node attempt (retries get distinct rows)       |
| `node_run_outputs` | Parsed `<port>` values from the agent's envelope           |
| `node_run_events`  | Streamed opencode stdout/stderr/text events                |
| `recent_repos`     | Picker history for the launcher                            |

The events table is the only one that grows linearly with run length. A
background ticker archives rows beyond
`config.eventsArchiveThresholds` into JSONL files under `~/.agent-workflow/logs/`
so the DB stays fast; the events API stitches archive + DB transparently.

## Per-task lifecycle

1. **`startTask` HTTP call** — validates the launcher payload, snapshots the
   workflow definition into `tasks.workflow_snapshot`, and `git worktree add`s
   a fresh worktree under `~/.agent-workflow/worktrees/<repo-slug>/<task-id>`
   on the chosen base branch.
2. **Scheduler** — Kahn's algorithm over the snapshot's DAG. Ready nodes run in
   parallel under four semaphores (all hot-applied on a settings save, RFC-266):
   - daemon-wide **agent pool** (`config.maxConcurrentNodes`) — agent nodes,
     workgroup host nodes, fan-out shards and aggregators
   - daemon-wide **script pool** (`config.maxConcurrentScriptNodes`) — RFC-253
     script nodes, fully independent of the agent pool
   - per-task **write semaphore** (capacity 1; held only across
     snapshot-at-dispatch and merge-back, not across a node's whole run —
     RFC-130 gave every node its own isolated worktree)
   - per-task fan-out sub-pool (`config.multiProcessSubprocessConcurrency`),
     applied *inside* an agent-pool slot
3. **Per node** — record a `pre_snapshot` (cheap `git stash create` SHA),
   spawn `opencode` with the agent injected via `OPENCODE_CONFIG_CONTENT` and
   the per-process skills directory via `OPENCODE_CONFIG_DIR`. Stream stdout
   into `node_run_events`; the last `<workflow-output>…</workflow-output>`
   envelope is parsed into `node_run_outputs`. On failure, retry up to the
   node's `retries` budget — each attempt is rolled back to its pre_snapshot
   first.
4. **Fan-out (`agent-multi`)** — wait for `sourcePort`'s upstream run, split
   the diff by the node's sharding strategy (per-file / per-N-files /
   per-directory), then spawn one child node_run per shard with `shard_key`
   set. Each declared output port concatenates child values in shard_key
   lexicographic order; an automatic `errors` port lists failed shards.
5. **Wrappers** — `wrapper-git` runs inner nodes in their own scope, captures
   `HEAD-before` vs `HEAD-after + dirty worktree` as `git_diff`. `wrapper-loop`
   iterates inner scope up to `maxIterations`, exiting when an exit-condition
   evaluator returns true; v1 has no cross-iteration feedback port — share
   state via worktree files only. Wrappers nest arbitrarily.

## Process isolation

Each opencode subprocess gets a private `OPENCODE_CONFIG_DIR` (so two
parallel agents never write to the same `~/.opencode/agents`) and its own
`OPENCODE_CONFIG_CONTENT` inline JSON. `cwd` is the task's worktree, so
`git diff` inside the agent sees only that task's changes.

## Token + auth

`/api/*` and `/ws/*` require the daemon token. The first start auto-generates
a 64-char hex token in `~/.agent-workflow/token` (mode 0600); subsequent
starts reuse it. The browser receives it as a query-string parameter in the
ready URL; the SPA persists it in `localStorage`.
