// RFC-312 —— Codex **实现门**四条 P1 与两条 P2 的回归锁（2026-08-20）。
//
// 为什么单独立一个文件：这些缺陷的共同点是**既有测试全绿的情况下依然存在**——它们都藏在
// "分支写了但从未被执行"或"注释声称的行为与代码不符"里。所以每条都按「把修复退回去就必须
// 立刻红」来写，而不是只断言修复后的表象。
//
//   P1-1 `handleClose` 从不置 `closing` ⇒ `installPresence` 的守卫是死的（该守卫的文档注释
//        逐字描述了这条竞态，却因为标志只在 `closeConnection` 里置位而从未生效）。
//   P1-2 复核冻结期间的帧被**丢弃**而非排队 ⇒ 累积式增量流永久停在旧状态。
//   P1-3 `sendJson` 忽略 Bun `ws.send()` 返回的 0（= 帧被丢弃）。
//   P2-1 `authority.changed` 同样忽略返回 0 ⇒ 失权通知静默丢失。
//   P2-2 建号时系统默认 grant 与操作者显式勾选合并归因 ⇒ 审计谎报"管理员显式授予"。

import { afterEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import type { ServerWebSocket } from 'bun'

import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb } from '../src/db/client'
import { WS_CHANNELS, installPresence, type WsConnectionData } from '../src/ws/registry'
import { buildWebSocketAdapter } from '../src/ws/server'
import {
  WS_CLOSE_NOT_VISIBLE,
  resetConnectionsForTest,
  revalidateAllConnections,
  trackConnection,
} from '../src/ws/connections'
import { createUser } from '../src/services/users'
import { createSession } from '../src/auth/sessionStore'
import { describeCredential } from '../src/auth/session'
import type { WsCredential } from '../src/ws/registry'
import { createLogger } from '../src/util/log'
import { composeIdentityAccess } from '../src/modules/identity-access/composition'
import { PerformanceMonotonicClock } from '../src/modules/identity-access/infrastructure/inMemoryPresence'
import {
  admitWsIdentity,
  stubIdentityAccessWsBinding,
  TEST_DIRECT_AUTHORITY,
} from './helpers/identityAccessWs'
import type { IdentityAccessWsBinding } from '../src/ws/registry'
import type { DirectRequestAuthority } from '../src/modules/identity-access/public/participants'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function seedUser(db: ReturnType<typeof createInMemoryDb>, id: string, role = 'admin'): void {
  db.$client
    .query(
      `INSERT INTO users (id, username, display_name, role, status, force_password_change,
                          created_at, updated_at, schema_version, access_revision)
       VALUES (?, ?, ?, ?, 'active', 0, 0, 0, 1, 0)`,
    )
    .run(id, id, id, role)
}

function actorWith(role: 'admin' | 'user', id = 'u-1'): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
  })
}

/** `sendReturns` 让用例模拟 Bun 在背压/已关闭时返回 0（帧被丢弃）。 */
function fakeWs(
  actor: Actor,
  sendReturns: (payload: string) => number = (p) => p.length,
  identity: {
    readonly authority: DirectRequestAuthority
    readonly identityAccess: IdentityAccessWsBinding
  } = {
    authority: TEST_DIRECT_AUTHORITY,
    identityAccess: stubIdentityAccessWsBinding(actor.authorityRevision ?? 0),
  },
): { ws: ServerWebSocket<WsConnectionData>; sent: unknown[] } {
  const sent: unknown[] = []
  const data: WsConnectionData = {
    channel: { kind: 'presence' },
    actor,
    ...identity,
    credential: { kind: 'session', hash: 'h', expiresAt: null },
    closing: false,
    revalidating: false,
    upgradeEpoch: 0,
    unsubscribe: () => {},
    visibilityCache: new Map(),
  }
  return {
    ws: {
      data,
      send(payload: string) {
        const n = sendReturns(payload)
        if (n !== 0) sent.push(JSON.parse(payload))
        return n
      },
    } as unknown as ServerWebSocket<WsConnectionData>,
    sent,
  }
}

describe('RFC-312 实现门 —— presence 计数不得因关闭时序泄漏', () => {
  // P1-1 的**核心**：真正走一遍 `handleClose`，断言它置了 `closing`。
  // 这一条才锁得住修复本身——若只自己把 `closing` 置真再调 installPresence，锁的是那个
  // 早已存在的守卫，而不是"标志有没有被置上"，删掉修复照样绿（我第一版就写错成那样）。
  test('handleClose 置 closing ⇒ 随后迟到的 installPresence 不再登记', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedUser(db, 'ghost')
    const identityAccess = composeIdentityAccess(db)
    const { getUserPresence } = identityAccess
    const adapter = buildWebSocketAdapter({ daemonToken: 'dt', db, identityAccess })
    const identity = await admitWsIdentity(identityAccess, 'ghost')
    const { ws } = fakeWs(identity.actor, undefined, identity)

    // 客户端在 handleOpen 的 epoch 复核 await 期间断开：Bun 回调 handleClose。
    adapter.handlers.close(ws as never)
    expect(ws.data.closing).toBe(true)

    // await 回来了，才轮到登记——此时必须是空操作，否则永远等不到第二次 close 回调。
    installPresence(ws)
    expect(getUserPresence.stateOf('ghost')).toBe('offline')
    expect(getUserPresence.snapshot()).not.toContain('ghost')
  })

  test('未关闭时正常登记，仍是在线（守卫没有误杀正向路径）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedUser(db, 'alive')
    const identityAccess = composeIdentityAccess(db)
    const { getUserPresence } = identityAccess
    const identity = await admitWsIdentity(identityAccess, 'alive')
    const { ws } = fakeWs(identity.actor, undefined, identity)
    installPresence(ws)
    expect(getUserPresence.stateOf('alive')).toBe('online')
  })
})

describe('RFC-312 实现门 —— presence 通道声明了重同步（累积流不得靠丢帧收场）', () => {
  // P1-2 / P1-3 的共同修法：通道把"如何重同步"声明成数据，复核解冻与 send 被丢两处都用它。
  test('presence spec 提供 resync，且它发的是一份全量快照', () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedUser(db, 'viewer')
    const { ws, sent } = fakeWs(actorWith('admin', 'viewer'))
    const resync = WS_CHANNELS.presence.resync
    expect(typeof resync).toBe('function')

    resync?.(ws, db)
    expect(sent).toHaveLength(1)
    expect((sent[0] as { type: string }).type).toBe('presence.snapshot')
  })

  // 没有累积状态的通道**不得**实现该钩子——否则等于给它们改行为。
  test('其余通道一律不声明 resync（行为逐字不变）', () => {
    const withResync = Object.entries(WS_CHANNELS)
      .filter(([, spec]) => (spec as { resync?: unknown }).resync !== undefined)
      .map(([kind]) => kind)
    expect(withResync).toEqual(['presence'])
  })
})

describe('RFC-312 实现门 —— 系统默认授权的归因', () => {
  // P2-2。建号时 `users:presence` 是**系统默认**发放的，审计应记为系统（NULL），
  // 与迁移 0188 给存量行写的 NULL 一致；操作者显式勾选的点才记操作者。
  // 修复前两者被合并成同一个数组、统一归因操作者 ⇒ 审计谎报"管理员显式授予了 users:presence"。
  test('默认 grant 记 NULL、显式勾选记操作者，两条来路归因不再打架', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedUser(db, 'admin-1', 'admin')
    const module = composeIdentityAccess(db)
    const context = module.contexts.fromAuthenticatedPrincipal(
      { userId: 'admin-1', source: 'session' },
      'http',
      4_000,
    )

    await module.createManagedUser.execute(context, {
      id: 'new-user',
      username: 'new-user',
      email: null,
      displayName: 'New User',
      passwordHash: 'hash',
      role: 'user',
      status: 'active',
      forcePasswordChange: false,
      createdBy: 'admin-1',
      schemaVersion: 1,
      additionalPermissions: ['scripts:author'],
    } as never)

    const rows = db.$client
      .query(
        `SELECT permission, granted_by_user_id AS by FROM user_permission_grants WHERE user_id = ?`,
      )
      .all('new-user') as Array<{ permission: string; by: string | null }>
    const byPermission = new Map(rows.map((r) => [r.permission, r.by]))

    // 两条来路都在，但归因不同——这正是修复的全部内容。
    expect(byPermission.get('users:presence')).toBeNull()
    expect(byPermission.get('scripts:author')).toBe('admin-1')
  })
})

describe('RFC-312 实现门 —— 单调时钟必须真的接的是单调源', () => {
  // P3-11。原有"墙钟回拨"用例只给纯函数喂人工数字，把生产 `nowMs()` 换成 `Date.now()`
  // 也不会红——单调时钟的**接线**没有任何锁。这两条补的正是接线本身。
  test('生产时钟读数不随墙钟回拨而回退', () => {
    const clock = new PerformanceMonotonicClock()
    const a = clock.nowMs()
    // 模拟 NTP 把墙钟拨回一小时：单调源不受影响。
    const realNow = Date.now
    try {
      Date.now = () => realNow() - 3_600_000
      const b = clock.nowMs()
      expect(b).toBeGreaterThanOrEqual(a)
    } finally {
      Date.now = realNow
    }
  })

  test('实现不得改回墙钟（源代码层兜底断言）', () => {
    const src = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'identity-access',
        'infrastructure',
        'inMemoryPresence.ts',
      ),
      'utf8',
    )
    const body = src.slice(src.indexOf('class PerformanceMonotonicClock'))
    // 墙钟回拨会让宽限期永远到不了期，用户被钉在"在线"约一小时。
    expect(body).not.toContain('Date.now')
    expect(body).toContain('performance.now')
  })
})

describe('RFC-312 实现门 —— 撤权拒绝链必须有行为锁', () => {
  afterEach(() => {
    resetConnectionsForTest()
  })

  // P2-9。原有用例只断言 spec 上 `rerunUpgradeGate === true`，那是**声明**不是行为：
  // 若有人给 presence 加一条"跳过复核"的捷径，那条断言照样绿。这里真的跑一遍
  // 「已有订阅 → 删除 grant → 复核 → 4403」，并带正向对照（有权限时不关）。
  test('删除 users:presence 后，既有 presence 连接被 4403 关掉（含正向对照）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const log = createLogger('test')
    const user = await createUser(db, {
      username: 'watcher',
      displayName: 'watcher',
      role: 'user',
      password: 'longEnoughPassword',
    })
    // user 静态 preset 不含该点，但建号路径会**默认发放**它（RFC-312 的授权形态）。
    // 这里顺手断言一次：若哪天默认发放被去掉，本用例的前提就不成立，应当立刻可见。
    const granted = db.$client
      .query(`SELECT permission FROM user_permission_grants WHERE user_id = ?`)
      .all(user.id) as Array<{ permission: string }>
    expect(granted.map((g) => g.permission)).toContain('users:presence')
    const { token } = await createSession({ db, userId: user.id })
    const fp = describeCredential(token)
    const credential: WsCredential =
      fp.kind === 'daemon' ? { kind: 'daemon' } : { ...fp, expiresAt: null }

    const identityAccess = composeIdentityAccess(db)
    const identity = await admitWsIdentity(identityAccess, user.id)
    const closes: Array<{ code: number; reason: string }> = []
    const data: WsConnectionData = {
      channel: { kind: 'presence' },
      actor: identity.actor,
      authority: identity.authority,
      identityAccess: identity.identityAccess,
      credential,
      closing: false,
      revalidating: false,
      upgradeEpoch: 0,
      unsubscribe: () => {},
      visibilityCache: new Map(),
    }
    const ws = {
      data,
      send: (p: string) => p.length,
      close: (code: number, reason: string) => closes.push({ code, reason }),
    } as unknown as ServerWebSocket<WsConnectionData>
    trackConnection(ws)

    // 正向对照：持有该权限时，复核**不得**关掉它。
    const before = await revalidateAllConnections({ db, log }, 'user-patched')
    expect(closes).toEqual([])
    expect(before.closedGate).toBe(0)

    // 撤权后：整连接级权限门在复核里重跑，连接必须被 4403 关掉。
    db.$client
      .query(`DELETE FROM user_permission_grants WHERE user_id = ? AND permission = ?`)
      .run(user.id, 'users:presence')
    const after = await revalidateAllConnections({ db, log }, 'user-patched')
    expect(after.closedGate).toBe(1)
    expect(closes).toEqual([{ code: WS_CLOSE_NOT_VISIBLE, reason: 'permission-required' }])
  })
})
