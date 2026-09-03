// `agent-workflow migrate` — manually apply pending DB migrations.
// The daemon's `start` command already does this on boot; this subcommand
// exists as a recovery / debug fallback when the daemon won't start due to
// a failed migration that needs inspection.

import { unhandledDatabaseProvider } from '@/platform/persistence/databaseProviders'
import { loadConfig } from '@/config'
import { resolveDatabaseProviderRuntime } from '@/platform/persistence/databaseProviderRuntime'
import { migratePostgresqlSchema } from '@/platform/persistence/postgresqlMigrator'
import { buildLogicalSchemaContract } from '@/platform/persistence/schemaContract'
import { resolveMigrationsFolder } from '@/util/migrationsFolder'
import { Paths } from '@/util/paths'

export async function migrateCommand(): Promise<{ output: string }> {
  const config = loadConfig(Paths.config)
  const contract = buildLogicalSchemaContract()
  const provider = resolveDatabaseProviderRuntime({
    config: config.database,
    sqlitePath: Paths.db,
    generationPointerPath: Paths.databaseGenerationPointer,
    operationsRoot: Paths.databaseMigrationsDir,
    contract,
  })
  // Residual fence: a third variant on ResolvedDatabaseProviderRuntime widens
  // this and stops compiling, instead of falling into the SQLite path below.
  if (provider.provider !== 'sqlite' && provider.provider !== 'postgresql') {
    return unhandledDatabaseProvider(provider)
  }
  if (provider.provider === 'postgresql') {
    try {
      const receipt = await migratePostgresqlSchema({ runtime: provider.runtime })
      return {
        output:
          `PostgreSQL schema ${receipt.applied ? 'applied' : 'verified'} ` +
          `(generation: ${provider.generation.payload.generationId}, active tables: ${receipt.activeTableCount})\n`,
      }
    } finally {
      await provider.close()
    }
  }
  // Opening the selected SQLite client applies all pending migrations. Close
  // the provider before returning:
  // the production CLI exits right after (so a leak is harmless there), but the
  // in-process test harness reuses the process, and on Windows a leaked bun:sqlite
  // handle keeps db.sqlite (+ WAL -wal/-shm) OPEN, which locks the containing
  // directory — the caller's `rm(tempDir)` then fails EBUSY (POSIX lets you
  // unlink an open file; Windows does not). RFC-254 T31 (cli.test.ts teardown).
  provider.openClient({ migrationsFolder: await resolveMigrationsFolder() })
  await provider.close()
  return { output: `migrations applied (database: ${Paths.db})\n` }
}
