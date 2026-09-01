// RFC-291 面 F —— handle ordinal 永不复用（AC-20 / AC-21）。
//
// 设计门 P1-d：`manifest.ts` 的注释写着「Counters only ever grow … so
// conversation history stays coherent across epochs」，实现却做不到——
// buildIntentDump 每轮从空清单重建，inventory 只保留 `.slice(0, cap)`，被 cap
// 淘汰（或资源已删）的非 detail 条目整个消失，连带丢掉它占用的 ordinal。下一个
// 新建资源于是拿到同一个 ordinal，**旧对话里的 `res#agent#3` 从此指向另一个资源**。
//
// 这里用 `inventoryCap` 测试缝确定性复现该路径，并锁住修法：会话行持久化
// per-type 高水位，allocator 取「清单推导值」与它的 max。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, users } from '../src/db/schema'
import type { Actor } from '../src/auth/actor'
import { buildIntentDumpForTest as buildIntentDump } from './helpers/intentResourceCatalogBinding'
import { createHandleAllocator, parseHandleWatermark } from '../src/services/intent/manifest'

const MIGRATIONS = join(import.meta.dir, '..', 'db', 'migrations')
const OWNER = 'user_owner_rfc291wm_000000'

let db: DbClient
let appHome: string

const actor: Actor = {
  user: { id: OWNER, username: 'owner', displayName: 'Owner', role: 'user', status: 'active' },
  source: 'session',
  permissions: new Set(['resource-acl:private']),
}

async function seedAgent(name: string): Promise<string> {
  const id = ulid()
  const now = Date.now()
  await db.insert(agents).values({
    id,
    name,
    description: name,
    outputs: JSON.stringify(['out']),
    ownerUserId: OWNER,
    visibility: 'private',
    createdAt: now,
    updatedAt: now,
  } as typeof agents.$inferInsert)
  return id
}

beforeEach(async () => {
  appHome = mkdtempSync(join(tmpdir(), 'aw-rfc291-wm-'))
  db = createInMemoryDb(MIGRATIONS)
  await db.insert(users).values({
    id: OWNER,
    username: 'owner',
    displayName: 'Owner',
    role: 'user',
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as typeof users.$inferInsert)
})
afterEach(() => {
  rmSync(appHome, { recursive: true, force: true })
})

describe('handle ordinal 不因 inventory cap 淘汰而复用（AC-20）', () => {
  test('淘汰后新资源不拿回历史 ordinal（有高水位）/ 会拿回（无高水位，缺陷形态）', async () => {
    // 三个 agent，名字排序 aaa < bbb < zzz ⇒ handle 依次 #1 #2 #3。
    // 消失的必须是**当前最大**的那个（#3）：删中间的 #2 不会让计数器回退，
    // 因为 #3 还在清单里撑着——这正是这个缺陷只在特定序列下暴露的原因。
    await seedAgent('aaa-agent')
    await seedAgent('bbb-agent')
    const zzz = await seedAgent('zzz-agent')

    // ① 首轮：cap 足够大，三个都进清单，各拿一个 ordinal。
    const first = await buildIntentDump({
      db,
      actor,
      appHome,
      mounts: [],
      inventoryCap: 10,
    })
    const zzzHandle = first.manifest.find((e) => e.resourceId === zzz)?.handle
    expect(zzzHandle).toBe('res#agent#3')
    expect(first.handleWatermark.agent).toBe(3)

    // ② zzz 被删除 —— 下一轮重建时它既不是 detail 也不在可见 inventory 里，
    //    条目连同它占用的最大 ordinal 一起从清单消失。
    await db.delete(agents).where(eq(agents.id, zzz))

    const second = await buildIntentDump({
      db,
      actor,
      appHome,
      mounts: [],
      priorManifest: first.manifest,
      handleWatermark: first.handleWatermark,
      inventoryCap: 10,
    })
    expect(second.manifest.find((e) => e.resourceId === zzz)).toBeUndefined()
    // 高水位不因条目消失而回退
    expect(second.handleWatermark.agent).toBe(3)

    // ③ 新建一个 agent 再跑一轮：它**不得**拿到 zzz 用过的 ordinal。
    const fresh = await seedAgent('nnn-agent')
    const third = await buildIntentDump({
      db,
      actor,
      appHome,
      mounts: [],
      priorManifest: second.manifest,
      handleWatermark: second.handleWatermark,
      inventoryCap: 10,
    })
    expect(third.manifest.find((e) => e.resourceId === fresh)?.handle).not.toBe(zzzHandle)

    // 对照（缺陷形态）：不喂高水位，新资源就复用了 zzz 的 ordinal ——
    // 旧对话里指向 zzz 的 `res#agent#3` 从此指向这个新资源。
    const withoutWatermark = await buildIntentDump({
      db,
      actor,
      appHome,
      mounts: [],
      priorManifest: second.manifest,
      inventoryCap: 10,
    })
    expect(withoutWatermark.manifest.find((e) => e.resourceId === fresh)?.handle).toBe(zzzHandle)
  })

  test('cap 截断路径同样不丢高水位', async () => {
    await seedAgent('aaa-agent')
    await seedAgent('bbb-agent')
    await seedAgent('zzz-agent')

    const full = await buildIntentDump({ db, actor, appHome, mounts: [], inventoryCap: 10 })
    expect(full.handleWatermark.agent).toBe(3)

    // cap=1：只有名字排序第一的进清单，另外两条被截断掉。
    const capped = await buildIntentDump({
      db,
      actor,
      appHome,
      mounts: [],
      priorManifest: full.manifest,
      handleWatermark: full.handleWatermark,
      inventoryCap: 1,
    })
    expect(capped.manifest.filter((e) => e.resourceType === 'agent')).toHaveLength(1)
    // 清单里只剩 1 条，但高水位仍是 3 —— 这正是防复用的那道防线。
    expect(capped.handleWatermark.agent).toBe(3)
    expect(createHandleAllocator(capped.manifest, capped.handleWatermark).next.agent).toBe(3)
  })
})

describe('存量会话退化（AC-21）', () => {
  test('高水位列为默认空 → 行为等同 RFC-291 之前，不报错', async () => {
    await seedAgent('aaa-agent')
    const dump = await buildIntentDump({
      db,
      actor,
      appHome,
      mounts: [],
      handleWatermark: parseHandleWatermark('{}'),
      inventoryCap: 10,
    })
    expect(dump.manifest).toHaveLength(1)
    expect(dump.handleWatermark.agent).toBe(1)
  })
})
