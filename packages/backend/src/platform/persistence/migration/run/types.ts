import type { MigrationProgressCallback } from '@/platform/persistence/migration/run/progress'
// RFC-395 V3: injected offline mechanisms; no module or runtime assembly dependencies.
import type { DatabaseProvider } from '../../databaseProviders'
import type { HistoryConnection } from '../../schema/history/connection'
import type { SourceKind, SourcePreflight, VersionedSourceReader } from '../sourceTypes'
import type { EmptyTableDecision } from '../sourceDispositions'
import type { ContentInventory } from '../conversion/content'
import type { BootUpgradeFacts } from '../conversion/bootUpgradeFacts'
import type { ConversionPlanSection } from '../conversion/plan'
import type { ConversionRunBinding, ConversionSummary } from '../conversion/sink'
import type {
  ArchivePayload,
  ArchiveRef,
  ArtifactReceipt,
  ChunkReceipt,
  ConversionBlock,
  DispositionClass,
  EncodedKey,
  HistoryRestriction,
  JsonValue,
  MigrationKey,
  MigrationRecord,
  OperatorDecision,
  RowDisposition,
  RuleRef,
  SourcePhase,
  SourceReceipt,
  TableReceipt,
  TargetRef,
  UnitRef,
} from '../conversion/types'

export type EpochSwitchKind = 'epoch-conversion' | 'old-epoch-restore'
export type EpochDeployment = 'standalone' | 'crewstation'
export type EpochGenerationRole = 'converted' | 'restored'
export type EpochSourceLocation =
  | { readonly kind: 'sqlite-file'; readonly path: string; readonly pointerPath: string }
  | { readonly kind: 'postgresql-database'; readonly profileRef: string }
  | {
      readonly kind: 'backup'
      readonly sourceKind: 'sqlite-backup' | 'logical-backup' | 'logical-artifact' | 'hosted-backup'
      readonly artifact: string
      readonly root: string
    }
export type EpochTargetLocation =
  | { readonly kind: 'sqlite-file'; readonly relativePath: string }
  | { readonly kind: 'postgresql-target'; readonly profileRef: string }
export interface ConversionTargetConnection extends HistoryConnection {
  transaction<T>(body: (tx: HistoryConnection) => Promise<T>): Promise<T>
  close(): Promise<void>
}
export interface FrozenSourceHandle {
  readonly reader: VersionedSourceReader
  readonly preflight: SourcePreflight
  readonly preUpgrade: {
    readonly reader: VersionedSourceReader
    readonly preflight: SourcePreflight
  } | null
  readonly watermark: string
  readonly evidenceRoot: string | null
  close(): Promise<void>
}
export interface ContentRootSpec {
  readonly kind: 'app-home' | 'backup'
  /** Source/backup home for skills and config; never replaced by --content-root. */
  readonly root: string
  /** Home containing runs/, logs/ and evidence/. Omitted means the source/backup home. */
  readonly runContentRoot?: string
  readonly runsSupplied: boolean
  readonly objects: 'none' | 'crewstation'
}
/** Bound to one operation and its current local operation root by composition. */
export interface EpochSwitchArtifactPort {
  /** Durable before return; equal name/digest is a no-op. Retain earlier digests of a name. */
  put(name: string, bytes: Uint8Array | AsyncIterable<Uint8Array>): Promise<string>
  /** Optional local clone-or-copy fast path, with the same digest and durable layout. */
  putFile?(name: string, path: string): Promise<string>
  /** Verify the exact digest, materialise under this Job's operation root, return its local path.
   * Missing or mismatched bytes fail; an existing equal file is reused. Names are relative to
   * the operation root. Standalone stores the same bytes there; hosted storage outlives Jobs.
   */
  get(name: string, digest: string): Promise<string>
}
export interface EpochSwitchArtifactReference {
  readonly name: string
  readonly digest: string
}
export type SourceArchiveInput =
  | {
      readonly kind: 'retained-epoch1-archive'
      readonly path: string
      readonly digest: string
    }
  | {
      readonly kind: 'never-installed'
      /** F rechecks all six ARCHIVE tables against this frozen catalog and expectedAbsent. */
      readonly evidence: {
        readonly sourceBornOn: 'postgresql'
        readonly sourceGenerationId: string
        readonly sourceWatermark: string
        readonly catalogDigest: string
        readonly expectedAbsent: readonly string[]
      }
    }
export interface FreezeContentManifest {
  readonly version: 1
  readonly roots: readonly string[]
  readonly files: readonly {
    readonly path: string
    readonly size: number
    readonly mtimeMs: number
  }[]
  readonly objects: readonly {
    readonly id: string
    readonly present: boolean
    readonly size: number | null
    readonly sha256: string | null
  }[]
  readonly databaseTrees: readonly {
    readonly skillId: string
    readonly tree: string
    readonly size: number
    readonly sha256: string
  }[]
  readonly digest: string
}
export interface ContentDrift {
  readonly sourceTable: string
  readonly sourceKey: EncodedKey
  readonly sourceColumn: string
  readonly originalReference: string | null
  readonly reason: 'missing' | 'size-changed' | 'digest-changed' | 'unlisted' | 'unreadable'
  readonly expected: { readonly size: number; readonly sha256: string } | null
  readonly actual: { readonly size: number; readonly sha256: string } | null
}
export interface VerifiableContentInventory extends ContentInventory {
  verifyUnchanged(receipts: AsyncIterable<ArtifactReceipt>): Promise<readonly ContentDrift[]>
}
export interface SwitchBackupReceipt {
  readonly version: 1
  readonly id: string
  readonly kind:
    | 'sqlite-vacuum'
    | 'postgresql-logical'
    | 'platform-retained'
    | 'immutable-backup-source'
  readonly path: string | null
  readonly digest: string
  readonly sourceWatermark: string
  readonly contentManifestDigest: string | null
  readonly createdAt: number
}
export interface FoldedIdentityHighWater {
  readonly table: string
  readonly column: string
  readonly value: string
  readonly basis: 'sequence' | 'max-row' | 'both'
  readonly warnings: readonly string[]
}
export interface TargetInsertRejection {
  readonly table: string
  readonly targetKey: EncodedKey
  readonly constraint: string | null
  readonly message: string
}
export interface ConstraintViolation {
  readonly table: string | null
  readonly targetKey: EncodedKey | null
  readonly constraint: string | null
  readonly message: string
  readonly kind: 'foreign-key' | 'check' | 'unique' | 'row-rule' | 'integrity'
  readonly referencedTable: string | null
}
export interface TargetPreflight {
  readonly provider: DatabaseProvider
  readonly location: EpochTargetLocation
  readonly fingerprint: string
  readonly empty: boolean
  readonly postgresqlMajor: number | null
  readonly encoding: string
  readonly collation: string
  readonly canCreate: boolean
  readonly availableBytes: number | null
  readonly blocks: readonly ConversionBlock[]
}
export interface ReadOnlyProbeConnection {
  readonly provider: DatabaseProvider
  query(sql: string, values?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>
}
export interface ProbeResult {
  readonly id: string
  readonly passed: boolean
  readonly detail: JsonValue
}
/** Adapters provide a read-only connection; probes never start ordinary daemon recovery. */
export interface ReadOnlyProbe {
  readonly id: string
  run(connection: ReadOnlyProbeConnection): Promise<ProbeResult>
}
export interface HealthReport {
  readonly version: 1
  readonly checkedAt: number
  readonly catalogAdmitted: boolean
  readonly probes: readonly ProbeResult[]
  readonly passed: boolean
  readonly digest: string
}
export interface TargetFinalizeReport {
  readonly version: 1
  readonly runId: string
  readonly deferredConstraintsApplied: boolean
  readonly violations: readonly ConstraintViolation[]
  readonly integrity: readonly string[]
  readonly catalogAdmitted: boolean
  readonly identityHighWater: readonly FoldedIdentityHighWater[]
  readonly identityVerified: boolean
  readonly digest: string
}
export const VALIDATION_CHECKS = [
  'coverage',
  'engine-blocks',
  'load-blocks',
  'receipt-conservation',
  'constraints',
  'integrity',
  'catalog',
  'identity',
  'required-seeds',
  'content',
  'history-restrictions',
  'probes',
] as const
export type ValidationCheck = (typeof VALIDATION_CHECKS)[number]
export interface ValidationReport {
  readonly version: 1
  readonly runId: string
  readonly validatedAt: number
  readonly passed: boolean
  readonly checks: readonly {
    readonly check: ValidationCheck
    readonly passed: boolean
    readonly detail: JsonValue
  }[]
  readonly blocks: readonly ConversionBlock[]
  readonly contentDrift: readonly ContentDrift[]
  readonly historyRestrictionsDigest: string
  readonly probes: readonly ProbeResult[]
  readonly digest: string
}
export interface QuiesceReceipt {
  readonly version: 1
  readonly operationId: string
  readonly deployment: EpochDeployment
  readonly kind: 'daemon-stopped' | 'already-stopped' | 'platform-frozen'
  readonly stoppedAt: number
  readonly freezeReference: string | null
  readonly digest: string
}
export interface ConversionRunRequest {
  readonly progress?: MigrationProgressCallback
  readonly source: FrozenSourceHandle
  readonly content: VerifiableContentInventory
  readonly scratchRoot: string
  readonly planTime: number
  readonly chunkLimit: number
  readonly targetGeneration: string
  readonly candidateBuild: string
  readonly sourceBackupId: string | null
  readonly contentManifestDigest: string
  readonly bootUpgradeFacts?: BootUpgradeFacts
  readonly operatorDecisions: readonly OperatorDecision[]
}
export interface DryRunResult {
  readonly stagingPeakBytes?: number
  readonly summary: ConversionSummary
  readonly units: number
  readonly rowsWritten: number
  readonly dispositions: number
  readonly artifacts: number
  readonly archiveBytes: number
  readonly targetCounts: readonly { readonly table: string; readonly rows: number }[]
}
import type { MIGRATION_RUN_STATES } from '../../schema/history/runStates'
export { MIGRATION_RUN_STATES } from '../../schema/history/runStates'
export type MigrationRunState = (typeof MIGRATION_RUN_STATES)[number]
export type GenerationState = 'prepared' | 'active' | 'retired'
export interface MigrationApprovalPayload {
  readonly version: 1
  readonly operationId: string
  readonly runId: string
  /** Zero-based, contiguous within a run; independent of the operation's run ordinal. */
  readonly sequence: number
  /** Review evidence only. Approval validity is determined by approvalDigest. */
  readonly planDigest: string
  readonly approvalDigest: string
  readonly approvedAt: number
  readonly previousApprovalDigest: string | null
}
export interface MigrationApproval {
  readonly payload: MigrationApprovalPayload
  readonly digest: string
}
export interface GenerationRecord {
  readonly generationId: string
  readonly schemaEpoch: 2
  readonly role: 'installed' | EpochGenerationRole
  readonly state: GenerationState
  readonly provider: DatabaseProvider
  readonly operationId: string | null
  readonly runId: string | null
  readonly sourceGenerationId: string | null
  readonly contractDigest: string
  readonly planDigest: string
  readonly activationReceiptDigest: string | null
  readonly createdAt: number
  readonly activatedAt: number | null
  readonly retiredAt: number | null
}
/** The sink derives converter/source/target binding columns from conversionPlan and open(binding). */
export interface MigrationRunInit {
  readonly version: 1
  readonly runId: string
  readonly operationId: string
  readonly ordinal: number
  readonly kind: EpochSwitchKind
  readonly role: EpochGenerationRole
  readonly sourceProvider: DatabaseProvider
  readonly sourceEpoch: 1
  readonly sourceKind: SourceKind
  readonly targetProvider: DatabaseProvider
  readonly targetEpoch: 2
  /** Initial run bindings stay immutable; later approvals live in migration_approvals. */
  readonly migrationPlanDigest: string
  readonly approvalDigest: string
  readonly conversionPlan: ConversionPlanSection
  readonly emptyTables: readonly EmptyTableDecision[]
  readonly startedAt: number
}
export interface MigrationRun extends MigrationRunInit {
  readonly state: MigrationRunState
  readonly binding: ConversionRunBinding
  readonly bindingDigest: string
  readonly summaryDigest: string | null
  readonly validation: ValidationReport | null
  readonly validationDigest: string | null
  readonly receiptExportDigest: string | null
  readonly convertedAt: number | null
  readonly validatedAt: number | null
  readonly completedAt: number | null
}
export type MigrationTableReceipt = TableReceipt
export type MigrationRowDisposition = RowDisposition
export type MigrationArtifactReceipt = ArtifactReceipt
export interface MigrationUnit {
  readonly runId: string
  readonly unitId: string
  readonly receipt: ChunkReceipt
  readonly outcome: 'committed' | 'load-blocked'
  readonly rowsWritten: number
  readonly committedAt: number
}
export interface MigrationUnitSource extends SourceReceipt {
  readonly runId: string
  readonly unitId: string
  readonly rule: RuleRef
  readonly receiptDigest: string
  readonly unit: UnitRef
}
export interface PersistedHistoryRestriction {
  readonly runId: string
  readonly unitId: string
  readonly ordinal: number
  readonly sourceTable: string
  readonly sourcePhase: SourcePhase
  readonly sourceKey: EncodedKey
  readonly decisionCode: string
  /** history.runId identifies a NodeRun, not the migration run. */
  readonly history: HistoryRestriction
}
export interface MigrationBlockRecord {
  readonly runId: string
  readonly origin: 'plan' | 'unit' | 'load' | 'validation'
  readonly unitId: string | null
  readonly ordinal: number
  readonly block: ConversionBlock
}
export interface ReceiptExport {
  readonly path: string | null
  readonly digest: string
}
export interface TraceInput {
  readonly operationId: string
  readonly runId?: string
  readonly table: string
  readonly key: MigrationKey
  readonly phase?: SourcePhase
  readonly replay?: boolean
}
export interface MigrationTraceResult {
  readonly runId: string
  readonly sourceTable: string
  readonly sourcePhase: SourcePhase
  readonly sourceKey: EncodedKey
  readonly proof: 'row-disposition' | 'unit-range' | 'group-unit' | 'replay' | 'not-found'
  readonly class: DispositionClass | null
  readonly dispositions: readonly RowDisposition[]
  readonly unit: {
    readonly unitId: string
    readonly rule: RuleRef
    readonly receiptDigest: string
    readonly range: { readonly firstKey: EncodedKey; readonly lastKey: EncodedKey } | null
    readonly groups: { readonly first: string | null; readonly last: string | null } | null
  } | null
  readonly targets: readonly (TargetRef & { readonly probed: boolean; readonly present: boolean })[]
  readonly artifacts: readonly ArtifactReceipt[]
  readonly restrictions: readonly HistoryRestriction[]
  readonly blocks: readonly ConversionBlock[]
  readonly archive: ArchiveRef | null
}
export interface UnitProgress {
  readonly runId: string
  readonly unitId: string
  readonly rule: RuleRef
  readonly outcome: MigrationUnit['outcome']
  readonly rowsWritten: number
  readonly replayed: boolean
}
export interface MigrationReceiptBundle {
  readonly version: 1
  readonly run: MigrationRun
  readonly tableReceipts: readonly TableReceipt[]
  readonly identityHighWater: readonly FoldedIdentityHighWater[]
  readonly records: readonly MigrationRecord[]
  readonly restrictions: readonly PersistedHistoryRestriction[]
  readonly units: readonly MigrationUnit[]
}
export type MigrationArchive = ArchivePayload & {
  readonly ref: ArchiveRef
  readonly unitId: string
}
