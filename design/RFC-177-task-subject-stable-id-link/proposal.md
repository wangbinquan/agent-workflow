# RFC-177 — 任务主体链接按稳定 id 解析（消除改名+复用误识别）

状态：Draft（待 Codex 设计门 + 用户批准）

## 背景

RFC-164 follow-up（commit `6907d6ef`）把任务列表 / 详情页的「执行主体」从泄漏内部
锚点工作流（`__workgroup_host__` / `__agent_host__`）改为链接到真正的所属资源：
工作组 → `/workgroups/$name`、单代理 → `/agents/$name`（公共组件
`components/TaskSubjectLink.tsx`，列表 cell + 详情页头部/元信息三处共用）。

该实现用任务**冻结的名字**（`workgroupName` / `sourceAgentName`）既作链接文案、又作
链接目标。Codex 复核（2026-07-13，隔离 worktree 审 `6907d6ef`）指出一条 **P2**：

> 工作组被重命名、或终态 agent 被改名/删除后，任务保留旧的
> `workgroupName`/`sourceAgentName`，而该名字之后可能被**另一个**资源复用。这些
> 链接届时会打开那个无关的替代资源、而不是仅仅 404，从而**错误标识**任务的执行主体。

即：`/workgroups/:name` 与 `/agents/:name` 都是**按名**寻址，而名字在改名/删除后可被
复用（工作组 / 代理均有 `/rename` 端点，名字唯一约束在删除/改名后释放）。冻结名会
在「改名 + 旧名被复用」的罕见情形下把用户导向**同名的错误资源**。

用户 2026-07-13 拍板：**真修这条 P2，采用「按稳定 id 链接」策略**（而非退化为纯文本、
也非后端读时校验——后者会回退 RFC-099「冻结名不 live-join」不变量）。

## 地基现状（RFC-175 已铺）

本 RFC **无需新 migration**，因为两个稳定 id 都已在任务负载里：

- **工作组**：任务恒冻结 `workgroupId`（稳定 ULID，`tasks.workgroup_id`，详情
  `TaskSchema` + `TaskSummary` 均有）——追溯全覆盖。
- **单代理**：RFC-175 已加 `tasks.source_agent_id`（`schema.ts:852`）+ 启动时冻结
  （`startAgentTask`，`services/task.ts:1215`）+ 详情 `TaskSchema.sourceAgentId`
  （`services/task.ts:3043` 已投影）+ 进程内引用计数 reservation 防 ABA。**不
  backfill** ⇒ 历史 agent 任务 `sourceAgentId = NULL`。

缺口仅在链接**用了名字而非 id**，外加列表投影 `TaskSummary` 尚缺 `sourceAgentId`。

## 目标

1. 任务主体链接**按稳定 id 解析**到当前资源：资源改名后仍指向**同一个**资源（跳到其
   当前规范 URL），彻底消除「旧名被复用 → 打开错误资源」的误识别。
2. 保持 RFC-099 **ACL-冻结名不变量**：任务负载不因本改动携带任何 live 资源状态；链接
   **文案仍是冻结名**（与聊天室一致），不向无可见权的协作者泄漏改名后的当前名。
3. 列表页 + 详情页行为一致（共用 `TaskSubjectLink`，单点改动）。
4. 无新 migration；单 PR。

## 非目标

- 不改「工作流」主体的链接（`/workflows/$id` 本就按 id，无此问题）。
- 不回填历史 agent 任务的 `source_agent_id`（RFC-175 的既定决策；历史行按 §设计的
  降级策略处理）。
- 不改聊天室 / 详情页对冻结名的**文案**展示（仍显示冻结名）。
- 不引入按查看者可见权动态解析当前名的后端投影（那是被否决的 Option 3，回退 ACL 不变量）。

## 用户故事

- 作为用户，我把工作组 `design-crew` 改名为 `design-crew-v2`，又新建了一个叫
  `design-crew` 的工作组。此前那个跑过任务的详情页里点「design-crew」链接——**现在
  跳到的是原来那个组（v2）**，而不是同名的新组。
- 作为用户，一个跑过的单代理任务，其代理后来被删、名字被别的代理复用——点主体链接**不
  会**打开那个无关的新代理。
- 作为无工作组可见权的任务协作者，我在任务里看到的主体名仍是启动时的冻结名（不因别人
  改名而变），点击进去若我无权则 404（与现状一致）。

## 验收标准

1. 工作组任务主体链接经 `workgroupId` 解析：组改名后点击落到该组当前规范页
   `/workgroups/<currentName>`；组已删/不可见 → not-found 态（与现状同形）。
2. 单代理任务（`sourceAgentId` 非空）主体链接经 id 解析，改名后落到 `/agents/<currentName>`。
3. 历史单代理任务（`sourceAgentId = NULL`）按 §设计 D3 的降级策略渲染，且**不 5xx、不误识别**。
4. 链接**文案**在所有情形下仍是冻结名（`workgroupName` / `sourceAgentName`）。
5. 列表页与详情页表现一致；`TaskSummary` 携带 `sourceAgentId`。
6. 任务负载（list / detail）不新增任何 live 资源字段（ACL 不变量守住）。
7. 五门全绿（typecheck / lint / 前端 vitest / 后端 bun test / format），零新 migration。

## 决策点（设计门 / 用户可调）

- **D1 — id 解析机制**：新增按 id 的**后端解析端点** + **前端 by-id 路由**（解析后重定向到
  规范名页）。备选：前端扫 ACL 过滤后的列表自解析（零后端）。推荐前者（O(1)、语义清晰）。
- **D2 — 链接文案**：冻结名（ACL 安全、与聊天室一致）。**不**用当前名（会回退 ACL 不变量）。
- **D3 — 历史 agent（`sourceAgentId=NULL`）降级**：(a) 回退到冻结**名**链接（与 `6907d6ef`
  现状一致、仅历史行保留罕见复用风险）/ (b) 纯文本无链接（最安全、但历史行失去链接）。
  推荐 **(a)**（对历史行零回归；新任务已 id-正确）。
- **D4 — 资源已删但 id 仍在**（工作组恒有 id；agent 新任务有 id）：链接照渲染（按 id），点击
  经解析端点得 404 → not-found 态。渲染期不做 lookup（守 ACL 不变量）。
