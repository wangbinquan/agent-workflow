# RFC-477 实施计划

**前置**：RFC-476 落地。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做功能验证，
开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                                    | 依据            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| RFC-477-T1 | 节点回滚：task-execution `domain/nodeRunRollbackOutcome.ts`、`infrastructure/nodeRollback.ts`；collaboration 端口与绑定一格；两边调用方 | design §1       |
| RFC-477-T2 | 资源限额：task-execution 审计端口与 `application/resourceLimitEnforcement.ts`；composition 转出；bootstrap 改取                         | design §2       |
| RFC-477-T3 | agent 启动快照：task-execution `domain/agentHostWorkflow.ts`；public 转出校验；integration 改取                                         | design §3       |
| RFC-477-T4 | 触发预检与停用资源策略：resource-catalog `domain/` 两个文件与 public 转出；全部消费方改取                                               | design §4–§5    |
| RFC-477-T5 | public 收口（撤出失去模块外消费方的符号）                                                                                               | design §1.3、§2 |
| RFC-477-T6 | 用例与账本：受影响用例、源码文本守卫、新增 RFC-477 用例、`R1` 账本、commons-manifest、owner 表、减速带（C13）、注释与文档链接           | design §6       |
| RFC-477-T7 | 集中验证（含 shared / system-mocks / frontend）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI；收尾                      | design §9       |

## 验收清单

- [ ] AC-1 五个 `services/` 文件不在、零引用；`R1` 里没有它们
- [ ] AC-2 行为不变（回滚、限额、启动快照、触发预检、停用资源处置；collaboration 经端口走同一份实现）
- [ ] AC-3 架构计数按实测（`R1` 30 → 27），偏差、未被消费的 public 符号与越界类计数不升；触及的减速带收紧到实测
- [ ] AC-4 受影响用例与新增用例全部通过（四个包）
- [ ] AC-5 exact SHA CI 全绿

## PR / 提交

单个提交：`refactor(backend): RFC-477 节点回滚、资源限额、agent 启动快照与触发预检按 owner 归位（RFC-294 W9-D 第二十四步）`。
走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
