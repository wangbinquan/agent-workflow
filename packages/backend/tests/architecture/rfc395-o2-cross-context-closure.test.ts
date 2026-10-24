// RFC-395 II-b package O2: prevent closed table accesses and retired startup/deletion entrypoints returning.
import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import { sourceUnit } from './census'
import { referencedPersistenceTables } from './tableOwnership'

const root = resolve(import.meta.dir, '../../../..')
const closed: Readonly<Record<string, readonly string[]>> = {
  'runtime-management/infrastructure/realtimeStore.ts': [
    'tasks',
    'nodeRuns',
    'nodeRunEvents',
    'taskCollaborators',
    'workflows',
    'workgroups',
  ],
  'resource-catalog/infrastructure/agentPersistenceSemantics.ts': ['tasks'],
  'resource-catalog/infrastructure/workflowPersistenceSemantics.ts': ['tasks'],
  'resource-catalog/infrastructure/workgroupRepository.ts': ['tasks'],
  'resource-catalog/infrastructure/legacy/agent.ts': ['tasks'],
  'resource-catalog/infrastructure/legacy/workflow.ts': ['tasks'],
  'resource-catalog/infrastructure/legacy/workgroups.ts': ['tasks'],
  'collaboration/infrastructure/review.ts': ['agents'],
  'collaboration/infrastructure/humanGateOperationJournal.ts': ['tasks'],
  'task-execution/infrastructure/taskArchiveContentCoordinator.ts': ['clarifyRounds'],
  'task-execution/infrastructure/taskRecoveryOperations.ts': ['clarifyRounds'],
  'task-execution/infrastructure/taskRouteOperations.ts': ['clarifyRounds'],
}
function violations(file: string, text: string) {
  return referencedPersistenceTables(
    sourceUnit(`packages/backend/src/modules/${file}`, text),
    persistenceSchema.tables,
  ).filter((table) => closed[file]?.includes(table))
}

test('O2 consumers no longer read the closed owner tables', () => {
  expect(existsSync(resolve(root, 'packages/backend/src/db/query.ts'))).toBe(false)
  expect(Object.keys(closed)).toHaveLength(12)
  for (const file of Object.keys(closed)) {
    expect(
      violations(file, readFileSync(resolve(root, 'packages/backend/src/modules', file), 'utf8')),
    ).toEqual([])
  }
})

test('negative control: aliased session-table read reopens the matching closure', () => {
  expect(
    violations(
      'collaboration/infrastructure/review.ts',
      `
    import { tablesOf as tables } from '@/platform/persistence/sessionTables'
    const { agents: profiles } = tables(db)
    db.select().from(profiles)
  `,
    ),
  ).toEqual(['agents'])
})

test('frame-backfill entrypoints and legacy delete functions are retired', () => {
  for (const file of [
    'cli/frameBackfill.ts',
    'modules/task-execution/composition/frameBackfill.ts',
    'modules/task-execution/application/frameBackfillJob.ts',
    'modules/task-execution/infrastructure/legacyMigration/frameBackfillStore.ts',
    'modules/task-execution/domain/legacyMigration/frameBackfill.ts',
  ]) {
    expect(existsSync(resolve(root, 'packages/backend/src', file))).toBe(false)
  }
  for (const [file, symbol] of [
    ['agent', 'deleteAgent'],
    ['workflow', 'deleteWorkflow'],
    ['workgroups', 'deleteWorkgroup'],
  ]) {
    expect(
      readFileSync(
        resolve(
          root,
          `packages/backend/src/modules/resource-catalog/infrastructure/legacy/${file}.ts`,
        ),
        'utf8',
      ),
    ).not.toContain(`function ${symbol}(`)
  }
  expect(
    readFileSync(resolve(root, 'packages/backend/src/bootstrap/daemonLifecycleProgram.ts'), 'utf8'),
  ).not.toContain("id: 'frame-backfill'")
})
