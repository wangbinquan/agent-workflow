// RFC-395 I-a: frozen RFC-349 v2 projection rules from 5f11d1857.
// These labels are the epoch-1 artifact format, not contribution ownership.
import { is, SQL } from 'drizzle-orm'
import {
  getTableConfig,
  SQLiteSyncDialect,
  SQLiteTable,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core'
import { databaseProviderTraits } from '../../providerTraits'
import { digestSchemaContract } from '../../schema/canonical'
import { assertExactSchemaRoster } from '../../schema/roster'
import {
  RFC349_SOURCE_TABLES,
  RFC349_ARCHIVE_TABLE_SET,
  RFC349_DEFER_TABLES,
  RFC349_SCHEMA_CONTRACT_VERSION,
  type DatabaseProvider,
  type TableDisposition,
  type OwnerContext,
  type LogicalCodec,
  type LogicalColumnContract,
  type LogicalIndexContract,
  type LogicalConstraintContract,
  type RetentionContract,
  type ConsumerLedgerContract,
  type LogicalTableContract,
  type LogicalSchemaContract,
} from '../../schema/contractTypes'
import type { SchemaRegistry } from '../../schema/registry'
import { materializeDrizzle } from '../../schema/drizzle'

function renderSqliteDefault(value: SQL): string {
  return sqliteDialect.sqlToQuery(value).sql.replaceAll(/\s+/g, ' ').trim()
}

export function renderPostgresqlDatabaseDefault(value: SQL): string {
  const expression = renderSqliteDefault(value)
  if (/^\(?unixepoch\(\) \* 1000\)?$/i.test(expression)) {
    return '(extract(epoch from clock_timestamp()) * 1000)::bigint'
  }
  if (/^\(?lower\(hex\(randomblob\(16\)\)\)\)?$/i.test(expression)) {
    return 'md5(random()::text || clock_timestamp()::text)'
  }
  // Remaining committed defaults are literal/provider-neutral expressions.
  // The baseline projector independently validates this allowlist before DDL.
  return expression
}

function ownerFor(table: string): OwnerContext {
  if (table.startsWith('observation_')) return 'run-observability'
  if (table.startsWith('development_') || table === 'mission_input_uploads') {
    return 'development-automation'
  }
  if (
    table.startsWith('employee_') ||
    table.startsWith('digital_employee_') ||
    table === 'digital_employees' ||
    table === 'digital_employee_revisions' ||
    table === 'repository_employee_assignments'
  ) {
    return 'digital-employee'
  }
  if (table.startsWith('intent_')) return 'intent'
  if (table === 'memories' || table.startsWith('memory_')) return 'knowledge-evolution'
  if (
    table.startsWith('event_') ||
    table.startsWith('custom_event_') ||
    table === 'observer_activations'
  ) {
    return 'event-center'
  }
  if (table.startsWith('committed_event_') || table === 'committed_events') {
    return 'platform-events'
  }
  if (
    table.startsWith('user_') ||
    table === 'users' ||
    table.startsWith('oidc_') ||
    table === 'auth_login_policy' ||
    table === 'external_identities' ||
    table === 'resource_grants' ||
    table.startsWith('token_')
  ) {
    return 'identity-access'
  }
  if (
    table.startsWith('code_') ||
    table.startsWith('webhook_') ||
    table.startsWith('cs_event_') ||
    table === 'cs_webhook_verifications' ||
    table === 'legacy_code_work_item_links'
  ) {
    return 'integration'
  }
  if (
    table === 'cached_repos' ||
    table.startsWith('sc_') ||
    table.startsWith('repo_') ||
    table.startsWith('repository_transport_') ||
    table === 'hosted_task_workspaces' ||
    table === 'hosted_workspace_commands'
  ) {
    return 'source-control'
  }
  if (
    table.startsWith('maintenance_') ||
    table.startsWith('lifecycle_') ||
    table === 'recovery_events' ||
    table === 'application_configuration' ||
    table === 'hosted_execution_control' ||
    table === 'hosted_database_backups' ||
    table === 'hosted_object_publications'
  ) {
    return 'system-operations'
  }
  if (
    table.startsWith('collaboration_') ||
    table.startsWith('review_') ||
    table === 'clarify_rounds' ||
    table === 'task_collaborators' ||
    table === 'task_feedback' ||
    table === 'task_questions'
  ) {
    return 'collaboration'
  }
  if (
    table === 'tasks' ||
    table.startsWith('task_') ||
    table.startsWith('node_run') ||
    table === 'node_execution_event_sources' ||
    table.startsWith('workgroup_') ||
    table === 'workgroups' ||
    table === 'runtime_session_leases' ||
    table === 'hosted_execution_bindings' ||
    table === 'hosted_execution_events' ||
    table === 'hosted_recovery_requests' ||
    table === 'hosted_task_artifacts' ||
    table === 'hosted_task_archive_entries' ||
    table === 'hosted_node_event_archives'
  ) {
    return 'task-execution'
  }
  return 'resource-catalog'
}

function dispositionFor(table: string): TableDisposition {
  if (RFC349_ARCHIVE_TABLE_SET.has(table)) return 'ARCHIVE_THEN_OMIT'
  if (RFC349_DEFER_TABLES.has(table)) return 'DEFER'
  return 'KEEP'
}

function codecFor(column: AnySQLiteColumn): LogicalCodec {
  if (column.dataType === 'boolean') return 'boolean'
  if (column.dataType === 'number') {
    if (column.columnType === 'SQLiteReal') return 'real'
    if (
      /(?:^|_)(?:at|until|after|before|deadline|expires|heartbeat|timestamp)(?:_|$)/.test(
        column.name,
      )
    ) {
      return 'epoch-milliseconds'
    }
    return 'integer'
  }
  if (column.dataType === 'buffer') return 'opaque-bytes'
  if (column.enumValues?.length) return 'text'
  if (
    column.name.endsWith('_json') ||
    /^(?:definition|inputs|outputs|permission|skills|depends_on|mcp|plugins|frontmatter_extra)$/.test(
      column.name,
    )
  ) {
    return 'json-text'
  }
  if (column.primary || /(?:^id$|_id$|_ref$|_key$|_digest$)/.test(column.name)) {
    return 'text-identity'
  }
  return 'text'
}

function postgresqlType(codec: LogicalCodec): string {
  switch (codec) {
    case 'boolean':
      return 'boolean'
    case 'epoch-milliseconds':
    case 'integer':
      return 'bigint'
    case 'real':
      return 'double precision'
    case 'opaque-bytes':
      return 'bytea'
    case 'json-text':
    case 'text':
    case 'text-identity':
      return 'text'
  }
}

function defaultKind(column: AnySQLiteColumn): LogicalColumnContract['defaultKind'] {
  if (!column.hasDefault) return 'none'
  if ((column as AnySQLiteColumn & { readonly autoIncrement?: boolean }).autoIncrement) {
    return 'identity'
  }
  if (column.default === undefined && column.primary) return 'implicit-primary'
  if (column.defaultFn !== undefined) return 'runtime'
  if (is(column.default, SQL)) return 'database-expression'
  return 'literal'
}

function literalSql(value: unknown, provider: DatabaseProvider): string {
  if (value === null) return 'NULL'
  if (typeof value === 'boolean') {
    // Per-provider rendering lives in the traits table so a new provider cannot
    // silently inherit SQLite's 1/0 (which PostgreSQL rejects on a boolean).
    return databaseProviderTraits(provider).booleanLiteral(value)
  }
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`
  throw new Error(`RFC-349 unsupported database default value type: ${typeof value}`)
}

function defaultProjection(
  column: AnySQLiteColumn,
): Pick<LogicalColumnContract, 'defaultValue' | 'providerDefault'> {
  if (!column.hasDefault) {
    return { defaultValue: null, providerDefault: { sqlite: null, postgresql: null } }
  }
  if ((column as AnySQLiteColumn & { readonly autoIncrement?: boolean }).autoIncrement) {
    return { defaultValue: 'identity', providerDefault: { sqlite: null, postgresql: null } }
  }
  if (column.default === undefined && column.primary) {
    return { defaultValue: 'implicit-primary', providerDefault: { sqlite: null, postgresql: null } }
  }
  if (column.defaultFn !== undefined) {
    return { defaultValue: 'runtime', providerDefault: { sqlite: null, postgresql: null } }
  }
  if (is(column.default, SQL)) {
    const sqlite = renderExpression(column.default)
    return {
      defaultValue: sqlite,
      providerDefault: {
        sqlite,
        postgresql: renderPostgresqlDatabaseDefault(column.default),
      },
    }
  }
  return {
    defaultValue: JSON.stringify(column.default),
    providerDefault: {
      sqlite: literalSql(column.default, 'sqlite'),
      postgresql: literalSql(column.default, 'postgresql'),
    },
  }
}

const sqliteDialect = new SQLiteSyncDialect()

function renderExpression(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (is(value, SQL)) return sqliteDialect.sqlToQuery(value).sql.replaceAll(/\s+/g, ' ').trim()
  if (typeof value === 'object' && 'name' in value && typeof value.name === 'string') {
    return value.name
  }
  return String(value)
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function retentionFor(
  table: string,
  owner: OwnerContext,
  disposition: TableDisposition,
): RetentionContract {
  if (disposition === 'ARCHIVE_THEN_OMIT') {
    return {
      class: 'archive-only',
      owner,
      rule: 'Preserve the RFC-349 logical archive and source generation; never restore into the active PostgreSQL schema.',
    }
  }
  if (/(?:event|audit|attempt|delivery|lease|outbox|operation|maintenance|journal)/.test(table)) {
    return {
      class: 'owner-managed-operational',
      owner,
      rule: 'The owning bounded context defines retention and archive jobs through its application port.',
    }
  }
  return {
    class: 'owner-managed-business',
    owner,
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  }
}

function consumerLedgerFor(table: string, disposition: TableDisposition): ConsumerLedgerContract {
  if (disposition === 'ARCHIVE_THEN_OMIT') {
    return {
      productionReader: 'zero-proved',
      productionWriter: 'zero-proved',
      backgroundRecoveryDiagnostic: 'zero-proved',
      evidence: `RFC-310 T108 and RFC-349 exact source census: ${table} has no production symbol or physical-name consumer outside db/schema.ts.`,
    }
  }
  return {
    productionReader: 'owner-required',
    productionWriter: 'owner-required-or-immutable',
    backgroundRecoveryDiagnostic: 'owner-reviewed',
    evidence:
      'RFC-349 keeps this table in the active parity set; removal requires a new exact consumer ledger and approval.',
  }
}

export function projectLegacyV2(registry: SchemaRegistry): LogicalSchemaContract {
  const entries = registry.tables
    .map(
      (table) =>
        [table.schemaSymbol, materializeDrizzle(table).sqlite] as readonly [string, object],
    )
    .filter((entry): entry is [string, object] => typeof entry[1] === 'object' && entry[1] !== null)
    .map(([symbol, table]) => ({ symbol, table }))
    .filter((entry): entry is { symbol: string; table: SQLiteTable } =>
      is(entry.table, SQLiteTable),
    )
    .map(({ symbol, table }) => ({ symbol, table, config: getTableConfig(table) }))

  const byName = new Map(entries.map((entry) => [entry.config.name, entry]))
  if (byName.size !== entries.length)
    throw new Error('RFC-349 schema contract: duplicate physical table name')

  assertExactSchemaRoster(
    [...byName.keys()],
    registry.tables.map((table) => table.id),
  )

  const tables: LogicalTableContract[] = RFC349_SOURCE_TABLES.map((name) => {
    const entry = byName.get(name)
    if (!entry) throw new Error(`RFC-349 schema contract missing ${name}`)
    const { config } = entry
    const ownerContext = ownerFor(name)
    const disposition = dispositionFor(name)
    const columnPrimary = config.columns
      .filter((column) => column.primary)
      .map((column) => column.name)
    const compositePrimary = config.primaryKeys.flatMap((primary) =>
      primary.columns.map((column) => column.name),
    )
    const primaryKey = uniqueStrings([...columnPrimary, ...compositePrimary])
    if (primaryKey.length === 0) {
      throw new Error(`RFC-349 active table ${name} has no stable primary migration key`)
    }

    const indexes = config.indexes.map(
      (index): LogicalIndexContract => ({
        name: index.config.name,
        unique: index.config.unique,
        columns: index.config.columns.map(renderExpression),
        where: index.config.where === undefined ? null : renderExpression(index.config.where),
      }),
    )
    const unique: LogicalConstraintContract[] = [
      ...config.uniqueConstraints.map((constraint) => ({
        name:
          constraint.getName() ??
          `${name}_${constraint.columns.map((column) => column.name).join('_')}_unique`,
        columns: constraint.columns.map((column) => column.name),
        expression: null,
      })),
      ...indexes
        .filter((index) => index.unique)
        .map((index) => ({ name: index.name, columns: index.columns, expression: index.where })),
    ]

    const result: LogicalTableContract = {
      id: name,
      schemaSymbol: entry.symbol,
      ownerContext,
      disposition,
      sourceTable: name,
      providerTables:
        disposition === 'ARCHIVE_THEN_OMIT' ? { sqlite: name } : { sqlite: name, postgresql: name },
      migrationKey: primaryKey,
      columns: config.columns.map((column) => {
        const logicalCodec = codecFor(column)
        const defaults = defaultProjection(column)
        return {
          name: column.name,
          logicalCodec,
          nullable: !column.notNull,
          primary: primaryKey.includes(column.name),
          hasDefault: column.hasDefault,
          defaultKind: defaultKind(column),
          ...defaults,
          identity: Boolean(
            (column as AnySQLiteColumn & { readonly autoIncrement?: boolean }).autoIncrement,
          ),
          uniqueName: column.isUnique
            ? (column.uniqueName ?? `${name}_${column.name}_unique`)
            : null,
          enumValues: column.enumValues ?? [],
          providerType: {
            sqlite: column.getSQLType(),
            postgresql: postgresqlType(logicalCodec),
          },
        }
      }),
      primaryKey,
      unique,
      foreignKeys: config.foreignKeys.map((foreignKey) => {
        const reference = foreignKey.reference()
        return {
          name: foreignKey.getName(),
          columns: reference.columns.map((column) => column.name),
          foreignTable: getTableConfig(reference.foreignTable).name,
          foreignColumns: reference.foreignColumns.map((column) => column.name),
          onDelete: foreignKey.onDelete ?? 'no action',
          onUpdate: foreignKey.onUpdate ?? 'no action',
        }
      }),
      checks: config.checks.map((constraint) => ({
        name: constraint.name,
        columns: [],
        expression: renderExpression(constraint.value),
      })),
      indexes,
      retention: retentionFor(name, ownerContext, disposition),
      consumers: consumerLedgerFor(name, disposition),
      rationale:
        disposition === 'ARCHIVE_THEN_OMIT'
          ? 'RFC-310 proved the legacy writer-private table has no production consumer; RFC-349 D9 preserves a verified logical archive and omits it from the PostgreSQL active schema.'
          : disposition === 'DEFER'
            ? 'The table appears historical or transitional, but RFC-349 lacks the complete drop-proof evidence required to omit it; migrate it unchanged.'
            : 'The owning bounded context currently requires this table for live, audit, or recovery semantics.',
      ...(disposition === 'ARCHIVE_THEN_OMIT'
        ? {
            archive: {
              format: 'agent-workflow-logical-table-v1' as const,
              stableOrder: primaryKey,
              verifies: ['row-count', 'key-bounds', 'chunk-digest', 'root-digest'] as const,
              restoreIntoActiveSchema: false as const,
              approval: 'RFC-349-D9' as const,
            },
          }
        : {}),
    }
    return result
  })

  const withoutDigest = {
    contractVersion: RFC349_SCHEMA_CONTRACT_VERSION,
    sourceProjection: 'sqlite' as const,
    sourceTableCount: tables.length,
    activeTableCount: tables.filter((table) => table.disposition !== 'ARCHIVE_THEN_OMIT').length,
    archiveOnlyTableCount: tables.filter((table) => table.disposition === 'ARCHIVE_THEN_OMIT')
      .length,
    tables,
  }
  return Object.freeze({
    ...withoutDigest,
    digest: digestSchemaContract(withoutDigest),
  })
}
