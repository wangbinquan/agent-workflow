// RFC-185 — locks the leader fan-out dispatch contract (design/RFC-185-workgroup-leader-fanout).
//
// Why this file exists: the ENGINE has always been able to run same-member
// assignment entries concurrently — deriveWakeSet wakes every dispatched
// assignment with no per-member busy gate, and each run gets its own
// shardKey + iso worktree. What was missing is the PROTOCOL telling the
// leader it MAY fan out (models self-limit to one entry per member without
// the invitation). These locks keep the three layers aligned so a future
// refactor cannot silently break the promise the protocol now makes:
//   1. protocol copy — FAN-OUT block exists, ONLY for the leader role, and
//      its per-turn cap number can never drift from WG_MAX_ASSIGNMENTS_PER_TURN;
//   2. parser — same-member entries pass through in order (no dedup), the
//      cap still rejects oversized turns;
//   3. wake — all same-member dispatched assignments wake concurrently, and
//      the leader aggregation barrier waits for terminal states only
//      (awaiting_human does NOT block it — design.md §D3-3).

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  parseWgAssignmentsPort,
  WG_MAX_ASSIGNMENTS_PER_TURN,
  type WorkgroupAssignment,
  type WorkgroupRuntimeConfig,
} from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  nodeRuns,
  tasks,
  workflows,
  workgroupAssignments,
  workgroupMessages,
} from '../src/db/schema'
import { createAgent } from '../src/services/agent'
import { renderWgProtocolBlock } from '../src/services/workgroupContext'
import {
  buildWorkgroupHostSnapshot,
  buildWorkgroupRuntimeConfig,
  WG_LEADER_NODE_ID,
  WG_MEMBER_NODE_ID,
} from '../src/services/workgroupLaunch'
import { createWorkgroup, getWorkgroup, updateWorkgroup } from '../src/services/workgroups'
import {
  runWorkgroupEngine,
  type WorkgroupEngineHooks,
  type WorkgroupHostRunRequest,
  type WorkgroupHostRunResult,
} from '../src/services/workgroupRunner'
import { deriveWakeSet, type WakeInput } from '../src/services/workgroupWake'
import { createLogger } from '../src/util/log'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const log = createLogger('rfc185-fanout-test')

// ---------------------------------------------------------------------------
// fixtures (mirrors rfc164-workgroup-core.test.ts shapes, trimmed to what the
// fan-out locks need)
// ---------------------------------------------------------------------------

function cfg(overrides: Partial<WorkgroupRuntimeConfig> = {}): WorkgroupRuntimeConfig {
  return {
    workgroupId: 'wg1',
    workgroupName: 'squad',
    mode: 'leader_worker',
    leaderMemberId: 'm-lead',
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: 10,
    completionGate: false,
    // RFC-185 D4 — fan-out is OPT-IN; this fixture models an enabled group
    // (the opt-in gating itself is locked in its own describe below).
    fanOut: true,
    instructions: 'be kind',
    goal: 'audit the services',
    members: [
      {
        id: 'm-lead',
        memberType: 'agent',
        agentName: 'planner',
        userId: null,
        displayName: 'planner',
        roleDesc: '协调',
      },
      {
        id: 'm-coder',
        memberType: 'agent',
        agentName: 'coder-a',
        userId: null,
        displayName: 'coder',
        roleDesc: '实现',
      },
    ],
    ...overrides,
  }
}

let seq = 0
function asg(overrides: Partial<WorkgroupAssignment> = {}): WorkgroupAssignment {
  seq += 1
  return {
    id: `A${String(seq).padStart(6, '0')}`,
    taskId: 't1',
    round: 1,
    source: 'leader',
    createdByRunId: null,
    createdByUserId: null,
    assigneeMemberId: 'm-coder',
    title: 'do x',
    briefMd: 'do x well',
    status: 'dispatched',
    nodeRunId: null,
    resultMessageId: null,
    dedupKey: null,
    createdAt: seq,
    updatedAt: seq,
    ...overrides,
  }
}

function wakeInput(overrides: Partial<WakeInput> = {}): WakeInput {
  return {
    config: cfg(),
    assignments: [],
    messages: [],
    cursors: new Map(),
    inFlight: {
      leaderRunning: false,
      runningAssignmentIds: new Set(),
      messageTurnMemberIds: new Set(),
    },
    roundsUsed: 1,
    gate: { declaredDone: false, awaitingConfirmation: false, rejected: false },
    ...overrides,
  }
}

/** A non-leader-authored room message the leader has not consumed yet. */
function freshContentForLeader(): Pick<WakeInput, 'messages' | 'cursors'> {
  return {
    messages: [
      {
        id: '01MFRESH0000000000000001',
        taskId: 't1',
        round: 1,
        authorKind: 'member',
        authorMemberId: 'm-coder',
        authorUserId: null,
        kind: 'result',
        bodyMd: 'shard done',
        mentionMemberIds: [],
        assignmentId: null,
        createdAt: 1,
      },
    ],
    cursors: new Map(),
  }
}

// ---------------------------------------------------------------------------
// 1. protocol copy
// ---------------------------------------------------------------------------

describe('RFC-185 — leader protocol FAN-OUT block', () => {
  test('leader block invites same-member fan-out with self-contained briefs', () => {
    const block = renderWgProtocolBlock('leader', cfg())
    expect(block).toContain('FAN-OUT:')
    expect(block).toContain('SAME member may appear in MULTIPLE entries')
    expect(block).toContain('CONCURRENT INSTANCE')
    expect(block).toContain('self-contained')
    // Codex impl-gate P2 — the barrier copy must NOT claim every assignment is
    // terminal at wake time: a clarify-parked instance (awaiting_human) does
    // not block the leader wake (locked below), so the copy has to teach the
    // leader to treat a parked ledger row as in-progress, not done.
    expect(block).toContain('aggregate once no dispatched')
    expect(block).toContain('awaiting_human in your ledger')
    expect(block).toContain('IN PROGRESS')
  })

  test('the per-turn cap in the copy can never drift from the validator constant', () => {
    const block = renderWgProtocolBlock('leader', cfg())
    expect(block).toContain(`At most ${WG_MAX_ASSIGNMENTS_PER_TURN} entries per`)
  })

  test.each(['worker', 'fc_member'] as const)('%s block carries NO fan-out invitation', (role) => {
    const block = renderWgProtocolBlock(
      role,
      cfg({ mode: role === 'fc_member' ? 'free_collab' : 'leader_worker' }),
    )
    expect(block).not.toContain('FAN-OUT')
  })
})

// ---------------------------------------------------------------------------
// 1b. D4 — fan-out is OPT-IN (user acceptance revision): OFF (default) keeps
//     the ORIGINAL fixed one-entity-per-agent protocol byte-for-byte; only an
//     explicitly enabled group's leader gets the invitation.
// ---------------------------------------------------------------------------

describe('RFC-185 D4 — fan-out opt-in gating', () => {
  test('fanOut:false leader block has NO fan-out invitation and keeps the original port copy', () => {
    const block = renderWgProtocolBlock('leader', cfg({ fanOut: false }))
    expect(block).not.toContain('FAN-OUT')
    // the pre-RFC-185 single-line port closure, byte-for-byte
    expect(block).toContain('Empty array = no new work.</port>')
  })

  test('a config with NO fanOut field (pre-RFC-185 task snapshot) reads as off', () => {
    const { fanOut: _drop, ...legacy } = cfg()
    const block = renderWgProtocolBlock('leader', legacy)
    expect(block).not.toContain('FAN-OUT')
  })

  test('fanOut:true is what injects the invitation (the §1 locks above run on it)', () => {
    expect(renderWgProtocolBlock('leader', cfg())).toContain('FAN-OUT:')
  })
})

// ---------------------------------------------------------------------------
// 2. parser — same-member entries survive, cap still enforced
// ---------------------------------------------------------------------------

describe('RFC-185 — parseWgAssignmentsPort keeps same-member fan-out entries', () => {
  const roster = new Set(['planner', 'coder'])

  test('three entries for the SAME member pass through in order (no dedup)', () => {
    const raw = JSON.stringify([
      { member: 'coder', title: 'shard 1', brief: 'audit file A' },
      { member: 'coder', title: 'shard 2', brief: 'audit file B' },
      { member: 'coder', title: 'shard 3', brief: 'audit file C' },
    ])
    const r = parseWgAssignmentsPort(raw, roster)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.map((a) => a.title)).toEqual(['shard 1', 'shard 2', 'shard 3'])
      expect(new Set(r.value.map((a) => a.member))).toEqual(new Set(['coder']))
    }
  })

  test('a turn above WG_MAX_ASSIGNMENTS_PER_TURN is rejected whole', () => {
    const raw = JSON.stringify(
      Array.from({ length: WG_MAX_ASSIGNMENTS_PER_TURN + 1 }, (_, i) => ({
        member: 'coder',
        title: `shard ${i}`,
        brief: 'audit one file',
      })),
    )
    const r = parseWgAssignmentsPort(raw, roster)
    expect(r.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. wake — concurrent fan-out + terminal-state-only aggregation barrier
// ---------------------------------------------------------------------------

describe('RFC-185 — wake set fans out; leader barrier is terminal-state only', () => {
  test('three dispatched assignments for the SAME member all wake concurrently', () => {
    const assignments = [asg(), asg(), asg()]
    const wake = deriveWakeSet(wakeInput({ assignments }))
    const woken = wake.items.filter((i) => i.kind === 'assignment')
    expect(woken.map((i) => (i.kind === 'assignment' ? i.assignmentId : ''))).toEqual(
      assignments.map((a) => a.id),
    )
    expect(wake.items.some((i) => i.kind === 'leader')).toBe(false)
  })

  test('leader stays asleep while ANY sibling instance is still running', () => {
    const assignments = [
      asg({ status: 'running' }),
      asg({ status: 'running' }),
      asg({ status: 'done' }),
    ]
    const wake = deriveWakeSet(wakeInput({ ...freshContentForLeader(), assignments }))
    expect(wake.items).toEqual([])
  })

  test('leader wakes to aggregate once ALL instances are terminal', () => {
    const assignments = [
      asg({ status: 'done' }),
      asg({ status: 'failed' }),
      asg({ status: 'done' }),
    ]
    const wake = deriveWakeSet(wakeInput({ ...freshContentForLeader(), assignments }))
    expect(wake.items).toEqual([{ kind: 'leader', reason: 'new-content' }])
  })

  test('awaiting_human does NOT block the aggregation barrier (design §D3-3)', () => {
    const assignments = [
      asg({ status: 'awaiting_human' }),
      asg({ status: 'done' }),
      asg({ status: 'done' }),
    ]
    const wake = deriveWakeSet(wakeInput({ ...freshContentForLeader(), assignments }))
    expect(wake.items).toEqual([{ kind: 'leader', reason: 'new-content' }])
  })
})

// ---------------------------------------------------------------------------
// 4. engine integration (fake hooks — no subprocesses): one leader turn fans
//    out THREE same-member entries; each becomes its own concurrent run
//    (distinct shardKey, same borrowed agent); the leader aggregates after all
//    reach a terminal state — including when one instance fails.
// ---------------------------------------------------------------------------

async function seedEngineTask(
  db: DbClient,
  config: WorkgroupRuntimeConfig,
): Promise<{ taskId: string }> {
  const taskId = ulid()
  const snapshot = buildWorkgroupHostSnapshot(config)
  await db.insert(workflows).values({
    id: ulid(),
    name: `host-anchor-${taskId}`,
    definition: '{}',
    builtin: true,
  })
  const workflowRow = (await db.select().from(workflows).limit(1))[0]
  await db.insert(tasks).values({
    id: taskId,
    name: 'wg-fanout-task',
    workflowId: workflowRow?.id ?? ulid(),
    workflowSnapshot: JSON.stringify(snapshot),
    repoPath: '/tmp/never-read',
    worktreePath: '/tmp/never-read-wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
    workgroupId: config.workgroupId,
    workgroupConfigJson: JSON.stringify(config),
  })
  for (const name of ['planner', 'coder-a']) {
    await createAgent(db, {
      name,
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: 'work',
    }).catch(() => undefined)
  }
  return { taskId }
}

/** Scripted hooks: pops the next result per host-node queue; records requests. */
function scriptedHooks(script: {
  leader: WorkgroupHostRunResult[]
  member: WorkgroupHostRunResult[]
}): { hooks: WorkgroupEngineHooks; requests: WorkgroupHostRunRequest[] } {
  const requests: WorkgroupHostRunRequest[] = []
  const hooks: WorkgroupEngineHooks = {
    runHostNode: (req) => {
      requests.push(req)
      const queue = req.nodeId === WG_LEADER_NODE_ID ? script.leader : script.member
      const next = queue.shift()
      if (next === undefined) {
        return Promise.resolve({
          status: 'failed',
          outputs: {},
          errorMessage: `script exhausted for ${req.nodeId}`,
        })
      }
      return Promise.resolve(next)
    },
  }
  return { hooks, requests }
}

const doneLeader = (opts: {
  assignments?: Array<{ member: string; title: string; brief: string }>
  decision: { action: 'continue' | 'done'; summary?: string }
}): WorkgroupHostRunResult => ({
  status: 'done',
  outputs: {
    wg_decision: JSON.stringify(opts.decision),
    ...(opts.assignments !== undefined ? { wg_assignments: JSON.stringify(opts.assignments) } : {}),
  },
})

const doneMember = (summary: string): WorkgroupHostRunResult => ({
  status: 'done',
  outputs: { wg_result: JSON.stringify({ summary }) },
})

const FAN_OUT_3 = [
  { member: 'coder', title: 'shard-A', brief: 'audit services/a.ts only' },
  { member: 'coder', title: 'shard-B', brief: 'audit services/b.ts only' },
  { member: 'coder', title: 'shard-C', brief: 'audit services/c.ts only' },
]

describe('RFC-185 — engine fan-out integration (fake hooks)', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('one leader turn dispatches 3 same-member instances; all run concurrently then the leader aggregates', async () => {
    const config = cfg()
    const { taskId } = await seedEngineTask(db, config)
    const { hooks, requests } = scriptedHooks({
      leader: [
        doneLeader({ assignments: FAN_OUT_3, decision: { action: 'continue' } }),
        doneLeader({ decision: { action: 'done', summary: 'all shards audited' } }),
      ],
      member: [doneMember('A clean'), doneMember('B clean'), doneMember('C clean')],
    })

    const result = await runWorkgroupEngine({ db, taskId, log, hooks })
    expect(result.kind).toBe('ok')

    // run shape: leader, 3 member instances (any interleaving), leader again
    expect(requests.map((r) => r.nodeId)).toEqual([
      WG_LEADER_NODE_ID,
      WG_MEMBER_NODE_ID,
      WG_MEMBER_NODE_ID,
      WG_MEMBER_NODE_ID,
      WG_LEADER_NODE_ID,
    ])

    // 3 assignment rows, all done, each with its own result message
    const assignments = await db
      .select()
      .from(workgroupAssignments)
      .where(eq(workgroupAssignments.taskId, taskId))
    expect(assignments).toHaveLength(3)
    expect(assignments.every((a) => a.status === 'done')).toBe(true)
    expect(new Set(assignments.map((a) => a.resultMessageId)).size).toBe(3)
    expect(new Set(assignments.map((a) => a.assigneeMemberId))).toEqual(new Set(['m-coder']))

    // one dispatch message per instance (auto-publicity, no confirmation gate)
    const messages = await db
      .select()
      .from(workgroupMessages)
      .where(eq(workgroupMessages.taskId, taskId))
    expect(messages.filter((m) => m.kind === 'dispatch')).toHaveLength(3)

    // instance isolation: 3 borrowed runs on the shared member node, each keyed
    // by ITS assignment id, all impersonating the same agent
    const memberRuns = await db
      .select()
      .from(nodeRuns)
      .where(eq(nodeRuns.nodeId, WG_MEMBER_NODE_ID))
    expect(memberRuns).toHaveLength(3)
    expect(new Set(memberRuns.map((r) => r.shardKey))).toEqual(
      new Set(assignments.map((a) => a.id)),
    )
    expect(new Set(memberRuns.map((r) => r.agentOverrideName))).toEqual(new Set(['coder-a']))

    // every instance prompt carried ITS OWN self-contained brief
    const memberPrompts = requests.filter((r) => r.nodeId === WG_MEMBER_NODE_ID)
    const briefs = memberPrompts.map((r) => r.promptTemplate)
    for (const shard of ['a.ts', 'b.ts', 'c.ts']) {
      expect(briefs.filter((p) => p.includes(`audit services/${shard} only`))).toHaveLength(1)
    }

    // the aggregation turn saw all three results in ledger/new-activity
    const aggPrompt = requests[4]?.promptTemplate ?? ''
    for (const s of ['A clean', 'B clean', 'C clean']) expect(aggPrompt).toContain(s)
    for (const t of ['shard-A', 'shard-B', 'shard-C']) expect(aggPrompt).toContain(t)
  })

  test('one failing instance neither blocks siblings nor the aggregation turn', async () => {
    const config = cfg()
    const { taskId } = await seedEngineTask(db, config)
    const { hooks, requests } = scriptedHooks({
      leader: [
        doneLeader({ assignments: FAN_OUT_3, decision: { action: 'continue' } }),
        doneLeader({ decision: { action: 'done', summary: 'shipped what passed' } }),
      ],
      // whichever instance pops this result fails; the other two finish fine
      member: [
        doneMember('first ok'),
        { status: 'failed', outputs: {}, errorMessage: 'boom' },
        doneMember('second ok'),
      ],
    })

    const result = await runWorkgroupEngine({ db, taskId, log, hooks })
    expect(result.kind).toBe('ok')

    const assignments = await db
      .select()
      .from(workgroupAssignments)
      .where(eq(workgroupAssignments.taskId, taskId))
    const byStatus = assignments.map((a) => a.status).sort()
    expect(byStatus).toEqual(['done', 'done', 'failed'])

    // failure surfaced into the room (system message), siblings unaffected,
    // and lw mode does NOT auto-reopen — the leader decides at aggregation
    const messages = await db
      .select()
      .from(workgroupMessages)
      .where(eq(workgroupMessages.taskId, taskId))
    expect(messages.some((m) => m.kind === 'system' && m.bodyMd.includes('failed: boom'))).toBe(
      true,
    )

    // the leader still got its aggregation turn and saw the failure state
    const leaderTurns = requests.filter((r) => r.nodeId === WG_LEADER_NODE_ID)
    expect(leaderTurns).toHaveLength(2)
    expect(leaderTurns[1]?.promptTemplate).toContain('[failed]')
  })
})

// ---------------------------------------------------------------------------
// 5. D4 — resource CRUD roundtrip + launch freeze: create defaults OFF (the
//    original fixed mode is never changed implicitly), update preserves an
//    omitted field, launch freezes the flag into the task runtime config.
// ---------------------------------------------------------------------------

describe('RFC-185 D4 — fanOut CRUD roundtrip + launch freeze', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  const groupInput = (over: Record<string, unknown> = {}) => ({
    name: 'squad',
    description: '',
    instructions: '',
    mode: 'leader_worker' as const,
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: 5,
    completionGate: false,
    members: [{ memberType: 'agent' as const, agentName: 'a1', displayName: 'a1', roleDesc: '' }],
    ...over,
  })

  test('create defaults fanOut to FALSE (opt-in — never an implicit behavior change)', async () => {
    await createWorkgroup(db, groupInput())
    expect((await getWorkgroup(db, 'squad'))?.fanOut).toBe(false)
  })

  test('explicit create ON + an update omitting fanOut preserves the stored value', async () => {
    await createWorkgroup(db, groupInput({ fanOut: true }))
    expect((await getWorkgroup(db, 'squad'))?.fanOut).toBe(true)
    // full-replace PUT that omits fanOut must NOT flip it (same omitted-⇒-
    // preserve contract as autonomous, RFC-181 design-gate P1).
    await updateWorkgroup(db, 'squad', groupInput())
    expect((await getWorkgroup(db, 'squad'))?.fanOut).toBe(true)
  })

  test('launch freezes fanOut into the task runtime config', async () => {
    await createWorkgroup(db, groupInput({ fanOut: true }))
    const g = await getWorkgroup(db, 'squad')
    expect(g).not.toBeNull()
    if (g === null) return
    const rc = buildWorkgroupRuntimeConfig(g, 'goal text')
    expect(rc.fanOut).toBe(true)
    expect(renderWgProtocolBlock('leader', rc)).toContain('FAN-OUT:')
  })
})
