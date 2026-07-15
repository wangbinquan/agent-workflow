// RFC-198 — TableViewport contract lock.
//
// The primitive must keep native table semantics/events while making only a
// genuinely overflowing scroller a labelled keyboard region. ResizeObserver
// watches both the scroll host and its direct table because async cell content
// can change scrollWidth without changing the host's own content box.

import { act, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ComponentProps, ComponentPropsWithoutRef, ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, expectTypeOf, test, vi } from 'vitest'
import { TableViewport } from '../src/components/TableViewport'

interface ScrollMetrics {
  clientWidth: number
  scrollWidth: number
  scrollLeft: number
}

class TestResizeObserver {
  static instances: TestResizeObserver[] = []

  readonly observed = new Set<Element>()
  readonly observe = vi.fn((target: Element) => this.observed.add(target))
  readonly unobserve = vi.fn((target: Element) => this.observed.delete(target))
  readonly disconnect = vi.fn(() => this.observed.clear())

  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this)
  }

  trigger(): void {
    this.callback([], this as unknown as ResizeObserver)
  }
}

function table(content = 'Cell'): ReactElement<ComponentPropsWithoutRef<'table'>, 'table'> {
  return (
    <table data-testid="native-table">
      <tbody>
        <tr>
          <td>{content}</td>
        </tr>
      </tbody>
    </table>
  )
}

function installMetrics(element: HTMLElement, metrics: ScrollMetrics): void {
  Object.defineProperties(element, {
    clientWidth: {
      configurable: true,
      get: () => metrics.clientWidth,
    },
    scrollWidth: {
      configurable: true,
      get: () => metrics.scrollWidth,
    },
    scrollLeft: {
      configurable: true,
      get: () => metrics.scrollLeft,
      set: (value: number) => {
        metrics.scrollLeft = value
      },
    },
  })
}

function latestObserver(): TestResizeObserver {
  const observer = TestResizeObserver.instances.at(-1)
  if (observer === undefined) throw new Error('expected TableViewport to create ResizeObserver')
  return observer
}

function triggerResize(observer = latestObserver()): void {
  act(() => observer.trigger())
}

beforeEach(() => {
  TestResizeObserver.instances = []
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('<TableViewport> — DOM and type contract', () => {
  test('children API is exactly a native table ReactElement', () => {
    type Child = ComponentProps<typeof TableViewport>['children']
    expectTypeOf<Child>().toEqualTypeOf<ReactElement<ComponentPropsWithoutRef<'table'>, 'table'>>()
  })

  test('renders stable outer/scroller/hint classes and defaults minWidth to md', () => {
    const { container } = render(<TableViewport label="Tasks">{table()}</TableViewport>)

    const outer = container.querySelector('.table-viewport') as HTMLDivElement
    const scroller = outer.querySelector('.table-viewport__scroller') as HTMLDivElement
    expect(outer.className).toBe('table-viewport table-viewport--md')
    expect(scroller.firstElementChild).toBe(screen.getByTestId('native-table'))
    expect(outer.querySelector('.table-viewport__hint')?.getAttribute('aria-hidden')).toBe('true')
  })

  test('maps explicit minWidth values to the outer modifier', () => {
    const child = table()
    const { container, rerender } = render(
      <TableViewport label="Tasks" minWidth="sm">
        {child}
      </TableViewport>,
    )
    const outer = container.querySelector('.table-viewport') as HTMLDivElement
    expect(outer.className).toBe('table-viewport table-viewport--sm')

    rerender(
      <TableViewport label="Tasks" minWidth="lg">
        {child}
      </TableViewport>,
    )
    expect(outer.className).toBe('table-viewport table-viewport--lg')
  })

  test('warns for a non-native direct child in dev/test without throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    function CustomTable() {
      return table('Custom')
    }
    const invalidChild = (<CustomTable />) as unknown as ReactElement<
      ComponentPropsWithoutRef<'table'>,
      'table'
    >

    expect(() => render(<TableViewport label="Tasks">{invalidChild}</TableViewport>)).not.toThrow()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(
      'TableViewport requires exactly one direct native <table> child; wrappers and custom table components are not supported.',
    )
  })

  test('CSS maps every width tier and keeps focus on the real scroll container', () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const css = readFileSync(path.resolve(here, '../src/styles.css'), 'utf8')
    expect(css).toMatch(/\.table-viewport--sm[\s\S]*?min-width: 560px/)
    expect(css).toMatch(/\.table-viewport--md[\s\S]*?min-width: 720px/)
    expect(css).toMatch(/\.table-viewport--lg[\s\S]*?min-width: 920px/)
    expect(css).toMatch(/\.table-viewport__scroller:focus-visible[\s\S]*?--focus-ring-color/)
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.table-viewport__hint::before/,
    )
  })
})

describe('<TableViewport> — overflow measurement', () => {
  test('measures on mount and only then adds region/name/tabIndex for true overflow', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains('table-viewport__scroller') ? 320 : 0
    })
    vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) {
      return this.classList.contains('table-viewport__scroller') ? 720 : 0
    })

    const { container } = render(<TableViewport label="Task history">{table()}</TableViewport>)
    const outer = container.querySelector('.table-viewport') as HTMLDivElement
    const scroller = outer.querySelector('.table-viewport__scroller') as HTMLDivElement

    expect(screen.getByRole('region', { name: 'Task history' })).toBe(scroller)
    expect(scroller.getAttribute('tabindex')).toBe('0')
    expect(outer.dataset.overflowStart).toBe('false')
    expect(outer.dataset.overflowEnd).toBe('true')
  })

  test('observes the scroller and direct table, then handles async grow and shrink', () => {
    const { container } = render(<TableViewport label="Tasks">{table()}</TableViewport>)
    const outer = container.querySelector('.table-viewport') as HTMLDivElement
    const scroller = outer.querySelector('.table-viewport__scroller') as HTMLDivElement
    const nativeTable = screen.getByTestId('native-table')
    const metrics = { clientWidth: 500, scrollWidth: 500, scrollLeft: 0 }
    installMetrics(scroller, metrics)

    const observer = latestObserver()
    expect(observer.observed).toEqual(new Set([scroller, nativeTable]))
    triggerResize(observer)
    expect(scroller.hasAttribute('role')).toBe(false)
    expect(scroller.hasAttribute('aria-label')).toBe(false)
    expect(scroller.hasAttribute('tabindex')).toBe(false)

    metrics.scrollWidth = 860
    triggerResize(observer)
    expect(scroller.getAttribute('role')).toBe('region')
    expect(scroller.getAttribute('aria-label')).toBe('Tasks')
    expect(scroller.getAttribute('tabindex')).toBe('0')
    expect(outer.dataset.overflowEnd).toBe('true')

    metrics.scrollWidth = 480
    triggerResize(observer)
    expect(scroller.hasAttribute('role')).toBe(false)
    expect(scroller.hasAttribute('aria-label')).toBe(false)
    expect(scroller.hasAttribute('tabindex')).toBe(false)
    expect(outer.dataset.overflowStart).toBe('false')
    expect(outer.dataset.overflowEnd).toBe('false')
  })

  test('remeasures synchronously after children and minWidth commits', () => {
    const firstTable = table('Short')
    const nextTable = table('A much longer async row')
    const { container, rerender } = render(
      <TableViewport label="Tasks" minWidth="sm">
        {firstTable}
      </TableViewport>,
    )
    const scroller = container.querySelector('.table-viewport__scroller') as HTMLDivElement
    const metrics = { clientWidth: 500, scrollWidth: 500, scrollLeft: 0 }
    installMetrics(scroller, metrics)
    triggerResize()
    expect(scroller.hasAttribute('role')).toBe(false)

    metrics.scrollWidth = 800
    rerender(
      <TableViewport label="Tasks" minWidth="sm">
        {nextTable}
      </TableViewport>,
    )
    expect(scroller.getAttribute('role')).toBe('region')
    expect(TestResizeObserver.instances).toHaveLength(2)

    metrics.scrollWidth = 480
    rerender(
      <TableViewport label="Tasks" minWidth="lg">
        {nextTable}
      </TableViewport>,
    )
    expect(scroller.hasAttribute('role')).toBe(false)
    expect(TestResizeObserver.instances).toHaveLength(3)
  })

  test('updates left/right edge state from the real scroller scroll event', () => {
    const { container } = render(<TableViewport label="Tasks">{table()}</TableViewport>)
    const outer = container.querySelector('.table-viewport') as HTMLDivElement
    const scroller = outer.querySelector('.table-viewport__scroller') as HTMLDivElement
    const metrics = { clientWidth: 400, scrollWidth: 1000, scrollLeft: 0 }
    installMetrics(scroller, metrics)
    triggerResize()

    expect(outer.dataset.overflowStart).toBe('false')
    expect(outer.dataset.overflowEnd).toBe('true')

    metrics.scrollLeft = 240
    fireEvent.scroll(scroller)
    expect(outer.dataset.overflowStart).toBe('true')
    expect(outer.dataset.overflowEnd).toBe('true')

    metrics.scrollLeft = 600
    fireEvent.scroll(scroller)
    expect(outer.dataset.overflowStart).toBe('true')
    expect(outer.dataset.overflowEnd).toBe('false')
  })

  test('does not intercept events from interactive table content', () => {
    const onClick = vi.fn()
    render(
      <TableViewport label="Actions">
        <table>
          <tbody>
            <tr>
              <td>
                <button type="button" onClick={onClick}>
                  Open
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </TableViewport>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(onClick).toHaveBeenCalledOnce()
  })
})
