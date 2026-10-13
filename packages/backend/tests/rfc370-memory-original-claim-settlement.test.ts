// RFC-370: settlement retries must preserve a replacement attempt and an
// operator cancellation after the original failure receipt was committed.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { describeEachProvider } from './helpers/eachProvider'
import { memoryDistillJobs } from '../src/db/schema'
import { DrizzleMemoryDistillWorkStore } from '../src/modules/memory/infrastructure/memoryDistillWorkStore'

describeEachProvider('RFC-370 original Memory claim settlement', (scope) => {
  async function claim() {
    const store = new DrizzleMemoryDistillWorkStore(scope.db)
    for (const id of ['original-head', 'original-sibling'])
      await store.enqueue({
        id,
        debounceKey: 'original-bundle',
        sourceKind: 'clarify',
        sourceEventId: id,
        taskId: null,
        scope: { agentIds: [], workflowId: null, repoId: null, includeGlobal: true },
        nextRunAt: 11,
        createdAt: 12,
        outputLang: null,
      })
    const ids = ['original-head', 'original-sibling']
    await store.markRunning(ids, 13)
    return { store, ids, original: await store.loadJobs(ids) }
  }

  test('one replaced sibling leaves the entire original bundle unchanged', async () => {
    const { store, ids, original } = await claim()
    await scope.db
      .update(memoryDistillJobs)
      .set({ attempts: 1, startedAt: 99 })
      .where(eq(memoryDistillJobs.id, ids[1]!))
    const before = await store.loadJobs(ids)
    await expect(store.markDone(ids, 21, original)).rejects.toThrow('original-settlement-unproven')
    await expect(
      store.markFailed({
        ids,
        original,
        attempts: 1,
        now: 21,
        retryAt: 30_021,
        error: 'original failure',
      }),
    ).rejects.toThrow('original-settlement-unproven')
    expect(await store.loadJobs(ids)).toEqual(before)
  })

  test('retrying an acknowledged failure preserves a later cancellation and its time', async () => {
    const { store, ids, original } = await claim()
    const failure = {
      ids,
      original,
      attempts: 1,
      now: 21,
      retryAt: 30_021,
      error: 'original failure',
    }
    await store.markFailed(failure)
    expect(await store.cancelPending(ids[0]!, 41)).toBe(true)
    const before = await store.loadJobs(ids)
    await store.markFailed(failure)
    expect(await store.loadJobs(ids)).toEqual(before)
    expect(before.find((row) => row.id === ids[0])).toMatchObject({
      status: 'canceled',
      finishedAt: 41,
      attempts: 1,
      nextRunAt: 30_021,
    })
  })

  test('duplicate original subjects cannot partially settle a different bundle', async () => {
    const { store, ids, original } = await claim()
    const duplicate = [original[0]!, original[0]!]
    await expect(store.markDone(ids, 21, duplicate)).rejects.toThrow('original-settlement-unproven')
    expect(await store.loadJobs(ids)).toEqual(original)
  })

  test('competing outcomes cannot both acknowledge different results for one issued bundle', async () => {
    const { store, ids, original } = await claim()
    const results = await Promise.allSettled([
      store.markDone(ids, 21, original),
      store.markFailed({
        ids,
        original,
        attempts: 1,
        now: 22,
        retryAt: 30_022,
        error: 'competing failure',
      }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rows = await store.loadJobs(ids)
    expect(new Set(rows.map((row) => row.status)).size).toBe(1)
    expect(rows.map((row) => row.attempts)).toEqual(
      results[0]?.status === 'fulfilled' ? [0, 0] : [1, 1],
    )
  })
})
