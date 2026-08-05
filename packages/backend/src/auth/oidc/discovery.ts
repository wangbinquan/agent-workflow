// RFC-036 → RFC-220 — OIDC discovery, now a PURE fetch layer: the strict
// 4-field `getProviderMetadata`/`testDiscovery` (plus the metadata/JWKS
// cache) were deleted in RFC-220 when the login routes moved to the
// per-field merge resolver (auth/oidc/endpoints.ts, which owns all caching)
// and /test moved to the resolver-backed probe (services/oidcProviders.ts).
// Pure HTTP; no DB writes.

import { timeoutSignal } from '@/util/timeoutSignal'

export interface OidcMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  scopes_supported?: string[]
  userinfo_endpoint?: string
  end_session_endpoint?: string
}

// RFC-220 — discovery probes must not hang a login request forever: the
// resolver treats a timeout as "discovery failed" and falls back to manual
// endpoints, so a bounded wait is what makes the fallback reachable at all.
const DISCOVERY_TIMEOUT_MS = 10_000

/**
 * RFC-220 — lenient discovery fetch: HTTP 2xx + a plain JSON object counts as
 * success, every field optional. Partial documents are a legitimate input for
 * the per-field merge in auth/oidc/endpoints.ts (D1); completeness is judged
 * there against the merged result, not here. Pure fetch — caching (positive,
 * negative, viability-gated) lives in the resolver, which needs per-key
 * control this module could not offer.
 */
export async function fetchDiscoveryDocument(
  issuerUrl: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<Partial<OidcMetadata>> {
  const trimmed = issuerUrl.replace(/\/$/, '')
  const url = `${trimmed}/.well-known/openid-configuration`
  // RFC-254: ref'd timeout — the platform timeout signal never fires on Windows Bun
  // when the loop is otherwise idle (see util/timeoutSignal.ts). Covers the
  // body read too, hence cancelled only after json() settles.
  const deadline = timeoutSignal(DISCOVERY_TIMEOUT_MS)
  let json: unknown
  try {
    const res = await fetcher(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: deadline.signal,
    })
    if (!res.ok) {
      throw new Error(`oidc-discovery-failed status=${res.status}`)
    }
    try {
      json = await res.json()
    } catch {
      throw new Error('oidc-discovery-not-json')
    }
  } finally {
    deadline.cancel()
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('oidc-discovery-not-object')
  }
  return json as Partial<OidcMetadata>
}
