// RFC-371: migrated PostgreSQL already seeds source revisions, and restoring
// business rows invokes their triggers. Preserve every original revision after
// full fixture restoration instead of failing duplicate keys or changing it.
import { expect, test } from 'bun:test'
import { asc } from 'drizzle-orm'
import { agents, observationSourceRevisions } from '@/db/schema'
import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('RFC-371 complete source revision fixture restoration', (harness) => {
  const revisions = () =>
    harness.db
      .select()
      .from(observationSourceRevisions)
      .orderBy(asc(observationSourceRevisions.sourceId))
      .all()

  test('all 55 migrated sources exist and a real business write changes only its source', async () => {
    const original = await revisions()
    expect(original).toHaveLength(55)
    await harness.db
      .insert(agents)
      .values({ id: 'rfc371-revision-snapshot', name: 'revision snapshot' })
      .run()
    const changed = await revisions()
    expect(changed).toHaveLength(55)
    expect(changed.find((row) => row.sourceId === 'agents')?.revision).not.toBe(
      original.find((row) => row.sourceId === 'agents')?.revision,
    )
    expect(changed.filter((row) => row.sourceId !== 'agents')).toEqual(
      original.filter((row) => row.sourceId !== 'agents'),
    )
  })

  test('the real fixture restores every original revision and removes the business write', async () => {
    const original = await revisions()
    expect(original).toHaveLength(55)
    await harness.db
      .insert(agents)
      .values({ id: 'rfc371-revision-snapshot', name: 'revision snapshot' })
      .run()
    expect(await revisions()).not.toEqual(original)
    await harness.restoreFixture()
    expect(await revisions()).toEqual(original)
    expect(
      (await harness.db.select().from(agents).all()).some(
        (row) => row.id === 'rfc371-revision-snapshot',
      ),
    ).toBe(false)
  })
})
