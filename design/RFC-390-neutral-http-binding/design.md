# RFC-390 设计：中立 HTTP 绑定

研究基线 HEAD `8186c9852`（行号以实施时源码为准；RFC-389 会移动 `cli/start.ts` 的维护接线）。缩写：

- `V:` = `server.ts`
- `S:` = `cli/start.ts`
- `P:` = `cli/postgresqlDaemonApplication.ts`
- `B/x` = `cli/daemonModules/x.ts`
- `T/` = `packages/backend/tests/`

其余路径相对 `packages/backend/src/`。研究笔记见本会话 2026-10-21 的两份只读研究（HTTP 绑定逐字段对照）。

## 1. 现状

### 1.1 绑定

| 元素 | 位置 | 使用者 |
| --- | --- | --- |
| `ProviderAppCompositionInput<P>`（13 组路由输入 + intent） | V:1103-1125；组类型 V:941-1095 | PostgreSQL |
| `composeProviderAppDeps` | V:1150-1323 | PostgreSQL（经 V:1326-1330 的 `composePostgresqlAppDeps`，唯一调用方 P:1665） |
| SQLite 绑定 | V:1362-1903 `composeSqliteApplicationDeps`（12 个模块组回退 + HTTP owner）+ V:1927-2384 `composeSqliteApiRouteMounts` + 公共路由表 V:1881-1887 | SQLite 生产（S:2586-2666 经 `composeSqliteAppDeps`）与测试 |
| HTTP 专用 owner（PostgreSQL） | P:712-798、P:874-942、P:955-970、P:1013-1035、P:1111-1130、P:1146-1443 | PostgreSQL |

### 1.2 差异分类（逐字段研究的结论）

| 类别 | 内容 |
| --- | --- |
| 同一工厂、写了两份 | 绝大多数 owner 与路由输入 |
| 只差输入 | 托管专属选择（`crewStationEvents`、`repositoryRemote`、代码评审内容 / 工件、`runtimeInventoryContent`）；测试接缝通道（`workflowExactOperationHook`、`codeHostFetch`、`opencodeVersion`）；热应用作用域键（SQLite `db`，PostgreSQL 运行时对象，= `DAEMON_TASK_EXECUTION_ADAPTERS[p].processConcurrencyScope`，B/adapters.ts:76、:82） |
| 漂移 | 维护遥测 SQLite 不传（V:2137；`platform/persistence/databaseProviderRuntime.ts:211`）；插件安装器两份（P:750-785 / `services/resourcePackage/pluginInstallerAdapter.ts:38`）；融合路由死字段 `appHome`（P:1347）与 `configPath` / `launchConfiguration`（`modules/knowledge-evolution/inbound/fusionRoutes.ts:48-53` 声明、无人读）；MCP `probeRunner`（V:2167-2177 不传）；`\| null` 死守卫（V:1213、:1224、:1235、:2221、:2255、:2260）与 `NO_RESOURCE_PACKAGE_APPLY_ACTIVITY` |
| 生产可达回退 | `deps.appHome ?? Paths.root`（V:1369）；`deps.configConcurrencyHotApply ?? composeLegacyConfigConcurrencyHotApply(deps.db)`（V:1537-1538） |

S 传给 `composeSqliteAppDeps` 的 76 个键里，约 40 个只喂 V 的 `??` 回退，生产不可达。

### 1.3 构造顺序

- PostgreSQL：应用（含 HTTP）先于维护服务。
- SQLite：维护服务先于 HTTP，对 `appComposition.resourcePackageApplyActivity` 闭包晚读（S:2549-2550）；这是 `SqliteAppComposition`
  额外输出里唯一的生产消费者。

## 2. 设计

### 2.1 中立函数（G1）

在 V 中、`/** Named production entry points` 注释之后，新增一个独立的顶层函数（不得并入 `composeProviderAppDeps`，见 §4）：

```ts
export interface ProviderAppOwnerInput<P extends DatabaseProvider> {
  readonly db: ProviderNeutralDatabase
  readonly token: string
  readonly appHome: string
  readonly secretBox: SecretBox
  readonly dbVersion: number
  readonly opencodeVersion: string | null
  readonly applicationConfiguration: ApplicationConfigurationBinding
  readonly executionAuthority: ExecutionAuthorityPort
  readonly databaseTelemetry: () => DatabaseRuntimeTelemetry
  readonly maintenanceStatus?: () => MaintenanceStatus
  readonly daemonRuntime?: DaemonRuntimeQueries
  readonly daemonInfoPath: string
  readonly databaseMigration: DatabaseMigrationModule
  readonly portArtifacts: PortArtifactOperations
  readonly integrationIdentityAccess: IntegrationTriggerIdentityAccess
  readonly modules: Readonly<{ /* 12 个会话模块组 */ }>
  readonly selections?: Readonly<{ /* 托管专属选择，单机不传 */ }>
  readonly testSeams?: Readonly<{ workflowRuntime?; codeHostRuntime?; buildScheduleLaunch? }>
}
export function composeProviderAppComposition<P extends DatabaseProvider>(
  input: ProviderAppOwnerInput<P>,
): { readonly composition: ProviderAppCompositionInput<P>; readonly resourcePackageApplyActivity: ResourcePackageApplyActivityQuery }
```

函数体就是现在 P 的 HTTP 部分，按以下规则统一：

- 资源包 provider / 原子 apply / catalog / 执行适配器收成同处一个私有助手；插件安装器只用 `createResourcePackagePluginInstaller()`。
- 配置热应用收成私有助手 `composeConfigConcurrencyHotApply(scope)`，作用域取任务执行模块组新交出的 `processConcurrencyScope`
  （B/taskExecution.ts 的返回值增加该成员）。
- oidc 用 `{ db, secretBox }` 入参；协作访问端口用中立名 `createCollaborationTaskAccessPort`；概览经 composition 再导出。
- 资源目录读模块组的具名成员（`agentCatalog` 等），不读 `classicCatalogs.*`。
- MCP 路由两边都带 `probeRunner`；维护状态两边都带 `databaseTelemetry`。
- 融合路由只传 `operations` / `directAuthority`：删除 `FusionRouteDependencies.configPath` / `launchConfiguration`、`fusionModules.launchConfiguration`
  与 B/fusion.ts 的 `configPath?` 输入（若再无消费方）。
- 删除 `| null` 死守卫与 `NO_RESOURCE_PACKAGE_APPLY_ACTIVITY`。
- `codeHistoryQueries` 由中立函数构造（S:2569 删除）。

### 2.2 三个调用方

- **PostgreSQL（P）**：
  - 模块组之后调一次中立函数，`createComposedApp(composeProviderAppDeps(http.composition))`；
  - `runtime.resourcePackageActivity` 取 `http.resourcePackageApplyActivity`；
  - 应用阶段只决定 `opencodeVersion`、`workflowRuntime` 的值与未启动阶段的就绪步骤；
  - 删除 P 里的 HTTP owner 及其导入，删除 `composePostgresqlAppDeps`。
- **SQLite 会话根（S）**：
  - 用一次中立调用取代 `codeHistoryQueries` 的构造与 76 键的 `composeSqliteAppDeps({...})`；
  - 显式传 `appHome: Paths.root` 与 `databaseTelemetry: databaseProvider.telemetry`，托管专属选择一项都不传；
  - 维护服务的 apply 晚读改读 `http.resourcePackageApplyActivity`。
- **SQLite 测试路径（V 的 `composeSqliteApplicationDeps`）**：
  - 保留开头的选择预处理与 12 个模块组回退（RFC-380 守卫要求 V 内模块组调用都在 `??` 右侧）；
  - `databaseMigration` 缺省时补一个惰性准入的模块（同 `T/helpers/providerHttpApplication.ts` 的做法）；若其构造不是被动的，改为保持可选，并在实施报告中说明；
  - 把 `AppDeps` 映射到中立输入（`appHome ?? Paths.root`、测试接缝），调中立函数与 `composeProviderAppDeps`；
  - `SqliteAppComposition` 的额外输出（模块组、`repositoryWorkspaceStore`、读模型、协作上下文、`resourcePackageApplyActivity` 等）保持不变。

### 2.3 删除（G2、G4）

- **路由表与类型**：`composeSqliteApiRouteMounts`、`SqliteApiRouteComposition`、SQLite 公共路由表、`ResourcePackageRouteBinding`、
  `RuntimeComposedAppDeps` / `SqliteComposedAppDeps` / `SqliteAppDeps`、`composeLegacyConfigConcurrencyHotApply`、`composePostgresqlAppDeps`。
- **`AppDeps` 的逐字段覆盖**：测试中零注入的一律删除，包括 `configConcurrencyHotApply`、`taskRouteLaunch`、`memoryDistillQueries`、
  `digitalEmployeeAgentTemplates`、`taskArchiveMaintenance`、`codeHistoryQueries`、`authRuntime`、`healthDatabase`、`webhookTerminalControl`、
  `digitalEmployeeEventCenter`、`memoryOperations`；实施时 grep 复核。
- **保留为显式测试口**：仍有测试注入的接缝，包括 `systemOperations`、`buildScheduleLaunch`、`workflowExactOperationHook`、`codeHostFetch`、
  `webhookDispatcher`、`maintenanceStatus`、`databaseTelemetry`、`daemonRuntime`。

### 2.4 仅测试 lane 的语义变化

- **webhook 派发器**：SQLite 测试 lane 从此总有派发器（取集成模块组成员，与 PostgreSQL lane 和生产一致）。
  `T/rfc257-webhook-error-codes.test.ts:434-448` 的「缺 dispatcher」单引擎用例，改为注入一个不支持 `dispatchSubscription` 的派发器，
  保留该分支的覆盖。
- **`core.identityAccess`**：取模块组原值，不再额外包一层；夹具与 MCP 只用 `directAuthority`。
- **`databaseMigration`**：见 §2.2，测试路径补缺省模块。

## 3. 失败模式

- 漏传某个托管选择，单机会退回本地实现，与现状相同；中立函数对每项选择缺省为本地实现。
- 热应用作用域与调度器不同源，会导致改并发设置不生效：由 `T/rfc266-concurrency-hot-apply.test.ts` 的双 lane 行为用例锁定。

## 4. 守卫与账本（实施时同提交修订）

- **不得违反**：
  - `T/architecture/rfc380-daemon-module-bundles.test.ts` 的 `ROOTS` / `FACTORIES` / `??` 规则：中立函数不调模块组，所用 owner 工厂都不在
    `FACTORIES` 名单内；
  - `T/architecture/rfc349-provider-cutover.test.ts:313-321`：`composeProviderAppDeps` 体内不得出现 provider 工厂名；
  - `T/rfc349-daemon-provider-core.test.ts:269-294`：切片锚点；删除 `composePostgresqlAppDeps` 时随之改锚点；
  - `T/rfc370-v9-sqlite-root-selections.test.ts:23-29`：S 不写 `input.<托管键>`。
- **精确账本**：
  - commons-debt R1：P 的 `memory/public/catalog`、`system-operations/application/overview` 两条消失；
  - `T/rfc305-architecture-lock.test.ts` 的 identity-access 清单：P 三行；
  - `T/architecture/rfc359-converged-twins.test.ts`：两个白名单剪掉 P；
  - `T/architecture/rfc359-w5-same-file-provider-pairs.test.ts:119`：销账；
  - `T/architecture/rfc359-w5-adapter-production-consumer.test.ts`：语料下限下调；
  - `T/rfc364-diagnostics-bindings.test.ts`；
  - guard-manifest。
- **文本 / AST 钉子**：研究清单约 40 个文件，改指新位置，不放宽断言意图。
  - 例：`T/rfc266`、`rfc319-cfg45`、`rfc317-work-start-bind`、`rfc339`、`rfc344`、`rfc345`、`rfc346`、`rfc349` 系、`rfc364`、`rfc372`
    及其 helper、RFC-370 根绑定族；
  - RFC-370 根绑定族里钉 S 旧实参的那些，多数钉的是「死转发」，应改指模块组调用或中立函数的实参。

## 5. 测试策略

1. 既有 HTTP 双引擎用例全部通过，不改断言意图；路由面一致性守卫（`T/architecture/rfc359-w5-composition-root-route-surface.test.ts`）照常通过。
2. 维护状态（双引擎）：SQLite 带 `database.provider === 'sqlite'`，PostgreSQL 带 `'postgresql'`；以「旧接线」对照显示 SQLite 原先不带。
3. 热应用（双 lane）：改并发设置后，调度器读到的池随之变化（`T/rfc266` 已有，改指新接线）。
4. 结构锁（新守卫，登记 guard-manifest）：
   - 三个调用方各恰好一次调用中立函数与 `composeProviderAppDeps`；
   - V 不再有 `composeSqliteApiRouteMounts` / 第二份公共路由表 / `composePostgresqlAppDeps`；
   - `mount*Routes(` 只出现在 `composeProviderAppDeps` 与请求管线里；
   - P 不再构造 HTTP 专用 owner。
5. `T/rfc257` 的「缺 dispatcher」用例按 §2.4 改写。
6. 文档：`docs/dev-gotchas.md` 中「改 server.ts 必须跑 W29 摘要守卫」两段已过时，删改；`:8752` 补「HTTP 绑定已中立」。

## 6. 与 RFC-294 目标架构的对齐

两种 provider 的 HTTP 装配合为一个中立函数，provider / 部署差异只作为输入进入，达成 S2b「一张 provider-neutral 图」的 HTTP 部分。
留下的债：
- 模块组构造与启动步骤仍在两个会话里各写一份（RFC-391）；
- 装配暂居 `server.ts`（RFC-391 迁入 `bootstrap/`）；
- 测试回退与 `createApp(AppDeps)`（RFC-392）。

无偏离项。
