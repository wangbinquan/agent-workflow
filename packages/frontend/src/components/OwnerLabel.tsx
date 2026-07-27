// RFC-232 — compact owner identity for task and scheduled-task tables.

import type { OwnerIdentity } from '@agent-workflow/shared'
import { useTranslation } from 'react-i18next'

export interface OwnerLabelProps {
  /** undefined is reserved for the old-daemon compatibility branch. */
  ownerUserId?: string | null
  owner?: OwnerIdentity | null
}

export function OwnerLabel({ ownerUserId, owner }: OwnerLabelProps) {
  const { t } = useTranslation()

  if (ownerUserId === undefined) {
    return <span className="owner-label owner-label--fallback">{t('acl.unknownOwner')}</span>
  }
  if (ownerUserId === null || ownerUserId === '__system__') {
    return <span className="owner-label owner-label--fallback">{t('acl.systemOwner')}</span>
  }
  if (owner !== null && owner !== undefined && owner.id === ownerUserId) {
    return (
      <span className="owner-label" title={`${owner.displayName} (@${owner.username})`}>
        <span className="owner-label__display">{owner.displayName}</span>
        <span className="owner-label__identity">@{owner.username}</span>
      </span>
    )
  }
  return (
    <span className="owner-label owner-label--fallback" title={ownerUserId}>
      <span className="owner-label__identity owner-label__identity--stable">{ownerUserId}</span>
    </span>
  )
}
