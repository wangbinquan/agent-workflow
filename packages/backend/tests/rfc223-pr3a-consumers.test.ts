// RFC-223 (PR-3a) — frozen-snapshot id producers + consumer-matrix + task
// guards resolve agents BY canonical id (name only for display / transitional).
//
// Pure-function locks (attribution / distill scope / mint) plus two DB locks:
//   - buildWorkgroupRuntimeConfig freezes each member's agentId into the task
//     config (going-forward R4-1);
//   - the single-agent delete/rename guard matches source_agent_id, so a
//     DIFFERENT agent's same-named task neither blocks the op nor leaks its id
//     (R3-3 cross-tenant isolation — the failure PR-8 name-uniqueness would open).

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { QUARANTINED_SNAPSHOT_AGENT_ID } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { buildActor } from '../src/auth/actor'
import { createAgent, deleteAgent, renameAgent } from '../src/services/agent'
import { createWorkgroup, getWorkgroup } from '../src/services/workgroups'
import { buildWorkgroupRuntimeConfig } from '../src/services/workgroup/launch'
import {
  deriveWorkgroupRunHistory,
  type HostRunLite,
  type MemberLite,
} from '../src/services/workgroup/room'
import { extractAgentRefsFromSnapshot } from '../src/services/memoryDistillScheduler'
import { buildMintNodeRunValues } from '../src/services/nodeRunMint'
import { WG_MEMBER_NODE_ID } from '../src/services/workgroup/constants'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const ACTOR = buildActor({
  user: { id: 'u-admin', username: 'admin', displayName: 'admin', role: 'admin', status: 'active' },
  source: 'session',
})

const AGENT_INPUT = (name: string) => ({
  name,
  description: '',
  outputs: [] as string[],
  syncOutputsOnIterate: true,
  permission: {},
  skills: [],
  dependsOn: [] as string[],
  mcp: [] as string[],
  plugins: [] as string[],
  frontmatterExtra: {},
  bodyMd: '',
})

// ---------------------------------------------------------------------------
// room attribution — a run maps to its member by the immutable agentOverrideId
// (rename/ABA-safe), name only as the legacy fallback (RFC-182 impl-gate P2).
// ---------------------------------------------------------------------------
describe('deriveWorkgroupRunHistory — id-first agent attribution', () => {
  const members: MemberLite[] = [
    { id: 'mA1', memberType: 'agent', agentId: 'ag-x', agentName: 'agent-x', displayName: 'A1' },
    { id: 'mA2', memberType: 'agent', agentId: 'ag-y', agentName: 'agent-y', displayName: 'A2' },
  ]

  test('agentOverrideId wins over the mutable card assignee', () => {
    // Card ASG1 was re-claimed by A2 (mutable), but the run was minted under A1.
    const assignments = [{ id: 'ASG1', assigneeMemberId: 'mA2' }]
    const run: HostRunLite = {
      id: 'R1',
      nodeId: WG_MEMBER_NODE_ID,
      shardKey: 'ASG1',
      status: 'done',
      rerunCause: 'wg-assignment',
      agentOverrideId: 'ag-x', // A1's agent
    }
    const history = deriveWorkgroupRunHistory(members, 'mA1', [run], assignments, [])
    expect(history.find((e) => e.nodeRunId === 'R1')?.memberId).toBe('mA1')
  })

  test('legacy row (agentOverrideName only, no id) falls back to the name', () => {
    const assignments = [{ id: 'ASG1', assigneeMemberId: null }]
    const run: HostRunLite = {
      id: 'R2',
      nodeId: WG_MEMBER_NODE_ID,
      shardKey: 'ASG1',
      status: 'done',
      rerunCause: 'wg-assignment',
      agentOverrideName: 'agent-x', // no agentOverrideId → name fallback
    }
    const history = deriveWorkgroupRunHistory(members, 'mA1', [run], assignments, [])
    expect(history.find((e) => e.nodeRunId === 'R2')?.memberId).toBe('mA1')
  })

  test('M1: agentOverrideId present but off-roster → fail closed, NOT re-bound by name', () => {
    // Agent A (ag-a, name "shared") was on the roster when run R3 was minted; A
    // was then removed mid-run and a DIFFERENT agent B (ag-b) took the name
    // "shared". The run froze A's id. Strict-by-id resolution must DROP the run
    // (fail closed) — the old `(byId ?? null) ?? (byName …)` chain fell through to
    // the name and mis-attributed A's history to B.
    const roster: MemberLite[] = [
      { id: 'mB', memberType: 'agent', agentId: 'ag-b', agentName: 'shared', displayName: 'B' },
    ]
    const assignments = [{ id: 'ASG9', assigneeMemberId: null }]
    const run: HostRunLite = {
      id: 'R3',
      nodeId: WG_MEMBER_NODE_ID,
      shardKey: 'ASG9',
      status: 'done',
      rerunCause: 'wg-assignment',
      agentOverrideId: 'ag-a', // A's id — no longer on the roster
      agentOverrideName: 'shared', // the name B now holds (the ABA trap)
    }
    const history = deriveWorkgroupRunHistory(roster, 'mB', [run], assignments, [])
    // The run must NOT be attributed to B — with strict-by-id it is dropped.
    expect(history.find((e) => e.nodeRunId === 'R3')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// distill scope — take the frozen id (取单行); a genuinely name-only node falls
// back to the name set (heuristic). A R4-1 quarantine sentinel is dropped
// ENTIRELY — never downgraded to a name lookup (impl-gate H1 fail-open fix).
// ---------------------------------------------------------------------------
describe('extractAgentRefsFromSnapshot', () => {
  test('frozen agentId → ids; sentinel → DROPPED; only genuine name-only → namesWithoutId', () => {
    const snap = JSON.stringify({
      nodes: [
        { id: 'n1', kind: 'agent-single', agentName: 'foo', agentId: 'ID_FOO' },
        { id: 'n2', kind: 'agent-single', agentName: 'bar' }, // name-only
        {
          id: 'n3',
          kind: 'agent-single',
          agentName: 'zap',
          agentId: QUARANTINED_SNAPSHOT_AGENT_ID,
        },
        { id: 'n4', kind: 'output' },
      ],
    })
    const { ids, namesWithoutId } = extractAgentRefsFromSnapshot(snap)
    expect(ids).toEqual(['ID_FOO'])
    // H1: the sentinel node ('zap') is FAIL-CLOSED — it must NOT leak into the
    // name fallback (re-resolving 'zap' by name could bind a different tenant's
    // agent). Only the genuinely id-less 'bar' remains.
    expect(namesWithoutId.sort()).toEqual(['bar'])
  })

  test('malformed JSON → empty', () => {
    expect(extractAgentRefsFromSnapshot('{not-json')).toEqual({ ids: [], namesWithoutId: [] })
  })
})

// ---------------------------------------------------------------------------
// nodeRunMint — the borrow / workgroup-member producer stamps agentOverrideId.
// ---------------------------------------------------------------------------
describe('buildMintNodeRunValues — agentOverrideId', () => {
  test('stamps both override name and id', () => {
    const v = buildMintNodeRunValues({
      taskId: 't1',
      nodeId: 'n1',
      status: 'pending',
      cause: 'initial',
      overrides: { agentOverrideName: 'x', agentOverrideId: 'ag-x' },
    })
    expect(v.agentOverrideName).toBe('x')
    expect(v.agentOverrideId).toBe('ag-x')
  })

  test('defaults to null when not overridden', () => {
    const v = buildMintNodeRunValues({
      taskId: 't1',
      nodeId: 'n1',
      status: 'pending',
      cause: 'initial',
    })
    expect(v.agentOverrideId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// launch freeze (A2) + task guard (R3-3) — DB-backed.
// ---------------------------------------------------------------------------
describe('RFC-223 PR-3a — DB locks', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('buildWorkgroupRuntimeConfig freezes each member agentId', async () => {
    const agent = await createAgent(db, AGENT_INPUT('planner'))
    await createWorkgroup(db, {
      name: 'squad',
      description: '',
      mode: 'free_collab',
      instructions: '',
      switches: { shareOutputs: true, directMessages: false, blackboard: false },
      maxRounds: 5,
      completionGate: false,
      members: [
        { memberType: 'agent', agentName: 'planner', displayName: 'planner', roleDesc: '' },
      ],
    })
    const group = await getWorkgroup(db, 'squad')
    expect(group).not.toBeNull()
    const config = buildWorkgroupRuntimeConfig(group!, 'goal')
    const member = config.members.find((m) => m.memberType === 'agent')!
    // Frozen by CANONICAL id (rename/ABA-safe), name kept for display.
    expect(member.agentId).toBe(agent.id)
    expect(member.agentName).toBe('planner')
  })

  test('R3-3: a same-named task with a DIFFERENT source_agent_id neither blocks nor leaks', async () => {
    const a = await createAgent(db, AGENT_INPUT('writer'))
    await db.insert(workflows).values({ id: 'wf', name: 'wf', definition: '{}' })
    // A live task whose display name is 'writer' but whose CANONICAL owner is a
    // different agent id (simulating a cross-tenant / ABA same-name collision).
    const otherTaskId = ulid()
    await db.insert(tasks).values({
      id: otherTaskId,
      name: 'other',
      workflowId: 'wf',
      workflowSnapshot: '{}',
      repoPath: '/tmp/x',
      worktreePath: '/tmp/x',
      baseBranch: 'main',
      branch: `aw/${otherTaskId}`,
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
      sourceAgentName: 'writer',
      sourceAgentId: 'a-DIFFERENT-agent-id', // NOT a.id
    })
    // The guard matches source_agent_id, so agent A's delete/rename is NOT
    // blocked by the other agent's task — and the error (which would carry that
    // task's id) never fires.
    const renamed = await renameAgent(db, 'writer', { newName: 'writer2' }, ACTOR)
    expect(renamed.name).toBe('writer2')
    await deleteAgent(db, 'writer2', ACTOR)
    // sanity: A really is gone; the unrelated task row is untouched.
    expect(a.name).toBe('writer')
    const row = (await db.select().from(tasks).where(eq(tasks.id, otherTaskId)))[0]
    expect(row?.status).toBe('running')
  })
})
