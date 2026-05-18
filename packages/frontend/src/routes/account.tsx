// RFC-036 — user self-service page (/account). Available to admin + user
// (account:self permission). Lets the actor change their password, view
// active sessions, manage PATs, and review linked identities.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, ApiError } from '@/api/client'
import { ACTOR_QUERY_KEY, useActor, type MeResponse } from '@/hooks/useActor'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/account',
  component: AccountPage,
})

function AccountPage() {
  const { t } = useTranslation()
  const { data, isLoading } = useActor()
  if (isLoading) return <div className="page account-page">Loading…</div>
  if (!data) {
    return (
      <div className="page account-page">
        <h1>{t('account.title', { defaultValue: 'My account' })}</h1>
        <p>Please sign in.</p>
      </div>
    )
  }
  return (
    <div className="page account-page">
      <header className="page__header">
        <h1>{t('account.title', { defaultValue: 'My account' })}</h1>
        <p className="page__hint">
          {t('account.subtitle', { defaultValue: 'Manage your password, sessions, and tokens.' })}
        </p>
      </header>
      <div className="account-page__grid">
        <ProfileSection me={data} />
        <PasswordSection />
        <PatSection />
        <IdentitiesSection />
        <SessionsSection />
      </div>
    </div>
  )
}

function SectionShell(props: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="account-card">
      <header className="account-card__header">
        <h2 className="account-card__title">{props.title}</h2>
        {props.description && <p className="account-card__description">{props.description}</p>}
      </header>
      <div className="account-card__body">{props.children}</div>
    </section>
  )
}

function ProfileSection({ me }: { me: MeResponse }) {
  const { t } = useTranslation()
  // Plain label / value rows. Role + Status get a small colored dot so they
  // can be skimmed at a glance, but stay borderless / unboxed.
  const rows: Array<[string, React.ReactNode]> = [
    [t('account.username', { defaultValue: 'Username' }), me.user.username],
    [t('account.displayName', { defaultValue: 'Display name' }), me.user.displayName],
    [
      t('account.role', { defaultValue: 'Role' }),
      <DotValue key="r" kind={`role-${me.user.role}`} text={me.user.role} />,
    ],
    [
      t('account.status', { defaultValue: 'Status' }),
      <DotValue key="s" kind={`status-${me.user.status}`} text={me.user.status} />,
    ],
    [t('account.source', { defaultValue: 'Authenticated via' }), me.source],
  ]
  return (
    <SectionShell title={t('account.profile', { defaultValue: 'Profile' })}>
      <dl className="account-defs">
        {rows.map(([k, v], i) => (
          <div key={i} className="account-defs__row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </SectionShell>
  )
}

function DotValue({ kind, text }: { kind: string; text: string }) {
  return (
    <span className="account-dot-value">
      <span className={`account-dot account-dot--${kind}`} aria-hidden />
      <span className="account-dot-value__text">{text}</span>
    </span>
  )
}

function PasswordSection() {
  const { t } = useTranslation()
  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const m = useMutation({
    mutationFn: () =>
      api.post('/api/auth/change-password', { oldPassword: oldPw, newPassword: newPw }),
    onSuccess: () => {
      setOldPw('')
      setNewPw('')
      setMsg({
        kind: 'ok',
        text: t('account.passwordChanged', { defaultValue: 'Password changed.' }),
      })
    },
    onError: (e: unknown) =>
      setMsg({
        kind: 'err',
        text: e instanceof ApiError ? e.message : ((e as Error).message ?? 'failed'),
      }),
  })
  return (
    <SectionShell
      title={t('account.password', { defaultValue: 'Change password' })}
      description={t('account.passwordDesc', {
        defaultValue:
          'Set a new password. Your other sessions will be revoked; this window will get a fresh session token automatically.',
      })}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          m.mutate()
        }}
        className="account-form"
      >
        <label className="account-form__field">
          <span className="account-form__label">
            {t('account.oldPassword', { defaultValue: 'Current password' })}
          </span>
          <input
            type="password"
            autoComplete="current-password"
            value={oldPw}
            onChange={(e) => setOldPw(e.target.value)}
            required
          />
        </label>
        <label className="account-form__field">
          <span className="account-form__label">
            {t('account.newPassword', { defaultValue: 'New password' })}
          </span>
          <input
            type="password"
            autoComplete="new-password"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            required
            minLength={8}
          />
        </label>
        <div className="account-form__actions">
          <button type="submit" className="btn btn--primary" disabled={m.isPending}>
            {m.isPending ? '…' : t('account.update', { defaultValue: 'Update password' })}
          </button>
          {msg && (
            <span className={msg.kind === 'ok' ? 'account-form__ok' : 'account-form__error'}>
              {msg.text}
            </span>
          )}
        </div>
      </form>
    </SectionShell>
  )
}

function PatSection() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [shown, setShown] = useState<string | null>(null)
  const { data } = useQuery<
    Array<{
      id: string
      name: string
      scopes: string[]
      createdAt: number
      lastUsedAt: number | null
      revokedAt: number | null
    }>
  >({
    queryKey: ['pats'],
    queryFn: () => api.get('/api/auth/pats'),
  })
  const create = useMutation({
    mutationFn: () =>
      api.post<{ token: string }>('/api/auth/pats', {
        name,
        scopes: ['tasks:launch', 'tasks:read:own', 'agents:read'],
      }),
    onSuccess: (r) => {
      setShown(r.token)
      setName('')
      void qc.invalidateQueries({ queryKey: ['pats'] })
    },
  })
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/api/auth/pats/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pats'] }),
  })
  return (
    <SectionShell
      title={t('account.pats', { defaultValue: 'Personal Access Tokens' })}
      description={t('account.patsDesc', {
        defaultValue:
          'For scripts and CI. Each token carries a subset of your role permissions. Tokens are shown once at creation — copy it before closing.',
      })}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          create.mutate()
        }}
        className="account-form account-form--inline"
      >
        <label className="account-form__field account-form__field--grow">
          <span className="account-form__label">
            {t('account.patName', { defaultValue: 'Token name' })}
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('account.patNamePlaceholder', { defaultValue: 'e.g. ci-launcher' })}
            required
          />
        </label>
        <button type="submit" className="btn btn--primary" disabled={!name || create.isPending}>
          {t('account.generate', { defaultValue: 'Generate' })}
        </button>
      </form>
      {shown && (
        <div className="account-callout account-callout--success" data-testid="new-pat-secret">
          <strong>{t('account.patShownOnce', { defaultValue: 'New token (copy now)' })}</strong>
          <code className="account-callout__code">{shown}</code>
          <button
            className="btn btn--ghost btn--xs"
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(shown)
            }}
          >
            {t('account.copy', { defaultValue: 'Copy' })}
          </button>
        </div>
      )}
      {(data ?? []).length === 0 ? (
        <p className="account-empty">{t('account.noPats', { defaultValue: 'No tokens yet.' })}</p>
      ) : (
        <table className="account-table">
          <thead>
            <tr>
              <th>{t('account.patNameCol', { defaultValue: 'Name' })}</th>
              <th>{t('account.patScopes', { defaultValue: 'Scopes' })}</th>
              <th>{t('account.patStatus', { defaultValue: 'Status' })}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>
                  <div className="account-scope-chips">
                    {p.scopes.map((s) => (
                      <span key={s} className="account-scope-chip">
                        {s}
                      </span>
                    ))}
                  </div>
                </td>
                <td>
                  <span
                    className={`status-chip status-chip--${p.revokedAt ? 'danger' : 'success'}`}
                  >
                    {p.revokedAt ? 'revoked' : 'active'}
                  </span>
                </td>
                <td>
                  {!p.revokedAt && (
                    <button
                      onClick={() => revoke.mutate(p.id)}
                      className="btn btn--ghost btn--xs btn--danger"
                    >
                      {t('account.revoke', { defaultValue: 'Revoke' })}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SectionShell>
  )
}

function SessionsSection() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data } = useQuery<Array<{ id: string; userAgent: string | null; lastUsedAt: number }>>({
    queryKey: ['sessions'],
    queryFn: () => api.get('/api/auth/sessions'),
  })
  const revoke = useMutation({
    mutationFn: (id: string) => api.post(`/api/auth/sessions/${id}/revoke`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sessions'] })
      qc.invalidateQueries({ queryKey: ACTOR_QUERY_KEY })
    },
  })
  return (
    <SectionShell
      title={t('account.sessions', { defaultValue: 'Active sessions' })}
      description={t('account.sessionsDesc', {
        defaultValue:
          'Web sessions for this account. Revoke any session you do not recognise — the next request from that browser will return 401.',
      })}
    >
      {(data ?? []).length === 0 ? (
        <p className="account-empty">
          {t('account.noSessions', { defaultValue: 'No active sessions.' })}
        </p>
      ) : (
        <table className="account-table">
          <thead>
            <tr>
              <th>{t('account.sessionId', { defaultValue: 'Session' })}</th>
              <th>{t('account.userAgent', { defaultValue: 'User agent' })}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((s) => (
              <tr key={s.id}>
                <td>
                  <code>{s.id.slice(0, 10)}…</code>
                </td>
                <td className="account-table__ua">{s.userAgent ?? '—'}</td>
                <td>
                  <button
                    onClick={() => revoke.mutate(s.id)}
                    className="btn btn--ghost btn--xs btn--danger"
                  >
                    {t('account.revoke', { defaultValue: 'Revoke' })}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SectionShell>
  )
}

function IdentitiesSection() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data } = useQuery<
    Array<{
      id: string
      providerSlug: string
      providerDisplayName?: string
      subject: string
      email: string | null
    }>
  >({
    queryKey: ['identities'],
    queryFn: () => api.get('/api/auth/identities'),
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/auth/identities/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['identities'] }),
  })
  return (
    <SectionShell
      title={t('account.linkedIdentities', { defaultValue: 'Linked identities' })}
      description={t('account.identitiesDesc', {
        defaultValue:
          'OIDC providers linked to this account. Unlinking does not delete the account; you can re-link from the login page.',
      })}
    >
      {(data ?? []).length === 0 ? (
        <p className="account-empty">
          {t('account.noIdentities', { defaultValue: 'No linked identities yet.' })}
        </p>
      ) : (
        <table className="account-table">
          <thead>
            <tr>
              <th>{t('account.provider', { defaultValue: 'Provider' })}</th>
              <th>{t('account.subject', { defaultValue: 'Subject' })}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data?.map((i) => (
              <tr key={i.id}>
                <td>{i.providerDisplayName ?? i.providerSlug}</td>
                <td>
                  <code>{i.subject}</code>
                </td>
                <td>
                  <button
                    onClick={() => remove.mutate(i.id)}
                    className="btn btn--ghost btn--xs btn--danger"
                  >
                    {t('account.unlink', { defaultValue: 'Unlink' })}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SectionShell>
  )
}
