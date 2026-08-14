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
- [x] **RFC-247-T7**：~~`verbForRoute` 映射表逐行测试~~；`routeMetaCoverage` 断言生产 app 无缺漏；
      每个域各一条「窄令牌被拒」集成测试；**跨域副作用族五条专属回归**（AC-29），文件名与顶部注释写明它锁的是
      「A 域路由产生 B 域副作用」这一族。
  - **2026-08-03 架构审视 G0 修正**：T4 只删了 `auth/permissions.ts` 的**挂载**、没删实现。该层
    202 行（7 个导出）此后全仓零生产引用，仅由 `rfc247-verb-for-route.test.ts` 这一条逐行测试
    续命——`verbForRoute` 因此成了「路由 → 权限点」的第二份、无人执行、无人比对的事实源（机械
    重放全部 `registerRoute` 声明与它分歧 7 条），其文件头还在断言 server.ts 里早已删除的手挂
    网关「still runs alongside」。整层 + 该逐行测试**已删除**，新增
    `tests/route-gate-single-source.test.ts` 锁住「不复辟 + 无第二套门」。T7 其余三项不变。
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
- [x] **RFC-247-T39**：设计门（Codex review，请批前）+ 实现门（Codex review，declare done 前）
      各一轮并修 findings。**已闭环**：设计门见 [`design-gate-2026-08-01.md`](./design-gate-2026-08-01.md)
      （Codex wedge → 两个正交视角的 Claude 子代理对抗评审替代并如实记档，5 P0 / 17 P1 / 23 P2
      全部折入为 AC-29～AC-48）；实现门见下方「2026-08-02 — 实现门（Codex 直驱，成功）」
      （75 分钟 / 86KB 日志 / 24 findings，12 修 + 12 登记 backlog）。
- [x] **RFC-247-T40**：`bun run typecheck && bun run lint && bun run test && bun run format:check`
      全绿 + binary build smoke + Playwright；推送后按**自己的确切 sha** 查 CI。**已完成**：
      PR #12 于 2026-08-02 squash 合并进 `main`。
- [x] **RFC-247-T41（2026-08-14 追加）**：**架构收尾移交 RFC-294 W4**——见下方
      「2026-08-14 — 收口对账（对齐 RFC-294）」。`scripts/depcheck.ts` 两条账目的
      `removeWhen` 已从「RFC-247 收尾」改写为指向 RFC-294 W4-A/W4-D，owner 转出。

---

## 验收清单

对应 proposal §5 的 AC 编号。

**2026-08-14 回填说明**：交付当天（2026-08-02）只勾了 7 条，其余一直空着——不是没做，是没回填
（交付记录里的「收尾时按 AC-1〜AC-48 回扫」确实跑过，见下方 §「AC 逐条回扫抓到的两个『写了规则
没接出口』」）。本次逐条定位锚并复跑：backend `rfc247-*.test.ts` 13 文件 **192 pass / 0 fail**、
frontend `token-matrix` / `token-create-dialog` / `api-docs-markdown` **65 pass**、shared
`permission.test.ts` / `permission-rfc041.test.ts` **35 pass**（均在 `4a544ef9` 上跑绿）。每组末尾
列该组的验证锚。**两条不勾**并各自写明缺口——按 RFC-294 §17「不能以抽样和人工宣称验收」的同一
标准，宁可留白也不空勾。

### 授权层

- [x] AC-1 权限目录无 `资源:write`；三档齐全；角色点集快照锁定
- [x] AC-2 全路由有元数据；删任一条声明 ⇒ 启动失败（有测试）
- [x] AC-3 `server.ts` 无手工门挂载（源码层文本断言）
- [ ] AC-4 真正无 gate 的 workgroups / reviews / clarify（+ scheduled-tasks PUT/DELETE）各有「窄令牌被拒」测试
- [x] AC-5 空矩阵 = 只读
- [x] AC-6 `scheduled-tasks` 双点 AND，无法绕过 `tasks:execute`

> 锚：`shared/tests/permission.test.ts` + `permission-rfc041.test.ts`（点集快照）；
> `rfc247-route-coverage.test.ts:54-93`（正向：无声明即启动失败）与 `:94-157`（反向：无路由的点
> 即启动失败）；`rfc247-token-grants.test.ts:34-55`（空矩阵 = 只读，且 pre-RFC 的「空 scopes =
> 全量 role」洞已闭）；`rfc247-cross-domain-escalation.test.ts:249-266`（scheduled-task POST /
> run-now 带 AND、PUT 保持单点）。
> **AC-4 不勾的理由**：机制侧已封——`rfc247-route-coverage.test.ts:6-7` 的文件头就写明它锁的正是
> 「workgroups / reviews / clarify 整域上线时无粗粒度门」这个成因，任何路由漏声明都在启动期炸。
> 但 AC 字面要的是「这三域各有一条『窄令牌被拒』用例」，本次回填未定位到这样的逐域独立用例。

### 令牌

- [x] AC-7 创建可用；原始令牌只出现一次；越权 422 而非静默丢弃
- [x] AC-8 删除档不进任何模板；「完整」模板签出的令牌 DELETE 全 403
- [x] AC-9 `mcp_only` 打 `/api/*` → 403 专用码；通用两通道皆通
- [x] AC-10 令牌打 `/api/auth/*` 全方法拒绝
- [x] AC-11 令牌打 ACL PUT 拒绝
- [x] AC-12 令牌读三类 MCP 密钥字段全掩码；session 通道明文不变

> 锚：`rfc247-token-issuance.test.ts`（AC-7 / AC-18 显式标注）；`frontend/tests/token-matrix.test.ts`
> 与 `token-create-dialog.test.tsx`（AC-8 / AC-23 显式标注）；`rfc247-token-purpose.test.ts`
> （AC-9 / AC-30 显式标注）；`rfc247-mcp-server.test.ts` + `rfc247-mcp-transport.test.ts`
> （AC-10 显式标注）；AC-11 = `routes/resourceAcl.ts:122-123` 声明 `tokenAccess:'never'`，语义由
> `rfc247-route-registry.test.ts:195-226`（PAT 持全部点仍被拒 / session 同路由通过）锁定；
> AC-12 = `rfc247-token-redaction.test.ts`（显式标注）+ `rfc247-mcp-server.test.ts:380-449`
> （PAT 读 MCP 得到掩码 env / headers / oauth secret）。

### MCP

- [x] AC-13 `/api/mcp` 只接 PAT
- [x] AC-14 `tools/list` 随矩阵变化
- [x] AC-15 `watch_task` ≤10s 心跳、240s 超时返回快照
- [x] AC-16 删除工具 confirm 校验，零副作用
- [x] AC-17 upload 类工作流拒绝且无落库
- [x] AC-18 全局开关同时关掉 `/api/mcp` 与令牌创建

> 锚：`rfc247-mcp-transport.test.ts:107-147`（PAT 通、session / daemon / 无凭据全 401）、
> `:148-166`（开关关闭后逐请求拒绝）；`rfc247-mcp-server.test.ts:256-296`（tools/list 随矩阵、
> 且「每个列出的工具都真能调」）、`:137-191`（删除工具仍要 type-to-confirm）、`:450-522`
> （upload 工作流拒绝且不落库）；`rfc247-mcp-watch.test.ts:91-120`（240s 上限不超、全程 ≤10s
> 心跳、心跳带任务在做什么）。

### 审计

- [x] AC-19 每次调用留痕且不含 body
- [x] AC-20 每次令牌 DELETE 有脱敏快照
- [x] AC-21 属主自查 / admin 全看 / 到期清理

> 锚：`rfc247-token-audit.test.ts:82-137`（REST 留痕含 method/path/status/tokenId、REFUSED 也留、
> session 不留、**行里根本没有 body 字段**）、`:138-167`（MCP 按 tool 而非 POST /api/mcp 留痕）、
> `:209-255` + `:462-533`（快照走**生产路由**而非手喂 —— 这正是实现门抓到的 AC-20 时序缺陷的
> 回归）、`:256-317`（保留期真会 prune）、`:318-356`（属主自查 / admin 只读 / 令牌读不到审计）。

### wiki

- [x] AC-22 文档由代码派生（派生关系有测试锁定）
- [x] AC-23 按角色裁剪
- [x] AC-24 四份配置片段可直接使用
- [x] AC-25 opencode 片段带 `oauth: false`
- [x] AC-26 双语外壳 + 英文标识符
- [x] AC-27 复用 `Prose`，无第二个渲染器
- [x] AC-28 390px 无页面级横向溢出

> 锚：`rfc247-api-docs.test.ts`（AC-22 显式标注；`:179-200` 片段——四份 = `claude-code` /
> `opencode` / `generic` / `curl`，见 `services/apiDocs.ts:164,170,192,210`，其中 opencode 片段
> 断言含 `"oauth": false`，每份都指向调用方自己的 origin）；`frontend/tests/api-docs-markdown.test.ts`
> （AC-22 / AC-27 显式标注，`:254` 锁「只有一条 markdown 渲染路径」）；`token-matrix.test.ts`
> （AC-23 角色裁剪）；`frontend/tests/i18n-key-resolution.test.ts:10`（双语键回退，注释点名 RFC-247）；
> `e2e/rfc247-api-docs-page.spec.ts`（AC-28 显式标注，390px 无横向溢出）。

### 设计门追加

- [x] AC-29 跨域副作用族五条各有专属回归
- [x] AC-30 `mcp_only` 令牌无法建立 WS 连接
- [x] AC-31 脱敏对 REST 与 WS 两条出口一致生效
- [x] AC-32 `memoryDistillJobs` 门改 `memory:update`，身份门不放宽
- [x] AC-33 路由元数据覆盖生产 app 上每一条路由（含 whoami 与模板 ACL 路由）

> 锚：`rfc247-cross-domain-escalation.test.ts:146-173`（AC-29 显式标注，五条逐条跑）、
> `:182-214`（AC-32：memory-distill-jobs 要 resource-admin 身份，不是光有点就行）；
> `rfc247-token-purpose.test.ts`（AC-30 显式标注）；AC-31 = `ws/registry.ts:496`
> `redactEventPayload(payload, ws.data.actor.source)`（WS 出口与 REST 共用同一 redactor）。

### 设计门第二 / 第三批

- [x] AC-34 `PUT /api/tasks/:id/members`、`PUT /api/workgroup-tasks/:taskId/config` 为 never
- [x] AC-35 cancel 归 `tasks:execute`；空矩阵令牌取消被拒
- [ ] AC-36 npm 安装带 `--ignore-scripts`（postinstall fixture 断言未执行）
- [x] AC-37 WS 默认拒绝白名单放行；新增频道未声明裁决即编译失败
- [x] AC-38 `rowToTask` 脱敏 `repoUrl`（对所有通道）
- [x] AC-39 stdout 脱敏；文案不得承诺 worktree 文件脱敏
- [x] AC-40 `/api/runtimes` 两条 GET 要求 `runtime:read`
- [x] AC-41 退役点清扫覆盖整个 backend（含 WS gate 与 `as never` 处）
- [x] AC-42 `/.well-known/mcp` 公开且先于 SPA catch-all
- [x] AC-43 管理员**不能**吊销他人令牌（负向断言）
- [x] AC-44 wiki 入口两处；`NAV_GROUPS` 零改动
- [x] AC-45 `assertDeleteConfirm` 覆盖 11 条
- [x] AC-46 `RANGE_POINTS` / `ROUTE_BACKED_POINTS` 存在；`READ∩SYSTEM=∅`
- [x] AC-47 资源键统一 `scheduled-tasks`，无 `schedules:` 变体
- [x] AC-48 `overview` / `plantuml` 补门

> 锚：`rfc247-cross-domain-escalation.test.ts:215-248`（AC-34 显式标注）；AC-35 =
> `routes/tasks.ts:423-425`（`POST /api/tasks/:id/cancel` 声明恰为 `['tasks:execute']`）+ 空矩阵
> 只读（AC-5 同锚）；AC-37 = `ws/server.ts:174` 的默认拒绝 + `:282` `TOKEN_ALLOWED_WS_CHANNELS`
> 白名单；AC-38 = `services/task.ts:1976` `redactGitUrl(r.repoUrl)`；AC-39 = `routes/tasks.ts:1038`
> `shouldRedactFor(actor.source) ? redactStdout(text) : text`（**这条是收尾回扫抓到的「写了规则
> 零调用方」之一，现已接线**）；AC-41 = `rfc247-route-coverage.test.ts:94-157` 的反向自检；
> AC-42 = `routes/docs.ts:65`；AC-43 = `rfc247-token-audit.test.ts:357`（显式标注的负向断言）；
> AC-44 = `AccountTokensPanel.tsx:53` + `settings.tsx:1281` 两处入口；AC-45 覆盖面已确证 **11 条**
> ——旧 `assertDeleteConfirm` 9 处调用覆盖 agents / skills / mcps / plugins / workflows /
> workgroups / tasks 七条顶层 DELETE（`mcps` / `plugins` 各有重读校验的第二处），新
> `assertTokenDeleteConfirm` 覆盖新补四条（`skills.ts:410` 技能文件 / `cached-repos.ts:94` /
> `memories.ts:315` / `scheduledTasks.ts:197`），另加 RFC-248 后来接入的 `repoGroups.ts:203`；
> 测试见 `rfc222-delete-confirm.test.ts`（旧七条）+ `rfc247-token-delete-confirm.test.ts`（规则本身
> 与 memory 端到端）+ `routes-memories.test.ts`。
> **AC-36 不勾的理由**：确实**没做**——`services/pluginInstaller.ts:277-289` 的 npm install 参数里
> 没有 `--ignore-scripts`（全仓该 flag 只出现在 `services/scriptDepsEnv.ts:163`，是脚本节点依赖
> 安装那条线，与插件安装无关）；`:781-787` 仍把 daemon 全量 `process.env` 转发给 npm。设计门 A1
> 把它定级 **P0（= 宿主任意代码执行）**、design §5.4 明写「本 RFC 加 `--ignore-scripts` 修根因」，
> 实现时降级进了 `docs/audit-backlog.md`。详见下方收口对账「档 3」。

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

| 测试                                | 现象                                 | 归属与处置                                                                                                                                                                                                                                                                                                 |
| ----------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rfc165-scheduled-kinds.test.ts` K6 | narrow PAT 删除定时任务由 200 变 422 | **本 RFC 有意**。K6 锁的是「删除**不需要**启动权限」——那条**仍然成立**；T20 加的是「令牌必须**指名**要删的东西」，两条正交（一条讲权限、一条讲意图）。测试改为先断 422 `delete-confirm-required`、再带 `confirm` 断成功，**原意完整保留**。存量令牌已被 migration 0129 全部吊销，故此 break 无活跃调用方。 |
| `api-contract-coverage.test.ts`     | 5 条新端点未登记                     | 该守卫正常工作。登记 `/api/auth/pats/audit`、`/api/tokens`、`/api/tokens/audit`、`/api/docs/api`、`/.well-known/mcp`（最后一条标 `public`）。                                                                                                                                                              |
| `plugin-install` timeout kill       | 全量套件下红、单独跑 17/17 绿        | **不属本 RFC**（未触及 `pluginInstaller`）；是 `timeoutMs` 杀子进程的时序敏感用例在满载下抖动。按 CLAUDE.md **不以「重跑就过」作为通过依据**——如实记录于此，留待其 owner 判定是真 flaky 还是真 bug。                                                                                                       |

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

### 2026-08-02 — 实现门（Codex 直驱，成功）

分离 worktree 从 pin `f004b618` 跑到 `642589f0`（139 文件 / +19005 −5174），**75 分钟、86KB 日志**——
与设计门那次 8 分钟僵死是两码事。产出 **24 findings（11 P1 + 13 P2）**。

**它抓到的东西，CI 与我自己的测试全都抓不到。** 三类值得固化：

1. **三个操作从来没成功过**——`resource_write(skills,update)` 打的是**已退休、恒返 410** 的
   `PUT /api/skills/:id`；`repair_alert` 发 `{option}` 而路由要 `{optionId, confirm:true}`；
   `resource_write(memory,delete)` 缺 `?confirm=true` 查询门。三条原测试全绿，因为它们**桩掉了
   dispatcher**——证明了「工具会调用某个 path」，完全没证明「那个 path 会接受这个 body」。
   新用例一律走**真实路由表**。
2. **AC-20 快照生产零触发**——表、脱敏器、测试俱在，但审计钩子跑在响应之后、那时行已经没了；
   原测试直接调 `recordTokenCall` 手喂快照，于是证明了表能用、完全没证明管道能用。
3. **401 契约写反，且我的测试给它背书**——D10 明写「一律 401」，我实现成 403 并写了断言 403 的
   用例。**本 RFC 第三次「实现与测试共享同一个错误前提」**，且是唯一一次结构守卫救不了的：
   前两次（redactor 零调用方、upload 夹具用 `name`）是漏接线，可以扫；这次是把规格读错，
   只有外部评审能抓。**这就是双门存在的理由**——CI 全绿、自测全绿，契约仍然是错的。

**12 条已修**（两批，各带红绿变异实证）：三个失败操作 + `list_repair_options` + 路径穿越编码

- 401 + `snapshot_failed`（migration 0130）+ 三扇门脱敏 + plugin spec + `describe_resource`
  派生 JSON Schema + `launch_task` 补 7 字段 + AC-20 快照时序。

**12 条登记 `docs/audit-backlog.md`** 并写明 defer 理由：收敛工具非 CRUD 面、review 逐文档 /
clarify 子集、审计查询下推 SQL、反代下 origin 推导、wiki 缺请求体 schema、discovery 不反映
开关、`redactSensitiveString` 的前缀环境变量缺口、插件安装 `--ignore-scripts` 等。

> **共享工作树事故（记录以免重演）**：第二批 commit 期间，并发 session 把主工作树切到了
> `rfc-248-repo-groups`，我的提交因此落到**别人的分支**上而非 main；`git push origin main`
> 报 "Everything up-to-date" 却领先 2，这个矛盾才暴露它。处置：**不在共享树上切分支**（那正是
> 刚发生在我身上的事），改开独立 worktree checkout main、cherry-pick、push、删除；也**不去
> 别人分支上 revert**（重写别人正在用的分支比留一个重复提交危险得多）。教训：共享树上提交前
> 先 `git branch --show-current`。

### 2026-08-14 — 收口对账（对齐 RFC-294）

RFC-247 主体 2026-08-02 已 Done。本次按 CLAUDE.md §RFC workflow 第 8 条「每个 RFC 都必须考虑向
RFC-294 目标架构演进」重新审视遗留项，**结论是架构面这块地不该由 RFC-247 收**——它在 RFC-294
里已经有 owner、有波次、还有一条明写的串行门。以下引用一律取 RFC-294 的**已提交 pin 版
`be31dd62`**（即 RFC-288 钉的那版），不引工作树里他人的未提交稿；并按 `6e8c4f9f` 立的仓规
**只引小节号、不引行号**（RFC-294 正在被并行重写，行锚必烂）。

#### 档 1：架构收尾移交 RFC-294 W4（T41，本次已落）

| RFC-294 锚（pin `be31dd62`） | 裁决 |
| --- | --- |
| `design.md` **§12 Integration** | 「HTTP 与 MCP 不再通过 MCP 内建第二套 Hono app 复用业务 handler；两者调用同一 application use case」「RouteMeta 可继续生成 docs/admission，但 **registry 下沉为 transport metadata，不让 `apiDocs`/MCP 反向依赖 server**」 |
| `design.md` **§13.1 Operation catalog** | operation descriptor 是 admission 唯一事实源；**RouteMeta 由 operation + HTTP binding 生成或降为 binding type，不能再手写第二份权限事实**；API docs 从同一 descriptor 派生；MCP 不重挂 Hono app；catalog 不导出 generic invoker |
| `design.md` **§18 owner 账本** | 「HTTP/MCP route 复用、API docs registry」→ owner = **inbound adapters + application operation catalog**，波次 **W4** |
| `plan.md` **W4-A** / **W4-D** | 「API docs 从 transport descriptor 派生，不让 service import route registry」「MCP 不再 mount 第二套 Hono route table」 |
| `plan.md` **§15 并发与冲突矩阵** | `server/mcp/route catalog` → **必须串行 W4 → W9 root 收口** |

因此 `scripts/depcheck.ts` 两条账目的 `removeWhen` 已改写、owner 转出：

- `:157` `mcp/dispatch → server`（三环 dispatch → server → mcp/server → dispatch）→ RFC-294 W4-D + W4-A；
- `:203` `services/apiDocs.ts → routes/registry.ts`（唯一一条 services → routes 分层违规）→ RFC-294 W4-A。

原文写的「RFC-247 收尾时把路由注册表下沉成不依赖 `server.ts` 的独立模块」**已作废**：终局不是就地
挪位，而是 operation descriptor 成为唯一 admission 事实源后 docs 与 RouteMeta 一起从它派生。247 侧
自行下沉一个中间态注册表既撞 §15 的串行门，又有造出 §13.1 明禁的第二份权限事实源的风险。

**副作用**：RFC-288 的 DEV-5「MCP 三环账目的 `removeWhen` 指向 RFC-247 收尾，实现前须与其 owner
协调排它窗口」前提随之消失——owner 已不是 247。但 RFC-288 的 AC-1（用户第三轮拍板扩为「真·全
backend 零值级 SCC」，含 MCP 三环）**是否仍吞这三环，需用户重新定夺**：按 pin 版 §15 该面串行到
W4，而 RFC-288 定位在 W2（`plan.md` §3.2 执行队列 N3–N4），pin 版 §14 里程碑也只要求 W4 后
SCC=5、W5 后=0。

#### 档 2：仍属 RFC-247 的欠工（AC-36，唯一「设计写了没做」）

`--ignore-scripts` + npm env 面收敛。RFC-294 §18 owner 表**没有**这条 ⇒ 不受 W4 串行门约束，可
独立落；owner 登记为 `resource-catalog/plugin`（§2 目标物理结构），随 W4-C/E 的资源域切片迁位。
它是能力收缩型（依赖 postinstall 的插件将装不上），落地前按 CLAUDE.md §RFC workflow 第 7 条呈用户
确认——design §5.4 当年按 D19「还没人用」批过，但那是 2026-08-01 的前提。

#### 档 3：backlog 里其余 defer 项（四条已落，其余定方向）

**已落（2026-08-14，四条各带测试，backlog 同步销账）**：

| 项 | 处置 | 锁 |
| --- | --- | --- |
| origin 推导（反代下 snippets / discovery URL 不可用） | **未新增配置项**：RFC-036 早有 `publicBaseUrl`，连同 forwarded 回退一起抽成纯函数 `routes/publicOrigin.ts:derivePublicOrigin`，docs 两条路由与 OIDC `resolveRedirectUri` 共用；顺带修代理链头取原始跳、以及无 Host 头时 RFC-036 版拼出的字面量 `http://undefined/...` | `rfc247-public-origin.test.ts`（12 条纯函数矩阵）+ `rfc247-api-docs.test.ts` §「the published origin survives a reverse proxy」 |
| `/.well-known/mcp` 不反映开关 | `wellKnownMcp()` 收 `{ enabled }`，由路由从既有单一读点 `isMcpSurfaceEnabled` 注入（未新造 config reader） | `rfc247-api-docs.test.ts` §D18 两条（纯函数双向 + HTTP 随真实 config 变化） |
| 令牌审计未下推 SQL | `WHERE`/`ORDER BY`/`LIMIT` 全下推；补 `id ASC` 二级键——JS `sort()` 稳定而裸 `ORDER BY created_at DESC` 不稳定，ULID 同毫秒单调故 `id ASC` 恰好复原插入顺序，行为与被替换的内存版逐字一致 | `rfc247-token-audit.test.ts` §「pushed into SQL」（行为三条 + 源码断言禁 `.filter(`/`.sort(`/`.slice(` 复辟） |
| `shared/schemas/mcp.ts` 过期断言 | 对本机 opencode checkout 重新核实：`core/src/v1/config/mcp.ts:11-13` 与 `core/src/config/mcp.ts:18` **都有 `cwd`**；注释改为陈述行为（我们不下发 ⇒ 子进程继承 worktree）而非不可能性，**是否开放 `cwd` 留作产品决策**不在注释里自裁 | 零行为变化，无需测试 |

两点值得记住：①`publicBaseUrl` 的**第三个消费者** `services/webhookEndpoints.ts` 规则**不同且有意
不同**——它只认 `publicBaseUrl`、缺了返回 `null`，因为那个 URL 要交给代码平台长期存活，猜错等于
webhook 永久失效；而 docs/discovery 的读者此刻正连着本 origin，回退才是正确答案。差异已写进
`publicOrigin.ts` 注释，免得后人当成疏忽去「统一」。②新模块按 RFC-294 §2 落在 inbound-HTTP
transport 层（`routes/`，与 `registry.ts` 同层，随 W4 迁 `adapters/inbound/http/`），**没有**落
`services/`——service 去读请求头正是 W4 要拆掉的耦合。

本轮自查抓到的一条（写下来因为它是「纯函数好测」的直接兑现）：`derivePublicOrigin` 初版把**空白
头**当成有效答案——`''.trim()` 不是 `undefined`，`??` 链会收下空串并返回被截断的 origin，而请求
URL 本可以答上。修法是每一级都过 `nonEmpty()`，并补一条「present but BLANK falls through」用例。
这个缺陷在 HTTP 集成测试里几乎撞不到（真实请求总带 `Host`），是抽成纯函数后逐项过矩阵才现形的。

另：跑门禁时撞到一条与本轮无关的超时红（`rfc210-submodule-topology.test.ts` 的
`check-ref-format` 用例，12 次子进程 spawn 挤不进 bun test 的 5s 默认超时），根因是本机当时压着
三份并发测试负载（含我 kill 后残留的孤儿分片）。清掉负载单跑 15 pass / 320ms。已按 CLAUDE.md
「flaky 不能当通过依据」登记进 `docs/audit-backlog.md` 交该测试 owner 处置，**未**以「重跑就过了」
名义放行。
- **明确「现在别做」**（做了就是逆向加固，已同步写进 `docs/audit-backlog.md` 对应条目）：
  1. 不要扩 `resource_read/write` 的 `method` 枚举——`McpBinding = {operationId, toolName}`
     （`design.md` §13.1）是 operation↔tool 一对一，W4-A 要求 HTTP RouteMeta 与 MCP tool
     引用同一 operation id/handler；扩枚举是往 generic invoker 方向加固；
  2. 不要手写第二套 wiki schema 派生——W4-A 的 descriptor 自带
     `inputCodec/outputCodec/publicErrorCodes`；
  3. 不要现在放宽 `redactSensitiveString` 正则——§15.3 要求 W0 建 secret canary 与
     serializer/logger capture 负测，正解是把 `OPENAI_API_KEY` 这类前缀形态登记成 canary 负测，
     而不是松词边界连带影响 RFC-030 探针与 daemon 日志。
