// RFC-349 — capability-template upstream merge must execute as one real
// PostgreSQL transaction: load local + upstream, decide purely, fence/write,
// commit. No SQLite shadow or synchronous cast may participate.

import { afterEach, describe, expect, test } from 'bun:test'
import { buildActor } from '@/auth/actor'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { createTemplateUpstreamOperations } from '@/modules/code-capability/application/templateUpstreamStatus'
import type { TemplateUpstreamRecord } from '@/modules/code-capability/application/ports/templateUpstreamPersistence'
import { createPostgresqlTemplateUpstreamPersistence } from '@/modules/code-capability/infrastructure/postgresqlTemplateUpstreamPersistence'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

interface Execution {
  readonly sql: string
  readonly parameters?: readonly unknown[]
}

function result(input: {
  readonly objects?: readonly Record<string, unknown>[]
  readonly values?: readonly (readonly unknown[])[]
  readonly count?: number
}): SqlRows {
  const records = [...(input.objects ?? [])] as Array<Record<string, unknown>> & { count?: number }
  records.count = input.count ?? records.length
  return Object.assign(Promise.resolve(records), {
    async values() {
      return input.values ?? []
    },
  })
}

function fixture() {
  const executions: Execution[] = []
  const queued: Array<Parameters<typeof result>[0]> = []
  const run = (sql: string, parameters?: readonly unknown[]) => {
    executions.push({ sql, parameters })
    return result(queued.shift() ?? {})
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
    generationId: 'dbg_code_template_upstream_pg',
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
    operations: createTemplateUpstreamOperations(
      createPostgresqlTemplateUpstreamPersistence(createPostgresqlDatabaseClient(runtime)),
    ),
    executions,
    queued,
  }
}

const base = {
  description: 'base',
  scripts: { entry: 'old' },
  hooks: [],
  paramSchema: [],
  paramDefaults: {},
  agentBySlot: {},
  promptBySlot: {},
  params: {},
  stageContractVer: 1,
}

const local: TemplateUpstreamRecord = {
  id: 'copy-1',
  name: 'copy',
  description: 'base',
  capability: 'mr-review',
  scriptsJson: JSON.stringify(base.scripts),
  hooksJson: '[]',
  paramSchemaJson: '[]',
  paramDefaultsJson: '{}',
  agentBySlotJson: '{}',
  promptBySlotJson: '{}',
  paramsJson: '{}',
  stageContractVer: 1,
  upstreamId: 'upstream-1',
  upstreamVersion: 100,
  baseDigest: 'base-digest',
  baseSnapshotJson: JSON.stringify(base),
  updatedAt: 110,
}

const upstream: TemplateUpstreamRecord = {
  ...local,
  id: 'upstream-1',
  name: 'upstream',
  scriptsJson: JSON.stringify({ entry: 'new' }),
  upstreamId: null,
  upstreamVersion: null,
  baseDigest: null,
  baseSnapshotJson: null,
  updatedAt: 200,
}

function values(row: TemplateUpstreamRecord): readonly unknown[] {
  return [
    row.id,
    row.name,
    row.description,
    row.capability,
    row.scriptsJson,
    row.hooksJson,
    row.paramSchemaJson,
    row.paramDefaultsJson,
    row.agentBySlotJson,
    row.promptBySlotJson,
    row.paramsJson,
    row.stageContractVer,
    row.upstreamId,
    row.upstreamVersion,
    row.baseDigest,
    row.baseSnapshotJson,
    row.updatedAt,
  ]
}

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 PostgreSQL capability-template upstream adapter', () => {
  test('reads both the local copy and its upstream from PostgreSQL', async () => {
    const fake = fixture()
    fake.queued.push({ values: [values(local)] }, { values: [values(upstream)] })

    await expect(fake.operations.read(local.id)).resolves.toMatchObject({
      status: { state: 'update-available' },
      upstreamName: 'upstream',
      baseRecorded: true,
    })

    expect(fake.executions).toHaveLength(2)
    for (const execution of fake.executions) {
      expect(execution.sql).toContain('from "agent_workflow"."capability_templates"')
    }
  })

  test('loads, decides, generation-fences and persists on one PostgreSQL transaction', async () => {
    const fake = fixture()
    fake.queued.push(
      { count: 0 },
      { count: 0 },
      { values: [values(local)] },
      { count: 0 },
      { values: [values(upstream)] },
      { objects: [{ generation_id: 'dbg_code_template_upstream_pg' }] },
      { count: 1 },
      { count: 0 },
    )
    const actor = buildActor({
      user: {
        id: 'upstream-author',
        username: 'upstream-author',
        displayName: 'Upstream Author',
        role: 'admin',
        status: 'active',
      },
      source: 'daemon',
    })

    await expect(fake.operations.merge(local.id, actor, 300)).resolves.toEqual({
      ok: true,
      applied: ['scripts'],
      keptLocal: [],
      stillConflicted: [],
    })

    const normalized = fake.executions.map((execution) => execution.sql.trim().toLowerCase())
    expect(normalized[0]).toBe('begin')
    expect(normalized[1]).toContain('for update')
    expect(normalized[2]).toContain('from "agent_workflow"."capability_templates"')
    expect(normalized[3]).toContain('for update')
    expect(normalized[4]).toContain('from "agent_workflow"."capability_templates"')
    expect(normalized[5]).toContain('database_generations')
    expect(normalized[6]).toContain('update "agent_workflow"."capability_templates"')
    expect(normalized[7]).toBe('commit')
    expect(fake.executions[6]?.parameters).toContain(JSON.stringify({ entry: 'new' }))
    expect(fake.executions[6]?.parameters).toContain(200)
    expect(fake.executions[6]?.parameters).toContain(300)
  })
})
