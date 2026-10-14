// RFC-371 v2 §5 — statistics computed on demand. Consumption is selected by
// call start time, task statistics by task start time; both are labelled in
// the UI. Non-administrators only aggregate tasks the task owner confirms are
// visible to them, plus their own task-less system calls.

import type {
  ObservationAgentPage,
  ObservationAgentRow,
  ObservationCall,
  ObservationModelPage,
  ObservationOverview,
  ObservationSystemPage,
  ObservationSystemQuery,
  ObservationTaskDetail,
  ObservationTaskPage,
  ObservationTaskPageQuery,
  ObservationUsage,
  ObservationWindowQuery,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type {
  CallAggregate,
  CallFilter,
  CallGroup,
  CallModelRow,
  CallRow,
  CallScope,
  CallStore,
  ModelAggregate,
} from './ports/callStore'
import type { ObservationTaskFactsPort } from './ports/taskFacts'
import { chunks, dayIndexes, dayLabel, nearestRank } from '../domain/statistics'

/** Distinct tasks a non-administrator window may aggregate before it is marked partial. */
export const VISIBLE_TASK_BUDGET = 20_000
export const TASK_PAGE_SIZE = 25
export const TASK_CALL_LIMIT = 2_000
export const AGENT_LIMIT = 200
export const MODEL_LIMIT = 500
export const SYSTEM_PAGE_SIZE = 50
const ID_CHUNK = 500

export interface ObservationQueries {
  overview(actor: Actor, query: ObservationWindowQuery): Promise<ObservationOverview>
  tasks(actor: Actor, query: ObservationTaskPageQuery): Promise<ObservationTaskPage>
  task(actor: Actor, taskId: string): Promise<ObservationTaskDetail | null>
  agents(actor: Actor, query: ObservationWindowQuery): Promise<ObservationAgentPage>
  models(actor: Actor, query: ObservationWindowQuery): Promise<ObservationModelPage>
  system(actor: Actor, query: ObservationSystemQuery): Promise<ObservationSystemPage>
}

const ZERO: ObservationUsage = {
  calls: 0,
  incompleteCalls: 0,
  failedCalls: 0,
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
  costNano: 0,
  unpricedCalls: 0,
}

function usageOf(
  row: Omit<ModelAggregate, 'runtimeId' | 'runtimeName' | 'protocol' | 'model'> | undefined,
): ObservationUsage {
  if (!row) return ZERO
  return {
    calls: row.calls,
    incompleteCalls: row.incompleteCalls,
    failedCalls: row.failedCalls,
    input: row.input,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    output: row.output,
    reasoning: row.reasoning,
    costNano: row.costNano,
    unpricedCalls: row.unpricedCalls,
  }
}

function addUsage(a: ObservationUsage, b: ObservationUsage): ObservationUsage {
  return {
    calls: a.calls + b.calls,
    incompleteCalls: a.incompleteCalls + b.incompleteCalls,
    failedCalls: a.failedCalls + b.failedCalls,
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    costNano: a.costNano + b.costNano,
    unpricedCalls: a.unpricedCalls + b.unpricedCalls,
  }
}

export function tokensOf(
  usage: Pick<ObservationUsage, 'input' | 'cacheRead' | 'cacheWrite' | 'output'>,
): number {
  return usage.input + usage.cacheRead + usage.cacheWrite + usage.output
}

function byConsumption<T extends { readonly usage: ObservationUsage }>(a: T, b: T): number {
  return tokensOf(b.usage) - tokensOf(a.usage) || b.usage.costNano - a.usage.costNano
}

function mergeAggregate(a: CallAggregate, b: CallAggregate): CallAggregate {
  return {
    ...addUsage(usageOf(a), usageOf(b)),
    key: a.key,
    label: a.label ?? b.label,
    durationMs: a.durationMs + b.durationMs,
    tasks: a.tasks + b.tasks,
    agents: a.agents + b.agents,
  }
}

function encodeCursor(row: { readonly startedAt: number; readonly id: string }): string {
  return Buffer.from(JSON.stringify([row.startedAt, row.id])).toString('base64url')
}

function decodeCursor(cursor: string | undefined): { startedAt: number; id: string } | null {
  if (!cursor) return null
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      Number.isSafeInteger(value[0]) &&
      typeof value[1] === 'string'
    )
      return { startedAt: value[0] as number, id: value[1] }
  } catch {
    /* fall through */
  }
  throw new RangeError('invalid-cursor')
}

function callView(
  row: CallRow,
  models: readonly CallModelRow[],
  attempt?: { readonly nodeId: string; readonly retryIndex: number },
): ObservationCall {
  return {
    id: row.id,
    purpose: row.purpose,
    taskId: row.taskId,
    systemKind: row.systemKind,
    systemLabel: row.systemLabel,
    nodeRunId: row.nodeRunId,
    nodeId: attempt?.nodeId ?? null,
    attempt: attempt ? attempt.retryIndex + 1 : null,
    agentId: row.agentId,
    agentName: row.agentName,
    runtimeName: row.runtimeName,
    protocol: row.protocol,
    status: row.status,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    usageState: row.usageState,
    costState: row.costState,
    input: row.input,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    output: row.output,
    reasoning: row.reasoning,
    costNano: row.costNano,
    models: models.map((model) => ({
      model: model.model,
      input: model.input,
      cacheRead: model.cacheRead,
      cacheWrite: model.cacheWrite,
      output: model.output,
      reasoning: model.reasoning,
      costNano: model.costNano,
    })),
  }
}

function groupModels(rows: readonly CallModelRow[]): Map<string, CallModelRow[]> {
  const grouped = new Map<string, CallModelRow[]>()
  for (const row of rows) {
    const list = grouped.get(row.callId)
    if (list) list.push(row)
    else grouped.set(row.callId, [row])
  }
  return grouped
}

function callUsage(row: CallRow): ObservationUsage {
  return {
    calls: 1,
    incompleteCalls: row.usageState === 'complete' ? 0 : 1,
    failedCalls: row.status === 'failed' || row.status === 'interrupted' ? 1 : 0,
    input: row.input,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    output: row.output,
    reasoning: row.reasoning,
    costNano: row.costNano,
    unpricedCalls: row.costState === 'unpriced' || row.costState === 'partial' ? 1 : 0,
  }
}

export function createObservationQueries(deps: {
  readonly calls: CallStore
  readonly tasks: ObservationTaskFactsPort
  readonly clock?: () => number
}): ObservationQueries {
  const clock = deps.clock ?? Date.now

  async function visibleScopes(
    actor: Actor,
    from: number,
    to: number,
  ): Promise<{ readonly scopes: readonly CallScope[]; readonly partial: boolean }> {
    if (actor.permissions.has('tasks:read:all'))
      return { scopes: [{ kind: 'all' }], partial: false }
    if (!actor.permissions.has('tasks:read:own')) return { scopes: [], partial: false }
    const candidates = await deps.calls.windowTaskIds(from, to, VISIBLE_TASK_BUDGET + 1)
    const visible: string[] = []
    for (const chunk of chunks(candidates.slice(0, VISIBLE_TASK_BUDGET), ID_CHUNK))
      visible.push(...(await deps.tasks.visibleTaskIds(actor, chunk)))
    return {
      scopes: [
        ...chunks(visible, ID_CHUNK).map((taskIds): CallScope => ({ kind: 'tasks', taskIds })),
        { kind: 'owner', userId: actor.user.id },
      ],
      partial: candidates.length > VISIBLE_TASK_BUDGET,
    }
  }

  async function aggregate(
    scopes: readonly CallScope[],
    base: Omit<CallFilter, 'scope'>,
    group: CallGroup,
    dayOffsetMinutes = 0,
  ): Promise<CallAggregate[]> {
    const merged = new Map<string, CallAggregate>()
    for (const scope of scopes)
      for (const row of await deps.calls.aggregate({ ...base, scope }, group, dayOffsetMinutes)) {
        const key = row.key ?? ''
        const previous = merged.get(key)
        merged.set(key, previous ? mergeAggregate(previous, row) : row)
      }
    return [...merged.values()]
  }

  async function taskNames(ids: readonly string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>()
    for (const chunk of chunks(ids, ID_CHUNK))
      for (const task of await deps.tasks.summaries(chunk)) names.set(task.id, task.name)
    return names
  }

  return {
    async overview(actor, query) {
      const asOf = clock()
      const { scopes, partial } = await visibleScopes(actor, query.from, query.to)
      const base = { from: query.from, to: query.to }
      const [byPurpose, byDay, byTask, byAgent, counts] = await Promise.all([
        aggregate(scopes, base, 'purpose'),
        aggregate(scopes, base, 'day', query.tzOffset),
        aggregate(scopes, { ...base, purpose: 'task' }, 'task'),
        aggregate(scopes, base, 'agent'),
        deps.tasks.counts(actor, base),
      ])
      const taskUsage = usageOf(byPurpose.find((row) => row.key === 'task'))
      const systemUsage = usageOf(byPurpose.find((row) => row.key === 'system'))
      const days = new Map(byDay.map((row) => [row.key, row]))
      const topTaskRows = byTask
        .filter((row) => row.key !== null)
        .map((row) => ({ taskId: row.key!, usage: usageOf(row) }))
        .sort(byConsumption)
        .slice(0, 5)
      const names = await taskNames(topTaskRows.map((row) => row.taskId))
      const status = counts.statuses
      const sum = (...keys: string[]) => keys.reduce((total, key) => total + (status[key] ?? 0), 0)
      return {
        asOf,
        from: query.from,
        to: query.to,
        partial,
        usage: addUsage(taskUsage, systemUsage),
        taskUsage,
        systemUsage,
        tasks: {
          total: Object.values(status).reduce((total, value) => total + value, 0),
          done: sum('done'),
          failed: sum('failed'),
          canceled: sum('canceled'),
          running: sum('pending', 'running'),
          waiting: sum('awaiting_review', 'awaiting_human'),
          interrupted: sum('interrupted'),
          durationSamples: counts.durations.length,
          durationP50: nearestRank(counts.durations, 0.5),
          durationP95: nearestRank(counts.durations, 0.95),
          durationMax: counts.durations.length
            ? counts.durations[counts.durations.length - 1]!
            : null,
        },
        daily: dayIndexes(query.from, query.to, query.tzOffset).map((index) => {
          const row = days.get(String(index))
          return {
            day: dayLabel(index),
            calls: row?.calls ?? 0,
            input: row?.input ?? 0,
            cacheRead: row?.cacheRead ?? 0,
            cacheWrite: row?.cacheWrite ?? 0,
            output: row?.output ?? 0,
            costNano: row?.costNano ?? 0,
          }
        }),
        topTasks: topTaskRows.map((row) => ({ ...row, name: names.get(row.taskId) ?? null })),
        topAgents: byAgent.map(agentRow).sort(byConsumption).slice(0, 5),
      }
    },

    async tasks(actor, query) {
      const asOf = clock()
      const page = await deps.tasks.page(actor, {
        from: query.from,
        to: query.to,
        ...(query.q ? { q: query.q } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.cursor ? { after: query.cursor } : {}),
        limit: TASK_PAGE_SIZE,
      })
      const ids = page.items.map((task) => task.id)
      const totals = ids.length
        ? await deps.calls.aggregate({ scope: { kind: 'tasks', taskIds: ids } }, 'task')
        : []
      const byTask = new Map(totals.map((row) => [row.key, row]))
      return {
        asOf,
        nextCursor: page.nextCursor,
        items: page.items.map((task) => {
          const row = byTask.get(task.id)
          return {
            taskId: task.id,
            name: task.name,
            status: task.status,
            startedAt: task.startedAt,
            finishedAt: task.finishedAt,
            agents: row?.agents ?? 0,
            usage: usageOf(row),
          }
        }),
      }
    },

    async task(actor, taskId) {
      if (!(await deps.tasks.visibleTaskIds(actor, [taskId])).includes(taskId)) return null
      const [task] = await deps.tasks.summaries([taskId])
      if (!task) return null
      const asOf = clock()
      const [found, attempts] = await Promise.all([
        deps.calls.taskCalls(taskId, TASK_CALL_LIMIT),
        deps.tasks.attempts(taskId),
      ])
      const byAttempt = new Map(attempts.map((row) => [row.nodeRunId, row]))
      const models = groupModels(found.models)
      return {
        asOf,
        task: {
          id: task.id,
          name: task.name,
          status: task.status,
          startedAt: task.startedAt,
          finishedAt: task.finishedAt,
          runningMs: task.runningMs,
        },
        usage: found.calls.map(callUsage).reduce(addUsage, ZERO),
        calls: found.calls.map((row) =>
          callView(
            row,
            models.get(row.id) ?? [],
            row.nodeRunId === null ? undefined : byAttempt.get(row.nodeRunId),
          ),
        ),
        truncated: found.truncated,
      }
    },

    async agents(actor, query) {
      const asOf = clock()
      const { scopes, partial } = await visibleScopes(actor, query.from, query.to)
      const rows = (await aggregate(scopes, { from: query.from, to: query.to }, 'agent'))
        .map(agentRow)
        .sort(byConsumption)
      return {
        asOf,
        partial,
        truncated: rows.length > AGENT_LIMIT,
        items: rows.slice(0, AGENT_LIMIT),
      }
    },

    async models(actor, query) {
      const asOf = clock()
      const { scopes, partial } = await visibleScopes(actor, query.from, query.to)
      const merged = new Map<string, ModelAggregate>()
      for (const scope of scopes)
        for (const row of await deps.calls.aggregateModels({
          from: query.from,
          to: query.to,
          scope,
        })) {
          const key = JSON.stringify([row.runtimeId, row.model])
          const previous = merged.get(key)
          merged.set(
            key,
            previous
              ? {
                  ...previous,
                  ...addUsage(usageOf(previous), usageOf(row)),
                  runtimeName: previous.runtimeName ?? row.runtimeName,
                }
              : row,
          )
        }
      const rows = [...merged.values()]
        .map((row) => ({
          runtimeId: row.runtimeId,
          runtimeName: row.runtimeName,
          protocol: row.protocol,
          model: row.model,
          usage: usageOf(row),
        }))
        .sort(byConsumption)
      return {
        asOf,
        partial,
        truncated: rows.length > MODEL_LIMIT,
        items: rows.slice(0, MODEL_LIMIT),
      }
    },

    async system(actor, query) {
      const asOf = clock()
      const { scopes, partial } = await visibleScopes(actor, query.from, query.to)
      const base = { from: query.from, to: query.to, purpose: 'system' as const }
      const kinds = (await aggregate(scopes, base, 'kind'))
        .map((row) => ({ kind: row.key ?? '', label: row.label, usage: usageOf(row) }))
        .sort(byConsumption)
      const before = decodeCursor(query.cursor)
      const filter = { ...base, ...(query.kind ? { systemKind: query.kind } : {}) }
      const pages = await Promise.all(
        scopes.map((scope) =>
          deps.calls.recentCalls({ ...filter, scope }, before, SYSTEM_PAGE_SIZE + 1),
        ),
      )
      const rows = pages
        .flatMap((page) => page.calls)
        .sort((a, b) => b.startedAt - a.startedAt || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0))
      const page = rows.slice(0, SYSTEM_PAGE_SIZE)
      const models = groupModels(pages.flatMap((result) => result.models))
      return {
        asOf,
        partial,
        kinds,
        recent: page.map((row) => callView(row, models.get(row.id) ?? [])),
        nextCursor: rows.length > SYSTEM_PAGE_SIZE ? encodeCursor(page[page.length - 1]!) : null,
      }
    },
  }
}

function agentRow(row: CallAggregate): ObservationAgentRow {
  const key = row.key ?? ''
  return {
    agentId: key.startsWith('~') ? null : key,
    agentName: row.label ?? (key.startsWith('~') ? key.slice(1) : key),
    tasks: row.tasks,
    durationMs: row.durationMs,
    usage: usageOf(row),
  }
}
