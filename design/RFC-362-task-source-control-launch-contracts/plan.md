# RFC-362 实施计划

- 状态：Done（2026-09-20；实现与托管验收见本文末尾）。仅关闭 W4-E1/W5 合同准备；生产 launch cutover、durable replay/group/revision 和 reader gaps 留后继，E1/B/D/W5 不记 Done。

## 1. 任务

| 任务       | 内容                                                                            | 依赖 / 判据                                                          |
| ---------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| RFC-362-T1 | 按 current launch kernel 枚举入口、字段、lane、writer、cancel/recovery 与 tests | 用户批准；包含 RFC-359 后新增修复，不能引用已删 startExecution       |
| RFC-362-T2 | 定义 SC offered 与 Task required 合同、ref codec、结果和错误映射                | T1；与 RFC-294 design/当前行为逐项对拍                               |
| RFC-362-T3 | 测试装配复用现有实现验证 source snapshot、preparation、workspace read           | T2；真实 provider，无新生产 writer                                   |
| RFC-362-T4 | 双库事务/回滚、真实 Git preparation、取消与 replay characterization             | T3；两条 lane 原时序保持                                             |
| RFC-362-T5 | 登记 declared-only 合同与精确后继 consumer、E1/W5 debt owner                    | T2/T4；不伪造 active port 或 B/D 关闭                                |
| RFC-362-T6 | 形成生产 cutover 后继的 current callsite、分批接线与回滚清单                    | T4/T5；与 RFC-360 runtime selection、RFC-361 后续 Reaction seam 对齐 |
| RFC-362-T7 | 发布，核对 exact-SHA CI，更新本 RFC、RFC-294、STATE/index                       | T6；AC-1～AC-7 完成，仅关闭合同准备                                  |

建议两批提交：T1/T2 合同；T3～T6 行为验证与后继计划；T7 收口。

## 2. 文件与冲突边界

- 本批开发：SC public/domain 合同、Task application ports、本批测试与文档。
- 原 source-control scope participant 可复用，不重写已交付代码。
- 生产 `server.ts`、Task route launch kernel、scheduler、task helpers 不在本 RFC 切换范围。
- canonical/STATE/index 按 shared-main 规则精确发布；与 RFC-360/361 的合同命名和共享 public 文件先协调。

## 3. 验收与后继入口

- [x] 完整入口/字段/lane/recovery ledger。
- [x] 所有新增合同都有测试 provider、真实 consumer 计划与明确 owner；无万能 workspace/runtime/context 包。
- [x] 同 scope snapshot、事务外 effects、pre-materialized 时序通过双库行为测试。
- [x] `__repo_prep__`、取消/恢复、重试 initiator、人审 anchor 和 parent/frame 行为不变。
- [x] declared-only 项单独计数，生产 liveness 不涨，route/root/legacy debt 不虚减。
- [x] 后继 E1 生产 RFC 可依据本批证据写出逐入口切换和回滚方案；独立获批后才实施。
- [x] exact-SHA Main CI 成功；W4-E1、W5 及 RFC-294 继续保持未关闭状态。

## 4. 实施候选（2026-09-20）

T1/T2/T3/T4/T5/T6 的代码与证据见 [implementation-ledger.md](implementation-ledger.md) 和
[implementation-baseline.json](implementation-baseline.json)。21 个生产文件已逐项对拍：20 个与 `475fbb43c` 逐字相同，`server.ts` 仅有另属 RFC-360 的 RC participant 根注入；
22 个新 public 声明单列 declared-contract-debt，Task required port 只有测试适配。
新测试复用同一 DatabaseSession、SC scope reader、Git 和工作区读取；durable replay/group/revision 的限制明确刻画并交后继。
未在本地运行 Bun 测试/服务/全门，T7 与所有运行时通过结论等待最终 exact-SHA 托管 CI。

## 2026-09-20 完成验收

实现取证 SHA `123ce2dbc94b10d2c88bf978437bfa0db1b898ba`，Main CI [35492271521](https://github.com/wangbinquan/agent-workflow/actions/runs/35492271521) **46/46 success**。
逐 job 和目标 suite 见 [共同验收记录](../RFC-294-backend-layered-target-architecture/acceptance-rfc360-362-2026-09-20.json)。
Windows 原生流程 [35491113835](https://github.com/wangbinquan/agent-workflow/actions/runs/35491113835) 在祖先 `59c1fff1c` success；
其后根注入由本次 Main 的多 OS binary/e2e 覆盖，不混称 Windows workflow 为本 SHA 结果。

AC-1/2/6：逐入口、54 个 root writer 字段、两条 lane 与后继逐批接线/回滚清单；AC-3/4：同事务 snapshot、真实 Git、取消/回滚与既有 recovery oracle；AC-5：22 个 declared public 合同和 1 个 declared required port 显式入账，无生产 liveness；AC-7：本页托管证据。

仅关闭 W4-E1/W5 合同准备；生产 launch cutover、durable replay/group/revision 和 reader gaps 留后继，E1/B/D/W5 不记 Done。后续纯文档提交的最终整仓 CI 与远端同步在发布时继续核对。
