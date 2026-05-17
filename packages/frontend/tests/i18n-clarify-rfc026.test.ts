// RFC-026 PR-B T10 — i18n completeness for the new clarify session-mode keys.
//
// Two contracts:
//   1. Every key path RFC-026 added (inspector segmented, eventStream
//      info/warning, node chip) is present in BOTH locales with the same path.
//   2. The existing `i18n-clarify.test.ts` mirror test (RFC-023 PR-C) keeps
//      passing — the additive nature of RFC-026 means flattening the whole
//      `clarify` subtree still produces equal sets.
//
// If this goes red, a Frontend surface added by RFC-026 will render a raw
// i18n key — UX-visible regression.

import { describe, expect, it } from 'vitest'
import { zhCN } from '../src/i18n/zh-CN'
import { enUS } from '../src/i18n/en-US'

describe('RFC-026 i18n — inspector segmented sessionMode', () => {
  it('zh-CN exposes the four sessionMode keys with non-empty values', () => {
    expect(zhCN.inspector.fieldClarifySessionMode.length).toBeGreaterThan(0)
    expect(zhCN.inspector.clarifySessionModeIsolated.length).toBeGreaterThan(0)
    expect(zhCN.inspector.clarifySessionModeInline.length).toBeGreaterThan(0)
    expect(zhCN.inspector.clarifySessionModeHint.length).toBeGreaterThan(0)
  })

  it('en-US exposes the four sessionMode keys with non-empty values', () => {
    expect(enUS.inspector.fieldClarifySessionMode.length).toBeGreaterThan(0)
    expect(enUS.inspector.clarifySessionModeIsolated.length).toBeGreaterThan(0)
    expect(enUS.inspector.clarifySessionModeInline.length).toBeGreaterThan(0)
    expect(enUS.inspector.clarifySessionModeHint.length).toBeGreaterThan(0)
  })
})

describe('RFC-026 i18n — eventStream + node chip', () => {
  it('zh-CN exposes eventStream + node.chip.inline', () => {
    expect(zhCN.clarify.eventStream.sessionResumed).toContain('{{prefix}}')
    expect(zhCN.clarify.eventStream.sessionResumed).toContain('{{n}}')
    expect(zhCN.clarify.eventStream.fallbackToIsolated).toContain('{{reason}}')
    expect(zhCN.clarify.node.chip.inline.length).toBeGreaterThan(0)
  })

  it('en-US exposes eventStream + node.chip.inline with the same placeholders', () => {
    expect(enUS.clarify.eventStream.sessionResumed).toContain('{{prefix}}')
    expect(enUS.clarify.eventStream.sessionResumed).toContain('{{n}}')
    expect(enUS.clarify.eventStream.fallbackToIsolated).toContain('{{reason}}')
    expect(enUS.clarify.node.chip.inline.length).toBeGreaterThan(0)
  })

  // The two locales must use the same placeholder set per key — t() calls
  // pass the same interpolation object regardless of active language.
  it('placeholder names match between zh-CN and en-US for both keys', () => {
    const re = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g
    const ph = (s: string): string[] => {
      const out: string[] = []
      let m: RegExpExecArray | null
      const r = new RegExp(re.source, 'g')
      while ((m = r.exec(s)) !== null) out.push(m[1]!)
      return [...new Set(out)].sort()
    }
    expect(ph(zhCN.clarify.eventStream.sessionResumed)).toEqual(
      ph(enUS.clarify.eventStream.sessionResumed),
    )
    expect(ph(zhCN.clarify.eventStream.fallbackToIsolated)).toEqual(
      ph(enUS.clarify.eventStream.fallbackToIsolated),
    )
  })
})
