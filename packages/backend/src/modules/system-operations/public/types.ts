// RFC-346 — exact application DTOs for backup/restore administration.

import type { z } from 'zod'
import type {
  activateLocalRestoreOptionsSchema,
  backupResultViewSchema,
  cancelStagedRestoreResultSchema,
  localRestoreActivationSchema,
  recoveryStatusViewSchema,
  requestBackupInputSchema,
  restorePlanOptionsSchema,
  restorePlanViewSchema,
  stageRestoreOptionsSchema,
  stageRestoreResultSchema,
} from '../application/systemOperationContracts'

export interface ReclaimableDiskItem {
  readonly id: 'retired-runtime-stores'
  readonly path: string
  readonly exists: boolean
  readonly bytes: number
  readonly entries: number
}

export interface MaintenanceDiskReport {
  readonly items: readonly ReclaimableDiskItem[]
  /** Provider-owned estimate of storage reusable by database maintenance. */
  readonly dbFreelistBytes: number
  /** Current physical database size reported by the selected provider. */
  readonly dbFileBytes: number
}

// RFC-349 — the system-operations public contract is shared byte-for-byte with
// Settings. Keep provider clients and raw connection URLs outside this surface.
export {
  type DatabaseMigrationArtifactInput,
  type DatabaseMigrationArtifactKind,
  type DatabaseMigrationArtifactView,
  type DatabaseMigrationLegacyChunkInput,
  type DatabaseMigrationLegacyTableInput,
  type DatabaseMigrationLegacyTableView,
  type DatabaseMigrationListView,
  type DatabaseMigrationOperationInput,
  type DatabaseMigrationPreflightInput,
  type DatabaseMigrationPreflightView,
  type DatabaseMigrationStatusView,
  type DatabaseMigrationTargetView,
  type DatabaseRuntimeOverview,
  type StartDatabaseMigrationInput,
} from '@agent-workflow/shared'

// Authority-bearing contexts stay on executable commands/queries. This file
// remains DTO/ref-only so request authority cannot leak through public types.
declare const localSystemOperationContextBrand: unique symbol
declare const restoreArtifactRefBrand: unique symbol

export interface LocalSystemOperationContext {
  readonly [localSystemOperationContextBrand]: 'local-system-operation-context'
}

export interface RestoreArtifactRef {
  readonly [restoreArtifactRefBrand]: 'restore-artifact-ref'
}
export type RequestBackupInput = z.infer<typeof requestBackupInputSchema>
export type BackupResultView = z.infer<typeof backupResultViewSchema>
export type RestorePlanOptions = z.infer<typeof restorePlanOptionsSchema>

export interface PlanLocalRestoreInput extends RestorePlanOptions {
  readonly artifactRef: RestoreArtifactRef
}
export type RestorePlanView = z.infer<typeof restorePlanViewSchema>
export type StageRestoreOptions = z.infer<typeof stageRestoreOptionsSchema>

export interface StageRestoreInput extends StageRestoreOptions {
  readonly artifactRef: RestoreArtifactRef
}
export type StageRestoreResult = z.infer<typeof stageRestoreResultSchema>
export type CancelStagedRestoreResult = z.infer<typeof cancelStagedRestoreResultSchema>
export type ActivateLocalRestoreOptions = z.infer<typeof activateLocalRestoreOptionsSchema>

export interface ActivateLocalRestoreInput extends ActivateLocalRestoreOptions {
  readonly artifactRef: RestoreArtifactRef
}
export type LocalRestoreActivationResult = z.infer<typeof localRestoreActivationSchema>
export type RecoveryStatusView = z.infer<typeof recoveryStatusViewSchema>
export type { DaemonRuntimeInfo } from '../domain/daemonRuntime'

import type {
  ValidationReportSchema,
  HistoryRestrictionSchema,
  MigrationRowDispositionSchema,
  ConversionBlockSchema,
} from '../domain/epochSwitch/documents'

type EpochDatabaseProvider = z.infer<typeof EpochProviderSchema>
export type EpochValidationView = z.infer<typeof ValidationReportSchema>
export interface EpochHistoryRestrictionView {
  readonly runId: string
  readonly unitId: string
  readonly ordinal: number
  readonly sourceTable: string
  readonly sourcePhase: 'current' | 'pre-upgrade'
  readonly sourceKey: `mk1:${string}`
  readonly decisionCode: string
  readonly history: z.infer<typeof HistoryRestrictionSchema>
}
import type { MigrationPlanBlock, MigrationPlanDocument } from '../domain/epochSwitch/documents'
import type {
  EpochProviderSchema,
  EpochSwitchFailure,
  EpochSwitchJournal,
  EpochSwitchKind,
  EpochSwitchPhase,
  EpochSwitchStatus,
} from '../domain/epochSwitch/model'

export type { TraceInput } from '@/platform/persistence/migration/run/types'
export interface EpochArtifactReceiptView {
  readonly sourceTable: string
  readonly sourceKey: `mk1:${string}`
  readonly sourceColumn: string
  readonly originalReference: string | null
  readonly target: {
    readonly table: string
    readonly key: `mk1:${string}`
    readonly contentId: string | null
    readonly backend: 'inline' | 'local-file' | 'database-bytes' | 'object'
  }
  readonly bytes: { readonly sha256: string; readonly size: number } | null
  readonly publication: 'not-required' | 'existing-ready' | 'requires-publication'
  readonly missing: {
    readonly state: 'originally-absent' | 'missing-at-freeze'
    readonly evidence: string
  } | null
}
export interface MigrationTraceResult {
  readonly runId: string
  readonly sourceTable: string
  readonly sourcePhase: 'current' | 'pre-upgrade'
  readonly sourceKey: `mk1:${string}`
  readonly proof: 'row-disposition' | 'unit-range' | 'group-unit' | 'replay' | 'not-found'
  readonly class: 'converted' | 'preserved' | 'archived' | 'blocked' | null
  readonly dispositions: readonly z.infer<typeof MigrationRowDispositionSchema>[]
  readonly unit: {
    readonly unitId: string
    readonly rule: { readonly id: string; readonly version: number }
    readonly receiptDigest: string
    readonly range: { readonly firstKey: `mk1:${string}`; readonly lastKey: `mk1:${string}` } | null
    readonly groups: { readonly first: string | null; readonly last: string | null } | null
  } | null
  readonly targets: readonly {
    readonly table: string
    readonly key: `mk1:${string}`
    readonly probed: boolean
    readonly present: boolean
  }[]
  readonly artifacts: readonly EpochArtifactReceiptView[]
  readonly restrictions: readonly z.infer<typeof HistoryRestrictionSchema>[]
  readonly blocks: readonly z.infer<typeof ConversionBlockSchema>[]
  readonly archive: `archive:sha256:${string}` | null
}

/** Hosted run Jobs print CS_DATABASE_MIGRATION_PLAN=<JSON of this value> when approval is needed. */
export interface EpochSwitchApprovalRequest {
  readonly operationId: string
  readonly runId: string
  readonly planDigest: string
  readonly approvalDigest: string
  readonly planPath: string | null
}
export interface EpochSwitchPlanView {
  readonly operationId: string
  readonly plan: MigrationPlanDocument
  readonly jsonPath: string | null
  readonly markdownPath: string | null
  readonly acknowledgeable: readonly MigrationPlanBlock[]
  readonly requiresApproval: boolean
  readonly guidance: readonly string[]
}
export interface EpochSwitchSummaryView {
  readonly mode?: 'auto'
  readonly operationId: string
  readonly kind: EpochSwitchKind
  readonly phase: EpochSwitchPhase
  readonly status: EpochSwitchStatus
  readonly sourceProvider: EpochDatabaseProvider
  readonly targetProvider: EpochDatabaseProvider
  readonly targetGenerationId: string | null
  readonly runId: string | null
  readonly updatedAt: number
  readonly failure: EpochSwitchFailure | null
}
export interface EpochSwitchStatusView extends EpochSwitchSummaryView {
  readonly journal: EpochSwitchJournal
  readonly validation: EpochValidationView | null
  readonly firstLiveWriteAt: number | null
  readonly rollback: { readonly allowed: boolean; readonly reason: string | null }
  readonly guidance: readonly string[]
  /** Present at awaiting-approval, including validated re-approval on a fresh hosted Job. */
  readonly approval?: EpochSwitchApprovalRequest
  /**
   * RFC-398 §3.5: an automatic PostgreSQL session's allocated targets and scratch databases are
   * never dropped automatically; status names each with its size and purpose.
   */
  readonly retainedDatabases?: readonly EpochRetainedDatabaseView[]
}
export interface EpochRetainedDatabaseView {
  readonly kind: 'target' | 'scratch'
  readonly database: string
  readonly runId: string
  readonly bytes: number | null
  readonly purpose: string
}
export interface TaskRestrictionView {
  readonly operationId: string
  readonly taskId: string
  readonly restrictions: readonly EpochHistoryRestrictionView[]
}
export type EpochSwitchTargetInput = {
  readonly provider: EpochDatabaseProvider
} & (
  | { readonly urlEnv?: string; readonly profileRef?: never }
  | { readonly urlEnv?: never; readonly profileRef: string }
)
export type EpochSwitchPlanInput = {
  readonly operationId?: string
  /** Used only when creating an operation; an automatic session persists intent first. */
  readonly requestedOperationId?: string
  readonly target?: EpochSwitchTargetInput
  readonly emptyTables?: readonly { readonly table: string; readonly reason: string }[]
  readonly rehearse?: boolean
  readonly chunkLimit?: number
} & (
  | { readonly scratchUrlEnv?: string; readonly scratchProfileRef?: never }
  | { readonly scratchUrlEnv?: never; readonly scratchProfileRef: string }
)

// RFC-398 design §1: public result contract for the automatic-upgrade CLI adapter.
export type { AutoUpgradeConclusion } from '../domain/epochSwitch/autoUpgrade'
