// 2026-07-21 —— awaiting_human 成因说明卡的前端侧回归锁（配套 backend
// wg-readonly-claim-and-pause-reason.test.ts）。
//
// 背景（用户实报困惑）：任务停在 max-rounds wrap-up（预算触顶、产出在手、
// 没有问题要答）时，任务徽章渲染「等待回答」——用户以为有问题在等他。
// 修法两段：① tasks.status.awaiting_human 文案中性化（等待人工 / Awaiting
// human，task-status-i18n.test.ts 锁）；② 房间在认识成因时渲染精确说明卡，
// 映射函数 pauseReasonCopyKey 与五个成因的双语文案在此锁定。
//
// 若这文件变红：要么引擎新增/改名了 pause reason（wake 的 outcome.reason 枚举）
// 而映射没跟上——补映射 + 双语文案；要么有人删了 i18n 键——找回。未知 reason
// 必须落 null（前向兼容：旧前端遇到新 daemon 的新成因时静默回退到中性徽章，
// 绝不渲染裸 key）。

import { describe, expect, test } from 'vitest'
import i18n, { setLanguage } from '@/i18n'
import { pauseReasonCopyKey } from '@/lib/workgroup-room'

const KNOWN: Record<string, string> = {
  'max-rounds-wrapup': 'workgroups.room.pause.maxRoundsWrapup',
  'leader-idle': 'workgroups.room.pause.leaderIdle',
  'leader-clarify': 'workgroups.room.pause.leaderClarify',
  'clarify-or-delivery': 'workgroups.room.pause.clarifyOrDelivery',
  'engine-stall': 'workgroups.room.pause.engineStall',
}

describe('pauseReasonCopyKey', () => {
  test('五个已知成因映射到 workgroups.room.pause.* 键', () => {
    for (const [reason, key] of Object.entries(KNOWN)) {
      expect(pauseReasonCopyKey(reason), reason).toBe(key)
    }
  })

  test('未知 / null / undefined ⇒ null（前向兼容回退到中性徽章）', () => {
    expect(pauseReasonCopyKey('some-future-reason')).toBeNull()
    expect(pauseReasonCopyKey(null)).toBeNull()
    expect(pauseReasonCopyKey(undefined)).toBeNull()
    expect(pauseReasonCopyKey('')).toBeNull()
  })

  test('每个映射键都有非空双语文案（含标题键），不渲染裸 key', () => {
    for (const lang of ['zh-CN', 'en-US'] as const) {
      setLanguage(lang)
      for (const key of [...Object.values(KNOWN), 'workgroups.room.pauseTitle']) {
        const label = i18n.t(key)
        expect(label, `${lang}:${key}`).not.toBe(key)
        expect(label.length, `${lang}:${key}`).toBeGreaterThan(0)
      }
    }
    setLanguage('zh-CN')
  })

  test('wrap-up 文案不得再要求用户「回答」（锁住本次修的语义）', () => {
    setLanguage('zh-CN')
    const zh = i18n.t(KNOWN['max-rounds-wrapup'] as string)
    expect(zh).toContain('没有问题在等你回答')
    setLanguage('en-US')
    const en = i18n.t(KNOWN['max-rounds-wrapup'] as string)
    expect(en).toContain('Nothing is waiting for an answer')
    setLanguage('zh-CN')
  })
})
