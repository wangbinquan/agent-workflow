import type { LogicalSchemaContract as ImportedLogicalSchemaContract } from '../../schema/contractTypes'
import type { ConversionPlanSection } from './plan'
import type {
  ConversionBlock,
  MigrationRecord,
  TableReceipt,
  UnitOutput,
  RowDisposition,
  EncodedKey,
  LoadRejectionDecision,
  SourcePhase,
  TargetLoadRejection,
  TaskSettlement,
} from './types'

export interface ConversionRunBinding {
  readonly sourceContract?: ImportedLogicalSchemaContract

  readonly planDigest: string
  readonly sourceWatermark: string
  readonly sourceVersion: string
  readonly sourceGenerationId: string
  readonly targetGeneration: string
  readonly converterVersion: string
  readonly ruleSetDigest: string
  readonly preUpgradeWatermark: string | null
  readonly stagingDigest: string
  readonly lookupDigest: string
}
export interface ConversionSinkOpened {
  readonly committedUnitIds: ReadonlySet<string>
  /**
   * RFC-626: for every committed unit that set rows aside because the target refused them,
   * the decisions exactly as that unit persisted them. The engine applies them before it
   * converts the unit again, so the replayed output has the committed digest.
   */
  readonly loadRejections?: ReadonlyMap<string, readonly LoadRejectionDecision[]>
}
export interface ConversionSink {
  /** Persist the entire binding; reject any difference, including on a previously finished run. */
  open(binding: ConversionRunBinding): Promise<ConversionSinkOpened>
  /**
   * Atomically commit rows and all evidence. Equal unit id + digest is a no-op; unequal digest must throw.
   * RFC-626: with automatic resolution a sink whose target refused rows commits nothing and
   * returns every refused row of this attempt; the engine sets their source rows aside and
   * commits the unit again.
   */
  commitUnit(
    output: UnitOutput,
  ): Promise<void | { readonly rejected: readonly TargetLoadRejection[] }>
  finish(summary: ConversionSummary): Promise<void>
}
/** RFC-626: the report lists at most this many rows per kind; totals stay exact. */
export const RESOLUTION_LIST_LIMIT = 1000
/** RFC-626: what the conversion itself decided. Finalize dispositions are reported separately. */
export interface ConversionResolutions {
  readonly settledTasks: readonly TaskSettlement[]
  readonly setAside: {
    readonly total: number
    readonly rows: readonly {
      readonly sourcePhase: SourcePhase
      readonly sourceTable: string
      readonly sourceKey: EncodedKey
      readonly code: string
    }[]
  }
  readonly missingContent: {
    readonly total: number
    readonly rows: readonly {
      readonly sourceTable: string
      readonly sourceKey: EncodedKey
      readonly sourceColumn: string
      readonly reference: string | null
      readonly state: string
      /** The one task the referring source row belongs to; null for none or several (§3.7). */
      readonly taskId: string | null
    }[]
  }
  /**
   * Rows that were converted with a marker instead of blocking (a schedule kept disabled, a
   * skill kept quarantined, a reference cleared): counted by decision code, and listed up to
   * the limit when the rule named the row in its decision.
   */
  readonly kept: {
    readonly total: number
    readonly byCode: Readonly<Record<string, number>>
    readonly rows: readonly {
      readonly sourceTable: string
      readonly sourceKey: EncodedKey
      readonly code: string
    }[]
  }
  /** Acknowledgements the upgrade gave in place of a person, counted by the code acknowledged. */
  readonly acknowledged: {
    readonly total: number
    readonly byCode: Readonly<Record<string, number>>
  }
}
export interface ConversionSummary {
  readonly status: 'converted' | 'blocked'
  readonly tableReceipts: readonly TableReceipt[]
  readonly blocks: readonly ConversionBlock[]
  readonly records: readonly MigrationRecord[]
  /** V3 includes each restriction in its reviewable MigrationPlan, alongside blocks. */
  readonly historyOnly: readonly RowDisposition[]
  readonly stagingDigest: string
  readonly plan: ConversionPlanSection
  /** RFC-626: present with automatic resolution; decisions of the conversion stage only. */
  readonly resolutions?: ConversionResolutions
}
