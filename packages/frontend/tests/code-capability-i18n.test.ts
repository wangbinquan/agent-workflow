// Every capability the platform ships must have a readable name in both
// locales, because the configuration UI is where an operator picks one.
//
// The `/code` matrix used to render `{row.capability}` raw — an operator
// configuring "issue → MR" had to know that is spelled `requirement`, and that
// `mr-comment-fix` is the one that answers review comments. Machine ids are a
// fine wire format and a poor label.
//
// Same guard shape as `webhook-event-i18n.test.ts`, for the same reason: the
// list is derived from a registry, so the registry growing must force the copy
// to grow with it. That is precisely the drift that left `issue_labeled`
// rendering as a raw key in the webhook trigger editor.

import { describe, expect, test } from 'vitest'
import i18n, { setLanguage } from '@/i18n'

/**
 * The shipped capabilities.
 *
 * Restated here rather than imported because `CODE_CAPABILITIES` lives in the
 * backend module (the frontend learns them from `/api/code/capabilities` at
 * runtime). The backend's own `rfc304-capability-catalog.test.ts` pins the
 * catalog against that registry, so a capability added there and forgotten here
 * fails on this list being short — which is the failure we want.
 */
const CAPABILITIES = ['mr-review', 'mr-comment-fix', 'requirement', 'ci-fix', 'mr-monitor'] as const

describe('code capability i18n', () => {
  test('every capability has a non-empty zh-CN + en-US name', () => {
    for (const lang of ['zh-CN', 'en-US'] as const) {
      setLanguage(lang)
      for (const capability of CAPABILITIES) {
        const key = `code.capability.${capability}`
        const label = i18n.t(key)
        expect(label, `${lang}:${key}`).not.toBe(key)
        expect(label.trim().length, `${lang}:${key} is blank`).toBeGreaterThan(0)
      }
    }
  })

  test('the names say what the capability DOES, not what it is called internally', () => {
    // The point of the exercise. "requirement" tells an operator nothing; the
    // label has to carry the flow, because choosing the wrong capability is a
    // mistake they only discover when nothing happens on their merge request.
    setLanguage('zh-CN')
    expect(i18n.t('code.capability.requirement')).toContain('issue')
    setLanguage('en-US')
    expect(i18n.t('code.capability.requirement')).toContain('issue')
  })

  test('the binding picker explains why an unset one is not a valid resting state', () => {
    // A capability with no binding can never become `ready`. An empty selector
    // that looked like a neutral default is how somebody switches a capability
    // on, sees no error, and waits for a review that can never run.
    for (const lang of ['zh-CN', 'en-US'] as const) {
      setLanguage(lang)
      for (const key of ['code.bindingLabel', 'code.bindingHint', 'code.bindingNone']) {
        expect(i18n.t(key), `${lang}:${key}`).not.toBe(key)
      }
    }
  })
})
