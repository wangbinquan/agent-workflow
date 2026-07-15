// RFC-010 follow-up — review 详情页的 diff 模式选择器从"勾选框 +
// 三按钮"改成单个 4 段 segmented pill control（原文 / 词 / 行 / 段）。
// 锁住：
//   1. 旧的 diff-view__toggle / diff-view__granularity DOM 形态彻底删除
//      （含 input[type="checkbox"] + diffToggle 文本节点的两步操作）
//   2. 新的 diff-mode-segmented 容器 + 4 个 button（含 'off'）就位
//   3. 翻译 key reviews.diffOff 在中英文 i18n 都补齐（避免 t() 出 fallback
//      key 漏字）
//   4. styles.css 有 .diff-mode-segmented 与 active 态样式
//
// JSDOM 跑不了 CSS 视觉效果，按 CLAUDE.md §Test-with-every-change "源代
// 码层文本断言"兜底；任何回退到老结构都会立刻红。

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const STYLES_CSS = resolve(__dirname, '..', 'src', 'styles.css')
const REVIEWS_DETAIL_TSX = resolve(__dirname, '..', 'src', 'routes', 'reviews.detail.tsx')
const ZH_CN = resolve(__dirname, '..', 'src', 'i18n', 'zh-CN.ts')
const EN_US = resolve(__dirname, '..', 'src', 'i18n', 'en-US.ts')

describe('review detail — diff mode segmented control', () => {
  test('reviews.detail.tsx 已不再渲染旧的 checkbox 形态（input + diff-view__toggle）', () => {
    const tsx = readFileSync(REVIEWS_DETAIL_TSX, 'utf8')
    expect(tsx).not.toMatch(/diff-view__toggle/)
    expect(tsx).not.toMatch(/diff-view__granularity/)
    expect(tsx).not.toMatch(/type="checkbox"[^/]*checked=\{diffMode\}/)
  })

  test('reviews.detail.tsx 渲染新的 .diff-mode-segmented 容器 + role=tablist', () => {
    const tsx = readFileSync(REVIEWS_DETAIL_TSX, 'utf8')
    expect(tsx).toMatch(/className="diff-mode-segmented"/)
    expect(tsx).toMatch(/role="tablist"/)
  })

  test('reviews.detail.tsx 4 个 segment（off/word/line/block）按钮都生成', () => {
    const tsx = readFileSync(REVIEWS_DETAIL_TSX, 'utf8')
    // 一行 const 数组同时驱动渲染：['off', 'word', 'line', 'block']
    expect(tsx).toMatch(/\[\s*'off'\s*,\s*'word'\s*,\s*'line'\s*,\s*'block'\s*\]/)
    // 选 off 时关闭 diff 模式（不只是切换 granularity）
    expect(tsx).toMatch(/setDiffMode\(false\)/)
    // 选其它任何一段时同时打开 diffMode + 设置 granularity
    expect(tsx).toMatch(/setDiffMode\(true\)/)
  })

  test('i18n: 中英都新增了 reviews.diffOff key 与 value', () => {
    const zh = readFileSync(ZH_CN, 'utf8')
    const en = readFileSync(EN_US, 'utf8')
    // type 定义（zh 是 source of truth）
    expect(zh).toMatch(/diffOff:\s*string/)
    // value
    expect(zh).toMatch(/diffOff:\s*'原文'/)
    expect(en).toMatch(/diffOff:\s*'Source'/)
  })

  test('styles.css 含 .diff-mode-segmented 容器 + active 态规则', () => {
    const css = readFileSync(STYLES_CSS, 'utf8')
    expect(css).toMatch(/\.diff-mode-segmented\s*\{/)
    expect(css).toMatch(/\.diff-mode-segmented__btn\s*\{/)
    expect(css).toMatch(/\.diff-mode-segmented__btn--active/)
    // 容器是 pill（圆角 999px）+ active 态有 accent 背景
    expect(css).toMatch(/\.diff-mode-segmented\s*\{[^}]*border-radius:\s*999px/)
    expect(css).toMatch(/\.diff-mode-segmented__btn--active[^}]*background:\s*var\(--accent-fill\)/)
  })
})
