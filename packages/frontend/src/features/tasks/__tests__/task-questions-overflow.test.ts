/**
 * 回归防护：任务详情「问题」页签（TaskQuestionsPanel）问题卡片标题「出框」修复。
 *
 * 背景：问题页签用 .task-questions__row(flex) + .task-questions__col(flex:1; min-width:0)
 * 布局，卡片标题用公共 .card__title 渲染。.card__title 默认 overflow-wrap:normal，长问题
 * 文本（含无空格长串）整体不断行 → 其 min-content 撑大 flex 列 → 列盒子顶出容器框。
 * 真实页面（/tasks/:id 问题页签）实测：列盒子溢出 84px、标题内容溢出 96px；
 * 给标题加换行后两者均归零（HMR 实地验证）。
 *
 * 修复：.task-questions .card__title 加 overflow-wrap:anywhere + word-break:break-word
 * （后代选择器限定在问题页签内，不影响其它用公共 .card__title 的地方）。
 *
 * CSS 布局无法在 jsdom 断言（vitest css:false、jsdom 不做布局），故以源码层文本断言兜底
 * 锁定这条规则——改回去本测试即转红。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// `__dirname` (the pattern the repo's other source-guard tests use) — NOT
// `fileURLToPath(new URL(..., import.meta.url))`, which throws "The URL must be of
// scheme file" under vitest (import.meta.url is not a file:// URL there) → 0 tests.
const css = readFileSync(resolve(__dirname, '..', '..', '..', 'styles.css'), 'utf8')

describe('task questions card title overflow guard', () => {
  it("wraps .card__title inside .task-questions so long titles don't overflow the column", () => {
    const idx = css.indexOf('.task-questions .card__title {')
    expect(idx).toBeGreaterThan(-1)
    const body = css.slice(idx, css.indexOf('}', idx))
    expect(body).toMatch(/overflow-wrap\s*:\s*anywhere/)
    expect(body).toMatch(/word-break\s*:\s*break-word/)
  })
})
