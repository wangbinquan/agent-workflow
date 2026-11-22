// RFC-370: Settings saves must wait for asynchronous hot-apply consumers while
// retaining immediate synchronous notification and best-effort error isolation.
import { describe, expect, test } from 'bun:test'
import { DEFAULT_CONFIG, type Config } from '@agent-workflow/shared'
import { createConfigAppliedListeners } from '@/platform/configuration/configAppliedListeners'

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
    // RFC-536: the listener set of one application configuration.
    const listeners = createConfigAppliedListeners(key)
    const calls: string[] = []
    const implicitNumber: (config: Config) => void = () => calls.push('number')
    const implicitNull: (config: Config) => void = () => null
    const unregister = [listeners.register(implicitNumber), listeners.register(implicitNull)]
    try {
      expect(listeners.notify(DEFAULT_CONFIG)).toBeUndefined()
      expect(calls).toEqual(['number'])
    } finally {
      for (const close of unregister) close()
    }
  })

  test('synchronous consumers are still called immediately and notify stays synchronous', () => {
    const calls: string[] = []
    const key = 'rfc370-sync-notification'
    // RFC-536: the listener set of one application configuration.
    const listeners = createConfigAppliedListeners(key)
    const unregister = [
      listeners.register((config) => {
        expect(config).toBe(DEFAULT_CONFIG)
        calls.push('first')
      }),
      listeners.register(() => {
        calls.push('second')
      }),
    ]
    try {
      expect(listeners.notify(DEFAULT_CONFIG)).toBeUndefined()
      expect(calls).toEqual(['first', 'second'])
    } finally {
      for (const close of unregister) close()
    }
    listeners.notify(DEFAULT_CONFIG)
    expect(calls).toEqual(['first', 'second'])
  })

  test('notification waits for held hot apply and still calls the next consumer promptly', async () => {
    const entered = barrier(),
      release = barrier()
    const key = 'rfc370-async-notification'
    // RFC-536: the listener set of one application configuration.
    const listeners = createConfigAppliedListeners(key)
    const calls: string[] = []
    const unregister = [
      listeners.register(async (config) => {
        expect(config).toBe(DEFAULT_CONFIG)
        entered.resolve()
        await release.promise
        calls.push('ack')
      }),
      listeners.register(() => {
        calls.push('next')
      }),
    ]
    let settled = false
    const pending = Promise.resolve(listeners.notify(DEFAULT_CONFIG)).then(() => {
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
    // RFC-536: the listener set of one application configuration.
    const listeners = createConfigAppliedListeners(key)
    const calls: string[] = []
    const unregister = [
      listeners.register(() => {
        throw new Error('synchronous hot apply failed')
      }),
      listeners.register(async () => {
        throw new Error('asynchronous hot apply failed')
      }),
      listeners.register(async () => {
        calls.push('entered')
        await release.promise
        calls.push('ack')
      }),
    ]
    let settled = false
    const pending = Promise.resolve(listeners.notify(DEFAULT_CONFIG)).then(() => {
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
