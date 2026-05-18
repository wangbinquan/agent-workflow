// RFC-036 — sidebar footer user dropdown. Admin sees: Manage users +
// Sign out. Regular user sees: My account + Sign out. The Settings entry
// is intentionally NOT included here — the sidebar gear icon (rendered
// next to LanguageSwitch when the actor has settings:read) is the
// canonical Settings entry, so duplicating it inside this menu would
// just be visual noise.

import { Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '@/api/client'
import { useActor, usePermission } from '@/hooks/useActor'
import { clearToken, getToken, subscribeAuth } from '@/stores/auth'

export function UserMenu() {
  const { data, isLoading } = useActor()
  const { t } = useTranslation()
  const isAdmin = usePermission('users:read')
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  async function logout() {
    try {
      await api.post('/api/auth/logout', {})
    } catch {
      /* ignore */
    }
    clearToken()
    setOpen(false)
    navigate({ to: '/auth' })
  }

  // If a token IS present but /api/auth/me fails (e.g. a PAT that lacks
  // account:self, or an expired session), useActor returns null. We still
  // need the user to be able to sign out — otherwise they're trapped with
  // no clickable affordance. Render a minimal "sign-out only" fallback.
  const hasToken = useSyncExternalStore(subscribeAuth, getToken, () => null) !== null
  if (isLoading) return null
  if (!data) {
    if (!hasToken) return null
    return (
      <div className="user-menu user-menu--orphan">
        <button
          type="button"
          className="user-menu__trigger user-menu__trigger--orphan"
          onClick={() => {
            clearToken()
            navigate({ to: '/auth' })
          }}
          title={t('userMenu.signedOutHint', {
            defaultValue: 'Token is missing account:self permission. Click to sign out.',
          })}
        >
          <span className="user-menu__avatar user-menu__avatar--warn" aria-hidden>
            !
          </span>
          <span className="user-menu__name-wrap">
            <span className="user-menu__name">
              {t('userMenu.tokenIssue', { defaultValue: 'Token has no access' })}
            </span>
            <span className="user-menu__sub">
              {t('userMenu.logout', { defaultValue: 'Sign out' })} →
            </span>
          </span>
        </button>
      </div>
    )
  }

  const isDaemon = data.source === 'daemon'
  // For daemon-token actors we surface the friendly displayName ("System")
  // and a "daemon access" sub-label instead of the internal __system__
  // slug. For real session/PAT users the username is the canonical identity
  // and we keep it visible.
  const triggerLabel = isDaemon ? data.user.displayName : data.user.username
  const triggerSub = isDaemon
    ? t('userMenu.daemonAccess', { defaultValue: 'daemon access' })
    : data.user.displayName !== data.user.username
      ? data.user.displayName
      : null

  return (
    <div className="user-menu" ref={ref}>
      <button
        className="user-menu__trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="user-menu__avatar" aria-hidden>
          {triggerLabel.slice(0, 1).toUpperCase()}
        </span>
        <span className="user-menu__name-wrap">
          <span className="user-menu__name">{triggerLabel}</span>
          {triggerSub && <span className="user-menu__sub">{triggerSub}</span>}
        </span>
      </button>
      {open && (
        <div className="user-menu__dropdown" role="menu">
          <div className="user-menu__header">
            <strong>{data.user.displayName}</strong>
            <span className="user-menu__role">
              {isDaemon
                ? t('userMenu.daemonRole', { defaultValue: 'daemon admin' })
                : data.user.role}
            </span>
          </div>
          {!isDaemon && (
            <Link
              to="/account"
              className="user-menu__item"
              role="menuitem"
              onClick={() => setOpen(false)}
            >
              {t('userMenu.account', { defaultValue: 'My account' })}
            </Link>
          )}
          {isAdmin && (
            <Link
              to="/users"
              className="user-menu__item"
              role="menuitem"
              onClick={() => setOpen(false)}
            >
              {t('userMenu.users', { defaultValue: 'Manage users' })}
            </Link>
          )}
          {/* "Settings" intentionally omitted — the sidebar's gear icon
              (rendered next to LanguageSwitch for admin actors) is the
              canonical entry to /settings. Keeping a duplicate link here
              just adds visual noise. */}
          <button className="user-menu__item user-menu__item--danger" onClick={logout}>
            {t('userMenu.logout', { defaultValue: 'Sign out' })}
          </button>
        </div>
      )}
    </div>
  )
}
