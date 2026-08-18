// RFC-198 — semantic, keyboard-reachable horizontal overflow for native tables.
//
// The table remains the callsite's native element (including its existing
// classes, testids and event handlers). This primitive owns only the wrapper,
// the real scroll container and the overflow-edge affordance state.

import {
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactElement,
} from 'react'

export interface TableViewportProps {
  label: string
  minWidth?: 'sm' | 'md' | 'lg'
  /** 一个直接子元素:原生 `<table>`,或 role 化的网格容器(RFC-311 起
   *  /repos、/tasks 这类窗口化列表用 `role="list"` + CSS grid 表达同一形态)。
   *  实现门 P2-10:此前类型写死 `'table'`,而 JSX.Element 是 `ReactElement<any,
   *  any>` 所以 tsc 拦不住——真实后果是 DEV 每次渲染 warn,且 ResizeObserver 少
   *  观察一个目标(内容宽度变化时不再重测溢出),RFC-198 的键盘可达横向滚动
   *  可能永不装配。 */
  children: ReactElement<ComponentPropsWithoutRef<'table'>, 'table'> | ReactElement
}

interface OverflowState {
  hasOverflow: boolean
  overflowStart: boolean
  overflowEnd: boolean
}

const INITIAL_OVERFLOW_STATE: OverflowState = {
  hasOverflow: false,
  overflowStart: false,
  overflowEnd: false,
}

// scrollLeft can be fractional at non-integer zoom levels. Treat a sub-pixel
// remainder as the edge so the fade does not flicker when the browser settles.
const SCROLL_EDGE_EPSILON = 0.5

/** 被观察的内容元素:原生表格或网格容器都取第一个元素子节点。 */
function directContentChild(scroller: HTMLDivElement): HTMLElement | null {
  const child = scroller.firstElementChild
  return child instanceof HTMLElement ? child : null
}

export function TableViewport({ label, minWidth = 'md', children }: TableViewportProps) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState<OverflowState>(INITIAL_OVERFLOW_STATE)
  // 契约守卫改为**运行时**判据:真正会坏事的不是「子级不是 <table>」(网格容器
  // 同样能被观察、能溢出),而是「scroller 里根本没有元素子级」——那时
  // ResizeObserver 少一个目标、溢出永远测不出来。组件型子级只要渲染出元素就没事。
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const scroller = scrollerRef.current
    if (scroller !== null && directContentChild(scroller) === null) {
      console.warn(
        'TableViewport requires exactly one direct element child (a native <table> or a role-based grid container).',
      )
    }
  }, [children])

  const measure = useCallback(() => {
    const scroller = scrollerRef.current
    if (scroller === null) return

    const { clientWidth, scrollLeft, scrollWidth } = scroller
    const hasOverflow = scrollWidth > clientWidth
    const maxScrollLeft = Math.max(0, scrollWidth - clientWidth)
    const overflowStart = hasOverflow && scrollLeft > SCROLL_EDGE_EPSILON
    const overflowEnd = hasOverflow && maxScrollLeft - scrollLeft > SCROLL_EDGE_EPSILON

    setOverflow((current) => {
      if (
        current.hasOverflow === hasOverflow &&
        current.overflowStart === overflowStart &&
        current.overflowEnd === overflowEnd
      ) {
        return current
      }
      return { hasOverflow, overflowStart, overflowEnd }
    })
  }, [])

  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (scroller === null) return

    // Measure synchronously after every relevant commit so the region does not
    // wait for ResizeObserver delivery before entering/leaving the tab order.
    measure()

    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(measure)
    observer.observe(scroller)

    // The table can grow without changing the scroller's content box (for
    // example after async cell text arrives), so observe both DOM nodes.
    const table = directContentChild(scroller)
    if (table !== null) observer.observe(table)

    return () => observer.disconnect()
  }, [children, measure, minWidth])

  return (
    <div
      className={`table-viewport table-viewport--${minWidth}`}
      data-overflow-start={overflow.overflowStart}
      data-overflow-end={overflow.overflowEnd}
    >
      <div
        ref={scrollerRef}
        className="table-viewport__scroller"
        role={overflow.hasOverflow ? 'region' : undefined}
        aria-label={overflow.hasOverflow ? label : undefined}
        tabIndex={overflow.hasOverflow ? 0 : undefined}
        onScroll={measure}
      >
        {children}
      </div>
      <span className="table-viewport__hint" aria-hidden="true" />
    </div>
  )
}
