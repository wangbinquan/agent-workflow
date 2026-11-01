// RFC-398 design §1 / §4: CLI rendering and locking with an explicitly injected operation factory.
import { join } from 'node:path'
import type { LegacyMigrationFinalizePort } from '@/modules/system-operations/public/commands'
import { readMigrationSourcePointer } from '@/platform/persistence/migration/generationPointerSource'
import { formatDatabaseMigrationStatus, type DatabaseCliResult } from '@/cli/database'
import { acquireLock } from '@/util/lock'

export async function legacyEpochMigrationCommand(input: {
  readonly appHome: string
  readonly createApplication: () => LegacyMigrationFinalizePort
  readonly argv: readonly string[]
}): Promise<DatabaseCliResult | null> {
  const [verb, operationId, ...flags] = input.argv
  if (
    !['status', 'finalize'].includes(verb ?? '') ||
    !operationId?.startsWith('dbm_') ||
    operationId.startsWith('dbm_e2_')
  )
    return null
  if (
    readMigrationSourcePointer(join(input.appHome, 'database-generation.json')).pointer?.payload
      .version === 2
  )
    return null
  if (flags.some((flag) => flag !== '--json'))
    return {
      status: 'usage-error',
      output: 'usage: db migration status|finalize <dbm_…> [--json]\n',
    }
  const lock = acquireLock(join(input.appHome, '.daemon.lock'))
  try {
    const adapter = input.createApplication()
    const result = await (verb === 'finalize'
      ? adapter.finalize(operationId)
      : adapter.status(operationId))
    return {
      status: 'ok',
      output: `${flags.includes('--json') ? JSON.stringify(result) : formatDatabaseMigrationStatus(result)}\n`,
    }
  } catch (error) {
    return {
      status: 'error',
      output: `${error instanceof Error ? error.message : String(error)}\n`,
    }
  } finally {
    lock.release()
  }
}
