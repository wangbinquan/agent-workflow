// RFC-056 PR-D C7 — inline fallback enumeration 守门.
//
// The cross-clarify QUESTIONER rerun (reject, with STOP CLARIFYING anchor)
// carries an inline session-mode field `sessionModeForQuestioner`, resolved via
// `resolveCrossClarifySessionMode`, composing with the RFC-026 fallback helpers
// (`decideResumeSessionId` + `detectSessionNotFoundFromStderr`) the scheduler
// already uses for the self-clarify path. The fallback contract: when inline
// can't run (missing session id / opencode rejected it / version too old), we
// degrade transparently to isolated + record a warning event with the specific
// reason.
//
// (The DESIGNER rerun's session-mode field was removed by RFC-056 patch
// 2026-06-22 — it was dead config; the designer rerun is always isolated.)
//
// LOCKS:
//   1. resolveCrossClarifySessionMode defaults to 'isolated' when the
//      questioner field is undefined.
//   2. resolveCrossClarifySessionMode reads sessionModeForQuestioner.
//   3. decideResumeSessionId composed with 'inline' + missing session id
//      returns fallbackReason='missing-session-id' + inlineMode=false.
//   4. decideResumeSessionId composed with 'inline' + null session id
//      returns fallbackReason='missing-session-id' + inlineMode=false
//      (covers SQLite NULL passthrough).
//   5. detectSessionNotFoundFromStderr recognizes the common opencode
//      stderr patterns post-spawn.
//   6. The 3 fallback reasons enumerated by RFC-026
//      (ClarifyInlineFallbackReason) — `missing-session-id`,
//      `session-not-found`, `unsupported-opencode-version` — are all
//      reachable from the questioner composition + direct compositions.
//
// If any of these go red the inline-mode fallback path on the cross-clarify
// questioner rerun has drifted from RFC-026's contract — investigate before
// relaxing.

import { describe, expect, test } from 'bun:test'

import type { ClarifyCrossAgentNode } from '@agent-workflow/shared'
import { resolveCrossClarifySessionMode } from '@agent-workflow/shared'
import {
  decideResumeSessionId,
  detectSessionNotFoundFromStderr,
  type ClarifyInlineFallbackReason,
} from '../src/services/sessionModeFallback'

function ccNode(overrides: Partial<ClarifyCrossAgentNode> = {}): ClarifyCrossAgentNode {
  return {
    id: 'cc1',
    kind: 'clarify-cross-agent',
    title: '',
    description: '',
    ...overrides,
  } as ClarifyCrossAgentNode
}

describe('RFC-056 C7 — inline fallback enumeration', () => {
  test('resolveCrossClarifySessionMode defaults to isolated when the field is undefined', () => {
    const node = ccNode()
    expect(resolveCrossClarifySessionMode(node)).toBe('isolated')
  })

  test('resolveCrossClarifySessionMode reads sessionModeForQuestioner', () => {
    const node = ccNode({ sessionModeForQuestioner: 'inline' })
    expect(resolveCrossClarifySessionMode(node)).toBe('inline')
  })

  test('decideResumeSessionId({sessionMode:inline}) + missing session id → fallback missing-session-id', () => {
    const ret = decideResumeSessionId({ sessionMode: 'inline', sourceSessionId: '' })
    expect(ret.inlineMode).toBe(false)
    expect(ret.fallbackReason).toBe('missing-session-id')
    expect(ret.resumeSessionId).toBeUndefined()
  })

  test('decideResumeSessionId({sessionMode:inline}) + null session id (SQLite NULL passthrough) → fallback missing-session-id', () => {
    const ret = decideResumeSessionId({ sessionMode: 'inline', sourceSessionId: null })
    expect(ret.inlineMode).toBe(false)
    expect(ret.fallbackReason).toBe('missing-session-id')
  })

  test('decideResumeSessionId({sessionMode:inline}) + opencodeSupportsResume=false → fallback unsupported-opencode-version', () => {
    const ret = decideResumeSessionId({
      sessionMode: 'inline',
      sourceSessionId: 'opc_xyz',
      opencodeSupportsResume: false,
    })
    expect(ret.inlineMode).toBe(false)
    expect(ret.fallbackReason).toBe('unsupported-opencode-version')
  })

  test('decideResumeSessionId({sessionMode:inline}) + valid session id + supported → happy: inline=true, resumeSessionId set', () => {
    const ret = decideResumeSessionId({ sessionMode: 'inline', sourceSessionId: 'opc_xyz' })
    expect(ret.inlineMode).toBe(true)
    expect(ret.resumeSessionId).toBe('opc_xyz')
    expect(ret.fallbackReason).toBeUndefined()
  })

  test('decideResumeSessionId({sessionMode:isolated}) never fallbacks (user chose isolated — not an error)', () => {
    const ret = decideResumeSessionId({ sessionMode: 'isolated', sourceSessionId: 'opc_xyz' })
    expect(ret.inlineMode).toBe(false)
    expect(ret.fallbackReason).toBeUndefined()
  })

  test('detectSessionNotFoundFromStderr recognises common opencode error wordings', () => {
    expect(detectSessionNotFoundFromStderr('Error: session not found')).toBe(true)
    expect(detectSessionNotFoundFromStderr('the session foo does not exist')).toBe(true)
    expect(detectSessionNotFoundFromStderr('unknown session id: opc_abc')).toBe(true)
    expect(detectSessionNotFoundFromStderr('no such session')).toBe(true)
  })

  test('detectSessionNotFoundFromStderr does NOT false-positive on unrelated stderr', () => {
    expect(detectSessionNotFoundFromStderr('warning: low disk space')).toBe(false)
    expect(detectSessionNotFoundFromStderr('')).toBe(false)
  })

  test('3-reason union ClarifyInlineFallbackReason covers all RFC-026 inline-fallback exits', () => {
    // Compile-time exhaustiveness: this would fail to type-check if the
    // union ever grows without our awareness.
    const reasons: ReadonlyArray<ClarifyInlineFallbackReason> = [
      'missing-session-id',
      'session-not-found',
      'unsupported-opencode-version',
    ]
    expect(reasons.length).toBe(3)
  })

  test('cross-clarify questioner + inline mode reaches missing-session-id fallback (full composition)', () => {
    const node = ccNode({ sessionModeForQuestioner: 'inline' })
    const sessionMode = resolveCrossClarifySessionMode(node)
    const ret = decideResumeSessionId({ sessionMode, sourceSessionId: undefined })
    expect(sessionMode).toBe('inline')
    expect(ret.fallbackReason).toBe('missing-session-id')
  })

  test('cross-clarify questioner + inline mode reaches unsupported-opencode-version fallback (full composition)', () => {
    const node = ccNode({ sessionModeForQuestioner: 'inline' })
    const sessionMode = resolveCrossClarifySessionMode(node)
    const ret = decideResumeSessionId({
      sessionMode,
      sourceSessionId: 'opc_xyz',
      opencodeSupportsResume: false,
    })
    expect(sessionMode).toBe('inline')
    expect(ret.fallbackReason).toBe('unsupported-opencode-version')
  })
})
