// RFC-217 T11 — the owned-edit-scope hook, extracted from
// routes/workgroups.detail.tsx (design §9.2: 乐观保存/歧义和解状态机是通用的
// 全量替换资源原语，不该私藏在一个路由里).
//
// Wraps the pure lib/edit-scope reducer with React state + a live ref so
// event handlers can chain synchronous dispatches without stale-closure reads
// (`ref.current` is always the latest committed scope state). `replace` swaps
// the whole state (server reconcile); `dispatch` runs one reducer step.

import { useCallback, useRef, useState, type RefObject } from 'react'
import {
  createEditScopeState,
  defaultEditScopeSemanticEqual,
  editScopeReducer,
  type EditScopeEvent,
  type EditScopeSemanticEqual,
  type EditScopeState,
} from '@/lib/edit-scope'

export interface ScopeController<T> {
  state: EditScopeState<T>
  ref: RefObject<EditScopeState<T>>
  dispatch: (event: EditScopeEvent<T>) => EditScopeState<T>
  replace: (next: EditScopeState<T>) => EditScopeState<T>
  semanticEqual: EditScopeSemanticEqual<T>
}

export function useOwnedEditScope<T>(
  initial: T,
  semanticEqual: EditScopeSemanticEqual<T> = defaultEditScopeSemanticEqual,
): ScopeController<T> {
  const [state, setState] = useState(() => createEditScopeState(initial))
  const ref = useRef(state)
  ref.current = state

  const replace = useCallback((next: EditScopeState<T>) => {
    ref.current = next
    setState(next)
    return next
  }, [])
  const dispatch = useCallback(
    (event: EditScopeEvent<T>) => replace(editScopeReducer(ref.current, event, semanticEqual)),
    [replace, semanticEqual],
  )
  return { state, ref, dispatch, replace, semanticEqual }
}
