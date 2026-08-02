// RFC-248 迁移表第 4/10 行 —— **存量定时任务 payload** 里的 `repos[]`。
//
// 这条是实现门自查发现的真缺口。把顶层 `repos` 加进 `RETIRED_START_TASK_KEYS`
// 之后，存量的多仓定时任务 payload 会开始被 RFC-165 的自愈扫描捡起来，但那段
// 扫描原本只认识 `repoPath` / `baseBranch` / `fetchBeforeLaunch`：
//
//   - `repos` 让 `rejectRetiredStartTaskKeys` 返回非 null ⇒ 这行「不干净」；
//   - 扫描进来，删掉几个**别的**键、写回、计一次 converted；
//   - `repos` 还在 ⇒ 下一轮再来一遍，**永远清不干净**；
//   - 与此同时计划照旧到点触发，每次 422。
//
// 也就是「一堆反复失败的启用中计划」——设计第 10 行专门要防的烂账，只是这次
// 从存量 payload 那一侧进来。修法分两种：
//
//   - **1 条** `repos`：语义上就是单仓（RFC-066 时代 length-1 走的正是单仓码
//     路径），摊平进顶层字段、删掉数组，payload 变干净，计划继续可用。
//   - **≥2 条**：**无法自愈**——框架没法替用户凭空造一个仓库组（挂载布局 /
//     ref / 只读是人的设计意图，不是能从两个 URL 推出来的）。停发并说清怎么改。

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { rejectRetiredStartTaskKeys } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { scheduledTasks } from '../src/db/schema'
import { healScheduledLaunchPayloads } from '../src/services/scheduledTasks'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

let db: DbClient
beforeEach(() => {
  db = createInMemoryDb(MIGRATIONS)
})

function seed(payload: unknown): string {
  const id = ulid()
  const now = Date.now()
  db.insert(scheduledTasks)
    .values({
      id,
      name: 's',
      ownerUserId: 'u1',
      launchKind: 'workflow',
      launchPayload: JSON.stringify(payload),
      scheduleSpec: JSON.stringify({ kind: 'interval', everyMs: 60_000, tz: 'UTC' }),
      enabled: true,
      nextRunAt: now + 60_000,
      consecutiveFailures: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  return id
}

const read = (id: string) => db.select().from(scheduledTasks).where(eq(scheduledTasks.id, id)).get()
const payloadOf = (id: string) => JSON.parse(read(id)!.launchPayload) as Record<string, unknown>

describe('RFC-248 —— 存量 repos[] 定时任务 payload', () => {
  test('单条 repos ⇒ 摊平进顶层单仓字段并删除数组，payload 变 v2-clean', async () => {
    const id = seed({
      workflowId: 'wf',
      name: 't',
      inputs: {},
      repos: [{ repoUrl: 'https://git.example/a.git', ref: 'dev' }],
    })
    await healScheduledLaunchPayloads(db)

    const p = payloadOf(id)
    expect(p.repos).toBeUndefined()
    expect(p.repoUrl).toBe('https://git.example/a.git')
    expect(p.ref).toBe('dev')
    // 关键：真的干净了——否则下一轮扫描还会把它捡起来。
    expect(rejectRetiredStartTaskKeys(p)).toBeNull()
    // 计划保持启用：它本来就是个能跑的单仓计划。
    expect(read(id)!.enabled).toBe(true)
  })

  test('多条 repos ⇒ **停发**并给出可操作的原因（不是留着反复失败）', async () => {
    const id = seed({
      workflowId: 'wf',
      name: 't',
      inputs: {},
      repos: [{ repoUrl: 'https://git.example/a.git' }, { repoUrl: 'https://git.example/b.git' }],
    })
    await healScheduledLaunchPayloads(db)

    const row = read(id)!
    expect(row.enabled).toBe(false)
    // next_run_at 置 null ⇒ 轮询直接跳过（disable 的既有语义）。
    expect(row.nextRunAt).toBeNull()
    expect(row.lastError).toContain('rfc248-multi-repo-retired')
    // 原因里要说清**怎么改**，不能只说「不支持了」。
    expect(row.lastError).toContain('repo group')
  })

  test('幂等：再扫一遍不会把已 healed 的行重新计为待转换', async () => {
    // 这条锁住那个「永远清不干净」的循环——第一轮之后必须收敛。
    const id = seed({
      workflowId: 'wf',
      name: 't',
      inputs: {},
      repos: [{ repoUrl: 'https://git.example/a.git' }],
    })
    const first = await healScheduledLaunchPayloads(db)
    expect(first.converted).toBe(1)
    const second = await healScheduledLaunchPayloads(db)
    expect(second.converted).toBe(0)
    expect(payloadOf(id).repos).toBeUndefined()
  })

  test('顶层已有单仓字段时不被数组覆盖（自相矛盾的 payload 取顶层）', async () => {
    const id = seed({
      workflowId: 'wf',
      name: 't',
      inputs: {},
      repoUrl: 'https://git.example/top.git',
      repos: [{ repoUrl: 'https://git.example/inner.git' }],
    })
    await healScheduledLaunchPayloads(db)
    const p = payloadOf(id)
    expect(p.repoUrl).toBe('https://git.example/top.git')
    expect(p.repos).toBeUndefined()
  })

  test('已经是 v2-clean 的行完全不动', async () => {
    const id = seed({ workflowId: 'wf', name: 't', inputs: {}, repoGroupId: 'grp_1' })
    const before = read(id)!.updatedAt
    const r = await healScheduledLaunchPayloads(db)
    expect(r.converted).toBe(0)
    expect(read(id)!.updatedAt).toBe(before)
    expect(payloadOf(id).repoGroupId).toBe('grp_1')
  })
})
