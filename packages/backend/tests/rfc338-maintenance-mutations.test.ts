// RFC-338 AC-12 — executable mutation receipts for the architectural load-
// bearing points. Each case mutates an in-memory copy of production source and
// proves the corresponding oracle turns red; no repository file is rewritten.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BACKEND = resolve(import.meta.dir, '..')
const ROOT = resolve(BACKEND, '..', '..')
const readBackend = (path: string): string => readFileSync(resolve(BACKEND, path), 'utf-8')

interface Sources {
  worker: string
  service: string
  runner: string
  store: string
  migration: string
  catalog: string
  schedule: string
  txSync: string
}

const original: Sources = {
  worker: readBackend('src/platform/background/maintenanceWorker.ts'),
  service: readBackend('src/platform/background/maintenanceService.ts'),
  runner: readBackend('src/platform/background/maintenanceJobRunner.ts'),
  store: readBackend('src/platform/persistence/sqlite/maintenanceRunStore.ts'),
  migration: readFileSync(
    resolve(BACKEND, 'db', 'migrations', '0216_rfc338_maintenance_runs.sql'),
    'utf-8',
  ),
  catalog: readBackend('src/platform/background/maintenanceCatalog.ts'),
  schedule: readBackend('src/platform/background/maintenanceSchedule.ts'),
  txSync: readBackend('src/db/txSync.ts'),
}

function issues(source: Sources): string[] {
  const out: string[] = []
  if (!source.worker.includes('const result = await runMaintenanceJob({')) {
    out.push('worker-hop')
  }
  if (source.service.includes('runMaintenanceJob(')) out.push('main-timer-body')
  if (
    !source.runner.includes('const DB_WRITE_SLICE_ROWS = 1_000') ||
    !source.runner.includes('const EVENT_ARCHIVE_SLICE_ROWS = 5_000') ||
    !source.runner.includes('const EVENT_ARCHIVE_COUNT_WINDOW_IDS = 1_000_000') ||
    !source.runner.includes('DB_WRITE_SLICE_ROWS') ||
    !source.runner.includes('EVENT_ARCHIVE_SLICE_ROWS') ||
    !source.runner.includes('knownGlobalRows')
  ) {
    out.push('bounded-batch')
  }
  if (
    !source.worker.includes('const MAX_BUSY_BACKOFF_MS = 30_000') ||
    !source.worker.includes('sqliteBusyDeferrals: 1') ||
    !source.service.includes('const ADMISSION_BUSY_TIMEOUT_MS = 5')
  ) {
    out.push('busy-backoff')
  }
  if (
    (source.store.match(/eq\(maintenanceRuns\.leaseToken, input\.leaseToken\)/gu) ?? []).length < 4
  ) {
    out.push('durable-fence')
  }
  for (const index of [
    'idx_maintenance_runs_job_slot',
    'idx_maintenance_runs_one_running',
    'idx_maintenance_runs_one_queued',
  ]) {
    if (!source.migration.includes(`CREATE UNIQUE INDEX \`${index}\``)) {
      out.push('slot-unique')
      break
    }
  }
  if (
    !/key: 'lifecycleInvariants',[\s\S]{0,120}class: 'recovery',[\s\S]{0,120}schedule: 'fixed'/u.test(
      source.catalog,
    )
  ) {
    out.push('recovery-class')
  }
  if (
    !source.schedule.includes('zonedWallClockToEpoch') ||
    (source.schedule.match(/schedule\.timezone/gu) ?? []).length < 4
  ) {
    out.push('timezone')
  }
  if (!source.txSync.includes("{ behavior: 'immediate' }")) {
    out.push('foreground-immediate')
  }
  return out
}

describe('RFC-338 mutation receipts', () => {
  test('the unmodified production boundary satisfies every mutation oracle', () => {
    expect(issues(original)).toEqual([])
  })

  const mutations: ReadonlyArray<{
    name: string
    receipt: string
    mutate: (source: Sources) => Sources
  }> = [
    {
      name: 'delete Worker hop',
      receipt: 'worker-hop',
      mutate: (source) => ({
        ...source,
        worker: source.worker.replace(
          'const result = await runMaintenanceJob({',
          'const result = {',
        ),
      }),
    },
    {
      name: 'reconnect a job body to a main timer',
      receipt: 'main-timer-body',
      mutate: (source) => ({ ...source, service: `${source.service}\nrunMaintenanceJob({})\n` }),
    },
    {
      name: 'remove bounded row budgets',
      receipt: 'bounded-batch',
      mutate: (source) => ({
        ...source,
        runner: source.runner
          .replace('const DB_WRITE_SLICE_ROWS = 1_000', 'const DB_WRITE_SLICE_ROWS = Infinity')
          .replace(
            'const EVENT_ARCHIVE_SLICE_ROWS = 5_000',
            'const EVENT_ARCHIVE_SLICE_ROWS = Infinity',
          ),
      }),
    },
    {
      name: 'restore a whole-table event count in every continuation',
      receipt: 'bounded-batch',
      mutate: (source) => ({
        ...source,
        runner: source.runner.replace(
          'const EVENT_ARCHIVE_COUNT_WINDOW_IDS = 1_000_000',
          'const EVENT_ARCHIVE_COUNT_WINDOW_IDS = Infinity',
        ),
      }),
    },
    {
      name: 'remove short busy wait and bounded backoff',
      receipt: 'busy-backoff',
      mutate: (source) => ({
        ...source,
        worker: source.worker.replace(
          'const MAX_BUSY_BACKOFF_MS = 30_000',
          'const MAX_BUSY_BACKOFF_MS = Infinity',
        ),
        service: source.service.replace(
          'const ADMISSION_BUSY_TIMEOUT_MS = 5',
          'const ADMISSION_BUSY_TIMEOUT_MS = 5_000',
        ),
      }),
    },
    {
      name: 'remove lease-token fences',
      receipt: 'durable-fence',
      mutate: (source) => ({
        ...source,
        store: source.store.replaceAll(
          'eq(maintenanceRuns.leaseToken, input.leaseToken)',
          'sql`1 = 1`',
        ),
      }),
    },
    {
      name: 'downgrade durable slot indexes',
      receipt: 'slot-unique',
      mutate: (source) => ({
        ...source,
        migration: source.migration.replaceAll('CREATE UNIQUE INDEX', 'CREATE INDEX'),
      }),
    },
    {
      name: 'move recovery work into the daily cleanup class',
      receipt: 'recovery-class',
      mutate: (source) => ({
        ...source,
        catalog: source.catalog.replace(
          /(key: 'lifecycleInvariants',[\s\S]{0,120})class: 'recovery'/u,
          "$1class: 'cleanup'",
        ),
      }),
    },
    {
      name: 'ignore the configured IANA timezone',
      receipt: 'timezone',
      mutate: (source) => ({
        ...source,
        schedule: source.schedule.replaceAll('schedule.timezone', "'UTC'"),
      }),
    },
    {
      name: 'downgrade foreground transactions to deferred snapshot upgrades',
      receipt: 'foreground-immediate',
      mutate: (source) => ({
        ...source,
        txSync: source.txSync.replace("{ behavior: 'immediate' }", "{ behavior: 'deferred' }"),
      }),
    },
  ]

  for (const mutation of mutations) {
    test(`${mutation.name} is killed by ${mutation.receipt}`, () => {
      expect(issues(mutation.mutate(original))).toContain(mutation.receipt)
    })
  }

  test('the scheduled workflow keeps both 50- and 100-client full-seed tiers', () => {
    const workflow = readFileSync(
      resolve(ROOT, '.github', 'workflows', 'maintenance-soak-nightly.yml'),
      'utf-8',
    )
    const soak = readFileSync(resolve(ROOT, 'scripts', 'rfc338-maintenance-soak.ts'), 'utf-8')
    expect(workflow).toContain("github.event_name == 'schedule' && '100'")
    expect(workflow).toContain("|| '50'")
    expect(workflow).toContain("|| 'full'")
    expect(workflow).toContain('bun run build:binary:e2e')
    expect(workflow).toContain('bun run soak:maintenance')
    expect(soak).toContain("url.pathname = '/ws/tasks'")
    expect(soak).toContain('Array.from({ length: input.args.clients }')
    expect(soak).toContain('HEAVY_MAINTENANCE_JOB_KEYS')
    expect(soak).toContain('SQLite statement p95 exceeded 50ms')
    expect(soak).toContain('perNodeRunBytes: 0')
    expect(soak).toContain('globalBytes: 0')
  })
})
