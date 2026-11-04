# RFC-437 技术设计

路径缩写：`S` = `packages/backend/src`，`T` = `packages/backend/tests`，`I` = `S/modules/integration`。以 RFC-436 收尾后的源码（`3cb987341`）为准。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：全部在 integration：
  - `domain`：适配器、触发器匹配与校验；
  - `application`：分发器、投递存储、限流、终态工作区清理策略、端点与触发器管理，以及新增的入站接收与投递重放用例；
  - `application/ports`：分发器合同、投递运行时、入站命令；
  - `inbound/http`：四个绑定；
  - composition、`server.ts` 与 bootstrap 只改连接。
- **承担的演进**：W4 B / D 第三步，并执行 RFC-294 design §2「`services/` 按 owner 迁入模块后删除」：
  - `R1` 198 → 178；
  - 深引模块内部的路由 4 → 3；
  - import `services/` 的路由 28 → 24；
  - integration 的 composition 与 infrastructure 不再回头 import `services/webhook/*`。
- **不新增**跨 context 依赖与 R2 边。分发器原先经 legacy 服务拿到的三个类型，改从 owner 取：
  - `IntegrationTriggerResourceBinding` 本是 integration 端口 `IntegrationTriggerResourceQueries` 的别名，直接用端口；
  - `ExecutionInvoker` 本就由 task-execution `public/commands` 导出；
  - `TaskExecutionResourceBinding` 由 task-execution `public/commands` 补导出（与已导出的 `TaskExecutionResourceAuthority` 同源，消费者为 integration）。
  - 分发器依赖合同里从未被使用的 `getUserGitCommitIdentity`（identity-access `public/queries`）删去：迁入 integration 后它会成为
    design §3.1 DAG 之外的 integration → identity-access offered 边；授权类型仍只走 identity-access `public/participants` 的 type-only 授权边。
- **留下的债**：
  - `I/composition/webhookAdmission.ts` 与 `I/infrastructure/webhookDispatchRuntime.ts` 的启动准入与保存校验仍调用定时任务服务的值级函数，
    随 RFC-438 迁移；
  - `I/composition/webhookAdmission.ts` 含校验逻辑（composition 只应构造与注入），同样随 RFC-438 归位。

## 1. 文件去向

| 原文件                                           | 新位置                                      | 说明                                                      |
| ------------------------------------------------ | ------------------------------------------- | --------------------------------------------------------- |
| `S/services/webhook/codeHostAdapter.ts`          | `I/domain/codeHostAdapters.ts`              | 适配器接口、注册表、`replayHeaders`                       |
| `S/services/webhook/githubAdapter.ts`            | `I/domain/githubWebhookAdapter.ts`          | 去掉对 `githubNormalization` 的转出，调用方直接取 domain  |
| `S/services/webhook/gitlabAdapter.ts`            | `I/domain/gitlabWebhookAdapter.ts`          | 同上                                                      |
| `S/services/webhook/matching.ts`                 | `I/domain/webhookTriggerMatching.ts`        | 纯函数                                                    |
| `S/services/webhook/triggerValidation.ts`        | `I/domain/webhookTriggerValidation.ts`      | 纯函数                                                    |
| `S/services/webhook/dispatcherTypes.ts`          | `I/application/ports/webhookDispatcher.ts`  | 分发器合同与能力判定                                      |
| `S/services/webhook/webhookDispatch.ts`          | `I/application/webhookDispatch.ts`          | 依赖改指 owner（见 §0）                                   |
| `S/services/webhook/deliveryStore.ts`            | `I/application/webhookDeliveryStore.ts`     | 去掉对 domain 常量的转出                                  |
| `S/services/webhook/rateLimiter.ts`              | `I/application/webhookRateLimiter.ts`       | 两档速率与可注入时钟                                      |
| `S/services/webhook/terminalWorkspaceCleanup.ts` | `I/application/terminalWorkspaceCleanup.ts` | 策略类型改从 task-execution `public/operations` 取        |
| `S/services/webhookEndpoints.ts`                 | `I/application/webhookEndpoints.ts`         |                                                           |
| `S/services/webhookTriggers.ts`                  | `I/application/webhookTriggers.ts`          | `IntegrationTriggerResourceAuthority` 改从端口取（见 §5） |
| `S/routes/webhooks.ts`                           | `I/inbound/http/webhookIngressRoutes.ts`    | 逻辑抽到 §2 的用例                                        |
| `S/routes/webhookDeliveries.ts`                  | `I/inbound/http/webhookDeliveryRoutes.ts`   | 重放抽到 §3 的用例                                        |
| `S/routes/webhookEndpoints.ts`                   | `I/inbound/http/webhookEndpointRoutes.ts`   | 原样搬迁                                                  |
| `S/routes/webhookTriggers.ts`                    | `I/inbound/http/webhookTriggerRoutes.ts`    | 原样搬迁，资源类型改指 owner                              |

原文件全部删除，不留 facade；仓内 import 方（src 与 tests）逐个改指新位置。搬迁时只去掉零消费者的转出与死代码：
适配器文件对 domain 归一化函数的转出、投递存储对 domain 常量的转出与零调用的 `touchEndpointLastDelivery`；
零实现的出站回写占位接口 `CodeHostReportSink` 原样保留。

## 2. 入站接收用例（G2）

`I/application/receiveCodeHostWebhook.ts`（新）把原路由的同步段整体收进来，顺序与分支逐条不变：

```ts
export interface CodeHostWebhookRequest {
  readonly provider: string
  readonly urlToken: string
  /** One request header by lower-case name; only the adapter allowlist is read. */
  header(name: string): string | undefined
  /** Reads the body up to `limitBytes`; null when it is larger. Called only after admission. */
  readBody(
    limitBytes: number,
  ): Promise<{ readonly bytes: Uint8Array; readonly text: string } | null>
}
export type CodeHostWebhookOutcome =
  | { readonly kind: 'not-found' }
  | { readonly kind: 'rate-limited' }
  | { readonly kind: 'payload-too-large' }
  | { readonly kind: 'internal-error' }
  | { readonly kind: 'signature-rejected' }
  | { readonly kind: 'invalid-json' }
  | { readonly kind: 'ignored'; readonly deliveryId: string }
  | { readonly kind: 'accepted'; readonly receipt: VerifiedWebhookReceipt }
export interface CodeHostWebhookReceiver {
  receive(request: CodeHostWebhookRequest): Promise<CodeHostWebhookOutcome>
}
export function createCodeHostWebhookReceiver(deps: {
  readonly persistence: WebhookIngressPersistence
  readonly unseal: (secretEnc: string) => string
  readonly verifiedIngress: VerifiedWebhookIngressCommands
  readonly limiters: WebhookRateLimiters
}): CodeHostWebhookReceiver
```

- 判定顺序：适配器（未知 → 计一次未匹配额度，`not-found`）→ 端点（缺失或 provider 不符 → 未匹配额度用尽为 `rate-limited`，否则 `not-found`）
  → 每端点额度 → 读正文（`payload-too-large`）→ 白名单取头 → 解封密钥（失败记日志，`internal-error`）→ 验签（落 `rejected` 投递，`signature-rejected`）
  → 解析 JSON（落 `ignored / parse-failed`，`invalid-json`）→ 归一化（落 `ignored`，原因 `unsupported-event` 或 `parse-failed`）
  → 停用端点（落 `ignored / endpoint-disabled`）→ 已验证投递接收（`accepted`）。
- 正文上限常量 `WEBHOOK_BODY_MAX_BYTES` 与日志器名 `webhook-ingress` 随用例迁移。
- 绑定的 HTTP 映射与原路由逐字相同：

| 结果                 | 响应                                    |
| -------------------- | --------------------------------------- |
| `not-found`          | 404 `{ error: 'not-found' }`            |
| `rate-limited`       | 429 `{ error: 'rate-limited' }`         |
| `payload-too-large`  | 413 `{ error: 'payload-too-large' }`    |
| `internal-error`     | 500 `{ error: 'internal-error' }`       |
| `signature-rejected` | 401 `{ error: 'signature-rejected' }`   |
| `invalid-json`       | 400 `{ error: 'invalid-json' }`         |
| `ignored`            | 200 `{ deliveryId, status: 'ignored' }` |
| `accepted`           | 200 已验证接收的回执                    |

- 绑定保留流式截断读取（`readBodyLimited`）与按名取头；路由只在接收器存在时注册，与原先「缺密钥箱或已验证接收即不挂」等价。

## 3. 投递重放用例（G3）

`I/application/replayWebhookDelivery.ts`（新）收下原 `POST /api/webhook-deliveries/:id/replay` 的处理体：

```ts
export interface WebhookDeliveryReplay {
  replay(
    deliveryId: string,
  ): Promise<{ deliveryId: string; replayedFrom: string; status: 'received' }>
}
export function createWebhookDeliveryReplay(deps: {
  readonly runtime: WebhookDeliveryRuntime
  readonly events: Pick<VerifiedWebhookIngressDependencies['events'], 'observe' | 'notify'>
  readonly wakeTerminalControl: (effectId: string | null) => void
  readonly now: () => number
}): WebhookDeliveryReplay
```

- 规则、错误码与文案逐条不变：
  - 缺失投递 404 `webhook-delivery-not-found`；
  - `rejected` 不可重放、在途、正文已清、端点已删、provider 未知、正文非 JSON、无法归一化，各自原码；
  - 终态事件（`mr_closed` / `mr_merged`）要求根投递有 MR 流修订与终态控制效果，缺一个各报原码；
  - 去重命中报 `webhook-delivery-replay-conflict`。
- 发布与标记不变：
  - 逐条观测，有投递计 `matched`；
  - 无投递而有终态控制效果计 `matched / terminal-control-accepted`，否则计 `ignored / no-trigger-matched`；
  - 唤醒终态控制，并对每个事件投递发通知，通知失败吞掉。
- **可用性由 composition 判定**：
  - 原条件是事件中心与分发器都在，且分发器支持事件中心投递，不看密钥箱与托管事件入口；
  - `composeWebhookDeliveryReplay` 按同一条件返回用例或 `undefined`；
  - 绑定在 `undefined` 时先于读投递报 409 `webhook-ingress-unavailable`，与原先先判可用性再读行的顺序一致。
- 事件端口复用已验证接收的 `observe / notify`，由 composition 用事件中心句柄实现。绑定不再接触 `EventCenterModule` 与分发器类型。

## 4. 绑定（G4）

- `webhookDeliveryRoutes.ts`：
  - 挂载入参改为 `{ runtime: WebhookDeliveryRuntime; replay?: WebhookDeliveryReplay }`；
  - 三个 GET 原样，重放调用 §3 的用例。
- `webhookEndpointRoutes.ts`、`webhookTriggerRoutes.ts`：原样搬迁，只改 import。
  - 触发器绑定的资源类型改指 integration 端口与 task-execution `public/commands`；
  - identity-access 只用 `public/participants`。
- `webhookIngressRoutes.ts`：见 §2。
- 四个绑定都不 import `services/`，不深引其他 context。

## 5. 端口、composition、`server.ts` 与 bootstrap

- `I/application/ports/scheduledTaskPersistence.ts` 接收 `IntegrationTriggerResourceAuthority`（原在 `services/scheduledTasks.ts`）：
  - 它与同文件的 `IntegrationTriggerResourceQueries` 同属触发器资源合同；
  - `services/scheduledTasks.ts` 改为从该端口取，这条边已在账本里，不新增。
- `I/application/ports/webhookDeliveryRuntime.ts`（新）接收 `WebhookDeliveryRuntime`（原在 `composition/webhookIngress.ts`），composition 转出。
- `I/application/ports/verifiedWebhookIngress.ts` 接收 `VerifiedWebhookIngressCommands`（原在 `public/commands.ts`）。
- `composeWebhookIngressTransport`：
  - 新增可选入参 `limiters`，并按原条件构造 `receiver`；
  - 原有字段保留。
- 新增 `composeWebhookDeliveryReplay`（§3）。
- `I/composition.ts` 转出：
  - 四个挂载函数及其入参类型；
  - bootstrap 需要的分发器工厂与合同、`recoverInterruptedDeliveries`。
- `S/server.ts` 与 `S/bootstrap/{daemonApplication,daemonHttpComposition,daemonModules/integration}.ts` 改经 integration composition 导入，
  重放用例在 HTTP 装配处连接。

## 6. public 面（G5）

`I/public/commands.ts` 删去 `VerifiedWebhookIngressCommands` 与 `WebhookIngressPersistence` 的转出，只剩维护命令 `IntegrationMaintenanceCommands`
（消费者 `bootstrap/maintenanceJobBindings.ts`）。

## 7. 账本与计数（实测为准）

- `architecture/commons-debt.json`：删去 20 条 R1 边（`routes/webhookDeliveries.ts` 2 条、`services/webhook/*` 15 条、两个服务 3 条），
  `inboundEdges` 198 → 178。
- RFC-305 identity-access 消费者账本：
  - `routes/webhookTriggers.ts` 改为新绑定路径；
  - `services/webhook/webhookDispatch.ts` 的 `public/participants` 边改为新路径，`public/queries` 边随死依赖删除而消失。
- `tests/architecture/architectureReport.ts` 的 legacy 文件归属表删去 16 个已删文件。
- 路由错误码棘轮的语料加入重放用例文件：错误码从路由搬进用例，仍受棘轮约束。
- 引用旧路径的源码锁与接线断言改指新位置；`counts.json` 只降不升；guard-manifest 刷新行数。

## 8. 失败模式

- **分支漂移**：两段逻辑整段搬迁、顺序不变。入站与重放的 HTTP 用例原样复跑，新增的直接用例逐分支断言结果与落库状态。
- **挂载缺失**：用例断言生产应用里每条 Webhook 路由各注册一次，权限点、令牌访问与公开理由不变。
- **反向依赖残留**：新增源码锁断言迁入的 19 个文件不 import `services/` 与其他 context 的内部，绑定只依赖本模块与传输工具。
- **可用性条件漂移**：重放可用性按原条件判定，有用例覆盖「缺事件中心」「分发器不支持事件中心投递」两种不可用。

## 9. 测试策略

- **新用例** `T/rfc437-integration-webhook-family.test.ts`：
  - 16 个原文件不存在、`services/webhook/` 目录不存在，新文件存在；
  - 四个绑定只 import 本模块与传输工具；迁入的 19 个文件不 import `services/` 与其他 context 的内部；
  - 入站接收用例：每个结果分支（含判定顺序：限流先于读正文、未知适配器仍计未匹配额度）与落库的投递状态；
  - 重放用例：每条错误码、三种标记结果、通知失败被吞掉、终态唤醒；
  - 重放可用性：两种不可用条件下 composition 返回 `undefined`，生产 HTTP 报 409 `webhook-ingress-unavailable`；
  - 生产应用里 Webhook 路由的元数据（权限点、令牌访问、公开理由）不变。
- **改指的用例**：约 30 个引用旧路径的用例与辅助文件只改 import 路径；注入限流器的用例改经 `composeWebhookIngressTransport` 传入。
- **回归**：Webhook 接收、GitHub 入站、重放、分页、端点与触发器管理、分发、终态工作区清理、维护切片、provider 适配器、
  事件中心投递的用例，以及全部架构测试。
- **集中验证**：全部实现与用例写完后一次进行：静态检查、全量 SQLite、受影响用例的 PostgreSQL lane、导出仓库按已提交源码出报告的用例、P0 变异 lane。
