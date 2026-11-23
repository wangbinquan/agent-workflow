// RFC-370 §9.2 V9 — the platform maintenance Worker never imports a deployment
// or business module. A hosted deployment ships its own Worker entry
// (`bootstrap/maintenanceWorkerEntry.ts`) whose loader maps the symbolic name
// its descriptor carries (RFC-541: the entry is its own thin root and hands the
// loader to the effects scope; no Worker-wide registration); the supervisor
// starts that entry only when the descriptor names it. Before this, the
// platform Worker hard-coded `import('@/bootstrap/crewstationMaintenance')`.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openMaintenanceWorkerEffectsScope } from '@/platform/background/maintenanceWorkerEffects'
import {
  createMaintenanceWorkerEffectsInit,
  readMaintenanceWorkerEffectsFrame,
} from '@/platform/background/maintenanceWorkerEffectsProtocol'
import { MAINTENANCE_CATALOG_DIGEST } from '@/platform/background/maintenanceCatalog'
import { MAINTENANCE_PROTOCOL_VERSION } from '@/platform/background/maintenanceProtocol'

const SRC = join(import.meta.dir, '..', 'src')
const read = (relative: string) => readFileSync(join(SRC, relative), 'utf8')

test('the platform Worker imports no bootstrap module', () => {
  for (const file of [
    'platform/background/maintenanceWorkerRuntime.ts',
    'platform/background/maintenanceWorkerEffects.ts',
    'platform/background/maintenanceWorkerSupervisor.ts',
  ])
    expect(read(file)).not.toMatch(/['"]@\/bootstrap\//)
})

test('without a loader the effects scope imports the descriptor module by its name', async () => {
  // RFC-541: `node:path` loads (an ordinary import), so the missing export is what fails — not the import.
  const scope = openMaintenanceWorkerEffectsScope({
    selectEffects: () => ({}),
    descriptor: {
      moduleSpecifier: 'node:path',
      exportName: 'noSuchFactory',
      configurationJson: '{}',
      capabilities: [],
    },
    context: { appHome: 'fixture-home', instanceRef: 'fixture-instance' },
  })
  await expect(scope.ready).rejects.toThrow('maintenance-worker-effects-factory-missing')
  await scope.dispose()
})

test('the hosted entry is its own thin root and maps the module its descriptor names', () => {
  const entry = read('bootstrap/maintenanceWorkerEntry.ts')
  expect(entry).not.toContain("import './maintenanceWorker'")
  expect(entry).toContain('runMaintenanceWorker({')
  expect(entry).toContain('composeGraph: composeMaintenanceWorkerGraph')
  expect(entry).toContain("specifier === 'aw:crewstation-maintenance'")
  expect(entry).toContain("import('./crewstationMaintenance')")
  const maintenance = read('bootstrap/crewstationMaintenance.ts')
  expect(maintenance).toContain("'./bootstrap/maintenanceWorkerEntry.ts'")
  expect(maintenance).toContain('workerEntry: HOSTED_MAINTENANCE_WORKER_ENTRY')
  // The compiled binary must bundle the entry as a separate Worker.
  const build = readFileSync(join(SRC, '..', '..', '..', 'scripts', 'build-binary.ts'), 'utf8')
  expect(build).toContain("join(backendSrc, 'bootstrap', 'maintenanceWorkerEntry.ts')")
})

test('the init frame carries the Worker entry and rejects an empty one', () => {
  const init = {
    type: 'init' as const,
    version: MAINTENANCE_PROTOCOL_VERSION,
    catalogDigest: MAINTENANCE_CATALOG_DIGEST,
    dbPath: 'fixture.sqlite',
    migrationsFolder: 'fixture-migrations',
    appHome: 'fixture-home',
    sqlite: { synchronous: 'NORMAL' as const, pageCacheMib: 8, mmapMib: 0, busyTimeoutMs: 50 },
  }
  const effects = {
    moduleSpecifier: 'aw:crewstation-maintenance',
    exportName: 'createCrewStationMaintenanceEffects',
    configurationJson: '{}',
    capabilities: ['taskArchive' as const],
    workerEntry: './bootstrap/maintenanceWorkerEntry.ts',
  }
  const frame = readMaintenanceWorkerEffectsFrame(createMaintenanceWorkerEffectsInit(init, effects))
  expect(frame.effects?.workerEntry).toBe('./bootstrap/maintenanceWorkerEntry.ts')
  expect(() => createMaintenanceWorkerEffectsInit(init, { ...effects, workerEntry: '' })).toThrow()
  const { workerEntry: _omitted, ...standalone } = effects
  expect(
    readMaintenanceWorkerEffectsFrame(createMaintenanceWorkerEffectsInit(init, standalone)).effects,
  ).not.toHaveProperty('workerEntry')
})
