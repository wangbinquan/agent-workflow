// RFC-359 W5-T17 —— provider 命名的文件只允许住在 `platform/persistence/`（高水位账本，只降不升）。
//
// **这条守卫锁的是什么**：一个以 `sqlite*` / `postgresql*`（含 `legacySqlite*` / `legacyPostgresql*`）
// 开头的文件名，是这份文件对自己的**自述**——「我只服务一个引擎」。而 RFC-359 要消灭的恰恰是这种形态：
// 同一件事落成两份实现，一个 provider 上修了、另一个漏了，行为就此悄悄漂移（W4 手上的每一对 pair
// 都是这么来的）。目标形态是：领域 / 应用层只认中立端口，引擎差异全部收进 `platform/persistence/`
// ——方言 SQL、客户端、迁移器、logical source/target 这些**本来就该按引擎分叉**的东西住在那里是设计，
// 不是债。判据因此只有一条：文件名带 provider 前缀 ⇒ 必须在 `platform/persistence/` 底下；在别处 = 债。
//
// **为什么现在是高水位而不是 0**：W4（pair 合一）还在收敛——写下这条守卫时全树还有 136 份这样的文件、
// 约 25 对未合。此刻钉 0 会让守卫从落地第一天就红，等于没有防守能力。所以先按 RFC-317 T17 的棘轮形态
// 把存量逐文件登记下来，**只降不升**：
//   - **增**了红 —— 有人又新开了一条只有单引擎能走的分叉；要么改走中立端口，要么把新增写进账本并说明理由；
//   - **减**了也红 —— 说明收敛真的发生了；把账本一起改小，让每一次销账都留下一次有署名的提交记录。
// W4 收敛完后这份账本应当清空：届时把两个常量都改成 `[]`，判据自然就是钉 0
// （`design/RFC-359-database-provider-unification/plan.md` §5 W5-T17：
//  「**T17** provider 命名文件只允许在 `platform/persistence/`（棘轮到 0）」）。
//
// **第二份账本（目录）** 堵的是同一判据的绕过口：把 `sqliteFoo.ts` 改叫 `sqlite/foo.ts`，文件名判据就
// 看不见了，分叉却一点没少。所以 provider 命名的**目录**同样登记、同样只降不升。

import { describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SRC = resolve(import.meta.dir, '..', '..', 'src')

/** provider 命名文件唯一允许的家：引擎差异本来就该收在这里。 */
const PERSISTENCE_HOME = 'platform/persistence/'

/** 「我只服务一个引擎」的自述式命名。大小写按仓内实际写法，不做宽松匹配。 */
const PROVIDER_NAMED = /^(sqlite|postgresql|legacySqlite|legacyPostgresql)/

/** 还落在 `platform/persistence/` 之外的 provider 命名文件（相对 `src`），按路径字典序。只降不升。 */
export const PROVIDER_NAMED_FILE_DEBT: readonly string[] = [
  'cli/postgresqlDaemonApplication.ts',
  'db/postgresqlSerializationRetry.ts',
  'db/sqliteMigrator.ts',
  'db/sqliteWriteRetry.ts',
  'modules/code-capability/infrastructure/postgresqlCapabilityMatrixRead.ts',
  'modules/code-capability/infrastructure/postgresqlCapabilityTemplatePackageMutationOwner.ts',
  'modules/code-capability/infrastructure/postgresqlCodeMetricsQuery.ts',
  'modules/code-capability/infrastructure/sqliteCapabilityMatrix.ts',
  'modules/code-capability/infrastructure/sqliteCodeMetricsRead.ts',
  'modules/integration/infrastructure/sqliteWebhookTriggerValidation.ts',
  'modules/intent/composition/postgresqlApplyMaintenance.ts',
  'modules/intent/infrastructure/postgresqlIntentApplyArtifactLifecycle.ts',
  'modules/intent/infrastructure/postgresqlIntentApplyOperations.ts',
  'modules/intent/infrastructure/sqliteIntentApplyArtifactLifecycle.ts',
  'modules/intent/infrastructure/sqliteIntentApplyOperations.ts',
  // ┌─ RFC-359 W10 —— resource-catalog 这 13 条**逐个核过**的分类。落在这里是因为 W9 已经证明
  // │  「这个数不等于分叉数」，而每一刀都在重新推导同一份分类；把结论钉在账本旁边，下一刀直接接。
  // │  分类判据：**看这份实现在生产里跑在什么句柄上、它的孪生在哪**，不看文件名。
  // │
  // │  ⚠️ 先记一条会反复骗人的事实：`PostgresqlDatabaseClient`（`platform/persistence/
  // │  postgresqlDatabaseClient.ts:35`）**不是** PG 专用客户端，它是 drizzle 的 **sqlite-proxy**
  // │  ——`SqliteRemoteDatabase<schema> & { $provider; $generationId }`，结构上就是
  // │  `ProviderNeutralDatabase` 的子类型（`db/query.ts:20`），查询构建器两侧同一套。
  // │  所以「这个文件吃 PostgresqlDatabaseClient」**不构成**它是真分叉的证据，只说明签名没放宽。
  // │
  // │  ① **真分叉（两侧各写一份业务逻辑，会漂）—— 7 条，是本模块剩下的全部靶心**
  // │     `aggregateAdapters/postgresql*` 五个 + `postgresqlResourcePackageArtifacts.ts` +
  // │     `composition/postgresqlResourcePackageCatalog.ts` 的 `mutationSessionFactory` 那一支。
  // │     **孪生顶着 `legacy*` 前缀、且一半藏在别的目录里**，所以 T17 的成对判据与
  // │     `rfc359-w5-provider-pair-conformance.test.ts` 的成对账本**同时看不见这一对**：
  // │       · intent apply：PG 侧 `postgresqlIntentApplyResourceParticipants`(510) +
  // │         `…ResourcePorts`(1591) + `…ArtifactOwners`(296) = 2397 行 ≈ 2099 行代码；
  // │         legacy 侧 `legacyIntentApplyResourceParticipants`(1118) +
  // │         `composition/legacyIntentApplyResourceDependencies`(143) + 注入的聚合写手 ≈ 1500 行
  // │         （agent 450 / workflow 333 / workgroup 248 / skill 282 / mcp 75 / plugin 44 …）
  // │         ⇒ **求和 ≈ 2761 行 ≈ 2219 行代码**。逐方法对位：
  // │         `createPostgresqlIntentApplyResourceSession` ↔ `createLegacyIntentApplyResourceSession`、
  // │         `createPostgresqlIntentApplyResourcePortFactory` ↔ `LegacyIntentApplyResourceDependencies`
  // │         的六条注入臂、`create…SkillArtifactLifecycle`/`…PluginArtifactLifecycle` ↔ legacy 的
  // │         inline `writeSkillTree` + 注入的 `stageManagedSkill`/`stageSkillVersion`/`installPlugin`。
  // │         PG 独有：`…MutationPort` / `…ResourcePorts` / 两阶段 `commitSucceeded()` attempt 提升。
  // │       · 资源包导入：PG 侧 `postgresqlResourcePackageMutationParticipants`(1405) +
  // │         `…MutationArms`(1725) + `postgresqlResourcePackageArtifacts`(489) = 3619 行 ≈ 3069 行代码；
  // │         legacy 侧 `legacyResourcePackageMutationParticipants`(1277) +
  // │         `services/bundle/legacyResourcePackageMutationDependencies`(214) +
  // │         `platform/persistence/sqlite/legacyResourcePackageCommit`(796) +
  // │         `…BundleApply`(732) + `…BundleLower`(324) ⇒ **求和 ≈ 3343 行**（注入的 ~1500 行聚合
  // │         写手与 intent apply **共用**，两行不要重复计）。逐方法对位：
  // │         `commitPostgresql{Agent,Skill,Mcp,Plugin,Workflow,Workgroup}PackageMutation`
  // │         ↔ legacy adapter 里同名的 `case '<kind>-create'/'-update'` 分支 → 注入的
  // │         `commitAgentCreateInTx` / `commitSkillReadyInTx` / `insertWorkflowInTx` … ；
  // │         `resolvePostgresqlCapabilityTemplatePackagePayload` ↔ `prepareTemplateFromBundle`。
  // │         PG 独有：`PostgresqlResourcePackageTransactionReader`（~300 行事务内读层，legacy 用
  // │         `getAclResourceOwnerInTx` 从组合根取）。
  // │     **薄壳陷阱提醒**：`legacy*` 那两个文件**不是**转发壳（719 / 894 行真实现），它们通过
  // │     依赖注入端口收下聚合写手；求和时要把 `composition/` 与 `services/bundle/` 里的注入记录
  // │     一起算进去，否则会低估 legacy 侧一半体量、误判成「PG 侧凭空多写了一倍」。
  // │     **处置建议（下一刀）**：体量 3000 : 2400，一刀合不完；按本波九次全中的经验先补
  // │     `POST /api/resource-packages/commit` 的双引擎对拍——两侧 compose 方式已在 `main.ts:224-260`
  // │     写全（SQLite 走 `composeSqliteResourcePackageProvider` +
  // │     `createSqliteResourcePackageExecutionAdapter`；PG 走 `composePostgresqlResourcePackage
  // │     Provider` + `createPostgresqlResourcePackageAtomicApplyOperations`），fork 点只在
  // │     `services/resourcePackage/executionAdapter.ts` 的 `apply`，上游 parse/preview/closure/
  // │     secretInputs/export 全是共用的中立代码。
  // │
  // │  ② **命名债（已经跑在中立句柄上，只是顶着旧名字；零行为风险）—— 4 条**
  // │     · `composition/postgresqlClassicCatalogs.ts` —— 唯一的 PG token 是入参类型；四个被调方
  // │       (`composeAgentCatalog` / `composeSkillCatalog` / `composeDatabaseWorkflowCatalog` /
  // │       `createSkillContentAvailability`) 全吃 `ProviderNeutralDatabase` 或纯文件系统。
  // │       注意它的「孪生」不是文件而是 `cli/start.ts` / `server.ts` 里**手写展开的同一串装配**。
  // │     · `composition/postgresqlResourcePackageCatalog.ts` 的 `resources`/`reads`/`readSkillTree`
  // │       三个字段与 `composition/resourcePackageOperations.ts:245` 的
  // │       `composeSqliteResourcePackageProvider` **逐字相同**；`composePostgresqlResourcePackage
  // │       Catalog` 本身是对中立 `composeResourcePackageOperations` 的纯转发。只有第四个字段
  // │       `mutationSessionFactory` 属于上面的①。
  // │     · `sqlitePackageResourceRows.ts` 的两个 async（`getSqlitePackageResourceRow` /
  // │       `findSqliteBuiltinResource`）是中立 drizzle，换 PG 照跑；只有两个 `*InTx` 是真机制。
  // │     · `sqliteResourceGrantRepository.ts` 的 `listWritableGrantedResourceIds` 早就吃
  // │       `ProviderNeutralDatabase`。
  // │     **改名不在本刀**：会牵动 5–7 份 architecture ledger，波尾单独一刀做。
  // │
  // │  ③ **机制本质不同（不该合，只该有对拍）—— 3 条**
  // │     · `sqliteAclReadRepository.ts` —— 七个 async 读**已经是 `export … from
  // │       './aclReadRepository'`**（W8 做的），结构上不可能漂；留下的五个 `*InTx` 吃 `DbTxSync`，
  // │       PG 上没有这个形态。**它不是分叉，只是落位债。**
  // │     · `sqliteResourcePackageMaintenance.ts` / `postgresqlResourcePackageMaintenance.ts` ——
  // │       两套互不认识的落盘工件 JSON（sqlite 的 `{staged:{…}}` vs PG 的扁平 + receipt 复核），
  // │       合一要数据迁移。已由 `rfc359-w5-artifact-format-portability.test.ts` 12 格矩阵 +
  // │       W8/W9 两份双引擎对拍钉住，成对账本里也有名。
  // │     ⚠️ **plan.md §W8 交接里点名的那个「活标本」已经不在了**：
  // │       `sqliteResourcePackageMaintenance.ts` 读 `skillOperations` 漏 `await` 那处，W9 已经补上
  // │       并在原地留了注释（今天在 :225-231）。别再按 plan 的描述去找它。
  // │
  // │  ④ **死代码 —— 已在本刀清掉 1 处**：`infrastructure/postgresql/repositorySupport.ts` 的
  // │     `runPostgresqlResourceCatalogTransaction`（零生产调用方）。它同时占着 W5-T18 与 W5-T20
  // │     两本账本各一行，随删除一并销账。另有 `sqliteResourceGrantRepository.ts` 的
  // │     `listResourceGrantUserIds` / `listResourceGrants` 也是零调用方，但退役会改动
  // │     `rfc349-provider-cutover.test.ts` 的导出账本（并发刀正在改那份），留给下一刀。
  // └─
  'modules/resource-catalog/composition/postgresqlClassicCatalogs.ts',
  'modules/resource-catalog/composition/postgresqlResourcePackageCatalog.ts',
  'modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlIntentApplyArtifactOwners.ts',
  'modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlIntentApplyResourceParticipants.ts',
  'modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlIntentApplyResourcePorts.ts',
  'modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlResourcePackageMutationArms.ts',
  'modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlResourcePackageMutationParticipants.ts',
  'modules/resource-catalog/infrastructure/postgresqlResourcePackageArtifacts.ts',
  'modules/resource-catalog/infrastructure/postgresqlResourcePackageMaintenance.ts',
  'modules/resource-catalog/infrastructure/sqliteAclReadRepository.ts',
  'modules/resource-catalog/infrastructure/sqlitePackageResourceRows.ts',
  'modules/resource-catalog/infrastructure/sqliteResourceGrantRepository.ts',
  'modules/resource-catalog/infrastructure/sqliteResourcePackageMaintenance.ts',
  'modules/system-operations/infrastructure/postgresqlAdminBackupCoordinator.ts',
  'modules/system-operations/infrastructure/postgresqlAdminRestoreCoordinator.ts',
  'modules/system-operations/infrastructure/postgresqlPendingRestore.ts',
  'modules/system-operations/infrastructure/postgresqlProviderBackup.ts',
  'modules/system-operations/infrastructure/postgresqlProviderRestore.ts',
  'modules/system-operations/infrastructure/postgresqlProviderRestoreApplicationAssets.ts',
  'modules/system-operations/infrastructure/sqliteMigrationSafetyBackup.ts',
  'modules/task-execution/composition/sqliteGateContinuationPreDrive.ts',
  'modules/task-execution/composition/sqliteTaskCatalogSources.ts',
  'modules/task-execution/composition/sqliteTaskExecutionContext.ts',
  'modules/task-execution/infrastructure/legacySqliteNodeRollback.ts',
  'modules/task-execution/infrastructure/legacySqliteNodeRunOperations.ts',
  'modules/task-execution/infrastructure/legacySqliteTaskAuthorization.ts',
  'modules/task-execution/infrastructure/legacySqliteTaskDatabase.ts',
  'modules/task-execution/infrastructure/legacySqliteTransportMechanisms.ts',
  'modules/task-execution/infrastructure/postgresqlChildExecutionLaunchOperations.ts',
  'modules/task-execution/infrastructure/postgresqlChildTaskLifecycleParticipant.ts',
  'modules/task-execution/infrastructure/postgresqlFusionEngineTaskOperations.ts',
  'modules/task-execution/infrastructure/postgresqlRepositoryPreparationRetryCommand.ts',
  'modules/task-execution/infrastructure/postgresqlSourceTerminationParticipant.ts',
  'modules/task-execution/infrastructure/postgresqlTaskDriverLifecycle.ts',
  'modules/task-execution/infrastructure/postgresqlTaskExecutionRuntimeParticipants.ts',
  'modules/task-execution/infrastructure/postgresqlTaskLifecycleAutoRepairCommand.ts',
  'modules/task-execution/infrastructure/postgresqlTaskLifecycleTransaction.ts',
  'modules/task-execution/infrastructure/postgresqlTaskRouteLaunchOperations.ts',
  'modules/task-execution/infrastructure/postgresqlTaskRouteOperations.ts',
  'modules/task-execution/infrastructure/postgresqlTaskRouteRepairOperations.ts',
  'modules/task-execution/infrastructure/postgresqlTaskRouteWorkspaceParticipant.ts',
  'modules/task-execution/infrastructure/sqliteChildExecutionLaunchOperations.ts',
  'modules/task-execution/infrastructure/sqliteNodeRunMintParticipant.ts',
  'modules/task-execution/infrastructure/sqliteSourceTerminationParticipant.ts',
  'modules/task-execution/infrastructure/sqliteTaskDecisionParticipant.ts',
  'modules/task-execution/infrastructure/sqliteTaskExecutionEffect.ts',
  'modules/task-execution/infrastructure/sqliteTaskExecutionIntent.ts',
  'modules/task-execution/infrastructure/sqliteTaskExecutionIntentAdmission.ts',
  'modules/task-execution/infrastructure/sqliteTaskExecutionRuntimeParticipants.ts',
  'modules/task-execution/infrastructure/sqliteTaskLifecycleAutoRepairCommand.ts',
  'modules/task-execution/infrastructure/sqliteTaskOwnership.ts',
  'modules/task-execution/infrastructure/sqliteTaskRouteLaunchOperations.ts',
  'modules/task-execution/infrastructure/sqliteTaskRouteOperations.ts',
  'modules/task-execution/infrastructure/sqliteTerminalizeExecutionIntent.ts',
  'platform/events/committed/sqliteStore.ts',
  'services/bundle/postgresqlApply.ts',
]

/**
 * 还落在 `platform/persistence/` 之外的 provider 命名**目录**（相对 `src`），按路径字典序。只降不升。
 * 这些目录里的文件自己不带 provider 前缀，逃得过上面那条账本，分叉却是同一种。
 */
export const PROVIDER_NAMED_DIRECTORY_DEBT: readonly string[] = [
  'modules/resource-catalog/infrastructure/postgresql',
]

type Entry = { readonly rel: string; readonly isDirectory: boolean }

/** 遍历整棵 `src`，产出每一个目录与 `.ts` 文件的相对路径。 */
function walkSrc(): Entry[] {
  const out: Entry[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(SRC, dir), { withFileTypes: true })) {
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        out.push({ rel, isDirectory: true })
        walk(rel)
        continue
      }
      if (entry.name.endsWith('.ts')) out.push({ rel, isDirectory: false })
    }
  }
  walk('')
  return out
}

const basename = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1)

/** 扫到的全部 backend 源文件——语料下限的分母（RFC-317 T13：扫空 = 假绿）。 */
function sourceFiles(): string[] {
  return walkSrc()
    .filter((entry) => !entry.isDirectory)
    .map((entry) => entry.rel)
}

/** `platform/persistence/` 里的 provider 命名文件：合法住户，同时也是「匹配器还活着」的活体证据。 */
function providerNamedAtHome(): string[] {
  return walkSrc()
    .filter(
      (entry) =>
        !entry.isDirectory &&
        entry.rel.startsWith(PERSISTENCE_HOME) &&
        PROVIDER_NAMED.test(basename(entry.rel)),
    )
    .map((entry) => entry.rel)
    .sort()
}

/** 判据本体：provider 命名、且不在 `platform/persistence/` 底下的文件。 */
function scan(): string[] {
  return walkSrc()
    .filter(
      (entry) =>
        !entry.isDirectory &&
        !entry.rel.startsWith(PERSISTENCE_HOME) &&
        PROVIDER_NAMED.test(basename(entry.rel)),
    )
    .map((entry) => entry.rel)
    .sort()
}

/** 同一判据的目录形态（绕过口）。 */
function scanDirectories(): string[] {
  return walkSrc()
    .filter(
      (entry) =>
        entry.isDirectory &&
        !entry.rel.startsWith(PERSISTENCE_HOME) &&
        PROVIDER_NAMED.test(basename(entry.rel)),
    )
    .map((entry) => entry.rel)
    .sort()
}

describe('RFC-359 W5-T17 —— provider 命名文件只允许在 platform/persistence/', () => {
  test('语料非空：确实扫到了整棵 backend 源码树，且命名匹配器仍能咬到东西（扫空 = 假绿）', () => {
    expect(
      sourceFiles().length,
      '扫到的 backend 源文件太少——扫描根多半失效了，此刻这条守卫零预言力。',
    ).toBeGreaterThanOrEqual(1500)
    expect(
      providerNamedAtHome().length,
      '`platform/persistence/` 里一个 provider 命名文件都没扫到——命名匹配器已经不咬人了；' +
        '账本清空后这条守卫会变成永久假绿，先修匹配器再说。',
    ).toBeGreaterThanOrEqual(10)
  })

  test('落在 platform/persistence/ 之外的 provider 命名文件与账本逐字相等（增了是新分叉，减了是收敛，都要改账本）', () => {
    expect(
      scan(),
      'provider 命名文件的落位与账本不符。' +
        '**增**了说明有人又新开了一条只有单引擎能走的分叉——把它写成中立端口 + ' +
        '`platform/persistence/` 里的方言实现；确有理由留在原地就把新增写进 ' +
        '`PROVIDER_NAMED_FILE_DEBT` 并说明为什么。' +
        '**减**了说明合一发生了——把账本一起改小，让这次销账留下一次有署名的提交记录。' +
        'W4 收敛完后这份账本应当清空（plan.md §5 W5-T17：棘轮到 0）。',
    ).toEqual([...PROVIDER_NAMED_FILE_DEBT])
  })

  test('落在 platform/persistence/ 之外的 provider 命名目录与账本逐字相等（堵住「改叫 sqlite/foo.ts」的绕过口）', () => {
    expect(
      scanDirectories(),
      'provider 命名目录与账本不符。新建这样的目录等于把分叉藏进路径里躲开文件名判据；' +
        '**增**了要么改走中立端口，要么写进 `PROVIDER_NAMED_DIRECTORY_DEBT` 并说明；' +
        '**减**了把账本一起改小。',
    ).toEqual([...PROVIDER_NAMED_DIRECTORY_DEBT])
  })

  test('两份账本都按路径字典序、无重复（清点稳定的前提）', () => {
    for (const [name, ledger] of [
      ['PROVIDER_NAMED_FILE_DEBT', PROVIDER_NAMED_FILE_DEBT],
      ['PROVIDER_NAMED_DIRECTORY_DEBT', PROVIDER_NAMED_DIRECTORY_DEBT],
    ] as const) {
      expect(new Set(ledger).size, `${name} 里有重复条目`).toBe(ledger.length)
      expect([...ledger].sort(), `${name} 没有按路径字典序排列`).toEqual([...ledger])
    }
  })
})
