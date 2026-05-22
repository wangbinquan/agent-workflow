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
import { act, render, waitFor } from '@testing-library/react'

const renderSpy = vi.fn()
vi.mock('@/components/review/MermaidBlock', () => ({
  MermaidBlock: {
    render: (mount: HTMLElement, source: string, theme?: 'light' | 'dark') => {
      renderSpy(source, theme)
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
    document.documentElement.removeAttribute('data-theme')
    installMatchMedia(false)
  })
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme')
  })

  test('forwards "dark" when <html data-theme="dark">', () => {
    document.documentElement.setAttribute('data-theme', 'dark')
    const md = '```mermaid\nflowchart TD\nA-->B\n```'
    render(<Prose body={md} />)
    return waitFor(() => {
      expect(renderSpy).toHaveBeenCalled()
      const call = renderSpy.mock.calls.at(-1)
      expect(call?.[0]).toContain('flowchart TD')
      expect(call?.[1]).toBe('dark')
    })
  })

  test('forwards "light" when <html data-theme="light">', () => {
    document.documentElement.setAttribute('data-theme', 'light')
    const md = '```mermaid\nflowchart TD\nA-->B\n```'
    render(<Prose body={md} />)
    return waitFor(() => {
      expect(renderSpy.mock.calls.at(-1)?.[1]).toBe('light')
    })
  })

  test('toggling <html data-theme> dark→light re-invokes MermaidBlock.render with new theme', async () => {
    document.documentElement.setAttribute('data-theme', 'dark')
    const md = '```mermaid\nflowchart TD\nA-->B\n```'
    render(<Prose body={md} />)

    // Explicit 5s waitFor timeouts (default is 1s). useResolvedTheme
    // observes `<html data-theme>` via MutationObserver; on slow CI
    // runners (macos GHA in particular) the effect chain
    // mutation → observer fire → setState → useEffect → renderSpy can
    // miss the 1s budget. Confirmed environmental flake on 2026-05-22
    // CI run 26297919707; bumping the explicit timeout keeps the test
    // catching real regressions while not relying on default-budget
    // luck. Local fast path: still finishes in <50ms.
    await waitFor(() => expect(renderSpy.mock.calls.at(-1)?.[1]).toBe('dark'), { timeout: 5000 })
    const darkCalls = renderSpy.mock.calls.length

    act(() => {
      document.documentElement.setAttribute('data-theme', 'light')
    })

    await waitFor(
      () => {
        expect(renderSpy.mock.calls.length).toBeGreaterThan(darkCalls)
        expect(renderSpy.mock.calls.at(-1)?.[1]).toBe('light')
      },
      { timeout: 5000 },
    )
  })
})
