// RFC-370: the owner ACK covers every receipt and the original continuation,
// even when more than one successive checkpoint loses its database ACK.
import { expect, test } from 'bun:test'
import { MemoryDistillReceiptCheckpoints } from '../src/modules/memory/application/distill/receiptCheckpoints'
import { MemoryDistillSettlementPendingError } from '../src/modules/memory/application/distill/settlement'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('successive lost ACKs never report the original continuation complete early', async () => {
  const checkpoints = new MemoryDistillReceiptCheckpoints()
  let prepareWrites = 0,
    terminalWrites = 0,
    modelCalls = 0,
    settlements = 0
  const work = (async () => {
    await checkpoints.acknowledge(['original-job'], async () => {
      if (++prepareWrites === 1) throw new Error('prepared ACK lost')
    })
    modelCalls += 1
    await checkpoints.acknowledge(['original-job'], async () => {
      if (++terminalWrites === 1) throw new Error('terminal ACK lost')
    })
    settlements += 1
  })()
  const retained = await checkpoints.retainOriginalWork(work).catch((error: unknown) => error)
  expect(retained).toBeInstanceOf(MemoryDistillSettlementPendingError)
  const original = retained as MemoryDistillSettlementPendingError
  await expect(original.retryOriginalSettlement()).rejects.toBe(original)
  expect(original.originalSettlementAcknowledged()).toBe(false)
  expect(modelCalls).toBe(1)
  expect(settlements).toBe(0)
  await original.retryOriginalSettlement()
  expect(original.originalSettlementAcknowledged()).toBe(true)
  expect({ prepareWrites, terminalWrites, modelCalls, settlements }).toEqual({
    prepareWrites: 2,
    terminalWrites: 2,
    modelCalls: 1,
    settlements: 1,
  })
})

test('concurrent drains share the original retry and wait for the final business tail', async () => {
  const checkpoints = new MemoryDistillReceiptCheckpoints(),
    finalTail = deferred(),
    tailEntered = deferred()
  let writes = 0
  const work = (async () => {
    await checkpoints.acknowledge(['original-job'], async () => {
      if (++writes === 1) throw new Error('primary ACK lost')
    })
    tailEntered.resolve()
    await finalTail.promise
  })()
  const retained = (await checkpoints
    .retainOriginalWork(work)
    .catch((error: unknown) => error)) as MemoryDistillSettlementPendingError
  let finished = 0
  const first = retained.retryOriginalSettlement().then(() => {
    finished += 1
  })
  const second = retained.retryOriginalSettlement().then(() => {
    finished += 1
  })
  await tailEntered.promise
  expect(writes).toBe(2)
  expect(finished).toBe(0)
  expect(retained.originalSettlementAcknowledged()).toBe(false)
  finalTail.resolve()
  await Promise.all([first, second])
  expect(finished).toBe(2)
  expect(retained.originalSettlementAcknowledged()).toBe(true)
})
