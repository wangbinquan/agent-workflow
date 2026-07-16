// RFC-198 — URL-backed task-detail tab resolution.
//
// The route cannot choose a panel from the task id alone: workgroup shape is
// only stable after the room aggregate arrives.  Keep that async decision in a
// pure resolver so loading/error/late-config transitions are exhaustively
// testable and the rendered URL can remain the single tab authority.

import type { DynamicWorkflowPhase } from '@agent-workflow/shared'
import {
  DYNAMIC_WORKGROUP_TAB_ORDER,
  TAB_ORDER,
  WORKGROUP_TAB_ORDER,
  availableTabs,
  defaultDynamicTab,
  type TaskDetailCapabilities,
  type TaskDetailTab,
} from './task-detail-tabs'

const TASK_DETAIL_TAB_SET = new Set<string>([
  ...TAB_ORDER,
  ...WORKGROUP_TAB_ORDER,
  ...DYNAMIC_WORKGROUP_TAB_ORDER,
])

export interface TaskDetailSearch extends Record<string, unknown> {
  tab?: TaskDetailTab
}

/** Syntax-only route validation. Availability is async and belongs below. */
export function isTaskDetailTab(value: unknown): value is TaskDetailTab {
  return typeof value === 'string' && TASK_DETAIL_TAB_SET.has(value)
}

/** Preserve unrelated search payload while dropping only an invalid tab. */
export function validateTaskDetailSearch(raw: Record<string, unknown>): TaskDetailSearch {
  const { tab: _invalidOrReplacedTab, ...rest } = raw
  return isTaskDetailTab(raw.tab) ? { ...rest, tab: raw.tab } : rest
}

/** Functional-search updater shared by push and canonical replace navigation. */
export function withTaskDetailTab<T extends Record<string, unknown>>(
  previous: T,
  tab: TaskDetailTab,
): T & { tab: TaskDetailTab } {
  return { ...previous, tab }
}

export type TaskDetailRoomClassification =
  | { status: 'pending' }
  | { status: 'error' }
  | {
      status: 'ready'
      mode: 'turn-engine' | 'dynamic-workflow'
      dwPhase?: DynamicWorkflowPhase | null
    }

export interface ResolveTaskDetailTabsInput {
  taskLoaded: boolean
  /** Async permission/capability inputs must settle before URL canonicalization. */
  capabilitiesReady?: boolean
  hasOutputs: boolean
  capabilities?: TaskDetailCapabilities
  isWorkgroup: boolean
  room: TaskDetailRoomClassification
  searchTab?: TaskDetailTab
}

export type TaskDetailTabResolution =
  | { status: 'pending' }
  | { status: 'error'; requestedTab?: TaskDetailTab }
  | {
      status: 'ready'
      tab: TaskDetailTab
      tabs: TaskDetailTab[]
      /** Missing/unavailable search must be written back with replace. */
      canonicalize: boolean
      shape: 'plain' | 'turn-engine' | 'dynamic-workflow'
    }

/**
 * Resolve the task shape and active URL panel without speculating while the
 * workgroup room request is unsettled.
 *
 * An already-available search tab always wins.  This is what makes the first
 * dynamic default one-shot: once canonicalized into the URL, later phase
 * changes cannot override it (unless the tab truly leaves `availableTabs`).
 */
export function resolveTaskDetailTabs(input: ResolveTaskDetailTabsInput): TaskDetailTabResolution {
  if (!input.taskLoaded || input.capabilitiesReady === false) return { status: 'pending' }

  let shape: 'plain' | 'turn-engine' | 'dynamic-workflow'
  let isDynamicWorkgroup = false
  let defaultTab: TaskDetailTab

  if (!input.isWorkgroup) {
    shape = 'plain'
    defaultTab = 'workflow-status'
  } else {
    if (input.room.status === 'pending') return { status: 'pending' }
    if (input.room.status === 'error') {
      return { status: 'error', requestedTab: input.searchTab }
    }
    if (input.room.mode === 'dynamic-workflow') {
      shape = 'dynamic-workflow'
      isDynamicWorkgroup = true
      defaultTab = defaultDynamicTab(input.room.dwPhase)
    } else {
      shape = 'turn-engine'
      defaultTab = 'chatroom'
    }
  }

  const tabs = availableTabs({
    hasOutputs: input.hasOutputs,
    isWorkgroup: input.isWorkgroup,
    isDynamicWorkgroup,
    capabilities: input.capabilities,
  })
  const stableDefault = tabs.includes(defaultTab) ? defaultTab : (tabs[0] ?? 'details')
  const tab =
    input.searchTab !== undefined && tabs.includes(input.searchTab)
      ? input.searchTab
      : stableDefault

  return {
    status: 'ready',
    tab,
    tabs,
    canonicalize: input.searchTab !== tab,
    shape,
  }
}
