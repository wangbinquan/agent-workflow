// RFC-395 II-b package O3: prevent business SQL returning to code-capability, System Operations or platform mechanisms.
import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import { sourceUnit, importEdges } from './census'
import { referencedPersistenceTables } from './tableOwnership'

const root = resolve(import.meta.dir, '../../../..')
const pathFor = (path: string) => 'packages/backend/src/' + path
const read = (path: string) => readFileSync(resolve(root, pathFor(path)), 'utf8')
const references = (path: string, text: string) =>
  referencedPersistenceTables(sourceUnit(pathFor(path), text), persistenceSchema.tables)
const moduleImports = (text: string) =>
  importEdges(sourceUnit('packages/backend/src/platform/fixture.ts', text))
    .filter((edge) => /(?:^|\/)modules\//.test(edge.specifier))
    .map((edge) => edge.specifier)

test('O3 consumers no longer read the reshaped tables', () => {
  const consumers = [
    'modules/code-capability/infrastructure/capabilityMatrixRead.ts',
    'modules/code-capability/infrastructure/crewstation/codeReviewObjectSweep.ts',
    'modules/system-operations/infrastructure/local/doctorDiagnostics.ts',
    'modules/system-operations/infrastructure/resourceLimitAudit.ts',
  ]
  const reshaped = new Set([
    'tasks',
    'taskRepos',
    'nodeRuns',
    'nodeRunOutputs',
    'agents',
    'workflows',
    'clarifyRounds',
  ])
  expect(consumers).toHaveLength(4)
  expect(
    consumers.flatMap((path) =>
      references(path, read(path)).filter((table) => reshaped.has(table)),
    ),
  ).toEqual([])
  for (const path of [
    'modules/code-capability/infrastructure/codeWorkspaceRead.ts',
    'modules/code-capability/application/ports/codeWorkspaceRead.ts',
    'modules/system-operations/infrastructure/healthReadModel.ts',
    'modules/system-operations/infrastructure/resourceLimitPersistence.ts',
    'modules/system-operations/composition/resourceLimits.ts',
    'platform/persistence/eventsArchiveStore.ts',
    'platform/persistence/postgresqlEventsArchive.ts',
    'platform/persistence/taskCheckpointMountPaths.ts',
  ])
    expect(existsSync(resolve(root, pathFor(path)))).toBe(false)
})

test('platform archive and retention retain only neutral ports and machinery', () => {
  for (const path of [
    'platform/persistence/sqlite/systemMaintenanceRetention.ts',
    'platform/persistence/sqlite/systemEventsArchive.ts',
    'platform/background/maintenanceSystemOperations.ts',
  ]) {
    const text = read(path)
    expect(references(path, text)).toEqual([])
    expect(moduleImports(text)).toEqual([])
  }
  const adapter = read('modules/task-execution/application/adapters/system-operations-adapter.ts')
  expect(adapter).toContain('import type { DoctorTaskLifecyclePort }')
  expect(adapter).not.toMatch(/from ['"][^'"]*(?:infrastructure|sessionTables|drizzle-orm|db\/)/)
  expect(read('modules/integration/infrastructure/retentionPhase.ts')).toContain(
    'nonTerminalTaskExists(db, webhookTriggerFires.taskId)',
  )
  expect(
    read('bootstrap/maintenanceWorkerGraph.ts').match(
      /eventsArchiveStore: createTaskNodeEventArchiveStore\(db\)/g,
    ),
  ).toHaveLength(2)
})

test('schema entrypoints do not load runtime retention composition', () => {
  for (const owner of ['intent', 'resource-catalog']) {
    const path = `modules/${owner}/composition/schema.ts`
    const edges = importEdges(sourceUnit(pathFor(path), read(path)))
    expect(edges.map((edge) => edge.specifier)).toEqual(['../infrastructure/persistence/schema'])
  }
})

test('negative controls catch aliased table bindings, raw Task SQL and platform module imports', () => {
  expect(
    references(
      'fixture.ts',
      "import { tablesOf as tables } from '@/platform/persistence/sessionTables'; const { tasks: rows } = tables(db)",
    ),
  ).toEqual(['tasks'])
  expect(references('fixture.ts', 'const query = sql`SELECT count(*) FROM tasks`')).toEqual([
    'tasks',
  ])
  expect(
    moduleImports(
      "import { createTaskStatusCounts as counts } from '@/modules/task-execution/composition'",
    ),
  ).toEqual(['@/modules/task-execution/composition'])
  expect(references('fixture.ts', 'const dto = { tasks: [] }')).toEqual([])
  expect(
    moduleImports(
      "import type { RetentionSweepPhase } from '@/platform/background/retentionSweepPhase'",
    ),
  ).toEqual([])
})
