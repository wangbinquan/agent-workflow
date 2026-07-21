# 前端公共原语抽取审计（2026-07-21）

> 目标：调研 `packages/frontend/src` 全量实现，找出**应抽取成公共组件 / 样式原语**、以防止未来继续出现格式与样式不一致的地方。
> 方法：23 路并行扫描（12 目录分片 + 11 横切维度）→ slug 去重 → **每候选双镜头对抗验证**（证据核实镜头 + API 可行性镜头，任一 refute 即淘汰）→ 完整性批评补扫 → 五分类撰写。
> 规模：534 个 agent、266 条原始候选、去重后 250 条进入验证，**确认 160 条 / 驳回 91 条**（驳回率 36%，说明验证不是走过场）。
>
> 本报告顶部（§0–§2、§8）是把 160 条确认项**按根因语义聚类**后的收敛视图（很多条是同一原语被不同分片各自命中，例如"ErrorBanner 重试按钮"被 4 路分别报了 30/70/61/9 次）；§3–§7 是五个分类的**逐条明细**（保留验证后的真实 `路径:行号` 与 API 草图），可追溯到源码；§9 是被对抗验证驳回的项与理由。

---

## 0. 结论摘要（TL;DR）

1. **前端 token 体系本身是健康的**（96 个 CSS 变量、2159 处 `var(--)` 引用），问题**不在"没有设计系统"，而在"设计系统被大面积绕过"**——`styles.css` 已膨胀到 17,517 行 / **1,720 个 class 选择器 / 199 个 BEM 命名空间**，其中很大一部分是各功能"图快"自写的一次性 chrome。这正是 CLAUDE.md「Frontend UI consistency」要防的回归，且已经发生。

2. **单一最大痛点 = 空/加载/错误"三态闸门"**：41 条确认项（23 条 high）都指向同一件事——已有 `EmptyState / LoadingState / ErrorBanner`，但**至少 15+ 个文件仍手拼 `<div className="muted">{t('…empty')}</div>` / 裸 spinner / 手写 retry 按钮**。根因是 `ErrorBanner` **缺 `onRetry` prop**，于是每个查询失败点都手写一个 `<button className="btn btn--sm">{t('common.retry')}</button>` 塞进 action 槽（全仓 60+ 次）。这是投入产出比最高的一抽。

3. **一批"看不见的"真实样式 bug 已经存在**（不是理论重复，是线上就错）：
   - 若干暗色覆盖**只写了 `:root[data-theme='dark']`、漏了 `@media (prefers-color-scheme)` 兜底** → 在默认 `theme='system'` 下这些规则**永远不生效**；
   - 多处 `var(--x, 字面值)` 引用的 `--x` **在全仓根本没定义** → fallback 永远命中，等于把颜色写死、绕过主题；
   - 多个 class（`chip--local` / `chip--remote` / `.error-text` / 某个关闭按钮 class / 退回原因字段 class）**在 `styles.css` 里根本不存在**，对应元素处于"裸奔"状态。

4. **同一语义色散成一片**：一个"警告琥珀"在 CSS 里有 8 种取值、一个"成功绿"有 5 种取值，全部绕开 `--warn-fg / --success`。语义色必须收敛成 token，否则每个新页面都会再挑一个"差不多的"颜色。

5. **a11y 契约漂移**：同类控件（combobox / radiogroup / 整行可点 / 单键热键守卫）在不同页面键盘行为不一致——`UserPicker` fork 了 `Select` 但**丢了整套键盘导航**且 `option` 里非法嵌了 `<button>`；`LanguageSwitch` 是 `.segmented` 的逐字 CSS fork（同一控件两套样式已各自演化）。role 契约是公共组件契约的一部分，这类漂移直接影响可用性与测试稳定性。

6. **该新建的原语很少，该"收编 + 补 prop"的很多**：真正缺的新原语只有 4–5 个（`<QueryState>`、`<CopyButton>`、`<CountBadge>`、`<MetaList>`）；其余绝大多数是**给既有组件加一个 prop**（`ErrorBanner.onRetry`、`Card.title`、`Field` 收编内联错误）或**把散落 class 收敛到既有 `.chip / .data-table / .segmented`**。这与 CLAUDE.md「最小扩展既有组件、不要 fork」完全一致。

7. **防漂移的关键不是"抽一次"，而是"抽完加锁"**：本仓已有大量源码层文本断言 / `findByRole` 契约测试。每个抽取都应配一条 grep 锁（"`navigator.clipboard` 只允许出现在 `lib/clipboard.ts`"式），否则下一个新按钮照样各写各的——**锁是这次抽取"防未来不一致"而非"减代码量"的唯一凭据**。

---

## 1. 审计方法与覆盖范围

- **扫描分片（12）**：settings / tasks / workflow-editor / canvas / workgroup / skills / review-clarify / agents / mcp-plugin-account / memory-repos / misc-pages / shared-root-components——覆盖 `routes/**` 全部 + `components/**` 全部子目录。
- **横切维度（11）**：CSS 三段通读（1–6000 / 6000–12000 / 12000–17517 行）、设计 token 一致性、既有原语绕开检测、暗色/主题覆盖、a11y/交互契约、列表行/表格、空/加载/错误三态、弹窗/表单动作、工具栏/筛选/搜索/分页。
- **验证**：每条候选跑 2 个独立镜头——① 证据核实（逐行 Read 核对行号真伪 + 形态同构性 + 是否已有原语覆盖 + 去重后是否 ≥3 处）；② API 可行性（会不会 config 地狱 / 是否应改成最小扩展 / 测试源码锁与迁移风险 / 是否真能防漂移）。任一镜头 refute 即淘汰。
- **诚实声明**：本报告只覆盖**样式/组件层重复**；纯业务逻辑重复、i18n 文案重复不在范围内。§3–§7 的行号均来自验证镜头亲自 Read 确认的集合；§0–§2 的聚类计数是对 160 条确认项按标题关键词归并的结果，可能有 ±2 条边界归类误差，不影响优先级判断。

---

## 2. 优先级路线（按"能防住多少未来不一致"排序）

聚类后的原语簇（`#项`=归入该簇的确认条数，`#high`=其中 high 影响，`Σlocs`=去重后涉及的出现点总数）：

### P0（先做，高频 + 已产生可见 bug/不一致）

| 原语 | 类型 | #项 | #high | Σlocs | 新建 or 扩展 |
|---|---|---:|---:|---:|---|
| **三态闸门 `<QueryState>` + `ErrorBanner.onRetry`** | 新建 + 扩展 | 41 | 23 | ~670 | 新建 `<QueryState>` 包 loading/empty/error/data；给 `ErrorBanner` 加 `onRetry` |
| **行内状态徽标收编到 `<StatusChip>` / `.chip`** | 收敛 | 16 | 10 | ~224 | 收编十余个 `X__status/__badge` 命名空间；补 `chip--local/remote` 缺失规则 |
| **语义色 token（success/warn/danger）** | token | 11+ | 5 | ~249 | 把 8 种琥珀 / 5 种绿收敛到 `--warn-fg/--success/--danger` |
| **`<FormDialog>` / `<DialogActions>`** | 新建 | 6 | 6 | ~143 | 抽弹窗 footer 按钮组（顺序 + 尺寸 + pending + 提交错误位统一） |
| **主题/暗色真实 bug 修复** | bugfix | 9 | 3 | ~189 | 补 `@media` 兜底、修未定义 `var()`、修不存在的 class |

### P1（高价值，但改动面或风险中等）

| 原语 | 类型 | #项 | #high | Σlocs | 新建 or 扩展 |
|---|---|---:|---:|---:|---|
| **combobox/单选 a11y 契约** | 修复+收敛 | 12 | 8 | ~136 | 修 `UserPicker` 键盘/非法 DOM；`LanguageSwitch` 收回 `Segmented` |
| **`<ClickableRow>` 整行可点** | 新建 | 5 | 5 | ~91 | 统一 hover/事件守卫/键盘打开（distill 行当前无法键盘打开） |
| **字号/间距/z-index token 补全** | token | 16 | 4 | ~328 | 补 13px/10px 字号 token、z-index 分层；收敛裸 px |
| **`<CopyButton>`** | 新建 | 6 | 3 | ~92 | 内部走 `lib/clipboard.ts::copyText`，统一成功/失败反馈 |
| **`<MetaList>` / `.meta-grid`（key:value 网格）** | 收敛 | 3 | 2 | ~52 | 收敛"Flat 族"dl 网格（列宽/间距/字号统一） |

### P2（低频 / 收益偏代码量 / 需产品拍板视觉）

`<CountBadge>` 计数角标（3 套漂移）、`RelativeTime` 收编绝对时间戳（20+ 处手写 `toLocaleString`）、`FormSection` 收编 fork 的裸 `<details>`、`Card.title` prop、`.data-table` 收编 `.account-table`、`× 关闭` 图标按钮、Inspector 抽屉头、`NoticeBanner` 收编平行横幅、字节格式化统一、`prefers-reduced-motion` 覆盖补全、两栏浏览器版式、`focus-trap` 浮层收回 `Dialog`。明细见 §3–§7 各条。

---

## 3. JSX 重复实现（jsx-duplication）

# JSX 重复实现审计（jsx-duplication）

本章汇总前端在 JSX 层的重复实现。多条围绕「ErrorBanner + 重试按钮」的发现由不同分片独立报出，实为同一根因的不同切面，已在下文分别列出并交叉引用；落地时应合并为一次 `ErrorBanner.onRetry` 扩展 + 一个 `RetryButton` 原语，一次收编全仓。

---

### 1. 复制到剪贴板按钮 4 处各写各的，反馈/尺寸/i18n key 全不同

**现状证据**
- `routes/account.tsx:549`、`553` — 复制 PAT/指纹，无反馈
- `components/canvas/EdgeInspector.tsx:191` 与 `components/canvas/NodeInspector.tsx:238` — 用 `editor.nodeActions.copy` 而非 `common.copy`，无反馈
- `components/NodeDetailDrawer.tsx:611`/`615` — 文件私有 `CopyButton`，有 `copied` 反馈但不处理 rejection
- `components/TaskOutputPanel.tsx:290` — 直接 import `copyText`（`lib/clipboard.ts:10`）
- `components/review/ReviewDocPane.tsx:365`/`370` — 唯一带失败提示的实现

**已产生的不一致**
四种行为：account 无反馈；两个 inspector 无反馈且用了另一套 i18n key；NodeDetailDrawer 有 `copied` 但 Safari/权限拒绝时静默无事发生（缺 rejection 分支，且绕开 RFC-072 非安全上下文降级）；只有 ReviewDocPane 才有失败提示。按钮尺寸 `btn--sm` / `btn--xs btn--ghost` / `btn--ghost btn--xs` 三种写法。

**建议** — 新建公共原语 `components/CopyButton.tsx`（**内部一律走已存在的 `copyText()`**，不要以 NodeDetailDrawer 的私有实现为基线上提，那份恰缺 rejection 分支）：

```tsx
// components/CopyButton.tsx（新建）
interface CopyButtonProps {
  text: string;
  size?: 'xs' | 'sm';            // 默认 'sm'
  variant?: 'ghost' | 'default';
  label?: React.ReactNode;        // 默认 t('common.copy')
  copiedLabel?: React.ReactNode;  // 默认 t('common.copied')
  testid?: string;
  className?: string;
  announce?: boolean;             // 可选 ManagedLiveRegion 播报，默认 false
}
// 内部：void copyText(text).then(ok => ok ? setCopied() : setFailed())
// 成功/失败各 1500ms 复位；失败文案新增 common.copyFailed（中英同步）
```

替换范围 = 4 处 + 1 处收编：account.tsx（用 `label` 覆写避免动 `account.copy` key）、NodeDetailDrawer（删私有函数，调用点 296 改用组件）、EdgeInspector/NodeInspector（切到 `common.copy`，**但 `editor.nodeActions.copy` 仍被 `WorkflowCanvas.tsx:2386`「复制节点」使用，不准删**）、TaskOutputPanel。**明确排除 ReviewDocPane**（形态不同 + RFC-009 源码锁）。

**迁移风险**
- 源码锁两处必须同批改：`tests/review-sidebar-rfc-009-enhancements.test.ts:85-93` 锁死 ReviewDocPane 须保留内联 `navigator.clipboard.writeText` + `copiedId`/`copyFailedId`；`tests/task-output-panel-source-guards.test.ts:43-46` 锁 TaskOutputPanel 须直接 import `copyText`——替换后改为断言引用 `CopyButton`，并把 `copyText` 锁迁到 `components/CopyButton.tsx`。
- `tests/task-output-panel.test.tsx:165/173` 用 `getByTestId('task-output-copy')` 且断言 `.disabled === true`——testid/disabled 须原样透到真实 `<button>`，不能包 wrapper span。
- 否决「grep 锁 `navigator.clipboard.writeText` 只允许出现在 `lib/clipboard.ts`」这条——它与 RFC-009 正向断言冲突；要加锁请写白名单式：只允许 `lib/clipboard.ts` 与 `components/review/ReviewDocPane.tsx`。
- i18n 新增 `common.copyFailed` 须中英两份同时加（显式 interface，漏一边 typecheck 红）。
- `components/canvas/*` 与 i18n 双 bundle 是高频并发文件，按精确路径 `git commit -- <paths>`。

**优先级** — high（3 个分片独立报出）

---

### 2. ErrorBanner 的「重试」按钮在 30+ 处手工拼装

**现状证据**
`routes/settings.tsx:247`/`1415`、`routes/account.tsx`（7 处）、`routes/tasks.detail.tsx`（8 处：374/549/689/1012…）、`components/memory/*`（7 处）、`components/gallery/ResourceGalleryPage.tsx:95`、`components/split/ResourceSplitPage.tsx:344`、`components/home/*`（RunningTaskList/RecentlyDoneList/CapabilityGrid/InboxPreviewList）、`routes/index.tsx:27`、`components/workflow-editor/WorkflowDraftStatus.tsx:102`/`185` 等。

**已产生的不一致**
目前形态基本一致，属「即将漂移」——尺寸/文案/`void` 包装靠人工复制。仅 `routes/index.tsx:27` 一处带 `disabled`+`aria-busy`；任何一处改 `btn--xs` 或加 loading 态就分叉。

**建议** — 两层一次落地：

```tsx
// components/RetryButton.tsx（新建）
interface RetryButtonProps {
  onRetry: () => void | Promise<void>;
  pending?: boolean;      // disabled + aria-busy
  size?: 'sm' | 'xs';     // 默认 'sm'
  label?: string;         // 默认 t('common.retry')
}
// 内部固定 type="button"、btn btn--{size}

// components/ErrorBanner.tsx（扩展既有）
interface ErrorBannerProps {
  // …既有
  onRetry?: () => void | Promise<void>;  // 与 action 互斥，同传 dev warn 且 action 优先
  // ⚠️ onRetry 必须计入内部 hasAction 判定，否则 error-banner--with-action class 漏加致布局变化
}
```

迁移顺序：ErrorBanner 包裹的调用点（`action={retryAction}` → `onRetry`）→ 删 `tasks.preview.tsx:53` 私有 RetryAction → gallery/split 两处条件包装 → home/* 4 处用 `size="xs"`。

**迁移风险**
- **源码文本锁（必须同批改写）**：`tests/resource-detail-query-state.test.ts:27-34`（RFC-198 PR4 ratchet）对 `agents/mcps/plugins/skills.detail.tsx` 断言含 `{t('common.retry')}` + `action={retryDetailAction}`（≥2 次且在 `<DetailHeaderActions` 之后）；`tests/settings-system-agents.test.ts:68` 与 `tests/account-users-settings-table-shell.test.ts:82` 锁 `settings.tsx` 同一字符串（同文件两个 tab）；`tests/repos-page.test.tsx:44` 锁 `repos.tsx`（未列入候选，属被牵连的第 16 处）。改造须保留原意图，注释写明理由，不能删。
- **行为锁（保持 accessible name 即绿）**：25+ 处 `getByRole('button', { name: /retry|重试/i })`。但若 pending 态加 `disabled`，`fireEvent.click` 在 disabled 时不触发——`memory-actor-query-continuity.test.tsx:184,224`、`account-query-continuity.test.tsx:204-303` 这类在 `isFetching=true` 中间态点击的 continuity 测试要逐一确认不会静默失效。
- i18n `home.section.error.retry` 合并属 key 迁移，本次只用 `label` prop 兼容，不动 key。
- `settings.png` 视觉基线覆盖 settings 默认 tab 的 retry 按钮，size/间距偏移需刷基线。
- 触点 90 处、30+ 文件，按目录分批精确 pathspec 提交。避免 RetryButton 演化成半吊子通用 Button（禁 variant/tone/icon）。

**优先级** — high（2 个分片）

---

### 3. 「复选框 + 标签行」没有公共原语，Form.tsx 只有 Switch

**现状证据**
`components/agents/DependencyAutodetectDialog.tsx:65`、`components/fusion/FuseDialog.tsx:174`、`components/launch/FilesPicker.tsx:101`/`178`、`components/launch/EnumPicker.tsx:65`、`components/structure/StructuralGraph.tsx:425`、`components/structure/StructuralDiffView.tsx:277`、`components/NodeDetailDrawer.tsx:195`（`.checkbox-inline`，全仓仅此）。`components/Form.tsx` 只 export `Field/TextInput/NumberInput/TextArea/Switch`，无 Checkbox。

**已产生的不一致**
FilesPicker/StructuralDiffView 的裸 input 完全无 `aria-label`（MemoryRow 有）；`disabled` 态只有 NodeDetailDrawer 与 QuestionForm 处理；account.tsx 额外做 `--checked` 高亮而其他行没有——同一交互 7 处 7 种可访问性与视觉水平。

**建议** — 在 `components/Form.tsx` 新增单一原语 `<Checkbox>`（不要同时上 CheckboxRow + CheckboxList 两层）：

```tsx
// components/Form.tsx 内新增（扩展既有）
interface CheckboxProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: React.ReactNode;       // ReactNode，可传 chip/<code>/swatch，勿拆成 string
  hint?: React.ReactNode;
  disabled?: boolean;
  'aria-label'?: string;
  'data-testid'?: string;
  density?: 'compact' | 'comfortable';  // 覆盖 FilesPicker 密排 vs 卡片留白两档
}
// 结构必须 label.form-checkbox > input[type=checkbox] 直挂 + {label}
```

收编 6 处：DependencyAutodetectDialog、FuseDialog、FilesPicker×2、EnumPicker（仅 multi 分支）、StructuralGraph、StructuralDiffView、NodeDetailDrawer（随之删 `.checkbox-inline`）。**保留独立**：account.tsx pat-scopes 卡片式行（后续单独立 `<ChoiceCard>`）。**明确排除**：MemoryRow、WorktreeDiffPanel、QuestionForm（clarify 专用带键盘导航）、EnumPicker radio 分支（应走 `.segmented`）。

**迁移风险**
- **最硬源码锁**：`tests/files-picker.test.tsx:193` 断言 `getAllByRole('checkbox').map(cb => cb.parentElement?.textContent)`——checkbox 的 parentElement 必须仍是含标签文本的 `<label>`，内部若再包 span/div 立刻红。结构必须 `label > input` 直挂。
- `data-testid` 须原样透到 input 本体（不能挂外层 label）：`autodetect-checkbox-${group}-${row.name}`、`memory-row-${id}-select`、`clarify-custom-checkbox`。`fuse-dialog-entry.test.tsx:138` 用单数 `getByRole('checkbox')`，迁移后多一个 checkbox 就 multiple-match 报错。
- `worktree-diff-panel.test.tsx:376-386` 锁 Space keydown 源自 checkbox 时列表不再 toggle——别动 WorktreeDiffPanel。
- 无 i18n 迁移（文案在调用方）。`.form-checkbox` 不设 gap/padding/font-size 则无需刷视觉基线；一旦统一密度须 light+dark 最小 repro 核验。
- Form.tsx / styles.css 高冲突面，精确 pathspec 提交。

**优先级** — high（2 个分片）

---

### 4. 绝对时间戳格式化在 20+ 处各写一遍 `new Date(x).toLocaleString()`

**现状证据**
`components/NodeDetailDrawer.tsx`（353/357/479/563/585/598）、`components/tasks/TaskFeedbackList.tsx:221`、`components/memory/distill-job-detail/DetailHeader.tsx`（60/65/71）、`components/ScheduleDialog.tsx:95`、`components/gallery/GalleryCard.tsx:71`、`components/mcps/McpInventoryPanel.tsx:442`、`routes/scheduled.tsx:190`、`routes/scheduled.$id.tsx:194`/`254`、`routes/tasks.detail.tsx:947`/`952`/`1577`/`1685`、`lib/node-prompt.ts:67` 等 20+ 处。既有 `components/RelativeTime.tsx` 按 RFC-191 D4 只覆盖相对时间，绝对时间无原语。

**已产生的不一致**
(a) 三种精度混用（`toLocaleString` / `toLocaleTimeString` / `{dateStyle:'medium',timeStyle:'short'}`），`tasks.detail:947` 与 `:1577` 同页出现完整日期与纯时间；(b) 空值兜底两套（`t('common.emDash')` vs 硬编码 `'—'`，`scheduled.$id.tsx:194` 绕过 i18n）；(c) 只有 RelativeTime 输出语义化 `<time dateTime>`，这 20+ 处全裸文本；(d) 无一处带 title 完整时间戳。

**建议** — 先落纯函数再包 JSX（`precision` 按代码实际 4 种取值，删原提案无用例的 `'date'`）：

```ts
// lib/absolute-time.ts（新建，复用 lib/relative-time.ts 的 toEpochMs）
type Precision = 'datetime' | 'time' | 'medium' | 'short';  // 默认 datetime
export function formatAbsolute(ts: number | string | null, precision?: Precision): string | null;
```

```tsx
// components/AbsoluteTime.tsx（新建，formatAbsolute 的 JSX 包装）
// null → t('common.emDash')；否则 <time dateTime={iso} title={完整 datetime}>
```

纯函数供字符串上下文（`reviews.tsx:270`、`McpInventoryPanel.tsx:442`、`GalleryCard.tsx:71` 拼 tooltip、`lib/node-prompt.ts:67` 非 React）。`RelativeTime.tsx:27` 的 title 也改调 `formatAbsolute` 使两原语同源。

**迁移风险**
- `tests/relative-time.test.ts:112` 用 `new Date(NOW-50_000).toLocaleString()` 断言 title——改 title 实现须保持等价输出。
- 行为变更两处须显式承认并配测试：`McpInventoryPanel:442` 的 `String(ms)` 回落改 em-dash；`TaskFeedbackList:221`/`clarify.tsx` 等无兜底处脏数据从 `Invalid Date` 变 em-dash。
- 约 30 处从裸文本变 `<time>`，`getByText`/`textContent` 不受影响但按 `td > span`/`firstChild` 取结构的断言会破（重点跑 `scheduled-detail-style.test.tsx`、`distill-job-detail-*`、`review-decision-info.test.tsx`、`gallery-page.test.tsx`）。
- 零新增 i18n key（`common.emDash` 已在 `en-US.ts:750`）。属非平凡跨模块重构，按 CLAUDE.md 需先走 RFC。`tasks.detail.tsx` 超大热点文件精确 pathspec。

**优先级** — medium

---

### 5. 「loading / error+重试 / 空列表」三态 gate 在列表与详情页重复 15+ 次

**现状证据**
`components/memory/*`（MemoryAllList/ApprovalQueue/ByScopeBrowser/DistillJobsTable/FusionList/ScopedList 六处）、`routes/repos.tsx:106`、`routes/scheduled.tsx:104`、`routes/tasks.tsx:209`、`routes/reviews.tsx:105`、`routes/clarify.tsx:198`、`routes/users.tsx:124`、`components/gallery/ResourceGalleryPage.tsx:121`、`components/split/ResourceSplitPage.tsx:387`。三个叶子原语（LoadingState/ErrorBanner/EmptyState）存在，但「怎么组合成三态」无原语。

**已产生的不一致**
loading 判据 4 种写法：`isLoading` / `isLoading && data === undefined` / `data === undefined` 外层 + 内层 `isLoading`；memory/* 六处带一条不可达的 `return <LoadingState />` 兜底（永久转圈），路由页没有——同状态 `/memory` 转圈、`/tasks` 空白。空态判据也分裂：`repos/scheduled/tasks/users` 各写 `isInitialEmpty`（users 版漏 `!isLoading`），`reviews/clarify` 直接 `data.length === 0` 不排除 loading。

**建议** — **优先落 hook 而非渲染型组件**：

```ts
// hooks/useQueryState.ts（新建）
function useQueryState<T>(
  query: UseQueryResult<T>,
  opts?: { isEmpty?: (data: T) => boolean }
): { state: 'loading' | 'error' | 'empty' | 'ready'; data?: T; error: unknown; isStaleError: boolean; retryAction: ReactNode };
// loading 统一为 isLoading && data === undefined
```

```tsx
// components/QueryStateSlot.tsx（新建，薄，只管 loading/error 两态）
// empty 留给调用方（EmptyState 的 title/description/icon/action 因页而异）
```

迁移顺序：memory/* 六处 → ResourceGalleryPage/ResourceSplitPage 内部（惠及 6 个路由）→ `repos/scheduled/tasks/users` 删手算 `isInitialEmpty` → `reviews/clarify` 补 loading 排除。顺手删 memory/* 不可达兜底（是删死代码，commit 别声称修转圈）。

**迁移风险**
- **强测试锁**：`tests/memory-panels-async-state.test.tsx`（RFC-198 专写）文件头明写「future refactor 须保 initial LoadingState、ErrorBanner+Retry、real empty、background refresh 失败时保留 cached rows」——`useQueryState` 必须同时暴露 `state` 和 `isStaleError`，否则「背景刷新失败仍显缓存行」变红。另 8 套按 testid 断言（`users-page-actions`、`memory-approval-queue`、`resource-split-*`、`scheduled-list-inline`、`tasks-list-surgery`、`repos-page-batch-button` 等）。
- **源码文本锁**：`tests/rfc203-fork-zero-source-lock.test.tsx:37,44` 全量扫 `src/**`，禁自写 `className="error-box"`，要求错误走 `describeError`；新建文件须复用 `ErrorBanner`。
- **行为变更非纯重构**：`users.tsx:92` 缺 `!isLoading`，统一后不再闪空态；`tasks.tsx` 三个 empty 分支（`isInitialEmpty`/`isStatusEmpty`/过滤态空）不能被单一 `state==='empty'` 吞掉。
- 零 i18n 迁移（标题/描述仍由调用点传）。属非平凡重构，需先走 RFC。styles.css 共享热点精确 pathspec。

**优先级** — high

---

### 6. 「表单弹窗」骨架（Dialog + Cancel/Submit footer + pending + 提交错误）被 20+ 处逐字手写

**现状证据**
`components/ScheduleDialog.tsx:174`、`components/workgroup/WorkgroupTaskConfigDialog.tsx:118`、`WorkgroupMemberCards.tsx:48`/`86`、`DynamicWorkflowPanel.tsx:357`、`WorkgroupRoom.tsx:1346`、`tasks/QuestionAuthorForm.tsx:89`、`memory/MemoryDialogShell.tsx:91`、`QuickCreateDialog.tsx:76`、`RenameDialog.tsx:74`、`agent-ports/AgentPortDialog.tsx:388`、`fusion/FuseDialog.tsx:126`、`clarify/CentralizedAnswerDialog.tsx:364`、`ConfirmDialog.tsx:98`。只有 Dialog 提供 footer 插槽。

**已产生的不一致**
四维分叉：(a) 按钮尺寸 `btn` vs `btn--sm`；(b) 提交错误放 footer span / body ErrorBanner / 不展示；(c) pending 时是否换文案/禁用 Cancel/aria-busy；(d) 是否锁 ESC+遮罩。最明显：`DynamicWorkflowPanel.tsx:362` vs `:367` 同一 footer 里 Cancel 是默认 `.btn`、Submit 是 `.btn--sm`，高度不一致。

**建议** — 分两层，且**必须与既有 `ConfirmDialog` 合流**（否则抽取本身造第二套 footer）：

```tsx
// components/DialogActions.tsx（新建，薄 footer 原语，唯一事实源）
interface DialogActionsProps {
  error?: React.ReactNode;
  extra?: React.ReactNode;          // wg-config-empty-hint / AgentPortDialog role=alert
  cancelLabel?: string; onCancel: () => void;
  submitLabel: string; pendingLabel?: string;
  pending: boolean; canSubmit: boolean;
  tone?: 'default' | 'danger';
  onSubmit: () => void;
  testidPrefix?: string;
  size?: 'md' | 'sm';               // 两按钮同尺寸，修 DynamicWorkflowPanel 高度不齐
}
// 主按钮 aria-busy={pending || undefined}；Cancel pending 时 disabled

// components/FormDialog.tsx（新建）= Dialog(dismissDisabled={pending}) + DialogActions + children
```

第 3 步：把 `ConfirmDialog` footer 改为复用 `DialogActions`（其 pending/error 竞态状态机保留内部）。迁移由低到高：QuickCreate/Rename/MemoryDialogShell → ScheduleDialog/WorkgroupMemberCards×2/… → DynamicWorkflowPanel 顺手修尺寸。

**迁移风险**
- **AST 棘轮**：`tests/overlay-ux-inventory.test.ts` 是逐文件 exact-equality 的 47-callsite 清单 + family/owner 校验——不改 `isSharedOverlayImport` 迁移第一处即红；`tests/dialog-scroll-layout.test.ts` 锁 `.dialog__panel/__body/__header/__footer` CSS 契约与 `@media(max-width:720px)` 下 `flex-wrap:wrap`——FormDialog 必须经 Dialog 的 footer 槽输出，不得自建 chrome。
- **class 文本锁**：`tests/confirm-dialog.test.tsx:58` 断言主按钮 className 恰为 `'btn btn--primary'`（加 `btn--sm` 会红）；`tests/mcps-page-wiring.test.ts:68,71` 断言 contains `'btn btn--primary'`；`tests/plugins-page-wiring.test.ts:97,104` 断言 **not** contains `'form-actions__error'`（RFC-151 已改 ErrorBanner，不得倒灌 span）；`tests/form-invalid-no-banner.test.tsx:151,172,192` 断言无效表单时 `.form-actions__error` 为 null——FormDialog error 须「仅提交失败才渲染」。
- **testid 异构**：`wg-config-submit`、`workgroup-add-agent-confirm`、`${prefix}-create-confirm` 等必须原样透传每处**现有** testid，不能统一成 `${prefix}-submit`；`workflows-pages.test.tsx:581` 用 `.dialog__footer .btn--primary` 定位。
- i18n：`scheduled.cancel`/`memory.formCancel`/`taskQuestions.author.cancel` 与 `common.cancel` 值相同，迁移前核 zh-CN 同值再删；`fusion.cancel = 'Cancel fusion'` 语义不同勿误伤。建议保持显式 label，key 合并另开。
- `WorkflowCanvas.tsx` 的 Dialog callsite 走 portal，不在 ReactFlow 树内、不触碰其 `selectionOnDrag` 锁。

**优先级** — high

---

### 7. 「ErrorBanner + 重试按钮」被手工拼了 70 多次（首页/侧栏/memory 分片）

**现状证据**
`routes/index.tsx:27`/`46`/`66`、`routes/scheduled.tsx:91`/`105`、`routes/scheduled.$id.tsx:82`/`153`、`components/home/RunningTaskList.tsx:56`、`RecentlyDoneList.tsx:56`、`InboxPreviewList.tsx:64`、`components/shell/InboxDrawer.tsx:301`、`components/home/CapabilityGrid.tsx:105`、`components/memory/*`（ScopedList/DistillJobsTable/ApprovalQueue/FusionList/ByScopeBrowser/AllList）、`components/skill/SkillVersionHistory.tsx:118`。全仓 `t('common.retry')` 命中 70+ 处。

**已产生的不一致**
`routes/index.tsx` 裸 `btn`（大一号）、三个 home 列表 `btn--xs`、InboxDrawer `btn--ghost btn--xs`（幽灵）。文案键三套：`common.retry` / `home.section.error.retry` / `nav.inbox.retry`，中文都是「重试」。只有 `routes/index.tsx` 带 `disabled`+`aria-busy`。`CapabilityGrid.tsx:102-109` 不是 ErrorBanner，是 `<div className="home-cap__error" role="status">`。

**建议** — 同条目 2 的 `ErrorBanner.onRetry` + `RetryButton`，附四点修正：
1. **不新增 `retrySize`**：把 `size` 提升为 ErrorBanner prop，由它推导重试按钮尺寸（`comfortable→btn--sm`、`compact→btn--xs`）。`routes/index.tsx` 裸 `btn` 归一到 `btn--sm`（缩一档，PR 点明）。
2. **必须补 `retryAriaLabel?: string`**：InboxDrawer 可见文案「重试」但 aria-label 是 `nav.inbox.retryFeed`，`tests/inbox-drawer.test.tsx:369-379` 按该名查询。
3. **`CapabilityGrid` 单独处理**：改用 ErrorBanner 会把 `role="status"` 变 `role="alert"`（打断读屏），剔出本次范围或在 RFC 拍板。
4. 删 `home.section.error.retry`/`nav.inbox.retry` 须同改 zh-CN/en-US 的 type 声明块与值块两处。

**迁移风险**
- **最大阻碍**：`tests/resource-detail-query-state.test.ts:27-29` 对 `agents/mcps/plugins/skills.detail.tsx` 源码断言 `toContain("{t('common.retry')}")` 且 `action={retryDetailAction}` ≥2 次——改 `onRetry` 立刻红，须改写 ratchet 并保留 RFC-198 PR4 原意注释。
- 84 处 `common.retry` 里相当一部分**不是** query 重试语义（`McpInventoryPanel.tsx:178` `runSaved`、`MultiDocReviewView.tsx:623` `selectionMut.mutate`、`workflow.retryAccess`、`agent-import` 的 `retry: 'Retry import'`）——不得一刀切吞掉，真实靶子约 42 文件的 ErrorBanner+refetch。
- `retrying={q.isFetching}` 会让后台轮询期间按钮反复变灰闪烁，应用 `isRefetching` 或由调用方显式传。
- `styles.css:1530` `.error-banner--with-action > span` 对 DOM 结构敏感，`hasAction` 未扩到 onRetry 会静默丢布局，须最小 repro 截图核验。

**优先级** — high

---

### 8. 「查询三态闸门 + 重试按钮」在 16+ 文件逐字重复（memory 分片主视角）

**现状证据**
`components/memory/*`（MemoryByScopeBrowser:26/32、ScopedList:35/41、DistillJobsTable:36/42、FusionList:31/37、AllList:224/231、ApprovalQueue:58/64）、`routes/memory.tsx:163`、`routes/repos.tsx:85`、`routes/memory.distill-jobs.$jobId.tsx:124`、`components/memory/MemoryDialogShell.tsx:126`、`routes/settings.tsx:332`、`routes/workgroups.detail.tsx:190`、`routes/workflows.edit.tsx:229`、`routes/reviews.detail.tsx:410`/`501`、`components/review/MultiDocReviewView.tsx:299`。

**已产生的不一致**
`MemoryScopedList` 用 `<LoadingState size="compact" />`，同分片其余五处默认尺寸；`MemoryFusionList` 额外包 `<div data-testid="memory-fusion-error">`（41/53/69）别处没有；`routes/memory.tsx:163-170` 与 `MemoryApprovalQueue:64-70` 同形不同序。`if (data===undefined){…return <LoadingState/>}` 尾巴 16 处各抄一遍，漏一处即永久空白。

**建议** — 分两层，不一把梭：

```tsx
// T1（低风险先做）：components/ErrorBanner.tsx 加 onRetry + retryTestid
// 84 处按钮 className 100% 是 btn btn--sm 且无 testid，纯机械替换

// T2（范围收窄，仅 components/memory/ 六个逐字克隆）
// components/QueryBoundary.tsx（新建）
interface QueryBoundaryProps<T> {
  query: UseQueryResult<T>;
  loading?: { size?: 'compact' | 'default' };
  empty?: { title: string; description?: string; testid?: string };
  errorTestid?: string;
  children: (data: T) => React.ReactNode;   // 非空时 stale-error 顶部条
}
```

**明确排除 T2**：`repos.tsx`（`isLoading + isInitialEmpty`）、`reviews.detail`/`workflows.edit`/`workgroups.detail`/`MultiDocReviewView`/`memory.distill-jobs.$jobId`（页壳变体，只吃 T1）。后续另立 `<PageQueryBoundary>`，勿给 QueryBoundary 加分支 prop。

**迁移风险**
- `tests/memory-fusion-tab.test.tsx` 锁 `memory-fusion-error` testid——去掉包裹 div 后 testid 落 NoticeBanner 根，先读该测试查询方式。
- `MemoryScopedList` 的 `size="compact"` 与其余默认是真实视觉差异，RFC 显式拍板。
- **源码锁**：`tests/repos-page.test.tsx:44` 硬锁 `'<ErrorBanner error={list.error} action={retryAction} />'`；`resource-detail-query-state.test.ts` 四文件锁 `{t('common.retry')}` + `action={retryDetailAction}` ≥2 且第二处在 `<DetailHeaderActions` 之后；`fusion-detail-ux.test.ts` 锁 `fusions.detail.tsx`。改 A 迁移须重写这些断言。
- render-prop children 改渲染时序，须确认 `MemoryApprovalQueue` 的 `editingId` 等 useState 不因包装层重挂载丢失。
- ErrorBanner 已被 RFC-203 三层 resolver 深改、横跨 42 文件，加 prop 严格向后兼容并定义 `action`/`onRetry` 并存语义。

**优先级** — high

---

### 9. 「候选下拉 + 值失效高亮 + 保留失效值为 missing 选项」在 inspector 手写 8 次

**现状证据**
`components/canvas/inspector/OutputEdit.tsx:94`/`140`、`ReviewEdit.tsx:137`/`180`、`WrapperGitLoopEdit.tsx:167`/`205`/`371`/`403`。已用 Select，但「失效值保留 + 无效高亮 + 空占位项 + 错误行」每处重抄。

**已产生的不一致**
(1) 空占位文案三套（`inspector.upstreamPlaceholder` / 字面 `'—'` / `inspector.loopExitNodeIdSelect`）；(2) 失效解释文字只有 WrapperGitLoopEdit 有（`form-input__error`），Output/Review 静默；(3) mono 字体只 loop outputBindings 两处加 `form-input--mono`，同页 exitCondition 两处没加；(4) 上游候选 label 规则各写一遍（`OutputEdit:33-39`/`ReviewEdit:58-64`/loop 两处）。

**建议** — 抽 `components/canvas/inspector/RefSelect.tsx` + 纯函数：

```tsx
// components/canvas/inspector/RefSelect.tsx（新建，薄封装 NodeRefSelect/PortRefSelect）
interface RefSelectProps {
  value: string;
  candidates: { value: string; label: string }[];
  emptyLabel: string;         // 空占位项 label
  ariaLabel: string;          // 与 emptyLabel 独立，勿合并
  invalidMessage?: string;
  mono?: boolean; searchable?: boolean; disabled?: boolean;
  onChange: (v: string) => void;
  'data-testid'?: string;
}
// 内部：invalid = value.length>0 && !candidates.some(c => c.value===value)
//   options = [{value:'',label:emptyLabel}, ...candidates, ...(invalid ? [missingOption] : [])]
//   form-input--invalid（+ 可选 --mono）拼到 Select className；invalid && invalidMessage 渲染 form-input__error
```

候选来源提纯函数（放 `components/canvas/wrapperCandidates.ts` 旁或新建 `lib/workflow-upstream-candidates.ts`），label 格式化抽 `formatRefLabel(title, id)`（收敛第三种变体——**行为变更**：loop 下拉 label 在 `title===id` 时从 `id (id)` 变 `id`，PR 明确并更新断言）。空占位/invalidMessage 保持调用点传入（不做 key 合并）。

**迁移风险**
- `tests/wrapper-loop-inspector.test.tsx:147` 断言 `getByTestId('loop-exit-node-select').classList.contains('form-input--invalid')`——class 必须仍落在带 testid 的 Select trigger 上（不能挪外层 wrapper）；同文件 110/130/252/254 依赖 `loop-exit-node-select`/`loop-exit-port-select` testid 与 option label 文本 `/\(a2\)/`。
- `tests/i18n-batch-extraction.test.ts:102-103` 锁 `inspector.missingOption` 须含 `{{value}}`，不可删改。
- `tests/ux-source-ratchets.test.ts:95-103` 的 `INPUT_IMPLEMENTATION_ALLOWLIST` 含 `Select.tsx`/`OutputEdit.tsx`/`WrapperGitLoopEdit.tsx`——扩展 Select 零棘轮改动；但 `ReviewEdit.tsx` 不在名单，别往里搬裸 input。
- i18n placeholder 同时充当 ariaLabel 与空占位 label，**必须保留 ariaLabel 与 emptyLabel 两独立 prop**，否则破 `getByRole(name)`。给 Output/Review 补 `form-input__error` 需新 key（中英+类型三处），且工作树已有他人未提 i18n 改动，精确 pathspec。
- 三种 `InspectorFieldAnchor`/`InspectorPortAnchor`/`InspectorHistoryBoundary` 包裹层次不同，抽取须保持不变（否则破坏「点校验错误跳字段」的 anchor 与撤销边界）。onChange 联动语义不同（保留只覆盖渲染层，勿吞 onChange）。

**优先级** — high

---

### 10. 计数/状态角标（neutral|attention|danger 三色小圆丸）在三个公共组件各写一份

**现状证据**
`components/Select.tsx:52`/`64`（`SelectOption.badgeTone`）、`components/TabBar.tsx:343`/`345`（`TabBadgeTone`）、`components/PageSectionNav.tsx:282`/`294`（`PageSectionBadgeTone`）；CSS `styles.css:656`/`4468`/`4808`。

**已产生的不一致**
三处基底样式不一致：背景 `var(--bg)` / `color-mix(text 10%)` / `var(--panel)`；font-weight 700/600/700；`min-height:18px` vs `height:18px`（后者换行被压扁）。`--attention`/`--danger` 修饰符三处逐字重复。TS 侧三个同义 union。

**建议** — 新建 `components/CountBadge.tsx`，导出唯一 `BadgeTone`：

```tsx
// components/CountBadge.tsx（新建）
type BadgeTone = 'neutral' | 'attention' | 'danger';  // 导出，供三处复用
interface CountBadgeProps {
  value: React.ReactNode;
  tone?: BadgeTone;            // 默认 neutral
  ariaLabel?: string;         // 非 neutral 强制要求（保留 TabBar 判别式约束）
  testid?: string;
}
// CSS 收敛为 .count-badge + .count-badge--{tone}；尺寸统一到 min-height（修压扁 bug）
```

修正：(1) 保留 TabBar 非-neutral 强制 ariaLabel 的判别式（TabBadgeStatus 55-65），别拍平成可选；(2) 不把 TabBar 的 `margin-left:6px` 烤进 base（间距交容器）；(3) `--space-1=4px≠6px`，用 `var(--space-1)` 会 6→4px 回归，间距不要塞进 base；(4) `.sidebar__badge`（`styles.css:314`）与 ~6807 两个单-tone count-pill 需明确纳入或声明 out of scope。

**迁移风险**
无测试锁 `select__badge`/`tabs__tab-badge`/`page-section-nav__badge` 类名、tone 修饰、`data-tone`（唯一 badge 测试 `task-workflow-cell-overflow.test.ts` 锁的是另一个 `.task-workflow-cell__badge`，须排除）。接线保真：AgentForm 经 `TabBar.badgeTestid` 下发 `agent-tab-ports-badge`/`agent-tab-resources-badge` 须保留；`data-tone` 属性三处保留。三处 base 背景真不同，收敛属视觉决策，需 light+dark 双主题像素验证。无 i18n/xyflow 约束。

**优先级** — high

---

### 11. portal 到 body 的下拉浮层（定位 style + 外部点击关闭 + role=listbox）写了三份

**现状证据**
`components/Select.tsx:288`/`296`、`components/MultiSelect.tsx:296`、`components/UserPicker.tsx:162`/`68`。既有 `hooks/usePopoverPosition.ts` 只抽了定位计算。

**已产生的不一致**
(1) `style={{position:'absolute', left, top, minWidth}}` 逐字重复三处；(2) 外部点击 useEffect 逐字重复（MultiSelect 与 UserPicker 连注释都对应）；(3) CSS 命名空间分叉（`.select__listbox` vs `.user-picker__results/__option/__empty`，边距/hover 不一致）；(4) **行为分叉**：Select/MultiSelect 有 ↑↓/Home/End/Enter/Esc + `aria-activedescendant`，UserPicker 完全无键盘导航（`<li><button role="option">` 只能 Tab 逐个走）。

**建议** — 抽 `components/PopoverListbox.tsx`（构建于 `usePopoverPosition` 之上）：

```tsx
// components/PopoverListbox.tsx（新建）
interface PopoverListboxProps {
  anchorRef: React.RefObject<HTMLElement>;
  open: boolean;
  listId: string;
  'aria-multiselectable'?: boolean;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  onRequestClose: () => void;   // 外部点击 + Esc
  className?: string;           // 合并各自命名空间
  children: React.ReactNode;    // option 渲染 / searchable input / 异步结果留给调用方
}
// 接管 portal + usePopoverPosition + 外部点击/Esc + aria-controls（Dialog.isFocusInsideDialog 依赖）
// 顺带给 UserPicker 补键盘导航 + aria-activedescendant，统一 .popover-listbox/__option/__empty
```

三者差异（单/多选、searchable input、异步 useQuery、`aria-multiselectable`）以 children/props 保留，避免退化成塞满 boolean 的巨壳。

**迁移风险**
`usePopoverPosition` 是 RFC-173 T1 既有原语，须构建其上；`aria-controls`/id 契约被 `Dialog.isFocusInsideDialog` 依赖，抽取时 popoverId 布线不能断，须与 Dialog 焦点判定对齐测试。测试可能锚 `.select__listbox`/`.user-picker__option`/`role=listbox`/`testidPrefix`，改类名/DOM 前 grep 源码锁（含 e2e/），UserPicker 补键盘后新增键盘路径测试。**属非平凡重构，需走 RFC + 用户批准**。

**优先级** — medium

---

### 12. 「这个 ReactNode 算不算存在」守卫函数在 5 个公共组件各写一份

**现状证据**
`components/NoticeBanner.tsx:82`、`components/PageHeader.tsx:20`、`components/Card.tsx:51`、`components/Select.tsx:48`、`components/PageSectionNav.tsx:278`、`components/TabBar.tsx:343`。

**已产生的不一致**
六处语义相同写法四套（具名 `isPresent`/`hasBadge`/内联 `!= null && !== false`/内联三段比较）；Card 用宽松 `!= null`，其余严格三段。空字符串 `''` 在所有实现里都算「存在」，`header={cond && ''}` 会渲染空 `.card__header`（Card.tsx:48-50 注释记录的 RFC-124 Codex P3 近亲）。

**建议** — 在 `lib/react-node.ts` 导出唯一谓词：

```ts
// lib/react-node.ts（新建）
export function isRenderable(node: React.ReactNode): boolean;
// 六处全改用；删 isPresent/hasBadge 具名 + TabBar/Card 内联三段
// 关键：显式冻结 '' 决策（当前六处一致把 '' 视为「存在」）
```

若 `isRenderable` 决定把 `''` 也算「不存在」，会改 Card 现有行为，须连同 RFC-124 注释一起评审并补锁定该决策的测试（`undefined/null/false → 不存在`，`'' 与 0/非空节点 → 按拍板口径`）。

**迁移风险**
`tests/card.test.tsx:24-25`/`40-46` 用 `.card__header/.card__footer + toBeNull` 锁 null/false 槽位缺失（Codex P3 回归），`isRenderable` 须保持该语义。无测试按名引用 `isPresent`/`hasBadge`，重命名安全。**唯一真风险**：`''` 处理决策——当前无测试覆盖 `''` 分支，改口径是静默行为变更（空串 title/badge 的 wrapper 消失），必须保持现语义或另立带测试的独立项。收益偏小（主要是统一命名 + 冻结 `''` 决策）。

**优先级** — low

---

### 13. 下拉/搜索 popover 的「加载中 / 无结果」三态在三个 picker 各写一套

**现状证据**
`components/Select.tsx:334`、`components/MultiSelect.tsx:311`/`315`、`components/UserPicker.tsx:175`。MultiSelect 内部的 `.select__empty` + `loadingLabel` prop 已成契约，未被 UserPicker/FilesPicker 复用。

**已产生的不一致**
(1) UserPicker 自建 `.user-picker__empty`（`styles.css:14116`，padding 8px/13px）而非复用 `.select__empty`（`styles.css:15662`），内边距字号不同；(2) UserPicker 的 li **没有 `role="presentation"`**（Select/MultiSelect 有）——空态行被读屏当可选项播报；(3) 加载文案 key 三种（`common.loading`/`dependencyTreePreview.loading`/`launch.filesPicker.loading`）。

**建议** — 抽 `components/SelectStatusRow.tsx`（label-only，默认文案留调用点）：

```tsx
// components/SelectStatusRow.tsx（新建）
interface SelectStatusRowProps {
  state: 'loading' | 'empty';
  label: React.ReactNode;   // 承接 noMatches / emptyLabel / loadingLabel / noResults
}
// 固定 role="presentation" + .select__empty
```

范围只限 `role="listbox"` popover 内的 `<li>`：Select:334、MultiSelect:311/315、UserPicker:175；UserPicker 删 `.user-picker__empty` 改 `.select__empty` 并补 `role="presentation"`（本次最实 a11y 修复）。**明确排除** NodeDependencyTreeSection:62 与 FilesPicker:140（内联 `.muted` 非 listbox 行）。

**迁移风险**
- **源码锁·会红**：`tests/inline-loading-ban.test.ts`（RFC-151/173）维护 allowlist，UserPicker/MultiSelect 在名单里正因它们 inline 了 `t('common.loading')`；两条断言（名单外禁引用 + 名单内每项须仍引用否则 prune）。**建议 label-only 且默认文案留调用点**——UserPicker/MultiSelect 仍引用 `common.loading`，allowlist 基本不动。
- `tests/multi-select.test.tsx:259-262` 用 `loadingLabel="Loading skills…"` + `getByText`——只要新组件把 label 作文本渲染即过。
- 删 `.user-picker__empty` 前已核实全仓仅 1 定义 + 1 使用、无 dark 覆盖，安全。无 i18n 重排、无 xyflow。

**优先级** — medium

---

### 14. 详情路由的「加载 / 出错 / 404」三态外壳被逐个路由手拼

**现状证据**
`routes/workflows.edit.tsx:229`、`routes/agents.by-id.tsx:34`、`routes/workgroups.by-id.tsx:45`、`routes/fusions.detail.tsx:89`、`routes/scheduled.$id.tsx:70`。PageHeader/LoadingState/ErrorBanner/EmptyState 都在，但「三态门」组合每路由自拼。

**已产生的不一致**
`agents.by-id`/`workgroups.by-id` 把 404 渲染成 `<EmptyState title=资源不可用>`，而 `workflows.edit`/`fusions.detail`/`scheduled.$id` 把 404 混进 ErrorBanner；标题不统一；LoadingState 有的带 label（`workflows.edit:248` 传 `editor.loadingWorkflow`）有的裸调——同一「打开已删资源」看到两种页面。

**建议** — 新增门原语，但归一化两类调用方：

```tsx
// components/DetailPageGate.tsx（新建）
interface DetailPageGateProps {
  // 归一化适配层：真详情路由传 react-query，重定向壳传 {isLoading,error,isReady}
  gate: { isLoading: boolean; error: unknown; isReady: boolean; refetch: () => void };
  title: string;
  notFoundTitle?: string;
  children: () => React.ReactNode;  // 就绪返回正文
}
// isLoading→LoadingState；ApiError 403/404→EmptyState(resourceUnavailable)；其他 error→ErrorBanner+retry
```

先落 3 个真详情路由（`fusions.detail`/`scheduled.$id`/`workflows.edit`，契约干净），把「404→EmptyState」收敛为全局一致，消灭「已删资源两种页面」漂移。重定向壳（`agents/workgroups.by-id` 用 `useResolveResourceName` 返回 `{name,isError,error,refetch}`，且「解析成功跳转中」仍渲染 LoadingState 兜底、不渲染正文）作为第二批或保留其 EmptyState 分支。

**迁移风险**
- **AST 棘轮**：`route-ux-inventory.test.ts`（RFC-198）强制 `scheduled.$id` 源码 import 并直接渲染 `<PageHeader>`（mode:'direct'），HeaderOwnership 只白名单 PageHeader/ResourceGalleryPage/ResourceSplitPage；`resource-detail-query-state.test.ts` 锁 `action={retryDetailAction}` ≥2 次。各出现点还有 owner 测试：`scheduled-detail-style.test.tsx`（rendered，断言 `.page__actions`/`role=banner`/stale-retry）、`fusion-detail-ux.test.ts`、`workflows-pages.test.tsx`、`task-subject-by-id-resolver.test.tsx`。
- `resourceUnavailable`/`common.retry` 既有 key 无迁移。`workflows.edit` 正文是 `<WorkflowEditorLoaded>`（画布），gate 只碰 `data===undefined` 外壳、画布在 gate 返回 null 后才挂载——须保证 gate 不改「query.data 存在才 mount 画布并以 id 做 key」的时序。

**优先级** — high

---

### 15. 「ErrorBanner + 重试」查询失败重试块（reviews/clarify 分片）

**现状证据**
`routes/reviews.detail.tsx:469`、`components/review/MultiDocReviewView.tsx:305`/`558`/`614`、`routes/clarify.detail.tsx:609`、`routes/clarify.tsx:200`、`routes/reviews.tsx:301`/`376`、`routes/tasks.tsx:122`。

**已产生的不一致**
`routes/reviews.tsx:294-313` 的 HistoryRows/RoundRows 没用 ErrorBanner，自写 `.reviews-version-loading`/`.reviews-version-error` 两 div，用另一套 key `reviews.loadVersionsFailed` + `reviews.retry`（与 `common.retry` 重复）——失败态没有 ErrorDetails/hint/raw 折叠、颜色不一致。`MultiDocReviewView:614-630` 的 selectionMut 重试是 `mutate(variables)` 且带 disabled，其它全 refetch 不 disable。`reviews.detail.tsx` fork 了 local helper `queryError`。

**建议** — 给 ErrorBanner 加 `onRetry` + `retryPending`，再加薄封装 `<QueryError>`：

```tsx
// components/ErrorBanner.tsx（扩展）：onRetry?: () => void; retryPending?: boolean;（onRetry 存在时透传按钮 disabled）

// components/QueryError.tsx（新建薄封装）
interface QueryErrorProps {
  query: UseQueryResult<unknown>;
  testid?: string;
  message?: string;   // 保留 reviews.tsx 现有「Failed to load version history.」
}
// error→ErrorBanner、onRetry=refetch、retryPending=isFetching
```

把 `reviews.tsx` **两处**手写 div（HistoryRows 294-313 + RoundRows 369-388）都换 QueryError，删 `reviews.retry`(234)/`reviews.loadVersionsFailed`(233) 重复 key 与 `.reviews-version-error` 规则。`selectionMut(614-630)` 是 mutation，保留 `action` 插槽写法，不强塞。

**迁移风险**
- **testid 契约**：`review-detail-query-continuity.test.tsx:285` 用 `findByTestId('review-historical-body-error')`；`reviews.detail` 还发 `review-diff-versions-error`/`review-diff-body-error`/`review-versions-error`/`review-diff-body-stale-error`——QueryError 必须把 testid 透给 ErrorBanner（NoticeBanner 根落 `data-testid`）。
- `clarify-list-route.test.tsx:204` 用 `getByRole('button', {name:/retry|重试/i})`——onRetry 渲染真 button 即过。
- i18n：删 `reviews.retry` 须 `en-US.ts:234` + `zh-CN.ts:409`(接口 type) + zh-CN 值三处同改；`reviews.loadVersionsFailed` 若保留文案则不能删。
- `reviews.tsx` 的 `.reviews-version-error` 是紧凑内联行且不经 `resolveApiError`，直接换 QueryError 会同时改文案（丢 loadVersionsFailed）和视觉尺寸——**非无损重构**。`isFetching→disabled` 是新增行为，须带测试。

**优先级** — high

---

### 16. 「加载 / 出错+重试 / 空 / 内容」四态区块被逐处手拼（account/skill 分片）

**现状证据**
`routes/account.tsx:562`/`670`/`768`、`components/skill/SkillVersionHistory.tsx:115`/`198`、`components/tasks/TaskFeedbackList.tsx:185`、`routes/mcps.detail.tsx:157`、`routes/plugins.detail.tsx:364`。

**已产生的不一致**
account.tsx 空态用 `<p className="account-empty">`（13px muted 纯文字），SkillVersionHistory/TaskFeedbackList 用 `<EmptyState size="compact">`（带图标/标题框）——同 App 里「无数据」两种视觉。account/skill 把 error 分支写两遍（`data===undefined` 一份、data 已有一份），重试按钮 size 各写各的。

**建议** — 按两种真实形态拆分：

```tsx
// components/QuerySection.tsx（新建，有 empty + children）
interface QuerySectionProps<T> {
  query: UseQueryResult<T>;
  empty?: { title: string; description?: string; testid?: string };
  onRetry: () => void;
  loadingSize?: 'compact' | 'default';
  errorMessage?: (err: unknown) => string;  // TaskFeedbackList 需自定义文案
  children: (data: T) => React.ReactNode;
}
// loading→error(retry)→empty(统一 EmptyState)→children；data 已有+error 非空→顶部 stale-error 条

// components/QueryGate.tsx（新建，门变体，无 empty/children）
// mcps.detail / plugins.detail 的 form===undefined 早返回门：loading/error/null
```

删 `.account-empty` + 三份 `<p>`，空态统一 EmptyState。account/skill 的 mutation-error banner（create/revoke/restore/remove）留在原语之外。

**迁移风险**
`account-query-continuity.test.tsx`（RFC-198 PR4）实为 QuerySection 的 spec（initial loading、initial error+retry、stale actor/sessions/identities error 保留 sections+就地 retry、`noSessions` 恒可见）；`task-feedback-list.test.tsx` 锁 `task-feedback-empty`/`task-feedback-error` testid + role retry + 自定义 message；mcps/plugins detail 锁 `mcp-detail-loading`/`plugin-detail-loading` testid（须透传）。`account-empty` class 无断言删除安全。SkillVersionHistory error 分支 `error` 可能为 null，抽象须容忍。TaskFeedbackList 标准化上 stale-error 属行为变更，须补测试。

**优先级** — high

---

### 17. 资源列表页「表格页骨架」被 7 处逐字手写

**现状证据**
`routes/tasks.tsx:209`、`routes/scheduled.tsx:104`、`routes/repos.tsx:106`、`routes/users.tsx:124`、`routes/reviews.tsx:105`、`routes/clarify.tsx:198`、`components/memory/MemoryDistillJobsTable.tsx:42`。既有 `components/gallery/ResourceGalleryPage.tsx` 与 `ResourceSplitPage.tsx` 已封装同骨架。

**已产生的不一致**
retry 按钮 JSX 8 份拷贝；loading testid 有的有（`tasks-loading`/`scheduled-loading`/`repos-loading`/`reviews-loading`）有的没有（users/clarify/memory）；TableViewport `minWidth` 各写（tasks/scheduled/memory=lg、reviews/clarify=md、`scheduled.$id`=sm、repos/users 不传）；「列表空」与「筛选无匹配」只有 tasks/reviews/clarify 分了。

**建议** — 分两步：

```tsx
// 第一步（低风险立即做）：ErrorBanner 加 onRetry（同条目 2），收敛 8 份 retry 拷贝

// 第二步：components/table/ResourceTablePage.tsx（新建，与 ResourceGalleryPage 同签名族）
interface ResourceTablePageProps<T> {
  title: string; headerActions?: React.ReactNode;
  isLoading: boolean; error: unknown; onRetry: () => void;
  items: T[];
  emptyListText: string; emptyDescription?: string; emptyIcon?: React.ReactNode;
  emptyAction?: React.ReactNode; emptyTestid?: string; loadingTestid?: string;
  minWidth?: 'sm' | 'md' | 'lg';
  toolbar?: React.ReactNode;   // 必需：承接 tasks 的 status-filter、reviews/clarify 的 Segmented
  children: React.ReactNode;   // 只留 <thead>/<tbody>
}
```

**迁移风险**
table 页在 PageHeader 与 `<table>` 之间夹异构工具栏（tasks status-filter chips + Segmented + 搜索、reviews/clarify Segmented），users 外层包 `isActorLoading`/`!allowed` 权限门整段 wrapper——`ResourceTablePage` 若直接吞 PageHeader 会冲突，须加 `toolbar` 插槽且特殊处理 users 的 gated 分支（要么 users 不接入）。全量 shell 抽取有真实设计摩擦。第一步 onRetry 收敛可独立先行，触 8 调用点须 grep testid/role 源码锁。

**优先级** — high

---

### 18. 「data / isLoading / error」三态渲染在 tasks 巨型组件手拼一遍

**现状证据**
`routes/tasks.preview.tsx:154`/`186`/`215`、`routes/tasks.detail.tsx:1004`/`1092`、`routes/tasks.new.tsx:1378`。

**已产生的不一致**
tasks.preview 三处一律 `size="compact"`，`tasks.new:1378` 默认尺寸；tasks.detail 有 data 时把 error 降级为顶部横幅、无 data 时整体替换，tasks.new 则永远并排渲染 loading 与 error（**可能同时出现**）。

**建议** — 新增 `<QueryBoundary>`（或纯函数 `renderQueryState`）：

```tsx
// components/QueryBoundary.tsx（新建）
interface QueryBoundaryProps<T> {
  query: UseQueryResult<T>;
  loading?: React.ReactNode;     // 吸收 size="compact" 与可选 label（tasks.detail 的 loadingDiff）
  errorAction?: React.ReactNode; // 吸收 preview 的 RetryAction 与内联 btn 差异
  empty?: React.ReactNode;
  children: (data: T) => React.ReactNode;
}
// 有缓存 data → error 降级为顶部 ErrorBanner 继续渲染；无 data → error→loading→null 整块替换
// 收进 error!==null && error!==undefined 样板
```

`tasks.new.tsx:1380` 收编属**行为变更**（现状 loading+error 可同现），须先写红后写绿锁定「loading 与 error 互斥」。

**迁移风险**
tasks.* 路由巨型组件，抽取须保留差异：retry action 两形态（RetryAction vs 内联 btn）与 loading 可选 label（`tasks.loadingDiff`）做成 slot。grep 未见对这些面板 DOM/class/testid 的源码文本锁（`worktree-diff`/`md-preview-truncated`/`loadingDiff`/`wizard-workflow-load-error` 均无引用），迁移锁风险低；但集成测试可能断言 `role=status`（LoadingState）/ErrorBanner，须跑 vitest + Playwright。`preview.tsx` 局部 `RetryAction` 需提升为共享组件。无 i18n/xyflow 约束。

**优先级** — medium

---

### 19. JSON 只读展示 `<pre>{JSON.stringify(x, null, 2)}</pre>` 各处手写

**现状证据**
`components/mcps/McpInventoryPanel.tsx:254`/`320`/`429`、`components/tasks/TaskDiagnosePanel.tsx:180`、`components/NodeDetailDrawer.tsx:601`。既有 `JsonField` 只面向可编辑表单。

**已产生的不一致**
McpInventoryPanel 一文件三份用两种 class（`mcp-inventory__tool-schema` / 裸 pre），滚动换行不同；无一处做截断或 overflow-x 容器，超长 schema 撑横面板（违反「宽内容自带 `overflow-x:auto` 容器」规范）。

**建议** — 新建 `<JsonPre>`：

```tsx
// components/JsonPre.tsx（新建）
interface JsonPreProps {
  value: unknown;         // 非字符串自动 stringify(…,null,2)；字符串原样透传（对应 601 string|object 分支）
  maxHeight?: number;
  collapsible?: boolean;  // details/summary，覆盖 320 tool schema / 180 diagnose / 254 error 折叠
  wrap?: boolean;         // 保留 diagnose-180 (pre-wrap+max-width:360px) 与 events-601 (pre-wrap+max-height:180px)
  'data-testid'?: string;
}
// 默认 pre.json-pre overflow:auto + mono token；顺带修 254/429 无 overflow-x 横撑 bug
```

**迁移风险**
溢出策略不真正统一：mcp 系（254/320/429）要横滚，diagnose-180 与 events-601 依赖 pre-wrap 换行（各有 max-width/max-height）——JsonPre 须暴露 `wrap`+`maxHeight`，否则改变现有换行/高度（视觉回归）。折叠形态不一（320 details 包 pre、254 外部 button+条件渲染走 i18n `showDetail`/`hideDetail`、180 details），`collapsible` 须兼容。**保留 testid**：`mcp-tool-schema-${name}`、toggle testid、`error-detail-toggle`。需新起 `.json-pre` 命名空间 CSS。

**优先级** — low

---

### 20. 纵向文件列表 tablist（roving tabindex + ↑↓/Home/End）被抄了三份

**现状证据**
`components/WorktreeDiffPanel.tsx:153`/`243`、`components/TaskOutputPanel.tsx:99`/`131`、`components/structure/StructuralDiffView.tsx:521`。`TabBar.tsx:12` 注释按 design §D2 有意把纵向排除 v1。

**已产生的不一致**
`tabRefs` Map + 焦点推进 + `tabIndex={isActive?0:-1}` + `tabDomIds(...)` 逐字重复；行为分叉：WorktreeDiffPanel 用 Space 切「已读」，TaskOutputPanel 用 Space/Enter 选中（Space 语义相反），StructuralDiffView 都没有；点击/onFocus 同步 rovingIndex 方式不同。缩进硬编码分叉（`paddingLeft: 8 + depth*14` 在 WorktreeDiffPanel:269/286 与 StructuralDiffView:529、`depth*16` 在 WorktreeFilesPanel:270）。

**建议** — 抽 hook（**优于扩展 TabBar，避免动 §D2**）：

```ts
// hooks/useRovingTablist.ts（新建）
function useRovingTablist<K>(opts: {
  keys: K[];
  activeKey: K;
  onSelect: (k: K) => void;
  orientation: 'vertical';
  activation: 'manual' | 'automatic';  // 保留三处分歧
  onSpace?: (k: K) => void;             // toggle-viewed / select / 无
}): { getTabProps: (k: K) => object };
```

Space 语义/选中同步做成配置项（非零配置抽取）。缩进统一成 CSS 变量 `--tree-indent` + `style={{'--depth': depth}}`——但 `WorktreeFilesPanel:270`（`depth*16`、`aria-pressed` 树）是第 4 个结构不同消费者，缩进统一**作为独立低风险改动**，勿与 tablist 键盘/焦点抽取混做。

**迁移风险**
- **硬棘轮** `tab-callsite-contract.test.ts`（RFC-198 PR4）：`VERTICAL_TRUE_TAB_CALLSITES` 断言三文件各渲染字面 `role="tablist"`/`role="tab"` 各 1、0 个 `<TabBar>`、含 `aria-orientation="vertical"` 字面；`TRUE_TAB_CALLSITES` 精确白名单直接否掉「扩 TabBar」支——hook 支须保持 role/aria 为字面 JSX，禁 spread-props。
- `task-output-panel-source-guards.test.ts`（RFC-072）文本锁 PANEL 必含 `role="tablist"`/`aria-orientation="vertical"`/`role="tab"`/`role="tabpanel"`/`aria-controls={ids.panelId}` 且禁 `role="listbox"`——抽 hook 不能把字面移出 TaskOutputPanel.tsx。
- 三处行为分歧被行为测试锁死不可抹平：`task-output-panel.test.tsx`（manual activation，ArrowDown 只移 tabIndex）、`worktree-diff-panel.test.tsx`（automatic + Space=toggle-viewed）、`structure-view.test.tsx`（automatic + 导航跟随 `fileTreeRows` 视觉序）。事件挂载点不同（两处挂容器 onKeyDown、TaskOutputPanel 挂单 tab 按钮）+ key 类型不同（string vs number）——hook 需泛型 K。当前无测试覆盖三组件的键盘 handler，须新补回归测试。

**优先级** — high

---

### 21. split 页右栏空态 4 个路由各自定义一份同文案组件

**现状证据**
`routes/mcps.tsx:119`、`routes/plugins.tsx:126`、`routes/agents.tsx:159`、`routes/skills.tsx:95`。i18n key 已存在（`en-US.ts:973-974` `splitPage.emptyPaneTitle`/`Hint`）。

**已产生的不一致**
skills 版多包一层 `.skills-empty-pane` div（额外定位/间距），另三个没有——同位置空态在 `/skills` 与 `/mcps` 上下留白不同。

**建议** — 从 `components/split/` 导出零-prop 组件：

```tsx
// components/split/SplitEmptyPane.tsx（新建）
export function SplitEmptyPane() {
  return <EmptyState title={t('splitPage.emptyPaneTitle')} description={t('splitPage.emptyPaneHint')} />;
}
// 四路由 IndexRoute 直接 component: SplitEmptyPane，删各自 XxxEmptyPane
```

skills 的 `.skills-empty-pane` 漂移二选一：(a) 若四页本该有 flex/gap/overflow 容器，并入公共容器 class；(b) 否则删 `.skills-empty-pane`（`styles.css:16403`）让四页归一。

**迁移风险**
grep `EmptyPane`/`skills-empty-pane`/`SplitEmptyPane`/`emptyPaneTitle` 在测试全无命中，无源码/role 锁。i18n key 原样复用无迁移。`.skills-empty-pane` 已确认仅 `skills.tsx:98` 单点引用，删除安全；删前 light+dark 对比 `/skills` 与 `/mcps`（内容仅 title+description，实际影响预期为零）。

**优先级** — low

---

### 22. Inspector 抽屉头（rail/content 双形态 + 标题块 + × 关闭）在三抽屉各写一遍

**现状证据**
`components/canvas/NodeInspector.tsx:189`、`components/canvas/EdgeInspector.tsx:124`、`components/NodeDetailDrawer.tsx:159`。既有 `DetailLayout`/`DetailHeaderActions` 面向页面级 detail，不覆盖 inspector 抽屉。

**已产生的不一致**
标题元素 class 三处两套（`inspector__title` vs `inspector__kind`）；`tabIndex={-1}`（焦点落点 a11y 契约）NodeInspector/EdgeInspector 有、NodeDetailDrawer 没有（从画布跳转到运行抽屉焦点无法落标题）；NodeDetailDrawer 无 rail/content 双形态分支，compact 视口拿不到 sr-only heading。

**建议** — 抽 `components/InspectorHeader.tsx`：

```tsx
// components/InspectorHeader.tsx（新建）
interface InspectorHeaderProps {
  chrome: 'rail' | 'content';
  headingId: string;          // NodeDetailDrawer 的 ariaLabelledBy 依赖，须透传
  title: React.ReactNode;
  subtitle?: React.ReactNode; // 吸收 summary / edge 无 subtitle / nodeDrawer 的 code+id
  onClose: () => void;
}
// 统一 header 结构、统一标题 class（选定 inspector__title）、恒定 tabIndex={-1}、统一 close 按钮、content 形态 sr-only heading 兜底
```

NodeDetailDrawer 恒 rail 语义（传 `chrome='rail'` 并补此前缺失的 `tabIndex={-1}`——本次 dedup 顺带修的 a11y，属期望非回归）。

**迁移风险**
全量 grep 对 `inspector__title/kind/close/header/summary/id` 零命中——无源码 class 锁，DOM 重排安全（相关测试走 `getByRole('combobox')`/`nodeTitle` 纯函数/`clearSelection`）。**主风险**：提案硬编码 `inspector__title` 会重设计 EdgeInspector + NodeDetailDrawer 两标题的字号/字重/大小写/颜色（styles.css 两套 class 实测不同），**须以 variant 规避**否则是未声明视觉回归。NodeDetailDrawer 带 TabBar 且 `ariaLabelledBy={NODE_DETAIL_DRAWER_HEADING_ID}`，`headingId` 透传不变否则 TabBar aria 关联断裂。close 按钮统一依赖 icon-button 候选，若被否则退化为内联。三抽屉非画布节点内，无 xyflow 约束。

**优先级** — high

---

### 23. 「技术细节」折叠块（details + summary + dl(kind/id) + 复制按钮）三处手写、结构各异

**现状证据**
`components/canvas/NodeInspector.tsx:228`/`238`、`components/canvas/EdgeInspector.tsx:185`/`191`、`components/AgentForm.tsx:474`。（复制按钮实横跨 5 站点：+ `TaskOutputPanel.tsx:236`、`ReviewDocPane.tsx:370`、`NodeDetailDrawer.tsx:615`）

**已产生的不一致**
三处共用同一 i18n summary key 却分属两个 class 命名空间（`inspector__technical` vs `agent-resources__technical`）；展开状态只有 AgentForm 记忆（`open`/`onToggle`），另两处每次重开塌陷；键值表 dl vs p 不一致；复制按钮 `navigator.clipboard?.writeText` 逐字复制两遍且都无成功反馈。

**建议** — 抽 `<TechnicalDetails>` + 复用条目 1 的 `<CopyButton>`：

```tsx
// components/TechnicalDetails.tsx（新建）
interface TechnicalDetailsProps {
  className?: string;   // 统一两个命名空间
  items?: { label: string; value: string; copyable?: boolean }[];  // Node/Edge 走 items
  extra?: React.ReactNode;  // AgentForm 只用 extra（说明段 p + DependencyTreePreview）
  rememberKey?: string;     // 解决 xyflow inspector 因 node.id 变更 re-mount 致 <details> 塌陷
}
```

CopyButton 收编 3 处裸无反馈站点（NodeInspector:241、EdgeInspector:194、`account.tsx:553`）；NodeDetailDrawer:615 与 ReviewDocPane:370 已自带 `.then` 反馈，可选迁移不强制（勿盲目降级）。

**迁移风险**
- **AgentForm 排除**：`agent-resources-groups.test.tsx:83-99` 硬锁 AgentForm 那处（`.closest('details')`、summary 文案 "Technical information"、`.dep-tree__empty`、"file:// cache"、`defaultTechnicalDetailsOpen→open`、点 summary 收起）——纳入这些断言全红，故 AgentForm 用 `extra` 槽或直接排除。
- 两处 inspector 的 dl/kind/id DOM 无测试锁（grep 不到 `technicalKind`/`inspector__technical`），重构低风险但须补 role/text 断言。
- CSS：`inspector__technical` / `inspector__technical--node`（styles.css:6611 有 border）/ `agent-resources__technical` 三个独立块，共享组件须用 variant 复原 `--node` border。
- summary 复用 `agentForm.technicalDetailsSummary`、copy 复用 `common.copy`/`common.copied` 无 key 迁移。ReviewDocPane 已自带 aria-live 复制反馈区（`ReviewDocPane.tsx:783`），纳入 CopyButton 须避免双 aria-live 重复播报。

**优先级** — medium

---

### 24. 三个 portal 下拉各自 inline 写同一段绝对定位 style 对象

**现状证据**
`components/Select.tsx:297`、`components/MultiSelect.tsx:303`、`components/UserPicker.tsx:167`。既有 `usePopoverPosition` + `.select__listbox--portal` class。

**已产生的不一致**
三处目前一致，但 z-index 分落 `styles.css:594`（`.select__listbox` = 1200）与 `styles.css:14231`（`.user-picker__results` = 1200）两条独立规则，任一方调整不带另一方。

**建议** — 抽 `<PortalListbox>`（与条目 11 的 PopoverListbox 可合并为一次落地）：

```tsx
// components/PortalListbox.tsx（新建）
const PortalListbox = forwardRef<HTMLUListElement, {
  anchorRef: React.RefObject<HTMLElement>;
  open: boolean;
  className?: string;      // 合并 multi-select__listbox / user-picker__results
  onKeyDown?: (e: React.KeyboardEvent) => void;
  children: React.ReactNode;  // ...aria-* rest-props 透传
}>(...);
// 内部 usePopoverPosition + createPortal + 定位 inline style + .portal-listbox 承载统一 z-index=var(--z-modal-popover)
```

迁移后删 `styles.css:594`（`.select__listbox` z-index）与 `14231`（`.user-picker__results` z-index），收敛到 `.portal-listbox` 单一规则。

**迁移风险**
无测试按 listbox class 名或 portal DOM 结构做源码锁；`select-searchable.test.tsx` 走 `getByRole('option')`，保留 role/id/aria 转发即不红。**必须 forwardRef 把 ref 落到 `<ul>`**（三处 `listRef` 焦点/键盘依赖），不得引 wrapper 改 DOM 层级。z-index 统一时 `.select__listbox` 用 shadow-lg、`.user-picker__results` 用 shadow-md 等其余样式不一致——**只提 z-index token，勿合并整块 listbox 样式**。无 i18n/xyflow 约束。

**优先级** — low

---

## 落地优先级总览

| 优先级 | 条目 |
|---|---|
| **high** | 1 复制按钮、2/7 ErrorBanner-retry（含 5/8/15/16/17 的三态编排）、3 Checkbox、6 FormDialog、9 RefSelect、10 CountBadge、14 DetailPageGate、20 useRovingTablist、22 InspectorHeader |
| **medium** | 4 AbsoluteTime、11 PopoverListbox、13 SelectStatusRow、18 QueryBoundary、23 TechnicalDetails |
| **low** | 12 isRenderable、19 JsonPre、21 SplitEmptyPane、24 PortalListbox |

**贯穿主线**：条目 2、7、8、15、16、17 均可归因于「`ErrorBanner` 缺 `onRetry` + 无 `RetryButton` 原语」这一根因——建议合并为**一次 `ErrorBanner.onRetry` 扩展 + 一个 `RetryButton`**，先做 T1 机械收敛（84 处按钮），再按目录分批处理三态编排（`useQueryState`/`QueryBoundary`/`QuerySection`）。多数条目触碰 `styles.css`、i18n 双 bundle 等共享热点文件，且工作树已有他人未提改动，务必按精确 pathspec `git commit -- <paths>` 一次成型；非平凡重构（4、11、24 等）按 CLAUDE.md 需先走 RFC 取得用户批准。

---

## 4. 公共原语绕开（primitive-bypass）

# 公共原语绕开（primitive-bypass）

本章汇总前端在已有公共组件 / 样式 class 明确覆盖某场景的前提下，仍手写原生元素、私有 CSS 或逐字 fork 原语的问题。每一节给出现状证据（`路径:行号`）、已经产生的可见不一致、收敛建议（含 API 草图，标注「新建」还是「扩展既有」）、迁移风险与优先级。行号基于当前工作副本（`styles.css` 等文件处于多人并发未提交状态，落地前须按类名重新定位）。

---

### 1. 确认弹窗手写 Dialog + footer 按钮对，绕开 `<ConfirmDialog>`

**【现状证据】**
- `routes/clarify.detail.tsx:978`、`routes/reviews.detail.tsx:817`、`components/review/MultiDocReviewView.tsx:648`、`routes/repos.tsx:195`、`components/memory/MemoryAllList.tsx:152` 各自手写 `<Dialog>` + footer 的「取消 / 确认」按钮对。
- 对照 `components/ConfirmDialog.tsx`（RFC-198）：已内建 `tone='danger'`、pending 互斥、双击防抖（`inFlightRef` 同步关窗）、只有 fulfilled 才关闭、内建 `ErrorBanner`、`triggerRef` 焦点归还；全仓已有 6 处调用（RuntimeList / ImportZipPanel / WorkflowDraftStatus / settings / workflows.edit / WorkflowCanvas）。

**【已产生的不一致】**
- 按钮尺寸两套：clarify / 集中回答用 `btn`，两个 review 弹窗用 `btn btn--sm`，同一 Dialog 语境高度不同。
- 同一「退回(reject)」确认：单文档 `btn--danger`（红）、多文档 `btn--primary`（蓝）。
- clarify 的「提交并停止反问」这种不可逆动作反而用最弱的 `btn--ghost`。
- 取消文案三套 key：`common.cancel` / `reviews.dialogCancel` / `clarify.detail.stopModal.cancel`。
- 只有 MultiDoc 做了 `dismissDisabled` + `aria-busy` 的 pending 保护；其余提交中可被 ESC / 遮罩关掉，`repos.tsx:210` 的确认按钮无 `disabled` 且不等 mutation 完成就 `setPendingDelete(null)`，快速双击发两次 force delete。

**【建议】** 扩展既有 `ConfirmDialog`（当前 `ConfirmDialogProps` 已含 `open/title/description/confirmLabel/tone/onConfirm/onClose/triggerRef`），分两档迁移：

- A 档（零 prop 扩展直接迁）：`clarify.detail.tsx:978`、`repos.tsx:195`、`MemoryAllList.tsx:152` —— body 都只是单个 `<p>`，直接换 `tone="danger"`，顺带把 clarify 的「提交并停止反问」从 `btn--ghost` 改为 `tone='danger'`；repos / memory 的错误从弹窗外收进弹窗内。
- B 档（最小扩展 2 个可选 prop）：`reviews.detail.tsx:817`、`MultiDocReviewView.tsx:648` —— 退回原因 / 迭代说明字段需要塞进弹窗体。

```ts
// 扩展 components/ConfirmDialog.tsx —— 向后兼容新增两个可选 prop
export interface ConfirmDialogProps {
  // …既有字段不变…
  children?: ReactNode        // 渲染在 description 之下、内建 ErrorBanner 之上
  confirmDisabled?: boolean   // 退回原因未填时禁用确认
  testidPrefix?: string       // 对齐 ChipsInput：派生 `${prefix}-confirm/-cancel/-dialog`
}
```

统一口径：确认按钮尺寸以 `ConfirmDialog` 现有的 `btn`（非 `btn--sm`）为唯一基准；取消文案收敛到 `common.cancel`，删除 `reviews.dialogCancel` / `memory.dialogCancel` / `repos.cancel` / `clarify.detail.stopModal.cancel`（en-US.ts + zh-CN.ts 同步）。

**明确排除**：`CentralizedAnswerDialog.tsx:358`（`size="lg"` 表单提交，提交文案随 `filledTotal` 动态计数）、`UnsavedChangesGuard.tsx:100`（stay/discard/force-leave 三态 + `busyRef` 重入）、`RepairConfirmModal.tsx:81`（失败态整块 footer 换成单个 Close，RFC-202 T7 的 `ok:false` 停窗语义，被 e2e `diagnose-repair.spec.ts` 锁定）。为这三处加 extraAction / footer 覆写等于把 ConfirmDialog 退化成 Dialog 二号。

**【迁移风险】**
- 最大阻碍：`ConfirmDialog` 当前不透传 testid，而被迁点都挂了 `data-testid`（`clarify-stop-modal/-cancel/-confirm`、`repos-delete-confirm(-action)`、`memory-confirm-dialog/-cancel/-ok`），`tests/clarify-detail-route.test.tsx`、`tests/clarify-rfc056-detail-route.test.tsx`（后者做**源码文本锁** `clarify-stop-modal` 等三字面量）、`tests/memory-all-list.test.tsx:167/170/179`、`tests/centralized-answer-pane.test.tsx` 直接依赖。必须加 `testidPrefix` 并让调用点传完整 testid，或同步改源码锁。
- 行为反转：现有「先关框后发 mutation」改成 await-then-close 后，`fireEvent.click(confirm)` 后立即断言「框已消失」的用例（`memory-all-list.test.tsx:202`、`clarify-detail-route.test.tsx:520`）需 `waitFor` 包裹。
- 删 4 个 cancel key 牵动 `zh-CN.ts` 的 interface 声明与值（4-6 处），漏改任一侧 typecheck 红；`tests/i18n-memory-keys.test.ts` 校验 memory.* key 集合。
- e2e 在 workspace typecheck 之外：`diagnose-repair.spec.ts`、`ux-consistency.spec.ts:937` 按 `.confirm-dialog` class + `getByRole('button',{name:'Cancel'})` 遍历，改 testid / 文案前须 grep `e2e/`。
- 顺手项（可独立落）：删掉 `repair-confirm--destructive` 红边（styles.css:3053），只保留 `RepairConfirmModal` 已有的 `confirmClass = 'btn btn--sm btn--danger'`。

**【优先级】** 高（含 repos 双击发两次 force delete 的真 bug + 4 项可见视觉不一致）。

---

### 2. 空 / 加载 / 错误三态手拼 `<div className="muted">`，绕开 `<EmptyState>` / `<LoadingState>` / `<ErrorBanner>`

**【现状证据】**
- 空态裸 muted：`components/inventory/AgentsTable.tsx:12`、`McpsTable.tsx:8`、`SkillsTable.tsx:8`、`PluginsTable.tsx:8`、`home/RunningTaskList.tsx:68`、`home/RecentlyDoneList.tsx:68`、`node-session/ConversationFlow.tsx:22`、`structure/StructuralGraph.tsx:398`、`agents/DependencyTreePreview.tsx:112/145/150`、`workflow-editor/WorkflowNodePicker.tsx:312`、`routes/account.tsx:588/696/794`、`components/tasks/TaskDiagnosePanel.tsx:145`、`routes/tasks.detail.tsx:1498`（node-runs 空态）、`launch/FilesPicker.tsx:126`。
- 加载裸 muted：`FilesPicker.tsx:140`、`agents/NodeDependencyTreeSection.tsx:62`、`DependencyTreePreview.tsx:115`、`TaskDiagnosePanel.tsx:102`。
- 错误裸 muted：`NodeDependencyTreeSection.tsx:66`（无 `role="alert"`，读屏静默）。
- `EmptyState.tsx:1-3` 与 `LoadingState.tsx` 文件头注释就写着「Replaces the `{data.length===0 && <div className="muted">…}` pattern」。`EmptyState` 已有 `size='compact'`。

**【已产生的不一致】**
- 同一应用里空态三形态：`EmptyState`（居中、图标、标题+描述+action）、`div.muted`（左对齐一行灰字）、`p.account-empty`。
- `LoadingState` 有 spinner + `role=status` + `aria-live`，手拼版屏读器完全静默。
- `NodeDependencyTreeSection` 把 loading/error/empty 三态全渲染成同一个 `<span className="muted">`，用户分不清「在加载」和「没有依赖」；同一棵依赖树在 `DependencyTreePreview`（块级 `<p>`）与 `NodeDependencyTreeSection`（行内 `<span>`）长得不一样。
- CSS 层长出 8+ 平行 `X__empty` 块，padding 从 4px 到 24px、字号 12/13px 混用，全裸 px 不走 token；另有僵尸 `.homepage-section__loading`（styles.css:1900，无引用）、`dep-tree__empty/__loading`（tsx 有、styles.css 无规则）。

**【建议】** 逐处定死映射，全量迁到既有原语（`EmptyState` 现签名 `{ title, description?, icon?, action?, size?, 'data-testid'? }`），**用 `size` 不用 `variant`**：

- 空态 → `<EmptyState size="compact" title={t(…)} data-testid={…} />`。
- 加载态 → `<LoadingState size="compact" />`。
- 错误态 → `<ErrorBanner error={q.error} />`（`NodeDependencyTreeSection:66`，签名 `error: unknown` 走 `resolveApiError`）。

密集面板 / 行内 / popover 场景（inventory 四表、callchain、`StructuralGraph:398`、`ConversationFlow:22`、`WorkflowNodePicker:312`、node-runs `tasks.detail:1498`）现状是 12/13px muted 左对齐微字，`empty-state--compact` 的 `--font-md` 居中会明显放大抢眼——须先给 `EmptyState` 加一档纯附加修饰，再迁移：

```ts
// 扩展 components/EmptyState.tsx —— 纯附加，不动 .empty-state / --compact 既有规则
export interface EmptyStateProps {
  // …既有…
  align?: 'center' | 'start'   // 默认 center；start 吸收 inventory/callchain 左对齐微型态
  // 字号档：把 12/13px 统一到 var(--font-sm) 的 micro 修饰类（新增 .empty-state--micro）
}
```

- **不加 `tone`**：`ValidationPanel.tsx:231` 的 `.workflow-validation__empty` 是「校验通过」成功提示（走 `NoticeBanner tone="success"`），`UserPicker.tsx:175` 在 `<li>` 内（塞 div 破坏 listbox a11y，保留），`CallChainView.tsx:102`（截断提示）、`BatchImportDialog.tsx:337`（内联校验）均非空态，排除。
- inventory 四表**不要上提到父级** `RuntimeInventorySection`：`tests/session-inventory-section.test.tsx:175` 断言 `querySelectorAll('.inventory-section__empty').length === 4`；保持四处各渲染一个 `<EmptyState size="compact">`。
- 删死 CSS：`.homepage-section__loading`(1900)、`.editor-sidebar__empty`、以及迁移后失去引用的 `.inventory-section__empty`(11284)、`.callchain__empty`(13251)、`.structure-graph__empty`(13716)、`.workflow-node-picker__empty`(5929)、`.session-flow__empty`(10840)、`.account-empty`(823)；tsx 里 `dep-tree__empty/__loading` 在 styles.css 本无规则，只需处理测试锁。

**【迁移风险】**
- 测试源码锁（同批改，否则前端 vitest 红）：`session-inventory-section.test.tsx:175`（`.inventory-section__empty` 且恰好 4 个）、`structure-graph-render.test.tsx:97`（`.structure-graph__empty`）、`agent-resources-groups.test.tsx:67/88`（`.dep-tree__empty`，跑英文 i18n）、`account-users-settings-table-shell.test.ts:88`（负向锁 `<p className="account-empty">`）、`worktree-files-panel.test.tsx:161`（`worktree-files-preview-empty` testid，透传即安全）。
- `EmptyState` / `LoadingState` 默认 testid 固定为 `empty-state` / `loading-state`，Homepage 同屏 `RunningTaskList`+`RecentlyDoneList` 两空态必须各传显式 `data-testid`，否则 `getByTestId` 多命中报错。
- 视觉：`compact` 是居中块级，替换 `StructuralGraph`/`ConversationFlow`/`WorkflowNodePicker` 这类窄容器左对齐一行灰字会改布局，须先落 `align='start'` + micro 字号再迁，并按 `[feedback_frontend_visual_verify_repro]` 在 light+dark 做最小复现截图。
- DOM 语义：`DependencyTreePreview` 用 `<p>`、`NodeDependencyTreeSection` 用 `<span>`（行内），`EmptyState` 渲染 `<div>`，若位于 `<p>` 祖先内会 invalid nesting，替换前确认父容器块级。
- `dependencyTreePreview.errorGeneric` 改走 `ErrorBanner` 后若无其他引用需 grep 全仓后删；其余 key 直接搬进 `title=`，零迁移。
- e2e `visual-regression.spec.ts:485` 对 `/workflows` 的 `.empty-state` 组件级截图——不动基类、仅新增修饰类即零 churn。
- 前端跑 vitest 非 `bun test`，改完单独跑 `packages/frontend` vitest + typecheck + format:check。

**【优先级】** 高（覆盖面最大、含读屏静默 a11y 缺陷 + 依赖树三态混渲的真实困惑）。

---

### 3. 表单 / 面板提交失败用裸 `<span className="form-actions__error">`，绕开 `ErrorBanner` 与 RFC-203 结构化错误

**【现状证据】**
- 面板级 mutation 错误裸 span：`components/AclPanel.tsx:242`、`tasks/TaskMembersPanel.tsx:156`、`workgroup/WorkgroupContextPanel.tsx:337/406`、`workgroup/DynamicWorkflowPanel.tsx:318/360`、`workgroup/WorkgroupRoom.tsx:859`、`workgroup/WorkgroupMemberCards.tsx:51/89`、`routes/settings.tsx:2041`。
- 弹窗 footer 内联错误（应保留 span 形态）：`AgentPortDialog.tsx:392`、`WorkgroupTaskConfigDialog.tsx:121`、`tasks.new.tsx:1175/1184`、`QuickCreateDialog.tsx:78`、`RenameDialog.tsx:76`。
- `ErrorBanner.tsx:44` 内部已硬编码 `size="compact"` 转发给 `NoticeBanner`；`DetailHeaderActions.tsx:7-9` 注释已定性：「delete-refused errors carry principal-aware reference lists that only the rich ErrorDetails path can render; the old string-shell span dropped them」。

**【已产生的不一致】**
- a11y：仅 `AgentPortDialog.tsx:392` 一处带（条件式）`role="alert"`，其余提交失败对读屏用户完全静默；同类失败在 `/repos`（走 ErrorBanner，经 `NoticeBanner.tsx:103` 拿到 `role="alert"`）有排障提示，在工作组面板只有一行英文。
- 信息量：裸 span 走 `describeApiError()` 只拿一行字符串，丢掉 RFC-203 三层解析的 hint / 可用 ref 列表 / OCC 冲突详情 / stderr 折叠块。
- `styles.css:3876` 的 `.form-actions__error` 与 `.error-box`（2601）是两套视觉。

**【建议】** 沿用 `tasks.new.tsx:1100` 已有的全 banner 先例，**不新造剥壳 inline 变体**：把面板 / 页面级 mutation 错误直接换成 `<ErrorBanner error={mutationError} testid=… />`（`ErrorBanner` 已默认 compact，无需加 prop）。

```tsx
// 面板级：直接换（testid 透传保锚点）
<ErrorBanner error={saveMembers.error} testid="workgroup-panel-error" />
// 本地字符串错误（AgentPortDialog.generalError / tasks.new.workgroupLaunchErrorMessage）走 message=，不是 error=
<ErrorBanner error={null} message={generalError ?? undefined} testid="wizard-submit-error" />
```

`.form-actions__error` **仅保留**给 Dialog footer 内行内错误（`RenameDialog` / `QuickCreateDialog` / `WorkgroupTaskConfigDialog` / `AgentPortDialog` / `tasks.new:1177/1184`）。`settings.tsx:2041` 只替换 error 分支，保留同级 `form-actions__ok` 成功 chip。`AgentPortDialog` 若一定要迁，须先给 `NoticeBanner`/`ErrorBanner` 加**可选 role 抑制 prop**（`AgentPortDialog:393` 的条件 role 是为 `hasExternalPortAlert` 时避免与外层 alert 双重播报，硬编码 `role=alert` 会造成 a11y 回归）——建议暂缓单列。

**【迁移风险】**
- testid 锁：`workgroup-studio-panel.test.tsx:945/954`、`workgroup-task-config.test.tsx:381`、`tasks-new-wizard.test.tsx:911/959` 按 testid 取节点读文本，`tasks-new-wizard.test.tsx:911` 断言 `wizard-submit-error` **不含**裸 code；替换后 testid 挂 banner 根，且 `describeApiError → resolved.title` 会改文案（domain/fallback 档旧值带 `: raw` 后缀，迁移后 raw 进折叠块，`toContain` 断言需放宽）。误迁 `tasks.new.tsx:1184` 会 red——必须用 `message=` 保留 domain copy。
- `form-invalid-no-banner.test.tsx:151/172/192/209/229` 用 `.form-actions__error` 做 NULL 断言（mcps/plugins 四页，不在本次范围）——**保留 class 名**即不受影响；若 inline 变体复用该 class 会让断言退化为恒真，掏空 RFC-151 回归防护。
- a11y：`NoticeBanner` error tone 恒 `role='alert'`（无 ManagedLiveRegion 时），迁移使多处从静默变为播报（正向），但 dialog footer 内的 announce 需确认不与 Dialog focus trap 打架。
- 布局：多处位于 `.form-actions` flex 行，块级 banner 会撑破，settings 那处与 `form-actions__ok` 同行拆成 block 会把错误与保存态视觉分离（属回归，建议剔除）。
- 并发树：`settings.tsx` / `i18n/*.ts` / `styles.css` 均有他人未提改动，按精确 pathspec 一次性 commit。

**【优先级】** 高。

---

### 4. 字段级校验错误 5+ 套并行写法，`role="alert"` 有挂有不挂，绕开 `<Field error>`

**【现状证据】**
- `components/memory/MemoryFormFields.tsx:209/224/241/257`（`.memory-form__error`，塞在 `<Field>` children 尾部）、`routes/tasks.new.tsx:1467`（`.error-text` 放在 `</Field>` 外）、`components/JsonField.tsx:87`、`components/ChipsInput.tsx:156`、`components/ModelSelect.tsx:111`、`components/KindSelect.tsx:159`、`components/launch/RepoSourceRow.tsx:109`、`components/SkillFileTree.tsx:186`、`components/canvas/inspector/WrapperGitLoopEdit.tsx:199/235`、`routes/users.tsx:205`。
- `Form.tsx:22-64`（RFC-154）已有 `<Field error errorId errorLive>`，`error` 渲染 `.form-field__error` 且带 `role={errorLive ? 'alert' : undefined}`，会用 hint 位替换。

**【已产生的不一致】**
- 字号四分五裂：`.form-field__error` 12px、`.memory-form__error` 11px、`.form-input__error` 11px、`.form-actions__error` 13px、`.chips-input__error` 12px、`.kind-select__error`/`.json-field__error` 12px、`.language-switch__error` 11px。`.memory-form__error` 还写死 `color: var(--danger, #c33)` hex 兜底。
- `MemoryFormFields` 把错误当 children 塞在 `<Field>` 内，既断了 `errorId`/`aria-describedby` 关联，又违背「error 替换 hint」契约。
- `ChipsInput` 的错误无 `role`/`id`/`aria` 关联（对比 `JsonField.tsx:80-82` 的 `aria-invalid`/`describedby`/`errormessage` 三连），`SkillFileTree.tsx:173` 的输入框也无 `aria-describedby`；同一表单里有的字段出错会朗读、有的不会。

**【建议】** 分两类：

- A) 真绕过 → 迁到 `Field.error`：`MemoryFormFields` 四处传 `<Field error={errors.x} errorId=…>` 并删 children 尾部 span；`tasks.new.tsx:1467`、`RepoSourceRow:109`（复用**已存在**的那个 Field，传 `error=`）、`SkillFileTree`、`users.tsx:205`。
- B) 复合控件抽内部 `<FieldError>` 子组件复用 `.form-field__error`：`ChipsInput`（补 `role=alert` + `id` + 调用方挂 `aria-describedby`）、`JsonField`、`WrapperGitLoopEdit`（Select in div，非 Field）。

`Field.error` 当前不透传 testid，`RepoSourceRow` 的 `repo-source-url-error${idx}` 会丢——须最小扩展：

```ts
// 扩展 components/Form.tsx —— 向后兼容
interface FieldProps {
  // …既有…
  errorTestId?: string   // 透传到 .form-field__error 的 <span>，保 wizard-branch-error / repo-source-url-error 锚点
  labelHidden?: boolean  // SkillFileTree 不想显示 label 时视觉隐藏、保留可访问名
}
```

**排除**：`ModelSelect.tsx:111`（models 加载失败整体回退，非字段校验，勿硬套 Field.error）、`KindSelect.tsx:159`（已有 `id`+条件 `role=alert`+`aria-invalid`，属去重非修 bug）、`DependencyTreePreview.tsx:123` 的 `.dep-tree__error`（段落样式、无对应 CSS，语义不同）。`.error-text` 另有 `RepoSourceList.tsx:95` 复用，删前确认。

**【迁移风险】**
- 源码 / DOM 锁：`launch-working-branch.test.ts:61/63`（`wizard-branch-error` + `role=alert` 相邻正则）、`launch-git-identity.test.ts:63`（`wizard-git-pair-error`）、`tasks-new-wizard.test.tsx:813`（`wizard-limits-error` testid）、`agents-split-page.test.tsx:565` 与 `agent-port-dialog.test.tsx:261/316`（`document.querySelector('.kind-select__error')`）——合并为 `.form-field__error` 时须同步改这 3 处选择器或保留旧 class 别名。`.file-tree__err` 在 `styles.css:17338` 有窄屏响应覆盖（`overflow-wrap:anywhere`），删类需移植。
- Field.error 替换 hint 的语义变更（tags/url 从 hint+error 同显变为 error 覆盖 hint）；11px→12px(`var(--font-sm)`) 需 light/dark 截图验证。
- 布局敌意：`SkillFileTree` 加行是 input+button+err 水平 flex、users error 在 `<td>` 内、`JsonField`/`KindSelect` 是控件原语，强套纵向 `<Field>` label 栈会破坏布局——用 `FieldError` 子组件而非整包 Field。
- i18n 全程复用现有 key，无重排；无 xyflow 约束（inspector 是右抽屉 DOM）。

**【优先级】** 中（a11y 修复价值高，但迁移面碎、每处需甄别）。

---

### 5. 行内状态徽标绕开 `<StatusChip>`：role-chip / memory / distill / users 各一套配色

**【现状证据】**
- `routes/users.tsx:164/207`（role 自绘 chip、status 裸文本无 i18n）、`components/memory/MemoryRow.tsx:54/58`（`memory-row__status`/`__scope`）、`memory/MemoryDistillJobsTable.tsx:99`（`memory-distill-status--${status}`）、`memory/distill-job-detail/DetailHeader.tsx:44/47/51`（`__meta-chip`）、`ScopeAndDedupSnapshot.tsx:20`、`CandidatesList.tsx:39`（`__action`）、`node-session/InjectedMemoriesCard.tsx:65/145`、`structure/CallChainView.tsx:193`、`structure/StructuralDiffView.tsx:279`、`tasks/TaskFeedbackList.tsx:224`。
- `StatusChip.tsx`：`kind: success|warn|danger|info|neutral`、`size: sm|md`、`withDot`、`title`/`aria-label`/`data-testid`/`className`；文件头注释「Replaces the four parallel implementations」。`TaskStatusChip` / `McpProbeStatusChip` / inventory `StatusBadge` 都已正确委托。

**【已产生的不一致】**
- `DetailHeader` 同一行 `<StatusChip>`（1px 边框、radius-lg、font-sm、lowercase）紧挨 `.distill-job-detail__meta-chip`（无边框、radius-pill、font-xs），高度 / 圆角 / 字号都不一样。
- `/users` role 自绘 chip、status 裸文本，而 `/account`(618) / `/settings`(1483) OIDC 同类账号状态走 `<StatusChip>`——同产品语义两种视觉。
- CSS 层圆角在 3px/4px/8px/999px 之间、字号 10/11/12px、色底浓度 12%/14%/18%/22% 随机；`structure__chip`/`structure__severity--risky` 硬编码 `#d99100`（暗色不跟随，真 bug）。
- 自绘 chip 全无 `role="status"` / `aria-label` 契约。

**【建议】** 删 `role-chip` / `memory-row__status--*` / `__scope--*` / `memory-distill-status--*` 自绘类，改 `<StatusChip>`，语义映射抽纯函数放 `lib/`（照 `lib/clarify-status.ts` 的 `Record` + 函数模式）：

```ts
// lib/memory.ts —— 单一事实源，与 DetailHeader:15 STATUS_KIND 合并
export const memoryStatusChip: Record<MemoryStatus, StatusChipKind> = {
  candidate: 'warn', archived: 'neutral', superseded: 'neutral',
  rejected: 'neutral', fused: 'info',
}
export const distillJobStatusChip: Record<DistillJobStatus, StatusChipKind> = {
  running: 'info', failed: 'danger', done: 'success',
}
// distillAction 不是状态语义，需显式表映射（不能自动推导）
export const distillActionChip: Record<'update_of'|'conflict_with'|'duplicate_of', StatusChipKind> = { … }
```

`StatusChip` 只做加法扩展（不动既有 kind 配色）：

```ts
// 扩展 StatusChip：补 kind='accent'（当前确实缺的一档，供 meta-chip/action/injected chip）
export type StatusChipKind = 'success' | 'warn' | 'danger' | 'info' | 'neutral' | 'accent'
// 处理 text-transform: lowercase 基类强制小写——下放为修饰符或加 casing prop
casing?: 'lower' | 'upper' | 'as-is'  // 默认 'lower' 向后兼容；severity 场景用 upper + loud
```

- role/scope 是**分类**非 status，只能映射 `info`/`neutral`（`userRoleChip: admin→info/user→neutral`、`scope: global→info/repo→neutral`），不要硬塞 success/danger。
- `users.tsx` role/status 当前裸 enum 无 i18n，迁 `StatusChip` 需新增 `users.statusOption.active/disabled/invited`（`roleOption` 已存在），属行为改进需带测试。
- `AttributionChip`（outline-only，无底色）不同轴，排除。
- 顺手把 `structure__chip`/`severity--risky` 的 `#d99100` 换 `var(--warn)`。

**【迁移风险】**
- 测试锁：`memory-row-lang-chip.test.tsx:38/46`（`memory-row__lang--zh-CN` className + `memory-row-<id>-lang` testid）、`structure-view.test.tsx:374/397`（`.structure__severity--breaking`）、`memory-row-fused-chip.test.tsx`（`memory-row-{id}-fused` testid + `v7` 文本）——迁移必须靠 `StatusChip` 的 `className` + `data-testid` 透传保留原类名。`users-self-role-lock.test.ts` 源码文本锁 `isSystem || isSelf ? (` 分支 + `users.selfRoleLocked` tooltip key，须用 `StatusChip title` 保留 tooltip、不动分支。
- `--accent-bg` token 不存在（styles.css 仅 danger/success/warn/info 四个 `*-bg`），新增 accent kind 须同补 light+dark。给 StatusChip 加 accent 与 `styles.css:3459` 记录的 flag-audit W0 决策（刻意删 raw-color chip 别名、只留五语义 kind）相冲，属回退——需用户拍板。
- `.status-chip` 基类 `text-transform: lowercase` 会静默小写化用户自定义 memory tag / scope / 语言码，且与 `structure__severity` 的 uppercase 冲突——必须先把 casing 从基类拆出。
- `.status-chip` `title`/`aria-label` 时加 `role='status'`，`memory-row__lang` 原带 `cursor:help`+title，迁移后多一个 live-region role，可能污染 `getAllByRole('status')`——全量 grep。
- `.memory-row__scope`/`__tag` 被 `MemoryConflictCompareDialog`/`MemoryReviewItem`/`FuseDialog`/`InjectedMemoriesCard`（第二份平行拷贝）跨文件复用，须一并处理。

**【优先级】** 高（含暗色漂色真 bug + 跨页账号状态视觉分叉；accent kind 是需用户拍板的决策点）。

---

### 6. 小号 pill / tag / badge 十余个命名空间各写一份，绕开 `.chip` 与 `StatusChip`

**【现状证据】**
- `.canvas-node__port-tag`(styles.css:7097, 9px + 硬编码 `#b87333`)、`.wrapper-header-pill`(7184, 11px + `#b87333`)、`.reviews-version-list__current-pill`(8136)、`.dep-tree__chip`(10123)、`.clarify-option__recommended-badge`(10319)、`.session-block__details-tag`(10913, 实心 accent + 硬编码 white)、`.inventory-section__chip`(11251)、`.status-badge`(11364, 仅 `shell/InboxDrawer.tsx:146/148` 还在用)、`.memory-row__tag`(11851)、`.memory-row__status`(11923, 唯一真状态徽标)。
- `.chip`(styles.css:3368) / `.chip--tight` / `.status-chip` + `.status-chip--sm/--md` + 五语义修饰符 / `.sidebar__badge`(314) 已存在。

**【已产生的不一致】**
- 12 份平行实现，圆角在 3px/4px/6px/10px/999px/`--radius-pill`/`--radius-sm` 之间随机，字号 9/10/11/12px 随机，padding 六种。
- 同一 memory row 上 `.memory-row__tag` 是全圆角胶囊、紧挨的 `.memory-row__scope`/`__status` 却是方角。
- `.status-badge`(11364) 与 `.status-chip`(3404) 完全同义两套。

**【建议】** 分三档收口：

1. 杀掉 `.status-badge`（独立小 PR）：`InboxDrawer.tsx:146/148` 改 `<StatusChip kind="neutral" size="sm">`（只是计数 / partial 文案，本不该带语义色），删 `styles.css:11364-11407` 整块。注意 `11368` 注释说明「不写 `white-space:nowrap` 让长本地化文案换行」，须先给 StatusChip 加 `allowWrap`（`.status-chip:3416` 是 `nowrap`），否则中文长文案溢出 inbox 头部。
2. 中性标签统一走 `.chip` + `.chip--tight`，补 `.chip--accent/--warn/--danger` 三个 tone 修饰（只读 token 禁 hex）：`inventory-section__chip` / `dep-tree__chip` / `reviews-version-list__current-pill` / `memory-row__tag`；同批把 memory 三兄弟 radius 对齐同一 token。
3. 超小尺寸加 `.chip--micro`：`canvas-node__port-tag`(9px) / `wrapper-header-pill` / `clarify-option__recommended-badge`；port-tag 保留 `uppercase + letter-spacing` 局部叠加。

```ts
// 扩展 StatusChip：allowWrap?: boolean（去 nowrap，容纳长中文）
// CSS：给 .chip 补 --accent/--warn/--danger tone + .chip--micro 尺寸档（读 token，禁 hex）
```

**排除**：`.session-block__details-tag`（实心 accent 底 + 白字 + `details[open]` 状态变体，折叠区指示器）。顺手把 3px/4px/10px/999px 硬编码换 `--radius-sm/--radius-lg/--radius-pill`。

**【迁移风险】**
- HEAD 硬锁：`tasks-list-id-status-nowrap.test.ts:15` 正则锁 `.status-chip{…white-space:nowrap…}`（改基规则直接红——`allowWrap` 必须是修饰类不动基类）、`canvas-wrapper-styles.test.ts:47`（`.wrapper-header-pill{` 必须存在，删类即红）、`status-chip-grep.test.ts:54`（禁 src 出现裸 `status-chip status-chip--` 字面量，迁移须走 `<StatusChip>`）、`status-kind-tables.test.ts:82`（禁 `status-chip--{green,red,…}` 动态拼接）。
- 事实前提：inventory 的 `StatusBadge` 早已转发 StatusChip（`components/inventory/StatusBadge.tsx:31`），`.status-badge` 真实残留只有 `InboxDrawer`。
- 视觉基线：`e2e/visual-regression.spec.ts` 双 OS × light/dark PNG，inbox/memory/reviews/clarify 都在里面，任何 padding/radius/font-size 改动须成对刷新（子页签内改动可能反而不需刷，逐张确认）。
- xyflow：canvas 节点在缩放 transform 内、`wrapper-group` 走 `padding:0` 对齐 bbox（`canvas-wrapper-styles.test.ts` 注释），给 canvas pill 加 border/gap 会改节点内测量宽度——本轮排除 canvas 是主因。

**【优先级】** 高（杀 `.status-badge` 可独立速赢）。

---

### 7. memory/distill 8 套「小圆角 chip」CSS，绕开 `<StatusChip>`

**【现状证据】** `memory/MemoryRow.tsx:54/58/62`（`memory-row__scope/__status/__fused`）、`MemoryApprovalQueue.tsx:182/190`、`MemoryDistillJobsTable.tsx:99`、`distill-job-detail/DetailHeader.tsx:44`、`ScopeAndDedupSnapshot.tsx:20/49`、`CandidatesList.tsx:35/39`；CSS 在 `styles.css` 12016 action-tag / 12052 scope / 12066 status / 12091 fused / 12299 distill-status / 12596 scope-chip / 12664 action（行号随并发未提交改动漂移，以类名定位）。

**【已产生的不一致】** `DetailHeader` 同一行 `<StatusChip>`（边框、radius-lg、lowercase）紧挨 `.__meta-chip`（无边框、radius-pill、font-xs）。CSS 同配方抄 8 遍：color-mix 比例 12%/14%/16%/18% 漂移，圆角 `--radius-sm`(scope) vs `--radius-pill`(tag)。`.memory-row__fused` 硬编码 `font-size:0.75rem; padding:1px 6px; border-radius:6px` 完全不走 token。

**【建议】** 与第 5、6 节同属 StatusChip 收敛，本处补 `tone="soft"` 无边框软底变体 + 语义→kind 映射入 `lib/memory.ts`（与 `DetailHeader:15` STATUS_KIND 合并单一事实源）：

```ts
// 扩展 StatusChip：tone/variant='soft'（无边框软底，承接 accent tint 形态）
// .memory-row__scope 带 text-transform:uppercase，跨 MemoryRow/ApprovalQueue/CandidatesList 三文件共用
//   → soft 变体保留 upper，或显式接受统一为 lowercase（这是可见语义差，别默默丢）
```

排除 `memory-row__fused`（已被第 6 节 micro 覆盖，且有 testid 锁）。

**【迁移风险】**
- `distill-detail-grep.test.ts` 源码文本锁只针对整行点击 `e.stopPropagation()` 与「不得 import ConversationFlow」，与 chip 无关。`memory-row-fused-chip.test.tsx` 锁 `memory-row-{id}-fused` testid + 含 `v7` textContent——迁 fused 须 `StatusChip` `data-testid`/children 保留（本处已排除）。
- 给 StatusChip 加 accent/soft 反悔 flag-audit W0（styles.css:3459，已刻意删 raw-color 别名只留五 kind）——属回退，需用户拍板。
- 视觉：StatusChip 有边框且 lowercase，scope 现为无边框 uppercase、tag/meta 为 accent 软底，全量并入不加 `soft` 会冒边框、抹平大写、accent 被迫改 info/neutral，跨 `/memory` 多页视觉变更。
- 候选引用的行号偏移约 180 行（styles.css 未提交改动），须按类名定位。

**【优先级】** 高（与第 5 节合并为一个 StatusChip RFC 落地更合理）。

---

### 8. 只读值行 `.inspector__readonly`（含 `--error`/`--warning`）手写 12 次，且 styles.css 里根本没有这三条规则

**【现状证据】** `components/canvas/inspector/ClarifyEdit.tsx:72/77/89/94`、`CrossClarifyEdit.tsx:80/85/97/102/114/119`、`canvas/EdgeInspector.tsx:148/156`。`grep -c inspector__readonly styles.css` = 0——三个 class（`inspector__readonly` / `--error` / `--warning`）全不存在。同类 `WrapperFanoutEdit.tsx:172` 的 `muted muted--warn`、`ReviewNode.tsx:64` 的 `canvas-node__input-source` 也零 CSS。

**【已产生的不一致】** 「未连接问询者」「不在循环里」这些错误 / 警告态与正常态渲染完全一样（纯裸 div），颜色语义 100% 丢失——是真实可见 bug。

**【建议】** 分两路，不新造第三套 tone 组件：

- 5 处有色态（`ClarifyEdit:77/94`、`CrossClarifyEdit:85/102/119`）改走既有 `<NoticeBanner tone="error"|"warning" size="compact" testid=…>`（已带真实 CSS + 图标 + live-region），testid 落 banner 根无 wrapper（RFC-203 T5b 路径）。
- 7 处 neutral 值行（`ClarifyEdit:72/89`、`CrossClarifyEdit:80/97/114`、`EdgeInspector:148/156`）新建最小原语：

```ts
// 新建 components/ReadonlyValue.tsx —— tone 归 NoticeBanner，本组件不带 tone
export interface ReadonlyValueProps {
  mono?: boolean
  'data-testid'?: string
  children: ReactNode
}
// 配真实 .readonly-value / .readonly-value--mono CSS
```

同批处置孤儿 class：`WrapperFanoutEdit:172` 的 `muted--warn`、`ReviewNode:64` 的 `canvas-node__input-source` 补 CSS 或改用既有 class。防回归测试**收窄**：只断言项目自有 BEM 前缀（`inspector__`/`canvas-node__`/`muted--`）在 styles.css 中存在，显式排除第三方 `react-flow__`/`nodrag`/`nopan`/`nowheel` 前缀（实测 102 个无 CSS 的 class 含 xyflow 行为类，全量「删孤儿 class」会破坏画布拖拽 / 滚轮）。

**【迁移风险】**
- 锁的是 testid 非 class：`node-inspector-clarify.test.tsx:109/112/132/133`、`cross-clarify-inspector-palette.test.tsx:120/123/125/160/163/167/168`（含 `document.querySelector('[data-testid=…]')`，对 DOM 层级敏感）——testid 必须留在渲染根，禁包 wrapper。后者第 5 条 LOCK 针对 `NodeInspector.tsx`/`nodePalette.ts`/`WorkflowCanvas.tsx` 的 `clarify-cross-agent` 字面量，本次不碰这些文件即安全。
- 无测试锁 `inspector__readonly` 类名本身（全仓仅 3 源文件命中），改名零风险。
- `canvas-node__input-source` 在 `ReviewNode`（画布节点内），改动注意 xyflow 节点尺寸量测——只补 CSS 不删 class。
- `NoticeBanner` 注入图标 + `role=alert/status`，改后跑 vitest 确认无 role/文本断言冲突。

**【优先级】** 高（颜色语义 100% 丢失的真实 a11y/可见 bug）。

---

### 9. 「说明 / 提示卡片」三套并行：`<NoticeBanner>` / 裸 `.info-box` / task-error-banner / 连通性测试 / WorkflowStarter

**【现状证据】**
- 裸 `.info-box(--muted)`：`AgentImportDialog.tsx:587/653/679/772`、`canvas/inspector/WrapperGitLoopEdit.tsx:92`、`tasks.new.tsx:1277`、`workgroups.detail.tsx:876`；6 处 `info-box--muted` 补丁挂在 NoticeBanner 上（`tasks.new:1007`、`scheduled.$id:166`、`tasks.detail:569/587/672`）。
- 任务页第二套 chrome `.task-error-banner`：`tasks.detail.tsx:616`、`tasks/StuckTaskBanner.tsx:70`、`RecoverySection.tsx:101`、`WorkflowSyncBanner.tsx:76`、`WorkflowSyncDialog.tsx:68/83`（styles.css:2789-2914 + 17065 移动端分支）。
- 手拼 `role="status"`：`structure/StructuralDiffView.tsx:135/140`、`home/CapabilityGrid.tsx:103`、`review/MultiDocReviewView.tsx:480`、`reviews.detail.tsx:696`、`launch/RepoSourceList.tsx:95`。
- OIDC 连通性：`routes/settings.tsx:1888`（`.oidc-form__test-result--ok/--err` + 硬编码 ✓/✗ + `<br>`）vs 同文件 PlantUML(1322) 走 NoticeBanner/ErrorBanner。
- `WorkflowStarterDialog.tsx:366/375/385/396`（4 状态色块）vs 同弹窗 394 已用 ErrorBanner。
- `NoticeBanner.tsx`：`tone: info/success/warning/error` + `size` + `title` + `action` + `dismiss` + `testid` + `ManagedLiveRegion` 播报；全仓 143 处使用。

**【已产生的不一致】**
- 同一「warning 提示」三套配方（`.notice-banner--warning` / AgentImport 的 `warn 55%边框/6%底` / `.info-box` accent 12% 全裸 px），`tasks.new:1007` 甚至给 NoticeBanner 挂 `info-box--muted` 去凑样子——两套体系互相打补丁。
- 同一 `.task-detail__banner-stack` 里 4 条走 NoticeBanner（带图标 + 统一 tone）、3 条走 `.task-error-banner`（无图标、自有配色）；ARIA 语义散了：StuckTaskBanner `role=alert`、WorkflowSyncBanner `role=status`、RecoverySection 动态切换。
- OIDC 同一 settings 里两个「测试连接」长得完全不同；WorkflowStarter 5 种反馈 2 套体系。

**【建议】** 全部收敛到 `NoticeBanner`（`ErrorBanner` 已默认 compact，无需加 size）：

```tsx
// info-box → NoticeBanner
<NoticeBanner tone="info" size="compact" title={t(...)}
  action={<StatusChip kind="warn" size="sm">{n}</StatusChip>}   // 用已有 action 槽承载计数，不新增 trailing
  testid="agent-import-not-created">
  {t(...)}
</NoticeBanner>

// role=status 六处：StructuralDiffView→warning、CapabilityGrid/RepoSourceList→error（error 恰渲染 role=alert 保真）、readonly 历史提示→info
// OIDC：成功 NoticeBanner tone=success；失败 ErrorBanner error=；issuer/token/jwks 详情用 <dl> 作 children
// WorkflowStarter：validating→info / valid→success / invalid→error(issue 列表 children) / replaceWarning→warning
```

task-error-banner 家族迁并入 NoticeBanner 需补三项可选能力：

```ts
// 扩展 NoticeBanner —— summary 省略号 + title 截断是 load-bearing（防 stack trace 撑破视口）
details?: ReactNode            // 折叠体
// summary 单行 ellipsis + title hover（styles.css 注释明示，迁移必须带上）
// action 槽允许多个按钮（jump+dismiss / diagnose+dismiss / clear+toggle+dismiss）
```

删 `.info-box`/`--muted`/`__action`、`.oidc-form__test-result*`、`.workflow-starter__valid/__invalid/__replace-warning`、`.task-error-banner*` 私有 CSS。**排除**「三处 ConnectionTestRow 共用」（OIDC/PlantUML/MCP probe 形态差异过大，各贴 NoticeBanner 即可），MCP probe 是持久化异步 surface（`useMcpProbe`/CAS/freshness）勿动。

**【迁移风险】**
- ARIA 行为变更（真实）：`replaceWarning` / StuckTaskBanner 现 `role=alert`（assertive）→ NoticeBanner warning 走 polite status；`RepoSourceList` 现 `role=alert`→error tone 保 alert，但在有 `ManagedLiveRegion` provider 时 NoticeBanner 不输出 role 而走 announce，`launch-repo-source-list.test.tsx:131/136` 断言 `role==='alert'` 须在真实挂载点确认 live-region 上下文。
- 测试锁：`structure-view.test.tsx:247`（`.structure__banner` length===1，删类须改选择器）、`reviews-detail-readonly-source.test.ts:160`（源码正则锁 `<div className="readonly-banner"`）、`capability-grid.test.tsx:181`（`findByRole('status')`，改 error tone 即失配，与 tone 决策绑定）、`agent-import-dialog.test.tsx:119`（`agent-import-not-created` 挂在 `<strong>` 上，挪进 `title` 会丢锚点）、`e2e/agent-import.spec.ts:140`（`toHaveText` 精确整体文本，最脆）、`workflows-pages.test.tsx:454`（`workgroup-readiness-banner`）、`workflow-starter-dialog.test.tsx:103/122/125`。`task-detail-failed-banner-single-line.test.ts` 整文件锁 `.task-error-banner*` JSX+CSS+移动端，且背后是真实防溢出保护——须在新 markup 等价重表达并重新 lock。
- 双重播报：`WorkflowStarterDialog:255-266` 自带 `managedLiveRegion.announce` useEffect 与 NoticeBanner 内部 announce 重叠，不删就双播，且 import 变未用触发 lint `max-warnings 0` 双 OS 红。
- 布局：`.workgroup-readiness`(styles.css:14617) 靠覆盖 `.info-box` 的 flex-row 堆叠多行 reason，`.notice-banner` 是 grid，须改选择器否则多条 reason 挤一行。`WorkflowSyncDialog` 两条是 Dialog 内联 callout（非横幅），排除。

**【优先级】** 高（task-error-banner 家族）/ 中（info-box、connection-test、WorkflowStarter）——建议按 surface 拆多个 PR。

---

### 10. 「错误横幅 + 重试按钮」到处手写 `<button className="btn btn--sm">{t('common.retry')}</button>`

**【现状证据】** 全仓 `t('common.retry')` 出现 84 次、其中 61 次挂手写 `<button>` 跨 42 文件。典型：`routes/skills.detail.tsx:769`、`components/SkillFileTree.tsx:142/200`、`skill/SkillVersionHistory.tsx:102/107`、`skills/ImportZipPanel.tsx:382/526`、`routes/account.tsx:569/677/775`、`routes/users.tsx:98`、`mcps.detail.tsx:151`、`plugins.detail.tsx:358/503`、`auth.tsx:313`、`mcps/McpInventoryPanel.tsx:178/191`、`tasks.preview.tsx:53`（已有私有 `RetryAction`，应提升）。`ErrorBanner` 有 `action?: ReactNode` 槽但无 `onRetry`。

**【已产生的不一致】** 尺寸：ErrorBanner 里全 `btn btn--sm`，`ImportZipPanel.tsx:493` 的 EmptyState action 用全尺寸 `btn`；文案：`common.retry` vs 私有 `skills.zipRetry`；忙碌语义：`ImportZipPanel:382` `disabled={busy}`、SkillFileTree/SkillVersionHistory 在 busy 时仍可点触发重复请求；`plugins.detail:503` 是唯一带 check/upgrade 业务分支的一份；`auth.tsx` panels 全在 `<form>` 里，某处漏 `type="button"` 会变提交按钮（风险已存在）。

**【建议】** 扩展 `ErrorBanner` + 导出 `RetryButton`：

```ts
// 扩展 components/ErrorBanner.tsx —— onRetry 与 action 互斥，onRetry 内部构造统一 RetryButton 喂 action 槽
interface ErrorBannerProps {
  // …既有 error/message/action/onDismiss/overrides/testid…
  onRetry?: () => void
  retryLabel?: string     // 默认 common.retry
  retryBusy?: boolean     // 保留 ImportZipPanel:382 的 disabled={busy}
}

// 新建 components/RetryButton.tsx —— 供 EmptyState/NoticeBanner 的 action 槽复用
export function RetryButton(p: { onClick: () => void; label?: string; busy?: boolean }): ReactElement
// 内部固定 <button type="button" className="btn btn--sm" disabled={busy} aria-busy={busy}>
```

约 40 文件退化成 `<ErrorBanner error={e} onRetry={() => void q.refetch()} />`。逐一保真：`McpInventoryPanel:174` 的 `action={cond ? undefined : …}`（改 `onRetry={cond ? undefined : …}`）、`plugins.detail:503` check/upgrade 分支、`McpInventoryPanel:178` 的 `.catch(() => undefined)`、`ImportZipPanel:493` 的 `skills.zipReplace` back 按钮（**非重试**，排除）。合并 `skills.zipRetry` 入 `common.retry` 前 grep 全仓。

**【迁移风险】**
- 源码锁（同 PR 改）：`settings-system-agents.test.ts:68`（`action={retryAction}`）、`repos-page.test.tsx:44`、`resource-detail-query-state.test.ts:27`（`{t('common.retry')}` + `action={retryDetailAction}`）、`workflows-pages.test.tsx:718` 与 `workgroups-pages.test.tsx:945`（`onClick={() => void query.refetch()}`）、`rfc105-markdown-preview-source.test.ts:29`（`<RetryAction onRetry=…/>`）。
- `import-zip-panel.test.tsx:227/383`（`getByRole('button',{name:i18n.t('skills.zipRetry')})`）——删 key 而不同步改断言，`i18n.t` 回落成 key 字符串匹配不到「Retry」两条红；删 key 还须删 `zh-CN.ts` interface 声明(1177)否则 typecheck 红。
- `error-banner.test.tsx:52` 硬锁 `getByRole('button',{name:'Retry'}).parentElement.className === 'notice-banner__action'`——onRetry 内部按钮必须走 `.notice-banner__action` 槽，禁另造 wrapper。
- `onRetry` 走 action 槽方案下，`getByRole('button',{name:/retry|重试/})` 契约自然保住。

**【优先级】** 高（迁移面大但收益确定，含 `<form>` 内漏 `type=button` 的潜在提交 bug）。

---

### 11. `/agents` 卡片自写 `<ResourceBadges>`（private chip + owner 名），class 与 title 文案不一致

**【现状证据】** `routes/agents.tsx:116/119`（自建 private chip + `.agent-card__owner`，title `Owner: 张三`，`hasSummary` 整块隐藏分支）vs `routes/skills.tsx:62`、`mcps.tsx:85`、`plugins.tsx:93`、`workflows.tsx:185`、`workgroups.tsx:120` 全走 `<ResourceBadges>`。`ResourceBadges.tsx:27` 注释「so every host renders the identical badges」，owner 用 `muted data-table__owner`、title 只 `t('acl.ownerBadge')`（「Owner」）。

**【已产生的不一致】** owner class 不同（`data-table__owner` vs `agent-card__owner`，省略号 / max-width 规则不一）；tooltip 文案两种（`Owner` vs `Owner: 张三`）；agents 多一个 `hasSummary` 整块隐藏分支。

**【建议】** 把 `agents.tsx:116-126` 替换为 `<ResourceBadges visibility={a.visibility} ownerUserId={a.ownerUserId} owners={owners} />`（插在 runtime/ports 之后、builtin chip 之前）。runtime/ports 作 agents 私有事实文本保留在 `.agent-card__facts`。owner tooltip 二选一：

```ts
// 扩展 components/ResourceBadges.tsx —— A: 加 prop 保留两态
ownerClassName?: string          // agents 传入复用 .agent-card__owner 收缩样式
ownerTitleWithName?: boolean     // agents 传 true 走 `${t('acl.ownerBadge')}: ${name}`
// 或 B: 全局统一 Owner:name + 删 .agent-card__owner（跨资源可见文案变更，需 PR 说明）
```

`.data-table__owner` 自带 `margin-left:8px` + `font-size:12px`（styles.css:14305），落进 `.agent-card__facts`（gap 布局 + `var(--font-xs)`）会双重间距 + 字号不一致，其省略号规则被 scope 在 `.split-card__badges`(16130)/`.gallery-card__badges`(16678) 内、`.agent-card__facts` 不命中——**裸删 `.agent-card__owner` 会让长 owner 名溢出**，必须走 `ownerClassName` 扩展或补 `.agent-card__facts .data-table__owner` 承接。

**【迁移风险】**
- 测试锁：`agents-split-page.test.tsx` 约 278 行 `card.querySelector('.agent-card__owner')?.getAttribute('title')` 断言 contains ownerName（迁移后 class 变 `.data-table__owner`、title 语义变，须改选择器+期望——正因此才把 title 统一带名以继续 contains）；`.agent-card__facts` length===1（约 213/274）、`'private'` 文本(281) wrapper 保留仍成立。`chip-row-vertical-center.test.ts`（`.chip-row .data-table__owner{margin-left:0}`）、`resource-split-page.test.tsx`（`.split-card__badges .data-table__owner{ellipsis}`）是 CSS 源码文本锁，新增 `.agent-card__facts .data-table__owner` 须复刻 `margin-left:0` + ellipsis。
- i18n 建议新增 `acl.ownerBadgeWithName` 而非改 `acl.ownerBadge` 语义。
- `agents.tsx:97` 的 searchText 仍自拼 privateChip/ownerName，与 badges 解耦，勿一并动。
- tooltip 统一是产品决策点，需用户拍板 A/B。仅前端展示层，不触碰 RFC-099 prompt 隔离。

**【优先级】** 高（tooltip 统一需拍板；owner 溢出是裸删会引入的真实视觉回归）。

---

### 12. 「× 关闭」按钮手写 7 次跨 4 套 class，其中一处 class 名在 CSS 里根本不存在

**【现状证据】** `Dialog.tsx:276`（内置但不导出）、`NoticeBanner.tsx:170`（`BannerDismissButton`，带 `nextDismiss/fallbackFocus/queueMicrotask` 焦点恢复）、`NodeDetailDrawer.tsx:168`、`canvas/EdgeInspector.tsx:131`、`canvas/NodeInspector.tsx:202`、`workflow-editor/ValidationPanel.tsx:173`、`canvas/WorkflowCanvas.tsx:2449`。CSS：`.dialog__close`(7) / `.banner-dismiss-button`(7) / `.inspector__close`(1)；`.btn-ghost`/`.btn-sm` **零命中**（只有 `.btn--ghost`/`.btn--sm`）。

**【已产生的不一致】** 真实 bug：`WorkflowCanvas.tsx:2451` 写单破折号 `btn btn-ghost btn-sm`，CSS 无此类 → 画布剪贴板提示条关闭按钮渲染成全尺寸默认按钮。无障碍名两套：`common.close` vs `inspector.closeAria`；× 有的包 `<span aria-hidden>`（NoticeBanner）有的裸放。

**【建议】** 新建 `CloseButton`，CSS 收敛到 `.close-button`，旧 class 降为薄修饰符：

```ts
// 新建 components/CloseButton.tsx
export interface CloseButtonProps {
  onClose: () => void
  label?: string                                        // 默认 t('common.close')
  variant?: 'panel' | 'dialog' | 'banner' | 'ghost'     // ghost 承接 ValidationPanel/WorkflowCanvas
  disabled?: boolean
  testid?: string
  ref?: RefObject<HTMLButtonElement | null>             // NoticeBanner 焦点恢复需透传
}
// 内部固定 <button type="button"><span aria-hidden>×</span></button>
```

`NoticeBanner` 的 dismiss 带 bespoke 焦点恢复（`NoticeBanner.tsx:131-167` 的 `.task-detail__banner-stack` 遍历 + `queueMicrotask`），CloseButton 必须透传 `ref`/`onClick` 不吞这段，建议 NoticeBanner 只做薄包装。`WorkflowCanvas:2449` 是把 × 塞进 NoticeBanner 的 action 槽——最优解直接改用 NoticeBanner 内置 `dismiss`，顺带修单破折号 bug。

**【迁移风险】**
- class 选择器锁：`.dialog__close` 在 `dialog.test`/`confirm-dialog.test`(×2)/`dialog-portal-focus`/`unsaved-guard`/`dialog-nested` 5 文件当选择器查询，`dialog-portal-focus.test.tsx:79` 断言 `class !== 'dialog__close'`（复合类字符串仍满足，但须保留 `dialog__close`）；`node-inspector.test.tsx:221` 用 `getByLabelText('Close')` 依赖 aria 文本。
- `stuck-task-banner-dismiss` testid 须继续透传否则 `stuck-task-banner.test` 红。
- i18n `common.close` 与 `inspector.closeAria` 均为 'Close'（文本一致），consolidation 安全；本次不删 key。
- xyflow：`WorkflowCanvas` 那颗按钮在 clipboard-notice 覆盖层（非自定义节点渲染器），无节点测量约束。迁移后补一条「不得再手写裸 × 关闭按钮」的 ratchet。

**【优先级】** 高（含 canvas 单破折号 class 的可见渲染 bug）。

---

### 13. 时间戳一半走 `<RelativeTime>`、一半手写 `new Date().toLocaleString()`

**【现状证据】** 手写 `toLocaleString` 19 处：`memory/MemoryRow.tsx:93`、`MemoryDistillJobsTable.tsx:105`、`distill-job-detail/DetailHeader.tsx:60/65/71`、`NodeDetailDrawer.tsx:353/357`、`tasks/TaskFeedbackList.tsx:221`、`TaskDiagnosePanel.tsx:176`、`skill/SkillVersionHistory.tsx:153`、`mcps/McpInventoryPanel.tsx:442`、`review/ReviewDecisionInfo.tsx:76`、`tasks.detail.tsx:947/952`、`clarify.tsx:97/138`、`reviews.tsx:270`、`scheduled.$id.tsx:194`、`gallery/GalleryCard.tsx:71`。`RelativeTime.tsx:13-17` 签名 `{ ts: number|string; 'data-testid'? }`，渲染 `<time dateTime>` + `title` 绝对值 + 相对文案；文件头注释 D4 口径「detail pages keep absolute times; this component is for list rows and cards only」。

**【已产生的不一致】** `/repos` 最后抓取是相对时间（带 `<time>` 语义 + hover 绝对值），`/memory` distill jobs 表创建时间是本地绝对串（无 `<time>` 元素、无 title、屏读器读不出机器可解析时间）；19 处手写全缺 `<time dateTime>`。

**【建议】** 按用途分两半：

```ts
// A) 需渲染时间的 JSX → 扩展 RelativeTime 加 mode（默认 relative 向后兼容现有 8 调用点）
export interface RelativeTimeProps {
  ts: number | string
  mode?: 'relative' | 'absolute' | 'both'   // absolute 仍输出 <time dateTime>+title；省一次 useNowTick rerender
  'data-testid'?: string
}
// 列表/卡片(默认 relative)：MemoryRow/MemoryDistillJobsTable/TaskFeedbackList/TaskDiagnosePanel/SkillVersionHistory/clarify
// 详情页(absolute)：DetailHeader:60/65/71、NodeDetailDrawer:353/357、tasks.detail:947/952、scheduled.$id:194、ReviewDecisionInfo

// B) 非 JSX、需绝对字符串的 helper → lib/relative-time.ts 补纯函数
export function formatAbsolute(ts: number | string): string   // 复用 toEpochMs 做 null 归一
// GalleryCard:71(tooltip 拼串)、McpInventoryPanel:442、reviews:270
```

同步把 `RelativeTime.tsx:4-6` 的 D4 注释改为「列表默认 relative，详情页传 `mode='absolute'`」，并在 RFC-191/192 追一行记录这次口径放宽——**不要让代码与 D4 注释矛盾**。

**【迁移风险】**
- `relative-time.test.ts:112` 硬断言默认路径 `title === new Date(ts).toLocaleString()` 且 textContent `'just now'`/`'1 min ago'`——任何改动必须保持默认相对路径逐字节不变。
- D4 文档决策冲突：把组件用到详情页是修订 RFC-191/192 D4（组件锁「list rows and cards only」），需与用户重开 D4，不能单方面反转（这是本项的核心决策点）。
- 绝对格式异构：`scheduled.tsx:190/254`、`ScheduleDialog:95` 用 `toLocaleString(undefined,{dateStyle,timeStyle})` 与裸 `toLocaleString` 不同，单一 `formatAbsolute(ts)` 会造成 config 蔓延或悄改格式——需保留 opts 参数或分档。
- `distill-detail-grep.test.ts` 源码锁 DetailHeader 其它不变量（不含时间戳），重构勿破坏；MemoryRow/表格/Gallery 时间戳无源码级文本锁。
- 无 xyflow 约束；`both` 若引入需连接词 i18n 字符串。

**【优先级】** 中（D4 口径放宽需用户拍板）。

---

### 14. 可折叠区块：`FormSection` 已解决受控 details desync，却被 fork 至少 5 处 + McpInventoryPanel 4 份

**【现状证据】** `FormSection.tsx:9-14,36-58`（原语本体，含 desync 修正）；fork/绕开：`canvas/inspector/InspectorSection.tsx:13-22`（近逐行 fork，无 desync 修正，h3）、`AgentForm.tsx:474`（手写 open/onToggle）、`skills.detail.tsx:823`（`skill-detail__technical` 技术信息 details+dl）、`canvas/NodeInspector.tsx:228`（`inspector__technical--node`）、`canvas/EdgeInspector.tsx:185`（`inspector__technical`）、`inventory/RuntimeInventorySection.tsx:48`（手写 open + 富 summary chips）、`node-session/InjectedMemoriesCard.tsx:49`（非受控 details + inherit 徽标）、`tasks/StuckTaskBanner.tsx:83`；`McpInventoryPanel.tsx:290/340/381/422`（4 个 section 裸文本 summary + 字符串拼 `(N)`）。

**【已产生的不一致】** `InspectorSection` 是 `FormSection` 的近逐行 fork 但**没有** desync 修正（无法受控折叠）；`AgentForm:468` 又手写一遍 open/onToggle 同步。标题层级漂移：FormSection 用 h2、InspectorSection 用 h3、其余 summary 无 heading，页面 outline 断裂。「技术信息」一个语义在 4 处用 3 套 class（`agent-resources__technical` / `skill-detail__technical` / `inspector__technical`）。McpInventoryPanel 四 section 「Tools 默认 open 其余关」只体现在 JSX 属性、无 API 表达，`(N)` 是字符串拼接。

**【建议】** 扩展 `FormSection` + 抽 `TechnicalDetails`：

```ts
// 扩展 components/FormSection.tsx —— 向后兼容
interface FormSectionProps {
  // …既有…
  headingLevel?: 2 | 3           // 默认 2；面板内避免 outline/字号错位（McpInventoryPanel 必需）
  summaryExtra?: ReactNode       // 承接 RuntimeInventorySection chips / InjectedMemoriesCard inherit 徽标
  count?: number                 // McpInventoryPanel 的 (N) 替代字符串拼接
}

// 新建 components/TechnicalDetails.tsx —— 3 处同构 <details><summary>技术信息</summary><dl>{label/value}</dl>
export function TechnicalDetails(p: { items: Array<{ label: string; value: ReactNode }> }): ReactElement
// 迁 skills.detail:823 / NodeInspector:228 / EdgeInspector:185，合并 3 套 __technical class
```

collapsible 迁移组：`InspectorSection`（删除改调 FormSection）+ `AgentForm`（body 是 `<p>`+DependencyTreePreview 树预览，非 label/value，留 collapsible 组不并入 TechnicalDetails）+ `RuntimeInventorySection` + `InjectedMemoriesCard` + `StuckTaskBanner`；`McpInventoryPanel` 四 section 用 collapsible + `count`，Tools 传 `defaultOpen`。**排除** `InjectedMemoriesCard`（summary 含 inherit 徽标 + 逐 scope chips + 分组 body，是复合控件，强并会给 FormSection 引入 chips 槽即原语污染）——本节两处描述（第 14 与 McpInventoryPanel 专项）对 InjectedMemoriesCard 结论一致：独立命名空间演进。

**【迁移风险】**
- `AgentForm` 手写 open/onToggle 并非真 bug（以 React prop 传 `open` 且每次 toggle setState，无 render-echo 坑），只是重复，勿以「修 bug」定优先级。
- 富 summary 两处（chips / inherit 徽标）迁移非平凡，`summaryExtra` 承接复杂 flex 布局，工作量大于其余三处。
- 测试锁：`session-inventory-section.test.tsx` / `runtime-inventory-section-in-flight.test.tsx` 依赖 `det.querySelector('summary')` + `(det as HTMLDetailsElement).open` + `runtime-inventory-section` testid（FormSection 已渲染真 details+testid，可过，但 chips 经 summaryExtra 放回 summary 内且多一层 h2/title 包裹，需回归验证）；`mcp-inventory-panel.test.tsx` 只依赖 `mcp-inventory-tools/resources/prompts/capabilities` testid（须 FormSection `data-testid` 透传）；`injected-memories-card.test.tsx` 断言 `getByText(/Injected memories \(3\)/)` 单文本节点正则（count 拆 span 会跨元素断裂——排除理由）；`i18n-mcps-probe-rfc030.test.ts:53` 锁 `mcps.probe.section.{k}` 非空。
- 视觉分歧（最高）：`.inspector-section`(12px 大写无边框, styles.css:6646) 与 `details.form-section`(16px + 边框圆角盒, 3923) 是两套刻意不同语法，合并前需视觉自查 + 用户拍板；`.mcp-inventory__section` 是 dashed border-top 紧凑分节，删旧样式 = 接受变卡片风格。
- `CopyButton` 尚不存在，`TechnicalDetails` 若含复制被其阻塞。`.card__title` 类冲突见第 15 节。前端跑 vitest。

**【优先级】** 中。

---

### 15. `Card` 缺 `title` prop，调用方手写 `header={<h3>}`，房间 class 被跨组件借用

**【现状证据】** `workgroup/WorkgroupRoom.tsx:760/1410`、`workgroup/DynamicWorkflowPanel.tsx:162/165/180/222/284`。`Card.tsx:15` 只有 header/children/footer 三 ReactNode 槽。`.card__title` **已存在**（styles.css:14456, `var(--font-md)`）且被 `TaskQuestionList.tsx:477`/`CentralizedAnswerDialog.tsx:635` 复用。

**【已产生的不一致】** `DynamicWorkflowPanel` 不在聊天室却借用 `.workgroup-room__side-title`/`__card-actions`/`__gate-state`/`__body` 整套；`.workgroup-room__side-title` 是 `font-size:13px` 硬编码（styles.css:15135）而其它卡片标题走 `--font-sm`（实为 14px）。footer 按钮排布 workgroup 用 `.workgroup-room__card-actions` 包一层、其它直接塞按钮。

**【建议】** 最小向后兼容扩展 `Card`：

```ts
// 扩展 components/Card.tsx
interface CardProps {
  // …既有 header/children/footer…
  title?: string       // 内部 <h3 className="card__title-heading">（新类名，避开已被锁的 .card__title）
  actions?: ReactNode  // footer 内固定 .card__actions flex 行
}
```

6 处从 `header={<h3 className="workgroup-room__side-title">}` 改 `title={t(...)}`；3 处 `.workgroup-room__card-actions` 改 `actions=`。**关键修正**：`.card__title` 已存在且用 `--font-md`，被 `centralized-answer-pane.test.tsx:351/365`（`querySelector('.card__title')`）与 `task-questions-overflow.test.ts:26`（源码锁 `.task-questions .card__title{overflow-wrap:anywhere}`）锁定——原提案「新增 `.card__title{font-size:var(--font-sm)}`」会重定义缩小这些已锁标题、直接踩红，故**新 header 标题必须用不同类名**。删 13px 硬编码 `.workgroup-room__side-title`（13px→14px 是有意 token 对齐）与 `.workgroup-room__card-actions`；DynamicWorkflowPanel 的 `gate-state`/`body` 借用改中性 class / `form-field__hint`。

**【迁移风险】**
- 类名冲突（最关键，见上）：`.card__title` 已锁，勿改字号。
- `side-title`/`card-actions` 有独立非 Card 用法（WorkgroupRoom 561/646/711、1120/1225/715），不能删类。
- testid 锁：`workgroup-room.test.tsx`/`dynamic-workflow-panel.test.tsx` 锁 5 个 card testid，迁移后须挂根节点。
- 13px→14px 需 light/dark 最小 repro 验证；workgroup 房间截图可能需刷 e2e 基线。前端跑 vitest。

**【优先级】** 中。

---

### 16. inspector 里 5 处裸 `<input className="form-input">`，绕开 `TextInput` / `NumberInput`

**【现状证据】** `canvas/inspector/InputEdit.tsx:268/290/305`（三个 type=number，各自重抄 `raw === '' ? undefined : Number(raw)`）、`OutputEdit.tsx:71`、`WrapperGitLoopEdit.tsx:354`。同批文件其它字段已用原语：`WrapperGitLoopEdit.tsx:103/281` 用 `NumberInput`、`InputEdit.tsx:80/137` 用 `TextInput`。CLAUDE.md 明文禁 `<input className="form-input">`。

**【已产生的不一致】** 同文件两种写法并存；裸 input 拿不到 `NumberInput` 的空值 / 取整归一（`Number.isFinite` 守卫），也拿不到 `TextInput` 的 `onBlur`/`onKeyDown` 统一行为与 `disabled`/`aria-invalid` 契约、无 testid。

**【建议】** 三个 number 字段换 `<NumberInput>`（`NumberInput` 已原生支持空→undefined，Form.tsx:195-204，**无需**加 `allowEmpty`），两个 text 字段换 `<TextInput>`：

```tsx
<NumberInput value={maxFileSize} min={1} placeholder="52428800"
  onChange={(v) => onPatch({ ...def, maxFileSize: v }, maxFileSizeMeta)}  // 保留 *Meta 第二参
  data-testid="input-edit-max-file-size" />
```

顺带补 `InputEdit` 三处缺失的 `Number.isFinite` 守卫（消除 NaN 灌入 def）。防回归文本锁措辞须为**精确串** `className="form-input"`（带闭合引号），避开同目录 `form-input__error`（`WrapperGitLoopEdit:199/235`）与 `form-input--mono/--invalid`（Select，:372），并把 `Form.tsx` 排除在 canvas glob 之外。

**【迁移风险】**
- `InputEdit` onChange 经 `InspectorHistoryBoundary` + `continuousNodeInspectorChange` meta，换 NumberInput 须把对应 `*Meta` 传给 `onPatch`，别丢历史边界归属；`OutputEdit`/`WrapperGitLoop` 的 `setPorts`/`setBindings` 第二参 meta 原样保留。
- `NumberInput` finite 守卫改变边缘输入行为（此前 NaN 会写入 def），属修 bug 但动到落库值语义，确认无测试锁定旧 NaN 行为（grep 零命中）。
- 文本锁若写宽松子串会误伤 `form-input__error`/`form-input--*`——已验证精确串安全。
- 无 xyflow 节点渲染约束（右抽屉 inspector）；无 i18n key 迁移；替换须自带测试（当前零回归网）。

**【优先级】** 中—高（含 NaN 穿透真实隐患 + 直接违反 CLAUDE.md 明文禁令）。

---

### 17. 复制按钮 5 处绕开 `lib/clipboard.ts` 的 `copyText`，各写 `navigator.clipboard`，行为已漂移

**【现状证据】** `NodeDetailDrawer.tsx:611-625`（私有 `function CopyButton`）、`canvas/EdgeInspector.tsx:194`、`canvas/NodeInspector.tsx:241`、`account.tsx:553`、`review/ReviewDocPane.tsx:365-370`。`lib/clipboard.ts` 的 `copyText()`（RFC-072）唯一调用方只剩 `TaskOutputPanel.tsx:18,236`。

**【已产生的不一致】** `copyText` 存在理由写在文件头：daemon 常经明文 http/LAN 访问，`navigator.clipboard` 为 undefined，直调抛 TypeError 被吞、按钮静默失效——这 5 处全部重新引入（`NodeDetailDrawer:615` 连 `?.` 都没有，直接 TypeError）。反馈三种（有 1.5s 复位 / 无反馈 / 自建一套）；尺寸 `btn--sm` vs `btn--xs btn--ghost`；文案 `common.copy` / `editor.nodeActions.copy` / `account.copy` 三套。

**【建议】** 新建 `CopyButton` 强制走 `copyText`：

```ts
// 新建 components/CopyButton.tsx
export interface CopyButtonProps {
  text: string
  label?: string                              // 默认 common.copy
  size?: 'sm' | 'xs'
  onCopied?: (ok: boolean) => void            // copyText 返回 boolean，供 ReviewDocPane 驱动 per-comment copied/failed
  'data-testid'?: string
}
// 内部：const ok = await copyText(text); setCopied(...); onCopied?.(ok)
```

替换 5 处 + 加源码层文本锁「禁 `navigator.clipboard`」。修正：`NodeDetailDrawer` 内私有 `CopyButton` 必须删除（否则同名冲突）；`ReviewDocPane` 是唯一有 per-comment id-keyed 双态（`copiedId`/`copyFailedId` + 自建 toast），靠 `onCopied(ok)` 回调驱动自身状态，否则保留自定义。i18n 收敛需同步 en-US/zh-CN（`editor.nodeActions.copy`(2368)、`account.copy` → `common.copy/common.copied`，`account.tsx` 现用 inline defaultValue 非真实 key）。

**【迁移风险】**
- 硬冲突：`review-sidebar-rfc-009-enhancements.test.ts:85-93` 是 HEAD 源码锁，断言 `ReviewDocPane.tsx` 必须含 `navigator.clipboard.writeText`——与「全局禁 navigator.clipboard」及「ReviewDocPane 改走 copyText」直接相撞，须同 PR 把第 87 行改成断言 `copyText(`，保留 `copiedId/copyFailedId` + 两个 per-comment i18n key 断言。
- i18n key 重载：`editor.nodeActions.copy` 与 `WorkflowCanvas:2386` `copySelection`（复制节点，语义不同）共用，迁 `common.copy` 可解耦但**绝不删该 key**，也不删 `account.copy`（保留 `label` 逃生口）。
- `ReviewDocPane` 3 态 per-comment 字形按钮不适配 2 态 text 形态，强塞会 config 膨胀——排除在迁移外或用回调驱动。
- xyflow：两个 inspector 是右抽屉面板非画布节点，无 `nodrag` 约束。

**【优先级】** 高（5 处全部重新引入明文 http 下静默失效的真实 bug）。

---

### 18. 手写 absolute 浮层（评论 popover / 跨标题提示），绕开 `usePopoverPosition` + portal

**【现状证据】** `review/ReviewDocPane.tsx:326/777/789`（selection comment popover + cross-heading-hint）自算 `rect.left + window.scrollX`，**不 portal**、**不在 scroll/resize 重锚**、**不做视口 clamp**；z-index 字面量（styles.css:8823 `z-index:50`、`.review-cross-heading-hint` `z-index:60`）。`hooks/usePopoverPosition.ts`（RFC-173）是 `Select`/`MultiSelect`/`UserPicker` 的单一事实源（capture 阶段 scroll 监听）。

**【已产生的不一致】** 页面滚动后 popover 与选区脱节（Select 家族有 capture scroll 监听）；祖先 overflow 会裁剪；全仓无 `--z-*` 变量做层级仲裁。真正 bypass 只有 2 处（都在 ReviewDocPane），`Select`/`MultiSelect`/`UserPicker` 是正确使用方不动。

**【建议】** 扩展 `usePopoverPosition` 支持虚拟锚点（向后兼容联合类型）：

```ts
// 扩展 hooks/usePopoverPosition.ts —— 三现有调用方零改动
export function usePopoverPosition<T extends HTMLElement>(
  refOrRect: RefObject<T | null> | DOMRect | (() => DOMRect | null),
  open: boolean,
): PopoverPosition
// recompute 分支：ref → getBoundingClientRect()；rect/thunk → 直接用；保留 capture-phase scroll+resize + window.scrollX/Y 语义
```

ReviewDocPane 两浮层改 `createPortal(…, document.body)` + 该 hook：选区 popover 传 `sel.getRangeAt(0)` 的 rect thunk（随滚动重锚、不受祖先 overflow 裁剪、offsetParent 恒为 body 消除坐标错算）；cross-heading-hint 保留 `key={Date.now()}` 触发 2.5s fade 重放的 remount 语义。z-index 变量化（`--z-popover/--z-tooltip/--z-dialog`）**单列独立清理项**，与本次解耦（牵涉 styles.css 多处，塞进来放大 diff）。补 `usePopoverPosition` rect-input 单测 + ReviewDocPane 源码文本断言（禁 `position:'absolute'` 字面量浮层、要求 createPortal）。

**【迁移风险】**
- 语义错配：现 hook 是「重读 live trigger rect 并每次 scroll/resize 重锚」，而选区浮层是一次性快照（Range 在点进 TextArea 后失效），静态 rect 传入会让重锚分支变空操作或被迫留失效 Range——须用 thunk 返回 live rect 或接受快照语义。
- z-index token 迁移是脚枪：50/60 字面量分散且不一致（`.select__listbox`=1200、Dialog=1200/1201），盲替误伤无关选择器、混淆 popover/dialog 层级——必须拆为独立逐选择器改动。
- RFC-173 把 hook 定义为 ref-based 单一事实源，扩签名须严格向后兼容（联合 + 分支），push 前 grep 测试对 hook 签名/调用形态的锁。
- 前端跑 vitest（不在 CI bun test），无 xyflow 约束，无 i18n 重排。

**【优先级】** 中（含滚动脱节的确定性 bug，但范围只 2 处）。

---

### 19. `role="dialog"` / `role="menu"` 浮层绕开 Dialog，缺 focus trap / Esc / 可及名称

**【现状证据】** `workflow-editor/ValidationPanel.tsx:165`（手写 `.workflow-validation__overlay` + role=dialog）、`review/ReviewDocPane.tsx:793`（评论气泡 role=dialog 无可及名称）、`UserMenu.tsx:106/121`（role=menu/menuitem 无键盘契约）、`canvas/ContextMenu.tsx:107`（role=menu 完整实现，正确参照）、`shell/InboxFooterButton.tsx:68`（有 aria-expanded 缺 aria-haspopup）、`shell/CompactTopBar.tsx:34`（`aria-haspopup="dialog"` 参照）。

**【已产生的不一致】** ValidationPanel 同组件里「走 Dialog」和「手写 overlay」两条分支 Esc/焦点/outside-click 行为不同；ReviewDocPane 气泡声明 role=dialog 却无可及名称（AT 只读「对话框」）、无焦点陷阱，Esc 仅焦点落 TextArea 才生效；UserMenu 声明 role=menu 却 Esc 关不掉 / 箭头不动 / 打开焦点不进菜单，而同应用 ContextMenu 键盘行为完全相反；UserMenu trigger 缺 `type="button"`，InboxFooterButton 缺 aria-haspopup。

**【建议】** 双抽取（注意 ux-source-ratchets 已把 ValidationPanel/ReviewDocPane 列为**刻意非-modal**，不改成 Dialog）：

```ts
// 新建 hooks/usePopoverLayer.ts —— Esc(含 stopPropagation 分层) + outside-click + 焦点归还 trigger + 可选 anchorRect
export function usePopoverLayer(opts: {
  open: boolean; onClose: () => void
  triggerRef: RefObject<HTMLElement | null>
  anchorRect?: DOMRect | (() => DOMRect | null)   // 仅 ReviewDocPane 需要
}): { layerProps: … }
// 消费：ReviewDocPane 气泡、ValidationPanel 非-compact 分支（保留非-modal，不改成 Dialog）

// 抽 ContextMenu 的 handleMenuKey + itemRefs → hooks/useMenuKeyboard.ts（popover layer + role=menu 键盘契约）
// UserMenu 消费 useMenuKeyboard（含 <Link> 路由项，用 hook 形态而非固定 item-shape 的 <Menu> 组件）+ 补 trigger type="button"
// InboxFooterButton 补 aria-haspopup
```

修正原提案：ValidationPanel 的 compact→Dialog / 非compact→overlay 是有意响应式拆分（移动端 modal、桌面内联非-modal），**不删 overlay 只留 Dialog**（那是 UX 行为变更）。

**【迁移风险】**
- `ux-source-ratchets.test.ts` 源码 ratchet「modal dialog semantics owned by Dialog, with documented non-modal exceptions」，`ROLE_DIALOG_ALLOWLIST` 已含 `Dialog.tsx` + `ReviewDocPane.tsx` + `ValidationPanel.tsx` + `SpotlightTour.tsx`——后两者是刻意非-modal，重构后须仍 role=dialog 且留白名单，绝不改成 Dialog。
- `review-detail-bubble-redesign.test.ts:69-70` 锁 `.comment-bubble{position:absolute}` + `.review-detail__bubbles{position:relative}` 且断言滚动重测量 → ReviewDocPane 气泡**不可 portal**。
- `validation-panel-navigation.test.tsx` 锁 `workflow-validation-overlay` testid + issue 按钮 role；`context-menu-keyboard.test.tsx` 直接 render `<ContextMenu>` 断言 `getByText`/`activeElement` → 抽 hook 时公有 API/DOM 需完全不变。
- UserMenu 项含 TanStack `<Link>`（to=/account、/users），固定 item-shape 的 `<Menu>` 会丢路由语义——必须 hook 形态。
- 三浮层当前零测试覆盖，属 CLAUDE.md 非平凡重构须走 RFC 且补测试；无 i18n key 迁移，不触 xyflow 节点渲染。

**【优先级】** 中（UserMenu 非法 role=menu 无键盘契约是真实 a11y bug，但属需 RFC 的重构）。

---

### 20. 单选组（radiogroup）多套并行：LanguageSwitch / WorkflowStarter / ConnectionDialog / attempt picker 绕开 Segmented / ChoiceCards

**【现状证据】**
- `LanguageSwitch.tsx:90/118`：容器 `role="group"` 包 `role="radio"` 子项（radio 须在 radiogroup 内，**非法 ARIA**），无方向键、无 roving tabindex，错误行手拼 `.language-switch__error`；`.language-switch__*` 是 `.segmented` 的逐字 fork（styles.css:2355-2391，RFC-192 给 `.segmented__option` 补的 `white-space:nowrap` 与 kbd 提示都没跟上）。
- `WorkflowStarterDialog.tsx:300`：手写 radiogroup/aria-checked 但缺方向键 + roving tabindex；首卡 `firstStarterRef` 喂 Dialog `initialFocusRef`(:274/:310)。
- `ConnectionDialog.tsx:455/527`：`role="group"` + `aria-pressed`（toggle 语义，屏读器读「按下」而非「单选已选中」），无方向键；`.connection-dialog__mode button.is-active`(styles.css:6152) 用 panel 底而 `.segmented__option--active`(2438) 用 accent-fill。
- `memory/distill-job-detail/ConversationSection.tsx:73`（AttemptPickerLite chip-row，选中态 `btn--primary`）——`node-session/SessionTab.tsx:95-107` 注释已记录「chip-row 布局在 retry/fan-out shard 多时换行，已改用 Select」。
- `Segmented.tsx`（已含 roving tabindex + ←→↑↓ + Home/End + `testidPrefix` + `activeOptionRef` + 逐项 disabled）、`ChoiceCards.tsx`（带描述卡片单选）；`Segmented.tsx:5` 注释点名 LanguageSwitch 为目标消费者却从未接线。

**【已产生的不一致】** 四套键盘契约（Segmented 全向 + Home/End、ChoiceCards 无 Home/End、LanguageSwitch/WorkflowStarter 无方向键）；三种「选中态」视觉；同一 App 里两个 role=menu/radiogroup 键盘行为相反；同一「选一次 attempt」语义在 SessionTab（Select）与 distill（chip-row）结论相反。

**【建议】**

```tsx
// LanguageSwitch → <Segmented>（顺带修 role=group→radiogroup 非法 ARIA），error 行留 Segmented 外层兄弟
<Segmented value={current} options={SUPPORTED_LANGUAGES.map(l => ({ value: l, label: t(`sidebar.lang.${l}`), data: { lang: l } }))}
  onChange={mutate} disabled={mutation.isPending} ariaLabel={t('sidebar.languageGroupLabel')} className="language-switch" />
// 错误行改走 <Field error> 或既有 .form-field__error（原提案的 .field-error 不存在）

// ConnectionDialog inputMode(new/reuse)+fanoutRole(shard/broadcast) → <Segmented testidPrefix='connection-mode'/'connection-fanout-role'>
//   new/reuse 的 setMode+setTargetPortName 副作用放进 onChange；per-option disabled 用 option.disabled

// WorkflowStarter catalog → <ChoiceCards testidPrefix='workflow-starter'>，须先给 ChoiceCards 加 activeOptionRef（照抄 Segmented.tsx:71）承接 Dialog initialFocusRef
// AttemptPickerLite → attempts 少用 <Segmented>、多用 <Select>（复用 SessionTab 已验证方案）；attemptIndex 是 number，需 String()/Number() 往返
```

抽 roving-tabindex + 方向键 + Home/End 为 `hooks/useRovingRadioGroup.ts`，`Segmented`/`ChoiceCards` 内部改用它（顺带给 ChoiceCards 补齐 Home/End）：

```ts
// 扩展 components/ChoiceCards.tsx —— 加 activeOptionRef?: RefObject<HTMLButtonElement|null>；value 泛型放宽为完整 WorkflowStarterId（catalog 含 'blank'）
```

删 `.language-switch__options/__option/--active/:hover/:disabled`、`.connection-dialog__mode`(6134-6157)、`.workflow-starter__catalog/__card`。**排除** `ScheduleDialog:268`（多选 toggle-button 组，非 radiogroup）。

**【迁移风险】**
- `segmented.test.tsx`（~30 断言）容器 className 字节精确（`toBe('segmented')`）→ 抽 hook 的 containerProps 绝不注入 className；tabindex/ArrowRight/Home/End/ArrowUp 的 onChange 目标 + activeElement 逐一锁死，焦点用 `:scope > [role=radio]`[index]——重构须逐字复刻。
- `connection-dialog.test.tsx:235` 断言 `connection-fanout-role-shard` 的 `aria-pressed==='true'` → Segmented 用 `aria-checked`，此断言须改（group→radiogroup 是语义升级非退化）；:117 靠 `.disabled` 属性、:107/108 靠 testid（testidPrefix 派生可保）。
- `language-switch.test.tsx`（RFC-025 T2，8 例）锁 `data-lang`（走 Segmented `data:{lang}`）+ role=radio + aria-checked + pending 双禁用 + `role=alert` 错误行 + 点已选无 PUT + PUT body 恰 `{language}`——错误行必须留 Segmented 外层；`getByRole('alert')` 依赖 error 组件在无 ManagedLiveRegion provider 时才 emit alert（该测试无 provider 故成立）。
- `workflow-starter-dialog.test.tsx` 锁 `workflow-starter-${id}` testid（ChoiceCards `testidPrefix` 派生 `${prefix}-${value}` 吻合）+ `blank→onUseBlank`；`initialFocusRef={firstStarterRef}`(card[0]) 是 Dialog 初始焦点来源，ChoiceCards 不转发 ref 会丢初始焦点——`activeOptionRef` 为必需扩展。
- `conversation-section.test.tsx:77`（`distill-attempt-0` testid，testidPrefix 可保）。
- `root-language-wiring.test.ts:25` 只源码锁 AppShell 导入 `<LanguageSwitch/>`（组件名不变安全）。原提案 `.field-error` 不存在，须剔除。CSS 在 prettier scope 内可删，但删 `.language-switch` 外层壳前 grep `.sidebar__footer-row .language-switch`。无 xyflow 约束（sidebar/Dialog 非画布节点）。

**【优先级】** 高（LanguageSwitch 非法 ARIA + 逐字 fork；attempt picker 有 chip-row 淘汰回归）。

---

### 21. 「多选集合筛选」三处各写一套（裸 checkbox ×2 + chip 按钮），绕开 MultiSelect

**【现状证据】** `structure/StructuralDiffView.tsx:277`（`.structure__sev-toggle` 11px 裸 checkbox）、`structure/StructuralGraph.tsx:425`（`.structure-graph__edge-toggle` 裸 checkbox）、`NodeDetailDrawer.tsx:523`（`.events-filter` chip 按钮）。`MultiSelect.tsx`（portal + 可搜索 + checkbox listbox）、`Segmented`、`ChipsInput` 都在，这些筛选点一个没用。

**【已产生的不一致】** 结构页 11px 裸 checkbox+文字 vs 节点抽屉 chip 切换态；两处裸 checkbox 组无 `role="group"`/fieldset/aria-label（屏读器听不出是筛选组），chip 版连 `aria-pressed` 都没有（`NodeDetailDrawer:526` 只靠 class 表选中）；空集合兜底只有 StructuralDiffView 做了（清空即全选，:19-21），另两处清空后什么都不显示。

**【建议】** 新建承接固定枚举多选过滤（FilesPicker 动态大列表走 MultiSelect，**不在范围**）：

```ts
// 新建 components/ToggleFilterGroup.tsx
export interface ToggleFilterGroupProps<V extends string> {
  value: Set<V>; onChange: (v: Set<V>) => void
  options: Array<{ value: V; label: string; swatch?: ReactNode; swatchClassName?: string }>
  ariaLabel: string
  emptyMeansAll?: boolean   // 每调用点显式配置，统一空集语义
}
// 内部 role="group" + 一排 aria-pressed chip 按钮（复用 .chip/.chip--active），swatch 承接配色图例
```

替换三处：StructuralDiffView(sevFilter, `emptyMeansAll=true`)、StructuralGraph(edgeKinds)、NodeDetailDrawer(enabledKinds)，删 `.structure__sev-toggle`/`.structure-graph__edge-toggle`/`.events-filter` 私有 CSS（`.events-filter` 上挂共享 chip-row，勿连带删）。

**【迁移风险】**
- 测试锁：`files-picker.test.tsx:74/93/135/157/168/179` 用 `getAllByRole('checkbox')` + `.parentElement.textContent`——ToggleFilterGroup 渲染 role=button，把 FilesPicker 纳入会红这些断言（排除 FilesPicker 的第二理由）；`structure-view.test.tsx:397` 在 diff **卡片**上断言 `.structure__severity--{s}`（与筛选 toggle 无关，删的是 `__sev-toggle` 外壳非 severity swatch class）；`structure-view.test.tsx` 只断言 tablist/tabpanel/status，未锁 checkbox role，可安全改。
- 行为变更：StructuralGraph/NodeDetailDrawer 当前清空后不回填（NodeDetailDrawer 清空即显示 noEventsMatch），`emptyMeansAll` 三态须逐点核对，弄反会静默改筛选行为（Graph 空集当前=空结果，不能被组件强制全选）。
- i18n：NodeDetailDrawer chip 直接渲染原始枚举 `{k}` 未 i18n，统一到 `label` prop 需为 `NODE_EVENT_KIND` 补 key（结构两处用 `SEVERITY_LABEL`/`EDGE_LABEL` 已走 t()）；swatch 靠 per-value CSS 类，槽位需透传任意 className。
- xyflow：StructuralGraph toggle 在 `.structure-graph__controls`（ReactFlowProvider 外），无节点约束。`structure-graph-css.test.ts` 锁 `.sg-card`/handle，删 `__edge-toggle` 安全。

**【优先级】** 中。

---

### 22. 纵向 tablist（文件 / 端口选择列表）手写三遍，键盘契约互不相同

**【现状证据】** `TaskOutputPanel.tsx:99/133`、`WorktreeDiffPanel.tsx:153/244`、`structure/StructuralDiffView.tsx:488/522`（三套纵向 roving tablist）；`TabBar.tsx:243`（仅横向 ArrowLeft/Right + overflow 滚动）。

**【已产生的不一致】** 四套键盘契约：TabBar 只 Left/Right；激活模式 TaskOutputPanel 是 manual（Enter/Space 才选）、WorktreeDiffPanel/StructuralDiffView 是 automatic（箭头即切）；Space 语义冲突（WorktreeDiffPanel=切「已查看」勾选、StructuralDiffView 无动作、TaskOutputPanel=激活 tab）。（注：候选原文「go() 只改 selection、焦点停旧 tab、aria-selected 与 activeElement 分离」经核实为**伪造**——`WorktreeDiffPanel:146`/`StructuralDiffView:486` 的 `selectFile` 均 `.focus()`，tab 均 roving tabIndex；activation 与 Space 语义是有意功能差异非 bug。）

**【建议】** 抽「纵向 roving tablist 焦点机器」：

```ts
// 新建 hooks/useRovingTablist.ts —— 目标 WorktreeDiffPanel + StructuralDiffView（selectFile/onTablistKeyDown/go 近逐字重复）
export function useRovingTablist(opts: {
  order: string[]; active: string; onSelect: (key: string) => void
  activation?: 'automatic' | 'manual'   // TaskOutputPanel 走 manual（箭头只移焦点、Enter/Space 才 commit）——真实配置轴非 bug
}): { tablistProps; tabProps: (key: string) => … }
// 统一 roving tabIndex + 焦点跟随 + Home/End 边界钳制
```

`TaskOutputPanel` 也可消费但显式 `activation:'manual'`；`WorktreeDiffPanel` 的 `Space=markViewed` 保持为叠加的额外 onKeyDown（守卫 `target.tagName !== 'INPUT'`），不重写整个 switch。**TabBar 折入属可选低价值项**（横向 + overflow chrome + `tab-bar.test.tsx:217/234` 锁 ArrowLeft/Right WRAP + skip-disabled），scope 限定两个纵向 diff（+ TaskOutputPanel）。

**【迁移风险】**
- `task-output-panel.test.tsx` 强锁：`aria-orientation='vertical'`、roving tabIndex `[0,-1,-1]`、manual 激活（ArrowDown 只移焦点不改选择）、Enter 与 Space 提交、Home/End、metaKey 箭头被忽略、`task-output-option-N` testid——hook 迁移后全保持；尤其 Space 在此=选中而 Worktree=markViewed，hook 按 activation 区分。
- `tab-callsite-contract.test.ts` 把两纵向 diff 归类为「manual true tabs / tree-shaped keyboard model」要求稳定 tabDomIds——保持 tabDomIds 用法，**不要**改写成 `<TabBar>` callsite（否则改 `TRUE_TAB_CALLSITES` 名单）。
- `worktree-diff-tablist-scroll.test.ts` 锁 `.worktree-diff__tablist`/`.structure__file-tab` 的 overflow-y/flex-shrink——hook 只返回 props/ref，className 由调用方渲染，不改类名即不受影响。`tab-bar.test.tsx:217/234` 是把 TabBar 排除的硬约束。
- 三站点当前无键盘契约测试，抽 hook 后须补 manual-vs-automatic 覆盖；无 i18n 重排；无 xyflow（task-detail/diff 面板非画布节点）。`WorktreeDiffPanel` line 187 的「target.tagName==='INPUT' 跳过」守卫必须保留。

**【优先级】** 高（四套键盘契约的真实一致性缺陷，但 a11y 部分论据需去伪）。

---

### 23. 「互斥单选 attempt」chip-row 与「连通性测试结果」等零散绕开（补充）

前述第 20 节已覆盖 ConnectionDialog / attempt picker，第 9 节已覆盖连通性测试结果——此处仅登记两处**独立可先落**的小项，避免遗漏：

**【现状证据】**
- OIDC 连通性 `settings.tsx:1888`（`.oidc-form__test-result--ok/--err` + 硬编码 ✓/✗ + `<br>`）：已并入第 9 节，改成功走 `<NoticeBanner tone="success" size="compact">`、失败走 `<ErrorBanner>`，issuer/token/jwks 用 `<dl>` 作 children，删 `styles.css:983-1006`。
- `WorkflowStarterDialog.tsx:366/375/385/396` 4 状态色块：已并入第 9 节。

**【建议 / 风险 / 优先级】** 见第 9 节；两处均无测试源码锁（grep 零命中 `oidc-form__test-result` / `workflow-starter-*` 断言），是低风险速赢，可各自独立成小 PR，落地时补一条源码文本断言（如「settings.tsx 不再出现 `oidc-form__test-result`」）作回归兜底。优先级中。

---

## 落地次序建议

1. **零依赖速赢**（无原语扩展、无跨文件决策）：第 8 节 ReadonlyValue、第 12 节 CloseButton（修 canvas class bug）、第 17 节 CopyButton（修明文 http 静默失效）、第 6 节杀 `.status-badge`、第 23 节 OIDC/WorkflowStarter banner。
2. **需最小扩展公共原语**：第 2 节 EmptyState `align`/micro、第 3/10 节 ErrorBanner `onRetry`、第 4 节 Field `errorTestId`、第 20 节 ChoiceCards `activeOptionRef`。
3. **需用户拍板的决策点**：第 5/7 节 StatusChip 加 `accent`/`soft`（反悔 flag-audit W0）、第 11 节 owner tooltip 文案统一、第 13 节 RelativeTime 详情页口径放宽（改 RFC-191/192 D4）。
4. **非平凡重构须走 RFC**：第 14 节 FormSection/TechnicalDetails、第 18/19 节 popover/menu hook、第 22 节 useRovingTablist、第 20 节 useRovingRadioGroup。

所有改动须遵守多人并发树纪律（`styles.css` / `i18n/*.ts` / `settings.tsx` 现均有他人未提改动，按精确 pathspec 一次性 commit）；前端测试跑 vitest 非 `bun test`，改完须 `bun run typecheck && vitest && format:check` 全绿，并按 `[feedback_frontend_visual_verify_repro]` 对涉及 styles.css 的改动做 light+dark 最小复现截图。

---

## 5. CSS 层重复（css-duplication）

## css-duplication

以下每一节对应一类被多处复制的 CSS/组件样板。行号取自本轮已核实的真实出现点（部分条目更正了原始候选的过期行号，以类名/grep 锚点为准）。同一去重目标被多路审计独立命中的，已合并为一节并标注命中路数。

---

### 1. 「键: 值」元信息定义列表（dl 网格）五~六套平行命名空间

多路审计（foundBy 2 + 3 处独立提案）指向同一目标：任务详情、节点抽屉、定时任务详情、工作组信息、蒸馏失败诊断五~六块「两列 grid + muted 的 dt + margin:0 的 dd」各写一套。

**【现状证据】**
- `packages/frontend/src/styles.css:3477` `.task-meta`（`110px 1fr` / `gap 4px 16px` / `13px`）
- `packages/frontend/src/styles.css:14570` `.detail-grid`（`max-content 1fr` / `var(--space-1) var(--space-3)` / dt `var(--font-sm)`）
- `packages/frontend/src/styles.css:15318` `.workgroup-room__info`（`auto 1fr` / `gap 4px 8px` / `12px`）
- `packages/frontend/src/styles.css:12550` `.distill-job-detail__diagnostics-list`（`max-content 1fr` / dt `var(--font-xs)`）
- `packages/frontend/src/styles.css:743` `.account-defs__row`（`140px 1fr` / `gap 12px`，uppercase 皮肤——排除）
- `packages/frontend/src/styles.css:15523` `.wizard-summary__row`（`10rem 1fr` / `gap 0.75rem`，卡片形态——排除）
- 扁平调用点：`routes/tasks.detail.tsx:880`、`components/NodeDetailDrawer.tsx:348`、`routes/scheduled.$id.tsx:190`、`components/workgroup/WorkgroupRoom.tsx:801`、`components/memory/distill-job-detail/FailureDiagnostics.tsx:23`、`routes/skills.detail.tsx:825`

**【已产生的不一致】** 标签列宽出现 `max-content / 110px / 140px / auto / 10rem` 五种，行距 `4px 16px / var(--space-1) var(--space-3) / 4px 8px / 0.4rem 1rem` 四种，字号 `13px / 12px / var(--font-xs) / var(--font-sm)`（px 与 rem/token 混用）。用户在 `/tasks/:id` 与 `/scheduled/:id` 之间切换，相邻界面的元信息表键列基线与字号都在跳。

**【建议】** 新建 `components/DescriptionList.tsx`（渲染扁平 `<dl class="desc-list">`，无 div 包行），value/label 必须是 `ReactNode` 且支持逐格 `className`/`testId` 透传（`workgroup-room-goal` 的 ClampedText、`.task-meta__error` 修饰、条件行都要能落地）。

```ts
// 新建 components/DescriptionList.tsx
type DescItem = {
  term: ReactNode;
  children: ReactNode;      // dd 内容，可含 <code>/ClampedText/StatusChip
  testId?: string;          // 透传到 dd
  ddClassName?: string;     // 保留 .task-meta__error 之类修饰
};
interface DescriptionListProps {
  items: DescItem[];        // 条件行由调用方 filter 后传入，勿在 items 内写空 term
  labelWidth?: 'auto' | 'sm' | 'md';  // 取代 110px/max-content/auto/140px
  density?: 'sm' | 'md';    // gap: var(--space-1) var(--space-3) / var(--space-2) var(--space-4)
  className?: string;
}
```

CSS 收敛为单一 `.desc-list`：`grid-template-columns: max-content minmax(0,1fr)`、dt `color:var(--muted); font-size:var(--font-sm)`、dd `margin:0; min-width:0; overflow-wrap:anywhere`。迁移 5 处扁平调用点后删除 `.task-meta / .detail-grid / .workgroup-room__info / .distill-job-detail__diagnostics-list / .skill-detail__technical dl` 五段规则；**保留** `.task-meta__error`（dd 修饰）、`.workgroup-room__goal { min-width:0 }`。**排除** `.wizard-summary`（卡片 + 行内编辑 + 移动端源码锁）与 `.account-defs`（uppercase 资料版式）。

**【迁移风险】**
- 源码锁：`tests/specialized-mobile-layout.test.ts:49` 正则锁 `.wizard-summary__row { grid-template-columns: minmax(0, 1fr)`——只要不动 wizard-summary 即安全，强折则红。
- `tests/task-question-name-overflow.test.tsx`（5 条 CSS 正则 + DOM）与 `tests/task-question-list.test.tsx:326/796/833/853` 硬锁 `.task-questions__meta-*` 的 inline-flex/ellipsis 契约——`TaskQuestionList` 是独立药丸行原语，**必须排除**，不得并入。
- `.task-meta` 用 `word-break: break-all`，换成 `overflow-wrap: anywhere` 后长 ULID/worktree 路径断行位置会变，`tasks.detail` dd 内含 `<code>` 路径/URL，需按 minimal repro + 明暗双主题截图核对。
- `tasks.detail.tsx:880` 的 dl 含大量 `{cond && (<><dt/><dd/></>)}`，改 items 数组要保证条件项被 filter 而非渲染空 dt。
- 无 i18n key 迁移（标签文案仍由调用点 `t(...)`）；NodeDetailDrawer/WorkgroupRoom 均为抽屉/侧栏，无 xyflow 约束。
- `styles.css` 处于多人共享工作树 `M` 状态，删规则按精确 pathspec 一次性 `git commit --`，勿全量 format。
- 需补一条「`.task-meta/.detail-grid/.workgroup-room__info` 不再出现在源码」的兜底文本断言。

**【优先级】** 高（跨 5-6 处真实同形、相邻界面对齐 bug、且已核实测试锁面清晰）。

---

### 2. 数字计数徽标 / 角标（CountBadge）多族并行

多路审计（foundBy 2 + 2 处独立提案）覆盖三类计数：侧栏/首页/抽屉的「待办数量药丸」、导航「计数角标」（sidebar/select/tabs/page-section-nav）、以及「标题旁的内联计数」（`*__count`）。

**【现状证据】**
- 药丸族：`styles.css:314` `.sidebar__badge`（20×20 / `999px` / `--danger-fill`）、`styles.css:1859` `.homepage-section__count`（22×20 / accent 14% + 变体硬编码 `#f5a623`/`#b1660d`）、`styles.css:1510` `.inbox-dialog__filter-count`（18×18 / `var(--radius-pill)` / currentColor 14%）
- 角标族：`styles.css:656` `.select__badge`、`styles.css:4468`（tabs `.tabs__tab-badge`）、`styles.css:4808`（`.page-section-nav__badge`）、`styles.css:6808` `.canvas-node__qbadge`（button + absolute overhang）；`styles.css:332` `.sidebar__link--active .sidebar__badge { background:#fff }`（裸 hex）
- 内联文字族（`*__count`）：`styles.css:15733` `.split__count`（`var(--font-xs)`）、`styles.css:16384` `.gallery__count`、`styles.css:14405` `.task-questions__count`、`styles.css:14652` `.workgroup-rail__count`（`var(--font-sm)`）、`styles.css:4013` `.agent-port-section__count`（硬编码 12px + `var(--font-mono)`）
- 消费点：`components/shell/InboxFooterButton.tsx:75`、`MemoryPendingBadge.tsx:100`、`home/TaskFeed.tsx:107`、`shell/InboxDrawer.tsx:95`、`Select.tsx:64`、`TabBar.tsx:345`、`PageSectionNav.tsx:294`、`components/structure/StructuralGraph.tsx:162`、`components/split/ResourceSplitPage.tsx:371`、`components/gallery/ResourceGalleryPage.tsx:137`

**【已产生的不一致】** 直径 18/20/22px 三档、`--attention`/`--danger` 修饰符逐字复制三~四份、底色 `--danger-fill / var(--bg) / color-mix(text 10%) / var(--panel)` 四选四、字重 500/600/700、圆角 `999px` vs `var(--radius-pill)`、`#f5a623`/`#b1660d`/`#fff` 裸 hex 未走 token。`'99+'` 截断在 InboxFooterButton 与 MemoryPendingBadge 各写一遍，而 TaskFeed/InboxDrawer 完全不截断。`font-variant-numeric: tabular-nums` 与 `aria-live` 只有个别处有。

**【建议】** 新建 `components/CountBadge.tsx`，一个组件覆盖「药丸」与「内联」两种形态；单一 `.count-badge` 命名空间，圆角一律 `var(--radius-pill)`，`--attention` 用 `var(--warn)`/`color-mix` 取代裸 hex，`>max` 截断收进组件。

```ts
// 新建 components/CountBadge.tsx
interface CountBadgeProps {
  count: number;
  form?: 'pill' | 'inline';                 // pill=角标, inline=标题旁灰字
  size?: 'sm' | 'md';                        // sm=18px, md=20px（sidebar）
  tone?: 'neutral' | 'accent' | 'attention' | 'danger' | 'inherit';
  max?: number;                              // 默认 99，>max → `${max}+`
  live?: boolean;                            // 挂 aria-live="polite"
  ariaLabel?: string;
  className?: string;                        // 透传定位类 margin-left/absolute
  'data-testid'?: string;                    // 必须透传，见风险
}
```

定位类（`margin-left:auto`、canvas 角标 `top/right:-8px` overhang）留在各 wrapper，用 `className` 透传；sidebar active 态白底反转改挂 `.count-badge` 的 host 修饰类，用 `var(--on-accent)`/`var(--panel)` 取代 `#fff`。分批迁移：先换无锁点（TaskFeed/InboxDrawer/account、`split__count`/`gallery__count`），再换有锁点（InboxFooter/Memory/Select/TabBar/PageSectionNav）并同 PR 改断言。

**【迁移风险】（本类锁面最密，属非平凡重构，需先走 RFC）**
- `tests/sidebar-badge-bubble.test.ts` readFileSync 正则锁 `.sidebar__badge` **规则体**（逐条断言 `border-radius:999px`、`background:var(--danger-fill)`、`min-width:\d+px`）+ 双选择器组合 `.nav-item--active .sidebar__badge, .nav-item-row--active .sidebar__badge`，还断言 `InboxFooterButton.tsx` 含 `sidebar__badge` 且 `/total > 99 \? '99\+'/`——把 99+ 收进组件会同时打红，必须整体改写该测试为对 `.count-badge` 规则体的等价断言（不是删）。
- `tests/tab-bar.test.tsx:523/527/553/604` 用 `toBe('tabs__tab-badge tabs__tab-badge--neutral')` **精确全等**，追加 `count-badge` class 即红；TabBar JSDoc（`:10`/`:42`）把 `tabs__tab-badge` 写进公开契约，需同步。
- `tests/page-section-nav.test.tsx:190` 用 `.select__group .select__badge` 组合选择器取 textContent。
- `e2e/nav-redesign.spec.ts:155` 依赖 `[data-testid="inbox-footer-badge"]`（e2e 在 workspace typecheck 之外，本地绿也可能红 CI）。
- InboxDrawer filter count 在 `.segmented` 内靠父级 color 翻转激活态——`tone='inherit'` 分支不能写 `color`，需测试覆盖。
- `canvas-node__qbadge` 是 `<button>` + `:hover` + `cursor`，需 `as`/wrapper 才吃得下，否则先跳过。
- `structure/StructuralGraph.tsx:162` 的 `.sg-pkgnode__count` 在 xyflow 自定义节点 `PkgSummaryNode` 内，11px→token 会改节点测量高度、影响连线落点，需保留显式尺寸或做双主题截图。
- `.workflow-sync__count, .workflow-sync__kind` 共用一块规则，删 `__count` 前先拆 `__kind`。
- 统一 18/20/22 → sm/md 两档必改像素，需刷 Playwright 侧栏/tab 基线；`settings.png` 不受影响。

**【优先级】** 高（三族 ≥5 套 CSS + 6-8 处消费点、含裸 hex 主题 bug；但锁面密，须 RFC + 分批）。

---

### 3. 数据表格体系（.data-table）多套平行命名空间

多路审计（foundBy 2 + 3 处独立提案，含 `.account-table`、inventory 专项）指向：全仓有 5-6 套并行表格 CSS，只有 `.data-table` 有 panel 底/边框/圆角 + `<TableViewport>` 横向溢出提示。

**【现状证据】**
- `styles.css:3240` `.data-table` 基线（`10px 14px` / 14px / th 大写+letter-spacing + 外框 + `overflow:hidden` + 一整套 `__truncate/__muted/__nowrap/__actions/--compact`）
- `styles.css:3360` `.data-table--compact`（实测 `6px 10px` + `var(--font-sm)`，注释写明供 dialog/inventory 嵌入）
- `styles.css:789` `.account-table`（`8px 10px` / 13px / th 底 `color-mix(--border 30%)`；活跃：`routes/account.tsx:596/704/802`、`routes/settings.tsx:1462/1480` OIDC 表）
- `styles.css:2955` `.diagnose-table`（`8px 10px` / 13px；`components/tasks/TaskDiagnosePanel.tsx:152`）
- `styles.css:10855` `.batch-import-table`（`6px 8px` / 13px + `tr[data-row-status] td:nth-child(3)` 按列序号着色 + 三处裸 hex 兜底；`components/repos/BatchImportDialog.tsx:348`）
- `styles.css:11289` `.inventory-table`（`4px 8px` / 12px + `table-layout:fixed` + colgroup 百分比列宽 + `tbody tr:hover`；`components/inventory/{Agents,Skills,Mcps,Plugins}Table.tsx`）
- `styles.css:10811` `.repos-table` —— **死代码**（`repos.tsx:116` 已改用 `.data-table`，仅 data-testid 同名）

**【已产生的不一致】** 行高两套（`8px 10px/13px` vs `10px 14px/14px`），/account PAT 表与 /repos 表相邻放置行高差 4px；表头分裂（`.account-table th` `color-mix(--border 30%)` 11px vs `.data-table th` `var(--bg)` 12px）；`vertical-align` middle vs top（多行单元格错位）；只有 `.data-table` 有横向溢出提示，其余窄屏撑破；`.batch-import-table` 靠 `nth-child(3)` 上色（列一改就错位）+ `var(--success,#2a7a2a)` 等硬编码兜底。

**【建议】** 不新建组件，收敛到既有 `.data-table` + 密度修饰符（复用已存在的 `--compact`，勿新造 `--dense`），并抽 `components/inventory/InventoryTable.tsx` 收编四张表壳与空态。

```ts
// 新建 components/inventory/InventoryTable.tsx（四张 inventory 表共用表壳）
interface InventoryTableProps<Row> {
  cols: { key: string; label: string; width?: string }[];  // colgroup 百分比列宽保留
  rows: Row[];
  renderCell: (row: Row, key: string) => ReactNode;
  emptyLabel: string;                     // 统一走 <EmptyState size="compact">
  testId?: string;
}
// 扩展既有 .data-table 修饰符：--compact(6/10) 承接 dialog，
// 新增 --flush(去 border/radius/panel-bg，供 account-card 内表避免双边框)、
// --fixed(table-layout:fixed)、--dense(4/8 供窄 drawer 的 inventory)
```

三步落地：**(1) 删死代码** `.repos-table` 整组（`styles.css:10811-10835`）+ `nth-child(3)` 着色（`10885-10893`）+ 三处裸 hex；**(2) 表头统一** 把 account/diagnose/batch-import/inventory 的 th 视觉并入 `.data-table th` 定义、padding/字号换 token；**(3) callsite 分批** 换 `data-table` + 修饰符，`__url/__detail`/colgroup 列宽原样保留。BatchImportDialog 状态列改用 `<StatusChip>`（已存在），inventory 空态改 `<EmptyState size="compact">`（同抽屉 `InjectedMemoriesCard.tsx:82/87` 借用的 `inventory-section__missing` 一并归入）。

**【迁移风险】**
- 源码锁（迁移时会红，需同步改）：`tests/account-users-settings-table-shell.test.ts:39` 断言 `account.tsx` 恰 3 处 `<table className="account-table">`、`:86` 断言 settings OIDC 表用 account-table（RFC-198 决策）；`tests/data-table-callsite.test.ts:32-36` **禁止** AgentImportDialog 用 `data-table--compact`（刻意选卡片，是「dialog 一律转密集表」的反例）；`tests/task-diagnose-panel-repair-wiring.test.tsx:136/138` 锁 `.diagnose-table__detail-disclosure`；`tests/batch-import-dialog.test.tsx:193-219` 锁 `table-viewport__scroller`/`--lg` + `data-row-status` + testid；`tests/memory-panels-async-state.test.tsx:212`、`tests/clarify-list-layout-alignment.test.ts:48/53` 正则锁 `<TableViewport …><table className="data-table">` 源码文本——往 table 加修饰符会打破这条正则，须同步放宽。
- `tests/ux-source-ratchets.test.ts:121-127` 的 `EMBEDDED_TABLE_ALLOWLIST` 明确豁免 inventory 四表不套 TableViewport（drawer 本身即滚动容器）——**不要**要求「表格一律经 TableViewport」。
- `.data-table` 带 `overflow:hidden`（已知裁剪弹层，见 `Select.tsx:136` 注释），弹窗内 `.batch-import-table` 迁入需逐 callsite 验证下拉/action 菜单；四张目标表都在已有 panel/Dialog 内，不加 `--flush` 会双边框。
- `.inventory-table tbody tr:hover` accent 6% 背景在 `.data-table` 上不存在，合并要保留交互反馈；`.data-table th` 有 `white-space:nowrap`，inventory 窄 drawer 会撑破。
- e2e：`e2e/lifecycle-diagnose.spec.ts:258`、`e2e/main.spec.ts:569` 依赖 `task-diagnose-table`/`batch-import-table` testid——只换 className，保留 testid。
- `settings.tsx`/`SubmoduleBadge.tsx` 当前 `M`（RFC-210 并行），触碰 `settings.tsx:1462` 需确认无同行冲突、精确 pathspec 提交。
- 无 i18n key 迁移；inventory 在右抽屉，无 xyflow 约束；`.repos-table` 删除零风险。

**【优先级】** 高（6 套体系、相邻页视觉分裂、含死代码 + nth-child 脆弱着色；但 RFC-198 已就 account/AgentImport 表做过决策，收敛须尊重既有边界）。

---

### 4. 「整行是个 button」列表行原语三套 CSS

**【现状证据】**
- `styles.css:1914` `.task-row`、`styles.css:1990` `.inbox-row`（逐行等价的 button 重置：`padding:8px 10px; border-radius:6px; border:1px solid transparent; background:transparent; font:inherit; cursor:pointer` + hover accent 8%，全硬编码 px）
- `styles.css:1547` `.inbox-dialog__item`（**同一批 review/clarify 数据**却用 token 体系：`var(--space-3)` / `var(--radius-md)` / `var(--panel)` 实底 + transition）
- `styles.css:4958` `.file-tree__item`
- 消费点：`components/home/task-row.tsx:36`、`home/InboxPreviewList.tsx:116`、`shell/InboxDrawer.tsx:193/328`、`components/SkillFileTree.tsx:157`

**【已产生的不一致】** 首页「待你处理」的行与侧栏收件箱的行内容一模一样，一个是透明扁行、一个是带边框的面板卡片；子元素也各写一套（`inbox-row__kind/__title/__subtitle/__time` vs `inbox-dialog__kind/__item-title/__item-source/__time`）。

**【建议】** 不抽带 kind/title/subtitle/trailing 全槽位的 React 组件（三处内部布局本质不同，会退化成一堆布尔 prop 且撞测试锁）。改抽 `.row-button` 基类（button 外观重置 + `text-align:left` + `font:inherit` + `min-width:0` + 统一 `:focus-visible` 走 `--focus-ring-*`），各 button 站点保留原 class 并追加 `.row-button` + 修饰。

```ts
// 无新组件；新增 CSS 工具类（各 button 站点 append）：
// .row-button              button 重置 + focus-ring
// .row-button--comfy/--dense   密度（padding 走 var(--space-*)）
// .row-button--flat/--carded   强调级别（透明扁行 / 带边框面板）
// 各站点 CSS 只留 display/grid-template-columns/gap 与专属细节
```

视觉 bug 单独一步修：把首页 `.inbox-row` 与抽屉 `.inbox-dialog__item` 的强调级别对齐（统一挑 `--flat` 或 `--carded`），子元素合并成一套但**保留旧类名作 alias** 以免打断测试锁。`.pat-scopes__row`/`.files-picker__row` 是 checkbox `<label>`（非 button），排除。

**【迁移风险】**
- 源码锁：`tests/inbox-drawer.test.tsx:226/235/507/509/552` 断言 `className.includes('inbox-dialog__item…')`；`tests/inbox-workgroup-source.test.tsx:92`、`tests/inbox-drawer-task-name.test.tsx:23/63`（锁 TSX + styles.css 文本）、`tests/homepage-task-row-status.test.tsx:53-56`（`.status-chip.task-row__status`）——只能**追加**修饰、不能改名/删。
- `tests/specialized-mobile-layout.test.ts:81` 正则锁 `.task-row { grid-template-columns: minmax(0, 1fr) auto;` 且必须落在 `SPECIALIZED_MARKER` 与「RFC-198」注释之间——任何改名/挪动该响应式块即红。
- data-testid 契约面宽：`task-row-*`、`inbox-preview-<kind>-<rowKey>`、`inbox-row-<kind>-<rowKey>`、`inbox-row-task-name` 等散在 5 个测试；`task-row-${id}` 被 `home/task-row.tsx:39` 与 `routes/tasks.tsx:260` **两个不相干组件共用**（后者不带 `.task-row`），组件化时勿误当同一原语。
- e2e 视觉基线：`e2e/visual-regression.spec.ts:541/570/581`、`a11y.spec.ts:250`、`nav-redesign.spec.ts:184`、`ux-consistency.spec.ts:366/987/1047` 在首页行/抽屉行上截图；硬编码 px→token 必改像素，需刷基线；焦点环从「无」变「有」是可见变化。
- i18n：`inbox-row__kind` 用 `nav.inbox.tabReviews/tabClarify`，抽屉用 `inboxKindLabelKey()` 且多出 fusion/memory/wg kind——合并子元素时两套 key 语义不同，不能顺手统一。
- 属跨组件重构，超出既有 issue，须先落 RFC 三件套。

**【优先级】** 高（同一批数据两种长相是明确视觉 bug；测试锁密，须 append 策略 + RFC）。

---

### 5. 表单/控件下方行内红色错误文字，每组件各写一条

**【现状证据】**
- `styles.css:3763`、`3967`、`4372`、`4384`、`5012`（字段级错误，字号 11/12/13px、`margin-top` 0/2/4/6px 混用）
- `styles.css:3876` `.form-actions__error`（13px）、`styles.css:783`（`.account-form__error` 12px）
- 成功文字分裂：`styles.css:778` `.account-form__ok`（`var(--success,#2c8a2c)` 绿）、`styles.css:3881` `.form-actions__ok`（`color-mix(var(--accent) 70%, #000)` 蓝）
- 消费点：`ChipsInput.tsx:156`、`JsonField.tsx:87`、`KindSelect.tsx:159`、`SkillFileTree.tsx:186`、`Form.tsx:64`
- 既有：`.form-field__error`（`Form.tsx <Field>` 内部，只有走 `<Field>` 的能拿到）

**【已产生的不一致】** 同一 PAT 创建对话框内三行红字对不齐不同大（Field 错误 12px+2px、ChipsInput 12px+4px、表单底部 13px）；「已保存」提示在 account 与 form-actions 两页一绿一蓝（本类唯一明确视觉 bug）。

**【建议】** 扩展既有 `Form.tsx` 导出 `<FieldError>`，供非 `<Field>` 场景复用；新增 `.field-error` 统一规则。

```ts
// 扩展 components/Form.tsx：导出 FieldError
export function FieldError(props: { id?: string; role?: string; children: ReactNode }): JSX.Element;
// .field-error { font-size: var(--font-sm); margin-top: var(--space-1);
//                line-height: 1.4; color: var(--danger-fg); }
```

字段级 5 处改用 `<FieldError>`，`margin-top` 统一到 4px（form-field 从 2px、kind-select 从 0 变 4px 是有意对齐，PR 说明）。**保留旧 BEM 类名并存**（`className="field-error form-field__error"`）或同步改测试选择器，二择一，不能直接删。表单级：`.form-actions__error`(13px) 与 `.account-form__error`(12px) 合并；`.account-form__ok`/`.form-actions__ok` 统一 `color:var(--success-fg)`，去掉蓝色 `color-mix`——此项优先级最高。排除 `.language-switch__error`/`.users-row__error`（单点紧凑排版有意为之）。

**【迁移风险】**
- 源码锁：`tests/form-invalid-no-banner.test.tsx:149/151/172/190/192/209/229` 用 `querySelector('.form-field__error'/'.form-actions__error')`；`agents-split-page.test.tsx:565`、`agent-port-dialog.test.tsx:261/316` 用 `.kind-select__error`；`plugins-page-wiring.test.ts:97/104` 做「源码里不得出现 form-actions__error」**反向断言**（新公共 class 不能塞进 plugins 页 shell）。全删改引用会红 3 个 vitest 文件——必须保留旧 BEM 并存或同步改测试。
- `role="alert"` 是行为变更：给原本静默的 7 处加 alert，会让 16 个用 `findByRole('alert')` 的文件出现多节点匹配（ModelSelect/AgentForm/MemoryFormFields/RepoSourceList/tasks.new…），需逐文件跑 vitest、必要时改 `getAllByRole`。
- data-testid 必须透传：`wg-config-error`/`workgroup-panel-error`/`wizard-collab-load-error`/`wizard-submit-error` 挂在 `form-actions__error` 的 span 上。
- 视觉：11/12/13px 拉平到 12px 会真实改变 /users 表格行内错误与 language-switch 顶栏（可能撑高 header），需 minimal repro 双主题截图。
- 前端跑 vitest 非 `bun test`；`styles.css`/`settings.tsx`/`i18n/*.ts` 有他人未提改动，精确 pathspec 提交。

**【优先级】** 高（一绿一蓝的成功提示是确定的视觉 bug，可先独立修；字段级收敛价值高但锁面需并存策略）。

---

### 6. 主题变量覆盖块被逐字复制多份

**【现状证据】**
- `styles.css:110` 与 `145`：根 token 表（30+ 行变量）逐字重复两处
- `styles.css:9017-9026`（`.agent-import`）与 `9374-9391`（`.skill-import`）：把 `--success:#1b6d34 / --warn:#844700 / --info:#1d5d9f` + 暗色 `#66d17a/#ffc25c/#8eb8ff` 各抄一遍、再抄一遍 `@media` 版，共 4 份同值定义
- `styles.css:11036/11051` 等 `:root:not([data-theme])` 兜底块

**【已产生的不一致】** 改一个色号要同步 8 处。且 `#66d17a/#ffc25c/#8eb8ff` 与根表 `--success-fg/--warn-fg/--info-fg` 值**恰好相同**——这两个组件级覆盖其实已冗余（当初为 11px chip 提对比度而加，现根 token 已升级到同值），是纯 no-op。

**【建议】** 无组件，纯 CSS 清理 + ratchet 断言。

```ts
// (1) bootstrap-script（<head> 内联无条件写 data-theme），
//     使每条覆盖只留 :root[data-theme='dark'] X 一份，@media 镜像整体消失
// (2) 直接删除 .agent-import(9017-9021,9022-9026,9036-9040) 与
//     .skill-import(9374-9378,9380-9384,9387-9391) 六个 no-op 块及其注释
//     —— 不要引入同值的 --success-fg-strong 别名（只会把 4 份重复变 4 份间接引用）
// (3) 结构断言（加进 tests/theme-css-ratchet.test.ts，勿新开文件）：
//     解析 CSS，selector 不属于 :root / :root[data-theme=…] / :root:not([data-theme])
//     的规则体内，禁止出现 --(success|warn|info|danger|accent)\s*:\s*#hex
```

**【迁移风险】**
- `tests/theme-css-ratchet.test.ts` 第一条断言 `styles.css` 与 `prose.css` **各至少保留一个** `@media (prefers-color-scheme: dark)` 块（`expect(bodies.length).toBeGreaterThan(0)`）且块内顶层选择器以 `:root:not([data-theme])` 开头——本条只删两个组件的镜像、根表 media 仍在，保持绿；但若 (1) 的 bootstrap 方案把全部 @media 兜底删掉会转红，须同步改断言意图（不是删）。同文件另有「无未定义 token 引用」断言，若按错误提案新增 `--*-fg-strong` 只在部分分支定义会被抓红。
- 顺序型断言：`tests/skill-import-responsive.test.ts:55-56`、`tests/ux-source-ratchets.test.ts:212` 依赖 `.skill-import` 相关选择器相对位置，删 token 块时勿挪动这些选择器。
- 无自动化视觉覆盖 agent/skill import 弹窗（`settings.png` 只截 runtime tab），需手工在明暗两套主题各看一眼 11px chip 与 `.status-chip--success/--warn/--info` 一致。
- 无 i18n/xyflow 牵连；`styles.css` `M` 状态，精确 pathspec，另有未追踪 `ShaRange.tsx` 勿误加。

**【优先级】** 高（改一处漏八处的维护陷阱 + 已确认 no-op 死代码；(2) 可独立低风险落地，(1) 需 bootstrap 先行）。

---

### 7. 「小号大写字距标签」（eyebrow）在 16+ 处各调一套参数

**【现状证据】** `styles.css` 中同模式共 16+ 独立选择器：`:441 .user-menu__sub`（10px/—/0.5px）、`:754 .account-defs__row dt`（12px/—/0.5px）、`:805 .account-table th`（11px/500/0.5px）、`:954 .oidc-form__group-title`（12px/600/0.6px）、`:1233 .nav-group__header`（10px/700/0.1em）、`:3270 .data-table th`（12px/500/0.04em）、`:4272 .capability-card__ports-label`、`:4411 .md-editor__label`、`:4737 .page-section-nav__group-heading`、`:4945 .file-tree__header`、`:5198 .inspector__kind`（11px/—/0.05em）、`:6657 .inspector-section > h3|summary`（12px/700/0.04em）、`:7642 .task-outputs > h2`（14px）、`:8096 .reviews-version-panel__header`、`:10772 .session-attempts__label`、`:11281 .inventory-section__subtitle`。全文件此模式共约 36 处。

**【已产生的不一致】** 字号 10/11/12/14px 四档、字距 `0.04em/0.05em/0.06em/0.1em/0.5px/0.6px` 六种（px 与 em 混用导致字号变化时字距行为不同）、字重 500/600/700 三档。左侧 sidebar 分组标题（0.1em/700）与右侧 inspector kind（0.05em/常规）并排明显不是一个体系。

**【建议】** CSS 分组选择器优先、零 markup churn（元素选择器 `dt`/`th`/`> h3` 不改挂 class）。

```ts
// styles.css token 区（紧邻 --font-xs/--font-sm）新增：
// --eyebrow-tracking: 0.05em;   （--font-xs=11px / --font-sm=12px 为唯一允许字号）
// 新增分组规则：
// .eyebrow, .account-defs__row dt, .account-table th, .data-table th,
// .oidc-form__group-title, .nav-group__header, .capability-card__ports-label,
// .md-editor__label, .page-section-nav__group-heading, .file-tree__header,
// .inspector__kind, .inspector-section > h3, .inspector-section > summary,
// .task-outputs > h2, .reviews-version-panel__header, .session-attempts__label,
// .inventory-section__subtitle {
//   font-size: var(--font-xs); font-weight: 600;
//   letter-spacing: var(--eyebrow-tracking); text-transform: uppercase;
//   color: var(--muted);
// }
// 各原规则只删这四五条声明，保留布局声明（ellipsis/flex/padding/background/margin）
// 变体：.eyebrow--strong(700 + var(--text)，给 inspector-section h3|summary)
//       .eyebrow--nav(sidebar 分组，字距统一到 --eyebrow-tracking，不留 0.1em/0.5px)
// 新写的 TSX 才用 .eyebrow class（属新建工具类）
```

`.task-outputs > h2` 现为 14px，收敛到 token 属真实视觉变更，PR 点名。分两步 PR：PR-1 只提取+统一值不动 TSX，PR-2 新 UI 才用 `.eyebrow`。

**【迁移风险】**
- Playwright 视觉基线必红：`.nav-group__header`（`components/shell/NavGroup.tsx`，出现在每张全页截图）、`.data-table th`（tasks/agents/workflows/repos/users/reviews/scheduled 基线）、`.inspector__kind` + `.inspector-section > h3`（workflow-editor-*-inspector 基线）——`e2e/visual-regression.spec.ts-snapshots` 下 62 张 darwin+linux×light/dark×mobile 基线绝大多数转红，darwin 基线只能本机重生成，须显式 `--update-snapshots` + 人工目检，不能当 flaky。
- 元素选择器不可无脑改 class：`dt`/`th`/`> h3|summary` 由表格与 `InspectorSection` 渲染，改挂 class 会波及 `EdgeInspector.tsx`/`InspectorSection.tsx`/`WrapperGitLoopEdit.tsx`/`ReviewEdit.tsx`——故走分组选择器。
- 删声明易误删同块布局声明（`:441` ellipsis、`:1233` flex/padding、`:805` background、`:11281` margin、`:4272` flex/min-width），整块替换会丢布局。
- 若把某选择器并进多选择器组，注意 `task-workflow-cell-overflow`/`task-questions-overflow`/`clarify-title-overflow` 三测试的 `ruleBody("<selector> {")` 字面量定位法——合并前 grep 全部 `ruleBody(` 选择器清单确认无交集。
- `text-transform:uppercase` 对中文文案是空操作，中文界面只有字距/字号/颜色生效——评估收益要意识到。
- PR 需自带一条「`text-transform:uppercase` 独立声明数 ≤ N」的源码兜底断言防再散开。

**【优先级】** 中（覆盖面最广、但纯样式收益偏软 + 视觉基线爆炸半径最大，建议 PR-1 值统一先行）。

---

### 8. NoticeBanner 之外的 banner/callout/success-error 提示各写一套

多路审计（2 处独立提案）：既有 `NoticeBanner`（tone info/success/warning/error × size + 图标 + live-region + dismiss，`ErrorBanner` 已在其上封装）之外，还有 4-5 套手写提示框。

**【现状证据】**
- `styles.css:830` `.account-callout` / `:840 --success` / `:846 __code`（radius 8px，`var(--success,#2c8a2c)` 内联 hex 兜底；`routes/account.tsx:546` PAT 明文，无 role）
- `styles.css:10740` `.repo-source-list__banner`（radius 6px，`var(--danger,#c0392b)` 兜底；`components/launch/RepoSourceList.tsx:94` role=alert，testid `repo-source-multi-banner`）
- `styles.css:13190` `.structure__banner`（radius 6px，纯 token；`StructuralDiffView.tsx:135/140` role=status）
- `styles.css:992` `.oidc-form__test-result--ok`（与 `.account-callout--success` 逐字节相同背景/边框；`settings.tsx:1889`）
- `styles.css:778` `.account-form__ok`（第三种，纯文字无框；另有 `account.tsx:537` 未记录调用点）
- 既有：`components/NoticeBanner.tsx`

**【已产生的不一致】** 圆角 8px/6px/自成一套；字号 13px 硬编码 ×2 vs `var(--font-xs)`；同一「成功/危险」语义三种绿/红写法（`color-mix` 现算 vs 两处内联 hex）；手写版全无图标与 dismiss，account 成功提示甚至无 `role=status`，屏读用户拿不到「密码已修改/连接测试通过」反馈。

**【建议】** 三~五处改调 `<NoticeBanner tone size="compact">`，删除四~五组手写规则与死 hex 兜底（`#2c8a2c/#c0392b/#2a7a2a`——`--success/--danger/--info` 全局已定义）。

```ts
// 扩展既有 components/NoticeBanner.tsx（唯一未验证点：确认其 role 输出）
// 若 NoticeBanner 未按 tone 区分 role=alert(error) / role=status(其余)，
// 先给它补可选 role/aria 通道，勿在迁移中把 alert 静默降级为 status
<NoticeBanner
  tone="success | error | warning"
  size="compact"
  testid="repo-source-multi-banner | new-pat-secret | …"  // 原样透传，保住锚点
  title={…}                                                 // account 的 strong → title
  action={…}                                                // PAT 的 copy 按钮 → action 槽
>
  {/* oidc issuer/detail 的 <code>、PAT code 放 children */}
</NoticeBanner>
```

`.account-callout__code` 等宽块另抽 `.inline-code` 通用 class。account 成功底色会从 `--success` 12% 收敛到 NoticeBanner `--success-bg` 10%（预期统一）。

**【迁移风险】**
- e2e 硬锁：`e2e/multi-repo-launch.spec.ts:292` 断言 `getByTestId('repo-source-multi-banner')` 可见且文本匹配 `/wrapper-git/i`——用 NoticeBanner testid prop 保锚点。
- 单测锁：`tests/account-query-continuity.test.tsx:161` `findByTestId('new-pat-secret')` 断言文本含 token——testid 必须挂到 NoticeBanner 根 div。无 class 名/✓✗ 文本锁。
- a11y 语义不可丢：`RepoSourceList` 现 role=alert、`StructuralDiffView` 现 role=status、account 现无 role——迁前须验证/扩展 NoticeBanner role 通道（本类唯一未核实点）。
- PAT 明文框现为横向单行（strong+code+copy 同排），NoticeBanner 为纵向 title/body——迁后视觉由单行变多行，需对齐自查（非阻断）。
- `.account-form__error` 有第二调用点 `account.tsx:537`；`.account-form__*` 是内联文字模式，若一并迁移会把按钮行内联状态变成大盒子（视觉回归）——本节先只收编盒式 callout，内联文字并入第 5 节 `field-error`。
- OIDC 块原有 ✓/✗ 字形迁后与 tone 图标语义重复，需删。无 i18n key 迁移（`patShownOnce/testOk/structDegraded*` 原样复用）；不涉 xyflow。
- NoticeBanner 恒有 icon 且存在 `ManagedLiveRegion` provider 时把 role 改走 live-region 播报——属行为变化，需 a11y 复核。

**【优先级】** 中（有明确 a11y 缺陷 + 死 hex；受「补 NoticeBanner role 通道」前置约束）。

---

### 9. 两列字段栅格三套等价 class（form-grid）

**【现状证据】**
- 既有 canonical `.form-grid.form-grid--cols-2`（8 处使用：`RuntimeList.tsx:481/536`、`launch/GitPicker.tsx:124`、`settings.tsx:522/658/682/739/1113`）
- `styles.css:2774` `.form-grid--two`（display:grid，gap 8px；`ReviewEdit.tsx:131`、`WrapperGitLoopEdit.tsx:165`）
- `styles.css:968-982` `.oidc-form__row` / `--cols-2`（gap 12px + 自写一个 `@media max-width:720px`；`settings.tsx:1731/1789`）
- 统一塌陷块 `styles.css:17159`（`@media max-width:720px`）

**【已产生的不一致】** gap 12/16px、8px、12px 三套；塌陷规则重复在两处 `@media`（集中块 + oidc 本地块，值都是 720px），任一次断点调整只会改到其一。**级联坑**：`.form-grid--two`（`:2774` display:grid）定义早于 `.form-grid`（`:3719` display:flex）、同特异性，故 `ReviewEdit`/`WrapperGitLoopEdit` **当前实际渲染为单列 flex 而非两列**——收敛到 cols-2 会翻成真两列（可见布局变化）。

**【建议】** 删除 `.form-grid--two` 与 `.oidc-form__row(--cols-2)` 两套冗余命名空间，统一到 canonical `.form-grid--cols-N`；gap 提成变量，紧凑场景用修饰符而非另起命名空间。

```ts
// 扩展既有 .form-grid 体系（无新组件，或加薄封装 <FormGrid cols={2}>）
// --form-grid-gap-x: var(--space-4); --form-grid-gap-y: var(--space-3);
// 注意 gap 简写是 row-then-column，别把 x/y 映射写反
// 紧凑 8px 场景 → .form-grid--tight（不新起命名空间）
// 迁移 oidc 两处后删 styles.css:977-981 本地 @media
// 保留 .page--editor .form-grid 的紧凑覆盖（styles.css:5116/5126/5130-5138）
```

**【迁移风险】**
- 级联翻转：`ReviewEdit.tsx:131`/`WrapperGitLoopEdit.tsx:165` 从「事实单列」变真两列，须目视验证画布右抽屉 inspector。
- 断点分叉：oidc 自有 720px `@media` → 统一即改折叠行为，OIDC 子标签需视觉核对（`settings.png` 只截 runtime tab，此子标签变更不需刷基线，但仍本地截图核对 gap 从 12px→12/16px、8px→12/16px 的位移是否可接受）。
- 编辑器后代覆盖 `.page--editor .form-grid`（gap 8px + field/label/input 尺寸）与画布抽屉耦合，收敛后必须保留紧凑覆盖。
- 无测试源码锁（grep `form-grid`/`--two`/`--cols`/`oidc-form__row` 对 `.test.*` 零命中，class 改名安全）；无 i18n/xyflow 约束。JSX wrapper 若强推会给 30+ 处纯竖排 `.form-grid` 徒增包装，列为可选。前端跑 vitest。

**【优先级】** 中（含一处「事实单列」级联 bug，收敛顺带修正；面小、无锁）。

---

### 10. 「ul 去样式 + 纵向 flex + gap」样板在 25+ 命名空间逐字重复

**【现状证据】** `styles.css` 中约 25+ 同构块，gap 值七零八落：`:12011`、`:12095`、`:12310`、`:12415`、`:12693`、`:13119`、`:14169`、`:15141`、`:15381` 等（`.injected-memories-card__list`=`var(--space-1)`、`.workgroup-room__members`=6px、`.file-tree__list`=1px、`.upload-picker__list`=2px、`.structure__walkthrough-list`=2px…）；既有语义不同的 `.stack--sm/md/lg`（`styles.css:11651`，margin-top 相邻兄弟机制，12 处 TSX 在用）。

**【已产生的不一致】** gap 出现 `1px/2px/3px/4px/6px/8px/16px` + `var(--space-1/2/3)` 八种，裸 px 与 token 不对齐（6px 不等于任何 `--space-*`）；同页两个列表（`.injected-memories-card__list`=`var(--space-1)` vs `.workgroup-room__members`=6px）行距肉眼可辨不一致。

**【建议】** 抽工具类，**改名避冲突**——不得叫 `.stack`（已被 `.stack--sm/md/lg` 占用不同语义）。

```ts
// 无组件；新增 CSS 工具类（命名避开 .stack）：
// .vlist            list-style:none; margin:0; padding:0; display:flex; flex-direction:column
// .vlist--gap-1/-2/-3   走 var(--space-1/2/3)
// 密排例外（.file-tree__list=1px 等「近乎贴合」）：先加 --space-0: 2px 一档，
//   或对这几处保留裸值 + 注释说明刻意密排（归一到 4px 会肉眼变松）
// 工具类与 .xxx__list 特异度同为 (0,1,0) → 工具类必须写在业务规则之前，否则静默改现有 margin/gap
```

分批：先落工具类 + 迁移已用 `var(--space-*)` 的那批（零视觉变更），裸 px 归一单独一批 + Playwright 基线复核。`.workgroup-room__config-members`（`margin:8px 0 0`）、`.reviews-version-list`（无 gap）迁后要保留自身 margin/gap 覆盖。

**【迁移风险】**
- 命名撞车（最高）：`.stack--sm/md/lg`（margin 机制）与提案 gap 机制同前缀不同语义，直接落会长期误用——故用 `.vlist`。
- 特异度平局：迁移时若把工具类写在文件尾部会静默改变现有 margin/gap。
- 视觉回归：1/2/3px 三档归一到 4px 是可见变化（文件树、上传列表、walkthrough 最密）；`settings.png` 只截 runtime 默认页，恰覆盖 `.runtime-list`，改它需刷基线。
- class 名被 JS 依赖：`RuntimeList.tsx:285-287` 用 `closest('.runtime-list__row')`+`querySelector('.runtime-list__name')` 键盘导航；`TaskFeedbackList.tsx:199` 挂 testid——只能加类，不能改/删。
- 仓库无 stylelint，「禁止新增裸 px gap」纯靠自觉，须配守卫测试。三个读 styles.css 的 overflow 测试锁的是无关选择器，但搬声明出原选择器前须 grep 这类锁。无 i18n/xyflow 约束。

**【优先级】** 中（覆盖面大但收益软 + 密排例外需逐处判断，建议只落工具类 + 迁移已 token 化的那批）。

---

### 11. 「左侧列表栏 + 右侧详情」两栏浏览器 3 套独立实现

**【现状证据】**
- `styles.css:7647/7684`（`.task-outputs-panel`，注释 `:7625` 自称 mirror RFC-065 worktree-files tab；`components/TaskOutputPanel.tsx:130`）
- `styles.css:8885/8951`（`.review-multidoc__body`）
- `styles.css:10020/10147`（`.worktree-diff`；`components/WorktreeFilesPanel.tsx:104`）
- `styles.css:15854/15959`（`.split-card` 选中态）；`components/split/ResourceSplitPage.tsx:366`
- 既有：`components/DetailLayout.tsx`（RFC-035，`asideWidth 'sm'|'md'|'lg'` + `asidePosition`）

**【已产生的不一致】** 左栏宽度 `minmax(220px,320px)` / 固定 240px / `clamp(220px,24%,280px)` 三种；栏间距 `--space-3`/16px/8px；选中态强调三样（accent 18% 纯底 / accent 12%+3px inset 左轨 / accent 14%+描边+文字）；选中态 DOM 契约分裂为 `.is-selected` class / `--active` 修饰符 / `aria-selected` 属性，测试选择器无法统一。

**【建议】** 分两层：栅格壳复用/最小扩展既有 `DetailLayout`；真正缺失的是「可选 rail-item」原语（renderItem 槽 + 统一选中态）。

```ts
// 扩展既有 components/DetailLayout.tsx（栏宽档位统一，必要时向后兼容加一档）
// 新增共享 rail-item 原语：
interface SelectableRailProps<Item> {
  items: Item[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  renderItem: (item: Item) => ReactNode;   // worktree 的 per-repo sticky 标题/目录分组/viewed 复选框经此保留
  // 选中态 DOM 契约统一用 aria-selected（可 getByRole(..,{selected:true})）
  // 视觉统一 accent 12% + inset 3px 左轨（取 review-multidoc 现值，最克制）
}
// .split-card.is-selected 的 per-kind --split-accent 彩色轨能力必须保留
```

worktree-diff 的 rail 富结构（sticky 标题、`.worktree-diff__tree-dir`、viewed 复选框）经 renderItem 保留，不强行拍平。

**【迁移风险】**
- 源码锁密集：`resource-split-page.test.tsx`（45 命中）、`task-output-panel-source-guards.test.ts`（源码文本锁 role=tablist/tab/tabpanel、禁 listbox/option、锁 `.task-outputs-panel(__pre)` 存在 + 旧 grid 规则不得复现）、`focus-ring-inset.test.ts`（9 命中，`:where(...).task-outputs-panel__option...:focus-visible` 点名该 class）、`worktree-files-panel.test.tsx`、`workgroup-studio-panel.test.tsx`（11）、`agents-split-page.test.tsx`（26）——改 class 名/DOM 结构会红一片。
- 语义风险：若把 tree/nav 强改为 tab 会破坏 `aria-expanded` 导航语义并撞 role 守卫——保持 tab 归 tab、tree 归 tree。
- 选中态 18%/14% 纯底改 12%+inset 左轨会移动像素，需刷 task-detail/worktree 相关基线；选中态断言契约要迁到统一 `aria-selected`。
- `DetailLayout` `asideWidth` 档位需确认覆盖三处目标宽度，否则向后兼容加档而非 fork。无 i18n key 迁移；三处均非画布节点。

**【优先级】** 中（作者本意就是复用却只能手抄，收敛价值明确；但锁面极密、选中态语义分裂需统一到 aria-selected，须 RFC）。

---

### 12. 浮层 surface（面板底+边框+圆角+阴影+z-index）6 处各写一套

**【现状证据】**
- `styles.css:449` `.user-menu__dropdown`（radius 8px / `--shadow-lg` / z 50）
- `styles.css:580` `.select__listbox`（radius 8px / `--shadow-lg` / z **1200**，带「高于 dialog(1000)」注释）
- `styles.css:6367` `.context-menu`（radius 6px / `0 4px 12px 0.15` / z 100）
- `styles.css:8834` `.comment-popover`（radius 12px / 双层 shadow / z 50）
- `styles.css:8989` `.review-cross-heading-hint`（radius 8px / `0 4px 12px 0.12` / z 60）
- `styles.css:15243` `.workgroup-room__mentions`（radius 8px / `0 8px 24px rgb(0 0 0/0.18)` / z **20**）
- 既有 `--shadow-sm/md/lg`（`styles.css:58-60`，但仅 2 个浮层引用）

**【已产生的不一致】** 圆角 8px×5/12px×1；阴影六种写法（含同值不同语法 `rgba(...)` vs `rgb(0 0 0/…)`、双层组合）；z-index `20/50/50/60/100/1200` 全魔数，只有 `.select__listbox` 写了「为什么 1200」。`.workgroup-room__mentions` 的 z:20 明显低于 dialog(1000)，在弹窗内打开会被压住（推测性 bug）。暗色下纯黑 rgba 阴影是给亮底调的，六浮层集体失去层次感。

**【建议】** 抽 `.surface--floating` 工具类，六处叠加、仅留各自定位/尺寸；**层级 token 与浮层抽取拆两个 PR**。

```ts
// PR-1（低风险 4 属性收敛，无组件）：
// .surface--floating {
//   background: var(--panel); border: 1px solid var(--border);
//   border-radius: var(--radius-lg); box-shadow: var(--shadow-lg);
// }
// PR-2（z-index token 化，blast radius 大，单独立）：
// --z-popover: 1200;  // select__listbox「穿透 dialog」必须映射到此 tier，勿压平成 --z-dropdown:50
// --z-menu / --z-tooltip …  逐站映射，.workgroup-room__mentions z:20 是 load-bearing，先验证再改
// 配层级回归断言
```

**【迁移风险】**
- `.select__listbox` z:1200 带 load-bearing 注释「让弹窗内 Select 弹出」，token 化若压平成 50 会破坏该行为——必须映射到 `--z-popover:1200`；`user-picker__results` 注释自称镜像它，改值需保持二者一致。
- z-index 一刀切会误伤 xyflow 画布 node handle 层叠（`styles.css:7465` 注释：named handles 靠 z-index 决定 fan-in drop 顺序）与评论/画布内部局部 stacking（z 1~12、20）——这些是组件内顺序不是全局层级。
- 统一 box-shadow 覆盖 `.comment-popover` 双层与 `.review-cross-heading-hint` 更紧阴影、圆角 6/8/12→`--radius-lg`(10px) 均可见变更，需 minimal repro 双主题核验；`--shadow-*` 改主题感知会影响全部 shadow 引用点（grep 远超 6 处），必须隔离出本次范围。
- `.dialog__panel` 滚动布局被 `tests/dialog-scroll-layout.test.tsx` 锁，叠 surface 类时勿动 overflow/padding。无 class 名源码锁、无 i18n key 迁移。
- 需补「六处一律叠 `.surface--floating`」源码文本断言。

**【优先级】** 中（PR-1 明确低风险高收益；z-index/暗色阴影触及全局，须严格隔离 + 逐站映射）。

---

### 13. 弹窗宽度两套机制 + 抽屉形态四份近似 CSS

**【现状证据】**
- 既有 `Dialog` 的 `size='sm'|'md'|'lg'`（`styles.css:11441-11451`）
- `panelClassName` 覆写宽度：`styles.css:11604`（`.batch-import-dialog` width 90vw）、`styles.css:10844`（`.memory-compare-dialog` 960 被 lg 的 760 压成死代码，实渲 760）
- 抽屉形态四份近似：`styles.css:1441`（`.inbox-dialog`，实为贴侧栏浮动 sheet：top:50% + translateY + height:auto + 圆角）、`styles.css:5270`（`.mobile-nav-dialog`）、`styles.css:17569`（`.workflow-editor-surface-dialog`）、`styles.css:6565`（`.workflow-validation-dialog` 矮 max-height 边到边）
- 消费点：`BatchImportDialog.tsx:314/315`、`MemoryConflictCompareDialog.tsx:50/52`、`shell/InboxDrawer.tsx:137`、`shell/MobileNavDialog.tsx:40`、`workflows.edit.tsx:1086/1105`、`workflow-editor/ValidationPanel.tsx:156`

**【已产生的不一致】** 宽度同一数值(760px) 由 size 与 panelClassName 各写一遍；「抽屉形态」（fixed + 全高 + 去圆角 + safe-area padding）在 4 份近似 CSS 中边框/圆角/safe-area 处理已互不相同。

**【建议】** 扩展既有 `Dialog`：加 `variant` 枚举收敛壳体形态 + `size='xl'`，删 panelClassName 的宽度覆写；加 CSS 层文本锁禁止 panelClassName 承载 `width|max-height`。

```ts
// 扩展 components/Dialog.tsx
interface DialogProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';   // 新增 xl=960
  variant?:
    | 'centered'                       // 默认
    | 'drawer-left'                    // mobile-nav（满高抽屉，可无损合并）
    | 'drawer-right'                   // workflow-editor-surface（满高抽屉，可无损合并）
    | 'anchored-sheet'                 // inbox：贴侧栏浮动 sheet，非满高，单列
    | 'fullscreen-mobile';            // workflow-validation：矮边到边
  // safe-area/border-radius 收进 .dialog__panel--drawer-{left,right}
}
```

真正可无损合并的仅 mobile-nav + workflow-editor-surface 两份满高抽屉；inbox（浮动 sheet）与 workflow-validation（矮面板）需单列 variant 或保留 panelClassName 只做定位。

**【迁移风险】**
- 行为变更：`.memory-compare-dialog` 的 960 当前被 lg 的 760 压成死代码、线上实渲 760——改 `size='xl'(960)` 会把该弹窗从 760 变宽到 960，是可见视觉变更，需产品确认；`.batch-import-dialog` 用 90vw 而非 100%，切纯 lg 会略改窄视口行为。
- 形态归并：inbox 与 workflow-validation 都不是满高抽屉，不能被 drawer-left/right 简单吸收。
- 源码锁：多处注释标「Locked by tests/dialog-scroll-layout.test.tsx」（inbox 段引用 RFC-195），落锁前先盘这些测试；`.dialog--<size> .dialog__panel.<x>` / `:where()` 深选择器改 header/body/footer（如 inbox `1451-1464` 的 border-bottom、footer stretch）须一并迁移否则丢边框；`.dialog__overlay:has(.mobile-nav-dialog){align-items:stretch}` 抽屉化必须保留否则回居中。
- 无 class 名/testid 锁（grep 零命中），无 i18n/xyflow 约束；每个改动 dialog 须 light+dark + 移动断点(≤720)截图（safe-area 在桌面浏览器求值为 0，需真移动视口）。属非平凡样式重构 + 可见宽度变更 + 新公共 prop，走 RFC。

**【优先级】** 中（含一处死代码宽度 + 抽屉形态漂移；但归档需产品确认宽度变更，须 RFC）。

---

### 14. 「一排行动按钮」被复制成 20+ 个 `__actions` class

**【现状证据】** 全仓 20+ 同构规则、gap 各写各的：`styles.css:8735` `.comment-bubble__actions`(2px)、`:2930`/`:10855`/`:5040`/`:11104`/`:14402`(6px 多处)、`:2536` `.page__actions`(8px)/`:10832`/`:7978`/`:8701`/`:14859`(8px 多处)、`:774`/`:10744`(12px)、`.memory-row__actions` 等（`var(--space-2)`）。既有 `.page__actions`（`styles.css:2536`，flex + gap 8px + justify-content flex-end）与 `.data-table__actions`（`:3349`，text-align+margin-left 机制）。消费点：`MemoryRow.tsx:99`、`MemoryApprovalQueue.tsx:217`、`BatchImportDialog.tsx:392`、`repos.tsx:161`（实为 `data-table__actions` 已复用）、`MemoryAllList.tsx:115`（实为 `page__actions` 已复用）。

**【已产生的不一致】** 同为「行尾操作按钮组」gap 2/6/8/12px + `var(--space-2/3)` 混用；/repos 表格行是 8px、批量导入弹窗行是 6px。

**【建议】** 分两步。第一步（安全高价值）：把 `__actions` 硬编码 px 统一成 `--space-*`，修真实不一致（repos-table 8px 与 batch-import-table 6px 对齐、comment-bubble 2px 离群归一）。第二步：新增中性工具类，作用域限定 in-row/in-card。

```ts
// 无必然组件；新增作用域受限的工具类（或薄封装 <ActionRow>）：
// .actions-row { display:flex; flex-wrap:wrap; align-items:center; gap:var(--space-2); }
// .actions-row--end / --inline
// 明确不接管：.page__actions（page-header 专用，带 page--editor/gallery 后代 + @media）
//            DetailHeaderActions（已单源化 save/del/acl 簇）
//            .data-table__actions（text-align+margin-left 机制，单列评估）
// 迁移时把伴生规则整组带走：data-table__actions>*+*、runtime-list__actions @media、
//   file-tree__actions/task-outputs-panel__actions 共享 @media 规则
```

**【迁移风险】**
- 响应式耦合：多条 `__actions` 在 `@media`（`styles.css:17090+/17326+/14417/9882`）有 override、键在 BEM 名上——无法删类，只能双类挂载，限制收益。
- `styles.css` 处于多人共享 `M`，一次性收敛 15+ 规则易与并行 session 冲突；候选原始行号整体错位约 150 行，须以类名定位。
- CSS 文本锁（`task-questions-overflow`/`task-workflow-cell-overflow`/`clarify-title-overflow`）锁的是 `__row/__col` overflow，不锁 `__actions` gap，无直接冲突；无 `__actions` class 的 DOM/testid 断言（data-testid 挂在按钮上）；不涉 i18n/xyflow。

**【优先级】** 中（第一步 gap token 化 + 对齐真实不一致是安全高价值；工具类因 BEM 响应式耦合收益受限，仅新代码用）。

---

### 15. 节点「点我跳转」提示行（review-nav / clarify-nav）JSX+CSS 各写一份

**【现状证据】**
- `styles.css:6880` `.canvas-node__review-nav` 与 `styles.css:6891` `.canvas-node__clarify-nav`（值完全相同、分两命名空间：`margin-top:4px; font-size:11px`）；pointer 光标规则分写 `styles.css:6877` 与 `6887-6890`
- `components/canvas/nodes/ReviewNode.tsx:76`、`ClarifyNode.tsx:86`、`CrossClarifyNode.tsx:89`

**【已产生的不一致】** 两条 CSS 值相同却分属两命名空间，改其一（如 clarify 字号改 12px）两类人机交互节点提示行立刻错位。

**【建议】** 抽 `<CanvasNodeNavHint>`，三处 JSX 各收敛成一行；CSS 走「共享同一声明块但保留两个原 class 名」以绕开源码锁。

```ts
// 新建 components/canvas/nodes/CanvasNodeNavHint.tsx
interface CanvasNodeNavHintProps {
  kind: 'review' | 'clarify';   // 决定挂 .canvas-node__review-nav / __clarify-nav
  nav: { … };                    // 现有 nav 数据
}
// CSS 方案A（推荐，零测试改动）：
// .canvas-node__review-nav, .canvas-node__clarify-nav { margin-top:4px; font-size:11px; }
// 保留字面量 11px/4px，勿引入 var(--fs-xs)（全仓无 --fs-*/--font-size-* token，纯 scope creep）
// 保留节点根 div 的 data-review-nav/data-clarify-nav（cursor 选择器依赖）
```

**【迁移风险】**
- 源码锁：`review-node-click-nav.test.tsx:137/145/153` 用 `querySelector('.canvas-node__review-nav')`；`clarify-node-click-nav.test.tsx:174/182/190` 用 `.canvas-node__clarify-nav`，且 `:312-313` 文本断言 CSS 里 `.canvas-node--clarify[data-clarify-nav]` / `.canvas-node--clarify-cross-agent[data-clarify-nav]`——故取方案A（共享声明块 + 保留两个原 class 名，零测试改动）；方案B 改名 `.canvas-node__nav-hint` 需同步 6 个选择器 + 源码文本锁。
- 原提案的 `var(--fs-xs)` 变量名不存在，照写会引入未定义变量致字号回退失效——保留字面值。
- 无 i18n key 迁移；hint 仅节点内普通子 div，无 xyflow 渲染约束；须保留根 div 的 `data-*-nav`。

**【优先级】** 中（字节级重复 + 明确「改一个错另一个」隐患；方案A 零测试改动、低风险，可直接落）。

---

### 16. 「粗体标题 + 灰色副说明」堆叠按钮卡片四套并行命名空间

**【现状证据】**
- `styles.css:5293` `.workflow-editor-action-list__item`（`var(--radius-md)` + `var(--font-sm)`；`workflows.edit.tsx:1128/1141`）
- `styles.css:5949` `.workflow-starter__card`（10px 圆角 + 12px + margin-top:5px；`WorkflowStarterDialog.tsx:318`）
- `styles.css:5818` `.editor-sidebar__item*`（被 `WorkflowNodePicker.tsx:287` **跨命名空间借用**——组件与 class 归属脱钩）
- `styles.css:15771` `.choice-card__body/__label/__desc`（既有原语；`components/ChoiceCards.tsx:106`）

**【已产生的不一致】** 同一编辑器里三种 hint 字号、两种圆角、三种 hover 反馈；`editor-sidebar` class 归 `WorkflowNodePicker` 消费，改 sidebar 样式会静默改掉 picker。

**【建议】** 抽「粗体标题 + 一行灰说明 + 可选 icon」纯展示文字栈为共享原语，分步。

```ts
// 第一步（低风险）：三处复用 ChoiceCards 既有 .choice-card__body/__label/__desc
//   （styles.css:15771，非候选写的 15624），或抽纯展示子组件：
interface OptionCardBodyProps {
  label: ReactNode;
  desc?: ReactNode;
  icon?: ReactNode;
  trailing?: ReactNode;   // node-picker 的 drag-grip / disabled-reason 附加行
}
// styles.css 删 .workflow-editor-action-list__item > span / .workflow-starter__card span
//   / .editor-sidebar__item-label|hint 三套字号规则，只留各自布局容器
//
// 第二步（可选）：扩展 ChoiceCards 加 as="action" 变体（onClick 立即触发、
//   无 role=radio/aria-checked），覆盖 action-list；starter 天然 radio 可整体迁移
//   （testidPrefix="workflow-starter" 保 workflow-starter-${id} 锚点）
// node-picker 因 drag-grip(draggable)+disabled-reason+aria-disabled 超出 radio 契约，
//   仅做第一步文字栈复用，不硬塞 ChoiceCards
```

**【迁移风险】**
- e2e 视觉基线：`e2e/visual-regression.spec.ts:734` 截图 workflow-node-picker-dialog、`workflow-editor.spec.ts` 驱动 picker/starter/actions-dialog——统一圆角/字号会移动像素，须重生成对应 e2e 基线（在 workspace typecheck 之外）。
- 语义硬约束：node-picker 用 `aria-disabled`（禁用项仍可搜/可聚焦）而非真 `disabled`（Tab 跳过）——语义不兼容，不能把 node-picker 折进 ChoiceCards。
- xyflow：node-picker 条目 draggable drag-grip 通过 `onDragStart` 写 `dataTransfer` 供画布建节点，须原样保留 grip + payload。
- Dialog 初始聚焦：starter 现用 `initialFocusRef=firstStarterRef`，迁移需给 ChoiceCards 加 `initialFocusRef` prop 或改 Dialog 目标。
- 锚点：`workflow-node-picker-item-*`/`workflow-starter-*`/`workflow-actions-dialog` testid + `.workflow-node-picker__drag-grip` 挂在按钮/容器上，只替换内层文字栈 span 即存活（`workflow-editor.spec.ts:286/403/799`、`focus-ring-clip.spec.ts:995`、`workflow-starter-dialog.test.tsx:93-95` 引用）。无 class 名源码锁、无 i18n key 迁移。

**【优先级】** 中（含「class 归属脱钩」误导性 bug；第一步文字栈复用低风险，第二步受 node-picker 语义/xyflow 约束不可全并）。

---

## 6. 硬编码设计 token（hardcoded-token）

# 硬编码 Token 审计 · 前端（hardcoded-token）

> 本章合并了多路审计对同一根因的重复命中（`foundBy` 已在小节末标注）。所有行号基于当前工作树快照；`styles.css` 是多人并发热点文件（当前 `git status` 已显示 `M styles.css`），实施时一律按内容匹配定位、按精确 pathspec 一次性 commit，勿 `git add -A`。前端测试跑在 **vitest**（不在根 `bun test` 范围内）。

---

### 1. 等宽字体栈绕过 `--font-mono`，写死 54+ 次、存在 3–4 个互不相同的变体

**【现状证据】**
- token 定义：`styles.css:4` — `--font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`
- 裸字面量重写（部分）：`styles.css:218 / 2170 / 3499 / 3576 / 3647 / 3656 / 3796 / 4971 / 5203 / 5368 / 5377 / 5699 / 5743 / 6780 / 7427 / 8016 / 9338 / 9472 / 9931 / 9981 / 10206 / 10281 / 11108 / 11130 / 11175 / 11201 / 11219 / 12947 / 13132 / 13159 / 13204 / 13220 / 13282 / 13302 / 13412 / 13435 / 13517 / 13756 / 13785 / 13814 / 14849`
- 带 fallback 的冗余形态 `var(--font-mono, …)`：`styles.css:848 / 1009 / 1112 / 1183 / 1206 / 1935 / 2463 / 4013 / 4245 / 4298 / 9142 / 9161 / 10624 / 13861`
- Consolas 变体：`styles.css:7699 / 7745 / 7764`；`'Liberation Mono'` 变体（唯一）：`styles.css:8129`

**【已产生的不一致】** 三个字面栈同时存在（有/无 Consolas、有/无 Liberation Mono），Linux 上不同面板的等宽文本落到不同字体，ID / 路径 / diff 的字宽对齐肉眼可辨；`var(--font-mono, monospace)` 一类 fallback 纯噪音（`:root` 必然存在，fallback 永不触发）。`components/prose/prose.css:279/297/320/329` 已是裸 `var(--font-mono)`——正例对照。

**【建议】** 纯 CSS 收敛，不涉组件 API。
- 先把跨平台候选补进 token 本身再替换，否则 `8129` 会从 Liberation Mono 掉回 generic monospace（Linux 真实回退）：
  ```css
  :root {
    --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
      'Liberation Mono', 'DejaVu Sans Mono', monospace;
  }
  ```
- 全部 53 处非 `:root` 字面量 + 冗余 fallback 形态一律替换为裸 `font-family: var(--font-mono)`。
- **扩展既有** `packages/frontend/tests/styles-tokens.test.ts`（已读取 styles.css 全文），新增计数断言（注意用「恰好 1 次」而非「不得出现」——`:root` 那行必须保留）：
  ```ts
  // 锁：等宽字体栈只允许在 --font-mono 定义处出现一次，禁止逐字重写 / fallback 形态
  const monoLines = css.split('\n').filter((l) => l.includes('ui-monospace'))
  expect(monoLines).toHaveLength(1)
  expect(monoLines[0].trimStart().startsWith('--font-mono:')).toBe(true)
  expect(css).not.toMatch(/var\(--font-mono,/)
  ```
- **不要**顺手改 `prose.css`（锁只针对 styles.css）；`prose.css:29` 另起 `:root` 重定义 `--font-mono` 是独立隐患，单开条目。

**【迁移风险】** 属真实视觉变更（非纯重构）：Windows 上 45 处从 generic monospace 变成 Consolas，需写进 commit message。Playwright 视觉基线（`e2e/visual-regression.spec.ts-snapshots/` darwin+linux 双份）含大量等宽文本，Linux runner 上涉 Liberation Mono 的元素字形会变，push 前跑 e2e 对比、红了再决定刷基线。macOS 本机 Menlo 恒命中、看不出差异，别以本机截图为准。

**【优先级】** medium（`foundBy: 2`）

---

### 2. 已定义 token 被配上死 fallback：`--muted` 一个变量 6 种兜底灰，`--success` 埋了第 4 种绿

**【现状证据】**
- `var(--muted, #hex)`（约 19 处，5 种灰 `#666/#888/#999/#9aa/#6b7280`）：`styles.css:2883 / 4254 / 4274 / 4303 / 4315 / 4322 / 4328 / 5234 / 6243 / 8842 / 10774 / 13038 / 13073 / 13139 / 13316 / 13319 / 13822 / 13844 / 13868`
- 非灰兜底（更误导）：`styles.css:6243 var(--muted, var(--text))`、`styles.css:8842 var(--muted, inherit)`
- `var(--success, #2c8a2c)`（5 处，`:root` 真值 `#1b6d34` ≠ 兜底）：`styles.css:780 / 841 / 842 / 993 / 994`
- 其它已定义 token 的 stale fallback：`var(--warn, #d28e0a)` @ `412/413/417`、`var(--warn, #b58900)` @ `14140/14141`、`var(--danger, #c0392b|#c44)` @ `4308 / 10284 / 10285 / 10291`、`var(--radius-md, 8px)` @ `14084`（真值 6px）、`var(--shadow-md/lg, …)` @ `458 / 591 / 14085`（与真值漂移）

**【已产生的不一致】** fallback 是死代码却记录了「作者心目中的多个值」；一旦 token 被重命名，这些点会分别退化到 5 种灰 / 4 种绿 / 8px 圆角，而非一起可见地坏掉。`14084` 的 `8px` 直接暴露作者以为 `--radius-md` 是 8。

**【建议】** 纯 CSS，无组件面。全部 `var(--已定义 token, <字面量>)` 删第二参数，改裸 `var(--x)`。**扩展** `styles-tokens.test.ts`，新增对偶断言（与 §3 的「未声明必须带 fallback」构成闭环，二者必须共享白名单常量）：
```ts
// 项目内自有 token 一律不带 fallback：缺失必须整体可见地坏掉，而非分别退化成 5 种灰
expect(css).not.toMatch(/var\(--(muted|success|danger|warn|info|font-mono|radius-md|shadow-(sm|md|lg)|space-\d),/)
```

**【迁移风险】** 视觉零变化（`:root` 无条件声明，fallback 不可达）。但涉及 34+ 处散点，`gallery-page.test.tsx:437` 用 `toContain('color: var(--muted)')` 精确匹配无 fallback 写法——本改动只会让更多规则满足它。`14085 / 458 / 591` 的 shadow fallback 可能在他人在飞的 hunk 里，改前确认并发范围。

**【优先级】** medium（`foundBy: 2`）

---

### 3. 未定义 token + 死 fallback：亮色主题下的暗色错位（真 bug）

**【现状证据】** 以下变量全仓 **零定义**，fallback 是唯一生效值：
- `--border-muted`：`styles.css:5226`（`#2a2a2a` 暗色边框硬写在浅色主题 → inspector 操作栏出现深色分隔线，与 `var(--border)` #e3e5ea 明显不同）
- `--amber-fg/-bg/-border`：`styles.css:8185 / 8186 / 8187`（`.readonly-banner` 永远浅色，暗色下白底黄框）
- `--panel-muted`：`styles.css:3009`
- `--hover`：`styles.css:14104`
- `--surface-1`：`styles.css:10611`（引用 2 处）
- `--diff-add-fg / --diff-del-fg`：`styles.css:13354 / 13357`（GitHub 暗色调，浅色主题对比度不足）

**【已产生的不一致】** 这几处「看似 token 化实则写死」的值不随主题走，`5226` 已是可见 bug。**注意豁免**：JS 内联注入的参数化 token —— `--review-sidebar-width`（`components/review/ReviewDocPane.tsx:531`）、`--clamped-text-lines`（`components/ClampedText.tsx:80`）、`--detail-layout-aside-w`（`.detail-layout--aside-sm/md/lg` @ `styles.css:11627`）—— 这些 fallback 是**正当默认值**，绝不能删，删了会侧栏塌陷 / clamp 失效。

**【建议】** 纯 CSS。**先补 `:root` 定义再删 fallback**（顺序反了会让属性失效），亮暗各一套：
```css
:root {
  --border-muted: color-mix(in srgb, var(--border) 55%, transparent);
  --panel-muted: color-mix(in srgb, var(--bg) 50%, var(--panel));
  --hover: rgba(127, 127, 127, 0.12); /* 明暗通用中性灰，直接照搬现有 fallback */
  --surface-1: /* 提升现有 fallback 值 */;
  --diff-add-fg: #1a7f37; --diff-del-fg: #cf222e;
}
:root[data-theme='dark'], @media (prefers-color-scheme: dark) { :root:not([data-theme]) {
  --diff-add-fg: #3fb950; --diff-del-fg: #f85149; /* 沿用现 GitHub 暗色 */
} }
```
`--amber-*`（`.readonly-banner`）建议改吃已有 `--warn` 体系而非新造第三条 amber 色轴，消费点改裸 `var(--warn-bg)` 等。**扩展** 既有 `theme-css-ratchet.test.ts`（其 `:75` 已有「引用未声明 token 必须带 fallback」）——加对偶断言并把参数化 token 放进显式白名单常量（仿 `RUNTIME_INJECTED_TOKENS`）。

**【迁移风险】** `.readonly-banner` / diff 由硬写 amber/绿转 token 是真实像素变化，按 `feedback_frontend_visual_verify_repro` 需 minimal repro + light/dark 双主题截图。`theme-css-ratchet.test.ts` 已有的「dark 块顶层选择器必须以 `:root:not([data-theme])` 开头」ratchet，补暗色值时容易踩。补定义 + 删 fallback 必须同一 commit。

**【优先级】** high（`foundBy: 3`）

---

### 4. 「无值」占位符 `—` 一半走 `t('common.emDash')` 一半硬编码

**【现状证据】** 硬编码 `'—'`（20 处）：`components/home/task-row.tsx:48`、`components/home/CapabilityGrid.tsx:89`、`components/inventory/SkillsTable.tsx:32`、`components/inventory/AgentsTable.tsx:38`、`components/inventory/McpsTable.tsx:35`、`routes/scheduled.$id.tsx:194`、`components/node-session/InjectedMemoriesCard.tsx:46`、`routes/repos.tsx:154`、`routes/scheduled.tsx:197`、`routes/account.tsx:718`、`components/ScheduleDialog.tsx:294`、`components/canvas/inspector/ReviewEdit.tsx:162 / 197`、`components/workgroup/WorkgroupRoom.tsx:688 / 1118 / 1205`、`components/agent-ports/AgentPortValidationSummary.tsx:53`、`components/skills/ImportZipPanel.tsx:255`、`lib/schedule-view.ts:29`、`routes/clarify.detail.tsx:740`、`routes/tasks.new.tsx:1565 / 1581 / 1741`
现有正确用法：`t('common.emDash')`（`i18n/zh-CN.ts:4401` / `en-US.ts:750`），已被 `RelativeTime.tsx:23` / `TaskSubjectLink.tsx:98` / `NodeDetailDrawer.tsx:341` 使用。

**【已产生的不一致】** 同一路由文件内部分叉：`routes/scheduled.tsx:197` 是 `<span className="data-table__muted">{t('common.emDash')}</span>`（灰），其详情页 `routes/scheduled.$id.tsx:194` 是裸 `'—'`（正文色）——列表页空值灰、详情页空值黑。

**【建议】** 分两层，不新建「总是灰化」的组件。
- **A（token 层，主干）**：全部 20 处换 `t('common.emDash')`；非组件上下文用 i18n 实例，照搬 `lib/distill-job-detail.ts:55` 先例：
  ```ts
  import i18n from '../i18n'
  export const emDash = () => i18n.t('common.emDash')   // lib/schedule-view.ts:29
  ```
  插值参数（`InjectedMemoriesCard:46`、`ImportZipPanel:255`、`AgentPortValidationSummary:53`）与 Select label（`ReviewEdit:162/197`）同样只换 token。
- **B（样式层，仅表格空值）**：沿用只改色的 `.data-table__muted`（`styles.css:3284`），**不要**用 `.muted`（`styles.css:2569` 会把字号压到 14px）。若抽组件仅限 `<TableEmptyCell />` 语义；`<dd>`/`<code>`/`<dt>` 详情场景继续用裸 token，`scheduled.$id.tsx:194` 是否算 bug 先确认设计意图。
- **C（源码锁）**：精确匹配「.tsx/.ts 中引号包裹的 em dash 字面量」，排除 `i18n/zh-CN.ts`、`i18n/en-US.ts` 与 `__tests__/*.test.*`；**绝不能**锁裸 em dash 字符（全仓 2300+ 行含 em dash，多为中文注释）。

**【迁移风险】** 至少 7 处位于非 JSX 字符串上下文（i18n 插值 / Select label / 纯函数返回），组件方案在这些点不可用。现有约 35 处 `t('common.emDash')` 里 31 处无 muted 包裹，「一律灰化」是行为变更需 UI 确认。`common.emDash` key 已存在，只增引用。工作树新增文件 `components/ShaRange.tsx:34` 也用 emDash（他人未追踪文件，勿主动 add）。

**【优先级】** medium（`foundBy: 2`）

---

### 5. 「警告 / 待处理 / review pending」语义散落 8 种琥珀色，全部绕开 `--warn-fg`

**【现状证据】** 至少 8 组不同橙：`#f5a623 / #b1660d / #d29922 / #d97706 / #b45309 / #d99100 / #bf8700/#d4a72c / #ea580c`。
- `#d97706` 一族（attention/awaiting）：`styles.css:6867 / 6868 / 6900 / 6901 / 6920 / 6921 / 6933 / 7309 / 7317 / 7318 / 10806 / 14703 / 14704 / 14708`
- 纯 warn 语义写死：`.diff__truncated` `3629-3631`、`.events-list__item--stderr` `5616` / `--rfc026-warning` `5629-5630`、`.status-badge--warn` `11382-11384`、`.session-capture-warning` `10981-10982`、`.homepage-section__count--warn` `1874 / 1970`
- `var(--warn)` 的两种不一致 fallback：`#d28e0a` @ `412-417`、`#b58900` @ `14140`
- 未定义的 `--amber-*`：`8185-8187`（见 §3）

**【已产生的不一致】** 同页面里 canvas 节点 awaiting 是 `#d97706`、右侧 `status-badge--warn` 是 `#d4a72c`、结构 diff 是 `#d99100`，三种橙并列。`--warn-fg`(#844700) 是 RFC-054 为过 WCAG AA 专门调暗的深棕，这些硬编码等于绕过无障碍修复。

**【建议】** 纯 CSS，范围收窄到「warn / 人工待处理」一族。
- 新增 **`--attention-fg/-bg/-border`**（亮暗各一套），承接比 `--warn-fg` 更亮的 review/clarify/awaiting_human 橙线，把 `#d97706` 与配套 `#b45309` 统一进去（修掉「color-mix 混 `var(--panel)` 但基色不随主题」的半吊子状态）：
  ```css
  :root { --attention-fg:#d97706; --attention-bg:color-mix(in srgb,#d97706 12%,var(--panel)); --attention-border:color-mix(in srgb,#d97706 40%,var(--border)); }
  :root[data-theme='dark'], @media (prefers-color-scheme:dark){:root:not([data-theme]){ --attention-fg:#f5a623; /* 亮一档 */ }}
  ```
- 纯 warn 语义直接吃 `var(--warn-fg)/--warn-bg/--warn-border`（`diff__truncated` / `events-list__item--stderr` / `status-badge--warn` / `session-capture-warning` / `homepage-section__count--warn`）。
- 删死 fallback（`412/413/417` 与 `14140/14141` 两套）。
- **显式排除本次范围（另立项）**：`#d99100` change-type 族（见 §7）、`#ea580c/#9333ea` RFC-027 分类 hue、`#f5a623` runtime-dot 进行态。
- 锁按「只禁增长」：allowlist 固定为改造后剩余裸 hex 集合，`:root`/`[data-theme]` 块外新增裸 hex 即红。

**【迁移风险】**（高，多条源码锁）
- `tests/awaiting-node-highlight.test.tsx:132 / 136-139` 硬断言 `border-color: #d97706` 及 `color-mix(in srgb, #d97706 55% …)` 字面量 → 同 commit 把断言改成 var 名并注释意图，**禁止删测试**。
- `tests/clarify-node-styles.test.ts` 断言 `.canvas-node--clarify` 与 `.canvas-node--review` 声明体**逐字相等** → 两者只改一个必红。
- `tests/canvas-review-output-drag-not-floating.test.ts:97` 要求 review 的 background/border-color 含 `color-mix`（改纯 var() 会红）。
- `theme-css-ratchet.test.ts`：dark 块顶层选择器须 `:root:not([data-theme])` 开头，且禁 `background: var(--accent|success|warn|info|danger)` 实心写法。
- `status-badge--warn` 的 `#d4a72c`（偏亮金）压到 `--warn-fg`(#844700) 会明显变暗，需 minimal repro + 明暗双截图。
- **只加不删** `--warn-fill`/`--warn` 历史别名（`:71-72` 自指），收敛时勿顺手删打穿 `:407-408/:892`。

**【优先级】** high（`foundBy: 1`）

---

### 6. success/warn/danger 状态色在各页面写死互不相同的 hex，不响应主题

**【现状证据】** 绿 5 种（`#1e8e3e / #2da44e / #16a34a / #1f883d / #1b6d34`）、红 6 种、黄 12 种。核心活点：
- `.status-dot--success|info|danger|warn|neutral`：`styles.css:10796-10810`（已被 `components/node-session/SessionTab.tsx:184` 以 `status-dot--${nodeRunStatusToKind(...)}` 复用）
- `.diff__add`：`styles.css:3664-3666`；`.diff__del` 已用 `var(--danger)`——对照
- `.validation-panel--ok`：`styles.css:6422-6423`
- `.homepage__runtime-dot--ok/checking/soft/fault`：`styles.css:1802-1817`
- `.task-row__status--*`：`styles.css:1963-1984`（发射方 `task-row.tsx` 早已走 `<StatusChip>`）
- `.status-badge--*` @ `11021 / 11377-11387`
现有全套 token：`--success-* / --warn-* / --danger-* / --info-*`（`styles.css:64-84`，暗色 `110/145` 分支齐备）。

**【已产生的不一致】** 同一 `done` 状态在 `/tasks` 由 `<TaskStatusChip>` 用 `var(--success)`(#1b6d34)、首页 `.task-row__status--done` 用 #1e8e3e——同页两种绿。这些字面量无暗色分支：`.task-row__status--done` 在 #1c2028 面板上仍用 #1e8e3e，对比度 <3:1。

**【建议】** 纯 CSS + 组件迁移，不新造 class。
- **(1) 就地换 token**：`.status-dot--*` → `var(--success-fill)/--info-fill/--danger-fill/--warn-fill/--muted`；`.diff__add` → `color: var(--success); background: color-mix(in srgb, var(--success) 10%, transparent)`（与 `.diff__del` 对称）；`.validation-panel--ok` → `var(--success)`。
- **(2) 删平行实现**：`.homepage__runtime-dot--*` 改直接输出 `status-dot status-dot--success|warn|neutral|danger`（`.homepage__runtime-dot` 只留尺寸/间距），删 `1802-1817`；`.task-row__status--*` 改渲染既有 `<TaskStatusChip>` / `.status-chip--kind`，删 `1963-1983` 自绘 tint（保留 `17153/17158` 窄屏 grid 定位规则）。
- **(3) 守卫用表级 banned 表**（不要「行号>180 禁裸 hex」——180 后仍有 199 处合法 hex）：在 `styles-tokens.test.ts` 逐个提取点名选择器规则体，断言不出现 `#`，并断言 5 个 `.status-dot--*` kind 都引用 `var(--*)`（复用 `theme-contrast.test.ts` 的 `declarations(selector)` 解析器）。

**【迁移风险】**（高）
- `theme-contrast.test.ts` 的 `rgb()` 只接受六位 hex，**只能改消费点**，`:root` token 值本身保持六位 hex 字面量。
- `status-kind-tables.test.ts:82,98` 锁 status→kind 映射 + 禁 src/ 出现 `status-chip--{green,red,blue,gray,amber,warning}` 色名 class；`homepage-task-row-status.test.tsx:56` 锁 `.status-chip.task-row__status` 复合选择器（删修饰符时勿删基类）。
- `.status-dot--*` 被 `SessionTab.tsx:184` 模板字符串拼接——**只改色值，不改选择器名**。
- **视觉基线是最大阻碍**：`e2e/visual-regression.spec.ts-snapshots/` 有 darwin+linux 双份 PNG（tasks / inbox / repos / workflow-editor 等）；步骤 (2) 改首页/任务页实际像素，两个 OS 基线大概率变红，linux 基线须走 CI `--update-snapshots`。步骤 (1) 删死 CSS 不动像素，可先单独合。
- `task-row` 迁到 `<TaskStatusChip>` 会引入 `text-transform: lowercase` 的大小写差异，需目视确认。

**【优先级】** high（`foundBy: 2`）

---

### 7. `modified / risky` 这一档语义色写死 `#d99100`，同色阶其它档已走 token

**【现状证据】**
- `.structure__delta--modified` `styles.css:13089`、`.structure__impact-target` `13135`、`.structure__badge--modified` `13334`、`.sg-card--ct-modified` `13548`、`.sg-card__member--ct-modified` `13575`、`.structure-graph__swatch--ct-modified` `13683/13684`、`.structure__chip` `13795/13796`、`.structure__severity--risky` `13898/13899`
- **CSS↔TS 双源**：`lib/structureGraph.ts:462` — `changeTypeColor('modified')` 返回字面量 `'#d99100'`（函数注释自称「Returns CSS vars so the SVG minimap stays theme-aware」——modified 分支违反自身契约）

**【已产生的不一致】** 三档严重度色阶被劈成两半：`--breaking` 用 `var(--danger)`、`--safe` 用 `var(--muted)`，唯独 `--risky` 写死；`--added/--removed` 用 `var(--success)/var(--danger)`，唯独 `--modified` 写死 → 主题切换时其余跟变而 modified 不变，色阶当场断裂。

**【建议】** CSS + TS 必须同改。
- 新增 `--change-modified`（三处主题块各一值，light 沿用 #d99100，dark 另给一档），8 处 CSS 全换 `var(--change-modified)`。**不建议**直接用 `var(--warn)`（解析为 `--warn-fg` #844700 深棕，与琥珀差异极大）。
  ```ts
  // lib/structureGraph.ts:462
  case 'modified': return 'var(--change-modified)'   // 原 '#d99100'
  ```
- 同步更新 `packages/frontend/tests/structure-graph-minimap.test.tsx:21` 的断言（改 `.toBe('#d99100')` → var 名，并更新 test 顶部注释）。

**【迁移风险】** `structure-graph-minimap.test.tsx:21` 硬断言必红，同 commit 改。xyflow MiniMap `nodeColor` 返回值落到内联 SVG `fill`——`var()` 在 SVG presentation attribute 上是否解析需**实测**（同 switch 的 added/removed 已返回 var()，属既成模式，风险低但仍应看一眼小地图着色）。新 token 必须定义在 `:root` 而非局部选择器，否则 minimap 取不到。清 `412/14140` 的 stale fallback 单独走 hunk。

**【优先级】** medium（`foundBy: 1`）

---

### 8. canvas 包装器/子仓的语义强调色（蓝/紫/铜）以裸 hex 散在 15+ 处

**【现状证据】** `#4a78a6`（≥5 次）、`#7a4ea6`、`#b87333`（≥8 次）：`styles.css:2140 / 2141 / 2147 / 6994 / 6995 / 6998 / 6999 / 7004 / 7005 / 7094 / 7095 / 7196 / 7197 / 10996 / 10997`；rfc027 分类色（另一套）`--rfc027-accent` 定义在 `10996` 一带。

**【已产生的不一致】** 同一 hex 多处重复、百分比各不相同（6%/14%/22%/25%）；平台里出现**两套**分类强调色——canvas 三支是压暗 muted 系（`#4a78a6/#7a4ea6/#b87333`），rfc027 是 vivid tailwind 系（`#2563eb/#16a34a/#ea580c/#9333ea/#64748b`）。

**【建议】** 纯 CSS，范围只收 canvas 三支，**不并入 rfc027**（两套是刻意不同调色板，强行共用即未经许可的视觉变更）：
```css
:root { --cat-git:#4a78a6; --cat-loop:#7a4ea6; --cat-fanout:#b87333; }
/* 派生需覆盖 6%/55%/80% 多档（pipeline-hero__wrapper-label 是 80% 变体）*/
```
`canvas-node--wrapper-group--{git,loop,fanout}` / `pipeline-hero__wrapper-box|label` / `shard-source` / `wrapper-header-pill--fanout` 全改引这组变量。若要治理 rfc027，另立第二组 `--role-*` token，各保原值。

**【迁移风险】** 全仓测试无锁这些 class/hex/`--rfc027-accent`。wrapper 背景是 React Flow group 节点、pipeline-hero 是 SVG fill/stroke，二者均支持 CSS var + color-mix，无渲染约束。派生需覆盖 6%/55%/80% 三档（别只算两档）。附近 `10874` 的 `#2a7a2a` success 回退不在范围，勿卷入。候选原列 `10853` 是 `.batch-import-table`（误列）。

**【优先级】** medium（`foundBy: 1`）

---

### 9. 品牌三色渐变在三个文件各抄一份，靠「keep in sync」注释维持

**【现状证据】** 三份拷贝：`components/home/PipelineHero.tsx:32-34`（`PIPE_GRADIENTS`）、`components/shell/AppShell.tsx:187-210`（`<linearGradient>`）、`public/favicon.svg:5-14`。`PipelineHero.tsx:30` 注释「keep in sync with __root.tsx」已过时（SVG 早搬到 `AppShell.tsx`）。

**【已产生的不一致】** 六个 tailwind 级高饱和色脱离主题体系，在 #15181d 暗底上（尤 `#3b82f6 → #a855f7`）饱和度过高，与 `--accent`(#8eb8ff) 柔和蓝割裂。

**【建议】** 只做「六色号 → CSS token」这层去重，**保持 gradient id 与各自 SVG 结构现状**（`aw-pipe-*` vs `aw-stream-*` 是刻意规避重复 id 冲突——两个 SVG 同屏于 `/`）：
```css
:root { --brand-a-from:…; --brand-a-to:…; /* …c-to，暗色分支给降饱和值 */ }
```
AppShell 的 `<stop stop-color>` 与 PipelineHero 的 `PIPE_GRADIENTS` 改读 `var()`（SVG `stop-color` 原生支持 CSS var，但 presentation 属性不支持——须走 `style`/CSS 规则）；`favicon.svg` 在 src 外无法读 var，保留字面量并在 token 定义处注释为唯一例外；删 `PipelineHero.tsx:30` 过时注释。**不要**合并成单一 `<defs>` / 共享 id（会产生非法重复 id；两坐标系 x2=64 vs x2=560 不可共用同一 linearGradient 几何）。

**【迁移风险】** 全仓测试无锁 `aw-stream/aw-pipe/PIPE_GRADIENTS/linearGradient`。暗色降饱和是净新增视觉变更，需 minimal repro + 明暗双截图；`/` 有 a11y gate，改 stop/defs 勿动 `aria-hidden` 与 `<Link>` 可访问名。收益如实下调：坐标无法 dedup、favicon 无法纳入，主要价值在暗色变体这一净新增能力。

**【优先级】** low（`foundBy: 1`）

---

### 10. MermaidBlock 把整套主题 token 用 62 个字面 hex 手抄了一遍（明暗各一份）

**【现状证据】** `components/review/MermaidBlock.tsx:36 / 39 / 45 / 46 / 72 / 73`（`THEME_VARS` light+dark 两套）；顶注 `27-33` 自称「keyed to the app's CSS variables」。token 里无对应项的 mermaid 专属色：`secondaryColor '#eef3ff'`、`noteBkgColor '#fff8d6'/'#3a2f10'`、`noteBorderColor`。

**【已产生的不一致】** 当前色值与 token 一致（逐条核对无 drift），但无机制保证同步：RFC-054 已改过两次 `--muted/--accent`，下次 styles.css 改 token 此处不会跟变。定性为「潜在漂移硬化」而非现有 bug。

**【建议】** `MermaidBlock` 是静态 helper（非 React 组件）。在 `loadMermaid()/initialize` 前用 `getComputedStyle` 读 token 组装 `themeVariables`：
```ts
function themeVars(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback
  return {
    background: v('--panel', '#ffffff'),
    primaryTextColor: v('--text', '#1f2328'),
    // …mermaid 专属色提成新 token：
    noteBkgColor: v('--mermaid-note-bkg', '#fff8d6'),
    noteBorderColor: v('--mermaid-note-border', '#…'),
  }
}
```
mermaid 专属色（`secondaryColor/noteBkg/noteBorder`）新增 `--mermaid-*` token 进 styles.css `:root/[data-theme=dark]`，对称双写。**必须 fail-loud/回退**：happy-dom 下 `getComputedStyle` 可能返回空串，读空时回退字面常量，否则 mermaid 拿到空色值渲染无样式图。校正：暗色 `primaryTextColor:'#e6e7ea'` 在 `:72`（非 71），源码无 `// == token` 行内注释，以顶注映射为准。

**【迁移风险】**（高，逐字契约锁）`tests/mermaid-block-theme.test.ts` 用 `toMatchObject` 硬锁 `#15181d/#1c2028/#e6e7ea/#8eb8ff/#95a0b3/#ffffff/#1f2328/#1f5fda/#5b6271` 及 `darkMode` 标志，头注明写「防 palette drift」——迁移必红，需连注释一起重写，并在 happy-dom 里 seed CSS var。`prose-code-mermaid-theme.test.tsx`（锁第 3 参 `'light'/'dark'` 透传与 flip 重渲染）、`mermaid-block-labels.test.ts` / `prose-code-mermaid.test.tsx`（锁 foreignObject 消毒）只要 render 签名与 initialize-per-render 行为不变即安全。归属 RFC-005 PR-C T17。

**【优先级】** medium（`foundBy: 2`）

---

### 11. 评审/反问命名空间的硬编码阴影与错色（已有 `--shadow-*` / `--warn` 变量）

**【现状证据】**
- 字节相同的阴影抄写：`.review-cross-heading-hint` `styles.css:8843`（= `--shadow-md`）
- 评论浮层各造一套两层阴影：`.comment-bubble` `8497-8500`、`:hover` `8510-8513`、`--active` `8519-8522`、`.comment-popover` `8686-8688`
- **真 bug 错色族**：`.review-decision-dialog__warn` `8902`（`rgba(255,180,50,.12)` 橙底）配 `8903` `border-left: 3px solid var(--accent, #f0a020)`（蓝左边框），`8922` `var(--danger, #d04040)`；focus ring `8661/8674` 硬写 `rgba(255,180,50,.75|.6)`
- stale fallback：`458 / 591` `var(--shadow-lg, 0 8px 24px …)`（≠真值 `0 20px 40px`）

**【已产生的不一致】** 同一「悬浮卡片」层级在气泡/popover/提示条上深浅不一；`8903` 想要警告橙却渲染成蓝色边框（`--accent` 生效），语义就是错的。

**【建议】** 拆四条子项，优先级递减：
- **A（零风险）**：`8843` → `box-shadow: var(--shadow-md)`（字节相同）；`8520` `--active` 首层 → `var(--shadow-md), 0 1px 3px rgba(0,0,0,.08)`。
- **B（有像素变化）**：评论浮层阴影不等于现有 token，在 `:root` 增补 `--shadow-popover: 0 8px 24px rgba(0,0,0,.18), 0 2px 6px rgba(0,0,0,.1)` 供 `8686` 与 `458/591` 复用，`8498/8511` 补 `--shadow-raised`；**不要**强压到 `--shadow-sm`。改前后 minimal repro 双主题截图。
- **C（真 bug，独立修）**：`.review-decision-dialog__warn` 改 `background: var(--warn-bg); border-left: 3px solid var(--warn-border)`；`8661/8674` focus ring 改 `color-mix(in srgb, var(--warn) 75%, transparent)`。
- **放弃**原提案「全命名空间去 hex fallback」——只在评审空间清理反造不一致，要清全仓一次性清（见 §2/§3）。
- **测试**：无回归网，按 test-with-every-change 自带一条源码文本断言（如「`.review-cross-heading-hint` 块内不得出现裸 rgba 阴影」）。

**【迁移风险】** `458/591` 当前实际渲染 `--shadow-lg` 的 `0 20px 40px`，改指 `--shadow-popover` 会让 Dialog 阴影变轻——是修 bug 但属可见变更，commit message 点名。`--amber-*`（`8185-8187`）与 `--border-muted`（`5226`）全仓无声明，hex fallback 是唯一真值（见 §3），CSS 无单测拦不住。`e2e` 无 review/comment/decision-dialog 快照，B 项像素变化 CI 既不报红也不保护，只能人工比对。行号常漂移，落地按选择器名重新 grep。

**【优先级】** medium（`foundBy: 1`）

---

### 12. 评论锚点高亮用裸 rgba 黄，不是 token 且暗色兜底缺 `@media`

**【现状证据】** `mark.comment-anchor` 簇 8 处裸 rgba：`styles.css:8799 / 8808 / 8815 / 8816 / 8820 / 8824 / 8828 / 8829`；`.review-decision-dialog__warn` `9057`（warn 语义，单独归 §11）。两个互不相干的黄 `rgba(255,215,80)` 与 `rgba(255,180,50)` × 4 档透明度。

**【已产生的不一致】** 同一「高亮」语义两套黄，全裸 rgba 与 `--warn` 无关；且这组暗色覆盖只有 `data-theme` 版（`8664-8674`）、缺 `@media (prefers-color-scheme: dark)` 兜底 → system 主题下暗档失效，用户看到亮档强黄（真 bug）。

**【建议】** 纯 CSS，定义独立高亮 token（直接承载现有黄值以免变色，**不从 `--warn-fg` 派生**——那会变棕）：
```css
:root { --highlight-bg:…; --highlight-bg-hover:…; --highlight-bg-strong:…; --highlight-ring:…; }
:root[data-theme='dark'] { /* 暗档 */ }
@media (prefers-color-scheme: dark) { :root:not([data-theme]) { /* 同暗档，补 system 兜底 */ } }
```
8 处裸 rgba 全换 token。**保留** `8800` 已有的 `color: inherit`（勿改 `var(--text)`，那是行为变更）。后续「搜索命中 / diff 关注行」复用 `--highlight`。

**【迁移风险】** 全仓测试只锁 `mark.comment-anchor[data-comment-id]/data-active` 选择器契约，不锁颜色值——改色安全。行号漂移约 +150，以 `grep 'comment-anchor'` 重新定位。暗色补 `@media` 与 `data-theme` 两路，否则 system 主题仍失效。改完 light+dark+system 三态目视比对。

**【优先级】** low（`foundBy: 1`）

---

### 13. 字段下方提示文案：14 处 inline `style` 硬编码字号/间距，绕开 Field 的 hint 槽与 `.form-field__hint`

**【现状证据】**（多路审计重复命中，合并）
`components/ModelSelect.tsx:111 / 160 / 178`、`components/ResourcePicker.tsx:102`、`components/RuntimeList.tsx:188 / 524 / 530 / 556 / 565`、`components/canvas/inspector/promptRefs.tsx:50`、`components/canvas/inspector/ClarifyEdit.tsx:83`、`components/canvas/inspector/CrossClarifyEdit.tsx:91 / 108`、`components/tasks/TaskDiagnosePanel.tsx:167`。
现有原语：`Form.tsx` 的 `<Field hint={…}>` → `.form-field__hint`（`Form.tsx:68` 渲染 `<span className="form-field__hint">`，见上文源码；`McpFields.tsx:80/115/160` 已把它当独立段落用）。`.form-field__hint` 现值 `font-size:12px`（`styles.css:3758`）。

**【已产生的不一致】** 同一「字段下方灰色小字」渲染成三种字号：12px（ModelSelect/ResourcePicker/inspector）、13px（RuntimeList 四处，`556` 是 13、`565` 是 12——同对话框内自相矛盾）、以及走 `.form-field__hint` 的正规字号；margin 写法三套（`marginTop:4` / `'4px 0 0 0'` / `'0 0 12px 0'`）。`ModelSelect.tsx:111` 是 `role="alert"`、`ResourcePicker:102` 同语义却没有——a11y 也不一致。`.form-hint` 被 `EdgeInspector.tsx:172` 引用但 styles.css 里从无定义（死类名）。

**【建议】** **扩展既有原语**，不新增组件。把 `.form-field__hint` 提升为可独立使用的 `.form-hint`（`.form-field__hint` 保留为真别名——选择器并列而非重命名，因 `styles.css:3817` 有 `.form-switch > .form-field__hint` 后代依赖）：
```css
/* 字号取 var(--font-sm)=12px，不是 --font-xs=11px（否则全站 hint 缩小一档） */
.form-hint, .form-field__hint { display: block; font-size: var(--font-sm); color: var(--muted); margin: var(--space-1) 0 0; }
```
- 能塞进 Field 的直接用 `<Field hint={…}>`（`RuntimeList:524/530/556/565`、`ClarifyEdit:83`、`CrossClarifyEdit:91/108` 均在 Field 内）；`hint` 现为 `string` 类型已够，**不要**扩成 ReactNode。
- 不在 Field 内的（`ModelSelect:178`、`ResourcePicker:102`、`promptRefs:50`）改 `<p className="form-hint">`（去 inline style）。
- **错误语义**用 `.form-field__error`（`styles.css:3763`，自带 `var(--danger)` + margin-top）+ `role="alert"`：`ModelSelect:111`（加载失败）、`ResourcePicker:102`（loadFailed，顺带补齐缺失的 role）。
- `RuntimeList` 的 13px 统一到 12px——本次唯一行为性修复。
- **排除**：`RuntimeList:188`（section 副标题，走 `.page__subtitle`）、`TaskDiagnosePanel:167`（表格单元格描述）、`ModelSelect:160`（按钮字号，另走 `.btn--xs`）——语义不是 field hint，单独处理。
- 锁：`components/`+`routes/` 下禁 `fontSize:` 字面量，allowlist 仅留待迁项；`PageSectionNav.tsx:155` 是 `getComputedStyle().fontSize` 属性读取，正则写成 `fontSize:` 才不误伤。

**【迁移风险】** **最高坑是字号**：`--font-xs`=11px、`--font-sm`=12px，原提案的 `--font-xs` 会把全站 15+ 处 hint 静默缩小——必须 `--font-sm`。`.form-field__hint` 有 12 个消费者（McpFields/FilesPicker/RepoSourceRow/WorkgroupRoom×5/WorkgroupForm/WorkgroupTaskConfigDialog/settings.tsx），提升时不保留别名会一次性打断。`tests/settings-inline-style-cleanup.test.ts`（RFC-035）断言 `settings.tsx` 中 `/style=\{\{/` 恒 false 且该文件当前有他人未提改动——**本批别碰 settings.tsx**。RuntimeList 13→12px 是真实视觉变更，`settings.png` 基线正是 runtime tab 内容，很可能需刷新。inspector 三处在右侧抽屉（`.inspector__*` 命名空间），新 class 优先级需确认不被覆盖。`.form-row` 类不存在（原提案误列，勿执行）。

**【优先级】** medium（`foundBy: 2`，多路重复确认）

---

### 14. 字号 token 体系不完整：13px（107 处）/10px（21 处）无对应 token，426 处裸 px vs 149 处 var

**【现状证据】** token 刻度 `styles.css:47-51`（xs11/sm12/md14/lg16/xl22，**缺 10px 与 13px**）。同角色 hint 三种写法并存：`.auth-tab__hint` `styles.css:921`（12px 裸写）、`.task-recovery__hint` `2922`（13px 无 token）、`.form-field__hint` `3759`（12px）、`.auth-page__hint` `7828`（13px）、`.resource-group__hint` `16315`（12px）、`.task-feedback__hint` `12278`（已 `var(--font-sm)`——反例）、`.agent-dep-autodetect__hint` `11693`（已 `var(--font-sm)`）。刻度外零星值：9/8/11.5/15/17/18/20/24/32px。

**【已产生的不一致】** 完全同语义的 hint 文本，有的 12px、有的 13px、有的 `var(--font-sm)`；107 处 13px、21 处 10px 落在刻度之外——说明「刻度不够用」于是各自造数。

**【建议】** 纯 CSS，**分两阶段，第一阶段必须像素恒等**。
- **阶段 A（像素零变化，收益最大）**：补两个 token 让刻度闭合，再机械按值替换全部裸 px（含 12→sm、11→xs、14→md、16→lg、22→xl；284/412 处本就等于已有 token 值，是收益大头）：
  ```css
  --font-2xs: 10px;
  --font-base: 13px;   /* 插在 sm 与 md 之间 */
  ```
  刻度外零星值（9/8/11.5/15/17/18/20/24/32px）单独盘：能贴最近 token 的贴，确属一次性装饰（32px 大字、8px 角标）就地留 px + 注释。同步收 JSX 内联 `fontSize`（见 §13）。
- **阶段 B（改像素，单独 PR）**：再决定 13→12/14 归一，风险量级与 A 不同必须拆开。
- **收尾锁**（计数不得增长）：源码断言 (a) styles.css `font-size:\s*\d+px` 出现数；(b) tsx `fontSize:\s*\d` 出现数；(c) `--font-2xs/--font-base` 存在于 `:root`。

**【迁移风险】** 阶段 A 像素恒等、零基线 churn；阶段 B 落在 `settings.png`（默认 runtime tab）截图区的会红。`workgroup-room-side-rail.test.tsx:213` `toMatch(/font-size:\s*13px/)`、`editor-layout-viewport-fit.test.ts:92/98` 锁 `18px/12px` 精确值——tokenize 这些站点会红，须 lockstep 更新正则。**xyflow 画布**：`.canvas-node*` 字号是节点尺寸/端口对齐输入，画布相关只做零像素替换、13→归一在画布区跳过。三个 overflow 源码锁（`task-questions-overflow` / `task-workflow-cell-overflow` / `clarify-title-overflow`）按整块规则文本匹配，批量 sed 前先跑这三个文件。

**【优先级】** high（`foundBy: 2`）

---

### 15. 圆角 token 只有 4/6/10/999，最常用的 8px（47 处）和 3px（22 处）不在刻度上

**【现状证据】** token `styles.css:53-56`（sm4/md6/lg10/pill999）。裸值散布：`.chip` border-radius 12px `3374`、`.info-box` 6px `2760`、`.agent-port-card` 系列，圆点 `50%`（11 处）与 `999px`（20 处）并存。`14084` fallback 写 `8px` 暴露作者以为 md 是 8。

**【已产生的不一致】** 卡片类有 6px/8px/10px 三档，小徽标有 3px/4px 两档；圆点一半 `50%` 一半 `999px`。

**【建议】** 纯 CSS。**保留 `--radius-md=6px` 不动**（61 裸 6px + 26 `var(--radius-md)` = 87 处意图 6px，是全仓最高频；重定义会让 26 个站点集体 6→8 回归）。新增收编 8px：
```css
--radius-xl: 8px;   /* 收编 48 处裸 8px */
```
其余归并：6px 裸→`var(--radius-md)`、4px→sm、10px→lg、3px→sm（1px 变化、徽标级可接受）、`999px` 与圆点 `50%`→`var(--radius-pill)`（8×8 圆点两者渲染等效）。加源码文本计数锁（裸 8px/6px/999px/50% 计数为 0 或白名单）。

**【迁移风险】** `sidebar-badge-bubble.test.ts:42` 断言字面 `border-radius: 999px`，pill 统一必红需同 PR 改。`11 处 50%` 真圆与 `20 处 999px` pill 语义不同，多值/单边圆角（`0 4px 4px 0`）不能一刀切。`styles-tokens.test.ts` 的 RADIUS 列表需手动加 `--radius-xl`。183 处裸值迁移是大 churn，需 light/dark 视觉核验。`workflow-canvas-surface.test.tsx` 只锁 handle `inset:-8px`（非 radius），画布迁移安全但仍需目视。

**【优先级】** medium（`foundBy: 1`）

---

### 16. 阴影 / z-index 绕开 token 写死 rgba/数字，浮层层级已无统一刻度

**【现状证据】** 阴影四种写法：`0 1px 2px rgb(0 0 0 / 12%)`（≈shadow-sm 手抄）`styles.css:13430 / 13452`、`0 8px 24px rgb(0 0 0/.18)`（15100）、`0 2px 8px rgba(0,0,0,.18)`（15296）、`8843`（=shadow-md）、`10942`（=shadow-sm）；stale fallback `458/591/14085`。z-index 无刻度：`2 / 20 / 50 / 60 / 100 / 1000 / 1200` 混用（`6369:100`、`8680:50`、`8835:60`、`11419:1000`、`594/14076:1200`、`.user-menu__dropdown 460:50`）。

**【已产生的不一致】** 同「悬浮卡片」深浅不一；z-index 无刻度导致新弹层只能靠猜。

**【建议】** 纯 CSS，**收窄为 elevation 阴影归一，z-index 需先测绘层叠序**。
- 零风险等价替换：`8843` → `var(--shadow-md)`、`10942` → `var(--shadow-sm)`；近似替换 `13430/13452` → `var(--shadow-sm)`（.12→.08 肉眼几无差，双主题截图确认）。
- `15296`（`0 2px 8px/.18`）与 `15100`（`0 8px 24px/.18`）**不等于任何现有 token**（`--shadow-lg` 是双层 `0 20px 40px`），**禁止直接替成 `--shadow-lg`**。若收敛需新增 `--shadow-float` / `--shadow-popover` 两档；目前各仅 1 处消费者，可判「暂不抽 + TODO 注释」。
- stale fallback `458/591/14085` 删掉，直接 `var(--shadow-lg)/var(--shadow-md)`。
- 锁：断言不出现「与 `--shadow-sm/md/lg` 定义值逐字相同的裸 box-shadow」，并从 `:root` 解析 token 值做比对（token 改值锁自动跟随）。
- **z-index 整体撤销/独立立项**：新增 `--z-*` 五档前须先测绘现有裸值相对层叠序（dialog 1200 须高于 canvas 1000/100），逐一映射保持既有堆叠；排查 `Dialog.tsx` / xyflow 是否在 JS 内联设 z-index。

**【迁移风险】**（多条锁）`focus-ring-inset.test.ts:81 / 280-291` 强制一组 `box-shadow: inset 0 0 0 2px` 且逐层断言「非 inset 即 bug」——新锁必须写成「非 inset 且非 0-offset-0-blur」窄形状，否则误伤 focus ring。`gallery-page.test.tsx:435-436` 断言 gallery 规则 `not.toContain('z-index')`。**xyflow 层叠**：`.canvas-node__inbound-catchall z-index:0`(7474)、`.canvas-connect-badge:10`(7536)、`.workflow-canvas__node-actions:12`(6057) 在 xyflow node wrapper 内，`canvas-port-handles.test.tsx:46` 注释文档化了相对序，改大值会穿透层叠上下文——不可动。29 处裸 box-shadow 多数是合法 inset/focus-ring/keyframe（`554/5974/6757/7505-7529/8661/8798/13530/15349/15597/15807/16523…`），锁不能一刀切。

**【优先级】** medium（`foundBy: 1`）

---

### 17. 焦点环 token 已存在，仍有一批 outline 写死 2px + 三种 offset

**【现状证据】** token `styles.css:83-101`（`--focus-ring-color/-width/-offset/-offset-inset/-gutter`，`1298/2752/3201/4706` 已正确用）。写死 `2px solid`（14 次）：`styles.css:1574 / 2094 / 3790 / 3860 / 6583 / 9158 / 14222 / 14926 / 14999 / 15332 / 15354 / 15437 / 15745`；死色 fallback `#3b82f6` @ `15354/15437`。

**【已产生的不一致】** offset 1px/2px/3px 三档并存，宽度写死后调 `--focus-ring-width` 不生效；`88-99` 注释明说满宽控件须用 inset 否则被祖先 overflow 裁，但 `3860` form-switch、`1574` inbox item 都用了正 offset。

**【建议】** 纯 CSS，分安全/语义两步。
- **A（机械，必做）**：13 处 accent 焦点环把 `2px solid var(--accent[, #3b82f6])` 改 `var(--focus-ring-width) solid var(--focus-ring-color)`（消除 `15354/15437` 死色，让宽度 token 生效）。
- **B（逐条判断）**：offset **不能盲替**。内蕴尺寸 chrome（`.btn`/tabs）保留 `var(--focus-ring-offset)`；满宽控件用 `var(--focus-ring-offset-inset)`。`1574` inbox item(1px) 很可能满宽 → 应改 inset；`6583`(3px) 逐条判 inset vs outset。
- **C（锁收窄）**：断言 `outline:\s*2px solid var\(--accent` 为 0（只禁硬编码宽度的 accent 环），**不要** `outline:\s*2px solid`——会误伤 `16850 outline: 2px solid CanvasText`（forced-colors 系统色，无法 token 化）、`15920 color-mix`、`15966 var(--split-accent)`（故意的不同色环）。首选扩到既有 `focus-ring-inset.test.ts` 新增 describe。

**【迁移风险】** `focus-ring-inset.test.ts` 明文声明「Table-level guard (not file-level)」并解释刻意不做文件级 outline 断言——文件级文本锁与其设计直接冲突。1px/3px→2px 是真实像素变化需双主题截图。`.react-flow__controls-button` 焦点环已在既有列表单独覆盖，不在本次范围。原提案行号 `15199` stale（实 `15354/15437`），总数 16 vs 提案 5，动手前重新盘点。

**【优先级】** medium（`foundBy: 1`）

---

### 18. 动效时长无 token，同一个 120ms 两种写法，另有 100/150/200ms 近似值

**【现状证据】** `styles.css:573`（0.12s）、`1379`（200ms）、`1671`（120ms）、`3851`（0.15s）、`5811`（0.1s，无缓动）、`8260 / 8305 / 8589`（hover 背景过渡）。

**【已产生的不一致】** 同语义 hover 背景过渡有 120ms/200ms/0.1s 三种；开关位移 `573` 0.12s、`1671` 120ms、`3851` 0.15s——开关比箭头明显慢一拍。

**【建议】** 纯 CSS，**按语义分档，不一刀切压成 fast**：
```css
--duration-fast: 120ms; --duration-base: 150ms; --duration-slow: 200ms;
--ease-standard: cubic-bezier(0.2, 0, 0, 1);
```
120ms 类→fast、150ms 类→base、200ms→slow；给 `5811` 缺失的缓动补 `var(--ease-standard)`。近似值集合以实测为准（100/150/200，**无 140ms**）。补源码文本锁（无 stylelint，token 化不自动防漂移）。

**【迁移风险】** 三个 overflow 源码锁只断言 overflow-wrap/word-break，不锁 transition。ease 改 `cubic-bezier` 是真实曲线变更，独立步骤 + 双主题截图。需 grep 确认这些 transition 是否命中 xyflow 画布节点。原提案 anchor `8446/8117` 错位（实 `8589/8260/8305`），且候选夸大「140ms」（不存在），落地按实际行改。

**【优先级】** low（`foundBy: 1`）

---

### 19. workgroup-room 卡片/标题块整段没走 token：字面 px + `var(--accent, #3b82f6)`

**【现状证据】** `.workgroup-room__card` `styles.css:15175`（gap:6px; padding:8px 10px; radius:8px）、`__card-title` `15192`（13px）、`__card-assignee` `15196`（12px）、`__side-title` `15279`（13px）、`__card--turn` `15330`（`border-left:3px solid var(--accent, #3b82f6)`）、`__runlog-row:focus-visible` `15426`（同 accent-hex）、`__gate-state` `15443`（13px）、`__info` `15462`（gap:4px 8px; 12px）；共享类 `.status-chip--clickable` `15343` 也有 `var(--accent, #3b82f6)`。

**【已产生的不一致】** 同命名空间内部分裂：RFC-207 的 `.workgroup-room__clarify-stops`（`15305`）用 `var(--space-2/3)`，RFC-164 的 `__card*` 全字面 px → 卡片间距 6px 与 chip 行间距（`--space-2`=8px）对不齐。`var(--accent, #3b82f6)` 全文件 3 处，主题改 accent 时兜底泄品牌外蓝。

**【建议】** 纯 CSS，分两档。
- **A（干净正解）**：删 `var(--accent, #3b82f6)` 的 hex 兜底，统一 `var(--accent)`（3 处 `15330/15343/15426`；`15343` 属共享 `.status-chip--clickable`，一并收敛）。锁：断言全文件不出现 `var(--accent, #`（既精确又覆盖全 3 处）。
- **B（只做无损映射）**：有精确 token 的才换（8px→`var(--space-2)`、12px→`var(--font-sm)`、11px→`var(--font-xs)`）。
- **不要动 / 需先决策**：13px 字号、6px 间距、10px padding 右值、8px 圆角均无对应 token，最近邻映射会改像素——要么补 token（设计确认）要么留字面量 + 注释。

**【迁移风险】** token 刻度缺 13px/6px/10px/8px，「px 全换」不可无损。`15343` 在命名空间外、属全局共享 class，改它牵动别的页面。CSS 注释「Locked by workgroup-room-composer-outline-clip.test.ts」已失真（该测试不存在），回归网薄需自建断言。原引用行号多处失准（`15031` 是布局轨道、`15048/15052` 在注释），以真实命中为准。

**【优先级】** medium（`foundBy: 1`）

---

### 20. agent / skills / editor 命名空间大量字面 px，与相邻块的 token 写法并存

**【现状证据】**
- **agent**：`.chip` `styles.css:3374`（radius 12px）/`3376`（13px）、`.agent-port-card__name` `4065`（14px）、`__kind-code` `4072`（11px）、`__description` `4087`（13px）、`.info-box` `2759`（padding 10px 14px）/`2760`（radius 6px）/`2761`（14px）
- **skills**：`.file-tree*` `4921-5044` 通篇字面 px（圆角 8px/6px/4px），而相邻 `.skill-import`（`9362+`）通篇 `var(--space/radius/font-*)`；`.skill-import` 局部把 `--success/--warn/--info` 覆写（`9374`，light 值 = 全局、dark 变体是刻意 AA 调优——**非 bug，勿动**）
- **editor**：`.workflow-starter__card` radius 10px `5956`、`.workflow-validation__overlay` radius 10px `6470`、副文字号 12px `5967`、`.connection-dialog__mode` radius 6px `6149`、`.inspector__output-ports` 8px `6141`；反例 `5303/5314` 已用 token

**【已产生的不一致】** 同一功能两个相邻 CSS 块风格相反（file-tree 字面 px vs skill-import token）；编辑器里 6px/8px/10px 三档圆角、12px/var(--font-sm) 两档副文字号并存。

**【建议】** 纯 CSS，**只做零像素等值替换，off-scale 值不强塞**。
- radius：6px→`var(--radius-md)`、10px→`var(--radius-lg)`（字节等价）；`6141` 的 8px 无对应 token → 见 §15 新增 `--radius-xl` 或 RFC 拍板 snap（真实像素变更）。
- font：12px→`var(--font-sm)`、11px→`var(--font-xs)`、14px→`var(--font-md)`。
- 13px（`.chip`/`.agent-port-card__description`）**不新增 `--font-13`**（把漂移制度化）——按 §14 阶段 B 统一到 sm/md，需双主题视觉核对。
- file-tree 8px/6px/4px 逐个核对是否精确映射 lg/md/sm，无完全对应值不强凑。
- off-scale 布局常量（padding 14px `5951`、3px、min-height 34px、top 50px `6470`）不套 `--space-*`，按语义新增变量（如 `--canvas-overlay-top`）。
- **删除**关于 `.skill-import` 覆写 `--success/--warn/--info` 的整项——是正当 scoped-token，勿新增 `--success-strong`。
- 锁：仿 `no-nul-bytes-in-source.test.ts`，断言 styles.css `font-size:\s*\d+px` / `border-radius:\s*\d+px` 计数「不得增加」（基线写进注释）。

**【迁移风险】** `AgentPortCard` 只在 `InputsEditor.tsx`/`OutputsEditor.tsx` 渲染，非画布节点，无 canvas 测量约束。三个 overflow 源码锁只锁 layout 属性不锁 font-size/radius——目标 class 替换安全。skill mono 字体禁令正则须写 `font-family:\s*ui-monospace`（否则误伤合法 `var(--font-mono, ui-monospace, …)` 兜底）。`workflow-validation__overlay` 是画布 absolute 浮层但 `radius-lg==10px` 字节等价、无影响。真实风险集中在被剔除的 13px 归一 / 8px snap（大 blast-radius 视觉改动，需逐页明暗双主题验证）。

**【优先级】** medium（`foundBy: 2`）

---

### 21. OIDC 登录按钮自写整套 chrome + 内嵌硬编码品牌色 SVG

**【现状证据】** `routes/auth.tsx:240 / 243`（自写按钮 + 伪元素图标）；`.auth-page__provider-btn` 5 条规则 `styles.css:7852 / 7873 / 7880 / 7886 / 7891 / 7897`；CSS 伪元素图标写死 `%232f6feb`（浅色主题 accent，暗色下仍浅蓝，且已被 RFC-054 淘汰）；`OidcProvider.iconUrl`（`routes/auth.tsx:44`）拿到却被伪元素覆盖，协议字段废弃。

**【已产生的不一致】** 登录页唯一自成一套焦点环/hover 的按钮，与同页 `.btn btn--primary`（`auth.tsx:219/277`）观感不一致。

**【建议】** **扩展既有 `.btn` 家族**，新增 `.btn--row` 修饰（左对齐、满宽、尾部箭头），删 `.auth-page__provider-btn` 全部 5 条规则，焦点环交给系统 `:where(.btn…):focus-visible`：
```tsx
// routes/auth.tsx
<button className="btn btn--primary btn--row" onClick={…}>
  {provider.iconUrl != null
    ? <img src={provider.iconUrl} alt="" aria-hidden className="btn__lead-icon" />
    : <SsoIcon />}   {/* 内联 SVG，stroke="currentColor"，对齐 components/icons/ 惯例 */}
  {t('auth.loginWith', { name: provider.name })}
</button>
```
- 图标优先渲染 `provider.iconUrl`；因其为 `string | null`（测试 fixture 就是 null），**必须做 null 回退**到内联 SVG。
- 附带修掉 `#2f6feb` 过期硬编码（改 `currentColor`）。

**【迁移风险】** `auth-form-tabs.test.tsx:162` 用 `getByRole('button', { name: 'Login with Corporate SSO' })` 按角色 + 可访问名选取——改 class 不红，但**必须保留 button role 与可访问名**（继续用 `t('auth.loginWith')`）。fixture（`auth-form-tabs.test.tsx:150`、`oidc-confirm-dialog.test.tsx:66`）均 `iconUrl:null`，渲染必须容忍 null。渲染 iconUrl 是行为变更（此前完全忽略），须验 null 分支。无测试对 `.auth-page__provider-btn` 或 hex 做源码锁（这正是 `#2f6feb` 一直没被拦下的原因）。按 test-with-every-change，此改动须随带新测试（当前零覆盖）。

**【优先级】** medium（`foundBy: 1`）

---

## 7. 契约漂移（contract-drift）

# Contract-Drift 专项审计（前端）

> 本章记录「同一产品契约在多处各写一份、实现已经漂移」的问题。每条给出现状证据（`路径:行号`）、已产生的用户可见不一致、收敛建议（含 API 草图与「新建/扩展」判定）、迁移风险与优先级。行号以审计时源码为准；`styles.css` 因并发改动持续下移，落地时请按类名/符号重新定位。

---

### 1. Dialog 底部「取消 + 主操作」按钮组各写各的（尺寸 / 顺序 / 嵌套已漂移）

**现状证据**
- 默认尺寸 `btn` 派：`components/ConfirmDialog.tsx:97-108`、`components/ScheduleDialog.tsx:175`、`components/QuickCreateDialog.tsx:76-79`、`components/RenameDialog.tsx:74`、`components/fusion/FuseDialog.tsx:126`、`components/tasks/TaskMembersPanel.tsx:181-188`、workgroup 全域（`WorkgroupMemberCards.tsx:48/86`、`WorkgroupTaskConfigDialog.tsx:118`、`WorkgroupRoom.tsx:856`）。
- `btn btn--sm` 派：`components/tasks/QuestionAuthorForm.tsx:89-93`、`components/tasks/WorkflowSyncDialog.tsx:43-50`、`components/tasks/RepairChoiceDialog.tsx:117-124`。
- 同一 footer 内混尺寸：`components/workgroup/DynamicWorkflowPanel.tsx:357-367`。
- 双层 footer：`components/tasks/TaskDiagnosePanel.tsx:85-86` 在 `Dialog` 已渲染的 `<footer className="dialog__footer">`（`components/Dialog.tsx:289`）里又套了一层 `<div className="dialog__footer">`；移动端 `styles.css:17007` 的 `.dialog__footer .btn` 规则因层级错位命中失败。
- 动作顺序反例：`TaskDiagnosePanel.tsx` 是「重扫(次)在左、关闭在右」，其余均「取消在左、主操作在右」。

**已产生的不一致**
- 同一产品的对话框按钮存在 36px（`btn--sm`）与 44px（`btn`）两种高度，且 tasks 域与仓内多数弹窗恰好分处两派。
- TaskDiagnosePanel 底部多一份 padding/gap；动作左右顺序与全局约定相反。

**建议** — 新建 `components/DialogFooterActions.tsx`（footer 动作区唯一出口），尺寸固定默认 `btn`，绝不出 `--sm`；DOM 序固定「error/extra → cancel → confirm」。以 `ConfirmDialog`（事实基准形态）作为首个消费者，再替换其余 11 处。
```ts
interface DialogFooterActionsProps {
  error?: unknown;                 // 走 ErrorBanner/resolveApiError，位置由本组件独占
  extra?: React.ReactNode;         // 承载非按钮内容 / 左侧次级动作（如 rescan、空态 hint）
  cancel: { label?: string; onClick: () => void; disabled?: boolean; testid?: string };
  confirm?: {                      // 不传 = 无主操作（如 diagnose 面板）
    label: string; pendingLabel?: string;
    onClick: () => void; disabled?: boolean; pending?: boolean;
    variant?: 'primary' | 'danger'; testid?: string;
  };
}
```
- 文案不内定：`label`/`pendingLabel` 一律由调用方传（`taskQuestions.author.cancel` / `tasks.syncWorkflow.cancel` / `common.cancel` 等各留原 key）。
- TaskDiagnosePanel 用 `extra={<rescan/>} cancel={{label: t('tasks.diagnose.close')}}` 且不传 `confirm`；同时删掉它 `:86` 的嵌套 `dialog__footer`。
- `Dialog` 的 footer 类型保持 `ReactNode`（不收紧成「只接受 DialogFooterActions」，否则 `WorkgroupTaskConfigDialog.tsx:126` 的 `form-field__hint` 空态会被逼出绕过写法）。
- 源码锁：断言除 `Dialog.tsx` 外无文件出现 `className="dialog__footer"`，且 footer 槽内不再出现裸 `btn btn--sm` cancel。

**迁移风险**
- testid 必须原样透传：`workflow-sync-confirm` / `task-diagnose-rescan` / `repair-choice-next` / `members-transfer-confirm` 被 `tests/{workflow-sync-banner,task-diagnose-panel,task-diagnose-panel-reopen}.test.tsx` 与 `e2e/lifecycle-diagnose.spec.ts:269` 锁定（e2e 在 workspace typecheck 之外，本地全绿仍可能红 Playwright CI）。
- 视觉回归：`btn--sm→btn` 在窄屏把 tasks 域按钮 36→44px（`styles.css:17006-17008`），须按 `feedback_frontend_visual_verify_repro` 做 light/dark 最小复现验证；`settings.png` 基线不受影响。
- CSS 层反向锁不可用「改 `.dialog__footer .btn` 强制尺寸」替代组件方案：`tests/workflows-pages.test.tsx:581` 用 `[data-testid="workflow-import-dialog"] .dialog__footer .btn--primary` 定位，`tests/dialog.test.tsx:311`、`tests/dialog-scroll-layout.test.ts:58`、`tests/overlay-ux-inventory.test.ts:263-264` 各锁 `.dialog__footer` 布局——新组件须继续渲染进 Dialog 自带 footer、primary 保留 `btn--primary`，不动 `styles.css`。
- `form-actions__error` 有反向锁：`tests/plugins-page-wiring.test.ts:97,104`、`tests/form-invalid-no-banner.test.tsx:151/172/192/209/229`——迁移时别把 QuestionAuthorForm/WorkflowSyncDialog 的 body ErrorBanner 改成 footer span。
- 占位纠错：`TaskMembersPanel.tsx:160` 是 `.acl-panel__footer`（面板内嵌行，同型 `AclPanel.tsx:246`），渲染在 Dialog **body** 里，属另一类「面板底部动作行」，本次不并入。
- 并发树：`DynamicWorkflowPanel` / `WorkgroupRoom` 属 RFC-187 活跃区；i18n bundle 正被他人改（`git status` M），提交按精确 pathspec。

**优先级：高**（foundBy 2）

---

### 2. Dialog 提交错误的三套展示：footer span / body ErrorBanner / 完全不展示

**现状证据**
- footer 内 `span.form-actions__error`：`QuickCreateDialog.tsx:78`、`RenameDialog.tsx:76`、`WorkgroupMemberCards.tsx:51/89`、`DynamicWorkflowPanel.tsx:318/360`、`WorkgroupRoom.tsx:859`、`WorkgroupTaskConfigDialog.tsx:121`。
- body 顶部整块 `ErrorBanner`：`fusion/FuseDialog.tsx:142`、`repos/BatchImportDialog.tsx:323`、`tasks/QuestionAuthorForm.tsx:115`、`ConfirmDialog.tsx:117`（body 底部）、`agent-ports/AgentPortDialog.tsx:392`（带条件 `role`）。
- 无反馈：`routes/repos.tsx:206` 删除确认 fire-and-forget（页面已另有 `ErrorBanner`，非彻底无反馈）。

**已产生的不一致**
- 同类 4xx 失败在 /memory、/workgroups 是 footer 一行小红字，在 /skills 融合、/repos 批量导入是 body 顶整块红 banner，ConfirmDialog 在 body 底——四种呈现；footer span 还会挤压 `justify-content:flex-end` 的按钮区。

**建议** — 扩展既有 `components/Dialog.tsx`（最小、向后兼容；**不**新造 FormDialog/DialogActions 第二套壳）。
```ts
interface DialogProps {
  // ...既有 props
  error?: unknown;          // Dialog 内部固定渲染在 body 最底部、紧贴 footer 上方
  errorTestid?: string;     // 透传给 ErrorBanner 的 testid
  errorRole?: 'alert';      // 可选：AgentPortDialog 需 role={hasExternalPortAlert ? undefined : 'alert'}
}
```
- Dialog 内部渲染 `<ErrorBanner error={error} testid={errorTestid} />`；8 处 footer span + 4 处 body 裸 ErrorBanner 全部改走 `error` prop；`ConfirmDialog` 透传给 Dialog，保持「失败不关闭」语义。
- 迁移时把 `describeApiError(x)` 直接换成 `error={x}`（ErrorBanner 内部走 `resolveApiError` 三档解析，比 `describeApiError` 全），不要先降级成字符串。
- 不硬编码 `role="alert"`（保留 AgentPortDialog 的条件 role，避免与 ManagedLiveRegion 双重播报）。
- 源码锁：任何含 `<Dialog` 的组件文件不得再出现 `form-actions__error`，显式豁免页内表单（AclPanel/TaskMembersPanel/settings/tasks.new）。

**迁移风险**
- `tests/workgroup-task-config.test.tsx:381` 断言 `err.textContent` 含具体英文且 `not.toContain('workgroup-config-duplicate-member')`；ErrorBanner 的 `ErrorDetails` 可折叠 raw 块可能带上 code，会打红——每个替换点须跑对应测试，必要时抑制 raw。
- testid 逐一转移：`wg-config-error`、`question-author-error` 等；`workgroup-panel-error`(`workgroup-studio-panel.test.tsx:945`)、`wizard-submit-error`(`tasks-new-wizard.test.tsx:911`) 属**面板/向导页非弹窗**，不在范围，误改会红。
- 视觉：错误从 footer flex 行移到 body 底、整块 `error-box` 比 13px 小红字重，须 light/dark 像素核验；`size="sm"` 弹窗高度/滚动区变化。
- repos 双 banner：`e2e/diagnose-repair.spec.ts:404` 用全局 `.error-box` 定位，多一个会触发 Playwright strict-mode 多命中——repos 删除确认这条建议单列、别顺手改 ConfirmDialog。

**优先级：高**

---

### 3. 提交进行中语义（禁关闭 / 禁 Cancel / aria-busy / 防双击）几乎无人遵守

**现状证据**
- `Dialog.dismissDisabled`（`Dialog.tsx:47-49`，行为 `Dialog.tsx:140/260`）30+ 弹窗仅 2 处用：`WorkflowImportDialog.tsx:219`、`WorkflowStarterDialog.tsx:276`。
- 缺口：`WorkgroupTaskConfigDialog.tsx:130`、`ScheduleDialog.tsx:177`、`DynamicWorkflowPanel.tsx:320`、`WorkgroupRoom.tsx:861`、`CentralizedAnswerDialog.tsx:366`、`TaskMembersPanel.tsx:183`（缺 `dismissDisabled` + Cancel `disabled`）；`FuseDialog.tsx:128`（缺 `dismissDisabled`）。
- 防双击各写各的：多数只靠 `disabled` 下一帧渲染，唯 `ConfirmDialog.tsx:33-86` 有同步 `inFlightRef` 竞态骨架。`aria-busy` 仅 6 处。

**已产生的不一致**
- 「转让所有者 / 提交评审驳回 / 保存工作组配置」等不可逆提交在飞行中可被 ESC / 点遮罩关掉，UI 状态与后端结果脱钩；屏幕阅读器 busy 提示不一致。

**建议** — 三步最小正解，**不**新建 `<FormDialog>` 大壳（footer 形态差异会逼出 7+ prop）。
1. 补齐语义：给 6 个缺口 Dialog 加 `dismissDisabled={pending}` + Cancel `disabled={pending}`，FuseDialog 补 `dismissDisabled`，主按钮统一 `aria-busy={pending || undefined}`。
2. 抽公共 hook，`ConfirmDialog` 作首个消费者（行为零变化，由 `confirm-dialog.test.tsx` 兜底）：
```ts
// hooks/useInFlightSubmit.ts —— 提取 ConfirmDialog.tsx:33-86 的竞态骨架
function useInFlightSubmit(): {
  pending: boolean;
  run: (op: () => Promise<void>) => void;   // 单次触发 + inFlightRef/operationRef/mountedRef/openRef 守护
  reset: () => void;                        // reject 后可重试
};
```
3. 源码锁 `dialog-pending-lock.test.ts`：凡渲染 `<Dialog>` 且 footer 出现 `isPending/submitting` 的文件，必须同时出现 `dismissDisabled`。

**迁移风险**
- **最大盲区**：`tests/overlay-ux-inventory.test.ts` 是双向 AST 棘轮（`OVERLAY_CALLSITES` 逐文件登记 Dialog/ConfirmDialog 渲染数 + 末尾 `toEqual`，`isSharedOverlayImport`(`:176-185`) 只认 Dialog/ConfirmDialog 两个名字）——任何新 FormDialog 会让该 manifest 全红且被整片隐形。仅加属性（方案 B）可规避。
- `tests/dialog.test.tsx:114` 锁 dismissDisabled 的 ESC/遮罩/关闭语义；`confirm-dialog.test.tsx:75/117/152/192` 锁 inFlight 全套（单次触发、阻断所有 dismiss、reject 后 reset、新会话清旧错、卸载焦点回退）——抽 hook 属纯重构，须让这几条零改动通过。
- 给 Cancel 加 `disabled` 会让「pending 态点 Cancel 期望关闭」的用例变红，改前 grep 各 dialog 的 `common.cancel` 点击路径。
- testid：8 个主按钮各有专属 testid（`wg-config-submit`/`schedule-save`/`dw-reject-submit`/`centralized-answer-submit`/`members-transfer-confirm`/`batch-import-start` 等），方案只加属性故不受影响。
- `e2e/keyboard-flows.spec.ts` 依赖 Dialog 的 `triggerRef` 焦点回归契约，改 dismiss 路径留意 Playwright。
- 不统一 `pendingLabel` 到 `common.saving`（否则改动 `fusion.submitting`/`scheduled.saving`/`repos.batchImport.*` 可见文案 + 双 bundle 连带红）。

**优先级：高**

---

### 4. 首页四个 section 的三态渲染各不相同（同屏可见的不一致）

**现状证据**
- `InboxPreviewList.tsx`：loading `isLoading && items.length===0`(`:59`)、空态 `<EmptyState size="compact">`(`:82-90`)、错误 `ErrorBanner`(`:62-80`)。
- `RunningTaskList.tsx` / `RecentlyDoneList.tsx`：loading 裸 `isLoading`(`:51`)、错误 `ErrorBanner`(`:54-65`)、空态**裸 `<div className="muted">`**(`:68`)。
- `CapabilityGrid.tsx:102-108`：错误态手拼 `div.home-cap__error.muted` + `role="status"`（灰、非 alert）。

**已产生的不一致**
- 三个并列 section 空态：一个虚线框 EmptyState，两个裸 muted 一行字，高度/边框/留白不同。
- CapabilityGrid 加载失败既不红也不通知读屏；loading 判据一处保留旧数据、两处裸 `isLoading`。

**建议** — 补全已有原语，非无脑套。
- `RunningTaskList.tsx:68` / `RecentlyDoneList.tsx:68` 裸 div → `<EmptyState size="compact" title={t('home.section.empty.running'|'.recent')} />`。若嫌不够紧凑，给 `EmptyState` 加 `size="inline"`（当前只有 `'compact'|'comfortable'`，最小向后兼容扩展）。
- CapabilityGrid 若改 ErrorBanner，注意 **无 `onRetry` prop**，只有 `action`：
```tsx
<ErrorBanner
  error={overview.error}
  message={t('home.section.error.generic')}
  action={<button className="btn btn--xs" onClick={() => void overview.refetch()}>
    {t('home.section.error.retry')}
  </button>}
/>
```
- **但 CapabilityGrid 的 `role="status"` 柔性降级是 RFC-190 有意设计**（失败时六 tile 仍渲染 em-dash 计数 + 下方 compact 静默 retry 行）；直接换红 ErrorBanner 会把「静默降级」变「红色告警」。建议抽一个共享 subdued 原语，或改前与 RFC-190 意图确认——**不能当纯 drift 抹平**。

**迁移风险**
- `tests/capability-grid.test.tsx:182` 用 `findByRole('status')` 锁死当前 `.home-cap__error`；改用 ErrorBanner（`NoticeBanner` tone=error 渲染 `role='alert'`）必红，须同步改测试。
- `homepage.test.tsx:269-277` 用 `/No running tasks|暂无运行中任务/` 锁空态文案——沿用 `home.section.empty.*` key 则安全。
- `tests/empty-loading-callsite.test.ts` 是既有 source-lock，迁移后应扩条覆盖 Running/Recent。
- loading 判据统一属 cosmetic（react-query v5 `isLoading` 已隐含无数据），非回归防护点。

**优先级：中**

---

### 5. 弹窗表单只有 2 处包 `<form>`+`type=submit`，其余 30 处靠 onClick（Enter 行为分叉）

**现状证据**
- 有 `<form>`+submit：`routes/users.tsx:280`、`routes/settings.tsx:1702`。
- 靠 onClick：`QuickCreateDialog.tsx:82`、`WorkgroupMemberCards.tsx:56`、`ScheduleDialog.tsx:180`、`AgentPortDialog.tsx:406`、`WorkgroupRoom.tsx:1351`、`MemoryDialogShell.tsx:108` 等。

**已产生的不一致**
- /users 新建用户、/settings 加 OIDC 输入完按 Enter 会提交；形态相同的「新建工作流 / 成员 / 定时任务 / 端口」弹窗按 Enter 无反应。

**建议** — 扩展 `Dialog`（加 `asForm` 而非新建 FormDialog，规避 overlay 棘轮）。
```ts
interface DialogProps {
  asForm?: boolean;                 // true: body 包进 <form onSubmit>；主按钮 type="submit" form={autoId}
  onSubmit?: () => void;            // pending/!canSubmit 短路
}
```
- 逐弹窗审计「是否真是单目的 create/edit 表单」：ConfirmDialog / MobileNavDialog / RepairChoiceDialog / 列表选择型明确 `asForm=false`，不无脑全量套。
- textarea 注意：原生 form 的 Enter 提交只对 `<input>` 生效、不对 `<textarea>`；WorkgroupRoom deliver 类须确认 summary 是单行 input（Enter 提交）而 detail 是 textarea（Enter 换行）。
- 补 `dialog-enter-submit.test.tsx`。

**迁移风险**
- **P0**：`overlay-ux-inventory.test.ts` AST 逐文件断言 `<Dialog>` count（users/settings/QuickCreate/Schedule/AgentPort/WorkgroupMemberCards/WorkgroupRoom 均在册），只认 Dialog/ConfirmDialog——新建 FormDialog 会全红；扩展 Dialog 则规避。
- `ux-source-ratchets.test.ts` 另锁 `.users-create-form`/`.oidc-form`/`.auth-form` 的 CSS 禁用 + 「文本输入必走 shared form 控件」，迁移勿引入自写 form CSS。
- 现有测试用 `fireEvent.click(getByTestId(...))`（`schedule-save` 等），改 `type=submit` 后 click 仍派发 submit → 可过，但每处须自测 disabled 态与异步 `.then(onClose)` 语义不变。
- footer 文案是逐弹窗 i18n key，主按钮留在调用点则不迁 key。

**优先级：中**

---

### 6. 弹窗提交失败聚焦第一个错误字段：一份导出、一份私有复制、一份没有

**现状证据**
- `components/PluginFields.tsx:25`（`focusFirstPluginFieldError`，字段 id 写死在内）。
- `routes/plugins.new.tsx:63` / `routes/plugins.detail.tsx:265` 复用它。
- `routes/mcps.detail.tsx:98`（另一份实现，硬编码 `timeoutMs→mcp-field-timeout` 特例）。
- `routes/mcps.new.tsx:55`（无聚焦）。

**已产生的不一致**
- /plugins/new 提交非法会跳到首个错误字段，/mcps/new 光标停原地（错误只在下方静默出现），/mcps/$name 用另一份实现。

**建议** — 提取 `lib/form-errors.ts`。
```ts
export function focusFirstFieldError(
  errors: Record<string, string>,
  fieldIdMap: Record<string, string>,   // plugin: PLUGIN_ERROR_FIELD_IDS；mcp: {name/command/url→`mcp-field-{f}`, timeoutMs→'mcp-field-timeout'}
  order?: string[],
): void;
```
- mcps.detail 的 `showValidationErrors` 还负责 `setErrors`+`save.reset()`+`setTab('config')`——只替换其中「find first + focus」切片，保留其余副作用。
- 特例 `timeoutMs→mcp-field-timeout` 收进传入 map，别在原语写死。
- 补 mcps.new；每种 map 加一条「首个 error 字段被 focus」正向测试。

**迁移风险**
- `plugins-split-page.test.tsx:283`（`activeElement===plugin-form-options`）、`mcps-split-page.test.tsx:264`（`activeElement===command`）锁聚焦目标，泛化后须保持不变。
- 无测试按名 import `focusFirstPluginFieldError`、无锁 `mcp-field-timeout`（已 grep），改名/搬迁安全，须手动更新两处 import。
- `AgentForm` 的 `focusJsonField` 是另一套机制，不并入。

**优先级：中**

---

### 7. 表单内联错误文本 4 套平行 class，其中 `.error-text` 在 styles.css 里根本不存在

**现状证据**
- `.error-text`（`grep` 零命中，无任何规则）：`routes/tasks.new.tsx:1467/1502/1531`、`components/tasks/TaskMembersPanel.tsx:156`。
- 同页对照 `.form-input__error`（红）：`components/launch/RepoSourceRow.tsx:109`；表单级 `components/launch/RepoSourceList.tsx:95`。

**已产生的不一致**
- 向导内「分支名非法 / git 身份不成对 / 限额非法」渲染成普通正文（无红色无强调），而同页 URL 非法是红的——同一向导校验失败视觉不一致；`role="alert"` 只挂两套。

**建议** — 复用**已存在**原语（`Field.error` 自 RFC-154 起已落地，`.form-field__error` 已有样式 `styles.css:3763`，内置 `role="alert"`+`aria-describedby`）。
1. 删除死类 `.error-text` 的全部 4 处。
2. workingBranch 分支错误直接用 workingBranch 那个 `<Field error={...}>`（字段级天然对齐）。
3. 跨字段错误（git 身份、限额）与 RepoSourceList banner 复用 `.form-field__error` 或表单级 `.form-actions__error`/`<ErrorBanner>`；必要时抽极薄 `<FieldError>`，但**必须渲染既有 `.form-field__error` 而非新类**。
4. 保留 testid（`wizard-branch-error`/`wizard-git-pair-error`/`wizard-limits-error`/`repo-source-multi-banner`）与 `role="alert"`。

**迁移风险**
- 源码文本锁必须保留：`launch-working-branch.test.ts:61-63`、`launch-git-identity.test.ts:62-63`、`tasks-new-wizard.test.tsx:813/516/960`、`form-invalid-no-banner.test.tsx:149/190`。
- `Field.error` 会用 error 替换 hint（`Form.tsx:63-68`）；某处若既要 hint 又要 error，须保留组级错误 div 而非并入 Field。

**优先级：高**

---

### 8. 字段 `aria-invalid`/`describedby`/`errormessage` 三件套逐字段手接，两套写法产出不同 DOM

**现状证据**
- `aria-invalid={boolean}`（无错也写 `="false"`）：`McpFields.tsx:48/97/135/174`。
- `aria-invalid={undefined | true}`（无错属性缺席）：`PluginFields.tsx:59/79/107`。
- 自渲染错误、不走 Field errorId：`JsonField.tsx:81-90`、`canvas/inspector/InputEdit.tsx:101-104`。

**已产生的不一致**
- 相邻两页同套表单原语产出不同 a11y DOM；`errorId` 在 Field 与控件两处各写一遍，改名必漏。

**建议** — 把控件端 aria 关联收进 `<Field>`（context 注入，非 cloneElement），**分层落地**。
```ts
// Form.tsx: Field 生成 errorId=`${childId}-error`，通过 context 向唯一子控件注入
interface FieldAriaContext {
  invalid: boolean;      // 有 error 时 true；无 error 时一个属性都不写（统一到「属性缺席」语义）
  errorId?: string;      // 注入 aria-describedby / aria-errormessage
}
```
- **A 层（本次，可折叠）**：`McpFields`(4) + `PluginFields`(3)——本就把 errorId 交给 Field，删控件端手写 aria 行。
- **B 层（排除）**：`JsonField`（自渲 `.json-field__error`）、`InputEdit`（aria-errormessage 指向 `input-key-error-${id}`、错误由 InspectorFieldAnchor 渲染）不走 Field errorId 路径，各有 bespoke 渲染，属独立后续工作。

**迁移风险**
- `mcp-field-errors-rfc201.test.tsx:26-27`、`form-invalid-no-banner.test.tsx:207-228`、`plugins-split-page.test.tsx:284-285`、`mcps-split-page.test.tsx:265`、`json-field.test.tsx:71/86`、`input-inspector.test.tsx:132/152` 硬编码 errorId 并同时校验 describedby+errormessage——errorId 必须保持稳定派生值，**改用 `useId` 会全红**。
- `form.test.tsx:26/44/87/103-107` 独立锁 TextInput/TextArea 显式 aria-* 透传（含 `{false}`、combobox 的 aria-controls/activedescendant）——context 只能补默认、不能替换透传。
- cloneElement 不可行：InputEdit 包在 InspectorHistoryBoundary（不透传未知 props）、JsonField 包在 div——必须用 context。

**优先级：高**

---

### 9. 「互斥单选按钮组」五套实现，ARIA 角色与键盘各不相同

**现状证据**
- `Segmented.tsx:142/160`（roving tabindex + Home/End）、`ChoiceCards.tsx:62/76/86`（roving 但缺 Home/End）。
- `LanguageSwitch.tsx:91/103`：`role="radio"` 放进 `role="group"`（无效 ARIA）、全选项 tabbable。
- `WorkflowStarterDialog.tsx:302/312`：声明 radiogroup/radio 却无箭头键和 roving。
- `ConnectionDialog.tsx:455/527`：用 `aria-pressed`（toggle 语义）表达互斥单选。
- 遗留证据：`AclPanel.tsx:193` 注释「RFC-150 迁到 Segmented 顺带修 a11y 漂移」——说明识别过一次未扫干净。

**已产生的不一致**
- LanguageSwitch 整组每项都是 Tab stop 且 AT 读不成一组单选；WorkflowStarterDialog radiogroup 里箭头键失效；ChoiceCards 缺 Home/End；ConnectionDialog AT 读成「按钮，已按下」。

**建议** — 抽 `useRovingRadioGroup`，Segmented/ChoiceCards 共用，站点迁移。
```ts
function useRovingRadioGroup<T>(o: {
  options: { value: T; disabled?: boolean }[];
  value: T; onChange: (v: T) => void;
  orientation?: 'horizontal' | 'vertical';
}): { getOptionProps: (i: number) => { role: 'radio'; tabIndex: 0 | -1; 'aria-checked': boolean; onKeyDown; onClick } };
```
- LanguageSwitch → `Segmented`；WorkflowStarterDialog 卡片目录 → `ChoiceCards`（保留 `firstStarterRef` 首项聚焦，需给 ChoiceCards 补 card-level ref prop）；ConnectionDialog 两处 → `Segmented`（per-option `opt.disabled`）。
- 源码锁：除 `Segmented.tsx`/`ChoiceCards.tsx` 外禁止 `role="radio"` 字面量（其余 `role="group"` 站点是真 group，天然放过）。

**迁移风险**
- `connection-dialog.test.tsx:235` 硬锁 `fanout-role-shard` 的 `aria-pressed==='true'`——迁 Segmented 后变 `aria-checked`，须同 change 改测试；`:107/117/138` 用 `connection-mode-*` testid + `.disabled`，经 `opt.testid`/per-option disabled 保留。
- `language-switch.test.tsx`、`tab-callsite-contract.test.ts:336-343`（锁 Segmented 暴露 radiogroup+radio）受益不受损。
- Starter 有 bespoke `.workflow-starter__catalog/__card`（`styles.css:5943-5971`+响应式），迁 `.choice-cards` 换布局——须 minimal-repro + 明暗双主题像素核验并清理 orphan CSS。
- Starter 从「全 tabbable」变 roving 是可观察行为变化，注意 e2e。

**优先级：高**

---

### 10. combobox/listbox：UserPicker 无键盘支持且 option 结构非法

**现状证据**
- `UserPicker.tsx:140/146/180-184`：0 个键盘处理（Arrow/Enter/Escape 均无）、`<button role="option">` 塞进 `<li>`、`aria-selected` 恒 false、空态 `user-picker__empty`。
- 对照：`Select.tsx:198/288/294/359`、`MultiSelect.tsx:191-224/269/296`（activedescendant 模型 + IME `isComposing` 守卫 + Home/End）。
- `WorkgroupRoom.tsx:439-443` 注释明确「the `<li>` IS the option — no inner button」，与 UserPicker 相反。
- `styles.css:14227`（`user-picker__`）；`rfc099-acl-components.test.tsx:82`（testid 锁）。

**已产生的不一致**
- 同弹窗内 MultiSelect 能上下键选、UserPicker 只能鼠标点；候选项进 Tab 序列；AT 读不出高亮行；空态三套。

**建议** — 抽 `useListboxKeyboard`，但 **UserPicker 原地补齐**（推荐，低风险），不重写成 MultiSelect 薄封装。
```ts
function useListboxKeyboard(o: {
  items: unknown[]; open: boolean; setOpen: (b: boolean) => void;
  activeIndex: number; setActiveIndex: (i: number) => void;
  onCommit: (i: number) => void; searchable?: boolean;
}): { onKeyDown: (e: React.KeyboardEvent) => void };  // isComposing 守卫 + Arrow/Home/End/Enter/Escape
```
- UserPicker：给输入框加 `onKeyDown`（镜像 `MultiSelect.tsx:191-224` 的 activeIndex + `aria-activedescendant`）；`<li><button role=option>` → `<li role=option id=... onMouseDown preventDefault+add>`（去内层 button，修 Tab 序列）；空态复用 `select__empty`。**不动** UserPicker 的 `UserPublic[]` value 契约与 `testidPrefix`。
- WorkgroupRoom 锚点是 `<textarea>`（注释「NO aria-expanded」）+ mention 专属提交——hook 不能假设锚点是 combobox，`aria-expanded` 写入交给调用方；实际其键盘走 `resolveComposerKey`，**本次不动**。
- 若坚持折进 MultiSelect：须先给它补 `asyncSearch`+debounce、`testidPrefix`、`single` 模式、`id→UserPublic` 缓存——改动面大，另立 RFC。

**迁移风险**
- `rfc099-acl-components.test.tsx:82-122` 硬锁 `tp-input`/`tp-option-alice`/`tp-remove-alice` + `aria-expanded='true'` + `.chips-input__row`——原地修可无痛保留。
- `multi-select.test.tsx` / `select-searchable.test.tsx` 大量锁键盘（Enter/Arrow/Backspace/Escape/IME/aria-selected），hook 重构须字节级保持绿。
- `ux-source-ratchets.test.ts:97-108` 的 `INPUT_IMPLEMENTATION_ALLOWLIST` 已白名单三文件，若把输入行抽进共享组件白名单路径会失配——再加一条「就地修、别抽输入行」理由。
- value 契约：UserPicker 进出 `UserPublic[]`（owner transfer 依赖完整对象），与 MultiSelect `string[]` 语义不同；i18n key（`userPicker.*` vs `multiSelect.*`，插值 `name` vs `label`）差异——就地修基本零 i18n 变动。

**优先级：高**

---

### 11. 折叠区块两套实现：原生 `details/summary` vs 手写 `aria-expanded` 按钮（均无 `aria-controls`）

**现状证据**
- `details/summary`：`InspectorSection.tsx:14-15`、`InjectedMemoriesCard.tsx:49-50`。
- 手写 button+`aria-expanded`（无 `aria-controls`）：`RecoverySection.tsx:151`（可见文案切换、`data-testid=task-recovery-toggle`）、`CallChainView.tsx:176`（▾/▸）、`SubagentBlock.tsx:28`（▼/▶）、`reviews.tsx:183`（▾/▸，展开成另一 `<tr>`）；`WorktreeFilesPanel.tsx:230` 又是 ▾/▸。
- 唯二有 `aria-controls`：`WorkgroupMemberGallery.tsx:98` / `workgroups.detail.tsx:906`。

**已产生的不一致**
- 图标字符 ▾/▸ vs ▼/▶ 不统一；可及名称策略（可见文案 vs aria-label vs 浏览器自带）不统一；手写站点缺 `aria-controls`，AT 无法跳到内容；details 版支持「查找页内文本自动展开」、手写版不支持，同页混着。

**建议** — 新建 `components/Disclosure.tsx`，默认内部 `<details>/<summary>`，仅受控场景（reviews 行展开到另一 `<tr>`）降级 button+自动 id 的 `aria-controls`。
```ts
interface DisclosureProps {
  summary: React.ReactNode; children: React.ReactNode;
  variant?: 'default' | 'section';         // section 变体吸收 FormSection
  controlled?: { open: boolean; onToggle: (b: boolean) => void };  // reviews/recovery 走 button+aria-controls
  ariaLabel?: string; testid?: string;     // label 仍由调用方传（各站 collapse/expand key 分化）
}
```
- caret 收敛为单一 `.disclosure__caret`（CSS 出字符，tsx 不再散落 ▾/▸/▼/▶）；native details 路径需 `summary{list-style:none}` + 注入同一 caret class。
- `FormSection.tsx`（RFC-155，已解决 controlled-`<details>` desync + heading-outline）必须**被复用/吸收**为 `variant="section"` 薄封装，别 fork 第三份。
- 排除 `WorktreeFilesPanel:223`（`role="treeitem"` 树语义，ARIA 契约不同）。

**迁移风险**
- `subagent-block-nested.test.tsx` 用 `getByRole('button',{expanded})`——SubagentBlock 若改 `<details>`，jsdom 对 summary 的 role/expanded 暴露不可靠，须**保持 button**。
- `recovery-section-banner.test.tsx` 用 `[data-testid="task-recovery-toggle"]`——testid 原样保留。
- reviews 行展开成独立 `<tr>`、recovery 并排块，结构上不能用 `<details>`，默认路径对它们不成立。
- 各站 aria-label key（`session.expand`/`tasks.structCallExpand`/`reviews.expand`/`tasks.recovery.expand`）无法收敛成单一 key，label 须由调用方传。

**优先级：中**

---

### 12. 整行可点击表格行：两处走共享 `shouldRowNavigate`，distill-jobs 自己手搓

**现状证据**
- 共享守卫：`routes/tasks.tsx:257/264`、`routes/scheduled.tsx:135/139`，走 `lib/row-nav.ts:14 shouldRowNavigate`（排除 defaultPrevented/非左键/修饰键/落在 a,button,input,label,[role=button] 内）+ `.data-table__row`（`styles.css:14719`）。
- 手搓：`MemoryDistillJobsTable.tsx:80/93/113/128`——`<tr onClick>` 无守卫、第一格只有 `<code>{job.id}</code>` 无 `<Link>`、按钮各自手写 `e.stopPropagation()`(`:113/:128`)、inline `style={{cursor:'pointer'}}`(`:93`，全仓唯一 inline cursor)、`.memory-distill-jobs__row:hover` 用 `color-mix(accent 5%)`(`styles.css:12753`)。

**已产生的不一致**
- **真 bug**：distill 行无内嵌 `<Link>`，键盘用户完全打不开详情；Cmd/Ctrl+点击不新标签打开而站内跳转、Shift 多选被吞。
- hover 底色三种（`var(--panel)` vs `accent 5%` vs `accent 6%`）；`.inventory-table` 给不可点行也画 hover 高亮（误导）；行尾 chevron tasks/scheduled 有 `›`、split-card 用 `→`(`ResourceSplitPage.tsx:461`)。

**建议** — 抽 `components/DataTableRow.tsx`。
```tsx
interface DataTableRowProps {
  to: string; params?: Record<string, string>;
  'data-testid'?: string;
  children: React.ReactNode;      // cells
}
// 内部：className="data-table__row"（自带 cursor + var(--panel) hover）
//       onClick 走 shouldRowNavigate + navigate；onKeyDown(Enter/Space)；tabIndex=0
```
- distill 行改用它，第一格 `<code>` 外裹真 `<Link to='/memory/distill-jobs/$jobId'>`（保证键盘可 tab/enter），去 inline cursor 与手写 stopPropagation（守卫 `closest()` 白名单自动豁免行内按钮），删 `.memory-distill-jobs__row:hover`，删 `.inventory-table tbody tr:hover`（无 onClick，纯误导）。
- 保留 `data-testid={`distill-job-row-${id}`}`；tasks.tsx 行结构复杂，wrapper 只接管 `<tr>` chrome、cells 作 children 传入。
- `shouldRowNavigate` 目前无单测——补守卫单测 + distill 行「Enter 可打开详情」回归测试（现有 `distill-job-detail-table-row-click.test.tsx` RFC-043 T6 只用 `fireEvent.click`，覆盖不到 a11y bug）。

**迁移风险**
- 保持 `distill-job-detail-table-row-click.test.tsx` 绿（点击行仍导航、retry/cancel 仍不冒泡）。
- 视觉：删 `.memory-distill-jobs__row` 会把 hover 从 `accent 5%` 统一成 `var(--panel)`——有意统一但属可见变化，PR 点明（或用可选 `rowClassName` 保留）。
- 全仓无测试锁 `row-nav`/`data-table__row`/`distill-job-row` testid/inline style（已 grep），从测试角度安全；CSS 行号已 +155 漂移，按内容 grep 定位。
- `home/task-row.tsx:36` 是 `<button>` 非 `<tr>`，形态不同，单列不强绑。

**优先级：高**

---

### 13. 同构列表行的时间列：一半 `<RelativeTime>`、一半 `new Date(x).toLocaleString()`

**现状证据**
- 相对时间（随 tick 刷新）：`routes/tasks.tsx:355`、`routes/repos.tsx:148/156`、`routes/scheduled.tsx:188/226`、`GalleryCard.tsx:88`、`ResourceSplitPage.tsx:478`、`InboxDrawer.tsx:342`（`components/RelativeTime.tsx`，`repos.tsx:146` 注释「RFC-192 D4/D5 list-layer relative time」）。
- 绝对串（不刷新）：`routes/reviews.tsx:229`（helper `:270`）、`routes/clarify.tsx:97/138`、`MemoryDistillJobsTable.tsx:105`、`MemoryRow.tsx:93`、`TaskDiagnosePanel.tsx:176`、`SkillVersionHistory.tsx:153`。

**已产生的不一致**
- 同一「列表行创建/更新时间」在两组同构页面视觉与刷新行为完全不同；绝对串是 locale 原生格式，未过 i18n 排版。

**建议** — 补完 RFC-192 §96 未做完的迁移，**不改 RelativeTime API**。
- 5 处确凿列表行 → `<RelativeTime ts={...} />`（零新增 prop，绝对值由其自带 `title`/`dateTime` 承担，`RelativeTime.tsx:27` 已实现）：`reviews.tsx:229`（改完 `:269 formatTimestamp` 无调用方，删）、`clarify.tsx:97/138`、`MemoryDistillJobsTable.tsx:105`、`MemoryRow.tsx:93`。
- `TaskDiagnosePanel.tsx:176` / `SkillVersionHistory.tsx:153` 是详情页内嵌表格，按 RFC-191 D4「detail 保绝对」单独提交给用户拍板。
- **不加** `mode='absolute'`（会把「列表层相对时间」单一语义组件变成通用格式器，违其头注释）；详情层裸 `toLocaleString` 另立候选走 `lib/format-time.ts#formatAbsolute`。
- 顺手消相对时间第二 fork：`lib/homepage.ts#formatRelativeTime` 与 `lib/relative-time.ts#relativeTimeToken` 阈值互抄（`relative-time.ts:7` 自承），收敛到 `relative-time.ts`。

**迁移风险**
- `relativeTimeToken` 无天数上限，长寿记录（skill 版本史、memory approvedAt、旧 clarify 轮）会显示「N 千天前」，可读性反变差——**必须一并处理**否则这三处是负收益。
- `e2e/visual-regression.spec.ts` 覆盖 /memory 列表（`memory-chromium-{darwin,linux}.png`），`MemoryRow.approvedAt` 文案变短会改宽度——推前本地跑 /memory 视觉用例，红则双 OS 刷基线。
- `MemoryRow.approvedAt` 有 null 分支（现靠外层守卫），迁移后 RelativeTime 自返 emDash，两层判空须对齐。
- `useNowTick` 须实测为共享粗时钟（注释称 shared）而非每实例 setInterval；注意前端 render-timing flake 体质。
- 全仓无测试锁这几处渲染文本/`<time>` 结构（已 grep）。

**优先级：高**

---

### 14. 筛选状态该不该进 URL 没有统一约定，同页一半进 URL 一半本地 state

**现状证据**
- 进 URL：`routes/tasks.tsx:163`（status chip）、`routes/memory.tsx:52-53/86`（`validateMemorySearch`）。
- 本地 state：`routes/tasks.tsx:85-86`（subject/search）、`routes/reviews.tsx:43`、`routes/clarify.tsx:154`、`ResourceGalleryPage.tsx:141`。

**已产生的不一致**
- /tasks 点状态 chip 改 URL 可分享可后退，改 subject/输入搜索不改 URL——后退会退掉状态却留搜索词；/reviews、/clarify 刷新回默认，/memory 页签可分享。

**建议** — 定「列表页筛选统一进 URL」并抽 `lib/listFilters.ts`。
```ts
function useListFilters<T extends Record<string, unknown>>(o: {
  defaults: T;
  validate: (raw: unknown) => T;    // 沿用 validateMemorySearch「只校验本页 owned key、其余透传」
}): [values: T, setValue: <K extends keyof T>(k: K, v: T[K]) => void, reset: () => void];
// 内部封装 Route.useSearch + navigate({ search: prev => ... })；reset 复用 useFilterReset
```
- tasks/reviews/clarify/gallery/split 全部改接，每页补 URL 深链 + 后退回归测试。

**迁移风险**
- reviews/clarify 的 filter 绑着 `activeFilterRef`+`restoreFilterFocusRef`+filter-keyed `useEffect` 做键盘焦点恢复——URL navigate 是异步的，会与焦点恢复 effect 竞态，helper 须保证 setValue 重渲染时序不破坏焦点恢复，否则 keyboard-nav 测试 flaky/红。
- `memory-tab-deeplink.test.ts` 有源码文本锁 `expect(src).toContain('hash })')`——泛型 helper 替换 memory navigate 会红，除非把 hash 串下去或改测试（印证 memory「全改接」有摩擦，建议收窄）。
- `useFilterReset` 尚不存在（grep 无命中），reset 悬于前序候选。
- 属产品可见行为变更（本地筛选→可深链/可后退），按 CLAUDE.md 属非平凡重构，**需先走 RFC 并获批**。

**优先级：中**

---

### 15. 记忆 scope 徽标手写 7 次，其中 6 次跨命名空间盗用 `memory-row__scope`，第 7 次样式已跑偏

**现状证据**
- `MemoryReviewItem.tsx:25`、`FuseDialog.tsx:180`、`InjectedMemoriesCard.tsx:131`、`MemoryRow.tsx:54`、`MemoryApprovalQueue.tsx:182`、`CandidatesList.tsx:35`、`ScopeAndDedupSnapshot.tsx:49`。
- `.memory-row__scope`（实际 `styles.css:12052`）：`font-xs / padding 2px var(--space-2) / radius-sm / accent 12% / uppercase`；`.injected-memory-row__scope`（`styles.css:12866`）：`11px / 1px 6px / radius 3px / accent 14% / 无大写 / 硬编码`。

**已产生的不一致**
- 同一条记忆的 scope 在 /memory 列表、融合审批、节点会话「注入记忆」卡片里三种样子；注入卡完全绕开设计 token（11px/3px 硬编码）。

**建议** — 新建 `components/MemoryScopeChip.tsx`，自有 `.memory-scope-chip` 命名空间（全用设计 token + 各 scopeType 配色变体）。
```ts
interface MemoryScopeChipProps {
  scope: MemoryScopeType;          // agent | workflow | global | repo ...
  scopeId?: string;                // 可选后缀，吸收 injected-memory-row__scope-id
  size?: 'sm' | 'xs';              // 纯字号，唯一漂移回流口
  testid?: string;                 // 保留 MemoryApprovalQueue 的 memory-candidate-scope-${id}
}
```
- 7 处全替换；删 `.injected-memory-row__scope*`，`.memory-row__scope*` 重命名进新命名空间杜绝跨模块借用。
- 保留 `InjectedMemoriesCard` 的 `t()` `{ defaultValue: memory.scopeType }` 兜底语义。

**迁移风险**
- 全仓无 `*.test.tsx` 对这些 class 名/testid 做源码文本锁（已核实），重命名安全；但 `injected-memories-card.test.tsx:98-103` 依赖行内 chip 渲染 `memory.scope.*` 文本、靠 tagName 与 h4 组标题区分——新组件须继续渲染 `t('memory.scope.${scope}')` 原文本。
- 统一后注入卡徽标外观必变（已知代价），须过视觉基线。
- scopeType 配色目前仅 `.memory-row__scope--global` 一个覆盖、injected 变体一个没有，合并时补齐各变体到新命名空间（顺带修注入卡 global 配色跑偏）。

**优先级：高**

---

### 16. 角色/状态指示器四种画法并存，且 `chip--local`/`chip--remote` 是根本不存在的 CSS 类

**现状证据**
- `routes/mcps.tsx:83`：`.chip--local`/`.chip--remote`（`grep` 零命中，从未生效）；`.source-chip`(`styles.css:1053`) 定义了但全仓零使用（死 CSS）。
- `routes/users.tsx:163-164/207`：彩色大写 chip，渲染裸 `{u.role}`/`{u.status}`（未翻译）；status 部分裸文字。
- `routes/account.tsx:100-104/619`：8px 圆点+小写文字（DotValue），PAT 状态用 StatusChip。
- `routes/fusions.detail.tsx:127`：`.chip--fusion-*`（零命中）。

**已产生的不一致**
- MCP 的 local/remote chip 与旁边 disabled chip 长得一样（作者意图的区分色从未生效）；同一 role/status 语义在 /users 是彩色大写 chip、/account 是圆点+小写、PAT 是 StatusChip、/users status 是裸文字——四种视觉。

**建议** — role/status 迁 `StatusChip`（`success/warn/danger/info/neutral + size + withDot`），删 `role-chip`/`account-dot*`/`source-chip` 三组 CSS，但**先定 value→kind 映射**。
- 映射示例：`local→neutral`、`remote→info`、`admin→warn/info`、`active→success`、`disabled→neutral`、`revoked→danger`；纯类别型 local/remote 也可选择**补齐真实 `.chip--local/.chip--remote` 语义 modifier** 而非强塞 StatusChip（避免语义扭曲）——这是一处需实现时明确的设计取舍。
- 源码锁：按对应 union 类型成员（`McpType='local'|'remote'`、fusion status 枚举）枚举生成期望 `chip--` 类名集合再断言其在 styles.css 存在（模板插值 `chip--${x}` 静态不可解）。
- 迁移须路由到既有 i18n key（`users.roleOption.*`、`fusion.status.*`），不把裸枚举文本带过去。

**迁移风险**
- StatusChip 五 kind 是固定严重度语义，role/mcp-type/fusion-status 是任意分类枚举，映射需 arbitrary 决策；account 可能需 borderless variant = 公共组件 API 膨胀——「并进 StatusChip」是被质疑的一面。
- 全仓无测试锁 `role-chip`/`account-dot`/`source-chip`/`chip--fusion`/`chip--local`/`DotValue`（已 grep），删 CSS 安全；dead class 是优雅降级（基类 `.chip` 仍渲染）。
- 新 guard test 按仓库 `*-source.test.ts` 文本断言范式写，顶部注释写明锁哪类回归。

**优先级：高**

---

### 17. success/warn/danger 语义色各页各写一套 hex，同一「成功绿」有 5 种取值

**现状证据**（真实行号见 correctedOccurrences，styles.css 已漂移）
- 成功绿：`#2da44e`（validation-panel/canvas done/status-badge 前景）、`#16a34a`（cross-clarify/status-dot/session-block--assistant）、`#1f883d`（status-badge 背景/light 前景）、`#1a7f37`+`rgba(46,160,67)`（mcp probe）、`#1b6d34`/`#66d17a`（`styles.css:9162-9163`/`9518-9519` agent-import/skill-import 覆写 `--success`）。
- 警告黄：`#d97706`、`#b45309`、`#bf8700`/`#d4a72c`、`#844700`/`#ffc25c`；`styles.css:8328-8330` 引用 `--amber-bg/-fg/-border` 但 `:root` 从未定义。
- 既有三元组 token：`styles.css:31-81`（`--success/-fg/-fill/-bg/-border`、`--warn/…`、dark+media override 于 `110-172`）。

**已产生的不一致**
- 同一状态语义在画布、表格 chip、探测 chip、导入流呈现四种绿/黄，dark 模式差异更明显。

**建议** — 迁移裸 hex 到**既有** token（提案原文「新建 token」有误——三元组已存在）。
- 全部裸 hex success/warn 调用点 → `var(--success)`/`var(--warn)`(+`-bg`)；删 `agent-import/skill-import` 冗余 `--success/--warn` 覆写（`9162-9180`/`9518-9532`，其值与 `:root` `--success-fg` 逐字相同、纯冗余重声明，非更深对比度色）。
- 删 `8328-8330` 幽灵 `--amber-*`，改 `--warn-bg/--warn/--warn-border`。
- 仅在**实测**证明小 chip（11px）在 tinted 底上对比度不足 AA 时才引入 `--success-strong/--warn-strong`，否则不加。
- 源码锁：除 `:root`/`[data-theme]`/`@media` token 定义块外禁止裸 success/warn hex，allowlist 放行 shadow rgba、`--rfc027-accent`、gradient tint、canvas 节点 `data-status` 状态色等非语义 hex。

**迁移风险**
- 多数裸 hex 无 dark 变体，接到 `var(--success)` 后 dark 下变 `#66d17a`，是可见变化，须 light+dark 双模式截图核验。
- allowlist 若过宽会误红约 40 种合法非语义 hex（canvas 状态色 `6936/7242`、按钮 hover `#204a8b/#2759a5` 等），须收窄到语义色族。
- 若改用 `--success-strong` 独立变量，须逐个重指所有 `var(--success)/var(--warn)` 后代消费选择器，漏一个 11px chip 掉回不过 AA（最大隐性 footgun）。
- 3 个测试用 readFileSync 读 styles.css（只锁 overflow/text-overflow，不锁颜色），改语义色不会红；styles.css 常被并发改，精确 pathspec。

**优先级：高**

---

### 18. structure-graph 的 change-type 配色三种走 token，唯独 modified 写死 `#d99100`

**现状证据**（按类名定位，行号已漂移）
- `.structure__delta--modified`、`.structure__badge--modified`、`.sg-card--ct-modified`、`.sg-card__member--ct-modified`、`.structure-graph__swatch--ct-modified`（background+border 两行）、`.structure__chip`、`.structure__severity--risky` 均 `#d99100`。
- 对照：added=`var(--success)`、removed=`var(--danger)`、renamed=`var(--accent)`（跟随主题）。
- 双事实源：`src/lib/structureGraph.ts` 的 `changeTypeColor` 喂 xyflow MiniMap `nodeColor`。
- `--warn`/`--warn-fg`（`styles.css:68-69`，亮 `#844700`/暗 `#ffc25c`）。

**已产生的不一致**
- 四态同级配色里 added/removed/renamed 随 token 切换、modified 钉死中调琥珀——亮色下最亮、暗色下最暗，两主题都「不合群」（token 化做一半）。

**建议** — modified 的 `#d99100` 全部 → `var(--warn)`，tint 背景用 `var(--warn-bg)` 或 `color-mix(in srgb, var(--warn) N%, ...)`。覆盖全部 9 处（含候选漏掉的 swatch 家族、`.structure__chip`、`.structure__severity--risky`）。
- **同步改 `src/lib/structureGraph.ts#changeTypeColor('modified')` 返回值**（否则卡片/minimap 撕裂），并把 `tests/structure-graph-minimap.test.tsx:21` 的 `=== '#d99100'` 断言改成 `'var(--warn)'`。
- 「进一步统一 structure-graph/DiffViewer(`.diff__add=#2da44e`)/markdown-diff(`.diff-ins`) 三套 diff 配色」事实成立但属跨 3 子系统大重构——**拆独立 RFC**，不塞进本次。

**迁移风险**
- 同时改亮/暗（`--warn` 亮 `#844700` 深棕/暗 `#ffc25c` 都不等于 `#d99100`）——light 下从亮金变深棕肉眼可见，须 light+dark 双主题核对图例 swatch/卡片边框/成员文本对比度。
- minimap 走 `nodeColor` 回调返回 CSS var 字符串，SVG fill 可解析，无渲染限制。
- 全仓无其它测试锁这些 class；styles.css 行号漂移按 class 定位。

**优先级：中**

---

### 19. 校验计数徽标（`! n` / `⚠ n` + aria-label 拼装）节点版与边版各写一份且已漂移

**现状证据**
- 节点版：`NodeValidationBadge.tsx:9/14/16/19`（error/warning 各自带色 `canvas-node__validation-error/-warning`，两段无分隔符），已被 7 个节点组件复用。
- 边版：`WorkflowCanvasEdge.tsx:59/63/80`（一整个 span、无分色、中间硬塞 `' · '`）。
- `styles.css:6679/6695`（`.workflow-edge-validation` 整段 `color:var(--danger)`）。

**已产生的不一致**
- 同一校验结果在节点与边上呈现不同（节点分色无分隔、边单色带 `·`）；aria-label join 逻辑逐字复制，加第三档（info）必漏改一边。

**建议** — **泛化已有 `NodeValidationBadge`**（节点侧已无重复，缺陷只在边内联拷贝），加三个透传 prop，比 `placement` 枚举更轻。
```ts
interface NodeValidationBadgeProps {
  errorCount: number; warningCount: number;
  as?: 'div' | 'span';        // 边侧用 span
  className?: string;         // 边侧定位类
  style?: React.CSSProperties;// 边侧 transform / z-index / pointer-events:none
}
```
- 唯一实现 aria-label 拼装 + 分色 span 结构，节点与边共用。统一时须显式决定 canonical 形态（两枚分色 pill 无分隔 vs 单 pill 带 `·`），会改变边徽标观感。
- 重构须一并处理 `.workflow-edge-validation` 的整段 `color:var(--danger)`（会盖掉 warn pill 颜色）。

**迁移风险**
- `workflow-canvas-surface.test.tsx:41,48` 用 `.canvas-node__validation` 类 + textContent `/2.*1/` 锁节点侧——抽取须在节点侧保留该 wrapper 类。
- xyflow 约束：边徽标必须留在 `EdgeLabelRenderer` 内、靠 transform 定位、带 `pointer-events:none`+`nodrag/nopan`——共享组件只渲染内层 pill，wrapper 留在 caller。
- 统一渲染改边徽标观感（warning 变 `--warn-fg`、`·`→双 pill）——无 screenshot baseline，须手动 light+dark 核对；`e2e/workflow-editor.spec.ts` 只碰 `workflow-validation-summary`，不受影响。
- 全仓无测试锁 class/文本/aria-label（已 grep）。

**优先级：中**

---

### 20. 「脏/陈旧/出错/结果未知」→ TabBar/PageSectionNav badge 推导被复制五份且规则不一致

**现状证据**
- `routes/skills.detail.tsx:244/270`、`routes/settings.tsx:150`、`routes/skills.new.tsx:122`。
- `TabBar.tsx:319`（`tab.badgeTone ?? 'neutral'`）；PageSectionNav 侧无 `--neutral` 修饰类（仅 `--attention/--danger`）。

**已产生的不一致**
- settings 对「仅 dirty」传 `badgeTone: undefined`、skills 传 `'neutral'`；skills.new 完全没有 stale/outcomeUnknown 分支（草稿陈旧或写入结果未知不显示提示），而同路由树的 skills.detail 会显示；settings **无 submitError 分支**（真实 bug），skills.detail 把 error 与 outcomeUnknown 都映射 danger；aria-label key 各取各的。

**建议** — 抽 `lib/draft-badge.ts` 纯函数，**只面向 EditScope 消费者**。
```ts
function draftBadge(
  s: { dirty: boolean; staleRemote: boolean; ambiguousSubmit: boolean; submitError: boolean },
  ariaKeys: { outcomeUnknown: string; error: string; stale: string; dirty: string },  // key 注入，不硬编码
  t: TFunction,
): Pick<TabDef, 'badge' | 'badgeTone' | 'badgeAriaLabel'> | {};
// 固定优先级 ambiguousSubmit > submitError > staleRemote > dirty；glyph !/!/!/•；tone danger/danger/attention/neutral
```
- 改造点：`skills.detail:244/270`、`settings.tsx:150`（由此**补上缺失的 submitError→danger 分支**，修 bug）；`skills.new:122` 用薄适配器把 `{create.error, dirty}` 归一后调用。
- **明确排除**：`AgentForm.tsx:258/273`（numeric count 徽标，另属一类）、`skills.detail:219` history 导航阻断徽标（`dirty→attention` 与固定表冲突，如需复用另设 `navBlockBadge`）。
- TabBar 与 PageSectionNav 各导 `spreadDraftBadge` 便捷包装（各自沿用本组件 class 命名，`--neutral` 在 PageSectionNav 侧不存在需统一），纯函数单测锁优先级表。

**迁移风险**
- aria-label key 按上下文分化（`skills.saveOutcomeUnknown`/`settings.outcomeUnknown`/`editor.draftStatus.phase.error`），硬统一成单套 `draftStatus.*` 会丢语义——须 key 注入。
- `agent-form-sections.test.tsx:115/128/129` 锁 AgentForm 端口 badge 的 `data-tone`/aria-label——绝不能动 `AgentForm.tsx:258`；`tab-bar.test.tsx` 锁 TabBar badge DOM。
- 头号漂移「settings undefined vs skills neutral」经核实为非 bug（两渲染端默认皆 neutral），真正动机是 settings 漏 submitError——抽取时勿以此为卖点。
- 未发现测试锁具体 aria 文案（grep 空），收窄后四处迁移不撞源码锁。

**优先级：高**

---

### 21. 「正在输入时不劫持单键热键」守卫的四种拼法

**现状证据**
- `reviews.detail.tsx:368-369/396`（`document.activeElement`，漏 contentEditable；`:396` 拦全部修饰键）。
- `MultiDocReviewView.tsx:260-261`（走 `multiDocHotkeyAction` 内部修饰键退出）。
- `ReviewDocPane.tsx:497-498/488-505`（`document.activeElement`，漏 contentEditable；J/K **完全不查修饰键**，Cmd+J 会同时跳评论）。
- `QuestionForm.tsx:224-226`（`e.target` + `isContentEditable`，但漏 SELECT）。
- `WorkflowCanvas.tsx:288`（第 5 处）。

**已产生的不一致**
- 前三份漏 contentEditable、QuestionForm 漏 SELECT；修饰键规则各走各的，`ReviewDocPane` 的 Cmd+J 会误触跳转。

**建议** — 抽 `lib/keyboard/hotkeys.ts`，拆两个**语义独立**纯谓词。
```ts
// 可无差别应用到全部四处，一次修掉漏 contentEditable / 漏 SELECT
export function isTypingTarget(e: KeyboardEvent): boolean;
//   同时看 e.target 与 document.activeElement，覆盖 INPUT/TEXTAREA/SELECT/isContentEditable/[role="textbox"]

// 不能作为统一入口，须按站点放置
export function isPlainKey(e: KeyboardEvent): boolean;  // 无 meta/ctrl/alt/shift
```
- `isPlainKey` 只能守 A/R/I 分支（`reviews.detail.tsx` 自己要 Cmd+1/2/3 切粒度，`:376`）；`ReviewDocPane` 的 J/K **新增** `isPlainKey` 守卫修 Cmd+J 回归；`MultiDoc` 已由 `multiDocHotkeyAction` 内建修饰键退出。
- 保留 `lib/review/multiDocHotkeys.ts`（RFC-090 已测纯 oracle），只把其修饰键检查换成复用 `isPlainKey`，**不折进新原语**。
- 单测锁两条：contentEditable 聚焦时 `isTypingTarget` 为 true；Cmd+J 下 ReviewDocPane 不 jumpComment。

**迁移风险**
- 行为变更（有意）：review 正文走只读 `<Prose>`、全仓 components/ 除 canvas 外无 contentEditable/role=textbox（已 grep），扩守卫不会误伤阅读导航；`ReviewDocPane` Cmd+J 修正属对现网发布行为的有意修正，PR 说明 + 新测试锁定。
- 四个 handler 无任何 keydown/DOM/源码文本锁，连 oracle 也无测试引用（grep 零命中）——碰撞风险低但**零安全网**，新单测是唯一防护。
- WorkflowCanvas 第 5 处：抽的是纯导出函数、无节点渲染约束，保留 re-export 即可。
- 测试跑 vitest（非 bun test）。

**优先级：高**

---

### 22. 主/次操作按钮顺序在相邻阶段反了，缺统一「操作条」原语

**现状证据**
- `skills/ImportZipPanel.tsx:563`（review 步：返回(次)→导入(主)）、`:814`（result 步：继续导入(主)→返回列表(次)）。
- `ConfirmDialog.tsx:98`（主按钮在最右约定）。
- CSS：`.skill-import__action-buttons`(`styles.css:9433-9445`) 与 `.skill-import__result-actions`(`:9624`) 两条只差 `justify-content`。

**已产生的不一致**
- ZIP 导入向导 review→result 连续两屏主按钮左右横跳，与 ConfirmDialog「主在最右」相反。

**建议** — 先修 bug（`ImportZipPanel:814` result 步 DOM 序改成 次(`zipReturnList`)→主(`zipContinue`)），再抽轻量 `components/ActionBar.tsx`。
```ts
interface ActionBarProps {
  primary: { label: string; onClick: () => void; tone?: 'primary' | 'danger'; disabled?: boolean; busy?: boolean; testid?: string };
  secondary?: { label: string; onClick: () => void; disabled?: boolean; testid?: string }[];
  align?: 'end';
}
// 内部固定 DOM 序 secondary→primary，复用同一条 .action-bar flex（含 720px 断点降级）
```
- 合并现 `.skill-import__action-buttons` 与 `.skill-import__result-actions`（保留 result 独有 padding-top 与 720px column 降级）；`ConfirmDialog` footer 可选内部复用同一 ActionBar，让「主永远最右」只有一处定义。
- 范围收窄：`skills.new:99` 已用 PageHeader.actions 单主按钮，不纳入。
- 补一条锁定 review/result「主按钮恒为最后一个/最右」的断言。

**迁移风险**
- `skill-import-responsive.test.ts:30-37` 断言 mobile media query 必须出现 `.skill-import__actions` 与 `.skill-import__result-actions`——改名会红，须保留 class 名或同步改测试。
- `import-zip-panel.test.tsx` 用 `getByRole('button',{name})` + `getByTestId('zip-commit-button')` 并断言 disabled(`:359/382/415`)——ActionBar 须透传 label（维持 role name）、testid、per-button disabled。
- i18n key（`skills.zipContinue/zipReturnList/zipBack`）双语已存在，保持不变。
- CSS 合并保留 720px column 降级避免视觉回归。

**优先级：中**

---

### 23. 字节数格式化两套实现，单位与精度已不一致（KB/MB vs KiB/MiB）

**现状证据**
- `UploadPicker.tsx:91/103`（`humanSize`，KB/MB、GB 档 2 位小数、缺 NaN/负数保护）。
- `WorktreeFilesPanel.tsx:35`（`formatBytes`，KiB/MiB、恒 1 位，已导出被 `tasks.preview.tsx:26` 复用）。
- `FileDropzone.tsx:130`（`formatShortBytes`，去尾零）。
- 内联 MB 换算：`routes/settings.tsx:837`。
- 调用点：`AgentImportDialog.tsx:315/319`、`skills/ImportZipPanel.tsx:152/366/458/694`。

**已产生的不一致**
- 同一 2048 字节：上传选择器「2.0 KB」、worktree 面板/Markdown 预览「2.0 KiB」；GB 档 humanSize 2 位、formatBytes 1 位。

**建议** — 新建 `lib/format-bytes.ts` 唯一实现，统一二进制单位 B/KiB/MiB/GiB。
```ts
export function formatBytes(bytes: number): string;  // 建议去尾零版（1 KiB 而非 1.0 KiB），含 NaN/负数保护
```
- 删除 `UploadPicker.humanSize`、`WorktreeFilesPanel.formatBytes`、`FileDropzone.formatShortBytes` 三份，全部 import 新模块（不保留 re-export，仓库「删除优于 deprecate」，import 点仅 4 文件）。
- `settings.tsx:837` 内联 MB 换算一并替换（改后 MB/2 位→MiB/1 位，可接受的可见文案变化，若不动需 PR 显式说明）。
- **必须先拍板小数口径**：现存两派「恒 1 位」vs「去尾零」，建议去尾零，并把 `worktree-files-panel.test.tsx:103-109` 的 6 条断言同步改写。

**迁移风险**
- 测试硬锁两套输出且互斥：`worktree-files-panel.test.tsx:103-109`（`1.0 KiB`/`1.0 MiB`/`3.0 GiB` 保尾零）、`file-dropzone.test.tsx:137-141`（`64 MiB` 去尾零）、`import-zip-panel.test.tsx:203`（alert `64 MiB`）——任何统一策略必红其中一套，改前同步更新。
- 两测试从组件文件 import 函数（`worktree-files-panel.test.tsx:29`、`file-dropzone.test.tsx:7`），删 export 会编译失败——须同批改全量命中集。
- 前端测试跑 vitest（非 bun test）。
- 无 i18n key 迁移（单位是插值 value，MB 字面量在 JSX 里）；settings.tsx 处于未提交态，精确 pathspec 并检查并发 hunk 引用。

**优先级：中**

---

### 24. 横向溢出渐隐提示两套实现已漂移，第三个可滚动容器干脆没有

**现状证据**
- `TableViewport.tsx:65/104`（`.table-viewport__hint`，`styles.css:3223`，24px、`var(--text)` 18% 雾，120ms 淡入）。
- `TabBar.tsx:127/293`（`tabs-viewport`，`styles.css:4576`，22px、背景实色，硬切）。
- `.page-filter`（`styles.css:2408`，第三个横向滚动区，无任何提示；RFC-192 注释 `:2433` 记录过同区域溢出）。

**已产生的不一致**
- 渐隐宽度 24 vs 22px；渐变色「文字色 18% 白雾」vs「背景实色」；一个 120ms 淡入一个硬切；.page-filter 用户看不出右侧还有筛选项。

**建议** — 抽 CSS + JS 两层（原提案只提 CSS，JS 也已分叉）。
```ts
function useOverflowEdges(ref: React.RefObject<HTMLElement>): {
  hasOverflow: boolean; overflowStart: boolean; overflowEnd: boolean;
};  // 统一 {clientWidth,scrollLeft,scrollWidth} 测量 + 0.5 epsilon + ResizeObserver(scroller & 内容双观察) + onScroll 重测
```
- 抽 `.scroll-fade` CSS（`::before/::after` + `[data-overflow-start/end]` 切 opacity），参数化 `--scroll-fade-w` 与遮罩色 var；table-viewport / tabs-viewport 两处必接。
- 遮罩色**不要单方面定 `var(--bg)`**——RFC-198 TableViewport 有意选 `var(--text)` 18% 雾感，统一色须走设计拍板。
- `.page-filter` 渐隐盖在 `.segmented` 交互按钮上可能遮可点性，设为 **opt-in**，核心收益是 table/tabs 去重。

**迁移风险**
- `table-viewport.test.tsx` 硬断言 className 精确等于 `'table-viewport table-viewport--md'` + `.table-viewport__scroller/__hint` + hint 的 `aria-hidden` + children API=原生 `<table>`；`tab-bar.test.tsx`、`tabs-retrofit-grep.test.ts`、`data-table-callsite.test.ts` 锁 TabBar variant 形态；`e2e/visual-regression.spec.ts` 有截图基线——抽取**只动 JS 内部**、保留全部现有 class 与 `data-overflow-*` 属性。
- TabBar 带滚动按钮(`tabs-viewport__scroll`)+44px grid，抽 hint 须与按钮布局解耦、与 TableViewport 强行同壳会 config 膨胀。

**优先级：中**

---

### 25. 暗色覆盖只写 `:root[data-theme='dark']`，漏 `@media` 兜底——默认 `theme='system'` 下永不生效

**现状证据**
- `hooks/useTheme.ts:90/93/96`：`theme==='system'`（产品默认）时**主动 `removeAttribute('data-theme')`**，故 `:root[data-theme=...]` 在默认配置下恒不匹配。
- 漏写块（真实行号见 correctedOccurrences，已下移约 135-155 行）：react-flow minimap-mask（`styles.css:6349/6352`）、comment-anchor 三条（`8798/8819/8823/8827`）、status-badge 反向写法（`11531/11554/11560`，base 给暗色、靠 `[data-theme='light']` 压暗）。
- 正确双写参照：`styles.css:110/145`、`8948/8956`、`9023/9035`、`9380/9386`、`11036/11051`。

**已产生的不一致**（本专项最高价值已发生 bug）
- 默认配置+系统暗色：review comment-anchor 仍是亮色强黄块、minimap 遮罩仍 `rgba(0,0,0,0.25)`（暗底几乎看不见视口框）。
- status-badge 反向写：默认配置+系统亮色的用户拿到亮底浅绿/浅黄 chip，对比度掉到 AA 以下（而 `styles.css:11375` 注释还写「stay readable on both themes」）。

**建议** — 先做最小正确修复 (b)，(a) 作为可选大 RFC，**不在共享树一把梭**。
- **(b)**：给三个漏写块补 `@media (prefers-color-scheme: dark) :root:not([data-theme]) X` 孪生——minimap-mask 补暗色 fill 0.5；comment-anchor 三条补 dark 值（0.18/0.32/0.45+shadow）；**status-badge 因是反向写法，兜底须写成 `@media (prefers-color-scheme: LIGHT) :root:not([data-theme])`** 把三色压到 `#1f883d/#9a6700/#b81f24`（方向与其余块相反）。
- 补源码守卫测试：每个含 `[data-theme='dark']` 的选择器须有对应 `:not([data-theme])` 的 `@media(dark)` 孪生；**且同样覆盖 `[data-theme='light']` 方向**（配 `@media(light)` 孪生，否则漏 status-badge 这类反向块）。白名单 `:110` 调色板双写块，避免对 light-only 规则误报。
- **(a)**（index.html 内联 bootstrap 无条件 setAttribute + useTheme 永不 removeAttribute + 删所有 `:not([data-theme])` 兜底）推翻 `useTheme.ts:91` 注释「/auth 页无 config、React 挂载前靠 @media 兜底」语义，改动面大——单独立 RFC 走确认。

**迁移风险**
- 行号全部过时（并发未提改动下移），按 correctedOccurrences 真实行号定向改。
- grep 未发现测试锁 useTheme/resolveTheme/data-theme DOM 行为，改 JS 安全；仓库已有 3 个 styles.css 源码扫描测试，(b) 守卫测试须同样读 styles.css 并白名单调色板双写块。
- styles.css 在 prettier 范围，改动须过 format:check；CLAUDE.md 硬约束：守卫测试是本修复的一部分。

**优先级：高**

---

### 26. readonly-banner 引用三个从未定义的 `--amber-*` 变量，永远落到亮色字面量兜底

**现状证据**
- `styles.css:8340/8341/8342`：`var(--amber-bg, #fff4d6)`/`var(--amber-fg, #5b3a00)`/`var(--amber-border, #f0c674)`——全仓 grep `--amber-*` 仅这三行，`:root` 从未定义，恒走兜底字面量。
- 调用点：`MultiDocReviewView.tsx:480`、`reviews.detail.tsx:696`。

**已产生的不一致**
- /reviews/$nodeRunId?version=… 只读横幅在暗色主题下是整条 `#fff4d6` 奶油色块 + `#5b3a00` 深棕字，与 `#15181d` 页面强烈撞色（「白砖」回归）；同语义别处走 `--warn-*` 或 `NoticeBanner`。

**建议** — 删私有 chrome，改用既有原语。
- 删 `.readonly-banner`（`styles.css:8339-8350`），两调用点改用 `<NoticeBanner tone="warning">`（枚举是 `'warning'` 非 `'warn'`），返回链接放进其 `action` 槽。
- 若保留独立 class，三条声明改 `background: var(--warn-bg); color: var(--warn-fg); border-color: var(--warn-border)`（两主题均已定义）。
- 补守卫测试：解析 styles.css 收集所有 `var(--x, fallback)` 的 x，断言每个 x 在文件内有 `--x:` 定义，堵死「幽灵变量+亮色兜底」暗色回归。

**迁移风险**
- `tests/reviews-detail-readonly-source.test.ts` 源码文本硬锁 `<div className="readonly-banner"`——换 NoticeBanner 会红，须改断言。
- `multidoc-historical-round.test.tsx:264` 用 `getByRole('status')` 断言 banner 文案（依赖 NoticeBanner 无 ManagedLiveRegion 时渲染 `role=status`，同文件 `:297` 已依赖，契约可保）。
- styles.css 处于未提交编辑态，按 class 名/内容重新定位；无 i18n key 重排（`reviews.historicalBanner`/`backToCurrent` 保留）。

**优先级：中**

---

### 27. prefers-reduced-motion 覆盖不全：部分无限动画被降级，共享 spinner 与画布连线脉冲却一直转

**现状证据**
- 已降级（`animation:none`）：hero 三连(`styles.css:2243`)、canvas-node running/awaiting 脉冲(`7286/7327`)、status-dot-pulse(`16926`)。
- **未降级**：`canvas-connect-preview-pulse`(`7500`)、`canvas-connect-reuse-pulse`(`7521`)、`rfc035-spin`(`11755`，`.loading-state__spinner` 动画，`LoadingState` 被 60 个文件使用)。

**已产生的不一致**
- 11 个无限动画只有一半被 `prefers-reduced-motion` 关掉；App 主加载指示器在 reduced-motion 下仍持续旋转；同类「无限循环动画」在无障碍降级契约上被拆成两派、判定标准不统一。

**建议** — 建立单一降级契约，优先「源码层测试锁」方向。
- 新增测试：`styles.css` 中每个 `animation: … infinite` 的选择器，要么在某 `@media (prefers-reduced-motion: reduce)` 块里有对应覆盖（`animation:none` / `animation-play-state:paused` / 放缓 `animation-duration` / inline 注释豁免 **四种形式均算已覆盖**），否则报红。按 **animation-name 映射**匹配（非选择器文本，避免措辞不同误判）。
- 据此收口：`.canvas-node__port-row--preview .canvas-node__handle`(`7500`) 与 `--reuse-target`(`7521`) 补 reduced-motion 块置 `animation:none`（连线脉冲纯装饰）；`.loading-state__spinner`(`11755`) 因旋转型 spinner 属无障碍惯例可豁免，二选一：reduced-motion 块换低速旋转（如 2.4s）或就地加注释显式豁免——**不要盲目 `animation:none`**。

**迁移风险**
- spinner 强行 `animation:none` 反而不妥，修复须允许显式降速/静态/注释豁免而非一刀切；测试须把 spinner 的合法「低速非 none」判为已覆盖。
- grep 未发现测试锁 useTheme 相关；连线脉冲挂在 xyflow handle 上但只加 CSS 规则、不改 xyflow 行为，无风险。
- 纯前端 CSS + vitest 范畴；无 i18n。

**优先级：中**
---

## 8. 落地建议（RFC 拆分与迁移顺序）

建议拆成 **5 个 RFC**，按依赖顺序落地。每个 RFC 都遵守 CLAUDE.md 的两条硬规则：① 优先"最小扩展既有组件"而非新建/ fork；② 抽取的同时**配一条防漂移锁**（源码文本断言或 grep 锁），否则视为只减代码量、不算交付。

### RFC-A：三态闸门 + `ErrorBanner.onRetry`（P0，先做）
- **范围**：给 `ErrorBanner` 加 `onRetry?: () => void`（有则渲染标准"重试"按钮，`common.retry`，`.btn .btn--sm`）；新建 `<QueryState query={...} empty={...}>{data => …}</QueryState>` 封装 `isLoading→LoadingState / error→ErrorBanner(onRetry=refetch) / 空→EmptyState / 有数据→children`。
- **迁移**：先切 15+ 个"逐字三态"最重的列表/详情页；`toLocaleString` 与裸 `muted` 空态顺带收编。
- **验收/锁**：新增 `<QueryState>` 单测（四态快照）；grep 锁"新代码里 `className=\"muted\"` 不得直接承载 `t('…empty')`"（白名单式）；`ErrorBanner` 加 `onRetry` 后补一条断言"重试按钮走 `common.retry`"。
- **测试**：vitest（前端不在 `bun test` 覆盖内，见 [风险]）。

### RFC-B：语义色 token 收敛 + 暗色真实 bug（P0，可与 A 并行）
- **范围**：把散落的 success/warn/danger hex 收敛到 `--success/--warn-fg/--danger`（含 `MermaidBlock.tsx` 的 62 处硬编码改读 CSS 变量）；修"只写 `[data-theme='dark']` 漏 `@media`"、"`var(--未定义, 字面)`"、"引用不存在的 class"三类真实 bug。
- **验收/锁**：按 [feedback_frontend_visual_verify_repro] 在**亮 + 暗**两种主题下截图核对；grep 锁"语义状态色不得再出现裸 hex"（白名单 `styles.css` token 区）；对不存在的 class 补规则或删引用后加"class 引用必须在 styles.css 有定义"的抽样断言。
- **注意**：`styles.css` 属 prettier 排除区（[reference_prettier_scope_excludes_design_state]），手工编辑。

### RFC-C：`<FormDialog>` / `<DialogActions>` + `<ConfirmDialog>` 回收（P0/P1）
- **范围**：抽 `<DialogActions primary secondary onCancel submitting>`（统一按钮顺序 Cancel 左/主操作右、尺寸统一、`submitting` 时禁用+文案切换+`aria-busy`、提交错误统一走 body 内 `ErrorBanner`）；把 4+ 处手写确认弹窗切回 `<ConfirmDialog>`。
- **风险**：`dismissDisabled` 全仓只有 2 个使用点——提交进行中的语义几乎无人遵守，需在组件层默认正确。
- **验收/锁**：`findByRole('dialog')` + footer 按钮 role 断言；grep 锁"新弹窗 footer 不得手写 `.form-actions__error`"。

### RFC-D：`<StatusChip>` / `.chip` 收编 + `<CountBadge>` + `<CopyButton>`（P1）
- **范围**：十余个 `X__status/__badge/__scope` 命名空间收编到 `<StatusChip>` / `.chip`（补 `chip--local/remote` 等缺失规则）；`<CountBadge neutral|attention|danger>` 统一三色小圆丸（含 "99+" 截断）；`<CopyButton>` 内部走 `copyText`。
- **风险**：`memory-row__scope` 被跨命名空间盗用、`role-chip` 等已漂移；`CopyButton` 有 RFC-009 / RFC-072 源码锁（ReviewDocPane 与 TaskOutputPanel 必须同 commit 改锁，详见 §3 首条）。
- **验收/锁**：grep 锁"`navigator.clipboard` 白名单 = `lib/clipboard.ts` + `ReviewDocPane.tsx`"；chip 收编后补"状态徽标走 StatusChip"的抽样断言。

### RFC-E：a11y 契约统一 + token 补全（P1，收尾）
- **范围**：修 `UserPicker`（补键盘导航、`option` 里移除非法 `<button>`）；`LanguageSwitch` CSS 收回 `.segmented`；`<ClickableRow>` 统一整行可点（含 distill 行键盘打开）；补 13px/10px 字号 token 与 z-index 分层。
- **验收/锁**：`getByRole('option')` / `radiogroup` 键盘用例；`findByRole` 断言 combobox 键盘契约；grep 锁"新控件字号走 `var(--font-*)`"。

**迁移顺序**：A、B 可并行先行（收益最大、风险可控）→ C（依赖 A 的 `ErrorBanner` 变更）→ D → E。每个 RFC 单独 PR，`bun run typecheck && bun run test && bun run format:check` 全绿 + **vitest 前端套件**（[project_frontend_i18n_batch]：前端测试跑 vitest 不在 `bun test`）+ 视觉基线（[reference_visual_baseline_settings_default_tab]）后再 push，按 [feedback_post_commit_ci_check] 查 CI。

**共性风险（所有 RFC 适用）**：
1. 前端测试跑 **vitest**，本地 `bun test` 覆盖不到这些锁——push 前必须单独跑前端套件。
2. i18n 是**显式 interface**，新增 key（如 `common.copyFailed`）必须**中英两份同时加**否则 typecheck 红。
3. 多人并行树：`components/canvas/**` 与 i18n 双 bundle 是高频并发文件，提交按精确路径 `git commit -- <paths>` 一次成型（[feedback_shared_index_commit_race] / [feedback_no_amend_on_shared_tree]）。
4. 大量 RFC-009 / RFC-072 / RFC-198 / RFC-203 源码锁锁死了当前 DOM/class/文本——改用组件必须**同 commit 改对应锁的断言并在注释写明意图**，绝不删别人的测试（[feedback_dont_delete_others_code_for_ci]）。

---

## 9. 已排除项（对抗验证驳回，共 91 条 —— 我们查过但不建议做，或问题被放大/已有原语覆盖）

> 以下候选被验证镜头驳回。保留在此是为了让后续 session **不要重复提**：多数是"行号属实但被放大成不存在的漂移"、"已有原语覆盖"、或"强行合一会变成 config 地狱"。

- **「筛选 chip 条」三套实现：Link chip / 自写 filter-chip 按钮 / chip--tight 按钮** —— 行号全部属实（tasks.tsx:159/164/173、TaskQuestionList.tsx:326/329-330/343-344、NodeDetailDrawer.tsx:521/527 逐行核对一致），但候选在「同一原语」和「去重后 ≥3」两条上站不住：

1) NodeDetailDrawer.tsx:521-531 不是同类。它是**多选 toggle**（enabledKinds: Set + toggleKind 取
- **"技术信息" 折叠块（details + summary + dl 键值网格）被四处各写一遍，CSS 还分裂成两个命名空间** —— 四个行号都真实存在、内容与描述一致（我逐条读过），但候选的核心论据经不起核实：

1) AgentForm.tsx:468 不是同一个原语。它没有 <dl> 键值网格，内部是 <p>{t('agentForm.technicalDetailsBody')}</p> + <DependencyTreePreview>（可点击跳转的依赖树组件）；CSS 上也是完全不同的形态——.agent-resources__technical(styl
- **tsx 里用 style={{ fontSize: 12, marginTop: 4 }} + className="muted" 手拼说明小字，散落在 8 个文件 13 处** —— 行号全部核实为真（13/13 内容逐字对得上，且候选还漏了 2 处：ModelSelect.tsx:160 的按钮 style={{fontSize:12}}、RuntimeList.tsx:530 的 claudeStaticModelHint 同样是 muted+13px），形态也确实同质（都是「表单控件下方一行说明小字」）。但按判据 3 直接推翻：仓库里已经有两个公共 class 覆盖了这个原语，候选把「已存在原语」写错了。(1)
- **「说明性小字（muted + 小号）」被 16 个命名空间各写一遍 __hint 规则，且字号已经分叉** —— 10 个声称行号逐条 Read 全部存在且内容一字不差（无编造/错位）。但候选的三条核心论据经不起核实：

(1) 「16 个命名空间」严重注水。styles.css 里 `__hint` 命中 33 处，其中 `.table-viewport__hint`(3204)、`.tabs-viewport__hint`(4557) 是 ::before/::after 滚动溢出渐变阴影，`.workflow-canvas__hint-bot
- **Form 原语里根本没有 Checkbox，全仓 11 处各自落原生 input + 自写 label 壳** —— 事实部分成立、方案不成立。11 处原生 checkbox 确实存在（提案漏列了 FilesPicker.tsx:102 和 NodeDetailDrawer.tsx:197，实际 11 处；Form.tsx:344 是 Switch 不算），但按提案的 API 抽取会立刻膨胀成 config 地狱：(1) label 各点都不是字符串——StructuralDiffView 是 `structure__severity--{s}` 严重
- **success/warn/danger/neutral 这套状态色被三套并行实现各写一份（runtime-dot / status-dot / status-badge），色值互不相同** —— 行号全部核实为真、内容一字不差，但「三套并行实现」这个前提站不住：三套里有两套已经是死 CSS，公共原语 <StatusChip> 早已把它们吃掉了。

逐条核实：
1) styles.css:1802-1816 `.homepage__runtime-dot--ok/checking/soft/fault`(#1e8e3e/#f5a623/#9aa0a6/#c5221f) —— 真实且活的，唯一消费者 components/home/
- **取消按钮在 .btn 与 .btn--ghost 之间不统一，次要动作（测试连接/返回上一步）的排位也各写各的** —— 问题本身真实但被放大，提案的组件形态站不住：

1) 真实缺陷只有一条，且很窄：弹窗 footer 的 Cancel 只有 3 处用了 `.btn .btn--ghost`（users.tsx:276、settings.tsx:1698、ConnectionDialog.tsx:389），其余全部是裸 `.btn`。而"次要动作排位各写各的"这条实际不成立——我逐个读了 RuntimeList.tsx:426（测试二进制）、settin
- **行内标识符 / 路径的 <code> 展示：每个功能域各自覆写字号与配色，没有统一原语** —— 八个出现点验证后不是同一类东西，`CodeText size/tone` 的两个轴几乎覆盖不到它们。真实分布：(a) styles.css:217 已经存在全局元素级 `code {}` 原语（font-mono + padding 1px 4px + radius 3px + border + 0.9em），也就是说"统一原语"其实已经有了，只是以元素选择器而非组件形式存在；(b) 各命名空间的覆写绝大多数不是字号/配色，而是**由容
- **树形缩进公式与展开/折叠三角在三四处各写一份，图标已经出现两种字形** —— 八个出现点我逐个读过，全部属实，但候选把两件不同的事捆成了一个提案，两件单独看都不成立。

(a) 树形缩进：真正涉及缩进的只有 3 个文件、2 套公式——StructuralDiffView.tsx:529 与 WorktreeDiffPanel.tsx:269/286 是 `8 + depth*14`（8px 基线 + 14px 步长），WorktreeFilesPanel.tsx:270 的 `indentFor()` 是 `de
- **胶囊/标签 chip 有 7 套平行实现，圆角 4/12/999px、字号 11/12/13px 全不一致** —— 行号本身都对得上（8 条我逐条 Read，7 条文本吻合），但『7 套平行实现』与旗舰漂移证据经不起核实：

(1) .task-workflow-cell__badge (styles.css:3609) 内容只有 `flex: 0 0 auto;`，不是『又一份行内标签』。唯一调用点 components/TaskSubjectLink.tsx:146-152 已经是 `<StatusChip kind="info" size="s
- **「标题左 + 操作右」的 header 行在 ≥10 个命名空间里各写一遍 flex/space-between** —— 亲自核对 8 个出现点后，候选描述（「≥10 个命名空间各写一遍 flex/space-between」）站不住脚：

1) 只有 3 处是真正的「space-between 标题左/操作右」：styles.css:6474 `.workflow-validation__header`、10613 `.repo-source-row__header`、8204 `.review-detail__page-header`。
2) 3 处根
- **「左侧列表栏 + 右侧详情窗格」这一版式被 7 个功能各自重写，栏宽/间距各不相同** —— 三条独立理由让这个提案站不住：

**(1) `.split` 不是「无路由语义」的版式原语，它的路由语义烧在 CSS 里。** styles.css:16087-16143 的 `@media (max-width: 1080px)` 里，`.page--split[data-mobile-view='list'] .split__detail` / `[data-mobile-view='detail'] .split__list`
- **.split-card 与 .gallery-card 是同一张卡的两个尺寸，却各自复制了一整套 accent 变量 + 顶栏渐变 + 图标/身份/徽标/元信息插槽** —— 行号全部核对属实（15769/15790/15823/15985/16413/16429/16460/16574 内容与摘录一致），不是编造。推翻理由在后四条：

(1) 漂移描述有硬伤。`grep -n 'split-card__' styles.css` 列出的 24 个插槽里**没有 __meta、也没有 __stretch**，候选声称的「__icon/__identity/__kind/__title/__name/__bad
- **单行截断三件套 overflow/text-overflow/white-space 在全文出现 68 次，缺一条工具类** —— 事实部分成立、结论不成立。

**事实核实（我自己跑的）**：styles.css 里 `text-overflow: ellipsis` 共 68 处；按规则体解析，其中 **62 处**确实是完整三件套（overflow:hidden + text-overflow:ellipsis + white-space:nowrap），6 处故意只有两件（`.task-questions__meta-v` 注释明写「nowrap 继承自 m
- **同一功能存在两个并行命名空间（缩写别名 / 改名残留），应合并** —— 候选把「命名不统一」等同于「并行实现/重复」，逐条核实后三条不成立，只剩一条真问题。

(1) .sg-* vs .structure-graph__* 不是两个并行命名空间。styles.css:13369 的 .structure-graph 是宿主容器与页面 chrome（.structure-graph__level / __empty / .structure-graph-wrap），.sg-card/.sg-pkgnode/
- **z-index 有 18 个互不相干的裸数值、没有分层 token，浮层梯子已经互相矛盾** —— 行号全部核实为真（8/8 内容对得上），且 `--z-*` 变量确实不存在——这两点没问题。但候选的核心论据「真实矛盾」是错的，且计数也不准，因此整体站不住：

1. **声称的 bug 不存在（跨 stacking context 的伪比较）**。我逐个查了这四个「会被 Dialog 盖住」的类的宿主组件：`.user-menu__dropdown` 在 `components/UserMenu.tsx:121`、`.context-
- **长文本截断统一靠 title 属性挂在不可聚焦元素上，ClampedText 原语只被用了一次** —— 行号与内容全部核实为真（8 处逐条 Read 对得上，ClampedText 确实全仓只有 WorkgroupRoom.tsx:807 一个调用方，无测试）。但作为「contract-drift」候选站不住脚，三点：

(1) 不是同一个原语。ClampedText 是「多行块级 clamp + 展开/收起 toggle 按钮」，服务于长自由文本（工作组 goal、memory body）；title= 那批是「单行 CSS 省略号 +
- **列表表格两套并行样式：.account-table（settings/account）vs .data-table（其余全部）** —— 提案两半都站不住。(1) 「打包 TableViewport + thead + 空态」这块价值已被 RFC-198 的 components/TableViewport.tsx 提前兑现——它已是公共 wrapper，两套表格全都已经在用它，DataTable 组件再包一层是重复。(2) .account-table 与 .data-table 不是「有人选错基座」的意外漂移，而是容器语境驱动的有意区别：account 的 3 张表 
- **画布节点卡片外壳（容器 class 拼接 + header 图标/标题 + surface 条件的配置摘要/nodeId）在 7 个节点渲染器里逐份手抄** —— 候选本身是真的：6 个叶子节点（Agent/Input/Output/Review/Clarify/CrossClarify）确实各手抄了一份「外层 div(class 拼接)+ ValidationBadge + header(kind glyph+label / title) + surface? summary : id」骨架，约 10 行 ×6。但提案要把 7 个渲染器（含 WrapperNodes）统一到一个 CanvasNo
- **「key: value 元信息 dl 网格」在 6 处各写一套 CSS，列宽/间距/字号全不一样** —— 提案把 7 处当成「同一套 key:value dl 网格」，但源码核实后它们分属两个结构族，且不是 6 套：

**Flat 族（dl > dt + dd，直接子网格）**：`.task-meta`（NodeDetailDrawer.tsx:348 与 tasks.detail.tsx:880 已经共用同一 class，本就只有 1 套 CSS）、`.detail-grid`（scheduled.$id.tsx:190）、`.work
- **loading / error / empty / data 四态三元级联在每个查询点手拼一遍，且各处形态不同** —— 候选的核心断言「上述 7 处是同一 loading/error/empty/data 四态级联、可一次性收敛」经核对为假：只有 4 处是真正的 query 四态级联（SkillVersionHistory:115、:198、RuntimeList:192、account:40），另外 3 处是伪同形。SkillFileTree:137 的三态是「渲染在恒存在的 <ul> 列表+新建表单之上的内联 banner」，不是互斥级联，套不进 c
- **两套并行 chip 体系：手写 `.chip .chip--tight` 与 `<StatusChip>` 在同一个 /skills 功能里混用** —— 全部 7 个行号真实存在、内容逐字对得上（已亲自 Read）。但候选的核心定性——"两套并行 chip 体系混用、.chip/.chip--tight 判为遗留、统一收敛到 StatusChip"——站不住脚，属于误诊设计：

1. .chip 不是遗留物，是全站活跃的中性元数据微标签原语。grep 命中 ~40 处调用：routes/workflows.tsx:196 `v{w.version}`（与 skills.tsx:59 版本
- **两套并行 chip 体系：`.chip chip--tight` 裸 span 与 <StatusChip size="sm">，且在同一行内混用** —— 所有行号与内容属实（逐条 Read 核对无误），但候选把两个**有意区分**的原语误判为 contract-drift。StatusChip（RFC-035，见 StatusChip.tsx:1-9 文档）是**语义状态**原语——success/warn/danger/info/neutral，带色底/描边、weight 500、text-transform:lowercase；它替代的是四套 *status* 实现，从不承载中性元数
- **「key: value」元信息定义列表 8 个命名空间各写一遍** —— 这 7 处不是「同一个 key:value 列表被抄了 8 遍」的偶然漂移，而是 4 种有意为之的上下文形态 + 2 处结构完全不同的技术折叠面板，强行合一要么变成 config 地狱、要么其实是一次未经产品拍板的视觉重设计。逐条核实：

一、DOM 结构就分两派，一个组件无法同时满足。account-defs 用 `__row` 包裹 div（`grid-template-columns:140px 1fr; align-items:
- **『淡色底 + 同色边框 + 圆角』的提示/错误框在 7 处各写一套，语义 token 已存在却被绕开** —— test isolation
- **按钮组行（flex + gap + 对齐）在 ≥12 个 __actions 命名空间里重复定义** —— 提案的前提站不住脚，且抽象会膨胀成 config 地狱。逐条：

1) 出现点几乎全错。给的 7 个行号里只有 2 个真的是按钮组行——styles.css:6049 `.workflow-canvas__empty-actions`、styles.css:7748 `.task-outputs-panel__actions`；其余 5 个（8217 `.reviews-row__expand-icon`、9350 `.agent-im
- **<details> 折叠区的 summary 外观各写一套，marker 隐藏与键盘可见性不统一** —— 提案的证据基础基本是伪造的。7 个引用坐标里只有 styles.css:6616、6660 确为 <details>/<summary> 样式；其余 5 个（10637 .clarify-shard-switcher、10905 .session-attempts、11158/11187 .mcp-probe-chip、11236 .mcp-expanded）根本不是 summary chrome，是 flex 容器 / Select 
- **焦点环一半走 --focus-ring-* token、一半写死 2px/-2px，且 inset 场景已经复发过 5 次** —— 提案的核心交付物基本已经存在，且提供的行号锚点全部失效，站不住脚。

1) 两条「基础规则」已经在 RFC-206 里建好，都走 token：
   - 外置组 styles.css:17010 `:where(.btn, .nav-item, .sidebar__link, .dialog__close):focus-visible { outline: var(--focus-ring-width) solid var(--focu
- **多处写死 #fff / #ffffff 当「反色前景」，暗色主题下变成白块或白字白底** —— 这条候选的核心动机站不住脚，多处细节与源码不符，属"只减代码量/换名、不真正防漂移"，故 refuted。

1) 「#fff 在暗色主题下变白块/白字白底」这个前提对绝大多数出现点是错的。`--on-accent`、`--panel` 的取值在**明暗两套主题里都各自定义**，而 `--on-accent = #ffffff` 在 :root 与 :root[data-theme='dark'] 里**都是 #ffffff**（sty
- **行尾操作按钮组三种尺寸/形态并存（btn--sm vs btn--ghost btn--xs vs btn--xs），且只有 2/7 张表包了 .data-table__actions** —— 提案的 `actions={[{label,onClick,tone,confirm,testid}]}` 扁平签名无法覆盖 7 个出现点的真实形态，为了兜住必然膨胀成 config 地狱（判据 1 命中）：

- reviews.tsx:231 根本不是 `<button>`，是 `<Link to params search className="btn btn--sm">` 路由链接——签名里的 `onClick` 表达不了，得再
- **列表页工具栏行（左筛选 + 右操作 / 计数）在 6 处各写一套 flex 容器与 CSS 命名空间** —— 全部 7 个行号真实存在且内容对得上（未编造）。但把它们当"同一个原语"站不住脚：只有 gallery__toolbar(16513) 与 task-questions__toolbar(14643) 是真正同形的 space-between 列表工具栏行；其余五个形态各异——structure__toolbar(14054) 与 files-picker__filter(5456) 是左对齐控件簇(无 space-between、ga
- **「保存按钮（忙碌文案）+ 内联错误/已保存 + 禁用原因」保存条被各处手写重复** —— 这 6 个「出现点」并不是同一套 chrome 的重复，而是 3–4 种语义不同、已各自部分抽象过的形态，硬收进一个 <FormActions> 会立刻膨胀成 config 地狱，且提案里写死的「左侧 error/hint、右侧 主按钮+saved」布局与实际代码没有一处对得上：

1) settings SectionForm(settings.tsx:2026-2046)本身就是 settings section 的已抽象组件:`.
- **草稿态三连告警（结果未知 / 远端已变 stale / 需重启）在四个编辑页各拼一遍** —— 六个锚点内容真实存在（settings 的两个行号错位约 7 行——2041 实为 form-actions__error span、2057 实为 reconcile 按钮 label，真正的 banner 在 2047/2063/2078；其余四处行号精确）。但「草稿态三连告警在四个编辑页各拼一遍」这一核心命题被证据推翻：四处结构差异过大，并非同一原语。① 只有 settings 拥有完整的 outcomeUnknown/stale
- **「小标题 + 说明文字 + 字段体」的表单分组被三套 chrome 各实现一遍（FormSection 缺 hint 槽）** —— 候选的前提「同一套 chrome 被三套实现」在核实后基本不成立——三处的标题是**有意为之的三种不同视觉/语义处理**，不是漂移出来的重复：

- `.form-section__title`（styles.css:3908）= 16px、正常大小写、真正的 `<h2>` 段落标题，进入 heading outline。
- `.oidc-form__group-title`（styles.css:951）= 12px、**UPPER
- **「折叠原始详情」details>summary>pre 被 6 个命名空间各写一遍** —— 提案前提「6 处只是把同一折叠详情各写一遍、可统一样式」不成立。读 CSS 后确认这 4 个命名空间是**有意各异**、不是偶然漂移：error-details__raw 的 pre 是带滚动框（max-height 220px + --panel 背景 + 圆角）且 summary 有 a11y 调过的 font-weight:500（源码里有明确 WCAG 注释禁止用 opacity 弱化）；task-error-banner__d
- **空值占位符「—」一半走 t('common.emDash')、一半写死字面量** —— 候选前提为真（20 处裸 '—' vs 34 处 t('common.emDash')），但提案的核心手段不可行。（1）`<EmptyValue />` 是 JSX 元素，无法覆盖大量 string-typed 空占位场景：ReviewEdit.tsx:162/197 的 Select option label（且在 xyflow 画布节点内）、clarify.detail.tsx:740 的 option label、ImportZi
- **画布/抽屉里的图标字形按钮（× / + / ⋯）各自手配 class，其中一处用了根本不存在的 class** —— 2451 的 class 笔误属实（btn-ghost/btn-sm 单横线不存在，真类是 .btn--ghost:3124 / .btn--sm:3116，当前退化成裸 .btn），值得独立一行修复——但这属于 CLAUDE.md 明列的"单行 bug 修复"豁免，无需靠抽取组件来承载。抽取本身不值得且提案有硬伤：(1) 六个出现点横跨三套互不相同的体系——A 组 .btn 家族（2390/2451/164）、B 组 .inspect
- **「@成员名 + 类型 chip + leader 徽标 + 状态 chip」的成员行在 5 处各写一遍，@ 前缀已经不一致** —— 候选基于多处与源码不符的前提，且抽象目标高度异质。事实核查：(1) 六个出现点里 Gallery:110、ContextPanel:266 根本不是「@成员名 handle」——Gallery 的名字是 h3 里的 workgroup-card__open 展开按钮（无 @），ContextPanel 是 workgroup-card__ref 引用串（agentName，无 @）。(2) 提案宣称要让 Gallery/ContextP
- **「驳回必须填理由」弹窗（Field required + TextArea rows=4/65536 + danger 提交按 trim 长度禁用）整段复制** —— 所有 6 个行号锚点均核实准确、内容对得上，非编造。但候选站不住脚：(1) 与提案「整段复制」精确匹配的驳回弹窗（Dialog size=sm + Field required + TextArea rows=4 maxLength=65536 + btn btn--danger 提交 disabled on trim().length===0）只有 2 处——WorkgroupRoom.tsx:850/883 与 DynamicWor
- **节点 / 任务短 id 的「等宽 code chip + 标题回退」五种写法** —— Broad proposal (6 sites into IdCode + EntityTitle, deleting 3 CSS rules) bloats into config hell. The 6 call sites differ on nearly every axis: truncation (only clarify:252 does slice(-10)+title; reviews:158 shows full),
- **展开 / 收起切换按钮：四套字形与四套 chrome** —— 提案作为「6 处合一的 icon+text 双变体组件」站不住脚，三个硬伤：

1. 出现点集合被污染，worktree 不是真成员。WorktreeFilesPanel.tsx 的 ▾/▸ 是一个 `<span aria-hidden>` caret，嵌在更大的复合行按钮 `<button className="worktree-files-tree__row--dir">` 里——该按钮同时渲染文件名、带 `data-testid=
- **role="tabpanel" 面板循环被手写 5+ 份，绕开 <TabPanels>，且 keep-mounted 语义被写反** —— 6 处行号全部存在、内容对得上（NodeDetailDrawer 实际 div 起于 213，候选写 212，差 1 行可接受）。但候选的**核心论点站不住**：它声称手写版 `{active && …}` 写反了 keep-mounted 语义、造成「切走丢半输入缓冲」的 bug，并以 AgentImportDialog paste 面板「切 upload↔paste 丢已粘贴文本」为旗舰证据。核对源码后此 bug 不成立——Agen
- **muted 小字提示语被拆成 12 个 __hint 命名空间，字号 11/12/13/14px 四档** —— 提案的价值被高估、方案本身有偏差，属于纯减代码量、不防漂移的 cosmetic 收敛，倾向 refuted。三点核心问题：(1) 与既有原语重叠——styles.css:2569 的 `.page__hint, .muted` 已经是事实上的「muted 小字」公共工具类（14px），再新建一条 `.hint` 基本是重复造轮子；正确姿势是复用/最小扩展 `.muted`，不是另起 `.hint` 命名空间。(2) 出现点清单不准且诱导
- **Dialog footer 的取消/确认按钮三套变体并存（btn--sm / btn--ghost / 裸 btn）** —— 提案（给 Dialog 新加结构化 footer `actions` API）应被否，两条独立理由都成立：

1) 与既有公共组件职责重叠。仓库已存在 `components/ConfirmDialog.tsx`（RFC-198），它恰好就是提案描述的东西：取消在左（`btn`）/主操作在右（`btn btn--primary` 或 `btn btn--danger`）、`tone: 'default'|'danger'`、pendin
- **“小灰标签”至少五套并行 class，其中两套 CSS 规则块逐字节相同** —— 提案把 6 个出现点当成"同一个小灰标签的五套复制"，但源码不支持这个前提：
- 真正逐字节相同的只有 2 处：inventory-section__chip(RuntimeInventorySection:58) 与 injected-memories-card__chip(InjectedMemoriesCard:65)，两者都是 padding:0 6px / radius:3px / bg:var(--panel) / colo
- **“搜索框 + 计数 + 空态 + 无匹配清除”这套列表骨架被实现了三遍，连同一句译文都存了两个 key** —— 候选的两处漂移是真的、可核实的：(1) zh-CN.ts:4634-4635 的 common.itemsCount 与 4702-4703 的 splitPage.itemsCount 字面完全相同（都是 '{{count}} 项'）；(2) styles.css:16534 的 .gallery__count 带 ::before 圆点 + font-sm，15885 的 .split__count 无圆点 + font-xs。ga
- **已有 ResourceIcon 图标注册表，shell 层却另起三个尺寸/线宽不同的一次性 SVG** —— 候选的两半都站不住。

(a) 图标合并——三个前提有两个是错的，且 API 会膨胀成 config 地狱：
1. InboxIcon 并非"一次性 SVG"。它本身已经是带 size/strokeWidth 参数的共享组件，被 InboxDrawer(size=32,sw=1.6) 与 InboxFooterButton(默认 size=18) 两处复用（InboxIcon.tsx:8、InboxDrawer.tsx:386、Inbo
- **「可删除标签 chip + × 按钮」在 6 处手写，aria-label 与 testid 契约已分叉** —— 候选前提事实错误，且提案 API 会膨胀成 config 地狱、几乎不防漂移，只减代码量。

(1) 6 处并非同类。只有 3 处是「可删除 chip + ×」：ChipsInput.tsx:129、MultiSelect.tsx:249、UserPicker.tsx:126。另外 3 处根本没有 × 按钮：AclPanel.tsx:229 与 TaskMembersPanel.tsx:145 都是只读分支里的裸标签 `<span cl
- **卡片外壳（panel 底 + 1px border + 圆角 + padding）在 6000-12000 段被手写 13 次，绕开 .card** —— 候选站不住脚，三重问题：

1. 证据严重错位。提案给的 6 个行号里只有 styles.css:7958（.onboarding__step）是真正的手写卡片外壳；10162=.worktree-diff__body（flex/overflow，无 border）、10844=.batch-import-dialog（max-width 弹窗）、11112=.session-role-badge--reasoning（仅一个 acce
- **分段控件被手写 4 套（连线弹窗 / diff 模式 / repo 来源页签），绕开 .segmented** —— 候选声称「分段控件被手写 4 套（连线弹窗 / diff 模式 / repo 来源页签）」，但逐条核实后 3 个声称出现点里有 2 个站不住：(1) diff-mode——reviews.detail.tsx:720-721 早已渲染 <Segmented>，只是传 className="diff-mode-segmented" 覆盖容器为 pill（Segmented.tsx:141 把 className 追加到 'segmente
- **box-shadow 写死 rgba 字面量，绕开 --shadow-sm/md/lg，dark 模式下深浅不一** —— 核心「暗色模式漂移」论点是编造的。暗色主题块（styles.css:145-172 `@media (prefers-color-scheme: dark) :root:not([data-theme])`）只覆盖颜色变量（--bg/--panel/--border/accents），从不重定义 --shadow-*；--shadow-sm/md/lg 全仓仅在 :root(58-60) 定义一次，light/dark 下渲染完全相同的
- **inventory 四个表绕开 TableViewport 直接裸 <table>，横向溢出无键盘可达滚动** —— 所有 6 个行号真实存在且内容对得上，但候选把设计意图弄反了，判为 primitive-bypass 不成立。inventory 4 表与 TableViewport+.data-table 是两套【互斥】的布局契约，不是同一原语被绕开：TableViewport(styles.css:3187-3197)给 table 施加硬 min-width 720/920px 并让容器横向滚动；.inventory-table(styles.c
- **列表页的搜索框有 4 套壳（split__search / gallery__search / tasks-toolbar__search / node-picker），尺寸与 testid 都不一致** —— 四个 TSX 出现点内容属实（行号各差约 1 行：split 实为 376、gallery 140、tasks 195、node-picker 240），但候选给的两条 styles.css 行号完全错位（16786 实为 .gallery-card__when，16398 实为 .skill-detail__technical dd；真正的规则在 15892 / 16553 / 16941）。更关键的是抽象站不住：(1) 第 4 个出
- **列表/弹层搜索框在 6 处手拼，尺寸、清除方式、Escape 行为、aria 全不一致** —— 前提站不住脚。所谓「6 处手拼」实际 5/6 已走公共 TextInput 原语（Form.tsx），type=search/aria-label/className 一致性早已由它保证：ResourceSplitPage.tsx:376、ResourceGalleryPage.tsx:141、tasks.tsx:198、WorkflowNodePicker.tsx:241 均为 <TextInput type="search">，Fi
- **全仓没有分页器原语，改用各不相同的硬截断上限 + 四种「已截断」提示** —— 候选把两类无关的东西硬凑成"6 处截断提示"。实际上 tasks.tsx:78（limit=500 查询参数）和 RunningTaskList.tsx:45（.slice(0,RUNNING_LIMIT) 静默截断）根本不渲染任何提示 UI，属于 (b) 分页范畴而非 (a)；且提案称 FilesPicker "静默"是错的——FilesPicker.tsx:186 已有带剩余计数的 moreHint。真正的 4 个提示点 DOM 与
- **区块级 header（h2 标题 + 说明 + 右侧动作）绕开 PageHeader 各写一套** —— 候选作为「primitive-bypass」站不住脚，理由三条。(1) 声称的形状「h2 标题 + 说明 + 右侧动作」在 5 处里只有 #1 auth-tab 三件齐全；#2 settings-section-panel 只有标题+说明、无动作、且 h2 挂 ref/id/tabIndex={-1} 做焦点管理（PageHeader 的裸 HeadingTag 无法转发）；#3 mcp-inventory 是标题+内联 StatusC
- **多选/单选选项列表全部落原生 input，Form 里没有 Checkbox 原语** —— 观察本身为真：EnumPicker/FilesPicker/StructuralDiffView/QuestionForm 四处确实都落了原生 `<input type=checkbox/radio>`，Form.tsx 里也只有 `<Switch>`（一个带自定义轨道皮肤的 checkbox），没有通用 Checkbox/CheckboxList/RadioGroup 原语。但"给 Form 补 CheckboxList/RadioG
- **"<details> 折叠原始信息/技术细节"至少 5 套并行 class，且已出现跨组件借用 class** —— 提案的核心卖点站不住脚，收益又几乎只剩「减代码量」。(1) 8 个调用点全是非受控原生 `<details>`（没有任何 React `open` 状态），而「借用 FormSection 的受控 open desync 处理」正是为受控场景服务的——这里根本没有 desync 问题，卖点空转。(2) 「至少 5 套并行 class」被夸大：ValidationPanel.tsx 与 ErrorDetails.tsx 其实已经共用同一个
- **端口行（handle + 省略标签 + 可选 tag）在 PortHandles 之外又被 WrapperNodes 复刻三份，注释里明写“不复用共享组件”** —— 候选把三段 WrapperNodes 代码说成 PortHandles 端口行的「复刻三份」，但结构上并不成立：PortHandles 是「每行一个 handle + 标签」模型，而 fanout 的输入/输出行是**双 handle 边界行**（outer+inner 跨边框，左右镜像、连接性语义也不同——普通左行强制 isConnectableStart/End:false，边界 handle 必须双向可连），git/loop 底部
- **「优先取 live node_run 状态、否则退回快照」的 StatusChip 六行块被逐字复制** —— 提案对出现点的刻画不成立，且抗漂移收益已被现有单一事实源吸收。

1) 「优先取 live、否则退回快照的六行块被逐字复制」这个描述只匹配 5 处中的 2 处（WorkgroupRoom.tsx 的 692/1105 两个卡片）。另外 3 处根本不是 live/fallback 形状：
   - NodeDetailDrawer.tsx:475 与 routes/tasks.detail.tsx:1543 是「纯 NodeRun」两行形
- **@提及下拉是第 4 份手写 listbox popover（active-descendant + 键盘导航 + hover 高亮）** —— 这条候选站不住脚（就本分片的 @提及 而言）。四处并非同一契约：UserPicker 根本没有键盘导航（选项是真 <button> 点选，无 activeIndex/无 aria-activedescendant/无箭头键），不属于「active-descendant + 键盘导航」家族，把它算进去是把真实的 2-3 处虚报成 4 处。本分片唯一出现点 WorkgroupRoom @提及 是四者中最差的适配对象：host 是多行 <te
- **收件箱页骨架：PageHeader + 分段筛选 + 三态 + 按任务分组表格** —— 提案三条腿有两条站不住，整体不成立，但残存一小块（TaskGroupSection）有价值，故 refuted + 给收窄后的 correctedProposal。

1) tasks.tsx 那条腿完全错位。tasks.tsx 的主筛选是 `.status-filter`（routes/tasks.tsx:159-177）——由一排 `<Link>` chip 反映 URL search 参数构成，既不是 `.page-filter`
- **「校验问题清单」区块（标题 + 逐条 severity 标识 + 消息 + 跳转修复按钮）被写了三份** —— 候选把「三份」当成同一区块来合并，但实际是「2 真重复 + 1 假兄弟」，三合一提案不可行。

真重复对（值得处理）：
- AgentPortValidationSummary.tsx:77（RFC-194）—— `section.agent-port-validation` role=alert/region → h3.__title → ul.__list → li.__item--{severity} → StatusChip 表
- **短 hash / 短 id 的截断长度与 title 提示各写各的（4 种长度）** —— 这 5 个出现点不是「同一个短 sha 概念的 4 种长度」，而是 3 类语义不同的东西被硬凑到一起：

1. 真·git/resource hash（长度 12，em dash 兜底）：plugins.detail.tsx:398（resource hash）、tasks.detail.tsx:923（baseCommit，真 git sha）——这两个确实契合 SHORT_SHA_LEN=12。
2. MCP resource ha
- **agents 列表卡片绕开 ResourceBadges 自写 private chip + owner 徽标** —— 候选把 agents 卡片说成「绕开 ResourceBadges 自写 private chip + owner 徽标」，但核实后这是**有意的差异化实现**，不是偷懒 fork，直接 swap 不保行为。

对比事实：
- private chip 部分确属完全重复（`<span className="chip chip--tight">{t('acl.privateChip')}</span>`，两处一字不差）——但这是全仓到处都
- **「带标题的内容区块」在各页各起一套 section/heading class** —— 提案作为写法站不住，核心机制与收益主张都对不上实际代码：

1. count 的三种写法语义并不同质，硬塞进单一 `count` prop 会引发真实的 i18n/视觉改动，而非纯清理。MemoryByScopeBrowser 是 `(n)`（MemoryByScopeBrowser.tsx:47），SourceEventsList 是 `· n`（SourceEventsList.tsx:41），而 DependencyAutodet
- **`btn--primary` 被当成「已选中 / 已按下」状态用，与「主行动按钮」语义冲突，出现在 5 处** —— 逐行核对：5 处行号全部存在且文本吻合。但把它们当「同一个可抽取原语（ToggleButton）」站不住脚，去重后真正贴合的仅 1 处。

1) WorktreeFilesPanel.tsx:260 根本不是 btn--primary——它用的是树行 class `worktree-files-tree__row ... + is-selected`，控件是 tree row（role=treeitem）而非按钮。候选自己也把它列为「另
- **多阶段（选择→复核→结果）弹窗的「阶段切换后 focus 到该阶段标题」样板抄了三份** —— 所有 5 个行号真实存在且内容对得上，AgentImportDialog 与 WorkflowImportDialog 两个弹窗确实各写了一份「setTimeout(…,0) 按 phase 重对焦 + openRef/generation 失效令牌 + 保持 initialFocusRef 稳定」的样板（AgentImportDialog.tsx:497-500 注释也证实了 Dialog.initialFocusRef 的原语缺口是
- **浮层选项列表（portal + 键盘高亮 + hover 洗色）被实现了三遍，z-index 相差 60 倍** —— 候选的前提在核对源码后有实质性失真，全量提案不可行。

一、"portal + 键盘高亮 + hover 洗色 被实现三遍" 与代码不符——四个调用点的机制各不相同，没有一个共同的三要素模式被复制三遍：
- Select（Select.tsx:287）：portal 到 body、键盘 activeIndex、`.select__*` 一套 class。
- MultiSelect（MultiSelect.tsx:295）：**已经复用
- **选中态徽标/开关旋钮直接写 #fff，绕开已有的 --on-accent** —— 五个行号都真实存在且逐字对得上（我逐条 Read 核实：330/1335/2023/2473/3849）。但候选把它们打包成"同一个原语 --on-accent，5 处出现"的框架站不住脚，理由三条：

1) 不是同一个原语——按提案自己的修法它们分流到 ≥3 个不同 token：330/1335 徽标→--on-accent、2023 inbox-kind→--on-info/--on-warn、3849 旋钮→--panel、247
- **仍有两处手写 role=dialog 浮层绕开 Dialog：无 focus trap / 无 ESC / 无 outside-click** —— 候选的关键论据与源码相反。ValidationPanel 非 compact 分支并非无 ESC / 无焦点归还：89-103 行有专门 ESC 监听（setOpen(false)+triggerRef.focus() 归还焦点），91 行打开时 focus 首个 issue，116 行 close() 归还焦点——两分支的 ESC 与焦点归还是刻意做成一致的，所谓"改窗口宽度交互就变 / 关闭键盘行为焦点归还完全不同"是虚构的；真实差
- **文件树/文件列表四个实现用了三套互斥的 ARIA 模型（tree / tablist / 无角色）** —— 出现点全部核实无误，"三套 ARIA 模型"描述属实，但提案把这当成需要消除的缺陷是误判——三套模型恰好对应三种真正不同的交互语义，硬统一会造成配置地狱且价值虚高。

1) ARIA 差异是语义正确、不是 bug。WorktreeFilesPanel 是可展开/折叠的层级树（aria-expanded + 惰性逐级 fetch），role="tree" 正确；两个 diff 面板是"选文件→右侧显示对应 panel"的标签选择器，rol
- **「共 N 条 / 已选 N 条」结果计数四处手写，i18n key、字号、装饰、播报方式都不同** —— 提案过度归并，五个出现点里只有 2 个（split / gallery）是真正同形的「可见计数 span + aria-live」，其余 3 个形态根本不同，硬塞进单一组件必然膨胀成 config 地狱：\n\n1) API 会因差异膨胀（判据1→refuted）：`kind:'items'|'selected'` 只覆盖两种文案，但实际有 4 种语义不同的 key —— itemsCount / selectedCount / res
- **「清空筛选 + 把焦点还回筛选控件」的样板在 5 处逐字重写，按钮文案还分裂成两种** —— 候选把 5 处说成「逐字重写」不成立：只有 reviews.tsx:44 与 clarify.tsx:155 是真正同构（segmented filter 复位到默认 sentinel + 通过 restoreFilterFocusRef+effect 把焦点还给<button>）。其余三处是不同行为——tasks.tsx:127 额外做 TanStack router navigate({search:{}}) 复位多个 state、
- **分区导航/页签上的「未保存 • / 冲突 !」角标映射在 4 处各算一遍** —— 四个行号都真实存在、内容大体对得上（候选给的行号偏 1-2 行，在同一块内，非编造），但候选是以「contract-drift（真实不一致 bug）」立论，而承重的 drift 站不住：①（PageSectionNav 缺 neutral 兜底）为假——PageSectionNav.tsx:284 的 Badge 用默认参数 `tone = 'neutral'`，settings 传 `badgeTone: undefined` 时默认
- **"搜索框 + 结果计数 + 无匹配空态"组合各写一遍，播报契约不一致** —— 四个行号真实存在、内容对得上（gallery/split/tasks 的 TextInput 实际在 140-141/376/195，候选标注有 ±1 偏移，但非编造）。但候选不成立：(1) gallery/split 各自是共享页面骨架 ResourceGalleryPage（被 workflows/workgroups 复用）/ResourceSplitPage（被 agents/mcps/skills/plugins 复用），带计
- **`nodeId.portName` 端口引用展示三处三种写法，分隔符已经不一致** —— 提案把「分隔符不一致」诊断为待修的意外漂移，但核实后这是有意的语境差异，不是漂移。EdgeInspector 在同一个 inspector 里故意把同一条 edge source 渲染两次：149 行 `<strong>{title}</strong> · {portName}`（中点+strong+非 code）是给人看的友好标签，201 行 `<code>{nodeId}.{portName}</code>`（点+扁平+code）是
- **"code 名 + 说明/错误码" 的结果条目列表在 ZIP 面板里写了四遍（CSS 已合并、JSX 未合并）** —— 候选把「四处同形」说过头了，实测四处并不同形：

1) 787(skipped) 与 800(failed) 才是真孪生：都是 section+h4 里 `<code>{name}</code>` + `<span>` 详情，仅 failed 多个 `<strong>{code}</strong>: ` 前缀。真重复但只有 2 处，且已有差异。
2) 598(ArchiveErrors) 外壳不同——它是 `<Card>`（带 coun
- **「标签：归属人 chip」一行（提交人 / 最后编辑 / 决策人 / 评论人）** —— 四行全部存在，但候选把它们包装成"同一个 标签+chip 原语的 4 处漂移"站不住脚。(1) 第4处 ReviewDocPane.tsx:762 是 footer 里一个裸 AttributionChip，**根本没有任何 `标签:` 文本**（没有 t('attribution.commentedBy') 之类），把它叫"评论人 chip"是编造——它不是"标签+chip"形态，AttributionLine(label=…) 无法
- **四个资源「新建」页的外壳（fieldset + PageHeader + 主按钮 + ErrorBanner + body）逐字复制** —— 四处行号真实存在且非编造，但"四页逐字复制同一外壳"只对 mcps.new:66 与 plugins.new:72 成立（两者近乎逐字同构：fieldset(agent-new detail-freeze)+PageHeader单按钮+ErrorBanner+.split__detail-body{Fields}）。skills.new:95 结构不同：PageHeader 带 child hint，后面是 TabBar+TabPane
- **「执行基线：已保存/有未保存改动 + 配置 hash」提示条两处分别实现且已漂移** —— 两处 banner 均真实存在且内容对得上（McpInventoryPanel.tsx:122 banner + :86 双按钮动作块；plugins.detail.tsx:389 banner + :411 form-actions 单按钮），非编造。但候选站不住脚：(1) 去重后真实出现点仅 2 处，未达 ≥3；(2) 候选最倚重的可见漂移——sha 截 10 vs 12、title 有无——已由一个正在并行落地的既有原语覆盖：未追
- **「长文折叠 + 展开/收起」被 fork 了三份，公共 ClampedText 注释里已认领此债** —— 四个行号全部真实且内容对得上，但"fork 三份"的计数站不住：(1) RecoverySection.tsx:152 是分类错误——它的 expanded 门控的是一整段 recovery 事件 <ul> 列表的显隐（RecoverySection.tsx:118 `{expanded && events.length > 0 && (<ul>…)`），没有文本、没有行数阈值、没有裁剪高度、没有底部渐隐，本质是"列表 disclosu
- **已有 .card 原语，但『带边框圆角的内容盒』仍被手写复制** —— 候选站不住脚，多点被推翻。(1) 出现点#4 styles.css:14287 的行号是错的——14287 实为 .attribution-chip__role--owner，真正的 .card 在 14442；且它根本不是"重复出现点"，而是被引作正例的目标原语本身。(2) 出现点#3 .resource-list__item(2584) 内容虽真，但全前端 .ts/.tsx 无任何引用，是死 CSS，不构成活跃的手写盒重复。(3) 
- **列表页搜索框 + 计数四处重复，可及名称直接复用 placeholder、结果计数播报不一致** —— 提案的两条核心卖点都站不住，且四处出现点的结构差异会把「内部固定输出 count+search」逼成 config 地狱或错位强塞。(1) role=searchbox 是白送的——四处全用 <input type="search">，原生隐式 ARIA 角色就是 searchbox，aria-label 已提供可及名称，无需新增。(2)「计数播报不一致」是伪命题：gallery(ResourceGalleryPage.tsx:137)
- **4 张 inventory 表（agents/skills/mcps/plugins）是同一份骨架的四次复制，只有列定义不同** —— 提案技术上可做（列数组 + per-column render 是表格抽象的标准形态，不会膨胀成 flag 地狱），但设计价值弱、性价比不足，且与既有意图测试冲突：

1. 抽出来防不了漂移，只减代码量（判据 4，impact 降级）。四个 leaf 的 cell 逻辑各不相同、都是 bespoke render：AgentsTable 的 model 列是 provider/id 复合带 ?/— 兜底；McpsTable 的 stat
- **展开/收起三角（▾/▸）在三处手写，reviews 表里的展开按钮自带一套 chrome** —— 4 个声称出现点行号全部真实，但去重后与提案形态相符者不足 3。(1) SkillFileTree.tsx:163 是伪出现点——`▸/·` 为静态文件/目录图标，dir 行 button 为 disabled、目录不可展开，`▸` 永不翻转是设计而非 bug，根本无 disclosure 语义。(2) WorktreeFilesPanel.tsx 遵循 ARIA tree 模式：aria-expanded 在 li[role=tree
- **非模态浮层（inline dialog / popover）各写一套 Escape + 外点关闭 + 焦点归还** —— 候选的事实前提站不住脚，且触碰的正是团队已经明确划定过的边界。

1) "各写一套 Escape + 外点关闭 + 焦点归还" 对 3 个引用点里的 2 个不成立：ValidationPanel.tsx:93 只有 Escape+焦点归还、**没有外点关闭**（且 compact 模式整段禁用）；ReviewDocPane.tsx:791 只有一条绑在 <TextArea onKeyDown> 上的 Escape、**既无外点关闭也无焦
- **详情页标题「任务名链接 / 节点名（· 版本）」三份手拼** —— 提案对三处调用点的事实描述不成立，且价值低于迁移代价。核实后三者是有意分叉、不是偶然漂移：

1) 提案的固定骨架「任务链接始终存在 → ' / ' → EntityTitle → muted 后缀」对 clarify 就是错的。clarify.detail.tsx 里 title 是 `hasTaskName ? (<Link>…</Link> + ' / ' + nodeLabel) : nodeLabel` —— 无任务名时整个标
- **「勾选框 + 标题 + 描述」的多选卡片列表 3 处各建一套命名空间** —— 三处行号均真实且内容对得上，但"同一个多选卡片原语"的前提不成立。核对 CSS：只有 pat-scopes__row 是真卡片（border+radius:8px+background+--checked 描边底色，垂直 body：title 13px/700 竖排 + desc 11px + code）。另两处是扁平单行 checkbox 行，无卡片 chrome、无选中态视觉：fusion-picker__row 用 align-i
- **PageSectionNav 的右侧面板被 memory/settings 各抄了一份（CSS 逐行相同）** —— 候选的两个 JSX 出现点属实（memory.tsx:290、settings.tsx:377 逐字对得上），header CSS 也确实字节级相同，但达不到抽取门槛，且核心论据有实质错误：

1. 【出现点不足 3】面板+header（h2 标题 + p 描述）这一形态只有 memory、settings 两处。第三个 PageSectionNav 消费方确实存在（tasks.detail.tsx:712），但它用的是 present
- **『key: value』元信息 dt/dd 栅格三套并存，标签列宽与断行规则不同** —— 三处 CSS 定义 styles.css:743/3066/3477 均真实存在、内容与候选逐字相符。但核心：styles.css:3066 的 .settings-grid 是死代码——frontend 源码(.tsx/.ts,排除 dist)grep 零命中(exit 1),无任何组件渲染。故候选主打 bug「同一 worktree 绝对路径在 /settings 里撑破栅格」属编造:/settings 根本无此 meta 栅格。真
