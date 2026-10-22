// RFC-371 v2 §3/§5 — provider-neutral persistence of runtime calls. Every
// statistic is an indexed window scan + GROUP BY over these two tables; there
// is no projection, cache or trigger.

import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
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
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
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

// Built per query: schema columns are provider projections and must not be captured at load time.
function usageFields(db: object) {
  const { observationCalls } = tablesOf(db)
  return {
    calls: count(),
    incompleteCalls: tally(sql`${observationCalls.usageState} <> 'complete'`),
    failedCalls: tally(sql`${observationCalls.status} in ('failed', 'interrupted')`),
    input: total(observationCalls.inputTokens),
    cacheRead: total(observationCalls.cacheReadTokens),
    cacheWrite: total(observationCalls.cacheWriteTokens),
    output: total(observationCalls.outputTokens),
    reasoning: total(observationCalls.reasoningTokens),
    costNano: total(observationCalls.costNano),
    unpricedCalls: tally(sql`${observationCalls.costState} in ('unpriced', 'partial')`),
  }
}

function where(db: object, filter: CallFilter): SQL | undefined {
  const { observationCalls } = tablesOf(db)
  const scope =
    filter.scope.kind === 'all'
      ? undefined
      : filter.scope.kind === 'tasks'
        ? inArray(observationCalls.taskId, [...filter.scope.taskIds])
        : and(
            isNull(observationCalls.taskId),
            eq(observationCalls.ownerUserId, filter.scope.userId),
          )
  return and(
    filter.from === undefined ? undefined : gte(observationCalls.startedAt, filter.from),
    filter.to === undefined ? undefined : lt(observationCalls.startedAt, filter.to),
    scope,
    filter.purpose ? eq(observationCalls.purpose, filter.purpose) : undefined,
    filter.systemKind ? eq(observationCalls.systemKind, filter.systemKind) : undefined,
  )
}

function groupKey(db: object, group: CallGroup, dayOffsetMinutes: number): SQL | null {
  const { observationCalls } = tablesOf(db)
  switch (group) {
    case 'none':
      return null
    case 'purpose':
      return sql`${observationCalls.purpose}`
    case 'day': {
      // A validated integer offset, inlined so both engines see a plain integer expression.
      const offset = sql.raw(String(Math.trunc(dayOffsetMinutes) * 60_000))
      return sql`cast((${observationCalls.startedAt} + ${offset}) / ${sql.raw(String(DAY_MS))} as integer)`
    }
    case 'task':
      return sql`${observationCalls.taskId}`
    case 'agent':
      return sql`coalesce(${observationCalls.agentId}, '~' || ${observationCalls.agentName})`
    case 'kind':
      return sql`${observationCalls.systemKind}`
  }
}

type RawCall = PersistenceTables['observationCalls']['$inferSelect']
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
function modelRow(row: PersistenceTables['observationCallModels']['$inferSelect']): CallModelRow {
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

export function createCallPersistence(db: PersistenceDb): CallStore {
  /** Price-line key; calls recorded before built-in keys existed fall back to theirs. */
  const runtimeKey = () => {
    const { observationCalls } = tablesOf(db)
    return sql<string>`coalesce(${observationCalls.runtimeId}, 'builtin:' || ${observationCalls.protocol})`.mapWith(
      String,
    )
  }

  async function modelsOf(ids: readonly string[]): Promise<CallModelRow[]> {
    const rows: CallModelRow[] = []
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      const { observationCallModels } = tablesOf(db)
      const found = await db
        .select()
        .from(observationCallModels)
        .where(inArray(observationCallModels.callId, [...chunk]))
        .orderBy(asc(observationCallModels.callId), asc(observationCallModels.model))
      rows.push(...found.map(modelRow))
    }
    return rows
  }

  return {
    async insert(call, at) {
      const { observationCalls } = tablesOf(db)
      const accepted = await db
        .insert(observationCalls)
        .values({
          ...call,
          status: 'running',
          endedAt: null,
          usageState: 'pending',
          costState: 'none',
          updatedAt: at,
        })
        .onConflictDoUpdate({
          target: observationCalls.id,
          set: { status: 'running', endedAt: null, updatedAt: at },
          where: and(
            eq(observationCalls.purpose, call.purpose),
            call.taskId === null
              ? isNull(observationCalls.taskId)
              : eq(observationCalls.taskId, call.taskId),
            call.nodeRunId === null
              ? isNull(observationCalls.nodeRunId)
              : eq(observationCalls.nodeRunId, call.nodeRunId),
            eq(observationCalls.protocol, call.protocol),
            eq(observationCalls.agentName, call.agentName),
            call.ownerUserId === null
              ? isNull(observationCalls.ownerUserId)
              : eq(observationCalls.ownerUserId, call.ownerUserId),
            call.agentId === null
              ? isNull(observationCalls.agentId)
              : eq(observationCalls.agentId, call.agentId),
            call.runtimeId === null
              ? isNull(observationCalls.runtimeId)
              : eq(observationCalls.runtimeId, call.runtimeId),
            call.systemKind === null
              ? isNull(observationCalls.systemKind)
              : eq(observationCalls.systemKind, call.systemKind),
          ),
        })
        .returning({ id: observationCalls.id })
      if (accepted.length !== 1) throw new Error('observation-call-identity-mismatch')
    },

    async pricingContext(callId) {
      const { observationCalls } = tablesOf(db)
      const row = await first(
        db
          .select({ runtimeId: observationCalls.runtimeId, startedAt: observationCalls.startedAt })
          .from(observationCalls)
          .where(eq(observationCalls.id, callId)),
      )
      return row ? { runtimeId: row.runtimeId, startedAt: Number(row.startedAt) } : null
    },

    async writeUsage(callId, write) {
      await databaseSessionFor(db).transaction(async (tx) => {
        const { observationCalls, observationCallModels } = tablesOf(tx)
        const current = await first(
          tx
            .select({ status: observationCalls.status })
            .from(observationCalls)
            .where(eq(observationCalls.id, callId)),
        )
        if (current?.status !== 'running') return
        await tx.delete(observationCallModels).where(eq(observationCallModels.callId, callId))
        if (write.models.length)
          await tx.insert(observationCallModels).values(
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
          .update(observationCalls)
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
          .where(eq(observationCalls.id, callId))
      })
    },

    async end(callId, end, at) {
      const { observationCalls } = tablesOf(db)
      await db
        .update(observationCalls)
        .set({
          status: end.status,
          endedAt: end.endedAt,
          usageState: sql`case when ${observationCalls.usageState} = 'pending' then 'none' else ${observationCalls.usageState} end`,
          updatedAt: at,
        })
        .where(and(eq(observationCalls.id, callId), eq(observationCalls.status, 'running')))
    },

    async interruptRunning(bootAt, at) {
      const { observationCalls } = tablesOf(db)
      const stale = await db
        .select({ id: observationCalls.id })
        .from(observationCalls)
        .where(and(eq(observationCalls.status, 'running'), lt(observationCalls.startedAt, bootAt)))
      if (!stale.length) return 0
      for (let i = 0; i < stale.length; i += 500)
        await db
          .update(observationCalls)
          .set({
            status: 'interrupted',
            endedAt: sql`${observationCalls.updatedAt}`,
            usageState: sql`case when ${observationCalls.usageState} = 'pending' then 'none' else ${observationCalls.usageState} end`,
            updatedAt: at,
          })
          .where(
            and(
              inArray(
                observationCalls.id,
                stale.slice(i, i + 500).map((row) => row.id),
              ),
              eq(observationCalls.status, 'running'),
            ),
          )
      return stale.length
    },

    async windowTaskIds(from, to, limit) {
      const { observationCalls } = tablesOf(db)
      const rows = await db
        .selectDistinct({ taskId: observationCalls.taskId })
        .from(observationCalls)
        .where(
          and(
            gte(observationCalls.startedAt, from),
            lt(observationCalls.startedAt, to),
            sql`${observationCalls.taskId} is not null`,
          ),
        )
        .limit(limit)
      return rows.flatMap((row) => (row.taskId === null ? [] : [row.taskId]))
    },

    async aggregate(filter, group, dayOffsetMinutes = 0) {
      const key = groupKey(db, group, dayOffsetMinutes)
      const { observationCalls } = tablesOf(db)
      const fields = {
        ...usageFields(db),
        durationMs: total(
          sql`case when ${observationCalls.endedAt} is not null then ${observationCalls.endedAt} - ${observationCalls.startedAt} else 0 end`,
        ),
        tasks: sql<number>`count(distinct ${observationCalls.taskId})`.mapWith(Number),
        agents:
          sql<number>`count(distinct coalesce(${observationCalls.agentId}, '~' || ${observationCalls.agentName}))`.mapWith(
            Number,
          ),
        // Text aggregates carry an explicit decoder too (drizzle keeps NULL as null).
        label:
          group === 'kind'
            ? sql<string | null>`max(${observationCalls.systemLabel})`.mapWith(String)
            : sql<string | null>`max(${observationCalls.agentName})`.mapWith(String),
      }
      if (!key) {
        const row = await first(db.select(fields).from(observationCalls).where(where(db, filter)))
        return row && row.calls > 0 ? [{ ...row, key: null, label: null }] : []
      }
      const rows = await db
        .select({ ...fields, key: sql<string | number | null>`${key}` })
        .from(observationCalls)
        .where(where(db, filter))
        .groupBy(key)
      return rows.map(
        (row): CallAggregate => ({
          ...row,
          key: row.key === null ? null : String(row.key),
          label: group === 'agent' || group === 'kind' ? row.label : null,
        }),
      )
    },

    async aggregateModels(filter) {
      const { observationCallModels, observationCalls } = tablesOf(db)
      const tokens = sql`(${observationCallModels.inputTokens} + ${observationCallModels.cacheReadTokens} + ${observationCallModels.cacheWriteTokens} + ${observationCallModels.outputTokens})`
      const runtime = runtimeKey()
      const rows = await db
        .select({
          runtimeId: runtime,
          runtimeName: sql<string | null>`max(${observationCalls.runtimeName})`.mapWith(String),
          protocol: sql<string>`max(${observationCalls.protocol})`.mapWith(String),
          model: observationCallModels.model,
          calls: sql<number>`count(distinct ${observationCalls.id})`.mapWith(Number),
          incompleteCalls: tally(sql`${observationCalls.usageState} <> 'complete'`),
          failedCalls: tally(sql`${observationCalls.status} in ('failed', 'interrupted')`),
          input: total(observationCallModels.inputTokens),
          cacheRead: total(observationCallModels.cacheReadTokens),
          cacheWrite: total(observationCallModels.cacheWriteTokens),
          output: total(observationCallModels.outputTokens),
          reasoning: total(observationCallModels.reasoningTokens),
          costNano: total(sql`coalesce(${observationCallModels.costNano}, 0)`),
          unpricedCalls: tally(
            sql`${observationCallModels.costState} in ('unpriced', 'partial') and ${tokens} > 0`,
          ),
        })
        .from(observationCallModels)
        .innerJoin(observationCalls, eq(observationCalls.id, observationCallModels.callId))
        .where(where(db, filter))
        .groupBy(runtime, observationCallModels.model)
      return rows.map((row): ModelAggregate => ({ ...row, protocol: row.protocol ?? '' }))
    },

    async taskCalls(taskId, limit) {
      const { observationCalls } = tablesOf(db)
      const found = await db
        .select()
        .from(observationCalls)
        .where(eq(observationCalls.taskId, taskId))
        .orderBy(asc(observationCalls.startedAt), asc(observationCalls.id))
        .limit(limit + 1)
      const rows = found.slice(0, limit).map(callRow)
      return {
        calls: rows,
        models: await modelsOf(rows.map((row) => row.id)),
        truncated: found.length > limit,
      }
    },

    async recentCalls(filter, before, limit) {
      const { observationCalls } = tablesOf(db)
      const after = before
        ? or(
            lt(observationCalls.startedAt, before.startedAt),
            and(
              eq(observationCalls.startedAt, before.startedAt),
              lt(observationCalls.id, before.id),
            ),
          )
        : undefined
      const found = await db
        .select()
        .from(observationCalls)
        .where(and(where(db, filter), after))
        .orderBy(desc(observationCalls.startedAt), desc(observationCalls.id))
        .limit(limit)
      const rows = found.map(callRow)
      return { calls: rows, models: await modelsOf(rows.map((row) => row.id)) }
    },

    async runtimeModels() {
      const runtime = runtimeKey()
      const { observationCallModels, observationCalls } = tablesOf(db)
      const rows = await db
        .select({
          runtimeId: runtime,
          model: observationCallModels.model,
          calls: sql<number>`count(distinct ${observationCalls.id})`.mapWith(Number),
        })
        .from(observationCallModels)
        .innerJoin(observationCalls, eq(observationCalls.id, observationCallModels.callId))
        .where(sql`${observationCallModels.model} <> ''`)
        .groupBy(runtime, observationCallModels.model)
      return rows.map((row) => ({ runtimeId: row.runtimeId, model: row.model, calls: row.calls }))
    },
  }
}
