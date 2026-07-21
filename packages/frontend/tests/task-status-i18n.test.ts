// Lock in localized labels for every TaskStatus value, so future status
// additions in @agent-workflow/shared are forced to ship a matching i18n
// entry in both zh-CN and en-US (preventing raw enum strings like
// "awaiting_human" leaking into the UI).
//
// RFC-150 PR-1 (flag-audit §4.6 W0 补做): `tasks.status.*` is now the SINGLE
// key family for TaskStatus copy — the parallel `home.taskRow.status*` family
// (drifted wording: zh「排队中/等待评审」, en lowercase) was deleted and the
// homepage <TaskRow> reads `tasks.status.*` too. The tests below ratchet the
// old keys to zero and pin the merged bilingual wording.

import { describe, expect, test } from 'vitest'
import { TASK_STATUS } from '@agent-workflow/shared'
import i18n, { setLanguage } from '@/i18n'

describe('task status i18n', () => {
  test('every TaskStatus has a non-empty zh-CN + en-US label', () => {
    for (const lang of ['zh-CN', 'en-US'] as const) {
      setLanguage(lang)
      for (const s of TASK_STATUS) {
        const label = i18n.t(`tasks.status.${s}`)
        expect(label, `${lang}:tasks.status.${s}`).not.toBe(`tasks.status.${s}`)
        expect(label.length, `${lang}:tasks.status.${s}`).toBeGreaterThan(0)
      }
    }
    setLanguage('zh-CN')
  })

  test('zh-CN labels for awaiting_* are the user-facing strings, not raw enum', () => {
    setLanguage('zh-CN')
    expect(i18n.t('tasks.status.awaiting_review')).toBe('等待审核')
    // 2026-07-21 —— 中性化（原「等待回答」）：awaiting_human 也覆盖 max-rounds
    // wrap-up（预算触顶、无问题要答），精确成因由房间 pauseReason 卡展示。
    expect(i18n.t('tasks.status.awaiting_human')).toBe('等待人工')
    expect(i18n.t('tasks.status.running')).toBe('运行中')
    setLanguage('zh-CN')
  })

  test('RFC-150 ratchet: the home.taskRow.status* key family stays deleted', () => {
    const OLD_KEYS = [
      'statusRunning',
      'statusAwaitingHuman',
      'statusAwaitingReview',
      'statusDone',
      'statusFailed',
      'statusCanceled',
      'statusInterrupted',
      'statusPending',
    ] as const
    for (const lang of ['zh-CN', 'en-US'] as const) {
      setLanguage(lang)
      for (const k of OLD_KEYS) {
        expect(
          i18n.exists(`home.taskRow.${k}`),
          `${lang}:home.taskRow.${k} must stay deleted`,
        ).toBe(false)
      }
    }
    setLanguage('zh-CN')
  })

  test('RFC-150 merged wording: homepage rows show the tasks.status.* copy verbatim', () => {
    // Deliberate user-visible unification — the homepage previously said
    // zh「排队中」/「等待评审」 and lowercase English; tasks.status.* wins.
    const EXPECT: Record<(typeof TASK_STATUS)[number], { zh: string; en: string }> = {
      pending: { zh: '待运行', en: 'Pending' },
      running: { zh: '运行中', en: 'Running' },
      done: { zh: '已完成', en: 'Done' },
      failed: { zh: '失败', en: 'Failed' },
      canceled: { zh: '已取消', en: 'Canceled' },
      interrupted: { zh: '已中断', en: 'Interrupted' },
      awaiting_review: { zh: '等待审核', en: 'Awaiting review' },
      awaiting_human: { zh: '等待人工', en: 'Awaiting human' },
    }
    setLanguage('zh-CN')
    for (const s of TASK_STATUS) {
      expect(i18n.t(`tasks.status.${s}`), `zh-CN:tasks.status.${s}`).toBe(EXPECT[s].zh)
    }
    setLanguage('en-US')
    for (const s of TASK_STATUS) {
      expect(i18n.t(`tasks.status.${s}`), `en-US:tasks.status.${s}`).toBe(EXPECT[s].en)
    }
    setLanguage('zh-CN')
  })
})
