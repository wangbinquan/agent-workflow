// RFC-359 T19h — immutable schema history and exact, replayable upgrade edges.
// This module never opens a database. Runtime admission and the artifact writer
// share this program; PostgreSQL executes only the verified statement sequence.

import type { ExpectedMigration } from '@/db/schemaAdmission'
import { sha256Hex } from '@/util/hash'
import {
  OBSERVATION_SOURCE_REVISION,
  OBSERVATION_SOURCE_REVISION_JOURNAL,
  type ObservationSourceRevisionContract,
} from './observationSourceRevisionSchema'
import {
  buildPostgresqlSchemaPlan,
  renderPostgresqlColumnSql,
  renderPostgresqlBaselineSql,
  POSTGRESQL_APPLICATION_SCHEMA,
  type PostgresqlSchemaPlan,
  type PostgresqlSchemaStatement,
} from './postgresqlSchema'
import {
  canonicalSchemaJson,
  createCanonicalFragmentCache,
  digestSchemaContract,
  withCanonicalFragmentCache,
  type LogicalIndexContract,
  type LogicalColumnContract,
  type LogicalSchemaContract,
  type LogicalTableContract,
  type OwnerContext,
} from './schemaContract'

export interface PostgresqlSchemaIdentity {
  readonly baselineId: string
  readonly contractDigest: string
  readonly planDigest: string
}

export interface PostgresqlSqliteMigrationIdentity {
  readonly count: number
  readonly last: Readonly<ExpectedMigration>
  readonly chainDigest: string
}

export interface PostgresqlMigrationVersion {
  readonly contract: LogicalSchemaContract
  readonly plan: PostgresqlSchemaPlan
  readonly sqliteMigrations: readonly Readonly<ExpectedMigration>[]
  readonly sqliteMigration: PostgresqlSqliteMigrationIdentity
}

export interface PostgresqlMigrationRoot extends PostgresqlMigrationVersion {
  readonly version: 1
  readonly baselineSqlDigest: string
  readonly legacyJournalDigest: string
}

interface LogicalIndexAddition {
  readonly tableId: string
  readonly position: number
  readonly index: LogicalIndexContract
}

/** A full unique index may be restricted to an explicit subset, preserving its
 * columns and every original row. The immutable ledger retains both predicates. */
export interface LogicalIndexPredicateReplacement {
  readonly tableId: string
  readonly name: string
  readonly fromExpression: null
  readonly toExpression: string
}

interface LogicalTableAddition {
  readonly position: number
  readonly table: LogicalTableContract
}

/**
 * RFC-366 — a named CHECK constraint whose expression changes while its table,
 * columns, codecs, keys and every other constraint stay exactly as they were.
 *
 * This is the one non-expand-only edge the sequence admits, and it exists
 * because widening a value domain is otherwise unreachable: `source_kind`,
 * `status`, `scope_type` and their siblings are CHECK lists, PostgreSQL has no
 * `ALTER CONSTRAINT ... CHECK`, and the logical contract is projected from the
 * same `db/schema.ts` both providers read — so a SQLite-only widening still
 * moves the contract digest and fails the head assertion. Admitting exactly
 * "replace a named check's expression, change nothing else" keeps the edge
 * reviewable: the replay below re-derives both the old and the new statement
 * from the projection, so a payload cannot smuggle in arbitrary DDL.
 */
export interface LogicalCheckReplacement {
  readonly tableId: string
  readonly name: string
  /** The expression BEFORE this upgrade — recorded so the edge reads both ways. */
  readonly fromExpression: string
  readonly toExpression: string
}

/**
 * RFC-366 — the SAME value domain as its table's CHECK, declared a second time
 * on the column (`text('source_kind', { enum: [...] })` in `db/schema.ts`).
 *
 * It carries no SQL of its own — the contract only reads it to decide the
 * provider type, and for these columns that stays `text` either way. It must
 * still travel with the check replacement, because leaving it out makes the two
 * projections of one domain disagree, and the contract digest would reject the
 * edge with no hint as to which half was missing.
 */
export interface LogicalColumnEnumReplacement {
  readonly tableId: string
  readonly column: string
  readonly fromValues: readonly string[]
  readonly toValues: readonly string[]
}

/** The executable pair a {@link LogicalCheckReplacement} projects to. */
export interface PostgresqlCheckReplacement {
  readonly logicalId: string
  readonly before: PostgresqlSchemaStatement
  readonly drop: PostgresqlSchemaStatement
  readonly after: PostgresqlSchemaStatement
}

export interface PostgresqlIndexUpgrade {
  /** V4 explicitly retires obsolete whole tables; existing migration artifacts stay immutable. */
  readonly retiredTables?: readonly string[]
  readonly version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
  /** V8 appends columns to existing KEEP tables; old artifacts omit this key. */
  readonly logicalColumns?: readonly LogicalColumnAddition[]
  /** V6 is metadata-only: ownership changes cannot alter any physical row or DDL. */
  readonly logicalOwners?: readonly LogicalOwnerReplacement[]
  /** V5 only: the exact legacy -> committed-row-journal clock transition. */
  readonly logicalSourceRevision?: LogicalSourceRevisionReplacement
  readonly sourceRevisionReplacements?: readonly PostgresqlSourceRevisionReplacement[]
  /** V2 adds whole new active tables; V1 artifacts remain byte-for-byte unchanged. */
  readonly logicalTables?: readonly LogicalTableAddition[]
  /** V3 replaces named CHECK expressions; V1/V2 artifacts never carry this key. */
  readonly logicalIndexPredicates?: readonly LogicalIndexPredicateReplacement[]
  readonly indexPredicateReplacements?: readonly PostgresqlCheckReplacement[]
  readonly logicalChecks?: readonly LogicalCheckReplacement[]
  readonly checkReplacements?: readonly PostgresqlCheckReplacement[]
  /** V3 only, and only when the same domain is also declared on the column. */
  readonly logicalEnums?: readonly LogicalColumnEnumReplacement[]
  readonly id: string
  readonly sequence: number
  readonly digest: string
  readonly previousEntryDigest: string
  readonly from: PostgresqlSchemaIdentity
  readonly to: PostgresqlSchemaIdentity
  readonly logicalIndexes: readonly LogicalIndexAddition[]
  readonly indexAdditions: readonly {
    readonly position: number
    readonly statement: PostgresqlSchemaStatement
  }[]
  readonly contractRow: {
    readonly beforeDigest: string
    readonly after: PostgresqlSchemaStatement
  }
  readonly sqliteMigration: {
    readonly from: PostgresqlSqliteMigrationIdentity
    readonly to: PostgresqlSqliteMigrationIdentity
    readonly appended: readonly Readonly<ExpectedMigration>[]
  }
  readonly executableStatements: readonly PostgresqlSchemaStatement[]
  readonly sqlFile: string
  readonly sqlDigest: string
}

export interface LogicalOwnerReplacement {
  readonly tableId: string
  readonly before: OwnerContext
  readonly after: OwnerContext
}

export function logicalOwnerReplacements(
  from: LogicalSchemaContract,
  to: LogicalSchemaContract,
): LogicalOwnerReplacement[] {
  return from.tables.flatMap((table) => {
    const next = to.tables.find((candidate) => candidate.id === table.id)
    return next && table.ownerContext !== next.ownerContext
      ? [{ tableId: table.id, before: table.ownerContext, after: next.ownerContext }]
      : []
  })
}

function applyLogicalOwners(
  contract: LogicalSchemaContract,
  replacements: readonly LogicalOwnerReplacement[],
): LogicalSchemaContract {
  if (replacements.length === 0) return contract
  requireSequence(
    new Set(replacements.map((item) => item.tableId)).size === replacements.length,
    'duplicate table ownership correction',
  )
  for (const replacement of replacements) {
    const table = contract.tables.find((candidate) => candidate.id === replacement.tableId)
    requireSequence(
      table !== undefined &&
        table.ownerContext === replacement.before &&
        table.retention.owner === replacement.before &&
        replacement.before !== replacement.after,
      'table ownership source differs',
    )
  }
  const payload = {
    ...contractPayload(contract),
    tables: contract.tables.map((table) => {
      const replacement = replacements.find((candidate) => candidate.tableId === table.id)
      return replacement
        ? {
            ...table,
            ownerContext: replacement.after,
            retention: { ...table.retention, owner: replacement.after },
          }
        : table
    }),
  }
  return { ...payload, digest: digestSchemaContract(payload) }
}

export interface LogicalSourceRevisionReplacement {
  readonly tableId: 'observation_source_revisions'
  readonly before: ObservationSourceRevisionContract
  readonly after: ObservationSourceRevisionContract
}
export interface PostgresqlSourceRevisionReplacement {
  readonly logicalId: string
  readonly before: PostgresqlSchemaStatement
  readonly after: PostgresqlSchemaStatement
}

export function logicalSourceRevisionReplacement(
  from: LogicalSchemaContract,
  to: LogicalSchemaContract,
): LogicalSourceRevisionReplacement | undefined {
  const before = from.tables.find(
    (table) => table.id === 'observation_source_revisions',
  )?.sourceRevisionProjection
  const after = to.tables.find(
    (table) => table.id === 'observation_source_revisions',
  )?.sourceRevisionProjection
  // Birth/retirement of a whole relation belongs to the original additive or
  // retirement edge; V5 is only a transition of an already present clock.
  if (before === undefined || after === undefined) return undefined
  if (canonicalSchemaJson(before ?? null) === canonicalSchemaJson(after ?? null)) return undefined
  exact(before, OBSERVATION_SOURCE_REVISION, 'source revision upgrade requires its original clock')
  exact(
    after,
    OBSERVATION_SOURCE_REVISION_JOURNAL,
    'source revision upgrade requires the complete journal clock',
  )
  return { tableId: 'observation_source_revisions', before: before!, after: after! }
}

function applyLogicalSourceRevision(
  contract: LogicalSchemaContract,
  replacement: LogicalSourceRevisionReplacement | undefined,
  missingRelationMessage = 'source clock original relation missing',
): LogicalSchemaContract {
  if (!replacement) return contract
  requireSequence(
    replacement.tableId === 'observation_source_revisions',
    'source clock table changed',
  )
  exact(replacement.before, OBSERVATION_SOURCE_REVISION, 'source clock previous descriptor differs')
  exact(
    replacement.after,
    OBSERVATION_SOURCE_REVISION_JOURNAL,
    'source clock journal descriptor differs',
  )
  const original = contract.tables.find((table) => table.id === replacement.tableId)
  requireSequence(original !== undefined, missingRelationMessage)
  exact(
    original.sourceRevisionProjection,
    replacement.before,
    'source clock original projection differs',
  )
  const payload = {
    ...contractPayload(contract),
    tables: contract.tables.map((table) =>
      table.id === replacement.tableId
        ? { ...table, sourceRevisionProjection: replacement.after }
        : table,
    ),
  }
  return { ...payload, digest: digestSchemaContract(payload) }
}

function sourceRevisionFunctionReplacements(
  from: PostgresqlSchemaPlan,
  to: PostgresqlSchemaPlan,
  replacement: LogicalSourceRevisionReplacement | undefined,
): readonly PostgresqlSourceRevisionReplacement[] {
  if (!replacement) return []
  const result: PostgresqlSourceRevisionReplacement[] = []
  for (const source of OBSERVATION_SOURCE_REVISION.sources)
    for (const event of ['insert', 'update', 'delete'] as const) {
      const logicalId = 'observation_source_revisions:' + source + ':' + event,
        before = from.statements.find(
          (statement) => statement.kind === 'function' && statement.logicalId === logicalId,
        ),
        after = to.statements.find(
          (statement) => statement.kind === 'function' && statement.logicalId === logicalId,
        )
      requireSequence(
        before !== undefined && after !== undefined && before.sql !== after.sql,
        'source clock function pair missing or unchanged',
      )
      result.push({ logicalId, before, after })
    }
  return result
}

function sourceRevisionExecutable(
  replacement: PostgresqlSourceRevisionReplacement,
): PostgresqlSchemaStatement {
  requireSequence(
    replacement.after.sql.startsWith('CREATE FUNCTION '),
    'source clock function projection differs',
  )
  return {
    ...replacement.after,
    sql: replacement.after.sql.replace(/^CREATE FUNCTION /, 'CREATE OR REPLACE FUNCTION '),
  }
}

export interface PostgresqlMigrationHistory {
  readonly root: PostgresqlMigrationRoot
  readonly versions: readonly PostgresqlMigrationVersion[]
  readonly steps: readonly PostgresqlIndexUpgrade[]
  readonly head: PostgresqlMigrationVersion
}

/** V4 retirement artifacts retain logical FK names. Resolve their physical
 * identifiers from the verified preceding CREATE plan (which bounds names to
 * PostgreSQL's 63-byte limit), without rewriting immutable migration artifacts. */
export function postgresqlUpgradeStatementSql(
  previous: PostgresqlMigrationVersion,
  statement: PostgresqlSchemaStatement,
): string {
  if (statement.kind !== 'constraint' || !statement.logicalId.startsWith('retire:'))
    return statement.sql
  const logical = statement.logicalId.slice('retire:'.length)
  const separator = logical.indexOf(':')
  const id = `${logical.slice(0, separator)}:fk:${logical.slice(separator + 1)}`
  const original = previous.plan.statements.find(
    (item) => item.kind === 'constraint' && item.logicalId === id,
  )
  const physical = original?.sql.match(
    /^(ALTER TABLE .+) ADD CONSTRAINT ("(?:[^"]|"")+") FOREIGN KEY /,
  )
  requireSequence(
    physical !== undefined && physical !== null,
    'retired foreign key is absent from the preceding plan',
  )
  return `${physical[1]} DROP CONSTRAINT ${physical[2]}`
}

/** The existing schema_migrations row shape; its original baseline stays intact. */
export interface PostgresqlCompletedUpgrade {
  readonly baselineId: string
  readonly contractDigest: string
  readonly planDigest: string
}

export class PostgresqlMigrationSequenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PostgresqlMigrationSequenceError'
  }
}

function requireSequence(condition: unknown, message: string): asserts condition {
  if (!condition) throw new PostgresqlMigrationSequenceError(message)
}

function exact(actual: unknown, expected: unknown, message: string): void {
  requireSequence(canonicalSchemaJson(actual) === canonicalSchemaJson(expected), message)
}

export function postgresqlMigrationDigest(value: unknown): string {
  return postgresqlMigrationSqlDigest(canonicalSchemaJson(value))
}

export function postgresqlMigrationSqlDigest(value: string): string {
  return `sha256:${sha256Hex(value)}`
}

export function postgresqlSchemaIdentity(plan: PostgresqlSchemaPlan): PostgresqlSchemaIdentity {
  return {
    baselineId: plan.baselineId,
    contractDigest: plan.contractDigest,
    planDigest: plan.digest,
  }
}

export function postgresqlSqliteMigrationIdentity(
  chain: readonly Readonly<ExpectedMigration>[],
): PostgresqlSqliteMigrationIdentity {
  requireSequence(chain.length > 0, 'SQLite migration history must not be empty')
  for (const [index, item] of chain.entries()) {
    requireSequence(
      item.index === index &&
        Number.isSafeInteger(item.folderMillis) &&
        /^[a-f0-9]{64}$/.test(item.hash) &&
        item.tag.length > 0,
      `SQLite migration identity differs at position ${index}`,
    )
    if (index > 0) {
      requireSequence(
        item.folderMillis > chain[index - 1]!.folderMillis,
        `SQLite migration time does not advance at position ${index}`,
      )
    }
  }
  return {
    count: chain.length,
    last: chain[chain.length - 1]!,
    chainDigest: postgresqlMigrationDigest(chain),
  }
}

export function postgresqlMigrationJournal(plan: PostgresqlSchemaPlan) {
  return {
    version: 1,
    baselineId: plan.baselineId,
    contractDigest: plan.contractDigest,
    planDigest: plan.digest,
    activeTableCount: plan.activeTableCount,
    archiveOnlyTableCount: plan.archiveOnlyTableCount,
    statements: plan.statements.map((statement) => ({
      kind: statement.kind,
      logicalId: statement.logicalId,
      digest: postgresqlMigrationSqlDigest(statement.sql),
    })),
  }
}

function planPayload(plan: PostgresqlSchemaPlan) {
  const { digest: _digest, ...payload } = plan
  return payload
}

function contractPayload(contract: LogicalSchemaContract) {
  const { digest: _digest, ...payload } = contract
  return payload
}

function rowContract(contract: LogicalSchemaContract) {
  return {
    ...contractPayload(contract),
    tables: contract.tables.map((table) => {
      const { indexes: _indexes, ...row } = table
      return row
    }),
  }
}

function statementKey(statement: PostgresqlSchemaStatement): string {
  return `${statement.kind}:${statement.logicalId}`
}

function validateVersion(version: PostgresqlMigrationVersion): void {
  requireSequence(
    version.contract.digest === digestSchemaContract(contractPayload(version.contract)),
    'logical contract digest differs',
  )
  requireSequence(
    version.plan.contractDigest === version.contract.digest,
    'plan and logical contract differ',
  )
  requireSequence(
    version.plan.digest === postgresqlMigrationDigest(planPayload(version.plan)),
    'schema plan digest differs',
  )
  requireSequence(
    new Set(version.plan.statements.map(statementKey)).size === version.plan.statements.length,
    'schema plan contains duplicate statement identities',
  )
  exact(
    version.sqliteMigration,
    postgresqlSqliteMigrationIdentity(version.sqliteMigrations),
    'SQLite migration prefix digest differs',
  )
}

export function createPostgresqlMigrationRoot(input: {
  readonly contract: LogicalSchemaContract
  readonly plan: PostgresqlSchemaPlan
  readonly sqliteMigrations: readonly Readonly<ExpectedMigration>[]
  readonly baselineSql: string
  readonly legacyJournal: string
}): PostgresqlMigrationRoot {
  const root: PostgresqlMigrationRoot = {
    version: 1,
    contract: input.contract,
    plan: input.plan,
    sqliteMigrations: input.sqliteMigrations,
    sqliteMigration: postgresqlSqliteMigrationIdentity(input.sqliteMigrations),
    baselineSqlDigest: postgresqlMigrationSqlDigest(input.baselineSql),
    legacyJournalDigest: postgresqlMigrationSqlDigest(input.legacyJournal),
  }
  validatePostgresqlMigrationRoot(root, input.baselineSql, input.legacyJournal)
  return root
}

export function validatePostgresqlMigrationRoot(
  root: PostgresqlMigrationRoot,
  baselineSql: string,
  legacyJournal: string,
): void {
  validateVersion(root)
  requireSequence(root.version === 1, 'unsupported schema root version')
  requireSequence(
    root.baselineSqlDigest === postgresqlMigrationSqlDigest(baselineSql) &&
      baselineSql === renderPostgresqlBaselineSql(root.plan),
    'baseline SQL drifted from frozen root',
  )
  requireSequence(
    root.legacyJournalDigest === postgresqlMigrationSqlDigest(legacyJournal),
    'journal drifted from frozen root',
  )
  exact(
    JSON.parse(legacyJournal),
    postgresqlMigrationJournal(root.plan),
    'journal drifted from frozen plan',
  )
}

/**
 * RFC-366 — rewrite the named checks' expressions and nothing else.
 *
 * Every rejection here is a case where the caller asked for something this edge
 * deliberately cannot express (a new check, a dropped check, a rename), so it
 * belongs in an upgrade kind of its own rather than sliding through this one.
 */
function applyLogicalCheckReplacements(
  contract: LogicalSchemaContract,
  replacements: readonly LogicalCheckReplacement[],
): LogicalSchemaContract {
  if (replacements.length === 0) return contract
  requireSequence(
    new Set(replacements.map((item) => `${item.tableId}:${item.name}`)).size ===
      replacements.length,
    'duplicate check replacement',
  )
  const pending = new Map(
    replacements.map((item) => [`${item.tableId}:${item.name}`, item] as const),
  )
  const tables = contract.tables.map((table) => {
    const changes = replacements.filter((item) => item.tableId === table.id)
    if (changes.length === 0) return table
    requireSequence(
      table.disposition !== 'ARCHIVE_THEN_OMIT',
      'check replacement requires an active table',
    )
    const checks = table.checks.map((check) => {
      const change = pending.get(`${table.id}:${check.name}`)
      if (change === undefined) return check
      requireSequence(
        check.expression === change.fromExpression && change.fromExpression !== change.toExpression,
        'check replacement does not match the existing expression',
      )
      pending.delete(`${table.id}:${check.name}`)
      return { ...check, expression: change.toExpression }
    })
    return { ...table, checks }
  })
  requireSequence(pending.size === 0, 'check replacement names an unknown table or constraint')
  const payload = { ...contractPayload(contract), tables }
  return { ...payload, digest: digestSchemaContract(payload) }
}

/** RFC-366 — rewrite the named columns' `enumValues` and nothing else. */
function applyLogicalColumnEnums(
  contract: LogicalSchemaContract,
  replacements: readonly LogicalColumnEnumReplacement[],
): LogicalSchemaContract {
  if (replacements.length === 0) return contract
  requireSequence(
    new Set(replacements.map((item) => `${item.tableId}:${item.column}`)).size ===
      replacements.length,
    'duplicate column enum replacement',
  )
  const pending = new Map(
    replacements.map((item) => [`${item.tableId}:${item.column}`, item] as const),
  )
  const tables = contract.tables.map((table) => {
    if (!replacements.some((item) => item.tableId === table.id)) return table
    const columns = table.columns.map((column) => {
      const change = pending.get(`${table.id}:${column.name}`)
      if (change === undefined) return column
      exact(
        column.enumValues,
        change.fromValues,
        'column enum replacement does not match the existing values',
      )
      pending.delete(`${table.id}:${column.name}`)
      return { ...column, enumValues: change.toValues }
    })
    return { ...table, columns }
  })
  requireSequence(pending.size === 0, 'column enum replacement names an unknown table or column')
  const payload = { ...contractPayload(contract), tables }
  return { ...payload, digest: digestSchemaContract(payload) }
}

/** RFC-366 — derive the `enumValues`-only column deltas between two contracts. */
export function logicalColumnEnumReplacements(
  from: LogicalSchemaContract,
  to: LogicalSchemaContract,
): LogicalColumnEnumReplacement[] {
  const replacements: LogicalColumnEnumReplacement[] = []
  const byId = new Map(from.tables.map((table) => [table.id, table] as const))
  for (const table of to.tables) {
    const previous = byId.get(table.id)
    if (previous === undefined) continue
    const previousColumns = new Map(previous.columns.map((column) => [column.name, column]))
    for (const column of table.columns) {
      const before = previousColumns.get(column.name)
      if (before === undefined) continue
      if (canonicalSchemaJson(before.enumValues) === canonicalSchemaJson(column.enumValues))
        continue
      replacements.push({
        tableId: table.id,
        column: column.name,
        fromValues: before.enumValues,
        toValues: column.enumValues,
      })
    }
  }
  return replacements
}

/**
 * RFC-366 — derive the expression-only check deltas between two contracts.
 * Anything beyond an expression change (a check added, removed, renamed, or
 * flipped to/from `null`) is left for `logicalIndexAdditions` to reject, so this
 * function never widens what the edge admits.
 */
export function logicalCheckReplacements(
  from: LogicalSchemaContract,
  to: LogicalSchemaContract,
): LogicalCheckReplacement[] {
  const replacements: LogicalCheckReplacement[] = []
  const byId = new Map(from.tables.map((table) => [table.id, table] as const))
  for (const table of to.tables) {
    const previous = byId.get(table.id)
    if (previous === undefined) continue
    const previousChecks = new Map(previous.checks.map((check) => [check.name, check] as const))
    for (const check of table.checks) {
      const before = previousChecks.get(check.name)
      if (before === undefined) continue
      if (before.expression === null || check.expression === null) continue
      if (before.expression === check.expression) continue
      replacements.push({
        tableId: table.id,
        name: check.name,
        fromExpression: before.expression,
        toExpression: check.expression,
      })
    }
  }
  return replacements
}

/**
 * RFC-366 — the `DROP CONSTRAINT` that must precede the re-`ADD`.
 *
 * Derived by slicing the projection's own `ADD CONSTRAINT` statement rather than
 * re-deriving the schema/table/identifier quoting here: a second spelling of
 * those rules is a second thing to keep in sync, and this one cannot drift
 * because it is literally the projected statement's own prefix.
 */
function checkDropStatement(add: PostgresqlSchemaStatement): PostgresqlSchemaStatement {
  const marker = ' ADD CONSTRAINT '
  const at = add.sql.indexOf(marker)
  requireSequence(
    add.kind === 'constraint' && add.sql.startsWith('ALTER TABLE ') && at > 0,
    'check constraint statement is not an ALTER TABLE ... ADD CONSTRAINT',
  )
  const table = add.sql.slice(0, at)
  const rest = add.sql.slice(at + marker.length)
  const nameEnd = rest.indexOf(' ')
  requireSequence(nameEnd > 0, 'check constraint statement has no constraint name')
  return {
    kind: 'constraint',
    logicalId: `${add.logicalId}:drop`,
    sql: `${table} DROP CONSTRAINT ${rest.slice(0, nameEnd)}`,
  }
}

/** RFC-366 — pair each replaced check's old projection with its drop + new add. */
function checkReplacementStatements(
  from: PostgresqlSchemaPlan,
  to: PostgresqlSchemaPlan,
  replacements: readonly LogicalCheckReplacement[],
): PostgresqlCheckReplacement[] {
  const old = new Map(from.statements.map((statement) => [statementKey(statement), statement]))
  const next = new Map(to.statements.map((statement) => [statementKey(statement), statement]))
  return replacements.map((replacement) => {
    const logicalId = `${replacement.tableId}:check:${replacement.name}`
    const key = `constraint:${logicalId}`
    const before = old.get(key)
    const after = next.get(key)
    requireSequence(
      before !== undefined && after !== undefined && before.sql !== after.sql,
      'check replacement has no projected statement pair',
    )
    return { logicalId, before, drop: checkDropStatement(before), after }
  })
}

export function logicalIndexPredicateReplacements(
  from: LogicalSchemaContract,
  to: LogicalSchemaContract,
): LogicalIndexPredicateReplacement[] {
  return to.tables.flatMap((table) => {
    const original = from.tables.find((value) => value.id === table.id)
    if (!original) return []
    return table.indexes.flatMap((index) => {
      const before = original.indexes.find((value) => value.name === index.name)
      if (!before || before.where === index.where) return []
      requireSequence(
        before.unique && index.unique && before.where === null && index.where !== null,
        'index predicate upgrade must restrict an existing full unique index',
      )
      exact(before.columns, index.columns, 'index predicate upgrade changed key columns')
      return [
        { tableId: table.id, name: index.name, fromExpression: null, toExpression: index.where! },
      ]
    })
  })
}

function applyLogicalIndexPredicates(
  contract: LogicalSchemaContract,
  replacements: readonly LogicalIndexPredicateReplacement[],
): LogicalSchemaContract {
  if (!replacements.length) return contract
  const pending = new Map(replacements.map((value) => [`${value.tableId}:${value.name}`, value]))
  requireSequence(pending.size === replacements.length, 'duplicate index predicate replacement')
  const tables = contract.tables.map((table) => {
    const indexes = table.indexes.map((index) => {
      const key = `${table.id}:${index.name}`,
        change = pending.get(key)
      if (!change) return index
      requireSequence(
        table.disposition !== 'ARCHIVE_THEN_OMIT' &&
          index.unique &&
          index.where === null &&
          change.fromExpression === null &&
          change.toExpression.length > 0,
        'index predicate source is not a full unique index',
      )
      const constraint = table.unique.find((value) => value.name === index.name)
      requireSequence(
        constraint !== undefined && constraint.expression === null,
        'index predicate unique contract missing',
      )
      exact(constraint.columns, index.columns, 'index predicate unique columns differ')
      pending.delete(key)
      return { ...index, where: change.toExpression }
    })
    const unique = table.unique.map((constraint) => {
      const change = replacements.find(
        (value) => value.tableId === table.id && value.name === constraint.name,
      )
      return change ? { ...constraint, expression: change.toExpression } : constraint
    })
    return { ...table, indexes, unique }
  })
  requireSequence(pending.size === 0, 'index predicate replacement names an unknown index')
  const payload = { ...contractPayload(contract), tables }
  return { ...payload, digest: digestSchemaContract(payload) }
}

function indexPredicateStatements(
  from: PostgresqlSchemaPlan,
  to: PostgresqlSchemaPlan,
  replacements: readonly LogicalIndexPredicateReplacement[],
): PostgresqlCheckReplacement[] {
  return replacements.map((change) => {
    const logicalId = `${change.tableId}:index:${change.name}`
    const before = from.statements.find(
      (value) => value.kind === 'index' && value.logicalId === logicalId,
    )
    const after = to.statements.find(
      (value) => value.kind === 'index' && value.logicalId === logicalId,
    )
    requireSequence(
      before !== undefined && after !== undefined && before.sql !== after.sql,
      'index predicate projected pair missing',
    )
    const name = change.name.replaceAll('"', '""'),
      schema = POSTGRESQL_APPLICATION_SCHEMA.replaceAll('"', '""')
    return {
      logicalId,
      before,
      after,
      drop: {
        kind: 'index',
        logicalId: `${logicalId}:drop`,
        sql: `DROP INDEX "${schema}"."${name}"`,
      },
    }
  })
}

export interface LogicalColumnAddition {
  readonly tableId: string
  readonly position: number
  readonly column: LogicalColumnContract
}

export function logicalColumnAdditions(
  from: LogicalSchemaContract,
  to: LogicalSchemaContract,
): LogicalColumnAddition[] {
  return to.tables.flatMap((table) => {
    const prior = from.tables.find((candidate) => candidate.id === table.id)
    if (!prior) return []
    return table.columns.slice(prior.columns.length).map((column, offset) => ({
      tableId: table.id,
      position: prior.columns.length + offset,
      column,
    }))
  })
}

/** RFC-374 V8: physical ALTER appends columns, so their logical order must match. */
function appendLogicalColumns(
  contract: LogicalSchemaContract,
  additions: readonly LogicalColumnAddition[],
): LogicalSchemaContract {
  for (const addition of additions) {
    const table = contract.tables.find((candidate) => candidate.id === addition.tableId)
    const column = addition.column
    requireSequence(table?.disposition === 'KEEP', 'column addition requires an active KEEP table')
    requireSequence(
      !column.primary &&
        !column.identity &&
        column.uniqueName === null &&
        (column.nullable ||
          (column.defaultKind === 'literal' && column.providerDefault.postgresql !== null)) &&
        (column.defaultKind === 'none' || column.defaultKind === 'literal') &&
        !table.foreignKeys.some((key) => key.columns.includes(column.name)),
      'column addition must be nullable or have a literal default, without keys or identity',
    )
  }
  const tables = contract.tables.map((table) => {
    const changes = additions.filter((addition) => addition.tableId === table.id)
    if (!changes.length) return table
    const columns = [...table.columns]
    for (const { position, column } of changes) {
      requireSequence(position === columns.length, 'column addition must append at the end')
      requireSequence(
        !columns.some((old) => old.name === column.name),
        'duplicate logical column name',
      )
      columns.push(column)
    }
    return { ...table, columns }
  })
  const payload = { ...contractPayload(contract), tables }
  return { ...payload, digest: digestSchemaContract(payload) }
}

function columnAdditionStatements(
  contract: LogicalSchemaContract,
  additions: readonly LogicalColumnAddition[],
): PostgresqlSchemaStatement[] {
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`
  return additions.map(({ tableId, column }) => {
    const table = contract.tables.find((candidate) => candidate.id === tableId)!
    return {
      kind: 'table',
      logicalId: `${tableId}.${column.name}`,
      sql: `ALTER TABLE ${quote(POSTGRESQL_APPLICATION_SCHEMA)}.${quote(table.providerTables.postgresql!)} ADD COLUMN ${renderPostgresqlColumnSql(column)}`,
    }
  })
}

function logicalIndexAdditions(
  from: LogicalSchemaContract,
  to: LogicalSchemaContract,
  columns: readonly LogicalColumnAddition[] = [],
): LogicalIndexAddition[] {
  const rowTarget = {
    ...to,
    tables: to.tables.map((table) => {
      const previous = from.tables.find((candidate) => candidate.id === table.id)!
      const added = table.indexes.filter(
        (index) =>
          index.unique &&
          !previous.indexes.some((old) => old.name === index.name) &&
          columns.some(
            (column) => column.tableId === table.id && index.columns.includes(column.column.name),
          ),
      )
      return {
        ...table,
        unique: table.unique.filter((key) => !added.some((index) => index.name === key.name)),
      }
    }),
  }
  exact(
    rowContract(from),
    rowContract(rowTarget),
    'index-only upgrade changed a row, codec, key or disposition',
  )
  return to.tables.flatMap((table, tableAt) => {
    const previous = from.tables[tableAt]!
    const oldNames = new Set(previous.indexes.map((index) => index.name))
    requireSequence(
      new Set(table.indexes.map((index) => index.name)).size === table.indexes.length,
      'duplicate logical index name',
    )
    exact(
      table.indexes.filter((index) => oldNames.has(index.name)),
      previous.indexes,
      'old indexes changed, moved or were removed',
    )
    return table.indexes.flatMap((index, position) =>
      oldNames.has(index.name) ? [] : [{ tableId: table.id, position, index }],
    )
  })
}

function insertAtPositions<T>(
  original: readonly T[],
  additions: readonly { readonly position: number; readonly value: T }[],
): T[] {
  const positions = new Map(additions.map((addition) => [addition.position, addition.value]))
  requireSequence(positions.size === additions.length, 'duplicate insertion position')
  const length = original.length + additions.length
  for (const position of positions.keys())
    requireSequence(
      Number.isSafeInteger(position) && position >= 0 && position < length,
      'invalid insertion position',
    )
  let sourceIndex = 0
  return Array.from({ length }, (_, position) => {
    if (positions.has(position)) return positions.get(position)!
    return original[sourceIndex++]!
  })
}

function appendLogicalIndexes(
  contract: LogicalSchemaContract,
  additions: readonly LogicalIndexAddition[],
  columns: readonly LogicalColumnAddition[] = [],
): LogicalSchemaContract {
  for (const addition of additions) {
    const table = contract.tables.find((candidate) => candidate.id === addition.tableId)
    requireSequence(
      table !== undefined && table.disposition !== 'ARCHIVE_THEN_OMIT',
      'index addition requires an existing active table',
    )
    requireSequence(
      !addition.index.unique ||
        columns.some(
          (column) =>
            column.tableId === addition.tableId &&
            addition.index.columns.includes(column.column.name),
        ),
      'this upgrade translator supports ordinary covering indexes only',
    )
  }
  const tables = contract.tables.map((table) => {
    const changes = additions.filter((addition) => addition.tableId === table.id)
    if (changes.length === 0) return table
    const indexes = insertAtPositions(
      table.indexes,
      changes.map((addition) => ({ position: addition.position, value: addition.index })),
    )
    requireSequence(
      new Set(indexes.map((index) => index.name)).size === indexes.length,
      'duplicate logical index name',
    )
    const unique = changes.some((change) => change.index.unique)
      ? [
          ...table.unique.filter((key) => !table.indexes.some((index) => index.name === key.name)),
          ...indexes
            .filter((index) => index.unique)
            .map((index) => ({
              name: index.name,
              columns: index.columns,
              expression: index.where,
            })),
        ]
      : table.unique
    return { ...table, indexes, unique }
  })
  const payload = { ...contractPayload(contract), tables }
  return { ...payload, digest: digestSchemaContract(payload) }
}

/** Only additive, active tables. Existing rows, constraints and retention stay immutable. */
function appendLogicalTables(
  contract: LogicalSchemaContract,
  additions: readonly LogicalTableAddition[],
): LogicalSchemaContract {
  const names = new Set(contract.tables.map((table) => table.id))
  for (const { table } of additions) {
    requireSequence(!names.has(table.id), 'table addition duplicates an existing table')
    requireSequence(table.disposition === 'KEEP', 'table addition requires an active KEEP table')
    names.add(table.id)
  }
  const tables = insertAtPositions(
    contract.tables,
    additions.map(({ position, table }) => ({ position, value: table })),
  )
  const payload = {
    ...contractPayload(contract),
    sourceTableCount: contract.sourceTableCount + additions.length,
    activeTableCount: contract.activeTableCount + additions.length,
    tables,
  }
  return { ...payload, digest: digestSchemaContract(payload) }
}

function retireLogicalTables(
  contract: LogicalSchemaContract,
  ids: readonly string[],
): LogicalSchemaContract {
  if (ids.length === 0) return contract
  const removed = new Set(ids)
  requireSequence(removed.size === ids.length, 'duplicate retired table')
  for (const id of ids)
    requireSequence(
      contract.tables.some((t) => t.id === id && t.disposition === 'KEEP'),
      'retirement requires an existing active table',
    )
  const tables = contract.tables.filter((t) => !removed.has(t.id))
  requireSequence(
    tables.every((t) => t.foreignKeys.every((fk) => !removed.has(fk.foreignTable))),
    'retained table references a retired table',
  )
  const payload = {
    ...contractPayload(contract),
    tables,
    sourceTableCount: contract.sourceTableCount - ids.length,
    activeTableCount: contract.activeTableCount - ids.length,
  }
  return { ...payload, digest: digestSchemaContract(payload) }
}
function retirementStatements(
  contract: LogicalSchemaContract,
  ids: readonly string[],
): PostgresqlSchemaStatement[] {
  const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"'
  const tables = ids.map((id) => contract.tables.find((t) => t.id === id)!)
  // Remove only constraints owned by retired tables; DROP TABLE never uses CASCADE.
  return [
    ...tables.flatMap((t) =>
      t.foreignKeys.map((fk) => ({
        kind: 'constraint' as const,
        logicalId: `retire:${t.id}:${fk.name}`,
        sql: `ALTER TABLE ${quote(POSTGRESQL_APPLICATION_SCHEMA)}.${quote(t.providerTables.postgresql!)} DROP CONSTRAINT ${quote(fk.name)}`,
      })),
    ),
    ...tables.map((t) => ({
      kind: 'table' as const,
      logicalId: `retire:${t.id}`,
      sql: `DROP TABLE ${quote(POSTGRESQL_APPLICATION_SCHEMA)}.${quote(t.providerTables.postgresql!)}`,
    })),
  ]
}
/**
 * RFC-371 v2: a retired relation may own triggers and functions installed on
 * SURVIVING tables (the v1 change capture on tasks / node_runs / …). DROP TABLE
 * never touches those, so the retirement edge drops every trigger, then every
 * function, that the retained plan no longer projects. An edge whose retired
 * tables own none (every earlier retirement) produces no statement here.
 */
function retiredProjectionStatements(
  version: PostgresqlMigrationVersion,
  ids: readonly string[],
): PostgresqlSchemaStatement[] {
  if (!ids.length) return []
  const kept = new Set(retainedStatements(version, ids).map(statementKey))
  const removed = version.plan.statements.filter(
    (statement) =>
      (statement.kind === 'trigger' || statement.kind === 'function') &&
      !kept.has(statementKey(statement)),
  )
  const name = String.raw`(?:"(?:[^"]|"")+"\.)?"(?:[^"]|"")+"`
  const trigger = new RegExp(
    String.raw`^CREATE TRIGGER ("(?:[^"]|"")+") AFTER [A-Z ]+? ON (${name})`,
  )
  const fn = new RegExp(String.raw`^CREATE FUNCTION (${name})\(\)`)
  return [
    ...removed
      .filter((statement) => statement.kind === 'trigger')
      .map((statement) => {
        const match = trigger.exec(statement.sql)
        requireSequence(match !== null, 'retired trigger statement shape differs')
        return {
          kind: 'trigger' as const,
          logicalId: `retire:${statement.logicalId}`,
          sql: `DROP TRIGGER ${match[1]} ON ${match[2]}`,
        }
      }),
    ...removed
      .filter((statement) => statement.kind === 'function')
      .map((statement) => {
        const match = fn.exec(statement.sql)
        requireSequence(match !== null, 'retired function statement shape differs')
        return {
          kind: 'function' as const,
          logicalId: `retire:${statement.logicalId}`,
          sql: `DROP FUNCTION ${match[1]}()`,
        }
      }),
  ]
}

function retainedStatements(
  version: PostgresqlMigrationVersion,
  ids: readonly string[],
): readonly PostgresqlSchemaStatement[] {
  if (!ids.length) return version.plan.statements
  const keys = new Set(
    buildPostgresqlSchemaPlan(retireLogicalTables(version.contract, ids)).statements.map(
      statementKey,
    ),
  )
  return version.plan.statements.filter((statement) => keys.has(statementKey(statement)))
}

function contractUpdate(
  from: PostgresqlSchemaPlan,
  to: PostgresqlSchemaPlan,
): PostgresqlSchemaStatement {
  return {
    kind: 'metadata',
    logicalId: 'advance-contract-row',
    sql: `UPDATE "agent_workflow_meta"."schema_contract" SET contract_digest = '${to.contractDigest}', active_table_count = ${to.activeTableCount}, archive_only_table_count = ${to.archiveOnlyTableCount} WHERE singleton = TRUE AND contract_digest = '${from.contractDigest}' RETURNING contract_digest`,
  }
}

export function renderPostgresqlUpgradeSql(
  step: Pick<PostgresqlIndexUpgrade, 'executableStatements'>,
): string {
  return (
    step.executableStatements
      .map(
        (statement) =>
          `-- ${statement.kind}: ${statement.logicalId}\n${statement.sql.replace(/;\s*$/u, '')};`,
      )
      .join('\n\n') + '\n'
  )
}

interface PostgresqlUpgradeInput {
  readonly from: PostgresqlMigrationVersion
  readonly to: PostgresqlMigrationVersion
  readonly id: string
  readonly sequence: number
  readonly previousEntryDigest: string
}

export function createPostgresqlIndexUpgrade(
  input: PostgresqlUpgradeInput,
): PostgresqlIndexUpgrade {
  return createPostgresqlUpgrade(input, false, false)
}

/** Append a reviewed subset predicate; old rows, keys and history are retained. */
export function createPostgresqlIndexPredicateUpgrade(
  input: PostgresqlUpgradeInput,
): PostgresqlIndexUpgrade {
  return createPostgresqlUpgrade(input, false, false, [], false, false, true)
}

/** Append a reviewed ownership correction while preserving all historic bytes. */
export function createPostgresqlOwnershipUpgrade(
  input: PostgresqlUpgradeInput,
): PostgresqlIndexUpgrade {
  return createPostgresqlUpgrade(input, false, false, [], false, true)
}

/** Only the named clock protocol changes; every historical version is retained. */
export function createPostgresqlSourceRevisionUpgrade(
  input: PostgresqlUpgradeInput,
): PostgresqlIndexUpgrade {
  return createPostgresqlUpgrade(input, false, false, [], true)
}

/** RFC-363 expand-only migration: new tables plus ordinary indexes on existing tables. */
export function createPostgresqlAdditiveUpgrade(
  input: PostgresqlUpgradeInput,
): PostgresqlIndexUpgrade {
  return createPostgresqlUpgrade(input, true, false)
}

/**
 * RFC-366 value-domain migration: replace named CHECK expressions (and, if the
 * same change happens to bring them, new tables/indexes). Everything else about
 * the schema must still be identical — see {@link LogicalCheckReplacement}.
 */
export function createPostgresqlCheckUpgrade(
  input: PostgresqlUpgradeInput,
): PostgresqlIndexUpgrade {
  return createPostgresqlUpgrade(input, true, true)
}

/** User-approved retirement, with any independent additive delta preserved. */
export function createPostgresqlRetirementUpgrade(
  input: PostgresqlUpgradeInput,
): PostgresqlIndexUpgrade {
  const remaining = new Set(input.to.contract.tables.map((t) => t.id))
  const retired = input.from.contract.tables.filter((t) => !remaining.has(t.id)).map((t) => t.id)
  requireSequence(retired.length > 0, 'retirement has no removed tables')
  return createPostgresqlUpgrade(input, true, false, retired)
}

/** RFC-374 V8: new tables plus appended columns and indexes using those columns. */
export function createPostgresqlColumnUpgrade(
  input: PostgresqlUpgradeInput,
): PostgresqlIndexUpgrade {
  return createPostgresqlUpgrade(input, true, false, [], false, false, false, true)
}

function createPostgresqlUpgrade(
  input: PostgresqlUpgradeInput,
  allowNewTables: boolean,
  allowCheckReplacement: boolean,
  retiredTables: readonly string[] = [],
  allowSourceRevisionReplacement = false,
  allowOwnershipReplacement = false,
  allowIndexPredicateReplacement = false,
  allowNewColumns = false,
): PostgresqlIndexUpgrade {
  const { from, to } = input
  validateVersion(from)
  validateVersion(to)
  const oldTableIds = new Set(from.contract.tables.map((table) => table.id))
  const logicalTables = allowNewTables
    ? to.contract.tables.flatMap((table, position) =>
        oldTableIds.has(table.id) ? [] : [{ position, table }],
      )
    : []
  const logicalOwners = allowOwnershipReplacement
    ? logicalOwnerReplacements(from.contract, to.contract)
    : []
  requireSequence(
    !allowOwnershipReplacement || logicalOwners.length > 0,
    'ownership upgrade has no correction',
  )
  const retained = applyLogicalOwners(
    retireLogicalTables(from.contract, retiredTables),
    logicalOwners,
  )
  const oldStatements = retainedStatements(from, retiredTables)
  const logicalSourceRevision = allowSourceRevisionReplacement
    ? logicalSourceRevisionReplacement(retained, to.contract)
    : undefined
  requireSequence(
    !allowSourceRevisionReplacement || logicalSourceRevision !== undefined,
    'source revision upgrade has no protocol transition',
  )
  const withTables = applyLogicalSourceRevision(
    appendLogicalTables(retained, logicalTables),
    logicalSourceRevision,
  )
  const logicalChecks = allowCheckReplacement
    ? logicalCheckReplacements(withTables, to.contract)
    : []
  const logicalEnums = allowCheckReplacement
    ? logicalColumnEnumReplacements(withTables, to.contract)
    : []
  const logicalIndexPredicates = allowIndexPredicateReplacement
    ? logicalIndexPredicateReplacements(withTables, to.contract)
    : []
  requireSequence(
    !allowIndexPredicateReplacement || logicalIndexPredicates.length > 0,
    'index predicate upgrade has no change',
  )
  const logicalColumns = allowNewColumns ? logicalColumnAdditions(retained, to.contract) : []
  requireSequence(
    !allowNewColumns || logicalColumns.length > 0,
    'column upgrade has no appended column',
  )
  const withColumns = appendLogicalColumns(withTables, logicalColumns)
  const expanded = applyLogicalIndexPredicates(
    applyLogicalColumnEnums(
      applyLogicalCheckReplacements(withColumns, logicalChecks),
      logicalEnums,
    ),
    logicalIndexPredicates,
  )
  const logicalIndexes = logicalIndexAdditions(expanded, to.contract, logicalColumns)
  requireSequence(
    logicalTables.length +
      logicalColumns.length +
      logicalIndexes.length +
      logicalChecks.length +
      logicalIndexPredicates.length +
      retiredTables.length +
      logicalOwners.length +
      (logicalSourceRevision ? 1 : 0) >
      0,
    'schema upgrade has no new indexes or tables',
  )
  requireSequence(
    !allowCheckReplacement || logicalChecks.length > 0,
    'check upgrade has no replaced constraint',
  )
  exact(
    appendLogicalIndexes(expanded, logicalIndexes, logicalColumns),
    to.contract,
    'logical index replay differs',
  )
  exact(
    to.sqliteMigrations.slice(0, from.sqliteMigrations.length),
    from.sqliteMigrations,
    'SQLite migration prefix changed',
  )
  requireSequence(
    to.sqliteMigrations.length > from.sqliteMigrations.length,
    'index upgrade requires an appended SQLite migration',
  )
  const old = new Map(oldStatements.map((statement) => [statementKey(statement), statement]))
  const next = new Map(to.plan.statements.map((statement) => [statementKey(statement), statement]))
  const indexPredicateReplacements = indexPredicateStatements(
    from.plan,
    to.plan,
    logicalIndexPredicates,
  )
  const checkReplacements = checkReplacementStatements(from.plan, to.plan, logicalChecks)
  const sourceRevisionReplacements = sourceRevisionFunctionReplacements(
    from.plan,
    to.plan,
    logicalSourceRevision,
  )
  const replacedKeys = new Set<string>([
    ...logicalColumns.map((item) => `table:${item.tableId}`),
    ...checkReplacements.map((item) => `constraint:${item.logicalId}`),
    ...indexPredicateReplacements.map((item) => `index:${item.logicalId}`),
    ...sourceRevisionReplacements.map((item) => `function:${item.logicalId}`),
  ])
  for (const statement of oldStatements) {
    requireSequence(
      next.has(statementKey(statement)),
      'schema upgrade removed an existing statement',
    )
    if (
      statementKey(statement) !== 'metadata:contract-row' &&
      !replacedKeys.has(statementKey(statement))
    )
      exact(
        next.get(statementKey(statement)),
        statement,
        'schema upgrade changed an existing statement',
      )
  }
  const indexAdditions = to.plan.statements.flatMap((statement, position) =>
    old.has(statementKey(statement)) ? [] : [{ position, statement }],
  )
  const before = old.get('metadata:contract-row')
  const after = next.get('metadata:contract-row')
  requireSequence(before !== undefined && after !== undefined, 'schema contract row is missing')
  // Drop-then-add per constraint, then the additions, then the contract row.
  // The drop must sit immediately before its own re-add so a partially applied
  // file never leaves a table with neither the old nor the new domain.
  const executableStatements = [
    ...retiredProjectionStatements(from, retiredTables),
    ...retirementStatements(from.contract, retiredTables),
    ...checkReplacements.flatMap((item) => [item.drop, item.after]),
    ...indexPredicateReplacements.flatMap((item) => [item.drop, item.after]),
    ...sourceRevisionReplacements.map(sourceRevisionExecutable),
    ...columnAdditionStatements(to.contract, logicalColumns),
    ...indexAdditions.map((addition) => addition.statement),
    contractUpdate(from.plan, to.plan),
  ]
  const payload = {
    ...(retiredTables.length ? { retiredTables } : {}),
    ...(logicalOwners.length ? { logicalOwners } : {}),
    ...(logicalColumns.length ? { logicalColumns } : {}),
    version: logicalColumns.length
      ? (8 as const)
      : logicalIndexPredicates.length
        ? (7 as const)
        : logicalOwners.length
          ? (6 as const)
          : logicalSourceRevision
            ? (5 as const)
            : retiredTables.length
              ? (4 as const)
              : logicalChecks.length > 0
                ? (3 as const)
                : logicalTables.length === 0
                  ? (1 as const)
                  : (2 as const),
    ...(logicalIndexPredicates.length
      ? { logicalIndexPredicates, indexPredicateReplacements }
      : {}),
    ...(logicalTables.length === 0 ? {} : { logicalTables }),
    ...(logicalChecks.length === 0 ? {} : { logicalChecks, checkReplacements }),
    ...(logicalEnums.length === 0 ? {} : { logicalEnums }),
    ...(logicalSourceRevision ? { logicalSourceRevision, sourceRevisionReplacements } : {}),
    id: input.id,
    sequence: input.sequence,
    previousEntryDigest: input.previousEntryDigest,
    from: postgresqlSchemaIdentity(from.plan),
    to: postgresqlSchemaIdentity(to.plan),
    logicalIndexes,
    indexAdditions,
    contractRow: { beforeDigest: postgresqlMigrationSqlDigest(before.sql), after },
    sqliteMigration: {
      from: from.sqliteMigration,
      to: to.sqliteMigration,
      appended: to.sqliteMigrations.slice(from.sqliteMigrations.length),
    },
    executableStatements,
    sqlFile: `${input.id}.sql`,
    sqlDigest: postgresqlMigrationSqlDigest(renderPostgresqlUpgradeSql({ executableStatements })),
  }
  const step = { ...payload, digest: postgresqlMigrationDigest(payload) }
  exact(
    applyPostgresqlIndexUpgrade(from, step, input.previousEntryDigest, input.sequence),
    to,
    'schema upgrade replay differs from target',
  )
  return step
}

function applyPostgresqlIndexUpgrade(
  previous: PostgresqlMigrationVersion,
  step: PostgresqlIndexUpgrade,
  previousEntryDigest: string,
  sequence: number,
): PostgresqlMigrationVersion {
  const { digest, ...payload } = step
  requireSequence(
    (step.version === 1 ||
      step.version === 2 ||
      step.version === 3 ||
      step.version === 4 ||
      step.version === 5 ||
      step.version === 6 ||
      step.version === 7 ||
      step.version === 8) &&
      digest === postgresqlMigrationDigest(payload),
    'upgrade entry digest differs',
  )
  requireSequence(
    step.sequence === sequence &&
      new RegExp(`^${String(sequence).padStart(4, '0')}_[a-z0-9_]+$`, 'u').test(step.id),
    'upgrade sequence or ID differs',
  )
  requireSequence(
    step.previousEntryDigest === previousEntryDigest,
    'upgrade previous-entry digest differs',
  )
  exact(step.from, postgresqlSchemaIdentity(previous.plan), 'upgrade source pair differs')
  requireSequence(
    step.to.baselineId === previous.plan.baselineId,
    'upgrade baseline identity changed',
  )
  const retiredTables = step.retiredTables ?? []
  const logicalOwners = step.logicalOwners ?? []
  requireSequence(
    step.version === 6
      ? logicalOwners.length > 0 &&
          step.logicalIndexes.length === 0 &&
          step.indexAdditions.length === 0
      : step.logicalOwners === undefined,
    'ownership correction does not match upgrade version',
  )
  requireSequence(
    step.version === 4 ? retiredTables.length > 0 : step.retiredTables === undefined,
    'retirement does not match upgrade version',
  )
  const logicalColumns = step.logicalColumns ?? []
  requireSequence(
    step.version === 8 ? logicalColumns.length > 0 : step.logicalColumns === undefined,
    'column additions do not match upgrade version',
  )
  const logicalTables = step.logicalTables ?? []
  const logicalIndexPredicates = step.logicalIndexPredicates ?? []
  const indexPredicateReplacements = step.indexPredicateReplacements ?? []
  requireSequence(
    step.version === 7
      ? logicalIndexPredicates.length > 0 &&
          logicalIndexPredicates.length === indexPredicateReplacements.length &&
          step.logicalIndexes.length === 0 &&
          step.indexAdditions.length === 0
      : step.logicalIndexPredicates === undefined && step.indexPredicateReplacements === undefined,
    'index predicate delta does not match upgrade version',
  )
  const logicalChecks = step.logicalChecks ?? []
  const checkReplacements = step.checkReplacements ?? []
  const logicalEnums = step.logicalEnums ?? []
  const logicalSourceRevision = step.logicalSourceRevision,
    sourceRevisionReplacements = step.sourceRevisionReplacements ?? []
  requireSequence(
    step.version === 5
      ? logicalSourceRevision !== undefined &&
          sourceRevisionReplacements.length === OBSERVATION_SOURCE_REVISION.sources.length * 3
      : logicalSourceRevision === undefined && step.sourceRevisionReplacements === undefined,
    'source clock replacement does not match upgrade version',
  )
  // V1/V2 artifacts never carry the V3 keys, so their canonical JSON — and with
  // it their digest — is byte-identical to what it was before RFC-366.
  requireSequence(
    step.version === 1
      ? step.logicalTables === undefined && step.logicalChecks === undefined
      : step.version === 2
        ? logicalTables.length > 0 && step.logicalChecks === undefined
        : step.version === 4 || step.version === 8
          ? logicalChecks.length === 0
          : step.version === 5 || step.version === 6 || step.version === 7
            ? logicalChecks.length === 0 && logicalTables.length === 0
            : logicalChecks.length > 0,
    'upgrade table additions do not match its version',
  )
  requireSequence(
    (step.logicalChecks === undefined) === (step.checkReplacements === undefined) &&
      checkReplacements.length === logicalChecks.length,
    'upgrade check replacements are not paired with their logical deltas',
  )
  // An enum delta carries no SQL, so on its own it would be an upgrade whose
  // file is empty apart from the contract row. It only ever travels WITH a
  // check replacement — the two are one value domain declared twice.
  requireSequence(
    logicalEnums.length === 0 || step.version === 3,
    'upgrade column enum replacements require a value-domain upgrade',
  )
  requireSequence(
    step.logicalIndexes.length +
      logicalColumns.length +
      logicalTables.length +
      logicalChecks.length +
      logicalIndexPredicates.length +
      retiredTables.length +
      logicalOwners.length +
      (logicalSourceRevision ? 1 : 0) >
      0,
    'schema upgrade has no new indexes or tables',
  )
  const withTables = applyLogicalSourceRevision(
    appendLogicalTables(
      applyLogicalOwners(retireLogicalTables(previous.contract, retiredTables), logicalOwners),
      logicalTables,
    ),
    logicalSourceRevision,
  )
  const withColumns = appendLogicalColumns(withTables, logicalColumns)
  const expanded = applyLogicalIndexPredicates(
    applyLogicalColumnEnums(
      applyLogicalCheckReplacements(withColumns, logicalChecks),
      logicalEnums,
    ),
    logicalIndexPredicates,
  )
  const contract = appendLogicalIndexes(expanded, step.logicalIndexes, logicalColumns)
  requireSequence(
    contract.digest === step.to.contractDigest,
    'upgrade target contract digest differs',
  )
  const previousContract = previous.plan.statements.find(
    (statement) => statementKey(statement) === 'metadata:contract-row',
  )
  requireSequence(
    previousContract !== undefined &&
      postgresqlMigrationSqlDigest(previousContract.sql) === step.contractRow.beforeDigest,
    'upgrade old contract-row digest differs',
  )
  requireSequence(
    statementKey(step.contractRow.after) === 'metadata:contract-row',
    'upgrade contract-row identity differs',
  )
  const replacedByKey = new Map<string, PostgresqlCheckReplacement>(
    checkReplacements.map((item) => [`constraint:${item.logicalId}`, item]),
  )
  const predicateReplacedByKey = new Map(
    indexPredicateReplacements.map((item) => [`index:${item.logicalId}`, item]),
  )
  exact(
    indexPredicateReplacements,
    indexPredicateStatements(
      previous.plan,
      buildPostgresqlSchemaPlan(contract),
      logicalIndexPredicates,
    ),
    'index predicate statements differ from their exact projection',
  )
  const sourceReplacedByKey = new Map(
    sourceRevisionReplacements.map((item) => [`function:${item.logicalId}`, item]),
  )
  const columnTableIds = new Set(logicalColumns.map((column) => column.tableId))
  const columnReplacedByKey = new Map(
    buildPostgresqlSchemaPlan(contract)
      .statements.filter(
        (statement) => statement.kind === 'table' && columnTableIds.has(statement.logicalId),
      )
      .map((statement) => [statementKey(statement), statement]),
  )
  const original = retainedStatements(previous, retiredTables).map((statement) => {
    const key = statementKey(statement)
    if (key === 'metadata:contract-row') return step.contractRow.after
    const columnReplacement = columnReplacedByKey.get(key)
    if (columnReplacement) return columnReplacement
    const predicateReplacement = predicateReplacedByKey.get(key)
    if (predicateReplacement) return predicateReplacement.after
    const sourceReplacement = sourceReplacedByKey.get(key)
    if (sourceReplacement) {
      exact(sourceReplacement.before, statement, 'source clock previous function differs')
      return sourceReplacement.after
    }
    const replacement = replacedByKey.get(key)
    if (replacement === undefined) return statement
    exact(replacement.before, statement, 'check replacement old statement differs')
    exact(
      replacement.drop,
      checkDropStatement(statement),
      'check replacement drop statement differs',
    )
    return replacement.after
  })
  requireSequence(
    replacedByKey.size === checkReplacements.length &&
      checkReplacements.every((item) =>
        previous.plan.statements.some(
          (statement) => statementKey(statement) === `constraint:${item.logicalId}`,
        ),
      ),
    'check replacement names a statement the previous plan does not have',
  )
  const statements = insertAtPositions(
    original,
    step.indexAdditions.map((addition) => ({
      position: addition.position,
      value: addition.statement,
    })),
  )
  const planBody = {
    ...planPayload(previous.plan),
    contractDigest: contract.digest,
    activeTableCount: contract.activeTableCount,
    archiveOnlyTableCount: contract.archiveOnlyTableCount,
    statements,
  }
  const plan = { ...planBody, digest: postgresqlMigrationDigest(planBody) }
  requireSequence(plan.digest === step.to.planDigest, 'upgrade target plan digest differs')
  const projected = buildPostgresqlSchemaPlan(contract)
  const oldStatements = new Map(
    previous.plan.statements.map((statement) => [statementKey(statement), statement]),
  )
  for (const statement of projected.statements) {
    const key = statementKey(statement)
    const prior = oldStatements.get(key)
    if (
      prior !== undefined &&
      key !== 'metadata:contract-row' &&
      !replacedByKey.has(key) &&
      !sourceReplacedByKey.has(key) &&
      !predicateReplacedByKey.has(key) &&
      !columnReplacedByKey.has(key)
    )
      exact(statement, prior, 'schema upgrade changed an existing statement')
  }
  exact(
    sourceRevisionReplacements,
    sourceRevisionFunctionReplacements(previous.plan, projected, logicalSourceRevision),
    'source clock function replacements differ from their exact projection',
  )
  for (const [key, replacement] of replacedByKey) {
    exact(
      projected.statements.find((statement) => statementKey(statement) === key),
      replacement.after,
      'replaced check SQL differs from its logical projection',
    )
  }
  const additions = projected.statements.filter(
    (statement) => !oldStatements.has(statementKey(statement)),
  )
  exact(
    step.indexAdditions.map((addition) => addition.statement),
    additions,
    'added index SQL differs from its logical projection',
  )
  exact(statements, projected.statements, 'schema upgrade statement replay differs')
  exact(
    step.contractRow.after,
    projected.statements.find((statement) => statementKey(statement) === 'metadata:contract-row'),
    'new contract-row projection differs',
  )
  exact(
    step.executableStatements,
    [
      ...retiredProjectionStatements(previous, retiredTables),
      ...retirementStatements(previous.contract, retiredTables),
      ...checkReplacements.flatMap((item) => [item.drop, item.after]),
      ...indexPredicateReplacements.flatMap((item) => [item.drop, item.after]),
      ...sourceRevisionReplacements.map(sourceRevisionExecutable),
      ...columnAdditionStatements(contract, logicalColumns),
      ...step.indexAdditions.map((addition) => addition.statement),
      contractUpdate(previous.plan, plan),
    ],
    'upgrade executable SQL differs',
  )
  requireSequence(
    step.sqlFile === `${step.id}.sql` &&
      step.sqlDigest === postgresqlMigrationSqlDigest(renderPostgresqlUpgradeSql(step)),
    'upgrade SQL file identity differs',
  )
  exact(step.sqliteMigration.from, previous.sqliteMigration, 'upgrade SQLite source prefix differs')
  requireSequence(step.sqliteMigration.appended.length > 0, 'upgrade SQLite prefix did not advance')
  const sqliteMigrations = [...previous.sqliteMigrations, ...step.sqliteMigration.appended]
  const version = {
    contract,
    plan,
    sqliteMigrations,
    sqliteMigration: postgresqlSqliteMigrationIdentity(sqliteMigrations),
  }
  exact(step.sqliteMigration.to, version.sqliteMigration, 'upgrade SQLite target prefix differs')
  validateVersion(version)
  return version
}

/** One replay, advanced a version at a time so a caller may yield between versions. */
function* replayVersions(
  root: PostgresqlMigrationRoot,
  steps: readonly PostgresqlIndexUpgrade[],
): Generator<void, PostgresqlMigrationHistory, void> {
  // Versions share unchanged tables by reference, so one fragment cache serves the
  // whole replay. It is active only inside each synchronous step, never across a yield.
  const fragments = createCanonicalFragmentCache()
  withCanonicalFragmentCache(fragments, () => validateVersion(root))
  let head: PostgresqlMigrationVersion = {
    contract: root.contract,
    plan: root.plan,
    sqliteMigrations: root.sqliteMigrations,
    sqliteMigration: root.sqliteMigration,
  }
  let previousDigest = withCanonicalFragmentCache(fragments, () => postgresqlMigrationDigest(root))
  const versions = [head]
  const seenContracts = new Set([head.contract.digest])
  for (const [index, step] of steps.entries()) {
    yield
    const previous = head
    const digestBefore = previousDigest
    head = withCanonicalFragmentCache(fragments, () =>
      applyPostgresqlIndexUpgrade(previous, step, digestBefore, index + 1),
    )
    requireSequence(
      !seenContracts.has(head.contract.digest),
      'schema history has an ambiguous or repeated contract digest',
    )
    seenContracts.add(head.contract.digest)
    versions.push(head)
    previousDigest = step.digest
  }
  return { root, steps, versions, head }
}

export function replayPostgresqlMigrationHistory(
  root: PostgresqlMigrationRoot,
  steps: readonly PostgresqlIndexUpgrade[],
): PostgresqlMigrationHistory {
  const replay = replayVersions(root, steps)
  let next = replay.next()
  while (next.done !== true) next = replay.next()
  return next.value
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/**
 * The same replay for a running daemon. Each version costs tens of milliseconds of
 * canonical JSON and digests, and the whole history about two seconds, so the event
 * loop gets a turn between versions instead of one block (RFC-349 evidence
 * 38613687770: 2.2 s event-loop gaps during a migration).
 */
export async function replayPostgresqlMigrationHistoryYielding(
  root: PostgresqlMigrationRoot,
  steps: readonly PostgresqlIndexUpgrade[],
  yieldTurn: () => Promise<void> = nextTurn,
): Promise<PostgresqlMigrationHistory> {
  const replay = replayVersions(root, steps)
  let next = replay.next()
  while (next.done !== true) {
    await yieldTurn()
    next = replay.next()
  }
  return next.value
}

export function assertPostgresqlMigrationHead(
  history: PostgresqlMigrationHistory,
  contract: LogicalSchemaContract,
  plan: PostgresqlSchemaPlan,
): void {
  exact(
    history.head.contract,
    contract,
    'schema history head differs from current logical contract',
  )
  exact(history.head.plan, plan, 'schema history head differs from current PostgreSQL plan')
}

export function postgresqlUpgradeReceipt(step: PostgresqlIndexUpgrade): PostgresqlCompletedUpgrade {
  return {
    baselineId: `upgrade:${step.id}:${step.digest}`,
    contractDigest: step.to.contractDigest,
    planDigest: step.to.planDigest,
  }
}

export function planPostgresqlUpgrade(
  history: PostgresqlMigrationHistory,
  input: {
    readonly baseline: PostgresqlSchemaIdentity
    readonly current: PostgresqlSchemaIdentity
    readonly completed: readonly PostgresqlCompletedUpgrade[]
  },
): readonly PostgresqlIndexUpgrade[] {
  const baselineAt = history.versions.findIndex(
    (version) =>
      canonicalSchemaJson(postgresqlSchemaIdentity(version.plan)) ===
      canonicalSchemaJson(input.baseline),
  )
  requireSequence(baselineAt >= 0, 'unsupported PostgreSQL baseline contract/plan pair')
  requireSequence(
    baselineAt + input.completed.length < history.versions.length,
    'too many completed PostgreSQL upgrade receipts',
  )
  const receipts = new Map(input.completed.map((row) => [row.baselineId, row]))
  requireSequence(receipts.size === input.completed.length, 'duplicate PostgreSQL upgrade receipt')
  for (let index = 0; index < input.completed.length; index += 1) {
    const expected = postgresqlUpgradeReceipt(history.steps[baselineAt + index]!)
    exact(
      receipts.get(expected.baselineId),
      expected,
      'PostgreSQL upgrade receipt has a gap or different ID/digest',
    )
  }
  exact(
    input.current,
    postgresqlSchemaIdentity(history.versions[baselineAt + input.completed.length]!.plan),
    'PostgreSQL metadata and completed upgrade receipts disagree',
  )
  return history.steps.slice(baselineAt + input.completed.length)
}

export function resolvePostgresqlHistoricalContract(
  history: PostgresqlMigrationHistory,
  digest: string,
): LogicalSchemaContract {
  const version = history.versions.find((candidate) => candidate.contract.digest === digest)
  requireSequence(version !== undefined, 'unsupported historical logical schema contract')
  return version.contract
}

function resolvePostgresqlRowBridge(
  history: PostgresqlMigrationHistory,
  input: HistoricalRowBridgeInput,
  allowNewTables: boolean,
): {
  readonly source: LogicalSchemaContract
  readonly target: LogicalSchemaContract
  readonly steps: readonly PostgresqlIndexUpgrade[]
} {
  const from = history.versions.findIndex(
    (version) => version.contract.digest === input.fromContractDigest,
  )
  const to = history.versions.findIndex(
    (version) => version.contract.digest === input.toContractDigest,
  )
  requireSequence(from >= 0 && to >= from, 'unsupported historical index-only row bridge')
  const source = history.versions[from]!.contract
  const target = history.versions[to]!.contract
  // RFC-366: a value-domain widening is row-compatible by construction — every
  // row written under the narrower CHECK still satisfies the wider one — so the
  // additive bridge folds those edges the same way it folds new tables. The
  // index-only bridge deliberately does NOT: its whole contract is "nothing
  // about the rows moved", and a widened domain is a change to the rows' shape
  // even when no row has to be rewritten.
  exact(
    rowContract(
      allowNewTables
        ? history.steps
            .slice(from, to)
            .reduce(
              (contract, step) =>
                applyLogicalOwners(
                  applyLogicalIndexPredicates(
                    applyLogicalSourceRevision(
                      applyLogicalColumnEnums(
                        applyLogicalCheckReplacements(
                          appendLogicalIndexes(
                            appendLogicalColumns(
                              appendLogicalTables(
                                retireLogicalTables(contract, step.retiredTables ?? []),
                                step.logicalTables ?? [],
                              ),
                              step.logicalColumns ?? [],
                            ),
                            step.logicalIndexes,
                            step.logicalColumns ?? [],
                          ),
                          step.logicalChecks ?? [],
                        ),
                        step.logicalEnums ?? [],
                      ),
                      step.logicalSourceRevision,
                    ),
                    step.logicalIndexPredicates ?? [],
                  ),
                  step.logicalOwners ?? [],
                ),
              source,
            )
        : history.steps
            .slice(from, to)
            .reduce(
              (contract, step) =>
                applyLogicalOwners(
                  applyLogicalSourceRevision(
                    contract,
                    step.logicalSourceRevision,
                    'historical row, codec, key or disposition changed',
                  ),
                  step.logicalOwners ?? [],
                ),
              source,
            ),
    ),
    rowContract(target),
    'historical row, codec, key or disposition changed',
  )
  exact(
    source.tables.filter((table) => table.disposition === 'ARCHIVE_THEN_OMIT'),
    target.tables.filter((table) => table.disposition === 'ARCHIVE_THEN_OMIT'),
    'historical archive-only table contract changed',
  )
  return { source, target, steps: history.steps.slice(from, to) }
}

interface HistoricalRowBridgeInput {
  readonly fromContractDigest: string
  readonly toContractDigest: string
}

/** The original V1 contract still rejects table additions. */
export function resolvePostgresqlIndexOnlyRowBridge(
  history: PostgresqlMigrationHistory,
  input: HistoricalRowBridgeInput,
) {
  return resolvePostgresqlRowBridge(history, input, false)
}

/** New active tables start empty when restoring a historical backup. Existing rows are unchanged. */
export function resolvePostgresqlAdditiveRowBridge(
  history: PostgresqlMigrationHistory,
  input: HistoricalRowBridgeInput,
) {
  return resolvePostgresqlRowBridge(history, input, true)
}
