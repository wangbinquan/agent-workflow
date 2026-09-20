# RFC-365：Event Automation target providers 拆分

- 状态：Draft（2026-09-20；待三件套批准，生产切换另受本文兼容判据约束）。
- 母项：RFC-294 W4-E9 的 Event target slice；RFC-361 仅已完成 Execution Contract providers。
- 前置：W4-E0/C 已完成；Task provider 接线与 RFC-363 的 launch seam 协调。
- 源码基线：`cae3e4ea2579bc1d13ff34008fa011d4073d8b59`，见 [source-baseline.json](./source-baseline.json)。

## 1. 问题与目标

当前 Event Center 将 owner、target、delivery/subscription 和 TriggerContext 一起交给 `EventAutomationWorkStartPort.launch`；三个 root 通过 Integration webhook dispatcher 返回 Task/Case union receipt。Task 和 Employee target 的规则物化、启动以及 receipt 所有权混在同一口。

本 RFC 使 EC 拥有规则选择、模板物化、durable origin/work intent 和 delivery 结算；TE / DE 分别提供唯一 target-specific adapter，只返回自身 receipt。保留 existing Task/Case 去重、重试、错误与旧规则失效语义。Integration 继续拥有 code-host WebhookTrigger，不再承接 EC source-neutral target switch。

## 2. 能力影响与尚待裁决的兼容点

本方案不批准删除或截断现有合法输入。四种 target、body/external-id intake、模板插值、现 permissions 和配置能力均保留。

当前 `responseRule.ts` 与 RFC-294 design §3.5 的目标 V1 **尚未等价**：

| 差异                | 当前事实                                                                                 | 切换前的要求                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| collection budget   | inputs/target 是 record，规则 schema 没有 max-256 集合限制                               | 盘点完整 admission 链的真实能力；不能假设所有输入都小于 256                        |
| text budget         | schema 的 `z.string().max(...)` 与目标 UTF-8 字节预算计数不同                            | 非 ASCII 与模板展开后文本逐项对拍，不能静默截断                                    |
| employee target/ref | 当前保存 field ref，启动时取 employee current revision；V1 要 exact ref/具名 field codec | 映射 must preserve current field grammar 和首次启动时机；不能用“新 machine id”改名 |

T1 输出可复跑的兼容报告，既覆盖已有 rule，也覆盖当前允许的新输入边界；**存量无超限不能证明能力等价**。默认处置是保留现能力并修订目标合同；如确需收缩某项能力，另列具体输入/部署影响并逐项呈用户批准，不能以批准本 RFC 推导这种许可。

因此本 RFC 的开发顺序为“行为及兼容锁 → 合同定稿 → providers → 切换”。若 T1 证明既有能力无法被目标 V1 无损表达，T2/生产 cutover 暂停，先提交精确合同修订；可继续独立的 receipt/claim oracle 和 RFC-363/364 工作。当前 Draft 不声称 V1 已适合直接上线。

## 3. 范围与非目标

承担 EC 规则物化、origin/work intent、target-specific delegated context、TE/DE providers、三 roots 和旧 union seam 消除。保留 source-neutral EventResponseRule 与 Integration WebhookTrigger 各自的 writer/表/路由。

不迁 Reaction execution/admission、整个 DE/EC transport、observer 调度或 W9 registry；不增加运行 worker，不开展权限策略调整。完成只抵扣 E9 Event target slice，完整 E9 继续开放。

## 4. 验收标准

- AC-1：四 target、模板/默认值、owner 当前行为、规则编辑/禁用/删除、trigger 缺失、status/error 等全部有旧链路 oracle。
- AC-2：目标 DTO 与现能力差异全部有明确处理；合同获批且无隐含收缩后方可生产切换。不得将源规则“看起来合法”当物化后输入符合 V1。
- AC-3：TE/DE 两个 required port 各 provider=1，方法和 DTO 按已批准 exact contract；不得跨传另一 target/receipt，也不得在 root 做业务 switch。
- AC-4：同事务写 durable origin + intent，复用现 delivery claim identity；Task/Case 创建幂等、crash-after-start 重放同 receipt，陈旧 claim 无法写规则结果或结算 delivery。
- AC-5：SQLite/PG 真并发、进程重启、迁移前已有 Task/Case 去重与旧规则失效行为一致。
- AC-6：production 三 roots 显式要求两个 providers，观察模式有明确标签；旧 union seam、root callback 和 dispatchEventTarget 的 EC 消费归零，code-host WebhookTrigger 保持原路径。
- AC-7：owned canonical/field/debt 对账、最终 exact-SHA Main CI 成功；完整 E9/Reaction/W9 不记 Done。
