// RFC-240 — 词档表格 cell 级细化（C′）渲染级回归。
//
// 同结构键（表头 + 分隔符逐字节同）的表格配对后单表呈现：未变行零高亮、
// 变化 cell 内联红旧绿新、增删行整行红/绿（相似度配对 Dice≥0.5）。结构
// 变化 / 行块档 / 正文行为零改动。设计与取舍全录 design.md（v14，设计门
// 13 轮）；本文件按其 §测试策略 16 项落地，断言以渲染产物为准
// （docs/dev-gotchas.md §前端：字符串断言盲区教训）。

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render } from '@testing-library/react'
import { MarkdownDiffView } from '@/components/review/MarkdownDiffView'
import { buildMergedMarkdown, MARKERS, _internal } from '@/lib/review/markdownDiff'

const T = (rows: string[][]): string =>
  [
    '| 参数 | 默认值 | 说明 |',
    '| --- | --- | --- |',
    ...rows.map((r) => '| ' + r.join(' | ') + ' |'),
  ].join('\n') + '\n'

const pipeLeak = (el: HTMLElement) => (el.textContent ?? '').includes('|')
const rtl = (l: string, r: string) =>
  render(<MarkdownDiffView left={l} right={r} granularity="word" />)

describe('RFC-240 §1-3 单表 cell 级基础', () => {
  test('#1 单 cell 修改：恰 1 张表、变化 cell 同含红绿、其余零 span、无裸 |', () => {
    const l = T([
      ['alpha', '1', '首个参数'],
      ['beta', '2', '次参数'],
    ])
    const r = T([
      ['alpha', '1', '首个参数'],
      ['beta', '9', '次参数'],
    ])
    const { container } = rtl(l, r)
    expect(container.querySelectorAll('table').length).toBe(1)
    expect(pipeLeak(container)).toBe(false)
    expect(container.querySelector('.diff-del')?.textContent).toBe('2')
    expect(container.querySelector('.diff-ins')?.textContent).toBe('9')
    expect(container.querySelectorAll('.diff-del, .diff-ins').length).toBe(2)
  })

  test('#2a 多 cell / 多行修改互不串扰 + CJK', () => {
    const l = T([
      ['甲', '一', '说明甲'],
      ['乙', '二', '说明乙'],
    ])
    const r = T([
      ['甲', '壹', '说明甲'],
      ['乙', '二', '说明乙更新'],
    ])
    const { container } = rtl(l, r)
    expect(container.querySelectorAll('table').length).toBe(1)
    const dels = Array.from(container.querySelectorAll('.diff-del')).map((n) => n.textContent)
    const inss = Array.from(container.querySelectorAll('.diff-ins')).map((n) => n.textContent)
    expect(dels).toContain('一')
    expect(inss).toContain('壹')
    expect(inss.join('')).toContain('更新')
    // 未变 cell（说明甲）无 span
    const cleanTd = Array.from(container.querySelectorAll('td')).find(
      (td) => td.textContent === '说明甲',
    )
    expect(cleanTd?.querySelector('.diff-del, .diff-ins')).toBeNull()
  })

  test('#2b inline code cell：code span 结构完整、红旧绿新', () => {
    const l = T([['`id`', '1', '主键']])
    const r = T([['`uid`', '1', '主键']])
    const { container } = rtl(l, r)
    expect(container.querySelectorAll('table').length).toBe(1)
    expect(container.querySelector('.diff-del code')?.textContent).toBe('id')
    expect(container.querySelector('.diff-ins code')?.textContent).toBe('uid')
  })

  test('#2c 多反引号 code span（双反引号定界、内容含单反引号）', () => {
    const l = T([['``a `b``', 'x', 'y']])
    const r = T([['``a `c``', 'x', 'y']])
    const { container } = rtl(l, r)
    expect(container.querySelector('.diff-del code')?.textContent).toBe('a `b')
    expect(container.querySelector('.diff-ins code')?.textContent).toBe('a `c')
  })

  test('#2d 定界符-only 与混合变更 → cell 整体红绿、emphasis 结构保留', () => {
    const l = T([['k', '**same**', 'x']])
    const r = T([['k', '*same*', 'x']])
    const { container } = rtl(l, r)
    expect(container.querySelector('.diff-del strong')?.textContent).toBe('same')
    expect(container.querySelector('.diff-ins em')?.textContent).toBe('same')
    const l2 = T([['k', '**old**', 'x']])
    const r2 = T([['k', '*new*', 'x']])
    const { container: c2 } = rtl(l2, r2)
    expect(c2.querySelector('.diff-del strong')?.textContent).toBe('old')
    expect(c2.querySelector('.diff-ins em')?.textContent).toBe('new')
  })

  test('#2e 转义奇偶：\\\\ 后 code span 原子化生效、\\$x$ 字面不误原子化', () => {
    const l = T([['k', '\\\\`code`', 'x']])
    const r = T([['k', '\\\\`kode`', 'x']])
    const { container } = rtl(l, r)
    // 反斜杠转义对 + code span 都成原子，红旧绿新可见且无裸反引号泄漏
    expect(container.querySelector('.diff-del')).not.toBeNull()
    expect(container.querySelector('.diff-ins')).not.toBeNull()
    expect(container.textContent ?? '').not.toContain('`')
    const l2 = T([['k', '\\$x$ old', 'x']])
    const r2 = T([['k', '\\$x$ new', 'x']])
    const { container: c2 } = rtl(l2, r2)
    // `\$x$` 是字面文本：不产出 KaTeX；残留孤立 `$`（字面转义后剩的
    // 闭合美元）命中保守白名单 → 整 cell 红旧绿新（合法渲染、粒度变粗）
    expect(c2.querySelector('.katex')).toBeNull()
    expect(c2.querySelector('.diff-del')?.textContent).toContain('old')
    expect(c2.querySelector('.diff-ins')?.textContent).toContain('new')
    expect(c2.querySelector('.diff-ins')?.textContent).not.toContain('old')
  })

  test('#2f 列表容器内缩进表：cell 修改单表保持在容器内', () => {
    const mk = (v: string) => '- item\n\n  | a | b |\n  | --- | --- |\n  | 1 | ' + v + ' |\n'
    const { container } = rtl(mk('2'), mk('9'))
    expect(container.querySelector('li table')).not.toBeNull()
    expect(pipeLeak(container)).toBe(false)
    expect(container.querySelector('.diff-del')?.textContent).toBe('2')
    expect(container.querySelector('.diff-ins')?.textContent).toBe('9')
  })

  test('#3 行增/删、全空 cell 行与零 cell 行、短行', () => {
    const l = '| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n'
    const r = '| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n|   |   |   |\n'
    const { container } = rtl(l, r)
    expect(container.querySelectorAll('table').length).toBe(1)
    // 全空 cell 新增行：色块占位可见
    expect(container.querySelectorAll('.diff-ins').length).toBeGreaterThan(0)
    // 短行删除（cell 数少于声明列）
    const l2 = '| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| x |\n'
    const r2 = '| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n'
    const { container: c2 } = rtl(l2, r2)
    expect(c2.querySelectorAll('table').length).toBe(1)
    expect(c2.querySelector('.diff-del')?.textContent).toBe('x')
  })
})

describe('RFC-240 §4-7 配对、守卫与阶段 1 保障', () => {
  test('#4a 相似度配对：编辑行配原行；无关行不硬配（纯标点包装反例）', () => {
    const l = T([['甲', '乙', '丙']])
    const r = T([['丁', '戊', '己']])
    const merged = buildMergedMarkdown(l, r, 'word')
    // 无关行 → 整行 DEL + 整行 INS（不做 cell 级混排）
    const lines = merged.split('\n')
    const delLine = lines.find((x) => x.includes(MARKERS.DEL_OPEN))
    const insLine = lines.find((x) => x.includes(MARKERS.INS_OPEN))
    expect(delLine).toBeDefined()
    expect(insLine).toBeDefined()
    expect(delLine).not.toBe(insLine)
    // 纯标点包装：**甲** vs **乙** 内容 token 无交集 → 不配对
    const lp = T([['**甲**', 'x', 'y']])
    const rp = T([['**乙**', 'x', 'y']])
    const tokensL = _internal.contentTokens('**甲**')
    const tokensR = _internal.contentTokens('**乙**')
    expect(_internal.diceScore(tokensL, tokensR)).toBe(0)
    const { container } = rtl(lp, rp)
    expect(pipeLeak(container)).toBe(false)
  })

  test('#4b 单 cell 行仅 URL 变化（原子化后 Dice=0）→ 整行红/绿', () => {
    const l = '| u |\n| --- |\n| [API](https://old/a) |\n'
    const r = '| u |\n| --- |\n| [API](https://new/b) |\n'
    const { container } = rtl(l, r)
    expect(container.querySelectorAll('table').length).toBe(1)
    expect(container.querySelector('.diff-del')).not.toBeNull()
    expect(container.querySelector('.diff-ins')).not.toBeNull()
    expect(pipeLeak(container)).toBe(false)
  })

  test('#5 超列行 → 整对回退现行为（两张表）', () => {
    const l = '| a | b |\n| --- | --- |\n| 1 | 2 |\n'
    const r = '| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n'
    const { container } = rtl(l, r)
    expect(container.querySelectorAll('table').length).toBe(2)
  })

  test('#6 同键表前插同键新表：A、B 保持 context，仅 X 整绿', () => {
    const A = T([['a1', 'a2', 'a3']])
    const B = T([['b1', 'b2', 'b3']])
    const X = T([['x1', 'x2', 'x3']])
    const merged = buildMergedMarkdown(A + '\n' + B, X + '\n' + A + '\n' + B, 'word')
    expect(merged.includes(MARKERS.DEL_OPEN)).toBe(false)
    // A、B 的行以 context 形态原样存在
    expect(merged).toContain('| a1 | a2 | a3 |')
    expect(merged).toContain('| b1 | b2 | b3 |')
    expect(merged).toContain(MARKERS.INS_OPEN + 'x1' + MARKERS.INS_CLOSE)
  })

  test('#7 内容重复表（左 [A,A] 右 [X,A]）：无交叉配对', () => {
    const A = T([['same', 'same', 'same']])
    const X = T([['fresh', 'fresh', 'fresh']])
    const merged = buildMergedMarkdown(A + '\n' + A, X + '\n' + A, 'word')
    // 首 A 整红、X 整绿、次 A context——不会出现 cell 级混排（merged 行）
    expect(merged).toContain(MARKERS.DEL_OPEN + 'same' + MARKERS.DEL_CLOSE)
    expect(merged).toContain(MARKERS.INS_OPEN + 'fresh' + MARKERS.INS_CLOSE)
    expect(merged).toContain('| same | same | same |')
    // 无同行 del+ins 混排
    for (const line of merged.split('\n')) {
      expect(line.includes(MARKERS.DEL_OPEN) && line.includes(MARKERS.INS_OPEN)).toBe(false)
    }
  })

  test('#8 正文跨表移动：配对占位符落 del/ins → 优雅降级两张干净整表', () => {
    const A = T([
      ['alpha', '1', 'x'],
      ['beta', '2', 'y'],
    ])
    const B = T([
      ['alpha', '1', 'x'],
      ['beta', '9', 'y'],
    ])
    const l = '前置段落甲\n\n' + A
    const r = B + '\n后置段落甲\n'
    const { container } = rtl(l, r)
    expect(pipeLeak(container)).toBe(false)
    // 表以两侧完整形态呈现（现行为），无 |  |  | 指纹
    const merged = buildMergedMarkdown(l, r, 'word')
    expect(merged).not.toMatch(/^\|(\s*\|)+\s*$/m)
  })

  test('#9 C′ 单表后接字面 |---| body 行不被兜底重建拆开', () => {
    const l = '| h | i |\n| --- | --- |\n| x | 1 |\n| --- | --- |\n'
    const r = '| h | i |\n| --- | --- |\n| x | 9 |\n| --- | --- |\n'
    const { container } = rtl(l, r)
    expect(container.querySelectorAll('table').length).toBe(1)
    expect(container.querySelector('.diff-del')?.textContent).toBe('1')
    expect(container.querySelector('.diff-ins')?.textContent).toBe('9')
  })
})

describe('RFC-240 §10-16 保护集、守卫与不变量', () => {
  test('#10a URL-only cell（多列，其它 cell 提供相似度）→ 降级红绿、href 各自精确', () => {
    const l = T([['api', '[API](https://old/a)', '入口']])
    const r = T([['api', '[API](https://new/b)', '入口']])
    const { container } = rtl(l, r)
    expect(container.querySelectorAll('table').length).toBe(1)
    const delLink = container.querySelector('.diff-del a')
    const insLink = container.querySelector('.diff-ins a')
    expect(delLink?.getAttribute('href')).toBe('https://old/a')
    expect(insLink?.getAttribute('href')).toBe('https://new/b')
  })

  test('#10b 数学式 cell → 旧式红 + 新式绿（math 原子化）', () => {
    const l = T([['f', '$x+1$', 'y']])
    const r = T([['f', '$x-1$', 'y']])
    const { container } = rtl(l, r)
    expect(container.querySelector('.diff-del .katex')).not.toBeNull()
    expect(container.querySelector('.diff-ins .katex')).not.toBeNull()
  })

  test('#10c 嵌套原子（label 含 code span 的链接）循环还原无残留', () => {
    const l = T([['k', '[see `x`](https://a/1)', 'y']])
    const r = T([['k', '[see `x`](https://a/2)', 'y']])
    const { container } = rtl(l, r)
    expect(container.querySelector('.diff-del a code')?.textContent).toBe('x')
    expect(container.querySelector('.diff-ins a code')?.textContent).toBe('x')
    // 无占位符 / marker 泄漏
    expect(container.textContent ?? '').not.toMatch(/[-]/)
  })

  test('#10d 字面 autolink cell（含大写变体）→ 每侧独立着色、无拼接 href', () => {
    const l = T([['w', 'HTTPS://old.example.com', 'y']])
    const r = T([['w', 'HTTPS://new.example.com', 'y']])
    const { container } = rtl(l, r)
    expect(container.querySelector('.diff-del')).not.toBeNull()
    expect(container.querySelector('.diff-ins')).not.toBeNull()
    for (const a of Array.from(container.querySelectorAll('a'))) {
      const href = a.getAttribute('href') ?? ''
      expect(href.includes('old') && href.includes('new')).toBe(false)
    }
  })

  test('#11 表内重复行改写（[A,A]→[X,A]）→ 整行 DEL + 整行 INS（run 边界语义）', () => {
    const l = '| c |\n| --- |\n| same |\n| same |\n'
    const r = '| c |\n| --- |\n| fresh |\n| same |\n'
    const merged = buildMergedMarkdown(l, r, 'word')
    for (const line of merged.split('\n')) {
      expect(line.includes(MARKERS.DEL_OPEN) && line.includes(MARKERS.INS_OPEN)).toBe(false)
    }
  })

  test('#12 合并行骨架：cell 数 2→3 尾列绿可见、3→2 被删尾列红可见', () => {
    const l = '| a | b | c |\n| --- | --- | --- |\n| k1 | v1 |\n'
    const r = '| a | b | c |\n| --- | --- | --- |\n| k1 | v1 | extra |\n'
    const { container } = rtl(l, r)
    expect(container.querySelectorAll('table').length).toBe(1)
    expect(
      Array.from(container.querySelectorAll('.diff-ins'))
        .map((n) => n.textContent ?? '')
        .join(''),
    ).toContain('extra')
    const { container: c2 } = rtl(r, l)
    expect(
      Array.from(c2.querySelectorAll('.diff-del'))
        .map((n) => n.textContent ?? '')
        .join(''),
    ).toContain('extra')
  })

  test('#13 splitTableCells 奇偶切分、无首 pipe 分隔行、含 \\| cell 的变更', () => {
    // 偶数反斜杠 + | = 真边界（旧 (?<!\\) 误判）
    expect(_internal.splitTableCells('a\\\\|b')).toEqual(['a\\\\', 'b'])
    // 奇数反斜杠 = 字面
    expect(_internal.splitTableCells('a\\|b')).toEqual(['a\\|b'])
    // 无首 pipe 分隔行：cell 计数正确、仍走细化（单表）
    const l = '| a | b |\n---|---\n| 1 | 2 |\n'
    const r = '| a | b |\n---|---\n| 1 | 9 |\n'
    const { container } = rtl(l, r)
    expect(container.querySelectorAll('table').length).toBe(1)
    expect(container.querySelector('.diff-ins')?.textContent).toBe('9')
    // cell 含字面 \| 的行编辑：转义对不被 marker 劈开、列数不变
    const l2 = '| k | v |\n| --- | --- |\n| a\\|b | old |\n'
    const r2 = '| k | v |\n| --- | --- |\n| a\\|b | new |\n'
    const { container: c2 } = rtl(l2, r2)
    expect(c2.querySelectorAll('table').length).toBe(1)
    expect(c2.querySelectorAll('thead th').length).toBe(2)
    expect(c2.querySelector('.diff-del')?.textContent).toBe('old')
    expect(c2.querySelector('.diff-ins')?.textContent).toBe('new')
  })

  test('#14a fail-safe：注入桩 allocator 伪造残留 → 整对回退（null）', () => {
    const A = '| a |\n| --- |\n| `x` old |\n'
    const B = '| a |\n| --- |\n| `x` new |\n'
    // 桩：lookup 永远查不到内容 → restoreLocal 无法达成不动点
    class StubAlloc extends _internal.PlaceholderAllocator {
      override alloc(kind: string, content: string, pad: boolean): string | null {
        const ph = super.alloc(kind, content, pad)
        if (ph !== null) this.lookup.delete(ph)
        return ph
      }
    }
    const out = _internal.intraTableDiff(A, B, () => new StubAlloc([A, B]))
    expect(out).toBeNull()
  })

  test('#14b 文档自带 U+E010 的 cell 不误判残留（仍细化）', () => {
    const pua = String.fromCodePoint(0xe010)
    const l = '| k | v |\n| --- | --- |\n| ' + pua + 'x | old |\n'
    const r = '| k | v |\n| --- | --- |\n| ' + pua + 'x | new |\n'
    const { container } = rtl(l, r)
    expect(container.querySelectorAll('table').length).toBe(1)
    expect(container.querySelector('.diff-del')?.textContent).toBe('old')
    expect(container.querySelector('.diff-ins')?.textContent).toBe('new')
  })

  test('#14c 两张同键表同时进入阶段 2 → 各自还原为各自的 merged 表', () => {
    const A1 = T([['p', 'AAA', 'r']])
    const A2 = T([['s', 'BBB', 'u']])
    const B1 = T([['p', 'XXX', 'r']])
    const B2 = T([['s', 'YYY', 'u']])
    const merged = buildMergedMarkdown(A1 + '\n' + A2, B1 + '\n' + B2, 'word')
    expect(merged).toContain(MARKERS.INS_OPEN + 'XXX' + MARKERS.INS_CLOSE)
    expect(merged).toContain(MARKERS.INS_OPEN + 'YYY' + MARKERS.INS_CLOSE)
    expect(merged).toContain(MARKERS.DEL_OPEN + 'AAA' + MARKERS.DEL_CLOSE)
    expect(merged).toContain(MARKERS.DEL_OPEN + 'BBB' + MARKERS.DEL_CLOSE)
  })

  test('#15 identical 不变量与既有锁定同形（含配对表混排文档）', () => {
    const doc = '# T\n\n段落甲\n\n' + T([['a', 'b', 'c']]) + '\n> 引用\n\n' + T([['x', 'y', 'z']])
    expect(buildMergedMarkdown(doc, doc, 'word')).toBe(doc)
    expect(buildMergedMarkdown(doc, doc, 'line')).toBe(doc)
    expect(buildMergedMarkdown(doc, doc, 'block').trim()).toBe(doc.trim())
  })

  test('#16a 行数守卫源码序锁：intraTableDiff 内行数守卫先于首个 diffArrays', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/review/markdownDiff.ts'), 'utf-8')
    const fnStart = src.indexOf('function intraTableDiff(')
    expect(fnStart).toBeGreaterThan(0)
    const body = src.slice(fnStart)
    const guardIdx = body.indexOf('CELL_MAX_ROWS) return null')
    const lcsIdx = body.indexOf('diffArrays<')
    expect(guardIdx).toBeGreaterThan(0)
    expect(lcsIdx).toBeGreaterThan(0)
    expect(guardIdx).toBeLessThan(lcsIdx)
  })

  test('#16b line / block 路径防误伤：line 档同键 cell 修改仍为行级红绿', () => {
    const l = T([
      ['alpha', '1', 'x'],
      ['beta', '2', 'y'],
    ])
    const r = T([
      ['alpha', '1', 'x'],
      ['beta', '9', 'y'],
    ])
    const { container } = render(<MarkdownDiffView left={l} right={r} granularity="line" />)
    const tables = container.querySelectorAll('table')
    expect(tables.length).toBe(1)
    // line 档保持行级 DEL 行 + INS 行相邻语义（非 cell 级内联）
    const rows = tables[0]?.querySelectorAll('tbody tr') ?? []
    expect(rows.length).toBe(3)
  })
})
