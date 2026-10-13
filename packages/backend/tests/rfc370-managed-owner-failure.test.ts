// RFC-370: a terminated managed owner reports the original fatal error while
// retaining that same error as a failed drain. This is a lifecycle contract;
// provider write retirement is covered by the actual activation-barrier suite.
import { expect, test } from 'bun:test'
import { startAuthorityManagedWorker } from '@/platform/background/authorityManagedWorker'
import type {
  AuthorityManagedWorkerDefinition,
  BackgroundExecutionLifetime,
} from '@/platform/background/definitions'
import { deferred } from './helpers/taskHostExecution'

test('the actual managed worker reports its original fatal result through the captured lifetime receiver without acknowledging drain', async () => {
  const entered = deferred(),
    release = deferred(),
    failure = new Error('original managed owner failure')
  const reports: unknown[] = [],
    stops: string[] = []
  const lifetime = {
    current: () => true,
    reportFailure(error: unknown) {
      expect(this).toBe(lifetime)
      reports.push(error)
    },
  } satisfies BackgroundExecutionLifetime
  const definition: AuthorityManagedWorkerDefinition = {
    id: 'managed-owner-failure',
    owner: 'fixture-owner',
    phase: 'after-ready',
    kind: 'long-running',
    dependencies: [],
    supportsExecutionLifetime: true,
    readiness: () => 'ready',
    state: () => ({}),
    start(context) {
      expect(this).toBe(definition)
      expect(context.execution?.current()).toBe(true)
    },
    async run() {
      expect(this).toBe(definition)
      entered.resolve()
      await release.promise
      throw failure
    },
    stop(reason) {
      expect(this).toBe(definition)
      stops.push(reason)
    },
    health: () => ({ status: 'healthy', checkedAt: 'fixture-not-a-runtime-proof' }),
  }
  const worker = await startAuthorityManagedWorker({
    definition,
    daemonGeneration: 'managed-failure-generation',
    lifetime,
  })
  lifetime.reportFailure = () => {
    throw new Error('replacement failure callback')
  }
  try {
    await entered.promise
    release.resolve()
    await expect(worker.done).rejects.toBe(failure)
    expect(reports).toEqual([failure])
    await worker.quiesceAuthorityLoss()
    await expect(worker.drain()).rejects.toBe(failure)
    expect(stops).toEqual(['authority-loss'])
  } finally {
    release.resolve()
    await worker.quiesceAuthorityLoss()
    await worker.drain().catch(() => {})
  }
})
