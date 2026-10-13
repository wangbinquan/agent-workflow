import { observationScopeRefs } from '@/db/observationStorage'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { jsonPathArray } from '@/platform/persistence/jsonPathArray'
import { CompleteObservationError } from '../domain/completeObservationError'
import { admitObservationStorage, observationViewAlive } from './observationStorageLifetime'
import { decodeQualifiedObservationGroup } from '../domain/qualifiedObservationIndexes'
import { decodeObservationRowCount } from '../domain/observationRowCount'
import {
  observationProjectionIndexedVersions,
  observationProjectionDescriptors,
  observationProjectionQueryScopes,
  observationProjectionQueryScopeMembers as scopeMembers,
} from '@/db/observationProjection'
import { decodeObservationWindowCell, completeWindowCell } from '../domain/observationWindowCell'
import { completeIncrementalObservationFold } from '../domain/incrementalObservationFold'
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
  const scopeCondition = (scope: string) =>
    sql`EXISTS(SELECT 1 FROM ${scopeMembers} m WHERE m.scope=${scope} AND ((m.kind='task' AND m.identity=${observationProjectionHistory.taskId}) OR (m.kind='component' AND m.identity=${observationProjectionHistory.component})))`
  const store = {
    snapshot,
    async *groupedDetails(input: {
      version: IncrementalObservationVersion
      section: string
      taskIds?: readonly string[]
      parent?: string | null
    }) {
      await qualify(input.version)
      if (!(await store.indexedDetails(input.version))) {
        yield* store.details(input)
        return
      }
      let after: string | undefined
      for (;;) {
        const rows = await db
          .select({
            key: observationProjectionHistory.key,
            document: observationProjectionHistory.document,
            descriptor: observationProjectionDescriptors.document,
          })
          .from(observationProjectionHistory)
          .innerJoin(
            observationProjectionDescriptors,
            eq(observationProjectionDescriptors.key, observationProjectionHistory.key),
          )
          .where(
            and(
              eq(observationProjectionHistory.kind, 'aggregate'),
              eq(observationProjectionHistory.section, 'qualified-group/' + input.section),
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
              visible(
                observationProjectionHistory.fromRevision,
                observationProjectionHistory.toRevision,
                input.version.revision,
              ),
              after ? gt(observationProjectionHistory.key, after) : undefined,
            ),
          )
          .orderBy(asc(observationProjectionHistory.key))
          .limit(200)
          .all()
        if (!rows.length) return
        for (const row of rows) {
          const [component, detail] = decodeQualifiedObservationGroup(row.descriptor),
            aggregate = JSON.parse(row.document) as IncrementalObservationFold,
            fold = {
              ...completeIncrementalObservationFold(aggregate),
              inventory: {
                tasks: aggregate.counters.tasks,
                attempts: aggregate.counters.attempts,
                numericRecords: aggregate.counters.numericRecords,
                nativeCaptures: aggregate.counters.nativeCaptures,
              },
            }
          if (
            Object.values(aggregate.counters).every((value) => value === '0') &&
            Object.keys(aggregate.gaps).length === 0
          )
            continue
          yield {
            key: row.key,
            component,
            aggregates: [],
            detail: { ...detail, key: row.key },
            fold,
          }
        }
        after = rows.at(-1)!.key
      }
    },

    async *metadataChanges(from: string, version: IncrementalObservationVersion) {
      await qualify(version)
      const greater = (column: SQLWrapper) =>
        or(
          sql`length(${column})>${from.length}`,
          and(sql`length(${column})=${from.length}`, sql`${column}>${from}`),
        )
      const keys = new Set<string>()
      let after: string | undefined
      for (;;) {
        const rows = await db
          .select({ key: observationProjectionHistory.key })
          .from(observationProjectionHistory)
          .where(
            and(
              eq(observationProjectionHistory.kind, 'contribution'),
              eq(observationProjectionHistory.section, 'tasks'),
              or(
                and(
                  greater(observationProjectionHistory.fromRevision),
                  visible(
                    observationProjectionHistory.fromRevision,
                    observationProjectionHistory.toRevision,
                    version.revision,
                  ),
                ),
                and(
                  greater(observationProjectionHistory.toRevision),
                  or(
                    sql`length(${observationProjectionHistory.toRevision})<${version.revision.length}`,
                    and(
                      sql`length(${observationProjectionHistory.toRevision})=${version.revision.length}`,
                      sql`${observationProjectionHistory.toRevision}<=${version.revision}`,
                    ),
                  ),
                ),
              ),
              after ? gt(observationProjectionHistory.key, after) : undefined,
            ),
          )
          .groupBy(observationProjectionHistory.key)
          .orderBy(asc(observationProjectionHistory.key))
          .limit(200)
          .all()
        if (!rows.length) break
        for (const row of rows) keys.add(row.key)
        after = rows.at(-1)!.key
      }
      for (let at = 0, all = [...keys]; at < all.length; at += 200) {
        const page = await db
            .select({
              key: observationProjectionHistory.key,
              document: observationProjectionHistory.document,
            })
            .from(observationProjectionHistory)
            .where(
              and(
                eq(observationProjectionHistory.kind, 'contribution'),
                inArray(observationProjectionHistory.key, all.slice(at, at + 200)),
                visible(
                  observationProjectionHistory.fromRevision,
                  observationProjectionHistory.toRevision,
                  version.revision,
                ),
              ),
            )
            .all(),
          found = new Map(
            page.map((row) => [
              row.key,
              JSON.parse(row.document) as QualifiedObservationContribution,
            ]),
          )
        for (const key of all.slice(at, at + 200)) yield { key, row: found.get(key) ?? null }
      }
    },
    async indexedDetails(version: IncrementalObservationVersion) {
      await qualify(version)
      return !!(await db
        .select()
        .from(observationProjectionIndexedVersions)
        .where(eq(observationProjectionIndexedVersions.revision, version.revision))
        .get())
    },
    async retainScope(
      id: string,
      taskIds: readonly string[],
      components: readonly string[],
      viewId?: string,
    ) {
      const ready = await databaseSessionFor(db).transaction(async (tx) => {
        await admitObservationStorage(tx)
        if (viewId) {
          if (!(await observationViewAlive(tx, viewId)))
            throw new CompleteObservationError('not-found', 'Original observation view expired')
          await tx
            .insert(observationScopeRefs)
            .values({ viewId, scope: id })
            .onConflictDoNothing()
            .run()
        }
        const current = await tx
          .select()
          .from(observationProjectionQueryScopes)
          .where(eq(observationProjectionQueryScopes.id, id))
          .get()
        if (current?.ready) return true
        await tx.insert(observationProjectionQueryScopes).values({ id }).onConflictDoNothing().run()
        return false
      })
      if (ready) return
      // The registered reference protects all packets; large scopes do not hold the global lifecycle lock.
      for (const kind of ['task', 'component'] as const) {
        const ids = kind === 'task' ? taskIds : components
        for (let at = 0; at < ids.length; at += 200)
          await db
            .insert(scopeMembers)
            .values(ids.slice(at, at + 200).map((identity) => ({ scope: id, kind, identity })))
            .onConflictDoNothing()
            .run()
      }
      await databaseSessionFor(db).transaction(async (tx) => {
        await admitObservationStorage(tx)
        if (viewId && !(await observationViewAlive(tx, viewId)))
          throw new CompleteObservationError('not-found', 'Original observation view expired')
        await tx
          .update(observationProjectionQueryScopes)
          .set({ ready: true })
          .where(eq(observationProjectionQueryScopes.id, id))
          .run()
      })
    },
    async *countGroups(scope: string, version: IncrementalObservationVersion) {
      await qualify(version)
      let after: string | undefined
      for (;;) {
        const rows = await db
          .select({
            key: observationProjectionHistory.key,
            document: observationProjectionHistory.document,
            descriptor: observationProjectionDescriptors.document,
          })
          .from(observationProjectionHistory)
          .innerJoin(
            observationProjectionDescriptors,
            eq(observationProjectionDescriptors.key, observationProjectionHistory.key),
          )
          .where(
            and(
              eq(observationProjectionHistory.kind, 'aggregate'),
              eq(observationProjectionHistory.section, 'row-count'),
              visible(
                observationProjectionHistory.fromRevision,
                observationProjectionHistory.toRevision,
                version.revision,
              ),
              scopeCondition(scope),
              after ? gt(observationProjectionHistory.key, after) : undefined,
            ),
          )
          .orderBy(asc(observationProjectionHistory.key))
          .limit(200)
          .all()
        if (!rows.length) return
        for (const row of rows) {
          const decoded = decodeObservationRowCount(row.descriptor),
            fold = JSON.parse(row.document) as IncrementalObservationFold
          if (fold.counters.numericRecords !== '0')
            yield {
              detail: {
                ...decoded.detail,
                key: row.key,
                document: decoded.detail.document ?? null,
              },
              component: decoded.owner,
              total: fold.counters.numericRecords,
            }
        }
        after = rows.at(-1)!.key
      }
    },
    async detailPacket(input: {
      version: IncrementalObservationVersion
      scope: string
      section: string
      parent: string | null
      after?: string
      limit: number
    }) {
      await qualify(input.version)
      const rows = await db
          .select({
            key: observationProjectionHistory.key,
            document: observationProjectionHistory.document,
          })
          .from(observationProjectionHistory)
          .where(
            and(
              eq(observationProjectionHistory.kind, 'contribution'),
              eq(observationProjectionHistory.section, input.section),
              input.parent === null
                ? isNull(observationProjectionHistory.parent)
                : eq(observationProjectionHistory.parent, input.parent),
              visible(
                observationProjectionHistory.fromRevision,
                observationProjectionHistory.toRevision,
                input.version.revision,
              ),
              scopeCondition(input.scope),
              input.after ? gt(observationProjectionHistory.key, input.after) : undefined,
            ),
          )
          .orderBy(asc(observationProjectionHistory.key))
          .limit(input.limit + 1)
          .all(),
        packet = rows.slice(0, input.limit)
      return {
        rows: packet.map((row) => JSON.parse(row.document) as QualifiedObservationContribution),
        next: rows.length > input.limit ? packet.at(-1)!.key : null,
      }
    },
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
      const scopes = jsonPathArray(db, observationProjectionHistory.document, ['detail', 'scopes'])
      const visibility = jsonPathArray(db, observationProjectionHistory.document, [
        'detail',
        'visibility',
      ])
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
          total:
            sql<string>`CAST(COUNT(DISTINCT ${observationProjectionHistory.originalKey}) AS TEXT)`.mapWith(
              String,
            ),
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
      readonly includeUnassigned?: boolean
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
                    input.includeUnassigned === false
                      ? sql`false`
                      : isNull(observationProjectionHistory.cohortAt),
                    gte(observationProjectionHistory.cohortAt, input.from),
                  ),
              input.to === undefined
                ? undefined
                : or(
                    input.includeUnassigned === false
                      ? sql`false`
                      : isNull(observationProjectionHistory.cohortAt),
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
  return {
    ...store,
    async *windowCells(input: {
      readonly version: IncrementalObservationVersion
      readonly taskIds: readonly string[]
      readonly components: readonly string[]
      readonly from: number
      readonly to: number
      readonly timezone: string
    }) {
      await qualify(input.version)
      if (!(await store.indexedDetails(input.version))) {
        for (const kind of ['task', 'standalone'] as const) {
          const ids = kind === 'task' ? input.taskIds : input.components
          for (let at = 0; at < ids.length; at += 200)
            for await (const row of store.details({
              version: input.version,
              section: 'time-partitions' as const,
              parent: null,
              ...(kind === 'task'
                ? { taskIds: ids.slice(at, at + 200) }
                : { components: ids.slice(at, at + 200), standalone: true }),
            }))
              yield row
        }
        return
      }
      const date = new Intl.DateTimeFormat('en-CA', {
          timeZone: input.timezone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }),
        edgeHours = new Set<number>()
      for (const kind of ['task', 'standalone'] as const) {
        const ids = kind === 'task' ? input.taskIds : input.components
        for (let offset = 0; offset < ids.length; offset += 200) {
          let after: string | undefined
          for (;;) {
            const page = await db
              .select({
                key: observationProjectionHistory.key,
                document: observationProjectionHistory.document,
                descriptor: observationProjectionDescriptors.document,
              })
              .from(observationProjectionHistory)
              .innerJoin(
                observationProjectionDescriptors,
                eq(observationProjectionDescriptors.key, observationProjectionHistory.key),
              )
              .where(
                and(
                  eq(observationProjectionHistory.kind, 'aggregate'),
                  eq(observationProjectionHistory.section, 'occurrence-cell'),
                  visible(
                    observationProjectionHistory.fromRevision,
                    observationProjectionHistory.toRevision,
                    input.version.revision,
                  ),
                  kind === 'task'
                    ? inArray(observationProjectionHistory.taskId, ids.slice(offset, offset + 200))
                    : and(
                        isNull(observationProjectionHistory.taskId),
                        inArray(
                          observationProjectionHistory.component,
                          ids.slice(offset, offset + 200),
                        ),
                      ),
                  after === undefined ? undefined : gt(observationProjectionHistory.key, after),
                ),
              )
              .orderBy(asc(observationProjectionHistory.key))
              .limit(200)
              .all()
            if (!page.length) break
            for (const row of page) {
              const cell = decodeObservationWindowCell(row.descriptor),
                crossWindow =
                  (cell.from < input.from && cell.to > input.from) ||
                  (cell.from < input.to && cell.to > input.to),
                crossDay =
                  cell.from >= input.from &&
                  cell.to <= input.to &&
                  date.format(cell.from) !== date.format(cell.to - 1)
              if (crossWindow || crossDay) {
                edgeHours.add(cell.from)
                continue
              }
              const fold = completeIncrementalObservationFold(
                JSON.parse(row.document) as IncrementalObservationFold,
              )
              if (fold.records === '0' && fold.gaps.length === 0) continue
              yield {
                key: row.key,
                component:
                  kind === 'task'
                    ? ''
                    : (JSON.parse(row.descriptor.slice(16)) as [null, string])[1],
                aggregates: [],
                fold,
                detail: {
                  section: 'time-partitions' as const,
                  parent: null,
                  key: row.key,
                  taskId: cell.original.task?.id ?? null,
                  cohortAt: cell.from,
                  document: completeWindowCell(cell, fold),
                  visibility: cell.original.visibility,
                  scopes: cell.original.scopes,
                  nativeRecord: cell.original.nativeRecord,
                },
              }
            }
            after = page.at(-1)!.key
          }
        }
      }
      // Cell interiors are already reduced. Read actual rows only for boundary
      // hours and unassigned clocks. Each boundary hour is read once per scope.
      for (const kind of ['task', 'standalone'] as const) {
        const ids = kind === 'task' ? input.taskIds : input.components
        for (let offset = 0; offset < ids.length; offset += 200) {
          const scope =
            kind === 'task'
              ? { taskIds: ids.slice(offset, offset + 200) }
              : { components: ids.slice(offset, offset + 200), standalone: true }
          for (const hour of edgeHours)
            for await (const row of store.details({
              version: input.version,
              section: 'time-partitions' as const,
              parent: null,
              ...scope,
              from: hour,
              to: hour + 3600000,
              includeUnassigned: false,
            }))
              yield row
          // With equal bounds only SQL NULL clocks pass the original half-open filter.
          for await (const row of store.details({
            version: input.version,
            section: 'time-partitions' as const,
            parent: null,
            ...scope,
            from: 0,
            to: 0,
          }))
            yield row
        }
      }
    },
  }
}
