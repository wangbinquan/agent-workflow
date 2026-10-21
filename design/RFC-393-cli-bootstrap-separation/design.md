# RFC-393 设计：`cli/` 与 `bootstrap/` 分离

研究基线 HEAD `2845ccb65`（行号以实施时源码为准）。路径相对 `packages/backend/src/`，`T/` = `packages/backend/tests/`。
研究笔记见本会话 2026-10-21 的四路只读研究（依赖边 AST 全表、77 槽清单、部署分支站点、测试影响逐文件分类）。

## 1. 现状

### 1.1 依赖边

| 方向 | 条数 | 位置 |
| --- | --- | --- |
| `bootstrap/ → cli/` | 36（19 值、17 类型） | `bootstrap/daemonApplication.ts` 15 值（13 个模块组、生命周期程序、实时策略）；`bootstrap/daemonHttpComposition.ts` 12 类型；`bootstrap/daemonSession.ts` 3 值 1 类型；`bootstrap/daemonSessionAdapters.ts` 1 值 3 类型；`bootstrap/crewstation.ts` 1 类型（`StartOptions`） |
| `cli/ → bootstrap/` | 1 值 | `cli/deployment.ts:7-10` → `bootstrap/crewstation.ts` |
| `server.ts → cli/` | 1 类型 | `server.ts:2-5` → `cli/daemonModules/providerCore.ts`（`DaemonProviderCore`、`SelectedDaemonProviderCore`） |
| `main.ts → cli/` / `bootstrap/` | 17 / 2 | 命令处理器、`start`、`dev`、`deployment`；`bootstrap/daemonSession.ts`、`bootstrap/workspaceTaskImage.ts`（动态） |

两个目录之间没有动态 import 或 `require`。被迁文件之间有 43 条相对 import，保持相对布局即不用改。

### 1.2 `cli/` 的 41 个文件

- **子命令处理器（15 个，留在 `cli/`）**：`auth`、`backup`、`config-cli`、`database`、`dbCompact`、`doctor`、`frameBackfill`、
  `migrationReport`、`package`、`restore`、`rfc295-downgrade-audit`、`status`、`stop`、`user`、`userBootstrap`。
- **迁入 `bootstrap/`（26 个）**：见 §2.1。机制文件只被 `bootstrap/` 与 `cli/start.ts` 使用，`modules/**` 对它们的引用为 0；
  留下的命令处理器 import 它们的边数为 0。

### 1.3 按路径钉住的守卫与清单

| 守卫 / 清单 | 现状 | 迁移后若不改 |
| --- | --- | --- |
| `T/architecture/rfc391-neutral-daemon-graph.test.ts` | 只检查 `cli/start.ts`、`cli/dev.ts` 的 import 声明不指向 `bootstrap/` | 静默失效 |
| G9（`T/architecture/rfc294Gates.ts` 的 `deploymentScope` 与 import 规则） | 作用域写死 `cli/(start\|dev)`；作用域内文件指向 `cli/deployment` 或 `bootstrap/` 即记一处 | 启动序列掉出作用域，`executionHost` 分支「合法消失」；迁入后若纳入作用域，它对 `bootstrap/` 的每条 import 都会被误记 |
| `T/architecture/rfc376-structural-guards.test.ts` | `KNOWN['deployment-mode-branch-sites']` 含 `cli/start.ts#startCommand#comparison#1`；变异 fixture 用 `cli/start.ts`、`cli/dev.ts`、`cli/deployment.ts` | 账本过期即红 |
| `T/architecture/rfc359-w5-t19b-composition-root-complete.test.ts` | 扫描面为 `cli/**` 与少数点名文件 | 迁入文件掉出扫描面，静默失效 |
| `T/architecture/rfc390-neutral-http-binding.test.ts` | 根清单含 `cli/start.ts`，文件缺失时 `continue` | 静默失效 |
| `T/architecture/rfc359-w5-t19c-startup-sequence.test.ts` | `DAEMON_ENTRY_FILES`、`serveDaemon @ …/cli/start.ts` 等 | 显式变红 |
| `T/architecture/rfc379-daemon-lifecycle-guard.test.ts` | `PROGRAM = cli/daemonLifecycleProgram.ts`，ROOTS 含 `cli/start.ts`、`cli/dev.ts` | 显式变红 |
| `T/architecture/rfc380-daemon-module-bundles.test.ts` | 只扫 `cli/daemonModules/` 前缀，且要求恰好 13 个文件 | 显式变红 |
| `T/architecture/census.ts` `BOOTSTRAP_FILES` | 17 个 `cli/` 路径 | R1 门出现新债行，逐条相等断言变红 |
| 其余精确账本 | `rfc349-provider-cutover`、`rfc385` / `rfc386` / `rfc388` 路径常量、void-promise 账本、`rfc305` / `rfc310` 消费者清单、RFC-310 OS 架构清单 | 显式变红 |
| 源码语料 helper | `T/helpers/daemonGraphSource.ts`（拼接 `cli/start.ts` 与三个图文件，顺序有语义）、`T/helpers/daemonProgramSource.ts` | 读不到文件 |
| workflow 路径过滤 | `windows-platform.yml`、`maintenance-soak-nightly.yml` 列有 `cli/start.ts`、`cli/daemonProviderRuntimeSession.ts`（由 `T/test-suite-policy.test.ts` 检查路径存在） | 显式变红 |

## 2. 设计

### 2.1 迁移清单（26 个文件）

| 旧路径 | 新路径 |
| --- | --- |
| `cli/daemonModules/*.ts`（13 个） | `bootstrap/daemonModules/*.ts` |
| `cli/daemonLifecycleProgram.ts` | `bootstrap/daemonLifecycleProgram.ts` |
| `cli/daemonProviderSession.ts`、`daemonProviderRuntimeSession.ts`、`daemonProviderRuntimeHandles.ts`、`daemonProviderRuntimeRouter.ts`、`daemonProviderMigrationAdmission.ts`、`daemonProviderBootstrap.ts` | `bootstrap/` 同名 |
| `cli/daemonRealtimePolicy.ts`、`cli/executionActivation.ts` | `bootstrap/` 同名 |
| `cli/start.ts` | `bootstrap/daemonStart.ts` |
| `cli/dev.ts` | `bootstrap/developmentReload.ts` |
| `cli/deployment.ts` | `bootstrap/deployment.ts` |
| `cli/migrate.ts` | `bootstrap/migrate.ts` |

- 文件内容只改 import 路径。被迁文件之间的相对导入保持原样，`start` 改名处的两处除外（`dev.ts`、`deployment.ts` 对 `./start` 的引用）。
- `bootstrap/deployment.ts` 对 `bootstrap/crewstation.ts` 的导入改为相对导入。
- `migrate.ts` 的命令输出语义不变，`main.ts` 照旧打印 `migrateForDeployment` 的结果。

### 2.2 类型落位

- 新建只含类型的 `bootstrap/daemonSessionInput.ts`，迁入 `DaemonProviderSessionComposeInput`、`ComposedDaemonProviderSession`、
  `DaemonProviderSessionComposer`。`bootstrap/daemonStart.ts`、`daemonSession.ts`、`daemonSessionAdapters.ts` 从这里导入。
- `StartOptions` 留在 `bootstrap/daemonStart.ts`；`crewstation.ts`、`deployment.ts`、`developmentReload.ts` 从 `./daemonStart` 导入。

### 2.3 `server.ts` 的结构合同

`server.ts` 删除对 `cli/daemonModules/providerCore.ts` 的类型导入，在本文件内按结构声明它用到的 core 合同：

- `AppHttpProviderCore`：今天是 `Pick<DaemonProviderCore, 'provider' | 'authRuntime' | 'tokenCallAudit' | 'identityAccess' | 'sourceWriteWindow'>`，
  改为逐字段声明，字段类型取各 owner 的公开类型或应用层类型；
- `ProviderComposedAppDeps`、`ProviderAppCompositionInput`、`composeProviderAppDeps` 改为按 core 类型参数化，参数约束为本文件声明的
  结构合同，覆盖挂载表实际读取的全部 core 字段。

`bootstrap/` 传入完整的 `SelectedDaemonProviderCore`，它是结构子类型。`server.ts` 仍不得导入 `bootstrap/`（RFC-392 结构锁），也不得导入 `cli/`。

### 2.4 `main.ts`

只改 import 路径：`startCommand` / `StartOptions` 来自 `@/bootstrap/daemonStart`，部署函数来自 `@/bootstrap/deployment`，
开发热重载来自 `@/bootstrap/developmentReload`。start 调用 `startCommand({ ...deployment, ...opts, ...development }, composeDaemonSession)` 原样保留。

### 2.5 G9 跟随迁移

在 `T/architecture/rfc294Gates.ts` 中：

- `deploymentScope` 把 `cli/(start|dev)` 换成 `bootstrap/(daemonStart|developmentReload)`；
- import 规则只对 `bootstrap/` 之外的作用域文件生效；目标模式去掉 `cli/deployment`，只留 `bootstrap/`；
- 比较、字面量、`case`、端口字面量等其余规则不变。

`rfc376-structural-guards.test.ts` 同步修改：

- `KNOWN['deployment-mode-branch-sites']` 把 `cli/start.ts#startCommand#comparison#1` 改为 `bootstrap/daemonStart.ts#startCommand#comparison#1`，总数仍为 6；
- G9 变异 fixture 改用新路径，并新增一条：`bootstrap/daemonStart.ts` 导入其他 `bootstrap/` 文件不记站点、出现模式比较照记。

### 2.6 目录级硬门

新增 `T/architecture/rfc393-cli-bootstrap-separation.test.ts`：

- 用 `createGateCorpus`（`rfc294Gates.ts`）的边集，断言以下三类边为零：
  - `src/cli/** → src/bootstrap/**`；
  - `src/bootstrap/** → src/cli/**`；
  - `src/server.ts → src/cli/** | src/bootstrap/**`；
- 断言 26 个旧路径都不存在、新路径都存在；
- 变异测试：两个方向各覆盖值导入、`import type`、行内 `type`、`export … from`、动态 `import()`、`require`、`import('x').T`，每条都必须红；
- 扫描全量生产语料，设语料文件数下限；登记 `architecture/guard-manifest.json`。

`rfc391-neutral-daemon-graph.test.ts` 删去「CLI imports bootstrap」检查及其 fixture，其余断言不变。

### 2.7 其余守卫、账本与清单

| 对象 | 修改 |
| --- | --- |
| t19b | 扫描面纳入迁入 `bootstrap/` 的文件，不得因换位置而缩小 |
| t19c | `DAEMON_ENTRY_FILES` 与入口计数改指新路径；`main.ts` 的 start 字面量不变 |
| RFC-379 | `PROGRAM`、ROOTS 改指新路径 |
| RFC-380 | 前缀改为 `bootstrap/daemonModules/`，仍恰好 13 个文件；生命周期程序路径同步 |
| RFC-390 | 根清单改指新路径；目标文件缺失时报错，不再跳过 |
| RFC-392 | `server.ts` 不导入 `bootstrap/` 的检查保留 |
| `rfc349-provider-cutover`、`rfc385` / `rfc386` / `rfc388`、void-promise 账本、`rfc305` / `rfc310` 消费者清单 | 路径改写，条目数不变 |
| `census.ts` `BOOTSTRAP_FILES` | 17 个 `cli/` 路径改为新路径，加入 `bootstrap/migrate.ts` |
| `architectureReport.ts` `LEGACY_BACKEND_FILE_OWNERS` | 迁入文件按 `bootstrap` 登记（含此前未登记的 13 个模块组） |
| `architecture/commons-debt.json` | `cli/migrate.ts` 的两条 R1 债删除（迁入 `bootstrap/` 后合法），inbound 基数随之下降并在 note 中注明；registeredFindings 中指向 `cli/start.ts` 的锚点与说明改为新路径 |
| RFC-310 `os-architecture-manifest.json` | `cli/daemonModules/{digitalEmployee,integration,resourceCatalog}.ts`、`cli/start.ts` 改为新路径 |
| `T/helpers/daemonGraphSource.ts`、`daemonProgramSource.ts` | 改指新路径，拼接顺序不变 |
| `.github/workflows/windows-platform.yml`、`maintenance-soak-nightly.yml` | 路径过滤改为新路径 |

### 2.8 测试改写

约 120～137 个测试文件需要改 import 或源码路径字面量，其中约三分之二是机械替换。只改路径，不改断言意图；
锁定 `opts.<槽>` 形状的用例原样保留，由后继类型化 profile 的 RFC 改写。

## 3. 测试策略

1. 新硬门的正例：真实语料零边。负例：两个方向、七种语法的变异 fixture 必须红。
2. G9 正例：迁移后账本恰为 6 条（含新 id）。负例：在迁入的启动序列里加模式比较必须记站点；`bootstrap/` 内部 import 不记站点。
3. 被改指路径的守卫：每个都确认读到的是新文件，缺失即红。
4. 行为：后端 SQLite 全量；PostgreSQL 补跑覆盖改动过的 PG 用例与守护进程用例；双 lane 跑路由面一致性、性能守卫与 RFC-379～393 守卫。

## 4. 与 RFC-294 目标架构的对齐

`bootstrap/` 拿到 design §2 列出的全部职责：唯一模块工厂图、部署选择点、生命周期程序、启动序列与开发热重载。
`cli/` 只剩入站子命令适配器。`server.ts` 只依赖模块合同。S2c 退出门中「`cli/` ↔ `bootstrap/` 不互相依赖」一项由本 RFC 达成。

留下的债：

- `StartOptions` 与三层逐字段转发、启动序列的 `executionHost` 分支、端口上的部署字面量、`main.ts` 自装配的命令依赖：S2c 后继 RFC；
- `cli/` 命令处理器最终是否并入各模块的 `inbound/cli`：不在 S2c 范围。

## 5. 风险

- **静默失效**：按路径写死的检查若漏改，会在不报红的情况下失去覆盖。§2.7 逐个改指，并让 RFC-390 等跳过缺失文件的检查改为报错。
- **G9 误记**：启动序列纳入作用域后，它对 `bootstrap/` 的 import 若仍按原规则计入，账本会膨胀。§2.5 限定 import 规则只看 `bootstrap/` 之外的文件。
- **并发冲突**：`bootstrap/daemon*.ts`、`server.ts`、`main.ts`、`T/architecture/*` 与大批 rfc370 根接线测试是多个 RFC 的共同改动面。
  本 RFC 与 S2c 后继 RFC 串行。
