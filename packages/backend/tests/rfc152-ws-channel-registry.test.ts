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
//      workflows + memories, aclBypassShortCircuit exactly on workflows +
//      memories, repo-import bare (token-only),
//   4. pathRe/parse round-trips (incl. task `?since` and %-decoding),
//   5. the gatedSubscribe pipeline: hello first, ACL-bypass short-circuit is
//      synchronous, gate=false / gate-throw ⇒ frame dropped.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb } from '../src/db/client'
import {
  AUTHORITY_CHANNEL,
  MEMORY_CHANNEL,
  MEMORY_DISTILL_JOB_CHANNEL,
  MCP_RUNTIME_TESTS_CHANNEL,
  mcpRuntimeTestsBroadcaster,
  REPO_IMPORT_CHANNEL,
  SCHEDULED_TASK_CHANNEL,
  TASK_CHANNEL,
  TASKS_LIST_CHANNEL,
  WORKGROUPS_CHANNEL,
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

// RFC-222: build a REALISTIC actor (permissions resolved from the role
// baseline) — the memory-distill-jobs gate is now a double-check (identity AND
// memory:approve), so an empty permission set no longer reflects a real admin.
function makeActor(role: 'admin' | 'user' | 'manager', id = 'u-test'): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
  })
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
  'authority',
  'task',
  'tasks-list',
  'workflows',
  'workgroups',
  'repo-import',
  'memories',
  'memory-distill-jobs',
  'scheduled-tasks', // RFC-159
  'intent-sessions', // RFC-234
  'mcp-runtime-tests', // RFC-238
  'presence', // RFC-312
]

describe('RFC-152 — WS_CHANNELS exhaustion lock', () => {
  test('registry keys are exactly the twelve channels (and WS_CHANNEL_KINDS mirrors them)', () => {
    expect(Object.keys(WS_CHANNELS).sort()).toEqual([...ALL_KINDS].sort())
    expect([...WS_CHANNEL_KINDS].sort()).toEqual([...ALL_KINDS].sort())
    for (const kind of ALL_KINDS) {
      expect(WS_CHANNELS[kind].kind).toBe(kind)
    }
  })

  test('helloName/channelKey pairs match the pre-registry strings exactly', () => {
    expect(WS_CHANNELS.authority.helloName({ kind: 'authority' })).toBe('authority')
    expect(WS_CHANNELS.authority.channelKeyOf({ kind: 'authority' })).toBe(AUTHORITY_CHANNEL)
    expect(AUTHORITY_CHANNEL).toBe('authority')
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
    // workgroups
    expect(WS_CHANNELS.workgroups.helloName({ kind: 'workgroups' })).toBe('workgroups')
    expect(WS_CHANNELS.workgroups.channelKeyOf({ kind: 'workgroups' })).toBe(WORKGROUPS_CHANNEL)
    expect(WORKGROUPS_CHANNEL).toBe('workgroups')
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
    // scheduled-tasks
    expect(WS_CHANNELS['scheduled-tasks'].helloName({ kind: 'scheduled-tasks' })).toBe(
      'scheduled-tasks',
    )
    expect(WS_CHANNELS['scheduled-tasks'].channelKeyOf({ kind: 'scheduled-tasks' })).toBe(
      SCHEDULED_TASK_CHANNEL,
    )
    expect(SCHEDULED_TASK_CHANNEL).toBe('scheduled-tasks')
    // MCP runtime tests
    expect(WS_CHANNELS['mcp-runtime-tests'].helloName({ kind: 'mcp-runtime-tests' })).toBe(
      'mcp-runtime-tests',
    )
    expect(WS_CHANNELS['mcp-runtime-tests'].channelKeyOf({ kind: 'mcp-runtime-tests' })).toBe(
      MCP_RUNTIME_TESTS_CHANNEL,
    )
    expect(MCP_RUNTIME_TESTS_CHANNEL).toBe('mcp-runtime-tests')
  })

  test('the three auth forms are NOT flattened (D1): gates sit exactly where they did', () => {
    // (a) upgrade-time whole-connection gates.
    expect(WS_CHANNELS.task.upgradeGate).toBeDefined()
    expect(WS_CHANNELS['memory-distill-jobs'].upgradeGate).toBeDefined()
    // (b) per-frame gates.
    expect(WS_CHANNELS['tasks-list'].frameGate).toBeDefined()
    expect(WS_CHANNELS.workflows.frameGate).toBeDefined()
    expect(WS_CHANNELS.workgroups.frameGate).toBeDefined()
    expect(WS_CHANNELS.memories.frameGate).toBeDefined()
    expect(WS_CHANNELS['scheduled-tasks'].frameGate).toBeDefined()
    expect(WS_CHANNELS['intent-sessions'].frameGate).toBeDefined()
    expect(WS_CHANNELS['mcp-runtime-tests'].frameGate).toBeDefined()
    // (c) repo-import：RFC-285 B6② 关闭 RFC-152 D4 缺口——升级门（发起者 ∨
    // 资源管理员）就位，仍无 frameGate（帧面全通，门在升级时一次判定）。
    expect(WS_CHANNELS['repo-import'].upgradeGate).toBeDefined()
    expect(WS_CHANNELS['repo-import'].frameGate).toBeUndefined()
    // No cross-contamination.
    expect(WS_CHANNELS.task.frameGate).toBeUndefined()
    expect(WS_CHANNELS['memory-distill-jobs'].frameGate).toBeUndefined()
    expect(WS_CHANNELS['tasks-list'].upgradeGate).toBeUndefined()
    expect(WS_CHANNELS.workflows.upgradeGate).toBeUndefined()
    expect(WS_CHANNELS.workgroups.upgradeGate).toBeUndefined()
    expect(WS_CHANNELS.memories.upgradeGate).toBeUndefined()
    expect(WS_CHANNELS.authority.upgradeGate).toBeUndefined()
    // ACL-bypass short-circuit exactly on workflows + workgroups + memories. tasks-list stays on
    // the async path (canViewTask short-circuits internally).
    expect(WS_CHANNELS.workflows.aclBypassShortCircuit).toBe(true)
    expect(WS_CHANNELS.workgroups.aclBypassShortCircuit).toBe(true)
    expect(WS_CHANNELS.memories.aclBypassShortCircuit).toBe(true)
    expect(WS_CHANNELS['tasks-list'].aclBypassShortCircuit).not.toBe(true)
    expect(WS_CHANNELS.task.aclBypassShortCircuit).not.toBe(true)
    expect(WS_CHANNELS['repo-import'].aclBypassShortCircuit).not.toBe(true)
    expect(WS_CHANNELS['memory-distill-jobs'].aclBypassShortCircuit).not.toBe(true)
    expect(WS_CHANNELS['scheduled-tasks'].aclBypassShortCircuit).not.toBe(true)
    expect(WS_CHANNELS['intent-sessions'].aclBypassShortCircuit).not.toBe(true)
    expect(WS_CHANNELS['mcp-runtime-tests'].aclBypassShortCircuit).not.toBe(true)
    expect(WS_CHANNELS.authority.aclBypassShortCircuit).not.toBe(true)
    // onOpenExtra: task 的 `?since` 重放；RFC-312 起 presence 也有一个——
    // 连接建立即点对点发一次全量在线快照（不是重放，但同属"open 时的额外一步"）。
    // 这条锁的意义是"谁有 open 钩子"必须显式登记，新增通道不得默默带上一个。
    expect(WS_CHANNELS.task.onOpenExtra).toBeDefined()
    expect(WS_CHANNELS.presence.onOpenExtra).toBeDefined()
    for (const kind of ALL_KINDS.filter((k) => k !== 'task' && k !== 'presence')) {
      expect(WS_CHANNELS[kind].onOpenExtra).toBeUndefined()
    }
  })

  test('parseWsChannel round-trips every channel path (incl. %-decoding and ?since)', () => {
    const parse = (path: string) => parseWsChannel(new URL(path, 'http://x'))
    expect(parse('/ws/authority')).toEqual({ kind: 'authority' })
    expect(parse('/ws/tasks/T1')).toEqual({ kind: 'task', taskId: 'T1' })
    expect(parse('/ws/tasks/T%2F1')).toEqual({ kind: 'task', taskId: 'T/1' })
    expect(parse('/ws/tasks/T1?since=5&token=t')).toEqual({ kind: 'task', taskId: 'T1', since: 5 })
    // non-integer / empty since is ignored (matches the old parseChannel).
    expect(parse('/ws/tasks/T1?since=abc')).toEqual({ kind: 'task', taskId: 'T1' })
    expect(parse('/ws/tasks/T1?since=')).toEqual({ kind: 'task', taskId: 'T1' })
    expect(parse('/ws/tasks')).toEqual({ kind: 'tasks-list' })
    expect(parse('/ws/workflows')).toEqual({ kind: 'workflows' })
    expect(parse('/ws/workgroups')).toEqual({ kind: 'workgroups' })
    expect(parse('/ws/repo-imports/B%2F1')).toEqual({ kind: 'repo-import', batchId: 'B/1' })
    expect(parse('/ws/memories')).toEqual({ kind: 'memories' })
    expect(parse('/ws/memory-distill-jobs')).toEqual({ kind: 'memory-distill-jobs' })
    expect(parse('/ws/scheduled-tasks')).toEqual({ kind: 'scheduled-tasks' })
    expect(parse('/ws/intent-sessions')).toEqual({ kind: 'intent-sessions' })
    expect(parse('/ws/mcp-runtime-tests')).toEqual({ kind: 'mcp-runtime-tests' })
    // Unknown channels stay null (server maps to 404 ws-unknown-channel).
    expect(parse('/ws/bogus')).toBeNull()
    expect(parse('/ws/tasks/')).toBeNull()
    expect(parse('/ws/repo-imports/a/b')).toBeNull()
  })

  test('every pathRe matches exactly one channel for the sample paths (no overlap)', () => {
    const samples: Array<[string, WsChannelKind]> = [
      ['/ws/authority', 'authority'],
      ['/ws/tasks/T1', 'task'],
      ['/ws/tasks', 'tasks-list'],
      ['/ws/workflows', 'workflows'],
      ['/ws/workgroups', 'workgroups'],
      ['/ws/repo-imports/B1', 'repo-import'],
      ['/ws/memories', 'memories'],
      ['/ws/memory-distill-jobs', 'memory-distill-jobs'],
      ['/ws/scheduled-tasks', 'scheduled-tasks'],
      ['/ws/intent-sessions', 'intent-sessions'],
      ['/ws/mcp-runtime-tests', 'mcp-runtime-tests'],
    ]
    for (const [path, expected] of samples) {
      const matching = ALL_KINDS.filter((k) => WS_CHANNELS[k].pathRe.test(path))
      expect(matching).toEqual([expected])
    }
  })
})

describe('RFC-152 — upgrade gates', () => {
  test('memory-distill-jobs checks effective capabilities, not the account role', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const params: AnyChannelParams = { kind: 'memory-distill-jobs' }
    const refusal = await checkUpgradeGate(db, makeActor('user'), params)
    expect(refusal).toEqual({
      code: 'permission-required',
      message: 'memory-distill-jobs channel requires memory-distill-jobs:manage',
    })
    expect(await checkUpgradeGate(db, makeActor('admin'), params)).toBe(true)
    // The manager preset currently includes both required points.
    expect(await checkUpgradeGate(db, makeActor('manager'), params)).toBe(true)
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

  test('channels without upgrade gates pass through upgrade checks', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const actor = makeActor('user')
    // RFC-285 B6②：repo-import 不再免门——缺行/非发起者同形拒绝（batch-not-found）。
    expect(await checkUpgradeGate(db, actor, { kind: 'repo-import', batchId: 'b' })).toMatchObject({
      code: 'batch-not-found',
    })
    expect(await checkUpgradeGate(db, actor, { kind: 'tasks-list' })).toBe(true)
    expect(await checkUpgradeGate(db, actor, { kind: 'workflows' })).toBe(true)
    expect(await checkUpgradeGate(db, actor, { kind: 'workgroups' })).toBe(true)
    expect(await checkUpgradeGate(db, actor, { kind: 'memories' })).toBe(true)
    expect(await checkUpgradeGate(db, actor, { kind: 'scheduled-tasks' })).toBe(true)
    expect(await checkUpgradeGate(db, actor, { kind: 'intent-sessions' })).toBe(true)
    expect(await checkUpgradeGate(db, actor, { kind: 'mcp-runtime-tests' })).toBe(true)
    expect(await checkUpgradeGate(db, actor, { kind: 'authority' })).toBe(true)
  })
})

describe('RFC-152 — gatedSubscribe pipeline (ACL-bypass shortcut → frameGate → error ⇒ drop)', () => {
  type ProbeMsg = { type: string; n: number }

  /** Build a scratch spec around a hand-rolled broadcaster so the pipeline
   *  can be driven without a real server. */
  function makeProbeSpec(opts: {
    aclBypassShortCircuit?: boolean
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
      aclBypassShortCircuit: opts.aclBypassShortCircuit,
      frameGate: opts.frameGate,
    }
    return {
      spec: spec as unknown as (typeof WS_CHANNELS)[WsChannelKind],
      fire: (msg: ProbeMsg) => listener?.(msg),
      wasUnsubscribed: () => unsubscribed,
    }
  }

  const db = createInMemoryDb(MIGRATIONS)
  db.$client.exec(`
    INSERT INTO users (
      id, username, email, display_name, password_hash, role, status,
      force_password_change, created_by, created_at, updated_at,
      last_login_at, schema_version, access_revision
    ) VALUES
      ('u-test', 'u-test', NULL, 'u-test', NULL, 'user', 'active', 0, NULL, 0, 0, NULL, 1, 0),
      ('owner-1', 'owner-1', NULL, 'owner-1', NULL, 'user', 'active', 0, NULL, 0, 0, NULL, 1, 0),
      ('stranger-1', 'stranger-1', NULL, 'stranger-1', NULL, 'user', 'active', 0, NULL, 0, 0, NULL, 1, 0),
      ('admin-1', 'admin-1', NULL, 'admin-1', NULL, 'admin', 'active', 0, NULL, 0, 0, NULL, 1, 0);
  `)
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

  test('RFC-305 DB revision fence drops a frame even when the change notification was lost', () => {
    const probe = makeProbeSpec({})
    const { ws, sent } = makeFakeWs(makeActor('user'))
    gatedSubscribe(ws, probe.spec, { kind: 'tasks-list' }, db)
    db.$client.query("UPDATE users SET access_revision = 1 WHERE id = 'u-test'").run()
    probe.fire({ type: 'x', n: 1 })
    expect(sent).toEqual([{ type: 'hello', channel: 'probe' }])
    expect(ws.data.revalidating).toBe(true)
    db.$client.query("UPDATE users SET access_revision = 0 WHERE id = 'u-test'").run()
  })

  test('RFC-305 async gate verdict cannot send after the actor was replaced', async () => {
    let finish: ((visible: boolean) => void) | undefined
    const probe = makeProbeSpec({
      frameGate: () =>
        new Promise<boolean>((resolveVisible) => {
          finish = resolveVisible
        }),
    })
    const { ws, sent } = makeFakeWs(makeActor('user'))
    gatedSubscribe(ws, probe.spec, { kind: 'tasks-list' }, db)
    probe.fire({ type: 'x', n: 1 })
    db.$client.query("UPDATE users SET access_revision = 1 WHERE id = 'u-test'").run()
    ws.data.actor = buildActor({
      user: {
        id: 'u-test',
        username: 'u-test',
        displayName: 'u-test',
        role: 'user',
        status: 'active',
      },
      source: 'session',
      authorityRevision: 1,
    })
    finish?.(true)
    await flush()
    expect(sent).toEqual([{ type: 'hello', channel: 'probe' }])
    db.$client.query("UPDATE users SET access_revision = 0 WHERE id = 'u-test'").run()
  })

  test('aclBypassShortCircuit sends synchronously for actors with ACL bypass', () => {
    let gateCalls = 0
    const probe = makeProbeSpec({
      aclBypassShortCircuit: true,
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

  test('task audience snapshots reach before/after members, reject outsiders, and bust stale cache', async () => {
    const gate = WS_CHANNELS['tasks-list'].frameGate!
    const taskId = 'task-audience-transition'
    const visibleUserIds = new Set([
      'before-owner',
      'removed-member',
      'after-owner',
      'added-member',
    ])
    const deliveryContext = {
      kind: 'task.members-changed-audience' as const,
      taskId,
      visibleUserIds,
    }
    const message = { type: 'task.members.changed' as const, taskId }

    for (const userId of visibleUserIds) {
      const cache = new Map([[taskId, false]])
      expect(
        await gate({ db, actor: makeActor('user', userId), cache }, message, deliveryContext),
      ).toBe(true)
      expect(cache.has(taskId)).toBe(false)
    }
    expect(
      await gate(
        { db, actor: makeActor('user', 'outsider'), cache: new Map([[taskId, true]]) },
        message,
        deliveryContext,
      ),
    ).toBe(false)
    expect(
      await gate(
        { db, actor: makeActor('admin', 'admin'), cache: new Map() },
        message,
        deliveryContext,
      ),
    ).toBe(true)
  })

  test('MCP runtime-test locator reaches only its owner; admin audit still requires an exact id', async () => {
    const owner = makeFakeWs(makeActor('user', 'owner-1'))
    const stranger = makeFakeWs(makeActor('user', 'stranger-1'))
    const admin = makeFakeWs(makeActor('admin', 'admin-1'))
    for (const target of [owner, stranger, admin]) {
      gatedSubscribe(target.ws, WS_CHANNELS['mcp-runtime-tests'], { kind: 'mcp-runtime-tests' }, db)
    }
    const locator = {
      type: 'mcp-runtime-test.updated',
      sessionId: 'session-1',
      sessionVersion: 2,
      inFlightTurnId: 'turn-1',
      turnStatus: 'running',
      eventCursor: 3,
      captureState: 'live',
    } as const
    mcpRuntimeTestsBroadcaster.broadcast(MCP_RUNTIME_TESTS_CHANNEL, locator, {
      kind: 'mcp-runtime-test-owner',
      ownerUserId: 'owner-1',
    })
    await flush()

    expect(owner.sent).toEqual([{ type: 'hello', channel: 'mcp-runtime-tests' }, locator])
    expect(admin.sent).toEqual([{ type: 'hello', channel: 'mcp-runtime-tests' }])
    expect(stranger.sent).toEqual([{ type: 'hello', channel: 'mcp-runtime-tests' }])
    expect(JSON.stringify(owner.sent)).not.toContain('owner-1')
    owner.ws.data.unsubscribe()
    stranger.ws.data.unsubscribe()
    admin.ws.data.unsubscribe()
  })
})
