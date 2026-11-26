import { expect, test } from 'bun:test'
import { TaskFeedbackService } from '@/modules/collaboration/application/taskFeedback'
import { DrizzleTaskFeedbackStore } from '@/modules/collaboration/infrastructure/taskFeedbackStore'
import type { ReviewActor } from '@/modules/collaboration/public/types'
import { describeEachProvider } from './helpers/eachProvider'
import { taskFixture, workflowFixture } from './helpers/model'
import { taskExecutionParticipants } from './helpers/taskExecutionParticipantBindings'

const actor: ReviewActor = {
  user: {
    id: 'feedback-author',
    username: 'author',
    displayName: 'Author',
    role: 'admin',
    status: 'active',
  },
  source: 'session',
  permissions: new Set(),
}

describeEachProvider('collaboration feedback durable behavior contract', (harness) => {
  async function setup() {
    await workflowFixture(harness.db, {
      id: 'feedback-workflow',
      name: 'workflow',
      definition: '{}',
    })
    await taskFixture(harness.db, {
      id: 'feedback-task',
      name: 'task',
      workflowId: 'feedback-workflow',
      workflowSnapshot: '{}',
      repoPath: '/tmp/unused-feedback',
      worktreePath: '/tmp/unused-feedback',
      baseBranch: 'main',
      branch: 'feedback-task',
      status: 'running',
      inputs: '{}',
      startedAt: 1,
    })
    let sequence = 0
    const service = new TaskFeedbackService(
      new DrizzleTaskFeedbackStore(harness.db, taskExecutionParticipants),
      {
        canManageReviewers() {
          throw new Error('feedback writes do not query reviewer management')
        },
        async resolveRelationship() {
          throw new Error('relationship is supplied by the caller')
        },
        async visibleTaskIds() {
          throw new Error('not a task catalog query')
        },
      },
      () => sequence,
      () => `feedback-${++sequence}`,
    )
    return service
  }

  test('a failed distill enqueue propagates once while preserving the authored feedback for listing', async () => {
    const service = await setup()
    const failure = new Error('distill temporarily unavailable')
    const enqueued: unknown[] = []
    await expect(
      service.create(
        { actor, taskId: 'feedback-task', bodyMd: 'keep this note' },
        {
          async enqueue(input) {
            enqueued.push(input)
            throw failure
          },
        },
      ),
    ).rejects.toBe(failure)
    expect(enqueued).toEqual([
      {
        sourceKind: 'feedback',
        sourceEventId: 'feedback-1',
        taskId: 'feedback-task',
      },
    ])
    expect(await service.list('feedback-task')).toEqual([
      expect.objectContaining({
        id: 'feedback-1',
        bodyMd: 'keep this note',
        distilled: false,
        distillJobId: null,
      }),
    ])
  })

  test('recent feedback is a bounded newest-first database query and zero requests no rows', async () => {
    const service = await setup()
    for (let index = 0; index < 25; index++) {
      await service.create(
        { actor, taskId: 'feedback-task', bodyMd: `note ${index}` },
        {
          async enqueue() {
            return null
          },
        },
      )
    }
    const recording = harness.recordStatements()
    try {
      const recent = await service.listRecent(3)
      expect(recent.map((row) => row.bodyMd)).toEqual(['note 24', 'note 23', 'note 22'])
      expect(recording.selects()).toHaveLength(1)
      expect(recording.selects()[0]!.rows).toBe(3)
      expect(await service.listRecent(0)).toEqual([])
      expect((await service.listRecent()).length).toBe(20)
      expect(await service.list('no-feedback')).toEqual([])
    } finally {
      recording.stop()
    }
  })
})
