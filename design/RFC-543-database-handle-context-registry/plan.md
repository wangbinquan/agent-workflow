# RFC-543 实施计划

依赖：RFC-542。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-543-T1 只记在句柄上**：`sessionTables.ts` 删去 `contexts`，上下文只记在句柄与原生客户端自己的属性上，不可扩展的句柄明确报错，查找只读
  属性（design D1）。
- **RFC-543-T2 用例**：新增 RFC-543 用例并登记 guard-manifest（design D2）。
- **RFC-543-T3 集中验证**：backend `tsc`、eslint、prettier；按 RFC-533 的口径、被改名字的字符串形态、读被改源码的测试助手与 `tests/fixtures/`
  里的摘要锁选用例，另加全部用 `new Proxy(` 的用例与 `helpers/competingWriter` 的导入方（RFC-542 教训）；红的与 HEAD 同时 A/B（两边都撞写死
  时限的用例在两边副本里放大时限跑到底）；架构报告对照（含公开面）；变异验证。
- **RFC-543-T4 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 4 项第十一步。

## 验收清单

- [ ] AC-1 `sessionTables.ts` 没有模块级集合；上下文只记在句柄与原生客户端自己的属性上
- [ ] AC-2 各种句柄取到的上下文不变；不可扩展的句柄在构造时明确报错
- [ ] AC-3 模块级可变单例 48 → 47、计数不升；新增 RFC-543 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-542 转 Done）；实现与验证后再提交
`refactor(backend): RFC-543 数据库句柄上下文只记在句柄上（RFC-294 S12 第二十四步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
