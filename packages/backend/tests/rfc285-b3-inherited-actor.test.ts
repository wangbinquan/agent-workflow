// RFC-285 B3（D7/E4）—— buildInheritedActor 单源 + 三臂接线锁。
//
// 为什么这条测试存在：call-workflow / call-workgroup 子任务此前用
// `as unknown as` 伪造无权限幽灵 actor 启动（scheduler.ts），owner 失活后
// 后台仍替其新启子任务；scheduled 触发臂则各自手写 owner rebuild。本文件锁：
//   ① 判定单源四分支（active 重建 / 失活 null / 缺行 null / NULL-owner Q5 放行）；
//   ② 三臂全部经 buildInheritedActor（伪造 cast 归零、scheduled 收编）；
//   ③ Q6（用户拍板）：resume 臂豁免——只拦「新任务创建」。
// 臂级正向行为（active owner 子任务照常启动）由既有 rfc243-call-* 套件覆盖；
// 本文件不重复起全调度器。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildInheritedActor, SYSTEM_USER_ID } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { users } from '../src/db/schema'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function makeDb(): DbClient {
  return createInMemoryDb(MIGRATIONS)
}

async function seedUser(db: DbClient, id: string, status: 'active' | 'disabled'): Promise<void> {
  await db.insert(users).values({
    id,
    username: `u-${id}`,
    displayName: `U ${id}`,
    role: 'user',
    status,
    passwordHash: 'x',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
}

describe('RFC-285 B3 — buildInheritedActor 判定单源', () => {
  test('active owner → 真实用户行重建（daemon 源 + 角色基线权限）', async () => {
    const db = makeDb()
    await seedUser(db, 'u1', 'active')
    const actor = await buildInheritedActor(db, 'u1')
    expect(actor).not.toBeNull()
    expect(actor!.user.id).toBe('u1')
    expect(actor!.source).toBe('daemon')
    expect(actor!.permissions.size).toBeGreaterThan(0) // 角色基线，非幽灵空集
  })

  test('失活 owner → null（错误形态归调用方）', async () => {
    const db = makeDb()
    await seedUser(db, 'u2', 'disabled')
    expect(await buildInheritedActor(db, 'u2')).toBeNull()
  })

  test('owner 行缺失 → null', async () => {
    const db = makeDb()
    expect(await buildInheritedActor(db, 'ghost')).toBeNull()
  })

  test('NULL owner（legacy）→ Q5 放行：__system__ 幽灵、空权限（绝不扩权）', async () => {
    const db = makeDb()
    const actor = await buildInheritedActor(db, null)
    expect(actor).not.toBeNull()
    expect(actor!.user.id).toBe(SYSTEM_USER_ID)
    expect(actor!.permissions.size).toBe(0)
  })

  test("字符串 '__system__' owner → 真身查行臂（有意的行为变化，实现门 P3-3 定界）", async () => {
    const db = makeDb()
    // createInMemoryDb 迁移链自带 __system__ 系统用户行（admin/active）。
    const actor = await buildInheritedActor(db, SYSTEM_USER_ID)
    expect(actor).not.toBeNull()
    expect(actor!.user.id).toBe(SYSTEM_USER_ID)
    // 与 NULL 臂的空幽灵不同：真身解析、角色基线权限（系统行为自洽；
    // 普通 session/PAT 无法把任务 owner 写成 __system__，无越权面）。
    expect(actor!.permissions.size).toBeGreaterThan(0)
  })
})

describe('RFC-285 B3 — 三臂接线源码锁', () => {
  const src = (rel: string): string =>
    readFileSync(resolve(import.meta.dir, '..', 'src', rel), 'utf8')

  test('伪造 actor cast 归零；两条新启臂都判 call-owner-inactive', () => {
    const scheduler = src('services/scheduler.ts')
    expect(scheduler.includes('as unknown as Parameters<typeof startExecution>')).toBe(false)
    // 臂 1（call-workflow）+ 臂 2（call-workgroup preflight）各一次判定 + 抛码。
    expect(
      (scheduler.match(/buildInheritedActor\(db, taskRow\.ownerUserId \?\? null\)/g) ?? []).length,
    ).toBe(2)
    expect((scheduler.match(/'call-owner-inactive'/g) ?? []).length).toBe(2)
  })

  test('Q6：resume 臂豁免注释锁在位（只拦新任务创建）', () => {
    const scheduler = src('services/scheduler.ts')
    expect(scheduler).toContain('RFC-285 B3 Q6')
    expect(scheduler).toContain('resumeTask(db, childTaskId, buildChildDeps(state))')
  })

  test('scheduled 臂收编：手写 owner rebuild 归零、错误码 owner-inactive 不变', () => {
    const scheduled = src('services/scheduledTasks.ts')
    expect(scheduled).toContain('buildInheritedActor(db, row.ownerUserId)')
    expect(scheduled.includes('buildActor(')).toBe(false) // 手写 rebuild 已收编
    expect(scheduled).toContain("'owner-inactive'")
  })
})
