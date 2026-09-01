import { and, desc, eq } from 'drizzle-orm'

import { eventResponseRules } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
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

export function createPostgresqlEventResponseRuleStore(
  db: PostgresqlDatabaseClient,
): EventResponseRuleStorePort {
  const get = async (id: string): Promise<EventResponseRuleRecord | null> => {
    const row = await db
      .select()
      .from(eventResponseRules)
      .where(eq(eventResponseRules.id, id))
      .get()
    return row === undefined ? null : recordOf(row)
  }
  return {
    async list() {
      const rows = await db
        .select()
        .from(eventResponseRules)
        .orderBy(desc(eventResponseRules.updatedAt), desc(eventResponseRules.id))
      return rows.map(recordOf)
    },
    get,
    async matching(observation) {
      const rows = await db
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
      return rows
        .map(recordOf)
        .filter((rule) => matchesSubject(rule, observation.subject.subjectRef))
    },
    async create(input) {
      const draft = eventResponseRuleDraftSchema.parse(input.draft)
      await db.insert(eventResponseRules).values({
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
      return (await get(input.id))!
    },
    async update(input) {
      const current = await get(input.id)
      if (current === null) return null
      const draft = eventResponseRuleDraftSchema.parse(input.draft)
      const definitionRevision = Math.max(input.now, current.updatedAt + 1)
      await db
        .update(eventResponseRules)
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
      return await get(input.id)
    },
    async remove(id) {
      if ((await get(id)) === null) return false
      await db.delete(eventResponseRules).where(eq(eventResponseRules.id, id))
      return true
    },
    async recordResult(input) {
      await db
        .update(eventResponseRules)
        .set({ lastFiredAt: input.now, lastStatus: input.state, lastError: input.error })
        .where(eq(eventResponseRules.id, input.id))
    },
  }
}
