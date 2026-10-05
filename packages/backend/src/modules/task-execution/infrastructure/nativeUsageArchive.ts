import { and, asc, eq, gt, inArray, or } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  nativeUsagePreparations,
  nativeUsageStoreBindings,
  nativeUsagePasses,
  nativeUsagePassHeads,
  nativeUsagePassPages,
  nativeUsageSessionParents,
  nativeUsageStepMembers,
  nativeUsageEmissions,
  nativeUsageRevisionHeads,
} from '@/db/schema'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import { SQL_IN_CHUNK } from '@/util/sqlChunk'

type Reader = ProviderNeutralDatabase | DatabaseTransaction
type Cursor = readonly [string, string]
const PAGE_ROWS = 500

interface NativeArchiveTable {
  readonly name: string
  batches(db: Reader, taskIds: readonly string[]): AsyncIterable<readonly unknown[]>
}
function spec<Row>(
  name: string,
  read: (
    db: Reader,
    ids: readonly string[],
    after: Cursor | null,
  ) => PromiseLike<readonly Row[]> | readonly Row[],
  key: (row: Row) => Cursor,
): NativeArchiveTable {
  return {
    name,
    async *batches(db, taskIds) {
      for (let start = 0; start < taskIds.length; start += SQL_IN_CHUNK) {
        const ids = taskIds.slice(start, start + SQL_IN_CHUNK)
        let after: Cursor | null = null
        for (;;) {
          const rows = await read(db, ids, after)
          if (!rows.length) break
          const next = key(rows[rows.length - 1]!)
          if (JSON.stringify(next) === JSON.stringify(after))
            throw new Error('Original native archive cursor did not advance')
          yield rows
          after = next
        }
      }
    },
  }
}
function afterKey(column: AnySQLiteColumn, cursor: Cursor | null) {
  return cursor === null ? undefined : gt(column, cursor[0])
}
function afterPair(first: AnySQLiteColumn, second: AnySQLiteColumn, cursor: Cursor | null) {
  return cursor === null
    ? undefined
    : or(gt(first, cursor[0]), and(eq(first, cursor[0]), gt(second, cursor[1])))
}
const invocations = (db: Reader, ids: readonly string[]) =>
  db
    .select({ id: nativeUsagePreparations.invocationId })
    .from(nativeUsagePreparations)
    .where(inArray(nativeUsagePreparations.taskId, [...ids]))
const passes = (db: Reader, ids: readonly string[]) =>
  db
    .select({ id: nativeUsagePasses.passId })
    .from(nativeUsagePasses)
    .where(inArray(nativeUsagePasses.invocationId, invocations(db, ids)))

/** All original evidence relations, streamed through their real primary keys to EOF. */
export const NATIVE_USAGE_ARCHIVE: readonly NativeArchiveTable[] = [
  spec(
    'task_execution_native_usage_preparations',
    (db, ids, after) =>
      db
        .select()
        .from(nativeUsagePreparations)
        .where(
          and(
            inArray(nativeUsagePreparations.taskId, [...ids]),
            afterKey(nativeUsagePreparations.invocationId, after),
          ),
        )
        .orderBy(asc(nativeUsagePreparations.invocationId))
        .limit(PAGE_ROWS)
        .all(),
    (row) => [row.invocationId, ''],
  ),
  spec(
    'task_execution_native_usage_store_bindings',
    (db, ids, after) =>
      db
        .select()
        .from(nativeUsageStoreBindings)
        .where(
          and(
            inArray(nativeUsageStoreBindings.invocationId, invocations(db, ids)),
            afterKey(nativeUsageStoreBindings.invocationId, after),
          ),
        )
        .orderBy(asc(nativeUsageStoreBindings.invocationId))
        .limit(PAGE_ROWS)
        .all(),
    (row) => [row.invocationId, ''],
  ),
  spec(
    'task_execution_native_usage_passes',
    (db, ids, after) =>
      db
        .select()
        .from(nativeUsagePasses)
        .where(
          and(
            inArray(nativeUsagePasses.invocationId, invocations(db, ids)),
            afterKey(nativeUsagePasses.passId, after),
          ),
        )
        .orderBy(asc(nativeUsagePasses.passId))
        .limit(PAGE_ROWS)
        .all(),
    (row) => [row.passId, ''],
  ),
  spec(
    'task_execution_native_usage_pass_heads',
    (db, ids, after) =>
      db
        .select()
        .from(nativeUsagePassHeads)
        .where(
          and(
            inArray(nativeUsagePassHeads.passId, passes(db, ids)),
            afterKey(nativeUsagePassHeads.key, after),
          ),
        )
        .orderBy(asc(nativeUsagePassHeads.key))
        .limit(PAGE_ROWS)
        .all(),
    (row) => [row.key, ''],
  ),
  spec(
    'task_execution_native_usage_pass_pages',
    (db, ids, after) =>
      db
        .select()
        .from(nativeUsagePassPages)
        .where(
          and(
            inArray(nativeUsagePassPages.passId, passes(db, ids)),
            afterPair(nativeUsagePassPages.passId, nativeUsagePassPages.ordinal, after),
          ),
        )
        .orderBy(asc(nativeUsagePassPages.passId), asc(nativeUsagePassPages.ordinal))
        .limit(PAGE_ROWS)
        .all(),
    (row) => [row.passId, row.ordinal],
  ),
  spec(
    'task_execution_native_usage_session_parents',
    (db, ids, after) =>
      db
        .select()
        .from(nativeUsageSessionParents)
        .where(
          and(
            inArray(nativeUsageSessionParents.passId, passes(db, ids)),
            afterPair(nativeUsageSessionParents.passId, nativeUsageSessionParents.sessionId, after),
          ),
        )
        .orderBy(asc(nativeUsageSessionParents.passId), asc(nativeUsageSessionParents.sessionId))
        .limit(PAGE_ROWS)
        .all(),
    (row) => [row.passId, row.sessionId],
  ),
  spec(
    'task_execution_native_usage_step_members',
    (db, ids, after) =>
      db
        .select()
        .from(nativeUsageStepMembers)
        .where(
          and(
            inArray(nativeUsageStepMembers.passId, passes(db, ids)),
            afterPair(nativeUsageStepMembers.passId, nativeUsageStepMembers.stepId, after),
          ),
        )
        .orderBy(asc(nativeUsageStepMembers.passId), asc(nativeUsageStepMembers.stepId))
        .limit(PAGE_ROWS)
        .all(),
    (row) => [row.passId, row.stepId],
  ),
  spec(
    'task_execution_native_usage_emissions',
    (db, ids, after) =>
      db
        .select()
        .from(nativeUsageEmissions)
        .where(
          and(
            inArray(nativeUsageEmissions.invocationId, invocations(db, ids)),
            afterPair(nativeUsageEmissions.invocationId, nativeUsageEmissions.eventId, after),
          ),
        )
        .orderBy(asc(nativeUsageEmissions.invocationId), asc(nativeUsageEmissions.eventId))
        .limit(PAGE_ROWS)
        .all(),
    (row) => [row.invocationId, row.eventId],
  ),
  spec(
    'task_execution_native_usage_revision_heads',
    (db, ids, after) =>
      db
        .select()
        .from(nativeUsageRevisionHeads)
        .where(
          and(
            inArray(nativeUsageRevisionHeads.invocationId, invocations(db, ids)),
            afterPair(
              nativeUsageRevisionHeads.invocationId,
              nativeUsageRevisionHeads.recordId,
              after,
            ),
          ),
        )
        .orderBy(asc(nativeUsageRevisionHeads.invocationId), asc(nativeUsageRevisionHeads.recordId))
        .limit(PAGE_ROWS)
        .all(),
    (row) => [row.invocationId, row.recordId],
  ),
]
