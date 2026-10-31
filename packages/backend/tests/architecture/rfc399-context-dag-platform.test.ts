// RFC-399: lock the context value DAG and one-way platform boundary after Parts A/B.
// Synthetic imports prove both direct edges and services-facade detours remain detectable.
import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, importEdges, sourceUnit } from './census'
import {
  createGateCorpus,
  contextValueSccs,
  contextPairsOffDag,
  platformModulePairs,
} from './rfc294Gates'

const ROOT = resolve(import.meta.dir, '../../../..')
const PREFIX = 'packages/backend/src/'
const UNITS = backendUnits(ROOT)
const CORPUS = createGateCorpus(UNITS)
const read = (path: string) => readFileSync(resolve(ROOT, PREFIX + path), 'utf8')

test('all three S5 sets are empty and the transport re-export bucket is absent', () => {
  expect(UNITS.length).toBeGreaterThanOrEqual(2000)
  expect(contextValueSccs(CORPUS)).toEqual([])
  expect(contextPairsOffDag(CORPUS)).toEqual([])
  expect(platformModulePairs(CORPUS)).toEqual([])
  expect(
    existsSync(
      resolve(
        ROOT,
        PREFIX + 'modules/task-execution/infrastructure/legacySqliteTransportMechanisms.ts',
      ),
    ),
  ).toBe(false)
})

test('new required-SPI providers import consumer required ports only with import type', () => {
  const providers = [
    ['resource-catalog', 'collaboration'],
    ['resource-catalog', 'integration'],
    ['collaboration', 'task-execution'],
    ['memory', 'task-execution'],
    ['source-control', 'task-execution'],
  ] as const
  for (const [provider, consumer] of providers) {
    const path = `modules/${provider}/application/adapters/${consumer}-adapter.ts`
    const unit = sourceUnit(PREFIX + path, read(path))
    const imports = unit.source.statements
      .filter(ts.isImportDeclaration)
      .filter(
        (node) =>
          ts.isStringLiteralLike(node.moduleSpecifier) &&
          node.moduleSpecifier.text.startsWith(`@/modules/${consumer}/`),
      )
    expect(imports.length).toBeGreaterThan(0)
    for (const node of imports) {
      expect((node.moduleSpecifier as ts.StringLiteral).text).toBe(
        `@/modules/${consumer}/composition/required-ports`,
      )
      expect(node.importClause?.isTypeOnly).toBe(true)
    }
  }
})

test('moved implementations have no facade at their original locations', () => {
  for (const path of [
    'platform/content/local/workspaceUploads.ts',
    'platform/persistence/sqlite/systemMaintenanceDisk.ts',
    'platform/background/maintenanceSystemOperations.ts',
    'modules/task-execution/composition/digitalEmployeeBuiltinToolCatalog.ts',
    'modules/task-execution/composition/taskClarifyDirectiveRoutes.ts',
    'modules/execution-contract/public/commands.ts',
    'modules/source-control/domain/forcedWorkspacePaths.ts',
    'services/taskCollab.ts',
  ])
    expect(existsSync(resolve(ROOT, PREFIX + path))).toBe(false)
})

test('the platform dispatcher has no module or services imports', () => {
  const path = 'platform/background/maintenanceJobRunner.ts'
  const edges = importEdges(sourceUnit(PREFIX + path, read(path)))
  expect(edges.length).toBeGreaterThan(0)
  expect(edges.filter((edge) => /(?:^|\/)(?:modules|services)\//.test(edge.specifier))).toEqual([])
})

test('synthetic platform imports and off-DAG values, including a services detour, turn the locks red', () => {
  const corpus = createGateCorpus([
    sourceUnit(PREFIX + 'platform/probe.ts', "import '@/modules/task-execution/public/commands'"),
    sourceUnit(
      PREFIX + 'modules/resource-catalog/application/probe.ts',
      "import '@/modules/task-execution/public/commands'",
    ),
    sourceUnit(
      PREFIX + 'modules/task-execution/public/commands.ts',
      "import '@/services/snapshot'",
    ),
    sourceUnit(
      PREFIX + 'services/snapshot.ts',
      "export { snapshot } from '@/modules/memory/public/queries'",
    ),
    sourceUnit(PREFIX + 'modules/memory/public/queries.ts', 'export const snapshot = 1'),
  ])
  expect(platformModulePairs(corpus)).toEqual([
    PREFIX + 'platform/probe.ts -> ' + PREFIX + 'modules/task-execution/public/commands.ts',
  ])
  expect(contextPairsOffDag(corpus)).toEqual(['resource-catalog->task-execution'])
  expect(contextPairsOffDag(corpus, { throughServices: true })).toEqual([
    'resource-catalog->task-execution',
    'task-execution->memory',
  ])
})
