import type {
  TaskCatalogListItem,
  TaskCatalogPage,
  TaskOperationsListItem,
  TaskOperationsPage,
  TaskSourceId,
} from '@agent-workflow/shared'

function sourceIdOf(item: TaskOperationsListItem): Exclude<TaskSourceId, 'digital-employee'> {
  if (item.workgroupId != null && item.workgroupId !== '') return 'workgroup'
  if (item.sourceAgentName != null && item.sourceAgentName !== '') return 'agent'
  return 'workflow'
}

function text(value: string) {
  const label = value === '' ? '—' : value
  return { 'zh-CN': label, 'en-US': label }
}

export function catalogItemFromTask(item: TaskOperationsListItem): TaskCatalogListItem {
  const sourceId = sourceIdOf(item)
  const subject =
    sourceId === 'agent'
      ? (item.sourceAgentName ?? item.sourceAgentId ?? '—')
      : sourceId === 'workgroup'
        ? (item.workgroupName ?? item.workgroupId ?? '—')
        : (item.workflowName ?? item.workflowId)
  return {
    id: item.id,
    sourceId,
    title: item.name,
    subject: {
      resourceId:
        sourceId === 'agent'
          ? (item.sourceAgentId ?? null)
          : sourceId === 'workgroup'
            ? (item.workgroupId ?? null)
            : item.workflowId,
      label: text(subject),
    },
    targetLabel: item.repoUrl ?? item.repoPath.split('/').filter(Boolean).at(-1) ?? null,
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

export function catalogPageFromOperations(page: TaskOperationsPage): TaskCatalogPage {
  return {
    schemaVersion: 1,
    sourceIds: ['agent', 'workflow', 'workgroup'],
    items: page.items.map(catalogItemFromTask),
    nextCursor: page.nextCursor,
    facets: page.kind === 'root' ? page.facets : { all: 0, active: 0, attention: 0, finished: 0 },
  }
}
