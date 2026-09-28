import { and, asc, eq, gt, inArray } from 'drizzle-orm'
import { ObservationMeasurementSchema } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { sha256Hex } from '@/util/hash'
import {
  observationUsageCurrent,
  observationUsageNativeRecords,
  observationUsageEvents,
  observationUsageSources,
} from '@/db/schema'
import {
  databaseSessionFor,
  engineOf,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import type { UsageLedgerRecord } from '../domain/usageLedger'
import type { UsageLedgerScope, UsageLedgerStore } from '../ports/usageLedger'
import {
  commitUsageCapture,
  readUsageCapture,
  readUsageCaptures,
  readPendingCaptureRepairs,
} from './usageCapturePersistence'

const key = (...parts: readonly string[]) => sha256Hex(JSON.stringify(parts))
const decode = (document: string): UsageLedgerRecord => JSON.parse(document) as UsageLedgerRecord

function scope(tx: DatabaseTransaction, sourceId: string): UsageLedgerScope {
  const recordKey = (invocationId: string, recordId: string) =>
    key(sourceId, invocationId, recordId)
  return {
    capture: (invocationId) => readUsageCapture(tx, invocationId),
    commitCapture: (value, cursor, resolutions) =>
      commitUsageCapture(tx, sourceId, cursor, value, resolutions),
    lockNativeRoot: async (nativeSource, root) => {
      const id = 'native-root:' + key(nativeSource, root)
      await tx.insert(observationUsageSources).values({ sourceId: id }).onConflictDoNothing().run()
      await engineOf(tx).lockAggregateRoot(
        tx,
        observationUsageSources,
        observationUsageSources.sourceId,
        id,
      )
    },
    nativeRecords: async (nativeSource, root, recordIds) => {
      if (recordIds.length > 400) throw new RangeError('Native record lookup exceeds batch budget')
      if (!recordIds.length) return { items: [], truncated: false }
      const rows = await tx
        .select({ document: observationUsageCurrent.document })
        .from(observationUsageCurrent)
        .innerJoin(
          observationUsageNativeRecords,
          eq(observationUsageCurrent.id, observationUsageNativeRecords.id),
        )
        .where(
          and(
            eq(observationUsageNativeRecords.nativeSource, nativeSource),
            eq(observationUsageNativeRecords.nativeRoot, root),
            inArray(observationUsageNativeRecords.recordId, [...recordIds]),
          ),
        )
        .limit(801)
        .all()
      return {
        items: rows.slice(0, 800).map((row) => decode(row.document)),
        truncated: rows.length > 800,
      }
    },
    nativeScope: async (otherSource) => {
      await tx
        .insert(observationUsageSources)
        .values({ sourceId: otherSource })
        .onConflictDoNothing()
        .run()
      await engineOf(tx).lockAggregateRoot(
        tx,
        observationUsageSources,
        observationUsageSources.sourceId,
        otherSource,
      )
      return scope(tx, otherSource)
    },
    cursor: async () =>
      (
        await tx
          .select({ cursor: observationUsageSources.cursor })
          .from(observationUsageSources)
          .where(eq(observationUsageSources.sourceId, sourceId))
          .get()
      )?.cursor ?? null,
    event: async (eventId) =>
      (
        await tx
          .select({ fingerprint: observationUsageEvents.fingerprint })
          .from(observationUsageEvents)
          .where(eq(observationUsageEvents.id, key(sourceId, eventId)))
          .get()
      )?.fingerprint,
    revisions: async (invocationId, recordId, afterRevision, limit) => {
      const rows = await tx
        .select({ document: observationUsageEvents.document })
        .from(observationUsageEvents)
        .where(
          and(
            eq(observationUsageEvents.recordKey, recordKey(invocationId, recordId)),
            gt(observationUsageEvents.revision, afterRevision),
          ),
        )
        .orderBy(asc(observationUsageEvents.revision))
        .limit(limit)
        .all()
      return rows.map((row) => ObservationMeasurementSchema.parse(JSON.parse(row.document)))
    },
    revision: async (invocationId, recordId, revision) =>
      (
        await tx
          .select({ fingerprint: observationUsageEvents.fingerprint })
          .from(observationUsageEvents)
          .where(
            and(
              eq(observationUsageEvents.recordKey, recordKey(invocationId, recordId)),
              eq(observationUsageEvents.revision, revision),
            ),
          )
          .get()
      )?.fingerprint,
    current: async (invocationId, recordId) => {
      const row = await tx
        .select({ document: observationUsageCurrent.document })
        .from(observationUsageCurrent)
        .where(eq(observationUsageCurrent.id, recordKey(invocationId, recordId)))
        .get()
      return row ? decode(row.document) : undefined
    },
    append: async (event, receipt, record, nativeSource) => {
      const id = recordKey(event.measurement.invocationId, event.measurement.recordId)
      await tx
        .insert(observationUsageEvents)
        .values({
          id: key(sourceId, event.eventId),
          sourceId,
          eventId: event.eventId,
          recordKey: id,
          revision: event.measurement.revision,
          fingerprint: receipt.fingerprint,
          outcome: receipt.outcome,
          document: JSON.stringify(event.measurement),
        })
        .run()
      if (record) {
        const row = {
          id,
          taskId: record.measurement.taskId,
          sourceId,
          document: JSON.stringify(record),
        }
        await tx
          .insert(observationUsageCurrent)
          .values(row)
          .onConflictDoUpdate({ target: observationUsageCurrent.id, set: row })
          .run()
        if (nativeSource !== undefined && record.measurement.scope) {
          const binding = {
            id,
            nativeSource,
            nativeRoot: record.measurement.scope.root,
            recordId: record.measurement.recordId,
          }
          await tx
            .insert(observationUsageNativeRecords)
            .values(binding)
            .onConflictDoUpdate({ target: observationUsageNativeRecords.id, set: binding })
            .run()
        }
      }
    },
    advance: async (cursor) => {
      await tx
        .update(observationUsageSources)
        .set({ cursor })
        .where(eq(observationUsageSources.sourceId, sourceId))
        .run()
    },
  }
}

export function createUsageLedgerStore(db: ProviderNeutralDatabase): UsageLedgerStore {
  return {
    captures: (ids) => readUsageCaptures(db, ids),
    pendingCaptureRepairs: (limit, after) => readPendingCaptureRepairs(db, limit, after),
    cursor: async (sourceId) =>
      (
        await db
          .select({ cursor: observationUsageSources.cursor })
          .from(observationUsageSources)
          .where(eq(observationUsageSources.sourceId, sourceId))
          .get()
      )?.cursor ?? null,
    change: (sourceId, work) =>
      databaseSessionFor(db).transaction(async (tx) => {
        await tx.insert(observationUsageSources).values({ sourceId }).onConflictDoNothing().run()
        await engineOf(tx).lockAggregateRoot(
          tx,
          observationUsageSources,
          observationUsageSources.sourceId,
          sourceId,
        )
        return work(scope(tx, sourceId))
      }),
    records: async (taskId, page) => {
      if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 500)
        throw new RangeError('Usage page size must be 1 through 500')
      const rows = await db
        .select({ id: observationUsageCurrent.id, document: observationUsageCurrent.document })
        .from(observationUsageCurrent)
        .where(
          and(
            eq(observationUsageCurrent.taskId, taskId),
            page.after === undefined ? undefined : gt(observationUsageCurrent.id, page.after),
          ),
        )
        .orderBy(asc(observationUsageCurrent.id))
        .limit(page.limit + 1)
        .all()
      const selected = rows.slice(0, page.limit)
      return {
        items: selected.map((row) => decode(row.document)),
        ...(rows.length > page.limit ? { nextCursor: selected.at(-1)!.id } : {}),
      }
    },
  }
}
