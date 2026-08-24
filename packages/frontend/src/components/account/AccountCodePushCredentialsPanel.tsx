// RFC-321 — session-only self-service Git push credentials.
// Plaintext is write-only: this panel always renders an empty password field
// and reads back only the server-provided last-four hint.

import type {
  CodeHostProvider,
  CodeHostTestResult,
  OwnCodeHostPushCredentialList,
  OwnCodeHostPushCredentialSummary,
} from '@agent-workflow/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '@/api/client'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { RelativeTime } from '@/components/RelativeTime'
import { SettingsCard } from '@/components/settings/SettingsCard'
import { StatusChip } from '@/components/StatusChip'
import { AccountGitIdentityCard } from '@/components/account/AccountGitIdentityCard'
import { type MeResponse, useAuthSessionRevision } from '@/hooks/useActor'

export const ACCOUNT_CODE_PUSH_CREDENTIALS_QUERY_KEY = [
  'account',
  'code-host-push-credentials',
] as const

export function AccountCodePushCredentialsPanel({ me }: { me: MeResponse }) {
  const { t } = useTranslation()
  const focusFallbackRef = useRef<HTMLHeadingElement>(null)
  const authSessionRevision = useAuthSessionRevision()
  const queryKey = [
    ...ACCOUNT_CODE_PUSH_CREDENTIALS_QUERY_KEY,
    me.user.id,
    authSessionRevision,
  ] as const
  const credentials = useQuery<OwnCodeHostPushCredentialList>({
    queryKey,
    queryFn: async () =>
      api.get<OwnCodeHostPushCredentialList>('/api/account/code-host-push-credentials'),
  })

  return (
    <section className="account-section-panel" aria-labelledby="account-section-title-code-push">
      <header className="account-section-panel__header">
        <h2 id="account-section-title-code-push" ref={focusFallbackRef} tabIndex={-1}>
          {t('account.sections.codePush')}
        </h2>
        <p>{t('account.sectionDescriptions.codePush')}</p>
      </header>
      <AccountGitIdentityCard me={me} />
      <NoticeBanner tone="info" title={t('account.codePush.priorityTitle')} size="compact">
        {t('account.codePush.priorityDescription')}
      </NoticeBanner>
      {credentials.isLoading ? (
        <LoadingState label={t('account.codePush.loading')} />
      ) : credentials.isError ? (
        <ErrorBanner error={credentials.error} />
      ) : (credentials.data?.items.length ?? 0) === 0 ? (
        <EmptyState
          title={t('account.codePush.noConnections')}
          description={t('account.codePush.noConnectionsDescription')}
          size="compact"
        />
      ) : (
        <div className="form-grid" data-testid="account-code-push-credentials">
          {credentials.data!.items.map((row) => (
            <CredentialCard key={row.provider} row={row} queryKey={queryKey} />
          ))}
        </div>
      )}
    </section>
  )
}

function CredentialCard({
  row,
  queryKey,
}: {
  row: OwnCodeHostPushCredentialSummary
  queryKey: readonly unknown[]
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [token, setToken] = useState('')
  const [error, setError] = useState<unknown | null>(null)
  const [saved, setSaved] = useState(false)
  const [testResult, setTestResult] = useState<CodeHostTestResult | null>(null)
  const [removeOpen, setRemoveOpen] = useState(false)
  const removeTriggerRef = useRef<HTMLButtonElement | null>(null)

  const refresh = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey })
  }
  const save = useMutation({
    mutationFn: async (plainToken: string) =>
      api.put<OwnCodeHostPushCredentialSummary>(
        `/api/account/code-host-push-credentials/${row.provider}`,
        {
          token: plainToken,
          connectionGeneration: row.connectionGeneration,
          endpointBindingDigest: row.endpointBindingDigest,
        },
      ),
    onSuccess: async () => {
      setToken('')
      setError(null)
      setSaved(true)
      await refresh()
    },
    onError: (nextError) => {
      setSaved(false)
      setError(nextError)
    },
  })
  const test = useMutation({
    mutationFn: async () =>
      api.post<CodeHostTestResult>(`/api/account/code-host-push-credentials/${row.provider}/test`, {
        ...(token.length >= 8 ? { token } : {}),
        connectionGeneration: row.connectionGeneration,
        endpointBindingDigest: row.endpointBindingDigest,
      }),
    onSuccess: (result) => {
      setError(null)
      setSaved(false)
      setTestResult(result)
    },
    onError: (nextError) => {
      setTestResult(null)
      setError(nextError)
    },
  })
  const remove = useMutation({
    mutationFn: async (provider: CodeHostProvider) =>
      api.delete<{ removed: boolean }>(`/api/account/code-host-push-credentials/${provider}`),
    onSuccess: async () => {
      setError(null)
      setSaved(false)
      setTestResult(null)
      await refresh()
    },
    onError: (nextError) => {
      setRemoveOpen(false)
      setError(nextError)
    },
  })
  const busy = save.isPending || test.isPending || remove.isPending
  const canTest = token.length >= 8 || (token.length === 0 && row.configured)

  return (
    <SettingsCard
      title={t(`codeHostProvider.${row.provider}`)}
      hint={row.displayBaseUrl}
      actions={
        <StatusChip
          kind={row.stale ? 'danger' : row.configured ? 'success' : 'neutral'}
          size="sm"
          data-testid={`account-code-push-status-${row.provider}`}
        >
          {row.stale
            ? t('account.codePush.stale')
            : row.configured
              ? t('account.codePush.personalActive')
              : t('account.codePush.platformFallback')}
        </StatusChip>
      }
      data-testid={`account-code-push-card-${row.provider}`}
    >
      <form
        className="form-grid account-code-push-form"
        onSubmit={(event) => {
          event.preventDefault()
          save.mutate(token)
        }}
      >
        {error !== null ? <ErrorBanner error={error} /> : null}
        {saved ? (
          <NoticeBanner tone="success" size="compact">
            {t('account.codePush.saved')}
          </NoticeBanner>
        ) : null}
        {testResult !== null ? (
          <NoticeBanner
            tone={testResult.ok ? 'success' : 'error'}
            size="compact"
            testid={`account-code-push-test-result-${row.provider}`}
          >
            {testResult.ok
              ? t('account.codePush.testOk', { login: testResult.login ?? '' })
              : t('account.codePush.testFailed', {
                  reason: t(`codeHostSettings.testCode_${testResult.code ?? 'bad-response'}`),
                })}
          </NoticeBanner>
        ) : null}
        <p className="inspector-hint">
          {row.configured
            ? t('account.codePush.stored', { hint: row.tokenHint ?? '' })
            : t('account.codePush.fallbackDescription')}
        </p>
        <p className="inspector-hint">{t(`account.codePush.scope_${row.provider}`)}</p>
        <p className="inspector-hint">{t('account.codePush.boundaryDescription')}</p>
        {row.updatedAt !== null ? (
          <p className="inspector-hint">
            {t('account.codePush.updated')} <RelativeTime ts={row.updatedAt} />
          </p>
        ) : null}
        <Field
          label={t('account.codePush.tokenLabel')}
          hint={
            row.configured ? t('account.codePush.replaceHint') : t('account.codePush.tokenHint')
          }
        >
          <TextInput
            value={token}
            onChange={(next) => {
              setSaved(false)
              setTestResult(null)
              setToken(next)
            }}
            type="password"
            autoComplete="new-password"
            minLength={8}
            maxLength={4096}
            disabled={busy}
            data-testid={`account-code-push-token-${row.provider}`}
          />
        </Field>
        <div className="page__actions">
          <button
            type="submit"
            className="btn btn--sm btn--primary"
            disabled={busy || token.length < 8}
            data-testid={`account-code-push-save-${row.provider}`}
          >
            {row.configured ? t('account.codePush.replace') : t('account.codePush.save')}
          </button>
          <button
            type="button"
            className="btn btn--sm"
            disabled={busy || !canTest}
            data-testid={`account-code-push-test-${row.provider}`}
            onClick={() => test.mutate()}
          >
            {test.isPending ? t('account.codePush.testing') : t('account.codePush.test')}
          </button>
          {row.configured ? (
            <button
              ref={removeTriggerRef}
              type="button"
              className="btn btn--sm btn--danger"
              disabled={busy}
              data-testid={`account-code-push-remove-${row.provider}`}
              onClick={() => setRemoveOpen(true)}
            >
              {t('account.codePush.remove')}
            </button>
          ) : null}
        </div>
      </form>
      <ConfirmDialog
        open={removeOpen}
        title={t('account.codePush.removeTitle')}
        description={t('account.codePush.removeDescription')}
        confirmLabel={t('account.codePush.remove')}
        tone="danger"
        triggerRef={removeTriggerRef}
        onClose={() => setRemoveOpen(false)}
        onConfirm={async () => {
          await remove.mutateAsync(row.provider)
        }}
      />
    </SettingsCard>
  )
}
