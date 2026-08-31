// RFC-349 — locks PostgreSQL execution-contract resource reads to the same
// Promise port and revision/closure behavior as the SQLite adapter.

import { afterEach, describe, expect, test } from 'bun:test'

import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { composeExecutionContract } from '@/modules/execution-contract/composition'
import { createPostgresqlExecutionContractResourceAdapter } from '@/modules/execution-contract/infrastructure/taskExecutionAdapter'
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
  const connection: PostgresqlReservedConnection = {
    unsafe: run,
    release() {},
  }
  const pool: PostgresqlPool = {
    async reserve() {
      return connection
    },
    unsafe: run,
    async close() {},
  }
  const runtime: PostgresqlDatabaseRuntime = {
    provider: 'postgresql',
    generationId: 'dbg_execution_contract_pg',
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

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 PostgreSQL execution-contract adapter', () => {
  test('composition accepts the provider-neutral resource port without a SQLite client', () => {
    const module = composeExecutionContract({
      appHome: '/not-used-by-this-query',
      registrations: [],
      resources: {
        async inspect() {
          return null
        },
      },
    })

    expect(module.list()).toEqual([])
  })

  test('projects an exact-revision agent through the closed resource port', async () => {
    const fake = fixture([
      [
        [
          'Implementer',
          '["contract-result"]',
          17,
          '{"executionContracts":[{"contractId":"development.analyze-implement","version":1}]}',
        ],
      ],
    ])
    const adapter = createPostgresqlExecutionContractResourceAdapter(fake.db)

    await expect(
      adapter.inspect({
        implementation: {
          kind: 'agent',
          agentRef: { id: 'agent-1', revision: 17 },
        },
        expectedOutputPort: 'contract-result',
      }),
    ).resolves.toMatchObject({
      kind: 'agent',
      name: 'Implementer',
      available: true,
      declaredContractRefs: [{ contractId: 'development.analyze-implement', version: 1 }],
    })
    expect(fake.executions[0]?.sql).toContain('from "agent_workflow"."agents"')
    expect(fake.executions[0]?.parameters).toEqual(['agent-1', 1])
  })

  test('rejects a stale agent revision without widening its declarations', async () => {
    const fake = fixture([
      [['Implementer', '["contract-result"]', 18, '{"executionContracts":[]}']],
    ])
    const adapter = createPostgresqlExecutionContractResourceAdapter(fake.db)

    await expect(
      adapter.inspect({
        implementation: {
          kind: 'agent',
          agentRef: { id: 'agent-1', revision: 17 },
        },
        expectedOutputPort: 'contract-result',
      }),
    ).resolves.toBeNull()
  })

  test('applies the existing workflow closure oracle to PostgreSQL rows', async () => {
    const definition = {
      $schema_version: 2,
      inputs: [{ key: 'prompt', label: 'Prompt', kind: 'text', required: true }],
      nodes: [{ id: 'result', kind: 'output', ports: [{ name: 'contract-result' }] }],
      edges: [],
    }
    const fake = fixture([[['Contract workflow', 4, JSON.stringify(definition)]]])
    const adapter = createPostgresqlExecutionContractResourceAdapter(fake.db)

    await expect(
      adapter.inspect({
        implementation: {
          kind: 'workflow',
          workflowRef: { id: 'workflow-1', revision: 4 },
        },
        expectedOutputPort: 'contract-result',
      }),
    ).resolves.toMatchObject({
      kind: 'workflow',
      name: 'Contract workflow',
      available: true,
      detail: 'Contract workflow; closed contract workflow; 1 node(s)',
    })
    expect(fake.executions[0]?.sql).toContain('from "agent_workflow"."workflows"')
    expect(fake.executions[0]?.parameters).toEqual(['workflow-1', 1])
  })
})
