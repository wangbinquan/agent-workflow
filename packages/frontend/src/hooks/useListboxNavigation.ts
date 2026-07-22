// RFC-217 T10 — active-descendant listbox keyboard/hover navigation state.
//
// Extracted from the workgroup room's @-mention popup (RFC-174) so any future
// text-anchored listbox (a multiline field can't be a combobox, so the
// active-descendant model is the a11y-correct shape) reuses one state machine:
//   - a RAW active index (set by hover / ArrowUp/Down) that is derively
//     CLAMPED to the current item count, so a stale index can never deref
//     out of range after the candidate list shrinks;
//   - stable ids for aria-controls / aria-activedescendant wiring.
//
// Deliberately NOT owning open/close or filtering — those are caller-domain
// (the mention popup keys them on token context, focus, and in-flight sends).

import { useCallback, useId, useState } from 'react'

export interface ListboxNavigation {
  /** Clamped active index — safe to deref items[activeIndex] when count > 0. */
  activeIndex: number
  /** Raw setter (hover / arrow-key movement). */
  setActive: (index: number) => void
  /** Reset highlight to the top item (e.g. when the filter query changes). */
  reset: () => void
  /** id for the <ul role="listbox"> element. */
  listboxId: string
  /** id for the option at `index` (aria-activedescendant target). */
  optionId: (index: number) => string
}

export function useListboxNavigation(count: number): ListboxNavigation {
  const [activeIndexRaw, setActiveIndexRaw] = useState(0)
  const listboxId = useId()
  const activeIndex = count === 0 ? 0 : Math.min(Math.max(activeIndexRaw, 0), count - 1)
  const reset = useCallback(() => setActiveIndexRaw(0), [])
  const optionId = useCallback((index: number) => `${listboxId}-opt-${index}`, [listboxId])
  return { activeIndex, setActive: setActiveIndexRaw, reset, listboxId, optionId }
}
