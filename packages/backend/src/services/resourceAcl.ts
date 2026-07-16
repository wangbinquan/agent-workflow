// RFC-099 — resource-level ownership ACL core.
//
// Six resource types (agent / skill / mcp / plugin / workflow / workgroup) carry
// owner_user_id + visibility ('private'|'public') columns plus per-user rows
// in resource_grants. This module is the single authority for "can this actor
// see / modify this resource":
//
//   - admins bypass everything. The bypass keys off `actor.user.role` (the
//     identity), NOT the resolved permission set — a PAT with narrowed scopes
//     still belongs to an admin and must not flip row visibility, only route
//     gates (auth/actor.ts buildActor narrows permissions, never the role).
//   - the daemon-token actor is the '__system__' admin, so the runner /
//     scheduler / opencode injection paths are structurally unaffected.
//   - non-granted non-admin users must not observe the resource at all:
//     list endpoints post-filter via filterVisibleRows, detail endpoints turn
//     "not visible" into a 404 (NOT 403 — a 403 would leak existence, D1).
//
// Role snapshots (D7/D17): resolveTaskRole computes the task-relationship
// role recorded on review comments / decisions / clarify submissions. Member
// identity wins over the global admin role.

import type {
  AclResourceType,
  ResourceAcl,
  ResourceVisibility,
  TaskActorRole,
  UpdateResourceAclBody,
  UserPublic,
} from '@agent-workflow/shared'
import { and, eq, inArray } from 'drizzle-orm'
import type { Actor } from '@/auth/actor'
import { SYSTEM_USER_ID } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import {
  agents,
  mcps,
  plugins,
  resourceGrants,
  skills,
  users,
  workflows,
  workgroups,
} from '@/db/schema'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'

/**
 * Minimal row shape every ACL check accepts; full resource rows AND mapped
 * DTOs superset it. The two ACL fields are optional so shared DTOs (which
 * declare them optional for fixture back-compat) plug in directly; absent
 * visibility means 'public' (the D2 legacy semantics) and absent owner means
 * "no owner yet" (admin-managed).
 */
export interface AclRow {
  id: string
  ownerUserId?: string | null
  visibility?: ResourceVisibility
  /** RFC-104 — built-in marker; present on agent/workflow DTOs, absent (→ not
   *  built-in) on skill/mcp/plugin rows. Read by assertNotBuiltin. */
  builtin?: boolean | null
}

/** Drizzle table per ACL resource type — used by routes to share generic helpers. */
export const ACL_TABLES = {
  agent: agents,
  skill: skills,
  mcp: mcps,
  plugin: plugins,
  workflow: workflows,
  workgroup: workgroups, // RFC-164
} as const

export function isAdminActor(actor: Actor): boolean {
  return actor.user.role === 'admin'
}

/** All resource ids of `type` granted to this user (one query; empty for admins — they don't need it). */
export async function listGrantedResourceIds(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
): Promise<Set<string>> {
  const rows = await db
    .select({ resourceId: resourceGrants.resourceId })
    .from(resourceGrants)
    .where(and(eq(resourceGrants.resourceType, type), eq(resourceGrants.userId, actor.user.id)))
  return new Set(rows.map((r) => r.resourceId))
}

/** Pure visibility predicate against a pre-fetched grant set. */
export function isVisibleRow(actor: Actor, row: AclRow, grantedIds: ReadonlySet<string>): boolean {
  if (isAdminActor(actor)) return true
  if ((row.visibility ?? 'public') === 'public') return true
  if (row.ownerUserId != null && row.ownerUserId === actor.user.id) return true
  return grantedIds.has(row.id)
}

/**
 * Post-filter a full list query down to what the actor may see. One grants
 * query per call; admins short-circuit without touching resource_grants.
 * (List endpoints in this codebase load full tables — system scale is small,
 * so a JS post-filter keeps the five routes uniform; see design §3.)
 */
export async function filterVisibleRows<T extends AclRow>(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  rows: readonly T[],
): Promise<T[]> {
  if (isAdminActor(actor)) return [...rows]
  const granted = await listGrantedResourceIds(db, actor, type)
  return rows.filter((r) => isVisibleRow(actor, r, granted))
}

/** Single-row visibility check (detail / reference sites). */
export async function canViewResource(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
): Promise<boolean> {
  if (isAdminActor(actor)) return true
  if ((row.visibility ?? 'public') === 'public') return true
  if (row.ownerUserId != null && row.ownerUserId === actor.user.id) return true
  const rows = await db
    .select({ resourceId: resourceGrants.resourceId })
    .from(resourceGrants)
    .where(
      and(
        eq(resourceGrants.resourceType, type),
        eq(resourceGrants.resourceId, row.id),
        eq(resourceGrants.userId, actor.user.id),
      ),
    )
    .limit(1)
  return rows.length > 0
}

/**
 * Detail-route gate: invisible → 404 (existence must not leak, D1).
 * Returns void so routes keep their own row object.
 */
export async function requireResourceView(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
): Promise<void> {
  if (await canViewResource(db, actor, type, row)) return
  throw new NotFoundError('not-found', `${type} not found`)
}

export function isResourceOwner(actor: Actor, row: AclRow): boolean {
  if (isAdminActor(actor)) return true
  return row.ownerUserId != null && row.ownerUserId === actor.user.id
}

/**
 * Write-route gate (modify / delete / ACL management): owner or admin.
 * A granted-but-not-owner user CAN see the resource, so a plain 403 here
 * leaks nothing new; an invisible caller still gets the view-404 first
 * (routes call requireResourceView before requireResourceOwner).
 */
export async function requireResourceOwner(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
): Promise<void> {
  await requireResourceView(db, actor, type, row)
  if (isResourceOwner(actor, row)) return
  throw new ForbiddenError('forbidden', `only the ${type} owner or an admin can modify it`)
}

/**
 * Task-relationship role snapshot (D7/D17) — member identity first:
 *   task owner → 'owner'; collaborator → 'user'; otherwise an admin acting
 *   from outside the membership → 'admin'; anyone else → null (caller must
 *   have rejected already).
 */
export function resolveTaskRole(
  actor: Actor,
  taskOwnerUserId: string | null,
  isMember: boolean,
): TaskActorRole | null {
  if (taskOwnerUserId !== null && taskOwnerUserId === actor.user.id) return 'owner'
  if (isMember) return 'user'
  if (isAdminActor(actor)) return 'admin'
  return null
}

// ---------------------------------------------------------------------------
// ACL management endpoints (GET/PUT /api/{res}/:key/acl)
// ---------------------------------------------------------------------------

type UserRow = typeof users.$inferSelect

function toUserPublic(row: UserRow): UserPublic {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
  }
}

/**
 * Build the GET /acl response. Caller has already passed requireResourceView;
 * member list is read-only-visible to every viewer (D16).
 */
export async function getResourceAcl(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
): Promise<ResourceAcl> {
  const table = ACL_TABLES[type]
  const revRows = await db
    .select({ aclRevision: table.aclRevision })
    .from(table)
    .where(eq(table.id, row.id))
    .limit(1)
  const aclRevision = revRows[0]?.aclRevision ?? 0
  const grantRows = await db
    .select()
    .from(resourceGrants)
    .where(and(eq(resourceGrants.resourceType, type), eq(resourceGrants.resourceId, row.id)))
  const grantIds = grantRows.map((g) => g.userId)
  const wantedIds = [...new Set([...(row.ownerUserId ? [row.ownerUserId] : []), ...grantIds])]
  const userRows =
    wantedIds.length === 0 ? [] : await db.select().from(users).where(inArray(users.id, wantedIds))
  const byId = new Map(userRows.map((u) => [u.id, u]))
  const ownerRow =
    row.ownerUserId != null && row.ownerUserId !== SYSTEM_USER_ID
      ? (byId.get(row.ownerUserId) ?? null)
      : null
  const grantUsers = grantIds
    .map((id) => byId.get(id))
    .filter((u): u is UserRow => u !== undefined)
    .map(toUserPublic)
  return {
    resourceType: type,
    resourceId: row.id,
    ownerUserId: row.ownerUserId ?? null,
    owner: ownerRow ? toUserPublic(ownerRow) : null,
    visibility: row.visibility ?? 'public',
    users: grantUsers,
    canManage: isResourceOwner(actor, row),
    aclRevision,
  }
}

/**
 * PUT /acl — owner/admin only. `userIds` is full-replace. On owner transfer
 * the previous owner is auto-appended to the grant list so they don't lock
 * themselves out of their own (now someone else's) resource. The new owner is
 * never materialised as a grant row (canViewResource short-circuits owners).
 */
export async function updateResourceAcl(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
  body: UpdateResourceAclBody,
  opts: { updatedAt?: number } = {},
): Promise<ResourceAcl> {
  await requireResourceOwner(db, actor, type, row)

  const referenced = new Set<string>(body.userIds ?? [])
  if (body.ownerUserId !== undefined) referenced.add(body.ownerUserId)

  const table = ACL_TABLES[type]
  const now = opts.updatedAt ?? Date.now()

  // RFC-170 §8 (G3-9/G5-P5): the OCC CAS, referenced-user active check, and the
  // prevOwner/grant assembly all run inside ONE write tx off an in-tx row
  // snapshot — so a stale `expectedAclRevision`, a concurrently-disabled user,
  // or a late owner transfer cannot slip a revoked grant / re-take ownership
  // through a check-then-write gap. Uses the synchronous drizzle surface (no
  // await inside dbTxSync).
  const updatedRow = dbTxSync<AclRow>(db, (tx) => {
    const cur = tx
      .select({
        aclRevision: table.aclRevision,
        ownerUserId: table.ownerUserId,
        visibility: table.visibility,
      })
      .from(table)
      .where(eq(table.id, row.id))
      .get()
    if (!cur) throw new NotFoundError('not-found', `${type} not found`)

    // Optional OCC preconditions (absent → legacy last-write-wins).
    if (body.expectedResourceId !== undefined && body.expectedResourceId !== row.id) {
      throw new ConflictError('acl-resource-mismatch', 'resource id changed; reload')
    }
    if (body.expectedAclRevision !== undefined && cur.aclRevision !== body.expectedAclRevision) {
      throw new ConflictError(
        'acl-revision-conflict',
        `acl revision is ${cur.aclRevision}, expected ${body.expectedAclRevision}; reload and retry`,
      )
    }

    // Referenced-user active check IN-tx (G5-P5).
    if (referenced.size > 0) {
      const urows = tx
        .select({ id: users.id, status: users.status })
        .from(users)
        .where(inArray(users.id, [...referenced]))
        .all()
      const activeSet = new Set(urows.filter((r) => r.status === 'active').map((r) => r.id))
      const bad = [...referenced].filter((id) => id === SYSTEM_USER_ID || !activeSet.has(id))
      if (bad.length > 0) {
        throw new ValidationError('acl-user-invalid', 'referenced user(s) not active', {
          userIds: bad,
        })
      }
    }

    const prevOwner = cur.ownerUserId ?? null
    const nextOwner = body.ownerUserId !== undefined ? body.ownerUserId : prevOwner
    const nextVisibility: ResourceVisibility =
      body.visibility !== undefined ? body.visibility : (cur.visibility ?? 'public')

    let nextGrantIds: string[]
    if (body.userIds !== undefined) {
      nextGrantIds = [...new Set(body.userIds)]
    } else {
      const current = tx
        .select({ userId: resourceGrants.userId })
        .from(resourceGrants)
        .where(and(eq(resourceGrants.resourceType, type), eq(resourceGrants.resourceId, row.id)))
        .all()
      nextGrantIds = current.map((g) => g.userId)
    }
    // Owner transfer keeps the previous human owner visible (server-side rule).
    if (
      nextOwner !== prevOwner &&
      prevOwner !== null &&
      prevOwner !== SYSTEM_USER_ID &&
      !nextGrantIds.includes(prevOwner)
    ) {
      nextGrantIds.push(prevOwner)
    }
    // The owner is never a grant row.
    nextGrantIds = nextGrantIds.filter((id) => id !== nextOwner)

    tx.update(table)
      .set({
        ownerUserId: nextOwner,
        visibility: nextVisibility,
        aclRevision: cur.aclRevision + 1, // monotonic bump on every successful PUT
        updatedAt: now,
      })
      .where(eq(table.id, row.id))
      .run()
    tx.delete(resourceGrants)
      .where(and(eq(resourceGrants.resourceType, type), eq(resourceGrants.resourceId, row.id)))
      .run()
    if (nextGrantIds.length > 0) {
      tx.insert(resourceGrants)
        .values(
          nextGrantIds.map((userId) => ({
            resourceType: type,
            resourceId: row.id,
            userId,
            addedBy: actor.user.id,
            addedAt: now,
          })),
        )
        .run()
    }
    return { id: row.id, ownerUserId: nextOwner, visibility: nextVisibility }
  })

  return getResourceAcl(db, actor, type, updatedRow)
}
