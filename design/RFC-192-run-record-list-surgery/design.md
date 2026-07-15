# RFC-192 · 技术设计

纯前端 RFC。所有后端能力已存在：`GET /api/tasks`（status 过滤 + limit≤500）、`PUT /api/scheduled-tasks/:id`（部分更新 `{enabled}`，详情页 toggle 同款）、`POST /api/scheduled-tasks/:id/run-now`（返回 `{taskId}`，详情页同款）。

## 1. 任务列表（`routes/tasks.tsx`）

### 1.1 新纯函数（首选可断言面）

- `lib/duration.ts`：
  ```ts
  export function formatDurationMs(ms: number): { key: 'durSec'|'durMin'|'durHourMin'|'durDay'; opts?: Record<string, number> }
  // clamp 负值为 0；<60s→durSec(n)；<60min→durMin(n)；<24h→durHourMin(h, m)；否则 durDay(d, h)
  ```
  i18n 落 `common.dur.*`。耗时单元格语义（组件内小函数，可单测）：
  | status | 显示 |
  | --- | --- |
  | done / failed / canceled / interrupted 且 `finishedAt != null` | `formatDurationMs(finishedAt - startedAt)` |
  | running | `tasks.durationRunning`（「进行中 · {dur}」，dur = now − startedAt） |
  | awaiting_review / awaiting_human | `tasks.durationWaiting`（「等待 {dur}」） |
  | 其余（pending / 无 finishedAt 终态） | `common.emDash` |
  now 取渲染时刻——列表已有 15s refetch + WS 失效驱动重渲染，不加内部定时器（与 `<RelativeTime>` 同口径）。

- `lib/task-list-filter.ts`：
  ```ts
  export function filterTaskRows(rows: TaskSummary[], f: { subject: 'all'|'workflow'|'workgroup'|'agent'; search: string }): TaskSummary[]
  ```
  subject 判定**必须**走 shared 的 `taskExecutionKind`（RFC-165 单一派生点，flag-audit「kind 散射」教训——不得散写 `workgroupId != null`）；search = 名称大小写不敏感子串；两维 AND。status 维持现状 URL 参数 → API 过滤，不进本函数。

- `lib/task-repo-name.ts`：`taskRepoDisplayName(row: Pick<TaskSummary, 'repoPath' | 'repoUrl'>): { name: string; title: string }`。
  - **URL 模式**（`repoUrl != null`）：`repoPath` 是缓存目录 `…/repos/{hash}-{slug}`，直接 basename 会把内部值（`deadbeef-repo`）当仓名展示（Codex 设计门 P2）——改从 `repoUrl` 派生：先走**既有 redact 工具**（RFC-024「UI must redact before render」的现行实现，实现时定位复用、不新写脱敏逻辑）剥凭据，再取 URL 最后路径段去 `.git` 后缀；`title` = 脱敏后完整 URL。
  - **路径模式**：按 `/` 分段取最后非空段，空退回原串；`title` = `repoPath` 全路径。

### 1.2 列与单元格

- **状态列**：`TaskStatusChip` 扩展一个可选 `pulse?: boolean`（内部映射为既有 `withDot` + `className="status-chip--pulse"`；`StatusChip` 组件零改动——`withDot` 与 `className` 都是既有 prop）。CSS 新增（keyframes 一并落，当前 stylesheet 无此定义——Codex 设计门 P2）：
  ```css
  @keyframes status-dot-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
  .status-chip--pulse .status-chip__dot { animation: status-dot-pulse 1.6s ease-in-out infinite; }
  @media (prefers-reduced-motion: reduce) { .status-chip--pulse .status-chip__dot { animation: none; } }
  ```
  调用点：`<TaskStatusChip status={row.status} pulse={row.status === 'running'} />`；「N 告警」stuck badge 现状保留。
- **任务列**：沿 `.task-name-cell__inner` flex-列结构（行高对齐注释保留）追加两个条件行：
  - 错误行：**`row.status === 'failed' && row.errorSummary != null`** → `.task-name-cell__error`（红字、单行截断、`title` 全文——迁移现「错误」列 `.data-table__clip` 的 360px 语义）。判据必须含 status：canceled（「canceled by user」）与 interrupted（「daemon-shutdown」）行的 `errorSummary` 非空但不是错误，不得渲染成红字（Codex 设计门 P2）；这两类说明文本详情页可见，列表不重复；
  - 「定时」chip：`row.scheduledTaskId != null` → `<Link to="/scheduled/$id">` 包 chip。
- **仓库列**：`taskRepoDisplayName(row)` → `<code title={title}>{name}</code>`（§1.1；URL 模式 title 为脱敏 URL，符合 RFC-024 redact 约束）；`row.repoCount > 1` → `<span class="chip chip--tight">{t('tasks.repoCountChip', { n })}</span>`。
- **行点击**：`<tr className="data-table__row" onClick={rowNavHandler}>`（`.data-table__row` hover 样式已存在，scheduled 页同款）；名称保留真实 Link（键盘/中键路径）。**行 handler 必须走导航守卫**（Codex 设计门 P2——Cmd/Ctrl-click 名称链接时 TanStack Link 留给浏览器开新页，但事件继续冒泡到 `<tr>`，当前页也会跟着跳；普通点击链接同样会双重导航）：
  ```ts
  // lib/row-nav.ts —— 两表共用（scheduled 现有实现同样带这个潜伏 bug，本 RFC 一并修正）
  export function shouldRowNavigate(e: ReactMouseEvent): boolean {
    if (e.defaultPrevented || e.button !== 0) return false
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false
    const t = e.target as HTMLElement
    return t.closest('a, button, input, label, [role="button"]') === null
  }
  ```
  行内交互元素（链接 / 按钮 / Switch）由 `closest` 白名单天然豁免，不再散布 stopPropagation（§4）。行尾 chevron 单元格 `›`（`aria-hidden`，纯提示）。

### 1.3 工具条

```
[全部][待运行][运行中]…（现状 chips，URL 驱动）      [主体 Segmented] [🔍 搜索任务名]
```

- 主体：`Segmented`（RFC-150 原语）四选一，本地 state 默认 `all`；
- 搜索：`input.form-input`（split__search 同款视觉，新 `.tasks-toolbar` 布局 class 排右侧）；
- 搜索框走**最小扩展后的 `TextInput`**（`type="search"` / `aria-label` / `className` 透传，RFC-191-T2 同一扩展；不落原生 `<input>`——Frontend UI consistency 表单原语强制条款，Codex 设计门 P2）；
- **渲染条件**：`data !== undefined && data.length > 0`（沿当前 status 过滤下的返回集）；空 DB 时仅现状 chips 行——`tasks.png` 空态基线零 churn。注意：status 过滤后 API 返回空但本地无过滤词时，Segmented/搜索框也随之隐藏——行为一致且无信息损失（本地过滤仅作用于已返回行）。
- **查询层**：列表 query 显式传 `limit: '500'`（`listTasks` 默认 `filters.limit ?? 100`、路由 clamp ≤500——不传则本地过滤只覆盖最近 100 条、静默漏配（Codex 设计门 P1）；500 为路由上限，超出需分页时另立 RFC）。
- 组合语义：API 层 status 过滤（+ limit=500）→ 客户端 `filterTaskRows`（subject × search AND）→ 渲染。

## 2. 定时任务列表（`routes/scheduled.tsx`）

### 2.1 Switch 启停

- `Form.tsx#Switch` 最小扩展（向后兼容）：`label` 改可选 + 新增 `'aria-label'?: string`（表格内无文字形态；既有调用方零改动）。
- 单元格：`<td onClick={stopPropagation}><Switch checked={row.enabled} aria-label={…} disabled={toggle.isPending} onChange={(v) => toggle.mutate({ id: row.id, enabled: v })} /></td>`。
- mutation：`PUT /api/scheduled-tasks/:id` body `{enabled}`（详情页 toggle 同端点同 body）；onSuccess invalidate `['scheduled-tasks']`；错误 → 表格上方 `ErrorBanner`（新增一个页级渠道）。不做乐观更新——WS（`useScheduledTaskWs`）+ invalidate 已够快，且避免与连挂自动禁用（backend 侧写 `enabled=false`）竞态出假状态。

### 2.2 下次触发 / 最近触发

- 下次触发：`row.enabled && row.nextRunAt != null` → 主行 `<RelativeTime ts={nextRunAt}>`（未来向 `common.relTime.in*`）+ 副行 `toLocaleString(短格式)`（现状格式收进副行）；否则 `—`。
- 最近触发（三合一单元格）：
  - `lastStatus == null` → muted「未触发」（现状）；
  - 否则：结果 `StatusChip`（danger/success，现状映射） + `lastRunAt != null` 时 `<RelativeTime>` + 任务链接**仅当 `lastStatus === 'launched'` 且 `lastTaskId != null`**（文案 `scheduled.lastTaskLink`「查看任务」）。**失败触发不渲染链接**（Codex 设计门 P1）：`recordFailure` 只写 `lastStatus/lastError/lastRunAt`、不动 `lastTaskId`（`scheduledTaskScheduler.ts` recordSuccess/recordFailure 字段集差异）——成功→失败序列下 `lastTaskId` 指向的是上一次成功的任务，失败 chip 旁挂旧任务链接是错误归因；
  - `consecutiveFailures > 1` → 追加 `<StatusChip kind="danger" size="sm">`「连挂 ×{n}」。阈值 >1：单次失败结果 chip 已表达，连挂才升级。
- `lastTaskId` 指向已删任务 → 链接照常渲染，详情页 404 兜底（现状行为，不加存在性预检）。

### 2.3 立即运行

- `ConfirmButton`（`size="sm"`，两击轻确认——决策 D3）；`onConfirm` → `POST …/run-now` → 成功 `navigate(/tasks/$id, { id: taskId })`（与详情页行为一致，单一口径）；
- 禁用判据：`row.migrationNeeded || row.launchPayload === null || row.scheduleSpec === null || runNow.isPending`。注意与「需修复」badge 判据（还含 `lastError != null`）**故意不同**：上次触发失败的调度恰恰是「立即运行」的头号用户，不禁用；判据差异注释进代码。
- 行点击进详情现状保留（改走 §1.2 `shouldRowNavigate` 守卫——ConfirmButton / Switch / 链接由 `closest` 白名单豁免）。

## 3. 一致性收尾（repos）

- `routes/repos.tsx`：`<time dateTime>{formatTimestamp(lastFetchedAt)}</time>` → `<RelativeTime ts={lastFetchedAt}>`——`CachedRepo.lastFetchedAt` 是 **ISO 字符串**，走 `<RelativeTime>` 的 string 契约（`Date.parse`，RFC-191 design §3.2；Codex 设计门 P2）；`formatTimestamp` 若再无调用方则删除；
- 口径记档（本 design 即档）：**列表层 = 相对时间 + title 绝对；详情层 = 绝对时间**。`tasks.detail` / `scheduled.$id` / run history 小表维持绝对时间不动。
- users 页盘点结论：无时间列、禁用流已有确认对话框——无收尾项，不动。

## 4. 行内交互与行导航的隔离（两表统一走 `shouldRowNavigate` 守卫）

机制（§1.2）：行 handler 先过守卫——`defaultPrevented` / 非左键 / 修饰键（Cmd/Ctrl/Shift/Alt）/ `closest('a, button, input, label, [role="button"]')` 命中任一即放弃行导航。**不再散布 stopPropagation**（守卫是单点，白名单元素天然豁免；修饰键分支同时修掉「Cmd-click 链接开新页时当前页也跳」的双导航——scheduled 现有行点击实现同样带这个潜伏问题，本 RFC 重写时一并覆盖）。

守卫豁免覆盖的行内交互清单（新增行内交互若不属白名单标签需回到本表评审）：

| 表 | 元素 |
| --- | --- |
| 任务 | 名称 Link、主体 `TaskSubjectLink`、「定时」chip Link |
| 定时任务 | Switch（label/input）、最近触发任务 Link、「立即运行」ConfirmButton |

## 5. 失败模式

| 场景 | 处置 |
| --- | --- |
| duration 负值（时钟漂移 / finishedAt < startedAt 脏数据） | `formatDurationMs` clamp 0 |
| `repoPath` 尾随斜杠 / 异常串 | basename 过滤空段；全空退回原串 |
| `repoUrl` 异常（无路径段 / 解析失败） | 展示名退回 `repoPath` basename（宁可内部名也不空白）；title 保持脱敏值 |
| canceled / interrupted 行带 `errorSummary` | 不渲染红色错误行（§1.2 判据含 status），说明文本留详情页 |
| Switch PUT 失败 | ErrorBanner + invalidate 回真值；行内不留半开状态 |
| run-now 竞态双击 | ConfirmButton 两击本身 + `isPending` 禁用 |
| run-now 失败 | ErrorBanner（页级渠道，与 Switch 共用）；不跳转 |
| 连挂自动禁用（backend `consecutiveFailures` 熔断） | WS 推送 + invalidate 后 Switch 显示为关——与详情页 `scheduled-auto-disabled` 语义一致，列表不再重复横幅 |
| 搜索/主体过滤命中 0 | `EmptyState` 紧凑态 `common.noMatches`（与列表本身为空分文案） |
| errorSummary 超长 / 多行 | 单行截断 + title 全文（继承现错误列语义） |

## 6. 测试策略（随改动落地）

**纯函数单测：**
1. `duration.test.ts` — 阈值表（59s/60s/59min/60min/23h59m/24h 边界、负值 clamp）+ 耗时单元格状态分派表（终态/running/awaiting/pending）。
2. `task-list-filter.test.ts` — subject 判定走 `taskExecutionKind`（workgroup 优先于 agent 的既有优先级）、搜索大小写、AND 组合、空过滤恒等。
3. `task-repo-name.test.ts` — 路径模式（常规 / 尾斜杠 / 单段 / 空串）+ URL 模式（凭据脱敏复用断言、`.git` 后缀剥离、缓存目录名**不得**出现在展示名）。
4. `row-nav.test.ts` — `shouldRowNavigate` 分支表：左键素点 ✓；修饰键 × / 右中键 × / defaultPrevented × / 目标在 `a`/`button`/`input`/`label`/`[role=button]` 内 ×。

**页面渲染测（vitest + testing-library）：**
5. `tasks-list-surgery.test.tsx`（新）— 错误行判据（failed+summary 渲染；**canceled+summary 不渲染红行**——负例必测）+ title 全文；「N 仓库」chip 仅 `repoCount>1`；「定时」chip 链接点击不触发行导航（守卫豁免）；行点击 navigate + **Cmd-click 名称链接不触发行导航**；查询参数含 `limit=500` 断言；pulse class 仅 running 行；Segmented + 搜索过滤交互（搜索框为扩展后 TextInput）；空列表不渲染新工具条。
6. `scheduled-list-inline.test.tsx`（新）— Switch 触发 `PUT` body `{enabled}` 断言；两击立即运行 → POST + navigate；禁用判据四分支（migrationNeeded / null payload / null spec / 失败行**不**禁用）；连挂 chip `>1` 阈值；任务链接**仅 `lastStatus==='launched'` 渲染**（failed 行无链接——负例必测）；行守卫豁免（Switch 点击不导航）；下次触发相对 + 副行。

**锁重写 / 清扫**（[feedback_grep_locks_before_push] 表级盘点）：
- `tasks-list-error-column-single-line.test.ts` → 改锁「错误第二行」新结构（原「错误列单行」锁退役，文件头注释链回本 RFC）；
- `tasks-list-id-status-nowrap.test.ts` / `tasks-list-name-cell-row-alignment.test.ts` → 按新列结构重立（name-cell flex-inner 模式保留，断言迁移）；
- `scheduled-list-repair-badge.test.tsx` → 判据不变，选择器随行结构核对；
- `homepage`/`i18n` 类表级锁复核命中集。

**e2e / 视觉：**
- `tasks.png` 空态基线零 churn（新工具条空态不渲染）；
- `task-lifecycle-states.spec.ts` 等 e2e 若引用任务列表列结构则同步（经查 e2e 主要走 API + 详情页，预期改动极小；实现时以 grep 命中集为准）；
- 推送前 minimal-repro 明暗截图（脉冲动画、Switch、连挂 chip 双主题对比）。

## 7. 依赖与并发

- **依赖 RFC-191-T1**（`<RelativeTime>` / `common.relTime.*`）；191 未合入前本 RFC 不开工。
- `routes/tasks.tsx#formatRelative` 在本 RFC 退役（导出消失——先 grep 测试/调用方锁，`i18n-phase-a` 等命中集同步）。
- 与 RFC-190（首页）无页面交集；`tasks.detail` 的「N 个仓库」multiRepoSummary 文案已存在，列表 chip 复用其 key 或新 key 实现时定夺（倾向复用 `tasks.detail.multiRepoSummary` 语义新建列表专用 key，避免 detail 文案耦合）。
- working tree 并发改动（`e2e/task-wizard.spec.ts` 等他人未提交件）与本 RFC 文件集有潜在交集（e2e fixtures）——实现时按多人并存原则精确 pathspec，冲突先问。
