// RFC-371 / CI 38506044476: a source clock must not hold a shared row lock
// across producer transactions, or miss a writer which commits out of order.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { agents, observationSourceRevisions } from '@/db/schema'
import { observationProjectionChanges } from '@/db/observationProjection'
import { completeCalculationSourceProof } from '@/modules/run-observability/infrastructure/completeCalculationSourceProof'
import { incrementalObservationChangeQueue } from '@/modules/run-observability/infrastructure/incrementalObservationChanges'
import { originalObservationProjectionRouter } from '@/platform/persistence/observationProjectionRouting'
import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('RFC-371 committed source clock without producer serialization', (h) => {
  const clock = async () => {
    const proof = await completeCalculationSourceProof(h.db, 'original-committed-clock')
    expect(proof).not.toBeNull()
    expect(proof!.relations).toHaveLength(55)
    return proof!.relations.find((row) => row.sourceId === 'agents')!.revision
  }
  test('two original same-source serializable writers both arrive before either commits, with no body replay', async () => {
    const runs = [0, 0],
      concurrent = h.applicationBinding.provider === 'postgresql'
    let arrived = 0,
      release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      release()
    }, 3000)
    const write = (n: number) =>
      h.session.serializable(async (tx) => {
        runs[n]!++
        await tx
          .insert(agents)
          .values({ id: 'original-clock-' + n, name: 'Original clock ' + n })
          .run()
        if (concurrent && runs[n] === 1) {
          if (++arrived === 2) release()
          await barrier
        }
      })
    const before = await clock()
    try {
      if (concurrent) await Promise.all([write(0), write(1)])
      else {
        await write(0)
        await write(1)
      }
    } finally {
      clearTimeout(timer)
      release()
    }
    expect(timedOut).toBe(false)
    expect(runs).toEqual([1, 1])
    expect(await clock()).not.toBe(before)
    expect(
      (await h.db.select().from(agents).all()).filter((row) =>
        row.id.startsWith('original-clock-'),
      ),
    ).toHaveLength(2)
  })

  test('a late committed original writer changes the same-snapshot clock; uncommitted and rolled-back writes do not', async () => {
    const concurrent = h.applicationBinding.provider === 'postgresql'
    let release!: () => void, arrived!: () => void
    const hold = new Promise<void>((resolve) => {
        release = resolve
      }),
      ready = new Promise<void>((resolve) => {
        arrived = resolve
      }),
      before = await clock()
    if (concurrent) {
      const late = h.session.transaction(async (tx) => {
        await tx
          .insert(agents)
          .values({ id: 'original-late-clock', name: 'Original late clock' })
          .run()
        arrived()
        await hold
      })
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        release()
      }, 3000)
      try {
        await ready
        expect(await clock()).toBe(before)
        await h.db
          .insert(agents)
          .values({ id: 'original-earlier-commit', name: 'Original earlier commit' })
          .run()
        const earlier = await clock()
        expect(timedOut).toBe(false)
        expect(earlier).not.toBe(before)
        release()
        await late
        expect(await clock()).not.toBe(earlier)
      } finally {
        clearTimeout(timer)
        release()
        await late
      }
    } else {
      await h.db
        .insert(agents)
        .values({ id: 'original-earlier-commit', name: 'Original earlier commit' })
        .run()
      const earlier = await clock()
      await h.db
        .insert(agents)
        .values({ id: 'original-late-clock', name: 'Original late clock' })
        .run()
      expect(await clock()).not.toBe(earlier)
    }
    const committed = await clock()
    await expect(
      h.session.transaction(async (tx) => {
        await tx
          .insert(agents)
          .values({ id: 'original-rolled-back-clock', name: 'Original rollback' })
          .run()
        throw new Error('original-clock-rollback')
      }),
    ).rejects.toThrow('original-clock-rollback')
    expect(await clock()).toBe(committed)
    expect(
      await h.db.select().from(agents).where(eq(agents.id, 'original-rolled-back-clock')).get(),
    ).toBeUndefined()
  })

  test('actual durable routing moves the clock with ACK and cannot reuse an old pending count after original journal cleanup', async () => {
    await h.db.insert(agents).values({ id: 'original-ack-clock', name: 'Original ACK clock' }).run()
    const pending = await clock(),
      rows = await h.db
        .select()
        .from(observationProjectionChanges)
        .where(eq(observationProjectionChanges.source, 'agents'))
        .all(),
      originalIds = rows.filter((row) => !row.completed).map((row) => row.id),
      queue = incrementalObservationChangeQueue(h.db, (error) => {
        throw error
      }),
      router = originalObservationProjectionRouter()
    expect(originalIds.length).toBeGreaterThan(0)
    while (await queue.dispatch(router, 2)) {
      /* complete original EOF, never a population cap */
    }
    const acknowledged = await clock()
    expect(acknowledged).not.toBe(pending)
    for (const id of originalIds)
      expect(
        await h.db
          .select()
          .from(observationProjectionChanges)
          .where(eq(observationProjectionChanges.id, id))
          .get(),
      ).toMatchObject({ completed: true })
    const base = await h.db
      .select()
      .from(observationSourceRevisions)
      .where(eq(observationSourceRevisions.sourceId, 'agents'))
      .get()
    expect(base?.revision).toBeTruthy()
    await h.db
      .delete(observationProjectionChanges)
      .where(eq(observationProjectionChanges.completed, true))
      .run()
    expect(await clock()).toBe(acknowledged)
    await h.db
      .update(agents)
      .set({ name: 'Original later value' })
      .where(eq(agents.id, 'original-ack-clock'))
      .run()
    expect(await clock()).not.toBe(pending)
    expect(await clock()).not.toBe(acknowledged)
    expect(
      await h.db.select().from(agents).where(eq(agents.id, 'original-ack-clock')).get(),
    ).toMatchObject({ name: 'Original later value' })
  })
})
