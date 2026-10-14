import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
// RFC-371: source binding bootstrap cannot wait on a derived index that is
// itself produced only after the original source has been routed.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { observationPlatformSources } from '@/db/schema'
import { originalObservationProjectionRouter } from '@/platform/persistence/observationProjectionRouting'
import { describeEachProvider } from './helpers/eachProvider'
import { seedCompleteCoveredUsage } from './helpers/rfc371CompleteCoverageFixture'
import { completeFixtureId } from './helpers/rfc371CompleteTaskFixture'

describeEachProvider('RFC-371 original platform routing before derived bootstrap', (h) => {
  test('an unused observed source is an empty contribution, not an unresolved bootstrap blocker', async () => {
    const route = {
      id: 'unused-source',
      $platformSource: 'unused-installation',
      $platformProject: 'original-project',
      $platformTask: 'original-task',
    }
    await h.db
      .insert(observationPlatformSources)
      .values({
        id: route.id,
        document: JSON.stringify({
          binding: {
            sourceId: route.$platformSource,
            projectId: route.$platformProject,
            taskId: route.$platformTask,
          },
        }),
      })
      .run()
    const result = await h.session.transaction((tx) =>
      originalObservationProjectionRouter().components(tx, {
        id: 'unused',
        source: 'observation_platform_sources',
        entityKey: route.id,
        operation: 'INSERT',
        previousRoute: null,
        nextRoute: route,
      }),
    )
    expect(result).toEqual([])
  })
  test('original accepted hosted executions route before any derived platform bindings exist', async () => {
    await seedCompleteCoveredUsage(h, 'platform', false)
    const source = await h.db.select().from(observationPlatformSources).get()
    expect(source).toBeDefined()
    const result = await h.session.transaction((tx) =>
      originalObservationProjectionRouter().components(tx, {
        id: 'bound',
        source: 'observation_platform_sources',
        entityKey: source!.id,
        operation: 'UPDATE',
        previousRoute: null,
        nextRoute: { id: source!.id, document: source!.document },
      }),
    )
    expect(result).not.toBeNull()
    expect(result).toContain(JSON.stringify(['invocation', completeFixtureId('invocation', 0)]))
    await h.db
      .delete(observationPlatformSources)
      .where(eq(observationPlatformSources.id, source!.id))
      .run()
  })
})

// The platform routes neutral change facts; only the actual daemon assembly root imports owner compositions.
test('projection source routing keeps its platform I/O contract independent of private module composition', () => {
  const root = resolve(import.meta.dir, '..', 'src'),
    router = readFileSync(
      resolve(root, 'platform/persistence/observationProjectionRouting.ts'),
      'utf8',
    ),
    ports = readFileSync(
      resolve(root, 'modules/run-observability/ports/incrementalObservationChanges.ts'),
      'utf8',
    )
  expect(router).not.toContain('@/modules/')
  expect(router).toContain("from './observationChangeContract'")
  expect(ports).toContain("from '@/platform/persistence/observationChangeContract'")
})
