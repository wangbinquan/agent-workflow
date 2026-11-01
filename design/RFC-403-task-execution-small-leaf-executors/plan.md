# RFC-403 实施计划

**前置**：RFC-402 Done。由 Codex 实施、本会话审核。全部实现与用例完成后集中验证一次；不在实施中途做功能验证。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-403-T1 | 窄合同与共享支撑：`codeHostNodeExecution.ts`、`virtualIoNodeExecution.ts`（input / output 分开）、`humanGateNodeExecution.ts`（COL 合同集中派生）、中立 `nodeExecutionSupport.ts`（状态事件 / 诊断，script 改指）；复用 `NodeStepRequest` / `NodeStepOutcome` 与具名 ledger | design §1、§2 |
| RFC-403-T2 | code-host 主体迁入 `engine/node/code-host-call/`：完整决策流程、恢复循环、输出与终态顺序与原错误码；绑定 transport / project / probe / effect | design §1.1、§3 |
| RFC-403-T3 | input / output 主体迁入；`readPortRowAtFrame` 归 `application/nodeInputs.ts`，`W` 只改 import；`pickString` 归 `domain/nodeFields.ts` | design §1.1、§2 |
| RFC-403-T4 | review / clarify / clarify-cross-agent 的 task 侧主体迁入；分支判定 / 跳过归 `application/nodeBranchActivation.ts`，gateway 经端口调用；`CollaborationNodeGatePort` 只留 `openAgentClarify` | design §1.1、§2、§3 |
| RFC-403-T5 | `E` 以显式端口直接构造六个新执行器；删除旧委托壳文件与 `N` 中六个主体；剩余 calls / agent / host、`W`、`executionMergeRecovery.ts` 改指真实 owner | design §1.1 |
| RFC-403-T6 | 守卫与用例：新结构锁 `rfc403-small-leaf-executors`（含负例）、RFC-328 code-host 站点识别与转发负例、RFC-317 / 334 / 287 / 292 / 395 / 370 / 376 / 294 改指、Windows 两份 `paths:` 与 suite、端口绑定用例；账本只准备改法，按 T7 实测填值 | design §4、§5 |
| RFC-403-T7 | 集中验证：静态检查、后端全量（含根目录守卫）、相关两 provider 矩阵、P0 变异 lane；按实测更新账本；实现门（只审功能）；推送后跟 CI | design §3 |

**派发**：T1～T6 一次派发给同一可写线程（主体合计约 800 行，守卫改动集中）；T7 由本会话执行。

## 冲突面

- `TE/composition/{nodeMechanics,nodeExecution,wrapperMechanics,executionMergeRecovery}.ts`、`TE/engine/node/*`、
  `TE/application/ports/{collaborationNodeGate,scriptNodeExecution}.ts`；
- 守卫与账本：见 design §4。

并发会话 RFC-398 的改动面（epoch migration / auto-upgrade、`platform/persistence/**`、`modules/system-operations/**`、`main.ts`、
`bootstrap/{daemonStart,epochMigration*,autoUpgradeChild,migrate}.ts`、`cli/epochMigration.ts`）与本 RFC 没有必需的同文件交集；实施前与
提交前按路径核对工作树。

## 实施记录（2026-10-31）

- **实施**：Codex 可写线程 `01a19499-5f46-7180-a30f-fb95c61a3077` 一次派发完成 T1～T6（新增 23、修改 40、删除 3 个路径）。本会话逐段对照
  基线审核，补回搬迁时丢失的三段承重注释：`application/nodeBranchActivation.ts` 的 RFC-306 段头、`judgeBranchActivation` 的「三个承重细节」
  与 `recordSkippedRun` 的说明，以及 `engine/node/clarify/settleIdleClarify.ts` 的 RFC-354 D7 说明。
- **结果**：`nodeMechanics.ts` 4621 → 3656 行。`CollaborationNodeGatePort` 只剩 `openAgentClarify`，`nodeExecution.ts` 以
  `state.opts.collaborationRuntime satisfies CollaborationNodeGatePort` 约束；原包装对象里的 `openAgentClarify` 没有调用方（review /
  clarify / cross 执行器只用另外三项），随之删除，agent / host 主体的三处调用不变。
- **账本实测**：`counts.json`、`commons-debt.json`、`commons-manifest.json` 不变；`guard-manifest.json` 只更新本 RFC 涉及的 11 个条目
  （`lines` 参考值，RFC-334 递归语料下限 32 → 40，新增 `rfc403-small-leaf-executors`）。

## 集中验证（T7）

- **静态**：
  - 后端 typecheck（含 tests，6 GiB heap）：全量开跑前 rc=0。最终候选（含门后两处测试锁修改）复跑时只报 1 处错误：
    `collaboration/infrastructure/review.ts:4071` 的 `continuationSlotKey`，属于并发 RFC-398 22:58 写入的在制改动（端口类型尚未跟上），不在
    本 RFC 候选中；本 RFC 的文件没有类型错误。
  - 候选中 62 个 TS 文件 eslint `--max-warnings 0`：0 error、0 warning；64 个代码与配置文件 prettier 通过。
- **实现门**（只审功能，Codex 只读线程 `01a194bb-f92d-71a2-ab8d-752a58d42b68`）：FAIL，1 项 P1——`scheduler-cross-clarify-no-runaway.test.ts`
  把没有搬迁的 `composition/taskDagGraph.ts` 错误改指到 `engine/node/clarify-cross-agent/`，依赖边锁读文件即 `ENOENT`。已按其建议改回
  `composition`。其余检查项（六种主体的行为等价、端口绑定与读取时机、gateway 的 abort → 分支判定 → 执行顺序、共享 helper 单一 owner、
  守卫与账本、Windows 接线）没有发现问题。门后只改了两处测试锁（即此项与下文的 `clarify-prompt-wire-up`），生产代码没有再动。用户 2026-10-31
  指示此后不再派 Codex，这两处改动由本会话复核。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段全部有效（每个 provider 15 个变异阶段各只让预期用例失败、对照用例通过，
  变异前后 26/26 通过），127 个源文件指纹前后一致。
- **后端全量**：6 分片、`--isolate --randomize`、PostgreSQL 各用独立库。全量期间机器负载约 70（常驻一个 kind 集群），分片 1、5 撞上
  9000 s 上限被截断：2795 个文件中 2732 个开始执行（30936 pass、418 fail、51 skip），183 个文件有失败。归因：
  - **本 RFC 引入、已修**：
    - 上述实现门 P1：全量开跑时修复还没落盘，分片 6 中该用例按门的预测以 `ENOENT` 失败；修复后低并发重跑 6/6 通过。
    - `clarify-prompt-wire-up.test.ts` 第 3 个用例仍断言 `nodeExecution.ts` 含 `await mechanics.openAgentClarify({`，即本 RFC 删掉的无调用方
      包装。改为逐跳锚定真实接线：`collaborationNodeGate.ts` 声明 `openAgentClarify`，`nodeExecution.ts` 以
      `satisfies CollaborationNodeGatePort` 约束 Collaboration runtime，`nodeMechanics.ts` 的 agent / host 主体调用
      `collaboration.openAgentClarify`。修后 10/10 通过，`rfc287-t1` 源码锁清单与 `rfc403-small-leaf-executors` 同时通过。
  - **并发 RFC-398 未提交文件造成**（证据保留，不归本 RFC；这些文件都不在本 RFC 候选中。本 RFC 的文件只有 6 个守卫 import 了别的会话改过的模块，
    即 `tests/architecture/census.ts`，其 RFC-398 改动只是把它新增的 `bootstrap/epochMigrationAuto.ts` 加进 `BOOTSTRAP_FILES`，不涉及本 RFC 的路径）：
    - 10 个守卫文件共 12 条：root-test-entrypoint（`release-upgrade-nightly.yml` 的 OS 矩阵步骤未声明 shell）、rfc359-w5-t19
      （`bootstrap/epochMigrationEntry.ts`）、t19d（SourceReader 12 → 13）、t19f（`rfc398-wal-sidecar-open.test.ts` 5 → 6）、
      rfc294-architecture-preflight 的 public surface（`epochSwitch.ts#LegacyMigrationFinalizePort`、`autoUpgrade.ts#AutoUpgradeConclusion`）、
      rfc284 env-flags（`AGENT_WORKFLOW_EPOCH_*`、`AGENT_WORKFLOW_TEST_EPOCH_UPGRADE`）/ spawn-site / microhelpers
      （`platform/persistence/migration/postgresqlBridge.ts`）、rfc254（`bootstrap/autoUpgradeChild.ts`）、rfc349 两条（`routes/health.ts`、
      epochMigrationAuto、postgresqlBridge、sourceAccess）；
    - 49 个未跟踪的 `release-upgrade-matrix-*` 用例文件：43 个各 1 条失败，6 个因截断没有执行。
  - **负载超时**：其余失败都是 PostgreSQL 用例或 hook 超时，以及超时后拆库引起的 `Connection closed`、HTTP 500 与查询失败，没有一条断言
    在未超时的情况下失败。
    - 129 个失败文件加上 59 个因截断没有执行的文件，3 worker 低并发重跑后剩 14 个文件，仍全是超时；其中 10 个在 RFC-402 的全量（本 RFC
      开工前）中也以超时失败过。
    - 这 14 个文件串行跑两遍（一遍 `--timeout=60000`，用例自带的 15 s / 35 s / 40 s 上限仍生效；一遍默认配置），失败的一律是超时（负载
      28～53）。除 `rfc395-q3-phase-activation-prepared` 外每个文件至少一遍通过；它在负载 8 时按默认配置 8/8 通过。
    - 静态 import 闭包：14 个文件中只有 7 个能到达本 RFC 的文件（`lifecycle-property`、`routes-clarify`、`routes-cross-clarify` 与 4 个
      `scheduler-*`）。clarify / scheduler 这 6 个两遍串行都通过；`lifecycle-property` 只在负载 44 时超时一次（PostgreSQL 首个用例常态
      约 11 s，上限 15 s），按默认配置复跑 6/6 通过。
- **本 RFC 关键用例**（全量中均通过）：`rfc403-small-leaf-executors`、`rfc403-port-bindings`、RFC-354 idle clarify 跳过、RFC-306 分支跳过、
  RFC-269 / RFC-328 code-host、RFC-287 T8 前奏矩阵、RFC-370 review 显式上下文、scheduler cross-clarify dispatch、RFC-402 结构锁。

## 验收清单

- [x] proposal AC-1～AC-5（本地集中验证，见上）
- [ ] 推送后 exact SHA 的 CI 全绿（AC-6）
