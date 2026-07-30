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

// Codex 实现门（2026-07-30）2 P1 回归：结构行判定不得作用于 word 模式的
// 行中片段（否则普通 `=`/`---` 增删被静默跳过、删除侧以 context 残留旧文
// 本）；"变更恰为行首前缀本体"（段落 ↔ task/list 化）必须整行入 marker 并
// 由行首修复拆行呈现，不得因空 body + 空 marker 对清理而完全无高亮。
describe('word 片段不误判结构行（Codex 实现门 P1）', () => {
  test('行中 `=` 插入 → 正常绿标，不被当 setext 下划线吞掉', () => {
    const { container } = render(<MarkdownDiffView left="a=b" right="a==b" granularity="word" />)
    const ins = container.querySelector('.diff-ins')
    expect(ins?.textContent).toBe('=')
    expect(container.querySelector('.diff-del')).toBeNull()
  })

  test('行中 `=` 删除 → 红标呈现，旧文本不以 context 形态残留', () => {
    const { container } = render(
      <MarkdownDiffView left="x === y" right="x == y" granularity="word" />,
    )
    const del = container.querySelector('.diff-del')
    expect(del?.textContent).toBe('=')
  })

  test('行中 `---` 删除 → 红标呈现，不被当 thematic break 吞掉', () => {
    const { container } = render(<MarkdownDiffView left="x --- y" right="x y" granularity="word" />)
    expect(container.querySelector('.diff-del')?.textContent).toContain('---')
    expect(container.querySelector('hr')).toBeNull()
  })

  test('真实 hr 插入（独立完整行）仍渲染 <hr>', () => {
    const { container } = render(
      <MarkdownDiffView left={'a\n'} right={'a\n\n---\n\nb\n'} granularity="word" />,
    )
    expect(container.querySelector('hr')).not.toBeNull()
    expect(container.querySelector('.diff-ins')?.textContent).toBe('b')
  })

  test('段落 → task 化：红段落 + 绿 task 项，变更不隐身', () => {
    const { container } = render(
      <MarkdownDiffView left="foo" right="- [x] foo" granularity="word" />,
    )
    expect(container.querySelector('.diff-del')?.textContent).toBe('foo')
    const li = container.querySelector('li')
    expect(li?.querySelector('input[type="checkbox"]')).not.toBeNull()
    expect(li?.querySelector('.diff-ins')?.textContent).toBe('foo')
  })

  test('task → 段落化：红 task 项 + 绿段落', () => {
    const { container } = render(
      <MarkdownDiffView left="- [x] foo" right="foo" granularity="word" />,
    )
    const li = container.querySelector('li')
    expect(li?.querySelector('input[type="checkbox"]')).not.toBeNull()
    expect(li?.querySelector('.diff-del')?.textContent).toBe('foo')
    expect(container.querySelector('.diff-ins')?.textContent).toBe('foo')
  })

  test('普通列表化（`- ` 前缀即变更本体）同样不隐身', () => {
    const { container } = render(
      <MarkdownDiffView left="item text" right="- item text" granularity="word" />,
    )
    expect(container.querySelector('.diff-del')?.textContent).toBe('item text')
    expect(container.querySelector('li')?.querySelector('.diff-ins')).not.toBeNull()
  })
})

// Codex 实现门二轮（2026-07-30）3 P1 + 1 P2 回归：line 模式表结构变化须
// 重建为旧表 + 新表（否则新列 cell 被 GFM 丢弃）；仅加删 setext 下划线的
// 结构变化不得隐身；引用空续行 `>` 保持裸行；缩进代码块里的 `[x]` 不做
// checkbox 原子化。
describe('line 模式表结构变化重建（Codex 二轮 P1）', () => {
  const T2 = '| a | b |\n| --- | --- |\n| 1 | 2 |\n'

  test('列数变化 → 旧表 + 新表两张，全部 cell 保留', () => {
    const T3 = '| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n'
    const { container } = render(<MarkdownDiffView left={T2} right={T3} granularity="line" />)
    const tables = container.querySelectorAll('table')
    expect(tables.length).toBe(2)
    expect(pipeLeak(container)).toBe(false)
    // 新增第三列的 cell 不被 GFM 丢弃
    expect(tables[1]?.textContent).toContain('c')
    expect(tables[1]?.textContent).toContain('3')
    expect(tables[0]?.querySelectorAll('.diff-del').length).toBeGreaterThan(0)
    expect(tables[1]?.querySelectorAll('.diff-ins').length).toBeGreaterThan(0)
  })

  test('表头改名 → 旧表 + 新表两张（第二行必须是分隔符才成表）', () => {
    const TH = '| x | y |\n| --- | --- |\n| 1 | 2 |\n'
    const { container } = render(<MarkdownDiffView left={T2} right={TH} granularity="line" />)
    const tables = container.querySelectorAll('table')
    expect(tables.length).toBe(2)
    expect(pipeLeak(container)).toBe(false)
    expect(tables[0]?.querySelector('th')?.textContent).toBe('a')
    expect(tables[1]?.querySelector('th')?.textContent).toBe('x')
  })

  test('body 行编辑仍保持单表（重建只针对结构不合法段）', () => {
    const TB = '| a | b |\n| --- | --- |\n| 1 | 9 |\n'
    const { container } = render(<MarkdownDiffView left={T2} right={TB} granularity="line" />)
    expect(container.querySelectorAll('table').length).toBe(1)
    expect(pipeLeak(container)).toBe(false)
  })
})

describe('setext 结构变化可见（Codex 二轮 P1）', () => {
  test('word：既有段落补 `===` 标题化 → 红段落 + 绿 <h1>', () => {
    const { container } = render(
      <MarkdownDiffView left={'A\n\nB\n'} right={'A\n\nB\n===\n'} granularity="word" />,
    )
    expect(container.querySelector('.diff-del')?.textContent).toBe('B')
    const h1 = container.querySelector('h1')
    expect(h1?.querySelector('.diff-ins')?.textContent).toBe('B')
    expect(container.textContent ?? '').not.toContain('=')
  })

  test('word：去掉 `===` 下划线 → 红 <h1> + 绿段落', () => {
    const { container } = render(
      <MarkdownDiffView left={'A\n\nB\n===\n'} right={'A\n\nB\n'} granularity="word" />,
    )
    expect(container.querySelector('h1')?.querySelector('.diff-del')).not.toBeNull()
    expect(container.querySelector('.diff-ins')?.textContent).toBe('B')
  })

  test('line：标题化同样可见', () => {
    const { container } = render(
      <MarkdownDiffView left={'A\n\nB\n'} right={'A\n\nB\n===\n'} granularity="line" />,
    )
    expect(container.querySelector('.diff-del')?.textContent).toBe('B')
    expect(container.querySelector('h1')?.querySelector('.diff-ins')).not.toBeNull()
  })
})

describe('引用段落增删（Codex 二轮 P1）', () => {
  test('word：整段引用（含 `>` 空续行）新增 → 两段绿引用，无字面 `>` 泄漏', () => {
    const { container } = render(
      <MarkdownDiffView left={'x\n'} right={'x\n\n> a\n>\n> b\n'} granularity="word" />,
    )
    const bq = container.querySelector('blockquote')
    expect(bq).not.toBeNull()
    expect(bq?.querySelectorAll('p').length).toBe(2)
    expect(container.textContent ?? '').not.toContain('>')
    expect(bq?.querySelectorAll('.diff-ins').length).toBe(2)
  })
})

describe('缩进代码块不做 checkbox 原子化（Codex 二轮 P2）', () => {
  test('word：4 空格缩进代码里的 `[x]` 切换 → 仍是代码块，不渲染 checkbox', () => {
    const { container } = render(
      <MarkdownDiffView
        left={'p\n\n    - [x] code\n'}
        right={'p\n\n    - [ ] code\n'}
        granularity="word"
      />,
    )
    expect(container.querySelector('input[type="checkbox"]')).toBeNull()
    expect(container.querySelector('pre code')).not.toBeNull()
  })

  test('word：嵌套 task（合法缩进）仍原子化，checkbox 正常', () => {
    const { container } = render(
      <MarkdownDiffView
        left={'- top\n  - [x] sub\n'}
        right={'- top\n  - [ ] sub\n'}
        granularity="word"
      />,
    )
    expect(container.querySelectorAll('input[type="checkbox"]').length).toBeGreaterThanOrEqual(2)
    expect(container.textContent ?? '').not.toContain('[')
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
