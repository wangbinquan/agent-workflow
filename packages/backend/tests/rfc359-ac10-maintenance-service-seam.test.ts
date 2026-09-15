// RFC-359 AC-10 —— `startMaintenanceService` 的第一批覆盖。
//
// 这个文件之所以到现在才存在，是因为这个服务此前**没有注入接缝**：它直接 `import`
// 监工、自己按 provider 开准入连接，于是既没法替身也没法断言，账本上那两处
// `options.provider === 'postgresql'` 与「零覆盖」是同一件事的两面。
//
// AC-10 把「谁来装」交回装配方（`openAdmissionStore` / `startSupervisor` 两个工厂）之后，
// 分叉消失，接缝也就有了。下面锁的都是**穿过接缝的功能接线**，不是实现细节：
//   · 两个工厂拿到的是同一份 live config（装配方据它开连接 / 起监工）；
//   · 准入真的落在装配方交出的那个 store 上（`runSoon` → `enqueue`）；
//   · 监工的 delta / event 真的接回服务的回调；
//   · `stop()` 会关掉准入连接，而「没有本地连接可关」的形态（外部服务器）不会因此崩。
import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '@agent-workflow/shared'

import { loadConfig } from '@/config'
import {
  startMaintenanceService,
  type MaintenanceServiceOptions,
} from '@/platform/background/maintenanceService'
import type { MaintenanceRunStore } from '@/platform/background/maintenanceRunStorePort'
import type { MaintenanceWorkerDelta } from '@/platform/background/maintenanceProtocol'
import type { MaintenanceWorkerSupervisor } from '@/platform/background/maintenanceWorkerSupervisor'
import { eventually } from './helpers/eventually'

function configFixture(): { path: string; config: Config } {
  const dir = mkdtempSync(join(tmpdir(), 'rfc359-ac10-maintenance-'))
  const path = join(dir, 'config.json')
  writeFileSync(path, '{}')
  return { path, config: loadConfig(path) }
}

interface Harness {
  readonly service: ReturnType<typeof startMaintenanceService>
  readonly enqueued: string[]
  readonly closed: { count: number }
  readonly seams: {
    admissionConfigs: Config[]
    supervisorConfigs: Config[]
    handlers: Parameters<MaintenanceServiceOptions['startSupervisor']>[1] | null
  }
  readonly supervisorStops: { count: number }
}

function startHarness(
  overrides: {
    readonly provider?: MaintenanceServiceOptions['provider']
    /** 外部服务器形态没有本地连接可关，`close` 省略。 */
    readonly withClose?: boolean
    readonly onLifecycleDelta?: MaintenanceServiceOptions['onLifecycleDelta']
    readonly onIntentQueued?: MaintenanceServiceOptions['onIntentQueued']
  } = {},
): Harness {
  const { path, config } = configFixture()
  const enqueued: string[] = []
  const closed = { count: 0 }
  const supervisorStops = { count: 0 }
  const seams: Harness['seams'] = {
    admissionConfigs: [],
    supervisorConfigs: [],
    handlers: null,
  }

  const store = {
    async enqueue(input: { readonly jobKey: string }) {
      enqueued.push(input.jobKey)
      return {
        row: null as never,
        inserted: true,
        coalesced: false,
      }
    },
    async readProjection() {
      return { active: null, last: null, backlog: [] }
    },
  } as unknown as MaintenanceRunStore

  const supervisor: MaintenanceWorkerSupervisor = {
    wake() {},
    live: () => ({ state: 'ready', lastHeartbeatAt: null, error: null, active: null }),
    pause: async () => undefined,
    resume: async () => undefined,
    stop: async () => {
      supervisorStops.count += 1
    },
    drain: async () => undefined,
  }

  const service = startMaintenanceService({
    provider: overrides.provider ?? 'sqlite',
    appHome: join(path, '..'),
    configPath: path,
    loadConfig: () => loadConfig(path),
    fileSnapshotInFlight: () => false,
    payloadSources: Object.freeze({
      activeTaskIds: () => [],
      activeIntentApplyJournalIds: () => [],
      activeResourceBundleApplyIds: () => [],
      bootIntentTurnIds: () => [],
    }),
    openAdmissionStore: (liveConfig) => {
      seams.admissionConfigs.push(liveConfig)
      return overrides.withClose === false
        ? { store }
        : {
            store,
            close: () => {
              closed.count += 1
            },
          }
    },
    startSupervisor: (liveConfig, handlers) => {
      seams.supervisorConfigs.push(liveConfig)
      seams.handlers = handlers
      return supervisor
    },
    ...(overrides.onLifecycleDelta === undefined
      ? {}
      : { onLifecycleDelta: overrides.onLifecycleDelta }),
    ...(overrides.onIntentQueued === undefined ? {} : { onIntentQueued: overrides.onIntentQueued }),
  })
  void config
  return { service, enqueued, closed, seams, supervisorStops }
}

test('两个接缝各被调用一次，并且拿到的是同一份 live config', async () => {
  const harness = startHarness()
  try {
    expect(harness.seams.admissionConfigs).toHaveLength(1)
    expect(harness.seams.supervisorConfigs).toHaveLength(1)
    // 装配方据这份 config 开准入连接（pragma）与起监工（同一批 sqlite 参数）——
    // 两边看到的必须是**同一个对象**，不是「值相等的另一次读取」：后者在 config 于两次读取
    // 之间被改写时会让连接和 Worker 按不同参数跑。用 `toBe` 而不是 `toEqual`，因为
    // `loadConfig()` 重读一次也会得到值相等的对象——那正是这条要挡住的形态。
    expect(harness.seams.supervisorConfigs[0]).toBe(harness.seams.admissionConfigs[0]!)
    expect(harness.seams.admissionConfigs[0]!.maintenanceSchedule).toBeDefined()
  } finally {
    await harness.service.stop()
  }
})

test('准入落在装配方交出的那个 store 上：runSoon 的作业进它的 enqueue', async () => {
  const harness = startHarness()
  try {
    harness.service.runSoon('backupPrune')
    // 只断言「它到了注入的那个 store」——同一批里还会有开机延迟作业
    // （`FIXED_MAINTENANCE_JOB_SPECS` 的 `bootDelayMs` 那几条，本身也穿这条接缝），
    // 锁死整个集合等于把作业目录抄进这个文件。
    expect(
      await eventually(
        async () => harness.enqueued,
        (jobs) => jobs.includes('backupPrune'),
        { what: 'maintenance admission reaching the injected store' },
      ),
    ).toContain('backupPrune')
  } finally {
    await harness.service.stop()
  }
})

test('监工交回的 delta / event 接到服务的回调上', async () => {
  const alerts: MaintenanceWorkerDelta[] = []
  const intentSessions: string[][] = []
  const harness = startHarness({
    onLifecycleDelta: (delta) => alerts.push(delta),
    onIntentQueued: (sessionIds) => intentSessions.push([...sessionIds]),
  })
  try {
    const handlers = harness.seams.handlers
    expect(handlers).not.toBeNull()
    handlers!.onDelta('run-1', 'lifecycleInvariants', {
      kind: 'lifecycle-alerts',
      alerts: [],
      resolvedTaskIds: [],
    } as unknown as MaintenanceWorkerDelta)
    handlers!.onDelta('run-2', 'intentRecovery', {
      kind: 'intent-queued',
      sessionIds: ['ses-1', 'ses-2'],
    } as unknown as MaintenanceWorkerDelta)
    expect(alerts).toHaveLength(1)
    expect(intentSessions).toEqual([['ses-1', 'ses-2']])
  } finally {
    await harness.service.stop()
  }
})

test('stop() 关掉准入连接并停掉监工；没有本地连接可关的形态照样停得下来', async () => {
  const local = startHarness()
  await local.service.stop()
  expect(local.closed.count).toBe(1)
  expect(local.supervisorStops.count).toBe(1)

  // 外部服务器形态：store 组在已验证代上，没有本地连接，`close` 整个省略。
  // 这一条锁的就是「省略不等于崩」——`admissionStore.close?.()` 的那个可选调用。
  const remote = startHarness({ provider: 'postgresql', withClose: false })
  await remote.service.stop()
  expect(remote.closed.count).toBe(0)
  expect(remote.supervisorStops.count).toBe(1)
})

test('stop() 幂等：重复调用只停一次监工、只关一次连接', async () => {
  const harness = startHarness()
  await harness.service.stop()
  await harness.service.stop()
  expect(harness.closed.count).toBe(1)
  expect(harness.supervisorStops.count).toBe(1)
})
