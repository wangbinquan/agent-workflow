# RFC-242 · 统一执行器与工作流组合（子工作流 / 工作组调用节点）

- 状态：Draft
- 日期：2026-07-31
- 发起：用户要求「把系统里的 agent 执行、工作流执行、工作组执行做统一的执行器抽象封装，
  支持通用的任务调用，为后续工作流可以引用其他工作流以及工作流引用工作组做准备」；
  经两轮共 8 问澄清后，范围拍板为**抽象 + 两类调用节点全量落地**（见 §3 D1）。
- 相关设计：RFC-164/167/217（工作组与回合引擎）、RFC-165/218（单 Agent 宿主快照启动）、
  RFC-060（wrapper-fanout）、RFC-130（隔离 worktree 与 merge-back）、RFC-097（生命周期 CAS）、
  RFC-159（定时任务三 kind 启动）、RFC-099/231（资源 ACL 与引用闭包授权）、
  RFC-230（Run 活性证据链——`runLiveness.ts` 已落地，本 RFC 扩展其 `delegated` 证据到
  跨任务「子任务委派」）、
  `design/arch-audit-2026-06-23/`（NodeKind 触点清单与「sub-workflow 迟早要做」的预判）。

## 1. 背景

平台今天有三种「可执行物」，在任务层已经半统一、在调用层完全割裂：

- **任务层已统一**：三种执行最终都是一条 `tasks` 行 + 启动时冻结的 workflow 快照。
  工作流直接用自己的定义；单 Agent 合成 `__agent_host__` 宿主快照（RFC-165/218）；
  工作组合成 `__wg_leader__` 等三节点宿主快照（RFC-164）。判别器 `taskExecutionKind()`
  （`packages/shared/src/schemas/task.ts:456`）与定时任务的 `launch_kind`
  （`workflow | agent | workgroup`）已经是全仓唯一三值枚举。
- **调用层割裂**：`startTask` / `startAgentTask` / `startWorkgroupTask` 三套入口签名、
  三套校验链、三套输入形状；「拿结果」三家各不相同（工作流有 output 绑定、Agent 有声明端口、
  **工作组任务没有任何稳定输出产物面**——RFC-184 故意让 host run 不落 `node_run_outputs`）；
  「等它结束」「取消它」没有统一动词。`scheduleLaunch` 是唯一同时面对三种 kind 的调用方，
  只能自己 switch 分发。
- **组合能力缺失**：工作流引用工作流从 v1 起被显式排除（`design/proposal.md:36`），
  架构审计把 NodeKind 注册面缺失列为 rank 4/5 技术债、把 sub-workflow 列为
  「产品迟早要的组合原语」。工作流引用工作组则完全没有先例。

其结果：无法把「审计+修复」这类成熟工作流沉淀为可复用构件被别的工作流调用；无法在
DAG 的一个环节把问题交给一个工作组协作解决；平台内部每多一个想「发起一次执行并拿结果」
的调用方（今天的定时任务、明天的调用节点、后天的 API 消费者），都要重新面对三套入口。

本 RFC 一次交付三件事：

1. **统一执行器抽象**（Executor）：`发起 / 结果投影 / 等待终态 / 取消` 四件套统一契约，
   收编三个既有 HTTP 启动端点与定时启动，行为零变化。
2. **`call-workflow` 节点**：工作流引用另一个工作流，子执行以独立子任务运行于
   派生自父工作区的隔离 worktree，完成后合并回父工作区，输出按子工作流 output 绑定回填端口。
3. **`call-workgroup` 节点**：工作流引用一个工作组，同样以独立子任务运行；本 RFC 同时
   给工作组任务补上**最小输出投影**（`result` 端口），作为下游输入。

## 2. 目标

1. 新增 `services/execution/` 统一执行器：`ExecutionRef{kind,id}` + 统一发起请求 →
   `taskId`；统一结果投影（per-kind）；统一等待终态与取消。三个既有启动路由与
   `scheduleLaunch` 全部内部收编，对外 wire 不变。
2. `scheduler` 的引擎分流点（`runScope` vs `runWorkgroupEngine`）显式化为执行器注册表的
   一部分；不合并两种推进引擎。
3. 新增 `call-workflow` / `call-workgroup` 两种节点 kind：画布可创建、可配置、可校验、
   可执行、可重试、可恢复、可取消。
4. 子执行 = 独立 `tasks` 行：新增 `parent_task_id` / `parent_node_run_id` 溯源列与
   调用节点行上的 `child_task_id`；子任务复用全部既有生命周期机制（恢复/取消/诊断/UI）。
5. 子任务工作区继承父任务：从父工作区当前状态（含未提交变更）派生隔离 worktree，
   子任务完成后合并回父工作区，复用 RFC-130 机制；调用节点默认按 writer 参与父任务写串行。
6. 工作组任务获得最小输出投影：任务 done 后可稳定读到 `result`（完成结论文本），
   `call-workgroup` 节点将其回填为输出端口；独立启动的工作组任务同样可读。
7. 引用闭包在**父任务启动时冻结**（子工作流定义+版本、工作组配置快照），启动时做闭包环
   检测，运行时做嵌套深度与全局活跃子任务限额守卫。
8. 任务列表默认只显示顶层任务，子任务可展开/筛选；父任务详情的调用节点直链子任务。

## 3. 产品决策

用户两轮澄清拍板（D1–D8），其余为本 RFC 依既有仓库原则推导、随批准一并生效（D9–D16）：

- **D1 — 全量交付**：本 RFC 同时交付执行器抽象与两类调用节点，不做「先抽象后消费者」的
  两段式。理由：抽象没有真实消费者容易设计跑偏；按 PR 分批落地（见 plan.md）。
- **D2 — 子执行 = 独立子任务**：每次调用生成独立 `tasks` 行，自有生命周期 / worktree /
  恢复 / 取消，任务列表可见（见 D8）；不做「父任务内嵌展开」。工作组回合制天然兼容。
- **D3 — 抽象覆盖面 = 发起+结果+等待/取消**：推进引擎（DAG 前沿 / 回合制）保持现状，
  只把分流点显式化。不做引擎收编。
- **D4 — 工作组最小输出本 RFC 落地**：给工作组任务定义并实现最小 `result` 投影
  （完成结论文本，具体载体见 design.md §工作组输出）；不做组级 outputs 端口声明。
- **D5 — 工作区继承：派生+合回**：子任务工作区从父任务 worktree 当前状态（含未提交）
  派生隔离 worktree，完成后合并回父，复用 RFC-130 节点级 iso/merge 机制的任务级形态；
  调用节点默认按 writer 参与父任务写串行。v1 不提供「独立工作区」节点选项。
- **D6 — 人工环节不冒泡**：子任务进入 `awaiting_review` / `awaiting_human` / 反问时，
  父任务保持 `running`，调用节点展示「等待子任务 X（状态）」并可点跳；处理入口在子任务
  自身页面。不做跨任务状态机联动。
- **D7 — 允许 fan-out 内子执行，受限额约束（实现期部分偏差，已登记）**：原拍板
  `wrapper-fanout` / `wrapper-loop` 内均允许调用节点。实现期确认 fanout 分片派发是
  agent 特化直调路径（`dispatchFanoutShard` 直调 `runNode`），per-shard 子任务需要
  单独的派发面改造——**v1 交付缩为：loop / git 内完整支持，fanout 内层由校验拒绝**
  （`call-workflow-in-fanout-unsupported`），等价写法为「子工作流自身包含 fanout」；
  完整形态登记为后续项（design §12）。全局活跃子任务并发限额、引用嵌套深度上限、
  启动闭包环检测、运行时深度守卫按原拍板交付。
- **D8 — 列表默认隐藏子任务**：任务列表默认只显示 `parent_task_id IS NULL` 的顶层任务；
  提供「含子任务」筛选与父行展开；父任务详情调用节点直链子任务详情。
- **D9 — 引用闭包启动时冻结**：父任务启动时把全部传递引用的子工作流定义（含版本）与
  工作组配置快照冻结进父任务；运行期编辑/删除被引用资源不影响在跑任务。同一父任务内
  多次调用（fan-out 分片、loop 轮次）共用同一份冻结定义。
- **D10 — 对外 wire 兼容**：三个既有启动端点（`POST /api/tasks`、`POST /api/agents/:id/tasks`、
  `POST /api/workgroups/:id/tasks`）与定时任务 wire 保持不变，内部改走统一执行器；
  子任务发起是服务层内部行为，**不新增**公网「通用启动」端点。
- **D11 — ACL 沿既有闭包授权**：保存工作流时只校验**新增**引用（含新增的子工作流/工作组
  引用），启动时校验工作流本身可用，引用闭包隐式授权（与 RFC-099/231 一致）。子任务
  owner = 父任务 owner，协作者继承父任务成员；工作组子任务的人类成员回答权按既有
  工作组任务规则建立。归属信息照旧不进 agent prompt。
- **D12 — 失败/取消/重试语义**：子任务 `failed` → 调用节点 `failed`（携带子任务错误摘要与
  failure_code）；用户直接取消子任务 → 调用节点 `failed`（`child-canceled`，父任务按
  既有失败语义收场）；取消父任务 → 级联取消全部活跃子任务；重试调用节点 → 按现行
  RFC-130 重试语义「作废（取消）旧子任务 + 丢弃旧 iso + 从父 canonical 当前状态重新
  派生 + 全新发起」，旧子任务保留为历史行（`pre_snapshot` 回滚在 RFC-130 后已不存在，
  不予恢复）。
- **D13 — 预算独立（设计门勘误增补）**：子任务限额（`maxDurationMs` / `maxTotalTokens`）
  由调用节点配置，未配置用系统默认；父任务 token 预算不含子任务用量（v1 文档化，任务树
  聚合视图为后续项）；调用节点不再叠加第二个计时器。**父任务 `maxDurationMs` 的时长
  判定扣除「子任务停人工门（awaiting_*）」的等待时间**（design §4.5：调用行落账
  `humanWaitMs`，limits 判定扣除 + awaiting 期击杀缓冲）——否则 D6「父保持 running」
  会让人工门等待烧穿父时长限额、级联砍掉停在完成门的子任务，与 RFC-207 停表语义冲突。
- **D14 — 统一范围为任务级三形态**：`runSystemAgent` 系统代理、MCP playground、意图会话
  等非任务执行不进入执行器抽象。
- **D15 — 不做 agent 调用节点**：工作流内使用 Agent 的方式仍是 `agent-single` 节点；
  执行器的 agent 适配器只服务 HTTP 与定时两个既有入口。
- **D16 — 版本与兼容**：新增两种 node kind 属于定义格式扩展，`$schema_version` 按
  design.md 的版本化结论处理（含 YAML 导入导出与旧 daemon 行为）；既有工作流零行为漂移，
  未使用新节点的定义 byte-compat。

## 4. 用户故事

### 4.1 沉淀可复用的审计子流程

作为工作流作者，我把「审计 + 修复」沉淀为独立工作流 W-audit。在主工作流里我拖入一个
`call-workflow` 节点选择 W-audit，把上游 git wrapper 的 `git_diff` 端口接到它的
`diff` 输入。运行时该节点发起一个子任务：在派生自父工作区当前状态的隔离 worktree 里
跑完 W-audit（含其内部 fan-out / loop），完成后修复的代码合并回父工作区，
W-audit 的 output 绑定值回填为节点输出端口，下游继续。

### 4.2 每分片一个子流程（v1 等价形态）

作为工作流作者，我需要"按分片跑子流程"。v1 写法：调用一个**自身包含 fanout** 的
子工作流（fanout 在子定义内部展开，分片仍在单一子任务内并行）；把 `call-workflow`
直接放进父级 `wrapper-fanout`（每分片一个独立子任务）是登记的后续项（D7 偏差注记）。
`wrapper-loop` 内的调用节点则完整支持：每轮一个独立子任务。

### 4.3 DAG 中段交给工作组协作

作为工作流作者，我在设计评审环节放一个 `call-workgroup` 节点选择「评审组」，把上游
产出接进目标模板。运行时发起工作组子任务，组内 leader 派单 / 成员协作 / 人类成员按
既有工作组体验参与；组任务过完成门后，其 `result`（完成结论文本）回填为节点输出，
下游拿到评审结论继续。

### 4.4 子任务的人工环节在子任务里处理

子任务停在 `awaiting_human`（如工作组完成门）时，父任务保持 running，调用节点显示
「等待子任务（awaiting_human）」并可点击跳转；我在子任务页面完成确认后，父工作流
自动继续。任务列表里该子任务按筛选可见，不淹没顶层视图。

### 4.5 平台既有入口无感收编

作为使用者，我用原有的任务向导 / Agent 启动 / 工作组启动 / 定时任务照常发起执行，
行为与 wire 完全不变；平台内部这四条路径已经走同一个执行器。

## 5. 验收标准

1. 三个既有启动端点与定时启动内部走统一执行器后，既有请求/响应 wire、副作用与
   全部既有测试（含 e2e）零回归。
2. `ExecutionRef{kind: workflow|agent|workgroup, id}` 的发起/结果/等待/取消四件套有
   单元与集成覆盖；引擎分流点收敛为执行器注册表单点。
3. 画布可创建/配置/保存/导入导出两种调用节点；静态校验覆盖：引用存在性与可见性
   （保存时仅新增引用）、端口映射完整性、闭包环检测、upload 类输入的支持矩阵。
4. `call-workflow` 端到端：子任务在派生 worktree 运行 → 完成合并回父 → 输出端口回填 →
   下游可消费；含 fan-out 内每分片一个子任务、loop 内每轮一个子任务两种叠加形态。
5. `call-workgroup` 端到端：工作组子任务全流程（派单/协作/完成门）→ `result` 投影回填；
   独立启动的工作组任务同样能通过统一结果投影读到 `result`。
6. 生命周期矩阵全绿：子失败→节点失败；子被直接取消→节点 `child-canceled`；父取消→
   级联取消子；重试调用节点→回滚 + 作废旧子 + 新子任务；daemon 重启→父子各自恢复，
   父调用节点凭 `child_task_id` 重挂等待而非重复发起；孤儿回收器不误伤等待中的调用节点。
7. 深度上限与全局活跃子任务限额生效且 fail-fast，错误信息可定位到超限的调用链。
8. 任务列表默认只显顶层；「含子任务」筛选、父行展开、父详情节点直链子任务可用；
   子任务行有父任务标识。
9. 工作区语义：子任务看得到父任务未提交变更；合并回父的冲突走既有 merge conflict
   人工路径；scratch 父任务的继承语义按 design.md 落定并有测试。
10. `bun run typecheck && lint && test && format:check` 全绿 + 单二进制 build smoke +
    Playwright e2e；设计门与实现门（Codex，故障时独立子代理替代）各过一轮并修完 findings。

## 6. 非目标

- 不合并 DAG 前沿与回合制两种推进引擎；不重写 scheduler。
- 不做「父任务内嵌展开」式子工作流；不做跨任务状态机冒泡（D6 的展示性指示除外）。
- 不做调用节点的「独立工作区」选项（继承派生+合回是 v1 唯一语义）。
- 不做工作组的组级 outputs 端口声明（最小 `result` 投影之外的结构化输出留给后续 RFC）。
- 不做 agent 调用节点（`agent-single` 已覆盖）；不做「工作组引用工作流/工作组」新形态
  （dynamic_workflow 既有能力不变）。
- 不新增公网「通用启动」HTTP 端点；不改变三个既有启动端点的 wire。
- 不做任务树预算聚合、跨任务 token 记账（D13 记为后续项）。
- 不做跨迭代反馈端口、不改变 fan-out fail-all-after-join 失败语义。
- `runSystemAgent` / MCP playground / 意图会话不纳入执行器。
- RFC-230 活性证据链已在 main（`runLiveness.ts`）；本 RFC 只扩展其证据域
  （child-task 委派），不另造平行机制。

## 7. 开放问题（设计门一轮后全部收口，结论存档）

1. ~~工作组 `result` 载体~~ → **显式结果锚**：新列 `workgroup_task_state.result_message_id`
   由 engine done 分支落锚（lw=leader done decision 消息、fc=收尾汇总消息），历史任务
   回退 `gate_summary`；「按 author/kind 过滤」被设计门证伪（fc 汇总与 zero-delta 告警
   同 kind 同 author）。见 design §6.4。
2. ~~scratch 继承机制~~ → scratch 任务是真 git repo（`initScratchRepo`），RFC-130 iso
   全套照常，与 repo 父任务同一条派生+合回路径。见 design §6.2 D。
3. ~~`$schema_version`~~ → 不 bump（RFC-060 先例 + 审计 WFM-03；闭集 kind 枚举把关，
   旧 daemon 422 fail-closed）。见 design §5.1。
4. ~~wrapper-git 交互~~ → call 行 iso 从 wrapper iso 分叉、合回 wrapper iso，diff 窗口
   天然含子任务改动；`rfc242-fanout-call.test.ts` 锁定。见 design §6.2 叠加形态。
