// RFC-616 §9 / §10.2 — provider-neutral persistence of text-theme analyses.

import { and, asc, desc, eq, inArray, notInArray, sql } from 'drizzle-orm'
import type { ProcessSubjectKind } from '@agent-workflow/shared'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { first } from '@/platform/persistence/queryHelpers'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import {
  INSIGHT_KEEP,
  type InsightAnalysis,
  type InsightInput,
  type InsightResultDocument,
  type InsightScope,
  type InsightStore,
  type InsightSubject,
} from '../application/process/ports/insightStore'

type Row = PersistenceTables['observationInsightAnalyses']['$inferSelect']

function parse<T>(text: string | null): T | null {
  if (text === null) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

function analysis(row: Row): InsightAnalysis {
  return {
    id: row.id,
    subject: {
      kind: row.subjectKind,
      id: row.subjectId === '' ? null : row.subjectId,
      name: row.subjectName,
    },
    scope: row.scopeKind === 'all' ? { kind: 'all' } : { kind: 'user', userId: row.scopeUserId },
    windowFrom: Number(row.windowFrom),
    windowTo: Number(row.windowTo),
    trigger: row.triggerKind,
    requestedBy: row.requestedBy,
    status: row.status,
    input: parse<InsightInput>(row.inputJson),
    result: parse<InsightResultDocument>(row.resultJson),
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: Number(row.createdAt),
    startedAt: row.startedAt === null ? null : Number(row.startedAt),
    finishedAt: row.finishedAt === null ? null : Number(row.finishedAt),
  }
}

const scopeUser = (scope: InsightScope) => (scope.kind === 'all' ? '' : scope.userId)

export function createInsightPersistence(db: PersistenceDb): InsightStore {
  // Built per query: schema columns are provider projections and must not be captured at load time.
  const scoped = (handle: object, subject: InsightSubject, scope: InsightScope) => {
    const { observationInsightAnalyses } = tablesOf(handle)
    return and(
      eq(observationInsightAnalyses.subjectKind, subject.kind),
      eq(observationInsightAnalyses.subjectId, subject.id ?? ''),
      eq(observationInsightAnalyses.scopeKind, scope.kind),
      eq(observationInsightAnalyses.scopeUserId, scopeUser(scope)),
    )
  }

  async function newestDone(subject: InsightSubject, scope: InsightScope) {
    const { observationInsightAnalyses } = tablesOf(db)
    return await first(
      db
        .select()
        .from(observationInsightAnalyses)
        .where(and(scoped(db, subject, scope), eq(observationInsightAnalyses.status, 'done')))
        .orderBy(desc(observationInsightAnalyses.createdAt), desc(observationInsightAnalyses.id))
        .limit(1),
    )
  }

  return {
    async active(subject, scope) {
      const { observationInsightAnalyses } = tablesOf(db)
      const row = await first(
        db
          .select()
          .from(observationInsightAnalyses)
          .where(
            and(
              scoped(db, subject, scope),
              inArray(observationInsightAnalyses.status, ['pending', 'running']),
            ),
          )
          .orderBy(desc(observationInsightAnalyses.createdAt))
          .limit(1),
      )
      return row ? analysis(row) : null
    },

    async recent(subject, scope, limit) {
      const { observationInsightAnalyses } = tablesOf(db)
      const rows = await db
        .select()
        .from(observationInsightAnalyses)
        .where(scoped(db, subject, scope))
        .orderBy(desc(observationInsightAnalyses.createdAt), desc(observationInsightAnalyses.id))
        .limit(limit)
      return rows.map(analysis)
    },

    async lastDone(subject, scope) {
      const row = await newestDone(subject, scope)
      return row ? analysis(row) : null
    },

    async insert(entry) {
      const { observationInsightAnalyses } = tablesOf(db)
      await db.insert(observationInsightAnalyses).values({
        id: entry.id,
        subjectKind: entry.subject.kind,
        subjectId: entry.subject.id ?? '',
        subjectName: entry.subject.name,
        scopeKind: entry.scope.kind,
        scopeUserId: scopeUser(entry.scope),
        windowFrom: entry.windowFrom,
        windowTo: entry.windowTo,
        triggerKind: entry.trigger,
        requestedBy: entry.requestedBy,
        status: 'pending',
        inputJson: null,
        resultJson: null,
        errorCode: null,
        errorMessage: null,
        createdAt: entry.createdAt,
        startedAt: null,
        finishedAt: null,
      })
    },

    async claimNext(at) {
      return databaseSessionFor(db).transaction(async (tx) => {
        const { observationInsightAnalyses } = tablesOf(tx)
        const next = await first(
          tx
            .select()
            .from(observationInsightAnalyses)
            .where(eq(observationInsightAnalyses.status, 'pending'))
            .orderBy(asc(observationInsightAnalyses.createdAt), asc(observationInsightAnalyses.id))
            .limit(1),
        )
        if (!next) return null
        // The status condition makes the claim a compare-and-set: a second claimer updates nothing.
        const claimed = await tx
          .update(observationInsightAnalyses)
          .set({ status: 'running', startedAt: at })
          .where(
            and(
              eq(observationInsightAnalyses.id, next.id),
              eq(observationInsightAnalyses.status, 'pending'),
            ),
          )
          .returning({ id: observationInsightAnalyses.id })
        return claimed.length === 1 ? analysis({ ...next, status: 'running', startedAt: at }) : null
      })
    },

    async finish(id, outcome, at) {
      const { observationInsightAnalyses } = tablesOf(db)
      await db
        .update(observationInsightAnalyses)
        .set(
          outcome.status === 'done'
            ? {
                status: 'done',
                inputJson: JSON.stringify(outcome.input),
                resultJson: JSON.stringify(outcome.result),
                errorCode: null,
                errorMessage: null,
                finishedAt: at,
              }
            : {
                status: 'failed',
                inputJson: outcome.input === null ? null : JSON.stringify(outcome.input),
                errorCode: outcome.errorCode,
                errorMessage: outcome.errorMessage.slice(0, 2_000),
                finishedAt: at,
              },
        )
        .where(
          and(
            eq(observationInsightAnalyses.id, id),
            eq(observationInsightAnalyses.status, 'running'),
          ),
        )
    },

    async failRunning(errorCode, errorMessage, at) {
      const { observationInsightAnalyses } = tablesOf(db)
      const rows = await db
        .update(observationInsightAnalyses)
        .set({ status: 'failed', errorCode, errorMessage, finishedAt: at })
        .where(eq(observationInsightAnalyses.status, 'running'))
        .returning({ id: observationInsightAnalyses.id })
      return rows.length
    },

    async prune(subject, scope) {
      const { observationInsightAnalyses } = tablesOf(db)
      const keep = await db
        .select({ id: observationInsightAnalyses.id })
        .from(observationInsightAnalyses)
        .where(scoped(db, subject, scope))
        .orderBy(desc(observationInsightAnalyses.createdAt), desc(observationInsightAnalyses.id))
        .limit(INSIGHT_KEEP)
      if (keep.length < INSIGHT_KEEP) return
      const lastDone = await newestDone(subject, scope)
      const kept = new Set(keep.map((row) => row.id))
      if (lastDone) kept.add(lastDone.id)
      await db.delete(observationInsightAnalyses).where(
        and(
          scoped(db, subject, scope),
          notInArray(observationInsightAnalyses.id, [...kept]),
          // Never delete a job that is queued or running.
          inArray(observationInsightAnalyses.status, ['done', 'failed']),
        ),
      )
    },

    async lastScheduled(kind: ProcessSubjectKind) {
      const { observationInsightAnalyses } = tablesOf(db)
      const rows = await db
        .select({
          subjectId: observationInsightAnalyses.subjectId,
          at: sql<number>`max(${observationInsightAnalyses.createdAt})`.mapWith(Number),
        })
        .from(observationInsightAnalyses)
        .where(
          and(
            eq(observationInsightAnalyses.subjectKind, kind),
            eq(observationInsightAnalyses.scopeKind, 'all'),
          ),
        )
        .groupBy(observationInsightAnalyses.subjectId)
      return new Map(rows.map((row) => [row.subjectId, row.at]))
    },
  }
}
