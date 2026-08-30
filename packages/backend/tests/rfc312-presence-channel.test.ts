// RFC-312 —— `/ws/presence` 通道的接线锁。
//
// 这条通道刻意做成**独立通道 + 整连接级权限门**（不是挂在 authority 上逐帧过滤）。
// 设计门跑了七轮，六条 P1 全部长在"挂 authority 就得自建一套权限变更重同步协议"上；
// 独立通道让那套协议整体消失：权限被收回时 rerunUpgradeGate 直接关连接，客户端重连即可。
// 因此本文件锁的是那个替代方案真的成立：
//
//   1. 无 `users:presence` ⇒ 升级被拒（不是"连上但收不到帧"）；
//   2. 有权限 ⇒ 连接建立即收到一次全量快照；
//   3. 该通道**没有 frameGate**——整条连接已在升级时鉴权，逐帧再判会连坐吃掉控制帧；
//   4. 声明了 rerunUpgradeGate ⇒ 权限被收回时既有复核机制会关掉它。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { ServerWebSocket } from 'bun'

import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb } from '../src/db/client'
import { checkUpgradeGate, WS_CHANNELS, type WsConnectionData } from '../src/ws/registry'
import { composeIdentityAccess } from '../src/modules/identity-access/composition'
import { admitWsIdentity } from './helpers/identityAccessWs'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

/**
 * 必须真的把用户行写进库：`sendJson` 会先过 RFC-305 的出站 fence
 * （`SELECT status, access_revision FROM users WHERE id = ?`），查不到行就**丢帧**。
 * 这条 fence 也是 presence 唯一的 DB 成本来源——每帧每订阅者一次主键点查。
 */
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

function fakeWs(identity: Awaited<ReturnType<typeof admitWsIdentity>>): {
  ws: ServerWebSocket<WsConnectionData>
  sent: unknown[]
} {
  const sent: unknown[] = []
  const data: WsConnectionData = {
    channel: { kind: 'presence' },
    actor: identity.actor,
    authority: identity.authority,
    identityAccess: identity.identityAccess,
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
        sent.push(JSON.parse(payload))
        return payload.length
      },
    } as unknown as ServerWebSocket<WsConnectionData>,
    sent,
  }
}

describe('rfc312 /ws/presence channel', () => {
  test('无 users:presence ⇒ 升级被拒，错误码是 permission-required', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    // 普通 user 的静态 preset 不含该点（它走显式 grant），所以裸 user 应被拒
    const verdict = await checkUpgradeGate(db, actorWith('user'), { kind: 'presence' })
    expect(verdict).not.toBe(true)
    expect(verdict === true ? null : verdict.code).toBe('permission-required')
  })

  test('admin 由动态全量 baseline 自动持有 ⇒ 升级通过', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    expect(await checkUpgradeGate(db, actorWith('admin'), { kind: 'presence' })).toBe(true)
  })

  test('连接建立即收到一次全量快照，内容 = 当前在线者', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedUser(db, 'viewer')
    const identityAccess = composeIdentityAccess(db)
    const { trackUserPresence } = identityAccess
    trackUserPresence.opened('someone-else')

    const { ws, sent } = fakeWs(await admitWsIdentity(identityAccess, 'viewer'))
    await WS_CHANNELS.presence.onOpenExtra?.(ws, { kind: 'presence' }, db)

    expect(sent).toHaveLength(1)
    const frame = sent[0] as { type: string; online: string[] }
    expect(frame.type).toBe('presence.snapshot')
    // 登记发生在发快照之前，所以订阅者**自己也在名单里**——这是对的：
    // 它这一刻确实在线，快照必须反映当下真值而不是"除我之外的人"。
    expect([...frame.online].sort()).toEqual(['someone-else', 'viewer'])
  })

  test('onOpenExtra 会登记本连接：登记后自己也出现在快照里，释放后消失', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedUser(db, 'me')
    const identityAccess = composeIdentityAccess(db)
    const { getUserPresence } = identityAccess
    const { ws } = fakeWs(await admitWsIdentity(identityAccess, 'me'))

    expect(getUserPresence.stateOf('me')).toBe('offline')
    await WS_CHANNELS.presence.onOpenExtra?.(ws, { kind: 'presence' }, db)
    expect(getUserPresence.stateOf('me')).toBe('online')

    // 释放句柄已装上，且只应生效一次
    expect(typeof ws.data.presenceLease?.release).toBe('function')
    ws.data.presenceLease?.release()
    // 宽限期内仍是 online——这是"刷新不闪烁"的语义，不是 bug
    expect(getUserPresence.stateOf('me')).toBe('online')
  })

  test('PAT 凭据不计入在线（那是脚本在跑，不是人在看）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedUser(db, 'bot')
    const identityAccess = composeIdentityAccess(db)
    const { getUserPresence } = identityAccess
    const { ws, sent } = fakeWs(await admitWsIdentity(identityAccess, 'bot', 'pat'))
    ws.data.credential = { kind: 'pat', hash: 'h', expiresAt: null }

    await WS_CHANNELS.presence.onOpenExtra?.(ws, { kind: 'presence' }, db)
    expect(getUserPresence.stateOf('bot')).toBe('offline')
    expect(ws.data.presenceLease).toBeUndefined()
    // 但快照照发——它有权限看别人
    expect(sent).toHaveLength(1)
  })

  test('通道声明：无 frameGate、有 upgradeGate、rerunUpgradeGate 为 true', () => {
    const spec = WS_CHANNELS.presence
    // 整连接级鉴权 ⇒ 不需要也不应有逐帧门（逐帧门会连坐过滤控制帧）
    expect(spec.frameGate).toBeUndefined()
    expect(spec.upgradeGate).toBeDefined()
    // 权限被收回时必须由既有复核机制关掉连接——这是"撤权无需服务端协议"的全部依据
    expect(spec.revalidation.rerunUpgradeGate).toBe(true)
    expect(spec.revalidation.refreshActor).toBe(true)
  })
})
