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
import { readFileSync } from 'node:fs'
import { agents, plugins, resourceGrants, users, workflows } from '../src/db/schema'
import { exportResourcePackage } from './helpers/resourcePackageProvider'
import { removeTempDirSync } from './fixtures/tempDir'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const actorOf = (id: string): Actor =>
  ({
    user: { id, username: id, displayName: id, role: 'user', status: 'active' },
    source: 'daemon',
    permissions: new Set<string>(['resource-acl:private', 'scripts:author']),
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
                // `nth` 为负数表示「从第 |nth| 次起**每次**都触发」——用于无法预知确切
                // 读表次数的场景（技能导出会读 `skills` 六次：闭包 / readSkillTree 内部 /
                // 末端复核 / 复核里的 readSkillTree），写操作必须是幂等的。
                if (nth < 0 ? reads >= -nth : reads === nth) mutate()
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
  test('root fence 的那次查询**自己**带授权判断（源码不变量）', () => {
    // ⚠️ 这条是源码层断言，不是竞态断言，说明理由：
    //
    // 要测的窗口是「闭包复核读过 root 之后、root fence 那次独立查询之前」撤权。我按读表
    // 计数注入（第 2 次、第 3 次）都没能落进那个窗口——撤权总是被更早的闭包复核抓到，
    // 加不加这道授权检查测试都绿。和技能树那条同一个原因：我对这条路径的读表次序建模
    // 不准，而基于计数的注入本身不可靠。
    //
    // 继续拼数字只会得到一条**看起来在测 oracle、实际没测到**的用例。所以这里只钉住
    // 那个真正重要的不变量，并把缺口写在明面上：
    //
    //   **只要某一步还要重新读一次库，它就必须自己带上授权判断**——「在它之前先检查
    //   一次」解决不了问题，第五轮就是这么以为的，第六轮实测 oracle 窗口只是挪后了。
    //
    // 端到端竞态覆盖仍缺，需要能精确注入 DB 时序的 seam。**这是已知缺口，不是已覆盖。**
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'resourcePackage', 'export.ts'),
      'utf8',
    )
    const fenceFn = src.slice(
      src.indexOf('async function assertRootStillCurrent('),
      src.indexOf('async function assertClosureStillCurrent('),
    )
    expect(fenceFn).toContain('reads.listGrantedResourceIds(actor, type)')
    expect(fenceFn).toContain('isVisibleRow(actor, row as never, grants)')
    // 而且授权判断要排在 `assertRootUnchanged` 明文比较**之前**。
    expect(fenceFn.indexOf('isVisibleRow(') < fenceFn.indexOf('assertRootUnchanged(')).toBe(true)
  })
})

describe('AC-7 · 第六轮：产物复核自己不能制造误拒 / 盲区', () => {
  // 三条各锁一个第五轮修复开出的洞。它们的共同教训是：**「拿产出比」这个方向是对的，
  // 但「产出」必须是同一条件下的产出**——顺序、身份字段、外部内容，任何一处不同源，
  // 比较要么恒不等（误拒）、要么恒相等（盲区）。

  test('① 混类型闭包 + 零并发写 ⇒ 必须成功（opId 是按遍历顺序递增的）', async () => {
    // `serializeClosure` 的 opId 是 `op-1` / `op-2` … 按遍历顺序递增，而复核比较的是
    // **整个 op 的 JSON**。第五轮我按类型分组重建 fresh，顺序一变 opId 就全错位 ⇒
    // 一次完全正常的导出确定性报 409。这条用「root workflow 同时含 agent 节点与
    // call 节点」构造出分组会打乱顺序的最小闭包。
    const db = createInMemoryDb(MIGRATIONS)
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc271-order-'))
    try {
      await seedUser(db, 'u1')
      const agentId = ulid()
      await seedAgent(db, agentId, 'worker', 'u1', 'private')
      const childId = ulid()
      await db.insert(workflows).values({
        id: childId,
        name: 'child',
        description: '',
        definition: JSON.stringify({ $schema_version: 4, inputs: [], edges: [], nodes: [] }),
        ownerUserId: 'u1',
        visibility: 'private',
        version: 1,
        createdAt: 1,
        updatedAt: 1,
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
          nodes: [
            { id: 'n1', kind: 'agent-single', agentId },
            { id: 'n2', kind: 'call-workflow', workflowName: 'child', workflowId: childId },
          ],
        }),
        ownerUserId: 'u1',
        visibility: 'private',
        version: 1,
        createdAt: 1,
        updatedAt: 1,
      } as never)

      const pkg = await exportResourcePackage(
        db,
        actorOf('u1'),
        { type: 'workflow', id: rootId },
        { appHome },
      )
      expect(pkg.zip.byteLength).toBeGreaterThan(0)
    } finally {
      removeTempDirSync(appHome)
    }
  })

  test('② 导出中途**改名** ⇒ 必须发现（序列化器读的是顶层 name，不是 row）', async () => {
    // 第五轮的 `{ ...resource, row: current }` 只换了 `row`，而序列化器读 `r.name`。
    // 后果不只是漏检：manifest 会**写旧名字**，产出一个与库不一致的包。
    const { db, appHome, rootId, childId } = await seedGrantedClosure()
    try {
      const raced = dbWithMidExportWrite(db, agents, 2, () => {
        db.update(agents).set({ name: 'renamed' }).where(eq(agents.id, childId)).run()
      })
      // 报的是 `package-root-changed` 而不是 closure：改名会改 slug，root 工作流的
      // `agentRef` wire 随之变化，于是 root 的 op 先不等。这比只发现「成员变了」更强
      // ——它说明**根的产物**确实变了，正是 fence 该拦的东西。
      expect(
        await codeOf(
          exportResourcePackage(
            raced,
            actorOf('reader'),
            { type: 'workflow', id: rootId },
            { appHome },
          ),
        ),
      ).toBe('package-root-changed')
    } finally {
      removeTempDirSync(appHome)
    }
  })

  test('③ 技能文件树：复核必须**重读**并单独比字节（op 里只有 path/ref）', () => {
    // ⚠️ 这条**没有**端到端竞态断言，是有意为之，说明理由：
    //
    // 我试了四种注入点（按 `skills` 读表次数第 2/3 次、以及「第 4/5/6 次起每次」）都没能
    // 让文件写落进「第一次读盘之后、复核读盘之前」那个窗口——探针显示两次读到的都是
    // 同一份字节。一次技能导出实测读 `skills` **六**回，而文件读盘与表读之间没有稳定的
    // 先后关系可供挂钩。继续拼注入点只会得到一条**看起来在测竞态、实际测不到**的用例，
    // 那比没有更糟（前面已经栽过一次：四条授权用例里三条是这么假绿的）。
    //
    // 所以这里只锁两件能确定的事，并把缺口写在明面上：
    //   ① 摘要函数确实对**字节**敏感（不是只比路径）——这是修复的核心判据；
    //   ② 复核路径确实**重读**了树，而不是复用导出早期那一份。
    // 真正的端到端竞态覆盖仍缺，留给能注入 FS 时序的场景（如 `readSkillTree` 加测试
    // seam）——**这是一个已知缺口，不是已覆盖**。
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'resourcePackage', 'export.ts'),
      'utf8',
    )
    // ① 摘要把**字节**算进去（`Buffer.from(f.bytes)`），不是只有 path。
    expect(src).toContain("Buffer.from(f.bytes).toString('base64')")
    // ② 复核里重读了树，且比的是新旧两份。
    expect(src).toContain('freshTrees.set(r.id, await readPackageSkillTree(r.id))')
    expect(src).toContain('skillTreeDigest(skillTrees.get(r.id)) === skillTreeDigest(')
    // ③ 而且序列化用的是**重读的**那份树（否则包里仍是旧内容）。
    expect(src).toContain('serializeClosure({ ...closure, resources: fresh }, freshTrees)')
  })
})
