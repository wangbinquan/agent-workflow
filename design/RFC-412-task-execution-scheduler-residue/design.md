# RFC-412 技术设计

路径缩写：`S` = `packages/backend/src`，`TE` = `S/modules/task-execution`，`T` = `packages/backend/tests`，`SCH` = `S/services/scheduler.ts`，
`TMS` = `S/services/execution/taskMechanicsState.ts`。行号以 RFC-411 落库后的源码为准，实施时按源码定位。形状沿用 RFC-405～411：主体原样
迁移，只做端口替换；绑定在 composition。

## 1. 文件

| 来源 | 去向 |
| --- | --- |
| `SCH` 的 `maybeRunCommitPush`（含 `genViaOpencode`） | `TE/engine/node/commit-push/runCommitPush.ts`：`runAutoCommitPush(ports, node, iteration, log)` |
| `SCH` 的 `inspectReadonlyRepos` | `TE/engine/task/readonlyInspection.ts`：`inspectReadonlyRepos(ports, log)` |
| 两者的端口 | `TE/application/ports/commitPush.ts`（`AutoCommitPushPorts`）、`TE/application/ports/readonlyInspection.ts`（`ReadonlyInspectionPorts`） |
| 绑定 | `TE/composition/commitPushBinding.ts`：`createAutoCommitPushPorts(state)`、`createReadonlyInspectionPorts(state)`；`readCommitExcludePatterns` 随之迁入 |
| `TMS` | `TE/composition/taskMechanicsState.ts`（原样；全部 import 改指） |
| `SCH` 的 `buildContainerMap` | 调用方直接用 shared `buildWorkflowScopeParentMap` |
| `SCH` 的兼容再导出 | 删除；用例改从 `TE/public/commands` / `TE/composition/taskEngineRuntimeOptions` 取 |

`composition/taskDagScope.ts` 的 `commitPush` 绑定改为 `runAutoCommitPush(createAutoCommitPushPorts(state), …)`；`taskEngineApplication.ts`
的 `inspectReadonlyRepos` 绑定改为 `inspectReadonlyRepos(createReadonlyInspectionPorts(state), log)`。`SCH`、`TMS` 删除。

## 2. 端口

**`AutoCommitPushPorts`**（绑定读调用时的 `state`）：

| 分组 | 能力 |
| --- | --- |
| `task` | `id`、`branch`、`baseBranch`、`ownerUserId`、`gitUserName`、`gitUserEmail`、`repos`、`repoGroupName` |
| `signal` | 取消信号 |
| `history` | `listDoneNodeRuns`（`persistence.scheduler`）与 `familyHistory` 选择（`createRunHistorySnapshot`） |
| `runtime` | `internal(...)`（提交 agent 运行时解析）、`resolve(sessionRunId, …)`（冻结） |
| `nodeRuns` | `mint`、`loadEnvelopeNonce` |
| `commitAgent` | 提交节点 id（`commitPushNodeId`）、信息端口名、信息 / 修复提示词构造、合成提交 agent 的会话运行（绑定内为 `buildCommitAgent` + 注入解析 + 任务 agent 运行族；输入字段与原文相同） |
| `repository` | 逐仓 `status --porcelain`（source-control public 工作区） |
| `effects` | `runCommitPush(args)`（source-control legacy，经绑定）、写锁 `acquireWrite` |
| `config` | 提交运行时 / 模型 / 默认运行时、修复次数、diff 上限、语言、排除配置、发布传输 |

**`ReadonlyInspectionPorts`**：`task.id`、`repos`、逐仓 `status --porcelain`、`recordReadonlyDirty`（`persistence.scheduler`）、
`execution`（可选的执行上下文）。

## 3. 依赖规则

- `TE/engine/node/commit-push/` 与 `TE/engine/task/readonlyInspection.ts` 只 import 本模块 `domain/`、`application/`、`engine/`、shared 与
  node 内建模块；`engine/task/**` 继续受 RFC-408 锁约束。
- source-control 的 `services/commitPush.ts` / `commitPushRunner.ts` 只出现在绑定文件。
- `TaskMechanicsState` 只出现在 `TE/composition/`。

## 4. 必须保持

| 不变量 | 现有锁 / 用例 |
| --- | --- |
| 逐仓顺序、只读跳过、干净仓跳过、取消在仓边界生效、发布传输缺失时抛 `repository-publication-transport-not-composed` | RFC-075 / 098 / 248 用例 |
| 提交 run 父子关系（父为触发节点最新 done run）、会话 run 的铸造身份与 cause、运行时冻结 | RFC-096 / 117 / 395 用例 |
| 提示词、修复次数、diff 上限、排除配置（RFC-308 一次性切片）、语言 | 提交推送用例 |
| 巡检记录字段与告警文本 | RFC-248 用例 |

## 5. 守卫与账本

| 守卫 / 账本 | 处理 |
| --- | --- |
| 读 `SCH` / `TMS` 源码的锁、RFC-395 选择语义账本（`familyHistory` 站点）、`architectureReport.ts` 的 scheduler 特例与 legacy 归属 | 改指新 owner；站点随主体迁移 |
| RFC-376 counts、commons-debt、guard-manifest、Windows paths | 按实测更新，只降不升 |

## 6. 测试

- 新增结构锁 `T/architecture/rfc412-scheduler-residue.test.ts`：两个主体与绑定 owner 唯一；`SCH`、`TMS` 不复活、不被引用；
  `TaskMechanicsState` 只在 composition；两个 engine 文件的 import 层级；source-control legacy 只在绑定；每项带纯伪造输入的负例。
- 端口绑定用例 `T/rfc412-port-bindings.test.ts`：端口读调用时的状态；`effects` / `commitAgent` / `repository` 转交到原实现。
- 搬迁涉及的既有用例只改 import 与源码锚点。
