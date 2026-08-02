# RFC-247 · 实施计划

- 状态：**In Progress**（2026-08-01 落档 → 设计门闭环 → 2026-08-02 起实现）
- 配套：[proposal.md](./proposal.md) · [design.md](./design.md)
- PR 策略：**单 RFC，内部 5 个 PR，按层切**（用户 2026-08-01 拍板）。每个 PR 独立跑绿、
  独立可回滚。

---

## PR 划分

| PR       | 主题                             | 依赖 | 交付后系统状态                                  |
| -------- | -------------------------------- | ---- | ----------------------------------------------- |
| **PR-1** | 路由元数据层 + 权限点重构        | —    | 内部重构，对外行为不变；「忘挂 gate」结构性消失 |
| **PR-2** | 令牌签发 + 矩阵 UI + 用途 + 脱敏 | PR-1 | 可签发令牌并用于 REST                           |
| **PR-3** | MCP 服务端 + 工具集              | PR-2 | 外部客户端可接入                                |
| **PR-4** | 审计表 + 删除快照 + 管理员可视面 | PR-3 | 可追溯                                          |
| **PR-5** | wiki + `/.well-known/mcp`        | PR-3 | 可自助上手                                      |

---

## 任务

### PR-1 · 路由元数据层与权限点重构

- [x] **RFC-247-T1**：设计并落地 `RouteMeta` 契约与 `registerRoute`（design §3.1）；
      支持 `permissions` 数组 AND 语义、`tokenAccess`、`publicReason`。
- [x] **RFC-247-T2**：权限目录重构——`资源:write` 拆为 `:create` / `:update` / `:delete`；
      新增 workgroups / scheduled-tasks / memory 的完整点；memory 旧五点退役并按 design §2.3
      映射；`ROLE_PERMISSIONS` 按 D15 等价照搬；`PAT_EXPLICIT_ONLY_PERMISSIONS` 升级为
      按 `:delete` 后缀派生的全集。
- [x] **RFC-247-T3**：全量迁移**36 个路由文件**的路由到 `registerRoute`，逐条填写 design §2.3
      的动词映射。**逐条回答「这条路由有没有跨域副作用」**，不按 URL 前缀想当然归档；已知的
      跨域副作用族**五条**必须用双点 AND 收口（design §2.3 的表）：`scheduled-tasks` 三条、
      `workgroup-tasks/dw-save-as-workflow`、`fusions` 的 launch 与 approve、
      `memory-distill-jobs/:id/retry`。另有**两条**改授权本身的走 `tokenAccess: 'never'`：
      `PUT /api/tasks/:id/members`、`PUT /api/workgroup-tasks/:taskId/config`。
      **范围含 `server.ts:159` 的 whoami 与 `mountAclEndpoints` 模板生成的 12 条 ACL 路由**。
- [x] **RFC-247-T3b**：`routes/memoryDistillJobs.ts` 的
      `requireResourceAdmin('memory:approve')` 随 memory 旧点退役改为 `memory:update`，
      **身份门保持 admin/manager 不放宽**（design §2.3 memory 小节的连带）。
- [x] **RFC-247-T4**：删除 `server.ts:183-247` 的**全部**手工门挂载（不只 183-211——
      下面还有 `configGate` :216-229、`/api/daemon` :234、`/api/backup*` :235-236、
      `/api/restore*` :237,243、`/api/runtime*` :246-247 六处）；实现启动期**双向**穷尽自检
      （无元数据的路由 → 启动失败；无路由引用的矩阵域权限点 → 启动失败）。
      权限点按真实路由派生——**不要**给 repos 补 `update`、给 skills 补 `execute`，
      实测这两个动词在这两个域没有任何路由。
- [x] **RFC-247-T5**：修 `auth/actor.ts:40` 的空 scope 洞——删除 `patScopes.length > 0`
      短路，PAT 分支恒收窄（关闭 `docs/audit-backlog.md:61`）。
- [x] **RFC-247-T6**：`resolveTokenPermissions` 纯函数（design §2.2 公式）+ 表驱动测试；
      角色点集快照测试重写（`ADMIN_ONLY_PERMISSIONS` / `MANAGER_DENIED_PERMISSIONS`）。
- [x] **RFC-247-T7**：`verbForRoute` 映射表逐行测试；`routeMetaCoverage` 断言生产 app 无缺漏；
      每个域各一条「窄令牌被拒」集成测试；**跨域副作用族五条专属回归**（AC-29），文件名与顶部注释写明它锁的是
      「A 域路由产生 B 域副作用」这一族。
- [x] **RFC-247-T8**：在 `docs/audit-backlog.md` 记录收口——`:60`（workgroups 无 method 点）、
      `:61`（空 scope 全权）、`:62`（任务操作面无写点 + cancel 死点）三条随本 RFC 关闭；
      `:63`（review 评论不验作者）**不关**，本 RFC 只是把它从 `tasks:delete` 的误归中解开。

### PR-2 · 令牌签发、矩阵 UI 与脱敏

- [x] **RFC-247-T9**：migration —— `user_pats` 加 `purpose` 列；存量行统一标记 `revoked_at`
      （D19 断代）。
- [x] **RFC-247-T10**：重开 `POST /api/auth/pats`；创建期校验（越权 422、删除档必须显式、
      原始令牌只返回一次）；`tokenAccess: 'never'` 覆盖 `/api/auth/*` 与 ACL PUT。
- [x] **RFC-247-T11**：用途门 —— `mcp_only` 令牌打 `/api/*` → 403 `token-mcp-only`。
- [x] **RFC-247-T11b**：**WS 用途门** —— `/ws/*` 在 `multiAuth` 之外（`cli/start.ts:551-556`
      先走 `ws.tryUpgrade`），必须在 `ws/server.ts` 的 `tryUpgrade` 里单独实施：
      `mcp_only` 令牌 401。（design §3.5）
- [x] **RFC-247-T12**：`services/tokenRedaction.ts` 单一事实源 + **两条出口**接线 ——
      REST 响应序列化 **与 `ws/broadcaster.ts` 的出帧路径**（MCP env / headers /
      oauth secret / cached_repo url）。脱敏必须挂在通道无关的位置，否则 WS 是绕过路径。
- [x] **RFC-247-T13**：账号页令牌区改造 —— 模板（只读 / 任务自动化 / 完整）+ 高级矩阵展开；
      **只渲染该角色实际拥有的档位**；删除档不进任何模板且带显著警告；
      移除 RFC-221 留下的「生成已关闭」NoticeBanner。复用 `Dialog` / `Form` / `Segmented` /
      `Switch` 等既有公共组件，禁止自写 chrome。
- [x] **RFC-247-T14**：zh-CN / en-US i18n；令牌创建与矩阵的单测 + 脱敏红绿测试；
      RFC-221 的三条锁定测试改写为新语义（不删除）。

### PR-3 · MCP 服务端与工具集

- [x] **RFC-247-T15**：`POST /api/mcp` —— `StreamableHTTPServerTransport` 无状态挂载；
      只接 PAT；全局开关（config 项 + settings UI，默认开启）。
- [x] **RFC-247-T16**：任务域具名工具（`launch_task` / `get_task` / `list_tasks` /
      `get_task_diff` / `list_node_runs` / `cancel_task` / `retry_node` / `resume_task` /
      `diagnose_task` / `repair_alert`）。
- [x] **RFC-247-T17**：`watch_task` —— ≤240s 阻塞、**≤10s 心跳 progress**（design §2.4 实测
      推出的硬要求）、超时返回快照 + `stillRunning`。
- [x] **RFC-247-T18**：人工门工具完整面（`list_pending_gates` / `answer_clarify` 逐题+提交 /
      `submit_review` 逐文档评论+通过打回）。
- [x] **RFC-247-T19**：`resource_read` / `resource_write` + `method` 收敛工具；
      `describe_resource` 由 zod 派生 JSON Schema；`describe_capabilities`。
- [x] **RFC-247-T20**：删除工具接 `assertDeleteConfirm`，并把它从 7 条**补到 11 条**
      （skill 文件 / cached-repo / memory / scheduled-task）；`launch_task` 的 upload 输入检测
      （零副作用拒绝）。
- [x] **RFC-247-T21**：`tools/list` 按矩阵过滤；错误语义（缺失点名 + 脱敏文本 + 闭合
      `additionalProperties` 的入参 schema）。
- [x] **RFC-247-T22**：MCP 测试 —— `tools/list` 三种矩阵快照、`watch_task` 假时钟心跳、
      confirm 红绿、upload 拒绝断言无落库、错误文本不含密钥。

### PR-4 · 审计与删除快照

- [x] **RFC-247-T23**：migration —— `token_audit` + `token_delete_snapshot` 两表 + 索引。
- [x] **RFC-247-T24**：两条通道的审计写入（旁路、失败不阻断业务）；**不记 body**。
- [x] **RFC-247-T25**：删除快照（复用 T12 脱敏；任务删除只存 DB 行不含 worktree）。
- [x] **RFC-247-T26**：`tokenAuditRetentionDays` 配置项（默认 90）+ 清理器挂进既有小时级
      后台任务。
- [x] **RFC-247-T27**：`GET /api/auth/pats/audit`（属主自查）+ 管理员全平台令牌与审计
      **只读**面（无吊销按钮）。
- [x] **RFC-247-T28**：审计测试（字段正确、无 body、快照脱敏、保留期清理、写入失败不阻断）。

### PR-5 · wiki 与端点发现

- [x] **RFC-247-T29**：`GET /api/docs/api` —— 从 `RouteMeta` + 工具注册表 + 权限目录 +
      错误码常量派生，按角色裁剪。
- [x] **RFC-247-T30**：`GET /.well-known/mcp`（无需认证，挂在 SPA catch-all 之前，
      **不动** `PUBLIC_PATH_PREFIXES`）。
- [x] **RFC-247-T31**：`/docs/api` 页面 —— 复用 `Prose` / `PageHeader` / `Card` /
      `PageSectionNav` / `TabBar`；MCP 接入指南 + REST 参考两个分区。
- [x] **RFC-247-T32**：配置片段生成器 —— Claude Code / **opencode（必带 `oauth: false`）** /
      通用 MCP 客户端 / 裸 curl；地址由 `window.location.origin` 推导；令牌为占位符。
- [x] **RFC-247-T33**：入口 —— 账号页令牌区旁 + 设置页各一个；`lib/nav.ts` 的 `NAV_GROUPS`
      **不动**。
- [x] **RFC-247-T34**：双语外壳 + 生成内容保持英文；i18n key 补齐。
- [x] **RFC-247-T35**：wiki 测试 —— **派生关系锁定**（改一条 `RouteMeta` 权限点 ⇒ 文档输出
      随之变）、角色裁剪、`Prose` 唯一性源码断言、390px 无横向溢出 Playwright。

### 收尾

- [x] **RFC-247-T36**：`docs/dev-gotchas.md` 补记本轮的通用踩坑（opencode
      `resetTimeoutOnProgress` / `DEFAULT_TIMEOUT=30s` / `oauth` 默认探测三条）。
- [x] **RFC-247-T37**：`docs/audit-backlog.md` 登记 design §11 的 `mcp.ts:88-91` 过期断言。
- [x] **RFC-247-T38**：`design/RFC-221-account-users-ux/proposal.md` 的 D1 标注
      「Superseded by RFC-247」。
- [ ] **RFC-247-T39**：设计门（Codex review，请批前）+ 实现门（Codex review，declare done 前）
      各一轮并修 findings。
- [ ] **RFC-247-T40**：`bun run typecheck && bun run lint && bun run test && bun run format:check`
      全绿 + binary build smoke + Playwright；推送后按**自己的确切 sha** 查 CI。

---

## 验收清单

对应 proposal §5 的 AC 编号。

### 授权层

- [x] AC-1 权限目录无 `资源:write`；三档齐全；角色点集快照锁定
- [x] AC-2 全路由有元数据；删任一条声明 ⇒ 启动失败（有测试）
- [x] AC-3 `server.ts` 无手工门挂载（源码层文本断言）
- [ ] AC-4 真正无 gate 的 workgroups / reviews / clarify（+ scheduled-tasks PUT/DELETE）各有「窄令牌被拒」测试
- [ ] AC-5 空矩阵 = 只读
- [ ] AC-6 `scheduled-tasks` 双点 AND，无法绕过 `tasks:execute`

### 令牌

- [ ] AC-7 创建可用；原始令牌只出现一次；越权 422 而非静默丢弃
- [ ] AC-8 删除档不进任何模板；「完整」模板签出的令牌 DELETE 全 403
- [ ] AC-9 `mcp_only` 打 `/api/*` → 403 专用码；通用两通道皆通
- [ ] AC-10 令牌打 `/api/auth/*` 全方法拒绝
- [ ] AC-11 令牌打 ACL PUT 拒绝
- [ ] AC-12 令牌读三类 MCP 密钥字段全掩码；session 通道明文不变

### MCP

- [ ] AC-13 `/api/mcp` 只接 PAT
- [ ] AC-14 `tools/list` 随矩阵变化
- [ ] AC-15 `watch_task` ≤10s 心跳、240s 超时返回快照
- [ ] AC-16 删除工具 confirm 校验，零副作用
- [ ] AC-17 upload 类工作流拒绝且无落库
- [ ] AC-18 全局开关同时关掉 `/api/mcp` 与令牌创建

### 审计

- [ ] AC-19 每次调用留痕且不含 body
- [ ] AC-20 每次令牌 DELETE 有脱敏快照
- [ ] AC-21 属主自查 / admin 全看 / 到期清理

### wiki

- [ ] AC-22 文档由代码派生（派生关系有测试锁定）
- [ ] AC-23 按角色裁剪
- [ ] AC-24 四份配置片段可直接使用
- [ ] AC-25 opencode 片段带 `oauth: false`
- [ ] AC-26 双语外壳 + 英文标识符
- [ ] AC-27 复用 `Prose`，无第二个渲染器
- [ ] AC-28 390px 无页面级横向溢出

### 设计门追加

- [x] AC-29 跨域副作用族五条各有专属回归
- [ ] AC-30 `mcp_only` 令牌无法建立 WS 连接
- [ ] AC-31 脱敏对 REST 与 WS 两条出口一致生效
- [ ] AC-32 `memoryDistillJobs` 门改 `memory:update`，身份门不放宽
- [x] AC-33 路由元数据覆盖生产 app 上每一条路由（含 whoami 与模板 ACL 路由）

### 设计门第二 / 第三批

- [ ] AC-34 `PUT /api/tasks/:id/members`、`PUT /api/workgroup-tasks/:taskId/config` 为 never
- [ ] AC-35 cancel 归 `tasks:execute`；空矩阵令牌取消被拒
- [ ] AC-36 npm 安装带 `--ignore-scripts`（postinstall fixture 断言未执行）
- [ ] AC-37 WS 默认拒绝白名单放行；新增频道未声明裁决即编译失败
- [ ] AC-38 `rowToTask` 脱敏 `repoUrl`（对所有通道）
- [ ] AC-39 stdout 脱敏；文案不得承诺 worktree 文件脱敏
- [x] AC-40 `/api/runtimes` 两条 GET 要求 `runtime:read`
- [ ] AC-41 退役点清扫覆盖整个 backend（含 WS gate 与 `as never` 处）
- [ ] AC-42 `/.well-known/mcp` 公开且先于 SPA catch-all
- [ ] AC-43 管理员**不能**吊销他人令牌（负向断言）
- [ ] AC-44 wiki 入口两处；`NAV_GROUPS` 零改动
- [ ] AC-45 `assertDeleteConfirm` 覆盖 11 条
- [x] AC-46 `RANGE_POINTS` / `ROUTE_BACKED_POINTS` 存在；`READ∩SYSTEM=∅`
- [x] AC-47 资源键统一 `scheduled-tasks`，无 `schedules:` 变体
- [x] AC-48 `overview` / `plantuml` 补门

---

### 2026-08-02 — PR-1 收官（T3 全量 + T4 双向自检）

**T3 完成**：剩余 ~175 条路由全部迁移，**252 条全覆盖**。含两处不在路由文件里的挂载：
`GET /api/whoami`（`server.ts`）与 **12 条模板生成的 ACL 路由**（`mountAclEndpoints` 自己登记
元数据——留给六个调用方就是六次写出不同契约的机会）。

**T4 完成**：删除 `server.ts` 全部 **73 行**手工门；`assertRouteMetaCoverage` 接进 `createApp`，
**生产 app 通过双向自检**——每条路由都有声明，每个矩阵域点都有路由。

#### 迁移暴露的六个真问题

| #   | 问题                                                                                                                                                          | 处置                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | **gate 让登录不可能**：`publicReason` 路由在 `PUBLIC_PATH_PREFIXES` 里、context 无 actor，而 `routeMetaGate` 调 `actorOf` 直接抛 401（15 条 auth 测试当场红） | 改为「无 actor 时由**声明**决定是否需要身份」                                                   |
| 2   | 自检在真实 app 上抓到 4 条「未声明路由」，实为 `app.use()` **中间件**（Hono 与端点同表、method 记 `ALL`）                                                     | 按 **method 结构性区分**，不往豁免名单加 4 条路径——手工名单会长成洞                             |
| 3   | 反 Zod 守卫抓到 `?phase=` 的 `as TaskQuestionPhase`——**真不安全**：`?phase=bogus` 穿到 service 静默匹配不到                                                   | **不加豁免**，按守卫要求修：新增 `TaskQuestionPhaseSchema`，非法值 422                          |
| 4   | 我自己在 `resourceAcl.ts` 写的 `as` 联合断言                                                                                                                  | 改**穷尽 Record**；TS 当场抓到它会生成 `repos:update`——刻意从未创建的点                         |
| 5   | 三条测试在测**中间件的影子**：`POST /api/repos` 根本不是端点，403 只因前缀中间件在路由前拦截                                                                  | 指向真实存在的 repos 域写端点；**行为变化如实记录**：网关下不存在的路径由 403 变 404            |
| 6   | **测试夹具占用生产路径 `/api/whoami`**——注册表是进程级单例，共享进程下与真实声明撞成「同路径不同契约」                                                        | 改合成路径；已写进 `docs/dev-gotchas.md`（含「本地复现 CI 用 `bun run test` 而非 `bun test`」） |

> 第 6 条只在**不带 `--isolate`** 时才炸。CI 与 `bun run test` 都带该 flag，所以它本可以一直
> 潜伏——本轮是手敲 `bun test` 才暴露。收口后**共享进程模式也全绿**，比 CI 的隔离模式更严。

- 门禁：typecheck 三包 / lint / format 全绿；shared **1555**、frontend **678 文件 5648**、
  backend **7991 pass / 28 skip / 0 fail**（共享进程模式）。

## 风险与已知取舍

| #   | 项                                                               | 处置                                                                                                   |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| R1  | PR-1 触及全部 ~200 条路由，是本 RFC 最大的单点风险               | 启动期穷尽性自检 + `verbForRoute` 逐行表驱动测试，把「漏改」变成「跑不起来 / 测试红」                  |
| R2  | 严格 DELETE 规则导致「删技能附件」与「删整个技能」同档           | design §2.3 已如实标注；不开语义例外（可判定性优先）                                                   |
| R3  | 同上导致**经令牌无法删评审评论**（`tasks:delete` 是 admin 专属） | 同上如实记录；日后放开的正解是拆独立资源域，不是给规则开例外                                           |
| R4  | 管理员不可吊销他人令牌                                           | 用户知情决策；外泄处置 = 禁用账号 / 关全局开关；属主本人可吊销                                         |
| R5  | `/.well-known/mcp` 向未认证访客确认平台存在                      | 用户知情决策；换来不污染 `PUBLIC_PATH_PREFIXES` 这道安全边界                                           |
| R6  | 全量 REST 文档暴露接口形状给所有登录用户                         | 按角色裁剪（AC-23）；内容只有形状与权限，不含任何资源数据                                              |
| R7  | opencode 默认 30s 超时可能断开 `watch_task`                      | 已由 ≤10s 心跳 progress 解决（源码实测 `resetTimeoutOnProgress: true`）；片段里同时给 `timeout` 建议值 |

---

## 交付记录

### 2026-08-01 — 设计门闭环

Codex 直驱路径 wedge（rollout 1.05MB 后冻结、CPU 0）；按 dev-gotchas 止损不重试，改用两个正交
视角的 Claude 子代理对抗评审替代，全过程与替代关系记档于
[`design-gate-2026-08-01.md`](./design-gate-2026-08-01.md)。合计 **5 P0 / 17 P1 / 23 P2**，
逐条核实后全部折入三份文档（新增 AC-29～AC-48）。其中并行自查独立命中 6 条，两个视角独立复现
2 条（`cached_repos.url` 是 no-op、cancel 范围点是死点）。

### 2026-08-02 — PR-1 首批（权限目录与授权公式）

- **T2 完成**：`permission.ts` 重写。60 点 / 48 矩阵域 / 46 route-backed；`资源:write` 全部拆分；
  memory 旧五点退役；`tasks:launch → tasks:execute`；删除零引用死点 `tasks:cancel:own|all`；
  新增 `MATRIX_RESOURCES` / `MATRIX_VERBS` / `RANGE_POINTS` / `ROUTE_BACKED_POINTS` /
  `resolveTokenPermissions` / `grantableMatrixPoints`。**未**造 `repos:update` 与 `skills:execute`
  两个对称直觉死点。
- **T5 完成**：`auth/actor.ts` 的 `patScopes.length > 0` 短路删除，PAT 分支恒走
  `resolveTokenPermissions`（关闭 `docs/audit-backlog.md:61`）。
- **T3b 完成**：`memoryDistillJobs` 与 `ws/registry.ts` 的 `memory:approve` → `memory:update`。
- **T3 部分**：`verbForRoute` 落地为 §2.3 映射表的单一事实源，`resourcePermissionGate` 改为消费它；
  全仓 39 文件 / 152 处退役点引用迁移完毕。
- **T6 完成**：`permission.test.ts` 与 `permission-rfc041.test.ts` 按新语义重写（保留 RFC-036 /
  041 / 099 / 222 的全部原意），新增 `rfc247-verb-for-route.test.ts`（34）与
  `rfc247-token-grants.test.ts`（12）。
- **T36 / T37 完成**：`docs/dev-gotchas.md` 记入 opencode MCP **客户端**三条实测行为；
  `docs/audit-backlog.md` 标记 `:60` / `:61` / `:62` 三条收口，并新登记三条（插件安装仍在
  containment 外、`shared/schemas/mcp.ts:88-91` 过期断言、`/ws/repo-imports` 无 gate 的 session 侧）。

### 2026-08-02 — PR-1 第三批（系统域 / 仓库域迁移 + 双门收进元数据）

再迁 **15 条**，累计 **67 条**：`memoryDistillJobs`(5) · `overview`/`plantuml`(2，**此前完全无门**，
AC-48) · `daemon`/`backup`/`runtime`(3) · `repos`/`cached-repos`(8)。

两处不是机械迁移能带过去的：

1. **RFC-222 的双门收进 `RouteMeta`**（新增 `identity?: 'admin' | 'resource-admin'`）。
   `memoryDistillJobs` 原本是 `requireResourceAdmin('memory:update')`——身份门 + 权限点两道。
   把身份门留在 `registerRoute` 旁边当中间件是可行的，但**生成的 API 文档会低估要求**：
   文档会说「需要 `memory:update`」，而该点就在**普通 user 基线**里，读者会以为普通用户能调。
   注册表存在的意义就是让文档不漂移，所以完整契约必须都在声明里。新测试锁死这点：
   持 `memory:update` 的**普通 user** 令牌被拒，错误为 `resource admin only`。
   同批补上**第五条跨域 AND**：`POST /api/memory-distill-jobs/:id/retry` 会让调度器
   **拉起真实模型进程**（`memoryDistillScheduler.ts:342` / `:448`），故需
   `memory:update AND tasks:execute`。
2. **自己制造的门冲突（实测抓到）**：`server.ts` 的 `resourcePermissionGate('repos')` 仍在跑，
   它对 `POST /api/cached-repos/:id/refresh` 算出 `repos:create`，而新元数据声明 `repos:execute`
   ——一枚只持其中一个点的令牌会被**另一道门**拒掉。repos 套件没暴露它，因为那些用例跑在
   admin 身份下（什么都有）。已给 `verbForRoute` 补对应 override，让**两道门读同一个函数**，
   结构上不可能再分歧；并加一条「`batch-import` 仍是 create」的邻居用例，防止将来放宽正则时
   把它误扫进 execute。

#### 第二次「机械迁移静默反转前序决定」——并已固化为守卫

`POST /api/agents/:id/tasks` 机械写成 `agents:execute AND tasks:execute`，**当场把
RFC-165 的 A9 回归打红**。`server.ts:180-186` 原文：「launching is a TASK operation on every
subject face —— 三条启动端点**统一** gate 在 `tasks:launch`，且 agent 启动路径**豁免** agent
方法门」。这是与 `PUT /api/scheduled-tasks/:id`（payload-conditional）**同一类错误的第二次
实例**；两次都是**既有的具名回归**当场抓住的——若那两条测试不存在，两处都会静默上线。

连带：`agents:execute` / `workgroups:execute` 失去唯一候选路由 ⇒ 成死点 ⇒ 按 §3.2 规则不该
存在，已删（**60 → 58 点**，user 基线 48 → 46）。

`rfc247-cross-domain-escalation.test.ts` 新增**迁移守卫**，把规律固化为可执行断言：

> **AND 成立的条件是「路由产生了它所在域之外的副作用」，不是「路由挂在某个资源的 URL 下」。**

守卫锁在两个犯错位置：scheduled-task PUT 必须单点、POST/run-now 必须双点、启动端点不得出现
非 tasks 域的 `:execute`。**下一批迁移再推导出错误答案就会红。**

#### 另修两处

- **门冲突**：`server.ts` 的 `resourcePermissionGate('repos')` 仍在跑，对
  `POST /api/cached-repos/:id/refresh` 算出 `repos:create`，而新元数据声明 `repos:execute`
  ——只持其中一个点的令牌会被**另一道门**拒掉。repos 套件没暴露它，因为那些用例跑在 admin
  身份下（什么都有）。已给 `verbForRoute` 补 override，让**两道门读同一个函数**，结构上不可能
  再分歧；并加「`batch-import` 仍是 create」的邻居用例防止将来放宽正则时误扫。
- **测试助手真 bug**：`ensureMounted` 用**一个** try/catch 包住全部 mount，第一个抛异常的
  mount 会让后面所有 mount **静默跳过**，测试却报「did the route move?」把人指向错误方向。
  改为逐 mount 独立 try/catch。

> **`server.ts` 的手工门本批仍保留**（与迁移后的路由双重把关、判据同源，无行为差异）。
> 按 design §3.2 的硬顺序 **T1 → T3 → T4**，它们随 T4 的双向自检一起摘除——在全量覆盖被
> 证明之前摘门就是在赌自己没漏，正是这道自检要消灭的赌。

#### 语义变更的测试爆炸半径（实测，全部按新契约重写而非删除）

全量 backend 套件揭示 5 条依赖旧语义的断言，**没有一条是回归**——都是本 RFC 有意改变的行为
被既有测试锁着。逐条按「保留原意、改锁新契约」处理：

| 测试                             | 锁的旧语义                                            | 为什么变                                                             | 处置                                                                                                                                        |
| -------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth-session.test.ts` ×2        | PAT 权限**恰好等于** scopes                           | D3 读恒开 ⇒ 多 11 个读点                                             | 改断言「非读点恰好等于所勾档位」，读点单独确认                                                                                              |
| `rfc190-overview-route.test.ts`  | PAT scope 能**剥掉资源读** ⇒ 该 key 为 null           | 同上，令牌不可能缺读点                                               | null 分支改用 `exactActor`（精确权限集、绕过角色基线）直接构造——**该分支在 `buildOverview` 里仍存在，删测试等于静默退掉真实代码路径的覆盖** |
| `auth-self-service-idor.test.ts` | PAT 可调 `GET /api/auth/me` 证明「令牌仍有效」        | D6 关闭整个 `/api/auth/*`                                            | 探针换成 `/api/whoami`（在该面之外、令牌可达），**证明的事情不变**：bob 被拒的 DELETE 没有真的吊销                                          |
| `api-contract-coverage.test.ts`  | `src/routes/*.ts` 里的 `app.<verb>('literal')` 即路由 | 我在 `registry.ts` 的 JSDoc 里写了一个 `app.get('/x', handler)` 示例 | **改我的注释**——该扫描器的 `stripLineComments` 不剥块注释，是既有盲点；不动共享测试，并在 `registry.ts` 里写明这条约束                      |

> **迁移中间态（T4 落地前的已知状态，不是缺陷）**：本批新增的点里有一部分**暂时没有路由引用**
> —— `tasks:read`、`workgroups:*`、`scheduled-tasks:*`、`memory:create|update|delete`、
> `tasks:update`、各 `:execute` 等。原因是它们的路由今天还没有粗粒度门（这正是本 RFC 要补的），
> 要等 **T1 的 `RouteMeta` + T3 的全量迁移**把它们声明出来。
> **T4 的反向穷尽自检必须最后落**——它一旦生效，上述任何一个点没被 `RouteMeta` 引用就会让
> daemon 起不来，这正是它存在的意义；但在 T3 完成前打开它会挡住自己的迁移路径。
> 顺序硬约束：**T1 → T3 → T4**。

### 2026-08-02 — PR-2（令牌签发、用途门、脱敏、矩阵 UI）

PR-2 全六项（T9–T14）交付，`POST /api/auth/pats` 重开。

- **T9/T10**：migration `0129` 加 `purpose` 列并按 D19 断代吊销存量行；创建路由做三重校验
  （全局开关 → 越权矩阵 422 且**指名**越权点 → 原始令牌只返回一次）。
- **T11/T11b**：用途门落在**两条互不共享代码的通道**——`registerRoute` 的派生门（排在
  `tokenAccess: 'never'` 之后，让「永久理由」压过「换发即可解」的理由）与 `ws/server.ts`
  的 `tryUpgrade`（在 `multiAuth` 之外，不单独实施就等于给 `mcp_only` 令牌开了等价读通道）。
- **T12**：`services/tokenRedaction.ts` 单一事实源，接在 REST 序列化与 WS 出帧两条出口；
  顺带修掉 `services/task.ts` 四处 `rowToTask` 的 repo URL 明文（既有泄漏，四条通道全中）。
- **T13**：账号页矩阵 UI。派生逻辑抽进 `lib/token-matrix.ts`（纯函数、无 DOM 可断言），
  组件只做渲染；新增**公共** `Checkbox` 原语（`Switch` 渲染的是开关，40 格网格里语义不对；
  仓内已有 5 处手搓 `<input type="checkbox">`，第 6 份私有拷贝会让「我们没有 checkbox 原语」
  永久为真）。角色拿不到的档位**不渲染**而非置灰——置灰是在教用户「你有这个能力，只是没开」。
- **T14**：中英 i18n（退役 `patGroup`/`patScope` 两棵死键树）+ 51 条新测试。

RFC-221 的三条锁定测试按 design §10 全部**改写而非删除**：两条后端锁改为锁「签发契约」，
e2e 那条改为锁**整链**（签发 → 哈希 → 出示 → 解析 → 门），并新增一条真正的开关测试
——`mcpSurfaceEnabled: false` 时创建被拒且零副作用，这才是 RFC-221「不能绕过 UI 直接建」
那层意图在新语义下的落点。

#### 本批踩的坑

删 `account.generate` 时用「4 空格 + 键名」做 `str.replace`，**吃掉了 6 空格缩进的
`intent.journey.generate`**（深缩进行天然包含浅缩进模式）。`tsc` 与 i18n parity 双绿
——两个语言文件加类型定义被对称吃掉，类型层看不出——只有一条渲染断言变红。已记入
`docs/dev-gotchas.md §前端`。

### 2026-08-02 — PR-3（MCP 服务端与工具集）

**架构决定：MCP 工具走的是 REST 的同一张路由表，而不是绕过它调 service。**
`server.ts` 抽出 `mountApiRoutes(app, deps)`，`mcp/dispatch.ts` 用它建第二个 app——
不挂 `multiAuth`，actor 经 `AsyncLocalStorage` 以**值**传入（请求伪造不了值，只有代码能设）。
收益是结构性的：门、载荷校验、行级 ACL、删除确认、修订栅栏全部是同一条代码路径，
MCP 在结构上**不可能**成为第二个更弱的授权面。实测立刻兑现——删除确认与 RFC-231 修订栅栏
在 MCP 通道自动生效，没写一行相关代码。

- **T15**：`POST /api/mcp`。**修正 design §4.1**：SDK 里 `StreamableHTTPServerTransport` 是
  Node `IncomingMessage` 包装层，本仓是 Bun + Hono（请求就是 web 标准 `Request`），
  应使用 `WebStandardStreamableHTTPServerTransport`——它是同一个传输的**内核**（Node 那个包着它），
  其 docstring 直接给的就是 Hono 用法。只接 PAT（session / daemon 403），全局开关同时关签发与本端点。
- **T16–T19**：任务域具名工具 + 人工门工具 + `resource_read` / `resource_write` /
  `describe_resource` / `describe_capabilities`。资源路由表**按真实路由抄写**而非对称猜测——
  三处猜测会错：repos 是批量导入且**没有 update**、memory 是 PATCH、tasks 不进收敛工具
  （启动不是「创建资源」，且已有具名工具）。修订栅栏字段**必须由调用方从读结果带回**，
  工具**不代填**——代填等于在唯一重要的时刻（两个写者竞争）废掉栅栏。
- **T17**：`watch_task` ≤240s、≤10s 心跳、触顶返回 `stillRunning` 而非报错；
  `awaiting_review` / `awaiting_human` 计入「已停」——那正是模型需要知道的时刻，
  当成「还在跑」会把整个预算耗在一个没人回答就不会动的任务上。假时钟驱动测试。
- **T20**：删除确认从 7 条补到 11 条，但**只对令牌调用方**生效
  （`assertTokenDeleteConfirm`）。四条落在外面的路由（定时任务 / 记忆 / 仓库镜像 / 技能文件）
  的 Web 流程是**有意**用更轻的确认——记忆的身份是 120 字标题，逼人重打是拿错风险换 UX。
  令牌没有对话框，且 `general` PAT 走 REST 也能到，所以只补 MCP 工具等于在补丁旁边留着洞。
  非对称是刻意的，与本 RFC 的 `shouldRedactFor` 同构。

#### 本批抓到的真实缺口（T12 的自我更正）

`redactMcpRecord` 写了、单测了，**但没有任何调用方**——`GET /api/mcps/:id` 一直原样返回
`config.env` / `headers` / `oauth.clientSecret`。此前 STATE 里「T12 接了 REST 与 WS 两条出口」
只对 `redactGitUrl` 那一半成立。已补 `serializeMcpFor(record, source)` 作为**唯一出口**并接在
`routes/mcps.ts` 的 5 个序列化点上（WS 侧确认无频道承载 MCP 定义记录，故无第二处）。
红绿锁在 `rfc247-mcp-server.test.ts`：PAT 读到 `***` 而键名保留，session 读到原值。
**这个洞是写 MCP 工具测试时发现的**——`resource_read(kind='mcps')` 会把它直接送进模型上下文。

### 2026-08-02 — PR-4（调用审计）与 PR-5（生成式 wiki）

**PR-4 · 审计（T23–T28）**

- `services/tokenAudit.ts`：一次调用一行，**两条通道各挂一个钩子**——REST 是 `/api/*` 上的
  一条中间件（挂在 `multiAuth` 之后、路由之前，`next()` 之后记录，观察得到抛错的路由），
  MCP 是**逐工具**记录（每次 MCP 调用都是同一个 `POST /api/mcp`，请求行不携带任何信息，
  工具名才携带）。`Actor` 加 `patId`——审计按**令牌**而非用户归集，因为「同一个人的两枚令牌
  在做不同的事」正是运维打开日志时想区分的东西。
- **不记 body**：`resource_write` 载荷里有 MCP env 与仓库凭据；存 body 的审计表是新的泄漏面，
  不是控制项。删除额外落一份**脱敏快照**——元数据回答「谁删了什么」，不回答「那是什么」，
  而行没了以后后者才是要紧的。
- F13/F14：写审计失败 **不阻断业务**（一个写不进日志就拒绝服务的守护进程，把可观测性做成了故障）；
  快照失败保留审计行。保留期清理挂进既有小时级 sweep。
- 读面：属主 `GET /api/auth/pats/audit`（令牌不可读——D6 关闭整个 `/api/auth/*`，
  一份被攻陷令牌能读的审计日志是「还能试什么」的地图）；管理员 `GET /api/tokens` /
  `/api/tokens/audit` **只读**，**没有** DELETE：管理员看得见每一枚令牌却不能吊销别人的，
  对应手段是停用账号——一次吊销全部，且是诚实的动作。

**PR-5 · wiki（T29–T35）**

- `GET /api/docs/api` 运行时从 `allRouteMeta()` + 工具注册表 + 权限目录派生，**按角色裁剪**
  （普通 user 看不到仓库域写端点；`tokenAccess:'never'` 的整片不出现——本页讲的是令牌能做什么）。
  AC-22 的锁不是「输出里有某个字符串」（手写页面也满足），而是**改一条 `RouteMeta` 的权限点，
  输出跟着变**。
- `/docs/api` 页面走 `Prose`（AC-27 源码级守卫：`components/prose` 之外不得新增 markdown 渲染
  入口；RFC-010 的 review diff 视图作为**具名例外**列入白名单，让例外可见、让第二个必须先说服人）。
  markdown 由 `lib/api-docs-markdown.ts` 纯函数生成，前端这半边的派生锁同样可断言。
- 客户端片段四种（Claude Code / opencode / 通用 / curl），opencode 那份必带 `oauth: false`
  （源码实测：不写会先探测 OAuth）。`/.well-known/mcp` 免鉴权，只讲端点与鉴权方式——
  免鉴权地列出全部工具等于白送一份能力清单，何况工具集本来就是按令牌变的。
- e2e 真实浏览器 5/5：派生内容渲染、`oauth:false`、**390px 无页面级横向溢出**、宽块自身可滚、
  `/.well-known/mcp` 免鉴权可达。

#### 全量套件揭示的三条（PR-3〜PR-5 收尾）

| 测试 | 现象 | 归属与处置 |
| --- | --- | --- |
| `rfc165-scheduled-kinds.test.ts` K6 | narrow PAT 删除定时任务由 200 变 422 | **本 RFC 有意**。K6 锁的是「删除**不需要**启动权限」——那条**仍然成立**；T20 加的是「令牌必须**指名**要删的东西」，两条正交（一条讲权限、一条讲意图）。测试改为先断 422 `delete-confirm-required`、再带 `confirm` 断成功，**原意完整保留**。存量令牌已被 migration 0129 全部吊销，故此 break 无活跃调用方。 |
| `api-contract-coverage.test.ts` | 5 条新端点未登记 | 该守卫正常工作。登记 `/api/auth/pats/audit`、`/api/tokens`、`/api/tokens/audit`、`/api/docs/api`、`/.well-known/mcp`（最后一条标 `public`）。 |
| `plugin-install` timeout kill | 全量套件下红、单独跑 17/17 绿 | **不属本 RFC**（未触及 `pluginInstaller`）；是 `timeoutMs` 杀子进程的时序敏感用例在满载下抖动。按 CLAUDE.md **不以「重跑就过」作为通过依据**——如实记录于此，留待其 owner 判定是真 flaky 还是真 bug。 |

顺带把 dispatcher 改为**首次使用时**才构建：它会把整张 `/api` 路由表挂进第二个 Hono app，
对一个从不收 MCP 请求的守护进程（或测试）是纯浪费——测试套件会建几百个 app。

两条 UX ratchet 也各自吃到本 RFC 的新东西，都按「让守卫学会」而非「把代码扭成守卫喜欢的样子」处理：
`overlay-ux-inventory` 要求每个 Dialog 调用点登记（`CreateTokenDialog` 两个 phase = count 2）；
`route-ux-inventory` 要求每条路由登记 owner + header 归属。
`onboarding-guide` 的「i18n 文案里不得出现 `**`」是**全库规则**，其前提是「没有任何地方 markdown 渲染
i18n 文案」——本 RFC 让这条前提第一次不成立（`apiDocs.*` 经 `buildApiDocsMarkdown` → `Prose`）。
处置是**窄豁免**：`apiDocs.*` 除 `title` / `subtitle`（它们进 `PageHeader` 纯文本槽，正是该守卫当初要防的
那个 bug）。豁免的前提本身也上了锁——`api-docs-markdown.test.ts` 断言 `docs.api.tsx` 里
**只有** 这两个键用在 markdown builder 之外，将来谁把新键喂进纯文本槽会立刻变红。

**末轮全量**：backend **8101 pass / 0 fail**、shared **1555**、frontend **681 文件 / 5698 tests**，
typecheck / lint / format 全绿。

#### AC 逐条回扫抓到的两个「写了规则没接出口」

收尾时按 AC-1〜AC-48 回扫，又抓到与 `redactMcpRecord` **同一形态**的第二例，以及两条只做了一半的 AC：

- **AC-39**：`redactStdout` 同样是「定义了、单测了、没有任何调用方」。已接在
  `GET /api/tasks/:id/nodes/:nodeRunId/stdout`，仅令牌通道生效——节点 stdout 是平台无法分类的
  自由文本，尽力而为；但一个 echo 过密钥的节点，离那把密钥进模型上下文只差一次 `get_task`。
  属主读自己那次运行的原始输出保持逐字（那正是他在调试的东西）。
- **AC-18 的另一半 / T15**：`mcpSurfaceEnabled` 有 config 项和后端读点，**没有 settings UI**。
  已加进 Network 分区（它管的正是「外面能不能驱动这台平台」），并附文档链接。
  `NetworkTab` 因此第一次需要 router 上下文，其既有测试的 `wrap()` 补了 memory router
  ——让它继续渲染**真组件**，而不是换成一个会与真组件漂移的替身。
- **AC-43 / AC-44**：补负向断言（admin 调他人 `patId` 的吊销端点被拒 403 且对方令牌仍有效）与
  入口锁（`lib/nav.ts` 不含 `/docs/api`；账号页令牌区与设置页各有一处）。

**教训**（已够格成为规律，并已上锁）：本 RFC 里「脱敏规则写完 + 单测写完」出现了 **两次** 之后
仍然没有调用方。单测测的是**函数**，接线是**另一件事**；只有从 AC 出发反查「谁调它」才会暴露。
已把这条判据写成可执行守卫（`rfc247-token-redaction.test.ts` 末段）：`tokenRedaction.ts` 导出的
**每一个** redactor 都必须在该模块**之外**被调用，否则红；外加三条具名出口断言
（stdout 路由 / `mcps.ts` 五个序列化点 / `rowToTask` 四处）。**做过变异实证**：拆掉三个
`serializeMcpFor` 调用点 → 红，装回 → 绿。
（正则要允许 `<T>` 出现在函数名与 `(` 之间——不允许的话这条守卫自己就只检查了一个子集，
正是它要防的那类漏检。）
