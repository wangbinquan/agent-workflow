# RFC-304 · 任务分解

> 产品视角见 [proposal.md](./proposal.md)，技术设计见 [design.md](./design.md)。
> 用户拍板：**一份 RFC 写完，plan.md 里拆多个 PR**（proposal A7）；**第一个 PR 交框架地基**（A8）。

## 0. 拆分原则

CLAUDE.md §RFC workflow 第 5 条允许「确需拆分时在 plan.md 说明并分别立 PR」。本 RFC 必须拆，
理由是单 PR 既无法评审也无法回滚，且中途任一处返工会阻塞全部。拆分沿三条线：

1. **地基先于能力**，但地基本身也要拆——见下方"第三轮重组"。
2. **一条能力一个 PR**：每个能力 PR 交付后都**端到端可验收**，不留"跑不起来的半成品"。
3. **首值优先于完备**：先让真实 MR 上出现第一条行级评论，再补完整能力。

每个 PR 独立满足 `bun run gate:local` 全绿 + 自带测试（CLAUDE.md §Test-with-every-change）。

### 0.1 第三轮设计门后的重组（重要）

第三轮以"这份 plan 拿去做会不会做不动"为视角审了一遍，报出三条结构性问题，本节据此重排：

- **PR-1 曾有 21 个任务**——三轮修复不断往地基加东西，它同时含五张表、两个状态机、artifact
  store、阶段引擎、脚本执行重构、新 execution kind、抢占、lease、closing、事件归属、发布意图。
  这不构成一个能独立定位回归的评审单元。**拆成 PR-1a / 1b / 1c**，并把三个错放的任务移走
  （`code_trigger_deliveries` 建表 → PR-11；artifact store 与 waitKind → PR-7 前置；
  事件归属 → PR-6）。
- **"第一条真实行级评论"原本要穿过 47 个任务**（按 AC-24 的自助启用路径是 50 个、5 个 PR），
  PR-4 因此并不是它自称的"第一个用户价值点"。**拆出 PR-4a 首值纵切**：两家 provider 都在、
  一个固定内置 binding、最小启用开关、单个 review AI，走通 webhook → 发布 → 落账；拆块、fork、
  三集合对账、采纳信号等推到 PR-4b。
- **`code-round` execution kind 是整条链的首个阻塞点**，却被风险表写成"新增筛选枚举"。
  **前置一个 PR-0 可行性 PR**：只交合同与验证桩，跑通真实 `code-round` 启动 → 取消 → daemon
  重启恢复，作为 go/no-go；通过后 StageEngine 才允许依赖它。

## 1. 任务清单

### `code-round` 可行性（PR-0）—— go / no-go 前置

它是整条链的首个阻塞点：要给 `StartExecutionRequest` 增第四种 kind，而 `task-execution` 本身正
等着 RFC-294 W2 重构（design D5）。**先验证再依赖**，不要等 StageEngine 写完才发现接不进去。

| #    | 任务                                                                                                                   | 依赖 | 状态                 |
| ---- | ---------------------------------------------------------------------------------------------------------------------- | ---- | -------------------- |
| T0a  | 与 `task-execution` owner 对齐 participant 注册点、task/nodeRun 归属、取消与恢复事件、详情投影、W2 收编接口            | —    | ✅ 2026-08-15        |
| T0a′ | `code-round` **NodeKind** 接入：12 处穷尽点 + 「不可授权」四机制 + 单一事实源 `SYNTHESIZED_ONLY_NODE_KINDS`            | T0a  | ✅ 2026-08-15        |
| T0b  | `code-round` **execution kind** 合同 + 验证桩（桩内只跑一个空阶段），跑通**启动 → 取消 → daemon 重启恢复**三条真实路径 | T0a′ | ✅ 2026-08-15 **GO** |
| T0c  | 把 `code-round` 形态登记进 RFC-294 的 W2 输入清单                                                                      | T0a′ | ✅ 2026-08-15        |

> **go / no-go**：T0b 三条路径全绿才进 PR-1a。不通过则回到 design D5 重选退路（届时 RFC 需改）。
>
> **判定结果（2026-08-15）：GO**。三条路径全绿（`tests/rfc304-code-round-execution-kind.test.ts`，
> 8 pass / 0 fail），实证见测试运行日志：启动路径跑到 `task done`、恢复路径
> `auto-resume ... resumed=1 skipped=0`。D5 的地基假设成立，可进 PR-1a。
>
> 落地过程另抓到**两个静默失败口**（都已修 + 各自钉测试，详见 design §D5 实现约束）：
> ①outcome 的兜底 `else` 不判 kind ⇒ 新 kind 落进 workgroup 臂，`done` + 空产出 + 一条指向
> 该任务根本没有的工作组配置的误导警告；②`OutcomeTaskRow` 忘记 select 判别列**不是类型错误
> 而是错误分类**（`taskExecutionKind` 判别字段全可选）。另修一处：首版 `StartCodeRoundInput`
> 手抄 space 字段，漏 `scratch`/`repoGroupId`/`sourceTaskId` 且带上**已退役**的 `repoPath`——
> 改走单一装配点 `applySpaceFields`，正是该函数注释所防的那类事故。

**T0a 对齐结论（2026-08-15，逐条按源码核对）**：四个接入点各有现成先例，**无一处需要改动既有语义**——

| 接入点                           | 障碍                    | 先例                                                                                        | 结论                                                |
| -------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `tasks.workflowId` notNull       | 合成轮次没有用户工作流  | `AGENT_HOST_WORKFLOW_ID`（`services/agentLaunch.ts`）                                       | sentinel 常量 + 懒 seed 锚点行                      |
| `tasks.workflowSnapshot` notNull | 同上                    | `callLaunch ?? workgroupLaunch ?? agentLaunch ?? workflow.definition`（`services/task.ts`） | `??` 链再加一条                                     |
| 节点执行                         | 需要非 agent 的执行分支 | `script` / `code-host-call` 在 `runOneNode` 各有分支                                        | 同形加一支，位置在 agent fall-through 前            |
| 启动面                           | 需要第四种 kind         | 既有三种 kind 的 dispatch                                                                   | `StartExecutionRequest` 加变体 + `executor.ts` 分发 |

T0c 已把「W2 立号时按四种收编」写进 RFC-294 `plan.md §6`，作为「先加后收编」的交换条件（用户 §6ter-H3 拍板）。

**T0b 实现清单（T0a 核实后确定，逐条对应源码位置）**：

| 步  | 改动                                                                                           | 位置                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | `tasks` 加 `code_round_id`（nullable text，软引用——同 RFC-303 既例，删业务行不得级联掉执行行） | `db/schema.ts` → `bun run db:generate` 出 `0158_rfc304_code_round.sql`                                 |
| 2   | `taskExecutionKind()` 增第四支并**判在最前**                                                   | `shared/schemas/task.ts:668`                                                                           |
| 3   | 38 处调用点由 TS 强制穷尽（11 个文件，前后端各半）                                             | 见 `grep -rn taskExecutionKind`                                                                        |
| 4   | `ExecutionKind` / `StartExecutionRequest` 各加一项                                             | `services/execution/types.ts:23,58`                                                                    |
| 5   | `buildExecutionOutcome` 增 code-round 分支（否则产出恒空——见 design §D5 实现约束）             | `services/execution/outcome.ts:150`                                                                    |
| 6   | sentinel workflow 常量 + 懒 seed + `startCodeRoundTask`                                        | 仿 `services/agentLaunch.ts`                                                                           |
| 7   | `runOneNode` 增 `code-round` 分支（桩内只跑一个空阶段）                                        | `services/scheduler.ts`，位置在 agent fall-through 之前                                                |
| 8   | 三条真实路径测试：启动 / 取消 / daemon 重启恢复                                                | 恢复路径已确认**不按 kind 过滤**（`services/autoResume.ts:79` 只看 status + errorSummary），故自动纳入 |

**T0a′ 交付内容**：`code-round` 作为 NodeKind 已全量接入，12 处穷尽点（编译器强制 9 处 + 非编译器强制 3 处：
`docs/workflow-yaml.md` 章节与计数、RFC-199 strict-target ratchet、执行能力目录）全部填齐。「用户不可授权」由四机制保证，
各自单测锁定：palette 停在不参与渲染的 `internal` section、validator 拒收（`code-round-not-authorable`，**唯一挡得住
YAML 导入 / 手工 PUT 的一道**）、INTENT.md 显式声明 withheld、四者共读 `SYNTHESIZED_ONLY_NODE_KINDS` 单一事实源。
画布投影与 accent 同期补齐（避免重蹈 RFC-253 「卡片有壳无数据」坑）。

### 地基一：工作项 + 阶段引擎 + 钩子（PR-1a）

| #   | 任务                                                                                                                                                                                                                     | 依赖  | 状态                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ------------------------------- |
| T1  | 新建 `modules/code-capability/` 骨架：七层目录 + public 合同占位；边界规则接入既有 import 守卫                                                                                                                           | —     | ✅ 2026-08-15（见下方说明）     |
| T2  | `code_work_items` / `code_work_rounds` / `code_round_stages` / **`code_ai_attempts`** 表与迁移；工作项身份键用 `(codeHostEndpointId, stableProjectId, …)`。（`code_trigger_deliveries` 移到 T61，它到 PR-11 才有消费者） | T1    | ✅ 2026-08-15（migration 0159） |
| T3  | 工作项状态机（domain 纯函数）+ CAS 写入（照搬 `lifecycle.ts` 姿势）+ 转移表穷举测试                                                                                                                                      | T2    | ✅ 2026-08-15                   |
| T4  | `StageContract` / `StageDef` **判别联合**（`program` / `script` / `ai` / **`invoke`**），每种 kind 只能携带自己那组字段；保存期校验 `invoke` 的区间存在性、递归环、输入输出闭包、取消传播                                | T1    | ✅ 2026-08-15                   |
| T5  | `StageEngine`：按序推进、落 `code_round_stages`、失败传播                                                                                                                                                                | T3,T4 | ✅ 2026-08-15                   |
| T7  | `HookRunner`：抽出不依赖 `WorkflowNode` 的脚本调用面（复用 `assembleScriptEnv` + 受管子进程）；pre/post 挂载；注入数据白名单合并；blocking 语义                                                                          | T5    | ✅ 2026-08-15                   |
| T8  | 阶段契约版本化：钩子声明版本，升版后旧钩子显式报迁移                                                                                                                                                                     | T7    | ✅ 2026-08-15                   |
| T12 | 用一条最简内置流程（`prepare-worktree → 一个 program 阶段 → ledger`）跑通 port 级最简链路。**注意它只为 PR-1a 背书**——真实 task 与 AI 重试在 PR-1b 才验证                                                                | T5,T7 | ✅ 2026-08-15                   |

**T1 说明（2026-08-15）**：目录按需生长，不预建空壳——本 PR 落了 `domain/`（工作项状态机、阶段契约）
与 `application/`（阶段引擎）两层。**`public/` 暂不建**：RFC-294 的 public 合同是给**跨模块消费者**用的，
本模块目前没有跨模块调用方，先摆五个空 entrypoint 只会是噪音；第一个消费者随 PR-1b 的 `code-round`
runner 落地，届时一并建。边界守卫**已自动接管**——`rfc294-architecture-preflight.test.ts` 遍历
`modules/` 下每个 context（本模块建出当天即在覆盖内），依赖分层门禁亦已复跑通过。

**T7 说明（2026-08-15）**：按 D4「复用机制、不复用节点」，第一步是把 `assembleScriptEnv` 与
`WorkflowNode` **解耦**——它原本从 node 上读 language / outputMode / env 三项，现改为接受纯数据，
script 节点分支在调用前自行读取。这样钩子（没有 node、没有画布位置与端口）能复用**同一套**装配与
受管子进程，而不是长出第二套脚本执行实现。既有 script 节点行为不变（`rfc253-script-execution` 20 pass）。

钩子的三种权力各自钉在边界上：注入走 envelope + **按阶段白名单**过滤（未列出的键**丢弃并上报**，
否则钩子可重定义序列依赖的任何 artifact，「program 阶段确定性」就只在没人写创意钩子时成立）；
中止需**显式声明** `blocking`（否则某组的可选 lint 钩子一红就卡死所有 MR）；副作用直接写工作树
（工作树本就是共享媒介，不设中介）。T8 的版本检查测的是它**不做**什么：过期钩子既不执行（会被喂
它读不懂的形状）也不静默跳过（某组的门会悄悄不再设防）。

**落地时改掉一处隐式契约**：注入原本靠钩子 mutate `ctx.artifacts` 生效——能工作只因 pre 钩子与
runner 共用同一个 ctx 对象，任一侧将来加个防御性拷贝就会断，且断在很久以后。改为 `pre` 显式返回
`{ inject }` 由引擎合并，并**限定只作用于本阶段**（不进序列累积产物，否则一个钩子会为其下游所有
阶段静默重定义该 artifact）；`block` 与 `inject` 同时返回时 block 优先。

### 地基二：真实 `code-round` 与 AI 确定性守卫（PR-1b）

| #    | 任务                                                                                                                                                                             | 依赖      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | --------------------------- |
| T9a  | 落地 `code-round` execution kind（合同已由 PR-0 验证）：participant、进程归属、取消与恢复                                                                                        | T0b,T1    | ✅ 2026-08-15               |
| T9   | `TaskLauncherPort` + 适配：起一轮 = 起一个 `code-round` task；新增独立任务类型并接入列表筛选                                                                                     | T3,T9a    | ✅ 2026-08-15               |
| T6   | `DeterminismGuard`：envelope 提取 → 结构/语义校验 → 同会话重试 → 换会话重跑 → 失败                                                                                               | T4,T9     | ✅ 2026-08-15               |
| T2b  | `code_ai_attempts` 状态机：唯一键 `(roundId, stage, shard, rerunSeq, attemptSeq)`，`claimed→running→validated\|failed\|interrupted`；**恢复时先收束悬挂 attempt 再分配下一序号** | T2,T6     | ✅ 2026-08-15               |
| T11  | 源码层负扫描：`kind:'program'` 阶段不得出现 agent 派发；钩子上下文键不可被作者 overlay 覆盖；**各配一条反向自检**（把实现改错、扫描必须变红）                                    | T4,T6     | ✅ 2026-08-15（见下方勘误） |
| T12b | 端到端：一条含 AI 阶段的最简流程跑通，含两级重试与 daemon 重启恢复                                                                                                               | T6,T2b,T9 | ✅ 2026-08-15               |

**T11 勘误（2026-08-15，按源码核对）**：原文第二项「`SAFE_FORWARD_ENV` 未被修改」**基于过期假设**——
该符号在当前代码库里**不存在**（`grep -rn SAFE_FORWARD_ENV packages/` 零命中）。它是 RFC-269 时代
agent 进程的环境白名单，已随 RFC-276「运行时作为普通子进程、继承 daemon 环境」退役（CLAUDE.md
§Runtime management 已记此现状）。为它写扫描等于扫一个不存在的东西，且**永远绿**——正是反向自检
要防的形态。

替换为**现行的等价护栏**：钩子的 `AW_CWI_*` 工作项上下文键不得被作者 env overlay 覆盖（它们是平台
身份而非可配置项）。该护栏有行为测试，本任务再加源码层断言（上下文键必须写在装配**之后**）。

### 地基三：并发与发布可靠性（PR-1c）—— 首个对外写能力的前置

| #    | 任务                                                                                                                                                                                                          | 依赖     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------- |
| T10  | 抢占：`superseding` 中间态 + round `epoch`；旧 task 终态后才开新轮；幂等且不产生孤儿行                                                                                                                        | T9       | ✅ 2026-08-15 |
| T10b | **发布临界区**（唯一线性化点）：轮次进入对外写动作前 CAS 标记 `publishing`+epoch；临界区内事件处理器只能登记 `pendingRevision`，不得推进 `superseding`。单纯的"调用前复检"是 TOCTOU，挡不住复检后被改的 epoch | T10      | ✅ 2026-08-15 |
| T10c | MR 级 lease 完整协议：键、持有者 roundId+fencing token、续租、**所有终态释放**、`awaiting`/`handed_off` **不持锁**、崩溃按 daemon 代际失效重认领；`queued` 期间只保留最新 `pendingRevision`（人工指令不合并） | T3       | ✅ 2026-08-15 |
| T10d | `closing` 状态：闭环事件先落 `closing`（epoch+1、发取消、等补偿与 lease 释放），旧 task 终态后才做终局比对并写 `closed`；所有 round 回调以预期状态 CAS，不得覆盖 `closing`/`closed`                           | T10      | ✅ 2026-08-15 |
| T10f | **发布意图**（跨阶段可恢复）：发布前持久化 `batchId`+指纹清单+epoch；远端成功后先原子写回 external id 再允许推进/取消；重启按批次核对远端                                                                     | T2       | ✅ 2026-08-15 |
| T12c | 并发用例组：抢占无孤儿、epoch 过期放弃产出、临界区内事件顺延、lease 跨工作项串行、崩溃后按批次恢复                                                                                                            | T10–T10f | ✅ 2026-08-15 |

### 两层配置与模板（PR-2）

**T19 的 i18n 部分同样待 RFC-305 落定**（2026-08-15）：三个 review 动作的中英 label / hint /
两条 unsupported 理由已写好，但 `i18n/{zh-CN,en-US}.ts` 已被 RFC-305 改动且其新增的
`permissionCatalog.ts` 依赖对方尚未提交的 `ROLE_CAPABILITY_CATALOG`——**部分拉取会向 backend
传染**，故这部分无法在隔离 worktree 独立验证。补丁已存
`scratchpad/rfc304-t19-i18n.patch`（283 行，纯新增 key），待对方提交后打回并单独过门禁。
期间 UI 有 `defaultValue: field.name` 兜底：显示英文字段名而非裸 key，可接受。

**T13 的跨 RFC 依赖（2026-08-15 实测发现，需在 RFC-305 落定后接续）**：把两类模板注册进
`ACL_RESOURCE_TYPES` 后，编译器指出的落点里有一处是硬依赖——`routes/resourceAcl.ts` 的
`ACL_PERMISSION_PREFIX` **类型故意收窄**（其注释写明：每个资源类型的 `${resource}:update`
必须是真实存在的权限点，靠 TypeScript 挡住不存在的组合）。故两类新资源需要新增权限点
`capability-frameworks:*` / `capability-bindings:*`。

**而 shared `Permission` 目录正由并发的 RFC-305 重构**（建穷尽的名称/分组/风险/delegation/
token/constraint 目录，新权限须补齐元数据）。此刻新增权限点会基于一个正在变的元数据形状、
几乎必然返工，且与对方改动在同一批文件上交错。故 **T13 的 ACL 全面接入推迟到 RFC-305 的
权限目录稳定之后**，届时一并补：`ACL_RESOURCE_TYPES` 两项、`ACL_TABLES` 两项、
`OWNER_NAME_UNIQUE_TYPES` 两项（两表均有 owner+name 唯一索引）、`resourceGrants.resourceType`
enum、`bundle/provider.ts` 的 `TYPE_RANK`（framework 排在 binding 之前——binding 引用
framework）、`cli/package.ts` 与 `bundle/{apply,lower}.ts`、`intent/applyChangeset.ts`。
探路时已确认这些**多为映射表补项而非深度实现**，接入成本不高；卡点纯粹在权限目录。

**已完成且不受该依赖影响的部分**：三张表与 migration 0161、两层的领域约束（framework-only
字段拒收、`canWriteFramework` 双条件）、参数继承与来源追溯、readiness 三态派生。

| #    | 任务                                                                                                                                                                                                                                                                                                                                                                                             | 依赖    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| T13  | `capability_frameworks` / `capability_bindings` 表；两类资源接入既有资源框架（owner/visibility/grants/复制）                                                                                                                                                                                                                                                                                     | T1      |
| T14  | 部门层写权额外要求 `scripts:author`；小组层不得写入脚本与钩子字段（服务端遮蔽 + 拒绝）                                                                                                                                                                                                                                                                                                           | T13     |
| T15  | 参数继承：框架声明 `paramSchema` 与默认值，绑定覆盖；解析顺序与来源可追溯                                                                                                                                                                                                                                                                                                                        | T13     |
| T16  | `repo_capability_config`（仓库 × 能力矩阵）+ 仓库 ACL 判据接入                                                                                                                                                                                                                                                                                                                                   | T13     |
| T16b | `readiness` 三态派生（`disabled`/`misconfigured`/`ready`）+ 「启用」编排动作（选默认 binding → 建/校验触发器 → 校验 code-host 与 agent 可见性）+ 逐条缺失项的一键修复入口                                                                                                                                                                                                                        | T16,T18 |
| T16c | **`readiness` 失效重算**：优先实时计算；若缓存则存 `dependencyRevision`+`lastValidatedAt` 并订阅 binding/agent/framework/trigger/code-host/wake 的变更事件批量失效。判据**按能力声明**——`ci-fix` 必须含唤醒源可达性（锁 AC-14d）。不做则一个共享 binding 被删会让 200 个格子继续显示 `ready`                                                                                                     | T16b    |
| T17a | **扩 RFC-271 的闭合集合**（设计门 P1：它今天不是通用包格式）：`ResourcePackageTypeSchema` 只接受六种（`packages/shared/src/schemas/resourcePackage.ts:18`）、`BundleOp` 是固定十二分支 union（`packages/shared/src/bundle/op.ts:87`）、`bundle.ts:42` 同样只识别六类。需逐项扩：type enum、bundle payload、BundleOp 变体、引用闭包解析、serialize/parse、preview/commit apply provider、importer | T13     |
| T17b | 两类资源接入配置包：闭包、`requirements`、`secrets[]` 脱敏索引 + 往返测试                                                                                                                                                                                                                                                                                                                        | T17a    |
| T18  | 内置两套：标准 GitLab/GitHub 框架（不接自建系统）+ 五套默认 agent 绑定，`built-in` + `public`                                                                                                                                                                                                                                                                                                    | T15     |

### 代码平台发布能力（PR-3）

| #    | 任务                                                                                                                                                                                                                                                                                                                    | 依赖    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------- |
| T19  | 扩 `CODE_HOST_ACTIONS`：GitLab `draft_notes` 创建 / `bulk_publish`；GitHub `pulls/reviews`（带 `comments[]`）。注册表是 `satisfies Record<CodeHostAction, ...>`，**两家都必须给 binding**——GitLab 独有的 draft_notes 在 GitHub 侧显式标 `unsupported` + reasonKey（`singleRequestReview`），反之亦然，否则 typecheck 红 | —       | ✅ 2026-08-15 |
| T20  | position 组装（domain 纯函数）：两家各自形态，新增/删除/上下文行                                                                                                                                                                                                                                                        | —       | ✅ 2026-08-15 |
| T21  | 批量发布器：草稿逐条 → 部分失败清理已建草稿 → 整轮失败；GitHub 单请求语义                                                                                                                                                                                                                                               | T19,T20 | ✅ 2026-08-15 |
| T22  | **provider-specific 的 `settle-stale` 动作**：GitLab 批量 `thread.resolve`；GitHub 无 resolve 能力（`actions.ts:315` unsupported）故走"追加一条已不再出现的回复"。**注意不是旧的 `cleanup-previous` 语义**                                                                                                              | T19     | ✅ 2026-08-15 |
| T22b | **发布意图的 code-host 侧**：按 `batchId` 核对远端已存在的草稿/review/notes，供重启恢复补齐 external id 而不重发                                                                                                                                                                                                        | T19     | ✅ 2026-08-15 |

### 首值纵切：真实 MR 上的第一条行级评论（PR-4a）

**这是第一个用户可见价值点**，也是整份 plan 里最该早交的东西。范围刻意收窄：两家 provider 都在、
**一个固定的内置 review binding**、最小启用开关、**单个 review AI**（不拆块）。它不宣称完成
`mr-review` 的全部 AC——那是 PR-4b。

| #     | 任务                                                                                                                                                        | 依赖                | 状态          |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------- |
| T4a1  | 最小 `mr-review` 契约：`resolve-target → prepare-worktree → fetch-diff → review(单个 AI) → validate-findings → gate → resolve-positions → publish → ledger` | T4,T6               | 各段已建并测  |
| T4a1z | 上述各段的**装配**（按序跑通一轮 `mr-review`）                                                                                                              | T4a1                | ✅ 2026-08-15 |
| T4a2  | 最小启用开关（矩阵行 + 触发器创建），不含 readiness 三态与一键修复                                                                                          | T16                 | ✅ 单元格读写 |
| T4a3  | 端到端：真实 webhook → 真实 code-host → **MR 上出现行级评论**（两家各一条）                                                                                 | T4a1z,T4a2,T21,T25b |               |

**装配现状（T4a1z 已接线，2026-08-15）**：`composition/mrReviewEnvironment.ts` 把 scheduler
已持有的东西（冻结的 trigger context、scope root、repo）转成 runner 要的两张 name→实现表，
`services/scheduler.ts` 的 code-round 分支据此构造 runner。带 trigger context 的一轮现在会
**真的按序跑各程序阶段**——`rfc304-code-round-end-to-end.test.ts` 锁死这条：失败信息不再是
「no registered implementation」，而是 `stage 'prepare-worktree' failed: … refs/merge-requests/412/head …`
（scratch 任务没有 clone 可取，是正确结局），证明 `resolve-target` 已读到 webhook 字段。

**唯一未闭合的缝：`makeCaller`**。让 `review` 阶段够到模型，需要把契约里的 `agentSlot` 解析成
本仓的组层 agent 绑定（§5），该接线尚未做。故**刻意不提供可用的默认实现**：缺失时 `review`
阶段按名拒绝（「no agent is bound to the 'reviewer' slot」），而不是拿一个猜来的 agent 去跑
——后者会发出一份由「碰巧排在第一个」的 agent 写的评审，且输出里没有任何东西表明绑定是编造的。

各段落位（2026-08-15）：`resolve-target` = `domain/resolveTarget.ts`；`prepare-worktree` =
`domain/headFetchPlan.ts` + `application/prepareWorktree.ts` + `infrastructure/gitAdapter.ts`；
`fetch-diff` = `domain/mrDiffNormalize.ts` + `application/fetchDiff.ts`；`review` =
`domain/reviewPrompt.ts` + `domain/reviewEnvelope.ts` + `application/reviewStage.ts`（AI 派发以
`makeCaller` 注入，不碰 scheduler，受 T11 负扫描约束）；`resolve-positions` =
`domain/anchorLine.ts` + 既有 `domain/reviewPosition.ts`；`publish` =
`application/publishReview.ts`。

> **fork 支持提前落在 PR-4a**（原列在 PR-4b 的 T24b）：只从 target remote 取
> `refs/merge-requests/{iid}/head` / `refs/pull/{n}/head`——两家都把 MR head 发布成目标仓内的
> ref，对 fork 同样解析，比「冻结 source clone URL 再去 fork 仓 fetch」少一套机制且不受 fork
> 私有/已删/token 够不到的影响。该方案即 `design.md §6.1` 的定稿对策（初稿方案与不采用理由存档在同节的折叠块里，含改回配方），真机验证在
> `tests/rfc304-git-adapter.test.ts`（真 git 建一个只存在于 MR ref 上的提交）。T24b 因此在
> PR-4b 只剩「fork PR 的 CI 事件经 head SHA→开放 PR 映射唤醒」一半。

> ### ⚠ T4a2 只做了一半，且另一半有个待你拍板的岔路（2026-08-15）
>
> T4a2 原文是「矩阵行 **+ 触发器创建**」。**矩阵行**已完工（`sqliteCapabilityMatrix.ts`，
> `wantsCapability` 要 `ready` 而非 `enabled`）；**触发器创建**没做，于是**真实 webhook 投递
> 目前不会启动任何 code-round**——`wakeCapabilitiesForDelivery` 写好并测过，但 `src` 里没有
> 任何调用方（`rg` 可复核）。这是本 RFC 第二次栽在同一个形态上：机制只是**缺席**、从不
> **出错**，测试套件对它完全无感。
>
> 岔路在于**归属（RFC-301）**：`taskLaunchAdmissionIssue` 规定 webhook 出身的启动必须同时带
> 非空 `webhookTriggerId` + `webhookFireId`（`taskLaunchOrigin.ts:78`），而「能力被唤醒」既
> 没有 trigger 行也没有 fire 行。三条路，代价各不相同：
>
> 1. **走触发器表（plan 原意，改动最大）**：启用单元格时写一行 `webhook_triggers`，其
>    launch payload 是 code-round，之后**完全复用**既有 dispatch → fire → 归属 → stream key
>    → supersede。代价：`RenderedLaunch` 要加第 4 种 kind（`webhookDispatch.ts:347`），而
>    `launchKind` 是**持久化列**，牵动 shared schema、trigger 校验、多半还有前端触发器表单。
> 2. **给 RFC-301 加一种 provenance（`capability`）**：改动小，但动的是别的 RFC 的封闭模型与
>    其守卫，且要重新定义这类任务的归属语义。
> 3. **为唤醒补记一行真 fire**：能力唤醒确实是「投递导致了工作」，记一笔说得通；但没有
>    trigger 行可挂，等于要造一个合成 trigger id——那正是「悬挂引用」，本 RFC 刚为它写了四条
>    互不相同的报错文案去避免。
>
> **不自选**：这条属「涉及设计方向由你定」。当前代码是诚实的——`wakeCapabilitiesForDelivery`
> 要求调用方给出两个 id，缺 fire id 时会**具名失败并报出来**（已有测试锁定），而不是伪造一个。
>
> T4a3（真机：真实 MR 上出现行级评论）在此之上，另需活凭据与真 MR。

> 仍推迟到 PR-4b 的：拆块并行与全局关联审、三集合对账与 finding 生命周期、采纳信号、
> 配置包扩展（T17a/b）。它们都不影响"第一条评论能不能出来"。

### MR 检视完整能力（PR-4b）

| #    | 任务                                                                                                                                                                                                                                                      | 依赖         |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------- |
| T23  | `split-diff`：按目录层级聚合 + 体量上限，确定性                                                                                                                                                                                                           | T4           | ✅ 2026-08-16 |
| T24  | `review-shard`（并行 AI 段，**每片一棵独立一次性工作树、禁 merge-back**）+ `review-global`；aiSchema 定义                                                                                                                                                 | T6,T23       | ✅ 2026-08-16 |
| T24b | **fork MR/PR 支持**：归一化并冻结 source project clone URL + head SHA，按 source remote 精确 fetch；fork PR 的 CI 事件经 head SHA→开放 PR 映射唤醒（唯一命中才唤醒）                                                                                      | T23          | ✅ 2026-08-16 |
| T25  | `validate-findings`：**只做结构与语义闭集校验**（schema、必填、severity 在闭集）。**行号是否在 diff 内不在这里判**——那属于锚定，见 T25b                                                                                                                   | T6,T23       | ✅ 2026-08-16 |
| T25b | `resolve-positions` 的锚定判定：行不在 hunk / 文件不在改动集 ⇒ **零 AI 重试**、标 `degraded`、阶段成功（锁 AC-3）；锚定基准是 `fetch-diff` 的产物而非当前工作树（锁 AC-4）                                                                                | T20,T23      | ✅ 2026-08-15 |
| T26  | `gate`：确定性排序 → 阈值过滤 → 上限截断 + 未展开计数                                                                                                                                                                                                     | T25          | ✅ 2026-08-15 |
| T27  | `code_findings` 台账：唯一键 `(codeHostEndpointId, stableProjectId, anchorKind, anchorId, fingerprint, generation)`；`fingerprint` 含 `symbolOrHunkDigest`；**`active/disappeared/reappeared` 生命周期**；`createdAt/lastSeenAt/closedAt` 与仓库+时间索引 | T2           | ✅ 2026-08-15 |
| T27b | `reconcile` 三集合对账：台账侧**只取 active 行**；重现的问题以**新 generation** 发布                                                                                                                                                                      | T27          | ✅ 2026-08-15 |
| T28  | `settle-stale`：**发布成功后**执行，且**只在状态边沿**动作一次（`active→disappeared`）——否则长命 MR 上 GitHub 会重复追加 78 条同义回复；逐项落幂等状态                                                                                                    | T22,T27b,T29 | ✅ 2026-08-15 |
| T29  | `publish`：草稿攒齐一次性发布 + 锚不上的并入总览评论                                                                                                                                                                                                      | T21,T26      | ✅ 2026-08-16 |
| T30  | 采纳信号：`resolved`（回读线程）与 `code_changed`（下轮比对锚定行）分列落账                                                                                                                                                                               | T27          | ✅ 2026-08-16 |
| T31  | `mr-review` 阶段契约 v1 装配 + webhook 触发路由（含"bot 自动提的 MR 可配置不检视"）                                                                                                                                                                       | T23–T30,T16  | ✅ 2026-08-16 |

> **T31b 后端查询合同（2026-08-16）**：`public/queries` + `public/commands`（RFC-294 的
> exact 入口）、`CodeMatrixQuery` / `CodeWorkItemProjectionQuery` / `EnableCommand` 实现，
> 三条 HTTP 路由（`repos:read` / `repos:update`——权限是闭合集合，为最小面新增
> `code:*` 会波及角色预设与 i18n，等 `/code` 长出自己的资源再说）。
>
> - **readiness 从「声称」变成「观测」**：`deriveReadiness` PR-2 就写好了，但**没有任何
>   东西生产它的 facts**——所有调用方都是测试手喂 `ready`。于是一个仓库可以在没有绑定、
>   没有触发器、没有 agent 的情况下显示 ready，正是 readiness 要暴露的那个状态。新增
>   `gatherReadinessFacts` 逐项去库里问，且**用轮次将来会问的同一个问题问**——「选了绑定」
>   与「这个仓看得见该 slot 的 agent」不是一回事，前者会 ready 然后死在 MR 上、当着作者的面。
> - **修好一处死锁**：readiness 要求 `hasTrigger`，而 `enableCapability` **只给已经 ready
>   的 cell 装触发器**——真实仓库永远到不了 ready。触发器是平台自己装的、不是用户要提供的
>   前置，故「只差触发器」的 cell 继续走到装配、再按 `hasTrigger: true` 重新推导。
> - **再修一处「要按两次保存」**：`invisibleSlots` 原本经 `resolveReviewerAgent` 读**已存**
>   的 cell，而首次保存时 cell 还不存在 → 每个新仓第一次保存都报 `agent-not-visible`、
>   第二次才 ready。改为按**请求里的** bindingId 解析（`resolveAgentForBinding`）。
>   回归测试**只保存一次**——保存两次的版本在死锁只修一半时同样会绿，而「你得按两次」正是
>   用户会报的那个症状。
> - **顺带修一个 PR-4a 的真 bug**：`resolveReviewerAgent` 只按 `repoId` 过滤 + `limit(1)`，
>   同时跑 `mr-review` 与 `mr-monitor` 的仓会**拿另一个能力的 agent** 去跑本能力的阶段，
>   而四条错误信息都声称在读「'{capability}' 的 cell」。所有测试都是一仓一能力，故一直没红。
>   已加跨能力回归并变异校验。

> **T24b 后半 + T31 bot 开关（2026-08-16）**：
>
> - **fork PR 的 CI 事件定位**：fork 的流水线事件不带 MR 号（GitHub 的
>   `pull_requests[]` 为空，因为流水线跑在 fork 自己的仓里），唯一可靠的线索是 commit，
>   故反向映射 head sha → 开放 MR。**只有唯一命中才唤醒**：一个 commit 可能同时是多个开放
>   MR 的 head（共享分支、堆叠 MR），猜一个等于**以他人名义在他人的 MR 上发检视**——不响应
>   CI 事件只是功能缺失，响应错 MR 是平台擅自做了没人要求的事。查的是**目标仓**的开放 MR
>   列表（与 §6.1 从 target remote 取 head 同一个信任判断：凭据已持有、fork 可能私有或已删、
>   且不跟随第三方 webhook 载荷给的 URL）。「读不到」与「没有」分开返回——合并会让 host 故障
>   期间静默丢掉 CI 事件。
> - **bot 开的 MR 默认照审（E2）**：开关**两步才生效**——既要打开 `skipBotAuthoredMr`，
>   又要在 `botAuthors` 里点名。不从用户名猜（`*-bot`）：会把叫 `alice-bot` 的人静默排除，
>   又漏掉叫 `deploy` 的机器。默认关闭是用户拍板的产品决定，代码与测试都写明这一点，免得
>   后人「顺手」把它改成默认开。

> **T30 采纳信号（2026-08-16）**：迁移 `0165` 给 `code_findings` 加四列——
> `resolved_at` / `resolved_round_id` / `code_changed_at` / `code_changed_round_id`。
>
> **两个信号分列而不是合成一个 `adopted`**：它们回答不同问题，且恰在有价值的场景里不一致
> ——「代码改了但线程没 resolve」是作者默默修了，「resolve 了但代码没动」是作者不认同。
> 合成一个 flag 会把两者都报成「已采纳」，而这对其中一个是假的。
>
> - `code_changed` **不解读为「已修复」**：检视分不清修复、重命名、格式化、隔壁两行的无关
>   改动。它支持的是那个诚实的问题——「我们指的地方有没有动过」。首次出现（台账无锚）与
>   本轮失锚都不算漂移，否则每条新发现一发布就被标成已采纳。
> - `resolved` 只有 GitLab 有：GitHub REST 面不暴露 review thread 的 resolved 状态（同一个
>   让 `thread.resolve` 在 GitHub 标 unsupported 的缺口）。故返回 `supported: false` 而不是
>   空集——「看不到」与「没人 resolve」不能长一样，否则 GitHub 上的采纳率会永远读作 0。
>   GitLab 侧按 note 逐条看 `resolved`，只看首条会漏掉「先回复再 resolve」的绝大多数线程。
> - **首次观测写入即冻结**（SQL 层 `IS NULL` 守卫）：这个值的语义是「什么时候有人动的」，
>   每轮覆盖会把日期变成「我们最后一次看的时间」，什么都答不了。

> **单条可更新总览（2026-08-16，design §11.1 第三条对策）**：原实现每轮**追加**一条总览
> 评论。设计里算过账：一个活跃 MR 上机器发言最低 15 次，机器自己的 push 还会再触发检视，
> 每轮一条总览会把人的讨论彻底埋掉；而人一旦把 bot 静音，**真正需要人接手的三轮失败与
> 冲突报告也一起丢了**。改为 MR 上只维护**一条**，每轮编辑它。
>
> - `comment.list` 加 `comment_scope`（GitHub 的 MR 级评论与行级评论是两个端点，找总览
>   要 `issues`、回读行级意见要 `pulls`）。
> - 总览带 `OVERVIEW_MARKER`（HTML 注释，读者看不见），下一轮据此找回自己那条。
> - **discussion id ≠ note id**：GitLab 上 `thread.resolve` 认 discussion、
>   `comment.update` 认 note（`notes[0].id`），互换即 404。故单列
>   `normalizeOverviewCandidates` 取 note id，与取 discussion id 的
>   `normalizeRemoteComments` 分开；共享 fake 也**给两者不同的值**，否则这个 bug 无法被
>   测出来。
> - 读不到或更新失败（评论被人删了）就退回新建——读失败不是「本轮什么都不说」的理由。

> **T29 草稿批量发布（2026-08-16）**：GitLab 侧从「每条一个 `comment.create-inline`」
> 改成「逐条 `review.draft-create` 攒草稿 → 一次 `review.draft-publish`」。原实现的半发
> 窗口是**作者可见**的：中途失败时前几条意见已经躺在 MR 上、剩下的没有任何交代。草稿把这
> 个窗口挪到无害的地方——攒的过程中失败就把已建的草稿删掉，MR 看起来没被碰过。
>
> - 注册表补 `review.draft-discard`（GitLab `DELETE .../draft_notes/{draft}`）。`draft`
>   字段本来就是为它加的（注释写着「补偿删除要用」），但动作一直没建，于是补偿这条路
>   在代码里根本走不通。
> - **删不掉的草稿必须说出来**：补偿失败或拿不到草稿 id 时，MR 上会留下永不发布的孤儿
>   草稿——正是这套机制存在的唯一理由。故计数并写进失败信息，而不是静默跳过（初版就是
>   静默跳过，测试 fixture 返回 `{}` 才暴露出来）。
> - **一个我差点写死的错误假设**：初版记 externalId 时用了草稿 id，注释还写着「草稿 id
>   发布后就是 note id」。**不是**——`bulk_publish` 把草稿转成新的 note、discussion 有
>   自己的 id，草稿 id 当场作废。台账里会存一批看着对、`thread.resolve` 全拒的引用。
>   改为发布后按指纹**回读**（与 GitHub 同一条路径，`comment.list` 一次补两家）。
> - **回读的重复语义与恢复相反**：`observeBatch` 取**首个**匹配（恢复时最老的那条才是
>   已经在的那条）；发布后回读必须取**最后一个**——问题消失又重现时，老评论还挂在 MR 上
>   且指纹完全相同（指纹由内容派生），取首个会把新一代绑到那条已 resolve 的老线程上，
>   于是 `settle-stale` 去 resolve 一条已 resolve 的，真正活着的那条永远关不掉。故新增
>   `observeJustPublished`，两处语义各自写明。
> - 测试侧新增共享 fake `tests/helpers/codeHostReviewFake.ts`：草稿 → 发布 → discussion
>   的**真实序列**（含发布时 id 变更），五个轮次套件共用，避免五份手写副本各自漂移。

> **§7.2 发布崩溃恢复接线（2026-08-16）**：`sqlitePublishIntentStore` /
> `publishIntent` / `publishReconcileRemote` PR-1c 就写完了，**零调用方**——于是这个洞
> 一直是活的：`publish` 发完评论、`ledger` 记账，两者之间崩溃/取消/被抢占，评论已经在
> MR 上而台账一无所知；下一轮对着空台账判定「全是新的」，把整篇检视**再发一遍**。台账
> 存在的意义被崩溃反噬。
>
> - `comment.list` 动作入注册表（两家各自路径；GitHub 特别注明**不能**用
>   `/issues/{n}/comments`——那是 MR 级评论、不含行级，恢复时会把整批行级评论判成
>   「没发出去」而重发）。
> - `application/recoverPublishIntents.ts`：读远端 → `observeBatch` 按指纹标记认领 →
>   `planPublishRecovery` 决策。**读失败时保持 pending**：pending 下一轮还能救，误判
>   settled 就永久救不回来了。三种结局都覆盖（全中 adopt / 全无 resend / 部分 complete
>   ——最后一种是天真实现必错的：重发整批指望 host 去重，它不会）。
> - `publish` 阶段：意图**在外发调用之前**写盘（写在之后只会记下那些不需要恢复的批次），
>   成功后 settle。`reconcile` 阶段先跑恢复再读台账——因为恢复会写台账行，而台账里有的
>   指纹会被判成 `keep` 而不是 `publish`，这正是「不重发」的机制。
> - **schema 抓到一个我推错的默认值**：`epoch` 有 `CHECK (epoch >= 1)`，我按「还没接
>   工作项、0 最诚实」写了 0，直接 CHECK 失败。正解是 **1**——与工作项自身列默认值一致，
>   语义是「还没发生过任何 supersede」。
>
> 锁在 `rfc304-publish-crash-recovery.test.ts`：真的把崩溃现场摆出来（意图行已写、评论
> 已在假 host 上、台账为空）再跑一轮正常检视。已变异校验：关掉恢复调用，「不重发」等三条
> 立刻转红。指纹**按 `resolve-positions` 的同一路径现算**而非硬编码常量，否则测试只是在
> 比对两个字符串碰巧相等。

> **T7 接线补记（2026-08-16）**：`hookRunner.ts` 与其单测 PR-1a 就写完了，但 `src` 里
> **没有任何调用方**——本模块每个 stage 文件都以「引擎在每个阶段边界触发钩子、合并阶段会
> 静默删掉团队的注入与阻断点」论证自己为何要独立成阶段，而实际上十三个边界零钩子，
> 该论证一直是假的，且**没有任何测试会红**（不存在的机制不会报错）。本次补上：
>
> - `services/codeCapabilityHooks.ts`：repo cell → binding → framework 三跳解析
>   `hooksJson`；坏 JSON / 非列表 / 单条畸形**各自具名**且**不毁整轮**（为一列坏 JSON 让
>   全仓 MR 停审是更糟的失败），单条坏不连累其余（否则一个可选钩子的手误会静默关掉团队的
>   强制门）。
> - `codeCapabilityRunner`：把解析结果转成引擎的 pre/post，`HookOutcome` 三态如实映射——
>   `blocked` 停序列、`failed-nonblocking` 记录后继续（§4.3 F8：可选 lint 钩子红了不该
>   卡住别人的 MR）、`needs-migration` **不跑也不静默**（跑等于喂它读不懂的形状，静默跳过
>   等于团队的门悄悄不设防了）。
> - `scheduler`：每轮解析（不缓存——framework 可能刚删了某个钩子，缓存会继续跑已删的门）；
>   解释器缺失只**禁用钩子并告警**，不拖垮整仓的检视。
> - **一个类型正确但语义反了的 bug（已修）**：初稿写 `.where(eq(repoId) && eq(capability))`
>   ——JS 的 `&&` 在两个 drizzle 条件之间求值成**第二个**，于是仓库过滤整个消失，任何仓库
>   都会继承首个同 capability 的 cell，即**跑别的团队以 daemon 身份执行的脚本**。它能过
>   typecheck，也能过任何只种一个仓库的测试。锁在 `rfc304-hook-resolution.test.ts` 的跨仓
>   两条（已变异校验：改回 `&&` 即红）。

> **T23/T24/T25 落地记录（2026-08-16）**：阶段契约升到 v4，单个 `review` 阶段换成设计
> §6.1 的 `split-diff → review-shard(parallel) → review-global → validate-findings`。
>
> - **每片一棵一次性可写树**（设计门 P1）：`GitPort` 加 `addDisposableWorktree` /
>   `removeDisposableWorktree`，走仓内既有 `withWorktreeRegistryLock`——`worktree add`
>   改的是**公共 git dir 的 registry**，并行分片不串行化会真的写坏（本仓 2026-07-27
>   half-initialized-commondir 事故即此）。树在**任何**退出路径上都删（含抛异常），
>   漏一棵就是永久磁盘泄漏，没有任何下游知道它存在过。
> - **分片失败不毁整轮**（设计原文未规定，此处补决策）：八片里一片废，另外七片是真实
>   且已校验的发现，丢掉它们帮不了任何人；但**七片当八片发**就是「七条里发四条还不说」
>   那个 bug 换张皮。故失败分片零 findings（合宪法 R5）+ `degraded` + 总览写明**哪一块**
>   没审成。全片皆废时才 fail 整轮——此时「无发现」等于骗作者说代码是干净的。
> - **`review-global` 只问跨片问题**：prompt 明确禁止重复分片已报的（附已报标题），
>   因为同一问题换个说法的指纹与 hunk 都不同，下游永远 dedupe 不掉。`validate-findings`
>   合并两趟并按 (file,line,severity,title) 去重兜底——「指示」不等于「保证」。
> - **一个只有集成测试能抓的接线 bug**（已修）：`prepare-worktree` 原来只发布路径、
>   丢掉了它解析出的 sha，于是每棵分片树建在 `undefined` 上；所有 fake git 都忽略 sha，
>   全绿。现在 `worktree` artifact 带 `baselineSha`，锁在
>   `rfc304-sharded-review-round.test.ts`「every shard tree is created at the round's
>   BASELINE sha」（已做变异校验：改回去即红）。

> **T27/T27b/T28 落地记录（2026-08-15）**：阶段契约升到 v3，`mr-review` 序列在
> `resolve-positions` 与 `publish` 之间插入 `reconcile`、在 `publish` 之后插入
> `settle-stale`，与 `design.md §6.1` 的规范序列一致。行为锁在
> `packages/backend/tests/rfc304-multi-round-ledger.test.ts`——**跑三轮**而不是两轮，
> 因为「边沿只触发一次」在两轮里无论实现对错都是绿的。
>
> **~~一处如实记录的缺口（GitHub）~~ 已于 2026-08-16 补齐**：原记录为 `settle-stale` 在
> GitHub 上退化为 `skip`，因为 `review.submit` 一次性提交整批、响应只回 review 不回每条
> 评论 id，而动作注册表当时**没有**可回读评论列表的动作。补齐方式正如当时写下的路径：
> 给注册表加 `comment.list`（GitLab `/discussions`、GitHub `/pulls/{n}/comments`），
> 用 `publishReconcileRemote.ts` 既有的指纹标记扫描把评论 id 认回来。同一个动作**同时**
> 解掉了 §7.2 发布崩溃恢复（见下条），两处缺口一次补上。
>
> GitHub 侧现在在 `review.submit` 成功后多发一次**读**请求回认 id。这不削弱「一次写入、
> 无半发状态」的原子性——读不会造出半发状态——测试也相应从「只有一次调用」改成
> 「只有一次**写**调用」，并单独锁住回读确实发生。

### 前端最小面（PR-5）

| #    | 任务                                                                                                                                                                                                                               | 依赖    |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------- |
| T31b | **后端查询合同**（此前 PR-5 只有前端任务，没有支撑它的 API）：`CodeMatrixQuery` / `EnableCommand`（矩阵行 + readiness + 缺失项 + 修复动作）与 `CodeWorkItemProjectionQuery`（工作项 → 轮次 → 阶段投影，cursor 分页），含 HTTP 适配 | T16c,T5 | ✅ 2026-08-16 |
| T32  | `/code` 路由与导航；仓库 × 能力矩阵配置页（复用既有表单原语）                                                                                                                                                                      | T31b    |
| T33  | 状态机流转图第一、二层：工作项状态 + 展开当前轮阶段                                                                                                                                                                                | T31b    |
| T34  | 任务列表按新任务类型筛选                                                                                                                                                                                                           | T9      |

### MR 监视器（PR-6）

| #    | 任务                                                                                                                                                                                                                                                                                                           | 依赖   |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| T35  | 四个脚本契约（collect / classify / arbitrate / select）+ 返回 schema 校验；`WorkPackage` 判别联合**含 `noop`**——不起 task、不在 MR 说话、只落 observation（50 MR×3 次/天 = 150 次健康唤醒全靠它）。**v1 的 union 只含 `noop \| mr-review`**——PR-7/PR-10 合并时才各自扩入自己那一支                             | T7     |
| T35c | **wake 入口**（**已降为可选**——proposal §6ter-H1 确认自研流水线由 GitLab CI 触发，唤醒链路天然成立）：public command + inbound route + 稳定 MR 定位 + 去重 + 接收回执，触发一次 `collect`。仍要实现（它是 readiness 判据的一部分，也为将来的独立流水线预留），但**不构成 CI 修复上线的前置**，可排在 PR-9 尾批 | T36    |
| T10e | **事件归属**（从 PR-1 移来，其价值到监视器阶段才出现）：每个 ingress event id 只被一个顶层 capability claim；监视器派发与直接触发共享 causation id；机器自身 push 打 cause 标记**仅用于同因果链去重**——已跑过等价 `self-review` 的 revision 才跳过检视，**不反转 E2 的默认监管**                               | T9,T36 |
| T35b | 核心脚本失败一律阻断（`blocking` 只适用钩子）；`collect` 失败不得带空产物继续                                                                                                                                                                                                                                  | T35    |
| T36  | 主循环：事件唤醒 → 四脚本 → 起一轮；**零轮询**断言                                                                                                                                                                                                                                                             | T35,T9 |
| T37  | 默认优先级仲裁（框架未覆盖时）：冲突 > 评论 > CI；CI 内三档                                                                                                                                                                                                                                                    | T35    |
| T38  | 多项工作包：一轮内依次做完、统一推送一次                                                                                                                                                                                                                                                                       | T36    |
| T39  | 冲突检测与报告（**不修**）                                                                                                                                                                                                                                                                                     | T36    |
| T40  | 闭环：MR 合并/关闭 → `closed`，停止后续                                                                                                                                                                                                                                                                        | T36    |

### 评论驱动改码（PR-7）

| #    | 任务                                                                                                                                                                                                                                                 | 依赖    |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| T2c  | **artifact store**（从 PR-1 移来，主要服务本 PR）：不可变产物（detached commit / blob）+ digest + 引用计数；`inherited` 阶段投影；消费或作废后**立即回收**                                                                                           | T2      |
| T4b  | **恢复策略按等待原因**（从 PR-1 移来）：`waitKind` ∈ {`frozen-artifact-confirmation`（禁重跑 AI）, `clarification-answer`（令 comprehend 及下游失效重跑）}                                                                                           | T4      |
| T41a | **共同主干装配**：`resolve-target → collect-thread → prepare-worktree → apply-change → validate-change` + `mr-comment-fix` StageContract + 监视器/ingress 接线（此前只有两个出口任务，主干无人做）                                                   | T4,T36  |
| T41  | `decide-form`：单文件 + 连续行数在阈值内 ⇒ suggestion，否则 patch                                                                                                                                                                                    | T41a    |
| T42  | suggestion 渲染（两家语法）与发布                                                                                                                                                                                                                    | T41,T19 |
| T43  | patch 路径：生成改动 → **固化为 detached commit + digest（`pendingArtifact`）** → 贴 diff（带 digest 短标识）→ `awaiting` → 关键词识别（须匹配 generation）→ `verify-baseline`（校 head/artifact/digest 三者）→ **物化并推送该确切产物**，不重新生成 | T41,T3  |
| T44  | 权限：suggestion 放宽到仓库写权限者；推送锁 MR 作者，bot MR 读 `initiatorUserId`                                                                                                                                                                     | T43     |
| T45  | 源分支变化作废 + 回帖说明                                                                                                                                                                                                                            | T43     |

### 需求实现（PR-8）

| #    | 任务                                                                                                                                                                                                                                                                                                    | 依赖     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| T46a | **新增 issue 事件面**（设计门核实：今天完全不存在）：`CODE_HOST_EVENT_TYPES` 增 `issue_labeled` / `issue_comment`；GitLab adapter 放开 `noteable_type === 'Issue'` 分支并解析 label hook；GitHub adapter 放开非 PR 的 `issue_comment` 与 `issues.labeled`；变量表补 issue 侧字段；触发器 UI 与校验跟进  | —        |
| T46b | 三入口：issue 标签 webhook / `/code` 界面 / 平台 API                                                                                                                                                                                                                                                    | T16,T46a |
| T47  | 模板声明参数表 → 平台渲染表单 + 校验（界面与 API 共用同一校验）                                                                                                                                                                                                                                         | T15,T46b |
| T48  | 入口脚本：只给引用时取回文档集合 `{documents[], writebackHandle}`（用户原话是「一组」设计文档）                                                                                                                                                                                                         | T7,T46b  |
| T49  | `clarify` 分流：有回写句柄且框架支持 ⇒ 回写 issue 评论；否则落平台。**回答的收取同样依赖 T46a**——answer 需带 round/question 标记以关联到具体那一问，并给提问者回执；issue 侧双向通道不可用时**拒绝启用该入口并说明原因**，不静默回退到平台 clarify（否则报告人永远等不到他以为会出现在 issue 里的问题） | T48,T46a |
| T50  | `implement` → `run-target-gate`（读目标仓 CLAUDE.md/CONTRIBUTING）→ `self-review`（`invoke` 子序列，进入前冻结父树为 snapshot）→ `open-mr`                                                                                                                                                              | T31,T4   |
| T50b | **闭环反向索引**（design §6.3 定义、此前无人实现）：`open-mr` 在同一事务内写回 produced MR 并注册 `(codeHostEndpointId, stableProjectId, mrIid) → workItemId`；MR 终态事件幂等消费后推进 requirement 工作项到 `closing/closed`。不做则需求工作项**永远闭不了环**                                        | T50,T40  |

### CI 修复（PR-9）

| #    | 任务                                                                                                                                                       | 依赖     |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| T51a | **`ci-fix` StageContract 装配**（此前只有零散阶段任务，无人把它们接成能力）：完整序列 + 监视器派发接线 + push + ledger + `handed_off` 与 campaign 指纹落账 | T31,T36  |
| T51  | 采集/分类脚本接入自研流水线（框架侧样例脚本 + schema 校验）                                                                                                | T35,T51a |
| T52  | `fix` → `validate-fix`（跑门禁脚本）→ 重跑循环上限 3 轮                                                                                                    | T6,T51   |
| T53  | `anti-cheat-check`（程序）：删断言 / 加 skip / 测试行净减 ⇒ 要求论证，缺则本轮失败                                                                         | T52      |
| T54  | 三轮未成功 ⇒ 停止并回帖汇总每轮尝试                                                                                                                        | T52      |

### 运维与规模化（PR-11）

第二轮设计门以"半年后会变成什么样"为视角报出的一批，体量足以独立成 PR；它们不阻塞前面任何
能力交付，但**不做就会在上线三个月后集中爆发**。

| #   | 任务                                                                                                                                                                                                                              | 依赖    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| T59 | **失败可见性按来源分**：自动 webhook 保持 MR 静默；人工指令（@叫 / 确认 / issue 标签 / API 发起）必须给可更新的 receipt（带 operation id，同一条消息上更新结果）。八类静默路径逐条归位                                            | T31,T43 |
| T60 | **噪音控制**：MR 上只维护一条**可编辑**的 bot 总览（每轮编辑而非追加）+ MR 级通知预算                                                                                                                                             | T29     |
| T61 | **排障链**：`code_trigger_deliveries` 全链落库（received → matched → routed\|dropped(reason) → queued(lease/配额 + 队列年龄) → round → published\|failed）+ 统一 correlation id；"发测试事件"走真实全链并显示断点                 | T2,T36  |
| T62 | **数据寿命**：closed 后物化汇总并归档明细；attempt 明细按期限清理保留聚合；artifact 消费即回收；`templateSnapshot` 内容寻址共享；历史查询走 cursor                                                                                | T2,T27  |
| T63 | **框架发布生命周期**：不可变 revision + `draft→validated→canary→published→retired`；binding 声明 `pinnedRevision`/`followChannel`；发布前回放固定样本并显示受影响仓数；保留 last-known-good 可一键回退                            | T13,T14 |
| T64 | **模板上游关系**：`upstreamRef`/`upstreamVersion`/`baseDigest`/`localOverrides` + `current\|update-available\|conflicted\|orphaned` 四态 + 三方差异预览与"只合并未覆盖字段"；配置包携带来源与基线摘要，连不上标 `detached`        | T17b    |
| T65 | **配置规模化**：按标签/集合批量 preview/apply/revert（落地为**对具体矩阵格的显式批量写入**）+ 唯一的 `EffectiveCapabilityConfig` 读模型。⚠️ **三级 assignment 继承不在本任务内**——它推翻了 F11/G4，登记在 §6bis-B 改-3 待用户确认 | T15,T16 |
| T66 | 状态图规模化：默认只取当前轮 + 最近 20 轮，attempt 按阶段惰性加载与虚拟化；百万级数据与 80 轮长命 MR 的性能验收                                                                                                                   | T55,T62 |

### 前端完整面（PR-10）

| #   | 任务                                                                             | 依赖     |
| --- | -------------------------------------------------------------------------------- | -------- |
| T55 | 状态图第三层：每次 AI 调用（envelope 校验结果、重试次数），可跳转任务详情        | T33,T6   |
| T56 | 轮次切换回看                                                                     | T33      |
| T57 | 模板管理页：两层资源的列表、复制、配置包导入导出；显示上游关系四态与三方差异预览 | T17b,T64 |
| T58 | 采纳率与运行度量面                                                               | T30      |

## 2. PR 顺序与并行性

```
PR-0 code-round 可行性（go/no-go）
  │
  └─► PR-1a 工作项+阶段引擎+钩子 ──► PR-1b 真实 code-round+AI 守卫 ──► PR-1c 并发与发布可靠性
                                          │                                    │
                    PR-2 两层配置 ◄────────┘                                    │
                          │                                                    │
        PR-3 发布能力 ────┴──────────────► ★ PR-4a 首值纵切（第一条行级评论）◄──┘
                                                     │
                                          PR-4b 检视完整能力
                                                     │
                            ┌────────────────────────┼────────────────────────┐
                            ▼                        ▼                        ▼
                    PR-5 前端最小面          PR-6 监视器（v1 只 noop|review）   │
                                                     │                        │
                                          ┌──────────┴──────────┐             │
                                          ▼                     ▼             │
                                  PR-7 评论改码           PR-9 CI 修复         │
                                          │                     │             │
                                          └─────► PR-8 需求实现 ◄┘             │
                                                     │                        │
                                          PR-10 前端完整面 ◄────────────────────┘
                                                     │
                                          PR-11 运维与规模化
```

- **PR-0 是 go/no-go**：`code-round` 接不进 `task-execution` 的话，整条链的地基假设不成立，
  必须回 design D5 重选退路。**先验证再依赖**。
- **PR-3 可与 PR-1/2 并行**（只动 `codeHost` 动作注册表，与新模块无交集）。
- **★ PR-4a 是第一个用户可见价值点**，也是本 plan 刻意优化的目标：让真实 MR 上尽早出现第一条
  行级评论。它之后的每个 PR 都在已经能用的东西上加厚。
- **PR-6 v1 的 union 只含 `noop | mr-review`**——它先于 PR-7/PR-9 合并，若此时就能派发那两种
  能力，真实事件会被选中后启动失败（第三轮 P1）。两者合并时各自扩入自己那一支。
- **PR-11 不阻塞任何能力**，但不做会在上线约三个月后集中爆发。

**PR-11 的定位**：它不阻塞任何能力交付（前十个 PR 各自端到端可用），但**不做就会在上线约三个月后
集中爆发**——噪音导致 bot 被静音、数据膨胀拖慢一切、框架改坏无法回退、200 仓配置无法维护。
建议在第一批能力上线并跑过一段真实流量后立刻排它，而不是等出事。

- **PR-3 可与 PR-1/2 完全并行**（它只动 `codeHost` 动作注册表，与新模块无交集）。
- **PR-4 是第一个用户可见价值点**，也是 PR-7/8/9 的前置（三者都要"自己审自己"）。
- **PR-6 之后 PR-7/8/9 可并行**，各自独立可验收。

## 3. 验收清单

> **两列口径**（第三轮 P2：原表把"主实现"与"E2E 验证"混在一起，出现 AC 无归属或错归属）：
> **主实现 PR** = 该行为的代码落在哪；**验证 PR** = 端到端跑通在哪。两者可以不同。

| PR        | 覆盖的 AC（proposal §9）                                                                     | 门禁                                                                                                                              |
| --------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| PR-0      | —（go/no-go 前置）                                                                           | 真实 `code-round` 启动 → 取消 → daemon 重启恢复三条路径                                                                           |
| PR-4a     | **AC-1（首条评论）**、AC-3、AC-5                                                             | 真实 webhook → 真实 code-host → MR 上出现行级评论（两家各一条）                                                                   |
| PR-1a/b/c | **AC-8（主）**、AC-9、AC-10、AC-20、AC-23、AC-27、AC-28、AC-28b                              | 状态机穷举（含 superseding/handed_off）+ 负扫描**及其反向自检** + 两级重试三档 + epoch 复检 + 最简流程集成                        |
| PR-2      | AC-18、AC-19、AC-21、AC-22、AC-24（框架部分）、**AC-32（backend 判据）**、AC-14d（判据部分） | 权限拒绝 + 参数继承 + 配置包往返（含扩 enum/op 后的闭集）+ readiness 三态与失效重算                                               |
| PR-3      | —（为 AC-1/3/6 提供能力）                                                                    | 两家发布载荷断言 + 部分失败清理                                                                                                   |
| PR-4b     | AC-2、AC-4、AC-6、AC-6b、AC-7、AC-7b、AC-8（接线）、AC-24、AC-30、AC-31                      | position 表驱动 + 完整一轮 + 三集合对账（含发布失败不清理）+ per-shard 树隔离 + fork 两家端到端                                   |
| PR-5      | AC-25（前两层）、**AC-27（UI/E2E）**、**AC-32（UI/E2E）**                                    | 后端查询合同 + 组件测试 + 矩阵三态与修复入口 e2e                                                                                  |
| PR-6      | AC-11、AC-12、AC-15、**AC-33**（`noop` 主实现）、AC-36（验证）                               | 零轮询断言 + `noop` 不起 task 不发言 + 多项工作包一次推送 + 未注册能力不被派发                                                    |
| PR-7      | AC-16、AC-17、AC-29                                                                          | 权限拒绝 + awaiting 全链（断言 AI 阶段未重跑、推送内容与 digest 一致）+ 基线变化作废                                              |
| PR-8      | AC-8（本能力 AI 阶段的接线证明）、AC-14c、AC-22                                              | 三入口参数校验 + issue 事件面往返 + clarify 出站/入站两条路径                                                                     |
| PR-9      | AC-13、AC-14、**AC-14b**、AC-14d（真实链路）                                                 | red-before/green-after 实证 + 结构检查 + 三轮上限 + campaign 指纹重置 + 独立流水线 wake → collect → fix 端到端                    |
| PR-10     | AC-25（第三层）、AC-26                                                                       | e2e：配置 → 发起 → 状态图三层 → 切轮次                                                                                            |
| PR-11     | AC-34、AC-35、AC-37、AC-38（AC-33 主实现在 PR-6、AC-36 在 T10e）                             | 人工指令 receipt 全链 + 一天噪音上限断言 + 排障链断点定位 + 80 轮长命 MR 与百万级数据性能 + 框架灰度与回退 + 200 仓批量启用与回滚 |

## 4. 风险与前置

| 风险                                                                                                 | 应对                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| draft_notes / bulk_publish 在部署侧版本上的实际行为（proposal §10-1）                                | PR-3 先做一次真实实例探测。**不可用时不得自行降级为逐条发布**——那会推翻用户拍板的 B10「一次性发布」并让 MR 出现多次通知。处置顺序：①另寻仍满足单次发布的接口；②都没有则把该 provider 的检视能力标为不可用并说明原因；③确需接受逐条，回 proposal §6bis-B 请用户改判（设计门第三轮 P1：原文预先授权了降级，已收回） |
| **`code-round` execution kind 接不进 task-execution**（真正的首个阻塞点）                            | 风险表原先只写"新任务类型接入既有筛选"，严重低估：它要新增 `StartExecutionRequest` 变体、participant 注册、进程归属、取消/重启恢复、详情投影，而该模块正等 RFC-294 W2 重构。**已前置为 PR-0 的 go/no-go**：只交合同与桩，跑通启动→取消→重启恢复三条真实路径后，StageEngine 才允许依赖它                           |
| **T17a 配置包扩展、T46a issue 事件面**——两项各自是跨多子系统的独立项目，此前被压成一句话且未进风险表 | T17a 触及 type enum / payload / BundleOp union / 闭包解析 / 序列化 / preview / commit provider / importer；T46a 触及 shared 事件 schema / 两家 adapter / 变量表 / 触发器 UI / 双 provider 回归。各自按子系统拆条并**在依赖它们的 PR 开工前独立验收**，否则会分别卡死配置包与整个 PR-9                             |
| 上下文行 position 的接受条件（§10-2）                                                                | PR-3 探测；纯函数已按"同时给 old/new"实现，实测后仅改常量                                                                                                                                                                                                                                                         |
| 抽出不依赖 `WorkflowNode` 的脚本调用面（T7）                                                         | 该重构触及 RFC-253 既有实现，**必须保持 script 节点行为逐字节不变**，以既有 script 测试为回归网                                                                                                                                                                                                                   |
| 新任务类型接入既有筛选（T9）                                                                         | 需确认任务类型枚举的扩展点，避免在 `routes/`/`services/` 平铺层加分支                                                                                                                                                                                                                                             |
| 自研流水线脚本 schema 覆盖率（§10-7）                                                                | PR-9 前先用真实日志样本验证 schema，不足则扩字段而非放宽校验                                                                                                                                                                                                                                                      |

## 5. 不在本 RFC 范围

- fanout 内层 kind 扩展与内链（RFC-294 W8，需 W7 先落地，**另立新号**）。
- 冲突修复、主干流水线修复、跨 MR 批量视图（proposal §11）。
- 顺手记账：`routes/workflows.ts:60` 的 `import {} from '@/services/workflow.yaml'` 空导入死代码，
  属 CLAUDE.md §6 可直接清理的例外，不占本 RFC 任务号。
