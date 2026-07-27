# RFC-232 · 任务与定时任务列表显示 Owner — plan

状态：Done（2026-07-28；用户已批准；第十轮设计门与外部 Codex 实现门均
APPROVED，0 open P0/P1/P2）。

## 任务

- [x] **T1 现状定位**：确认 Task owner 权威列、TaskSummary 缺口、ScheduledTask 既有 owner id、
      两张表格与 UserPublic 公开字段口径。
- [x] **T2 设计门**：复审 list-only DTO + backend batch projection 方案至 0 open P0/P1/P2。
- [x] **T3 Shared / backend wire**：新增最小 `OwnerIdentitySchema`、`TaskListItemSchema`、
      `ScheduledTaskListItemSchema`（均 strict）；task 仅在 `include_owner=true` 时于原
      summary pipeline 后批量补身份，scheduled HTTP list 复用原 canonical mapper 后批量补；
      显式排除 system sentinel；保留默认 TaskSummary、overview、详情/CRUD/WS wire。
- [x] **T4 Owner 原语与两表接线**：新增独立 `OwnerLabel`，统一
      displayName / username a11y / stable-id / system / unknown / mismatch；两表增加独立列。
- [x] **T5 自动化与浏览器**：schema/service/route/component/route 回归；desktop + 390px、
      128 字符 owner、同名消歧、axe、行点击与行内操作。
- [x] **T6 门禁与实现门**：定向及相关全量 tests、typecheck、lint、format，外部 Codex
      实现审查，更新 RFC/STATE/index；用户随后明确授权提交并推送 `main`。

## 顺序

```text
T1 → T2 设计门 → T3 shared/backend → T4 frontend → T5 验证 → T6 实现门
```

## 不变约束

- owner 来自每行持久化 owner，绝不使用当前 viewer 或 schedule launcher 临时替代。
- 只选择 `OwnerIdentity` 三个显示字段；不返回 role/status/email/lastLoginAt/凭据。
- task visibility 先限定 rows；隐藏 task/owner 不进入 HTTP。
- scheduled route 保持既有 owner/admin visibility。
- TaskSummary、task.created、ScheduledTask 详情/CRUD/WS wire 不变。
- 不发 `/api/users/lookup`；无 per-row 请求、200-id 截断或独立 owner cache。
- backend identity SQL 固定每批最多 200 ids 并无截断合并；scheduled 无分页也不生成无上限
  单个 `IN (...)`。
- identity 查询缺用户时回退 stable id；字段缺失显示 unknown；系统 owner 不泄露 `__system__`。
- owner object id 必须与 `ownerUserId` 相同，否则 fail closed 到 stable id。
- Owner 主文案有界截断，唯一 username 作为可见、可换行的次级文本；不依赖 title/sr-only 才能
  在触屏或键盘场景辨认，generic span 不设置 `aria-label`。
- 不新增 filter/sort/migration，不改 ResourceBadges，不改 auth/QueryClient/mutation/logout。
- 保留 RFC-231 与共享树其他 WIP；重叠 `STATE.md` / `design/plan.md` 只做精确追加。

## 验收清单

- [x] AC-1：任务表 Owner 列显示 resolved / fallback / system / unknown / mismatch。
- [x] AC-2：定时任务表同口径。
- [x] AC-3：两个 list-only schema 与 producer 字段完整；task 默认 response、通用/实时 wire
      不膨胀，overview 不承担 owner identity query。
- [x] AC-4：不可见 task 与 owner 不进入 response，scheduled visibility 不回归。
- [x] AC-5：零前端 owner lookup/N+1；backend 201+ owner 跨批完整，缺失用户不阻塞列表。
- [x] AC-6：128 字符与同名 owner 可截断且可唯一识别。
- [x] AC-7：过滤、Switch、run-now、行点击和窄屏横向滚动不回归。
- [x] AC-8：自动化、axe、静态门禁、真实浏览器与实现门通过，0 open P0/P1/P2。

## 提交边界

- RFC 批准只授权实现，不自动授权 commit/push；用户已于实现门完成前另行明确授权提交并推送
  `main`。
- 提交按 AGENTS.md 为实际贡献的 agent/model 添加真实
  `Co-Authored-By` trailer，并在 push 前核验 commit body。
- 共享 `main` 精确 pathspec；不使用 `git add -A`，不 amend/rebase/force-push。
