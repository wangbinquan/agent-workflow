import type { DevelopmentActivityOperations, DevelopmentActivityResult } from '../public/operations'

export interface DevelopmentActivityWorker {
  runOneOutbox(): Promise<'completed' | 'retried' | 'idle'>
  pumpOneDelivery(): boolean
  planOneReaction(): string | null
  inspectOneExecution(): Promise<'completed' | 'retried' | 'failed' | 'pending' | 'idle'>
  publishOneChannelResult(): 'completed' | 'idle'
}

export interface DevelopmentActivityWorkerBinding {
  readonly operations: DevelopmentActivityOperations
  bind(worker: DevelopmentActivityWorker): void
}

function operationsFor(worker: () => DevelopmentActivityWorker): DevelopmentActivityOperations {
  return Object.freeze({
    async runOneWorkerCycle(): Promise<DevelopmentActivityResult> {
      const bound = worker()
      const channel = bound.publishOneChannelResult()
      if (channel !== 'idle') return { activity: 'channel', state: channel }
      const outbox = await bound.runOneOutbox()
      if (outbox !== 'idle') return { activity: 'outbox', state: outbox }
      if (bound.pumpOneDelivery()) return { activity: 'delivery', state: 'completed' }
      const roundId = bound.planOneReaction()
      if (roundId !== null) return { activity: 'reaction', state: roundId }
      return { activity: 'execution', state: await bound.inspectOneExecution() }
    },
  })
}

export function createDevelopmentActivityWorkerBinding(): DevelopmentActivityWorkerBinding {
  let worker: DevelopmentActivityWorker | null = null
  return Object.freeze({
    operations: operationsFor(() => {
      if (worker === null) throw new Error('development-activity-worker-not-bound')
      return worker
    }),
    bind(next: DevelopmentActivityWorker) {
      if (worker !== null) throw new Error('development-activity-worker-already-bound')
      worker = next
    },
  })
}
