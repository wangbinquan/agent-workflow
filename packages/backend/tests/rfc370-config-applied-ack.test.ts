// RFC-370: Settings saves must wait for asynchronous hot-apply consumers while
// retaining immediate synchronous notification and best-effort error isolation.
import { describe, expect, test } from 'bun:test'
import { DEFAULT_CONFIG, type Config } from '@agent-workflow/shared'
import {
  notifyConfigApplied,
  registerConfigAppliedListener,
} from '@/services/configAppliedListeners'

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

describe('RFC-370 configuration hot-apply acknowledgements', () => {
  test('legacy void callbacks with implicit synchronous return values keep notify synchronous', () => {
    const key = 'rfc370-implicit-void-notification' // gitleaks:allow -- listener namespace, not a credential
    const calls: string[] = []
    const implicitNumber: (config: Config) => void = () => calls.push('number')
    const implicitNull: (config: Config) => void = () => null
    const unregister = [
      registerConfigAppliedListener(key, implicitNumber),
      registerConfigAppliedListener(key, implicitNull),
    ]
    try {
      expect(notifyConfigApplied(key, DEFAULT_CONFIG)).toBeUndefined()
      expect(calls).toEqual(['number'])
    } finally {
      for (const close of unregister) close()
    }
  })

  test('synchronous consumers are still called immediately and notify stays synchronous', () => {
    const calls: string[] = []
    const key = 'rfc370-sync-notification'
    const unregister = [
      registerConfigAppliedListener(key, (config) => {
        expect(config).toBe(DEFAULT_CONFIG)
        calls.push('first')
      }),
      registerConfigAppliedListener(key, () => {
        calls.push('second')
      }),
    ]
    try {
      expect(notifyConfigApplied(key, DEFAULT_CONFIG)).toBeUndefined()
      expect(calls).toEqual(['first', 'second'])
    } finally {
      for (const close of unregister) close()
    }
    notifyConfigApplied(key, DEFAULT_CONFIG)
    expect(calls).toEqual(['first', 'second'])
  })

  test('notification waits for held hot apply and still calls the next consumer promptly', async () => {
    const entered = barrier(),
      release = barrier()
    const key = 'rfc370-async-notification'
    const calls: string[] = []
    const unregister = [
      registerConfigAppliedListener(key, async (config) => {
        expect(config).toBe(DEFAULT_CONFIG)
        entered.resolve()
        await release.promise
        calls.push('ack')
      }),
      registerConfigAppliedListener(key, () => {
        calls.push('next')
      }),
    ]
    let settled = false
    const pending = Promise.resolve(notifyConfigApplied(key, DEFAULT_CONFIG)).then(() => {
      settled = true
    })
    try {
      await entered.promise
      expect(calls).toEqual(['next'])
      expect(settled).toBe(false)
      release.resolve()
      await pending
      expect(calls).toEqual(['next', 'ack'])
      expect(settled).toBe(true)
    } finally {
      release.resolve()
      await pending
      for (const close of unregister) close()
    }
  })

  test('sync and async failures keep best-effort delivery without skipping another pending ACK', async () => {
    const release = barrier()
    const key = 'rfc370-failed-notification'
    const calls: string[] = []
    const unregister = [
      registerConfigAppliedListener(key, () => {
        throw new Error('synchronous hot apply failed')
      }),
      registerConfigAppliedListener(key, async () => {
        throw new Error('asynchronous hot apply failed')
      }),
      registerConfigAppliedListener(key, async () => {
        calls.push('entered')
        await release.promise
        calls.push('ack')
      }),
    ]
    let settled = false
    const pending = Promise.resolve(notifyConfigApplied(key, DEFAULT_CONFIG)).then(() => {
      settled = true
    })
    try {
      await Promise.resolve()
      expect(calls).toEqual(['entered'])
      expect(settled).toBe(false)
      release.resolve()
      await pending
      expect(calls).toEqual(['entered', 'ack'])
    } finally {
      release.resolve()
      await pending
      for (const close of unregister) close()
    }
  })
})
