# RFC-021 — 技术设计

## 总览

把 `tasks.detail.tsx` 从"五段纵向 section"重构为"page-level 标题区 + tab
bar + 五个常驻 tab pane"。所有 react-query hooks、selection state、mutation
保持在 page 顶层（不下沉到 tab 组件），保证切 tab 不影响数据流。

```
.page--task-detail (height: 100%; flex column)
├─ <header class="page__header">          ← 永远可见
│   ├─ <h1><code>{id}</code> <TaskStatusChip/></h1>
│   └─ <div class="page__actions">Resume / Cancel</div>
├─ {cancel-error | resume-error | resume-unavailable
│    | failed-banner with jumpToFailed
│    | worktree-preserved} banners       ← 永远可见
├─ <nav class="task-detail__tab-bar tabs">
│     [工作流状态] [节点运行] [详细信息] [输出?] [worktree diff]
└─ <div class="task-detail__panes">       ← flex: 1; min-height: 0
    ├─ pane workflow-status   (display: flex when active, none otherwise)
    │     └─ <TaskStatusCanvas/> + <NodeDetailDrawer/>
    ├─ pane node-runs         <NodeRunsTable/>
    ├─ pane details           <dl class="task-meta">...</dl>
    ├─ pane outputs           <TaskOutputPanel/>      (rendered only if hasOutputs)
    └─ pane worktree-diff     baseCommit==null ? hint
                              : empty diff ? "No changes"
                              : <WorktreeDiffPanel/>   ← 二级竖向 file tabs
```

worktree diff pane 内部布局（新增 `WorktreeDiffPanel` 组件）：

```
.worktree-diff (flex row, height: 100%)
├─ <aside class="worktree-diff__files">         ← 竖向 tab 列
│     {truncated && banner}
│     <nav role="tablist" aria-orientation="vertical">
│       <button role="tab" aria-selected> file1 path </button>
│       <button role="tab"               > file2 path </button>
│       …                                       ← overflow-y: auto
│     </nav>
└─ <section class="worktree-diff__body">        ← 右侧 hunks
      <div class="diff__file-header">{selected.header}</div>
      <pre class="diff__body">…lines…</pre>     ← overflow: auto
```

## 接口契约

### 新增纯函数（`packages/frontend/src/lib/task-detail-tabs.ts`）

```ts
export type TaskDetailTab =
  | 'workflow-status'
  | 'node-runs'
  | 'details'
  | 'outputs'
  | 'worktree-diff'

export const TAB_ORDER: readonly TaskDetailTab[] = [
  'workflow-status',
  'node-runs',
  'details',
  'outputs',
  'worktree-diff',
] as const

/** Filter the tab list to what the current task can actually show. */
export function availableTabs(opts: { hasOutputs: boolean }): TaskDetailTab[]

/** Resolve the (selected node-run id, target tab) pair for the
 *  "Jump to failed node" button. Returns `runId: null` when the
 *  failed node has no node-run row yet — UI still switches tab so
 *  the user sees the canvas. */
export function nextTabForFailedJump(
  runs: NodeRun[],
  failedNodeId: string | null,
): { runId: string | null; tab: TaskDetailTab }
```

### TaskOutputPanel 导出

`packages/frontend/src/components/TaskOutputPanel.tsx` 把现有内部函数

```ts
function collectPorts(snap: unknown): DeclaredPort[]
```

改为 `export function collectPorts(...)`，让 page 计算 `hasOutputs` 时复用
同一段解析逻辑（**不可在 page 内重写**——重写会与 panel 的 ports.length
判断逐步漂移）。

### DiffViewer 拆分 + 新 WorktreeDiffPanel

`packages/frontend/src/components/DiffViewer.tsx` 现存：

```ts
function splitByFile(diff: string): FileBlock[]
function lineClass(line: string): string
export function DiffViewer({ diff, truncated })
export const __testSplitByFile = splitByFile
export const __testLineClass = lineClass
```

把 `splitByFile` / `lineClass` 改正式 `export`（保留 `__testXxx` 别名一
段时间防外部测试 import 失败），并新增渲染单个 `FileBlock` 的纯组件
`DiffFileBody`：

```ts
export function splitByFile(diff: string): FileBlock[]
export function lineClass(line: string): string
export function DiffFileBody({ block }: { block: FileBlock }): JSX.Element
```

`DiffViewer` 自身实现保持向后兼容（仍接 `{ diff, truncated }`，内部用
`splitByFile` + `<DiffFileBody>` 渲染所有 block），但 tasks.detail 不再
用它，改用新的 `WorktreeDiffPanel`：

```ts
// packages/frontend/src/components/WorktreeDiffPanel.tsx
interface Props {
  diff: string
  truncated?: boolean
}
export function WorktreeDiffPanel({ diff, truncated }: Props): JSX.Element
```

内部状态：

```ts
const blocks = useMemo(() => splitByFile(diff), [diff])
const [selectedKey, setSelectedKey] = useState<string | null>(null)

// 切到新 diff 时校正 selectedKey；blocks 顺序变化后 fallback 到首块。
useEffect(() => {
  if (blocks.length === 0) { setSelectedKey(null); return }
  if (selectedKey === null || !blocks.some((b) => keyOf(b) === selectedKey)) {
    setSelectedKey(keyOf(blocks[0]))
  }
}, [blocks])
```

`keyOf(block)` 用 `header` 作 key（一份 diff 内 header 唯一；同 header
碰撞理论不可能，splitByFile 已用 `${header}-${i}` 防御）。

空 diff 走 `<div class="diff diff--empty muted">No changes since the task
started.</div>`（沿用 DiffViewer 原文案与 className，**保持视觉一致**）。

`truncated === true` 的 banner 出现在左侧 file list 顶部，不在右侧 body
顶部（不然每切一个文件都得再看一遍）。

### tasks.detail.tsx state

```ts
const [tab, setTab] = useState<TaskDetailTab>('workflow-status')
const [selectedNodeRunId, setSelectedNodeRunId] = useState<string | null>(null)
```

`tab` 与 `selectedNodeRunId` 在 page 顶层共存；jumpToFailed 同步 setState：

```ts
onClick={() => {
  if (nodeRuns.data === undefined || tk.failedNodeId === null) return
  const { runId, tab: nextTab } = nextTabForFailedJump(
    nodeRuns.data.runs,
    tk.failedNodeId,
  )
  if (runId !== null) setSelectedNodeRunId(runId)
  setTab(nextTab)
}}
```

## 数据流

| Source | 当前位置 | 新位置 | 备注 |
| --- | --- | --- | --- |
| `useTaskSync(id)` | page top | **不变** | tab 切换不影响 WS 订阅。 |
| `useQuery<Task>` | page top | **不变** | refetchInterval 不变。 |
| `useQuery<TaskNodeRuns>` | page top | **不变** | NodeRunsTable / TaskOutputPanel / TaskStatusCanvas / Drawer 都共享同一份。 |
| `useQuery<TaskDiff>` | page top | **不变** | `enabled: baseCommit !== null` 仍生效，切到 diff tab 才看，但获取已经在跑。 |
| `cancel` mutation | page top | **不变** | 按钮挪到 header，已经在那里。 |
| `resume` mutation | page top | **不变** | 同上。 |
| `selectedNodeRunId` state | page top | **不变** | 跨 tab 持久。 |

**关键设计点**：5 个 tab pane 都 `always-mount`，用 CSS `display: none` 切
换可见性。原因：

- xyflow 实例 unmount → remount 会重置 viewport（用户调好的 pan/zoom 全部
  丢失）。
- DiffViewer 已经按 react-query 拉取，首次渲染后 DOM 保留无副作用。
- 切 tab 即时（无 mount/transition 抖动），UX 更接近 IDE 多面板。

## 关键文件改动清单

| 文件 | 改动类型 | 备注 |
| --- | --- | --- |
| `packages/frontend/src/lib/task-detail-tabs.ts` | **新建** | `TaskDetailTab` 类型 + `TAB_ORDER` + `availableTabs` + `nextTabForFailedJump` 共 ~50 行纯函数。 |
| `packages/frontend/src/routes/tasks.detail.tsx` | 主改 | TaskDetailPage 重构 return；其他函数（`TaskStatusCanvas` / `NodeRunsTable` / `canvasStatus` / `noderunTone` / `isTerminal` / `taskCanvasLayoutClass` / `resumeStatus` / `resolveNodeIdFromRuns` / `resolveNodeKindFromSnapshot`）保持原样。 |
| `packages/frontend/src/components/TaskOutputPanel.tsx` | export | `collectPorts` 改 `export`，零行为变更。 |
| `packages/frontend/src/components/DiffViewer.tsx` | export + 重构 | `splitByFile` / `lineClass` 改正式 export；抽 `DiffFileBody` 单块渲染组件；`DiffViewer` 实现保持外部签名兼容。 |
| `packages/frontend/src/components/WorktreeDiffPanel.tsx` | **新建** | 二级竖向文件 tab 列 + 右侧 hunks；空 diff fallback；truncated banner 放左栏顶。约 120 行。 |
| `packages/frontend/src/styles.css` | 新规则 | `.page--task-detail` 视口锁 + `.task-detail__tab-bar` + `.task-detail__panes` + `.task-detail__pane[hidden]` + canvas-frame--task 在 tab 内拿 100% 高度（覆盖原 `70vh`） + `.worktree-diff` 两栏（`__files` 竖向 tab 列、`__body` 右栏 hunks）+ `__file-tab[aria-selected='true']` 状态。 |
| `packages/frontend/src/i18n/zh-CN.ts` & `en-US.ts` | +6 key | `tasks.tabWorkflowStatus` / `tabNodeRuns` / `tabDetails` / `tabOutputs` / `tabWorktreeDiff` / `detailsHeading`。旧 `sectionXxx` key 不删（防御其他地方引用）。 |

## 与既有模块的耦合点

1. **`NodeDetailDrawer` 内部 tabs**：drawer 自己有 prompt/events/output/stats
   4 个 sub-tab，用 `.inspector__tabs` 类。本 RFC 顶层用 `.task-detail__tab-
   bar`，CSS 类不冲突。
2. **`taskCanvasLayoutClass(selectedNodeRunId)`**：当前返回
   `'task-canvas-layout' | 'task-canvas-layout--with-drawer'`，挂在
   工作流状态 tab pane 内层，行为不变。
3. **`page--wide`**：原 `<div className="page page--wide">` 改为
   `<div className="page page--task-detail">`，删除 `page--wide`（task
   detail 不再需要内容超出主面板宽度，因为 tab pane 内部各自 overflow）。
4. **`useTaskSync(id)`** 的 invalidate 行为：依然在 page 顶层运行；tab 切
   换通过 React 状态隔离，与 WS 推送无关。
5. **`reviews/$nodeRunId` 跳转链接**：NodeRunsTable 内的 `<Link>` 不变，
   切到 reviews 路由后离开本页面。

## 失败模式与边界

| 场景 | 行为 |
| --- | --- |
| `task.workflowSnapshot` 缺失 / 不是对象 | 工作流状态 tab 显示 `tasks.noWorkflowSnapshot`（沿用原 `TaskStatusCanvas` 内部 fallback）。 |
| `nodeRuns.isLoading` | 节点运行 tab pane 显示 `common.loading`；工作流状态 tab 画布渲染但无节点状态色（同现版行为）。 |
| `nodeRuns.error !== null` | 节点运行 tab pane 显示 error-box（沿用现行）。工作流状态 tab 画布仍可见（节点无状态色）。 |
| `tk.failedNodeId` 设置但 runs 里查不到 | jumpToFailed 仍切 tab（让用户看到画布），`selectedNodeRunId` 保持 null（Drawer 不弹）。 |
| 输出 tab 切换但 `ports.length===0` 之后 workflow 重定义新增 output（极少见，不可能 mid-task 改 snapshot） | `task.workflowSnapshot` 是 frozen 副本，运行期不变。`availableTabs` 在 render 内重算即可。 |
| 用户在输出 tab 上时 hasOutputs 突变 false（理论不可能） | `availableTabs` 返回新 list，若当前 `tab` 不在新 list 内，page 在 render 时 fallback 到 `'workflow-status'`（`useEffect` 同步 setTab）。 |
| canvas viewport 切 tab 保留 | always-mount + display:none。React Testing Library 集成测试断言切到 details 时 canvas DOM 仍在 document 里、`hidden` 属性 = true。 |
| worktree diff 文件数极大（>200） | 左栏 `overflow-y: auto`，列宽固定 `width: 280px; max-width: 30%`，单 tab `white-space: nowrap; text-overflow: ellipsis; title=full-header`。右栏只渲染选中文件，DOM 不随文件数膨胀。 |
| worktree diff 在切 file tab 之间保留滚动位置 | 不保留——每选一个文件，右栏内容整块替换，`<pre>` 自带滚动重置到顶。trade-off：实现简单 + 文件切换语义清晰。后续若要保留，再加 `Map<header, scrollTop>` 缓存。 |
| diff 字符串热更新（resume 后重拉）后 selectedKey 失效 | useEffect 在 `blocks` 变化时检查 selectedKey 是否仍存在于新 blocks；不在则 fallback 到首块。 |
| diff `(preamble)` 块（rename 等特殊场景） | 与普通 file block 同样进 file tab list；header 显示 "(preamble)" 文案保留 splitByFile 行为，不特判。 |

## 测试策略

### 单测（vitest，纯函数）

`packages/frontend/tests/task-detail-tabs.test.ts`

- `TAB_ORDER` 长度 5、顺序固定。
- `availableTabs({ hasOutputs: true })` === 5 项。
- `availableTabs({ hasOutputs: false })` === 4 项，不含 `'outputs'`。
- `nextTabForFailedJump([], null)` → `{ runId: null, tab: 'workflow-status' }`。
- `nextTabForFailedJump(runs, 'agent_x')` 中 `agent_x` 有多条 run，最新
  startedAt 那条胜出。
- `nextTabForFailedJump(runs, 'unknown_node')` → `{ runId: null, tab:
  'workflow-status' }`。

### 集成（React Testing Library）

`packages/frontend/tests/task-detail-page-tabs.test.tsx`

- mock react-query + router；提供完整 Task / runs / diff fixture。
- case 1：初次渲染断言 `[role='tab'][aria-selected='true']` 文案 = "工作
  流状态"；canvas tab pane 不带 `hidden`，其他 pane 带 `hidden`。
- case 2：点 "详细信息" tab → 现 details pane（含 `dl.task-meta`）、canvas
  pane 上 hidden 出现。
- case 3：tk.status='failed' 且 failedNodeId 已设 → 在 details tab 点
  "跳到失败节点" → workflow-status tab 重新激活；selectedNodeRunId 设。
- case 4：workflow snapshot 无 output 节点 → tab bar 仅 4 个 tab；
  `'outputs'` 不出现。

`packages/frontend/tests/worktree-diff-panel.test.tsx`

- case 1：3 文件 diff 渲染 → 左栏出现 3 个 `role='tab'`，第 1 个
  `aria-selected='true'`；右栏 hunks 含该文件 `+` / `-` 行。
- case 2：点第 2 个 file tab → aria-selected 转移；右栏 header 切换；左
  栏文件顺序不变。
- case 3：空 diff（`""`） → 渲染 `diff--empty` 提示，无 file tab 列。
- case 4：`truncated === true` → 左栏顶部出现截断 banner，右栏 body 不重
  复 banner。
- case 5：diff 字符串热更换（rerender 用不同 fixture）后 selectedKey 不
  在新 blocks → 自动回退到首块（断言 aria-selected 移到新首块）。
- case 6：100 个文件 diff → 渲染时间 < 200ms（perf smoke，使用
  `performance.now()`，不当成强约束，仅 console.warn 提示）。

### 源码层兜底（regex / file assertions）

`packages/frontend/tests/task-detail-layout-viewport-fit.test.ts`

- `.page--task-detail` 含 `height: 100%`、`min-height: 0`、`overflow:
  hidden`、`display: flex`、`flex-direction: column`。
- `.task-detail__panes` 含 `flex: 1`、`min-height: 0`。
- `.task-detail__pane[hidden]` 含 `display: none`（保险，浏览器默认就有
  hidden→none，但显式声明免得后续误覆盖）。
- `.worktree-diff` 含 `display: flex`、`flex-direction: row`、`height:
  100%`、`min-height: 0`。
- `.worktree-diff__files` 含 `overflow-y: auto`、`width: 280px`（或
  `flex: 0 0 280px`）、`min-height: 0`。
- `.worktree-diff__body` 含 `flex: 1`、`min-width: 0`、`overflow: auto`。
- `.worktree-diff__file-tab[aria-selected='true']` 含选中态背景 / 边框色。
- 在 `routes/tasks.detail.tsx` 里 grep 到 `'task-detail__tab-bar'` 与
  `'task-detail__pane'`。
- `TaskOutputPanel.tsx` 含 `export function collectPorts`。
- `DiffViewer.tsx` 含 `export function splitByFile` / `export function
  lineClass` / `export function DiffFileBody`。
- `WorktreeDiffPanel.tsx` 含 `aria-orientation="vertical"`（竖向 tab
  列契约 / 兜底 a11y）。

### Playwright e2e

不新增。既有 e2e 不触及 tasks.detail；本 RFC 改动覆盖在 jsdom 集成测试足
够，避免拖慢 CI。

## 性能

- 5 pane always-mount 增量 DOM：详细信息 dl ≈ 20 节点；NodeRunsTable 行
  数 = O(node count × retries)，通常 < 100 行；TaskOutputPanel 卡片数 =
  workflow output ports 数；DiffViewer 已是按 file chunk 渲染。
- React 渲染：切 tab 不重渲染（只切 `hidden` 属性）；首次渲染时间预估与
  现行一致，因为现行也是全部 section 同时 mount。
- react-query 拉取节奏：完全不变。

## Migration

- 数据库：零。
- shared schema：零。
- i18n：新增 key 兼容旧 key；不删 `sectionXxx` 防御。
- URL：路由 `/tasks/$id` 不变；不引入 query param。

## 不在本 RFC 范围

- Tab 状态写入 URL / 浏览器历史（未来 RFC）。
- 工作流状态 tab 内 canvas 全屏按钮 / 抽屉宽度调整。
- 详细信息 tab 字段编辑（当前页本来就只读）。
