// RFC-326 D5 — offset-based review highlighting (proposal AC-28 / AC-29; design §9).
//
// WHY THIS FILE EXISTS (regression intent):
//   - The web page used to locate a comment by text + occurrence number computed
//     over the RENDERED text, so a quote that also appears earlier in a code span,
//     a heading or a link, or a source with escapes / entities, highlighted the
//     wrong place (or nothing). The page now projects the stored SOURCE offsets
//     through react-markdown's `position` data with a token-aware alignment
//     (inline-code backticks, `\` escapes, `&…;` entities). Turning the alignment
//     into a plain subtraction (mutation evidence ⑥, plan §3) turns the inline
//     code / escape / entity cases red.
//   - Ranges that never render (link targets, HTML comments, reference
//     definitions) and KaTeX output stay UNLOCATED (no wrong `<mark>`); fenced
//     code hands its ranges to the code element and CodeBlock renders them via
//     shiki decorations (crossing ranges made atomic) or plain `<mark>` slices;
//     unpositioned visible text (GitHub alert first paragraph) falls back to a
//     windowed text match; the merged-diff view stays on text mode; a body swap
//     re-projects (the plugin chain depends on the body now); the indexes are
//     built once per render.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { findAllOccurrences } from '@agent-workflow/shared'
import { atomicAnchorSegments } from '@/components/prose/CodeBlock'
import { __setHighlighterForTests } from '@/components/prose/highlighter'
import { Prose } from '@/components/prose/Prose'
import {
  alignValueToSource,
  nonRenderedSpans,
  rehypeWrapAnchors,
  resolveSourceRange,
  type AnchorWrapInput,
} from '@/components/prose/rehypeWrapAnchors'
import { MarkdownDiffView } from '@/components/review/MarkdownDiffView'

/** Anchor for the `n`-th (1-based, non-overlapping) occurrence of `quote` in `body`. */
function anchorFor(
  body: string,
  quote: string,
  n = 1,
  commentId = `c-${quote}-${n}`,
): AnchorWrapInput {
  const offsets = findAllOccurrences(body, quote)
  const start = offsets[n - 1]
  if (start === undefined) throw new Error(`fixture: '${quote}' #${n} not in body`)
  return {
    commentId,
    selectedText: quote,
    occurrenceIndex: n,
    offsetStart: start,
    offsetEnd: start + quote.length,
  }
}

function marks(container: HTMLElement, commentId?: string): HTMLElement[] {
  const sel =
    commentId === undefined
      ? 'mark.comment-anchor'
      : `mark.comment-anchor[data-comment-id="${commentId}"]`
  return Array.from(container.querySelectorAll<HTMLElement>(sel))
}

function markedText(container: HTMLElement, commentId?: string): string {
  return marks(container, commentId)
    .map((m) => m.textContent ?? '')
    .join('|')
}

describe('RFC-326 AC-28 — source offsets land on the rendered text', () => {
  test('inline code: the quote inside backticks is marked, the backticks are not rendered', () => {
    const body = 'Use `order_status` here, not order_status there.\n'
    // The FIRST occurrence sits inside the code span; text-mode would also pick
    // the first rendered occurrence, so also pin the SECOND (plain) one.
    const inCode = anchorFor(body, 'order_status', 1, 'in-code')
    const plain = anchorFor(body, 'order_status', 2, 'plain')
    const { container } = render(<Prose body={body} anchors={[inCode, plain]} />)
    const codeMark = container.querySelector('code mark.comment-anchor')
    expect(codeMark?.getAttribute('data-comment-id')).toBe('in-code')
    expect(codeMark?.textContent).toBe('order_status')
    expect(markedText(container, 'plain')).toBe('order_status')
    expect(marks(container, 'plain')[0]!.closest('code')).toBeNull()
  })

  test('backslash escapes: the source quote `\\_b\\_` marks the rendered `_b_`', () => {
    const body = 'keep \\_b\\_ as is\n'
    const a = anchorFor(body, '\\_b\\_')
    const { container } = render(<Prose body={body} anchors={[a]} />)
    expect(markedText(container)).toBe('_b_')
    expect(container.textContent).toContain('keep _b_ as is')
  })

  test('entities (named, decimal, hex): the source quote marks the decoded characters', () => {
    const body = 'Tom &amp; Jerry &lt;3 &#169; &#xA9; &copy; &quot;q&quot; &nbsp;x\n'
    const cases: Array<[string, string]> = [
      ['&amp; Jerry', '& Jerry'],
      ['&lt;3', '<3'],
      ['&#169;', '©'],
      ['&#xA9;', '©'],
      ['&copy;', '©'],
      ['&quot;q&quot;', '"q"'],
      ['&nbsp;x', ' x'],
    ]
    const anchors = cases.map(([quote], i) => anchorFor(body, quote, 1, `e${i}`))
    const { container } = render(<Prose body={body} anchors={anchors} />)
    for (const [i, [, rendered]] of cases.entries()) {
      expect(markedText(container, `e${i}`), cases[i]![0]).toBe(rendered)
    }
  })

  test('a quote across inline nodes and across paragraphs yields one mark per text node', () => {
    const body = '**bold** and plain\n\nsecond paragraph here\n'
    const across = anchorFor(body, 'bold** and', 1, 'across')
    const paragraphs = anchorFor(body, 'plain\n\nsecond', 1, 'paras')
    const { container } = render(<Prose body={body} anchors={[across, paragraphs]} />)
    expect(markedText(container, 'across')).toBe('bold| and')
    expect(marks(container, 'across')[0]!.closest('strong')).not.toBeNull()
    expect(markedText(container, 'paras')).toBe('plain|second')
  })

  test('a heading with inline code: marks skip the autolink `#` and cover the code text', () => {
    const body = '# Title with `code` inside\n\nbody text\n'
    const a = anchorFor(body, 'with `code` inside')
    const { container } = render(<Prose body={body} anchors={[a]} />)
    expect(markedText(container)).toBe('with |code| inside')
    expect(container.querySelector('a.prose__anchor mark')).toBeNull()
  })

  test('legacy rows (no offsets) project the N-th non-overlapping occurrence', () => {
    const body = 'aaaa and aaaa\n'
    const { container } = render(
      <Prose
        body={body}
        anchors={[{ commentId: 'legacy', selectedText: 'aa', occurrenceIndex: 2 }]}
      />,
    )
    // Non-overlapping occurrences of 'aa' in 'aaaa and aaaa': 0, 2, 9, 11 → #2 is chars 2-3.
    const m = marks(container, 'legacy')
    expect(m.length).toBe(1)
    expect(m[0]!.textContent).toBe('aa')
    // The first 'aa' stays bare text; the mark is the second non-overlapping pair.
    expect(container.querySelector('p')!.innerHTML.startsWith('aa<mark')).toBe(true)
  })

  test('stored offsets that do not match the text fall back to the occurrence; unknown text falls back to text mode', () => {
    const body = 'alpha beta alpha\n'
    const drifted: AnchorWrapInput = {
      commentId: 'drift',
      selectedText: 'alpha',
      occurrenceIndex: 2,
      offsetStart: 3, // not where 'alpha' is
      offsetEnd: 8,
    }
    const { container } = render(<Prose body={body} anchors={[drifted]} />)
    expect(marks(container, 'drift').length).toBe(1)
    const p = container.querySelector('p')!
    expect(p.innerHTML.indexOf('<mark')).toBeGreaterThan('alpha beta '.length - 1)
  })
})

describe('RFC-326 AC-29 — what must NOT be highlighted, and the fallbacks', () => {
  test('link targets, HTML comments and reference definitions stay unlocated', () => {
    const body =
      'see [docs](https://example.com/path) now\n\n<!-- hidden note here -->\n\n[ref]: https://example.com/ref\n\nvisible text\n'
    const anchors = [
      anchorFor(body, 'example.com/path', 1, 'link'),
      anchorFor(body, 'hidden note', 1, 'comment'),
      anchorFor(body, 'example.com/ref', 1, 'refdef'),
      anchorFor(body, 'visible text', 1, 'ok'),
    ]
    const { container } = render(<Prose body={body} anchors={anchors} />)
    expect(marks(container, 'link')).toEqual([])
    expect(marks(container, 'comment')).toEqual([])
    expect(marks(container, 'refdef')).toEqual([])
    expect(markedText(container, 'ok')).toBe('visible text')
    expect(nonRenderedSpans(body).length).toBe(3)
  })

  test('KaTeX output is never marked', () => {
    const body = 'inline $x^2$ math\n\n$$\ny^2\n$$\n'
    const anchors = [anchorFor(body, 'x^2', 1, 'inline'), anchorFor(body, 'y^2', 1, 'block')]
    const { container } = render(<Prose body={body} anchors={anchors} />)
    expect(container.querySelector('.katex')).not.toBeNull()
    expect(marks(container)).toEqual([])
  })

  test('GitHub alert first paragraph (no source position): windowed text fallback', () => {
    const body = '> [!NOTE]\n> alert body text here\n\nafter the alert\n'
    const anchors = [
      anchorFor(body, 'alert body', 1, 'alert'),
      anchorFor(body, 'after the', 1, 'after'),
    ]
    const { container } = render(<Prose body={body} anchors={anchors} />)
    expect(markedText(container, 'alert')).toBe('alert body')
    expect(marks(container, 'alert')[0]!.closest('.markdown-alert')).not.toBeNull()
    expect(markedText(container, 'after')).toBe('after the')
  })

  test('mermaid blocks are not highlighted', () => {
    const body = '```mermaid\ngraph TD; A-->B\n```\n'
    const a = anchorFor(body, 'A-->B')
    const { container } = render(<Prose body={body} anchors={[a]} />)
    expect(marks(container)).toEqual([])
  })
})

describe('RFC-326 AC-29 — fenced code (P15)', () => {
  const codeToHtml = vi.fn(
    (
      source: string,
      opts: {
        lang: string
        decorations?: Array<{ start: number; end: number; properties: Record<string, string> }>
      },
    ) => {
      // Deterministic stand-in: wrap decorated ranges exactly like shiki would.
      let html = ''
      let cursor = 0
      for (const d of [...(opts.decorations ?? [])].sort((a, b) => a.start - b.start)) {
        html += source.slice(cursor, d.start)
        html += `<mark class="${d.properties['class']}" data-comment-id="${d.properties['data-comment-id']}">${source.slice(d.start, d.end)}</mark>`
        cursor = d.end
      }
      html += source.slice(cursor)
      return `<pre class="shiki" data-stub-lang="${opts.lang}"><code>${html}</code></pre>`
    },
  )
  beforeEach(() => {
    codeToHtml.mockClear()
    __setHighlighterForTests(Promise.resolve({ codeToHtml } as never))
  })
  afterEach(() => {
    __setHighlighterForTests(null)
  })

  test('shiki path: the range reaches codeToHtml as a decoration and the final DOM carries the mark', async () => {
    const body = 'intro\n\n```ts\nconst x = 1\nconst y = 2\n```\n\nafter\n'
    const a = anchorFor(body, 'x = 1', 1, 'code-a')
    const { container } = render(<Prose body={body} anchors={[a]} />)
    await waitFor(() => {
      expect(container.querySelector('[data-prose-code="ts"] pre.shiki')).not.toBeNull()
    })
    const call = codeToHtml.mock.calls[0]!
    expect(call[0]).toBe('const x = 1\nconst y = 2')
    expect(call[1].decorations).toEqual([
      expect.objectContaining({
        start: 'const '.length,
        end: 'const x = 1'.length,
        tagName: 'mark',
        properties: expect.objectContaining({ 'data-comment-id': 'code-a' }),
      }),
    ])
    const m = container.querySelector('[data-prose-code="ts"] mark.comment-anchor')
    expect(m?.textContent).toBe('x = 1')
    expect(m?.getAttribute('data-comment-id')).toBe('code-a')
  })

  test('plain fallback (unsupported language): <mark> slices, multi-line range', () => {
    const body = '```fooz\nline one\nline two\n```\n'
    const a = anchorFor(body, 'one\nline', 1, 'span')
    const { container } = render(<Prose body={body} anchors={[a]} />)
    const fallback = container.querySelector('pre.prose__code-fallback')
    expect(fallback).not.toBeNull()
    const m = fallback!.querySelector('mark.comment-anchor')
    expect(m?.textContent).toBe('one\nline')
    expect(codeToHtml).not.toHaveBeenCalled()
    expect(fallback!.textContent).toBe('line one\nline two')
  })

  test('atomic segments: crossing, containing, adjacent ranges never intersect', () => {
    const segs = atomicAnchorSegments(
      [
        { start: 0, end: 5, commentId: 'a' },
        { start: 3, end: 8, commentId: 'b' },
        { start: 8, end: 10, commentId: 'c' },
        { start: 20, end: 30, commentId: 'outer' },
        { start: 22, end: 25, commentId: 'inner' },
        { start: 40, end: 99, commentId: 'clipped' },
      ],
      50,
    )
    expect(segs).toEqual([
      { start: 0, end: 3, commentId: 'a', commentIds: ['a'] },
      { start: 3, end: 5, commentId: 'a', commentIds: ['a', 'b'] },
      { start: 5, end: 8, commentId: 'b', commentIds: ['b'] },
      { start: 8, end: 10, commentId: 'c', commentIds: ['c'] },
      { start: 20, end: 22, commentId: 'outer', commentIds: ['outer'] },
      { start: 22, end: 25, commentId: 'outer', commentIds: ['outer', 'inner'] },
      { start: 25, end: 30, commentId: 'outer', commentIds: ['outer'] },
      { start: 40, end: 50, commentId: 'clipped', commentIds: ['clipped'] },
    ])
    for (let i = 1; i < segs.length; i++)
      expect(segs[i]!.start).toBeGreaterThanOrEqual(segs[i - 1]!.end)
  })
})

describe('RFC-326 — text mode is untouched where the document is not the anchor source', () => {
  test('MarkdownDiffView keeps prior anchors on text matching', () => {
    const left = 'alpha beta\n'
    const right = 'alpha beta gamma\n'
    const { container } = render(
      <MarkdownDiffView
        left={left}
        right={right}
        granularity="line"
        priorAnchors={[
          {
            commentId: 'p1',
            selectedText: 'beta',
            occurrenceIndex: 1,
            offsetStart: 6,
            offsetEnd: 10,
          },
        ]}
      />,
    )
    const m = container.querySelectorAll('mark.prior-comment-anchor')
    expect(m.length).toBeGreaterThan(0)
    expect(m[0]!.textContent).toBe('beta')
  })

  test('non-overlapping occurrence counting is the shared one', () => {
    expect(findAllOccurrences('aaaa', 'aa')).toEqual([0, 2])
    const body = 'aaaa\n'
    const { container } = render(
      <Prose body={body} anchors={[{ commentId: 'x', selectedText: 'aa', occurrenceIndex: 2 }]} />,
    )
    expect(container.querySelector('p')!.innerHTML).toBe(
      'aa<mark class="comment-anchor" data-comment-id="x">aa</mark>',
    )
  })
})

describe('RFC-326 — the chain follows the body, and the work is bounded', () => {
  test('re-rendering with a new body and the same comments re-projects onto the new body', () => {
    const bodyA = 'one two three\n'
    const bodyB = 'zero one two three\n'
    const anchors = [anchorFor(bodyA, 'two', 1, 'k')]
    const { container, rerender } = render(<Prose body={bodyA} anchors={anchors} />)
    expect(markedText(container, 'k')).toBe('two')
    // Same anchors object, new body: the offsets (4..7) now point at "one" in bodyB,
    // so the stored text no longer matches → falls back to the occurrence → still "two".
    rerender(<Prose body={bodyB} anchors={anchors} />)
    expect(markedText(container, 'k')).toBe('two')
    expect(container.textContent).toContain('zero one two three')
  })

  test('alignment runs once per text node and occurrence scans at most once per anchor text', () => {
    const body = 'alpha beta gamma delta\n'
    const stats = { alignments: 0, occurrenceScans: 0 }
    const plugin = rehypeWrapAnchors({
      anchors: [
        anchorFor(body, 'alpha', 1, 'a'),
        anchorFor(body, 'gamma', 1, 'g'),
        { commentId: 'legacy', selectedText: 'delta', occurrenceIndex: 1 },
        { commentId: 'legacy2', selectedText: 'delta', occurrenceIndex: 1 },
      ],
      mode: 'source-offset',
      sourceBody: body,
      __stats: stats,
    })
    interface Node {
      type: string
      tagName?: string
      value?: string
      position?: { start: { offset: number }; end: { offset: number } }
      children?: Node[]
    }
    const text: Node = {
      type: 'text',
      value: 'alpha beta gamma delta',
      position: { start: { offset: 0 }, end: { offset: 22 } },
    }
    const tree: Node = {
      type: 'root',
      children: [{ type: 'element', tagName: 'p', children: [text] }],
    }
    plugin(tree as never)
    expect(stats.alignments).toBe(1) // three anchors, one text node
    // RFC-326 实现门 P1#8:带 offset 的锚**也**要走这条记忆化扫描——此前自洽校验在
    // resolveSourceRange 里自己 `body.indexOf` 重扫,统计看不到、成本也真实存在
    // (O(anchors × body))。现在按「不同引文」计数:alpha / gamma / delta 三种。
    expect(stats.occurrenceScans).toBe(3)
    const p = tree.children![0]!
    expect(p.children!.filter((c) => c.type === 'element' && c.tagName === 'mark').length).toBe(3)
  })

  test('alignValueToSource: equal chars, escape token, entity token, skipped source', () => {
    const src = '`a b` \\* &amp; x'
    const value = 'a b * & x'
    const map = alignValueToSource(value, src, 100)
    // 'a'→101 ' '→102 'b'→103; the closing backtick (104) is skipped; ' '→105;
    // '*' comes from the escape token at 106; ' '→108; '&' from `&amp;` at 109;
    // ' '→114; 'x'→115.
    expect(Array.from(map)).toEqual([101, 102, 103, 105, 106, 108, 109, 114, 115])
  })

  test('resolveSourceRange: consistent → stored range; text-only match → occurrence; absent → null', () => {
    const body = 'x y x y x'
    const occ = (t: string) => findAllOccurrences(body, t)
    expect(
      resolveSourceRange(
        body,
        { commentId: 'c', selectedText: 'x', occurrenceIndex: 2, offsetStart: 4, offsetEnd: 5 },
        occ,
      ),
    ).toEqual({ start: 4, end: 5 })
    expect(
      resolveSourceRange(
        body,
        { commentId: 'c', selectedText: 'x', occurrenceIndex: 3, offsetStart: 4, offsetEnd: 5 },
        occ,
      ),
    ).toEqual({ start: 8, end: 9 })
    expect(
      resolveSourceRange(body, { commentId: 'c', selectedText: 'zzz', occurrenceIndex: 1 }, occ),
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// RFC-326 实现门(PR-B)findings 的回归锁。每条都先红后绿,注释写明它锁的是哪一条。
// ---------------------------------------------------------------------------
describe('RFC-326 实现门 —— 偏移对齐的边界修复', () => {
  test('P1#1 非法数字实体解成 U+FFFD 而不是把整个渲染炸掉', () => {
    // `String.fromCodePoint(0x110000)` 抛 RangeError。它跑在 rehype 插件里,
    // 设计文档里出现这么一个字面量就会白屏——而实体字面量正是评审文档的常客。
    const body = 'edge &#x110000; and &#xD800; and &#0; done\n'
    const a = anchorFor(body, 'edge')
    expect(() => render(<Prose body={body} anchors={[a]} />)).not.toThrow()
    const { container } = render(<Prose body={body} anchors={[a]} />)
    expect(markedText(container)).toBe('edge')
    expect(container.textContent).toContain('\uFFFD')
  })

  test('P1#6 窗口兜底钉的是这条锚自己的那一次(x and x)', () => {
    // GitHub alert 首段没有 position,走窗口内文本匹配。此前恒取第一次,于是
    // 第二条意见与第一条高亮在同一处,两个气泡指向同一个字。
    const body = '> [!NOTE]\n> x and x here\n\nafter\n'
    const first = anchorFor(body, 'x and', 1, 'first')
    const second = anchorFor(body, 'x here', 1, 'second')
    const { container } = render(<Prose body={body} anchors={[first, second]} />)
    const one = marks(container, 'first')[0]!
    const two = marks(container, 'second')[0]!
    expect(one.textContent).toBe('x and')
    expect(two.textContent).toBe('x here')
    // 两段 mark 必须落在不同位置(而不是同一个 x 上叠两次)。
    expect(one.compareDocumentPosition(two) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test('P1#3 无语言围栏块里的代码锚照样出 mark', () => {
    // 此前 makeCode 在 lang === '' 分支里 return 得比读 data-anchor-ranges 还早,
    // rehype 明明算出了区间,页面上什么都不亮。
    const body = 'intro\n\n```\nconst orderStatus = "x"\n```\n'
    const a = anchorFor(body, 'orderStatus')
    const { container } = render(<Prose body={body} anchors={[a]} />)
    const mark = container.querySelector<HTMLElement>('pre code mark.comment-anchor')
    expect(mark, '无语言围栏块应当带上锚 mark').not.toBeNull()
    expect(mark!.textContent).toBe('orderStatus')
    expect(mark!.getAttribute('data-comment-id')).toBe(a.commentId)
  })

  test('P1#2 围栏里的引用定义 / HTML 注释是可见正文,不是「永不渲染」', () => {
    // 此前 nonRenderedSpans 整篇平扫:围栏里写 `[ref]: …` 或 `<!-- … -->`,落在那儿的
    // 锚点会在进入代码块交接之前被判成不渲染直接丢掉,页面上一个 mark 都没有。
    const body = 'intro\n\n```\n[ref]: https://inside.example\n<!-- visible code -->\n```\n'
    const refDef = anchorFor(body, 'https://inside.example', 1, 'ref')
    const comment = anchorFor(body, 'visible code', 1, 'cmt')
    const { container } = render(<Prose body={body} anchors={[refDef, comment]} />)
    expect(markedText(container, 'ref')).toBe('https://inside.example')
    expect(markedText(container, 'cmt')).toBe('visible code')
  })

  test('P1#2 围栏外的引用定义 / 注释仍然是不渲染区间(守卫的守卫)', () => {
    const body = 'see [x]\n\n[x]: https://outside.example\n\n<!-- hidden -->\n\ntail\n'
    const outside = anchorFor(body, 'https://outside.example', 1, 'out')
    const hidden = anchorFor(body, 'hidden', 1, 'hid')
    const { container } = render(<Prose body={body} anchors={[outside, hidden]} />)
    expect(marks(container, 'out')).toHaveLength(0)
    expect(marks(container, 'hid')).toHaveLength(0)
  })

  test('P1#4 缩进围栏 + CRLF:代码块偏移逐行换算,不是减掉第一行', () => {
    // `  ```ts` 的内容行按 CommonMark 每行剥掉至多 2 个前导空格,减法版会整体错位
    // 并逐行累积;CRLF 又让源文的换行比 value 多一个字符。
    const body = 'intro\r\n\r\n  ```ts\r\n  const a = 1\r\n  const bbb = 2\r\n  ```\r\n'
    const a = anchorFor(body, 'bbb', 1, 'deep')
    const { container } = render(<Prose body={body} anchors={[a]} />)
    const mark = container.querySelector<HTMLElement>('pre code mark.comment-anchor')
    expect(mark, '缩进 + CRLF 围栏里的锚点应当命中').not.toBeNull()
    expect(mark!.textContent).toBe('bbb')
  })

  test('P1#4 波浪线围栏与更长的开标记同样逐行换算', () => {
    const body = 'intro\n\n~~~~\nalpha beta\n~~~~\n'
    const a = anchorFor(body, 'beta', 1, 'tilde')
    const { container } = render(<Prose body={body} anchors={[a]} />)
    expect(container.querySelector('pre code mark.comment-anchor')?.textContent).toBe('beta')
  })

  test('P1#5 多行行内代码:换行被正规化成空格,换行后的引文照样命中', () => {
    // `` `foo\nbar` `` 渲染成 `foo bar`;此前换行之后的字符全部留在未映射状态,
    // 对 `bar` 的锚点一个 mark 都没有。
    const body = 'text `foo\nbar` tail\n'
    const a = anchorFor(body, 'bar', 1, 'wrapped')
    const { container } = render(<Prose body={body} anchors={[a]} />)
    const mark = container.querySelector<HTMLElement>('code mark.comment-anchor')
    expect(mark, '多行行内代码里换行后的引文应当命中').not.toBeNull()
    expect(mark!.textContent).toBe('bar')
  })

  test('P1#8 同一条引文的多个锚只扫一次(含带 offset 的锚)', () => {
    const body = 'alpha beta alpha\n'
    const stats = { alignments: 0, occurrenceScans: 0 }
    const plugin = rehypeWrapAnchors({
      anchors: [anchorFor(body, 'alpha', 1, 'a1'), anchorFor(body, 'alpha', 2, 'a2')],
      mode: 'source-offset',
      sourceBody: body,
      __stats: stats,
    })
    const text = {
      type: 'text',
      value: 'alpha beta alpha',
      position: { start: { offset: 0 }, end: { offset: 16 } },
    }
    plugin({
      type: 'root',
      children: [{ type: 'element', tagName: 'p', children: [text] }],
    } as never)
    expect(stats.occurrenceScans).toBe(1)
  })
})
