// RFC-164 PR-4 — workgroup room endpoints + human @-dispatch semantics.
//
// Locks:
//   - room visibility = task membership (owner sees, stranger gets the same
//     404 as missing; non-workgroup tasks 404 too — no shape leak);
//   - 决策 #14: "@member" in a human message = direct dispatch (one
//     assignment per mentioned member, source='human', card linked); no
//     mentions → blackboard chat;
//   - mention resolution: roster displayName tokens only, dedup, unknown
//     tokens ignored;
//   - cancel endpoint: open/dispatched cards cancel + system message;
//     running cards 409;
//   - prompt-isolation adjacency: the room payload is a HUMAN surface — it
//     may carry authorUserId/createdByUserId audit columns (design §11 keeps
//     them out of prompts, not out of the member-gated UI).

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { TaskWsMessage, WorkgroupRuntimeConfig } from '@agent-workflow/shared'
import { createSession } from '../src/auth/sessionStore'
import { TASK_CHANNEL, taskBroadcaster } from '../src/ws/broadcaster'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  nodeRuns,
  tasks,
  workflows,
  workgroupAssignments,
  workgroupMessages,
} from '../src/db/schema'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'
import { resolveMentions } from '../src/routes/workgroupTasks'
import { createLogger } from '../src/util/log'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
void createLogger

function cfg(): WorkgroupRuntimeConfig {
  return {
    workgroupId: 'wg1',
    workgroupName: 'squad',
    mode: 'leader_worker',
    leaderMemberId: 'm-lead',
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: 10,
    completionGate: false,
    instructions: '',
    goal: 'g',
    members: [
      {
        id: 'm-lead',
        memberType: 'agent',
        agentName: 'planner',
        userId: null,
        displayName: 'planner',
        roleDesc: '',
      },
      {
        id: 'm-coder',
        memberType: 'agent',
        agentName: 'coder-a',
        userId: null,
        displayName: 'coder',
        roleDesc: '',
      },
    ],
  }
}

describe('RFC-164 room — resolveMentions', () => {
  test('roster tokens only, dedup, order-stable, unknown ignored', () => {
    const out = resolveMentions('@coder please, and @coder again; @ghost no; cc @planner', cfg())
    expect(out.map((m) => m.displayName)).toEqual(['coder', 'planner'])
  })
  test('no tokens → empty', () => {
    expect(resolveMentions('plain note without mentions', cfg())).toEqual([])
  })
})

describe('RFC-164 room — endpoints', () => {
  let db: DbClient
  let app: ReturnType<typeof createApp>
  let owner: { id: string; token: string }
  let stranger: { id: string; token: string }
  let taskId: string

  async function mkUser(username: string) {
    const u = await createUser(db, {
      username,
      displayName: username,
      role: 'user',
      password: 'longEnoughPassword',
    })
    const { token } = await createSession({ db, userId: u.id })
    return { id: u.id, token }
  }

  async function req(token: string, path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    if (init.body) headers.set('content-type', 'application/json')
    return app.request(path, { ...init, headers })
  }

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    app = createApp({
      token: 'a'.repeat(64),
      configPath: '/tmp/aw-rfc164-room-config.json',
      opencodeVersion: '1.14.25',
      dbVersion: 1,
      db,
    })
    owner = await mkUser('owner')
    stranger = await mkUser('stranger')

    const wfId = ulid()
    taskId = ulid()
    await db.insert(workflows).values({ id: wfId, name: `wf-${wfId}`, definition: '{}' })
    await db.insert(tasks).values({
      id: taskId,
      name: 'room-task',
      workflowId: wfId,
      workflowSnapshot: '{"$schema_version":1,"inputs":[],"nodes":[],"edges":[]}',
      repoPath: '/tmp/x',
      worktreePath: '/tmp/x-wt',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
      ownerUserId: owner.id,
      workgroupId: 'wg1',
      workgroupConfigJson: JSON.stringify(cfg()),
    })
  })

  test('room aggregate: owner 200 with config/gate/messages/assignments; stranger + missing → same 404', async () => {
    const ok = await req(owner.token, `/api/workgroup-tasks/${taskId}/room`)
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as {
      config: { members: unknown[] }
      gate: { awaitingConfirmation: boolean }
      messages: unknown[]
      assignments: unknown[]
      memberRuns: Record<string, unknown>
    }
    expect(body.config.members).toHaveLength(2)
    expect(body.gate.awaitingConfirmation).toBe(false)
    // RFC-179 — room exposes a per-member currentRun map; no runs seeded → all null.
    expect(body.memberRuns['m-lead']).toBeNull()
    expect(body.memberRuns['m-coder']).toBeNull()

    const invisible = await req(stranger.token, `/api/workgroup-tasks/${taskId}/room`)
    const missing = await req(stranger.token, `/api/workgroup-tasks/${ulid()}/room`)
    expect(invisible.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(((await invisible.json()) as { code: string }).code).toBe(
      ((await missing.json()) as { code: string }).code,
    )
  })

  test('RFC-179: room memberRuns maps a running assignment run to its member', async () => {
    // Seed a dispatched→running assignment for @coder + the host run keyed by it.
    const assignmentId = ulid()
    await db.insert(workgroupAssignments).values({
      id: assignmentId,
      taskId,
      source: 'leader',
      assigneeMemberId: 'm-coder',
      title: 'do the thing',
      status: 'running',
    })
    const runId = ulid()
    await db.insert(nodeRuns).values({
      id: runId,
      taskId,
      nodeId: '__wg_member__',
      shardKey: assignmentId,
      status: 'running',
      rerunCause: 'wg-assignment',
      retryIndex: 0,
      iteration: 0,
      reviewIteration: 0,
      startedAt: Date.now(),
    })
    const body = (await (await req(owner.token, `/api/workgroup-tasks/${taskId}/room`)).json()) as {
      memberRuns: Record<
        string,
        { nodeRunId: string; status: string; kind: string; triggerMessageId: string | null } | null
      >
    }
    expect(body.memberRuns['m-coder']).toEqual({
      nodeRunId: runId,
      status: 'running',
      kind: 'assignment',
      triggerMessageId: null,
    })
    // The leader has no run of its own → still null (assignment run is @coder's).
    expect(body.memberRuns['m-lead']).toBeNull()
  })

  test('non-workgroup task → 404 (room endpoints only exist for group tasks)', async () => {
    const wfId = ulid()
    const plainId = ulid()
    await db.insert(workflows).values({ id: wfId, name: `wf-${wfId}`, definition: '{}' })
    await db.insert(tasks).values({
      id: plainId,
      name: 'plain',
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/x',
      worktreePath: '/tmp/x-wt',
      baseBranch: 'main',
      branch: `agent-workflow/${plainId}`,
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
      ownerUserId: owner.id,
    })
    expect((await req(owner.token, `/api/workgroup-tasks/${plainId}/room`)).status).toBe(404)
  })

  test('决策 #14: @coder message → assignment(source=human) + dispatch message; no-@ → chat', async () => {
    const dispatch = await req(owner.token, `/api/workgroup-tasks/${taskId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: '@coder 顺便查下测试\n再补充一行细节' }),
    })
    expect(dispatch.status).toBe(201)
    const dBody = (await dispatch.json()) as { messageId: string; assignmentIds: string[] }
    expect(dBody.assignmentIds).toHaveLength(1)

    const rows = await db
      .select()
      .from(workgroupAssignments)
      .where(eq(workgroupAssignments.taskId, taskId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.source).toBe('human')
    expect(rows[0]?.assigneeMemberId).toBe('m-coder')
    expect(rows[0]?.status).toBe('dispatched')
    expect(rows[0]?.createdByUserId).toBe(owner.id)
    expect(rows[0]?.briefMd).toContain('再补充一行细节')

    const msgs = await db
      .select()
      .from(workgroupMessages)
      .where(eq(workgroupMessages.taskId, taskId))
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.kind).toBe('dispatch')
    expect(msgs[0]?.assignmentId).toBe(rows[0]?.id ?? '')

    const chat = await req(owner.token, `/api/workgroup-tasks/${taskId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: '方向偏了，改走 events 表' }),
    })
    expect(chat.status).toBe(201)
    const after = await db
      .select()
      .from(workgroupMessages)
      .where(eq(workgroupMessages.taskId, taskId))
    expect(after).toHaveLength(2)
    // Assert by kind, not array index: a concurrent test that perturbs the
    // clock can make ULID ids non-monotonic across the whole suite, reordering
    // the id-sorted select (the no-@ chat message's kind is still correct —
    // only its position moves). Full-suite pollution surfaced this on
    // 2026-07-10; single/small-batch runs stay monotonic.
    const chatMsg = after.find((m) => m.kind === 'chat')
    expect(chatMsg).toBeDefined()
    expect(chatMsg?.authorKind).toBe('human')
    expect(after.filter((m) => m.kind === 'dispatch')).toHaveLength(1)
    // no extra assignment for the plain chat
    expect(
      await db.select().from(workgroupAssignments).where(eq(workgroupAssignments.taskId, taskId)),
    ).toHaveLength(1)
  })

  test('terminal task refuses messages (409)', async () => {
    await db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, taskId))
    const res = await req(owner.token, `/api/workgroup-tasks/${taskId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: 'hello?' }),
    })
    expect(res.status).toBe(409)
  })

  test('cancel: dispatched card cancels + system message; running card 409; stranger 404', async () => {
    await req(owner.token, `/api/workgroup-tasks/${taskId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: '@coder do x' }),
    })
    const a = (
      await db.select().from(workgroupAssignments).where(eq(workgroupAssignments.taskId, taskId))
    )[0]
    expect(a).toBeDefined()

    const strangerCancel = await req(
      stranger.token,
      `/api/workgroup-tasks/${taskId}/assignments/${a?.id ?? ''}/cancel`,
      { method: 'POST' },
    )
    expect(strangerCancel.status).toBe(404)

    // RFC-179 follow-up: a concurrent viewer's room only learns of the
    // cancellation through the WS frames, so the endpoint must BROADCAST the
    // assignment flip + the system note (not merely write them to the DB) —
    // else the other viewer stays stale until the 15s poll / F5.
    const frames: TaskWsMessage[] = []
    const unsub = taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (m) => frames.push(m))
    const ok = await req(
      owner.token,
      `/api/workgroup-tasks/${taskId}/assignments/${a?.id ?? ''}/cancel`,
      { method: 'POST' },
    )
    unsub()
    expect(ok.status).toBe(204)
    const after = (
      await db
        .select()
        .from(workgroupAssignments)
        .where(eq(workgroupAssignments.id, a?.id ?? ''))
    )[0]
    expect(after?.status).toBe('canceled')
    const sys = (
      await db.select().from(workgroupMessages).where(eq(workgroupMessages.taskId, taskId))
    ).filter((m) => m.kind === 'system')
    expect(sys.length).toBeGreaterThan(0)
    expect(frames.some((f) => f.type === 'wg.assignment.updated' && f.status === 'canceled')).toBe(
      true,
    )
    expect(frames.some((f) => f.type === 'wg.message.created' && f.kind === 'system')).toBe(true)

    // running card refuses
    const b = ulid()
    await db.insert(workgroupAssignments).values({
      id: b,
      taskId,
      round: 1,
      source: 'leader',
      assigneeMemberId: 'm-coder',
      title: 't',
      briefMd: 'b',
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const refuse = await req(
      owner.token,
      `/api/workgroup-tasks/${taskId}/assignments/${b}/cancel`,
      { method: 'POST' },
    )
    expect(refuse.status).toBe(409)
  })
})

// ---------------------------------------------------------------------------
// PR-5 — human delivery / completion gate / mid-run config (design §8)
// ---------------------------------------------------------------------------

describe('RFC-164 room — PR-5 surfaces', () => {
  let db: DbClient
  let app: ReturnType<typeof createApp>
  let owner: { id: string; token: string }
  let taskId: string

  function cfgWithHuman(userId: string): WorkgroupRuntimeConfig {
    const base = cfg()
    return {
      ...base,
      members: [
        ...base.members,
        {
          id: 'm-pm',
          memberType: 'human',
          agentName: null,
          userId,
          displayName: 'pm',
          roleDesc: '把关',
        },
      ],
    }
  }

  async function req(token: string, path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    if (init.body) headers.set('content-type', 'application/json')
    return app.request(path, { ...init, headers })
  }

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    app = createApp({
      token: 'a'.repeat(64),
      configPath: '/tmp/aw-rfc164-room5-config.json',
      opencodeVersion: '1.14.25',
      dbVersion: 1,
      db,
    })
    const u = await createUser(db, {
      username: 'owner5',
      displayName: 'owner5',
      role: 'user',
      password: 'longEnoughPassword',
    })
    owner = { id: u.id, token: (await createSession({ db, userId: u.id })).token }
    const wfId = ulid()
    taskId = ulid()
    await db.insert(workflows).values({ id: wfId, name: `wf-${wfId}`, definition: '{}' })
    await db.insert(tasks).values({
      id: taskId,
      name: 'room5-task',
      workflowId: wfId,
      workflowSnapshot: '{"$schema_version":1,"inputs":[],"nodes":[],"edges":[]}',
      repoPath: '/tmp/x',
      worktreePath: '/tmp/x-wt',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
      ownerUserId: owner.id,
      workgroupId: 'wg1',
      workgroupConfigJson: JSON.stringify(cfgWithHuman(u.id)),
    })
  })

  async function seedHumanCard(status = 'dispatched'): Promise<string> {
    const id = ulid()
    await db.insert(workgroupAssignments).values({
      id,
      taskId,
      round: 1,
      source: 'leader',
      assigneeMemberId: 'm-pm',
      title: '确认口径',
      briefMd: '请确认幂等键口径',
      status: status as 'dispatched',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    return id
  }

  test('deliver 双形态：body 直交付 / summary+detail 归一；卡 dispatched→delivered + delivery 消息', async () => {
    const a1 = await seedHumanCard()
    const r1 = await req(owner.token, `/api/workgroup-tasks/${taskId}/assignments/${a1}/deliver`, {
      method: 'POST',
      body: JSON.stringify({ body: '用订单号+事件类型' }),
    })
    expect(r1.status).toBe(201)
    const row1 = (
      await db.select().from(workgroupAssignments).where(eq(workgroupAssignments.id, a1))
    )[0]
    expect(row1?.status).toBe('delivered')
    expect(row1?.resultMessageId).toBeTruthy()

    const a2 = await seedHumanCard()
    const r2 = await req(owner.token, `/api/workgroup-tasks/${taskId}/assignments/${a2}/deliver`, {
      method: 'POST',
      body: JSON.stringify({ summary: '口径确认', detail: '订单号+事件类型联合键' }),
    })
    expect(r2.status).toBe(201)
    const msgs = await db
      .select()
      .from(workgroupMessages)
      .where(eq(workgroupMessages.taskId, taskId))
    const deliveries = msgs.filter((m) => m.kind === 'delivery')
    expect(deliveries).toHaveLength(2)
    // by-content, not index (ULID ordering may be perturbed under full-suite
    // clock pollution — see the 决策 #14 test note).
    expect(deliveries.some((m) => m.bodyMd.includes('订单号+事件类型联合键'))).toBe(true)

    // 已交付卡重复交付 409
    const dup = await req(owner.token, `/api/workgroup-tasks/${taskId}/assignments/${a1}/deliver`, {
      method: 'POST',
      body: JSON.stringify({ body: 'again' }),
    })
    expect(dup.status).toBe(409)
  })

  test('deliver 拒绝非 human 卡', async () => {
    const id = ulid()
    await db.insert(workgroupAssignments).values({
      id,
      taskId,
      round: 1,
      source: 'leader',
      assigneeMemberId: 'm-coder',
      title: 't',
      briefMd: 'b',
      status: 'dispatched',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const res = await req(owner.token, `/api/workgroup-tasks/${taskId}/assignments/${id}/deliver`, {
      method: 'POST',
      body: JSON.stringify({ body: 'x' }),
    })
    expect(res.status).toBe(422)
  })

  async function openGate(): Promise<void> {
    const raw = JSON.parse(
      (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.workgroupConfigJson ?? '{}',
    ) as Record<string, unknown>
    raw.gate = { declaredDone: true, awaitingConfirmation: true, rejected: false, approved: false }
    await db
      .update(tasks)
      .set({ workgroupConfigJson: JSON.stringify(raw), status: 'awaiting_review' })
      .where(eq(tasks.id, taskId))
    await db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: '__wg_leader__',
      status: 'awaiting_review',
      rerunCause: 'wg-gate',
      retryIndex: 0,
      iteration: 0,
      reviewIteration: 0,
      startedAt: Date.now(),
    })
  }

  test('confirm approve：gate 关+approved、门 run done、系统消息', async () => {
    await openGate()
    const res = await req(owner.token, `/api/workgroup-tasks/${taskId}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approve' }),
    })
    expect(res.status).toBe(200)
    const raw = JSON.parse(
      (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.workgroupConfigJson ?? '{}',
    ) as { gate: { approved: boolean; awaitingConfirmation: boolean } }
    expect(raw.gate.approved).toBe(true)
    expect(raw.gate.awaitingConfirmation).toBe(false)
    const holders = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
      (r) => r.rerunCause === 'wg-gate',
    )
    expect(holders[0]?.status).toBe('done')
  })

  test('confirm reject：必带 comment；declaredDone 复位 + rejected 置位', async () => {
    await openGate()
    const noComment = await req(owner.token, `/api/workgroup-tasks/${taskId}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'reject' }),
    })
    expect(noComment.status).toBe(422)
    const res = await req(owner.token, `/api/workgroup-tasks/${taskId}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'reject', comment: '测试没覆盖并发场景' }),
    })
    expect(res.status).toBe(200)
    const raw = JSON.parse(
      (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.workgroupConfigJson ?? '{}',
    ) as { gate: { rejected: boolean; declaredDone: boolean; rejectedComment: string } }
    expect(raw.gate.rejected).toBe(true)
    expect(raw.gate.declaredDone).toBe(false)
    expect(raw.gate.rejectedComment).toBe('测试没覆盖并发场景')
  })

  test('gate 未开时 confirm → 409', async () => {
    const res = await req(owner.token, `/api/workgroup-tasks/${taskId}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approve' }),
    })
    expect(res.status).toBe(409)
  })

  test('config patch：加成员游标=当前尾（不补历史）、减成员卡转置、leader 不可删、重名拒', async () => {
    // 先落一条消息作为「历史」
    await db.insert(workgroupMessages).values({
      id: ulid(),
      taskId,
      round: 0,
      authorKind: 'system',
      kind: 'system',
      bodyMd: 'history line',
      mentionsJson: '[]',
      createdAt: Date.now(),
    })
    const add = await req(owner.token, `/api/workgroup-tasks/${taskId}/config`, {
      method: 'PUT',
      body: JSON.stringify({
        addMembers: [
          { memberType: 'agent', agentName: 'late-joiner', displayName: 'late', roleDesc: '' },
        ],
        maxRounds: 30,
      }),
    })
    expect(add.status).toBe(200)
    const raw = JSON.parse(
      (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.workgroupConfigJson ?? '{}',
    ) as { members: Array<{ id: string; displayName: string }>; maxRounds: number }
    expect(raw.maxRounds).toBe(30)
    const late = raw.members.find((m) => m.displayName === 'late')
    expect(late).toBeDefined()
    // join-no-history：游标已是当前尾
    const { workgroupMemberCursors } = await import('../src/db/schema')
    const cursor = (
      await db
        .select()
        .from(workgroupMemberCursors)
        .where(eq(workgroupMemberCursors.taskId, taskId))
    ).find((c2) => c2.memberId === (late?.id ?? ''))
    expect(cursor?.lastConsumedMessageId ?? '').not.toBe('')

    // leader 不可删
    const rmLeader = await req(owner.token, `/api/workgroup-tasks/${taskId}/config`, {
      method: 'PUT',
      body: JSON.stringify({ removeMemberIds: ['m-lead'] }),
    })
    expect(rmLeader.status).toBe(422)

    // 重名拒
    const dup = await req(owner.token, `/api/workgroup-tasks/${taskId}/config`, {
      method: 'PUT',
      body: JSON.stringify({
        addMembers: [{ memberType: 'agent', agentName: 'x', displayName: 'late', roleDesc: '' }],
      }),
    })
    expect(dup.status).toBe(422)

    // 减成员：其 dispatched 卡取消（lw）
    const cardId = ulid()
    await db.insert(workgroupAssignments).values({
      id: cardId,
      taskId,
      round: 1,
      source: 'leader',
      assigneeMemberId: late?.id ?? '',
      title: 't',
      briefMd: 'b',
      status: 'dispatched',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const rm = await req(owner.token, `/api/workgroup-tasks/${taskId}/config`, {
      method: 'PUT',
      body: JSON.stringify({ removeMemberIds: [late?.id ?? ''] }),
    })
    expect(rm.status).toBe(200)
    expect(
      (await db.select().from(workgroupAssignments).where(eq(workgroupAssignments.id, cardId)))[0]
        ?.status,
    ).toBe('canceled')
  })

  test('pending-count：我的人类待办 + 待确认门', async () => {
    await seedHumanCard()
    const before = (await (
      await req(owner.token, '/api/workgroup-tasks/pending-count')
    ).json()) as { deliveries: number; gates: number; total: number }
    expect(before.deliveries).toBe(1)
    expect(before.gates).toBe(0)
    await openGate()
    const after = (await (await req(owner.token, '/api/workgroup-tasks/pending-count')).json()) as {
      deliveries: number
      gates: number
      total: number
    }
    expect(after.gates).toBe(1)
    expect(after.total).toBe(2)
  })
})
