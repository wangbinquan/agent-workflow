import type { LogicalSchemaContract as ImportedLogicalSchemaContract } from '../../schema/contractTypes'
import type { ConversionPlanSection } from './plan'
import type {
  ConversionBlock,
  MigrationRecord,
  TableReceipt,
  UnitOutput,
  RowDisposition,
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
export interface ConversionSink {
  /** Persist the entire binding; reject any difference, including on a previously finished run. */
  open(binding: ConversionRunBinding): Promise<{ readonly committedUnitIds: ReadonlySet<string> }>
  /** Atomically commit rows and all evidence. Equal unit id + digest is a no-op; unequal digest must throw. */
  commitUnit(output: UnitOutput): Promise<void>
  finish(summary: ConversionSummary): Promise<void>
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
}
