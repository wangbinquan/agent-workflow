# RFC-191 · 定义资源列表画廊化——工作流 / 工作组卡片列表

- 状态：Draft
- 日期：2026-07-15
- 发起：用户「调研工作流、工作组、任务、定时任务的界面表格显示的表现形式，看看有没有更合适的界面表现形式」→ 调研报告（session artifact《列表页形态调研》，含现状复现与方案渲染）→ 用户拍板**方案 A（卡片画廊）**，其余决策点（D2-D5）一并确认。
- 姊妹 RFC：[RFC-192 运行记录列手术](../RFC-192-run-record-list-surgery/proposal.md)（任务 / 定时任务，保留表格）。实现顺序 **191 先行**（本 RFC 落地 `<RelativeTime>` 公共原语，192 复用）。

## 1. 背景

全站列表页目前两代形态并存：

- **第二代**（RFC-169，2026-07-11）：agents / skills / mcps / plugins 四资源页已迁 `ResourceSplitPage` 双栏——左卡片栏（搜索 + 卡片 + 新建）+ 右详情，卡片零行内按钮、整卡可点。
- **第一代**：workflows / workgroups 仍是全宽 `data-table`。RFC-169 当时明确排除这两页（§3 非目标：「点开是画布 / 房间，右栏放不下详情」）——该判断只否定了**双栏**形态，不代表现状表格合适。

调研（2026-07-15）对两页的实测问题：

**工作流列表**（名称 · 版本 · ID · 操作）：
1. ID 列全量展示 26 字符 ULID 等宽字体，对用户几乎零价值，却是仅有的三个信息列之一；
2. `description` 字段存在、QuickCreate 对话框还让用户填，列表却不显示——最重要的辨识信息缺位；
3. 无更新时间、无节点数（列表 API 返回完整 `definition` 与 `updatedAt`，节点数可零成本客户端派生）;
4. 没有「启动任务」快捷动作——对工作流最高频的操作要绕道 /tasks/new 再手选，而任务向导已支持 `?kind=workflow&workflow=<id>` 深链（`tasks.new.tsx` validateSearch）；
5. 「打开」按钮与名称链接完全重复。

**工作组列表**（名称 · 模式 · 成员数 · Leader · 描述 · 更新时间 · 操作）：
1. 更新时间 `toLocaleString()` 全格式（精确到秒），又宽又噪——与任务页（相对时间）、定时任务页（短格式）三套并存；
2. 模式 / 成员数 / Leader 本质是一组「配置摘要」，摊开占三列；模式 chip 是普通 `.chip` 无语义色；`autonomous`（RFC-180 全自动）、`fanOut` 等开关在列表完全不可见；
3. 「打开」按钮同样冗余；
4. 删除确认走 `Dialog`（RFC-164 选型），而工作流列表走两击 `ConfirmButton`——同类操作两套确认模式。

两页同属**定义资源**：条目规模小（个位数到几十）、描述是辨识核心、详情是全页体验（画布 / 房间）。列表页的职责是「辨识 + 进入 + 启动」，不是数据网格。

## 2. 目标

1. **两页统一换成卡片画廊**：`repeat(auto-fill, minmax(300px, 1fr))` 网格；卡片 = 标题行（名称 + 徽标）→ 描述（两行截断）→ meta chips 行 → footer（相对更新时间 + 「启动」按钮）。骨架落成**公共组件**（新公共原语，遵守 Frontend UI consistency），两页复用同一实现。
2. **补齐缺位信息**：工作流卡片显示描述、`vN` 版本 chip、节点数 chip、相对更新时间；工作组卡片模式改 `StatusChip` 语义色（三模式三色），成员数 / leader / 全自动收进 meta chips。
3. **「启动」快捷动作**：卡片 footer 唯一行内按钮，深链 `/tasks/new?kind=workflow&workflow=<id>`（工作组 `?kind=workgroup&workgroup=<name>`），向导预填、无副作用、免确认（决策 D3）。
4. **整卡可点进详情**（画布 / 房间），沿 RFC-169「open = click」语言；「打开」按钮退场。
5. **搜索框**：名称 + 描述子串过滤，复用 `filterResourceCards`（RFC-169 T2 纯函数），与 split 页同口径。
6. **`<RelativeTime>` 公共原语落地**（决策 D4「相对时间 + title 绝对时间」为全站列表层标准），并**收敛**现存两套相对时间实现（`lib/homepage.ts#formatRelativeTime` token 版 / `routes/tasks.tsx#formatRelative` 字符串版）——本 RFC 落原语并接管本两页 + home 消费方，RFC-192 接管任务 / 定时任务 / repos。

## 3. 非目标

- **不改双栏四页**（agents / skills / mcps / plugins）；不把 workflows / workgroups 改成双栏（RFC-169 §3 的排除理由依然成立）。
- **列表层不做删除 / 导出**：删除与导出的既有入口已在详情层——工作流编辑器 header（`workflows.edit.tsx` 导出 YAML + 删除 ConfirmButton）、工作组详情 `DetailHeaderActions`（删除 + 启动）。卡片除「启动」外零按钮，**不新造 Menu/kebab 原语**（调研 mockup 里的「⋯」按此决策取消；若未来确需列表级批量删除，另立小 RFC）。工作组列表现有的删除 `Dialog` 代码随迁移退役。
- **不改 QuickCreate 流程**：两页的快速创建对话框（名称 + 描述）原样保留，触发按钮仍在页 header；创建成功后跳编辑器 / 详情的现行为不变。工作流「导入 YAML」按钮及冲突处理流程原样保留。
- **零后端改动**：纯前端 RFC。列表 API、ACL 过滤、owner 查询（`useResourceList`）全部复用。
- **不做排序控件**：卡片按 `updatedAt` 降序固定排列（新鲜的在前）。
- **不做列表级 WS 订阅**（现状两页也没有；query invalidation 行为不变）。
- **空态保持字节级现状**：列表为空时渲染与今天相同的 header + `EmptyState`（搜索框仅在有条目时渲染）——e2e 视觉基线 `workflows.png` 零 churn。
- 移动端专属布局不做（与 RFC-169 同口径）；网格 `auto-fill` 天然降级单列。

## 4. 用户故事

1. 我打开 `/workflows`，看到一片卡片：每张有名称、描述、`v7`、`6 节点`、「更新于 2 天前」。我认出要跑的流，点卡片进画布改两笔；回来点它 footer 的「启动」，直接落在任务向导第三步（工作流已选好）。
2. 我的工作组有八个，我在搜索框敲 `review`，名称或描述命中的卡片立刻过滤出来；`code-review-squad` 卡片上蓝色的「Leader-Worker」、「4 成员」、「leader: lead-reviewer」一眼可辨，旁边全自动的组带着「全自动」chip。
3. 一个没填描述的工作流卡片显示斜体「（未填写描述）」占位——我意识到该补描述了（而不是像今天根本不知道列表能显示描述）。
4. 我想删掉废弃的工作流：点卡片进画布，右上角删除（与今天编辑器里的删除同一个按钮）。列表上不再有一排危险的红色删除按钮。

## 5. 交互规格

### 5.1 页面布局

```
┌──────────────────────────────────────────────────────────┐
│ 工作流                                [导入 YAML][+ 新建工作流] │  ← .page__header（现状结构）
│ [🔍 搜索名称 / 描述…]                                        │  ← 仅 items>0 时渲染
│ ┌───────────────┐ ┌───────────────┐ ┌───────────────┐    │
│ │ code-audit-fix │ │ nightly-… 私有 │ │ docs-sync      │    │  ← auto-fill minmax(300px,1fr)
│ │ 代码→审计→修复… │ │ 夜间全仓清扫…   │ │ （未填写描述）   │    │
│ │ [v7][6 节点]    │ │ [v3][4 节点]   │ │ [v1][2 节点]   │    │
│ │ ──────────────│ │───────────────│ │───────────────│    │
│ │ 2 天前   [启动] │ │ 8 小时前 [启动] │ │ 3 周前  [启动] │    │
│ └───────────────┘ └───────────────┘ └───────────────┘    │
└──────────────────────────────────────────────────────────┘
```

### 5.2 卡片规格（两页共用槽位）

| 槽位 | 工作流 | 工作组 |
| --- | --- | --- |
| 标题 | `name`（单行截断，title 悬停全文） | `name` |
| 徽标 | `ResourceBadges`（私有 chip + owner） | 同左 |
| 描述 | `description` 两行截断；空 → 斜体占位「（未填写描述）」 | 同左 |
| meta chips | `v{version}`、`{n} 节点`（`definition.nodes.length`） | 模式 StatusChip（leader_worker=info / free_collab=neutral / dynamic_workflow=warn）、`{n} 成员`、`leader: {name}`（仅 leader_worker 且可解析）、`全自动`（`autonomous===true`） |
| footer 左 | `<RelativeTime ts={updatedAt}>` | 同左 |
| footer 右 | 「启动」`btn btn--sm btn--primary` → `/tasks/new?kind=workflow&workflow={id}` | 「启动」→ `/tasks/new?kind=workgroup&workgroup={name}` |
| 整卡点击 | `/workflows/$id`（画布） | `/workgroups/$name`（房间） |

### 5.3 行为细则

- **整卡可点 + footer 按钮共存**：卡片主链接用 stretched-link 模式（真实 `<a>` + 绝对定位铺满层），footer 按钮更高 z-index——不出现 `<a>` 嵌套 `<a>`（详见 design §2）。
- **搜索**：本地 state，不进 URL；空串恒等返回（`filterResourceCards` 语义）；过滤后无命中显示 `common.noMatches` 紧凑空态（split 页同款），与「列表本身为空」的空态文案区分。
- **排序**：`updatedAt` 降序，装配层 `useMemo` 排序（shell 组件不感知）。
- **删除入口迁移**：工作组列表现有 `Dialog` 删除 + 工作流列表 `ConfirmButton` 删除随迁移移除；两页删除唯一入口 = 详情层（已存在，无需新增）。

## 6. 验收标准

1. `/workflows`、`/workgroups` 渲染卡片画廊，无 `data-table`；两页卡片视觉完全同构（同一公共组件）。
2. 工作流卡片可见：描述（或占位）、版本、节点数、相对更新时间、私有/owner 徽标；工作组卡片可见：模式语义色 chip、成员数、leader、全自动 chip、描述、相对更新时间。
3. 点卡片体 → 进画布/房间；点「启动」→ 任务向导对应主体已预填；键盘 Tab 可依次聚焦卡片链接与启动按钮。
4. 搜索框过滤名称+描述；列表空时搜索框不渲染、空态与改版前字节一致（`workflows.png` 基线零 churn）。
5. QuickCreate、导入 YAML 流程与改版前行为一致（既有测试断言迁移后仍绿）。
6. `bun run typecheck && bun run lint && vitest && format:check` 全绿；e2e（含 visual-regression）全绿。
