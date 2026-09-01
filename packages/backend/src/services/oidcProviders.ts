// RFC-036 — OIDC providers service. CRUD with AES-256-GCM-wrapped client
// secret at rest (via auth/secretBox), discovery probe for the /test endpoint,
// and a redacted-for-output view that never leaks the secret.

import { ulid } from 'ulid'
import type {
  CreateOidcProviderBody,
  OidcProvider,
  OidcProviderPublic,
  PatchOidcProviderBody,
} from '@agent-workflow/shared'
import { OidcProviderSchema } from '@agent-workflow/shared'
import type { SecretBox } from '@/auth/secretBox'
import { resolveEndpoints, type EndpointSource } from '@/auth/oidc/endpoints'
import {
  SqliteOidcProviderRepository,
  type OidcProviderRepository,
} from '@/modules/identity-access/public/operations'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { timeoutSignal } from '@/util/timeoutSignal'

type SqliteOidcProviderDatabase = ConstructorParameters<typeof SqliteOidcProviderRepository>[0]
type OidcProviderPersistenceRecord = NonNullable<
  Awaited<ReturnType<OidcProviderRepository['findById']>>
>
type PatchOidcProviderRecord = Parameters<OidcProviderRepository['patch']>[0]['updates']

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

export function createOidcProvidersService(
  deps:
    | { readonly repository: OidcProviderRepository; readonly secretBox: SecretBox }
    | { readonly db: SqliteOidcProviderDatabase; readonly secretBox: SecretBox },
): OidcProvidersService {
  const repository =
    'repository' in deps ? deps.repository : new SqliteOidcProviderRepository(deps.db)
  const { secretBox } = deps

  function materialize(row: OidcProviderPersistenceRecord): OidcProvider {
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
      userinfoRequestStyle: row.userinfoRequestStyle,
      jwksUri: row.jwksUri ?? null,
      trustEmailVerified: row.trustEmailVerified,
      usernameClaim: row.usernameClaim ?? null,
      gitNameClaim: row.gitNameClaim ?? null,
      emailClaim: row.emailClaim ?? null,
      subjectClaim: row.subjectClaim ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })
  }

  return {
    async list() {
      const rows = await repository.list()
      return rows.map(materialize)
    },
    async listPublic() {
      const rows = await repository.listEnabled()
      return rows.map((r) => ({ slug: r.slug, displayName: r.displayName, iconUrl: r.iconUrl }))
    },
    async findById(id) {
      const row = await repository.findById(id)
      return row === null ? null : materialize(row)
    },
    async findBySlug(slug) {
      const row = await repository.findBySlug(slug)
      return row === null ? null : materialize(row)
    },
    async resolveClientSecret(id) {
      const row = await repository.findById(id)
      if (row === null) return null
      return secretBox.unseal(row.clientSecretEnc)
    },
    async create(body, now = Date.now()) {
      const id = ulid()
      const result = await repository.insert({
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
        userinfoRequestStyle: body.userinfoRequestStyle ?? 'get_bearer',
        jwksUri: body.jwksUri ?? null,
        trustEmailVerified: body.trustEmailVerified ?? false,
        usernameClaim: body.usernameClaim ?? null,
        gitNameClaim: body.gitNameClaim ?? null,
        emailClaim: body.emailClaim ?? null,
        subjectClaim: body.subjectClaim ?? null,
        createdAt: now,
        updatedAt: now,
        schemaVersion: 1,
      })
      if (!result.ok) throw providerWriteError(result.code, id, body.slug)
      return materialize(result.value)
    },
    async patch(id, body, now = Date.now()) {
      const cur = await this.findById(id)
      if (!cur) throw new NotFoundError('oidc-provider-not-found', `provider ${id} not found`)
      // RFC-220 — subject namespace lock. Changing subjectClaim re-keys future
      // identities; rows written under the old namespace could then miss
      // (duplicate accounts) or collide with another user's old subject (login
      // as someone else). While ANY identity exists the change is refused; the
      // zero-identity predicate and the provider update share one synchronous
      // transaction so an in-flight callback's identity insert (also dbTxSync,
      // userIdentities.ts) serializes strictly before or after us — either we
      // 409 here or the callback's write-time recheck rejects with
      // provider-config-changed. Equal-value rewrites pass untouched.
      const subjectClaimChanges =
        body.subjectClaim !== undefined && body.subjectClaim !== cur.subjectClaim
      // Persistence records deliberately expose readonly fields. Build one
      // immutable patch value instead of mutating a DTO after construction;
      // this keeps the same closed contract for SQLite and PostgreSQL.
      const updates: PatchOidcProviderRecord = {
        updatedAt: now,
        ...(body.slug !== undefined && body.slug !== cur.slug ? { slug: body.slug } : {}),
        ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
        ...(body.issuerUrl === undefined ? {} : { issuerUrl: body.issuerUrl }),
        ...(body.clientId === undefined ? {} : { clientId: body.clientId }),
        ...(body.scopes === undefined ? {} : { scopes: body.scopes }),
        ...(body.provisioning === undefined ? {} : { provisioning: body.provisioning }),
        ...(body.allowedEmailDomains === undefined
          ? {}
          : { allowedEmailDomainsJson: JSON.stringify(body.allowedEmailDomains) }),
        ...(body.iconUrl === undefined ? {} : { iconUrl: body.iconUrl }),
        ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        ...(body.authorizationEndpoint === undefined
          ? {}
          : { authorizationEndpoint: body.authorizationEndpoint }),
        ...(body.tokenEndpoint === undefined ? {} : { tokenEndpoint: body.tokenEndpoint }),
        ...(body.userinfoEndpoint === undefined ? {} : { userinfoEndpoint: body.userinfoEndpoint }),
        ...(body.userinfoRequestStyle === undefined
          ? {}
          : { userinfoRequestStyle: body.userinfoRequestStyle }),
        ...(body.jwksUri === undefined ? {} : { jwksUri: body.jwksUri }),
        ...(body.trustEmailVerified === undefined
          ? {}
          : { trustEmailVerified: body.trustEmailVerified }),
        ...(body.usernameClaim === undefined ? {} : { usernameClaim: body.usernameClaim }),
        ...(body.gitNameClaim === undefined ? {} : { gitNameClaim: body.gitNameClaim }),
        ...(body.emailClaim === undefined ? {} : { emailClaim: body.emailClaim }),
        ...(typeof body.clientSecret === 'string' && body.clientSecret.length > 0
          ? { clientSecretEnc: secretBox.seal(body.clientSecret) }
          : {}),
        ...(subjectClaimChanges ? { subjectClaim: body.subjectClaim } : {}),
      }
      const result = await repository.patch({ id, updates, subjectClaimChanges })
      if (!result.ok) throw providerWriteError(result.code, id, body.slug, 'disable')
      return materialize(result.value)
    },
    async remove(id, force = false) {
      const result = await repository.remove({ id, force })
      if (!result.ok) throw providerWriteError(result.code, id, undefined, 'delete')
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
      const userinfoProfileMode =
        provider.usernameClaim !== null ||
        provider.gitNameClaim !== null ||
        provider.emailClaim !== null
      let jwksReachable: boolean | undefined
      if (!subjectMode && eff.jwksUri !== null) {
        // RFC-254: ref'd timeout — the platform timeout signal never fires on Windows
        // Bun when the loop is otherwise idle (see util/timeoutSignal.ts).
        const deadline = timeoutSignal(10_000)
        try {
          const res = await fetcher(eff.jwksUri, {
            method: 'GET',
            signal: deadline.signal,
          })
          // A 200 with an HTML/empty/malformed body would still fail every
          // id-token verification — "reachable" means "serves a JWKS", so the
          // body must parse to a `{ keys: [...] }` document (impl-gate P2;
          // the pre-RFC-220 probe consumed the body too).
          if (!res.ok) {
            jwksReachable = false
          } else {
            const jwksBody = (await res.json()) as { keys?: unknown }
            jwksReachable =
              typeof jwksBody === 'object' && jwksBody !== null && Array.isArray(jwksBody.keys)
          }
        } catch {
          jwksReachable = false
        } finally {
          deadline.cancel()
        }
      }
      const identityChannelReady = subjectMode
        ? eff.userinfoEndpoint !== null
        : userinfoProfileMode
          ? eff.userinfoEndpoint !== null && (eff.jwksUri === null || jwksReachable === true)
          : eff.jwksUri !== null
            ? jwksReachable === true
            : eff.userinfoEndpoint !== null
      return {
        ok:
          eff.authorizationEndpoint !== null && eff.tokenEndpoint !== null && identityChannelReady,
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

function providerWriteError(
  code:
    | 'oidc-provider-not-found'
    | 'oidc-slug-taken'
    | 'last-enabled-oidc-required'
    | 'subject-claim-locked-by-identities'
    | 'provider-still-linked',
  id: string,
  slug?: string,
  lastProviderOperation?: 'disable' | 'delete',
): Error {
  switch (code) {
    case 'oidc-provider-not-found':
      return new NotFoundError(code, `provider ${id} not found`)
    case 'oidc-slug-taken':
      return new ConflictError(code, `slug '${slug ?? ''}' already exists`)
    case 'last-enabled-oidc-required':
      return new ConflictError(
        code,
        `cannot ${lastProviderOperation ?? 'disable'} the last enabled identity provider while password login is disabled`,
      )
    case 'subject-claim-locked-by-identities':
      return new ConflictError(
        code,
        'subjectClaim cannot change while identities are linked to this provider; delete and recreate the provider instead',
      )
    case 'provider-still-linked':
      return new ConflictError(
        code,
        'one or more users still have identities linked to this provider',
      )
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
