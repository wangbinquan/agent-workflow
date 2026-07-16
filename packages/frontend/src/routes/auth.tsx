// RFC-036 — three-tab login screen:
//   - Password (default)
//   - OIDC provider (shown when /api/auth/oidc/providers returns ≥1 entry)
//   - Daemon token (admin / break-glass fallback)
// Shown when localStorage has no token, after a 401, or on first visit. The
// daemon URL field is no longer surfaced — the SPA always talks to its own
// origin (vite proxy in dev, same-host bundle in prod); remote setups can
// still override BASE_URL_KEY via localStorage for now.

import { createRoute, useRouter, useSearch } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, ApiError } from '@/api/client'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { TabBar, type TabDef } from '@/components/TabBar'
import { TabPanels, type TabPanelDef } from '@/components/split/TabPanels'
import { describeApiError } from '@/i18n'
import { setToken } from '@/stores/auth'
import { Route as RootRoute } from './__root'

interface AuthSearch {
  redirect?: string
}

/**
 * RFC-105 — post-login destination guard. The `redirect` search param is
 * user-controlled (it rides the shared URL), so only same-origin relative
 * paths are honored: it must start with a single `/` and not `//` or `/\`
 * (protocol-relative / backslash open-redirect tricks). Anything else falls
 * back to the default landing page. Preserves the query string so deep links
 * like `/tasks/t/preview?path=docs/report.md` survive login.
 */
export function safeInternalRedirect(redirect: string | undefined): string {
  if (redirect === undefined || !/^\/(?![/\\])/.test(redirect)) return '/agents'
  return redirect
}

interface OidcProvider {
  slug: string
  displayName: string
  iconUrl: string | null
}

type OidcDiscoveryState =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'success'; providers: OidcProvider[] }

type AuthTab = 'password' | 'oidc' | 'token'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/auth',
  validateSearch: (raw: Record<string, unknown>): AuthSearch => {
    const out: AuthSearch = {}
    if (typeof raw.redirect === 'string') out.redirect = raw.redirect
    return out
  },
  component: AuthPage,
})

function AuthPage() {
  const router = useRouter()
  const { redirect } = useSearch({ from: Route.id }) as AuthSearch
  const { t } = useTranslation()
  const [oidcDiscovery, setOidcDiscovery] = useState<OidcDiscoveryState>({ status: 'loading' })
  const [tab, setTab] = useState<AuthTab>('password')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [tokenInput, setTokenInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const usernameRef = useRef<HTMLInputElement>(null)
  const initialFocusDoneRef = useRef(false)
  const discoveryRequestRef = useRef(0)

  // Focus the first password-method field exactly once for this Auth-page
  // landing. Panels stay mounted below, so keyboard tab activation never
  // remounts an autoFocus input and steals focus from the active tab.
  useEffect(() => {
    if (initialFocusDoneRef.current) return
    initialFocusDoneRef.current = true
    usernameRef.current?.focus()
  }, [])

  const discoverOidcProviders = useCallback(async () => {
    const request = ++discoveryRequestRef.current
    setOidcDiscovery({ status: 'loading' })
    try {
      const response = await api.get<{ providers: OidcProvider[] }>('/api/auth/oidc/providers')
      if (discoveryRequestRef.current !== request) return
      setOidcDiscovery({ status: 'success', providers: response.providers ?? [] })
    } catch (error) {
      if (discoveryRequestRef.current !== request) return
      setOidcDiscovery({ status: 'error', error })
    }
  }, [])

  // Discovery is a visible async state, not an empty-list fallback: otherwise
  // a network failure falsely tells users that this installation has no SSO.
  useEffect(() => {
    void discoverOidcProviders()
    return () => {
      discoveryRequestRef.current += 1
    }
  }, [discoverOidcProviders])

  const providers = oidcDiscovery.status === 'success' ? oidcDiscovery.providers : []

  // Note: the `#aw_session=` fragment from the OIDC callback is handled
  // globally in __root.tsx (so any postLoginRedirect target picks it up),
  // not here. If the token lands while we're on /auth the SPA still
  // reflows correctly: setToken triggers the auth-store emit →
  // RootComponent's token-aware fallback drops the bare layout →
  // beforeLoad's redirect-to-/auth check won't refire because the token
  // is now set; user lands on whatever route they navigate to next.

  // When switching tabs, drop any per-tab error so the user gets a clean
  // form. We deliberately keep input values so accidental tab clicks don't
  // wipe what they typed.
  function switchTab(next: AuthTab) {
    setTab(next)
    setError(null)
  }

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const r = await api.post<{ sessionToken: string }>('/api/auth/login', {
        username,
        password,
      })
      setToken(r.sessionToken)
      // history.push (not navigate({to})) so a redirect carrying a query
      // string (shared deep link) is honored verbatim; guarded against
      // open redirects by safeInternalRedirect.
      router.history.push(safeInternalRedirect(redirect))
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setError(t('auth.invalidCredentials'))
      } else {
        setError(describeApiError(e))
      }
    } finally {
      setBusy(false)
    }
  }

  async function handleTokenSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    setToken(tokenInput)
    try {
      await api.get('/api/whoami')
      router.history.push(safeInternalRedirect(redirect))
    } catch (e) {
      setError(describeApiError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleOidcLogin(slug: string) {
    setError(null)
    try {
      const r = await api.post<{ authorizeUrl: string }>(`/api/auth/oidc/${slug}/login/start`, {
        // Strip any #fragment: the OIDC callback appends `#aw_session=…`, and a
        // second fragment (e.g. a preview heading anchor) would break the
        // `^#aw_session=` consumer in stores/auth.ts → login bounces.
        postLoginRedirect: safeInternalRedirect(redirect).split('#')[0] || '/agents',
      })
      window.location.href = r.authorizeUrl
    } catch (e) {
      setError(describeApiError(e))
    }
  }

  const tabs: Array<TabDef<AuthTab>> = [
    { key: 'password', label: t('auth.tabPassword', { defaultValue: 'Password' }) },
  ]
  if (providers.length > 0) {
    tabs.push({ key: 'oidc', label: t('auth.tabOidc', { defaultValue: 'Identity provider' }) })
  }
  tabs.push({ key: 'token', label: t('auth.tabToken', { defaultValue: 'Daemon token' }) })

  const panels: Array<TabPanelDef<AuthTab>> = [
    {
      key: 'password',
      testid: 'auth-tabpanel-password',
      content: (
        <form onSubmit={handlePasswordSubmit} className="form-grid">
          <Field label={t('auth.username', { defaultValue: 'Username' })}>
            <TextInput
              inputRef={usernameRef}
              type="text"
              autoComplete="username"
              value={username}
              onChange={setUsername}
              placeholder={t('auth.usernamePlaceholder', { defaultValue: 'alice' })}
            />
          </Field>
          <Field label={t('auth.password', { defaultValue: 'Password' })}>
            <TextInput
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={setPassword}
              placeholder={t('auth.passwordPlaceholder', { defaultValue: '••••••••' })}
            />
          </Field>
          {error !== null && <ErrorBanner error={error} />}
          <button
            type="submit"
            className="btn btn--primary"
            disabled={busy || !username || !password}
            aria-busy={busy}
          >
            {busy ? t('auth.verifying') : t('auth.signIn', { defaultValue: t('auth.connect') })}
          </button>
        </form>
      ),
    },
  ]
  if (providers.length > 0) {
    panels.push({
      key: 'oidc',
      testid: 'auth-tabpanel-oidc',
      content: (
        <div className="auth-page__providers">
          <p className="auth-page__provider-hint">
            {t('auth.oidcHint', { defaultValue: 'Sign in with an external identity provider.' })}
          </p>
          {providers.map((p) => (
            <button
              key={p.slug}
              type="button"
              className="auth-page__provider-btn"
              onClick={() => handleOidcLogin(p.slug)}
            >
              {t('auth.loginWith', {
                name: p.displayName,
                defaultValue: `Login with ${p.displayName}`,
              })}
            </button>
          ))}
          {error !== null && <ErrorBanner error={error} />}
        </div>
      ),
    })
  }
  panels.push({
    key: 'token',
    testid: 'auth-tabpanel-token',
    content: (
      <form onSubmit={handleTokenSubmit} className="form-grid">
        <p className="auth-form__hint">
          {t('auth.tokenHint', {
            defaultValue:
              'Use the 64-char hex token printed when the daemon started. Admin / break-glass only.',
          })}
        </p>
        <Field label={t('auth.token')}>
          <TextInput
            type="password"
            value={tokenInput}
            onChange={setTokenInput}
            placeholder={t('auth.tokenPlaceholder')}
          />
        </Field>
        {error !== null && <ErrorBanner error={error} />}
        <button
          type="submit"
          className="btn btn--primary"
          disabled={busy || !tokenInput}
          aria-busy={busy}
        >
          {busy ? t('auth.verifying') : t('auth.connect')}
        </button>
      </form>
    ),
  })

  return (
    <div className="auth-page">
      <h1>{t('auth.title')}</h1>
      <p className="auth-page__hint">{t('auth.subtitle', { defaultValue: t('auth.hint') })}</p>
      <TabBar<AuthTab>
        tabs={tabs}
        active={tab}
        onSelect={switchTab}
        variant="segment"
        ariaLabel={t('auth.title')}
        idPrefix="auth-method"
      />
      {oidcDiscovery.status === 'loading' && (
        <LoadingState
          size="compact"
          label={t('auth.oidcDiscoveryLoading')}
          data-testid="oidc-discovery-loading"
        />
      )}
      {oidcDiscovery.status === 'error' && (
        <ErrorBanner
          error={oidcDiscovery.error}
          message={t('auth.oidcDiscoveryError')}
          action={
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => void discoverOidcProviders()}
            >
              {t('common.retry')}
            </button>
          }
        />
      )}
      {oidcDiscovery.status === 'success' && providers.length === 0 && (
        <NoticeBanner tone="info" size="compact">
          {t('auth.oidcDiscoveryEmpty')}
        </NoticeBanner>
      )}
      <TabPanels<AuthTab> active={tab} panels={panels} idPrefix="auth-method" />
    </div>
  )
}
