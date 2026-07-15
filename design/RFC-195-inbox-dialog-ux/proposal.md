# RFC-195 — 收件箱弹窗 UX 重构

> **状态**：已批准并完成本地实现；等待 Linux 视觉基线回填与最终 CI 收口。
>
> **触发**：2026-07-15 用户「优化下收件箱弹窗的 ux 设计」。
>
> **范围**：纯前端交互与视觉重构；不新增待办类型，不改后端 API / DB / ACL / WS。

## 1. 背景与现场证据

当前 `InboxDrawer` 仍是 RFC-032 时期的自定义 portal 浮层。后来仓库已经有完整的共享
`<Dialog>`、`<Segmented>`、`<EmptyState>`、`<LoadingState>`、`<ErrorBanner>` 与
`<RelativeTime>`，但收件箱没有迁移，形成了一个明显的 UX 孤岛。

本次对当前 dev 页面做了桌面与 390×844 窄屏复现：

- 桌面空态是一块从 `top:16px` 撑到 `bottom:16px` 的 360px 白板，没有标题、关闭按钮、
  待办数量与上下文说明；两条历史入口被压在最底部，空白区域占据绝大多数视觉重量。
- 窄屏下浮层仍是 `left:240px;width:360px`，实测边界为 `left=240/right=600`，在
  390px viewport 上向右溢出 **210px**，主体内容与关闭路径均不可达。
- 组件只有 `role="dialog"`，没有 `aria-modal`、标题关联、焦点陷阱、关闭后焦点恢复与
  body scroll lock；这些能力共享 `<Dialog>` 已全部提供。
- “全部 / 评审 / 反问”是手写 tab chrome，没有数量反馈；重新打开时即使上次选中的不是
  “全部”，初始焦点仍强制落到“全部”。
- 行只显示类型色块、单行截断标题与多层来源文字；`createdAt` 只参与排序，不展示时间；
  用户难以快速判断“是什么、从哪来、多久前、是否紧急”。
- loading/error/empty 判定分散在 JSX：empty 没有等待 workgroup feed settled，也不排除
  feed error，可能出现“加载失败”和“当前没有待办”同时表达相反结论。
- review / clarify 行点击后浮层仍开着，用户还要再关一次才能处理详情；workgroup 行却会关闭，
  同一收件箱存在两种导航反馈。

## 2. 目标

1. 让收件箱在桌面上成为清晰、紧凑的任务型 side dialog，在窄屏上成为完整可用的全屏 sheet。
2. 第一眼回答四个问题：**还有多少、分别是什么、来自哪里、多久以前**。
3. loading / partial-error / all-error / empty / content 五态互斥且 failure-soft；一个 feed 失败不
   吞掉其他 feed 的可用待办。
4. 复用仓库公共原语，补齐 modal、键盘、焦点恢复、关闭入口与读屏语义。
5. 点击任何待办都直接进入处理页并关闭弹窗，消除多余的第二次关闭动作。
6. 保持 RFC-121 的领域边界：收件箱仍只承载任务流程待办，不重新吸纳记忆候选或融合待办。

## 3. 非目标

- 不把收件箱扩展成通知中心；task error、runtime 告警、记忆审批仍留在各自领域。
- 不合并 reviews / clarify / workgroup 后端端点，不新增 `/api/inbox` 聚合接口。
- 不在弹窗内直接完成评审、回答反问或交付工作组任务；弹窗负责发现与导航。
- 不新增“已读 / 未读 / 稍后处理 / 归档 / 搜索 / 排序”状态。
- 不改 15 秒轮询频率，不新增 WebSocket 规则。
- 不重做 sidebar / homepage 信息架构。

## 4. 产品决策

### D1 — 保持三源边界

数据源仍为：

1. pending reviews；
2. awaiting-human clarify sessions；
3. workgroup deliveries + gates 的 count-only 汇总。

memory / fusion 不查询、不渲染、不计数，继续由 `/memory` 与其侧栏徽标承载。

### D2 — 桌面 side dialog，窄屏 full-screen sheet

- `>720px`：面板紧邻 220px sidebar，宽 420px、内容自适应、高度上限 680px，垂直居中；共享 overlay
  提供背景遮罩与 outside-click。
- `<=720px`：面板 `inset:0`、`width:100vw`、`height:100dvh`、无外圆角，所有操作都在
  viewport 内；底部使用 safe-area padding。
- 统一使用共享 `<Dialog>` 的标题、×、ESC、overlay、focus trap、focus restore、body scroll
  lock，不再维护第二套 modal 生命周期。

### D3 — 标题区先给行动总览

标题固定为“收件箱”；正文首行给一句短说明“集中处理评审、反问与工作组待办”，旁边显示
已成功加载来源的待办总数。部分来源失败时明确显示“部分待办未加载”，不把已加载数量伪装成
完整总数。

### D4 — 过滤器复用 Segmented，并带数量

“全部 / 评审 / 反问”改用共享 `<Segmented>`：

- 全部数量 = review 行数 + clarify 行数 + workgroup actionable count；
- 评审 / 反问各显示本 feed 行数；
- 某 feed 未成功加载时，该项不显示误导性的 `0`；
- workgroup 继续只属于“全部”，不新增第四个 tab（count-only 数据不足以支撑独立列表）。

### D5 — 行重排为“类型与时间 → 标题 → 来源”

每行固定三层：

1. 语义类型（评审 / 反问 / 工作组）+ `<RelativeTime>`；
2. 最多两行的行动标题；
3. task name 为主来源，workflow / asking-agent 为补充；原始 task id 只放 `title` tooltip，
   不再占一整行制造噪声。

尾部增加轻量 chevron，hover / focus-visible 使用现有 accent 语言。workgroup 汇总行同一行体系，
但用数字徽标明确它代表 N 个行动而不是一个任务。

### D6 — 状态互斥、partial failure 可继续工作

- selected feed 首次加载且没有缓存数据：`<LoadingState size="compact">`。
- 部分 feed 失败：顶部 `<ErrorBanner>` + feed 级重试，下面继续显示其他成功 feed 的内容。
- 所有 selected feed 失败且无缓存：只显示 error，不显示 empty。
- 所有 selected feed 已 settled、无 error 且 0 item：`<EmptyState size="compact">`，带收件箱图标与
  解释文案。
- 有缓存数据的 refetch 不把列表清空；仅保留现有内容并在失败时提示。

### D7 — 行点击统一“导航并关闭”

review、clarify、workgroup 三类行在 navigation 发起前都调用 `onClose()`。处理页成为下一焦点，
不再让浮层遮住刚打开的内容。用户处理完后重新打开收件箱即可看到轮询后的剩余队列。

### D8 — 历史入口保留但降级为 footer 辅助动作

footer 继续保留“全部评审 / 全部反问”两个入口，使用公共 `.btn .btn--ghost .btn--sm`，不与
待处理行争夺主视觉。点击仍关闭弹窗后导航。

### D9 — 打开状态与过滤状态

关闭再打开保留本 session 的过滤选择；共享 Dialog 初始焦点落在当前选中的 Segmented option，
而不是永远落“全部”。退出登录 / root unmount 后自然恢复默认 `all`，不新增持久化偏好。

### D10 — failure-soft 数据契约不变

继续使用三个既有 query key 与 15 秒 refetch；列表排序仍按 `createdAt` 新到旧。纯前端派生函数
集中计算 visible items、counts 与 view state，避免 JSX 内再次长出互相矛盾的布尔条件。

## 5. 目标形态

```text
┌──────────────── 收件箱 ─────────────── × ┐
│ 集中处理评审、反问与工作组待办     5 项 │
│ [ 全部 5 ] [ 评审 2 ] [ 反问 1 ]       │
├──────────────────────────────────────────┤
│ 工作组                              2  › │
│ 2 项工作组待办 · 待交付 1 · 待确认 1    │
│                                          │
│ 评审                         5 分钟前  › │
│ 安全设计评审                             │
│ 重构登录态 · Code → Review               │
│                                          │
│ 反问                         18 分钟前 › │
│ 确认回滚边界                             │
│ 发布流程 · ← auditor · 第 2 轮           │
├──────────────────────────────────────────┤
│ [全部评审]                     [全部反问] │
└──────────────────────────────────────────┘
```

## 6. 验收标准

- [x] 桌面面板有标题、说明、关闭按钮、总数、带数量过滤器、列表与 footer 四层清晰结构。
- [x] 390×844 下 panel 边界全部位于 viewport 内，主体与 footer 均可滚动/触达。
- [x] DOM 只有共享 `<Dialog>` 提供的 modal chrome；`aria-modal=true`、标题关联、ESC、outside click、
      focus trap、关闭后回到收件箱 trigger 全成立。
- [x] 当前选中 filter 是重新打开后的初始焦点。
- [x] review / clarify 行显示相对时间、两行标题与人类可读来源；长标题、长 task name 不横向溢出。
- [x] review / clarify / workgroup 点击均关闭并导航到正确目标。
- [x] loading / partial error / all error / empty / content 矩阵互斥；workgroup loading/error 进入同一状态机。
- [x] feed 错误可单独重试，其他成功 feed 的待办仍可操作。
- [x] memory / fusion endpoint 零请求、tab/row 零渲染的 RFC-121 锁继续通过。
- [x] 中英文 key 对称，light / dark / desktop / 390px 本地视觉通过。
- [ ] frontend unit、a11y/keyboard、nav e2e 与 Darwin visual baseline 已绿；待 Linux baseline + SHA CI。

## 7. 用户批准门

本 RFC 按 `CLAUDE.md` 在批准前只落设计三件套。用户于 2026-07-15 回复「ok」明确批准后进入
生产代码、测试、视觉基线与提交阶段。
