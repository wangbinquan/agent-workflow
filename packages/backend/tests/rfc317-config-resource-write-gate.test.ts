// RFC-317 C1 / findings.md ACL-01 —— 五类数字员工配置资源的写门。
//
// 为什么这个文件存在
// ------------------
// `routes/developmentConfig.ts` 用一个**自己写的** `requireVisible` 当写门，而不是
// 其余七类 ACL 资源共用的 `requireResourceOwner`。`requireVisible` 只判「看得见」，
// 于是写门等于读门：
//
//   - `user` 角色预设本就持有这五类的 `:update` / `:archive` 点
//     （`shared/schemas/permission.ts` 的 `USER_RESOURCE_WRITES`）；
//   - 这些资源里凡是 `visibility='public'` 的，对每个登录用户都可见；
//   - ⇒ **任何登录用户都能改写 / 发布 / 归档别人的** 动作模板、验证档案、数字员工、
//     自动化策略与适配器定义。
//
// 而同一份 permission 文件的注释白纸黑字写着「per-row check 是 resource ACL，
// 和这里其他类型一样」——名实不符，且不符的方向是放行。
//
// 本文件锁死修复后的语义。**红→绿对**：把 `developmentConfig.ts` 里的
// `requireOwned` 换回 `requireVisible`，本文件的 403 组必须立刻全红。
//
// 顺带锁住一个容易想当然的事实：**`read` 档的 grant 不含写权**。
//
// RFC-324 就是那个「产品决策」（本注释此前预告过它，措辞是「必须先改这里的断言，
// 而不是悄悄放行」）：授权从此分两档。`read` 是迁移后每一条存量授权的档位，语义与
// RFC-324 之前逐字相同——只授可见与可用，写仍然 403，下面那组断言原样保留、含义
// 未变。`write` 档是新增的第二档，它放行 revise / publish，**但不放行 archive**
// （归档与删除同级，属治理面）。两侧都在本文件里锁着。
//
// 行是直接种进 DB 的，不走各自的 create 端点：写门只 `load()` 一行，种子化让本文件
// 不必背负每种类型创建时的特有约束（草稿 schema、能力引用闭包……），那些与被测边界无关。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  actionTemplates,
  automationPolicies,
  developmentAdapterDefinitions,
  digitalEmployees,
  resourceGrants,
  verificationProfiles,
} from '../src/db/schema'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_700_000_000_000

interface Actor {
  id: string
  token: string
}

interface Harness {
  db: DbClient
  app: Hono
  owner: Actor
  grantee: Actor
  stranger: Actor
  admin: Actor
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-rfc317-write-gate-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  const mkUser = async (username: string, role: 'admin' | 'user'): Promise<Actor> => {
    const user = await createUser(db, {
      username,
      displayName: username,
      role,
      password: 'longEnoughPassword',
    })
    const { token } = await createSession({ db, userId: user.id })
    return { id: user.id, token }
  }
  return {
    db,
    app,
    owner: await mkUser('owner', 'user'),
    grantee: await mkUser('grantee', 'user'),
    stranger: await mkUser('stranger', 'user'),
    admin: await mkUser('root', 'admin'),
  }
}

async function req(
  app: Hono,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return app.request(path, { ...init, headers })
}

type ConfigTable =
  | typeof actionTemplates
  | typeof automationPolicies
  | typeof developmentAdapterDefinitions
  | typeof digitalEmployees
  | typeof verificationProfiles

interface ResourceCase {
  /** `AclResourceType` 的字面量；也是 `resource_grants.resource_type` 的取值。 */
  readonly type:
    | 'action_template'
    | 'automation_policy'
    | 'development_adapter'
    | 'digital_employee'
    | 'verification_profile'
  readonly base: string
  readonly table: ConfigTable
  /** 该表在共享 identity 列之外的必填列。 */
  readonly extra: Record<string, string>
}

const CASES: readonly ResourceCase[] = [
  {
    type: 'action_template',
    base: '/api/code/action-templates',
    table: actionTemplates,
    extra: { capabilityId: 'rfc317-capability' },
  },
  {
    type: 'verification_profile',
    base: '/api/code/verification-profiles',
    table: verificationProfiles,
    extra: {},
  },
  {
    type: 'digital_employee',
    base: '/api/code/digital-employees',
    table: digitalEmployees,
    extra: {},
  },
  {
    type: 'automation_policy',
    base: '/api/code/automation-policies',
    table: automationPolicies,
    extra: {},
  },
  {
    type: 'development_adapter',
    base: '/api/integrations/development-adapters',
    table: developmentAdapterDefinitions,
    extra: { purpose: 'requirement-source' },
  },
]

interface SeededRow {
  id: string
  draftJson: string
  updatedAt: number
  publishedRevision: number | null
  archivedAt: number | null
}

async function seed(
  db: DbClient,
  subject: ResourceCase,
  ownerUserId: string,
  visibility: 'private' | 'public',
): Promise<string> {
  const id = ulid()
  await db
    .insert(subject.table)
    .values({
      id,
      name: `rfc317-${subject.type}-${id.slice(-6)}`,
      draftJson: JSON.stringify({ seeded: true }),
      publishedRevision: null,
      ownerUserId,
      visibility,
      aclRevision: 0,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      ...subject.extra,
    } as never)
    .run()
  return id
}

async function readRow(db: DbClient, subject: ResourceCase, id: string): Promise<SeededRow> {
  const rows = await db.select().from(subject.table).where(eq(subject.table.id, id)).all()
  const row = rows[0]
  expect(row, `种子行必须存在，否则本用例零预言力：${subject.type}/${id}`).toBeDefined()
  const found = row as unknown as SeededRow
  return {
    id: found.id,
    draftJson: found.draftJson,
    updatedAt: found.updatedAt,
    publishedRevision: found.publishedRevision,
    archivedAt: found.archivedAt,
  }
}

/** 三个写入口。revise 需要合法 body，否则会先撞 422 而不是权限判据。 */
function writeAttempts(
  base: string,
  id: string,
): ReadonlyArray<{ label: string; init: RequestInit; path: string }> {
  return [
    {
      label: 'revise',
      path: `${base}/${id}`,
      init: { method: 'PUT', body: JSON.stringify({ draft: { intruded: true } }) },
    },
    { label: 'publish', path: `${base}/${id}/publish`, init: { method: 'POST' } },
    { label: 'archive', path: `${base}/${id}/archive`, init: { method: 'POST' } },
  ]
}

describe('RFC-317 C1 —— 配置资源写门只认 owner', () => {
  test('CASES 覆盖 developmentConfig 挂载的全部五类（扫到 0 条即本文件零预言力）', () => {
    expect(CASES.length).toBe(5)
    expect([...new Set(CASES.map((subject) => subject.type))].length).toBe(5)
  })

  for (const subject of CASES) {
    test(`${subject.type}：public 行——非 owner 的三个写入口全部 403 且零写入`, async () => {
      const harness = await buildHarness()
      const id = await seed(harness.db, subject, harness.owner.id, 'public')
      const before = await readRow(harness.db, subject, id)

      if (subject.type === 'development_adapter') {
        const detail = await req(harness.app, harness.stranger.token, `${subject.base}/${id}`)
        expect(detail.status, 'public visibility alone must not expose Adapter detail').toBe(403)
        expect((await detail.json()) as { code: string }).toMatchObject({
          code: 'adapter-technical-details-forbidden',
        })
      }

      for (const attempt of writeAttempts(subject.base, id)) {
        const res = await req(harness.app, harness.stranger.token, attempt.path, attempt.init)
        expect(res.status, `${subject.type} ${attempt.label} 应 403（可见但非 owner）`).toBe(403)
        const after = await readRow(harness.db, subject, id)
        expect(after, `${subject.type} ${attempt.label} 被拒后不得留下任何持久写入`).toEqual(before)
      }
    })

    test(`${subject.type}：read 档 grant 的非 owner 写仍 403——只授可见，不授写`, async () => {
      const harness = await buildHarness()
      const id = await seed(harness.db, subject, harness.owner.id, 'private')
      await harness.db
        .insert(resourceGrants)
        .values({
          resourceType: subject.type,
          resourceId: id,
          userId: harness.grantee.id,
          addedBy: harness.owner.id,
          addedAt: NOW,
        })
        .run()
      const before = await readRow(harness.db, subject, id)

      // 前提复核：没有这一句，下面的 403 可能只是「看不见」的 404 被误读。
      const visible = await req(harness.app, harness.grantee.token, `${subject.base}/${id}`)
      expect(visible.status, '前提不成立：被授权者应当看得见这一行，否则本用例测的不是写门').toBe(
        200,
      )
      if (subject.type === 'development_adapter') {
        const metadata = (await visible.json()) as Record<string, unknown>
        expect(metadata).toMatchObject({ id, purpose: 'requirement-source' })
        expect(metadata).not.toHaveProperty('draft')
      }

      for (const attempt of writeAttempts(subject.base, id)) {
        const res = await req(harness.app, harness.grantee.token, attempt.path, attempt.init)
        expect(res.status, `${subject.type} ${attempt.label}：被授权者仍不得写`).toBe(403)
        expect(await readRow(harness.db, subject, id)).toEqual(before)
      }
    })

    // RFC-324 —— 第二档。与上一条用例逐字对照：同样的人、同样的三个入口，唯一的
    // 差别是 grant 的 `level`。revise / publish 从 403 变成放行，archive 仍是 403。
    test(`${subject.type}：write 档 grant 能 revise/publish，archive 仍 403（治理面不放行）`, async () => {
      const harness = await buildHarness()
      const id = await seed(harness.db, subject, harness.owner.id, 'private')
      await harness.db
        .insert(resourceGrants)
        .values({
          resourceType: subject.type,
          resourceId: id,
          userId: harness.grantee.id,
          level: 'write',
          addedBy: harness.owner.id,
          addedAt: NOW,
        })
        .run()
      const before = await readRow(harness.db, subject, id)

      const revise = await req(harness.app, harness.grantee.token, `${subject.base}/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ draft: { revisedBy: 'write-grantee' } }),
      })
      expect(
        [403, 404],
        `${subject.type}：write 档必须被写门放行（放行后是 200 还是该类型自己的 422 由领域规则决定）`,
      ).not.toContain(revise.status)
      const afterRevise = await readRow(harness.db, subject, id)
      if (revise.status === 200) {
        expect(afterRevise.draftJson, 'write 档放行后的写必须真的落库').not.toBe(before.draftJson)
      } else {
        expect(revise.status, '非 200 时只接受内容校验 422').toBe(422)
        expect(afterRevise, '内容校验失败不得留下持久写入').toEqual(before)
      }

      const publish = await req(
        harness.app,
        harness.grantee.token,
        `${subject.base}/${id}/publish`,
        { method: 'POST' },
      )
      expect([403, 404], `${subject.type}：发布与编辑同档（RFC-324 D8）`).not.toContain(
        publish.status,
      )

      const beforeArchive = await readRow(harness.db, subject, id)
      const archive = await req(
        harness.app,
        harness.grantee.token,
        `${subject.base}/${id}/archive`,
        { method: 'POST' },
      )
      expect(archive.status, `${subject.type}：archive 属治理面，write 档不得放行`).toBe(403)
      expect((await archive.json()) as { code: string }).toMatchObject({
        code: 'resource-govern-owner-only',
      })
      expect(await readRow(harness.db, subject, id), 'archive 被拒后不得留下任何持久写入').toEqual(
        beforeArchive,
      )
    })

    test(`${subject.type}：private 行对陌生人是 404，与不存在同形（不泄漏存在性）`, async () => {
      const harness = await buildHarness()
      const id = await seed(harness.db, subject, harness.owner.id, 'private')
      const before = await readRow(harness.db, subject, id)

      for (const attempt of writeAttempts(subject.base, id)) {
        const res = await req(harness.app, harness.stranger.token, attempt.path, attempt.init)
        expect(res.status, `${subject.type} ${attempt.label}：不可见必须 404 而非 403`).toBe(404)
        expect(await readRow(harness.db, subject, id)).toEqual(before)
      }
    })

    // 正向用例的被测面是**写门**，不是各类型的草稿 schema。断言「门放行了」=
    // 既不是 403（非 owner）也不是 404（不可见）。放行之后是 200 还是该类型自己的
    // 内容校验 422，属那个类型的领域规则，不该由本文件绑架——否则任何一次无关的
    // 草稿 schema 变更都会把这里染红，久而久之就会有人把断言改松。
    // 两种放行结果各自还要有持久效果断言，避免退化成「只要不是 403 就算过」。
    for (const who of ['owner', 'admin'] as const) {
      const why =
        who === 'owner'
          ? 'owner 必须写得动'
          : 'bypass 持有者是收紧后仅剩的跨 owner 写入口，逃生阀不能被一并封死'
      test(`${subject.type}：${who} 的 revise 被写门放行（${why}）`, async () => {
        const harness = await buildHarness()
        const id = await seed(harness.db, subject, harness.owner.id, 'private')
        const before = await readRow(harness.db, subject, id)

        const res = await req(harness.app, harness[who].token, `${subject.base}/${id}`, {
          method: 'PUT',
          body: JSON.stringify({ draft: { revisedBy: who } }),
        })
        expect([403, 404], `${subject.type}/${who}：${why}`).not.toContain(res.status)

        const after = await readRow(harness.db, subject, id)
        if (res.status === 200) {
          expect(after.draftJson, `${subject.type}/${who}：放行后的写必须真的落库`).not.toBe(
            before.draftJson,
          )
        } else {
          // 被该类型自己的内容校验挡下：状态必须是 422，且不得留下半截写入。
          expect(res.status, `${subject.type}/${who}：非 200 时只接受内容校验 422`).toBe(422)
          expect(after, `${subject.type}/${who}：内容校验失败不得留下持久写入`).toEqual(before)
        }
      })
    }
  }

  test('development_adapter：technical owner detail includes the draft', async () => {
    const harness = await buildHarness()
    const subject = CASES.find((candidate) => candidate.type === 'development_adapter')
    expect(subject).toBeDefined()
    const id = await seed(harness.db, subject!, harness.admin.id, 'private')

    const detail = await req(harness.app, harness.admin.token, `${subject!.base}/${id}`)
    expect(detail.status).toBe(200)
    expect((await detail.json()) as Record<string, unknown>).toMatchObject({
      id,
      draft: { seeded: true },
    })
  })
})

// RFC-330 D-② —— 旧 `/code/config/employees` 详情页的 playbook 保存路径此前误挂治理门
// （`requireGovernable`）：被授权的 `write` 编辑者在那一页保存一律 403，而同一资源的
// 新式 PUT 早已按 RFC-324 放行。现在同为内容写：write 档放行、read 档 403、改名归 owner。
describe('RFC-330 D-② —— digital_employee playbook 保存是内容写', () => {
  const PLAYBOOK = (id: string): string => `/api/code/digital-employees/${id}/playbook`

  async function seedWithGrant(level: 'read' | 'write'): Promise<{ harness: Harness; id: string }> {
    const harness = await buildHarness()
    const subject = CASES.find((c) => c.type === 'digital_employee')!
    const id = await seed(harness.db, subject, harness.owner.id, 'private')
    await harness.db
      .insert(resourceGrants)
      .values({
        resourceType: 'digital_employee',
        resourceId: id,
        userId: harness.grantee.id,
        level,
        addedBy: harness.owner.id,
        addedAt: NOW,
      })
      .run()
    return { harness, id }
  }

  const VALID_PLAYBOOK = {
    schemaVersion: 1,
    description: 'saved by a write grantee',
    supportedRepositoryFacts: [],
    capabilityRoutes: [],
    requirementSources: [],
    pipelineProviders: [],
    defaultPolicyRef: { id: 'rfc330-policy', revision: 1 },
  }

  test('write 档：保存合法 playbook → 200 且落库（不再 403 govern）', async () => {
    const { harness, id } = await seedWithGrant('write')
    const subject = CASES.find((c) => c.type === 'digital_employee')!
    const before = await readRow(harness.db, subject, id)
    const res = await req(harness.app, harness.grantee.token, PLAYBOOK(id), {
      method: 'PUT',
      body: JSON.stringify({ playbook: VALID_PLAYBOOK }),
    })
    expect(res.status, await res.clone().text()).toBe(200)
    const after = await readRow(harness.db, subject, id)
    expect(after.draftJson).not.toBe(before.draftJson)
    expect(JSON.parse(after.draftJson) as { description?: string }).toMatchObject({
      description: 'saved by a write grantee',
    })
  })

  test('write 档带改名 ⇒ 403 resource-rename-owner-only', async () => {
    const { harness, id } = await seedWithGrant('write')
    const res = await req(harness.app, harness.grantee.token, PLAYBOOK(id), {
      method: 'PUT',
      body: JSON.stringify({ name: 'renamed-by-editor', playbook: VALID_PLAYBOOK }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()) as { code: string }).toMatchObject({
      code: 'resource-rename-owner-only',
    })
  })

  test('read 档 ⇒ 403 resource-read-only', async () => {
    const { harness, id } = await seedWithGrant('read')
    const res = await req(harness.app, harness.grantee.token, PLAYBOOK(id), {
      method: 'PUT',
      body: JSON.stringify({ playbook: VALID_PLAYBOOK }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'resource-read-only' })
  })
})
