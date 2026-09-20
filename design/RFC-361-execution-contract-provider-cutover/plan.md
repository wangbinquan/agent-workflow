# RFC-361 实施计划

- 状态：Done（2026-09-20；实现与托管验收见本文末尾）。仅关闭 W4-E9 的 EC resource/fixture provider slice；Reaction、Event target、transport 和 observer lifecycle 继续开放。

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

- [x] T1 当前字段/失败矩阵与 exact IDs 齐全。
- [x] RC/TE 各一个 provider，两个 SPI 均被真实 EC application 消费。
- [x] EC 旧 service/table import 与默认 provider 构造归零。
- [x] 原真实 fixture、resource revision、DE 三条链和双库行为通过。
- [x] manifest/entrypoints/external import 精确对拍；其他 E9 debt 保持正确 owner。
- [x] 最终 exact-SHA Main CI 成功；父 RFC 仍 In Progress。

## 4. 首批实现候选（2026-09-20）

T1 原 exact IDs 固化在 `implementation-baseline.json`。T2～T5 已落候选：RC 窄列读取与 closure、TE 原 Script 机制、
EC 输入 pairing 与 validator/exact-output 编排分离；三个生产根强制注入两类 provider，旧 EC adapter 删除。
两个 required ports 经 canonical 识别为 active，各有一个真实 provider adapter 和一个 EC composition。
新增用例覆盖输入配对、direct validator 返回值、失败透传、参数、真实程序退出/超时和临时目录清理；托管 CI 待本批发布验证。
本 RFC 仅抵扣 EC provider slice，不关闭整个 E9；RFC-360 另有已定位的公共内核路径与子任务注入字段账本修复随本批补齐。

## 2026-09-20 完成验收

实现取证 SHA `123ce2dbc94b10d2c88bf978437bfa0db1b898ba`，Main CI [35492271521](https://github.com/wangbinquan/agent-workflow/actions/runs/35492271521) **46/46 success**。
逐 job 和目标 suite 见 [共同验收记录](../RFC-294-backend-layered-target-architecture/acceptance-rfc360-362-2026-09-20.json)。
Windows 原生流程 [35491113835](https://github.com/wangbinquan/agent-workflow/actions/runs/35491113835) 在祖先 `59c1fff1c` success；
其后根注入由本次 Main 的多 OS binary/e2e 覆盖，不混称 Windows workflow 为本 SHA 结果。

AC-1/2/5：EC 只消费两个必填 SPI，RC/TE 各一个 provider，三个根沿用唯一 EC participant，无生产反向 value 环；AC-3/4：真实资源、Script、超时/清理、配对与 exact-output oracle 通过；AC-6：旧 13 个 owner、8 个 exception 与 9 个 import ID 归零；AC-7：本页托管证据。

仅关闭 W4-E9 的 EC resource/fixture provider slice；Reaction、Event target、transport 和 observer lifecycle 继续开放。后续纯文档提交的最终整仓 CI 与远端同步在发布时继续核对。
