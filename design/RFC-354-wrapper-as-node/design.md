# RFC-354 — 技术设计

跟 `proposal.md` 配套读。顺序：RFC-294 落位 → 统一抽象 → 裁决（帧 / 闭包 / 边模型 / 系统通道 / clarify）→ 数据流 →
耦合点 → 失败模式 → 迁移 → 测试 → 债。施工细节归 `plan.md`。

## 0. RFC-294 落位（`CLAUDE.md` §RFC workflow 第 8 条）

| 改动                                                                       | bounded context    | 层                                                                                                                       |
| -------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| schema v6、升级器、端口表（含通道语义）、引用清单、环境链纯函数              | shared（值对象）    | `schemas/{workflow,review}.ts`、`workflowMigration.ts`、`nodePorts.ts`、`workflow-node-references.ts`、`workflowScope.ts` |
| validator 退役 / 泛化 / 新增规则                                            | `resource-catalog` | `infrastructure/legacy/workflow.validator.ts`（legacy 位置，本 RFC 不搬）                                                 |
| `node_runs.container_run_id` / `scope_path`、mint、查询过滤                  | `task-execution`   | `application/ports/nodeExecutionPersistence.ts`、`infrastructure/{sqlite,postgresql}*`（双 provider）                     |
| `TaskScopeArgs.containerRunId`、frontier / freshness / 环境链读点、clarify executor 铸 `skipped` | `task-execution`   | `composition/{taskDagScope,dagFrontier,nodeMechanics,wrapperMechanics,wrapperRunLifecycle}.ts`、`engine/{wrapper,node}/*` |
| `wrapperRevivalEvidence` / liveness / `containerMemberRuns`                  | `task-execution`   | `services/dispatchFrontier.ts`、`services/freshness.ts`、`services/runLiveness.ts`（legacy 位置的纯模块，§10 债）         |
| review 读入边、`clarify_rounds.container_run_id`                             | `collaboration`    | `infrastructure/legacySqliteReview.ts:612` 等、`application/prepareClarifyGateOpen.ts` + 双 provider                     |
| 画布参数 / 返回值行、`connectionSync` 简化、inspector、任务详情              | frontend           | `components/canvas/*`、`routes/tasks.detail.tsx`、`lib/node-history.ts`                                                   |

执行链不变：TaskEngine → WrapperRuntime → NodeExecutor → ExecutionKernel。**偏离项：无。**顺手演进见 §10。

## 1. 统一抽象（全部 14 种 kind）

| 概念   | 定义                                                                                     | 对叶子 kind                    | 对有体 kind（三种 wrapper）                   | 对 call-*                          |
| ------ | ---------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------- | ---------------------------------- |
| 参数   | 以该节点为 target 的边；参数名 = `target.portName`                                        | 同                             | 同；体内经 `wrapper-input` 边界边取用          | 同；镜像子图 `inputs[].key`         |
| 返回值 | `declaredPorts(node).dataOutputs`，以该节点为 source 的边只能引用它们                     | kind 固定 / 资源声明            | `wrapper-output` 边界边提升体内端口（git 固定 `git_diff`） | 子图 output 节点的参数集 / 固定 `result` |
| 闭包   | source 在体外、target 在体内的边；容器执行打开时按词法环境绑定                              | 空（无体）                     | 成立                                         | **无**（跨帧，只能传参）             |
| 帧     | 每次执行一行 `node_runs`，`container_run_id` = 所属 wrapper 代际行                          | 一行 / 次（clarify 亦然，D8）   | 代际行 + 体行                                | child task                         |

**参数的消费方式是 kind 的实现细节，不是模型的一部分**：agent 把参数模板进 prompt、script 放进 env、call-workflow 喂给子图
`input` 节点、review / output 快照端口、clarify 由框架注入 prompt。这层差异保留。

**返回值的声明来源三种，全部落在 `PORT_DERIVERS` 一张表**：kind 固定（git `git_diff`、code-host `response`/`status`、
workgroup `result`、review `approved_doc`/`accepted` + `approval_meta`、input `inputKey`、clarify `answers`）、资源声明
（agent `outputs`、script 声明或 `stdout`）、体内提升（loop / fanout 的 `wrapper-output` 边、call-workflow 子图 output 节点的参数集）。

**由抽象直接推出、不再单独设计的事实**：可见性由环境链决定（不是数值窗口）；闭包在容器执行打开时捕获（外层重跑 → 帧 stale 重开）；
嵌套即递归；wrapper 与 call-* 是同一抽象的两个帧档位。

## 2. 裁决

### D1 — 存储保持平铺 `nodeIds[]`（用户已确认）

xyflow sub-flow 本就是平铺 + `parentId`；validator / layout / sync-diff / YAML / teaching 全部消费平铺 `nodes[]`。
「是一张图」的三层含义由 §1 + D5 兑现。

### D2 — 参数 = 入边（边推导），四种 kind 改造

| kind             | 今天                                                        | 本 RFC                                                                                                                       |
| ---------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `wrapper-loop` / `wrapper-git` | 拒入边（validator ≈`:1084-1088`，code `edge-target-port-missing`） | 删除该分支；`nodePorts.ts:235-242` 声明 `dataInputs: edgeDerivedInputs(defn, node)`；体内经 `wrapper-input` 边界边取参数 |
| `wrapper-fanout` | 声明式 `inputs[]`（含 `isShardSource`）                       | 删 `inputs[]`；参数 = 入边；新增标量字段 `shardSourcePort: string`（必须是某条入边的 `target.portName`；validator 沿边解析 source 端口 kind 须为 `list<T>`——`:924` 的解析今天已存在）；`expectedShardCount` 不变 |
| `output`         | 边 + `ports[].bind` 双写                                     | 删 `ports[]`；参数 = 入边（`existingInputPorts` 今天已按边推导，`dropTarget.ts:33-46`）；`runOutputNode`（`nodeMechanics.ts:3345-3359`）改读入边 |
| `review`         | 边 `__review_input__` + `inputSource` 双写（`schemas/review.ts:88-95`） | 删 `inputSource`；runtime（`legacySqliteReview.ts:612` 等 12 处）改读唯一入边；`rerunnableOnReject` / `rerunnableOnIterate` 保留（重跑策略，不是数据边） |

`wrapper-input` 边界边的 source 端口必须在该 wrapper 的参数集里：validator `:1098-1115`（今天只对 fanout）泛化为
`wrapper-input-port-missing`。fanout 的 `wrapper-input-boundary-missing`（`:1173-1190`）**保持 fanout-only**——fanout 体没有闭包
（RFC-339 §3 非目标）。

### D3 — 返回值：loop 改为 `wrapper-output` 边界边；`exitCondition` 变成对自己返回值的谓词

- `outputBindings: [{name, bind}]` → 边 `{ source: bind, target: {nodeId: loop, portName: name}, boundary: 'wrapper-output' }`。
  `nodePorts.ts:239-242` 的 loop 声明改为「以 loop 为 target 的 `wrapper-output` 边的 `target.portName` 去重」——与 fanout 的
  `WRAPPER_BOUNDARY_PROMOTERS['wrapper-fanout']` 完全同形，loop 的 promoter 随之合并（`workflowScope.ts` 穷尽表两条变一条实现）。
- `exitCondition: { kind, nodeId, portName, … }` → `{ kind, portName, … }`，`portName` 必须是 loop 自己的返回值端口
  （validator 新规则 `wrapper-loop-exit-port-missing`）。运行时 `loopStrategy.ts:233` 改读 loop 代际行本轮提升的返回值
  （与 `complete()` 写 `upsertOutput` 的同一路径，先提升后判退出——顺序调整：每轮结束先按边界边提升返回值到代际行，再求谓词）。
  升级器：若 `exitCondition` 引用的体内端口没有对应 `outputBindings`，自动补一条 `wrapper-output` 边，端口名取原 `portName`
  （冲突加 `_2`）。
- `WrapperGitLoopEdit.tsx` 的 `outputBindings` 编辑 UI 删除；loop 卡片右侧渲染输出行（复用 fanout 的 boundary 行原语，
  `WrapperNodes.tsx:231-262`），体内端口拖到内侧 Handle 即铸 `wrapper-output` 边；`exitCondition` 编辑器改为从 loop 返回值端口选。
- gap4 规则（`scheduler-audit-gap4-…`：exitCondition 不得引用体外）在新形状下由「必须是自己的返回值」蕴含，测试改写为新 code。

### D4 — 闭包：环境链查找，`iteration ≤` 窗口退役

- `pickUpstreamSourceRun(rows, iterationWindow)`（`freshness.ts:197-200`）删除窗口形参。
- 新纯函数 `resolveInEnvironment(source, frame)`（`task-execution/domain/`）：
  1. 局部变量（source 与 target 同 scope）→ 读同帧 `(containerRunId, iteration)` 最新 settled 行；
  2. 自由变量 / 参数（source 在祖先 scope 或顶层）→ 沿容器链找到**直接包含 source 的那一帧**（代际行的
     `container_run_id` / `iteration` 就是父帧坐标），读 source 在该帧的 settled 行；顶层帧 = `(null, 0)`；
  3. 找不到 → 响亮失败 `closure-binding-unresolved`（RFC-294 §6 B），不回退。
  `readPortRowAtIteration` / `resolveUpstreamInputs`（`nodeMechanics.ts:4977` / `:4880`）改调它；`wrapper-input` 边界边按 (2)。
- 捕获已存在（`wrapperExternalUpstreamSources` + `resolveConsumed`）；`wrapperExternalUpstreamSources:139` 已把 wrapper 自身算进
  scope，所以参数与闭包一起进 consumed。帧上的 settled 行在容器执行打开后不变（上游 gating 由 `projectWorkflowDependency` 投影
  保证），「打开时捕获」与「派发时沿环境链读」读到同一行；source 重跑 → consumed 不匹配 → 既有 stale 重开。

### D5 — 帧：`node_runs.container_run_id` + 派生 `scope_path`

**已经存在的一半**：每个 wrapper 代际都有自己的行（`wrapperRunLifecycle.ts:86-154`）。缺的只是体内行指回它。

| 列                 | 类型                                 | 语义                                                                                  |
| ------------------ | ------------------------------------ | ------------------------------------------------------------------------------------- |
| `container_run_id` | `TEXT NULL REFERENCES node_runs(id)` | 所属 wrapper 代际行 id（= 帧）；顶层行 NULL                                             |
| `iteration`        | 既有列，语义收窄                     | 帧内轮次：loop 体 0..n、git / fanout 体 0、顶层 0                                       |
| `scope_path`       | `TEXT NOT NULL DEFAULT ''`           | 根→本处 `wrapperId:iteration/…`，mint 时按容器链算出、只写不改；UI / SQL 前缀 / 诊断用；**调度不读** |

嵌套：内层 loop 代际行 `container_run_id` = 外层代际行、`iteration` = 外层轮次；内层体行挂内层代际行。fanout shard 行带帧
且**保留** `parentNodeRunId`（`nodeRunMint.ts:17-20` 不变量不动）；`parentNodeRunId` 语义收窄为「born-running 子行」，
`topLevelOnly` → `excludeBornRunningChildren`（38 处裸比较逐个认领）。`container_run_id` 是唯一事实源，守卫断言 `scope_path` 与之一致。

调度：`TaskScopeArgs` / `WrapperScopeDriverPort.drive` / `NodeExecutionQuery` / `wrapperRuns.findResumable` 加 `containerRunId`；
`deriveFrontier`（`dagFrontier.ts:152`）与 `buildFreshestSettledPerNode`（`freshness.ts:321`）改帧过滤；`openGeneration`
按 `(nodeId, containerRunId, iteration)` 续接。`containerMemberRuns(containerRunId, rows)` 一个原语供 `wrapperRevivalEvidence`
（depth-1 消失）/ `innerRunsOf` / `retryNode` 级联 / `nodeRollback` 使用。

### D6 — 系统通道折进端口表

`systemChannelPorts.ts` 的 `SYSTEM_CHANNEL_PORTS`（5 条 spec：`side` / `promptInjected` / `dataflow`）删除；
`DeclaredPort` 增可选 `channel?: { promptInjected: boolean; dataflow: 'never' | 'unless-target-clarify' }`，挂在
`PORT_DERIVERS` 里 agent / clarify / clarify-cross-agent 的 `systemInputs` / `systemOutputs` 条目上（`nodePorts.ts:198-205`、
`:263-276`）。`channelEdgeDataflowSkip` / `isSystemChannelEdge` / `touchesSystemChannelPort` / `PROMPT_INJECTED_PORT_NAMES`
改为从 `declaredPorts` 派生（4 backend + 4 shared 消费文件）。`rfc147-system-channel-ports` 的「注册表 ↔ 端口表」drift
测试改为「端口表是唯一来源」守卫。运行语义逐字不变。

### D7 — clarify 用行表达生命周期

今天：`ClarifyNodeExecutor.execute` 是 no-op（`humanGateNodeExecutors.ts`「Graph visits are no-ops」）；行由 collaboration
在 agent 发问时铸（`prepareClarifyGateOpen.ts:206-228`，cause `clarify-park` / `cross-clarify-park`）；frontier pass-2
（`dagFrontier.ts:211-219`）按 `settlesWithoutRow` 无行判完成。

改：executor 被访问而无 open round 时铸一行 `skipped`（RFC-306「闸门未触发」，`freshness.ts:203-220` 的 settled 口径已把
`skipped` 算作答案）；agent 发问时 collaboration 铸的 park 行 id 更新 → `isFresherNodeRun` 判它为最新 → 节点从
completed 变为 park；答复后该行沿既有路径 `done`（cross 路径 `legacySqliteClarify/service.ts:584` 已如此；self 路径的 done
转移点在实现 T13 逐条核实）。`settlesWithoutRow` 从 `NODE_KIND_BEHAVIORS` 删除，pass-2 删除。这是本 RFC 风险最高的一刀
（RFC-092/098/120/128/132/140 的 park / deferred 机制都挂在 clarify 上），验收口径是**既有全部 clarify 用例与 20 条 e2e
不改断言直接绿**。

### D8 — clarify 同帧

`clarify_rounds` 新增 `container_run_id`（= 提问 run 的帧），`loop_iter` 语义收窄为帧内轮次（列名不动），索引改为
`(asking_node_id, container_run_id, loop_iter, iteration)`；`prepareClarifyGateOpen` input 增 `containerRunId`；85 处 `loopIter`
透传随编译器带上。

### D9 — validator

| code                                         | 变更                                                                                          | 严重度  |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- | ------- |
| `wrapper-loop-nested`                        | 删除                                                                                          | —       |
| `edge-target-port-missing`（loop / git 入边分支） | 删除                                                                                       | —       |
| `wrapper-input-port-missing`                 | 新增：任何 wrapper 的 `wrapper-input` 边 source 端口不在参数集                                 | error   |
| `wrapper-loop-exit-port-missing`             | 新增：`exitCondition.portName` 不是 loop 自己的返回值端口                                      | error   |
| `wrapper-fanout-shard-source-*`              | 改读 `shardSourcePort` + 入边 source kind                                                      | error   |
| `wrapper-fanout-unsupported-inner-kind`      | 新增：fanout 体内非 `agent-single`（镜像 `fanoutStrategy.ts:218-226`）                          | error   |
| review / output 的绑定类规则（`:1914` 等）      | 改为对入边的规则（`resolveWorkflowSourceRef` 逻辑不变）                                        | 同今天  |
| `wrapper-input-boundary-missing`             | 保持 fanout-only                                                                              | error   |
| `wrapper-fanout-nested`                      | 保留                                                                                          | warning |

`rfc199-workflow-validation-targets` 计数棘轮、`rfc203-validation-copy` 文案棘轮随之更新。

### D10 — schema v6 与升级器

`WORKFLOW_SCHEMA_VERSION = 6`；`migrateWorkflowDefinitionToLatest`（`workflowMigration.ts:92-107`）级联 v5 → v6，纯函数、幂等：

1. review：删 `inputSource`（若定义里缺对应边——只可能是手写 YAML——补一条 `→ (review, __review_input__)` 边）。
2. output：删 `ports[]`（若某 `bind` 无对应边则补边 `bind → (output, name)`）。
3. loop：每条 `outputBindings` → `wrapper-output` 边；`exitCondition` 去 `nodeId`、`portName` 改指 loop 返回值端口，必要时补边。
4. fanout：`inputs[]` → `shardSourcePort = inputs.find(isShardSource).name`，删 `inputs[]`（入边已经存在，端口即边推导）。
5. `$schema_version: 6`。

透明升级点不变（workflow GET / YAML import / 启动快照）。`workflow-node-references.ts` 的 output / review / loop / fanout 条目
清空 PortRef 字段（只剩 `nodeIds` 与 review `rerunnableOn*`）；unmanaged-field 棘轮随之调整。RFC-348 teaching：fanout / review
是 strict kind（zod 键控，字段删除即编译红）；output / loop 是 passthrough kind（`types.ts:209-219` 的键 union 改）。

### D11 — 前端

- `<WrapperBoundaryPortRow>` 从 `WrapperNodes.tsx:160-262` 抽出，三种 wrapper 复用：左侧参数行（边推导）、右侧返回值行
  （loop / fanout 由 `wrapper-output` 边推导；git 固定 `git_diff`）。
- `connectionSync.ts` 的 review / output 双写（`:163-262`）删除：连接就是一条边。
- inspector：`WrapperGitLoopEdit.tsx` 删 `outputBindings` 编辑，`exitCondition` 从返回值端口选；fanout inspector 删 `inputs`
  编辑，加 `shardSourcePort` 选择。
- 任务详情：`tasks.detail.tsx:1864` 轮次列 → `scopePath` 面包屑；`node-history.ts` 按帧分组；`InboxDrawer` 标签。

## 3. 数据流（嵌套两层 + 闭包 + 返回值）

```text
findings_input (top, frame (null,0))
   │ 闭包边 ────────────────────────────────────────────────┐
outer loop 代际行 R_outer (container=null, iter=0)          │
   consumed = { findings_input: <run at (null,0)> }         │ 捕获
   round i:                                                  │
     inner loop 代际行 R_inner[i] (container=R_outer, iter=i)│
        round j:                                             ▼
          worker (container=R_inner[i], iter=j, scope_path="outer:i/inner:j")
            读 findings → 环境链 R_inner[i] → R_outer → (null,0) → findings_input 的 settled 行
          轮末：worker.findings ──wrapper-output──▶ R_inner[i].result（提升到代际行 outputs）
                exitCondition(port-empty, 'result') 对 R_inner[i].result 求值
```

## 4. 与现有模块的耦合点

- RFC-130 隔离：`createOrRebuildWrapperIso(state, generation.runId, previous)`（`wrapperMechanics.ts:222`）已按代际行键 iso；帧不改路径。
- RFC-098 stale redispatch：wrapper 级 consumed 就是闭包捕获记录。
- RFC-306：settled = done ∪ skipped 不变；clarify 的 `skipped` 行正是这条口径的消费者。
- RFC-243：call 节点允许在 git / loop 体内；call-workflow 派生返回值时改读子图 output 节点的入边。
- RFC-189 / RFC-075：workgroup / commit-push 合成行不进帧语义。
- RFC-349：新列进 `schemaContract.ts` + 写矩阵；双 provider adapter。
- RFC-292：模板面（`workflowTemplateSurfaces.ts:63-80`）不变。

## 5. 失败模式

| 场景                                            | 处置                                                                        |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| 环境链找不到自由变量 / 参数的 settled 行         | `failed` + `closure-binding-unresolved`，不静默 `''`                        |
| loop 本轮没有提升出 `exitCondition` 引用的返回值 | 视为端口未激活 / 空（RFC-306 口径），谓词照常求值——与今天 `readPort` 得 `''` 一致 |
| 升级器遇到 `bind` 无对应边（手写 YAML）           | 补边；幂等                                                                  |
| 升级器遇到 `exitCondition` 引用体外节点           | 保留为 validator error（gap4 语义），不静默改写                              |
| 回填找不到候选代际行                             | NULL + `''` + WARN；oracle 统计 = 0                                         |
| clarify `skipped` 行与 park 行竞态               | park 行 id 更新即胜（`isFresherNodeRun`），executor 只在无 open round 时铸   |
| 三层以上嵌套 resume                              | 逐层 `openGeneration` 续接                                                  |

## 6. 迁移（0223）与 PostgreSQL contract

1. `node_runs` 加 `container_run_id` / `scope_path` + 索引 `(task_id, container_run_id, node_id, iteration)`；
   `clarify_rounds` 加 `container_run_id`、重建 `idx_clarify_rounds_asking`。
2. 回填（durable backfill job + `aw doctor --backfill-containers`）：对每个 task 按 `buildWorkflowScopeParentMap(snapshot)`，
   体行 r 的容器 = 同 task、`nodeId = parents[r.nodeId]`、`id < r.id` 的最大 id 行；`scope_path` 由链拼出；
   `clarify_rounds.container_run_id = node_runs[intermediary_node_run_id].container_run_id`。存量无嵌套 loop，规则唯一。
3. `schemaContract.ts` 两表合同 + codec；`upgrade-rolling` 计数；journal prettier。
4. workflow 定义：v6 升级在读出时透明完成，**不写回**（与 v3→v4 / v4→v5 先例一致）；新写一律 v6。

## 7. 能力口径的可复跑引用

- 闭包边今天合法：`workflow.validator.ts:1184`；读法：`nodeMechanics.ts:4928-4934` → `freshness.ts:186-200`。
- 捕获已实现的一半：`dispatchFrontier.ts:134-152` + `wrapperRunLifecycle.ts:127-135` + `sqliteWrapperRunPersistence.ts:40-51`。
- review / output 双写：`schemas/review.ts:88-95`、`connectionSync.ts:163-262`。
- loop 绑定不是边：`nodePorts.ts:239-242`、示例 `examples/workflows/showcase/nested-loop-git-fix.yaml`（无 `target: fix_loop` 边）。
- clarify 无行判完成：`node-kind-behavior.ts`（`settlesWithoutRow: true`）、`dagFrontier.ts:211-219`。
- loop / git 拒入边：`workflow.validator.ts` ≈`:1084-1088`。

## 8. 测试策略（必写清单）

**翻转 / 删除**：s06 翻 4 次；`rfc094` rule-1 反转；gap4 改写为 `wrapper-loop-exit-port-missing` + 环境链断言；
`lifecycle-wrapper-nested` 三条不变量改帧口径；validator「不接受入边」断言删除；`rfc147` drift 测试改单一来源守卫。

**新增（后端）**：三层嵌套；闭包 (a)(b)(c)；参数路由 + `wrapper-input-port-missing`；loop 返回值经边界边提升 + exit 谓词；
fanout `shardSourcePort`；升级器：32 个示例 + starter golden、幂等、升级后 validator 零 error、**升级前后执行逐字相同**
（既有 scheduler / review / clarify fixture 双跑）；clarify `skipped` 行 + park 覆盖 + 既有 clarify 用例零改动全绿；
嵌套内 self / cross clarify；resume / 重试；回填 oracle；`containerMemberRuns` 表测；`scope_path` 一致性守卫；双 provider parity。

**新增（前端）**：三种 wrapper 参数 / 返回值行（role 断言）；exitCondition 选择器；review / output 连线只产边；面包屑 / 分组纯函数；
e2e：`canvas-wrapper-membership` 加参数边 / 闭包边 / 返回值边三幕；`canvas-connection-dialog` 对 review / output 的连接断言只查边。

**源码层兜底**：`wrapper-loop-nested`、"does not accept inbound edges"、`inputSource`、`outputBindings`、`ports[].bind`、
`SYSTEM_CHANNEL_PORTS`、`settlesWithoutRow` 在生产代码零命中；`pickUpstreamSourceRun` 无窗口形参；`r.iteration <=` 形态零命中。

## 9. 与 call-workflow 的关系（概念对齐，不动实现）

wrapper = 内联 lambda（帧 = container run）；call-workflow = 调用定义在别处的函数（帧 = child task；参数 = 子图 `inputs[].key`、
返回值 = 子图 output 节点的参数集、无闭包）。RFC-294 §5.1 维持。将来「内联体引用另一张 workflow」只需 `bodyRef`。

## 10. 承担的演进与留下的债

- **承担**：14 种 kind 的入出口收成一种边模型；wrapper 抽象归一；数据模型第③批中 `container_run_id` + `scope_path` +
  `parentNodeRunId` 收窄 + `containerMemberRuns`；系统通道并行注册表退役；`settlesWithoutRow` 退役。
- **债**：`services/{freshness,dispatchFrontier,runLiveness}.ts` 不搬家（W4-E1）；`workflow.validator.ts` 仍在 legacy 目录；
  第③批另一半（`row_kind`、`seq`、`node_run_repos`）；fanout 体扩张（W8）；跨轮反馈端口；review `rerunnableOn*` 作为
  控制策略仍是 nodeId 列表（不是边——它们不是数据流）。
