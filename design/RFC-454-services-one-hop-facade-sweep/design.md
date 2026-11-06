# RFC-454 技术设计

记号：`S/` = `packages/backend/src/`，`T/` = `packages/backend/tests/`，`SH/` = `packages/shared/src/`，`L/` = `S/services/`；
TE = task-execution、CO = collaboration、RC = resource-catalog、SO = system-operations、RM = runtime-management、EC = event-center。

## 0. 架构落位（RFC-294 第 8 条）

- RFC-294 plan §4.6 W9-D：「所有 facade 的生产与测试 consumer 归零后删除；`services/` 只剩到期删除的一跳 facade」。本 RFC 删除其中 30 个，
  余下 6 个写明去处（§4）。
- 不新增目标 DAG 之外的边：被转出藏起来的 6 处反向 / 越界依赖里 5 处背后是纯函数或常量，按真实使用者下沉（§2）；第 6 处
  （`sessionEventSink`）的类型依赖 `L/runtime/types`，随运行时驱动归位再处理。
- 不新增 public surface 偏差：跨模块只新增纯函数与只含 shared 类型的类型导出；带数据库句柄的 legacy 函数不进 public（§4）。
- 不新增 `module-layer-violations`：application 不经任何路径取本模块或他模块的 `infrastructure/`。

## 1. 30 个转出的处置

| 转出（`L/`）                                                                                                                                       | 生产消费方                                                                                  | 处置                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `execution/resolveInjection`、`scriptDepsEnv`、`runner`                                                                                            | 无（只有用例）                                                                              | 删除；用例改取声明处                                                           |
| `backup`、`backupManifest`、`restore`                                                                                                              | SO infrastructure、`L/portableBackupArchive`、`L/rawDbSnapshot`                             | 改取 `S/platform/persistence/sqlite/*`                                         |
| `backupScheduler`                                                                                                                                  | `S/bootstrap/daemonSession`                                                                 | 改取 `S/platform/background/providerBackupScheduler`                           |
| `execution/managedProcess`                                                                                                                         | bootstrap、RC、TE application（两个常量）                                                   | 改取 `S/platform/execution/local/managedProcess`                               |
| `protocol`                                                                                                                                         | TE application `taskAgentRun`                                                               | 改取 shared 的 `renderUserPrompt`                                              |
| `runtime/usage`                                                                                                                                    | `L/runtime/*`（legacy）                                                                     | 改取 RM `public/participants`                                                  |
| `lifecycle`                                                                                                                                        | bootstrap、CO `review`、`L/task`                                                            | 改取 TE `public/operations`                                                    |
| `clarify/autoDispatch`、`clarify/rerunLedger`、`clarifyRerunLedger`、`clarify/service`、`clarifyDecision`、`taskQuestionDispatch`、`taskQuestions` | CO infrastructure（回取自己）                                                               | 改取 CO 声明处（相对路径）；`clarify/service` 的 TE 消费方见 §2                |
| `execution/taskEngineRuntimeOptions`                                                                                                               | TE composition（回取自己）                                                                  | 改取声明处                                                                     |
| `pendingRestore`                                                                                                                                   | SO infrastructure（回取自己）                                                               | 改取声明处                                                                     |
| `pluginInstaller`                                                                                                                                  | RC infrastructure（回取自己）、`L/resourcePackage/pluginInstallerAdapter`                   | 改取声明处（legacy 适配器同一条 `R1` 边换个起点，随 resourcePackage 一族归位） |
| `clarify/rounds`、`clarifyRounds`                                                                                                                  | TE composition `agentNodeExecution`                                                         | §2.1                                                                           |
| `execution/closure`                                                                                                                                | RC infrastructure `workflow.validator`、TE application port、`L/execution/triggerPreflight` | §2.2                                                                           |
| `scriptRun`                                                                                                                                        | EC composition / infrastructure                                                             | §2.3                                                                           |
| `workflow.yaml`                                                                                                                                    | `S/platform/persistence/portableApplicationAssets`                                          | §2.4                                                                           |
| `workgroup/askerKey`、`workgroup/constants`                                                                                                        | CO infrastructure                                                                           | §2.4                                                                           |
| `workflowLaunchInputs`                                                                                                                             | integration composition、TE infrastructure ×2                                               | §2.2                                                                           |
| `resourceRefs`                                                                                                                                     | intent application `dumpBuilder`                                                            | §2.4                                                                           |

## 2. 藏边归位（函数体原样，两处例外见 §2.1、§2.2）

### 2.1 澄清判定 → TE `domain/clarifyRules.ts`

`resolveEffectiveClarifyChannel`、`shouldInjectStopNotice`、`computeRemaining`（RFC-122 / RFC-023 的纯判定，原在
`S/modules/collaboration/infrastructure/clarifyRounds.ts`）与 `findClarifyNode`（原在 CO `infrastructure/clarify/service.ts`）只有
TE 用：TE composition 把它们绑进 `application/ports/agentNodeExecution` 的 `rules`，由 `engine/node/agent-single` 调用。CO 自己不用。
四个函数迁入 TE `domain/clarifyRules.ts`，TE composition 改取 domain；CO 的两个文件删去这四个函数。TE → CO 不是目标 DAG 的边，
这样 TE 不再经 `services/` 取 CO 内部。

迁入时改一行：`computeRemaining` 取循环成员改经 TE `domain/executionScope.ts` 的 `directNodeIdsOf`（RFC-339：TE 里包装节点的成员只由
作用域索引的这一个读者读，`rfc339-wrapper-runtime-cutover` 扫 TE 全目录的裸 `.nodeIds`，函数在 CO 时不在扫描面内）。`directNodeIdsOf`
对非数组给空、只留字符串项，而这里查的是一个字符串节点 id，所以对一切输入同解；新用例补了非数组成员、非字符串项、非循环包装与
上限非正的对照。

### 2.2 调用闭包编解码与启动输入校验 → RC `domain`

- `S/modules/task-execution/infrastructure/legacyCallClosure.ts` 里只依赖 shared 的部分（`FrozenWorkflowRef`、`FrozenWorkgroupRef`、
  `FrozenWorkgroupGroupSchema` / `FrozenWorkgroupGroup`、`FrozenCallClosure`、`callEdgeKey`、`parseCallClosure`、
  `frozenWorkflowFromClosure`、`frozenWorkgroupFromClosure`、`childClosureSubset`）迁入 RC `domain/callClosure.ts`：闭包是 RC 资源
  定义（工作流 / workgroup）的冻结快照，RC 的 `workflow.validator` 与 TE 的子任务启动都读它；RC → TE 不是目标 DAG 的边，TE → RC 是。
  RC `public/types` 导出四个类型，`public/queries` 导出纯函数与 `parseFrozenWorkgroupGroup`（取代 TE 直接调
  `FrozenWorkgroupGroupSchema.parse`，zod schema 不进 public）。`freezeCallClosure`（读库、ACL）留在 TE infrastructure，改取 RC public。
- 类型上改一处：`FrozenWorkgroupRef.group` 原为 `unknown`，在 TE infrastructure 里不算公共面；进 RC public 后它会成为公共面的开放
  类型（W0-R 偏差 +2：`frozenWorkgroupFromClosure` 的返回值与 `parseFrozenWorkgroupGroup` 的形参）。改为 `FrozenWorkgroupGroup`：
  生产冻结（TE `application/taskExecutionCallClosure.ts`）写入的就是这个形状（它本地的同名类型也这样写）；解码仍只查是对象（断言
  成该类型），启动处照旧用 schema 复验（旧闭包带行元数据，复验时剥掉；坏数据仍在启动时以 `child-launch-failed` 收场）。运行时零变化。
- TE `application/ports/childExecutionLaunchOperations` 的 `FrozenWorkgroupRef` 改取 RC `public/types`（原来经 `services/` 取 TE
  infrastructure，是被藏起来的 application → infrastructure）。
- `assertWorkflowLaunchInputs`（原 RC `infrastructure/legacy/workflowLaunchInputs.ts`，只依赖 shared 类型与 `ValidationError`）迁入
  RC `domain/workflowLaunchInputs.ts`，经 RC `public/queries` 导出；integration composition 与 TE 两个 infrastructure 改取 public；
  RC 内部原文件改为直取 domain（文件删除，RC 内的消费方改指）。

### 2.3 脚本解释器解析 → `S/platform/execution/local/scriptInterpreter.ts`

`S/modules/task-execution/infrastructure/local/scriptRun.ts` 里解释器的登记与探测（`INTERPRETER_SPEC`、`WINDOWS_INTERPRETER_CANDIDATES`、
`gitBashCandidatesFromGitPath`、`gitBashFromGitPath`、`INTERPRETER_PROBE_TIMEOUT_MS`、`ResolvedInterpreter`、`resolveScriptInterpreter`、
`describeInterpreterResolution`、`interpreterCandidatePaths` 及其私有探测）是宿主机制：TE 的脚本节点与 EC 的自定义观察者程序都要
「这台机器上用哪个 python / bash / node」。迁入平台（与 `managedProcess` 同目录，不取任何模块），TE 的 `scriptRun` 与 EC 改取平台。
EC → TE 不是目标 DAG 的边。

### 2.4 纯词表与纯函数 → shared

- workgroup 宿主节点 id：shared 已有 `WORKGROUP_TURN_LEADER_NODE_ID` / `WORKGROUP_TURN_MEMBER_NODE_ID`（`SH/workgroupHostIdentity.ts`），
  RC `infrastructure/legacy/workgroup/constants.ts` 的 `WG_LEADER_NODE_ID` / `WG_MEMBER_NODE_ID` 是它们的重复；CO 的提问派发改取 shared，
  shared 补 `WORKGROUP_TURN_CLARIFY_NODE_ID`（`'__wg_clarify__'`），TE `childExecutionLaunchOperations.ts` / `workgroupRuntimeConfig.ts`
  与 CO `collaborationWorkgroupClarify.ts` 的本地副本改取 shared（值相同）。`WG_RERUN_CAUSE` 生产与用例零使用，随文件删除。
  `wgClarifyAskerKeyForRound`（原 `.../workgroup/askerKey.ts`，shared `wgClarifyAskerKey` 的五行包装）只有 CO 的澄清封存用，迁入
  CO `domain/workgroupClarifyAskerKey.ts`。RC 的两个 legacy 文件删除。CO → RC 不是目标 DAG 的边。
- `SH/workflow-yaml.ts` 收 `stringifyWorkflowYaml`（原 RC `infrastructure/legacy/workflow.yaml.ts`，是 shared
  `stringifyWorkflowYamlDocument` 的十行适配）：平台的备份资产导出不再经 `services/` 取 RC（平台 → 模块为 0 的规则此前被这一跳藏住）。
- `SH/resourceReferences.ts` 收 `extractWorkflowAgentRefs`（原 RC `infrastructure/legacy/resourceRefs.ts`，是 shared
  `collectWorkflowDependencyRefs` 的过滤）：intent 的转储直接取 shared（intent → RC 虽给出，但 `Set` 进 public 会成为偏差，而它本就
  是 shared 函数的一层过滤）。

## 3. 用例

- **新用例** `T/rfc454-services-one-hop-facade-sweep.test.ts`：30 个转出文件不存在、`S/` 与 `T/` 零引用（census AST，别名与相对路径
  都认，带负对照）；余下 6 个转出的生产消费方清单精确相等（不增）；§2 的落点各有一条行为锁——四个澄清判定与原实现的真值表、调用
  闭包 v1 / v2 解析与边键、`parseFrozenWorkgroupGroup` 剥掉行元数据、解释器登记的三种语言、workgroup 宿主节点 id 的线上取值与
  `wgClarifyAskerKeyForRound` 的三种键、`stringifyWorkflowYaml` 与 `extractWorkflowAgentRefs` 的输出；CO 的 `clarifyRounds` /
  `clarify/service` 不再导出迁走的函数；EC 与 platform 不取 TE / RC。
- **随迁的守卫表**：`T/rfc345-resource-acl-facade-retirement.test.ts` 的 facade 登记表、`T/architecture/rfc376-structural-guards.test.ts`
  的精确清单、架构报告的 legacy 归属表删去这 30 个文件（不可达清单另见 §4 末）。
- **集中验证查出、随之改锚的锁**：`T/cross-clarify-designer-rerun-no-rollback.test.ts` 的源码守卫原读 `L/clarify/service.ts` 与
  `L/taskQuestionDispatch.ts`——两个都是转出，「不含回滚助手」的断言只看到再导出行；改读 CO 的实现文件，断言才落到实处。
  `T/clarify-prompt-wire-up.test.ts` 的 stop 门改读 TE `domain/clarifyRules.ts`。`T/fixtures/rfc395-serialized-insert-source-locks.json`
  里 CO `clarify/seal.ts` 的摘要随三行 import 改指重钉（复核：轮次锁、调用方事务与答案写入顺序不变，写进该条 `why`）。
  `windows-platform` 两份触发清单里的 `L/runtime/usage.ts` 改列 RM `domain/usageMeter.ts`。
- **改 import 的用例**：约 300 处经转出取的用例改取声明处（脚本按导入名分到新位置）。
- 架构账本、`guard-manifest.json`、`commons-debt.json`（`R1` / `R2` 销账；资源包插件安装适配器改直取安装器，原记在转出上的那条边
  换了起点）、架构报告 legacy 归属表、`rfc376` 精确清单按实测刷新；`commons-manifest.json` 三个内核的文件改指实现处；两份 workflow
  触发清单（`integration-opencode` 改列代理运行与协议渲染的实现文件，`windows-platform` 改列脚本执行器，解释器解析已在
  `platform/execution/local/**` 下）与各守卫里写着旧路径的文本锁随迁——读转出文件内容的锁改为断言文件不存在，扫描转出的锁改扫实现文件。

## 4. 余下 6 个转出

| 转出                                      | 生产消费方                                                              | 去处                                                                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `sessionEventSink`                        | intent、memory、`L/runtime/opencode/sessionCapture`、`L/systemAgentRun` | 类型依赖 `L/runtime/types` 的 `NormalizedEventKind`，intent / memory → RM 不是目标 DAG 的边：随运行时驱动与系统代理运行归位 |
| `workflow`（`getWorkflow(db, …)`）        | TE infrastructure、`L/taskLaunchGate`                                   | RC 的执行期查询端口（不新增带 `PersistenceDb` 的 public 导出）                                                              |
| `workgroups`（`getWorkgroupById(db, …)`） | TE `legacyCallClosure`（RFC-349 冻结遍历的行为 oracle，只有用例调用）   | 同上                                                                                                                        |
| `workflow.validator`                      | `L/task`、`L/taskLaunchGate`                                            | 只剩 legacy 消费方：随 E1（`task.ts` 退役）与启动门归位                                                                     |
| `skillBootVerify`、`skillIdentityPaths`   | TE `legacyTaskExecutionInjectionResolver`                               | 启动期状态与文件系统：RC 给 TE 的技能注入端口                                                                               |

三个文件随本 RFC 变为生产不可达：TE `infrastructure/legacyCallClosure.ts`（编解码迁走后只剩 oracle `freezeCallClosure`）、它读的
`L/workgroups.ts`、RC `infrastructure/legacy/workflow.yaml.ts`（唯一的生产导出 `stringifyWorkflowYaml` 迁入 shared 后只剩用例在用的
YAML 预览与选择器投影，RFC-401 T6 已删去导入写入）。此前它们只因转出的再导出链被算作可达。RFC-376 G14 的不可达精确清单把它们登记
为保留（与已在清单里的注入 oracle 同一处理），继任写 RFC-294 W9-D；同时删去的 3 个只剩用例在用的转出出了清单，总数 27 → 27。

## 5. 失败模式

- 漏改的消费方：tsc 兜底（转出文件删除后取不到）；用例经新用例的零引用断言兜底。
- 下沉后形成值环：`backend-value-scc` / `context-value-sccs` 上限 0；
- 新增越界：off-DAG 值边、`module-layer-violations`、跨 context 内部文件对、public surface 偏差的精确清单 / 上限兜底；
- 平台取模块：`platform-to-modules-file-pairs` 上限 0（脚本解释器只取 shared 与 util）。

## 6. 测试策略

迁移所涉用例全部复跑（SQLite 全量 + PostgreSQL 受影响面）；新用例见 §3；P0 变异 lane 两引擎各 17 阶段。
