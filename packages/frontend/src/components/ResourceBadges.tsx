// RFC-169 (T4) — the RFC-099 private-visibility chip + owner badge fragment,
// extracted from ResourceNameCell so the split-page cards and the surviving
// table cells (workflows / workgroups still use ResourceNameCell) render the
// identical badges. Renders a fragment (no wrapper element) so both a `<td>`
// host and a flex chip-row host can drop it in.

import { useTranslation } from 'react-i18next'
import type { ResourceVisibility, UserPublic } from '@agent-workflow/shared'

/** Structural slice of `useUserLookup`'s return — the page-level batch lookup
 *  is created once per page and threaded into every card/row. */
export interface OwnerLookup {
  get: (id: string | null | undefined) => UserPublic | undefined
}

export interface ResourceBadgesProps {
  visibility?: ResourceVisibility | undefined
  ownerUserId?: string | null | undefined
  owners: OwnerLookup
}

export function ResourceBadges(props: ResourceBadgesProps) {
  const { t } = useTranslation()
  const owner = props.ownerUserId != null ? props.owners.get(props.ownerUserId) : undefined
  return (
    <>
      {props.visibility === 'private' && (
        <span className="chip chip--tight">{t('acl.privateChip')}</span>
      )}
      {owner !== undefined && (
        <span className="muted data-table__owner" title={t('acl.ownerBadge')}>
          {owner.displayName}
        </span>
      )}
    </>
  )
}
