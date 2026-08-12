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
//      `session-not-found`, `session-resume-unsupported` — are all
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
  type ClarifyInlineFallbackReason,
} from '../src/services/sessionModeFallback'
import { getRuntimeDriver } from '../src/services/runtime'

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

  test('decideResumeSessionId({sessionMode:inline}) + supportsSessionResume=false → capability fallback', () => {
    const ret = decideResumeSessionId({
      sessionMode: 'inline',
      sourceSessionId: 'opc_xyz',
      supportsSessionResume: false,
    })
    expect(ret.inlineMode).toBe(false)
    expect(ret.fallbackReason).toBe('session-resume-unsupported')
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

  // RFC-284 T15 改锚：措辞判据下沉 RuntimeDriver.detectSessionNotFound?（各 CLI
  // 私有）；原四条 opencode 措辞逐条保留，另补 claude 实测采样双措辞与跨 driver
  // 互不误报。
  test('opencode driver 识别既有四类措辞；无关 stderr 不误报', () => {
    const d = getRuntimeDriver('opencode')
    expect(d.detectSessionNotFound?.('Error: session not found')).toBe(true)
    expect(d.detectSessionNotFound?.('the session foo does not exist')).toBe(true)
    expect(d.detectSessionNotFound?.('unknown session id: opc_abc')).toBe(true)
    expect(d.detectSessionNotFound?.('no such session')).toBe(true)
    expect(d.detectSessionNotFound?.('warning: low disk space')).toBe(false)
    expect(d.detectSessionNotFound?.('')).toBe(false)
  })

  test('claude driver 识别实测采样双措辞（2026-08-12 本机 CLI 采样）；跨 driver 不串', () => {
    const c = getRuntimeDriver('claude-code')
    expect(
      c.detectSessionNotFound?.(
        'No conversation found with session ID: 00000000-dead-beef-0000-000000000000',
      ),
    ).toBe(true)
    expect(
      c.detectSessionNotFound?.(
        'Error: --resume requires a valid session ID or session title when used with --print. Provided value "x" is not a UUID and does not match any session title.',
      ),
    ).toBe(true)
    expect(c.detectSessionNotFound?.('Error: session not found')).toBe(false) // opencode 措辞不归 claude
    expect(
      getRuntimeDriver('opencode').detectSessionNotFound?.(
        'No conversation found with session ID: x',
      ),
    ).toBe(false)
    expect(c.detectSessionNotFound?.('')).toBe(false)
  })

  test('3-reason union ClarifyInlineFallbackReason covers all RFC-026 inline-fallback exits', () => {
    // Compile-time exhaustiveness: this would fail to type-check if the
    // union ever grows without our awareness.
    const reasons: ReadonlyArray<ClarifyInlineFallbackReason> = [
      'missing-session-id',
      'session-not-found',
      'session-resume-unsupported',
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

  test('cross-clarify questioner + inline mode reaches session-resume-unsupported fallback', () => {
    const node = ccNode({ sessionModeForQuestioner: 'inline' })
    const sessionMode = resolveCrossClarifySessionMode(node)
    const ret = decideResumeSessionId({
      sessionMode,
      sourceSessionId: 'opc_xyz',
      supportsSessionResume: false,
    })
    expect(sessionMode).toBe('inline')
    expect(ret.fallbackReason).toBe('session-resume-unsupported')
  })
})
