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
    const application = read(
      'packages/backend/src/modules/task-execution/composition/taskEngineApplication.ts',
    )
    const scheduler = read('packages/backend/src/services/scheduler.ts')
    // All four checkpoints must pass the abort reason — dropping it silently
    // reverts daemon shutdowns to "canceled by user" (audit P1 F-13). RFC-331
    // makes the application-owned topology the required first argument.
    const threaded = application.match(
      /cancelTaskRow\(\s*topology,\s*db,\s*taskId,[\s\S]{0,180}?opts\.signal\??\.reason,\s*opts\.executionContext\s*,?\s*\)/g,
    )
    expect(threaded?.length ?? 0).toBeGreaterThanOrEqual(4)
    expect(scheduler).toContain('DAEMON_SHUTDOWN_ABORT_REASON')
    expect(scheduler).toContain("to: 'interrupted'")
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
    expect(shutdown).toContain(
      'shutdownActiveTaskExecutions(DAEMON_SHUTDOWN_ABORT_REASON, budgetMs)',
    )
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
    expect(src).toContain('clarify.roundDismissedNoHuman')
    expect(src).toContain('clarify.detail.roundSealedFooter')
    for (const bundle of [
      'packages/frontend/src/i18n/zh-CN.ts',
      'packages/frontend/src/i18n/en-US.ts',
    ]) {
      const b = read(bundle)
      expect(b).toContain('roundSealedByTaskTerminal')
      expect(b).toContain('roundDismissedNoHuman')
      expect(b).toContain('roundSealedFooter')
      expect(b).toContain("'task-terminal'")
      expect(b).toContain("'clarify-round-terminal'")
      expect(b).toContain("'workflow-scheduled-referenced'")
      expect(b).not.toContain('resumeFailedAfterSubmit')
    }
  })

  test('terminal sweep is owned by the committed-event consumer with no ambient hook slot', () => {
    const start = read('packages/backend/src/cli/start.ts')
    const consumers = read(
      'packages/backend/src/modules/task-execution/application/taskLifecycleConsumers.ts',
    )
    expect(start).toContain('createTaskLifecycleDurableConsumerDefinitions')
    expect(start).toContain('sealOpenHumanGatesForTask')
    expect(consumers).toContain("id: 'task-terminal-gate-close'")
    expect(start).not.toContain('registerTerminalTaskHook')
    const lifecycle = read('packages/backend/src/platform/persistence/sqlite/taskLifecycle.ts')
    expect(lifecycle).not.toContain('registerTerminalTaskHook')
    expect(lifecycle).not.toContain("from '@/services/terminalSweep'")
    expect(lifecycle).not.toContain("from '@/services/review'")
    expect(lifecycle).not.toContain("from '@/services/clarify")
  })

  test('durable decision receipts remove all three obsolete resume-failure branches', () => {
    for (const file of [
      'packages/frontend/src/routes/reviews.detail.tsx',
      'packages/frontend/src/routes/clarify.detail.tsx',
      'packages/frontend/src/components/tasks/TaskQuestionList.tsx',
    ]) {
      expect(read(file)).not.toContain('resumeFailedAfterSubmit')
    }
  })
})
