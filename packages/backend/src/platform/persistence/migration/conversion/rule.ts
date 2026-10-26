import type { DatabaseProvider } from '../../databaseProviders'
import type { SourcePreflight } from '../sourceTypes'
import type { SchemaRegistry } from '../../schema/registry'
import type { ContentInventory } from './content'
import type { BootUpgradeFacts } from './bootUpgradeFacts'
import type { LookupBuilder, LookupKey, LookupReader } from './lookups'
import type { TargetRegistryView } from './targetRows'
import type { LegacyEvidence } from './evidence'
import type {
  ArtifactReceipt,
  ArchivePayload,
  ArchiveRef,
  ConversionBlock,
  EncodedKey,
  MigrationRecord,
  RowDisposition,
  RuleRef,
  SourcePhase,
  SourceRow,
  TargetRow,
  OperatorDecision,
} from './types'

export type UnitSpec =
  | { readonly kind: 'source-chunk'; readonly table: string }
  | { readonly kind: 'raw-chunk'; readonly table: string }
  | {
      readonly kind: 'group'
      readonly driver: string | LookupKey<unknown>
      readonly groupColumn: string
      readonly members: readonly { readonly table: string; readonly column: string }[]
      readonly groupsPerUnit?: number
    }
export interface ConversionUnit {
  readonly rows: ReadonlyMap<string, readonly SourceRow[]>
  readonly groupKeys?: readonly string[]
}
export interface ConversionRule {
  readonly ref: RuleRef
  readonly owner: string
  readonly claims: readonly string[]
  readonly sourcePhase?: SourcePhase
  readonly produces: readonly { readonly table: string; readonly partition?: string }[]
  readonly lookups: readonly LookupKey<unknown>[]
  readonly unit: UnitSpec
  readonly disposition?: 'converted' | 'preserved'
  readonly codecTakeovers?: readonly {
    readonly table: string
    readonly columns: readonly string[]
  }[]
  convert(unit: ConversionUnit, ctx: RuleContext): void | Promise<void>
}
export interface RuleContext {
  readonly sourceVersion: string
  readonly sourceProvider: DatabaseProvider
  readonly sourceGenerationId: string
  readonly preflight: SourcePreflight
  readonly preUpgradePreflight?: SourcePreflight
  readonly planTime: number
  readonly target: TargetRegistryView
  lookup<V>(key: LookupKey<V>): LookupReader<V>
  readonly ids: {
    child(namespace: string, parent: EncodedKey, discriminator?: string | number): string
  }
  readonly content: ContentInventory
  readonly operatorDecisions?: OperatorDecisionAccess
  readonly out: RuleOutput
}
export interface OperatorDecisionAccess {
  find(row: SourceRow, blockCode: OperatorDecision['blockCode']): OperatorDecision | null
  /** Consume only when the row actually receives its acknowledged disposition. */
  consume(row: SourceRow, blockCode: OperatorDecision['blockCode']): OperatorDecision | null
}
export interface RuleOutput {
  row(table: string, values: TargetRow, origin: SourceRow | null): void
  exception(disposition: Omit<RowDisposition, 'rule'>): void
  evidence(evidence: LegacyEvidence): void
  artifact(receipt: ArtifactReceipt): void
  archive(payload: ArchivePayload): ArchiveRef
  block(block: ConversionBlock): void
  record(record: MigrationRecord, origin?: SourceRow): void
}
export interface RowValidator {
  readonly ref: RuleRef
  readonly table: string
  readonly sourcePhase?: SourcePhase
  readonly lookups?: readonly LookupKey<unknown>[]
  validate(
    row: SourceRow,
    ctx: RuleContext,
  ): readonly ConversionBlock[] | Promise<readonly ConversionBlock[]>
}
export interface ConversionSourceCatalog {
  readonly preflight: SourcePreflight
  readonly preUpgradePreflight?: SourcePreflight
  readonly target: SchemaRegistry
  readonly bootUpgradeFacts?: BootUpgradeFacts
}
export interface ConversionContribution {
  readonly rules: readonly ConversionRule[]
  readonly lookups: readonly LookupBuilder<unknown>[]
  readonly validators: readonly RowValidator[]
  /** Bind immutable plan/freeze facts before lookups or units execute. */
  withBootUpgrade?(facts: BootUpgradeFacts): ConversionContribution
  /** Stage B expands admitted extra/retired/metadata tables without editing the assembly. */
  forSource?(catalog: ConversionSourceCatalog): readonly ConversionRule[]
}
