// RFC-370 M1: lease acquisition protocol, independent expiry and boot ordering.
// RFC-370 v3 V7 (design/RFC-370-crewstation-hosted-deployment/redesign-v2-20261014.md §9):
// a platform freeze keeps a standby alive as a read-only instance that reports
// the freeze ready (and never crashes when the platform will not accept it from
// this instance), and the platform's renewal is adopted before the database
// mirror, so a slow database write cannot run the held lease out.
import { expect, test } from 'bun:test'
import { createCrewStationExecutionAuthority } from '@/modules/system-operations/infrastructure/crewstation/crewStationExecutionAuthority'
import {
  HostedExecutionControlStaleError,
  type HostedExecutionControlRecord,
} from '@/modules/system-operations/application/ports/hostedExecutionControl'
import {
  CrewStationApiError,
  type CrewStationPlatformApi,
} from '@/platform/crewstation/platformApi'
import { createLogger } from '@/util/log'
import { selectExecutionInitialization } from '@/bootstrap/executionInitialization'
import {
  assertExecutionAvailable,
  bindExecutionAvailability,
} from '@/platform/http/executionAvailability'

const instanceId = '01a0bf5d-8f4b-7100-8000-000000000001'
const leaseId = '01a0bf5d-8f4b-7100-8000-000000000002'
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached')
    await Bun.sleep(2)
  }
}
function fixture(
  options: {
    expiresMs?: number
    handoff?: string
    migration?: string
    renewMs?: number
    now?: () => number
    beforeWrite?: (record: HostedExecutionControlRecord) => Promise<void>
    beforePost?: (path: string) => Promise<void>
  } = {},
) {
  const calls: { path: string; body?: unknown }[] = []
  const writes: HostedExecutionControlRecord[] = []
  const now = options.now ?? Date.now
  let phase = 'inactive'
  let hangs = false
  let migration = options.migration
  let expiry = new Date(now() + (options.expiresMs ?? 60_000)).toISOString()
  const current = () => ({
    epoch: 1,
    phase,
    leaseOwner: instanceId,
    leaseId,
    leaseExpiresAt: expiry,
    ...(options.handoff === undefined ? {} : { operationId: options.handoff }),
    ...(migration === undefined ? {} : { migration: { operationId: migration } }),
  })
  const platform: CrewStationPlatformApi = {
    async get<T>(path: string): Promise<T> {
      calls.push({ path })
      if (hangs) return new Promise(() => {})
      return current() as T
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      await options.beforePost?.(path)
      calls.push({ path, body })
      if (path.endsWith('/claim')) phase = 'preparing'
      if (path.endsWith('/activate')) phase = 'active'
      if (path.endsWith('/renew'))
        expiry = new Date(now() + (options.expiresMs ?? 60_000)).toISOString()
      return current() as T
    },
    async *stream<T>(): AsyncIterable<T> {
      yield* []
      throw new Error('unexpected stream')
    },
  }
  const authority = createCrewStationExecutionAuthority({
    platform,
    instanceId,
    tickMs: 5,
    renewMs: options.renewMs ?? 10,
    now,
    control: {
      read: async () => writes.at(-1) ?? null,
      async write(value) {
        await options.beforeWrite?.(value)
        writes.push(value)
      },
    },
    acceptedTaskContractVersions: ['aw-task-v1'],
    log: createLogger('rfc370-authority-test'),
  })
  return {
    authority,
    calls,
    writes,
    hang: () => {
      hangs = true
    },
    freeze: () => {
      phase = 'frozen'
    },
    migrate: (operationId: string) => {
      migration = operationId
      phase = 'frozen'
    },
    endMigration: () => {
      migration = undefined
      phase = 'inactive'
    },
  }
}

test('preparing and handoff ACK precede activation, followed by one active DB barrier', async () => {
  const f = fixture({ handoff: 'handoff-1' })
  try {
    f.authority.start()
    await f.authority.whenActive()
    expect(f.calls.map((call) => call.path.split('/').at(-1))).toEqual([
      'control',
      'claim',
      'renew',
      'ready',
      'activate',
    ])
    expect(f.writes.map((write) => write.phase)).toEqual(['preparing', 'active'])
    const ready = f.calls.find((call) => call.path.endsWith('/ready'))?.body
    expect(ready).toMatchObject({
      expectedEpoch: 1,
      leaseId,
      instanceId,
      operationId: 'handoff-1',
      acceptedTaskContractVersions: ['aw-task-v1'],
    })
    expect((ready as { preparationDigest: string }).preparationDigest).toMatch(/^[a-f0-9]{64}$/)
  } finally {
    await f.authority.close()
  }
})

test('a hung HTTP renewal cannot keep an expired lease active or cause reacquisition', async () => {
  const f = fixture({ expiresMs: 500 })
  const lost = deferred<void>()
  let losses = 0
  f.authority.onLost(() => {
    losses += 1
    lost.resolve()
  })
  try {
    f.authority.start()
    await f.authority.whenActive()
    f.hang()
    await lost.promise
    expect(f.authority.current().kind).toBe('standby')
    expect(losses).toBe(1)
    expect(f.calls.filter((call) => call.path.endsWith('/claim'))).toHaveLength(1)
  } finally {
    await f.authority.close()
  }
}, 2_000)

test('platform freeze loses authority once and mirrors the database barrier', async () => {
  const f = fixture(),
    lost = deferred<void>()
  f.authority.onLost(() => lost.resolve())
  try {
    f.authority.start()
    await f.authority.whenActive()
    f.freeze()
    await lost.promise
    expect(f.authority.current()).toEqual({
      kind: 'frozen',
      reason: 'execution-frozen-by-platform',
    })
    // The synchronous loss happens before the DB ACK; a microtask flush
    // observes this in-memory persistence stub, without a polling loop.
    await Promise.resolve()
    expect(f.writes.at(-1)?.phase).toBe('frozen')
  } finally {
    await f.authority.close()
  }
})

test('active migration closes admission, drains database writes and ACKs before requesting exit', async () => {
  const draining = deferred<void>(),
    drained = deferred<void>(),
    ready = deferred<void>()
  const acknowledged = deferred<void>(),
    lost = deferred<void>()
  let losses = 0
  const f = fixture({
    beforeWrite: async (record) => {
      if (record.migrationOperationId === undefined) return
      draining.resolve()
      await drained.promise
    },
    beforePost: async (path) => {
      if (!path.includes('/migrations/')) return
      ready.resolve()
      await acknowledged.promise
    },
  })
  f.authority.onLost(() => {
    losses += 1
    lost.resolve()
  })
  try {
    f.authority.start()
    await f.authority.whenActive()
    f.migrate('schema-change')
    await draining.promise
    expect(f.authority.current()).toEqual({
      kind: 'frozen',
      reason: 'database-frozen-by-platform',
    })
    expect(losses).toBe(0)
    expect(f.calls.some((call) => call.path.includes('/migrations/'))).toBe(false)
    drained.resolve()
    await ready.promise
    expect(losses).toBe(0)
    expect(f.writes.at(-1)).toMatchObject({
      phase: 'frozen',
      migrationOperationId: 'schema-change',
    })
    acknowledged.resolve()
    await lost.promise
    expect(losses).toBe(1)
    expect(f.calls.at(-1)?.path).toEndWith('/migrations/schema-change/ready')
    expect(f.calls.filter((call) => call.path.endsWith('/claim'))).toHaveLength(1)
  } finally {
    drained.resolve()
    acknowledged.resolve()
    await f.authority.close()
  }
})

test('a failed migration drain never reports readiness', async () => {
  const lost = deferred<void>()
  const f = fixture({
    beforeWrite: async (record) => {
      if (record.migrationOperationId) throw new Error('database freeze failed')
    },
  })
  f.authority.onLost(() => lost.resolve())
  try {
    f.authority.start()
    await f.authority.whenActive()
    f.migrate('failed-freeze')
    await lost.promise
    expect(f.calls.some((call) => call.path.includes('/migrations/'))).toBe(false)
    expect(f.authority.current().kind).toBe('frozen')
  } finally {
    await f.authority.close()
  }
})

test('a standby the platform will not accept a freeze ACK from stays a read-only standby and asks again', async () => {
  let refusals = 2
  let losses = 0
  const f = fixture({
    migration: 'database-restore-1',
    beforePost: async (path) => {
      if (!path.includes('/migrations/') || refusals === 0) return
      refusals -= 1
      throw new CrewStationApiError(403, 'forbidden', 'not the active release pod', {})
    },
  })
  f.authority.onLost(() => {
    losses += 1
  })
  try {
    f.authority.start()
    await until(() =>
      f.calls.some((call) => call.path.endsWith('/migrations/database-restore-1/ready')),
    )
    // Never a crash, never a claim: the window is closed and the instance waits.
    expect(losses).toBe(0)
    expect(f.calls.some((call) => call.path.endsWith('/claim'))).toBe(false)
    expect(f.authority.current()).toEqual({
      kind: 'frozen',
      reason: 'database-frozen-by-platform',
    })
    expect(f.writes.every((write) => write.phase === 'frozen')).toBe(true)
    expect(f.writes[0]).toMatchObject({ migrationOperationId: 'database-restore-1', owner: null })
    // Once the platform accepted it, the ACK is not repeated on later ticks.
    const ticks = f.calls.filter((call) => call.path.endsWith('/control')).length
    await until(() => f.calls.filter((call) => call.path.endsWith('/control')).length > ticks + 3)
    expect(
      f.calls.filter((call) => call.path.endsWith('/migrations/database-restore-1/ready')),
    ).toHaveLength(1)
    expect(losses).toBe(0)
  } finally {
    await f.authority.close()
  }
})

test('once the platform ends the freeze the next claim takes the lease (and reopens the window)', async () => {
  const f = fixture({ migration: 'migration-2' })
  try {
    f.authority.start()
    await until(() => f.calls.some((call) => call.path.endsWith('/migrations/migration-2/ready')))
    f.endMigration()
    await f.authority.whenActive()
    const after = f.writes.slice(f.writes.findIndex((write) => write.phase !== 'frozen'))
    expect(after.map((write) => write.phase)).toEqual(['preparing', 'active'])
    // A claim record carries no migration: the store reopens the window with it.
    expect(after.every((write) => write.migrationOperationId === undefined)).toBe(true)
    expect(f.authority.current().kind).toBe('active')
  } finally {
    await f.authority.close()
  }
})

test('the platform renewal is adopted before the database mirror, so a slow mirror write cannot run the lease out', async () => {
  let clock = 1_000_000
  const renewalWrite = deferred<void>(),
    renewalWriteStarted = deferred<void>()
  let actives = 0
  let losses = 0
  const f = fixture({
    now: () => clock,
    expiresMs: 30_000,
    renewMs: 10_000,
    beforeWrite: async (record) => {
      if (record.phase !== 'active') return
      actives += 1
      if (actives === 1) return
      renewalWriteStarted.resolve()
      await renewalWrite.promise
    },
  })
  f.authority.onLost(() => {
    losses += 1
  })
  try {
    f.authority.start()
    await f.authority.whenActive()
    // The activation expiry is clock + 30s; the first renewal is due after 10s.
    clock += 10_000
    await renewalWriteStarted.promise
    // Past the activation expiry, before the renewed one: still active while
    // the database mirror is still writing.
    clock += 25_000
    expect(f.authority.current().kind).toBe('active')
    expect(losses).toBe(0)
    renewalWrite.resolve()
  } finally {
    renewalWrite.resolve()
    await f.authority.close()
  }
})

test('a rate-limited or timed-out renewal keeps the lease and retries before its deadline', async () => {
  // Locks the review fix: every 4xx used to read as "the platform refused
  // this lease", so one 429 after the client's own retries froze the instance.
  let refusals = 0
  let losses = 0
  const f = fixture({
    beforePost: async (path) => {
      if (!path.endsWith('/renew') || refusals >= 2) return
      refusals += 1
      throw new CrewStationApiError(refusals === 1 ? 429 : 408, 'busy', 'try again', {})
    },
  })
  f.authority.onLost(() => {
    losses += 1
  })
  try {
    f.authority.start()
    await f.authority.whenActive()
    await until(() => f.calls.filter((call) => call.path.endsWith('/renew')).length >= 1)
    await until(() => refusals === 2 && f.writes.filter((w) => w.phase === 'active').length >= 2)
    expect(losses).toBe(0)
    expect(f.authority.current().kind).toBe('active')
  } finally {
    await f.authority.close()
  }
})

test('a renewal the application database refuses (a newer holder recorded) loses the lease', async () => {
  let actives = 0
  const lost = deferred<void>()
  const f = fixture({
    beforeWrite: async (record) => {
      if (record.phase !== 'active') return
      actives += 1
      if (actives > 1) throw new HostedExecutionControlStaleError(2, 1)
    },
  })
  f.authority.onLost(() => lost.resolve())
  try {
    f.authority.start()
    await f.authority.whenActive()
    await lost.promise
    expect(f.authority.current()).toEqual({
      kind: 'frozen',
      reason: 'execution-frozen-by-platform',
    })
  } finally {
    await f.authority.close()
  }
})

test('HTTP boot registration returns before recovery, business activation waits for recovery', async () => {
  const f = fixture(),
    recovery = deferred<void>()
  const selected = selectExecutionInitialization(f.authority)
  try {
    await selected.initialize(() => recovery.promise)
    await f.authority.whenActive()
    expect(selected.authority.current()).toEqual({
      kind: 'standby',
      reason: 'execution-recovery-in-progress',
    })
    recovery.resolve()
    await selected.authority.whenActive()
    expect(selected.authority.current().kind).toBe('active')
    await expect(selected.initialize(async () => undefined)).rejects.toThrow('already-registered')
  } finally {
    await selected.authority.close()
  }
})

test('recovery failure freezes admission and requests process exit through the loss callback', async () => {
  const f = fixture(),
    selected = selectExecutionInitialization(f.authority),
    lost = deferred<void>()
  selected.authority.onLost(() => lost.resolve())
  try {
    await selected.initialize(async () => {
      throw new Error('unacknowledged result')
    })
    await lost.promise
    expect(selected.authority.current()).toEqual({
      kind: 'frozen',
      reason: 'execution-initialization-failed: unacknowledged result',
    })
  } finally {
    await selected.authority.close()
  }
})

test('M1 rejects unavailable groups even after task execution becomes active', () => {
  const app = {}
  bindExecutionAvailability(app, () => ({
    mode: 'crewstation',
    state: 'active',
    reason: null,
    unavailableGroups: { diagnostics: 'Diagnostics require M2' },
  }))
  expect(() => assertExecutionAvailable(app, 'task')).not.toThrow()
  expect(() => assertExecutionAvailable(app, 'diagnostics')).toThrow('Diagnostics require M2')
  expect(() => assertExecutionAvailable(app, undefined)).not.toThrow()
})
