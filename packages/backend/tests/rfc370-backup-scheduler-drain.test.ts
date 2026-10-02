// RFC-370: provider close awaits the scheduled backup acknowledgement and the
// existing post-backup retention wake. Timer stop alone cannot close its DB.
import { describe, expect, spyOn, test } from 'bun:test'
import { startBackupScheduler } from '@/services/backupScheduler'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

describe('RFC-370 scheduled backup stop and drain', () => {
  test('a provider callback can synchronously stop and drain its own admitted request', async () => {
    const entered = deferred()
    const released = deferred()
    const interval = spyOn(globalThis, 'setInterval')
    let closing: Promise<void> | undefined
    let idle = false
    let wakes = 0
    const scheduler: ReturnType<typeof startBackupScheduler> = startBackupScheduler({
      intervalMs: 123_456,
      retentionCount: 3,
      retentionDays: 7,
      pruneMode: 'external',
      onBackupSettled: () => {
        wakes += 1
      },
      async createScheduledBackup() {
        scheduler.stop()
        closing = scheduler.awaitIdle().then(() => {
          idle = true
        })
        entered.resolve()
        await released.promise
      },
      appHome: '/selected-backup-home',
    })
    try {
      const index = interval.mock.calls.findIndex((args) => args[1] === 123_456)
      const args = interval.mock.calls[index]
      const result = interval.mock.results[index]
      if (args === undefined || result === undefined || result.type !== 'return')
        throw new Error('backup timer not registered')
      clearInterval(result.value)
      const [handler, , ...rest] = args
      if (typeof handler !== 'function') throw new Error('unexpected interval handler')
      Reflect.apply(handler, undefined, rest)
      await entered.promise
      await Promise.resolve()
      expect(idle).toBe(false)
      expect(wakes).toBe(0)
      released.resolve()
      await closing
      expect(idle).toBe(true)
      expect(wakes).toBe(1)
    } finally {
      released.resolve()
      scheduler.stop()
      await closing
      await scheduler.awaitIdle()
      interval.mockRestore()
    }
  })

  for (const fail of [false, true]) {
    test(`drain waits for the ${fail ? 'failed' : 'successful'} admitted provider request and settlement`, async () => {
      const entered = deferred()
      const released = deferred()
      const interval = spyOn(globalThis, 'setInterval')
      let calls = 0
      let wakes = 0
      const scheduler = startBackupScheduler({
        intervalMs: 123_456,
        retentionCount: 3,
        retentionDays: 7,
        pruneMode: 'external',
        onBackupSettled: () => {
          wakes += 1
        },
        async createScheduledBackup(request) {
          expect(request).toEqual({ kind: 'scheduled', appHome: '/selected-backup-home' })
          calls += 1
          entered.resolve()
          await released.promise
          if (fail) throw new Error('selected backup failed')
        },
        appHome: '/selected-backup-home',
      })
      const index = interval.mock.calls.findIndex((args) => args[1] === 123_456)
      const args = interval.mock.calls[index]
      const result = interval.mock.results[index]
      let closing: Promise<void> | undefined
      try {
        if (args === undefined || result === undefined || result.type !== 'return')
          throw new Error('backup timer not registered')
        clearInterval(result.value)
        const [handler, , ...rest] = args
        if (typeof handler !== 'function') throw new Error('unexpected interval handler')
        Reflect.apply(handler, undefined, rest)
        await entered.promise
        Reflect.apply(handler, undefined, rest)
        expect(calls).toBe(1)
        expect(wakes).toBe(0)
        scheduler.stop()
        let idle = false
        closing = scheduler.awaitIdle().then(() => {
          idle = true
        })
        await Promise.resolve()
        expect(idle).toBe(false)
        Reflect.apply(handler, undefined, rest)
        expect(calls).toBe(1)
        released.resolve()
        await closing
        expect(idle).toBe(true)
        expect(wakes).toBe(1)
        expect(calls).toBe(1)
        await scheduler.awaitIdle()
      } finally {
        released.resolve()
        scheduler.stop()
        await closing
        await scheduler.awaitIdle()
        interval.mockRestore()
      }
    })
  }
})
