# RFC-539 实施计划

依赖：RFC-538。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-539-T1 计数器与句柄上下文**：新增 `platform/persistence/fileSnapshots.ts`；`DatabaseHandleContext` 加 `fileSnapshots`，`fileSnapshotTrackerOf(handle)`
  取回（design D1）。
- **RFC-539-T2 快照方与读者**：`systemProviderBackup.ts` 删去模块级计数与 `isDbSnapshotInProgress`，两个离线程函数与 checkpoint 一拍收计数器，
  `createBackup` 取所快照库的那一份（design D1）。
- **RFC-539-T3 会话**：SQLite 维护适配器取会话库的计数器；迁移模块、迁移协调器与迁移安全备份收会话交来的那一份，命令行各建一份（design D2）。
- **RFC-539-T4 用例与锁**：新增 RFC-539 用例并登记 guard-manifest；读旧形状的三个用例随改（design D3）。
- **RFC-539-T5 集中验证**：backend `tsc`、eslint、prettier；按 RFC-533 的口径、被改名字的字符串形态、读被改源码的测试助手与 `tests/fixtures/`
  里的摘要锁选用例，红的与 HEAD 同时 A/B（两边都撞写死时限的用例在两边副本里放大时限跑到底）；架构报告对照（含公开面）；变异验证。
- **RFC-539-T6 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 4 项第七步。

## 验收清单

- [ ] AC-1 `systemProviderBackup.ts` 没有模块级计数；在途计数挂在句柄上下文上，会话把自己库的那一份交给迁移安全备份与维护服务
- [ ] AC-2 快照期间 checkpoint 跳过、结束后执行；两个库的快照互不挡对方；worker 回退与校验失败的结局不变
- [ ] AC-3 模块级可变单例 55 → 54、计数不升；锁随改；新增 RFC-539 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-538 转 Done）；实现与验证后再提交
`refactor(backend): RFC-539 SQLite 文件快照的在途计数随数据库句柄走（RFC-294 S12 第二十步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
