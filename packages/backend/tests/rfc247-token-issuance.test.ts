// RFC-247 D1 / D10 / AC-7 / AC-18 — the token issuing contract.
//
// RFC-221 D1 closed this endpoint globally ("只退不进"). The reason was not that
// issuing tokens is inherently unsafe — it was that the permission catalog of
// the day could not express a narrow one: `资源:write` covered delete as well as
// edit, and an empty scope list silently meant "everything the owner has". A
// token you could not scope is a token you should not mint.
//
// RFC-247 fixed both of those, which is what makes reopening defensible, so
// these tests lock the properties that make it safe rather than the fact that
// the endpoint answers at all.

import { describe, expect, test } from 'bun:test'
import { Hono, type MiddlewareHandler } from 'hono'
import { buildActor, type Actor } from '@/auth/actor'
import { errorHandler, ForbiddenError, ValidationError } from '@/util/errors'
import { registerRoute, resetRouteMetaRegistry, type RouteMeta } from '@/routes/registry'
import { assertMatrixGrantable, PatMatrixError } from '@/auth/patStore'

describe('RFC-247 AC-7 — an over-reaching matrix is refused, not narrowed', () => {
  test('a plain user cannot grant a repos verb', () => {
    // `resolveTokenPermissions` would drop this anyway — a token never exceeds
    // its owner's role — so accepting would still be SAFE. It would still be
    // wrong: the user walks away believing the token can create repo mirrors
    // and finds out when the automation 403s, far from this decision.
    expect(() => assertMatrixGrantable('user', ['repos:create'])).toThrow(PatMatrixError)
  })

  test('the refusal names exactly which points were ungrantable', () => {
    try {
      assertMatrixGrantable('user', ['agents:create', 'users:read', 'repos:delete'])
      throw new Error('expected a throw')
    } catch (err) {
      expect(err).toBeInstanceOf(PatMatrixError)
      // Both bad ones, and NOT the good one — a message that just said
      // "some permissions are invalid" would leave the user guessing.
      expect([...(err as PatMatrixError).ungrantable].sort()).toEqual([
        'repos:delete',
        'users:read',
      ])
    }
  })

  test('a manager CAN grant the repos verbs its role holds', () => {
    expect(() => assertMatrixGrantable('manager', ['repos:create', 'repos:delete'])).not.toThrow()
  })

  test('nobody can grant a system-domain point, admin included', () => {
    for (const role of ['user', 'manager', 'admin'] as const) {
      expect(() => assertMatrixGrantable(role, ['settings:write'])).toThrow(PatMatrixError)
      expect(() => assertMatrixGrantable(role, ['account:self'])).toThrow(PatMatrixError)
    }
  })

  test('an empty matrix is always grantable — it is the read-only token', () => {
    for (const role of ['user', 'manager', 'admin'] as const) {
      expect(() => assertMatrixGrantable(role, [])).not.toThrow()
    }
  })

  test('delete points are grantable when the role has them (they are opt-in, not forbidden)', () => {
    // D4 makes delete EXPLICIT, not unavailable. The matrix may name it; what
    // it may never do is arrive without being named.
    expect(() => assertMatrixGrantable('admin', ['tasks:delete'])).not.toThrow()
    expect(() => assertMatrixGrantable('user', ['tasks:delete'])).toThrow(PatMatrixError)
  })
})

// The remaining codes are raised by route handlers; exercise them through the
// declared gate so the test names the code the same way production emits it.
const OK = () => new Response('ok')

function appWithActor(actor: Actor, meta: RouteMeta, handler = OK): Hono {
  resetRouteMetaRegistry()
  const app = new Hono()
  const inject: MiddlewareHandler = async (c, next) => {
    c.set('actor', actor)
    await next()
  }
  app.use('*', inject)
  app.onError(errorHandler)
  registerRoute(app, meta, handler)
  return app
}

describe('RFC-247 AC-18 — the surface switch and the payload gate name their codes', () => {
  const meta: RouteMeta = {
    method: 'POST',
    path: '/api/auth/pats',
    permissions: ['account:self'],
    tokenAccess: 'never',
    summary: 'Create a personal access token',
  }

  test('token-issuance-disabled is what a closed surface answers', async () => {
    // Locks the CODE, which the account page keys on to explain why the button
    // is refusing. A generic 403 would leave the UI unable to say why.
    const session = buildActor({
      user: { id: 'u1', username: 'u1', displayName: 'U1', role: 'admin', status: 'active' },
      source: 'session',
    })
    const app = appWithActor(session, meta, () => {
      throw new ForbiddenError(
        'token-issuance-disabled',
        'the administrator has disabled the API token surface',
      )
    })
    const res = await app.request('/api/auth/pats', { method: 'POST' })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe('token-issuance-disabled')
  })

  test('pat-invalid is what a malformed creation payload answers', async () => {
    const session = buildActor({
      user: { id: 'u1', username: 'u1', displayName: 'U1', role: 'admin', status: 'active' },
      source: 'session',
    })
    const app = appWithActor(session, meta, () => {
      throw new ValidationError('pat-invalid', 'invalid token payload')
    })
    const res = await app.request('/api/auth/pats', { method: 'POST' })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('pat-invalid')
  })
})
