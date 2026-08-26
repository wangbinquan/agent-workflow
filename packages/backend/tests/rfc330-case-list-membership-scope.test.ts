// RFC-330 缺口 1（docs/audit-backlog.md）—— 案例成员制要进统一任务列表的 mine / shared。
//
// 修前：`task-catalog-adapter.ts` 的 digital-employee 来源对 `scope=shared` 硬编码返回空页，
// `mine` 只按 owner 过滤——被加为成员（observer / collaborator）的人在「我的任务」「与我共享」
// 里都找不到案例，只能靠链接直达。修后与任务侧 `taskOwnershipScopeCondition` 同语义：
//   mine   = 发起人 ∨ 成员
//   shared = 成员 ∧ 非发起人（`owner_user_id IS NULL` 的无主案例也算）
//   all    = 只有持 tasks:read:all 的人到得了；普通用户的 all 降成 mine
// facets 与条目同口径。**红→绿对**：把 sqliteRuntimeStore.listCasesPage 的 membership 条件删掉，
// 或让 adapter 重新对 shared 返回空页，本文件立刻红。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { Hono } from 'hono'
import { ulid } from 'ulid'

import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { employeeCaseMembers, employeeCases, employeeContextRecords } from '../src/db/schema'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_700_000_000_000

interface Actor {
  id: string
  token: string
}

async function mkUser(db: DbClient, username: string, role: 'admin' | 'user'): Promise<Actor> {
  const user = await createUser(db, {
    username,
    displayName: username,
    role,
    password: 'longEnoughPassword',
  })
  const { token } = await createSession({ db, userId: user.id })
  return { id: user.id, token }
}

async function seedCase(
  db: DbClient,
  ownerUserId: string | null,
  state: 'active' | 'blocked' | 'terminal' = 'active',
): Promise<string> {
  const id = ulid()
  await db
    .insert(employeeCases)
    .values({
      id,
      name: `case-${id.slice(-6)}`,
      employeeId: 'employee-1',
      employeeRevision: 1,
      typeId: 'development',
      typeRevision: 10,
      primaryContextId: `context-${id}`,
      executionPolicyRevision: 1,
      ownerUserId,
      state,
      ...(state === 'terminal' ? { terminalKind: 'completed' } : {}),
      revision: 1,
      writerGeneration: 1,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run()
  // 列表查询 inner join 主上下文（`listCasesPage` 用它做全文过滤）：没有这一行案例根本不出现。
  await db
    .insert(employeeContextRecords)
    .values({
      id: `context-${id}`,
      caseId: id,
      typeId: 'development',
      schemaVersion: 1,
      currentRevision: 1,
      lifecycleState: state === 'terminal' ? 'terminal' : 'active',
      stateJson: '{}',
      artifactRefsJson: '[]',
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run()
  return id
}

async function seedMember(
  db: DbClient,
  caseId: string,
  userId: string,
  role: 'collaborator' | 'observer',
): Promise<void> {
  await db
    .insert(employeeCaseMembers)
    .values({ caseId, userId, role, addedBy: 'seed', addedAt: NOW })
    .run()
}

interface CatalogPage {
  items: Array<{ id: string }>
  facets: { all: number; active: number; attention: number; finished: number }
}

async function listCases(
  app: Hono,
  token: string,
  scope: 'mine' | 'shared' | 'all',
  extra = '',
): Promise<CatalogPage> {
  const res = await app.request(`/api/task-catalog?type=digital-employee&scope=${scope}${extra}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(res.status).toBe(200)
  return (await res.json()) as CatalogPage
}

function ids(page: CatalogPage): string[] {
  return page.items.map((item) => item.id).sort()
}

async function buildHarness() {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-rfc330-case-list-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  const owner = await mkUser(db, 'l-owner', 'user')
  const member = await mkUser(db, 'l-member', 'user')
  const stranger = await mkUser(db, 'l-stranger', 'user')
  const admin = await mkUser(db, 'l-root', 'admin')

  const ownCase = await seedCase(db, owner.id) // owner 自己的，member 不在里面
  const sharedCase = await seedCase(db, owner.id, 'blocked') // owner 的，member 是 collaborator
  const observedCase = await seedCase(db, owner.id, 'terminal') // owner 的，member 是 observer
  const orphanCase = await seedCase(db, null) // 无主（系统发起），member 是 collaborator
  const memberOwnCase = await seedCase(db, member.id) // member 自己发起的
  await seedMember(db, sharedCase, member.id, 'collaborator')
  await seedMember(db, observedCase, member.id, 'observer')
  await seedMember(db, orphanCase, member.id, 'collaborator')

  return {
    app,
    owner,
    member,
    stranger,
    admin,
    ownCase,
    sharedCase,
    observedCase,
    orphanCase,
    memberOwnCase,
  }
}

describe('RFC-330 缺口 1 —— 案例成员进统一任务列表的 mine / shared', () => {
  test('成员的 shared = 别人发起且拉了我的案例（含无主案例），mine 再加上自己发起的', async () => {
    const h = await buildHarness()
    const shared = await listCases(h.app, h.member.token, 'shared')
    expect(ids(shared)).toEqual([h.sharedCase, h.observedCase, h.orphanCase].sort())
    const mine = await listCases(h.app, h.member.token, 'mine')
    expect(ids(mine)).toEqual([h.sharedCase, h.observedCase, h.orphanCase, h.memberOwnCase].sort())
  })

  test('facets 与条目同口径（shared 只数成员案例）', async () => {
    const h = await buildHarness()
    const shared = await listCases(h.app, h.member.token, 'shared')
    // sharedCase blocked → attention；observedCase terminal → finished；orphanCase active → active
    expect(shared.facets).toEqual({ all: 3, active: 1, attention: 1, finished: 1 })
    const mine = await listCases(h.app, h.member.token, 'mine')
    expect(mine.facets).toEqual({ all: 4, active: 2, attention: 1, finished: 1 })
  })

  test('发起人：mine 有自己的全部案例，shared 不含自己发起的', async () => {
    const h = await buildHarness()
    const mine = await listCases(h.app, h.owner.token, 'mine')
    expect(ids(mine)).toEqual([h.ownCase, h.sharedCase, h.observedCase].sort())
    const shared = await listCases(h.app, h.owner.token, 'shared')
    expect(ids(shared)).toEqual([])
  })

  test('既非发起人也非成员的人两档都为空；普通用户的 all 降成 mine', async () => {
    const h = await buildHarness()
    expect(ids(await listCases(h.app, h.stranger.token, 'mine'))).toEqual([])
    expect(ids(await listCases(h.app, h.stranger.token, 'shared'))).toEqual([])
    expect(ids(await listCases(h.app, h.stranger.token, 'all'))).toEqual([])
    const memberAll = await listCases(h.app, h.member.token, 'all')
    expect(ids(memberAll)).toEqual(ids(await listCases(h.app, h.member.token, 'mine')))
  })

  test('tasks:read:all（admin）的 all 看到全部案例，shared 仍按成员制', async () => {
    const h = await buildHarness()
    const all = await listCases(h.app, h.admin.token, 'all')
    expect(ids(all)).toEqual(
      [h.ownCase, h.sharedCase, h.observedCase, h.orphanCase, h.memberOwnCase].sort(),
    )
    expect(ids(await listCases(h.app, h.admin.token, 'shared'))).toEqual([])
  })

  test('view / 状态筛选在成员制之上继续生效', async () => {
    const h = await buildHarness()
    const attention = await listCases(h.app, h.member.token, 'shared', '&view=attention')
    expect(ids(attention)).toEqual([h.sharedCase])
    const finished = await listCases(h.app, h.member.token, 'shared', '&view=finished')
    expect(ids(finished)).toEqual([h.observedCase])
  })
})
