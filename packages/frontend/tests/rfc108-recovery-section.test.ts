// RFC-108 T21 (AR-11) — task-detail RecoverySection source + i18n parity guard.
//
// 为什么这条测试存在：RecoverySection 是任务级系统恢复审计 + 自动恢复隔离解除的唯一
// 前台入口。本测试锁定：① 组件存在、查 recovery-events、POST clear-recovery-suspension、
// 复用 btn 公共类（不自写按钮 chrome）；② 健康任务（无事件且未隔离）早退渲染 null（不
// 制造视觉噪声）；③ i18n 键 zh/en 双语齐全。

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (p: string): string => readFileSync(path.resolve(here, p), 'utf8')
const detail = read('../src/routes/tasks.detail.tsx')
const zh = read('../src/i18n/zh-CN.ts')
const en = read('../src/i18n/en-US.ts')

// RecoverySection was extracted out of tasks.detail.tsx into its own component
// when it was reworked into a compact collapsible banner (user feedback: the old
// <h2> page__section was too tall, looked like a second heading, and leaked raw
// enum kinds). Same contract, new home — read it from there.
const section = read('../src/components/tasks/RecoverySection.tsx')

describe('RFC-108 T21 — task-detail RecoverySection', () => {
  test('RecoverySection exists and is rendered in the task detail', () => {
    expect(/export function RecoverySection\(/.test(section)).toBe(true)
    expect(detail).toMatch(
      /<RecoverySection\s+key=\{`recovery:\$\{id\}`\}\s+taskId=\{id\}\s+status=\{tk\.status\}\s+\/>/,
    )
  })

  test('queries recovery-events and posts clear-recovery-suspension', () => {
    expect(section.includes('/recovery-events')).toBe(true)
    expect(section.includes('/clear-recovery-suspension')).toBe(true)
  })

  test('reuses the shared btn class for the clear-quarantine action', () => {
    expect(/className="btn btn--sm"/.test(section)).toBe(true)
  })

  test('T23: live-polls the recovery view while the task is active (stops when terminal)', () => {
    expect(section.includes('refetchInterval')).toBe(true)
    expect(section.includes('isTerminal(status)')).toBe(true)
  })

  test('renders nothing for a healthy task (no events + not suspended → early return null)', () => {
    expect(section.includes('data.events.length === 0 && !data.suspended')).toBe(true)
    expect(section.includes('return null')).toBe(true)
  })

  test('tasks.recovery.* i18n keys exist in BOTH zh-CN and en-US', () => {
    for (const leaf of ['title:', 'quarantined:', 'clearQuarantine:']) {
      expect(zh.includes(leaf), `zh-CN missing ${leaf}`).toBe(true)
      expect(en.includes(leaf), `en-US missing ${leaf}`).toBe(true)
    }
  })
})
