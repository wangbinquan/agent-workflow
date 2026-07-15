# RFC-192 · 任务分解

依赖 RFC-191-T1（`<RelativeTime>`）先行合入。建议 2 个 PR：PR-1 = 任务表（T1–T3），PR-2 = 定时任务 + 收尾（T4–T6）；如实现体量可控亦可合一（commit 拆清）。

## 任务

- **RFC-192-T1 纯函数层**
  `lib/duration.ts`（`formatDurationMs` + 耗时单元格状态分派）、`lib/task-list-filter.ts`（`filterTaskRows`，subject 走 `taskExecutionKind`）、`repoBasename`。i18n `common.dur.*` / `tasks.durationRunning` / `tasks.durationWaiting` / `tasks.repoCountChip`。
  测试：`duration.test.ts` / `task-list-filter.test.ts` / `repo-basename.test.ts`（design §6-1~3）。
  依赖：RFC-191-T1。

- **RFC-192-T2 任务表列手术**
  `routes/tasks.tsx`：列重排（状态前置 / 错误列退役并折进名称单元格 / 仓库 basename+N 仓 chip / 开始 RelativeTime / 耗时列 / chevron）+ 整行可点 + 「定时」溯源 chip + `formatRelative` 退役。`TaskStatusChip` 加 `pulse` prop + `.status-chip--pulse` CSS（reduced-motion 静止）。
  测试：`tasks-list-surgery.test.tsx`（design §6-4）+ pulse 渲染断言。
  依赖：T1。

- **RFC-192-T3 任务表过滤三维化**
  主体 `Segmented` + 搜索框（`.tasks-toolbar`）；空列表隐藏新工具条（基线零 churn）；组合过滤接线 `filterTaskRows`。
  测试：过滤交互断言并入 `tasks-list-surgery.test.tsx`。
  依赖：T2。

- **RFC-192-T4 定时任务行内化**
  `Form.tsx#Switch` 最小扩展（`label` 可选 + `aria-label`）；`routes/scheduled.tsx`：Switch 启停（PUT `{enabled}`）、下次触发相对化 + 副行、最近触发三合一（chip + 时间 + 任务链接 + 连挂 ×N）、「立即运行」ConfirmButton（禁用判据 design §2.3）、页级 ErrorBanner 渠道。i18n `scheduled.lastTaskLink` / `scheduled.consecutiveChip` / `scheduled.runNowConfirm` 等。
  测试：`scheduled-list-inline.test.tsx`（design §6-5）+ Switch 扩展兼容单测。
  依赖：T1（RelativeTime 未来向）。

- **RFC-192-T5 一致性收尾**
  repos `lastFetchedAt` → `<RelativeTime>`（`formatTimestamp` 无调用方则删）；口径记档（列表相对 / 详情绝对）已在 design §3。
  测试：repos 页既有测试同步。
  依赖：T1。

- **RFC-192-T6 锁清扫与全量门**
  `tasks-list-error-column-single-line` / `tasks-list-id-status-nowrap` / `tasks-list-name-cell-row-alignment` 重立，`scheduled-list-repair-badge` 核对；e2e grep 命中集复核（`task-lifecycle-states.spec` 等）；`tasks.png` 基线零 churn 验证；五门 + binary smoke + minimal-repro 明暗截图。
  依赖：T2–T5。

## 验收清单

- [ ] proposal §6 六条验收全过；
- [ ] 后端零改动（diff 不触 `packages/backend/`）；
- [ ] 「后端已备好、前端未接线」三件全接：`repoCount` chip / `scheduledTaskId` 溯源 / `lastTaskId`+`lastRunAt`+`consecutiveFailures`；
- [ ] 行内交互 stopPropagation 清单（design §4）逐项有测试；
- [ ] 五门全绿 + Codex 实现门 + 视觉双主题自查。
