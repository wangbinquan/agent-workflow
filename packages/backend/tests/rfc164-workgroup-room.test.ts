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
import { createAgent } from '../src/services/agent'
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

async function seedAgent(db: DbClient, name: string): Promise<void> {
  await createAgent(db, {
    name,
    description: '',
    outputs: ['result'],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: 'test agent',
  })
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

    // RFC-182 — the aggregate also carries the FULL run history (ascending),
    // with the member's displayName frozen on and the assignment id resolved.
    const withHistory = (await (
      await req(owner.token, `/api/workgroup-tasks/${taskId}/room`)
    ).json()) as {
      runHistory: Array<{
        nodeRunId: string
        memberId: string
        displayName: string | null
        kind: string
        assignmentId: string | null
        note: string | null
      }>
    }
    expect(withHistory.runHistory).toHaveLength(1)
    expect(withHistory.runHistory[0]).toMatchObject({
      nodeRunId: runId,
      memberId: 'm-coder',
      displayName: 'coder',
      kind: 'assignment',
      assignmentId,
      note: null,
    })
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
    // 上线前加固（2026-07-18）：409 必须是零副作用。旧实现先 INSERT
    // delivery message 再 CAS 卡片，重复提交虽然返回 409，房间里却会留下
    // 一条幽灵答案。
    const afterDuplicate = await db
      .select()
      .from(workgroupMessages)
      .where(eq(workgroupMessages.taskId, taskId))
    expect(afterDuplicate.filter((m) => m.kind === 'delivery')).toHaveLength(2)
    expect(afterDuplicate.some((m) => m.bodyMd === 'again')).toBe(false)
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
    // Atomic confirm now performs the same worktree preflight as every resume.
    // Use an existing directory for this positive path; the missing-worktree
    // rollback contract is locked separately below.
    await db
      .update(tasks)
      .set({ worktreePath: import.meta.dir })
      .where(eq(tasks.id, taskId))
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
    await db
      .update(tasks)
      .set({ worktreePath: import.meta.dir })
      .where(eq(tasks.id, taskId))
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

  test('上线前加固：confirm 恢复失败时 gate、holder 与消息全部保持可重试', async () => {
    await openGate()
    const beforeMessages = await db
      .select()
      .from(workgroupMessages)
      .where(eq(workgroupMessages.taskId, taskId))

    // beforeEach deliberately points at /tmp/x-wt, which does not exist. The
    // old fire-and-forget path returned 200, closed the gate + holder, then only
    // logged the failed resume — permanently stranding the task.
    const res = await req(owner.token, `/api/workgroup-tasks/${taskId}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approve' }),
    })
    expect(res.status).toBe(410)

    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    const raw = JSON.parse(task?.workgroupConfigJson ?? '{}') as {
      gate: { approved: boolean; awaitingConfirmation: boolean }
    }
    expect(task?.status).toBe('awaiting_review')
    expect(raw.gate.approved).toBe(false)
    expect(raw.gate.awaitingConfirmation).toBe(true)
    const holders = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
      (r) => r.rerunCause === 'wg-gate',
    )
    expect(holders).toHaveLength(1)
    expect(holders[0]?.status).toBe('awaiting_review')
    const afterMessages = await db
      .select()
      .from(workgroupMessages)
      .where(eq(workgroupMessages.taskId, taskId))
    expect(afterMessages).toHaveLength(beforeMessages.length)
  })

  test('gate 未开时 confirm → 409', async () => {
    const res = await req(owner.token, `/api/workgroup-tasks/${taskId}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approve' }),
    })
    expect(res.status).toBe(409)
  })

  test('config patch：加成员游标=当前尾（不补历史）、减成员卡转置、leader 不可删、重名拒', async () => {
    await seedAgent(db, 'late-joiner')
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

  // RFC-099 audit (2026-07-15): mid-run addMembers of a HUMAN must write a
  // task_collaborators row (like the launch-time T24 union), else the joiner
  // can't open the room / receive cards — canViewTask keys off that table.
  test('RFC-099 audit: adding a human member writes task_collaborators so they can enter the room', async () => {
    const { taskCollaborators } = await import('../src/db/schema')
    const bobU = await createUser(db, {
      username: 'bob5',
      displayName: 'bob5',
      role: 'user',
      password: 'longEnoughPassword',
    })
    const bob = { id: bobU.id, token: (await createSession({ db, userId: bobU.id })).token }

    // Before joining, bob is not a task member → the room 404s (D20).
    const before = await req(bob.token, `/api/workgroup-tasks/${taskId}/room`)
    expect(before.status).toBe(404)

    const add = await req(owner.token, `/api/workgroup-tasks/${taskId}/config`, {
      method: 'PUT',
      body: JSON.stringify({
        addMembers: [{ memberType: 'human', userId: bob.id, displayName: 'bob', roleDesc: '把关' }],
      }),
    })
    expect(add.status).toBe(200)

    // The human member is now a task_collaborators row (the fix) …
    const collab = await db
      .select()
      .from(taskCollaborators)
      .where(eq(taskCollaborators.taskId, taskId))
    expect(collab.some((r) => r.userId === bob.id && r.role === 'collaborator')).toBe(true)

    // … so bob can actually open the room.
    const after = await req(bob.token, `/api/workgroup-tasks/${taskId}/room`)
    expect(after.status).toBe(200)
  })

  test('RFC-099 audit: adding an unknown / non-active human member is rejected 422', async () => {
    const add = await req(owner.token, `/api/workgroup-tasks/${taskId}/config`, {
      method: 'PUT',
      body: JSON.stringify({
        addMembers: [
          { memberType: 'human', userId: 'no_such_user', displayName: 'ghost', roleDesc: '' },
        ],
      }),
    })
    expect(add.status).toBe(422)
  })

  test('上线前加固：已删除的 agent 不能在运行中加入 roster', async () => {
    const add = await req(owner.token, `/api/workgroup-tasks/${taskId}/config`, {
      method: 'PUT',
      body: JSON.stringify({
        addMembers: [
          {
            memberType: 'agent',
            agentName: 'deleted-agent',
            displayName: 'deleted',
            roleDesc: '',
          },
        ],
      }),
    })
    expect(add.status).toBe(422)
    const raw = JSON.parse(
      (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.workgroupConfigJson ?? '{}',
    ) as { members: Array<{ displayName: string }> }
    expect(raw.members.some((m) => m.displayName === 'deleted')).toBe(false)
  })

  test('上线前加固：运行中的成员不可从 roster 移除', async () => {
    const cardId = ulid()
    await db.insert(workgroupAssignments).values({
      id: cardId,
      taskId,
      round: 1,
      source: 'leader',
      assigneeMemberId: 'm-coder',
      title: 'still running',
      briefMd: 'the runtime still owns this member',
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const remove = await req(owner.token, `/api/workgroup-tasks/${taskId}/config`, {
      method: 'PUT',
      body: JSON.stringify({ removeMemberIds: ['m-coder'] }),
    })
    expect(remove.status).toBe(409)
    const raw = JSON.parse(
      (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.workgroupConfigJson ?? '{}',
    ) as { members: Array<{ id: string }> }
    expect(raw.members.some((m) => m.id === 'm-coder')).toBe(true)
    expect(
      (await db.select().from(workgroupAssignments).where(eq(workgroupAssignments.id, cardId)))[0]
        ?.status,
    ).toBe('running')
  })

  test('上线前加固：无效 config patch 返回 422 时不取消卡片、不写游标、不改 roster', async () => {
    const cardId = ulid()
    await db.insert(workgroupAssignments).values({
      id: cardId,
      taskId,
      round: 1,
      source: 'leader',
      assigneeMemberId: 'm-coder',
      title: 'must survive rejected patch',
      briefMd: 'validation must precede durable side effects',
      status: 'dispatched',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await db.insert(workgroupMessages).values({
      id: ulid(),
      taskId,
      round: 0,
      authorKind: 'system',
      kind: 'system',
      bodyMd: 'cursor tail',
      mentionsJson: '[]',
      createdAt: Date.now(),
    })
    const { workgroupMemberCursors } = await import('../src/db/schema')
    const beforeCursorCount = (
      await db
        .select()
        .from(workgroupMemberCursors)
        .where(eq(workgroupMemberCursors.taskId, taskId))
    ).length

    // Removal used to cancel m-coder's card before the later human validation
    // discovered that ghost-user did not exist.
    const rejected = await req(owner.token, `/api/workgroup-tasks/${taskId}/config`, {
      method: 'PUT',
      body: JSON.stringify({
        removeMemberIds: ['m-coder'],
        addMembers: [
          {
            memberType: 'human',
            userId: 'ghost-user',
            displayName: 'ghost',
            roleDesc: '',
          },
        ],
      }),
    })
    expect(rejected.status).toBe(422)
    expect(
      (await db.select().from(workgroupAssignments).where(eq(workgroupAssignments.id, cardId)))[0]
        ?.status,
    ).toBe('dispatched')
    const raw = JSON.parse(
      (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.workgroupConfigJson ?? '{}',
    ) as { members: Array<{ id: string; displayName: string }> }
    expect(raw.members.some((m) => m.id === 'm-coder')).toBe(true)
    expect(raw.members.some((m) => m.displayName === 'ghost')).toBe(false)
    const afterCursorCount = (
      await db
        .select()
        .from(workgroupMemberCursors)
        .where(eq(workgroupMemberCursors.taskId, taskId))
    ).length
    expect(afterCursorCount).toBe(beforeCursorCount)
  })

  // RFC-181 A/A2 — autonomous 进 per-task PATCH（对称 on/off + system 消息），
  // false→true 单事务遣散在途 clarify park 并 requeue 卡（design §2.1/§2.1a）。
  test('RFC-181：PATCH autonomous 往返 + false→true 遣散在途 clarify park', async () => {
    const { clarifySessions } = await import('../src/db/schema')
    const { mintNodeRun } = await import('../src/services/nodeRunMint')

    // A：接受 autonomous、写 config、changes 文案。
    const on = await req(owner.token, `/api/workgroup-tasks/${taskId}/config`, {
      method: 'PUT',
      body: JSON.stringify({ autonomous: true }),
    })
    expect(on.status).toBe(200)
    const changes = ((await on.json()) as { changes: string[] }).changes
    expect(changes.some((c) => c.includes('autonomous → true'))).toBe(true)
    const readCfg = async (): Promise<{ autonomous?: boolean }> =>
      JSON.parse(
        (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.workgroupConfigJson ?? '{}',
      ) as { autonomous?: boolean }
    expect((await readCfg()).autonomous).toBe(true)

    // 对称 off（true→false 不触发遣散路径）。
    const off = await req(owner.token, `/api/workgroup-tasks/${taskId}/config`, {
      method: 'PUT',
      body: JSON.stringify({ autonomous: false }),
    })
    expect(off.status).toBe(200)
    expect((await readCfg()).autonomous).toBe(false)

    // A2：seed 一个 worker clarify park（awaiting_human 卡 + 中介 park run +
    // open session），翻 on → 遣散 + requeue + changes 附遣散计数。
    const cardId = ulid()
    await db.insert(workgroupAssignments).values({
      id: cardId,
      taskId,
      round: 1,
      source: 'leader',
      assigneeMemberId: 'm-coder',
      title: 'blocked-on-question',
      briefMd: 'ask first',
      status: 'awaiting_human',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const clarifyRunId = await mintNodeRun(db, {
      taskId,
      nodeId: '__wg_clarify__',
      status: 'awaiting_human',
      cause: 'clarify-park',
      overrides: { shardKey: cardId, startedAt: Date.now() },
    })
    const sessionId = ulid()
    await db.insert(clarifySessions).values({
      id: sessionId,
      taskId,
      sourceAgentNodeId: '__wg_member__',
      sourceAgentNodeRunId: ulid(),
      sourceShardKey: cardId,
      clarifyNodeId: '__wg_clarify__',
      clarifyNodeRunId: clarifyRunId,
      iterationIndex: 0,
      questionsJson: JSON.stringify([{ id: 'q1', question: '哪个口径？' }]),
      status: 'awaiting_human',
      createdAt: Date.now(),
    })
    const on2 = await req(owner.token, `/api/workgroup-tasks/${taskId}/config`, {
      method: 'PUT',
      body: JSON.stringify({ autonomous: true }),
    })
    expect(on2.status).toBe(200)
    const changes2 = ((await on2.json()) as { changes: string[] }).changes
    expect(changes2.some((c) => c.includes('dismissed 1 open clarify session'))).toBe(true)
    expect(
      (await db.select().from(clarifySessions).where(eq(clarifySessions.id, sessionId)))[0]?.status,
    ).toBe('canceled')
    expect(
      (await db.select().from(workgroupAssignments).where(eq(workgroupAssignments.id, cardId)))[0]
        ?.status,
    ).toBe('dispatched')

    // true→true：no-op（无遣散计数，仍是合法 patch——附带 completionGate 改动）。
    const on3 = await req(owner.token, `/api/workgroup-tasks/${taskId}/config`, {
      method: 'PUT',
      body: JSON.stringify({ autonomous: true, completionGate: false }),
    })
    expect(on3.status).toBe(200)
    const changes3 = ((await on3.json()) as { changes: string[] }).changes
    expect(changes3.some((c) => c.includes('dismissed'))).toBe(false)
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
