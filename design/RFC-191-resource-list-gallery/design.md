# RFC-191 · 技术设计

## 1. 新公共组件（`packages/frontend/src/components/gallery/`）

遵守 Frontend UI consistency：先复用既有原语（`Card`、`ResourceBadges`、`StatusChip`、`filterResourceCards`、`EmptyState`/`LoadingState`/`ErrorBanner`、`.btn` 族），只新增「画廊排布」这一层。

### 1.1 `ResourceGalleryPage`（页面骨架）

```ts
export interface GalleryCardItem {
  key: string
  title: string
  /** 一行截断用于过滤的副文本（描述原文；空串视为无）。 */
  subtitle?: string
  /** 标题右侧徽标（各页自装 ResourceBadges / chip）。 */
  badges?: ReactNode
  /** 描述空缺时的斜体占位文案（i18n 后的串）。 */
  subtitleFallback: string
  /** meta chips 行（各页自装）。 */
  meta?: ReactNode
  /** footer 左侧时间戳（ms）。 */
  updatedAt: number
  /** 整卡主链接。 */
  to: '/workflows/$id' | '/workgroups/$name'
  params: { id: string } | { name: string }
  /** footer 右侧「启动」深链（to 恒为 /tasks/new，search 按主体装配）。 */
  launchSearch: Record<string, string>
  testid?: string
}

export interface ResourceGalleryPageProps {
  title: string
  /** header 右侧动作区（导入 YAML / 新建按钮由调用方装配，含既有 testid/ref）。 */
  headerActions: ReactNode
  items: GalleryCardItem[] | undefined
  isLoading: boolean
  error: unknown
  searchPlaceholder: string
  emptyListText: string
  emptyTestid: string
  /** 对话框等页级附属物（QuickCreateDialog 等）作为 children 渲染在骨架之后。 */
  children?: ReactNode
}
```

职责：header 行（`.page__header--row` 现状结构）→ 搜索框（**仅 `items !== undefined && items.length > 0` 时渲染**，保证空态字节不变）→ Loading / Error / Empty 三态（既有组件 + 既有 testid 语义）→ `.gallery` 网格。**排序不在骨架内**——调用方装配 items 时按 `updatedAt` 降序 `useMemo` 排好。

过滤：骨架持有 `search` 本地 state，`filterResourceCards(search, items)` 直接复用（`GalleryCardItem` 的 `title`/`subtitle` 字段名与 RFC-169 的约束类型 `{ title: string; subtitle?: string }` 结构兼容——这是选这两个字段名的原因）。过滤后空 → `EmptyState size="compact"` + `common.noMatches`（split 页同款分支逻辑）。

### 1.2 `GalleryCard`（单卡）

基于 `Card`（RFC-124）：`<Card interactive className="gallery-card">`，body = 标题行 + 描述，footer = 时间 + 启动按钮。

**stretched-link 模式**（整卡可点且不嵌套 `<a>`）：

```
.gallery-card { position: relative; }
.gallery-card__stretch::after { content: ''; position: absolute; inset: 0; }   /* 铺满整卡的点击面 */
.gallery-card__ops, .gallery-card__badges { position: relative; z-index: 1; }  /* 按钮/徽标浮在点击面之上 */
```

- 标题文字本身是真实 `<Link className="gallery-card__stretch">`（a11y：可聚焦、名称即链接名），`::after` 把点击面扩展到整卡；
- 「启动」是独立 `<Link className="btn btn--sm btn--primary">`，z-index 高于点击面——DOM 上两个 `<a>` 是兄弟，不嵌套；
- Tab 顺序自然：卡片链接 → 启动按钮 → 下一张卡。

新 CSS 全部落 `.gallery` / `.gallery-card` 命名空间（styles.css 追加一段，token 化：`--space-*` / `--radius-*` / `var(--muted)`……），网格 `display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: var(--space-3);`。描述两行截断用 `-webkit-line-clamp: 2` + `min-height: 2 行`（卡片高度对齐，短描述不塌）。

## 2. 各页装配

### 2.1 `routes/workflows.tsx`

- 数据源不变：`useResourceList<Workflow>`（query + owners；**不再解构 `del`**）。
- items 映射：`subtitle = w.description`（空串→undefined）、meta = `<span class="chip chip--tight">v{w.version}</span>` + `<span class="chip chip--tight">{t('workflows.cardNodes', { n: w.definition.nodes.length })}</span>`、`launchSearch = { kind: 'workflow', workflow: w.id }`。
- 节点数直接 `definition.nodes.length`（schema `.default([])`，无 undefined 分支；计数含 wrapper/IO 节点，与画布所见一致）。
- 保留：导入 YAML input + 按钮、`postYaml`、QuickCreate 对话框及 `createOpenRef` 守卫——原样迁入 `headerActions` / `children` 槽。
- 删除：`ConfirmButton` 行内删除移除（入口收敛到编辑器 header，`workflows.edit.tsx` 既有）。

### 2.2 `routes/workgroups.tsx`

- meta 装配：模式 `StatusChip`（映射表新纯函数，见 §2.3）+ `{n} 成员` chip + `leader: {workgroupLeaderDisplayName(w)}` chip（仅非 null）+ `全自动` chip（`w.autonomous === true`）。
- `launchSearch = { kind: 'workgroup', workgroup: w.name }`。
- 删除：`pendingDelete` state、确认 `Dialog`、行内删除按钮全部移除（入口收敛到详情 `DetailHeaderActions`，既有）。

### 2.3 `lib/workgroup-mode.ts`（新纯函数，首选可断言面）

```ts
export const WORKGROUP_MODE_KIND: Record<WorkgroupMode, StatusChipKind> = {
  leader_worker: 'info',
  free_collab: 'neutral',
  dynamic_workflow: 'warn',
}
```

仿 `lib/task-status.ts#TASK_STATUS_KIND` 先例（单一事实源，房间/详情未来复用同色）。

## 3. `<RelativeTime>` 公共原语（决策 D4）

现状**两套并存**（dedup-audit 型重复）：

- `lib/homepage.ts#formatRelativeTime(nowMs, atMs): RelativeTimeToken` — token 版，key 挂 `home.taskRow.*`，`Math.max(0, …)` 只支持过去向；消费方 `home/task-row.tsx`、`home/InboxPreviewList.tsx`、`tasks/RecoverySection.tsx`。
- `routes/tasks.tsx#formatRelative(ts, t): string` — 字符串版，页面私有。

收敛设计：

### 3.1 `lib/relative-time.ts`（新，纯函数）

```ts
export type RelativeTimeKey =
  | 'justNow' | 'minAgo' | 'hourAgo' | 'dayAgo'      // 过去向
  | 'inMin' | 'inHour' | 'inDay'                     // 未来向（RFC-192 定时任务「下次触发」用）
export function relativeTimeToken(nowMs: number, atMs: number): { key: RelativeTimeKey; opts?: { n: number } }
```

阈值表与 `formatRelativeTime` 现行为逐档一致（<60s justNow / <60min minAgo / <24h hourAgo / 否则 dayAgo），未来向对称（<60s 也归 justNow，避免「0 分钟后」）。i18n key 落 `common.relTime.*`（zh/en 双语）。

### 3.2 `components/RelativeTime.tsx`（新）

```tsx
<RelativeTime ts={number} />  →  <time dateTime={iso} title={绝对时间 toLocaleString()}>{t(`common.relTime.${key}`, opts)}</time>
```

`now` 取渲染时刻（各列表页已有 15–30s refetch/WS 驱动重渲染，粒度足够；不加内部定时器）。repos 页已有 `<time dateTime>` 先例，语义元素沿用。

### 3.3 收敛路径与 RFC-190 并发调和

- 本 RFC：落 `lib/relative-time.ts` + `<RelativeTime>`，workflows / workgroups 卡片直接使用；`lib/homepage.ts#formatRelativeTime` 改为 delegate（内部调 `relativeTimeToken` 并映射回 `home.taskRow.*` legacy key）——**token 形状与既有 `homepage-lib.test.ts` 锁保持不变**，home 三个消费方零改动。
- home 消费方整体迁到 `<RelativeTime>` + legacy key 退役：**让路给 RFC-190（首页门户改版，Draft 并发中）**——homepage 将被 190 重写，届时直接用新原语；本 RFC 不碰 `home/*`，避免多人踩踏。
- `routes/tasks.tsx#formatRelative` 的退役放 RFC-192（该 RFC 重写任务页）。

## 4. 类型与既有共享件收缩

- `ResourceNameCell`（RFC-151）：`to` 联合类型移除 `'/workflows/$id' | '/workgroups/$name'` 两成员（迁移后仅双栏四页使用该单元格）。`resource-list-shell.test.tsx` 同步更新。
- `useResourceList`：不动（`deleteBy` 参数与 `del` mutation 保留——双栏四页详情层仍在用这个 hook 的查询部分；两页只是不再解构 `del`）。

## 5. 失败模式

| 场景 | 处置 |
| --- | --- |
| `description` 空串 | 斜体占位 `subtitleFallback`（i18n `workflows.noDescription` / `workgroups.noDescription`）；过滤时空描述不参与匹配 |
| owners 查询未命中 / 未返回 | `ResourceBadges` 现行为：owner 徽标缺省，不阻塞渲染 |
| leader 成员 id 无法解析出显示名 | `workgroupLeaderDisplayName` 返回 null → 不渲染 leader chip（现列表同语义） |
| 启动深链指向已删资源 | 向导现行为兜底（选择器空/校验拦截），本 RFC 不新增风险面 |
| QuickCreate 慢 POST + 用户先关对话框 | `createOpenRef` 守卫原样迁移（不因 late response 跳页） |
| 搜索命中 0 | `common.noMatches` 紧凑空态，与列表空态（`emptyListText`）分文案 |
| 长名称 / 长描述 | 标题单行 ellipsis + title 悬停；描述两行 clamp + title 悬停 |

## 6. 测试策略（随改动落地，不后补）

**新增：**
1. `relative-time.test.ts` — 阈值表双向逐档（59s/60s/59min/60min/23h/24h 边界 + 未来向对称 + `homepage-lib` delegate 后 token 形状不变）。
2. `gallery-page.test.tsx` — 骨架：三态渲染、搜索过滤（复用 `filterResourceCards` 的行为断言）、空列表不渲染搜索框、卡片 stretched 链接 role=link 可达、启动按钮 href（`getByRole('link', { name: 启动 })` 断言 search 参数序列化）。
3. `workflows-pages.test.tsx` **重写** — 卡片断言：节点数 chip、vN、描述占位分支、导入按钮仍在、QuickCreate 流程回归（既有断言迁移）、**不再存在删除按钮**。
4. `workgroups-pages.test.tsx` **重写** — 模式三色映射（`WORKGROUP_MODE_KIND` 表单测 + 渲染断言）、leader/全自动 chip 条件渲染、删除 Dialog 退役断言。

**锁清扫**（[feedback_grep_locks_before_push]，表级盘点）：
- `resource-list-shell.test.tsx` — `ResourceNameCell.to` 收缩后更新；
- `data-table-callsite.test.ts` — 现锁 repos/reviews/AgentImportDialog，不涉两页，不动；**新增反向锁**：`workflows.tsx` / `workgroups.tsx` 不得出现 `className="data-table"`（源级文本断言，仿既有 callsite guard 风格，放 `gallery-callsite.test.ts`）；
- `empty-loading-callsite.test.ts` / `page-hint-removal.test.ts` / `i18n-phase-a.test.ts` / `chip-row-vertical-center.test.ts` — grep 命中集逐一复核（预期兼容：空/加载态组件沿用、无新 hint、i18n 走 key）。

**e2e / 视觉：**
- `visual-regression.spec.ts` `/workflows` 空态基线**零 churn 验证**（搜索框空态不渲染 + header 结构不变）；若 CI diff 非零即回查；
- e2e 各 spec 经查不直接引用两页列表 testid（创建走 API），预期零改动；`workflow-editor.spec.ts` 回归跑通。
- 推送前 minimal-repro 明暗双主题截图，与 `/agents`（split 卡）side-by-side 比对按钮高度/圆角/间距（[feedback_frontend_visual_verify_repro]）。

## 7. 耦合点与并发

- **RFC-190（首页门户，Draft 并发）**：本 RFC 不碰 `home/*`（§3.3 让路策略）；i18n 双方都追加 key——提交按路径精确、逐 key 段追加，冲突面可调和。
- working tree 现有他人未提改动（`e2e/task-wizard.spec.ts`、backend 数文件）与本 RFC 文件集无交集；提交遵守多人并存原则（精确 pathspec）。
