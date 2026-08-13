// RFC-287 T10（G4）—— 并发/配额六项在设置页的**覆盖防漏锁**。
//
// 起因：这六项里此前只有三项露在设置页，另外三项只能改配置文件。补齐后必须有一条
// 锁盯住它——新增一项配额却忘了上页面，用户能感知到的症状是「这个数改不了」，没有
// 任何报错；忘了登记进 `SETTINGS_CONFIG_SCOPE_KEYS.limits`（最小写入白名单）则更
// 隐蔽：表单能改、能点保存、不报错，值却被静默丢掉。
//
// 用源码文本断言而非渲染断言，是因为要锁的是「六项**都**在」这个集合性质；渲染
// 断言只能逐项查在不在，漏掉新项时它自己也不会红。

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SETTINGS_CONFIG_SCOPE_KEYS } from '../src/lib/settings-drafts'

/** daemon 级并发/配额的全部六项（新增一项就往这里加，三处会一起红）。 */
const QUOTA_SETTINGS = [
  'maxConcurrentNodes',
  'maxConcurrentScriptNodes',
  'multiProcessSubprocessConcurrency',
  'maxConcurrentCodeHostCalls',
  'maxActiveChildTasks',
  'maxInvocationDepth',
] as const

const SETTINGS_PAGE = readFileSync(
  resolve(import.meta.dirname, '..', 'src/routes/settings.tsx'),
  'utf8',
)

describe('RFC-287 T10 — 六项配额的设置页覆盖', () => {
  test('每一项都在设置页有输入框', () => {
    for (const key of QUOTA_SETTINGS) {
      expect(SETTINGS_PAGE, `${key} 没有出现在设置页`).toContain(`setting="${key}"`)
    }
  })

  test('每一项都登记在 limits 的最小写入白名单里（漏登记会被静默丢弃）', () => {
    const allow = SETTINGS_CONFIG_SCOPE_KEYS.limits as readonly string[]
    for (const key of QUOTA_SETTINGS) {
      expect(allow, `${key} 未登记进 SETTINGS_CONFIG_SCOPE_KEYS.limits`).toContain(key)
    }
  })

  test('每一项都有中英双语 label + hint', () => {
    for (const lang of ['zh-CN', 'en-US']) {
      const src = readFileSync(resolve(import.meta.dirname, '..', `src/i18n/${lang}.ts`), 'utf8')
      for (const key of QUOTA_SETTINGS) {
        // multiProcessSubprocessConcurrency 的 i18n key 是历史简称。
        const i18nKey = key === 'multiProcessSubprocessConcurrency' ? 'multiProcessConc' : key
        expect(src, `${lang} 缺 ${i18nKey}`).toContain(`${i18nKey}:`)
        expect(src, `${lang} 缺 ${i18nKey}Hint`).toContain(`${i18nKey}Hint:`)
      }
    }
  })
})
