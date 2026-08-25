// RFC-324 — "what may I do with this resource?", for the pages that render it.
//
// Why a hook over `GET {base}/acl` rather than a field on each detail DTO:
// there are thirteen ACL resource types, so a `canEdit` on every detail
// response is thirteen parallel backend changes, thirteen serializers and
// thirteen sets of fixtures to keep in agreement — for one fact that the ACL
// endpoint already computes in one place. This shares `AclPanel`'s exact query
// key, so a page that also hosts the permissions dialog pays for ONE request,
// and both collapse to the same cache entry when `resource-acl-changed`
// invalidates it (that is what makes a live downgrade land on the page without
// a reload).
//
// Unresolved is OPTIMISTIC, and that is a deliberate reversal of the first cut.
//
// Failing closed while the ACL is in flight reads safer, but it invents a
// failure mode that did not exist: a flaky `/acl` response would leave an OWNER
// staring at their own resource in read-only, with no way to tell why. Failing
// open degrades to exactly today's behaviour instead — the UI is interactive and
// the backend refuses the write — which is no worse than the status quo for a
// reader and strictly better for the owner. In practice the verdict lands in
// milliseconds, because the page is already authorized to read this resource and
// the ACL endpoint takes the same `{res}:read` point the page itself did.
//
// The one thing that must NOT ride on the optimistic value is an automatic
// write. `workflows.edit.tsx` fires a compatibility-heal save on load without
// any user gesture; that path is gated on `isResolved && canEdit`, so a
// read-only viewer never emits the PUT that `docs/audit-backlog.md:489-499`
// recorded as "opens the editor, immediately eats a 403 saying it may have been
// deleted". Interactive controls read `canEdit`; unattended writes read both.

import { useQuery } from '@tanstack/react-query'
import type { ResourceAcl } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { useActor, useAuthSessionRevision } from '@/hooks/useActor'

export interface ResourceAccessState {
  /**
   * May the current actor change this resource's content? Optimistic `true`
   * until the verdict arrives — see the header note. Fine for enabling
   * controls; NOT sufficient to authorize an unattended write.
   */
  canEdit: boolean
  /** May they change the ACL itself (owner / `resource-acl:bypass`)? Same optimism. */
  canManage: boolean
  /** True once the server verdict is in hand. Unattended writes must check this. */
  isResolved: boolean
}

/**
 * @param resourceBaseUrl e.g. `/api/workflows/01J…`; pass null to stay idle
 *        (a detail page mounts before its id resolves).
 */
export function useResourceAccess(resourceBaseUrl: string | null): ResourceAccessState {
  const actor = useActor()
  const authRevision = useAuthSessionRevision()
  const aclUrl = resourceBaseUrl === null ? null : `${resourceBaseUrl}/acl`
  const actorSettled =
    actor.status === 'success' &&
    actor.fetchStatus === 'idle' &&
    actor.data !== null &&
    actor.data !== undefined
  // Single-user daemon mode (RFC-099 D19): there are no other principals, so
  // there is no ACL to consult and nothing to lock down. Matches AclPanel,
  // which hides itself entirely under the daemon token.
  const isDaemon = actorSettled && actor.data?.source === 'daemon'

  const query = useQuery<ResourceAcl>({
    queryKey: ['acl', aclUrl, authRevision] as const,
    queryFn: ({ signal }) => api.get(aclUrl as string, undefined, signal),
    enabled: aclUrl !== null && actorSettled && !isDaemon,
  })

  if (isDaemon) return { canEdit: true, canManage: true, isResolved: true }
  const acl = query.data
  // Only a real boolean counts as a verdict. Anything else — no response yet, an
  // error, or a payload without the field — stays optimistic-but-unresolved, so
  // a shape that isn't actually an ACL can never silently lock a page down.
  if (typeof acl?.canEdit !== 'boolean' || typeof acl.canManage !== 'boolean') {
    return { canEdit: true, canManage: true, isResolved: false }
  }
  return { canEdit: acl.canEdit, canManage: acl.canManage, isResolved: true }
}
