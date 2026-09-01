import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { createInMemoryDb } from '@/db/client'
import {
  committedEventDeliveries,
  committedEvents,
  eventRecords,
  tasks,
  workflows,
} from '@/db/schema'
import { composeEventCenter } from '@/modules/event-center/composition'
import {
  createTaskLifecycleDurableConsumerDefinitions,
  taskLifecycleCommittedEventCodec,
} from '@/modules/task-execution/application/taskLifecycleConsumers'
import {
  TASK_LIFECYCLE_SOURCE_REF,
  TASK_STATUS_CHANGED_EVENT_REF,
  taskLifecycleEventCatalogJson,
} from '@/modules/task-execution/public/events'
import { createCommittedEventDispatcher } from '@/platform/events/committed/dispatcherWorker'
import { createSqliteCommittedEventDeliveryPersistence } from '@/platform/events/committed/sqlitePersistence'
import { setTaskStatus } from '@/services/lifecycle'
import { MIGRATIONS } from './migration-freeze'

describe('RFC-310 task lifecycle publication through RFC-341', () => {
  test('commits the canonical event with the status CAS and multicasts independent deliveries', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    let now = 10_000
    let ordinal = 0
    const eventCenter = await composeEventCenter({
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
      await eventCenter.participant.subscribe({
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
    const committed = db
      .select()
      .from(committedEvents)
      .where(eq(committedEvents.id, 'task-lifecycle:task-1:2'))
      .get()
    expect(committed).toMatchObject({
      id: 'task-lifecycle:task-1:2',
      eventType: 'task.lifecycle-transitioned.v1',
      deliveryMode: 'dispatchable',
      producerEpoch: 2,
    })
    expect(
      db
        .select()
        .from(committedEventDeliveries)
        .where(eq(committedEventDeliveries.eventId, committed!.id))
        .all(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          consumerId: 'event-center.task-lifecycle',
          state: 'pending',
          attemptCount: 0,
        }),
      ]),
    )

    const dispatcher = createCommittedEventDispatcher({
      persistence: createSqliteCommittedEventDeliveryPersistence(db),
      workerId: 'task-lifecycle-test',
      codecs: taskLifecycleCommittedEventCodec,
      consumers: createTaskLifecycleDurableConsumerDefinitions({
        events: eventCenter.commands,
        async closeTerminalGates() {},
        async notifyChildBudget() {},
        async notifyExecutionWatch() {},
        async nudgeWorkspacePrune() {},
      }),
      now: () => now,
    })
    expect((await dispatcher.drain()).madeProgress).toBeTrue()

    const parentDelivery = await eventCenter.participant.pendingDeliveries(subscribers[0]!, 10)
    const auditDelivery = await eventCenter.participant.pendingDeliveries(subscribers[1]!, 10)
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
    await eventCenter.participant.acceptDelivery(parentDelivery[0]!.deliveryId)
    expect(await eventCenter.participant.pendingDeliveries(subscribers[0]!, 10)).toEqual([])
    expect(await eventCenter.participant.pendingDeliveries(subscribers[1]!, 10)).toHaveLength(1)
  })
})
