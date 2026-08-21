import { and, desc, eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { eventResponseRules } from '@/db/schema'
import type { EventResponseRuleStorePort } from '../application/ports/responseRuleStore'
import {
  eventResponseRuleDraftSchema,
  eventResponseTargetSchema,
  type EventResponseRuleRecord,
} from '../domain/responseRule'

function recordOf(row: typeof eventResponseRules.$inferSelect): EventResponseRuleRecord {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    name: row.name,
    enabled: row.enabled,
    sourceRef: { id: row.sourceId, revision: row.sourceRevision },
    eventTypeRef: { id: row.eventTypeId, revision: row.eventTypeRevision },
    subjectTypeId: row.subjectType,
    subjectMatch: row.subjectMatch,
    subjectPattern: row.subjectPattern,
    target: eventResponseTargetSchema.parse(JSON.parse(row.targetJson) as unknown),
    lastFiredAt: row.lastFiredAt,
    lastStatus: row.lastStatus,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function matchesSubject(rule: EventResponseRuleRecord, subjectRef: string): boolean {
  if (rule.subjectMatch === 'all') return true
  if (rule.subjectPattern === null) return false
  return rule.subjectMatch === 'exact'
    ? subjectRef === rule.subjectPattern
    : subjectRef.startsWith(rule.subjectPattern)
}

export function createSqliteEventResponseRuleStore(db: DbClient): EventResponseRuleStorePort {
  const get = (id: string): EventResponseRuleRecord | null => {
    const row = db.select().from(eventResponseRules).where(eq(eventResponseRules.id, id)).get()
    return row === undefined ? null : recordOf(row)
  }
  return {
    list() {
      return db
        .select()
        .from(eventResponseRules)
        .orderBy(desc(eventResponseRules.updatedAt), desc(eventResponseRules.id))
        .all()
        .map(recordOf)
    },
    get,
    matching(observation) {
      return db
        .select()
        .from(eventResponseRules)
        .where(
          and(
            eq(eventResponseRules.enabled, true),
            eq(eventResponseRules.sourceId, observation.sourceRef.id),
            eq(eventResponseRules.sourceRevision, observation.sourceRef.revision),
            eq(eventResponseRules.eventTypeId, observation.eventTypeRef.id),
            eq(eventResponseRules.eventTypeRevision, observation.eventTypeRef.revision),
            eq(eventResponseRules.subjectType, observation.subject.typeId),
          ),
        )
        .all()
        .map(recordOf)
        .filter((rule) => matchesSubject(rule, observation.subject.subjectRef))
    },
    create(input) {
      const draft = eventResponseRuleDraftSchema.parse(input.draft)
      db.insert(eventResponseRules)
        .values({
          id: input.id,
          name: draft.name,
          ownerUserId: input.ownerUserId,
          enabled: draft.enabled,
          sourceId: input.sourceRef.id,
          sourceRevision: input.sourceRef.revision,
          eventTypeId: draft.eventTypeRef.id,
          eventTypeRevision: draft.eventTypeRef.revision,
          subjectType: input.subjectTypeId,
          subjectMatch: draft.subjectMatch,
          subjectPattern: draft.subjectPattern,
          targetJson: JSON.stringify(draft.target),
          createdAt: input.now,
          updatedAt: input.now,
        })
        .run()
      return get(input.id)!
    },
    update(input) {
      const current = get(input.id)
      if (current === null) return null
      const draft = eventResponseRuleDraftSchema.parse(input.draft)
      // updatedAt is also the immutable routing-definition revision. Two edits
      // may occur in the same wall-clock millisecond, so make it monotonic per
      // rule instead of letting an old queued delivery execute a new target.
      const definitionRevision = Math.max(input.now, current.updatedAt + 1)
      db.update(eventResponseRules)
        .set({
          name: draft.name,
          enabled: draft.enabled,
          sourceId: input.sourceRef.id,
          sourceRevision: input.sourceRef.revision,
          eventTypeId: draft.eventTypeRef.id,
          eventTypeRevision: draft.eventTypeRef.revision,
          subjectType: input.subjectTypeId,
          subjectMatch: draft.subjectMatch,
          subjectPattern: draft.subjectPattern,
          targetJson: JSON.stringify(draft.target),
          updatedAt: definitionRevision,
        })
        .where(eq(eventResponseRules.id, input.id))
        .run()
      return get(input.id)
    },
    remove(id) {
      if (get(id) === null) return false
      db.delete(eventResponseRules).where(eq(eventResponseRules.id, id)).run()
      return true
    },
    recordResult(input) {
      db.update(eventResponseRules)
        .set({
          lastFiredAt: input.now,
          lastStatus: input.state,
          lastError: input.error,
        })
        .where(eq(eventResponseRules.id, input.id))
        .run()
    },
  }
}
