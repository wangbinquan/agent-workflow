# RFC-361 实施计划

- 状态：In Progress（2026-09-20 用户批准实施）；开始实施，只领取 W4-E9 的 EC provider slice。

## 1. 任务

| 任务       | 内容                                                                        | 依赖 / 判据                          |
| ---------- | --------------------------------------------------------------------------- | ------------------------------------ |
| RFC-361-T1 | 冻结 resource/fixture 字段、case matrix、全部构造点、manifest 与 exact debt | 用户批准；两向 inventory 完整        |
| RFC-361-T2 | RC provider 接管 Agent/Workflow projection 与 resource closure              | T1；双库 oracle 相同                 |
| RFC-361-T3 | TE fixture provider 与 EC 本域 output validator 分离                        | T1；真实 Script 及错误矩阵行为相同   |
| RFC-361-T4 | bootstrap 注入两个必填 provider，保持唯一 EC participant                    | T2/T3；DE 三条生产调用链通过         |
| RFC-361-T5 | 删除旧 EC infrastructure adapter/fallback，更新 imports/manifest/canonical  | T4；本批 exact IDs=0，无 value cycle |
| RFC-361-T6 | 发布与 exact-SHA CI，更新母 RFC slice credit、STATE/index                   | T5；AC-1～AC-7 全满足                |

建议提交：T1/T2 资源纵切；T3 fixture 纵切；T4/T5 根切换与删除；T6 收口。若中间兼容 adapter 必要，必须只转发且有短期
consumer 清单；不得复制业务实现。预期修改目录为 EC application/composition、RC/TE adapters、本批测试与文档。

## 2. E9 余项的接续顺序

以下是母 RFC 余项与后继立项入口，**不是本 RFC 的实施授权或完成分母**：

| 后继 slice                  | 入口 / 必须完成                                                                                                                                                      | 依赖与冲突                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| E9-B Event target providers | 将 `EventAutomationWorkStartPort` 分为 task/employee 两个单方法 required ports；按 RFC-294 design §3.5 exact V1 接线、确定性 dedupe、保留 delivery claim 结算        | E0/C 已满足；需 TE/DE provider 与 Event composition，根接线串行                                       |
| E9-C Reaction execution     | `ReactionExecutionPortV1` 四方法 + `ReactionExecutionAdmissionParticipantInTxV1` 三方法；DE claim 与 TE admission 同一 async transaction；复用 RFC-328 takeover 机制 | 独立 schema/receipt/backfill 设计；与 RFC-362 的 TE launch/provider 接缝先对齐，不复活 provider twins |
| E9-D transport/root         | DE/Event routes 由 composition view 改 public command/query；所有操作完整保留，provider 必填、实例唯一                                                               | 各用例合同和 provider 完成后逐路切，B/D 随本域收口                                                    |
| E9/W9 observer lifecycle    | Observer/delivery worker 声明 lifecycle owner，与 managed registry 对接                                                                                              | W9 管理合同；未接入前维持当前启动/停止行为并保留债务                                                  |

Reaction 设计必须包含当前手动重试 initiator、人审 host anchor、零起始 attempt、同逻辑 attempt replay 与 cancellation oracle。
EventCenter-owned response rule 与 Integration-owned WebhookTrigger 分别迁移；不能因为共享授权词汇就并表或合并 ingress。
完整 E9 关闭须上述剩余 slices 均有独立 successor 和验收，RFC-361 完成只抵扣 EC 两类 provider。

## 3. 完成清单

- [ ] T1 当前字段/失败矩阵与 exact IDs 齐全。
- [ ] RC/TE 各一个 provider，两个 SPI 均被真实 EC application 消费。
- [ ] EC 旧 service/table import 与默认 provider 构造归零。
- [ ] 原真实 fixture、resource revision、DE 三条链和双库行为通过。
- [ ] manifest/entrypoints/external import 精确对拍；其他 E9 debt 保持正确 owner。
- [ ] 最终 exact-SHA Main CI 成功；父 RFC 仍 In Progress。
