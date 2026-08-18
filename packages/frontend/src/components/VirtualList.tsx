// RFC-311 — windowed rendering primitive for unbounded lists.
//
// 全仓此前零虚拟化:每个列表页都把已加载的全部行渲染成 DOM(/tasks 累积
// Load-more 到 2000 行 ≈ 8 万节点),且每行的 30s 时钟 tick 订阅让整列表
// 同帧重渲染。本组件用 @tanstack/react-virtual(与既有 TanStack 栈同族的
// headless 原语)把 DOM 收敛到可视窗口:
//
//   - 只渲染可视区 ± overscan 的行 ⇒ tick/RelativeTime 订阅数自然收敛;
//   - `estimateSize` + measureElement 动态行高(min-height 行、换行标题都准);
//   - `onReachEnd` 滚动哨兵:距底 `endThresholdPx` 内触发一次加载(去重由
//     调用方的 isFetching 把关),替代手动 Load more;
//   - a11y:容器保留调用方语义(role 由外层 ol/ul 提供),每行注入
//     aria-setsize/aria-posinset,屏幕阅读器在窗口化下仍知道总量与位置。
//
// 按 §Frontend UI consistency:这是公共原语,新列表一律接入此组件而不是
// 自写窗口化;需要新能力(横向、网格)先最小扩展这里。

import {
  measureElement as measureElementDefault,
  observeElementRect,
  useVirtualizer,
} from '@tanstack/react-virtual'
import { useEffect, useRef, type CSSProperties, type ReactElement, type ReactNode } from 'react'

export interface VirtualListProps<T> {
  items: readonly T[]
  /** 行 key(稳定;翻页追加时既有行 key 不变)。 */
  itemKey: (item: T, index: number) => string
  /** 估计行高(px)。行高接近恒定时给准确值可消除首帧跳动。 */
  estimateSize: number
  /** 渲染一行。返回元素会被 measure(动态高)。 */
  renderItem: (item: T, index: number) => ReactNode
  /** 滚动容器高度(CSS 值)。省略时不内联 height——交给调用方的
   *  className(如 flex:1 + min-height:0 + overflow 的既有布局类)。 */
  height?: string
  /** 距底部还有这么多 px 时触发(默认 400)。 */
  endThresholdPx?: number
  /** 接近底部时回调(调用方自行用 isFetching 去重)。 */
  onReachEnd?: () => void
  /** 渲染窗口外预渲染的行数(默认 8)。 */
  overscan?: number
  /** 追加在列表末尾、不参与虚拟化的尾注(加载中/到底提示)。 */
  tail?: ReactNode
  /** 透传给滚动容器(测试锚点/aria)。 */
  containerProps?: {
    className?: string
    'data-testid'?: string
    'aria-label'?: string
    role?: string
  }
  /** 行容器元素标签(默认 'div';配合外层 ol 可用 'li' 保语义)。 */
  rowTag?: 'div' | 'li'
  /** 行容器的 ARIA role(如 'listitem')。renderItem 自带 listitem 时省略,
   *  避免嵌套双重语义。 */
  rowRole?: string
  /** 数据集切换(过滤变化)时传新值可把滚动位置重置到顶部。 */
  scrollResetKey?: string
}

export function VirtualList<T>(props: VirtualListProps<T>): ReactElement {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const virtualizer = useVirtualizer({
    count: props.items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => props.estimateSize,
    overscan: props.overscan ?? 8,
    getItemKey: (index) => props.itemKey(props.items[index]!, index),
    // jsdom（单测/组件测试）没有真实布局,容器 rect 恒为 0。核心库的
    // observeElementRect 在挂载时同步用 getBoundingClientRect() 覆盖
    // initialRect——所以光给 initialRect 不够,必须把 0×0 的测量丢弃:
    // 保留 initialRect（jsdom）或上一次非零实测（真实浏览器里容器瞬时
    // 塌陷/display:none 时不清空窗口,恢复可见后 ResizeObserver 会立即
    // 送来新实测）。包装的是官方实现,观察机制本身不变。
    initialRect: { width: 800, height: 800 },
    observeElementRect: (instance, cb) =>
      observeElementRect(instance, (rect) => {
        if (rect.width > 0 || rect.height > 0) cb(rect)
      }),
    // 行测量同理:jsdom 里 getBoundingClientRect().height 恒 0,若照单全收,
    // 每行尺寸被清零、超出视口的列表整体塌缩成空;量到 0 时回退估计值
    // (真实浏览器里行瞬时不可见时同样受益)。
    measureElement: (el, entry, instance) => {
      const size = measureElementDefault(el, entry, instance)
      return size > 0 ? size : props.estimateSize
    },
  })

  const resetKey = props.scrollResetKey
  useEffect(() => {
    if (resetKey === undefined) return
    scrollRef.current?.scrollTo({ top: 0 })
    virtualizer.scrollToOffset(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在数据集身份变化时重置
  }, [resetKey])

  const onReachEndRef = useRef(props.onReachEnd)
  useEffect(() => {
    onReachEndRef.current = props.onReachEnd
  })
  const threshold = props.endThresholdPx ?? 400
  const handleScrollRef = useRef<() => void>(() => {})
  const handleScroll = (): void => {
    const el = scrollRef.current
    if (el === null || onReachEndRef.current === undefined) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= threshold) {
      onReachEndRef.current()
    }
  }
  handleScrollRef.current = handleScroll

  const virtualItems = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()
  // 实现门 P2-8:哨兵只挂在 onScroll 上,内容不足以产生滚动条时(视口比首页高、
  // 过滤后只剩几行但仍有 nextCursor)它永远不触发,而组件文档把 onReachEnd 描述为
  // 「替代手动 Load more」——后续按此接入且不带兜底按钮的调用方会静默无法翻页。
  // 行数/总高变化后自检一次。
  useEffect(() => {
    handleScrollRef.current()
  }, [props.items.length, totalSize])
  const RowTag = props.rowTag ?? 'div'
  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className={props.containerProps?.className}
      data-testid={props.containerProps?.['data-testid']}
      aria-label={props.containerProps?.['aria-label']}
      role={props.containerProps?.role}
      style={{
        ...(props.height !== undefined ? { height: props.height } : {}),
        overflowY: 'auto',
        position: 'relative',
      }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {virtualItems.map((virtualRow) => {
          const item = props.items[virtualRow.index]
          if (item === undefined) return null
          const style: CSSProperties = {
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            transform: `translateY(${virtualRow.start}px)`,
          }
          return (
            <RowTag
              key={virtualRow.key}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              role={props.rowRole}
              // aria-setsize/posinset are only ALLOWED on roles that take them
              // (listitem/option/row/…). When the caller's renderItem owns the
              // row role, this wrapper is a bare positioning div — putting the
              // attributes here is an `aria-allowed-attr` violation (axe caught
              // it on /tasks). Such callers pass the two values into their own
              // row element instead (see `ariaSetsize`/`ariaPosinset` in
              // routes/tasks.tsx).
              {...(props.rowRole === undefined
                ? {}
                : { 'aria-setsize': props.items.length, 'aria-posinset': virtualRow.index + 1 })}
              style={style}
            >
              {props.renderItem(item, virtualRow.index)}
            </RowTag>
          )
        })}
      </div>
      {props.tail}
    </div>
  )
}
