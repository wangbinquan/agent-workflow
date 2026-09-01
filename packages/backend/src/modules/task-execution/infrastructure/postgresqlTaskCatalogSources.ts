import {
  TASK_LIST_ACTIVE_STATUSES,
  TASK_LIST_ATTENTION_STATUSES,
  TASK_LIST_FINISHED_STATUSES,
  canonicalTaskStatuses,
  isWorkgroupTask,
  parseTaskStatusList,
  type TaskCatalogListItem,
  type TaskListItem,
  type TaskStatus,
} from '@agent-workflow/shared'

import type {
  TaskCatalogSource,
  TaskCatalogSourceListInput,
} from '@/modules/task-catalog/composition/required-ports'
import { ValidationError } from '@/util/errors'
import type {
  TaskExecutionCatalogSourceFactory,
  TaskExecutionCatalogSourceId,
} from '../application/adapters/task-catalog-adapter'
import type { TaskRouteOperations } from '../public/taskRoutes'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

interface SourceCursor {
  readonly v: 1
  readonly startedAt: number
  readonly taskId: string
}

function decodeCursor(raw: string): SourceCursor {
  try {
    const bytes = Buffer.from(raw, 'base64url')
    if (bytes.toString('base64url') !== raw) throw new Error('non-canonical')
    const value = JSON.parse(bytes.toString('utf8')) as unknown
    if (
      typeof value !== 'object' ||
      value === null ||
      (value as { v?: unknown }).v !== 1 ||
      !Number.isInteger((value as { startedAt?: unknown }).startedAt) ||
      typeof (value as { taskId?: unknown }).taskId !== 'string'
    ) {
      throw new Error('shape')
    }
    return value as SourceCursor
  } catch {
    throw new ValidationError('task-page-cursor-invalid', 'invalid task catalog cursor')
  }
}

function encodeCursor(item: TaskListItem): string {
  return Buffer.from(
    JSON.stringify({ v: 1, startedAt: item.startedAt, taskId: item.id } satisfies SourceCursor),
    'utf8',
  ).toString('base64url')
}

function text(value: string) {
  const label = value === '' ? '—' : value
  return { 'zh-CN': label, 'en-US': label }
}

function sourceOf(item: TaskListItem): TaskExecutionCatalogSourceId {
  if (item.sourceAgentId !== null && item.sourceAgentId !== undefined) return 'agent'
  if (isWorkgroupTask(item)) return 'workgroup'
  return 'workflow'
}

function targetLabel(item: TaskListItem): string | null {
  const value = item.repoUrl?.trim() || item.repoPath.trim()
  if (value === '') return null
  const normalized = value.replace(/\/+$/, '')
  return (
    normalized
      .split('/')
      .at(-1)
      ?.replace(/\.git$/i, '') || normalized
  )
}

function normalized(
  sourceId: TaskExecutionCatalogSourceId,
  item: TaskListItem,
  now: number,
): TaskCatalogListItem {
  const subjectName =
    sourceId === 'agent'
      ? (item.sourceAgentName ?? item.sourceAgentId ?? '—')
      : sourceId === 'workgroup'
        ? (item.workgroupName ?? item.workgroupId ?? '—')
        : (item.workflowName ?? item.workflowId)
  const subjectResourceId =
    sourceId === 'agent'
      ? (item.sourceAgentId ?? null)
      : sourceId === 'workgroup'
        ? (item.workgroupId ?? null)
        : item.workflowId
  const running = item.finishedAt === null
  return {
    id: item.id,
    sourceId,
    title: item.name,
    subject: { resourceId: subjectResourceId, label: text(subjectName) },
    targetLabel: targetLabel(item),
    status: item.status,
    statusDetail: null,
    startedAt: item.startedAt,
    updatedAt: item.finishedAt ?? now,
    finishedAt: item.finishedAt,
    executionClock: {
      runningMs: Math.max(0, (item.finishedAt ?? now) - item.startedAt),
      runningSince: running ? item.startedAt : null,
    },
    ownerUserId: item.ownerUserId,
    owner: item.owner,
    ownerLabel: null,
    errorSummary: item.errorSummary,
    failureCode: item.failureCode ?? null,
    childCount: item.childCount,
    repositoryCount: item.repoCount,
    scheduledTaskId: item.scheduledTaskId ?? null,
    openAlertCount: item.openAlertCount ?? 0,
    hierarchy: {
      parentItemId: item.parentTaskId ?? null,
      invocationDepth: item.invocationDepth ?? 0,
      matchKind: 'self',
      parentAvailability: item.parentTaskId === null ? 'none' : 'visible',
      qualifyingChildCount: item.childCount,
      matchingDescendantCount: item.childCount,
      branchStartedAt: item.startedAt,
    },
  }
}

function limitOf(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_LIMIT
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new ValidationError('task-page-filter-invalid', 'limit must be an integer from 1 to 100')
  }
  return value
}

function selectedStatuses(input: TaskCatalogSourceListInput): ReadonlySet<TaskStatus> | null {
  const explicit = input.statuses === undefined ? null : parseTaskStatusList(input.statuses)
  if (explicit !== null) return new Set(canonicalTaskStatuses(explicit))
  if (input.view === 'active') return new Set(TASK_LIST_ACTIVE_STATUSES)
  if (input.view === 'attention') return new Set(TASK_LIST_ATTENTION_STATUSES)
  if (input.view === 'finished') return new Set(TASK_LIST_FINISHED_STATUSES)
  if (input.view !== undefined && input.view !== 'all') {
    throw new ValidationError('task-page-filter-invalid', `unknown view: ${input.view}`)
  }
  return null
}

function statusFacet(status: TaskStatus): 'active' | 'attention' | 'finished' {
  if ((TASK_LIST_ACTIVE_STATUSES as readonly string[]).includes(status)) return 'active'
  if ((TASK_LIST_ATTENTION_STATUSES as readonly string[]).includes(status)) return 'attention'
  return 'finished'
}

function source(
  operations: Pick<TaskRouteOperations, 'listItems'>,
  sourceId: TaskExecutionCatalogSourceId,
  now: () => number,
): TaskCatalogSource {
  return Object.freeze({
    sourceId,
    supportsHierarchy: true,
    async list(input: TaskCatalogSourceListInput) {
      const scope = input.scope ?? (input.actor.permissions.has('tasks:read:all') ? 'all' : 'mine')
      if (scope !== 'all' && scope !== 'mine' && scope !== 'shared') {
        throw new ValidationError('task-page-filter-invalid', `unknown scope: ${scope}`)
      }
      const rows = await operations.listItems({
        catalogVisibility: 'public',
        ...(input.parentItemId === undefined
          ? { topLevelOnly: true }
          : { parentTaskId: input.parentItemId }),
        ...(scope === 'all' ? {} : { visibility: { actorUserId: input.actor.user.id, scope } }),
        // The provider route query remains bounded even if an installation has
        // years of history; the catalog applies its own public page after all
        // source/view filters below.
        limit: 10_000,
      })
      const statuses = selectedStatuses(input)
      const q = input.q?.trim().toLocaleLowerCase()
      const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor)
      const all = rows
        .filter((item) => sourceOf(item) === sourceId)
        .filter((item) => statuses === null || statuses.has(item.status))
        .filter((item) => {
          if (input.origin === undefined || input.origin === 'all') return true
          if (input.origin === 'scheduled') return item.scheduledTaskId != null
          if (input.origin === 'manual') return item.scheduledTaskId == null
          throw new ValidationError('task-page-filter-invalid', `unknown origin: ${input.origin}`)
        })
        .filter((item) => {
          if (q === undefined || q === '') return true
          return [
            item.name,
            item.workflowName,
            item.workflowId,
            item.sourceAgentName,
            item.sourceAgentId,
            item.workgroupName,
            item.workgroupId,
            item.repoUrl,
            item.repoPath,
          ].some((value) => value?.toLocaleLowerCase().includes(q) === true)
        })
        .sort((left, right) => right.startedAt - left.startedAt || right.id.localeCompare(left.id))
      const afterCursor =
        cursor === null
          ? all
          : all.filter(
              (item) =>
                item.startedAt < cursor.startedAt ||
                (item.startedAt === cursor.startedAt && item.id.localeCompare(cursor.taskId) < 0),
            )
      const limit = limitOf(input.limit)
      const page = afterCursor.slice(0, limit)
      const counts = { active: 0, attention: 0, finished: 0 }
      for (const item of all) counts[statusFacet(item.status)] += 1
      return {
        items: page.map((item) => normalized(sourceId, item, now())),
        nextCursor:
          afterCursor.length > page.length && page.length > 0 ? encodeCursor(page.at(-1)!) : null,
        facets: { all: all.length, ...counts },
      }
    },
  } satisfies TaskCatalogSource)
}

/** PostgreSQL catalog adapter over the already-composed TaskExecution route query. */
export function createPostgresqlTaskExecutionCatalogSourceFactory(
  operations: Pick<TaskRouteOperations, 'listItems'>,
  now: () => number = Date.now,
): TaskExecutionCatalogSourceFactory {
  return Object.freeze({
    create: (sourceId: TaskExecutionCatalogSourceId) => source(operations, sourceId, now),
  } satisfies TaskExecutionCatalogSourceFactory)
}
