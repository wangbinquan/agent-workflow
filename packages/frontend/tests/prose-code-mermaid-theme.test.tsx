// Locks the theme wiring between MermaidDiagram (the React shell in
// CodeBlock.tsx) and MermaidBlock.render:
//
//   1. The shell observes the resolved light/dark via useResolvedTheme and
//      forwards it as the 3rd argument to MermaidBlock.render.
//   2. Flipping <html data-theme> at runtime re-renders the shell and
//      invokes MermaidBlock.render again with the new theme — without this,
//      a user toggling the OS / app theme would still see the old palette
//      baked into the existing SVG.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, render } from '@testing-library/react'

const renderSpy = vi.fn()
interface MermaidRenderEvent {
  mount: HTMLElement
  source: string
  theme: 'light' | 'dark' | undefined
}

let renderEvents: MermaidRenderEvent[] = []
let renderWaiters: Array<{
  theme: 'light' | 'dark'
  resolve: (event: MermaidRenderEvent) => void
}> = []

function publishRender(event: MermaidRenderEvent): void {
  const waiterIndex = renderWaiters.findIndex((waiter) => waiter.theme === event.theme)
  if (waiterIndex === -1) {
    renderEvents.push(event)
    return
  }
  const [waiter] = renderWaiters.splice(waiterIndex, 1)
  waiter?.resolve(event)
}

/** Arm before render/theme mutation so even a same-turn passive effect is observed. */
function nextRenderWithTheme(theme: 'light' | 'dark'): Promise<MermaidRenderEvent> {
  const queuedIndex = renderEvents.findIndex((event) => event.theme === theme)
  if (queuedIndex !== -1) {
    const [event] = renderEvents.splice(queuedIndex, 1)
    return Promise.resolve(event!)
  }
  return new Promise((resolve) => renderWaiters.push({ theme, resolve }))
}

vi.mock('@/components/review/MermaidBlock', () => ({
  MermaidBlock: {
    render: (mount: HTMLElement, source: string, theme?: 'light' | 'dark') => {
      renderSpy(source, theme)
      publishRender({ mount, source, theme })
      mount.innerHTML = '<svg data-mocked="mermaid"/>'
      return Promise.resolve()
    },
  },
}))

import { Prose } from '@/components/prose/Prose'

function installMatchMedia(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((q: string) => ({
      matches: q.includes('dark') ? matches : !matches,
      media: q,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    })),
  })
}

describe('Prose mermaid → MermaidBlock theme wiring', () => {
  beforeEach(() => {
    renderSpy.mockClear()
    renderEvents = []
    renderWaiters = []
    document.documentElement.removeAttribute('data-theme')
    installMatchMedia(false)
  })
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme')
  })

  test('forwards "dark" when <html data-theme="dark">', async () => {
    document.documentElement.setAttribute('data-theme', 'dark')
    const md = '```mermaid\nflowchart TD\nA-->B\n```'
    const rendered = nextRenderWithTheme('dark')
    const { container } = render(<Prose body={md} />)
    const event = await rendered
    const diagram = container.querySelector('[data-prose-diagram="mermaid"]')
    expect(event.mount).toBe(diagram)
    expect(event.source).toContain('flowchart TD')
    expect(event.theme).toBe('dark')
    expect(diagram?.getAttribute('data-prose-diagram-theme')).toBe('dark')
  })

  test('forwards "light" when <html data-theme="light">', async () => {
    document.documentElement.setAttribute('data-theme', 'light')
    const md = '```mermaid\nflowchart TD\nA-->B\n```'
    const rendered = nextRenderWithTheme('light')
    const { container } = render(<Prose body={md} />)
    const event = await rendered
    const diagram = container.querySelector('[data-prose-diagram="mermaid"]')
    expect(event.mount).toBe(diagram)
    expect(event.source).toContain('flowchart TD')
    expect(event.theme).toBe('light')
    expect(diagram?.getAttribute('data-prose-diagram-theme')).toBe('light')
  })

  test('toggling <html data-theme> dark→light re-invokes MermaidBlock.render with new theme', async () => {
    document.documentElement.setAttribute('data-theme', 'dark')
    const md = '```mermaid\nflowchart TD\nA-->B\n```'
    const initialRender = nextRenderWithTheme('dark')
    const { container } = render(<Prose body={md} />)
    const darkEvent = await initialRender
    const diagram = container.querySelector('[data-prose-diagram="mermaid"]')
    expect(darkEvent.mount).toBe(diagram)
    expect(diagram?.getAttribute('data-prose-diagram-theme')).toBe('dark')
    const darkCalls = renderSpy.mock.calls.length

    // Wait on the exact mocked render call rather than polling across the
    // MutationObserver → state → effect chain. Arm first so a same-turn effect
    // cannot be missed; the final DOM + call-count assertions remain intact.
    const lightRender = nextRenderWithTheme('light')
    act(() => {
      document.documentElement.setAttribute('data-theme', 'light')
    })

    const lightEvent = await lightRender
    expect(lightEvent.mount).toBe(diagram)
    expect(lightEvent.source).toContain('flowchart TD')
    expect(lightEvent.theme).toBe('light')
    expect(renderSpy.mock.calls.length).toBeGreaterThan(darkCalls)
    expect(renderSpy.mock.calls.at(-1)?.[1]).toBe('light')
    expect(diagram?.getAttribute('data-prose-diagram-theme')).toBe('light')
  })
})
