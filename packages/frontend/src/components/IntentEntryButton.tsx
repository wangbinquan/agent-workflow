// RFC-234 (T11) — the shared "build/modify via intent" entry button.
//
// List/gallery pages render the create variant (optional artifact hint);
// detail/editor pages render the modify variant carrying a mount target. Both
// navigate to /intent with the create dialog pre-opened — session creation and
// mounting stay on the one intent surface (no per-page dialog forks).

import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { ReactElement } from 'react'

export interface IntentEntryButtonProps {
  variant: 'create' | 'modify'
  /** Artifact hint for the create dialog (e.g. 'workflow'). */
  hint?: string
  /** Modify variant: the element the new session should mount. */
  mount?: {
    resourceType: 'agent' | 'skill' | 'mcp' | 'plugin' | 'workflow' | 'workgroup'
    resourceId: string
  }
  /** Match the hosting toolbar: default is the page-level `.btn` (md). */
  size?: 'sm' | 'xs'
  'data-testid'?: string
}

export function IntentEntryButton(props: IntentEntryButtonProps): ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const label = props.variant === 'create' ? t('intent.entryCreate') : t('intent.entryModify')
  return (
    <button
      type="button"
      className={props.size === undefined ? 'btn' : `btn btn--${props.size}`}
      data-testid={props['data-testid'] ?? 'intent-entry'}
      onClick={() =>
        void navigate({
          to: '/intent',
          search: {
            create: true,
            ...(props.hint === undefined ? {} : { hint: props.hint }),
            ...(props.mount === undefined
              ? {}
              : { mountType: props.mount.resourceType, mountId: props.mount.resourceId }),
          },
        })
      }
    >
      {label}
    </button>
  )
}
