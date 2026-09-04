// RFC-357 —— 任务目录里三个 task-execution 源的**唯一**适配实现。
//
// 之前这份适配在两个 provider 上各有一份：SQLite 那份调下推的页查询，PostgreSQL 那份
// `listItems({ limit: 10_000 })` 拉回全部行再在内存里过滤 / 搜索 / 排序 / 分页 / 数 facets。
// 分叉的代价不是理论上的——facets 数在 view 之后、origin 按 `scheduled_task_id` 猜致
// 「事件」/「API」筛选 400、层级与排序写死，三处都是先在一侧修好、另一侧照旧。
//
// 现在只剩一份：provider 差异全部收进传进来的 `TaskListPage`（`taskListPage/sqlite.ts` 与
// `taskListPage/postgresql.ts` 两个装配），这里连数据库客户端都拿不到。

import type { TaskCatalogListItem, TaskOperationsListItem } from '@agent-workflow/shared'

import type { TaskCatalogSource } from '@/modules/task-catalog/composition/required-ports'
import type {
  TaskExecutionCatalogSourceFactory,
  TaskExecutionCatalogSourceId,
} from '../application/adapters/task-catalog-adapter'
import { taskListViewerOf, type TaskListPage } from './taskListPage'

function text(value: string) {
  const label = value === '' ? '—' : value
  return { 'zh-CN': label, 'en-US': label }
}

function targetLabel(item: { repoUrl: string | null; repoPath: string }): string | null {
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

function normalizeItem(
  sourceId: TaskExecutionCatalogSourceId,
  item: TaskOperationsListItem,
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
  return {
    id: item.id,
    sourceId,
    title: item.name,
    subject: { resourceId: subjectResourceId, label: text(subjectName) },
    targetLabel: targetLabel(item),
    status: item.status,
    statusDetail: null,
    startedAt: item.startedAt,
    updatedAt: item.finishedAt ?? item.executionClock.runningSince ?? item.startedAt,
    finishedAt: item.finishedAt,
    executionClock: item.executionClock,
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
      ...item.listContext,
    },
  }
}

function source(page: TaskListPage, sourceId: TaskExecutionCatalogSourceId): TaskCatalogSource {
  return {
    sourceId,
    supportsHierarchy: true,
    async list(input) {
      const listed = await page.list(
        // Actor 在模块边界上收成闭合投影（RFC-294 §629：目录合同禁止 full Actor）。
        taskListViewerOf(input.actor),
        {
          ...(input.view === undefined ? {} : { view: input.view }),
          ...(input.q === undefined ? {} : { q: input.q }),
          ...(input.statuses === undefined ? {} : { statuses: input.statuses }),
          subject: sourceId,
          ...(input.scope === undefined ? {} : { scope: input.scope }),
          ...(input.origin === undefined ? {} : { origin: input.origin }),
          ...(input.parentItemId === undefined ? {} : { parent_id: input.parentItemId }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        },
        {
          catalogVisibility: 'public',
        },
      )
      return {
        items: listed.items.map((item) => normalizeItem(sourceId, item)),
        nextCursor: listed.nextCursor,
        facets:
          listed.kind === 'root' ? listed.facets : { all: 0, active: 0, attention: 0, finished: 0 },
      }
    },
  }
}

/** 两个 provider 共用：给一个已装配好的页查询，得到三个目录源。 */
export function createTaskExecutionCatalogSourceFactory(
  page: TaskListPage,
): TaskExecutionCatalogSourceFactory {
  return Object.freeze({
    create: (sourceId: TaskExecutionCatalogSourceId) => source(page, sourceId),
  } satisfies TaskExecutionCatalogSourceFactory)
}
