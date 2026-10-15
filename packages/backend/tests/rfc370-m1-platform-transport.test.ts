// RFC-370 M1: framing, request replay and the task-image command wire format.
import { expect, test } from 'bun:test'
import { createCrewStationPlatformApi } from '@/platform/crewstation/platformApi'
import {
  createHostedUsageMeter,
  hostedEventRecord,
} from '@/modules/task-execution/infrastructure/crewstation/runtimeEvents'
import {
  workspaceHelperArguments,
  decodeWorkspaceHelperArguments,
  workspaceHelperResult,
  WORKSPACE_RESULT_PREFIX,
} from '@/platform/crewstation/workspaceProtocol'
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

test('workspace JSON is argument-safe, chunked and bounded before dispatch', () => {
  const input = { script: 'echo "hello"; $(do-not-execute) `literal`\n中文' + 'a'.repeat(40_000) }
  const argv = workspaceHelperArguments('run-script', input)
  expect(argv.slice(0, 2)).toEqual(['agent-workflow', 'workspace'])
  expect(argv.length).toBeGreaterThan(3)
  expect(decodeWorkspaceHelperArguments(argv.slice(2))).toEqual({
    version: 1,
    operation: 'run-script',
    input,
  })
  expect(() => workspaceHelperArguments('large', 'x'.repeat(24_000 * 1020))).toThrow(
    'command-limit',
  )
  expect(
    workspaceHelperResult('script output\n' + WORKSPACE_RESULT_PREFIX + '{"ok":true,"value":7}\n'),
  ).toBe(7)
  expect(() => workspaceHelperResult('partial output')).toThrow('result-missing')
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
