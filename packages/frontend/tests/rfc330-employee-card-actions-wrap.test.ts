// RFC-330 —— 员工卡操作行多了「权限」入口后，1280 宽视口下四个按钮一行放不下：
// 员工卡是 grid（第三列 auto），操作行不换行就把整张卡撑出页面（2026-08-27 视觉
// 基线 digital-employee-cards 实撞：右侧「创建员工」「创建任务」被裁掉）。工具行与
// 模版头早有同样的换行规则，这里把员工卡对齐并锁住，防止哪次样式整理把它删回去。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const CSS = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf-8')
const ROUTE = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'digital-employees.$typeRef.tsx'),
  'utf-8',
)

describe('RFC-330 — employee card actions wrap instead of overflowing the card', () => {
  test('the employee card actions row wraps and keeps right alignment on desktop', () => {
    const block = CSS.match(
      /\.employee-summary-card--employee > \.employee-summary-card__actions\s*\{[^}]*\}/,
    )
    expect(block).not.toBeNull()
    expect(block![0]).toMatch(/flex-wrap:\s*wrap/)
    expect(block![0]).toMatch(/justify-content:\s*flex-end/)
  })

  test('the narrow-viewport override left-aligns it like the tool rows and template header', () => {
    const blocks = CSS.match(
      /\.employee-summary-card--employee > \.employee-summary-card__actions\s*\{[^}]*\}/g,
    )
    expect(blocks).not.toBeNull()
    expect(blocks!.some((block) => /justify-content:\s*flex-start/.test(block))).toBe(true)
  })

  test('the employee card still renders its actions through the shared actions class', () => {
    expect(ROUTE).toContain('className="employee-summary-card employee-summary-card--employee"')
    const employeesPanel = ROUTE.slice(ROUTE.indexOf('function EmployeesPanel('))
    expect(employeesPanel).toContain('<div className="employee-summary-card__actions">')
  })
})
