# Performance & stability notes — v1 (P-5-12)

This document captures the baseline numbers measured before v1 ships, plus
the bottlenecks worth tracking for v2. Re-run the sweep with:

```
bun run --filter @agent-workflow/backend perf:sweep
```

The script lives at `packages/backend/scripts/perf-sweep.ts`. It seeds
synthetic data into an in-memory database, calls service-level functions
(no HTTP round-trip), and prints a Markdown table. Concurrent-task results
do shell out to a real `git init` so they include real worktree
creation cost.

## Reference machine

The numbers below were captured on:

- darwin arm64 · bun 1.3.13 · 10 CPUs · 64 GiB RAM
- macOS 25.3 · Apple Silicon
- 2026-05-15

Linux CI runners (GitHub `ubuntu-latest`) typically show ~1.5–2× higher
wall times for the diff and concurrent-task scenarios because of slower
SSDs and busier CPUs; the relative rankings hold.

## Raw measurements

| scenario                          | wall time (ms) | RSS delta (KiB) | notes                         |
| --------------------------------- | -------------: | --------------: | ----------------------------- |
| `seed_1000_events_insert`         |              9 |               0 | batched 250 rows / insert     |
| `events_fetch_first_500`          |              3 |           1,408 | full window, no archive on FS |
| `events_fetch_next_500_cursor`    |              2 |           2,192 | cursor pagination from id=500 |
| `events_full_1000_in_one_call`    |              1 |           1,968 | limit cap honored             |
| `seed_100_tasks`                  |              4 |               0 |                               |
| `tasks_list_500_limit`            |              1 |             768 |                               |
| `tasks_list_filter_done`          |              0 |             240 | uses `idx_tasks_status`       |
| `tasks_list_filter_workflow`      |              0 |           1,072 | uses `idx_tasks_workflow`     |
| `diff_generate_10mib`             |              7 |               0 | 1,066 files, 10.00 MiB        |
| `diff_split_per_file`             |              8 |          13,312 |                               |
| `diff_split_per_10_files`         |             10 |          25,456 |                               |
| `diff_split_per_directory_depth2` |             11 |          22,432 |                               |
| `concurrent_10_tasks_wall_time`   |            268 |          49,680 | 10 tasks reach terminal       |
| `agent_node_avg_ms_under_load`    |             17 |               0 | n=10 nodes, max=22ms          |

`RSS delta` is the difference in process RSS immediately before vs. after
each scenario. Values can dip negative on the second run as the GC reaps
allocations from the previous scenario; treat them as ceilings rather
than steady-state usage.

## Findings

### 1. Node-detail page with 1000 events

The `getNodeRunEvents` service hits a single indexed query
(`idx_node_run_events_by_node` does not exist today — see
[issue tracker §1](#issue-tracker)), pulls up to 1000 rows, then walks
them in-process to assemble the response. The hard cap of 1000 rows per
call (`limit = Math.min(opts.limit ?? 500, 1000)`) keeps a single fetch
under 5 ms.

The frontend's polling cadence is 2.5 s on the detail page; even at the
full 1000-event ceiling the page can keep up. We don't need
virtualization or WebSocket-only delivery for v1.

### 2. Task list (100 rows)

`listTasks` returns the full Task shape including
`workflowSnapshot` (full JSON definition). At 100 rows, the resulting
payload is ~140 KiB JSON; serialization dominates over query time. The
table only renders meta columns, so v2 should add a `listTasksLight`
endpoint that omits `workflowSnapshot` and `inputs`. Until then, 100
tasks is comfortable, but the curve is super-linear because the JSON
strings inside each row vary wildly.

### 3. 10 MiB diff splitting

All three strategies run in ~10 ms for a 10 MiB / 1066-file diff. RSS
delta is the parsed-AST array (~13–25 MiB while alive). After the shards
are produced the original `diff` string can drop out of scope, so peak
memory ≈ 10 MiB diff + 25 MiB shard array, well below the 100 MiB v1
operational ceiling.

The `extractLastEnvelope` parser does a single regex pass per call; it
isn't exercised by these numbers but the runner stream-accumulates text
events line-by-line so the same envelope buffer never exceeds the agent
output size.

### 4. 10 concurrent tasks

End-to-end wall time for 10 concurrent task starts (real `git worktree
add`, real subprocess spawn via stub-opencode, full scheduler) is
~270 ms. Per-agent-node wall time averages 17 ms. RSS for the daemon
process climbs ~50 MiB during the burst — most of it the SQLite WAL
cache plus the 10 simultaneous child process pipes.

`maxConcurrentNodes` (default 4) caps the actual parallelism: when 10
tasks each have one agent node, 4 nodes execute at once and the other 6
queue. The 17 ms per-node average is dominated by `git worktree add` +
`Bun.spawn` setup; the stub script itself exits in <1 ms.

There were no flaky failures across the 10-task burst and the WS
broadcasters did not back-pressure (none of the test infra subscribes).
Real subscribers (frontend pages) absorb fewer events per second; the
limit is bound by what we emit (1 status event per node transition),
not what they consume.

## Issue tracker

The bottlenecks below are not blockers for v1. They are listed here so
we don't lose them; create issues in the v2 milestone when ready.

1. ~~**No index on `node_run_events.node_run_id`.**~~ **RESOLVED — this
   entry was stale.** The index exists and covers exactly the composite
   predicate this entry worried about: `idx_events_node` on
   `(node_run_id, id)` (`packages/backend/src/db/schema.ts`, the
   `nodeRunEvents` table), plus `idx_events_session` on
   `(node_run_id, session_id, id)` for the RFC-027 session tree. Corrected
   2026-07-21 — the entry had survived long enough that a fresh audit
   re-reported it as a live performance gap, which is the exact cost of a
   stale doc (see `design/test-guard-audit-2026-07-21` §2 逃逸机制⑧).
   `packages/backend/tests/docs-implementation-parity.test.ts` now keeps
   this entry honest.
2. **`listTasks` returns full `workflowSnapshot`.** Add a "light"
   projection that omits JSON snapshot + inputs; ~50× payload reduction
   on a 100-row page. Frontend hydrates the snapshot on demand via the
   detail endpoint.
3. **Diff parsing is O(diff size) for every API call.** `worktreeDiff`
   re-parses the unified diff via `git diff` each time the task-detail
   page polls (every 5 s). Cache parsed shards on the server side keyed
   by `(taskId, base_commit)` — invalidate on any new node run.
4. **`concurrent_10_tasks_wall_time` is dominated by `git worktree
add`.** Each worktree spawns 2 git child processes; at 10 tasks that
   is 20 subprocess starts in series under the per-task lock. Worktree
   creation is already async per task, so the cost is mostly startup —
   not worth optimizing unless we see complaints. If we do, swap to a
   pool of pre-warmed worktrees per repo.
5. **No back-pressure on `node_run_events` writes.** The runner writes
   each opencode event line as a separate SQLite INSERT. At ~1k
   events/sec the busy_timeout cushions but adds latency. P-5-01's
   events archive runs hourly and removes pressure at rest, but a
   write-coalesce step (batch every 100 ms) would smooth burst load.

## Stability observations

- No flaky failures across 100+ runs of `bun test` and 30+ runs of
  the e2e (`bunx playwright test`). The daemon's signal handler order
  fix (M5 caveat §"`.daemon.info` 终修复") removed the last known race.
- The graceful-shutdown ticker (P-4-06) drains active tasks within 5 s
  in this synthetic environment because the stub-opencode exits
  immediately. Real opencode runs longer; the 30 s budget remains the
  right setting.
- The events archiver wakes hourly. We did **not** measure under-load
  archive cost yet; deferred until a user reports a slow detail-page
  fetch after multiple long-running tasks.
- `worktreeAutoGc` defaults to disabled. Operators who flip it on
  should watch the daemon log on the first cycle — directory walking
  is filesystem-bound and unmetered.

## Re-running

```
bun run --filter @agent-workflow/backend perf:sweep
```

The script writes Markdown to stdout. Paste into this file (under
"Raw measurements") after a meaningful regression to track movement
over time. v2 will fold this into the CI dashboard.
