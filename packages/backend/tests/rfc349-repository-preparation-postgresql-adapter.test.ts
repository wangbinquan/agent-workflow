import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import type { TaskDriveSubmission } from '@/modules/task-execution/application/drive/taskDriveTypes'
import type { TaskExecutionTopologyLogger } from '@/modules/task-execution/application/ports/taskExecutionTopology'
import {
  createPostgresqlRepositoryPreparationRetryCommand,
  createPostgresqlTaskWorkspaceMaterializer,
} from '@/modules/task-execution/composition/taskExecutionRuntime'
import type { PostgresqlTaskRoutePreparedWorkspace } from '@/modules/task-execution/composition/taskRouteLaunch'
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

function postgresqlFixture(trace: string[]) {
  const executions: Array<{ readonly sql: string; readonly parameters: readonly unknown[] }> = []
  let insertedEvent: readonly unknown[] | null = null
  const run = (query: string, parameters: readonly unknown[] = []): SqlRows => {
    executions.push({ sql: query, parameters })
    const normalized = query.trim().toLowerCase()
    if (normalized === 'commit') trace.push('db:commit')
    // RFC-349: matches both the one-shot live-write marker and the
    // per-transaction generation fence.
    if (normalized.includes('agent_workflow_meta') && normalized.includes('database_generations')) {
      return sqlRows({
        objects: [{ generation_id: 'dbg_repo_prep_retry_pg' }],
        values: [['dbg_repo_prep_retry_pg']],
      })
    }
    if (
      normalized.includes('from "agent_workflow"."tasks"') &&
      normalized.includes('"workspace_pruning_at"')
    ) {
      return sqlRows({
        values: [
          [
            'task-1',
            'Retry repository',
            'workflow-1',
            'failed',
            JSON.stringify({ prompt: 'repair it' }),
            null,
            null,
            10,
            'old failure',
            'old detail',
            '__repo_prep__',
            'Owner',
            'owner@example.test',
            null,
            false,
            'cached-1',
            null,
            '',
            'main',
            1,
            null,
            null,
            null,
          ],
        ],
      })
    }
    if (
      normalized.includes('from "agent_workflow"."node_runs"') &&
      normalized.includes('"retry_index"')
    ) {
      return sqlRows({ values: [['prep-0', 0, 'failed']] })
    }
    if (normalized.includes('from "agent_workflow"."cached_repos"')) return sqlRows()
    if (normalized.includes('from "agent_workflow"."task_execution_owners"')) return sqlRows()
    if (normalized.startsWith('update "agent_workflow"."tasks"')) {
      trace.push('task:cas')
      return sqlRows({ values: [[2]], count: 1 })
    }
    if (normalized.includes('from "agent_workflow"."node_runs"')) return sqlRows()
    if (normalized.startsWith('insert into "agent_workflow"."node_runs"')) {
      trace.push('prep:insert')
      return sqlRows({ count: 1 })
    }
    if (normalized.startsWith('insert into "agent_workflow"."task_repos"')) {
      trace.push('repos:insert')
      return sqlRows({ count: 1 })
    }
    if (
      normalized.includes('from "agent_workflow"."tasks"') &&
      normalized.includes('"execution_lineage_id"')
    ) {
      return sqlRows({
        values: [
          [
            2,
            'task-1',
            JSON.stringify([
              {
                stableNodeKey: 'task-root',
                frozenOccurrenceKey: 'task-1',
                workflowRevision: null,
              },
            ]),
          ],
        ],
      })
    }
    if (normalized.includes('from "agent_workflow"."task_execution_intents"')) return sqlRows()
    if (normalized.includes('from "agent_workflow"."task_execution_lineage_operation_records"')) {
      return sqlRows()
    }
    if (normalized.includes('from "agent_workflow"."task_execution_maintenance_members"')) {
      return sqlRows()
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
          eventId !== undefined && insertedEvent !== null && parameters.includes(eventId)
            ? [insertedEvent]
            : [],
      })
    }
    return sqlRows({
      count:
        normalized.startsWith('insert ') ||
        normalized.startsWith('update ') ||
        normalized.startsWith('delete ')
          ? 1
          : 0,
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
    generationId: 'dbg_repo_prep_retry_pg',
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

describe('RFC-349 PostgreSQL repository preparation', () => {
  test('production workspace materializer returns a real rollback lease', async () => {
    selectDatabaseSchemaProvider('postgresql')
    const fixture = postgresqlFixture([])
    const appHome = await mkdtemp(join(tmpdir(), 'rfc349-workspace-pg-'))
    try {
      const materializer = createPostgresqlTaskWorkspaceMaterializer({
        db: fixture.db,
        appHome,
      })
      const prepared = await materializer.prepare({
        taskId: 'task-scratch',
        task: {
          workflowId: 'workflow-1',
          name: 'Scratch workspace',
          inputs: {},
          scratch: true,
        },
        gitCommitIdentity: { name: 'Owner', email: 'owner@example.test' },
      })

      expect(prepared.kind).toBe('scratch')
      expect(prepared.earlyError).toBeNull()
      expect(prepared.repositories).toHaveLength(1)
      expect(existsSync(prepared.worktreePath)).toBe(true)
      const report = await prepared.rollback()
      expect(report.complete).toBe(true)
      expect(existsSync(prepared.worktreePath)).toBe(false)
    } finally {
      await rm(appHome, { recursive: true, force: true })
    }
  })

  test('commits the real workspace projection and continuation before drive', async () => {
    selectDatabaseSchemaProvider('postgresql')
    const trace: string[] = []
    const fixture = postgresqlFixture(trace)
    const appHome = await mkdtemp(join(tmpdir(), 'rfc349-repo-prep-pg-'))
    const submissions: TaskDriveSubmission[] = []
    let rolledBack = false
    registerAfterCommitEventPump({
      async publishNow() {
        trace.push('event:publish')
      },
      nudge() {},
    })
    const prepared: PostgresqlTaskRoutePreparedWorkspace = Object.freeze({
      taskId: 'task-1',
      kind: 'single',
      spaceKind: 'remote',
      repoPath: '/cache/repo.git',
      repoUrl: 'https://example.test/repo.git',
      cachedRepoId: 'cached-1',
      repoGroupId: null,
      repoGroupName: null,
      worktreePath: '/worktrees/repo/task-1',
      baseBranch: 'main',
      branch: 'agent-workflow/task-1',
      baseCommit: 'base-commit',
      earlyError: null,
      repositories: [
        {
          repoIndex: 0,
          repoPath: '/cache/repo.git',
          repoUrl: 'https://example.test/repo.git',
          cachedRepoId: 'cached-1',
          baseBranch: 'main',
          branch: 'agent-workflow/task-1',
          workingBranch: null,
          baseCommit: 'base-commit',
          worktreePath: '/worktrees/repo/task-1',
          worktreeDirName: '',
          mountPath: '',
          subdir: '',
          readonly: false,
          workspaceProfileVersion: 1,
          workspaceProfileDigest: 'profile-v1',
          hasSubmodules: false,
          submoduleInitOk: true,
          submoduleInitError: null,
        },
      ],
      nodePaths: [],
      commit() {
        trace.push('workspace:commit')
      },
      async rollback() {
        rolledBack = true
        return { taskId: 'task-1', complete: true, failures: [] }
      },
    })
    const ids = ['operation-1', 'intent-1', 'prep-1']
    const command = createPostgresqlRepositoryPreparationRetryCommand({
      db: fixture.db,
      appHome,
      workspace: {
        async prepare(input) {
          trace.push('workspace:prepare')
          expect(input.task).toMatchObject({
            workflowId: 'workflow-1',
            cachedRepoId: 'cached-1',
            ref: 'main',
          })
          expect(input.gitCommitIdentity).toEqual({
            name: 'Owner',
            email: 'owner@example.test',
          })
          return prepared
        },
      },
      coordinator: {
        async submit(input) {
          trace.push('coordinator')
          submissions.push(input)
          return { kind: 'accepted', taskId: input.taskId }
        },
      },
      isTaskActive: () => false,
      log: logger(),
      id() {
        const id = ids.shift()
        if (id === undefined) throw new Error('fixture id sequence exhausted')
        return id
      },
      now: () => 1_700_000_000_000,
    })

    try {
      await command.retry('task-1')
    } finally {
      await rm(appHome, { recursive: true, force: true })
    }

    expect(rolledBack).toBe(false)
    expect(submissions).toEqual([
      { taskId: 'task-1', intentId: 'intent-1', completionMode: 'background' },
    ])
    expect(trace.indexOf('db:commit')).toBeLessThan(trace.indexOf('workspace:commit'))
    expect(trace.indexOf('workspace:commit')).toBeLessThan(trace.indexOf('event:publish'))
    expect(trace.indexOf('event:publish')).toBeLessThan(trace.indexOf('coordinator'))
    expect(trace).toContain('repos:insert')
    expect(trace).toContain('prep:insert')
  })

  test('composition exposes production workspace and retry factories without SQLite escape hatches', () => {
    const backend = resolve(import.meta.dir, '..', 'src')
    const workspace = readFileSync(
      resolve(
        backend,
        'modules/task-execution/infrastructure/postgresqlTaskRouteWorkspaceParticipant.ts',
      ),
      'utf8',
    )
    const retry = readFileSync(
      resolve(
        backend,
        'modules/task-execution/infrastructure/postgresqlRepositoryPreparationRetryCommand.ts',
      ),
      'utf8',
    )
    const provider = readFileSync(
      resolve(backend, 'modules/task-execution/composition/providerRuntime.ts'),
      'utf8',
    )
    expect(workspace).toContain('createPostgresqlTaskWorkspaceMaterializer')
    expect(workspace).toContain('materializeSpaceWithProvider')
    expect(retry).toContain('createPostgresqlRepositoryPreparationRetryCommand')
    expect(retry).toContain('submitPostgresqlTaskContinuationTx')
    expect(retry).toContain('await publishCommittedEventsAfterCommit')
    expect(provider).toContain(
      'createPostgresqlTaskRouteWorkspaceParticipant(workspaceDependencies)',
    )
    expect(provider).toContain('createPostgresqlRepositoryPreparationRetryCommand({')
    expect(`${workspace}\n${retry}`).not.toContain("from '@/db/client'")
    expect(`${workspace}\n${retry}`).not.toContain('createSqlite')
    expect(`${workspace}\n${retry}`).not.toContain('as DbClient')
  })
})
