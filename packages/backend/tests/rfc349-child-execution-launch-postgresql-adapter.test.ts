// RFC-349 — a node-launched child already owns an inherited workspace. This
// locks the PostgreSQL-native mint (task/repo/membership/intent/event in one
// SERIALIZABLE transaction) and the commit-before-drive boundary without
// routing the provider client through the legacy SQLite launcher.

import { afterEach, describe, expect, test } from 'bun:test'
import { WorkflowDefinitionSchema, type StartTask } from '@agent-workflow/shared'

import { buildActor } from '@/auth/actor'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { agentLaunchResourceIntegrityParticipantBrand } from '@/modules/resource-catalog/domain/participantBrands'
import { createProviderTaskExecutionModule } from '@/modules/task-execution/composition'
import { createPostgresqlTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import type { SchedulerDriverPort } from '@/modules/task-execution/application/ports/taskExecutionTopology'
import type { TaskExecutionTopologyLogger } from '@/modules/task-execution/application/ports/taskExecutionTopology'
import {
  createPostgresqlChildExecutionLaunchOperations,
  type PostgresqlChildExecutionLaunchDependencies,
} from '@/modules/task-execution/composition/childExecutionLaunch'
import { registerAfterCommitEventPump } from '@/platform/events/committed/runtime'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'
import type { MaterializedSpace } from '@/services/task'

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

function postgresqlFixture(trace: string[]) {
  const executions: Array<{ readonly sql: string; readonly parameters: readonly unknown[] }> = []
  let insertedEvent: readonly unknown[] | null = null
  const run = (query: string, parameters: readonly unknown[] = []): SqlRows => {
    executions.push({ sql: query, parameters })
    const normalized = query.trim().toLowerCase()
    if (normalized === 'commit') trace.push('db:commit')
    if (normalized.startsWith('insert into "agent_workflow"."tasks"')) {
      trace.push('task:insert')
    }
    if (
      normalized.includes('agent_workflow_meta') &&
      normalized.includes('database_generations') &&
      normalized.includes('first_live_write_at')
    ) {
      return sqlRows({
        objects: [{ generation_id: 'dbg_child_launch_pg' }],
        values: [['dbg_child_launch_pg']],
      })
    }
    if (
      normalized.includes('from "agent_workflow"."tasks"') &&
      normalized.includes('"launch_origin"')
    ) {
      return sqlRows({
        values: [
          [
            'parent-task',
            'running',
            'owner-1',
            'manual',
            'public',
            'root-task',
            'lineage-1',
            JSON.stringify([
              {
                stableNodeKey: 'task-root',
                frozenOccurrenceKey: 'root-task',
                workflowRevision: 1,
              },
            ]),
            0,
            null,
            null,
            null,
            null,
            null,
            'Owner',
            'owner@example.test',
            null,
            null,
          ],
        ],
      })
    }
    if (normalized.includes('from "agent_workflow"."node_runs"')) {
      return sqlRows({
        values: [['parent-task', 'running', 'child-task', 'call:node-1', null, 2]],
      })
    }
    if (normalized.includes('from "agent_workflow"."workflows"')) {
      return sqlRows({ values: [['child-workflow']] })
    }
    if (normalized.includes('from "agent_workflow"."users"')) {
      return sqlRows({ values: [['owner-1']] })
    }
    if (
      normalized.includes('from "agent_workflow"."tasks"') &&
      normalized.includes('"parent_task_id"')
    ) {
      return sqlRows({ values: [['parent-task', null]] })
    }
    if (
      normalized.includes('from "agent_workflow"."tasks"') &&
      normalized.includes('"source_termination_fence"')
    ) {
      trace.push('drive:admission-read')
      // A concurrent terminal winner makes coordinator attach a valid
      // not-attached receipt. The mint/commit path remains fully exercised.
      return sqlRows({ values: [['done', null]] })
    }
    if (normalized.includes('from "agent_workflow"."committed_event_family_cutovers"')) {
      return sqlRows({
        values: [['task-execution', 'task-lifecycle', 'dispatchable', 1, 0, 'test-cutover']],
      })
    }
    if (normalized.includes('from "agent_workflow"."committed_event_aggregate_heads"')) {
      return sqlRows()
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
    return sqlRows({
      count: normalized.startsWith('insert ') || normalized.startsWith('update ') ? 1 : 0,
    })
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
    generationId: 'dbg_child_launch_pg',
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

const inheritedSpace: MaterializedSpace = {
  kind: 'single',
  spaceKind: 'inherited',
  taskId: 'child-task',
  worktreePath: '/workspace/child-task',
  branch: 'agent-workflow/parent-task',
  baseCommit: 'base-commit',
  earlyError: null,
  resolvedSources: [],
  nodePaths: ['src'],
  cleanup: {
    taskId: 'child-task',
    ownedRoot: null,
    worktrees: [],
    state: 'owned',
    report: null,
  },
  repos: [
    {
      repoIndex: 0,
      repoPath: '/repo',
      repoUrl: null,
      cachedRepoId: null,
      baseBranch: 'main',
      branch: 'agent-workflow/parent-task',
      baseCommit: 'base-commit',
      worktreePath: '/workspace/child-task',
      worktreeDirName: '',
      mountPath: '',
      subdir: '',
      readonly: false,
      workspaceProfileVersion: 1,
      workspaceProfileDigest: 'profile-v1',
      submoduleInitOk: true,
      submoduleInitError: null,
      hasSubmodules: false,
    },
  ],
}

const childTask: StartTask = {
  workflowId: 'child-workflow',
  name: 'Child task',
  inputs: { input: 'value' },
  autoCommitPush: false,
}

function logger(): TaskExecutionTopologyLogger {
  const log: TaskExecutionTopologyLogger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return log
    },
  }
  return log
}

afterEach(() => {
  registerAfterCommitEventPump(null)
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 PostgreSQL child execution launch', () => {
  test('mints a source-less inherited child atomically before coordinator admission', async () => {
    const trace: string[] = []
    const fixture = postgresqlFixture(trace)
    const persistence = createPostgresqlTaskExecutionPersistence(fixture.db)
    const executionModule = createProviderTaskExecutionModule({
      daemonGeneration: 'daemon-child-test',
      persistence,
    })
    const schedulerCalls: string[] = []
    const schedulerDriver: SchedulerDriverPort = {
      async drive(input) {
        schedulerCalls.push(input.taskId)
      },
      async cancelChild() {},
      async resumeChild() {},
      isTaskActive() {
        return false
      },
    }
    const dependencies: PostgresqlChildExecutionLaunchDependencies = {
      db: fixture.db,
      persistence,
      executionModule,
      async finalizeWorkspace() {
        trace.push('workspace:finalize')
      },
      log: logger(),
      workgroup: {
        async loadExistingAgentIds() {
          throw new Error('workgroup resources are not used by workflow launch')
        },
        async ensureHostWorkflow() {
          throw new Error('workgroup resources are not used by workflow launch')
        },
        integrity: {
          [agentLaunchResourceIntegrityParticipantBrand]:
            'agent-launch-resource-integrity-participant',
          async assertUsable() {
            throw new Error('workgroup resources are not used by workflow launch')
          },
        },
      },
      id: () => 'intent-child',
      now: () => 1_700_000_000_000,
    }
    const definition = WorkflowDefinitionSchema.parse({
      $schema_version: 2,
      inputs: [],
      nodes: [],
      edges: [],
    })

    await createPostgresqlChildExecutionLaunchOperations(dependencies).launchWorkflow({
      actor,
      parentTaskId: 'parent-task',
      parentNodeRunId: 'parent-run',
      invocationDepth: 1,
      materializedSpace: inheritedSpace,
      runtime: { runConfig: { appHome: '/app-home' }, actorUserId: actor.user.id },
      schedulerDriver,
      workflowId: 'child-workflow',
      frozenWorkflowVersion: 7,
      payload: childTask,
      frozenSnapshotJson: JSON.stringify(definition),
      refClosureJson: null,
    })

    expect(inheritedSpace.cleanup.state).toBe('committed')
    expect(schedulerCalls).toEqual([])
    expect(trace).toEqual(['task:insert', 'db:commit', 'drive:admission-read'])
    const statements = fixture.executions.map((execution) => execution.sql.toLowerCase())
    for (const table of [
      'tasks',
      'task_repos',
      'task_space_nodes',
      'task_collaborators',
      'task_execution_intents',
      'committed_events',
    ]) {
      expect(
        statements.some((sql) => sql.includes(`insert into "agent_workflow"."${table}"`)),
      ).toBe(true)
    }
    const taskInsert = fixture.executions.find((execution) =>
      execution.sql.toLowerCase().includes('insert into "agent_workflow"."tasks"'),
    )
    expect(taskInsert?.parameters).toContain('child-task')
    expect(taskInsert?.parameters).toContain('parent-task')
    expect(taskInsert?.parameters).toContain(7)
  })
})
