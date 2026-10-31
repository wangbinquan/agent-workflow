# RFC-402 task-execution 执行机制库与 script 节点试点（RFC-294 S6 第一步）

- **状态**：In Progress（2026-10-31 落档并开始实施）。用户 2026-10-30「你继续推进RFC294，你可以使用codex进行调研和实现，过程中按你的判断
  来推进，不用询问我」：由本会话设计、交 Codex 实施并审核，取舍由本会话按推荐决定（见 §6，可推翻）。纯结构重构，无用户可见变化。
  设计门免：Codex 只读研究（线程 `01a19308-2b67-7a61-88c7-55603bbcd9ba`），本会话抽查关键论断后定稿；实现门做一轮只审功能的检视。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S6；design §5.2、§5.4、§5.5 第 1、2 步
- **前序**：[RFC-399](../RFC-399-context-dag-platform-one-way/proposal.md)、[RFC-400](../RFC-400-collaboration-task-participants-actor/proposal.md)
- **落位**：task-execution `engine/kernel/`（执行机制库）、`engine/node/script/`（script 执行器）、`application/ports`（窄合同）、
  `infrastructure/`（provider 适配与工作区会话）；`platform/contracts/`（隔离工作区的中立 DTO）

## 1. 背景

RFC-294 design §5.2 的目标是四层：任务控制面、scope 解释器、节点执行器、执行机制库（`engine/kernel/`）。现状（design §5.1）是叶子节点
经「engine 里一行委托壳 → `legacyArgs` → `composition/nodeMechanics.ts` 的 run*Node」执行，机制散落在 `services/schedulerAssembly.ts`
（`runAssembly`）、`infrastructure/isolatedAgentRun.ts`（隔离与合并）、`services/{taskWriteLocks,processNodeConcurrency,taskFanoutPools}.ts`
（许可），执行上下文是 22 字段的 `TaskMechanicsState`。

design §5.5 给出的前两步：

1. 把 `runAssembly` 与隔离、合并、许可一起迁为 `engine/kernel` 机制库，改指现有调用方，删除回指 task-execution 自身的三个 facade；
2. 以 script 节点试点，把 kind 主体从 `nodeMechanics.ts` 迁入 `engine/node/script/`，显式列出它需要的端口。

研究核对的现状（行号以 2026-10-31 源码为准）：

- `runAssembly` 有五个调用点，分布在两个文件：`nodeMechanics.ts:342`（workgroup host）、`:2741`（script）、`:4866`（agent），
  `wrapperMechanics.ts:793`（fanout 分片）、`:1382`（聚合）。
- 三个回指 task-execution 的 facade：`services/isolatedAgentRun.ts`（全部转导出 TE public participants）、`services/nodeIsolation.ts`（大部分
  转导出 platform，最后一项 `discardNodeIso` 回指 TE）、`services/taskExecutionParticipants.ts`（`export *` TE public participants）。
- 许可是模块级可变状态：`taskWriteLocks.ts` 两个 `Map<taskId, Semaphore>`，`taskFanoutPools.ts` 一个，`processNodeConcurrency.ts` 一个
  `WeakMap<daemonScope, pools>`。
- script 主体 669 行（`nodeMechanics.ts:2624-3292`），直接用到 `TaskMechanicsState` 的 10 个字段，经共享 merge helper 再用 1 个；
  `legacyArgs` 只有 `node`、`containerRunId`、`iteration`、`log` 四项。

## 2. 目标

- **G1 执行机制库**：`engine/kernel/` 持有 assembly、隔离创建与持久、合并与结算、隔离清理、effect request 构造、许可、NodeRun ledger 绑定；
  kernel 只依赖本模块 domain / application ports 与 `platform/contracts`，不 import `services/`、`composition/`、`infrastructure/` 与 platform 的
  物理实现。删除 `services/` 下七个文件（`schedulerAssembly.ts`、`taskWriteLocks.ts`、`processNodeConcurrency.ts`、`taskFanoutPools.ts`、
  `isolatedAgentRun.ts`、`nodeIsolation.ts`、`taskExecutionParticipants.ts`），不留 facade；TE public participants 收回隔离实现的转导出。
- **G2 状态显式化**：许可注册表是显式实例，由 bootstrap 按 daemon scope 构造一次并注入所有消费者（task-execution、collaboration、
  legacy `services/taskDelete.ts` 等），共享语义与今天的模块级 Map 相同；工作区会话由显式依赖选择，`composition/isolationWorkspaceScene.ts`
  的缓存行为移入 infrastructure。
- **G3 script 试点**：script 执行器与主体在 `engine/node/script/`，经显式端口执行，不再经过 `legacyArgs` 或 `TaskMechanicsState`；script 用到的
  共享 helper 各归其位且只有一份（输入解析、合并冲突解决、状态事件、隔离失败诊断）。
- **G4 守卫不缩**：按路径或被调名取语料的守卫随迁移精确改指并保留负例；`rfc334-node-executor-boundary` 改为递归扫描 engine；新增结构锁；
  账本按实测下调。
- **G5 纯结构**：执行顺序、许可与释放次序、record-before-act、ownership token、重试、超时、取消与中断语义、输出与结算顺序都不变。

## 3. 非目标

- 其余 kind（agent、code-host、input / output、call-workflow / call-workgroup、workgroup host）的主体迁移，wrapper 分片与聚合主体，
  `taskEngineApplication.ts` 的引擎编排，删除 `nodeMechanics.ts` 与 `legacyArgs`，协调器只在 bootstrap 构造（S6 后续步骤）。
- `services/nodeRunMint.ts` 的全面清理；mint 仍由 infrastructure 的 mint participant 执行，kernel 只持有调用合同。
- 移动 `platform/workspace/local/isolation.ts` 的物理实现（RFC-399 已决定只归位 `repoRelForcedPaths`）。
- 迁移 `services/scriptPorts.ts` / envelope 解析（本次经端口注入现有实现）。
- 改变隔离清理 receipt 的 provider 参与条件（`rfc370-isolation-cleanup-context` 锁定的现状不变）。
- 安全相关改动。

## 4. 用户可见变化

无。HTTP / MCP / WS 合同、数据库结构、发布二进制的行为均不变。

## 5. 验收标准

- **AC-1 kernel**：G1 的七个 `services/` 文件不存在且无引用；`engine/kernel/` 的 import 只指向允许的层（新增结构锁锁定，含负例）；
  五个 assembly 调用点与 manual call-workflow 隔离、wrapper restore / rebuild、`executionMergeRecovery` 都改用 kernel。
- **AC-2 状态**：许可注册表无模块级单例；生产只在 bootstrap 构造，同一 daemon scope 的所有消费者拿到同一实例（结构锁 + 行为用例）。
- **AC-3 script**：script 执行器在 `engine/node/script/`，不 import `composition/`、`services/`，不引用 `TaskMechanicsState`、`legacyArgs`；
  `rfc334-node-executor-boundary` 递归扫描并有嵌套负例。
- **AC-4 行为不变**：script 执行矩阵（`rfc370-task-script-family` 每个 provider 15 个场景）、RFC-287 assembly 骨架与源码锁、RFC-328 effect
  observer 表与负例、RFC-130 / 188 / 210 隔离与 replay、恢复 oracle、P0 变异 lane 全部通过，断言意图不变。
- **AC-5 账本**：`architecture/counts.json`、`architecture/commons-debt.json`、`rfc294-architecture-preflight`、`rfc376-structural-guards`、
  `architectureReport.ts` 映射、`commons-manifest.json`、`guard-manifest.json` 按完整候选实测更新，只降不升。
- **AC-6 CI**：推送后 exact SHA 的 GitHub Actions 全绿（含 PostgreSQL 分片、三平台 e2e 与 windows-platform）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **一个 RFC 两部分**：Part A（kernel）与 Part B（script 试点）共享许可 / 会话 / 上下文合同与同一批守卫，分成两个 RFC 容易在中间
   留下 facade 或重复改同一批基线。全部实现与用例完成后集中验证一次。
2. **「隔离迁 kernel」指 task 自有的编排**：物理 FS / Git 算法留在 `platform/workspace/local/isolation.ts`；只把 task-execution 与 platform
   共用的中立 DTO 类型抽到 `platform/contracts/isolationWorkspace.ts`（只有一份定义，不复制同形类型）。
3. **许可一个工厂、一套实例**：`engine/kernel/permits.ts` 导出 `createExecutionPermitRegistry()`，内部保持 worktree、question、三类节点池、
  fanout 各自独立，不合成一个信号量；跨 context 的消费者经 TE exact public 合同拿到它（COL → TE 是 DAG 实线），不 import kernel。
4. **mint 进入 kernel 的只是调用合同**：`engine/kernel/nodeRunLedger.ts` 绑定既有 lifecycle 端口与执行上下文，方法名用守卫认得的
  `setNodeRunStatus` / `transitionNodeRunStatus` / `mintNodeRun`（RFC-400 的教训：通用名会让转移表预言丢站点）；不复制 SQL 或 mint 程序。
5. **共享合并冲突解决留在节点层**：`resolveMergeConflicts` 含合成 run、runtime 选择与 agent 执行，归 `engine/node/shared/`；kernel 只接收它
   作为回调，不 import。
6. **script 输出解析经端口注入现有实现**：`extractScriptPorts` 依赖共享 envelope 实现，本次不扩到 envelope 全家迁移；engine 仍不 import
   `@/services`（由装配注入）。
7. **保持真实执行顺序**：design §5.4 的箭头是阶段概览；script 现行顺序是「上游输入 → 首次 run-row 解析 → interpreter → script 许可 →
   隔离创建与持久 → 依赖安装 → running 写入与广播 → effect prepare → 进程 receipt / 激活 / 输出 → 输出 + NodeRun / effect 结算 →
   writable 合并 → assembly 结果 → 反向释放 → 清理」，本 RFC 不重排。
8. **偏离项**：落档时无；实施中接受的偏差记在下一条。
