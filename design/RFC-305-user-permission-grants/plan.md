# RFC-305 · 统一权限目录与用户级附加授权 — 实施计划

> 状态：**In Progress（2026-08-15，用户已批准完整实现、测试/架构防护、提交上库和 exact-SHA CI）**。

## 1. 最终边界

- `admin / manager / user` 仅为权限预设；授权消费者只能检查有效权限。
- 72 点统一目录；`user=48`、`manager=60`、`admin=72`。
- 只有 `account:self` 内在；所有其余预设差集均可逐账户授予，普通 `user` 当前可选 24 点。
- `user + 全 24 grant == admin` 的有效权限与真实授权行为；角色字段仍为 `user`。
- 五个历史身份谓词改为显式权限；RouteMeta/MCP/ACL/WS/前端不得另设角色轴。
- 新代码按 RFC-294 落入 `modules/identity-access/`，访问写入只有一个事务所有者。

## 2. 批次与任务

### 批 A — shared 单一事实源

- [x] **RFC-305-T1** `PERMISSIONS` 扩为 72 点，加入五个历史身份 capability。
- [x] **RFC-305-T2** 建穷尽 `PERMISSION_CATALOG`：group/label/description/delegation/risk/token/constraints。
- [x] **RFC-305-T3** delegation 收敛为 `account-additive | intrinsic`；只有 `account:self` 内在。
- [x] **RFC-305-T4** 统一 effective account、grantable difference、role rebase、strict/fail-closed normalization。
- [x] **RFC-305-T5** PAT 与 matrix 使用 effective account cap，system-domain 始终剔除。
- [x] **退出门**：目录 exact coverage；48/60/72 与 user 24 差集；全 grant 等于 admin；坏输入/坏存量/PAT 正负矩阵全绿。

### 批 B — RFC-294 `identity-access` 纵切与存储

- [x] **RFC-305-T6** 迁移 0162：`access_revision`、grant 表、append-only audit 表/trigger/index。
- [x] **RFC-305-T7** 建 `domain / application / ports / infrastructure / public / composition`。
- [x] **RFC-305-T8** exact create/update command、query 与 current/delegated authority resolver。
- [x] **RFC-305-T9** role/grant/revision/audit 单 writer；Bootstrap/OIDC 经 exact transaction participant；同事务 OCC + audit，单语句 authority snapshot 与 post-commit targeted refresh。
- [x] **RFC-305-T10** self/system/last-active-`users:write`、disabled/invited、profile no-op 与 legacy role adapter。
- [x] **RFC-305-T11** opaque direct/delegated operation context；禁止对象字面量伪造 authority。
- [x] **退出门**：public export/import allowlist、writer 分母、迁移、并发、回滚、审计、invariant 定向测试全绿。

### 批 C — transport、消费者与即时撤权

- [x] **RFC-305-T12** session/PAT/daemon/current actor 每请求重读 role+grants+status+revision。
- [x] **RFC-305-T13** scheduled/call/workgroup/webhook 以 subject ref 重新解析 delegated authority。
- [x] **RFC-305-T14** WS subscribe/input/output 全部 DB revision fenced；认证 AppShell 常驻 `/ws/authority`，先发 `authority.changed` 再执行业务 channel 撤权关闭。
- [x] **RFC-305-T15** 删除 RouteMeta/MCP identity 轴及 `isResourceAdminRole` / admin short-circuit helpers。
- [x] **RFC-305-T16** 五个显式 capability 接回真实消费者：ACL、distill、Intent、MCP runtime test、Webhook owner override。
- [x] **RFC-305-T17** 所有前端 route/nav/action 改用具体 permission；malformed `/me` fail closed。
- [x] **退出门**：源码无账户角色授权比较；五点均有生产消费方；授予/撤销后同一 credential 立即生效。

### 批 D — 用户管理 UI

- [x] **RFC-305-T18** shared user schema 增 create grants、exact access snapshot 与 revision；legacy role 互斥。
- [x] **RFC-305-T19** `UserPermissionCatalog`：完整目录、分组、搜索、来源、风险、PAT、constraints、a11y。
- [x] **RFC-305-T20** Create/Edit Dialog 复用组件，不手写 permission id 表。
- [x] **RFC-305-T21** 角色切换按显式 grant rebase；baseline/intrinsic 锁定；无“全选”。
- [x] **RFC-305-T22** OCC 409 保留草稿与加载最新，dirty/reset/busy/error 完整。
- [x] **RFC-305-T23** EN/ZH 72 点 label/description 及错误文案穷尽。
- [x] **退出门**：前端纯模型/RTL/i18n/source locks/typecheck 定向全绿。

### 批 E — 行为、E2E 与发布

- [x] **RFC-305-T24** `scripts:author` grant/revoke 的敏感投影、保存和既有 workflow 执行回归。
- [x] **RFC-305-T25** `user + 全 24` 的 set 等价与真实 HTTP 行为；`role` wire 保持 `user`。
- [x] **RFC-305-T26** `resource-acl:bypass` 与 `memory-distill-jobs:manage` 正负/撤销行为。
- [x] **RFC-305-T27** `intent:audit`、`mcp-runtime-tests:audit`、`webhook-triggers:override-owner` 正负/只读/撤销行为。
- [x] **RFC-305-T28** `users:read` 独立开放 list/detail，`users:write` 开放 mutation；普通 user 可管理他人访问；self/system/last capability 防护。
- [x] **RFC-305-T29** PAT 五个新 system point 永不携带，matrix/range grant revoke/regrant。
- [x] **RFC-305-T30** Playwright 真实 daemon：390px/light/dark/a11y、create/edit/OCC/live WS、PAT cap。
- [x] **RFC-305-T31** 全量 format/typecheck/lint/depcheck/tests/migration/build 与 `bun run gate:local`：shared 2129、frontend 6459、backend 10663 pass（35 skip、0 fail），真实 binary + Chromium E2E 2/2。
- [ ] **RFC-305-T32** 固定提交 detached worktree 安装依赖并做 Codex implementation review，处置全部 P1/P2。
- [ ] **RFC-305-T33** 精确 staging、commit trailer、push、origin ancestry 与 exact-SHA GitHub Actions 终态验证。
- [ ] **RFC-305-T34** RFC/索引/STATE 改 Done，记录本地门禁、提交 SHA 与远端 CI 证据。

## 3. 必跑行为矩阵

| 主体         | 附加权限                          | 正向                            | 负向/撤销                                   |
| ------------ | --------------------------------- | ------------------------------- | ------------------------------------------- |
| user session | `scripts:author`                  | 可读写脚本敏感字段              | 无 grant 脱敏/403；已保存 workflow 仍可执行 |
| user session | `resource-acl:bypass`             | 他人 private resource 200       | 无/撤销为 404                               |
| user session | `memory-distill-jobs:manage`      | HTTP + WS 可用                  | 无/撤销为 403 / permission-required         |
| user session | `intent:audit`                    | 跨 owner exact read / `all=1`   | mutation 仍 404；撤销读为 404               |
| user session | `mcp-runtime-tests:audit`         | exact-id transcript read        | latest 不枚举、end 不放行；无 grant 404     |
| user session | trigger update + `override-owner` | 跨 owner update/delete          | 撤销回 404                                  |
| user session | `users:read` + `users:write`      | list/create/patch other user    | self access snapshot 拒绝                   |
| user session | 全 24                             | 与 admin 的 72 点和真实能力一致 | 移除单点只收窄该能力                        |
| PAT          | 任意 system-domain grant          | 无                              | 创建 matrix 拒绝且运行时剔除                |
| delegated/WS | grant/revoke                      | 下一 admission/revision 生效    | stale revision 不得继续收发/副作用          |

## 4. 架构防护

`rfc305-architecture-lock.test.ts` 必须冻结：

- `identity-access/public` 仅五个 exact entrypoint 及审核 export；
- 模块外 import allowlist 不增长；
- role/grant/revision/audit 单生产 writer；
- backend/frontend 无账户角色字面量授权比较；展示和非账户 protocol role 仅 exact allowlist；
- `RouteMeta`、MCP tool 无 `identity`；退役 role helper 零引用；
- system-domain 每点有真实生产消费方；
- Create/Edit Dialog 只渲染共享目录组件；
- delegated opaque authority 和 WS DB revision/前端 refresh 围栏存在。

新权限的最小变更路径固定为：

```text
PERMISSIONS
  -> PERMISSION_CATALOG metadata
  -> EN/ZH label + description
  -> real consumer + reverse coverage
  -> automatic Create/Edit catalog row
```

## 5. 验证顺序

1. shared catalog/grant/PAT 定向；
2. backend migration、identity-access、五 capability、HTTP/WS/delegated 定向；
3. frontend model/catalog/dialog/i18n/router 定向；
4. Playwright RFC-305 real-daemon journey；
5. typecheck、lint、format、depcheck；
6. `bun run gate:local`；
7. exact staged diff 与固定 commit；
8. detached worktree `bun install --frozen-lockfile` + implementation review；
9. 处置 P1/P2 后重新 gate；
10. push 并按 exact SHA 等待 GitHub Actions 终态。

不得用 frontend 目录下的裸 `bun test` 代替 Vitest runner；DOM/`vi` 套件使用 package script。

## 6. 提交纪律

- shared `main` 不 stash/reset/rebase/amend/force-push；
- 只精确 stage RFC-305 owned paths/hunks，不 broad-stage 并行 WIP；
- commit message：`feat(auth): RFC-305 unify account permission grants`；
- 加实际模型 co-author trailer，并在 push 前用 `git show -s --format=%B HEAD` 核验；
- 本地 green、远端 exact-SHA green、RFC/STATE 证据三者分别报告，不互相替代。

## 7. Done 门

- [ ] proposal AC-1…AC-13 全部实证并勾选；
- [ ] 本计划 T1…T34 全部完成；
- [ ] 固定提交实现审查无未处置 P1/P2；
- [x] `bun run gate:local` 全绿；
- [ ] commit 已推入 `origin/main` 且远端祖先关系确认；
- [ ] exact SHA 或包含它的后继 SHA GitHub Actions 终态全绿；
- [ ] `design/plan.md` 与 `STATE.md` 标记 Done 并记录证据。
