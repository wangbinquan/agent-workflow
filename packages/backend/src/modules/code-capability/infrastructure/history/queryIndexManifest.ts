import { and, eq, inArray } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { sha256Hex } from '@/platform/contracts/hash'
import {
  CODE_HISTORY_TABLES,
  CodeHistoryReadError,
  type CodeHistorySource,
} from '../../domain/codeHistoryPackage'
import { CODE_HISTORY_QUERY_VERSION } from '../../domain/historyQueryProjection'

export async function readCodeHistoryManifest(
  db: Pick<PersistenceDb, 'select'>,
  source: CodeHistorySource,
) {
  const { codeHistoryArchives: archives } = tablesOf(db)
  const rows = await db
    .select({
      id: archives.id,
      formatVersion: archives.formatVersion,
      sourceGeneration: archives.sourceGeneration,
      sourceContract: archives.sourceContract,
      sourceTable: archives.sourceTable,
      rowCount: archives.rowCount,
      rootDigest: archives.rootDigest,
      contentRefJson: archives.contentRefJson,
    })
    .from(archives)
    .where(
      and(
        eq(archives.sourceGeneration, source.sourceGeneration),
        eq(archives.sourceContract, source.contract.digest),
        inArray(archives.sourceTable, [...CODE_HISTORY_TABLES]),
      ),
    )
  const ordered = CODE_HISTORY_TABLES.map((table) => {
    const matches = rows.filter((row) => row.sourceTable === table)
    if (matches.length !== 1)
      throw new CodeHistoryReadError(
        matches.length === 0 ? 'code-history-package-missing' : 'code-history-package-conflict',
        table,
      )
    return matches[0]!
  })
  const json = canonicalSchemaJson(ordered)
  return { archives: ordered, json, digest: sha256Hex(json) }
}

export function historyQueryStateWhere(
  db: Pick<PersistenceDb, 'select'>,
  source: CodeHistorySource,
) {
  const { codeHistoryQueryStates: state } = tablesOf(db)
  return and(
    eq(state.sourceGeneration, source.sourceGeneration),
    eq(state.sourceContract, source.contract.digest),
    eq(state.projectionVersion, CODE_HISTORY_QUERY_VERSION),
  )
}

/** Only bounded metadata is read here; content_inline_bytes is never selected. */
export async function requireCodeHistoryBuild(
  db: Pick<PersistenceDb, 'select'>,
  source: CodeHistorySource,
) {
  const manifest = await readCodeHistoryManifest(db, source)
  const { codeHistoryQueryStates: states, codeHistoryQueryBuilds: builds } = tablesOf(db)
  const [state] = await db.select().from(states).where(historyQueryStateWhere(db, source)).limit(1)
  if (state?.state !== 'ready' || state.activeBuildId === null)
    throw new CodeHistoryReadError(
      'code-history-query-index-not-ready',
      state?.failureCode ?? source.sourceGeneration,
    )
  const [build] = await db.select().from(builds).where(eq(builds.id, state.activeBuildId)).limit(1)
  if (
    build === undefined ||
    build.state !== 'ready' ||
    build.sourceGeneration !== source.sourceGeneration ||
    build.sourceContract !== source.contract.digest ||
    build.projectionVersion !== CODE_HISTORY_QUERY_VERSION ||
    build.manifestDigest !== manifest.digest ||
    build.archiveManifestJson !== manifest.json
  )
    throw new CodeHistoryReadError(
      'code-history-query-index-not-ready',
      'source manifest or projection changed',
    )
  return { buildId: build.id, manifest }
}
