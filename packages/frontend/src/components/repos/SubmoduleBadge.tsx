// RFC-034 — small chip rendered next to each cached_repos row to advertise
// whether the parent repo has submodules and whether the latest sync/init
// pass succeeded.
//
// RFC-210 folds it into <StatusChip>. It used to carry its own
// `.submodule-badge` CSS, which made it one of the last chip families sitting
// outside the shared primitive — and the four states below now map cleanly onto
// StatusChipKind, so there was nothing left that justified a private look.
//
// The "has submodules but never synced" case (`lastSubmoduleSyncOk === null`)
// previously rendered as the green OK chip, claiming a success that never
// happened; it is neutral now.

import { useTranslation } from 'react-i18next'
import { StatusChip } from '@/components/StatusChip'

export interface SubmoduleBadgeProps {
  /** `null` when never probed; boolean once probed. */
  hasSubmodules: boolean | null
  /** `null` when never attempted; boolean otherwise. */
  lastSubmoduleSyncOk: boolean | null
  /** Pre-redacted stderr from the last failed pass. */
  lastSubmoduleSyncError: string | null
}

export function SubmoduleBadge({
  hasSubmodules,
  lastSubmoduleSyncOk,
  lastSubmoduleSyncError,
}: SubmoduleBadgeProps) {
  const { t } = useTranslation()
  // Never probed (legacy row) or genuinely submodule-free: nothing to say.
  if (hasSubmodules === null || hasSubmodules === false) return null

  if (lastSubmoduleSyncOk === false) {
    return (
      <StatusChip
        kind="danger"
        size="sm"
        title={lastSubmoduleSyncError ?? t('repos.submodule.errorFallback')}
        data-testid="submodule-badge-error"
      >
        {t('repos.submodule.labelError')}
      </StatusChip>
    )
  }
  if (lastSubmoduleSyncOk === null) {
    return (
      <StatusChip kind="neutral" size="sm" title={t('repos.submodule.titlePending')}>
        {t('repos.submodule.labelPending')}
      </StatusChip>
    )
  }
  return (
    <StatusChip
      kind="success"
      size="sm"
      title={t('repos.submodule.titleOk')}
      data-testid="submodule-badge-ok"
    >
      {t('repos.submodule.labelOk')}
    </StatusChip>
  )
}
