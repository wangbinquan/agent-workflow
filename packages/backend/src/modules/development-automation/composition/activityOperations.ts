import type { DevelopmentActivityOperations, DevelopmentActivityResult } from '../public/operations'

export interface DevelopmentActivityWorker {
  runOneOutbox(): Promise<'completed' | 'retried' | 'idle'>
  pumpOneDelivery(): boolean
  planOneReaction(): string | null
  inspectOneExecution(): Promise<'completed' | 'retried' | 'failed' | 'pending' | 'idle'>
  publishOneChannelResult(): 'completed' | 'idle'
}

export function composeDevelopmentActivityOperations(
  worker: DevelopmentActivityWorker,
): DevelopmentActivityOperations {
  return Object.freeze({
    async runOneWorkerCycle(): Promise<DevelopmentActivityResult> {
      const channel = worker.publishOneChannelResult()
      if (channel !== 'idle') return { activity: 'channel', state: channel }
      const outbox = await worker.runOneOutbox()
      if (outbox !== 'idle') return { activity: 'outbox', state: outbox }
      if (worker.pumpOneDelivery()) return { activity: 'delivery', state: 'completed' }
      const roundId = worker.planOneReaction()
      if (roundId !== null) return { activity: 'reaction', state: roundId }
      return { activity: 'execution', state: await worker.inspectOneExecution() }
    },
  })
}
