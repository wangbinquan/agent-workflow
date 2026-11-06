// RFC-083 logic detail (#6) — per-method body line delta. Locks the multiset
// math + the applies-only-to-modified-callables gate.

import { describe, expect, test } from 'bun:test'
import {
  lineMultisetDelta,
  bodyDeltaFor,
} from '../src/modules/workspace-insight/domain/structuralDiff/bodyDelta'
import type { SymbolChange, SymbolNode } from '@agent-workflow/shared'

function method(id: string, range: { startLine: number; endLine: number }): SymbolNode {
  return {
    id,
    kind: 'method',
    name: 'm',
    qualifiedName: 'C.m',
    lang: 'python',
    filePath: 'm.py',
    range,
    confidence: 'extracted',
  }
}

describe('lineMultisetDelta', () => {
  test('counts added + removed by multiset difference', () => {
    expect(lineMultisetDelta(['a', 'b', 'c'], ['a', 'b', 'd', 'e'])).toEqual({
      added: 2,
      removed: 1,
    })
  })
  test('identical → no delta', () => {
    expect(lineMultisetDelta(['x', 'y'], ['x', 'y'])).toEqual({ added: 0, removed: 0 })
  })
  test('order-insensitive', () => {
    expect(lineMultisetDelta(['a', 'b'], ['b', 'a'])).toEqual({ added: 0, removed: 0 })
  })
})

describe('bodyDeltaFor', () => {
  const oldText = 'class C:\n    def m(self):\n        return 1\n'
  const newText = 'class C:\n    def m(self):\n        log()\n        return 1\n'

  test('modified callable with a changed body → line delta', () => {
    const change: SymbolChange = {
      changeType: 'modified',
      kind: 'method',
      before: method('m.py#C.m:method:2', { startLine: 2, endLine: 3 }),
      after: method('m.py#C.m:method:2', { startLine: 2, endLine: 4 }),
    }
    expect(bodyDeltaFor(change, oldText, newText)).toEqual({ added: 1, removed: 0 }) // log() added
  })

  test('added (not modified) → undefined', () => {
    const change: SymbolChange = {
      changeType: 'added',
      kind: 'method',
      after: method('m.py#C.m:method:2', { startLine: 2, endLine: 4 }),
    }
    expect(bodyDeltaFor(change, oldText, newText)).toBeUndefined()
  })

  test('non-callable (class) → undefined', () => {
    const node: SymbolNode = {
      ...method('m.py#C:class:1', { startLine: 1, endLine: 4 }),
      kind: 'class',
    }
    const change: SymbolChange = {
      changeType: 'modified',
      kind: 'class',
      before: node,
      after: node,
    }
    expect(bodyDeltaFor(change, oldText, newText)).toBeUndefined()
  })

  test('no-op body change → undefined (no delta worth showing)', () => {
    const change: SymbolChange = {
      changeType: 'modified',
      kind: 'method',
      before: method('m.py#C.m:method:2', { startLine: 2, endLine: 3 }),
      after: method('m.py#C.m:method:2', { startLine: 2, endLine: 3 }),
    }
    expect(bodyDeltaFor(change, oldText, oldText)).toBeUndefined()
  })
})
