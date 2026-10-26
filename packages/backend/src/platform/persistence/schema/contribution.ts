// RFC-395 I-a: ordered, serializable definitions owned by their contributing context.
import type { CodecName } from './codecs'
import type { SchemaExpression } from './expressions'
import type { RowRule } from './rowRules'
import type { InstallSeed } from './seeds'
import type { TableDisposition } from './contractTypes'

export type ColumnDefault =
  | { readonly kind: 'none' | 'implicit-primary' | 'identity' }
  | { readonly kind: 'literal'; readonly value: string | number | boolean | null }
  | { readonly kind: 'expression'; readonly expression: SchemaExpression }
export interface ColumnDefinition {
  readonly name: string
  readonly codec: CodecName
  readonly nullable: boolean
  /** Inline primary key; composite keys are declared on the table. */
  readonly primary: boolean
  readonly default: ColumnDefault
  /** Preserve metadata from reused legacy SQLite builders, even on non-unique columns. */
  readonly sqliteUniqueName?: string
  readonly unique?: string
  readonly uniqueNulls?: UniqueNullSemantics
  readonly enumValues?: readonly string[]
  readonly originalTextDigest?: boolean
  readonly document?:
    | { readonly kind: 'content-ref'; readonly version: 1; readonly inlineBytesColumn: string }
    | { readonly kind: 'requested-source'; readonly version: 1 | 2 }
  readonly highWater?: 'preserve-source-high-water'
}
export interface SchemaForeignKey {
  readonly name: string
  readonly columns: readonly string[]
  readonly foreignTable: string
  readonly foreignColumns: readonly string[]
  readonly onDelete: 'no action' | 'restrict' | 'cascade' | 'set null' | 'set default'
  readonly onUpdate: 'no action' | 'restrict' | 'cascade' | 'set null' | 'set default'
  readonly lifecycle: string
}
export type UniqueNullSemantics = 'distinct' | 'not-distinct'
export interface SchemaIndex {
  readonly name: string
  readonly unique: boolean
  readonly nulls: UniqueNullSemantics
  readonly columns: readonly SchemaExpression[]
  readonly where: SchemaExpression | null
}
export interface TableDefinition {
  readonly id: string
  readonly schemaSymbol: string
  readonly owner: string
  readonly version: number
  readonly columns: Readonly<Record<string, ColumnDefinition>>
  readonly primaryKey: readonly string[]
  readonly migrationKey: readonly string[]
  readonly unique: readonly {
    readonly name: string
    readonly columns: readonly string[]
    readonly nulls: UniqueNullSemantics
  }[]
  readonly foreignKeys: readonly SchemaForeignKey[]
  readonly checks: readonly { readonly name: string; readonly expression: SchemaExpression }[]
  readonly indexes: readonly SchemaIndex[]
  readonly retention: {
    readonly class: 'archive-only' | 'owner-managed-business' | 'owner-managed-operational'
    readonly rule: string
  }
  readonly migrationPolicy: TableDisposition
  readonly rowRules?: readonly RowRule[]
}
export interface SchemaContribution {
  readonly owner: string
  readonly version: number
  readonly tables: readonly TableDefinition[]
  readonly seeds?: readonly InstallSeed[]
  /** Explicit target NULL semantics for retained inline unique columns, without cloning their table. */
  readonly indexUniqueNulls?: readonly {
    readonly table: string
    readonly index: string
    readonly nulls: UniqueNullSemantics
  }[]
  readonly columnUniqueNulls?: readonly {
    readonly table: string
    readonly column: string
    readonly nulls: UniqueNullSemantics
  }[]
}
