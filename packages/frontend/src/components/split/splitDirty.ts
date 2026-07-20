// RFC-169 (T5) — parent-draft dirty channel between the split page's left rail
// (cards, which draw the dirty dot) and the right-rail route component (which
// owns the draft and knows whether it's dirty), plus the unsaved guard (which
// blocks navigation while dirty).
//
// The route reports its complete unsafe-to-leave state. Most pages derive this
// from the parent form draft; route-owned child buffers must be folded into the
// same boolean as they migrate (RFC-201: Agent raw-invalid JsonField state).
// This context deliberately remains a narrow boolean/key channel — ownership,
// validity and submission stay with the route rather than the split shell.
//
// The dirty key is held in BOTH a ref (read synchronously by the guard's
// shouldBlockFn — avoids the onSuccess-same-tick-navigation false block, T-D5)
// and state (drives the card dot render). ResourceSplitPage owns both and
// provides `report`.

import { createContext, useContext, useEffect } from 'react'

export type SplitBusyRelease = () => void
export type SplitDiscardHandler = () => boolean | void
export type SplitDiscardUnregister = () => void

export interface SplitDirtyContextValue {
  /** The cardKey whose parent draft is currently dirty (null = clean). */
  dirtyKey: string | null
  /** Right-rail route component reports its parent-draft dirty state up. */
  report: (cardKey: string, dirty: boolean) => void
  /**
   * Acquire a synchronous mutation token before starting network I/O. The
   * returned release is idempotent, so success-before-navigation and settled
   * cleanup can safely share it. Optional only for legacy isolated test
   * providers; ResourceSplitPage always supplies the production implementation.
   */
  beginBusy?: (cardKey: string, opts?: { abort?: () => void }) => SplitBusyRelease
  /**
   * Register one route-owned synchronous discard operation. Registrations are
   * composed per card key by ResourceSplitPage before guarded navigation.
   */
  registerDiscard?: (cardKey: string, discard: SplitDiscardHandler) => SplitDiscardUnregister
}

export const SplitDirtyContext = createContext<SplitDirtyContextValue | null>(null)

type ResolvedSplitDirtyContextValue = SplitDirtyContextValue & {
  beginBusy: NonNullable<SplitDirtyContextValue['beginBusy']>
  registerDiscard: NonNullable<SplitDirtyContextValue['registerDiscard']>
}

const NOOP_RELEASE: SplitBusyRelease = () => {}
const NOOP_UNREGISTER: SplitDiscardUnregister = () => {}
const NOOP_BEGIN_BUSY = () => NOOP_RELEASE
const NOOP_REGISTER_DISCARD = () => NOOP_UNREGISTER

export function useSplitDirty(): ResolvedSplitDirtyContextValue {
  const ctx = useContext(SplitDirtyContext)
  if (ctx === null) {
    throw new Error('useSplitDirty must be used within a ResourceSplitPage')
  }
  return {
    ...ctx,
    beginBusy: ctx.beginBusy ?? NOOP_BEGIN_BUSY,
    registerDiscard: ctx.registerDiscard ?? NOOP_REGISTER_DISCARD,
  }
}

/** Sentinel cardKey for the inline "new" view (which has no matching card —
 *  the guard still blocks, the left rail just draws no dot). */
export const NEW_CARD_KEY = '__new__'

/**
 * Right-rail detail/new components call this to report their parent-draft
 * dirty state. Reports on every dirty change and clears on unmount (so a
 * remount for a different resource, via remountDeps, starts clean).
 */
export function useReportSplitDirty(cardKey: string, dirty: boolean): void {
  const { report } = useSplitDirty()
  useEffect(() => {
    report(cardKey, dirty)
  }, [report, cardKey, dirty])
  useEffect(() => {
    return () => report(cardKey, false)
  }, [report, cardKey])
}

/** Register a route/child discard operation for the lifetime of its owner. */
export function useRegisterSplitDiscard(cardKey: string, discard: SplitDiscardHandler): void {
  const { registerDiscard } = useSplitDirty()
  useEffect(() => registerDiscard(cardKey, discard), [cardKey, discard, registerDiscard])
}
