import { useMemo, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { Permission, PermissionGroup, Role } from '@agent-workflow/shared'
import { EmptyState } from '@/components/EmptyState'
import { Checkbox, TextInput } from '@/components/Form'
import { StatusChip, type StatusChipKind } from '@/components/StatusChip'
import {
  derivePermissionRows,
  toggleAdditionalPermission,
  type PermissionRowSource,
  type UserPermissionRow,
} from '@/lib/user-permissions'

const GROUP_ORDER: ReadonlyArray<PermissionGroup> = [
  'resources',
  'tasks',
  'memory-intent',
  'event-center',
  'webhooks',
  'repositories',
  'privileged-authoring',
  'platform',
]

const RISK_KIND: Record<UserPermissionRow['entry']['risk'], StatusChipKind> = {
  standard: 'neutral',
  elevated: 'warn',
  critical: 'danger',
}

function sourceTitle(source: PermissionRowSource, t: (key: string) => string): string {
  if (source === 'intrinsic') return t('permissions.intrinsicReason')
  if (source === 'baseline') return t('permissions.baselineReason')
  return t(`permissions.source.${source}`)
}

export function UserPermissionCatalog(props: {
  role: Role
  additionalPermissions: ReadonlyArray<Permission>
  disabled?: boolean
  onChange: (next: ReadonlyArray<Permission>) => void
}): ReactElement {
  const { t, i18n } = useTranslation()
  const [search, setSearch] = useState('')
  const model = useMemo(
    () =>
      derivePermissionRows({
        role: props.role,
        additionalPermissions: props.additionalPermissions,
        search,
        locale: i18n.language,
        translate: (key) => t(key),
      }),
    [i18n.language, props.additionalPermissions, props.role, search, t],
  )
  const hasRows = model.permissions.length > 0

  const renderPermission = (row: UserPermissionRow): ReactElement => {
    const readOnly = row.source === 'intrinsic'
    const inputDisabled = props.disabled === true || !row.mutable
    return (
      <li
        key={row.permission}
        className={`user-permission-row user-permission-row--${row.source}`}
        data-permission={row.permission}
      >
        <div className="user-permission-row__control">
          {readOnly ? (
            <span
              className="user-permission-row__readonly"
              role="img"
              aria-label={sourceTitle(row.source, t)}
              title={sourceTitle(row.source, t)}
            >
              {row.effective ? '✓' : '—'}
            </span>
          ) : (
            <Checkbox
              checked={row.effective}
              disabled={inputDisabled}
              title={inputDisabled ? sourceTitle(row.source, t) : undefined}
              aria-label={`${row.label} (${row.permission})`}
              data-testid={`user-permission-${row.permission}`}
              onChange={(checked) =>
                props.onChange(
                  toggleAdditionalPermission({
                    role: props.role,
                    additionalPermissions: props.additionalPermissions,
                    permission: row.permission,
                    checked,
                  }),
                )
              }
            />
          )}
        </div>
        <div className="user-permission-row__body">
          <div className="user-permission-row__heading">
            <strong>{row.label}</strong>
            <code>{row.permission}</code>
          </div>
          <p>{row.description}</p>
          <div className="user-permission-row__meta">
            <StatusChip kind={row.source === 'additional' ? 'info' : 'neutral'} size="sm">
              {t(`permissions.source.${row.source}`)}
            </StatusChip>
            <StatusChip kind={RISK_KIND[row.entry.risk]} size="sm">
              {t(`permissions.risk.${row.entry.risk}`)}
            </StatusChip>
            <span>{t(`permissions.token.${row.entry.token}`)}</span>
            {row.entry.constraints.map((constraint) => (
              <span key={constraint}>{t(`permissions.constraints.${constraint}`)}</span>
            ))}
          </div>
        </div>
      </li>
    )
  }

  return (
    <section className="user-permission-catalog" aria-labelledby="user-permission-catalog-title">
      <div className="user-permission-catalog__header">
        <div>
          <h3 id="user-permission-catalog-title">{t('permissions.title')}</h3>
          <p>
            {t('permissions.summary', {
              effective: model.effectiveCount,
              additional: model.additionalCount,
            })}
          </p>
        </div>
        <TextInput
          type="search"
          value={search}
          onChange={setSearch}
          placeholder={t('permissions.searchPlaceholder')}
          aria-label={t('permissions.searchLabel')}
          disabled={props.disabled}
          data-testid="user-permission-search"
        />
      </div>

      {!hasRows ? (
        <EmptyState
          title={t('permissions.noMatches')}
          description={t('permissions.noMatchesDescription')}
          size="compact"
          data-testid="user-permission-empty"
        />
      ) : (
        <div className="user-permission-catalog__groups">
          {GROUP_ORDER.map((group) => {
            const rows = model.permissions.filter((row) => row.entry.group === group)
            if (rows.length === 0) return null
            return (
              <section key={group} className="user-permission-group">
                <h4>{t(`permissions.groups.${group}`)}</h4>
                <ul>{rows.map(renderPermission)}</ul>
              </section>
            )
          })}
        </div>
      )}
    </section>
  )
}
