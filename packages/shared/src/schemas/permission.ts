// RFC-036 — permission catalog. Routes use `requirePermission(perm)` against
// these literals; roles are mapped to permission sets via ROLE_PERMISSIONS. To
// add a new role (auditor / viewer / team_lead etc.) we only add a new key to
// ROLE_PERMISSIONS — business code does not key off the role string.

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
export type Role = 'admin' | 'user'

export const PermissionSchema = z.enum(PERMISSIONS)
export const RoleSchema = z.enum(['admin', 'user'])

const USER_RESOURCE_READS: ReadonlyArray<Permission> = [
  'agents:read',
  'skills:read',
  'mcps:read',
  'plugins:read',
  'workflows:read',
  'repos:read',
  'runtime:read',
]

const USER_BASELINE: ReadonlyArray<Permission> = [
  ...USER_RESOURCE_READS,
  'users:search',
  'tasks:launch',
  'tasks:read:own',
  'tasks:cancel:own',
  'account:self',
  // RFC-041: anyone logged in can read approved memories and write task
  // feedback on tasks they can see. approve/archive/delete stay admin-only.
  'memory:read',
  'memory:write_feedback',
]

export const ROLE_PERMISSIONS: Record<Role, ReadonlyArray<Permission>> = {
  admin: [...PERMISSIONS],
  user: USER_BASELINE,
}

export function hasPermission(role: Role, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(perm)
}

/** Used by snapshot tests to lock the negative set — points that must NOT leak to `user`. */
export const ADMIN_ONLY_PERMISSIONS: ReadonlyArray<Permission> = PERMISSIONS.filter(
  (p) => !USER_BASELINE.includes(p),
)
