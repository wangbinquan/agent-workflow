import type { TaskCatalogListItem, TaskOperationsListItem } from '@agent-workflow/shared'

// RFC-349 SQLite compatibility source factory.
import type { DbClient } from '@/db/client'
import type { TaskCatalogSource } from '@/modules/task-catalog/composition/required-ports'
import type { OwnerIdentityQueries } from '@/modules/identity-access/public/operations'
import { createSqliteTaskListPage, taskListViewerOf, type TaskListPage } from './taskListPage'

const EXECUTION_SOURCE_IDS = ['agent', 'workflow', 'workgroup'] as const

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
  sourceId: (typeof EXECUTION_SOURCE_IDS)[number],
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

function source(
  page: TaskListPage,
  sourceId: (typeof EXECUTION_SOURCE_IDS)[number],
): TaskCatalogSource {
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

export function composeTaskExecutionCatalogSources(
  db: DbClient,
  owners: OwnerIdentityQueries,
): TaskCatalogSource[] {
  const page = createSqliteTaskListPage(db, owners)
  return EXECUTION_SOURCE_IDS.map((sourceId) => source(page, sourceId))
}
