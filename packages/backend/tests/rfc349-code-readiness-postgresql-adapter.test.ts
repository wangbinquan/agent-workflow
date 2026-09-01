// RFC-349 — the standalone readiness use case has a real PostgreSQL adapter,
// not only the batched matrix projection.

import { afterEach, describe, expect, test } from 'bun:test'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { gatherReadinessFacts } from '@/modules/code-capability/application/readinessFacts'
import { createPostgresqlReadinessFactsRead } from '@/modules/code-capability/infrastructure/postgresqlReadinessFactsRead'
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
    generationId: 'dbg_code_readiness_pg',
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
    reader: createPostgresqlReadinessFactsRead(createPostgresqlDatabaseClient(runtime)),
    executions,
  }
}

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 PostgreSQL code readiness adapter', () => {
  test('observes the same binding, trigger, endpoint and agent facts', async () => {
    const fake = fixture([
      [['template-1']],
      [
        [
          'trigger-1',
          JSON.stringify({ kind: 'paths', paths: ['group/project'] }),
          JSON.stringify(['pipeline_succeeded']),
        ],
      ],
      [['endpoint-1', 'gitlab']],
      [[JSON.stringify({ reviewer: 'agent-1' })]],
      [['agent-1']],
    ])

    await expect(
      gatherReadinessFacts({
        reader: fake.reader,
        repoId: 'group/project',
        capability: 'mr-review',
        endpointId: 'endpoint-1',
        templateId: 'template-1',
        enabled: true,
      }),
    ).resolves.toMatchObject({
      enabled: true,
      hasBinding: true,
      frameworkExists: true,
      hasTrigger: true,
      codeHostConfigured: true,
      invisibleAgentSlots: [],
      hasWakeSource: true,
    })

    expect(fake.executions).toHaveLength(5)
    const sql = fake.executions.map((execution) => execution.sql).join('\n')
    for (const table of [
      'capability_templates',
      'webhook_triggers',
      'webhook_endpoints',
      'agents',
    ]) {
      expect(sql).toContain(`"agent_workflow"."${table}"`)
    }
  })
})
