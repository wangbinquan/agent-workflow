// RFC-370 §9.2 V9 — the platform maintenance Worker never imports a deployment
// or business module. A hosted deployment ships its own Worker entry
// (`bootstrap/maintenanceWorkerEntry.ts`) that registers its effect module by
// the symbolic name its descriptor carries; the supervisor starts that entry
// only when the descriptor names it. Before this, the platform Worker
// hard-coded `import('@/bootstrap/crewstationMaintenance')`.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  importMaintenanceWorkerEffectModule,
  registerMaintenanceWorkerEffectModule,
} from '@/platform/background/maintenanceWorkerEffects'
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

test('a registered effect module is loaded by its symbolic name', async () => {
  const module = { createEffects: () => 'selected' }
  registerMaintenanceWorkerEffectModule('aw:test-effects', async () => module)
  expect(await importMaintenanceWorkerEffectModule('aw:test-effects')).toBe(module)
  // An unregistered specifier is an ordinary module import.
  const fallback = await importMaintenanceWorkerEffectModule('node:path')
  expect(typeof fallback.join).toBe('function')
})

test('the hosted entry registers the module its descriptor names and runs the shared Worker root', () => {
  const entry = read('bootstrap/maintenanceWorkerEntry.ts')
  expect(entry).toContain("import './maintenanceWorker'")
  expect(entry).toContain("'aw:crewstation-maintenance'")
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
