# RFC-365 技术设计

## 1. 切换前生产事实

`eventResponseRules.createEventResponseDeliveryConsumer` 先读取规则；不存在/disabled 或 materialized subscription 不匹配即不启动。缺 TriggerContext 抛 `event-response-trigger-context-missing`。成功/失败更新 rule result，失败文本截到 2,000 后抛回 delivery retry。

`eventCenterService.runOneNotification` 按 worker id claim delivery，以 `attemptCount` + lease owner 结算；现 consumer 只收到 `EventDeliveryRecord`，不能凭它证明仍持有 claim。三个 root 注入的 callback 最终到 `services/webhook/webhookDispatch.ts:dispatchEventTarget`，其中读取当前 owner、模板物化、admit 和 launch。

Task 以 `tasks.event_delivery_id` 唯一约束去重；DE 以 `employee_case_event_origins.event_delivery_id` 和现 `event-delivery:<id>` intake key 恢复原 Case。新 ref 不得使这些旧 receipt 失联。

## 2. 模块边界与冻结合同

EC application 拥有两个 required ports：`TaskAutomationWorkStartPort.start` 与 `EmployeeAutomationWorkStartPort.start`。TE / DE 各自在 application adapter 实现 EC exact SPI，并只调用本域唯一 launch/Case writer；DB receipt lookup 留在本域 infrastructure，由 composition 注入；root 负责装配。EC 选择 target 分支，模板物化也归 EC。Integration code-host trigger renderer 可继续使用共享纯 template mechanism，不保留 EC 的业务 switch。

合同目标是 RFC-294 design §3.5 的 V1：Task receipt 仅 TaskRef，Employee receipt 仅 EmployeeCaseRef；event-only context 绑定 durable `EventAutomationOriginRef` 与 `task-automation-work-start.v1` / `employee-automation-work-start.v1`，同 origin+port 派生确定性 key。origin 绑定 owner、subscription/delivery、rule revision 与 target digest；这些只封入引用，不再由 caller 拆开传 provider。

**合同冻结结论**：V1 新 collection/byte/field/ref 限制与现 schema 有差异，不能直接照抄类型再宣称等价。T1 已输出 source→rendered→current admission→target codec 的字段矩阵，覆盖默认 scratch、Agent allowClarify、空 inputs 省略、description null、body/external-id、uploads=[]、当前 employee revision 解析时点。T2 已按“保留全部现合法输入”冻结 public ledger：不新增 256 项上限，不把 UTF-16 限额改成 UTF-8 bytes/code points，不截断、不丢弃、不静默转新格式。

DE `domain/runtimeModel.ts` 的 intake 下游 target value 1,000、body 2 MiB、externalId 500 均继续按 UTF-16 unit 计数；DE target 数量继续受 manifest ≤20 约束。合同使用整条 admission 链的交集作为既有能力，没有把当前早已被下游拒绝的输入误报为新增收缩，也没有混淆 UTF-16 length、code points 与 UTF-8 bytes。

ownership、持久化、切换协议和兼容合同已一起落地；production liveness 使用必填 exact providers，observation-only 则显式标记，不以 optional legacy fallback 或 no-op provider 冒充能力。

## 3. Durable origin / work intent

已新增 EC-owned `event_automation_work_intents`，同一记录承载 origin 和 intent，避免另造通用 journal。字段：origin ref、delivery id、subscription id、rule id/revision/digest、owner ref、port id、已物化 target-specific payload/格式版本/digest、首次解析目标 ref、provider receipt、状态、claim identity 和时间。`delivery_id` 唯一；SQLite `0229` 与 PostgreSQL immutable `0005` 同步扩展。

`attemptCount` 与现 claimedBy/claimExpiresAt 足以识别 delivery 当前尝试时优先复用，禁止另起第二套 worker epoch。EC 内部 claim-scope factory 由现 worker/store 创建不可变 claim ref；新 consumer 仅在该 scope 调用建 intent/写结果。consumer signature 已逐一迁移现 subscriber adapters，不能让它们伪造 claim。

首调用在同一 `DatabaseSessionTx` 中：确认当前 delivery claim → 重验原规则存在/启用/materializedSubscriptionId → 物化并保存 target intent/origin。目标 current revision 按原 launch 的首次可用性解析时机绑定，重放不能再取另一个 revision。外部 provider 不在 EC tx 内运行。

IA adapter 从当前 rule owner 的既有 delegated authority 和 durable origin 铸 event-only context；EC required context factory 的实现由 root 注入。不得在 bootstrap 构造 Actor 或复制旧权限 snapshot。这里是保留已存在 admission 行为的合同归位，不新增授权策略。

provider 需要既有 source provenance 时，由 same-origin 的受约束 participant 在 live tx 中解析只属于该 source 的绑定；不解码 ref 成任意 ID，不另传 caller-controlled delivery 字段。该 participant 由 EC offered、IA/TE/DE adapters 按其 consumer 最小字段使用，精确登记 public surface；TE/DE 不直接读 EC 表。

## 4. 启动、结算与失败

| 时点                   | 必须行为                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| 第一次 effect 前       | EC intent 已持久化，authority 走现 current owner 路径；规则已变则按原 obsolete 行为结束  |
| provider 开始          | 按 origin 查本域既有 receipt；无 receipt 才在本域 admission tx 经唯一 writer 创建        |
| 并发重复               | 唯一键冲突后读同一 Task/Case；不能只用启动前的一次查询去重                               |
| provider 成功、EC 崩溃 | 重启重放同 origin 得到同 receipt，不产生第二 Task/Case                                   |
| claim 已换             | receipt 可以作为既有物理事实保存，但旧 claim 不得修改 rule result 或 delivery state      |
| 规则编辑/禁用后重放    | 不启动新版 target；若已存在旧 receipt 则只对账，未发出的旧 intent 按原 obsolete 语义退出 |
| provider 失败          | 保留原 2,000 字错误投影、retry budget/backoff、dead-letter 与人工操作；不新增重试器      |

rule `recordResult` 和 delivery settle 在 EC-owned 事务中同时验证该 claim 与规则版本，避免 consumer 写完结果才发现 lease 丢失。涉及非 automation consumers 的通用 delivery 流程只做必要 claim-context 适配，不重写它们的业务结算。

旧 receipt 兼容：无新 origin 行但已有 Task.eventDeliveryId / Case event origin 时，先读取旧 receipt 并建立映射，不能通过新 origin key 再启动。新 provider 仍由本域 adapter 写原 event source columns，保留 source termination、launch_origin、catalog membership。TE consumer 使用 RFC-363 已稳定的 launch seam；DE 只调用现 Case queue，不进入 Reaction 改造。

## 5. Roots、迁移与回滚

生产 automation composition 必填两个 providers + delegated context factory + claim/intent store；应用能力明确为 `{kind: 'automation', ...required}`。当前仅观察/测试的 composition 用显式 `{kind: 'observation-only'}`，保留其不注册 automation consumer 的意图；不能以 no-op provider 伪造 production capability。server、SQLite CLI、PG application 均按真实能力接线，移除运行时 `supportsEventCenterWorkStart` 猜测。

expand 表/reader → 旧 receipt 映射 → 全部合同与兼容判据完成 → 每 root 单一新 consumer → 删除旧 EC union seam。禁止两个 consumer 同时启动同 delivery；不修改 Integration code-host replay/control effect 流程。

回滚保留新表、origin/receipt 和兼容 reader；新 intent 写入后只能回到能识别它的兼容版本，不能直接回到基线旧 dispatcher 后重复执行。停新 admission、排空/结算已有 intent，再退 root 接线。claim/receipt 去重不可回滚为内存 Map。

## 6. 验证与退出

沿用 `rfc310-event-center`、`rfc315-event-automation-permissions`、`rfc359-w12-event-center-composition`、`rfc359-w15-events-archive-store-conformance`、`rfc359-w7-committed-events-conformance` 和 migration 0195/0196/0197/0198/0202；新增 `rfc365-automation-compatibility` 与 `rfc365-event-automation-target-providers`，覆盖四 target/原模板默认值、Unicode/集合边界、规则编辑前后、双库并发 claim、crash-after-start、legacy receipt、三 roots providers 和 observation-only。

跨 seam 只检查既有功能所需字段与正确绑定，不扩展安全审计。完成需两个 ports 的 recursive field/provider/consumer 账、旧 callback/union seam production imports=0；源码中的 WebhookTrigger code-host chain 仍应有真实 consumer，不能误删以换数字归零。
