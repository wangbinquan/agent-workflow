# RFC-337 — 数字员工任务详情的信息架构与交付可见性

- 状态：Implemented / Publication In Progress（用户已批准 D1–D7，2026-08-28）
- 发起：用户，2026-08-28
- source pin：`234cfb2307602ced40bfb3279843843d6818997a`
- 前置：RFC-310（数字员工操作系统）、RFC-294（后台目标架构）

## 0. 终态一句话

数字员工任务详情不再把“创建任务时可选择的三个入口”当成运行中操作；它只显示这个 Case
已经收到的唯一真实输入，并用“概览 / 详细信息 / 产物 / 执行记录 / 关注与协作”五个页签，持续展示
仓库、分支、冻结参数、修改候选和当前 MR；一旦 MR 创建成功，页头、职责 2 和三个 MR 工作项都能直达同一个 MR。

```text
Case 冻结输入 ──> 唯一绿色输入卡 ──点击──> 当前任务真实输入
                      │
                      ├── 概览：输入 / 仓库 / 目标分支 / 当前 MR / 职责图
                      ├── 详细信息：全部任务参数 / Context 技术记录
                      ├── 产物：修改候选 / MR / artifact refs
                      ├── 执行记录：每轮时间轴 / 输入输出 / Session
                      └── 关注与协作：Attention / 事件队列 / 委托

MR Context.webUrl ──> 页头 + 职责 2 + 提交 MR + 关注 MR + 判断可合入
```

## 1. 当前实现与问题

### 1.1 运行态误用了配置入口

`employee-cases.$caseId.tsx` 把共享 `EmployeeCapabilityPanorama` 直接用于 Case 运行态，并给
`onConfigureIngress` 接上 `/tasks/new` 与 Event Center。`projectWorkIngresses()` 又把任务创建入口拆成
正文/文件、外部编号和 issue 事件三张卡。因此任务已经创建后，职责图仍像“创建前配置器”；点击输入卡
还会离开当前任务，而不是解释本 Case 实际收到了什么。

真实输入并未丢失：`development.issue-handling` Context 已保存 `request.kind/body/externalId/uploads/
executionOptions` 和 `repositoryRef`，Case 也保存 `launchOrigin`。缺口是运行态投影与交互语义。

### 1.2 关键参数存在，但没有形成任务详情

当前详情页把 Context 按 `projectionFields` 纵向铺开。研发类型的 issue Context 只投影正文、外部编号和
文件数量，漏掉仓库与执行选项；工作区表已经保存 `repositoryId/baselineSha/targetBranch/sourceBranch/state`，
但 `GET /api/employee-cases/:id` 没有读取这个只读事实。用户因而看不到“在哪个仓、从哪个基线、往哪个
目标分支、使用什么源分支工作”，也缺少一个集中查看任务冻结参数的入口。

### 1.3 MR 合同保存了链接，页面却丢掉了

`development.merge-request` Context 已保存 `mergeRequestRef/providerMrRef/webUrl/sourceBranch/
targetBranch/headSha/readyToMerge/mergeableState/status`。当前类型投影却只显示 MR 编号、head SHA 和是否可合入；
职责图只把运行中的工作项链接到执行 Session。MR 已创建后，页头、职责 2、`publish-mr`、`observe-mr`
和 `evaluate-ready` 都没有可见的 MR 链接。

### 1.4 单列长页面掩盖了主线

职责图、Context、Attention、事件队列、完整执行时间轴和协作区全部纵向挂在同一页，导致首要事实被埋在
长滚动中。工作流任务详情已经使用共享 `PageSectionNav` 按能力分组；数字员工 Case 尚未采用这一信息架构。

## 2. 目标

1. 在 Case 运行态只呈现一个与冻结输入一致的入口卡；卡片恒为“已接收/已完成”绿色状态。
2. 点击该卡只在当前页打开真实输入检查器，不跳转任务创建页或 Event Center。
3. 首屏可看到当前仓库、目标分支、源分支和当前 MR；不要求用户先展开原始 Context JSON。
4. 新增集中“详细信息”页签，完整展示输入、上传文件去向、执行选项、员工/类型/岗位模板修订、Adapter
   绑定、分派配置、仓库/工作区和 Case 时间信息。
5. 新增“产物”页签，展示修改候选、变更路径、MR、各 Context/Reaction Round 的 artifact 引用及对应
   执行 Session。
6. MR 一旦出现，页头、概览、职责 2 标题、提交 MR、关注 MR 状态、判断是否可随时合入和所选工作项详情
   都提供同一条明显的外部链接。
7. 复用工作流任务详情的页签原语和 URL 深链语义，使窄屏、键盘、刷新、前进后退都符合直觉。

## 3. 非目标

- 不改变数字员工的创建表单、事件订阅配置或三类可选输入能力；只纠正“已创建 Case”的运行态呈现。
- 不新增目标分支选择器，也不改变当前以仓库默认分支解析工作区基线的行为。
- 不改变 MR 创建、关注、流水线、审批、冲突修复或合入判断的业务状态机。
- 不复制工作流 TaskEngine 的 NodeRun、worktree 文件浏览或 diff API；数字员工页只展示自身已有的
  Case/Context/Reaction/交付事实，并链接到真实执行 Session/MR。
- 不把 Context 原始 JSON、工作区表或代码平台 SDK 直接暴露给共享职责图组件。
- 不做数据库迁移，不修改历史 Case/Context/MR 数据，不借本 RFC 领取 RFC-294 W2/W5 架构 wave。
- 不引入或调整任何权限、安全或凭据策略。

## 4. 用户可感知行为

### 4.1 页签与首屏

默认进入“概览”，页头下方显示五个页签：

1. **概览**：下一步提示、输入/仓库/目标分支/MR 四个关键事实、实际职责图和所选卡详情；
2. **详细信息**：任务冻结输入、仓库与工作区、执行参数、员工/类型/岗位模板/策略修订、完整 Context；
3. **产物**：修改候选、变更路径、MR 交付卡、去重后的 artifact 引用和来源；
4. **执行记录**：现有 Reaction Round 时间轴、每轮冻结输入/确定性输出和执行 Session；
5. **关注与协作**：Attention、待处理事件和数字员工委托。

URL 使用 `?tab=overview|details|artifacts|execution|activity`。无 `tab` 或旧链接进入 `overview`；未知值也
回退概览。非活动页签不参与页面布局、焦点顺序或读屏顺序，因此不会继续制造长页面。

### 4.2 唯一真实输入

- 手工正文/文件任务显示一张“任务输入”卡；副标题来自正文首个非空行与文件数量。
- 外部编号任务显示一张“外部编号”卡并显示实际 ID。
- 事件触发任务显示一张“事件输入”卡，并显示冻结到 Context 的实际主题/正文/编号。
- API/历史 Case 无法对应旧入口时，也只显示一张“任务输入”兼容卡，绝不退回三个配置入口。
- 卡片为绿色完成态，文案为“已接收”；点击后在职责图下方打开有高度上限、可内部滚动且不截断数据的
  输入检查器，显示正文、外部 ID、原文件名、放置方式、仓内目标路径和执行选项。

创建页和岗位模板编辑页仍显示全部可配置入口，并保留原有跳转行为。

### 4.3 仓库、分支与参数

概览四个事实卡中：

- 仓库优先显示现有 repository catalog 的 `urlRedacted`，同时可查看稳定 `repositoryRef`；查询失败时仍显示 ID。
- 工作区已创建时显示其精确 `targetBranch/sourceBranch/baselineSha`。
- 工作区尚未创建时，目标分支显示仓库当前默认分支并明确标记“计划值”；默认分支也未知时显示
  “工作区准备后确定”，不伪造 `main`。
- MR 已创建时，交付卡显示 MR 编号、状态、源/目标分支、head、合入状态和“查看 MR”按钮；未创建时明确
  显示“尚未创建 MR”。

### 4.4 MR 直达

当 `webUrl` 非空时：

- PageHeader 出现主按钮“查看 MR”；
- 概览交付卡与产物页 MR 卡显示同一链接；
- 职责 2 标题右侧显示“当前 MR”；
- `publish-mr`、`observe-mr`、`evaluate-ready` 卡片各显示独立的外链动作；
- 选择上述工作项后，其合同详情也显示“查看当前 MR”。

这些链接在新标签打开，当前任务详情与已选页签保持不动。共享职责图不硬编码研发工作项 ID；由类型拥有的
只读详情投影声明哪些 region/work item 与当前交付相关。若 MR 只有编号而 `webUrl` 为空，页面显示编号和
“链接尚不可用”，不拼接猜测 URL。

## 5. 待用户确认的裁决

批准本 RFC 即确认：

| ID  | 裁决                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------- |
| D1  | Case 详情固定使用“概览 / 详细信息 / 产物 / 执行记录 / 关注与协作”五个 URL 页签，默认概览。                                |
| D2  | 运行态职责图只显示本 Case 的一个真实输入，恒为绿色已完成；点击在当前页展开完整输入，不再跳创建页/Event Center。           |
| D3  | 首屏展示仓库与分支：工作区值是精确值；工作区未准备时只把 repository default branch 标成“计划值”，未知则如实显示待确定。   |
| D4  | MR 链接同时出现在页头、概览/产物、职责 2、`publish-mr`、`observe-mr`、`evaluate-ready` 及所选工作项详情，并在新标签打开。 |
| D5  | “产物”包含修改候选、变更路径、MR、artifact refs 与关联 Session；不在 Case 页复制完整 worktree/diff/log 浏览器。           |
| D6  | 新增类型拥有、只读且规范化的 Case 详情投影；共享数字员工 route/组件不按 `development` 或工作项 ID 写分支。                |
| D7  | 旧 Case/API-origin/MR 链接缺失都使用单一卡片与明确空态兼容；不迁移数据、不修改任务/MR 执行行为。                          |

## 6. 验收标准

- **AC-1 唯一输入**：body/files/body-and-files/external-id/event/API/legacy fixtures 的 Case 详情在运行态均
  恰好一张 input ingress 卡；页面中不存在“去新建任务/去 Webhook 配置”动作。
- **AC-2 输入真实性**：点击卡片不改变 route/path；检查器逐字段显示冻结 Context 中的正文、外部 ID、
  原文件名、placement、targetPath 与 executionOptions，输入卡为 completed/success 视觉态。
- **AC-3 关键事实**：概览无需展开技术 JSON即可读取 repositoryRef/显示名、target/source branch、baseline SHA
  和 MR 空态/实态；workspace/default/pending 三种 branch authority 文案互不混淆。
- **AC-4 全部参数**：详细信息展示 Case、Employee、Type、Job Template、Execution Policy、执行选项、Adapter
  绑定、分派配置、输入、仓库/工作区及 created/updated；Context 技术记录仍可查看。
- **AC-5 产物**：产物页展示最新修改候选及 changedPaths、当前 MR、去重 artifact refs、来源 Context/Round
  和可用的 execution Session 链接；空态明确。
- **AC-6 MR 精确链接**：给定 `webUrl=https://code.example/repo/merge_requests/42`，所有 D4 表面都使用这一
  精确 href；没有 `webUrl` 时没有伪链接，只有明确状态。
- **AC-7 类型边界**：共享 route/panorama/flow display 不含 `development`、`publish-mr`、`observe-mr`、
  `evaluate-ready` 条件；这些关联由已校验的类型详情投影提供。
- **AC-8 页签**：五个页签支持点击、键盘、刷新、前进后退和直接 URL；非活动 pane 不参与页面高度、焦点和
  可访问树，旧无 tab URL 稳定进入 overview。
- **AC-9 实时更新**：Case 非终态 3 秒轮询取得 MR/workspace 后，不刷新页面即可出现分支和所有 MR 链接；
  终态首次投影仍完整显示最终交付事实。
- **AC-10 响应式**：390px 宽度下页签进入共享紧凑形态，关键事实卡单列，外链可点击，输入/JSON 区域内部
  滚动且不造成横向页面溢出。
- **AC-11 回归**：数字员工创建页、岗位模板页仍显示和配置全部入口；职责图 authoring 交互不变；运行中的
  work item → Task Session 双向导航保持。
- **AC-12 测试与交付**：backend/frontend/E2E/visual 测试覆盖上述行为；最终以包含实现的 exact SHA
  GitHub Actions 终态为交付依据。

## 7. 实施状态

用户已于 2026-08-28 明确批准 §5 D1–D7，并授权实现完成后提交、推送到远端。生产投影、前端页签、
共享职责图与测试已经完成；本地 backend/frontend 类型检查、目标测试、Chromium E2E、390px 紧凑页签和
真实浏览器视觉检查均通过。远端发布与 exact-SHA CI 证据在 `plan.md` T10–T11 收口。
