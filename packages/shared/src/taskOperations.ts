// RFC-244 — list-only contracts for the high-density task operations page.
//
// Kept outside schemas/task.ts so the legacy TaskSummary / TaskListItem wire
// remains byte-compatible. The new endpoint opts into this module explicitly.

import { z } from 'zod'

import { TASK_STATUS, TaskListItemSchema, TaskStatusSchema, type TaskStatus } from './schemas/task'

export const TASK_LIST_VIEWS = ['all', 'active', 'attention', 'finished'] as const
export const TaskListViewSchema = z.enum(TASK_LIST_VIEWS)
export type TaskListView = z.infer<typeof TaskListViewSchema>

export const TASK_LIST_ACTIVE_STATUSES = [
  'pending',
  'running',
  'awaiting_review',
  'awaiting_human',
] as const satisfies readonly TaskStatus[]

export const TASK_LIST_FINISHED_STATUSES = [
  'done',
  'failed',
  'canceled',
  'interrupted',
] as const satisfies readonly TaskStatus[]

export const TASK_LIST_ATTENTION_STATUSES = [
  'failed',
  'awaiting_review',
  'awaiting_human',
] as const satisfies readonly TaskStatus[]

export const TASK_LIST_SUBJECTS = ['all', 'workflow', 'workgroup', 'agent'] as const
export const TaskListSubjectSchema = z.enum(TASK_LIST_SUBJECTS)
export type TaskListSubject = z.infer<typeof TaskListSubjectSchema>

export const TASK_LIST_SCOPES = ['mine', 'shared', 'all'] as const
export const TaskListScopeSchema = z.enum(TASK_LIST_SCOPES)
export type TaskListScope = z.infer<typeof TaskListScopeSchema>

/**
 * RFC-301 — persisted task launch-origin literals. This is a neutral shared
 * codec for the backend query contract and frontend filter; task-execution
 * owns the derivation/invariants that decide which literal is persisted.
 */
export const TASK_LAUNCH_ORIGINS = ['manual', 'scheduled', 'webhook', 'api'] as const
export const TaskLaunchOriginSchema = z.enum(TASK_LAUNCH_ORIGINS)
export type TaskLaunchOrigin = z.infer<typeof TaskLaunchOriginSchema>

export const TASK_LIST_ORIGINS = ['all', ...TASK_LAUNCH_ORIGINS] as const
export const TaskListOriginSchema = z.enum(TASK_LIST_ORIGINS)
export type TaskListOrigin = z.infer<typeof TaskListOriginSchema>

export const TaskListMatchKindSchema = z.enum(['self', 'context'])
export type TaskListMatchKind = z.infer<typeof TaskListMatchKindSchema>

export const TaskParentAvailabilitySchema = z.enum(['none', 'visible', 'unavailable'])
export type TaskParentAvailability = z.infer<typeof TaskParentAvailabilitySchema>

export const TaskExecutionClockSchema = z
  .object({
    runningMs: z.number().int().nonnegative(),
    runningSince: z.number().int().nonnegative().nullable(),
  })
  .strict()
export type TaskExecutionClock = z.infer<typeof TaskExecutionClockSchema>

export const TaskOperationsListContextSchema = z
  .object({
    matchKind: TaskListMatchKindSchema,
    parentAvailability: TaskParentAvailabilitySchema,
    qualifyingChildCount: z.number().int().nonnegative(),
    matchingDescendantCount: z.number().int().nonnegative(),
    branchStartedAt: z.number().int().nonnegative(),
  })
  .strict()
export type TaskOperationsListContext = z.infer<typeof TaskOperationsListContextSchema>

export const TaskOperationsListItemSchema = TaskListItemSchema.extend({
  executionClock: TaskExecutionClockSchema,
  listContext: TaskOperationsListContextSchema,
}).strict()
export type TaskOperationsListItem = z.infer<typeof TaskOperationsListItemSchema>

export const TaskOperationsFacetsSchema = z
  .object({
    all: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    attention: z.number().int().nonnegative(),
    finished: z.number().int().nonnegative(),
  })
  .strict()
export type TaskOperationsFacets = z.infer<typeof TaskOperationsFacetsSchema>

const TaskOperationsPageBaseShape = {
  items: z.array(TaskOperationsListItemSchema),
  nextCursor: z.string().nullable(),
}

export const TaskOperationsRootPageSchema = z
  .object({
    kind: z.literal('root'),
    ...TaskOperationsPageBaseShape,
    facets: TaskOperationsFacetsSchema,
  })
  .strict()
export type TaskOperationsRootPage = z.infer<typeof TaskOperationsRootPageSchema>

export const TaskOperationsChildPageSchema = z
  .object({
    kind: z.literal('children'),
    parentId: z.string(),
    ...TaskOperationsPageBaseShape,
  })
  .strict()
export type TaskOperationsChildPage = z.infer<typeof TaskOperationsChildPageSchema>

export const TaskOperationsPageSchema = z.discriminatedUnion('kind', [
  TaskOperationsRootPageSchema,
  TaskOperationsChildPageSchema,
])
export type TaskOperationsPage = z.infer<typeof TaskOperationsPageSchema>

export interface TaskOperationsFilters {
  view: TaskListView
  q?: string
  statuses: TaskStatus[]
  subject: TaskListSubject
  scope: TaskListScope
  origin: TaskListOrigin
}

const ACTIVE = new Set<TaskStatus>(TASK_LIST_ACTIVE_STATUSES)
const FINISHED = new Set<TaskStatus>(TASK_LIST_FINISHED_STATUSES)
const ATTENTION = new Set<TaskStatus>(TASK_LIST_ATTENTION_STATUSES)

/** Pure single-source predicate used by shared tests and frontend summaries. */
export function taskMatchesListView(
  view: TaskListView,
  status: TaskStatus,
  hasOpenAlert: boolean = false,
): boolean {
  if (view === 'all') return true
  if (view === 'active') return ACTIVE.has(status)
  if (view === 'finished') return FINISHED.has(status)
  return ATTENTION.has(status) || hasOpenAlert
}

/** Canonical TASK_STATUS ordering for URL/query status sets. */
export function canonicalTaskStatuses(values: readonly TaskStatus[]): TaskStatus[] {
  const wanted = new Set(values)
  return TASK_STATUS.filter((status) => wanted.has(status))
}

/** Strict parser for comma-separated status query values. */
export function parseTaskStatusList(raw: string): TaskStatus[] | null {
  const tokens = raw.split(',')
  if (tokens.length === 0 || tokens.some((token) => token === '')) return null
  const parsed: TaskStatus[] = []
  for (const token of tokens) {
    const status = TaskStatusSchema.safeParse(token)
    if (!status.success) return null
    parsed.push(status.data)
  }
  const canonical = canonicalTaskStatuses(parsed)
  return canonical.length === 0 ? null : canonical
}
