# RFC-554 实施计划

依赖：RFC-553。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-554-T1**：删死的 `export *`；仓库端点发现挪进 integration 的 infrastructure，组合根与用例改取（design §1）。
- **RFC-554-T2 门与用例**：两份精确清单与 `counts.json` 降低；新增 RFC-554 用例并登记 guard-manifest。
- **RFC-554-T3 集中验证**：backend `tsc`、eslint（含 promises）、prettier；读已提交源码的用例在候选导出里跑；选用例；架构报告对照；变异验证。
- **RFC-554-T4 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记一行。

## 验收清单

- [ ] AC-1 `runtimeRegistry.ts` 没有 `export *`；仓库端点发现在 integration 的 infrastructure
- [ ] AC-2 行为不变
- [ ] AC-3 清单与减速带随之降低；新增 RFC-554 用例并登记；读旧位置的用例随改
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（与 RFC-553 转 Done 同一提交）；实现与验证后再提交
`refactor(backend): RFC-554 两个小结构门（RFC-294 S9 余项）`。走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact
SHA 跟 CI。
