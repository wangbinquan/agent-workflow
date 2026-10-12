import { and, asc, eq, gt, gte, lt, inArray, isNull, or, sql, type SQLWrapper } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  observationProjectionHeads,
  observationProjectionHistory,
  observationProjectionMemberships,
  observationProjectionVersions,
} from '@/db/observationProjection'
import type { IncrementalObservationFold } from '../domain/incrementalObservationFold'
import type {
  IncrementalObservationContribution,
  IncrementalObservationVersion,
} from '../ports/incrementalObservationProjection'
import type { QualifiedObservationContribution } from '../ports/incrementalObservationQualified'
import { engineOf } from '@/platform/persistence/databaseTransaction'

/** Revisions are arbitrary precision decimal strings. Compare length then digits;
 * neither provider may silently coerce them to floating point or 64-bit numbers. */
function visible(from: SQLWrapper, to: SQLWrapper, revision: string) {
  if (!/^(0|[1-9][0-9]*)$/.test(revision))
    throw new Error('Invalid observation projection revision')
  const lower = or(
    sql`length(${from}) < ${revision.length}`,
    and(sql`length(${from}) = ${revision.length}`, sql`${from} <= ${revision}`),
  )
  const upper = or(
    isNull(to),
    sql`length(${to}) > ${revision.length}`,
    and(sql`length(${to}) = ${revision.length}`, sql`${to} > ${revision}`),
  )
  return and(lower, upper)
}
export function createIncrementalObservationQueryStore(db: ProviderNeutralDatabase) {
  async function snapshot(revision?: string): Promise<IncrementalObservationVersion | null> {
    if (revision === undefined) {
      const head = await db
        .select({
          revision: observationProjectionHeads.revision,
          asOf: observationProjectionHeads.asOf,
        })
        .from(observationProjectionHeads)
        .where(eq(observationProjectionHeads.id, 'incremental-20261012-v1'))
        .get()
      return head?.revision === '0' ? null : (head ?? null)
    }
    return (
      (await db
        .select({
          revision: observationProjectionVersions.revision,
          asOf: observationProjectionVersions.asOf,
        })
        .from(observationProjectionVersions)
        .where(eq(observationProjectionVersions.revision, revision))
        .get()) ?? null
    )
  }
  async function qualify(version: IncrementalObservationVersion) {
    const original = await snapshot(version.revision)
    if (!original || original.asOf !== version.asOf)
      throw new Error('Observation projection snapshot is unavailable')
  }
  return {
    snapshot,
    async bootstrapComplete(version: IncrementalObservationVersion) {
      await qualify(version)
      return (
        (
          await db
            .select({ complete: observationProjectionVersions.bootstrapComplete })
            .from(observationProjectionVersions)
            .where(eq(observationProjectionVersions.revision, version.revision))
            .get()
        )?.complete === true
      )
    },
    async aggregates(keys: readonly string[], version: IncrementalObservationVersion) {
      await qualify(version)
      const found = new Map<string, IncrementalObservationFold>()
      for (let at = 0; at < keys.length; at += 200) {
        const rows = await db
          .select({
            key: observationProjectionHistory.key,
            document: observationProjectionHistory.document,
          })
          .from(observationProjectionHistory)
          .where(
            and(
              eq(observationProjectionHistory.kind, 'aggregate'),
              inArray(observationProjectionHistory.key, keys.slice(at, at + 200)),
              visible(
                observationProjectionHistory.fromRevision,
                observationProjectionHistory.toRevision,
                version.revision,
              ),
            ),
          )
          .all()
        for (const row of rows) {
          if (found.has(row.key)) throw new Error('Observation projection intervals overlap')
          found.set(row.key, JSON.parse(row.document) as IncrementalObservationFold)
        }
      }
      return found
    },
    async *days(input: {
      readonly version: IncrementalObservationVersion
      readonly taskIds: readonly string[]
      readonly components: readonly string[]
      readonly from: number
      readonly to: number
    }) {
      await qualify(input.version)
      const fullFrom = Math.ceil(input.from / 86400000) * 86400000,
        fullTo = Math.floor(input.to / 86400000) * 86400000
      if (fullFrom >= fullTo) return
      for (const kind of ['task', 'standalone'] as const) {
        const ids = kind === 'task' ? input.taskIds : input.components
        for (let at = 0; at < ids.length; at += 200) {
          let after: string | undefined
          for (;;) {
            const page = await db
              .select({
                key: observationProjectionHistory.key,
                document: observationProjectionHistory.document,
              })
              .from(observationProjectionHistory)
              .where(
                and(
                  eq(observationProjectionHistory.kind, 'aggregate'),
                  eq(observationProjectionHistory.section, 'occurrence-day'),
                  visible(
                    observationProjectionHistory.fromRevision,
                    observationProjectionHistory.toRevision,
                    input.version.revision,
                  ),
                  gte(observationProjectionHistory.cohortAt, fullFrom),
                  lt(observationProjectionHistory.cohortAt, fullTo),
                  kind === 'task'
                    ? inArray(observationProjectionHistory.taskId, ids.slice(at, at + 200))
                    : and(
                        isNull(observationProjectionHistory.taskId),
                        inArray(observationProjectionHistory.component, ids.slice(at, at + 200)),
                      ),
                  after === undefined ? undefined : gt(observationProjectionHistory.key, after),
                ),
              )
              .orderBy(asc(observationProjectionHistory.key))
              .limit(200)
              .all()
            if (!page.length) break
            for (const row of page) yield JSON.parse(row.document) as IncrementalObservationFold
            after = page.at(-1)!.key
          }
        }
      }
    },
    async *identities(input: {
      readonly version: IncrementalObservationVersion
      readonly taskIds?: readonly string[]
      readonly components?: readonly string[]
    }) {
      await qualify(input.version)
      const scopes =
        engineOf(db).provider === 'sqlite'
          ? sql<
              string | null
            >`json_extract(${observationProjectionHistory.document}, '$.detail.scopes')`
          : sql<
              string | null
            >`${observationProjectionHistory.document}::jsonb #>> '{detail,scopes}'`
      const visibility =
        engineOf(db).provider === 'sqlite'
          ? sql<
              string | null
            >`json_extract(${observationProjectionHistory.document}, '$.detail.visibility')`
          : sql<
              string | null
            >`${observationProjectionHistory.document}::jsonb #>> '{detail,visibility}'`
      let after: string | undefined
      for (;;) {
        const page = await db
          .select({
            id: observationProjectionHistory.key,
            section: observationProjectionHistory.section,
            key: observationProjectionHistory.originalKey,
            component: observationProjectionHistory.component,
            taskId: observationProjectionHistory.taskId,
            cohortAt: observationProjectionHistory.cohortAt,
            scopes,
            visibility,
          })
          .from(observationProjectionHistory)
          .where(
            and(
              eq(observationProjectionHistory.kind, 'contribution'),
              isNull(observationProjectionHistory.parent),
              visible(
                observationProjectionHistory.fromRevision,
                observationProjectionHistory.toRevision,
                input.version.revision,
              ),
              input.taskIds === undefined
                ? undefined
                : input.taskIds.length
                  ? inArray(observationProjectionHistory.taskId, [...input.taskIds])
                  : sql`false`,
              input.components === undefined
                ? undefined
                : input.components.length
                  ? inArray(observationProjectionHistory.component, [...input.components])
                  : sql`false`,
              after === undefined ? undefined : gt(observationProjectionHistory.key, after),
            ),
          )
          .orderBy(asc(observationProjectionHistory.key))
          .limit(200)
          .all()
        if (!page.length) return
        for (const row of page)
          if (row.section !== null && row.key !== null && row.component !== null)
            yield {
              section: row.section,
              key: row.key,
              component: row.component,
              detail: {
                section: row.section as QualifiedObservationContribution['detail']['section'],
                key: row.key,
                parent: null,
                taskId: row.taskId,
                cohortAt: row.cohortAt,
                document: null,
                ...(row.scopes
                  ? {
                      scopes: JSON.parse(row.scopes) as NonNullable<
                        QualifiedObservationContribution['detail']['scopes']
                      >,
                    }
                  : {}),
                ...(row.visibility
                  ? {
                      visibility: JSON.parse(row.visibility) as NonNullable<
                        QualifiedObservationContribution['detail']['visibility']
                      >,
                    }
                  : {}),
              },
            }
        after = page.at(-1)!.id
      }
    },
    async counts(input: {
      readonly version: IncrementalObservationVersion
      readonly taskIds?: readonly string[]
      readonly standaloneComponents?: readonly string[]
      readonly from?: number
      readonly to?: number
    }) {
      await qualify(input.version)
      const rows = await db
        .select({
          section: observationProjectionHistory.section,
          total: sql<string>`CAST(COUNT(DISTINCT ${observationProjectionHistory.originalKey}) AS TEXT)`,
        })
        .from(observationProjectionHistory)
        .where(
          and(
            eq(observationProjectionHistory.kind, 'contribution'),
            isNull(observationProjectionHistory.parent),
            visible(
              observationProjectionHistory.fromRevision,
              observationProjectionHistory.toRevision,
              input.version.revision,
            ),
            input.taskIds === undefined
              ? undefined
              : input.taskIds.length
                ? inArray(observationProjectionHistory.taskId, [...input.taskIds])
                : sql`false`,
            input.standaloneComponents === undefined
              ? undefined
              : and(
                  isNull(observationProjectionHistory.taskId),
                  input.standaloneComponents.length
                    ? inArray(observationProjectionHistory.component, [
                        ...input.standaloneComponents,
                      ])
                    : sql`false`,
                ),
            input.from === undefined
              ? undefined
              : or(
                  isNull(observationProjectionHistory.cohortAt),
                  gte(observationProjectionHistory.cohortAt, input.from),
                ),
            input.to === undefined
              ? undefined
              : or(
                  isNull(observationProjectionHistory.cohortAt),
                  lt(observationProjectionHistory.cohortAt, input.to),
                ),
          ),
        )
        .groupBy(observationProjectionHistory.section)
        .all()
      return rows
        .filter((row) => row.section !== null)
        .map((row) => ({ section: row.section!, total: String(row.total) }))
    },
    async *details(input: {
      readonly version: IncrementalObservationVersion
      readonly section: string
      readonly parent?: string | null
      readonly taskIds?: readonly string[]
      readonly components?: readonly string[]
      readonly standalone?: boolean
      readonly from?: number
      readonly to?: number
    }) {
      await qualify(input.version)
      let after: string | undefined
      for (;;) {
        const page = await db
          .select({
            key: observationProjectionHistory.key,
            document: observationProjectionHistory.document,
          })
          .from(observationProjectionHistory)
          .where(
            and(
              eq(observationProjectionHistory.kind, 'contribution'),
              eq(observationProjectionHistory.section, input.section),
              visible(
                observationProjectionHistory.fromRevision,
                observationProjectionHistory.toRevision,
                input.version.revision,
              ),
              input.parent === undefined
                ? undefined
                : input.parent === null
                  ? isNull(observationProjectionHistory.parent)
                  : eq(observationProjectionHistory.parent, input.parent),
              input.taskIds === undefined
                ? undefined
                : input.taskIds.length
                  ? inArray(observationProjectionHistory.taskId, [...input.taskIds])
                  : sql`false`,
              input.components === undefined
                ? undefined
                : input.components.length
                  ? inArray(observationProjectionHistory.component, [...input.components])
                  : sql`false`,
              input.standalone ? isNull(observationProjectionHistory.taskId) : undefined,
              input.from === undefined
                ? undefined
                : or(
                    isNull(observationProjectionHistory.cohortAt),
                    gte(observationProjectionHistory.cohortAt, input.from),
                  ),
              input.to === undefined
                ? undefined
                : or(
                    isNull(observationProjectionHistory.cohortAt),
                    lt(observationProjectionHistory.cohortAt, input.to),
                  ),
              after === undefined ? undefined : gt(observationProjectionHistory.key, after),
            ),
          )
          .orderBy(asc(observationProjectionHistory.key))
          .limit(200)
          .all()
        if (!page.length) return
        for (const row of page) yield JSON.parse(row.document) as QualifiedObservationContribution
        after = page.at(-1)!.key
      }
    },
    async aggregate(
      key: string,
      version: IncrementalObservationVersion,
    ): Promise<IncrementalObservationFold | null> {
      await qualify(version)
      const rows = await db
        .select({ document: observationProjectionHistory.document })
        .from(observationProjectionHistory)
        .where(
          and(
            eq(observationProjectionHistory.kind, 'aggregate'),
            eq(observationProjectionHistory.key, key),
            visible(
              observationProjectionHistory.fromRevision,
              observationProjectionHistory.toRevision,
              version.revision,
            ),
          ),
        )
        .all()
      if (rows.length > 1) throw new Error('Observation projection intervals overlap')
      return rows[0] ? (JSON.parse(rows[0].document) as IncrementalObservationFold) : null
    },
    async page(input: {
      readonly aggregate: string
      readonly version: IncrementalObservationVersion
      readonly after?: string
      readonly packetSize: number
    }) {
      await qualify(input.version)
      if (!Number.isSafeInteger(input.packetSize) || input.packetSize < 1)
        throw new RangeError('Invalid projection transfer packet')
      const rows = await db
        .select({
          key: observationProjectionHistory.key,
          document: observationProjectionHistory.document,
        })
        .from(observationProjectionHistory)
        .innerJoin(
          observationProjectionMemberships,
          and(
            eq(observationProjectionMemberships.key, observationProjectionHistory.key),
            eq(
              observationProjectionMemberships.fromRevision,
              observationProjectionHistory.fromRevision,
            ),
          ),
        )
        .where(
          and(
            eq(observationProjectionHistory.kind, 'contribution'),
            eq(observationProjectionMemberships.aggregate, input.aggregate),
            visible(
              observationProjectionHistory.fromRevision,
              observationProjectionHistory.toRevision,
              input.version.revision,
            ),
            visible(
              observationProjectionMemberships.fromRevision,
              observationProjectionMemberships.toRevision,
              input.version.revision,
            ),
            input.after === undefined
              ? undefined
              : gt(observationProjectionHistory.key, input.after),
          ),
        )
        .orderBy(asc(observationProjectionHistory.key))
        .limit(input.packetSize)
        .all()
      return {
        rows: rows.map((row) => JSON.parse(row.document) as IncrementalObservationContribution),
        // A full packet requires the next actual read; equality never claims EOF.
        next: rows.length === input.packetSize ? rows.at(-1)!.key : null,
      }
    },
  }
}
