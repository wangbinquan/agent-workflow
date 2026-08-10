import { afterEach, describe, expect, test } from 'vitest'
import { WORKGROUP_SYSTEM_TEMPLATE_KEYS } from '@agent-workflow/shared'
import i18n from '../src/i18n'
import { enUS } from '../src/i18n/en-US'
import { zhCN } from '../src/i18n/zh-CN'
import { resolveWorkgroupMessageBody } from '../src/lib/workgroup-system-message'

afterEach(async () => {
  await i18n.changeLanguage('zh-CN')
})

describe('RFC-274 viewer-localized workgroup system messages', () => {
  test('every closed backend template key has both viewer translations', () => {
    for (const key of WORKGROUP_SYSTEM_TEMPLATE_KEYS) {
      expect(enUS.workgroups.systemMessages[key]).toBeTruthy()
      expect(zhCN.workgroups.systemMessages[key]).toBeTruthy()
    }
  })

  test('locale switch reprojects the same durable fallback without a server rewrite', async () => {
    const message = {
      bodyMd: 'workgroup hit max_rounds (7)',
      templateKey: 'maxRoundsFailed',
      templateParams: { maxRounds: 7 },
    }
    await i18n.changeLanguage('zh-CN')
    expect(resolveWorkgroupMessageBody(message, i18n.t)).toContain('达到最大轮数')
    await i18n.changeLanguage('en-US')
    expect(resolveWorkgroupMessageBody(message, i18n.t)).toContain('max_rounds')
  })

  test('unknown keys, malformed params and untemplated originals use bodyMd verbatim', () => {
    const fallback = 'durable fallback'
    expect(
      resolveWorkgroupMessageBody(
        { bodyMd: fallback, templateKey: 'futureKey', templateParams: { x: 1 } },
        i18n.t,
      ),
    ).toBe(fallback)
    expect(
      resolveWorkgroupMessageBody(
        { bodyMd: fallback, templateKey: 'maxRoundsFailed', templateParams: { maxRounds: 'bad' } },
        i18n.t,
      ),
    ).toBe(fallback)
    expect(
      resolveWorkgroupMessageBody(
        { bodyMd: fallback, templateKey: null, templateParams: null },
        i18n.t,
      ),
    ).toBe(fallback)
  })
})
