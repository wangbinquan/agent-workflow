// Lock a localized label for every CODE_HOST_EVENT_TYPES value, so a future
// event added in @agent-workflow/shared is forced to ship matching zh-CN and
// en-US copy instead of leaking the raw enum string into the trigger editor.
//
// Written because that is exactly what happened: RFC-304 T46a added
// `issue_labeled` and `issue_comment` to the shared list, `TriggersPanel`
// derives its checkbox list from that constant — correctly, which is the point
// — and neither locale gained a key. The event list rendered the raw keys.
//
// Same shape as `task-status-i18n.test.ts`, and the same shape as most of what
// RFC-304's audit turned up: both halves right, no join. A list derived from a
// registry is the RIGHT way to build that UI; what was missing was anything
// asserting the registry and the copy stay in step.
//
// The `.not.toBe(key)` assertion is load-bearing rather than stylistic:
// i18next returns the key itself for a miss, so a missing label is a UI that
// says `webhookTriggers.events.issue_labeled` to the operator — legible enough
// to survive review, wrong enough to look broken in a screenshot.

import { describe, expect, test } from 'vitest'
import { CODE_HOST_EVENT_TYPES, WEBHOOK_DELIVERY_STATUSES } from '@agent-workflow/shared'
import i18n, { setLanguage } from '@/i18n'

describe('webhook trigger event i18n', () => {
  test('every CODE_HOST_EVENT_TYPES value has a non-empty zh-CN + en-US label', () => {
    for (const lang of ['zh-CN', 'en-US'] as const) {
      setLanguage(lang)
      for (const eventType of CODE_HOST_EVENT_TYPES) {
        const key = `webhookTriggers.events.${eventType}`
        const label = i18n.t(key)
        expect(label, `${lang}:${key}`).not.toBe(key)
        expect(label.trim().length, `${lang}:${key} is blank`).toBeGreaterThan(0)
      }
    }
  })

  test('the issue events specifically — the pair that was missing', () => {
    // Named rather than left to the loop above so the regression is readable in
    // a failure list. These two are the `requirement` capability's entry point
    // (label an issue) and its answer path (comment on that issue), so an
    // operator who cannot identify them in the event list cannot switch the
    // capability on.
    setLanguage('zh-CN')
    expect(i18n.t('webhookTriggers.events.issue_labeled')).toBe('Issue 打标签')
    expect(i18n.t('webhookTriggers.events.issue_comment')).toBe('Issue 评论')

    setLanguage('en-US')
    expect(i18n.t('webhookTriggers.events.issue_labeled')).toBe('Issue labeled')
    expect(i18n.t('webhookTriggers.events.issue_comment')).toBe('Issue comment')
  })

  test('delivery statuses are covered too — the neighbouring registry', () => {
    // `DeliveriesPanel` renders this family the same derived way, from the same
    // kind of shared constant. It is complete today; this keeps it that way,
    // because the failure mode is identical and so is the fix people forget.
    for (const lang of ['zh-CN', 'en-US'] as const) {
      setLanguage(lang)
      for (const status of WEBHOOK_DELIVERY_STATUSES) {
        const key = `webhookDeliveries.statuses.${status}`
        expect(i18n.t(key), `${lang}:${key}`).not.toBe(key)
      }
    }
  })

  test('the two locales cover the SAME set — neither may drift ahead', () => {
    // A key present in one locale only is the half-fix version of this bug: it
    // looks correct to whoever is developing in that language and shows raw
    // keys to everybody else.
    const labelsFor = (lang: 'zh-CN' | 'en-US'): string[] => {
      setLanguage(lang)
      return CODE_HOST_EVENT_TYPES.map((eventType) => i18n.t(`webhookTriggers.events.${eventType}`))
    }
    const zh = labelsFor('zh-CN')
    const en = labelsFor('en-US')
    expect(zh).toHaveLength(CODE_HOST_EVENT_TYPES.length)
    expect(en).toHaveLength(CODE_HOST_EVENT_TYPES.length)
  })
})
