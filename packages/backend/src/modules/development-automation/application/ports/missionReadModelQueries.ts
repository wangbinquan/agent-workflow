import type { TaskListView, TaskStatus } from '@agent-workflow/shared'

export interface MissionSummaryProjection {
  readonly id: string
  readonly revision: number
  readonly status: string
  readonly automationMode: string
  readonly transitionFence: string
  readonly repositoryId: string
  readonly sourceKind: string
  readonly externalId: string | null
  readonly resolvedSourceKey: string | null
  readonly deliveryKind: string
  readonly employeeId: string | null
  readonly employeeRevision: number | null
  readonly policyId: string | null
  readonly policyRevision: number | null
  readonly blockCode: string | null
  readonly terminalKind: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface MissionPageCursor {
  readonly createdAt: number
  readonly id: string
}

export interface MissionPageFilters {
  readonly view?: TaskListView
  readonly statuses?: readonly TaskStatus[]
  readonly q?: string
  readonly employeeId?: string
  readonly missionStatuses?: readonly string[]
}

export interface MissionPageProjection {
  readonly items: readonly MissionSummaryProjection[]
  readonly nextCursor: MissionPageCursor | null
  readonly facets: {
    readonly all: number
    readonly active: number
    readonly attention: number
    readonly finished: number
  }
  readonly counts: Readonly<Record<string, number>>
}

export interface MissionDetailProjection extends MissionSummaryProjection {
  readonly sources: readonly unknown[]
  readonly readiness: unknown
  readonly blockDetail: string | null
}

export interface MissionMergeRequestProjection {
  readonly iid: string
  readonly state: string
  readonly href: string | null
}

export interface MissionReadModelQueries {
  list(): Promise<readonly MissionSummaryProjection[]>
  listPage(
    input: { readonly limit: number; readonly cursor?: MissionPageCursor } & MissionPageFilters,
  ): Promise<MissionPageProjection>
  terminalOutcomeGroups(): Promise<
    readonly {
      readonly employeeId: string
      readonly terminalKind: string
      readonly count: number
    }[]
  >
  detail(missionId: string): Promise<MissionDetailProjection | null>
  mergeRequest(
    missionId: string,
    repositoryId: string,
  ): Promise<MissionMergeRequestProjection | null>
  effects(missionId: string): Promise<readonly unknown[]>
  decisionTrace(missionId: string): Promise<readonly unknown[]>
}
