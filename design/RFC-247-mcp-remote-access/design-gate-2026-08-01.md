# RFC-247 · 设计门记录（2026-08-01）

> CLAUDE.md 工作准则要求 RFC 请批前跑一次 Codex review（设计门）并修 findings。本文件如实记录
> 本轮门禁的**执行过程、替代关系与处置**，包括失败部分。

---

## 1. Codex 路径：wedge，未产出 findings

- **调用方式**：按 `docs/dev-gotchas.md` §Codex + per-user memory 的记录，插件 1.0.6 × CLI
  0.146.0 是已知互挂组合（companion review 卡在 "Starting Codex review thread."），故直接走
  `codex exec --sandbox read-only` 直驱兜底路径。
- **执行**：2026-08-01 23:19:23 启动，prompt 为对抗式设计门（范围 / 输出格式内联，明确 read-only、
  禁构建、禁测试、60s 放弃）。
- **过程**：正常工作约 8 分钟，rollout 增长到 1,057,145 bytes，token 计数显示 4.14M input /
  11.3K output / 6.4K reasoning——是一次真实的深度审查，不是空转。
- **结局**：**23:27:11 后 rollout 冻结、进程 CPU 0.0%、stdout 0 字节**。这与 dev-gotchas
  记录的 wedge 签名完全一致（「进程 ~0 CPU、rollout 冻结」）。
- **处置**：按 dev-gotchas「**勿三连重试**」，未重试，`pkill -f "codex exec"` 止损。

### 1.1 Pre-stall 抢救

按 dev-gotchas「从 `~/.codex/sessions` 的 rollout jsonl 里抢救 pre-stall finding」，从
`rollout-2026-08-01T23-19-23-019fbde8-*.jsonl` 提取到 6 段 assistant 输出。**全部是规划阶段
陈述，零 findings**。有价值的一段是它自己列出的排查方向：

> RFC 的路由表只按十个业务域分组，但真实目录还包含
> `backup/config/daemon/fusions/health/intent/memoryDistillJobs/oidc/overview/plantuml/restore/runtime/users`
> 等系统或混合域，以及独立 WebSocket 注册表。我会把这些都纳入穷尽性与 `tokenAccess` 审计。

这与本文 §2 的自查命中**方向完全一致**（fusions / memoryDistillJobs / WebSocket / 穷尽性），
构成一次独立佐证——但它在给出结论前就 wedge 了，因此**不计为通过的门**。

---

## 2. 自查（Codex 运行期并行进行）

在等待 Codex 期间自行做了一轮全量路由清点与鉴权链核对，命中 6 条，全部已折入 RFC：

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| S1 | P0 | **`routes/workgroupTasks.ts` 9 条路由完全缺失**于映射表；其中 `POST /:taskId/dw-save-as-workflow`（`:67-73`）在 workgroup-task 域下**创建 workflow 资源** | design §2.3 新增 workgroup-tasks 表；该条改**双点 AND**（`tasks:execute` + `workflows:create`） |
| S2 | P0 | **`routes/fusions.ts` 7 条路由完全缺失**；`POST /api/fusions` 跑内置 agent、`/:id/approve` 原子 bump skill 版本 + fuse memory。今天 fusion 对 skill 的授权是**行级 ACL**（`services/fusion.ts:502` 抛 `fusion-skill-forbidden`），只回答「你是不是 owner」，**不回答「你的令牌有没有 `skills:update` 档」** | design §2.3 新增 fusions 表；launch 与 approve 各用双点 AND |
| S3 | P1 | **WebSocket 完全未被考虑**。`/ws/*` 的升级在 `Bun.serve.fetch` 里（`cli/start.ts:551-556` 先调 `ws.tryUpgrade`），**完全在 `multiAuth` 之外**；`ws/server.ts:110-135` 直接 `resolveActor`，注释明写接受 PAT。⇒ (a) `mcp_only` 令牌可开 WS 绕过用途门；(b) 矩阵对 WS 不生效；(c) REST 序列化脱敏对 WS 帧不生效 | design 新增 §3.5；plan 新增 T11b（WS 用途门）与 T12 扩为**两条出口**接线；proposal 新增 AC-30 / AC-31 |
| S4 | P1 | `routes/memoryDistillJobs.ts:26` 等五条的门是 `requireResourceAdmin('memory:approve')`，而本 RFC 让 `memory:approve` 退役 ⇒ **gate 引用不存在的点** | design §2.3 memory 小节加连带说明；plan 新增 T3b；proposal 新增 AC-32 |
| S5 | P1 | 三处跨域提权面（S1/S2 + 原有的 scheduled-tasks）构成**同一缺陷族**：「A 域路由产生 B 域副作用，而门只看 A 域」 | design §2.3 显式命名该族；T3 验收改为「逐条回答有无跨域副作用」，禁止按 URL 前缀想当然归档；proposal 新增 AC-29 |
| S6 | P1 | **权限点按资源类型对称补齐会造出死点**。实测 `routes/cached-repos.ts` + `routes/repos.ts` **无任何 PUT/PATCH** ⇒ `repos:update` 无路由；`routes/skills.ts` 5 条 POST 全是 create/update 语义 ⇒ `skills:execute` 无路由。死点会出现在授权矩阵 UI 上，**让用户以为勾了就有能力**——这是授权界面在撒谎 | design §3.2 升级为**双向穷尽自检**（无元数据的路由 → 启动失败；无路由引用的矩阵域点 → 启动失败）；proposal AC-2 改写；plan T4 明确「不要给 repos 补 update、给 skills 补 execute」 |

---

## 3. 替代门禁：Claude 子代理对抗评审

Codex 既已 wedge 且不重试，按 dev-gotchas 的止损姿势（「改用 Claude 子代理，全新上下文 +
对抗 prompt，做同强度独立评审并**如实记录替代关系**」）执行，用两个**正交视角**并发以补偿
单一评审者的盲区：

- **视角 A（对抗安全）**：专攻「令牌如何超出其矩阵」，按跨域副作用 / 自提权 / 脱敏绕过 /
  门外通道 / 授权公式语义五类穷举，要求每条 finding 给出具体攻击场景。
- **视角 B（事实核对）**：不评价设计，只验证 RFC 对既有代码的每条 `file:line` 断言是否属实、
  §2.3 映射表与真实路由清单的差集、三份文档的内部一致性、每条 AC 的可测性，并实跑
  `packages/shared` 的 typecheck 与测试以给出「已知待修清单」。

> **这不等同于 Codex 门。** 它是同强度的独立评审替代，按仓库既定止损规程执行并在此记档，
> 而非声称 Codex 门已通过。

（findings 与逐条处置见 §4，实施期回填。）

---

## 4. 替代门 findings 与处置

两个视角合计 **5 P0 / 17 P1 / 23 P2**。**全部逐条核实过**（不照单全收），下面按视角列出并给出
处置。两个视角**独立命中同两条**（`cached_repos.url` 是 no-op、cancel 范围点是死点），是强信号。

### 4.1 视角 A（对抗安全）：2 P0 / 6 P1 / 3 P2

| # | 级别 | finding | 核实 | 处置 |
|---|---|---|---|---|
| A1 | **P0** | **`plugins:create/update` = 宿主任意代码执行**。`services/pluginInstaller.ts:220-224` 跑 `npm install` **无 `--ignore-scripts`**，`:600-602` 用 `env: process.env`，在所有 containment 之外。`postinstall` 即以 daemon 身份执行，拿到 daemon token / 全部 MCP 密钥 / 全部仓库凭据 / SQLite 库 | ✅ 实测属实 | design **新增 §5.4**：本 RFC **加 `--ignore-scripts`** 修根因（D19 零兼容风险），plugins 三档保留在矩阵；「安装仍在 containment 外 + 继承完整 daemon env」登记 backlog。**不采用**「把三档设为 never」——那是拿功能换安全而根因一行可修 |
| A2 | **P0** | **`PUT /api/tasks/:id/members` 在 `tasks:update` 下转移 owner**。`services/taskCollab.ts:132-161` 接受 `{ownerUserId, userIds}`，`canManage` 只要求「你是 owner」。而任务成员**就是**评审/反问的回答权边界；**吊销令牌不能撤销**该授予 | ✅ 实测属实 | 改 `tokenAccess: 'never'`（design §3.3）。D5 的不变量被初稿**只表达成了一个 URL 形状**，这是它的第二个 URL |
| A3 | P1 | `PUT /api/workgroup-tasks/:taskId/config` 的 `addMembers` 插 `task_collaborators` 行（`configActions.ts:333`，其 `:172-175` 注释自陈），把任意活跃用户加进成员私有任务 | ✅ 属实 | 同上，`never` |
| A4 | P1 | 同一 handler 加 agent 成员后调 `kickResumeIfResumable`（`:493`）**踢引擎跑**——`update` 路由产生 `execute` 副作用 | ✅ 属实 | 被 A3 的 `never` 一并覆盖；并入跨域族表 |
| A5 | P1 | **`tasks:cancel:own/all` 是死点**且 `READ_POINTS` 无条件并入范围点 ⇒ 反向自检让 daemon 起不来；「随手给 cancel 路由声明该点」的补救会**打穿 AC-5**（空矩阵令牌也能取消） | ✅ 实测零引用；`cancelTask` 无 actor 参数 | **删除这两个点**；cancel 归 `tasks:execute`；新增 `tasks:read`；新增 `RANGE_POINTS` / `ROUTE_BACKED_POINTS` 两个常量把范围点排除出反向自检 |
| A6 | P1 | `POST /api/memory-distill-jobs/:id/retry` 在 `memory:update` 下**拉起真实 LLM 进程**（`memoryDistillScheduler.ts:342,448`），且 D16 不做速率限制 | ✅ 属实 | 双点 AND：`memory:update AND tasks:execute`；design §2.3 新增独立小节 |
| A7 | P1 | **WS 频道清单错了：10 个不是 4 个**；`repo-import`（`:653`）**无任何 gate**（spec 自陈 "no gate of any kind"）；`intent-sessions`（`:777`）令牌可读而 REST 侧 403 | ✅ 实测属实 | design §3.5 **重写**：从 `WS_CHANNEL_KINDS` 派生 10 频道表，逐个裁决；`repo-import` / `intent-sessions` 一律拒 PAT；改为**默认拒绝白名单放行 + 穷尽 switch** |
| A8 | P1 | **脱敏清单挑错字段**：`cached_repos.url` 自 RFC-204 起就不上线（no-op），真正在漏的是 `tasks.repo_url`（`services/task.ts:3997/4102/4136/4162` 四处未脱敏，而同文件 `:1194/:1827/:1898` 特意脱敏） | ✅ 实测属实 | §5.3 换成 `tasks.repo_url` + `task_repos.repo_url`，且**对所有通道**修（修既有泄漏，不只是加令牌门）；`cached_repos.url` 降为防回归断言 |
| A9 | P2 | `GET /api/runtimes` **无门**——`server.ts:246-247` 挂的是 `/api/runtime` 与 `/api/runtime/*`，匹配不到复数 | ✅ 属实 | design §2.3 新增 runtimes 小节，两条 GET 声明 `runtime:read` |
| A10 | P2 | `getNodeRunStdout` 与 worktree 文件读是**自由字节流**，「读恒开」使其成为最宽的读面 | ✅ 属实 | stdout 接 `redactSensitiveString`；worktree 文件**明确写为不脱敏**，并禁止 UI 文案承诺「只读令牌不泄漏密钥」 |
| A11 | P2 | `memory:approve` 退役清扫漏了 `ws/registry.ts:750-755` 的频道 gate；`services/resourceAcl.ts:216` / `workflow.ts:636` 的 `as never` 绕过 `Permission` 联合类型 | ✅ 属实 | T3b 扩为全 backend 清扫 + 人工过 `as never` 两处 |

### 4.2 视角 B（事实核对）：3 P0 / 11 P1 / 20 P2

**锚点**：约 30 条 `file:line` 断言**逐条验证通过**，含 §2.4 全部 6 条 opencode 锚点。
错的 6 条已改：`permission.ts:181→187`、`actor.ts:35→40`、`audit-backlog:61→60` 与 `:62→61`、
`session.ts:139-186` 实为 `resolveActor`（`multiAuth` 在 `:59-85`）、
`gitRepoCache.ts:223` 是调用点非定义、`config.ts` 需全限定为 `packages/shared/src/schemas/`。

| # | 级别 | finding | 核实 | 处置 |
|---|---|---|---|---|
| B1 | **P0** | **85 / ~256 条路由无 §2.3 映射**，含 3 条今天完全无门（`overview` / `plantuml` / `runtimes` GET）；`GET /api/whoami`（`server.ts:159`）与 12 条模板 ACL 路由**不在 36 个文件里**，T3 扫不到而正向自检会让 daemon 起不来 | ✅ 属实 | design §2.3 新增**系统域与公开路由表**（16 个文件逐条）+ 两处特殊挂载的处理约定（`mountAclEndpoints` 自己登记元数据）；AC-33 从「36 个文件」改为「生产 app 上每一条路由」 |
| B2 | **P0** | `DELETE …/comments/:id → tasks:delete` 会**连 Web UI 一起锁死**（元数据门跑在 handler 之前、对所有 actor 生效），且初稿声称的「session 走 handler 内作者判定」**不存在**（`reviews.ts:352-358` 只有 `ensureReviewMember`；`audit-backlog:63` 早已登记） | ✅ 实测属实 | 评审评论删除**豁免规则 ①**，归 `tasks:execute`；规则 ① 同时补上作用域定义 |
| B3 | **P0** | 同 A5（cancel 死点 + `RouteMeta.permissions` 只有 AND 语义无法表达范围） | ✅ | 同 A5 处置 |
| B4 | P1 | **§1.4 事实错误**：memories 与 intent **本来就有权限点**（`routes/memories.ts` 每条、`intentSessions.ts:212-213`），初稿的举例也不成立 | ✅ 实测属实 | proposal §1.4 **改写并显式标注勘误**；AC-4 从「五个域」收窄为 workgroups / reviews / clarify + scheduled-tasks 的 PUT/DELETE |
| B5 | P1 | 资源键命名不一致：文档 `scheduled-tasks:*`，已写的代码 `schedules:*` | ✅ | 代码改为 `scheduled-tasks`（与路由一致）；新增 AC-47 源码断言禁止 `schedules:` 变体 |
| B6 | P1 | AC-3 要求「`server.ts` 无手工挂载」但 T4 只删 `:183-211`——下面还有 **6 处**（configGate / daemon / backup×2 / restore×2 / runtime×2） | ✅ 属实 | T4 范围改 `:183-247` 并逐条列出 |
| B7 | P1 | `READ_POINTS` **漏了 `intent:read`**——手写排除列表只挡了 5 个系统 `:read` 中的 4 个 | ✅ 属实（与我自查 E3 同一处，它给出了确切的泄漏项） | 改为 `!SYSTEM_DOMAIN_POINTS.includes(p)` 派生；调整声明顺序；加 `READ∩SYSTEM=∅` 断言（AC-46） |
| B8 | P1 | D4-4 承诺「MCP 删除工具保留 type-to-confirm」，但 `assertDeleteConfirm` **只挂在 7 条**上，另 5 条也会经 `resource_write method:delete` 暴露 | ✅ 属实 | design §1.4 列表化：**补齐 4 条**（skill 文件 / cached-repo / memory / scheduled-task），评审评论那条不补（已改归 execute）；新增 AC-45 |
| B9 | P1 | 规则 ①「DELETE 恒 delete 档、无例外」被 **8 条系统域 DELETE 违反**，套用会凭空造 7 个死点 | ✅ 属实 | 规则 ① 加作用域：限矩阵域资源；系统域与「资源内交互记录」两类例外逐条列出 |
| B10 | P1 | AC-12 的对照条件**不可能成立**（`cached_repos.url` 无明文通道） | ✅ | AC-12 去掉该字段，改由 AC-38 的防回归断言覆盖 |
| B11 | P2×多 | 规则 ② 对纯预览 POST 判定不一致（`closure-preview`→read vs `validate`→execute 无判据）；D18/D8/D17 无 AC；AC-6 的「改动 launchPayload 的 PUT」静态元数据表达不了；401/403 不一致；AC-18 措辞；D15 未覆盖新建域的基线；`worktree-files` 路径不在 `/api/tasks*` glob 内；AC-24/AC-8/AC-9/AC-33 可测性 | ✅ 逐条属实 | 规则 ② 补「是否消耗外部资源」判据（顺带保住 `workflows:execute` 不成死点）；新增 **AC-42～AC-48**；AC-6 去掉 payload 条件；WS 用途门统一 **403**；`worktree-files` 独立成行；D15 补新建域规则 |

### 4.3 代码侧同步完成（PR-1 的一部分，已实测）

`packages/shared/src/schemas/permission.ts` 已按上述结论改完并验证：

```
READ_POINTS ∩ SYSTEM_DOMAIN_POINTS = ∅        （intent:read 泄漏已修）
tasks:cancel:*                      已删除
总点数 60 | matrix 48 | route-backed 46
空矩阵 user  ⇒ 11 个点，全部 ∈ READ_POINTS   （AC-5 成立）
admin 勾 agents:update 但未勾 delete ⇒ 不含 agents:delete （AC-8 成立）
user 可勾档位 32 | admin 36
tsc --noEmit                        通过
```

`ROLE_PERMISSIONS` 的等价性由视角 B 逐点核对确认「无静默放宽或收窄」。

### 4.4 已知待修（预期内，随 PR-1 后续任务收口）

`packages/shared` 4 条测试红（`permission.test.ts` 整文件因 `PAT_EXPLICIT_ONLY_PERMISSIONS`
已删而 module-load 失败，12 条被挡；`permission-rfc041.test.ts` 3 条断言旧 memory 五点）。
全仓另有 **52 处**引用已删点/导出，分布在 17 个文件——这正是 T2/T3 的工作量，不是回归。
