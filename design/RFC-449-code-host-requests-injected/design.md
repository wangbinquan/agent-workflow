# RFC-449 技术设计

路径缩写：`S` = `packages/backend/src`，`T` = `packages/backend/tests`，`TE` = `S/modules/task-execution`，`DA` = `S/modules/development-automation`。
以 RFC-448 落地后的源码（`0cd746750`）为准。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：task-execution 的 `application/ports`（端口）、`composition`（运行时选项、参与者与节点端口装配）、`infrastructure`
  （运行时参与者）；development-automation 的 `infrastructure`（交付 provider）。
- **承担的演进**：W4 B / D 的准备步：task-execution、development-automation 对 `services/codeHost/*` 的依赖清零，后继 RFC-450 把该家族迁入
  integration 时不产生 DAG 外的边。
- **不新增**任何跨 context 边：新端口都在各自模块内；装配根与测试拓扑是唯一把 legacy 实现接进来的地方。
- **留下的债**：`services/codeHost/*` 仍在 legacy（RFC-450）；两个路由（RFC-450）；`cached-repos`、`tasks`。
- **偏离项**：无。

## 1. 端口

- `TE/application/ports/codeHostNodeExecution.ts`：
  - 新增 `CodeHostConnectionResolver { resolve(provider: CodeHostProvider): Promise<CodeHostNodeConnection | null> }`；
  - `CodeHostRequestPort`（已有）不变。legacy 的 `ResolvedCodeHostConnection` 多一个可选的 `transportMappings`，结构上可赋给
    `CodeHostNodeConnection`；三个 legacy 函数的签名与 `CodeHostRequestPort` 同形（由 `tsc` 在装配点核对）。
- `DA/infrastructure/developmentDeliveryProvider.ts`：本地 `DevelopmentCodeHostConnections { resolve(provider) }`，返回值取交付 provider
  实际读到的字段（以 `tsc` 核对 legacy 服务可赋值）。

## 2. 连接

- **运行时选项与参与者**：
  - `TE/composition/taskEngineRuntimeOptions.ts`：`codeHostConnections?: CodeHostConnectionResolver`；新增
    `codeHostRequests?: CodeHostRequestPort`；
  - `TE/infrastructure/taskExecutionRuntimeParticipants.ts`：同样两项，原样透传进运行时选项；
  - `TE/composition/providerRuntime.ts`：daemon 装配处原本要求 `codeHostConnections`，同时要求 `codeHostRequests`。
- **节点端口装配**（`TE/composition/codeHostNodeExecution.ts`）：`requests` 取 `state.opts.codeHostRequests`；缺失时取一个只返回失败的
  端口（`code-host-not-configured`，与没有配置连接时的码相同），文件不再 import `services/codeHost/*`。
- **装配根**（`S/bootstrap/daemonModules/taskExecution.ts`）：在传 `codeHostConnections` 的同处传
  `codeHostRequests: { executeCodeHostCall, resolveProjectFallback, probeCodeHostMutation }`（装配根可以 import legacy）。
- **测试拓扑**：`T/helpers/taskExecutionTestTopology.ts` 的 `composeTaskExecutionTestRuntime` 总是注入真实的三个函数（连接仍按调用方给）；
  `T/helpers/eachProviderTaskExecution.ts` 与连接一样给「不该被用到」的占位；`T/helpers/daemonTaskExecutionBundle.ts` 走 daemon 装配根，
  由装配根注入；`T/helpers/providerTaskExecutionTestTopology.ts` 给调用方的运行选项与连接一样不收 `codeHostRequests`（由所选装配给出）。

## 3. 守卫与用例

- **新用例** `T/rfc449-code-host-requests-injected.test.ts`：
  - task-execution 与 development-automation 下没有文件 import `services/codeHost/*`（census AST，带负对照）；
  - `codeHostNodeExecution.ts` 的 `requests` 取运行时选项；未注入时三个请求都返回 `code-host-not-configured` 失败而不抛错；
  - 装配根注入的三个函数就是 legacy 的那三个（同一引用）。
- **既有锁随动**：RFC-284 T20 的子任务选项处置表登记 `codeHostRequests`（`dropped-registered`，与连接同由注册参与者给出）；
  RFC-408 的驱动配置排除表加 `codeHostRequests`（不进驱动配置）。
- **行为由既有用例覆盖**：RFC-269 代码平台节点执行、调用 / 回退 / 恢复探测、RFC-328 尝试账本、RFC-295 活跃投影、交付 provider 与
  webhook 代码平台上下文 e2e。
- **账本**：`commons-debt.json`、清单与 `counts.json` 不变（移除的都是模块 → legacy 的非受限层边，计数只降）。

## 4. 失败模式

- **漏注入**：`tsc` 检查装配点类型；daemon 装配处要求两项同时给出；新用例锁定未注入时的失败形状。
- **端口形状漂移**：legacy 函数与端口形状不一致时装配点 `tsc` 报错。

## 5. 测试策略

全部实现与用例写完后集中验证一次：静态检查；全量 SQLite（候选导出仓库）；导出仓库接 PostgreSQL 跑全部架构测试与受影响用例；P0 变异 lane。
