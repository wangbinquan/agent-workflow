// RFC-349 — port-artifact transport owns filesystem rendering only. Task
// visibility and persisted output/repository rows come from the selected
// TaskExecution read model, including the external PostgreSQL implementation.

import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { createPostgresqlTaskExecutionReadModels } from '@/modules/task-execution/infrastructure/postgresqlTaskExecutionReadModels'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

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
    generationId: 'dbg_port_artifact_provider',
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
    reads: createPostgresqlTaskExecutionReadModels(createPostgresqlDatabaseClient(runtime)),
    executions,
  }
}

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 port-artifact provider cutover', () => {
  test('PostgreSQL freezes visibility, run ownership, output and repo prefix in one closed result', async () => {
    const fake = fixture([
      [['task-1', 'owner-1', '/worktrees/task-1', 2]],
      [['run-1']],
      [['{"v":1,"items":[]}', 'docs/result.md', 'path<md>']],
      [['api']],
    ])

    await expect(
      fake.reads.portArtifacts.find({
        actor: { userId: 'owner-1', canReadAllTasks: false },
        taskId: 'task-1',
        nodeRunId: 'run-1',
        portName: 'result',
      }),
    ).resolves.toEqual({
      status: 'found',
      artifact: {
        taskId: 'task-1',
        worktreePath: '/worktrees/task-1',
        archiveJson: '{"v":1,"items":[]}',
        content: 'docs/result.md',
        kind: 'path<md>',
        legacyRepoDirName: 'api',
      },
    })
    expect(fake.executions).toHaveLength(4)
    expect(fake.executions[3]?.sql).toContain('order by "agent_workflow"."task_repos"."repo_index"')
  })

  test('PostgreSQL collapses missing membership into task-not-found before reading the run', async () => {
    const fake = fixture([[['task-2', 'owner-2', '/worktrees/task-2', 1]], []])

    await expect(
      fake.reads.portArtifacts.find({
        actor: { userId: 'stranger', canReadAllTasks: false },
        taskId: 'task-2',
        nodeRunId: 'run-2',
        portName: 'result',
      }),
    ).resolves.toEqual({ status: 'task-not-found' })
    expect(fake.executions).toHaveLength(2)
  })

  test('PostgreSQL reads prefix and tail per sibling and returns one ordered session source', async () => {
    const snapshot = JSON.stringify({ nodes: [{ id: 'agent-1', kind: 'agent-single' }] })
    const fake = fixture([
      [[snapshot]],
      [['run-a', 'task-3', 'agent-1', 'first', null, 10, 'session-3', 0]],
      [
        ['run-a', 'task-3', 'agent-1', 'first', null, 10, 'session-3', 0],
        ['run-b', 'task-3', 'agent-1', 'second', null, 20, 'session-3', 1],
      ],
      [[1, 10, 'text', 'session-3', null, 'a-prefix']],
      [[3, 30, 'text', 'session-3', null, 'a-tail']],
      [[4, 40, 'text', 'session-3', null, 'b-prefix']],
      [[5, 50, 'text', 'session-3', null, 'b-tail']],
    ])

    await expect(
      fake.reads.sessions.find({
        taskId: 'task-3',
        nodeRunId: 'run-a',
        rootPrefixCap: 1,
        tailCap: 1,
      }),
    ).resolves.toEqual({
      status: 'found',
      workflowSnapshot: snapshot,
      run: {
        id: 'run-a',
        taskId: 'task-3',
        nodeId: 'agent-1',
        promptText: 'first',
        promptPath: null,
        startedAt: 10,
        opencodeSessionId: 'session-3',
        retryIndex: 0,
      },
      siblings: [
        {
          id: 'run-a',
          taskId: 'task-3',
          nodeId: 'agent-1',
          promptText: 'first',
          promptPath: null,
          startedAt: 10,
          opencodeSessionId: 'session-3',
          retryIndex: 0,
        },
        {
          id: 'run-b',
          taskId: 'task-3',
          nodeId: 'agent-1',
          promptText: 'second',
          promptPath: null,
          startedAt: 20,
          opencodeSessionId: 'session-3',
          retryIndex: 1,
        },
      ],
      events: [
        {
          id: 1,
          ts: 10,
          kind: 'text',
          sessionId: 'session-3',
          parentSessionId: null,
          payload: 'a-prefix',
        },
        {
          id: 3,
          ts: 30,
          kind: 'text',
          sessionId: 'session-3',
          parentSessionId: null,
          payload: 'a-tail',
        },
        {
          id: 4,
          ts: 40,
          kind: 'text',
          sessionId: 'session-3',
          parentSessionId: null,
          payload: 'b-prefix',
        },
        {
          id: 5,
          ts: 50,
          kind: 'text',
          sessionId: 'session-3',
          parentSessionId: null,
          payload: 'b-tail',
        },
      ],
    })
    expect(fake.executions).toHaveLength(7)
    const eventQueries = fake.executions.slice(3)
    expect(eventQueries).toHaveLength(4)
    for (const query of eventQueries) expect(query.sql).toContain('"node_run_events"')
  })

  test('transport and filesystem presenter do not import database mechanisms', () => {
    for (const relativePath of [
      'routes/port-artifacts.ts',
      'services/portArtifacts.ts',
      'services/sessionView.ts',
    ]) {
      const source = readFileSync(resolve(import.meta.dir, '..', 'src', relativePath), 'utf8')
      expect(source).not.toMatch(/@\/db|bun:sqlite|drizzle-orm/)
    }
    const route = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'routes', 'port-artifacts.ts'),
      'utf8',
    )
    expect(route).toContain('taskExecutionReadModels.portArtifacts.find')
  })
})
