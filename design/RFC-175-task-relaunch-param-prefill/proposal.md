# RFC-175 任务「再次启动」全参数预填（Relaunch with pre-filled params）—— proposal

## 1. 背景与问题

RFC-165 给任务详情页加了终态任务的「再次启动」按钮（`tasks.detail.tsx`，`data-testid="task-detail-relaunch"`），但当时明确只做 **v1「只预填主体」**（`design/RFC-165-unified-task-creation/design.md:102`「再次启动按 kind 深链（v1 只预填主体）」）：

- **工作流任务**：深链带 `{ kind: 'workflow', workflow: workflowId }`。
- **单代理任务**：深链带 `{ kind: 'agent', agent: sourceAgentName }`。
- **工作组任务**：只带 `{ kind: 'workgroup' }`——**连工作组名都没带**，落到一个几乎空白的向导。

工作组之所以最惨，是数据形状导致的「作用域省略」：向导的工作组深链是**按名**键控（`/tasks/new?workgroup=<name>`），而任务详情 DTO（`TaskSchema`）只有 `workgroupId` 没有 `workgroupName`（`workgroupName` 只在**列表** `TaskSummarySchema` 上，`packages/shared/src/schemas/task.ts:275`）。同步 `<Link>` 只能拿 `tk` 上的字段，没有名字可传，于是只传了 kind。

用户反馈：**「工作组任务的再次启动需要按当前任务默认填任务参数，不能只是新建一个空任务」**。即：再次启动应把**当前任务的全部启动参数**作为默认值回填到向导（工作组名 / goal / 执行空间 + 仓库 / 任务名 / 协作者 / git 身份 / 工作分支 / 自动提交推送 / 资源限额……），而不是丢给用户一张空表单从头再填一遍。

**范围与机制两项已由用户 2026-07-13 拍板**：
- **范围＝三种任务统一都改**（单代理 / 工作流 / 工作组一致，消除「工作组是孤岛」的不对称）。
- **机制＝复用现有持久化数据重建，零 DB migration**（不新增 `launch_payload` 列、不碰启动热路径）。

## 2. 目标

- **G1 全参数预填**：终态任务「再次启动」时，把该任务当初的全部启动参数作为**可编辑默认值**回填进 `/tasks/new` 向导。
- **G2 三 kind 一致**：单代理 / 工作流 / 工作组行为统一，无孤岛。工作组必须能预填工作组名 + goal。
- **G3 重建零 migration + 单点 targeted migration**：主重建路径只读既有列、复用 `payloadToWizardSeed`（`?editScheduled=` 同款）零 migration；**唯 agent 身份忠实闭合加 1 枚 targeted migration `tasks.source_agent_id`**（用户 2026-07-13 拍板 B，§2e）——除此一处，不碰启动写路径。
- **G4 追溯生效（best-effort）**：因为读的是任务既有列，**remote/scratch/local 空间**的历史任务（含本 RFC 之前创建的）都能被 best-effort 重放，免 backfill；**internal 空间 / 中途失败多仓 / workflow upload 输入 / 已改名或复用的主体**降级为**安全缺省**（永不静默错误值，见 design §7），不谎称「全部参数全可重放」。
- **G5 可编辑**：预填是「默认值」不是「锁定值」——用户可在向导里逐字段修改后再启动（这是一次**全新任务**，不是编辑原任务）。
- **G6 安全优先**：预填只产可信真值或安全缺省，**绝不产静默错误值**（错主体 / 越权协作者 / 不可启动空间）；无法忠实且安全重建的字段降级为向导正常空/默认，由既有校验门阻拦非法启动。

## 3. 非目标

- **不做一键克隆 / 后端 relaunch endpoint**：用户要的是「预填后可审阅可改再启动」，不是「立刻复制出一个新任务」。保持 RFC-165 的「深链进向导」哲学。
- **不新增 `launch_payload` 列 / 不做 migration**（用户拍板机制）。逐字节精确重放（含原始凭据 URL、原始字面 ref）**非本 RFC 目标**——预填是可编辑默认值，脱敏 URL / 解析后分支作为默认即可。
- **不做 upload 文件原样回放**（设计门 R1-F5 → R4-F3 收窄）：`kind:'upload'` 输入首启后存成 repo-relative 路径、浏览器不能重建 `File`；再次启动**按当前 workflow def 规范化输入**（清 upload-kind 及一切不合当前 def 的种子值 + 提示、堵静默非法提交），必填 upload 走 `missingRequired` 门让用户重选。**不**引入服务端源任务文件复制机制（独立大工程）。
- **不给 internal（fusion）任务 relaunch**（设计门 R4-F1）：internal 空间任务的 workflow 是 builtin（`assertNotBuiltin` 403），**直接抑制入口**，不做重建。
- **不重建多仓 materialize 中途失败的丢失仓库**（设计门 R2-F4 → R3-F1）：此类任务 `repoCount` 只剩成功前缀且原始数已丢；用结构信号 `failedNodeId==null` **检测 + 加「已确认仓库完整」勾选门**，不对仓库子集静默启动（非 migration 决策项）。
- **即时 relaunch 主体 ABA 闭合；save-as-schedule 主体身份=定时既有 name 定位、整体出范围**（设计门 R1–R8 + 用户拍板）：即时 relaunch——workgroup 用稳定 `workgroupId`（§2b）、**agent 用户拍板加 `source_agent_id` migration**（§2e：captured `selectedAgentId` + `expectedAgentId` + **in-tx name+id 精确重验**闭初检→INSERT TOCTOU）闭合 post-migration 任务（历史任务 best-effort）。**save-as-schedule 的主体身份沿用定时既有 name 定位**（create+fire 端到端，RFC-159 既有；R7 拟的 create-time precondition 经 R8 证为 theater〔fire 仍按 name 重解析〕已撤）——**所有 schedule 皆然、非 RFC-175 引入/回归**；durable-id 定时定位是独立 scheduled-task RFC，**列为可选 follow-up、不并入本 RFC**。
- **不改工作组成员机制**：工作组任务的成员 / leader / 模式**不是**启动参数（启动时从活的工作组资源重新快照，`services/workgroupLaunch.ts`），因此不在预填范围；再次启动仍会在启动时重新派生 roster。
- **不改「从工作组详情页新建任务」**（`workgroups.detail.tsx:400` 的 `workgroup-launch-button`）：那是**全新**启动、无「当前任务」可复制，维持现状（带组名即可）。
- **不动定时任务 `?editScheduled=` 现有行为**（本 RFC 只**抽取共用** seed 应用逻辑，行为不变）。

## 4. 用户故事

- 作为用户，我跑完一个工作组任务后点「再次启动」，向导应已经选好这个工作组、填好 goal、选好仓库和分支、带上我原来的协作者和限额——我只改一两个字段就能再跑一遍，而不是面对空表单。
- 作为用户，我的单代理任务失败了，点「再次启动」应保留我原来的提示词（description）、反问开关、执行空间，让我微调后重试。
- 作为用户，我的工作流任务需要换个输入再跑一次，「再次启动」应把原来的输入值都填好，我只改要改的那个。
- 作为用户，即使某个任务是很早以前（本功能上线前）创建的，「再次启动」也应正常预填——不该因为「老任务没存启动包」而降级成空表单。

## 5. 决策记录（2026-07-13）

用户两问拍板：

- **D1 范围**：三种任务（单代理 / 工作流 / 工作组）统一全参数预填。
- **D2 数据来源 / 机制**：复用现有持久化数据重建，零 migration，无 `launch_payload` 列，不碰启动热路径。**（2026-07-13 用户就 agent ABA 拍板 B，破例加 1 枚 targeted `source_agent_id` migration + 一处 `startAgentTask` 写路径改动 —— 见 §7 与 design §2e；其余重建路径仍守 D2 零 migration。）**

由设计推导、随本 RFC 定稿的从属决策（详见 design.md，设计门可挑战）：

- **D3 种子管线复用**：新增纯函数 `taskToLaunchPayload(task)` 产出与 `scheduled_tasks.launchPayload` **同形**的 payload，直接喂现成 `payloadToWizardSeed`（`lib/task-wizard.ts:219`）。editScheduled 与 relaunch 共用同一 seed 应用逻辑（抽 `applyWizardSeed`）。
- **D4 后端两枚派生投影（零 migration）**：`TaskSchema` 增 `workgroupName` + `goal`（均 nullable optional），`rowToTask` 从 `row.workgroupConfigJson` 派生（`frozenWorkgroupName` 已存 + 新增对称 `frozenWorkgroupGoal`）。detail 端点已是任务成员 ACL 门控，与 room 端点已暴露 goal 一致，无新泄漏面。
- **D5 agent `allowClarify` 前端推断**：不落后端字段——从 detail DTO 已下发的 `workflowSnapshot` 用纯 oracle `snapshotAllowsClarify` 推断（存在 `kind:'clarify'` 节点 ⟺ true）。
- **D6 入口＝`/tasks/new?relaunchFrom=<taskId>`**（镜像 `?editScheduled=`）。任务详情 relaunch `<Link>` 与「无 worktree 无法 resume」兜底 `<Link>` 一并切换；**不设 isEdit**（主行动仍是「启动」），kind 不锁。
- **D7 保真度取舍（可接受，设计门 R1 收窄）**：仓库 URL 按 RFC-024 脱敏、ref 用解析后 `baseBranch`、`allowClarify` 三态（不可解析缺省 true）——均可编辑默认值。**协作者 kind 相关**（R1-F2）：agent/workflow 忠实预填显式集；**workgroup 不预填**（存量并集含自动并入 human 成员、无 provenance，回填会越权授旧成员，改由启动按当前 roster 重派）。**主体身份**（R1-F1）：workgroup 用 `workgroupId` 守卫（不一致不 pre-select），agent 按名 pre-select。**空间四态**（R1-F4）：local repoUrl 空 / internal / 中途失败多仓 → 空间降级为向导缺省。
- **D8 任务名**：默认 verbatim 复制原任务名（再次启动语义即「再跑一遍」；用户可改）。

## 6. 验收标准

- **AC1**：终态工作组任务点「再次启动」→ 向导预选该工作组（当前同名组 id 与任务 `workgroupId` 一致时）、填好 goal、执行空间/仓库/分支/limits 回填；不再是空表单。**工作组不预填协作者**（最小权限，启动按当前 roster 重派 human 成员）。
- **AC2**：单代理任务「再次启动」→ 预填 description（提示词）+ allowClarify（三态、缺省 true）+ 执行空间 + advanced（含协作者）。
- **AC3**：工作流任务「再次启动」→ 预填 inputs（**按当前 workflow def 规范化**：清 upload-kind 及不合当前 def 的值〔含 enum 不在 choices 等〕+ 提示、**堵静默非法提交**）+ 执行空间 + advanced；必填 upload 由 `missingRequired` 门要求重选。
- **AC4**：历史任务「再次启动」——remote/scratch/local best-effort 完整预填；**internal（fusion）任务无 relaunch 入口**；多仓 materialize partial（`failedNodeId==null`）加确认门；输入按当前 def 规范化，**不产静默错误值**。
- **AC5**：再次启动落地的是**全新任务**（新 task id）；kind 未锁、可改；未污染 `?editScheduled=` 的编辑语义。
- **AC6**：**主体身份与 ACL 安全**——workgroup id 守卫 + **captured `selectedWorkgroupId`**（后台刷新替身仍 409、显式改选放行）+ 服务端 `expectedWorkgroupId`（ACL-404 后比对）；agent 按 `agentsQ` pre-select；协作者集=`[owner,...users]−launcher`（含原 owner）、workgroup 不预填、**kind 切换清协作者**；`relaunchPhase` barrier 含 actor+全清单、每条 query 有 error/retry（不永挂）、applied 拒晚到；已删 404 / 不可见 403 / 网络 报错禁提交；多仓失败确认门。
- **AC7**：重建路径**零 migration**；**唯 §2e agent 身份加 1 枚 targeted migration**（`tasks.source_agent_id`，用户拍板 B）+ `startAgentTask` 落库 `sourceAgentId`（**唯一启动写路径改动**）。`TaskSchema` +3 optional（`workgroupName`/`goal`/`sourceAgentId`）+ 三启动 schema 各 +1 optional 守卫参（`expectedWorkgroupId`/`expectedWorkflowVersion`/`expectedAgentId`）——均向后兼容、缺省=现状。**三守卫是即时提交 OCC overlay、不进 `buildImmediateBody`/定时任务**（R6-F1），定时 payload schema 拒收。migration journal bump 同步改 `upgrade-rolling.test.ts`、号与 RFC-170 协调。
- **AC8**：测试全绿——`taskToLaunchPayload`（四 spaceKind）/ `snapshotClarifyState`（三态）纯函数逐字段覆盖 + round-trip（→`payloadToWizardSeed`）+ 后端 rowToTask 派生 + 向导双查询状态机/协作者 kind 相关/主体守卫/upload 清理集成 + 工作组 relaunch 不再传裸 `{kind:'workgroup'}` 的源码锁 + editScheduled 回归。`typecheck && lint && test && format:check` + build smoke + CI 全绿。

## 7. 开放问题

- **落步 UX**：再次启动落在 STEP_MODE（从头审阅、frontier 全开，镜像 editScheduled）还是直接落 STEP_CONFIRM（一键重跑、可回跳）？design.md §4.6 暂定 STEP_MODE + frontier=CONFIRM（更安全，兼容 seed 部分降级的情形，如脱敏 URL / 空间不可解析 / 主体已变）；设计门可挑战。
- **工作组聊天室入口**：工作组任务的主视图若是 room 而非 tasks.detail，是否在 room 也加一枚指向同 `?relaunchFrom=` 的入口？design.md §5 评估后默认沿用 tasks.detail 通用入口，room 入口列为可选增量。
- **✅ agent ABA 残留——用户 2026-07-13 拍板「加 migration 忠实闭合」（B）**：`tasks` 持久化 `source_agent_id`（§2e）、`startAgentTask` 落库 `agent.id`、relaunch 携 `expectedAgentId` 服务端 ACL-404 后比对（删+同名重建→409）。**这是对 D2「零 migration / 不碰启动写路径」的一处有意破例**（用户认为该边界值得）：**post-migration agent 任务闭合**；migration 前的**历史 agent 任务**仍 best-effort 按名（`sourceAgentId=NULL`、**不 backfill** 以免 stamp 错 id）——与用户「只护未来、不 backfill 历史」认知一致。**至此设计门 findings 与用户决策均已消解，无待定项。**
  - （设计门收敛记录：R2「多仓中途失败」→R3-F1 `failedNodeId==null` 结构检测 + 确认门；R3「upload provenance」→R4-F3 证为可修 bug〔规范化输入〕；R4-F1 internal fusion→抑制入口；R5「version 竞态」→`expectedWorkflowVersion`；R6「OCC 泄漏定时」→即时 overlay 隔离；agent ABA→用户拍板 migration 闭合。）
