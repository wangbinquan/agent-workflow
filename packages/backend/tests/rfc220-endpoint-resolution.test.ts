// RFC-220 T2 — resolveEndpoints (design §3, locks §12 S3).
//
// The two properties that must never regress:
//   1. D1 merge: discovery wins per FIELD, manual fills gaps, a malformed
//      discovery value counts as missing (it must not shadow a valid manual
//      fallback, and must never reach `new URL` in a login path).
//   2. Cache gates: a cached entry — positive or negative — is only honored
//      when the merged result is loginViable. Without that gate a transient
//      discovery failure (or a transient 200 `{}`) becomes a 5min-1h outage
//      amplifier for standard OIDC IdPs with no manual fallback (design-gate
//      rounds 2/3 P1).

import { beforeEach, describe, expect, test } from 'bun:test'
import {
  clearEndpointCaches,
  getJwksInstance,
  loginViable,
  resolveEndpoints,
} from '../src/auth/oidc/endpoints'

const ISSUER = 'https://idp.example.com'

function stubFetch(respond: (url: string) => { status?: number; body: unknown }): {
  fetcher: typeof fetch
  calls: string[]
} {
  const calls: string[] = []
  const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push(url)
    const { status = 200, body } = respond(url)
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

function failingFetch(): { fetcher: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
    calls.push(typeof input === 'string' ? input : input.toString())
    throw new Error('network down')
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

const NO_MANUAL = {
  issuerUrl: ISSUER,
  authorizationEndpoint: null,
  tokenEndpoint: null,
  userinfoEndpoint: null,
  jwksUri: null,
  subjectClaim: null,
}

const FULL_MANUAL = {
  issuerUrl: ISSUER,
  authorizationEndpoint: 'https://manual.test/authorize',
  tokenEndpoint: 'https://manual.test/token',
  userinfoEndpoint: 'https://manual.test/userinfo',
  jwksUri: 'https://manual.test/jwks',
  subjectClaim: null,
}

const FULL_DOC = {
  issuer: ISSUER,
  authorization_endpoint: 'https://disc.test/authorize',
  token_endpoint: 'https://disc.test/token',
  userinfo_endpoint: 'https://disc.test/userinfo',
  jwks_uri: 'https://disc.test/jwks',
  scopes_supported: ['openid', 'profile', 42, 'email'],
}

describe('RFC-220 S3 — resolveEndpoints', () => {
  beforeEach(() => clearEndpointCaches())

  test('full discovery document wins every field over manual', async () => {
    const { fetcher } = stubFetch(() => ({ body: FULL_DOC }))
    const eff = await resolveEndpoints(FULL_MANUAL, { fetcher })
    expect(eff.authorizationEndpoint).toBe('https://disc.test/authorize')
    expect(eff.tokenEndpoint).toBe('https://disc.test/token')
    expect(eff.userinfoEndpoint).toBe('https://disc.test/userinfo')
    expect(eff.jwksUri).toBe('https://disc.test/jwks')
    expect(eff.sources.tokenEndpoint).toBe('discovery')
    expect(eff.issuer).toBe(ISSUER)
    expect(eff.discoveryOk).toBe(true)
    // runtime-validated passthrough drops the non-string entry
    expect(eff.scopesSupported).toEqual(['openid', 'profile', 'email'])
  })

  test('partial document: manual fills the gaps per field (D1)', async () => {
    const { fetcher } = stubFetch(() => ({
      body: { issuer: ISSUER, token_endpoint: 'https://disc.test/token' },
    }))
    const eff = await resolveEndpoints(FULL_MANUAL, { fetcher })
    expect(eff.tokenEndpoint).toBe('https://disc.test/token')
    expect(eff.sources.tokenEndpoint).toBe('discovery')
    expect(eff.authorizationEndpoint).toBe('https://manual.test/authorize')
    expect(eff.sources.authorizationEndpoint).toBe('manual')
    expect(eff.userinfoEndpoint).toBe('https://manual.test/userinfo')
    expect(eff.discoveryOk).toBe(true)
  })

  test('malformed discovery fields count as missing and do not shadow manual', async () => {
    const { fetcher } = stubFetch(() => ({
      body: {
        issuer: ISSUER,
        authorization_endpoint: '',
        token_endpoint: 1234,
        userinfo_endpoint: 'javascript:alert(1)',
        jwks_uri: 'not a url',
      },
    }))
    const eff = await resolveEndpoints(FULL_MANUAL, { fetcher })
    expect(eff.authorizationEndpoint).toBe('https://manual.test/authorize')
    expect(eff.tokenEndpoint).toBe('https://manual.test/token')
    expect(eff.userinfoEndpoint).toBe('https://manual.test/userinfo')
    expect(eff.jwksUri).toBe('https://manual.test/jwks')
    expect(eff.sources.authorizationEndpoint).toBe('manual')
  })

  test('discovery failure → all manual, issuer stays issuerUrl VERBATIM', async () => {
    const { fetcher } = failingFetch()
    const withSlash = { ...FULL_MANUAL, issuerUrl: 'https://idp.example.com/' }
    const eff = await resolveEndpoints(withSlash, { fetcher })
    expect(eff.discoveryOk).toBe(false)
    expect(eff.discoveryError).toContain('network down')
    expect(eff.tokenEndpoint).toBe('https://manual.test/token')
    // exact-string iss expectation: the trailing slash is preserved
    expect(eff.issuer).toBe('https://idp.example.com/')
  })

  test('both missing → null fields with sources none', async () => {
    const { fetcher } = stubFetch(() => ({ body: { issuer: ISSUER } }))
    const eff = await resolveEndpoints(NO_MANUAL, { fetcher })
    expect(eff.authorizationEndpoint).toBeNull()
    expect(eff.sources.authorizationEndpoint).toBe('none')
    expect(eff.jwksUri).toBeNull()
  })

  test('viable positive hit is cached: second resolve does not fetch', async () => {
    const { fetcher, calls } = stubFetch(() => ({ body: FULL_DOC }))
    await resolveEndpoints(NO_MANUAL, { fetcher, now: 1000 })
    await resolveEndpoints(NO_MANUAL, { fetcher, now: 2000 })
    expect(calls.length).toBe(1)
    // …and expires after the 1h TTL
    await resolveEndpoints(NO_MANUAL, { fetcher, now: 1000 + 60 * 60 * 1000 + 1 })
    expect(calls.length).toBe(2)
  })

  test('non-viable positive hit (200 {}) re-probes on every call — no outage fixation', async () => {
    const { fetcher, calls } = stubFetch(() => ({ body: {} }))
    await resolveEndpoints(NO_MANUAL, { fetcher, now: 1000 })
    await resolveEndpoints(NO_MANUAL, { fetcher, now: 2000 })
    await resolveEndpoints(NO_MANUAL, { fetcher, now: 3000 })
    expect(calls.length).toBe(3)
    // IdP recovery is picked up immediately on the next call
    const healthy = stubFetch(() => ({ body: FULL_DOC }))
    const eff = await resolveEndpoints(NO_MANUAL, { fetcher: healthy.fetcher, now: 4000 })
    expect(eff.tokenEndpoint).toBe('https://disc.test/token')
  })

  test('negative cache holds ONLY for a fully viable manual config', async () => {
    const { fetcher, calls } = failingFetch()
    await resolveEndpoints(FULL_MANUAL, { fetcher, now: 1000 })
    const eff = await resolveEndpoints(FULL_MANUAL, { fetcher, now: 2000 })
    expect(calls.length).toBe(1) // window hit → straight to manual, no probe
    expect(eff.discoveryOk).toBe(false)
    expect(eff.tokenEndpoint).toBe('https://manual.test/token')
    // window expiry re-probes
    await resolveEndpoints(FULL_MANUAL, { fetcher, now: 1000 + 5 * 60 * 1000 + 1 })
    expect(calls.length).toBe(2)
  })

  test('negative cache is NOT honored without a full identity channel', async () => {
    const { fetcher, calls } = failingFetch()
    // start-only manual config: authorize+token but no userinfo/jwks — a
    // cached failure here would let start redirect while every callback dies.
    const halfViable = {
      ...NO_MANUAL,
      authorizationEndpoint: 'https://manual.test/authorize',
      tokenEndpoint: 'https://manual.test/token',
    }
    await resolveEndpoints(halfViable, { fetcher, now: 1000 })
    await resolveEndpoints(halfViable, { fetcher, now: 2000 })
    expect(calls.length).toBe(2) // re-probed every call
  })

  test('subjectClaim mode: jwks is not an identity channel (D6)', async () => {
    const jwksOnly = {
      ...NO_MANUAL,
      authorizationEndpoint: 'https://manual.test/authorize',
      tokenEndpoint: 'https://manual.test/token',
      jwksUri: 'https://manual.test/jwks',
    }
    expect(loginViable(jwksOnly, { subjectClaim: null })).toBe(true)
    expect(loginViable(jwksOnly, { subjectClaim: 'id' })).toBe(false)
    const withUserinfo = { ...jwksOnly, userinfoEndpoint: 'https://manual.test/userinfo' }
    expect(loginViable(withUserinfo, { subjectClaim: 'id' })).toBe(true)
    // and the negative cache respects the mode: jwks-only manual + subjectClaim
    // re-probes every call instead of serving the half-viable window
    const { fetcher, calls } = failingFetch()
    const provider = { ...jwksOnly, subjectClaim: 'id' }
    await resolveEndpoints(provider, { fetcher, now: 1000 })
    await resolveEndpoints(provider, { fetcher, now: 2000 })
    expect(calls.length).toBe(2)
  })

  test('forceFresh bypasses both caches and overwrites them', async () => {
    const { fetcher, calls } = stubFetch(() => ({ body: FULL_DOC }))
    await resolveEndpoints(NO_MANUAL, { fetcher, now: 1000 })
    expect(calls.length).toBe(1)
    const fresh = stubFetch(() => ({
      body: { ...FULL_DOC, token_endpoint: 'https://disc.test/v2/token' },
    }))
    const eff = await resolveEndpoints(NO_MANUAL, {
      fetcher: fresh.fetcher,
      now: 2000,
      forceFresh: true,
    })
    expect(fresh.calls.length).toBe(1)
    expect(eff.tokenEndpoint).toBe('https://disc.test/v2/token')
    // the fresh result replaced the cached entry
    const after = await resolveEndpoints(NO_MANUAL, { fetcher, now: 3000 })
    expect(after.tokenEndpoint).toBe('https://disc.test/v2/token')
    expect(calls.length).toBe(1)
  })

  test('a fresh failure evicts the stale positive entry (impl-gate P2)', async () => {
    // healthy → cached; then a forceFresh probe fails; once the (shorter)
    // negative window lapses, the old positive entry must NOT resurrect the
    // stale discovery URLs — the next resolve goes back to the network.
    const healthy = stubFetch(() => ({ body: FULL_DOC }))
    await resolveEndpoints(FULL_MANUAL, { fetcher: healthy.fetcher, now: 1000 })
    const failing = failingFetch()
    await resolveEndpoints(FULL_MANUAL, { fetcher: failing.fetcher, now: 2000, forceFresh: true })
    const after = stubFetch(() => ({
      body: { ...FULL_DOC, token_endpoint: 'https://disc.test/v3/token' },
    }))
    const eff = await resolveEndpoints(FULL_MANUAL, {
      fetcher: after.fetcher,
      now: 2000 + 5 * 60 * 1000 + 1,
    })
    expect(after.calls.length).toBe(1) // refetched, not served from the old entry
    expect(eff.tokenEndpoint).toBe('https://disc.test/v3/token')
  })

  test('failure is never cached as success', async () => {
    const bad = failingFetch()
    await resolveEndpoints(FULL_MANUAL, { fetcher: bad.fetcher, now: 1000 })
    // after the negative window, a healthy IdP is picked up — the failure
    // entry did not morph into a positive one
    const healthy = stubFetch(() => ({ body: FULL_DOC }))
    const eff = await resolveEndpoints(FULL_MANUAL, {
      fetcher: healthy.fetcher,
      now: 1000 + 5 * 60 * 1000 + 1,
    })
    expect(eff.discoveryOk).toBe(true)
    expect(eff.tokenEndpoint).toBe('https://disc.test/token')
  })

  test('getJwksInstance caches per resolved jwks_uri', () => {
    const a = getJwksInstance('https://manual.test/jwks')
    const b = getJwksInstance('https://manual.test/jwks')
    const c = getJwksInstance('https://other.test/jwks')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})
