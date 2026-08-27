// RFC-221 — bare-shell, mandatory first-human-admin handoff.

import { CreateBootstrapAdminBodySchema } from '@agent-workflow/shared'
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

type BootstrapAdminField = 'username' | 'displayName' | 'email' | 'password' | 'confirm'
type BootstrapAdminFieldError =
  | 'required'
  | 'username'
  | 'displayName'
  | 'email'
  | 'password'
  | 'passwordMismatch'

interface BootstrapAdminDraft {
  username: string
  displayName: string
  email: string
  password: string
  confirm: string
}

type BootstrapAdminFieldErrors = Partial<Record<BootstrapAdminField, BootstrapAdminFieldError>>

const BOOTSTRAP_ADMIN_FIELD_ORDER: readonly BootstrapAdminField[] = [
  'username',
  'displayName',
  'email',
  'password',
  'confirm',
]

export function validateBootstrapAdminDraft(draft: BootstrapAdminDraft): BootstrapAdminFieldErrors {
  const errors: BootstrapAdminFieldErrors = {}
  if (draft.username.length === 0) errors.username = 'required'
  else if (!CreateBootstrapAdminBodySchema.shape.username.safeParse(draft.username).success) {
    errors.username = 'username'
  }

  if (draft.displayName.length === 0) errors.displayName = 'required'
  else if (!CreateBootstrapAdminBodySchema.shape.displayName.safeParse(draft.displayName).success) {
    errors.displayName = 'displayName'
  }

  const normalizedEmail = draft.email.trim()
  if (
    normalizedEmail !== '' &&
    !CreateBootstrapAdminBodySchema.shape.email.safeParse(normalizedEmail).success
  ) {
    errors.email = 'email'
  }

  if (draft.password.length === 0) errors.password = 'required'
  else if (!CreateBootstrapAdminBodySchema.shape.password.safeParse(draft.password).success) {
    errors.password = 'password'
  }

  if (draft.confirm.length === 0) errors.confirm = 'required'
  else if (draft.password !== draft.confirm) errors.confirm = 'passwordMismatch'
  return errors
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
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const usernameRef = useRef<HTMLInputElement>(null)
  const displayNameRef = useRef<HTMLInputElement>(null)
  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLInputElement>(null)
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

  const usernameHint = t('auth.bootstrapUsernameHint', {
    defaultValue:
      'Use 1–64 lowercase letters or numbers; after the first character, - and _ are allowed.',
  })
  const displayNameHint = t('auth.bootstrapDisplayNameHint', {
    defaultValue: 'Use 1–128 characters.',
  })
  const emailHint = t('auth.bootstrapEmailHint', {
    defaultValue: 'Optional. Enter a valid email address with at most 254 characters.',
  })
  const passwordLengthMessage = t('auth.bootstrapPasswordHint', {
    defaultValue: 'Use 8–256 characters.',
  })
  const confirmHint = t('auth.bootstrapConfirmHint', {
    defaultValue: 'Enter the same password again.',
  })
  const fieldErrors = validateBootstrapAdminDraft({
    username,
    displayName,
    email,
    password,
    confirm,
  })
  const fieldValues: Record<BootstrapAdminField, string> = {
    username,
    displayName,
    email,
    password,
    confirm,
  }
  const validationMessages: Record<BootstrapAdminFieldError, string> = {
    required: t('auth.bootstrapFieldRequired', { defaultValue: 'This field is required.' }),
    username: usernameHint,
    displayName: displayNameHint,
    email: emailHint,
    password: passwordLengthMessage,
    passwordMismatch: t('auth.passwordMismatch'),
  }
  const visibleError = (field: BootstrapAdminField): string | undefined => {
    const code = fieldErrors[field]
    if (code === undefined || (!submitAttempted && fieldValues[field].length === 0))
      return undefined
    return validationMessages[code]
  }
  const usernameError = visibleError('username')
  const displayNameError = visibleError('displayName')
  const emailError = visibleError('email')
  const passwordError = visibleError('password')
  const confirmError = visibleError('confirm')
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
            noValidate
            onSubmit={(event) => {
              event.preventDefault()
              setSubmitAttempted(true)
              const firstInvalid = BOOTSTRAP_ADMIN_FIELD_ORDER.find(
                (field) => fieldErrors[field] !== undefined,
              )
              if (firstInvalid !== undefined) {
                const refs = {
                  username: usernameRef,
                  displayName: displayNameRef,
                  email: emailRef,
                  password: passwordRef,
                  confirm: confirmRef,
                }
                refs[firstInvalid].current?.focus()
                return
              }
              create.mutate()
            }}
          >
            <div className="bootstrap-admin__row">
              <Field
                label={t('auth.username', { defaultValue: 'Username' })}
                required
                hint={usernameHint}
                error={usernameError}
                errorId="bootstrap-admin-username-error"
              >
                <TextInput
                  inputRef={usernameRef}
                  value={username}
                  onChange={setUsername}
                  autoComplete="username"
                  pattern="[a-z0-9][a-z0-9_-]{0,63}"
                  maxLength={64}
                  required
                  aria-invalid={usernameError === undefined ? undefined : true}
                  aria-errormessage={
                    usernameError === undefined ? undefined : 'bootstrap-admin-username-error'
                  }
                />
              </Field>
              <Field
                label={t('account.displayName', { defaultValue: 'Display name' })}
                required
                hint={displayNameHint}
                error={displayNameError}
                errorId="bootstrap-admin-display-name-error"
              >
                <TextInput
                  inputRef={displayNameRef}
                  value={displayName}
                  onChange={setDisplayName}
                  required
                  maxLength={128}
                  aria-invalid={displayNameError === undefined ? undefined : true}
                  aria-errormessage={
                    displayNameError === undefined
                      ? undefined
                      : 'bootstrap-admin-display-name-error'
                  }
                />
              </Field>
            </div>
            <Field
              label={t('account.email', { defaultValue: 'Email (optional)' })}
              hint={emailHint}
              error={emailError}
              errorId="bootstrap-admin-email-error"
            >
              <TextInput
                inputRef={emailRef}
                type="email"
                value={email}
                onChange={setEmail}
                autoComplete="email"
                maxLength={254}
                aria-invalid={emailError === undefined ? undefined : true}
                aria-errormessage={
                  emailError === undefined ? undefined : 'bootstrap-admin-email-error'
                }
              />
            </Field>
            <div className="bootstrap-admin__row">
              <Field
                label={t('auth.password', { defaultValue: 'Password' })}
                required
                hint={passwordLengthMessage}
                error={passwordError}
                errorId="bootstrap-admin-password-error"
              >
                <TextInput
                  inputRef={passwordRef}
                  type="password"
                  value={password}
                  onChange={setPassword}
                  autoComplete="new-password"
                  minLength={8}
                  maxLength={256}
                  required
                  aria-invalid={passwordError === undefined ? undefined : true}
                  aria-errormessage={
                    passwordError === undefined ? undefined : 'bootstrap-admin-password-error'
                  }
                />
              </Field>
              <Field
                label={t('auth.confirmPassword', { defaultValue: 'Confirm password' })}
                required
                hint={confirmHint}
                error={confirmError}
                errorId="bootstrap-admin-confirm-error"
              >
                <TextInput
                  inputRef={confirmRef}
                  type="password"
                  value={confirm}
                  onChange={setConfirm}
                  autoComplete="new-password"
                  minLength={8}
                  maxLength={256}
                  required
                  aria-invalid={confirmError === undefined ? undefined : true}
                  aria-errormessage={
                    confirmError === undefined ? undefined : 'bootstrap-admin-confirm-error'
                  }
                />
              </Field>
            </div>
            {create.error !== null && <ErrorBanner error={create.error} />}
            <button
              type="submit"
              className="btn btn--primary bootstrap-admin__submit"
              disabled={create.isPending}
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
