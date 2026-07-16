// RFC-202 — source-text locks for wiring that is impractical to drive in a
// unit harness (scheduler abort checkpoints, runner persist branch, frontend
// inline judgments). Per CLAUDE.md's test policy these are the minimum
// regression fence when runtime coverage of a giant component is not
// feasible; the behavioral contracts themselves are locked in
// rfc202-lifecycle-exits.test.ts / rfc202-empty-review-auto-approve.test.ts.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..', '..')
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8')

describe('RFC-202 source locks', () => {
  test('scheduler abort checkpoints thread signal.reason into cancelTaskRow', () => {
    const src = read('packages/backend/src/services/scheduler.ts')
    // All four checkpoints must pass the abort reason — dropping it silently
    // reverts daemon shutdowns to "canceled by user" (audit P1 F-13).
    const threaded = src.match(/cancelTaskRow\(db, taskId(?:, [^)]*)?opts\.signal\??\.reason\)/g)
    expect(threaded?.length ?? 0).toBeGreaterThanOrEqual(4)
    expect(src).toContain('DAEMON_SHUTDOWN_ABORT_REASON')
    expect(src).toContain("to: 'interrupted'")
  })

  test('runner persists shutdown-aborted node_runs as interrupted (resume rollback eligibility)', () => {
    const src = read('packages/backend/src/services/runner.ts')
    expect(src).toContain('DAEMON_SHUTDOWN_ABORT_REASON')
    expect(src).toMatch(/persistedStatus\s*=/)
    // resume's rollback-target selection only covers failed/interrupted; a
    // 'canceled' row would be revived WITHOUT rollback (dirty worktree).
    expect(src).toContain("? 'interrupted'")
  })

  test('shutdown survivors + checkpoint interrupts stamp the summary autoResume matches', () => {
    const shutdown = read('packages/backend/src/services/shutdown.ts')
    expect(shutdown).toContain('DAEMON_RESTART_ERROR_SUMMARY')
    expect(shutdown).not.toContain("errorSummary: 'daemon-shutdown'")
    expect(shutdown).toContain('abortAllActiveTasks(DAEMON_SHUTDOWN_ABORT_REASON)')
  })

  test('frontend cancel affordance covers awaiting_review/awaiting_human', () => {
    const src = read('packages/frontend/src/routes/tasks.detail.tsx')
    const cancelable = src.slice(
      src.indexOf('const cancelable'),
      src.indexOf('const cancelable') + 400,
    )
    expect(cancelable).toContain("'awaiting_review'")
    expect(cancelable).toContain("'awaiting_human'")
  })

  test('clarify detail wires the sealed-round copy (both causes) and the sealed footer', () => {
    const src = read('packages/frontend/src/routes/clarify.detail.tsx')
    expect(src).toContain('clarify.roundSealedByTaskTerminal')
    expect(src).toContain('clarify.roundDismissedByAutonomous')
    expect(src).toContain('clarify.detail.roundSealedFooter')
    for (const bundle of [
      'packages/frontend/src/i18n/zh-CN.ts',
      'packages/frontend/src/i18n/en-US.ts',
    ]) {
      const b = read(bundle)
      expect(b).toContain('roundSealedByTaskTerminal')
      expect(b).toContain('roundDismissedByAutonomous')
      expect(b).toContain('roundSealedFooter')
      expect(b).toContain("'task-terminal'")
      expect(b).toContain("'clarify-round-terminal'")
      expect(b).toContain("'workflow-scheduled-referenced'")
      expect(b).toContain('resumeFailedAfterSubmit')
    }
  })

  test('terminal hook is registered exactly once, at daemon assembly', () => {
    const start = read('packages/backend/src/cli/start.ts')
    expect(start.match(/registerTerminalTaskHook\(/g)?.length).toBe(1)
    // lifecycle.ts must not import clarify/review/terminalSweep (module cycle
    // → binary-build hazard); the hook stays a registration.
    const lifecycle = read('packages/backend/src/services/lifecycle.ts')
    expect(lifecycle).not.toContain("from '@/services/terminalSweep'")
    expect(lifecycle).not.toContain("from '@/services/review'")
    expect(lifecycle).not.toContain("from '@/services/clarify")
  })

  test('resume-failure surfacing is wired on all three submit surfaces', () => {
    for (const [file, marker] of [
      ['packages/frontend/src/routes/reviews.detail.tsx', 'resumeFailedAfterSubmit'],
      ['packages/frontend/src/routes/clarify.detail.tsx', 'resumeFailedAfterSubmit'],
      ['packages/frontend/src/components/tasks/TaskQuestionList.tsx', 'resumeFailedAfterSubmit'],
    ] as const) {
      expect(read(file)).toContain(marker)
    }
  })
})
