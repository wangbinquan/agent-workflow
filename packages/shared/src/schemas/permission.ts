// RFC-036 — permission catalog. Routes declare the points they need in their
// `registerRoute` metadata (backend routes/registry.ts) and the framework
// derives the gate from that declaration; roles are mapped to permission sets
// via ROLE_PERMISSIONS. To add a new role (auditor / viewer / team_lead etc.)
// we only add a new key to ROLE_PERMISSIONS — business code does not key off
// the role string.
//
// RFC-222 — third role `manager` (中文「资源管理员」): manager = admin minus
// user management, system settings/ops, and task deletion. It gets every
// resource-domain capability (row-level ACL bypass lives in the identity
// predicate isResourceAdminRole below, NOT in a permission point) plus the
// coarse route points repos:* / tasks:read:all.
//
// RFC-247 — the `资源:write` point is GONE. It used to cover POST/PUT/PATCH/
// DELETE alike (the `resourcePermissionGate` middleware, since deleted along
// with the whole legacy `backend/src/auth/permissions.ts` layer), which made
// "can modify but not delete" and "can create but not modify" inexpressible —
// exactly what a self-issued API token needs to express. Every matrix-domain
// resource now carries explicit `:create` / `:update` / `:delete` / `:execute`
// points, derived FROM THE REAL ROUTE INVENTORY rather than symmetrically
// filled in per resource type. Three verbs are deliberately absent because no
// route implements them (a startup self-check enforces this — see
// design/RFC-247-mcp-remote-access/design.md §3.2):
//
//   - `skills:execute`    — routes/skills.ts has no execute-semantics route
//   - `agents:execute`    — RFC-165 F15/N1 gates agent launch on tasks:execute
//   - `workgroups:execute`— …and workgroup launch likewise
//
// A declared-but-unrouted point is worse than a missing one: it shows up in the
// account page's token matrix and tells the user that ticking it grants a
// capability that does not exist.

import { z } from 'zod'

/**
 * RFC-247 — the resource types that appear on the token authorization matrix.
 * The matrix axis is `MATRIX_RESOURCES × verbs`; anything outside this list is
 * a system-domain point that a token NEVER carries (see SYSTEM_DOMAIN_POINTS).
 */
export const MATRIX_RESOURCES = [
  'agents',
  'skills',
  'mcps',
  'plugins',
  'workflows',
  'workgroups',
  'tasks',
  'scheduled-tasks',
  'repos',
  'memory',
] as const
export type MatrixResource = (typeof MATRIX_RESOURCES)[number]

/**
 * RFC-247 — the four verbs the user picks on the matrix. `read` is deliberately
 * NOT here: reads are always granted to any valid token (scoped by the row-level
 * ACL and by the range points below), so there is no read switch to tick.
 */
export const MATRIX_VERBS = ['create', 'update', 'delete', 'execute'] as const
export type MatrixVerb = (typeof MATRIX_VERBS)[number]

export const PERMISSIONS = [
  // ---------------------------------------------------------------------------
  // Matrix domain — read points. Always granted to a token ("read is on").
  // ---------------------------------------------------------------------------
  'agents:read',
  'skills:read',
  'mcps:read',
  'plugins:read',
  'workflows:read',
  'workgroups:read',
  'scheduled-tasks:read',
  // RFC-257（UI 修订收紧）— webhook 配置整面 admin-only：四个 trigger 动词
  // 与 endpoints:manage 都只在 admin 全集里，user/manager 基线一律没有。
  'webhook-triggers:read',
  'repos:read',
  'memory:read',
  'tasks:read',
  // RANGE points — how far the ACCOUNT can see, which is an identity property,
  // not a token grant. Consumed directly by handlers via
  // `actor.permissions.has(...)` (routes/tasks.ts:183,188; clarify.ts:125,178;
  // reviews.ts:120,162), so they never appear in a RouteMeta — see
  // HANDLER_CONSUMED_POINTS below.
  'tasks:read:own',
  'tasks:read:all',

  // ---------------------------------------------------------------------------
  // Matrix domain — create.
  // ---------------------------------------------------------------------------
  'agents:create',
  'skills:create',
  'mcps:create',
  'plugins:create',
  'workflows:create',
  'workgroups:create',
  'scheduled-tasks:create',
  'webhook-triggers:create',
  'repos:create',
  'memory:create',
  // NOTE: no `tasks:create` — launching a task is an EXECUTE verb (RFC-247 D11).

  // ---------------------------------------------------------------------------
  // Matrix domain — update.
  // ---------------------------------------------------------------------------
  'agents:update',
  'skills:update',
  'mcps:update',
  'plugins:update',
  'workflows:update',
  'workgroups:update',
  'scheduled-tasks:update',
  'webhook-triggers:update',
  'memory:update',
  'tasks:update',
  // RFC-248: `repos:update` 由 `PUT /api/repo-groups/:id` 引入——在此之前 repos
  // 域确实没有任何 PUT/PATCH 路由（那条 NOTE 曾在这里）。仓库组与 cached_repos
  // 同类，复用 repos:* 而不新增授权矩阵行（D5）。它**必须**同时进 MANAGER_EXTRA，
  // 否则 manager 能建组却改不了组、也无法给 PAT 授权（设计门 G4）。
  'repos:update',

  // ---------------------------------------------------------------------------
  // Matrix domain — delete. RFC-247 D4: every one of these must be ticked
  // EXPLICITLY on a token; none of them rides a role baseline or a preset.
  // ---------------------------------------------------------------------------
  'agents:delete',
  'skills:delete',
  'mcps:delete',
  'plugins:delete',
  'workflows:delete',
  'workgroups:delete',
  'scheduled-tasks:delete',
  'webhook-triggers:delete',
  'repos:delete',
  'memory:delete',
  'tasks:delete',

  // ---------------------------------------------------------------------------
  // Matrix domain — execute.
  // ---------------------------------------------------------------------------
  'mcps:execute',
  'plugins:execute',
  'workflows:execute',
  'scheduled-tasks:execute',
  'repos:execute',
  'tasks:execute',
  // NOTE: no `skills:execute` — no execute-semantics route in the skills domain.
  //
  // NOTE: no `agents:execute` / `workgroups:execute` either. The only candidate
  // routes were `POST /api/{agents,workgroups}/:id/tasks`, and RFC-165 F15/N1
  // decided that launching is a TASK operation on every subject face: all three
  // launch endpoints gate uniformly on `tasks:execute`, with the agent path
  // explicitly EXEMPT from the agent method gate. Minting per-subject execute
  // points would reverse that decision AND leave two points no route
  // references — the "authorization UI lying to its user" failure this file
  // opens by warning about.
  //
  // RFC-247 also DELETES `tasks:cancel:own` / `tasks:cancel:all`. They were dead
  // points: `services/task.ts:2219` `cancelTask(db, id, opts)` takes no actor at
  // all, and a repo-wide grep finds zero references outside this file — already
  // recorded at docs/audit-backlog.md:62 ("`tasks:cancel:own/all` 零引用死点").
  // Cancel is an execute verb bounded by `canViewTask`, which is what the code
  // has always actually done.

  // ---------------------------------------------------------------------------
  // System domain — a token NEVER carries any of these (RFC-247 D7), not even
  // when its owner is an administrator.
  // ---------------------------------------------------------------------------
  'users:read',
  'users:write',
  'users:search',
  'settings:read',
  'settings:write',
  'oidc:read',
  'oidc:configure',
  'backup:run',
  'runtime:read',
  'account:self',
  // RFC-234 intent builder — explicitly out of the RFC-247 token surface.
  'intent:read',
  'intent:write',
  // RFC-253 — authoring the INLINE BODY of a script node, i.e. code the daemon
  // host will execute. It is not a CRUD verb on a resource domain (there is no
  // "script" resource — D1 keeps the body inline in the workflow), it is a
  // capability: "may cause arbitrary host execution". It therefore lives in the
  // system domain and never rides a token, so a leaked PAT with every matrix
  // grant still cannot write a script body.
  'scripts:author',
  // RFC-257 (D19) — managing webhook ENDPOINTS (the verification secret and the
  // public URL token). Platform infrastructure, not a work resource: a leaked
  // PAT must never be able to read or rotate the ingress secret, so the point
  // is system-domain (admin + manager role surface, zero token surface).
  'webhook-endpoints:manage',
] as const

export type Permission = (typeof PERMISSIONS)[number]
export type Role = 'admin' | 'user' | 'manager'

export const PermissionSchema = z.enum(PERMISSIONS)
export const RoleSchema = z.enum(['admin', 'user', 'manager'])

// -----------------------------------------------------------------------------
// RFC-247 — point classification. These are SELECTORS over PERMISSIONS (they
// overlap and do not jointly cover it), and they are the single source of truth
// for how a token's grant set is computed — see resolveTokenPermissions below.
//
// Declaration order matters: READ_POINTS and RANGE_POINTS are both derived by
// SUBTRACTING SYSTEM_DOMAIN_POINTS, so that set must exist first. An earlier
// draft hand-listed the system `:read` points to exclude and missed
// `intent:read`, which then rode into "reads a token always gets" — the exact
// class of silent widening this file is supposed to prevent.
// -----------------------------------------------------------------------------

/**
 * Points a token never carries, whatever its owner's role. Everything that
 * manages the platform itself rather than the work running on it.
 */
export const SYSTEM_DOMAIN_POINTS: ReadonlyArray<Permission> = [
  'users:read',
  'users:write',
  'users:search',
  'settings:read',
  'settings:write',
  'oidc:read',
  'oidc:configure',
  'backup:run',
  'runtime:read',
  'account:self',
  'intent:read',
  'intent:write',
  // RFC-253 — see the catalog entry: host code execution is a system-domain
  // capability, so no token may carry it (AC-26).
  'scripts:author',
  // RFC-257 — see the catalog entry: the ingress secret surface never rides a token.
  'webhook-endpoints:manage',
]

/**
 * RFC-247 — RANGE points: they bound how far an ACCOUNT can see, which is an
 * identity property rather than a token grant. They are consumed directly by
 * handlers through `actor.permissions.has(...)` and therefore never appear in a
 * `RouteMeta`, so the startup reverse self-check (design §3.2) must treat them
 * as handler-consumed rather than dead. Every entry carries the file:line that
 * consumes it — without that rule this list degrades into the reverse check's
 * dustbin.
 */
export const RANGE_POINTS: ReadonlyArray<Permission> = [
  // routes/tasks.ts:183,188 · clarify.ts:125,178 · reviews.ts:120,162
  'tasks:read:all',
  // services/overview.ts — the "mine vs all" split
  'tasks:read:own',
]

/**
 * Reads a token always gets, plus the range points that bound its reach.
 * Derived by subtraction from SYSTEM_DOMAIN_POINTS so a future system-domain
 * `:read` point cannot silently become a token grant.
 */
export const READ_POINTS: ReadonlyArray<Permission> = PERMISSIONS.filter(
  (p) => (p.endsWith(':read') || RANGE_POINTS.includes(p)) && !SYSTEM_DOMAIN_POINTS.includes(p),
)

/**
 * RFC-247 D4 — delete points must be named EXPLICITLY on a token. This replaces
 * RFC-222's hand-listed `PAT_EXPLICIT_ONLY_PERMISSIONS = ['tasks:delete']`:
 * deriving by suffix means a new resource type cannot silently widen a historical
 * token as the catalog grows.
 */
export const DELETE_POINTS: ReadonlyArray<Permission> = PERMISSIONS.filter((p) =>
  p.endsWith(':delete'),
)

/** Every matrix-domain point — i.e. everything a token can possibly hold. */
export const MATRIX_DOMAIN_POINTS: ReadonlyArray<Permission> = PERMISSIONS.filter(
  (p) => !SYSTEM_DOMAIN_POINTS.includes(p),
)

/**
 * RFC-247 §3.2 — the set the startup REVERSE self-check runs over: every point
 * here must be referenced by at least one `RouteMeta`, else the daemon refuses
 * to boot. Range points are excluded because handlers consume them directly
 * (see RANGE_POINTS); a dead point in the remainder would show up on the token
 * matrix as a capability that maps to no endpoint.
 */
export const ROUTE_BACKED_POINTS: ReadonlyArray<Permission> = MATRIX_DOMAIN_POINTS.filter(
  (p) => !RANGE_POINTS.includes(p),
)

// -----------------------------------------------------------------------------
// Role baselines. RFC-247 D15: EQUIVALENT to the pre-RFC-247 catalog — the
// shape of the points changed, the reach of each role did not.
// -----------------------------------------------------------------------------

const USER_RESOURCE_READS: ReadonlyArray<Permission> = [
  'agents:read',
  'skills:read',
  'mcps:read',
  'plugins:read',
  'workflows:read',
  'workgroups:read',
  'scheduled-tasks:read',
  'repos:read',
  'runtime:read',
]

// RFC-099: any user may create the ACL'd resource types (creator becomes owner)
// and modify / delete the ones they own; the per-row check lives in
// services/resourceAcl.ts and these points are only the coarse method gate.
// RFC-247 splits the old `:write` into three, and adds the previously
// UNGATED domains (workgroups / schedules) at their real, current reach —
// they had no permission point at all, i.e. every logged-in user could use them.
const USER_RESOURCE_WRITES: ReadonlyArray<Permission> = [
  'agents:create',
  'agents:update',
  'agents:delete',
  'skills:create',
  'skills:update',
  'skills:delete',
  'mcps:create',
  'mcps:update',
  'mcps:delete',
  'plugins:create',
  'plugins:update',
  'plugins:delete',
  'workflows:create',
  'workflows:update',
  'workflows:delete',
  'workgroups:create',
  'workgroups:update',
  'workgroups:delete',
  // Creating / editing a schedule arms a future launch, so it sat behind
  // `tasks:launch` (RFC-165 N1-r3) — which the user baseline has.
  'scheduled-tasks:create',
  'scheduled-tasks:update',
  'scheduled-tasks:delete',
]

// Execute points. Pre-RFC-247 these were reached either through `tasks:launch`
// (agent / workgroup task launches, schedule run-now) or through the resource's
// own `:write` (mcp probe, plugin check-update, workflow validate) — the user
// baseline had all of them.
const USER_EXECUTE: ReadonlyArray<Permission> = [
  'mcps:execute',
  'plugins:execute',
  'workflows:execute',
  'scheduled-tasks:execute',
  'tasks:execute',
]

const USER_BASELINE: ReadonlyArray<Permission> = [
  ...USER_RESOURCE_READS,
  ...USER_RESOURCE_WRITES,
  ...USER_EXECUTE,
  'users:search',
  'tasks:read',
  'tasks:read:own',
  'tasks:update',
  'account:self',
  // RFC-041 / RFC-099 D12: memory management is "scope-resource owner or
  // resource-admin", enforced per row by services/memory.ts canManageMemory.
  // RFC-247 folds the old approve/archive/edit/delete/write_feedback points
  // into the four verbs; the reach is unchanged.
  'memory:read',
  'memory:create',
  'memory:update',
  'memory:delete',
  // RFC-234 (D22): intent building is open to all users.
  'intent:read',
  'intent:write',
]

// RFC-222 — manager's extra route points over the user baseline. Row-level
// resource bypass is NOT here (it's the isResourceAdminRole identity predicate).
// Repos are out of the ACL model, so the repos points are plain points here.
const MANAGER_EXTRA: ReadonlyArray<Permission> = [
  // RFC-253 (D19) — script authoring is admin + manager. Being a SYSTEM-domain
  // point does not imply "admin only": `account:self`, `users:search` and
  // `intent:*` are system-domain and sit in USER_BASELINE. The system domain
  // bounds the TOKEN surface, not the role surface.
  'scripts:author',
  'repos:create',
  'repos:update', // RFC-248 D5/G4 —— 仓库组走 repos:* 这一档
  'repos:delete',
  'repos:execute',
  'tasks:read:all',
]

export const ROLE_PERMISSIONS: Record<Role, ReadonlyArray<Permission>> = {
  admin: [...PERMISSIONS],
  user: USER_BASELINE,
  manager: [...USER_BASELINE, ...MANAGER_EXTRA],
}

export function hasPermission(role: Role, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(perm)
}

/**
 * RFC-222 — the resource-domain identity predicate. admin AND manager share
 * every row-level ACL bypass (view/modify/delete/ACL-manage any owner's
 * resource). This is the SINGLE SOURCE OF TRUTH the ACL service, the auth
 * middleware, and the WS registry all derive from — business code must not
 * hand-write `role === 'admin' || role === 'manager'` (a repo guard enforces
 * this). System-domain gates (users/settings/oidc/backup/runtimes/task
 * deletion) stay keyed on `role === 'admin'` only.
 */
export function isResourceAdminRole(role: Role): boolean {
  return role === 'admin' || role === 'manager'
}

/** Used by snapshot tests to lock the negative set — points that must NOT leak to `user`. */
export const ADMIN_ONLY_PERMISSIONS: ReadonlyArray<Permission> = PERMISSIONS.filter(
  (p) => !USER_BASELINE.includes(p),
)

/**
 * RFC-222 (P1-2 negative lock) — points that must belong to admin but NEVER to
 * manager. Snapshot tests assert each is ∈ admin and ∉ manager.
 */
export const MANAGER_DENIED_PERMISSIONS: ReadonlyArray<Permission> = [
  'users:read',
  'users:write',
  'settings:read',
  'settings:write',
  'oidc:read',
  'oidc:configure',
  'backup:run',
  'tasks:delete',
]

// -----------------------------------------------------------------------------
// RFC-247 — token grant resolution. THE formula; auth/actor.ts calls this and
// does not reimplement any part of it.
// -----------------------------------------------------------------------------

export interface ResolveTokenPermissionsInput {
  readonly role: Role
  /** The matrix the user ticked when creating the token. May be empty (= read-only). */
  readonly matrix: ReadonlyArray<Permission>
}

/**
 * RFC-247 §2.2:
 *
 *   (READ_POINTS ∪ matrix) ∩ ROLE_PERMISSIONS[role] \ SYSTEM_DOMAIN_POINTS
 *                                                   \ (DELETE_POINTS \ matrix)
 *
 * Three invariants this encodes, each of which has a regression test:
 *
 *  1. **Reads are always on.** An empty matrix yields a read-only token rather
 *     than — as the pre-RFC-247 `patScopes.length > 0` short-circuit did — a
 *     token holding the owner's ENTIRE role baseline (docs/audit-backlog.md:62).
 *  2. **A token never exceeds its owner's role.** Unchanged from RFC-036.
 *  3. **Delete is opt-in per point.** A delete point the matrix does not name is
 *     stripped even though the role baseline has it (RFC-247 D4).
 */
export function resolveTokenPermissions(input: ResolveTokenPermissionsInput): Set<Permission> {
  const baseline = new Set(ROLE_PERMISSIONS[input.role])
  const ticked = new Set(input.matrix)
  const out = new Set<Permission>()

  for (const p of READ_POINTS) if (baseline.has(p)) out.add(p)
  for (const p of ticked) if (baseline.has(p)) out.add(p)

  for (const p of SYSTEM_DOMAIN_POINTS) out.delete(p)
  for (const p of DELETE_POINTS) if (!ticked.has(p)) out.delete(p)

  return out
}

/**
 * RFC-247 — the matrix points a given role may ever tick. The account page only
 * renders these (D3 / AC-23: a普通 user must not see repos write verbs at all),
 * and token creation rejects anything outside this set with 422 rather than
 * silently dropping it (AC-7).
 */
export function grantableMatrixPoints(role: Role): ReadonlyArray<Permission> {
  const baseline = new Set(ROLE_PERMISSIONS[role])
  return MATRIX_DOMAIN_POINTS.filter((p) => baseline.has(p) && !READ_POINTS.includes(p))
}
