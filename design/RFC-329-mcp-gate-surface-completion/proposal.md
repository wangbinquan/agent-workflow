# RFC-329 —— MCP 人工门完整面、死路径修复与全域「路由⟷工具」守卫

状态：Draft（2026-08-26）· 批准前零生产改动

## 1. 背景

用户问：「现在 agent-workflow 的 API 和 MCP 有回答完反问提交反问的能力吗，包括提交并继续反问和提交并停止反问」。

源码对账的答案是**一半有、一半没有**：

- **REST 完整**：`POST /api/clarify/:nodeRunId/answers`（`routes/clarify.ts:213-214`）收
  `SubmitClarifyAnswersSchema`（`shared/schemas/clarify.ts:137-172`）的
  `directive: 'continue' | 'stop'`（缺省 `continue`），`stop` 的语义在
  `shared/clarify.ts:226-241`——下一轮 prompt 注入 `### User directive: STOP CLARIFYING`
  **且不再追加 `<workflow-clarify>` 协议块**，所以 agent 想再问也问不出来。网页端
  「提交并继续反问 / 提交并停止反问」两个按钮就是打这条路由
  （`frontend/src/routes/clarify.detail.tsx:492-522` / `:1029-1056`）。
- **MCP 只有整轮快通道**：`answer_clarify`（`mcp/tools.ts:563-594`）确实收
  `directive: 'continue' | 'stop'` 并经 `ctx.dispatch` 打回同一条 REST 路由，语义逐字一致；
  但它**表达不了** `defer` / `questionIds` / `resubmitQuestionIds`，于是「逐题作答 → 待指派 →
  批量下发」那条控制通道在 MCP 上摸不到。这一条 `docs/audit-backlog.md:98` 已挂账。

用户随即要求：「你也再看下 MCP 或者 API 还没有其他缺口，这次一并审视补齐」。

本 RFC 是那次全面审计的结论与补齐方案。

## 2. 审计方法与总账

**不是读文档，是动态跑出来的**。把 `createApp` 真实挂出的全量路由（`allRouteMeta()`，
`routes/registry.ts:108`）与 MCP 工具**实际 dispatch 到的路径**（recording dispatcher 逐个真调
`tool.handler`，收敛工具遍历 11 kind × 6 method）做双向 diff。技术沿用
`tests/architecture/rfc326-review-tool-route-guard.test.ts:66-105` 的记录式调度。

> **v2 勘误（2026-08-26 设计门 P1-1 / P1-11）**：v1 的数字全部作废。两处错：①deps 用 stub 建
> app，条件挂载的路由（需要 `secretBox` 的那批）根本没挂上，分母偏小；②**漏了一整个维度**——
> 一条路由即使 `tokenAccess:'allow'`，只要它的权限点落在 `SYSTEM_DOMAIN_POINTS`
> （`shared/schemas/permission.ts:806-851`），`resolveTokenPermissions` 就会显式
> `out.delete(p)`（同文件 `:1293-1301`），**任何 PAT 都永远够不着**。v2 用
> `buildContractHarness` 同款 deps（含 `secretBox`）重跑，并把这一维补进判据。

| 口径                                      | v1（错） | **v2（准）** |
| ----------------------------------------- | -------- | ------------ |
| 已注册路由                                | 440      | **470**      |
| `tokenAccess:'never'`（PAT 不得开这扇门） | 50       | **63**       |
| **权限点 PAT 永不可持**（v1 漏掉的维度）  | —        | **61**       |
| PAT 真正可达                              | 313      | **346**      |
| 已有工具覆盖                              | 77       | **79**       |
| **真实缺口**                              | 313      | **267**      |

一条附带的好消息：`toolsHitSysBlockedOrNever` 实测为空——现有 29 个工具没有一个打向
PAT 结构上够不着的路由。唯一的例外是 A1 那条**根本不存在**的路由（属 `unroutedTools`，见下）。

267 条按性质分四类。**一类必修、二类本 RFC 补、三类挂账、四类是范围问题**。
另有独立于四类之外的 61 条「结构不可达」，它们**不是缺口**——见 §2.5。

### 2.1 一类：闭环断裂 / 死路径（bug 级）

| #   | 缺陷                                                                               | 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | **`resource_read(kind='repos', method='get')` 恒 404**                             | `RESOURCE_ROUTES.repos.get` 指向 `GET /api/cached-repos/:id`（`mcp/tools.ts:936`），该路由**根本没注册**——`routes/cached-repos.ts` 只有 list / `:id/refresh` / `:id`(DELETE) / batch-import / imports 五条。实测 `404 {"code":"route-not-found"}`。`describe_resource(kind='repos')` 还照表宣称支持 get。前端也从没读过单条（`repos.tsx:156` 只有 delete）——这条路由是 MCP 表凭空发明的                                                                      |
| A2  | **alerts 闭环断裂：`repair_alert` / `list_repair_options` 在 MCP-only 场景是死的** | 两者都必须传 `alertId`；`repair_alert` 的描述说「call get_task first to read the alert」，但 `GET /api/tasks/:id` 走 `serializeTaskFor`（`services/tokenRedaction.ts:224-227`）**只对 workflowSnapshot 脱敏并返回 task 行本身，不含 alerts**。alerts 在独立端点 `GET /api/tasks/:id/alerts`（实测 200 `{alerts:[]}`），**无任何工具**。讽刺的是 `list_repair_options` 的描述自陈「没有它 MCP 调用方拿不到 option id」——它补上了 optionId，alertId 仍然拿不到 |
| A3  | **`launch_task` 的 `ref` 在 MCP 上无法解析**                                       | `GET /api/repos/refs` 无工具，模型只能猜分支名                                                                                                                                                                                                                                                                                                                                                                                                               |
| A4  | **`answer_clarify` 描述里的状态码是错的**                                          | 描述写 `mismatched answers are refused with 412`（`mcp/tools.ts:584`），实际 409——`ConflictError` 硬编码 409（`util/errors.ts:53-57`），`routes/clarify.ts:10-13` 还专门注释说「刻意保持 409 而非 412」。**同一个错还残留在 shared schema 的注释里**（`shared/schemas/clarify.ts:137-142`，设计门 P2-5）。这段文字是给模型读的，错的状态码让调用方写错重试分支                                                                                               |

> **v1 的 A3 / A4 各砍掉一半**（设计门 P1-1 / P1-8，用户 D11 / D12 拍板）：
> `find_users` 与两个 batch-import 工具**从本 RFC 删除**，理由见 §3 非目标与 `plan.md §5`。

### 2.2 二类：人工门不全（本 RFC 的主体）

`list_pending_gates` 自称 _"everything waiting on a human"_，实际只 dispatch
`GET /api/reviews` + `GET /api/clarify` 两路。**同档的门漏了两个**：

- **反问门自身的控制通道**：`defer` / `questionIds` / `resubmitQuestionIds` 表达不了；
  问题看板 6 条（list / manual / confirm / reassign / stage / dispatch）、节点级
  继续-停止开关 2 条、协作草稿 1 条，全部无工具。
- **工作组任务门**（`/api/workgroup-tasks/*`，8 条无工具）：confirm / dw-confirm /
  dw-save-as-workflow / messages / assignments deliver·cancel / room / pending-count。
  它与 clarify **同一个可见性边界**（`canViewTask`，`routes/workgroupTasks.ts:6-7`）、
  **同样停在 `awaiting_human`**（`resolveRoomPauseReason`，同文件 `:34-40`）。
- **fusion 审批门**（`/api/fusions/*`，7 条无工具）：记忆→技能融合的 approve / reject /
  cancel + list / get / pending-count。

> **memory 人审发布门本来也在这一档，v2 移除**（设计门 P1-6，用户 D11）：
> `POST /api/memories/:id/promote` 本身 PAT 可达，但**发现 candidate 需要
> `resource-acl:bypass`**——`routes/memories.ts:139-143` 对非 bypass 者过滤掉全部
> `status='candidate'` 行，而该点在 `SYSTEM_DOMAIN_POINTS` 里（`permission.ts:846`）。
> 于是 MCP 上「看不到、却能对已知 id 下决定」，与 G2 承诺的「可发现、可读、可处置」
> 直接矛盾。真因是权限目录而不是缺工具，**不能靠加一个工具解决**。

### 2.3 三类：资源域运维面（`docs/audit-backlog.md:97` 已挂账，本 RFC 不做）

skills 内容面整块不可达（content / files / file / versions / diff / restore，读写共 11 条）、
workflows `validate` / `validate-draft`、四类 rename、workflows·workgroups `copy`、
`cached-repos refresh` 与 batch-import 的进度 / 重试、mcps probe + runtime-test 9 条、
全部 `GET .../acl` 读面、`scheduled-tasks run-now`、capability-template copy·upstream-merge、
memory `archive` / `unarchive` / `promote`、`POST /api/fusions`（发起融合）。

### 2.4 四类：整块从未纳入（**不是缺口，是范围**）

`/api/code`(72)、`/api/digital-employee-types`(14)、`/api/digital-employees`(8)、
`/api/employee-cases`(5)、`/api/digital-employee-job-templates`(2)、
`/api/digital-employee-input-uploads`(2)、`/api/event-center`(11)、
`/api/webhook-triggers`(7)、`/api/webhook-deliveries`(3)、`/api/webhook-endpoints`(2)、
`/api/integrations`(7)、`/api/resource-packages`(2)、`/api/execution-contracts`(3)。

**这一类真正的问题不是"没有工具"，是"没人看管"**：这些域的权限点不在
`MATRIX_RESOURCES`（`shared/schemas/permission.ts:40-56` 只有 11 类），所以
`MCP_RESOURCE_KINDS` 的漂移锁（`rfc247-mcp-server.test.ts:319-330`）**根本锁不到它们**。
新域可以无声长出来，而没有任何机器会说一句「MCP 没跟」。RFC-326 建的双向守卫
只扫 `/api/reviews*`，管不到这里。

### 2.5 结构不可达（61 条，**不是缺口**）

权限点落在 `SYSTEM_DOMAIN_POINTS` 的路由，任何 PAT 都够不着——给它们做 MCP 工具
**没有意义**（工具要么因声明该权限而永不出现在 `tools/list`，要么因声明空权限而恒 403）。

整域落在此类的有：`/api/intent-sessions/*` 与 `/api/intent-provenance/*`（`intent:read|write`）、
`/api/users/*`（`users:read|write|search`）、`/api/runtimes/*` 与 `/api/runtime/models`
（`runtime:read` / `settings:write`）、`/api/config`、`/api/daemon`、`/api/maintenance/*`
（`settings:*`）、`/api/oidc/*`（`oidc:*`）、`/api/backup` 与 `/api/restore/*`（`backup:run`）、
`/api/memory-distill-jobs/*`（`memory-distill-jobs:manage`）。

**这一节直接证伪了设计门 P1-9**：该 finding 说 `POST /api/intent-sessions/:id/mount-approvals`
是被误分类的人工门、应当纳入。但 `intent:write` 是系统域点——整个 intent 域 PAT 结构上
进不去，纳入它只会造出第二个 `find_users`。重算后该域从缺口列表里整体消失。

## 3. 目标 / 非目标

### 目标

1. **G1（一类全修）**：四条死路径全部修掉，每条带回归用例 + 变异实证。
2. **G2（人工门完整面）**：反问门、工作组任务门、fusion 审批门在 MCP 上可**发现、可读、
   可处置**；`list_pending_gates` 名副其实。memory 人审门 v2 移出（§2.2 的框，权限目录问题）。
3. **G3（REST 补一条）**：新增 `GET /api/workgroup-tasks/pending`——让「哪些工作组任务
   在等人」有可列的端点（今天只有三个数字）。
4. **G4（全域守卫）**：一条覆盖**全部已注册路由**（分母取运行期 `allRouteMeta()`，不硬编码）
   的「路由 ⟷ MCP 工具」守卫，判定**三维**：路径、请求字段、权限（设计门 P1-2，用户 D10）；
   配**域分组 + 组内逐条精确叶子**的豁免账本（设计门 P1-4，用户 D9），接进
   `architecture/ledger-baselines.json` 的高水位机制、盯**叶子总数**。
   **这一条是本 RFC 里唯一能保证「不会有第三次」的东西**。

### 非目标

- **不做三类的资源域运维面**——挂账不变，留给后续 RFC。
- **不做四类的新域工具化**——本 RFC 只让它们**在账本里可见**，不给工具。
- **不做 RFC-294 W4-A 的 operation catalog**（见 §6 的架构对齐）。
- **不扩 `resource_read` / `resource_write` 的 `method` 枚举**——`docs/audit-backlog.md:97`
  明禁（会往 generic invoker 方向加固，RFC-294 design §13.1 禁止）。本 RFC 全部走具名工具。
- **不做 `find_users`**（设计门 P1-1，用户 D11）：`users:search` 在 `SYSTEM_DOMAIN_POINTS` 里，
  PAT 永不持有，该工具声明该权限则永不出现在 `tools/list`、声明空权限则恒 403。
  `launch_task` 的 `collaboratorUserIds` 在 MCP 上因此暂无解——**真因是权限目录，不是缺工具**。
- **不做 batch-import 的进度 / 重试工具**（设计门 P1-8，用户 D12）：这两条 REST 路由只按
  batch/row id 操作、**不读 actor**，无 owner 门（`docs/audit-backlog.md:88` 已挂账）。
  general PAT 今天走 REST 已能做，但 `mcp_only` PAT 被 purpose 门挡着
  （`routes/registry.ts:188-193`），而 MCP dispatch 会按 RFC-247 D2 清除 purpose
  （`mcp/dispatch.ts:125-139`）——补工具等于把一个已知无门的跨用户能力推给自动化通道。
- **不做 memory 的 `promote`**（设计门 P1-6，用户 D11）：见 §2.2 的框。
- **不改权限目录**：不新增 `users:lookup:minimal` / `memory:candidate:decide` 这类窄点。
  那是跨 RFC 的面（连带令牌矩阵 UI 与文档），另立。
- **不改任何网页端行为**。前端不需要任何改动。
- **不动 `PUT /api/workgroup-tasks/:taskId/config`**：它的 `addMembers` 写
  `task_collaborators`，属 RFC-247 D5 的四种 URL 形状之一，`tokenAccess:'never'` 保持。

## 4. 用户决策记录（2026-08-26 逐项拍板）

| #   | 决策                                                   | 取值                                                                                                             |
| --- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| D1  | 本次补到哪一档                                         | **A+B**：一类死路径 + 二类全部人工门。三类挂账、四类只入账本                                                     |
| D2  | 补齐形态                                               | **延续 RFC-326：具名工具 + 双向守卫**。不扩 method 枚举，不等 W4-A                                               |
| D3  | `questions/:entryId/reassign` 的 `tokenAccess:'never'` | **是遗漏，改成 `allow` 并补工具**                                                                                |
| D4  | `GET /api/cached-repos/:id` 这条不存在的路由           | **从 MCP 表删掉 `repos.get`**（不补 REST 路由）                                                                  |
| D5  | 工作组门怎么列                                         | **新增 `GET /api/workgroup-tasks/pending`**；`pending-count` 保持不变（前端 badge 在用）                         |
| D6  | `defer` 半边怎么暴露                                   | **扩既有 `answer_clarify`**（照抄 RFC-326 给 `submit_review` 加 `comments[]`/`selections[]` 的先例），不新开工具 |
| D7  | memory 三个动词补哪些                                  | **只 `promote`**（人审发布门）。`archive` / `unarchive` 是普通生命周期，归三类                                   |
| D8  | 双向守卫做多宽                                         | **全域（分母取运行期路由表）+ 豁免账本**（逐条登记理由），不是只盖本次触及的域                                   |

设计门（2026-08-26，0 P0 / 11 P1 / 11 P2）后用户追加拍板：

| #   | 决策                                                                     | 取值                                                            |
| --- | ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| D9  | 豁免账本结构（P1-4：prefix 会静默吞掉未来新增路由）                      | **域分组 + 组内逐条精确叶子**；高水位盯**叶子总数**而非组数     |
| D10 | 守卫深度（P1-2：只比路径抓不住 `answer_clarify` 那类「路径对、字段缺」） | **加深到三维**：路径 + 请求字段 + 权限                          |
| D11 | 两个权限结构上不可行的工具（P1-1 `find_users` / P1-6 `promote_memory`）  | **都从本 RFC 删掉**，登记延期并写明真因是权限目录而非缺工具     |
| D12 | A4 两个导入工具对 `mcp_only` 令牌是能力扩张（P1-8）                      | **删掉，明确延期**；不在「补工具」的 RFC 里顺手扩大跨用户读取面 |

## 5. 能力影响清单

CLAUDE.md §RFC workflow 第 7 条要求：凡**关闭或收缩既有能力**的 RFC 必须逐项列出并呈用户确认。
本 RFC 逐项对照如下——**没有任何一项是真实的能力收缩**，但仍逐条列出以备复核：

| #   | 改动                                                             | 方向     | 判定                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | 删 `RESOURCE_ROUTES.repos.get`                                   | 表面收缩 | **不是收缩**：删除的是一个**从来没有工作过**的声明（恒 404，实测见 A1）。删除后 `describe_resource(kind='repos')` 从「宣称支持 get 但必失败」变成「如实说没有 get」。零调用方受影响——任何依赖它的调用今天就是 404                                                                                                                                                                                  |
| C2  | `questions/:entryId/reassign` 的 `tokenAccess` `never` → `allow` | **扩张** | 属能力**开放**不是收缩。开放理由：RFC-162 后 reassign 的语义是「给问题加 / 去 designer handler 节点」（`routes/taskQuestions.ts:174-178` 的 `action` 三态），改的是 `targetNodeId`，**不碰 owner / grants / visibility**，不属 RFC-247 D5 的四种 URL 形状；同域另外四条（confirm / stage / dispatch / manual）本来就是 `allow`。它是全仓 `questions` 域唯一一条 `never` 且**没有任何注释说明理由** |
| C3  | 新增 `GET /api/workgroup-tasks/pending`                          | **扩张** | 新读端点。可见性沿用 `pendingCount` 已有的 `visibleTaskIdsOf` 过滤（`services/workgroup/room.ts:379-383`），**不新造读面**——今天同一批行已经被算出来用于计数，只是被丢掉了                                                                                                                                                                                                                         |
| C4  | `list_pending_gates` 从 2 路扩到 4 路                            | **扩张** | 返回体加字段，既有 `reviews` / `clarify` 两键逐字不变                                                                                                                                                                                                                                                                                                                                              |
| C5  | 27 个新工具                                                      | **扩张** | 每个工具的权限点与其 REST 路由声明**逐字一致**；`toolsFor()`（`mcp/tools.ts:1261-1265`）按 token 权限过滤，窄令牌看到的工具集自动收窄                                                                                                                                                                                                                                                              |

**没有任何禁用 / 拒绝分支被新增**，故 §7 第二条（禁用分支必须有测试覆盖）无对应项；
第三条（关闭判据须为可复跑的外部源码引用）无对应项（本 RFC 不引用 opencode 行为）。

## 6. 与 RFC-294 目标架构的对齐

必读裁决：`design/RFC-294-backend-layered-target-architecture/proposal.md §1 / §3` 与 `design.md`。

**本 RFC 落在哪一层**：MCP 工具表与 REST 路由表**同属 inbound transport**。
`mcp/dispatch.ts:1-23` 已经把这件事钉死——工具不碰 `services/*`，一律经
`ctx.dispatch` 走 REST 路由表，「每条授权规则只有一处实现」。

**本 RFC 承担哪一步演进**：

- 27 个新工具**全部零业务逻辑**——每个 handler 就是一次（个别两次）`ctx.dispatch`，
  与既有 26 个具名工具形状逐字一致。没有任何新的 facade、没有 cross-context import、
  没有往 `routes/` / `services/` 加新的跨域耦合。
- G4 的全域守卫产出一张**「路由 ⟷ 工具」全量映射表**。这张表恰好是 W4-A
  operation catalog 的**输入清单**：W4-A 要求「HTTP RouteMeta 与 MCP tool 映射引用同一
  operation id/handler」（`RFC-294/plan.md` W4-A，`design.md §13.1` 的
  `McpBinding = {operationId, toolName}` 一对一），而今天没有任何地方能一次说清
  「已注册的每条路由里哪些有 tool、哪些没有、为什么」。本 RFC 把它变成一份**受高水位约束的
  账本**，W4-A 落地时直接读它，而不是再审一次。

**留下的债**（显式声明，不掩盖）：

1. 本 RFC **不建** operation catalog、**不引入** `McpBinding` 类型、**不合并**
   RouteMeta 与 tool 的 handler。工具与路由仍是两份声明，靠守卫钉住一致——
   这正是 `docs/audit-backlog.md:97` 所说的「等 W4-A 时自动消解」的那部分。
2. 三类（资源域运维面）与四类（新产品域）在账本里以豁免条目存在，**它们的消解
   仍需各自立 RFC**。账本让它们可见且不可无声增长，但不代表已解决。

**偏离项**：无。本 RFC 不需要绕过 kernel、不新增临时 facade。

## 7. 用户故事

1. **本地 agent 替我把反问答完并收尾**：agent 通过 `list_pending_gates` 发现任务停在反问门
   → `get_clarify_session` 读题 → `answer_clarify(directive:'stop')` 提交并要求不再反问，
   任务继续跑。**（今天已可用，本 RFC 保持逐字不变）**
2. **本地 agent 做逐题分派**：对一轮里的部分问题先给答案封存进待下发
   （`answer_clarify(defer:true, questionIds:[...])`），其余留给同事；等齐了再
   `dispatch_task_questions` 一次性下发推进任务。**（今天 MCP 完全做不到）**
3. **本地 agent 处理卡住的任务**：`list_task_alerts` 拿到 alert →
   `list_repair_options` 拿到 option → `repair_alert` 修复。**（今天在 MCP 上是死的：
   alertId 拿不到）**
4. **本地 agent 参与工作组房间**：`list_pending_gates` 看到工作组任务在等人 →
   `get_workgroup_room` 读房间 → `post_workgroup_message` 发言或
   `confirm_workgroup_step` 确认，任务继续。**（今天 MCP 完全做不到）**
5. **本地 agent 处理融合审批**：`list_fusions` 看待批融合 → `get_fusion` 读内容 →
   `approve_fusion` / `reject_fusion`。**（今天 MCP 完全做不到）**
   （v1 这条还含 memory candidate 的人审发布，v2 移除——见 §2.2 的框：那是权限目录问题。）

6. **我不用担心下次又漏**：新域长出来而 MCP 没跟时，全域守卫当场红，
   要么补工具、要么在账本里写下一行有署名的理由。**（今天无人看管）**

## 8. 验收标准

> AC 编号在 v2 重排（删掉 `find_users` / batch-import / memory promote 三项后不留空号）。
> `plan.md §4` 的证据表逐条对应——**这两处必须同批改**，否则
> `tests/rfc-index-status-drift.test.ts` 的 AC 证据台账当场红（2026-08-26 主干实撞，
> owning commit 是本 RFC 的落档笔）。

### 一类（死路径）

- **AC-1**：`describe_resource(kind:'repos')` 不再宣称支持 `get`；`resource_write(kind:'repos',
method:'delete')` 的 note 写明「confirm 用的 `urlRedacted` 从 list 取」。变异实证：把 `get`
  加回表里 → 守卫的 `unroutedTools` 命中 → 红。
- **AC-2**：新增 `list_task_alerts`；`repair_alert` 的描述不再说「call get_task」，改为指向
  `list_task_alerts`。存在一条端到端用例：`list_task_alerts` → `list_repair_options` →
  `repair_alert` 全链走通，**全程不经网页端**。
- **AC-3**：新增 `list_repo_refs`（接 `cachedRepoId`，工具内部两跳解析 `localPath`，
  **不把绝对路径交给模型**）；存在一条用例证明 `launch_task` 的 `ref` 可以纯由 MCP 解析得到。
  第一跳查不到该 id 时抛业务拒绝 `cached-repo-not-found`（**不是** 500）。
- **AC-4**：`answer_clarify` 的描述里状态码是 **409**，`shared/schemas/clarify.ts` 的注释
  **同批订正**；断言从描述中提取的状态码**精确等于** `new ConflictError(...).status`
  （不是「不含 412」——那允许描述干脆不写状态码，见设计门 P2-5）。

### 二类（人工门）

- **AC-5**：`answer_clarify` 接受 `defer` / `questionIds` / `resubmitQuestionIds`；两条路由级
  互斥校验（`clarify-question-ids-requires-defer` / `clarify-resubmit-requires-defer`，
  `routes/clarify.ts:240-257`）在 MCP 通道上**原样生效**——两条拒绝分支各有专测。
- **AC-6**：`directive:'continue'|'stop'` 在**快通道与控制通道**上都生效，且 `stop` 按 RFC-123
  回写节点级开关；有一条用例从 MCP 侧验证 `list_clarify_directives` 能读到刚写入的 `stop`。
- **AC-7**：问题看板六工具就位，`reassign` 路由的 `tokenAccess` 已改 `allow`；非成员 PAT 调用
  `reassign` 被拒（成员门 `gateMemberEntry` 与凭据类型无关）。
- **AC-8**：工作组七工具 + 新端点 `GET /api/workgroup-tasks/pending` 就位；断言
  **`reduce(pendingRows(actor)) === pendingCount(actor)`**（逐 actor 的聚合等式，不是「两个
  HTTP 端点行集合相同」——旧端点只返回三个数字，那句话无法证伪，见设计门 P2-9/P2-3），
  覆盖 owner / stranger / admin 三种 actor、畸形 config、以及一行同时有 gate 与 delivery。
- **AC-9**：fusion 五工具就位；`list_fusions` 的 `status` 入参用 `z.enum` 收口（路由对未知值
  静默退化为「无过滤」，`routes/fusions.ts:94-97`，宽容不得传染给工具）；描述写明 **MCP 上
  始终 owner-only**——`hasResourceAclBypass` 读的 `resource-acl:bypass` 是系统域点，PAT 永不
  持有（设计门 P2-4），不得暗示存在能看全局的管理员 PAT。
- **AC-10**：`list_pending_gates` 返回 `{reviews, clarify, workgroupTasks, fusions}` 四键，
  前两键的形状与既有**逐字一致**（golden lock）；单路失败**在该路内先 `unwrap`** 后返回
  `{ok:false, error}`，不拖垮其余三路，且聚合调用的审计状态有明确定义——`Promise.allSettled`
  本身抓不到 HTTP 4xx/5xx（dispatcher 对它们返回 fulfilled，`mcp/dispatch.ts:109-121`，
  设计门 P1-10）。

### 全域守卫

- **AC-11**：守卫覆盖**运行期 `allRouteMeta()` 的全部路由**（分母不硬编码任何数字），判定
  四向 + 三维：`uncovered` / `staleExemptions` / `unroutedTools` / **权限一致性**。权限判据是
  「扣除 PAT 恒有的读权限后**精确等价**」而非子集——工具少声明权限会让它出现在 `tools/list`
  却每次调用被路由拒（设计门 P1-5）；`resource_write` 这类按参数分派的工具以
  `requiredPermissions(args)` 声明，不套用等价规则。**A1 那条缺陷必须能被 `unroutedTools`
  抓到**，有负向 fixture 证明它会红。
- **AC-12**：豁免账本按**域分组 + 组内逐条精确 `METHOD /api/x/:id` 叶子**；每组一条理由，
  五个 category（`never` / `system-point` / `system` / `not-in-scope` / `deliberate`）。
  登记进 `architecture/ledger-baselines.json`，高水位盯**叶子总数**，受
  `rfc317-ledger-highwater.test.ts` 的「逐字相等 + 只降不升」两层规则约束。
- **AC-13**：八条变异各**固化为一条永久负向 fixture**（不是一次性实跑记录，设计门 P2-9）：
  加回 `repos.get` / 删任一新工具 / 给豁免叶子加工具而不改账本 / 账本改数而不改基线 /
  写一条已不存在的叶子 / 工具权限与路由不等价 / 删 `answer_clarify` 的 `defer` /
  `pendingRows` 去掉 `visibleTaskIdsOf`。

## 9. 工具数量的正视（对 RFC-247 D11 的回应）

D11（`mcp/tools.ts:12-21`）担心的是：「11 类资源 × 4 动词 = 44 个只有名词不同的工具，
会淹没真正重要的任务工具」。本 RFC 让工具数从 **29 → 52**（v1 是 56；删掉 `find_users`、
两个 batch-import 工具与 `promote_memory` 后 23 个新工具），必须正面回应：

- **D11 反对的是"描述只差一个名词"的 CRUD 排列**，不是「一个操作一个工具」本身。
  它自己就把任务域的 13 个动词全部具名（launch / cancel / retry / resume / diagnose …），
  理由是「模型在这里花时间、错了代价大」。**人工门恰恰是同一类地方**——RFC-326 已经
  按这个逻辑给评审门补了 7 个具名工具。
- 新增的 23 个工具**没有一个是 CRUD 排列**：它们是 confirm / stage / dispatch / reassign /
  deliver / approve / reject / promote 这样的**领域动词**，每个都有自己的前置条件和失败模式。
- `toolsFor()` 按 token 权限过滤（`mcp/tools.ts:1261-1265`）：一个只读令牌看到的新工具
  只有读面那几个；只有同时持 `tasks:execute` + `skills:update` + `memory:update` 的宽令牌
  才会看到全部 52 个。**实际暴露面由令牌决定，不是 52 个恒定。**
- **但过滤不等于可理解**（设计门 P2-11）：`ALL_TOOLS` 今天把四个数组扁平合并
  （`mcp/tools.ts:1246-1252`），过滤条件只有权限。本 RFC 同批把源码按域拆组
  （task / clarify-gate / workgroup-gate / fusion-gate / resource / introspection），
  并让 `list_pending_gates` 每行返回 `{kind, id, state, nextTools}`——**模型先发现门，
  再从该门自己声明的下一步工具里选**，而不是在 52 个名字里找。

## 10. 风险

| 风险                                                                     | 处置                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全域守卫初次落地会暴露出更多今天没意识到的不一致                         | 这正是它的价值。落地时若发现新的 `unroutedTools`（即又一个 A1 类死路径），当场修；若是新的 `uncovered`，按四类归类后入账本                                                                                                                                                                                                                                                                    |
| 280 条豁免账本又臭又长，没人读                                           | 按**域前缀分组** + 每组一条理由，而非 280 条各写一句。高水位机制保证它只降不升                                                                                                                                                                                                                                                                                                                |
| `GET /api/workgroup-tasks/pending` 与 `pending-count` 两处可见性判定漂移 | 两者共用同一个内部候选集函数（重构 `pendingCount` 抽出 `pendingRows`，count 由 rows 派生）。AC-9 有双 actor 一致性用例                                                                                                                                                                                                                                                                        |
| 27 个新工具的描述质量参差，模型误用                                      | 每个工具的描述必须写明**前置条件**与**这一步会不会推进任务**（`dispatch_task_questions` / `confirm_workgroup_step` 会，`stage_task_question` 不会）——这是 review 的硬项。**「推进」还要分两段**：`dispatch_task_questions` 落库成功后 resume 仍可能失败，路由以 HTTP 200 带嵌套 `{resume:{ok:false}}` 返回（`routes/taskQuestions.ts:231-269`，设计门 P2-7），描述必须要求调用方检查 `resume` |

## 11. 设计门 / 实现门

按 CLAUDE.md §Codex review 双门：本 RFC 三件套写完请批前跑**设计门**，
代码改完 declare done 前跑**实现门**，findings 分「纯实现我改」与「涉及设计方向你定」两堆，
后者逐条呈用户。记录写回本文件 §12 与 `plan.md §3`。

## 12. 门记录

（待填）
