// RFC-036 — requirePermission middleware factory.
// Routes annotate themselves with the permission they need:
//   app.get('/api/agents', requirePermission('agents:read'), listAgents)
// The middleware reads the resolved actor from the Hono context (multiAuth
// has already populated it) and 403s if the permission is missing.

import type { MiddlewareHandler } from 'hono'
import type { Permission } from '@agent-workflow/shared'
import { isResourceAdminRole } from '@agent-workflow/shared'
import { actorOf } from './actor'
import { ForbiddenError } from '@/util/errors'

export function requirePermission(perm: Permission): MiddlewareHandler {
  return async (c, next) => {
    const actor = actorOf(c)
    if (!actor.permissions.has(perm)) {
      throw new ForbiddenError('forbidden', `missing permission: ${perm}`, {
        requiredPermission: perm,
        actorPermissions: [...actor.permissions],
      })
    }
    await next()
  }
}

/**
 * RFC-099 — admin-identity gate for surfaces that stay admin-only even though
 * their permission POINT moved into the user baseline (memory distill jobs:
 * the route gate was `memory:approve`, which D12 opened to all users for the
 * per-row canManageMemory model; the distill-jobs operational pages were
 * explicitly kept 现状/admin-only in the RFC scope).
 */
export function requireAdmin(): MiddlewareHandler {
  return async (c, next) => {
    const actor = actorOf(c)
    if (actor.user.role !== 'admin') {
      throw new ForbiddenError('forbidden', 'admin only')
    }
    await next()
  }
}

/**
 * RFC-222 — resource-admin gate (admin OR manager) with a DOUBLE check: the
 * identity predicate AND a permission point. The identity door rejects `user`;
 * the permission door lets a narrowed PAT still take effect (a plain
 * `requireAdmin()`-style identity-only gate would let a scope-stripped token
 * through — the very hole RFC-099's route-gate contract warns about). Used for
 * route/channel gates that D3 opens to manager (memory-distill-jobs). Row-level
 * resource bypass stays pure-identity via isResourceAdminActor — see
 * services/resourceAcl.ts.
 */
export function requireResourceAdmin(perm: Permission): MiddlewareHandler {
  return async (c, next) => {
    const actor = actorOf(c)
    if (!isResourceAdminRole(actor.user.role)) {
      throw new ForbiddenError('forbidden', 'resource admin only')
    }
    if (!actor.permissions.has(perm)) {
      throw new ForbiddenError('forbidden', `missing permission: ${perm}`, {
        requiredPermission: perm,
        actorPermissions: [...actor.permissions],
      })
    }
    await next()
  }
}

/** Helper for ad-hoc gates inside handlers (e.g. owner-or-admin checks). */
export function ensurePermission(c: Parameters<MiddlewareHandler>[0], perm: Permission): void {
  const actor = actorOf(c)
  if (!actor.permissions.has(perm)) {
    throw new ForbiddenError('forbidden', `missing permission: ${perm}`, {
      requiredPermission: perm,
      actorPermissions: [...actor.permissions],
    })
  }
}

/**
 * Method-aware permission gate for resource routes that have a clean
 * read/write split. Mount once per resource:
 *   app.use('/api/agents', resourcePermissionGate('agents'))
 *   app.use('/api/agents/*', resourcePermissionGate('agents'))
 * GET / HEAD → `${resource}:read`; POST / PUT / PATCH / DELETE → `:write`.
 * For routes that need a different mapping (e.g. read-only POSTs like
 * /test endpoints), guard them with their own requirePermission() above
 * the gate or split the path.
 */
export function resourcePermissionGate(
  resource: 'agents' | 'skills' | 'mcps' | 'plugins' | 'workflows' | 'repos',
  opts?: {
    /**
     * RFC-165 (F15): carve-outs for sub-paths whose semantics are NOT a
     * resource read/write — e.g. POST /api/agents/:id/tasks is a task
     * LAUNCH gated by tasks:launch (registered separately), not agents:write.
     * Return true to skip this gate for the request.
     */
    skip?: (method: string, path: string) => boolean
  },
): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method
    if (opts?.skip !== undefined && opts.skip(method, c.req.path)) {
      await next()
      return
    }
    const perm =
      method === 'GET' || method === 'HEAD'
        ? (`${resource}:read` as Permission)
        : (`${resource}:write` as Permission)
    const actor = actorOf(c)
    if (!actor.permissions.has(perm)) {
      throw new ForbiddenError('forbidden', `missing permission: ${perm}`, {
        requiredPermission: perm,
        actorPermissions: [...actor.permissions],
      })
    }
    await next()
  }
}
