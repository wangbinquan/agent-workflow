// RFC-346 — source locks for the CLI cutover. Behavioral output remains covered
// by RFC-213 restore tests; this file prevents direct legacy orchestration from
// growing back into the CLI adapters.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE_ROOT = join(import.meta.dirname, '../src')
const CLI_ROOT = join(SOURCE_ROOT, 'cli')
/**
 * What the two CLI adapters may not reach directly: the database, `services/`, and the three mechanisms the System
 * Operations commands own — the daemon lock, the installation paths and the migrations folder. The three left `util/`
 * (RFC-572, RFC-574, RFC-573); RFC-574 points the matcher at their current locations, which the `util/` spelling had
 * stopped matching after the first two moves.
 */
const FORBIDDEN_CLI_MECHANISMS =
  /@\/(?:db|services|platform\/execution\/local\/daemonLock|platform\/configuration\/installationPaths|platform\/persistence\/migration\/migrationsFolder)/

describe('RFC-346 CLI typed cutover', () => {
  test('backup and restore consume only exact System Operations public contracts', () => {
    const expectedPublicContracts = {
      'backup.ts': ['commands', 'types'],
      'restore.ts': ['commands', 'queries', 'types'],
    } as const
    for (const [name, contracts] of Object.entries(expectedPublicContracts)) {
      const source = readFileSync(join(CLI_ROOT, name), 'utf8')
      for (const contract of contracts) {
        expect(source).toContain(`@/modules/system-operations/public/${contract}`)
      }
      expect(source).not.toContain('@/modules/system-operations/composition')
      expect(source).not.toMatch(FORBIDDEN_CLI_MECHANISMS)
    }
  })

  test('matcher self-check: the three mechanisms at their current locations and db / services are recognised; public contracts pass', () => {
    for (const fabricated of [
      "import { acquireLock } from '@/platform/execution/local/daemonLock'",
      "import { Paths } from '@/platform/configuration/installationPaths'",
      "import { resolveMigrationsFolder } from '@/platform/persistence/migration/migrationsFolder'",
      "import { openDb } from '@/db/client'",
      "import { runBackup } from '@/services/backup'",
    ])
      expect(FORBIDDEN_CLI_MECHANISMS.test(fabricated), fabricated).toBe(true)
    for (const legitimate of [
      "import type { RequestBackupCommand } from '@/modules/system-operations/public/commands'",
      "import { isProcessAlive } from '@/platform/execution/local/process'",
    ])
      expect(FORBIDDEN_CLI_MECHANISMS.test(legitimate), legitimate).toBe(false)
  })

  // RFC-427: bootstrap composes the local system operations; the CLI root hands them to the handlers.
  test('bootstrap composes local system operations and the CLI root injects both adapters', () => {
    const source = readFileSync(join(SOURCE_ROOT, 'main.ts'), 'utf8')
    const bootstraps = readFileSync(join(SOURCE_ROOT, 'bootstrap/commandBootstraps.ts'), 'utf8')
    expect(bootstraps).toContain("from '@/modules/system-operations/composition'")
    const composeBackup = bootstraps
      .split('export async function composeBackupCommandOperations()')[1]!
      .split('\nexport ')[0]!
    const composeRestore = bootstraps
      .split('export function composeRestoreCommandOperations()')[1]!
      .split('\nexport ')[0]!
    expect(composeBackup).toContain('const provider = await resolveCommandProvider()')
    expect(composeBackup.replace(/\s+/g, '')).toContain(
      'composeLocalSystemOperations({repositoryBackupPreparationFactory:composeRepositoryBackupPreparation,contract:logicalSchemaContract,schemaHistory:persistenceSchemaBinding.history,providerRuntime:provider.runtime,databaseConfig:loadConfig(Paths.config).database,})',
    )
    expect(composeRestore.replace(/\s+/g, '')).toContain(
      'returncomposeLocalSystemOperations({repositoryBackupPreparationFactory:composeRepositoryBackupPreparation,contract,schemaHistory:persistenceSchemaBinding.history,providerRuntime,databaseConfig,})',
    )
    const backup = source.split("case 'backup': {")[1]!.split("case 'restore': {")[0]!
    const restore = source.split("case 'restore': {")[1]!.split("case '")[0]!
    expect(backup).toContain('const operations = await composeBackupCommandOperations()')
    expect(backup).toContain('backupCommand(Bun.argv.slice(3), operations)')
    expect(restore).toContain('const operations = composeRestoreCommandOperations()')
    expect(restore).toContain('restoreCommand(Bun.argv.slice(3), operations)')
    for (const command of [backup, restore])
      expect(command).toContain('await operations.shutdown()')
  })

  test('RFC-295 downgrade audit is retired from the command dispatch', () => {
    expect(readFileSync(join(CLI_ROOT, '../main.ts'), 'utf8')).not.toContain(
      'rfc295-downgrade-audit',
    )
  })
})
