import { useRef, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { AdminUserView } from '@agent-workflow/shared'
import { EmptyState } from '@/components/EmptyState'
import { TextInput } from '@/components/Form'
import { RelativeTime } from '@/components/RelativeTime'
import { Segmented } from '@/components/Segmented'
import { Select } from '@/components/Select'
import { StatusChip } from '@/components/StatusChip'
import { USER_ICON } from '@/components/icons/resourceIcons'
import {
  USER_ROLE_PRESENTATION,
  USER_STATUS_PRESENTATION,
  accountInitials,
} from '@/lib/account-user-presentation'
import type {
  UserDirectoryFilters,
  UserDirectoryModel,
  UserRoleFilter,
  UserStatusFilter,
} from '@/lib/user-directory'

export interface UserDirectoryProps {
  model: UserDirectoryModel
  filters: UserDirectoryFilters
  currentUserId: string | undefined
  onQueryChange: (query: string) => void
  onStatusChange: (status: UserStatusFilter) => void
  onRoleChange: (role: UserRoleFilter) => void
  onClearFilters: () => void
  onCreate: (trigger: HTMLButtonElement) => void
  onManage: (user: AdminUserView, trigger: HTMLButtonElement) => void
}

export function UserDirectory(props: UserDirectoryProps): ReactElement {
  const { t } = useTranslation()
  const searchRef = useRef<HTMLInputElement>(null)

  const clearFilters = () => {
    props.onClearFilters()
    queueMicrotask(() => searchRef.current?.focus())
  }

  return (
    <div className="user-directory">
      {props.model.emptyKind === 'initial' ? (
        <EmptyState
          title={t('users.empty')}
          description={t('users.emptyDescription')}
          icon={USER_ICON}
          action={
            <button
              type="button"
              className="btn btn--primary"
              onClick={(event) => props.onCreate(event.currentTarget)}
            >
              {t('users.new')}
            </button>
          }
          data-testid="users-empty"
        />
      ) : (
        <>
          <div className="user-directory__toolbar" aria-label={t('users.filtersLabel')}>
            <label className="user-directory__search">
              <span className="sr-only">{t('users.searchLabel')}</span>
              <span className="user-directory__search-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
                  <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
                  <path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.8" />
                </svg>
              </span>
              <TextInput
                inputRef={searchRef}
                value={props.filters.q}
                onChange={props.onQueryChange}
                placeholder={t('users.searchPlaceholder')}
                data-testid="users-search"
              />
            </label>
            <Segmented<UserStatusFilter>
              value={props.filters.status}
              onChange={props.onStatusChange}
              ariaLabel={t('users.statusFilterLabel')}
              className="user-directory__status-filter"
              testidPrefix="users-status-filter"
              options={[
                { value: 'all', label: t('users.filterAll') },
                { value: 'active', label: t('users.statusOption.active') },
                { value: 'invited', label: t('users.statusOption.invited') },
                { value: 'disabled', label: t('users.statusOption.disabled') },
              ]}
            />
            <Select<UserRoleFilter>
              value={props.filters.role}
              onChange={props.onRoleChange}
              ariaLabel={t('users.roleFilterLabel')}
              data-testid="users-role-filter"
              options={[
                { value: 'all', label: t('users.allRoles') },
                { value: 'admin', label: t('users.roleOption.admin') },
                { value: 'manager', label: t('users.roleOption.manager') },
                { value: 'user', label: t('users.roleOption.user') },
              ]}
            />
          </div>

          {props.model.emptyKind === 'filtered' ? (
            <EmptyState
              title={t('users.filteredEmpty')}
              description={t('users.filteredEmptyDescription')}
              size="compact"
              action={
                <button type="button" className="btn btn--sm" onClick={clearFilters}>
                  {t('common.clearFilters')}
                </button>
              }
              data-testid="users-filtered-empty"
            />
          ) : (
            <ul className="user-directory__list" aria-label={t('users.directoryLabel')}>
              {props.model.visible.map((user) => (
                <UserDirectoryRow
                  key={user.id}
                  user={user}
                  isSelf={user.id === props.currentUserId}
                  onManage={props.onManage}
                />
              ))}
            </ul>
          )}
        </>
      )}

      {props.model.system !== null && <SystemPrincipal user={props.model.system} />}
    </div>
  )
}

function UserDirectoryRow({
  user,
  isSelf,
  onManage,
}: {
  user: AdminUserView
  isSelf: boolean
  onManage: (user: AdminUserView, trigger: HTMLButtonElement) => void
}): ReactElement {
  const { t } = useTranslation()
  const role = USER_ROLE_PRESENTATION[user.role]
  const status = USER_STATUS_PRESENTATION[user.status]
  const ownership = user.hasOidcIdentity
    ? t('users.ownership.oidc')
    : user.status === 'invited'
      ? t('users.ownership.awaitingOidc')
      : t('users.ownership.local')

  return (
    <li className="user-directory__item" data-user-id={user.id}>
      <span className="user-directory__avatar" aria-hidden="true">
        {accountInitials(user.displayName, user.username)}
      </span>
      <div className="user-directory__identity">
        <div className="user-directory__name-line">
          <strong>{user.displayName}</strong>
          {isSelf && <span className="account-meta-chip">{t('users.you')}</span>}
        </div>
        <div className="user-directory__identity-meta">
          <code>@{user.username}</code>
          <span aria-hidden="true">·</span>
          <span>{user.email ?? t('common.emDash')}</span>
        </div>
      </div>
      <div className="user-directory__facts">
        <StatusChip kind={role.kind} size="sm">
          {t(role.labelKey)}
        </StatusChip>
        <StatusChip kind={status.kind} size="sm" withDot>
          {t(status.labelKey)}
        </StatusChip>
        <span className="account-meta-chip">{ownership}</span>
        <span className="user-directory__last-login">
          {user.lastLoginAt === null ? (
            t('users.neverSignedIn')
          ) : (
            <>
              <RelativeTime ts={user.lastLoginAt} /> {t('users.signedInSuffix')}
            </>
          )}
        </span>
      </div>
      <button
        type="button"
        className="btn btn--ghost user-directory__manage"
        onClick={(event) => onManage(user, event.currentTarget)}
        data-testid={`user-manage-${user.id}`}
      >
        {t('users.manage')}
      </button>
    </li>
  )
}

function SystemPrincipal({ user }: { user: AdminUserView }): ReactElement {
  const { t } = useTranslation()
  return (
    <section className="user-directory__system" aria-labelledby="users-system-title">
      <div className="user-directory__system-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
          <rect x="4" y="5" width="16" height="14" rx="3" stroke="currentColor" />
          <path d="M8 9h8M8 13h5" stroke="currentColor" strokeLinecap="round" />
        </svg>
      </div>
      <div>
        <h2 id="users-system-title">{t('users.systemTitle')}</h2>
        <p>
          <code>{user.username}</code> · {t('users.systemDescription')}
        </p>
      </div>
      <StatusChip kind="neutral" size="sm">
        {t('users.systemTokenRetired')}
      </StatusChip>
    </section>
  )
}
