import { eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { hostedTaskWorkspaces } from '@/db/schema'
import { parseHostedWorkspaceReference } from './workspaceReference'

/** Volume owners are AW task ids (bare ULIDs) or namespaced shared owners
 * (`system:intent`, `development:shared`, `mcp-test:<session>`, …). A shared
 * owner's use is not covered by any task status, so the lifecycle reconciler
 * pauses it only after an idle period.
 *
 * Scratch owners (`system:…`, `mcp-test:…`) hold nothing but per-invocation
 * scratch. A CrewStation parent keeps the task image it was created with, so
 * their parent follows the running release instead: one created under another
 * release is replaced (RFC-370 hosted acceptance, 2026-10-17). Durable shared
 * owners such as `development:shared` keep theirs. */
export function hostedWorkspaceOwnerKind(owner: string): 'task' | 'shared' | 'scratch' {
  if (!owner.includes(':')) return 'task'
  return owner.startsWith('system:') || owner.startsWith('mcp-test:') ? 'scratch' : 'shared'
}

/** Native paths have no platform owner; malformed hosted references fail closed. */
export function hostedWorkspaceOwnerFromReference(reference: string): string | null {
  return reference.startsWith('cs-workspace:')
    ? parseHostedWorkspaceReference(reference).taskId
    : null
}

/** The AW task owning the volume of one CrewStation parent task, whatever its
 * workspace state (a recovery request names the platform's parent task). */
export async function readHostedWorkspaceOwnerForBusinessTask(
  db: ProviderNeutralDatabase,
  businessTaskId: string,
) {
  const [row] = await db
    .select({
      taskId: hostedTaskWorkspaces.taskId,
      businessTaskId: hostedTaskWorkspaces.businessTaskId,
      requestKey: hostedTaskWorkspaces.requestKey,
      state: hostedTaskWorkspaces.state,
    })
    .from(hostedTaskWorkspaces)
    .where(eq(hostedTaskWorkspaces.businessTaskId, businessTaskId))
    .limit(1)
  return row ?? null
}
