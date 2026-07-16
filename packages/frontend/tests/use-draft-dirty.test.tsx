// RFC-169 (T3) — locks the dirty-tracking / save-receipt / clean-follow
// contract added to useDraftFromQuery, plus the useDirtyBaseline sister hook.
//
// These are the equality/reseed oracles behind the split page's dirty dot and
// UnsavedChangesGuard. The named scenarios below are the design-gate reasoning
// (P1-1 submit snapshot, R2-P1-1 A→B→A late receipt, P2-4 slow-config
// baseline) turned into regression locks.

import { act, renderHook } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { useDirtyBaseline, useDraftFromQuery } from '../src/hooks/useDraftFromQuery'

interface V {
  v: string
}
const idMap = (d: V): V => ({ v: d.v })

describe('useDraftFromQuery — dirty', () => {
  test('seed → clean; edit → dirty', () => {
    const { result } = renderHook(() => useDraftFromQuery<V, V>({ v: 'orig' }, idMap))
    expect(result.current.loaded).toBe(true)
    expect(result.current.dirty).toBe(false)
    act(() => result.current.setDraft({ v: 'edited' }))
    expect(result.current.dirty).toBe(true)
  })

  test('reverting an edit back to the seed value clears dirty (stable compare)', () => {
    const { result } = renderHook(() => useDraftFromQuery<V, V>({ v: 'orig' }, idMap))
    act(() => result.current.setDraft({ v: 'x' }))
    expect(result.current.dirty).toBe(true)
    act(() => result.current.setDraft({ v: 'orig' }))
    expect(result.current.dirty).toBe(false)
  })
})

describe('useDraftFromQuery — commitSaved receipt (P1-1)', () => {
  test('user idle at submit → draft = seed = saved (clean)', () => {
    const { result } = renderHook(() => useDraftFromQuery<V, V>({ v: 'orig' }, idMap))
    act(() => result.current.setDraft({ v: 'A' }))
    // submit snapshot 'A'; server echoes normalized 'A-server'
    act(() => result.current.commitSaved({ v: 'A' }, { v: 'A-server' }))
    expect(result.current.draft).toEqual({ v: 'A-server' })
    expect(result.current.dirty).toBe(false)
  })

  test('user kept editing during save → keep newer draft, only advance seed (still dirty)', () => {
    const { result } = renderHook(() => useDraftFromQuery<V, V>({ v: 'orig' }, idMap))
    act(() => result.current.setDraft({ v: 'A' })) // submitted snapshot
    act(() => result.current.setDraft({ v: 'B' })) // kept typing while in flight
    act(() => result.current.commitSaved({ v: 'A' }, { v: 'A' }))
    expect(result.current.draft).toEqual({ v: 'B' }) // never rolled back
    expect(result.current.dirty).toBe(true) // B differs from advanced seed A
  })
})

describe('useDraftFromQuery — followWhenClean / dirty-freeze', () => {
  test('clean draft rebases to a background refetch (A→B→A late-receipt fix)', () => {
    const { result, rerender } = renderHook(
      ({ data }) => useDraftFromQuery<V, V>(data, idMap, { followWhenClean: true }),
      { initialProps: { data: { v: 'orig' } as V } },
    )
    expect(result.current.dirty).toBe(false)
    rerender({ data: { v: 'server-new' } })
    expect(result.current.draft).toEqual({ v: 'server-new' })
    expect(result.current.dirty).toBe(false)
  })

  test('dirty draft is frozen; only the seed advances', () => {
    const { result, rerender } = renderHook(
      ({ data }) => useDraftFromQuery<V, V>(data, idMap, { followWhenClean: true }),
      { initialProps: { data: { v: 'orig' } as V } },
    )
    act(() => result.current.setDraft({ v: 'my-edit' }))
    rerender({ data: { v: 'server-changed' } })
    expect(result.current.draft).toEqual({ v: 'my-edit' }) // edits kept
    expect(result.current.dirty).toBe(true) // vs advanced seed 'server-changed'
  })

  test('route-owned invalid buffer freezes an otherwise clean draft', () => {
    const { result, rerender } = renderHook(
      ({ data, freezeWhen }) =>
        useDraftFromQuery<V, V>(data, idMap, { followWhenClean: true, freezeWhen }),
      { initialProps: { data: { v: 'orig' } as V, freezeWhen: false } },
    )

    rerender({ data: { v: 'server-changed' }, freezeWhen: true })
    expect(result.current.draft).toEqual({ v: 'orig' })
    // The remote value still advances the baseline. Once the sibling buffer
    // becomes valid, the retained draft is correctly dirty against it.
    rerender({ data: { v: 'server-changed' }, freezeWhen: false })
    expect(result.current.draft).toEqual({ v: 'orig' })
    expect(result.current.dirty).toBe(true)
  })

  test('without followWhenClean, a clean draft does NOT follow refetches (hydrate-once)', () => {
    const { result, rerender } = renderHook(({ data }) => useDraftFromQuery<V, V>(data, idMap), {
      initialProps: { data: { v: 'orig' } as V },
    })
    rerender({ data: { v: 'server-new' } })
    expect(result.current.draft).toEqual({ v: 'orig' }) // untouched contract preserved
  })
})

describe('useDirtyBaseline (P2-4 slow-config, two directions)', () => {
  const applyDefaults = (d: { name: string; runtime?: string }, runtime: string) => ({
    ...d,
    runtime: d.runtime ?? runtime,
  })

  test('untouched page stays clean once defaults fold into both draft and baseline', () => {
    const empty = { name: '', runtime: undefined as string | undefined }
    const { result, rerender } = renderHook(({ draft }) => useDirtyBaseline(draft, empty), {
      initialProps: { draft: empty },
    })
    expect(result.current.dirty).toBe(false)
    const withDefaults = applyDefaults(empty, 'oc')
    act(() => result.current.resetBaseline(withDefaults))
    rerender({ draft: withDefaults })
    expect(result.current.dirty).toBe(false)
  })

  test('a page the user typed into first stays dirty after defaults arrive', () => {
    const empty = { name: '', runtime: undefined as string | undefined }
    const { result, rerender } = renderHook(({ draft }) => useDirtyBaseline(draft, empty), {
      initialProps: { draft: empty },
    })
    const typed = { name: 'x', runtime: undefined as string | undefined }
    rerender({ draft: typed })
    expect(result.current.dirty).toBe(true)
    // config arrives: baseline absorbs defaults on the EMPTY shape; draft folds
    // defaults into the user's typed value.
    act(() => result.current.resetBaseline(applyDefaults(empty, 'oc')))
    rerender({ draft: applyDefaults(typed, 'oc') })
    expect(result.current.dirty).toBe(true) // name 'x' still differs
  })
})
