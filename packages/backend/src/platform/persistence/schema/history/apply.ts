import type { HistorySession } from './session'
import { persistenceDialect } from '../../nativeDialect'
// RFC-395 II-b R2: the DDL, transform receipt and version receipt commit together.
import { unhandledDatabaseProvider } from '../../databaseProviders'
import { canonicalSchemaJson, digestSchemaContract } from '../canonical'
import {
  compileMetaTables,
  metaTableName,
  HISTORY_META_TABLES,
  type MetaTableDeclaration,
} from './meta'
import { parameters, type HistoryConnection } from './connection'
import { installTargetSentinel, initializeFirstWriteMarker } from './markers'
import { compileInstallSeeds, renderInstallSeedStatements, type InstallPath } from '../seeds'
import { verifyHistoryVersion } from './artifacts'
import { deriveSchemaEdge, sameSchemaValue, sameHistoryVersion } from './edgeDiff'
import {
  SchemaHistoryError,
  type HistoryVersion,
  type SchemaHistoryRow,
  type HistoryStatement,
} from './types'

export interface ApplyHistoryOptions {
  readonly version: HistoryVersion
  readonly now?: () => number
  readonly metaTables?: readonly MetaTableDeclaration[]
  readonly afterStatement?: (index: number) => void
}
export async function readSchemaHistoryRows(
  connection: HistoryConnection,
  fromVersion = 0,
): Promise<readonly SchemaHistoryRow[]> {
  let presenceQuery: string
  switch (connection.provider) {
    case 'sqlite':
      presenceQuery =
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'aw_meta_schema_history'"
      break
    case 'postgresql':
      presenceQuery =
        "SELECT 1 FROM information_schema.tables WHERE table_schema = 'agent_workflow_meta' AND table_name = 'schema_history'"
      break
    default:
      return unhandledDatabaseProvider(connection.provider)
  }
  const present = await connection.execute(presenceQuery)
  if (!present.length)
    throw new SchemaHistoryError('not-epoch-2-database', 'schema-history metadata is absent')
  const rows = await connection.execute(
    `SELECT version, contract_digest, sqlite_plan_digest, postgresql_plan_digest, applied_at, artifact_json FROM ${metaTableName(connection.provider, 'schema_history')} WHERE version >= ${parameters(connection, 1)} ORDER BY version`,
    [fromVersion],
  )
  return rows.map((row) => ({
    version: Number(row.version),
    contractDigest: String(row.contract_digest),
    sqlitePlanDigest: String(row.sqlite_plan_digest),
    postgresqlPlanDigest: String(row.postgresql_plan_digest),
    appliedAt: Number(row.applied_at),
    artifact: JSON.parse(String(row.artifact_json)) as HistoryVersion,
  }))
}
export function assertHistoryRow(row: SchemaHistoryRow): void {
  verifyHistoryVersion(row.artifact)
  if (
    row.version !== row.artifact.contract.version ||
    row.contractDigest !== row.artifact.contract.contract.digest ||
    row.sqlitePlanDigest !== row.artifact.sqlite.digest ||
    row.postgresqlPlanDigest !== row.artifact.postgresql.digest
  )
    throw new SchemaHistoryError('receipt-mismatch', String(row.version))
}
async function apply(
  connection: HistoryConnection,
  options: ApplyHistoryOptions,
): Promise<boolean> {
  const version = options.version
  verifyHistoryVersion(version)
  for (const sql of compileMetaTables(
    connection.provider,
    options.metaTables ?? HISTORY_META_TABLES,
  ))
    await connection.execute(sql)
  const rows = await readSchemaHistoryRows(connection)
  for (const row of rows) assertHistoryRow(row)
  const existing = rows.find((row) => row.version === version.contract.version)
  if (existing) {
    if (!sameHistoryVersion(existing.artifact, version))
      throw new SchemaHistoryError('immutable-version', String(existing.version))
    return false
  }
  const last = rows.at(-1)?.artifact
  if (
    version.contract.version !== (last ? last.contract.version + 1 : 0) ||
    version.contract.previousDigest !== (last?.contract.digest ?? null)
  )
    throw new SchemaHistoryError('predecessor', 'apply versions in order')
  if (last) {
    const edge = version.contract.edge
    if (
      !edge ||
      !sameSchemaValue(
        edge,
        deriveSchemaEdge(edge.kind, last.contract.contract, version.contract.contract, edge),
      )
    )
      throw new SchemaHistoryError('edge-diff-mismatch', String(version.contract.version))
  } else if (version.contract.edge !== null)
    throw new SchemaHistoryError('baseline-edge', 'initial version must be a baseline')
  const now = options.now?.() ?? Date.now()
  const edge = version.contract.edge
  const receiptTable = metaTableName(connection.provider, 'schema_transform_receipts')
  let transformed = false
  if (edge?.kind === 'data-transform') {
    const recorded = await connection.execute(
      `SELECT edge_digest FROM ${receiptTable} WHERE receipt_id = ${parameters(connection, 1)}`,
      [edge.receiptId],
    )
    if (recorded.length) {
      if (recorded[0]!.edge_digest !== digestSchemaContract(edge))
        throw new SchemaHistoryError('transform-receipt-conflict', edge.receiptId)
      transformed = true
    }
  }
  if (!transformed)
    for (const [index, sql] of version[connection.provider].statements.entries()) {
      await connection.execute(sql)
      options.afterStatement?.(index)
    }
  if (edge?.kind === 'data-transform' && !transformed)
    await connection.execute(
      `INSERT INTO ${receiptTable} (receipt_id, edge_digest, applied_at) VALUES (${parameters(connection, 3)})`,
      [edge.receiptId, digestSchemaContract(edge), now],
    )
  await installTargetSentinel(connection)
  await connection.execute(
    `INSERT INTO ${metaTableName(connection.provider, 'schema_history')} (version, contract_digest, sqlite_plan_digest, postgresql_plan_digest, applied_at, artifact_json) VALUES (${parameters(connection, 6)})`,
    [
      version.contract.version,
      version.contract.contract.digest,
      version.sqlite.digest,
      version.postgresql.digest,
      now,
      canonicalSchemaJson(version),
    ],
  )
  if ((options.metaTables ?? HISTORY_META_TABLES).some((table) => table.name === 'generations'))
    await connection.execute(
      `UPDATE ${metaTableName(connection.provider, 'generations')} SET contract_digest = ${parameters(connection, 2).split(', ')[0]}, plan_digest = ${parameters(connection, 2).split(', ')[1]} WHERE state = 'active'`,
      [version.contract.contract.digest, version[connection.provider].digest],
    )
  return true
}
export function applyHistoryVersion(
  session: HistorySession,
  options: ApplyHistoryOptions,
): Promise<boolean> {
  return session.transaction((connection) => apply(connection, options))
}
export interface InstallHistoryHeadOptions extends ApplyHistoryOptions {
  readonly generationId: string
  readonly installPath: InstallPath
}
async function installHead(
  connection: HistoryConnection,
  options: InstallHistoryHeadOptions,
): Promise<void> {
  const { version } = options
  verifyHistoryVersion(version)
  const now = options.now?.() ?? Date.now()
  const contract = version.contract.contract
  const seeds = compileInstallSeeds(
    {
      schemaEpoch: 2,
      tables: contract.tables,
      contributions: contract.contributions.map((entry) => ({
        ...entry,
        tables: contract.tables.filter((table) => table.owner === entry.owner),
      })),
    },
    { path: options.installPath, installedAt: now },
  )
  // Fresh installs execute the compiled head only, never historical edges or transforms.
  const statements = [
    ...version[connection.provider].head.map((statement) => statement.sql),
    ...compileMetaTables(connection.provider, options.metaTables ?? HISTORY_META_TABLES),
    ...renderInstallSeedStatements(seeds.rows, connection.provider),
  ]
  for (const [index, statement] of statements.entries()) {
    await connection.execute(statement)
    options.afterStatement?.(index)
  }
  if (options.installPath === 'hosted-installation') {
    const policy = persistenceDialect(connection.provider).tableName('auth_login_policy')
    await connection.execute(
      `UPDATE ${policy} SET bootstrap_completed_at = ${now}, updated_at = ${now} WHERE id = 'global' AND bootstrap_completed_at IS NULL`,
    )
  }
  if (options.metaTables?.some((table) => table.name === 'generations'))
    await connection.execute(
      `INSERT INTO ${metaTableName(connection.provider, 'generations')} (generation_id, schema_epoch, role, state, provider, contract_digest, plan_digest, created_at, activated_at) VALUES (${parameters(connection, 9)})`,
      [
        options.generationId,
        2,
        'installed',
        'active',
        connection.provider,
        contract.digest,
        version[connection.provider].digest,
        now,
        now,
      ],
    )
  await initializeFirstWriteMarker(connection, options.generationId)
  await installTargetSentinel(connection)
  await connection.execute(
    `INSERT INTO ${metaTableName(connection.provider, 'schema_history')} (version, contract_digest, sqlite_plan_digest, postgresql_plan_digest, applied_at, artifact_json) VALUES (${parameters(connection, 6)})`,
    [
      version.contract.version,
      contract.digest,
      version.sqlite.digest,
      version.postgresql.digest,
      now,
      canonicalSchemaJson(version),
    ],
  )
}
/** Install the embedded head under the native session's schema transaction. */
export function installHistoryHead(
  session: HistorySession,
  options: InstallHistoryHeadOptions,
): Promise<void> {
  return session.transaction((connection) => installHead(connection, options))
}

export interface InstallConversionHeadOptions extends ApplyHistoryOptions {
  readonly generationId: string
}
/** Conversion uses the head without install-only seeds, and validates FKs after loading. */
export async function installConversionHistoryHead(
  connection: HistoryConnection,
  options: InstallConversionHeadOptions,
): Promise<{ readonly deferred: readonly HistoryStatement[] }> {
  const { version } = options
  verifyHistoryVersion(version)
  const deferred: HistoryStatement[] = []
  for (const [index, statement] of version[connection.provider].head.entries()) {
    if (
      persistenceDialect(connection.provider).deferredForeignKeys &&
      statement.kind === 'constraint' &&
      statement.logicalId.includes(':fk:')
    )
      deferred.push(statement)
    else await connection.execute(statement.sql)
    options.afterStatement?.(index)
  }
  for (const sql of compileMetaTables(
    connection.provider,
    options.metaTables ?? HISTORY_META_TABLES,
  ))
    await connection.execute(sql)
  await initializeFirstWriteMarker(connection, options.generationId)
  await installTargetSentinel(connection)
  await connection.execute(
    `INSERT INTO ${metaTableName(connection.provider, 'schema_history')} (version, contract_digest, sqlite_plan_digest, postgresql_plan_digest, applied_at, artifact_json) VALUES (${parameters(connection, 6)})`,
    [
      version.contract.version,
      version.contract.contract.digest,
      version.sqlite.digest,
      version.postgresql.digest,
      options.now?.() ?? Date.now(),
      canonicalSchemaJson(version),
    ],
  )
  return { deferred }
}
export function installConversionHead(
  session: HistorySession,
  options: InstallConversionHeadOptions,
) {
  return session.transaction((connection) => installConversionHistoryHead(connection, options))
}
