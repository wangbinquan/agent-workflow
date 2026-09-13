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
//
// 判据不绑在工作组这一种类型上——同一批问题在 **代理** / **MCP（含密文占位符回填）** /
// **工作流** 上各问一遍，才能看出「归属 / 可见性 / 零 grants / 重放」是引擎级不变量、
// 不是某个类型的巧合；工作流那组还顺带把 `finalName` 改名与 `scripts:author` 这条
// **随 payload 动态求值**的写能力判据（RFC-304/309）拉进两台机器一起验。

import { afterEach, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import {
  PACKAGE_SECRET_PLACEHOLDER,
  PackageImportReceiptSchema,
  PackagePreviewSchema,
} from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import {
  agents,
  mcps,
  resourceBundleApplies,
  resourceGrants,
  users,
  workflows,
  workgroups,
} from '@/db/schema'
import { createPostgresqlCapabilityTemplatePackageMutationOwner } from '@/modules/code-capability/composition/capabilityTemplateOperations'
import { AuthorityClaimRegistry } from '@/modules/identity-access/application/operationContext'
import type { ResourcePackageImportDecision } from '@/modules/resource-catalog/application/package/ports'
import { createMcpTransactionLifecycle } from '@/modules/resource-catalog/composition/mcpRuntimeTestPersistence'
import {
  composePostgresqlResourcePackageCatalog,
  composePostgresqlResourcePackageProvider,
} from '@/modules/resource-catalog/composition/postgresqlResourcePackageCatalog'
import type { ComposedResourcePackageCatalog } from '@/modules/resource-catalog/composition/resourcePackageOperations'
import { createPostgresqlResourcePackageAtomicApplyOperations } from '@/platform/persistence/postgresqlResourcePackageAtomicApply'
import { createPostgresqlResourcePackageExecutionAdapter } from '@/services/resourcePackage/executionAdapter'
import { encodeZip } from '@/util/zip'
import { buildWorkgroupPackageZip } from './fixtures/rfc271Package'
import { removeTempDirSync } from './fixtures/tempDir'
import { describeEachProvider } from './helpers/eachProvider'

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value)

/** 一个最小的 agent 包：没有任何外部引用，用来验第二种资源类型走的是同一套归属 / 可见性规则。 */
const agentPackageZip = (): Uint8Array =>
  encodeZip([
    {
      path: 'manifest.yaml',
      bytes: utf8(`formatVersion: 1
exportedAt: 0
root:
  slug: agent-worker
  type: agent
  name: worker
resources:
  - slug: agent-worker
    type: agent
    name: worker
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
              slug: 'agent-worker',
              payload: {
                name: 'worker',
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
          rootRef: 'local:agent-worker',
        }),
      ),
    },
  ])

/** 一个声明了凭据字段的 MCP 包：`config.env.TOKEN` 落在包里的是占位符，真值由 `secretInputs` 给。 */
const secretPackageZip = (): Uint8Array =>
  encodeZip([
    {
      path: 'manifest.yaml',
      bytes: utf8(`formatVersion: 1
exportedAt: 0
root:
  slug: mcp-tools
  type: mcp
  name: tools
resources:
  - slug: mcp-tools
    type: mcp
    name: tools
requirements:
  executables:
    - tool-server
  mcpKinds:
    - local
secrets:
  - resourceType: mcp
    resourceName: tools
    field: config.env.TOKEN
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
              kind: 'mcp-create',
              slug: 'mcp-tools',
              payload: {
                name: 'tools',
                description: 'from package',
                type: 'local',
                config: {
                  command: ['tool-server'],
                  env: { TOKEN: PACKAGE_SECRET_PLACEHOLDER },
                },
                enabled: true,
              },
            },
          ],
          rootRef: 'local:mcp-tools',
        }),
      ),
    },
  ])

/**
 * 一个最小的 workflow 包：第三种资源类型，验归属 / 可见性规则不随类型漂。
 * `script: true` 时节点带 `kind: 'script'`——那是 RFC-304/309 的字段级门（`scripts:author`），
 * 普通 user 拿不到，两台机器都应当在同一处拒绝。
 */
const workflowPackageZip = (options: { readonly script?: boolean } = {}): Uint8Array =>
  encodeZip([
    {
      path: 'manifest.yaml',
      bytes: utf8(`formatVersion: 1
exportedAt: 0
root:
  slug: workflow-deploy
  type: workflow
  name: deploy
resources:
  - slug: workflow-deploy
    type: workflow
    name: deploy
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
              kind: 'workflow-create',
              slug: 'workflow-deploy',
              payload: {
                name: 'deploy',
                description: 'from package',
                definition: {
                  $schema_version: 6,
                  inputs: [],
                  edges: [],
                  nodes: [{ id: 'run', kind: options.script === true ? 'script' : 'input' }],
                },
              },
            },
          ],
          rootRef: 'local:workflow-deploy',
        }),
      ),
    },
  ])

const OWNER = 'package-apply-owner'
const T0 = 1_700_000_000_000
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) removeTempDirSync(root)
})

describeEachProvider(
  'RFC-359 —— 资源包 apply 引擎双引擎对拍（工作组 / 代理 / MCP / 工作流）',
  (harness) => {
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
      const client = harness.db
      const provider = composePostgresqlResourcePackageProvider({
        db: client,
        appHome,
        authorityResolver: { resolve: () => actor },
        mcpLifecycle: createMcpTransactionLifecycle(),
        capabilityTemplates: createPostgresqlCapabilityTemplatePackageMutationOwner({ db: client }),
        pluginInstaller: {
          plannedGenerationDirectory() {
            throw new Error('workgroup apply must not install plugins')
          },
          async install() {
            throw new Error('workgroup apply must not install plugins')
          },
        },
      })
      const catalog: ComposedResourcePackageCatalog = composePostgresqlResourcePackageCatalog({
        provider,
        execution: createPostgresqlResourcePackageExecutionAdapter({
          box,
          provider,
          atomicApply: createPostgresqlResourcePackageAtomicApplyOperations({ db: client, box }),
        }),
      })

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
        secretInputs: readonly {
          resourceType: 'mcp'
          resourceName: string
          field: string
          value: string
        }[] = [],
      ) => {
        const staged = await catalog.operations.apply.invoke(
          context,
          catalog.transport.stageApply(actor, {
            bytes,
            previewToken,
            decisions: [decision],
            humanMemberMappings: [...humanMemberMappings],
            secretInputs: [...secretInputs],
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
        f.apply(
          bytes,
          previewResult.previewToken,
          { localSlug: 'workgroup-squad', action: 'new' },
          [{ workgroupSlug: 'workgroup-squad', username: 'alice', userId: 'no-such-user' }],
        ),
      ).rejects.toMatchObject({ status: 422 })
      expect(await f.db.select().from(workgroups)).toEqual([])
    })

    test('⑤ 第二种资源类型（agent）走同一套归属 / 可见性规则', async () => {
      const f = await fixture()
      const bytes = agentPackageZip()
      const previewResult = await f.preview(bytes)
      const receipt = await f.apply(bytes, previewResult.previewToken, {
        localSlug: 'agent-worker',
        action: 'new',
      })

      const rootId = receipt.root?.resourceId
      if (rootId === undefined) throw new Error('agent receipt root missing')
      const rows = await f.db.select().from(agents).where(eq(agents.id, rootId))
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        name: 'worker',
        description: 'from package',
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

    test('⑥ agent 的重放也是同一条路：回执逐字相同、不产生第二行', async () => {
      const f = await fixture()
      const bytes = agentPackageZip()
      const previewResult = await f.preview(bytes)
      const decision = { localSlug: 'agent-worker', action: 'new' as const }
      const first = await f.apply(bytes, previewResult.previewToken, decision)
      const replay = await f.apply(bytes, previewResult.previewToken, decision)

      expect(replay).toEqual(first)
      expect(await f.db.select().from(agents)).toHaveLength(1)
      expect(await f.db.select().from(resourceBundleApplies)).toHaveLength(1)
    })

    test('⑦ 凭据：真值只写进实际落地的那一行，回执不记 skippedSecrets', async () => {
      const f = await fixture()
      const bytes = secretPackageZip()
      const previewResult = await f.preview(bytes)
      const receipt = await f.apply(
        bytes,
        previewResult.previewToken,
        { localSlug: 'mcp-tools', action: 'new', finalName: 'tools-copy' },
        [],
        [
          {
            resourceType: 'mcp',
            resourceName: 'tools',
            field: 'config.env.TOKEN',
            value: 'local-secret',
          },
        ],
      )

      expect(receipt.root?.name).toBe('tools-copy')
      expect(receipt.skippedSecrets).toBeUndefined()
      const rows = await f.db.select().from(mcps).where(eq(mcps.name, 'tools-copy'))
      expect(JSON.parse(rows[0]?.config ?? '{}')).toMatchObject({ env: { TOKEN: 'local-secret' } })
    })

    test('⑧ 凭据留空：该字段整个省掉、占位符绝不落库，且 skippedSecrets 进耐久回执', async () => {
      const f = await fixture()
      const bytes = secretPackageZip()
      const previewResult = await f.preview(bytes)
      const receipt = await f.apply(
        bytes,
        previewResult.previewToken,
        { localSlug: 'mcp-tools', action: 'new', finalName: 'tools-copy' },
        [],
        [{ resourceType: 'mcp', resourceName: 'tools', field: 'config.env.TOKEN', value: '' }],
      )

      const rows = await f.db.select().from(mcps).where(eq(mcps.name, 'tools-copy'))
      const stored = JSON.parse(rows[0]?.config ?? '{}') as { env?: Record<string, string> }
      expect(stored.env?.TOKEN).toBeUndefined()
      // 占位符落库 = 用户拿到一个跑不起来的 MCP，两个引擎都不许。
      expect(JSON.stringify(stored)).not.toContain(PACKAGE_SECRET_PLACEHOLDER)
      expect(receipt.skippedSecrets).toEqual([
        { resourceType: 'mcp', resourceName: 'tools-copy', field: 'config.env.TOKEN' },
      ])
      // 耐久回执里也要记着——重放时用户看到的是同一份「哪些凭据被跳过了」。
      const journal = await f.db
        .select({ receiptJson: resourceBundleApplies.receiptJson })
        .from(resourceBundleApplies)
        .where(eq(resourceBundleApplies.id, receipt.journalId))
      expect(journal[0]?.receiptJson ?? '').toContain('skippedSecrets')
    })

    test('⑨ 第三种资源类型（workflow）：归属 / 可见性 / 零 grants 不随类型漂', async () => {
      const f = await fixture()
      const bytes = workflowPackageZip()
      const previewResult = await f.preview(bytes)
      const receipt = await f.apply(bytes, previewResult.previewToken, {
        localSlug: 'workflow-deploy',
        action: 'new',
      })

      const rootId = receipt.root?.resourceId
      if (rootId === undefined) throw new Error('workflow receipt root missing')
      const rows = await f.db.select().from(workflows).where(eq(workflows.id, rootId))
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        name: 'deploy',
        description: 'from package',
        ownerUserId: OWNER,
        visibility: 'private',
      })
      expect(
        await f.db.select().from(resourceGrants).where(eq(resourceGrants.resourceId, rootId)),
      ).toEqual([])
    })

    test('⑩ 决策里的 finalName 生效：落地行用的是新名字，回执里也是', async () => {
      const f = await fixture()
      const bytes = workflowPackageZip()
      const previewResult = await f.preview(bytes)
      const receipt = await f.apply(bytes, previewResult.previewToken, {
        localSlug: 'workflow-deploy',
        action: 'new',
        finalName: 'deploy-copy',
      })

      expect(receipt.root?.name).toBe('deploy-copy')
      const rows = await f.db.select().from(workflows).where(eq(workflows.name, 'deploy-copy'))
      expect(rows).toHaveLength(1)
      expect(await f.db.select().from(workflows).where(eq(workflows.name, 'deploy'))).toEqual([])
    })

    test('⑪ 写能力的动态判据两台机器同解：带 script 节点的 workflow 一律拒绝，且不落行', async () => {
      const f = await fixture()
      const bytes = workflowPackageZip({ script: true })
      const previewResult = await f.preview(bytes)

      // preview 侧：`new` 不在可选动作里，缺的那一项被逐字报出来。
      const entry = previewResult.entries.find((e) => e.localSlug === 'workflow-deploy')
      expect(entry?.allowedActions).toEqual([])
      expect(entry?.defaultAction).toBeNull()
      expect(entry?.missingPermissions).toEqual(['scripts:author'])

      // commit 侧：同一个 oracle 再算一遍——两台机器都在这里拒绝。
      const err = await f
        .apply(bytes, previewResult.previewToken, { localSlug: 'workflow-deploy', action: 'new' })
        .then(
          () => null,
          (e: unknown) => e,
        )
      expect(err).toMatchObject({ code: 'package-decision-not-allowed' })
      expect(await f.db.select().from(workflows)).toEqual([])
      expect(await f.db.select().from(resourceBundleApplies)).toEqual([])
    })
  },
)
