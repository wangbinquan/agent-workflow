// RFC-108 T22 — task-list stuck badge source guard.
//
// 为什么这条测试存在：stuck 徽标必须复用公共 StatusChip（不自写 chrome），仅在
// openAlertCount>0 时渲染，且键 zh/en 齐全。

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (p: string): string => readFileSync(path.resolve(here, p), 'utf8')
const list = read('../src/routes/tasks.tsx')
const zh = read('../src/i18n/zh-CN.ts')
const en = read('../src/i18n/en-US.ts')

describe('RFC-108 T22 — task-list stuck badge', () => {
  test('renders a StatusChip badge gated on openAlertCount > 0', () => {
    expect(list.includes('(item.openAlertCount ?? 0) > 0')).toBe(true)
    expect(list.includes('<StatusChip')).toBe(true)
    expect(list.includes('kind="warn"')).toBe(true)
  })

  test('tasks.stuckBadge i18n key exists in both zh-CN and en-US', () => {
    expect(zh.includes('stuckBadge:')).toBe(true)
    expect(en.includes('stuckBadge:')).toBe(true)
  })
})
