// RFC-338 — closed production inventory and main-event-loop isolation guard.
// Adding a periodic DB/FS-heavy body without catalog + Worker composition must
// fail here instead of silently reintroducing an hourly whole-UI freeze.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { MAINTENANCE_JOB_KEYS } from '@agent-workflow/shared'
import {
  HEAVY_MAINTENANCE_JOB_KEYS,
  MAINTENANCE_JOB_CATALOG,
} from '@/platform/background/maintenanceCatalog'
import { MAINTENANCE_PHASE } from '@/services/daemonCadence'

const BACKEND = resolve(import.meta.dir, '..')
const ROOT = resolve(BACKEND, '..', '..')
const readBackend = (path: string): string => readFileSync(resolve(BACKEND, path), 'utf8')

describe('RFC-338 maintenance architecture', () => {
  test('catalog is closed and every historical phase is classified exactly once', () => {
    const catalogKeys = MAINTENANCE_JOB_CATALOG.map((spec) => spec.key)
    // RFC-341 replaced the old maintenance payload with a continuously
    // recovering committed-event worker. Keep the legacy shared decode key
    // readable during rolling upgrade, but it is no longer schedulable.
    expect(catalogKeys).toEqual(MAINTENANCE_JOB_KEYS.filter((key) => key !== 'humanGateRecovery'))
    expect(new Set(catalogKeys).size).toBe(catalogKeys.length)
    const historicalHeavy = Object.keys(MAINTENANCE_PHASE).filter(
      (job) => job !== 'batchImportGc' && job !== 'lifecycleInvariants',
    ) as Array<(typeof HEAVY_MAINTENANCE_JOB_KEYS)[number]>
    expect([...HEAVY_MAINTENANCE_JOB_KEYS]).toEqual(historicalHeavy)
    expect(
      MAINTENANCE_JOB_CATALOG.find((spec) => spec.key === 'lifecycleInvariants'),
    ).toMatchObject({ class: 'recovery', schedule: 'fixed' })
    expect(MAINTENANCE_JOB_CATALOG.find((spec) => spec.key === 'walCheckpoint')).toMatchObject({
      class: 'checkpoint',
      schedule: 'checkpoint',
    })
    expect(MAINTENANCE_JOB_CATALOG.find((spec) => spec.key === 'humanGateRecovery')).toBeUndefined()
  })

  test('production bootstrap admits heavy work to one maintenance service and keeps only memory GC on main', () => {
    const start = readBackend('src/cli/start.ts')
    expect(start.match(/startMaintenanceService\(\{/g)).toHaveLength(1)
    expect(start).toContain('maintenanceStatus: maintenanceService.status')
    expect(start).toContain("maintenanceService.runSoon('backupPrune')")
    expect(start).toContain('await maintenanceService.stop()')
    expect(start).toContain('startBatchImportGc(')
    expect(start).toMatch(
      /const developmentWakeTimer = setInterval\(\(\) => \{[\s\S]*?try \{[\s\S]*?refreshDigitalEmployeeWriterState\([\s\S]*?catch \(err\) \{[\s\S]*?development writer refresh failed[\s\S]*?return/u,
    )

    for (const forbidden of [
      'startWorktreeGc(',
      'startWebhookDeliveryGc(',
      'startEventsArchiver(',
      'startRetentionSweeper(',
      'startTaskArchiveSweeper(',
      'startPluginGenerationGc(',
      'startLifecycleInvariantsLoop(',
      'startStuckTaskDetectorLoop(',
      'startWalCheckpointLoop(',
      'checkpointWal(',
      'sweepIntentScratch(',
      'pruneTokenAudit(',
      'recoverPendingHumanGateContinuations(',
    ]) {
      expect(start, `${forbidden} must not run from the HTTP bootstrap`).not.toContain(forbidden)
    }
  })

  test('only the Worker entry executes job bodies and compiled binaries carry that entry', () => {
    const worker = readBackend('src/platform/background/maintenanceWorker.ts')
    const service = readBackend('src/platform/background/maintenanceService.ts')
    const supervisor = readBackend('src/platform/background/maintenanceWorkerSupervisor.ts')
    const build = readFileSync(resolve(ROOT, 'scripts/build-binary.ts'), 'utf8')

    expect(worker).toContain('await runMaintenanceJob(')
    expect(worker).toContain('busyTimeoutMs: parsed.sqlite.busyTimeoutMs')
    expect(worker).toContain("journalMode: 'preserve'")
    expect(worker).toContain('observeStatementMs: (ms) => recordTiming(statementTimings, ms)')
    expect(worker).toContain('observeTransactionMs: (ms) => recordTiming(transactionTimings, ms)')
    expect(worker).toContain('sqliteBusyDeferrals: 1')
    expect(service).not.toContain('runMaintenanceJob(')
    expect(service).toContain('listIntentTurnIdsForBootRecovery(admissionDb)')
    expect(service).toContain("journalMode: 'preserve'")
    expect(service).toContain('recoverTurnIds: bootIntentTurnIds')
    expect(service).not.toContain('recoverTurns: true')
    expect(supervisor).not.toContain('runMaintenanceJob(')
    expect(supervisor).toContain("? './platform/background/maintenanceWorker.ts'")
    expect(supervisor).toContain(": new URL('./maintenanceWorker.ts', import.meta.url).href")
    expect(supervisor).toContain('new Worker(MAINTENANCE_WORKER_ENTRY)')
    expect(build).toContain("join(backendSrc, 'platform', 'background', 'maintenanceWorker.ts')")
    expect(build).toContain('entrypoints: [mainEntry, ...WORKER_ENTRIES]')
    expect(build).toContain("AW_COMPILED_BUILD: 'true'")
  })
})
