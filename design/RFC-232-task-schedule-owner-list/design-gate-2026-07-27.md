# RFC-232 · Codex 设计门记录（2026-07-27）

## 首轮结论

`NEEDS_REVISION`：P0=0，P1=2，P2=4。

## Findings 与折入结果

| 级别 | Finding | RFC 修订 |
| --- | --- | --- |
| P1 | tasks / scheduled / owner lookup cache 不含账号维度，401 或 WS 撤权后重新登录可能复用高权限账号数据 | 二轮证明只给两张 list 加 generation 仍漏 homepage/detail/history；最终改为 production QueryClient 的统一 auth/base-URL clear 边界 |
| P1 | optional `ownerUserId` 把旧 daemon 的 missing 错标为 system | 新 backend schema 改 required-nullable；REST `rowToSummary` 与 `task.created` 两个 producer 全接线；前端把 runtime `undefined` 显示为 `acl.unknownOwner` |
| P2 | lookup endpoint 只消费 200 ids，但 tasks 可达 500、scheduled 无页上限；生产默认 retry 还会放大请求 | 共享 `USER_LOOKUP_MAX_IDS=200`；hook 在一条 logical query 内分块并 `retry:false`；补 201+ owners 回归 |
| P2 | 复用新叶子会把既有 ResourceBadges 的 `__system__` 文案顺带改变 | 新增独立 `OwnerLabel`；既有 ResourceBadges 零修改 |
| P2 | `nowrap` 无法限制 auto-layout table 的 128 字符 owner | 新增 max-width + ellipsis 的 owner inner label；desktop/390 Playwright 锁 table-owned overflow 与操作可达 |
| P2 | `displayName` 不唯一，泛化 title 无法识别真实用户 | 视觉主文案保留 displayName；title 与 Owner cell 的 sr-only 真实文本带唯一 `@username`，lookup miss 用 stable id；补同名与 axe 回归 |

## 第二轮复审

`NEEDS_REVISION`：P0=0，P1=1，P2=1。

| 级别 | Finding | RFC 修订 |
| --- | --- | --- |
| P1 | generation 只覆盖两张列表与 lookup，homepage、task detail、scheduled detail/history 固定 key 仍可能跨账号闪现旧私有数据 | 改成 `installAuthQueryCacheBoundary(queryClient)` 单一边界；任一 token/base-URL 事件同步 `queryClient.clear()`；测试预热全部相关 key 并覆盖 HTTP 401、WS 4401、token/base-URL 切换 |
| P2 | generic `span` 禁止 author-provided name，`aria-label` 可能被忽略且 axe violations-only 门禁不能证明同名消歧 | 删除 generic span 的 `aria-label`；用现有 `.sr-only` 把 `(@username)` 作为 Owner cell 真实文本；真实表格 computed accessible name 与 Owner 相关 axe incomplete 均纳入门禁 |

## 第三轮复审

`NEEDS_REVISION`：P0=0，P1=2，P2=1。

| 级别 | Finding | RFC 修订 |
| --- | --- | --- |
| P1 | TanStack Query v5 `clear()` 删除 cache map，但 mounted observer 仍保留旧 result；base URL 变化也不让只订阅 token snapshot 的 Root 重渲染 | 改为统一 transport revision；`AuthQueryBoundary` 以 revision 为 key 卸载旧 provider、route observers 与 DOM，创建全新 QueryClient；行为测试挂真实 observer，不再只断言 cache 为空 |
| P1 | task preview、worktree/port 下载、WorktreeFilesPanel 与 Skill ZIP 等 daemon-auth raw fetch 的 401 不调用 `clearToken`，边界不会触发 | 新增只面向 app daemon 的统一 fetch wrapper；标准 helpers 与所有 bearer raw fetch 共用 401 handler，外部 PlantUML endpoint 保持无副作用 wrapper |
| P2 | proposal 目标 6 / D6 仍保留已被二轮否定的局部 generation 方案 | proposal、design、plan 统一为全 provider transport scope；删除“list/lookup key generation + 旧 cache 自然回收”描述 |

## 第四轮复审

`NEEDS_REVISION`：P0=0，P1=2，P2=1。

| 级别 | Finding | RFC 修订 |
| --- | --- | --- |
| P1 | 统一 401 handler 没有请求发起 revision；A 的迟到 401 会把已经切换后的 B token 清掉 | 引入原子 `{revision, baseUrl, token}` request lease；HTTP 401 与 WS 4401 仅通过 revision-CAS 清 token；standard/raw body 与副作用前复验 lease |
| P1 | keyed subtree 会卸载 MutationObserver，但 pending mutation 本体仍执行 hook-level lifecycle；旧改密可覆盖 B token、旧 run-now 可导航到 A task | `createQueryClient({ transportRevision })` 安装 transport-aware MutationCache；stale success/error 在 TanStack hook/observer lifecycle 与 dispatch 前进入 per-mutation quarantine；补 password/run-now 与 hook/call-site callback race |
| P2 | `TransportQueryScope` 的 effect cleanup `clear()` 在 React 19 StrictMode 首次 replay 时会清 live client | production 拓扑改为 QueryClient provider 在 StrictMode 外、Router 在内；真实卸载不显式 clear；补与 production 同构的 StrictMode 首挂行为测试 |

## 第五轮复审

`NEEDS_REVISION`：P0=0，P1=3，P2=1。

| 级别 | Finding | RFC 修订 |
| --- | --- | --- |
| P1 | 永不 settle quarantine 阻断 `finally/runNext`；pending mutation 的 5 分钟 GC timer 会无限续期并强引用退休 client | 删除永久 Promise；改为 actual callback-entry adapter + 可判别 retired error，有界 settle；保留 transport-neutral settled/finally，补 fake timer、runNext、cache removal 回归 |
| P1 | global callback 单次 revision check 与 hook invocation 之间有 await TOCTOU；async hook 内 await 后仍可导航 | `TransportQueryClient.defaultMutationOptions` 在 hook 实际入口同步 guard；三处 call-site lifecycle 显式包装；有非本地副作用的 async hook 在每个 await 后复验，mutateAsync 交付处再验 |
| P1 | imperative auth 清单漏 `UserMenu.logout`；A 的迟到 logout 会清 B token/client/drafts 并导航 | logout 改为点击时发起 best-effort POST 后同步 CAS 退休 A；迟到 response 无本地权限；draft cleanup 后仅 logoutRevision 仍当前才导航；补 success/401/network race |
| P2 | React `key` 不进入 props，scope 按伪代码拿不到创建 client 所需 revision | 显式同时传 `key={revision}` 与 `transportRevision={revision}`；scope 只消费 prop，补 key/client/adapter revision 一致性测试 |

## 第六轮复审

`NEEDS_REVISION`：P0=0，P1=3，P2=2。

| 级别 | Finding | RFC 修订 |
| --- | --- | --- |
| P1 | tab-local revision 不是跨 tab 原子 CAS，storage event 延迟时旧 401/logout 仍可能覆盖新 token | 不再为 owner 展示引入任何 token/CAS/logout 改动；删除该方案 |
| P1 | mutateAsync helper 有微任务 TOCTOU，adapter 又未覆盖 onMutate/mutationFn 与二段请求 | 不再引入 mutation adapter/helper；删除该方案 |
| P1 | 旧 onSettled invalidate 可能在卸载提交前以新 credential refetch 旧路径 | 不再修改 QueryClient/mutation 生命周期；删除该方案 |
| P2 | async onError 中抛 transport assert 会形成 unhandled rejection | 删除 transport callback assert 方案 |
| P2 | defaultMutationOptions 包装未定义幂等契约 | 删除 TransportQueryClient 方案 |

## 第七版方案

前六轮 findings 共同说明：为复用前端 `useUserLookup` 而把两列展示扩张成全站 auth transport
改造，风险与范围都不成比例。第七版改为 list-only DTO：

- `GET /api/tasks` 与 `GET /api/scheduled-tasks` 在既有列表读取中 LEFT JOIN owner 的
  `UserPublic` 投影；
- 前端不发 owner lookup，不新增独立身份 cache；
- `TaskSummary`、实时事件、详情/CRUD/WS、auth/QueryClient/mutation/logout 全部不改；
- owner 只随已可见列表行返回，缺用户时回退 stable id。

该方案保留相同产品结果，同时从根上移除前六轮发现的 lookup 容量、跨账号 lookup cache 与
transport lifecycle 改动面。

## 第七轮复审

`NEEDS_REVISION`：P0=0，P1=2，P2=2。

| 级别 | Finding | RFC 修订 |
| --- | --- | --- |
| P1 | `__system__` 在 migration 中有真实 user row，普通等值 JOIN 不会得到 null，且 sentinel username 不满足 UserPublic schema | 两条 list-item JOIN/mapper 显式排除 `SYSTEM_USER_ID`，并补 task/scheduled system route 与严格 response schema 回归 |
| P1 | `filterTaskRows` 固定返回 `TaskSummary[]`，会擦掉 `TaskListItem.owner*` 并导致页面 typecheck 失败 | helper 改为 `<T extends TaskSummary>(rows: T[]): T[]`，补 `expectTypeOf` 子类型保持回归 |
| P2 | `/api/tasks` 同时被首页 10 秒轮询与 scheduled history 30 秒轮询消费，endpoint-wide owner 会扩大 JOIN/payload | `include_owner` 默认 false；只有 `/tasks` 页面显式开启，默认 wire/首页/history 保持原状 |
| P2 | 截断完整身份只靠不可聚焦 `title` 与 sr-only，视力正常的键盘/触屏用户不可达 | 唯一 `@username` 改为可见、可换行的有界次级文本；title 仅作冗余，补键盘/触屏与浏览器回归 |

## 第八版方案

- 新增只含 `id / username / displayName` 的 `OwnerIdentity`，不夹带 role/status；
- task 默认 list 继续返回 `TaskSummary[]`，只有 `include_owner=true` 返回 `TaskListItem[]`；
- scheduled HTTP list 使用独立 `listScheduledTaskItems`，overview/详情/CRUD 保持旧 producer；
- system sentinel 显式归一为 null；
- Owner 显示名有界截断，唯一 username 对所有输入方式可见；
- task filter 保留传入的 `TaskSummary` 子类型。

待第八轮零 finding 复审。

## 第八轮复审

`NEEDS_REVISION`：P0=0，P1=1，P2=4。

| 级别 | Finding | RFC 修订 |
| --- | --- | --- |
| P1 | scheduled 新 producer 若另写 mapper，可能丢失坏 JSON 容错与 credentialed repoUrl 脱敏 | `listScheduledTaskItems` 先调用原 `listScheduledTasks`/`rowToScheduledTask`，visibility 后只批量附加 owner；补 degradation/redaction parity |
| P2 | task 新 producer 可能漏现有 `openAlertCount` / `failureCode` enrichment，且 optional schema 检不出 | 抽单一 `listTaskSummaryRows` canonical pipeline；default/opt-in 仅最后投影不同，补去 owner 后逐字段 parity |
| P2 | 非 strict Zod 会 strip 未知字段，contract 可能对 raw role/status/email 夹带误绿 | 三个新 schema 均 strict；contract 使用非空 fixture，另对 raw response 做 exact-key 断言 |
| P2 | `include_owner` 无效值写成 400，与统一 `parseBoolQuery` 的 422 契约冲突 | 明确复用统一 parser；测试 missing/0/1/false/true/invalid 与三类 frontend consumer |
| P2 | proposal D6、STATE、RFC index 仍保留旧 lookup/单行/零 i18n-CSS 方案 | D6 改为仅 displayName 单行；本轮同步 STATE 与 RFC index 为第九版事实 |

## 第九版方案

- 两张列表都先走原 canonical producer，再以一次 backend `WHERE id IN (...)` 批量补最小身份；
- task 的 alert/failure enrichment 与 scheduled 的 tolerant/redacting mapper 不分叉；
- strict schema + 非空 contract + raw exact-key 测试共同锁 wire；
- `include_owner` 使用统一 422 boolean-query 契约；
- displayName 单行截断，完整 username/stable-id 可见换行；
- 仓库 STATE 与 RFC index 同步为当前事实。

待第九轮零 finding 复审。

## 第九轮复审

`NEEDS_REVISION`：P0=0，P1=0，P2=2。

| 级别 | Finding | RFC 修订 |
| --- | --- | --- |
| P2 | scheduled 列表无分页，单个 `users WHERE id IN (...)` 的 bind 参数可无上限增长 | `loadOwnerIdentities` 固定按 200 ids 做 backend SQL batch 并无截断合并；测试至少 201 个不同 owner 跨 batch 边界 |
| P2 | `task.created` 使用非 strict `TaskSummarySchema`，仅 schema parse 无法证明 raw producer 未夹带 owner | 捕获真实 `tasksListBroadcaster` frame，对 raw `task` 做 exact-key / 显式无 owner 断言 |

## 第十版方案

- 前端仍然零 owner lookup / 分块 HTTP；backend helper 按 200 ids 有界分批并合并全部结果；
- task 最多 500 行，因此 identity 查询最多三批；scheduled 无分页也不会构造无上限单个 `IN`；
- 默认 REST 与真实 `task.created` raw frame 都有无 owner 的 producer guard；
- 其余第九版 canonical producer、strict DTO、ACL 与可见身份规则不变。

待第十轮零 finding 复审。

## 第十轮复审

`APPROVED`：P0=0，P1=0，P2=0。

第九轮的 backend batch 容量边界与 raw `task.created` producer guard 均已闭环；可进入实现。
