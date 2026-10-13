import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import i18n from '../src/i18n'
import { MarkdownEditor } from '@/components/MarkdownEditor'
import { MARKDOWN_LAYOUT_STORAGE_KEY } from '@/lib/markdown-editor-layout'

let containerWidth = 1000
let observers: TestResizeObserver[] = []

class TestResizeObserver implements ResizeObserver {
  constructor(readonly callback: ResizeObserverCallback) {
    observers.push(this)
  }
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}

function resize(width: number) {
  containerWidth = width
  act(() => {
    for (const observer of observers) observer.callback([], observer)
  })
}

function stored() {
  return JSON.parse(localStorage.getItem(MARKDOWN_LAYOUT_STORAGE_KEY) ?? '{}') as {
    mode: string
    ratio: number
    singlePane: string
  }
}

function editorMode() {
  return screen.getByTestId('markdown-editor').getAttribute('data-mode')
}

function source() {
  return screen.getByTestId('markdown-source') as HTMLTextAreaElement
}

function mount(initial = '# Draft', readOnly = false) {
  const changed = vi.fn()
  function Harness() {
    const [body, setBody] = useState(initial)
    return (
      <MarkdownEditor
        value={body}
        onChange={(next) => {
          changed(next)
          setBody(next)
        }}
        fill
        readOnly={readOnly}
      />
    )
  }
  return { ...render(<Harness />), changed }
}

function pointerCapture(separator: HTMLElement) {
  const pointers = new Set<number>()
  separator.setPointerCapture = vi.fn((id: number) => {
    pointers.add(id)
  })
  separator.hasPointerCapture = vi.fn((id: number) => pointers.has(id))
  separator.releasePointerCapture = vi.fn((id: number) => {
    pointers.delete(id)
  })
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  localStorage.removeItem(MARKDOWN_LAYOUT_STORAGE_KEY)
  containerWidth = 1000
  observers = []
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    return new DOMRect(0, 0, this.classList.contains('md-editor__panes') ? containerWidth : 0, 400)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Markdown editor layout interactions', () => {
  test('mode switches retain the textarea, draft, selection and each scroll container', () => {
    const { changed } = mount()
    const textarea = source()
    fireEvent.change(textarea, {
      target: { value: '# Unsaved draft\n\n| a | b |\n| - | - |\n| 1 | 2 |' },
    })
    textarea.setSelectionRange(2, 9)
    textarea.scrollTop = 25
    const preview = screen.getByRole('region', { name: 'Preview' })
    preview.scrollTop = 35
    fireEvent.click(screen.getByTestId('markdown-mode-preview'))
    expect(editorMode()).toBe('preview')
    expect(textarea.closest<HTMLElement>('.md-editor__pane')?.hidden).toBe(true)
    fireEvent.click(screen.getByTestId('markdown-mode-edit'))
    expect(editorMode()).toBe('edit')
    fireEvent.click(screen.getByTestId('markdown-mode-split'))
    expect(source()).toBe(textarea)
    expect(textarea.value).toContain('Unsaved draft')
    expect([textarea.selectionStart, textarea.selectionEnd, textarea.scrollTop]).toEqual([2, 9, 25])
    expect(screen.getByRole('region', { name: 'Preview' })).toBe(preview)
    expect(preview.scrollTop).toBe(35)
    expect(preview.querySelector('table')).not.toBeNull()
    expect(changed).toHaveBeenCalledTimes(1)
  })

  test('actual container resize restores the split and its preferred ratio after compact/hidden tabs', () => {
    mount()
    const separator = screen.getByRole('separator')
    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    expect(stored().ratio).toBe(0.52)
    resize(390)
    expect(editorMode()).toBe('edit')
    expect((screen.getByTestId('markdown-mode-split') as HTMLButtonElement).disabled).toBe(true)
    expect(stored().mode).toBe('split')
    resize(0)
    expect(editorMode()).toBe('edit')
    resize(1000)
    expect(editorMode()).toBe('split')
    expect(separator.getAttribute('aria-valuenow')).toBe('52')
    resize(652)
    expect(separator.getAttribute('aria-valuenow')).toBe('50')
    expect(stored().ratio).toBe(0.52)
    resize(1000)
    expect(separator.getAttribute('aria-valuenow')).toBe('52')
  })

  test('preview interaction determines automatic compact fallback; explicit mode overrides restoration', () => {
    mount()
    fireEvent.pointerDown(screen.getByRole('region', { name: 'Preview' }))
    resize(390)
    expect(editorMode()).toBe('preview')
    fireEvent.click(screen.getByTestId('markdown-mode-edit'))
    resize(1000)
    expect(editorMode()).toBe('edit')
  })

  test('keyboard resizing exposes limits, equal split and a focus-safe collapse', () => {
    const { changed } = mount()
    const separator = screen.getByRole('separator')
    act(() => separator.focus())
    fireEvent.keyDown(separator, { key: 'Home' })
    expect(separator.getAttribute('aria-valuenow')).toBe(separator.getAttribute('aria-valuemin'))
    fireEvent.keyDown(separator, { key: 'End' })
    expect(separator.getAttribute('aria-valuenow')).toBe(separator.getAttribute('aria-valuemax'))
    fireEvent.doubleClick(separator)
    expect(separator.getAttribute('aria-valuenow')).toBe('50')
    fireEvent.keyDown(separator, { key: 'ArrowLeft' })
    expect(separator.getAttribute('aria-valuenow')).toBe('48')
    fireEvent.click(screen.getByRole('button', { name: 'Equal split' }))
    expect(separator.getAttribute('aria-valuenow')).toBe('50')
    fireEvent.keyDown(separator, { key: 'Enter' })
    expect(editorMode()).toBe('preview')
    expect(document.activeElement).toBe(screen.getByTestId('markdown-mode-preview'))
    expect(changed).not.toHaveBeenCalled()
  })

  test('focus leaves a pane or separator that becomes hidden', () => {
    mount()
    act(() => source().focus())
    fireEvent.click(screen.getByTestId('markdown-mode-preview'))
    expect(document.activeElement).toBe(screen.getByTestId('markdown-mode-preview'))
    fireEvent.click(screen.getByTestId('markdown-mode-split'))
    act(() => screen.getByRole('separator').focus())
    resize(390)
    expect(document.activeElement).toBe(screen.getByTestId('markdown-mode-preview'))
  })

  test.each(['pointerUp', 'pointerCancel', 'lostPointerCapture'] as const)(
    'pointer drag clamps, ignores other pointers, and ends on %s',
    (end) => {
      const { changed } = mount()
      const separator = screen.getByRole('separator')
      pointerCapture(separator)
      fireEvent.pointerDown(separator, { button: 0, pointerId: 7 })
      fireEvent.pointerMove(separator, { pointerId: 8, clientX: 900 })
      expect(stored().ratio).toBe(0.5)
      fireEvent.pointerMove(separator, { pointerId: 7, clientX: 900 })
      expect(stored().ratio * 988).toBeCloseTo(668)
      fireEvent[end](separator, { pointerId: 7 })
      expect(screen.getByTestId('markdown-editor').hasAttribute('data-dragging')).toBe(false)
      fireEvent.pointerMove(separator, { pointerId: 7, clientX: 10 })
      expect(stored().ratio * 988).toBeCloseTo(668)
      expect(separator.releasePointerCapture).toHaveBeenCalledWith(7)
      expect(changed).not.toHaveBeenCalled()
    },
  )

  test('a compact transition or unmount releases capture and disconnects the observer', () => {
    const { unmount } = mount()
    const separator = screen.getByRole('separator')
    pointerCapture(separator)
    fireEvent.pointerDown(separator, { button: 0, pointerId: 7 })
    resize(390)
    expect(separator.releasePointerCapture).toHaveBeenCalledWith(7)
    resize(1000)
    fireEvent.pointerDown(separator, { button: 0, pointerId: 9 })
    unmount()
    expect(separator.releasePointerCapture).toHaveBeenCalledWith(9)
    expect(observers[0]?.disconnect).toHaveBeenCalledOnce()
  })

  test('read-only source stays read-only while view controls remain available', () => {
    containerWidth = 390
    const { changed } = mount('# Reference', true)
    expect(editorMode()).toBe('preview')
    fireEvent.click(screen.getByTestId('markdown-mode-edit'))
    expect(source().readOnly).toBe(true)
    expect(source().value).toBe('# Reference')
    expect(changed).not.toHaveBeenCalled()
  })

  test('a remount restores user layout, while rejected storage remains usable', () => {
    const first = mount()
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' })
    fireEvent.click(screen.getByTestId('markdown-mode-preview'))
    first.unmount()
    const second = mount()
    expect(editorMode()).toBe('preview')
    fireEvent.click(screen.getByTestId('markdown-mode-split'))
    expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('48')
    second.unmount()
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('unavailable')
    })
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('full')
    })
    mount()
    fireEvent.click(screen.getByTestId('markdown-mode-edit'))
    fireEvent.change(source(), { target: { value: 'Still editable' } })
    expect(source().value).toBe('Still editable')
  })

  test('window resize fallback is cleaned up when ResizeObserver is unavailable', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const remove = vi.spyOn(window, 'removeEventListener')
    const { unmount } = mount()
    containerWidth = 390
    fireEvent(window, new Event('resize'))
    expect(editorMode()).toBe('edit')
    unmount()
    expect(remove).toHaveBeenCalledWith('resize', expect.any(Function))
  })

  test('Chinese controls use the same translated layout and separator semantics', async () => {
    await i18n.changeLanguage('zh-CN')
    mount()
    expect(screen.getByRole('button', { name: '双栏' }).getAttribute('aria-pressed')).toBe('true')
    expect(
      screen
        .getByRole('separator', { name: '调整 Markdown 编辑区宽度' })
        .getAttribute('aria-valuetext'),
    ).toBe('编辑区占 50%')
  })
})
