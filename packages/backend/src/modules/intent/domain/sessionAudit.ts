// RFC-466 — Intent's audit visibility policy: an actor holding `intent:audit` sees every intent session. It sat in
// `public/operations` only because the retired `services/resourceAcl.ts` facade re-exported it; every remaining caller
// is this module's own code, so it lives in the domain (RFC-294 design §3.3: no outside consumer, not public). The
// rest of that file (four type re-exports of the apply port) had no importer either, so the file is gone.
import type { Permission } from '@agent-workflow/shared'

/** Intent owns its audit visibility policy; Resource Catalog has no role in it. */
export function canAuditIntentSessions(actor: {
  readonly permissions: ReadonlySet<Permission>
}): boolean {
  return actor.permissions.has('intent:audit')
}
