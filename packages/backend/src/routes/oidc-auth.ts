// RFC-036 — public OIDC login flow:
//   GET  /api/auth/oidc/providers              public list of enabled IdPs
//   POST /api/auth/oidc/:slug/login/start      mints PKCE/state + redirect URL
//   GET  /api/auth/oidc/:slug/callback         IdP callback; issues a session

import type { Context, Hono } from 'hono'
import { loadConfig } from '@/config'
import { getProviderMetadata } from '@/auth/oidc/discovery'
import { consumeFlow, startFlow } from '@/auth/oidc/flow'
import { exchangeCodeForTokens, verifyIdToken } from '@/auth/oidc/tokens'
import { createSession } from '@/auth/sessionStore'
import { createOidcProvidersService } from '@/services/oidcProviders'
import { createIdentity, findByProviderSubject } from '@/services/userIdentities'
import { decideProvisioning, type IdTokenClaims } from '@/services/oidc/provisioning'
import { createUser, findByUsername } from '@/services/users'
import type { AppDeps } from '@/server'
import { eq } from 'drizzle-orm'
import { users } from '@/db/schema'
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
    const flow = startFlow(provider.id, {
      redirectUri,
      ...(postLoginRedirect ? { postLoginRedirect } : {}),
    })
    const { metadata } = await getProviderMetadata(provider.issuerUrl)
    const authorizeUrl = buildAuthorizeUrl(metadata.authorization_endpoint, {
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

    let metadata: Awaited<ReturnType<typeof getProviderMetadata>>['metadata']
    let jwks: Awaited<ReturnType<typeof getProviderMetadata>>['jwks']
    try {
      const m = await getProviderMetadata(provider.issuerUrl)
      metadata = m.metadata
      jwks = m.jwks
    } catch {
      return c.html(friendly('discovery-failed'), 503)
    }

    let claims: IdTokenClaims
    try {
      const tokens = await exchangeCodeForTokens({
        tokenEndpoint: metadata.token_endpoint,
        clientId: provider.clientId,
        clientSecret,
        code,
        codeVerifier: flow.codeVerifier,
        redirectUri: flow.redirectUri,
      })
      const payload = await verifyIdToken({
        idToken: tokens.id_token,
        jwks,
        issuer: metadata.issuer,
        audience: provider.clientId,
        nonce: flow.nonce,
      })
      claims = {
        sub: String(payload.sub ?? ''),
        email: typeof payload.email === 'string' ? payload.email : null,
        email_verified: payload.email_verified === true,
        name: typeof payload.name === 'string' ? payload.name : null,
        preferred_username:
          typeof payload.preferred_username === 'string' ? payload.preferred_username : null,
      }
    } catch (err) {
      const code = err instanceof BadRequestErrorOrFriendlyHtml ? err.code : 'verify-failed'
      return c.html(friendly(code), 400)
    }

    if (flow.linkUserId) {
      try {
        await createIdentity(deps.db, {
          userId: flow.linkUserId,
          providerId: provider.id,
          subject: claims.sub,
          email: claims.email ?? null,
          emailVerified: !!claims.email_verified,
        })
      } catch {
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

    let userId: string
    switch (decision.action) {
      case 'login':
        userId = decision.userId
        break
      case 'create': {
        const created = await createUser(deps.db, {
          username: await pickUniqueUsername(deps, claims),
          displayName: claims.name ?? claims.email ?? 'OIDC User',
          email: claims.email ?? undefined,
          role: 'user',
          // OIDC auto-provisioning: the IdP verified the identity, so the
          // user lands as `active` immediately. Without this override
          // createUser would default to `invited` (password is null) and
          // every subsequent /api/auth/me call would 401.
          status: 'active',
        })
        await createIdentity(deps.db, {
          userId: created.id,
          providerId: provider.id,
          subject: claims.sub,
          email: claims.email ?? null,
          emailVerified: !!claims.email_verified,
        })
        userId = created.id
        break
      }
      case 'bindInvited':
        await deps.db
          .update(users)
          .set({ status: 'active', updatedAt: Date.now() })
          .where(eq(users.id, decision.userId))
        await createIdentity(deps.db, {
          userId: decision.userId,
          providerId: provider.id,
          subject: claims.sub,
          email: claims.email ?? null,
          emailVerified: !!claims.email_verified,
        })
        userId = decision.userId
        break
      case 'reject':
        return c.html(friendly(decision.reason), 403)
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
