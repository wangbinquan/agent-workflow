// RFC-061 PR-B — registry exhaustiveness tests.
//
// These tests enforce the structural contract from design.md §5:
// the NODE_KIND_HANDLERS / SIGNAL_KIND_HANDLERS Records contain
// EXACTLY one entry per closed union member (compile-time enforced
// by `satisfies Record<...>`, runtime double-locked here).
//
// Together with the property tests in PR-A (rfc061-property.test.ts)
// these are the structural guarantees that prevent the
// "5 dispatchers each pick the current row" pattern from coming back.

import { describe, expect, test } from 'bun:test'

import { NODE_KIND_HANDLERS } from '../src/handlers/nodeKind'
import { SIGNAL_KIND_HANDLERS } from '../src/handlers/signalKind'
import { EVENT_KINDS, SIGNAL_KINDS, NODE_KIND } from '@agent-workflow/shared'

describe('NODE_KIND_HANDLERS exhaustiveness', () => {
  test('has one entry per NodeKind in the closed union', () => {
    const registered = Object.keys(NODE_KIND_HANDLERS).sort()
    const expected = [...NODE_KIND].sort()
    expect(registered).toEqual(expected)
  })

  test('each registered handler reports its own kind', () => {
    for (const [k, h] of Object.entries(NODE_KIND_HANDLERS)) {
      expect((h as { kind: string }).kind).toBe(k)
    }
  })

  test('each handler defines dispatch + onAttemptFinished', () => {
    for (const h of Object.values(NODE_KIND_HANDLERS)) {
      expect(typeof (h as { dispatch: unknown }).dispatch).toBe('function')
      expect(typeof (h as { onAttemptFinished: unknown }).onAttemptFinished).toBe('function')
    }
  })

  test('wrapper-* handlers define onInnerScopeCompleted', () => {
    const wrappers: Array<keyof typeof NODE_KIND_HANDLERS> = [
      'wrapper-git',
      'wrapper-loop',
      'wrapper-fanout',
    ]
    for (const k of wrappers) {
      expect(typeof NODE_KIND_HANDLERS[k].onInnerScopeCompleted).toBe('function')
    }
  })
})

describe('SIGNAL_KIND_HANDLERS exhaustiveness', () => {
  test('has one entry per SignalKind in the closed union', () => {
    const registered = Object.keys(SIGNAL_KIND_HANDLERS).sort()
    const expected = [...SIGNAL_KINDS].sort()
    expect(registered).toEqual(expected)
  })

  test('each registered handler reports its own kind', () => {
    for (const [k, h] of Object.entries(SIGNAL_KIND_HANDLERS)) {
      expect((h as { kind: string }).kind).toBe(k)
    }
  })

  test('each handler defines the 5 required methods', () => {
    const required = [
      'onSuspend',
      'validateResolution',
      'applyResolution',
      'effectOnLogicalRun',
      'renderPromptSection',
    ] as const
    for (const h of Object.values(SIGNAL_KIND_HANDLERS)) {
      for (const m of required) {
        expect(typeof (h as unknown as Record<string, unknown>)[m]).toBe('function')
      }
    }
  })

  test('retry-pending-auto exposes optional autoResolve', () => {
    expect(typeof SIGNAL_KIND_HANDLERS['retry-pending-auto'].autoResolve).toBe('function')
  })

  test('user-driven signals do NOT auto-resolve', () => {
    const userDriven: Array<keyof typeof SIGNAL_KIND_HANDLERS> = [
      'self-clarify',
      'cross-clarify',
      'review',
      'retry-pending-human',
    ]
    for (const k of userDriven) {
      expect(SIGNAL_KIND_HANDLERS[k].autoResolve).toBeUndefined()
    }
  })
})

describe('EventKind closed union (cross-check vs PR-A schema)', () => {
  test('26 kinds present (7 task + 4 logical-run + 10 attempt + 3 suspension + 2 invariant)', () => {
    // 10 attempt-* kinds: started, finished-success/envelope-fail/crash/
    // timeout, canceled, output-captured, subagent-tool-use, subagent-
    // output, token-usage (RFC-061 follow-up).
    expect(EVENT_KINDS.length).toBe(26)
  })
})
