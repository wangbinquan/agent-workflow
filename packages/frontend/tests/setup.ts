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

// React 19's concurrent scheduler defers some render work to `setImmediate`.
// When a test renders async-side-effect components (e.g. `<Prose>` lazy-loading
// shiki / mermaid / plantuml), the work can be queued just as the test ends,
// then fires after happy-dom has torn `window` down — producing "ReferenceError:
// window is not defined" inside react-dom's scheduler. Draining one
// macrotask + microtask cycle after each test gives React a chance to finish.
import { afterEach, beforeEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import {
  installUnexpectedNetworkGuard,
  resetUnexpectedNetworkRequests,
  takeUnexpectedNetworkRequests,
} from './unexpectedNetwork'

// Install immediately so test modules that capture the current fetch as their
// restore target capture the guard, not Node's real network implementation.
installUnexpectedNetworkGuard()

beforeEach(() => {
  resetUnexpectedNetworkRequests()
  installUnexpectedNetworkGuard()
})

afterEach(async () => {
  cleanup()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const unexpected = takeUnexpectedNetworkRequests()
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
await import('../src/i18n')

export {}
