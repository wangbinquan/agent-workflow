import type { MigrationProgressCallback } from '@/platform/persistence/migration/run/progress'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import type { PostgresqlDatabaseRuntime } from '../../postgresqlRuntime'
import { canonicalSchemaJson, digestSchemaContract } from '../../schema/canonical'
import { readMigrationSourcePointer } from '../generationPointerSource'
import {
  FrozenCopyStaleError,
  openEpoch1SqliteSource,
  openEpoch1SqliteBackupSource,
  type Epoch1SqliteSource,
  type SqliteCopyRecord,
} from '../sqliteSourceReader'
import { openEpoch1PostgresqlSource } from '../postgresqlSourceReader'
import {
  openEpoch1LogicalArtifactSource,
  openEpoch1HostedBackupSource,
} from '../artifactSourceReader'
import { upgradeEpoch1Copy, type OfflinePostgresqlDatabase } from '../offlineSourceUpgrade'
import { composePostgresqlArchiveSource } from '../conversion/postgresqlArchiveSource'
import { resolvePostgresqlSourceArchive } from './postgresqlArchive'
import { releasedPostgresqlSources } from '../epoch1/releasedPostgresql'
import { bridgeReleasedPostgresql, PostgresqlBridgeBlockedError } from '../postgresqlBridge'
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
  writeDurableLogicalArtifact,
} from '../legacy/logicalDatabaseArtifact'
import { makeSourceFingerprint } from '../sourceCatalog'
import { sourceFilesDigest, sourceChunk } from '../sourceReader'
import { rawSourceChunk } from '../rawSourceReader'
import type { SupportedSourceManifest } from '../supportedSources'
import { unhandledDatabaseProvider, type DatabaseProvider } from '../../databaseProviders'
import type { EmptyTableDecision } from '../sourceDispositions'
import type {
  SourceMeasurementObserver,
  SourcePreflight,
  VersionedSourceReader,
} from '../sourceTypes'
import type {
  EpochSourceLocation,
  FrozenSourceHandle,
  EpochSwitchArtifactPort,
  SourceArchiveInput,
} from '../run/types'
import type { ConversionResolution } from '../conversion/types'
import { captureLiveSqliteSnapshot, pinnedSnapshotReader } from './liveSnapshot'
import { migrationPostgresqlRuntime, preparePostgresqlScratch } from './postgresqlDatabases'
import {
  atomicSourceFile,
  materializedSourceDirectory,
  persistSourceDirectory,
  sourceArtifactRoot,
  syncSourceDirectory,
} from './artifacts'
import {
  FROZEN_COPY_FILE,
  describesFreeze,
  discardFreezeRecord,
  freezeIdentity,
  publishFreezeRecord,
  readFreezeRecord,
} from './freezeRecord'
import type { SourceWatch } from './sourceWatch'

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
  /**
   * RFC-626 §4.1: what the process remembers about the old database from one handle to the
   * next. Borrowed: the assembly of the automatic upgrade owns it for the whole session and a
   * handle never closes it. Without one each handle confirms the identity for itself.
   */
  readonly watch?: SourceWatch
  /**
   * RFC-626: `automatic` for the automatic upgrade. A frozen handle then keeps its freeze in
   * the run directory and later handles of the run take it over (§4.2), and what the old
   * database could hold is left to the conversion instead of failing the freeze (§3.3).
   */
  readonly resolution?: ConversionResolution
  /**
   * RFC-626 §7: told each time one of the handle's readers reads all of the data of a source or
   * of an artifact directory. Tests count with it; the assembly passes none.
   */
  readonly onMeasure?: SourceMeasurementObserver
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
  readonly onMeasure?: SourceMeasurementObserver
}): VersionedSourceReader {
  const { location, manifest, onMeasure } = input
  if (location.sourceKind === 'sqlite-backup')
    return openEpoch1SqliteBackupSource({
      backupRoot: location.root,
      manifest,
      operationRoot: input.operationRoot,
      emptyTables: input.emptyTables,
      onMeasure,
    })
  if (location.sourceKind === 'hosted-backup')
    return openEpoch1HostedBackupSource({
      backupRoot: location.root,
      supportedSources: manifest,
      onMeasure,
    })
  if (location.sourceKind === 'logical-backup') {
    const backup = readManifest(location.root)
    if (backup?.manifestVersion !== 2) throw new Error('old-epoch-logical-manifest-required')
    return openEpoch1LogicalArtifactSource({
      artifactRoot: join(location.root, backup.database.logicalPath),
      backupRoot: location.root,
      envelopeFileDigest: backup.database.envelopeFileDigest,
      supportedSources: manifest,
      onMeasure,
    })
  }
  if (existsSync(join(location.root, 'logical-backup.json')))
    return openEpoch1LogicalArtifactSource({
      artifactRoot: location.root,
      envelopeFileDigest: logicalArtifactFileDigest(join(location.root, 'logical-backup.json')),
      supportedSources: manifest,
      onMeasure,
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
    onMeasure,
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
  /**
   * RFC-626 §4.2, automatic upgrade only: the content identity of the SQLite work copy and the
   * size it was recorded at. The copy is this operation's own, so a later handle recognises it
   * by its size and takes the identity over instead of reading the whole copy again.
   */
  readonly copy?: SqliteCopyRecord
}
/** The work copy depends on the source it was made from, the decisions, and the head it reaches. */
function upgradeBindingDigest(original: SourcePreflight, input: SourceAccessInput): string {
  return digestSchemaContract({
    watermark: original.watermark,
    decisions: input.emptyTables,
    head: input.manifest.headDigest,
  })
}
/** `runs/<runId>/source-access/frozen` in an operation with an artifact store. */
async function freezeRecordRoot(input: SourceAccessInput, workRoot: string): Promise<string> {
  return input.artifacts
    ? sourceArtifactRoot(input.artifacts, 'source-access/frozen')
    : join(workRoot, 'frozen')
}
/**
 * A borrowed watch seen under a prefix. A reader keys its baseline by the database it reads,
 * and a scratch database that is reset and filled again is still that database: it can hold
 * as many rows and the same sequence values as before with other content, which cheap
 * evidence cannot tell apart. The prefix names the copy, so each copy starts without a baseline.
 */
function scopedWatch(watch: SourceWatch, scope: string): SourceWatch {
  return {
    sqliteDataVersion: (path) => watch.sqliteDataVersion(path),
    baseline: (key) => watch.baseline(`${scope}:${key}`),
    remember: (key, baseline) => watch.remember(`${scope}:${key}`, baseline),
    forget: (key) => watch.forget(`${scope}:${key}`),
    close() {},
  }
}
/** A borrowed watch that also reports the cheap evidence the reader last settled on. */
function observedWatch(watch: SourceWatch): {
  readonly watch: SourceWatch
  evidence(): string | null
} {
  let evidence: string | null = null
  return {
    watch: {
      sqliteDataVersion: (path) => watch.sqliteDataVersion(path),
      baseline(key) {
        const remembered = watch.baseline(key)
        if (remembered) evidence = remembered.evidence
        return remembered
      },
      remember(key, baseline) {
        evidence = baseline.evidence
        watch.remember(key, baseline)
      },
      forget: (key) => watch.forget(key),
      close() {},
    },
    evidence: () => evidence,
  }
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
              'bridge-copy-',
              'conversion-',
            ].some((prefix) => entry.name.startsWith(prefix))) ||
          entry.name.endsWith('.tmp')
        )
          rmSync(join(directory, entry.name), { recursive: true, force: true })
    }
    // RFC-626 §4.2: only the automatic upgrade keeps its freeze. It runs with the daemon stopped
    // for the whole session, so the copy frozen for the plan is still the old database when
    // the run step opens it. An operator's plan reads a snapshot of a database that is still
    // being written, and every handle of theirs freezes for itself as before.
    const durable = input.resolution === 'automatic' && mode === 'frozen'
    let original: VersionedSourceReader
    let pointerBytes: string | null = null
    let databaseFingerprint: string | null = null
    let sqlite: Epoch1SqliteSource | null = null
    let databaseEvidence: (() => string | null) | null = null
    if (input.location.kind === 'sqlite-file') {
      const location = input.location
      const pointer = readMigrationSourcePointer(location.pointerPath)
      pointerBytes = pointer.bytes ? Buffer.from(pointer.bytes).toString('base64') : null
      if (pointer.pointer && pointer.pointer.payload.version !== 1)
        throw new Error('source-epoch-not-one')
      const snapshot =
        mode === 'live' ? captureLiveSqliteSnapshot({ ...location, operationRoot: workRoot }) : null
      if (snapshot) releases.push(snapshot.close)
      const openOriginal = (
        copy: Pick<Parameters<typeof openEpoch1SqliteSource>[0], 'frozenCopy' | 'recorded'> = {},
      ) => {
        const opened = openEpoch1SqliteSource({
          path: snapshot?.path ?? location.path,
          manifest: input.manifest,
          operationRoot: workRoot,
          emptyTables: input.emptyTables,
          resolution: input.resolution,
          ...(!pointer.bytes ? { sourceGenerationId: 'dbg_legacy_sqlite' } : {}),
          ...(snapshot?.pointerPath
            ? { generationPointerPath: snapshot.pointerPath }
            : mode === 'frozen' && pointer.bytes
              ? { generationPointerPath: location.pointerPath }
              : {}),
          // The plan snapshot is this handle's own copy and is read in place; the old database
          // itself is what the watch is for.
          ...(snapshot ? { privateCopy: true } : { watch: input.watch }),
          onMeasure: input.onMeasure,
          ...copy,
        })
        // Registered at once: a reader that fails below still gives up its connections.
        releases.push(() => opened.close())
        return opened
      }
      if (!durable) sqlite = openOriginal()
      else {
        const root = await freezeRecordRoot(input, workRoot)
        const frozenCopy = join(root, FROZEN_COPY_FILE)
        const record = readFreezeRecord(root)
        if (record?.provider === 'sqlite') {
          const reopened = openOriginal({
            frozenCopy,
            recorded: { content: record.content, bytes: record.copy.bytes },
          })
          let stale: FrozenCopyStaleError['reason'] | null = null
          try {
            if (describesFreeze(record, await reopened.preflight())) sqlite = reopened
            else stale = 'source'
          } catch (error) {
            if (!(error instanceof FrozenCopyStaleError)) throw error
            stale = error.reason
          }
          if (stale) {
            await reopened.close()
            // The old database is no longer what was frozen. A run whose plan is pinned ends
            // here and the caller starts a new run; before that nothing depends on the earlier
            // identity yet and the freeze is taken again in this run's directory. A copy that
            // merely is not the recorded file any more is made again from the source either way.
            if (stale === 'source' && expected)
              throw new Error('source-changed: source differs from its frozen copy')
          }
        }
        if (!sqlite) {
          // No record, or one that cannot be taken over: what lies there is an unfinished or
          // outdated freeze.
          discardFreezeRecord(root)
          const frozen = openOriginal({ frozenCopy })
          const preflight = await frozen.preflight()
          const state = frozen.copyState()
          await publishFreezeRecord(root, {
            ...freezeIdentity(
              preflight,
              preflight.requiresOfflineUpgrade ? upgradeBindingDigest(preflight, input) : null,
            ),
            provider: 'sqlite',
            content: state.content,
            copy: { file: FROZEN_COPY_FILE, bytes: state.bytes },
            foreignKeyViolations: state.foreignKeyViolations ?? 0,
          })
          if (state.foreignKeyViolations)
            input.progress?.({
              phase: 'freeze',
              detail: `${state.foreignKeyViolations} row(s) with a dangling foreign key are left to the conversion`,
            })
          sqlite = frozen
        }
      }
      original = sqlite
    } else if (input.location.kind === 'postgresql-database') {
      if (!input.postgresql) throw new Error('postgresql-source-runtime-required')
      const runtime = migrationPostgresqlRuntime(input.postgresql())
      databaseFingerprint = (await runtime.readiness()).databaseFingerprint
      const observed = durable && input.watch ? observedWatch(input.watch) : null
      databaseEvidence = observed?.evidence ?? null
      original = openEpoch1PostgresqlSource({
        runtime,
        manifest: input.manifest,
        contentRoot: input.operationRoot,
        emptyTables: input.emptyTables,
        watch: observed?.watch ?? input.watch,
        resolution: input.resolution,
        onMeasure: input.onMeasure,
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
    const release = releasedPostgresqlSources.find(
      (release) =>
        release.contract.digest === originalPreflight.contract?.digest &&
        input.manifest.sources.some(
          (source) =>
            source.contract?.digest === release.contract.digest &&
            source.readMode === 'logical-bridge',
        ),
    )
    if (release && bridgesReleasedBaseline(originalPreflight.fingerprint.provider)) {
      const directory = mkdtempSync(join(workRoot, 'bridge-copy-'))
      releases.push(() => rmSync(directory, { recursive: true, force: true }))
      const sourceDetails: FrozenSourceDetails = {
        location: input.location,
        originalReader,
        originalPreflight,
        sqlitePath: null,
        immutableDigest,
        databaseFingerprint,
        mode,
        operationRoot: workRoot,
      }
      const provisional: FrozenSourceHandle = {
        reader: original,
        preflight: originalPreflight,
        preUpgrade: null,
        watermark: originalPreflight.watermark,
        evidenceRoot: null,
        close: async () => {},
      }
      details.set(provisional, sourceDetails)
      const archiveInput =
        input.location.kind === 'postgresql-database'
          ? await input.postgresqlArchive?.(provisional)
          : undefined
      if (input.location.kind === 'postgresql-database' && !archiveInput)
        throw new Error('postgresql-archive-required')
      const archive = archiveInput
        ? await resolvePostgresqlSourceArchive(sourceDetails, archiveInput, input.onMeasure)
        : undefined
      await archive?.emptyArchive?.assertProvenance()
      const binding = digestSchemaContract({
        fingerprint: originalPreflight.fingerprint.digest,
        watermark: originalPreflight.watermark,
      }).slice(7)
      const bridge = await bridgeReleasedPostgresql({
        release,
        source: original,
        expected: originalPreflight,
        manifest: input.manifest,
        path: join(directory, 'bridge.sqlite'),
        archive: archive?.preservedArchive,
        archiveDigest:
          archiveInput?.kind === 'retained-epoch1-archive' ? archiveInput.digest : null,
        ...(input.location.kind === 'backup' ? { archiveReader: original } : {}),
      }).catch(async (error: unknown) => {
        if (error instanceof PostgresqlBridgeBlockedError) {
          const name = `source-access/bridges/${binding}/blocks.json`
          const evidence = {
            sourceFingerprint: originalPreflight.fingerprint.digest,
            sourceWatermark: originalPreflight.watermark,
            blocks: error.blocks,
          }
          writeDurableLogicalArtifact(join(input.operationRoot, name), evidence)
          await input.artifacts?.put(name, Buffer.from(canonicalSchemaJson(evidence)))
        }
        throw error
      })
      releases.push(() => bridge.reader.close())
      const receiptName = `source-access/bridges/${binding}/receipt.json`
      // Replays rebuild and must reproduce the same counts/digests/catalog receipt.
      writeDurableLogicalArtifact(join(input.operationRoot, receiptName), bridge.receipt)
      await input.artifacts?.put(receiptName, Buffer.from(canonicalSchemaJson(bridge.receipt)))
      const upgraded = await upgradeEpoch1Copy({
        source: bridge.physical,
        expected: await bridge.physical.preflight(),
        manifest: bridge.manifest,
        operationRoot: workRoot,
        emptyTables: input.emptyTables,
        progress: input.progress,
        onMeasure: input.onMeasure,
      })
      releases.push(() => upgraded.close())
      const physical = await upgraded.reader.preflight()
      const current: SourcePreflight = {
        ...physical,
        kind: originalPreflight.kind,
        sourceVersion: originalPreflight.sourceVersion,
        fingerprint: originalPreflight.fingerprint,
        sourceGenerationId: originalPreflight.sourceGenerationId,
        identityHighWater: originalPreflight.identityHighWater,
        identityEvidence: originalPreflight.identityEvidence,
        watermark: originalPreflight.watermark,
      }
      const assertUnchanged = async (value: SourcePreflight) => {
        if (canonicalSchemaJson(value) !== canonicalSchemaJson(current))
          throw new Error('source-changed: PostgreSQL bridge binding differs')
        await bridge.reader.assertUnchanged(bridge.preflight)
        await upgraded.reader.assertUnchanged(physical)
        if (archiveInput)
          await resolvePostgresqlSourceArchive(sourceDetails, archiveInput, input.onMeasure)
      }
      const handle: FrozenSourceHandle = {
        reader: {
          ...upgraded.reader,
          kind: current.kind,
          preflight: async () => {
            await assertUnchanged(current)
            return current
          },
          assertUnchanged,
          async readChunk(table, afterKey, limit) {
            return sourceChunk({
              ...(await upgraded.reader.readChunk(table, afterKey, limit)),
              table: physical.contract!.tables.find((entry) => entry.id === table)!,
              sourceVersion: current.sourceVersion,
            })
          },
          async readRawChunk(table, afterKey, limit) {
            const chunk = await upgraded.reader.readRawChunk(table, afterKey, limit)
            return rawSourceChunk({
              table: chunk.table,
              migrationKey: chunk.migrationKey,
              afterKey: chunk.afterKey,
              rows: chunk.rows,
              sourceVersion: current.sourceVersion,
            })
          },
        },
        preflight: current,
        preUpgrade: { reader: bridge.reader, preflight: bridge.preflight },
        watermark: current.watermark,
        evidenceRoot: directory,
        close,
      }
      details.set(handle, sourceDetails)
      if (
        expected &&
        (handle.watermark !== expected.watermark ||
          originalPreflight.watermark !== expected.preUpgradeWatermark ||
          current.sourceGenerationId !== expected.sourceGenerationId)
      )
        throw new Error('source-changed: frozen PostgreSQL bridge differs')
      await assertUnchanged(current)
      return handle
    }
    if (durable && input.location.kind === 'postgresql-database') {
      // A database source has no frozen file: its freeze is the reader's snapshot transaction,
      // which ended with the earlier handle. The reader has just taken a new snapshot and
      // decided for itself whether its identity still holds; here the result is only compared
      // with what the run recorded. A bridged baseline (returned above) is rebuilt on every
      // access and keeps no record.
      const root = await freezeRecordRoot(input, workRoot)
      const found = readFreezeRecord(root)
      const record = found?.provider === 'postgresql' ? found : null
      if (!record || !describesFreeze(record, originalPreflight)) {
        if (record && expected)
          throw new Error('source-changed: source differs from its freeze record')
        discardFreezeRecord(root)
        mkdirSync(root, { recursive: true })
        await publishFreezeRecord(root, {
          ...freezeIdentity(
            originalPreflight,
            originalPreflight.requiresOfflineUpgrade
              ? upgradeBindingDigest(originalPreflight, input)
              : null,
          ),
          provider: 'postgresql',
          tableRows: originalPreflight.fingerprint.tableRows,
          identityHighWater: originalPreflight.identityHighWater,
          evidence: databaseEvidence?.() ?? null,
        })
      }
    }
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
      const bindingDigest = upgradeBindingDigest(originalPreflight, input)
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
            // The work copy is this operation's own file: read in place, never copied again.
            privateCopy: true,
            resolution: input.resolution,
            onMeasure: input.onMeasure,
            ...(durable && binding.copy ? { recorded: binding.copy } : {}),
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
            // Scoped to this very copy: a scratch that is reset and filled again gets a new
            // directory name, so it can never take over what was remembered for its predecessor.
            ...(input.watch
              ? { watch: scopedWatch(input.watch, `work-copy:${binding.directory}`) }
              : {}),
            resolution: input.resolution,
            onMeasure: input.onMeasure,
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
          // RFC-626 §4.2: a freeze the automatic upgrade takes again before its plan is pinned
          // replaces the earlier one — nothing depends on that identity yet, so its work copy
          // goes too. Otherwise a frozen work copy is evidence of a run and is retained.
          if (prior.frozen && !(durable && !expected))
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
        let workCopy: Epoch1SqliteSource | null = null
        if (sqlite) {
          const upgraded = await upgradeEpoch1Copy({
            progress: input.progress,
            source: sqlite,
            expected: await sqlite.preflight(),
            manifest: input.manifest,
            operationRoot: workRoot,
            emptyTables: input.emptyTables,
            resolution: input.resolution,
            onMeasure: input.onMeasure,
          })
          try {
            sqlitePath = join(directoryName, 'current.sqlite')
            vacuumSqliteInto({ dbPath: upgraded.path, dest: join(cacheRoot, sqlitePath) })
          } finally {
            await upgraded.close()
          }
          workCopy = openEpoch1SqliteSource({
            path: join(cacheRoot, sqlitePath),
            manifest: input.manifest,
            operationRoot: workRoot,
            emptyTables: input.emptyTables,
            sourceGenerationId: originalPreflight.sourceGenerationId,
            privateCopy: true,
            resolution: input.resolution,
            onMeasure: input.onMeasure,
          })
          const upgradedReader = workCopy
          releases.push(() => upgradedReader.close())
          reader = workCopy
        } else {
          const openScratch = input.reopenScratchPostgresql ?? input.createScratchPostgresql!
          const upgraded = await upgradeEpoch1Copy({
            progress: input.progress,
            source: original,
            manifest: input.manifest,
            operationRoot: workRoot,
            resolution: input.resolution,
            onMeasure: input.onMeasure,
            // The scope the reopening handle above uses for this copy: its identity, measured
            // once here, is adopted by a later handle of this process instead of read again.
            ...(input.watch
              ? { watch: scopedWatch(input.watch, `work-copy:${directoryName}`) }
              : {}),
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
        const currentWatermark = (await reader.preflight()).watermark
        const copied = durable ? workCopy?.copyState() : undefined
        binding = {
          originalWatermark: originalPreflight.watermark,
          generationId: originalPreflight.sourceGenerationId,
          directory: directoryName,
          sqlitePath,
          currentWatermark,
          bindingDigest,
          scratchFingerprint,
          frozen: mode === 'frozen',
          ...(copied ? { copy: { content: copied.content, bytes: copied.bytes } } : {}),
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
      // The handle hands out `current` itself; only a foreign value has to be encoded to compare.
      if (value !== current && canonicalSchemaJson(value) !== canonicalSchemaJson(current))
        throw new Error('source-changed: source binding differs')
      // RFC-626 §4.1: neither reader measures its database here. The old database answers with
      // its cheap evidence and the work copy, being this operation's own, with its size; the
      // content identity is recomputed only when that evidence has moved.
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
      await resolvePostgresqlSourceArchive(physicalDetails, archiveInput, input.onMeasure)
      if (archiveInput.kind === 'retained-epoch1-archive') {
        const manifest = verifyLogicalArtifactManifest(
          JSON.parse(readFileSync(join(archiveInput.path, 'logical-manifest.json'), 'utf8')),
        )
        const archive = openEpoch1LogicalArtifactSource({
          artifactRoot: archiveInput.path,
          manifestDigest: manifest.digest,
          legacyArchiveFileDigest: archiveInput.digest,
          supportedSources: input.manifest,
          onMeasure: input.onMeasure,
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

/** RFC-398 §3.8: only a released PostgreSQL baseline is bridged through a private SQLite prefix. */
function bridgesReleasedBaseline(provider: DatabaseProvider): boolean {
  switch (provider) {
    case 'postgresql':
      return true
    case 'sqlite':
      return false
    default:
      return unhandledDatabaseProvider(provider)
  }
}
