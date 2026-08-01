// RFC-247 AC-29 — locks the CROSS-DOMAIN SIDE-EFFECT family.
//
// The family: a route whose real effect lands in a different permission domain
// than its URL implies, gated only on the domain the URL implies. Every member
// is a back door — hold the cheap surface point, get the expensive one free.
//
// These are hard to find because the route NAME does not say what it does. Of
// the members below, exactly one (`POST /api/scheduled-tasks`) is guessable from
// its path; the rest were found only by reading the service each handler calls:
//
//   POST /api/workgroup-tasks/:taskId/dw-save-as-workflow
//        → creates a real workflow resource                (workflows:create)
//   POST /api/fusions
//        → runs the built-in aw-skill-merger agent          (tasks:execute)
//        → and ultimately rewrites the target skill         (skills:update)
//   POST /api/fusions/:id/approve
//        → atomically bumps a skill version + fuses memory  (skills:update,
//          memory:update) — today's only check is a ROW-level ACL
//          (services/fusion.ts fusion-skill-forbidden) which asks "do you own
//          this skill", never "does your token hold skills:update"
//
// This file asserts the AND: a token holding ONLY the surface-domain verb is
// refused, and the refusal names the missing point. It is deliberately written
// against the route METADATA rather than by driving each handler end-to-end —
// the property under test is the declared authorization contract, and asserting
// it at that level means a future handler refactor cannot quietly drop the gate
// while keeping the test green.

import { describe, expect, test } from 'bun:test'
import { Hono, type MiddlewareHandler } from 'hono'
import type { Permission } from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import { errorHandler } from '@/util/errors'
import { lookupRouteMeta, routeMetaGate, type RouteMeta } from '@/routes/registry'
import { mountFusionRoutes } from '@/routes/fusions'
import { mountWorkgroupTaskRoutes } from '@/routes/workgroupTasks'
import { mountScheduledTaskRoutes } from '@/routes/scheduledTasks'
import { mountWorkgroupRoutes } from '@/routes/workgroups'

// Mounting is what populates the registry; the deps are never touched because
// every assertion refuses before the handler runs.
const deps = {} as Parameters<typeof mountFusionRoutes>[1]
function ensureMounted(): void {
  const sink = new Hono()
  try {
    mountFusionRoutes(sink, deps)
    mountWorkgroupTaskRoutes(sink, deps as Parameters<typeof mountWorkgroupTaskRoutes>[1])
    mountScheduledTaskRoutes(sink, deps as Parameters<typeof mountScheduledTaskRoutes>[1])
    mountWorkgroupRoutes(sink, deps as Parameters<typeof mountWorkgroupRoutes>[1])
  } catch {
    // Some mounts build service singletons from `deps`; a throw there still
    // leaves the routes registered, which is all this file needs.
  }
}

function meta(method: string, path: string): RouteMeta {
  ensureMounted()
  const m = lookupRouteMeta(method, path)
  if (m === undefined) throw new Error(`no RouteMeta for ${method} ${path} — did the route move?`)
  return m
}

/** Drive just the declared gate with a token holding exactly `matrix`. */
async function probe(m: RouteMeta, matrix: Permission[]): Promise<Response> {
  const app = new Hono()
  const actor = buildActor({
    user: { id: 'u1', username: 'u1', displayName: 'U1', role: 'admin', status: 'active' },
    source: 'pat',
    patScopes: matrix,
  })
  const inject: MiddlewareHandler = async (c, next) => {
    c.set('actor', actor)
    await next()
  }
  app.use('*', inject)
  app.onError(errorHandler)
  app.all('/probe', routeMetaGate(m), () => new Response('reached-handler'))
  return app.request('/probe', { method: 'POST' })
}

interface Case {
  readonly name: string
  readonly method: string
  readonly path: string
  /** The verb a caller would naively assume is enough. */
  readonly surface: Permission
  /** The point the route ALSO needs because of what it really does. */
  readonly hidden: Permission
}

const CASES: ReadonlyArray<Case> = [
  {
    name: 'creating a schedule arms a future task launch',
    method: 'POST',
    path: '/api/scheduled-tasks',
    surface: 'scheduled-tasks:create',
    hidden: 'tasks:execute',
  },
  {
    name: 'dw-save-as-workflow creates a workflow resource',
    method: 'POST',
    path: '/api/workgroup-tasks/:taskId/dw-save-as-workflow',
    surface: 'tasks:execute',
    hidden: 'workflows:create',
  },
  {
    name: 'launching a fusion runs an agent against a skill',
    method: 'POST',
    path: '/api/fusions',
    surface: 'tasks:execute',
    hidden: 'skills:update',
  },
  {
    name: 'approving a fusion rewrites the skill',
    method: 'POST',
    path: '/api/fusions/:id/approve',
    surface: 'memory:update',
    hidden: 'skills:update',
  },
  {
    name: 'launching a workgroup task is a task execution',
    method: 'POST',
    path: '/api/workgroups/:id/tasks',
    surface: 'workgroups:execute',
    hidden: 'tasks:execute',
  },
]

describe('RFC-247 AC-29 — cross-domain side effects need BOTH domains', () => {
  for (const c of CASES) {
    test(`${c.method} ${c.path} — ${c.name}`, async () => {
      const m = meta(c.method, c.path)

      // the declaration itself names both domains
      expect(m.permissions).toContain(c.surface)
      expect(m.permissions).toContain(c.hidden)

      // holding only the surface point is refused, and the error names the gap
      const res = await probe(m, [c.surface])
      expect(res.status).toBe(403)
      const body = (await res.json()) as { details?: { requiredPermission?: string } }
      expect(body.details?.requiredPermission).toBe(c.hidden)

      // holding both passes the gate
      const ok = await probe(m, [c.surface, c.hidden])
      expect(ok.status).toBe(200)
      expect(await ok.text()).toBe('reached-handler')
    })
  }
})

describe('RFC-247 AC-34 — routes that change authorization itself are token-proof', () => {
  test('PUT /api/workgroup-tasks/:taskId/config is tokenAccess: never', async () => {
    // Its `addMembers` inserts task_collaborators rows — a durable third-party
    // grant on a member-private task — and then kicks the engine. No matrix
    // combination may reach it.
    const m = meta('PUT', '/api/workgroup-tasks/:taskId/config')
    expect(m.tokenAccess).toBe('never')

    const res = await probe(m, ['tasks:update', 'tasks:execute'])
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe('token-forbidden-route')
  })
})
