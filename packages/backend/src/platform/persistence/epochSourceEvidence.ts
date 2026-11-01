// RFC-398 design §1 / §2.1: provider-local discovery of a configured but unpublished store.
import type { DatabaseConfig } from '@agent-workflow/shared'
import { unhandledDatabaseProvider } from './databaseProviders'
import { createPostgresqlDatabaseRuntime } from './postgresqlRuntime'

export async function probeConfiguredEpochSource(input: {
  readonly database: DatabaseConfig
  readonly env?: Readonly<Record<string, string | undefined>>
}): Promise<boolean | undefined> {
  switch (input.database.provider) {
    case 'sqlite':
      return undefined
    case 'postgresql':
      break
    default:
      return unhandledDatabaseProvider(input.database)
  }
  const runtime = createPostgresqlDatabaseRuntime({
    config: input.database,
    env: input.env,
    generationId: 'dbg_epoch_boot_probe',
  })
  try {
    const rows = await runtime
      .providerPool('migration')
      .unsafe(
        "SELECT 1 FROM information_schema.tables WHERE table_schema = 'agent_workflow' AND table_type = 'BASE TABLE' LIMIT 1",
      )
    return rows.length > 0
  } finally {
    await runtime.close()
  }
}
