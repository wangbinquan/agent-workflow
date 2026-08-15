// RFC-099 — resource-level ownership ACL core.
//
// Six resource types (agent / skill / mcp / plugin / workflow / workgroup) carry
// owner_user_id + visibility ('private'|'public') columns plus per-user rows
// in resource_grants. This module is the single authority for "can this actor
// see / modify this resource":
//
//   - `resource-acl:bypass` bypasses row ACLs. RFC-305 deliberately keys this
//     off the resolved authority set, so roles remain presets rather than a
//     parallel authorization axis. PATs never carry this system-domain point.
//   - the daemon-token actor is the capability-bearing '__system__' account, so the runner /
//     scheduler / opencode injection paths are structurally unaffected.
//   - actors without a grant or ACL-bypass permission must not observe the resource at all:
//     list endpoints post-filter via filterVisibleRows, detail endpoints turn
//     "not visible" into a 404 (NOT 403 — a 403 would leak existence, D1).
//
// Role snapshots (D7/D17): resolveTaskRole computes the task-relationship
// role recorded on review comments / decisions / clarify submissions. Member
// task membership wins over global ACL-bypass authority.
//
// ── RFC-284 T12（§2.6）——六类资源的 OCC fence 选型对照（现状登记，非规范）──
//
// | 资源      | 机制                                        | 为什么是这个                          | 拒因子码现状 |
// | agent     | 行级 CAS：expectedUpdatedAt+expectedAclRevision | 无 version 列；ACL 与内容双轴各自演进   | resource-operation-stale；名字域 agent-name-in-use |
// | workflow  | version 列 CAS（PUT 自增）                   | 画布编辑器多标签并发是主场景            | resource-operation-stale（原 workflow-version-conflict，RFC-285 B5） |
// | workgroup | version 列 CAS                              | 同 workflow                          | resource-operation-stale（原 workgroup-version-conflict） |
// | skill     | contentVersion 内容围栏 + 覆写/重命名版本域   | 文件系统为真源，注入面须防换胎（RFC-178/223）| resource-operation-stale（原 skill-version-conflict/-overwrite-stale）/ skill-changed；名字域 skill-name-in-use（skills_owner_name_unique） |
// | mcp       | RFC-201 精确操作修订（mcpOperationRevision） | 操作对象是配置哈希而非整行             | resource-operation-stale 系 + 运行面 mcp-config-changed 族 |
// | plugin    | RFC-201 精确操作修订（pluginOperationRevision）| 同 mcp（generation 不可变）           | resource-operation-stale 系 |
//
// 另有启动预检的 preflight-stale（任务面，不属资源行 OCC）。**错误码横向不一致
// 是已知债**：stale 语义归一（直接切换 + 族外码入族）已拍板在 RFC-285（Q1+Q7），
// 本表只登记现状、不新造码。

import type {
  AclResourceType,
  ResourceAcl,
  ResourceVisibility,
  TaskActorRole,
  UpdateResourceAclBody,
  UserPublic,
} from '@agent-workflow/shared'
import { and, eq, inArray, ne } from 'drizzle-orm'
import type { Actor } from '@/auth/actor'
import { SYSTEM_USER_ID } from '@/auth/systemIdentity'
import type { DbClient } from '@/db/client'
import { type DbTxSync, dbTxSync } from '@/db/txSync'
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
import { triggerRevalidation } from '@/ws/revalidationHook'

/**
 * Minimal row shape every ACL check accepts; full resource rows AND mapped
 * DTOs superset it. The two ACL fields are optional so shared DTOs (which
 * declare them optional for fixture back-compat) plug in directly; absent
 * visibility means 'public' (the D2 legacy semantics) and absent owner means
 * "no owner yet" (platform-managed).
 */
export interface AclRow {
  id: string
  ownerUserId?: string | null
  visibility?: ResourceVisibility
  /** RFC-104 — built-in marker; present on agent/workflow DTOs, absent (→ not
   *  built-in) on skill/mcp/plugin rows. Read by assertNotBuiltin. */
  builtin?: boolean | null
}

/** RFC-231 product default for every newly-created user ACL resource. */
export const DEFAULT_USER_RESOURCE_VISIBILITY = 'private' as const

export function initialPrivateResourceAcl(ownerUserId: string | null): {
  ownerUserId: string | null
  visibility: typeof DEFAULT_USER_RESOURCE_VISIBILITY
  aclRevision: 0
} {
  return {
    ownerUserId,
    visibility: DEFAULT_USER_RESOURCE_VISIBILITY,
    aclRevision: 0,
  }
}

/** Framework-owned resources are deliberately discoverable and read-only. */
export function initialBuiltinResourceAcl(ownerUserId: string | null): {
  ownerUserId: string | null
  visibility: 'public'
  aclRevision: 0
} {
  return { ownerUserId, visibility: 'public', aclRevision: 0 }
}

/**
 * Bind an actor-backed create to the authenticated principal. HTTP payloads
 * never choose an owner; this assertion also rejects accidental ownerless
 * private rows on an authenticated create path.
 */
export function assertInitialResourceOwner(
  actor: Actor | null | undefined,
  ownerUserId: string | null,
): void {
  if (actor === null || actor === undefined || ownerUserId === actor.user.id) return
  throw new ValidationError(
    'resource-owner-mismatch',
    'resource owner must match the authenticated creator',
  )
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

/** RFC-223: these five resource types have owner-scoped display-name uniqueness.
 * Workflows deliberately remain non-unique; runtimes are not ACL resources. */
export const OWNER_NAME_UNIQUE_TYPES: ReadonlySet<AclResourceType> = new Set([
  'agent',
  'skill',
  'mcp',
  'plugin',
  'workgroup',
])

/** RFC-234/RFC-305 — cross-owner Intent audit is a dedicated permission. */
export function canAuditIntentSessions(actor: Actor): boolean {
  return actor.permissions.has('intent:audit')
}

/** Single source for the row-level resource ACL bypass. */
export function hasResourceAclBypass(actor: Actor): boolean {
  return actor.permissions.has('resource-acl:bypass')
}

/** The one WHERE shape for "all grants of `type` for this user" — both the
 *  async and the in-tx variant below build from it (RFC-282 D2: the grant-set
 *  query exists once; importRefs used to carry a literal copy). */
function grantsOfUserWhere(type: AclResourceType, userId: string) {
  return and(eq(resourceGrants.resourceType, type), eq(resourceGrants.userId, userId))
}

/** All resource ids of `type` granted to this user (ACL-bypass actors do not need the result). */
export async function listGrantedResourceIds(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
): Promise<Set<string>> {
  const rows = await db
    .select({ resourceId: resourceGrants.resourceId })
    .from(resourceGrants)
    .where(grantsOfUserWhere(type, actor.user.id))
  return new Set(rows.map((r) => r.resourceId))
}

/** Sync twin of `listGrantedResourceIds` for services already inside dbTxSync.
 *  Same contract: callers short-circuit actors with `resource-acl:bypass`. */
export function listGrantedResourceIdsInTx(
  tx: DbTxSync,
  actor: Actor,
  type: AclResourceType,
): Set<string> {
  const rows = tx
    .select({ resourceId: resourceGrants.resourceId })
    .from(resourceGrants)
    .where(grantsOfUserWhere(type, actor.user.id))
    .all()
  return new Set(rows.map((r) => r.resourceId))
}

/** RFC-284 T10（§2.3）——by-resource 半边：与 grantsOfUserWhere 对称的唯一
 *  WHERE 形状。此前五处（本文件 ×2、workflow / workgroups 删除审计受众、
 *  mcpRuntimeTestTransitions 的 grant 集）各写一份字面 and(eq,eq)。 */
export function grantsOfResourceWhere(type: AclResourceType, resourceId: string) {
  return and(eq(resourceGrants.resourceType, type), eq(resourceGrants.resourceId, resourceId))
}

/** All granted user ids of one resource（audience 快照 / 成员清单用）。 */
export async function listResourceGrantUserIds(
  db: DbClient,
  type: AclResourceType,
  resourceId: string,
): Promise<string[]> {
  const rows = await db
    .select({ userId: resourceGrants.userId })
    .from(resourceGrants)
    .where(grantsOfResourceWhere(type, resourceId))
  return rows.map((r) => r.userId)
}

/** Sync twin of `listResourceGrantUserIds` for services already inside dbTxSync. */
export function listResourceGrantUserIdsInTx(
  tx: DbTxSync,
  type: AclResourceType,
  resourceId: string,
): string[] {
  return tx
    .select({ userId: resourceGrants.userId })
    .from(resourceGrants)
    .where(grantsOfResourceWhere(type, resourceId))
    .all()
    .map((r) => r.userId)
}

/**
 * RFC-284 T10（§2.4）——「快照式受众可见性」唯一判定：对一份 DELETE 前捕获的
 * （或事务内自建的）{visibility, ownerUserId, grantedUserIds} 快照判某用户可见。
 * 含显式 ACL bypass 分支——ws/registry 的 deleted-audience 两处此前
 * 不带 bypass 分支、其正确性非局部依赖上游 aclBypassShortCircuit；收编后上游
 * 捷径退化为纯性能优化。mcpRuntimeTestTransitions 的 status==='active' 检查按
 * 设计留在调用方（本函数只答"可见性"，不答"账号是否存活"）。
 */
export function isVisibleToAudienceSnapshot(
  userId: string,
  resourceAclBypass: boolean,
  snapshot: {
    visibility: 'public' | 'private'
    ownerUserId: string | null
    grantedUserIds: ReadonlySet<string>
  },
): boolean {
  if (resourceAclBypass) return true
  if (snapshot.visibility === 'public') return true
  if (snapshot.ownerUserId !== null && snapshot.ownerUserId === userId) return true
  return snapshot.grantedUserIds.has(userId)
}

/** Pure visibility predicate against a pre-fetched grant set. */
export function isVisibleRow(actor: Actor, row: AclRow, grantedIds: ReadonlySet<string>): boolean {
  if (hasResourceAclBypass(actor)) return true
  if ((row.visibility ?? 'public') === 'public') return true
  if (row.ownerUserId != null && row.ownerUserId === actor.user.id) return true
  return grantedIds.has(row.id)
}

/** RFC-203 T6 — delete/rename refusal details, principal-aware (the
 *  deleteWorkflow precedent): names only for referencing resources the actor
 *  may see, everything else an aggregate count. The frontend <ErrorDetails>
 *  renders exactly this shape ({visible[], hiddenCount}); the legacy bare
 *  arrays it renders count-only (ACL iron rule). */
export interface DisclosedRefs {
  visible: Array<{ id: string; name: string }>
  hiddenCount: number
}

/** Sync core — dbTxSync guard blocks use this with a grant set pre-fetched
 *  OUTSIDE the transaction (grants are disclosure control, not the refusal
 *  decision itself, so a stale set is harmless). */
export function discloseRefsSync(
  actor: Actor,
  rows: ReadonlyArray<AclRow & { name: string }>,
  grantedIds: ReadonlySet<string>,
): DisclosedRefs {
  const visible = rows.filter((r) => isVisibleRow(actor, r, grantedIds))
  return {
    visible: visible.map((r) => ({ id: r.id, name: r.name })),
    hiddenCount: rows.length - visible.length,
  }
}

/** Async convenience for non-transactional refusal sites. */
export async function discloseRefs(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  rows: ReadonlyArray<AclRow & { name: string }>,
): Promise<DisclosedRefs> {
  const granted = hasResourceAclBypass(actor)
    ? new Set<string>()
    : await listGrantedResourceIds(db, actor, type)
  return discloseRefsSync(actor, rows, granted)
}

/** Schedules are member-private (owner + `tasks:read:all`), not an
 *  ACL_TABLES resource — mirror the deleteWorkflow precedent for
 *  *-scheduled-referenced refusals. */
export function discloseScheduleRefs(
  actor: Actor,
  rows: ReadonlyArray<{ id: string; name: string; ownerUserId: string }>,
): DisclosedRefs {
  const canSeeAll = actor.permissions.has('tasks:read:all' as never)
  const visible = rows.filter((r) => canSeeAll || r.ownerUserId === actor.user.id)
  return {
    visible: visible.map((r) => ({ id: r.id, name: r.name })),
    hiddenCount: rows.length - visible.length,
  }
}

/**
 * Post-filter a full list query down to what the actor may see. One grants
 * query per call; actors with `resource-acl:bypass` short-circuit without touching resource_grants.
 * (List endpoints in this codebase load full tables — system scale is small,
 * so a JS post-filter keeps the five routes uniform; see design §3.)
 */
export async function filterVisibleRows<T extends AclRow>(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  rows: readonly T[],
): Promise<T[]> {
  if (hasResourceAclBypass(actor)) return [...rows]
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
  if (hasResourceAclBypass(actor)) return true
  if ((row.visibility ?? 'public') === 'public') return true
  if (row.ownerUserId != null && row.ownerUserId === actor.user.id) return true
  const rows = await db
    .select({ resourceId: resourceGrants.resourceId })
    .from(resourceGrants)
    .where(and(grantsOfResourceWhere(type, row.id), eq(resourceGrants.userId, actor.user.id)))
    .limit(1)
  return rows.length > 0
}

/** Fresh synchronous visibility oracle for services already inside dbTxSync. */
export function canViewResourceInTx(
  tx: DbTxSync,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
): boolean {
  if (hasResourceAclBypass(actor)) return true
  if ((row.visibility ?? 'public') === 'public') return true
  if (row.ownerUserId != null && row.ownerUserId === actor.user.id) return true
  return (
    tx
      .select({ resourceId: resourceGrants.resourceId })
      .from(resourceGrants)
      .where(and(grantsOfResourceWhere(type, row.id), eq(resourceGrants.userId, actor.user.id)))
      .get() !== undefined
  )
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
  if (hasResourceAclBypass(actor)) return true
  return row.ownerUserId != null && row.ownerUserId === actor.user.id
}

/**
 * Write-route gate (modify / delete / ACL management): owner or ACL bypass.
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
  throw new ForbiddenError(
    'forbidden',
    `only the ${type} owner or an actor with resource-acl:bypass can modify it`,
  )
}

/**
 * Task-relationship role snapshot (D7/D17) — member identity first:
 *   task owner → 'owner'; collaborator → 'user'; otherwise only a resource ACL
 *   operator may bypass membership. One that also has `users:write` is
 *   attributed as 'admin'; every other bypass holder is attributed as
 *   'manager'. These legacy audit labels are derived from permissions, not the
 *   account role preset;
 *   anyone else → null (caller must have rejected already).
 */
export function resolveTaskRole(
  actor: Actor,
  taskOwnerUserId: string | null,
  isMember: boolean,
): TaskActorRole | null {
  if (taskOwnerUserId !== null && taskOwnerUserId === actor.user.id) return 'owner'
  if (isMember) return 'user'
  if (!hasResourceAclBypass(actor)) return null
  return actor.permissions.has('users:write') ? 'admin' : 'manager'
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
  const grantIds = await listResourceGrantUserIds(db, type, row.id)
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
 * PUT /acl — owner or `resource-acl:bypass`. `userIds` is full-replace. On owner transfer
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
  opts: {
    updatedAt?: number
    afterWriteInTx?: (
      tx: DbTxSync,
      change: {
        resourceId: string
        ownerUserId: string | null
        visibility: ResourceVisibility
        grantedUserIds: ReadonlySet<string>
        now: number
      },
    ) => void
  } = {},
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
        name: table.name,
        ownerUserId: table.ownerUserId,
        visibility: table.visibility,
      })
      .from(table)
      .where(eq(table.id, row.id))
      .get()
    if (!cur) throw new NotFoundError('not-found', `${type} not found`)

    // Route authorization is only an early UX check. The row may have changed
    // owner/visibility/grants before this write transaction began, so the
    // transaction must authorize the actor again from its own fresh snapshot.
    if (!canViewResourceInTx(tx, actor, type, { id: row.id, ...cur })) {
      throw new NotFoundError('not-found', `${type} not found`)
    }

    // Compare the mandatory immutable-id + revision fence only after the
    // fresh visibility check. A caller who lost visibility during the race
    // must receive the same 404 as any other invisible caller, not a revision
    // oracle that confirms the row still exists.
    if (body.expectedResourceId !== row.id) {
      throw new ConflictError('acl-resource-mismatch', 'resource id changed; reload')
    }
    if (cur.aclRevision !== body.expectedAclRevision) {
      throw new ConflictError(
        'acl-revision-conflict',
        `acl revision is ${cur.aclRevision}, expected ${body.expectedAclRevision}; reload and retry`,
      )
    }

    if (!hasResourceAclBypass(actor) && cur.ownerUserId !== actor.user.id) {
      throw new ForbiddenError(
        'forbidden',
        `only the ${type} owner or an actor with resource-acl:bypass can modify it`,
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

    if (nextOwner !== prevOwner && nextOwner !== null && OWNER_NAME_UNIQUE_TYPES.has(type)) {
      const collision = tx
        .select({ id: table.id })
        .from(table)
        .where(
          and(eq(table.ownerUserId, nextOwner), eq(table.name, cur.name), ne(table.id, row.id)),
        )
        .get()
      if (collision !== undefined) {
        throw new ConflictError(
          'resource-name-conflict',
          `${type} '${cur.name}' already exists for the target owner`,
          { resourceType: type, name: cur.name, ownerUserId: nextOwner },
        )
      }
    }

    let nextGrantIds: string[]
    if (body.userIds !== undefined) {
      nextGrantIds = [...new Set(body.userIds)]
    } else {
      nextGrantIds = listResourceGrantUserIdsInTx(tx, type, row.id)
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

    try {
      tx.update(table)
        .set({
          ownerUserId: nextOwner,
          visibility: nextVisibility,
          aclRevision: cur.aclRevision + 1, // monotonic bump on every successful PUT
          updatedAt: now,
        })
        .where(eq(table.id, row.id))
        .run()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (
        nextOwner !== prevOwner &&
        OWNER_NAME_UNIQUE_TYPES.has(type) &&
        /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE|constraint failed/i.test(message)
      ) {
        throw new ConflictError(
          'resource-name-conflict',
          `${type} '${cur.name}' already exists for the target owner`,
          { resourceType: type, name: cur.name, ownerUserId: nextOwner },
        )
      }
      throw error
    }
    tx.delete(resourceGrants).where(grantsOfResourceWhere(type, row.id)).run()
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
    opts.afterWriteInTx?.(tx, {
      resourceId: row.id,
      ownerUserId: nextOwner,
      visibility: nextVisibility,
      grantedUserIds: new Set(nextGrantIds),
      now,
    })
    return { id: row.id, ownerUserId: nextOwner, visibility: nextVisibility }
  })

  // RFC-212 — AFTER commit: a grant may have been revoked or the resource made
  // private, so WS channels that surface this resource must re-check.
  triggerRevalidation(db, 'resource-acl-changed')

  return getResourceAcl(db, actor, type, updatedRow)
}
