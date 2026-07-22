// RFC-036 — OIDC discovery + JWKS fetcher with an in-memory LRU cache (TTL 1h
// per design.md §5.3). Pure HTTP; no DB writes.

import { createRemoteJWKSet, type JSONWebKeySet } from 'jose'

export interface OidcMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  scopes_supported?: string[]
  userinfo_endpoint?: string
  end_session_endpoint?: string
}

interface CacheEntry {
  metadata: OidcMetadata
  jwks: ReturnType<typeof createRemoteJWKSet>
  fetchedAt: number
}

const TTL_MS = 60 * 60 * 1000
const cache = new Map<string, CacheEntry>()

export function clearDiscoveryCache(): void {
  cache.clear()
}

export async function getProviderMetadata(
  issuerUrl: string,
  now: number = Date.now(),
  fetcher: typeof fetch = globalThis.fetch,
): Promise<CacheEntry> {
  const hit = cache.get(issuerUrl)
  if (hit && now - hit.fetchedAt < TTL_MS) return hit
  const metadata = await fetchDiscovery(issuerUrl, fetcher)
  const jwks = createRemoteJWKSet(new URL(metadata.jwks_uri))
  const entry: CacheEntry = { metadata, jwks, fetchedAt: now }
  cache.set(issuerUrl, entry)
  return entry
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
  const res = await fetcher(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`oidc-discovery-failed status=${res.status}`)
  }
  let json: unknown
  try {
    json = await res.json()
  } catch {
    throw new Error('oidc-discovery-not-json')
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('oidc-discovery-not-object')
  }
  return json as Partial<OidcMetadata>
}

async function fetchDiscovery(issuerUrl: string, fetcher: typeof fetch): Promise<OidcMetadata> {
  const json = await fetchDiscoveryDocument(issuerUrl, fetcher)
  if (!json.issuer || !json.authorization_endpoint || !json.token_endpoint || !json.jwks_uri) {
    throw new Error('oidc-discovery-incomplete')
  }
  return json as OidcMetadata
}

/** Used by the admin /test endpoint — fetch + return metadata, do not cache. */
export async function testDiscovery(
  issuerUrl: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<{ ok: true; metadata: OidcMetadata } | { ok: false; error: string }> {
  try {
    const metadata = await fetchDiscovery(issuerUrl, fetcher)
    // Touch JWKS just to make sure it is reachable.
    const jwksRes = await fetcher(metadata.jwks_uri, { method: 'GET' })
    if (!jwksRes.ok) {
      return { ok: false, error: `jwks-fetch-failed status=${jwksRes.status}` }
    }
    const _jwks = (await jwksRes.json()) as JSONWebKeySet
    void _jwks
    return { ok: true, metadata }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
