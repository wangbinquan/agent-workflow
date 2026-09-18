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
  eventArchive: string
  store: string
  migration: string
  catalog: string
  schedule: string
  txSync: string
  /**
   * RFC-359 AC-10：准入连接搬到了 `platform/persistence/`（`cli/start.ts` 不得 import
   * `@/db/client`，见 `rfc349-provider-cutover`），`ADMISSION_BUSY_TIMEOUT_MS` 跟着搬。
   * 判据不变——准入必须保持**短**忙等——只是跟到它现在所在的文件。
   */
  admissionStore: string
}

const original: Sources = {
  worker: readBackend('src/platform/background/maintenanceWorker.ts'),
  service: readBackend('src/platform/background/maintenanceService.ts'),
  runner: readBackend('src/platform/background/maintenanceJobRunner.ts'),
  eventArchive: readBackend('src/platform/background/eventsArchiveMaintenance.ts'),
  store: readBackend('src/platform/persistence/maintenanceRunStore.ts'),
  migration: readFileSync(
    resolve(BACKEND, 'db', 'migrations', '0216_rfc338_maintenance_runs.sql'),
    'utf-8',
  ),
  catalog: readBackend('src/platform/background/maintenanceCatalog.ts'),
  schedule: readBackend('src/platform/background/maintenanceSchedule.ts'),
  txSync: readBackend('src/db/txSync.ts'),
  admissionStore: readBackend('src/platform/persistence/sqlite/maintenanceAdmissionStore.ts'),
}

function issues(source: Sources): string[] {
  const out: string[] = []
  if (!source.worker.includes('const result = await runMaintenanceJob({')) {
    out.push('worker-hop')
  }
  if (source.service.includes('runMaintenanceJob(')) out.push('main-timer-body')
  if (
    !source.runner.includes('const DB_WRITE_SLICE_ROWS = 1_000') ||
    !source.runner.includes('DB_WRITE_SLICE_ROWS') ||
    !source.eventArchive.includes('const EVENT_ARCHIVE_SLICE_ROWS = 1_000') ||
    !source.eventArchive.includes('const EVENT_ARCHIVE_COUNT_WINDOW_IDS = 250_000') ||
    !source.eventArchive.includes('EVENT_ARCHIVE_SLICE_ROWS') ||
    !source.eventArchive.includes('knownGlobalRows')
  ) {
    out.push('bounded-batch')
  }
  if (
    !source.worker.includes('const MAX_BUSY_BACKOFF_MS = 30_000') ||
    !source.worker.includes('sqliteBusyDeferrals: 1') ||
    // 用 `\b` 收尾，不能用 `includes`：把 5 改成 5_000 之后
    // `'const ADMISSION_BUSY_TIMEOUT_MS = 5_000'` **仍然包含** `'… = 5'`，
    // 于是这一半判据从来没咬到过——整条 busy-backoff 收据一直只靠上面 worker 那一半在绿。
    // （这是搬家时顺手发现的旧洞，不是搬家引入的：判据读 `service` 时就已经这样。）
    !/const ADMISSION_BUSY_TIMEOUT_MS = 5\b/u.test(source.admissionStore)
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
        runner: source.runner.replace(
          'const DB_WRITE_SLICE_ROWS = 1_000',
          'const DB_WRITE_SLICE_ROWS = Infinity',
        ),
        eventArchive: source.eventArchive.replace(
          'const EVENT_ARCHIVE_SLICE_ROWS = 1_000',
          'const EVENT_ARCHIVE_SLICE_ROWS = Infinity',
        ),
      }),
    },
    {
      name: 'restore a whole-table event count in every continuation',
      receipt: 'bounded-batch',
      mutate: (source) => ({
        ...source,
        eventArchive: source.eventArchive.replace(
          'const EVENT_ARCHIVE_COUNT_WINDOW_IDS = 250_000',
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
        // RFC-359 AC-10：跟着常量搬到 `admissionStore`。留在 `service` 上会变成一次**空替换**
        // ——判据仍绿，但绿的全部来自上面 worker 那一半，准入忙等这一半已经不咬了。
        admissionStore: source.admissionStore.replace(
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
    expect(soak).toContain('SQLite statement p95 exceeded ')
    // The freeze judgement is two-sided on purpose: a slow *stretch* (>0.1% of
    // statements over 250ms) and a single hard stall (>=1s). A single-sample
    // `max >= 250ms` cap measured shared-runner scheduling noise, not the
    // product — it flapped red/green across unrelated commits.
    //
    // 2026-09-19：事务那一半当初漏改，于是同一类抖动继续在事务这一格红两次
    // （`a889b978c` 是 runner 冻结、`934c31af9` 是 runner 变快跨过 GC 相位边界，
    // 详见 scripts/rfc338-maintenance-soak.ts 里的注释）。现在两侧同形，判据本身
    // ——而不是消息措辞——才是不许回退的东西；行为级断言（用那三次真实跑的原数）
    // 在 packages/backend/tests/rfc338-soak-timing-gates.test.ts。
    expect(soak).toContain('const STATEMENT_SLOW_RATIO = 0.001')
    expect(soak).toContain('const TRANSACTION_SLOW_RATIO = 0.02')
    expect(soak).toContain('const TRANSACTION_SLOW_MIN_COUNT = 3')
    expect(soak).toContain('statements.le250Ratio < 1 - STATEMENT_SLOW_RATIO')
    expect(soak).toContain('transactions.le250Ratio < 1 - TRANSACTION_SLOW_RATIO')
    expect(soak).toContain('statements.maxMs >= HARD_FREEZE_MS')
    expect(soak).toContain('transactions.maxMs >= HARD_FREEZE_MS')
    // 两侧的旧形状都不许回来：单样本 `max >= 250ms` 上限，以及事务的 95%<=50ms 门。
    expect(soak).not.toContain('>= 250ms`')
    expect(soak).not.toContain('transactions.le50Ratio < 0.95')
    expect(soak).toContain('perNodeRunBytes: 0')
    expect(soak).toContain('globalBytes: 0')
  })
})
