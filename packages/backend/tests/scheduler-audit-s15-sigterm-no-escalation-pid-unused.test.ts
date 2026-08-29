// POSITIVE GUARD (flipped) — design/scheduler-audit-2026-06-10.md S-15, fixed
// by RFC-098 WP-8 (design/RFC-098-scheduler-closeout, survey §wp8-wp9).
//
// This file used to be a CURRENT-BEHAVIOR LOCK pinning the three S-15
// indictments (single fire-and-forget SIGTERM, unbounded `await child.exited`,
// write-only nodeRuns.pid). The fix landed; per the FLIP instructions in the
// original header the assertions are now POSITIVE source-text guards for the
// mechanisms that replaced them:
//
//   1. Kill escalation — POSIX spawns detached (child = its own process-group
//      leader), while Windows stays flat because its tree kill uses Job
//      Object/taskkill and detached Bun children can lose output. `killTree`
//      delegates both host shapes to the same SIGTERM → grace → SIGKILL chain.
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
const MANAGED_PROCESS = resolve(BACKEND_SRC, 'services', 'execution', 'managedProcess.ts')
const ORPHANS = resolve(BACKEND_SRC, 'services', 'orphans.ts')
const STUCK = resolve(BACKEND_SRC, 'services', 'stuckTaskDetector.ts')
const TASK = resolve(BACKEND_SRC, 'services', 'task.ts')
const PROCESS_UTIL = resolve(BACKEND_SRC, 'util', 'process.ts')
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

describe('S-15 guard: SIGTERM→SIGKILL escalation + group kill (managedProcess.ts)', () => {
  // RFC-280 T7: the kill-escalation + bounded-reap mechanism moved OUT of
  // runner.ts into the unified process primitive (services/execution/
  // managedProcess.ts). The runner now delegates the whole child lifecycle to
  // runAgentProcess; these guards follow the mechanism to its new home. The
  // behavioral oracles (stubborn child, group kill reaches the grandchild,
  // bounded wall clock) still live in tests/rfc098-process-governance.test.ts.
  const mpSrc = readFileSync(MANAGED_PROCESS, 'utf8')
  const runnerSrc = readFileSync(RUNNER, 'utf8')

  test('spawn uses POSIX groups, keeps Windows flat, and delegates tree kill', () => {
    // POSIX needs a process-group leader for `-pid`; Windows has no such group
    // and uses Job Object/taskkill. Keeping the predicate explicit also locks
    // the Windows output fix shared with spawnVersionProbe.
    expect(countNonCommentMatches(mpSrc, /detached: process\.platform !== 'win32'/g)).toBe(1)
    // killTree delegates the group signal to killProcessTree (util/process),
    // keeping the single-process `child.kill` fallback.
    expect(countNonCommentMatches(mpSrc, /killProcessTree\(pid, signal\)/g)).toBe(1)
    expect(mpSrc).toContain("child.kill(signal === 'SIGKILL' ? 9 : 15)")
    // The runner no longer spawns or kills directly — it hands the child to the
    // unified executor.
    expect(runnerSrc).toContain('await runAgentProcess({')
    expect(countNonCommentMatches(runnerSrc, /Bun\.spawn\(/g)).toBe(0)
  })

  test('escalation chain exists: SIGTERM now, SIGKILL after the grace timer', () => {
    // managedProcess `escalate()` fires SIGTERM immediately, arms an unref'd
    // grace timer, then SIGKILLs.
    const escStart = mpSrc.indexOf('const escalate = (): void => {')
    const escEnd = mpSrc.indexOf('\n  const onAbort', escStart)
    expect(escStart).toBeGreaterThan(-1)
    expect(escEnd).toBeGreaterThan(escStart)
    const escSrc = mpSrc.slice(escStart, escEnd)
    expect(countNonCommentMatches(escSrc, /killTree\(child, 'SIGTERM'\)/g)).toBe(1)
    expect(countNonCommentMatches(escSrc, /killTree\(child, 'SIGKILL'\)/g)).toBe(1)
    // The grace timer must be unref'd (a wedged child can't pin bun test).
    expect(escSrc).toContain('killTimer.unref()')
    // Both the caller abort and the timeout route through the same escalate().
    expect(countNonCommentMatches(mpSrc, /\bescalate\(\)/g)).toBeGreaterThanOrEqual(2)
  })

  test('child.exited and the pumps are bounded by a drain deadline', () => {
    // managedProcess races the pump drain against a bounded deadline; a child
    // that survives SIGKILL past it is reported `child-unkillable`, which the
    // agent adapter maps to `unreaped` and the runner turns into a
    // child-unkillable failure (with pid).
    expect(countNonCommentMatches(mpSrc, /Promise\.race/g)).toBeGreaterThanOrEqual(1)
    expect(mpSrc).toContain("outcome = 'child-unkillable'")
    expect(countNonCommentMatches(mpSrc, /\.cancel\(\)/g)).toBeGreaterThanOrEqual(2)
    // The runner still surfaces the child-unkillable terminal state (with pid).
    expect(countNonCommentMatches(runnerSrc, /child-unkillable/g)).toBeGreaterThanOrEqual(1)
    expect(runnerSrc).toContain("runResult.outcome === 'unreaped'")
  })
})

describe('S-15 guard: nodeRuns.pid is consumed by process governance', () => {
  test('util/process.ts owns the liveness + kill-tree vocabulary; lock.ts re-exports', () => {
    const processSrc = readFileSync(PROCESS_UTIL, 'utf8')
    expect(countNonCommentMatches(processSrc, /export function isProcessAlive/g)).toBe(1)
    expect(countNonCommentMatches(processSrc, /export function killProcessTree/g)).toBe(1)
    expect(
      countNonCommentMatches(processSrc, /export async function killStaleRunProcessTree/g),
    ).toBe(1)
    // Both PID-reuse noise gates live in the shared helper.
    expect(processSrc).toContain('STALE_RUN_PID_MAX_AGE_MS')
    expect(processSrc).toContain("'-o', 'command='")

    const lockSrc = readFileSync(LOCK_UTIL, 'utf8')
    expect(countNonCommentMatches(lockSrc, /export \{ isProcessAlive \}/g)).toBe(1)
  })

  test('orphan reaper kills live children before flipping rows', () => {
    const orphansSrc = readFileSync(ORPHANS, 'utf8')
    // RFC-224 introduced an injectable kill dependency so boot-recovery tests
    // can prove fail-closed capability issuance. Production still falls back to
    // the same helper, and the awaited kill remains before the status flip.
    const killCall = '(dependencies.killStaleRunProcessTree ?? killStaleRunProcessTree)(r, {'
    const killIdx = orphansSrc.indexOf(killCall)
    const flipIdx = orphansSrc.indexOf('await transitionNodeRunStatus({', killIdx)
    expect(killIdx).toBeGreaterThan(-1)
    expect(flipIdx).toBeGreaterThan(killIdx)
    expect(
      countNonCommentMatches(orphansSrc, /killStaleRunProcessTree \?\? killStaleRunProcessTree/g),
    ).toBe(1)
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
