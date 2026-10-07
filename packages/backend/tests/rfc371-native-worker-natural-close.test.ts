import { expect, test } from 'bun:test'
import { nativeUsageBaselineRead } from '@/platform/persistence/nativeUsageBaselineRead'
import { openNativeUsagePassWorker } from '@/platform/background/nativeUsagePassWorkerHost'
import { persistNativeUsagePass } from '@/modules/runtime-management/application/persistNativeUsagePass'
import { originalBaselineWorkerFixture } from './helpers/rfc371NativeBaselineWorkerFixture'

test('successful original baseline and pass snapshots exit naturally after closed ACK without a second cancel or terminate', async () => {
  const fixture = await originalBaselineWorkerFixture(17),
    OriginalWorker = globalThis.Worker
  const workers: {
    closedReply: boolean
    actualClose: boolean
    destructiveAfterAck: string[]
    errors: string[]
  }[] = []
  class ObservedWorker extends OriginalWorker {
    private readonly observed = {
      closedReply: false,
      actualClose: false,
      destructiveAfterAck: [] as string[],
      errors: [] as string[],
    }
    constructor(...args: ConstructorParameters<typeof Worker>) {
      super(...args)
      workers.push(this.observed)
      this.addEventListener('message', (event: MessageEvent) => {
        const reply = event.data
        if (reply.kind === 'failed' || reply.ok === false)
          this.observed.errors.push(String(reply.error))
        if ((reply.kind === 'reply' || reply.ok === true) && reply.result?.kind === 'closed')
          this.observed.closedReply = true
      })
      this.addEventListener('error', (event) => {
        this.observed.errors.push(event.message)
      })
      this.addEventListener('close', () => {
        this.observed.actualClose = true
      })
    }
    override postMessage(...args: Parameters<Worker['postMessage']>) {
      if (this.observed.closedReply && args[0]?.kind === 'cancel')
        this.observed.destructiveAfterAck.push('cancel')
      return super.postMessage(...args)
    }
    override terminate() {
      if (this.observed.closedReply) this.observed.destructiveAfterAck.push('terminate')
      return super.terminate()
    }
  }
  globalThis.Worker = ObservedWorker
  try {
    const read = nativeUsageBaselineRead({
      provider: 'sqlite',
      db: fixture.ledger!,
      generationId: 'actual-file-worker',
    })!
    await read.run({ binding: fixture.readBinding, original: fixture.original }, async (view) => {
      expect(await view!.members([fixture.step(0), fixture.step(16)])).toEqual(
        new Set([fixture.step(0), fixture.step(16)]),
      )
    })
    const reader = await openNativeUsagePassWorker(
      { path: fixture.path, identity: fixture.f.identity('final'), pageRows: 7 },
      new AbortController().signal,
    )
    const ack = await persistNativeUsagePass(reader, fixture.f.owner())
    expect(ack.eof).not.toBeNull()
    expect(ack.counts.steps).toBe('17')
    expect(workers).toHaveLength(2)
    for (const worker of workers) {
      expect(worker.closedReply).toBe(true)
      expect(worker.actualClose).toBe(true)
      expect(worker.destructiveAfterAck).toEqual([])
      expect(worker.errors).toEqual([])
    }
  } finally {
    globalThis.Worker = OriginalWorker
    fixture.close()
  }
}, 30_000)
