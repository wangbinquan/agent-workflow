import { describe, expect, test } from 'bun:test'

import { prepareWorkspaceRollbackPlan } from '@/modules/collaboration/application/prepareWorkspaceRollbackPlan'
import { HumanGateOperationError } from '@/modules/collaboration/domain/humanGateOperation'

describe('RFC-333 T4 workspace rollback plan preparation', () => {
  test('checks every snapshot before returning one deterministic, ordered effect plan', async () => {
    const checked: string[] = []
    const input = {
      taskId: 'task-333',
      candidates: [
        {
          sourceNodeRunId: 'run-b',
          targets: [{ worktreePath: '/work/repo-b', worktreeDirName: 'b', snapshot: 'sha-b' }],
        },
        {
          sourceNodeRunId: 'run-a',
          targets: [
            { worktreePath: '/work/repo-a', worktreeDirName: 'a', snapshot: 'sha-a' },
            { worktreePath: '/work/repo-empty', worktreeDirName: 'empty', snapshot: '' },
          ],
        },
      ],
      inspector: {
        snapshotExists: async ({
          worktreePath,
          snapshot,
        }: {
          worktreePath: string
          snapshot: string
        }) => {
          checked.push(`${worktreePath}:${snapshot}`)
          return true
        },
      },
    } as const
    const first = await prepareWorkspaceRollbackPlan(input)
    const second = await prepareWorkspaceRollbackPlan(input)

    expect(first.digest).toBe(second.digest)
    expect(first.targets).toEqual([
      {
        sourceNodeRunId: 'run-b',
        worktreePath: '/work/repo-b',
        worktreeDirName: 'b',
        snapshot: 'sha-b',
        ordinal: 0,
      },
      {
        sourceNodeRunId: 'run-a',
        worktreePath: '/work/repo-a',
        worktreeDirName: 'a',
        snapshot: 'sha-a',
        ordinal: 1,
      },
    ])
    expect(first.resourceKeys).toHaveLength(2)
    expect(checked).toEqual([
      '/work/repo-b:sha-b',
      '/work/repo-a:sha-a',
      '/work/repo-b:sha-b',
      '/work/repo-a:sha-a',
    ])
  })

  test('returns no plan when any check-only snapshot inspection fails', async () => {
    let effectCalls = 0
    try {
      await prepareWorkspaceRollbackPlan({
        taskId: 'task-333',
        candidates: [
          {
            sourceNodeRunId: 'run-a',
            targets: [
              { worktreePath: '/work/repo-a', worktreeDirName: 'a', snapshot: 'sha-a' },
              { worktreePath: '/work/repo-b', worktreeDirName: 'b', snapshot: 'missing' },
            ],
          },
        ],
        inspector: {
          snapshotExists: async ({ snapshot }) => {
            effectCalls++
            return snapshot !== 'missing'
          },
        },
      })
      throw new Error('expected missing snapshot to reject')
    } catch (error) {
      expect(error).toBeInstanceOf(HumanGateOperationError)
      expect((error as HumanGateOperationError).code).toBe('human-gate-operation-manifest-invalid')
    }
    expect(effectCalls).toBe(2)
  })
})
