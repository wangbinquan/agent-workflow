// RFC-359 —— `platform/persistence/ResourcePackageApplyEngine` 的**双引擎对拍**。
//
// # 这一对是怎么被找到的
//
// 它不在 `rfc359-w5-provider-pair-conformance` 的十条机械检出里：那条判据是「同目录 + 去掉引擎
// 前缀后同名」，而这一对是**跨目录 + 改了名**——
//
//   SQLite 侧  `platform/persistence/sqlite/legacyResourcePackageCommit.ts`（约 796 行）
//              `platform/persistence/sqlite/legacyResourcePackageBundleApply.ts`（约 652 行）
//   PG   侧    `platform/persistence/postgresqlResourcePackageAtomicApply.ts`（约 976 行）
//
// 同一件事——「把一个资源包的决策落成库里的行 + 盘上的工件，失败要补偿」——两台机器。
// 它是顺着「AC-6 的账本压不动了，剩下的都卡在哪」摸出来的（plan §5do），现在登记在那条守卫的
// `DECLARED_CROSS_DIRECTORY_PAIRS` 里。
//
// # 这份对拍补的是什么
//
// 资源包应用的全部行为判据——`rfc271-import-commit`（25 个调用点）/
// `rfc271-resource-package-hardening`（7）/ `rfc271-import-http` / `rfc271-export-closure-authz`
// ——**只跑 SQLite 那台机器**。PG 那台上，工作组这条路径今天一条断言都没有。
// 这正是本 RFC 反复照出的形状：PG 那份长期零行为覆盖，于是悄悄比 SQLite 弱，直到合一那一刻
// 才第一次被看见（技能目录三对的 52:6 倒挂、`rfc328-durable-ownership` 的 1495 行只跑 SQLite）。
//
// 所以这里按 RFC 自己验证过的办法来：**合一之前先补对拍，用实测差异代替纸面对账**。
// 同一批判据在 SQLite 内存库与真 PostgreSQL 上各跑一遍，问的都是用户可见的结果：
//
//   ① **新建**：归导入者 + `private` + 零 grants（AC-21），且 journal 落到 committed。
//   ② **重放**：同一个 preview token 再提交一次 —— 回执逐字相同，**不产生第二行**
//      （「commit 成功但响应丢失、用户重试」这条路径两个引擎必须同解）。
//   ③ **复用**：`action: 'reuse'` 不产 op、不写行；顺带附上的人员映射**不被消费**
//      （reuse 不写 roster，那些行不该触发 duplicate / 无效用户的报错）。

import { afterEach, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { PackageImportReceiptSchema, PackagePreviewSchema } from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import type { DbClient } from '@/db/client'
import { resourceBundleApplies, resourceGrants, users, workgroups } from '@/db/schema'
import { createPostgresqlCapabilityTemplatePackageMutationOwner } from '@/modules/code-capability/composition/capabilityTemplateOperations'
import { AuthorityClaimRegistry } from '@/modules/identity-access/application/operationContext'
import type { ResourcePackageImportDecision } from '@/modules/resource-catalog/application/package/ports'
import { createMcpTransactionLifecycle } from '@/modules/resource-catalog/composition/mcpRuntimeTestPersistence'
import {
  composePostgresqlResourcePackageCatalog,
  composePostgresqlResourcePackageProvider,
} from '@/modules/resource-catalog/composition/postgresqlResourcePackageCatalog'
import type { ComposedResourcePackageCatalog } from '@/modules/resource-catalog/composition/resourcePackageOperations'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createPostgresqlResourcePackageAtomicApplyOperations } from '@/platform/persistence/postgresqlResourcePackageAtomicApply'
import { createPostgresqlResourcePackageExecutionAdapter } from '@/services/resourcePackage/executionAdapter'
import { buildWorkgroupPackageZip } from './fixtures/rfc271Package'
import { removeTempDirSync } from './fixtures/tempDir'
import { describeEachProvider } from './helpers/eachProvider'
import { composeSqliteResourcePackageCatalogForTest } from './helpers/resourcePackageProvider'

const OWNER = 'package-apply-owner'
const T0 = 1_700_000_000_000
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) removeTempDirSync(root)
})

describeEachProvider('RFC-359 —— 资源包 apply 引擎双引擎对拍（工作组）', (harness) => {
  async function fixture() {
    const db = harness.db
    await db.insert(users).values({
      id: OWNER,
      username: OWNER,
      displayName: 'Package Owner',
      role: 'user',
      status: 'active',
      createdAt: T0,
      updatedAt: T0,
    })
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc359-package-apply-'))
    roots.push(appHome)
    const actor = buildActor({
      user: {
        id: OWNER,
        username: OWNER,
        displayName: 'Package Owner',
        role: 'user',
        status: 'active',
      },
      source: 'daemon',
    })
    const context = {
      authority: new AuthorityClaimRegistry().mintLocalAuthority({
        userId: OWNER,
        source: 'system' as const,
      }),
      operationId: 'package-apply',
      correlationId: 'package-apply',
      now: T0,
    }
    const box = createSecretBoxFromKey(randomBytes(32))
    const catalog: ComposedResourcePackageCatalog = (() => {
      if (harness.capabilities.isolation === 'exclusive') {
        return composeSqliteResourcePackageCatalogForTest({
          db: harness.db as DbClient,
          appHome,
          box,
        })
      }
      const client = harness.db as PostgresqlDatabaseClient
      const provider = composePostgresqlResourcePackageProvider({
        db: client,
        appHome,
        authorityResolver: { resolve: () => actor },
        mcpLifecycle: createMcpTransactionLifecycle(),
        capabilityTemplates: createPostgresqlCapabilityTemplatePackageMutationOwner({
          db: client,
        }),
        pluginInstaller: {
          plannedGenerationDirectory() {
            throw new Error('workgroup apply must not install plugins')
          },
          async install() {
            throw new Error('workgroup apply must not install plugins')
          },
        },
      })
      return composePostgresqlResourcePackageCatalog({
        provider,
        execution: createPostgresqlResourcePackageExecutionAdapter({
          box,
          provider,
          atomicApply: createPostgresqlResourcePackageAtomicApplyOperations({ db: client, box }),
        }),
      })
    })()

    const preview = async (bytes: Uint8Array) => {
      const staged = await catalog.operations.inspect.invoke(
        context,
        catalog.transport.stageInspect(actor, bytes),
      )
      return PackagePreviewSchema.parse(
        JSON.parse((await catalog.operations.getPreview.invoke(context, staged)).document),
      )
    }
    const apply = async (
      bytes: Uint8Array,
      previewToken: string,
      decision: ResourcePackageImportDecision,
      humanMemberMappings: readonly {
        workgroupSlug: string
        username: string
        userId: string
      }[] = [],
    ) => {
      const staged = await catalog.operations.apply.invoke(
        context,
        catalog.transport.stageApply(actor, {
          bytes,
          previewToken,
          decisions: [decision],
          humanMemberMappings: [...humanMemberMappings],
          secretInputs: [],
        }),
      )
      return PackageImportReceiptSchema.parse(
        JSON.parse((await catalog.operations.getReceipt.invoke(context, staged)).document),
      )
    }
    return { db, apply, preview }
  }

  test('① 新建：归导入者 + private + 零 grants，journal 落 committed', async () => {
    const f = await fixture()
    const bytes = buildWorkgroupPackageZip()
    const previewResult = await f.preview(bytes)
    const receipt = await f.apply(
      bytes,
      previewResult.previewToken,
      { localSlug: 'workgroup-squad', action: 'new' },
      // 新建会写 roster，所以包里那个 human 成员必须被映射到一个真实用户——两个引擎同解，
      // 缺映射都抛 `package-human-mapping-missing`。
      [{ workgroupSlug: 'workgroup-squad', username: 'alice', userId: OWNER }],
    )

    expect(receipt.applied).toHaveLength(1)
    expect(receipt.root).toBeDefined()
    const rootId = receipt.root?.resourceId
    if (rootId === undefined) throw new Error('workgroup receipt root missing')

    const rows = await f.db.select().from(workgroups).where(eq(workgroups.id, rootId))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      name: 'squad',
      ownerUserId: OWNER,
      visibility: 'private',
    })
    expect(
      await f.db.select().from(resourceGrants).where(eq(resourceGrants.resourceId, rootId)),
    ).toEqual([])

    const journal = await f.db.select().from(resourceBundleApplies)
    expect(journal).toHaveLength(1)
    expect(journal[0]?.state).toBe('committed')
  })

  test('② 重放：同一个 preview token 再提交，回执逐字相同且不产生第二行', async () => {
    const f = await fixture()
    const bytes = buildWorkgroupPackageZip()
    const previewResult = await f.preview(bytes)
    const decision = { localSlug: 'workgroup-squad', action: 'new' as const }
    const mappings = [{ workgroupSlug: 'workgroup-squad', username: 'alice', userId: OWNER }]
    const first = await f.apply(bytes, previewResult.previewToken, decision, mappings)
    const replay = await f.apply(bytes, previewResult.previewToken, decision, mappings)

    expect(replay).toEqual(first)
    expect(await f.db.select().from(workgroups)).toHaveLength(1)
    expect(await f.db.select().from(resourceBundleApplies)).toHaveLength(1)
  })

  test('③ 缺人员映射：两个引擎都以 `package-human-mapping-missing` 拒收，且什么都没写', async () => {
    const f = await fixture()
    const bytes = buildWorkgroupPackageZip()
    const previewResult = await f.preview(bytes)
    // 包里那个 human 成员没有映射到任何真实用户。两个引擎必须给同一个拒绝码——
    // 一个拒收、另一个建出半张 roster，正是本 RFC 要消灭的「一个好一个不好」。
    await expect(
      f.apply(bytes, previewResult.previewToken, {
        localSlug: 'workgroup-squad',
        action: 'new',
      }),
    ).rejects.toMatchObject({ code: 'package-human-mapping-missing' })
    expect(await f.db.select().from(workgroups)).toEqual([])
  })

  test('④ 映射指向不存在的用户：同样拒收，且什么都没写', async () => {
    const f = await fixture()
    const bytes = buildWorkgroupPackageZip()
    const previewResult = await f.preview(bytes)
    await expect(
      f.apply(bytes, previewResult.previewToken, { localSlug: 'workgroup-squad', action: 'new' }, [
        { workgroupSlug: 'workgroup-squad', username: 'alice', userId: 'no-such-user' },
      ]),
    ).rejects.toMatchObject({ status: 422 })
    expect(await f.db.select().from(workgroups)).toEqual([])
  })
})
