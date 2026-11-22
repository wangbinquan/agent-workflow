# RFC-534 终态工作区回收策略与记忆蒸馏策略由会话交入（RFC-294 S12 第十五步）

- **状态**：Done（2026-11-22，落地 `252c54a28`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S12（装配余项）第 4 项（模块级可变单例）的第二步；
  design §3 常驻规则 5、§14“模块级可变单例（生产态，bootstrap 外）0”。
- **前序**：[RFC-533](../RFC-533-session-child-task-budget/proposal.md)（S12 第十四步：子任务预算由会话构造）。

## 1. 背景

daemon 的启动程序有一个 `process-registrations` 启动步（prepare 阶段，失败即停），它把两条策略写进进程级的模块状态：

1. **终态工作区回收策略**（task-execution `infrastructure/terminalWorkspacePrune.ts` 的模块级变量与 `registerTerminalWorkspacePrunePolicy`）：daemon
   交 integration 组合的 webhook 回收策略——webhook 发起的任务转入 `done` / `canceled`、且设置“webhook 任务结束后自动清理工作区”开着时，在终态
   转移的同一笔 CAS 里盖上回收认领。读它的有四处：运行期生命周期写者、取消、源终止与遗留的 `setTaskStatus`。
2. **记忆蒸馏准入策略**（memory `application/distill/schedule.ts` 的模块级变量、setter 与测试用的 reset）：daemon 交一个每次重读配置的读取器，
   `enqueueDistillJob` 每次入队前读它。

这一步还在每次执行恢复（暂停后再恢复）之前重跑一次——同一进程里别的会话可能已经改写了这两份进程级状态，只能靠重登记找回来。架构报告的
模块级可变单例清单里这两个文件占 5 条（全仓 71 条）。另外，维护 Worker 是另一个 JS realm，主线程的登记到不了那里：Worker 里的回收策略一直
是空的。

## 2. 目标

- **G1 回收策略由会话交入**：task-execution 的持久化依赖加必填的回收策略，daemon 装配 task-execution 时交 integration 组合的 webhook 回收策略；
  四个读者都读本会话交入的这一份；维护 Worker 交具名的“从不回收”策略（与此前相同）。`terminalWorkspacePrune.ts` 不再有模块级状态与登记函数。
- **G2 蒸馏策略由会话交入**：memory 的组合输入加必填的蒸馏策略读取器，daemon 装配 memory 时交每次重读配置的那一份；`enqueueDistillJob` 显式收
  策略。`schedule.ts` 不再有模块级状态与 setter / reset。
- **G3 删去登记步**：`process-registrations` 启动步与只为它存在的恢复前钩子（`beforeResume`）一并删去。
- **G4 门与用例**：新增 RFC-534 用例（两个文件没有模块级可变状态与导出的登记函数；daemon 把两条策略交进会话的装配、不再有该启动步；两份
  会话各用各的策略；带负对照）；读旧形状的锁与用例随改；模块级可变单例清单 71 → 66。

## 3. 非目标

- 其余 66 条模块级可变单例（执行看门、按对象挂的侧表、`transport-projections` 等其余登记、platform / util 的进程级缓存等）：另立后继。
- 两条策略本身的判定、回收认领的原子性（仍在终态转移的同一笔 CAS 里、策略在事务外算好）与蒸馏准入语义不变。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：两个文件没有模块级可变状态与导出的登记函数；回收策略与蒸馏策略每个会话一份，由 bootstrap 在装配时交入；维护 Worker 交从不回收。
- **AC-2**：`process-registrations` 启动步与 `beforeResume` 删去；webhook 任务的终态回收（含取消与源终止的回收认领）与蒸馏准入与此前相同。
- **AC-3**：模块级可变单例清单 71 → 66，计数不升；钉住旧形状的锁随改，新增 RFC-534 用例并登记 guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
