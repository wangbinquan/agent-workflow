// RFC-120 — locks `deriveQuestionPhase`: the pure mapping from (round status,
// confirmation overlay, staged flag, resolved handler run) to the displayed
// kanban phase.
//
// v2 (2026-06-28 design discussion): 「下发」(minting the handler rerun) is the
// pending/staged → processing boundary — once a handler run EXISTS the entry is
// 处理中 (dispatched), regardless of whether the run has started. design §11.2/11.6.
//
// Intent of each lock (so a future refactor that reddens it sees why):
//   * RFC-126: 'closed' removed — canceled/abandoned no longer special-cased here
//     (reconcile skips them; migration un-abandons legacy abandoned rows).
//   * confirmation === 'confirmed' → 'done' (the only manual terminal).
//   * NOT dispatched (no handler run) + isStaged → 'staged' (待下发, approved
//     awaiting batch dispatch); NOT dispatched + not staged → 'pending' (待指派).
//   * **dispatched (handler run present) → 'processing' even when the run is
//     still queued (status 'pending', no startedAt)** — dispatch is the boundary,
//     not run start. This is the v2 change from the original startedAt-based rule.
//   * staged is ONLY a pre-dispatch state — once dispatched, processing wins.
//   * **handler 'failed' → 'processing'** (decision D3: failure stays 处理中).
//   * handler 'done' WITH output → 'awaiting_confirm'; done WITHOUT output →
//     'processing' (defensive).

import { describe, expect, test } from 'bun:test'
import {
  deriveQuestionPhase,
  type DeriveQuestionPhaseInput,
  type HandlerRunView,
} from '../src/task-questions'

const input = (over: Partial<DeriveQuestionPhaseInput>): DeriveQuestionPhaseInput => ({
  roundStatus: 'answered',
  confirmation: 'open',
  isStaged: false,
  dispatchedInFlight: false,
  handlerRun: null,
  ...over,
})

const handler = (over: Partial<HandlerRunView> = {}): HandlerRunView => ({
  status: 'running',
  startedAt: 1,
  hasOutput: false,
  ...over,
})

describe('deriveQuestionPhase (v2)', () => {
  // RFC-126: 'closed' phase removed. deriveQuestionPhase no longer special-cases
  // canceled/abandoned — they derive from confirmation/handler-run/staged like any
  // round. (In practice they never reach here: reconcile skips canceled/abandoned
  // rounds, and migration 0066 un-abandons legacy 'abandoned' rows.)
  test('RFC-126: canceled/abandoned no longer force a terminal — derive from the rest', () => {
    // canceled + confirmed + done-with-output → falls through → 'done' (was 'closed')
    expect(
      deriveQuestionPhase(
        input({
          roundStatus: 'canceled',
          confirmation: 'confirmed',
          handlerRun: handler({ status: 'done', hasOutput: true }),
        }),
      ),
    ).toBe('done')
    // abandoned + nothing else → 'pending' (was 'closed')
    expect(deriveQuestionPhase(input({ roundStatus: 'abandoned' }))).toBe('pending')
  })

  test('confirmed → done', () => {
    expect(
      deriveQuestionPhase(
        input({
          confirmation: 'confirmed',
          handlerRun: handler({ status: 'done', hasOutput: true }),
        }),
      ),
    ).toBe('done')
  })

  test('not dispatched + not staged → pending (待指派)', () => {
    expect(deriveQuestionPhase(input({ handlerRun: null, isStaged: false }))).toBe('pending')
  })

  test('not dispatched + staged → staged (待下发)', () => {
    expect(deriveQuestionPhase(input({ handlerRun: null, isStaged: true }))).toBe('staged')
  })

  test('dispatched in-flight (answered, handler running, no done-stamp yet) → processing', () => {
    // Codex impl gate F1: don't guess a run — show processing without binding.
    expect(deriveQuestionPhase(input({ handlerRun: null, dispatchedInFlight: true }))).toBe(
      'processing',
    )
  })

  test('dispatchedInFlight is overridden by an authoritative handler run', () => {
    expect(
      deriveQuestionPhase(
        input({
          dispatchedInFlight: true,
          handlerRun: handler({ status: 'done', hasOutput: true }),
        }),
      ),
    ).toBe('awaiting_confirm')
  })

  test('staged is pre-dispatch only — once dispatched, processing wins', () => {
    expect(
      deriveQuestionPhase(input({ isStaged: true, handlerRun: handler({ status: 'running' }) })),
    ).toBe('processing')
  })

  test('v2: dispatched but still queued (run pending, no startedAt) → processing', () => {
    expect(
      deriveQuestionPhase(input({ handlerRun: handler({ status: 'pending', startedAt: null }) })),
    ).toBe('processing')
  })

  test('handler running → processing', () => {
    expect(deriveQuestionPhase(input({ handlerRun: handler({ status: 'running' }) }))).toBe(
      'processing',
    )
  })

  test('handler failed → processing (D3: failure stays 处理中)', () => {
    expect(
      deriveQuestionPhase(input({ handlerRun: handler({ status: 'failed', startedAt: 5 }) })),
    ).toBe('processing')
  })

  test('handler done + output → awaiting_confirm', () => {
    expect(
      deriveQuestionPhase(input({ handlerRun: handler({ status: 'done', hasOutput: true }) })),
    ).toBe('awaiting_confirm')
  })

  test('handler done WITHOUT output → processing (defensive)', () => {
    expect(
      deriveQuestionPhase(input({ handlerRun: handler({ status: 'done', hasOutput: false }) })),
    ).toBe('processing')
  })
})

// RFC-128 §2 — partial is a PURE DERIVED state: within ONE still-awaiting_human round,
// different questions sit in different phases (one sealed+dispatched → processing, a
// sibling still unsealed/undispatched → pending). deriveQuestionPhase is per-entry, so
// it expresses this naturally with NO new DB 'partial' status (protecting RFC-126's
// "a round is either answered or not" invariant). This locks that the function never
// keys phase off the round being wholly answered — only off the entry's own handler
// state — so a partial round yields a heterogeneous board.
describe('deriveQuestionPhase — RFC-128 同轮逐题不同相位 (partial = derived)', () => {
  test('same awaiting_human round: a dispatched Q1 reads processing while an unsealed Q2 reads pending', () => {
    // Q1: control channel sealed it + dispatched the handler (in flight).
    const q1 = deriveQuestionPhase(
      input({ roundStatus: 'awaiting_human', dispatchedInFlight: true, handlerRun: null }),
    )
    // Q2: still unsealed, never dispatched.
    const q2 = deriveQuestionPhase(
      input({ roundStatus: 'awaiting_human', dispatchedInFlight: false, handlerRun: null }),
    )
    expect(q1).toBe('processing')
    expect(q2).toBe('pending')
    expect(q1).not.toBe(q2) // heterogeneous within one (un-answered) round
  })

  test('and a third Q3 already done+output reads awaiting_confirm in the SAME round', () => {
    const q3 = deriveQuestionPhase(
      input({
        roundStatus: 'awaiting_human',
        handlerRun: handler({ status: 'done', hasOutput: true }),
      }),
    )
    expect(q3).toBe('awaiting_confirm')
  })
})
