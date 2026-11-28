import type { DatabaseProvider } from '../../databaseProviders'
import type { SourcePreflight } from '../sourceTypes'
import type { SchemaRegistry } from '../../schema/registry'
import type { ContentInventory } from './content'
import type { BootUpgradeFacts } from './bootUpgradeFacts'
import type { LookupBuilder, LookupKey, LookupReader, LookupResolver } from './lookups'
import type { StagedReader } from './staging'
import type { DecodedSourceRow } from '../sourceTypes'
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
  TargetValue,
  OperatorDecision,
  ConversionResolution,
  TaskSettlement,
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
  /**
   * RFC-626: claimed tables whose rows keep their table and key in the target although the
   * rule as a whole converts. A table that moves from the generic copy into a group rule
   * (the operation records of a skill) keeps the class its rows always had.
   */
  readonly preservedClaims?: readonly string[]
  readonly codecTakeovers?: readonly {
    readonly table: string
    readonly columns: readonly string[]
  }[]
  /** RFC-626: this rule converts part of a task's execution chain; see `SettlesDeclaration`. */
  readonly settles?: SettlesDeclaration
  /**
   * RFC-626: with automatic resolution, rows the frozen codec could not decode are handed to
   * the rule (`codecFailure` set, `canonical` and `raw` as read) instead of being set aside
   * before it runs. For a rule that has to account for every row of its table in one output —
   * an archive of a whole table, which the product later expects to be complete. The rule
   * stores such a row as it was read and records its own decision for it.
   */
  readonly takesUndecodedRows?: boolean
  convert(unit: ConversionUnit, ctx: RuleContext): void | Promise<void>
}
/**
 * RFC-626: declared by every rule and validator that may call `blockExecutable`, and by every
 * rule whose rows an unfinished task needs in order to continue. With automatic resolution a
 * row of such a rule that is about to be set aside ends the unfinished tasks it belongs to.
 */
export interface SettlesDeclaration {
  /**
   * The tasks this row may end. Default: the text `task_id` of the row, `id` for `tasks`,
   * otherwise undefined. Undefined means the row itself cannot tell (discovery then always
   * includes the row); an empty array means the row concerns no task.
   */
  tasksOf?(row: SourceRow, lookup: LookupResolver): readonly string[] | undefined
  /**
   * For a rule converted by group: tasks that cover every row of one group — for each row of
   * the group, `tasksOf` (or its default) lies within them. Discovery then leaves a group
   * none of whose tasks can continue unread. Undefined means the group key cannot tell, and
   * the group is read. Declared by the rule and by every validator of its tables that
   * declares `settles`, or discovery reads every group as before. Only an optimisation: what
   * discovery finds must not change by declaring it.
   */
  tasksOfGroup?(groupKey: string, lookup: LookupResolver): readonly string[] | undefined
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
  /**
   * RFC-626: `operator` keeps every block for a person to decide (the manual flow and the
   * default). `automatic` is the automatic upgrade: a rule that has a way to keep the row
   * takes it instead of blocking.
   */
  readonly resolution: ConversionResolution
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
  /**
   * RFC-626: "this task could continue, so the row blocks". With `operator` resolution it is
   * `block(block)`, byte for byte. With `automatic` resolution the task is ended during
   * discovery instead, and reaching this call afterwards is an engine error. Only rules and
   * validators that declare `settles` may call it.
   */
  blockExecutable(
    task: { readonly taskId: string; readonly status: string },
    block: ConversionBlock,
  ): void
  record(record: MigrationRecord, origin?: SourceRow): void
}
/** RFC-626: a validator's way to say `blockExecutable`; a plain block stays a plain block. */
export interface ExecutableValidatorBlock {
  readonly executable: { readonly taskId: string; readonly status: string }
  readonly block: ConversionBlock
}
export interface RowValidator {
  readonly ref: RuleRef
  readonly table: string
  readonly sourcePhase?: SourcePhase
  readonly lookups?: readonly LookupKey<unknown>[]
  /** RFC-626: required when `validate` returns an `ExecutableValidatorBlock`. */
  readonly settles?: SettlesDeclaration
  validate(
    row: SourceRow,
    ctx: RuleContext,
  ):
    | readonly (ConversionBlock | ExecutableValidatorBlock)[]
    | Promise<readonly (ConversionBlock | ExecutableValidatorBlock)[]>
}
export interface ConversionSourceCatalog {
  readonly preflight: SourcePreflight
  readonly preUpgradePreflight?: SourcePreflight
  readonly target: SchemaRegistry
  readonly bootUpgradeFacts?: BootUpgradeFacts
}
/**
 * RFC-626: what ending a task changes in this module's rows, and which other tasks it takes
 * along. The engine iterates to a fixed point and calls these; it knows no table or column.
 */
export interface SettlementContribution {
  readonly settlers: readonly TaskSettler[]
  /** Tasks that end because already settled ones do (a canceled parent's cancelable children). */
  expand?(input: {
    readonly settled: ReadonlyMap<string, TaskSettlement>
    readonly staged: StagedReader
  }): readonly TaskSettlement[]
}
export interface TaskSettler {
  /** Tables this settler reads, with the column that holds the task id (`id` for `tasks`). */
  readonly tables: readonly {
    readonly table: string
    readonly taskColumn: string
    /** False for a table the settler only reads. Default true. */
    readonly write?: boolean
    /**
     * For a table whose rows point at rows of the task instead of at the task: the rows whose
     * `taskColumn` holds the `keyColumn` value of one of the task's rows in `via.table`,
     * another table of this settler that is selected by task. (A replay decision is bound to
     * an intent of the task; it carries no column with that task's id.)
     */
    readonly via?: { readonly table: string; readonly keyColumn: string }
  }[]
  /**
   * Receives every staged row of one settled task in those tables, as staged before any
   * settler ran; returns the rows to rewrite with their complete new decoded values.
   */
  settle(
    rows: ReadonlyMap<string, readonly SourceRow[]>,
    ctx: { readonly settlement: TaskSettlement; readonly planTime: number },
  ): readonly {
    readonly table: string
    readonly key: EncodedKey
    readonly values: DecodedSourceRow
  }[]
}
/**
 * RFC-626: a reference the referring row survives without. Applied where the conversion finds
 * the referenced row absent from the source and again when the target is finalized, so the
 * outcome does not depend on when the referenced row dropped out. Foreign keys the target
 * schema declares `set null` are detached without a declaration here.
 */
export interface ReferenceKeepPolicy {
  /** Target table of the referring row and the name of its foreign key. */
  readonly table: string
  readonly foreignKey: string
  readonly action:
    | { readonly kind: 'detach' }
    /** Point the foreign key columns at a required seed row instead. */
    | { readonly kind: 'substitute'; readonly values: Readonly<Record<string, TargetValue>> }
}
export interface ConversionContribution {
  readonly rules: readonly ConversionRule[]
  readonly lookups: readonly LookupBuilder<unknown>[]
  readonly validators: readonly RowValidator[]
  /** RFC-626: see `SettlementContribution`. */
  readonly settlement?: SettlementContribution
  /** RFC-626: see `ReferenceKeepPolicy`. */
  readonly references?: readonly ReferenceKeepPolicy[]
  /** Bind immutable plan/freeze facts before lookups or units execute. */
  withBootUpgrade?(facts: BootUpgradeFacts): ConversionContribution
  /** Stage B expands admitted extra/retired/metadata tables without editing the assembly. */
  forSource?(catalog: ConversionSourceCatalog): readonly ConversionRule[]
}
