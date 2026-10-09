// AW-R06: physical Task birth and transport pages must never cap actual consumption candidates.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { buildActor } from '@/auth/actor'
import { tasks } from '@/db/schema'
import { createCompleteTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
import { COMPLETE_NOW, seedCompleteTask } from './helpers/rfc371CompleteTaskFixture'
import { describeEachProvider } from './helpers/eachProvider'

const actor = buildActor({
  source: 'session',
  user: {
    id: 'complete-task-reader',
    username: 'complete-task-reader',
    displayName: 'reader',
    role: 'admin',
    status: 'active',
  },
})
describeEachProvider('RFC-371 usage-window original owner population', (harness) => {
  test('all 201 original Tasks outside the birth window remain reachable through real EOF with a different cohort cursor', async () => {
    await seedCompleteTask(harness, 1, 1)
    await harness.db
      .update(tasks)
      .set({ startedAt: COMPLETE_NOW - 1000 })
      .where(eq(tasks.id, 'complete-original-task'))
      .run()
    const original = await harness.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, 'complete-original-task'))
      .get()
    if (!original) throw new Error('Original Task seed missing')
    for (let start = 1; start <= 200; start += 50)
      await harness.db
        .insert(tasks)
        .values(
          Array.from({ length: Math.min(50, 201 - start) }, (_, offset) => {
            const id = 'usage-owner-' + String(start + offset).padStart(4, '0')
            return {
              ...original,
              id,
              rootTaskId: id,
              name: 'Original task ' + id,
              workflowSnapshot: '{}',
              deletedAt: start + offset === 2 ? COMPLETE_NOW : null,
              spaceKind: start + offset === 3 ? ('internal' as const) : original.spaceKind,
            }
          }),
        )
        .run()
    const source = createCompleteTaskObservationFacts(harness.db)
    const range = { from: COMPLETE_NOW, to: COMPLETE_NOW + 60000, timezone: 'UTC', limit: 17 }
    expect((await source.list({ actor, query: range })).items).toHaveLength(0)
    const ids = new Set<string>()
    let after: string | undefined,
      firstCursor: string | null = null
    for (;;) {
      const page = await source.list({
        actor,
        query: { ...range, cohort: 'usage', ...(after === undefined ? {} : { after }) },
      })
      for (const task of page.items) {
        expect(ids.has(task.id)).toBe(false)
        ids.add(task.id)
      }
      if (firstCursor === null) firstCursor = page.nextCursor
      if (page.nextCursor === null) break
      expect(page.nextCursor).not.toBe(after)
      after = page.nextCursor
    }
    expect(ids.size).toBe(201)
    expect(ids.has('usage-owner-0002')).toBe(true)
    expect(ids.has('usage-owner-0003')).toBe(true)
    expect(firstCursor).not.toBeNull()
    await expect(source.list({ actor, query: { ...range, after: firstCursor! } })).rejects.toThrow(
      'cursor changed scope',
    )
  }, 120000)
})
