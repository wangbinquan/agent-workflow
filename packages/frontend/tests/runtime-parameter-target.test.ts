import { describe, expect, test, vi } from 'vitest'
import {
  commitRuntimeParameter,
  snapshotRuntimeParameterTarget,
  type RuntimeParameterTarget,
} from '../src/components/runtime-parameters/target'

function target(over: Partial<RuntimeParameterTarget> = {}): RuntimeParameterTarget {
  return {
    id: 'field',
    label: 'Prompt',
    mode: 'insert-at-caret',
    value: 'hello world',
    revision: 1,
    commit: vi.fn(),
    ...over,
  }
}

describe('RFC-295 runtime parameter conditional target adapter', () => {
  test('captures selection before focus moves and replaces it atomically', () => {
    const input = document.createElement('textarea')
    input.value = 'hello world'
    input.setSelectionRange(6, 11)
    const current = target({ element: input })
    const snapshot = snapshotRuntimeParameterTarget(current)
    input.setSelectionRange(0, 0)

    expect(commitRuntimeParameter(snapshot, current, '{{name}}')).toEqual({
      ok: true,
      next: 'hello {{name}}',
      caret: 14,
    })
    expect(current.commit).toHaveBeenCalledWith('hello {{name}}')
  })

  test('whole-value mode replaces an enum value', () => {
    const current = target({ mode: 'replace-whole-value', value: 'success' })
    const snapshot = snapshotRuntimeParameterTarget(current)
    expect(commitRuntimeParameter(snapshot, current, '{{verdict}}')).toEqual({
      ok: true,
      next: '{{verdict}}',
      caret: null,
    })
  })

  test('a never-focused text target appends at the end', () => {
    const current = target({ value: 'hello' })
    expect(
      commitRuntimeParameter(snapshotRuntimeParameterTarget(current), current, '{{name}}'),
    ).toEqual({ ok: true, next: 'hello{{name}}', caret: 13 })
  })

  test('id, mode, revision and value are all CAS fences', () => {
    const opened = target()
    const snapshot = snapshotRuntimeParameterTarget(opened)
    for (const changed of [
      target({ id: 'other' }),
      target({ mode: 'replace-whole-value' }),
      target({ revision: 2 }),
      target({ value: 'remote edit' }),
    ]) {
      expect(commitRuntimeParameter(snapshot, changed, '{{x}}')).toEqual({
        ok: false,
        reason: 'stale',
      })
      expect(changed.commit).not.toHaveBeenCalled()
    }
  })

  test('disabled and validateNext failures never mutate', () => {
    const disabled = target({ disabled: true })
    expect(
      commitRuntimeParameter(snapshotRuntimeParameterTarget(disabled), disabled, '{{x}}'),
    ).toEqual({ ok: false, reason: 'disabled' })

    const invalid = target({ validateNext: () => 'Token must stay inside a JSON string.' })
    expect(
      commitRuntimeParameter(snapshotRuntimeParameterTarget(invalid), invalid, '{{x}}'),
    ).toEqual({
      ok: false,
      reason: 'invalid',
      error: 'Token must stay inside a JSON string.',
    })
    expect(invalid.commit).not.toHaveBeenCalled()
  })

  test('a throwing commit becomes an inline failure instead of escaping the picker', () => {
    const current = target({
      commit: () => {
        throw new Error('row was removed')
      },
    })
    expect(
      commitRuntimeParameter(snapshotRuntimeParameterTarget(current), current, '{{x}}'),
    ).toEqual({ ok: false, reason: 'invalid', error: 'row was removed' })
  })

  test('deferred caret restore yields when the user has focused another text control', () => {
    const callbacks: Array<() => void> = []
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
      callbacks.push(callback)
      return callbacks.length
    })
    const original = document.createElement('textarea')
    const other = document.createElement('input')
    document.body.append(original, other)
    original.value = 'hello'
    original.setSelectionRange(2, 2)
    const current = target({ value: 'hello', element: original })

    commitRuntimeParameter(snapshotRuntimeParameterTarget(current), current, '{{x}}')
    other.focus()
    callbacks[0]?.()

    expect(document.activeElement).toBe(other)
    original.remove()
    other.remove()
    vi.unstubAllGlobals()
  })
})
