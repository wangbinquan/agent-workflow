// RFC-395 I-a: concise declarations expand to the complete, serializable schema contract.
import type { CodecName } from './codecs'
import type { ColumnDefault, SchemaForeignKey, SchemaIndex, TableDefinition } from './contribution'
import type { SchemaExpression } from './expressions'

type Literal = string | number | boolean | null
export interface ColumnOptions {
  readonly nullable?: boolean
  readonly primary?: boolean
  readonly default?: Literal | SchemaExpression
  readonly unique?: string
  readonly sqliteUniqueName?: string
  readonly originalTextDigest?: boolean
  readonly highWater?: 'preserve-source-high-water'
}
type DefaultFor<C extends CodecName, O extends ColumnOptions> = O extends { default: infer D }
  ? [D] extends [SchemaExpression]
    ? { readonly kind: 'expression'; readonly expression: D }
    : { readonly kind: 'literal'; readonly value: D }
  : C extends 'identity'
    ? { readonly kind: 'identity' }
    : C extends 'int'
      ? O extends { primary: true }
        ? { readonly kind: 'implicit-primary' }
        : { readonly kind: 'none' }
      : { readonly kind: 'none' }
type BuiltColumn<N extends string, C extends CodecName, O extends ColumnOptions> = Omit<
  O,
  'default' | 'nullable' | 'primary'
> & {
  readonly name: N
  readonly codec: C
  readonly nullable: O extends { nullable: infer V } ? V : false
  readonly primary: O extends { primary: infer V } ? V : false
  readonly default: DefaultFor<C, O>
} & (C extends 'jsonText'
    ? { readonly originalTextDigest: O extends { originalTextDigest: infer V } ? V : true }
    : C extends 'identity' | 'seq'
      ? { readonly highWater: 'preserve-source-high-water' }
      : object)

function columnBuilder<const C extends CodecName>(codec: C) {
  return <const N extends string, const O extends ColumnOptions = Record<never, never>>(
    name: N,
    options: O = {} as O,
  ): BuiltColumn<N, C, O> => {
    const { default: value, nullable = false, primary = false, ...rest } = options
    const defaultValue: ColumnDefault =
      value !== undefined
        ? typeof value === 'object' && value !== null
          ? { kind: 'expression', expression: value }
          : { kind: 'literal', value }
        : {
            kind:
              codec === 'identity'
                ? 'identity'
                : codec === 'int' && primary
                  ? 'implicit-primary'
                  : 'none',
          }
    return {
      name,
      codec,
      nullable,
      primary,
      default: defaultValue,
      ...(codec === 'jsonText' ? { originalTextDigest: true } : {}),
      ...(codec === 'identity' || codec === 'seq'
        ? { highWater: 'preserve-source-high-water' }
        : {}),
      ...rest,
    } as BuiltColumn<N, C, O>
  }
}
function enumColumn<
  const N extends string,
  const V extends readonly [string, ...string[]],
  const O extends ColumnOptions = Record<never, never>,
>(name: N, values: V, options: O = {} as O) {
  return { ...columnBuilder('enum')(name, options), enumValues: values }
}
export const column = {
  id: columnBuilder('id'),
  text: columnBuilder('text'),
  enum: enumColumn,
  bool: columnBuilder('bool'),
  int: columnBuilder('int'),
  bigint: columnBuilder('bigint'),
  epochMs: columnBuilder('epochMs'),
  durationMs: columnBuilder('durationMs'),
  real: columnBuilder('real'),
  jsonText: columnBuilder('jsonText'),
  jsonDoc: columnBuilder('jsonDoc'),
  rawJson: columnBuilder('rawJson'),
  bytes: columnBuilder('bytes'),
  seq: columnBuilder('seq'),
  identity: columnBuilder('identity'),
  slotKey: columnBuilder('slotKey'),
}

export const retention = {
  archive: {
    class: 'archive-only',
    rule: 'Preserve the RFC-349 logical archive and source generation; never restore into the active PostgreSQL schema.',
  },
  business: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  operational: {
    class: 'owner-managed-operational',
    rule: 'The owning bounded context defines retention and archive jobs through its application port.',
  },
} as const

type TableInput = Pick<TableDefinition, 'id' | 'schemaSymbol' | 'columns' | 'retention'> &
  Partial<Omit<TableDefinition, 'id' | 'schemaSymbol' | 'columns' | 'retention' | 'owner'>>
type TableDefaults = {
  readonly version: 1
  readonly unique: readonly []
  readonly foreignKeys: readonly []
  readonly checks: readonly []
  readonly indexes: readonly []
  readonly migrationPolicy: 'KEEP'
}
type DefinedTable<T extends TableInput, O extends string> = Omit<TableDefaults, keyof T> &
  Omit<T, 'owner' | 'primaryKey' | 'migrationKey'> & {
    readonly owner: O
    readonly primaryKey: readonly string[]
    readonly migrationKey: readonly string[]
  }
/** The owner is explicit once per contribution, never derived from a table name. */
export function defineContribution<const O extends string>(owner: O) {
  return {
    table<const T extends TableInput>(definition: T): DefinedTable<T, O> {
      const primaryKey =
        definition.primaryKey ??
        Object.values(definition.columns)
          .filter((column) => column.primary)
          .map((column) => column.name)
      return {
        version: 1,
        unique: [],
        foreignKeys: [],
        checks: [],
        indexes: [],
        migrationPolicy: 'KEEP',
        ...definition,
        owner,
        primaryKey,
        migrationKey: definition.migrationKey ?? primaryKey,
      } as DefinedTable<T, O>
    },
    contribution<const T extends readonly TableDefinition[]>(tables: T) {
      return { owner, version: 1, tables } as const
    },
  }
}

export function index(
  name: string,
  columns: readonly (string | SchemaExpression)[],
  options: { readonly unique?: boolean; readonly where?: SchemaExpression } = {},
): SchemaIndex {
  return {
    name,
    unique: options.unique ?? false,
    nulls: 'distinct',
    columns: columns.map((column) =>
      typeof column === 'string' ? { kind: 'column', name: column } : column,
    ),
    where: options.where ?? null,
  }
}
export function foreignKey(
  name: string,
  columns: readonly string[],
  foreignTable: string,
  foreignColumns: readonly string[],
  options: Partial<Pick<SchemaForeignKey, 'onDelete' | 'onUpdate' | 'lifecycle'>> = {},
): SchemaForeignKey {
  const { onDelete = 'no action', onUpdate = 'no action' } = options
  return {
    name,
    columns,
    foreignTable,
    foreignColumns,
    onDelete,
    onUpdate,
    lifecycle:
      options.lifecycle ??
      `Preserve epoch-1 ${onDelete} delete and ${onUpdate} update semantics; target is a logical table reference.`,
  }
}
/** Epoch-1 raw spelling is frozen; target contributions can use the typed AST. */
export function raw(sqlite: string, postgresql = sqlite): SchemaExpression {
  return {
    kind: 'raw',
    reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
    sqlite,
    postgresql,
  }
}
