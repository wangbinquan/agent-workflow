import type { OverviewTasks } from '@agent-workflow/shared'

import type { AuthenticatedAuthoritySnapshot } from '@/modules/identity-access/public/participants'

/**
 * Task Execution owns the public-task window the system overview shows. The adapter applies the exact
 * owner/collaborator visibility rule and never exposes a provider row or client to the aggregate.
 *
 * RFC-561: declared here instead of `public/queries` — the system overview names its task source with its own port and
 * bootstrap binds this query to it, so no other module reads this type.
 */
export interface TaskOverviewQuery {
  load(input: {
    readonly actor: AuthenticatedAuthoritySnapshot
    readonly since: number
  }): Promise<OverviewTasks>
}
