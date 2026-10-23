// RFC-395 II-a A2: preserve all three definition CAS operations, config projections and exact room bytes on both providers.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  WorkgroupLaunchConfigSchema,
  WorkgroupRuntimeConfigSchema,
  type WorkflowDefinition,
  type WorkgroupRuntimeConfig,
} from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  taskWorkgroupConfigSelection,
  taskWorkgroupLaunchSelection,
} from '@/modules/task-execution/infrastructure/taskWorkgroupConfig'
import { insertOne } from '@/platform/persistence/singleInsert'
import { createTaskDefinitionWriteParticipantInTx } from '@/modules/task-execution/infrastructure/taskDefinitionWriteParticipant'
import { createWorkgroupTaskRoomTaskParticipantInTx } from '@/modules/task-execution/infrastructure/workgroupTaskRoomTaskParticipant'
import { createWorkgroupHostLedgerParticipantInTx } from '@/modules/task-execution/infrastructure/workgroupHostLedgerParticipant'
import {
  decodeTaskWorkgroupConfig,
  decodeTaskWorkgroupLaunchConfig,
  workgroupLaunchMode,
} from '@/modules/task-execution/domain/taskWorkgroupConfig'
import { DrizzleDynamicWorkflowPersistence } from '@/modules/task-execution/infrastructure/dynamicWorkflowPersistence'
import { DrizzleTaskEngineApplicationPersistence } from '@/modules/task-execution/infrastructure/taskEngineApplicationPersistence'
import { DrizzleMemoryDistillWorkStore } from '@/modules/memory/infrastructure/memoryDistillWorkStore'
import { extractAgentIdsFromWorkgroupConfig } from '@/modules/memory/application/distill/schedule'
import { createTaskExecutionReadModels } from '@/modules/task-execution/infrastructure/taskExecutionReadModels'
import {
  syncWorkflow,
  type TaskWorkflowSyncDependencies,
} from '@/modules/task-execution/infrastructure/taskRouteOperations'
import { isTaskClarifySuppressed } from '@/modules/collaboration/infrastructure/collaborationWorkgroupClarify'
import { parseConfig } from '@/modules/resource-catalog/infrastructure/workgroupTaskRoom'
import { resolveTaskEngineSelection } from '@/modules/task-execution/engine/task/taskEngineRegistry'
import { describeEachProvider } from './helpers/eachProvider'
import {
  taskFixture,
  patchTaskFixture,
  readTaskFixtures,
  workflowFixture,
  nodeRunFixture,
  readNodeRunFixtures,
  type TaskFixtureSpec,
} from './helpers/model'
import { createClarifyAnswerQueries } from '@/modules/collaboration/composition'

async function readConfig(db: PersistenceDb, taskId: string) {
  const { tasks } = tablesOf(db)
  const [row] = await db
    .select({ config: taskWorkgroupConfigSelection(db) })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  return row?.config ?? null
}

const definition: WorkflowDefinition = { $schema_version: 4, inputs: [], nodes: [], edges: [] }
const nextDefinition: WorkflowDefinition = {
  ...definition,
  inputs: [{ key: 'message', kind: 'text', label: 'message' }],
  nodes: [{ id: 'input', kind: 'input', inputKey: 'message' }],
}
const config: WorkgroupRuntimeConfig = {
  workgroupId: 'group',
  workgroupName: 'launch name',
  mode: 'free_collab',
  leaderMemberId: null,
  goal: 'launch goal',
  switches: { shareOutputs: true, directMessages: false, blackboard: false },
  maxRounds: 5,
  completionGate: false,
  instructions: 'original instructions',
  members: [
    {
      id: 'agent',
      memberType: 'agent',
      agentId: 'agent-id',
      agentName: 'Agent',
      userId: null,
      displayName: 'agent',
      roleDesc: '',
    },
  ],
}
const clarify = {
  async loadProjection() {
    return { askingNodeRunIds: [], stopDirectives: [] }
  },
  async dismissOpenSelfClarifies() {
    return { dismissedSessions: 0, parks: [] }
  },
}

for (const value of [
  null,
  '',
  '{broken',
  'null',
  '[]',
  '7',
  '{}',
  JSON.stringify({ mode: 'unknown', goal: '' }),
  JSON.stringify({ mode: 'dynamic_workflow', workgroupName: 'partial', goal: 'partial goal' }),
  JSON.stringify(config),
]) {
  test(`pure split retains strict runtime parsing and tolerant launch reads: ${String(value)}`, () => {
    const projected = decodeTaskWorkgroupConfig(value)
    expect(decodeTaskWorkgroupLaunchConfig(value)).toEqual(projected.launch)
    let raw: unknown = null
    try {
      raw = value === null ? null : JSON.parse(value)
    } catch {
      /* old corrupt-config fallback */
    }
    const runtime = WorkgroupRuntimeConfigSchema.safeParse(raw)
    expect(projected.runtime.config).toEqual(runtime.success ? runtime.data : null)
    expect(projected.runtime.revision).toBe(value)
    const record =
      raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : null
    for (const field of ['workgroupName', 'goal'] as const) {
      const old = record?.[field]
      expect(projected.launch[field]).toBe(typeof old === 'string' && old.length > 0 ? old : null)
    }
    expect(projected.launch.mode).toBe(typeof record?.mode === 'string' ? record.mode : null)
    expect(parseConfig(projected.runtime)?.config ?? null).toEqual(
      runtime.success ? runtime.data : null,
    )
    expect(
      resolveTaskEngineSelection(
        { subject: { kind: 'workgroup', sourceId: 'group' }, workgroupConfig: projected },
        null,
      ).engine,
    ).toBe(
      workgroupLaunchMode(projected.launch) === 'dynamic_workflow'
        ? 'dw-generate'
        : 'workgroup-turns',
    )
  })
}

test('shared launch shape contains only immutable facts while runtime exports remain compatible', () => {
  expect(WorkgroupLaunchConfigSchema.parse(config)).toEqual({
    workgroupId: 'group',
    workgroupName: 'launch name',
    mode: 'free_collab',
    leaderMemberId: null,
    goal: 'launch goal',
  })
  expect(WorkgroupRuntimeConfigSchema.parse(config)).toEqual(config)
})

describeEachProvider('RFC-395 II-a A2 definition writer and workgroup read port', (harness) => {
  async function seed(overrides: Partial<TaskFixtureSpec> = {}) {
    const taskId = ulid(),
      workflowId = ulid()
    await workflowFixture(harness.db, {
      id: workflowId,
      name: `definition-${workflowId}`,
      definition: JSON.stringify(nextDefinition),
      version: 2,
    })
    await taskFixture(harness.db, {
      id: taskId,
      workflowId,
      workflowSnapshot: JSON.stringify(definition),
      workflowVersion: 1,
      inputs: '{}',
      refClosureJson: 'old closure',
      name: 'definition task',
      status: 'failed',
      startedAt: 1,
      lifecycleEventRevision: 4,
      repoPath: '/repo',
      worktreePath: '/workspace',
      baseBranch: 'main',
      branch: 'task',
      ...overrides,
    })
    return { taskId, workflowId }
  }

  test('sync writer updates snapshot, version, closure and lifecycle in one CAS', async () => {
    const { taskId } = await seed()
    const result = await harness.session.transaction((tx) =>
      createTaskDefinitionWriteParticipantInTx(tx).syncWorkflow({
        taskId,
        expectedStatus: 'failed',
        expectedLifecycleRevision: 4,
        snapshot: 'new snapshot',
        sourceRevision: 2,
        resourceClosure: 'new closure',
        occurredAt: 42,
      }),
    )
    expect(result).toBe(5)
    expect((await readTaskFixtures(harness.db, { id: taskId }))[0]).toMatchObject({
      status: 'interrupted',
      workflowSnapshot: 'new snapshot',
      workflowVersion: 2,
      refClosureJson: 'new closure',
      lifecycleEventRevision: 5,
      finishedAt: 42,
    })
  })

  for (const conflict of ['status', 'revision', 'pruned', 'missing'] as const) {
    test(`sync CAS ${conflict} miss preserves every definition column`, async () => {
      const { taskId } = await seed(conflict === 'pruned' ? { workspacePrunedAt: 9 } : {})
      const before = await readTaskFixtures(harness.db, { id: taskId })
      const result = await harness.session.transaction((tx) =>
        createTaskDefinitionWriteParticipantInTx(tx).syncWorkflow({
          taskId: conflict === 'missing' ? 'missing' : taskId,
          expectedStatus: conflict === 'status' ? 'done' : 'failed',
          expectedLifecycleRevision: conflict === 'revision' ? 3 : 4,
          snapshot: 'must not land',
          sourceRevision: 2,
          resourceClosure: null,
          occurredAt: 42,
        }),
      )
      expect(result).toBeNull()
      expect(await readTaskFixtures(harness.db, { id: taskId })).toEqual(before)
    })
  }

  for (const conflict of [false, true]) {
    test(`sync command retains ${conflict ? 'task-not-syncable conflict code' : 'resume handoff'} through the port`, async () => {
      const { taskId, workflowId } = await seed({ refClosureJson: null })
      let resumed = false
      const actor = buildActor({
        source: 'session',
        user: {
          id: 'definition-actor',
          username: 'actor',
          displayName: 'actor',
          role: 'admin',
          status: 'active',
        },
      })
      const dependencies: TaskWorkflowSyncDependencies = {
        db: harness.db,
        persistence: {} as TaskWorkflowSyncDependencies['persistence'],
        activity: {
          async awaitReleasedSettled() {},
          isActive: () => false,
        } as TaskWorkflowSyncDependencies['activity'],
        resourceAuthorityFor: () =>
          ({
            resources: {
              async loadAuthorized() {
                return [
                  {
                    kind: 'workflow-launch',
                    workflow: {
                      id: workflowId,
                      name: 'workflow',
                      version: 2,
                      definition: nextDefinition,
                    },
                  },
                ]
              },
              async freezeCallClosure() {
                return null
              },
            },
          }) as unknown as ReturnType<TaskWorkflowSyncDependencies['resourceAuthorityFor']>,
        async validateHostWorkflow() {
          if (conflict) await patchTaskFixture(harness.db, { id: taskId }, { status: 'canceled' })
          return { ok: true, issues: [] }
        },
        async resumeTaskAs() {
          resumed = true
        },
        now: () => 42,
      }
      if (conflict) {
        await expect(
          syncWorkflow(dependencies, { actor, taskId, expectedVersion: 2 }),
        ).rejects.toMatchObject({ code: 'task-not-syncable', status: 409 })
        expect((await readTaskFixtures(harness.db, { id: taskId }))[0]?.workflowSnapshot).toBe(
          JSON.stringify(definition),
        )
        expect(resumed).toBe(false)
      } else {
        await syncWorkflow(dependencies, { actor, taskId, expectedVersion: 2 })
        expect((await readTaskFixtures(harness.db, { id: taskId }))[0]?.workflowVersion).toBe(2)
        expect(resumed).toBe(true)
      }
    })
  }

  test('room replaceConfig retains exact supplied bytes and immutable launch facts', async () => {
    const oldBytes = JSON.stringify({ ...config, unknown: { keep: true } }, null, 2)
    const nextBytes =
      JSON.stringify(
        {
          ...config,
          instructions: 'edited',
          maxRounds: 9,
          unknown: { keep: true },
          members: [
            ...config.members,
            {
              ...config.members[0],
              id: 'new-member',
              displayName: 'new-member',
              agentId: 'new-agent',
            },
          ],
        },
        null,
        4,
      ) + '\n'
    const { taskId } = await seed({ workgroupId: 'group', workgroupConfigJson: oldBytes })
    const before = await readConfig(harness.db, taskId)
    const result = await harness.session.transaction((tx) =>
      createWorkgroupTaskRoomTaskParticipantInTx(tx, clarify).replaceConfig({
        taskId,
        expectedConfigJson: oldBytes,
        nextConfigJson: nextBytes,
        newCollaborators: [],
      }),
    )
    expect(result).toBe(true)
    expect((await readTaskFixtures(harness.db, { id: taskId }))[0]?.workgroupConfigJson).toBe(
      nextBytes,
    )
    const after = await readConfig(harness.db, taskId)
    expect(after?.launch).toEqual(before?.launch)
    expect(after?.runtime.config?.maxRounds).toBe(9)
    expect(after?.runtime.raw?.unknown).toEqual({ keep: true })
    expect(after?.runtime.revision).toBe(nextBytes)
    expect(extractAgentIdsFromWorkgroupConfig(after?.runtime.config ?? null)).toEqual([
      'agent-id',
      'new-agent',
    ])
  })

  test('room JSON CAS compares bytes and a miss does not add collaborators', async () => {
    const bytes = JSON.stringify(config, null, 2)
    const { taskId } = await seed({ workgroupId: 'group', workgroupConfigJson: bytes })
    const before = await readTaskFixtures(harness.db, { id: taskId })
    const result = await harness.session.transaction((tx) =>
      createWorkgroupTaskRoomTaskParticipantInTx(tx, clarify).replaceConfig({
        taskId,
        expectedConfigJson: JSON.stringify(config),
        nextConfigJson: '{}',
        newCollaborators: [{ userId: 'would-fail-fk', addedBy: 'would-fail-fk', addedAt: 3 }],
      }),
    )
    expect(result).toBe(false)
    expect(await readTaskFixtures(harness.db, { id: taskId })).toEqual(before)
    const { taskCollaborators } = tablesOf(harness.db)
    expect(
      await harness.db.select().from(taskCollaborators).where(eq(taskCollaborators.taskId, taskId)),
    ).toEqual([])
  })

  test('dynamic approval uses the port with its holder, intent and event in the caller transaction', async () => {
    const actorUserId = ulid()
    const { users, taskExecutionIntents } = tablesOf(harness.db)
    await insertOne(harness.db, users, {
      id: actorUserId,
      username: actorUserId,
      displayName: actorUserId,
      role: 'user',
      createdAt: 1,
      updatedAt: 1,
    })
    const { taskId } = await seed({
      status: 'awaiting_review',
      errorSummary: 'old error',
      errorMessage: 'old error',
      failedNodeId: 'old-node',
    })
    const runId = ulid()
    await nodeRunFixture(harness.db, {
      id: runId,
      taskId,
      nodeId: '__wg_leader__',
      status: 'awaiting_review',
      rerunCause: 'dw-gate',
    })
    const input = {
      taskId,
      expectedStatus: 'awaiting_review' as const,
      actorUserId,
      occurredAt: 42,
      workflowSnapshot: JSON.stringify(nextDefinition),
      closeHolder: { rerunCause: 'dw-gate' as const, reason: 'dw-gate-approved' as const },
      identity: {
        operationRef: ulid(),
        eventGroupId: ulid(),
        eventGroupOrdinal: 0,
        correlationRef: taskId,
      },
    }
    const result = await harness.session.transaction((tx) =>
      createWorkgroupTaskRoomTaskParticipantInTx(tx, clarify).continueTask(input),
    )
    expect(result).not.toBeNull()
    expect(result?.closedHolderIds).toEqual([runId])
    expect((await readTaskFixtures(harness.db, { id: taskId }))[0]).toMatchObject({
      status: 'pending',
      workflowSnapshot: JSON.stringify(nextDefinition),
      lifecycleEventRevision: 5,
      finishedAt: null,
      errorSummary: null,
      errorMessage: null,
      failedNodeId: null,
    })
    expect((await readNodeRunFixtures(harness.db, { id: runId }))[0]?.status).toBe('done')
    expect(
      await harness.db
        .select({ kind: taskExecutionIntents.kind })
        .from(taskExecutionIntents)
        .where(eq(taskExecutionIntents.taskId, taskId)),
    ).toEqual([{ kind: 'gate-continuation' }])
    expect(
      await harness.session.transaction((tx) =>
        createWorkgroupTaskRoomTaskParticipantInTx(tx, clarify).continueTask(input),
      ),
    ).toBeNull()
  })

  for (const conflict of ['status', 'revision', 'missing'] as const) {
    test(`dynamic approval ${conflict} CAS miss leaves snapshot and lifecycle unchanged`, async () => {
      const { taskId } = await seed({ status: 'awaiting_review' })
      const before = await readTaskFixtures(harness.db, { id: taskId })
      const result = await harness.session.transaction((tx) =>
        createTaskDefinitionWriteParticipantInTx(tx).continueWorkgroupTask({
          taskId: conflict === 'missing' ? 'missing' : taskId,
          expectedStatus: conflict === 'status' ? 'interrupted' : 'awaiting_review',
          expectedLifecycleRevision: conflict === 'revision' ? 3 : 4,
          snapshot: 'must not land',
        }),
      )
      expect(result).toBe(false)
      expect(await readTaskFixtures(harness.db, { id: taskId })).toEqual(before)
    })
  }

  test('caller rollback undoes each definition operation', async () => {
    const bytes = JSON.stringify(config)
    const { taskId } = await seed({ workgroupConfigJson: bytes })
    const before = await readTaskFixtures(harness.db, { id: taskId })
    for (const operation of ['sync', 'config', 'approval'] as const) {
      await expect(
        harness.session.transaction(async (tx) => {
          const port = createTaskDefinitionWriteParticipantInTx(tx)
          if (operation === 'sync')
            await port.syncWorkflow({
              taskId,
              expectedStatus: 'failed',
              expectedLifecycleRevision: 4,
              snapshot: '{}',
              sourceRevision: 2,
              resourceClosure: null,
              occurredAt: 42,
            })
          if (operation === 'config')
            await port.replaceWorkgroupRuntimeConfig({
              taskId,
              expectedRevision: bytes,
              nextConfig: '{}',
            })
          if (operation === 'approval')
            await port.continueWorkgroupTask({
              taskId,
              expectedStatus: 'failed',
              expectedLifecycleRevision: 4,
              snapshot: '{}',
            })
          throw new Error('rollback definition')
        }),
      ).rejects.toThrow('rollback definition')
      expect(await readTaskFixtures(harness.db, { id: taskId })).toEqual(before)
    }
  })

  test('legacy lifecycle definition companion stays inside the same status CAS', async () => {
    const { taskId } = await seed()
    const input = {
      taskId,
      from: 'failed' as const,
      to: 'pending' as const,
      expectedLifecycleRevision: 4,
      now: 42,
      workspacePruneDecision: { prune: false as const },
      extra: { workflowSnapshot: 'legacy snapshot', workflowVersion: null, refClosureJson: null },
    }
    const changed = await harness.session.transaction(async (tx) =>
      createTaskDefinitionWriteParticipantInTx(tx).transitionLifecycle(input),
    )
    expect(changed).toEqual([{ id: taskId, lifecycleEventRevision: 5 }])
    const after = await readTaskFixtures(harness.db, { id: taskId })
    expect(after[0]).toMatchObject({
      status: 'pending',
      workflowSnapshot: 'legacy snapshot',
      workflowVersion: null,
      refClosureJson: null,
    })
    expect(
      await harness.session.transaction(async (tx) =>
        createTaskDefinitionWriteParticipantInTx(tx).transitionLifecycle({
          ...input,
          extra: { workflowSnapshot: 'must not land' },
        }),
      ),
    ).toEqual([])
    expect(await readTaskFixtures(harness.db, { id: taskId })).toEqual(after)
  })

  test('absent storage config preserves null SQL projections and existing reader fallbacks', async () => {
    const { taskId } = await seed({ workgroupConfigJson: null })
    expect(await readConfig(harness.db, taskId)).toBeNull()
    const { tasks } = tablesOf(harness.db)
    const [launch] = await harness.db
      .select({ value: taskWorkgroupLaunchSelection(harness.db) })
      .from(tasks)
      .where(eq(tasks.id, taskId))
    expect(launch?.value).toBeNull()
    expect(
      (await new DrizzleDynamicWorkflowPersistence(harness.db).loadTask(taskId))?.workgroupConfig,
    ).toBeNull()
    expect(
      (
        await new DrizzleMemoryDistillWorkStore(
          harness.db,
          createClarifyAnswerQueries(harness.db),
        ).findTaskScope(taskId)
      )?.workgroupConfig,
    ).toBeNull()
    expect(await isTaskClarifySuppressed(harness.db, { taskId })).toBe(false)
    expect(parseConfig(null)).toBeNull()
    expect(workgroupLaunchMode(null)).toBeNull()
  })

  test('each storage reader forwards the same launch/runtime view without rereading the workgroup resource', async () => {
    const bytes = JSON.stringify({ ...config, unknown: ['kept'] }, null, 2)
    const { taskId } = await seed({ workgroupId: 'group', workgroupConfigJson: bytes })
    const expected = decodeTaskWorkgroupConfig(bytes)
    expect(await readConfig(harness.db, taskId)).toEqual(expected)
    expect(
      (await new DrizzleDynamicWorkflowPersistence(harness.db).loadTask(taskId))?.workgroupConfig,
    ).toEqual(expected)
    expect(
      (await new DrizzleTaskEngineApplicationPersistence(harness.db).load(taskId))?.task
        .workgroupConfig,
    ).toEqual(expected)
    expect(
      (
        await new DrizzleMemoryDistillWorkStore(
          harness.db,
          createClarifyAnswerQueries(harness.db),
        ).findTaskScope(taskId)
      )?.workgroupConfig,
    ).toEqual(expected)
    expect(
      (await createTaskExecutionReadModels(harness.db).executionOutcome.find(taskId))?.task
        .workgroupConfig,
    ).toEqual(expected)
    await harness.session.transaction(async (tx) => {
      expect(
        (await createWorkgroupTaskRoomTaskParticipantInTx(tx, clarify).load(taskId))
          ?.workgroupConfig,
      ).toEqual(expected)
      expect(
        (await createWorkgroupHostLedgerParticipantInTx(tx, clarify).load(taskId))?.workgroupConfig,
      ).toEqual(expected)
    })
    expect(await isTaskClarifySuppressed(harness.db, { taskId })).toBe(true)
    expect(await readConfig(harness.db, 'missing')).toBeNull()
  })

  test('partial historical config still supports clarify and launch fields when the full runtime schema fails', async () => {
    const { taskId } = await seed({
      workgroupConfigJson: JSON.stringify({
        workgroupName: 'historical',
        mode: 'free_collab',
        members: [{ memberType: 'agent' }],
      }),
    })
    const value = await readConfig(harness.db, taskId)
    expect(value?.launch.workgroupName).toBe('historical')
    const { tasks } = tablesOf(harness.db)
    const [launch] = await harness.db
      .select({ value: taskWorkgroupLaunchSelection(harness.db) })
      .from(tasks)
      .where(eq(tasks.id, taskId))
    expect(launch?.value).toEqual(value?.launch)
    expect(value?.runtime.config).toBeNull()
    expect(await isTaskClarifySuppressed(harness.db, { taskId })).toBe(true)
  })
})
