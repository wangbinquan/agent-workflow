// 2026-07-21 工作组实战夜的两条根治回归锁（配套 fc 预算豁免 67fa7cdc）。
//
// ① fc 只读成员盲派（实测：任务 01KY25DM…10B1 三次 ROLE MISROUTE）：
//    平台代领把落盘写活整批派给只读 agent（edit/write 双 deny），成员只能整批
//    报「NOT executable」→ 整批 attempt_count +1 → 反复错派烧穿 → failed。
//    修法：deriveWakeSet 的 1fc-b 新认领跳过只读成员（WakeInput.readonlyMemberIds，
//    引擎每 pass 从 agents.permission 推导）。边界（本文件逐条锁）：
//    - fc_initial（首轮拆解）与 message_turn 不过滤——只读角色的正当参与面；
//    - 恢复批（1fc-a dispatched 集结）不过滤——已派是既成事实，过滤=永久孤儿卡；
//    - 全员只读 ⇒ 回退不过滤（宁可旧行为错派，绝不制造 fc-deadlock）；
//    - 字段缺省 ⇒ 旧行为逐字不变。
//
// ② awaiting_human 成因链（用户实报困惑：wrap-up 停机被「等待回答」文案误导）：
//    引擎在返回 awaiting_human 前把 outcome.reason 写进 tasks.workgroup_config_json
//    的 wgPause 槽（json_set 单键原子，不 clobber gate/dw 兄弟键）；房间 API 经
//    resolveRoomPauseReason 输出——读方门槛：仅任务当前停在 awaiting_human 时
//    非 null，陈值永不外泄（槽因此无需清理）。

import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { WorkgroupAssignment, WorkgroupRuntimeConfig } from '@agent-workflow/shared'
import { createInMemoryDb } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import {
  deriveWakeSet,
  isReadonlyAgentPermission,
  type WakeInput,
  type WakeItem,
} from '../src/services/workgroupWake'
import { resolveRoomPauseReason } from '../src/routes/workgroupTasks'
import { writeWgPauseReason } from '../src/services/workgroupRunner'

// ---------------------------------------------------------------------------
// fixtures（形状照抄 rfc215-fc-dual-track.test.ts）
// ---------------------------------------------------------------------------

function fcCfg(overrides: Partial<WorkgroupRuntimeConfig> = {}): WorkgroupRuntimeConfig {
  return {
    workgroupId: 'wg1',
    workgroupName: 'squad',
    mode: 'free_collab',
    leaderMemberId: null,
    switches: { shareOutputs: true, directMessages: true, blackboard: true },
    maxRounds: 40,
    completionGate: false,
    instructions: 'x',
    goal: 'g',
    members: [
      {
        id: 'm-a',
        memberType: 'agent',
        agentName: 'a',
        userId: null,
        displayName: 'A',
        roleDesc: '',
      },
      {
        id: 'm-b',
        memberType: 'agent',
        agentName: 'b',
        userId: null,
        displayName: 'B',
        roleDesc: '',
      },
      {
        id: 'm-c',
        memberType: 'agent',
        agentName: 'c',
        userId: null,
        displayName: 'C',
        roleDesc: '',
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
    round: 0,
    source: 'self_claim',
    createdByRunId: null,
    createdByUserId: null,
    assigneeMemberId: null,
    title: `task ${seq}`,
    briefMd: 'x',
    status: 'open',
    nodeRunId: null,
    resultMessageId: null,
    dedupKey: null,
    attemptCount: 0,
    createdAt: seq,
    updatedAt: seq,
    ...overrides,
  } as WorkgroupAssignment
}

function input(overrides: Partial<WakeInput> = {}): WakeInput {
  return {
    config: fcCfg(),
    assignments: [],
    messages: [],
    cursors: new Map(),
    inFlight: {
      leaderRunning: false,
      runningAssignmentIds: new Set(),
      messageTurnMemberIds: new Set(),
      taskTurnMemberIds: new Set(),
    },
    roundsUsed: 5,
    gate: { declaredDone: false, awaitingConfirmation: false, rejected: false },
    ...overrides,
  }
}

const claims = (items: readonly WakeItem[]) =>
  items.filter((i): i is Extract<WakeItem, { kind: 'fc_claim' }> => i.kind === 'fc_claim')

// ---------------------------------------------------------------------------
// ① isReadonlyAgentPermission —— 保守判定矩阵
// ---------------------------------------------------------------------------

describe('isReadonlyAgentPermission — 只有显式 edit+write 双 deny 才算只读', () => {
  test('本仓只读代理的既有形状 ⇒ true', () => {
    // task-completion-checker / code-auditor / refactor-analyst 的实际形状
    expect(
      isReadonlyAgentPermission({
        read: 'allow',
        edit: 'deny',
        write: 'deny',
        bash: { '*': 'deny', 'ls *': 'allow' },
        glob: 'allow',
        grep: 'allow',
      }),
    ).toBe(true)
  })

  test('缺省 / 单边 deny / ask / 对象形 / 非对象 ⇒ 一律可写（false）', () => {
    expect(isReadonlyAgentPermission({})).toBe(false)
    expect(isReadonlyAgentPermission({ edit: 'deny' })).toBe(false) // write 缺省
    expect(isReadonlyAgentPermission({ edit: 'deny', write: 'ask' })).toBe(false)
    expect(isReadonlyAgentPermission({ edit: { '*': 'deny' }, write: 'deny' })).toBe(false) // 对象形不展开
    expect(isReadonlyAgentPermission(null)).toBe(false)
    expect(isReadonlyAgentPermission(undefined)).toBe(false)
    expect(isReadonlyAgentPermission('deny')).toBe(false)
    expect(isReadonlyAgentPermission([])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ① deriveWakeSet —— 新认领跳过只读成员的四条边界
// ---------------------------------------------------------------------------

describe('fc 新认领跳过只读成员（2026-07-21 ROLE-MISROUTE 回归）', () => {
  test('只读成员不参与新认领：open 卡全部配给可写成员', () => {
    const cards = [asg(), asg(), asg(), asg()]
    const w = deriveWakeSet(input({ assignments: cards, readonlyMemberIds: new Set(['m-a']) }))
    const got = claims(w.items)
    expect(got.length).toBeGreaterThan(0)
    expect(got.every((c) => c.memberId !== 'm-a')).toBe(true)
    // 4 张卡全部被 m-b / m-c 认领走，没有卡因过滤而滞留
    expect(got.flatMap((c) => c.assignmentIds).length).toBe(4)
  })

  test('全员只读 ⇒ 回退不过滤（绝不 fc-deadlock）——行为与缺省逐字一致', () => {
    const cards = [asg(), asg()]
    const all = new Set(['m-a', 'm-b', 'm-c'])
    const filtered = deriveWakeSet(input({ assignments: cards, readonlyMemberIds: all }))
    const baseline = deriveWakeSet(input({ assignments: cards }))
    expect(claims(filtered.items)).toEqual(claims(baseline.items))
    expect(claims(filtered.items).length).toBeGreaterThan(0)
  })

  test('恢复批（dispatched 集结）不过滤：只读 assignee 的既派卡照常恢复', () => {
    const card = asg({ status: 'dispatched', assigneeMemberId: 'm-a' })
    const w = deriveWakeSet(input({ assignments: [card], readonlyMemberIds: new Set(['m-a']) }))
    const got = claims(w.items)
    expect(got.length).toBe(1)
    expect(got[0]?.memberId).toBe('m-a')
    expect(got[0]?.assignmentIds).toEqual([card.id])
  })

  test('fc_initial 首轮拆解不过滤：只读成员照常参与', () => {
    const w = deriveWakeSet(
      input({ roundsUsed: 0, readonlyMemberIds: new Set(['m-a', 'm-b', 'm-c']) }),
    )
    const inits = w.items.filter((i) => i.kind === 'fc_initial')
    expect(inits.length).toBe(3)
  })

  test('字段缺省 ⇒ 旧行为逐字不变（roster 序均分含全部成员）', () => {
    const cards = [asg(), asg(), asg()]
    const w = deriveWakeSet(input({ assignments: cards }))
    const members = claims(w.items).map((c) => c.memberId)
    expect(members).toEqual(['m-a', 'm-b', 'm-c'])
  })
})

// ---------------------------------------------------------------------------
// ② resolveRoomPauseReason —— 读方门槛矩阵
// ---------------------------------------------------------------------------

describe('resolveRoomPauseReason — 仅 awaiting_human 时外泄，陈值屏蔽', () => {
  test('awaiting_human + 合法槽 ⇒ reason', () => {
    expect(
      resolveRoomPauseReason('awaiting_human', { wgPause: { reason: 'max-rounds-wrapup' } }),
    ).toBe('max-rounds-wrapup')
  })

  test('非 awaiting_human ⇒ 恒 null（陈值屏蔽——running/done/interrupted 全覆盖）', () => {
    for (const st of ['running', 'done', 'failed', 'interrupted', 'awaiting_review']) {
      expect(resolveRoomPauseReason(st, { wgPause: { reason: 'max-rounds-wrapup' } })).toBeNull()
    }
  })

  test('槽缺失 / 形状坏 ⇒ null', () => {
    expect(resolveRoomPauseReason('awaiting_human', {})).toBeNull()
    expect(resolveRoomPauseReason('awaiting_human', { wgPause: null })).toBeNull()
    expect(resolveRoomPauseReason('awaiting_human', { wgPause: 'wrapup' })).toBeNull()
    expect(resolveRoomPauseReason('awaiting_human', { wgPause: ['x'] })).toBeNull()
    expect(resolveRoomPauseReason('awaiting_human', { wgPause: { reason: '' } })).toBeNull()
    expect(resolveRoomPauseReason('awaiting_human', { wgPause: { reason: 7 } })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// ② writeWgPauseReason —— json_set 单键原子：写 reason 不 clobber 兄弟键
// ---------------------------------------------------------------------------

describe('writeWgPauseReason — 单键原子更新（DB 级）', () => {
  test('写入 wgPause 保留 gate/dw 等兄弟键；重复写幂等覆盖；NULL config 起底为 {}', async () => {
    const db = createInMemoryDb(new URL('../db/migrations', import.meta.url).pathname)
    const wfId = ulid()
    await db.insert(workflows).values({ id: wfId, name: 'wf-pause', definition: '{}' })
    const taskId = ulid()
    await db.insert(tasks).values({
      id: taskId,
      name: 'pause-slot-task',
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/never-read',
      worktreePath: '/tmp/never-read-wt',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'awaiting_human',
      inputs: '{}',
      startedAt: Date.now(),
      workgroupConfigJson: JSON.stringify({ gate: { declaredDone: true }, maxRounds: 9 }),
    })

    await writeWgPauseReason(db, taskId, 'max-rounds-wrapup')
    let raw = JSON.parse(
      (await db.select({ c: tasks.workgroupConfigJson }).from(tasks).where(eq(tasks.id, taskId)))[0]
        ?.c as string,
    ) as Record<string, unknown>
    expect(raw.wgPause).toEqual({ reason: 'max-rounds-wrapup' })
    expect(raw.gate).toEqual({ declaredDone: true }) // 兄弟键无损
    expect(raw.maxRounds).toBe(9)

    await writeWgPauseReason(db, taskId, 'leader-idle')
    raw = JSON.parse(
      (await db.select({ c: tasks.workgroupConfigJson }).from(tasks).where(eq(tasks.id, taskId)))[0]
        ?.c as string,
    ) as Record<string, unknown>
    expect(raw.wgPause).toEqual({ reason: 'leader-idle' })

    // NULL config（非工作组任务防御位）：json_set 从 '{}' 起底
    const bareId = ulid()
    await db.insert(tasks).values({
      id: bareId,
      name: 'bare-task',
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/never-read',
      worktreePath: '/tmp/never-read-wt2',
      baseBranch: 'main',
      branch: `agent-workflow/${bareId}`,
      status: 'awaiting_human',
      inputs: '{}',
      startedAt: Date.now(),
    })
    await writeWgPauseReason(db, bareId, 'engine-stall')
    const bare = JSON.parse(
      (await db.select({ c: tasks.workgroupConfigJson }).from(tasks).where(eq(tasks.id, bareId)))[0]
        ?.c as string,
    ) as Record<string, unknown>
    expect(bare.wgPause).toEqual({ reason: 'engine-stall' })
  })
})
