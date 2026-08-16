// RFC-269/RFC-304 — every `reasonKey` in the action registry has a translation.
//
// This test exists because both halves were correct and nothing joined them.
// `packages/shared/tests/rfc304-review-actions.test.ts` asserts the registry
// SETS `reasonKey: 'useDraftNotes'`; the i18n symmetry test asserts zh and en
// agree with each other. Neither notices that the key the registry names has no
// entry in either table — so `review.draft-publish` and `review.submit` shipped
// with the specific "use this other action instead" sentence written in the RFC
// and never landed, and the inspector fell back to a generic line.
//
// The fallback is why it stayed invisible: `t(key, { defaultValue: … })` renders
// something plausible, so the screen looks finished. A missing translation with
// a sensible default is strictly harder to notice than a raw key would be.
//
// What the reader loses is the whole point of the message. "Not supported on
// this code host" reads as a gap in the platform and sends someone to look for
// a setting; the real answer is that GitHub and GitLab model reviews
// differently and a DIFFERENT action does the same job.

import { describe, expect, test } from 'vitest'
import { CODE_HOST_ACTION_DEFS } from '@agent-workflow/shared'
import { enUS as en } from '@/i18n/en-US'
import { zhCN as zh } from '@/i18n/zh-CN'

/** Every distinct `reasonKey` the registry can hand the inspector. */
function declaredReasonKeys(): string[] {
  const keys = new Set<string>()
  for (const spec of Object.values(CODE_HOST_ACTION_DEFS)) {
    for (const binding of Object.values(spec.bindings)) {
      if (binding !== undefined && 'unsupported' in binding && binding.unsupported) {
        keys.add(binding.reasonKey)
      }
    }
  }
  return [...keys].sort()
}

describe('RFC-269/RFC-304 — unsupported reasons are translated, not defaulted', () => {
  test('the scan finds reason keys at all (fails closed)', () => {
    // Without this, a registry refactor that stopped exposing `reasonKey` would
    // make every assertion below vacuously pass.
    expect(declaredReasonKeys().length).toBeGreaterThanOrEqual(3)
  })

  test('every declared reason key exists in BOTH locales and is non-empty', () => {
    const missing: string[] = []
    for (const key of declaredReasonKeys()) {
      const enText = (en.codeHostUnsupported as Record<string, string | undefined>)[key]
      const zhText = (zh.codeHostUnsupported as Record<string, string | undefined>)[key]
      if (enText === undefined || enText.trim() === '') missing.push(`en-US: ${key}`)
      if (zhText === undefined || zhText.trim() === '') missing.push(`zh-CN: ${key}`)
    }
    expect(missing).toEqual([])
  })

  test('a reason names the action to use instead, rather than only refusing', () => {
    // The specific value of these strings. A reason that only says "not
    // supported" is worse than the generic fallback it replaces, because it
    // costs a translation and tells the reader nothing new.
    const en1 = en.codeHostUnsupported.singleRequestReview
    const en2 = en.codeHostUnsupported.useDraftNotes
    expect(en1.toLowerCase()).toContain('use')
    expect(en2.toLowerCase()).toContain('use')
    // …and each points at the OTHER host's mechanism, which is the fact that
    // makes the refusal actionable.
    expect(en1.toLowerCase()).toContain('review')
    expect(en2.toLowerCase()).toContain('draft')
  })

  test('no locale defines a reason the registry never names', () => {
    // The other direction: a stale entry is a translation somebody maintains
    // for a message that can no longer appear.
    const declared = new Set(declaredReasonKeys())
    for (const key of Object.keys(en.codeHostUnsupported)) {
      expect(declared.has(key), `en-US defines '${key}', which no action declares`).toBe(true)
    }
  })
})
