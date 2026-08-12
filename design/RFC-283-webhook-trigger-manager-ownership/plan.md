# RFC-283 · 任务分解

实现顺序：B → A → C → D → E。当前状态：用户已批准；设计门第一轮 2×P1 + 3×P2、第二轮
3×P1 + 1×P2、第三轮 1×P1 + 3×P2 已写回，待第四轮复审通过后实现。B 的 owner 围栏必须先于 A 的 manager 权限
授权，二者不得以相反顺序进入可运行 main；B 的 DELETE 后端契约与现有 Web caller 必须原子
落地。

## B — 后端 owner 围栏（必须先落）

- [ ] B1 `requireWrite` 从 owner∨resource-admin 改为 owner∨admin；PUT、DELETE、reset 在事务内对
      fresh trigger 重跑围栏。
- [ ] B2 PUT 增 payload-conditional arming 判据：rename/disable 可不带 `tasks:execute`，enable 与
      匹配/目标/payload/阈值字段必须有；预读快拒 + 事务 fresh 行权威重算 + launch-config 四列
      逐字节 CAS（不用 runtime `updatedAt`）。
- [ ] B2a create/PUT 事务内复用同步 target identity/ACL/builtin fence；create 同事务重验 endpoint；
      target 删除/收权、四列并发改动、fire runtime update 三类 race 回归。
- [ ] B3 reset 改 `webhook-triggers:update AND tasks:execute`，owner/launch gate/stream 更新同事务。
- [ ] B4 DELETE 新增强制 `{confirm: freshRow.name}`；缺失/错名 422，owner 404 先于比名；确认后
      capture PAT 快照再删除。
- [ ] B5 **与 B4 同一原子批次**把现有 Web caller 改为
      `api.deleteJson({confirm: row.name})`，加 Web 删除集成回归，禁止 bodyless 中间态进入 main。
- [ ] B6 先以直接 actor/现有 admin 能力锁 owner、admin、user、arming、删除确认/快照回归，再进入
      A1。
- [ ] B7 manager create owner 落库、own CRUD/reset 正向矩阵。
- [ ] B8 manager 对他人规则 PUT/DELETE/reset 负向矩阵（404 + 数据不变）。
- [ ] B9 admin 全局旁路、user 403、manager PAT scope/owner/arming 矩阵；REST PAT/MCP 删除快照。

## A — 权限目录与令牌面

- [ ] A0 新增 0149 数据迁移：所有未撤销旧 PAT 按序剥离 trigger create/update/delete；覆盖 Full
      隐藏 scopes、手工 delete、无关 scope、revoked/malformed 与迁移后新 token。
- [ ] A1 **仅在 B1–B4 完成后**，`MANAGER_EXTRA` 增 trigger create/update/delete，改写角色注释。
- [ ] A2 `MATRIX_RESOURCES` 增 `webhook-triggers`，token matrix 中英标签补齐。
- [ ] A3 shared 精确角色/PAT/可见 cell/Full preset 无隐藏授权测试。
- [ ] A4 MCP generic resource 增 trigger CRUD 与 endpoint list/get-only，保持正式 API dispatch。
- [ ] A5 trigger create/update 改用 kind-aware MCP schema override；三 kind parity 与 unknown 退化锁。
- [ ] A6 generic MCP DELETE 错名/空名保护与 endpoint 脱敏/无写 op 测试。

## C — 前端能力与归属

- [ ] C1 `TriggersPanel` 拆 create/update/delete/reset capability，移除单一 canAdmin 写面。
- [ ] C2 卡片按 permission × owner 显示动作；他人规则只读。
- [ ] C3 `useUserLookup` 批量 owner 标签；本人/他人/fallback 三种显示。
- [ ] C4 FiresDialog reset 按目标规则 owner 控制。
- [ ] C5 API client 支持 `RequestOptions.cache`；JSON/multipart/blob 三条请求流共用 request identity
      helper，入口捕获 token/base URL/auth revision，401 仅在 store 仍匹配时清 token；`setBaseUrl`
      推进 revision，actor query key 纳入 base URL。
- [ ] C5a 每次写前走共享 query 之外的 `cache:'no-store'` `/api/auth/me` preflight；捕获 request
      identity/action generation，严格解析后 exact cancel 同一 actor query，await 后重验再
      `setQueryData`；刷新失败/降权/换号只发 auth GET并失效旧 handler 与无权 Dialog。
- [ ] C5b 新增 actor query key factory，迁移 repos/AccountSecurity/AccountTokens 等全部手工消费者；
      trigger/endpoint/workflow/agent/workgroup/fires/owner lookup query 绑定 base URL + auth revision，
      draft/确认态绑定来源 key，daemon/token/ABA 切换 fail-closed。
- [ ] C6 正向锁：同一 manager refresh 不触发共享 query `fetching` 自我撤权，Dialog 保持且 auth GET
      后继续恰好一条 trigger 写请求；旧 query 迟到响应不覆写 fresh actor，旧 credential/server 的
      迟到 401 不清新 token，三条底层 fetch 流的身份门与 no-store 正确；跨 daemon 业务 cache/draft
      不复用，即使两端 fixture id 相同也不误写。
- [ ] C7 中英文与 390px 响应式验证。

## D — 文档与回归守卫

- [ ] D1 更新 `docs/webhook-triggers.md`，修复 endpoint admin/manager 旧文档漂移。
- [ ] D2 更新 RFC-260 现行测试注释/断言，不回写历史 RFC 设计正文。
- [ ] D3 route registry、MCP resource、permission/token-matrix 漂移锁全绿。

## E — 验证与收口

- [ ] E1 shared 权限与 token matrix 定向测试。
- [ ] E2 backend RFC-283 权限矩阵定向测试。
- [ ] E3 frontend manager owner UX 与 stale-auth 定向测试。
- [ ] E4 `bun run gate:local`。
- [ ] E5 Codex 实现门，逐条处置 findings。
- [ ] E6 更新 RFC/STATE/索引为 Done；如用户另行授权提交/推送，再按精确路径执行。

## 验收映射

| AC                | 任务       |
| ----------------- | ---------- |
| AC-1 角色矩阵     | A1、A3     |
| AC-2 创建归属     | B7、B9     |
| AC-3 owner 写隔离 | B1–B9、B2a |
| AC-4 全量读       | B9         |
| AC-5 前端动作     | C1、C2、C4 |
| AC-6 归属标签     | C3、C7     |
| AC-7 stale auth   | C5、C5a、C6 |
| AC-8 PAT/MCP      | A0、A2–A6、B9 |
| AC-9 回归         | D、E       |
