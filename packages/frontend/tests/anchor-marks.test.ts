// RFC-241 阶段 2 — anchorMarks 帮助函数独立单测(实现门 P2-4):
// 「先清后设」「null 只清」「切换 id 时旧组整组熄灭」此前仅由
// review-diff-prior-comments #7(单条点击)与源码锁间接覆盖,这里直接
// 锁纯 DOM 行为。跨 text 节点的意见产生同 data-comment-id 的多段 mark,
// active 必须整组切换;滚动定位到第一段并返回是否命中。

import { beforeEach, describe, expect, test, vi } from 'vitest'
import { scrollToAnchorMark, setActiveAnchorMarks } from '../src/lib/review/anchorMarks'

const SEL = 'mark.prior-comment-anchor'

function makeRoot(): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = [
    '<p>',
    '<mark class="prior-comment-anchor" data-comment-id="a">甲1</mark>',
    '中缝',
    '<mark class="prior-comment-anchor" data-comment-id="a">甲2</mark>',
    '<mark class="prior-comment-anchor" data-comment-id="b">乙1</mark>',
    '<mark class="prior-comment-anchor" data-comment-id="b">乙2</mark>',
    '<mark class="comment-anchor" data-comment-id="cur">当前版</mark>',
    '</p>',
  ].join('')
  return root
}

const active = (root: HTMLElement, sel: string): string[] =>
  Array.from(root.querySelectorAll<HTMLElement>(`${sel}[data-active]`)).map(
    (m) => `${m.getAttribute('data-comment-id')}:${m.textContent}`,
  )

describe('setActiveAnchorMarks', () => {
  let root: HTMLElement
  beforeEach(() => {
    root = makeRoot()
  })

  test('点亮整组:同 comment-id 的多段 mark 全部 data-active', () => {
    setActiveAnchorMarks(root, 'a', SEL)
    expect(active(root, SEL)).toEqual(['a:甲1', 'a:甲2'])
  })

  test('切换 id:旧组整组熄灭、新组整组点亮', () => {
    setActiveAnchorMarks(root, 'a', SEL)
    setActiveAnchorMarks(root, 'b', SEL)
    expect(active(root, SEL)).toEqual(['b:乙1', 'b:乙2'])
  })

  test('null 只清不设', () => {
    setActiveAnchorMarks(root, 'a', SEL)
    setActiveAnchorMarks(root, null, SEL)
    expect(active(root, SEL)).toEqual([])
  })

  test('按 markSelector 隔离:不触碰其它 class 的 mark', () => {
    const cur = root.querySelector<HTMLElement>('mark.comment-anchor')
    cur?.setAttribute('data-active', 'true')
    setActiveAnchorMarks(root, 'a', SEL)
    setActiveAnchorMarks(root, null, SEL)
    // 当前版 mark 的 data-active 不被 prior 选择器的清扫波及
    expect(cur?.getAttribute('data-active')).toBe('true')
  })

  test('未知 id:只清扫,零点亮', () => {
    setActiveAnchorMarks(root, 'a', SEL)
    setActiveAnchorMarks(root, 'missing', SEL)
    expect(active(root, SEL)).toEqual([])
  })
})

describe('scrollToAnchorMark', () => {
  test('命中:滚动到第一段并返回 true', () => {
    const root = makeRoot()
    const spy = vi.fn()
    Element.prototype.scrollIntoView = spy
    expect(scrollToAnchorMark(root, 'a', SEL)).toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' })
    const firstMark = root.querySelector<HTMLElement>(`${SEL}[data-comment-id="a"]`)
    expect(spy.mock.instances[0]).toBe(firstMark)
  })

  test('未命中:返回 false 且不滚动', () => {
    const root = makeRoot()
    const spy = vi.fn()
    Element.prototype.scrollIntoView = spy
    expect(scrollToAnchorMark(root, 'missing', SEL)).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })
})
