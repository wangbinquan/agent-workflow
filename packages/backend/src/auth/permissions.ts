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

export type GatedResource = 'agents' | 'skills' | 'mcps' | 'plugins' | 'workflows' | 'repos'

/**
 * RFC-247 — sub-paths whose verb is NOT the naive method mapping. The rules
 * (design/RFC-247-mcp-remote-access/design.md §2.3):
 *
 *   ① DELETE on a matrix-domain resource → `:delete`
 *   ② a POST with no persisted side effect → `:read` when it consumes nothing
 *      external, `:execute` when it runs real work (network / subprocess / model)
 *   ③ everything else by semantics
 *
 * Only the exceptions are listed; anything unmatched falls through to the naive
 * mapping at the bottom of `verbForRoute`. Every entry is anchored to the route
 * it covers so this table can be diffed against the real inventory.
 */
const VERB_OVERRIDES: ReadonlyArray<{
  method: string
  re: RegExp
  verb: 'read' | 'create' | 'update' | 'delete' | 'execute'
}> = [
  // — rule ②: pure resolve / preview / parse, no side effect, nothing external —
  { method: 'POST', re: /^\/api\/agents\/import-resolve$/, verb: 'read' },
  { method: 'POST', re: /^\/api\/agents\/closure-preview$/, verb: 'read' },
  { method: 'POST', re: /^\/api\/skills\/import-zip\/parse$/, verb: 'read' },

  // — rule ②: no resource write, but real work is performed —
  { method: 'POST', re: /^\/api\/workflows\/[^/]+\/validate$/, verb: 'execute' },
  { method: 'POST', re: /^\/api\/workflows\/[^/]+\/validate-draft$/, verb: 'execute' },
  { method: 'POST', re: /^\/api\/plugins\/[^/]+\/check-update$/, verb: 'execute' },
  { method: 'POST', re: /^\/api\/mcps\/[^/]+\/probe$/, verb: 'execute' },
  { method: 'POST', re: /^\/api\/mcps\/[^/]+\/runtime-test-sessions(\/.*)?$/, verb: 'execute' },
  // Repo mirrors: refreshing / retrying an import row does real fetch work
  // against a remote, but creates no resource. These two MUST agree with the
  // route metadata (routes/cached-repos.ts) — while the manual
  // `resourcePermissionGate('repos')` mount in server.ts still runs alongside
  // the migrated routes, a disagreement means the middleware demands
  // `repos:create` while the declaration demands `repos:execute`, and a token
  // holding exactly one of them is refused by the other. Both gates read this
  // function precisely so that cannot happen.
  { method: 'POST', re: /^\/api\/cached-repos\/[^/]+\/refresh$/, verb: 'execute' },
  {
    method: 'POST',
    re: /^\/api\/cached-repos\/imports\/[^/]+\/rows\/[^/]+\/retry$/,
    verb: 'execute',
  },

  // — rule ③: POSTs that mutate an EXISTING resource rather than create one —
  {
    method: 'POST',
    re: /^\/api\/(agents|mcps|plugins|workgroups)\/[^/]+\/rename$/,
    verb: 'update',
  },
  { method: 'POST', re: /^\/api\/plugins\/[^/]+\/upgrade$/, verb: 'update' },
  { method: 'POST', re: /^\/api\/skills\/[^/]+\/save$/, verb: 'update' },
  { method: 'POST', re: /^\/api\/skills\/[^/]+\/versions\/[^/]+\/restore$/, verb: 'update' },

  // — rule ③: POSTs that really do create a NEW resource under a nested path —
  { method: 'POST', re: /^\/api\/skills\/import-zip\/commit$/, verb: 'create' },
  { method: 'POST', re: /^\/api\/workflows\/import$/, verb: 'create' },
  { method: 'POST', re: /^\/api\/(workflows|workgroups)\/[^/]+\/copy$/, verb: 'create' },
]

/**
 * RFC-247 — the single source of truth for "which verb does this route carry".
 * `resourcePermissionGate` consumes it today; the route-metadata registry (T1)
 * will consume the same function so the two can never disagree.
 *
 * Exported for the table-driven test that walks the real route inventory.
 */
export function verbForRoute(
  method: string,
  path: string,
): 'read' | 'create' | 'update' | 'delete' | 'execute' {
  for (const o of VERB_OVERRIDES) {
    if (o.method === method && o.re.test(path)) return o.verb
  }
  if (method === 'GET' || method === 'HEAD') return 'read'
  if (method === 'DELETE') return 'delete'
  if (method === 'PUT' || method === 'PATCH') return 'update'
  return 'create'
}

/**
 * Method-aware permission gate for resource routes. Mount once per resource:
 *   app.use('/api/agents', resourcePermissionGate('agents'))
 *   app.use('/api/agents/*', resourcePermissionGate('agents'))
 *
 * RFC-247: the verb comes from `verbForRoute`, not from a two-way read/write
 * split — `资源:write` no longer exists, because it could not express
 * "may modify but not delete", which is exactly what a self-issued API token
 * needs to say.
 */
export function resourcePermissionGate(
  resource: GatedResource,
  opts?: {
    /**
     * RFC-165 (F15): carve-outs for sub-paths whose semantics belong to a
     * DIFFERENT resource domain — e.g. POST /api/agents/:id/tasks is a task
     * launch gated by tasks:execute (registered separately), not an agents verb.
     * Return true to skip this gate for the request.
     */
    skip?: (method: string, path: string) => boolean
  },
): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method
    const path = c.req.path
    if (opts?.skip !== undefined && opts.skip(method, path)) {
      await next()
      return
    }
    const perm = `${resource}:${verbForRoute(method, path)}` as Permission
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
