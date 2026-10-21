# RFC-392 设计：统一测试入口

研究基线 HEAD `b1799e6bc`（行号以实施时源码为准）。缩写：

- `V:` = `server.ts`
- `G:` = `bootstrap/daemonApplication.ts`
- `GS:` = `bootstrap/daemonSession.ts`
- `GA:` = `bootstrap/daemonSessionAdapters.ts`
- `H:` = `tests/helpers/providerHttpApplication.ts`
- `B/x` = `cli/daemonModules/x.ts`
- `T/` = `packages/backend/tests/`

其余路径相对 `packages/backend/src/`。研究笔记见本会话 2026-10-21 的只读研究（121 个候选测试逐文件分类）。

## 1. 现状

### 1.1 `server.ts` 的 SQLite 测试路径（生产零调用者）

| 符号 | 位置 |
| --- | --- |
| `AppDeps`（85 字段，其中 61 个与应用图输入同名、24 个独有） | V:391-593 |
| `RuntimeDiagnosticTestDependencies`（与模块类型逐字段相同的重复） | V:376-389 |
| `withIntegrationTriggerResources` | V:599-605 |
| `SqliteAppComposition` | V:727-751 |
| `composeSqliteAppDeps`（3 条重载） | V:1759-1765 |
| `composeSqliteApplicationDeps`（12 个模块组回退 + 12 个其他默认） | V:1767-2161 |
| `createApp(AppDeps \| ComposedAppDeps)` | V:2371-2375 |

另有：

- `composeProviderAppComposition`（V:1187-1684）及私有 `composeResourcePackageBinding` / `composeConfigConcurrencyHotApply`；
- `UnstartedApplicationScope`（V:1754-1757）；
- `composeDevelopmentPurposeRoot` 与 `assertPurposePair`（V:2396-2522）。

它们留在 V，只因测试路径还在用；生产由 G 调用。

### 1.2 两条测试 lane（H）

- **SQLite lane**：`composeSqliteApplicationDeps(deps, scope)`，再由 H 自己 `platformTools.load()` / `maintenance.ready()`。
- **PostgreSQL lane**：`composeDaemonApplication(…, { kind: 'unstarted', scope })`。

直接使用方：

- 约 23 个直接 `createApp(` 的用例；
- `T/contracts/harness.ts`、`T/helpers/routeOperationDispatcher.ts`；
- RFC-380～384 的 5 个注入边界用例；
- rfc349-platform-tools、rfc359-execution-contract。

### 1.3 接缝对照

- **G 已有的测试接缝**（7 个，生产不传）：`buildScheduleLaunch`、`runtimeDiagnosticTestDependencies`、`webhookDispatcher`、`mcpRuntimeTestDependencies`、
  `intentTestDependencies`、`workflowRuntime`、`opencodeVersion`。
- **兼作生产输入的**：`maintenanceStatus`、`daemonRuntime`、`executionAuthority`。
- **`AppDeps` 有、G 没有，仍有测试使用的三个**：`codeHostFetch`（rfc269、rfc321）、`webhookTerminalControl`（rfc300）、`systemOperations`（rfc370-m3、rfc370-v3）。
- **其余不需要接缝**：
  - `executionContracts`、`digitalEmployeePlatformTools`、`repositoryTransport`：与生产构造等价，改写用例；
  - `identityAccess`：只在 dispatcher 的零调用者形态里，删除；
  - 12 个模块组注入：只在 RFC-380～384 用例里，改写。

### 1.4 SQLite lane 改走图后的差异（全是向生产靠拢）

| 编号 | 差异 | 影响 |
| --- | --- | --- |
| 1 | 托管选择准入（G:455 → GA） | 只影响 `T/rfc370-m2-inventory-read-content.test.ts`（SQLite lane 传 `runtimeInventoryContent`） |
| 2 | 身份事件 / 在线投影真实触发 | PostgreSQL lane 早已如此 |
| 3 | `dbPath` / `lockPath` | H 显式传 `join(appHome, 'db.sqlite')` / `join(appHome, '.daemon.lock')` |
| 4 | `skillContentRoot` | scope 已把环境变量设为 appHome，实际无差别 |
| 5 | 驱动释放收尾 | 由 SQLite 专属的 `finishClaimedWebhookWorkspacePrune` 换为中立的工作区维护命令 |
| 6 | 直接用例新增未启动期初始化 | 事件目录写库、平台工具加载、数字员工 ready |
| 7 | `configPath: ''` 的 4 个用例 | rfc257、rfc269、rfc321、rfc359-exec 要改为临时路径（否则写进 cwd） |
| 8 | 返回形状不含 `ComposedAppDeps` | rfc349-platform-tools 的再挂路由断言、rfc380 的 `composed.authentication` 改写 |

## 2. 设计

### 2.1 统一入口（G1）

- H 只保留**一个** `composeDaemonApplication` 调用点。t19c 账本逐字钉着这一点。
- H 提供一个接收数据库绑定（harness 借出的连接与 provider 运行时句柄）的入口：
  - scope / topology / WS scope 经它装应用；
  - 原先直接 `createApp` 的用例也改经它。
- H 为 SQLite 绑定提供 `telemetry`、`dbPath`、`lockPath`、临时 app home；为两种 provider 映射平铺的测试输入到 `testSeams`。
- `routeOperationDispatcher` 与 `contracts/harness` 改经 H。
- `T/helpers/runtimeOpencodeFixture.ts` 改引用模块里的 `RuntimeDiagnosticTestDependencies`。

### 2.2 删除测试路径（G2）

- 删除 §1.1 表中全部测试路径符号、只为它们存在的导入（约 57 处），以及 dispatcher 的 `AppDeps` 形态。
- `createComposedApp(ComposedAppDeps)` 保留：生产用它。

### 2.3 测试接缝收拢与死接缝（G3）

- **`testSeams`**：G 的输入新增 `testSeams?: {…}`，原 7 个测试接缝与新增的 3 个都在其中：
  - `codeHostFetch`：转发到仓库凭据组与 `ProviderAppOwnerInput.testSeams.codeHostRuntime`；
  - `webhookTerminalControl`：转发到集成组的 adapter；
  - `systemOperations`：在核心组装配后覆盖核心组的系统运维实例，类型取 `SelectedDaemonProviderCore<P>['systemOperations']`。

  GS 调用 G 时不得出现 `testSeams`（结构锁）。
- **默认值改必填**：G 中只服务测试的默认改为必填，生产 GS 总是传入。
  - G:456 `log`；
  - G:491-506 `applicationConfiguration` / `taskLaunchConfiguration`；
  - B/providerCore.ts:159 `sourceWriteWindow`。
- **死接缝**：模块组里只为测试路径存在或已无人传入的 `adapters.*` / `testSeams` 字段删除（研究 §1.3 清单，实施时 grep 复核）。
  同步改钉着它们的测试，例如 `T/rfc321-repository-publication-ratchet.test.ts`。

### 2.4 HTTP 组合迁入 `bootstrap/`（G4）

- **新文件**：`bootstrap/daemonHttpComposition.ts`（名称可调，不得以 provider 名开头）。
  - 承接 `composeProviderAppComposition`、`ProviderAppOwnerInput`、`ProviderAppComposition` 与两个私有助手；
  - 只类型依赖 V（路由组合类型），V 不导入 `bootstrap/`；
  - **不得**并进 G：rfc390 的 `HTTP_OWNERS` 与 rfc266 / rfc345 的断言要求 G 不含这些工厂。
- **`UnstartedApplicationScope`**：迁入 G。
- **开发用途**：
  - `composeDevelopmentPurposeRoot` / `assertPurposePair` 迁入 `bootstrap/` 的独立文件；
  - `DevelopmentPurposeSelection` / `SelectedDevelopmentPurposeRoot` 等类型迁入 `@/modules/development-automation/composition`
    （`cli/start.ts`、模块组与 G 都已导入该 composition，不新增边，不触发部署分支门）。
- **`readDaemonGraphSource()`**（`T/helpers/daemonGraphSource.ts`）：不纳入新的 HTTP 组合文件，避免「图源码不含 X」类断言误红；需要读新文件的钉子单独读取。
- **V 之后的内容**：路由组合类型、`freezeComposedAppDeps`、`composeProviderAppDeps`、`mountApiRoutes`、`createHttpRequestApp`、`createComposedApp`，
  以及仍被引用的少量类型（如 `IntegrationTriggerIdentityAccess`）。

## 3. 测试策略

1. 既有 HTTP 双引擎用例全部通过，不改断言意图；路由面一致性守卫以双 lane 运行通过。
2. 改写用例（保持原意）：
   - RFC-380～384 注入边界用例：改为对 `composeProviderAppComposition({ modules })` 的注入断言，或图级同一性断言；
   - rfc349-platform-tools、rfc359-execution-contract：改为读图自己的参与者；按 t19f 能双引擎的顺势双引擎；
   - rfc370-m2：按 proposal §6 第 2 条处理；
   - rfc257 / 269 / 321 / 359-exec：`configPath` 改为临时路径；
   - 7 个只用 `AppDeps` 类型的用例改用 `Hono` 等实际类型。
3. 结构锁（新守卫，登记 guard-manifest）：
   - 被删符号不存在；
   - V 不调用模块组工厂、无 `deps.x ??`、不含 HTTP 组合函数与开发用途根；
   - 测试入口唯一（H 内恰一个 `composeDaemonApplication` 调用）；
   - GS 调用 G 时无 `testSeams`；
   - HTTP 组合文件不在 G 内。
4. 旧锁与账本（研究清单：392a 部分 73 个、392b 部分 36 个会红的文件，16 个重叠）：
   - 双根源码锁删掉 V 那一行，不放宽图那一行；
   - RFC-380 守卫：ROOTS 去掉 V，删「V 里模块组必须在 `??` 右侧」规则，期望调用数 24 → 12；
   - RFC-390 守卫：ROOTS 改为单根，owner 位置与锚点改读新文件；
   - t19b `NAMED_ROOTS`、t19c、t19f（失去「组合根」单引擎理由的迁双引擎）；
   - void-promise 账本（`server.ts: 2` → 1）、适配器生产消费者下限（实测下调并注明）；
   - commons-debt（R1 一条、TP-08、两个 baseline）与 RFC-317 findings.md；
   - converged-twins、rfc305 / rfc347 / rfc310 精确清单、`BOOTSTRAP_FILES`；
   - windows-platform 路径过滤。
5. 文档：`docs/dev-gotchas.md` 中描述 `server.ts` 测试回退与三个组合根的段落、`docs/audit-backlog.md` 中的相关引用，按新结构改写。

## 4. 与 RFC-294 目标架构的对齐

测试与生产同经 `bootstrap/` 的应用图，测试只通过图的 `testSeams` 注入实例（RFC-294 design §10），`server.ts` 成为 provider 无关挂载表。
S2b「每模块每进程构造一次、不存在 provider 专属装配函数、移除测试回退」全部达成。

留下的债：入口根瘦身与 `cli/` ↔ `bootstrap/` 互依（S2c）。无偏离项。
