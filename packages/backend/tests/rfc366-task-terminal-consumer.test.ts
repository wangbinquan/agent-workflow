// RFC-366 —— 任务结束信号源的持久化消费者。
//
// 这条消费者只在**任务真的结束了**时入队一次。两条判据各自都能独立出错，
// 所以各自有用例：
//
//   ① 终态范围（D4）：done / failed 入队，canceled / interrupted 不入队。
//   ② `continuationHandoff`：PostgreSQL 的两段式 retry 会先把任务推到一个可
//      resume 的终态（interrupted）再 CAS 回 pending，那一跳的 status 是中转态
//      不是结局。不跳过它，一次重试就会按「任务已结束」提炼一遍，而任务还在跑。
//      同文件里另外三个消费者为同一个理由各自跳过它（见 taskLifecycleConsumers.ts
//      的 RFC-359 W8 注释）——本消费者漏掉这一条不会有任何既有用例变红。

import { describe, expect, test } from 'bun:test'
import { ulid } from 'ulid'
import type { TaskStatus } from '@agent-workflow/shared'
import { createTaskLifecycleDurableConsumerDefinitions } from '../src/modules/task-execution/application/taskLifecycleConsumers'

function transition(input: {
  status: TaskStatus
  previousStatus?: TaskStatus
  continuationHandoff?: boolean
  taskId?: string
}): unknown {
  const taskId = input.taskId ?? ulid()
  const occurredAt = new Date().toISOString()
  return {
    eventId: ulid(),
    eventGroupId: ulid(),
    eventGroupOrdinal: 0,
    schemaVersion: 1,
    producer: 'task-execution',
    family: 'task-lifecycle',
    aggregate: { kind: 'task', id: taskId, seq: 2 },
    operationRef: ulid(),
    correlationRef: null,
    causationRef: null,
    occurredAt,
    type: 'task.lifecycle-transitioned.v1',
    payload: {
      taskId,
      lifecycleRevision: 2,
      previousStatus: input.previousStatus ?? 'running',
      status: input.status,
      updatedAt: occurredAt,
      errorSummary: null,
      nodeChanges: [],
      workspacePruneClaim: null,
      sourceTerminationEffectRef: null,
      continuationHandoff: input.continuationHandoff ?? false,
    },
  }
}

function consumerUnderTest() {
  const enqueued: string[] = []
  const definitions = createTaskLifecycleDurableConsumerDefinitions({
    events: { async observe() {} } as never,
    async closeTerminalGates() {},
    async notifyChildBudget() {},
    async notifyExecutionWatch() {},
    async nudgeWorkspacePrune() {},
    async enqueueTaskRunDistill(taskId) {
      enqueued.push(taskId)
    },
  })
  const definition = definitions.find((item) => item.id === 'task-terminal-distill-enqueue')
  expect(definition).toBeDefined()
  return { enqueued, definition: definition! }
}

describe('RFC-366 task-run distill consumer', () => {
  test('注册为持久化消费者，只订阅生命周期跳变事件', () => {
    const { definition } = consumerUnderTest()
    expect(definition.eventTypes).toEqual(['task.lifecycle-transitioned.v1'])
    // durable-effect-recorded：入队是一个外部副作用，投递必须记账到效果落库为止，
    // 否则 daemon 在投递与入队之间崩掉，这个任务就永远不会被提炼。
    expect(definition.settle).toBe('durable-effect-recorded')
  })

  for (const status of ['done', 'failed'] as const) {
    test(`AC-4: ${status} 入队一次`, async () => {
      const { enqueued, definition } = consumerUnderTest()
      const taskId = ulid()
      await definition.handle(transition({ status, taskId }))
      expect(enqueued).toEqual([taskId])
    })
  }

  for (const status of ['canceled', 'interrupted'] as const) {
    test(`AC-4: ${status} 不入队（不是一次跑完的执行）`, async () => {
      const { enqueued, definition } = consumerUnderTest()
      await definition.handle(transition({ status }))
      expect(enqueued).toEqual([])
    })
  }

  for (const status of ['running', 'pending', 'awaiting_review', 'awaiting_human'] as const) {
    test(`非终态 ${status} 不入队`, async () => {
      const { enqueued, definition } = consumerUnderTest()
      await definition.handle(transition({ status }))
      expect(enqueued).toEqual([])
    })
  }

  test('continuationHandoff 的 interrupted 不入队（PostgreSQL 两段式重试的中转态）', async () => {
    const { enqueued, definition } = consumerUnderTest()
    await definition.handle(transition({ status: 'interrupted', continuationHandoff: true }))
    expect(enqueued).toEqual([])
  })

  test('continuationHandoff 的 failed 同样不入队——重试自己失败之前不是结局', async () => {
    const { enqueued, definition } = consumerUnderTest()
    await definition.handle(transition({ status: 'failed', continuationHandoff: true }))
    expect(enqueued).toEqual([])
  })

  test('重试最终以真 failed 收场时照常入队', async () => {
    const { enqueued, definition } = consumerUnderTest()
    const taskId = ulid()
    await definition.handle(
      transition({ status: 'interrupted', continuationHandoff: true, taskId }),
    )
    await definition.handle(transition({ status: 'failed', continuationHandoff: false, taskId }))
    expect(enqueued).toEqual([taskId])
  })
})
