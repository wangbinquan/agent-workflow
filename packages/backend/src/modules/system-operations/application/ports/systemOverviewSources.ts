// RFC-561 — the five sources the system overview assembles, declared with this module's own types. Bootstrap hands over
// each owner's query (the same objects as before), so system-operations names no other business context.
import type { MemorySummary, OverviewResources, OverviewTasks } from '@agent-workflow/shared'

import type { AuthenticatedAuthoritySnapshot } from '@/modules/identity-access/public/participants'
import type { SystemOverviewAuthority } from '../../public/queries'

/** The six resource kinds the overview counts; a kind the requester may not list is `null`. */
export type SystemOverviewResourceCounts = Pick<
  OverviewResources,
  'agents' | 'skills' | 'mcps' | 'plugins' | 'workflows' | 'workgroups'
>

/** Resource rows the requester would see on each list page. */
export interface SystemOverviewResourceSource {
  load(requester: AuthenticatedAuthoritySnapshot): Promise<SystemOverviewResourceCounts>
}

/** Cached repositories; the overview asks only when the requester may list repositories. */
export interface SystemOverviewRepositorySource {
  countCachedRepositories(): Promise<number>
}

/** Scheduled tasks the requester would see; `null` when the requester may not list them. */
export interface SystemOverviewScheduledTaskSource {
  countScheduled(requester: AuthenticatedAuthoritySnapshot): Promise<number | null>
}

/** The memory catalog's approved rows and its visibility filter; the overview counts what stays visible. */
export interface SystemOverviewMemorySource {
  readonly queries: {
    list(filter: { readonly status: 'approved' }): Promise<readonly MemorySummary[]>
    filterVisible(
      requester: SystemOverviewAuthority,
      rows: readonly MemorySummary[],
    ): Promise<readonly unknown[]>
  }
}

/** Task counters over the requester's visible tasks; the terminal ones count from `since`. */
export interface SystemOverviewTaskSource {
  load(input: {
    readonly actor: AuthenticatedAuthoritySnapshot
    readonly since: number
  }): Promise<OverviewTasks>
}

export interface SystemOverviewSources {
  readonly resourceCatalog: SystemOverviewResourceSource
  readonly repositories: SystemOverviewRepositorySource
  readonly integration: SystemOverviewScheduledTaskSource
  readonly memories: SystemOverviewMemorySource
  readonly tasks: SystemOverviewTaskSource
}
