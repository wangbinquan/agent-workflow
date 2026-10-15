// RFC-371 v2 §3/§5 — provider-neutral persistence of runtime calls. Every
// statistic is an indexed window scan + GROUP BY over these two tables; there
// is no projection, cache or trigger.

import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { observationCallModels as models, observationCalls as calls } from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type {
  CallAggregate,
  CallFilter,
  CallGroup,
  CallModelRow,
  CallRow,
  CallStore,
  ModelAggregate,
} from '../application/ports/callStore'

const DAY_MS = 86_400_000

const total = (column: SQL | AnyColumn) => sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number)
const tally = (condition: SQL) =>
  sql<number>`coalesce(sum(case when ${condition} then 1 else 0 end), 0)`.mapWith(Number)
/** Price-line key; calls recorded before built-in keys existed fall back to theirs. */
const runtimeKey = () =>
  sql<string>`coalesce(${calls.runtimeId}, 'builtin:' || ${calls.protocol})`.mapWith(String)

// Built per query: schema columns are provider projections and must not be captured at load time.
function usageFields() {
  return {
    calls: count(),
    incompleteCalls: tally(sql`${calls.usageState} <> 'complete'`),
    failedCalls: tally(sql`${calls.status} in ('failed', 'interrupted')`),
    input: total(calls.inputTokens),
    cacheRead: total(calls.cacheReadTokens),
    cacheWrite: total(calls.cacheWriteTokens),
    output: total(calls.outputTokens),
    reasoning: total(calls.reasoningTokens),
    costNano: total(calls.costNano),
    unpricedCalls: tally(sql`${calls.costState} in ('unpriced', 'partial')`),
  }
}

function where(filter: CallFilter): SQL | undefined {
  const scope =
    filter.scope.kind === 'all'
      ? undefined
      : filter.scope.kind === 'tasks'
        ? inArray(calls.taskId, [...filter.scope.taskIds])
        : and(isNull(calls.taskId), eq(calls.ownerUserId, filter.scope.userId))
  return and(
    filter.from === undefined ? undefined : gte(calls.startedAt, filter.from),
    filter.to === undefined ? undefined : lt(calls.startedAt, filter.to),
    scope,
    filter.purpose ? eq(calls.purpose, filter.purpose) : undefined,
    filter.systemKind ? eq(calls.systemKind, filter.systemKind) : undefined,
  )
}

function groupKey(group: CallGroup, dayOffsetMinutes: number): SQL | null {
  switch (group) {
    case 'none':
      return null
    case 'purpose':
      return sql`${calls.purpose}`
    case 'day': {
      // A validated integer offset, inlined so both engines see a plain integer expression.
      const offset = sql.raw(String(Math.trunc(dayOffsetMinutes) * 60_000))
      return sql`cast((${calls.startedAt} + ${offset}) / ${sql.raw(String(DAY_MS))} as integer)`
    }
    case 'task':
      return sql`${calls.taskId}`
    case 'agent':
      return sql`coalesce(${calls.agentId}, '~' || ${calls.agentName})`
    case 'kind':
      return sql`${calls.systemKind}`
  }
}

type RawCall = typeof calls.$inferSelect
function callRow(row: RawCall): CallRow {
  return {
    id: row.id,
    purpose: row.purpose,
    taskId: row.taskId,
    nodeRunId: row.nodeRunId,
    systemKind: row.systemKind,
    systemLabel: row.systemLabel,
    ownerUserId: row.ownerUserId,
    agentId: row.agentId,
    agentName: row.agentName,
    runtimeId: row.runtimeId,
    runtimeName: row.runtimeName,
    protocol: row.protocol,
    startedAt: Number(row.startedAt),
    endedAt: row.endedAt === null ? null : Number(row.endedAt),
    status: row.status,
    usageState: row.usageState,
    input: Number(row.inputTokens),
    cacheRead: Number(row.cacheReadTokens),
    cacheWrite: Number(row.cacheWriteTokens),
    output: Number(row.outputTokens),
    reasoning: Number(row.reasoningTokens),
    costNano: Number(row.costNano),
    costState: row.costState,
  }
}
function modelRow(row: typeof models.$inferSelect): CallModelRow {
  return {
    callId: row.callId,
    model: row.model,
    input: Number(row.inputTokens),
    cacheRead: Number(row.cacheReadTokens),
    cacheWrite: Number(row.cacheWriteTokens),
    output: Number(row.outputTokens),
    reasoning: Number(row.reasoningTokens),
    costNano: row.costNano === null ? null : Number(row.costNano),
    costState: row.costState,
  }
}

export function createCallPersistence(db: ProviderNeutralDatabase): CallStore {
  async function modelsOf(ids: readonly string[]): Promise<CallModelRow[]> {
    const rows: CallModelRow[] = []
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      const found = await db
        .select()
        .from(models)
        .where(inArray(models.callId, [...chunk]))
        .orderBy(asc(models.callId), asc(models.model))
        .all()
      rows.push(...found.map(modelRow))
    }
    return rows
  }

  return {
    async insert(call, at) {
      await db.insert(calls).values({
        ...call,
        status: 'running',
        endedAt: null,
        usageState: 'pending',
        costState: 'none',
        updatedAt: at,
      })
    },

    async pricingContext(callId) {
      const row = await db
        .select({ runtimeId: calls.runtimeId, startedAt: calls.startedAt })
        .from(calls)
        .where(eq(calls.id, callId))
        .get()
      return row ? { runtimeId: row.runtimeId, startedAt: Number(row.startedAt) } : null
    },

    async writeUsage(callId, write) {
      await databaseSessionFor(db).transaction(async (tx) => {
        const current = await tx
          .select({ status: calls.status })
          .from(calls)
          .where(eq(calls.id, callId))
          .get()
        if (current?.status !== 'running') return
        await tx.delete(models).where(eq(models.callId, callId))
        if (write.models.length)
          await tx.insert(models).values(
            write.models.map((row) => ({
              callId,
              model: row.model,
              inputTokens: row.input,
              cacheReadTokens: row.cacheRead,
              cacheWriteTokens: row.cacheWrite,
              outputTokens: row.output,
              reasoningTokens: row.reasoning,
              priceId: row.priceId,
              costNano: row.costNano,
              costState: row.costState,
            })),
          )
        await tx
          .update(calls)
          .set({
            usageState: write.usageState,
            inputTokens: write.totals.input,
            cacheReadTokens: write.totals.cacheRead,
            cacheWriteTokens: write.totals.cacheWrite,
            outputTokens: write.totals.output,
            reasoningTokens: write.totals.reasoning,
            costNano: write.costNano,
            costState: write.costState,
            updatedAt: write.updatedAt,
            ...(write.end ? { status: write.end.status, endedAt: write.end.endedAt } : {}),
          })
          .where(eq(calls.id, callId))
      })
    },

    async end(callId, end, at) {
      await db
        .update(calls)
        .set({
          status: end.status,
          endedAt: end.endedAt,
          usageState: sql`case when ${calls.usageState} = 'pending' then 'none' else ${calls.usageState} end`,
          updatedAt: at,
        })
        .where(and(eq(calls.id, callId), eq(calls.status, 'running')))
    },

    async interruptRunning(bootAt, at) {
      const stale = await db
        .select({ id: calls.id })
        .from(calls)
        .where(and(eq(calls.status, 'running'), lt(calls.startedAt, bootAt)))
        .all()
      if (!stale.length) return 0
      for (let i = 0; i < stale.length; i += 500)
        await db
          .update(calls)
          .set({
            status: 'interrupted',
            endedAt: sql`${calls.updatedAt}`,
            usageState: sql`case when ${calls.usageState} = 'pending' then 'none' else ${calls.usageState} end`,
            updatedAt: at,
          })
          .where(
            and(
              inArray(
                calls.id,
                stale.slice(i, i + 500).map((row) => row.id),
              ),
              eq(calls.status, 'running'),
            ),
          )
      return stale.length
    },

    async windowTaskIds(from, to, limit) {
      const rows = await db
        .selectDistinct({ taskId: calls.taskId })
        .from(calls)
        .where(
          and(
            gte(calls.startedAt, from),
            lt(calls.startedAt, to),
            sql`${calls.taskId} is not null`,
          ),
        )
        .limit(limit)
        .all()
      return rows.flatMap((row) => (row.taskId === null ? [] : [row.taskId]))
    },

    async aggregate(filter, group, dayOffsetMinutes = 0) {
      const key = groupKey(group, dayOffsetMinutes)
      const fields = {
        ...usageFields(),
        durationMs: total(
          sql`case when ${calls.endedAt} is not null then ${calls.endedAt} - ${calls.startedAt} else 0 end`,
        ),
        tasks: sql<number>`count(distinct ${calls.taskId})`.mapWith(Number),
        agents:
          sql<number>`count(distinct coalesce(${calls.agentId}, '~' || ${calls.agentName}))`.mapWith(
            Number,
          ),
        // Text aggregates carry an explicit decoder too (drizzle keeps NULL as null).
        label:
          group === 'kind'
            ? sql<string | null>`max(${calls.systemLabel})`.mapWith(String)
            : sql<string | null>`max(${calls.agentName})`.mapWith(String),
      }
      if (!key) {
        const row = await db.select(fields).from(calls).where(where(filter)).get()
        return row && row.calls > 0 ? [{ ...row, key: null, label: null }] : []
      }
      const rows = await db
        .select({ ...fields, key: sql<string | number | null>`${key}` })
        .from(calls)
        .where(where(filter))
        .groupBy(key)
        .all()
      return rows.map(
        (row): CallAggregate => ({
          ...row,
          key: row.key === null ? null : String(row.key),
          label: group === 'agent' || group === 'kind' ? row.label : null,
        }),
      )
    },

    async aggregateModels(filter) {
      const tokens = sql`(${models.inputTokens} + ${models.cacheReadTokens} + ${models.cacheWriteTokens} + ${models.outputTokens})`
      const runtime = runtimeKey()
      const rows = await db
        .select({
          runtimeId: runtime,
          runtimeName: sql<string | null>`max(${calls.runtimeName})`.mapWith(String),
          protocol: sql<string>`max(${calls.protocol})`.mapWith(String),
          model: models.model,
          calls: sql<number>`count(distinct ${calls.id})`.mapWith(Number),
          incompleteCalls: tally(sql`${calls.usageState} <> 'complete'`),
          failedCalls: tally(sql`${calls.status} in ('failed', 'interrupted')`),
          input: total(models.inputTokens),
          cacheRead: total(models.cacheReadTokens),
          cacheWrite: total(models.cacheWriteTokens),
          output: total(models.outputTokens),
          reasoning: total(models.reasoningTokens),
          costNano: total(sql`coalesce(${models.costNano}, 0)`),
          unpricedCalls: tally(
            sql`${models.costState} in ('unpriced', 'partial') and ${tokens} > 0`,
          ),
        })
        .from(models)
        .innerJoin(calls, eq(calls.id, models.callId))
        .where(where(filter))
        .groupBy(runtime, models.model)
        .all()
      return rows.map((row): ModelAggregate => ({ ...row, protocol: row.protocol ?? '' }))
    },

    async taskCalls(taskId, limit) {
      const found = await db
        .select()
        .from(calls)
        .where(eq(calls.taskId, taskId))
        .orderBy(asc(calls.startedAt), asc(calls.id))
        .limit(limit + 1)
        .all()
      const rows = found.slice(0, limit).map(callRow)
      return {
        calls: rows,
        models: await modelsOf(rows.map((row) => row.id)),
        truncated: found.length > limit,
      }
    },

    async recentCalls(filter, before, limit) {
      const after = before
        ? or(
            lt(calls.startedAt, before.startedAt),
            and(eq(calls.startedAt, before.startedAt), lt(calls.id, before.id)),
          )
        : undefined
      const found = await db
        .select()
        .from(calls)
        .where(and(where(filter), after))
        .orderBy(desc(calls.startedAt), desc(calls.id))
        .limit(limit)
        .all()
      const rows = found.map(callRow)
      return { calls: rows, models: await modelsOf(rows.map((row) => row.id)) }
    },

    async runtimeModels() {
      const runtime = runtimeKey()
      const rows = await db
        .select({
          runtimeId: runtime,
          model: models.model,
          calls: sql<number>`count(distinct ${calls.id})`.mapWith(Number),
        })
        .from(models)
        .innerJoin(calls, eq(calls.id, models.callId))
        .where(sql`${models.model} <> ''`)
        .groupBy(runtime, models.model)
        .all()
      return rows.map((row) => ({ runtimeId: row.runtimeId, model: row.model, calls: row.calls }))
    },
  }
}
