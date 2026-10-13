// RFC-370: the real Intent owner drains issued turn/result work, not only a
// queue admission. Explicit retries ACK the original continuation, never run it twice.
import { expect, test } from 'bun:test'
import { DEFAULT_CONFIG } from '@agent-workflow/shared'
import {
  createIntentTurnExecutionLifecycle,
  IntentExecutionDeferredError,
  IntentOriginalExecutionPendingError,
} from '../src/modules/intent/application/executionLifecycle'
import { composeIntentQueuedResumption } from '../src/modules/intent/composition/queuedResumption'
import { awaitOriginalHostPreparation } from '../src/cli/daemonHostExecutionRecovery'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

test('queued owner waits for the actual issued HTTP turn and its complete original write tail', async () => {
  const execution = createIntentTurnExecutionLifecycle()
  const queue = composeIntentQueuedResumption({
    configuration: { read: () => DEFAULT_CONFIG },
    execution,
    resume: async () => {},
    onError: () => {},
  })
  let current = true,
    models = 0,
    writes = 0,
    drained = false
  const issued = deferred<void>(),
    result = deferred<void>(),
    written = deferred<void>(),
    acknowledgeWrite = deferred<void>()
  const handle = queue.runtimeFactory.startAuthority({ current: () => current })
  const work = execution.dispatch('original-turn', async (control) => {
    expect(control.current()).toBe(true)
    models++
    issued.resolve()
    await result.promise
    writes++
    written.resolve()
    await acknowledgeWrite.promise
  })
  await issued.promise
  current = false
  handle.stop()
  const draining = handle.drain().then(() => {
    drained = true
  })
  result.resolve()
  await written.promise
  expect(drained).toBe(false)
  acknowledgeWrite.resolve()
  await Promise.all([work, draining])
  expect(models).toBe(1)
  expect(writes).toBe(1)
  expect(drained).toBe(true)
})

test('consecutive primary ACK failures retain their original positions and gate drain until the entire result tail completes', async () => {
  const owner = createIntentTurnExecutionLifecycle()
  const reported = [deferred<unknown>(), deferred<unknown>()]
  let reports = 0,
    current = true,
    models = 0,
    firstWrites = 0,
    finalWrites = 0
  const handle = owner.start({
    current: () => current,
    reportFailure: (error) => reported[reports++]!.resolve(error),
  })
  const work = owner.dispatch('original-turn', async (control) => {
    await control.checkpoint(async () => {
      if (++firstWrites === 1) throw new Error('prepared ACK lost')
    })
    models++
    await control.checkpoint(async () => {
      if (++finalWrites === 1) throw new Error('business ACK lost')
    })
  })
  const first = await reported[0]!.promise
  expect(first).toBeInstanceOf(IntentOriginalExecutionPendingError)
  handle.stop()
  await expect(handle.drain()).rejects.toThrow('intent-original-execution-pending')
  // The original prepared continuation is admitted before this simulated loss.
  const retry = owner.recoverOriginal('original-turn')
  await reported[1]!.promise
  expect(await retry).toBe(false)
  expect(models).toBe(1)
  current = false
  await expect(handle.drain()).rejects.toThrow('intent-original-execution-pending')
  expect(await owner.recoverOriginal('original-turn')).toBe(true)
  await Promise.all([work, handle.drain()])
  expect(firstWrites).toBe(2)
  expect(finalWrites).toBe(2)
  expect(models).toBe(1)
  expect((first as IntentOriginalExecutionPendingError).originalRecoveryAcknowledged()).toBe(true)
})

test('unissued original reservation waits for the next actual activation and issued recovery never auto-ACKs unknown facts', async () => {
  const owner = createIntentTurnExecutionLifecycle()
  let available = false,
    models = 0,
    physical = false,
    recoveries = 0
  const blocked = deferred<unknown>()
  const handle = owner.start({ current: () => available, reportFailure: blocked.resolve })
  await owner.dispatch('original-turn', async (control) => {
    if (!control.current()) throw new IntentExecutionDeferredError()
    models++
    await control.holdOriginal(async () => {
      recoveries++
      return physical
    })
  })
  handle.stop()
  await handle.drain()
  expect(models).toBe(0)
  available = true
  const active = deferred<boolean>()
  const next = owner.start({
    current: () => available,
    whenActive: active.promise,
    reportFailure: blocked.resolve,
  })
  expect(models).toBe(0)
  active.resolve(true)
  const error = await blocked.promise
  next.stop()
  expect(await owner.recoverOriginal('original-turn')).toBe(false)
  await expect(next.drain()).rejects.toThrow('intent-original-execution-pending')
  physical = true
  expect(await owner.recoverOriginal('original-turn')).toBe(true)
  await next.drain()
  expect(models).toBe(1)
  expect(recoveries).toBe(2)
  const preparation = Promise.reject(error)
  await awaitOriginalHostPreparation(preparation)
  await expect(
    awaitOriginalHostPreparation(Promise.reject(new Error('unacknowledged ordinary failure'))),
  ).rejects.toThrow('unacknowledged ordinary failure')
})
