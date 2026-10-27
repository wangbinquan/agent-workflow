import type { MigrationProgressCallback } from '@/platform/persistence/migration/run/progress'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import type { PostgresqlDatabaseRuntime } from '../../postgresqlRuntime'
import { canonicalSchemaJson, digestSchemaContract } from '../../schema/canonical'
import { readMigrationSourcePointer } from '../generationPointerSource'
import {
  openEpoch1SqliteSource,
  openEpoch1SqliteBackupSource,
  type Epoch1SqliteSource,
} from '../sqliteSourceReader'
import { openEpoch1PostgresqlSource } from '../postgresqlSourceReader'
import {
  openEpoch1LogicalArtifactSource,
  openEpoch1HostedBackupSource,
} from '../artifactSourceReader'
import { upgradeEpoch1Copy, type OfflinePostgresqlDatabase } from '../offlineSourceUpgrade'
import { composePostgresqlArchiveSource } from '../conversion/postgresqlArchiveSource'
import { resolvePostgresqlSourceArchive } from './postgresqlArchive'
import { openDispositionEvidenceSource } from '../conversion/generic/dispositionSource'
import {
  captureSourceDispositionRows,
  type SourceDispositionEvidence,
} from '../sourceDispositionEvidence'
import { readManifest } from '../legacy/backupManifest'
import { vacuumSqliteInto } from '../legacy/sqliteSnapshot'
import {
  logicalArtifactFileDigest,
  verifyLogicalArtifactManifest,
} from '../legacy/logicalDatabaseArtifact'
import { makeSourceFingerprint } from '../sourceCatalog'
import { sourceFilesDigest } from '../sourceReader'
import type { SupportedSourceManifest } from '../supportedSources'
import type { EmptyTableDecision } from '../sourceDispositions'
import type { SourcePreflight, VersionedSourceReader } from '../sourceTypes'
import type {
  EpochSourceLocation,
  FrozenSourceHandle,
  EpochSwitchArtifactPort,
  SourceArchiveInput,
} from '../run/types'
import { captureLiveSqliteSnapshot, pinnedSnapshotReader } from './liveSnapshot'
import { migrationPostgresqlRuntime, preparePostgresqlScratch } from './postgresqlDatabases'
import {
  atomicSourceFile,
  materializedSourceDirectory,
  persistSourceDirectory,
  sourceArtifactRoot,
  syncSourceDirectory,
} from './artifacts'

export interface SourceAccessInput {
  readonly progress?: MigrationProgressCallback
  /** Stable across new runs of the same operation; never across operations. */
  readonly scratchOwner?: string
  readonly location: EpochSourceLocation
  readonly manifest: SupportedSourceManifest
  readonly operationRoot: string
  readonly emptyTables: readonly EmptyTableDecision[]
  readonly artifacts?: EpochSwitchArtifactPort
  /** Installation-bound RFC-349 history, resolved afresh for each snapshot. */
  readonly postgresqlArchive?: (source: FrozenSourceHandle) => Promise<SourceArchiveInput>
  /** The returned runtime is borrowed; bootstrap owns its pool lifetime. */
  readonly postgresql?: () => PostgresqlDatabaseRuntime
  readonly createScratchPostgresql?: () => Promise<OfflinePostgresqlDatabase>
  readonly reopenScratchPostgresql?: () => Promise<OfflinePostgresqlDatabase>
}
export interface SourceExpected {
  readonly watermark: string
  readonly preUpgradeWatermark: string | null
  readonly sourceGenerationId: string
}
export interface FrozenSourceDetails {
  readonly location: EpochSourceLocation
  readonly originalReader: VersionedSourceReader
  readonly originalPreflight: SourcePreflight
  readonly sqlitePath: string | null
  readonly immutableDigest: string | null
  readonly databaseFingerprint: string | null
  readonly mode: 'live' | 'frozen'
  readonly operationRoot: string
}
const details = new WeakMap<FrozenSourceHandle, FrozenSourceDetails>()
const activeRoots = new Set<string>()
export function frozenSourceDetails(source: FrozenSourceHandle): FrozenSourceDetails {
  const value = details.get(source)
  if (!value) throw new Error('frozen-source-handle-not-owned')
  return value
}

export function openBackupSource(input: {
  readonly location: Extract<EpochSourceLocation, { kind: 'backup' }>
  readonly manifest: SupportedSourceManifest
  readonly operationRoot: string
  readonly emptyTables: readonly EmptyTableDecision[]
}): VersionedSourceReader {
  const { location, manifest } = input
  if (location.sourceKind === 'sqlite-backup')
    return openEpoch1SqliteBackupSource({
      backupRoot: location.root,
      manifest,
      operationRoot: input.operationRoot,
      emptyTables: input.emptyTables,
    })
  if (location.sourceKind === 'hosted-backup')
    return openEpoch1HostedBackupSource({ backupRoot: location.root, supportedSources: manifest })
  if (location.sourceKind === 'logical-backup') {
    const backup = readManifest(location.root)
    if (backup?.manifestVersion !== 2) throw new Error('old-epoch-logical-manifest-required')
    return openEpoch1LogicalArtifactSource({
      artifactRoot: join(location.root, backup.database.logicalPath),
      backupRoot: location.root,
      envelopeFileDigest: backup.database.envelopeFileDigest,
      supportedSources: manifest,
    })
  }
  if (existsSync(join(location.root, 'logical-backup.json')))
    return openEpoch1LogicalArtifactSource({
      artifactRoot: location.root,
      envelopeFileDigest: logicalArtifactFileDigest(join(location.root, 'logical-backup.json')),
      supportedSources: manifest,
    })
  const artifact = verifyLogicalArtifactManifest(
    JSON.parse(readFileSync(join(location.root, 'logical-manifest.json'), 'utf8')),
  )
  return openEpoch1LogicalArtifactSource({
    artifactRoot: location.root,
    manifestDigest: artifact.digest,
    legacyArchiveFileDigest: logicalArtifactFileDigest(
      join(location.root, 'legacy-archive/manifest.json'),
    ),
    supportedSources: manifest,
  })
}

interface UpgradeBinding {
  readonly originalWatermark: string
  readonly generationId: string
  readonly directory: string
  readonly sqlitePath: string | null
  readonly currentWatermark: string
  readonly bindingDigest: string
  readonly scratchFingerprint: string | null
  readonly frozen: boolean
}

async function access(
  input: SourceAccessInput,
  mode: 'live' | 'frozen',
  expected?: SourceExpected,
): Promise<FrozenSourceHandle> {
  const workRoot = resolve(input.operationRoot, 'source-access')
  if (activeRoots.has(workRoot)) throw new Error('source-access-already-open')
  activeRoots.add(workRoot)
  const releases: (() => void | Promise<void>)[] = []
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try {
      let failure: unknown
      for (const release of releases.reverse())
        try {
          await release()
        } catch (error) {
          failure ??= error
        }
      if (failure) throw failure
    } finally {
      activeRoots.delete(workRoot)
    }
  }
  try {
    input.progress?.({ phase: 'freeze', detail: `${mode} source snapshot`, boundary: true })
    mkdirSync(workRoot, { recursive: true })
    // S holds the operation lock for discover/run/trace. These are disposable copies.
    for (const directory of [
      workRoot,
      join(input.operationRoot, 'discovery/source-access'),
      join(input.operationRoot, 'frozen/source-access'),
    ]) {
      if (!existsSync(directory)) continue
      for (const entry of readdirSync(directory, { withFileTypes: true }))
        if (
          (entry.isDirectory() &&
            [
              'epoch1-source-',
              'plan-snapshot-',
              'epoch1-upgrade-',
              'epoch1-pg-upgrade-',
              'conversion-',
            ].some((prefix) => entry.name.startsWith(prefix))) ||
          entry.name.endsWith('.tmp')
        )
          rmSync(join(directory, entry.name), { recursive: true, force: true })
    }
    let original: VersionedSourceReader
    let pointerBytes: string | null = null
    let databaseFingerprint: string | null = null
    let sqlite: Epoch1SqliteSource | null = null
    if (input.location.kind === 'sqlite-file') {
      const pointer = readMigrationSourcePointer(input.location.pointerPath)
      pointerBytes = pointer.bytes ? Buffer.from(pointer.bytes).toString('base64') : null
      if (pointer.pointer && pointer.pointer.payload.version !== 1)
        throw new Error('source-epoch-not-one')
      const snapshot =
        mode === 'live'
          ? captureLiveSqliteSnapshot({ ...input.location, operationRoot: workRoot })
          : null
      if (snapshot) releases.push(snapshot.close)
      sqlite = openEpoch1SqliteSource({
        path: snapshot?.path ?? input.location.path,
        manifest: input.manifest,
        operationRoot: workRoot,
        emptyTables: input.emptyTables,
        ...(!pointer.bytes ? { sourceGenerationId: 'dbg_legacy_sqlite' } : {}),
        ...(snapshot?.pointerPath
          ? { generationPointerPath: snapshot.pointerPath }
          : mode === 'frozen' && pointer.bytes
            ? { generationPointerPath: input.location.pointerPath }
            : {}),
      })
      original = sqlite
    } else if (input.location.kind === 'postgresql-database') {
      if (!input.postgresql) throw new Error('postgresql-source-runtime-required')
      const runtime = migrationPostgresqlRuntime(input.postgresql())
      databaseFingerprint = (await runtime.readiness()).databaseFingerprint
      original = openEpoch1PostgresqlSource({
        runtime,
        manifest: input.manifest,
        contentRoot: input.operationRoot,
        emptyTables: input.emptyTables,
      })
    } else {
      original = openBackupSource({ ...input, location: input.location, operationRoot: workRoot })
      if (input.location.sourceKind === 'sqlite-backup') sqlite = original as Epoch1SqliteSource
    }
    releases.push(() => original.close())
    let originalPreflight = await original.preflight()
    if (mode === 'live' && input.location.kind === 'postgresql-database')
      original = pinnedSnapshotReader(original, originalPreflight)
    const immutableDigest =
      input.location.kind === 'backup' ? await sourceFilesDigest(input.location.root) : null
    if (immutableDigest) {
      const underlying = original
      const physical = originalPreflight
      originalPreflight = { ...physical, watermark: immutableDigest }
      original = {
        ...pinnedSnapshotReader(underlying, originalPreflight),
        async assertUnchanged(value) {
          if (value.watermark !== immutableDigest)
            throw new Error('source-changed: backup binding differs')
          await underlying.assertUnchanged(physical)
        },
      }
    }
    const originalReader = original
    const sourcePath = sqlite?.offlinePath() ?? null
    let reader = original
    let evidenceRoot: string | null = null
    let preUpgrade: FrozenSourceHandle['preUpgrade'] = null
    const pendingScratch =
      originalPreflight.requiresOfflineUpgrade &&
      !sqlite &&
      !input.createScratchPostgresql &&
      !input.reopenScratchPostgresql
    if (pendingScratch && mode === 'frozen')
      throw new Error('postgresql-scratch-required: offline upgrade needs a scratch database')
    // Live discovery returns the original preflight so S can render the scratch block first.
    if (originalPreflight.requiresOfflineUpgrade && !pendingScratch) {
      input.progress?.({
        phase: 'offline-upgrade',
        detail: 'prepare or reuse offline copy',
        boundary: true,
      })
      if (expected && expected.preUpgradeWatermark !== originalPreflight.watermark)
        throw new Error('source-changed: pre-upgrade source differs from the previous run')
      const artifactName = 'source-access/upgrade'
      const cacheRoot = input.artifacts
        ? ((await materializedSourceDirectory(input.artifacts, artifactName)) ??
          join(await sourceArtifactRoot(input.artifacts, artifactName), 'payload'))
        : join(workRoot, 'upgrade')
      mkdirSync(cacheRoot, { recursive: true })
      const persist = async () => {
        if (input.artifacts) await persistSourceDirectory(input.artifacts, artifactName, cacheRoot)
      }
      const ownerPath = join(cacheRoot, 'owner.json')
      if (!existsSync(ownerPath)) {
        await atomicSourceFile(
          ownerPath,
          canonicalSchemaJson({ owner: input.scratchOwner ?? crypto.randomUUID() }),
        )
        await persist()
      }
      const { owner } = JSON.parse(readFileSync(ownerPath, 'utf8')) as { owner: string }
      if (input.scratchOwner && owner !== input.scratchOwner)
        throw new Error('postgresql-scratch-owned-by-another-operation')
      const bindingDigest = digestSchemaContract({
        watermark: originalPreflight.watermark,
        decisions: input.emptyTables,
        head: input.manifest.headDigest,
      })
      const bindingPath = join(cacheRoot, 'binding.json')
      let prior: UpgradeBinding | null = null
      if (existsSync(bindingPath)) {
        try {
          prior = JSON.parse(readFileSync(bindingPath, 'utf8')) as UpgradeBinding
        } catch {
          if (expected) throw new Error('source-changed: frozen upgrade binding is incomplete')
        }
      }
      for (const entry of readdirSync(cacheRoot, { withFileTypes: true }))
        if (
          (entry.isDirectory() &&
            entry.name.startsWith('copy-') &&
            entry.name !== prior?.directory &&
            !existsSync(join(cacheRoot, entry.name, '.retained'))) ||
          entry.name.endsWith('.tmp')
        )
          rmSync(join(cacheRoot, entry.name), { recursive: true, force: true })
      let binding: UpgradeBinding
      if (prior?.bindingDigest === bindingDigest) {
        binding = prior
        if (
          binding.originalWatermark !== originalPreflight.watermark ||
          binding.generationId !== originalPreflight.sourceGenerationId
        )
          throw new Error('source-changed: upgrade binding differs')
        if (binding.sqlitePath) {
          reader = openEpoch1SqliteSource({
            path: join(cacheRoot, binding.sqlitePath),
            manifest: input.manifest,
            operationRoot: workRoot,
            emptyTables: input.emptyTables,
            sourceGenerationId: binding.generationId,
          })
          const reopened = reader
          releases.push(() => reopened.close())
        } else {
          if (!input.reopenScratchPostgresql) throw new Error('postgresql-scratch-reopen-required')
          const scratch = await input.reopenScratchPostgresql()
          releases.push(() => scratch.close())
          const runtime = migrationPostgresqlRuntime(scratch.runtime)
          const fingerprint = await preparePostgresqlScratch({
            runtime,
            owner,
            bindingDigest,
            sourceFingerprint: databaseFingerprint,
            reset: false,
          })
          if (fingerprint !== binding.scratchFingerprint)
            throw new Error('source-changed: scratch database differs')
          reader = openEpoch1PostgresqlSource({
            runtime,
            manifest: input.manifest,
            sourceGenerationId: binding.generationId,
            contentRoot: join(cacheRoot, binding.directory),
          })
          const reopened = reader
          releases.push(() => reopened.close())
        }
        if ((await reader.preflight()).watermark !== binding.currentWatermark)
          throw new Error('source-changed: retained upgrade differs')
        if (mode === 'frozen' && !binding.frozen) {
          binding = { ...binding, frozen: true }
          await atomicSourceFile(bindingPath, canonicalSchemaJson(binding))
          await persist()
        }
      } else {
        if (prior) {
          if (prior.frozen)
            await atomicSourceFile(join(cacheRoot, prior.directory, '.retained'), '')
          else rmSync(join(cacheRoot, prior.directory), { recursive: true, force: true })
          rmSync(bindingPath, { force: true })
        }
        const directoryName = `copy-${crypto.randomUUID()}`
        const directory = join(cacheRoot, directoryName)
        mkdirSync(directory)
        await captureSourceDispositionRows(
          original,
          originalPreflight,
          join(directory, 'pre-upgrade'),
        )
        let sqlitePath: string | null = null
        let scratchFingerprint: string | null = null
        if (sqlite) {
          const upgraded = await upgradeEpoch1Copy({
            progress: input.progress,
            source: sqlite,
            expected: await sqlite.preflight(),
            manifest: input.manifest,
            operationRoot: workRoot,
            emptyTables: input.emptyTables,
          })
          try {
            sqlitePath = join(directoryName, 'current.sqlite')
            vacuumSqliteInto({ dbPath: upgraded.path, dest: join(cacheRoot, sqlitePath) })
          } finally {
            await upgraded.close()
          }
          reader = openEpoch1SqliteSource({
            path: join(cacheRoot, sqlitePath),
            manifest: input.manifest,
            operationRoot: workRoot,
            emptyTables: input.emptyTables,
            sourceGenerationId: originalPreflight.sourceGenerationId,
          })
          const upgradedReader = reader
          releases.push(() => upgradedReader.close())
        } else {
          const openScratch = input.reopenScratchPostgresql ?? input.createScratchPostgresql!
          const upgraded = await upgradeEpoch1Copy({
            progress: input.progress,
            source: original,
            manifest: input.manifest,
            operationRoot: workRoot,
            async createEmptyDatabase() {
              const scratch = await openScratch()
              const runtime = migrationPostgresqlRuntime(scratch.runtime)
              try {
                scratchFingerprint = await preparePostgresqlScratch({
                  runtime,
                  owner,
                  bindingDigest,
                  sourceFingerprint: databaseFingerprint,
                  reset: true,
                })
                return { runtime, close: () => scratch.close() }
              } catch (error) {
                await scratch.close()
                throw error
              }
            },
          })
          releases.push(() => upgraded.close())
          reader = upgraded.reader
        }
        await syncSourceDirectory(directory)
        binding = {
          originalWatermark: originalPreflight.watermark,
          generationId: originalPreflight.sourceGenerationId,
          directory: directoryName,
          sqlitePath,
          currentWatermark: (await reader.preflight()).watermark,
          bindingDigest,
          scratchFingerprint,
          frozen: mode === 'frozen',
        }
        await atomicSourceFile(bindingPath, canonicalSchemaJson(binding))
        await persist()
      }
      evidenceRoot = join(cacheRoot, binding.directory, 'pre-upgrade')
      const dispositionPath = join(evidenceRoot, 'dispositions.json')
      const oldText = readFileSync(dispositionPath, 'utf8')
      const entries = JSON.parse(oldText) as readonly SourceDispositionEvidence[]
      const relocated = canonicalSchemaJson(
        entries.map((entry) => ({
          ...entry,
          chunks: entry.chunks.map((chunk) => ({
            ...chunk,
            path: join(evidenceRoot!, basename(chunk.path)),
          })),
        })),
      )
      if (relocated !== oldText) {
        await atomicSourceFile(dispositionPath, relocated)
        await persist()
      }
      const evidence = openDispositionEvidenceSource(evidenceRoot)
      releases.push(() => evidence.close())
      preUpgrade = { reader: evidence, preflight: await evidence.preflight() }
      input.progress?.({ phase: 'offline-upgrade', detail: 'complete', boundary: true })
    }
    const physicalCurrent = await reader.preflight()
    const current: SourcePreflight = {
      ...physicalCurrent,
      kind: originalPreflight.kind,
      fingerprint:
        physicalCurrent.fingerprint.provider === originalPreflight.fingerprint.provider
          ? physicalCurrent.fingerprint
          : makeSourceFingerprint(
              originalPreflight.fingerprint.provider,
              physicalCurrent.fingerprint.catalog,
              physicalCurrent.fingerprint.journal,
              physicalCurrent.fingerprint.tableRows,
              originalPreflight.fingerprint.evidence,
            ),
    }
    const assertUnchanged = async (value: SourcePreflight) => {
      if (mode === 'frozen' && input.location.kind === 'sqlite-file') {
        const bytes = readMigrationSourcePointer(input.location.pointerPath).bytes
        if ((bytes ? Buffer.from(bytes).toString('base64') : null) !== pointerBytes)
          throw new Error('source-changed: source pointer differs')
      }
      if (canonicalSchemaJson(value) !== canonicalSchemaJson(current))
        throw new Error('source-changed: source binding differs')
      await originalReader.assertUnchanged(originalPreflight)
      if (reader !== originalReader) await reader.assertUnchanged(physicalCurrent)
      if (preUpgrade) await preUpgrade.reader.assertUnchanged(preUpgrade.preflight)
    }
    await assertUnchanged(current)
    let handle: FrozenSourceHandle = {
      reader: {
        ...reader,
        kind: current.kind,
        preflight: async () => {
          await assertUnchanged(current)
          return current
        },
        assertUnchanged,
      },
      preflight: current,
      preUpgrade,
      watermark: current.watermark,
      evidenceRoot,
      close,
    }
    details.set(handle, {
      location: input.location,
      originalReader,
      originalPreflight,
      sqlitePath: sourcePath,
      immutableDigest,
      databaseFingerprint,
      mode,
      operationRoot: workRoot,
    })
    if (input.location.kind === 'postgresql-database' && input.postgresqlArchive) {
      const physicalHandle = handle
      const physicalDetails = frozenSourceDetails(physicalHandle)
      const archiveInput = await input.postgresqlArchive(physicalHandle)
      await resolvePostgresqlSourceArchive(physicalDetails, archiveInput)
      if (archiveInput.kind === 'retained-epoch1-archive') {
        const manifest = verifyLogicalArtifactManifest(
          JSON.parse(readFileSync(join(archiveInput.path, 'logical-manifest.json'), 'utf8')),
        )
        const archive = openEpoch1LogicalArtifactSource({
          artifactRoot: archiveInput.path,
          manifestDigest: manifest.digest,
          legacyArchiveFileDigest: archiveInput.digest,
          supportedSources: input.manifest,
        })
        releases.push(() => archive.close())
        // Compose after the physical offline upgrade. Backup/export and scratch
        // binding retain the original physical reader and its row census.
        const composed = await composePostgresqlArchiveSource({ source: handle.reader, archive })
        const preflight = await composed.preflight()
        handle = { ...handle, reader: composed, preflight, watermark: preflight.watermark }
        details.set(handle, physicalDetails)
      }
    }
    if (
      expected &&
      (handle.watermark !== expected.watermark ||
        (preUpgrade?.preflight.watermark ?? null) !== expected.preUpgradeWatermark ||
        handle.preflight.sourceGenerationId !== expected.sourceGenerationId)
    )
      throw new Error('source-changed: frozen source differs from the previous run')
    const preflightPath = join(
      workRoot,
      `preflight-${digestSchemaContract({ current: handle.preflight, preUpgrade: preUpgrade?.preflight ?? null }).slice(7)}.json`,
    )
    if (!existsSync(preflightPath))
      await atomicSourceFile(
        preflightPath,
        canonicalSchemaJson({
          current: handle.preflight,
          preUpgrade: preUpgrade?.preflight ?? null,
        }),
      )
    input.progress?.({ phase: 'freeze', detail: 'source ready', boundary: true })
    return handle
  } catch (error) {
    await close()
    throw error
  }
}

export function openLiveSnapshotSource(input: SourceAccessInput): Promise<FrozenSourceHandle> {
  return access(input, 'live')
}
export function openFrozenSource(
  input: SourceAccessInput & { readonly expected?: SourceExpected },
): Promise<FrozenSourceHandle> {
  return access(input, 'frozen', input.expected)
}
