# RFC-482 实施计划

**前置**：RFC-481 落地（Done，`fdc78adf8`，Done 文档 `68086c6cd`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后
集中验证一次；不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                                                                             | 依据         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| RFC-482-T1 | `TaskExecutionParticipantBindings` 增五个工厂引用；task-execution 的 composition 转出它们；bootstrap 的绑定与用例 helper 补上                                                    | design §2    |
| RFC-482-T2 | collaboration 的 30 个调用点改用绑定，没有绑定的函数沿调用链接上；bootstrap 的五个装配点改收绑定                                                                                 | design §1–§2 |
| RFC-482-T3 | 指令存储改为命令上下文的可选能力，`CollaborationRouteContext` 加能力；`createClarifyDirectiveStore` 改收实例；collaboration 的 `taskClarifyDirective.ts` 删除                    | design §2    |
| RFC-482-T4 | task-execution 持久化包增 `clarifyDirectives`，引擎两处端口改接；`CollaborationRuntimeMechanics` 去掉 `getNodeClarifyDirective`                                                  | design §2    |
| RFC-482-T5 | `reselectRunInTx` 与两处调用删除；`TaskRunSelectionReads` 声明并交出；task-execution 的 public 撤出六个符号                                                                      | design §2    |
| RFC-482-T6 | 新增 RFC-482 用例与行为用例；账本销账、`counts.json` 收紧、guard-manifest 登记；搜 `tests/` 与 `scripts/` 的文本断言随之改写；既有用例改取与补传绑定                             | design §3–§4 |
| RFC-482-T7 | 集中验证（静态、读源码文本的用例先行、受影响用例、全量 SQLite 与 PostgreSQL lane 按受影响范围、架构报告对账）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI；收尾 | design §5    |

## 验收清单

- [ ] AC-1 task-execution 的 public 不再导出六个符号；collaboration 改经绑定取五个工厂
- [ ] AC-2 `reselectRunInTx` 不在；引擎的 clarify 指令读取不经 collaboration；collaboration 的 `taskClarifyDirective.ts` 不在
- [ ] AC-3 `public-surface-deviations` 74 → 68 并收紧到实测；两个模块未消费符号仍为 0；跨 context 内部文件对与越 DAG 文件对不变
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-482 collaboration 取 task-execution 的事务参与者与三个小查询改经装配期绑定（RFC-294 S9 第三步）`。走私有 index、按路径
清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
