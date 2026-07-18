// Regression guard for process-global frontend test state.
//
// The suite deliberately chooses zh-CN as its baseline, while both cases
// switch away to en-US. The shared setup must restore the inherited suite
// baseline before whichever case Vitest shuffles next.

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import i18n from '@/i18n'

type StorageSnapshot = Array<[string, string]>

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
