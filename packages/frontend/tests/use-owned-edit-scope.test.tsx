// RFC-217 T11 — useOwnedEditScope hook unit tests (extracted from
// routes/workgroups.detail.tsx; the pure reducer is covered by
// edit-scope.test.ts — THESE lock the React wrapper's contract):
//   1. dispatch runs one reducer step and returns the NEW state synchronously;
//   2. ref.current always tracks the latest state, so chained dispatches in
//      one event handler never read a stale closure;
//   3. replace swaps the whole state (server reconcile path).

import { describe, expect, test } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useOwnedEditScope } from '../src/hooks/useOwnedEditScope'

describe('useOwnedEditScope', () => {
  test('dispatch(edit) flips dirty and returns the new state synchronously', () => {
    const { result } = renderHook(() => useOwnedEditScope({ name: 'a' }))
    expect(result.current.state.dirty).toBe(false)
    let returned: ReturnType<typeof result.current.dispatch> | undefined
    act(() => {
      returned = result.current.dispatch({ type: 'edit', draft: { name: 'b' } })
    })
    expect(returned?.dirty).toBe(true)
    expect(result.current.state.draft).toEqual({ name: 'b' })
  })

  test('ref.current tracks chained dispatches within one handler (no stale closure)', () => {
    const { result } = renderHook(() => useOwnedEditScope({ name: 'a' }))
    act(() => {
      result.current.dispatch({ type: 'edit', draft: { name: 'b' } })
      // Second dispatch in the SAME act tick must see the first one's result
      // via ref.current — state (useState) is still the old render's value.
      const after = result.current.dispatch({ type: 'edit', draft: { name: 'c' } })
      expect(after.draft).toEqual({ name: 'c' })
      expect(result.current.ref.current.draft).toEqual({ name: 'c' })
    })
    expect(result.current.state.draft).toEqual({ name: 'c' })
  })

  test('semantic equality: editing back to the base value clears dirty', () => {
    const { result } = renderHook(() => useOwnedEditScope({ name: 'a' }))
    act(() => {
      result.current.dispatch({ type: 'edit', draft: { name: 'b' } })
      result.current.dispatch({ type: 'edit', draft: { name: 'a' } })
    })
    expect(result.current.state.dirty).toBe(false)
  })

  test('replace swaps the whole scope state (server reconcile)', () => {
    const { result } = renderHook(() => useOwnedEditScope({ name: 'a' }))
    act(() => {
      result.current.dispatch({ type: 'edit', draft: { name: 'b' } })
    })
    const fresh = {
      ...result.current.state,
      dirty: false,
      baseline: { name: 'z' },
      draft: { name: 'z' },
    }
    act(() => {
      result.current.replace(fresh)
    })
    expect(result.current.state.draft).toEqual({ name: 'z' })
    expect(result.current.ref.current.draft).toEqual({ name: 'z' })
    expect(result.current.state.dirty).toBe(false)
  })
})
