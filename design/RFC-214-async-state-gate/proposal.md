# RFC-214 三态闸门 `<QueryState>` + `ErrorBanner.onRetry`（产品视角）

> 状态：Draft（待用户批准进入实现）
> 来源：`design/frontend-primitive-audit-2026-07-21.md` §0 TL;DR 第 2 条、§2 P0 首项。全仓审计（534 agent / 160 确认）把「空/加载/错误三态绕开公共原语」列为**单一最大痛点**（41 条确认 / 23 条 high）。
> 前置关系：**完成 RFC-203 T5b 主动留下的下一步**——RFC-203 `design.md:124` 当时有意把 home 三处 retry 按钮留在 `action` 槽手写、只给 ErrorBanner 加了 testid；本 RFC 把这条尾巴收干净。

## 1. 背景

前端的设计系统本身是健康的（96 个 CSS 变量、2159 处 `var()` 引用），三态原语也早已存在：

- `LoadingState`（RFC-035，`components/LoadingState.tsx`）——转圈 + 文案，`role=status`。
- `EmptyState`（RFC-035，`components/EmptyState.tsx`）——icon + title + description + action。
- `ErrorBanner`（RFC-203，`components/ErrorBanner.tsx`）——结构化错误 + `action` 槽 + 可选 `onDismiss`。

问题不在「没有原语」，而在**把它们串起来的组合层缺失**，于是每个「一个查询 → 一段列表/详情」的渲染点都各自手拼三态级联：

```tsx
if (tasks.isLoading) return <LoadingState size="compact" />
if (tasks.error != null) return (
  <ErrorBanner error={tasks.error} message={t('home.section.error.generic')}
    action={<button type="button" className="btn btn--xs" onClick={() => void tasks.refetch()}>
      {t('home.section.error.retry')}</button>} />
)
if (running.length === 0) return <div className="muted">{t('home.section.empty.running')}</div>
return <div className="task-list">…</div>
```

（真实样本：`components/home/RunningTaskList.tsx:50-79`。）

### 已经产生的、可见的不一致（不是理论重复）

1. **重试按钮尺寸分裂**：`home/*` 用 `.btn--xs`，`memory/*`、`SkillFileTree.tsx` 用 `.btn--sm`——同一个「重试」在不同页面大小不一。（实测：非测试 tsx 里查询 retry 跨 **16 个 i18n 键**，`common.retry`×83 之外还有 `home.section.error.retry`×4、`skills.zipRetry`×3、`reviews.retry`×2 等；home 是**唯一**仍用 xs 的查询 retry，其余多已 sm。）
2. **空态观感不一**：`className="muted"` 实测 **109 处**，但其中真正的「查询空态」（引用 empty 类键）只有 **约 12 处** + 一批 `no*`/`none*`/`outputNone` 型键；其余 ~90 处是 hint 小字 / 时间戳缺省 / 内联占位（如 `common.empty` 的「值为空」），**不是迁移目标**。真实痛点：这十几处查询空态 vs 少数 `<EmptyState>` 重量级空态，同类「暂无数据」长得不一样。
3. **重试文案键三分五裂**：`common.retry` / `home.section.error.retry` / 各功能域自造键并存。
4. **`ErrorBanner` 缺 `onRetry`**（当前只有 `action?: ReactNode`）——这是根因：既然没有内置重试，每个失败点只能往 `action` 槽手塞一个 `<button>`，尺寸/文案/写法自然各写各的。
5. **列表页三态已被三个壳集中、但仍是并行 chrome**：`ResourceSplitPage`（`:344-347`→`:389`）、`ResourceGalleryPage`（`:95-98`→`:123`）、`tasks.preview.tsx` 的 RetryAction 已各自把列表三态收进壳（且已 `.btn--sm`+`common.retry`）——agents/skills/mcps 等**本就走壳**。所以真正的手写三态集中在 home / memory / 详情页 / 各组件；列表页需要的是**收编这三个壳**（否则 QueryState 上线＝第 4 个并存 gate＝新漂移源）。

## 2. 目标 / 非目标

### 目标
- **G1**：给 `ErrorBanner` 加 `onRetry?`（+ `retryLabel?`），把「重试」按钮做成组件内置的**唯一实现**，统一尺寸为 `.btn--sm`、默认文案 `common.retry`。
- **G2**：新建 `<QueryState>` 组合原语，一次性表达 loading / error(+retry) / empty / data 四态级联，消灭手拼三态。
- **G3**：**全量清扫**——把全仓手写查询三态迁到新原语：约 83 处手写 retry（收编三壳 + home/memory/详情页/组件）+ 查询空态子集（~12 empty 键 + `no*`/`none*` 型，**非** 109 处 muted 全量）（按目录分片、分 PR）。
- **G4**：落 **防漂移锁**——但**用结构信号 / 组件锚点，不用文案子串**（BLOCKER-2/3：retry 跨 16 键、mutation retry 同文件共存、muted 109 里仅 12 是空态，文案锁两头塌）。锁 A 收敛「手写 `<button onClick>…refetch()`」（诚实声明图标/`<Trans>`/新键 grep 不到）；锁 B 约束「查询空态走 QueryState 的 `emptyText`/`empty`」。这是本 RFC「防未来不一致」而非「减代码量」的凭据；其**剩余约束力如实写在 design.md §5.2**，不夸大。

### 非目标
- **不**改 `ErrorBanner` 的错误解析链（`resolveApiError` / `ErrorDetails`，RFC-203 资产原样保留）。
- **不**改 `EmptyState` / `LoadingState` / `NoticeBanner` 的对外 API（仅被 `QueryState` 组合调用）。
- **不**触碰 mutation 的错误展示（本 RFC 只管**查询**三态；表单提交错误是 RFC-C/RFC-203 的地盘）。
- **不**统一空态**视觉重量**（MAJOR-6 澄清）：本 RFC 统一的是**机制**——所有查询空态收敛到 `QueryState` 一个组件，日后要改空态观感是**一处改、全站生效**（US3 在机制层成立）；两档（muted / EmptyState）是**有意的密度选择、不算漂移**。不把 ~90 处非空态 muted、也不把十几处查询 muted 空态**一律升级**成重量级 EmptyState（那是需要产品拍板的视觉重设计，不在本 RFC）。锁 B 只保证「不再有人在 QueryState 之外手拼查询空态」。
- **不**收编 `WorkflowCanvas` / `components/canvas/**` 画布内的三态（xyflow 渲染约束，守卫 scope carve-out）；`NodeDetailDrawer` 的 muted 多为内联占位 + mutation retry，判定为范围外（design.md §5.2）。

## 3. 用户故事

- **US1（开发者）**：我写一个新列表页，只需 `<QueryState query={list} emptyText={t('…empty')}>{data => …}</QueryState>`，不用再记「loading 用哪个 size、error 要不要挂 retry、空态用 muted 还是 EmptyState」——原语替我保证一致。
- **US2（终端用户）**：任何页面的「加载失败」都长一样、重试按钮一样大、点了就重试，不再出现「这个页面能重试那个页面只能刷新」。
- **US3（维护者）**：我想把某类空态整体换个观感，只改 `QueryState` 一处，全站生效；CI 的 grep 锁保证没人偷偷绕开再写一版。

## 4. 验收标准

- **AC1**：`ErrorBanner` 传 `onRetry` 时渲染一个 `.btn .btn--sm` 的重试按钮（文案 `retryLabel ?? t('common.retry')`）进 `action` 槽；同时传了 `action` 则 `action` 优先（向后兼容 RFC-203 现有调用点，零涟漪）。
- **AC2**：`<QueryState>` 按 **loading（`isLoading` 优先，`enabled:false` 门控查询不误转圈）→ error(onRetry=refetch) → empty → data** 顺序渲染；`data` 支持传入**派生/过滤后的值**（覆盖 `running.length===0` 这类 data 非空但结果空的场景）；`isEmpty` 可自定义，默认「空数组 / null / undefined」为空。
- **AC3**：`emptyText` 走轻量 `<div className="muted">`；`empty={<EmptyState…/>}` 走重量级；两者都不传且非空数组为空时渲染 `null`（与现状一致）。
- **AC4（BLOCKER-1）**：`keepDataOnError` 时，`error!=null` 且 `data` 非空 → **叠加**渲染 ErrorBanner + `children(data)`（覆盖 memory 面板「刷新失败保留缓存行」契约）；默认 false 为短路。
- **AC5（MAJOR-5）**：`ErrorBanner` 只传 `onRetry`（无 `action`）时，根节点仍带 `error-banner--with-action`（flex 行布局不回归）。
- **AC6（防漂移锁，BLOCKER-2/3）**：源码守卫用**结构信号 + 组件锚点**——锁 A 禁「非白名单文件里手写 `<button onClick>` 闭包直链 `.refetch()`」（不碰 `mutation.mutate()`）；锁 B 约束「显式空态键清单中的键只能经 QueryState 的 `emptyText`/`empty` 呈现、不得手拼 `<div className="muted">`」；白名单为**文件 + i18n 键**级，`components/canvas/**` 与 `NodeDetailDrawer` carve-out。剩余约束力如实记于 design.md §5.2。
- **AC7**：全量迁移后 `bun run typecheck && bun run test && bun run format:check` + **前端 vitest 全套** + 单二进制冒烟 + 相关视觉基线全绿；每个迁移 PR 单独达标。
- **AC8**：RFC-203 的 7 个既有 testid 锚点原样绿；`memory-panels-async-state.test.tsx` 的「保留缓存行」断言**迁移后仍绿**（memory 面板传 `keepDataOnError`）；`empty-state.test.tsx` 原样绿——**同 commit 适配**（改断言不删测试，注释写明意图）。
