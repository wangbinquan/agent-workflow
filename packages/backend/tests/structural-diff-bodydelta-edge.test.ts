// RFC-083/RFC-088 logic detail — edge-case guards for bodyDeltaFor.
// Locks the three branches the original structural-diff-bodydelta.test.ts never
// exercises (verified real coverage gaps):
//   1. RFC-088 "whitespace-only change is a no-op" — bodyLines filters blank
//      lines (s.trim().length > 0), so inserting an empty line inside a method
//      collapses to an EQUAL multiset {added:0,removed:0} → undefined. The
//      pre-existing no-op test only feeds IDENTICAL text on both sides, so it
//      never proves a body that DIFFERS only in whitespace is a no-op.
//   2. newText === null fails the guard → undefined.
//   3. a modified method whose after.range is undefined fails the guard →
//      undefined (SymbolNode.range is optional in the schema).
// See packages/backend/src/modules/workspace-insight/domain/structuralDiff/bodyDelta.ts:40-61.

import { describe, expect, test } from 'bun:test'
import { bodyDeltaFor } from '../src/modules/workspace-insight/domain/structuralDiff/bodyDelta'
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

function methodNoRange(id: string): SymbolNode {
  return {
    id,
    kind: 'method',
    name: 'm',
    qualifiedName: 'C.m',
    lang: 'python',
    filePath: 'm.py',
    confidence: 'extracted',
  }
}

describe('bodyDeltaFor edge guards', () => {
  // A blank line inserted inside the method body: before is lines 2..2,
  // after is lines 2..3 (the inserted blank line widens the range). bodyLines
  // drops the blank line, leaving identical trimmed non-empty bodies.
  const oldText = 'def m():\n    return 1\n'
  const newText = 'def m():\n\n    return 1\n'

  test('whitespace-only body change (blank line inserted) → undefined (no-op)', () => {
    const change: SymbolChange = {
      changeType: 'modified',
      kind: 'method',
      before: method('m.py#C.m:method:2', { startLine: 2, endLine: 2 }),
      after: method('m.py#C.m:method:2', { startLine: 2, endLine: 3 }),
    }
    // trimmed non-empty lines are ['return 1'] on both sides → {0,0} → undefined
    expect(bodyDeltaFor(change, oldText, newText)).toBeUndefined()
  })

  test('newText null → undefined', () => {
    const change: SymbolChange = {
      changeType: 'modified',
      kind: 'method',
      before: method('m.py#C.m:method:2', { startLine: 2, endLine: 2 }),
      after: method('m.py#C.m:method:2', { startLine: 2, endLine: 3 }),
    }
    expect(bodyDeltaFor(change, oldText, null)).toBeUndefined()
  })

  test('oldText null → undefined', () => {
    const change: SymbolChange = {
      changeType: 'modified',
      kind: 'method',
      before: method('m.py#C.m:method:2', { startLine: 2, endLine: 2 }),
      after: method('m.py#C.m:method:2', { startLine: 2, endLine: 3 }),
    }
    expect(bodyDeltaFor(change, null, newText)).toBeUndefined()
  })

  test('after.range undefined → undefined', () => {
    const change: SymbolChange = {
      changeType: 'modified',
      kind: 'method',
      before: method('m.py#C.m:method:2', { startLine: 2, endLine: 2 }),
      after: methodNoRange('m.py#C.m:method:2'),
    }
    expect(bodyDeltaFor(change, oldText, newText)).toBeUndefined()
  })

  test('before.range undefined → undefined', () => {
    const change: SymbolChange = {
      changeType: 'modified',
      kind: 'method',
      before: methodNoRange('m.py#C.m:method:2'),
      after: method('m.py#C.m:method:2', { startLine: 2, endLine: 3 }),
    }
    expect(bodyDeltaFor(change, oldText, newText)).toBeUndefined()
  })
})
