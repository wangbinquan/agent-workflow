// RFC-285 B3（D7/E4）+ RFC-347 —— delegated authority 单源 + 三臂接线锁。
//
// 为什么这条测试存在：call-workflow / call-workgroup 子任务此前用
// `as unknown as` 伪造无权限幽灵 actor 启动（scheduler.ts），owner 失活后
// 后台仍替其新启子任务；scheduled 触发臂则各自手写 owner rebuild。本文件锁：
//   ① 判定单源四分支（active projection / 失活 null / 缺行 null / NULL-owner Q5 放行）；
//   ② 三臂全部经 closed delegated factory（伪造 cast 与 central facade 归零）；
//   ③ Q6（用户拍板）：resume 臂豁免——只拦「新任务创建」。
// 臂级正向行为（active owner 子任务照常启动）由既有 rfc243-call-* 套件覆盖；
// 本文件不重复起全调度器。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SYSTEM_USER_ID } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { users } from '../src/db/schema'
import { composeIdentityAccess } from '../src/modules/identity-access/composition'
import { projectOwnerlessLegacyActor } from '../src/modules/identity-access/application/legacyActorProjection'

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

async function resolveCallOwner(
  runtime: ReturnType<typeof composeIdentityAccess>,
  ownerUserId: string,
) {
  return (
    (
      await runtime.delegatedRequests.forCall({
        kind: 'call-workflow',
        ownerUserId,
        parentTaskId: 'rfc285-parent-task',
        parentNodeRunId: 'rfc285-parent-node',
      })
    )?.actor ?? null
  )
}

describe('RFC-285 B3 — delegated authority 判定单源', () => {
  test('active owner → 真实用户行重建（daemon 源 + 角色基线权限）', async () => {
    const db = makeDb()
    const runtime = composeIdentityAccess(db)
    await seedUser(db, 'u1', 'active')
    const actor = await resolveCallOwner(runtime, 'u1')
    expect(actor).not.toBeNull()
    expect(actor!.user.id).toBe('u1')
    expect(actor!.source).toBe('daemon')
    expect(actor!.permissions.size).toBeGreaterThan(0) // 角色基线，非幽灵空集
  })

  test('active owner → 每次按 grant + revision 重建，撤销无需重启后台', async () => {
    const db = makeDb()
    const runtime = composeIdentityAccess(db)
    await seedUser(db, 'u-grant', 'active')
    const context = runtime.contexts.fromAuthenticatedPrincipal(
      { userId: SYSTEM_USER_ID, source: 'cli' },
      'cli',
      1_000,
    )
    await runtime.updateUserAccess.execute(context, {
      targetUserId: 'u-grant',
      access: {
        role: 'user',
        additionalPermissions: ['scripts:author'],
        expectedRevision: 0,
      },
    })
    const granted = await resolveCallOwner(runtime, 'u-grant')
    expect(granted?.permissions.has('scripts:author')).toBe(true)
    expect(granted?.authorityRevision).toBe(1)

    await runtime.updateUserAccess.execute(context, {
      targetUserId: 'u-grant',
      access: { role: 'user', additionalPermissions: [], expectedRevision: 1 },
    })
    const revoked = await resolveCallOwner(runtime, 'u-grant')
    expect(revoked?.permissions.has('scripts:author')).toBe(false)
    expect(revoked?.authorityRevision).toBe(2)
  })

  test('失活 owner → null（错误形态归调用方）', async () => {
    const db = makeDb()
    const runtime = composeIdentityAccess(db)
    await seedUser(db, 'u2', 'disabled')
    expect(await resolveCallOwner(runtime, 'u2')).toBeNull()
  })

  test('owner 行缺失 → null', async () => {
    const db = makeDb()
    const runtime = composeIdentityAccess(db)
    expect(await resolveCallOwner(runtime, 'ghost')).toBeNull()
  })

  test('NULL owner（legacy）→ Q5 放行：__system__ 幽灵、空权限（绝不扩权）', async () => {
    const actor = projectOwnerlessLegacyActor()
    expect(actor).not.toBeNull()
    expect(actor!.user.id).toBe(SYSTEM_USER_ID)
    expect(actor!.permissions.size).toBe(0)
  })

  test("字符串 '__system__' owner → 真身查行臂（有意的行为变化，实现门 P3-3 定界）", async () => {
    const db = makeDb()
    const runtime = composeIdentityAccess(db)
    // createInMemoryDb 迁移链自带 __system__ 系统用户行（admin/active）。
    const actor = await resolveCallOwner(runtime, SYSTEM_USER_ID)
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
    const nodeMechanics = src('modules/task-execution/composition/nodeMechanics.ts')
    expect(nodeMechanics.includes('as unknown as Parameters<typeof startExecution>')).toBe(false)
    // helper definition + call-workflow + call-workgroup preflight；central facade 归零。
    expect((nodeMechanics.match(/delegatedCallActor\(/g) ?? []).length).toBe(3)
    expect(nodeMechanics).toContain('delegated.forCall({')
    expect(nodeMechanics).not.toContain('buildInheritedActor(')
    expect(nodeMechanics).toContain("'call-workflow'")
    expect(nodeMechanics).toContain("'call-workgroup'")
    expect((nodeMechanics.match(/'call-owner-inactive'/g) ?? []).length).toBe(2)
  })

  test('Q6：resume 臂豁免注释锁在位（只拦新任务创建）', () => {
    const nodeMechanics = src('modules/task-execution/composition/nodeMechanics.ts')
    const start = nodeMechanics.indexOf('RFC-285 B3 Q6')
    expect(start).toBeGreaterThan(-1)
    const end = nodeMechanics.indexOf('} catch (error)', start)
    expect(end).toBeGreaterThan(start)
    const resumeArm = nodeMechanics.slice(start, end)
    // RFC-331 keeps Q6 on the explicit child-control port: resume extends an
    // existing task and therefore must not rebuild or re-check its owner.
    expect(resumeArm).toContain('const childRuntime = buildChildRuntime(state)')
    expect(resumeArm).toContain('await state.topology.schedulerDriver.resumeChild({')
    expect(resumeArm).toContain('taskId: childTaskId')
    expect(resumeArm).toContain('runtime: childRuntime')
    expect(resumeArm).not.toContain('delegatedCallActor(')
  })

  test('scheduled 臂收编：手写 owner rebuild 归零、错误码 owner-inactive 不变', () => {
    const scheduled = src('services/scheduledTasks.ts')
    expect(scheduled).toContain('identityAccess.delegatedRequests.forSchedule({')
    expect(scheduled).not.toContain('buildInheritedActor(')
    expect(scheduled.includes('buildActor(')).toBe(false) // 手写 rebuild 已收编
    expect(scheduled).toContain("'owner-inactive'")
  })
})
