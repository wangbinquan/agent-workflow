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
  EncodedKey,
  MigrationRecord,
  RowDisposition,
  SourcePhase,
  TableReceipt,
  TargetRef,
  UnitRef,
} from '@/platform/persistence/migration/conversion/types'
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
  operationRoot(operationId: string): string
  lockOperation(operationId: string): Promise<{ release(): void | Promise<void> }>
  /** All operation documents and F evidence share this operation-scoped durable store. */
  artifacts?(operationId: string): EpochSwitchArtifactPort
}
export interface SourceSnapshotRequest {
  readonly postgresqlArchive?: (source: FrozenSourceHandle) => Promise<SourceArchiveInput>
  readonly scratchOwner?: string
  readonly scratchProfileRef?: string
  readonly location: EpochSourceLocation
  readonly emptyTables: readonly EmptyTableDecision[]
  readonly operationRoot: string
  readonly artifacts?: EpochSwitchArtifactPort
}
export interface FrozenSourceExpected {
  readonly watermark: string
  readonly preUpgradeWatermark: string | null
  readonly sourceGenerationId: string
}
export interface EpochSourcePort {
  discover(input: SourceSnapshotRequest): Promise<FrozenSourceHandle>
  freeze(
    input: SourceSnapshotRequest & { readonly expected?: FrozenSourceExpected },
  ): Promise<FrozenSourceHandle>
}
export interface EpochBackupPort {
  create(input: {
    readonly operationId: string
    readonly source: FrozenSourceHandle
    readonly destination: string
    readonly contentManifest?: FreezeContentManifest | null
    readonly postgresqlArchive?: SourceArchiveInput
    readonly artifacts?: EpochSwitchArtifactPort
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
    readonly source: FrozenSourceHandle
    readonly root: ContentRootSpec
    readonly destination: string
  }): Promise<FreezeContentManifest>
  open(input: {
    readonly manifest: FreezeContentManifest
    readonly root: ContentRootSpec
    readonly source: FrozenSourceHandle
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
}
export interface TargetGenerationHandle {
  readonly generationId: string
  readonly provider: DatabaseProvider
  openRun(
    row: MigrationRunInit,
  ): ConversionSink & { loadBlocks(): Promise<readonly ConversionBlock[]> }
  finalize(input: { readonly runId: string }): Promise<TargetFinalizeReport>
  validate(input: {
    readonly runId: string
    readonly preflight: SourcePreflight
    readonly preUpgrade: SourcePreflight | null
    readonly inventory: VerifiableContentInventory
    readonly probes: readonly ReadOnlyProbe[]
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
