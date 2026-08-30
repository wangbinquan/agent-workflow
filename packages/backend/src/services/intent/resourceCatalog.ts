// RFC-235 v22 — actor-filtered resource labels for mounted-context and
// agent-suggested mount resolution. This is a display/selection projection;
// final approval still rechecks ACL in the write transaction.

import type { AclResourceType } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { listAllVisibleResourceSummariesForActor } from '@/modules/resource-catalog/infrastructure/sqliteCatalogQuery'

export interface IntentVisibleResource {
  resourceType: AclResourceType
  resourceId: string
  name: string
  description: string | null
}

export async function listVisibleIntentResources(
  db: DbClient,
  actor: Actor,
): Promise<IntentVisibleResource[]> {
  return (await listAllVisibleResourceSummariesForActor(db, actor)).map((summary) => ({
    resourceType: summary.kind,
    resourceId: summary.ref.id,
    name: summary.name,
    description: summary.description,
  }))
}
