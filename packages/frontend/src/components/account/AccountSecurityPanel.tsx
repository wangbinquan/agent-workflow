import type { SessionPublic } from '@agent-workflow/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '@/api/client'
import { Card } from '@/components/Card'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextInput } from '@/components/Form'
import { NoticeBanner } from '@/components/NoticeBanner'
import { QueryState } from '@/components/QueryState'
import { RelativeTime } from '@/components/RelativeTime'
import { ACTOR_QUERY_KEY, type MeResponse } from '@/hooks/useActor'
import { isOidcManaged } from '@/lib/account-user-presentation'
import { setToken } from '@/stores/auth'

interface ChangePasswordResponse {
  ok: true
  sessionToken?: string
}

export function AccountSecurityPanel({ me }: { me: MeResponse }) {
  const { t } = useTranslation()
  const focusFallbackRef = useRef<HTMLHeadingElement>(null)
  return (
    <section className="account-section-panel" aria-labelledby="account-section-title-security">
      <header className="account-section-panel__header">
        <h2 id="account-section-title-security" ref={focusFallbackRef} tabIndex={-1}>
          {t('account.sections.security')}
        </h2>
        <p>{t('account.sectionDescriptions.security')}</p>
      </header>
      {isOidcManaged(me.linkedIdentities) ? (
        <Card title={t('account.password')} className="account-security-card">
          <NoticeBanner tone="info">
            <strong>{t('account.oidcPasswordTitle')}</strong>
            <p>{t('account.oidcPasswordDescription')}</p>
          </NoticeBanner>
        </Card>
      ) : (
        <PasswordCard me={me} />
      )}
      <SessionsCard restoreFocusFallbackRef={focusFallbackRef} />
    </section>
  )
}

function PasswordCard({ me }: { me: MeResponse }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [changed, setChanged] = useState(false)
  const changePassword = useMutation({
    mutationFn: () =>
      api.post<ChangePasswordResponse>('/api/auth/change-password', {
        oldPassword,
        newPassword,
      }),
    onSuccess: async (result) => {
      if (result.sessionToken !== undefined) {
        setToken(result.sessionToken)
        qc.setQueryData([...ACTOR_QUERY_KEY, result.sessionToken], me)
      }
      setOldPassword('')
      setNewPassword('')
      setChanged(true)
      await Promise.all([
        qc.invalidateQueries({ queryKey: ACTOR_QUERY_KEY }),
        qc.invalidateQueries({ queryKey: ['account', 'sessions'] }),
      ])
    },
  })
  return (
    <Card
      title={t('account.password')}
      header={<p className="account-card-description">{t('account.passwordDesc')}</p>}
      className="account-security-card"
    >
      <form
        className="form-grid account-password-form"
        onSubmit={(event) => {
          event.preventDefault()
          setChanged(false)
          changePassword.mutate()
        }}
      >
        <Field label={t('account.oldPassword')} required>
          <TextInput
            type="password"
            autoComplete="current-password"
            value={oldPassword}
            onChange={setOldPassword}
            required
          />
        </Field>
        <Field label={t('account.newPassword')} required>
          <TextInput
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={setNewPassword}
            minLength={8}
            required
          />
        </Field>
        {changePassword.error !== null && <ErrorBanner error={changePassword.error} />}
        {changed && <NoticeBanner tone="success">{t('account.passwordChanged')}</NoticeBanner>}
        <div className="account-form-actions">
          <button
            type="submit"
            className="btn btn--primary"
            disabled={
              changePassword.isPending || oldPassword.length === 0 || newPassword.length < 8
            }
            aria-busy={changePassword.isPending || undefined}
          >
            {changePassword.isPending ? t('common.saving') : t('account.update')}
          </button>
        </div>
      </form>
    </Card>
  )
}

function SessionsCard({
  restoreFocusFallbackRef,
}: {
  restoreFocusFallbackRef: RefObject<HTMLElement | null>
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [revokeId, setRevokeId] = useState<string | null>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const sessions = useQuery<SessionPublic[]>({
    queryKey: ['account', 'sessions'],
    queryFn: ({ signal }) => api.get('/api/auth/sessions', undefined, signal),
  })
  const sorted = [...(sessions.data ?? [])].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
  return (
    <Card
      as="section"
      title={t('account.sessions')}
      header={<p className="account-card-description">{t('account.sessionsDesc')}</p>}
      className="account-security-card"
    >
      <QueryState
        query={sessions}
        data={sorted}
        keepDataOnError
        loadingSize="compact"
        empty={
          <EmptyState
            title={t('account.noSessions')}
            description={t('account.noSessionsDescription')}
            size="compact"
          />
        }
      >
        {(rows) => (
          <ul className="account-session-list" aria-label={t('account.sessions')}>
            {rows.map((session) => (
              <li key={session.id} className="account-session-list__item">
                <div className="account-session-list__body">
                  <strong>{session.userAgent ?? t('account.unknownClient')}</strong>
                  <div className="account-session-list__meta">
                    <span>
                      {t('account.lastActive')} <RelativeTime ts={session.lastUsedAt} />
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {t('account.expires')} <RelativeTime ts={session.expiresAt} />
                    </span>
                  </div>
                  <code>{session.id.slice(0, 10)}…</code>
                </div>
                <button
                  type="button"
                  className="btn btn--danger btn--sm"
                  onClick={(event) => {
                    triggerRef.current = event.currentTarget
                    setRevokeId(session.id)
                  }}
                >
                  {t('account.revoke')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      <ConfirmDialog
        open={revokeId !== null}
        title={t('account.revokeSessionTitle')}
        description={t('account.revokeSessionDescription')}
        confirmLabel={t('account.revoke')}
        tone="danger"
        triggerRef={triggerRef}
        restoreFocusFallbackRef={restoreFocusFallbackRef}
        onClose={() => setRevokeId(null)}
        onConfirm={async () => {
          if (revokeId === null) return
          await api.post(`/api/auth/sessions/${revokeId}/revoke`, {})
          await Promise.all([
            qc.invalidateQueries({ queryKey: ['account', 'sessions'] }),
            qc.invalidateQueries({ queryKey: ACTOR_QUERY_KEY }),
          ])
        }}
      />
    </Card>
  )
}
