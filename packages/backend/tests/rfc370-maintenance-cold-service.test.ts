import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '@agent-workflow/shared'

import { loadConfig } from '@/config'
import {
  createColdMaintenanceService,
  type ColdMaintenanceServiceOptions,
} from '@/platform/background/maintenanceService'
import type {
  EnqueueMaintenanceRunInput,
  MaintenanceRunRecord,
  MaintenanceRunStore,
} from '@/platform/background/maintenanceRunStorePort'
import type { ColdMaintenanceWorkerSupervisor } from '@/platform/background/maintenanceWorkerSupervisor'
import { notifyConfigApplied } from '@/services/configAppliedListeners'
import { eventually } from './helpers/eventually'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function lifetime(): { valid: boolean; current: () => boolean } {
  return {
    valid: true,
    current() {
      return this.valid
    },
  }
}

function coldHarness(
  options: {
    readonly payloadWait?: ReturnType<typeof deferred>
    readonly enqueueWait?: ReturnType<typeof deferred>
    readonly onCreate?: (supervisor: ColdMaintenanceWorkerSupervisor) => void
    readonly resumeWait?: ReturnType<typeof deferred>
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'rfc370-cold-maintenance-service-'))
  const path = join(home, 'config.json')
  writeFileSync(path, '{}')
  const initialConfig = loadConfig(path)
  const inputs: EnqueueMaintenanceRunInput[] = []
  const owners: ReturnType<typeof owner>[] = []
  const factoryConfigs: Config[] = []
  const storeConfigs: Config[] = []
  const observations = { bootReads: 0, payloadReads: 0, closes: 0, closeReceiver: false }
  const store: MaintenanceRunStore = {
    async enqueue(input) {
      inputs.push(input)
      await options.enqueueWait?.promise
      const row: MaintenanceRunRecord = {
        id: input.id,
        jobKey: input.jobKey,
        jobClass: input.jobClass,
        slotKey: input.slotKey,
        cycleKey: input.cycleKey ?? null,
        payloadJson: JSON.stringify(input.payload),
        state: 'pending',
        cursorVersion: 1,
        cursorJson: null,
        leaseToken: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        attempt: 0,
        sliceNo: 0,
        countersJson: '{}',
        errorCode: null,
        errorMessage: null,
        scheduledAt: input.scheduledAt,
        createdAt: input.now,
        updatedAt: input.now,
        startedAt: null,
        finishedAt: null,
      }
      return { row, inserted: true, coalesced: false }
    },
    async recoverRunning() {
      throw new Error('service must not recover Worker rows')
    },
    async claimNext() {
      throw new Error('service must not claim Worker rows')
    },
    async heartbeat() {
      throw new Error('service must not heartbeat Worker rows')
    },
    async settle() {
      throw new Error('service must not settle Worker rows')
    },
    async read() {
      return null
    },
    async readProjection() {
      return { active: null, last: null, backlog: [] }
    },
  }
  const admission = {
    store,
    close() {
      observations.closes += 1
      observations.closeReceiver = this === admission
    },
  }
  function owner() {
    const ready = deferred(),
      drained = deferred()
    const calls: string[] = []
    let state: 'stopped' | 'starting' | 'ready' = 'stopped'
    const supervisor: ColdMaintenanceWorkerSupervisor = {
      wake() {
        expect(this).toBe(supervisor)
        calls.push('wake')
      },
      live() {
        expect(this).toBe(supervisor)
        return { state, active: null, error: null, lastHeartbeatAt: null }
      },
      async pause() {
        expect(this).toBe(supervisor)
        calls.push('pause')
        state = 'stopped'
      },
      async resume() {
        expect(this).toBe(supervisor)
        calls.push('resume')
        await options.resumeWait?.promise
        state = 'ready'
      },
      async stop() {
        expect(this).toBe(supervisor)
        calls.push('stop')
        ready.resolve()
        drained.resolve()
        state = 'stopped'
      },
      async drain() {
        expect(this).toBe(supervisor)
        calls.push('ordinary-drain')
      },
      async start() {
        expect(this).toBe(supervisor)
        calls.push('start')
        state = 'starting'
        await ready.promise
        state = 'ready'
      },
      quiesce() {
        expect(this).toBe(supervisor)
        calls.push('quiesce')
        state = 'stopped'
      },
      async awaitDrained() {
        expect(this).toBe(supervisor)
        calls.push('actual-drain')
        await drained.promise
      },
    }
    return { supervisor, ready, drained, calls }
  }
  const service = createColdMaintenanceService({
    provider: 'sqlite',
    appHome: home,
    configPath: path,
    loadConfig: () => initialConfig,
    fileSnapshotInFlight: () => false,
    payloadSources: {
      async activeTaskIds() {
        observations.payloadReads += 1
        await options.payloadWait?.promise
        return ['task-original']
      },
      activeIntentApplyJournalIds: () => [],
      activeResourceBundleApplyIds: () => [],
      bootIntentTurnIds() {
        observations.bootReads += 1
        return ['turn-original']
      },
    },
    openAdmissionStore(config) {
      storeConfigs.push(config)
      return admission
    },
    createSupervisor(config) {
      factoryConfigs.push(config)
      const next = owner()
      owners.push(next)
      options.onCreate?.(next.supervisor)
      return next.supervisor
    },
  } satisfies ColdMaintenanceServiceOptions)
  return {
    service,
    owners,
    inputs,
    observations,
    initialConfig,
    factoryConfigs,
    storeConfigs,
    admission,
    async apply(config: Config) {
      await notifyConfigApplied(path, config)
    },
    async finish() {
      options.payloadWait?.resolve()
      options.enqueueWait?.resolve()
      options.resumeWait?.resolve()
      for (const item of owners) {
        item.ready.resolve()
        item.drained.resolve()
      }
      await service.stop()
      rmSync(home, { recursive: true, force: true })
    },
  }
}

async function ownerReady(harness: ReturnType<typeof coldHarness>, scope = lifetime()) {
  const starting = harness.service.start(scope)
  await eventually(
    async () => harness.owners.length,
    (count) => count > 0,
  )
  harness.owners.at(-1)!.ready.resolve()
  await starting
  return scope
}

test('cold service queries, hot configuration and unstarted close create no execution owner', async () => {
  const h = coldHarness()
  try {
    expect(h.storeConfigs).toEqual([h.initialConfig])
    expect(h.observations.bootReads).toBe(1)
    const config = { ...h.initialConfig, backupRetentionCount: 37 }
    await h.apply(config)
    h.service.reconfigure()
    await h.service.pause()
    expect(h.service.status()).toMatchObject({
      worker: { state: 'stopped' },
      nextRunAt: null,
      eventLoop: { sampleCount: 0 },
    })
    expect(() => h.service.runSoon('backupPrune')).toThrow('maintenance execution is not ready')
    expect(h.owners).toEqual([])
    expect(h.inputs).toEqual([])
    h.admission.close = () => {
      throw new Error('replacement close must not be called')
    }
    await h.service.stop()
    await h.service.stop()
    expect(h.observations).toMatchObject({ closes: 1, closeReceiver: true, bootReads: 1 })
  } finally {
    await h.finish()
  }
})

test('cold service waits for the same ready owner before admission and captures the live factory configuration', async () => {
  const h = coldHarness()
  try {
    const scope = lifetime()
    const config = { ...h.initialConfig, backupRetentionCount: 37 }
    await h.apply(config)
    const starting = h.service.start(scope)
    expect(h.service.start(scope)).toBe(starting)
    await eventually(
      async () => h.owners.length,
      (count) => count >= 1,
    )
    expect(h.factoryConfigs[0]).toBe(config)
    expect(h.service.status().worker.state).toBe('starting')
    expect(() => h.service.runSoon('backupPrune')).toThrow('maintenance execution is not ready')
    expect(h.inputs).toEqual([])
    h.owners[0]!.ready.resolve()
    await starting
    h.service.runSoon('backupPrune')
    await eventually(
      async () => h.inputs,
      (inputs) => inputs.some((input) => input.jobKey === 'backupPrune'),
    )
    expect(h.inputs.find((input) => input.jobKey === 'backupPrune')!.payload).toMatchObject({
      retentionCount: 37,
    })
    expect(h.owners[0]!.calls).toContain('wake')
    expect(h.observations.bootReads).toBe(1)
  } finally {
    await h.finish()
  }
})

test('loss during asynchronous payload preparation retains the slot and revalidates configuration on the next owner', async () => {
  const payloadWait = deferred()
  const h = coldHarness({ payloadWait })
  try {
    const first = await ownerReady(h)
    h.service.runSoon('worktreeGc')
    await eventually(
      async () => h.observations.payloadReads,
      (count) => count >= 1,
    )
    first.valid = false
    await h.service.quiesce(first)
    let drained = false
    const draining = h.service.awaitDrained(first).then(() => {
      drained = true
    })
    const config = {
      ...h.initialConfig,
      worktreeAutoGc: {
        ...h.initialConfig.worktreeAutoGc,
        enabled: !h.initialConfig.worktreeAutoGc.enabled,
      },
    }
    await h.apply(config)
    payloadWait.resolve()
    await eventually(
      async () => h.owners[0]!.calls,
      (calls) => calls.includes('actual-drain'),
    )
    expect(h.inputs.filter((input) => input.jobKey === 'worktreeGc')).toEqual([])
    expect(drained).toBe(false)
    h.owners[0]!.drained.resolve()
    await draining
    const next = h.service.start(lifetime())
    await eventually(
      async () => h.owners.length,
      (count) => count === 2,
    )
    h.owners[1]!.ready.resolve()
    await next
    await eventually(
      async () => h.inputs,
      (inputs) => inputs.some((input) => input.jobKey === 'worktreeGc'),
    )
    expect(h.inputs.find((input) => input.jobKey === 'worktreeGc')!.payload).toMatchObject({
      worktreeAutoGc: config.worktreeAutoGc,
      activeTaskIds: ['task-original'],
    })
    expect(h.observations.bootReads).toBe(1)
  } finally {
    await h.finish()
  }
})

test('loss waits for a pending enqueue and actual owner drain without waking the retired owner', async () => {
  const enqueueWait = deferred()
  const h = coldHarness({ enqueueWait })
  try {
    const scope = await ownerReady(h)
    h.service.runSoon('backupPrune')
    await eventually(
      async () => h.inputs.filter((input) => input.jobKey === 'backupPrune').length,
      (count) => count === 1,
    )
    const wakesBeforeLoss = h.owners[0]!.calls.filter((call) => call === 'wake').length
    scope.valid = false
    await h.service.quiesce(scope)
    let drained = false
    const draining = h.service.awaitDrained(scope).then(() => {
      drained = true
    })
    h.owners[0]!.drained.resolve()
    expect(drained).toBe(false)
    enqueueWait.resolve()
    await draining
    expect(h.owners[0]!.calls.filter((call) => call === 'wake')).toHaveLength(wakesBeforeLoss)
    expect(h.inputs.filter((input) => input.jobKey === 'backupPrune')).toHaveLength(1)
  } finally {
    await h.finish()
  }
})

test('actual drain timeout preserves the old owner and a late receipt permits the next lifetime', async () => {
  const h = coldHarness()
  try {
    const scope = await ownerReady(h)
    scope.valid = false
    await h.service.quiesce(scope)
    await expect(h.service.awaitDrained(scope, 17)).rejects.toThrow(
      'maintenance execution actual drain timed out',
    )
    expect(h.owners).toHaveLength(1)
    expect(h.owners[0]!.calls).not.toContain('stop')
    let nextReady = false
    const next = h.service.start(lifetime()).then(() => {
      nextReady = true
    })
    await eventually(
      async () => h.owners[0]!.calls.filter((call) => call === 'actual-drain').length,
      (count) => count >= 2,
    )
    expect(nextReady).toBe(false)
    expect(h.owners).toHaveLength(1)
    h.owners[0]!.drained.resolve()
    await eventually(
      async () => h.owners.length,
      (count) => count === 2,
    )
    h.owners[1]!.ready.resolve()
    await next
  } finally {
    await h.finish()
  }
})

test('pending starts preserve the original current function, owner methods and receivers', async () => {
  const h = coldHarness()
  try {
    const scope = lifetime()
    const starting = h.service.start(scope)
    void starting.catch(() => undefined)
    await eventually(
      async () => h.owners.length,
      (count) => count === 1,
    )
    const original = h.owners[0]!
    scope.current = () => true
    scope.valid = false
    original.supervisor.quiesce = () => {
      throw new Error('replacement quiesce must not be called')
    }
    original.supervisor.awaitDrained = async () => {
      throw new Error('replacement drain must not be called')
    }
    original.ready.resolve()
    await expect(starting).rejects.toThrow('maintenance execution start quiesced')
    expect(original.calls).toContain('quiesce')
    const draining = h.service.awaitDrained(scope)
    original.drained.resolve()
    await draining
    expect(original.calls).toContain('actual-drain')
    expect(h.inputs).toEqual([])
  } finally {
    await h.finish()
  }
})

test('a second lifetime fences the pending first start and waits for its actual receipt before creation', async () => {
  const h = coldHarness()
  try {
    const first = lifetime(),
      second = lifetime()
    const starting = h.service.start(first)
    void starting.catch(() => undefined)
    await eventually(
      async () => h.owners.length,
      (count) => count === 1,
    )
    const next = h.service.start(second)
    h.owners[0]!.ready.resolve()
    await expect(starting).rejects.toThrow('maintenance execution start quiesced')
    await eventually(
      async () => h.owners[0]!.calls,
      (calls) => calls.includes('actual-drain'),
    )
    expect(h.owners).toHaveLength(1)
    h.owners[0]!.drained.resolve()
    await eventually(
      async () => h.owners.length,
      (count) => count === 2,
    )
    h.owners[1]!.ready.resolve()
    await next
    expect(h.service.status().worker.state).toBe('ready')
  } finally {
    await h.finish()
  }
})

test('a superseded lifetime cannot restart while its successor waits for the original receipt', async () => {
  const h = coldHarness()
  try {
    const first = await ownerReady(h)
    // Both current callbacks remain true: retirement belongs to this service's
    // lifetime transition and must not create a mutual wait between start tails.
    const next = h.service.start(lifetime())
    await eventually(
      async () => h.owners[0]!.calls,
      (calls) => calls.includes('actual-drain'),
    )
    await expect(h.service.start(first)).rejects.toThrow(
      'maintenance execution lifetime has been superseded',
    )
    expect(h.owners).toHaveLength(1)
    h.owners[0]!.drained.resolve()
    await eventually(
      async () => h.owners.length,
      (count) => count === 2,
    )
    h.owners[1]!.ready.resolve()
    await next
    expect(h.service.status().worker.state).toBe('ready')
  } finally {
    await h.finish()
  }
})

// SOURCE-R1 P2-001: completed generations must leave the strong wait population;
// otherwise every subsequent selection repeats all prior quiesce/drain calls.
test('actually drained owners leave the wait population across new and repeated lifetimes', async () => {
  const h = coldHarness()
  try {
    let scope = await ownerReady(h)
    const first = scope
    const retired: Array<{ calls: string[]; completedCalls: string[] }> = []
    for (let i = 0; i < 10; i += 1) {
      const owner = h.owners.at(-1)!
      scope.valid = false
      await h.service.quiesce(scope)
      owner.drained.resolve()
      await h.service.awaitDrained(scope)
      retired.push({ calls: owner.calls, completedCalls: [...owner.calls] })
      scope = lifetime()
      const starting = h.service.start(scope)
      await eventually(
        async () => h.owners.length,
        (count) => count === i + 2,
      )
      h.owners.at(-1)!.ready.resolve()
      await starting
      for (const previous of retired) expect(previous.calls).toEqual(previous.completedCalls)
    }
    await expect(h.service.start(first)).rejects.toThrow(
      'maintenance execution lifetime has been superseded',
    )
    // Restarting the most recent lifetime must release its old owner as well.
    for (let i = 0; i < 2; i += 1) {
      const owner = h.owners.at(-1)!
      await h.service.quiesce(scope)
      owner.drained.resolve()
      await h.service.awaitDrained(scope)
      retired.push({ calls: owner.calls, completedCalls: [...owner.calls] })
      const countBeforeStart = h.owners.length
      const starting = h.service.start(scope)
      await eventually(
        async () => h.owners.length,
        (count) => count === countBeforeStart + 1,
      )
      h.owners.at(-1)!.ready.resolve()
      await starting
      for (const previous of retired) expect(previous.calls).toEqual(previous.completedCalls)
    }
    await h.service.stop()
    for (const previous of retired) expect(previous.calls).toEqual(previous.completedCalls)
    expect(h.owners.at(-1)!.calls.filter((call) => call === 'stop')).toHaveLength(1)
  } finally {
    await h.finish()
  }
})

// SOURCE-R2 P2-003: a normal pause must win against pending readiness without
// retiring its still-current lifetime or turning resume into implicit startup.
test('normal pause during pending readiness stays closed until the original owner resumes', async () => {
  const h = coldHarness()
  try {
    const starting = h.service.start(lifetime())
    void starting.catch(() => undefined)
    await eventually(
      async () => h.owners.length,
      (count) => count === 1,
    )
    const original = h.owners[0]!
    await h.service.pause()
    expect(original.calls).toContain('pause')
    original.ready.resolve()
    await expect(starting).rejects.toThrow('maintenance execution start paused')
    expect(original.calls).not.toContain('quiesce')
    expect(h.inputs).toEqual([])
    expect(h.service.status()).toMatchObject({
      nextRunAt: null,
      eventLoop: { sampleCount: 0 },
    })
    expect(() => h.service.runSoon('backupPrune')).toThrow('maintenance execution is not ready')
    original.supervisor.resume = async () => {
      throw new Error('replacement resume must not be called')
    }
    await h.service.resume()
    expect(h.owners).toHaveLength(1)
    expect(original.calls).toContain('resume')
    h.service.runSoon('backupPrune')
    await eventually(
      async () => h.inputs,
      (inputs) => inputs.some((input) => input.jobKey === 'backupPrune'),
    )
  } finally {
    await h.finish()
  }
})

test('normal pause while a successor waits for an old ACK prevents creation until explicit resume', async () => {
  const h = coldHarness()
  try {
    await ownerReady(h)
    const original = h.owners[0]!
    const next = h.service.start(lifetime())
    void next.catch(() => undefined)
    await eventually(
      async () => original.calls,
      (calls) => calls.includes('actual-drain'),
    )
    await h.service.pause()
    expect(original.calls).not.toContain('pause')
    original.drained.resolve()
    await expect(next).rejects.toThrow('maintenance execution start paused')
    expect(h.owners).toHaveLength(1)
    expect(() => h.service.runSoon('backupPrune')).toThrow('maintenance execution is not ready')
    const completedCalls = [...original.calls]
    const resuming = h.service.resume()
    await eventually(
      async () => h.owners.length,
      (count) => count === 2,
    )
    h.owners[1]!.ready.resolve()
    await resuming
    expect(original.calls).toEqual(completedCalls)
    expect(h.service.status().worker.state).toBe('ready')
  } finally {
    await h.finish()
  }
})

test('unstarted normal pause and resume remain cold before explicit current startup', async () => {
  const h = coldHarness()
  try {
    const scope = lifetime()
    await h.service.pause()
    await expect(h.service.start(scope)).rejects.toThrow('maintenance execution start paused')
    await h.service.resume()
    expect(h.owners).toEqual([])
    expect(h.inputs).toEqual([])
    expect(h.service.status().eventLoop.sampleCount).toBe(0)
    await ownerReady(h, scope)
    expect(h.owners).toHaveLength(1)
  } finally {
    await h.finish()
  }
})

// SOURCE-R2 P2-004: an injected synchronous factory may close this exact frame
// before returning. The newly captured owner must see that fence before start.
test('factory reentrant quiesce rejects startup before starting the returned owner and retains its drain', async () => {
  const scope = lifetime()
  const h: ReturnType<typeof coldHarness> = coldHarness({
    onCreate: () => void h.service.quiesce(scope),
  })
  try {
    await expect(h.service.start(scope)).rejects.toThrow('maintenance execution start quiesced')
    const original = h.owners[0]!
    expect(original.calls).toContain('quiesce')
    expect(original.calls).not.toContain('start')
    expect(h.inputs).toEqual([])
    let drained = false
    const draining = h.service.awaitDrained(scope).then(() => {
      drained = true
    })
    await eventually(
      async () => original.calls,
      (calls) => calls.includes('actual-drain'),
    )
    expect(drained).toBe(false)
    original.drained.resolve()
    await draining
    expect(drained).toBe(true)
  } finally {
    await h.finish()
  }
})

test('factory reentrant normal pause keeps the returned owner cold until explicit resume and ready', async () => {
  let pausing: Promise<void> | undefined
  const h: ReturnType<typeof coldHarness> = coldHarness({
    onCreate() {
      pausing = h.service.pause()
    },
  })
  try {
    await expect(h.service.start(lifetime())).rejects.toThrow('maintenance execution start paused')
    await pausing
    const original = h.owners[0]!
    expect(original.calls).toContain('pause')
    expect(original.calls).not.toContain('start')
    expect(original.calls).not.toContain('quiesce')
    expect(h.inputs).toEqual([])
    const resuming = h.service.resume()
    await eventually(
      async () => original.calls,
      (calls) => calls.includes('start'),
    )
    expect(() => h.service.runSoon('backupPrune')).toThrow('maintenance execution is not ready')
    original.ready.resolve()
    await resuming
    expect(h.owners).toHaveLength(1)
    expect(h.service.status().worker.state).toBe('ready')
  } finally {
    await h.finish()
  }
})

test('loss drains a pending ordinary resume tail before its owner ACK permits the next lifetime', async () => {
  const resumeWait = deferred()
  const h = coldHarness({ resumeWait })
  try {
    const first = await ownerReady(h)
    const original = h.owners[0]!
    await h.service.pause()
    const resuming = h.service.resume()
    void resuming.catch(() => undefined)
    expect(h.service.start(first)).toBe(resuming)
    await eventually(
      async () => original.calls,
      (calls) => calls.includes('resume'),
    )
    const wakesBeforeLoss = original.calls.filter((call) => call === 'wake').length
    first.valid = false
    await h.service.quiesce(first)
    const next = h.service.start(lifetime())
    expect(h.owners).toHaveLength(1)
    expect(original.calls).not.toContain('actual-drain')
    resumeWait.resolve()
    await expect(resuming).rejects.toThrow('maintenance execution lifetime is not current')
    await eventually(
      async () => original.calls,
      (calls) => calls.includes('actual-drain'),
    )
    expect(h.owners).toHaveLength(1)
    expect(original.calls.filter((call) => call === 'wake')).toHaveLength(wakesBeforeLoss)
    original.drained.resolve()
    await eventually(
      async () => h.owners.length,
      (count) => count === 2,
    )
    h.owners[1]!.ready.resolve()
    await next
    expect(h.service.status().worker.state).toBe('ready')
  } finally {
    await h.finish()
  }
})

test('another normal pause during pending resume wins until a later explicit resume', async () => {
  const resumeWait = deferred()
  const h = coldHarness({ resumeWait })
  try {
    await ownerReady(h)
    const original = h.owners[0]!
    await h.service.pause()
    const resuming = h.service.resume()
    await eventually(
      async () => original.calls,
      (calls) => calls.includes('resume'),
    )
    await h.service.pause()
    resumeWait.resolve()
    await resuming
    expect(original.calls).not.toContain('quiesce')
    expect(() => h.service.runSoon('backupPrune')).toThrow('maintenance execution is not ready')
    expect(h.service.status()).toMatchObject({
      nextRunAt: null,
      eventLoop: { sampleCount: 0 },
    })
    await h.service.resume()
    expect(h.owners).toHaveLength(1)
    h.service.runSoon('backupPrune')
    await eventually(
      async () => h.inputs,
      (inputs) => inputs.some((input) => input.jobKey === 'backupPrune'),
    )
  } finally {
    await h.finish()
  }
})

// SOURCE-R3 P2-005: clearing ordinary pause intent cannot depend on granting
// an old lost owner. Test both already-ACKed and still-held old resources.
test('explicit resume after ordinary pause and loss clears intent without reactivating the old owner or bypassing its ACK', async () => {
  for (const oldAckFirst of [false, true]) {
    const h = coldHarness()
    try {
      const first = await ownerReady(h)
      const original = h.owners[0]!
      const second = lifetime()
      await h.service.pause()
      first.valid = false
      await h.service.quiesce(first)
      const draining = h.service.awaitDrained(first)
      void draining.catch(() => undefined)
      await eventually(
        async () => original.calls,
        (calls) => calls.includes('actual-drain'),
      )
      if (oldAckFirst) {
        original.drained.resolve()
        await draining
      }
      await expect(h.service.start(second)).rejects.toThrow('maintenance execution start paused')
      await expect(h.service.resume()).rejects.toThrow(
        'maintenance execution lifetime is not current',
      )
      expect(original.calls).not.toContain('resume')
      expect(() => h.service.runSoon('backupPrune')).toThrow('maintenance execution is not ready')
      const next = h.service.start(second)
      void next.catch(() => undefined)
      if (!oldAckFirst) {
        expect(h.owners).toHaveLength(1)
        expect(h.inputs).toEqual([])
        original.drained.resolve()
        await draining
      }
      await eventually(
        async () => h.owners.length,
        (count) => count === 2,
      )
      expect(() => h.service.runSoon('backupPrune')).toThrow('maintenance execution is not ready')
      h.owners[1]!.ready.resolve()
      await next
      expect(h.service.status().worker.state).toBe('ready')
      expect(original.calls).not.toContain('resume')
    } finally {
      await h.finish()
    }
  }
})
