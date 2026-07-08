// POSITIVE GUARD (flipped) — design/scheduler-audit-2026-06-10.md S-15, fixed
// by RFC-098 WP-8 (design/RFC-098-scheduler-closeout, survey §wp8-wp9).
//
// This file used to be a CURRENT-BEHAVIOR LOCK pinning the three S-15
// indictments (single fire-and-forget SIGTERM, unbounded `await child.exited`,
// write-only nodeRuns.pid). The fix landed; per the FLIP instructions in the
// original header the assertions are now POSITIVE source-text guards for the
// mechanisms that replaced them:
//
//   1. Kill escalation — runner spawns `detached: true` (child = its own
//      process-group leader), `killTree` group-kills via `process.kill(-pid)`
//      with a `safeKill` single-pid fallback, and `armKillEscalation` fires
//      SIGTERM now → unref'd grace timer → SIGKILL. Both the abort and the
//      timeout paths route through it (`startKill`).
//   2. Bounded reaping — `child.exited` and the stdout/stderr pumps race a
//      final reap deadline (grace + margin, armed at first kill / at exit);
//      overrun ⟹ status='failed' + errorMessage='child-unkillable' (with
//      pid), stream readers canceled (`LinePump.cancel`), `child.unref()`.
//   3. pid governance — `util/process.ts` owns isProcessAlive (re-exported
//      from util/lock.ts) + killProcessTree + killStaleRunProcessTree (the
//      kill-then-proceed helper with the 48h startedAt window and the
//      `ps -o command=` PID-reuse gates). orphans.ts kills live orphans
//      before flipping rows; task.ts resumeTask/retryNode kill before the
//      worktree rollback; stuckTaskDetector grew the S5 rule whose detail
//      carries per-run {nodeRunId,nodeId,pid,lastEventTs}.
//
// Behavioral oracles (stubborn child, group kill reaches the grandchild,
// bounded wall clock) live in tests/rfc098-process-governance.test.ts; this
// file only keeps the wiring honest at the source level.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BACKEND_SRC = resolve(import.meta.dir, '..', 'src')
const RUNNER = resolve(BACKEND_SRC, 'services', 'runner.ts')
const ORPHANS = resolve(BACKEND_SRC, 'services', 'orphans.ts')
const STUCK = resolve(BACKEND_SRC, 'services', 'stuckTaskDetector.ts')
const TASK = resolve(BACKEND_SRC, 'services', 'task.ts')
const PROCESS_UTIL = resolve(BACKEND_SRC, 'util', 'process.ts')
const PLATFORM_UTIL = resolve(BACKEND_SRC, 'util', 'platform.ts')
const LOCK_UTIL = resolve(BACKEND_SRC, 'util', 'lock.ts')

function isCommentLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

function nonCommentLines(content: string): string[] {
  return content.split('\n').filter((l) => !isCommentLine(l))
}

function countNonCommentMatches(content: string, re: RegExp): number {
  let n = 0
  for (const line of nonCommentLines(content)) {
    const m = line.match(re)
    if (m) n += m.length
  }
  return n
}

describe('S-15 guard: SIGTERM→SIGKILL escalation + group kill (runner.ts)', () => {
  const runnerSrc = readFileSync(RUNNER, 'utf8')

  test('spawn is detached and killTree group-kills with safeKill fallback', () => {
    // detached: true ⟹ the child is its own process-group leader, the
    // precondition for `-pid` group signals reaching grandchildren.
    expect(countNonCommentMatches(runnerSrc, /detached: true/g)).toBe(1)

    // RFC-windows PR-1: killTree delegates to util/platform.ts `killProcessTree`
    // (POSIX `process.kill(-pid)` byte-for-byte; Windows `taskkill /T /F`),
    // with the single-process `safeKill` as the last-ditch fallback. The
    // `process.kill(-pid, signal)` literal now lives in platform.ts (asserted
    // in the platform guard test) — here we only lock the wiring.
    expect(countNonCommentMatches(runnerSrc, /killProcessTree\(pid, signal\)/g)).toBe(1)
    expect(countNonCommentMatches(runnerSrc, /safeKill\(child, signal\)/g)).toBe(1)
  })

  test('escalation chain exists: SIGTERM now, SIGKILL after the grace timer', () => {
    // armKillEscalation fires the TERM and arms the KILL — exactly one each.
    expect(countNonCommentMatches(runnerSrc, /killTree\(child, 'SIGTERM'\)/g)).toBe(1)
    expect(countNonCommentMatches(runnerSrc, /killTree\(child, 'SIGKILL'\)/g)).toBe(1)

    // Both kill initiators (abort + timeout) route through startKill().
    expect(countNonCommentMatches(runnerSrc, /\bstartKill\(\)/g)).toBe(2)
    expect(countNonCommentMatches(runnerSrc, /armKillEscalation\(/g)).toBeGreaterThanOrEqual(1)

    // The grace timer must be unref'd (a wedged child can't pin bun test).
    expect(runnerSrc).toContain('timer.unref()')
  })

  test('`child.exited` and the pumps are bounded by the reap deadline race', () => {
    // Implementation mechanism is Promise.race against `reapDeadline`
    // (修订条款: this regex is intentionally written for the REAL mechanism —
    // if the bounded wait is reimplemented differently, rewrite this guard
    // alongside it).
    expect(countNonCommentMatches(runnerSrc, /Promise\.race/g)).toBeGreaterThanOrEqual(2)
    expect(countNonCommentMatches(runnerSrc, /reapDeadline\b/g)).toBeGreaterThanOrEqual(3)

    // Overrun ⟹ child-unkillable failure (with pid) + reader cancel + unref.
    expect(countNonCommentMatches(runnerSrc, /child-unkillable/g)).toBeGreaterThanOrEqual(1)
    expect(countNonCommentMatches(runnerSrc, /child\.unref\(\)/g)).toBe(1)
    expect(countNonCommentMatches(runnerSrc, /reader\.cancel\(\)/g)).toBeGreaterThanOrEqual(1)
    expect(countNonCommentMatches(runnerSrc, /stdoutPump\.cancel\(\)/g)).toBeGreaterThanOrEqual(1)
    expect(countNonCommentMatches(runnerSrc, /stderrPump\.cancel\(\)/g)).toBeGreaterThanOrEqual(1)
  })
})

describe('S-15 guard: nodeRuns.pid is consumed by process governance', () => {
  test('util/platform.ts owns the liveness + kill-tree vocabulary; process.ts re-exports + owns the orchestrator; lock.ts re-exports', () => {
    // RFC-windows PR-1: the OS-specific primitives (isProcessAlive / killProcessTree
    // / pidCommandLine) moved to util/platform.ts — the single source of
    // platform branching. util/process.ts re-exports them (callers keep their
    // `@/util/process` import path) and still owns the platform-agnostic
    // killStaleRunProcessTree orchestrator + the 48h startedAt window. The
    // `ps -o command=` POSIX literal moved with pidCommandLine into platform.ts.
    const platformSrc = readFileSync(PLATFORM_UTIL, 'utf8')
    expect(countNonCommentMatches(platformSrc, /export function isProcessAlive/g)).toBe(1)
    expect(countNonCommentMatches(platformSrc, /export function killProcessTree/g)).toBe(1)
    expect(countNonCommentMatches(platformSrc, /export function pidCommandLine/g)).toBe(1)
    // POSIX PID-reuse fingerprint literal lives in platform.ts now.
    expect(platformSrc).toContain("'-o', 'command='")

    const processSrc = readFileSync(PROCESS_UTIL, 'utf8')
    expect(
      countNonCommentMatches(processSrc, /export async function killStaleRunProcessTree/g),
    ).toBe(1)
    // Both PID-reuse noise gates live in the shared helper.
    expect(processSrc).toContain('STALE_RUN_PID_MAX_AGE_MS')
    // Re-exports the platform primitives so callers' import path is stable.
    expect(countNonCommentMatches(processSrc, /export \{/g)).toBeGreaterThanOrEqual(1)
    expect(processSrc).toContain("from './platform'")

    const lockSrc = readFileSync(LOCK_UTIL, 'utf8')
    expect(countNonCommentMatches(lockSrc, /export \{ isProcessAlive \}/g)).toBe(1)
  })

  test('orphan reaper kills live children before flipping rows', () => {
    const orphansSrc = readFileSync(ORPHANS, 'utf8')
    expect(countNonCommentMatches(orphansSrc, /killStaleRunProcessTree\(/g)).toBeGreaterThanOrEqual(
      1,
    )
    expect(countNonCommentMatches(orphansSrc, /\bpid\b/g)).toBeGreaterThan(0)
  })

  test('resumeTask + retryNode kill-then-proceed before the worktree rollback', () => {
    const taskSrc = readFileSync(TASK, 'utf8')
    // ≥ 2 call sites (resume loop + retry target) + the import line.
    expect(countNonCommentMatches(taskSrc, /killStaleRunProcessTree/g)).toBeGreaterThanOrEqual(3)
  })

  test('stuck detector grew the S5 rule and surfaces pid in its detail', () => {
    const stuckSrc = readFileSync(STUCK, 'utf8')
    expect(countNonCommentMatches(stuckSrc, /'S5'/g)).toBeGreaterThanOrEqual(2)
    expect(countNonCommentMatches(stuckSrc, /\bpid\b/g)).toBeGreaterThan(0)
    expect(stuckSrc).toContain('latestEventTsForRun')
  })
})
