// RFC-300 — Task detail exposes a compatible capability state rather than
// leaking internal prune timestamps. Old daemon payloads remain parseable.

import { describe, expect, test } from 'bun:test'
import { TaskSchema, WorkspaceStateSchema } from '../src/schemas/task.js'

const baseTask = {
  id: 'task-1',
  name: 'task',
  workflowId: 'workflow-1',
  workflowName: 'workflow',
  workflowSnapshot: {},
  workflowVersion: null,
  repoPath: '/repo',
  repoUrl: null,
  cachedRepoId: null,
  worktreePath: '/workspace',
  baseBranch: 'main',
  branch: 'agent-workflow/task-1',
  workingBranch: null,
  autoCommitPush: false,
  baseCommit: null,
  status: 'done',
  inputs: {},
  maxDurationMs: null,
  maxTotalTokens: null,
  startedAt: 1,
  finishedAt: 2,
  errorSummary: null,
  errorMessage: null,
  failedNodeId: null,
  expiresAt: null,
  deletedAt: null,
  schemaVersion: 1,
  gitUserName: null,
  gitUserEmail: null,
}

describe('RFC-300 Task.workspaceState wire contract', () => {
  test('accepts all closed states', () => {
    for (const workspaceState of ['available', 'pruning', 'pruned'] as const) {
      expect(TaskSchema.parse({ ...baseTask, workspaceState }).workspaceState).toBe(workspaceState)
    }
  })

  test('keeps old responses without the optional field compatible', () => {
    expect(TaskSchema.parse(baseTask).workspaceState).toBeUndefined()
  })

  test('rejects unknown states', () => {
    expect(WorkspaceStateSchema.safeParse('missing').success).toBe(false)
  })
})
