// RFC-036 — OIDC providers service. CRUD with AES-256-GCM-wrapped client
// secret at rest (via auth/secretBox), discovery probe for the /test endpoint,
// and a redacted-for-output view that never leaks the secret.

import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type {
  CreateOidcProviderBody,
  OidcProvider,
  OidcProviderPublic,
  PatchOidcProviderBody,
} from '@agent-workflow/shared'
import { OidcProviderSchema } from '@agent-workflow/shared'
import type { SecretBox } from '@/auth/secretBox'
import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import { oidcProviders, userIdentities } from '@/db/schema'
import { resolveEndpoints, type EndpointSource } from '@/auth/oidc/endpoints'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'

type Row = typeof oidcProviders.$inferSelect

// RFC-220 — admin diagnostic result for POST /:id/test (design §7). Always
// carried on a 200: the per-field diagnosis is MOST valuable when the
// configuration is broken, and a 4xx would strip the structured body in the
// frontend error path.
export interface ProbeResult {
  /**
   * loginReady under the runtime branch rules (§5): authorization + token
   * plus an identity channel that can actually carry a callback —
   * subjectClaim mode requires userinfo (jwks is not an identity channel
   * there); otherwise a configured jwks_uri must probe reachable (an IdP
   * that sends an id_token hard-fails on unreachable JWKS, userinfo cannot
   * rescue it), and with no jwks_uri userinfo must be configured.
   */
  ok: boolean
  discovery: { ok: boolean; error?: string }
  issuer: string
  endpoints: Record<
    'authorizationEndpoint' | 'tokenEndpoint' | 'userinfoEndpoint' | 'jwksUri',
    { url: string; source: EndpointSource } | null
  >
  /** Probed only when jwks participates (subjectClaim NOT configured). */
  jwksReachable?: boolean
  scopesSupported: string[]
}

export interface OidcProvidersService {
  list(): Promise<OidcProvider[]>
  listPublic(): Promise<OidcProviderPublic[]>
  findById(id: string): Promise<OidcProvider | null>
  findBySlug(slug: string): Promise<OidcProvider | null>
  /** Returns the *raw* client_secret value — only call from token-exchange code paths. */
  resolveClientSecret(id: string): Promise<string | null>
  create(body: CreateOidcProviderBody, now?: number): Promise<OidcProvider>
  patch(id: string, body: PatchOidcProviderBody, now?: number): Promise<OidcProvider>
  remove(id: string, force?: boolean): Promise<void>
  probe(provider: OidcProvider, fetcher?: typeof fetch): Promise<ProbeResult>
}

export function createOidcProvidersService(deps: {
  db: DbClient
  secretBox: SecretBox
}): OidcProvidersService {
  const { db, secretBox } = deps

  function materialize(row: Row): OidcProvider {
    return OidcProviderSchema.parse({
      id: row.id,
      slug: row.slug,
      displayName: row.displayName,
      issuerUrl: row.issuerUrl,
      clientId: row.clientId,
      scopes: row.scopes,
      provisioning: row.provisioning,
      allowedEmailDomains: safeJson<string[]>(row.allowedEmailDomainsJson) ?? [],
      iconUrl: row.iconUrl,
      enabled: row.enabled,
      authorizationEndpoint: row.authorizationEndpoint ?? null,
      tokenEndpoint: row.tokenEndpoint ?? null,
      userinfoEndpoint: row.userinfoEndpoint ?? null,
      jwksUri: row.jwksUri ?? null,
      trustEmailVerified: row.trustEmailVerified,
      usernameClaim: row.usernameClaim ?? null,
      subjectClaim: row.subjectClaim ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })
  }

  return {
    async list() {
      const rows = await db.select().from(oidcProviders)
      return rows.map(materialize)
    },
    async listPublic() {
      const rows = await db.select().from(oidcProviders).where(eq(oidcProviders.enabled, true))
      return rows.map((r) => ({ slug: r.slug, displayName: r.displayName, iconUrl: r.iconUrl }))
    },
    async findById(id) {
      const rows = await db.select().from(oidcProviders).where(eq(oidcProviders.id, id)).limit(1)
      return rows[0] ? materialize(rows[0]) : null
    },
    async findBySlug(slug) {
      const rows = await db
        .select()
        .from(oidcProviders)
        .where(eq(oidcProviders.slug, slug))
        .limit(1)
      return rows[0] ? materialize(rows[0]) : null
    },
    async resolveClientSecret(id) {
      const rows = await db.select().from(oidcProviders).where(eq(oidcProviders.id, id)).limit(1)
      if (!rows[0]) return null
      return secretBox.unseal(rows[0].clientSecretEnc)
    },
    async create(body, now = Date.now()) {
      const existing = await this.findBySlug(body.slug)
      if (existing) {
        throw new ConflictError('oidc-slug-taken', `slug '${body.slug}' already exists`)
      }
      const id = ulid()
      await db.insert(oidcProviders).values({
        id,
        slug: body.slug,
        displayName: body.displayName,
        issuerUrl: body.issuerUrl,
        clientId: body.clientId,
        clientSecretEnc: secretBox.seal(body.clientSecret),
        scopes: body.scopes,
        provisioning: body.provisioning,
        allowedEmailDomainsJson: JSON.stringify(body.allowedEmailDomains ?? []),
        iconUrl: body.iconUrl,
        enabled: body.enabled,
        authorizationEndpoint: body.authorizationEndpoint ?? null,
        tokenEndpoint: body.tokenEndpoint ?? null,
        userinfoEndpoint: body.userinfoEndpoint ?? null,
        jwksUri: body.jwksUri ?? null,
        trustEmailVerified: body.trustEmailVerified ?? false,
        usernameClaim: body.usernameClaim ?? null,
        subjectClaim: body.subjectClaim ?? null,
        createdAt: now,
        updatedAt: now,
        schemaVersion: 1,
      })
      return (await this.findById(id))!
    },
    async patch(id, body, now = Date.now()) {
      const cur = await this.findById(id)
      if (!cur) throw new NotFoundError('oidc-provider-not-found', `provider ${id} not found`)
      const updates: Partial<typeof oidcProviders.$inferInsert> = { updatedAt: now }
      if (body.slug !== undefined && body.slug !== cur.slug) {
        const dup = await this.findBySlug(body.slug)
        if (dup) throw new ConflictError('oidc-slug-taken', `slug '${body.slug}' already exists`)
        updates.slug = body.slug
      }
      if (body.displayName !== undefined) updates.displayName = body.displayName
      if (body.issuerUrl !== undefined) updates.issuerUrl = body.issuerUrl
      if (body.clientId !== undefined) updates.clientId = body.clientId
      if (body.scopes !== undefined) updates.scopes = body.scopes
      if (body.provisioning !== undefined) updates.provisioning = body.provisioning
      if (body.allowedEmailDomains !== undefined) {
        updates.allowedEmailDomainsJson = JSON.stringify(body.allowedEmailDomains)
      }
      if (body.iconUrl !== undefined) updates.iconUrl = body.iconUrl
      if (body.enabled !== undefined) updates.enabled = body.enabled
      if (body.authorizationEndpoint !== undefined) {
        updates.authorizationEndpoint = body.authorizationEndpoint
      }
      if (body.tokenEndpoint !== undefined) updates.tokenEndpoint = body.tokenEndpoint
      if (body.userinfoEndpoint !== undefined) updates.userinfoEndpoint = body.userinfoEndpoint
      if (body.jwksUri !== undefined) updates.jwksUri = body.jwksUri
      if (body.trustEmailVerified !== undefined) updates.trustEmailVerified = body.trustEmailVerified
      if (body.usernameClaim !== undefined) updates.usernameClaim = body.usernameClaim
      // Empty clientSecret in PATCH = keep existing; non-empty = re-seal.
      if (typeof body.clientSecret === 'string' && body.clientSecret.length > 0) {
        updates.clientSecretEnc = secretBox.seal(body.clientSecret)
      }
      // RFC-220 — subject namespace lock. Changing subjectClaim re-keys future
      // identities; rows written under the old namespace could then miss
      // (duplicate accounts) or collide with another user's old subject (login
      // as someone else). While ANY identity exists the change is refused; the
      // zero-identity predicate and the provider update share one synchronous
      // transaction so an in-flight callback's identity insert (also dbTxSync,
      // userIdentities.ts) serializes strictly before or after us — either we
      // 409 here or the callback's write-time recheck rejects with
      // provider-config-changed. Equal-value rewrites pass untouched.
      if (body.subjectClaim !== undefined && body.subjectClaim !== cur.subjectClaim) {
        updates.subjectClaim = body.subjectClaim
        dbTxSync(db, (tx) => {
          const linked = tx
            .select({ id: userIdentities.id })
            .from(userIdentities)
            .where(eq(userIdentities.providerId, id))
            .limit(1)
            .all()
          if (linked.length > 0) {
            throw new ConflictError(
              'subject-claim-locked-by-identities',
              'subjectClaim cannot change while identities are linked to this provider; delete and recreate the provider instead',
            )
          }
          tx.update(oidcProviders).set(updates).where(eq(oidcProviders.id, id)).run()
        })
        return (await this.findById(id))!
      }
      await db.update(oidcProviders).set(updates).where(eq(oidcProviders.id, id))
      return (await this.findById(id))!
    },
    async remove(id, force = false) {
      const cur = await this.findById(id)
      if (!cur) throw new NotFoundError('oidc-provider-not-found', `provider ${id} not found`)
      const ids = await db
        .select()
        .from(userIdentities)
        .where(eq(userIdentities.providerId, id))
        .limit(1)
      if (ids.length > 0 && !force) {
        throw new ConflictError(
          'provider-still-linked',
          'one or more users still have identities linked to this provider',
        )
      }
      if (force) {
        // Caller asked for cascade. SQLite ON DELETE RESTRICT on
        // user_identities.provider_id will block; remove identity rows first.
        await db.delete(userIdentities).where(eq(userIdentities.providerId, id))
      }
      await db.delete(oidcProviders).where(eq(oidcProviders.id, id))
    },
    async probe(provider, fetcher = globalThis.fetch) {
      // forceFresh: an admin pressing "Test connection" wants the IdP's
      // CURRENT state, not up to an hour of positive cache — and the fresh
      // result backfills both caches through the resolver's own rules.
      const eff = await resolveEndpoints(provider, { fetcher, forceFresh: true })
      const endpointOf = (
        url: string | null,
        source: EndpointSource | 'none',
      ): { url: string; source: EndpointSource } | null =>
        url !== null && source !== 'none' ? { url, source } : null
      const subjectMode = provider.subjectClaim !== null
      let jwksReachable: boolean | undefined
      if (!subjectMode && eff.jwksUri !== null) {
        try {
          const res = await fetcher(eff.jwksUri, {
            method: 'GET',
            signal: AbortSignal.timeout(10_000),
          })
          jwksReachable = res.ok
        } catch {
          jwksReachable = false
        }
      }
      const identityChannelReady = subjectMode
        ? eff.userinfoEndpoint !== null
        : eff.jwksUri !== null
          ? jwksReachable === true
          : eff.userinfoEndpoint !== null
      return {
        ok:
          eff.authorizationEndpoint !== null &&
          eff.tokenEndpoint !== null &&
          identityChannelReady,
        discovery: {
          ok: eff.discoveryOk,
          ...(eff.discoveryError !== undefined ? { error: eff.discoveryError } : {}),
        },
        issuer: eff.issuer,
        endpoints: {
          authorizationEndpoint: endpointOf(
            eff.authorizationEndpoint,
            eff.sources.authorizationEndpoint,
          ),
          tokenEndpoint: endpointOf(eff.tokenEndpoint, eff.sources.tokenEndpoint),
          userinfoEndpoint: endpointOf(eff.userinfoEndpoint, eff.sources.userinfoEndpoint),
          jwksUri: endpointOf(eff.jwksUri, eff.sources.jwksUri),
        },
        ...(jwksReachable !== undefined ? { jwksReachable } : {}),
        scopesSupported: eff.scopesSupported,
      }
    },
  }
}

function safeJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** Redact a provider for API output — drops the encrypted secret. */
export function redactedProvider(p: OidcProvider): OidcProvider & { clientSecret: '***' } {
  // Schema doesn't include clientSecret; we still emit a sentinel so the UI
  // form can show "(hidden — enter a new value to overwrite)".
  return { ...p, clientSecret: '***' as const }
}

export { ValidationError as OidcValidationError }
