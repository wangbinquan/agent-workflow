// RFC-370: the real repository refresh loop waits for its selected live query.
// Initial reads, tick reads and hot reconfiguration share the stop/drain boundary.
import { expect, spyOn, test } from 'bun:test'
import type { Config } from '@agent-workflow/shared'
import { composeSqliteRepositoryWorkspaceStore } from '@/modules/source-control/composition'
import { startConfiguredSubmoduleRefreshLoop } from '@/services/submoduleRefresh'
import { describeEachProvider } from './helpers/eachProvider'

type RefreshConfig = Pick<Config, 'submoduleAutoRefresh'>

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return { promise, resolve, reject }
}

describeEachProvider('RFC-370 selected repository refresh settings', (harness) => {
  test('a rejected hot read cannot finish drain before an admitted tick settles', async () => {
    const store = composeSqliteRepositoryWorkspaceStore(harness.db)
    const select = spyOn(store, 'listDueCachedRepos')
    const timeout = spyOn(globalThis, 'setTimeout')
    const tickEntered = deferred<void>()
    const tickRelease = deferred<RefreshConfig>()
    const hotRelease = deferred<RefreshConfig>()
    const failure = new Error('hot refresh read failed during close')
    let reads = 0
    const loop = await startConfiguredSubmoduleRefreshLoop(store, {
      read() {
        reads += 1
        if (reads === 1) return { submoduleAutoRefresh: { enabled: true, intervalMs: 60_000 } }
        if (reads === 2) {
          tickEntered.resolve()
          return tickRelease.promise
        }
        return hotRelease.promise
      },
    })
    let hot: Promise<boolean> | undefined
    let closing: Promise<void> | undefined
    try {
      const index = timeout.mock.calls.findIndex((args) => args[1] === 60_000)
      const args = timeout.mock.calls[index]
      const result = timeout.mock.results[index]
      if (args === undefined || result === undefined || result.type !== 'return')
        throw new Error('refresh timer not armed')
      clearTimeout(result.value)
      const [handler, , ...rest] = args
      if (typeof handler !== 'function') throw new Error('unexpected timer handler')
      Reflect.apply(handler, undefined, rest)
      await tickEntered.promise
      hot = loop.reconfigure()
      loop.stop()
      let idle = false
      closing = loop.awaitIdle().then(() => {
        idle = true
      })
      hotRelease.reject(failure)
      await expect(hot).rejects.toBe(failure)
      await Promise.resolve()
      expect(idle).toBe(false)
      expect(select).not.toHaveBeenCalled()
      tickRelease.resolve({ submoduleAutoRefresh: { enabled: true } })
      await closing
      expect(idle).toBe(true)
      expect(select).not.toHaveBeenCalled()
    } finally {
      hotRelease.resolve({ submoduleAutoRefresh: { enabled: false } })
      tickRelease.resolve({ submoduleAutoRefresh: { enabled: false } })
      await hot?.catch(() => undefined)
      loop.stop()
      await closing
      await loop.awaitIdle()
      timeout.mockRestore()
      select.mockRestore()
    }
  })

  test('startup waits before arming and a stopped pending tick drains without refreshing', async () => {
    const store = composeSqliteRepositoryWorkspaceStore(harness.db)
    const select = spyOn(store, 'listDueCachedRepos')
    const timeout = spyOn(globalThis, 'setTimeout')
    let entered = deferred<void>()
    let released = deferred<RefreshConfig>()
    const configuration = {
      async read() {
        expect<unknown>(this).toBe(configuration)
        const pending = released.promise
        entered.resolve()
        return await pending
      },
    }
    let opened = false
    const opening = startConfiguredSubmoduleRefreshLoop(store, configuration).then((loop) => {
      opened = true
      return loop
    })
    try {
      await entered.promise
      expect(opened).toBe(false)
      expect(select).not.toHaveBeenCalled()
      expect(timeout.mock.calls.filter((args) => args[1] === 60_000)).toEqual([])
      released.resolve({ submoduleAutoRefresh: { enabled: true, intervalMs: 60_000 } })
      const loop = await opening
      entered = deferred<void>()
      released = deferred<RefreshConfig>()
      const index = timeout.mock.calls.findIndex((args) => args[1] === 60_000)
      const args = timeout.mock.calls[index]
      const result = timeout.mock.results[index]
      if (args === undefined || result === undefined || result.type !== 'return')
        throw new Error('refresh timer not armed')
      clearTimeout(result.value)
      const [handler, , ...rest] = args
      if (typeof handler !== 'function') throw new Error('unexpected timer handler')
      Reflect.apply(handler, undefined, rest)
      await entered.promise
      expect(select).not.toHaveBeenCalled()
      loop.stop()
      let idle = false
      const closing = loop.awaitIdle().then(() => {
        idle = true
      })
      await Promise.resolve()
      expect(idle).toBe(false)
      released.resolve({ submoduleAutoRefresh: { enabled: true, intervalMs: 60_000 } })
      await closing
      expect(idle).toBe(true)
      expect(select).not.toHaveBeenCalled()
      expect(timeout.mock.calls.filter((call) => call[1] === 60_000)).toHaveLength(1)
    } finally {
      released.resolve({ submoduleAutoRefresh: { enabled: false } })
      const loop = await opening
      loop.stop()
      await loop.awaitIdle()
      timeout.mockRestore()
      select.mockRestore()
    }
  })

  test('a newer hot configuration wins and stop prevents a late read from rearming', async () => {
    const store = composeSqliteRepositoryWorkspaceStore(harness.db)
    const timeout = spyOn(globalThis, 'setTimeout')
    let selected: RefreshConfig | Promise<RefreshConfig> = {
      submoduleAutoRefresh: { enabled: false },
    }
    const loop = await startConfiguredSubmoduleRefreshLoop(store, { read: () => selected })
    const older = deferred<RefreshConfig>()
    const last = deferred<RefreshConfig>()
    let oldChange: Promise<boolean> | undefined
    let lastChange: Promise<boolean> | undefined
    try {
      selected = older.promise
      oldChange = loop.reconfigure()
      selected = { submoduleAutoRefresh: { enabled: true, intervalMs: 60_000 } }
      expect(await loop.reconfigure()).toBe(true)
      older.resolve({ submoduleAutoRefresh: { enabled: false } })
      expect(await oldChange).toBe(false)
      expect(timeout.mock.calls.filter((args) => args[1] === 60_000)).toHaveLength(1)
      selected = last.promise
      lastChange = loop.reconfigure()
      loop.stop()
      let idle = false
      const closing = loop.awaitIdle().then(() => {
        idle = true
      })
      await Promise.resolve()
      expect(idle).toBe(false)
      last.resolve({ submoduleAutoRefresh: { enabled: true, intervalMs: 120_000 } })
      expect(await lastChange).toBe(false)
      await closing
      expect(idle).toBe(true)
      expect(timeout.mock.calls.filter((args) => args[1] === 120_000)).toEqual([])
      expect(await loop.reconfigure()).toBe(false)
    } finally {
      older.resolve({ submoduleAutoRefresh: { enabled: false } })
      last.resolve({ submoduleAutoRefresh: { enabled: false } })
      await oldChange
      await lastChange
      loop.stop()
      await loop.awaitIdle()
      timeout.mockRestore()
    }
  })

  test('selected startup and hot read failure propagate without arming a replacement', async () => {
    const store = composeSqliteRepositoryWorkspaceStore(harness.db)
    const timeout = spyOn(globalThis, 'setTimeout')
    const failure = new Error('selected refresh configuration unavailable')
    let reject = true
    const configuration = {
      async read(): Promise<RefreshConfig> {
        if (reject) throw failure
        return { submoduleAutoRefresh: { enabled: false } }
      },
    }
    let loop: Awaited<ReturnType<typeof startConfiguredSubmoduleRefreshLoop>> | undefined
    try {
      await expect(startConfiguredSubmoduleRefreshLoop(store, configuration)).rejects.toBe(failure)
      reject = false
      loop = await startConfiguredSubmoduleRefreshLoop(store, configuration)
      reject = true
      await expect(loop.reconfigure()).rejects.toBe(failure)
      expect(timeout.mock.calls.filter((args) => args[1] === 60_000)).toEqual([])
    } finally {
      loop?.stop()
      await loop?.awaitIdle()
      timeout.mockRestore()
    }
  })
})
