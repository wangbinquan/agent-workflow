// RFC-349 T9 — Settings/HTTP and CLI share one exact application surface;
// raw PostgreSQL URLs cannot enter its DTOs or observable operation status.

import { describe, expect, test } from 'bun:test'
import { createDatabaseMigrationApplication } from '@/modules/system-operations/application/databaseMigrationApplication'
import type { DatabaseMigrationCoordinatorPort } from '@/modules/system-operations/application/ports/databaseMigrationCoordinator'
import { createDatabaseMigrationOperationDescriptors } from '@/modules/system-operations/public/databaseMigrationOperations'
import {
  databaseMigrationStatusViewSchema,
  startDatabaseMigrationInputSchema,
  type DatabaseMigrationStatusView,
} from '@/modules/system-operations/public/databaseMigrationTypes'

const target = {
  provider: 'postgresql' as const,
  urlEnv: 'AGENT_WORKFLOW_DATABASE_URL',
  poolMax: 16,
  connectTimeoutMs: 10_000,
  statementTimeoutMs: 60_000,
  idleTimeoutMs: 30_000,
}

const status: DatabaseMigrationStatusView = {
  operationId: 'dbm_operation_12345678',
  revision: 0,
  phase: 'planned',
  sourceGenerationId: 'dbg_legacy_sqlite',
  targetProvider: 'postgresql',
  targetUrlEnv: target.urlEnv,
  target,
  targetDatabaseFingerprint: null,
  tableCounts: { source: 184, active: 178, archiveOnly: 6 },
  progress: {
    table: null,
    chunk: 0,
    tablesCompleted: 0,
    tablesTotal: 184,
    rowsCopied: 0,
    bytesCopied: 0,
    lastMigrationKey: [],
  },
  failure: null,
  cancelEligible: true,
  resumeEligible: false,
  rollback: { eligible: false, reason: 'pointer-not-switched' },
  firstLiveWriteAt: null,
  rolledBackAt: null,
  rollbackReceiptDigest: null,
  createdAt: 1,
  updatedAt: 1,
}
const overview = {
  provider: 'sqlite' as const,
  generationId: 'dbg_legacy_sqlite',
  schemaDigest: `sha256:${'a'.repeat(64)}`,
  databaseFingerprint: 'sqlite:fixture',
  serverVersion: null,
  operationId: null,
  target: null,
  source: { databaseFingerprint: 'sqlite:fixture', fileBytes: 4096, totalRows: 0 },
  tableCounts: status.tableCounts,
}
const preflight = {
  ok: true as const,
  databaseFingerprint: 'pg:fixture',
  serverMajor: 17,
  serverVersionNum: 170_000,
  serverEncoding: 'UTF8' as const,
  timezone: 'UTC' as const,
  databaseBytes: 8192,
  targetState: 'empty' as const,
  applicationTableCount: 0,
  metadataTableCount: 0,
  sourceDatabaseFingerprint: 'sqlite:fixture',
  sourceBytes: 4096,
  sourceRows: 0,
  tableCounts: status.tableCounts,
}

function fixture() {
  const calls: string[] = []
  const coordinator: DatabaseMigrationCoordinatorPort = {
    async preflight() {
      calls.push('preflight')
      return preflight
    },
    async start() {
      calls.push('start')
      return status
    },
    async resume() {
      calls.push('resume')
      return status
    },
    async cancel() {
      calls.push('cancel')
      return status
    },
    async rollback() {
      calls.push('rollback')
      return status
    },
    async finalize() {
      calls.push('finalize')
      return status
    },
    async get() {
      calls.push('get')
      return status
    },
    async list() {
      calls.push('list')
      return [status]
    },
    async overview() {
      calls.push('overview')
      return overview
    },
    async resumeInterrupted() {
      return null
    },
  }
  const application = createDatabaseMigrationApplication(coordinator)
  return {
    calls,
    descriptors: createDatabaseMigrationOperationDescriptors(application),
  }
}

describe('RFC-349 database migration public operations', () => {
  test('uses exact codecs, two critical permissions and one idempotency field', async () => {
    const { descriptors, calls } = fixture()
    expect(descriptors.start.kind).toBe('idempotent-command')
    expect(descriptors.start.idempotencyKey.field).toBe('idempotencyKey')
    expect(descriptors.start.permissions).toEqual(['settings:write', 'backup:run'])
    const input = descriptors.start.input.parse({
      idempotencyKey: 'settings:2026-08-31:01',
      target,
    })
    expect(
      await descriptors.start.invoke({} as never, input),
    ).toEqual(databaseMigrationStatusViewSchema.parse(status))
    expect(calls).toEqual(['start'])
    expect(() => descriptors.start.input.parse({ ...input, unexpected: true })).toThrow()
  })

  test('exposes safe runtime overview and target preflight without a connection URL', async () => {
    const { descriptors, calls } = fixture()
    expect(await descriptors.overview.invoke({} as never, {})).toEqual(overview)
    expect(
      await descriptors.preflight.invoke({} as never, { target }),
    ).toEqual(preflight)
    expect(calls).toEqual(['overview', 'preflight'])
    expect(JSON.stringify({ overview, preflight })).not.toContain('postgresql://')
  })

  test('rejects raw connection URLs and secret-bearing target fields', () => {
    expect(
      startDatabaseMigrationInputSchema.safeParse({
        idempotencyKey: 'settings:2026-08-31:02',
        target: { ...target, urlEnv: 'postgresql://user:secret@db/app' },
      }).success,
    ).toBe(false)
    expect(
      startDatabaseMigrationInputSchema.safeParse({
        idempotencyKey: 'settings:2026-08-31:03',
        target: { ...target, url: 'postgresql://user:secret@db/app' },
      }).success,
    ).toBe(false)
    expect(JSON.stringify(status)).not.toContain('postgresql://')
  })

  test('exposes status/list/resume/cancel/rollback/finalize through the same application owner', async () => {
    const { descriptors, calls } = fixture()
    const context = {} as never
    const operation = { operationId: status.operationId }
    await descriptors.get.invoke(context, operation)
    await descriptors.list.invoke(context, {})
    await descriptors.resume.invoke(context, operation)
    await descriptors.cancel.invoke(context, operation)
    await descriptors.rollback.invoke(context, operation)
    await descriptors.finalize.invoke(context, operation)
    expect(calls).toEqual(['get', 'list', 'resume', 'cancel', 'rollback', 'finalize'])
  })
})
