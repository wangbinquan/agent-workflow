import type { OverviewResponse } from '@agent-workflow/shared'

import type {
  SystemOverviewAuthority,
  SystemOverviewQuery,
} from '@/modules/system-operations/public/queries'
import { createInFlightCoalescer } from '@/platform/contracts/inFlight'
import type { SystemOverviewSources } from './ports/systemOverviewSources'

const WINDOW_7D_MS = 7 * 86_400_000

function flightKey(authority: SystemOverviewAuthority): string {
  const actor = authority.actor
  return JSON.stringify([
    actor.user.id,
    actor.source,
    actor.authorityRevision ?? 0,
    [...actor.permissions].sort(),
  ])
}

// RFC-561: the five sources are this module's own ports (`ports/systemOverviewSources.ts`); bootstrap binds the owners' queries.
export function composeSystemOverviewQuery(
  input: SystemOverviewSources & { readonly now?: () => number },
): SystemOverviewQuery {
  const now = input.now ?? Date.now
  const flights = createInFlightCoalescer<string, OverviewResponse>()

  const load = async (authority: SystemOverviewAuthority): Promise<OverviewResponse> => {
    const actor = authority.actor
    const capturedAt = now()
    const canReadTasks =
      actor.permissions.has('tasks:read:all') || actor.permissions.has('tasks:read:own')
    const [catalog, repos, scheduled, memories, tasks] = await Promise.all([
      input.resourceCatalog.load(actor),
      actor.permissions.has('repos:read')
        ? input.repositories.countCachedRepositories()
        : Promise.resolve(null),
      input.integration.countScheduled(actor),
      actor.permissions.has('memory:read')
        ? (async () => {
            const approved = await input.memories.queries.list({ status: 'approved' })
            return (
              await input.memories.queries.filterVisible(
                { actor, authority: authority.authority },
                approved,
              )
            ).length
          })()
        : Promise.resolve(null),
      canReadTasks
        ? input.tasks.load({ actor, since: capturedAt - WINDOW_7D_MS })
        : Promise.resolve(null),
    ])

    return Object.freeze({
      resources: Object.freeze({
        ...catalog,
        repos,
        scheduled,
        memories,
      }),
      tasks,
      generatedAt: new Date(capturedAt).toISOString(),
    })
  }

  return Object.freeze({
    execute(authority: SystemOverviewAuthority) {
      // Injected clocks define independent observations in boundary tests.
      if (input.now !== undefined) return load(authority)
      return flights(flightKey(authority), () => load(authority))
    },
  })
}
