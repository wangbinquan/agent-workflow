// RFC-271 AC-12 —— 导出 fence 在**路由层**的解析边界。
//
// 覆盖验收条款：AC-12（根资源沿用 exact-revision 保护）
//   （编号锚点由 rfc271-ac-coverage.test.ts 机械核查，别删）
//
// 服务层的 fence 逻辑在 `rfc271-export-fence.test.ts` 里逐类型测过了。这里测的是**从
// query string 到 fence 对象**这一小段翻译，因为它有一个只在 HTTP 层才存在的失败形态：
//
//   `?expectedConfigHash=`（显式传了，但值是空）
//
// 旧实现写的是 `if (raw !== undefined && raw !== '') out[key] = raw`，于是这个请求**静默
// 降级成完全没有 fence**，返回 200 + zip；而 `?expectedConfigHash=wrong` 才 409。
//
// 这是最坏的一档失败：调用方以为自己有「所见非所得」防护，实际什么都没有。而空值恰恰是
// 前端最容易拼出来的——`?expectedConfigHash=${row.configHash ?? ''}`、表单未填、状态还没
// 加载完，都会产生它。「显式传了空」与「没传」在语义上是两回事，不能合并。

import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Hono, type MiddlewareHandler } from 'hono'
import { ulid } from 'ulid'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, mcps, users, workflows } from '../src/db/schema'
import type {
  CommandContext,
  QueryContext,
} from '../src/modules/identity-access/public/participants'
import { errorHandler } from '../src/util/errors'
import { registerResourcePackageRoutes } from '../src/routes/resourcePackages'
import { removeTempDirSync } from './fixtures/tempDir'
import { composeSqliteResourcePackageCatalogForTest } from './helpers/resourcePackageProvider'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const tempDirs: string[] = []

function testCommandContext(): CommandContext {
  return Object.freeze({
    get authority(): never {
      throw new Error('rfc271-export-fence-does-not-consume-request-authority')
    },
    operationId: 'rfc271-export-fence',
    correlationId: 'rfc271-export-fence',
    now: 0,
  })
}

function testQueryContext(): QueryContext {
  return Object.freeze({
    get authority(): never {
      throw new Error('rfc271-export-fence-does-not-consume-request-authority')
    },
    operationId: 'rfc271-export-fence',
    correlationId: 'rfc271-export-fence',
  })
}

function makeApp(db: DbClient, appHome: string): Hono {
  const box = createSecretBoxFromKey(randomBytes(32))
  const app = new Hono()
  const injectActor: MiddlewareHandler = async (c, next) => {
    c.set('actor', {
      user: {
        id: 'u1',
        username: 'u1',
        displayName: 'U1',
        role: 'admin',
        status: 'active',
      },
      source: 'daemon',
      permissions: new Set<string>([
        'agents:read',
        'skills:read',
        'mcps:read',
        'plugins:read',
        'workflows:read',
        'workgroups:read',
        'resource-acl:private',
        'agents:create',
        'agents:update',
        'skills:create',
        'skills:update',
        'mcps:create',
        'mcps:update',
        'plugins:create',
        'plugins:update',
        'workflows:create',
        'workflows:update',
        'workgroups:create',
        'workgroups:update',
        'scripts:author',
      ]),
    })
    await next()
  }
  app.use('*', injectActor)
  app.onError(errorHandler)
  registerResourcePackageRoutes(app, {
    catalog: composeSqliteResourcePackageCatalogForTest({ db, appHome, box }),
    commandContextFor: testCommandContext,
    queryContextFor: testQueryContext,
  })
  return app
}

async function seed(): Promise<{ db: DbClient; appHome: string; mcpId: string; wfId: string }> {
  const db = createInMemoryDb(MIGRATIONS)
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc271-fence-http-'))
  tempDirs.push(appHome)
  await db.insert(users).values({
    id: 'u1',
    username: 'u1',
    displayName: 'U1',
    role: 'admin',
    status: 'active',
    passwordHash: 'x',
    createdAt: 1,
    updatedAt: 1,
  } as never)
  const mcpId = ulid()
  await db.insert(mcps).values({
    id: mcpId,
    name: 'gh',
    description: '',
    type: 'remote',
    config: JSON.stringify({ url: 'https://x.test' }),
    enabled: true,
    ownerUserId: 'u1',
    visibility: 'private',
    createdAt: 1,
    updatedAt: 1,
  } as never)
  const wfId = ulid()
  await db.insert(workflows).values({
    id: wfId,
    name: 'wf',
    description: '',
    definition: JSON.stringify({ $schema_version: 4, inputs: [], edges: [], nodes: [] }),
    ownerUserId: 'u1',
    visibility: 'private',
    version: 2,
    aclRevision: 0,
    createdAt: 1,
    updatedAt: 1,
  } as never)
  return { db, appHome, mcpId, wfId }
}

const bodyCodeOf = async (res: Response): Promise<string> => {
  if (res.headers.get('content-type')?.includes('application/zip') === true) return 'ZIP'
  const json = (await res.json()) as { code?: string; error?: { code?: string } }
  return String(json.code ?? json.error?.code ?? 'unknown')
}

describe('AC-12 · 空 fence 参数不得静默降级', () => {
  test('`?expectedConfigHash=`（显式空）⇒ 422，而不是 200 + 无保护的 zip', async () => {
    const { db, appHome, mcpId } = await seed()
    const app = makeApp(db, appHome)
    const res = await app.request(`/api/mcps/${mcpId}/export-package?expectedConfigHash=`)
    expect(res.status).toBe(422)
    expect(await bodyCodeOf(res)).toBe('package-invalid')
    removeTempDirSync(appHome)
  })

  test('对照组：值写错 ⇒ 409；完全不带该参数 ⇒ 200 zip', async () => {
    // 这两条把上一条夹在中间：错值必须 409（fence 生效），不传必须 200（fence 可选）。
    // 三条一起才说明「显式空」被正确地归到了「错」而不是「不传」。
    const { db, appHome, mcpId } = await seed()
    const app = makeApp(db, appHome)

    const wrong = await app.request(
      `/api/mcps/${mcpId}/export-package?expectedConfigHash=definitely-not-it`,
    )
    expect(wrong.status).toBe(409)
    expect(await bodyCodeOf(wrong)).toBe('package-root-changed')

    const bare = await app.request(`/api/mcps/${mcpId}/export-package`)
    expect(bare.status).toBe(200)
    expect(await bodyCodeOf(bare)).toBe('ZIP')
    removeTempDirSync(appHome)
  })

  test("`%20`（空白）同样拒绝 —— `Number(' ')` 也是 0", async () => {
    // 第一版只挡逐字空串，于是 `?expectedVersion=%20` 照样被 `Number(' ')` 变成 0，
    // 再比出一个假的 409「资源已变更」（实现门第四轮实测）。判据改成「只收纯十进制
    // 数字串」，任何空白 / 符号 / 小数点一律拒。
    const { db, appHome, wfId } = await seed()
    const app = makeApp(db, appHome)
    const res = await app.request(`/api/workflows/${wfId}/export-package?expectedVersion=%20`)
    expect(res.status).toBe(422)
    expect(await bodyCodeOf(res)).toBe('package-invalid')
    removeTempDirSync(appHome)
  })

  test('`expectedVersion=0` 拒绝，而 `expectedAclRevision=0` 合法 —— 逐字段的取值域', async () => {
    // 一刀切「非负整数」两头错：`version` / `contentVersion` 从 1 起（正式 schema 就是
    // positive），0 是不可能存在的值、放进去只会比出假 409；而 `aclRevision` /
    // `metaRevision` 从 0 起，0 是合法初值、拒掉它等于让新建资源无法带 fence 导出。
    const { db, appHome, wfId } = await seed()
    const app = makeApp(db, appHome)

    const zeroVersion = await app.request(`/api/workflows/${wfId}/export-package?expectedVersion=0`)
    expect(zeroVersion.status).toBe(422)
    expect(await bodyCodeOf(zeroVersion)).toBe('package-invalid')

    // agent 的 fence 是 updatedAt + aclRevision，两者都可以是 0（刚建的资源）。
    const agentId = ulid()
    await db.insert(agents).values({
      id: agentId,
      name: 'fresh',
      description: '',
      outputs: '[]',
      permission: '{}',
      skills: '[]',
      dependsOn: '[]',
      mcp: '[]',
      plugins: '[]',
      frontmatterExtra: '{}',
      bodyMd: '',
      ownerUserId: 'u1',
      visibility: 'private',
      aclRevision: 0,
      createdAt: 1,
      updatedAt: 0,
    } as never)
    const zeroAcl = await app.request(
      `/api/agents/${agentId}/export-package?expectedUpdatedAt=0&expectedAclRevision=0`,
    )
    expect(zeroAcl.status).toBe(200)
    expect(await bodyCodeOf(zeroAcl)).toBe('ZIP')
    removeTempDirSync(appHome)
  })

  test('`expectedAclRevision=%20` 也必须拒 —— min=0 的字段挡不住「空白变 0」', async () => {
    // 反向验证逼出来的一条：把字面量判去掉时，`expectedVersion=%20` 仍然会红，因为它被
    // `min=1` 那道门顺手捡了漏。真正只有字面量判能挡的是 **min=0 的字段**——`Number(' ')`
    // 得到 0，而 0 对 aclRevision 是完全合法的初值，于是一个「什么都没填」的请求会被当成
    // 「我确认它是第 0 版」放行，用户以为有保护而实际没有。
    const { db, appHome } = await seed()
    const app = makeApp(db, appHome)
    const agentId = ulid()
    await db.insert(agents).values({
      id: agentId,
      name: 'a2',
      description: '',
      outputs: '[]',
      permission: '{}',
      skills: '[]',
      dependsOn: '[]',
      mcp: '[]',
      plugins: '[]',
      frontmatterExtra: '{}',
      bodyMd: '',
      ownerUserId: 'u1',
      visibility: 'private',
      aclRevision: 0,
      createdAt: 1,
      updatedAt: 0,
    } as never)

    const res = await app.request(
      `/api/agents/${agentId}/export-package?expectedUpdatedAt=0&expectedAclRevision=%20`,
    )
    expect(res.status).toBe(422)
    expect(await bodyCodeOf(res)).toBe('package-invalid')
    removeTempDirSync(appHome)
  })

  test('数值型 fence 的空值同样拒绝（`?expectedVersion=`）', async () => {
    // 数值支走的是 `z.coerce.number()`，而 `Number('')` 是 **0** —— 空串会被悄悄
    // 强转成一个看起来合法的 fence 值 0，然后拿 0 去比 version，稳定 409。
    // 那是个假阳性：用户没传值，却得到「资源已变更」。这里锁住它报的是格式错。
    const { db, appHome, wfId } = await seed()
    const app = makeApp(db, appHome)
    const res = await app.request(`/api/workflows/${wfId}/export-package?expectedVersion=`)
    expect(res.status).toBe(422)
    expect(await bodyCodeOf(res)).toBe('package-invalid')
    removeTempDirSync(appHome)
  })
})
