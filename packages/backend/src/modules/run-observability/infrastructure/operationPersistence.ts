// RFC-616 §5.4 / §10.1 — provider-neutral persistence of recorded human operations.

import { and, desc, eq, inArray } from 'drizzle-orm'
import type { ProcessOperationAction, ProcessOperationSubjectKind } from '@agent-workflow/shared'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { first } from '@/platform/persistence/queryHelpers'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { OperationStore } from '../application/process/ports/operationStore'

const MAX_IDS = 500

export function createOperationPersistence(db: PersistenceDb): OperationStore {
  return {
    async latest(key) {
      const { observationOperations } = tablesOf(db)
      const row = await first(
        db
          .select({ id: observationOperations.id, lastAt: observationOperations.lastAt })
          .from(observationOperations)
          .where(
            and(
              eq(observationOperations.actorUserId, key.actorUserId),
              eq(observationOperations.action, key.action),
              eq(observationOperations.subjectKind, key.subjectKind),
              eq(observationOperations.subjectId, key.subjectId),
            ),
          )
          .orderBy(desc(observationOperations.lastAt), desc(observationOperations.id))
          .limit(1),
      )
      return row ? { id: row.id, lastAt: Number(row.lastAt) } : null
    },

    async insert(operation) {
      const { observationOperations } = tablesOf(db)
      await db.insert(observationOperations).values({
        id: operation.id,
        action: operation.action,
        subjectKind: operation.subjectKind,
        subjectId: operation.subjectId,
        actorUserId: operation.actorUserId,
        transport: operation.transport,
        firstAt: operation.at,
        lastAt: operation.at,
      })
    },

    async touch(id, lastAt) {
      const { observationOperations } = tablesOf(db)
      await db.update(observationOperations).set({ lastAt }).where(eq(observationOperations.id, id))
    },

    async bySubjects(subjectKind, subjectIds, actions) {
      if (subjectIds.length > MAX_IDS) throw new RangeError('subject id batch exceeds 500')
      const ids = [...new Set(subjectIds)]
      if (!ids.length || actions?.length === 0) return []
      const { observationOperations } = tablesOf(db)
      const rows = await db
        .select()
        .from(observationOperations)
        .where(
          and(
            eq(observationOperations.subjectKind, subjectKind),
            inArray(observationOperations.subjectId, ids),
            actions ? inArray(observationOperations.action, [...actions]) : undefined,
          ),
        )
      return rows.map((row) => ({
        // `action` is stored as text so a new action needs no schema change; rows are only ever
        // written from the closed set, and readers filter by the actions they know.
        action: row.action as ProcessOperationAction,
        subjectKind: row.subjectKind as ProcessOperationSubjectKind,
        subjectId: row.subjectId,
        actorUserId: row.actorUserId,
        firstAt: Number(row.firstAt),
        lastAt: Number(row.lastAt),
      }))
    },
  }
}
