// RFC-326 实现门(PR-B)P1#7 —— 重叠代码锚的导航必须认 `data-comment-ids`。
//
// 为什么这条测试存在:shiki 的 decorations 不接受交叉区间,所以代码块里被多条意见
// 重叠覆盖的那一段只能切成**一个原子段**由多条意见共享。共享段的 `data-comment-id`
// 只写最早开始的那条,其余 id 落在 `data-comment-ids`(空格分隔)。在此之前所有按 id
// 找 mark 的地方(active 高亮 / 滚动定位 / 气泡对齐)都只匹配 `data-comment-id`,
// 于是**重叠区里后开始的那条意见永远找不到自己的 mark**:不高亮、滚不过去、气泡掉
// 进 orphan 栏。单一选择器 `anchorMarkSelector` 是这条契约的唯一事实源。

import { describe, expect, test } from 'vitest'
import { atomicAnchorSegments } from '@/components/prose/CodeBlock'
import {
  anchorMarkSelector,
  scrollToAnchorMark,
  setActiveAnchorMarks,
} from '@/lib/review/anchorMarks'

const MARK = 'mark.comment-anchor'

/** 一个代码块 DOM:`shared` 段同属 c1 / c2,`tail` 段只属 c2。 */
function buildRoot(): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = [
    '<pre><code>',
    '<mark class="comment-anchor" data-comment-id="c1" data-comment-ids="c1">head</mark>',
    '<mark class="comment-anchor" data-comment-id="c1" data-comment-ids="c1 c2">shared</mark>',
    '<mark class="comment-anchor" data-comment-id="c2" data-comment-ids="c2">tail</mark>',
    '</code></pre>',
  ].join('')
  // jsdom 没有布局,scrollIntoView 需要打桩。
  root.querySelectorAll('mark').forEach((m) => {
    ;(m as HTMLElement).scrollIntoView = () => {}
  })
  return root
}

describe('anchorMarkSelector', () => {
  test('两种挂法都认(单 id 属性 + 空格分隔的 ids 属性)', () => {
    expect(anchorMarkSelector(MARK, 'c2')).toBe(
      `${MARK}[data-comment-id="c2"], ${MARK}[data-comment-ids~="c2"]`,
    )
  })
})

describe('RFC-326 P1#7 —— 重叠代码锚的 active / 滚动', () => {
  test('后开始的那条意见点亮共享段与自己的独占段', () => {
    const root = buildRoot()
    setActiveAnchorMarks(root, 'c2', MARK)
    const active = [...root.querySelectorAll<HTMLElement>('mark[data-active]')].map(
      (m) => m.textContent,
    )
    expect(active).toEqual(['shared', 'tail'])
  })

  test('先开始的那条同样整组点亮,并且切换时清干净', () => {
    const root = buildRoot()
    setActiveAnchorMarks(root, 'c2', MARK)
    setActiveAnchorMarks(root, 'c1', MARK)
    expect(
      [...root.querySelectorAll<HTMLElement>('mark[data-active]')].map((m) => m.textContent),
    ).toEqual(['head', 'shared'])
    setActiveAnchorMarks(root, null, MARK)
    expect(root.querySelectorAll('mark[data-active]').length).toBe(0)
  })

  test('滚动定位能找到只存在于 data-comment-ids 里的意见', () => {
    const root = buildRoot()
    // c3 谁都不属于 → false(未定位意见不滚)。
    expect(scrollToAnchorMark(root, 'c3', MARK)).toBe(false)
    expect(scrollToAnchorMark(root, 'c2', MARK)).toBe(true)
  })

  test('共享段确实是 CodeBlock 的原子切分产物(契约对账,不是手写 DOM 的自证)', () => {
    // c1 覆盖 [0,10)、c2 覆盖 [4,14):交叉 → 切成三段,中段两条都带。
    const segments = atomicAnchorSegments(
      [
        { start: 0, end: 10, commentId: 'c1' },
        { start: 4, end: 14, commentId: 'c2' },
      ],
      20,
    )
    expect(segments.map((s) => [s.start, s.end, s.commentId, s.commentIds.join(' ')])).toEqual([
      [0, 4, 'c1', 'c1'],
      [4, 10, 'c1', 'c1 c2'],
      [10, 14, 'c2', 'c2'],
    ])
  })
})
