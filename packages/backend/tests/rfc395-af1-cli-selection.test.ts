import type { LocalSystemOperationContext } from '@/modules/system-operations/public/types'
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrationReportCommand } from '@/cli/migrationReport'
import { checkConfiguredDatabase } from '@/modules/system-operations/infrastructure/local/doctorDiagnostics'
import { prepareEpoch2DatabaseProviderRuntime } from '@/platform/persistence/databaseProviderRuntime'
import { createFileDatabasePreOpenRecovery } from '@/modules/system-operations/infrastructure/local/fileDatabasePreOpenRecovery'
import { stagePendingRestore } from '@/modules/system-operations/infrastructure/local/filePendingRestore'
import { logicalSchemaContract } from '@/bootstrap/persistenceSchema'
import { createSqliteBaseline } from '@/bootstrap/persistenceBaseline'
import { readGenerationPointerV2 } from '@/platform/persistence/generationPointerV2'
import { tarGz } from '@/util/archive'
import {
  supportsDatabaseMigration,
  supportsProviderMove,
} from '@/platform/persistence/migrationSupport'

async function withHome(body: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'af1-tools-')),
    previous = process.env.AGENT_WORKFLOW_HOME
  process.env.AGENT_WORKFLOW_HOME = root
  try {
    await body(root)
  } finally {
    if (previous === undefined) delete process.env.AGENT_WORKFLOW_HOME
    else process.env.AGENT_WORKFLOW_HOME = previous
    rmSync(root, { recursive: true, force: true })
  }
}
const tasks = {
  async countLifecycleStates() {
    return { interrupted: 0, failed: 0, awaitingReview: 0, awaitingHuman: 0, quarantined: 0 }
  },
}
test('AF-D10 report refuses and doctor accepts an uninstalled home without creating db.sqlite', () =>
  withHome(async (root) => {
    await expect(migrationReportCommand([], logicalSchemaContract)).rejects.toThrow(
      'requires an installed database generation',
    )
    expect((await checkConfiguredDatabase(logicalSchemaContract, tasks))[0]).toMatchObject({
      ok: true,
      message: 'SQLite (no database yet)',
    })
    expect(existsSync(join(root, 'db.sqlite'))).toBeFalse()
  }))
test('AF-D10 report and doctor follow the SQLite pointer even when configuration selects PostgreSQL', () =>
  withHome(async (root) => {
    const prepared = await prepareEpoch2DatabaseProviderRuntime({
      config: { provider: 'sqlite' },
      contract: logicalSchemaContract,
      sqlitePath: join(root, 'db.sqlite'),
      generationPointerPath: join(root, 'database-generation.json'),
      operationsRoot: join(root, 'database-migrations'),
      sqliteOptions: {},
    })
    await prepared.runtime.close()
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({ database: { provider: 'postgresql', urlEnv: 'AF1_UNUSED_PG_PROFILE' } }),
    )
    expect(
      JSON.parse((await migrationReportCommand(['--json'], logicalSchemaContract)).output),
    ).toBeObject()
    const report = await checkConfiguredDatabase(logicalSchemaContract, tasks)
    expect(report[0]!.message).toContain('sqlite generation')
    expect(existsSync(join(root, 'db.sqlite'))).toBeFalse()
  }))
test('AF-D7 pending restore never attempts v2 parsing for a v1 pointer', () =>
  withHome(async (root) => {
    writeFileSync(
      join(root, 'database-generation.json'),
      JSON.stringify({ payload: { version: 1 } }),
    )
    const recovery = createFileDatabasePreOpenRecovery({
      contract: logicalSchemaContract,
      migrationsFolder: '',
    })
    expect(await recovery.applyStagedRestore()).toBeFalse()
    const artifact = join(root, 'old.tar.gz')
    writeFileSync(artifact, 'staging fixture')
    stagePendingRestore(artifact, { appHome: root, now: 1 })
    await expect(recovery.applyStagedRestore()).rejects.toThrow('epoch-1 installation')
    const source = readFileSync(join(import.meta.dir, '../src/bootstrap/daemonStart.ts'), 'utf8')
    expect(source.indexOf('readEpochBootFacts({')).toBeLessThan(
      source.indexOf('await applyLocalEpoch2PendingRestore('),
    )
  }))
test('AF-D11 migration eligibility is the source/target/epoch matrix', () => {
  for (const sourceProvider of ['sqlite', 'postgresql'] as const)
    for (const targetProvider of ['sqlite', 'postgresql'] as const) {
      expect(supportsProviderMove(sourceProvider, targetProvider)).toBe(
        sourceProvider === 'sqlite' && targetProvider === 'postgresql',
      )
      expect(
        supportsDatabaseMigration({
          sourceProvider,
          targetProvider,
          sourceEpoch: 1,
          targetEpoch: 2,
        }),
      ).toBe(!(sourceProvider === 'postgresql' && targetProvider === 'sqlite'))
      expect(
        supportsDatabaseMigration({
          sourceProvider,
          targetProvider,
          sourceEpoch: 2,
          targetEpoch: 1,
        }),
      ).toBeFalse()
    }
})

test('AF-D8 a staged native restore into an empty home publishes the generation directory', () =>
  withHome(async (root) => {
    const incoming = join(root, 'incoming')
    mkdirSync(incoming)
    const source = createSqliteBaseline()
    try {
      writeFileSync(join(incoming, 'db.sqlite'), source.serialize())
    } finally {
      source.close()
    }
    const archive = join(root, 'restore.tar.gz')
    await tarGz(incoming, archive)
    stagePendingRestore(archive, { appHome: root, now: 1, noSafetyBackup: true })
    const recovery = createFileDatabasePreOpenRecovery({
      contract: logicalSchemaContract,
      migrationsFolder: '',
    })
    expect(await recovery.applyStagedRestore()).toBeTrue()
    const pointer = readGenerationPointerV2(join(root, 'database-generation.json'))
    expect(pointer.payload.database).toEqual({
      kind: 'sqlite-file',
      relativePath: `databases/${pointer.payload.generationId}/db.sqlite`,
    })
    expect(existsSync(join(root, 'db.sqlite'))).toBeFalse()
    expect(existsSync(join(root, `databases/${pointer.payload.generationId}/db.sqlite`))).toBeTrue()
  }))

// BF-D15: target validation must not mask the coordinator's idempotency/refusal.
for (const action of ['preflight', 'migrate'] as const)
  test(`BF-D15 ${action} reaches the coordinator with PostgreSQL already live`, async () => {
    const { databaseCommand } = await import('@/cli/database')
    const { createDatabaseMigrationApplication } =
      await import('@/modules/system-operations/application/databaseMigrationApplication')
    const calls: string[] = []
    const unused = async (): Promise<never> => {
      throw new Error('unexpected coordinator call')
    }
    const application = createDatabaseMigrationApplication({
      async overview() {
        return {
          provider: 'postgresql',
          generationId: 'dbg_pg_cli_completed',
          schemaDigest: `sha256:${'a'.repeat(64)}`,
          databaseFingerprint: null,
          serverVersion: null,
          operationId: 'dbm_cli_completed',
          target: null,
          source: null,
          tableCounts: { source: 0, active: 0, archiveOnly: 0 },
        }
      },
      async preflight(input) {
        calls.push(`preflight:${input.target.provider}`)
        throw new Error('database-migration-source-not-sqlite')
      },
      async start(input) {
        calls.push(`start:${input.target.provider}`)
        expect(input.idempotencyKey.length).toBeGreaterThan(8)
        return {
          operationId: 'dbm_cli_completed',
          revision: 1,
          phase: 'finalized',
          sourceGenerationId: 'dbg_source_fixture',
          targetProvider: 'postgresql',
          targetUrlEnv: input.target.urlEnv,
          target: input.target,
          targetDatabaseFingerprint: 'pg:fixture',
          tableCounts: { source: 0, active: 0, archiveOnly: 0 },
          progress: {
            table: null,
            chunk: 0,
            tablesCompleted: 0,
            tablesTotal: 0,
            rowsCopied: 0,
            bytesCopied: 0,
            lastMigrationKey: [],
          },
          failure: null,
          cancelEligible: false,
          resumeEligible: false,
          rollback: { eligible: false, reason: 'operation-finalized' },
          firstLiveWriteAt: 1,
          rolledBackAt: null,
          rollbackReceiptDigest: null,
          createdAt: 1,
          updatedAt: 2,
        }
      },
      resume: unused,
      cancel: unused,
      rollback: unused,
      finalize: unused,
      get: unused,
      list: unused,
      readArtifact: unused,
      inspectLegacyTable: unused,
      readLegacyChunk: unused,
      resumeInterrupted: unused,
    })
    let released = false
    const result = await databaseCommand(
      [action, '--to', 'postgresql', '--auto', '--json'],
      {
        context: {} as LocalSystemOperationContext,
        application,
      },
      (path) => ({
        pid: 1,
        path,
        release() {
          released = true
        },
      }),
    )
    expect(calls).toEqual([`${action === 'migrate' ? 'start' : 'preflight'}:postgresql`])
    if (action === 'migrate') {
      expect(result.status).toBe('ok')
      expect(JSON.parse(result.output)).toMatchObject({
        phase: 'finalized',
        operationId: 'dbm_cli_completed',
      })
      expect(released).toBeTrue()
    } else {
      expect(result.status).toBe('error')
      expect(result.output).toContain('database-migration-source-not-sqlite')
    }
  })
