// RFC-359 —— 统一 apply 引擎的 **journal 三态重放 / 失败终态**双引擎对拍。
//
// # 这份文件为什么存在（它是一次退役的前置条件）
//
// 这些判据此前只锁在**通用 bundle 引擎**（`services/bundle/apply.ts` 的 `applyResourceBundle`）
// 上，由 `rfc271-bundle-engine.test.ts` 的「I2/I3 · claim 与三态重放」一组守着，而那台引擎
// 只有 SQLite 走过。资源包 apply 两台引擎合一（plan §5dv）之后生产侧只剩统一那一台，
// 那组判据锁的是**不再运行的代码**——删它之前，同一批问题必须先在统一引擎上、且在
// **两个 provider** 上各问一遍。这就是那一遍。
//
// # 问的是什么
//
// 「commit 成功但响应丢了、用户重试」这条路径上，journal 的三种状态各有一个**用户可见**的答案：
//
//   ① `committed` ⇒ 原样回放上次那份回执，**不产生第二份资源**；
//   ② `failed`    ⇒ 409 明说上次失败，**绝不**因为这次载荷是好的就静默重跑；
//   ③ 未结（`prepared` / `applying`）⇒ 409 未结，拒绝而不是猜。
//
// 外加失败侧的两条：pre-commit 抛错 ⇒ **零资源可见** 且 journal 终态化为 `failed` 并带原因。
//
// 覆盖验收条款：AC-24f / AC-20 / AC-20b / AC-B4（引擎承重不变量 I2 / I3 / I7 / I8 / I13）
//   （编号锚点由 rfc271-ac-coverage.test.ts 机械核查，别删）
//
// # 覆盖的验收条款 / 不变量
//
// 这些编号原本锚在 `rfc271-bundle-engine.test.ts` 上；那份随被测的通用 bundle 引擎退役
// （plan §5dy），判据搬到这里，锚点跟着搬——锚在真的测了那件事的文件上。
//
//   · **AC-24f** 重复提交按**三态**处理（`committed` → 原 receipt；`failed` → 409；未结 → 409）；
//   · **AC-20** 导入可收敛：任一步失败或 SIGKILL 后，启动收敛能**证明**该前滚还是回滚
//     （这里锁失败侧的终态化，收敛本身在 `rfc349-resource-package-maintenance`）；
//   · **AC-20b** 正式资源行在 journal 到达 `committed` 前对读路径不可见（⑤：提交事务中途失败 ⇒ 零资源）；
//   · **I2**（claim 同生共死）/ **I3**（三态重放）/ **I8**（post-commit 绝不补偿）；
//   · **I13** 的一半（commit 内核 / receipt / journal 同一笔大事务）——完整那条在
//     `rfc359-w11-atomic-apply-neutral-transaction-conformance`；
//   · **I7** 的后继形态：统一引擎没有 `finalizeInTx` 这个钩子，回执与资源写、journal committed
//     落在同一笔事务里（⑤ 与 w11 一起钉）。
//
// # 怎么在两个引擎上都造出「提交事务中途失败」
//
// 用 `helpers/faultTrigger` 在 `agents` 上挂一条 BEFORE INSERT 的 ABORT 触发器：两个引擎
// 同一份文案、同一条判据。它落在 journal **认领之后**、提交事务之内，正是要测的那一段。
// PostgreSQL 那台的库是整份测试共用的，所以每处都 try/finally 卸掉。

import { afterEach, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { buildActor } from '@/auth/actor'
import { AuthorityClaimRegistry } from '@/modules/identity-access/application/operationContext'
import { createPostgresqlCapabilityTemplatePackageMutationOwner } from '@/modules/code-capability/composition/capabilityTemplateOperations'
import { createMcpTransactionLifecycle } from '@/modules/resource-catalog/composition/mcpRuntimeTestPersistence'
import { composePostgresqlResourcePackageProvider } from '@/modules/resource-catalog/composition/postgresqlResourcePackageCatalog'
import { createPostgresqlResourcePackageAtomicApplyOperations } from '@/platform/persistence/postgresqlResourcePackageAtomicApply'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { agents, resourceBundleApplies, users } from '@/db/schema'
import { parseResourcePackage } from '@/services/resourcePackage/parse'
import { encodeZip } from '@/util/zip'
import { describeEachProvider } from './helpers/eachProvider'
import { dropAbortTrigger, installAbortTrigger } from './helpers/faultTrigger'
import { commitResourcePackageForTest } from './helpers/resourcePackageApply'
import { buildPackagePreview } from './helpers/resourcePackageProvider'
import { removeTempDirSync } from './fixtures/tempDir'

const OWNER = 'w14-journal-owner'
const T0 = 1_700_000_000_000
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value)
const roots: string[] = []

type PackageMutationSession = ReturnType<
  ReturnType<typeof composePostgresqlResourcePackageProvider>['mutationSessionFactory']['create']
>

const agentPackageZip = (name: string): Uint8Array =>
  encodeZip([
    {
      path: 'manifest.yaml',
      bytes: utf8(`formatVersion: 1
exportedAt: 0
root:
  slug: agent-${name}
  type: agent
  name: ${name}
resources:
  - slug: agent-${name}
    type: agent
    name: ${name}
requirements: {}
secrets: []
danglingCallRefs: []
`),
    },
    {
      path: 'bundle.json',
      bytes: utf8(
        JSON.stringify({
          bundleVersion: 1,
          ops: [
            {
              opId: 'op-1',
              kind: 'agent-create',
              slug: `agent-${name}`,
              payload: {
                name,
                description: 'from package',
                outputs: [],
                syncOutputsOnIterate: true,
                permission: {},
                skills: [],
                dependsOn: [],
                mcp: [],
                plugins: [],
                frontmatterExtra: {},
                bodyMd: '',
              },
            },
          ],
          rootRef: `local:agent-${name}`,
        }),
      ),
    },
  ])

/**
 * 同一个包里 A 依赖 B，两条都选 `new`。B 在库里还不存在，所以 A 的引用只能靠**预铸 id**
 * 解析——引擎在 prepare 之前就给每个 create op 铸好了 id（`session.request.ids.mintCreate`）。
 */
const dependentAgentsPackageZip = (): Uint8Array => {
  const agentPayload = (name: string, dependsOn: readonly string[]) => ({
    name,
    description: 'from package',
    outputs: [],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [...dependsOn],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
  })
  return encodeZip([
    {
      path: 'manifest.yaml',
      bytes: utf8(`formatVersion: 1
exportedAt: 0
root:
  slug: agent-lead
  type: agent
  name: lead
resources:
  - slug: agent-lead
    type: agent
    name: lead
  - slug: agent-helper
    type: agent
    name: helper
requirements: {}
secrets: []
danglingCallRefs: []
`),
    },
    {
      path: 'bundle.json',
      bytes: utf8(
        JSON.stringify({
          bundleVersion: 1,
          ops: [
            {
              opId: 'op-1',
              kind: 'agent-create',
              slug: 'agent-lead',
              payload: agentPayload('lead', ['local:agent-helper']),
            },
            {
              opId: 'op-2',
              kind: 'agent-create',
              slug: 'agent-helper',
              payload: agentPayload('helper', []),
            },
          ],
          rootRef: 'local:agent-lead',
        }),
      ),
    },
  ])
}

afterEach(() => {
  while (roots.length > 0) removeTempDirSync(roots.pop()!)
})

describeEachProvider('RFC-359 —— 统一 apply 引擎的 journal 三态重放', (harness) => {
  const ABORT = {
    name: 'w14_agents_abort',
    table: 'agents',
    error: 'forced agent insert failure',
  } as const

  async function fixture() {
    const db = harness.db
    await db.insert(users).values({
      id: OWNER,
      username: OWNER,
      displayName: 'Journal Owner',
      role: 'user',
      status: 'active',
      createdAt: T0,
      updatedAt: T0,
    })
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc359-w14-journal-'))
    roots.push(appHome)
    const actor = buildActor({
      user: {
        id: OWNER,
        username: OWNER,
        displayName: 'Journal Owner',
        role: 'user',
        status: 'active',
      },
      source: 'daemon',
    })
    const deps = { db, appHome, box: createSecretBoxFromKey(randomBytes(32)) }
    return {
      db,
      actor,
      deps,
      async commit(bytes: Uint8Array, importId: string) {
        const pkg = await parseResourcePackage(bytes)
        const preview = await buildPackagePreview(db, actor, pkg, { box: deps.box, importId })
        return commitResourcePackageForTest(deps, actor, {
          pkg,
          previewToken: preview.previewToken,
          decisions: [{ localSlug: pkg.manifest.root.slug, action: 'new' }],
        })
      },
      /** 包里每一条都选 `new`（多资源包用）。 */
      async commitAll(bytes: Uint8Array, importId: string) {
        const pkg = await parseResourcePackage(bytes)
        const preview = await buildPackagePreview(db, actor, pkg, { box: deps.box, importId })
        return commitResourcePackageForTest(deps, actor, {
          pkg,
          previewToken: preview.previewToken,
          decisions: preview.entries.map((entry) => ({
            localSlug: entry.localSlug,
            action: 'new' as const,
          })),
        })
      },
      /**
       * 同一条提交，但把写会话包一层——用来在**数据库事务已经提交之后**的那一段注入故障。
       * 这里必须自己装引擎（不走 `commitResourcePackageForTest`），因为要拿到
       * `mutationSessionFactory` 才包得住会话。
       */
      async commitWith(
        pkg: Awaited<ReturnType<typeof parseResourcePackage>>,
        previewToken: string,
        wrap: (session: PackageMutationSession) => PackageMutationSession,
      ) {
        const provider = composePostgresqlResourcePackageProvider({
          db,
          appHome,
          authorityResolver: { resolve: () => actor },
          mcpLifecycle: createMcpTransactionLifecycle(),
          capabilityTemplates: createPostgresqlCapabilityTemplatePackageMutationOwner({ db }),
          pluginInstaller: {
            plannedGenerationDirectory() {
              throw new Error('journal fixture must not install plugins')
            },
            async install() {
              throw new Error('journal fixture must not install plugins')
            },
          },
        })
        const atomicApply = createPostgresqlResourcePackageAtomicApplyOperations({
          db,
          box: deps.box,
        })
        return atomicApply.apply({
          authority: new AuthorityClaimRegistry().mintLocalAuthority({
            userId: OWNER,
            source: 'system' as const,
          }),
          actor,
          package: pkg,
          previewToken,
          decisions: [{ localSlug: pkg.manifest.root.slug, action: 'new' }],
          humanMemberMappings: [],
          secretInputs: [],
          mutationSessionFactory: Object.freeze({
            create: (request: Parameters<typeof provider.mutationSessionFactory.create>[0]) =>
              wrap(provider.mutationSessionFactory.create(request)),
          }),
        })
      },
    }
  }

  test('① 首次 apply ⇒ journal 落 committed，资源真的落库', async () => {
    const f = await fixture()
    const receipt = (await f.commit(agentPackageZip('worker'), ulid())) as {
      journalId: string
      applied: readonly { resourceType: string }[]
    }

    expect(receipt.applied).toHaveLength(1)
    expect(receipt.applied[0]?.resourceType).toBe('agent')
    const journal = await f.db
      .select()
      .from(resourceBundleApplies)
      .where(eq(resourceBundleApplies.id, receipt.journalId))
    expect(journal[0]?.state).toBe('committed')
    expect(await f.db.select().from(agents)).toHaveLength(1)
  })

  test('② committed 重放 ⇒ 原回执逐字相同，且不产生第二份资源', async () => {
    const f = await fixture()
    const bytes = agentPackageZip('worker')
    const importId = ulid()
    const first = await f.commit(bytes, importId)
    const second = await f.commit(bytes, importId)

    expect(second).toEqual(first)
    expect(await f.db.select().from(agents)).toHaveLength(1)
    expect(await f.db.select().from(resourceBundleApplies)).toHaveLength(1)
  })

  test('③ failed 重放 ⇒ 409 明说上次失败，绝不因为这次载荷是好的就静默重跑', async () => {
    const f = await fixture()
    const bytes = agentPackageZip('worker')
    const importId = ulid()

    await installAbortTrigger(harness, ABORT)
    try {
      await expect(f.commit(bytes, importId)).rejects.toBeDefined()
    } finally {
      await dropAbortTrigger(harness, ABORT)
    }

    // 触发器已经卸掉——这一次的载荷完全健康。引擎仍然必须拒绝。
    const error = await f.commit(bytes, importId).then(
      () => null,
      (e: unknown) => e as { code?: string },
    )
    expect(error?.code).toBe('bundle-apply-failed-replay')
    expect(await f.db.select().from(agents)).toHaveLength(0)
  })

  test('④ 未结（prepared）重放 ⇒ 409 未结：拒绝，而不是猜', async () => {
    const f = await fixture()
    const importId = ulid()
    await f.db.insert(resourceBundleApplies).values({
      id: ulid(),
      scope: 'package',
      key: importId,
      actorUserId: OWNER,
      state: 'prepared',
      preparedArtifactsJson: '[]',
      createdAt: T0,
      updatedAt: T0,
    })

    const error = await f.commit(agentPackageZip('worker'), importId).then(
      () => null,
      (e: unknown) => e as { code?: string },
    )
    expect(error?.code).toBe('bundle-apply-unsettled')
    expect(await f.db.select().from(agents)).toHaveLength(0)
  })

  test('⑤ 提交事务中途失败 ⇒ 零资源可见，且 journal 终态化为 failed 并带原因', async () => {
    const f = await fixture()
    const importId = ulid()

    await installAbortTrigger(harness, ABORT)
    try {
      await expect(f.commit(agentPackageZip('worker'), importId)).rejects.toBeDefined()
    } finally {
      await dropAbortTrigger(harness, ABORT)
    }

    expect(await f.db.select().from(agents)).toHaveLength(0)
    const journal = await f.db
      .select()
      .from(resourceBundleApplies)
      .where(eq(resourceBundleApplies.key, importId))
    expect(journal).toHaveLength(1)
    expect(journal[0]?.state).toBe('failed')
    // 「带原因」两个引擎都成立，但**原因的文案由驱动决定**：bun:sqlite 把 `RAISE(ABORT, …)`
    // 的文案原样抛出来，PostgreSQL 的 remote 驱动把它包进一段 `Failed query: insert into …
    // "agents" …` 里。判据因此锁「非空，且指得出是哪张表出的事」，不锁逐字文案——
    // 逐字锁会把一个驱动实现细节变成引擎分叉。
    expect(journal[0]?.error ?? '').not.toBe('')
    expect(journal[0]?.error ?? '').toMatch(/agent/i)
  })

  test('⑥ 预铸 id 早于落库：同包内 A 依赖 B，A 指向的是**这次建出来的** B', async () => {
    const f = await fixture()
    await f.commitAll(dependentAgentsPackageZip(), ulid())

    const rows = await f.db.select().from(agents)
    const lead = rows.find((row) => row.name === 'lead')
    const helper = rows.find((row) => row.name === 'helper')
    expect(lead).toBeDefined()
    expect(helper).toBeDefined()
    // 指向的必须是这次新建的那一行——不是包内 slug、也不是别的同名行。
    expect(JSON.parse(lead?.dependsOn ?? '[]')).toEqual([helper?.id])
  })

  test('⑦ 提交之后再抛错**绝不补偿**：journal 仍是 committed，资源仍然可见', async () => {
    const f = await fixture()
    const bytes = agentPackageZip('worker')
    const importId = ulid()
    const pkg = await parseResourcePackage(bytes)
    const preview = await buildPackagePreview(f.db, f.actor, pkg, {
      box: f.deps.box,
      importId,
    })

    // 数据库事务已经提交之后才抛的那一段（`afterCommitted`）：此时回滚是**错的**——
    // 资源已经对用户可见、journal 也已经是 committed，补偿会把用户看得见的东西删掉。
    // 引擎的处置是「补偿走 databaseCommitted: true 那一支（只做前滚收尾）+ 原样抛出」。
    const error = await f
      .commitWith(pkg, preview.previewToken, (session) => ({
        ...session,
        afterCommitted: () => Promise.reject(new Error('post-commit boom')),
      }))
      .then(
        () => null,
        (e: unknown) => e as Error,
      )
    expect(error?.message).toContain('post-commit boom')

    const journal = await f.db
      .select()
      .from(resourceBundleApplies)
      .where(eq(resourceBundleApplies.key, importId))
    expect(journal[0]?.state).toBe('committed')
    expect(journal[0]?.receiptJson ?? '').not.toBe('')
    expect((await f.db.select().from(agents)).map((row) => row.name)).toEqual(['worker'])
  })
})
