// Regression guard for process-global frontend test state.
//
// The suite deliberately chooses zh-CN as its baseline, while both cases
// switch away to en-US. The shared setup must restore the inherited suite
// baseline before whichever case Vitest shuffles next.

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import i18n from '@/i18n'

type StorageSnapshot = Array<[string, string]>
type AttributeSnapshot = Array<[string, string]>

interface BrowserShellSnapshot {
  href: string
  historyState: unknown
  title: string
  htmlAttributes: AttributeSnapshot
  bodyAttributes: AttributeSnapshot
}

function snapshotStorage(storage: Storage): StorageSnapshot {
  const snapshot: StorageSnapshot = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key === null) continue
    const value = storage.getItem(key)
    if (value !== null) snapshot.push([key, value])
  }
  return snapshot
}

function restoreStorage(storage: Storage, snapshot: StorageSnapshot): void {
  storage.clear()
  for (const [key, value] of snapshot) storage.setItem(key, value)
}

function snapshotAttributes(element: Element): AttributeSnapshot {
  return element.getAttributeNames().map((name) => [name, element.getAttribute(name) ?? ''])
}

function restoreAttributes(element: Element, snapshot: AttributeSnapshot): void {
  for (const name of element.getAttributeNames()) element.removeAttribute(name)
  for (const [name, value] of snapshot) element.setAttribute(name, value)
}

function snapshotBrowserShell(): BrowserShellSnapshot {
  return {
    href: window.location.href,
    historyState: window.history.state,
    title: document.title,
    htmlAttributes: snapshotAttributes(document.documentElement),
    bodyAttributes: snapshotAttributes(document.body),
  }
}

function restoreBrowserShell(snapshot: BrowserShellSnapshot): void {
  window.history.replaceState(snapshot.historyState, '', snapshot.href)
  document.title = snapshot.title
  restoreAttributes(document.documentElement, snapshot.htmlAttributes)
  restoreAttributes(document.body, snapshot.bodyAttributes)
}

describe('frontend test harness isolation', () => {
  let originalLanguage = 'en-US'

  beforeAll(async () => {
    originalLanguage = i18n.resolvedLanguage ?? i18n.language
    await i18n.changeLanguage('zh-CN')
  })

  afterAll(async () => {
    await i18n.changeLanguage(originalLanguage)
  })

  beforeEach(() => {
    expect(i18n.resolvedLanguage).toBe('zh-CN')
  })

  for (const label of ['first mutation', 'second mutation']) {
    test(label, async () => {
      await i18n.changeLanguage('en-US')
      expect(i18n.resolvedLanguage).toBe('en-US')
    })
  }
})

describe('frontend test harness storage isolation', () => {
  let originalLocalStorage: StorageSnapshot = []
  let originalSessionStorage: StorageSnapshot = []

  beforeAll(() => {
    originalLocalStorage = snapshotStorage(localStorage)
    originalSessionStorage = snapshotStorage(sessionStorage)
    localStorage.clear()
    sessionStorage.clear()
    localStorage.setItem('harness-baseline', 'local')
    sessionStorage.setItem('harness-baseline', 'session')
  })

  afterAll(() => {
    restoreStorage(localStorage, originalLocalStorage)
    restoreStorage(sessionStorage, originalSessionStorage)
  })

  beforeEach(() => {
    expect(localStorage.getItem('harness-baseline')).toBe('local')
    expect(sessionStorage.getItem('harness-baseline')).toBe('session')
    expect(localStorage.getItem('harness-mutation')).toBeNull()
    expect(sessionStorage.getItem('harness-mutation')).toBeNull()
  })

  for (const label of ['first mutation', 'second mutation']) {
    test(label, () => {
      localStorage.setItem('harness-mutation', label)
      sessionStorage.setItem('harness-mutation', label)
    })
  }
})

describe('frontend test harness timer isolation', () => {
  beforeEach(() => {
    expect(vi.isFakeTimers()).toBe(false)
  })

  for (const label of ['first fake clock', 'second fake clock']) {
    test(label, () => {
      vi.useFakeTimers()
      expect(vi.isFakeTimers()).toBe(true)
    })
  }
})

describe('frontend test harness browser-shell isolation', () => {
  let originalShell: BrowserShellSnapshot

  beforeAll(() => {
    originalShell = snapshotBrowserShell()
    window.history.replaceState({ scope: 'suite' }, '', '/harness-baseline?scope=suite#stable')
    document.title = 'harness baseline'
    document.documentElement.setAttribute('data-harness-baseline', 'html')
    document.body.setAttribute('data-harness-baseline', 'body')
  })

  afterAll(() => {
    restoreBrowserShell(originalShell)
  })

  beforeEach(() => {
    expect(window.location.pathname).toBe('/harness-baseline')
    expect(window.location.search).toBe('?scope=suite')
    expect(window.location.hash).toBe('#stable')
    expect(window.history.state).toEqual({ scope: 'suite' })
    expect(document.title).toBe('harness baseline')
    expect(document.documentElement.getAttribute('data-harness-baseline')).toBe('html')
    expect(document.body.getAttribute('data-harness-baseline')).toBe('body')
    expect(document.documentElement.hasAttribute('data-harness-mutation')).toBe(false)
    expect(document.body.hasAttribute('data-harness-mutation')).toBe(false)
  })

  for (const label of ['first shell mutation', 'second shell mutation']) {
    test(label, () => {
      window.history.replaceState({ leaked: label }, '', `/harness-mutation#${label}`)
      document.title = label
      document.documentElement.setAttribute('data-harness-mutation', label)
      document.body.setAttribute('data-harness-mutation', label)
    })
  }
})
