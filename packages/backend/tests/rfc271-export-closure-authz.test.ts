// RFC-271 —— 导出末端的**两道复核**：产物没变 × 你现在还有权导出。
//
// 覆盖验收条款：AC-7（导出要求整棵树可见，含传递依赖）
//   （编号锚点由 rfc271-ac-coverage.test.ts 机械核查，别删）
//
// 这个文件锁的是实现门第四轮的一对 finding，它们是**同一个错误的两面**：把「产物是否
// 变化」和「授权是否仍成立」合并成一次 `expectTokenOf` 比较。
//
//  · **P1-2 漏检（越权）**：workflow / workgroup 的 CAS token 只有 `version`，而 ACL 写
//    路径只推 `aclRevision` / `updatedAt`。于是「reader 对 private 子工作流有 grant →
//    发起导出 → 闭包捕获后 owner 撤销 grant」全程无感，导出仍 200，包里带走了此刻**已经
//    不可见**的资源。
//  · **P2-2 误拒**：agent / skill 的 token 含 `aclRevision`，MCP / plugin 的 hash 更覆盖
//    owner / visibility / 本机安装态。把一个 agent 从 private 改成 public——包字节一个
//    都不变——却让在途导出报 `package-closure-changed`。
//
// 我此前实测「ACL 漂移产出逐字节相同的包」并据此撤回了 fence 的 ACL 维。那个实测是对的，
// 但**结论下大了**：它只能推出「产物比较不该管 ACL」，推不出「ACL 无关紧要」。
// **产物等价 ≠ 授权仍然成立。**
//
// 所以两道复核分开：产物比较用「整行减 ACL 列」，授权复核重新查 grant 跑 `isVisibleRow`。

import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, plugins, resourceGrants, users, workflows } from '../src/db/schema'
import { exportResourcePackage } from '../src/services/resourcePackage/export'
import { removeTempDirSync } from './fixtures/tempDir'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const actorOf = (id: string): Actor =>
  ({
    user: { id, username: id, displayName: id, role: 'user', status: 'active' },
    source: 'daemon',
    permissions: new Set<string>(['scripts:author']),
  }) as unknown as Actor

const codeOf = async (p: Promise<unknown>): Promise<string | undefined> =>
  p.then(
    () => undefined,
    (e: unknown) => (e as { code?: string }).code,
  )

async function seedUser(db: DbClient, id: string): Promise<void> {
  await db.insert(users).values({
    id,
    username: id,
    displayName: id,
    role: 'user',
    status: 'active',
    passwordHash: 'x',
    createdAt: 1,
    updatedAt: 1,
  } as never)
}

async function seedAgent(
  db: DbClient,
  id: string,
  name: string,
  owner: string,
  visibility: 'private' | 'public',
): Promise<void> {
  await db.insert(agents).values({
    id,
    name,
    description: '',
    outputs: '[]',
    permission: '{}',
    skills: '[]',
    dependsOn: '[]',
    mcp: '[]',
    plugins: '[]',
    frontmatterExtra: '{}',
    bodyMd: 'body',
    ownerUserId: owner,
    visibility,
    aclRevision: 0,
    createdAt: 1,
    updatedAt: 1,
  } as never)
}

/** reader 拥有的工作流，引用了 owner 的 private agent（reader 靠 grant 才看得见）。 */
async function seedGrantedClosure(): Promise<{
  db: DbClient
  appHome: string
  rootId: string
  childId: string
}> {
  const db = createInMemoryDb(MIGRATIONS)
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc271-authz-'))
  await seedUser(db, 'reader')
  await seedUser(db, 'owner')

  const childId = ulid()
  await seedAgent(db, childId, 'private-dep', 'owner', 'private')
  await db.insert(resourceGrants).values({
    resourceType: 'agent',
    resourceId: childId,
    userId: 'reader',
    addedBy: 'owner',
    addedAt: 1,
  } as never)

  const rootId = ulid()
  await db.insert(workflows).values({
    id: rootId,
    name: 'root',
    description: '',
    definition: JSON.stringify({
      $schema_version: 4,
      inputs: [],
      edges: [],
      nodes: [{ id: 'n1', kind: 'agent-single', agentId: childId }],
    }),
    ownerUserId: 'reader',
    visibility: 'private',
    version: 9,
    aclRevision: 0,
    createdAt: 1,
    updatedAt: 1,
  } as never)

  return { db, appHome, rootId, childId }
}

/**
 * 在导出**中途**注入一次写：闭包遍历读过 `agents` 之后、末端复核读它之前。
 *
 * ⚠️ 这个 proxy 是必须的，不能图省事在调用 `exportResourcePackage` **之前**改数据——
 * 那样撞上的是闭包遍历时的第一道可见性门（`walkExportClosure`），末端复核根本没被执行
 * 到，测试会以**假绿**的方式"通过"。第一版就是这么写的，四条里三条都没测到要测的东西。
 *
 * `nth` = **第几次读该表时、在读之前**触发。`agents` 在一次导出里被读两次：闭包遍历
 * 一次、末端复核一次。所以要的是 `nth = 2`——第 1 次（闭包）读到旧值，第 2 次（复核）
 * 读到新值，这才构成「捕获之后、复核之前」的窗口。
 *
 * 传 1 会让**两次都**读到新值：闭包遍历自己就会拒绝，测试仍然变绿，但绿的是第一道门
 * 而不是末端复核。第一版就是这么写的。
 */
function dbWithMidExportWrite(
  db: DbClient,
  table: unknown,
  nth: number,
  mutate: () => void,
): DbClient {
  let reads = 0
  return new Proxy(db as object, {
    get(target, property, receiver) {
      const original = Reflect.get(target, property, receiver)
      if (property !== 'select' || typeof original !== 'function') {
        return typeof original === 'function' ? original.bind(target) : original
      }
      return (...args: unknown[]) => {
        const builder = original.apply(target, args)
        return new Proxy(builder as object, {
          get(queryTarget, queryProperty, queryReceiver) {
            const queryMethod = Reflect.get(queryTarget, queryProperty, queryReceiver)
            if (queryProperty !== 'from' || typeof queryMethod !== 'function') {
              return typeof queryMethod === 'function' ? queryMethod.bind(queryTarget) : queryMethod
            }
            return (t: unknown) => {
              if (t === table) {
                reads += 1
                if (reads === nth) mutate()
              }
              return queryMethod.call(queryTarget, t)
            }
          },
        })
      }
    },
  }) as unknown as DbClient
}

describe('AC-7 · 授权复核：闭包成员在导出中途失去可见性 ⇒ 拒绝', () => {
  test('基线：grant 在，导出成功且包含该依赖', async () => {
    const { db, appHome, rootId } = await seedGrantedClosure()
    try {
      const pkg = await exportResourcePackage(
        db,
        actorOf('reader'),
        { type: 'workflow', id: rootId },
        { appHome },
      )
      const names = (pkg.manifest.resources as Array<{ name: string }>).map((r) => r.name).sort()
      expect(names).toEqual(['private-dep', 'root'])
    } finally {
      removeTempDirSync(appHome)
    }
  })

  test('**撤权后**导出必须拒绝 —— 而不是带走一个已经不可见的资源', async () => {
    const { db, appHome, rootId, childId } = await seedGrantedClosure()
    try {
      // 闭包已捕获（第 1 次读 agents）之后撤销 grant：删 grant + 推 aclRevision，
      // **version 不动**（ACL 写路径就是这样：只推 aclRevision / updatedAt）。
      // 旧实现在这里完全无感——它比的是 `expectTokenOf`，workflow 只看 version。
      const raced = dbWithMidExportWrite(db, agents, 2, () => {
        db.delete(resourceGrants).where(eq(resourceGrants.resourceId, childId)).run()
        db.update(agents).set({ aclRevision: 1, updatedAt: 2 }).where(eq(agents.id, childId)).run()
      })

      expect(
        await codeOf(
          exportResourcePackage(
            raced,
            actorOf('reader'),
            { type: 'workflow', id: rootId },
            { appHome },
          ),
        ),
      ).toBe('package-export-ref-unavailable')
    } finally {
      removeTempDirSync(appHome)
    }
  })

  test('依赖被改成 private 且无 grant ⇒ 同样拒绝（不只 grant 一条路径）', async () => {
    const { db, appHome, rootId, childId } = await seedGrantedClosure()
    try {
      const raced = dbWithMidExportWrite(db, agents, 2, () => {
        db.delete(resourceGrants).where(eq(resourceGrants.resourceId, childId)).run()
        db.update(agents)
          .set({ visibility: 'private', ownerUserId: 'owner', aclRevision: 2 })
          .where(eq(agents.id, childId))
          .run()
      })

      expect(
        await codeOf(
          exportResourcePackage(
            raced,
            actorOf('reader'),
            { type: 'workflow', id: rootId },
            { appHome },
          ),
        ),
      ).toBe('package-export-ref-unavailable')
    } finally {
      removeTempDirSync(appHome)
    }
  })
})

describe('AC-7 · 产物复核：**不改变字节**的 ACL 漂移不得误拒', () => {
  test('依赖 private → public（reader 仍可见）⇒ 导出照常成功', async () => {
    // 这是上一组的必要配平。合并成一次 `expectTokenOf` 比较时，agent 的 token 含
    // `aclRevision`，于是这次「把依赖公开」——一次**扩大**可见性、且包字节一个都不变的
    // 改动——会让在途导出报 `package-closure-changed`。用户看到的是「资源被改了，重试」，
    // 而实际什么产物变化都没有。
    const { db, appHome, rootId, childId } = await seedGrantedClosure()
    try {
      const raced = dbWithMidExportWrite(db, agents, 2, () => {
        db.update(agents)
          .set({ visibility: 'public', aclRevision: 3, updatedAt: 5 })
          .where(eq(agents.id, childId))
          .run()
      })

      const pkg = await exportResourcePackage(
        raced,
        actorOf('reader'),
        { type: 'workflow', id: rootId },
        { appHome },
      )
      const names = (pkg.manifest.resources as Array<{ name: string }>).map((r) => r.name).sort()
      expect(names).toEqual(['private-dep', 'root'])
    } finally {
      removeTempDirSync(appHome)
    }
  })

  test('真实内容变更仍然拒绝（产物复核没有被放宽掉）', async () => {
    const { db, appHome, rootId, childId } = await seedGrantedClosure()
    try {
      const raced = dbWithMidExportWrite(db, agents, 2, () => {
        db.update(agents)
          .set({ bodyMd: 'CHANGED', updatedAt: 7 })
          .where(eq(agents.id, childId))
          .run()
      })

      expect(
        await codeOf(
          exportResourcePackage(
            raced,
            actorOf('reader'),
            { type: 'workflow', id: rootId },
            { appHome },
          ),
        ),
      ).toBe('package-closure-changed')
    } finally {
      removeTempDirSync(appHome)
    }
  })
})

describe('AC-7 · 产物复核拿**序列化器的产出**比，不是拿「行」近似「包」', () => {
  // 第五轮 P2-2。判据一路退化的轨迹值得留着：
  //   · v1 用引擎 CAS token ⇒ workflow/workgroup 漏检 ACL、另四类误拒 ACL 漂移；
  //   · v2 改「整行减 ACL 四列」⇒ 插件的 `cachedPath` / `resolvedVersion` / `installedAt`
  //     是**本机安装态**、序列化器根本不输出，而一次正常 `reinstallPlugin` 恰好只动这
  //     三列 ⇒ 两次导出**逐字节相同**却报 `package-closure-changed`。
  //
  // 排除清单在累积例外，说明轴选错了。v3 拿同一个 `serializeClosure` 跑一遍新行、逐 slug
  // 比它产出的 op——「什么进包」的唯一事实源，对将来新增的列自动免疫。
  test('闭包里的插件在导出中途被重装（只动本机安装态）⇒ 不得误拒', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc271-plugin-'))
    try {
      await seedUser(db, 'u1')
      const pluginId = ulid()
      await db.insert(plugins).values({
        id: pluginId,
        name: 'fmt',
        description: '',
        spec: 'npm:p@1.0.0',
        sourceKind: 'npm',
        enabled: true,
        cachedPath: '/cache/a',
        resolvedVersion: '1.0.0',
        installedAt: 1,
        ownerUserId: 'u1',
        visibility: 'private',
        aclRevision: 0,
        createdAt: 1,
        updatedAt: 1,
      } as never)
      const agentId = ulid()
      await seedAgent(db, agentId, 'uses-plugin', 'u1', 'private')
      await db
        .update(agents)
        .set({ plugins: JSON.stringify([pluginId]) } as never)
        .where(eq(agents.id, agentId))

      // 闭包捕获插件行之后、末端复核读它之前，模拟一次正常重装：**只**换安装态三列，
      // `spec` / `enabled` / `description` 一个字都不动。
      const raced = dbWithMidExportWrite(db, plugins, 2, () => {
        db.update(plugins)
          .set({ cachedPath: '/cache/b', resolvedVersion: '1.0.1', installedAt: 2 })
          .where(eq(plugins.id, pluginId))
          .run()
      })

      const pkg = await exportResourcePackage(
        raced,
        actorOf('u1'),
        { type: 'agent', id: agentId },
        { appHome, exportedAt: 0 },
      )
      expect(pkg.zip.byteLength).toBeGreaterThan(0)
    } finally {
      removeTempDirSync(appHome)
    }
  })
})

describe('AC-7 · 授权复核排在 root fence 之前（不做状态 oracle）', () => {
  // 第五轮 P2-1。之前 `assertRootStillCurrent`（客户端 fence）跑在闭包复核之前，于是
  // root 的授权被绕到了 fence 之后：撤权之后再导出、若 root 同时被推到 v2，返回的是
  // `package-root-changed ... now 2` —— 一个此刻**已经对你不可见**的资源，却把它的精确
  // revision 报了出来。不泄露 ZIP，但在竞态窗口里是个状态 oracle。
  test('root 失去可见性且同时被改 ⇒ 报「不可用」，不得报出 now <version>', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc271-oracle-'))
    try {
      await seedUser(db, 'reader')
      await seedUser(db, 'owner')
      const rootId = ulid()
      await db.insert(workflows).values({
        id: rootId,
        name: 'shared',
        description: '',
        definition: JSON.stringify({ $schema_version: 4, inputs: [], edges: [], nodes: [] }),
        ownerUserId: 'owner',
        visibility: 'private',
        version: 1,
        aclRevision: 0,
        createdAt: 1,
        updatedAt: 1,
      } as never)
      await db.insert(resourceGrants).values({
        resourceType: 'workflow',
        resourceId: rootId,
        userId: 'reader',
        addedBy: 'owner',
        addedAt: 1,
      } as never)

      const raced = dbWithMidExportWrite(db, workflows, 2, () => {
        db.delete(resourceGrants).where(eq(resourceGrants.resourceId, rootId)).run()
        db.update(workflows).set({ version: 2, updatedAt: 2 }).where(eq(workflows.id, rootId)).run()
      })

      const err = await exportResourcePackage(
        raced,
        actorOf('reader'),
        { type: 'workflow', id: rootId },
        { appHome, expect: { expectedVersion: 1 } },
      ).then(
        () => null,
        (e: unknown) => e as { code?: string; message?: string },
      )
      expect(err?.code).toBe('package-export-ref-unavailable')
      // 关键：**不能**把当前 revision 报出来。
      expect(err?.message ?? '').not.toContain('now 2')
    } finally {
      removeTempDirSync(appHome)
    }
  })
})
