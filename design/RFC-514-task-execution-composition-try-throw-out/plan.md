# RFC-514 实施计划

依赖：RFC-513；与 S12 共用模块 composition 文件（本 RFC 只改 task-execution `composition/` 下的 3 个文件；装配入口不变）。按 CLAUDE.md 文首硬
规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-514-T1 归位**：新增 `engine/task/driveTaskRun.ts` 与 `application/dynamicWorkflowOperations.ts`；`application/taskRunSelection.ts` 增
  `createTaskRunConfigurationReferences`，`application/digitalEmployeeExecution.ts` 增 `cancelAndReadTask`（design D1）。
- **RFC-514-T2 composition 只装配**：三个组合文件改为调用新位置（design D2）。
- **RFC-514-T3 账本与锁**：`counts.json` 一项收紧；guard-manifest 登记（`assertsAbsence: true`）；`rfc423` 的 throw 账本与 try 豁免、t19b 的占位账本
  同步改（design D3）。
- **RFC-514-T4 用例**：新增 RFC-514 用例（design §4）。
- **RFC-514-T5 集中验证**：backend `tsc`、eslint、prettier；直接取改动文件的用例、按名字、路径与错误串扫出的用例与全部 `tests/architecture/`，按 CI
  的跑法与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照；全仓旧位置扫描。全量语料交给 CI 的 backend 分片。
- **RFC-514-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 清单里的名字只在各自的位置声明；三个组合文件不再有 `try` / `throw`；装配入口与导出的名字、签名不变
- [ ] AC-2 同样输入下驱动、回收与三处 fail-closed 的行为、错误与时机和此前一致
- [ ] AC-3 新位置的依赖面是闭集；public surface 不升；`composition-control-flow-task-execution` 收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

【待补】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-514 任务执行组合层余下的 try / throw 迁出 composition（RFC-294 S10 第二十一步）`。走私有 index、按路径清单提交，在共享发
布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
