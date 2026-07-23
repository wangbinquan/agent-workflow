// RFC-221 — server-discovered authentication entry point.
// Fresh installs expose daemon-token bootstrap only. After the first admin is
// committed, daemon auth disappears permanently and this page derives exactly
// the ready methods allowed by the persisted password/OIDC policy.

import type { AuthMethodDiscovery } from '@agent-workflow/shared'
import { AuthMethodDiscoverySchema } from '@agent-workflow/shared'
import { createRoute, useRouter, useSearch } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, ApiError } from '@/api/client'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { TabBar, type TabDef } from '@/components/TabBar'
import { AuthExperienceShell } from '@/components/auth/AuthExperienceShell'
import { TabPanels } from '@/components/split/TabPanels'
import { describeApiError } from '@/i18n'
import { clearToken, getToken, setToken } from '@/stores/auth'
import { Route as RootRoute } from './__root'

interface AuthSearch {
  redirect?: string
  setup?: 'complete'
  bootstrap?: 'token'
}

export function safeInternalRedirect(redirect: string | undefined): string {
  if (redirect === undefined || !/^\/(?![/\\])/.test(redirect)) return '/agents'
  return redirect
}

export function setupAdminHref(redirect: string | undefined): string {
  return `/setup/admin?redirect=${encodeURIComponent(safeInternalRedirect(redirect))}`
}

export type AuthMethod = 'password' | 'oidc' | 'token'

export function deriveAuthMethods(discovery: AuthMethodDiscovery): AuthMethod[] {
  if (discovery.mode === 'bootstrap') return ['token']
  const methods: AuthMethod[] = []
  if (discovery.providers.length > 0) methods.push('oidc')
  if (discovery.passwordLoginEnabled) methods.push('password')
  return methods
}

type DiscoveryState =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'success'; value: AuthMethodDiscovery }

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/auth',
  validateSearch: (raw: Record<string, unknown>): AuthSearch => {
    const out: AuthSearch = {}
    if (typeof raw.redirect === 'string') out.redirect = raw.redirect
    if (raw.setup === 'complete') out.setup = 'complete'
    if (raw.bootstrap === 'token') out.bootstrap = 'token'
    return out
  },
  component: AuthPage,
})

function AuthPage() {
  const router = useRouter()
  const {
    redirect,
    setup,
    bootstrap: bootstrapHandoff,
  } = useSearch({
    from: Route.id,
  }) as AuthSearch
  const { t } = useTranslation()
  const [discovery, setDiscovery] = useState<DiscoveryState>({ status: 'loading' })
  const [active, setActive] = useState<AuthMethod>('password')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [tokenInput, setTokenInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const usernameRef = useRef<HTMLInputElement>(null)
  const tokenRef = useRef<HTMLInputElement>(null)
  const interactedRef = useRef(false)
  const requestRef = useRef(0)
  const bootstrapHandoffRef = useRef(false)

  const discover = useCallback(async () => {
    const request = ++requestRef.current
    setDiscovery({ status: 'loading' })
    try {
      const raw = await api.get<unknown>('/api/auth/oidc/providers')
      const value = AuthMethodDiscoverySchema.parse(raw)
      if (requestRef.current === request) setDiscovery({ status: 'success', value })
    } catch (nextError) {
      if (requestRef.current === request) setDiscovery({ status: 'error', error: nextError })
    }
  }, [])

  useEffect(() => {
    void discover()
    return () => {
      requestRef.current += 1
    }
  }, [discover])

  const methods = discovery.status === 'success' ? deriveAuthMethods(discovery.value) : []

  useEffect(() => {
    if (discovery.status !== 'success') return
    const next = deriveAuthMethods(discovery.value)
    if (next.length === 0) return
    if (!next.includes(active) || !interactedRef.current) setActive(next[0]!)
  }, [active, discovery])

  useEffect(() => {
    if (discovery.status !== 'success' || interactedRef.current) return
    const next = deriveAuthMethods(discovery.value)[0]
    queueMicrotask(() => {
      if (next === 'password') usernameRef.current?.focus()
      if (next === 'token') tokenRef.current?.focus()
    })
  }, [discovery])

  useEffect(() => {
    if (
      bootstrapHandoff !== 'token' ||
      discovery.status !== 'success' ||
      bootstrapHandoffRef.current
    ) {
      return
    }
    bootstrapHandoffRef.current = true

    const authHref = `/auth?redirect=${encodeURIComponent(safeInternalRedirect(redirect))}`
    if (discovery.value.mode !== 'bootstrap') {
      // A bookmarked daemon URL may outlive bootstrap. Never retain that stale
      // credential or resurrect the retired token method on a ready install.
      clearToken()
      router.history.replace(authHref)
      return
    }

    const token = getToken()
    if (token === null) {
      setError(t('auth.bootstrapTokenRequired'))
      router.history.replace(authHref)
      return
    }

    let activeRequest = true
    setBusy(true)
    void api
      .get<{ source: string }>('/api/whoami')
      .then((who) => {
        if (!activeRequest) return
        if (who.source !== 'daemon') throw new Error(t('auth.bootstrapTokenRequired'))
        router.history.replace(setupAdminHref(redirect))
      })
      .catch((nextError: unknown) => {
        if (!activeRequest) return
        clearToken()
        setError(describeApiError(nextError))
        router.history.replace(authHref)
      })
      .finally(() => {
        if (activeRequest) setBusy(false)
      })

    return () => {
      activeRequest = false
    }
  }, [bootstrapHandoff, discovery, redirect, router, t])

  const draftSetter = (setter: (value: string) => void) => (value: string) => {
    interactedRef.current = true
    setter(value)
  }

  const selectMethod = (method: AuthMethod) => {
    interactedRef.current = true
    setActive(method)
    setError(null)
  }

  async function handlePasswordSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const result = await api.post<{ sessionToken: string }>('/api/auth/login', {
        username,
        password,
      })
      setToken(result.sessionToken)
      router.history.replace(safeInternalRedirect(redirect))
    } catch (nextError) {
      if (nextError instanceof ApiError && nextError.status === 401) {
        setError(t('auth.invalidCredentials'))
      } else {
        setError(describeApiError(nextError))
      }
      if (
        nextError instanceof ApiError &&
        (nextError.code === 'password-login-disabled' ||
          nextError.code === 'bootstrap-admin-required')
      ) {
        void discover()
      }
    } finally {
      setBusy(false)
    }
  }

  async function handleTokenSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    setToken(tokenInput)
    try {
      const who = await api.get<{ source: string }>('/api/whoami')
      if (who.source !== 'daemon') throw new Error(t('auth.bootstrapTokenRequired'))
      router.history.replace(setupAdminHref(redirect))
    } catch (nextError) {
      clearToken()
      setError(describeApiError(nextError))
    } finally {
      setBusy(false)
    }
  }

  async function handleOidcLogin(slug: string) {
    setError(null)
    try {
      const result = await api.post<{ authorizeUrl: string }>(
        `/api/auth/oidc/${slug}/login/start`,
        {
          postLoginRedirect: safeInternalRedirect(redirect).split('#')[0] || '/agents',
        },
      )
      window.location.href = result.authorizeUrl
    } catch (nextError) {
      setError(describeApiError(nextError))
    }
  }

  const labels: Record<AuthMethod, string> = {
    password: t('auth.tabPassword', { defaultValue: 'Password' }),
    oidc: t('auth.tabOidc', { defaultValue: 'Identity provider' }),
    token: t('auth.tabToken', { defaultValue: 'Setup token' }),
  }
  const tabs: Array<TabDef<AuthMethod>> = methods.map((method) => ({
    key: method,
    label: <AuthMethodTabLabel method={method} label={labels[method]} />,
  }))

  const forms: Partial<Record<AuthMethod, React.ReactNode>> = {}
  if (
    bootstrapHandoff !== 'token' &&
    discovery.status === 'success' &&
    methods.includes('password')
  ) {
    forms.password = (
      <form onSubmit={handlePasswordSubmit} className="form-grid" data-testid="auth-password-form">
        <p className="auth-page__method-copy">{t('auth.passwordHint')}</p>
        <Field label={t('auth.username', { defaultValue: 'Username' })}>
          <TextInput
            inputRef={usernameRef}
            autoComplete="username"
            value={username}
            onChange={draftSetter(setUsername)}
          />
        </Field>
        <Field label={t('auth.password', { defaultValue: 'Password' })}>
          <TextInput
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={draftSetter(setPassword)}
          />
        </Field>
        {error !== null && <ErrorBanner error={error} />}
        <button
          className="btn btn--primary auth-page__submit"
          type="submit"
          disabled={busy || !username || !password}
        >
          {busy ? t('auth.verifying') : t('auth.signIn', { defaultValue: 'Sign in' })}
        </button>
      </form>
    )
  }
  if (bootstrapHandoff !== 'token' && discovery.status === 'success' && methods.includes('oidc')) {
    forms.oidc = (
      <div className="auth-page__providers" data-testid="auth-oidc-method">
        <p className="auth-page__provider-hint">
          {t('auth.oidcHint', { defaultValue: 'Sign in with your identity provider.' })}
        </p>
        {discovery.value.mode === 'ready' &&
          discovery.value.providers.map((provider) => (
            <button
              key={provider.slug}
              type="button"
              className="auth-page__provider-btn"
              aria-label={t('auth.loginWith', {
                name: provider.displayName,
                defaultValue: `Login with ${provider.displayName}`,
              })}
              onClick={() => void handleOidcLogin(provider.slug)}
            >
              <span className="auth-page__provider-mark" aria-hidden="true">
                <ProviderIcon />
              </span>
              <span className="auth-page__provider-copy">
                <strong className="auth-page__provider-name" title={provider.displayName}>
                  {provider.displayName}
                </strong>
                <span>{t('auth.providerButtonHint')}</span>
              </span>
              <span className="auth-page__provider-arrow" aria-hidden="true">
                <ArrowIcon />
              </span>
            </button>
          ))}
        {error !== null && <ErrorBanner error={error} />}
      </div>
    )
  }
  if (discovery.status === 'success' && methods.includes('token') && bootstrapHandoff !== 'token') {
    forms.token = (
      <form onSubmit={handleTokenSubmit} className="form-grid" data-testid="auth-token-form">
        <NoticeBanner tone="info" size="compact">
          {t('auth.bootstrapTokenHint', {
            defaultValue:
              'Use the setup token printed by the daemon. It can only create the first administrator and will then expire permanently.',
          })}
        </NoticeBanner>
        <Field label={t('auth.token', { defaultValue: 'Setup token' })}>
          <TextInput
            inputRef={tokenRef}
            type="password"
            value={tokenInput}
            onChange={draftSetter(setTokenInput)}
            autoComplete="off"
          />
        </Field>
        {error !== null && <ErrorBanner error={error} />}
        <button
          className="btn btn--primary auth-page__submit"
          type="submit"
          disabled={busy || !tokenInput}
        >
          {busy ? t('auth.verifying') : t('auth.continueSetup', { defaultValue: 'Continue setup' })}
        </button>
      </form>
    )
  }

  const form = forms[active] ?? null
  const panels = methods.flatMap((method) => {
    const content = forms[method]
    // Keep every ARIA panel node present for its controlling tab, but only
    // mount the active credential form. Hidden password inputs must not remain
    // live in the DOM when OIDC is selected (and vice versa).
    return content === undefined
      ? []
      : [{ key: method, content: method === active ? content : null }]
  })

  const bootstrap = discovery.status === 'success' && discovery.value.mode === 'bootstrap'

  return (
    <AuthExperienceShell>
      <div className="auth-page">
        <header className="auth-page__heading">
          <span className="auth-page__eyebrow">{t('auth.secureAccess')}</span>
          <h1>{bootstrap ? t('auth.bootstrapLoginTitle') : t('auth.title')}</h1>
          <p className="auth-page__hint">
            {bootstrap ? t('auth.bootstrapLoginSubtitle') : t('auth.subtitle')}
          </p>
        </header>
        {setup === 'complete' && (
          <NoticeBanner tone="success" size="compact">
            {t('auth.setupComplete', {
              defaultValue: 'Administrator created. Sign in with the account you just created.',
            })}
          </NoticeBanner>
        )}
        {discovery.status === 'loading' && (
          <LoadingState
            size="compact"
            label={t('auth.oidcDiscoveryLoading')}
            data-testid="auth-discovery-loading"
          />
        )}
        {discovery.status === 'success' && bootstrapHandoff === 'token' && (
          <LoadingState
            size="compact"
            label={t('auth.verifying')}
            data-testid="auth-bootstrap-handoff"
          />
        )}
        {discovery.status === 'error' && (
          <ErrorBanner
            error={discovery.error}
            message={t('auth.oidcDiscoveryError')}
            onRetry={() => void discover()}
          />
        )}
        {discovery.status === 'success' && methods.length === 0 && (
          <ErrorBanner
            error={t('auth.noLoginMethod', { defaultValue: 'No login method is available.' })}
          />
        )}
        {discovery.status === 'success' && bootstrapHandoff !== 'token' && methods.length > 1 && (
          <div className="auth-page__method-picker">
            <span className="auth-page__method-label">{t('auth.methodLabel')}</span>
            <TabBar<AuthMethod>
              tabs={tabs}
              active={active}
              onSelect={selectMethod}
              variant="segment"
              ariaLabel={t('auth.methodLabel')}
              idPrefix="auth-method"
            />
          </div>
        )}
        {panels.length > 1 ? (
          <TabPanels<AuthMethod> active={active} panels={panels} idPrefix="auth-method" />
        ) : (
          form
        )}
      </div>
    </AuthExperienceShell>
  )
}

function AuthMethodTabLabel({ method, label }: { method: AuthMethod; label: string }) {
  return (
    <span className="auth-page__method-tab-label">
      <span className="auth-page__method-tab-icon" aria-hidden="true">
        <AuthMethodIcon method={method} />
      </span>
      <span className="auth-page__method-tab-text" title={label}>
        {label}
      </span>
    </span>
  )
}

function AuthMethodIcon({ method }: { method: AuthMethod }) {
  if (method === 'oidc') {
    return (
      <svg viewBox="0 0 24 24">
        <circle cx="7" cy="12" r="3" />
        <circle cx="17" cy="7" r="3" />
        <circle cx="17" cy="17" r="3" />
        <path d="m9.7 10.6 4.6-2.2M9.7 13.4l4.6 2.2" />
      </svg>
    )
  }
  if (method === 'token') {
    return (
      <svg viewBox="0 0 24 24">
        <circle cx="8" cy="12" r="4" />
        <path d="M12 12h8m-3 0v3m-3-3v2" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24">
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
    </svg>
  )
}

function ProviderIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M4 20V8l8-4 8 4v12" />
      <path d="M8 11h2m4 0h2M8 15h2m4 0h2M10 20v-2h4v2" />
    </svg>
  )
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M5 12h14m-5-5 5 5-5 5" />
    </svg>
  )
}
