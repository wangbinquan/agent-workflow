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

import { nodeRunFixture, taskFixture, workflowFixture } from './helpers/model'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { describeEachProvider } from './helpers/eachProvider'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { contentRefColumns } from '@/platform/content/contentStore'
import { legacyContentRef } from '@/platform/content/contentRef'
import { seedNodeRunDisplayEvidence } from './helpers/rfc395Q1Evidence'

import { createTaskExecutionReadModels } from '../src/modules/task-execution/infrastructure/taskExecutionReadModels'
import { getSessionTree } from '../src/services/sessionView'

const PARENT = 'ses_parent'
const CHILD = 'ses_child'

async function seed(db: PersistenceDb, childEventCount: number): Promise<void> {
  const { users, nodeRunEvents } = tablesOf(db)
  await insertOne(db, users, {
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
  await workflowFixture(db, { id: 'wf1', name: 'wf', definition: snapshot })
  await taskFixture(db, {
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
  await nodeRunFixture(db, {
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
    await insertOne(db, nodeRunEvents, {
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
    await insertOne(db, nodeRunEvents, {
      id: id++,
      nodeRunId: 'nr1',
      ts: id,
      kind: 'text',
      sessionId: CHILD,
      parentSessionId: PARENT,
      payload: `child-${i}`,
    })
  }
  await insertOne(db, nodeRunEvents, {
    id: id++,
    nodeRunId: 'nr1',
    ts: id,
    kind: 'text',
    sessionId: CHILD,
    parentSessionId: PARENT,
    payload: 'LAST-EVENT',
  })
}

describeEachProvider('RFC-311 T13 — 会话树 DB 读有界且根不退化', (harness) => {
  test('BF-D24 only same-session runs load prompts, including NULL sessions restored from evidence', async () => {
    const db = harness.db
    await seed(db, 0)
    const { nodeRuns, nodeRunConfigs } = tablesOf(db)
    for (const [id, session] of [
      ['sibling', PARENT],
      ...Array.from({ length: 12 }, (_, i) => [`other-${i}`, 'other-session'] as const),
    ] as const) {
      await nodeRunFixture(db, {
        id,
        taskId: 't1',
        nodeId: id,
        status: 'done',
        startedAt: 2,
        opencodeSessionId: session,
        promptText: 'placeholder',
      })
      const ref = contentRefColumns.encode(legacyContentRef('prompt-test', 'database-bytes', id))
      await db
        .update(nodeRunConfigs)
        .set({ promptRefJson: ref.json, promptInlineBytes: null })
        .where(eq(nodeRunConfigs.nodeRunId, id))
    }
    await db.insert(nodeRuns).values({
      id: 'history-sibling',
      taskId: 't1',
      nodeId: 'removed',
      seq: 15,
      generationSeq: 0,
      status: 'done',
      role: null,
      slotKey: null,
      attemptIndex: null,
      scopePath: null,
      recordMode: 'history-only',
      provenanceQuality: 'unknown',
      envelopeNonce: null,
    })
    await seedNodeRunDisplayEvidence(db, 't1', 'history-sibling', {
      retry_index: 7,
      scope_path: 'legacy:2',
      opencode_session_id: PARENT,
      prompt_text: 'Original history prompt',
      started_at: 3,
    })
    const contentReads: unknown[] = []
    const recording = harness.recordStatements()
    try {
      const found = await createTaskExecutionReadModels(db, {
        async read(ref) {
          contentReads.push(ref.location.value)
          return new TextEncoder().encode(`database prompt for ${String(ref.location.value)}`)
        },
      }).sessions.find({ taskId: 't1', nodeRunId: 'nr1', rootPrefixCap: 5, tailCap: 10 })
      expect(found.status).toBe('found')
      if (found.status !== 'found') throw new Error('session fixture not found')
      expect(found.siblings.map((row) => row.id)).toEqual(['nr1', 'sibling', 'history-sibling'])
      expect(found.siblings[1]?.promptText).toBe('database prompt for sibling')
      expect(found.siblings[2]).toMatchObject({
        opencodeSessionId: PARENT,
        retryIndex: 7,
        promptText: 'Original history prompt',
      })
      expect(contentReads).toEqual(['sibling'])
    } finally {
      recording.stop()
    }
    const promptQueries = recording.statements.filter((row) =>
      row.sql.includes('prompt_inline_bytes'),
    )
    expect(promptQueries.map((row) => row.rows)).toEqual([1, 3])
    expect(promptQueries.every((row) => /where.*"node_runs"\."id"/i.test(row.sql))).toBe(true)
  })

  test('事件远超上限时，根仍是父会话，且最近内容还在', async () => {
    const db = harness.db
    await seed(db, 120)
    // 压到远小于事件总数：前缀 5 条、尾巴 10 条，中间那段必然被舍弃。
    const { tree } = await getSessionTree(createTaskExecutionReadModels(db).sessions, 't1', 'nr1', {
      rootPrefix: 5,
      tail: 10,
    })

    const serialized = JSON.stringify(tree)
    expect(serialized).toContain('LAST-EVENT')
    // 根必须仍是父会话——这正是朴素保尾会失守的地方。
    expect(serialized).toContain('parent-open-0')
  })

  test('未超限时行为不变（有界不改变正常情况）', async () => {
    const db = harness.db
    await seed(db, 5)
    const sessions = createTaskExecutionReadModels(db).sessions
    const bounded = await getSessionTree(sessions, 't1', 'nr1', {
      rootPrefix: 500,
      tail: 20_000,
    })
    const tight = await getSessionTree(sessions, 't1', 'nr1', { rootPrefix: 5, tail: 10 })
    // 9 条事件 < 5 + 10，两种上限下应当得到同一棵树
    expect(JSON.stringify(tight)).toBe(JSON.stringify(bounded))
  })
})
