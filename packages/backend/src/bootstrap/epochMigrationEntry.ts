import { createMigrationProgressReporter } from '@/platform/persistence/migration/run/progress'
import { writeSync } from 'node:fs'
import { recordedLiveLogicalContract } from '@/platform/persistence/schema/history/logicalHistory'
import { loadFrozenEpoch1History } from '@/platform/persistence/migration/epoch1/bundle'
import { RestoreDowngradeError } from '@/platform/persistence/sqlite/systemProviderRestore'
import { Database } from 'bun:sqlite'
// CLI/converter entry only. Daemon roots must never import this module.
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '@/config'
import { Paths } from '@/util/paths'
import { extractTarGz } from '@/util/archive'
import { readManifest } from '@/platform/persistence/sqlite/systemBackupManifest'
import { composeLocalEpochSwitch } from './epochMigration'
import { persistenceHead, persistencePostgresqlCatalogs } from './persistenceHead'
import { logicalSchemaContract } from './persistenceSchema'
import { settleEpochSwitchBeforePointerReplacement } from '@/modules/system-operations/composition/epochMigration'

export function composeEpochMigrationCommand() {
  const application = composeLocalEpochSwitch({
    appHome: Paths.root,
    progress: createMigrationProgressReporter((line) => {
      writeSync(2, line)
    }),
    config: loadConfig(Paths.config),
    env: process.env,
    head: persistenceHead(),
    catalogArtifacts: persistencePostgresqlCatalogs(),
    sourceBornOnPostgresql: process.env.AGENT_WORKFLOW_SOURCE_BORN_ON_POSTGRESQL === '1',
  })
  return {
    ...application,
    async restoreBackup(input: Parameters<typeof application.restoreBackup>[0]) {
      await settleEpochSwitchBeforePointerReplacement({ appHome: Paths.root, env: process.env })
      return application.restoreBackup(input)
    },
  }
}
/** Selection is made by the recorded logical contract, before any target is opened. */
export async function classifyRestoreArtifact(
  artifact: string,
  operation: 'restore' | 'stage' = 'restore',
): Promise<'epoch1' | 'epoch2'> {
  if (!existsSync(artifact)) throw new Error(`restore failed: no such file: ${artifact}`)
  const directory = statSync(artifact).isDirectory()
  const root = directory ? artifact : mkdtempSync(join(tmpdir(), 'aw-restore-contract-'))
  try {
    if (!directory) await extractTarGz(artifact, root)
    const manifest = readManifest(root)
    let digest: string | undefined =
      manifest?.manifestVersion === 2 ? manifest.database.schemaDigest : undefined
    if (!digest)
      for (const name of ['logical-backup.json', 'database/logical/logical-backup.json']) {
        if (existsSync(join(root, name))) {
          const value = JSON.parse(readFileSync(join(root, name), 'utf8')) as {
            payload: { schemaDigest: string }
          }
          digest = value.payload.schemaDigest
          break
        }
      }
    if (digest && (await recordedLiveLogicalContract(digest, logicalSchemaContract)))
      return 'epoch2'
    if (digest) {
      const legacy = await loadFrozenEpoch1History()
      if (legacy.postgresql.versions.some((version) => version.contract.digest === digest))
        return 'epoch1'
    }
    if (existsSync(join(root, 'db.sqlite'))) {
      const db = new Database(join(root, 'db.sqlite'), { readonly: true })
      try {
        if (db.query("SELECT 1 FROM sqlite_schema WHERE name='aw_meta_schema_history'").get()) {
          const receipt = db
            .query(
              'SELECT version, artifact_json FROM aw_meta_schema_history ORDER BY version DESC LIMIT 1',
            )
            .get() as { version: number; artifact_json: string } | null
          if (!receipt) throw new Error('restore-artifact-recorded-contract-missing')
          if (receipt.version > persistenceHead().contract.version)
            throw new RestoreDowngradeError(receipt.version, persistenceHead().contract.version)
          const artifact = JSON.parse(receipt.artifact_json) as {
            contract: { contract: { schemaEpoch?: number } }
          }
          if (artifact.contract.contract.schemaEpoch === 2 && !digest) return 'epoch2'
          if (artifact.contract.contract.schemaEpoch === 2)
            throw new Error(
              'restore refused: backup is NEWER than this binary or has an unsupported recorded epoch-2 contract; you cannot downgrade — upgrade the binary or pick an older backup',
            )
          throw new Error('restore-artifact-contract-unsupported')
        }
        // Released pre-contract SQLite backups carried obsolete logical digests.
        // Their frozen raw journal, including aliases, remains V1's authority.
        return 'epoch1'
      } finally {
        db.close()
      }
    }
    if (digest)
      throw new Error(
        `restore refused: backup is NEWER than this binary or has an unsupported recorded contract (${digest}); ` +
          'you cannot downgrade — upgrade the binary or pick an older backup',
      )
    // An archive with neither a recorded logical contract nor a SQLite file is
    // not an old-epoch backup. Preserve the operator's original refusal before
    // any conversion plan or pending restore can be created.
    throw new Error(`${operation} refused: backup contains no db.sqlite (not a backup tarball?)`)
  } finally {
    if (!directory) rmSync(root, { recursive: true, force: true })
  }
}
