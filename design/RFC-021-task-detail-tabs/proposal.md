# RFC-021 — 任务详情页 Tab 化

## 背景

`/tasks/$id` 详情页当前把所有内容**纵向堆叠**：

1. 头部 `task-meta` `<dl>`（workflow / repo / worktree / branch / started /
   finished / error，约 8 行 + 操作按钮）
2. 一坨条件 banner（cancel error / resume error / resume-unavailable hint /
   failed banner / 已取消保留 worktree 提示）
3. `TaskOutputPanel`（如果 workflow 声明了 output 节点）
4. `<section>` **工作流状态**：`TaskStatusCanvas` + `NodeDetailDrawer`
   （canvas 自身 `min-height: 70vh`）
5. `<section>` **节点运行**：`NodeRunsTable`
6. `<section>` **worktree diff**：`DiffViewer`

页面总高度轻易破 2500px，用户进来必须滚动若干屏才能看完——而最有价值的
**画布 + 节点状态实时刷新**被压在中段。RFC-019/020 已把编辑器收紧为视口锁
定 + 内部独立滚动，本 RFC 把同一思路套到任务详情页。

## 目标

- 标题区（`<h1>` + `TaskStatusChip` + 操作按钮 + 必要 banner）**保留在
  page-level**，永远可见。
- 其余 5 块内容**收进 5 个 tab 页签**。
- tab 顺序（用户指定）：**工作流状态 → 节点运行 → 详细信息 → 输出 →
  worktree diff**。
- 默认 tab = 工作流状态；点 "跳到失败节点" 自动切回该 tab 并选中 noderun。
- tab 切换不丢 react-query 缓存、不丢 xyflow viewport（5 个 tab pane 都常
  驻 DOM，靠 `display: none` 切换）。
- 详情页整体锁定视口高度，仅 tab pane 内部出现滚动，浏览器不再出现文档级
  滚动条（与编辑器一致）。

## 非目标

- 不改后端 API、不改 react-query 拉取节奏。
- 不改 `NodeDetailDrawer` / `TaskOutputPanel` / `NodeRunsTable` /
  `DiffViewer` 任何内部行为。
- 不把 tab 状态挂到 URL（v1 保持 React state，未来若需要分享深链接再升
  级；与现有 drawer tab 一致）。
- 不引入新 UI 组件库——复用已有 `.tabs / .tabs__tab / .tabs__tab--active`
  CSS（`NodeDetailDrawer` 同款）。

## 用户故事

1. **运行中任务全程关注**：进入页面默认看到画布，节点颜色随后端 3s 轮询
   实时刷新；其他元数据不抢屏幕。
2. **失败任务快速定位**：在任何 tab 上点 "跳到失败节点" → 自动切回工作流
   状态 tab + Drawer 锁到对应 noderun，无需手动滚或换 tab。
3. **节点执行细节**：切到节点运行 tab 看完整表格（含 review 跳转按
   钮）；行为与现版一致。
4. **元数据查询**：切到详细信息 tab 看 workflow / repo / worktree / branch
   / started / finished / error 等结构化字段（搬自原 `task-meta` dl）。
5. **产出抓取**：切到输出 tab 复制最终产物；若 workflow 没声明 output 节
   点该 tab **自动从 tab list 中隐藏**（避免空 tab）。
6. **worktree diff 审阅**：切到 worktree diff tab 后，**内部再做二级竖
   向 tab**——左侧是文件列（每个改动文件一个竖直 tab），右侧只渲染选中
   文件的 hunks。文件数可能上百，竖向布局比顶部横排更扛量；左侧自身可
   滚，右侧 diff 也独立滚动。若 `baseCommit === null` 显示原 "No base
   commit" 提示（按现行为，**不隐藏 tab**，让用户知道 diff 不可用而非
   以为 tab 丢了）。

## 验收标准

1. ✅ 默认 `tab === 'workflow-status'`；tab 顺序固定为
   `['workflow-status', 'node-runs', 'details', 'outputs', 'worktree-diff']`，
   `outputs` 在 workflow 无 output 节点时被过滤掉。
2. ✅ `<h1>` + `TaskStatusChip` + Resume/Cancel 按钮 + cancel/resume error
   banner + resume-unavailable banner + failed banner + 已取消保留 worktree
   banner 全部留在 page-level，**在 tab bar 之上**，任意 tab 都看得见。
3. ✅ "跳到失败节点" 按钮按下：`setSelectedNodeRunId(target.id)` 与
   `setTab('workflow-status')` 同步发生。
4. ✅ 切换 tab 不触发 react-query 重拉、不重置 canvas viewport（pan/zoom
   保留）。
5. ✅ 详细信息 tab 完整包含原 `task-meta` dl 全部字段；error 字段标红与原
   样式一致。
6. ✅ 输出 tab 在 `collectPorts(task.workflowSnapshot).length === 0` 时不
   出现在 tab bar 中；存在时 pane 内容即原 `TaskOutputPanel`。
7. ✅ worktree diff tab 内：≥1 个文件改动时左侧出现竖向文件 tab 列、右
   侧只渲染选中文件 hunks；默认选首个文件；左右两栏独立滚动；空 diff
   显示 "No changes since the task started." 提示（无侧栏）。
8. ✅ 页面整体没有文档级滚动条，仅 tab pane 内部按需滚动（canvas / 节点
   表 / details dl / diff viewer 各自独立滚动）。
9. ✅ 既有源码层 / 集成测试（如 `noderun-review-jump.test.ts`、
   `task-canvas-layout-class.test.ts`、`task-detail-resolve-node` 等）全部
   保持绿。

## 影响范围

- **前端**：`packages/frontend/src/routes/tasks.detail.tsx` 主改；
  `packages/frontend/src/components/TaskOutputPanel.tsx` 导出
  `collectPorts`；`packages/frontend/src/styles.css` 新增 page--task-detail
  + tab pane 系列规则；i18n 中英新增 6 个 key（5 tab label + details
  heading）。
- **后端 / shared / scheduler / runner / runtime / migration**：零 LOC。
- **测试**：纯函数 6+ case（`task-detail-tabs.test.ts`）、集成 4 case
  （`task-detail-page-tabs.test.tsx`）、CSS 契约（`task-detail-layout-
  viewport-fit.test.ts`），与编辑器收紧同款断言模式。

## 风险与回退

| 风险 | 缓解 |
| --- | --- |
| 5 个 tab 全部 always-mount → DOM 体积膨胀（特别是大型 diff） | DiffViewer 自身已虚拟化分块；canvas 渲染量级不变；details/outputs/node-runs 都是轻量 DOM。实测 jsdom 渲染时间 < 50ms。|
| 用户初次看不到 metadata，疑似数据丢失 | tab 顺序按用户指定（详细信息排第 3），仍属于"主要 tab"且默认排序之内；h1 处 task id + status chip 仍可见；首次访问 banner 区域充当 context。|
| 移动端 5 tab 横排溢出 | tab bar 给 `overflow-x: auto` + 单 tab 不换行兜底。 |
| 后续要把 tab 挂到 URL | v1 仅 React state；未来加 query param `?tab=...` 不破坏既有 API。 |

## 不走 RFC 的部分

`TaskOutputPanel.collectPorts` 改 export 是单一函数对外暴露、零行为变更，
但因为同属本次设计的依赖，写在 plan 的 T1 一起做，不单独立 RFC。
