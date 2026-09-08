// RFC-359 T19h — immutable schema history and exact, replayable upgrade edges.
// This module never opens a database. Runtime admission and the artifact writer
// share this program; PostgreSQL executes only the verified statement sequence.

import type { ExpectedMigration } from '@/db/schemaAdmission'
import { sha256Hex } from '@/util/hash'
import {
  buildPostgresqlSchemaPlan,
  renderPostgresqlBaselineSql,
  type PostgresqlSchemaPlan,
  type PostgresqlSchemaStatement,
} from './postgresqlSchema'
import {
  canonicalSchemaJson,
  digestSchemaContract,
  type LogicalIndexContract,
  type LogicalSchemaContract,
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

export interface PostgresqlIndexUpgrade {
  readonly version: 1
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

export interface PostgresqlMigrationHistory {
  readonly root: PostgresqlMigrationRoot
  readonly versions: readonly PostgresqlMigrationVersion[]
  readonly steps: readonly PostgresqlIndexUpgrade[]
  readonly head: PostgresqlMigrationVersion
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

function logicalIndexAdditions(
  from: LogicalSchemaContract,
  to: LogicalSchemaContract,
): LogicalIndexAddition[] {
  exact(
    rowContract(from),
    rowContract(to),
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
): LogicalSchemaContract {
  for (const addition of additions) {
    const table = contract.tables.find((candidate) => candidate.id === addition.tableId)
    requireSequence(
      table !== undefined && table.disposition !== 'ARCHIVE_THEN_OMIT',
      'index addition requires an existing active table',
    )
    requireSequence(
      !addition.index.unique,
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
    return { ...table, indexes }
  })
  const payload = { ...contractPayload(contract), tables }
  return { ...payload, digest: digestSchemaContract(payload) }
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

export function createPostgresqlIndexUpgrade(input: {
  readonly from: PostgresqlMigrationVersion
  readonly to: PostgresqlMigrationVersion
  readonly id: string
  readonly sequence: number
  readonly previousEntryDigest: string
}): PostgresqlIndexUpgrade {
  const { from, to } = input
  validateVersion(from)
  validateVersion(to)
  const logicalIndexes = logicalIndexAdditions(from.contract, to.contract)
  requireSequence(logicalIndexes.length > 0, 'schema upgrade has no new indexes')
  exact(
    appendLogicalIndexes(from.contract, logicalIndexes),
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
  const old = new Map(from.plan.statements.map((statement) => [statementKey(statement), statement]))
  const next = new Map(to.plan.statements.map((statement) => [statementKey(statement), statement]))
  for (const statement of from.plan.statements) {
    requireSequence(
      next.has(statementKey(statement)),
      'schema upgrade removed an existing statement',
    )
    if (statementKey(statement) !== 'metadata:contract-row')
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
  const executableStatements = [
    ...indexAdditions.map((addition) => addition.statement),
    contractUpdate(from.plan, to.plan),
  ]
  const payload = {
    version: 1 as const,
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
    step.version === 1 && digest === postgresqlMigrationDigest(payload),
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
  requireSequence(step.logicalIndexes.length > 0, 'schema upgrade has no new indexes')
  const contract = appendLogicalIndexes(previous.contract, step.logicalIndexes)
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
  const original = previous.plan.statements.map((statement) =>
    statementKey(statement) === 'metadata:contract-row' ? step.contractRow.after : statement,
  )
  const statements = insertAtPositions(
    original,
    step.indexAdditions.map((addition) => ({
      position: addition.position,
      value: addition.statement,
    })),
  )
  const planBody = { ...planPayload(previous.plan), contractDigest: contract.digest, statements }
  const plan = { ...planBody, digest: postgresqlMigrationDigest(planBody) }
  requireSequence(plan.digest === step.to.planDigest, 'upgrade target plan digest differs')
  const projected = buildPostgresqlSchemaPlan(contract)
  const addedIds = new Set(
    step.logicalIndexes.map((addition) => `${addition.tableId}:index:${addition.index.name}`),
  )
  requireSequence(
    addedIds.size === step.indexAdditions.length,
    'logical and physical index additions differ',
  )
  exact(
    step.indexAdditions.map((addition) => addition.statement),
    projected.statements.filter(
      (statement) => statement.kind === 'index' && addedIds.has(statement.logicalId),
    ),
    'added index SQL differs from its logical projection',
  )
  exact(
    step.contractRow.after,
    projected.statements.find((statement) => statementKey(statement) === 'metadata:contract-row'),
    'new contract-row projection differs',
  )
  exact(
    step.executableStatements,
    [
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

export function replayPostgresqlMigrationHistory(
  root: PostgresqlMigrationRoot,
  steps: readonly PostgresqlIndexUpgrade[],
): PostgresqlMigrationHistory {
  validateVersion(root)
  let head: PostgresqlMigrationVersion = {
    contract: root.contract,
    plan: root.plan,
    sqliteMigrations: root.sqliteMigrations,
    sqliteMigration: root.sqliteMigration,
  }
  let previousDigest = postgresqlMigrationDigest(root)
  const versions = [head]
  const seenContracts = new Set([head.contract.digest])
  for (const [index, step] of steps.entries()) {
    head = applyPostgresqlIndexUpgrade(head, step, previousDigest, index + 1)
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

export function resolvePostgresqlIndexOnlyRowBridge(
  history: PostgresqlMigrationHistory,
  input: {
    readonly fromContractDigest: string
    readonly toContractDigest: string
  },
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
  exact(
    rowContract(source),
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
