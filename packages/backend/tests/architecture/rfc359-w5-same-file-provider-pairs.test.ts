// RFC-359 AC-1 —— **同文件** provider 孪生的账本（只降不升）。
//
// 为什么需要这一份
// ----------------
// `rfc359-w5-provider-pair-conformance` 是本仓数「还剩几对」的地方，但它按**文件名词干**
// 配对（`sqliteFoo.ts` ↔ `postgresqlFoo.ts`）。于是**同一个文件里的一对**它一个也看不见：
//
//     // 一个文件里
//     export function composeSqliteFoo(db: DbClient) { … }
//     export function composePostgresqlFoo(db: PostgresqlDatabaseClient) { … }
//
// plan §5fp 合掉的那一对（`create{,Postgresql}ExecutionContractResourceAdapter`）正是这个形状，
// **合掉它 `PROVIDER_PAIR_COUNT` 一动不动**——那个数当时记着 8，而同文件对实测 48 对 / 42 个文件。
// 「还剩几对」长期只数得到一小半，AC-1 的真实规模从来没被看见过。这份账本补上另一半。
//
// 判据（`§5fq` 的完成线）
// ----------------------
// 一对孪生必须合一，**除非差异源于引擎本身**，而那只有三种：
//   ① 只有一个引擎有的**原语**（advisory lock / PRAGMA / `$client` / `dbTxSync` /
//      PostgreSQL 的只读可重复读快照）；
//   ② 只有一个引擎有的**资源形态**（SQLite 是一个**文件**，PostgreSQL 是一台**服务器**）；
//   ③ 驱动强加的**线上差异**（占位符 / 类型编解码）。
// 其余一律是漂移，处方是「各取更强的一半，合成一份」。
//
// 所以账本里每一条都**必须带一个裁决标记**：`①` / `②` / `③` 之一，或者 `漂移待合`。
// 想让一对留下来，就得指名它命中哪一条；指不出来，它就只能挂着 `漂移待合` 等人来合。
// 这比一个光秃秃的数字有用——数字不告诉你下一步该干什么。
//
// 判据只认**导出的**声明（`export function|class|const`），因为只有导出的东西才可能被
// 两个组合根分别选用；文件内部的私有辅助函数叫什么名字不构成 provider 分叉。

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

const SRC = resolve(import.meta.dir, '..', '..', 'src')

const BRAND = /(Sqlite|Postgresql)/
const EXPORTED_DECLARATION = /export\s+(?:async\s+)?(?:function|class|const)\s+([A-Za-z0-9_]+)/g
/** 裁决标记：三条「源于引擎本身」之一，或「还没合、也没理由留」。 */
const RULING = /—\s(①|②|③|漂移待合)：/

/** 账本行 → 它描述的那一对的身份（丢掉裁决与理由）。 */
function pairIdentityOf(entry: string): string {
  const cut = entry.search(RULING)
  return cut < 0 ? entry : entry.slice(0, cut).trimEnd()
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, out)
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

const FILES = sourceFiles(SRC)

/**
 * 扫出同文件孪生。两种成对形态都算：
 *   · 两个品牌名同时存在（`composeSqliteFoo` + `composePostgresqlFoo`）；
 *   · 一个品牌名 + 同文件里的中立名（`composeFoo` + `composePostgresqlFoo`）——
 *     这种更隐蔽：中立那份看起来「已经合一了」，其实旁边还挂着一份品牌实现。
 */
export function scanSameFileProviderPairs(
  files: readonly { readonly path: string; readonly text: string }[],
): string[] {
  const rows: string[] = []
  for (const file of files) {
    const exported = new Set<string>()
    for (const match of file.text.matchAll(EXPORTED_DECLARATION)) exported.add(match[1] ?? '')
    const byNeutral = new Map<string, string[]>()
    for (const name of exported) {
      if (!BRAND.test(name)) continue
      const key = name.replace(BRAND, '')
      byNeutral.set(key, [...(byNeutral.get(key) ?? []), name])
    }
    for (const [key, members] of byNeutral) {
      const hasSqlite = members.some((name) => name.includes('Sqlite'))
      const hasPostgresql = members.some((name) => name.includes('Postgresql'))
      const neutralPresent = exported.has(key)
      if (!((hasSqlite && hasPostgresql) || (neutralPresent && (hasSqlite || hasPostgresql)))) {
        continue
      }
      const all = [...members, ...(neutralPresent ? [key] : [])].sort()
      rows.push(`${file.path}::${key} = ${all.join(' + ')}`)
    }
  }
  return rows.sort()
}

const SCANNED = scanSameFileProviderPairs(
  FILES.map((path) => ({ path: relative(SRC, path), text: readFileSync(path, 'utf8') })),
)

/**
 * 同文件 provider 孪生的高水位。**只降不升**——合掉一对就删一行。
 *
 * 每一行的形状是 `<相对 src 的路径>::<中立名> = <成员> — <裁决>：<理由>`。
 * 裁决只能是 ① / ② / ③ / 漂移待合 四者之一（见文件头注）。
 */
export const SAME_FILE_PROVIDER_PAIRS: readonly string[] = [
  'cli/doctor.ts::checkSealedCredentials = checkPostgresqlSealedCredentials + checkSealedCredentials — ②：doctor 要在**守护进程没起来**时也能查：SQLite 直接 `new Database(<文件>, {readonly:true})` 打开那个文件，PostgreSQL 必须问一台**服务器**要连接池。文件 vs 服务器，判据第二条',
  'embed.ts::countEmbeddedSqlMigrations = countEmbeddedPostgresqlSqlMigrations + countEmbeddedSqlMigrations — ②：两条迁移链是**两套各自落盘的工件**（`MIGRATION_FILES` / `POSTGRESQL_MIGRATION_FILES`），不是同一份 SQL 的两种渲染——与 `util/migrationsFolder.ts` 同一条理由',
  'embed.ts::extractMigrationsTo = extractMigrationsTo + extractPostgresqlMigrationsTo — ②：两条迁移链是**两套各自落盘的工件**（`MIGRATION_FILES` / `POSTGRESQL_MIGRATION_FILES`），不是同一份 SQL 的两种渲染——与 `util/migrationsFolder.ts` 同一条理由',
  'modules/collaboration/composition/commandContext.ts::createCollaborationCommandContext = createCollaborationCommandContext + createPostgresqlCollaborationCommandContext — 漂移待合：按 §5fq 三条判据均未指名，但**挡在下层**——下层仍是品牌实现：`createPostgresqlCollaborationCommandContext`。先合下层，这一层自然塌成一份。',
  'modules/digital-employee/composition.ts::composeDigitalEmployee = composeDigitalEmployee + composePostgresqlDigitalEmployee — 漂移待合：按 §5fq 三条判据均未指名，但**挡在下层**——下层仍是品牌实现：`composePostgresqlDigitalEmployee`。先合下层，这一层自然塌成一份。',
  'modules/digital-employee/composition.ts::createEmployeeReactionRoundQueries = createEmployeeReactionRoundQueries + createPostgresqlEmployeeReactionRoundQueries — 漂移待合：按 §5fq 三条判据均未指名，但**挡在下层**——下层仍是品牌实现：`createPostgresqlEmployeeReactionRoundQueries`。先合下层，这一层自然塌成一份。',
  'modules/event-center/composition.ts::composeEventCenter = composeEventCenter + composePostgresqlEventCenter — 漂移待合：按 §5fq 三条判据均未指名，但**挡在下层**——下层仍是品牌实现：`composePostgresqlEventCenter`。先合下层，这一层自然塌成一份。',
  'modules/identity-access/composition.ts::createIdentityAccessRuntime = createIdentityAccessRuntime + createPostgresqlIdentityAccessRuntime — 漂移待合：按 §5fq 三条判据均未指名，但**挡在下层**——下层仍是品牌实现：`createPostgresqlIdentityAccessRuntime`。先合下层，这一层自然塌成一份。',
  'modules/integration/composition.ts::createCodeHostWebhookDeliveryConsumer = createCodeHostWebhookDeliveryConsumer + createPostgresqlCodeHostWebhookDeliveryConsumer — 漂移待合：按 §5fq 三条判据均未指名，但**挡在下层**——下层仍是品牌实现：`createPostgresqlCodeHostWebhookDeliveryConsumer`。先合下层，这一层自然塌成一份。',
  'modules/integration/composition.ts::createCodeHostWebhookRoutingDirectory = createCodeHostWebhookRoutingDirectory + createPostgresqlCodeHostWebhookRoutingDirectory — 漂移待合：按 §5fq 三条判据均未指名，但**挡在下层**——下层仍是品牌实现：`createPostgresqlCodeHostWebhookRoutingDirectory`。先合下层，这一层自然塌成一份。',
  'modules/integration/composition/webhookDispatch.ts::composeWebhookDispatchPersistence = composePostgresqlWebhookDispatchPersistence + composeWebhookDispatchPersistence — 漂移待合：按 §5fq 三条判据均未指名，但**挡在下层**——下层仍是品牌实现：`composePostgresqlWebhookDispatchPersistence`。先合下层，这一层自然塌成一份。',
  'modules/integration/composition/webhookDispatch.ts::composeWebhookTriggerServiceDependencies = composePostgresqlWebhookTriggerServiceDependencies + composeSqliteWebhookTriggerServiceDependencies + composeWebhookTriggerServiceDependencies — 漂移待合：按 §5fq 三条判据均未指名，但**挡在下层**——下层仍是品牌实现：`composePostgresqlWebhookTriggerServiceDependencies` / `composeSqliteWebhookTriggerServiceDependencies` / `createSqliteWebhookTriggerValidation`。先合下层，这一层自然塌成一份。',
  'modules/integration/composition/webhookTerminalControl.ts::composeMrTerminalControl = composeMrTerminalControl + composePostgresqlMrTerminalControl — 漂移待合：按 §5fq 三条判据均未指名，但**挡在下层**——下层仍是品牌实现：`composePostgresqlMrTerminalControl`。先合下层，这一层自然塌成一份。',
  'modules/integration/infrastructure/webhookRepositoryResolver.ts::createWebhookRepositoryResolver = createPostgresqlWebhookRepositoryResolver + createSqliteWebhookRepositoryResolver — 漂移待合：按 §5fq 三条判据均未指名，但**挡在下层**——下层仍是品牌实现：`createSqliteWebhookRepositoryResolver`。先合下层，这一层自然塌成一份。',
  'modules/resource-catalog/composition/resourcePackageMaintenance.ts::composeResourcePackageApplyMaintenance = composePostgresqlResourcePackageApplyMaintenance + composeSqliteResourcePackageApplyMaintenance — 漂移待合：按 §5fq 三条判据均未指名，但**挡在下层**——下层仍是品牌实现：`composePostgresqlResourcePackageApplyMaintenance` / `composeSqliteResourcePackageApplyMaintenance`。先合下层，这一层自然塌成一份。',
  'modules/system-operations/composition.ts::composeSystemOperations = composePostgresqlSystemOperations + composeSystemOperations — ②：备份 / 恢复：SQLite 是 copy 一个文件，PostgreSQL 是 pg_dump / pg_restore 一台服务器',
  'modules/system-operations/composition/maintenanceDisk.ts::composeMaintenanceDiskOperations = composePostgresqlMaintenanceDiskOperations + composeSqliteMaintenanceDiskOperations — ②：SQLite 量的是一个**文件**的磁盘占用，PostgreSQL 要问**服务器**要；资源形态不同',
  'modules/task-execution/composition/actionExecutionEnvironment.ts::createActionExecutionEnvironment = createPostgresqlActionExecutionEnvironment + createSqliteActionExecutionEnvironment — 漂移待合：按 §5fq 三条判据均未指名，但**挡在下层**——下层仍是品牌实现：`createPostgresqlActionExecutionEnvironment` / `createSqliteActionExecutionEnvironment`；且这条路还挂在 `services/task` 的 SQLite 专属启动面上。先合下层，这一层自然塌成一份。',
  'modules/task-execution/composition/agentActionExecution.ts::composeAgentActionExecution = composeAgentActionExecution + composePostgresqlAgentActionExecution — 漂移待合：按 §5fq 三条判据均未指名，但**挡在下层**——下层仍是品牌实现：`composePostgresqlAgentActionExecution` / `createPostgresqlActionExecutionEnvironment` / `createSqliteActionExecutionEnvironment`。先合下层，这一层自然塌成一份。',
  'modules/task-execution/composition/agentLaunchResources.ts::composeAgentLaunchResourceOperations = composePostgresqlAgentLaunchResourceOperations + composeSqliteAgentLaunchResourceOperations — 漂移待合：按 §5fq 三条判据均未指名，但**挡在下层**——下层仍是品牌实现：`composePostgresqlAgentLaunchResourceOperations` / `composeSqliteAgentLaunchResourceOperations` / `createSqliteAgentLaunchResourceOperations`。先合下层，这一层自然塌成一份。',
  'modules/task-execution/composition/digitalEmployeeExecution.ts::composeDigitalEmployeeExecution = composeDigitalEmployeeExecution + composePostgresqlDigitalEmployeeExecution — 漂移待合：按 §5fq 三条判据均未指名，但**挡在下层**——下层仍是品牌实现：`composePostgresqlDigitalEmployeeExecution`；且这条路还挂在 `services/task` 的 SQLite 专属启动面上。先合下层，这一层自然塌成一份。',
  'modules/task-execution/composition/providerRuntime.ts::composeTaskExecutionProviderRuntime = composePostgresqlTaskExecutionProviderRuntime + composeSqliteTaskExecutionProviderRuntime — 漂移待合：按 §5fq 三条判据均未指名，但**挡在下层**——下层仍是品牌实现：`composePostgresqlTaskExecutionProviderRuntime` / `createPostgresqlClarifyRepairParticipant` / `createPostgresqlFusionEngineTaskOperations`。先合下层，这一层自然塌成一份。',
  'modules/task-execution/composition/scriptActionExecution.ts::composeScriptActionExecution = composePostgresqlScriptActionExecution + composeScriptActionExecution — 漂移待合：按 §5fq 三条判据均未指名，但**挡在下层**——下层仍是品牌实现：`composePostgresqlScriptActionExecution` / `createPostgresqlActionExecutionEnvironment` / `createSqliteActionExecutionEnvironment`。先合下层，这一层自然塌成一份。',
  'modules/task-execution/composition/sourceTermination.ts::composeTaskSourceTermination = composePostgresqlTaskSourceTermination + composeTaskSourceTermination — 漂移待合：按 §5fq 三条判据均未指名，但**挡在下层**——下层仍是品牌实现：`composePostgresqlTaskSourceTermination` / `createPostgresqlTaskSourceTerminationParticipant`。先合下层，这一层自然塌成一份。',
  'modules/task-execution/composition/triggerExecution.ts::createTaskExecutionTriggerParticipant = createPostgresqlTaskExecutionTriggerParticipant + createSqliteTaskExecutionTriggerParticipant — 漂移待合：按 §5fq 三条判据均未指名，但**挡在下层**——下层仍是品牌实现：`createPostgresqlTaskExecutionTriggerParticipant` / `createSqliteTaskExecutionTriggerParticipant`。先合下层，这一层自然塌成一份。',
  'modules/task-execution/infrastructure/agentLaunchResourceOperations.ts::createAgentLaunchResourceOperations = createPostgresqlAgentLaunchResourceOperations + createSqliteAgentLaunchResourceOperations — 漂移待合：按 §5fq 三条判据均未指名，但**挡在下层**——下层仍是品牌实现：`createPostgresqlAgentLaunchResourceOperations` / `createSqliteAgentLaunchResourceOperations`。先合下层，这一层自然塌成一份。',
  'platform/persistence/capabilities.ts::createCapabilities = createPostgresqlCapabilities + createSqliteCapabilities — ①：能力矩阵本身——「这个引擎有没有同步读」这类问题按定义每个引擎一个答案',
  'platform/persistence/databaseOperationalAdapter.ts::createDatabaseOperationalAdapter = createPostgresqlDatabaseOperationalAdapter + createSqliteDatabaseOperationalAdapter — 漂移待合：按 §5fq 三条判据均未指名，但**挡在下层**——下层仍是品牌实现：`createPostgresqlDatabaseOperationalAdapter` / `createSqliteDatabaseOperationalAdapter`。先合下层，这一层自然塌成一份。',
  'platform/persistence/databaseTransaction.ts::createDatabaseSession = createPostgresqlDatabaseSession + createSqliteDatabaseSession — ①：事务原语：SQLite 走 bun:sqlite 的同步事务，PostgreSQL 走 SERIALIZABLE + 40001 退避',
  'server.ts::composeAppDeps = composePostgresqlAppDeps + composeSqliteAppDeps — 漂移待合：按 §5fq 三条判据均未指名，但**挡在下层**——下层仍是品牌实现：`composePostgresqlAppDeps` / `composeSqliteAppDeps`；且这条路还挂在 `services/task` 的 SQLite 专属启动面上。先合下层，这一层自然塌成一份。',
  'server.ts::composeDaemonProviderCore = composePostgresqlDaemonProviderCore + composeSqliteDaemonProviderCore — 漂移待合：按 §5fq 三条判据均未指名，但**挡在下层**——下层仍是品牌实现：`composePostgresqlDaemonProviderCore` / `composePostgresqlMaintenanceDiskOperations` / `composePostgresqlRepositoryWorkspaceStore`；且这条路还挂在 `services/task` 的 SQLite 专属启动面上。先合下层，这一层自然塌成一份。',
  'util/migrationsFolder.ts::resolveMigrationsFolder = resolveMigrationsFolder + resolvePostgresqlMigrationsFolder — ②：两条迁移链各有各的目录——迁移文件是**落盘工件**，不是同一份 SQL 的两种渲染',
]

describe('RFC-359 AC-1 —— 同文件 provider 孪生（高水位，只降不升）', () => {
  test('语料非空：确实扫到了整棵 src（扫成 0 说明扫描根失效，此刻零预言力）', () => {
    expect(FILES.length, 'src 扫成空').toBeGreaterThanOrEqual(500)
  })

  test('判别式在真源码上识别得出东西（识别到 0 = 判据瞎了）', () => {
    expect(SCANNED.length).toBeGreaterThanOrEqual(1)
  })

  test('两种成对形态都认：双品牌、以及「中立名 + 品牌名」同处一文件', () => {
    const rows = scanSameFileProviderPairs([
      {
        path: 'demo/both.ts',
        text: 'export function composeSqliteFoo() {}\nexport function composePostgresqlFoo() {}\n',
      },
      {
        path: 'demo/neutralPlusBrand.ts',
        text: 'export const composeBar = 1\nexport function composePostgresqlBar() {}\n',
      },
      {
        // 只有一侧、且同文件没有中立名 ⇒ 不是同文件对（可能与别的文件配成跨文件对，
        // 那是 `rfc359-w5-provider-pair-conformance` 的判据，不归这里管）。
        path: 'demo/loneBrand.ts',
        text: 'export function composeSqliteBaz() {}\n',
      },
      {
        // 私有声明不算：没导出的东西不可能被两个组合根分别选用。
        path: 'demo/private.ts',
        text: 'function composeSqliteQux() {}\nfunction composePostgresqlQux() {}\n',
      },
    ])

    expect(rows).toEqual([
      'demo/both.ts::composeFoo = composePostgresqlFoo + composeSqliteFoo',
      'demo/neutralPlusBrand.ts::composeBar = composeBar + composePostgresqlBar',
    ])
  })

  test('逐条与源码相等（增了是新开的同文件分叉，减了是合一，都要改账本）', () => {
    // 账本行 = `<对的身份> — <裁决>：<理由>`；这条只比**身份**那一半。
    // 裁决由下一条单独管，两件事分开断言，红的时候一眼知道是「多了一对」还是「少了个理由」。
    expect(
      SCANNED,
      '同文件 provider 孪生与账本不符。**增**了说明有人在一个文件里新开了一对按 provider 分叉的' +
        '导出——先按 §5fq 的三条判据问自己「这个差异源于引擎本身吗」，指不出来就别分叉。' +
        '**减**了说明合掉了一对，把对应那行删掉。',
    ).toEqual(SAME_FILE_PROVIDER_PAIRS.map(pairIdentityOf))
  })

  test('每一条都带 §5fq 裁决标记（想留下来就得指名命中哪一条）', () => {
    const unruled = SAME_FILE_PROVIDER_PAIRS.filter((entry) => !RULING.test(entry))
    expect(
      unruled,
      '这些条目没有裁决标记。账本不是用来「记着有这么回事」的——每一对要么指名它命中 ' +
        '§5fq 的 ① / ② / ③（差异源于引擎本身，可以留），要么标 `漂移待合`（该合，还没合）。',
    ).toEqual([])
  })

  test('账本按字典序、无重复（清点稳定的前提）', () => {
    expect([...SAME_FILE_PROVIDER_PAIRS]).toEqual([...SAME_FILE_PROVIDER_PAIRS].sort())
    expect(new Set(SAME_FILE_PROVIDER_PAIRS).size).toBe(SAME_FILE_PROVIDER_PAIRS.length)
  })
})
