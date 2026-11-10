# RFC-479 实施计划

**前置**：RFC-478 落地（Done，`0133385a8` / `27a42a3aa`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中
验证一次；不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                                                                                                  | 依据         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| RFC-479-T1 | `checkCounts` 低于上限判红、返回值只剩 `errors`；调用方随改；4 项 `max` 收紧到实测                                                                                                                    | design §2    |
| RFC-479-T2 | `publicContractGateSets`（未消费 public 符号、public 类型偏差）并进 `reportGateSets`；报告复用 surfaces；基线渲染去重                                                                                 | design §3    |
| RFC-479-T3 | `compositionControlFlowSets`（19 项 `composition-control-flow-<module>`）并进 `reportGateSets`                                                                                                        | design §4    |
| RFC-479-T4 | `architecture/counts.json` 登记 21 项新计数（`max` = 实测，`reason` 写口径）                                                                                                                          | design §2–§4 |
| RFC-479-T5 | 用例：`checkCounts` 的低于上限分支；新增 RFC-479 用例（两类新门的 fixture 变异与真实语料对账）；`rfc376-report` 项数；guard-manifest                                                                  | design §6    |
| RFC-479-T6 | RFC-294 plan §1.2 增列「结构锁 / 覆盖范围」并逐行填写；plan §3 S10 记一句「删掉 composition 控制流的临时减速带」；`docs/dev-gotchas.md` 一条                                                          | design §5    |
| RFC-479-T7 | 集中验证（`tests/architecture/**`、RFC-294 相关守卫、文档用例、`tsc` / eslint / prettier；改动只在用例与账本，全量按受影响范围定）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI；收尾 | design §6    |

## 验收清单

- [ ] AC-1 `counts.json` 每项 `max` = 实测；低于上限即红（带负对照）
- [ ] AC-2 `unconsumed-public-symbols`、`public-surface-deviations` 入带，与报告章节逐条相同，各有会红的变异用例
- [ ] AC-3 19 项 `composition-control-flow-<module>` 入带，与 F13 口径的差异逐条说明，有会红的变异用例
- [ ] AC-4 RFC-294 plan §1.2 新列没有空格、逐行可复核
- [ ] AC-5 受影响用例全部通过；exact SHA CI 全绿

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`test(architecture): RFC-479 治理补洞——减速带上限 = 实测、public 合同两项计数与 composition 控制流入带（RFC-294 S11）`。走私有 index、
按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
