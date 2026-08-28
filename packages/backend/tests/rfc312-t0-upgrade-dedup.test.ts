// RFC-312 T0 —— WS 升级路径不得对同一个 token 解析两遍。
//
// 修复前：`tryUpgrade` 先 `resolveActor(db, token)`，再 `buildWsCredential(db, token)`，
// 两者各跑一遍 `lookupActiveSession` ⇒ 越过活动写入合流窗口的升级会有
// **5 读 + 2 次 `UPDATE user_sessions.last_used_at`**。
// `ws/server.ts` 那行注释自己就写着 "Computed from the same token resolveActor just consumed"，
// 只是没把结果传下来。合并后是 3 读 1 写，且**对所有 WS 连接生效**，不只 presence。
//
// 断言口径必须写成「**越过活动写入合流窗口后，成功 session 的 tryUpgrade 认证段**」：
// RFC-338 允许窗口内的热请求零写入；失败凭据会提前返回，
// 带升级门的通道（task / memory-distill-jobs / presence）另有各自的读取，
// 所以这不是"完整建连总成本"。
//
// 计数方式：给 db.$client.query / db.run 挂 spy 数 SQL，只统计打到 user_sessions 的语句。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createSession } from '../src/auth/sessionStore'
import { resolveActorWithWsCredential } from '../src/auth/session'
import { userSessions } from '../src/db/schema'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function seedUser(db: DbClient, id: string): void {
  db.$client
    .query(
      `INSERT INTO users (id, username, display_name, role, status, force_password_change,
                          created_at, updated_at, schema_version, access_revision)
       VALUES (?, ?, ?, 'user', 'active', 0, 0, 0, 1, 0)`,
    )
    .run(id, id, id)
}

/**
 * 统计本次调用发出了几条 `UPDATE user_sessions`。
 *
 * 直接数 drizzle 的 `db.update(userSessions)` 调用：`lookupActiveSessionByHash` 的
 * rolling renewal 就走这条（`auth/sessionStore.ts:150-152`）。不去 hook `$client`——
 * drizzle 的 update 不经过 `$client.query`，那样数出来恒为 0（第一版就踩了这个）。
 */
function countSessionUpdates(db: DbClient): { writes: () => number; restore: () => void } {
  let writes = 0
  const target = db as unknown as { update: (table: unknown) => unknown }
  const original = target.update.bind(target)
  target.update = (table: unknown) => {
    if (table === userSessions) writes += 1
    return original(table)
  }
  return { writes: () => writes, restore: () => void (target.update = original) }
}

describe('rfc312 T0 · WS 升级路径去重', () => {
  test('一次成功的 session 升级只写一次 last_used_at（修复前是两次）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedUser(db, 'u-1')
    const { token } = await createSession({ db, userId: 'u-1', now: 1_000 })

    const counter = countSessionUpdates(db)
    const resolved = await resolveActorWithWsCredential(
      db,
      token,
      Buffer.from('daemon-token'),
      2_000,
    )

    expect(resolved.actor).not.toBeNull()
    expect(resolved.actor!.user.id).toBe('u-1')
    // 凭据与 actor 出自同一次解析
    expect(resolved.credential.kind).toBe('session')
    expect(
      resolved.credential.kind === 'session' ? resolved.credential.expiresAt : null,
    ).toBeGreaterThan(0)

    // 这就是本条的红→绿判据：拆开的实现会数到 2。
    expect(counter.writes()).toBe(1)
    counter.restore()
  })

  test('rolling renewal 仍然生效：升级确实推进了 last_used_at', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedUser(db, 'u-2')
    const { token, session } = await createSession({ db, userId: 'u-2', now: 1_000 })

    await resolveActorWithWsCredential(db, token, Buffer.from('daemon-token'), 999_000)
    const after = db.$client
      .query('SELECT last_used_at AS t FROM user_sessions WHERE id = ?')
      .get(session.id) as { t: number }
    expect(after.t).toBe(999_000)
    expect(after.t).toBeGreaterThan(session.lastUsedAt)
  })

  test('无效 token：actor 为 null，凭据仍带指纹（调用方据 actor 判 401）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const bogus = `aws_s_${randomBytes(32).toString('hex')}`
    const resolved = await resolveActorWithWsCredential(db, bogus, Buffer.from('daemon-token'))
    expect(resolved.actor).toBeNull()
    expect(resolved.credential.kind).toBe('session')
    expect(resolved.credential.kind === 'session' ? resolved.credential.expiresAt : 0).toBeNull()
  })

  test('daemon token：不查库，凭据为 daemon 形态', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const counter = countSessionUpdates(db)
    const resolved = await resolveActorWithWsCredential(
      db,
      'daemon-token',
      Buffer.from('daemon-token'),
    )
    expect(resolved.credential).toEqual({ kind: 'daemon' })
    expect(counter.writes()).toBe(0)
    counter.restore()
  })
})
