// RFC-036 — public OIDC login flow:
//   GET  /api/auth/oidc/providers              public list of enabled IdPs
//   POST /api/auth/oidc/:slug/login/start      mints PKCE/state + redirect URL
//   GET  /api/auth/oidc/:slug/callback         IdP callback; issues a session

import type { Context, Hono } from 'hono'
import { loadConfig } from '@/config'
import { resolveEndpoints } from '@/auth/oidc/endpoints'
import { acquireIdentityClaims } from '@/auth/oidc/identity'
import { consumeFlow, startFlow } from '@/auth/oidc/flow'
import { OidcTokenError, exchangeCodeForTokens } from '@/auth/oidc/tokens'
import { createSession } from '@/auth/sessionStore'
import { createOidcProvidersService } from '@/services/oidcProviders'
import {
  bindInvitedUserWithIdentity,
  createIdentity,
  createUserWithIdentity,
  findByProviderSubject,
  syncPreferredSnapshot,
} from '@/services/userIdentities'
import {
  applyEmailTrust,
  decideProvisioning,
  type IdTokenClaims,
} from '@/services/oidc/provisioning'
import { findByUsername } from '@/services/users'
import type { AppDeps } from '@/server'
import { eq } from 'drizzle-orm'
import { users } from '@/db/schema'
import { DomainError } from '@/util/errors'
import { BadRequestErrorOrFriendlyHtml, friendly } from '@/util/oidcResponse'

export function mountOidcAuthRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/auth/oidc/providers', async (c) => {
    if (!deps.secretBox) return c.json({ providers: [] })
    const svc = createOidcProvidersService({ db: deps.db, secretBox: deps.secretBox })
    return c.json({ providers: await svc.listPublic() })
  })

  app.post('/api/auth/oidc/:slug/login/start', async (c) => {
    if (!deps.secretBox) return c.json({ ok: false, code: 'oidc-not-configured' }, 503)
    const svc = createOidcProvidersService({ db: deps.db, secretBox: deps.secretBox })
    const provider = await svc.findBySlug(c.req.param('slug'))
    if (!provider || !provider.enabled) {
      return c.json({ ok: false, code: 'provider-not-found' }, 404)
    }
    const body = (await safeJson(c.req.raw)) as Record<string, unknown>
    const postLoginRedirect =
      typeof body.postLoginRedirect === 'string' ? body.postLoginRedirect : undefined
    const redirectUri = resolveRedirectUri(c, provider.slug, deps)
    // RFC-220 — discovery merged over manual fallbacks; a failure used to
    // escape as an unhandled 500 here (behavior change #1).
    const eff = await resolveEndpoints(provider)
    if (!eff.authorizationEndpoint) {
      return c.json(
        {
          ok: false,
          code: 'oidc-endpoints-unresolved',
          // message must be present: the frontend error decoder only keeps a
          // structured code when code AND message are both strings
          // (api/client.ts extractErrorBody).
          message: 'identity provider endpoints could not be resolved',
        },
        503,
      )
    }
    const flow = startFlow(provider.id, {
      redirectUri,
      ...(postLoginRedirect ? { postLoginRedirect } : {}),
    })
    const authorizeUrl = buildAuthorizeUrl(eff.authorizationEndpoint, {
      clientId: provider.clientId,
      scopes: provider.scopes,
      state: flow.state,
      codeChallenge: flow.codeChallenge,
      nonce: flow.nonce,
      redirectUri,
    })
    return c.json({ authorizeUrl, state: flow.state })
  })

  app.get('/api/auth/oidc/:slug/callback', async (c) => {
    if (!deps.secretBox) return c.html(friendly('oidc-not-configured'), 503)
    const code = c.req.query('code')
    const state = c.req.query('state')
    if (!code || !state) return c.html(friendly('invalid-callback'), 400)
    const flow = consumeFlow(state)
    if (!flow) return c.html(friendly('state-expired'), 400)

    const svc = createOidcProvidersService({ db: deps.db, secretBox: deps.secretBox })
    const provider = await svc.findById(flow.providerId)
    if (!provider || !provider.enabled) {
      return c.html(friendly('provider-disabled'), 400)
    }
    const clientSecret = await svc.resolveClientSecret(provider.id)
    if (!clientSecret) return c.html(friendly('client-secret-missing'), 500)

    // RFC-220 — effective endpoints: discovery merged over manual fallbacks.
    const eff = await resolveEndpoints(provider)
    if (!eff.tokenEndpoint) return c.html(friendly('endpoints-unresolved'), 503)

    let claims: IdTokenClaims
    try {
      const tokens = await exchangeCodeForTokens({
        tokenEndpoint: eff.tokenEndpoint,
        clientId: provider.clientId,
        clientSecret,
        code,
        codeVerifier: flow.codeVerifier,
        redirectUri: flow.redirectUri,
      })
      claims = applyEmailTrust(
        await acquireIdentityClaims({
          tokens,
          effective: eff,
          clientId: provider.clientId,
          nonce: flow.nonce,
          usernameClaim: provider.usernameClaim,
          subjectClaim: provider.subjectClaim,
          userinfoRequestStyle: provider.userinfoRequestStyle,
          scopes: provider.scopes,
        }),
        provider.trustEmailVerified,
      )
    } catch (err) {
      const code =
        err instanceof BadRequestErrorOrFriendlyHtml
          ? err.code
          : err instanceof OidcTokenError
            ? err.code
            : 'verify-failed'
      return c.html(friendly(code), 400)
    }

    // RFC-220 D7 — identity snapshot seed ('' = observed-but-absent sentinel);
    // only meaningful when usernameClaim is configured.
    const snapshotInit = provider.usernameClaim !== null ? (claims.preferred_username ?? '') : null

    if (flow.linkUserId) {
      try {
        await createIdentity(deps.db, {
          userId: flow.linkUserId,
          providerId: provider.id,
          subject: claims.sub,
          email: claims.email ?? null,
          emailVerified: !!claims.email_verified,
          preferredSnapshot: snapshotInit,
          expectedSubjectClaim: provider.subjectClaim,
        })
      } catch (err) {
        if (isDomainCode(err, 'provider-config-changed')) {
          return c.html(friendly('provider-config-changed'), 400)
        }
        return c.html(friendly('identity-already-linked'), 409)
      }
      return c.redirect(flow.postLoginRedirect ?? `/account?linked=${provider.slug}`)
    }

    const existingIdentity = await findByProviderSubject(deps.db, provider.id, claims.sub)
    const invited =
      claims.email && claims.email_verified ? await findInvitedByEmail(deps, claims.email) : null
    const decision = decideProvisioning(
      provider,
      claims,
      existingIdentity ? { userId: existingIdentity.userId } : null,
      invited,
    )
    if (decision.action === 'reject') {
      return c.html(friendly(decision.reason), 403)
    }

    const identitySeed = {
      providerId: provider.id,
      subject: claims.sub,
      email: claims.email ?? null,
      emailVerified: !!claims.email_verified,
      preferredSnapshot: snapshotInit,
      expectedSubjectClaim: provider.subjectClaim,
    }
    let userId: string
    try {
      switch (decision.action) {
        case 'login':
          userId = decision.userId
          // RFC-220 D7 — presented-name follow + email_verified sync for the
          // existing identity (three-way snapshot merge, design §5.3).
          syncPreferredSnapshot(deps.db, {
            providerId: provider.id,
            subject: claims.sub,
            userId,
            composed: provider.usernameClaim !== null ? (claims.preferred_username ?? null) : null,
            emailVerified: !!claims.email_verified,
            usernameClaimConfigured: provider.usernameClaim !== null,
          })
          break
        case 'create': {
          // OIDC auto-provisioning: the IdP verified the identity, so the user
          // lands as `active` immediately. User row + identity row commit in
          // ONE transaction — a subjectClaim race must roll back both instead
          // of leaving an identity-less active account (design §6.2).
          const created = await createUserWithIdentity(deps.db, {
            username: await pickUniqueUsername(deps, claims),
            displayName:
              (provider.usernameClaim !== null ? claims.preferred_username : null) ??
              claims.name ??
              claims.email ??
              'OIDC User',
            email: claims.email ?? null,
            identity: identitySeed,
          })
          userId = created.userId
          break
        }
        case 'bindInvited':
          await bindInvitedUserWithIdentity(deps.db, {
            userId: decision.userId,
            identity: identitySeed,
          })
          userId = decision.userId
          break
      }
    } catch (err) {
      // The write-time subjectClaim recheck throws AFTER the claims try/catch;
      // without this second net it would surface as a JSON 500 instead of the
      // promised friendly page (design §6.2).
      if (isDomainCode(err, 'provider-config-changed')) {
        return c.html(friendly('provider-config-changed'), 400)
      }
      if (isDomainCode(err, 'identity-already-linked')) {
        return c.html(friendly('identity-already-linked'), 409)
      }
      throw err
    }

    const { token } = await createSession({ db: deps.db, userId })
    // For SPA login: redirect with token in fragment so localStorage hook can
    // pick it up without leaking to server logs.
    return c.redirect(`${flow.postLoginRedirect ?? '/'}#aw_session=${encodeURIComponent(token)}`)
  })
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}

function isDomainCode(err: unknown, code: string): boolean {
  return err instanceof DomainError && err.code === code
}

function resolveRedirectUri(c: Context, slug: string, deps: AppDeps): string {
  // RFC-036 — explicit publicBaseUrl in config.json takes precedence so dev
  // setups behind a proxy that doesn't forward X-Forwarded-* (e.g. vite)
  // still issue redirects that land back on the user-facing origin.
  try {
    const cfg = loadConfig(deps.configPath)
    if (typeof cfg.publicBaseUrl === 'string' && cfg.publicBaseUrl.length > 0) {
      const base = cfg.publicBaseUrl.replace(/\/$/, '')
      return `${base}/api/auth/oidc/${slug}/callback`
    }
  } catch {
    // ignore — fall through to header-based derivation
  }
  const proto = c.req.header('X-Forwarded-Proto') ?? new URL(c.req.url).protocol.replace(/:$/, '')
  const host = c.req.header('X-Forwarded-Host') ?? c.req.header('Host')
  return `${proto}://${host}/api/auth/oidc/${slug}/callback`
}

function buildAuthorizeUrl(
  endpoint: string,
  args: {
    clientId: string
    scopes: string
    state: string
    codeChallenge: string
    nonce: string
    redirectUri: string
  },
): string {
  const url = new URL(endpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', args.clientId)
  url.searchParams.set('redirect_uri', args.redirectUri)
  url.searchParams.set('scope', args.scopes)
  url.searchParams.set('state', args.state)
  url.searchParams.set('code_challenge', args.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('nonce', args.nonce)
  return url.toString()
}

async function pickUniqueUsername(deps: AppDeps, claims: IdTokenClaims): Promise<string> {
  const base = (claims.preferred_username || claims.email?.split('@')[0] || `oidc-${claims.sub}`)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^[-_]+/, '')
    .slice(0, 48)
  let candidate = base || `oidc-${Date.now()}`
  for (let i = 0; i < 10; i++) {
    const dup = await findByUsername(deps.db, candidate)
    if (!dup) return candidate
    candidate = `${base}-${i + 1}`
  }
  return `${base}-${Date.now()}`
}

async function findInvitedByEmail(deps: AppDeps, email: string) {
  const rows = await deps.db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1)
  const row = rows[0]
  if (!row || row.status !== 'invited') return null
  return {
    id: row.id,
    email: row.email,
    status: row.status as 'active' | 'disabled' | 'invited',
  }
}
