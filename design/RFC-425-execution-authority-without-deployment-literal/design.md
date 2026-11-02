# RFC-425 技术设计

路径缩写：`S` = `packages/backend/src`，`SO` = `S/modules/system-operations`，`T` = `packages/backend/tests`。行号以 RFC-424 落库后的源码
（`556a45573`）为准。

## 1. 端口与实现

- `SO/application/ports/executionAuthority.ts`：`ExecutionAuthorityPort` 删除 `readonly mode: 'standalone' | 'crewstation'`。
- 三个实现删除 `mode` 字段：`SO/infrastructure/local/localExecutionAuthority.ts`、`SO/infrastructure/crewstation/crewStationExecutionAuthority.ts`、
  `SO/infrastructure/crewstation/standbyExecutionAuthority.ts`。
- `S/bootstrap/executionInitialization.ts` 包装托管 authority 的对象同样删除转抄的 `mode`。
- `SO/application/executionStatus.ts`：`executionStatusOf(authority, mode)`，`mode` 由调用方给出（类型为 shared 的 `ExecutionStatus['mode']`）。
  线上 `ExecutionStatus` 形状不变。

## 2. 部署种类下传

profile 对象（`S/bootstrap/standalone.ts`、`S/bootstrap/crewstation.ts`）新增 `frontendMarker: string | null`（单机 `null`、托管
`'crewstation'`）；`DeploymentProfile` 类型同步。

| 消费方                                         | 改动前                                         | 改动后                                                            |
| ---------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------- |
| 执行状态读取器（`S/server.ts` 绑定）           | `executionStatusOf(deps.executionAuthority)`   | `executionStatusOf(deps.executionAuthority, deps.deploymentKind)` |
| HTTP 应用的 SPA 标记（`createHttpRequestApp`） | `deploymentMode: deps.executionAuthority.mode` | `frontendMarker: deps.frontendMarker`                             |
| 生命周期程序（`S/bootstrap/daemonSession.ts`） | `profile: input.executionAuthority?.mode`      | `profile: input.deploymentKind`                                   |

`deploymentKind` 与 `frontendMarker` 由 `daemonStart` 从 profile 取出，经会话输入、应用装配、HTTP 组合一路作为**必填值**传到 `server.ts`
（`server.ts` 不 import bootstrap，类型用 shared 的 `ExecutionStatus['mode']` 与 `string | null`）。测试侧的应用装配（统一测试入口）按单机
给出 `deploymentKind: 'standalone'`、`frontendMarker: null`。

## 3. SPA 标记

`S/embed.ts`：`withDeploymentMarker(asset, marker: string | null)` 在 `marker === null` 时原样返回，否则注入
`<meta name="agent-workflow-deployment" content="${marker}">`；`getEmbeddedFrontendResponse(path, lookup, marker)`。删去
`FrontendDeploymentMode` 与 `deployment === 'standalone'` 比较。

## 4. 守卫与账本

- **RFC-376**：`deployment-mode-branch-sites` 基线删去端口两处与 `embed.ts` 一处（5 → 2），`counts.json` 的上限同步改为 2（原因写明本 RFC）。
- **新增结构锁** `T/architecture/rfc425-execution-authority-deployment.test.ts`：
  - `ExecutionAuthorityPort` 不声明 `mode`；
  - `SO` 下实现执行权端口的对象字面量不出现 `mode:` 部署字面量；
  - `server.ts` 从 `deps.deploymentKind` 取执行状态的部署种类、从 `deps.frontendMarker` 取 SPA 标记，不读 `executionAuthority.mode`；
  - `daemonSession.ts` 交给生命周期程序的 `profile` 是 `input.deploymentKind`；
  - 两个 profile 各自写明标记（单机 `null`、托管 `'crewstation'`）；
  - 负例：端口重新声明 `mode`、实现重新写部署字面量、`server.ts` 回读 `executionAuthority.mode`、生命周期改回取 authority、
    `embed.ts` 重新比较部署字面量、profile 缺标记，各自被报出（既有语料替换与纯夹具两组）。
- **RFC-392 统一测试入口锁**：正例改为「`createComposedApp` 读必填的 `deps.deploymentKind`」，「`?? 'standalone'` 回落」负例保留。
- **guard-manifest**：新增一条；改动的守卫刷新行数。

## 5. 测试

- 执行状态投影：同一 authority 在两种部署种类下给出对应的 `mode`，状态与原因不变。
- SPA 标记：`null` 原样返回、非空注入（改写 `rfc370-m0-hosted-control-plane` 里调用 `withDeploymentMarker` / `getEmbeddedFrontendResponse`
  的断言，期望值不变）。
- 生命周期程序：`rfc379-daemon-lifecycle` 的 profile 入参来源改变，有序作业清单断言不变。
- 部署种类下传：`rfc394-start-sequence` 对单机与托管两种 profile 断言会话输入的 `deploymentKind` / `frontendMarker` 等于 profile
  给出的值（夹具不选执行权，托管种类只能来自 profile）；`rfc394-deployment-profile` 断言两个 profile 的标记。
- 测试里自建的 authority 夹具与读 `authority.mode` 的断言随之改写（后者改为断言 authority 不再携带部署种类）。
