// RFC-393: keep CLI handlers, bootstrap assembly and the HTTP contract separated after all 26 moves.
import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { backendUnits, sourceUnit } from './census'
import { BACKEND_PREFIX, createGateCorpus, type GateCorpus } from './rfc294Gates'

const MOVES = [
  ['cli/daemonModules/adapters.ts', 'bootstrap/daemonModules/adapters.ts'],
  [
    'cli/daemonModules/developmentAutomation.ts',
    'bootstrap/daemonModules/developmentAutomation.ts',
  ],
  ['cli/daemonModules/digitalEmployee.ts', 'bootstrap/daemonModules/digitalEmployee.ts'],
  ['cli/daemonModules/fusion.ts', 'bootstrap/daemonModules/fusion.ts'],
  ['cli/daemonModules/integration.ts', 'bootstrap/daemonModules/integration.ts'],
  ['cli/daemonModules/intent.ts', 'bootstrap/daemonModules/intent.ts'],
  ['cli/daemonModules/memory.ts', 'bootstrap/daemonModules/memory.ts'],
  ['cli/daemonModules/observation.ts', 'bootstrap/daemonModules/observation.ts'],
  ['cli/daemonModules/providerCore.ts', 'bootstrap/daemonModules/providerCore.ts'],
  [
    'cli/daemonModules/repositoryCredentials.ts',
    'bootstrap/daemonModules/repositoryCredentials.ts',
  ],
  ['cli/daemonModules/resourceCatalog.ts', 'bootstrap/daemonModules/resourceCatalog.ts'],
  ['cli/daemonModules/scheduledTasks.ts', 'bootstrap/daemonModules/scheduledTasks.ts'],
  ['cli/daemonModules/taskExecution.ts', 'bootstrap/daemonModules/taskExecution.ts'],
  ['cli/daemonLifecycleProgram.ts', 'bootstrap/daemonLifecycleProgram.ts'],
  ['cli/daemonProviderSession.ts', 'bootstrap/daemonProviderSession.ts'],
  ['cli/daemonProviderRuntimeSession.ts', 'bootstrap/daemonProviderRuntimeSession.ts'],
  ['cli/daemonProviderRuntimeHandles.ts', 'bootstrap/daemonProviderRuntimeHandles.ts'],
  ['cli/daemonProviderRuntimeRouter.ts', 'bootstrap/daemonProviderRuntimeRouter.ts'],
  ['cli/daemonProviderMigrationAdmission.ts', 'bootstrap/daemonProviderMigrationAdmission.ts'],
  ['cli/daemonProviderBootstrap.ts', 'bootstrap/daemonProviderBootstrap.ts'],
  ['cli/daemonRealtimePolicy.ts', 'bootstrap/daemonRealtimePolicy.ts'],
  ['cli/executionActivation.ts', 'bootstrap/executionActivation.ts'],
  ['cli/start.ts', 'bootstrap/daemonStart.ts'],
  ['cli/dev.ts', 'bootstrap/developmentReload.ts'],
  ['cli/deployment.ts', 'bootstrap/deployment.ts'],
  ['cli/migrate.ts', 'bootstrap/migrate.ts'],
] as const

export function separationViolations(corpus: GateCorpus): string[] {
  const cli = BACKEND_PREFIX + 'cli/'
  const bootstrap = BACKEND_PREFIX + 'bootstrap/'
  return corpus.edges
    .filter(
      ({ from, target }) =>
        (from.path.startsWith(cli) && target.startsWith(bootstrap)) ||
        (from.path.startsWith(bootstrap) && target.startsWith(cli)) ||
        (from.path === BACKEND_PREFIX + 'server.ts' &&
          (target.startsWith(cli) || target.startsWith(bootstrap))),
    )
    .map(({ from, target, kind, syntax }) => `${from.path} -> ${target} (${kind}, ${syntax})`)
    .sort()
}

export function migrationViolations(files: ReadonlySet<string>): string[] {
  const errors: string[] = []
  for (const [oldPath, newPath] of MOVES) {
    if (files.has(BACKEND_PREFIX + oldPath)) errors.push(`old path present: ${oldPath}`)
    if (!files.has(BACKEND_PREFIX + newPath)) errors.push(`new path missing: ${newPath}`)
  }
  return errors
}

const IMPORT_FIXTURES = [
  [
    'value import',
    (target: string) => `import { value } from '${target}'`,
    'value',
    'static-import',
  ],
  [
    'import type',
    (target: string) => `import type { Type } from '${target}'`,
    'type',
    'static-import',
  ],
  [
    'inline type',
    (target: string) => `import { type Type } from '${target}'`,
    'type',
    'static-import',
  ],
  ['export from', (target: string) => `export { value } from '${target}'`, 'value', 'export'],
  [
    'dynamic import',
    (target: string) => `const value = import('${target}')`,
    'value',
    'dynamic-import',
  ],
  ['require', (target: string) => `const value = require('${target}')`, 'value', 'require'],
  [
    'import type node',
    (target: string) => `type Type = import('${target}').Type`,
    'type',
    'import-type',
  ],
  ['side effect import', (target: string) => `import '${target}'`, 'value', 'static-import'],
  ['type export', (target: string) => `export type { Type } from '${target}'`, 'type', 'export'],
  [
    'inline type export',
    (target: string) => `export { type Type } from '${target}'`,
    'type',
    'export',
  ],
  ['star export', (target: string) => `export * from '${target}'`, 'value', 'export'],
  ['empty import', (target: string) => `import {} from '${target}'`, 'value', 'static-import'],
  ['empty export', (target: string) => `export {} from '${target}'`, 'value', 'export'],
  [
    'import with options',
    (target: string) => `import('${target}', { with: { type: 'json' } })`,
    'value',
    'dynamic-import',
  ],
  ['import equals', (target: string) => `import value = require('${target}')`, 'value', 'require'],
] as const

for (const [from, to] of [
  ['cli', 'bootstrap'],
  ['bootstrap', 'cli'],
] as const) {
  test.each(IMPORT_FIXTURES)(`rejects ${from} -> ${to}: %s`, (_name, render, kind, syntax) => {
    for (const target of [`@/${to}/target`, `../${to}/target`]) {
      const corpus = createGateCorpus([
        sourceUnit(BACKEND_PREFIX + `${from}/probe.ts`, render(target)),
        sourceUnit(
          BACKEND_PREFIX + `${to}/target.ts`,
          'export const value = 1; export type Type = number',
        ),
      ])
      expect(separationViolations(corpus)).toEqual([
        `${BACKEND_PREFIX}${from}/probe.ts -> ${BACKEND_PREFIX}${to}/target.ts (${kind}, ${syntax})`,
      ])
    }
  })
}

test.each(IMPORT_FIXTURES)('server rejects either directory: %s', (_name, render, kind, syntax) => {
  for (const directory of ['cli', 'bootstrap']) {
    const target = `${BACKEND_PREFIX}${directory}/target`
    // Unresolved first-party targets must still count as forbidden edges.
    const corpus = createGateCorpus([
      sourceUnit(BACKEND_PREFIX + 'server.ts', render(`@/${directory}/target`)),
    ])
    expect(separationViolations(corpus)).toEqual([
      `${BACKEND_PREFIX}server.ts -> ${target} (${kind}, ${syntax})`,
    ])
  }
})

test('same-directory imports and main entry wiring remain allowed', () => {
  const corpus = createGateCorpus([
    sourceUnit(BACKEND_PREFIX + 'cli/probe.ts', "import './handler'"),
    sourceUnit(BACKEND_PREFIX + 'bootstrap/probe.ts', "import './assembly'"),
    sourceUnit(
      BACKEND_PREFIX + 'server.ts',
      "import type { Contract } from '@/modules/a/public/types'",
    ),
    sourceUnit(BACKEND_PREFIX + 'main.ts', "import '@/cli/handler'; import '@/bootstrap/assembly'"),
  ])
  expect(separationViolations(corpus)).toEqual([])
})

test('negative fixtures reject each old path revival and each missing migration target', () => {
  const files = new Set(MOVES.map(([, path]) => BACKEND_PREFIX + path))
  expect(MOVES).toHaveLength(26)
  expect(files.size).toBe(26)
  expect(migrationViolations(files)).toEqual([])
  for (const [oldPath, newPath] of MOVES) {
    expect(migrationViolations(new Set([...files, BACKEND_PREFIX + oldPath]))).toEqual([
      `old path present: ${oldPath}`,
    ])
    expect(
      migrationViolations(new Set([...files].filter((path) => path !== BACKEND_PREFIX + newPath))),
    ).toEqual([`new path missing: ${newPath}`])
  }
})

test('complete production corpus has zero directory edges and all 26 completed moves', () => {
  const root = resolve(import.meta.dir, '../../../..')
  const units = backendUnits(root)
  expect(units.length).toBeGreaterThanOrEqual(2000)
  const corpus = createGateCorpus(units)
  expect(separationViolations(corpus)).toEqual([])
  expect(migrationViolations(new Set(corpus.byPath.keys()))).toEqual([])
  for (const [oldPath, newPath] of MOVES) {
    expect(existsSync(resolve(root, BACKEND_PREFIX + oldPath))).toBe(false)
    expect(existsSync(resolve(root, BACKEND_PREFIX + newPath))).toBe(true)
  }
}, 30_000)
