// RFC-036 — admin users list. Hidden behind usePermission('users:read');
// non-admin actors see a NoPermissionEmpty placeholder.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, ApiError } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { Select } from '@/components/Select'
import { usePermission } from '@/hooks/useActor'
import { Route as RootRoute } from './__root'

interface UserRow {
  id: string
  username: string
  email: string | null
  displayName: string
  role: 'admin' | 'user'
  status: 'active' | 'disabled' | 'invited'
  lastLoginAt: number | null
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/users',
  component: UsersPage,
})

function UsersPage() {
  const { t } = useTranslation()
  const allowed = usePermission('users:read')
  const qc = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)

  const { data, isLoading, error } = useQuery<UserRow[]>({
    queryKey: ['users'],
    queryFn: () => api.get('/api/users'),
    enabled: allowed,
  })
  const create = useMutation({
    mutationFn: (body: {
      username: string
      displayName: string
      role: 'admin' | 'user'
      password?: string
    }) => api.post('/api/users', body),
    onSuccess: () => {
      setShowCreate(false)
      qc.invalidateQueries({ queryKey: ['users'] })
    },
  })
  const disable = useMutation({
    mutationFn: (id: string) => api.delete(`/api/users/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  })

  if (!allowed) {
    return (
      <div className="page">
        <h1>{t('users.title', { defaultValue: 'Users' })}</h1>
        <NoPermission />
      </div>
    )
  }

  return (
    <div className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>{t('users.title', { defaultValue: 'Users' })}</h1>
          <p className="page__hint">
            {t('users.hint', { defaultValue: 'Manage users — only admins land here.' })}
          </p>
        </div>
        <button className="btn btn--primary" onClick={() => setShowCreate(true)}>
          {t('users.new', { defaultValue: 'New user' })}
        </button>
      </header>
      {isLoading && <div>Loading…</div>}
      {error && <div className="auth-form__error">{(error as Error).message}</div>}
      <table className="data-table">
        <thead>
          <tr>
            <th>{t('users.username', { defaultValue: 'Username' })}</th>
            <th>{t('users.displayName', { defaultValue: 'Display name' })}</th>
            <th>{t('users.role', { defaultValue: 'Role' })}</th>
            <th>{t('users.status', { defaultValue: 'Status' })}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {(data ?? []).map((u) => (
            <tr key={u.id}>
              <td>
                <code>{u.username}</code>
              </td>
              <td>{u.displayName}</td>
              <td>{u.role}</td>
              <td>{u.status}</td>
              <td>
                {u.id !== '__system__' && u.status === 'active' && (
                  <button
                    className="btn btn--ghost btn--xs btn--danger"
                    onClick={() => disable.mutate(u.id)}
                  >
                    {t('users.disable', { defaultValue: 'Disable' })}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {showCreate && (
        <CreateUserDialog
          onCancel={() => setShowCreate(false)}
          onSubmit={(b) => create.mutate(b)}
          busy={create.isPending}
          error={create.error instanceof ApiError ? create.error.message : null}
        />
      )}
    </div>
  )
}

function CreateUserDialog(props: {
  onCancel: () => void
  onSubmit: (b: {
    username: string
    displayName: string
    role: 'admin' | 'user'
    password?: string
  }) => void
  busy: boolean
  error: string | null
}) {
  const { t } = useTranslation()
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [role, setRole] = useState<'admin' | 'user'>('user')
  const [password, setPassword] = useState('')
  return (
    <Dialog
      open
      onClose={props.onCancel}
      title={t('users.create.title', { defaultValue: 'New user' })}
      size="sm"
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={props.onCancel}>
            {t('users.cancel', { defaultValue: 'Cancel' })}
          </button>
          <button
            type="submit"
            form="users-create-form"
            className="btn btn--primary"
            disabled={props.busy}
          >
            {t('users.create.submit', { defaultValue: 'Create' })}
          </button>
        </>
      }
    >
      <form
        id="users-create-form"
        className="users-create-form"
        onSubmit={(e) => {
          e.preventDefault()
          const body: Parameters<typeof props.onSubmit>[0] = { username, displayName, role }
          if (password) body.password = password
          props.onSubmit(body)
        }}
      >
        <label className="form-field">
          <span className="form-field__label">
            {t('users.username', { defaultValue: 'Username' })}
          </span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            pattern="[a-z0-9][a-z0-9_-]{0,63}"
            required
            autoFocus
          />
        </label>
        <label className="form-field">
          <span className="form-field__label">
            {t('users.displayName', { defaultValue: 'Display name' })}
          </span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
        </label>
        <label className="form-field">
          <span className="form-field__label">{t('users.role', { defaultValue: 'Role' })}</span>
          <Select<'admin' | 'user'>
            value={role}
            onChange={setRole}
            ariaLabel={t('users.role', { defaultValue: 'Role' })}
            options={[
              {
                value: 'user',
                label: t('users.role.user', { defaultValue: 'user' }),
                description: t('users.role.userDesc', {
                  defaultValue: 'Resource read + launch tasks + manage own account.',
                }),
              },
              {
                value: 'admin',
                label: t('users.role.admin', { defaultValue: 'admin' }),
                description: t('users.role.adminDesc', {
                  defaultValue: 'Full access: users, settings, OIDC, all tasks.',
                }),
              },
            ]}
            renderOption={(opt) => (
              <span className="select__option-stack">
                <span className="select__option-title">{opt.label}</span>
                {opt.description && <span className="select__option-sub">{opt.description}</span>}
              </span>
            )}
          />
        </label>
        <label className="form-field">
          <span className="form-field__label">
            {t('users.password', {
              defaultValue: 'Password (leave blank for invite-only)',
            })}
          </span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
          />
        </label>
        {props.error && <div className="form-field__error">{props.error}</div>}
      </form>
    </Dialog>
  )
}

function NoPermission() {
  const { t } = useTranslation()
  return (
    <div className="empty-state" data-testid="no-permission">
      <h2>{t('users.noPermission.title', { defaultValue: 'Admin permission required' })}</h2>
      <p>
        {t('users.noPermission.body', {
          defaultValue: 'This page is only available to administrators.',
        })}
      </p>
    </div>
  )
}
