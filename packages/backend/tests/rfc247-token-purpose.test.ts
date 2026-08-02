// RFC-247 D2 / AC-9 / AC-30 / AC-37 — the purpose gate on both channels.
//
// A token is issued for one of two uses, and the distinction only means
// something if it is enforced everywhere the credential can be presented. There
// are two such places and they share no code:
//
//   HTTP — `registerRoute`'s derived gate, after the `tokenAccess: 'never'`
//          check so the permanent reason wins over the reissuable one.
//   WS   — `ws/server.ts` `tryUpgrade`, which runs inside Bun.serve's fetch
//          handler ENTIRELY OUTSIDE `multiAuth`. Nothing the route layer does
//          reaches it, so the rule has to be restated there or an `mcp_only`
//          token that cannot call `GET /api/tasks` could simply subscribe to
//          `/ws/tasks/:id` for the same data.

import { describe, expect, test, beforeEach } from 'bun:test'
import { Hono, type MiddlewareHandler } from 'hono'
import { buildActor, type Actor } from '@/auth/actor'
import { errorHandler } from '@/util/errors'
import { registerRoute, resetRouteMetaRegistry, type RouteMeta } from '@/routes/registry'

const OK = () => new Response('ok')

beforeEach(() => {
  resetRouteMetaRegistry()
})

function tokenActor(purpose: 'general' | 'mcp_only'): Actor {
  return buildActor({
    user: { id: 'u1', username: 'u1', displayName: 'U1', role: 'admin', status: 'active' },
    source: 'pat',
    patScopes: ['agents:create', 'agents:update'],
    patPurpose: purpose,
  })
}

function appWith(actor: Actor, meta: RouteMeta): Hono {
  const app = new Hono()
  const inject: MiddlewareHandler = async (c, next) => {
    c.set('actor', actor)
    await next()
  }
  app.use('*', inject)
  app.onError(errorHandler)
  registerRoute(app, meta, OK)
  return app
}

const BUSINESS: RouteMeta = {
  method: 'POST',
  path: '/api/agents',
  permissions: ['agents:create'],
  tokenAccess: 'allow',
  summary: 'Create an agent',
}

const AUTH_SURFACE: RouteMeta = {
  method: 'GET',
  path: '/api/auth/me',
  permissions: ['account:self'],
  tokenAccess: 'never',
  summary: 'Current actor',
}

describe('RFC-247 AC-9 — mcp_only tokens cannot use the REST API', () => {
  test('a business route answers 403 token-mcp-only', async () => {
    const res = await appWith(tokenActor('mcp_only'), BUSINESS).request('/api/agents', {
      method: 'POST',
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe('token-mcp-only')
  })

  test('the SAME matrix works when the token is issued as general', async () => {
    // Proves the refusal is about PURPOSE, not about the permission matrix —
    // otherwise this test would 403 for the same reason and prove nothing.
    const res = await appWith(tokenActor('general'), BUSINESS).request('/api/agents', {
      method: 'POST',
    })
    expect(res.status).toBe(200)
  })

  test('a session actor is unaffected by purpose entirely', async () => {
    const session = buildActor({
      user: { id: 'u2', username: 'u2', displayName: 'U2', role: 'admin', status: 'active' },
      source: 'session',
    })
    const res = await appWith(session, BUSINESS).request('/api/agents', { method: 'POST' })
    expect(res.status).toBe(200)
  })
})

describe('RFC-247 — gate ordering: the permanent reason wins', () => {
  test('mcp_only + tokenAccess:never reports the never, not the purpose', async () => {
    // `/api/auth/me` is closed to EVERY token (D6). Reporting `token-mcp-only`
    // would imply reissuing the token as `general` would open it — it would
    // not. The answer has to stay stable across a reissue.
    const res = await appWith(tokenActor('mcp_only'), AUTH_SURFACE).request('/api/auth/me')
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe('token-forbidden-route')
  })

  test('general + tokenAccess:never is refused for the same reason', async () => {
    const res = await appWith(tokenActor('general'), AUTH_SURFACE).request('/api/auth/me')
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe('token-forbidden-route')
  })
})

describe('RFC-247 — buildActor defaults purpose to the narrower channel', () => {
  test('a token with no recorded purpose is treated as mcp_only', () => {
    // Fail closed: a row that predates the column, or any future path that
    // forgets to pass it, must not silently become a general REST credential.
    const actor = buildActor({
      user: { id: 'u1', username: 'u1', displayName: 'U1', role: 'admin', status: 'active' },
      source: 'pat',
      patScopes: [],
    })
    expect(actor.purpose).toBe('mcp_only')
  })

  test('session actors carry no purpose at all', () => {
    const actor = buildActor({
      user: { id: 'u1', username: 'u1', displayName: 'U1', role: 'admin', status: 'active' },
      source: 'session',
    })
    expect(actor.purpose).toBeUndefined()
  })
})
