# RFC-246 · 技术设计：统一运行表面

- 状态：Implementation Complete Locally / Publication In Progress（2026-08-01）
- 配套：`proposal.md`、`plan.md`

## 1. 现状与边界

| 页面         | 数据合同                          | 当前高频动作             | 本 RFC 数据策略        |
| ------------ | --------------------------------- | ------------------------ | ---------------------- |
| `/tasks`     | RFC-244 `/api/tasks/page`         | 搜索、筛选、展开、进详情 | 保留服务端过滤与任务树 |
| `/scheduled` | `/api/scheduled-tasks` 全量授权行 | 启停、立即运行、进详情   | 客户端视图/搜索/筛选   |
| `/repos`     | `/api/cached-repos` 全量授权行    | 刷新、删除、批量导入     | 客户端视图/搜索/筛选   |

本 RFC 不触及 shared/backend wire。Scheduled/Repos 的派生集合只读已有 DTO 字段，并保留 mutation、
query invalidation、WebSocket 失效与导航路径。

## 2. 公共组件

新增 `components/operations/OperationsToolbar.tsx`：

- 泛型 `view` 与 `views[]`，每项接收 label、count、testid；内部复用 `Segmented`。
- 统一搜索区（复用 `TextInput`）、筛选按钮、活跃维度计数、清空动作。
- 搜索/筛选/chevron SVG 只在该公共命名空间维护；路由不再各存一份图标。
- 使用通用 `.operations-surface*` / `.operations-toolbar*` chrome；任务行自身继续保留
  `.task-operations*`，Scheduled/Repos 只维护各自业务网格。

这不是新交互原语，而是把 RFC-244 已批准且被三个页面共同需要的组合抽成公共组件。

## 3. 派生口径

### 3.1 Scheduled

`scheduledNeedsAttention(row)` 为纯函数：

```text
migrationNeeded || launchPayload == null || scheduleSpec == null ||
lastError != null || lastStatus == failed || consecutiveFailures > 1
```

视图计数基于未搜索、未高级筛选的授权全集，帮助用户理解业务桶；搜索与高级筛选再作用于当前视图。
文本搜索使用 locale-insensitive 小写包含，输入源为名称、`scheduleSummary`、`launchKind`、Owner 的
displayName/username/id。`paused` 精确为 `enabled === false`。

### 3.2 Repos

`repoNeedsAttention(row)` 精确为：

```text
hasSubmodules === true && lastSubmoduleSyncOk === false
```

`referenced` 为 `referencingTaskCount > 0`，`unused` 为 `=== 0`。搜索只使用 `urlRedacted`、
`localPath`、`defaultBranch`，不读取或渲染原始 URL。

## 4. 行与响应式

- 两页保留原生 `<table>` 语义，但由路由级 class 将 `thead/tbody/tr` 变为可收缩 grid；
  `TableViewport` 不设置强制 `minWidth`，因此不把移动端退化成横向滚动。
- 1280px 为完整列；721–1100px 收紧列宽与 gap；≤720px 隐藏表头并把同一行重排为卡片式 grid。
- 桌面行 `min-height: 56px`，每个主要单元最多两层信息；长路径/Owner 允许换行或省略并用 `title`
  恢复全文。
- Scheduled 保留整行详情导航与末列 chevron；所有 switch/link/button 继续由 `shouldRowNavigate`
  排除。Repos 没有详情路由，整行无 pointer/chevron。

## 5. 状态与失败模式

- 初始空态与筛选无结果分开：前者保留创建/导入 CTA，后者显示可清除筛选的紧凑 `EmptyState`。
- mutation 错误继续用 `ErrorBanner`；Scheduled 的 `runNowBlocked` 与 lastTask 链接安全条件不变。
- filter dialog 复用 `Dialog + Field + Segmented`，关闭不提交 draft；Apply 原子替换生效值，Clear
  清空当前页面全部搜索/视图/高级筛选。
- 计数、视图与筛选全是确定性纯派生，用单元测试锁边界；浏览器测试锁几何、overflow 和触控尺寸。

## 6. 测试策略

- 纯函数：两个 attention predicate、四视图、搜索与高级筛选组合。
- 组件/路由：公共 toolbar source/role 契约；Scheduled 原有 mutation/navigation/链接语义；Repos
  原有刷新、删除、强制删除、URL 脱敏与批量导入语义。
- Playwright：三页共享 chrome；Scheduled/Repos populated fixture 的 1280/1024/390×844/390×568
  overflow、搜索/筛选同排、行密度、目标尺寸。
- Visual：为 Scheduled 和 Repos 增加确定性 populated baseline，并人工查看截图。
