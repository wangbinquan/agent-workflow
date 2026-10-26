// RFC-395 A-3: the maintained sweep seeds live aggregates and reads current projections.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { scenarioEvents, scenarioTasksList } from '../scripts/perf-sweep'

describe('live operational performance sweep', () => {
  test('event and task scenarios run on the embedded baseline', async () => {
    await scenarioEvents()
    await scenarioTasksList()
  })
  test('concurrent launch uses production launch, live fixtures and the portable stub', () => {
    const source = readFileSync(resolve(import.meta.dir, '../scripts/perf-sweep.ts'), 'utf8')
    expect(source).toContain('launchTestTask as startTask')
    expect(source).toContain('makeVersionedStubOpencode')
    expect(source).toContain('awaitScheduler: true')
    expect(source).not.toContain('MIGRATIONS_DIR')
    expect(source).not.toContain("from '@/db/schema'")
  })
})
