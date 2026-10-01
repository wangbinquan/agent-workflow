// RFC-370 CI compatibility: the shared public query retained RFC-371 owner
// positions; its provider implementation must deliver those same-window cursors.
import { expect, test } from 'bun:test'
import { buildActor } from '@/auth/actor'
import { tasks, workflows } from '@/db/schema'
import { createTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
import { describeEachProvider } from './helpers/eachProvider'

const reader = buildActor({
  user: {
    id: 'reader',
    username: 'reader',
    displayName: 'Reader',
    role: 'admin',
    status: 'active',
  },
  source: 'session',
})
const query = { from: 0, to: 10, timezone: 'UTC', limit: 2 }

describeEachProvider('RFC-370 shared task query contract compatibility', (harness) => {
  test('every returned position resumes the same owner page, including equal-time ties', async () => {
    await harness.db.insert(workflows).values({
      id: 'workflow',
      name: 'query compatibility',
      definition: '{}',
      createdAt: 1,
      updatedAt: 1,
    })
    for (const id of ['a', 'b', 'c'])
      await harness.db.insert(tasks).values({
        id,
        name: id,
        workflowId: 'workflow',
        workflowSnapshot: '{}',
        repoPath: '/repo',
        worktreePath: '/worktree',
        baseBranch: 'main',
        branch: `agent-workflow/${id}`,
        status: 'done',
        inputs: '{}',
        startedAt: 1,
        finishedAt: 2,
      })
    const owner = createTaskObservationFacts(harness.db)
    const first = await owner.list({ actor: reader, query })
    expect(first.items.map((item) => item.id)).toEqual(['c', 'b'])
    expect(first.positions.map((position) => position.taskId)).toEqual(['c', 'b'])
    expect(first.nextCursor).toBe(first.positions[1]!.cursor)
    for (const [index, expected] of [
      [0, ['b', 'a']],
      [1, ['a']],
    ] as const) {
      const next = await owner.list({
        actor: reader,
        query: { ...query, after: first.positions[index]!.cursor },
      })
      expect(next.items.map((item) => item.id)).toEqual([...expected])
      expect(next.positions.map((position) => position.taskId)).toEqual([...expected])
      expect(next.nextCursor).toBeNull()
    }
    await expect(
      owner.list({ actor: reader, query: { ...query, to: 11, after: first.positions[0]!.cursor } }),
    ).rejects.toThrow('changed window')
  })
  test('empty owner cohorts still fulfill the positions contract', async () => {
    const owner = createTaskObservationFacts(harness.db)
    expect(await owner.list({ actor: reader, query })).toEqual({
      items: [],
      positions: [],
      nextCursor: null,
    })
    expect(await owner.list({ actor: { ...reader, permissions: new Set() }, query })).toEqual({
      items: [],
      positions: [],
      nextCursor: null,
    })
  })
})
