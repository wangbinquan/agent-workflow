// RFC-182 T1 —— 房间执行体验后端锁（runHistory 派生锁在
// rfc179-member-current-run.test.ts 的 RFC-182 describe；引擎 mint→pending 帧
// 锁在 rfc164-workgroup-engine.test.ts）。本文件锁：
//   - 外部 mint 点（taskQuestionDispatch）对 wg 宿主节点的 pending 帧（设计门
//     P2：clarify-answer 续跑经 adoptedRunId 进引擎、引擎侧不再发帧，而
//     clarify.answered 不失效房间 key——不在外部 mint 发帧，续跑开跑前对房间
//     不可见）。源级锁：广播块存在 + 引擎 broadcastPendingMint 恒「一 mint 一帧」
//     （1 定义 + 3 调用，全部位于真 mint 分支内）。
//   - getTaskNodeRuns 响应 mapper 带出 rerunCause（P1-3 勘误缝位：routes 是薄
//     委托、无 select 可加——wire 缝在 services/task.ts 的手写 mapper）。

import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { mintNodeRun } from '../src/services/nodeRunMint'
import { getTaskNodeRuns } from '../src/services/task'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SRC = (p: string): string => readFileSync(resolve(import.meta.dir, '..', 'src', p), 'utf8')

describe('RFC-182 — pending 帧源级锁', () => {
  test('taskQuestionDispatch：提交后对 wg 宿主 mint 广播 pending（外部 mint 点）', () => {
    const src = SRC('services/taskQuestionDispatch.ts')
    const block = src.slice(src.indexOf('if (!committed) return EMPTY_RESULT'))
    expect(block).toContain('WG_LEADER_NODE_ID')
    expect(block).toContain('WG_MEMBER_NODE_ID')
    expect(block).toContain("status: 'pending'")
  })

  test('workgroupRunner：broadcastPendingMint 恒 1 定义 + 3 真 mint 调用（adopted 不重发）', () => {
    const src = SRC('services/workgroupRunner.ts')
    expect(src.split('broadcastPendingMint(').length - 1).toBe(4)
  })
})

describe('RFC-182 P1-3 — getTaskNodeRuns 响应带 rerunCause', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('mapper 透出 mint cause（wg 历轮标签的 wire 依据）', async () => {
    const taskId = ulid()
    const wfId = ulid()
    await db.insert(workflows).values({ id: wfId, name: `wf-${wfId}`, definition: '{}' })
    await db.insert(tasks).values({
      id: taskId,
      name: 'rfc182-wire',
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/never-read',
      worktreePath: '/tmp/never-read-wt',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
    })
    const runId = await mintNodeRun(db, {
      taskId,
      nodeId: '__wg_member__',
      status: 'pending',
      cause: 'wg-message-turn',
      overrides: { shardKey: 'msg:m-x:0' },
    })
    const { runs } = await getTaskNodeRuns(db, taskId)
    const run = runs.find((r) => r.id === runId)
    expect(run?.rerunCause).toBe('wg-message-turn')
  })
})
