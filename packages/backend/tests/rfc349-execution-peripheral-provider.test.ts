// RFC-349 — execution-peripheral services consume closed provider operations;
// only infrastructure adapters may own database mechanics.

import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { buildActor } from '@/auth/actor'
import { createInMemoryDb } from '@/db/client'
import { workflows } from '@/db/schema'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import {
  composePostgresqlAgentLaunchResourceOperations,
  composeSqliteAgentLaunchResourceOperations,
} from '@/modules/task-execution/composition/agentLaunchResources'
import { composeSqliteDynamicWorkflowPersistence } from '@/modules/task-execution/composition/dynamicWorkflowPersistence'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function sqlRows(
  values: readonly (readonly unknown[])[] = [],
  rows: readonly Record<string, unknown>[] = [],
): SqlRows {
  return Object.assign(Promise.resolve(rows), {
    async values() {
      return values
    },
  })
}

function postgresqlFixture() {
  const executions: string[] = []
  const execute = (sql: string) => {
    executions.push(sql)
    if (sql.includes('"agent_workflow_meta"."database_generations"')) {
      return sqlRows(
        [['dbg_execution_peripheral_pg']],
        [{ generation_id: 'dbg_execution_peripheral_pg' }],
      )
    }
    return sqlRows()
  }
  const connection: PostgresqlReservedConnection = { unsafe: execute, release() {} }
  const pool: PostgresqlPool = {
    unsafe: execute,
    async reserve() {
      return connection
    },
    async close() {},
  }
  const runtime: PostgresqlDatabaseRuntime = {
    provider: 'postgresql',
    generationId: 'dbg_execution_peripheral_pg',
    providerPool: () => pool,
    async health() {
      throw new Error('not used')
    },
    async readiness() {
      throw new Error('not used')
    },
    async acquireMigrationAdvisoryLock() {
      throw new Error('not used')
    },
    async close() {},
  }
  return { db: createPostgresqlDatabaseClient(runtime), executions }
}

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 execution-peripheral provider boundary', () => {
  test('keeps database mechanisms out of peripheral orchestration services', () => {
    const services = [
      'agentLaunch.ts',
      'codeReviewAgentCaller.ts',
      'commitPushRunner.ts',
      'dynamicWorkflowRunner.ts',
    ]

    // RFC-353 T5：`fusion.ts` 已迁出 `services/`，成为
    // `modules/knowledge-evolution/application/fusionOrchestration.ts`。它不再是
    // 「外围编排服务」，但这条不变式（编排里不许有数据库机制）对它同样成立且更强
    // ——application 层本来就不该碰 DbClient / drizzle。所以**保留断言、只换落点**，
    // 而不是把它从清单里删掉：删掉等于在搬家的同时悄悄少了一条守卫。
    const modules = ['../src/modules/knowledge-evolution/application/fusionOrchestration.ts']

    for (const service of [...services.map((s) => `../src/services/${s}`), ...modules]) {
      const source = readFileSync(resolve(import.meta.dir, service), 'utf8')
      expect(source, service).not.toMatch(/from ['"](?:@\/db\/|drizzle-orm)/)
      expect(source, service).not.toMatch(/\b(?:DbClient|PostgresqlDatabaseClient)\b/)
      expect(source, service).not.toMatch(/\bdb\.(?:select|insert|update|delete|transaction)\b/)
    }

    const legacy = readFileSync(
      resolve(
        import.meta.dir,
        '../src/services/execution/legacyTaskExecutionResourceDependencies.ts',
      ),
      'utf8',
    )
    expect(legacy).toContain('infrastructure/mcpPersistence')
    expect(legacy).toContain('infrastructure/pluginPersistence')
    expect(legacy).not.toMatch(/@\/services\/(?:mcp|plugin)['"]/)
  })

  test('SQLite agent-launch and dynamic-workflow adapters perform real durable reads and writes', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const agentLaunch = composeSqliteAgentLaunchResourceOperations(db)
    const dynamicWorkflow = composeSqliteDynamicWorkflowPersistence(db)

    await agentLaunch.ensureHostWorkflow()
    await agentLaunch.ensureHostWorkflow()

    expect(
      db
        .select({ id: workflows.id, name: workflows.name, builtin: workflows.builtin })
        .from(workflows)
        .where(eq(workflows.id, '00000000000000AGENTHOST00'))
        .get(),
    ).toEqual({
      id: '00000000000000AGENTHOST00',
      name: '__agent_host__',
      builtin: true,
    })
    await expect(dynamicWorkflow.loadTask('missing-task')).resolves.toBeNull()
    expect(await dynamicWorkflow.countNodeRuns('missing-task', 'missing-node')).toBe(0)

    db.$client.close()
  })

  test('PostgreSQL agent launch persists its host and requires closed catalog operations', async () => {
    const fixture = postgresqlFixture()
    const visibleRequests: Array<{ readonly actorId: string; readonly agentId: string }> = []
    const actor = buildActor({
      user: {
        id: 'owner-1',
        username: 'owner',
        displayName: 'Owner',
        role: 'admin',
        status: 'active',
      },
      source: 'session',
    })
    const operations = composePostgresqlAgentLaunchResourceOperations({
      db: fixture.db,
      agents: {
        async get(authority, agentId) {
          visibleRequests.push({ actorId: authority.user.id, agentId })
          return null
        },
      },
      workflowValidation: {
        async validate() {
          return { ok: true, issues: [] }
        },
      },
    })

    await operations.ensureHostWorkflow()
    await expect(operations.loadVisibleAgent(actor, 'agent-1')).resolves.toBeNull()
    await expect(
      operations.validateHostWorkflow({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
    ).resolves.toEqual({ ok: true, issues: [] })

    expect(visibleRequests).toEqual([{ actorId: 'owner-1', agentId: 'agent-1' }])
    expect(fixture.executions.some((sql) => sql.includes('"agent_workflow"."workflows"'))).toBe(
      true,
    )
  })
})
