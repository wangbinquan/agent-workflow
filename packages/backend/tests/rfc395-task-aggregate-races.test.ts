import { composeHumanGateOpenParticipantFactory } from '@/modules/collaboration/composition'
import { epoch2RuntimeTestPorts } from './helpers/epoch2RuntimePorts'
import type { TaskCreationInput } from '@/modules/task-execution/application/ports/taskCreation'
import {
  createTaskCreationParticipantInTx,
  taskExecutionGenerationsParticipant,
} from '@/modules/task-execution/infrastructure/taskCreationParticipant'
import { tablesOf, inheritDatabaseHandle } from '@/platform/persistence/sessionTables'
import { expect, test } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'
import { describeEachProvider } from './helpers/eachProvider'

const taskInput = (id: string): TaskCreationInput => ({
  subject: { kind: 'workflow', sourceId: 'workflow' },
  core: {
    id,
    name: id,
    status: 'failed',
    startedAt: 10,
    ownerUserId: null,
    catalogVisibility: 'public',
    branchStartedAt: 10,
  },
  definition: {
    definitionOrigin: 'authored',
    workflowSnapshot: '{"$schema_version":4,"inputs":[],"nodes":[],"edges":[]}',
    workflowVersion: 4,
    inputs: '{}',
  },
  launch: { kind: 'root', launchOrigin: 'api' },
  launchContext: {},
  workspace: {
    repoPath: '',
    worktreePath: '',
    baseBranch: '',
    branch: `agent-workflow/${id}`,
    baseCommit: null,
    spaceKind: 'scratch',
  },
  repos: [],
  nodePaths: [],
})

import {
  createTaskDefinitionWriteParticipantInTx,
  taskAggregateWrite,
} from '@/modules/task-execution/infrastructure/taskDefinitionWriteParticipant'
import { createTaskPreparationParticipantInTx } from '@/modules/task-execution/infrastructure/taskPreparationParticipant'

describeEachProvider('RFC-395 T aggregate races', (harness) => {
  test('definition vs lifecycle permits only one original-status CAS', async () => {
    await harness.session.transaction((tx) =>
      createTaskCreationParticipantInTx(tx).create(taskInput('race')),
    )
    const { tasks, taskDefinitions } = tablesOf(harness.db)
    const [before] = await harness.db.select().from(tasks)
    const results = await Promise.all([
      harness.session.transaction((tx) =>
        createTaskDefinitionWriteParticipantInTx(tx).syncWorkflow({
          taskId: 'race',
          expectedStatus: 'failed',
          expectedLifecycleRevision: before!.lifecycleEventRevision,
          snapshot: 'new',
          sourceRevision: 2,
          resourceClosure: null,
          occurredAt: 30,
        }),
      ),
      harness.session.transaction((tx) =>
        createTaskDefinitionWriteParticipantInTx(tx).continueWorkgroupTask({
          taskId: 'race',
          expectedStatus: 'failed',
          expectedLifecycleRevision: before!.lifecycleEventRevision,
        }),
      ),
    ])
    expect(Number(results[0] !== null) + Number(results[1])).toBe(1)
    const [after] = await harness.db.select().from(tasks)
    expect(after!.lifecycleEventRevision).toBe(before!.lifecycleEventRevision + 1)
    expect((await harness.db.select().from(taskDefinitions))[0]?.workflowSnapshot).toBe(
      results[0] === null ? taskInput('race').definition.workflowSnapshot : 'new',
    )
  })
  test('a final CAS miss rolls back the already-written subordinate row', async () => {
    await harness.session.transaction((tx) =>
      createTaskCreationParticipantInTx(tx).create(taskInput('miss')),
    )
    const { tasks, taskDefinitions } = tablesOf(harness.db)
    const before = await harness.db.select().from(taskDefinitions)
    const [root] = await harness.db.select().from(tasks)
    await expect(
      harness.session.transaction(async (tx) => {
        const injected = inheritDatabaseHandle(
          new Proxy(tx, {
            get(target, property) {
              if (property !== 'update') {
                const value = Reflect.get(target, property)
                return typeof value === 'function' ? value.bind(target) : value
              }
              return (table: typeof tasks) => {
                const builder = target.update(table)
                if (table !== tasks) return builder
                return {
                  set: (values: Parameters<typeof builder.set>[0]) => {
                    const query = builder.set(values)
                    return {
                      where: (predicate: Parameters<typeof query.where>[0]) =>
                        query.where(and(predicate, sql`1 = 0`)),
                    }
                  },
                }
              }
            },
          }),
          tx,
        )
        await createTaskDefinitionWriteParticipantInTx(injected).syncWorkflow({
          taskId: 'miss',
          expectedStatus: 'failed',
          expectedLifecycleRevision: root!.lifecycleEventRevision,
          snapshot: 'must-rollback',
          sourceRevision: 2,
          resourceClosure: null,
          occurredAt: 30,
        })
      }),
    ).rejects.toThrow('task-aggregate-cas-miss:miss')
    expect(await harness.db.select().from(taskDefinitions)).toEqual(before)
    expect((await harness.db.select().from(tasks))[0]?.lifecycleEventRevision).toBe(
      root!.lifecycleEventRevision,
    )
  })
  test('workspace vs retry shares the root and preserves generation plus frozen definition', async () => {
    await harness.session.transaction((tx) =>
      createTaskCreationParticipantInTx(tx).create(taskInput('workspace')),
    )
    await Promise.all([
      harness.session.transaction((tx) =>
        createTaskPreparationParticipantInTx(tx).writeWorkspace({
          taskId: 'workspace',
          worktreePath: '/work',
          branch: 'topic',
          baseCommit: null,
          spaceKind: 'scratch',
          repositories: [],
          nodePaths: [''],
        }),
      ),
      harness.session.transaction((tx) =>
        taskExecutionGenerationsParticipant.openGeneration(tx, {
          taskId: 'workspace',
          operationRef: 'retry',
          cause: 'retry',
          previousGenerationSeq: 0,
          createdAt: 30,
        }),
      ),
    ])
    const { tasks, taskExecutionGenerations } = tablesOf(harness.db)
    expect((await harness.db.select().from(tasks))[0]?.workspaceRootRef).toBe('/work')
    expect(await harness.db.select().from(taskExecutionGenerations)).toHaveLength(2)
  })
  test('workspace vs delete cannot leave a workspace row after the root disappears', async () => {
    await harness.session.transaction((tx) =>
      createTaskCreationParticipantInTx(tx).create(taskInput('delete-workspace')),
    )
    const { tasks, taskWorkspaces } = tablesOf(harness.db)
    const results = await Promise.allSettled([
      harness.session.transaction((tx) =>
        createTaskPreparationParticipantInTx(tx).writeWorkspace({
          taskId: 'delete-workspace',
          worktreePath: '/work',
          branch: 'topic',
          baseCommit: null,
          spaceKind: 'scratch',
          repositories: [],
          nodePaths: [],
        }),
      ),
      harness.session.transaction(async (tx) => {
        await taskAggregateWrite.lockTaskAggregateRoot(tx, 'delete-workspace')
        await tx.delete(tasks).where(eq(tasks.id, 'delete-workspace'))
      }),
    ])
    expect(results[1]!.status).toBe('fulfilled')
    if (results[0]!.status === 'rejected')
      expect(String(results[0]!.reason)).toContain('task-aggregate-cas-miss:delete-workspace')
    expect(await harness.db.select().from(tasks)).toEqual([])
    expect(await harness.db.select().from(taskWorkspaces)).toEqual([])
  })
  test('delete vs definition leaves no orphan subordinate row', async () => {
    await harness.session.transaction((tx) =>
      createTaskCreationParticipantInTx(tx).create(taskInput('delete')),
    )
    const { tasks, taskDefinitions } = tablesOf(harness.db)
    const [root] = await harness.db.select().from(tasks)
    await Promise.all([
      harness.session.transaction((tx) =>
        createTaskDefinitionWriteParticipantInTx(tx).syncWorkflow({
          taskId: 'delete',
          expectedStatus: 'failed',
          expectedLifecycleRevision: root!.lifecycleEventRevision,
          snapshot: 'new',
          sourceRevision: 2,
          resourceClosure: null,
          occurredAt: 30,
        }),
      ),
      harness.session.transaction(async (tx) => {
        await taskAggregateWrite.lockTaskAggregateRoot(tx, 'delete')
        await tx.delete(tasks).where(eq(tasks.id, 'delete'))
      }),
    ])
    expect(await harness.db.select().from(tasks)).toEqual([])
    expect(await harness.db.select().from(taskDefinitions)).toEqual([])
  })
})

// W1 L-1: race the actual owner-fenced merge and Task lifecycle adapters on both providers.

import { insertOne } from '@/platform/persistence/singleInsert'
import { DrizzleMergeStateLifecyclePersistence } from '@/modules/task-execution/infrastructure/mergeStateLifecyclePersistence'
import { DrizzleTaskRuntimeLifecyclePersistence } from '@/modules/task-execution/infrastructure/taskRuntimeLifecyclePersistence'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { createTaskExecutionContext } from '@/modules/task-execution/application/taskExecutionContext'
import {
  createOwnershipToken,
  createWorkerIdentity,
} from '@/modules/task-execution/domain/ownership'
import { encodeCanonicalRunSlot } from '@/modules/task-execution/domain/runSelection/slotKey'

describeEachProvider('RFC-395 W1 owner fence and aggregate lock order', (harness) => {
  test('owned merge and lifecycle transitions both commit without a reversed-lock deadlock', async () => {
    const base = taskInput('owned-race')
    await harness.session.transaction((tx) =>
      createTaskCreationParticipantInTx(tx).create({
        ...base,
        core: { ...base.core, status: 'running' },
      }),
    )
    const tables = tablesOf(harness.db)
    await insertOne(harness.db, tables.nodeRuns, {
      id: 'race-run',
      taskId: 'owned-race',
      nodeId: 'worker',
      seq: 1,
      role: 'node-attempt',
      slotKey: encodeCanonicalRunSlot({
        kind: 'node',
        nodeId: 'worker',
        frame: { containerRunId: null, iteration: 0 },
      }),
      generationSeq: 0,
      attemptIndex: 0,
      recordMode: 'executable',
      provenanceQuality: 'recorded',
      envelopeNonce: 'nonce-race',
      status: 'running',
    })
    const identity = createWorkerIdentity({
      ownerId: 'race-owner',
      daemonGeneration: 'race-generation',
    })
    const { taskExecutionOwners } = tablesOf(harness.db)
    await insertOne(harness.db, taskExecutionOwners, {
      taskId: 'owned-race',
      ...identity,
      epoch: 1,
      state: 'claimed',
      leaseUntil: 100_000,
      revision: 1,
      lastHeartbeatAt: 1,
      updatedAt: 1,
    })
    const token = createOwnershipToken({
      taskId: 'owned-race',
      identity,
      epoch: 1,
      leaseUntil: 100_000,
      ownerRevision: 1,
    })
    const executionContext = createTaskExecutionContext({
      intentId: 'race-intent',
      token,
      persistence: createTaskExecutionPersistence(harness.db, {
        humanGateOpen: composeHumanGateOpenParticipantFactory(),
        historyRestrictions: epoch2RuntimeTestPorts(harness.db).historyRestrictions,
      }),
    })
    const merge = new DrizzleMergeStateLifecyclePersistence(harness.db)
    const lifecycle = new DrizzleTaskRuntimeLifecyclePersistence(harness.db, {
      async exists() {
        return true
      },
    })
    const outcomes = await Promise.all([
      merge.transition({
        nodeRunId: 'race-run',
        event: { kind: 'begin-isolation' },
        executionContext,
        now: 20,
      }),
      lifecycle.trySet({
        taskId: 'owned-race',
        to: 'awaiting_human',
        allowedFrom: ['running'],
        reason: 'w1-lock-race',
        executionContext,
        now: 20,
      }),
    ])
    expect(outcomes).toEqual([{ from: null, to: 'isolating' }, true])
    expect((await harness.db.select().from(tables.tasks))[0]!.status).toBe('awaiting_human')
    expect((await harness.db.select().from(tables.nodeRunRuntimeStates))[0]!.mergeState).toBe(
      'isolating',
    )
    expect((await harness.db.select().from(taskExecutionOwners))[0]!.revision).toBe(3)
  })
})

import { DatabaseHumanGateTaskLifecyclePersistence } from '@/modules/task-execution/infrastructure/humanGateTaskLifecyclePersistence'
import { sha256Hex } from '@/util/hash'
import type { HistoryRestrictionRequest } from '@/platform/contracts/historyRestriction'

describeEachProvider('RFC-395 W1 Task gate restriction injection', (harness) => {
  test('each lifecycle instance forwards its own provider and an absent provider still refuses replay', async () => {
    const base = taskInput('gate-task')
    await harness.session.transaction((tx) =>
      createTaskCreationParticipantInTx(tx).create({
        ...base,
        core: { ...base.core, status: 'running' },
      }),
    )
    const { collaborationGateOperations } = tablesOf(harness.db)
    const manifestJson = JSON.stringify({
      node: { id: 'gate-node', consumedUpstreamRunsJson: '{}' },
    })
    await harness.db.insert(collaborationGateOperations).values({
      id: 'gate-op',
      taskId: 'gate-task',
      gateKind: 'review',
      operationKind: 'open',
      gateRef: 'gate',
      idempotencyKey: 'gate-idempotency',
      requestHash: 'hash',
      expectedTaskRevision: 0,
      expectedGateRevision: 0,
      state: 'prepared',
      manifestJson,
      createdAt: 10,
      updatedAt: 10,
    })
    const runtime = new DrizzleTaskRuntimeLifecyclePersistence(harness.db, {
      async exists() {
        return true
      },
    })
    const requests: { instance: string; request: HistoryRestrictionRequest }[] = []
    const lifecycle = (instance: string) =>
      new DatabaseHumanGateTaskLifecyclePersistence(harness.db, runtime, {
        humanGateOpen: composeHumanGateOpenParticipantFactory(),
        historyRestrictions: {
          async check(_tx, request) {
            requests.push({ instance, request })
            throw new Error(`injected-${instance}`)
          },
        },
      })
    const first = lifecycle('first'),
      second = lifecycle('second')
    const input = {
      prepared: {
        operationId: 'gate-op',
        taskId: 'gate-task',
        gateKind: 'review' as const,
        expectedTaskRevision: 0,
        manifestDigest: sha256Hex(manifestJson),
      },
      now: 20,
    }
    await expect(first.parkPrepared(input)).rejects.toThrow('injected-first')
    await expect(second.parkPrepared(input)).rejects.toThrow('injected-second')
    await expect(first.parkPrepared(input)).rejects.toThrow('injected-first')
    expect(requests.map((entry) => entry.instance)).toEqual(['first', 'second', 'first'])
    expect(
      requests.every(
        ({ request }) =>
          request.taskId === 'gate-task' &&
          request.action === 'replay' &&
          request.nodeRunIds.includes('gate-node'),
      ),
    ).toBe(true)
    await expect(
      // @ts-expect-error Deliberately exercise the runtime refusal for a missing provider.
      new DatabaseHumanGateTaskLifecyclePersistence(harness.db, runtime, {
        humanGateOpen: composeHumanGateOpenParticipantFactory(),
      }).parkPrepared(input),
    ).rejects.toThrow('gate-history-restriction-provider-required')
    expect((await harness.db.select().from(collaborationGateOperations))[0]!.state).toBe('prepared')
    const { tasks } = tablesOf(harness.db)
    expect((await harness.db.select().from(tasks))[0]!.status).toBe('running')
  })
})
