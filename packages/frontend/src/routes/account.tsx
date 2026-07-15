// RFC-036 — user self-service page (/account). Available to admin + user
// (account:self permission). Lets the actor change their password, view
// active sessions, manage PATs, and review linked identities.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, ApiError } from '@/api/client'
import { Card } from '@/components/Card'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { StatusChip } from '@/components/StatusChip'
import { TableViewport } from '@/components/TableViewport'
import { ACTOR_QUERY_KEY, useActor, type MeResponse } from '@/hooks/useActor'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/account',
  component: AccountPage,
})

function AccountPage() {
  const { t } = useTranslation()
  const { data, isLoading, error, refetch } = useActor()
  const actorError = error !== null && error !== undefined
  const retryAction = (
    <button type="button" className="btn btn--sm" onClick={() => void refetch()}>
      {t('common.retry')}
    </button>
  )
  return (
    <div className="page account-page">
      <PageHeader title={t('account.title', { defaultValue: 'My account' })} />
      {data === undefined ? (
        isLoading ? (
          <LoadingState />
        ) : actorError ? (
          <ErrorBanner error={error} action={retryAction} />
        ) : (
          <LoadingState />
        )
      ) : (
        <>
          {actorError && <ErrorBanner error={error} action={retryAction} />}
          {!data ? (
            <EmptyState title={t('account.pleaseSignIn')} size="compact" />
          ) : (
            <div className="account-page__grid">
              <ProfileSection me={data} />
              <PasswordSection />
              <PatSection />
              <IdentitiesSection />
              <SessionsSection />
            </div>
          )}
        </>
      )}
    </div>
  )
}

function SectionShell(props: {
  headingId: string
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <Card
      as="section"
      aria-labelledby={props.headingId}
      header={
        <header>
          <h2 id={props.headingId} className="account-card__title">
            {props.title}
          </h2>
          {props.description && <p className="account-card__description">{props.description}</p>}
        </header>
      }
    >
      {props.children}
    </Card>
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
    <SectionShell
      headingId="account-profile-heading"
      title={t('account.profile', { defaultValue: 'Profile' })}
    >
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
        text:
          e instanceof ApiError ? e.message : ((e as Error).message ?? t('common.unknownError')),
      }),
  })
  return (
    <SectionShell
      headingId="account-password-heading"
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
        className="form-grid"
      >
        <Field label={t('account.oldPassword', { defaultValue: 'Current password' })} required>
          <TextInput
            type="password"
            autoComplete="current-password"
            value={oldPw}
            onChange={setOldPw}
            required
          />
        </Field>
        <Field label={t('account.newPassword', { defaultValue: 'New password' })} required>
          <TextInput
            type="password"
            autoComplete="new-password"
            value={newPw}
            onChange={setNewPw}
            required
            minLength={8}
          />
        </Field>
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

// Curated list of scopes the user can toggle on a PAT. Each scope carries
// a friendly i18n label + short description so the picker reads as
// purposes ("Launch tasks") rather than literal permission codes
// ("tasks:launch"). The bare code is still rendered in a small mono chip
// below the label so admins / CI authors can still tell exactly what each
// box maps to.
//
// Admins can grant any box in any group; the backend intersects PAT scopes
// with the role baseline so a regular-user PAT with the "Admin" boxes
// ticked just has them stripped (no privilege escalation possible).

interface PatScopeDef {
  code: string
  /** i18n key for the friendly label (e.g. "Launch tasks"). */
  labelKey: string
  /** i18n key for the one-line description (the "why pick this" hint). */
  descKey: string
}

interface PatScopeGroup {
  /** i18n key for the section heading. */
  titleKey: string
  scopes: PatScopeDef[]
}

const PAT_SCOPE_GROUPS: ReadonlyArray<PatScopeGroup> = [
  {
    titleKey: 'account.patGroup.spa',
    scopes: [
      {
        code: 'account:self',
        labelKey: 'account.patScope.accountSelf.label',
        descKey: 'account.patScope.accountSelf.desc',
      },
      {
        code: 'users:search',
        labelKey: 'account.patScope.usersSearch.label',
        descKey: 'account.patScope.usersSearch.desc',
      },
      {
        code: 'runtime:read',
        labelKey: 'account.patScope.runtimeRead.label',
        descKey: 'account.patScope.runtimeRead.desc',
      },
    ],
  },
  {
    titleKey: 'account.patGroup.tasks',
    scopes: [
      {
        code: 'tasks:launch',
        labelKey: 'account.patScope.tasksLaunch.label',
        descKey: 'account.patScope.tasksLaunch.desc',
      },
      {
        code: 'tasks:read:own',
        labelKey: 'account.patScope.tasksReadOwn.label',
        descKey: 'account.patScope.tasksReadOwn.desc',
      },
      {
        code: 'tasks:cancel:own',
        labelKey: 'account.patScope.tasksCancelOwn.label',
        descKey: 'account.patScope.tasksCancelOwn.desc',
      },
    ],
  },
  {
    titleKey: 'account.patGroup.resourceRead',
    scopes: [
      {
        code: 'agents:read',
        labelKey: 'account.patScope.agentsRead.label',
        descKey: 'account.patScope.agentsRead.desc',
      },
      {
        code: 'skills:read',
        labelKey: 'account.patScope.skillsRead.label',
        descKey: 'account.patScope.skillsRead.desc',
      },
      {
        code: 'mcps:read',
        labelKey: 'account.patScope.mcpsRead.label',
        descKey: 'account.patScope.mcpsRead.desc',
      },
      {
        code: 'plugins:read',
        labelKey: 'account.patScope.pluginsRead.label',
        descKey: 'account.patScope.pluginsRead.desc',
      },
      {
        code: 'workflows:read',
        labelKey: 'account.patScope.workflowsRead.label',
        descKey: 'account.patScope.workflowsRead.desc',
      },
      {
        code: 'repos:read',
        labelKey: 'account.patScope.reposRead.label',
        descKey: 'account.patScope.reposRead.desc',
      },
    ],
  },
  {
    titleKey: 'account.patGroup.admin',
    scopes: [
      {
        code: 'users:read',
        labelKey: 'account.patScope.usersRead.label',
        descKey: 'account.patScope.usersRead.desc',
      },
      {
        code: 'users:write',
        labelKey: 'account.patScope.usersWrite.label',
        descKey: 'account.patScope.usersWrite.desc',
      },
      {
        code: 'settings:read',
        labelKey: 'account.patScope.settingsRead.label',
        descKey: 'account.patScope.settingsRead.desc',
      },
      {
        code: 'settings:write',
        labelKey: 'account.patScope.settingsWrite.label',
        descKey: 'account.patScope.settingsWrite.desc',
      },
      {
        code: 'tasks:read:all',
        labelKey: 'account.patScope.tasksReadAll.label',
        descKey: 'account.patScope.tasksReadAll.desc',
      },
    ],
  },
]

function defaultPatScopes(): Set<string> {
  // Sensible default: everything in the "SPA access" + "Tasks" + resource-
  // read groups. This is what most CI / script PATs actually need; admins
  // can still tick admin boxes by hand.
  const out = new Set<string>()
  for (const g of PAT_SCOPE_GROUPS.slice(0, 3)) for (const s of g.scopes) out.add(s.code)
  return out
}

function PatSection() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: me } = useActor()
  // RFC-036 — the backend intersects PAT scopes with the actor's role
  // baseline, so a user-role actor that ticks `settings:read` gets it
  // silently stripped before the PAT row is written. To avoid the
  // "I ticked it but the PAT doesn't have it" UX surprise, we drive the
  // picker off the actor's actual permissions: scopes the actor doesn't
  // hold render disabled + faded, and groups where every scope is
  // disabled fall behind a "your role doesn't grant any of these" hint.
  const actorPerms = me?.permissions ?? []
  const hasPerm = (s: string) => actorPerms.includes(s)
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<Set<string>>(() => defaultPatScopes())

  // Reconcile the seed default against the actor's permissions when /me
  // resolves — strips any pre-checked scope the actor cannot grant so the
  // user never sees "I ticked this, why didn't it land in the PAT".
  useEffect(() => {
    if (!me) return
    const allowed = new Set(me.permissions)
    setScopes((prev) => {
      let changed = false
      const next = new Set<string>()
      for (const s of prev) {
        if (allowed.has(s)) next.add(s)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [me])
  const [shown, setShown] = useState<string | null>(null)
  const { data, isLoading, error, refetch } = useQuery<
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
        scopes: [...scopes],
      }),
    onSuccess: (r) => {
      setShown(r.token)
      setName('')
      setScopes(defaultPatScopes())
      void qc.invalidateQueries({ queryKey: ['pats'] })
    },
  })
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/api/auth/pats/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pats'] }),
  })
  function toggleScope(s: string) {
    setScopes((prev) => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })
  }
  return (
    <SectionShell
      headingId="account-pats-heading"
      title={t('account.pats', { defaultValue: 'Personal Access Tokens' })}
      description={t('account.patsDesc', {
        defaultValue:
          'For scripts and CI. Each token carries a subset of your role permissions — pick only the scopes the token actually needs. Tokens are shown once at creation; copy it before closing.',
      })}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          create.mutate()
        }}
        className="form-grid"
      >
        <Field label={t('account.patName', { defaultValue: 'Token name' })} required>
          <TextInput
            value={name}
            onChange={setName}
            placeholder={t('account.patNamePlaceholder', { defaultValue: 'e.g. ci-launcher' })}
            required
          />
        </Field>
        <div className="pat-scopes">
          <div className="pat-scopes__header">
            <span className="account-form__label">
              {t('account.patScopesLabel', { defaultValue: 'Scopes' })}
            </span>
            <div className="pat-scopes__bulk">
              <button
                type="button"
                className="btn btn--ghost btn--xs"
                onClick={() => {
                  // Tick everything the actor is *allowed* to grant —
                  // scopes outside the role baseline would be stripped by
                  // the backend anyway.
                  const all = new Set<string>()
                  for (const g of PAT_SCOPE_GROUPS) {
                    for (const s of g.scopes) {
                      if (hasPerm(s.code)) all.add(s.code)
                    }
                  }
                  setScopes(all)
                }}
              >
                {t('account.patSelectAll', { defaultValue: 'Select all' })}
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--xs"
                onClick={() =>
                  setScopes(new Set([...defaultPatScopes()].filter((s) => hasPerm(s))))
                }
              >
                {t('account.patSelectDefault', { defaultValue: 'Defaults' })}
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--xs"
                onClick={() => setScopes(new Set())}
              >
                {t('account.patSelectNone', { defaultValue: 'Clear' })}
              </button>
            </div>
          </div>
          {PAT_SCOPE_GROUPS.map((g) => {
            // Only render scopes the actor's role actually grants — the
            // backend would strip the rest anyway. If a whole group is
            // beyond the actor's role we omit it entirely (regular users
            // never see the Admin group, etc).
            const grantable = g.scopes.filter((s) => hasPerm(s.code))
            if (grantable.length === 0) return null
            const checkedCount = grantable.filter((s) => scopes.has(s.code)).length
            return (
              <fieldset key={g.titleKey} className="pat-scopes__group">
                <legend className="pat-scopes__group-title">
                  <span>{t(g.titleKey)}</span>
                  <span className="pat-scopes__group-count">
                    {checkedCount}/{grantable.length}
                  </span>
                </legend>
                <div className="pat-scopes__list">
                  {grantable.map((s) => {
                    const checked = scopes.has(s.code)
                    return (
                      <label
                        key={s.code}
                        className={`pat-scopes__row ${checked ? 'pat-scopes__row--checked' : ''}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleScope(s.code)}
                        />
                        <span className="pat-scopes__row-body">
                          <span className="pat-scopes__row-title">{t(s.labelKey)}</span>
                          <span className="pat-scopes__row-desc">{t(s.descKey)}</span>
                          <code className="pat-scopes__row-code">{s.code}</code>
                        </span>
                      </label>
                    )
                  })}
                </div>
              </fieldset>
            )
          })}
        </div>
        <div className="account-form__actions">
          <button
            type="submit"
            className="btn btn--primary"
            disabled={!name || scopes.size === 0 || create.isPending}
          >
            {t('account.generate', { defaultValue: 'Generate' })}
          </button>
          {scopes.size === 0 && (
            <span className="account-form__error">
              {t('account.patNoScopes', {
                defaultValue: 'Pick at least one scope.',
              })}
            </span>
          )}
        </div>
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
      {create.error !== null && <ErrorBanner error={create.error} />}
      {revoke.error !== null && <ErrorBanner error={revoke.error} />}
      {data === undefined ? (
        isLoading ? (
          <LoadingState size="compact" />
        ) : error !== null ? (
          <ErrorBanner
            error={error}
            action={
              <button type="button" className="btn btn--sm" onClick={() => void refetch()}>
                {t('common.retry')}
              </button>
            }
          />
        ) : null
      ) : (
        <>
          {error !== null && (
            <ErrorBanner
              error={error}
              action={
                <button type="button" className="btn btn--sm" onClick={() => void refetch()}>
                  {t('common.retry')}
                </button>
              }
            />
          )}
          {data.length === 0 ? (
            <p className="account-empty">
              {t('account.noPats', { defaultValue: 'No tokens yet.' })}
            </p>
          ) : (
            <TableViewport
              label={t('account.pats', { defaultValue: 'Personal Access Tokens' })}
              minWidth="sm"
            >
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
                  {data.map((p) => (
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
                        <StatusChip kind={p.revokedAt ? 'danger' : 'success'}>
                          {p.revokedAt
                            ? t('account.patStatusRevoked', { defaultValue: 'revoked' })
                            : t('account.patStatusActive', { defaultValue: 'active' })}
                        </StatusChip>
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
            </TableViewport>
          )}
        </>
      )}
    </SectionShell>
  )
}

function SessionsSection() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data, isLoading, error, refetch } = useQuery<
    Array<{ id: string; userAgent: string | null; lastUsedAt: number }>
  >({ queryKey: ['sessions'], queryFn: () => api.get('/api/auth/sessions') })
  const revoke = useMutation({
    mutationFn: (id: string) => api.post(`/api/auth/sessions/${id}/revoke`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sessions'] })
      qc.invalidateQueries({ queryKey: ACTOR_QUERY_KEY })
    },
  })
  return (
    <SectionShell
      headingId="account-sessions-heading"
      title={t('account.sessions', { defaultValue: 'Active sessions' })}
      description={t('account.sessionsDesc', {
        defaultValue:
          'Web sessions for this account. Revoke any session you do not recognise — the next request from that browser will return 401.',
      })}
    >
      {revoke.error !== null && <ErrorBanner error={revoke.error} />}
      {data === undefined ? (
        isLoading ? (
          <LoadingState size="compact" />
        ) : error !== null ? (
          <ErrorBanner
            error={error}
            action={
              <button type="button" className="btn btn--sm" onClick={() => void refetch()}>
                {t('common.retry')}
              </button>
            }
          />
        ) : null
      ) : (
        <>
          {error !== null && (
            <ErrorBanner
              error={error}
              action={
                <button type="button" className="btn btn--sm" onClick={() => void refetch()}>
                  {t('common.retry')}
                </button>
              }
            />
          )}
          {data.length === 0 ? (
            <p className="account-empty">
              {t('account.noSessions', { defaultValue: 'No active sessions.' })}
            </p>
          ) : (
            <TableViewport
              label={t('account.sessions', { defaultValue: 'Active sessions' })}
              minWidth="sm"
            >
              <table className="account-table">
                <thead>
                  <tr>
                    <th>{t('account.sessionId', { defaultValue: 'Session' })}</th>
                    <th>{t('account.userAgent', { defaultValue: 'User agent' })}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((s) => (
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
            </TableViewport>
          )}
        </>
      )}
    </SectionShell>
  )
}

function IdentitiesSection() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data, isLoading, error, refetch } = useQuery<
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
      headingId="account-identities-heading"
      title={t('account.linkedIdentities', { defaultValue: 'Linked identities' })}
      description={t('account.identitiesDesc', {
        defaultValue:
          'OIDC providers linked to this account. Unlinking does not delete the account; you can re-link from the login page.',
      })}
    >
      {remove.error !== null && <ErrorBanner error={remove.error} />}
      {data === undefined ? (
        isLoading ? (
          <LoadingState size="compact" />
        ) : error !== null ? (
          <ErrorBanner
            error={error}
            action={
              <button type="button" className="btn btn--sm" onClick={() => void refetch()}>
                {t('common.retry')}
              </button>
            }
          />
        ) : null
      ) : (
        <>
          {error !== null && (
            <ErrorBanner
              error={error}
              action={
                <button type="button" className="btn btn--sm" onClick={() => void refetch()}>
                  {t('common.retry')}
                </button>
              }
            />
          )}
          {data.length === 0 ? (
            <p className="account-empty">
              {t('account.noIdentities', { defaultValue: 'No linked identities yet.' })}
            </p>
          ) : (
            <TableViewport
              label={t('account.linkedIdentities', { defaultValue: 'Linked identities' })}
              minWidth="sm"
            >
              <table className="account-table">
                <thead>
                  <tr>
                    <th>{t('account.provider', { defaultValue: 'Provider' })}</th>
                    <th>{t('account.subject', { defaultValue: 'Subject' })}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((i) => (
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
            </TableViewport>
          )}
        </>
      )}
    </SectionShell>
  )
}
