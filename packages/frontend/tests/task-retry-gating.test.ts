// Gating predicates for the M3 Resume / Retry-node buttons (P-3-08 /
// P-3-09 wired into the UI). Both helpers exist so we can pin the
// behavior without mounting the full task-detail route — the backend
// API contract is exercised by the resume/retry service tests
// already; here we just make sure the UI doesn't offer the user a
// button that the API will 409 on.

import { describe, expect, test } from 'vitest'
import { resumeStatus } from '../src/routes/tasks.detail'
import { canRetryNodeRun } from '../src/components/NodeDetailDrawer'

describe('resumeStatus', () => {
  test('failed task with a worktree → ready', () => {
    expect(resumeStatus('failed', '/tmp/wt')).toBe('ready')
  })

  test('interrupted task with a worktree → ready (daemon-restart case)', () => {
    expect(resumeStatus('interrupted', '/tmp/wt')).toBe('ready')
  })

  test('failed task with empty worktreePath → worktree-missing (resume cannot recover)', () => {
    // This is the exact shape the demo-repo / no-commits failure had:
    // `git worktree add` blew up so worktreePath was never persisted.
    // The backend `resumeTask` is documented to "kick the scheduler
    // without re-creating the worktree" — so re-running would just
    // fail the same way. The UI must surface the alternate path.
    expect(resumeStatus('failed', '')).toBe('worktree-missing')
  })

  test('interrupted task with empty worktreePath → worktree-missing', () => {
    expect(resumeStatus('interrupted', '')).toBe('worktree-missing')
  })

  test('done task → not-resumable (nothing to resume)', () => {
    expect(resumeStatus('done', '/tmp/wt')).toBe('not-resumable')
  })

  test('running task → not-resumable (would race the live scheduler)', () => {
    expect(resumeStatus('running', '/tmp/wt')).toBe('not-resumable')
  })

  test('pending task → not-resumable', () => {
    expect(resumeStatus('pending', '/tmp/wt')).toBe('not-resumable')
  })

  test('canceled task → not-resumable (no resume API endpoint for canceled)', () => {
    expect(resumeStatus('canceled', '/tmp/wt')).toBe('not-resumable')
  })
})

describe('canRetryNodeRun', () => {
  test('failed run on a failed task → true', () => {
    expect(canRetryNodeRun('failed', 'failed')).toBe(true)
  })

  test('interrupted run on an interrupted task → true', () => {
    expect(canRetryNodeRun('interrupted', 'interrupted')).toBe(true)
  })

  test('exhausted run on a failed task → true (retries blown, fresh attempt OK)', () => {
    expect(canRetryNodeRun('exhausted', 'failed')).toBe(true)
  })

  test('canceled run on a canceled task → true (cancel/resume cycle)', () => {
    expect(canRetryNodeRun('canceled', 'canceled')).toBe(true)
  })

  test('failed run on a STILL-running task → false (API would 409 task-still-running)', () => {
    expect(canRetryNodeRun('failed', 'running')).toBe(false)
  })

  test('failed run on a pending task → false (scheduler is alive, would race)', () => {
    expect(canRetryNodeRun('failed', 'pending')).toBe(false)
  })

  test('done run on a done task → false (would redo finished work)', () => {
    expect(canRetryNodeRun('done', 'done')).toBe(false)
  })

  test('skipped run → false', () => {
    expect(canRetryNodeRun('skipped', 'done')).toBe(false)
  })

  test('running run → false (scheduler still owns it)', () => {
    expect(canRetryNodeRun('running', 'running')).toBe(false)
  })

  test('pending run → false', () => {
    expect(canRetryNodeRun('pending', 'failed')).toBe(false)
  })

  test('missing taskStatus → still gates on run (defensive)', () => {
    expect(canRetryNodeRun('failed', undefined)).toBe(true)
  })
})
