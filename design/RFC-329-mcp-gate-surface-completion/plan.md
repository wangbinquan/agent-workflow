# RFC-329 任务分解

配套：`proposal.md`（背景 / 审计总账 / 决策 D1–D8 / 验收 AC-1…AC-14）· `design.md`（技术设计 §1–§7）

## 1. 子任务

依赖标记：`←` 表示必须先完成。**v2 已按设计门 D9–D12 调整**：删掉 `find_users`、
两个 batch-import 工具、`promote_memory`；守卫加深到三维、账本改精确叶子。

### PR-A —— 死路径 + 守卫地基（先落，因为守卫会立刻暴露 A1）

| #      | 任务                                                                                                                                                                                                                                          | 触及                                                  | 依赖                   |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------- |
| **T1** | 守卫骨架：两侧推导（分母取运行期 `allRouteMeta()`，**不硬编码**）+ 四向判定 `uncovered` / `staleExemptions` / `unroutedTools` / 权限等价                                                                                                      | `tests/architecture/rfc329-mcp-surface-guard.test.ts` | —                      |
| **T2** | **工具 binding 声明化**（D10）：每个工具声明它 dispatch 的路径、能表达的 body key、`requiredPermissions(args)`；守卫据此比三维，而不是靠 recording dispatcher 的固定 `{}` 响应猜（设计门 P1-3：固定响应会让 `list_repo_refs` 第二跳永不发生） | `mcp/tools.ts` + 守卫                                 | ← T1                   |
| **T3** | 豁免账本 `MCP_SURFACE_EXEMPTIONS`：域分组 + 组内逐条精确叶子 + 五 category（`never` / `system-point` / `system` / `not-in-scope` / `deliberate`）；每条叶子必须命中现存路由                                                                   | 守卫文件                                              | ← T1                   |
| **T4** | 账本登记进高水位（盯**叶子总数**）                                                                                                                                                                                                            | `architecture/ledger-baselines.json`                  | ← T3                   |
| **T5** | **A1**：删 `RESOURCE_ROUTES.repos.get` + 改 note                                                                                                                                                                                              | `mcp/tools.ts`                                        | ← T1（守卫先红，再修） |
| **T6** | **A2**：新增 `list_task_alerts`；修 `repair_alert` 描述                                                                                                                                                                                       | `mcp/tools.ts`                                        | ← T2                   |
| **T7** | **A3**：新增 `list_repo_refs`（两跳，接 `cachedRepoId`，第一跳缺 id → `cached-repo-not-found`）                                                                                                                                               | `mcp/tools.ts`                                        | ← T2                   |
| **T8** | **A4**：`answer_clarify` 描述 412→409 **+ 同批订正 `shared/schemas/clarify.ts:137-142` 的注释** + 状态码精确相等断言                                                                                                                          | `mcp/tools.ts`、`shared/schemas/clarify.ts`、测试     | —                      |
| **T9** | PR-A 测试：`rfc329-mcp-dead-paths.test.ts` + 变异 fixture ①②③④⑤⑥                                                                                                                                                                              | 测试                                                  | ← T5–T8                |

### PR-B —— 人工门完整面

| #       | 任务                                                                                                                                                                   | 触及                                                                   | 依赖           |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------- | ----- |
| **T10** | `answer_clarify` 扩 `defer` / `questionIds` / `resubmitQuestionIds`（binding 同批声明这三个 key，否则守卫的字段维会红）                                                | `mcp/tools.ts`                                                         | ← T2           |
| **T11** | 反问看板六工具：`list_task_questions` / `raise_task_question` / `confirm_task_question` / `reassign_task_question` / `stage_task_question` / `dispatch_task_questions` | `mcp/tools.ts`                                                         | ← T2           |
| **T12** | **REST**：`routes/taskQuestions.ts` 的 reassign `tokenAccess` `never`→`allow` + 理由注释                                                                               | `routes/taskQuestions.ts`                                              | ← T11          |
| **T13** | 开关与草稿三工具：`list_clarify_directives` / `set_clarify_directive` / `save_clarify_draft`（后者描述写明同题 **later-writer-wins**，设计门 P2-6）                    | `mcp/tools.ts`                                                         | ← T2           |
| **T14** | **REST**：`pendingCount` 重构出 `pendingRows`（补 `name` 投影与逐任务 `pendingDeliveries`——今天两者都没有），count 由 rows 派生，既有返回体逐字不变                    | `services/workgroup/room.ts`                                           | —              |
| **T15** | **REST**：新增 `GET /api/workgroup-tasks/pending`                                                                                                                      | `routes/workgroupTasks.ts`                                             | ← T14          |
| **T16** | 工作组七工具；描述区分「dispatch 已提交」与「resume 成功」（P2-7）                                                                                                     | `mcp/tools.ts`                                                         | ← T15, T2      |
| **T17** | fusion 五工具；`status` 用 `z.enum` 收口；描述写明 MCP 上恒 owner-only                                                                                                 | `mcp/tools.ts`                                                         | ← T2           |
| **T18** | `list_pending_gates` 扩四路：每路**先 `unwrap` 再** settle，返回 `{ok,data                                                                                             | error}`；定义聚合审计状态；每行带 `{kind,id,state,nextTools}`（P2-11） | `mcp/tools.ts` | ← T15 |
| **T19** | **源码按域拆组**：`ALL_TOOLS` 的扁平合并改为 task / clarify-gate / workgroup-gate / fusion-gate / resource / introspection 六组                                        | `mcp/tools.ts`                                                         | ← T16–T18      |
| **T20** | PR-B 测试：clarify / workgroup / fusion / pending-gates 四个测试文件 + 变异 fixture ⑦⑧                                                                                 | 测试                                                                   | ← T10–T19      |
| **T21** | e2e：`e2e/rfc329-mcp-gate-surface.spec.ts`                                                                                                                             | e2e                                                                    | ← T20          |
| **T22** | 账本收敛：新工具覆盖的叶子从豁免账本移出，`ledger-baselines.json` 基线**下调**                                                                                         | 账本                                                                   | ← T19          |

### 收尾

| #       | 任务                                                                                                                                                                                                                                                                                                                                                                          |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T23** | `docs/audit-backlog.md` 销账：第 98 行（clarify defer 半边）标 ✅ 注明 RFC-329；第 97 行保持 ⏳ 但补一句「人工门部分已由 RFC-329 以具名工具补齐，剩余为三类资源域运维面」；**新增三条挂账**：`find_users`（`users:search` 是系统域点）、memory candidate 审批（`resource-acl:bypass` 是系统域点）、batch-import 两端点无 owner 门（与既有 :88 行合并）                        |
| **T24** | `design/plan.md` 索引状态更新；`STATE.md` 完工后移入已完成表                                                                                                                                                                                                                                                                                                                  |
| **T25** | `docs/dev-gotchas.md` 沉淀三条：①MCP 表可以声明一条**不存在**的路由且无人发现（A1）；②判断「PAT 能不能到达一条路由」必须同时看 `tokenAccess` **与**权限点是否在 `SYSTEM_DOMAIN_POINTS`——只看前者会造出必死的工具（本 RFC 设计门实撞）；③新 RFC 只要同时有 AC 列表与证据表，就必须在 `AC_EVIDENCE_GAP` 台账登记，**缺口为 0 也要登记**（2026-08-26 本 RFC 落档笔实撞推红主干） |

## 2. PR 拆分建议

**两个 PR**，理由是 PR-A 的守卫必须先落地——它是**发现 A1 的那台机器**，先有机器再修 bug，
才能证明机器管用（变异实证 ① 就是把 A1 加回去看它红）。

- **PR-A**（T1–T9 + T25）：守卫 + 账本 + 五条死路径。**这个 PR 自身就有独立价值**——
  即使 PR-B 因故延后，全域守卫与死路径修复也已经在保护主干。
- **PR-B**（T10–T24）：27 个工具里剩下的 22 个 + 两处 REST 改动 + 账本收敛 + 销账。

两个 PR 都直接推 `main`（本仓禁分支），commit message 前缀
`feat(mcp): RFC-329 ...`，推完立刻按 exact SHA 查 CI 盯到绿。

## 3. 门记录

### 设计门（Codex，请批前）

（待填）

### 实现门（Codex，declare done 前）

PR-A：（待填）
PR-B：（待填）

## 4. 验收清单

逐条对应 `proposal.md §8` 的 AC-1…AC-13，每条填**证据**（测试文件:用例名 / 实测输出）。

> **这张表与 proposal 的 AC 列表必须同批改。** `tests/rfc-index-status-drift.test.ts` 的
> `AC_EVIDENCE_GAP` 台账按「measured 与台账逐字相等」判定：新增 AC 不补证据行 ⇒ 缺口变大 ⇒ 红；
> 补齐了也要把台账一起改小。RFC-329 已登记为 `0`，**任何一条 AC 没有对应行都会立刻红**
> ——2026-08-26 主干实撞，owning commit 就是本 RFC 的落档笔。

| AC    | 内容                                                                                      | 证据 |
| ----- | ----------------------------------------------------------------------------------------- | ---- |
| AC-1  | `describe_resource(kind:'repos')` 不再宣称 get；note 说明 confirm 取值来源                | 待填 |
| AC-2  | `list_task_alerts` → `list_repair_options` → `repair_alert` 全链走通，不经网页端          | 待填 |
| AC-3  | `list_repo_refs` 两跳解析；`launch_task` 的 `ref` 可纯由 MCP 得到；第一跳缺 id 抛业务拒绝 | 待填 |
| AC-4  | `answer_clarify` 描述状态码精确等于 `ConflictError.status`；shared schema 注释同批订正    | 待填 |
| AC-5  | `defer` / `questionIds` / `resubmitQuestionIds` 可用；两条互斥拒绝分支在 MCP 通道生效     | 待填 |
| AC-6  | `directive` 在快 / 控两通道都生效；stop 回写节点开关且可被 `list_clarify_directives` 读回 | 待填 |
| AC-7  | 看板六工具就位；`reassign` 路由改 `allow`；非成员 PAT 被拒                                | 待填 |
| AC-8  | 工作组七工具 + 新端点；逐 actor 的 `reduce(pendingRows) === pendingCount` 聚合等式        | 待填 |
| AC-9  | fusion 五工具；`status` 用 `z.enum` 收口；描述写明 MCP 上始终 owner-only                  | 待填 |
| AC-10 | `list_pending_gates` 四键 + 前两键 golden lock；单路先 `unwrap` 后返回错误、不拖垮其余    | 待填 |
| AC-11 | 守卫分母取运行期 `allRouteMeta()`；四向 + 权限等价；A1 负向 fixture                       | 待填 |
| AC-12 | 豁免账本域分组 + 精确叶子 + 五 category；高水位盯叶子总数                                 | 待填 |
| AC-13 | 八条变异各固化为一条永久负向 fixture                                                      | 待填 |

## 5. 显式登记的「本 RFC 不解决」

写在这里，避免被后来者误读为已收口。**前三条是设计门查出来的、v2 新增的**。

1. **`launch_task` 的 `collaboratorUserIds` 在 MCP 上仍无解**（设计门 P1-1，D11）。
   `GET /api/users/search` 与 `POST /api/users/lookup` 都要 `users:search`，而它在
   `SYSTEM_DOMAIN_POINTS`（`shared/schemas/permission.ts:808`）里被
   `resolveTokenPermissions` 显式剔除（同文件 `:1293-1301`）——**任何 PAT 都不可能持有**。
   补工具解决不了：声明该权限则工具永不出现在 `tools/list`，声明空权限则每次调用恒 403。
   **真因是权限目录**。修法方向：新增一个可授予 PAT 的窄点（如只回公开字段的
   `users:lookup:minimal`）并进令牌矩阵——那是跨 RFC 的面（连带 UI 与文档），另立。
2. **memory candidate 的人审发布在 MCP 上不可做**（设计门 P1-6，D11）。
   `POST /api/memories/:id/promote` 本身 PAT 可达，但**发现 candidate 需要
   `resource-acl:bypass`**——`routes/memories.ts:139-143` 对非 bypass 者过滤掉全部
   `status='candidate'` 行，而该点同样是系统域点（`permission.ts:846`）。只补 promote
   工具会造出「看不到却能对已知 id 下决定」的形状，与「可发现、可读、可处置」矛盾。
   修法方向同上：一个可授予 PAT 的 `memory:candidate:decide` 类窄点，并统一
   list / get / promote 的判据。
   **附带一条既有缺陷**（设计门 P1-7，本 RFC 不修）：promote 路由先在事务外
   `loadManagedMemory`（`routes/memories.ts:55-71,313-332`），最终事务只重查 memory 状态、
   **不重查当前 scope owner/grant**（`services/memory.ts:330-350`）——撤权或 owner 转移
   可以夹在检查与提交之间。它今天就存在于网页端路径，不因本 RFC 而恶化。
3. **batch-import 的进度查询与失败行重试没有 owner 门**（设计门 P1-8，D12；
   与 `docs/audit-backlog.md:88` 合并）。`GET /api/cached-repos/imports/:batchId` 与
   `POST .../rows/:rowId/retry` 只按 batch/row id 操作、**不读 actor**
   （`routes/cached-repos.ts:188-243`）。general PAT 今天走 REST 已能读 / 重试他人批次；
   `mcp_only` PAT 被 purpose 门挡着（`routes/registry.ts:188-193`），而 MCP dispatch
   按 RFC-247 D2 清除 purpose（`mcp/dispatch.ts:125-139`）——**补工具会把这个已知无门的
   跨用户能力第一次推给自动化通道**。判定读点 `batchOwnerUserId` 已就位，接线是小改，
   但收紧属能力收缩，须按 CLAUDE.md §7 呈用户逐项确认后另行落地。因此本 RFC
   **既不补工具、也不加门**，只如实登记。
4. **三类（资源域运维面）**：skills 内容面 11 条、workflows validate、四类 rename、
   copy、`cached-repos refresh`、mcps probe + runtime-test 9 条、`GET .../acl` 读面、
   `scheduled-tasks run-now`、memory archive / unarchive / promote、`POST /api/fusions`
   （发起融合，是**发起**不是**门**，与 `launch_task` 同类）。
   全部在豁免账本 `not-in-scope` 组里，等后续 RFC。
5. **四类（新产品域）**：`/api/code`(72)、`/api/digital-employee*` 家族（**含
   `/api/employee-cases/*`**）、`/api/event-center`、`/api/integrations`、
   `/api/webhook-*`、`/api/resource-packages`、`/api/execution-contracts`。
   同上入账本，**本 RFC 只让它们可见、不给工具**。
   （v2 补：v1 的清单漏了 `/api/employee-cases/*`，设计门 P2-8。）
6. **61 条结构不可达路由不在任何一类里**（`proposal.md §2.5`）：它们进账本的
   `system-point` 组，理由统一为「权限点在 `SYSTEM_DOMAIN_POINTS`，PAT 永不持有」。
   给它们做工具没有意义，**不是待办**。
7. **RFC-294 W4-A 的 operation catalog** 未建。T2 的工具 binding 是它的雏形但不是它：
   本 RFC 不引入 `McpBinding` 类型、不合并 RouteMeta 与 tool 的 handler、不建 operation id
   注册表。守卫钉住两侧一致，catalog 留给 W4-A。
