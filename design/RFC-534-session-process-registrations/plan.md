# RFC-534 实施计划

依赖：RFC-533。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-534-T1 回收策略**：`terminalWorkspacePrune.ts` 删去模块级状态与登记函数，判定显式收策略，导出 `neverPruneTerminalWorkspaces`；持久化依赖、
  源终止输入、遗留写者与延迟仓库准备的依赖加必填字段；daemon 组合一次交给 task-execution 与 integration，维护 Worker 交从不回收（design D1）。
- **RFC-534-T2 蒸馏策略**：`schedule.ts` 删去模块级状态、setter 与 reset，`enqueueDistillJob` 显式收策略；memory 组合输入加必填字段，daemon 交
  原来登记的读取器（design D2）。
- **RFC-534-T3 登记步**：删去 `process-registrations` 启动步、它的实现与 `beforeResume`（design D3）。
- **RFC-534-T4 用例与锁**：新增 RFC-534 用例并登记 guard-manifest；登记 / 设置策略的用例改为交进装配；构造这些依赖与输入的用例补字段；
  钉启动步的锁随改（design D4）。
- **RFC-534-T5 集中验证**：backend `tsc`、eslint、prettier；改动文件的用例、读被改文件源码的用例（按路径主干、不带目录的文件名与删去的名字）、
  直接导入被改文件与其在 `src/` 里调用方的用例、全部 `tests/architecture/`，红的与 HEAD 同时 A/B；架构报告对照。
- **RFC-534-T6 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 4 项第二步。

## 验收清单

- [ ] AC-1 两个文件没有模块级可变状态与导出的登记函数；策略每会话一份；维护 Worker 交从不回收
- [ ] AC-2 登记步与 `beforeResume` 删去；回收与蒸馏准入不变
- [ ] AC-3 模块级可变单例 71 → 66、计数不升；锁随改；新增 RFC-534 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

【待补】

## CI（AC-4）

- 【待补：实现提交】

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-533 转 Done）；实现与验证后再提交
`refactor(backend): RFC-534 终态工作区回收策略与记忆蒸馏策略由会话交入（RFC-294 S12 第十五步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
