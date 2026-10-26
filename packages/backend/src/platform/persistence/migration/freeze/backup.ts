import { Database } from 'bun:sqlite'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { canonicalSchemaJson, digestSchemaContract } from '../../schema/canonical'
import { vacuumSqliteInto, quickCheckSqlite } from '../legacy/sqliteSnapshot'
import { readDbMigrationIdentity, writeManifest } from '../legacy/backupManifest'
import { exportEpoch1PostgresqlSource } from '../postgresqlSourceExport'
import { sourceFilesDigest } from '../sourceReader'
import { sqliteContentDigest } from '../rawSourceReader'
import type {
  FreezeContentManifest,
  FrozenSourceHandle,
  SwitchBackupReceipt,
  SourceArchiveInput,
  EpochSwitchArtifactPort,
} from '../run/types'
import { resolvePostgresqlSourceArchive, type PostgresqlBackupArchive } from './postgresqlArchive'
import { frozenSourceDetails } from './sourceAccess'
import { assertDiskBudget } from './diskBudget'
import {
  atomicSourceFile,
  persistSourceDirectory,
  materializedSourceDirectory,
  syncSourceDirectory,
} from './artifacts'

export type { PostgresqlBackupArchive } from './postgresqlArchive'
export function resolvePostgresqlBackupArchive(
  source: FrozenSourceHandle,
  archive: SourceArchiveInput,
): Promise<PostgresqlBackupArchive> {
  return resolvePostgresqlSourceArchive(frozenSourceDetails(source), archive)
}

export async function persistSwitchBackup(
  receipt: SwitchBackupReceipt,
  artifacts?: EpochSwitchArtifactPort,
): Promise<SwitchBackupReceipt> {
  if (artifacts && receipt.path && receipt.kind !== 'platform-retained')
    await persistSourceDirectory(artifacts, `switch-backups/${receipt.id}`, receipt.path)
  return receipt
}
export async function materializeSwitchBackup(
  receipt: SwitchBackupReceipt,
  artifacts: EpochSwitchArtifactPort,
): Promise<SwitchBackupReceipt> {
  if (receipt.kind === 'platform-retained') return receipt
  const path = await materializedSourceDirectory(artifacts, `switch-backups/${receipt.id}`)
  if (!path || (await sourceFilesDigest(path)) !== receipt.digest)
    throw new Error('switch-backup-artifact-mismatch')
  return { ...receipt, path }
}

function copyBackupContent(root: string, manifest: FreezeContentManifest | null): void {
  if (!manifest) return
  writeFileSync(join(root, 'content-manifest.json'), canonicalSchemaJson(manifest))
  const home = manifest.roots[0]
  if (!home) return
  for (const name of ['skills', 'config.json']) {
    const path = join(home, name)
    if (existsSync(path))
      cpSync(path, join(root, name), { recursive: true, preserveTimestamps: true })
  }
  const listed = new Map(manifest.files.map((entry) => [entry.path, entry]))
  const verify = (relative: string) => {
    const destination = join(root, relative)
    if (statSync(destination).isDirectory()) {
      for (const name of readdirSync(destination)) verify(`${relative}/${name}`)
      return
    }
    const entry = listed.get(relative)
    if (!entry) throw new Error('switch-backup-content-unlisted')
    const source = join(home, relative)
    const info = statSync(source)
    if (
      info.size !== entry.size ||
      Math.trunc(info.mtimeMs) !== entry.mtimeMs ||
      !readFileSync(source).equals(readFileSync(destination))
    )
      throw new Error('switch-backup-content-changed')
  }
  for (const name of ['skills', 'config.json']) if (existsSync(join(root, name))) verify(name)
  for (const entry of manifest.files.filter(
    (entry) => entry.path.startsWith('skills/') || entry.path === 'config.json',
  ))
    if (!existsSync(join(root, entry.path))) throw new Error('switch-backup-content-missing')
}

async function createBackup(input: {
  readonly destination: string
  readonly source: FrozenSourceHandle
  readonly kind: 'sqlite-vacuum' | 'postgresql-logical'
  readonly contentManifest: FreezeContentManifest | null
  write(path: string, createdAt: number): Promise<void>
}): Promise<SwitchBackupReceipt> {
  mkdirSync(input.destination, { recursive: true })
  for (const entry of readdirSync(input.destination, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const receiptPath = join(input.destination, entry.name, 'switch-backup.json')
    if (!existsSync(receiptPath)) {
      if (entry.name.startsWith('switch-'))
        rmSync(join(input.destination, entry.name), { recursive: true, force: true })
      continue
    }
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as SwitchBackupReceipt
    if (
      receipt.kind === input.kind &&
      receipt.contentManifestDigest === (input.contentManifest?.digest ?? null) &&
      (await switchBackupMatches(receipt, input.source.watermark))
    )
      return receipt
  }
  const directory = mkdtempSync(join(input.destination, 'switch-'))
  const path = join(directory, 'payload')
  mkdirSync(path)
  const createdAt = Date.now()
  await input.source.reader.assertUnchanged(input.source.preflight)
  await input.write(path, createdAt)
  copyBackupContent(path, input.contentManifest)
  await input.source.reader.assertUnchanged(input.source.preflight)
  await syncSourceDirectory(path)
  const digest = await sourceFilesDigest(path)
  const receipt: SwitchBackupReceipt = {
    version: 1,
    id: `dbb_e2_${digest.slice(7, 39)}`,
    kind: input.kind,
    path,
    digest,
    sourceWatermark: input.source.watermark,
    contentManifestDigest: input.contentManifest?.digest ?? null,
    createdAt,
  }
  await atomicSourceFile(join(directory, 'switch-backup.json'), canonicalSchemaJson(receipt))
  return receipt
}

interface FileBackupInput {
  readonly sourcePath: string
  readonly destination: string
  readonly frozen: FrozenSourceHandle
  readonly contentManifest: FreezeContentManifest | null
}
function createFileBackup(input: FileBackupInput): Promise<SwitchBackupReceipt> {
  return createBackup({
    ...input,
    source: input.frozen,
    kind: 'sqlite-vacuum',
    async write(path, createdAt) {
      const sourceBytes =
        statSync(input.sourcePath).size +
        (existsSync(`${input.sourcePath}-wal`) ? statSync(`${input.sourcePath}-wal`).size : 0)
      assertDiskBudget({ path, requiredBytes: sourceBytes })
      const target = join(path, 'db.sqlite')
      vacuumSqliteInto({ dbPath: input.sourcePath, dest: target })
      quickCheckSqlite({ dbPath: target })
      const original = frozenSourceDetails(input.frozen).sqlitePath
      if (!original) throw new Error('switch-backup-sqlite-source-required')
      const expectedDatabase = new Database(original, { readonly: true })
      const backupDatabase = new Database(target, { readonly: true })
      try {
        if (sqliteContentDigest(expectedDatabase) !== sqliteContentDigest(backupDatabase))
          throw new Error('switch-backup-source-differs')
      } finally {
        expectedDatabase.close()
        backupDatabase.close()
      }
      const migration = readDbMigrationIdentity(target)
      if (!migration) throw new Error('switch-backup-migration-identity-unavailable')
      writeManifest(path, {
        manifestVersion: 1,
        kind: 'pre-migration',
        createdAt,
        appVersion: 'rfc395-epoch-switch',
        includesWorktrees: false,
        migration,
      })
    },
  })
}

interface LogicalBackupInput {
  readonly source: FrozenSourceHandle
  readonly destination: string
  readonly operationId: string
  readonly chunkRows: number
  readonly contentManifest?: FreezeContentManifest | null
  readonly archive?: PostgresqlBackupArchive
}
export function createSwitchBackup(
  input: FileBackupInput | LogicalBackupInput,
): Promise<SwitchBackupReceipt> {
  if ('sourcePath' in input) return createFileBackup(input)
  const details = frozenSourceDetails(input.source)
  return createBackup({
    ...input,
    contentManifest: input.contentManifest ?? null,
    kind: 'postgresql-logical',
    async write(path, createdAt) {
      const receipt = await exportEpoch1PostgresqlSource({
        source: details.originalReader,
        artifactRoot: join(path, 'database/logical'),
        operationId: input.operationId,
        chunkRows: input.chunkRows,
        ...input.archive,
      })
      writeManifest(path, {
        manifestVersion: 2,
        kind: 'pre-migration',
        createdAt,
        appVersion: 'rfc395-epoch-switch',
        includesWorktrees: false,
        migration: { lastHash: null, lastCreatedAt: null },
        database: {
          format: 'agent-workflow-logical-database-v1',
          provider: 'postgresql',
          sourceGenerationId: details.originalPreflight.sourceGenerationId,
          schemaDigest: details.originalPreflight.contract!.digest,
          logicalPath: 'database/logical',
          envelopeFileDigest: receipt.envelopeFileDigest,
          rawSqlitePath: null,
        },
      })
    },
  })
}

export async function immutableSourceBackup(
  source: FrozenSourceHandle,
  contentManifest: FreezeContentManifest | null,
): Promise<SwitchBackupReceipt> {
  const details = frozenSourceDetails(source)
  if (details.location.kind !== 'backup' || !details.immutableDigest)
    throw new Error('immutable-backup-source-required')
  await source.reader.assertUnchanged(source.preflight)
  return {
    version: 1,
    id: `dbb_e2_${details.immutableDigest.slice(7, 39)}`,
    kind: 'immutable-backup-source',
    path: details.location.root,
    digest: details.immutableDigest,
    sourceWatermark: source.watermark,
    contentManifestDigest: contentManifest?.digest ?? null,
    createdAt: Date.now(),
  }
}

export async function switchBackupMatches(
  receipt: SwitchBackupReceipt,
  frozenWatermark: string,
): Promise<boolean> {
  if (receipt.version !== 1 || receipt.sourceWatermark !== frozenWatermark) return false
  if (receipt.kind === 'platform-retained') return false
  if (!receipt.path || !existsSync(receipt.path)) return false
  return (await sourceFilesDigest(receipt.path)) === receipt.digest
}

export function platformRetainedBackup(input: {
  readonly id: string
  readonly frozenWatermark: string
  readonly retentionDigest: string
  readonly contentManifestDigest: string | null
  readonly createdAt: number
}): SwitchBackupReceipt {
  return {
    version: 1,
    id: input.id,
    kind: 'platform-retained',
    path: null,
    digest: digestSchemaContract({
      retentionDigest: input.retentionDigest,
      watermark: input.frozenWatermark,
      contentManifestDigest: input.contentManifestDigest,
    }),
    sourceWatermark: input.frozenWatermark,
    contentManifestDigest: input.contentManifestDigest,
    createdAt: input.createdAt,
  }
}
