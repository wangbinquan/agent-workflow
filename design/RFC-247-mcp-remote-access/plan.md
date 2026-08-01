# RFC-247 · 实施计划

- 状态：**In Progress**（2026-08-01 落档 → 设计门闭环 → 2026-08-02 起实现）
- 配套：[proposal.md](./proposal.md) · [design.md](./design.md)
- PR 策略：**单 RFC，内部 5 个 PR，按层切**（用户 2026-08-01 拍板）。每个 PR 独立跑绿、
  独立可回滚。

---

## PR 划分

| PR | 主题 | 依赖 | 交付后系统状态 |
|---|---|---|---|
| **PR-1** | 路由元数据层 + 权限点重构 | — | 内部重构，对外行为不变；「忘挂 gate」结构性消失 |
| **PR-2** | 令牌签发 + 矩阵 UI + 用途 + 脱敏 | PR-1 | 可签发令牌并用于 REST |
| **PR-3** | MCP 服务端 + 工具集 | PR-2 | 外部客户端可接入 |
| **PR-4** | 审计表 + 删除快照 + 管理员可视面 | PR-3 | 可追溯 |
| **PR-5** | wiki + `/.well-known/mcp` | PR-3 | 可自助上手 |

---

## 任务

### PR-1 · 路由元数据层与权限点重构

- [ ] **RFC-247-T1**：设计并落地 `RouteMeta` 契约与 `registerRoute`（design §3.1）；
      支持 `permissions` 数组 AND 语义、`tokenAccess`、`publicReason`。
- [x] **RFC-247-T2**：权限目录重构——`资源:write` 拆为 `:create` / `:update` / `:delete`；
      新增 workgroups / scheduled-tasks / memory 的完整点；memory 旧五点退役并按 design §2.3
      映射；`ROLE_PERMISSIONS` 按 D15 等价照搬；`PAT_EXPLICIT_ONLY_PERMISSIONS` 升级为
      按 `:delete` 后缀派生的全集。
- [ ] **RFC-247-T3**：全量迁移**36 个路由文件**的路由到 `registerRoute`，逐条填写 design §2.3
      的动词映射。**逐条回答「这条路由有没有跨域副作用」**，不按 URL 前缀想当然归档；已知的
      跨域副作用族**五条**必须用双点 AND 收口（design §2.3 的表）：`scheduled-tasks` 三条、
      `workgroup-tasks/dw-save-as-workflow`、`fusions` 的 launch 与 approve、
      `memory-distill-jobs/:id/retry`。另有**两条**改授权本身的走 `tokenAccess: 'never'`：
      `PUT /api/tasks/:id/members`、`PUT /api/workgroup-tasks/:taskId/config`。
      **范围含 `server.ts:159` 的 whoami 与 `mountAclEndpoints` 模板生成的 12 条 ACL 路由**。
- [x] **RFC-247-T3b**：`routes/memoryDistillJobs.ts` 的
      `requireResourceAdmin('memory:approve')` 随 memory 旧点退役改为 `memory:update`，
      **身份门保持 admin/manager 不放宽**（design §2.3 memory 小节的连带）。
- [ ] **RFC-247-T4**：删除 `server.ts:183-247` 的**全部**手工门挂载（不只 183-211——
      下面还有 `configGate` :216-229、`/api/daemon` :234、`/api/backup*` :235-236、
      `/api/restore*` :237,243、`/api/runtime*` :246-247 六处）；实现启动期**双向**穷尽自检
      （无元数据的路由 → 启动失败；无路由引用的矩阵域权限点 → 启动失败）。
      权限点按真实路由派生——**不要**给 repos 补 `update`、给 skills 补 `execute`，
      实测这两个动词在这两个域没有任何路由。
- [x] **RFC-247-T5**：修 `auth/actor.ts:40` 的空 scope 洞——删除 `patScopes.length > 0`
      短路，PAT 分支恒收窄（关闭 `docs/audit-backlog.md:61`）。
- [x] **RFC-247-T6**：`resolveTokenPermissions` 纯函数（design §2.2 公式）+ 表驱动测试；
      角色点集快照测试重写（`ADMIN_ONLY_PERMISSIONS` / `MANAGER_DENIED_PERMISSIONS`）。
- [ ] **RFC-247-T7**：`verbForRoute` 映射表逐行测试；`routeMetaCoverage` 断言生产 app 无缺漏；
      每个域各一条「窄令牌被拒」集成测试；**跨域副作用族五条专属回归**（AC-29），文件名与顶部注释写明它锁的是
      「A 域路由产生 B 域副作用」这一族。
- [ ] **RFC-247-T8**：在 `docs/audit-backlog.md` 记录收口——`:60`（workgroups 无 method 点）、
      `:61`（空 scope 全权）、`:62`（任务操作面无写点 + cancel 死点）三条随本 RFC 关闭；
      `:63`（review 评论不验作者）**不关**，本 RFC 只是把它从 `tasks:delete` 的误归中解开。

### PR-2 · 令牌签发、矩阵 UI 与脱敏

- [ ] **RFC-247-T9**：migration —— `user_pats` 加 `purpose` 列；存量行统一标记 `revoked_at`
      （D19 断代）。
- [ ] **RFC-247-T10**：重开 `POST /api/auth/pats`；创建期校验（越权 422、删除档必须显式、
      原始令牌只返回一次）；`tokenAccess: 'never'` 覆盖 `/api/auth/*` 与 ACL PUT。
- [ ] **RFC-247-T11**：用途门 —— `mcp_only` 令牌打 `/api/*` → 403 `token-mcp-only`。
- [ ] **RFC-247-T11b**：**WS 用途门** —— `/ws/*` 在 `multiAuth` 之外（`cli/start.ts:551-556`
      先走 `ws.tryUpgrade`），必须在 `ws/server.ts` 的 `tryUpgrade` 里单独实施：
      `mcp_only` 令牌 401。（design §3.5）
- [ ] **RFC-247-T12**：`services/tokenRedaction.ts` 单一事实源 + **两条出口**接线 ——
      REST 响应序列化 **与 `ws/broadcaster.ts` 的出帧路径**（MCP env / headers /
      oauth secret / cached_repo url）。脱敏必须挂在通道无关的位置，否则 WS 是绕过路径。
- [ ] **RFC-247-T13**：账号页令牌区改造 —— 模板（只读 / 任务自动化 / 完整）+ 高级矩阵展开；
      **只渲染该角色实际拥有的档位**；删除档不进任何模板且带显著警告；
      移除 RFC-221 留下的「生成已关闭」NoticeBanner。复用 `Dialog` / `Form` / `Segmented` /
      `Switch` 等既有公共组件，禁止自写 chrome。
- [ ] **RFC-247-T14**：zh-CN / en-US i18n；令牌创建与矩阵的单测 + 脱敏红绿测试；
      RFC-221 的三条锁定测试改写为新语义（不删除）。

### PR-3 · MCP 服务端与工具集

- [ ] **RFC-247-T15**：`POST /api/mcp` —— `StreamableHTTPServerTransport` 无状态挂载；
      只接 PAT；全局开关（config 项 + settings UI，默认开启）。
- [ ] **RFC-247-T16**：任务域具名工具（`launch_task` / `get_task` / `list_tasks` /
      `get_task_diff` / `list_node_runs` / `cancel_task` / `retry_node` / `resume_task` /
      `diagnose_task` / `repair_alert`）。
- [ ] **RFC-247-T17**：`watch_task` —— ≤240s 阻塞、**≤10s 心跳 progress**（design §2.4 实测
      推出的硬要求）、超时返回快照 + `stillRunning`。
- [ ] **RFC-247-T18**：人工门工具完整面（`list_pending_gates` / `answer_clarify` 逐题+提交 /
      `submit_review` 逐文档评论+通过打回）。
- [ ] **RFC-247-T19**：`resource_read` / `resource_write` + `method` 收敛工具；
      `describe_resource` 由 zod 派生 JSON Schema；`describe_capabilities`。
- [ ] **RFC-247-T20**：删除工具接 `assertDeleteConfirm`，并把它从 7 条**补到 11 条**
      （skill 文件 / cached-repo / memory / scheduled-task）；`launch_task` 的 upload 输入检测
      （零副作用拒绝）。
- [ ] **RFC-247-T21**：`tools/list` 按矩阵过滤；错误语义（缺失点名 + 脱敏文本 + 闭合
      `additionalProperties` 的入参 schema）。
- [ ] **RFC-247-T22**：MCP 测试 —— `tools/list` 三种矩阵快照、`watch_task` 假时钟心跳、
      confirm 红绿、upload 拒绝断言无落库、错误文本不含密钥。

### PR-4 · 审计与删除快照

- [ ] **RFC-247-T23**：migration —— `token_audit` + `token_delete_snapshot` 两表 + 索引。
- [ ] **RFC-247-T24**：两条通道的审计写入（旁路、失败不阻断业务）；**不记 body**。
- [ ] **RFC-247-T25**：删除快照（复用 T12 脱敏；任务删除只存 DB 行不含 worktree）。
- [ ] **RFC-247-T26**：`tokenAuditRetentionDays` 配置项（默认 90）+ 清理器挂进既有小时级
      后台任务。
- [ ] **RFC-247-T27**：`GET /api/auth/pats/audit`（属主自查）+ 管理员全平台令牌与审计
      **只读**面（无吊销按钮）。
- [ ] **RFC-247-T28**：审计测试（字段正确、无 body、快照脱敏、保留期清理、写入失败不阻断）。

### PR-5 · wiki 与端点发现

- [ ] **RFC-247-T29**：`GET /api/docs/api` —— 从 `RouteMeta` + 工具注册表 + 权限目录 +
      错误码常量派生，按角色裁剪。
- [ ] **RFC-247-T30**：`GET /.well-known/mcp`（无需认证，挂在 SPA catch-all 之前，
      **不动** `PUBLIC_PATH_PREFIXES`）。
- [ ] **RFC-247-T31**：`/docs/api` 页面 —— 复用 `Prose` / `PageHeader` / `Card` /
      `PageSectionNav` / `TabBar`；MCP 接入指南 + REST 参考两个分区。
- [ ] **RFC-247-T32**：配置片段生成器 —— Claude Code / **opencode（必带 `oauth: false`）** /
      通用 MCP 客户端 / 裸 curl；地址由 `window.location.origin` 推导；令牌为占位符。
- [ ] **RFC-247-T33**：入口 —— 账号页令牌区旁 + 设置页各一个；`lib/nav.ts` 的 `NAV_GROUPS`
      **不动**。
- [ ] **RFC-247-T34**：双语外壳 + 生成内容保持英文；i18n key 补齐。
- [ ] **RFC-247-T35**：wiki 测试 —— **派生关系锁定**（改一条 `RouteMeta` 权限点 ⇒ 文档输出
      随之变）、角色裁剪、`Prose` 唯一性源码断言、390px 无横向溢出 Playwright。

### 收尾

- [ ] **RFC-247-T36**：`docs/dev-gotchas.md` 补记本轮的通用踩坑（opencode
      `resetTimeoutOnProgress` / `DEFAULT_TIMEOUT=30s` / `oauth` 默认探测三条）。
- [ ] **RFC-247-T37**：`docs/audit-backlog.md` 登记 design §11 的 `mcp.ts:88-91` 过期断言。
- [ ] **RFC-247-T38**：`design/RFC-221-account-users-ux/proposal.md` 的 D1 标注
      「Superseded by RFC-247」。
- [ ] **RFC-247-T39**：设计门（Codex review，请批前）+ 实现门（Codex review，declare done 前）
      各一轮并修 findings。
- [ ] **RFC-247-T40**：`bun run typecheck && bun run lint && bun run test && bun run format:check`
      全绿 + binary build smoke + Playwright；推送后按**自己的确切 sha** 查 CI。

---

## 验收清单

对应 proposal §5 的 AC 编号。

### 授权层
- [ ] AC-1 权限目录无 `资源:write`；三档齐全；角色点集快照锁定
- [ ] AC-2 全路由有元数据；删任一条声明 ⇒ 启动失败（有测试）
- [ ] AC-3 `server.ts` 无手工门挂载（源码层文本断言）
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
- [ ] AC-29 跨域副作用族五条各有专属回归
- [ ] AC-30 `mcp_only` 令牌无法建立 WS 连接
- [ ] AC-31 脱敏对 REST 与 WS 两条出口一致生效
- [ ] AC-32 `memoryDistillJobs` 门改 `memory:update`，身份门不放宽
- [ ] AC-33 路由元数据覆盖生产 app 上每一条路由（含 whoami 与模板 ACL 路由）

### 设计门第二 / 第三批
- [ ] AC-34 `PUT /api/tasks/:id/members`、`PUT /api/workgroup-tasks/:taskId/config` 为 never
- [ ] AC-35 cancel 归 `tasks:execute`；空矩阵令牌取消被拒
- [ ] AC-36 npm 安装带 `--ignore-scripts`（postinstall fixture 断言未执行）
- [ ] AC-37 WS 默认拒绝白名单放行；新增频道未声明裁决即编译失败
- [ ] AC-38 `rowToTask` 脱敏 `repoUrl`（对所有通道）
- [ ] AC-39 stdout 脱敏；文案不得承诺 worktree 文件脱敏
- [ ] AC-40 `/api/runtimes` 两条 GET 要求 `runtime:read`
- [ ] AC-41 退役点清扫覆盖整个 backend（含 WS gate 与 `as never` 处）
- [ ] AC-42 `/.well-known/mcp` 公开且先于 SPA catch-all
- [ ] AC-43 管理员**不能**吊销他人令牌（负向断言）
- [ ] AC-44 wiki 入口两处；`NAV_GROUPS` 零改动
- [ ] AC-45 `assertDeleteConfirm` 覆盖 11 条
- [ ] AC-46 `RANGE_POINTS` / `ROUTE_BACKED_POINTS` 存在；`READ∩SYSTEM=∅`
- [ ] AC-47 资源键统一 `scheduled-tasks`，无 `schedules:` 变体
- [ ] AC-48 `overview` / `plantuml` 补门

---

## 风险与已知取舍

| # | 项 | 处置 |
|---|---|---|
| R1 | PR-1 触及全部 ~200 条路由，是本 RFC 最大的单点风险 | 启动期穷尽性自检 + `verbForRoute` 逐行表驱动测试，把「漏改」变成「跑不起来 / 测试红」 |
| R2 | 严格 DELETE 规则导致「删技能附件」与「删整个技能」同档 | design §2.3 已如实标注；不开语义例外（可判定性优先） |
| R3 | 同上导致**经令牌无法删评审评论**（`tasks:delete` 是 admin 专属） | 同上如实记录；日后放开的正解是拆独立资源域，不是给规则开例外 |
| R4 | 管理员不可吊销他人令牌 | 用户知情决策；外泄处置 = 禁用账号 / 关全局开关；属主本人可吊销 |
| R5 | `/.well-known/mcp` 向未认证访客确认平台存在 | 用户知情决策；换来不污染 `PUBLIC_PATH_PREFIXES` 这道安全边界 |
| R6 | 全量 REST 文档暴露接口形状给所有登录用户 | 按角色裁剪（AC-23）；内容只有形状与权限，不含任何资源数据 |
| R7 | opencode 默认 30s 超时可能断开 `watch_task` | 已由 ≤10s 心跳 progress 解决（源码实测 `resetTimeoutOnProgress: true`）；片段里同时给 `timeout` 建议值 |

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

#### 语义变更的测试爆炸半径（实测，全部按新契约重写而非删除）

全量 backend 套件揭示 5 条依赖旧语义的断言，**没有一条是回归**——都是本 RFC 有意改变的行为
被既有测试锁着。逐条按「保留原意、改锁新契约」处理：

| 测试 | 锁的旧语义 | 为什么变 | 处置 |
|---|---|---|---|
| `auth-session.test.ts` ×2 | PAT 权限**恰好等于** scopes | D3 读恒开 ⇒ 多 11 个读点 | 改断言「非读点恰好等于所勾档位」，读点单独确认 |
| `rfc190-overview-route.test.ts` | PAT scope 能**剥掉资源读** ⇒ 该 key 为 null | 同上，令牌不可能缺读点 | null 分支改用 `exactActor`（精确权限集、绕过角色基线）直接构造——**该分支在 `buildOverview` 里仍存在，删测试等于静默退掉真实代码路径的覆盖** |
| `auth-self-service-idor.test.ts` | PAT 可调 `GET /api/auth/me` 证明「令牌仍有效」 | D6 关闭整个 `/api/auth/*` | 探针换成 `/api/whoami`（在该面之外、令牌可达），**证明的事情不变**：bob 被拒的 DELETE 没有真的吊销 |
| `api-contract-coverage.test.ts` | `src/routes/*.ts` 里的 `app.<verb>('literal')` 即路由 | 我在 `registry.ts` 的 JSDoc 里写了一个 `app.get('/x', handler)` 示例 | **改我的注释**——该扫描器的 `stripLineComments` 不剥块注释，是既有盲点；不动共享测试，并在 `registry.ts` 里写明这条约束 |

> **迁移中间态（T4 落地前的已知状态，不是缺陷）**：本批新增的点里有一部分**暂时没有路由引用**
> —— `tasks:read`、`workgroups:*`、`scheduled-tasks:*`、`memory:create|update|delete`、
> `tasks:update`、各 `:execute` 等。原因是它们的路由今天还没有粗粒度门（这正是本 RFC 要补的），
> 要等 **T1 的 `RouteMeta` + T3 的全量迁移**把它们声明出来。
> **T4 的反向穷尽自检必须最后落**——它一旦生效，上述任何一个点没被 `RouteMeta` 引用就会让
> daemon 起不来，这正是它存在的意义；但在 T3 完成前打开它会挡住自己的迁移路径。
> 顺序硬约束：**T1 → T3 → T4**。
