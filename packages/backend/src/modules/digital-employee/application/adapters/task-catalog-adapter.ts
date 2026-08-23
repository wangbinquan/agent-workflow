import {
  DigitalEmployeeTaskPageSchema,
  TaskListOriginSchema,
  TaskListScopeSchema,
  parseTaskStatusList,
  type TaskCatalogListItem,
  type TaskLaunchOrigin,
  type TaskStatus,
} from '@agent-workflow/shared'
import { classifyTerminalKind } from '@/modules/digital-employee/public/types'

import type { TaskCatalogSource } from '@/modules/task-catalog/composition/required-ports'
import { ValidationError } from '@/util/errors'

type EmployeeCaseState = 'active' | 'waiting' | 'blocked' | 'terminal'

function caseStatesFromTaskStatuses(
  statuses: readonly TaskStatus[],
): EmployeeCaseState[] | undefined {
  if (statuses.length === 0) return undefined
  const states = new Set<EmployeeCaseState>()
  for (const status of statuses) {
    if (status === 'pending' || status === 'running') states.add('active')
    else if (status === 'awaiting_human' || status === 'awaiting_review') states.add('waiting')
    else if (status === 'failed' || status === 'interrupted') states.add('blocked')
    else states.add('terminal')
  }
  return [...states]
}

function text(value: string) {
  const label = value === '' ? '—' : value
  return { 'zh-CN': label, 'en-US': label }
}

function employeeLabel(
  typeName: { readonly 'zh-CN': string; readonly 'en-US': string },
  employeeName: string,
) {
  return {
    'zh-CN': `${typeName['zh-CN']} · ${employeeName}`,
    'en-US': `${typeName['en-US']} · ${employeeName}`,
  }
}

function taskStatus(item: { state: EmployeeCaseState; terminalKind: string | null }): TaskStatus {
  if (item.state === 'active') return 'running'
  if (item.state === 'waiting') return 'awaiting_human'
  if (item.state === 'blocked') return 'failed'
  // RFC-317 T44（DE-06）—— 走共享分类，不再就地手写一张表。
  //
  // 旧写法认的是 'closed-unmerged'，那是**旧版 Mission** 的终态词，OS 从来不产出；
  // OS 真正铸的 'closed' 于是掉进兜底被报成 'done'——按状态筛 canceled 会漏掉它们，
  // 而它们在列表里显示成"完成"。
  return classifyTerminalKind(item.terminalKind).catalog
}

export function composeDigitalEmployeeTaskCatalogSource(runtime: {
  readonly queries: {
    listCasePage(input: {
      readonly employeeId?: string
      readonly ownerUserId?: string
      readonly launchOrigin?: TaskLaunchOrigin
      readonly states?: readonly EmployeeCaseState[]
      readonly view?: 'all' | 'active' | 'attention' | 'finished'
      readonly q?: string
      readonly cursor?: string
      readonly limit?: number
    }): string
  }
}): TaskCatalogSource {
  return {
    sourceId: 'digital-employee',
    supportsHierarchy: false,
    async list(input) {
      const view = input.view ?? 'all'
      if (!['all', 'active', 'attention', 'finished'].includes(view)) {
        throw new ValidationError('task-page-filter-invalid', `unknown view: ${view}`)
      }
      const statuses = input.statuses === undefined ? [] : parseTaskStatusList(input.statuses)
      if (statuses === null) {
        throw new ValidationError('task-page-filter-invalid', 'statuses must contain known values')
      }
      const parsedScope = TaskListScopeSchema.safeParse(input.scope ?? 'all')
      if (!parsedScope.success) {
        throw new ValidationError('task-page-filter-invalid', `unknown scope: ${input.scope}`)
      }
      const scope =
        parsedScope.data === 'all' && !input.actor.permissions.has('tasks:read:all')
          ? 'mine'
          : parsedScope.data
      if (scope === 'shared') {
        return {
          items: [],
          nextCursor: null,
          facets: { all: 0, active: 0, attention: 0, finished: 0 },
        }
      }
      const parsedOrigin = TaskListOriginSchema.safeParse(input.origin ?? 'all')
      if (!parsedOrigin.success) {
        throw new ValidationError('task-page-filter-invalid', `unknown origin: ${input.origin}`)
      }
      const launchOrigin =
        parsedOrigin.data === 'all'
          ? undefined
          : parsedOrigin.data === 'webhook'
            ? 'event'
            : parsedOrigin.data
      let limit: number | undefined
      if (input.limit !== undefined) {
        if (!/^\d+$/.test(input.limit)) {
          throw new ValidationError('task-page-filter-invalid', 'limit must be an integer')
        }
        limit = Number(input.limit)
      }
      const states = caseStatesFromTaskStatuses(statuses)
      const page = DigitalEmployeeTaskPageSchema.parse(
        JSON.parse(
          runtime.queries.listCasePage({
            view: view as 'all' | 'active' | 'attention' | 'finished',
            ...(scope === 'mine' ? { ownerUserId: input.actor.user.id } : {}),
            ...(launchOrigin === undefined ? {} : { launchOrigin }),
            ...(states === undefined ? {} : { states }),
            ...(input.q === undefined ? {} : { q: input.q }),
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            ...(limit === undefined ? {} : { limit }),
          }),
        ) as unknown,
      )
      return {
        items: page.items.map((item): TaskCatalogListItem => {
          const status = taskStatus(item)
          const detail =
            item.currentWorkItemName ?? (item.blockReason === null ? null : text(item.blockReason))
          return {
            id: item.id,
            sourceId: 'digital-employee',
            title: item.taskName,
            subject: {
              resourceId: item.employeeRef.id,
              label: employeeLabel(item.typeName, item.employeeName),
            },
            targetLabel: item.targetRef,
            status,
            statusDetail: detail,
            startedAt: item.createdAt,
            updatedAt: item.updatedAt,
            finishedAt: item.state === 'terminal' ? item.updatedAt : null,
            executionClock: {
              runningMs: Math.max(0, item.updatedAt - item.createdAt),
              runningSince: item.state === 'active' ? item.updatedAt : null,
            },
            ownerUserId: null,
            owner: null,
            ownerLabel: item.employeeName,
            errorSummary: item.blockReason,
            failureCode: null,
            childCount: 0,
            repositoryCount: item.targetRef === null ? 0 : 1,
            scheduledTaskId: null,
            openAlertCount: item.state === 'blocked' ? 1 : 0,
            hierarchy: {
              parentItemId: null,
              invocationDepth: 0,
              matchKind: 'self',
              parentAvailability: 'none',
              qualifyingChildCount: 0,
              matchingDescendantCount: 0,
              branchStartedAt: item.updatedAt,
            },
          }
        }),
        nextCursor: page.nextCursor,
        facets: page.facets,
      }
    },
  }
}
