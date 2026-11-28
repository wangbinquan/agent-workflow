import type { JsonObject } from '@/platform/contracts/json'
import type { DatabaseProvisioning } from '@/platform/persistence/migration/databaseProvisioning'
import type { MigrationProgressCallback } from '@/platform/persistence/migration/run/progress'
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import type { GenerationPointerV2Payload } from '@/platform/persistence/generationPointerV2'
import type { EmptyTableDecision } from '@/platform/persistence/migration/sourceDispositions'
import type { SourcePreflight } from '@/platform/persistence/migration/sourceTypes'
import type { BootUpgradeEnvironmentPort } from '@/platform/persistence/migration/freeze/bootUpgradeEnvironment'
import type {
  ConversionSink,
  ConversionSummary,
} from '@/platform/persistence/migration/conversion/sink'
import type {
  ArtifactReceipt,
  ArchiveRef,
  ConversionBlock,
  ConversionResolution,
  EncodedKey,
  LoadRejectionDecision,
  MigrationRecord,
  RowDisposition,
  SourcePhase,
  TableReceipt,
  TargetRef,
  UnitRef,
} from '@/platform/persistence/migration/conversion/types'
import type { PreparedConversion } from '@/platform/persistence/migration/conversion/engine'
import type { ReferenceKeepPolicy } from '@/platform/persistence/migration/conversion/rule'
import type {
  ContentRootSpec,
  ConversionRunRequest,
  DryRunResult,
  EpochSourceLocation,
  EpochTargetLocation,
  EpochSwitchArtifactPort,
  FoldedIdentityHighWater,
  FreezeContentManifest,
  FrozenSourceHandle,
  HealthReport,
  MigrationArchive,
  MigrationApproval,
  MigrationBlockRecord,
  MigrationRun,
  MigrationRunInit,
  MigrationTraceResult,
  MigrationUnit,
  MigrationUnitSource,
  PersistedHistoryRestriction,
  SourceArchiveInput,
  QuiesceReceipt,
  ReadOnlyProbe,
  ReceiptExport,
  SwitchBackupReceipt,
  TargetFinalizeReport,
  TargetPreflight,
  TraceInput,
  ValidationReport,
  VerifiableContentInventory,
} from '@/platform/persistence/migration/run/types'
import type { EpochSwitchFaults, EpochSwitchJournal } from '../../domain/epochSwitch/model'
import type { DatabaseMigrationStatusView } from '../databaseMigrationControlPlane'
import type {
  AutoUpgradeAcceptanceEvidence,
  AutoUpgradeRecord,
  AutoUpgradeRecordKind,
  AutoUpgradeSession,
} from '../../domain/epochSwitch/autoUpgrade'

export interface AutoUpgradeRecordPort {
  list(): Promise<readonly AutoUpgradeSession[]>
  append(
    operationId: string,
    kind: AutoUpgradeRecordKind,
    data: Readonly<Record<string, unknown>>,
  ): Promise<AutoUpgradeRecord>
  /**
   * Publishes the session's receipt once and returns it as published: the JSON of the first value, also when a later call
   * (recovery) passes a new one. The value stays opaque (RFC-398 §2.7); only the published form is typed (RFC-610).
   */
  receipt(operationId: string, value: Readonly<Record<string, unknown>>): Promise<JsonObject>
  acceptance(operationId: string, runId: string): Promise<readonly AutoUpgradeAcceptanceEvidence[]>
}
export interface SessionLockPort {
  acquire(): Promise<void>
  bind(operationId: string): Promise<void>
  assertHeld(): Promise<void>
  /** Releases a self-held daemon lock before removing active.json; a live parent keeps its lock. */
  release(): Promise<void>
}
import type {
  ActivationReceipt,
  RollbackReceipt,
  SwitchReceipt,
} from '../../domain/epochSwitch/documents'

export type {
  ContentRootSpec,
  ConversionRunRequest,
  DryRunResult,
  FrozenSourceHandle,
  MigrationRunInit,
  ReadOnlyProbe,
  SwitchBackupReceipt,
  TargetPreflight,
  TargetFinalizeReport,
  ValidationReport,
  HealthReport,
  QuiesceReceipt,
  VerifiableContentInventory,
  FreezeContentManifest,
  TraceInput,
  MigrationTraceResult,
  MigrationApproval,
  EpochSwitchArtifactPort,
  EpochSwitchArtifactReference,
  SourceArchiveInput,
} from '@/platform/persistence/migration/run/types'

export interface EpochSwitchJournalPort {
  create(journal: EpochSwitchJournal): Promise<EpochSwitchJournal>
  read(operationId: string): Promise<EpochSwitchJournal | null>
  list(): Promise<readonly EpochSwitchJournal[]>
  compareAndSwap(
    expected: { readonly operationId: string; readonly revision: number; readonly digest: string },
    next: EpochSwitchJournal,
  ): Promise<EpochSwitchJournal>
  /** Equal bytes are a no-op; conflicting bytes are a receipt conflict. */
  writeOnce(operationId: string, name: string, bytes: Uint8Array): Promise<ReceiptExport>
  readArtifact(operationId: string, name: string): Promise<Uint8Array | null>
  prunePlanContent?(
    operationId: string,
    references: readonly { path?: string; digest: string }[],
  ): Promise<void>
  operationRoot(operationId: string): string
  lockOperation(operationId: string): Promise<{ release(): void | Promise<void> }>
  /** All operation documents and F evidence share this operation-scoped durable store. */
  artifacts?(operationId: string): EpochSwitchArtifactPort
}

export interface EpochTargetProvisioningPort extends DatabaseProvisioning {
  nextTargetLocation(
    previous: EpochSwitchJournal,
    next: EpochSwitchJournal,
  ): Promise<EpochTargetLocation>
}
export interface LegacyMigrationFinalizePort {
  status(operationId: string): Promise<DatabaseMigrationStatusView>
  finalize(operationId: string): Promise<DatabaseMigrationStatusView>
}
export interface SourceSnapshotRequest {
  readonly progress?: MigrationProgressCallback
  readonly postgresqlArchive?: (source: FrozenSourceHandle) => Promise<SourceArchiveInput>
  readonly scratchOwner?: string
  readonly scratchProfileRef?: string
  readonly location: EpochSourceLocation
  readonly emptyTables: readonly EmptyTableDecision[]
  readonly operationRoot: string
  readonly artifacts?: EpochSwitchArtifactPort
  /**
   * RFC-626: `automatic` for the automatic upgrade. The source access then keeps what the
   * physical source can hold instead of failing on it (rows whose foreign key dangles in the
   * old database, values the logical codec rejects while copying), reuses the frozen copy of
   * the run, and leaves the decision about such data to the conversion.
   */
  readonly resolution?: ConversionResolution
}
export interface FrozenSourceExpected {
  readonly watermark: string
  readonly preUpgradeWatermark: string | null
  readonly sourceGenerationId: string
}
/**
 * RFC-626: what the read-only check before an automatic upgrade found out about the source.
 * It opens the source, identifies its structure from the catalog and the migration journal
 * without counting rows, and measures the live data (not the file size).
 */
export type SourcePrecheck =
  | { readonly ok: true; readonly liveBytes: number }
  | {
      readonly ok: false
      /** `unreadable`: cannot be opened or read. `structure`: not a released structure. */
      readonly reason: 'unreadable' | 'structure'
      /** One sentence a person can act on; names the objects that differ. */
      readonly message: string
      readonly detail: JsonObject
    }
export interface EpochSourcePort {
  discover(input: SourceSnapshotRequest): Promise<FrozenSourceHandle>
  freeze(
    input: SourceSnapshotRequest & { readonly expected?: FrozenSourceExpected },
  ): Promise<FrozenSourceHandle>
  /** RFC-626: writes nothing under the operation root and creates no database. */
  precheck?(input: SourceSnapshotRequest): Promise<SourcePrecheck>
}
export interface EpochBackupPort {
  create(input: {
    readonly operationId: string
    readonly source: FrozenSourceHandle
    readonly destination: string
    readonly contentManifest?: FreezeContentManifest | null
    readonly postgresqlArchive?: SourceArchiveInput
    readonly artifacts?: EpochSwitchArtifactPort
    /** RFC-626: see `SourceSnapshotRequest.resolution`. */
    readonly resolution?: ConversionResolution
  }): Promise<SwitchBackupReceipt>
  matches(receipt: SwitchBackupReceipt, frozenWatermark: string): Promise<boolean>
}
export interface QuiescePort {
  quiesce(input: {
    readonly operationId: string
    readonly drainTimeoutMs: number
  }): Promise<QuiesceReceipt>
  release(operationId: string): Promise<void>
  assertHeld(operationId: string): Promise<void>
}
export interface ContentInventoryPort {
  capture(input: {
    readonly progress?: MigrationProgressCallback
    readonly source: FrozenSourceHandle
    readonly root: ContentRootSpec
    readonly destination: string
  }): Promise<FreezeContentManifest>
  /**
   * RFC-626 §4.4: the manifest this very object captured into `destination`, handed over once.
   * The plan step and the execution step of an automatic upgrade run in one process; the
   * execution step takes what the plan step listed instead of parsing its file — 170 MB on
   * the reference installation — into a second copy. Null when this object did not write that
   * file (another process did, or the listing was taken again): the caller then reads the file.
   */
  takeCaptured?(destination: string): FreezeContentManifest | null
  open(input: {
    readonly manifest: FreezeContentManifest
    readonly root: ContentRootSpec
    readonly source: FrozenSourceHandle
    /**
     * RFC-626: with `automatic` a receipt that registers content as missing is not compared
     * with the disk when the inventory is verified; a receipt that registers bytes still is.
     */
    readonly resolution?: ConversionResolution
  }): Promise<VerifiableContentInventory>
}
export interface TargetGenerationPort {
  preflight(input: {
    readonly location: EpochTargetLocation
    readonly provider: DatabaseProvider
    readonly sourceFingerprint: string | null
  }): Promise<TargetPreflight>
  create(input: {
    readonly generationId: string
    readonly provider: DatabaseProvider
    readonly location: EpochTargetLocation
    readonly operationId: string
    readonly runId: string
    readonly role: 'converted' | 'restored'
    readonly sourceGenerationId: string
    readonly now: number
    readonly faults?: EpochSwitchFaults
  }): Promise<TargetGenerationHandle>
  open(input: {
    readonly generationId: string
    readonly provider: DatabaseProvider
    readonly location: EpochTargetLocation
    readonly faults?: EpochSwitchFaults
  }): Promise<TargetGenerationHandle>
  discard(input: {
    readonly generationId: string
    readonly location: EpochTargetLocation
    readonly destination: string
  }): Promise<void>
  /**
   * RFC-626: retire a generation by the identity the journal stored for it. Unlike `open` it
   * does not require the generation to match this binary's target contract: a binary with a
   * different contract has to be able to give up the half-built target of its predecessor.
   * Touches migration metadata only.
   */
  retire(input: {
    readonly generationId: string
    readonly provider: DatabaseProvider
    readonly location: EpochTargetLocation
  }): Promise<'retired' | 'already-retired' | 'written' | 'absent'>
}
export interface TargetGenerationHandle {
  readonly generationId: string
  readonly provider: DatabaseProvider
  openRun(
    row: MigrationRunInit,
    /** RFC-626: `automatic` returns refused rows to the engine instead of recording load blocks. */
    options?: { readonly resolution?: ConversionResolution },
  ): ConversionSink & { loadBlocks(): Promise<readonly ConversionBlock[]> }
  finalize(input: {
    readonly runId: string
    /**
     * RFC-626: resolve references to rows that are not in the target instead of reporting
     * them: a reference with a keep policy is cleared or re-pointed, any other referring row
     * is moved to the archive. The report then lists what was done.
     */
    readonly dangling?: { readonly policies: readonly ReferenceKeepPolicy[] }
  }): Promise<TargetFinalizeReport>
  validate(input: {
    readonly runId: string
    readonly preflight: SourcePreflight
    readonly preUpgrade: SourcePreflight | null
    readonly inventory: VerifiableContentInventory
    readonly probes: readonly ReadOnlyProbe[]
    /** RFC-626: the report of the finalize that just ran; without it validation finalizes again. */
    readonly finalized?: TargetFinalizeReport
  }): Promise<ValidationReport>
  exportReceipts(input: {
    readonly runId: string
    readonly operationRoot: string
  }): Promise<ReceiptExport>
  /** Append-only by (runId, sequence); equal record is a no-op, conflicts fail. Phase 2 supplies it. */
  recordApproval?(approval: MigrationApproval): Promise<void>
  /** Phase 2 must compare against the latest recorded run approval, not MigrationRunInit. */
  prepareActivation(receipt: ActivationReceipt, previousPointer: Uint8Array | null): Promise<void>
  healthCheck(probes: readonly ReadOnlyProbe[]): Promise<HealthReport>
  firstLiveWriteAt(): Promise<number | null>
  retireIfUnwritten(): Promise<'retired' | 'already-retired' | 'written'>
  /** A rollback with null activation digest is valid when target activation was never recorded. */
  writeSwitchReceipt(receipt: SwitchReceipt | RollbackReceipt): Promise<void>
  trace(): MigrationMetaReadPort
  close(): Promise<void>
}
export interface ConversionPort {
  /** A composes the owner-local read-only probes; runtime boot mutators are never called. */
  readonly bootUpgradeEnvironment?: BootUpgradeEnvironmentPort
  dryRun(input: ConversionRunRequest): Promise<DryRunResult>
  run(input: ConversionRunRequest, sink: ConversionSink): Promise<ConversionSummary>
  /**
   * RFC-626: stage the source and fix the plan (with automatic resolution: find the tasks the
   * conversion ends) before a target run is registered; `run` on the result converts.
   */
  prepare?(input: ConversionRunRequest): Promise<PreparedConversion>
  /** RFC-626: the keep policies of the assembled contributions, for the finalize step. */
  readonly references?: readonly ReferenceKeepPolicy[]
}
export interface ActivationPort {
  activate(input: {
    readonly journal: EpochSwitchJournal
    readonly receiptDigest: string
    readonly pointer: GenerationPointerV2Payload | null
  }): Promise<{ readonly pointerDigest: string | null }>
  observe(operationId: string): Promise<{
    readonly pointsAt: 'source' | 'target' | 'other' | 'none'
    readonly pointerDigest: string | null
  }>
  restorePrevious(input: {
    readonly previousBytes: Uint8Array | null
    readonly firstLiveWriteAt: null
  }): Promise<void>
}
export interface SourceRetentionPort {
  retain(input: {
    readonly operationId: string
    readonly source: EpochSourceLocation
  }): Promise<readonly string[]>
}
export interface MigrationSourceKey {
  readonly sourceTable: string
  readonly sourcePhase: SourcePhase
  readonly sourceKey: EncodedKey
}
/** Range/group ordering is compared in code with staging key order, never database collation. */
export interface MigrationMetaReadPort {
  migrationRun(runId: string): Promise<MigrationRun | null>
  /** Ordered by sequence. Missing capability is not evidence of approval. */
  approvals?(runId: string): Promise<readonly MigrationApproval[]>
  runs(operationId: string): Promise<readonly MigrationRun[]>
  units(runId: string): AsyncIterable<MigrationUnit>
  unitSources(input: {
    readonly runId: string
    readonly sourceTable: string
    readonly sourcePhase: SourcePhase
  }): Promise<readonly MigrationUnitSource[]>
  tableReceipts(runId: string): Promise<readonly TableReceipt[]>
  dispositions(input: {
    readonly runId: string
    readonly source?: MigrationSourceKey
    readonly unitId?: string
  }): AsyncIterable<RowDisposition>
  artifacts(input: {
    readonly runId: string
    readonly sourceTable?: string
    readonly sourceKey?: EncodedKey
    readonly unitId?: string
  }): AsyncIterable<ArtifactReceipt>
  restrictions(input: {
    readonly runId?: string
    readonly taskId?: string
  }): Promise<readonly PersistedHistoryRestriction[]>
  blocks(input: {
    readonly runId: string
    readonly unitId?: string
  }): Promise<readonly MigrationBlockRecord[]>
  records(runId: string): AsyncIterable<MigrationRecord>
  /**
   * RFC-626: the refusals each committed unit set rows aside for, by unit id, as persisted.
   * A replay applies them verbatim; without the capability it converts as if none was refused.
   */
  loadRejections?(runId: string): Promise<ReadonlyMap<string, readonly LoadRejectionDecision[]>>
  identityHighWater(runId: string): Promise<readonly FoldedIdentityHighWater[]>
  archive(input: {
    readonly runId: string
    readonly ref: ArchiveRef
  }): Promise<MigrationArchive | null>
  probeTarget(target: TargetRef): Promise<boolean>
  receiptExport(
    runId: string,
  ): Promise<(ReceiptExport & { readonly bytes: Uint8Array | null }) | null>
}
export interface TraceSourceProbePort {
  groupKeys(
    input: MigrationSourceKey & { readonly run: MigrationRun; readonly unit: UnitRef },
  ): Promise<readonly string[]>
}
export interface TraceReplayPort {
  replay(input: TraceInput & { readonly run: MigrationRun }): Promise<MigrationTraceResult>
}
/**
 * RFC-626 §3.5: what the automatic session measures before it records a new upgrade. Every
 * member only reads: nothing is created under the home or the operation directory.
 */
export interface AutoUpgradeEnvironmentPort {
  /** Free bytes of the file system the operation directory will be created on; null when unknown. */
  availableBytes(operationRoot: string): Promise<number | null>
  /**
   * An estimate of how many content files the inventory will list. Bounded: it must not walk
   * every file, because the check it serves has to answer within seconds for any amount of data.
   */
  contentFiles(root: ContentRootSpec): Promise<number>
  /** False when the artifact store on that file system has to copy instead of linking. Default true. */
  artifactHardLinks?(operationRoot: string): Promise<boolean>
}
