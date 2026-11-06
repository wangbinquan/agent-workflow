// RFC-083 — eager on-disk persistence of the task-scope structural diff (so the
// view survives worktree-GC). File-based (no DB migration), best-effort.
// RFC-453: the two standalone-file helpers (`writeStoredDiff` / `readStoredDiff`, only used here) were deleted;
// the same round trip runs through the standalone artifact store they wrapped (generation `null`).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeLocalCodeReviewArtifacts } from '../src/modules/workspace-insight/composition/codeReviewArtifacts'
import { isTerminalTaskStatus } from '../src/modules/workspace-insight/domain/structuralDiff/terminalStatus'
import { computeSummary, type StructuralDiff } from '@agent-workflow/shared'

let home: string
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'aw-sd-store-'))
  process.env.AGENT_WORKFLOW_HOME = home
})
afterAll(() => {
  delete process.env.AGENT_WORKFLOW_HOME
  rmSync(home, { recursive: true, force: true })
})

function sample(taskId: string): StructuralDiff {
  return {
    scope: 'task',
    taskId,
    fromRef: 'base',
    toRef: 'WORKTREE',
    engine: 'baseline',
    status: 'ok',
    files: [],
    dependencyChanges: [],
    impact: [],
    classEdges: [],
    summary: computeSummary([], []),
  }
}

describe('structural-diff store', () => {
  test('write → read round-trips', async () => {
    const d = sample('task_abc')
    const artifacts = composeLocalCodeReviewArtifacts()
    await artifacts.writeStructuralDiff({ taskId: d.taskId, scope: d.scope, generation: null }, d)
    expect(
      await artifacts.readStructuralDiff({ taskId: 'task_abc', scope: 'task', generation: null }),
    ).toEqual(d)
  })

  test('absent artifact reads as null', async () => {
    expect(
      await composeLocalCodeReviewArtifacts().readStructuralDiff({
        taskId: 'task_missing',
        scope: 'task',
        generation: null,
      }),
    ).toBeNull()
  })

  test('isTerminalTaskStatus', () => {
    expect(isTerminalTaskStatus('done')).toBe(true)
    expect(isTerminalTaskStatus('failed')).toBe(true)
    expect(isTerminalTaskStatus('canceled')).toBe(true)
    expect(isTerminalTaskStatus('interrupted')).toBe(true)
    expect(isTerminalTaskStatus('running')).toBe(false)
    expect(isTerminalTaskStatus('pending')).toBe(false)
    expect(isTerminalTaskStatus('awaiting_review')).toBe(false)
    expect(isTerminalTaskStatus('awaiting_human')).toBe(false)
  })
})
