# RFC-481 实施计划

**前置**：RFC-480 落地（Done，`bb7da0e8d` + `489526d4a`，Done 文档 `c28b1a8d8`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现
与用例完成后集中验证一次；不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                                                                             | 依据         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| RFC-481-T1 | `PreparedHumanGateRef` 与两个端口（连同输入输出类型）挪进 task-execution，从 `public/types` 交出；collaboration 改取，删除自己的两个端口文件                                     | design §2    |
| RFC-481-T2 | task-execution 路由依赖删去 `collaboration` 字段；bootstrap 直接持有协作上下文                                                                                                   | design §2    |
| RFC-481-T3 | 两个帧函数的回调参数改为闭合接口；collaboration 的使用处随之改                                                                                                                   | design §2    |
| RFC-481-T4 | collaboration 的删除参与者工厂改由 `composition.ts` 交给 bootstrap，撤出 public                                                                                                  | design §2    |
| RFC-481-T5 | 新增 RFC-481 用例；两本账销账、`counts.json` 收紧、guard-manifest 登记；搜 `tests/` 与 `scripts/` 的文本断言随之改写                                                             | design §3–§4 |
| RFC-481-T6 | 集中验证（静态、读源码文本的用例先行、受影响用例、全量 SQLite 与 PostgreSQL lane 按受影响范围、架构报告对账）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI；收尾 | design §5    |

## 验收清单

- [ ] AC-1 task-execution 不取 collaboration 的 public（只剩 required-SPI 车道一条）；越 DAG 的 8 条销账
- [ ] AC-2 三组端口类型声明在 task-execution，collaboration 改取，collaboration 的 public 不再交出
- [ ] AC-3 两个开放类型与 collaboration 的一条类型污染销账；两项减速带收紧到实测；两个模块未消费符号仍为 0
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-481 task-execution 自有人工门端口——反向越 DAG 类型边清零与开放类型收口（RFC-294 S9 第二步）`。
走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
