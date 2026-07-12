// RFC-169 (T5) — the single router-level unsaved-changes guard, mounted once
// by ResourceSplitPage. Blocks any in-app navigation (clicking another card,
// "+ new", the sidebar, a dependency-tree node, browser back) while the parent
// draft is dirty, and arms the native beforeunload prompt for refresh/close.
//
// Dialog close semantics (§3.4, P2-5): the shared Dialog fires `onClose` on ESC
// / × / overlay click, but useBlocker's blocked promise only resolves via
// proceed()/reset(). If a dismiss merely hid the dialog, the blocked navigation
// would hang forever and a later navigation could overwrite the resolver. So
// EVERY dismiss path (onClose, "stay") maps to `resolver.reset()` = stay on the
// page; only "discard" calls `resolver.proceed()`.

import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { useBlocker } from '@tanstack/react-router'
import { Dialog } from '@/components/Dialog'

export interface UnsavedChangesGuardProps {
  /** Synchronously-readable dirty key (non-null ⇒ block). */
  dirtyRef: RefObject<string | null>
}

export function UnsavedChangesGuard({ dirtyRef }: UnsavedChangesGuardProps) {
  const { t } = useTranslation()
  const resolver = useBlocker({
    shouldBlockFn: () => dirtyRef.current !== null,
    enableBeforeUnload: () => dirtyRef.current !== null,
    withResolver: true,
  })

  if (resolver.status !== 'blocked') return null

  return (
    <Dialog
      open
      onClose={resolver.reset}
      title={t('splitPage.unsavedTitle')}
      size="sm"
      data-testid="unsaved-guard-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={resolver.reset} data-testid="unsaved-stay">
            {t('splitPage.unsavedStay')}
          </button>
          <button
            type="button"
            className="btn btn--danger"
            onClick={resolver.proceed}
            data-testid="unsaved-discard"
          >
            {t('splitPage.unsavedDiscard')}
          </button>
        </>
      }
    >
      <p>{t('splitPage.unsavedBody')}</p>
    </Dialog>
  )
}
