// RFC-247 T1 — locks the route-metadata registry contract.
//
// The registry is the single source of truth for "which permission does this
// endpoint need". Three properties have to hold or the whole design collapses
// into the situation it replaces (gates scattered across three layers, no way
// to answer the question for an arbitrary route):
//
//   1. A declaration cannot be silently incomplete — an empty `permissions`
//      without a `publicReason` is a mistake, not a public route.
//   2. `tokenAccess: 'never'` refuses BEFORE any permission maths and before the
//      handler, so no matrix combination reopens `/api/auth/*` or an ACL write.
//   3. `permissions` is an AND. The cross-domain side-effect family (a route
//      whose real effect lands outside the domain its URL implies) is gated on
//      both domains, so holding only the surface one is not enough.

import { describe, expect, test, beforeEach } from 'bun:test'
import { Hono, type MiddlewareHandler } from 'hono'
import type { Permission } from '@agent-workflow/shared'
import { buildActor, type Actor } from '@/auth/actor'
import { errorHandler } from '@/util/errors'
import {
  allRouteMeta,
  lookupRouteMeta,
  registerRoute,
  resetRouteMetaRegistry,
  RouteMetaError,
  type RouteMeta,
} from '@/routes/registry'

function appWithActor(actor: Actor): Hono {
  const app = new Hono()
  const inject: MiddlewareHandler = async (c, next) => {
    c.set('actor', actor)
    await next()
  }
  app.use('*', inject)
  app.onError(errorHandler)
  return app
}

function actorOfKind(
  source: 'session' | 'pat',
  role: 'admin' | 'user' = 'admin',
  matrix: Permission[] = [],
): Actor {
  return buildActor({
    user: { id: 'u1', username: 'u1', displayName: 'U1', role, status: 'active' },
    source,
    patScopes: source === 'pat' ? matrix : undefined,
  })
}

const OK = () => new Response('ok')

beforeEach(() => {
  resetRouteMetaRegistry()
})

describe('RFC-247 registry — declaration validation', () => {
  test('empty permissions without publicReason is refused at registration', () => {
    const app = new Hono()
    expect(() =>
      registerRoute(
        app,
        { method: 'GET', path: '/x', permissions: [], tokenAccess: 'allow', summary: 's' },
        OK,
      ),
    ).toThrow(RouteMetaError)
  })

  test('empty permissions WITH publicReason is accepted', () => {
    const app = new Hono()
    expect(() =>
      registerRoute(
        app,
        {
          method: 'GET',
          path: '/health',
          permissions: [],
          publicReason: 'liveness probe, no identity required',
          tokenAccess: 'allow',
          summary: 'Health probe',
        },
        OK,
      ),
    ).not.toThrow()
  })

  test('publicReason on a gated route is refused — it would read as public', () => {
    const app = new Hono()
    expect(() =>
      registerRoute(
        app,
        {
          method: 'GET',
          path: '/x',
          permissions: ['agents:read'],
          publicReason: 'nope',
          tokenAccess: 'allow',
          summary: 's',
        },
        OK,
      ),
    ).toThrow(RouteMetaError)
  })

  test('a blank summary is refused — the summary is published in the API doc', () => {
    const app = new Hono()
    expect(() =>
      registerRoute(
        app,
        {
          method: 'GET',
          path: '/x',
          permissions: ['agents:read'],
          tokenAccess: 'allow',
          summary: '  ',
        },
        OK,
      ),
    ).toThrow(RouteMetaError)
  })

  // `createApp` is called many times in one process (every backend test builds a
  // fresh app), so re-declaring the SAME contract has to be a no-op — a registry
  // that threw on the second identical declaration would be unusable exactly
  // where its guarantees matter. A CONFLICTING re-declaration is the real
  // mistake and still throws.
  test('re-declaring the same contract is a no-op (app rebuilds must work)', () => {
    const meta: RouteMeta = {
      method: 'GET',
      path: '/x',
      permissions: ['agents:read'],
      tokenAccess: 'allow',
      summary: 's',
    }
    registerRoute(new Hono(), meta, OK)
    expect(() => registerRoute(new Hono(), meta, OK)).not.toThrow()
    expect(allRouteMeta().length).toBe(1)
  })

  test('re-declaring with DIFFERENT permissions is refused', () => {
    const base: RouteMeta = {
      method: 'GET',
      path: '/x',
      permissions: ['agents:read'],
      tokenAccess: 'allow',
      summary: 's',
    }
    registerRoute(new Hono(), base, OK)
    expect(() =>
      registerRoute(new Hono(), { ...base, permissions: ['agents:update'] }, OK),
    ).toThrow(RouteMetaError)
  })

  test('re-declaring with a DIFFERENT tokenAccess is refused', () => {
    const base: RouteMeta = {
      method: 'PUT',
      path: '/y',
      permissions: ['agents:update'],
      tokenAccess: 'allow',
      summary: 's',
    }
    registerRoute(new Hono(), base, OK)
    expect(() => registerRoute(new Hono(), { ...base, tokenAccess: 'never' }, OK)).toThrow(
      RouteMetaError,
    )
  })
})

describe('RFC-247 registry — the registry is queryable', () => {
  test('registered routes are discoverable by method+path and in bulk', () => {
    const app = new Hono()
    registerRoute(
      app,
      {
        method: 'POST',
        path: '/api/agents',
        permissions: ['agents:create'],
        tokenAccess: 'allow',
        summary: 'Create an agent',
      },
      OK,
    )
    expect(lookupRouteMeta('POST', '/api/agents')?.permissions).toEqual(['agents:create'])
    expect(lookupRouteMeta('GET', '/api/agents')).toBeUndefined()
    expect(allRouteMeta().length).toBe(1)
  })
})

describe('RFC-247 registry — tokenAccess: never', () => {
  const meta: RouteMeta = {
    method: 'PUT',
    path: '/api/tasks/:id/members',
    // Deliberately permissive on points: the refusal must not depend on them.
    permissions: ['tasks:update'],
    tokenAccess: 'never',
    summary: 'Replace task members',
  }

  test('a PAT is refused even holding every point the route names', async () => {
    const app = appWithActor(actorOfKind('pat', 'admin', ['tasks:update']))
    let handlerRan = false
    registerRoute(app, meta, () => {
      handlerRan = true
      return new Response('ok')
    })
    const res = await app.request('/api/tasks/t1/members', { method: 'PUT' })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe('token-forbidden-route')
    // the refusal happens before the handler — no side effect can have occurred
    expect(handlerRan).toBe(false)
  })

  test('a session actor passes the same route', async () => {
    const app = appWithActor(actorOfKind('session', 'admin'))
    registerRoute(app, meta, OK)
    const res = await app.request('/api/tasks/t1/members', { method: 'PUT' })
    expect(res.status).toBe(200)
  })
})

describe('RFC-247 registry — permissions is an AND', () => {
  // The cross-domain side-effect family: `POST /api/scheduled-tasks` arms a
  // future task launch, so holding only the schedules verb must not be enough.
  const meta: RouteMeta = {
    method: 'POST',
    path: '/api/scheduled-tasks',
    permissions: ['scheduled-tasks:create', 'tasks:execute'],
    tokenAccess: 'allow',
    summary: 'Create a scheduled task',
  }

  test('holding only the surface-domain point is refused', async () => {
    const app = appWithActor(actorOfKind('pat', 'admin', ['scheduled-tasks:create']))
    registerRoute(app, meta, OK)
    const res = await app.request('/api/scheduled-tasks', { method: 'POST' })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { details?: { requiredPermission?: string } }
    expect(body.details?.requiredPermission).toBe('tasks:execute')
  })

  test('holding both points passes', async () => {
    const app = appWithActor(
      actorOfKind('pat', 'admin', ['scheduled-tasks:create', 'tasks:execute']),
    )
    registerRoute(app, meta, OK)
    const res = await app.request('/api/scheduled-tasks', { method: 'POST' })
    expect(res.status).toBe(200)
  })

  test('the refusal names the MISSING point, not the first one', async () => {
    const app = appWithActor(actorOfKind('pat', 'admin', ['tasks:execute']))
    registerRoute(app, meta, OK)
    const res = await app.request('/api/scheduled-tasks', { method: 'POST' })
    const body = (await res.json()) as { details?: { requiredPermission?: string } }
    expect(body.details?.requiredPermission).toBe('scheduled-tasks:create')
  })
})

describe('RFC-247 registry — a public route stays reachable', () => {
  test('publicReason routes admit any actor, token included', async () => {
    const app = appWithActor(actorOfKind('pat', 'user', []))
    registerRoute(
      app,
      {
        method: 'GET',
        // A synthetic path, deliberately not a production one. The registry is
        // process-global (it describes the codebase's route inventory, which is
        // static), so a fixture that squats on a real path collides with the
        // production declaration the moment tests share a process — which is
        // exactly what happened when this file first used '/api/whoami'.
        path: '/api/__registry_fixture_public__',
        permissions: [],
        publicReason: 'fixture: a route that needs no permission point',
        tokenAccess: 'allow',
        summary: 'Fixture public route',
      },
      OK,
    )
    const res = await app.request('/api/__registry_fixture_public__')
    expect(res.status).toBe(200)
  })
})
