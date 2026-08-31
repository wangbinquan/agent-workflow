// RFC-349 T9 — CLI is a projector over the same system-operations application,
// and mutating commands hold the daemon lock for the whole operation.

import { describe, expect, test } from 'bun:test'
import {
  databaseCommand,
  formatDatabaseMigrationStatus,
  type LocalDatabaseMigrationOperations,
} from '@/cli/database'
import { createDatabaseMigrationApplication } from '@/modules/system-operations/application/databaseMigrationApplication'
import type { DatabaseMigrationCoordinatorPort } from '@/modules/system-operations/application/ports/databaseMigrationCoordinator'
import type { DatabaseMigrationStatusView } from '@/modules/system-operations/public/types'
import type { LocalSystemOperationContext } from '@/modules/system-operations/public/types'
import { DaemonLockHeldError, type Lock } from '@/util/lock'

const target = {
  provider: 'postgresql' as const,
  urlEnv: 'AW_DATABASE_URL',
  poolMax: 8,
  connectTimeoutMs: 5_000,
  statementTimeoutMs: 20_000,
  idleTimeoutMs: 15_000,
}
const status: DatabaseMigrationStatusView = {
  operationId: 'dbm_cli_operation_1234',
  revision: 1,
  phase: 'copying',
  sourceGenerationId: 'dbg_legacy_sqlite',
  targetProvider: 'postgresql',
  targetUrlEnv: target.urlEnv,
  target,
  targetDatabaseFingerprint: 'pg:fixture',
  tableCounts: { source: 184, active: 178, archiveOnly: 6 },
  progress: {
    table: 'tasks',
    chunk: 4,
    tablesCompleted: 120,
    tablesTotal: 184,
    rowsCopied: 12_345,
    bytesCopied: 2_097_152,
    lastMigrationKey: ['task-1'],
  },
  failure: null,
  cancelEligible: true,
  resumeEligible: false,
  rollback: { eligible: false, reason: 'pointer-not-switched' },
  firstLiveWriteAt: null,
  rolledBackAt: null,
  rollbackReceiptDigest: null,
  createdAt: 1,
  updatedAt: 2,
}
const overview = {
  provider: 'sqlite' as const,
  generationId: 'dbg_legacy_sqlite',
  schemaDigest: `sha256:${'a'.repeat(64)}`,
  databaseFingerprint: 'sqlite:fixture',
  serverVersion: null,
  operationId: null,
  target: null,
  source: { databaseFingerprint: 'sqlite:fixture', fileBytes: 4096, totalRows: 12345 },
  tableCounts: status.tableCounts,
}
const preflight = {
  ok: true as const,
  databaseFingerprint: 'pg:fixture',
  serverMajor: 17,
  serverVersionNum: 170_000,
  serverEncoding: 'UTF8' as const,
  timezone: 'UTC' as const,
  databaseBytes: 8_192,
  targetState: 'empty' as const,
  applicationTableCount: 0,
  metadataTableCount: 0,
  sourceDatabaseFingerprint: 'sqlite:fixture',
  sourceBytes: 4_096,
  sourceRows: 12_345,
  tableCounts: status.tableCounts,
}
const artifactDigest = `sha256:${'c'.repeat(64)}`
const receiptArtifact = {
  operationId: status.operationId,
  kind: 'receipt' as const,
  fileName: `${status.operationId}-receipt.json`,
  contentType: 'application/json; charset=utf-8' as const,
  byteLength: 3,
  digest: artifactDigest,
  fileDigest: artifactDigest,
  json: '{}\n',
}
const legacyInspection = {
  operationId: status.operationId,
  table: 'code_artifacts',
  disposition: 'ARCHIVE_THEN_OMIT' as const,
  rowCount: 2,
  chunkCount: 1,
  firstKey: ['{"type":"text","value":"a"}'],
  lastKey: ['{"type":"text","value":"b"}'],
  rootDigest: artifactDigest,
  blobBytes: 0,
}

function fixture() {
  const calls: Array<{ action: string; input: unknown }> = []
  const coordinator: DatabaseMigrationCoordinatorPort = {
    async preflight(input) {
      calls.push({ action: 'preflight', input })
      return preflight
    },
    async start(input) {
      calls.push({ action: 'start', input })
      return status
    },
    async resume(input) {
      calls.push({ action: 'resume', input })
      return status
    },
    async cancel(input) {
      calls.push({ action: 'cancel', input })
      return status
    },
    async rollback(input) {
      calls.push({ action: 'rollback', input })
      return status
    },
    async finalize(input) {
      calls.push({ action: 'finalize', input })
      return status
    },
    async get(input) {
      calls.push({ action: 'get', input })
      return status
    },
    async list() {
      return [status]
    },
    async overview() {
      calls.push({ action: 'overview', input: {} })
      return overview
    },
    async readArtifact(input) {
      calls.push({ action: 'readArtifact', input })
      return receiptArtifact
    },
    async inspectLegacyTable(input) {
      calls.push({ action: 'inspectLegacyTable', input })
      return legacyInspection
    },
    async readLegacyChunk(input) {
      calls.push({ action: 'readLegacyChunk', input })
      return { ...receiptArtifact, kind: 'legacy-archive-chunk' as const }
    },
    async resumeInterrupted() {
      return null
    },
  }
  const application = createDatabaseMigrationApplication(coordinator)
  const operations: LocalDatabaseMigrationOperations = {
    context: {} as LocalSystemOperationContext,
    application,
  }
  let acquired = 0
  let released = 0
  const lockFactory = (path: string): Lock => {
    acquired += 1
    return {
      pid: 123,
      path,
      release() {
        released += 1
      },
    }
  }
  return {
    calls,
    operations,
    lockFactory,
    get acquired() {
      return acquired
    },
    get released() {
      return released
    },
  }
}

describe('RFC-349 database CLI', () => {
  test('requires explicit --auto and projects every target constraint', async () => {
    const fake = fixture()
    expect(
      await databaseCommand(
        ['migrate', '--to', 'postgresql', '--url-env', 'AW_DATABASE_URL'],
        fake.operations,
        fake.lockFactory,
      ),
    ).toMatchObject({ status: 'error', output: expect.stringContaining('--auto is required') })
    expect(fake.calls).toHaveLength(0)

    const result = await databaseCommand(
      [
        'migrate',
        '--to',
        'postgresql',
        '--url-env',
        'AW_DATABASE_URL',
        '--pool-max',
        '8',
        '--connect-timeout-ms',
        '5000',
        '--statement-timeout-ms',
        '20000',
        '--idle-timeout-ms',
        '15000',
        '--auto',
      ],
      fake.operations,
      fake.lockFactory,
    )
    expect(result.status).toBe('ok')
    expect(fake.calls[0]).toMatchObject({ action: 'start', input: { target } })
    expect(fake.calls[0]?.input).toMatchObject({ idempotencyKey: expect.stringMatching(/^cli:/) })
    expect(fake.acquired).toBe(1)
    expect(fake.released).toBe(1)
  })

  test('database status and preflight are online read/probe actions without the daemon lock', async () => {
    const fake = fixture()
    expect(await databaseCommand(['status'], fake.operations, fake.lockFactory)).toMatchObject({
      status: 'ok',
      output: expect.stringContaining('provider:     sqlite'),
    })
    expect(
      await databaseCommand(
        ['preflight', '--to', 'postgresql', '--url-env', 'AW_DATABASE_URL'],
        fake.operations,
        fake.lockFactory,
      ),
    ).toMatchObject({ status: 'ok', output: expect.stringContaining('preflight: ready') })
    expect(fake.calls.map((call) => call.action)).toEqual(['overview', 'preflight'])
    expect(fake.acquired).toBe(0)
  })

  test('status stays read-only while resume/cancel/rollback/finalize take the offline lock', async () => {
    const fake = fixture()
    const operationId = status.operationId
    expect(
      await databaseCommand(
        ['migration', 'status', operationId, '--json'],
        fake.operations,
        fake.lockFactory,
      ),
    ).toMatchObject({ status: 'ok', output: expect.stringContaining('"phase":"copying"') })
    expect(fake.acquired).toBe(0)
    for (const action of ['resume', 'cancel', 'rollback', 'finalize']) {
      expect(
        await databaseCommand(
          ['migration', action, operationId],
          fake.operations,
          fake.lockFactory,
        ),
      ).toMatchObject({ status: 'ok' })
    }
    expect(fake.acquired).toBe(4)
    expect(fake.released).toBe(4)
  })

  test('reports a live daemon before invoking a mutating command', async () => {
    const fake = fixture()
    const result = await databaseCommand(
      ['migration', 'resume', status.operationId],
      fake.operations,
      () => {
        throw new DaemonLockHeldError(456, '/tmp/daemon.lock')
      },
    )
    expect(result).toMatchObject({
      status: 'error',
      output: expect.stringContaining('daemon is running (pid 456)'),
    })
    expect(fake.calls).toHaveLength(0)
  })

  test('human status distinguishes source, active and archive-only tables', () => {
    const output = formatDatabaseMigrationStatus(status)
    expect(output).toContain('184 source (178 active + 6 archive-only)')
    expect(output).toContain('rows=12345')
    expect(output).toContain('rollback:')
  })

  test('inspects and exports only bounded verified legacy artifacts without the daemon lock', async () => {
    const fake = fixture()
    const operationId = status.operationId
    expect(
      await databaseCommand(
        ['legacy', 'inspect', operationId, 'code_artifacts'],
        fake.operations,
        fake.lockFactory,
      ),
    ).toMatchObject({
      status: 'ok',
      output: expect.stringContaining('chunks:       1'),
    })
    expect(
      await databaseCommand(
        ['legacy', 'export', operationId, 'code_artifacts', '--chunk', '0'],
        fake.operations,
        fake.lockFactory,
      ),
    ).toEqual({ status: 'ok', output: '{}\n' })
    expect(
      await databaseCommand(
        ['migration', 'artifact', operationId, 'receipt'],
        fake.operations,
        fake.lockFactory,
      ),
    ).toEqual({ status: 'ok', output: '{}\n' })
    expect(fake.calls).toEqual([
      {
        action: 'inspectLegacyTable',
        input: { operationId, table: 'code_artifacts' },
      },
      {
        action: 'readLegacyChunk',
        input: { operationId, table: 'code_artifacts', chunkIndex: 0 },
      },
      { action: 'readArtifact', input: { operationId, kind: 'receipt' } },
    ])
    expect(fake.acquired).toBe(0)
  })
})
