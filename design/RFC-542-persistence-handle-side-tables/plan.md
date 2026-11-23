# RFC-542 实施计划

依赖：RFC-541。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-542-T1 行规则标记**：`rowRules.ts` 删去 `boundSessions`，“已套过”记在会话对象自己的符号属性上（design D1）。
- **RFC-542-T2 单行写入**：`singleInsert.ts` 删去 `inserts`，带围栏的单行写入记在根库对象自己的符号属性上（design D2）。
- **RFC-542-T3 用例**：新增 RFC-542 用例并登记 guard-manifest（design D3）。
- **RFC-542-T4 集中验证**：backend `tsc`、eslint、prettier；按 RFC-533 的口径、被改名字的字符串形态、读被改源码的测试助手与 `tests/fixtures/`
  里的摘要锁选用例，红的与 HEAD 同时 A/B（两边都撞写死时限的用例在两边副本里放大时限跑到底）；架构报告对照（含公开面）；变异验证。
- **RFC-542-T5 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 4 项第十步。

## 验收清单

- [ ] AC-1 `rowRules.ts` 与 `singleInsert.ts` 没有模块级集合；标记与单行写入记在各自的对象上
- [ ] AC-2 行规则翻译与单行写入的结局不变
- [ ] AC-3 模块级可变单例 50 → 48、计数不升；新增 RFC-542 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-541 转 Done）；实现与验证后再提交
`refactor(backend): RFC-542 行规则错误翻译与单行写入的按句柄侧表归各自的句柄（RFC-294 S12 第二十三步）`。走私有 index、按路径清单提交，在共享
发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
