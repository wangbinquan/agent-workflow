// RFC-370 §9.2 V4 — CrewStation recovery intake for the two parent-level
// actions AW declares. Claims are bound to this adapter and the current
// execution lease; every platform mutation reuses the request's own key.
import { expect, test } from 'bun:test'
import {
  createCrewStationRecoveryApi,
  type CrewStationRecoveryTarget,
} from '@/platform/crewstation/recovery'
import {
  createCrewStationPlatformApi,
  type CrewStationPlatformApi,
} from '@/platform/crewstation/platformApi'

const id = (suffix: string) => `01a13e6d-3e00-7000-9e3c-${suffix.padStart(12, '0')}`
const base = { taskId: id('1'), expectedGeneration: 4, materialDigest: 'a'.repeat(64) }
const targets: CrewStationRecoveryTarget[] = [
  { ...base, action: 'resume-task', volumeUid: 'volume-uid' },
  { ...base, action: 'rebuild-workspace', volumeUid: 'volume-uid' },
]
function fixture(target: CrewStationRecoveryTarget = targets[0]!) {
  let now = 1000
  let fence = { epoch: 3, leaseId: id('3'), instanceId: id('4') }
  const request = {
    id: id('5'),
    projectId: id('6'),
    serviceId: id('7'),
    requestedBy: id('8'),
    requestKey: 'user-request',
    target: structuredClone(target),
    assessmentDigest: 'b'.repeat(64),
    state: 'claimed',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }
  const claimed = { request, claimId: id('9'), expiresAt: new Date(5000).toISOString() }
  const calls: { path: string; body: unknown; options?: { readonly retry: false } }[] = []
  let result: unknown = {
    operationId: id('13'),
    taskId: base.taskId,
    state: 'pending',
    message: 'accepted',
  }
  let rejectionState = 'rejected'
  const api: CrewStationPlatformApi = {
    async get() {
      throw new Error('unexpected GET')
    },
    async post<T>(path: string, body: unknown, options?: { readonly retry: false }): Promise<T> {
      calls.push({ path, body, ...(options ? { options } : {}) })
      if (path.endsWith('/claim')) return structuredClone(claimed) as T
      if (path.endsWith('/read')) return structuredClone(request) as T
      if (path.endsWith('/reject'))
        return { ...structuredClone(request), state: rejectionState } as T
      return structuredClone(result) as T
    },
    stream() {
      throw new Error('unexpected stream')
    },
  }
  const client = createCrewStationRecoveryApi({
    api,
    fence: { current: () => fence },
    now: () => now,
  })
  return {
    client,
    calls,
    request,
    claimed,
    fence: () => fence,
    time: (value: number) => {
      now = value
    },
    rotate: () => {
      fence = { epoch: 4, leaseId: id('14'), instanceId: id('15') }
    },
    result: (value: unknown) => {
      result = value
    },
    rejectionState: (value: string) => {
      rejectionState = value
    },
  }
}

for (const target of targets)
  test(`recovery ${target.action} uses the original request key and current claim`, async () => {
    const f = fixture(target)
    const claim = (await f.client.claim())!
    expect(f.calls[0]?.options).toEqual({ retry: false })
    const receipt = await f.client.execute(claim)
    await f.client.execute(claim)
    expect(f.calls[2]).toEqual(f.calls[1])
    const submitted = f.calls[1]!
    expect(submitted.body).toMatchObject({
      requestKey: `recovery:${f.request.id}`,
      fence: f.fence(),
      recovery: { recoveryRequestId: f.request.id, claimId: f.claimed.claimId },
    })
    expect(JSON.stringify(submitted.body)).not.toContain('materialDigest')
    expect(submitted.path).toBe(
      `/v3/business-tasks/${target.taskId}/${target.action === 'resume-task' ? 'resume' : 'rebuild'}`,
    )
    expect(submitted.body).toMatchObject({ expectedGeneration: 4 })
    expect(receipt).toEqual({
      kind: 'operation',
      operationId: id('13'),
      taskId: base.taskId,
      state: 'pending',
    })
  })

test('an undeclared action is readable so it can be rejected, but never executed', async () => {
  for (const action of ['restart-task', 'retry-subtask']) {
    const f = fixture({ ...base, action })
    Object.assign(f.request.target, { subtaskId: id('2'), expectedAttempt: 3 })
    const claim = (await f.client.claim())!
    expect(claim.request.target.action).toBe(action)
    await expect(f.client.execute(claim)).rejects.toThrow('hosted-recovery-action-not-declared')
    expect((await f.client.reject(claim, 'recovery-action-not-supported')).state).toBe('rejected')
    expect(f.calls.map((call) => call.path.split('/').at(-1))).toEqual(['claim', 'reject'])
  }
})

test('an operation already recorded as running is replayed through the same platform mutation', async () => {
  const f = fixture()
  Object.assign(f.request, { state: 'running', operationId: id('13') })
  const claim = (await f.client.claim(f.request.id))!
  await f.client.execute(claim)
  expect(f.calls[1]?.path).toEndWith('/resume')
  await expect(f.client.reject(claim, 'do not overwrite a running result')).rejects.toThrow(
    'already-running',
  )
  expect(f.calls).toHaveLength(2)
})

test('claim expiry and lease rotation require a new claim before any mutation', async () => {
  const f = fixture()
  const claim = (await f.client.claim())!
  f.time(5000)
  await expect(f.client.execute(claim)).rejects.toThrow('claim-expired')
  f.time(1000)
  f.rotate()
  await expect(f.client.execute(claim)).rejects.toThrow('claim-expired')
  expect(f.calls).toHaveLength(1)
  f.claimed.claimId = id('16')
  await f.client.execute((await f.client.claim(f.request.id))!)
  expect(f.calls[2]?.body).toMatchObject({
    requestKey: `recovery:${f.request.id}`,
    fence: f.fence(),
    recovery: { claimId: id('16') },
  })
})

test('foreign handles and mismatched request identity are rejected; unknown fields are ignored', async () => {
  const a = fixture(),
    b = fixture()
  const claim = (await a.client.claim())!
  await expect(b.client.execute(claim)).rejects.toThrow('claim-not-owned')
  expect(b.calls).toHaveLength(0)
  await expect(a.client.execute({ ...claim, request: { ...claim.request } })).rejects.toThrow(
    'claim-not-owned',
  )
  await expect(a.client.claim(id('99'))).rejects.toThrow('request-identity-mismatch')
  // A newer platform adding fields must not make every claim fail.
  Object.assign(b.request.target, { futureField: 'ignored' })
  Object.assign(b.request, { futureEnvelopeField: true })
  const lenient = (await b.client.claim())!
  expect(lenient.request.target).not.toHaveProperty('futureField')
  expect(lenient.request).not.toHaveProperty('futureEnvelopeField')
})

test('recovery read keeps lease credentials out of query strings, rejection is single-attempt and audited by the platform', async () => {
  const f = fixture()
  expect((await f.client.read(f.request.id)).id).toBe(f.request.id)
  expect(f.calls[0]).toEqual({
    path: `/v3/business-execution/recovery/${f.request.id}/read`,
    body: { fence: f.fence() },
  })
  const claim = (await f.client.claim())!
  expect((await f.client.reject(claim, '  AW task permission denied  ')).state).toBe('rejected')
  expect(f.calls[2]).toMatchObject({
    options: { retry: false },
    body: { reason: 'AW task permission denied', claimId: f.claimed.claimId },
  })
})

test('a platform receipt cannot redirect recovery to another parent', async () => {
  const parent = fixture()
  parent.result({ operationId: id('13'), taskId: id('99'), state: 'pending' })
  await expect(parent.client.execute((await parent.client.claim())!)).rejects.toThrow(
    'task-identity-mismatch',
  )
})

test('an unconfirmed rejection is not reported as a completed business decision', async () => {
  const f = fixture()
  f.rejectionState('claimed')
  await expect(f.client.reject((await f.client.claim())!, 'AW permission denied')).rejects.toThrow(
    'rejection-not-confirmed',
  )
  expect(f.calls).toHaveLength(2)
})

for (const outcome of ['transport', 'unavailable', 'quota'] as const)
  test(`claim-next never automatically retries a ${outcome} failure`, async () => {
    let calls = 0
    const api = createCrewStationPlatformApi({
      baseUrl: 'http://platform.invalid',
      attempts: 5,
      fetch: (async () => {
        calls++
        if (outcome === 'transport') throw new Error('lost reply')
        return new Response(JSON.stringify({ error: 'unavailable', message: 'retry later' }), {
          status: outcome === 'quota' ? 429 : 503,
        })
      }) as unknown as typeof fetch,
      sleep: async () => {
        throw new Error('unexpected transport retry')
      },
    })
    const client = createCrewStationRecoveryApi({
      api,
      fence: { current: () => ({ epoch: 1, leaseId: id('3'), instanceId: id('4') }) },
    })
    await expect(client.claim()).rejects.toThrow()
    expect(calls).toBe(1)
  })
