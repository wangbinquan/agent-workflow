import { openDb } from '@/db/client'
import type { MaintenanceWorkerEvent } from '@/platform/background/maintenanceProtocol'
import { startMaintenanceWorkerSupervisor } from '@/platform/background/maintenanceWorkerSupervisor'
import { createMaintenanceRunStore } from '@/platform/persistence/maintenanceRunStore'

const input = JSON.parse(process.argv[2]!) as {
  appHome: string
  dbPath: string
  migrationsFolder: string
  moduleSpecifier: string
  channelName: string
}
const db = openDb({
  path: input.dbPath,
  migrationsFolder: input.migrationsFolder,
  skipIntegrityCheck: true,
  slowQueryMs: 0,
})
const store = createMaintenanceRunStore(db)
const runId = 'compiled-selected-worker-gc'
await store.enqueue({
  id: runId,
  jobKey: 'pluginGenerationGc',
  jobClass: 'cleanup',
  slotKey: runId,
  payload: {},
  scheduledAt: 0,
  now: 0,
})
const phases: string[] = []
const channel = new BroadcastChannel(input.channelName)
let releaseEntered!: () => void
const disposing = new Promise<void>((resolve) => {
  releaseEntered = resolve
})
channel.onmessage = (event) => {
  phases.push(event.data.type)
  if (event.data.type === 'dispose-entered') releaseEntered()
}
let complete!: (event: MaintenanceWorkerEvent) => void
const completed = new Promise<MaintenanceWorkerEvent>((resolve) => {
  complete = resolve
})
const supervisor = startMaintenanceWorkerSupervisor({
  appHome: input.appHome,
  databaseInit: {
    dbPath: input.dbPath,
    migrationsFolder: input.migrationsFolder,
    sqlite: { synchronous: 'NORMAL', pageCacheMib: 8, mmapMib: 0, busyTimeoutMs: 50 },
  },
  effectsBootstrap: {
    moduleSpecifier: input.moduleSpecifier,
    exportName: 'createEffects',
    configurationJson: JSON.stringify({ channelName: input.channelName }),
    capabilities: ['pluginGenerationGc'],
  },
  onEvent(event) {
    if (event.type === 'completed' && event.runId === runId) complete(event)
    if (event.type === 'degraded') complete(event)
  },
})
const timeout = setTimeout(() => {
  process.stderr.write('compiled-worker-effects-timeout\n')
  process.exit(2)
}, 20_000)
try {
  const event = await completed
  await supervisor.drain()
  await disposing
  const settled = await store.read(runId)
  if (
    event.type !== 'completed' ||
    event.outcome !== 'succeeded' ||
    event.counters.removed !== 1 ||
    settled?.state !== 'succeeded' ||
    !phases.includes('gc-collect-entered') ||
    !phases.includes('dispose-entered')
  ) {
    throw new Error(
      `compiled-worker-effects-mismatch:${JSON.stringify({ event, settled, phases })}`,
    )
  }
  process.stdout.write(
    `RFC370_COMPILED_WORKER:${JSON.stringify({ outcome: event.outcome, removed: event.counters.removed, phases })}\n`,
  )
} finally {
  clearTimeout(timeout)
  channel.close()
  await supervisor.stop()
  ;(db as unknown as { $client: { close(): void } }).$client.close()
}
