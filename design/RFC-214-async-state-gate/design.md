# RFC-214 技术设计

> 权威源码引用均来自 `packages/frontend/src`（除非另注）。

## 1. 接口契约

### 1.1 扩展 `ErrorBanner`（`components/ErrorBanner.tsx`，最小扩展）

```tsx
interface ErrorBannerProps {
  error: unknown
  message?: string
  action?: ReactNode
  onRetry?: () => void          // ← 新增
  retryLabel?: string           // ← 新增，默认 t('common.retry')
  onDismiss?: () => void
  overrides?: Record<string, string>
  testid?: string
}
```

**行为**（渲染进 `NoticeBanner` 的既有 `action` 槽，不新增 DOM 层级）：

```tsx
const resolvedAction =
  action !== undefined && action !== null && action !== false
    ? action                                    // 显式 action 永远优先（向后兼容 RFC-203）
    : onRetry !== undefined
      ? <button type="button" className="btn btn--sm"
          onClick={() => { onRetry() }}>{retryLabel ?? t('common.retry')}</button>
      : undefined
```

传给 `NoticeBanner` 的是 `action={resolvedAction}`。**关键（MAJOR-5 修正）**：现有 `ErrorBanner.tsx:40` 的 `hasAction` / `:49` 的 `className` 目前算自**原始 `action`**——若只把 action 槽换成 `resolvedAction` 而 `hasAction` 仍读原始 `action`，则「只传 `onRetry`」的 banner 会拿到 `'error-box'`（缺 `error-banner--with-action`），重试按钮进了槽却丢掉 `styles.css:1530/:1537` 的 flex 行布局（样式回归）。故必须改成：

```tsx
const hasAction = resolvedAction !== undefined && resolvedAction !== null && resolvedAction !== false
// className / NoticeBanner action 均基于 resolvedAction 计算
```

- `action` 优先保证 RFC-203 已迁移的调用点（含 `home` 三处、22 处 error-box）**零行为变化**；它们后续在迁移 PR 里改成传 `onRetry`。
- 按钮统一 `.btn .btn--sm`（用户拍板 canon）。不引入 xs/sm 联动，规则越简单越防漂移。
- `onClick` 里**不 `void`**——`onRetry` 签名是 `() => void`，调用方若要 `refetch()` 自行在闭包里 `void query.refetch()`（`QueryState` 会替它包好，见 1.2）。

### 1.2 新建 `<QueryState>`（`components/QueryState.tsx`）

```tsx
// 只依赖 TanStack Query 结果对象的一个子集，便于手构 / 测试。
interface QueryLike {
  isPending?: boolean
  isLoading?: boolean
  error?: unknown
  refetch?: () => unknown
}

interface QueryStateProps<T> {
  query: QueryLike
  data: T                                    // 可为派生/过滤值；决定 empty 与 children 入参
  isEmpty?: (data: T) => boolean             // 默认：Array.isArray→length===0；否则 data==null
  children: (data: T) => ReactNode           // 仅在「非 loading / 非 error / 非 empty」时调用

  // loading
  loadingLabel?: string
  loadingSize?: 'compact' | 'comfortable'    // 默认 comfortable（与 LoadingState 一致）

  // error
  errorMessage?: string
  errorOverrides?: Record<string, string>
  retryLabel?: string
  onRetry?: () => void                       // 默认 () => void query.refetch?.()

  // empty（两档，默认轻量）
  emptyText?: string                         // 轻量：<div className="muted">{emptyText}</div>
  empty?: ReactNode                          // 重量：调用方传 <EmptyState …/>（empty 存在则忽略 emptyText）

  // error + 缓存数据（BLOCKER-1）
  keepDataOnError?: boolean                  // 默认 false=短路；true=error 且 data 非空时叠加渲染 ErrorBanner + children(data)

  testid?: string                            // 透传给当前呈现的子原语
}
```

**渲染顺序（短路，除非 `keepDataOnError`）**：

```
0. loading = query.isLoading ?? query.isPending ?? false           // MAJOR-4：isLoading 优先
   → <LoadingState size={loadingSize} label={loadingLabel} data-testid={testid} />
1. errored = query.error != null
   errorBanner = <ErrorBanner error={query.error} message={errorMessage} overrides={errorOverrides}
        onRetry={onRetry ?? (query.refetch ? () => { void query.refetch!() } : undefined)}
        retryLabel={retryLabel} testid={testid} />
2. // BLOCKER-1：有缓存数据又刷新失败 —— 叠加而非抹掉
   if (errored && keepDataOnError && !isEmptyFn(data)) → <>{errorBanner}{children(data)}</>
3. if (errored) → errorBanner                                       // 无缓存数据 / 未开 keepDataOnError：短路
4. empty = (isEmpty ?? defaultIsEmpty)(data)
   → empty ?? (emptyText != null ? <div className="muted">{emptyText}</div> : null)
5. 否则 → <>{children(data)}</>
```

- **`isLoading ?? isPending`（MAJOR-4 修正）**：TanStack Query v5 里 `enabled:false` 的 disabled 查询是 `status='pending' + fetchStatus='idle'` → **`isPending===true` 但 `isLoading===false`**。若取 `isPending` 优先，`FilesPicker`(`:48 enabled`)/`SkillFileTree`(`:77 enabled`)/`InboxDrawer`(`:38/45/54 enabled`) 这类门控查询会**永久转圈**。`isLoading` 同时满足「首屏无数据=true / 后台 refetch=false / disabled=false」三条，匹配仓里全部现有三态门控（它们全用 `.isLoading`）。回退 `isPending` 仅为兼容手构对象。（旧「233 vs 139」论证作废：那把 `mutation.isPending` 的按钮禁用旗标误算进了查询 loading。）
- **`keepDataOnError`（BLOCKER-1 修正）**：memory 面板family（`MemoryDistillJobsTable.tsx:62-64`、`MemoryScopedList.tsx:52`、`MemoryByScopeBrowser.tsx:43`、`MemoryAllList.tsx:242`、`MemoryApprovalQueue.tsx:77/89`）刻意在「刷新失败」时**保留缓存行**并把 ErrorBanner 摞在上方——这是硬契约（`tests/memory-panels-async-state.test.tsx:1-6` 头注 + `:201` 用例名「a refetch failure keeps cached distill rows」+ `:210/:220/:225` 断言）。纯短路会抹掉这些行、违约。这些面板迁移时传 `keepDataOnError`。默认 false 保短路（多数列表不需要）。
- **`data` + `isEmpty` 解决派生空态**：`RunningTaskList` 传 `data={running}`（已过滤），`isEmpty` 默认判 `running.length===0`——纯 `query=` API 做不到这点，这是本 API 必须带 `data` 的原因。
- **`children` 是 render-prop 而非 `data` 直渲**：让调用点在「确有数据」分支拿到 narrowed `data`，且不强迫把渲染搬进 QueryState。

## 2. 数据流

```
useQuery() ─┬─ query（isPending/error/refetch）──▶ QueryState.query
            └─ query.data ──(调用点可 filter/map)──▶ QueryState.data
QueryState ──┬─ loading ─▶ LoadingState (RFC-035)
             ├─ error   ─▶ ErrorBanner (RFC-203) ─▶ onRetry ─▶ query.refetch()
             ├─ empty   ─▶ muted 行 | 调用方 EmptyState (RFC-035)
             └─ data    ─▶ children(data)
```

无新增全局状态、无 store、无 WS 订阅——纯呈现组合。retry 就是调用 `query.refetch()`，由 TanStack Query 负责重取与缓存。

## 3. 与现有模块的耦合点

| 模块 | 关系 | 约束 |
|---|---|---|
| `ErrorBanner`（RFC-203） | 扩展加 `onRetry`/`retryLabel` | `action` 显式传入时优先，保 RFC-203 T5b 的 22 处 + home 3 处零涟漪；7 个 testid 锚点不动 |
| `LoadingState` / `EmptyState`（RFC-035） | 组合调用 | 对外 API 不改；`QueryState` 内部消费 |
| `NoticeBanner`（RFC-198） | 间接（经 ErrorBanner） | retry 按钮进其 `action` 槽，不新增 chrome |
| i18n（`common.retry`） | 复用既有键 | `common.retry='Retry'` 已存在（en-US.ts:234 / zh-CN 对应）；本 RFC **不新增 key**，迁移时把 `home.section.error.retry` 等各自键收敛到默认或经 `retryLabel` 保留 |
| `.btn .btn--sm`（styles.css） | 复用 | 无新 CSS；home 的 xs→sm 是唯一视觉变化点 |
| `ResourceSplitPage`（`:344-347 retryAction`→`:389`）/ `ResourceGalleryPage`（`:95-98`→`:123`）/ `tasks.preview.tsx` RetryAction | **收编**（MAJOR-6） | 列表页三态**早已被这三个共享壳集中**、且已是 `.btn--sm` + `common.retry`。所以 QueryState 若不收编它们就会成为**第 4 个并存 gate**＝新漂移源。方案：三壳内部改用 `ErrorBanner.onRetry`（它们已 sm+common.retry，收编=纯内部简化）；收编前先登记进 §5.2 白名单豁免。agents/skills/mcps 等列表页**本就走壳**，T5 因此不是「迁移手写三态」而是「收编壳」——见 plan.md T5 修正。 |

## 4. 失败模式与边界

1. **`data` 非空但语义空**（派生过滤）：靠 `isEmpty` 覆盖；调用点不传 `isEmpty` 且传的是过滤后数组时默认判 length 正确。
2. **`error` 与 `data` 同时存在**（TanStack 有缓存旧数据又报错）：**默认短路**只展示 ErrorBanner（与多数列表手写 `if error return` 一致）；**传 `keepDataOnError` 则叠加**渲染 ErrorBanner + `children(data)`，覆盖 memory 面板「刷新失败保留缓存行」的硬契约（见 §1.2 BLOCKER-1）。
3. **`enabled:false` 门控查询**（MAJOR-4）：`isLoading===false` ⇒ 默认**不显 LoadingState**（否则 disabled 查询永久转圈）；配套单测锁定（§5.1）。
4. **`refetch` 缺失**（手构 query 对象没给）：`onRetry` 回退为 `undefined`，ErrorBanner 不渲染重试按钮——与「没有 retry 能力」的现状等价，不报错。
5. **loading 抖动**：沿用 `LoadingState`，无防抖（现状也无）；不在本 RFC 引入 skeleton。
6. **children 抛错**：QueryState 不加 error boundary（现状也无）；保持透明。
7. **多查询联合**（一个渲染点 gate 多个 query）：不强套 QueryState，允许手写；这类点由 grep 锁的白名单显式豁免（见 §5），避免为「多 query」把 API 撑成 config 地狱。

## 5. 测试策略（前端跑 **vitest**，不在 `bun test` 覆盖内）

### 5.1 新原语单测
- `tests/query-state.test.tsx`（新）：
  - loading：`isLoading=true` → LoadingState，透传 size/label/testid；**disabled 查询**（`isPending=true, isLoading=false, data=undefined`，MAJOR-4）→ **不渲染 LoadingState**；
  - error → 渲染 ErrorBanner，`onRetry` 缺省时点重试触发 `query.refetch`；
  - **`keepDataOnError`（BLOCKER-1）**：`error!=null` 且 `data` 非空 + `keepDataOnError` → **同时**渲染 ErrorBanner **和** `children(data)`；不开该 prop 则只渲染 ErrorBanner（短路）；
  - empty 轻量（`emptyText`）→ `div.muted`；empty 重量（`empty=<EmptyState>`）→ EmptyState；两者都无 → `null`；
  - 派生空（`data=[]` filtered，默认 isEmpty）与自定义 `isEmpty`；
  - data → `children(data)` 收到 narrowed 值。
- `tests/error-banner-retry.test.tsx`（新）：
  - `onRetry` → 渲染 `.btn.btn--sm`，`findByRole('button', {name: /retry|重试/})` 点击触发回调；
  - **onRetry-only 时根节点含 `error-banner--with-action`（MAJOR-5，锁 flex 布局不回归）**；
  - 同时传 `action` → action 优先、不渲染内置按钮（锁向后兼容）；
  - `retryLabel` 覆写文案。

### 5.2 防漂移源码守卫（**结构信号 + 快照枚举**，不用文案子串；遵 [feedback_grep_locks_before_push]）

> **BLOCKER-2/3 修正**：原「grep retry/empty 文案子串」判据两头塌——① retry 按钮实测跨 **16 个 i18n 键**（`common.retry`×83 之外还有 `home.section.error.retry`、`skills.zipRetry`、`reviews.retry` …），文案锁既抓不到这些清扫目标、也拦不住新键 `foo.tryAgain`/图标按钮/`<Trans>`；且会**误伤 mutation retry**（`NodeDetailDrawer.tsx:193 retry.mutate`、`MemoryDistillJobsTable.tsx:111/119 action.mutate` 与查询 retry `:38` **同文件**共存，文件级白名单隔不开）。② `className="muted"` 实测 109 处但引用 empty 键的仅 **12**，其余是 hint/时间戳/内联占位（`NodeDetailDrawer.tsx:299 common.empty` 绝不该迁）；`empty` 子串既**漏**真空态（`AclPanel.tsx:225 noMembers`、`NodeDetailDrawer.tsx:288 outputNone`、`:536 noEventsMatch` 键名不含 empty）又**误伤**内联占位。

`tests/async-state-gate-source-guard.test.ts`（新），两条锁均**用组件/结构信号，不用文案关键字**：

- **锁 A — 手写 refetch 按钮收敛（结构信号）**：扫非测试 tsx，禁止「`<button>` 的 `onClick` 闭包里直接链 `.refetch()`」这一结构，**只允许** `ErrorBanner.tsx` / `QueryState.tsx` / 收编后的三壳（见 §3）。**明确不碰 `mutation.mutate()` 的重试**（那是 mutation retry，非本 RFC 范围）。RFC 如实声明：图标按钮 / `<Trans>` / 新造文案键的重试**无法从文本 grep**，本锁只保证「手写 refetch 按钮」这一类收敛——这是诚实的剩余约束力，不夸大成「拦截任意新 retry」。
- **锁 B — 查询空态走组件锚点（非文案子串）**：约定**查询空态一律走 QueryState 的 `emptyText`/`empty`**；锁断言「一个显式空态 i18n 键清单」（常量数组，含 `no*`/`none*`/`outputNone`/`noEventsMatch`/`sourceDeleted` 等真实键、**排除 `common.empty` 等内联占位**）中的键，不得再出现在 `<div className="muted">{t(<清单键>)}</div>` 的手写结构里（只允许 QueryState.tsx）。内联占位（值为空、时间戳缺省）不受此锁。
- **扫描 scope carve-out**：`components/canvas/**` 整体排除（xyflow 非目标，与 §6/proposal 一致）。`NodeDetailDrawer.tsx`（节点 inspector，9 muted 多为内联占位 + mutation retry）**判定为范围外**，登记进白名单豁免并注释原因。
- **白名单粒度 = 文件 + i18n 键**（非仅两文件）：显式枚举 mutation-retry 豁免文件（`NodeDetailDrawer` / `BatchImportDialog` / `WorkflowDraftStatus` / `InboxDrawer` / `MemoryDistillJobsTable` per-row action）；若豁免项多于受管项，在本节**如实写明锁的剩余约束力**。
- 守卫用**允许清单 + 命中集**而非逐文件禁止，新增文件默认纳管。

**已实现（PR-5，`tests/async-state-gate-source-guard.test.ts`）**：
- **锁 A**（结构信号）：正则 `onClick={…refetch(…)`（含裸 `refetch()`——实现门 P1-1 修订 2026-07-21，`\brefetch\(` 覆盖解构形态） / `onClick={(x.)?refetch}` 扫非测试 tsx，命中集 ⊆ `ALLOW_RETRY = { routes/tasks.detail.tsx（room 复合 Details+retry 双按钮）, components/home/CapabilityGrid.tsx（低调内联叠加）, routes/reviews.tsx（bespoke reviews-version-error 内联条）}`。另一条测试反向保证 allowlist 不注水（每个条目仍须命中，否则提示删除）。ErrorBanner/QueryState 自身断言 0 手写 refetch 按钮。
- **锁 B**（快照 ratchet）：正则 `<div className="muted">{t('<非 common.empty 的 empty 类键>')` 命中集 ⊆ `ALLOW_EMPTY`（11 个 bespoke/内联面板：AclPanel/WorktreeFilesPanel/NodeDependencyTreeSection/FuseDialog/McpInventoryPanel/SourceEventsList/BatchImportDialog/TaskMembersPanel + 实现门 P1-2 修订新增 TaskDiagnosePanel〔数据内空集〕/RepairChoiceDialog〔dialog picker〕/tasks.new〔向导分支〕——旧紧邻正则对带属性/换行失明的三个活体，修正后正则 `className="muted"[^>]*>\s*{t(` 穿透属性与换行）。**诚实降级**：RFC-214 收编了全部 retry 按钮并迁移了 home 的干净列表 cascade，但多数 muted 空态是**多查询/草稿编辑器/bespoke 双叠加/内联占位**，QueryState v1 不宜硬套（设计门警告的 config 地狱），故 allowlist grandfather 现存、只禁新增（新列表页须走 QueryState.emptyText/empty）。
- **carve-out**：`components/canvas/**` + `NodeDetailDrawer.tsx` 从扫描排除。
- **变异验证**：非白名单文件注入手写 refetch 按钮 → 锁 A 必红；注入 muted 空态 → 锁 B 必红（已实测）。
- **已知盲区（不夸大）**：图标按钮 / `<Trans>` / 新造文案键 / `mutation.mutate()` 的 retry 不在锁 A 覆盖内；锁 B 只认清单内的空态键形态。

### 5.3 既有测试同 commit 适配（改断言不删测试，注释写明意图）
- `memory-panels-async-state.test.tsx`：**该套锁死「刷新失败保留缓存行」**（`:1-6` 头注、`:201` 用例名、`:210/:220/:225` 断言）。memory 面板迁移**必须传 `keepDataOnError`**（BLOCKER-1），迁移后**「保留 rows」的断言必须仍绿**——不是「DOM 不变大概率绿」，而是**功能契约必须继续满足**，同 commit 核。
- `empty-state.test.tsx`：EmptyState 本体不改，应原样绿。
- RFC-203 的 7 个 testid 锚点：ErrorBanner 加 `onRetry` 不改 testid 透传，应原样绿；逐一核。
- home 视觉：`home` 是**唯一** xs 查询 retry（memory 查询 retry 已是 `.btn--sm`，`MemoryDistillJobsTable.tsx:38`），xs→sm 变化**只在 error 态可见**；home e2e 视觉基线（`e2e/visual-regression.spec.ts-snapshots/homepage-chromium-{darwin,linux}.png`）截的是正常态，**多半无需刷基线**——按 [feedback_frontend_visual_verify_repro] 亮/暗截图核对 error 态即可；确需刷再走 [reference_visual_baseline_stale_binary]。

### 5.4 迁移 PR 的通用门槛
每个迁移分片 PR：`bun run typecheck && bun run test && bun run format:check` + 前端 vitest 全套 + 单二进制冒烟；push 后按 [feedback_post_commit_ci_check] 查 CI。

## 6. 迁移中的多人并行树纪律

- `components/canvas/**`、i18n 双 bundle、`styles.css` 是高频并发文件——本 RFC 基本不碰 canvas 与 styles.css（无新 CSS）；i18n 也不新增 key，冲突面小。
- 提交按精确路径 `git commit -- <paths>` 一次成型（[feedback_shared_index_commit_race]），绝不 `git add -A`，绝不 `--amend`（[feedback_no_amend_on_shared_tree]）。
- 迁移触及别人正改的文件时，只改自己那几处三态、保留他人 hunk，冲突先问（[feedback_dont_delete_others_code_for_ci]）。
