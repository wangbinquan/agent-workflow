# RFC-247 · MCP 远程接入、路由元数据授权层与 API 文档界面

- 状态：Draft（2026-08-01 落档，待用户批准）
- 日期：2026-08-01
- 触发：用户要求「系统需要提供 MCP 能力以支持模型进行各类资源创建与任务执行，远程调用使用
  token 的方式进行，每个账户在自己的个人账号界面都可以创建 token 并选择该 token 的权限」，
  随后补充「允许提供删除能力」「MCP 和 API 可以参考 GitHub 的接口来设计」「不用管现有实现，
  因为还没人用」「需要给 API 和 MCP 使用加个 wiki 界面来介绍使用方式」。
- 相关 RFC：RFC-036（认证与权限目录 / PAT）、RFC-099（资源 ACL）、RFC-165（启动即委派）、
  RFC-211（引导页）、RFC-221（**本 RFC supersede 其 D1**）、RFC-222（资源管理员角色 /
  type-to-confirm 删除）、RFC-231（默认私有）、RFC-234（意图构建，本 RFC 非目标）、
  RFC-238（MCP 运行时试用）、RFC-243/244/245/246（任务面 UX）

---

## 1. 背景

### 1.1 平台今天只能被人操作，不能被程序操作

整个平台的能力面（六类 ACL 资源、任务启动与推进、定时任务、仓库缓存、长期记忆）目前只有一条
入口：浏览器里的 Web UI。没有任何面向外部程序的接口约定，也没有任何面向模型的工具协议。

这与产品定位是矛盾的。平台自身的价值主张是「用确定性的框架管道驱动多个 agent 进程」，
而它自己却无法被另一个 agent 驱动——外部的 Claude Code / opencode 会话想让平台跑一轮
Code → Audit → Fix，只能让人去点界面。

### 1.2 令牌机制存在，但创建入口被明令关闭

RFC-036 建成了完整的三轨认证：session token（`aws_s_`）、PAT（`aws_pat_`）、legacy daemon
token，由 `multiAuth`（`session.ts:59-85`）经 `resolveActor`（`session.ts:134-189`）按前缀分派，PAT 的
scope **收窄**角色基线而永不放大（`auth/actor.ts:33-56`）。存储、哈希、吊销、WS 撤销联动
（`auth/patStore.ts`）一应俱全。

但 RFC-221 D1 拍板「全局关闭个人访问令牌生成」，形成「只退不进」：

- `routes/auth.ts:228-230` 对任何能到达该路由的 actor 固定 403 `pat-creation-disabled`；
- 前端 `AccountTokensPanel.tsx` 只剩列表与吊销，`CreatePatDialog` / `PatPreset` /
  `PAT_SCOPE_GROUPS` 已删除；
- `e2e/auth-isolation.spec.ts:458` 与 `tests/auth-routes.test.ts:330,387` 锁死该行为。

本 RFC 正面反转该决策，并显式记录 supersede 关系。

### 1.3 现有权限目录表达不了本需求

`shared/schemas/permission.ts` 是「资源 : read/write」二元结构，`auth/permissions.ts` 的
`resourcePermissionGate` 把 **POST / PUT / PATCH / DELETE 全部映射到同一个 `:write` 点**
（`permissions.ts:104-110`）。因此：

- 无法签发「能改不能删」的凭据；
- 无法签发「能建不能改」的凭据；
- 唯一的反例 `tasks:delete` 是手工开的独立点，并靠 `PAT_EXPLICIT_ONLY_PERMISSIONS`
  （`permission.ts:187`）保证不随基线继承——这个范式是对的，但只覆盖了一个点。

### 1.4 有几类资源没有粗粒度权限门

`server.ts:188-211` 只为 agents / skills / mcps / plugins / workflows / repos 挂了方法门。
真正**完全没有权限点**的是 **workgroups、reviews、clarify**（只有 handler 内部的 ACL 检查），
外加 **scheduled-tasks 的 PUT / DELETE**（它的 POST 与 `run-now` 有 `tasks:launch`，
见 `routes/scheduledTasks.ts:61,80,151`）。后果是：一个被收窄到「只能读 agent」的 PAT，
照样能创建工作组、改删定时任务、提交评审决策——因为没有可被收窄的点存在。

> **设计门勘误**：本节初稿把 **memories 与 intent** 也列进了「无权限点」，**这是错的**。
> `routes/memories.ts` 每条路由都挂了 `requirePermission('memory:read'|'approve'|'edit'|
> 'archive'|'delete')`；`routes/intentSessions.ts:212-213` 每条都挂了
> `requirePermission('intent:read'|'intent:write')`。初稿据此举的例子（「窄 PAT 照样能创建
> 定时任务」）同样不成立——那种 PAT 没有 `tasks:launch`，今天就会被拒。真实缺口比初稿描述的窄，
> 但依然存在，且依然是本需求的直接障碍。

`docs/audit-backlog.md:60` 已登记 workgroups 那条，`:61` 登记了「空 scopes 的 PAT 静默拿到
全量角色权限」（`actor.ts:40` 只在 `patScopes.length > 0` 时才收窄），`:62` 登记了
「任务操作面无写权限点 + `tasks:cancel:own/all` 零引用死点」，`:63` 登记了「review 评论
PATCH/DELETE 不验作者不留痕」。**这四条本 RFC 都会碰到**，其中前三条随本 RFC 收口。

### 1.5 授权与文档必然漂移

即便补齐了权限点，「哪条路由需要哪个权限」这件事仍然分散在 `server.ts` 的中间件挂载、
各 handler 内的 `requirePermission` 调用、以及 handler 内联的 ACL 判断三处。没有任何单一
位置能回答「这个端点要什么权限」。要给外部用户写一份**准确**的接口文档，就必须先让这个问题
有一个可机器读取的答案——否则文档从写下的第一天起就在漂移，而这恰恰是安全文档最不能错的
地方。

---

## 2. 目标

- **G1 程序化接入**：外部 MCP 客户端可用一枚令牌完成「创建资源 → 启动任务 → 观察进度 →
  推进人工门 → 取回结果」的完整闭环。
- **G2 令牌自助签发**：任何登录用户都能在个人账号页创建令牌，并在**资源类型 × 动词**矩阵上
  选择该令牌的权限；权限永远是其账户角色的子集。
- **G3 四动词可分**：`新增 / 修改 / 删除 / 执行` 四档在 REST 层真实成立，不只是 MCP 工具层的
  装饰。删除档必须显式勾选，永不随模板或角色基线自动附带。
- **G4 单一授权事实源**：每条路由在元数据中声明自己的权限点，框架据此统一挂门；
  **未声明权限的路由启动即失败**，「忘了挂 gate」在结构上不可能再发生。
- **G5 令牌通道最小化**：令牌不可达账户管理面，不可改授权与可见性，读路径统一脱敏。
- **G6 可审计**：令牌的每一次调用留痕；删除操作额外旁路快照被删内容。
- **G7 文档不漂移**：API 与 MCP 的使用说明由运行时从路由元数据、工具注册表与权限目录派生，
  并按当前用户的角色裁剪。
- **G8 可运维**：管理员可一键关闭整个对外面；可查看全平台令牌清单与调用审计。

---

## 3. 已批准的产品决策

以下全部来自 2026-08-01 与用户的十八轮澄清，是本 RFC 的硬合同，不是实现建议。

### D1 — 令牌载体：复用 PAT，撤销 RFC-221 D1

重新开放 `POST /api/auth/pats` 与账号页创建入口。RFC-221 D1「只退不进」被本 RFC 显式取代；
`design/RFC-221-account-users-ux/` 三件套保留为历史，其 D1 一条标注为 Superseded by RFC-247。
令牌前缀保持 `aws_pat_`，不改 `multiAuth` 的前缀分派。

### D2 — 两种用途

创建令牌时必须选定用途：

- **仅 MCP**：只能连 `POST /api/mcp`；打任何 `/api/*` 业务路由 → **403 + 专用错误码**。
- **通用**：`/api/*` 与 `/api/mcp` 均可，同一份权限矩阵同时约束两条通道。

### D3 — 权限形状：资源类型 × 四动词矩阵，读恒开

- 动词轴：`create` / `update` / `delete` / `execute`。
- **读恒开**：令牌只要有效，就能读该用户在 ACL 下可见的一切（经过 D9 的脱敏）。矩阵上没有
  读的开关；空矩阵 = 只读令牌。
- 覆盖资源：agent / skill / mcp / plugin / workflow / workgroup / tasks / scheduled-tasks /
  cached-repos（仓库域）/ memory。
- **intent（意图构建会话）不进 v1**。

### D4 — 删除：允许，但四重约束

1. 删除档**逐资源类型独立**（`agents:delete` / `workflows:delete` / …）。
2. **必须显式勾选**：不随角色基线继承，不进任何预设模板（含「完整」模板）——沿用
   `PAT_EXPLICIT_ONLY_PERMISSIONS` 范式并把它扩展到全部 delete 点。
3. 边界**严格按 HTTP DELETE**，作用域限定**矩阵域资源本身**：凡矩阵域资源的 DELETE 归删除档；
   `PUT` 即使把内容改空也算修改。系统域的 8 条 DELETE（oidc provider / user / runtime /
   restore-pending / pat / identity / intent mount）沿用各自的系统域点；「资源内交互记录」
   的删除（评审评论）归 `execute`——**唯一一条业务域例外，逐条列出**（design §2.3 规则 ①）。
4. MCP 删除工具**保留 type-to-confirm**：调用方必须传入资源的确切当前名字，服务端权威校验
   （复用 RFC-222 D5 的 `services/deleteConfirm.ts`）。它今天只挂在 7 条路由上，本 RFC
   **补齐** skill 文件 / cached-repo / memory / scheduled-task 四条（design §1.4）。

### D5 — 授权与可见性不入矩阵

`PUT /api/{res}/:id/acl`（`routes/resourceAcl.ts:63-75` 的统一挂载）对令牌**一律拒绝**，
无论矩阵勾了什么。令牌不能把自己创建的私有资源开给别人，也不能改任何资源的 owner / grants /
visibility。

### D6 — 令牌不可达 `/api/auth/*`

令牌不能创建令牌、不能列出或吊销令牌、不能改密码、不能操作 session 与 identity。堵死
「用一枚窄令牌签出一枚宽令牌」的自提权路径。令牌恒不含 `account:self`。

### D7 — 系统域恒不可达

矩阵覆盖面之外的系统域权限点（`users:*` / `settings:*` / `oidc:*` / `backup:run` /
`runtime:read` / `intent:*`）**令牌一律不含**，即便持有者是 admin。管理员的 MCP 令牌不能改
系统设置、不能管用户、不能跑备份。

### D8 — 过期与生命周期

过期时间**可选**，允许永不过期。所有登录用户可为自己创建。**管理员可查看全平台令牌**
（属主 / 名称 / 矩阵 / 用途 / 创建与最后使用时间），**但不可吊销**——吊销权只属于属主本人。
外泄时的处置路径是「禁用该账号」或「关闭全局开关」，这是用户知情后的取舍。

### D9 — 令牌读路径统一脱敏

经由令牌（两种用途皆然）的读，一律掩码：MCP 的 `config.env` 值、`config.headers`、
`oauth.clientSecret`。保留键名，只隐藏值。**Web session 通道不受影响**，行为与今天一致。

> **设计门勘误**：初稿把 `cached_repos.url` 列为脱敏目标，**它自 RFC-204 起就不在 wire 上**
> （`shared/schemas/cachedRepo.ts` 根本没有 `url` 字段），该条是 no-op。真正在漏的是
> **`tasks.repo_url` / `task_repos.repo_url`**（`services/task.ts:3997,4102,4136,4162` 四处
> 未脱敏），它对**所有通道**修复而非只对令牌——详见 design §5.3。

### D10 — MCP 服务端形态

- 端点 `POST /api/mcp`，**Streamable HTTP**，**无状态**（不签发 `Mcp-Session-Id`）。
- **只接受 PAT**：session token 与 daemon token 打该端点一律 401。
- 管理员**全局开关，默认开启**；关闭后令牌创建入口与 `/api/mcp` 同时失效。
- 工具名、参数名、参数描述、错误文案**全英文**。
- `tools/list` 按该令牌的矩阵**动态过滤**，只返回可用工具。
- 只做 `tools`，**不做** `resources` / `prompts`。

### D11 — 工具集形态：任务域具名，其余收敛

- **任务域具名**：`launch_task` / `watch_task` / `cancel_task` / `retry_node` /
  `get_task_diff` 等。
- **人工门具名且完整面**：`list_pending_gates` / `answer_clarify`（逐题作答 + 提交冻结）/
  `submit_review`（逐文档评论 + 通过 / 打回）。
- **其余收敛**：`resource_read` / `resource_write` + `method` 参数（对齐 GitHub 新版
  `issue_read` / `issue_write` 的收敛方向），配 `describe_resource(kind)` 派生 JSON Schema。
- `launch_task` **全量透传** `StartTaskSchema`（含多仓 `repos[]`、`workingBranch`、
  `autoCommitPush`、`collaboratorUserIds`、git 身份、`expectedWorkflowVersion`）；
  **multipart 上传类输入不支持**，命中带 upload 输入的工作流时给明确错误。
- **skill 附件文件不支持**：只能建 / 改元数据与 `SKILL.md` 正文。
- 「执行」档覆盖：启动任务、取消任务、重试 / 恢复 / 诊断修复、推进人工门（反问与评审）。

### D12 — 结果回传：轮询 + 长驻 watch + 进度通知

`launch_task` 立即返回 `taskId`；另有 `watch_task` 阻塞等待，**上限 240s**（Bun 的
`idleTimeout` 硬顶 255s 之下留 15s 余量，见 `cli/start.ts:544` 的既有注释），超时返回当前
快照 + `stillRunning`，期间推送 MCP progress notification。

### D13 — 参考 GitHub 的范围

只参考 **MCP 形态与命名**（Bearer 认证、工具命名收敛、只读语义）。**不采用** GitHub 的
`read` / `write`（含删）/ `admin` 三级模型——它的 `write` 包含删除，与 D4 的显式删除档
冲突。**不引入** toolsets 分组（可见性完全由令牌矩阵决定）。**不改** 现有 REST 风格
（错误体保持 `{code, message, details}`，不改成 GitHub 的 `{message, documentation_url}`）。

### D14 — 路由元数据层是权限门的单一事实源

每条路由声明 method / path / 所需权限点 / 请求与响应 schema，框架据此统一挂门；
`server.ts` 里手写的 `resourcePermissionGate` / `requirePermission` 挂载全部退役。
**未声明权限的路由启动即失败**（穷尽性由启动期自检强制，范式同仓内 `agentCapability` 的
穷尽 switch）。

### D15 — 角色基线等价照搬现状

`X:write` 展开为 `X:create + X:update + X:delete` 后原样发给现在拥有 `X:write` 的角色；
memory 的旧点按语义映射后照发。行级 ACL 与 `isResourceAdminRole` 的身份判定不变。本 RFC
**不重新设计角色语义**，只改权限点的形状。

### D16 — 审计

- 新建审计表：时间 / 令牌 id / 工具名或方法+路径 / 目标资源 id / 结果状态。**不记请求体**。
- **自己可查 + admin 全看**；保留期**可配，默认 90 天**。
- **删除操作额外旁路存被删内容快照**，与审计同保留期、同脱敏规则。只作存证，不提供一键恢复。
- **不做**速率限制，**不做**每令牌并发任务上限。

### D17 — wiki 界面

- 内容**从代码自动生成为主**（路由元数据 + 工具注册表 + 权限目录）+ 少量手写导语。
- **运行时接口**生成，天然按当前用户角色裁剪。
- 覆盖三块：**MCP 接入指南**、**REST API 参考（全量）**、**客户端配置片段生成器**。
  不做在线试调。
- 配置片段目标：**Claude Code / opencode / 通用 MCP 客户端 / 裸 curl**。
- 入口：**账号页令牌区旁 + 设置页各一个**，路由独立；主导航 `NAV_GROUPS` 不动。
- 语言：**中英双语跟随 i18n**，但生成内容（工具名 / 参数名 / schema 描述 / 错误码）
  **保持英文**，只翻译外壳。
- **登录用户可见，按角色裁剪**。
- 渲染复用 `components/prose/Prose.tsx`，禁止新造 markdown 渲染器。

### D18 — 端点发现接口

`GET /.well-known/mcp` **无需认证**可读，返回 MCP 端点 URL 与启用状态。选在 `/api/*` 之外
是为了不往 `multiAuth` 的 `PUBLIC_PATH_PREFIXES`（`session.ts:39-44`，今天只有 OIDC 登录
三条）里增加前缀匹配条目——那份名单是安全边界，每加一条都是净贬值。用户知情该接口会向未认证
访客确认「这台机器跑着本平台且开了 MCP」。

### D19 — 存量断代

用户明确「不用管现有实现，因为还没人用」。存量 PAT 的旧 scope 语义不做兼容迁移；
迁移时统一作废。本 RFC 不承担任何向后兼容包袱。

---

## 4. 非目标

- **平台内部 agent 自举**：平台自己的 opencode / claude 节点把本平台当 MCP 用（在工作流里
  建资源、启子任务）不在 v1。接口设计不堵死这条路，但令牌注入 agent 环境、与 RFC-224 受控
  配置封印的关系、与 RFC-243 call 节点的语义重叠都留给后续切片。
- **intent 意图构建会话**接入 MCP（多轮会话式构建不适合无状态传输）。
- **skill 附件 / 二进制文件**通过 MCP 写入。
- **multipart 上传类任务输入**通过 MCP 启动。
- **MCP `resources` 与 `prompts`** 两个面。
- **OAuth 授权码流**：本 RFC 只做 Bearer 令牌。
- **速率限制与配额**。
- **删除内容的一键恢复**（只存证，恢复靠现有全库 backup）。
- **远程网络可达性**：`bindHost` 默认仍是 `127.0.0.1`（`packages/shared/src/schemas/config.ts:517`），要对外暴露由部署方
  自行改绑定或架反代；本 RFC 不改网络绑定，也不提供 HTTPS 终结。
- **改造现有 REST 错误体 / 分页 / ETag 以对齐 GitHub**。
- **重新设计角色语义**（见 D15）。

---

## 5. 验收标准

### 授权层

- **AC-1**：权限目录中不再存在 `资源:write`；每个矩阵内资源类型都有 `:create` / `:update` /
  `:delete` 三点，并按 D15 等价发放给现有角色。快照测试锁定 admin / manager / user 三个角色
  的完整点集。
- **AC-2**：**双向穷尽**。正向：所有路由都在元数据中声明了权限点，**故意删掉任一条声明会让
  daemon 启动失败**。反向：任何声明了却没有被任何路由引用的**矩阵域**权限点，同样让启动失败
  （死点会出现在授权矩阵 UI 上误导用户「勾了就有能力」）。两向各有测试锁定。
  **权限点按真实路由派生，不按资源类型对称补齐**——实测 `repos:update` 与 `skills:execute`
  就是对称直觉会造出的死点。
- **AC-3**：`server.ts` 中不再有 `resourcePermissionGate` / `requirePermission` 的手工挂载；
  权限门全部由元数据派生。源码层文本断言锁定。
- **AC-4**：真正缺门的三个域 **workgroups / reviews / clarify**（外加 scheduled-tasks 的
  PUT/DELETE）的每条写路由都有权限点并被令牌矩阵实际收窄——每个域各一条「窄令牌被拒」测试。
  memories 与 intent **本来就有点**（设计门勘误，见 §1.4），它们只做点名迁移，不算「补门」。
- **AC-5**：空矩阵的令牌 = 只读。它读得到该用户可见资源，写 / 删 / 执行一律 403。
- **AC-6**：`POST /api/scheduled-tasks`（及改动 `launchPayload` 的 `PUT`、`run-now`）**同时**
  要求 scheduled-tasks 侧动词点与 `tasks:execute`；只有 `scheduled-tasks:create` 的令牌
  无法借定时任务绕过执行限制。

### 令牌

- **AC-7**：`POST /api/auth/pats` 恢复可用，返回的原始令牌只出现一次；矩阵越过角色基线的部分
  在创建时被拒绝（不是静默丢弃）。
- **AC-8**：删除档不出现在任何模板；只勾「完整」模板签出的令牌，对每个资源类型的 DELETE
  都是 403。
- **AC-9**：**「业务路由」定义为 `/api/*` 减去 `/api/mcp`**。仅 MCP 用途的令牌打任意业务路由
  → **403 `token-mcp-only`**；打 `/api/mcp` 正常。通用用途令牌两条通道都通。
  门序：`tokenAccess: 'never'` 先于用途门——故 `mcp_only` 令牌打 `/api/auth/me` 得到的是
  `tokenAccess` 的拒绝码，不是 `token-mcp-only`，且该顺序有测试锁定。
- **AC-10**：任何令牌打 `/api/auth/*` 的任意方法一律拒绝，包括 `GET /api/auth/pats`。
- **AC-11**：任何令牌打 `PUT /api/{res}/:id/acl` 一律拒绝，即使矩阵勾满该资源的修改档。
- **AC-12**：经令牌读取 MCP 资源时，`config.env` 的值、`headers`、`oauth.clientSecret`
  全部掩码；同一份数据经 Web session 读取保持明文（行为不变）。
  （`cached_repos.url` 已不在 wire 上，无法构造「session 明文」的对照条件——改由 AC-38 的
  防回归断言覆盖。）

### MCP

- **AC-13**：`POST /api/mcp` 只接受 PAT；session token 与 daemon token 401。
- **AC-14**：`tools/list` 的返回随令牌矩阵变化——只勾「任务·执行」的令牌看不到
  `resource_write`。
- **AC-15**：`watch_task` 在 240s 内以 ≤10s 的间隔持续发送 progress notification（即使任务
  状态无变化），超时返回快照且 `stillRunning: true`。
- **AC-16**：MCP 删除工具缺 `confirm` 或名字不匹配时拒绝，且**没有任何副作用**。
- **AC-17**：命中带 upload 类输入的工作流时，`launch_task` 返回明确的不支持错误而非静默降级。
- **AC-18**：全局开关关闭后，`/api/mcp` 与 `POST /api/auth/pats` 同时不可用，且已存在的令牌
  在 REST 通道上的行为不受影响（仅 MCP 面关闭）。

### 审计

- **AC-19**：每次经令牌的调用都落一条审计行，且**审计行内不含请求体**。
- **AC-20**：每次经令牌的 DELETE 额外落一份被删内容快照，快照按 D9 同规则脱敏。
- **AC-21**：用户只能查到自己令牌的审计；admin 能查到全部。保留期到期后自动清理。

### wiki

- **AC-22**：wiki 的工具清单、参数、权限矩阵、错误码全部由运行时接口从代码派生——**新增一个
  MCP 工具或改一条路由的权限点，wiki 无需改动即反映**，且有测试锁定这条派生关系。
- **AC-23**：wiki 按当前用户角色裁剪：普通 user 看不到仓库域写操作与系统域端点的文档。
- **AC-24**：配置片段生成器给出 Claude Code / opencode / 通用客户端 / curl 四份可直接使用的
  片段，端点地址由浏览器当前地址推导，令牌位置为占位符（不回显明文）。
- **AC-25**：opencode 片段带 `oauth: false`（否则 opencode 会对我们的端点发起 OAuth 探测，
  见 design §2.4 的源码实测）。
- **AC-26**：wiki 正文中英双语跟随 i18n；工具名 / 参数名 / 错误码在两种语言下都保持英文。
- **AC-27**：wiki 复用 `Prose`，仓内不新增第二个 markdown 渲染器；源码层文本断言锁定。
- **AC-28**：390px 下 wiki 正文与代码块无页面级横向溢出（代码块自身可横向滚动）。

### 设计门追加（2026-08-01 自查发现，非新决策——是 D2 / D9 / D14 的实现补全）

- **AC-29**：**跨域副作用族**的五条路由各有一条专属回归，断言「只有 A 域档、缺 B 域档」的令牌
  被拒：
  1. `POST /api/scheduled-tasks` 缺 `tasks:execute`；
  2. `POST /api/workgroup-tasks/:taskId/dw-save-as-workflow` 缺 `workflows:create`；
  3. `POST /api/fusions` 缺 `skills:update`；
  4. `POST /api/fusions/:id/approve` 缺 `skills:update` 或 `memory:update`；
  5. `POST /api/memory-distill-jobs/:id/retry` 缺 `tasks:execute`。
- **AC-30**：`purpose === 'mcp_only'` 的令牌**无法建立 WebSocket 连接**（`/ws/*` 在
  `multiAuth` 之外，用途门必须在 `tryUpgrade` 里单独实施）。**状态码统一为 403**，与 HTTP
  用途门一致——WS 升级失败体沿用 `ws/server.ts` 既有的 `{ok:false, code, message}` 形状。
- **AC-31**：§D9 的脱敏对 **WS 出帧路径同样生效**——`services/tokenRedaction.ts` 被 REST 与 WS
  两条出口共同调用，有测试断言两条通道对同一份数据产生同样的掩码结果。
- **AC-32**：`memory:approve` 退役后，`routes/memoryDistillJobs.ts` 的
  `requireResourceAdmin('memory:approve')` 已改为 `memory:update`，**身份门仍是 admin/manager**
  （不因动词映射而放宽）。
- **AC-33**：路由元数据覆盖**生产 `app` 上可路由到的每一条路由**——不是「36 个文件」这个
  单位。断言方式是遍历 Hono 路由表求差集，因此天然涵盖两类不在 `routes/*.ts` 里的路由：
  `GET /api/whoami`（`server.ts:159`）与 `mountAclEndpoints` 模板生成的 12 条 ACL 路由。
  `/health` 这类 `/api/*` 之外的公开路由以 `publicReason` 显式声明。

### 设计门第二批（对抗安全评审，2026-08-01）

- **AC-34**：`PUT /api/tasks/:id/members` 与 `PUT /api/workgroup-tasks/:taskId/config` 为
  `tokenAccess: 'never'`。回归断言：持满额 `tasks:update` 的令牌调用二者均被拒，且
  `tasks.owner_user_id` 与 `task_collaborators` **零变化**。
- **AC-35**：`tasks:cancel:own` / `tasks:cancel:all` 已从权限目录**删除**（实测零引用）；
  取消归 `tasks:execute`。回归断言：**空矩阵令牌对 `POST /api/tasks/:id/cancel` 返回 403**。
- **AC-36**：`services/pluginInstaller.ts` 的 npm 安装带 `--ignore-scripts`。回归用一个
  带 `postinstall` 的本地 fixture 包断言脚本**未被执行**。
- **AC-37**：WS 令牌裁决按**默认拒绝、白名单放行**：`mcp_only` 令牌开任何频道 401；
  `general` 令牌开 `repo-import` 与 `intent-sessions` 被拒；新增频道未声明裁决时**编译失败**
  （穷尽 switch）。
- **AC-38**：`rowToTask` 对 `repoUrl` 施加 `redactGitUrl`，**对所有通道生效**（不只令牌）；
  回归用一个 `https://user:token@host/repo.git` 形式的 `repoUrl` 启动任务，断言
  `GET /api/tasks` 与 `GET /api/tasks/:id` 都不回明文。`cached_repos.url` 保留一条防回归断言。
- **AC-39**：`getNodeRunStdout` 输出经 `redactSensitiveString`；且账号页与 wiki 文案中
  **不出现**「只读令牌不会泄漏密钥」这类表述（源码层文本断言），因为 worktree 文件读按设计
  不脱敏。
- **AC-40**：`GET /api/runtimes` 与 `GET /api/runtimes/status` 都要求 `runtime:read`；
  回归断言令牌（系统域恒不含该点）拿到 403，普通 session 用户仍 200。
- **AC-41**：退役点清扫覆盖**整个 backend** 而非只有 `routes/`——含
  `ws/registry.ts:750-755` 的 `memory-distill-jobs` 频道 gate，以及
  `services/resourceAcl.ts:216` / `services/workflow.ts:636` 的 `as never` 断言处
  （它们绕过 `Permission` 联合类型，退役点在那里不会编译报错）。

### 设计门第三批（事实核对评审，2026-08-01）

- **AC-42**：`/.well-known/mcp` 无需认证可读、返回文档所述字段、**且挂在 SPA catch-all
  之前**（有测试断言它不会被 SPA fallback 吞掉）。
- **AC-43**：**管理员不能吊销他人令牌**——负向断言：admin 对他人 `patId` 调吊销端点被拒，
  且该令牌仍可用；同一 admin 可吊销自己的。
- **AC-44**：wiki 入口只在**账号页令牌区旁 + 设置页**两处；`lib/nav.ts` 的 `NAV_GROUPS`
  **零改动**（源码层文本断言）。
- **AC-45**：`assertDeleteConfirm` 覆盖面从 7 条扩到 11 条（补 skill 文件 / cached-repo /
  memory / scheduled-task）；每条各有一条「缺 confirm ⇒ 422 且资源仍在」的红绿测试。
- **AC-46**：`tasks:cancel:own` / `tasks:cancel:all` 已从目录删除；`RANGE_POINTS` 与
  `ROUTE_BACKED_POINTS` 两个常量存在，且有测试断言
  `READ_POINTS ∩ SYSTEM_DOMAIN_POINTS = ∅`（防 `intent:read` 那类静默泄漏复发）。
- **AC-47**：矩阵资源键与权限点前缀**同名**（`scheduled-tasks`，与路由 `/api/scheduled-tasks`
  一致），文档与代码不得出现 `schedules:` 变体（源码层文本断言）。
- **AC-48**：`GET /api/overview` 与 `POST /api/plantuml/render`（今天**完全无门**）在元数据里
  声明 `tasks:read`；回归断言未认证与越权访问被拒。
