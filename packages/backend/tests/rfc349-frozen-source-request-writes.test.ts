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
import { createAuthRuntimeFor } from '../src/auth/composition'
import { createPat } from './helpers/auth/patStore'
import { createSession } from './helpers/auth/sessionStore'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { userPats, users, userSessions } from '../src/db/schema'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const backendRoot = resolve(import.meta.dir, '..')

const FROZEN = Object.freeze({ writable: () => false })
const OPEN = Object.freeze({ writable: () => true })

let db: ProviderNeutralDatabase

async function seedFixture(harness: ProviderHarness): Promise<void> {
  db = harness.db
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
}

const sessionRow = async (id: string) =>
  await db.select().from(userSessions).where(eq(userSessions.id, id)).get()
const patRow = async (id: string) =>
  await db.select().from(userPats).where(eq(userPats.id, id)).get()

describe('RFC-349 T10 — a frozen source sees no request-path writes', () => {
  // RFC-359 AC-6：冻结窗这层判据在**两个引擎**上各钉一遍。窗口本身是 provider-中立的
  // （`createAuthRuntimeFor` 按 `databaseSessionFor(db).engine.provider` 自选实现），
  // 而「冻结期间一个字节都不写」恰恰是拷贝源侧的不变量——只跑 SQLite 等于 PostgreSQL
  // 侧的同一条投影从未被验证过。
  describeEachProvider('冻结窗内的请求路径写入（双引擎）', (harness) => {
    beforeEach(async () => {
      await seedFixture(harness)
    })

    test('the session last-used projection is skipped while frozen and resumes after', async () => {
      const created = await createSession({ db, userId: 'u-frozen', now: 1_000 })
      const before = (await sessionRow(created.session.id))!.lastUsedAt

      const frozen = createAuthRuntimeFor({ db, sourceWriteWindow: FROZEN })
      const resolvedWhileFrozen = await frozen.lookupActiveSession(created.token, 900_000)
      expect(
        resolvedWhileFrozen,
        '冻结期间连凭据都认不出来了 ⇒ 迁移进度页会被登出，这不是本条要的效果',
      ).not.toBeNull()
      expect(
        (await sessionRow(created.session.id))!.lastUsedAt,
        '冻结窗内写了 last_used_at ⇒ 源库被改，拷贝随后以 sqlite-source-mutated 收场',
      ).toBe(before)

      const open = createAuthRuntimeFor({ db, sourceWriteWindow: OPEN })
      await open.lookupActiveSession(created.token, 900_000)
      expect(
        (await sessionRow(created.session.id))!.lastUsedAt,
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
      const before = (await patRow(created.meta.id))!.lastUsedAt

      const frozen = createAuthRuntimeFor({ db, sourceWriteWindow: FROZEN })
      expect(await frozen.lookupActivePat(created.token, 900_000)).not.toBeNull()
      expect(
        (await patRow(created.meta.id))!.lastUsedAt,
        'PAT 的 last_used_at 每次请求都写，冻结窗内一次就够把拷贝判红',
      ).toBe(before)

      const open = createAuthRuntimeFor({ db, sourceWriteWindow: OPEN })
      await open.lookupActivePat(created.token, 900_000)
      expect((await patRow(created.meta.id))!.lastUsedAt).toBe(900_000)
    })

    test('omitting the window keeps today’s behaviour: every composition without a migration writes', async () => {
      const created = await createSession({ db, userId: 'u-frozen', now: 1_000 })
      const runtime = createAuthRuntimeFor({ db })
      await runtime.lookupActiveSession(created.token, 900_000)
      expect(
        (await sessionRow(created.session.id))!.lastUsedAt,
        '默认组装也不写了 ⇒ 这个改动越界了，它只该在迁移冻结时让路',
      ).toBe(900_000)
    })
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
    const bootstrap = readFileSync(
      resolve(backendRoot, 'src/cli/daemonProviderBootstrap.ts'),
      'utf8',
    )
    // RFC-359 W12：bootstrap 先构造真实 admission，再把同一组 bindings 交给初始/切换会话。
    const sessionInput = start.indexOf('const sessionInput = Object.freeze({')
    expect(sessionInput).toBeGreaterThan(-1)
    expect(
      start.slice(sessionInput, sessionInput + 700),
      '初始会话必须接收 bootstrap 提供的真实迁移窗口',
    ).toMatch(
      /await composeDaemonProviderBootstrap\([\s\S]*composeInitial: \(bindings\)[\s\S]*\.\.\.bindings/u,
    )
    const nextSession = start.indexOf('async create(lifecycleInput, bindings)')
    expect(nextSession).toBeGreaterThan(-1)
    expect(start.slice(nextSession, nextSession + 1600)).toContain('...bindings,')
    // SQLite daemon: the provider core must receive that window (destructured from the input).
    const core = start.indexOf('composeSqliteDaemonProviderCore({')
    expect(core).toBeGreaterThan(-1)
    expect(
      start.slice(core, core + 300),
      'SQLite daemon 没把真窗口交给 provider core ⇒ 这层在生产里永远是空转',
    ).toMatch(/sourceWriteWindow,|sourceWriteWindow: sourceWriteWindow/u)
    // PostgreSQL daemon: same window, threaded through the session composer.
    expect(start, 'PG 装配没接上同一个窗口').toContain('sourceWriteWindow: input.sourceWriteWindow')
    // The window reads the actual admission even while the first session is composing.
    expect(bootstrap).toContain("writable: () => admission.live().phase === 'open'")
    expect(
      bootstrap.indexOf('const admission = createDaemonProviderMigrationAdmission('),
    ).toBeLessThan(bootstrap.indexOf('const initial = await input.composeInitial(bindings)'))
  })
})
