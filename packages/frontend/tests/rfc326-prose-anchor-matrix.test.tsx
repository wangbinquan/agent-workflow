// RFC-326 实现门(PR-B)P2#15 —— design §13 要求的「集成层」矩阵:把一份**真实文档**
// 交给评审文档面用的同一条渲染链(`<Prose body anchors>`),逐类块型检查锚点落点。
//
// 为什么单独一个文件:偏移对齐的单测(rehype-wrap-anchors-offset)锁的是算法,
// 这里锁的是**产品面**——换一篇正文要重投影、公式块一律不高亮但意见本身不能丢、
// 图表块不许因为锚点而崩、脚注与硬换行这类「可见但没有 position」的文本要能定位。
// 页面级(侧栏条目 + shiki 真高亮)由 e2e/rfc326-mcp-review-tools.spec.ts 覆盖。

import { describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { findAllOccurrences } from '@agent-workflow/shared'
import { Prose } from '@/components/prose/Prose'
import type { AnchorWrapInput } from '@/components/prose/rehypeWrapAnchors'

function anchorFor(body: string, quote: string, n = 1, commentId = `c-${n}`): AnchorWrapInput {
  const start = findAllOccurrences(body, quote)[n - 1]
  if (start === undefined) throw new Error(`fixture: '${quote}' #${n} not in body`)
  return {
    commentId,
    selectedText: quote,
    occurrenceIndex: n,
    offsetStart: start,
    offsetEnd: start + quote.length,
  }
}

function markTexts(container: HTMLElement, commentId?: string): string[] {
  const sel =
    commentId === undefined
      ? 'mark.comment-anchor'
      : `mark.comment-anchor[data-comment-id="${commentId}"]`
  return [...container.querySelectorAll<HTMLElement>(sel)].map((m) => m.textContent ?? '')
}

describe('RFC-326 §13 集成矩阵 —— 换正文', () => {
  test('切换到另一篇文档:旧锚点不再出现,新锚点按新正文投影', () => {
    const first = '# One\n\nalpha here\n'
    const second = '# Two\n\nbeta there\n'
    const { container, rerender } = render(
      <Prose body={first} anchors={[anchorFor(first, 'alpha', 1, 'a')]} />,
    )
    expect(markTexts(container, 'a')).toEqual(['alpha'])
    rerender(<Prose body={second} anchors={[anchorFor(second, 'beta', 1, 'b')]} />)
    expect(markTexts(container, 'a')).toEqual([])
    expect(markTexts(container, 'b')).toEqual(['beta'])
  })
})

describe('RFC-326 §13 集成矩阵 —— 不高亮但不丢的块型', () => {
  test('公式:KaTeX 输出一律不高亮(零 mark),渲染本身不受影响', () => {
    // design §9.4 / 三轮设计门 F8:KaTeX 的 DOM 是渲染产物,往里插 mark 会破坏它。
    // 意见不因此消失——它在侧栏里仍然是一条(未定位),这一半由 e2e / 气泡布局覆盖。
    const body = 'before\n\n$$\nE = mc^2\n$$\n\nafter\n'
    const { container } = render(<Prose body={body} anchors={[anchorFor(body, 'mc^2', 1, 'f')]} />)
    expect(markTexts(container, 'f')).toEqual([])
    expect(container.querySelector('.katex')).not.toBeNull()
  })

  test('Mermaid 图表块:锚点被丢弃而不是把渲染搞崩', () => {
    // 图表块(mermaid / plantuml)走各自的渲染组件,ranges 按 design §9.4 直接丢弃。
    // 这里用 mermaid:plantuml 的渲染要打后端接口,在单测里属于逃逸的网络请求。
    const body = 'intro\n\n```mermaid\ngraph TD\nA-->B\n```\n'
    const { container } = render(<Prose body={body} anchors={[anchorFor(body, 'A-->B', 1, 'd')]} />)
    expect(markTexts(container, 'd')).toEqual([])
    expect(
      container.querySelector('[data-prose-diagram="mermaid"]'),
      'mermaid 块应当照常渲染',
    ).not.toBeNull()
  })
})

describe('RFC-326 §13 集成矩阵 —— 可见但无 position 的文本', () => {
  test('脚注定义里的引文照样定位', () => {
    const body = 'text with a note[^1]\n\n[^1]: the footnote body says more\n'
    const { container } = render(
      <Prose body={body} anchors={[anchorFor(body, 'footnote body', 1, 'fn')]} />,
    )
    expect(markTexts(container, 'fn')).toEqual(['footnote body'])
  })

  test('硬换行两侧的引文各自定位,不会互相吃掉', () => {
    const body = 'first line  \nsecond line\n'
    const { container } = render(
      <Prose
        body={body}
        anchors={[anchorFor(body, 'first line', 1, 'l1'), anchorFor(body, 'second line', 1, 'l2')]}
      />,
    )
    expect(markTexts(container, 'l1')).toEqual(['first line'])
    expect(markTexts(container, 'l2')).toEqual(['second line'])
  })
})
