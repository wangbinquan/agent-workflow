# RFC-478 `services/task.ts` 按内容分层归 task-execution（RFC-294 W9-D，task-execution 一族收尾）

- **状态**：Done（2026-11-10，落地 `0133385a8`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09
  再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审
  功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.7 的 task-execution 一族（W4-E1）的最后一个文件；
  [review-2026-11-09](../RFC-294-backend-layered-target-architecture/review-2026-11-09.md) §7：E1 与 S9 共享
  `task-execution/public/operations.ts`、二者串行且 E1 先做，S12 的「`taskExecutionModule` 不在 import 期构造」也排在 E1 之后。
- **前序**：[RFC-477](../RFC-477-rollback-limits-launch-preflight-owners/proposal.md)（同一族的另外五个文件；依赖运行时驱动的三个文件随运行时
  驱动一族）；RFC-287 G7 与 RFC-359 AC-1（延后仓库准备）；RFC-109（工作流同步预览）；RFC-203 T4（任务失败码）；RFC-103 / 115 / 266 /
  269（运行时选项漏斗）；RFC-328（effect 现场）。

## 1. 背景

`services/task.ts`（1793 行）是 `services/` 里最大的一个文件，也是 `R1`（非模块文件取模块内部）27 条里 9 条的来处。它不再含启动路径
（RFC-363 / RFC-424 之后），余下的内容按性质分成几类：

1. **延后仓库准备**（约 1000 行）：驱动认领后第 0 步的描述读取、准备执行（合成 `__repo_prep__` 行、RFC-328 `workspace-prepare` effect、
   网络失败的窗口重试、取消 / 停机 / 离开准备窗口三种收场、回填事务）、重试前的残骸回收（目录、镜像注册项、分支与 ref 锁）。
2. **工作流同步预览**（RFC-109）：冻结闭包、读节点运行与产出端口、静态校验、触发预检，拼出预览；配套的纯函数（运行摘要、快照解析）。
3. **任务详情读投影**：`getTask` 与批量的 `loadTaskFailureCodes`。
4. **运行时选项漏斗** `runtimeConfigOpts`（配置 → 驱动选项）与延后准备步骤的装配入口。
5. **纯函数**：内置工作流快照的布局三件套、同步回滚目标选择器。
6. **测试专用与死代码**：`isTaskActive` / `abortAllActiveTasks`（生产零调用方，17 / 9 个用例在用）、`TaskContinuationDependencies`
   依赖袋（生产只经 `Pick` 取字段）、`shutdownActiveTaskExecutions`（零调用方）。

生产消费方只有 7 个文件：bootstrap 的 `daemonModules/taskExecution.ts` 与 task-execution 自己的 6 个文件（两个 composition、四个
infrastructure）。用例侧 45 个文件 import 它，41 个文件以路径字面量读它（源码文本守卫）。

按 RFC-294 2026-11-09 的刷新：搬迁按内容分层落位（C10），不再把用例文件原样停在 infrastructure；public 不新增内部构件（C11）；
结构锁写明覆盖范围（C12）；收口时收紧触及的减速带（C13）。进度以结构规则与 design §14 的不变量报告，`services/` 文件数与 `R1`
条数只是 W9-D 的退出门之一（plan §0 第 8 条）。

## 2. 目标

- **G1 按内容分层**（C10）：纯函数进 `domain/`（布局三件套；运行摘要与快照解析并入既有的 `domain/workflowSyncPreview.ts`）；同步预览
  作为 application 查询、经 task-execution 自有的读端口取数据，同步回滚目标选择器与它的兄弟 `selectResumeRollbackTargets` 同处
  `application/resumeRollbackTargets.ts`；延后仓库准备（读取、执行、残骸回收）与任务详情读投影进 `infrastructure/`；运行时选项漏斗与
  准备步骤的装配进 `composition/`。
- **G2 不新增跨 context 内部 import**：延后准备对 source-control 的全部 effect 只经既有的 consumer 自有端口
  `TaskRepositoryPreparationBinding`（bootstrap 装配）；该端口多一个与 `groupName` 同源的 `groupCachedRepoIds`；端口在这一步改为必填，
  没有调用方的「无绑定」回落分支删除。`cross-context-internal-file-pairs` 不升。
- **G3 测试专用出口离开生产树**：`isTaskActive` / `abortAllActiveTasks` 与依赖袋迁入 `tests/helpers/`；`shutdownActiveTaskExecutions` 删除。
- **G4 public 收口**（design §3 常驻规则 11 / 12）：迁移后失去模块外生产消费方的 task-execution public 符号当场撤出（预计含
  `public/operations` 的 `mintNodeRun`、`setTaskStatus`，即 S9 第 1 项点名的兼容写原子中的两个）；不新增 public 符号。
- **G5 账本与减速带**：`R1` 27 → 18（按实测销账）；`services/` 48 → 47；本 RFC 触及的减速带收口时收紧到实测（C13）。

## 3. 非目标

- design §5.6 记在 W4-E1 名下的 `infrastructure/taskRouteLaunchOperations.ts`（1457 行）归 application：它直接用 drizzle 与平台持久化、
  取 9 个同层文件，归位要先把这些切成端口，规模与 S6 的一步相当，另立后继 RFC（理由见 §6 第 1 条）。
- `public/operations` 余下的兼容写原子与其他模块外使用方（S9 第 1 项）；未消费 public 符号的存量清理（S9 第 3 项）。
- `taskExecutionModule` 改由工厂图构造（S12 第 3 项；本 RFC 只去掉 `services/task.ts` 这个全局使用方）。
- 行为：延后准备的读取、执行、重试窗口、三种收场与回填，同步预览的内容与问题码，任务详情与失败码，运行时选项的取值，全部逐字不变。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：`services/task.ts` 不在、零引用（import、路径字面量、Markdown 链接）；`R1` 里没有它的边；测试专用出口只在 `tests/helpers/`。
- **AC-2**：行为不变——延后仓库准备（含重试回收、取消 / 停机 / 离开窗口、回填）、同步预览、任务详情与失败码、运行时选项由既有用例
  覆盖，都改走新位置。
- **AC-3**：架构计数按实测（`R1` 27 → 18），账本逐条相等；`cross-context-internal-file-pairs`、off-DAG、值环、public 偏差与未消费
  public 符号都不升；新增文件按内容分层（domain 纯、application 不取 infrastructure / legacy）；触及的减速带收紧到实测。
- **AC-4**：受影响用例与新增 RFC-478 用例全部通过；四个包的用例都跑。
- **AC-5**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **只做 `services/task.ts`，启动用例的归位另立**：刷新后的总纲要求 E1 先于 S9，卡住 S9 的只是 `services/task.ts`（它在模块外取
   `public/operations` 的写原子）；`taskRouteLaunchOperations.ts` 在模块内，不碰 `public/operations`，与 S9 不冲突。把它并进来会让本 RFC 的
   改动面翻倍（再加 1.4k 行与它的 9 个同层依赖的端口化），验证面与回归面同步放大。
2. **source-control 的 effect 只走既有的 consumer 自有端口**：原样搬进 infrastructure 会把两条 `R1` 变成一条 task-execution →
   source-control `composition` 的跨 context 内部文件对；改经 `TaskRepositoryPreparationBinding`（RFC-363 起由 bootstrap 装配、task 自有的
   provider 绑定）就不新增越界。为此端口加一格 `groupCachedRepoIds`（与已有的 `groupName` 同源：同一个 `resolveRepoGroupLayout`、同一个
   仓库工作区存储）。
3. **绑定必填、删「无绑定」回落**：bootstrap 与全部用例装配都传绑定，`materializeSpaceWithProvider` 直调、`repositoryWorkspace` 回落与
   `journaled-repository-preparation-binding-missing` 守卫没有调用方；删除优于保留（CLAUDE.md「面向代码最合理」）。离开准备窗口时对
   非日志化准备的清理改经绑定的 `legacy.cleanup`：对延后准备的空间与原来的租约清理相同（`materializingSpaces` 只登记 scratch，这里的
   来源只有缓存仓与仓库组；生产上两边都不传清理钩子）。
4. **同步预览进 application**：它是路由操作调用的查询用例（design §3 常驻规则 10），读取经 task-execution 自有端口
   `WorkflowSyncPreviewReads`（四个读：节点运行、每节点最新 done 顶层行、产出端口、冻结触发上下文），实现在 infrastructure。
5. **测试专用出口进 `tests/helpers/`**：生产零调用方；`TaskContinuationDependencies` 的生产用处只有两处 `Pick`，在 task-execution 里按字段
   写成显式类型。
