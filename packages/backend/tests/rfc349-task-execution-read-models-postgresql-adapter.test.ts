// RFC-349 — task-execution readers keep one provider-neutral Promise contract:
// PostgreSQL projects the same task/status/workspace/review identities, while
// daemon bootstrap explicitly injects the selected provider implementation.

import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import {
  composePostgresqlTaskExecutionReadModels,
  composeTaskExecutionRuntime,
} from '@/modules/task-execution/composition/taskExecutionRuntime'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function rows(values: readonly (readonly unknown[])[]): SqlRows {
  return Object.assign(Promise.resolve([] as readonly Record<string, unknown>[]), {
    async values() {
      return values
    },
  })
}

function fixture(responses: Array<readonly (readonly unknown[])[]>) {
  const executions: Array<{ readonly sql: string; readonly parameters?: readonly unknown[] }> = []
  const run = (query: string, parameters?: readonly unknown[]) => {
    executions.push({ sql: query, parameters })
    return rows(responses.shift() ?? [])
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
    generationId: 'dbg_task_execution_reads_pg',
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
  return {
    readModels: composePostgresqlTaskExecutionReadModels(createPostgresqlDatabaseClient(runtime)),
    executions,
  }
}

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 PostgreSQL task-execution read-model adapter', () => {
  test('projects status, multi-repository workspace, review nodes, and gate subject', async () => {
    const fake = fixture([
      [['task-1', 'running', null]],
      [['task-1', '/worktrees/task-1']],
      [
        ['api', '/worktrees/task-1/api'],
        ['web', '/worktrees/task-1/web'],
      ],
      [
        [
          'task-1',
          'owner-1',
          JSON.stringify({
            nodes: [
              { id: 'review-1', kind: 'review', title: 'Review', description: 'Inspect it' },
              { id: 'agent-1', kind: 'agent', title: 'Worker' },
            ],
          }),
        ],
      ],
      [['run-1', 'task-1', 'review-1', 'owner-1']],
    ])

    await expect(fake.readModels.statusProjection.find('task-1')).resolves.toEqual({
      taskId: 'task-1',
      status: 'running',
      errorSummary: null,
    })
    await expect(fake.readModels.callGraphWorkspace.find('task-1')).resolves.toEqual({
      taskId: 'task-1',
      worktreePath: '/worktrees/task-1',
      repos: [
        { worktreeDirName: 'api', worktreePath: '/worktrees/task-1/api' },
        { worktreeDirName: 'web', worktreePath: '/worktrees/task-1/web' },
      ],
    })
    await expect(fake.readModels.taskReviewNodes.find('task-1')).resolves.toEqual({
      taskId: 'task-1',
      taskOwnerUserId: 'owner-1',
      nodes: [{ reviewNodeId: 'review-1', title: 'Review', description: 'Inspect it' }],
    })
    await expect(fake.readModels.reviewGateSubjects.find('run-1')).resolves.toEqual({
      nodeRunId: 'run-1',
      taskId: 'task-1',
      reviewNodeId: 'review-1',
      taskOwnerUserId: 'owner-1',
    })

    expect(fake.executions).toHaveLength(5)
    expect(fake.executions.map((execution) => execution.parameters)).toEqual([
      ['task-1', 1],
      ['task-1', 1],
      ['task-1'],
      ['task-1', 1],
      ['run-1', 1],
    ])
    expect(fake.executions[2]?.sql).toContain('order by "agent_workflow"."task_repos"."repo_index"')
    expect(fake.executions[4]?.sql).toContain('inner join "agent_workflow"."tasks"')
  })

  test('keeps the legacy single-root fallback and corrupt snapshot behavior', async () => {
    const fake = fixture([[['task-2', '/worktrees/task-2']], [], [['task-2', null, '{not-json']]])

    await expect(fake.readModels.callGraphWorkspace.find('task-2')).resolves.toEqual({
      taskId: 'task-2',
      worktreePath: '/worktrees/task-2',
      repos: [{ worktreeDirName: '', worktreePath: '/worktrees/task-2' }],
    })
    await expect(fake.readModels.taskReviewNodes.find('task-2')).resolves.toEqual({
      taskId: 'task-2',
      taskOwnerUserId: null,
      nodes: [],
    })
  })

  test('runtime preserves an injected provider-neutral read-model identity', () => {
    const sqlite = createInMemoryDb(MIGRATIONS)
    const readModels = fixture([]).readModels
    const runtime = composeTaskExecutionRuntime({ db: sqlite, readModels })

    expect(runtime.readModels).toBe(readModels)
  })

  test('daemon bootstrap explicitly selects SQLite instead of relying on runtime fallback', () => {
    const start = readFileSync(resolve(import.meta.dir, '../src/cli/start.ts'), 'utf8')
    expect(start).toContain(
      'const taskExecutionReadModels = composeSqliteTaskExecutionReadModels(db)',
    )
    expect(start).toContain('readModels: taskExecutionReadModels,')
  })
})
