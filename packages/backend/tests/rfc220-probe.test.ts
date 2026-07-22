// RFC-220 T4 — admin connection probe (design §7, locks §12 S2 probe rows).
//
// The readiness formula must mirror the RUNTIME branch rules (§5), or the
// diagnostic lies in both directions:
//   - jwksUri configured but unreachable → NOT ready even with userinfo
//     present (an IdP that sends an id_token hard-fails on unreachable JWKS,
//     userinfo cannot rescue it — gate rounds 4/5).
//   - subjectClaim mode ignores jwks entirely (runtime never touches it);
//     a dead discovery-provided jwks_uri must not fail an otherwise working
//     pure-OAuth2 provider (gate round 6).

import { beforeEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clearEndpointCaches } from '../src/auth/oidc/endpoints'
import {
  createOidcProvidersService,
  type OidcProvidersService,
} from '../src/services/oidcProviders'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const ISSUER = 'https://idp.example.com'

interface Harness {
  db: DbClient
  svc: OidcProvidersService
}

function buildHarness(): Harness {
  const db = createInMemoryDb(MIGRATIONS)
  const secretBox = createSecretBoxFromKey(randomBytes(32))
  return { db, svc: createOidcProvidersService({ db, secretBox }) }
}

const BASE = {
  slug: 'idp',
  displayName: 'IdP',
  issuerUrl: ISSUER,
  clientId: 'c',
  clientSecret: 's',
  scopes: 'openid',
  provisioning: 'auto' as const,
  allowedEmailDomains: [],
  iconUrl: null,
  enabled: true,
}

/** fetch stub: discovery → doc (or failure), jwks URL → jwksOk. */
function stubFetch(opts: {
  doc?: unknown
  discoveryStatus?: number
  jwksOk?: boolean
  fail?: boolean
}): { fetcher: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push(url)
    if (opts.fail) throw new Error('network down')
    if (url.includes('.well-known')) {
      return new Response(JSON.stringify(opts.doc ?? {}), {
        status: opts.discoveryStatus ?? 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    // anything else is the jwks probe
    return new Response('{"keys":[]}', { status: (opts.jwksOk ?? true) ? 200 : 500 })
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

describe('RFC-220 S2 — probe readiness', () => {
  let h: Harness
  beforeEach(() => {
    clearEndpointCaches()
    h = buildHarness()
  })

  test('discovery-complete OIDC provider with reachable jwks → ready, sources=discovery', async () => {
    const p = await h.svc.create(BASE)
    const { fetcher } = stubFetch({
      doc: {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/a`,
        token_endpoint: `${ISSUER}/t`,
        jwks_uri: `${ISSUER}/jwks`,
        scopes_supported: ['openid'],
      },
    })
    const r = await h.svc.probe(p, fetcher)
    expect(r.ok).toBe(true)
    expect(r.discovery.ok).toBe(true)
    expect(r.jwksReachable).toBe(true)
    expect(r.endpoints.tokenEndpoint).toEqual({ url: `${ISSUER}/t`, source: 'discovery' })
    expect(r.scopesSupported).toEqual(['openid'])
  })

  test('jwks 200 with a non-JWKS body counts as unreachable (impl-gate P2)', async () => {
    const p = await h.svc.create(BASE)
    const calls: string[] = []
    const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push(url)
      if (url.includes('.well-known')) {
        return new Response(
          JSON.stringify({
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/a`,
            token_endpoint: `${ISSUER}/t`,
            jwks_uri: `${ISSUER}/jwks`,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      // 200 but an HTML error page — createRemoteJWKSet would fail every verify
      return new Response('<html>gateway</html>', { status: 200 })
    }) as unknown as typeof fetch
    const r = await h.svc.probe(p, fetcher)
    expect(r.jwksReachable).toBe(false)
    expect(r.ok).toBe(false)
  })

  test('jwks unreachable → NOT ready even with userinfo configured (fail-closed)', async () => {
    const p = await h.svc.create({ ...BASE, userinfoEndpoint: 'https://m.test/me' })
    const { fetcher } = stubFetch({
      doc: {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/a`,
        token_endpoint: `${ISSUER}/t`,
        jwks_uri: `${ISSUER}/jwks`,
      },
      jwksOk: false,
    })
    const r = await h.svc.probe(p, fetcher)
    expect(r.jwksReachable).toBe(false)
    expect(r.ok).toBe(false)
  })

  test('subjectClaim mode: jwks ignored (not probed), userinfo decides readiness', async () => {
    const p = await h.svc.create({
      ...BASE,
      subjectClaim: 'id',
      userinfoEndpoint: 'https://m.test/me',
      authorizationEndpoint: 'https://m.test/a',
      tokenEndpoint: 'https://m.test/t',
    })
    // discovery advertises a DEAD jwks_uri — must not matter in this mode
    const { fetcher, calls } = stubFetch({
      doc: { issuer: ISSUER, jwks_uri: `${ISSUER}/dead-jwks` },
      jwksOk: false,
    })
    const r = await h.svc.probe(p, fetcher)
    expect(r.ok).toBe(true)
    expect(r.jwksReachable).toBeUndefined()
    expect(calls.some((u) => u.includes('dead-jwks'))).toBe(false)
    // …and without userinfo the same mode is NOT ready
    clearEndpointCaches()
    const p2 = await h.svc.create({
      ...BASE,
      slug: 'idp2',
      subjectClaim: 'id',
      authorizationEndpoint: 'https://m.test/a',
      tokenEndpoint: 'https://m.test/t',
      jwksUri: 'https://m.test/jwks',
    })
    const r2 = await h.svc.probe(p2, stubFetch({ discoveryStatus: 404 }).fetcher)
    expect(r2.ok).toBe(false)
  })

  test('discovery down + full manual → ready with sources=manual and discovery.error surfaced', async () => {
    const p = await h.svc.create({
      ...BASE,
      authorizationEndpoint: 'https://m.test/a',
      tokenEndpoint: 'https://m.test/t',
      userinfoEndpoint: 'https://m.test/me',
    })
    const r = await h.svc.probe(p, stubFetch({ fail: true }).fetcher)
    expect(r.ok).toBe(true)
    expect(r.discovery.ok).toBe(false)
    expect(r.discovery.error).toContain('network down')
    expect(r.endpoints.authorizationEndpoint).toEqual({ url: 'https://m.test/a', source: 'manual' })
    expect(r.endpoints.jwksUri).toBeNull()
  })

  test('probe bypasses the caches (forceFresh) — fresh state, not up to 1h stale', async () => {
    const p = await h.svc.create({
      ...BASE,
      authorizationEndpoint: 'https://m.test/a',
      tokenEndpoint: 'https://m.test/t',
      userinfoEndpoint: 'https://m.test/me',
    })
    // first probe fails discovery (and negative-caches it — manual is viable)
    const r1 = await h.svc.probe(p, stubFetch({ fail: true }).fetcher)
    expect(r1.discovery.ok).toBe(false)
    // second probe with a healthy IdP must go out and see it immediately —
    // a negative-cache hit would report discovery as still down
    const healthy = stubFetch({
      doc: { issuer: ISSUER, token_endpoint: `${ISSUER}/t2` },
    })
    const r2 = await h.svc.probe(p, healthy.fetcher)
    expect(r2.discovery.ok).toBe(true)
    expect(r2.endpoints.tokenEndpoint).toEqual({ url: `${ISSUER}/t2`, source: 'discovery' })
  })
})
