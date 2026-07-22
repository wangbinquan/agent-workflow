// RFC-220 — claims acquisition (design §5): the single decision point that
// turns a token response into identity claims. Pure and injectable so the
// whole D4/D6 branch matrix is unit-lockable without HTTP.
//
// Invariants (rfc220-identity-acquisition.test.ts):
//   - An UNVERIFIED id_token is never a claims source: fallback branches only
//     ignore it, they never parse it.
//   - The verify/fallback decision looks at CONFIG state only (is a jwks_uri
//     resolved?). Runtime JWKS fetch failures stay hard failures — deciding on
//     runtime state would let an attacker downgrade signature verification by
//     taking the JWKS endpoint down.
//   - subjectClaim (D6) is a MODE SWITCH: when configured, identity always
//     comes from userinfo, even when a verifiable id_token is present. Two
//     subject namespaces on one provider would let a custom field value
//     collide with someone else's `sub` (login as another account).
//   - Subjects are never silently re-sourced: the configured field either
//     yields the subject or the login fails loud.

import type { JWTPayload } from 'jose'
import type { IdTokenClaims } from '@/services/oidc/provisioning'
import type { EffectiveEndpoints } from './endpoints'
import { getJwksInstance } from './endpoints'
import {
  OidcTokenError,
  fetchUserinfo,
  verifyIdToken,
  type TokenResponse,
  type VerifyIdTokenInput,
} from './tokens'

/**
 * Single-field reader shared by both selectors and the userinfo defaults:
 * own-property only (schema-level poison-key blocklist is the first line,
 * this is the second — a `__proto__`-ish key must never read inherited
 * values), non-empty strings, and SAFE-integer numbers. Larger numbers are
 * rejected outright: JSON.parse has already rounded them, and a lossy
 * normalization on an identity key folds adjacent IdP users into one local
 * subject (design-gate round 1 P1).
 */
export function readClaimField(source: Record<string, unknown>, key: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(source, key)) return null
  const value = source[key]
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  return null
}

/**
 * D7 — compose the presented name from a space-separated claim-name list:
 * values joined in configured order, absent fields skipped (signature-style
 * fields come and go), all absent → null. Capped at 128 chars to match
 * UserSchema.displayName (shared/schemas/user.ts).
 */
export function composePreferred(
  source: Record<string, unknown>,
  claimList: string,
): string | null {
  const parts = claimList
    .split(' ')
    .map((key) => readClaimField(source, key))
    .filter((v): v is string => v !== null)
  return parts.length > 0 ? parts.join(' ').slice(0, 128) : null
}

/**
 * preferred_username resolution shared by both identity sources. The DEFAULT
 * path stays string-only — today's callback accepts the standard claim only
 * as a string, and the unconfigured path must remain byte-equivalent
 * (design-gate round 3 P3); number tolerance belongs to explicit selectors.
 * A configured selector is authoritative: on a miss we return null (username
 * derivation falls back to email/subject) instead of silently re-reading the
 * standard claim, which would mask a misconfigured field name.
 */
function readPreferred(
  source: Record<string, unknown>,
  usernameClaim: string | null,
): string | null {
  if (usernameClaim !== null) return composePreferred(source, usernameClaim)
  const value = source['preferred_username']
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function extractUserinfoClaims(
  json: unknown,
  opts: { subjectClaim: string | null; usernameClaim: string | null },
): IdTokenClaims {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new OidcTokenError('userinfo-shape-invalid', 'userinfo-shape-invalid')
  }
  const source = json as Record<string, unknown>
  let sub: string | null
  if (opts.subjectClaim !== null) {
    // D6 — the configured field is the identity key, no fallback of any kind.
    sub = readClaimField(source, opts.subjectClaim)
  } else {
    // Default: standard `sub`, string-only, NO implicit `id` fallback — a
    // per-user fallback chain is namespace mixing (one user resolving via
    // `sub`, another via `id`) and can collide identities (round 4 P1).
    const value = source['sub']
    sub = typeof value === 'string' && value.length > 0 ? value : null
  }
  if (sub === null) {
    throw new OidcTokenError('userinfo-shape-invalid missing-subject', 'userinfo-shape-invalid')
  }
  return {
    sub,
    email: typeof source.email === 'string' ? source.email : null,
    email_verified: source.email_verified === true,
    name: typeof source.name === 'string' ? source.name : null,
    preferred_username: readPreferred(source, opts.usernameClaim),
  }
}

function claimsFromIdToken(payload: JWTPayload, usernameClaim: string | null): IdTokenClaims {
  const source = payload as Record<string, unknown>
  const rawSub = payload.sub
  // Empty-subject rejection (behavior change #4): the pre-RFC callback
  // stringified a missing sub into '' and happily created a subject-less
  // identity row.
  const sub = typeof rawSub === 'string' && rawSub.length > 0 ? rawSub : null
  if (sub === null) {
    throw new OidcTokenError('id-token-verify-failed empty-sub', 'id-token-verify-failed')
  }
  return {
    sub,
    email: typeof source.email === 'string' ? source.email : null,
    email_verified: source.email_verified === true,
    name: typeof source.name === 'string' ? source.name : null,
    preferred_username: readPreferred(source, usernameClaim),
  }
}

export interface AcquireIdentityInput {
  tokens: TokenResponse
  effective: EffectiveEndpoints
  clientId: string
  nonce: string
  usernameClaim?: string | null
  subjectClaim?: string | null
  /** RFC-220 D8 — userinfo invocation style + the scope string the post_json
   * body carries (provider.scopes verbatim). */
  userinfoRequestStyle?: 'get_bearer' | 'post_json'
  scopes?: string
  fetcher?: typeof fetch
  /** Test injection; production default = getJwksInstance(effective.jwksUri). */
  jwks?: VerifyIdTokenInput['jwks']
}

/** Design §5 branch matrix — see module header for the invariants. */
export async function acquireIdentityClaims(input: AcquireIdentityInput): Promise<IdTokenClaims> {
  const subjectClaim = input.subjectClaim ?? null
  const usernameClaim = input.usernameClaim ?? null
  const { tokens, effective } = input
  const subjectMode = subjectClaim !== null

  if (!subjectMode && typeof tokens.id_token === 'string' && effective.jwksUri !== null) {
    const payload = await verifyIdToken({
      idToken: tokens.id_token,
      jwks: input.jwks ?? getJwksInstance(effective.jwksUri),
      issuer: effective.issuer,
      audience: input.clientId,
      nonce: input.nonce,
    })
    return claimsFromIdToken(payload, usernameClaim)
  }

  if (effective.userinfoEndpoint !== null) {
    const raw = await fetchUserinfo({
      userinfoEndpoint: effective.userinfoEndpoint,
      accessToken: tokens.access_token,
      requestStyle: input.userinfoRequestStyle ?? 'get_bearer',
      clientId: input.clientId,
      ...(input.scopes !== undefined ? { scope: input.scopes } : {}),
      ...(input.fetcher ? { fetcher: input.fetcher } : {}),
    })
    return extractUserinfoClaims(raw, { subjectClaim, usernameClaim })
  }

  if (!subjectMode && typeof tokens.id_token === 'string') {
    // id_token present, but no JWKS is CONFIGURED and there is no userinfo
    // endpoint either — nothing can establish identity. The unverified token
    // is not parsed.
    throw new OidcTokenError('jwks-unavailable', 'jwks-unavailable')
  }
  throw new OidcTokenError('userinfo-unavailable', 'userinfo-unavailable')
}
