// 2026-07-30 — 评审页 diff「变更落在表格内时整表碎裂」渲染级回归锁定。
//
// 根因（markdownDiff.ts 同日修复）：repairBrokenLinePrefixes 对
// wrapTableRowCells 产出的表格行误报"行首结构前缀被 marker 打断"——整行
// DEL/INS 的空侧视图（`|  |  |`）的 `\|\s*` 前缀比 marker 前的物理前缀
// （`| `）长——把每个带 marker 的表格行拆成"行 + 空行 + `|  |  |`"，三种
// granularity 下表格全部降级成带裸 `|` 的段落。同根修复顺带覆盖：
//   - blockquote 内表格（结构行判定剥引用前缀后进行）
//   - setext `===` 下划线（wrapLines 跳过，不再降级标题并漏出裸 `===`）
//   - task list checkbox（`[x]`/`[ ]` word 路径原子化 + 并入行首结构前缀，
//     勾选态切换拆成两条完整 task 行；此前 del 视图残留 `[x ]` 字面量）
//
// 断言走真实渲染管线（MarkdownDiffView = react-markdown + remark-gfm +
// remarkDiffMarkers）：merged 字符串层的断言锁不住这类回归——旧测试全绿的
// 同时浏览器里表格已经烂了，所以这里必须以 <table>/<input> 等渲染产物为准。

import { describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { MarkdownDiffView } from '@/components/review/MarkdownDiffView'
import { buildMergedMarkdown } from '@/lib/review/markdownDiff'

const TABLE_L = ['# Doc', '', '| col | val |', '| --- | --- |', '| a | 1 |', '| b | 2 |', ''].join(
  '\n',
)
const TABLE_R = ['# Doc', '', '| col | val |', '| --- | --- |', '| a | 9 |', '| b | 2 |', ''].join(
  '\n',
)

/** 渲染产物里不允许出现裸 `|`——表格正常渲染时竖线只存在于 DOM 结构中。 */
const pipeLeak = (el: HTMLElement) => (el.textContent ?? '').includes('|')

describe('表格 diff 渲染（cell 改动）', () => {
  test('word：旧表整表 DEL + 新表整表 INS，两张表都正常渲染', () => {
    const { container } = render(
      <MarkdownDiffView left={TABLE_L} right={TABLE_R} granularity="word" />,
    )
    const tables = container.querySelectorAll('table')
    expect(tables.length).toBe(2)
    expect(pipeLeak(container)).toBe(false)
    // 第一张全 del、第二张全 ins；cell 文本完整
    expect(tables[0]?.querySelectorAll('.diff-del').length).toBeGreaterThan(0)
    expect(tables[0]?.querySelectorAll('.diff-ins').length).toBe(0)
    expect(tables[1]?.querySelectorAll('.diff-ins').length).toBeGreaterThan(0)
    expect(tables[1]?.textContent).toContain('9')
    expect(tables[0]?.textContent).toContain('1')
  })

  test('line：单张表内 DEL 行 + INS 行相邻呈现', () => {
    const { container } = render(
      <MarkdownDiffView left={TABLE_L} right={TABLE_R} granularity="line" />,
    )
    const tables = container.querySelectorAll('table')
    expect(tables.length).toBe(1)
    expect(pipeLeak(container)).toBe(false)
    const rows = tables[0]?.querySelectorAll('tbody tr') ?? []
    // 旧行(a,1) + 新行(a,9) + context 行(b,2)
    expect(rows.length).toBe(3)
    expect(rows[0]?.querySelector('.diff-del')).not.toBeNull()
    expect(rows[1]?.querySelector('.diff-ins')).not.toBeNull()
    expect(rows[2]?.querySelector('.diff-del, .diff-ins')).toBeNull()
  })

  test('block：与 word 同为两张完整表', () => {
    const { container } = render(
      <MarkdownDiffView left={TABLE_L} right={TABLE_R} granularity="block" />,
    )
    expect(container.querySelectorAll('table').length).toBe(2)
    expect(pipeLeak(container)).toBe(false)
  })

  test('merged 字符串不含 repair 误拆产物（空 cell 杂散行 / 表行间空行）', () => {
    for (const g of ['word', 'line', 'block'] as const) {
      const merged = buildMergedMarkdown(TABLE_L, TABLE_R, g)
      // `|  |  |` 式全空 cell 杂散行是 repairBrokenLinePrefixes 误拆的指纹
      expect(merged).not.toMatch(/^\|(\s*\|)+\s*$/m)
    }
    // line 模式全程单表：表格行之间被插入空行（撕表）即回归。word/block
    // 模式"旧表 + 新表"之间的空行是合法边界，不适用本断言。
    expect(buildMergedMarkdown(TABLE_L, TABLE_R, 'line')).not.toMatch(/^\|.*\n\n+\|/m)
  })
})

describe('表格 diff 渲染（行增删 / 表格出现）', () => {
  test('line：新增一行 → 同一张表内绿行', () => {
    const l = '| a | b |\n| --- | --- |\n| 1 | 2 |\n'
    const r = '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n'
    const { container } = render(<MarkdownDiffView left={l} right={r} granularity="line" />)
    const tables = container.querySelectorAll('table')
    expect(tables.length).toBe(1)
    expect(pipeLeak(container)).toBe(false)
    const rows = tables[0]?.querySelectorAll('tbody tr') ?? []
    expect(rows.length).toBe(2)
    expect(rows[1]?.querySelector('.diff-ins')).not.toBeNull()
  })

  test('word：段落文档新增一张表 → 单张全绿表', () => {
    const l = 'some text\n'
    const r = 'some text\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n'
    const { container } = render(<MarkdownDiffView left={l} right={r} granularity="word" />)
    const tables = container.querySelectorAll('table')
    expect(tables.length).toBe(1)
    expect(pipeLeak(container)).toBe(false)
    expect(tables[0]?.querySelectorAll('.diff-ins').length).toBeGreaterThan(0)
  })
})

describe('blockquote 内表格', () => {
  test('word：引用内 cell 改动 → 表仍在 blockquote 内渲染，del+ins 同 cell', () => {
    const l = '> intro\n>\n> | a | b |\n> | --- | --- |\n> | 1 | 2 |\n'
    const r = '> intro\n>\n> | a | b |\n> | --- | --- |\n> | 1 | 9 |\n'
    const { container } = render(<MarkdownDiffView left={l} right={r} granularity="word" />)
    const table = container.querySelector('blockquote table')
    expect(table).not.toBeNull()
    expect(pipeLeak(container)).toBe(false)
    expect(table?.querySelector('.diff-del')?.textContent).toBe('2')
    expect(table?.querySelector('.diff-ins')?.textContent).toBe('9')
  })

  test('word：整段引用（含表）新增 → 引用内表格完整渲染为绿', () => {
    const l = 'before\n'
    const r = 'before\n\n> note\n>\n> | a | b |\n> | --- | --- |\n> | 1 | 2 |\n'
    const { container } = render(<MarkdownDiffView left={l} right={r} granularity="word" />)
    const table = container.querySelector('blockquote table')
    expect(table).not.toBeNull()
    expect(pipeLeak(container)).toBe(false)
    expect(table?.querySelectorAll('.diff-ins').length).toBeGreaterThan(0)
  })
})

describe('setext 标题', () => {
  test('word：插入 setext 标题 → 渲染成 <h1>，不漏出裸 `===`', () => {
    const l = 'para before\n'
    const r = 'para before\n\nNew Title\n=========\n'
    const { container } = render(<MarkdownDiffView left={l} right={r} granularity="word" />)
    const h1 = container.querySelector('h1')
    expect(h1).not.toBeNull()
    expect(h1?.querySelector('.diff-ins')).not.toBeNull()
    expect(container.textContent ?? '').not.toContain('=')
  })
})

describe('task list checkbox', () => {
  test('word：勾选态切换 → 拆成勾选红项 + 未勾绿项，checkbox 不降级为字面量', () => {
    const l = '- [x] done item\n- [ ] todo item\n'
    const r = '- [ ] done item\n- [ ] todo item\n'
    const { container } = render(<MarkdownDiffView left={l} right={r} granularity="word" />)
    const boxes = container.querySelectorAll('input[type="checkbox"]')
    expect(boxes.length).toBe(3)
    expect((boxes[0] as HTMLInputElement).checked).toBe(true)
    expect((boxes[1] as HTMLInputElement).checked).toBe(false)
    expect(container.textContent ?? '').not.toContain('[')
    const items = container.querySelectorAll('li')
    expect(items[0]?.querySelector('.diff-del')).not.toBeNull()
    expect(items[1]?.querySelector('.diff-ins')).not.toBeNull()
  })

  test('word：整条 task 项新增 → checkbox 正常渲染、文本绿', () => {
    const l = '- [ ] a\n'
    const r = '- [ ] a\n- [x] b\n'
    const { container } = render(<MarkdownDiffView left={l} right={r} granularity="word" />)
    const boxes = container.querySelectorAll('input[type="checkbox"]')
    expect(boxes.length).toBe(2)
    expect(container.textContent ?? '').not.toContain('[')
    expect(container.querySelector('.diff-ins')).not.toBeNull()
  })
})

describe('identical 输入不变量（checkbox / setext / 引用内 checkbox 原子化不破坏无变更路径）', () => {
  const doc = [
    '# T',
    '',
    '- [x] a',
    '- [ ] b',
    '1. [X] c',
    '',
    '> - [x] quoted',
    '',
    'Setext',
    '======',
    '',
    '| a |',
    '| --- |',
    '| 1 |',
    '',
  ].join('\n')

  test('word / line 逐字节还原，block 段落规范化后等价', () => {
    expect(buildMergedMarkdown(doc, doc, 'word')).toBe(doc)
    expect(buildMergedMarkdown(doc, doc, 'line')).toBe(doc)
    expect(buildMergedMarkdown(doc, doc, 'block').trim()).toBe(doc.trim())
  })
})
