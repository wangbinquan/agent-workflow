# RFC-551 实施计划

依赖：RFC-550。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-551-T1 判据**：类型形状遍历纳入非 private / protected 的构造参数属性（design §1）。
- **RFC-551-T2 撤出**：按 design §2 逐个撤出、挪进内部；迭代复采到两个 context 为 0。
- **RFC-551-T3 门与用例**：`architecture/counts.json` 上限降低；逐名清单 fixture；新增 RFC-551 用例并登记 guard-manifest；随改读旧位置的
  用例与清单。
- **RFC-551-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；按 RFC-533 的口径与 RFC-550 的选法选用例，先跑读源码文本的用例；
  架构报告对照；变异验证。
- **RFC-551-T5 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S9 第七步。

## 验收清单

- [ ] AC-1 两个 context 的未消费 public 符号为 0（全仓为 0）；撤出的名字不再从它们的 public 导出；判据把构造参数属性当作实例成员
- [ ] AC-2 行为不变
- [ ] AC-3 减速带上限随之降低；新增 RFC-551 用例并登记；读旧位置的用例与清单随改
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（与 RFC-550 转 Done 同一提交）；实现与验证后再提交
`refactor(backend): RFC-551 identity-access 与 source-control 的未消费 public 符号清零（RFC-294 S9 第七步）`。走私有 index、按路径清单提交，
在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
