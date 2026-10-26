import { createEpoch2PostgresqlMetadata } from './helpers/epoch2PostgresqlMetadata'
// RFC-349 — the three owner maintenance jobs execute through real PostgreSQL
// adapters and keep the same bounded counters as SQLite.
// RFC-395 BF-D27: AF-D1 keeps one fence per mutation and one committed first-write marker per runtime.

import { withNativeTransactions } from './helpers/nativeTransactions'
import { describe, expect, test } from 'bun:test'

import { composeDevelopmentAutomationMaintenanceCommands } from '@/modules/development-automation/composition'
import {
  composeDigitalEmployeeMaintenanceCommands,
  composeDigitalEmployeeWriterCutover,
} from '@/modules/digital-employee/composition'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

function rows(input: {
  readonly objects?: readonly Record<string, unknown>[]
  readonly values?: readonly (readonly unknown[])[]
  readonly count?: number
}): SqlRows {
  const objects = [...(input.objects ?? [])] as Array<Record<string, unknown>> & { count?: number }
  objects.count = input.count ?? objects.length
  return Object.assign(Promise.resolve(objects), {
    async values() {
      return input.values ?? []
    },
  })
}

function fixture() {
  const statements: string[] = []
  const epoch2Metadata = createEpoch2PostgresqlMetadata()
  const execute = (sql: string): SqlRows => {
    statements.push(sql)
    const metadata = epoch2Metadata(sql)
    if (metadata) return metadata
    const normalized = sql.trim().toLowerCase()
    if (/^(begin|commit|rollback)$/.test(normalized)) return rows({})
    if (sql.includes('generations')) {
      return rows({ objects: [{ generation_id: 'dbg_owner_maintenance_pg' }] })
    }
    if (normalized.startsWith('select') && normalized.includes('mission_input_uploads')) {
      return rows({ values: [['mission-upload-1']] })
    }
    if (normalized.startsWith('delete') && normalized.includes('mission_input_uploads')) {
      // RFC-359 W4-D11：过期上传清扫是「子查询取一批 id + DELETE … RETURNING」一条语句，计数来自 RETURNING 行。
      return rows({ values: [['mission-upload-1']], count: 1 })
    }
    if (normalized.startsWith('select') && normalized.includes('employee_input_uploads')) {
      return rows({ values: [['employee-upload-1']] })
    }
    if (normalized.startsWith('delete') && normalized.includes('employee_input_uploads')) {
      return rows({ count: 1 })
    }
    if (normalized.startsWith('select') && normalized.includes('development_missions')) {
      return rows({ values: [] })
    }
    if (normalized.startsWith('select') && normalized.includes('development_bundle_refs')) {
      return rows({ values: [[0]] })
    }
    throw new Error(`unexpected PostgreSQL owner-maintenance query: ${sql}`)
  }
  const connection: PostgresqlReservedConnection = withNativeTransactions({
    unsafe: execute,
    release() {},
  })
  const pool: PostgresqlPool = {
    async reserve() {
      return connection
    },
    unsafe: execute,
    async close() {},
  }
  const runtime: PostgresqlDatabaseRuntime = {
    provider: 'postgresql',
    generationId: 'dbg_owner_maintenance_pg',
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
  return { db: createPostgresqlDatabaseClient(runtime), statements }
}

function writerFixture() {
  const statements: string[] = []
  const epoch2Metadata = createEpoch2PostgresqlMetadata()
  const execute = (sql: string): SqlRows => {
    statements.push(sql)
    const metadata = epoch2Metadata(sql)
    if (metadata) return metadata
    const normalized = sql.trim().toLowerCase()
    if (/^(begin|commit|rollback)$/.test(normalized)) return rows({})
    if (sql.includes('generations')) {
      return rows({ objects: [{ generation_id: 'dbg_owner_maintenance_pg' }] })
    }
    if (normalized.includes('for update')) return rows({})
    if (normalized.startsWith('select') && normalized.includes('employee_os_writer_state')) {
      return rows({ values: [['global', 0, 'pre-cutover', true, 0, 1_000]] })
    }
    if (normalized.startsWith('select') && normalized.includes('development_missions')) {
      return rows({ values: [[2]] })
    }
    if (normalized.startsWith('update') && normalized.includes('employee_os_writer_state')) {
      return rows({ count: 1 })
    }
    throw new Error(`unexpected PostgreSQL writer-cutover query: ${sql}`)
  }
  const connection: PostgresqlReservedConnection = withNativeTransactions({
    unsafe: execute,
    release() {},
  })
  const pool: PostgresqlPool = {
    async reserve() {
      return connection
    },
    unsafe: execute,
    async close() {},
  }
  const runtime: PostgresqlDatabaseRuntime = {
    provider: 'postgresql',
    generationId: 'dbg_owner_maintenance_pg',
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
  return { db: createPostgresqlDatabaseClient(runtime), statements }
}

describe('RFC-349 Digital/Development PostgreSQL maintenance owners', () => {
  test('upload GC, retention and employee-input GC use owner tables and bounded counters', async () => {
    const fake = fixture()
    const development = composeDevelopmentAutomationMaintenanceCommands(fake.db)
    const digital = composeDigitalEmployeeMaintenanceCommands(fake.db)

    await expect(development.sweepExpiredUploads(2_000, 100)).resolves.toBe(1)
    await expect(development.sweepRetention(2_000)).resolves.toEqual({
      missionsScanned: 0,
      prunedAttempts: 0,
      markedBundleRefs: 0,
      expiredBundleRefsPending: 0,
    })
    await expect(digital.sweepExpiredInputUploads(2_000, 100)).resolves.toBe(1)

    const sql = fake.statements.join('\n')
    expect(sql).toContain('"agent_workflow"."mission_input_uploads"')
    expect(sql).toContain('"agent_workflow"."development_missions"')
    expect(sql).toContain('"agent_workflow"."development_bundle_refs"')
    expect(sql).toContain('"agent_workflow"."employee_input_uploads"')
    const normalized = fake.statements.map((statement) => statement.trim().toLowerCase())
    const mutations = normalized.filter((statement) => statement.startsWith('delete from'))
    expect(mutations).toEqual([
      expect.stringContaining('delete from "agent_workflow"."mission_input_uploads"'),
      expect.stringContaining('delete from "agent_workflow"."employee_input_uploads"'),
    ])
    const fence = expect.stringMatching(/^select generation_id .*"generations".*for share$/)
    const firstWrite = [
      expect.stringContaining('select first_live_write_at'),
      expect.stringContaining('update "agent_workflow_meta"."first_write"'),
    ]
    expect(normalized.filter((statement) => statement.includes('"generations"'))).toEqual(
      mutations.map(() => fence),
    )
    expect(normalized.filter((statement) => statement.includes('"first_write"'))).toEqual(
      firstWrite,
    )
    for (const [index, mutation] of mutations.entries()) {
      const mutationIndex = normalized.indexOf(mutation)
      const begin = normalized.lastIndexOf('begin', mutationIndex)
      const commit = normalized.indexOf('commit', mutationIndex)
      expect(begin).toBeGreaterThanOrEqual(0)
      expect(commit).toBeGreaterThan(mutationIndex)
      expect(normalized.slice(begin, commit + 1)).toEqual([
        'begin',
        fence,
        ...(index === 0 ? firstWrite : []),
        mutation,
        'commit',
      ])
    }
  })

  test('installed writer facts never issue retired PostgreSQL state queries', async () => {
    const fake = writerFixture()
    const writer = composeDigitalEmployeeWriterCutover(fake.db, {
      activeGeneration: 1,
      updatedAt: 2000,
    })
    await expect(writer.read()).resolves.toEqual({
      activeGeneration: 1,
      mode: 'os-active',
      legacyAdmissionsEnabled: false,
      legacyOpenMissionCount: 0,
      updatedAt: 2000,
    })
    expect((await writer.analyze()).draining).toEqual([])
    expect(fake.statements).toEqual([])
  })
})
