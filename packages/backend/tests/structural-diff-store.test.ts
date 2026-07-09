import { rimrafDir } from './helpers/cleanup'
// RFC-083 — eager on-disk persistence of the task-scope structural diff (so the
// view survives worktree-GC). File-based (no DB migration), best-effort.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  writeStoredDiff,
  readStoredDiff,
  isTerminalTaskStatus,
} from '../src/services/structuralDiff/store'
import { computeSummary, type StructuralDiff } from '@agent-workflow/shared'

let home: string
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'aw-sd-store-'))
  process.env.AGENT_WORKFLOW_HOME = home
})
afterAll(() => {
  delete process.env.AGENT_WORKFLOW_HOME
  rimrafDir(home)
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
    await writeStoredDiff(d)
    expect(await readStoredDiff('task_abc', 'task')).toEqual(d)
  })

  test('absent artifact reads as null', async () => {
    expect(await readStoredDiff('task_missing', 'task')).toBeNull()
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
