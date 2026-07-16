// RFC-010 — MarkdownDiffView 集成测试。
// 锚定：组件确实把 PUA marker 渲染成带 .diff-ins / .diff-del 的 <span>，
// 标题等块级结构在渲染中保留，<script> 字面量不会真生成 <script> 元素。

import { describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { MarkdownDiffView } from '@/components/review/MarkdownDiffView'

describe('MarkdownDiffView', () => {
  test('段内 word 改动 → .diff-ins / .diff-del span', () => {
    const { container } = render(
      <MarkdownDiffView left="the order_status enum" right="the order_status field" />,
    )
    const ins = container.querySelectorAll('.diff-ins')
    const del = container.querySelectorAll('.diff-del')
    expect(ins.length).toBeGreaterThan(0)
    expect(del.length).toBeGreaterThan(0)
    const insText = Array.from(ins)
      .map((n) => n.textContent ?? '')
      .join('')
    const delText = Array.from(del)
      .map((n) => n.textContent ?? '')
      .join('')
    expect(insText).toContain('field')
    expect(delText).toContain('enum')
  })

  test('heading 改字 → 仍然是 <h1>，不被 marker 拆散', () => {
    const { container } = render(<MarkdownDiffView left="# Old Title" right="# New Title" />)
    const h1 = container.querySelector('h1')
    expect(h1).not.toBeNull()
    expect(h1?.querySelector('.diff-ins')).not.toBeNull()
    expect(h1?.querySelector('.diff-del')).not.toBeNull()
  })

  test('list item 改字 → 仍然是 <ul><li>', () => {
    const { container } = render(
      <MarkdownDiffView left={'- buy milk\n- buy bread'} right={'- buy oats\n- buy bread'} />,
    )
    const items = container.querySelectorAll('li')
    expect(items.length).toBe(2)
    // 第一项含 ins/del；第二项是纯 context
    const first = items[0]
    expect(first?.querySelector('.diff-ins')).not.toBeNull()
    expect(first?.querySelector('.diff-del')).not.toBeNull()
  })

  test('CJK：你好世界 → 你好新世界 仅 1 个 .diff-ins', () => {
    const { container } = render(<MarkdownDiffView left="你好世界" right="你好新世界" />)
    const ins = container.querySelectorAll('.diff-ins')
    expect(ins.length).toBe(1)
    // 渲染后 splitForWordDiff 注入的 ZWSP 仍可能残留在 segment 末尾，
    // 用 normalize（剥 ZWSP）后断言纯字面值，对未来字体 / 搜索友好。
    const ZWSP = '​'
    const norm = (s: string | null | undefined) => (s ?? '').replaceAll(ZWSP, '')
    expect(norm(ins[0]?.textContent)).toBe('新')
  })

  test('安全：<script> 字面量不会渲染成真实 <script>', () => {
    const { container } = render(
      <MarkdownDiffView left="hello" right="<script>alert(1)</script>" />,
    )
    expect(container.querySelectorAll('script').length).toBe(0)
  })

  test('完全相同 → 没有 .diff-ins / .diff-del', () => {
    const { container } = render(<MarkdownDiffView left="hello world" right="hello world" />)
    expect(container.querySelectorAll('.diff-ins').length).toBe(0)
    expect(container.querySelectorAll('.diff-del').length).toBe(0)
  })

  test('容器带 markdown-diff-view class，便于 CSS 局部作用域', () => {
    const { container } = render(<MarkdownDiffView left="a" right="b" />)
    expect(container.querySelector('.markdown-diff-view')).not.toBeNull()
  })

  test('容器带 data-granularity，反映传入 prop（默认 word）', () => {
    const { container } = render(<MarkdownDiffView left="a" right="b" />)
    expect(container.querySelector('[data-granularity="word"]')).not.toBeNull()
  })
})

describe('MarkdownDiffView — line granularity', () => {
  test('单行改字 → 整行 ins / del', () => {
    const { container } = render(
      <MarkdownDiffView
        left={'hello world\nstable line\n'}
        right={'hello earth\nstable line\n'}
        granularity="line"
      />,
    )
    const ins = container.querySelectorAll('.diff-ins')
    const del = container.querySelectorAll('.diff-del')
    expect(ins.length).toBeGreaterThan(0)
    expect(del.length).toBeGreaterThan(0)
    const insText = Array.from(ins)
      .map((n) => n.textContent ?? '')
      .join('')
    const delText = Array.from(del)
      .map((n) => n.textContent ?? '')
      .join('')
    expect(insText).toContain('hello earth')
    expect(delText).toContain('hello world')
  })

  test('整行新增 → 仅 ins', () => {
    const { container } = render(
      <MarkdownDiffView left={'a\nb\n'} right={'a\nb\nc\n'} granularity="line" />,
    )
    expect(container.querySelectorAll('.diff-ins').length).toBeGreaterThan(0)
    expect(container.querySelectorAll('.diff-del').length).toBe(0)
  })

  test('容器 data-granularity 反映 line', () => {
    const { container } = render(<MarkdownDiffView left="a" right="b" granularity="line" />)
    expect(container.querySelector('[data-granularity="line"]')).not.toBeNull()
  })

  // 用户回归（line 模式 CJK 单行替换）：
  //   left  "单人/双人游戏模式"
  //   right "单人游戏模式"
  // 旧实现下，新行的 INS marker 渲染丢失（用户原话：下面那句话没标绿）。
  // 锁住：渲染后必须同时存在 .diff-del 和 .diff-ins，文本各对应。
  test('CJK 单行替换 → 同时渲染 .diff-del 和 .diff-ins span', () => {
    const { container } = render(
      <MarkdownDiffView left={'单人/双人游戏模式'} right={'单人游戏模式'} granularity="line" />,
    )
    expect(container.querySelector('.diff-del')?.textContent).toBe('单人/双人游戏模式')
    expect(container.querySelector('.diff-ins')?.textContent).toBe('单人游戏模式')
  })

  test('列表项内 CJK 单行替换 → li 内同时含 .diff-del 和 .diff-ins', () => {
    const { container } = render(
      <MarkdownDiffView
        left={['- 单人/双人游戏模式', '- 多人游戏模式'].join('\n')}
        right={['- 单人游戏模式', '- 多人游戏模式'].join('\n')}
        granularity="line"
      />,
    )
    const items = container.querySelectorAll('li')
    expect(items.length).toBeGreaterThanOrEqual(2)
    const allDel = container.querySelector('.diff-del')
    const allIns = container.querySelector('.diff-ins')
    expect(allDel?.textContent).toBe('单人/双人游戏模式')
    expect(allIns?.textContent).toBe('单人游戏模式')
  })

  // 用户回归：root cause 是 jsdiff diffLines 在 input 缺尾 \n 时 emit 的
  // 最后一段 value 也没 \n，buildMergedMarkdown 拼回时 DEL + INS 糊在一行，
  // 第二行的 markdown 结构字符（## / -）落进第一行的 text 里，导致：
  //   - heading 模式下两 h2 合成一个 <h2>，第二个 ## 变成 heading 内文本
  //   - list 模式下两 li 合成一个 <li>，新行 INS 紧贴在旧行 DEL 后面
  // 修复：computeChanges 在 line 路径上对 left/right 做 ensureTrailingNewline。
  test('裸 heading 替换（无 trailing \\n）→ 必须渲染 2 个独立 <h2>', () => {
    const { container } = render(
      <MarkdownDiffView
        left={'## 单人/双人游戏模式'}
        right={'## 单人游戏模式'}
        granularity="line"
      />,
    )
    const headings = container.querySelectorAll('h2')
    expect(headings.length).toBe(2)
    expect(headings[0]?.querySelector('.diff-del')?.textContent).toBe('单人/双人游戏模式')
    expect(headings[1]?.querySelector('.diff-ins')?.textContent).toBe('单人游戏模式')
  })

  test('裸 list item 替换（无 trailing \\n）→ 必须渲染 2 个独立 <li>', () => {
    const { container } = render(
      <MarkdownDiffView left={'- 单人/双人游戏模式'} right={'- 单人游戏模式'} granularity="line" />,
    )
    const items = container.querySelectorAll('li')
    expect(items.length).toBe(2)
    expect(items[0]?.querySelector('.diff-del')?.textContent).toBe('单人/双人游戏模式')
    expect(items[1]?.querySelector('.diff-ins')?.textContent).toBe('单人游戏模式')
  })
})

describe('MarkdownDiffView — block granularity', () => {
  test('整段重写 → 旧段 del + 新段 ins，结构保留', () => {
    const left = 'first paragraph\n\nold paragraph two\n\nthird paragraph\n'
    const right = 'first paragraph\n\nbrand new paragraph two\n\nthird paragraph\n'
    const { container } = render(<MarkdownDiffView left={left} right={right} granularity="block" />)
    const ins = container.querySelectorAll('.diff-ins')
    const del = container.querySelectorAll('.diff-del')
    expect(del.length).toBeGreaterThan(0)
    expect(ins.length).toBeGreaterThan(0)
    const allText = container.textContent ?? ''
    expect(allText).toContain('first paragraph')
    expect(allText).toContain('third paragraph')
  })

  test('整段新增（含 heading + list）→ 渲染保留 <h2> + <ul>', () => {
    const left = 'paragraph one\n'
    const right = 'paragraph one\n\n## New Section\n\n- bullet a\n- bullet b\n'
    const { container } = render(<MarkdownDiffView left={left} right={right} granularity="block" />)
    expect(container.querySelector('h2')).not.toBeNull()
    expect(container.querySelectorAll('li').length).toBe(2)
    expect(container.querySelectorAll('.diff-ins').length).toBeGreaterThan(0)
  })

  test('容器 data-granularity 反映 block', () => {
    const { container } = render(<MarkdownDiffView left="a" right="b" granularity="block" />)
    expect(container.querySelector('[data-granularity="block"]')).not.toBeNull()
  })

  // 用户回归：block 模式必须真正 RENDER 出独立段落，不再像旧 line 实现
  // 那样把多块挤进一行或被代码块吞掉。
  test('段落级改动 → 渲染成 4 个独立 <p>，旧段 del / 新段 ins 各自成段', () => {
    const left = 'Intro.\n\nMiddle old.\n\nEnd.'
    const right = 'Intro.\n\nMiddle new.\n\nEnd.'
    const { container } = render(<MarkdownDiffView left={left} right={right} granularity="block" />)
    const paragraphs = container.querySelectorAll('p')
    expect(paragraphs.length).toBe(4) // Intro / Middle old / Middle new / End
    expect(paragraphs[1]?.querySelector('.diff-del')?.textContent).toBe('Middle old.')
    expect(paragraphs[2]?.querySelector('.diff-ins')?.textContent).toBe('Middle new.')
  })

  test('代码块改动 → 渲染保留 <pre><code> 结构（fence 不被 marker 拆破）', () => {
    const left = ['# Spec', '', '```ts', 'old()', '```'].join('\n')
    const right = ['# Spec', '', '```ts', 'new()', '```'].join('\n')
    const { container } = render(<MarkdownDiffView left={left} right={right} granularity="block" />)
    // 必须有正确解析出的 <pre> + <code>，否则就说明 fence 被 marker 破坏
    expect(container.querySelector('pre code')).not.toBeNull()
    const allText = container.textContent ?? ''
    expect(allText).toContain('old()')
    expect(allText).toContain('new()')
  })
})

// RFC-012：word 模式表格保留。把"列数 / 表头不一致"和"段落↔表互换"渲染
// 出真正的 `<table>`，不允许整张表降级成 `<p>` + 裸 `|---|---|`。
describe('MarkdownDiffView — RFC-012 table preservation (word)', () => {
  const PIPE_DASHES_RE = /\|---/

  test('header rename + 列数 / 分隔符宽度不一致 → 两张独立 <table>，分隔符行 0 markdown 漏出', () => {
    // 浏览器实测样本（见 RFC-012 proposal §背景）。
    const left = `| 项目名称 | 坦克大战游戏 |\n|---------|------------|\n| 文档版本 | V1.0 |\n| 创建日期 | 2026-05-16 |\n| 文档状态 | 初稿 |\n`
    const right = `| 项目 | 内容 |\n|------|------|\n| 项目名称 | 坦克大战游戏 |\n| 文档版本 | v1.0 |\n| 创建日期 | 2026-05-16 |\n| 文档状态 | 正式发布 |\n`
    const { container } = render(<MarkdownDiffView left={left} right={right} granularity="word" />)
    const tables = container.querySelectorAll('table')
    expect(tables.length).toBeGreaterThanOrEqual(2)
    // 任何 `<p>` 都不允许包含 `|---` 子串（说明表降级为段落了）
    const badPs = Array.from(container.querySelectorAll('p')).filter((p) =>
      PIPE_DASHES_RE.test(p.textContent ?? ''),
    )
    expect(badPs.length).toBe(0)
    // 每张表至少有一个 .diff-ins / .diff-del cell，否则颜色就丢了
    const insCells = container.querySelectorAll('table th .diff-ins, table td .diff-ins')
    const delCells = container.querySelectorAll('table th .diff-del, table td .diff-del')
    expect(insCells.length).toBeGreaterThan(0)
    expect(delCells.length).toBeGreaterThan(0)
  })

  test('段落 → 表格：渲染含一个 <table> + 段落各自带 del / ins', () => {
    const left = '项目名称：坦克大战游戏\n'
    const right = '| 项目 | 内容 |\n|---|---|\n| 项目名称 | 坦克大战游戏 |\n'
    const { container } = render(<MarkdownDiffView left={left} right={right} granularity="word" />)
    expect(container.querySelector('table')).not.toBeNull()
    expect(container.querySelector('.diff-del')).not.toBeNull()
    expect(container.querySelector('.diff-ins')).not.toBeNull()
    const badPs = Array.from(container.querySelectorAll('p')).filter((p) =>
      PIPE_DASHES_RE.test(p.textContent ?? ''),
    )
    expect(badPs.length).toBe(0)
  })

  test('line 模式回归：同一对 left/right 切到 line 仍渲染表格、不带 PUA 漏文本', () => {
    const left = `| 项目名称 | 坦克大战游戏 |\n|---------|------------|\n`
    const right = `| 项目 | 内容 |\n|------|------|\n`
    const { container } = render(<MarkdownDiffView left={left} right={right} granularity="line" />)
    // line 模式既有行为：每张表整行被 ins/del 包，但行结构保持
    const tables = container.querySelectorAll('table')
    expect(tables.length).toBeGreaterThanOrEqual(1)
    const badPs = Array.from(container.querySelectorAll('p')).filter((p) =>
      PIPE_DASHES_RE.test(p.textContent ?? ''),
    )
    expect(badPs.length).toBe(0)
  })

  test('block 模式回归：同一对 left/right 切到 block 仍渲染表格', () => {
    const left = `| 项目名称 | 坦克大战游戏 |\n|---------|------------|\n`
    const right = `| 项目 | 内容 |\n|------|------|\n`
    const { container } = render(<MarkdownDiffView left={left} right={right} granularity="block" />)
    const tables = container.querySelectorAll('table')
    expect(tables.length).toBeGreaterThanOrEqual(1)
    const badPs = Array.from(container.querySelectorAll('p')).filter((p) =>
      PIPE_DASHES_RE.test(p.textContent ?? ''),
    )
    expect(badPs.length).toBe(0)
  })
})

// 2026-07-16 — 渲染级乱码回归锁：PUA marker 不允许出现在最终 DOM 文本里，
// code / bold / heading 结构在 diff 后保持合法（此前 fence 内改行会把 PUA
// 渲染成 tofu 方块、整行新增含 bold 时高亮整段静默丢失、##→### 会把
// heading 降级成段落并漏出裸 #）。
describe('MarkdownDiffView — 乱码 / 高亮丢失渲染回归', () => {
  const PUA_RE = /[\uE000-\uF8FF]/

  test('fence 内改行：DOM 文本无 PUA，新旧代码块都完整渲染', () => {
    const { container } = render(
      <MarkdownDiffView
        left={'intro\n\n```js\nconst b = 2\n```\n'}
        right={'intro\n\n```js\nconst b = 99\n```\n'}
      />,
    )
    expect(PUA_RE.test(container.textContent ?? '')).toBe(false)
    expect(container.querySelectorAll('pre').length).toBe(2)
    expect(container.textContent).toContain('const b = 2')
    expect(container.textContent).toContain('const b = 99')
  })

  test('line 模式 fence 内改行：DOM 文本无 PUA', () => {
    const { container } = render(
      <MarkdownDiffView
        left={'```js\nconst b = 2\n```\n'}
        right={'```js\nconst b = 99\n```\n'}
        granularity="line"
      />,
    )
    expect(PUA_RE.test(container.textContent ?? '')).toBe(false)
    expect(container.textContent).toContain('const b = 2')
    expect(container.textContent).toContain('const b = 99')
  })

  test('inline code 改词：diff span 完整包裹 <code>，无 PUA 泄漏', () => {
    const { container } = render(
      <MarkdownDiffView left={'run `foo bar` now'} right={'run `foo baz` now'} />,
    )
    expect(PUA_RE.test(container.textContent ?? '')).toBe(false)
    const del = container.querySelector('.diff-del')
    const ins = container.querySelector('.diff-ins')
    expect(del?.querySelector('code')?.textContent).toBe('foo bar')
    expect(ins?.querySelector('code')?.textContent).toBe('foo baz')
  })

  test('整行新增含 **bold**：整行进 .diff-ins（跨节点高亮不再丢失）', () => {
    const { container } = render(
      <MarkdownDiffView
        left={'stable'}
        right={'stable\nnew line with **bold** words'}
        granularity="line"
      />,
    )
    const ins = container.querySelector('.diff-ins')
    expect(ins).not.toBeNull()
    expect(ins?.querySelector('strong')?.textContent).toBe('bold')
    expect(ins?.textContent).toBe('new line with bold words')
  })

  test('heading 级别变化 ##→###：渲染成两个合法 heading，无裸 #', () => {
    const { container } = render(<MarkdownDiffView left={'## Title'} right={'### Title'} />)
    const h2 = container.querySelector('h2')
    const h3 = container.querySelector('h3')
    expect(h2?.querySelector('.diff-del')).not.toBeNull()
    expect(h3?.querySelector('.diff-ins')).not.toBeNull()
    // rehype-autolink-headings 会给 heading 追加 '#' 锚点文本，因此不能
    // 断 textContent 无 '#'；断"没有降级成段落"即可锁住旧 bug 形态。
    expect(container.querySelector('p')).toBeNull()
  })

  test('CJK 词级：审查→评审 无逐字交错（del/ins 各自完整成段）', () => {
    if (typeof Intl.Segmenter !== 'function') return
    const { container } = render(
      <MarkdownDiffView left={'本轮代码审查通过'} right={'本轮代码评审通过'} />,
    )
    const del = Array.from(container.querySelectorAll('.diff-del'))
      .map((n) => n.textContent ?? '')
      .join('')
    const ins = Array.from(container.querySelectorAll('.diff-ins'))
      .map((n) => n.textContent ?? '')
      .join('')
    expect(del).toBe('审查')
    expect(ins).toBe('评审')
  })
})
