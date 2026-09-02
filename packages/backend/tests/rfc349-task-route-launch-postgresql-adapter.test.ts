// RFC-349 — direct Agent/Workgroup launch keeps the existing route contract
// while the selected PostgreSQL provider owns the task row, collaborators,
// launch intent, frozen resource closure and committed lifecycle event.

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentSchema, WorkflowDefinitionSchema, WorkgroupSchema } from '@agent-workflow/shared'

import { buildActor, type Actor } from '@/auth/actor'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { agentLaunchResourceIntegrityParticipantBrand } from '@/modules/resource-catalog/domain/participantBrands'
import { AuthorityClaimRegistry } from '@/modules/identity-access/application/operationContext'
import type { AgentLaunchResourceIntegrityParticipant } from '@/modules/resource-catalog/public/participants'
import type { ProtectedMrLaunchGuard } from '@/modules/integration/public/mrTerminalControl'
import type { TaskExecutionResourceAuthority } from '@/modules/task-execution/application/ports/taskExecutionResourceSnapshots'
import type { AgentLaunchResourceOperations } from '@/modules/task-execution/application/ports/agentLaunchResourceOperations'
import type { TaskDriveSubmission } from '@/modules/task-execution/application/drive/taskDriveTypes'
import {
  createPostgresqlTaskExecutionLaunchParticipant,
  createPostgresqlTaskRouteLaunchOperations,
  type PostgresqlTaskRouteLaunchDependencies,
  type PostgresqlTaskRoutePreparedWorkspace,
  type PostgresqlTaskRouteWorkspaceParticipant,
} from '@/modules/task-execution/composition/taskRouteLaunch'
import type { SourceTerminationSnapshot } from '@/modules/task-execution/public/types'
import { registerAfterCommitEventPump } from '@/platform/events/committed/runtime'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

interface SqlResponse {
  readonly objects?: readonly Record<string, unknown>[]
  readonly values?: readonly (readonly unknown[])[]
  readonly count?: number
}

function sqlRows(response: SqlResponse = {}): SqlRows {
  const objects = [...(response.objects ?? [])] as Array<Record<string, unknown>> & {
    count?: number
  }
  objects.count = response.count ?? objects.length
  return Object.assign(Promise.resolve(objects), {
    async values() {
      return response.values ?? []
    },
  })
}

function postgresqlFixture(input: {
  readonly activeUserIds: readonly string[]
  readonly visibleTaskIds?: readonly string[]
  readonly trace: string[]
}) {
  const executions: Array<{ readonly sql: string; readonly parameters: readonly unknown[] }> = []
  let insertedEvent: readonly unknown[] | null = null
  const run = (query: string, parameters: readonly unknown[] = []): SqlRows => {
    executions.push({ sql: query, parameters })
    const normalized = query.trim().toLowerCase()
    if (normalized.startsWith('insert into "agent_workflow"."tasks"')) {
      input.trace.push('task:insert')
    }
    if (normalized === 'commit') input.trace.push('db:commit')
    // RFC-349: matches both the one-shot live-write marker and the
    // per-transaction generation fence.
    if (normalized.includes('agent_workflow_meta') && normalized.includes('database_generations')) {
      return sqlRows({
        objects: [{ generation_id: 'dbg_task_route_launch_pg' }],
        values: [['dbg_task_route_launch_pg']],
      })
    }
    if (normalized.includes('from "agent_workflow"."users"')) {
      return sqlRows({ values: input.activeUserIds.map((userId) => [userId]) })
    }
    if (normalized.includes('from "agent_workflow"."committed_event_family_cutovers"')) {
      return sqlRows({
        values: [['task-execution', 'task-lifecycle', 'dispatchable', 1, 0, 'test-cutover']],
      })
    }
    if (normalized.startsWith('insert into "agent_workflow"."committed_events"')) {
      insertedEvent = [...parameters]
      return sqlRows({ count: 1 })
    }
    if (normalized.includes('from "agent_workflow"."committed_events"')) {
      const eventId = insertedEvent?.[0]
      return sqlRows({
        values:
          eventId !== undefined && parameters.includes(eventId) && insertedEvent !== null
            ? [insertedEvent]
            : [],
      })
    }
    if (normalized.includes('from "agent_workflow"."committed_event_aggregate_heads"')) {
      return sqlRows()
    }
    if (normalized.includes('from "agent_workflow"."tasks"')) {
      const visible = (input.visibleTaskIds ?? []).filter((taskId) => parameters.includes(taskId))
      return sqlRows({ values: visible.map((taskId) => [taskId]) })
    }
    return sqlRows({ count: normalized.startsWith('insert ') ? 1 : 0 })
  }
  const connection: PostgresqlReservedConnection = { unsafe: run, release() {} }
  const pool: PostgresqlPool = {
    async reserve() {
      return connection
    },
    unsafe: run,
    async close() {},
  }
  const runtime: PostgresqlDatabaseRuntime = {
    provider: 'postgresql',
    generationId: 'dbg_task_route_launch_pg',
    async health() {
      throw new Error('not used')
    },
    async readiness() {
      throw new Error('not used')
    },
    async acquireMigrationAdvisoryLock() {
      throw new Error('not used')
    },
    providerPool: () => pool,
    async close() {},
  }
  return { db: createPostgresqlDatabaseClient(runtime), executions }
}

const actor = buildActor({
  user: {
    id: 'owner-1',
    username: 'owner',
    displayName: 'Owner',
    role: 'user',
    status: 'active',
  },
  source: 'session',
})

const agent = AgentSchema.parse({
  id: 'agent-1',
  name: 'writer',
  description: 'Writes one artifact',
  ownerUserId: actor.user.id,
  visibility: 'public',
  builtin: false,
  outputs: ['result'],
  inputs: [{ name: 'artifact', kind: 'path<txt>', required: true }],
  syncOutputsOnIterate: true,
  permission: {},
  skills: [],
  dependsOn: [],
  mcp: [],
  plugins: [],
  frontmatterExtra: {},
  bodyMd: '',
  schemaVersion: 1,
  createdAt: 1,
  updatedAt: 1,
})

const workgroup = WorkgroupSchema.parse({
  id: 'workgroup-1',
  name: 'delivery-team',
  description: 'Delivery team',
  instructions: 'Coordinate the delivery',
  mode: 'leader_worker',
  outputContract: 'files',
  leaderMemberId: 'member-agent',
  switches: { shareOutputs: true, directMessages: true, blackboard: true },
  maxRounds: 4,
  completionGate: true,
  clarifyBudget: 2,
  fanOut: false,
  members: [
    {
      id: 'member-agent',
      memberType: 'agent',
      agentName: agent.name,
      agentId: agent.id,
      userId: null,
      displayName: 'writer',
      roleDesc: 'writes',
      sortOrder: 0,
    },
    {
      id: 'member-human',
      memberType: 'human',
      agentName: null,
      agentId: null,
      userId: 'human-1',
      displayName: 'reviewer',
      roleDesc: 'reviews',
      sortOrder: 1,
    },
  ],
  version: 3,
  ownerUserId: actor.user.id,
  visibility: 'public',
  schemaVersion: 1,
  createdAt: 1,
  updatedAt: 2,
})

const workflow = Object.freeze({
  id: 'workflow-1',
  name: 'Release workflow',
  version: 7,
  definition: WorkflowDefinitionSchema.parse({
    $schema_version: 1,
    inputs: [],
    nodes: [],
    edges: [],
  }),
})

const temporaryRoots: string[] = []

async function workspaceParticipant(input: {
  readonly committed: string[]
  readonly rolledBack: string[]
  readonly sourceTerminationSignals: Array<AbortSignal | undefined>
  readonly trace: string[]
}): Promise<PostgresqlTaskRouteWorkspaceParticipant> {
  const root = await mkdtemp(join(tmpdir(), 'rfc349-task-route-launch-'))
  temporaryRoots.push(root)
  return Object.freeze({
    async prepare(
      request: Parameters<PostgresqlTaskRouteWorkspaceParticipant['prepare']>[0],
    ): Promise<PostgresqlTaskRoutePreparedWorkspace> {
      input.trace.push('workspace:prepare')
      input.sourceTerminationSignals.push(request.sourceTerminationSignal)
      const worktreePath = join(root, request.taskId)
      mkdirSync(worktreePath, { recursive: true })
      writeFileSync(join(worktreePath, '.workspace-prepared'), request.gitCommitIdentity.email)
      return Object.freeze({
        taskId: request.taskId,
        kind: 'scratch' as const,
        spaceKind: 'scratch' as const,
        repoPath: worktreePath,
        repoUrl: null,
        cachedRepoId: null,
        repoGroupId: null,
        repoGroupName: null,
        worktreePath,
        baseBranch: 'main',
        branch: `agent-workflow/${request.taskId}`,
        baseCommit: 'base-commit',
        earlyError: null,
        repositories: Object.freeze([
          Object.freeze({
            repoIndex: 0,
            repoPath: worktreePath,
            repoUrl: null,
            cachedRepoId: null,
            baseBranch: 'main',
            branch: `agent-workflow/${request.taskId}`,
            workingBranch: null,
            baseCommit: 'base-commit',
            worktreePath,
            worktreeDirName: '',
            mountPath: '',
            subdir: '',
            readonly: false,
            workspaceProfileVersion: 1,
            workspaceProfileDigest: 'profile-v1',
            hasSubmodules: false,
            submoduleInitOk: true,
            submoduleInitError: null,
          }),
        ]),
        nodePaths: Object.freeze([]),
        commit() {
          input.trace.push('workspace:commit')
          input.committed.push(request.taskId)
        },
        async rollback() {
          input.trace.push('workspace:rollback')
          rmSync(worktreePath, { recursive: true, force: true })
          input.rolledBack.push(request.taskId)
          return { taskId: request.taskId, complete: true, failures: [] }
        },
      })
    },
  })
}

function integrity(calls: string[][]): AgentLaunchResourceIntegrityParticipant {
  return Object.freeze({
    [agentLaunchResourceIntegrityParticipantBrand]:
      'agent-launch-resource-integrity-participant' as const,
    async assertUsable(
      input: Parameters<AgentLaunchResourceIntegrityParticipant['assertUsable']>[0],
    ) {
      calls.push([...input.rootAgentIds])
    },
  })
}

async function harness(input: {
  readonly activeUserIds: readonly string[]
  readonly visibleTaskIds?: readonly string[]
}) {
  const trace: string[] = []
  const postgres = postgresqlFixture({ ...input, trace })
  const configRoot = await mkdtemp(join(tmpdir(), 'rfc349-task-route-launch-config-'))
  temporaryRoots.push(configRoot)
  const committed: string[] = []
  const rolledBack: string[] = []
  const submissions: TaskDriveSubmission[] = []
  const closures: Array<{ readonly actor: Actor; readonly workflowId: string }> = []
  const integrityCalls: string[][] = []
  const sourceTerminationSignals: Array<AbortSignal | undefined> = []
  const authority = new AuthorityClaimRegistry().mintLocalAuthority({
    userId: actor.user.id,
    source: 'system',
  })
  const resourceAuthorityFor = (currentActor: Actor): TaskExecutionResourceAuthority =>
    Object.freeze({
      actor: currentActor,
      authority,
      resources: Object.freeze({
        async loadAuthorized(
          _pair: Parameters<TaskExecutionResourceAuthority['resources']['loadAuthorized']>[0],
          requests: Parameters<TaskExecutionResourceAuthority['resources']['loadAuthorized']>[1],
        ) {
          return Object.freeze(
            requests.map((request) => {
              if (request.kind !== 'workflow-launch') {
                throw new Error(`unexpected test resource request: ${request.kind}`)
              }
              if (request.workflowId !== workflow.id) {
                throw new Error(`unexpected test workflow: ${request.workflowId}`)
              }
              return Object.freeze({ kind: 'workflow-launch' as const, workflow })
            }),
          )
        },
        async freezeCallClosure(
          pair: Parameters<TaskExecutionResourceAuthority['resources']['freezeCallClosure']>[0],
          root: Parameters<TaskExecutionResourceAuthority['resources']['freezeCallClosure']>[1],
        ) {
          closures.push({ actor: pair.actor, workflowId: root.id })
          return null
        },
      }),
    })
  const ids = ['task-agent', 'intent-agent', 'task-workgroup', 'intent-workgroup']
  const dependencies: PostgresqlTaskRouteLaunchDependencies = {
    db: postgres.db,
    configPath: join(configRoot, 'config.json'),
    resourceAuthorityFor,
    gitCommitIdentity: {
      async execute(userId) {
        expect(userId).toBe(actor.user.id)
        return { name: 'Owner', email: 'owner@example.test' }
      },
    },
    workspace: await workspaceParticipant({
      committed,
      rolledBack,
      sourceTerminationSignals,
      trace,
    }),
    coordinator: {
      async submit(submission) {
        trace.push('coordinator')
        submissions.push(submission)
        return { kind: 'accepted', taskId: submission.taskId }
      },
    },
    agent: {
      resources: Object.freeze<AgentLaunchResourceOperations>({
        async loadVisibleAgent(_actor, agentId) {
          return agentId === agent.id ? agent : null
        },
        async ensureHostWorkflow() {},
        async validateHostWorkflow() {
          return { ok: true, issues: [] }
        },
      }),
      integrity: integrity(integrityCalls),
    },
    workgroup: Object.freeze({
      async loadVisible(_actor: Actor, workgroupId: string) {
        return workgroupId === workgroup.id ? workgroup : null
      },
      async loadExistingAgentIds(agentIds: readonly string[]) {
        return agentIds.filter((agentId) => agentId === agent.id)
      },
      async ensureHostWorkflow() {},
      integrity: integrity(integrityCalls),
    }),
    id() {
      const id = ids.shift()
      if (id === undefined) throw new Error('fixture id sequence exhausted')
      return id
    },
    now: () => 1_700_000_000_000,
  }
  return {
    operations: createPostgresqlTaskRouteLaunchOperations(dependencies),
    participant: createPostgresqlTaskExecutionLaunchParticipant(dependencies),
    resources: resourceAuthorityFor(actor),
    executions: postgres.executions,
    committed,
    rolledBack,
    submissions,
    closures,
    integrityCalls,
    sourceTerminationSignals,
    trace,
  }
}

function launchGuard(input: {
  readonly trace: string[]
  readonly snapshot: SourceTerminationSnapshot
  readonly failVerifyAt?: number
}): ProtectedMrLaunchGuard {
  const controller = new AbortController()
  let verifyCount = 0
  return Object.freeze({
    id: 'guard-1',
    signal: controller.signal,
    snapshot: input.snapshot,
    assertCanCommit() {
      input.trace.push('guard:assert')
    },
    async verifyCanCommit() {
      verifyCount++
      input.trace.push('guard:verify')
      if (input.failVerifyAt === verifyCount) throw new Error('guard verification failed')
    },
    async taskCommitted(taskId: string) {
      input.trace.push(`guard:task-committed:${taskId}`)
    },
    async launchSettled(taskId: string) {
      input.trace.push(`guard:launch-settled:${taskId}`)
    },
    async failed(errorCode: string) {
      input.trace.push(`guard:failed:${errorCode}`)
    },
    release() {
      input.trace.push('guard:release')
    },
  })
}

afterEach(() => {
  registerAfterCommitEventPump(null)
  selectDatabaseSchemaProvider('sqlite')
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RFC-349 PostgreSQL task route launch operations', () => {
  test('replay visibility is provider-native and preserves the opaque 404', async () => {
    const testHarness = await harness({
      activeUserIds: [actor.user.id],
      visibleTaskIds: ['source-visible'],
    })

    await expect(
      testHarness.operations.agent.assertReplayVisible(actor, 'source-visible'),
    ).resolves.toBeUndefined()
    await expect(
      testHarness.operations.workgroup.assertReplayVisible(actor, 'source-private'),
    ).rejects.toMatchObject({ code: 'task-not-found' })

    const reads = testHarness.executions.filter((execution) =>
      execution.sql.includes('from "agent_workflow"."tasks"'),
    )
    expect(reads).toHaveLength(2)
    expect(reads.every((execution) => execution.sql.includes('task_collaborators'))).toBe(true)
  })

  test('launches an Agent with upload landing, frozen authority, atomic rows and created event', async () => {
    const testHarness = await harness({ activeUserIds: [actor.user.id] })
    expect(testHarness.operations.agent.uploadLimits()).toMatchObject({
      perFile: expect.any(Number),
      perRequest: expect.any(Number),
      perCount: expect.any(Number),
    })

    const task = await testHarness.operations.agent.launch(actor, {
      agentId: agent.id,
      payload: {
        name: 'Agent task',
        inputs: {},
        allowClarify: true,
        scratch: true,
      },
      uploads: {
        parts: [
          {
            inputKey: 'artifact',
            filename: 'note.txt',
            declaredMime: 'text/plain',
            blob: new Blob(['hello'], { type: 'text/plain' }),
          },
        ],
        limits: { perFile: 1_024, perRequest: 2_048, perCount: 2 },
      },
    })

    expect(task).toMatchObject({
      id: 'task-agent',
      status: 'pending',
      sourceAgentId: agent.id,
      sourceAgentName: agent.name,
      gitUserName: 'Owner',
      gitUserEmail: 'owner@example.test',
      spaceKind: 'scratch',
    })
    expect(task.inputs['artifact']).toBe('.agent-workflow/inputs/agent/artifact/note.txt')
    expect(readFileSync(join(task.worktreePath, task.inputs['artifact'] ?? ''), 'utf8')).toBe(
      'hello',
    )
    expect(existsSync(join(task.worktreePath, '.workspace-prepared'))).toBe(true)
    expect(testHarness.committed).toEqual(['task-agent'])
    expect(testHarness.rolledBack).toEqual([])
    expect(testHarness.closures).toEqual([{ actor, workflowId: '00000000000000AGENTHOST00' }])
    expect(testHarness.integrityCalls).toEqual([[agent.id]])
    expect(testHarness.submissions).toEqual([
      { taskId: 'task-agent', intentId: 'intent-agent', completionMode: 'background' },
    ])

    const statements = testHarness.executions.map((execution) => execution.sql.toLowerCase())
    expect(statements.some((sql) => sql.includes('insert into "agent_workflow"."tasks"'))).toBe(
      true,
    )
    expect(
      statements.some((sql) => sql.includes('insert into "agent_workflow"."task_repos"')),
    ).toBe(true)
    expect(
      statements.some((sql) => sql.includes('insert into "agent_workflow"."task_collaborators"')),
    ).toBe(true)
    expect(
      statements.some((sql) =>
        sql.includes('insert into "agent_workflow"."task_execution_intents"'),
      ),
    ).toBe(true)
    expect(
      statements.some((sql) => sql.includes('insert into "agent_workflow"."committed_events"')),
    ).toBe(true)
  })

  test('launches a Workgroup with human membership and frozen runtime state', async () => {
    const testHarness = await harness({ activeUserIds: [actor.user.id, 'human-1'] })

    const task = await testHarness.operations.workgroup.launch(actor, {
      workgroupId: workgroup.id,
      payload: {
        name: 'Workgroup task',
        goal: 'Ship the release',
        scratch: true,
        expectedWorkgroupId: workgroup.id,
        expectedWorkgroupVersion: workgroup.version,
      },
    })

    expect(task).toMatchObject({
      id: 'task-agent',
      status: 'pending',
      workgroupId: workgroup.id,
      workgroupName: workgroup.name,
      goal: 'Ship the release',
      sourceAgentId: null,
      spaceKind: 'scratch',
    })
    expect(testHarness.committed).toEqual(['task-agent'])
    expect(testHarness.rolledBack).toEqual([])
    expect(testHarness.integrityCalls).toEqual([[agent.id]])
    expect(testHarness.closures).toEqual([{ actor, workflowId: '00000000000000WORKGROUP00' }])
    expect(testHarness.submissions).toEqual([
      { taskId: 'task-agent', intentId: 'intent-agent', completionMode: 'background' },
    ])
    const collaboratorInsert = testHarness.executions.find((execution) =>
      execution.sql.toLowerCase().includes('insert into "agent_workflow"."task_collaborators"'),
    )
    expect(collaboratorInsert?.parameters).toContain('human-1')
    expect(
      testHarness.executions.some((execution) =>
        execution.sql.toLowerCase().includes('insert into "agent_workflow"."workgroup_task_state"'),
      ),
    ).toBe(true)
  })

  test('rejects a launch that swaps the actor outside its admitted authority pair', async () => {
    const testHarness = await harness({ activeUserIds: [actor.user.id] })
    const foreignActor = buildActor({ user: actor.user, source: 'session' })
    await expect(
      testHarness.participant.launch({
        actor: foreignActor,
        target: {
          kind: 'workflow',
          refId: workflow.id,
          payload: { workflowId: workflow.id, name: 'Foreign launch', inputs: {}, scratch: true },
        },
        invoker: { type: 'scheduled', scheduledTaskId: 'schedule-foreign' },
        resources: testHarness.resources,
      }),
    ).rejects.toMatchObject({ code: 'task-launch-authority-mismatch' })
    expect(testHarness.trace).toEqual([])
  })

  test('generic launch persists scheduled and event provenance without a direct-route fallback', async () => {
    const scheduled = await harness({ activeUserIds: [actor.user.id] })
    const scheduledTask = await scheduled.participant.launch({
      actor,
      target: {
        kind: 'workflow',
        refId: workflow.id,
        payload: {
          workflowId: workflow.id,
          name: 'Scheduled workflow',
          inputs: {},
          scratch: true,
        },
      },
      invoker: { type: 'scheduled', scheduledTaskId: 'schedule-1' },
      resources: scheduled.resources,
    })
    expect(scheduledTask.scheduledTaskId).toBe('schedule-1')
    const scheduledInsert = scheduled.executions.find((execution) =>
      execution.sql.toLowerCase().includes('insert into "agent_workflow"."tasks"'),
    )
    expect(scheduledInsert?.parameters).toContain('scheduled')
    expect(scheduledInsert?.parameters).toContain('schedule-1')
    const scheduledIntent = scheduled.executions.find((execution) =>
      execution.sql.toLowerCase().includes('insert into "agent_workflow"."task_execution_intents"'),
    )
    expect(scheduledIntent?.parameters).toContain('scheduler')

    const event = await harness({ activeUserIds: [actor.user.id] })
    const triggerContext = {
      trigger: { webhook: { event_type: 'push', repo_path: 'group/project' } },
    } as const
    await event.participant.launch({
      actor,
      target: {
        kind: 'workflow',
        refId: workflow.id,
        payload: {
          workflowId: workflow.id,
          name: 'Event workflow',
          inputs: {},
          scratch: true,
        },
      },
      invoker: {
        type: 'event',
        eventSubscriptionId: 'subscription-1',
        eventDeliveryId: 'delivery-1',
        triggerContext,
      },
      resources: event.resources,
    })
    const eventInsert = event.executions.find((execution) =>
      execution.sql.toLowerCase().includes('insert into "agent_workflow"."tasks"'),
    )
    expect(eventInsert?.parameters).toContain('event')
    expect(eventInsert?.parameters).toContain('subscription-1')
    expect(eventInsert?.parameters).toContain('delivery-1')
    expect(eventInsert?.parameters).toContain(JSON.stringify(triggerContext))
  })

  test('protected webhook launch owns the complete guard lifecycle and source attribution', async () => {
    const testHarness = await harness({ activeUserIds: [actor.user.id, 'human-1'] })
    const snapshot: SourceTerminationSnapshot = Object.freeze({
      binding: 'endpoint-1:group/project!12',
      launchRevision: 12,
      fence: null,
      effectRevision: null,
    })
    const guard = launchGuard({ trace: testHarness.trace, snapshot })
    const triggerContext = {
      trigger: { webhook: { event_type: 'push', repo_path: 'group/project' } },
    } as const

    await testHarness.participant.launch({
      actor,
      target: {
        kind: 'workgroup',
        refId: workgroup.id,
        payload: {
          name: 'Protected Workgroup task',
          goal: 'Review the merge request',
          scratch: true,
          expectedWorkgroupId: workgroup.id,
          expectedWorkgroupVersion: workgroup.version,
        },
      },
      invoker: {
        type: 'webhook',
        webhookTriggerId: 'trigger-1',
        webhookFireId: 'fire-1',
        triggerContext,
        sourceTerminationSnapshot: snapshot,
      },
      resources: testHarness.resources,
      guard,
    })

    const taskInsert = testHarness.executions.find((execution) =>
      execution.sql.toLowerCase().includes('insert into "agent_workflow"."tasks"'),
    )
    expect(taskInsert?.parameters).toContain('webhook')
    expect(taskInsert?.parameters).toContain('trigger-1')
    expect(taskInsert?.parameters).toContain('fire-1')
    expect(taskInsert?.parameters).toContain(JSON.stringify(triggerContext))
    expect(taskInsert?.parameters).toContain(snapshot.binding)
    expect(taskInsert?.parameters).toContain(snapshot.launchRevision)
    expect(testHarness.sourceTerminationSignals).toEqual([guard.signal])
    expect(testHarness.trace).toEqual([
      'guard:assert',
      'guard:verify',
      'workspace:prepare',
      'guard:verify',
      'guard:assert',
      'task:insert',
      'db:commit',
      'guard:task-committed:task-agent',
      'workspace:commit',
      'coordinator',
      'guard:launch-settled:task-agent',
      'guard:release',
    ])
  })

  test('guard refusal rolls back the prepared workspace and records the failure before release', async () => {
    const testHarness = await harness({ activeUserIds: [actor.user.id] })
    const snapshot: SourceTerminationSnapshot = Object.freeze({
      binding: 'endpoint-1:group/project!13',
      launchRevision: 13,
      fence: null,
      effectRevision: null,
    })
    const guard = launchGuard({ trace: testHarness.trace, snapshot, failVerifyAt: 2 })

    await expect(
      testHarness.participant.launch({
        actor,
        target: {
          kind: 'workflow',
          refId: workflow.id,
          payload: { workflowId: workflow.id, name: 'Rejected launch', inputs: {}, scratch: true },
        },
        invoker: {
          type: 'webhook',
          webhookTriggerId: 'trigger-2',
          webhookFireId: 'fire-2',
          triggerContext: { trigger: { webhook: { event_type: 'push' } } },
          sourceTerminationSnapshot: snapshot,
        },
        resources: testHarness.resources,
        guard,
      }),
    ).rejects.toThrow('guard verification failed')
    expect(testHarness.rolledBack).toEqual(['task-agent'])
    expect(testHarness.executions).not.toContainEqual(
      expect.objectContaining({
        sql: expect.stringContaining('insert into "agent_workflow"."tasks"'),
      }),
    )
    expect(testHarness.trace).toEqual([
      'guard:assert',
      'guard:verify',
      'workspace:prepare',
      'guard:verify',
      'workspace:rollback',
      'guard:failed:launch-failed',
      'guard:release',
    ])
  })
})
