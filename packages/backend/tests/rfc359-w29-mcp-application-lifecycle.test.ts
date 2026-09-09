import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import type { McpRuntimeTestPersistence } from '@/modules/resource-catalog/application/mcps/runtimeTestPersistence'
import {
  getMcpRuntimeTestService,
  McpRuntimeTestService,
  type McpRuntimeTestDependencies,
} from '@/services/mcpRuntimeTest'

// Real service lifecycle with controlled persistence protocol replies. No database,
// runtime driver, MCP process, network, configuration file or lease is opened.
const services: McpRuntimeTestService[] = []
const timerSpies: Array<{ mockRestore(): void }> = []

function internal(service: McpRuntimeTestService, name: string, ...args: unknown[]): unknown {
  const method: unknown = Reflect.get(service, name)
  if (typeof method !== 'function') throw new Error(`missing lifecycle method ${name}`)
  return Reflect.apply(method, service, args)
}

afterEach(() => {
  for (const service of services.splice(0)) internal(service, 'clearBackgroundTimers')
  for (const spy of timerSpies.splice(0)) spy.mockRestore()
})

function gate<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function fixture(overrides: Partial<McpRuntimeTestPersistence> = {}) {
  const calls: string[] = []
  const unexpected = (): never => {
    throw new Error('unexpected non-lifecycle dependency')
  }
  const empty = async (name: string) => {
    calls.push(name)
    return []
  }
  const persistence: McpRuntimeTestPersistence = {
    identity: {},
    appendEvent: unexpected,
    loadRuntimeSessionId: unexpected,
    setRootSession: unexpected,
    markRootSessionResetPending: unexpected,
    markCaptureTerminal: unexpected,
    shutdown: async (now, deadline) => {
      calls.push(`shutdown:${now}:${deadline}`)
      return []
    },
    listEndingWithoutInFlight: () => empty('listEndingWithoutInFlight'),
    findCreateReceipt: unexpected,
    create: unexpected,
    findTurnByClientMessage: unexpected,
    acceptMessage: unexpected,
    cancel: unexpected,
    end: unexpected,
    loadSession: unexpected,
    loadTurn: unexpected,
    findLatestSession: unexpected,
    listTurns: unexpected,
    listEvents: unexpected,
    latestEventSequence: unexpected,
    loadBroadcastSnapshot: unexpected,
    invalidateMcp: unexpected,
    invalidateOwner: unexpected,
    markMcpConfigChanged: unexpected,
    markRuntimeProfileChanged: unexpected,
    invalidateRuntime: unexpected,
    assertMcpDeleteReady: unexpected,
    expireIdle: () => empty('expireIdle'),
    listCleanupCandidates: () => empty('listCleanupCandidates'),
    listExpiredReceipts: () => empty('listExpiredReceipts'),
    deleteExpiredReceipt: unexpected,
    listQuarantinedCandidates: () => empty('listQuarantinedCandidates'),
    recoverQuarantined: unexpected,
    expireTurns: async () => {
      calls.push('expireTurns')
      return { settled: [], abort: [] }
    },
    listDurableIntentCandidates: () => empty('listDurableIntentCandidates'),
    settleQueuedDurableIntent: unexpected,
    requestRunningTurnCancel: unexpected,
    clearTerminalDurableIntent: unexpected,
    listBootSessions: () => empty('listBootSessions'),
    recoverBootSession: unexpected,
    admitTurn: unexpected,
    isSpawnAllowed: unexpected,
    recordSpawn: unexpected,
    failBeforeRun: unexpected,
    settleTurn: unexpected,
    invalidateSession: unexpected,
    prepareCleanup: unexpected,
    finishCleanup: unexpected,
    nextDeadline: async () => {
      calls.push('nextDeadline')
      return null
    },
  }
  Object.assign(persistence, overrides)
  const deps: McpRuntimeTestDependencies = {
    persistence,
    leaseOperations: {
      claimNew: unexpected,
      preclaim: unexpected,
      rotate: unexpected,
      release: unexpected,
      repairAfterReap: unexpected,
    },
    loadMcp: unexpected,
    loadRuntime: unexpected,
    configPath: '/unused/w29-mcp.yml',
    appHome: '/unused/w29-mcp-home',
    runFn: unexpected,
    now: () => 100,
    capacity: 1,
    killStaleRunProcessTree: unexpected,
  }
  const service = new McpRuntimeTestService(deps)
  services.push(service)
  return { service, persistence, deps, calls }
}

const START = [
  'listBootSessions',
  'listDurableIntentCandidates',
  'expireTurns',
  'expireIdle',
  'listQuarantinedCandidates',
  'listCleanupCandidates',
  'listExpiredReceipts',
  'nextDeadline',
]
const DRAIN = ['shutdown:100:600100', 'listEndingWithoutInFlight']

function timers() {
  const interval = spyOn(globalThis, 'setInterval')
  const timeout = spyOn(globalThis, 'setTimeout')
  timerSpies.push(interval, timeout)
  return { interval, timeout }
}

function emptyLocalState(service: McpRuntimeTestService) {
  expect(Reflect.get(service, 'idleTimer')).toBeNull()
  expect(Reflect.get(service, 'reconcileTimer')).toBeNull()
  expect(Reflect.get(service, 'queue')).toEqual([])
  expect(Reflect.get(service, 'queued')).toEqual(new Set())
}

describe('RFC359 W29 original MCP lifecycle controls', () => {
  test('constructors do no work and the existing getter keeps its identity cache', () => {
    const { deps, service, calls } = fixture()
    const other = new McpRuntimeTestService(deps)
    services.push(other)
    expect(other).not.toBe(service)
    expect(getMcpRuntimeTestService(deps)).toBe(getMcpRuntimeTestService({ ...deps }))
    expect(getMcpRuntimeTestService(deps)).not.toBe(service)
    expect(calls).toEqual([])
    emptyLocalState(service)
  })

  test('start stays immediate, deduplicated and ordered; stop retains cold start and idempotence', async () => {
    const { service, calls } = fixture()
    const first = service.start()
    expect(calls).toEqual(['listBootSessions'])
    expect(service.start()).toBe(first)
    await first
    expect(calls).toEqual(START)
    await service.stop(0)
    expect(calls).toEqual([...START, ...DRAIN])
    await service.shutdown(1)
    await service.stop(2)
    expect(calls).toEqual([...START, ...DRAIN])
    emptyLocalState(service)
    const cold = fixture()
    await cold.service.stop(0)
    expect(cold.calls).toEqual([...START, ...DRAIN])
  })

  test('the original pause/resume and failed-start retry paths retain their work', async () => {
    const f = fixture()
    const failure = new Error('original startup failure')
    const listBoot = f.persistence.listBootSessions
    f.persistence.listBootSessions = () => Promise.reject(failure)
    await expect(f.service.start()).rejects.toBe(failure)
    expect(Reflect.get(f.service, 'startPromise')).toBeNull()
    f.persistence.listBootSessions = listBoot
    await f.service.start()
    await f.service.pause(0)
    await f.service.resume()
    await f.service.shutdown(0)
    expect(f.calls).toEqual([...START, ...DRAIN, ...START.slice(1), ...DRAIN])
    emptyLocalState(f.service)
  })

  test('the original stop still waits for the tracked turn using its exact requested budget', async () => {
    const admitted = gate<Awaited<ReturnType<McpRuntimeTestPersistence['admitTurn']>>>()
    const f = fixture({
      admitTurn: () => admitted.promise,
      loadSession: async () => null,
      loadBroadcastSnapshot: async () => null,
      shutdown: async () => [{ sessionId: 'session', turnId: 'turn-1' }],
    })
    const clock = timers()
    await f.service.start()
    internal(f.service, 'enqueue', { sessionId: 'session', turnId: 'turn-1' })
    const stopped = f.service.stop(1234)
    try {
      for (let turn = 0; turn < 12 && clock.timeout.mock.calls.length === 0; turn += 1)
        await Promise.resolve()
      expect(clock.timeout.mock.calls.map(([, delay]) => delay)).toEqual([1234])
    } finally {
      admitted.resolve(null)
    }
    await stopped
    expect(Reflect.get(f.service, 'activeWorkers')).toBe(0)
    emptyLocalState(f.service)
  })
})

describe('RFC359 W29 application-owned MCP disposal', () => {
  test('never-started disposal is idempotent with zero work and cannot be restarted', async () => {
    const f = fixture()
    const clock = timers()
    await Promise.all([f.service.dispose(0), f.service.dispose(1)])
    await expect(f.service.start()).rejects.toMatchObject({ code: 'mcp-test-service-disposed' })
    expect(f.calls).toEqual([])
    expect(clock.interval).not.toHaveBeenCalled()
    expect(clock.timeout).not.toHaveBeenCalled()
    emptyLocalState(f.service)
  })

  test('disposing during startup waits for that original attempt and suppresses its timers', async () => {
    const boot = gate<Awaited<ReturnType<McpRuntimeTestPersistence['listBootSessions']>>>()
    const f = fixture({ listBootSessions: () => boot.promise })
    const clock = timers()
    const started = f.service.start()
    let done = false
    const disposed = f.service.dispose(0).then(() => {
      done = true
    })
    try {
      await Promise.resolve()
      expect(done).toBe(false)
      expect(f.calls).toEqual([])
    } finally {
      boot.resolve([])
    }
    await Promise.all([started, disposed])
    expect(f.calls).toEqual([...START.slice(1, -1), ...DRAIN])
    expect(clock.interval).not.toHaveBeenCalled()
    expect(clock.timeout).not.toHaveBeenCalled()
    emptyLocalState(f.service)
  })

  test('synchronous disposal inside the first boot callback sees the assigned startup promise', async () => {
    const boot = gate<Awaited<ReturnType<McpRuntimeTestPersistence['listBootSessions']>>>()
    let disposed: Promise<void> | undefined
    const f = fixture({
      listBootSessions: () => {
        expect(Reflect.get(f.service, 'startPromise')).toBeInstanceOf(Promise)
        disposed = f.service.dispose(0)
        return boot.promise
      },
    })
    const started = f.service.start()
    try {
      expect(disposed).toBeInstanceOf(Promise)
      await Promise.resolve()
      expect(f.calls).toEqual([])
    } finally {
      boot.resolve([])
    }
    await Promise.all([started, disposed])
    expect(f.calls).toEqual([...START.slice(1, -1), ...DRAIN])
    emptyLocalState(f.service)
  })

  test('a failed startup is not retried by disposal and original startup rejection is retained', async () => {
    const failure = new Error('startup failed before dispose')
    let attempts = 0
    const f = fixture({
      listBootSessions: async () => {
        attempts += 1
        throw failure
      },
    })
    await expect(f.service.start()).rejects.toBe(failure)
    await f.service.dispose(0)
    expect(attempts).toBe(1)
    expect(f.calls).toEqual(DRAIN)
    emptyLocalState(f.service)
  })

  test('startup and drain failures both propagate while the closed state is permanent', async () => {
    const boot = gate<Awaited<ReturnType<McpRuntimeTestPersistence['listBootSessions']>>>()
    const first = new Error('pending boot failed')
    const second = new Error('drain failed')
    let shutdowns = 0
    const f = fixture({
      listBootSessions: () => boot.promise,
      shutdown: async () => {
        shutdowns += 1
        throw second
      },
    })
    const started = f.service.start()
    const startResult = started.catch((error: unknown) => error)
    const disposed = f.service.dispose(0)
    const result = disposed.catch((error: unknown) => error)
    boot.reject(first)
    expect(await startResult).toBe(first)
    const error = await result
    expect(error).toBeInstanceOf(AggregateError)
    if (!(error instanceof AggregateError))
      throw new Error('missing aggregated startup/drain failures')
    expect(error.errors).toEqual([first, second])
    await expect(f.service.dispose(1)).rejects.toBe(error)
    await expect(f.service.start()).rejects.toMatchObject({ code: 'mcp-test-service-disposed' })
    expect(shutdowns).toBe(1)
    emptyLocalState(f.service)
  })

  for (const stage of ['startup', 'drain'] as const)
    test(`a sole ${stage} failure propagates unchanged after disposal cleanup`, async () => {
      const boot = gate<Awaited<ReturnType<McpRuntimeTestPersistence['listBootSessions']>>>()
      const failure = new Error(`${stage} failed`)
      const f = fixture({ listBootSessions: () => boot.promise })
      if (stage === 'drain') f.persistence.shutdown = () => Promise.reject(failure)
      const started = f.service.start().catch((error: unknown) => error)
      const disposed = f.service.dispose(0).catch((error: unknown) => error)
      if (stage === 'startup') boot.reject(failure)
      else boot.resolve([])
      await started
      expect(await disposed).toBe(failure)
      await expect(f.service.dispose(1)).rejects.toBe(failure)
      emptyLocalState(f.service)
    })

  test('a late deadline result cannot recreate an idle timer after disposal', async () => {
    const deadline = gate<number | null>()
    const f = fixture({ nextDeadline: () => deadline.promise })
    const clock = timers()
    await f.service.start()
    expect(clock.interval).toHaveBeenCalledTimes(1)
    await f.service.dispose(0)
    deadline.resolve(1_000_000)
    await Promise.resolve()
    expect(clock.timeout).not.toHaveBeenCalled()
    expect(f.calls).toEqual([...START.slice(0, -1), ...DRAIN])
    emptyLocalState(f.service)
  })

  test('the actual queue and pending turn are drained without starting a queued or late turn', async () => {
    const admitted = gate<Awaited<ReturnType<McpRuntimeTestPersistence['admitTurn']>>>()
    const admissions: string[] = []
    const f = fixture({
      admitTurn: (input) => {
        admissions.push(input.turnId)
        return admitted.promise
      },
      loadSession: async () => null,
      loadBroadcastSnapshot: async () => null,
      shutdown: async () => [{ sessionId: 'session', turnId: 'turn-1' }],
    })
    const clock = timers()
    await f.service.start()
    internal(f.service, 'enqueue', { sessionId: 'session', turnId: 'turn-1' })
    internal(f.service, 'enqueue', { sessionId: 'session', turnId: 'turn-2' })
    expect(admissions).toEqual(['turn-1'])
    let done = false
    const disposed = f.service.dispose(1000).then(() => {
      done = true
    })
    try {
      for (let turn = 0; turn < 12 && clock.timeout.mock.calls.length === 0; turn += 1)
        await Promise.resolve()
      expect(clock.timeout.mock.calls.map(([, delay]) => delay)).toEqual([1000])
      expect(done).toBe(false)
      expect(Reflect.get(f.service, 'queue')).toEqual([])
      internal(f.service, 'enqueue', { sessionId: 'session', turnId: 'late-turn' })
    } finally {
      admitted.resolve(null)
    }
    await disposed
    expect(admissions).toEqual(['turn-1'])
    expect(Reflect.get(f.service, 'activeWorkers')).toBe(0)
    expect(Reflect.get(f.service, 'turnPromises')).toEqual(new Map())
    emptyLocalState(f.service)
  })

  test('closing one directly constructed app instance leaves its sibling instance usable', async () => {
    const f = fixture()
    const sibling = new McpRuntimeTestService(f.deps)
    services.push(sibling)
    await f.service.dispose()
    await sibling.start()
    expect(f.calls).toEqual(START)
    await sibling.dispose(0)
    expect(f.calls).toEqual([...START, ...DRAIN])
    emptyLocalState(sibling)
  })
})
