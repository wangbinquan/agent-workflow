// vitest setup — runs once before the suite.
//
// Node 22+ ships a native `localStorage` global, but vitest invokes Node with
// `--localstorage-file` lacking a path, so the resulting Storage is a no-op
// `{}` shim with none of the Storage methods. Happy-dom doesn't shadow it
// either. Install a minimal in-memory shim so component code that uses
// `localStorage.getItem/setItem/clear` works under test.

class MemoryStorage implements Storage {
  private store = new Map<string, string>()
  get length(): number {
    return this.store.size
  }
  clear(): void {
    this.store.clear()
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value))
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null
  }
}

const shim = new MemoryStorage()
Object.defineProperty(globalThis, 'localStorage', { value: shim, configurable: true })
if (typeof globalThis.window !== 'undefined') {
  Object.defineProperty(globalThis.window, 'localStorage', { value: shim, configurable: true })
}

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

// React 19's concurrent scheduler defers some render work to `setImmediate`.
// When a test renders async-side-effect components (e.g. `<Prose>` lazy-loading
// shiki / mermaid / plantuml), the work can be queued just as the test ends,
// then fires after happy-dom has torn `window` down — producing "ReferenceError:
// window is not defined" inside react-dom's scheduler. Draining one
// macrotask + microtask cycle after each test gives React a chance to finish.
import { afterEach, beforeEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import {
  installUnexpectedNetworkGuard,
  resetUnexpectedNetworkRequests,
  takeUnexpectedNetworkRequests,
} from './unexpectedNetwork'

// Install immediately so test modules that capture the current fetch as their
// restore target capture the guard, not Node's real network implementation.
installUnexpectedNetworkGuard()

let languageAtTestStart: string | undefined
let localStorageAtTestStart: StorageSnapshot = []
let sessionStorageAtTestStart: StorageSnapshot = []
let browserShellAtTestStart: BrowserShellSnapshot | undefined

beforeEach(() => {
  // i18next is a process-global singleton. Preserve each test's inherited
  // baseline (including a suite-level beforeAll locale) so a case that changes
  // language cannot leak that mutation to its shuffled neighbour.
  languageAtTestStart = i18n.resolvedLanguage ?? i18n.language
  // Browser storage is process-global inside a Vitest worker. Preserve a
  // suite-level beforeAll baseline while preventing an individual test from
  // leaking auth, draft, theme, or viewed-state keys into a shuffled neighbor.
  localStorageAtTestStart = snapshotStorage(localStorage)
  sessionStorageAtTestStart = snapshotStorage(sessionStorage)
  browserShellAtTestStart = snapshotBrowserShell()
  resetUnexpectedNetworkRequests()
  installUnexpectedNetworkGuard()
})

afterEach(async () => {
  // A forgotten fake clock would also fake the macrotask drain below, hanging
  // the shared hook and poisoning every shuffled neighbor in this worker.
  if (vi.isFakeTimers()) vi.useRealTimers()
  cleanup()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const unexpected = takeUnexpectedNetworkRequests()
  const restoreLanguage = languageAtTestStart
  languageAtTestStart = undefined
  if (restoreLanguage !== undefined && i18n.resolvedLanguage !== restoreLanguage) {
    await i18n.changeLanguage(restoreLanguage)
  }
  restoreStorage(localStorage, localStorageAtTestStart)
  restoreStorage(sessionStorage, sessionStorageAtTestStart)
  localStorageAtTestStart = []
  sessionStorageAtTestStart = []
  const restoreShell = browserShellAtTestStart
  browserShellAtTestStart = undefined
  if (restoreShell !== undefined) restoreBrowserShell(restoreShell)
  if (unexpected.length > 0) {
    throw new Error(
      `Unexpected network request(s) escaped test mocks:\n${unexpected.map((r) => `- ${r}`).join('\n')}`,
    )
  }
})

// Boot i18next so components that call useTranslation() get real strings.
// Without this they render raw keys (e.g. 'onboarding.title'), which makes
// queryByText selectors fragile in render tests.
//
// MUST be top-level-awaited — a fire-and-forget dynamic import was racing
// with the first render() on slower CI runners (e.g. ubuntu-latest), where
// the test would query for translated text (`Add`, `Other (custom)…`) while
// the rendered DOM still carried raw keys (`enumPicker.add`,
// `enumPicker.otherPlaceholder`). vitest setup is an ES module, so
// top-level await is supported here.
const { default: i18n } = await import('../src/i18n')

export {}
