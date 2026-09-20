# RFC-362 实施台账与后继切换清单

源码基线：`475fbb43c09b3be0eeb0dc036c41bcbe508fc277`；只审功能。路径以下均相对 `packages/backend/src`。
RFC-362 仅新增声明、引用 codec、测试 provider 和账本；生产 launch/writer 不变。
21 文件账中 `server.ts` 的后续变化属于 RFC-360 的 RC participant 根注入，已单独保留基线 hash 与归属；其余 20 文件不变。

## 1. 当前入口、lane 和唯一写点

| 入口                           | 当前调用点 / owner                                                                                                                                                                                        | 准备 lane 与提交顺序                                                                                    | 对应行为 oracle（`packages/backend/tests/`）                                                                                         |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Workflow JSON                  | `modules/task-execution/infrastructure/taskRouteLaunchOperations.ts` 的 `createRootTaskLaunchKernel` / `createTaskExecutionLaunchParticipant`；`taskRouteOperations.ts` 调 `dependencies.launches.launch` | 请求决定 defer；repository 先 pending，drive 第 0 步准备。scratch/sourceTaskId 不延后                   | `rfc359-w5hn-workflow-route-launch-provider-parity.test.ts`、`rfc287-t13-deferred-prep.test.ts`                                      |
| Workflow multipart             | 同一个 root kernel，uploads 在 kernel 内强制取消 defer                                                                                                                                                    | buffer/validate → prepare → applyUploads → task transaction → lease.commit → drive；异常 rollback lease | `rfc359-w5hn-multipart-launch-provider-parity.test.ts`、`upload-apply-to-worktree.test.ts`                                           |
| Agent / Workgroup direct       | 同文件 `createAgentRouteLaunch` / `createWorkgroupRouteLaunch`，合成 workflow subject 后调 root                                                                                                           | direct 保持同步准备；不额外造一个 launch algorithm                                                      | `rfc359-w5hn-agent-launch-provider-parity.test.ts`、`rfc359-w5hn-workgroup-launch-provider-parity.test.ts`                           |
| scheduled / webhook / event    | 同文件 `createTaskExecutionLaunchParticipant` 根据 invoker 推导 origin/defer                                                                                                                              | root transaction 与直接启动相同；source termination 在 Task owner 内                                    | `rfc287-t13-deferred-prep.test.ts`、`rfc359-w5hn-launch-resources-delegated-authority.test.ts`                                       |
| 数字员工                       | `modules/task-execution/composition/digitalEmployeeExecution.ts` → 同一个 launch participant；RC host anchor 先 ensure                                                                                    | case/action refs 进入 root transaction，workspace 可为已有 caller-owned lease                           | `rfc359-w12-digital-employee-execution.test.ts`、`rfc319-task27-de28-manual-retry-and-host-anchor.test.ts`                           |
| call / child                   | `modules/task-execution/infrastructure/childExecutionLaunchOperations.ts` 的 `launchPreparedChild`                                                                                                        | 消费 `request.materializedSpace`，已物化；child lifecycle 保持父/帧归属                                 | `rfc359-w8-child-launch-conformance.test.ts`、`call-graph-worktree.test.ts`                                                          |
| fusion                         | `modules/task-execution/infrastructure/postgresqlFusionEngineTaskOperations.ts` 的 `launch`                                                                                                               | 已有 workspace 的 pre-materialized lane；Knowledge Evolution 保留内部补偿                               | `fusion-engine.test.ts`、`rfc349-fusion-route-provider.test.ts`、`rfc353-fusion-inbound.test.ts`                                     |
| retry / resume / boot takeover | `taskRouteOperations.ts` 的 `retryNodeProjection`；`composition/taskAutoResume.ts`；`infrastructure/postgresqlRepositoryPreparationRetryCommand.ts`                                                       | retry-repository-preparation continuation → 唯一 mint → 原 drive；不能新造 worker                       | `rfc287-t13-deferred-prep.test.ts`（interrupted 可重试、retryIndex 递增）、`rfc319-task27-de28-manual-retry-and-host-anchor.test.ts` |
| legacy 调用点                  | `services/task.ts` 的 `startTaskWithLocalRepo/startTask/startTaskImpl` 与 scheduler assembly                                                                                                              | 仍是待切实现，不因 RFC359/RFC362 完成记为已删除                                                         | `task-start-pre-worktree.test.ts`、`rfc287-t2-assembly-skeleton.test.ts`                                                             |

Task root 持有 tasks、taskRepos、taskSpaceNodes、collaborators、intent 与已提交事件写入；NodeRun 使用
`modules/task-execution/infrastructure/nodeRunMintParticipant.ts` 的唯一程序。SC 测试 provider 不写 Task/NodeRun。
准备当前经 `taskRouteWorkspaceParticipant.ts` → `services/task.ts.materializeSpaceWithProvider`；drive 使用
`application/drive/repositoryPreparationStep.ts` 与 `composition/deferredRepositoryPreparation.ts`。本批不复制这些算法。

## 2. 逐字段归属

| 字段族                                                                                                      | 当前来源与冻结点                                                                    | 后继合同中的位置                                                                                    |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| launch_origin / initiator / owner                                                                           | root `rootLaunchMetadata` 与 `deriveTaskLaunchOrigin`；child 从 parent 继承既有来源 | Task admission/continuation，SC 不接收                                                              |
| catalog_visibility                                                                                          | root `internal.catalogVisibility ?? 'public'`                                       | Task；不混入 workspace source                                                                       |
| sourceTermination binding / launchRevision / fence / effectRevision                                         | root 的四个持久化列，来自同一 `SourceTerminationSnapshot`                           | Task source/effect ownership；SC effect capability 仅绑定取消执行，不暴露 terminal reason           |
| scheduledTaskId / webhookTriggerId / webhookFireId / eventSubscriptionId / eventDeliveryId / triggerContext | root metadata 明确字段                                                              | Task source provenance；不能被一个任意 JSON “context”替代                                           |
| digitalEmployeeRoundId / digitalEmployeeCaseId                                                              | internal actionRunId/caseId                                                         | Task/DE；SC 不接收业务 case 或 Task schema                                                          |
| runtime profile / params / launch policy                                                                    | RFC360 首次派发 snapshot；task launch 的 advanced 字段维持原传递                    | RM selection + Task options；不并入 SC source                                                       |
| repoPath / cachedRepoId / repoUrl / repoGroupId/name / baseBranch/Commit / worktreePath                     | 当前 prepared workspace → root transaction 的 tasks/taskRepos 投影                  | SC 内部冻结 source record；跨域仅 frozen ref + receipt；绝对路径不在新 public 输入                  |
| workingBranch / subdir / mountPath / readonly / clone timeout / fetch / submodules                          | StartTask → 当前 materializer / Git mechanism，taskRepos 保存每仓投影               | 后继 frozen preparation record 的具名字段；测试单仓使用当前 createWorktree，不宣称 group/fetch 已切 |
| upload inputs / files / platformInputPaths                                                                  | root buffer/validate/applyUploads；成功后写 persistedInputs                         | Task pre-materialized artifact ref；repository arm 的 artifact 为 never                             |
| parent/frame/lineage                                                                                        | RFC354 原 child launch 与 mint；root 的 lineageSlotPath                             | 保持 Task ownership；本批不增加 generation/sequence                                                 |
| cancel / cleanup receipt                                                                                    | 原 signal → Git abort；lease.rollback / cleanupCreatedWorktree                      | SC stopped/diagnostics ref；Task 决定任务终态。测试确认原 Git cleanup 结果                          |

## 3. 合同、测试 provider 与实际限制

四个 offered port 与一个 effect capability 声明归 SC，TaskWorkspaceReadPort 与两条 lane 归 Task application ports。
22 个新增 public 项由 canonical 标为 `declared-contract-debt`，owner TaskExecution，removeAfterWave=W4-E1/W5，
后继任务 `RFC-362-E1-production-cutover`。5 个值类型被 Task port **以 type import 引用**；四个 offered
port 均无生产调用/装配。不可把这些类型边计为运行时 liveness。
canonical 同时登记 TaskWorkspaceReadPort 为 declared-debt；四个零 consumer offered port 与一个零 provider/consumer required port
分别进入已有精确债务账本，基线 136→140、8→9，注明 RFC-362 授权与 E1/W5 清偿入口。

测试装配在 `tests/helpers/repositoryLaunchContracts.ts`：

- seal 包装唯一 `ensureCachedRepoIdentity`；它只建立现有缓存身份，未 clone。当前进程按 key 保留示例引用。
- snapshot 用 `DatabaseSession.transaction` 的同一个 tx，复用 `RepositoryScopeAuthorizationInTx.exists`；读取的
  repository facts 与 admission fixture 一起回滚。scope 返回后失效，只有成功提交的临时 ref 可供 effect 消费。
- preparation 调用当前 `createWorktree`，使用原 cleanup provenance；不会模拟一个成功目录或另写 Git 算法。
- Task reader 先解析已绑定 capability，再委托 SC snapshot，SC 包装当前 `listWorktreeDir/readWorktreeFile`。
- 引用 codec 只验证 kind/version/ULID 并 round-trip，不把解码成功视为存在性或持久化证据。

以下是明确的**后继设计决策**，已用失败/边界用例刻画，不能靠本 RFC 假称解决：

| 缺口                            | 当前证据 / 本批处理                                                                                                          | 后继必须完成                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| durable seal / operation replay | 新 harness 无法兑付旧进程 ref；返回/抛出明确 replay-unavailable；同进程 duplicate 只执行一次真实 Git                         | 幂等 key、frozen source、operation/receipt 的真实持久化和 restart 收敛；不得把 Map 当 journal                     |
| repository revision             | cachedRepos 无 content revision；测试对实际行取摘要，不把 lastFetchedAt 当版本                                               | 明确 revision 语义和迁移；与 sealed source 同事务消费                                                             |
| group frozen preparation        | 复用 scope + group version 读取；当前匹配 version 后仍明确报告 unavailable                                                   | 冻结完整 group/layout、每仓 ref/commit 与 prepared receipt，而非再解析 live group                                 |
| current authority in tx         | 总纲的 CurrentAuthorityInTx 尚无对应已交付类型；此批声明使用已存在 RequestAuthority；harness 绑定同一个已 admit identity     | 在真实 Task live scope 接入既有 IA participant，不新建权限策略；SC 不复用 memory 的 manage-only 判据来限制 launch |
| reader 分页 / 二进制            | 当前目录服务先截断；保留 truncated，绝不伪造下一页。当前 file service 返回 UTF-8 display text；bounded 输出为该文本的 base64 | 后继决定 cursor/full-list 与 raw byte reader；保持原 HTTP wire 兼容，不把当前适配称为原始二进制读取               |
| 全准备流 clone/fetch/restart    | 新测试单仓调用真实 Git primitive；完整 deferred/retry/clone 中取消仍由既有 suite 验证                                        | 切 production materializer 时逐入口复跑原 suites，不以单仓 adapter 替代总行为 oracle                              |

## 4. 取消、恢复与失败 wire

prepare 前和 Git 启动中取消：新 `rfc362-launch-contracts.test.ts` 与原 `rfc303-worktree-abort-cleanup.test.ts`。
clone 中取消：`rfc287-t13-git-abort.test.ts`；准备完 admission 失败：现有 root rollback lease 与本批真实清理用例。
重启接管：`rfc287-t13-deferred-prep.test.ts` 的 interrupted/重试、`rfc303-runtime-ownership.test.ts`。
重复准备与逻辑 request replay：本批区分同进程成功复用和重启后的明确缺口。手动 initiator 与 human-review host anchor
继续由 `rfc319-task27-de28-manual-retry-and-host-anchor.test.ts` 验证。

生产仍保留 `__repo_prep__`、`repo-prep-not-retryable`、`repo-prep-source-unavailable`、Git 原文 earlyError、
`worktree creation failed: ...` 和 upload error/cleanup report。新 adapter 的 closed safeCode 只在测试映射；生产错误 wire 未替换。

## 5. 后继切换顺序与回滚

1. **SC source record**：先决定上述 durable/revision/group gap；开发 `source-control` application + infrastructure provider，
   `services/gitRepoCache.ts` / `services/repoGroup.ts` 保留唯一算法至转发完成。任何 schema 变化单独纳入后继 RFC。
2. **Task admission adapter**：接 `taskRouteLaunchOperations.ts` / `composition/taskRouteLaunch.ts`；沿用其一个数据库事务、
   原 root/child writer 与 nodeRunMint，repository lane 和 pre-materialized lane 分批接，不改 upload 时序。
3. **准备、取消与恢复**：接 `taskRouteWorkspaceParticipant.ts`、`repositoryPreparationStep.ts`、
   `deferredRepositoryPreparation.ts`、`postgresqlRepositoryPreparationRetryCommand.ts`、`taskAutoResume.ts`。
   在途 task 按已存 snapshot/receipt forward-converge；不可把取消/重试作为重建 source 的旁路。
4. **查询**：Task infrastructure adapter 绑定 TaskWorkspaceReadPort → SC WorkspaceContentParticipant；随后切
   `routes/tasks.ts` 的 list/read，保留当前 HTTP 返回值、offset/bounds 与错误映射。
5. **root 和旧文件删除**：三个 bootstrap 显式装配；HTTP/MCP/CLI 逐入口替换；确认 legacy consumer 归零才删
   `services/task.ts` 对应 launch/assembly 分段。scheduler assembly/root 与其他会话短时串行修改。

依赖：RFC360 runtime selection/RC participant 根注入已通过最终实现 CI；RFC361 只完成 EC provider slice，Reaction 的
TaskLaunchPlan seam 另行设计，不能随本批倒灌。W5 repository/cache/submodule/git SCC 和 WorkspaceInsight 仍另案。

本批回滚可直接删未装配声明、codec、测试和对应 declared debt，不回退 RFC359。
后继生产回滚须保留新旧在途记录的读能力，停用新 admission 后收敛旧 task，禁止删除已写 durable records。
每批以原始 suite + 双库 + 最终 exact-SHA Main CI 验收；本 RFC 完成只关闭准备，不关闭 E1、B/D、W5 或 RFC294。

2026-09-20 收口：本 RFC 的批准范围已通过 `123ce2dbc94b10d2c88bf978437bfa0db1b898ba` / Main `35492271521`。当前结论见 [plan](plan.md) 完成验收；上文中间批次的待办仅保留历史。
