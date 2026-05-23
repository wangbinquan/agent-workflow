// RFC-060 PR-B — signal-port prompt template guard tests.
//
// Locks the contract:
//  1. Empty / undefined template → no violations.
//  2. Template references to non-signal ports → no violations.
//  3. Template references to a signal port → violation reported.
//  4. Multiple signal ports referenced → all reported, dedup by port name.
//  5. Unknown port (not in portKinds) → no violation (legacy 'string' default).
//  6. ParsedKind can be passed directly (callers don't have to stringify).
//  7. assertNoPromptSignalRefs throws SignalPortInPromptError with detail.

import { describe, expect, test } from 'bun:test'
import { parseKind } from '../src/kindParser'
import {
  SignalPortInPromptError,
  assertNoPromptSignalRefs,
  findPromptSignalRefs,
} from '../src/signalPromptGuard'

describe('findPromptSignalRefs — empty / undefined templates', () => {
  test('undefined template → []', () => {
    expect(findPromptSignalRefs(undefined, { done: 'signal' })).toEqual([])
  })

  test('empty string → []', () => {
    expect(findPromptSignalRefs('', { done: 'signal' })).toEqual([])
  })

  test('no template references → []', () => {
    expect(findPromptSignalRefs('hello world', { done: 'signal' })).toEqual([])
  })
})

describe('findPromptSignalRefs — non-signal port refs', () => {
  test('string port reference → no violation', () => {
    expect(findPromptSignalRefs('hi {{report}}', { report: 'string' })).toEqual([])
  })

  test('markdown port reference → no violation', () => {
    expect(findPromptSignalRefs('hi {{md}}', { md: 'markdown' })).toEqual([])
  })

  test('path<md> reference → no violation', () => {
    expect(findPromptSignalRefs('hi {{doc}}', { doc: 'path<md>' })).toEqual([])
  })

  test('list<path<md>> reference → no violation', () => {
    expect(findPromptSignalRefs('hi {{docs}}', { docs: 'list<path<md>>' })).toEqual([])
  })
})

describe('findPromptSignalRefs — signal port refs', () => {
  test('single signal port reference flagged', () => {
    const v = findPromptSignalRefs('upstream finished: {{done}}', { done: 'signal' })
    expect(v).toEqual([{ port: 'done', kindRepr: 'signal' }])
  })

  test('two signal ports flagged in declaration order', () => {
    const v = findPromptSignalRefs('a={{a}} b={{b}}', { a: 'signal', b: 'signal' })
    expect(v).toEqual([
      { port: 'a', kindRepr: 'signal' },
      { port: 'b', kindRepr: 'signal' },
    ])
  })

  test('duplicate references dedup by port name', () => {
    const v = findPromptSignalRefs('{{done}} again {{done}}', { done: 'signal' })
    expect(v).toEqual([{ port: 'done', kindRepr: 'signal' }])
  })

  test('mixed signal + non-signal → only signal flagged', () => {
    const v = findPromptSignalRefs('report={{report}} done={{done}}', {
      report: 'path<md>',
      done: 'signal',
    })
    expect(v).toEqual([{ port: 'done', kindRepr: 'signal' }])
  })
})

describe('findPromptSignalRefs — unknown / loose inputs', () => {
  test('unknown port (not in portKinds map) → not flagged', () => {
    expect(findPromptSignalRefs('{{stranger}}', {})).toEqual([])
  })

  test('malformed kind string → treated as not-signal', () => {
    expect(findPromptSignalRefs('{{p}}', { p: 'list<>' })).toEqual([])
  })

  test('ParsedKind value (not string) accepted', () => {
    const v = findPromptSignalRefs('{{p}}', { p: parseKind('signal') })
    expect(v).toEqual([{ port: 'p', kindRepr: 'signal' }])
  })
})

describe('assertNoPromptSignalRefs', () => {
  test('no violations → no throw', () => {
    expect(() => assertNoPromptSignalRefs('hi {{report}}', { report: 'string' })).not.toThrow()
  })

  test('signal violation → throws SignalPortInPromptError with detail', () => {
    let caught: SignalPortInPromptError | null = null
    try {
      assertNoPromptSignalRefs('upstream={{done}}', { done: 'signal' })
    } catch (err) {
      caught = err as SignalPortInPromptError
    }
    expect(caught).not.toBeNull()
    expect(caught?.name).toBe('SignalPortInPromptError')
    expect(caught?.message).toContain("'done'")
    expect(caught?.violations).toEqual([{ port: 'done', kindRepr: 'signal' }])
  })
})
