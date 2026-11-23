# RFC-540 实施计划

依赖：RFC-539。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-540-T1 处理器**：新增 `platform/persistence/sqliteLogicalSourceWorkerHandler.ts`，六种请求的处理与三份状态从入口逐字搬进
  `createSqliteLogicalSourceWorkerHandler(io)` 的闭包（design D1）。
- **RFC-540-T2 入口**：`sqliteLogicalSourceWorker.ts` 只建一个处理器，`onmessage` 交给它（design D2）。
- **RFC-540-T3 用例与锁**：新增 RFC-540 用例并登记 guard-manifest；`rfc349-database-migration-worker` 改钉处理器文件（design D3）。
- **RFC-540-T4 集中验证**：backend `tsc`、eslint、prettier；按 RFC-533 的口径、被改名字的字符串形态、读被改源码的测试助手与 `tests/fixtures/`
  里的摘要锁选用例，红的与 HEAD 同时 A/B（两边都撞写死时限的用例在两边副本里放大时限跑到底）；架构报告对照（含公开面）；变异验证。
- **RFC-540-T5 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 4 项第八步。

## 验收清单

- [ ] AC-1 Worker 入口与处理器文件没有模块级状态；入口只建一个处理器并把 `onmessage` 交给它
- [ ] AC-2 六种请求的结局不变；两个处理器各自初始化、互不相通
- [ ] AC-3 模块级可变单例 54 → 51、计数不升；锁随改；新增 RFC-540 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-539 转 Done）；实现与验证后再提交
`refactor(backend): RFC-540 SQLite 逻辑源 Worker 的状态归每个 Worker 的处理器（RFC-294 S12 第二十一步）`。走私有 index、按路径清单提交，在共享
发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
