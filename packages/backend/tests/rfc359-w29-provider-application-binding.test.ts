import { readWorkflowFixtures, workflowFixture } from './helpers/model'
import { expect, test } from 'bun:test'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider(
  'RFC-359 W29 — application borrows the selected recorded database',
  (harness) => {
    test('each application binding reaches its own database through the existing recorder', async () => {
      expect(harness.applicationBinding).toBe(harness.database(0).applicationBinding)
      expect(harness.database(0).applicationBinding.db).not.toBe(
        harness.database(1).applicationBinding.db,
      )

      for (const index of [0, 1]) {
        const database = harness.database(index)
        const binding = database.applicationBinding
        expect(Object.isFrozen(binding)).toBe(true)
        expect<PersistenceDb>(binding.db).toBe(database.db)
        expect(binding.provider).toBe(database.capabilities.provider)
        const borrowed: PersistenceDb = binding.db
        const recording = database.recordStatements()
        try {
          await workflowFixture(borrowed, {
            id: 'w29-binding',
            name: `database-${index}`,
            definition: '{}',
          })
          const rows = await readWorkflowFixtures(database.db, { id: 'w29-binding' }).then((rows) =>
            rows.map((row) => ({ id: row.id, name: row.name })),
          )
          expect(rows).toEqual([{ id: 'w29-binding', name: `database-${index}` }])
          expect(
            recording.statements.filter((statement) =>
              /^\s*insert\s+into\s+(?:"agent_workflow"\.)?"workflows"/i.test(statement.sql),
            ),
          ).toHaveLength(1)

          // This is a mechanism assertion: the production composition also
          // receives this exact runtime, so direct pool queries must be recorded.
          if (binding.provider === 'postgresql') {
            expect(binding.databaseConfig.provider).toBe(binding.provider)
            const before = recording.statements.length
            const rawRows = await binding.runtime
              .providerPool()
              .unsafe('select id, name from "agent_workflow"."workflows" where id = $1', [
                'w29-binding',
              ])
            expect(Array.from(rawRows)).toEqual(rows)
            expect(recording.statements).toHaveLength(before + 1)
            expect(recording.statements.at(-1)?.values).toEqual(['w29-binding'])
          }
        } finally {
          recording.stop()
        }
      }
    })
  },
  { databaseCount: 2 },
)
