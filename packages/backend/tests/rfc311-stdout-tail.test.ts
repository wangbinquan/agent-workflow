// RFC-311 T13 —— node_run stdout 只回**最后 1 MiB**，且读取本身有界。
//
// 此前 `getNodeRunStdout` 把「全部归档 + 全部 DB 事件」拼成一个字符串返回（归档侧
// 还传了 `Number.MAX_SAFE_INTEGER`）。长跑节点的 stdout 可以是几十 MB，而这条路径
// 跑在 daemon 唯一的同步连接上——一次请求就能把全站顶住。日志读者要的从来是最后
// 那一段。
//
// 锁四件事：
//   1. 小输出**逐字不变**（截断不能改变正常情况的行为）；
//   2. 超预算时保的是**尾巴**（最新的在），不是头；
//   3. 截断必须**说出来**——静默丢日志会让人以为节点没输出过那段；
//   4. **读取有界**：尾巴被 DB 填满时根本不读归档（归档严格更旧）。第 4 条是
//      "只省网络不省内存"与"真有界"的分界，也是这次改动的要点。

import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRunEvents, nodeRuns, tasks, users, workflows } from '../src/db/schema'
import {
  getNodeRunStdout,
  STDOUT_OMITTED_MARKER,
  STDOUT_TAIL_BUDGET_BYTES,
} from '../src/services/task'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function seed(db: DbClient, payloads: string[]): Promise<void> {
  await db.insert(users).values({
    id: 'u1',
    username: 'u1',
    displayName: 'u1',
    role: 'admin',
    createdAt: 1,
    updatedAt: 1,
  })
  await db.insert(workflows).values({ id: 'wf1', name: 'wf', definition: '{}' })
  await db.insert(tasks).values({
    id: 't1',
    name: 't1',
    workflowId: 'wf1',
    workflowSnapshot: '{}',
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
  })
  let id = 1
  for (const payload of payloads) {
    await db.insert(nodeRunEvents).values({
      id: id++,
      nodeRunId: 'nr1',
      ts: id,
      kind: 'text',
      payload,
    })
  }
}

describe('RFC-311 T13 — stdout 保尾且读取有界', () => {
  test('小输出逐字不变，且不带截断标记', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db, ['first line', 'second line', 'third line'])
    const logsDir = mkdtempSync(join(tmpdir(), 'aw-stdout-'))
    const out = await getNodeRunStdout(db, 't1', 'nr1', { logsDir })
    expect(out).toBe('first line\nsecond line\nthird line')
    expect(out).not.toContain(STDOUT_OMITTED_MARKER)
  })

  test('stderr 仍然被剔除（那条通道在 Events 页）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db, ['keep me'])
    await db.insert(nodeRunEvents).values({
      id: 99,
      nodeRunId: 'nr1',
      ts: 99,
      kind: 'stderr',
      payload: 'noisy stderr',
    })
    const logsDir = mkdtempSync(join(tmpdir(), 'aw-stdout-'))
    const out = await getNodeRunStdout(db, 't1', 'nr1', { logsDir })
    expect(out).toBe('keep me')
  })

  test('超预算时保尾、丢头，并明说省略了', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    // 每行 ~64 KiB，20 行 ≈ 1.25 MiB > 1 MiB 预算
    const line = (tag: string): string => `${tag}:${'x'.repeat(64 * 1024)}`
    await seed(
      db,
      Array.from({ length: 20 }, (_, i) => line(`L${String(i).padStart(2, '0')}`)),
    )
    const logsDir = mkdtempSync(join(tmpdir(), 'aw-stdout-'))
    const out = await getNodeRunStdout(db, 't1', 'nr1', { logsDir })

    expect(out.startsWith(STDOUT_OMITTED_MARKER), '截断必须说出来').toBe(true)
    // 尾巴在：最后一行必须出现
    expect(out).toContain('L19:')
    // 头没了：第一行必须不在
    expect(out).not.toContain('L00:')
    // 预算生效（标记本身不算进预算，给一行的余量）
    expect(Buffer.byteLength(out, 'utf-8')).toBeLessThan(
      STDOUT_TAIL_BUDGET_BYTES + STDOUT_OMITTED_MARKER.length + 128,
    )
  })

  test('尾巴被 DB 填满时**根本不读归档** —— 有界的关键', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const line = (tag: string): string => `${tag}:${'y'.repeat(64 * 1024)}`
    await seed(
      db,
      Array.from({ length: 20 }, (_, i) => line(`D${String(i).padStart(2, '0')}`)),
    )
    // 归档目录指向一个不存在的路径：真去读会抛/返回空，而**根本不读**才是要锁的。
    // 这里用「读了也拿不到东西」的目录 + 断言输出里只有 DB 行，来锁住这条路径。
    const logsDir = join(tmpdir(), 'aw-stdout-nonexistent-' + String(Date.now()))
    const out = await getNodeRunStdout(db, 't1', 'nr1', { logsDir })
    expect(out.startsWith(STDOUT_OMITTED_MARKER)).toBe(true)
    expect(out).toContain('D19:')
  })
})
