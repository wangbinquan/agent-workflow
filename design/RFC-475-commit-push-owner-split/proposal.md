# RFC-475 自动提交推送按 owner 拆开：git 发布归 source-control、提交行记账归 task-execution（RFC-294 W9-D 第二十二步）

- **状态**：In Progress（2026-11-09）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09
  再次下达）：本会话调研、设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本
  会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.6 W9-D（`services/` 业务实现按 owner 归位、越界边收口）
- **前序**：RFC-075（自动 commit&push：框架自己跑 git，commit agent 只写消息与修复被拒的推送）；RFC-210（子仓递归提交推送）；RFC-076 C4（写锁
  只括索引采集与本地提交）；RFC-308（提交候选与排除策略的 binder，「Git mechanics stay private to source-control」）；RFC-321（一次发布一个
  传输会话）；RFC-328（外部副作用由 effect observer 括住）；RFC-370（selected Git 工作区）；[RFC-412](../RFC-412-task-execution-scheduler-residue/proposal.md)
  （commit&push 尾段迁入 task-execution engine，runner 与 commit-agent 辅助经 composition 绑定进入）。
- **落位**：source-control 新增 application 用例 `workspaceChangePublication.ts`、domain `stagedChangeSummary.ts`（并给 `repositoryPushFailure.ts`
  增补），composition 新增 `workspaceChangePublication.ts` 与 `repositoryCommit.ts`（提交 binder 从 `composition.ts` 移入），经 `public/` 交出；
  task-execution 新增 `infrastructure/commitPushAttempt.ts`（提交行与 effect 记账）与 `domain/commitAgent.ts`（内置 commit agent 与提示词）；
  子仓列表的两个纯函数进 `util/git.ts`；`services/commitPushRunner.ts`、`services/commitPush.ts` 删除。

## 1. 背景

`R1`（非模块文件取模块内部）余 38 条，其中 4 条出在 `services/commitPushRunner.ts`（1075 行）：取 task-execution 三个 application 端口的类型，
取 source-control `composition` 的提交 binder 与推送失败分类。这个文件做的是两个 owner 的事：

1. **task-execution 的记账**：每次提交 mint 一条 commit-push 容器行（挂在触发它的 agent 运行下）、登记 repository effect（RFC-328）、收尾写
   `commit_push_json` 与行状态、把 commit agent 的会话 id 落到行上。
2. **source-control 的 git 发布**：子仓递归提交推送（RFC-210）、暂存与排除策略（RFC-308 binder）、diff 采集、本地提交、在一个 RFC-321 传输
   会话里推送 / 非快进 fetch + merge / LLM 修复后重推 / 推后校验。

整体迁去哪边都会越界：迁进 task-execution，`push` / `fetch` / `merge` / `ls-remote` / `checkout -B` 这些 git 机制就进了 task-execution，违背
RFC-308 的「git 机制留在 source-control 内」；迁进 source-control（架构报告的 owner 表就把它记在 source-control 名下），又要 source-control
取 task-execution——目标 DAG 上 source-control → task-execution 只有 required-implementation 的 `RepositoryPreparationLookup`，没有 offered 边。

`services/commitPush.ts`（316 行）同样是两半：内置 commit agent、提示词、输出语言指令、提交节点 id 属于 task-execution（与 task-execution
`domain/dynamicWorkflowOrchestrator.ts` 的编排 agent 同类）；推送失败分类、numstat 汇总、diff 截断、兜底提交消息、推送错误脱敏属于 git 发布。
另有三个函数只剩用例在调：`shouldConsiderCommit`（生产上的提交判据在 `engine/scope/runScope.ts`）、`parseCommitMessageFromEnvelope`（生产从
agent 运行结果的端口取消息）、`isCommitPushNodeId`。

子仓递归要用的两个列表纯函数 `usableSubmodules` / `bottomUp` 在 `services/gitSubmodule.ts`；source-control 的 application 层不能取 `services/`
（`R2`），platform 的隔离工作区也在用它们。

## 2. 目标

- **G1 git 发布归 source-control**：新增 application 用例 `publishWorkspaceChanges`，把 runner 的 git 一半原样迁入（子仓阶段、暂存与采集、消息
  生成、本地提交、发布会话内的推送 / 修复 / 校验）。它只经注入的工作区 scope、提交 binder、发布传输与消息作者端口做事，返回 `CommitPushMeta`。
  经 public `bindWorkspaceChangePublication` 交出；合同都是闭合接口，不带函数类型属性、守护进程 Logger 或开放类型。
- **G2 提交行记账归 task-execution**：新增 `infrastructure/commitPushAttempt.ts` 的 `runCommitPush`（签名不变；engine 端口 `effects.runCommitPush` 的 act site）：绑定工作区、mint 容器行、登记
  effect、调 source-control 发布、按结果写行与 effect。commit agent 的会话 id 由它包住的消息回调记录。
- **G3 两个 `services/` 文件退役**：commit agent 一族归 task-execution `domain/commitAgent.ts`，git 发布的纯判定归 source-control domain，
  `services/commitPush.ts` 与 `services/commitPushRunner.ts` 删除。只剩用例调用的三个函数：`shouldConsiderCommit` 与 `parseCommitMessageFromEnvelope`
  删除（连同只测它们的用例段），`isCommitPushNodeId` 移入用例 helper（两个用例拿它当判据）。
- **G4 子仓列表纯函数**：`usableSubmodules` / `bottomUp` 迁入 `util/git.ts`（与 RFC-377 迁去的其他子仓原语同处，按结构泛型），platform 与
  source-control 都从那里取。
- **G5 账本**：`R1` 38 → 34（按实测销账）；`services/` 57 → 55，`legacy-horizontal-files` 与 `legacy-service-implementations` 各 −2；public
  surface 偏差与未被消费的 public 符号不升（失去模块外消费方的 task-execution `repositoryPublicationOrdinal`、source-control
  `bindRepositoryGitSubworkspace` 两个转出当场收回）；跨 context 内部文件对与 off-DAG offered 文件对按实测（runner 取 task-execution 的边消失）。

## 3. 非目标

- 其余 `R1`：`services/task.ts`（9）、`services/systemAgentRun.ts`（5）、`services/runtimeSmoke.ts`（4）、运行时驱动一族（9）、
  `services/nodeRollback.ts`（3）、`services/reviewMutationCoordinator.ts`（2）、`services/taskDelete.ts`（2）。
- `services/gitSubmodule.ts` 与 `services/mergeAgent.ts` 的归属：platform 的隔离工作区在用它们，随 source-control 一族另行处理。
- 行为：提交 / 推送的 git 命令序列、写锁区间、提交消息、错误文本（含落进 `commit_push_json` 的 `pushError`）、行状态、effect 记录与日志
  字段逐字不变（唯一的次序差见 §6.3）。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：`services/commitPushRunner.ts`、`services/commitPush.ts` 不在、零引用（import、路径字面量、Markdown 链接）；`R1` 里没有它们的边。
- **AC-2**：行为不变——git 命令序列与锁区间、提交消息与兜底、推送结果与 `pushError`、行状态与 effect、会话 id、子仓结果由既有 commit-push
  用例覆盖（runner、RFC-210 三个、RFC-370 selected Git、RFC-098 非阻塞、RFC-205 凭据、scheduler 提交推送、输出语言指令、RFC-321 发布）。
- **AC-3**：架构计数按实测（`R1` 38 → 34），账本逐条相等；public surface 偏差、未被消费的 public 符号与越界类计数不升。
- **AC-4**：受影响用例与新增 RFC-475 用例全部通过；四个包的用例都跑。
- **AC-5**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **按 owner 拆开，不整体迁移**：理由见 §1。拆开后 task-execution 只经 source-control 的 public 合同发布，source-control 不取 task-execution。
2. **source-control 合同用闭合接口**：消息作者（`compose` / `repair`）、写锁（`acquire` → `release`）、日志（`warn`）都写成接口方法，不用函数
   类型属性——public surface 偏差规则把函数类型属性与守护进程 Logger 记为开放类型。task-execution 一侧把原来的 `acquireWrite` 与两个生成
   回调适配过去；日志字段按 task-execution `WorkgroupTurnLogger` 的先例写成闭合的字段集。
3. **四个本地采集失败出口的次序**：暂存、`diff --numstat`、`diff --stat`、`diff` 任一步失败时，commit 行的收尾写（结果、状态、effect）改在
   释放写锁之后（原先在锁内）。写锁的约定范围是索引采集与本地提交（RFC-076 C4），收尾只写库、不碰工作树与索引；没有用例或用户可见行为
   依赖这个次序，保留它就要让 source-control 回调 task-execution 的记账。
4. **诊断 id**：source-control 的请求带 `nodeRunId`，只用于日志字段，键名与原日志一致。
5. **三个只剩用例调用的函数**：`shouldConsiderCommit` 与 `parseCommitMessageFromEnvelope` 删除，连同只测它们的用例段（生产上的提交判据与
   消息读取各有用例覆盖）；`isCommitPushNodeId` 移入用例 helper。
6. **提交 binder 移出 `composition.ts`**：`bindRepositoryCommitParticipant` 移到 `composition/repositoryCommit.ts`，`composition.ts` 照旧转出
   （用例从那里取）；新 binder 从模块根取它会把根 composition 的整张依赖带进 public 的 import 闭包。`classifyRepositoryPushFailure` 在
   `composition.ts` 的转出只剩用例在用，删除，用例改取 domain。
7. **子仓列表纯函数进 `util/git.ts`**：platform 不能取模块、source-control application 不能取 `services/`，两边共同能取的最低一层就是 git
   原语所在的 `util/git.ts`。
