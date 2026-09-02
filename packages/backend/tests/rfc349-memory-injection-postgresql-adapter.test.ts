import { afterEach, describe, expect, test } from 'bun:test'
import type { Agent } from '@agent-workflow/shared'

import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { PostgresqlMemoryInjectionReadStore } from '@/modules/memory/infrastructure/postgresqlMemoryInjectionReadStore'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'
import { injectMemoryForRun, loadInjectedSnapshotFromFirstAttempt } from '@/modules/memory/application/injection/injectMemory'

function rows(values: readonly (readonly unknown[])[]): SqlRows {
  return Object.assign(Promise.resolve([] as readonly Record<string, unknown>[]), {
    async values() {
      return values
    },
  })
}

function fixture(responses: Array<readonly (readonly unknown[])[]>) {
  const executions: Array<{ readonly sql: string; readonly parameters?: readonly unknown[] }> = []
  const run = (sql: string, parameters?: readonly unknown[]) => {
    executions.push({ sql, parameters })
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
    generationId: 'dbg_memory_injection_pg',
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
    store: new PostgresqlMemoryInjectionReadStore(createPostgresqlDatabaseClient(runtime)),
    executions,
  }
}

function memoryRow(
  id: string,
  scopeType: 'agent' | 'workflow' | 'repo' | 'repo_group' | 'global',
  scopeId: string | null,
  title: string,
) {
  return [id, scopeType, scopeId, title, `${title} body`, 10, 2, '["provider"]', 'manual', 9]
}

const primaryAgent = { id: 'agent-1' } as Agent

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 PostgreSQL runtime memory injection', () => {
  test('resolves every active scope and renders the same closed snapshot contract', async () => {
    const fake = fixture([
      [['workflow-1', 'repo-legacy', 'group-1']],
      [['repo-1']],
      [['repo-1']],
      [memoryRow('m-agent', 'agent', 'agent-1', 'Agent rule')],
      [memoryRow('m-workflow', 'workflow', 'workflow-1', 'Workflow rule')],
      [memoryRow('m-repo', 'repo', 'repo-1', 'Repository rule')],
      [memoryRow('m-group', 'repo_group', 'group-1', 'Group rule')],
      [memoryRow('m-global', 'global', null, 'Global rule')],
    ])

    const result = await injectMemoryForRun({
      store: fake.store,
      taskId: 'task-1',
      primaryAgent,
      dependents: [],
      envelopeNonce: 'N349',
    })

    expect(result.snapshot?.map((item) => item.id)).toEqual([
      'm-agent',
      'm-workflow',
      'm-repo',
      'm-group',
      'm-global',
    ])
    expect(result.block).toContain('<aw-input name="memory:m-global" id="N349">')
    expect(fake.executions.map((entry) => entry.sql).join('\n')).toContain(
      '"agent_workflow"."memories"',
    )
  })

  test('anchors retry snapshots through PostgreSQL without leaking query mechanics', async () => {
    const snapshot = JSON.stringify([
      {
        id: 'm1',
        version: 1,
        scopeType: 'global',
        scopeId: null,
        title: 'Rule',
        bodyMd: 'Body',
        tags: [],
        sourceKind: 'manual',
        approvedAt: 1,
      },
    ])
    const fake = fixture([
      [
        ['run-1', 'failed', snapshot],
        ['run-2', 'running', null],
      ],
    ])

    await expect(
      loadInjectedSnapshotFromFirstAttempt(fake.store, {
        taskId: 'task-1',
        nodeId: 'node-1',
        iteration: 0,
        shardKey: null,
        reviewIteration: 0,
        runId: 'run-2',
      }),
    ).resolves.toMatchObject([{ id: 'm1', title: 'Rule' }])
  })
})
