# RFC-556 provider 实现别的 context 的端口一律经指定 adapter（RFC-294 S9 第十一步）

- **状态**：In Progress（2026-11-23）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §4，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S9 第 5 项（跨 context 内部文件对）与 design §14
  “跨 context 内部文件对 → 0”；形状同 [RFC-555](../RFC-555-mission-continuation-required-port/proposal.md)（consumer 的 `composition/required-ports.ts`
  只由 bootstrap 与指定 provider adapter 取）。

## 1. 背景

跨 context 内部文件对精确清单（14 条）里有四条是同一种形状：provider 实现 consumer 自有的端口，却在 adapter 以外的文件里取 consumer 的端口类型。

| #   | provider 文件                                                            | 取的 consumer 端口                                                                               |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 1   | task-execution `infrastructure/taskCatalogSources.ts`                    | task-catalog `composition/required-ports` 的 `TaskCatalogSource`（只为标注返回类型）             |
| 2   | task-execution `infrastructure/taskExecutionCatalogSources.ts`           | 同上                                                                                             |
| 3   | task-execution `infrastructure/taskExecutionTrigger.ts`                  | integration `application/ports/webhookExecution` 的 `WebhookTaskExecutionParticipant`            |
| 4   | resource-catalog `infrastructure/adapters/runtimeProfileParticipants.ts` | runtime-management `application/ports/runtimeProfileParticipants` 的 `RuntimeProfileUsageReader` |

1～3 同时是 `rfc328-architecture-guards` 的 provider-bridge 精确债务里的三条。task-execution 已有 task-catalog 的指定 adapter，resource-catalog 已有
runtime-management 的指定 adapter；task-execution 还没有 integration 的。

## 2. 目标

- **G1**：两个 consumer 的 `composition/required-ports.ts` 交出各自的端口类型（integration 加 `WebhookTaskExecutionParticipant`，runtime-management 加
  `RuntimeProfileUsageReader`；端口声明位置不变）。
- **G2**：每个 provider 只在指定 adapter 里按类型取 consumer 的 required-ports，provider 自己的 infrastructure 改从 adapter 取：task-catalog 的 adapter
  转出 `TaskCatalogSource`；task-execution 新增 `application/adapters/integration-adapter.ts`，声明 `TaskExecutionTriggerParticipant`；resource-catalog 的
  runtime-management adapter 转出 `RuntimeProfileUsageReader`。
- **G3**：目标 DAG 与 RFC-294 design §3.1 的 Mermaid 同批登记两条虚线 required 边（task-execution implements `WebhookTaskExecutionParticipant` →
  integration；resource-catalog implements `RuntimeProfileUsageReader` → runtime-management）；`TaskCatalogSource` 的边已在。
- **G4**：跨 context 内部文件对 14 → 10；`rfc328` 的 provider-bridge 债务销去三条；精确清单与减速带随之降低，其余计数不升。
- **G5 结局不变**：只换类型的取处，实现与装配不变。顺带删去 integration `composition/webhookDispatch.ts` 里那条同名类型转出（生产代码没有读者，唯一的读者是一个测试助手、改从
  required-ports 取；端口只经 required-ports 交出一处）。

## 3. 非目标

- 其余 10 条跨 context 内部文件对（code-capability → resource-catalog 两条、integration → task-execution 的源终止能力两条、integration → event-center、
  intent → resource-catalog 两条、task-execution → source-control、task-execution 工作组启动的两条资源读）。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：四个 provider 文件不再取 consumer 的内部；三个 provider 的指定 adapter 是各自唯一取 consumer required-ports 的文件，且只按类型。
- **AC-2**：行为与装配不变。
- **AC-3**：目标 DAG 与 design 的 Mermaid 同批登记两条新虚线边；跨 context 内部文件对 14 → 10，`rfc328` 债务、精确清单、`counts.json`、design 边总数与
  `rfc423` 的符号归属随之更新；新增 RFC-556 用例并登记 guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
