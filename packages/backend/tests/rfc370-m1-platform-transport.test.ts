// RFC-370 M1: framing, request replay and the task-image command wire format.
import { expect, test } from 'bun:test'
import { createCrewStationPlatformApi } from '@/platform/crewstation/platformApi'
import {
  createHostedTokenDeltas,
  createHostedUsageMeter,
  hostedEventRecord,
} from '@/modules/task-execution/infrastructure/crewstation/runtimeEvents'
import {
  workspaceHelperArguments,
  decodeWorkspaceHelperArguments,
  parseWorkspaceHelperOutcome,
  workspaceHelperFailureOf,
  workspaceHelperValue,
  workspaceResultPath,
  WORKSPACE_ARGUMENT_BUDGET_BYTES,
  WORKSPACE_CHUNK_BYTES,
  WORKSPACE_TRANSFER_CHUNK_BYTES,
  WorkspaceCommandFailedError,
  WorkspaceCommandInputTooLargeError,
} from '@/platform/crewstation/workspaceProtocol'
import { DomainError } from '@/util/errors'
import {
  hostedWorkspaceReference,
  joinHostedWorkspaceReference,
  parseHostedWorkspaceReference,
} from '@/modules/source-control/infrastructure/crewstation/workspaceReference'
import { createCrewStationObjectStorage } from '@/platform/crewstation/objectStorage'
import { createHash } from 'node:crypto'

test('SSE accepts split UTF-8 and multiple large frames in one network chunk', async () => {
  const text = '中' + 'a'.repeat(200_000)
  const bytes = new TextEncoder().encode(
    Array.from({ length: 3 }, (_, i) => `id: ${i}\ndata: ${JSON.stringify({ i, text })}\n\n`).join(
      '',
    ),
  )
  const split = bytes.indexOf(0xe4) + 1
  const api = createCrewStationPlatformApi({
    baseUrl: 'http://platform',
    fetch: (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.subarray(0, split))
            controller.enqueue(bytes.subarray(split))
            controller.close()
          },
        }),
      )) as unknown as typeof fetch,
  })
  const result: Array<{ i: number; text: string }> = []
  for await (const event of api.stream<{ i: number; text: string }>('/events', { after: 'cursor' }))
    result.push(event)
  expect(result.map((event) => event.i)).toEqual([0, 1, 2])
  expect(result[0]?.text).toBe(text)
})

test('transient HTTP errors repeat exactly the same mutation body and request key', async () => {
  const bodies: string[] = []
  const api = createCrewStationPlatformApi({
    baseUrl: 'http://platform',
    sleep: async () => undefined,
    fetch: (async (_url, init) => {
      bodies.push(String(init?.body))
      return bodies.length === 1
        ? Response.json({ error: 'busy' }, { status: 503 })
        : Response.json({ id: 'accepted' })
    }) as typeof fetch,
  })
  expect(await api.post('/subtasks', { requestKey: 'one', prompt: 'two' })).toEqual({
    id: 'accepted',
  })
  expect(bodies).toEqual([
    '{"requestKey":"one","prompt":"two"}',
    '{"requestKey":"one","prompt":"two"}',
  ])
})

// RFC-370 acceptance (2026-10-17): a task failed at its second workspace command
// with `409 stale_generation` while the lease was still held — the platform
// refuses fenced calls until each renewal reaches its object-write control.
test('a stale-generation refusal is retried with the same body; a persistent one surfaces; disabled retries stay single', async () => {
  const stale = () =>
    Response.json(
      { error: 'conflict', message: 'stale', details: { code: 'stale_generation' } },
      { status: 409 },
    )
  const bodies: string[] = []
  const api = createCrewStationPlatformApi({
    baseUrl: 'http://platform',
    sleep: async () => undefined,
    fetch: (async (_url, init) => {
      bodies.push(String(init?.body))
      return bodies.length === 1 ? stale() : Response.json({ id: 'accepted' })
    }) as typeof fetch,
  })
  expect(await api.post('/subtasks', { requestKey: 'one', fence: { epoch: 4 } })).toEqual({
    id: 'accepted',
  })
  expect(new Set(bodies)).toEqual(new Set(['{"requestKey":"one","fence":{"epoch":4}}']))
  expect(bodies).toHaveLength(2)

  let calls = 0
  const lost = createCrewStationPlatformApi({
    baseUrl: 'http://platform',
    attempts: 3,
    sleep: async () => undefined,
    fetch: (async (_url, _init) => {
      calls += 1
      return stale()
    }) as typeof fetch,
  })
  await expect(lost.post('/subtasks', { requestKey: 'two' })).rejects.toMatchObject({
    status: 409,
    code: 'stale_generation',
  })
  expect(calls).toBe(3)

  calls = 0
  await expect(lost.post('/claim-next', {}, { retry: false })).rejects.toMatchObject({
    code: 'stale_generation',
  })
  expect(calls).toBe(1)

  // Other conflicts are answers, not transient refusals.
  calls = 0
  const conflict = createCrewStationPlatformApi({
    baseUrl: 'http://platform',
    sleep: async () => undefined,
    fetch: (async (_url, _init) => {
      calls += 1
      return Response.json(
        { error: 'conflict', message: 'changed', details: { code: 'idempotency_conflict' } },
        { status: 409 },
      )
    }) as typeof fetch,
  })
  await expect(conflict.post('/subtasks', { requestKey: 'three' })).rejects.toMatchObject({
    code: 'idempotency_conflict',
  })
  expect(calls).toBe(1)
})

test('SSE window rotation keeps complete events and leaves partial framing for cursor refill', async () => {
  const api = createCrewStationPlatformApi({
    baseUrl: 'http://platform',
    streamWindowMs: 20,
    fetch: (async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"cursor":"c1"}\n\ndata: {"cursor":'),
            )
            init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), {
              once: true,
            })
          },
        }),
      )) as typeof fetch,
  })
  const events: unknown[] = []
  for await (const event of api.stream('/events', {})) events.push(event)
  expect(events).toEqual([{ cursor: 'c1' }])
})

test('real SSE failures and caller aborts still propagate instead of being hidden as rotation', async () => {
  for (const callerAbort of [false, true]) {
    const stop = new AbortController()
    const failure = new Error(callerAbort ? 'caller cancelled' : 'connection reset')
    const api = createCrewStationPlatformApi({
      baseUrl: 'http://platform',
      fetch: (async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              if (callerAbort) stop.abort(failure)
              controller.error(failure)
            },
          }),
        )) as unknown as typeof fetch,
    })
    const iterator = api.stream('/events', {}, stop.signal)[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toThrow(failure.message)
  }
})

test('workspace JSON is argument-safe, chunked and bounded by the container argument budget', () => {
  // RFC-370 §9.2 V2: CS execs argv directly, so argv + env must stay below the
  // task container ARG_MAX (2 MiB, measured in the CS task image).
  const input = { script: 'echo "hello"; $(do-not-execute) `literal`\n中文' + 'a'.repeat(40_000) }
  const resultPath = workspaceResultPath('key')
  expect(resultPath).toBe('/work/.aw/command-results/key.json')
  const argv = workspaceHelperArguments('run-script', input, resultPath)
  expect(argv.slice(0, 2)).toEqual(['agent-workflow', 'workspace'])
  expect(argv.length).toBeGreaterThan(3)
  expect(argv.slice(2).every((chunk) => chunk.length <= WORKSPACE_CHUNK_BYTES)).toBe(true)
  expect(decodeWorkspaceHelperArguments(argv.slice(2))).toEqual({
    version: 2,
    operation: 'run-script',
    input,
    resultPath,
  })
  // The largest transfer chunk still fits the argument budget.
  const transfer = Buffer.alloc(WORKSPACE_TRANSFER_CHUNK_BYTES, 0xff).toString('base64')
  const encoded = workspaceHelperArguments('write-chunk', { bytesBase64: transfer }, resultPath)
    .slice(2)
    .join('')
  expect(encoded.length).toBeLessThanOrEqual(WORKSPACE_ARGUMENT_BUDGET_BYTES)
  let refused: unknown
  try {
    workspaceHelperArguments('large', 'x'.repeat(WORKSPACE_ARGUMENT_BUDGET_BYTES), resultPath)
  } catch (error) {
    refused = error
  }
  expect(refused).toBeInstanceOf(WorkspaceCommandInputTooLargeError)
  expect(refused).toMatchObject({ code: 'hosted-command-input-too-large', status: 413 })
  expect(() => decodeWorkspaceHelperArguments([])).toThrow('command-limit')
  expect(() => decodeWorkspaceHelperArguments(['x'.repeat(WORKSPACE_CHUNK_BYTES + 1)])).toThrow(
    'command-limit',
  )
  const v1 = Buffer.from(JSON.stringify({ version: 1, operation: 'x', input: {} })).toString(
    'base64',
  )
  expect(() => decodeWorkspaceHelperArguments([v1])).toThrow('protocol-invalid')
})

test('workspace outcomes carry the native error code, status and details back', () => {
  expect(workspaceHelperValue(parseWorkspaceHelperOutcome('{"ok":true,"value":7}'))).toBe(7)
  const conflict = workspaceHelperFailureOf(
    new DomainError('git-conflict', 'merge conflict', 409, { paths: ['a'] }),
  )
  expect(conflict).toEqual({
    code: 'git-conflict',
    message: 'merge conflict',
    status: 409,
    details: { paths: ['a'] },
  })
  let thrown: unknown
  try {
    workspaceHelperValue(
      parseWorkspaceHelperOutcome(JSON.stringify({ ok: false, error: conflict })),
    )
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(DomainError)
  expect(thrown).toMatchObject({ code: 'git-conflict', status: 409, details: { paths: ['a'] } })
  const native = workspaceHelperFailureOf(Object.assign(new Error('gone'), { code: 'ENOENT' }))
  expect(native).toEqual({ code: 'ENOENT', message: 'gone' })
  expect(() => workspaceHelperValue({ ok: false, error: native })).toThrow(
    WorkspaceCommandFailedError,
  )
  expect(() => parseWorkspaceHelperOutcome('{"ok":false}')).toThrow('result-invalid')
  expect(() => parseWorkspaceHelperOutcome('null')).toThrow('result-invalid')
})

test('workspace references retain the task-volume owner and reject traversal', () => {
  const root = hostedWorkspaceReference('task:one', '/work/worktrees/task:one')
  expect(parseHostedWorkspaceReference(joinHostedWorkspaceReference(root, 'src/a.ts'))).toEqual({
    taskId: 'task:one',
    path: '/work/worktrees/task:one/src/a.ts',
    relative: 'worktrees/task:one/src/a.ts',
  })
  expect(() => joinHostedWorkspaceReference(root, '../other')).toThrow('path-invalid')
  expect(() => parseHostedWorkspaceReference('/work/file')).toThrow('reference-required')
})

test('normalized usage replaces per-model snapshots and never counts a replay twice', () => {
  const meter = createHostedUsageMeter()
  const event = (id: string, count: number) =>
    JSON.parse(
      hostedEventRecord({
        type: 'usage',
        taskId: 'task',
        subtaskId: 'subtask',
        attempt: 1,
        cursor: id,
        sourceEventId: id,
        occurredAt: new Date(0).toISOString(),
        data: {
          measurementId: id,
          scope: 'main',
          mode: 'cumulative',
          inputTokens: count,
          outputTokens: 4,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          complete: true,
          snapshot: {
            state: 'complete',
            models: [
              {
                model: 'actual',
                input: count,
                output: 4,
                reasoning: 1,
                cacheRead: 0,
                cacheWrite: 0,
              },
            ],
          },
        },
      }).raw,
    ) as Record<string, unknown>
  expect(meter.observe(event('one', 10))).toBe(true)
  expect(meter.observe(event('one', 10))).toBe(false)
  expect(meter.observe(event('two', 12))).toBe(true)
  expect(meter.snapshot().models).toEqual([
    { model: 'actual', input: 12, output: 4, reasoning: 1, cacheRead: 0, cacheWrite: 0 },
  ])
})

test('platform usage snapshots become non-negative token deltas, a replay counts once', () => {
  // RFC-370 §9.2 V1: hosted usage feeds the node's tok_* totals and
  // max_total_tokens; a replacement snapshot that shrinks never subtracts.
  const deltas = createHostedTokenDeltas()
  const usage = (id: string, models: { model: string; input: number; output: number }[]) =>
    JSON.parse(
      hostedEventRecord({
        type: 'usage',
        taskId: 'task',
        subtaskId: 'subtask',
        attempt: 1,
        cursor: id,
        sourceEventId: id,
        occurredAt: new Date(0).toISOString(),
        data: {
          measurementId: id,
          scope: 'main',
          mode: 'cumulative',
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          complete: false,
          snapshot: {
            state: 'partial',
            models: models.map((model) => ({
              ...model,
              reasoning: 0,
              cacheRead: 2,
              cacheWrite: 1,
            })),
          },
        },
      }).raw,
    ) as Record<string, unknown>
  expect(deltas(usage('u1', [{ model: 'a', input: 10, output: 3 }]))).toEqual({
    input: 10,
    output: 3,
    cacheCreate: 1,
    cacheRead: 2,
  })
  // Two models in the next snapshot: the delta is the growth of the totals.
  expect(
    deltas(
      usage('u2', [
        { model: 'a', input: 12, output: 3 },
        { model: 'b', input: 5, output: 1 },
      ]),
    ),
  ).toEqual({ input: 7, output: 1, cacheCreate: 1, cacheRead: 2 })
  // The same measurement replayed is not counted again.
  expect(deltas(usage('u2', [{ model: 'a', input: 99, output: 99 }]))).toBeUndefined()
  // A shrinking snapshot never produces negative growth.
  expect(deltas(usage('u3', [{ model: 'a', input: 1, output: 1 }]))).toBeUndefined()
  // Growth after the shrink is measured from the highest totals seen.
  expect(deltas(usage('u4', [{ model: 'a', input: 20, output: 5 }]))).toEqual({
    input: 3,
    output: 1,
    cacheCreate: 0,
    cacheRead: 0,
  })
})

test('object bytes are committed and digest-checked before pinning their durable reference', async () => {
  const bytes = new TextEncoder().encode('artifact')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const calls: string[] = []
  let uploaded = false
  const objects = createCrewStationObjectStorage({
    baseUrl: 'http://objects/v3/objects',
    fence: {
      current: () => ({ epoch: 1, leaseId: 'lease', instanceId: 'instance' }),
      assertHeld: async () => undefined,
    },
    sleep: async () => undefined,
    fetch: (async (url, init) => {
      const path = new URL(String(url)).pathname
      calls.push(`${init?.method ?? 'GET'} ${path}`)
      if (path.endsWith('/uploads'))
        return Response.json({ id: 'upload', state: 'waiting', objectId: null })
      if (path.endsWith('/uploads/upload/content')) {
        uploaded = true
        return new Response(null, { status: 204 })
      }
      if (path.endsWith('/commit')) {
        expect(uploaded).toBe(true)
        return Response.json({ id: 'upload', state: 'ready', objectId: 'object' })
      }
      if (path.endsWith('/references')) return new Response(null, { status: 204 })
      return Response.json({ id: 'object', revision: 1, size: bytes.byteLength, sha256 })
    }) as typeof fetch,
  })
  expect((await objects.put('runs/task/ports/run/output/item_0.txt', bytes)).sha256).toBe(sha256)
  expect(calls).toEqual([
    'POST /v3/objects/uploads',
    'PUT /v3/objects/uploads/upload/content',
    'POST /v3/objects/uploads/upload/commit',
    'GET /v3/objects/object',
    'PUT /v3/objects/object/references',
  ])
})
