// RFC-220 T3 — acquireIdentityClaims branch matrix + claim extraction
// (design §5, locks §12 S5/S6/S12/S13).
//
// The security invariants this file exists to hold:
//   - An UNVERIFIED id_token is never a claims source (fallback branches
//     ignore it — the userinfo result must win even when both disagree).
//   - The verify/fallback decision looks at CONFIG state only. Runtime JWKS
//     fetch failures stay hard failures: deciding on runtime state would let
//     an attacker downgrade signature verification by DoS-ing the JWKS URL.
//   - subjectClaim (D6) is a mode switch to a SINGLE subject namespace:
//     configured → identity always comes from userinfo, id_token claims never
//     appear in the result.
//   - Identity keys are never lossily normalized (unsafe-integer ids fold
//     adjacent IdP users into one local subject) and never silently
//     re-sourced (no sub←id fallback — D2 as revised in gate round 4).

import { describe, expect, test } from 'bun:test'
import { SignJWT, generateKeyPair, type CryptoKey } from 'jose'
import {
  acquireIdentityClaims,
  composePreferred,
  extractUserinfoClaims,
  readClaimField,
} from '../src/auth/oidc/identity'
import { OidcTokenError, type VerifyIdTokenInput } from '../src/auth/oidc/tokens'
import type { EffectiveEndpoints } from '../src/auth/oidc/endpoints'

const ISSUER = 'https://idp.example.com'
const AUDIENCE = 'client-abc'
const NONCE = 'nonce-xyz'

function effective(overrides: Partial<EffectiveEndpoints>): EffectiveEndpoints {
  return {
    authorizationEndpoint: `${ISSUER}/authorize`,
    tokenEndpoint: `${ISSUER}/token`,
    userinfoEndpoint: null,
    jwksUri: null,
    issuer: ISSUER,
    sources: {
      authorizationEndpoint: 'manual',
      tokenEndpoint: 'manual',
      userinfoEndpoint: 'none',
      jwksUri: 'none',
    },
    scopesSupported: [],
    discoveryOk: false,
    ...overrides,
  }
}

function userinfoFetcher(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
}

function staticJwks(key: CryptoKey): VerifyIdTokenInput['jwks'] {
  return (async () => key) as unknown as VerifyIdTokenInput['jwks']
}

async function signIdToken(key: CryptoKey, claims: Record<string, unknown>): Promise<string> {
  return new SignJWT({ nonce: NONCE, ...claims })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key)
}

async function expectTokenError(promise: Promise<unknown>, code: OidcTokenError['code']) {
  const err = await promise.catch((e: unknown) => e)
  expect(err).toBeInstanceOf(OidcTokenError)
  expect((err as OidcTokenError).code).toBe(code)
}

// ---------------------------------------------------------------------------
// S12/S13 — field readers
// ---------------------------------------------------------------------------

describe('RFC-220 readClaimField / composePreferred', () => {
  test('own-property only: prototype-chain keys read nothing', () => {
    expect(readClaimField({}, 'toString')).toBeNull()
    expect(readClaimField({}, 'constructor')).toBeNull()
    expect(readClaimField({ login: 'x' }, 'login')).toBe('x')
  })

  test('string and SAFE-integer numbers normalize; everything else is null', () => {
    expect(readClaimField({ id: 42 }, 'id')).toBe('42')
    expect(readClaimField({ id: '42' }, 'id')).toBe('42')
    expect(readClaimField({ id: 2 ** 53 }, 'id')).toBeNull() // > MAX_SAFE_INTEGER
    expect(readClaimField({ id: 1.5 }, 'id')).toBeNull()
    expect(readClaimField({ id: { toString: () => 'x' } }, 'id')).toBeNull()
    expect(readClaimField({ id: '' }, 'id')).toBeNull()
    expect(readClaimField({ id: null }, 'id')).toBeNull()
  })

  test('composePreferred joins configured order, skips absent, caps at 128', () => {
    const src = { family: '张', given: '三', sig: '我爱写代码' }
    expect(composePreferred(src, 'family given sig')).toBe('张 三 我爱写代码')
    expect(composePreferred(src, 'given family')).toBe('三 张')
    // absent fields are skipped, not fatal (signature fields come and go)
    expect(composePreferred(src, 'family missing sig')).toBe('张 我爱写代码')
    expect(composePreferred({}, 'family sig')).toBeNull()
    const long = composePreferred({ a: 'x'.repeat(200), b: 'y' }, 'a b')
    expect(long!.length).toBe(128) // UserSchema.displayName max
  })
})

// ---------------------------------------------------------------------------
// S5/S12/S13 — extractUserinfoClaims
// ---------------------------------------------------------------------------

describe('RFC-220 extractUserinfoClaims', () => {
  const opts = { subjectClaim: null, usernameClaim: null }

  test('standard claims extraction', () => {
    const claims = extractUserinfoClaims(
      {
        sub: 'u-1',
        email: 'a@b.test',
        email_verified: true,
        name: 'Alice',
        preferred_username: 'alice',
      },
      opts,
    )
    expect(claims).toEqual({
      sub: 'u-1',
      email: 'a@b.test',
      email_verified: true,
      name: 'Alice',
      preferred_username: 'alice',
    })
  })

  test('default subject is string-only with NO implicit id fallback (D2 revised)', () => {
    // id present, sub absent → fail loud. A per-user fallback chain is
    // namespace mixing: another user's `id` could equal this user's `sub`.
    expect(() => extractUserinfoClaims({ id: '7', login: 'x' }, opts)).toThrow(OidcTokenError)
    // numeric standard sub is not accepted either (OIDC says string)
    expect(() => extractUserinfoClaims({ sub: 42 }, opts)).toThrow(OidcTokenError)
    expect(() => extractUserinfoClaims({ sub: '' }, opts)).toThrow(OidcTokenError)
  })

  test('subjectClaim: configured field wins, no fallback on miss (D6)', () => {
    const withSubject = { subjectClaim: 'id', usernameClaim: null }
    expect(extractUserinfoClaims({ id: 42, sub: 'ignored' }, withSubject).sub).toBe('42')
    // miss → hard failure, never falls back to sub/id
    expect(() => extractUserinfoClaims({ sub: 'present' }, withSubject)).toThrow(OidcTokenError)
    // unsafe-integer id is rejected, not rounded into a colliding subject
    expect(() => extractUserinfoClaims({ id: 2 ** 53 }, withSubject)).toThrow(OidcTokenError)
  })

  test('same normalized value from string and number folds to one key (documented)', () => {
    // Deliberate (design §9.9): the ID field is IdP-platform-generated; a
    // type prefix would turn serialization jitter into silent duplicate
    // accounts. This lock pins the folding so it can never drift unnoticed.
    const withSubject = { subjectClaim: 'id', usernameClaim: null }
    expect(extractUserinfoClaims({ id: '7' }, withSubject).sub).toBe('7')
    expect(extractUserinfoClaims({ id: 7 }, withSubject).sub).toBe('7')
  })

  test('usernameClaim list feeds preferred_username; miss falls to null (not the standard claim)', () => {
    const withUsername = { subjectClaim: null, usernameClaim: 'login sig' }
    const composed = extractUserinfoClaims(
      { sub: 'u-1', login: 'zhang', sig: 'hello', preferred_username: 'standard' },
      withUsername,
    )
    expect(composed.preferred_username).toBe('zhang hello')
    // configured-but-missing must NOT silently reread the standard claim —
    // that would mask a misconfigured field name
    const missing = extractUserinfoClaims(
      { sub: 'u-1', preferred_username: 'standard' },
      withUsername,
    )
    expect(missing.preferred_username).toBeNull()
  })

  test('default preferred_username stays string-only (byte-compat, round-3 P3)', () => {
    const claims = extractUserinfoClaims({ sub: 'u-1', preferred_username: 12345 }, opts)
    expect(claims.preferred_username).toBeNull()
  })

  test('non-object payloads are shape failures', () => {
    expect(() => extractUserinfoClaims([1], opts)).toThrow(OidcTokenError)
    expect(() => extractUserinfoClaims('jwt-ish-string', opts)).toThrow(OidcTokenError)
    expect(() => extractUserinfoClaims(null, opts)).toThrow(OidcTokenError)
  })
})

// ---------------------------------------------------------------------------
// S6 — acquireIdentityClaims matrix
// ---------------------------------------------------------------------------

describe('RFC-220 acquireIdentityClaims matrix (D4/D6)', () => {
  test('id_token + configured jwks → verified claims (nonce enforced)', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256')
    const idToken = await signIdToken(privateKey, { sub: 'idt-1', email: 'a@b.test' })
    const claims = await acquireIdentityClaims({
      tokens: { access_token: 'at', id_token: idToken },
      effective: effective({ jwksUri: `${ISSUER}/jwks`, userinfoEndpoint: `${ISSUER}/me` }),
      clientId: AUDIENCE,
      nonce: NONCE,
      jwks: staticJwks(publicKey),
    })
    expect(claims.sub).toBe('idt-1')
  })

  test('verify failure stays FATAL even with userinfo available (no downgrade)', async () => {
    const { privateKey } = await generateKeyPair('ES256')
    const { publicKey: wrongKey } = await generateKeyPair('ES256')
    const idToken = await signIdToken(privateKey, { sub: 'idt-1' })
    await expectTokenError(
      acquireIdentityClaims({
        tokens: { access_token: 'at', id_token: idToken },
        effective: effective({ jwksUri: `${ISSUER}/jwks`, userinfoEndpoint: `${ISSUER}/me` }),
        clientId: AUDIENCE,
        nonce: NONCE,
        jwks: staticJwks(wrongKey),
        fetcher: userinfoFetcher({ sub: 'ui-1' }),
      }),
      'id-token-verify-failed',
    )
  })

  test('runtime JWKS fetch failure is a hard failure too (config-state gating)', async () => {
    const { privateKey } = await generateKeyPair('ES256')
    const idToken = await signIdToken(privateKey, { sub: 'idt-1' })
    const failingJwks = (async () => {
      throw new Error('jwks endpoint down')
    }) as unknown as VerifyIdTokenInput['jwks']
    await expectTokenError(
      acquireIdentityClaims({
        tokens: { access_token: 'at', id_token: idToken },
        effective: effective({ jwksUri: `${ISSUER}/jwks`, userinfoEndpoint: `${ISSUER}/me` }),
        clientId: AUDIENCE,
        nonce: NONCE,
        jwks: failingJwks,
        fetcher: userinfoFetcher({ sub: 'ui-1' }),
      }),
      'id-token-verify-failed',
    )
  })

  test('id_token WITHOUT configured jwks + userinfo → userinfo wins, unverified token ignored', async () => {
    const { privateKey } = await generateKeyPair('ES256')
    const idToken = await signIdToken(privateKey, { sub: 'idt-SPOOF' })
    const claims = await acquireIdentityClaims({
      tokens: { access_token: 'at', id_token: idToken },
      effective: effective({ userinfoEndpoint: `${ISSUER}/me` }),
      clientId: AUDIENCE,
      nonce: NONCE,
      fetcher: userinfoFetcher({ sub: 'ui-real' }),
    })
    // the unverified id_token's claims never leak into the result
    expect(claims.sub).toBe('ui-real')
  })

  test('id_token without jwks and without userinfo → jwks-unavailable', async () => {
    await expectTokenError(
      acquireIdentityClaims({
        tokens: { access_token: 'at', id_token: 'unverifiable' },
        effective: effective({}),
        clientId: AUDIENCE,
        nonce: NONCE,
      }),
      'jwks-unavailable',
    )
  })

  test('no id_token + userinfo → userinfo path', async () => {
    const claims = await acquireIdentityClaims({
      tokens: { access_token: 'at' },
      effective: effective({ userinfoEndpoint: `${ISSUER}/me` }),
      clientId: AUDIENCE,
      nonce: NONCE,
      fetcher: userinfoFetcher({ sub: 'ui-1', email_verified: 'yes' }),
    })
    expect(claims.sub).toBe('ui-1')
    // email_verified must be boolean true, not truthy
    expect(claims.email_verified).toBe(false)
  })

  test('no id_token + no userinfo → userinfo-unavailable', async () => {
    await expectTokenError(
      acquireIdentityClaims({
        tokens: { access_token: 'at' },
        effective: effective({ jwksUri: `${ISSUER}/jwks` }),
        clientId: AUDIENCE,
        nonce: NONCE,
      }),
      'userinfo-unavailable',
    )
  })

  test('subjectClaim mode: verifiable id_token present but identity STILL comes from userinfo', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256')
    const idToken = await signIdToken(privateKey, { sub: 'idt-namespace' })
    const claims = await acquireIdentityClaims({
      tokens: { access_token: 'at', id_token: idToken },
      effective: effective({ jwksUri: `${ISSUER}/jwks`, userinfoEndpoint: `${ISSUER}/me` }),
      clientId: AUDIENCE,
      nonce: NONCE,
      subjectClaim: 'id',
      jwks: staticJwks(publicKey),
      fetcher: userinfoFetcher({ id: 7, sub: 'idt-namespace' }),
    })
    // single namespace: the configured field is the key, payload.sub never is
    expect(claims.sub).toBe('7')
  })

  test('subjectClaim mode without userinfo endpoint → userinfo-unavailable (jwks irrelevant)', async () => {
    await expectTokenError(
      acquireIdentityClaims({
        tokens: { access_token: 'at', id_token: 'whatever' },
        effective: effective({ jwksUri: `${ISSUER}/jwks` }),
        clientId: AUDIENCE,
        nonce: NONCE,
        subjectClaim: 'id',
      }),
      'userinfo-unavailable',
    )
  })

  test('unconfigured + id_token path uses payload.sub as before', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256')
    const idToken = await signIdToken(privateKey, {
      sub: 'idt-1',
      preferred_username: 'idt-user',
    })
    const claims = await acquireIdentityClaims({
      tokens: { access_token: 'at', id_token: idToken },
      effective: effective({ jwksUri: `${ISSUER}/jwks` }),
      clientId: AUDIENCE,
      nonce: NONCE,
      jwks: staticJwks(publicKey),
    })
    expect(claims.sub).toBe('idt-1')
    expect(claims.preferred_username).toBe('idt-user')
  })

  test('usernameClaim composes from the id_token payload too (D5 both paths)', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256')
    const idToken = await signIdToken(privateKey, { sub: 'idt-1', family: '张', given: '三' })
    const claims = await acquireIdentityClaims({
      tokens: { access_token: 'at', id_token: idToken },
      effective: effective({ jwksUri: `${ISSUER}/jwks` }),
      clientId: AUDIENCE,
      nonce: NONCE,
      usernameClaim: 'family given',
      jwks: staticJwks(publicKey),
    })
    expect(claims.preferred_username).toBe('张 三')
  })

  test('empty id_token sub is rejected (behavior change #4)', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256')
    const idToken = await signIdToken(privateKey, { email: 'a@b.test' }) // no sub at all
    await expectTokenError(
      acquireIdentityClaims({
        tokens: { access_token: 'at', id_token: idToken },
        effective: effective({ jwksUri: `${ISSUER}/jwks` }),
        clientId: AUDIENCE,
        nonce: NONCE,
        jwks: staticJwks(publicKey),
      }),
      'id-token-verify-failed',
    )
  })

  // ------------------------------------------------------------------
  // S5 — fetchUserinfo HTTP-layer behavior through the acquire surface
  // ------------------------------------------------------------------

  test('userinfo request carries Bearer auth + accept json', async () => {
    let seen: { auth: string | null; accept: string | null } | null = null
    const fetcher = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      seen = { auth: headers.get('authorization'), accept: headers.get('accept') }
      return new Response(JSON.stringify({ sub: 'ui-1' }), { status: 200 })
    }) as unknown as typeof fetch
    await acquireIdentityClaims({
      tokens: { access_token: 'the-token' },
      effective: effective({ userinfoEndpoint: `${ISSUER}/me` }),
      clientId: AUDIENCE,
      nonce: NONCE,
      fetcher,
    })
    expect(seen!.auth).toBe('Bearer the-token')
    expect(seen!.accept).toBe('application/json')
  })

  test('userinfo 401 → userinfo-fetch-failed', async () => {
    await expectTokenError(
      acquireIdentityClaims({
        tokens: { access_token: 'at' },
        effective: effective({ userinfoEndpoint: `${ISSUER}/me` }),
        clientId: AUDIENCE,
        nonce: NONCE,
        fetcher: userinfoFetcher({ error: 'invalid_token' }, 401),
      }),
      'userinfo-fetch-failed',
    )
  })

  test('userinfo non-JSON body (signed userinfo) → userinfo-shape-invalid', async () => {
    await expectTokenError(
      acquireIdentityClaims({
        tokens: { access_token: 'at' },
        effective: effective({ userinfoEndpoint: `${ISSUER}/me` }),
        clientId: AUDIENCE,
        nonce: NONCE,
        fetcher: userinfoFetcher('eyJhbGciOi.signed.jwt'),
      }),
      'userinfo-shape-invalid',
    )
  })

  test('userinfo transport failure (incl. AbortError timeouts) → userinfo-fetch-failed', async () => {
    const throwing = (async () => {
      throw new DOMException('aborted', 'AbortError')
    }) as unknown as typeof fetch
    await expectTokenError(
      acquireIdentityClaims({
        tokens: { access_token: 'at' },
        effective: effective({ userinfoEndpoint: `${ISSUER}/me` }),
        clientId: AUDIENCE,
        nonce: NONCE,
        fetcher: throwing,
      }),
      'userinfo-fetch-failed',
    )
  })

  test('userinfo body over 256 KiB is cut off → userinfo-fetch-failed (body-too-large)', async () => {
    const huge = `{"sub":"u-1","pad":"${'x'.repeat(300 * 1024)}"}`
    const err = await acquireIdentityClaims({
      tokens: { access_token: 'at' },
      effective: effective({ userinfoEndpoint: `${ISSUER}/me` }),
      clientId: AUDIENCE,
      nonce: NONCE,
      fetcher: userinfoFetcher(huge),
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OidcTokenError)
    expect((err as OidcTokenError).code).toBe('userinfo-fetch-failed')
    expect((err as OidcTokenError).message).toContain('body-too-large')
  })
})
