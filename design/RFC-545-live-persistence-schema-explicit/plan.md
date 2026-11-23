# RFC-545 实施计划

依赖：RFC-542。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-545-T1 live 绑定是常量**：删去 `schema/tables.ts` 的登记与读取，bootstrap 导出常量（design D1）。
- **RFC-545-T2 显式交入**：PostgreSQL 客户端与 provider 运行期选项必填 `liveSchema`，各入口沿 `contract` 的通路交入（design D2）。
- **RFC-545-T3 `tablesOf`**：句柄上下文记 live 绑定，`tablesOf` 据此核对（design D3）。
- **RFC-545-T4 用例**：新增 RFC-545 用例并登记 guard-manifest；随改 design D4 所列用例与测试助手。
- **RFC-545-T5 集中验证**：backend `tsc`、eslint、prettier；按 RFC-533 的口径、被改名字的字符串形态、读被改源码的测试助手与 `tests/fixtures/`
  里的摘要锁选用例；红的与 HEAD 同时 A/B（两边都撞写死时限的用例在两边副本里放大时限跑到底）；架构报告对照（含公开面）；变异验证。
- **RFC-545-T6 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 4 项第十二步。

## 验收清单

- [ ] AC-1 `schema/tables.ts` 没有模块级状态；bootstrap 只导出常量；客户端与 provider 运行期选项显式收下 live 绑定
- [ ] AC-2 两种引擎的客户端与 `tablesOf` 的结局不变
- [ ] AC-3 模块级可变单例 48 → 46、计数不升；新增 RFC-545 用例并登记；读旧接口的用例随改
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-544 转 Done 的 CI）；实现与验证后再提交
`refactor(backend): RFC-545 live 持久化 schema 由组合根显式交给 provider 构造（RFC-294 S12 第二十五步）`。走私有 index、按路径清单提交，
在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
