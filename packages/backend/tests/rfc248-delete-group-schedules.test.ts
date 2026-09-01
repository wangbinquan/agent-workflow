// RFC-248 #10（设计门二轮 H9 补的第 10 行）—— 删组要顾及**引用它的定时任务**。
//
// 漏掉这条的后果不是崩，而是**慢性烂账**：组删了，引用它的计划照旧到点触发、
// 每次都因为 `repo-group-not-found` 失败，管理员在计划列表里只看到一串失败，
// 看不出根因。所以：
//
//   - 默认**阻止**删除，并把引用它的计划列出来（409 + details）；
//   - `force=1` 时在**同一事务**里把这些计划禁用（不删——用户可能只想换个组），
//     `next_run_at` 置 null 让轮询直接跳过，`last_error` 写明原因。
//
// 另一条同等重要的语义：**已禁用**的计划不算引用。它本来就不会触发，拿它去
// 阻塞删除只会让用户困惑（「我明明停了它」）。

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { repoGroups, scheduledTasks } from '../src/db/schema'
import { RepoGroupHasReferencesError, deleteRepoGroup } from '../src/services/repoGroup'
import {
  composeSqliteRepositoryWorkspaceStore,
  type RepositoryWorkspaceStore,
} from '../src/modules/source-control/composition'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

let db: DbClient
let store: RepositoryWorkspaceStore
beforeEach(() => {
  db = createInMemoryDb(MIGRATIONS)
  store = composeSqliteRepositoryWorkspaceStore(db)
})

function seedGroup(name = 'g'): string {
  const id = ulid()
  const now = Date.now()
  db.insert(repoGroups)
    .values({
      id,
      name,
      description: '',
      version: 1,
      createdByUserId: null,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  return id
}

function seedSchedule(opts: { name: string; payload: unknown; enabled?: boolean }): string {
  const id = ulid()
  const now = Date.now()
  db.insert(scheduledTasks)
    .values({
      id,
      name: opts.name,
      ownerUserId: 'u1',
      launchKind: 'workflow',
      launchPayload: JSON.stringify(opts.payload),
      scheduleSpec: JSON.stringify({ kind: 'interval', everyMs: 60_000, tz: 'UTC' }),
      enabled: opts.enabled ?? true,
      nextRunAt: (opts.enabled ?? true) ? now + 60_000 : null,
      consecutiveFailures: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  return id
}

describe('RFC-248 #10 —— 删组 × 定时任务', () => {
  test('启用中的计划引用本组 ⇒ 默认拒绝删除，并在 details 里列出它', async () => {
    const gid = seedGroup()
    const sid = seedSchedule({
      name: '每天审计',
      payload: { workflowId: 'wf', name: 't', inputs: {}, repoGroupId: gid },
    })

    let caught: RepoGroupHasReferencesError | null = null
    try {
      await deleteRepoGroup(store, gid)
    } catch (e) {
      caught = e as RepoGroupHasReferencesError
    }
    expect(caught).toBeInstanceOf(RepoGroupHasReferencesError)
    expect(caught!.status).toBe(409)
    expect(caught!.referencingSchedules).toEqual([{ id: sid, name: '每天审计' }])
    // 组还在——拒绝必须是原子的，不能删一半。
    expect(db.select().from(repoGroups).where(eq(repoGroups.id, gid)).all()).toHaveLength(1)
  })

  test('force=1 ⇒ 组被删，引用它的计划被**禁用**（不是删除）且带上原因', async () => {
    const gid = seedGroup()
    const sid = seedSchedule({
      name: '每天审计',
      payload: { workflowId: 'wf', name: 't', inputs: {}, repoGroupId: gid },
    })

    const res = await deleteRepoGroup(store, gid, { force: true })
    expect(res.disabledSchedules).toBe(1)
    expect(db.select().from(repoGroups).where(eq(repoGroups.id, gid)).all()).toHaveLength(0)

    const row = db.select().from(scheduledTasks).where(eq(scheduledTasks.id, sid)).get()
    // 计划行仍在（用户可能只想换个组重新启用）。
    expect(row).toBeDefined()
    expect(row!.enabled).toBe(false)
    // next_run_at 置 null ⇒ 轮询直接跳过，不会每分钟失败一次。
    expect(row!.nextRunAt).toBeNull()
    expect(row!.lastError).toContain(gid)
  })

  test('**已禁用**的计划不算引用——它本来就不会触发', async () => {
    const gid = seedGroup()
    seedSchedule({
      name: '停用的',
      payload: { workflowId: 'wf', name: 't', inputs: {}, repoGroupId: gid },
      enabled: false,
    })
    const res = await deleteRepoGroup(store, gid)
    expect(res.disabledSchedules).toBe(0)
    expect(db.select().from(repoGroups).where(eq(repoGroups.id, gid)).all()).toHaveLength(0)
  })

  test('引用**别的**组的计划不受影响', async () => {
    const mine = seedGroup('mine')
    const other = seedGroup('other')
    const sid = seedSchedule({
      name: '指向 other',
      payload: { workflowId: 'wf', name: 't', inputs: {}, repoGroupId: other },
    })
    const res = await deleteRepoGroup(store, mine)
    expect(res.disabledSchedules).toBe(0)
    expect(db.select().from(scheduledTasks).where(eq(scheduledTasks.id, sid)).get()!.enabled).toBe(
      true,
    )
  })

  test('组 id 只是**出现在提示词里**不算引用（子串筛选后必须逐条 parse 确认）', async () => {
    // 这条锁住实现里的 `LIKE %"repoGroupId":"<id>"%` 之后那次 JSON.parse 复核。
    // 只靠子串会把「用户在 prompt 里粘了个组 id」误判成引用，用户会遇到一个
    // 永远删不掉、也解释不清的组。
    const gid = seedGroup()
    seedSchedule({
      name: '提示词里提到了它',
      payload: {
        workflowId: 'wf',
        name: 't',
        // 注意这里的键名不是 repoGroupId，值里却含有完全相同的字面量。
        inputs: { note: `参考 {"repoGroupId":"${gid}"} 的布局` },
        repoUrl: 'https://x/r.git',
      },
    })
    const res = await deleteRepoGroup(store, gid)
    expect(res.disabledSchedules).toBe(0)
    expect(db.select().from(repoGroups).where(eq(repoGroups.id, gid)).all()).toHaveLength(0)
  })

  test('kind-enveloped payload（`{kind, body}`）里的 repoGroupId 同样被认出', async () => {
    const gid = seedGroup()
    seedSchedule({
      name: '信封形态',
      payload: { kind: 'workflow', body: { workflowId: 'wf', name: 't', repoGroupId: gid } },
    })
    await expect(deleteRepoGroup(store, gid)).rejects.toThrow(RepoGroupHasReferencesError)
  })
})
