// RFC-349 T10 回归防护 —— 源库被迁移冻结时，请求路径一个字节都不许写。
//
// 为什么这条测试存在：迁移先冻结 SQLite 源、再证明拷贝期间它没变过
//（`sqliteLogicalSource.assertUnchanged`：data_version 变了就判 `sqlite-source-mutated`）。
// 路由层的维护门（`runBusinessRequest`）已经会对业务请求回 503，但**迁移必须能被盯着看**，
// 所以 `/api/database/*` 与 `/api/health` 是故意豁免的——而这些请求照样要过认证，认证顺手写
// 两条**活动投影**：`user_sessions.last_used_at`（每会话每秒最多一次）与
// `user_pats.last_used_at`（每次请求都写）；PAT 请求结束后还会补一条 token-call 审计。
// 它们都发生在路由门**之前**，任何路由层的门都拦不到；而只要冻结窗内落下一页写，
// 拷贝就必红。实测：4.3GB 那次冻结窗有 5.8 分钟，本机 45MB 复现也是每次必中，
// 失败前 29ms 那条写就是 `last_used_at`。
//
// 判据：①窗口关着时两条 last-used 投影都不落库，开着时照常落；②凭据判定本身不受影响
//（关着时仍然认得出这个会话/PAT，只是不更新“最近使用”）；③生产装配确实把真窗口接上了——
// 否则这层在 daemon 里永远是空转。

import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createSqliteAuthRuntime } from '../src/auth/composition'
import { createPat } from '../src/auth/patStore'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { userPats, users, userSessions } from '../src/db/schema'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const backendRoot = resolve(import.meta.dir, '..')

const FROZEN = Object.freeze({ writable: () => false })
const OPEN = Object.freeze({ writable: () => true })

let db: DbClient

beforeEach(async () => {
  db = createInMemoryDb(MIGRATIONS)
  await db.insert(users).values({
    id: 'u-frozen',
    username: 'frozen',
    displayName: 'Frozen',
    role: 'admin',
    status: 'active',
    passwordHash: null,
    createdAt: 1,
    updatedAt: 1,
  })
})

const sessionRow = (id: string) =>
  db.select().from(userSessions).where(eq(userSessions.id, id)).get()
const patRow = (id: string) => db.select().from(userPats).where(eq(userPats.id, id)).get()

describe('RFC-349 T10 — a frozen source sees no request-path writes', () => {
  test('the session last-used projection is skipped while frozen and resumes after', async () => {
    const created = await createSession({ db, userId: 'u-frozen', now: 1_000 })
    const before = sessionRow(created.session.id)!.lastUsedAt

    const frozen = createSqliteAuthRuntime({ db, sourceWriteWindow: FROZEN })
    const resolvedWhileFrozen = await frozen.lookupActiveSession(created.token, 900_000)
    expect(
      resolvedWhileFrozen,
      '冻结期间连凭据都认不出来了 ⇒ 迁移进度页会被登出，这不是本条要的效果',
    ).not.toBeNull()
    expect(
      sessionRow(created.session.id)!.lastUsedAt,
      '冻结窗内写了 last_used_at ⇒ 源库被改，拷贝随后以 sqlite-source-mutated 收场',
    ).toBe(before)

    const open = createSqliteAuthRuntime({ db, sourceWriteWindow: OPEN })
    await open.lookupActiveSession(created.token, 900_000)
    expect(
      sessionRow(created.session.id)!.lastUsedAt,
      '窗口重新打开后还是不写 ⇒ 这条投影被永久关掉了，不是只在维护窗内让路',
    ).toBe(900_000)
  })

  test('the PAT last-used projection is skipped while frozen and resumes after', async () => {
    const created = await createPat({
      db,
      userId: 'u-frozen',
      name: 'frozen-pat',
      purpose: 'general',
      now: 1_000,
    })
    const before = patRow(created.meta.id)!.lastUsedAt

    const frozen = createSqliteAuthRuntime({ db, sourceWriteWindow: FROZEN })
    expect(await frozen.lookupActivePat(created.token, 900_000)).not.toBeNull()
    expect(
      patRow(created.meta.id)!.lastUsedAt,
      'PAT 的 last_used_at 每次请求都写，冻结窗内一次就够把拷贝判红',
    ).toBe(before)

    const open = createSqliteAuthRuntime({ db, sourceWriteWindow: OPEN })
    await open.lookupActivePat(created.token, 900_000)
    expect(patRow(created.meta.id)!.lastUsedAt).toBe(900_000)
  })

  test('omitting the window keeps today’s behaviour: every composition without a migration writes', async () => {
    const created = await createSession({ db, userId: 'u-frozen', now: 1_000 })
    const runtime = createSqliteAuthRuntime({ db })
    await runtime.lookupActiveSession(created.token, 900_000)
    expect(
      sessionRow(created.session.id)!.lastUsedAt,
      '默认组装也不写了 ⇒ 这个改动越界了，它只该在迁移冻结时让路',
    ).toBe(900_000)
  })

  test('the token-call audit consults the same window', () => {
    const server = readFileSync(resolve(backendRoot, 'src/server.ts'), 'utf8')
    const at = server.indexOf('deps.core.tokenCallAudit.record({')
    expect(at, '审计中间件不见了（结构变了？）').toBeGreaterThan(-1)
    expect(
      server.slice(Math.max(0, at - 400), at),
      'PAT 请求的审计行照写 ⇒ 冻结窗内它就是请求路径的另一个写手',
    ).toContain('deps.core.sourceWriteWindow.writable()')
  })

  test('the daemon binds the live window, not the always-writable default', () => {
    const start = readFileSync(resolve(backendRoot, 'src/cli/start.ts'), 'utf8')
    // SQLite daemon: the provider core must receive the deferred holder's window.
    const core = start.indexOf('composeSqliteDaemonProviderCore({')
    expect(core).toBeGreaterThan(-1)
    expect(
      start.slice(core, core + 300),
      'SQLite daemon 没把真窗口交给 provider core ⇒ 这层在生产里永远是空转',
    ).toContain('sourceWriteWindow: deferredDatabaseMigrationAdmission.sourceWriteWindow')
    // PostgreSQL daemon: same window, threaded through the session composer.
    expect(
      start.split('sourceWriteWindow: deferredDatabaseMigrationAdmission.sourceWriteWindow')
        .length - 1,
      '两个 provider 的装配没有都接上同一个窗口',
    ).toBeGreaterThanOrEqual(4)
    // The window itself must read the bound admission phase, not a constant.
    expect(start).toContain("writable: () => bound === null || bound.live().phase === 'open'")
  })
})
