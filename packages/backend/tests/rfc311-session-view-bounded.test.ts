// RFC-311 T13 —— 会话树的 DB 读有界，**且超限时根仍然正确**。
//
// 归档侧早就有 `ARCHIVED_SESSION_EVENT_CAP`，DB 侧此前无上限：长会话下一次请求就把
// 该任务的全部事件取回，跑在 daemon 唯一的同步连接上。
//
// 但这里**不能像 stdout 那样只保尾**——`sessionView.ts` 里已经记着一次真事故：会话
// 前半段一旦缺失，`deriveRootSessionId` 会退化成「取残留事件里的第一个 sessionId」
// （通常是**子代理**会话），整棵树以子代理为根渲染。那不是少了历史，是渲染出**错误
// 结构**。所以读法是「最早 PREFIX 条（定根）+ 最新 TAIL 条（近期内容）」。
//
// 这条测试就是钉住那个分界：把上限压到几十条、让事件远超上限，然后断言
//   1. 根仍是**父**会话（朴素保尾会在这里变成子代理，是本测试存在的全部理由）；
//   2. 最近的内容还在（尾巴没被前缀挤掉）。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRunEvents, nodeRuns, tasks, users, workflows } from '../src/db/schema'
import { getSessionTree } from '../src/services/sessionView'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const PARENT = 'ses_parent'
const CHILD = 'ses_child'

async function seed(db: DbClient, childEventCount: number): Promise<void> {
  await db.insert(users).values({
    id: 'u1',
    username: 'u1',
    displayName: 'u1',
    role: 'admin',
    createdAt: 1,
    updatedAt: 1,
  })
  const snapshot = JSON.stringify({
    nodes: [{ id: 'n1', kind: 'agent-single', data: { agentName: 'worker' } }],
    edges: [],
  })
  await db.insert(workflows).values({ id: 'wf1', name: 'wf', definition: snapshot })
  await db.insert(tasks).values({
    id: 't1',
    name: 't1',
    workflowId: 'wf1',
    workflowSnapshot: snapshot,
    repoPath: '/r',
    worktreePath: '/w',
    baseBranch: 'main',
    branch: 'b',
    status: 'done',
    inputs: '{}',
    startedAt: 1,
    runningMs: 0,
    ownerUserId: 'u1',
    invocationDepth: 0,
    launchOrigin: 'manual',
    branchStartedAt: 1,
    rootTaskId: 't1',
  })
  await db.insert(nodeRuns).values({
    id: 'nr1',
    taskId: 't1',
    nodeId: 'n1',
    status: 'done',
    retryIndex: 0,
    startedAt: 1,
    promptText: 'do the work',
    opencodeSessionId: PARENT,
  })

  let id = 1
  // 最早的几条属于**父**会话——定根靠它们。
  for (let i = 0; i < 3; i += 1) {
    await db.insert(nodeRunEvents).values({
      id: id++,
      nodeRunId: 'nr1',
      ts: id,
      kind: 'text',
      sessionId: PARENT,
      parentSessionId: null,
      payload: `parent-open-${i}`,
    })
  }
  // 中间一大段全是**子代理**会话：朴素保尾只会看到它们，于是把子代理当成根。
  for (let i = 0; i < childEventCount; i += 1) {
    await db.insert(nodeRunEvents).values({
      id: id++,
      nodeRunId: 'nr1',
      ts: id,
      kind: 'text',
      sessionId: CHILD,
      parentSessionId: PARENT,
      payload: `child-${i}`,
    })
  }
  await db.insert(nodeRunEvents).values({
    id: id++,
    nodeRunId: 'nr1',
    ts: id,
    kind: 'text',
    sessionId: CHILD,
    parentSessionId: PARENT,
    payload: 'LAST-EVENT',
  })
}

describe('RFC-311 T13 — 会话树 DB 读有界且根不退化', () => {
  test('事件远超上限时，根仍是父会话，且最近内容还在', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db, 120)
    // 压到远小于事件总数：前缀 5 条、尾巴 10 条，中间那段必然被舍弃。
    const { tree } = await getSessionTree(db, 't1', 'nr1', { rootPrefix: 5, tail: 10 })

    const serialized = JSON.stringify(tree)
    expect(serialized).toContain('LAST-EVENT')
    // 根必须仍是父会话——这正是朴素保尾会失守的地方。
    expect(serialized).toContain('parent-open-0')
  })

  test('未超限时行为不变（有界不改变正常情况）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db, 5)
    const bounded = await getSessionTree(db, 't1', 'nr1', { rootPrefix: 500, tail: 20_000 })
    const tight = await getSessionTree(db, 't1', 'nr1', { rootPrefix: 5, tail: 10 })
    // 9 条事件 < 5 + 10，两种上限下应当得到同一棵树
    expect(JSON.stringify(tight)).toBe(JSON.stringify(bounded))
  })
})
