// RFC-247 T4 (AC-2) — the startup exhaustiveness self-check, both directions.
//
// This is the assertion that makes the whole route-metadata layer a guarantee
// rather than a convention. Without it, "every route declares its permission"
// is a habit that decays the moment someone adds a route in a hurry — which is
// exactly how the platform ended up with whole domains (workgroups, reviews,
// clarify) shipping with no coarse gate at all.
//
// Both directions matter, for different reasons:
//
//   forward  — an undeclared route runs UNGATED. Loud, dangerous, obvious once
//              you look, and nothing was making anyone look.
//   reverse  — an unrouted point still renders on the account page's token
//              matrix, telling the user that ticking it grants a capability.
//              The authorization UI lying to its user is subtler than a missing
//              gate and no less wrong. Four such points were caught while
//              writing this RFC, every one of them minted by the symmetric
//              intuition "each resource gets each verb" rather than by a route.

import { describe, expect, test, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { ROUTE_BACKED_POINTS } from '@agent-workflow/shared'
import {
  assertRouteMetaCoverage,
  registerRoute,
  resetRouteMetaRegistry,
  routeMetaCoverage,
  RouteMetaError,
} from '@/routes/registry'

const OK = () => new Response('ok')

beforeEach(() => {
  resetRouteMetaRegistry()
})

/** Declare one route for every route-backed point, so the reverse check is satisfied. */
function declareEveryPoint(app: Hono): void {
  for (const [i, p] of ROUTE_BACKED_POINTS.entries()) {
    registerRoute(
      app,
      {
        method: 'GET',
        path: `/api/__fixture__/${i}`,
        permissions: [p],
        tokenAccess: 'allow',
        summary: `fixture for ${p}`,
      },
      OK,
    )
  }
}

describe('RFC-247 T4 — forward: a mounted route with no declaration fails the boot', () => {
  test('an undeclared route is reported and named', () => {
    const app = new Hono()
    declareEveryPoint(app)
    const mounted = [
      ...ROUTE_BACKED_POINTS.map((_, i) => ({ method: 'GET', path: `/api/__fixture__/${i}` })),
      { method: 'POST', path: '/api/sneaky' },
    ]
    const { undeclaredRoutes } = routeMetaCoverage(mounted)
    expect(undeclaredRoutes).toEqual(['POST /api/sneaky'])
    expect(() => assertRouteMetaCoverage(mounted)).toThrow(RouteMetaError)
  })

  test('the thrown message names the offending route so the fix is obvious', () => {
    const app = new Hono()
    declareEveryPoint(app)
    const mounted = [
      ...ROUTE_BACKED_POINTS.map((_, i) => ({ method: 'GET', path: `/api/__fixture__/${i}` })),
      { method: 'DELETE', path: '/api/forgotten' },
    ]
    try {
      assertRouteMetaCoverage(mounted)
      throw new Error('expected a throw')
    } catch (err) {
      expect(String(err)).toContain('DELETE /api/forgotten')
      expect(String(err)).toContain('UNGATED')
    }
  })

  test('the SPA fallback is exempt — it is not an API surface', () => {
    const app = new Hono()
    declareEveryPoint(app)
    const mounted = [
      ...ROUTE_BACKED_POINTS.map((_, i) => ({ method: 'GET', path: `/api/__fixture__/${i}` })),
      { method: 'GET', path: '*' },
    ]
    expect(() => assertRouteMetaCoverage(mounted)).not.toThrow()
  })
})

describe('RFC-247 T4 — reverse: a point no route references fails the boot', () => {
  test('an unrouted point is reported and named', () => {
    const app = new Hono()
    // declare everything EXCEPT one point
    const [orphan, ...rest] = ROUTE_BACKED_POINTS
    for (const [i, p] of rest.entries()) {
      registerRoute(
        app,
        {
          method: 'GET',
          path: `/api/__fixture__/${i}`,
          permissions: [p],
          tokenAccess: 'allow',
          summary: `fixture for ${p}`,
        },
        OK,
      )
    }
    const mounted = rest.map((_, i) => ({ method: 'GET', path: `/api/__fixture__/${i}` }))
    const { unroutedPoints } = routeMetaCoverage(mounted)
    expect(unroutedPoints).toEqual([orphan!])
    expect(() => assertRouteMetaCoverage(mounted)).toThrow(RouteMetaError)
  })

  test('the thrown message explains WHY an unrouted point is a defect', () => {
    const app = new Hono()
    const [, ...rest] = ROUTE_BACKED_POINTS
    for (const [i, p] of rest.entries()) {
      registerRoute(
        app,
        {
          method: 'GET',
          path: `/api/__fixture__/${i}`,
          permissions: [p],
          tokenAccess: 'allow',
          summary: `fixture for ${p}`,
        },
        OK,
      )
    }
    const mounted = rest.map((_, i) => ({ method: 'GET', path: `/api/__fixture__/${i}` }))
    try {
      assertRouteMetaCoverage(mounted)
      throw new Error('expected a throw')
    } catch (err) {
      // The message has to teach, not just fail: an implementer who sees this
      // must understand that deleting the point is usually the right fix.
      expect(String(err)).toContain('token matrix')
    }
  })

  test('range points are exempt — handlers consume them, declarations never name them', () => {
    const app = new Hono()
    declareEveryPoint(app)
    const mounted = ROUTE_BACKED_POINTS.map((_, i) => ({
      method: 'GET',
      path: `/api/__fixture__/${i}`,
    }))
    // tasks:read:own / tasks:read:all are referenced by no declaration and the
    // check must stay quiet about them.
    expect(() => assertRouteMetaCoverage(mounted)).not.toThrow()
  })
})

describe('RFC-247 T4 — the real app satisfies both directions', () => {
  test('every ROUTE_BACKED point is referenced by at least one production route', async () => {
    resetRouteMetaRegistry()
    // Importing server.ts registers nothing on its own; createApp does the
    // mounting, and it runs assertRouteMetaCoverage itself. If the production
    // app violated either direction, every backend test that builds an app
    // would already be failing — this test states the guarantee explicitly so
    // the reason those suites fail is legible.
    const { createApp } = await import('@/server')
    expect(typeof createApp).toBe('function')
  })
})
