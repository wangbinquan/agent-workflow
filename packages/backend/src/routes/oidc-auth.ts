// RFC-036 — public OIDC login flow:
//   GET  /api/auth/oidc/providers              public list of enabled IdPs
//   POST /api/auth/oidc/:slug/login/start      mints PKCE/state + redirect URL
//   GET  /api/auth/oidc/:slug/callback         IdP callback; issues a session

import type { Context, Hono } from 'hono'
import type { OidcProvider } from '@agent-workflow/shared'
import { publicOriginOf } from '@/routes/publicOrigin'
import { resolveEndpoints } from '@/auth/oidc/endpoints'
import { acquireIdentityClaims, resolveOidcProfileNames } from '@/auth/oidc/identity'
import { consumeFlow, startFlow } from '@/auth/oidc/flow'
import { OidcTokenError, exchangeCodeForTokens } from '@/auth/oidc/tokens'
import type { AuthRuntime } from '@/auth/application/authRuntime'
import {
  applyEmailTrust,
  decideProvisioning,
  type IdTokenClaims,
} from '@/services/oidc/provisioning'
import { registerRoute } from '@/routes/registry'
import { DomainError } from '@/util/errors'
import { BadRequestErrorOrFriendlyHtml, friendly } from '@/util/oidcResponse'
import { safeJsonOrEmpty } from '@/util/http'

export interface OidcIdentitySeed {
  readonly providerId: string
  readonly subject: string
  readonly email: string | null
  readonly emailVerified: boolean
  readonly displayName?: string
  readonly gitName?: string
  readonly preferredSnapshot?: string | null
  readonly expectedSubjectClaim?: string | null
  readonly expectedUsernameClaim?: string | null
  readonly expectedGitNameClaim?: string | null
  readonly expectedEmailClaim?: string | null
  readonly now?: number
}

export interface OidcIdentityLinkInput extends OidcIdentitySeed {
  readonly userId: string
}

export interface OidcAuthIdentityBindings {
  readonly findByProviderSubject: (
    providerId: string,
    subject: string,
  ) => Promise<{ readonly userId: string } | null>
  readonly createIdentity: (input: OidcIdentityLinkInput) => Promise<unknown>
  readonly createUserWithIdentity: (input: {
    readonly username: string
    readonly displayName: string
    readonly gitName: string
    readonly email?: string | null
    readonly identity: OidcIdentitySeed
  }) => Promise<{ readonly userId: string }>
  readonly bindInvitedUserWithIdentity: (input: {
    readonly userId: string
    readonly identity: OidcIdentitySeed
  }) => Promise<void>
  readonly syncPreferredSnapshot: (input: {
    readonly providerId: string
    readonly subject: string
    readonly userId: string
    readonly displayName: string
    readonly gitName: string
    readonly email?: string | null
    readonly emailVerified: boolean
    readonly expectedSubjectClaim?: string | null
    readonly expectedUsernameClaim?: string | null
    readonly expectedGitNameClaim?: string | null
    readonly expectedEmailClaim?: string | null
  }) => Promise<unknown>
}

export interface OidcAuthRouteBindings {
  readonly auth: AuthRuntime
  readonly providers: {
    readonly findById: (id: string) => Promise<OidcProvider | null>
    readonly findBySlug: (slug: string) => Promise<OidcProvider | null>
    readonly resolveClientSecret: (id: string) => Promise<string | null>
  } | null
  readonly identities: OidcAuthIdentityBindings
}

export function mountOidcAuthRoutes(
  app: Hono,
  deps: { readonly configPath: string },
  bindings: OidcAuthRouteBindings,
): void {
  const { auth, identities, providers } = bindings
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/auth/oidc/providers',
      permissions: [],
      publicReason:
        'login flow; must answer before any identity exists (already in multiAuth PUBLIC_PATH_PREFIXES)',
      tokenAccess: 'never',
      summary: 'List enabled OIDC providers for the login page',
    },
    async (c) => {
      return c.json(await auth.getLoginMethodDiscovery(providers !== null))
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/auth/oidc/:slug/login/start',
      permissions: [],
      publicReason:
        'login flow; must answer before any identity exists (already in multiAuth PUBLIC_PATH_PREFIXES)',
      tokenAccess: 'never',
      summary: 'Begin an OIDC login',
    },
    async (c) => {
      await auth.assertBootstrapComplete()
      if (providers === null) return c.json({ ok: false, code: 'oidc-not-configured' }, 503)
      const provider = await providers.findBySlug(c.req.param('slug'))
      if (!provider || !provider.enabled) {
        return c.json({ ok: false, code: 'provider-not-found' }, 404)
      }
      const body = (await safeJsonOrEmpty(c.req.raw)) as Record<string, unknown>
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
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/auth/oidc/:slug/callback',
      permissions: [],
      publicReason:
        'login flow; must answer before any identity exists (already in multiAuth PUBLIC_PATH_PREFIXES)',
      tokenAccess: 'never',
      summary: 'OIDC callback',
    },
    async (c) => {
      if ((await auth.getLoginPolicy()).bootstrapCompletedAt === null) {
        return c.html(friendly('bootstrap-admin-required'), 403)
      }
      if (providers === null) return c.html(friendly('oidc-not-configured'), 503)
      const code = c.req.query('code')
      const state = c.req.query('state')
      if (!code || !state) return c.html(friendly('invalid-callback'), 400)
      const flow = consumeFlow(state)
      if (!flow) return c.html(friendly('state-expired'), 400)

      const provider = await providers.findById(flow.providerId)
      if (!provider || !provider.enabled) {
        return c.html(friendly('provider-disabled'), 400)
      }
      const clientSecret = await providers.resolveClientSecret(provider.id)
      if (!clientSecret) return c.html(friendly('client-secret-missing'), 500)

      // RFC-220 — effective endpoints: discovery merged over manual fallbacks.
      const eff = await resolveEndpoints(provider)
      if (!eff.tokenEndpoint) return c.html(friendly('endpoints-unresolved'), 503)

      let claims: IdTokenClaims
      let displayName: string
      let gitName: string
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
            gitNameClaim: provider.gitNameClaim,
            emailClaim: provider.emailClaim,
            subjectClaim: provider.subjectClaim,
            userinfoRequestStyle: provider.userinfoRequestStyle,
            scopes: provider.scopes,
          }),
          provider.trustEmailVerified,
        )
        const profileNames = resolveOidcProfileNames(provider, claims)
        displayName = profileNames.displayName
        gitName = profileNames.gitName
      } catch (err) {
        const code =
          err instanceof BadRequestErrorOrFriendlyHtml
            ? err.code
            : err instanceof OidcTokenError
              ? err.code
              : 'verify-failed'
        return c.html(friendly(code), 400)
      }

      // RFC-335 — retained for compatibility/diagnostics only; it no longer
      // controls whether profile reconciliation overwrites an in-app edit.
      const snapshotInit = displayName

      if (flow.linkUserId) {
        try {
          await identities.createIdentity({
            userId: flow.linkUserId,
            providerId: provider.id,
            subject: claims.sub,
            email: claims.email ?? null,
            emailVerified: !!claims.email_verified,
            displayName,
            gitName,
            preferredSnapshot: snapshotInit,
            expectedSubjectClaim: provider.subjectClaim,
            expectedUsernameClaim: provider.usernameClaim,
            expectedGitNameClaim: provider.gitNameClaim,
            expectedEmailClaim: provider.emailClaim,
          })
        } catch (err) {
          if (isDomainCode(err, 'provider-config-changed')) {
            return c.html(friendly('provider-config-changed'), 400)
          }
          if (isDomainCode(err, 'oidc-email-conflict')) {
            return c.html(friendly('oidc-email-conflict'), 409)
          }
          return c.html(friendly('identity-already-linked'), 409)
        }
        return c.redirect(flow.postLoginRedirect ?? `/account?linked=${provider.slug}`)
      }

      const existingIdentity = await identities.findByProviderSubject(provider.id, claims.sub)
      const invited =
        claims.email && claims.email_verified
          ? await auth.findInvitedUserByEmail(claims.email)
          : null
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
        displayName,
        gitName,
        preferredSnapshot: snapshotInit,
        expectedSubjectClaim: provider.subjectClaim,
        expectedUsernameClaim: provider.usernameClaim,
        expectedGitNameClaim: provider.gitNameClaim,
        expectedEmailClaim: provider.emailClaim,
      }
      let userId: string
      try {
        switch (decision.action) {
          case 'login':
            userId = decision.userId
            // RFC-335 — both names reconcile on every successful callback.
            await identities.syncPreferredSnapshot({
              providerId: provider.id,
              subject: claims.sub,
              userId,
              displayName,
              gitName,
              email: claims.email ?? null,
              emailVerified: !!claims.email_verified,
              expectedSubjectClaim: provider.subjectClaim,
              expectedUsernameClaim: provider.usernameClaim,
              expectedGitNameClaim: provider.gitNameClaim,
              expectedEmailClaim: provider.emailClaim,
            })
            break
          case 'create': {
            // OIDC auto-provisioning: the IdP verified the identity, so the user
            // lands as `active` immediately. User row + identity row commit in
            // ONE transaction — a subjectClaim race must roll back both instead
            // of leaving an identity-less active account (design §6.2).
            const created = await identities.createUserWithIdentity({
              username: await pickUniqueUsername(auth, claims),
              displayName,
              gitName,
              email: claims.email ?? null,
              identity: identitySeed,
            })
            userId = created.userId
            break
          }
          case 'bindInvited':
            await identities.bindInvitedUserWithIdentity({
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
        if (isDomainCode(err, 'oidc-email-conflict')) {
          return c.html(friendly('oidc-email-conflict'), 409)
        }
        if (
          err instanceof DomainError &&
          (err.code === 'oidc-display-name-claim-invalid' ||
            err.code === 'oidc-git-name-claim-invalid')
        ) {
          return c.html(friendly(err.code), 400)
        }
        throw err
      }

      const { token } = await auth.createLoginSession({ userId })
      // For SPA login: redirect with token in fragment so localStorage hook can
      // pick it up without leaking to server logs.
      return c.redirect(`${flow.postLoginRedirect ?? '/'}#aw_session=${encodeURIComponent(token)}`)
    },
  )
}

function isDomainCode(err: unknown, code: string): boolean {
  return err instanceof DomainError && err.code === code
}

function resolveRedirectUri(
  c: Context,
  slug: string,
  deps: { readonly configPath: string },
): string {
  // RFC-036 — explicit publicBaseUrl in config.json takes precedence so dev
  // setups behind a proxy that doesn't forward X-Forwarded-* (e.g. vite)
  // still issue redirects that land back on the user-facing origin.
  //
  // The precedence itself now lives in `routes/publicOrigin.ts`, shared with the
  // RFC-247 documentation surfaces: they need the same answer, and two copies of
  // this rule is how the two drift. Order is unchanged (config → X-Forwarded-*
  // → Host → request URL); the one difference is that a request carrying no
  // Host header at all now falls back to the request URL instead of producing
  // the literal `http://undefined/...` this used to emit.
  return `${publicOriginOf(c, deps.configPath)}/api/auth/oidc/${slug}/callback`
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

async function pickUniqueUsername(auth: AuthRuntime, claims: IdTokenClaims): Promise<string> {
  const base = (claims.preferred_username || claims.email?.split('@')[0] || `oidc-${claims.sub}`)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^[-_]+/, '')
    .slice(0, 48)
  let candidate = base || `oidc-${Date.now()}`
  for (let i = 0; i < 10; i++) {
    const dup = await auth.findUserByUsername(candidate)
    if (!dup) return candidate
    candidate = `${base}-${i + 1}`
  }
  return `${base}-${Date.now()}`
}
