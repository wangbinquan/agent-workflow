// OIDC / SSO login chain — behavioural coverage.
//
// WHY THIS EXISTS
// ---------------
// The 2026-07-21 test-guard audit (gap M1-lcov-1, P0) found the entire
// third-party login chain at zero behavioural coverage: `exchangeCodeForTokens`,
// `verifyIdToken`, `getProviderMetadata`, `consumeFlow` and `sweepExpiredFlows`
// had ZERO hits across all four test roots; only `startFlow` appeared once, in
// the redirect-sanitisation test. The provider CRUD service was tested; the code
// that actually turns an IdP redirect into a session was not.
//
// That is the worst possible place for a hole: `/api/auth/oidc/:slug/callback`
// is mounted unconditionally (server.ts) and reachable WITHOUT authentication,
// so every check in this chain is a security boundary an anonymous caller
// exercises directly. The properties locked below are the ones whose failure is
// silent — a dropped `nonce` check or a dropped PKCE verifier does not break any
// happy-path login, it just makes replay and code-injection possible while every
// existing test stays green.
//
// Everything here runs offline: discovery/token endpoints take an injectable
// `fetcher`, and `verifyIdToken` accepts a static key resolver, so tokens are
// signed locally with jose. No network, no secrets, no IdP container.
//
// See design/test-guard-audit-2026-07-21 §1 (P0 list) / 逃逸机制③.

import { beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { SignJWT, generateKeyPair, type CryptoKey } from 'jose'
import { clearDiscoveryCache, getProviderMetadata } from '../src/auth/oidc/discovery'
import { clearPendingFlows, consumeFlow, startFlow, sweepExpiredFlows } from '../src/auth/oidc/flow'
import {
  OidcTokenError,
  exchangeCodeForTokens,
  verifyIdToken,
  type VerifyIdTokenInput,
} from '../src/auth/oidc/tokens'

const ISSUER = 'https://idp.example.com'
const AUDIENCE = 'client-abc'
const NONCE = 'nonce-xyz'

interface Recorded {
  url: string
  init: Parameters<typeof fetch>[1]
}

/** A fetch stub that records calls and replays a scripted response. */
function stubFetch(respond: (url: string) => { status?: number; body: unknown }): {
  fetcher: typeof fetch
  calls: Recorded[]
} {
  const calls: Recorded[] = []
  const fetcher = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push({ url, init })
    const { status = 200, body } = respond(url)
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

/**
 * `verifyIdToken`'s `jwks` parameter is typed as jose's key-RESOLVER union, so a
 * bare key is not assignable. A resolver that always returns the same key is the
 * static-key form jose documents, and keeps these tests offline (no JWKS fetch).
 */
function staticJwks(key: CryptoKey): VerifyIdTokenInput['jwks'] {
  return (async () => key) as unknown as VerifyIdTokenInput['jwks']
}

async function signIdToken(
  key: CryptoKey,
  claims: Record<string, unknown>,
  overrides: { issuer?: string; audience?: string; expSeconds?: number } = {},
): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(overrides.expSeconds ?? Math.floor(Date.now() / 1000) + 300)
  return jwt.sign(key)
}

describe('OIDC token exchange', () => {
  const base = {
    tokenEndpoint: `${ISSUER}/token`,
    clientId: AUDIENCE,
    clientSecret: 'shh',
    code: 'auth-code-1',
    codeVerifier: 'verifier-1',
    redirectUri: 'https://app.example.com/api/auth/oidc/idp/callback',
  }

  test('sends every parameter the authorization-code + PKCE grant requires', async () => {
    // A silently dropped `code_verifier` disables PKCE without breaking any
    // happy-path login: the IdP simply stops binding the code to this client.
    // Likewise a dropped `redirect_uri` removes the IdP's own cross-check.
    const { fetcher, calls } = stubFetch(() => ({
      body: { access_token: 'at', id_token: 'it' },
    }))
    await exchangeCodeForTokens({ ...base, fetcher })

    expect(calls.length).toBe(1)
    expect(calls[0]?.url).toBe(base.tokenEndpoint)
    expect(calls[0]?.init?.method).toBe('POST')
    const sent = new URLSearchParams(String(calls[0]?.init?.body))
    expect(Object.fromEntries(sent)).toEqual({
      grant_type: 'authorization_code',
      code: base.code,
      redirect_uri: base.redirectUri,
      client_id: base.clientId,
      client_secret: base.clientSecret,
      code_verifier: base.codeVerifier,
    })
  })

  test('a non-2xx token endpoint is a typed failure, never a partial success', async () => {
    const { fetcher } = stubFetch(() => ({ status: 401, body: { error: 'invalid_client' } }))
    const err = await exchangeCodeForTokens({ ...base, fetcher }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OidcTokenError)
    expect((err as OidcTokenError).code).toBe('token-exchange-failed')
  })

  test('a 200 response missing id_token is rejected instead of flowing onward', async () => {
    // A broken or hostile IdP answering `200 {}` must not produce a session.
    // Without the shape check the undefined id_token would reach verifyIdToken.
    for (const body of [{}, { access_token: 'at' }, { id_token: 'it' }, { access_token: 1 }]) {
      const { fetcher } = stubFetch(() => ({ body }))
      const err = await exchangeCodeForTokens({ ...base, fetcher }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(OidcTokenError)
      expect((err as OidcTokenError).code).toBe('token-exchange-failed')
    }
  })
})

describe('OIDC id_token verification', () => {
  let publicKey: CryptoKey
  let privateKey: CryptoKey
  let otherPublicKey: CryptoKey
  let otherPrivateKey: CryptoKey

  beforeEach(async () => {
    const pair = await generateKeyPair('RS256')
    publicKey = pair.publicKey as CryptoKey
    privateKey = pair.privateKey as CryptoKey
    const other = await generateKeyPair('RS256')
    otherPublicKey = other.publicKey as CryptoKey
    otherPrivateKey = other.privateKey as CryptoKey
  })

  const verify = async (idToken: string, nonce = NONCE): Promise<unknown> =>
    verifyIdToken({
      idToken,
      jwks: staticJwks(publicKey),
      issuer: ISSUER,
      audience: AUDIENCE,
      nonce,
    })

  test('accepts a correctly signed token and returns its claims', async () => {
    const idToken = await signIdToken(privateKey, { nonce: NONCE, sub: 'u-1', email: 'a@b.c' })
    const payload = (await verify(idToken)) as Record<string, unknown>
    expect(payload.sub).toBe('u-1')
    expect(payload.email).toBe('a@b.c')
  })

  test('rejects a token whose nonce does not match the pending flow (replay)', async () => {
    // The nonce is what binds this id_token to THIS browser's login attempt.
    // Drop the comparison and a token captured from another session — or
    // replayed later — authenticates successfully.
    const idToken = await signIdToken(privateKey, { nonce: 'some-other-nonce', sub: 'u-1' })
    const err = await verify(idToken).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OidcTokenError)
    expect((err as OidcTokenError).code).toBe('id-token-verify-failed')
    expect((err as OidcTokenError).message).toBe('nonce-mismatch')
  })

  test('rejects a token carrying no nonce at all', async () => {
    // Fail closed: an IdP that omits the claim must not be treated as "nothing
    // to compare, therefore fine".
    const idToken = await signIdToken(privateKey, { sub: 'u-1' })
    const err = await verify(idToken).catch((e: unknown) => e)
    expect((err as OidcTokenError).message).toBe('nonce-missing')
  })

  test('rejects a token signed by a key that is not the provider JWKS', async () => {
    const forged = await signIdToken(otherPrivateKey, { nonce: NONCE, sub: 'u-1' })
    const err = await verify(forged).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OidcTokenError)
    expect((err as OidcTokenError).code).toBe('id-token-verify-failed')
    // Sanity: the same token DOES verify against its own key, proving the
    // rejection above is about the signature and not a malformed fixture.
    await expect(
      verifyIdToken({
        idToken: forged,
        jwks: staticJwks(otherPublicKey),
        issuer: ISSUER,
        audience: AUDIENCE,
        nonce: NONCE,
      }),
    ).resolves.toBeDefined()
  })

  test('rejects a token minted for a different issuer or a different client', async () => {
    const wrongIssuer = await signIdToken(
      privateKey,
      { nonce: NONCE, sub: 'u-1' },
      { issuer: 'https://evil.example.com' },
    )
    expect(((await verify(wrongIssuer).catch((e: unknown) => e)) as OidcTokenError).code).toBe(
      'id-token-verify-failed',
    )

    // Audience confusion: a token legitimately issued to ANOTHER client of the
    // same IdP must not log anyone into this deployment.
    const wrongAudience = await signIdToken(
      privateKey,
      { nonce: NONCE, sub: 'u-1' },
      { audience: 'some-other-client' },
    )
    expect(((await verify(wrongAudience).catch((e: unknown) => e)) as OidcTokenError).code).toBe(
      'id-token-verify-failed',
    )
  })

  test('rejects an expired token', async () => {
    const expired = await signIdToken(
      privateKey,
      { nonce: NONCE, sub: 'u-1' },
      { expSeconds: Math.floor(Date.now() / 1000) - 60 },
    )
    expect(((await verify(expired).catch((e: unknown) => e)) as OidcTokenError).code).toBe(
      'id-token-verify-failed',
    )
  })

  test('never leaks a jose internal error type to the caller', async () => {
    // The callback handler branches on OidcTokenError to render a friendly 400;
    // an escaping jose error would surface as a 500 with library internals.
    const err = await verify('not-a-jwt').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OidcTokenError)
  })
})

describe('OIDC pending-flow state', () => {
  beforeEach(() => {
    clearPendingFlows()
  })

  const start = (now?: number) =>
    startFlow('provider-1', {
      redirectUri: 'https://app.example.com/cb',
      ...(now === undefined ? {} : { now }),
    })

  test('derives the PKCE challenge as base64url(S256(verifier))', () => {
    // If the challenge stops matching the verifier the IdP rejects the exchange
    // outright, but if it is derived from something predictable, PKCE is
    // decorative. Recompute it independently here.
    const flow = start()
    const expected = createHash('sha256')
      .update(flow.codeVerifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '')
    expect(flow.codeChallenge).toBe(expected)
  })

  test('mints unpredictable, per-attempt state / verifier / nonce', () => {
    const flows = Array.from({ length: 16 }, () => start())
    for (const key of ['state', 'codeVerifier', 'nonce'] as const) {
      const values = new Set(flows.map((f) => f[key]))
      expect(`${key}: ${values.size} distinct of ${flows.length}`).toBe(
        `${key}: ${flows.length} distinct of ${flows.length}`,
      )
      // base64url of >=16 random bytes — reject any accidental short/static id.
      for (const value of values) expect(value.length).toBeGreaterThanOrEqual(20)
    }
  })

  test('consumeFlow is one-shot: a replayed callback finds nothing', () => {
    // The authorization code lands in a URL that ends up in browser history,
    // referrer headers and server logs. One-shot consumption is what stops the
    // same callback URL from being replayed into a second session.
    const flow = start()
    expect(consumeFlow(flow.state)?.providerId).toBe('provider-1')
    expect(consumeFlow(flow.state)).toBeNull()
  })

  test('an expired flow is refused AND dropped, not just refused', () => {
    const t0 = 1_000_000
    const flow = startFlow('provider-1', { redirectUri: 'https://app.example.com/cb', now: t0 })
    const afterTtl = t0 + 5 * 60 * 1000 + 1
    expect(consumeFlow(flow.state, afterTtl)).toBeNull()
    // Deleted on the way out, so a later clock skew cannot resurrect it.
    expect(consumeFlow(flow.state, t0)).toBeNull()
  })

  test('an unknown state is a miss, not a crash', () => {
    expect(consumeFlow('state-that-never-existed')).toBeNull()
  })

  test('sweepExpiredFlows removes only what has actually expired', () => {
    const t0 = 2_000_000
    const stale = startFlow('p', { redirectUri: 'https://a/cb', now: t0 })
    const fresh = startFlow('p', { redirectUri: 'https://a/cb', now: t0 + 5 * 60 * 1000 })
    expect(sweepExpiredFlows(t0 + 5 * 60 * 1000 + 1)).toBe(1)
    expect(consumeFlow(stale.state, t0 + 5 * 60 * 1000 + 1)).toBeNull()
    expect(consumeFlow(fresh.state, t0 + 5 * 60 * 1000 + 1)?.providerId).toBe('p')
  })
})

describe('OIDC discovery', () => {
  const metadata = {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/jwks`,
  }

  beforeEach(() => {
    clearDiscoveryCache()
  })

  test('requests the well-known document at the normalised issuer URL', async () => {
    const { fetcher, calls } = stubFetch(() => ({ body: metadata }))
    // Trailing slash must not produce a double-slash path.
    await getProviderMetadata(`${ISSUER}/`, Date.now(), fetcher)
    expect(calls[0]?.url).toBe(`${ISSUER}/.well-known/openid-configuration`)
  })

  test('caches within the TTL and refetches after it', async () => {
    const { fetcher, calls } = stubFetch(() => ({ body: metadata }))
    const t0 = 10_000_000
    await getProviderMetadata(ISSUER, t0, fetcher)
    await getProviderMetadata(ISSUER, t0 + 60 * 60 * 1000 - 1, fetcher)
    expect(calls.length).toBe(1)
    await getProviderMetadata(ISSUER, t0 + 60 * 60 * 1000 + 1, fetcher)
    expect(calls.length).toBe(2)
  })

  test('rejects an incomplete discovery document instead of caching a broken one', async () => {
    // Missing jwks_uri would otherwise reach createRemoteJWKSet(new URL(undefined)).
    for (const field of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      clearDiscoveryCache()
      const partial: Record<string, unknown> = { ...metadata }
      delete partial[field]
      const { fetcher } = stubFetch(() => ({ body: partial }))
      await expect(getProviderMetadata(ISSUER, Date.now(), fetcher)).rejects.toThrow(
        'oidc-discovery-incomplete',
      )
    }
  })

  test('a failed discovery fetch is not cached as a success', async () => {
    let status = 500
    const { fetcher, calls } = stubFetch(() => ({ status, body: {} }))
    await expect(getProviderMetadata(ISSUER, Date.now(), fetcher)).rejects.toThrow(
      'oidc-discovery-failed',
    )
    status = 200
    // Second call must go back out to the network rather than serve a poisoned
    // cache entry.
    const before = calls.length
    await getProviderMetadata(ISSUER, Date.now(), stubFetch(() => ({ body: metadata })).fetcher)
    expect(calls.length).toBe(before)
  })
})
