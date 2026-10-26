import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, basename } from 'node:path'
import { extractTarGz } from '@/util/archive'
import { readManifest } from '../legacy/backupManifest'
import {
  logicalArtifactFileDigest,
  verifyLogicalArtifactManifest,
} from '../legacy/logicalDatabaseArtifact'
import { readLogicalDatabaseBackupEnvelope } from '../legacy/logicalDatabaseExport'
import { sourceFilesDigest } from '../sourceReader'
import {
  atomicSourceFile,
  persistSourceDirectory,
  materializedSourceDirectory,
  syncSourceDirectory,
} from './artifacts'
import type { EpochSourceLocation, EpochSwitchArtifactPort } from '../run/types'

export type OldEpochBackup = {
  readonly sourceKind: Extract<EpochSourceLocation, { kind: 'backup' }>['sourceKind']
  readonly root: string
  readonly digest: string
  readonly runsSupplied: boolean
}

export function detectOldEpochBackup(root: string): OldEpochBackup['sourceKind'] {
  if (existsSync(join(root, 'hosted-backup.json'))) {
    const header = JSON.parse(readFileSync(join(root, 'hosted-backup.json'), 'utf8')) as {
      format?: string
    }
    if (header.format !== 'aw-hosted-database-backup-v2')
      throw new Error('old-epoch-hosted-format-unsupported')
    const logical = join(root, 'database/logical')
    readLogicalDatabaseBackupEnvelope({
      artifactRoot: logical,
      expectedFileDigest: logicalArtifactFileDigest(join(logical, 'logical-backup.json')),
    })
    return 'hosted-backup'
  }
  const manifest = readManifest(root)
  if (manifest) {
    if (manifest.manifestVersion === 1 || manifest.database.rawSqlitePath === 'db.sqlite') {
      if (!existsSync(join(root, 'db.sqlite'))) throw new Error('old-epoch-sqlite-file-missing')
      return 'sqlite-backup'
    }
    readLogicalDatabaseBackupEnvelope({
      artifactRoot: join(root, manifest.database.logicalPath),
      expectedFileDigest: manifest.database.envelopeFileDigest,
    })
    return 'logical-backup'
  }
  if (existsSync(join(root, 'logical-backup.json'))) {
    readLogicalDatabaseBackupEnvelope({
      artifactRoot: root,
      expectedFileDigest: logicalArtifactFileDigest(join(root, 'logical-backup.json')),
    })
    return 'logical-artifact'
  }
  if (existsSync(join(root, 'logical-manifest.json'))) {
    verifyLogicalArtifactManifest(
      JSON.parse(readFileSync(join(root, 'logical-manifest.json'), 'utf8')),
    )
    if (!existsSync(join(root, 'legacy-archive/manifest.json')))
      throw new Error('old-epoch-archive-missing')
    return 'logical-artifact'
  }
  if (!existsSync(join(root, 'manifest.json')) && existsSync(join(root, 'db.sqlite')))
    return 'sqlite-backup'
  throw new Error('old-epoch-backup-unrecognized')
}

export async function unpackOldEpochBackup(input: {
  readonly artifact: string
  readonly destination: string
  readonly artifacts?: EpochSwitchArtifactPort
}): Promise<OldEpochBackup> {
  mkdirSync(input.destination, { recursive: true })
  for (const name of readdirSync(input.destination)) {
    if (!/^old-epoch-.*\.pending$/.test(name)) continue
    rmSync(join(input.destination, name.slice(0, -8)), { recursive: true, force: true })
    rmSync(join(input.destination, name))
  }
  const directory = mkdtempSync(join(input.destination, 'old-epoch-'))
  const pending = join(input.destination, `${basename(directory)}.pending`)
  writeFileSync(pending, '')
  try {
    const isDirectory = statSync(input.artifact).isDirectory()
    const before = isDirectory
      ? await sourceFilesDigest(input.artifact)
      : logicalArtifactFileDigest(input.artifact)
    if (isDirectory)
      cpSync(input.artifact, directory, { recursive: true, preserveTimestamps: true })
    else await extractTarGz(input.artifact, directory)
    const copiedDigest = isDirectory ? await sourceFilesDigest(directory) : null
    let root = directory
    const entries = readdirSync(root, { withFileTypes: true })
    if (entries.length === 1 && entries[0]!.isDirectory()) root = join(root, entries[0]!.name)
    const sourceKind = detectOldEpochBackup(root)
    const digest = await sourceFilesDigest(root)
    const after = isDirectory
      ? await sourceFilesDigest(input.artifact)
      : logicalArtifactFileDigest(input.artifact)
    if (before !== after || (isDirectory && before !== copiedDigest))
      throw new Error('source-changed: backup changed during unpack')
    await syncSourceDirectory(root)
    if (input.artifacts)
      await persistSourceDirectory(input.artifacts, `old-epoch/${digest.slice(7)}`, root)
    await atomicSourceFile(
      join(input.destination, `${basename(directory)}.complete.json`),
      JSON.stringify({ sourceKind, digest }),
    )
    rmSync(pending)
    return {
      sourceKind,
      root,
      digest,
      runsSupplied: existsSync(join(root, 'runs')) && statSync(join(root, 'runs')).isDirectory(),
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    rmSync(pending, { force: true })
    throw error
  }
}

export async function materializeOldEpochBackup(input: {
  readonly digest: string
  readonly artifacts: EpochSwitchArtifactPort
}): Promise<OldEpochBackup> {
  const root = await materializedSourceDirectory(
    input.artifacts,
    `old-epoch/${input.digest.slice(7)}`,
  )
  if (!root || (await sourceFilesDigest(root)) !== input.digest)
    throw new Error('old-epoch-artifact-mismatch')
  return {
    root,
    digest: input.digest,
    sourceKind: detectOldEpochBackup(root),
    runsSupplied: existsSync(join(root, 'runs')) && statSync(join(root, 'runs')).isDirectory(),
  }
}
