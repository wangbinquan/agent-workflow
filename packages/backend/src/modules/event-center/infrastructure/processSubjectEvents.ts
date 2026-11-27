// RFC-616 §3.2 / §6.3 — the event history of subjects, offered to process metrics through the platform contract.
//
// The stored document is handed out verbatim: what an event says belongs to the module that published it, which
// reads its own routing facts back out of it.

import { and, asc, eq, inArray } from 'drizzle-orm'

import { PROCESS_FACT_ID_BATCH, type ProcessSubjectEvents } from '@/platform/contracts/processFacts'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'

export function createProcessSubjectEvents(db: PersistenceDb): ProcessSubjectEvents {
  return {
    async history(subjectType, subjectRefs) {
      if (subjectRefs.length > PROCESS_FACT_ID_BATCH)
        throw new RangeError(`subject batch exceeds ${PROCESS_FACT_ID_BATCH}`)
      const refs = [...new Set(subjectRefs)]
      if (refs.length === 0) return []
      const { eventRecords } = tablesOf(db)
      // Served by idx_event_records_subject (subject_type, subject_ref, occurred_at).
      const rows = await db
        .select({
          subjectRef: eventRecords.subjectRef,
          occurredAt: eventRecords.occurredAt,
          eventTypeId: eventRecords.eventTypeId,
          summaryJson: eventRecords.summaryJson,
        })
        .from(eventRecords)
        .where(
          and(eq(eventRecords.subjectType, subjectType), inArray(eventRecords.subjectRef, refs)),
        )
        .orderBy(asc(eventRecords.subjectRef), asc(eventRecords.occurredAt), asc(eventRecords.id))
      return rows.map((row) => ({
        subjectRef: row.subjectRef,
        occurredAt: Number(row.occurredAt),
        eventTypeId: row.eventTypeId,
        summaryJson: row.summaryJson,
      }))
    },
  }
}
