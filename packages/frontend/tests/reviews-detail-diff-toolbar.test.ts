// RFC-010 follow-up — review 详情页的 diff 模式选择器从"勾选框 +
// 三按钮"改成单个 4 段 segmented pill control（原文 / 词 / 行 / 段）。
// 锁住：
//   1. 旧的 diff-view__toggle / diff-view__granularity DOM 形态彻底删除
//      （含 input[type="checkbox"] + diffToggle 文本节点的两步操作）
//   2. shared Segmented + 4 个 radio option（含 'off'）就位，filter/view
//      mode 不再冒充 tab/tabpanel
//   3. 翻译 key reviews.diffOff 在中英文 i18n 都补齐（避免 t() 出 fallback
//      key 漏字）
//   4. styles.css 有 shared `.segmented` 与 active 态样式
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

  test('reviews.detail.tsx 复用 Segmented，且不再手写 tab/tabpanel 语义', () => {
    const tsx = readFileSync(REVIEWS_DETAIL_TSX, 'utf8')
    expect(tsx).toMatch(/<Segmented<'off' \| DiffGranularity>/)
    expect(tsx).toMatch(/className="diff-mode-segmented"/)
    expect(tsx).not.toMatch(/role="tablist"/)
    expect(tsx).not.toMatch(/role="tab"/)
    expect(tsx).not.toMatch(/role="tabpanel"/)
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

  test('styles.css 含 shared segmented 容器 + active option 规则', () => {
    const css = readFileSync(STYLES_CSS, 'utf8')
    expect(css).toMatch(/\.diff-mode-segmented\s*\{/)
    expect(css).toMatch(/\.segmented\s*\{/)
    expect(css).toMatch(/\.segmented__option\s*\{/)
    expect(css).toMatch(/\.segmented__option--active/)
    // route-specific container remains a pill while active treatment is
    // supplied by the shared Segmented primitive.
    expect(css).toMatch(/\.diff-mode-segmented\s*\{[^}]*border-radius:\s*999px/)
    expect(css).toMatch(/\.segmented__option--active[^}]*background:\s*var\(--accent-fill\)/)
  })

  // 回归防护：pill 容器（999px）里的选项也必须是 pill，否则 shared
  // `.segmented__option` 自带的 4px 方角在首段（原文）/末段（段）被选中或 hover
  // 时会顶出圆弧容器之外（用户报告的"选中的方块跑到边框外面，很丑"）。RFC-150
  // 把手写的按钮规则（曾带 999px）迁到 `.segmented__option` 时丢了这个半径——
  // 任何回退到方角选项都会让首尾段重新外溢，这条断言即刻变红。
  test('styles.css: diff-mode pill 容器内的选项同为 pill（首尾段无方角外溢）', () => {
    const css = readFileSync(STYLES_CSS, 'utf8')
    expect(css).toMatch(/\.diff-mode-segmented \.segmented__option\s*\{[^}]*border-radius:\s*999px/)
  })
})
