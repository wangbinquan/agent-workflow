# RFC-365 实施计划

状态：In Progress；T1 兼容性对拍已于 2026-09-20 完成，2026-09-21 按“保留全部现合法输入”冻结合同并完成 T2～T6 实现；等待 exact-SHA hosted CI 后正式置 Done。

| 任务 | 交付物                                                               | 前置 / 退出条件                                                  |
| ---- | -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| T1   | 四 target 的原字段/默认值/模板/codec/receipt/claim oracle 与兼容报告 | 覆盖现合法新输入，非仅存量统计；不读用户业务库或输出敏感模板正文 |
| T2   | exact 两端口、origin/context、consumer 字段与预算合同定稿            | T1；若不等价，先呈批具体目标合同修订；本 RFC 不授权能力收缩      |
| T3   | EC origin/intent store、既有 claim-scope、旧 receipt 映射            | T2；真实双库 migration/rollback/并发                             |
| T4   | TE Task provider、DE Case provider，各自单一 writer/dedupe           | T3；TE 接线等 RFC-363 launch seam 稳定                           |
| T5   | EC 模板物化、claim-aware result/settle、三 roots、观察模式           | T3/T4；旧规则失效/重启/claim 交错全部通过                        |
| T6   | 删除 EC union seam 和 root callback、canonical/AC/最终 CI            | T5；code-host 独立链保留；完整 E9 不关闭                         |

T1 可与 RFC-363/364 独立准备；合同兼容未定时 T2 以后暂停，继续完善 oracle。T4 的 Task adapter 不与 RFC-363 同时改 launch kernel。T3 schema/migration，T5 roots，T6 index/canonical 都在共享 main 短发布段串行。只提交本项 allowlist，保留他人 WIP，不建 branch/worktree。

## 完成检查

- [x] AC-1～6 逐项通过，所有 target 的现合法行为有源码和 targeted suite 证据。
- [x] 新集合/UTF-8/field/ref 限制与现能力差异均已明确处置；没有静默截断/拒绝。
- [x] origin/digest/确定性 key 与旧 receipt 对齐；双库 harness 覆盖 crash/replay、陈旧 claim 和并发线性化。
- [x] TE/DE providers 各 1，所有方法真实消费；root 无业务 target switch。
- [x] Integration WebhookTrigger 仍走自身链路；Reaction 和 W9 无范围外改动。
- [ ] owned debt 出账、最终 exact-SHA Main CI success；RFC-294 仍 In Progress。

## T1 完成（2026-09-20）

[兼容性报告](./compatibility-report.md) 已逐字段覆盖 source/render/current admission/V1，新增生产 renderer 与真实 codec 的特征测试。发现 UTF-8/UTF-16、Task 257 inputs、form-field grammar 和 trim 差异；DE target 受 manifest≤20 约束，未误报为新增256限制。T1 七个特征用例在 Ubuntu/macOS 通过；验收源码 `7befa335c23c36107f3298e654026d38380159dc` 的 [Main CI 35513285722](https://github.com/wangbinquan/agent-workflow/actions/runs/35513285722) success。推荐的兼容合同已在 2026-09-21 获继续实施指令，按不收缩现能力落入 T2。

## T2～T6 实现候选（2026-09-21）

- T2：四臂 renderer 唯一归 EC；Task 与 Employee exact ports、event-only delegated context、durable origin binding 均为封闭合同。Task 不加 256 项上限，所有字符串沿用既有 UTF-16/downstream 判据。
- T3：新增 `event_automation_work_intents` 的 SQLite/PG additive migration 与中立 store；intent 在 effect 前持久化，receipt 可在 claim 丢失后保事实，rule/delivery settle 必须通过 immutable claim scope 与 rule revision fence。
- T4：TE 只返回 Task receipt，DE 只返回 EmployeeCase receipt；两者都先采用旧 receipt，再以本域既有唯一键在并发下线性化，crash-after-start 重放不产生第二实体。
- T5：server、SQLite CLI、PostgreSQL daemon 三 roots 显式注入两个 providers、context factory 和 intent store；纯观察 composition 明示 `observation-only`。
- T6：Integration dispatcher 的 EC union target switch、能力探测和 root callback 已删除；code-host WebhookTrigger 原链保留。canonical/账本与 hosted CI 尚待本批收口。
