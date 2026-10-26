import { collectSqliteHistoryCatalog } from '../../sqlite/historyCatalog'
import { collectPostgresqlHistoryCatalog } from '../../postgresql/historyCatalog'
export { collectSqliteHistoryCatalog } from '../../sqlite/historyCatalog'
export { collectPostgresqlHistoryCatalog } from '../../postgresql/historyCatalog'
// RFC-395 II-b R2: compare native catalogs with a compiled head, never migration replay.
import { Database } from 'bun:sqlite'
import { unhandledDatabaseProvider } from '../../databaseProviders'
import { canonicalSchemaJson, digestSchemaContract } from '../canonical'
import type { PostgresqlReservedConnection } from '../../postgresqlRuntime'
import { executePostgresqlReferenceStatements } from '../../postgresql/referenceStatements'
import { compileMetaTables, HISTORY_META_TABLES, type MetaTableDeclaration } from './meta'
import { targetSentinelStatements } from './markers'
import { postgresqlHistoryConnection, type HistoryConnection } from './connection'
import { SchemaHistoryError, type HistoryPlanArtifact } from './types'
import type { HistoryCatalog, PostgresqlCatalogArtifact } from './catalogModel'
export { sortHistoryCatalog } from './catalogModel'
export type { CatalogEntry, HistoryCatalog, PostgresqlCatalogArtifact } from './catalogModel'

export function verifyPostgresqlCatalogArtifact(
  artifact: PostgresqlCatalogArtifact,
  plan: HistoryPlanArtifact,
  metaTables?: readonly MetaTableDeclaration[],
  postgresqlMajor?: number,
): void {
  const { digest, ...payload } = artifact
  if (digestSchemaContract(payload) !== digest)
    throw new SchemaHistoryError('catalog-artifact-digest', plan.digest)
  if (
    !Number.isSafeInteger(artifact.postgresqlMajor) ||
    artifact.postgresqlMajor <= 0 ||
    artifact.formatVersion !== 1 ||
    artifact.schemaEpoch !== 2 ||
    artifact.version !== plan.version ||
    artifact.planDigest !== plan.digest ||
    (metaTables !== undefined && artifact.metaDigest !== digestSchemaContract(metaTables))
  )
    throw new SchemaHistoryError('catalog-artifact-identity', plan.digest)
  if (postgresqlMajor !== undefined && artifact.postgresqlMajor !== postgresqlMajor)
    throw new SchemaHistoryError(
      'catalog-postgresql-major',
      `artifact ${artifact.postgresqlMajor}; database ${postgresqlMajor}`,
    )
}
/** A may embed these JSON values; admission never constructs a reference database. */
export function supportedPostgresqlMajors(
  artifacts: readonly PostgresqlCatalogArtifact[],
): readonly number[] {
  return [...new Set(artifacts.map((artifact) => artifact.postgresqlMajor))].sort((a, b) => a - b)
}
export function postgresqlCatalogLoader(artifacts: readonly PostgresqlCatalogArtifact[]) {
  return async (
    plan: HistoryPlanArtifact,
    metaTables?: readonly MetaTableDeclaration[],
    postgresqlMajor?: number,
  ): Promise<PostgresqlCatalogArtifact> => {
    const candidates = artifacts.filter(
      (value) =>
        value.planDigest === plan.digest &&
        (postgresqlMajor === undefined || value.postgresqlMajor === postgresqlMajor),
    )
    if (candidates.length !== 1)
      throw new SchemaHistoryError(
        'catalog-artifact-missing',
        `${plan.digest}:${postgresqlMajor ?? 'unspecified-major'}`,
      )
    const artifact = candidates[0]!
    verifyPostgresqlCatalogArtifact(artifact, plan, metaTables, postgresqlMajor)
    return artifact
  }
}
export async function readPostgresqlMajor(connection: HistoryConnection): Promise<number> {
  const rows = await connection.execute("SELECT current_setting('server_version_num') AS version")
  return Math.floor(Number(rows[0]!.version) / 10_000)
}
/** Run only on an empty, dedicated reference connection. The target connection is always read-only during admission. */
export async function compilePostgresqlHistoryCatalog(
  reference: PostgresqlReservedConnection,
  plan: HistoryPlanArtifact,
  metaTables: readonly MetaTableDeclaration[] = HISTORY_META_TABLES,
): Promise<PostgresqlCatalogArtifact> {
  if (plan.provider !== 'postgresql')
    throw new SchemaHistoryError('catalog-provider', plan.provider)
  await reference.unsafe('BEGIN')
  try {
    const existing = await reference.unsafe(
      "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('agent_workflow','agent_workflow_meta') LIMIT 1",
    )
    if (existing.length)
      throw new SchemaHistoryError('catalog-reference-not-empty', 'use an empty reference database')
    await reference.unsafe('SET LOCAL search_path TO agent_workflow, public')
    await executePostgresqlReferenceStatements(reference, [
      ...plan.head.map((s) => s.sql),
      ...compileMetaTables('postgresql', metaTables),
      ...targetSentinelStatements('postgresql'),
    ])
    const connection = postgresqlHistoryConnection(reference)
    const payload = {
      formatVersion: 1 as const,
      schemaEpoch: 2 as const,
      version: plan.version,
      planDigest: plan.digest,
      metaDigest: digestSchemaContract(metaTables),
      postgresqlMajor: await readPostgresqlMajor(connection),
      catalog: await collectPostgresqlHistoryCatalog(connection),
    }
    return { ...payload, digest: digestSchemaContract(payload) }
  } finally {
    await reference.unsafe('ROLLBACK')
  }
}
export class HistoryCatalogCache {
  private readonly entries = new Map<string, Promise<HistoryCatalog>>()
  constructor(
    private readonly loadPostgresql?: (
      plan: HistoryPlanArtifact,
      metaTables: readonly MetaTableDeclaration[],
      postgresqlMajor?: number,
    ) => Promise<PostgresqlCatalogArtifact>,
  ) {}
  expected(
    plan: HistoryPlanArtifact,
    metaTables: readonly MetaTableDeclaration[] = HISTORY_META_TABLES,
    postgresqlMajor?: number,
    storedArtifact?: PostgresqlCatalogArtifact,
  ): Promise<HistoryCatalog> {
    if (storedArtifact) {
      switch (plan.provider) {
        case 'sqlite':
          break
        case 'postgresql':
          verifyPostgresqlCatalogArtifact(storedArtifact, plan, metaTables, postgresqlMajor)
          return Promise.resolve(storedArtifact.catalog)
        default:
          return unhandledDatabaseProvider(plan.provider)
      }
    }
    const key = `${plan.provider}:${plan.digest}:${digestSchemaContract(metaTables)}:${postgresqlMajor ?? 0}`
    const cached = this.entries.get(key)
    if (cached) return cached
    const pending = this.compile(plan, metaTables, postgresqlMajor)
    this.entries.set(key, pending)
    if (this.entries.size > 8) this.entries.delete(this.entries.keys().next().value!)
    return pending.catch((error: unknown) => {
      this.entries.delete(key)
      throw error
    })
  }
  private async compile(
    plan: HistoryPlanArtifact,
    metaTables: readonly MetaTableDeclaration[],
    postgresqlMajor?: number,
  ): Promise<HistoryCatalog> {
    switch (plan.provider) {
      case 'postgresql': {
        if (!this.loadPostgresql)
          throw new SchemaHistoryError(
            'catalog-artifact-required',
            'load the per-version PostgreSQL catalog artifact',
          )
        const artifact = await this.loadPostgresql(plan, metaTables, postgresqlMajor)
        verifyPostgresqlCatalogArtifact(artifact, plan, metaTables, postgresqlMajor)
        return artifact.catalog
      }
      case 'sqlite': {
        const database = new Database(':memory:')
        try {
          for (const sql of [
            ...plan.head.map((s) => s.sql),
            ...compileMetaTables('sqlite', metaTables),
            ...targetSentinelStatements('sqlite'),
          ])
            database.exec(sql)
          return collectSqliteHistoryCatalog(database)
        } finally {
          database.close()
        }
      }
      default:
        return unhandledDatabaseProvider(plan.provider)
    }
  }
}
export function assertHistoryCatalog(expected: HistoryCatalog, actual: HistoryCatalog): void {
  if (canonicalSchemaJson(expected) !== canonicalSchemaJson(actual)) {
    const first =
      actual.find(
        (row) => !expected.some((other) => canonicalSchemaJson(row) === canonicalSchemaJson(other)),
      ) ??
      expected.find(
        (row) => !actual.some((other) => canonicalSchemaJson(row) === canonicalSchemaJson(other)),
      )
    throw new SchemaHistoryError(
      'physical-drift',
      first
        ? `${first.kind} ${first.relation}.${first.name}`
        : 'catalog differs from compiled head',
    )
  }
}
