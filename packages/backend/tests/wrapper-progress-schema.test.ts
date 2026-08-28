// RFC-040/RFC-339 — locks the contract for task-execution/domain/wrapperProgress.ts.
//
// The scheduler's wrapper resume path depends on `decodeWrapperProgress`
// returning a typed `WrapperProgress` on round-trip and returning null
// (with a warn) on malformed payloads — never throwing. If this test starts
// failing the scheduler's resume helper would either crash on bad payloads
// (regression) or silently accept the wrong shape (worse silent regression).

import { describe, expect, test } from 'bun:test'
import {
  decodeWrapperProgress,
  encodeWrapperProgress,
  type WrapperProgress,
} from '../src/modules/task-execution/domain/wrapperProgress'

function warnSink(): { calls: string[]; warn: (msg: string) => void } {
  const calls: string[] = []
  return { calls, warn: (msg) => calls.push(msg) }
}

describe('wrapperProgress encode/decode', () => {
  test('round-trips a loop-kind payload', () => {
    const progress: WrapperProgress = { kind: 'loop', iteration: 3, phase: 'awaiting' }
    const encoded = encodeWrapperProgress(progress)
    const sink = warnSink()
    const decoded = decodeWrapperProgress(encoded, sink.warn)
    expect(decoded).toEqual(progress)
    expect(sink.calls.length).toBe(0)
  })

  test('round-trips a git-kind payload', () => {
    const progress: WrapperProgress = {
      kind: 'git',
      baseline: 'a1b2c3d4e5f6',
      phase: 'awaiting',
    }
    const encoded = encodeWrapperProgress(progress)
    const sink = warnSink()
    const decoded = decodeWrapperProgress(encoded, sink.warn)
    expect(decoded).toEqual(progress)
    expect(sink.calls.length).toBe(0)
  })

  test('decode null / empty string returns null without warning', () => {
    const sink = warnSink()
    expect(decodeWrapperProgress(null, sink.warn)).toBeNull()
    expect(decodeWrapperProgress(undefined, sink.warn)).toBeNull()
    expect(decodeWrapperProgress('', sink.warn)).toBeNull()
    expect(sink.calls.length).toBe(0)
  })

  test('decode invalid JSON returns null and warns once', () => {
    const sink = warnSink()
    const decoded = decodeWrapperProgress('{not json', sink.warn)
    expect(decoded).toBeNull()
    expect(sink.calls.length).toBe(1)
    expect(sink.calls[0]).toContain('[rfc040]')
    expect(sink.calls[0]).toContain('invalid JSON')
  })

  test('decode shape mismatch returns null and warns once', () => {
    const sink = warnSink()
    const decoded = decodeWrapperProgress(
      JSON.stringify({ kind: 'unknown-kind', phase: 'awaiting' }),
      sink.warn,
    )
    expect(decoded).toBeNull()
    expect(sink.calls.length).toBe(1)
    expect(sink.calls[0]).toContain('[rfc040]')
    expect(sink.calls[0]).toContain('shape mismatch')
  })

  test('decode preserves passthrough fields (forward-compat)', () => {
    const raw = JSON.stringify({
      kind: 'loop',
      iteration: 0,
      phase: 'awaiting',
      futureField: { nested: [1, 2, 3] },
    })
    const sink = warnSink()
    const decoded = decodeWrapperProgress(raw, sink.warn) as WrapperProgress & {
      futureField?: unknown
    }
    expect(decoded).not.toBeNull()
    expect(decoded?.kind).toBe('loop')
    expect(decoded?.iteration).toBe(0)
    expect(decoded?.futureField).toEqual({ nested: [1, 2, 3] })
    expect(sink.calls.length).toBe(0)
  })

  test('iter-done phase encodes/decodes', () => {
    const p: WrapperProgress = { kind: 'loop', iteration: 5, phase: 'iter-done' }
    const sink = warnSink()
    expect(decodeWrapperProgress(encodeWrapperProgress(p), sink.warn)).toEqual(p)
  })
})
