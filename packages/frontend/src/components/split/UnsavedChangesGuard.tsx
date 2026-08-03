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

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { useBlocker, type ShouldBlockFn } from '@tanstack/react-router'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'

export interface UnsavedChangesCopyKeys {
  title: string
  body: string
  busyBody: string
  stay: string
  discard: string
  save: string
  saveFailed: string
  forceLeave: string
  forceLeaveWarning: string
}

export interface UnsavedChangesGuardProps {
  /** Synchronously-readable dirty key (non-null ⇒ block). */
  dirtyRef: RefObject<string | null>
  /** In-flight mutation state. Busy navigation cannot truthfully be discarded. */
  busyRef?: RefObject<boolean>
  /**
   * RFC-208 — when the current busy stretch began. Once it exceeds
   * BUSY_ESCAPE_AFTER_MS the dialog offers an informed "leave anyway".
   *
   * The block itself is NOT relaxed: a completed client-side abort still cannot
   * prove the server did not commit. What changed is that the block is no longer
   * allowed to be indefinite AND unescapable at the same time — a request that
   * hangs used to lock navigation for the whole app with a Stay-only dialog, and
   * only a reload could clear it.
   */
  busySinceRef?: RefObject<number | null>
  /** Cancel the in-flight operation(s) before leaving. */
  onForceLeave?: () => void
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
  /**
   * RFC-250 — durably save the latest caller-owned local generation before
   * continuing the blocked navigation. The callback must synchronously clear
   * `dirtyRef` before its promise fulfills; otherwise the guard fails closed.
   */
  onSaveAndProceed?: () => Promise<void>
  /** Caller-owned copy stays in the typed i18n catalog; raw HTML is forbidden. */
  copyKeys?: Partial<UnsavedChangesCopyKeys>
}

/** RFC-208 — how long a busy stretch may run before the dialog offers an out. */
export const BUSY_ESCAPE_AFTER_MS = 10_000

export function UnsavedChangesGuard({
  dirtyRef,
  busyRef,
  busySinceRef,
  onForceLeave,
  shouldBlockNavigation,
  onDiscard,
  onSaveAndProceed,
  copyKeys,
}: UnsavedChangesGuardProps) {
  const { t } = useTranslation()
  const stayRef = useRef<HTMLButtonElement | null>(null)
  const [savePending, setSavePending] = useState(false)
  const [saveError, setSaveError] = useState<unknown>(null)
  const [, setEscapeTick] = useState(0)
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
    if (
      resolver.status === 'blocked' &&
      !savePending &&
      dirtyRef.current === null &&
      busyRef?.current !== true
    ) {
      resolver.reset()
    }
  })

  useEffect(() => {
    if (resolver.status !== 'blocked') {
      setSavePending(false)
      setSaveError(null)
    }
  }, [resolver.status])

  const busy = busyRef?.current === true
  const since = busySinceRef?.current ?? null

  // `busySinceRef` deliberately stays synchronously readable, but refs do not
  // schedule React renders. Arm the one render needed at the escape threshold;
  // otherwise a navigation attempted during the first ten seconds can remain
  // on a Stay-only dialog forever when the request itself never settles.
  useEffect(() => {
    if (resolver.status !== 'blocked' || !busy || since === null) return
    const remaining = since + BUSY_ESCAPE_AFTER_MS - Date.now()
    if (remaining <= 0) return
    const timer = window.setTimeout(() => setEscapeTick((tick) => tick + 1), remaining)
    return () => window.clearTimeout(timer)
  }, [busy, resolver.status, since])

  if (resolver.status !== 'blocked') return null

  // Only offer the escape once the operation has visibly stopped progressing.
  // Before that the honest answer really is "wait" — a normal save settles in
  // well under this, so the button never appears during healthy use.
  const stalled = busy && since !== null && Date.now() - since >= BUSY_ESCAPE_AFTER_MS
  const key = <K extends keyof UnsavedChangesCopyKeys>(
    name: K,
    fallback: UnsavedChangesCopyKeys[K],
  ) => copyKeys?.[name] ?? fallback

  return (
    <Dialog
      open
      onClose={resolver.reset}
      title={t(key('title', 'splitPage.unsavedTitle'))}
      size="sm"
      data-testid="unsaved-guard-dialog"
      initialFocusRef={stayRef}
      dismissDisabled={savePending}
      footer={
        <>
          <button
            ref={stayRef}
            type="button"
            className="btn"
            onClick={resolver.reset}
            disabled={savePending}
            data-testid="unsaved-stay"
          >
            {t(key('stay', 'splitPage.unsavedStay'))}
          </button>
          {!busy && (
            <button
              type="button"
              className="btn btn--danger"
              disabled={savePending}
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
              {t(key('discard', 'splitPage.unsavedDiscard'))}
            </button>
          )}
          {!busy && onSaveAndProceed !== undefined && (
            <button
              type="button"
              className="btn btn--primary"
              disabled={savePending}
              onClick={() => {
                setSavePending(true)
                setSaveError(null)
                void onSaveAndProceed()
                  .then(() => {
                    // A fulfilled write for an older generation is not enough:
                    // only the caller's synchronous exact-generation clear can
                    // authorize the navigation.
                    if (dirtyRef.current !== null || busyRef?.current === true) {
                      throw new Error(t(key('saveFailed', 'splitPage.unsavedSaveFailed')))
                    }
                    resolver.proceed()
                  })
                  .catch((error: unknown) => {
                    setSaveError(error)
                  })
                  .finally(() => {
                    setSavePending(false)
                  })
              }}
              data-testid="unsaved-save-and-proceed"
            >
              {savePending ? t('common.saving') : t(key('save', 'splitPage.unsavedSaveAndProceed'))}
            </button>
          )}
          {busy && stalled && (
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => {
                onForceLeave?.()
                resolver.proceed()
              }}
              data-testid="unsaved-force-leave"
            >
              {t(key('forceLeave', 'splitPage.unsavedForceLeave'))}
            </button>
          )}
        </>
      }
    >
      <p>
        {t(
          busy
            ? key('busyBody', 'splitPage.unsavedBusyBody')
            : key('body', 'splitPage.unsavedBody'),
        )}
      </p>
      {busy && stalled && (
        <p>{t(key('forceLeaveWarning', 'splitPage.unsavedForceLeaveWarning'))}</p>
      )}
      {saveError !== null && (
        <ErrorBanner
          error={saveError}
          message={t(key('saveFailed', 'splitPage.unsavedSaveFailed'))}
          testid="unsaved-save-error"
        />
      )}
    </Dialog>
  )
}
