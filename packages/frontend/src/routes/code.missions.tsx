// RFC-310 compatibility route for the retired second Mission inbox.
//
// Digital-employee runs are Tasks. Keep this module's shared status projection
// helpers, but send old bookmarks to the unified filtered list.

import { createRoute, redirect } from '@tanstack/react-router'

import type { StatusChipKind } from '@/components/StatusChip'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/code/missions',
  beforeLoad: redirectMissionListToTasks,
})

export function redirectMissionListToTasks(): never {
  throw redirect({ to: '/tasks', search: { category: 'digital-employee' } })
}

export interface MissionSummary {
  id: string
  status: string
  automationMode: string
  repositoryId: string
  sourceKind: string
  externalId: string | null
  deliveryKind: string
  employeeId: string | null
  blockCode: string | null
  terminalKind: string | null
  createdAt: number
  updatedAt: number
}

export function missionStatusKind(status: string): StatusChipKind {
  if (status === 'merged' || status === 'completed-no-change') return 'success'
  if (status === 'blocked' || status === 'failed') return 'danger'
  if (status === 'awaiting-information' || status === 'waiting-committer') return 'warn'
  if (status === 'canceled' || status === 'closed-unmerged') return 'neutral'
  return 'info'
}

export function missionStatusLabel(
  t: (key: string, options?: Record<string, unknown>) => string,
  status: string,
): string {
  const known = new Set([
    'admitting',
    'awaiting-information',
    'working',
    'publishing',
    'watching',
    'ready-to-merge',
    'waiting-committer',
    'blocked',
    'completed-no-change',
    'merged',
    'closed-unmerged',
    'canceled',
    'failed',
  ])
  return known.has(status) ? t(`code.missions.status.${status}`) : status
}
