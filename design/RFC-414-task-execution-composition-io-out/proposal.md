# RFC-414 task-execution composition 不再直接读写数据库、文件系统与 git（RFC-294 S6）

- **状态**：In Progress（2026-11-01 落档并开始实施）。用户 2026-10-30「你继续推进RFC294，……过程中按你的判断来推进，不用询问我」；2026-10-31
  「后面的工作你可以不用启动codex来做，你自己完成」：本会话调研、设计、实施与集中验证，不派 Codex；取舍由本会话按推荐决定（见 §6，可推翻）。
  纯结构重构，无用户可见变化。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S6 退出门「task-execution `composition/` 只剩装配」
- **前序**：[RFC-413](../RFC-413-task-execution-wrapper-workspace-merge-recovery/proposal.md)（wrapper 工作区、账本与合并恢复迁出 composition）
- **落位**：task-execution `infrastructure/`（查询与本地 I/O 适配器）、`composition/`（只剩绑定与对 bootstrap 的导出面）

## 1. 背景

RFC-413 之后，task-execution `composition/` 仍有八处直接做 I/O，不是装配：

| 文件                                 | I/O                                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `workspacePreparationMaintenance.ts` | 扫 `task_workspace_preparations` 表、按前缀与年龄筛选并逐条补偿（孤儿 / scratch GC 相位） |
| `crewstationExecution.ts`            | 读 `tasks.worktree_path` 判定托管工作区的物理归属                                         |
| `crewstationRecovery.ts`             | 读 `tasks.status`                                                                         |
| `actionExecutionRunners.ts`          | 读 `tasks.status`；本地工作区入口检查用 `existsSync`                                      |
| `digitalEmployeeExecution.ts`        | 人审闸门快照读 `tasks.inputs` 与 `node_runs`；执行元数据读 `tasks` 两列                   |
| `nodeExecution.ts`                   | 零增量告警的规范 delta 直接调 `util/git` 的 `worktreeFilesChanged`                        |
| `taskImageExecution.ts`              | 托管任务镜像操作（`rmSync` 等文件系统动作与脚本执行入口）                                 |
| `taskImageArchive.ts`                | 托管任务归档清单（`lstatSync` / `readdirSync` / `createReadStream`）                      |

## 2. 目标

- **G1 查询进 infrastructure**：上表的库读写改为 `infrastructure/` 下的具名查询（同一个读只保留一份实现），composition 只把它们绑进端口。
- **G2 本地 I/O 进 infrastructure**：工作区入口检查、规范 delta、托管任务镜像操作与归档迁入 `infrastructure/`；bootstrap 仍经 composition 的导出面取用。
- **G3 结构锁**：task-execution `composition/` 不 import `drizzle-orm`、`platform/persistence/sessionTables`、`platform/persistence/queryHelpers`、
  `node:fs`、`node:fs/promises`、`node:child_process`、`@/util/git`，不调用 `tablesOf(`、`Bun.spawn(`。
- **G4 纯结构**：查询的列、条件与排序，GC 的前缀 / 年龄 / 补偿顺序与计数，托管操作的路径校验、拒绝码与返回形状，零增量告警的判定全部不变。

## 3. 非目标

- composition 里不碰 I/O、但仍含应用逻辑的部分（数字员工执行核心、动作执行运行器的编排、托管代理调用准备等）——另立 RFC。
- 其它模块的 composition。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1 迁移**：八处 I/O 不在 composition（结构锁锁定，含负例）。
- **AC-2 行为不变**：GC、托管执行 / 恢复、动作运行、数字员工、零增量告警、托管任务镜像的既有用例与 P0 变异 lane 全部通过，断言意图不变。
- **AC-3 守卫**：按旧路径取语料的锁随 owner 改指；新结构锁带负例。
- **AC-4 账本**：counts / commons-debt / guard-manifest / Windows paths 按实测更新，只降不升。
- **AC-5 CI**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **只搬 I/O，不搬编排**：本 RFC 让 composition 不再碰持久化与文件系统；数字员工执行核心等应用逻辑的归位牵涉启动内核类型的位置，单独立 RFC。
2. **bootstrap 的导出面留在 composition**：托管任务镜像的两个入口由 bootstrap 调用，bootstrap 只依赖模块 composition / public，故 composition 保留
   只做再导出的入口文件。
3. **偏离项**：落档时无；实施中接受的偏差记在 plan「实施记录」。
