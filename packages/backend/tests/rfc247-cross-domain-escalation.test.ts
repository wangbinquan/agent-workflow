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
import { mountMemoryDistillJobRoutes } from '@/routes/memoryDistillJobs'
import { mountAgentRoutes } from '@/routes/agents'

// Mounting is what populates the registry; the deps are never touched because
// every assertion refuses before the handler runs.
//
// Each mount is wrapped SEPARATELY: some build service singletons out of `deps`
// and throw on the empty stub, and a single shared try/catch would let the first
// thrower silently skip every mount after it — the routes would simply be absent
// and the tests would fail with "did the route move?", pointing at the wrong
// thing. Routes registered before a throw are kept, which is all this file needs.
const deps = {} as Parameters<typeof mountFusionRoutes>[1]

function mountAll(): void {
  const sink = new Hono()
  const mounts: ReadonlyArray<() => void> = [
    () => mountFusionRoutes(sink, deps),
    () => mountWorkgroupTaskRoutes(sink, deps as Parameters<typeof mountWorkgroupTaskRoutes>[1]),
    () => mountScheduledTaskRoutes(sink, deps as Parameters<typeof mountScheduledTaskRoutes>[1]),
    () => mountWorkgroupRoutes(sink, deps as Parameters<typeof mountWorkgroupRoutes>[1]),
    () =>
      mountMemoryDistillJobRoutes(sink, deps as Parameters<typeof mountMemoryDistillJobRoutes>[1]),
    () => mountAgentRoutes(sink, deps as Parameters<typeof mountAgentRoutes>[1]),
  ]
  for (const m of mounts) {
    try {
      m()
    } catch {
      // see above — partial registration is fine and expected
    }
  }
}

function meta(method: string, path: string): RouteMeta {
  mountAll()
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
    name: 'retrying a distill job spawns a real model run',
    method: 'POST',
    path: '/api/memory-distill-jobs/:id/retry',
    surface: 'memory:update',
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

// RFC-165 F15/N1 counter-case: launching is a TASK operation on every subject
// face, so the three launch endpoints are NOT members of the cross-domain family
// — they carry exactly one point. A mechanical `${resource}:execute` pass would
// have made them AND-gated and silently reversed that decision (and minted two
// dead points). This asserts the uniformity so the next migration cannot.
describe('RFC-247 — launch endpoints stay uniformly gated (RFC-165 F15/N1)', () => {
  for (const path of ['/api/agents/:id/tasks', '/api/workgroups/:id/tasks']) {
    test(`POST ${path} requires exactly tasks:execute`, () => {
      expect(meta('POST', path).permissions).toEqual(['tasks:execute'])
    })
  }
})

describe('RFC-247 — the identity door AND the point door', () => {
  // RFC-222's two-door pattern moved INTO the metadata so the generated API
  // documentation states the whole contract. Both doors must still be enforced:
  // identity alone would let a scope-stripped token through (the hole RFC-099's
  // route-gate contract warns about); the point alone would let a plain `user`
  // through on a point that sits in the user baseline — and `memory:update`
  // does sit there.
  test('memory-distill-jobs demands resource-admin identity, not just the point', async () => {
    const m = meta('POST', '/api/memory-distill-jobs/:id/cancel')
    expect(m.identity).toBe('resource-admin')

    const app = new Hono()
    const plainUser = buildActor({
      user: { id: 'u2', username: 'u2', displayName: 'U2', role: 'user', status: 'active' },
      source: 'pat',
      patScopes: ['memory:update'],
    })
    // the point IS held — a plain user has memory:update in its baseline
    expect(plainUser.permissions.has('memory:update')).toBe(true)
    const inject: MiddlewareHandler = async (c, next) => {
      c.set('actor', plainUser)
      await next()
    }
    app.use('*', inject)
    app.onError(errorHandler)
    app.all('/probe', routeMetaGate(m), () => new Response('reached-handler'))
    const res = await app.request('/probe', { method: 'POST' })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { message: string }).message).toBe('resource admin only')
  })
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

// ---------------------------------------------------------------------------
// Migration guard — the two mistakes this RFC made, generalised.
//
// T3 migrated ~80 routes by hand. Twice, writing the "obvious" declaration
// silently reversed a deliberate decision from an earlier RFC, and both times
// only a pre-existing named regression caught it:
//
//   · PUT /api/scheduled-tasks/:id — RFC-165 N1-r3 makes that gate
//     PAYLOAD-CONDITIONAL (rename / disabled-spec edits stay open; only an
//     arming edit needs the execute point). A static `+ tasks:execute` looked
//     safer and in fact revoked a granted capability.
//   · POST /api/agents/:id/tasks — RFC-165 F15/N1 gates every launch endpoint
//     uniformly on tasks:execute. A mechanical `${resource}:execute` looked
//     symmetric and in fact reversed that, and minted two dead points besides.
//
// The transferable rule: an AND is justified when the route causes an effect
// OUTSIDE its own domain — not when the route merely lives under some
// resource's URL. These assertions encode the rule at the two places it was
// gotten wrong, so the next batch cannot re-derive the wrong answer.
// ---------------------------------------------------------------------------
describe('RFC-247 — migration guard: no AND without a real cross-domain effect', () => {
  test('scheduled-task PUT stays single-point (its launch check is payload-conditional)', () => {
    // services/scheduledTasks.ts armsLaunchAgainst is where the execute
    // requirement lives, because only it can see the request body.
    expect(meta('PUT', '/api/scheduled-tasks/:id').permissions).toEqual(['scheduled-tasks:update'])
  })

  test('scheduled-task POST and run-now DO carry the AND (they always arm)', () => {
    expect(meta('POST', '/api/scheduled-tasks').permissions).toEqual([
      'scheduled-tasks:create',
      'tasks:execute',
    ])
    expect(meta('POST', '/api/scheduled-tasks/:id/run-now').permissions).toEqual([
      'scheduled-tasks:execute',
      'tasks:execute',
    ])
  })

  test('no route declares a `:execute` point for a subject it merely launches', () => {
    // agents:execute / workgroups:execute do not exist at all — see
    // shared/schemas/permission.ts. This asserts the absence survives at the
    // declaration layer too, where a future migration would reintroduce it.
    for (const path of ['/api/agents/:id/tasks', '/api/workgroups/:id/tasks']) {
      const perms = meta('POST', path).permissions as readonly string[]
      expect(perms.some((p) => p.endsWith(':execute') && !p.startsWith('tasks:'))).toBe(false)
    }
  })
})
