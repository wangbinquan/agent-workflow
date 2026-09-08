// Hosted-only real-process interruption at an old copy's durable boundary.
// The parent supplies an already-created historical source; no service is
// launched here. The synchronous latch prevents another phase from advancing.
import { readFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseConfig } from '@agent-workflow/shared'
import { createDatabaseMigrationControlPlane } from '@/modules/system-operations/application/databaseMigrationControlPlane'
import { createDatabaseMigrationRunner } from '@/modules/system-operations/application/databaseMigrationRunner'
import { createFileDatabaseMigrationArtifactStore } from '@/modules/system-operations/infrastructure/fileDatabaseMigrationArtifactStore'
import { createFileDatabaseMigrationStore } from '@/modules/system-operations/infrastructure/fileDatabaseMigrationStore'
import { createSqliteMigrationSafetyBackup } from '@/modules/system-operations/infrastructure/sqliteMigrationSafetyBackup'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationHistory'
import { openPostgresqlLogicalTarget } from '@/platform/persistence/postgresqlLogicalTarget'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { openSqliteLogicalSource } from '@/platform/persistence/sqliteLogicalSource'

const input = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as {
  appHome: string
  operationId: string
  sourceGenerationId: string
  config: Extract<DatabaseConfig, { provider: 'postgresql' }>
  checkpoint: 'after:chunk' | 'after:health-checked'
}
function hold(checkpoint: typeof input.checkpoint): void {
  if (checkpoint !== input.checkpoint) return
  writeSync(1, `RFC359_T19H_CHECKPOINT ${JSON.stringify({ checkpoint, pid: process.pid })}\n`)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  throw new Error('historical copy interruption latch unexpectedly returned')
}

const history = await loadPostgresqlMigrationHistory()
const operationsRoot = join(input.appHome, 'database-migrations')
const controlPlane = createDatabaseMigrationControlPlane({
  store: createFileDatabaseMigrationStore({ root: operationsRoot }),
  newOperationId: () => input.operationId,
  newOwnerId: () => 'dbo_t19h_old_copy_process',
})
const source = openSqliteLogicalSource({
  path: join(input.appHome, 'db.sqlite'),
  contract: history.root.contract,
})
const snapshot = await source.preflight()
controlPlane.start({
  idempotencyKey: input.operationId,
  sourceGenerationId: input.sourceGenerationId,
  sourceSchemaDigest: history.root.contract.digest,
  sourceDatabaseFingerprint: snapshot.databaseFingerprint,
  target: input.config,
  tableCounts: {
    source: history.root.contract.sourceTableCount,
    active: history.root.contract.activeTableCount,
    archiveOnly: history.root.contract.archiveOnlyTableCount,
  },
  ownerLeaseMs: 60_000,
  now: Date.now(),
})
const runtime = createPostgresqlDatabaseRuntime({
  config: input.config,
  generationId: `dbg_pg_${input.operationId.slice(4)}`,
})
const target = await openPostgresqlLogicalTarget({
  runtime,
  operationId: input.operationId,
  sourceGenerationId: input.sourceGenerationId,
  contract: history.root.contract,
  plan: history.root.plan,
})
try {
  const runner = createDatabaseMigrationRunner({
    controlPlane: {
      ...controlPlane,
      advance(operationId, transition) {
        const result = controlPlane.advance(operationId, transition)
        if (transition.nextPhase === 'health-checked') hold('after:health-checked')
        return result
      },
    },
    source,
    sourceSnapshot: snapshot,
    target: {
      ...target,
      async copyChunk(table, chunk, now) {
        await target.copyChunk(table, chunk, now)
        hold('after:chunk')
      },
    },
    targetRuntime: runtime,
    contract: history.root.contract,
    admission: {
      freezeAndDrain: async () => {},
      reopenSqlite: async () => {},
      activatePostgresql: async () => {},
      openPostgresqlAdmission: async () => {},
    },
    safetyBackup: createSqliteMigrationSafetyBackup(),
    artifacts: createFileDatabaseMigrationArtifactStore({ operationsRoot }),
    generationPointerPath: join(input.appHome, 'database-generation.json'),
  })
  await runner.run(input.operationId)
  throw new Error('historical worker completed without reaching its checkpoint')
} finally {
  try {
    await target.close()
  } finally {
    try {
      await source.close()
    } finally {
      await runtime.close()
    }
  }
}
