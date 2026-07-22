// RFC-220 — effective endpoint resolution (design §3): per-field merge of the
// discovery document over manual fallbacks (D1), plus BOTH caches. The caches
// live here and not in discovery.ts because their semantics are resolver
// semantics: hits are only honored when the merged result can actually carry a
// login ("loginViable"), entries are replaced per issuer key, and the admin
// probe forces a fresh fetch — none of which a raw document cache could offer.
//
// Cache discipline (locked by rfc220-endpoint-resolution.test.ts):
//   - A failure is only ever cached AS a failure (never as success).
//   - A cached entry — positive or negative — is only honored when the merged
//     endpoint set is loginViable; otherwise the resolver re-probes on every
//     call, preserving today's "incomplete discovery retries per request, IdP
//     recovery is picked up immediately" behavior. Without this gate a single
//     transient failure (or a transient 200 `{}`) would turn into a 5min-1h
//     outage amplifier for standard OIDC IdPs with no manual fallback.

import { createRemoteJWKSet } from 'jose'
import type { OidcProvider } from '@agent-workflow/shared'
import { fetchDiscoveryDocument, type OidcMetadata } from './discovery'

export type EndpointSource = 'discovery' | 'manual'

export interface EffectiveEndpoints {
  authorizationEndpoint: string | null
  tokenEndpoint: string | null
  userinfoEndpoint: string | null
  jwksUri: string | null
  /**
   * Expected `iss` for id_token verification: the discovery document's issuer
   * when present, otherwise provider.issuerUrl VERBATIM. No trailing-slash
   * trimming — OIDC issuer comparison is exact, and trimming would reject
   * every token of a provider configured as `https://x/` (the trim only ever
   * applies to the discovery request URL, in discovery.ts).
   */
  issuer: string
  sources: Record<
    'authorizationEndpoint' | 'tokenEndpoint' | 'userinfoEndpoint' | 'jwksUri',
    EndpointSource | 'none'
  >
  /** Discovery `scopes_supported` passthrough (runtime-validated), else []. */
  scopesSupported: string[]
  discoveryOk: boolean
  discoveryError?: string
}

export type ResolveEndpointsInput = Pick<
  OidcProvider,
  // subjectClaim feeds loginViable (D6 mode needs userinfo as the identity
  // channel) — the cache gates cannot judge viability without it.
  | 'issuerUrl'
  | 'authorizationEndpoint'
  | 'tokenEndpoint'
  | 'userinfoEndpoint'
  | 'jwksUri'
  | 'subjectClaim'
>

const POS_TTL_MS = 60 * 60 * 1000
const NEG_TTL_MS = 5 * 60 * 1000

interface PositiveEntry {
  doc: Partial<OidcMetadata>
  fetchedAt: number
}
interface NegativeEntry {
  error: string
  fetchedAt: number
}

const positiveCache = new Map<string, PositiveEntry>()
const negativeCache = new Map<string, NegativeEntry>()
const jwksInstances = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

export function clearEndpointCaches(): void {
  positiveCache.clear()
  negativeCache.clear()
  jwksInstances.clear()
}

/**
 * Remote JWKS keyed by the RESOLVED jwks_uri (manual or discovery). jose's
 * RemoteJWKSet keeps its own key cache + cooldown per instance, so reusing
 * the instance is what makes that machinery effective.
 */
export function getJwksInstance(jwksUri: string): ReturnType<typeof createRemoteJWKSet> {
  let instance = jwksInstances.get(jwksUri)
  if (!instance) {
    instance = createRemoteJWKSet(new URL(jwksUri))
    jwksInstances.set(jwksUri, instance)
  }
  return instance
}

/**
 * Runtime validation for discovery-provided endpoint fields (design §3, gate
 * P1): only a non-empty http(s) URL counts as "discovery provided this
 * field". Anything else (empty string, number, garbage, other schemes) is
 * treated as missing so a valid manual fallback is not shadowed by a broken
 * document — and so a bad value never reaches `new URL` in a login path.
 */
function sanitizeUrlField(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  if (!/^https?:\/\//i.test(value)) return null
  try {
    new URL(value)
  } catch {
    return null
  }
  return value
}

/**
 * Can the merged endpoint set carry a whole login — start AND callback AND
 * claims acquisition? Both cache gates share this predicate. A "half viable"
 * set (start would redirect but the callback could never source an identity)
 * must not be served from cache: subjectClaim mode (D6) locks the identity
 * source to userinfo, otherwise either userinfo or a configured JWKS works.
 */
export function loginViable(
  effective: Pick<
    EffectiveEndpoints,
    'authorizationEndpoint' | 'tokenEndpoint' | 'userinfoEndpoint' | 'jwksUri'
  >,
  provider: Pick<OidcProvider, 'subjectClaim'>,
): boolean {
  if (!effective.authorizationEndpoint || !effective.tokenEndpoint) return false
  if (provider.subjectClaim) return effective.userinfoEndpoint !== null
  return effective.userinfoEndpoint !== null || effective.jwksUri !== null
}

function merge(
  doc: Partial<OidcMetadata> | null,
  provider: ResolveEndpointsInput,
  discovery: { ok: boolean; error?: string },
): EffectiveEndpoints {
  const pick = (
    docValue: unknown,
    manual: string | null,
  ): { url: string | null; source: EndpointSource | 'none' } => {
    const fromDoc = sanitizeUrlField(docValue)
    if (fromDoc !== null) return { url: fromDoc, source: 'discovery' }
    if (manual !== null) return { url: manual, source: 'manual' }
    return { url: null, source: 'none' }
  }
  const authorization = pick(doc?.authorization_endpoint, provider.authorizationEndpoint)
  const token = pick(doc?.token_endpoint, provider.tokenEndpoint)
  const userinfo = pick(doc?.userinfo_endpoint, provider.userinfoEndpoint)
  const jwks = pick(doc?.jwks_uri, provider.jwksUri)
  const scopesSupported = Array.isArray(doc?.scopes_supported)
    ? doc.scopes_supported.filter((s): s is string => typeof s === 'string')
    : []
  return {
    authorizationEndpoint: authorization.url,
    tokenEndpoint: token.url,
    userinfoEndpoint: userinfo.url,
    jwksUri: jwks.url,
    issuer:
      (typeof doc?.issuer === 'string' && doc.issuer !== '' && doc.issuer) || provider.issuerUrl,
    sources: {
      authorizationEndpoint: authorization.source,
      tokenEndpoint: token.source,
      userinfoEndpoint: userinfo.source,
      jwksUri: jwks.source,
    },
    scopesSupported,
    discoveryOk: discovery.ok,
    ...(discovery.error !== undefined ? { discoveryError: discovery.error } : {}),
  }
}

export async function resolveEndpoints(
  provider: ResolveEndpointsInput,
  opts?: { now?: number; fetcher?: typeof fetch; forceFresh?: boolean },
): Promise<EffectiveEndpoints> {
  const now = opts?.now ?? Date.now()
  const fetcher = opts?.fetcher ?? globalThis.fetch

  if (opts?.forceFresh !== true) {
    const negative = negativeCache.get(provider.issuerUrl)
    if (negative && now - negative.fetchedAt < NEG_TTL_MS) {
      const manualOnly = merge(null, provider, { ok: false, error: negative.error })
      // Read-side gate: the provider's manual fields may have been PATCHed
      // inside the window, so viability is judged against the CURRENT config.
      if (loginViable(manualOnly, provider)) return manualOnly
    }
    const positive = positiveCache.get(provider.issuerUrl)
    if (positive && now - positive.fetchedAt < POS_TTL_MS) {
      const effective = merge(positive.doc, provider, { ok: true })
      if (loginViable(effective, provider)) return effective
      // Non-viable hit → miss: re-probe below and overwrite the entry.
    }
  }

  try {
    const doc = await fetchDiscoveryDocument(provider.issuerUrl, fetcher)
    positiveCache.set(provider.issuerUrl, { doc, fetchedAt: now })
    negativeCache.delete(provider.issuerUrl)
    return merge(doc, provider, { ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const manualOnly = merge(null, provider, { ok: false, error: message })
    // A fresh failure is the newest fact about this issuer: a surviving
    // positive entry would resurrect up-to-1h-stale discovery URLs the moment
    // the (shorter) negative window lapses (impl-gate P2).
    positiveCache.delete(provider.issuerUrl)
    // Failures are cached AS failures, and only for configs that can actually
    // continue through manual endpoints — anything else keeps per-request
    // retry semantics so IdP recovery is picked up immediately.
    if (loginViable(manualOnly, provider)) {
      negativeCache.set(provider.issuerUrl, { error: message, fetchedAt: now })
    }
    return manualOnly
  }
}
