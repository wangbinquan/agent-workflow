# RFC-245 · 任务分解

- 状态：Done（2026-08-01；完整性审计完成，publication 已授权）
- 配套：`proposal.md`、`design.md`

## PR 拆分建议

**单 PR**：`feat(frontend): RFC-245 调用节点点击直达子任务`。
子任务都在前端、互相咬合（纯函数 → 画布数据 → 卡片 → 接线 → 测试），拆开无法独立跑绿。
父任务入口（T6）虽然是独立小面，但同属「父子任务往返闭环」这一个产品目标，且共用同一批
i18n / 测试基建，一起提交更利于回溯。T9（表格「运行详情」入口）与 T10（children 再验证）
是设计门抓出的**必须同批交付项**：前者补偿 D1 移除的 Retry / 历代入口，后者是 D5 可见性判据
成立的前提——两者若拆到后续 PR，本 RFC 落地即带功能损失与永久失效链接。

## 子任务

### RFC-245-T1 · 纯函数 `deriveCallNodeNav`

- 新建 `packages/frontend/src/lib/call-node-nav.ts`：`CallNodeNav` / `CallNodeNavKind` /
  `deriveCurrentCallNodeRun` / `deriveCallNodeNav`（design §3.1）；状态色与跳转共用 current-run oracle。
- 文件头注释写明：为什么是「严格最新一代」、为什么过滤顶层行、与
  `review-node-nav.ts` / `clarify-node-nav.ts` 的同构关系、`scheduler.ts` 领养禁 mint 这条
  后端不变量是本口径的前提。
- 依赖：无。

### RFC-245-T2 · `CanvasNodeData.callNav` + `toFlowNodes` 打标

- `components/canvas/nodes/types.ts` 增 `callNav?: 'child'`（注释即契约，说明 golden-lock）。
- `WorkflowCanvas.tsx`：`toFlowNodes` 与 `__testToFlowNodes` **末位追加** `callNavs` 形参
  （design §D7）；打标只认两个 call kind。
- 依赖：T1（类型）。

### RFC-245-T3 · `WorkflowCanvas` prop 贯通

- 新增 `callNavs` prop + `externalCallNavsRef` + `callNavsChanged`；
  三处 `toFlowNodes` 调用点同步传参；`useCallback` 依赖数组补 `callNavs`（design I2/I3/I4）。
- 依赖：T2。

### RFC-245-T4 · 卡片提示行 + CSS

- `CallResourceNodeCard` 增 `navHintLabel` prop：`data.callNav !== undefined` 时渲染
  `.canvas-node__call-nav` 提示行并把 `data-call-nav` 打进 `dataAttributes`
  （与既有 `data-reference-state` 合并，不覆盖）。
- `CallWorkflowNode` / `CallWorkgroupNode` 各传 `t('callNode.navChild')`。
- `styles.css` 增两条规则（design §3.7），紧挨 `[data-clarify-nav]` 块以便对照。
- i18n：`callNode.navChild` 加进类型声明 + zh-CN + en-US。
- 依赖：T2。

### RFC-245-T5 · `tasks.detail` 接线

- `TaskStatusCanvas` 内新增「调用直达三件套」：`callNodeIds` / `callNavByNode` / `callNavs`，
  与 review / clarify 三件套并列同形。
- `useTaskChildren(task.id, callNodeIds.size > 0, !isTerminal(task.status))` 做可见性合成
  （design D5/D6/D9）。
- `children.isError` 必须优先于 retained `children.data`：refetch 失败按「未证明不可见」保持乐观，
  `ChildTaskLink` 采用相同口径。
- `onSelect` 增调用分支（design §4 的确切形状），位置在 clarify 分支之后、抽屉兜底之前。
- `callNavs` 传给 `WorkflowCanvas`。
- 依赖：T1、T3、T4。

### RFC-245-T6 · 父任务入口

- 新建 `components/tasks/ParentTaskLink.tsx`（design §3.5）。
  **实施期修正**：原为「从 `routes/tasks.tsx` 抽取 `ParentTaskBadge` 供列表 + 详情共用」；
  落地时并发的 RFC-244 已重写 `/tasks` 并把列表侧探针换成服务端 `parentAvailability`，
  故本组件改为**详情页专用**、不带 `parentInList`，且**不修改 `routes/tasks.tsx`**。
- `routes/tasks.detail.tsx` 头部 `meta` 槽在 `tk.parentTaskId != null` 时增
  `<div className="task-detail__parent">`，内嵌 `<ParentTaskLink showName />`。
- `styles.css` 视需要给 `.task-detail__parent` 补与 `.task-detail__workflow` 一致的间距；
  能直接复用既有 class 就不新增。
- 依赖：无（可与 T1–T5 并行）。

### RFC-245-T8 · `/tasks/$id` 路由 `remountDeps`

- `routes/tasks.detail.tsx` 的 `createRoute` 增 `remountDeps: ({ params }) => params`
  （precedent：`workgroups.detail.tsx:64`、`skills.detail.tsx:60`），并写注释说明它锁的是
  「详情→详情跳转后不得残留上一个任务的 `selectedNodeRunId`」（design D8）。
- 依赖：无（可与 T1–T6 并行）。

### RFC-245-T9 · 「节点运行」表 call 行的「运行详情」入口（D1 补偿，设计门 P1-2）

- `NodeRunsTable` 的 call 行（`r.childTaskId != null` 或该 nodeId 的 kind 属两个 call kind）
  在既有「子任务」按钮旁增「运行详情」按钮：复用失败横幅同款机制（切到 `workflow-status`
  tab + `setSelectedNodeRunId(r.id)`）把抽屉从表格打开。
- **只加在 call 行**：精确补偿 D1 移除的那个入口（Retry + cascade 开关 + 历代 attempt 切换是
  抽屉独有的，见 design D1 取舍段），不改其它 kind 的行为。
- 需要把 `setSelectedNodeRunId` / tab 导航从 `TaskDetailPage` 传进 `NodeRunsTable`
  （目前它只收 `taskId` / `runs` / `workflowSnapshot`）。
- 依赖：无（可与 T1–T6 并行）。

### RFC-245-T10 · children 查询再验证（设计门 P0-2）

- `hooks/useTaskSync.ts`：`node.status`（及任务终态那组）追加失效
  `['tasks','children', taskId]`。
- `hooks/useTaskChildren.ts`：增 `parentActive` 形参，父任务未终态时保持轮询
  （不再因为 `[]` 就关掉）。调用方 `tasks.detail.tsx` / `tasks.tsx` 各自传值。
- 顺带修好 `ChildTaskLink` 今天会常驻误显「子任务不可见或已删除」的同一缺陷。
- 依赖：无（但 T5 的可见性合成依赖它才成立，测试放一起）。

### RFC-245-T7 · 测试

- 新建 `packages/frontend/tests/call-node-click-nav.test.tsx`（design §7 第 1–9 组）。
- 新建 `packages/frontend/tests/parent-task-link.test.tsx`（含 403 / 404 两条 ACL 路径）。
- 扩 `task-detail-route-history.test.tsx`：真实路由锁住画布单跳、表格运行详情与 A→B remount 清状态；
  扩 `task-detail-child-task-link.test.tsx` 锁 retained-data refetch error。
- 回归面按 design §7 末段的备查表逐个确认（9 个按位置调用 `__testToFlowNodes` 的文件 +
  4 个相关文件），最终以**整套 frontend Vitest 全绿**为准。
- 依赖：T1–T6、T8–T10。

## 依赖图

```
T1 ─┬─► T2 ─► T3 ─┐
    │             ├─► T5 ─┐
    └─────────────┤       │
              T4 ─┘       ├─► T7（测试）
              T6 ─────────┤
              T8 ─────────┤
              T9 ─────────┤
             T10 ─────────┘        T10 是 T5 可见性合成成立的前提
```

## 验收清单

- [x] A1 有可见子任务的调用节点：点击 → `/tasks/{childTaskId}`，抽屉不出现
- [x] A2 四种「无子任务」情形：不跳、不开抽屉、无提示行、无 pointer
- [x] A3 多代取最新代；旧代永不成为目标（含「更新的空行遮蔽更旧有值行」+ adoption `canceled`
      行仍可点 + cascade 占位行遮蔽三条用例）；新代 `startedAt=null` 时状态色也取新代
- [x] A4 `data-call-nav` 只出现在可点的调用节点上（且不挤掉 `data-reference-state`）
- [x] A5 编辑器 / 两个预览 surface 的节点数据 golden-lock 通过（不传 map ⇒ 无 `callNav`）
- [x] A6 详情页父任务入口：可见 → 链接；403 不可见 / 404 已删 / **中途被撤权** → 中性标签
- [x] A7 `/tasks` 列表零改动（RFC-244 已重写该路由，本 RFC 不碰）
- [x] A9 「详情 → 详情」跳转落地干净（`remountDeps`，含空抽屉栏症状锁）
- [x] A10 首次 children 返回 `[]` 后子任务才起来 → 能自动转为可点（WS 失效真断言 + 活跃期轮询）
- [x] A11 call 行的「运行详情」入口可达抽屉的 Retry / 历代 attempt（按 `canOfferFailedJump` 门控；
      snapshot kind 缺失时以 wire `childTaskId` 兜底识别）
- [x] A12 `callNavs` 单独变化时卡片提示行与光标跟随更新（effect 依赖，实测摘依赖 → 红）
- [x] A8 typecheck / lint / format 全绿；前端 675 文件 5631 条、shared 1536 条全绿。
      本地长时全仓 backend 轮在宿主临时端口耗尽后出现 `Bun.serve({ port: 0 })` `EADDRINUSE`
      及其 47 条 WS / daemon 级联失败；另有既有 RFC-098 PID 回收等待 2 条红。两者均可在零改动
      隔离复跑中稳定复现，且本 RFC 零 backend 改动；最终发布以干净 hosted runner 的 exact-SHA CI
      为权威
- [x] Codex 设计门 findings 已折入（2 P0 / 3 P1 / 4 P2，1 条 P0 部分驳回并给出理由）
- [x] 实现门已跑 —— **Codex 两轮均 wedge，按 dev-gotchas「勿三连重试」改为对抗自评审替代**，
      逐条结论与三处「摘掉修复即变红」的实测见 `implementation-gate-2026-08-01.md`
- [x] `design/plan.md` RFC 索引登记 + `STATE.md` 同步
- [x] 上库授权与精确发布单元已收口（用户于 2026-08-01 明确授权；实际 push 与 exact-SHA CI
      证据由本轮上库回执给出）
