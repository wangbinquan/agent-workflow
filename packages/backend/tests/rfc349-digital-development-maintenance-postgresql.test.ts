// RFC-349 — the three owner maintenance jobs execute through real PostgreSQL
// adapters and keep the same bounded counters as SQLite.

import { afterEach, describe, expect, test } from 'bun:test'

import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { composePostgresqlDevelopmentAutomationMaintenanceCommands } from '@/modules/development-automation/composition'
import {
  composePostgresqlDigitalEmployeeMaintenanceCommands,
  composePostgresqlDigitalEmployeeWriterCutover,
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
  const execute = (sql: string): SqlRows => {
    statements.push(sql)
    const normalized = sql.trim().toLowerCase()
    if (/^(begin|commit|rollback)$/.test(normalized)) return rows({})
    if (sql.includes('database_generations')) {
      return rows({ objects: [{ generation_id: 'dbg_owner_maintenance_pg' }] })
    }
    if (normalized.startsWith('select') && normalized.includes('mission_input_uploads')) {
      return rows({ values: [['mission-upload-1']] })
    }
    if (normalized.startsWith('delete') && normalized.includes('mission_input_uploads')) {
      return rows({ count: 1 })
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
  const connection: PostgresqlReservedConnection = { unsafe: execute, release() {} }
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
  const execute = (sql: string): SqlRows => {
    statements.push(sql)
    const normalized = sql.trim().toLowerCase()
    if (/^(begin|commit|rollback)$/.test(normalized)) return rows({})
    if (sql.includes('database_generations')) {
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
  const connection: PostgresqlReservedConnection = { unsafe: execute, release() {} }
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

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 Digital/Development PostgreSQL maintenance owners', () => {
  test('upload GC, retention and employee-input GC use owner tables and bounded counters', async () => {
    const fake = fixture()
    const development = composePostgresqlDevelopmentAutomationMaintenanceCommands(fake.db)
    const digital = composePostgresqlDigitalEmployeeMaintenanceCommands(fake.db)

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
    expect(
      fake.statements.filter((statement) => statement.includes('database_generations')),
    ).toHaveLength(2)
  })

  test('writer cutover locks, counts, fences and updates in one PostgreSQL transaction', async () => {
    const fake = writerFixture()
    const writer = composePostgresqlDigitalEmployeeWriterCutover(fake.db)

    await expect(writer.activate({ now: 2_000, legacyAdmissionsEnabled: false })).resolves.toEqual({
      activeGeneration: 1,
      mode: 'legacy-draining',
      legacyAdmissionsEnabled: false,
      legacyOpenMissionCount: 2,
      updatedAt: 2_000,
    })

    const normalized = fake.statements.map((statement) => statement.trim().toLowerCase())
    expect(normalized[0]).toBe('begin')
    expect(normalized.some((statement) => statement.includes('for update'))).toBe(true)
    expect(normalized.some((statement) => statement.includes('database_generations'))).toBe(true)
    expect(
      normalized.some((statement) =>
        statement.includes('update "agent_workflow"."employee_os_writer_state"'),
      ),
    ).toBe(true)
    expect(normalized.at(-1)).toBe('commit')
  })
})
