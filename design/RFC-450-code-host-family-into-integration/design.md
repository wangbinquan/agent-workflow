# RFC-450 技术设计

路径缩写：`S` = `packages/backend/src`，`T` = `packages/backend/tests`，`I` = `S/modules/integration`，`L` = `S/services/codeHost`。
以 RFC-449 落地后的源码（`2f8d491cd`）为准。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：integration 的 `domain`、`application/ports`、`application`、`infrastructure/codeHost`、`composition`、`public/types`。
- **承担的演进**：W4 B / D 第十五步：`codeHosts`、`accountRepositoryTransportCredentials` 两个路由不再 import `services/`；`L` 整体退役；
  integration MR 用例的 4 条 `R2` 清偿（原定 W4-E 的一部分，随家族迁移顺带完成）。
- **跨 context 边**：只有 integration → task-execution（`public/participants` 的恢复描述与尝试观察类型，原本就在 `L` 里）；task-execution、
  development-automation 已在 RFC-449 只认自己的端口，装配根把 integration 的实现注入进去。
- **留下的债**：`cached-repos`、`tasks` 两个路由；`services/developmentDeliveryDeps.ts`（W4-E）。
- **偏离项**：无。

## 1. 文件落位

| 原文件               | 去向                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `L/url.ts`           | `I/domain/codeHostUrl.ts`（原样）                                                                                               |
| `L/project.ts`       | `I/domain/codeHostProjectFallback.ts`（原样；`ProjectFallback` 类型随之从 `call.ts` 移来）                                      |
| `L/connections.ts`   | `I/infrastructure/codeHost/connections.ts`（连接服务、key-file 解析、`codeHostTlsRequestInit`、探测、`testCodeOf`，函数体原样） |
| `L/call.ts`          | `I/infrastructure/codeHost/call.ts`（执行器原样）                                                                               |
| `L/recoveryProbe.ts` | `I/infrastructure/codeHost/recoveryProbe.ts`（原样）                                                                            |

拆出去的部分：

- `I/domain/codeHostTlsPolicy.ts`：`normalizeCodeHostRejectUnauthorized`（TLS 选项的 provider 判据；连接服务、Bun TLS 片段与测试连接用例共用）。
- `I/application/ports/codeHostCalls.ts`：`ResolvedCodeHostConnection`、`FetchLike`、`CodeHostCallSpec`、`CodeHostCallDeps`、`CodeHostCallOutcome`
  （原样）；`CodeHostConnectionProbeInput`（`probeCodeHostConnection` 原来的内联参数）；新增端口
  `CodeHostRequests { executeCodeHostCall(spec, deps); probeCodeHostConnection(input) }`。
- `I/application/ports/codeHostConnections.ts`：`CodeHostConnectionsService`、`CodeHostConnectionUpsertInput`（原 `UpsertInput` 改名）、
  `CodeHostConnectionMutationConfirmation`（原样）；两个路由合同：
  - `CodeHostConnectionAdministration { list(); upsert(provider, input); remove(provider, confirmation?); test(provider, draft) }`；
  - `CodeHostConnectionProbe { probe(credential) }`，`credential` = `{ provider, baseUrl, token, rejectUnauthorized }`；
  - `CodeHostConnectionTestDraft { baseUrl?, token?, rejectUnauthorized? }`。

## 2. 用例

- **测试连接**（`I/application/codeHostConnectionTest.ts`）：`testCodeHostConnection({ service, probe }, provider, draft)`，函数体即
  `routes/codeHosts.ts` 测试端点在请求体解析之后的那段：未传字段回落到 `service.resolve(provider)` 的已存值、`normalizeCodeHostRejectUnauthorized`、
  缺 base URL 或 token 时 `ValidationError('code-host-not-configured', …)`、`probe.probe(...)`、只有测的就是已存那套时 `service.recordTest`。
- **MR 用例**：`MrEnsureConnectionDeps` 增加 `readonly requests: CodeHostRequests`；`mrEnsure.ts` 三处、`mrFacts.ts` 五处 `executeCodeHostCall(`
  改为 `deps.requests.executeCodeHostCall(`，`mrFacts.ts` 一处 `probeCodeHostConnection(` 改为 `deps.requests.probeCodeHostConnection(`；
  其余不变。类型从 `./ports/codeHostCalls` 取。

## 3. 装配

- **`I/composition/codeHostConnections.ts`**（并经 `I/composition.ts` 导出）：
  - `composeCodeHostConnections({ secretBox, repositoryTransport })`（即 `createCodeHostConnectionsService`）；
  - `composeCodeHostConnectionAdministration({ service, fetchImpl? })`：列表 / 保存 / 删除转给服务，测试走 `testCodeHostConnection`，探测绑定 `fetchImpl`；
  - `composeCodeHostConnectionProbe({ fetchImpl? })`；
  - `codeHostRequests`（MR 绑定用）：`{ executeCodeHostCall, probeCodeHostConnection }`；
  - `codeHostNodeRequests`（task-execution 节点与启动恢复用）：`{ executeCodeHostCall, resolveProjectFallback, probeCodeHostMutation }`。
- **交付 provider**（`S/modules/development-automation/infrastructure/developmentDeliveryProvider.ts`）：`createDevelopmentDeliveryProvider` 多收
  `requests`（类型取自交付绑定合同 `DevelopmentDeliveryProvider['resolveBinding']` 的返回值），解析出的绑定带上它。
- **装配根**：
  - `S/bootstrap/daemonModules/repositoryCredentials.ts`：连接服务改取 `composeCodeHostConnections`，交付 provider 传 `requests: codeHostRequests`；
  - `S/bootstrap/daemonModules/taskExecution.ts`：`codeHostRequests: codeHostNodeRequests`；
  - `S/bootstrap/daemonApplication.ts`：启动恢复的 `codeHostProbe` 改走 `codeHostNodeRequests.probeCodeHostMutation`；
  - `S/bootstrap/daemonHttpComposition.ts`：`codeHosts` 给 `composeCodeHostConnectionAdministration({ service, fetchImpl })`（连接服务恒在；路由签名仍保留 null 时不挂载的自我跳过），
    `repositoryTransportCredentials` 的路由依赖多一项 `connectionProbe: composeCodeHostConnectionProbe({ fetchImpl })`；测试注入点
    `testSeams.codeHostRuntime` 的类型改为本地的 `{ codeHostFetch? }`。
- **路由**：
  - `S/routes/codeHosts.ts`：`mountCodeHostRoutes(app, service: CodeHostConnectionAdministration | null)`；测试端点解析请求体后
    `c.json(await service.test(provider, body))`；不再收 `deps`；
  - `S/routes/accountRepositoryTransportCredentials.ts`：`mountAccountRepositoryTransportCredentialRoutes(app, routeDeps)`，`routeDeps.connectionProbe`
    取代 `deps.codeHostFetch` 与 legacy 探测；
  - `S/server.ts`：两个挂载与 `ProviderSourceControlRouteComposition` 的类型随之收窄（`codeHosts` 只剩合同，`repositoryTransportCredentials` 只剩 `route`）。
- **public**：新增 `I/public/types.ts`，导出两个路由合同及其参数类型（`CodeHostConnectionAdministration`、`CodeHostConnectionProbe`、
  `CodeHostConnectionUpsertInput`、`CodeHostConnectionMutationConfirmation`、`CodeHostConnectionTestDraft`、`CodeHostConnectionCredential`）。

## 4. 守卫、账本与用例

- **新用例** `T/rfc450-code-host-family-into-integration.test.ts`：
  - `S/services/codeHost` 目录不存在、`S` 下没有文件 import `services/codeHost/*`（census AST，带负对照）；两个路由不 import `services/`；
  - 测试连接用例：回落已存值并在测已存那套时回写；草稿值不同则不回写；缺字段报 `code-host-not-configured`；GitHub 关闭 TLS 校验报
    `code-host-tls-option-unsupported`；
  - MR 用例经绑定里的 `requests` 发请求（注入的假实现收到调用）。
- **账本**：`architecture/commons-debt.json` 删去 mrEnsure / mrFacts → `L/*` 的 4 条 `R2`；`T/architecture/architectureReport.ts` 删去 `L/*` 的
  5 条 owner 登记；`guard-manifest.json` 刷新受影响的已登记守卫行数。
- **随迁的源码文本锁**（RFC-201 / 345 / 370 先例）：
  - `T/rfc254-platform-surface-guard.test.ts` 两条 posix-path-prefix 例外改指 `I/domain/codeHostUrl.ts`、`I/domain/codeHostProjectFallback.ts`；
  - `T/rfc349-source-control-promise-contract.test.ts` 读连接服务的新位置；路由里的 `await service.resolve(` 随编排移到测试连接用例，改读用例文件；
  - `T/rfc449-code-host-requests-injected.test.ts` 的装配根断言改为注入 integration composition 的实现；
  - `T/route-error-code-coverage.test.ts` 语料加入测试连接用例（它抛客户端可达的 `code-host-not-configured`）；
  - e2e 的源码引用注释（`e2e/rfc319-*`）改指新位置与行号；
  - `T/architecture/rfc390-neutral-http-binding.test.ts` 的 HTTP owner 表加入两个路由合同的装配函数（RFC-447 / 448 先例：只能由 HTTP 装配调用）。
- **用例的 import**：直接用 `L/*` 的用例与测试拓扑改从新位置取；构造 MR 绑定的 7 个用例文件给绑定加上 `requests: codeHostRequests`；
  直接构造交付 provider 的 W4-D13 用例传 `requests`；直接挂个人凭据路由的 RFC-321 用例改用两参数签名并给 `connectionProbe`。

## 5. 失败模式

- **漏给 `requests`**：`MrEnsureConnectionDeps.requests` 必填，`tsc` 在每个绑定构造处报错。
- **分层回退**：分层门（`rfc294-review-module-layer-rules`）与 public surface 预检在集中验证里跑；新增文件只按 domain → ports → application →
  infrastructure → composition 的方向引用。
- **注入点漂移**：两个路由的出站 fetch 注入点改由 composition 绑定；测试连接与个人凭据测试的既有 HTTP 用例覆盖。

## 6. 测试策略

全部实现与用例写完后集中验证一次：静态检查；全量 SQLite（候选导出仓库）；导出仓库接 PostgreSQL 跑全部架构测试与受影响用例；P0 变异 lane。
