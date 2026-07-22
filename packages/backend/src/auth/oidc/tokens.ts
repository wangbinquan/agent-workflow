// RFC-036 — `code → tokens` exchange + id_token verification via jose.
// Verification covers signature (JWKS), iss / aud / exp / nbf (handled by
// jose's jwtVerify), and nonce (explicit). Failures throw a typed error so
// the callback handler can render a friendly 400.

import { jwtVerify, type createRemoteJWKSet, type JWTPayload } from 'jose'

export interface TokenResponse {
  access_token: string
  /** RFC-220 — optional: pure OAuth 2.0 servers issue no id_token; identity
   * then comes from the userinfo endpoint (auth/oidc/identity.ts). */
  id_token?: string
  refresh_token?: string
  token_type?: string
  expires_in?: number
  scope?: string
}

export interface ExchangeInput {
  tokenEndpoint: string
  clientId: string
  clientSecret: string
  code: string
  codeVerifier: string
  redirectUri: string
  fetcher?: typeof fetch
}

export class OidcTokenError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'token-exchange-failed'
      | 'id-token-verify-failed'
      // RFC-220 — userinfo identity source + the acquire fallbacks
      // (auth/oidc/identity.ts throws the last two).
      | 'userinfo-fetch-failed'
      | 'userinfo-shape-invalid'
      | 'userinfo-unavailable'
      | 'jwks-unavailable',
  ) {
    super(message)
    this.name = 'OidcTokenError'
  }
}

export async function exchangeCodeForTokens(input: ExchangeInput): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code_verifier: input.codeVerifier,
  })
  const fetcher = input.fetcher ?? globalThis.fetch
  // RFC-220 — transport and parse failures are wrapped so the callback maps
  // them to the precise token-exchange-failed page instead of the generic
  // verify-failed catch-all (behavior change #3).
  let res: Response
  try {
    res = await fetcher(input.tokenEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
    })
  } catch (err) {
    throw new OidcTokenError(
      `token-exchange-failed transport: ${err instanceof Error ? err.message : String(err)}`,
      'token-exchange-failed',
    )
  }
  if (!res.ok) {
    throw new OidcTokenError(`token-exchange-failed status=${res.status}`, 'token-exchange-failed')
  }
  let parsed: unknown
  try {
    parsed = await res.json()
  } catch {
    throw new OidcTokenError('token-exchange-body-not-json', 'token-exchange-failed')
  }
  const json = (
    typeof parsed === 'object' && parsed !== null ? parsed : {}
  ) as Partial<TokenResponse> & Record<string, unknown>
  if (typeof json.access_token !== 'string') {
    throw new OidcTokenError('token-exchange-shape-invalid', 'token-exchange-failed')
  }
  // A non-string id_token (null, number, …) is treated as absent — pure OAuth2
  // servers emit dirty fields here; the strict check only ever guarded the
  // verify path, which acquireIdentityClaims now gates on presence.
  if (typeof json.id_token !== 'string' || json.id_token.length === 0) {
    delete json.id_token
  }
  return json as TokenResponse
}

// RFC-220 — the userinfo call happens inside the public callback AFTER the
// one-shot state was consumed: an unbounded request would wedge the login
// permanently, and an unbounded body would let a hostile IdP exhaust daemon
// memory. Both bounds are hard requirements (design §4.2).
const USERINFO_TIMEOUT_MS = 10_000
const USERINFO_MAX_BODY_BYTES = 256 * 1024

export interface FetchUserinfoInput {
  userinfoEndpoint: string
  accessToken: string
  fetcher?: typeof fetch
}

/**
 * HTTP layer only: returns the raw userinfo JSON object. Claims extraction
 * (subjectClaim / usernameClaim semantics) lives in auth/oidc/identity.ts —
 * keeping it there keeps the dependency direction identity → tokens acyclic.
 */
export async function fetchUserinfo(input: FetchUserinfoInput): Promise<unknown> {
  const fetcher = input.fetcher ?? globalThis.fetch
  let res: Response
  try {
    res = await fetcher(input.userinfoEndpoint, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(USERINFO_TIMEOUT_MS),
    })
  } catch (err) {
    throw new OidcTokenError(
      `userinfo-fetch-failed transport: ${err instanceof Error ? err.message : String(err)}`,
      'userinfo-fetch-failed',
    )
  }
  if (!res.ok) {
    throw new OidcTokenError(`userinfo-fetch-failed status=${res.status}`, 'userinfo-fetch-failed')
  }
  const raw = await readBodyCapped(res, USERINFO_MAX_BODY_BYTES)
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    // includes signed userinfo (application/jwt) — deliberately unsupported
    throw new OidcTokenError('userinfo-shape-invalid', 'userinfo-shape-invalid')
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new OidcTokenError('userinfo-shape-invalid', 'userinfo-shape-invalid')
  }
  return json
}

async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  const body = res.body
  if (!body) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    let step: Awaited<ReturnType<typeof reader.read>>
    try {
      step = await reader.read()
    } catch (err) {
      // The headers already resolved, so a mid-body stall/reset/abort throws
      // HERE, outside the transport catch in fetchUserinfo — untyped it would
      // collapse into the generic verify-failed page (impl-gate P2).
      throw new OidcTokenError(
        `userinfo-fetch-failed body-read: ${err instanceof Error ? err.message : String(err)}`,
        'userinfo-fetch-failed',
      )
    }
    if (step.done) break
    const value = step.value
    if (value) {
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new OidcTokenError('userinfo-fetch-failed body-too-large', 'userinfo-fetch-failed')
      }
      chunks.push(value)
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

export interface VerifyIdTokenInput {
  idToken: string
  /** Either the remote JWKS or a static key resolver. */
  jwks: ReturnType<typeof createRemoteJWKSet> | Parameters<typeof jwtVerify>[1]
  issuer: string
  audience: string
  nonce: string
}

export async function verifyIdToken(input: VerifyIdTokenInput): Promise<JWTPayload> {
  try {
    const { payload } = await jwtVerify(input.idToken, input.jwks as never, {
      issuer: input.issuer,
      audience: input.audience,
    })
    if (typeof payload.nonce === 'string') {
      if (payload.nonce !== input.nonce) {
        throw new OidcTokenError('nonce-mismatch', 'id-token-verify-failed')
      }
    } else {
      throw new OidcTokenError('nonce-missing', 'id-token-verify-failed')
    }
    return payload
  } catch (err) {
    if (err instanceof OidcTokenError) throw err
    throw new OidcTokenError(
      err instanceof Error ? err.message : String(err),
      'id-token-verify-failed',
    )
  }
}
