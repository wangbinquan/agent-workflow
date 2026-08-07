// RFC-266 —— 设置页三个并发字段的接线与文案。
//
// 为什么这些测试存在：
// ① `multiProcessSubprocessConcurrency` 在设置页存在、能保存，但后端两级漏斗都
//    没搬运它，所以用户改了永远不生效。新加的 `maxConcurrentScriptNodes` 必须
//    从第一天就完整接线——前端这一侧的接线点就是 limits 组的 key 清单：**漏加
//    这一条，输入框看得见、值也进了草稿，但 PUT 的最小补丁里没有它，静默不保存**。
// ② 三个框光看标题分不清谁管谁（用户就是在这里被绊住的），因此 hint 是契约的
//    一部分：必须成对存在、双语齐全，且写明生效范围。

import { DEFAULT_CONFIG } from '@agent-workflow/shared'
import { describe, expect, test } from 'vitest'
import { SETTINGS_CONFIG_SCOPE_KEYS } from '@/lib/settings-drafts'
import { zhCN } from '@/i18n/zh-CN'
import { enUS } from '@/i18n/en-US'

describe('RFC-266 concurrency settings wiring', () => {
  test('all three concurrency keys are owned by the limits scope (minimal-patch allowlist)', () => {
    for (const key of [
      'maxConcurrentNodes',
      'maxConcurrentScriptNodes',
      'multiProcessSubprocessConcurrency',
    ] as const) {
      expect(SETTINGS_CONFIG_SCOPE_KEYS.limits).toContain(key)
    }
  })

  test('the script pool ships a default so an existing config.json backfills it', () => {
    expect(DEFAULT_CONFIG.maxConcurrentScriptNodes).toBe(4)
    // 与 agent 池同默认值：两池独立 ⇒ 峰值 = 两者之和（proposal §5 B-1）。
    expect(DEFAULT_CONFIG.maxConcurrentNodes).toBe(4)
  })

  test('each concurrency field has a label AND a hint, in both languages', () => {
    for (const key of [
      'maxConcurrentNodes',
      'maxConcurrentScriptNodes',
      'multiProcessConc',
    ] as const) {
      for (const dict of [zhCN, enUS]) {
        const form = dict.settingsForm as unknown as Record<string, string>
        expect(form[key]?.length ?? 0).toBeGreaterThan(0)
        expect(form[`${key}Hint`]?.length ?? 0).toBeGreaterThan(0)
      }
    }
  })

  test('hints state when a change takes effect — the exact question the user asked', () => {
    const zh = zhCN.settingsForm as unknown as Record<string, string>
    const en = enUS.settingsForm as unknown as Record<string, string>
    for (const key of ['maxConcurrentNodes', 'maxConcurrentScriptNodes', 'multiProcessConc']) {
      expect(zh[`${key}Hint`]).toContain('立即生效')
      expect(en[`${key}Hint`]).toContain('Applies on save')
    }
    // 独立池这条语义必须写进文案，否则「峰值翻倍」对部署者是隐形的。
    expect(zh.maxConcurrentScriptNodesHint).toContain('独立')
    expect(en.maxConcurrentScriptNodesHint).toContain('independent')
  })
})
