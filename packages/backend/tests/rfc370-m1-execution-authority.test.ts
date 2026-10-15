// RFC-370 M1: lease acquisition protocol, independent expiry and boot ordering.
import { expect, test } from 'bun:test'
import { createCrewStationExecutionAuthority } from '@/modules/system-operations/infrastructure/crewstation/crewStationExecutionAuthority'
import type { HostedExecutionControlRecord } from '@/modules/system-operations/application/ports/hostedExecutionControl'
import type { CrewStationPlatformApi } from '@/platform/crewstation/platformApi'
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
function fixture(options: { expiresMs?: number; handoff?: string; migration?: string } = {}) {
  const calls: { path: string; body?: unknown }[] = []
  const writes: HostedExecutionControlRecord[] = []
  let phase = 'inactive'
  let hangs = false
  const expiry = new Date(Date.now() + (options.expiresMs ?? 60_000)).toISOString()
  const current = () => ({
    epoch: 1,
    phase,
    leaseOwner: instanceId,
    leaseId,
    leaseExpiresAt: expiry,
    ...(options.handoff === undefined ? {} : { operationId: options.handoff }),
    ...(options.migration === undefined ? {} : { migration: { operationId: options.migration } }),
  })
  const platform: CrewStationPlatformApi = {
    async get<T>(path: string): Promise<T> {
      calls.push({ path })
      if (hangs) return new Promise(() => {})
      return current() as T
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      calls.push({ path, body })
      if (path.endsWith('/claim')) phase = 'preparing'
      if (path.endsWith('/activate')) phase = 'active'
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
    renewMs: 10,
    control: {
      read: async () => writes.at(-1) ?? null,
      async write(value) {
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
    expect(f.authority.current().kind).toBe('frozen')
    // The synchronous loss happens before the DB ACK; a microtask flush
    // observes this in-memory persistence stub, without a polling loop.
    await Promise.resolve()
    expect(f.writes.at(-1)?.phase).toBe('frozen')
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
