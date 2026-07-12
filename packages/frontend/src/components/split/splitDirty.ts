// RFC-169 (T5) — parent-draft dirty channel between the split page's left rail
// (cards, which draw the dirty dot) and the right-rail route component (which
// owns the draft and knows whether it's dirty), plus the unsaved guard (which
// blocks navigation while dirty).
//
// Design (§3.4, three-times-final "parent-draft level"): only the PARENT draft
// (the main form body — name/description/prompt/ports/config…, i.e. ~90% of
// edits) is tracked. Child local buffers (invalid JSON in a JsonField, an
// unsaved skill file, a staged ZIP) stay best-effort and are NOT tracked — and
// because "save stays in place" keeps those components mounted, they're already
// safer than today (where navigating away unmounts and drops them).
//
// The dirty key is held in BOTH a ref (read synchronously by the guard's
// shouldBlockFn — avoids the onSuccess-same-tick-navigation false block, T-D5)
// and state (drives the card dot render). ResourceSplitPage owns both and
// provides `report`.

import { createContext, useContext, useEffect } from 'react'

export interface SplitDirtyContextValue {
  /** The cardKey whose parent draft is currently dirty (null = clean). */
  dirtyKey: string | null
  /** Right-rail route component reports its parent-draft dirty state up. */
  report: (cardKey: string, dirty: boolean) => void
}

export const SplitDirtyContext = createContext<SplitDirtyContextValue | null>(null)

export function useSplitDirty(): SplitDirtyContextValue {
  const ctx = useContext(SplitDirtyContext)
  if (ctx === null) {
    throw new Error('useSplitDirty must be used within a ResourceSplitPage')
  }
  return ctx
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
