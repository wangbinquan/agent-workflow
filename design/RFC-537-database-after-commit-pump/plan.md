# RFC-537 实施计划

依赖：RFC-536。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-537-T1 句柄上下文的槽与挂接**：`DatabaseHandleContext` 加 `afterCommit` 槽；`runtime.ts` 改为 `attachAfterCommitEventPump(handle, pump)` 与
  `publishCommittedEventsAfterCommit(handle, eventRefs)`，删去模块级变量与两个登记函数（design D1）。
- **RFC-537-T2 写方**：25 处调用补上提交所用的句柄（design D2）。
- **RFC-537-T3 daemon 会话**：`after-commit-event-pump` 句柄挂在 `input.db` 上、停止时摘除（design D3）。
- **RFC-537-T4 用例与锁**：新增 RFC-537 用例并登记 guard-manifest；测试助手与读旧形状的用例随改（design D4）。
- **RFC-537-T5 集中验证**：backend `tsc`、eslint、prettier；按 RFC-533 的口径与被改名字的字符串形态选用例、按分段拼出的路径补搜，红的与 HEAD
  同时 A/B（长扫描用例在两边副本里放大时限跑到底）；架构报告对照；变异验证。
- **RFC-537-T6 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 4 项第五步。

## 验收清单

- [ ] AC-1 `runtime.ts` 没有模块级状态与登记函数；泵挂在句柄上下文上，daemon 会话挂在自己的库上、停止时摘下
- [ ] AC-2 25 处写方按提交所用的句柄投递；两个库各投各的、事务句柄取到客户端的泵；空批次 / 无泵 / 抛错的结局不变
- [ ] AC-3 模块级可变单例 58 → 56、计数不升；锁随改；新增 RFC-537 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-537 已提交事件的即时投递泵随数据库句柄走（RFC-294 S12 第十八步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
