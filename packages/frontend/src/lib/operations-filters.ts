// RFC-246 — deterministic client-side business views for APIs that already
// return the complete authorized Scheduled/Cached Repo collection.

import type { CachedRepo, ScheduledTaskListItem } from '@agent-workflow/shared'

export const SCHEDULED_OPERATIONS_VIEWS = ['all', 'enabled', 'attention', 'paused'] as const
export type ScheduledOperationsView = (typeof SCHEDULED_OPERATIONS_VIEWS)[number]
export type ScheduledLaunchKindFilter = 'all' | ScheduledTaskListItem['launchKind']
export type ScheduledOutcomeFilter =
  | 'all'
  | 'never'
  | NonNullable<ScheduledTaskListItem['lastStatus']>

export interface ScheduledOperationsFilters {
  view: ScheduledOperationsView
  q: string
  launchKind: ScheduledLaunchKindFilter
  outcome: ScheduledOutcomeFilter
}

/** Preserve the pre-RFC-246 repair-badge predicate. Attention is broader:
 * a failed outcome can need intervention without claiming corrupt config. */
export function scheduledNeedsRepair(row: ScheduledTaskListItem): boolean {
  return (
    row.migrationNeeded ||
    row.launchPayload === null ||
    row.scheduleSpec === null ||
    row.lastError !== null
  )
}

export function scheduledNeedsAttention(row: ScheduledTaskListItem): boolean {
  return scheduledNeedsRepair(row) || row.lastStatus === 'failed' || row.consecutiveFailures > 1
}

function scheduledMatchesView(row: ScheduledTaskListItem, view: ScheduledOperationsView): boolean {
  switch (view) {
    case 'all':
      return true
    case 'enabled':
      return row.enabled
    case 'attention':
      return scheduledNeedsAttention(row)
    case 'paused':
      return !row.enabled
  }
}

export function scheduledOperationsFacets(
  items: ReadonlyArray<ScheduledTaskListItem>,
): Record<ScheduledOperationsView, number> {
  return {
    all: items.length,
    enabled: items.filter((row) => row.enabled).length,
    attention: items.filter(scheduledNeedsAttention).length,
    paused: items.filter((row) => !row.enabled).length,
  }
}

export function filterScheduledOperations(
  items: ReadonlyArray<ScheduledTaskListItem>,
  filters: ScheduledOperationsFilters,
  scheduleText: (row: ScheduledTaskListItem) => string,
): ScheduledTaskListItem[] {
  const query = filters.q.trim().toLocaleLowerCase()
  return items.filter((row) => {
    if (!scheduledMatchesView(row, filters.view)) return false
    if (filters.launchKind !== 'all' && row.launchKind !== filters.launchKind) return false
    if (
      filters.outcome !== 'all' &&
      (filters.outcome === 'never' ? row.lastStatus !== null : row.lastStatus !== filters.outcome)
    ) {
      return false
    }
    if (query === '') return true
    const owner = row.owner
    return [
      row.name,
      row.launchKind,
      scheduleText(row),
      row.ownerUserId,
      owner?.id,
      owner?.username,
      owner?.displayName,
    ].some((value) => value?.toLocaleLowerCase().includes(query) === true)
  })
}

export const REPO_OPERATIONS_VIEWS = ['all', 'referenced', 'attention', 'unused'] as const
export type RepoOperationsView = (typeof REPO_OPERATIONS_VIEWS)[number]
export type RepoSubmoduleFilter = 'all' | 'with' | 'without'
export type RepoAutoRefreshFilter = 'all' | 'refreshed' | 'never'

export interface RepoOperationsFilters {
  view: RepoOperationsView
  q: string
  submodules: RepoSubmoduleFilter
  autoRefresh: RepoAutoRefreshFilter
}

export function repoNeedsAttention(row: CachedRepo): boolean {
  return row.hasSubmodules === true && row.lastSubmoduleSyncOk === false
}

function repoMatchesView(row: CachedRepo, view: RepoOperationsView): boolean {
  switch (view) {
    case 'all':
      return true
    case 'referenced':
      return row.referencingTaskCount > 0
    case 'attention':
      return repoNeedsAttention(row)
    case 'unused':
      return row.referencingTaskCount === 0
  }
}

export function repoOperationsFacets(
  items: ReadonlyArray<CachedRepo>,
): Record<RepoOperationsView, number> {
  return {
    all: items.length,
    referenced: items.filter((row) => row.referencingTaskCount > 0).length,
    attention: items.filter(repoNeedsAttention).length,
    unused: items.filter((row) => row.referencingTaskCount === 0).length,
  }
}

export function filterRepoOperations(
  items: ReadonlyArray<CachedRepo>,
  filters: RepoOperationsFilters,
): CachedRepo[] {
  const query = filters.q.trim().toLocaleLowerCase()
  return items.filter((row) => {
    if (!repoMatchesView(row, filters.view)) return false
    if (
      filters.submodules !== 'all' &&
      (filters.submodules === 'with' ? row.hasSubmodules !== true : row.hasSubmodules !== false)
    ) {
      return false
    }
    if (
      filters.autoRefresh !== 'all' &&
      (filters.autoRefresh === 'refreshed'
        ? row.lastAutoRefreshAt === null
        : row.lastAutoRefreshAt !== null)
    ) {
      return false
    }
    if (query === '') return true
    return [row.urlRedacted, row.localPath, row.defaultBranch].some(
      (value) => value?.toLocaleLowerCase().includes(query) === true,
    )
  })
}
