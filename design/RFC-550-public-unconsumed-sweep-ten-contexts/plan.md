# RFC-550 实施计划

依赖：RFC-549。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-550-T1 撤出**：按 design §1 的规则逐 context 撤出，挪进内部的按 §2 落位；迭代复采到十个 context 为 0。
- **RFC-550-T2 门与用例**：`architecture/counts.json` 的上限随之降低；逐名清单 fixture；新增 RFC-550 用例并登记 guard-manifest；随改经 public
  取这些名字的用例。
- **RFC-550-T3 集中验证**：backend `tsc`、eslint、prettier；按 RFC-533 的口径、被改名字的字符串形态、读被改源码的测试助手、子进程夹具与两跳的
  测试助手与 `tests/fixtures/` 里的摘要锁选用例；红的与 HEAD 同时 A/B；架构报告对照（含公开面）；变异验证。
- **RFC-550-T4 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S9 第六步。

## 验收清单

- [ ] AC-1 十个 context 的未消费 public 符号为 0；撤出的名字不再从它们的 public 导出
- [ ] AC-2 行为不变
- [ ] AC-3 减速带上限随之降低；新增 RFC-550 用例并登记；读旧位置的用例随改
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（与 RFC-549 转 Done 同一提交）；实现与验证后再提交
`refactor(backend): RFC-550 十个 context 的未消费 public 符号清零（RFC-294 S9 第六步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
