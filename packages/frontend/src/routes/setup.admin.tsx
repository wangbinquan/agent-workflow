// RFC-221 — bare-shell, mandatory first-human-admin handoff.

import { useMutation, useQuery } from '@tanstack/react-query'
import { createRoute, useRouter } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, ApiError } from '@/api/client'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { AuthExperienceShell } from '@/components/auth/AuthExperienceShell'
import { clearToken } from '@/stores/auth'
import { safeInternalRedirect } from './auth'
import { Route as RootRoute } from './__root'

interface SetupSearch {
  redirect?: string
}

export function authAfterSetupHref(redirect: string | undefined): string {
  return `/auth?setup=complete&redirect=${encodeURIComponent(safeInternalRedirect(redirect))}`
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/setup/admin',
  validateSearch: (raw: Record<string, unknown>): SetupSearch =>
    typeof raw.redirect === 'string' ? { redirect: raw.redirect } : {},
  component: SetupAdminPage,
})

function SetupAdminPage() {
  const { t } = useTranslation()
  const router = useRouter()
  const { redirect } = Route.useSearch()
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const usernameRef = useRef<HTMLInputElement>(null)
  const status = useQuery<{ required: boolean }>({
    queryKey: ['auth', 'bootstrap-status'],
    queryFn: ({ signal }) => api.get('/api/auth/bootstrap/status', undefined, signal),
    retry: false,
  })

  useEffect(() => {
    if (status.data?.required !== false) return
    clearToken()
    router.history.replace('/auth')
  }, [router.history, status.data?.required])

  useEffect(() => {
    if (status.data?.required !== true) return
    queueMicrotask(() => usernameRef.current?.focus())
  }, [status.data?.required])

  const passwordMismatch = confirm.length > 0 && password !== confirm
  const create = useMutation({
    mutationFn: () =>
      api.post('/api/auth/bootstrap/admin', {
        username,
        displayName,
        ...(email.trim() !== '' ? { email: email.trim() } : {}),
        password,
      }),
    onSuccess: () => {
      clearToken()
      router.history.replace(authAfterSetupHref(redirect))
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'bootstrap-already-complete') {
        clearToken()
        router.history.replace(authAfterSetupHref(redirect))
      }
    },
  })

  if (status.isLoading) {
    return (
      <AuthExperienceShell wide>
        <div className="bootstrap-admin bootstrap-admin--state">
          <LoadingState size="compact" />
        </div>
      </AuthExperienceShell>
    )
  }
  if (status.error !== null) {
    return (
      <AuthExperienceShell wide>
        <div className="bootstrap-admin bootstrap-admin--state">
          <ErrorBanner error={status.error} onRetry={() => void status.refetch()} />
        </div>
      </AuthExperienceShell>
    )
  }

  return (
    <AuthExperienceShell wide>
      <div className="bootstrap-admin">
        <div className="bootstrap-admin__card">
          <div className="bootstrap-admin__heading">
            <span className="bootstrap-admin__eyebrow">
              {t('auth.bootstrapStep', { defaultValue: 'Secure first-time setup' })}
            </span>
            <h1>{t('auth.bootstrapTitle', { defaultValue: 'Create the first administrator' })}</h1>
            <p>
              {t('auth.bootstrapDescription', {
                defaultValue:
                  'This account becomes the first administrator. When it is created, the setup token is retired permanently.',
              })}
            </p>
          </div>
          <ol className="bootstrap-admin__steps" aria-label={t('auth.bootstrapStepsLabel')}>
            <li className="bootstrap-admin__step bootstrap-admin__step--active">
              <span>1</span>
              {t('auth.bootstrapStepAccount', { defaultValue: 'Set account' })}
            </li>
            <li className="bootstrap-admin__step">
              <span>2</span>
              {t('auth.bootstrapStepRetire', { defaultValue: 'Retire setup token' })}
            </li>
            <li className="bootstrap-admin__step">
              <span>3</span>
              {t('auth.bootstrapStepLogin', { defaultValue: 'Sign in' })}
            </li>
          </ol>
          <NoticeBanner tone="warning" size="compact">
            {t('auth.bootstrapOneWay', {
              defaultValue:
                'This handoff is one-way. Save the administrator password before continuing.',
            })}
          </NoticeBanner>
          <form
            className="form-grid bootstrap-admin__form"
            onSubmit={(event) => {
              event.preventDefault()
              if (!passwordMismatch) create.mutate()
            }}
          >
            <div className="bootstrap-admin__row">
              <Field label={t('auth.username', { defaultValue: 'Username' })} required>
                <TextInput
                  inputRef={usernameRef}
                  value={username}
                  onChange={setUsername}
                  autoComplete="username"
                  pattern="[a-z0-9][a-z0-9_-]{0,63}"
                  required
                />
              </Field>
              <Field label={t('account.displayName', { defaultValue: 'Display name' })} required>
                <TextInput value={displayName} onChange={setDisplayName} required maxLength={128} />
              </Field>
            </div>
            <Field label={t('account.email', { defaultValue: 'Email (optional)' })}>
              <TextInput type="email" value={email} onChange={setEmail} autoComplete="email" />
            </Field>
            <div className="bootstrap-admin__row">
              <Field label={t('auth.password', { defaultValue: 'Password' })} required>
                <TextInput
                  type="password"
                  value={password}
                  onChange={setPassword}
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </Field>
              <Field
                label={t('auth.confirmPassword', { defaultValue: 'Confirm password' })}
                required
                error={passwordMismatch ? t('auth.passwordMismatch') : undefined}
              >
                <TextInput
                  type="password"
                  value={confirm}
                  onChange={setConfirm}
                  autoComplete="new-password"
                  minLength={8}
                  required
                  aria-invalid={passwordMismatch || undefined}
                />
              </Field>
            </div>
            {create.error !== null && <ErrorBanner error={create.error} />}
            <button
              type="submit"
              className="btn btn--primary bootstrap-admin__submit"
              disabled={
                create.isPending ||
                !username ||
                !displayName ||
                password.length < 8 ||
                !confirm ||
                passwordMismatch
              }
              aria-busy={create.isPending || undefined}
            >
              {create.isPending
                ? t('auth.creatingAdmin', { defaultValue: 'Creating administrator…' })
                : t('auth.completeHandoff', { defaultValue: 'Complete handoff' })}
            </button>
          </form>
        </div>
      </div>
    </AuthExperienceShell>
  )
}
