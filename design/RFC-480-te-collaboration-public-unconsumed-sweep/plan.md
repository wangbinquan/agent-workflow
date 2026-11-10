# RFC-480 实施计划

**前置**：RFC-479 落地（Done，`0d591604b` / `673b1b53b`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中
验证一次；不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                                                       | 依据         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| RFC-480-T1 | 136 个转出撤掉；经 public 取用它们的本模块文件与用例改取定义处（codemod，按符号解析定义处）                                                                | design §1    |
| RFC-480-T2 | 直接声明在 public 的：31 个无使用方的删除；38 个有使用方的按内容挪进模块内部（落位表），使用方改取新位置                                                   | design §1–§2 |
| RFC-480-T3 | task-execution `public/operations` 退役：三处模块外使用改取平台定义处 / required port / composition，文件删除                                              | design §3    |
| RFC-480-T4 | 撤出 → 复采 → 再撤，迭代到两个模块的未消费计数为 0                                                                                                         | design §1    |
| RFC-480-T5 | 未消费符号按 context 分项入带（`publicContractGateSets`、`counts.json`、报告与 RFC-479 用例的口径断言）                                                    | design §4    |
| RFC-480-T6 | 新增 RFC-480 用例；用例改指；guard-manifest 与减速带收紧                                                                                                   | design §5    |
| RFC-480-T7 | 集中验证（静态、受影响用例、全量 SQLite 与 PostgreSQL lane 按受影响范围、架构报告对账）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI；收尾 | design §8    |

## 验收清单

- [ ] AC-1 两个模块的未消费 public 符号为 0；声明按内容落位
- [ ] AC-2 task-execution `public/operations.ts` 不在、零引用；三处使用改取新位置
- [ ] AC-3 未消费符号按 context 分项入带，上限 = 实测，两个模块为 0
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-480 task-execution 与 collaboration 的 public 收口——未消费符号清零、public/operations 退役（RFC-294 S9 第一步）`。
走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
