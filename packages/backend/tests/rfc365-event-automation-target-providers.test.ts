import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { createTriggerContext } from '@agent-workflow/shared'

import {
  employeeCaseEventOrigins,
  employeeCases,
  eventAutomationWorkIntents,
  eventDeliveries,
  eventResponseRules,
  tasks,
} from '@/db/schema'
import { createEmployeeAutomationWorkStartProvider } from '@/modules/digital-employee/composition'
import type { EventAutomationWorkIntentStorePort } from '@/modules/event-center/application/ports/eventAutomationWorkIntentStore'
import {
  composeEventCenter,
  createEventAutomationWorkIntentStore,
  type EventCenterAutomationCapability,
} from '@/modules/event-center/composition'
import type {
  EmployeeAutomationWorkStartV1,
  EventAutomationDelegatedContext,
  EventAutomationDelegatedContextFactory,
  EventAutomationOriginRef,
  EventAutomationPortId,
  TaskAutomationWorkStartV1,
  TaskAutomationWorkStartPort,
} from '@/modules/event-center/composition/required-ports'
import { createTaskAutomationWorkStartProvider } from '@/modules/task-execution/composition/taskRouteLaunch'
import {
  codeHostBusinessEventObservation,
  codeHostEventCatalogJson,
} from '@/modules/integration/public/events'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const OWNER = {
  userId: 'rfc365-owner',
  canOverrideOwner: false,
  hasPermission: () => true,
} as const

const trigger = createTriggerContext({
  namespace: 'test',
  definitionRef: { id: 'test.event', revision: 1 },
  availableFields: ['value'],
  values: { value: 'fixture' },
})

const taskInput: TaskAutomationWorkStartV1 = {
  version: 1,
  target: {
    kind: 'workflow',
    refId: 'workflow-rfc365',
    payload: {
      workflowId: 'workflow-rfc365',
      name: 'RFC-365 fixture',
      inputs: {},
      scratch: true,
    },
  },
  trigger,
}

const employeeInput: EmployeeAutomationWorkStartV1 = {
  version: 1,
  employeeId: 'employee-rfc365',
  intake: {
    kind: 'body',
    target: {},
    body: 'RFC-365 fixture',
    externalId: null,
    uploads: [],
  },
}

function delegatedContext<TPort extends EventAutomationPortId>(
  origin: EventAutomationOriginRef,
  portId: TPort,
): EventAutomationDelegatedContext<TPort> {
  return Object.freeze({
    authority: Object.freeze({}),
    operationId: `rfc365:${origin}`,
    correlationId: `rfc365:${origin}`,
    now: 1,
    idempotencyKey: origin,
    origin,
    portId,
  }) as unknown as EventAutomationDelegatedContext<TPort>
}

const delegatedContexts: EventAutomationDelegatedContextFactory = Object.freeze({
  async create<TPort extends EventAutomationPortId>(input: {
    readonly ownerUserId: string
    readonly origin: EventAutomationOriginRef
    readonly portId: TPort
  }) {
    return delegatedContext(input.origin, input.portId)
  },
})

function taskRow(id: string, deliveryId: string) {
  return {
    id,
    name: id,
    workflowId: 'workflow-rfc365',
    workflowSnapshot: '{}',
    repoPath: '/tmp/rfc365',
    worktreePath: '/tmp/rfc365',
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status: 'pending' as const,
    inputs: '{}',
    startedAt: 1,
    eventSubscriptionId: 'subscription-rfc365',
    eventDeliveryId: deliveryId,
  }
}

function employeeCaseRow(id: string) {
  return {
    id,
    name: id,
    employeeId: 'employee-rfc365',
    employeeRevision: 1,
    typeId: 'development',
    typeRevision: 1,
    primaryContextId: `context-${id}`,
    executionPolicyRevision: 1,
    ownerUserId: OWNER.userId,
    createdAt: 1,
    updatedAt: 1,
  }
}

function automationCapability(input: {
  store: EventAutomationWorkIntentStorePort
  taskWorkStart: TaskAutomationWorkStartPort
}): EventCenterAutomationCapability {
  return Object.freeze({
    kind: 'automation',
    workIntents: input.store,
    delegatedContexts,
    taskWorkStart: input.taskWorkStart,
    employeeWorkStart: {
      async start() {
        throw new Error('unexpected-employee-target')
      },
    },
  })
}

async function createRuleAndDelivery(input: {
  harness: ProviderHarness
  automation: EventCenterAutomationCapability
  now: () => number
  workerId: string
  idPrefix: string
  deliveryLeaseMs?: number
}) {
  let ordinal = 0
  const eventCenter = await composeEventCenter({
    db: input.harness.db,
    typePackageDescriptorJsons: [codeHostEventCatalogJson],
    automation: input.automation,
    now: input.now,
    id: () => `${input.idPrefix}-${++ordinal}`,
    workerId: input.workerId,
    deliveryLeaseMs: input.deliveryLeaseMs,
    deliveryRetryLimits: {
      current: () => ({ defaultNodeRetries: 1, sessionRestartBudget: 0 }),
    },
  })
  await eventCenter.responseRules.commands.create(
    {
      name: 'RFC-365 durable automation',
      enabled: true,
      eventTypeRef: { id: 'code-host.pipeline.failed', revision: 1 },
      subjectMatch: 'all',
      subjectPattern: null,
      target: {
        kind: 'workflow',
        refId: 'workflow-rfc365',
        nameTemplate: 'repair {{trigger.code_host.repo_path}}',
        inputs: { mr: '{{trigger.code_host.mr_iid}}' },
      },
    },
    OWNER,
  )
  const receipt = await eventCenter.participant.observe(
    codeHostBusinessEventObservation({
      endpointId: 'rfc365-endpoint',
      deliveryId: `${input.idPrefix}-provider-delivery`,
      occurredAt: input.now(),
      event: {
        provider: 'gitlab',
        eventUuid: `${input.idPrefix}-event`,
        eventType: 'pipeline_failed',
        repoPath: 'platform/rfc365',
        repoHttpUrl: 'https://gitlab.example.com/platform/rfc365.git',
        repoSshUrl: 'git@gitlab.example.com:platform/rfc365.git',
        branch: 'feature/rfc365',
        mrIid: '365',
        pipelineId: 'pipeline-rfc365',
        pipelineStatus: 'failed',
        author: { username: 'automation' },
        raw: { object_kind: 'pipeline' },
      },
    }),
  )
  const deliveryId = receipt.deliveryIds[0]
  if (deliveryId === undefined) throw new Error('missing-rfc365-delivery')
  return { eventCenter, deliveryId }
}

describeEachProvider('RFC-365 Event automation target providers', (harness) => {
  test('crash after target start replays one durable receipt after recomposition', async () => {
    let clock = 1_000
    const now = () => clock
    const receipts = new Map<string, string>()
    let physicalStarts = 0
    const baseStore = createEventAutomationWorkIntentStore(harness.db)
    let failReceiptWrite = true
    const crashAfterStartStore: EventAutomationWorkIntentStorePort = {
      ...baseStore,
      async recordReceipt(input) {
        if (failReceiptWrite) {
          failReceiptWrite = false
          throw new Error('fixture-crash-after-target-start')
        }
        await baseStore.recordReceipt(input)
      },
    }
    const taskWorkStart: TaskAutomationWorkStartPort = {
      async start(context) {
        const prior = receipts.get(context.origin)
        if (prior !== undefined) return { taskId: prior }
        physicalStarts += 1
        const taskId = `durable-task-${physicalStarts}`
        receipts.set(context.origin, taskId)
        return { taskId }
      },
    }
    const first = await createRuleAndDelivery({
      harness,
      automation: automationCapability({ store: crashAfterStartStore, taskWorkStart }),
      now,
      workerId: 'rfc365-worker-before-crash',
      idPrefix: 'rfc365-crash',
    })

    expect(await first.eventCenter.worker.runOneNotification(first.deliveryId)).toBe('retried')
    expect(await harness.db.select().from(eventAutomationWorkIntents)).toMatchObject([
      { deliveryId: first.deliveryId, receiptRef: null, status: 'failed' },
    ])

    clock = 3_000
    const restarted = await composeEventCenter({
      db: harness.db,
      typePackageDescriptorJsons: [codeHostEventCatalogJson],
      automation: automationCapability({ store: baseStore, taskWorkStart }),
      now,
      id: () => 'rfc365-restart-unused',
      workerId: 'rfc365-worker-after-crash',
      deliveryRetryLimits: {
        current: () => ({ defaultNodeRetries: 1, sessionRestartBudget: 0 }),
      },
    })
    expect(await restarted.worker.runOneNotification(first.deliveryId)).toBe('completed')
    expect(physicalStarts).toBe(1)
    expect(await harness.db.select().from(eventAutomationWorkIntents)).toMatchObject([
      { deliveryId: first.deliveryId, receiptRef: 'durable-task-1', status: 'launched' },
    ])
    expect(
      await harness.db
        .select({ state: eventDeliveries.state })
        .from(eventDeliveries)
        .where(eq(eventDeliveries.id, first.deliveryId)),
    ).toEqual([{ state: 'accepted' }])
  })

  test('an expired claim can preserve a receipt but cannot settle or overwrite rule result', async () => {
    let clock = 10_000
    const now = () => clock
    const store = createEventAutomationWorkIntentStore(harness.db)
    const receipts = new Map<string, string>()
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let providerCalls = 0
    const taskWorkStart: TaskAutomationWorkStartPort = {
      async start(context) {
        providerCalls += 1
        const prior = receipts.get(context.origin)
        if (prior !== undefined) return { taskId: prior }
        receipts.set(context.origin, 'claim-race-task')
        markFirstStarted()
        await firstRelease
        return { taskId: 'claim-race-task' }
      },
    }
    const first = await createRuleAndDelivery({
      harness,
      automation: automationCapability({ store, taskWorkStart }),
      now,
      workerId: 'rfc365-stale-worker',
      idPrefix: 'rfc365-claim',
      deliveryLeaseMs: 10,
    })
    const staleRun = first.eventCenter.worker.runOneNotification(first.deliveryId)
    await firstStarted

    clock = 20_000
    const winner = await composeEventCenter({
      db: harness.db,
      typePackageDescriptorJsons: [codeHostEventCatalogJson],
      automation: automationCapability({ store, taskWorkStart }),
      now,
      id: () => 'rfc365-winner-unused',
      workerId: 'rfc365-winning-worker',
      deliveryLeaseMs: 10,
    })
    expect(await winner.worker.runOneNotification(first.deliveryId)).toBe('completed')

    clock = 30_000
    releaseFirst()
    await expect(staleRun).rejects.toThrow('event delivery lease was lost')
    expect(providerCalls).toBe(2)
    expect(
      await harness.db
        .select({ state: eventDeliveries.state })
        .from(eventDeliveries)
        .where(eq(eventDeliveries.id, first.deliveryId)),
    ).toEqual([{ state: 'accepted' }])
    expect(await harness.db.select().from(eventResponseRules)).toMatchObject([
      { lastFiredAt: 20_000, lastStatus: 'launched', lastError: null },
    ])
    expect(await harness.db.select().from(eventAutomationWorkIntents)).toMatchObject([
      {
        deliveryId: first.deliveryId,
        receiptRef: 'claim-race-task',
        status: 'launched',
        claimOwner: 'rfc365-winning-worker',
        claimAttempt: 2,
      },
    ])
  })

  test('Task and Case providers adopt legacy receipts and linearize concurrent starts', async () => {
    await harness.db.insert(tasks).values(taskRow('legacy-event-task', 'legacy-task-delivery'))
    await harness.db.insert(employeeCases).values(employeeCaseRow('legacy-event-case'))
    await harness.db.insert(employeeCaseEventOrigins).values({
      caseId: 'legacy-event-case',
      eventSubscriptionId: 'subscription-rfc365',
      eventDeliveryId: 'legacy-case-delivery',
      createdAt: 1,
    })

    let taskLaunchCalls = 0
    let employeeLaunchCalls = 0
    let contextResolveCalls = 0
    const origins = {
      async resolve(_origin: EventAutomationOriginRef, portId: EventAutomationPortId) {
        return {
          eventSubscriptionId: 'subscription-rfc365',
          eventDeliveryId:
            portId === 'task-automation-work-start.v1'
              ? 'legacy-task-delivery'
              : 'legacy-case-delivery',
        }
      },
    }
    const contexts = {
      resolve() {
        contextResolveCalls += 1
        return {
          actor: Object.freeze({ user: Object.freeze({ id: OWNER.userId }) }),
          authority: Object.freeze({}),
        } as never
      },
    }
    const taskProvider = createTaskAutomationWorkStartProvider({
      db: harness.db,
      origins,
      contexts,
      resources: Object.freeze({}) as never,
      async launch() {
        taskLaunchCalls += 1
        throw new Error('legacy task must not relaunch')
      },
    })
    const employeeProvider = createEmployeeAutomationWorkStartProvider({
      db: harness.db,
      origins,
      contexts,
      async launchWork() {
        employeeLaunchCalls += 1
        throw new Error('legacy case must not relaunch')
      },
    })
    const legacyTaskOrigin = 'event-automation:legacy-task' as EventAutomationOriginRef
    const legacyCaseOrigin = 'event-automation:legacy-case' as EventAutomationOriginRef
    await expect(
      taskProvider.start(
        delegatedContext(legacyTaskOrigin, 'task-automation-work-start.v1'),
        taskInput,
      ),
    ).resolves.toEqual({ taskId: 'legacy-event-task' })
    await expect(
      employeeProvider.start(
        delegatedContext(legacyCaseOrigin, 'employee-automation-work-start.v1'),
        employeeInput,
      ),
    ).resolves.toEqual({ caseId: 'legacy-event-case' })
    expect({ taskLaunchCalls, employeeLaunchCalls, contextResolveCalls }).toEqual({
      taskLaunchCalls: 0,
      employeeLaunchCalls: 0,
      contextResolveCalls: 0,
    })

    const racingOrigins = {
      async resolve(_origin: EventAutomationOriginRef, portId: EventAutomationPortId) {
        return {
          eventSubscriptionId: 'subscription-rfc365',
          eventDeliveryId:
            portId === 'task-automation-work-start.v1'
              ? 'racing-task-delivery'
              : 'racing-case-delivery',
        }
      },
    }
    let taskOrdinal = 0
    let caseOrdinal = 0
    const racingTaskProvider = createTaskAutomationWorkStartProvider({
      db: harness.db,
      origins: racingOrigins,
      contexts,
      resources: Object.freeze({}) as never,
      async launch() {
        const taskId = `racing-event-task-${++taskOrdinal}`
        await harness.db.insert(tasks).values(taskRow(taskId, 'racing-task-delivery'))
        return { taskId }
      },
    })
    const racingEmployeeProvider = createEmployeeAutomationWorkStartProvider({
      db: harness.db,
      origins: racingOrigins,
      contexts,
      async launchWork() {
        const caseId = `racing-event-case-${++caseOrdinal}`
        await harness.session.transaction(async (tx) => {
          await tx.insert(employeeCases).values(employeeCaseRow(caseId))
          await tx.insert(employeeCaseEventOrigins).values({
            caseId,
            eventSubscriptionId: 'subscription-rfc365',
            eventDeliveryId: 'racing-case-delivery',
            createdAt: 2,
          })
        })
        return { caseId }
      },
    })
    const racingTaskOrigin = 'event-automation:racing-task' as EventAutomationOriginRef
    const racingCaseOrigin = 'event-automation:racing-case' as EventAutomationOriginRef
    const taskReceipts = await Promise.all(
      Array.from({ length: 2 }, () =>
        racingTaskProvider.start(
          delegatedContext(racingTaskOrigin, 'task-automation-work-start.v1'),
          taskInput,
        ),
      ),
    )
    const caseReceipts = await Promise.all(
      Array.from({ length: 2 }, () =>
        racingEmployeeProvider.start(
          delegatedContext(racingCaseOrigin, 'employee-automation-work-start.v1'),
          employeeInput,
        ),
      ),
    )
    expect(new Set(taskReceipts.map((receipt) => receipt.taskId)).size).toBe(1)
    expect(new Set(caseReceipts.map((receipt) => receipt.caseId)).size).toBe(1)
    expect(
      await harness.db
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.eventDeliveryId, 'racing-task-delivery')),
    ).toHaveLength(1)
    expect(
      await harness.db
        .select({ caseId: employeeCaseEventOrigins.caseId })
        .from(employeeCaseEventOrigins)
        .where(eq(employeeCaseEventOrigins.eventDeliveryId, 'racing-case-delivery')),
    ).toHaveLength(1)
  })
})
