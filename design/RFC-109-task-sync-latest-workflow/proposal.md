# RFC-109 — 任务工作流热同步（Sync Latest Workflow & Continue）

> 状态：Draft（待用户批准进入实现）
> 触发：2026-06-26 用户「给任务增加一个功能，可以把关联的最新的工作流同步过来，然后按照最新工作流继续运行」。
> 调研：回源核实任务↔工作流的数据耦合（`tasks.workflowSnapshot` 冻结快照 vs 实时 `workflows.definition`）+ 调度引擎对拓扑变化的容忍度 + resume/CAS 生命周期，证据 file:line 见 `design.md §1`。

## 1. 背景

平台启动任务时，把工作流定义**冻结**成快照写进 `tasks.workflow_snapshot`（`schema.ts:411`，注释明确 "Holds workflow snapshot for replay safety"）。调度器**只读这份冻结快照**重建 DAG（`scheduler.ts:301` 每次 `runTask()` 入口无条件 `JSON.parse(task.workflowSnapshot)`），从不回读实时 `workflows.definition`。任务行另有 `workflow_id` 外键指向实时工作流（其 `version` 列每次 PUT 自增 `schema.ts:319`），但**两者之间没有任何「把实时定义带回任务」的通路**。

这带来一个真实痛点：**工作流是活的、任务是死的**。用户在编辑器里持续改进工作流（修 prompt、加节点、调参数），但任何**已经启动**的任务都永远停留在它启动那一刻的定义上。今天唯一「用上新定义」的办法是**从头重启一个新任务**——而这会丢掉之前所有已完成节点的产出（可能是数小时的 agent 工作 + LLM 成本）。

由此引出几个高频且当前无解的场景：

- **杀手用例（修 prompt 后续跑）**：某节点因 prompt 写错而 `failed`。用户在编辑器把 prompt 改好。今天点「重试」（`retryNode`）用的仍是**旧冻结快照里的旧 prompt**（`retryNode` 在 `task.ts:1272` 重读的是 `task.workflowSnapshot`，不是实时工作流）——修复带不进来，只能整个重启、丢掉前面所有成功节点。
- **完成后追加步骤**：任务跑完（`done`），用户事后想加一个「审计」下游节点。今天只能重启整条流水线重跑一遍。
- **中断期间工作流升级**：daemon 重启把 90% 完成的任务翻成 `interrupted`；与此同时另一人改进了工作流。用户希望「拉取最新 + 从断点续跑」，而不是二选一。

**引擎其实早就准备好了**（`design.md §1` 证据）：调度器每个 `runTask()` 入口重新解析快照、对拓扑变化高度健壮——新节点（无 node_run）上游完成即派发（`dispatchFrontier.ts:303` `row===undefined → dispatchable`）；被删节点的历史 node_run 行被静默跳过（`scheduler.ts:1209` `!scopeIds.has(r.nodeId) → continue`）；边/端口实时从定义读取（`scheduler.ts:4856` `buildScopeUpstreams`）。**缺的只是一条「把实时工作流定义原子写回任务快照、再 resume」的受控通路**——这正是本 RFC 要补的那条线。

## 2. 目标 / 非目标

### 2.1 目标（v1）

1. **一键热同步**：在任务详情页提供「同步最新工作流并继续」能力——把任务关联工作流的**当前定义**原子写回该任务的 `workflow_snapshot`，记录新版本号，然后从断点**按新定义续跑**。
2. **覆盖全部非活跃状态**（决策 D1）：`failed / interrupted / done / canceled / awaiting_review / awaiting_human` 六种状态均可同步续跑。`running / pending` 因调度器正持有快照，**拒绝**同步（须先取消或等其停下）。
3. **保留已完成产出**（决策 D2）：只有**新增节点**与**尚未终态**的节点按新定义执行；已成功完成的节点保留旧产出喂给下游。要让被改动的已完成节点重跑，对它单独点「重试」（重试天然用新快照）。非破坏、可预期。
4. **应用前预览 + 确认**（决策 D3）：同步前弹窗展示版本号变化（v3 → v7）、新增/删除/修改的节点清单，并对「删除/改名的端口正喂给已完成节点」等**会静默丢数据**的结构性变更给出警告，用户确认后再应用。
5. **复用既有机制、不 fork**（决策 D5）：同步 = `resume` 前面加一步「原子换快照」。抽出 `resume` 的「CAS 所有权锁 + 回滚 + 拉起调度器」核心给两者共用；换快照走 `setTaskStatus` 的 `extra` 白名单与状态翻转**同事务原子完成**（决策 D6）。
6. **完整安全闸**：built-in 工作流禁同步（RFC-104）；同步者须可见该工作流（RFC-099）；并发 sync/resume 经 CAS 恰一胜；工作流被删 / 当前定义校验不过 / worktree 缺失均给干净错误。

### 2.2 非目标（本 RFC 不做 / 推后续）

- **不重跑「被改动的已完成节点」**（D2 的反面）：v1 保留已完成产出；按节点 diff 自动作废并级联重跑是更大的功能（需可靠节点级 diff + 更复杂回滚），推 v2。用户要重跑可对单节点点「重试」。
- **不消除端口改名的静默丢数据**：引擎在端口改名时让下游读到空串是既有行为（`scheduler.ts:4516` `port?.content ?? ''`）。v1 只在预览里**警告**这类风险，不做自动端口迁移 / 阻断。
- **不做工作流版本回退 / 任意版本选择**：v1 只同步到**当前最新**定义，不提供「同步到历史某版本」。（工作流本身无版本历史表，仅 `version` 计数；历史快照不可取。）
- **不改快照之外的任务参数**：仓库 / worktree / 基线分支 / git 身份 / 限额等启动期参数不随同步变化；只换 `workflow_snapshot` + `workflow_version`。
- **不触碰 running/pending 任务**：不做「热替换正在跑的任务的快照」；活跃任务必须先停。
- **不与 RFC-108 抢生命周期重构**：本 RFC 在现有 `setTaskStatus`（RFC-097 CAS + allowedFrom + allowTerminal）之上最小落地，不引入 RFC-108 草拟的 `nextTaskStatus` 转移表；两者邻接点见 `design.md §5`，落地顺序由先合并者承接。

## 3. 用户故事

1. **作为修了 prompt 的用户**：某节点因 prompt 有误 `failed`。我在工作流编辑器把 prompt 改好回到任务页，看到「工作流有更新（v4 → v5）」横幅，点「同步并继续」，预览确认只有这一个节点的 prompt 变了，应用后失败节点用**新 prompt** 重跑、下游照常推进——**不丢**前面已完成的工作。
2. **作为完成后追加步骤的用户**：任务已 `done`。我在编辑器给末尾加了一个「安全审计」节点保存。回到任务页同步，引擎只跑这个**新增**节点（上游产出已在），跑完任务重新收尾——而不是把整条流水线重跑一遍。
3. **作为续跑被中断任务的用户**：daemon 重启把我的任务翻成 `interrupted`；期间工作流被改进。我同步最新定义后从断点继续，一举既拿到改进又不重头来过。
4. **作为谨慎的用户**：同步前我能在预览里看到「删除了节点 X（它的产出原本喂给已完成节点 Y）」这类警告，明白可能有下游读到空输入的风险，再决定是否应用。
5. **作为协作者**：我是任务成员但不是工作流 owner；只要我**能看见**这个工作流（RFC-099），就能触发同步；看不见则任务页不出现同步入口。
6. **作为 built-in 资源用户**：内置融合工作流（aw-skill-fusion）的任务不提供同步入口（RFC-104 只读）。

## 4. 验收标准

> 每条都须带测试（先红后绿）；运行门槛 `bun run typecheck && bun run test && bun run format:check` 全绿 + CI（含 binary smoke + e2e）；按 [feedback_post_commit_ci_check] push 后查 CI。

**核心机制**
- AC-1：`syncTaskWorkflow(db, id, deps)` 把 `task.workflow_snapshot` 原子替换为关联工作流的**当前 `definition`**、并写入 `workflow_version = workflows.version`，**与状态翻转 `→ pending` 在同一 CAS 内完成**（CAS 失败则快照不被改写）。
- AC-2：同步后调度器重读新快照续跑：**新增节点**（无 node_run）上游完成即派发；**被改动的已完成节点**（D2）保留旧产出、**不**重跑；**failed/interrupted 节点**按 resume 语义回滚 `pre_snapshot` 后用**新定义**重跑（覆盖「修 prompt 后续跑」杀手用例）。
- AC-3：可从 `failed / interrupted / done / canceled / awaiting_review / awaiting_human` 六种状态同步（D1）；从 `running / pending` 同步抛 `task-not-syncable`（409，零副作用）。

**预览（D3）**
- AC-4：`GET /api/tasks/:id/workflow-sync-preview` 返回 `currentVersion`（任务快照版本，legacy 为 null）/ `latestVersion` / `differs`（按**定义内容**而非仅版本号比较）/ 新增·删除·修改节点清单 / 结构性警告 / `invalid`（当前工作流静态校验不过时为 true，附 issues）。
- AC-5：纯函数 `diffWorkflowForSync(oldDef, newDef, runSummary)` 正确分类 added/removed/modified（按 nodeId），并产出警告：①删除了「有已完成 node_run」且其产出仍被新图下游引用的节点；②新图中喂给「尚未完成节点」的边其 source 端口在上游声明输出里不存在（将解析为空输入）。定义字节等价时 `differs=false`、清单与警告全空。

**安全闸**
- AC-6：built-in 工作流的任务同步被 `assertTaskWorkflowNotBuiltin` 拒（403，复用 RFC-104）。
- AC-7：同步者对该工作流不可见时（RFC-099 `requireResourceView`）路由 403；任务非成员经既有 `visibilityCheck` 中间件 404/403。
- AC-8：关联工作流已删除 → `workflow-deleted`（409/404）；当前工作流静态校验有 error → `workflow-invalid`（422，复用 `validateWorkflowDef`）。
- AC-9：并发 `syncTaskWorkflow` 与 `resumeTask`（或两次 sync）经 `setTaskStatus` CAS 恰一胜，输者 409 且零副作用（不双写快照、不双拉调度器）。
- AC-10：`worktree_path === ''`（worktree 已被 GC）→ 同步给干净错误而非 500（前端入口亦按 `worktreePath !== ''` 隐藏）。

**生命周期白名单**
- AC-11：`TaskStatusUpdateExtra` 扩展允许 `workflow_snapshot` + `workflow_version` 随状态翻转写入；`status` 仍不可经 `extra` 走私（既有 s14 守卫不被削弱）；`allowTerminal` 注释把 syncTaskWorkflow 登记为第 5 个持有者。

**数据模型**
- AC-12：migration 0050 给 `tasks` 加 `workflow_version INTEGER`（nullable，legacy NULL）；`startTask` 落库时写入 `workflows.version`；升级滚动测试（upgrade-rolling）journal 加一档。

**前端**
- AC-13：任务详情页在非活跃可同步状态且工作流定义已变（`differs`）时显示「工作流有更新（vN→vM）」横幅（复用 `task-error-banner` 样式族），点开 `WorkflowSyncDialog` 展示节点 diff + 警告 + 版本号，确认后 `POST sync-workflow` 并失效相关 query；活跃 / 定义未变 / worktree 缺失 / 工作流不可见时不显示。组件全复用公共原语（`Dialog` / `.btn` / chips / `DiffViewer` 或同款），i18n 中英对称，做视觉对齐自查。

## 5. 决策登记

- **D1（可同步状态）= 全部非活跃状态**：`failed/interrupted/done/canceled/awaiting_review/awaiting_human` 均可同步。`running/pending` 拒绝（调度器持锁）。理由：用户明确要「最灵活」；引擎对各状态续跑均有既有支撑（resume 覆盖 failed/interrupted/awaiting_*；RFC-095 令 canceled node_run 可复活；done 经 `allowTerminal` 放行后新增节点自然派发）。
- **D2（已完成且被改动的节点）= 保留 fresh 的已完成产出**（Codex F1 精化）：只跑新增 + 未终态节点；已完成节点中 **fresh** 的保留旧产出，**stale 的**（其消费过的上游重跑了）按引擎既有 freshness **自动级联重跑**（正确行为，非违例）。改动后但仍 fresh 的已完成节点不自动重跑，需重跑则单独「重试」。新图给已完成节点**新增上游边**则静默保留（不纳入新上游）——预览警告。理由：用户选「非破坏、可预期」；与引擎 RFC-074 消费溯源行为一致，无需脆弱的节点级 diff。
- **D3（应用前）= 预览 + 确认**：弹窗展示版本号 + 节点 diff + 静默丢数据**警告** + 结构性变更**阻断**，确认后再应用。理由：用户选此项；契合本仓谨慎 UX 与「端口改名 / wrapper 结构变更静默丢数据」这一真实风险。
- **D4（版本可见性）= 新增 `tasks.workflow_version` 列**：理由：预览要展示「v3 → v7」必须知道任务**快照自哪个版本**，而该信息此前不落库（任务只存 `workflow_id` + 冻结快照）。加一个 nullable 整型列（migration 0050）最干净；legacy NULL 显示为「未知 → v7」。
- **D5（实现姿态）= 抽 resume 核心共用、不 fork**：把 `resumeTask` 的「active 检查 + 状态闸 + CAS 所有权锁 + 回滚 + 拉起 runTask」抽成内部 `resumeKick(event, extra, rollbackStatuses, ...)`，`resumeTask` 与 `syncTaskWorkflow` 各传参复用。理由：CLAUDE.md「抽一次别 fork」；避免回滚/CAS/拉起三段逻辑双份漂移。
- **D6（原子换快照）= 走 `setTaskStatus`/事件式 wrapper 的 `extra` 白名单**：把 `workflow_snapshot`/`workflow_version` 纳入 `TaskStatusUpdateExtra`，随 `→ pending` 的 CAS 同事务写入。理由：CAS（`WHERE id AND status=from`）天然原子；输掉所有权竞争时快照不被改写，避免「换了快照却没拿到调度权」的中间态。
- **D7（ACL）= 同步者可见工作流即可（引用闭包隐式授权）**：路由 `requireResourceView(workflow)`（不可见 404 防探测）；不逐一校验新定义引入的 agent/skill 引用。理由：对齐启动语义（RFC-099 D3「启动任务只校验工作流本身可用，引用闭包隐式授权」）——同步本质是「以新图再启动」。
- **D8（与 RFC-108 集成）= 扩展其已落 HEAD 的转移表**（Codex F6 修订）：RFC-108 T1/T2 的 `nextTaskStatus` 事件转移表已在 HEAD（`shared/lifecycle.ts:186`）。本 RFC 在其 ADT 加一个 `{ kind: 'sync-workflow' }` 事件（allowed-from = 全部 6 非活跃态 = resume∪retry，`never` 穷举强制补全），CAS 走既有事件式 wrapper `transitionTaskStatusByEvent`——**按其 SSOT 扩展、非绕开**。改动最小加性（一个事件 + 两个 extra 字段 + 一个 rollbackStatuses 参数），降低与 RFC-108 后续 PR 的碰撞面。

> **Codex 设计 gate fold（2026-06-26，落码前）**：三件套经 Codex 设计 gate 核读源码后 8 条 findings 全采纳，修订见 `design.md §9`：F1（D2 精化为 done∧fresh）/ F2（端口警告基于保留 run 实际产出而非声明）/ F3（wrapper/fanout 结构变更 + live 行 → **阻断**而非警告）/ F4（canceled 须先回滚写节点再复活）/ F5（preview→apply 版本 TOCTOU → `expectedVersion` 闸）/ F6（集成 RFC-108 转移表，见 D8）/ F7（同定义短路免状态 churn）/ F8（ACL 404 非 403）。
