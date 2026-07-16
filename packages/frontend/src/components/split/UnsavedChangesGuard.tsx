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

import { useCallback, useEffect, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { useBlocker, type ShouldBlockFn } from '@tanstack/react-router'
import { Dialog } from '@/components/Dialog'

export interface UnsavedChangesGuardProps {
  /** Synchronously-readable dirty key (non-null ⇒ block). */
  dirtyRef: RefObject<string | null>
  /** In-flight mutation state. Busy navigation cannot truthfully be discarded. */
  busyRef?: RefObject<boolean>
  /**
   * Optional dirty-navigation policy. Return false only for a caller-owned,
   * same-resource navigation that is safe because its draft remains mounted.
   * Busy mutations always block regardless of this predicate.
   */
  shouldBlockNavigation?: ShouldBlockFn
  /**
   * Synchronously clear caller-owned drafts before proceeding. Return false
   * when the caller could not clear them (for example, a mutation just began).
   */
  onDiscard?: () => boolean | void
}

export function UnsavedChangesGuard({
  dirtyRef,
  busyRef,
  shouldBlockNavigation,
  onDiscard,
}: UnsavedChangesGuardProps) {
  const { t } = useTranslation()
  const shouldBlock = useCallback<ShouldBlockFn>(
    (args) => {
      const dirty = dirtyRef.current !== null
      const busy = busyRef?.current === true
      if (!dirty && !busy) return false
      // A completed client-side abort cannot prove that the server did not
      // commit an in-flight write, so no navigation is safe while mutating.
      if (busy) return true
      return shouldBlockNavigation?.(args) ?? true
    },
    [busyRef, dirtyRef, shouldBlockNavigation],
  )
  const resolver = useBlocker({
    shouldBlockFn: shouldBlock,
    // The caller predicate only relaxes in-app navigation. Refresh/close must
    // keep the native prompt armed for every dirty or mutating draft.
    enableBeforeUnload: () => dirtyRef.current !== null || busyRef?.current === true,
    withResolver: true,
  })

  // A navigation may be blocked while a save is pending, then become safe
  // because that exact save settles clean. Do not leave a stale resolver/dialog
  // asking the user to discard work that no longer exists.
  useEffect(() => {
    if (resolver.status === 'blocked' && dirtyRef.current === null && busyRef?.current !== true) {
      resolver.reset()
    }
  })

  if (resolver.status !== 'blocked') return null

  const busy = busyRef?.current === true

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
          {!busy && (
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => {
                // The dialog can render while cleanly discardable, then an
                // exact save starts before this click. Re-check the live ref;
                // a stale button must never navigate away from a mutating form.
                const isBusyNow = () => busyRef?.current === true
                if (isBusyNow()) return
                if (onDiscard?.() === false) return
                if (isBusyNow()) return
                resolver.proceed()
              }}
              data-testid="unsaved-discard"
            >
              {t('splitPage.unsavedDiscard')}
            </button>
          )}
        </>
      }
    >
      <p>{t(busy ? 'splitPage.unsavedBusyBody' : 'splitPage.unsavedBody')}</p>
    </Dialog>
  )
}
