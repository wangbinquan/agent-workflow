// RFC-151 PR-4 — hydrate-once draft seeding for detail/edit pages.
//
// The resource detail pages keep a locally-editable draft that must seed
// exactly once from the fetched entity: React Query serves cached data first
// and refetches in the background, so a naive `useEffect(..., [data])` would
// clobber in-progress edits whenever the background refetch settles. Each
// page used to hand-roll the same `loaded` boolean + guard effect; this hook
// is that idiom, single-sourced.
//
// ## Stale-race contract (RFC-151 D3 — the hook does NOT manage caches)
//
// Because the draft seeds from whatever the query returns FIRST (usually the
// cache), any mutation that saves this draft MUST eagerly write its server
// response back into the query cache in `onSuccess` (`qc.setQueryData(...)`)
// — otherwise re-opening the page right after a save re-seeds from the stale
// cached row until the background refetch lands. The four resource detail
// pages already do this; the canonical worked example (incl. sibling list
// caches) is MemoryEditDialog's onSuccess eager-write block
// (src/components/memory/MemoryEditDialog.tsx:107-139). Keeping the eager
// write at the call site is deliberate: the hook cannot know which sibling
// caches hold copies, and hiding it here would obscure who owns cache
// consistency.
//
// ## Sister form
//
// `useMemoryFormState` (MemoryFormFields.tsx) covers the *dialog* variant of
// the same problem with a lazy useState initializer instead: its seed is a
// prop that is synchronously available at mount (the dialog remounts per
// entity), not an async query — so it needs no `loaded` gate and is NOT
// migrated onto this hook.
//
// `ready` gates multi-source pages: skills.detail seeds one draft from two
// queries (meta + content), passing `ready: content.data !== undefined` while
// `map` closes over the second source.
//
// ## RFC-169 — dirty tracking + save-receipt + clean-follow
//
// The split (master-detail) pages add three concerns on top of hydrate-once:
//
//   - `dirty`: is the draft different from the seed snapshot? Drives the card
//     dirty-dot and the UnsavedChangesGuard. Computed with `stableStringify`
//     so key-reordering never falsely flips it.
//   - `commitSaved(submitted, saved)`: the save-onSuccess receipt. NOT an
//     unconditional overwrite — the field stays editable during a save (Save
//     only disables itself), so if the user kept typing while the PUT was in
//     flight we must keep their newer input and only advance the baseline.
//     * current draft === submitted (user idle) → draft = seed = saved (clean)
//     * else (user kept editing)                → keep draft, seed = saved
//       (still dirty vs the new baseline — never silently roll back edits)
//   - `followWhenClean` (opt-in; the four RFC-169 pages enable it, every other
//     caller keeps the untouched hydrate-once contract): when the draft is
//     CLEAN, a background refetch of `data` rebases seed=draft to the fresh
//     value (covers the A→B→A late-receipt "clean but stale" trap and
//     multi-tab clean-side edits); when the draft is DIRTY, the draft is
//     frozen (edits kept) and only the seed advances to the latest server
//     truth. `dirty` therefore always means "your draft differs from the
//     latest known server value".

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { stableStringify } from '@/lib/stable-stringify'

export interface UseDraftFromQueryResult<D> {
  /** undefined until the first successful seed. */
  draft: D | undefined
  setDraft: Dispatch<SetStateAction<D | undefined>>
  /** True once the draft seeded — gate Save buttons on it. */
  loaded: boolean
  /** loaded && the draft differs from the seed baseline (stable-serialized). */
  dirty: boolean
  /**
   * Save-onSuccess receipt (RFC-169 §3.3). Pass the snapshot that was
   * submitted (mutation variables) and the mapped server response. Reseeds
   * the baseline to `saved`; only overwrites the draft when the user has not
   * kept editing since submit.
   */
  commitSaved: (submitted: D, saved: D) => void
}

export function useDraftFromQuery<T, D>(
  data: T | undefined,
  map: (t: T) => D,
  opts?: {
    ready?: boolean
    followWhenClean?: boolean
    /**
     * A sibling route-owned buffer is dirty even when `draft` itself still
     * equals its seed (for example raw-invalid JSON whose last parsed object
     * remains unchanged). Freeze clean-follow until that sibling reconciles.
     */
    freezeWhen?: boolean
  },
): UseDraftFromQueryResult<D> {
  const [draft, setDraft] = useState<D | undefined>(undefined)
  const [seed, setSeed] = useState<D | undefined>(undefined)
  const [loaded, setLoaded] = useState(false)
  const ready = opts?.ready ?? true
  const followWhenClean = opts?.followWhenClean ?? false
  const freezeWhen = opts?.freezeWhen ?? false

  // Refs mirror the latest committed values so async callbacks (commitSaved)
  // and the follow effect read the current draft/seed without stale closures.
  const draftRef = useRef(draft)
  draftRef.current = draft
  const seedRef = useRef(seed)
  seedRef.current = seed

  // Hydrate-once: seed both draft and baseline from the first available data.
  useEffect(() => {
    if (!loaded && ready && data !== undefined) {
      const seeded = map(data)
      setDraft(seeded)
      setSeed(seeded)
      setLoaded(true)
    }
  }, [loaded, ready, data, map])

  // clean-follow / dirty-freeze (opt-in). After the first seed, react to
  // background refetches of `data`. Idempotent: guarded by stableStringify so
  // repeated runs (inline `map` identity churn) never loop.
  useEffect(() => {
    if (!followWhenClean || !loaded || !ready || data === undefined) return
    const mapped = map(data)
    const mappedSig = stableStringify(mapped)
    const seedSig = stableStringify(seedRef.current)
    const isDirtyNow = freezeWhen || stableStringify(draftRef.current) !== seedSig
    if (mappedSig !== seedSig) setSeed(mapped)
    if (!isDirtyNow && stableStringify(draftRef.current) !== mappedSig) setDraft(mapped)
  }, [followWhenClean, freezeWhen, loaded, ready, data, map])

  const commitSaved = useCallback((submitted: D, saved: D) => {
    const cur = draftRef.current
    setSeed(saved)
    if (cur !== undefined && stableStringify(cur) === stableStringify(submitted)) {
      setDraft(saved)
    }
    // else: user kept editing while the save was in flight — keep their draft,
    // which now reads dirty against the advanced (saved) baseline.
  }, [])

  const dirty = useMemo(
    () => loaded && draft !== undefined && stableStringify(draft) !== stableStringify(seed),
    [loaded, draft, seed],
  )

  return { draft, setDraft, loaded, dirty, commitSaved }
}

/**
 * RFC-169 §3.3 — dirty tracking for create pages (a `useState` draft with no
 * backing query). Sister to `useDraftFromQuery`'s dirty field. `resetBaseline`
 * takes the next baseline EXPLICITLY: the caller decides what "clean" means
 * (e.g. agents.new folds config defaults into both draft and baseline so an
 * untouched page stays clean, while a page the user typed into stays dirty).
 */
export function useDirtyBaseline<D>(
  draft: D,
  initial: D,
): { dirty: boolean; resetBaseline: (next: D) => void } {
  const [baseline, setBaseline] = useState<D>(initial)
  const dirty = useMemo(
    () => stableStringify(draft) !== stableStringify(baseline),
    [draft, baseline],
  )
  const resetBaseline = useCallback((next: D) => setBaseline(next), [])
  return { dirty, resetBaseline }
}
