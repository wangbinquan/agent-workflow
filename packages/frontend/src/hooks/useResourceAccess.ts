// RFC-324 — "what may I do with this resource?", for the pages that render it.
//
// Why a hook over `GET {base}/acl` rather than a field on each detail DTO:
// there are thirteen ACL resource types, so a `canEdit` on every detail
// response is thirteen parallel backend changes, thirteen serializers and
// thirteen sets of fixtures to keep in agreement — for one fact that the ACL
// endpoint already computes in one place.
//
// It deliberately does NOT share `AclPanel`'s query key, and that is a lesson
// paid for in an e2e failure. Sharing looks like a free win (one request for a
// page that also hosts the permissions dialog) right up until something has to
// INVALIDATE it: the `resource-acl.changed` frame arrives at the owner's own
// browser too, and an invalidation puts the shared entry into `fetching` —
// which trips `AclPanel`'s own "is my management session still live?" guard
// (it requires `fetchStatus === 'idle'`), so the owner's save silently stopped
// closing its dialog. Two consumers with different invalidation needs must not
// share one cache entry. The extra request is one GET on a page the actor is
// already authorized to read.
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
    // 独立于 AclPanel 的 `['acl', …]`——见文件头注释。
    queryKey: ['resource-access', aclUrl, authRevision] as const,
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
