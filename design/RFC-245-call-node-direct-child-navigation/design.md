# RFC-245 · 技术设计：调用节点点击直达子任务

- 状态：Done（2026-08-01；实现、完整性审计与上库授权完成）
- 配套：`proposal.md`（产品视角）、`plan.md`（任务分解）

## 1. 现状锚点

| 关注点               | 位置                                                                                                           | 现状                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 画布点击派发         | `routes/tasks.detail.tsx:1368-1408`                                                                            | `onSelect` 依次判 review / clarify 分支，兜底 `latestRunByNode.get(sel.id)` → 开抽屉                 |
| 抽屉挂载             | `routes/tasks.detail.tsx:831-859`                                                                              | `selectedNodeRunId !== null` 即渲染 `NodeDetailDrawer`                                               |
| 评审直达三件套       | `routes/tasks.detail.tsx:1303-1324`                                                                            | `reviewNodeIds` / `reviewNavByNode` / `reviewNavs`                                                   |
| 反问直达三件套       | `routes/tasks.detail.tsx:1326-1346`                                                                            | 同构                                                                                                 |
| 纯函数先例           | `lib/review-node-nav.ts`、`lib/clarify-node-nav.ts`                                                            | ULID-newest「最新一代」口径                                                                          |
| 画布 props           | `components/canvas/WorkflowCanvas.tsx:249-257`                                                                 | `reviewNavs` / `clarifyNavs`                                                                         |
| ref-guard            | `WorkflowCanvas.tsx:544-547`（refs）、`727-800`（重建判据 + 赋值）                                             | map 变化触发节点数据重建                                                                             |
| `toFlowNodes`        | `WorkflowCanvas.tsx:2876-2902`（签名）、`2953-2966`（打标）、`3422-3453`（测试导出）                           | 位置参数，末位是 `surface`、`workflowByRef`                                                          |
| `toFlowNodes` 调用点 | `WorkflowCanvas.tsx:501`（初始 state）、`781`（def-sync effect）、`1402`（undo/restore）、`3452`（测试导出内） | 全部按位置传参                                                                                       |
| 节点数据槽           | `components/canvas/nodes/types.ts:124-141`                                                                     | `reviewNav` / `clarifyNav` 注释即契约                                                                |
| 调用节点卡片         | `nodes/CallResourceNodeCard.tsx`                                                                               | 共享 chrome，**dumb**：所有文案由 `CallWorkflowNode` / `CallWorkgroupNode` 以 props 传入             |
| 子任务链接           | `components/tasks/ChildTaskLink.tsx:25-31`                                                                     | 可见性降级：children 列表**已加载**且缺该 child → 中性占位                                           |
| children 查询        | `hooks/useTaskChildren.ts`                                                                                     | `['tasks','children',parentId]` 单键共享，带 `enabled` 形参                                          |
| 父任务 chip          | `routes/tasks.tsx:478-519`                                                                                     | `ParentTaskBadge`：`['tasks',parentId]` 探针 + 中性降级                                              |
| 头部 meta 槽         | `routes/tasks.detail.tsx:493-506`                                                                              | `task-detail__id` + `task-detail__workflow`(`TaskSubjectLink`)                                       |
| nav 光标 CSS         | `styles.css:7559-7577`                                                                                         | `[data-review-nav]` / `[data-clarify-nav]` → `cursor: pointer`                                       |
| 调用行换代规则       | `services/scheduler.ts:2841-2876`                                                                              | 领养禁 mint：只有显式 retryNode 才换代，新行 `childTaskId` 为空                                      |
| wire 现状            | `services/task.ts:3670`、`shared/schemas/task.ts:387-389`                                                      | `childTaskId` / `parentTaskId` 均已下发                                                              |
| 路由 remount         | `routes/tasks.detail.tsx:83-88`                                                                                | **无 `remountDeps`**；对照 `routes/workgroups.detail.tsx:64`、`routes/skills.detail.tsx:60` 均已声明 |

**结论**：本 RFC 是 RFC-158 / RFC-161 这条既有路径的第三次实例化 + 一个公共组件抽取，
**零后端改动、零 wire 改动、零 schema 改动**。

## 2. 决策记录

### D1（用户拍板）调用节点在画布上永不开抽屉

`onSelect` 的调用分支无条件 `onSelectNodeRun(null)`；有跳转目标就 `navigate`，没有就到此为止。
与评审 / 反问分支的形状完全一致。

**取舍与代价（设计门 P1-2 后重新盘点）**：调用节点是 `isProcess: true` 的节点
（`shared/node-kind-behavior.ts:165-176`），抽屉对它并不只是「诊断信息」——它还是
**唯一的 Retry（含 cascade 开关）控件**（`NodeDetailDrawer.tsx:113-130,188-210`，
`canRetryNodeRun` 门控）和**唯一的历代 attempt 切换面**（StatsTab `onPickRetry`，`:445-495`）。

原稿把「失败横幅的跳转到失败节点」当成足够的缓解，**这是错的**：那条路径要求
`task.status === 'failed'` **且** `failedNodeId` 正好指向该节点（`routes/tasks.detail.tsx:631-684`）。
`interrupted` / `canceled` 的调用节点、历史 failed 代、以及「任务因别的节点失败」时，
调用节点的 Retry 与历代面就**彻底不可达**了。

因此 D1 保持不变（**画布点击永不开抽屉**），但必须补一个非画布入口，否则本 RFC 就是在删功能：

1. **T9（新增）**：「节点运行」表的 **call 行**增加「运行详情」按钮 —— 复用失败横幅同款机制
   （`nextTabForFailedJump` 的「切到 workflow-status + 选中该 run」），把抽屉从表格打开。
   只加在 call 行上，精确补偿 D1 移除的那一个入口，不改其它 kind 的行为。
2. 失败横幅路径继续保留（显式诊断动作，不是画布点击，D1 不覆盖它）。
3. 调用节点的输出端口值是子任务结果的转发副本，在子任务自己的「输出」面板上是同一份内容。

### D2（用户拍板）严格最新一代 = 镜像 `isFresherNodeRun`

`deriveCallNodeNav` 只读该 nodeId **最新顶层行**的 `childTaskId`，「最新」的定义**不是自创的
「ULID 最大」，而是复用全仓唯一的 freshness 权威** `isFresherNodeRun`
（`services/freshness.ts:155-161`）：RFC-074 PR-C 明确定为「纯 ULID id 比较，最后插入的行获胜」，
并由 `isfresher-noderun-baseline.test.ts` 锁住与历史三元组的等价性。调度器 `latestPerNode`、
上游输入选取、`deriveReviewNodeNav` / `deriveClarifyNodeNav` 都用它。上库前完整性审计发现任务画布
的通用状态投影仍沿用 `startedAt`（新 placeholder 常为 `null`）；本 RFC 因 A3 直接受影响，故为
**两个 call kind** 增 `deriveCanvasNodeStatuses` 覆写，用同一个 `deriveCurrentCallNodeRun` 选代。
非 call kind 的通用迁移仍归系统级 freshest-run 后续项，不能借本 UX RFC 静默扩面。

因此本 RFC 的口径 = 系统口径，**不引入新的排序假设**：

- 与 `deriveReviewNodeNav` 同构（后者也过滤 `parentNodeRunId === null`）；
- 与调用节点画布状态色同口径 —— `deriveCanvasNodeStatuses` 与点击共用
  `deriveCurrentCallNodeRun`，节点显示的是哪一代的颜色，点击就进哪一代的子任务；
- **旧代不穿透**：`scheduler.ts:2841-2876` 的「领养禁 mint」保证恢复 / 重入一律原地复位、只有
  显式 retryNode 才换代；新行 `childTaskId` 为空的窗口内按 D1 不可点。这与 RFC-161 设计门收敛出
  的「更新的 null 必须遮蔽更旧的可点」是同一条不变量。

**设计门驳回记录（Codex P0-1）**：评审提出「普通 `ulid()` 同毫秒随机后缀不保证递增、时钟回拨
会破坏顺序，应先引入持久严格递增的 generation」。事实部分成立，但**结论不适用于本 RFC**：
排序权威是 `isFresherNodeRun`，它是 RFC-074 定下的**全仓不变量**——若它不成立，调度器早在画布
之前就会选错行。把它换成持久序列是跨 scheduler / 画布 / 评审 / 反问 / 上游输入的系统级改造，
按仓内经验（`docs/dev-gotchas.md` §impl-gate：「平台 / 基础设施类 finding 常引入比原 bug 更严重
的 regression」）绝不能塞进一个前端 UX RFC。已作为**系统级待办**登记进 `docs/audit-backlog.md`。
本 RFC 的义务是「与系统同口径」，这一条已满足。

**设计门修正（Codex P1-1）**：原文写「retryNode 会先级联取消旧代仍存活的子任务」——只对
**被直接重试的那一行**成立（`services/task.ts:2982-3000` 只读 target run 的 `childTaskId`）。
`cascade` 给下游 call 节点 mint 空 placeholder 时（`:3050-3093`）**不**取消它们的存活子任务。
这是 RFC-243 的后端缺口，不是本 RFC 的缺陷：即使发生，最新行 `childTaskId` 为空 ⇒ 按 D1 不可点
⇒ **不会误跳到被取代的旧子任务**，本 RFC 的安全性不依赖那句被过度断言的前提。该后端问题已登记
进 `docs/audit-backlog.md`（RFC-243 后续项），**本 RFC 不动后端**。

顶层过滤（`parentNodeRunId === null`）是防御性的：RFC-243 v1 的 validator 拒绝 fanout 内层
call（`workflow.validator.ts:2260`，直接 + 传递包含均拒），故不存在分片调用行；未来若开放，
per-shard 跳转需要单独决策而不是被这里默默继承。

### D3（用户拍板）提示行 + 指针光标

`CallResourceNodeCard` 在 `data.callNav !== undefined` 时渲染
`<div className="canvas-node__call-nav muted">` 提示行，并把 `data-call-nav` 打到卡片根节点上；
CSS `.canvas-node--call[data-call-nav] { cursor: pointer }`。三处都是评审 / 反问的同名同形结构。

### D4（用户拍板）父任务入口一并补

抽取 `routes/tasks.tsx` 的 `ParentTaskBadge` 为公共组件 `components/tasks/ParentTaskLink.tsx`，
列表与详情共用。**不新写第二套父任务探针**——这条是 CLAUDE.md「前端一致性 / 最小扩展公共组件」
的直接要求，先例是 `TaskSubjectLink`（同一个组件同时服务 `/tasks` 列表单元格与详情头部 meta，
用一个布尔 prop 区分形态）。

### D5（推导）可点性 = 「有最新代 childTaskId」∧「未被证明不可见」

判据与 `ChildTaskLink` 逐字一致：只有 children 查询**成功加载且该 child 缺席**时才判定不可点。
加载中 / 查询报错 → 仍然可点（乐观）。TanStack Query 的 refetch error 可能与上一次成功的旧
`data` 并存，因此调用侧必须让 `isError` 优先，不能把 retained `[]` 当成新的缺席证明。理由：

- 子任务成员是父任务成员的超集，「可见」是正常态，加载中就压掉提示行会让提示在正常流程里晚到；
- 「不可见」必须是**被证明的**，而不是「没能证明可见」——否则一次网络抖动就让整块画布的调用
  节点集体失去入口；
- 与抽屉 / 表格里同一 child 的链接口径完全一致，同一页面不会出现「表格里能点、画布上不能点」。

残余暴露：加载窗口内点一个实际不可见的 child → 落到子任务详情页的 404 面。这与
`ChildTaskLink` 现有暴露等价，不新增风险面。

### D6（推导）children 查询按需启用

`useTaskChildren(task.id, hasCallNodes)`，`hasCallNodes` 由 workflow snapshot 推导。不含调用节点
的任务（绝大多数）**不新增任何请求**，画布行为字节不变。含调用节点时与抽屉 / 表格共用同一
query key，零重复拉取。

### D9（设计门 P0-2，确认成立）children 查询必须有再验证触发器

**没有这一条，D5 会把正常创建的子任务永久判成「已证明缺席」。** 核实结论：

1. `useTaskChildren` 的 `refetchInterval`（`hooks/useTaskChildren.ts:40-42`）只在
   **已有非终态 child** 时开启。首次请求若在 child INSERT 之前返回 `[]`，
   `[].some(...) === false` ⇒ **轮询当场关闭**。
2. 任务详情页只挂 `useTaskSync`，它的失效键全是 `['tasks', taskId]` / `['tasks', taskId, …]`
   （`hooks/useTaskSync.ts:32-40,90-165`）。React Query 的前缀匹配下，
   `['tasks','children',parentId]` **不在**这些前缀里（第二段是 `'children'`，不是 taskId）。
   `task.created` / `task.deleted` 只在列表页的 `useTasksSync` 上处理。
3. 于是：打开父任务详情 → 调用节点还没派发 → children 是 `[]` → 轮询关闭 → 子任务起来后
   **再也不会刷新**。D5 的「已加载且缺席 ⇒ 不可点」就把一个活着的子任务永久锁在不可点。

同一个缺陷今天已经在 `ChildTaskLink` 上存在（会常驻显示「子任务不可见或已删除」），只是抽屉/
表格不是主路径所以没人注意。本 RFC 把它变成主路径，必须修：

- **触发器 1（事件驱动，主）**：`useTaskSync` 的 `node.status` / 任务终态规则追加失效
  `['tasks','children', taskId]`。子任务 id 正是在调用行上落库的
  （`scheduler.ts:3000-3005`，先 stamp `childTaskId` 再启动），该 stamp 必然伴随节点状态广播。
- **触发器 2（兜底轮询）**：`useTaskChildren` 增 `parentActive` 形参；**父任务未终态时保持轮询**，
  而不是只看 children 自身。空列表不再等于「不用再看了」。

两条一起才闭合：事件驱动负责及时，轮询负责补漏（WS 断线 / 事件丢失）。

**残余（显式登记，不建整套再验证机制）**：父任务已终态、子任务在别处被删除时，缓存里的旧行
会让链接指向一个已删任务 → 落到 404 面。与 `ChildTaskLink` 今天的暴露等价，不扩大。

### D8（推导，本 RFC 前提）`/tasks/$id` 必须声明 `remountDeps`

**这是设计阶段自查发现的既有缺陷，本 RFC 把它变成必须修的前提。**

`routes/tasks.detail.tsx:83-88` 的 `createRoute` 没有 `remountDeps`，而同仓
`workgroups.detail.tsx:64` / `skills.detail.tsx:60` 都声明了 `remountDeps: ({ params }) => params`。
TanStack Router 的默认语义是**同一路由内 params 变化不重挂组件**，于是 `/tasks/A → /tasks/B`
会保留 `TaskDetailPage` 的全部 `useState`：`selectedNodeRunId`、`dismissedBanners`、
`focusTargetNode`、`structScope` 等。

后果（现存、可复现；**症状经设计门 P2-2 修正**）：抽屉开着时从详情页跳到另一个任务详情，
`selectedNodeRunId` 仍是**上一个任务**的 run id。`NodeDetailDrawer` 本身是安全的——
`run === undefined` 时直接 `return null`（`NodeDetailDrawer.tsx:128-129`），**不会**渲染出
字段全空的坏抽屉（原稿这里写错了）。真正的坏味道是：

1. `taskCanvasLayoutClass(selectedNodeRunId)`（`:1702-1706`）只看「非 null」，于是画布右侧
   **留出一条空的抽屉栏**，内容却是空的；
2. 其余 task 作用域状态一起残留：`dismissedBanners`（键含旧 task id，永不再命中）、
   `focusTargetNode`（指向旧任务的节点）、`structScope`（`node:${旧 nodeRunId}`）。

今天这条路径只在「抽屉里的 `ChildTaskLink`」上可达，比较冷门。

本 RFC 让「详情 → 详情」成为**主要交互**（G1 的下行 + D4 的上行），命中率从冷门变常态；
其中 D4 的父任务入口更是可以在抽屉开着的状态下点（失败横幅开的抽屉 + 头部父任务链接同屏）。
因此把 `remountDeps: ({ params }) => params` 补上是本 RFC 的组成部分，而不是可选顺手活。
按 params 重挂而非逐个 `setState(null)`：一次性覆盖所有 id 作用域状态，新增状态不会再漏。
`search`（tab 切换）不在 remount 依赖里，页内切页签行为不变。

### D7（推导）`toFlowNodes` 新参数追加到末位

现签名是 **13 个位置参数**（`definition, agentByName, statuses, questionCounts,
onQuestionBadgeClick, clarifyDirectives, onClarifyDirectiveToggle, reviewNavs, clarifyNavs,
onAddInsideWrapper, validationCounts, surface, workflowByRef`），且
`call-workflow-node.test.tsx:168-182` 等测试按位置传到第 13 位。
`callNavs` **追加为第 14 位**，不插在 `clarifyNavs` 之后——插入会静默改变既有测试的语义。
签名改成 options 对象是正解，但会横扫 5+ 个测试文件并与在飞的 RFC-244 抢同一批文件，
登记为后续项（§8）。

## 3. 接口契约

### 3.1 新纯函数 `lib/call-node-nav.ts`

```ts
export interface CallNodeNav {
  /** 跳转目标：/tasks/{childTaskId} */
  childTaskId: string
}

/** 该调用节点的点击目标，或 null（不可点）。严格最新一代（D2）。 */
export function deriveCallNodeNav(runs: NodeRun[], nodeId: string): CallNodeNav | null
```

实现：过滤 `r.nodeId === nodeId && r.parentNodeRunId === null` → 空则 `null`；取 ULID 最大行；
`childTaskId` 为 `null` / `undefined` → `null`；否则 `{ childTaskId }`。**纯函数，无 ACL 判断**
（可见性在调用侧合成，见 §4）。

### 3.2 节点数据槽 `CanvasNodeData`

```ts
/** RFC-245: 调用节点点击目标标记 —— 只在任务详情画布、且该节点有可跳子任务时出现。
 *  编辑器 / 预览画布恒为 undefined（golden-lock）。 */
callNav?: 'child'
```

单值枚举而非布尔：与 `reviewNav` / `clarifyNav` 保持同形（`data-*` 属性存在性驱动 CSS），
且为未来可能的语义分档（如「运行中 / 已完成」）留位而不预先发明。

### 3.3 画布 prop

```ts
/** RFC-245: 每个调用节点的点击目标；undefined（编辑器画布）⇒ 无节点获得 callNav。 */
callNavs?: Record<string, CallNodeNavKind>   // CallNodeNavKind = 'child'
```

打标条件：`callNavs !== undefined && (n.kind === 'call-workflow' || n.kind === 'call-workgroup')`
且 `callNavs[n.id] !== undefined`。

### 3.4 卡片 props（`CallResourceNodeCard`）

新增 `navHintLabel: string`（由两个节点组件各自以 `t('callNode.navChild')` 传入）。
卡片保持 dumb——不引入 `useTranslation`，与 `CanvasNodeCard` / `CanvasNodeReferenceBand` 的既有
契约一致。

### 3.5 详情页组件 `components/tasks/ParentTaskLink.tsx`

```ts
export function ParentTaskLink(props: {
  taskId: string // 当前（子）任务 id，用于 testid
  parentTaskId: string
  showName?: boolean // 探针成功时同时显示父任务名（默认 false）
}): ReactElement
```

`probe.data !== undefined` → `<Link>`；否则中性 `<span>`，文案
`probe.isError ? tasks.parentTaskUnavailable : tasks.parentTaskChip`。`showName` 只在已有
`probe.data` 时追加名字，不改变可点性判据。i18n 复用既有 `tasks.parentTaskChip` /
`tasks.parentTaskUnavailable`（zh/en 均已存在）。

**实施期现实修正（2026-08-01）**：原计划是「从 `routes/tasks.tsx` 抽取 `ParentTaskBadge`，
列表 + 详情共用」。落地时并发的 **RFC-244 已经把 `/tasks` 重写完毕**，列表侧的客户端探针被
服务端 `listContext.parentAvailability` 取代（正是 RFC-244 proposal §1.6 要解决的 N+1 探针）。
因此本组件改为**详情页专用**、不带 `parentInList`，也**不触碰 `routes/tasks.tsx`**
（CLAUDE.md 并发原则：不动他人正在改的文件）。详情页只需一次查询、且共享
`['tasks', parentId]` 缓存（顺带预热跳转目标），所以客户端探针在这个面上依然是正解；
若将来任务详情 wire 也给出授权父任务投影，再把它收敛过去。

**ACL 口径修正（设计门 P2-4）**：父任务「存在但不可见」由中间件抛 `ForbiddenError`
**403**（`packages/backend/src/routes/tasks.ts:810-821`），只有「不存在」才是 404
（`:215-238` 显式「不泄露 存在 vs 禁止」）。组件对**任意** `probe.isError` 都降级、且只在
`probe.data` 就绪后才显示名字，所以没有名称泄露；但测试必须**分别**覆盖 403 与 404
两条路径，不能像原稿那样只建模 404。

### 3.6 新增 i18n key

`callNode.navChild` —— zh：`点击进入子任务`；en：`Open child task`。
（新起 `callNode` 命名空间：文案对两个调用 kind 完全相同，塞进 `callWorkflowNode` /
`callWorkgroupNode` 会逼出两份同值副本。）

### 3.7 新增 CSS

```css
/* RFC-245 —— 与 [data-review-nav] / [data-clarify-nav] 同形 */
.canvas-node--call[data-call-nav] {
  cursor: pointer;
}
.canvas-node__call-nav {
  margin-top: 4px;
  font-size: 11px;
}
```

## 4. 数据流

```
GET /api/tasks/:id/node-runs ──► runs
                                  │
                     callNodeIds (definition 里两个 call kind 的 id 集合)
                                  │
                    deriveCallNodeNav(runs, nodeId)  ── D2 严格最新一代
                                  │  {childTaskId} | null
GET /api/tasks?parent_id=:id ──► children (enabled = hasCallNodes, D6)
                                  │
                    可见性合成 (D5)：children.isError === false
                                     && children.data !== undefined
                                     && !children.data.some(c => c.id === childTaskId)
                                     ⇒ 判定不可点
                                  │
                    callNavByNode: Map<nodeId, childTaskId>
                          ├──► callNavs: Record<nodeId,'child'> ──► WorkflowCanvas ──► 卡片提示行 + 指针
                          └──► onSelect 调用分支 ──► navigate('/tasks/$id')
```

`onSelect` 调用分支（放在 review / clarify 分支之后、抽屉兜底之前）：

```ts
if (callNodeIds.has(sel.id)) {
  // 必须最先：unselectNodesAndEdges + 把 lastEmittedSelectionSig 复位成 'null'
  // （WorkflowCanvas.tsx:2196-2202）。否则 onNodeClick 的同签名去重
  // （:2288-2295）会吞掉对同一节点的第二次点击。
  canvasRef?.current?.clearSelection()
  // 只负责清空父组件的 drawer state（不碰 xyflow 签名）——覆盖「失败横幅已把抽屉
  // 打开、用户又去点画布上的调用节点」这一路。
  onSelectNodeRun(null)
  const nav = callNavByNode.get(sel.id)
  if (nav != null) {
    void navigate({ to: '/tasks/$id', params: { id: nav.childTaskId }, search: {} })
  }
  return
}
```

（设计门 P2-1：原稿把签名复位归因给了 `onSelectNodeRun(null)`，会误导后来者以为
`clearSelection()` 可以删或后移。两个调用的职责已按上面的注释分清。）

`search: {}` 让子任务详情页走 `validateTaskDetailSearch` 的规范默认 tab
（与 `/reviews` 分支同写法）。

## 5. 与现有模块的耦合点 / 不变量

- **I1 golden-lock**：`callNavs === undefined` ⇒ `toFlowNodes` 产出的节点数据与本 RFC 前逐字段
  相同。编辑器、`workgroup-preview`、`intent-preview` 三个 surface 都不传该 prop。
- **I2 ref-guard 对称**：新增 `externalCallNavsRef` + `callNavsChanged` 判据，与
  `reviewNavsChanged` / `clarifyNavsChanged` 并列（`WorkflowCanvas.tsx:727-800` 的判据与赋值
  两段都要加）。缺这一条会让 node-runs 查询解析后提示行不刷新（RFC-158 踩过的同一个坑）。
- **I2b def-sync effect 依赖数组**（设计门 P1-3，原稿漏项）：`callNavs` 必须进
  `WorkflowCanvas.tsx:825-845` 的 `useEffect` deps（`reviewNavs` / `clarifyNavs` 就在里面）。
  **只加 ref-guard 不加 deps 时 effect 根本不会重跑**：children 数据单独由「缺席 → 命中」翻转时
  点击闭包已更新、卡片上的提示行与光标却停在旧值，行为与视觉分叉。纯函数测试和源码锁都抓不到，
  必须补一条 `undefined → present → absent` 的重渲染断言。
- **I3 四处 `toFlowNodes` 调用点必须同步**：初始 state（`:501`）、def-sync effect（`:781`）、
  undo/restore（`:1402`）、测试导出 `__testToFlowNodes`（`:3452`）。漏任何一处 ⇒ 撤销或重建后
  提示行消失（或测试打不到标）。
- **I4 useCallback 依赖**：`callNavs` 要进 undo/restore 回调（`:1443-1461`）的依赖数组，
  否则闭包读到旧 map。
- **I5 分支顺序**：调用分支必须在 `latestRunByNode.get(sel.id)` 兜底之前 return，
  由源码文本锁固定（clarify 测试同款断言）。
- **I6 抽屉其它入口不受影响**：失败横幅路径直写 `selectedNodeRunId`，不经过 `onSelect`；
  `resolveNodeKindFromSnapshot` 对两个 call kind 继续正常返回。
- **I7 不触碰 `/tasks`**：并发的 RFC-244 正在重写该路由，本 RFC 一行不改（见 §3.5 实施期修正）。

## 6. 失败模式

| #   | 场景                                           | 行为                                                                     | 依据                                 |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------ |
| F1  | 调用节点未派发 / 等限额 / 启动前失败           | 无 `childTaskId` ⇒ 不可点、无提示行、不开抽屉                            | D1                                   |
| F2  | 子任务被删除（RFC-222）或对当前用户不可见      | children 加载后缺席 ⇒ 不可点                                             | D5                                   |
| F3  | children 查询报错 / 未完成（含 retained data） | `isError` 优先，保持可点（乐观）；点中不可见 child 时落 404 面           | D5 残余暴露，与 `ChildTaskLink` 等价 |
| F3b | 首次 children 请求早于 child 落库（返回 `[]`） | 事件失效 + 父任务活跃期轮询 ⇒ child 出现后转可点；**不会**被永久判成缺席 | D9                                   |
| F3c | 父任务已终态、子任务在别处被删                 | 缓存旧行 ⇒ 链接落 404 面                                                 | D9 残余，显式登记                    |
| F4  | 重试刚换代、新 `childTaskId` 未落库            | 该窗口内不可点（不回退旧代）                                             | D2                                   |
| F5  | node-runs 查询失败                             | `runs` 为空 ⇒ 全部调用节点不可点；页面既有 ErrorBanner 已覆盖            | 现状                                 |
| F6  | 父任务不可见 / 已删除                          | 详情头部渲染中性「父任务不可见」，不是死链                               | D4                                   |
| F7  | 同一节点连点两次                               | `clearSelection()` 先行 ⇒ 第二次点击不被选中签名吞掉                     | §4 楔子                              |
| F8  | 抽屉开着时跳到另一个任务详情                   | `remountDeps` 重挂 ⇒ 落地页状态干净，不再渲染坏抽屉                      | D8                                   |

## 7. 测试策略

新增 `packages/frontend/tests/call-node-click-nav.test.tsx`，按 `clarify-node-click-nav.test.tsx`
的六组结构：

1. **纯函数** `deriveCallNodeNav`：空 runs / 全空 `childTaskId` / 单行命中 / 多代取 ULID 最新 /
   **更新的空行遮蔽更旧的有值行**（D2 反例，回归防护重点）/ 顶层过滤（带 `parentNodeRunId` 的行
   被跳过）/ 不跨 nodeId / 字段缺失（旧 daemon）不可点。
2. **卡片渲染**：`callNav='child'` ⇒ `.canvas-node__call-nav` 提示行 + `[data-call-nav]`；
   无 `callNav` ⇒ 两者都不存在（golden-lock），两个 kind 各跑一遍。
3. **`toFlowNodes` 打标**：两个 call kind 命中 map 才打标；非 call kind 即使键在 map 里也不打标；
   **不传 map 时任何调用节点都没有 `callNav`**（编辑器画布字节不变）。
4. **可见性合成 + 再验证**（D5 / D9）：
   - 纯判据（抽成可测函数）：children 未加载 ⇒ 可点；加载后命中 ⇒ 可点；加载后缺席 ⇒ 不可点。
   - **retained-data error**：先成功缓存 `[]`、随后 refetch 失败时仍可点；`ChildTaskLink` 同步锁住
     「旧缺席数据 + 新错误」恢复乐观链接，防 error/data 优先级再次漂移。
   - **`[] → live child` 真实转换**（P0-2 回归锁）：mock 首次返回 `[]`，触发失效后返回含 child
     的列表，断言节点从不可点变可点；同时断言 `useTaskSync` 的规则表里
     `['tasks','children', taskId]` 确实在 `node.status` / 任务终态两组键里。
   - **父任务活跃期轮询**：断言 `useTaskChildren` 在 `parentActive` 为真时即使 children 为空
     也返回非 false 的 `refetchInterval`。
5. **画布重渲染**（P1-3 回归锁）：同一 `definition` 下把 `callNavs` 从 `undefined` → 有值 →
   空对象，断言卡片提示行与 `data-call-nav` 跟着出现 / 消失（锁 effect 依赖数组，而不只是
   ref-guard）。
   另用「旧 done 行 `startedAt>0` + 新 pending 行 `startedAt=null`」锁住 call 状态色仍取新行，
   与点击目标共享 freshness 代际（A3）。
6. **`tasks.detail` 接线源码锁**：调用分支存在且位于抽屉兜底之前；`clearSelection()` 在
   `navigate` 之前；分支内出现 `onSelectNodeRun(null)`（抽屉永不打开）；`callNavs` 已 thread 给
   `WorkflowCanvas`；`useTaskChildren` 以 `hasCallNodes` 为 enabled。
7. **CSS + i18n**：`.canvas-node--call[data-call-nav]` 有 `cursor: pointer`；两个 locale 都定义
   `callNode.navChild`。
8. **D8 路由锁**：源码断言 `routes/tasks.detail.tsx` 的 `createRoute` 含
   `remountDeps: ({ params }) => params`，注释写明它锁的是「详情→详情跳转后不得残留上一个任务
   的 `selectedNodeRunId`」；行为断言 A→B 路由后 `task-canvas-layout--with-drawer`
   修饰类消失（P2-2 修正后的真实症状）。
9. **T9 表格入口**：call 行渲染「运行详情」按钮、非 call 行不渲染；点击后 tab 切到
   `workflow-status` 且该 run 被选中（抽屉打开）——锁住 D1 的补偿入口不被后人顺手删掉。

新增 `packages/frontend/tests/parent-task-link.test.tsx`：

- 父任务可见 ⇒ `<a>` 指向 `/tasks/{parentId}`；
- **403（存在但不可见）与 404（已删除）各一例**（P2-4）：两者都断言无链接、无父任务名、
  保留既有 testid；
- `showName` 打开且探针成功 ⇒ 显示父任务名；探针未完成 ⇒ 不显示名字且不报错；
- 源码锁：`routes/tasks.tsx` 与 `routes/tasks.detail.tsx` 都从
  `components/tasks/ParentTaskLink` 引入（不存在第二份探针实现）。

回归面（设计门 P2-3 补全）：按位置调用 `__testToFlowNodes` 的**全部 9 个**测试文件都要原样
通过——`call-workflow-node` / `call-workgroup-node` / `canvas-node-title` /
`canvas-question-badge` / `canvas` / `clarify-directive-toggle` / `clarify-node-click-nav` /
`review-node-click-nav` / `status-canvas`；外加 `call-node-card-style` /
`task-detail-child-task-link` / `task-canvas-layout-class` / `tasks-list-children`。
实操上以**整套 frontend Vitest 全绿**为准，上面的清单只是「必须逐个确认无遗漏」的备查表。

不新增 e2e：RFC-158 / RFC-161 两个同构先例均为单测 + 源码锁，`e2e/rfc243-call-nodes.spec.ts`
覆盖的是编辑器侧，本 RFC 不改那条路径。

## 8. 后续项（登记，不在本 RFC 实施）

1. **`toFlowNodes` 位置参数 → options 对象**：本 RFC 后达 14 位，横扫 9 个按位置调用的测试文件，
   宜在没有在飞前端 RFC 的窗口单独做（D7）。
2. **两条登记进 `docs/audit-backlog.md` 的仓级问题**（设计门产出，非本 RFC 修）：
   - **node_run id 单调性是全仓前提**：`isFresherNodeRun` 纯 ULID 比较（RFC-074），同毫秒随机
     后缀与时钟回拨在理论上可破坏顺序；影响面是调度器 / 画布 / 评审 / 反问 / 上游输入的**全部**
     freshest-run 选取，需要系统级 RFC（持久严格递增 generation）而不是逐处打补丁。
   - **retryNode cascade 不取消下游 call 行的存活子任务**：`services/task.ts:2982-3000` 只取消
     被直接重试那一行的 `childTaskId`，`:3050-3093` 的 cascade placeholder mint 不做同样的事
     ⇒ 可能留下孤儿子任务。属 RFC-243 后端范畴。
3. **fanout 内层 call 开放后的 per-shard 跳转**：届时 `deriveCallNodeNav` 的顶层过滤需要显式
   决策（跳哪片 / 还是给出分片列表），不得默默继承本 RFC 的口径。
