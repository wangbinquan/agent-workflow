// RFC-232 — compact owner identity for task and scheduled-task tables.

import type { OwnerIdentity } from '@agent-workflow/shared'
import { useTranslation } from 'react-i18next'

export interface OwnerLabelProps {
  /** undefined is reserved for the old-daemon compatibility branch. */
  ownerUserId?: string | null
  owner?: OwnerIdentity | null
  /** Allow the full identity to wrap instead of ellipsizing the display name. */
  wrap?: boolean
}

export function OwnerLabel({ ownerUserId, owner, wrap = false }: OwnerLabelProps) {
  const { t } = useTranslation()
  const className = `owner-label${wrap ? ' owner-label--wrap' : ''}`

  if (ownerUserId === undefined) {
    return <span className={`${className} owner-label--fallback`}>{t('acl.unknownOwner')}</span>
  }
  if (ownerUserId === null || ownerUserId === '__system__') {
    return <span className={`${className} owner-label--fallback`}>{t('acl.systemOwner')}</span>
  }
  if (owner !== null && owner !== undefined && owner.id === ownerUserId) {
    return (
      <span className={className} title={`${owner.displayName} (@${owner.username})`}>
        <span className="owner-label__display">{owner.displayName}</span>
        <span className="owner-label__identity">@{owner.username}</span>
      </span>
    )
  }
  return (
    <span className={`${className} owner-label--fallback`} title={ownerUserId}>
      <span className="owner-label__identity owner-label__identity--stable">{ownerUserId}</span>
    </span>
  )
}
