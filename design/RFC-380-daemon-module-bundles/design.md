# RFC-380 设计：守护进程模块组

基线 HEAD `8194c30dc`。`S:` = `packages/backend/src/cli/start.ts`（SQLite 会话组合 `composeSqliteProviderSession` S:2162-2408 之后的主体，
PostgreSQL 会话组合 `composePostgresqlProviderSession` S:740-1411），`V:` = `packages/backend/src/server.ts`（`composeSqliteApplicationDeps`
V:2272-2883、`composeSqliteApiRouteMounts` V:3062-4293、两个 provider 核心 V:770-894），`P:` = `packages/backend/src/cli/postgresqlDaemonApplication.ts`
（`composePostgresqlApplication` P:718-2891），`T/` = `packages/backend/tests/`；其余路径相对 `packages/backend/src/`。行号仅作定位提示。

## 1. 现状（只列本 RFC 范围）

### 1.1 provider 核心

- SQLite S:2244-2270 调 `composeSqliteDaemonProviderCore`（V:770-831），PostgreSQL P:785-815 调 `composePostgresqlDaemonProviderCore`（V:834-894）。
- 两者成员逐项同构（同一实现或别名：工作区存储 / 运输凭据仓库 `modules/source-control/composition.ts:59-69`，认证运行时
  `createPostgresqlAuthRuntime` 直接返回 `createAuthRuntimeFor` `auth/composition.ts:43-49`），只有 `systemOperations`
  （`composeSystemOperations` / `composePostgresqlSystemOperations`）与 `maintenanceDisk` 按 provider 不同。
- PostgreSQL 在 P:990-991 另建工作区存储与运输凭据仓库，核心里的那份无人使用。
- SQLite HTTP 在 V:2846-2850 无条件另建 `composeLocalHttpAuthentication(...)`（即 `createLocalHttpAuthentication` 的别名，
  `modules/identity-access/composition/authentication.ts:10`），核心的 `httpAuthentication`（V:803）在 SQLite 无人使用；令牌审计读取
  走 `services/tokenAudit` 门面（V:4263、V:4279），PostgreSQL 走 `core.tokenCallAudit`（P:2572、P:2587）。写入两边都已走核心实例。

### 1.2 仓库凭据组

S:2271-2312 构造运输模块、代码托管连接、端点发现、发布运输、流水线证据运行器、开发交付；S 只把核心与发布运输传给 V（S:3490、
S:3511）。V 的 `composeRepositoryBootstrap`（V:2004-2080）因此重建代码托管连接（V:2025）、开发交付（V:2037）、流水线证据（V:2041）、
端点发现（V:2049，生产无人使用），V:3311-3316 另建工作区准备。运输模块在 V:2021 经按 (repository, secretBox) 的 WeakMap 缓存命中 S 的实例。
P:994-1028 构造同一组（基于它另建的存储与仓库）。所有成员无状态。`composeSqliteUncredentialedDevelopmentDeliveryProvider`
（V:1956-2002）只在 `deps.repositoryTransport === null` 时可达，无调用方这样做。

### 1.3 资源目录组

| 工厂 | S | V（生产状态） | P |
| --- | --- | --- | --- |
| `composeResourceCatalogFor` | 2314 | 2699 重复；2591 另一实例（只用 grants）；2409 生产跳过 | 841 |
| `composeClassicCatalogs` + `createAsyncSkillRestoreMembership` | 2318-2328 | 2703-2711 重复 | 870-880 |
| `composeSkillCatalogBoot` | 2755-2758 | — | 827-830（恢复之后） |
| `composeMcpProbeStore` / `composeMcpCatalog` / `createMcpTransactionLifecycle` | 2810-2828 | 2714-2732 重复 | 881、942-959 |
| `composePluginCatalog` / `composeWorkgroupCatalog` | 2831-2838 | 2733-2744 重复 | 960-969 |
| `composeCapabilityTemplateOperations` | 2856-2859（`resourceCatalog.authorization`） | 3789-3792 重复（旧 WeakMap ACL） | 1052-1065 |
| 开发适配器 / 开发配置 | 2876-2885 | 2588-2597 重复（旧 ACL；配置访问对象共 3 个） | 1947-1960 |
| `composeForeignResourceAclFor`（开发适配器 + 三个 employee_*） | — | 1853-1856、3899-3911 | 1952-1955、2073-2085 |
| `composeDigitalEmployeeAgentTemplateCatalogFor` | 2759-2762 | 3334-3339（`??` 回退，S 从不注入，故重复） | 970-973 |

所有工厂接受 `ProviderNeutralDatabase`，无实例状态、定时器或订阅。旧 WeakMap ACL（`modules/resource-catalog/composition/resourceAcl.ts`）
与 `resourceCatalog.authorization` / `.acl` 由同一组应用与端口构成，读、判定、错误与 404 形状逐项相同（研究记录逐站核对）；
**唯一差别**：旧 `updateResourceAcl`（`composition/resourceAcl.ts:197-218`）在提交后追加 `triggerRevalidation('resource-acl-changed')`，
`resourceCatalog.acl.updateResourceAcl`（`application/resourceAcl.ts:213-221`）只执行调用方给的 `afterCommit`，P（P:1077-1084、P:2121-2138）
没有给，所以 PostgreSQL 修改能力模板与四个开发配置自有类型的 ACL 后不推送。

### 1.4 观测 / 系统 Agent / 运行时管理

| 项 | S | V | P |
| --- | --- | --- | --- |
| `composeRunObservationCalls` | 2434 | 2448 无人使用；3108 重复 | 1165 |
| `composeSystemAgentObservations` | 2435 | 2447 无人使用；3107 重复 | 1166 |
| 运行族：记忆 / 意图分派 / 叙事 / 意图 HTTP | 2340-2345（尊重选择）、3966-3969（只用本地） | 2450-2453 无人使用；3110-3113、3854-3857（只用本地） | 845-850、2237-2242、1484-1489、2266-2271（都尊重选择） |
| MCP 运行时测试（有状态：队列、控制器、定时器） | 2766-2809，注入 V | 2642-2698 生产跳过 | 882-941 |
| 运行时管理 | — | 4005-4019 | 2350-2364 |
| 工作区在场 | 2433（忽略 `input.workspacePresence`） | 2323 生产跳过 | 739（尊重选择） |
| `createRuntimeSessionLeaseOperations` | 2338 | 2115、2384 跳过；3136、3197（每次仓库准备重试）、3996 重复 | 2773 |

### 1.5 记忆组

记忆运营 / 注入查询 / 记忆目录：S:2337-2360；V:2347-2348、2454-2481 都是生产跳过的回退；P:851-869（注入查询走默认值，
`providerRuntime.ts:538` 另建一份）。

## 2. 模块组构造函数

新目录 `cli/daemonModules/`（文件名不以 `sqlite` / `postgresql` 开头，函数名不含 `Sqlite` / `Postgresql`）：

| 文件 | 函数 | 输入（要点） | 输出 |
| --- | --- | --- | --- |
| `providerCore.ts` | `composeDaemonProviderCore` | 现有 `DaemonProviderCoreCommonInput`（V:698-715）+ `db` + `adapters: DaemonProviderCoreAdapters`（`systemOperations`、`maintenanceDisk`） | 现有 `SelectedDaemonProviderCore`（类型随文件迁来，V 与 P 以 `import type` 引用） |
| `repositoryCredentials.ts` | `composeDaemonRepositoryCredentials` | `db`、`secretBox`、`appHome`、核心的存储 / 操作 / 运输仓库、`developmentPurposeRoot`（由根构造后传入）、可选的托管选择（发布运输、工作区准备）与测试接缝 `codeHostFetch` | 运输模块（恒非空）、代码托管连接、端点发现、发布运输、开发交付、工作区准备 |
| `resourceCatalog.ts` | `composeDaemonResourceCatalogModules` | `db`、`skillContentRoot`、`skillContent`、`pluginInstaller`、`runtimeProfiles`、`mcpRuntime`（指向根持有的 MCP 运行时测试的惰性端口） | §1.3 全部实例 + 能力模板 ACL 绑定 + 开发配置 ACL 路由绑定（取代 V:1847-1882 与 P:2099-2141） |
| `observation.ts` | `composeDaemonObservationModules` | `db`、`appHome`、`configuration`、核心的身份访问与运行时注册表、`mcpCatalog` 惰性端口、`adapters`（运行族、MCP 诊断、运行时管理、工作区在场）、测试接缝 | 调用记录、系统 Agent 观测、四个运行族（各自配对的 binding）、工作区在场、运行时会话租约、MCP 运行时测试、运行时管理 |
| `memory.ts` | `composeDaemonMemoryModules` | `db`、`nodeRunPrompts`、记忆运行族 binding、身份上下文、`reviewedArtifacts` 惰性读取 | 记忆运营（显式传注入查询）、注入查询、记忆目录 |
| `adapters.ts` | `DAEMON_PROVIDER_CORE_ADAPTERS`、`standaloneModuleAdapters()` | — | provider 核心适配器表（`satisfies Record<DatabaseProvider, …>`，各根按自己的键取用）；单机适配器（本地运行族、本地 MCP 诊断、本地运行时管理、文件工作区在场） |

规则：

- **调用位置**：SQLite 会话组合与 `composePostgresqlApplication` 各调用每个函数一次（按会话，不进 `startCommand`）；SQLite 把实例经
  `composeSqliteAppDeps` 的新字段注入 V。V 只在回退中调用同一函数（`deps.x ?? composeDaemonXxx(...)`），测试直接 `createApp` 时仍可用。
- **顺序**：数据库客户端与 secretBox → `developmentPurposeRoot` → realtime 策略（只建闭包）→ 核心 →（PostgreSQL：待应用恢复，
  位置不变）→ 观测组 → 资源目录组 → 仓库凭据组 → 记忆组 → 其后的任务执行等消费者。惰性边保持为对稍后 `const` 的闭包：realtime 策略 →
  资源目录 / 记忆目录；MCP 诊断 ↔ MCP 目录；记忆 → 协作上下文；运行族的 `observations` / `appHome` getter。
- **托管选择**：PostgreSQL 根以 `input.x ?? standalone.x` 组成适配器；SQLite 根只用 `standaloneModuleAdapters()`，不读托管选择。
- **构造无副作用**：函数内不执行 SQL、不启动定时器、不做初始化（RFC-379）；`applyPendingRestore` 与启动对账留在原处。

## 3. provider 核心适配器

```ts
export const DAEMON_PROVIDER_CORE_ADAPTERS = {
  sqlite: (input: { db; appHome; dbPath; lockPath; secretBox }) => ({ systemOperations, maintenanceDisk }),
  postgresql: (input: { db; runtime; databaseConfig; databaseBackup?; appHome; lockPath }) => ({ systemOperations, maintenanceDisk }),
} satisfies { readonly [P in DatabaseProvider]: (input: CoreAdapterInput[P]) => DaemonProviderCoreAdapters<P> }
```

各根以确定的键取用（`DAEMON_PROVIDER_CORE_ADAPTERS.sqlite(...)`），不比较 provider 名（`T/architecture/rfc359-w5-t19-provider-branch.test.ts`
的 `PROVIDER_BRANCH_DEBT = []`）。`systemOperations` 需要核心先建好的 `repositoryWorkspaceOperations.backupPreparation`，适配器以函数形式
接收它。

## 4. 规则统一

### 4.1 HTTP 认证与令牌审计

- V 的认证改为 `deps.providerCore?.httpAuthentication ?? composeLocalHttpAuthentication(...)`。等价依据：两者都是
  `createLocalHttpAuthentication`，只读 `auth`、`daemonToken`、`identityAccess.directAuthority`、`now`
  （`modules/identity-access/infrastructure/local/httpAuthentication.ts:38-83`）；SQLite 两边拿到的是同一 `authRuntime`、同一 token、同一
  `directAuthority` 引用，都不传 `now`；唯一的实例状态（并发请求合并）前后都只有一个实例在用。
- 令牌审计读取改为 `deps.core.tokenCallAudit.listForUser(id)` / `.list()`（与 P:2572、P:2587 相同）。等价依据：门面每次构造的参与者与
  核心实例用同一持久化、同一排序与缺省上限（`auth/application/tokenCallAudit.ts:197-198`），返回相同行。
- 门面 `listTokenAudit` / `listTokenAuditForUser` 失去生产调用方后删除，`T/rfc247-token-audit.test.ts` 与
  `T/rfc349-auth-token-audit-provider.test.ts` 改走核心实例。

### 4.2 资源目录自有类型的 ACL 写入

在资源目录模块内提供带通知的写入口（例如 `composeOwnedResourceAclEndpoints(resourceCatalog)`，放在
`modules/resource-catalog/composition/resourceAcl.ts`，使「通知属于 ACL 写入本身」继续成立），能力模板与开发配置四个自有类型
（action_template、verification_profile、digital_employee、automation_policy）的 ACL 更新都经它提交并触发
`triggerRevalidation('resource-acl-changed')`。V 与 P 的 ACL 路由绑定改用它；`T/rfc212-revalidation-behavior.test.ts` 的写入点清单加入它。
旧 WeakMap ACL 模块保留（技能目录与任务执行启动操作仍在用，见研究记录）。

### 4.3 仅托管选择项

`HOSTED_ONLY_SELECTIONS`（S:1518-1541）增加 `credentials`、`systemAgentRunFamily`、`workspacePresence`。SQLite 根改为不读取它们：
核心的 `credentials` 用本地凭据适配器，运行族与工作区在场用 `standaloneModuleAdapters()`。`T/rfc370-v9-sqlite-root-selections.test.ts`
随之覆盖三项。

## 5. server.ts 的改造

- `AppDeps` 增加五个模块组的注入字段（命名避开已有的选择字段，例如已有的 `runtimeManagement` 是工厂选择而非实例）。
- `composeSqliteApplicationDeps` / `composeSqliteApiRouteMounts` 中 §1 列出的无条件构造与重复构造改为使用注入实例；回退分支调用同一
  构造函数；删除无人使用的实例（V:2447-2453、V:2049 的生产路径等）。
- `server.ts` 可以值导入 `cli/daemonModules/*`；`cli/daemonModules/*` 不得值导入 `server.ts`、`cli/start.ts`、
  `cli/postgresqlDaemonApplication.ts`（`architecture/counts.json` 的 `backend-value-scc` 为 0）。`composeDevelopmentPurposeRoot` 留在
  `server.ts`，由根构造后作为值传入。

## 6. 架构约束

- 新文件加入 `T/architecture/census.ts` 的 `BOOTSTRAP_FILES`（否则对 `modules/*/composition` 的引用都计为 R1 新边，R1 与
  `architecture/commons-debt.json` 双向精确）；类型只从 `composition/*` 或精确的 `public/*` 入口取（R1 也计类型边）。
- 有精确导入方账本的入口：只有 `providerCore.ts` 引用 `identity-access/composition`（`createIdentityAccessRuntime` 等），并加入
  `T/rfc305-architecture-lock.test.ts` 与 `T/rfc347-identity-access-runtime.test.ts` 的清单；其余新文件不引用 identity-access，访问对象的
  类型用 `@/auth/actor` 的 `Actor`。开发配置只经 `composition/configOperations` 子路径引用（`T/rfc310-architecture-lock.test.ts`）。
- 不放在 `bootstrap/`（RFC-376 G9）；不 import `resolveDatabaseProviderRuntime` / `resolveDatabaseProviderSelection`
  （`T/rfc349-provider-cutover.test.ts` 的 `PROVIDER_SELECTION_SITES`）；新文件无占位持有者与 `not-bound` 标记（`rfc359-w5-t19b`）。
- `architecture/counts.json` 不升；删除的 R1 边从 `commons-debt.json` 删除（两向精确）。

## 7. 旧锁处置

| 测试 | 处置 |
| --- | --- |
| `T/rfc349-daemon-provider-core.test.ts` | 改为构建 `composeDaemonProviderCore` 的两个适配器；`:214-230` 的文本锁改指 `postgresql` 适配器项（不执行 SQL、无 `runtime.close`） |
| `T/architecture/rfc359-w5-same-file-provider-pairs.test.ts` | 删除 `server.ts::composeDaemonProviderCore` 行 |
| `T/architecture/rfc359-w5-identical-provider-twins.test.ts` | 语料下限按实际下调（只降） |
| `T/architecture/rfc359-w5-adapter-production-consumer.test.ts` | `createPostgresqlAuthRuntime` 删除后无死适配器 |
| `T/rfc349-frozen-source-request-writes.test.ts:163-170` | 改锚到新的核心调用 |
| `T/rfc346-system-operations-contracts.test.ts:315-316` | 计数改指 `providerCore.ts` 的适配器表 |
| `T/rfc347-identity-access-runtime.test.ts:260-284` | 文件清单加入 `providerCore.ts`（`server.ts` 回退仍在） |
| `T/rfc321-repository-publication-ratchet.test.ts` | 构造文本锁改指 `repositoryCredentials.ts`；根中保留局部名 `repositoryPublicationTransport` 与内联的对账调用 |
| `T/rfc359-w4-d14/d15/d16/d17/d18-adapters.test.ts`、`T/rfc349-resource-catalog-classic-postgresql-adapters.test.ts`、`T/rfc353-skill-restore-membership.test.ts` | 正向断言改指 `resourceCatalog.ts`；负向断言扩到新文件 |
| `T/rfc370-skill-content-root-wiring.test.ts`、`T/rfc370-plugin-installer-roots.test.ts`（AST） | 改为断言根把选择交给共享函数、共享函数恰有一次调用 |
| `T/rfc359-t7d-postgresql-skill-catalog-boot.test.ts` | 顺序锚改为资源目录组的调用在 `applyPendingRestore()` 之后 |
| `T/rfc345-classic-facade-provider-neutralization.test.ts`、`T/rfc359-w4-d6c-adapters.test.ts`、`T/rfc349-postgresql-daemon-system-identity.test.ts` | 文件清单加入新文件 |
| `T/rfc364-diagnostics-bindings.test.ts` | `composeLocalMcpDiagnostics` 的调用断言改指 `adapters.ts` / `observation.ts`；V 保留回退 |
| `T/rfc370-node-run-prompt-bindings.test.ts:672-833` | 改断言 `composeDaemonMemoryModules({ nodeRunPrompts })` |
| `T/rfc212-revalidation-behavior.test.ts` | 写入点清单加入 §4.2 的写入口 |
| `T/architecture/census.ts`、`architecture/commons-debt.json` | 新文件入 `BOOTSTRAP_FILES`；随删除的边删除账本行 |

根中尽量沿用现有局部名（`repositoryPublicationTransport`、`skillCatalogBoot`、`mcpRuntimeTests`、`memoryOperations`、`core` 等），
减少文本锁改动；改不了的锁按上表改指，不放宽意图。

## 8. 测试策略

1. 每个构造函数的单测：输出成员齐全、冻结、构造期不执行 SQL / 不起定时器；provider 核心两个适配器的成员集合相同。
2. 结构锁（新增 `T/architecture/rfc380-daemon-module-bundles.test.ts`，RFC-376 硬门格式并登记 guard-manifest）：S 与 P 各调用五个
   构造函数恰好一次；V 只在 `??` 回退中调用；被收进构造函数的底层工厂不再在 S、V、P 中直接调用。
3. 行为：SQLite 生产形状下 V 使用注入实例（例如 HTTP 认证即核心实例、资源目录即会话实例）；双引擎 HTTP 套件
   （`rfc247-token-audit`、`rfc370-http-authentication-adapter`、`rfc359-w5-composition-root-route-surface`）不改即通过。
4. §4.2：双引擎用例——能力模板与四个开发配置自有类型的 ACL PUT 触发 `resource-acl-changed` 再验证。
5. §4.3：SQLite 根收到三项新增的仅托管选择即拒绝。
6. 既有套件不改即通过（除 §7 列出的锁）。

## 9. 与 RFC-294 目标架构的对齐

- 承担的演进：S2b 第一批——同构模块组单一构造、SQLite 进程内去重、provider 专属核心装配函数退役。
- 偏离项：构造函数放 `cli/daemonModules/`（同 RFC-379），S2c 迁入 `bootstrap/`。
- 留下的债：集成 / 定时任务 / 融合（RFC-381）；任务执行、数字员工、开发自动化、意图（RFC-382）；SQLite HTTP 装配并入中立挂载表与
  回退删除（RFC-383）；`profile` 与 `cli/` → `bootstrap/`（S2c）。
