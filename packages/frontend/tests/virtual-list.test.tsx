// RFC-311 T25 — VirtualList 公共原语单测。
//
// 特别锁定 jsdom 零矩阵回归:@tanstack/virtual-core 的 observeElementRect 在
// 挂载时同步用 getBoundingClientRect()(jsdom 恒 0×0)覆盖 initialRect,曾使
// 组件在所有组件测试里一行都不渲染(tasks-list-children 6 红)。VirtualList
// 用自定义 observeElementRect 丢弃 0×0 测量修复——本文件第一条即该回归锁。

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { VirtualList } from '../src/components/VirtualList'

const items = (n: number): string[] => Array.from({ length: n }, (_, i) => `it-${i}`)

function renderList(
  n: number,
  extra?: Partial<Parameters<typeof VirtualList<string>>[0]>,
): ReturnType<typeof render> {
  return render(
    <VirtualList<string>
      items={items(n)}
      itemKey={(x) => x}
      estimateSize={50}
      renderItem={(x) => <span data-testid={`row-${x}`}>{x}</span>}
      containerProps={{ role: 'list', 'data-testid': 'vl' }}
      {...extra}
    />,
  )
}

describe('VirtualList', () => {
  test('renders rows under jsdom zero-rect (initialRect survives the 0×0 measurement)', async () => {
    renderList(3)
    expect(await screen.findByTestId('row-it-0')).toBeTruthy()
    expect(screen.getByTestId('row-it-2')).toBeTruthy()
  })

  test('windows large lists: only the viewport ± overscan is in the DOM', async () => {
    renderList(1_000)
    await screen.findByTestId('row-it-0')
    // initialRect 高 800 / estimateSize 50 + overscan 8 ⇒ 数十行,绝非全量。
    const rendered = screen.getAllByTestId(/^row-it-/)
    expect(rendered.length).toBeGreaterThan(10)
    expect(rendered.length).toBeLessThan(100)
    expect(screen.queryByTestId('row-it-999')).toBeNull()
  })

  test('rows carry aria-setsize/aria-posinset and the container keeps caller semantics', async () => {
    renderList(40, { rowRole: 'listitem' })
    const first = await screen.findByTestId('row-it-0')
    expect(screen.getByTestId('vl').getAttribute('role')).toBe('list')
    const row = first.parentElement!
    expect(row.getAttribute('role')).toBe('listitem')
    expect(row.getAttribute('aria-setsize')).toBe('40')
    expect(row.getAttribute('aria-posinset')).toBe('1')
  })

  test('onReachEnd fires when scrolled near the bottom, not at the top', async () => {
    const onReachEnd = vi.fn()
    renderList(1_000, { onReachEnd, endThresholdPx: 400 })
    await screen.findByTestId('row-it-0')
    const el = screen.getByTestId('vl')
    // 挂载后的一次自检(实现门 P2-8:内容撑不出滚动条时哨兵永不触发)在 jsdom 下
    // 必然命中——几何全是 0。这里要验的是滚动语义,先清掉那一次。
    onReachEnd.mockClear()
    // jsdom 不做布局,滚动几何手工注入。
    Object.defineProperty(el, 'scrollHeight', { value: 50_000, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 800, configurable: true })
    el.scrollTop = 0
    fireEvent.scroll(el)
    expect(onReachEnd).not.toHaveBeenCalled()
    el.scrollTop = 50_000 - 800 - 100 // 距底 100px < 400px 阈值
    fireEvent.scroll(el)
    expect(onReachEnd).toHaveBeenCalledTimes(1)
  })

  test('tail renders after the virtualized window', async () => {
    renderList(5, { tail: <div data-testid="tail">more</div> })
    await screen.findByTestId('row-it-0')
    expect(screen.getByTestId('tail')).toBeTruthy()
  })

  test('scrollResetKey change scrolls back to top', async () => {
    const { rerender } = render(
      <VirtualList<string>
        items={items(1_000)}
        itemKey={(x) => x}
        estimateSize={50}
        renderItem={(x) => <span data-testid={`row-${x}`}>{x}</span>}
        containerProps={{ role: 'list', 'data-testid': 'vl' }}
        scrollResetKey="a"
      />,
    )
    await screen.findByTestId('row-it-0')
    const el = screen.getByTestId('vl')
    const scrollTo = vi.fn()
    Object.defineProperty(el, 'scrollTo', { value: scrollTo, configurable: true })
    rerender(
      <VirtualList<string>
        items={items(1_000)}
        itemKey={(x) => x}
        estimateSize={50}
        renderItem={(x) => <span data-testid={`row-${x}`}>{x}</span>}
        containerProps={{ role: 'list', 'data-testid': 'vl' }}
        scrollResetKey="b"
      />,
    )
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 })
  })

  test('滚动容器常驻滚动条槽位——布局不随「这一刻有没有滚动条」跳动', async () => {
    // 回归锁:窗口化列表的总高度是测量出来的,渲染早期「要不要滚动条」不稳定。
    // 经典滚动条(Linux/Windows)一出现就吃掉 ~15px,行内容整体左移——用户看到
    // 列宽跳动,CI 上表现为 /repos 视觉基线间歇性红(2026-08-19 实测:同一提交
    // 红-绿-红交替,且 macOS overlay 滚动条不占位所以本地永远复现不了)。
    renderList(50)
    await screen.findByTestId('row-it-0')
    expect(screen.getByTestId('vl').style.scrollbarGutter).toBe('stable')
  })

  test('the sentinel also fires when the content is too short to scroll', async () => {
    // 实现门 P2-8:视口比首页高、或过滤后只剩几行但仍有 nextCursor 时,onScroll
    // 永远不会触发——不带兜底按钮的调用方会静默无法翻页。
    const onReachEnd = vi.fn()
    renderList(2, { onReachEnd })
    await screen.findByTestId('row-it-0')
    expect(onReachEnd).toHaveBeenCalled()
  })
})
