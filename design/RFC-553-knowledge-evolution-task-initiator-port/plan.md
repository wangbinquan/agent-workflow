# RFC-553 实施计划

依赖：RFC-552。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-553-T1 合同**：task-execution `public/types` 交出 `DirectTaskInitiator`，composition 转出投影函数（design §1）。
- **RFC-553-T2 改取**：融合编排改取 public 类型；融合路由多 `directTaskInitiator` 依赖并改调；bootstrap 绑定。
- **RFC-553-T3 门与用例**：两份精确清单、模块分层违规清单与 `counts.json` 降低；新增 RFC-553 用例并登记 guard-manifest。
- **RFC-553-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；读已提交源码的用例在候选导出里跑；选用例；架构报告对照；变异验证。
- **RFC-553-T5 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S9 第九步。

## 验收清单

- [ ] AC-1 knowledge-evolution 不再 import task-execution 的 domain / inbound；类型经 `public/types`，投影经路由依赖交入
- [ ] AC-2 融合任务的启动人与原先相同
- [ ] AC-3 跨 context 内部文件对 17 → 15、模块分层违规 1 → 0；清单与减速带随之更新；新增 RFC-553 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（与 RFC-552 转 Done 同一提交）；实现与验证后再提交
`refactor(backend): RFC-553 knowledge-evolution 不再取 task-execution 的内部（RFC-294 S9 第九步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
