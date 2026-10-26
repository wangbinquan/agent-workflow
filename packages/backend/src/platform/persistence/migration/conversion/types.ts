import type { CanonicalLogicalRow, CanonicalLogicalValue } from '../legacy/logicalDatabaseArtifact'
import type { DecodedSourceRow, RawSourceRow, RawSourceCell } from '../sourceTypes'
import type { TableDefinition } from '../../schema/contribution'
import type { ColumnData } from '../../schema/neutral'
import { valueDigest } from './digest'

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }
export type SourceTable = string
export type TargetTable = string
export type MigrationKey = readonly CanonicalLogicalValue[]
export type EncodedKey = `mk1:${string}`
export type SourcePhase = 'current' | 'pre-upgrade'
export {
  OperatorDecisionSchema,
  type OperatorDecision,
} from '@/platform/contracts/migrationDecision'

/** Same frozen row evidence is used by the plan, the rule and replay. */
export function operatorDecisionRowDigest(row: SourceRow): string {
  return valueDigest({
    table: row.table,
    phase: row.phase,
    key: row.encodedKey,
    canonical: row.canonical,
    raw: row.raw ?? null,
  })
}
export type TargetValue = string | number | bigint | boolean | Uint8Array | null
export type TargetRow = Readonly<Record<string, TargetValue>>
export type TargetRowOf<D extends TableDefinition> = {
  readonly [P in keyof D['columns'] as D['columns'][P]['name']]:
    | ColumnData<D['columns'][P]>
    | (D['columns'][P]['nullable'] extends true ? null : never)
}
export interface RuleRef {
  readonly id: string
  readonly version: number
}
export interface LookupVersion extends RuleRef {
  readonly digest: string
}
export interface SourceRef {
  readonly table: string
  readonly key: EncodedKey
  readonly phase: SourcePhase
}
export interface SourceCodecTakeover {
  readonly column: string
  readonly raw: RawSourceCell
  readonly message: string
}
export const HISTORY_EXECUTION_UNUSED_REASONS = ['null-envelope-nonce-unselected'] as const
export type HistoryExecutionUnusedReason = (typeof HISTORY_EXECUTION_UNUSED_REASONS)[number]
export type HistoryRestriction = {
  readonly taskId: string
  readonly runId: string | null
  readonly missingFields: readonly string[]
} & (
  | {
      readonly execution: 'retryable-history' | 'terminal-history'
      readonly executionUse?: never
      readonly reason?: never
    }
  | {
      readonly execution: 'executable'
      readonly executionUse: 'none'
      readonly reason: HistoryExecutionUnusedReason
    }
)
export interface SourceRow {
  readonly table: string
  readonly phase: SourcePhase
  readonly key: MigrationKey
  readonly encodedKey: EncodedKey
  readonly canonical: CanonicalLogicalRow
  readonly values: DecodedSourceRow
  /** Present for raw units and failed logical decoding; original storage evidence is never normalized. */
  readonly raw?: RawSourceRow
  /** Only failures not taken over by the claiming rule remain blocking here. */
  readonly codecFailure?: { readonly message: string; readonly columns: readonly string[] }
  readonly codecTakeovers?: readonly SourceCodecTakeover[]
}
export type DispositionClass = 'converted' | 'preserved' | 'archived' | 'blocked'
export type ExceptionKind =
  | 'derived-id'
  | 'merged'
  | 'deleted-placeholder'
  | 'history-only'
  | 'archived'
  | 'blocked'
  | 'conflict-resolved'
export interface TargetRef {
  readonly table: string
  readonly key: EncodedKey
}
export interface RowDisposition {
  readonly sourceTable: string
  readonly sourceKey: EncodedKey
  readonly sourcePhase?: SourcePhase
  readonly class: DispositionClass
  readonly kind: ExceptionKind
  readonly targets: readonly TargetRef[]
  readonly archive: ArchiveRef | null
  readonly rule: RuleRef
  readonly history?: HistoryRestriction
  /** Failed columns explicitly decided by this converted/history-only disposition. */
  readonly codecColumns?: readonly string[]
  readonly allocation?: {
    readonly column: string
    readonly value: string
    readonly sourceHighWater: string
  }
  readonly decision: { readonly code: string; readonly detail: JsonValue } | null
}
export interface ConversionBlock {
  readonly code: string
  readonly scope: 'global' | 'table' | 'row'
  readonly sourceTable: string | null
  readonly sourceKey: EncodedKey | null
  readonly sourcePhase?: SourcePhase
  readonly taskId: string | null
  readonly runId: string | null
  readonly missingFields: readonly string[]
  readonly detail: JsonValue
  readonly acknowledgeable?: boolean
}
export type ArchiveRef = `archive:sha256:${string}`
export interface ArchivePayload {
  readonly kind:
    | 'retired-table'
    | 'unknown-table'
    | 'dropped-by-chain'
    | 'source-journal'
    | 'deleted-row'
  readonly sourceTable: string
  readonly format: 'raw-chunk@1' | 'logical-row@1'
  readonly bytes: Uint8Array
  readonly rows: number
}
export interface ArtifactReceipt {
  readonly sourceTable: string
  readonly sourceKey: EncodedKey
  readonly sourceColumn: string
  readonly originalReference: string | null
  readonly target: TargetRef & {
    readonly contentId: string | null
    readonly backend: 'inline' | 'local-file' | 'database-bytes' | 'object'
  }
  readonly bytes: { readonly sha256: string; readonly size: number } | null
  readonly publication: 'not-required' | 'existing-ready' | 'requires-publication'
  readonly missing: null | {
    readonly state: 'originally-absent' | 'missing-at-freeze'
    readonly evidence: string
  }
}
export type MigrationRecord =
  | {
      readonly kind: 'identity-high-water'
      readonly table: string
      readonly column: string
      readonly value: string
      readonly basis: 'sequence' | 'max-row' | 'both'
      readonly warning?: string
    }
  | { readonly kind: 'source-journal'; readonly entries: JsonValue }
  | {
      readonly kind: 'source-generation'
      readonly generationId: string
      readonly evidence: JsonValue
    }
  | { readonly kind: 'writer-drain'; readonly payload: JsonValue }
  | { readonly kind: 'family-cutover-source'; readonly payload: JsonValue }
  | { readonly kind: 'source-metadata'; readonly table: string; readonly payload: JsonValue }
  | { readonly kind: 'decision'; readonly code: string; readonly payload: JsonValue }
export type UnitRef =
  | {
      readonly kind: 'source-chunk' | 'raw-chunk'
      readonly table: string
      readonly phase: SourcePhase
      readonly afterKey: EncodedKey | null
      readonly limit: number
    }
  | {
      readonly kind: 'group'
      readonly rule: string
      readonly index: number
      readonly firstGroup: string | null
      readonly lastGroup: string | null
    }
export type DispositionCounts = Readonly<Record<DispositionClass, number>>
export interface SourceReceipt {
  readonly table: string
  readonly phase: SourcePhase
  readonly rows: number
  readonly digest: string
  readonly keyDigest: string
  readonly firstKey: EncodedKey | null
  readonly lastKey: EncodedKey | null
  readonly counts: DispositionCounts
  readonly exceptions: number
  readonly historyOnly: number
}
export interface ChunkReceipt {
  readonly version: 1
  readonly unitId: string
  readonly unit: UnitRef
  readonly sourceVersion: string
  readonly rule: RuleRef
  readonly lookups: readonly LookupVersion[]
  readonly sources: readonly SourceReceipt[]
  readonly targets: readonly {
    readonly table: string
    readonly rows: number
    readonly digest: string
  }[]
  readonly counts: DispositionCounts & { readonly exceptions: number; readonly historyOnly: number }
  readonly digest: string
}
export interface TableReceipt {
  readonly sourceTable: string
  readonly sourcePhase: SourcePhase
  readonly sourceVersion: string
  readonly rowsRead: number
  readonly activeClaims: readonly {
    readonly sourceKey: EncodedKey
    readonly values: Readonly<Record<string, CanonicalLogicalValue>>
  }[]
  readonly targets: readonly { readonly table: string; readonly rows: number }[]
  readonly counts: DispositionCounts
  readonly exceptions: number
  readonly historyOnly: number
  readonly keyDigest: string
  readonly contentDigest: string
  readonly units: number
}
export interface UnitOutput {
  readonly receipt: ChunkReceipt
  readonly rows: readonly { readonly table: string; readonly rows: readonly TargetRow[] }[]
  readonly dispositions: readonly RowDisposition[]
  readonly artifacts: readonly ArtifactReceipt[]
  readonly archives: readonly (ArchivePayload & { readonly ref: ArchiveRef })[]
  readonly blocks: readonly ConversionBlock[]
  readonly records: readonly MigrationRecord[]
}
