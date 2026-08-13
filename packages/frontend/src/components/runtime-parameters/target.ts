export type RuntimeParameterTargetMode = 'insert-at-caret' | 'replace-whole-value'

export function insertAtCursor(
  value: string,
  start: number | null,
  end: number | null,
  token: string,
): { next: string; caret: number } {
  const selectionStart = start ?? value.length
  const selectionEnd = end ?? selectionStart
  return {
    next: value.slice(0, selectionStart) + token + value.slice(selectionEnd),
    caret: selectionStart + token.length,
  }
}

export interface RuntimeParameterTarget {
  readonly id: string
  readonly label: string
  readonly mode: RuntimeParameterTargetMode
  readonly value: string
  readonly revision: string | number
  readonly element?:
    | HTMLInputElement
    | HTMLTextAreaElement
    | null
    | (() => HTMLInputElement | HTMLTextAreaElement | null)
  readonly disabled?: boolean
  readonly validateNext?: (next: string) => string | null
  readonly commit: (next: string) => void
}

export function runtimeParameterTargetElement(
  target: RuntimeParameterTarget,
): HTMLInputElement | HTMLTextAreaElement | null {
  return typeof target.element === 'function' ? target.element() : (target.element ?? null)
}

export interface RuntimeParameterTargetSnapshot {
  readonly id: string
  readonly mode: RuntimeParameterTargetMode
  readonly value: string
  readonly revision: string | number
  readonly selectionStart: number | null
  readonly selectionEnd: number | null
}

export type RuntimeParameterCommitResult =
  | { readonly ok: true; readonly next: string; readonly caret: number | null }
  | {
      readonly ok: false
      readonly reason: 'disabled' | 'stale' | 'invalid'
      readonly error?: string
    }

export function snapshotRuntimeParameterTarget(
  target: RuntimeParameterTarget,
): RuntimeParameterTargetSnapshot {
  const element = runtimeParameterTargetElement(target)
  return {
    id: target.id,
    mode: target.mode,
    value: target.value,
    revision: target.revision,
    selectionStart: target.mode === 'insert-at-caret' ? (element?.selectionStart ?? null) : null,
    selectionEnd: target.mode === 'insert-at-caret' ? (element?.selectionEnd ?? null) : null,
  }
}

function restoreCaret(element: HTMLInputElement | HTMLTextAreaElement, caret: number): void {
  const raf =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (callback: () => void) => setTimeout(callback, 0)
  raf(() => {
    const active = document.activeElement
    if (
      active !== element &&
      (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)
    ) {
      return
    }
    element.focus()
    element.setSelectionRange(caret, caret)
  })
}

export function commitRuntimeParameter(
  snapshot: RuntimeParameterTargetSnapshot,
  current: RuntimeParameterTarget,
  token: string,
): RuntimeParameterCommitResult {
  if (current.disabled === true) return { ok: false, reason: 'disabled' }
  if (
    current.id !== snapshot.id ||
    current.mode !== snapshot.mode ||
    current.revision !== snapshot.revision ||
    current.value !== snapshot.value
  ) {
    return { ok: false, reason: 'stale' }
  }

  const insertion =
    current.mode === 'replace-whole-value'
      ? { next: token, caret: null }
      : insertAtCursor(snapshot.value, snapshot.selectionStart, snapshot.selectionEnd, token)
  const error = current.validateNext?.(insertion.next) ?? null
  if (error !== null) return { ok: false, reason: 'invalid', error }

  try {
    current.commit(insertion.next)
  } catch (error) {
    return {
      ok: false,
      reason: 'invalid',
      error: error instanceof Error ? error.message : String(error),
    }
  }
  const element = runtimeParameterTargetElement(current)
  if (insertion.caret !== null && element !== null) {
    restoreCaret(element, insertion.caret)
  }
  return { ok: true, next: insertion.next, caret: insertion.caret }
}
