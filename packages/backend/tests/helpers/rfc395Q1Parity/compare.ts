import {
  TaskSchema,
  TaskNodeRunsSchema,
  TaskCatalogPageSchema,
  ReviewSummarySchema,
  ClarifyRoundSchema,
  TaskSummarySchema,
  TaskListItemSchema,
  TaskStatusSchema,
  AgentSchema,
  SessionViewResponseSchema,
  OBSERVATION_CALL_STATUSES,
  OBSERVATION_USAGE_STATES,
  OBSERVATION_COST_STATES,
  type ObservationTaskDetail,
} from '@agent-workflow/shared'
import { z } from 'zod'
import { Q1_TASK, Q1_CLARIFY_RUN, Q1_AGENT, Q1_AGENT_RELATIONS } from './fixture'

// Observation has a shared TypeScript contract, but no shared response schema.
const observationSchema = z.object({
  asOf: z.number().int(),
  task: z.object({
    id: z.string(),
    name: z.string(),
    status: TaskStatusSchema,
    startedAt: z.number(),
    finishedAt: z.number().nullable(),
    runningMs: z.number(),
  }),
  usage: z.object({
    calls: z.number(),
    incompleteCalls: z.number(),
    failedCalls: z.number(),
    input: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    output: z.number(),
    reasoning: z.number(),
    costNano: z.number(),
    unpricedCalls: z.number(),
  }),
  calls: z.array(
    z.object({
      id: z.string(),
      purpose: z.enum(['task', 'system']),
      taskId: z.string().nullable(),
      systemKind: z.string().nullable(),
      systemLabel: z.string().nullable(),
      nodeRunId: z.string().nullable(),
      nodeId: z.string().nullable(),
      attempt: z.number().nullable(),
      agentId: z.string().nullable(),
      agentName: z.string(),
      runtimeId: z.string().nullable(),
      runtimeName: z.string().nullable(),
      protocol: z.string(),
      status: z.enum(OBSERVATION_CALL_STATUSES),
      startedAt: z.number(),
      endedAt: z.number().nullable(),
      usageState: z.enum(OBSERVATION_USAGE_STATES),
      costState: z.enum(OBSERVATION_COST_STATES),
      input: z.number(),
      cacheRead: z.number(),
      cacheWrite: z.number(),
      output: z.number(),
      reasoning: z.number(),
      costNano: z.number(),
      models: z.array(
        z.object({
          model: z.string(),
          input: z.number(),
          cacheRead: z.number(),
          cacheWrite: z.number(),
          output: z.number(),
          reasoning: z.number(),
          costNano: z.number().nullable(),
        }),
      ),
    }),
  ),
  truncated: z.boolean(),
}) satisfies z.ZodType<ObservationTaskDetail>

export const Q1_SURFACES = [
  { name: 'task', path: `/api/tasks/${Q1_TASK}`, schema: TaskSchema },
  {
    name: 'task-list',
    path: '/api/tasks?workflow_id=q1-workflow&limit=100',
    schema: z.array(TaskSummarySchema),
  },
  {
    name: 'task-list-items',
    path: '/api/tasks?workflow_id=q1-workflow&limit=100&include_owner=true',
    schema: z.array(TaskListItemSchema),
  },
  { name: 'agent', path: `/api/agents/${Q1_AGENT}`, schema: AgentSchema },
  {
    name: 'session',
    path: `/api/tasks/${Q1_TASK}/node-runs/q1-unknown-run/session`,
    schema: SessionViewResponseSchema,
  },
  { name: 'observation', path: `/api/observability/tasks/${Q1_TASK}`, schema: observationSchema },
  { name: 'node-runs', path: `/api/tasks/${Q1_TASK}/node-runs`, schema: TaskNodeRunsSchema },
  {
    name: 'directory',
    path: '/api/task-catalog?q=Q1%20parity%20fixture&limit=100',
    schema: TaskCatalogPageSchema,
  },
  {
    name: 'reviews',
    path: `/api/reviews?taskId=${Q1_TASK}&status=all`,
    schema: z.array(ReviewSummarySchema),
  },
  { name: 'clarify', path: `/api/clarify/${Q1_CLARIFY_RUN}`, schema: ClarifyRoundSchema },
] as const
export type Q1Surface = (typeof Q1_SURFACES)[number]['name']

/** New parity surfaces must exercise their seeded relationships, not empty responses. */
export function assertQ1CaptureContent(surface: Q1Surface, value: unknown): void {
  if (surface === 'task-list' || surface === 'task-list-items') {
    const rows = z.array(z.object({ id: z.string() })).parse(value)
    if (!rows.some((row) => row.id === Q1_TASK)) throw new Error(`q1-empty-${surface}-oracle`)
  }
  if (surface === 'agent') {
    const agent = AgentSchema.parse(value)
    for (const field of ['skills', 'dependsOn', 'mcp', 'plugins'] as const)
      if (JSON.stringify(agent[field]) !== JSON.stringify(Q1_AGENT_RELATIONS[field]))
        throw new Error(`q1-agent-relations-oracle:${field}`)
  }
  if (surface === 'session') {
    const text = JSON.stringify(SessionViewResponseSchema.parse(value))
    for (const expected of [
      'Original prompt',
      'Original session event q1-agent-run',
      'Original session event q1-unknown-run',
    ])
      if (!text.includes(expected)) throw new Error('q1-empty-session-oracle')
  }
  if (surface === 'observation') {
    const detail = observationSchema.parse(value)
    for (const [id, nodeRunId, attempt] of [
      ['q1-call-0', 'q1-agent-run', 1],
      ['q1-call-1', 'q1-unknown-run', 4],
    ] as const)
      if (
        !detail.calls.some(
          (call) =>
            call.id === id &&
            call.nodeRunId === nodeRunId &&
            call.attempt === attempt &&
            call.models.length > 0,
        )
      )
        throw new Error('q1-empty-observation-oracle')
  }
}

export interface Q1CaptureWindow {
  readonly startedAt: number
  readonly finishedAt: number
}

/** Stored bytes stay exact except seq backfill; observation's request clock is checked separately. */
export function assertQ1ResponseParity(
  surface: Q1Surface,
  before: string,
  after: string,
  windows?: { readonly before: Q1CaptureWindow; readonly after: Q1CaptureWindow },
): void {
  if (surface === 'observation') {
    // asOf is the request clock, not stored history. Validate it independently;
    // every other byte, including persisted timestamps and attempts, must match.
    if (!windows) throw new Error('q1-observation-capture-window-required')
    const old = JSON.parse(before) as Record<string, unknown>
    const next = JSON.parse(after) as Record<string, unknown>
    for (const [value, window] of [
      [old.asOf, windows.before],
      [next.asOf, windows.after],
    ] as const)
      if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < window.startedAt ||
        value > window.finishedAt
      )
        throw new Error('q1-observation-clock-outside-capture')
    if (JSON.stringify(old) !== before || JSON.stringify(next) !== after)
      throw new Error('q1-dto-byte-mismatch:serialization')
    next.asOf = old.asOf
    if (JSON.stringify(next) !== before) throw new Error('q1-dto-byte-mismatch:observation')
    return
  }
  if (before === after) return
  if (surface !== 'node-runs') throw new Error(`q1-dto-byte-mismatch:${surface}`)
  const old = JSON.parse(before) as { runs: Record<string, unknown>[] }
  const next = JSON.parse(after) as { runs: Record<string, unknown>[] }
  if (JSON.stringify(old) !== before || JSON.stringify(next) !== after)
    throw new Error('q1-dto-byte-mismatch:serialization')
  if (old.runs.length !== next.runs.length) throw new Error('q1-dto-byte-mismatch:run-count')
  for (const [index, row] of next.runs.entries()) {
    const prior = old.runs[index]!
    if (row.id !== prior.id) throw new Error('q1-dto-byte-mismatch:run-order')
    if (prior.seq === null || !Object.hasOwn(prior, 'seq')) {
      if (typeof row.seq !== 'number' || !Number.isSafeInteger(row.seq))
        throw new Error('q1-seq-not-integer')
      if (Object.hasOwn(prior, 'seq')) row.seq = null
      else delete row.seq
    }
  }
  if (JSON.stringify(next) !== before) throw new Error('q1-dto-byte-mismatch:node-runs')
}
