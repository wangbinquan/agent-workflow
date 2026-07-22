// RFC-036 — permission catalog. Routes use `requirePermission(perm)` against
// these literals; roles are mapped to permission sets via ROLE_PERMISSIONS. To
// add a new role (auditor / viewer / team_lead etc.) we only add a new key to
// ROLE_PERMISSIONS — business code does not key off the role string.
//
// RFC-222 — third role `manager` (中文「资源管理员」): manager = admin minus
// user management, system settings/ops, and task deletion. It gets every
// resource-domain capability (row-level ACL bypass lives in the identity
// predicate isResourceAdminRole below, NOT in a permission point) plus the
// coarse route points repos:write / tasks:read:all / tasks:cancel:all.

import { z } from 'zod'

export const PERMISSIONS = [
  // resource read (admin + user)
  'agents:read',
  'skills:read',
  'mcps:read',
  'plugins:read',
  'workflows:read',
  'repos:read',
  'runtime:read',
  // resource write (admin only)
  'agents:write',
  'skills:write',
  'mcps:write',
  'plugins:write',
  'workflows:write',
  'repos:write',
  // user management (admin only)
  'users:read',
  'users:write',
  // user search picker (admin + user) — public-fields-only endpoint
  'users:search',
  // global settings (admin only)
  'settings:read',
  'settings:write',
  // OIDC providers config (admin only)
  'oidc:read',
  'oidc:configure',
  // backup (admin only)
  'backup:run',
  // tasks
  'tasks:launch',
  'tasks:read:own',
  'tasks:read:all',
  'tasks:cancel:own',
  'tasks:cancel:all',
  // RFC-222 task deletion (admin only — NOT manager)
  'tasks:delete',
  // self-service (admin + user)
  'account:self',
  // RFC-041 platform long-term memory
  'memory:read',
  'memory:approve',
  'memory:archive',
  'memory:delete',
  'memory:write_feedback',
  // RFC-045 manual edit of candidate/approved/archived rows (admin only)
  'memory:edit',
] as const

export type Permission = (typeof PERMISSIONS)[number]
export type Role = 'admin' | 'user' | 'manager'

export const PermissionSchema = z.enum(PERMISSIONS)
export const RoleSchema = z.enum(['admin', 'user', 'manager'])

const USER_RESOURCE_READS: ReadonlyArray<Permission> = [
  'agents:read',
  'skills:read',
  'mcps:read',
  'plugins:read',
  'workflows:read',
  'repos:read',
  'runtime:read',
]

// RFC-099: resource writes are no longer admin-only at the route gate — any
// user may create the five ACL'd resource types (creator becomes owner) and
// modify the ones they own. The per-row owner/grant check lives in
// services/resourceAcl.ts; these points are only the coarse method gate.
// repos:write stays admin-only (repos are out of the ACL model).
const USER_RESOURCE_WRITES: ReadonlyArray<Permission> = [
  'agents:write',
  'skills:write',
  'mcps:write',
  'plugins:write',
  'workflows:write',
]

const USER_BASELINE: ReadonlyArray<Permission> = [
  ...USER_RESOURCE_READS,
  ...USER_RESOURCE_WRITES,
  'users:search',
  'tasks:launch',
  'tasks:read:own',
  'tasks:cancel:own',
  'account:self',
  // RFC-041: anyone logged in can read approved memories and write task
  // feedback on tasks they can see.
  'memory:read',
  'memory:write_feedback',
  // RFC-099 (D12): memory management moved from admin-only to "scope-resource
  // owner or resource-admin", enforced per-row by services/memory.ts
  // canManageMemory (repo/global-scoped rows still reject non-resource-admins
  // at the row check — RFC-222 opened those rows to manager alongside admin).
  'memory:approve',
  'memory:archive',
  'memory:delete',
  'memory:edit',
]

// RFC-222 — manager's extra route points over the user baseline. Row-level
// resource bypass is NOT here (it's the isResourceAdminRole identity predicate);
// these are only the coarse method/route gates a manager additionally passes.
// repos are out of the ACL model, so repos:write is a plain point here (D3).
const MANAGER_EXTRA: ReadonlyArray<Permission> = [
  'repos:write',
  'tasks:read:all',
  'tasks:cancel:all',
]

export const ROLE_PERMISSIONS: Record<Role, ReadonlyArray<Permission>> = {
  admin: [...PERMISSIONS],
  user: USER_BASELINE,
  // RFC-222 — manager inherits the user baseline (incl. the D12 memory points,
  // whose repo/global reach is unlocked per-row by isResourceAdminRole) plus
  // MANAGER_EXTRA. Notably absent: users:*, settings:*, oidc:*, backup:run,
  // tasks:delete — the identity of "resource admin, not system admin".
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
 * manager. Snapshot tests assert each is ∈ admin and ∉ manager. (ADMIN_ONLY
 * above still locks the ∉ user set; it stays admin-vs-user by design even
 * though some of its members — repos:write etc. — are now also manager's.)
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

/**
 * RFC-222 (P1-3) — permissions a PAT never inherits from its role baseline; it
 * must list them explicitly. buildActor strips these from any PAT (even an
 * empty-scoped one, which otherwise gets the full role baseline) unless the
 * scope array names them. Keeps a historical admin token from silently gaining
 * a destructive new point (tasks:delete) as the catalog grows.
 */
export const PAT_EXPLICIT_ONLY_PERMISSIONS: ReadonlyArray<Permission> = ['tasks:delete']
