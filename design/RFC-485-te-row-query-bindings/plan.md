# RFC-485 实施计划

**前置**：RFC-482（Done，`42b52316d`）、RFC-484（Done，`067169518`，Done 文档 `86cad5f11`）。由本会话实施（用户 2026-10-31 指示不再派
Codex）。全部实现与用例完成后集中验证一次；不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                                                                | 依据      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| RFC-485-T1 | 声明 `TaskNodeRunReads`、`TaskNodeOutputReads`，`NodeRunQueries` / `NodeOutputQueries` extends 它们；`public/types` 交出闭合接口                                    | design §2 |
| RFC-485-T2 | `TaskExecutionParticipantBindings` 增三个工厂；task-execution 的 composition 转出；bootstrap 的绑定与用例 helper 补上                                               | design §2 |
| RFC-485-T3 | collaboration 的调用点改用绑定，没有绑定的函数沿调用链接上；bootstrap 的装配点改交绑定                                                                              | design §2 |
| RFC-485-T4 | memory 的装配输入增两个读取端口，工作存储与注入读存储改收端口；bootstrap 的 memory 模块建好交入                                                                     | design §2 |
| RFC-485-T5 | `public/queries` 撤出三个工厂与四个类型名；账本销账、`counts.json` 收紧、guard-manifest 登记                                                                        | design §3 |
| RFC-485-T6 | 新增 RFC-485 用例与行为用例；字面量扫描找出的文本断言随改动改写；既有用例改取与补传                                                                                 | design §4 |
| RFC-485-T7 | 集中验证（静态、读源码文本的用例先行、受影响用例、全量 SQLite 与 PostgreSQL lane、架构报告对账）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI；收尾 | design §5 |

## 验收清单

- [ ] AC-1 task-execution 的 public 不再导出三个工厂；collaboration 经绑定、memory 经装配输入取得读取能力
- [ ] AC-2 两个闭合读取接口只有方法签名、从 `public/types` 交出；task-execution 未消费符号仍为 0
- [ ] AC-3 `public-surface-deviations` 68 → 65 并收紧到实测；跨 context 内部文件对与越 DAG 文件对不变
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-485 collaboration 与 memory 取 task-execution 的三个行形状查询工厂改经装配期注入（RFC-294 S9 第四步）`。走私有
index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
