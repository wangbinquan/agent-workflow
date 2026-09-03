# RFC-354 — 节点语义统一：参数 / 返回值 / 闭包 + 帧（全部 14 种节点，任意深度嵌套）

- 状态：Draft（2026-09-03，待用户批准；批准前不动任何生产代码）
- 发起：用户 2026-09-03「当前工作流规则校验不允许包装器嵌套……是不是可以直接放开」→ 源码对账后升级为
  「包装器为什么没有按节点抽象？包装器不就是一张图吗，和子工作流有什么区别？」→ 用户裁决抽象
  「输入边就是输入，输出边就是输出，穿墙边是闭包」→ 用户追问「所有节点是不是都是入参、输出、闭包这样的统一简洁抽象」
  → 对账结论「没有」→ 用户裁决**并进本 RFC 一次做完**。
- 目录名沿用 `RFC-354-wrapper-as-node`（索引与 STATE 链接已登记），标题按扩后的范围改写。
- 前置：RFC-060（fanout-as-wrapper：`wrapper-input` / `wrapper-output` 边界边的先例）、RFC-094（`wrapper-loop-nested`
  禁令）、RFC-098（wrapper 语义收口）、RFC-130（节点级 worktree 隔离）、RFC-146（`declaredPorts` 单一端口表）、
  RFC-147（系统通道注册表）、RFC-199（`workflow-node-references` 引用清单）、RFC-292（schema v5 升级器先例）、
  RFC-306（`skipped` 行）、RFC-339（WrapperRuntime 归位）、RFC-348（intent teaching 注册表）、RFC-349（双 provider contract）
- 直接输入：`design/scheduler-audit-2026-06-10.md`（S-6 / 缺口 3 / 缺口 4）、
  `design/task-execution-architecture-audit-2026-08-03.md`（§数据模型 ③）

## 0. 终态一句话

**每一种节点都只有四个概念**：**参数**（以它为 target 的边）、**返回值**（以它为 source 的边可用的端口）、
**闭包**（对有体的节点：从体外直连体内的边，容器执行打开时按词法环境绑定）、**帧**（每次执行一行 `node_runs`，
挂在所属容器执行之下）。今天并存的第二、第三种连接写法——PortRef 字段（`review.inputSource`、`output.ports[].bind`、
`wrapper-loop.outputBindings` / `exitCondition.nodeId`、`wrapper-fanout.inputs[]`）与独立的系统通道注册表——全部收成边；
clarify 节点像所有节点一样用自己的行表达生命周期。包装器嵌套因此成为递归、深度不限；`wrapper-loop-nested` 退役。

## 1. 背景：按 kind 对账（2026-09-03）

### 1.1 今天的连接有三种写法，返回值形状每 kind 一套

| kind                                | 参数（入）                                                                       | 返回值（出）                                                                    | 闭包 / 体                                       | 帧                                   |
| ----------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------ |
| `agent-single`                      | 边推导 → prompt 变量（`nodePorts.ts:184`「never declared」）                      | agent frontmatter `outputs` → envelope 端口                                     | 叶子                                            | 一行 / 次                            |
| `script`                            | 边推导 → `AW_PORT_*` env                                                         | 声明端口或隐式 `stdout`                                                         | 叶子                                            | 一行                                 |
| `code-host-call`                    | 不声明，参数按名字模板解析（`:333` D22）                                          | 固定 `response` / `status`                                                      | 叶子                                            | 一行                                 |
| `call-workflow`                     | 镜像子工作流 `inputs[].key`                                                       | 子工作流 `output` 节点端口并集                                                  | 体 = 另一张图，**无闭包**（跨 task）            | child task                           |
| `call-workgroup`                    | 边推导 → `goalTemplate`                                                          | 固定 `result`（`nodeMechanics.ts:1748-1760`）                                   | 体 = 工作组回合（RFC-164，不走 DAG）            | child task                           |
| `input`                             | launcher 表单                                                                    | 单端口 = `inputKey`                                                             | 叶子                                            | 一行（虚拟）                         |
| `output`                            | **边 + `ports[].bind` 双写**（`canvas/connectionSync.ts:181-199`）                | 无（sink）                                                                      | 叶子                                            | 一行（虚拟，`nodeMechanics.ts:3345`） |
| `review`                            | **边 `__review_input__` + `inputSource` 双写**（`schemas/review.ts:88-95` 自陈「lock-step」，`connectionSync.ts:171-178`） | `approved_doc` / `accepted`（名随输入 kind 变）+ `approval_meta`                | 叶子                                            | 一行                                 |
| `clarify` / `clarify-cross-agent`   | **系统通道**（`SYSTEM_CHANNEL_PORTS` 5 个端口名，各带 `dataflow` 跳过规则 + prompt 注入） | 系统通道                                                                        | 叶子，派发在 DAG 之外（executor 是 no-op）       | 行由 collaboration 侧铸，frontier 按 `settlesWithoutRow` 无行判完成（`dagFrontier.ts:211-219`） |
| `wrapper-loop`                      | 拒入边（validator ≈`:1087`）                                                      | `outputBindings` / `exitCondition` = **PortRef 字段，不是边**（示例中无任何 `target: <loop>` 的边） | 有体，闭包读法是数值近似（§1.2）                | 代际行                               |
| `wrapper-git`                       | 拒入边                                                                           | 固定 `git_diff`                                                                 | 有体，同上                                      | 代际行                               |
| `wrapper-fanout`                    | 声明式 `inputs[]` + `wrapper-input` 边界边                                        | `wrapper-output` 边界边                                                         | 有体，**无闭包**（绕开 runScope）               | 代际行 + shard 子行                  |
| `code-round`                        | 无端口，不可创作（RFC-304）                                                       | 无                                                                              | —                                               | 一行（StageEngine 驱动）             |

**已经统一的**：NodeKind 闭集 + 四张 `satisfies Record<NodeKind,…>` 穷尽表（行为 `node-kind-behavior.ts`、端口
`nodePorts.ts`、引用 `workflow-node-references.ts`、intent teaching）、执行器注册表（`engine/node/*`，RFC-334）、
`node_runs` / `node_run_outputs` 一套存储、一套模板文法（RFC-292 `workflowTemplateSurfaces.ts`）。

**没统一的，三处**：① 同一条「连接」三种写法（普通边 / PortRef 字段 / 系统通道边），review 与 output 甚至边和字段双写，
图走查器要在 `buildScopeUpstreams:101-129`、`wrapperExternalUpstreamSources:153+`、validator、canvas 四处各特判；
② 返回值形状每 kind 一套，`PORT_DERIVERS` 只把各家形状**列出来**、没把它们**变成一种**；③ 帧不齐——clarify 家族的完成
不由自己的行决定，工作组回合在 DAG 之外。

### 1.2 包装器的闭包只实现了一半，嵌套因此被禁

- `design/design.md:539` 原始设计：`nodes: Node[] // 含 wrapper（wrapper 是一种 node）`；`:761`「**内存里**建一个执行图：
  wrapper 展开为子图」。`schemas/workflow.ts:866-869`：`nodeIds[]` 平铺引用兄弟。`node_runs` 只有扁平 `iteration`
  （`db/schema.ts:1799`），到迁移 `0222` 为止没有任何帧轴。
- 闭包的**捕获**已经存在：`wrapperExternalUpstreamSources`（`services/dispatchFrontier.ts:134-152`）求的就是自由变量集，
  `openGeneration` 时 `resolveConsumed`（`wrapperRunLifecycle.ts:127-135` → `sqliteWrapperRunPersistence.ts:40-51`）把它们
  绑定成 consumed provenance。**但体内读点不读这份绑定**：每次派发去翻外层节点的行，用「`iteration ≤` 当前轮、取最高」
  决定读哪一行（`nodeMechanics.ts:4928-4934` → `freshness.ts:186-200`）——单层下碰巧等于词法环境，嵌套下不成立
  （审计「跨 loop/git 边界直连边双重失效」，`scheduler-audit-2026-06-10.md:367`）。
- 内层 loop 从自己的 0 计数（`loopStrategy.ts:189`），frontier 第一句 `if (r.iteration !== iteration) continue`
  （`dagFrontier.ts:152`）：外层第 2 轮起内层静默 no-op（`tests/scheduler-audit-s06-nested-loop-inner-noop.test.ts`
  锁：外 2 × 内 2 只调起 2 次，正确 4 次）；`wrapperRevivalEvidence` depth-1（`dispatchFrontier.ts:253,265`）。
  RFC-094 因此把 loop 嵌 loop 标 error。审计 2026-08-03:110：「文档承诺的核心能力外化成了产品缺口」。

### 1.3 和子工作流的区别只是帧画在哪

`call-workflow` 就是「节点 + 子图」（`nodeMechanics.ts:1190-1199`），每次执行体有帧（child task），所以任意嵌套毫无问题。
本 RFC 之后二者是同一抽象的两个档位：wrapper = 内联 lambda（帧 = container run），call-* = 调用定义在别处的函数
（帧 = child task，只能传参不能捕获调用方局部量）。

### 1.4 为什么一直没改

每个触及 wrapper 的 RFC 都选择「复用一根既有的轴」（RFC-060 §1.2、RFC-339 §3）；每个新 kind 都自带一套入出口形状
（RFC-005 review 的 `inputSource`、RFC-016 loop 的 `outputBindings`、RFC-060 fanout 的 `inputs[]`、RFC-023/056 的系统通道）。
审计 2026-08-03:66「四类 wrapper 是四段并列的手写过程」、:202「每来一种新执行体就补一根正交轴」。用户裁决：**修抽象**。

## 2. 目标 / 非目标

### 2.1 目标

- **G1 参数一种写法**：任何节点的参数 = 以它为 target 的边，端口名 = `target.portName`。声明式参数只剩两种来源：
  kind 固定（review `__review_input__`、clarify `questions`、系统通道端口）与 call-workflow 镜像子图 `inputs[].key`；
  其余全部边推导（agent / script / code-host-call / call-workgroup 今天已是；**output / loop / git / fanout 本 RFC 改为**）。
- **G2 返回值一种声明面**：任何节点的返回值 = `declaredPorts(node).dataOutputs`，来源三种：kind 固定、资源声明
  （agent `outputs` / script）、体内提升（loop / fanout 的 `wrapper-output` 边界边；call-workflow 子图 output 节点的参数集）。
  **loop 的 `outputBindings` 改为 `wrapper-output` 边界边**（fanout 已有的形状），`exitCondition` 改为对 loop **自己的返回值端口**的谓词。
- **G3 闭包**：外→体内直连边保持合法；体内读点改读容器执行打开时绑定的环境（沿帧链查找），`iteration ≤` 数值窗口退役。
  只对有体的 kind 成立；call-* 跨帧无闭包（抽象自洽）。
- **G4 帧**：`node_runs` 新增 `container_run_id`（所属 wrapper 代际行）与 `scope_path`（派生）；`iteration` 收窄为帧内轮次；
  嵌套任意深度不再碰撞；`wrapper-loop-nested` 退役（三层以上一并支持）。
- **G5 PortRef 字段退役**：`review.inputSource`、`output.ports[].bind`、`wrapper-loop.outputBindings` /
  `exitCondition.nodeId`、`wrapper-fanout.inputs[]` 全部删除，由边表达；`$schema_version` 5 → 6，纯升级器机械改写；
  `workflow-node-references.ts` 只剩容器引用（`nodeIds`）与控制策略引用（review `rerunnableOn*`）。
- **G6 系统通道折进端口表**：`SYSTEM_CHANNEL_PORTS` 并行注册表删除，五个通道端口的 `promptInjected` / `dataflow` 语义
  作为 `DeclaredPort.channel` 挂在 `PORT_DERIVERS` 的 `systemInputs/systemOutputs` 条目上；运行语义不变。
- **G7 clarify 用行表达生命周期**：clarify / cross-clarify 节点被访问而无 open round 时铸 `skipped` 行（RFC-306「闸门未触发」），
  agent 发问时 collaboration 铸的 park 行作为更新的行覆盖它；`settlesWithoutRow` 从行为表删除，frontier pass-2 删除。
- **G8 clarify 同帧**：`clarify_rounds.loop_iter` 挂到帧（新增 `container_run_id`）。
- **G9 fanout 内 wrapper 的校验前置**：补 schema-time error（fanout 体能力本身不扩张，W8）。

### 2.2 非目标

- 不把 `nodeIds[]` 平铺引用改成物理嵌套（用户已确认 D1）。
- 不扩张 fanout 体（闭包 / inner chain / 体内 wrapper）——RFC-339 §3 留给 W8。
- 不做跨轮反馈端口（本 RFC 之后它只是「返回值回喂下一轮参数」，不需要新轴）。
- 不把 `call-workflow` 并入 WrapperRuntime；不改工作组回合引擎（RFC-164）——`call-workgroup` 作为节点已符合模型（参数边推导、返回值固定 `result`、帧 = child task）。
- 不改 review 的 `rerunnableOnReject` / `rerunnableOnIterate`（它们是重跑策略，不是数据边）。
- 不改 `code-round`（不可创作的合成节点）。
- 安全类项目一律不承接（用户 2026-08-26 硬规则）。

## 3. 用户故事

- **US-1（嵌套修复循环）**：外层 loop「审计 → 修复」3 轮，里面再套 loop「修到测试通过」5 轮。保存无告警、启动不被拒；
  任务详情里能看到「外 2 › 内 3」，每一轮内层 agent 都真实跑了。
- **US-2（闭包）**：把「待修问题」输入节点直接连到 loop 体内的修复 agent——今天怎么画以后还怎么画；两层 loop 之内的 agent
  也拿到同一份值。
- **US-3（参数）**：把上游输出连到 loop 卡片本身的输入行，再从卡片内侧连给体内节点；卡片上能看出这个 loop「吃什么」。
- **US-4（返回值）**：从体内 agent 的端口拖到 loop 卡片右侧的输出行，就是 loop 的返回值；退出条件从 loop 自己的返回值里选，
  不再要我去指体内某个节点。fanout 今天就是这样，loop 现在一样。
- **US-5（review / output）**：我连一条边到 review 或 output，定义里只多一条边，没有第二份藏在字段里的副本；
  导出的 YAML 更短，手写时只写 `edges`。
- **US-6（嵌套里的反问）**：内层 loop 的 agent 在外 2 › 内 1 反问；我回答后它从那一轮继续。任务详情里 clarify 节点在没被
  触发的轮次显示为「跳过」，触发的轮次显示问答。
- **US-7（恢复 / 重试）**：daemon 在外 2 › 内 1 重启，resume 从那里继续；重试外 2 › 内 1 的 agent 只级联该帧之下的下游。
- **US-8（fanout 内放错东西）**：把 loop 拖进 fanout，校验面板立刻红，而不是启动后报 `v1-unsupported-inner-kind`。
- **US-9（旧工作流 / 旧 YAML）**：已保存的 v5 工作流打开时透明升级为 v6，画布多了 loop 卡片的输出行、少了双写字段，行为一字不差；
  导入 v4 / v5 YAML 同样自动升级。

## 4. 能力影响清单（`CLAUDE.md` §RFC workflow 第 7 条）

| #   | 既有能力                                                                                 | 本 RFC 之后                                                                                                                                                                  | 受影响的部署形态                                                                                   |
| --- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| C-1 | loop / git 拒绝入边                                                                       | 接受入边 = 参数（扩张）                                                                                                                                                      | —                                                                                                  |
| C-2 | 闭包边读值用「`iteration ≤` 窗口取最高」                                                   | 读容器执行打开时绑定的环境。单跑 / resume / 重试逐字不变；loop 运行中外层节点被人为重跑时运行中的帧读旧值、帧 stale 重开后读新值（既有 `rfc098-wrapper-stale-redispatch` 契约） | 只影响「循环中人为重跑外层节点」这一交互；由抽象决定                                                 |
| C-3 | `node_runs.iteration` = 全任务扁平轮次                                                     | = 帧内轮次；DTO 新增 `containerRunId` / `scopePath`                                                                                                                          | 读 `NodeRun.iteration` 的 API / MCP 消费者：单层不变；嵌套需改读 `scopePath`                          |
| C-4 | `clarify_rounds.loop_iter` = 所在 loop 轮次                                                | = 帧内轮次，新增 `container_run_id`                                                                                                                                          | 内部表                                                                                             |
| C-5 | loop 嵌 loop 被拒绝启动                                                                   | 放开（扩张）                                                                                                                                                                 | —                                                                                                  |
| C-6 | fanout 体内放 wrapper：校验放行、运行时硬失败                                              | 校验期 error（信号前移）                                                                                                                                                     | 含该拓扑的已保存工作流：校验面板红、启动被拒（与今天启动结果一致）                                      |
| C-7 | **workflow schema v5**：`review.inputSource`、`output.ports[].bind`、`loop.outputBindings` / `exitCondition.nodeId`、`fanout.inputs[]` 是定义的一部分 | **v6**：这些字段删除，由边表达；存量定义读出即透明升级，v≤5 YAML 导入自动升级；**v6 导出的 YAML 不能被升级前的 daemon 导入**（向下不兼容）                                       | 所有含 review / output / loop / fanout 的已保存工作流（仓内 32 个示例全部命中）——透明；跨版本共享 YAML 的团队需同步升级 daemon |
| C-8 | clarify 节点在未被触发的轮次没有任何行                                                     | 出现一条 `skipped` 行（任务详情可见「跳过」）                                                                                                                                | UI 可见变化；API `node_runs` 列表多出 skipped 行                                                     |

**C-7 是本清单里唯一的真实收缩**（v6 YAML 的向下不兼容），请确认。其余为扩张、语义收窄或纯增字段。

## 5. 验收标准

- **AC-1（嵌套跑通）**：`scheduler-audit-s06` 翻转（外 2 × 内 2 → 4 次）；三层嵌套 loop ⊃ git ⊃ loop ⊃ agent 用例，
  `scope_path` 逐行正确。
- **AC-2（禁令退役）**：`wrapper-loop-nested` 与 loop / git 拒入边分支全仓零命中。
- **AC-3（参数）**：14 种 kind 的 `declaredPorts(...).dataInputs` 只来自 kind 固定 / call 镜像 / 边推导三种来源；
  `wrapper-input` 边界边路由；`wrapper-input-port-missing` 正反例。
- **AC-4（返回值）**：loop 的返回值只来自 `wrapper-output` 边界边；`exitCondition.portName` 必须是 loop 自己的返回值端口
  （validator 正反例）；运行时按帧读 loop 返回值求退出。
- **AC-5（闭包）**：(a) 顶层值被两层 loop 之内的体读到同一行；(b) 外层 mid-loop 重跑 → 运行中帧读旧值、stale 重开后读新值；
  (c) 环境链找不到 → `closure-binding-unresolved`。既有 wrapper scheduler 用例不改断言直接绿。
- **AC-6（PortRef 字段退役）**：`workflow-node-references.ts` 的 `directPortRefs` / `embeddedPortRefs` / `bindingLists`
  对全部 kind 为空；`connectionSync.ts` 的 review / output 双写路径删除；源码守卫。
- **AC-7（升级器）**：`migrateWorkflowDefinitionToLatest` 级联到 v6；32 个示例 YAML + 全部 starter 的 golden（升级前后 diff
  只含字段删除 + 新边）；幂等；升级后 validator 零 error；升级前后**执行结果逐字相同**（既有 scheduler / review / clarify
  fixture 双跑）。
- **AC-8（系统通道折表）**：`systemChannelPorts.ts` 删除；`channelEdgeDataflowSkip` 等从 `declaredPorts` 派生；
  `rfc147-system-channel-ports` drift 测试改为端口表单一来源守卫。
- **AC-9（clarify 落行）**：`settlesWithoutRow` 从 `NODE_KIND_BEHAVIORS` 删除、frontier pass-2 删除；clarify 未触发轮次
  出现 `skipped` 行；既有 clarify / cross-clarify 的全部 backend 用例与 20 条 e2e **不改断言直接绿**。
- **AC-10（clarify 同帧）**：嵌套内 self / cross clarify 各一条用例。
- **AC-11（恢复 / 重试）**：resume 于外 2 › 内 1；单节点重试级联范围。
- **AC-12（回填）**：存量 `node_runs` / `clarify_rounds` 回填 oracle 未命中 = 0。
- **AC-13（双 provider）**：新列进 RFC-349 contract + 写矩阵 + parity。
- **AC-14（前端）**：loop / git 卡片参数行与 loop 输出行（复用 fanout boundary 行原语）；exitCondition 编辑器从 loop 返回值选；
  review / output 连线只写边；任务详情面包屑 + 按帧分组；inspector 参数 / 返回值只读列表。
- **AC-15（fanout 校验）**：体内非 `agent-single` → error；`shardSourcePort` 必须是某条入边的端口且 source kind 解析为 `list<T>`。
- **AC-16（文档）**：`docs/workflow-yaml.md` 的 `edges[]` / `wrapper-*` / `review` / `output` 小节更新；`design/design.md`
  §6.4-6.5 与 `CLAUDE.md` wrapper 段落对齐。
- **AC-17（CI）**：三个 PR 各自 exact SHA Main CI 35/35 + PostgreSQL evidence lane 绿。
