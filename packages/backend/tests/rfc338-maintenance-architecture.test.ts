import { readDaemonGraphSource } from './helpers/daemonGraphSource'
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
const readBackend = (path: string): string =>
  /(?:^|\/)bootstrap\/daemonStart\.ts$/.test(path)
    ? readDaemonGraphSource()
    : readFileSync(resolve(BACKEND, path), 'utf8')

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

  test('each selected provider owns one maintenance service and keeps only memory GC on main', () => {
    const start = readDaemonGraphSource()
    expect(start.match(/createMaintenanceService\(\{/g)).toHaveLength(1)
    expect(start).toMatch(/postgresql: \{[\s\S]*?createMaintenanceRunStore\(db\)/u)
    expect(start).toMatch(
      /adapter\.maintenance\(\{[\s\S]*?dbPath: activeDbPath,[\s\S]*?migrationsFolder: input\.migrationsFolder/u,
    )
    expect(start).toContain('maintenanceStatus: () => maintenanceService.status()')
    expect(start).toContain("maintenanceService.runSoon('backupPrune')")
    expect(start).toContain('maintenanceBindings.runtimeFactory')
    // RFC-359 W3-T14：监听器与关机序列只有一份（serveDaemon），bootstrap.stop() 只在它里面调一次。
    expect(start).toContain('await input.bootstrap.stop()')
    expect(start.split('.bootstrap.stop()').length - 1).toBe(1)
    expect(start).toContain('startBatchImportGc(')
    expect(start).not.toContain('sweepWakesWhileDraining(')
    const gates = readBackend(
      'src/modules/development-automation/application/writerCutoverGates.ts',
    )
    expect(gates).toContain('interface DevelopmentWriterCutover')
    expect(gates).not.toMatch(
      /export (?:async )?function|legacy-draining|sweepWakesWhileDraining|recoverWhileDraining/,
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
    const worker = readBackend('src/platform/background/maintenanceWorkerRuntime.ts')
    const graph = readBackend('src/bootstrap/maintenanceWorkerGraph.ts')
    const entries = readBackend('src/bootstrap/maintenanceWorkerEntries.ts')
    const service = readBackend('src/platform/background/maintenanceService.ts')
    const supervisor = readBackend('src/platform/background/maintenanceWorkerSupervisor.ts')
    const build = readFileSync(resolve(ROOT, 'scripts/build-binary.ts'), 'utf8')

    expect(worker).toContain('await runMaintenanceJob(')
    expect(graph).toContain('busyTimeoutMs: parsed.sqlite.busyTimeoutMs')
    expect(graph).toContain("journalMode: 'preserve'")
    expect(graph).toContain('observeStatementMs: observe.statement')
    expect(worker).toContain('statement: (ms, sql, cpuMs) => {')
    expect(worker).toContain('recordTiming(statementTimings, ms)')
    expect(worker).toContain('sliceDiagnostics?.observeStatement(ms, sql, cpuMs)')
    expect(graph).toContain('observeTransactionMs: observe.transaction')
    expect(worker).toContain('transaction: (ms) => recordTiming(transactionTimings, ms)')
    expect(worker).toContain('sqliteBusyDeferrals: 1')
    expect(service).not.toContain('runMaintenanceJob(')
    expect(service).toContain('payloadSources = options.payloadSources')
    expect(service).not.toContain('@/modules/intent/infrastructure/')
    // RFC-359 AC-10：准入连接从服务体内搬走了（`createMaintenanceService` 不再按 provider
    // 自己开连接，改由装配方的 `openAdmissionStore` 交出），而**开库这件事落在
    // `platform/persistence/`**——`cli/start.ts` 不得 import `@/db/client`，那是
    // `rfc349-provider-cutover` 的既有规则（provider factory owns SQLite）。
    // 这条锁的东西没变——**准入连接绝不改日志模式**——只是跟着连接搬到它现在所在的文件。
    expect(service).not.toContain("journalMode: 'preserve'")
    expect(readBackend('src/platform/persistence/sqlite/maintenanceAdmissionStore.ts')).toContain(
      "journalMode: 'preserve'",
    )
    expect(readBackend('src/bootstrap/daemonSessionAdapters.ts')).toContain(
      'openSqliteMaintenanceAdmissionStore({',
    )
    expect(service).toContain('recoverTurnIds: bootIntentTurnIds')
    expect(service).not.toContain('recoverTurns: true')
    expect(graph).toContain("'database' in request")
    expect(graph).toContain('poolMax: Math.min(2, parsed.database.poolMax)')
    expect(graph).toContain('createMaintenanceRunStore(')
    expect(graph).toContain('composeWorkspaceMaintenanceCommand({')
    // RFC-359（§5ea）—— intent 维护装配两个 provider 合成一份，名字不再带引擎前缀。
    // 锁的东西没变：Worker 是**唯一**装配维护命令的地方。
    expect(graph).toContain('composeIntentMaintenanceCommandsForDatabase({')
    expect(graph).toContain('composeResourcePackageApplyMaintenance({')
    expect(graph).toContain('createAtomicApplyRecovery([')
    expect(graph).not.toContain('postgresql-maintenance-owner-command-unavailable')
    expect(supervisor).not.toContain('runMaintenanceJob(')
    expect(entries).toContain("? './bootstrap/maintenanceWorker.ts'")
    expect(entries).toContain(": new URL('./maintenanceWorker.ts', import.meta.url).href")
    expect(supervisor).toContain('options.effectsBootstrap?.workerEntry ?? options.workerEntry')
    expect(supervisor).toContain('new Worker(entry)')
    expect(build).toContain("join(backendSrc, 'bootstrap', 'maintenanceWorker.ts')")
    expect(build).toContain('entrypoints: [mainEntry, ...WORKER_ENTRIES]')
    expect(build).toContain("AW_COMPILED_BUILD: 'true'")
  })
})
