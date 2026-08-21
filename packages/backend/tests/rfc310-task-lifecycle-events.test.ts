import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { createInMemoryDb } from '@/db/client'
import { eventRecords, taskLifecycleEventOutbox, tasks, workflows } from '@/db/schema'
import { composeEventCenter } from '@/modules/event-center/composition'
import { createSqliteTaskLifecycleEventPublisher } from '@/modules/task-execution/infrastructure/sqliteTaskLifecycleEventPublisher'
import {
  TASK_LIFECYCLE_SOURCE_REF,
  TASK_STATUS_CHANGED_EVENT_REF,
  taskLifecycleEventCatalogJson,
} from '@/modules/task-execution/public/events'
import { setTaskStatus } from '@/services/lifecycle'
import { MIGRATIONS } from './migration-freeze'

describe('RFC-310 task lifecycle publication', () => {
  test('commits the owner outbox with the status CAS and multicasts independent deliveries', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    let now = 10_000
    let ordinal = 0
    const eventCenter = composeEventCenter({
      db,
      typePackageDescriptorJsons: [taskLifecycleEventCatalogJson],
      now: () => now,
      id: () => `task-event-resource-${++ordinal}`,
    })
    db.insert(workflows)
      .values({
        id: 'workflow-1',
        name: 'Lifecycle fixture',
        definition: '{}',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    db.insert(tasks)
      .values({
        id: 'task-1',
        name: 'Lifecycle fixture',
        workflowId: 'workflow-1',
        workflowSnapshot: '{}',
        repoPath: '/tmp/repo',
        worktreePath: '/tmp/worktree',
        baseBranch: 'main',
        branch: 'agent-workflow/task-1',
        status: 'running',
        inputs: '{}',
        startedAt: now,
      })
      .run()

    const subscribers = ['parent-work', 'audit-projection'].map((subscriberRef) => ({
      kind: 'system' as const,
      subscriberRef,
    }))
    for (const subscriber of subscribers) {
      eventCenter.participant.subscribe({
        eventTypeRef: TASK_STATUS_CHANGED_EVENT_REF,
        subject: { typeId: 'platform.task', subjectRef: 'task-1' },
        subscriber,
      })
    }

    now += 1
    await setTaskStatus({
      db,
      taskId: 'task-1',
      to: 'failed',
      allowedFrom: ['running'],
      now,
      reason: 'lifecycle event fixture',
    })
    expect(db.select().from(tasks).where(eq(tasks.id, 'task-1')).get()).toMatchObject({
      status: 'failed',
      lifecycleEventRevision: 2,
    })
    expect(
      db
        .select()
        .from(taskLifecycleEventOutbox)
        .where(eq(taskLifecycleEventOutbox.taskId, 'task-1'))
        .get(),
    ).toMatchObject({ taskRevision: 2, state: 'pending', attemptCount: 0 })

    const publisher = createSqliteTaskLifecycleEventPublisher({
      db,
      events: eventCenter.commands,
      retryLimits: () => ({ defaultNodeRetries: 2, sessionRestartBudget: 1 }),
      workerId: 'task-lifecycle-test',
      now: () => now,
    })
    expect(await publisher.runOne()).toBe('completed')
    expect(await publisher.runOne()).toBe('idle')

    const parentDelivery = eventCenter.participant.pendingDeliveries(subscribers[0]!, 10)
    const auditDelivery = eventCenter.participant.pendingDeliveries(subscribers[1]!, 10)
    expect(parentDelivery).toHaveLength(1)
    expect(auditDelivery).toHaveLength(1)
    expect(parentDelivery[0]).toMatchObject({
      eventTypeRef: TASK_STATUS_CHANGED_EVENT_REF,
      sourceRef: TASK_LIFECYCLE_SOURCE_REF,
      subject: { typeId: 'platform.task', subjectRef: 'task-1' },
    })
    const eventDocument = JSON.parse(
      db
        .select({ summaryJson: eventRecords.summaryJson })
        .from(eventRecords)
        .where(eq(eventRecords.id, parentDelivery[0]!.eventId))
        .get()!.summaryJson,
    ) as { triggerContext: unknown }
    expect(eventDocument.triggerContext).toMatchObject({
      contract: { namespace: 'task' },
      trigger: { task: { task_id: 'task-1', status: 'failed', previous_status: 'running' } },
    })
    expect(parentDelivery[0]!.eventId).toBe(auditDelivery[0]!.eventId)
    expect(parentDelivery[0]!.deliveryId).not.toBe(auditDelivery[0]!.deliveryId)
    eventCenter.participant.acceptDelivery(parentDelivery[0]!.deliveryId)
    expect(eventCenter.participant.pendingDeliveries(subscribers[0]!, 10)).toEqual([])
    expect(eventCenter.participant.pendingDeliveries(subscribers[1]!, 10)).toHaveLength(1)
  })
})
