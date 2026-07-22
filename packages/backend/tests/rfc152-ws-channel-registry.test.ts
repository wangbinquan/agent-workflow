// RFC-152 — WS channel registry exhaustion lock + gatedSubscribe pipeline.
//
// Why this file exists: server.ts used to hand-copy six channel branches
// (path regex, hello frame, broadcaster key, and three different auth
// forms). RFC-152 moves them into ws/registry.ts as data. This suite locks:
//   1. the key set is exhaustive (adding/removing a channel must touch it),
//   2. helloName/channelKey pairs are byte-identical to the pre-registry
//      strings (the frame-level suites — ws.test.ts / rfc099-ws-acl-filter /
//      ws-repo-imports / ws-auth-multi-token — depend on them),
//   3. the three auth forms are NOT flattened (D1): upgradeGate exactly on
//      task + memory-distill-jobs, frameGate exactly on tasks-list +
//      workflows + memories, adminShortCircuit exactly on workflows +
//      memories, repo-import bare (token-only),
//   4. pathRe/parse round-trips (incl. task `?since` and %-decoding),
//   5. the gatedSubscribe pipeline: hello first, admin short-circuit is
//      synchronous, gate=false / gate-throw ⇒ frame dropped.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { ServerWebSocket } from 'bun'
import type { Actor } from '../src/auth/actor'
import { createInMemoryDb } from '../src/db/client'
import {
  MEMORY_CHANNEL,
  MEMORY_DISTILL_JOB_CHANNEL,
  REPO_IMPORT_CHANNEL,
  TASK_CHANNEL,
  TASKS_LIST_CHANNEL,
  WORKFLOWS_CHANNEL,
} from '../src/ws/broadcaster'
import {
  WS_CHANNELS,
  WS_CHANNEL_KINDS,
  checkUpgradeGate,
  gatedSubscribe,
  parseWsChannel,
  type AnyChannelParams,
  type WsChannelKind,
  type WsConnectionData,
} from '../src/ws/registry'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function makeActor(role: 'admin' | 'user', id = 'u-test'): Actor {
  return {
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
    permissions: new Set(),
  }
}

/** Minimal ServerWebSocket stand-in — gatedSubscribe only touches data+send. */
function makeFakeWs(actor: Actor): {
  ws: ServerWebSocket<WsConnectionData>
  sent: unknown[]
} {
  const sent: unknown[] = []
  const data: WsConnectionData = {
    channel: { kind: 'tasks-list' },
    actor,
    // RFC-212 — the registry never reads these; they exist so the fixture stays
    // structurally identical to a real connection.
    credential: { kind: 'daemon' },
    closing: false,
    revalidating: false,
    upgradeEpoch: 0,
    unsubscribe: () => {},
    visibilityCache: new Map(),
  }
  const ws = {
    data,
    send(payload: string) {
      sent.push(JSON.parse(payload))
      return payload.length
    },
  } as unknown as ServerWebSocket<WsConnectionData>
  return { ws, sent }
}

const ALL_KINDS: WsChannelKind[] = [
  'task',
  'tasks-list',
  'workflows',
  'repo-import',
  'memories',
  'memory-distill-jobs',
  'scheduled-tasks', // RFC-159
]

describe('RFC-152 — WS_CHANNELS exhaustion lock', () => {
  test('registry keys are exactly the seven channels (and WS_CHANNEL_KINDS mirrors them)', () => {
    expect(Object.keys(WS_CHANNELS).sort()).toEqual([...ALL_KINDS].sort())
    expect([...WS_CHANNEL_KINDS].sort()).toEqual([...ALL_KINDS].sort())
    for (const kind of ALL_KINDS) {
      expect(WS_CHANNELS[kind].kind).toBe(kind)
    }
  })

  test('helloName/channelKey pairs match the pre-registry strings exactly', () => {
    // task
    expect(WS_CHANNELS.task.helloName({ kind: 'task', taskId: 'T1' })).toBe('tasks/T1')
    expect(WS_CHANNELS.task.channelKeyOf({ kind: 'task', taskId: 'T1' })).toBe('task:T1')
    expect(WS_CHANNELS.task.channelKeyOf({ kind: 'task', taskId: 'T1' })).toBe(TASK_CHANNEL('T1'))
    // tasks-list
    expect(WS_CHANNELS['tasks-list'].helloName({ kind: 'tasks-list' })).toBe('tasks')
    expect(WS_CHANNELS['tasks-list'].channelKeyOf({ kind: 'tasks-list' })).toBe(TASKS_LIST_CHANNEL)
    expect(TASKS_LIST_CHANNEL).toBe('tasks-list')
    // workflows
    expect(WS_CHANNELS.workflows.helloName({ kind: 'workflows' })).toBe('workflows')
    expect(WS_CHANNELS.workflows.channelKeyOf({ kind: 'workflows' })).toBe(WORKFLOWS_CHANNEL)
    expect(WORKFLOWS_CHANNEL).toBe('workflows')
    // repo-import
    expect(WS_CHANNELS['repo-import'].helloName({ kind: 'repo-import', batchId: 'B1' })).toBe(
      'repo-imports/B1',
    )
    expect(WS_CHANNELS['repo-import'].channelKeyOf({ kind: 'repo-import', batchId: 'B1' })).toBe(
      REPO_IMPORT_CHANNEL('B1'),
    )
    expect(REPO_IMPORT_CHANNEL('B1')).toBe('repo-import:B1')
    // memories
    expect(WS_CHANNELS.memories.helloName({ kind: 'memories' })).toBe('memories')
    expect(WS_CHANNELS.memories.channelKeyOf({ kind: 'memories' })).toBe(MEMORY_CHANNEL)
    expect(MEMORY_CHANNEL).toBe('memories')
    // memory-distill-jobs
    expect(WS_CHANNELS['memory-distill-jobs'].helloName({ kind: 'memory-distill-jobs' })).toBe(
      'memory-distill-jobs',
    )
    expect(WS_CHANNELS['memory-distill-jobs'].channelKeyOf({ kind: 'memory-distill-jobs' })).toBe(
      MEMORY_DISTILL_JOB_CHANNEL,
    )
    expect(MEMORY_DISTILL_JOB_CHANNEL).toBe('memory-distill-jobs')
  })

  test('the three auth forms are NOT flattened (D1): gates sit exactly where they did', () => {
    // (a) upgrade-time whole-connection gates.
    expect(WS_CHANNELS.task.upgradeGate).toBeDefined()
    expect(WS_CHANNELS['memory-distill-jobs'].upgradeGate).toBeDefined()
    // (b) per-frame gates.
    expect(WS_CHANNELS['tasks-list'].frameGate).toBeDefined()
    expect(WS_CHANNELS.workflows.frameGate).toBeDefined()
    expect(WS_CHANNELS.memories.frameGate).toBeDefined()
    // (c) token-only.
    expect(WS_CHANNELS['repo-import'].upgradeGate).toBeUndefined()
    expect(WS_CHANNELS['repo-import'].frameGate).toBeUndefined()
    // No cross-contamination.
    expect(WS_CHANNELS.task.frameGate).toBeUndefined()
    expect(WS_CHANNELS['memory-distill-jobs'].frameGate).toBeUndefined()
    expect(WS_CHANNELS['tasks-list'].upgradeGate).toBeUndefined()
    expect(WS_CHANNELS.workflows.upgradeGate).toBeUndefined()
    expect(WS_CHANNELS.memories.upgradeGate).toBeUndefined()
    // Admin short-circuit exactly where the old handlers had a sync
    // role==='admin' fast path: workflows + memories. tasks-list stays on
    // the async path (canViewTask short-circuits internally).
    expect(WS_CHANNELS.workflows.adminShortCircuit).toBe(true)
    expect(WS_CHANNELS.memories.adminShortCircuit).toBe(true)
    expect(WS_CHANNELS['tasks-list'].adminShortCircuit).not.toBe(true)
    expect(WS_CHANNELS.task.adminShortCircuit).not.toBe(true)
    expect(WS_CHANNELS['repo-import'].adminShortCircuit).not.toBe(true)
    expect(WS_CHANNELS['memory-distill-jobs'].adminShortCircuit).not.toBe(true)
    // onOpenExtra (replay) only on task.
    expect(WS_CHANNELS.task.onOpenExtra).toBeDefined()
    for (const kind of ALL_KINDS.filter((k) => k !== 'task')) {
      expect(WS_CHANNELS[kind].onOpenExtra).toBeUndefined()
    }
  })

  test('parseWsChannel round-trips every channel path (incl. %-decoding and ?since)', () => {
    const parse = (path: string) => parseWsChannel(new URL(path, 'http://x'))
    expect(parse('/ws/tasks/T1')).toEqual({ kind: 'task', taskId: 'T1' })
    expect(parse('/ws/tasks/T%2F1')).toEqual({ kind: 'task', taskId: 'T/1' })
    expect(parse('/ws/tasks/T1?since=5&token=t')).toEqual({ kind: 'task', taskId: 'T1', since: 5 })
    // non-integer / empty since is ignored (matches the old parseChannel).
    expect(parse('/ws/tasks/T1?since=abc')).toEqual({ kind: 'task', taskId: 'T1' })
    expect(parse('/ws/tasks/T1?since=')).toEqual({ kind: 'task', taskId: 'T1' })
    expect(parse('/ws/tasks')).toEqual({ kind: 'tasks-list' })
    expect(parse('/ws/workflows')).toEqual({ kind: 'workflows' })
    expect(parse('/ws/repo-imports/B%2F1')).toEqual({ kind: 'repo-import', batchId: 'B/1' })
    expect(parse('/ws/memories')).toEqual({ kind: 'memories' })
    expect(parse('/ws/memory-distill-jobs')).toEqual({ kind: 'memory-distill-jobs' })
    // Unknown channels stay null (server maps to 404 ws-unknown-channel).
    expect(parse('/ws/bogus')).toBeNull()
    expect(parse('/ws/tasks/')).toBeNull()
    expect(parse('/ws/repo-imports/a/b')).toBeNull()
  })

  test('every pathRe matches exactly one channel for the sample paths (no overlap)', () => {
    const samples: Array<[string, WsChannelKind]> = [
      ['/ws/tasks/T1', 'task'],
      ['/ws/tasks', 'tasks-list'],
      ['/ws/workflows', 'workflows'],
      ['/ws/repo-imports/B1', 'repo-import'],
      ['/ws/memories', 'memories'],
      ['/ws/memory-distill-jobs', 'memory-distill-jobs'],
    ]
    for (const [path, expected] of samples) {
      const matching = ALL_KINDS.filter((k) => WS_CHANNELS[k].pathRe.test(path))
      expect(matching).toEqual([expected])
    }
  })
})

describe('RFC-152 — upgrade gates (registry semantics == pre-registry branches)', () => {
  test('memory-distill-jobs: non-admin refused with admin-required; admin passes', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const params: AnyChannelParams = { kind: 'memory-distill-jobs' }
    const refusal = await checkUpgradeGate(db, makeActor('user'), params)
    expect(refusal).toEqual({
      code: 'admin-required',
      message: 'memory-distill-jobs channel is admin-only',
    })
    expect(await checkUpgradeGate(db, makeActor('admin'), params)).toBe(true)
  })

  test('task: missing task row refused with task-not-visible (fail closed)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const refusal = await checkUpgradeGate(db, makeActor('user'), {
      kind: 'task',
      taskId: 'no-such-task',
    })
    expect(refusal).toEqual({
      code: 'task-not-visible',
      message: 'task not visible to current actor',
    })
  })

  test('gate-less channels (repo-import / tasks-list / workflows / memories) pass through', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const actor = makeActor('user')
    expect(await checkUpgradeGate(db, actor, { kind: 'repo-import', batchId: 'b' })).toBe(true)
    expect(await checkUpgradeGate(db, actor, { kind: 'tasks-list' })).toBe(true)
    expect(await checkUpgradeGate(db, actor, { kind: 'workflows' })).toBe(true)
    expect(await checkUpgradeGate(db, actor, { kind: 'memories' })).toBe(true)
  })
})

describe('RFC-152 — gatedSubscribe pipeline (admin short-circuit → frameGate → error ⇒ drop)', () => {
  type ProbeMsg = { type: string; n: number }

  /** Build a scratch spec around a hand-rolled broadcaster so the pipeline
   *  can be driven without a real server. */
  function makeProbeSpec(opts: {
    adminShortCircuit?: boolean
    frameGate?: (ctx: unknown, msg: ProbeMsg) => Promise<boolean>
  }) {
    let listener: ((msg: ProbeMsg) => void) | null = null
    let unsubscribed = false
    const spec = {
      kind: 'tasks-list',
      helloName: () => 'probe',
      pathRe: /^never$/,
      parse: () => null,
      broadcaster: {
        subscribe: (_ch: string, l: (msg: ProbeMsg) => void) => {
          listener = l
          return () => {
            unsubscribed = true
          }
        },
      },
      channelKeyOf: () => 'probe-key',
      adminShortCircuit: opts.adminShortCircuit,
      frameGate: opts.frameGate,
    }
    return {
      spec: spec as unknown as (typeof WS_CHANNELS)[WsChannelKind],
      fire: (msg: ProbeMsg) => listener?.(msg),
      wasUnsubscribed: () => unsubscribed,
    }
  }

  const db = createInMemoryDb(MIGRATIONS)
  const flush = () => new Promise((r) => setTimeout(r, 10))

  test('hello frame is sent first; since is echoed when params carry one', () => {
    const { ws, sent } = makeFakeWs(makeActor('user'))
    gatedSubscribe(ws, WS_CHANNELS.task, { kind: 'task', taskId: 'T9', since: 42 }, db)
    expect(sent[0]).toEqual({ type: 'hello', channel: 'tasks/T9', since: 42 })
    const { ws: ws2, sent: sent2 } = makeFakeWs(makeActor('user'))
    gatedSubscribe(ws2, WS_CHANNELS.task, { kind: 'task', taskId: 'T9' }, db)
    expect(sent2[0]).toEqual({ type: 'hello', channel: 'tasks/T9' })
  })

  test('no frameGate ⇒ every frame forwards; unsubscribe is wired onto ws.data', () => {
    const probe = makeProbeSpec({})
    const { ws, sent } = makeFakeWs(makeActor('user'))
    gatedSubscribe(ws, probe.spec, { kind: 'tasks-list' }, db)
    probe.fire({ type: 'x', n: 1 })
    expect(sent).toEqual([
      { type: 'hello', channel: 'probe' },
      { type: 'x', n: 1 },
    ])
    ws.data.unsubscribe()
    expect(probe.wasUnsubscribed()).toBe(true)
  })

  // RFC-212 impl-gate (Codex 2026-07-22): `revalidating` is a synchronous frame
  // short-circuit set for the DURATION of an in-flight revocation rescan, so no
  // frame is delivered under a stale actor while the async pass re-resolves it.
  test('revalidating=true synchronously drops frames; clearing it resumes delivery', () => {
    const probe = makeProbeSpec({})
    const { ws, sent } = makeFakeWs(makeActor('user'))
    gatedSubscribe(ws, probe.spec, { kind: 'tasks-list' }, db)
    expect(sent).toEqual([{ type: 'hello', channel: 'probe' }])
    // Freeze for an in-flight rescan → the frame is dropped (not queued).
    ws.data.revalidating = true
    probe.fire({ type: 'x', n: 1 })
    expect(sent).toEqual([{ type: 'hello', channel: 'probe' }])
    // The pass refreshed the actor and unfroze → delivery resumes.
    ws.data.revalidating = false
    probe.fire({ type: 'x', n: 2 })
    expect(sent).toEqual([
      { type: 'hello', channel: 'probe' },
      { type: 'x', n: 2 },
    ])
  })

  test('adminShortCircuit sends synchronously for admins without consulting the gate', () => {
    let gateCalls = 0
    const probe = makeProbeSpec({
      adminShortCircuit: true,
      frameGate: async () => {
        gateCalls += 1
        return false
      },
    })
    const { ws, sent } = makeFakeWs(makeActor('admin'))
    gatedSubscribe(ws, probe.spec, { kind: 'tasks-list' }, db)
    probe.fire({ type: 'x', n: 1 })
    // Synchronous — visible before any await.
    expect(sent).toEqual([
      { type: 'hello', channel: 'probe' },
      { type: 'x', n: 1 },
    ])
    expect(gateCalls).toBe(0)
  })

  test('frameGate=false drops; frameGate=true sends (non-admin path)', async () => {
    const probe = makeProbeSpec({
      frameGate: async (_ctx, msg) => msg.n % 2 === 0,
    })
    const { ws, sent } = makeFakeWs(makeActor('user'))
    gatedSubscribe(ws, probe.spec, { kind: 'tasks-list' }, db)
    probe.fire({ type: 'x', n: 1 })
    probe.fire({ type: 'x', n: 2 })
    await flush()
    expect(sent).toEqual([
      { type: 'hello', channel: 'probe' },
      { type: 'x', n: 2 },
    ])
  })

  test('throwing frameGate drops the frame without crashing the connection', async () => {
    const probe = makeProbeSpec({
      frameGate: async () => {
        throw new Error('db blip')
      },
    })
    const { ws, sent } = makeFakeWs(makeActor('user'))
    gatedSubscribe(ws, probe.spec, { kind: 'tasks-list' }, db)
    probe.fire({ type: 'x', n: 1 })
    await flush()
    expect(sent).toEqual([{ type: 'hello', channel: 'probe' }])
    // The subscription survives — the next passing frame still arrives.
    const probe2 = makeProbeSpec({ frameGate: async () => true })
    const { ws: ws2, sent: sent2 } = makeFakeWs(makeActor('user'))
    gatedSubscribe(ws2, probe2.spec, { kind: 'tasks-list' }, db)
    probe2.fire({ type: 'ok', n: 3 })
    await flush()
    expect(sent2).toEqual([
      { type: 'hello', channel: 'probe' },
      { type: 'ok', n: 3 },
    ])
  })
})
