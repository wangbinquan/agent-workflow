# RFC-232 · 任务与定时任务列表显示 Owner

- 状态：Done（2026-07-28；设计门与外部 Codex 实现门均 APPROVED，0 open P0/P1/P2）
- 日期：2026-07-27
- 发起：用户要求「任务列表和定时任务列表，把 owner 显示出来」。
- 相关 RFC：RFC-036（任务成员与 owner）、RFC-099（资源 ACL）、RFC-159（定时任务）、
  RFC-192（两张运行记录表的现行列结构）、RFC-222（manager 可查看他人任务与定时任务）。

## 1. 背景

任务与定时任务都是多用户运行入口，但当前两张列表都不显示归属：

- `tasks.owner_user_id` 已是任务归属权威列，可见性也按 owner / collaborator /
  `tasks:read:all` 判定，但任务 list wire 没有投影它；
- `ScheduledTask.ownerUserId` 已存在，但 list response 没有 owner 的公开显示身份；
- manager / admin 在「全部」范围看到多人的记录，协作者也可能看到别人拥有的共享任务，仅凭
  名称、状态和主体无法判断该找谁处理。

## 2. 目标

1. `/tasks` 增加独立「所有者 / Owner」列。
2. `/scheduled` 增加同口径独立列。
3. 优先显示 `displayName`；完整 identity 包含唯一 `@username`；用户投影缺失时回退 stable
   `ownerUserId`。
4. `null` / `__system__` 显示系统 owner；旧 daemon 缺 task owner 字段时显示未知归属。
5. owner identity 由两张列表 endpoint 随可见行批量返回，不产生额外 lookup 或 N+1 请求。
6. 不改变 ACL、筛选、排序、行点击与行内操作。

## 3. 产品决策

- **D1 — 独立列**：Owner 是运行归属的一等扫读维度。任务列位于主体后，定时任务列位于名称后。
- **D2 — list-only DTO**：新增 `TaskListItem` 与 `ScheduledTaskListItem`，附带
  `ownerUserId + owner: OwnerIdentity | null`；`OwnerIdentity` 只含显示所需的
  `id / username / displayName`。不扩张通用 `TaskSummary`、详情或 WebSocket 协议。
- **D3 — 后端批量补投影**：公开 owner 投影与可见列表行一起返回。`GET /api/tasks`
  默认仍返回原 `TaskSummary[]`，只有任务列表显式传 `include_owner=true` 时才在 canonical
  summary pipeline 后调用一次 identity loader 并返回 `TaskListItem[]`；loader 内部按最多 200
  ids 的固定 SQL 批次查询并无截断合并（任务列表最多 500 行，因此最多三批）。首页与定时任务
  历史保持原 payload/查询成本。定时任务先经原 canonical mapper 与 visibility 过滤，再由同一
  loader 有界批量补 owner，不改变 overview 使用的原 service。前端不调用
  `/api/users/lookup`，没有 per-row / 前端分块请求、200-id 截断或独立 owner cache。
- **D4 — 显示与消歧**：主文案为单行截断的 `displayName`；唯一 `@username` 作为可见、
  可换行的次级文本，触屏/键盘无需 hover 即可辨认。owner object 缺失或 id 不匹配时回退
  stable id。
- **D5 — 系统与未知**：只有显式 `null` / `__system__` 显示系统 owner；字段缺失显示未知，
  不猜归属。
- **D6 — 有界布局**：仅 displayName 单行 max-width + ellipsis；username / stable-id 在同一
  有界列内完整换行；窄屏继续横向滚动。
- **D7 — 不夹带全站 auth 改造**：本功能不新增独立用户查询缓存；既有全站
  auth/QueryClient 生命周期若要统一整改，单独立安全 RFC。

## 4. 列顺序

- 任务：`状态 | 任务 | 主体 | Owner | 仓库 | 开始 | 耗时 | ›`
- 定时任务：`启用 | 名称 | Owner | 周期 | 下次触发 | 最近触发 | 操作 | ›`

## 5. 验收标准

1. 两张列表均出现本地化 Owner 表头和逐行 owner 文案。
2. 正常用户显示 `displayName`，Owner cell 可见的次级文本含完整唯一 `@username`。
3. 公开用户投影缺失或与 `ownerUserId` 不匹配时显示 stable id。
4. `null` / `__system__` 显示 `acl.systemOwner`；旧 task list wire 缺字段显示新增
   `acl.unknownOwner`。
5. `GET /api/tasks` 默认 wire 不变；只有 `include_owner=true` 时才对已通过 visibility 的
   rows 附带 owner。不可见 task 与 owner identity 不进入 response。
6. `GET /api/scheduled-tasks` 保持既有 owner/admin 可见性；详情/CRUD/WS wire 不变。
7. 无 `/api/users/lookup`、per-row 或前端分块请求；backend identity loader 以最多 200 ids
   的批次无截断返回，owner identity miss 不阻塞主表。
8. 128 字符显示名单行截断，但完整唯一 username 保持可见；现有过滤、Switch、run-now、
   行点击和窄屏横向滚动不回归。
9. shared/backend/frontend 定向测试、typecheck、lint、format、真实浏览器与实现门全绿。

## 6. 非目标

- 不新增 owner filter、排序、分组、头像或 profile 链接。
- 不修改任务详情成员/owner 管理。
- 不修改 owner 转让、协作者、scheduled 写权限或 ACL。
- 不返回 email、lastLoginAt 或其他管理/认证字段。
- 不新增 migration。
- 不改全站 auth store、QueryClient、HTTP/WS 401、mutation 或 logout。
