import { CodeHostEventTypeSchema } from '@agent-workflow/shared'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'

import { webhookTriggers } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { matchTrigger } from '@/services/webhook/matching'
import { parseTriggerRow } from '@/services/webhook/webhookDispatch'
import type { CodeHostEventResponseDirectoryPort } from '../application/ports/codeHostEventResponse'
import {
  codeHostSelectorEvent,
  type CodeHostEventResponseDefinition,
  type CodeHostRoutingValue,
} from '../domain/codeHostWebhookEvent'

function selectorConfig(
  endpointId: string,
  trigger: ReturnType<typeof parseTriggerRow> & { ok: true },
): CodeHostRoutingValue {
  const rule = trigger.trigger.rule
  return {
    endpointId,
    repoScope: rule.repoScope as CodeHostRoutingValue,
    eventTypes: [...rule.eventTypes],
    branchFilter: rule.branchFilter ?? null,
    commandPrefix: rule.commandPrefix ?? null,
    ignoreUsernames: [...rule.ignoreUsernames],
  }
}

function definitionOf(row: typeof webhookTriggers.$inferSelect): CodeHostEventResponseDefinition {
  const parsed = parseTriggerRow(row)
  const eventTypes = (() => {
    try {
      return z.array(CodeHostEventTypeSchema).catch([]).parse(JSON.parse(row.eventTypes))
    } catch {
      return []
    }
  })()
  return {
    id: row.id,
    definitionRevision: String(row.updatedAt),
    endpointId: row.endpointId,
    eventTypes,
    displayName: { 'zh-CN': row.name, 'en-US': row.name },
    selector: parsed.ok
      ? { kind: 'code-host.webhook-rule', config: selectorConfig(row.endpointId, parsed) }
      : {
          kind: 'code-host.webhook-rule',
          config: { endpointId: row.endpointId, invalidReason: parsed.reason },
        },
    state: !row.enabled ? 'paused' : parsed.ok ? 'active' : 'invalid',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function createPostgresqlCodeHostEventResponseDirectory(
  db: PostgresqlDatabaseClient,
): CodeHostEventResponseDirectoryPort {
  return {
    async list() {
      const rows = await db.select().from(webhookTriggers).orderBy(asc(webhookTriggers.createdAt))
      return rows.map(definitionOf)
    },
    async matching(facts) {
      const event = codeHostSelectorEvent(facts)
      const rows = await db
        .select()
        .from(webhookTriggers)
        .where(
          and(eq(webhookTriggers.endpointId, facts.endpointId), eq(webhookTriggers.enabled, true)),
        )
      return rows.flatMap((row) => {
        const parsed = parseTriggerRow(row)
        return parsed.ok && matchTrigger(event, parsed.trigger.rule).hit ? [definitionOf(row)] : []
      })
    },
    async has(ruleId) {
      return (
        (await db
          .select({ id: webhookTriggers.id })
          .from(webhookTriggers)
          .where(eq(webhookTriggers.id, ruleId))
          .limit(1)
          .get()) !== undefined
      )
    },
  }
}
