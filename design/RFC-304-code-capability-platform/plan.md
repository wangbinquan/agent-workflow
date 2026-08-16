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

> **接续完成（2026-08-16，RFC-305 已落定）**。上面那张待补清单的实际落法，与原计划有两处
> 不同，记在这里免得下一个人以为漏了：
>
> - **按计划补的**：`ACL_RESOURCE_TYPES` 两项、`ACL_TABLES` 两项、`resourceGrants.resourceType`
>   enum、新权限点 `capability-frameworks:*` / `capability-bindings:*`（八个，两层分开：binding
>   四个是普通矩阵点，framework 三个写点进系统域）——均随 T57(a) 落地。**零迁移**：
>   `resource_grants.resource_type` 在 SQL 里是裸 `text` 无 CHECK。
> - **补漏一项**：`OWNER_NAME_UNIQUE_TYPES` 当时**漏了**，2026-08-16 补上并配红测试。症状具体：
>   两张表都带 owner+name 唯一索引，而驱动**属主转移**冲突检查的正是这个集合——不登记就让
>   「把模板转给一个已有同名模板的人」抛出裸 `UNIQUE constraint failed`，即本该 409 的地方给
>   500。（注意它与 `services/capabilityTemplates.ts` 里的 `assertNameFree` **不重复**：后者管
>   创建/改名/复制，前者管属主转移，是互补的两半。）
> - **故意不按计划做的**：`bundle/provider.ts` 的 `TYPE_RANK`、`cli/package.ts`、
>   `bundle/{apply,lower}.ts`、`intent/applyChangeset.ts` —— 原计划是给这些映射表**补项**，
>   实际改成**把类型收窄**（引入 `BundleResourceType` / `IntentResourceType`）。理由：配置包
>   现在**载不了**这两类（T17a 未落），给映射表补项等于新增一条编译通过却什么也不产出的导出
>   路径；而收窄反而逼出了两个真缺陷（包 manifest root 用更宽 schema 校验、CLI 对用户输入
>   `as` 断言使随后的校验失效）。等 T17a/T17b 落地时再把这些放开——那才是补项的正确时机。

> **T19 的 i18n 残留（2026-08-16 收口）**：那份 283 行的 patch 只被打回了一部分——三个 review
> 动作的 label 在，但两条 unsupported 理由（`singleRequestReview` / `useDraftNotes`）**中英都
> 缺**。之所以长期没人发现：`CodeHostCallEdit` 用的是
> `t(key, { defaultValue: t('codeHostInspector.unsupportedGeneric') })`，**缺翻译时界面显示的是
> 一句像模像样的泛化文案而不是裸 key**——带兜底的缺失比不带兜底的更难被看见。已补齐，并加
> `code-host-unsupported-reasons.test.ts` 把注册表与 i18n 表**接上**：此前 shared 那侧只断言
> `reasonKey` 被设置、i18n 那侧只断言中英对称，**没有任何一条跨过两者**。

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

> **T32/T33 前端最小面（2026-08-16）**：`/code` 两个页签——仓库 × 能力矩阵、活动
> （工作项 → 轮次 → 阶段，即状态图前两层）。全部复用既有原语（PageHeader / TabBar +
> TabPanels / Field / TextInput / Switch / StatusChip / EmptyState / ErrorBanner /
> LoadingState），无自写 chrome。
>
> - **readiness 渲染成动作而不是徽章**：后端已把每条缺失与修它的路由配好对，页面渲染的是
>   链接。只显示一个红标签等于把问题从「不知道为什么不跑」挪成「不知道去哪修」。
> - **`disabled` 用中性色**：关掉是选择、不是故障；和故障同色会训练人忽略这个颜色。
> - **四条前端守卫各自照办**：TabBar 必须带 `idPrefix` 且与同前缀的 `TabPanels` 配对——
>   我原本写的三元切换渲染是对的，但会让 tab 的 `aria-controls` 指向不存在的面板；
>   nav 图标清单与 route-UX 双向棘轮各自登记，后者**要求先有渲染测试**才允许登记路由
>   （`code-page-inline.test.tsx`，承重用例是「misconfigured 的每条缺失都渲染出修复链接」）。

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
| T32  | `/code` 路由与导航；仓库 × 能力矩阵配置页（复用既有表单原语）                                                                                                                                                                      | T31b    | ✅ 2026-08-16 |
| T33  | 状态机流转图第一、二层：工作项状态 + 展开当前轮阶段                                                                                                                                                                                | T31b    | ✅ 2026-08-16 |
| T34  | 任务列表按新任务类型筛选                                                                                                                                                                                                           | T9      | ✅ 2026-08-16 |

### MR 监视器（PR-6）

| #    | 任务                                                                                                                                                                                                                                                                                                           | 依赖   | 状态                                        |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------- |
| T35  | 四个脚本契约（collect / classify / arbitrate / select）+ 返回 schema 校验；`WorkPackage` 判别联合**含 `noop`**——不起 task、不在 MR 说话、只落 observation（50 MR×3 次/天 = 150 次健康唤醒全靠它）。**v1 的 union 只含 `noop \| mr-review`**——PR-7/PR-10 合并时才各自扩入自己那一支                             | T7     | ✅ 2026-08-16                               |
| T35c | **wake 入口**（**已降为可选**——proposal §6ter-H1 确认自研流水线由 GitLab CI 触发，唤醒链路天然成立）：public command + inbound route + 稳定 MR 定位 + 去重 + 接收回执，触发一次 `collect`。仍要实现（它是 readiness 判据的一部分，也为将来的独立流水线预留），但**不构成 CI 修复上线的前置**，可排在 PR-9 尾批 | T36    | ⏳ 可选，排 PR-9 尾批                       |
| T10e | **事件归属**（从 PR-1 移来，其价值到监视器阶段才出现）：每个 ingress event id 只被一个顶层 capability claim；监视器派发与直接触发共享 causation id；机器自身 push 打 cause 标记**仅用于同因果链去重**——已跑过等价 `self-review` 的 revision 才跳过检视，**不反转 E2 的默认监管**                               | T9,T36 | ✅ 2026-08-16（observation 唯一索引 claim） |
| T35b | 核心脚本失败一律阻断（`blocking` 只适用钩子）；`collect` 失败不得带空产物继续                                                                                                                                                                                                                                  | T35    | ✅ 2026-08-16                               |
| T36  | 主循环：事件唤醒 → 四脚本 → 起一轮；**零轮询**断言                                                                                                                                                                                                                                                             | T35,T9 | ✅ 2026-08-16                               |
| T37  | 默认优先级仲裁（框架未覆盖时）：冲突 > 评论 > CI；CI 内三档                                                                                                                                                                                                                                                    | T35    | ✅ 2026-08-16                               |
| T38  | 多项工作包：一轮内依次做完、统一推送一次                                                                                                                                                                                                                                                                       | T36    | ✅ 2026-08-16                               |
| T39  | 冲突检测与报告（**不修**）                                                                                                                                                                                                                                                                                     | T36    | ✅ 2026-08-16（每 revision 报一次，不修）   |
| T40  | 闭环：MR 合并/关闭 → `closed`，停止后续                                                                                                                                                                                                                                                                        | T36    | ✅ 2026-08-16（dispatcher 已接线）          |

> **PR-6 那条遗留项已解决（2026-08-16），记下选法与理由**：**能力轮次的 webhook 归属**。
> 原本三条路都不理想：①给 `TASK_LAUNCH_ORIGINS` 加第五种要改 `tasks` 表的 CHECK，而 SQLite
> 改 CHECK 只能整表重建——`tasks` 是全库最大、被外键指得最多的表，为一个枚举值重建它不划算；
> ③让 fires 表 `trigger_id` 可空同样是重建。
>
> 最终走的是**把不变量说得更准**而不是放松它：RFC-301 的 webhook 分支要求的是「可归属」，
> 而可归属的锚点本来就有**两种**——触发器 fire，以及**能力轮次**（`code_work_rounds` 行，
> 带工作项、轮次号与事件链）。能力不是触发器（§3.1 明写），所以它没有 trigger 行可指是**正确**
> 的，不是缺陷。判据改为「有 canonical context，且 (trigger+fire) 或 capability round 其一」，
> 普通触发器启动**仍然两个 id 都要**——所以丢了 fire id 不会伪装成能力轮次混过去。
> 纯代码改动，零迁移。dispatcher 的唤醒接线随之落地（`wakeCodeCapabilitiesFor`）。
>
> 接线时被 RFC-268 的既有断言拦下一次：scratch 启动**不得**走到 repo resolver，而我一开始
> 每条投递都无条件解析。改为**先查有没有任何启用中的单元格**再解析——没配能力的部署（也就是
> 今天所有部署、以及那批 RFC-268 用例描述的形态）行为一字未变。

### 评论驱动改码（PR-7）

| #    | 任务                                                                                                                                                                                                                                                 | 依赖    | 状态                                                    |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------- |
| T2c  | **artifact store**（从 PR-1 移来，主要服务本 PR）：不可变产物（detached commit / blob）+ digest + 引用计数；`inherited` 阶段投影；消费或作废后**立即回收**                                                                                           | T2      | ✅ 2026-08-16                                           |
| T4b  | **恢复策略按等待原因**（从 PR-1 移来）：`waitKind` ∈ {`frozen-artifact-confirmation`（禁重跑 AI）, `clarification-answer`（令 comprehend 及下游失效重跑）}                                                                                           | T4      | ◐ 见下方说明（冻结产物一支已落，clarify 一支随 PR-8）   |
| T41a | **共同主干装配**：`resolve-target → collect-thread → prepare-worktree → apply-change → validate-change` + `mr-comment-fix` StageContract + 监视器/ingress 接线（此前只有两个出口任务，主干无人做）                                                   | T4,T36  | ✅ 2026-08-16（阶段已装配；ingress 接线同 PR-6 遗留项） |
| T41  | `decide-form`：单文件 + 连续行数在阈值内 ⇒ suggestion，否则 patch                                                                                                                                                                                    | T41a    | ✅ 2026-08-16                                           |
| T42  | suggestion 渲染（两家语法）与发布                                                                                                                                                                                                                    | T41,T19 | ✅ 2026-08-16                                           |
| T43  | patch 路径：生成改动 → **固化为 detached commit + digest（`pendingArtifact`）** → 贴 diff（带 digest 短标识）→ `awaiting` → 关键词识别（须匹配 generation）→ `verify-baseline`（校 head/artifact/digest 三者）→ **物化并推送该确切产物**，不重新生成 | T41,T3  | ✅ 2026-08-16                                           |
| T44  | 权限：suggestion 放宽到仓库写权限者；推送锁 MR 作者，bot MR 读 `initiatorUserId`                                                                                                                                                                     | T43     | ✅ 2026-08-16（判定规则；接线随确认入口）               |
| T45  | 源分支变化作废 + 回帖说明                                                                                                                                                                                                                            | T43     | ✅ 2026-08-16                                           |

> **T4b 的落法（与原文措辞不同，此处说明）**：原计划要一个 `waitKind` 枚举来区分恢复策略。
> 实现时改为由 `awaiting` 结果自带的 **`resumeAt` 阶段名**表达——`frozen-artifact-confirmation`
> 就是 `resumeAt: 'verify-baseline'`，它位于 `apply-change` **之后**，因此「禁重跑 AI」不是一条
> 需要遵守的规则，而是序列本身的形状（`rfc304-comment-fix-round` 用一个「被调用就抛」的假模型
> 锁死这一点）。再加一个 `waitKind` 字段等于把同一件事编码两遍，两者一旦不一致，真正生效的是
> 阶段名而告警看的是字段。`clarification-answer` 那一支属于 `requirement`，随 PR-8 落地。

### 需求实现（PR-8）

| #    | 任务                                                                                                                                                                                                                                                                                                    | 依赖     | 状态                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------- |
| T46a | **新增 issue 事件面**（设计门核实：今天完全不存在）：`CODE_HOST_EVENT_TYPES` 增 `issue_labeled` / `issue_comment`；GitLab adapter 放开 `noteable_type === 'Issue'` 分支并解析 label hook；GitHub adapter 放开非 PR 的 `issue_comment` 与 `issues.labeled`；变量表补 issue 侧字段；触发器 UI 与校验跟进  | —        | ✅ 2026-08-16                                                       |
| T46b | 三入口：issue 标签 webhook / `/code` 界面 / 平台 API                                                                                                                                                                                                                                                    | T16,T46a | ◐ issue 标签入口已通（含 dispatcher 接线）；`/code` 与 API 入口待做 |
| T47  | 模板声明参数表 → 平台渲染表单 + 校验（界面与 API 共用同一校验）                                                                                                                                                                                                                                         | T15,T46b | ◐ 声明格式 + 单一校验器 + 解析链已落；表单渲染随 PR-10              |
| T48  | 入口脚本：只给引用时取回文档集合 `{documents[], writebackHandle}`（用户原话是「一组」设计文档）                                                                                                                                                                                                         | T7,T46b  | ✅ 2026-08-16（输入契约与预算；入口脚本待接）                       |
| T49  | `clarify` 分流：有回写句柄且框架支持 ⇒ 回写 issue 评论；否则落平台。**回答的收取同样依赖 T46a**——answer 需带 round/question 标记以关联到具体那一问，并给提问者回执；issue 侧双向通道不可用时**拒绝启用该入口并说明原因**，不静默回退到平台 clarify（否则报告人永远等不到他以为会出现在 issue 里的问题） | T48,T46a | ✅ 2026-08-16（分流判定与标记；发问接线待做）                       |
| T50  | `implement` → `run-target-gate`（读目标仓 CLAUDE.md/CONTRIBUTING）→ `self-review`（`invoke` 子序列，进入前冻结父树为 snapshot）→ `open-mr`                                                                                                                                                              | T31,T4   | ✅ 2026-08-16（阶段实现 + invoke 运行器 + 目标仓门禁读取）          |
| T50b | **闭环反向索引**（design §6.3 定义、此前无人实现）：`open-mr` 在同一事务内写回 produced MR 并注册 `(codeHostEndpointId, stableProjectId, mrIid) → workItemId`；MR 终态事件幂等消费后推进 requirement 工作项到 `closing/closed`。不做则需求工作项**永远闭不了环**                                        | T50,T40  | ✅ 2026-08-16（已接进终态路径）                                     |

### CI 修复（PR-9）

| #    | 任务                                                                                                                                                       | 依赖     | 状态                                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------ |
| T51a | **`ci-fix` StageContract 装配**（此前只有零散阶段任务，无人把它们接成能力）：完整序列 + 监视器派发接线 + push + ledger + `handed_off` 与 campaign 指纹落账 | T31,T36  | ✅ 2026-08-16（契约 + 完整序列 + 派发接线；补齐 union 缺失的两支）             |
| T51  | 采集/分类脚本接入自研流水线（框架侧样例脚本 + schema 校验）                                                                                                | T35,T51a | ⏳ 采集/分类样例脚本待写（schema 与运行器已就绪）                              |
| T52  | `fix` → `validate-fix`（跑门禁脚本）→ 重跑循环上限 3 轮                                                                                                    | T6,T51   | ◐ 配额与指纹已落，`validate-fix` 阶段实现待做                                  |
| T53  | `anti-cheat-check`（程序）：删断言 / 加 skip / 测试行净减 ⇒ 要求论证，缺则本轮失败                                                                         | T52      | ✅ 2026-08-16（结构信号 + red-before/green-after 裁决 + 无从论证的一支转人工） |
| T54  | 三轮未成功 ⇒ 停止并回帖汇总每轮尝试                                                                                                                        | T52      | ✅ 2026-08-16（耗尽后逐轮汇总 + 写明重置条件）                                 |

> **T52 的落法（与原文措辞不同，此处说明）**：原计划写「重跑循环上限 3 轮」，实现时**没有**在轮次内
> 做循环。理由是配额的计数键（§6.4 E9）是 **`(工作项, 失败指纹)`**——指纹存在的唯一意义就是**跨轮**
> 匹配；轮内循环面对的必然是同一个失败，根本用不着指纹。所以形状是「**一轮 = 一次尝试**」，计数落
> `code_fix_attempts` 表，下一次 pipeline 事件开下一轮时接着数。若把计数留在内存里，每轮都会从 1 重
> 新开始，「三次」等于「永远」——`rfc304-ci-fix-round.test.ts` 里那条跑四轮的用例就是锁这个的，
> 单轮测试**看不见**它。
>
> **顺带补上的三处「两半都对、就是没接上」**（都不是新需求，是既有能力够不着）：
>
> 1. `WorkPackageSchema` 从来没有 `mr-comment-fix` / `ci-fix` 两支——PR-7 的整条评论修复序列写完、
>    单测全绿，但仲裁脚本一旦选它就被判为「产出不合契约」→ `blocked`。**缺一支 union 和一次合法拒绝
>    长得一模一样**，所以全仓无一处标红。
> 2. `defaultArbitrate`（无自定义 arbitrate 脚本时的内置仲裁）对评论与红流水线仍回 `noop` +
>    「本版本还做不了」。上线第一天没人写过 arbitrate 脚本，等于两个能力对所有部署都不可达。
> 3. `rfc304-monitor-contracts.test.ts` 里有一条用例**把临时状态锁死了**——它断言 `ci-fix` 必须被
>    schema 拒绝。意图是对的（平台跑不了的名字不该放进来），例子过期了；改成断言一个真不存在的能力
>    被拒 + 每个已发布能力都被接纳，两半都锁。
>
> **push 用 `expectedRemoteSha` 做 CAS，比对的是 `collect` 当时报的 head**，不是「当前分支头」——
> 后者是拿一个值和它自己比，守卫永远通过，包括唯一该拦的那次（作者在 agent 干活期间推了代码，
> force-update 会让平台成为**弄坏它本该修的分支**的那个）。

### 运维与规模化（PR-11）

第二轮设计门以"半年后会变成什么样"为视角报出的一批，体量足以独立成 PR；它们不阻塞前面任何
能力交付，但**不做就会在上线三个月后集中爆发**。

| #   | 任务                                                                                                                                                                                                                              | 依赖    | 状态          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------- |
| T59 | **失败可见性按来源分**：自动 webhook 保持 MR 静默；人工指令（@叫 / 确认 / issue 标签 / API 发起）必须给可更新的 receipt（带 operation id，同一条消息上更新结果）。八类静默路径逐条归位                                            | T31,T43 | ✅ 2026-08-16 |
| T60 | **噪音控制**：MR 上只维护一条**可编辑**的 bot 总览（每轮编辑而非追加）+ MR 级通知预算                                                                                                                                             | T29     | ✅ 2026-08-16 |
| T61 | **排障链**：`code_trigger_deliveries` 全链落库（received → matched → routed\|dropped(reason) → queued(lease/配额 + 队列年龄) → round → published\|failed）+ 统一 correlation id；"发测试事件"走真实全链并显示断点                 | T2,T36  | ✅ 2026-08-16 |
| T62 | **数据寿命**：closed 后物化汇总并归档明细；attempt 明细按期限清理保留聚合；artifact 消费即回收；`templateSnapshot` 内容寻址共享；历史查询走 cursor                                                                                | T2,T27  | ✅ 2026-08-16 |
| T63 | **框架发布生命周期**：不可变 revision + `draft→validated→canary→published→retired`；binding 声明 `pinnedRevision`/`followChannel`；发布前回放固定样本并显示受影响仓数；保留 last-known-good 可一键回退                            | T13,T14 | ✅ 2026-08-16 |
| T64 | **模板上游关系**：`upstreamRef`/`upstreamVersion`/`baseDigest`/`localOverrides` + `current\|update-available\|conflicted\|orphaned` 四态 + 三方差异预览与"只合并未覆盖字段"；配置包携带来源与基线摘要，连不上标 `detached`        | T17b    | ✅ 2026-08-16 |
| T65 | **配置规模化**：按标签/集合批量 preview/apply/revert（落地为**对具体矩阵格的显式批量写入**）+ 唯一的 `EffectiveCapabilityConfig` 读模型。⚠️ **三级 assignment 继承不在本任务内**——它推翻了 F11/G4，登记在 §6bis-B 改-3 待用户确认 | T15,T16 | ✅ 2026-08-16 |
| T66 | 状态图规模化：默认只取当前轮 + 最近 20 轮，attempt 按阶段惰性加载与虚拟化；百万级数据与 80 轮长命 MR 的性能验收                                                                                                                   | T55,T62 | ✅ 2026-08-16 |

### 前端完整面（PR-10）

| #   | 任务                                                                             | 依赖     | 状态                                                    |
| --- | -------------------------------------------------------------------------------- | -------- | ------------------------------------------------------- |
| T55 | 状态图第三层：每次 AI 调用（envelope 校验结果、重试次数），可跳转任务详情        | T33,T6   | ✅ 2026-08-16                                           |
| T56 | 轮次切换回看                                                                     | T33      | ✅ 2026-08-16                                           |
| T57 | 模板管理页：两层资源的列表、复制、配置包导入导出；显示上游关系四态与三方差异预览 | T17b,T64 | ✅ 2026-08-16（(a)(b)(c) 全落，T17a/T17b/T64 同日补齐） |
| T58 | 采纳率与运行度量面                                                               | T30      | ✅ 2026-08-16                                           |

> **T57 开工前对账（2026-08-16，按源码而非按计划表）**：它的两个依赖**都还没实现**，而 PR-2 在
> 任务表里是「已完成」——原因是 T17a/T17b 那两行当时被压成一句话、且 PR-2 那张表**没有状态列**，
> 于是「表已建 + ACL 列已加」被当成了「接入完成」。按源码实际：
>
> - `ACL_RESOURCE_TYPES` 只有六种（agent/skill/mcp/plugin/workflow/workgroup），**没有**
>   capability_framework / capability_binding。两张表虽然带了 owner/visibility/acl_revision 列，
>   但 `filterVisibleRows(db, actor, 'capability_framework', …)` 连类型都过不了——列在、闭包不在。
> - `BundleOpSchema` 的 12 个 arm 里**没有** capability 相关的任何一支，即 T17a「扩 RFC-271 闭合
>   集合」未落；T17b（两类资源接入配置包）自然也无从谈起。
> - T64（上游关系四态 + 三方差异预览）属 PR-11，未实现。
>
> 另外 `templateLayers.ts` 里 `rejectFrameworkOnlyFields` / `canWriteFramework` 两条规则**写好了
> 但全仓零调用**——因为这两类资源根本还没有 HTTP 面。这是本 RFC 反复出现的同一形状（两半都对、
> 就是没接上），T57 的路由就是那个接头。
>
> 故 T57 拆为：**(a)** ACL 闭包扩两型 + 两类资源 CRUD/复制 + 管理页；**(b)** 配置包导入导出
> （需先补 T17a/T17b）；**(c)** 上游四态与三方差异（需先补 T64）。
>
> **(a) 已完成（2026-08-16）**，落法与踩到的坑：
>
> - ACL 闭包扩两型**零迁移**——`resource_grants.resource_type` 在 SQL 里是裸 `text`、无 CHECK，
>   闭合集合只活在类型系统里。（对照：`tasks` 的 launch origin 有真 CHECK，同一个 RFC 里
>   为此换了判据绕开，见 PR-6 遗留项那段。）
> - 扩宽 `AclResourceType` 后编译器点出 12 处，**每一处都是三个不同问题此前被同一个类型
>   回答**（因为答案恰好相同）：哪些类型有行级 ACL / 哪些能进配置包 / 哪些能被 Intent 会话
>   创建。现拆为 `AclResourceType` / `BundleResourceType` / `IntentResourceType`，后两者共用
>   一份清单，`ResourcePackageTypeSchema` 由它派生而非第三次重抄。其中两处是真缺陷（包
>   manifest root 用更宽 schema 校验；CLI 对用户输入 `as` 断言使随后的校验失效），两个集合
>   还相等时都不可见。
> - **八个权限点，两层分开**：binding 四个是普通矩阵点（进 user 基线、可上令牌、有 MCP 工具
>   面）；framework 三个写点进**系统域**（永不进令牌、无 MCP 工具面——让 agent 去编辑「配置
>   agent 的模板」是没人要过的循环）。framework 的 read 仍是普通点，脚本正文在序列化时对非
>   `scripts:author` 遮蔽：**遮蔽而非扣留**——扣留会让小组层在不发放部门层的前提下不可用，
>   而那正是分层的全部意义。
> - `rejectFrameworkOnlyFields` / `canWriteFramework` 自 PR-2 起零调用，这两条路由就是那个接头。
>   framework 写是真 AND（资源写权 ∧ scripts:author），两个方向都有用例：只有资源写权时报错
>   **点名缺的是哪一个**（真实部署里最常见的正是这一种，光说 forbidden 会让人去申请错的权限）。
> - 启动自检按设计工作：5 个无路由权限点让 daemon 拒绝启动，20 条测试失败全是这一条拒绝。

> **顺带删掉一处重复实现**：`templateLayers.resolveParams` 与 shared 的
> `resolveCapabilityParams` 是同一件事的两份实现，前者**零调用**。两份永远不一起跑的实现可以
> 无限期地互相矛盾而不被任何测试发现，所以删掉了零调用的那份，并把它独有的**来源追溯**
> （哪个值赢了、从哪来——排查「我的阈值怎么不生效」时唯一有用的信息）搬进留下的那份
> （`traceCapabilityParams`）。留下的那份还知道得更多：它拿到的是完整参数表而不只是一串 key 名。

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

## 2bis. 实现完整性审视（2026-08-16，任务 #19）

按源码逐条对账，不看任务表状态列——本轮已三次发现表记完成而源码未落。方法是扫
「两半都对、就是没接上」：**规则/表/schema 已建但零调用**、**union 缺一支**、
**点位无路由**、**写侧有读侧无**。

**最大的一处，也是这次审视存在的理由**：**调度器只接线了 `mr-review` 一条能力**。

```
scheduler.ts:4558   capability === 'mr-review' && state.triggerContext !== null
                      ? await buildMrReviewWiring({...})
                      : null      ← 其余四条能力全部走到这里
```

后果是具体的：`mr-comment-fix` / `requirement` / `ci-fix` 的 stage composition
（`mrCommentFixStages.ts` / `requirementStages.ts` / `ciFixStages.ts`）**写完了、
单测全绿、但调度器对它们零引用**——起一轮拿到的是没有任何 programStages/aiStages
的 runner，于是第一个阶段就以
`stage 'X' is kind 'program', which has no runner registered yet` 失败。

**而且 PR-9 把这件事从「够不着」变成了「够得着但会炸」**：我在 PR-9 给
`WorkPackageSchema` 补了 `mr-comment-fix` / `ci-fix` 两支 union arm（那本身是对的
——缺一支 union 和一次合法拒绝长得一模一样），于是监视器**现在真的会派发**它们。
派发 → 起轮 → 持 MR lease → 每个阶段失败。补 union 而不补接线，等于把一个安静的
不可达变成一个响亮的失败；两者都要修，而正确的修法是**补接线**，不是缩回 union。

`mr-review` 本身是**真正端到端通的**：`buildMrReviewWiring` + `resolveReviewerAgent`

- `createReviewAgentCaller` 都在调度器里接上了（早期注释说「makeCaller 故意不给」
  是过期的，代码后来补上了）。所以这不是「整条 RFC 没接」，而是**四条能力里只接了
  一条**。

### 2bis.1 「零生产引用」模块普查

判据是机械的：模块在 `src` 下被 import 的次数为 0（测试不算）。全模块扫出 8 个，
逐个定性如下——**「零引用」本身不是缺陷，缺陷是「本该有人调而没人调」**。

| 模块                                        | 定性                  | 处置                                    |
| ------------------------------------------- | --------------------- | --------------------------------------- |
| `dataLifetimeGc`（T62）                     | **该调没调**          | 已修：`cli/start.ts` 起 ticker + 停机停 |
| `mrVoice`                                   | **该调没调**          | 已修：ci-fix 发言改走 `say()`           |
| `invalidatePending`（T45）                  | **该调没调**          | 已修：接在 `collect` 之后，见 2bis.2    |
| `pushAuthority`（T44）                      | **该调没调**          | 已修：接在 `verify-baseline`，见 2bis.3 |
| `sqliteWorkItemStore` 链                    | 与生产实现**重复**    | 未修，见 2bis.4                         |
| `sampleMonitorScripts`                      | 样例，测试内执行      | 可接受（无生产调用面是本意）            |
| `configScale` / `stateViewScale`（T65/T66） | 规模判据，供前端/文档 | 可接受                                  |
| `frameworkRelease`（T63）                   | 灰度判据              | 可接受                                  |
| `templateUpstream`（T64）                   | 经 service 暴露       | 可接受                                  |
| `readinessInvalidation`                     | 判据纯函数            | 可接受                                  |

### 2bis.2 T45 失效从未运行（已修）

`invalidatePendingOnPush` 写完、单测全绿、`src` 下零 import。规则在，**该触发的
时刻不存在**。

这一处的破坏是安静的，所以活得久：`verify-baseline` 仍然拒绝推送过期 artifact，
**不会推错东西**。发生的是另一回事——diff 挂在 thread 上看起来还有效，作者两天后
回 `/aw apply`，此时才知道它早就过期了。没人告诉过他，而平台让他做的事失败了。
T45 的全部意义就是**在分支移动的那一刻说话**，而不是在有人尝试使用的那一刻。

接线点选在 `collect` 之后：`collect` 报出当前 head，是整个循环里平台**唯一**知道
分支动过的时刻。锁在 `rfc304-monitor-invalidation-join.test.ts`（去掉接线 → 2 条
正向断言转红，3 条「什么都不该发生」保持绿）。

### 2bis.3 T44 推送授权从未运行（已修）

`judgePushAuthority` 零调用。它自己的注释写明后果：patch 形态由**平台用自己的凭据
推送**，下游不校验任何人的权限，「一条评论与别人分支上的一个 commit 之间，唯一挡着
的就是这个函数」。`verify-baseline` 此前只做 C7 基线校验，**不看是谁要求的**。

**我此前判为「需用户裁决」，判错了**——与 2ter.4 闸二同一个错误：把「我没找到数据」
当成「设计没定」。实际上两头都是现成的：

- **规则早定了**：design §939「叫机器推送 | MR 作者；bot 开的 MR ⇒ `initiatorUserId`
  | C3」，§1163 更把它写成验收判据（「非 MR 作者叫推送被拒；bot MR 上
  `initiatorUserId` 可叫、他人不可」）。
- **数据也拿得到**：`mrAuthor` 不在 webhook 规范字段里，但 `mr.get` 返回它，而
  `mrReviewStages.ts:283` 早就在调这个 action。我先前「只接一半会拦住主路径」的结论，
  建立在「拿不到 mrAuthor」这个错误前提上。

修法：`verify-baseline` 在 C7 之后、返回 done 之前判 T44。四个身份——commenter 取
trigger 的 `comment_author`；`mrAuthor` 取 `mr.get`（**不新增 webhook 字段**：授权
输入不该信第三方载荷）；`initiator` 取 `code_work_items.initiator_user_id`；
`botUsername` 暂缺且**不阻塞**——它喂的是纵深防御那一层，规则本身已拦住平台自授权
（bot 开的 MR 上 initiator 优先，而平台永远不是 initiator）。

拒绝**回帖说明**而非静默丢弃：被静默忽略的确认会教会用户「这功能不可靠」，代价比
拒绝本身大。实测文案点名有权的人并给出下一步（「Nothing was pushed — copy the diff
if you want to apply it yourself」）。

测试：`rfc304-comment-fix-round.test.ts` 加两条（非作者被拒且回帖点名、无法归属的
确认被拒而不是假定为作者），去掉这道判定即转红（已验证）。既有「确认轮推送冻结
commit」那条同步更新夹具——它此前**不必说明是谁在确认**，现在必须。

### 2bis.4 工作项状态机与生产实现重复（未修）

`decideCodeWorkItemTransition` / `applyWorkItemEvent`（10 状态 / 10 事件 / 12 效果）
**只有测试调用者**，`sqliteWorkItemStore` 整条链在 `src` 下零引用。

但**这不是可靠性没实现**——先查了再说：它声明的行为在生产里由另一套命令式实现
承担，且都接上了：MR lease（`mrLease.ts` + `sqliteMrLeaseStore` + scheduler）、
epoch（`mrReviewStages` / `mrReviewEnvironment`）、handed_off（`ciFixStages`）。
真正没接的是**声明式的 queue-and-merge**，而 `codeRoundLease.ts` 的文件头自己就
写明了这一点：「不排队……keep 最新 `pendingRevision`、bump epoch 的行为属于工作项，
那是后面的 PR」。

后果因此是**退化而非错误**：拿不到 lease 的一轮不会起，事件仍被监视器观察并记录
（wake 层不受 lease 管辖，`codeCapabilityWake` 总是跑 `runMonitorLoopFor`），只是
不会为它开轮。缺的是「一轮跑着时到达的新版本，等这轮结束后被处理」这一步。
两套设计留一套是正确终局，属独立一波。

### 2bis.5 自评论回环守卫是失效的冗余防线（未修，风险已定级）

`capabilityWake.ts:153` 的 `options.botUsername` 守卫在生产里恒为 undefined——
全仓无人产出该值。但**主防线是接上的**：webhook 层 `ignoreUsernames` 按作者过滤，
作用域含 `note` / `issue_comment`（`AUTHOR_FILTERED_EVENT_TYPES`），正是回环路径。

所以结论不是「平台会自己刷自己」，而是**回环防护依赖运维把平台账号填进
`ignoreUsernames`**；填了就安全，没填则第二道防线不生效。与 2bis.3 的 bot 账号
是同一份缺失数据，一并决策。

## 2ter. system-mock E2E 找到的三处断链（任务 #20，均已修）

§2bis 是**读代码**扫出来的；这一节是**跑起来**扫出来的。`e2e/rfc304-capability-platform.spec.ts`
把一条签名 webhook 打进编译后的 daemon，走真 SQLite / 真调度器 / 有状态 GitLab /
真 Git，只有模型是确定性替身。三处断链单测一条都看不见，原因完全一致：
**单测把出错的那个东西当参数递进去了**。

### 2ter.1 轮次的宿主任务起在 scratch 空间（`prepare-worktree` 必死）

```
"spaceKind":"scratch"  "cachedRepoId":null
"repoPath":".../scratch/01M050A984AS4ZH8ZWSA519754"
→ stage 'prepare-worktree' failed: fatal: 'origin' does not appear to be a git repository
```

`codeCapabilityWake.ts` 两个起轮点都写死 `scratch: true`，于是 `repoPath` 是个**没有
remote 的空目录**；而 `prepare-worktree` 要从 `origin` 取 MR head（design §5.2 明确
裁决：从 **target remote** 取，因为那是平台已持有凭据的那一个）。**任何部署里
mr-review 都活不过第二个阶段**。单测永远把一个现成的 clone 当 `repoPath` 递进去，
所以这个阶段从来没拿到过生产真正会给它的东西。

修法用的是既有机制、不是新造：`LaunchSpaceFields` 本来就有 `cachedRepoId`，而投递
早就解析出来了（`resolution.cachedRepoId` → `input.repoId`）。两处改成
`cachedRepoId: input.repoId`。

**对夹具的连带要求**（改这块的人会撞上）：起轮从此走 reuse-by-id，于是单测夹具
必须给出**真能启动的**缓存仓——只写一行 `repo_capability_config.repo_id='repo-1'`
不再够。逐层被拒的顺序即是产品的真实约束链，每一层都是**对的行为、错的夹具**：

| 夹具缺什么             | 产品怎么拒                                           |
| ---------------------- | ---------------------------------------------------- |
| 无 `cached_repos` 行   | `cached repo 'repo-1' not found`                     |
| `url_enc` 为 null      | `has no readable URL (sealed with a different key?)` |
| 封的 key 与调度器不同  | 同上——正确的报错、错误的原因                         |
| 裸路径 / `file://`     | `local paths are not a supported remote`（产品明令） |
| 镜像无 `origin`        | 拒绝复用：剥凭据失败，明文 token 可能残留            |
| `last_fetched_at` 太旧 | `refusing to launch from a stale cache`              |

正解是复用既有的 `tests/helpers/gitHttpRemote.ts`（真 smart-HTTP 远端）——它本来
就是为「产品把 `file://` 判非法后单测怎么办」而建的，理由与此处完全同源：另一条路
是在生产代码里开测试旁路，那等于把刚立的规则自己拆掉。已按此改好
`rfc304-capability-wake-launch` 与 `rfc304-terminal-close-wiring` 两个夹具（25 条全绿）。

### 2ter.2 用文件路径当能力配置的主键（AI 阶段全部拒绝 + 钩子从未触发）

```
scheduler.ts  resolveReviewerAgent(db, { repoId: task.repoPath, ... })
scheduler.ts  resolveCapabilityHooks(db, { repoId: task.repoPath, ... })
→ "no capability configuration exists for this repository"
```

`repo_capability_config.repo_id` 存的是 **cached-repo ULID**，`task.repoPath` 是**文件
系统路径**。两者都是 `string`，所以类型检查、lint、单测全绿，运行时**永远匹配不上**。
后果：每一轮的 AI 阶段都以「这仓库没有能力配置」拒绝，且**任何团队写的 stage hook
从来没有触发过**——两个消费者读同一张表，两个都错。

修法：新增 `cachedRepoIdForTask(db, taskId)`（读 `task_repos.cached_repo_id`），三个
调用点统一走它。

> 这条在 2ter.1 修好前是**看不见**的：轮次死在 `prepare-worktree`，根本走不到解析
> agent 那一步。三处断链是**串行**暴露的，每修一处才露出下一处。

### 2ter.3 没有人给轮次写终态

`code_work_rounds` 全生产只有两处写：`openRound` 插入、`attachRoundTask` 补 `taskId`。
**没有任何代码写 `outcome` / `endedAt`**。于是十三个阶段全 `done`、评论都发到 MR 上了，
轮次还是 `running`。

读侧早就按完整词汇表写好了——`deriveRoundStatus`、`codeMetricsQuery` 的
`published/failed/awaiting` 分桶（连「ended 但没写 outcome = daemon 中途死」的分支都
有）、`dataLifetimeGc` 的回收判据。**缺的只是写侧，而缺一个写侧永远不报错。**

修法：`sqliteMonitorStore.closeRound()`（`endedAt IS NULL` 守卫保幂等——**第一个终态
才是真的**，重试不得改写历史），scheduler 的三个出口（awaiting / 失败 / 成功）各调一次。

### 现在跑通到哪

```
resolve-target → prepare-worktree → fetch-diff → split-diff → review-shard(ai)
→ review-global(ai) → validate-findings → gate → resolve-positions → reconcile
→ publish → settle-stale → ledger        全部 done，outcome=published
```

且 MR 上真的出现了行级评论：`POST draft_notes`（带 `position`）+ **一次**
`draft_notes/bulk_publish`——即 B10「一次性发布」，design §10-1 明确禁止降级为逐条发布，
E2E 断言 `bulk_publish` 恰好一次把这条锁住。

门禁保护：E2E 只在 CI 跑，故 `packages/backend/tests/rfc304-round-lifecycle-and-keys.test.ts`
把三条同样的回归放到 `gate:local` 面前（`closeRound` 行为 + 两条源码层断言——
后者是弱形式的测试，此处是**刻意**：缺陷是 5000 行调度分支里一个类型正确的实参，
类型系统和运行时都抓不住，能便宜锁住的只有「那个错误写法不许再出现」）。

### 2ter.4 ci-fix 跑不起来有**两道**闸，已修其一

准备给 ci-fix 补 E2E 时挖出来的，且**第二道是在第一道修好后才露出来的**——与
2ter.1–2ter.3 完全同一种串行暴露。

**闸一：阶段引擎的 `script` 种类没有实现（已修）**

```
codeCapabilityRunner.ts  script: notImplemented('script')
scheduler.ts             resumeFromStage: null       ← 每轮从第 0 阶段起跑
CI_FIX_CONTRACT.stages[0..3]  kind: 'script'（collect / classify / arbitrate / select）
```

于是每一轮都以 `stage 'collect' is kind 'script', which has no runner registered
yet` 立刻失败。**这一处没有任何未决**：四个槽位就是框架的脚本槽，`runMonitorScript`
本来就在给监视器跑同样这四个，结果 schema 也早就有且与各阶段 `produces` 一一对应
——**四个零件全在，没有一个接上**。

修法：新增 `composition/scriptStages.ts`（按 contract 派生实现，而不是手写清单，
所以以后新增 script 阶段自动有实现）+ 引擎补 `script` 分派 + `buildCapabilityWiring`
从框架解析脚本。缺脚本时**具名拒绝并点明层级**（脚本属部门层、需 `scripts:author`），
**不得回退到问 AI**——那会把确定性流水线悄悄变成不确定的，而且看起来还成功了。
锁在 `rfc304-script-stages.test.ts`（5 条，真 python 子进程；去掉 `requires` 过滤
即转红）。

注意**别混淆两条脚本路径**：监视器自己的四个脚本走 `monitorLoop.ts` 的
`runMonitorScript`，那条一直是通的；没通的是**阶段引擎里的 script 种类**。

**闸二：`hasWakeSource` 硬编码 `false`（已修）**

```
readinessFacts.ts:98    hasWakeSource: false,
readinessFacts.ts:33    const NEEDS_WAKE_SOURCE = new Set(['ci-fix'])
```

源码注释自陈「wake entry point 是 PR-6 T35c，所以诚实地写 false」。但**那条注释比它
依据的裁决活得久**：proposal §6ter-H1 早已把这条唯一的待证事实结掉了——

> 由 GitLab CI 触发，GitLab 侧有 pipeline 对象 → 唤醒链路**天然成立**；wake 入口从
> 「必需」**降为可选**；**PR-9 范围不变**。「链路本来就通，不需要你们的流水线做任何改动。」

plan.md 的 T35c 行同样写着「**不构成 CI 修复上线的前置**」。所以这不是待裁决项，是
**一个过期占位符把一整条能力关掉了**——`ci-fix` 是唯一需要 wake source 的能力，于是
它的格子永远 misconfigured。

修在**事实层**而非规则层：`deriveReadiness` 一直是对的（`rfc304-template-layers` 双向
都测了），错的只是喂给它的事实。改为按 contract 派生：**ci-fix 的 wake source 就是它
自己那条 trigger 上的 pipeline 事件**。两个方向都保持诚实——普通格子可被唤醒即
`ready`，而有人把 events 收窄到不含 pipeline 事件时仍报 `no-wake-source`（AC-14d 立
这条规则正是为了这种情况）。

### 2ter.5 修完闸二又连出三处（都已修，全是同一族）

闸二一开，后面三处依次露出来——**每一处都被前一处挡着看不见**，与 2ter.1–2ter.3 完全同形：

| #   | 症状                           | 根因                                                                                                                                                                             |
| --- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | armed 不了 trigger             | `onlyTriggerMissing` 只容忍 `no-trigger`，而 ci-fix 起手同时有 `no-wake-source`——**而后者恰恰要靠 arm trigger 才能满足**。死锁：没 trigger 因为没 ready，没 ready 因为没 trigger |
| 2   | trigger armed 了但事件不对     | `syncCapabilityTrigger` 缺省回退到 **MR-review 的事件集**（它是为那条能力写的），于是 ci-fix 的 trigger 不含任何 pipeline 事件                                                   |
| 3   | 事件对了但格子仍 misconfigured | arm 之后的 re-derive 只手工补了 `hasTrigger: true`，没补 `hasWakeSource`——**紧接着供给了 wake source 的那个动作之后，格子仍说没有 wake source**，且此后无人重算                  |

三处的修法分别是：容忍「arm 本身能消掉的那些 issue」（并用事件检查兜住——收窄了事件
的格子 arm 也救不了，必须继续报错）、把**本格子的事件**显式传给 sync、re-derive 时把
arm 真正变true的**两个**事实都补上。

另有一处小的：`buildCapabilityWiring` 把 `interpreterPath` 缺省成空串，spawn 时表现为
可执行文件缺失、读起来像框架作者的脚本写错了。改为复用 `defaultInterpreterFor`（含
Windows 的 `python` / `python3` 分支），**按每个脚本各自的语言解析**。

### ci-fix 现在跑通到哪

E2E `a SECOND capability is reachable` 全绿：格子 `ready`（zero issues）→ 一条
`pipeline_failed` 投递 → 轮次起来 → 第一个阶段是 ci-fix 自己 contract 的 `collect`
（不是 review 的）→ 框架的两个 python 脚本真跑、输出被接受（`collect` / `classify`
均 `done`）→ 无任何 "no runner registered"。

### 2ter.6 E2E 覆盖五条能力（12 条全绿，连跑三遍稳定）

`e2e/rfc304-capability-platform.spec.ts` 现在逐条能力断言**可达性**，而不是从一条通
推断其余四条通——因为本 RFC 里每条能力都曾各自因不同原因不可达：

| 能力           | 唤醒事件          | 断言                                                                                                            |
| -------------- | ----------------- | --------------------------------------------------------------------------------------------------------------- |
| mr-review      | `mr_opened`       | 十三阶段全 done、`outcome=published`、MR 上出现行级评论（draft_notes + **一次** bulk_publish）                  |
| ci-fix         | `pipeline_failed` | 格子 ready → 首阶段是自己的 `collect`（不是 review 的）→ 框架两个 python 脚本真跑、`collect`/`classify` 均 done |
| mr-comment-fix | `comment_created` | 首阶段 `resolve-target`，无 "no runner registered"                                                              |
| requirement    | `issue_labeled`   | **anchor 是 issue 不是 mr**（弄错不报错，只会把工作项键到一个数字相同的另一个对象上）+ 首阶段 `resolve-input`   |
| mr-monitor     | `mr_updated`      | 观察到了但**什么都不做**（AC-33 `noop`）：有工作项、零轮次、不起 task 不发言                                    |

**一处自己写出来的 flake 已修**（按仓规「flaky 不能掩盖红 case」）：ci-fix 那条原先
等的是「有任何阶段」（`stages.length > 0`），却断言**后面**的 `classify` 已 done——
`collect` 一开始跑该条件就成立了。它先前是**碰巧赢了这个 race**，加进第五条能力后
才输。改成等「`classify` 进入终态」，即等它真正断言的那个条件；连跑三遍稳定。

### 2ter.7 §2.3 lease 协议表的三行从未执行（已修）+ 不可达面全量盘点

顺着「长命 MR」查下去，撞上的是 design §2.2「lease 的完整协议」那张表——三行**建了
没接**：

| 表里那行 | 实际状态                                                                                                                       | 后果                                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| 续租     | `renewLease` 零调用方，`withRoundLease` 从不续                                                                                 | 轮次一超过 `ROUND_LEASE_MS`（15min，AI 轮次的常态）就悄悄丢掉 MR；`acquireLease` 走 expiry 分支放行，同一 MR 上第二轮开跑 |
| 崩溃恢复 | `daemonGeneration` 在 `RunTaskOptions` 上、在 `INHERITABLE_RUN_CONFIG_KEYS` 里、scheduler 也读——**没人赋值**，生产恒为 `'dev'` | 重启前后同代际 ⇒ `decideLeaseAcquisition` 的 fence 永不触发，崩掉的 daemon 把它持过的每个 MR 锁满一个租期                 |
| 崩溃恢复 | `reclaimStaleLeases` 自带 "Run at boot" 文档、零调用方                                                                         | 表里长期留着没有主人的行                                                                                                  |

修法：`services/daemonGeneration.ts`（模块加载期铸 ULID；`resolveDaemonGeneration`
显式优先，保证**子任务跑在父任务的代际**上，否则子任务会把父任务活着的 lease 当作
废票抢走）+ `withRoundLease` 起心跳（`leaseMs/3`，ticker 可注入以免用例依赖挂钟；
`finally` 里先置终止标志再停表再释放，避免在途心跳误报「lease 丢了」）+
`reclaimCodeLeasesOnBoot` 接进 `cli/start.ts` 启动恢复段。

**代际这条修完立刻照出一条测试的假绿**：`rfc304-t4a3-mock-end-to-end` 里那条「另一
轮持锁时本轮不得开跑」，夹具用 `daemonGeneration: 'dev'` 铸竞争 lease——那恰好等于
当时的生产兜底值，所以它一直**是对的**；生产改成真代际后，那把 lease 变成「上个
daemon 的」被 fence 放行，用例转红。夹具改用 `DAEMON_GENERATION`（竞争者按定义是
本代际的活轮次）。这正是这类缺陷的典型形状：**夹具与生产共用同一个错误常量时，
用例证明不了任何东西**。

**同一族的第二处，顺手一起接**：§2.2 的发布临界区。`clearStalePublishSections` 的
两条用例从写出来那天就是绿的，而它自己的文档写明了后果——「崩在发布中途的 daemon
把标记留在那里，此后该 MR 的每个事件都只能登记 `pending_revision`，工作项永不再
动」——却零调用方，所以那个**静默永久停摆**在生产里一直可达。已接进 `cli/start.ts`，
且必须排在 `resumeSupersedingWorkItems` **之前**（那之后可能已有活轮次进了临界区，
再清就是把别人正持有的锁清掉）；补了一条带顺序断言的接线锁。这与 lease 那三行是
同一个形状：**用例覆盖的是函数，接线是另一件事，而缺失的接线永远不报错**。

同时做了一次**全模块不可达面盘点**（61 个函数生产不可达、6 个 `.ts` 零导入，逐条
对账过「功能缺失」还是「同功能另有实现」），结论与可复跑的扫描方法见
`unreachable-surface-audit.md`。

### 2ter.8 §11 的三条运维措施全部零调用方（已修）+ readiness 陈旧（已修）

「两半都对、没接上」的最后一批，四处都是**产品承诺在生产里根本不存在**：

| 面                     | 缺的那一半                                                                                                  | 现在                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| AC-35 单条可更新总览   | **我先前的判断是错的**——见下方勘误                                                                          | 无生产改动（只补了 `parsePrevious` 这缺失的一半）                                                   |
| §11.1 噪音上限         | `notificationsSpent` 无人赋值，`say()` 永远判「已花 0」，上限从未生效一次                                   | 口径 = **MR 上平台自己的评论数**（建一条 = 一次通知，编辑不通知）；`say` 给正文打不可见标记以便计数 |
| §11.2 T59 人工指令回执 | `answer` 零调用方，没人收到过回执                                                                           | issue 打标签入口建回执，路由结果与轮次终局在**同一条**上更新                                        |
| readiness 陈旧         | `forRepo` 逐字读存储值，唯一写点是 enable；`dependencyRevision` 硬编码 1；`readinessInvalidation.ts` 零导入 | **读时推导**——结构上不可能陈旧                                                                      |

**AC-35 勘误（e2e 当场打脸，值得写下来）**：我按「`updateSummary` 零调用方」判定「MR 上
从未出现过总览」，接上后 `rfc304-review-reconcile` 立刻红——`POST /notes` 从 1 变 3。
真相是 **mr-review 早就在维护一条总览评论**，走它自己的 `<!-- aw-review-overview -->`
标记与 `publishReview.renderOverview`，建一次、之后编辑，AC-35 的承诺**已经兑现**。我加
的是**第二条**互相竞争的总览——正是本节要防的噪音，由「修复」亲手制造。已整体回退
（`announceRound.ts` 与其用例删除，`summaryLineFor` 一并删掉，免得再多一个零调用方的
导出）；`parseSummary` 保留，它修的是另一个真实缺陷（`updateSummary` 要调用方自带
解析器，而全仓唯一的实现是返回 `[]` 的测试桩）。

**判据沉淀**：「某个函数零调用方」**不等于**「这个产品承诺没兑现」——同一件事完全可能
由另一条路径、另一个标记实现着。下判断前先问「这个承诺在产品面上到底有没有发生」，而
不是只 grep 一个符号。这次是 e2e 在推上去之前拦住的：只有真实事件走完整条链才会暴露。

**真正的残留缺口（比先前记载窄得多）**：总览只覆盖 `mr-review`，另外四条能力
（ci-fix / mr-comment-fix / requirement / mr-monitor）不参与。要让它们也进这条总览，得把
mr-review 的总览统一到 `mrVoice.updateSummary` 上，那会动到 review 总览的正文契约
（e2e 断言里的 `still open` 等），是一次独立重构，未做。

两处**刻意收窄**，都写在代码注释里：

1. **回执入口只开给 `issue-label`**，不开给评论。`mr-comment-fix` 对 MR 上**任何** note
   都醒，逐条回执就会在人类对话的每一行下面挂一条机器回复——正是 §11.1 要防的 feed，由
   本该帮忙的规则亲手制造。该能力本来就自己说话（declined 有解释、applied 有改动）。要
   再收窄到「真的 @ 了平台」需要 mention 检测，仓内没有，猜一个只是把同样的越界换个地方。
2. **readiness 选读时推导而非写时失效**：写时失效要在每条变更路径上接（删 agent / 删
   binding / 删 framework / 删 trigger），漏一条就是同一个 bug 换入口，且没有编译期保障。
   `readinessInvalidation.ts` 因此变成冗余，**保留未删**以便随时回退。

一个测试写法的坑（自己踩、当场修）：这两组用例最初用 `mock.module` 换掉 codeHostAdapter，
**bun 的 module registry 是进程级的**，而 backend 分片一个进程跑很多文件——于是十四条
毫不相干的 wire-format 用例集体转红。改成**按参数注入端口**。已进 `docs/dev-gotchas.md`。

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
