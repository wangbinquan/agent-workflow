// RFC-167 — dynamic workflow space service: CRUD on `dynamic_workflow_spaces`
// (the SEVENTH ACL resource). DB is source of truth; the `agent_pool_json`
// column is (un)marshaled into a `string[]` agentPool at this boundary. Name
// uniqueness is enforced by the column index AND an explicit pre-insert lookup
// for a friendly ConflictError (same shape as services/workgroups.ts).
//
// Pool semantics (design §1.1):
//   - agent names are SOFT references (dangling tolerated until launch, same as
//     a workflow node's agentName). Save-time reference-usability (RFC-099 D15)
//     is the ROUTE's job via assertNewRefsUsable — this service owns only
//     existence/shape and de-dupes the stored pool for a clean value.
//   - save-lenient: an empty pool is a valid quick-create; the non-empty +
//     all-resolvable requirement is enforced at LAUNCH (engine PR), not here.
//   - no task-side / scheduled guard on delete/rename: v1 has no scheduled
//     launch kind for dynamic-workflow spaces, and launched tasks snapshot their
//     own dwspace_config (durable-soft-link philosophy, design §1.2).

import type {
  AgentPool,
  CreateDynamicWorkflowSpace,
  DynamicWorkflowSpace,
  UpdateDynamicWorkflowSpace,
} from '@agent-workflow/shared'
import { AgentPoolSchema } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { dynamicWorkflowSpaces } from '@/db/schema'
import { ConflictError, NotFoundError } from '@/util/errors'

type SpaceRow = typeof dynamicWorkflowSpaces.$inferSelect

/** De-dupe pool names preserving first-seen order (the pool is a candidate SET;
 *  a duplicate name is redundant, not an error — reuse happens per workflow node). */
function dedupePool(names: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of names) {
    if (seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out
}

/** Parse the agent_pool_json column, dropping malformed values → []. */
function parsePoolColumn(value: string | null | undefined): AgentPool {
  if (value === null || value === undefined || value === '') return []
  try {
    const parsed = AgentPoolSchema.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

function rowToDynamicWorkflowSpace(row: SpaceRow): DynamicWorkflowSpace {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    agentPool: parsePoolColumn(row.agentPoolJson),
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    schemaVersion: row.schemaVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function listDynamicWorkflowSpaces(db: DbClient): Promise<DynamicWorkflowSpace[]> {
  const rows = await db.select().from(dynamicWorkflowSpaces)
  return rows.map(rowToDynamicWorkflowSpace)
}

export async function getDynamicWorkflowSpace(
  db: DbClient,
  name: string,
): Promise<DynamicWorkflowSpace | null> {
  const rows = await db
    .select()
    .from(dynamicWorkflowSpaces)
    .where(eq(dynamicWorkflowSpaces.name, name))
    .limit(1)
  const row = rows[0]
  return row ? rowToDynamicWorkflowSpace(row) : null
}

export async function createDynamicWorkflowSpace(
  db: DbClient,
  input: CreateDynamicWorkflowSpace,
  aclOpts?: { ownerUserId?: string },
): Promise<DynamicWorkflowSpace> {
  if ((await getDynamicWorkflowSpace(db, input.name)) !== null) {
    throw new ConflictError(
      'dynamic-workflow-space-name-in-use',
      `dynamic workflow space '${input.name}' already exists`,
    )
  }
  const id = ulid()
  const now = Date.now()
  await db.insert(dynamicWorkflowSpaces).values({
    id,
    name: input.name,
    description: input.description,
    agentPoolJson: JSON.stringify(dedupePool(input.agentPool)),
    // RFC-099: creator becomes owner; new resources default to 'public' (D18).
    ownerUserId: aclOpts?.ownerUserId ?? null,
    visibility: 'public',
    createdAt: now,
    updatedAt: now,
  })
  const created = await getDynamicWorkflowSpace(db, input.name)
  if (created === null) throw new Error('dynamic workflow space disappeared right after insert')
  return created
}

export async function updateDynamicWorkflowSpace(
  db: DbClient,
  name: string,
  patch: UpdateDynamicWorkflowSpace,
): Promise<DynamicWorkflowSpace> {
  const existing = await getDynamicWorkflowSpace(db, name)
  if (existing === null) {
    throw new NotFoundError(
      'dynamic-workflow-space-not-found',
      `dynamic workflow space '${name}' not found`,
    )
  }
  const set: Partial<typeof dynamicWorkflowSpaces.$inferInsert> = { updatedAt: Date.now() }
  if (patch.description !== undefined) set.description = patch.description
  if (patch.agentPool !== undefined) set.agentPoolJson = JSON.stringify(dedupePool(patch.agentPool))
  await db.update(dynamicWorkflowSpaces).set(set).where(eq(dynamicWorkflowSpaces.name, name))
  const updated = await getDynamicWorkflowSpace(db, name)
  if (updated === null) throw new Error('dynamic workflow space disappeared after update')
  return updated
}

export async function deleteDynamicWorkflowSpace(db: DbClient, name: string): Promise<void> {
  const existing = await getDynamicWorkflowSpace(db, name)
  if (existing === null) {
    throw new NotFoundError(
      'dynamic-workflow-space-not-found',
      `dynamic workflow space '${name}' not found`,
    )
  }
  await db.delete(dynamicWorkflowSpaces).where(eq(dynamicWorkflowSpaces.name, name))
}

export async function renameDynamicWorkflowSpace(
  db: DbClient,
  oldName: string,
  newName: string,
): Promise<DynamicWorkflowSpace> {
  const existing = await getDynamicWorkflowSpace(db, oldName)
  if (existing === null) {
    throw new NotFoundError(
      'dynamic-workflow-space-not-found',
      `dynamic workflow space '${oldName}' not found`,
    )
  }
  if (newName === oldName) return existing
  if ((await getDynamicWorkflowSpace(db, newName)) !== null) {
    throw new ConflictError(
      'dynamic-workflow-space-name-in-use',
      `dynamic workflow space '${newName}' already exists; pick a different name`,
    )
  }
  await db
    .update(dynamicWorkflowSpaces)
    .set({ name: newName, updatedAt: Date.now() })
    .where(eq(dynamicWorkflowSpaces.name, oldName))
  const renamed = await getDynamicWorkflowSpace(db, newName)
  if (renamed === null) throw new Error('dynamic workflow space disappeared after rename')
  return renamed
}

/** New pool agent names in `next` not already in `prev` — the D15 ref-usability
 *  input the route feeds to assertNewRefsUsable (only NEWLY-added refs re-checked). */
export function diffNewPoolAgentNames(
  prev: Pick<DynamicWorkflowSpace, 'agentPool'> | null,
  nextPool: readonly string[],
): string[] {
  const prevNames = new Set(prev?.agentPool ?? [])
  const out = new Set<string>()
  for (const n of nextPool) {
    if (n.length > 0 && !prevNames.has(n)) out.add(n)
  }
  return [...out]
}
