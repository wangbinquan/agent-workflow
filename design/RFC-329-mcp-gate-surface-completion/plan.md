# RFC-329 任务分解

配套：`proposal.md`（背景 / 审计总账 / 决策 D1–D8 / 验收 AC-1…AC-14）· `design.md`（技术设计 §1–§7）

## 1. 子任务

依赖标记：`←` 表示必须先完成。

### PR-A —— 死路径 + 守卫地基（先落，因为守卫会立刻暴露 A1）

| #      | 任务                                                                                                            | 触及                                                  | 依赖                   |
| ------ | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------- |
| **T1** | 全域守卫骨架：两侧推导 + 四向判定（`uncovered` / `staleExemptions` / `unroutedTools` / 权限子集）+ 负向 fixture | `tests/architecture/rfc329-mcp-surface-guard.test.ts` | —                      |
| **T2** | 豁免账本 `MCP_SURFACE_EXEMPTIONS`：按域前缀分组、四个 category、每组一条理由；prefix 必须命中现存路由           | 同上                                                  | ← T1                   |
| **T3** | 账本登记进高水位机制                                                                                            | `architecture/ledger-baselines.json`                  | ← T2                   |
| **T4** | **A1**：删 `RESOURCE_ROUTES.repos.get` + 改 note（D4）                                                          | `mcp/tools.ts`                                        | ← T1（守卫先红，再修） |
| **T5** | **A2**：新增 `list_task_alerts`；修 `repair_alert` 描述                                                         | `mcp/tools.ts`                                        | —                      |
| **T6** | **A3**：新增 `list_repo_refs`（两跳，接 `cachedRepoId`）与 `find_users`（两路由一工具）                         | `mcp/tools.ts`                                        | —                      |
| **T7** | **A4**：新增 `get_repo_import` / `retry_repo_import_row`                                                        | `mcp/tools.ts`                                        | —                      |
| **T8** | **A5**：`answer_clarify` 描述 412→409 + 源码级状态码断言                                                        | `mcp/tools.ts` + 测试                                 | —                      |
| **T9** | PR-A 测试：`rfc329-mcp-dead-paths.test.ts` + 变异实证 ①②③④⑤⑥                                                    | 测试                                                  | ← T4–T8                |

### PR-B —— 人工门完整面

| #       | 任务                                                                                                                                                                   | 触及                         | 依赖      |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | --------- |
| **T10** | `answer_clarify` 扩 `defer` / `questionIds` / `resubmitQuestionIds`，`satisfies` 绑定键集（D6）                                                                        | `mcp/tools.ts`               | —         |
| **T11** | 反问看板六工具：`list_task_questions` / `raise_task_question` / `confirm_task_question` / `reassign_task_question` / `stage_task_question` / `dispatch_task_questions` | `mcp/tools.ts`               | —         |
| **T12** | **REST**：`routes/taskQuestions.ts:162` 的 `tokenAccess` `never`→`allow` + 理由注释（D3）                                                                              | `routes/taskQuestions.ts`    | ← T11     |
| **T13** | 开关与草稿三工具：`list_clarify_directives` / `set_clarify_directive` / `save_clarify_draft`                                                                           | `mcp/tools.ts`               | —         |
| **T14** | **REST**：`pendingCount` 重构出 `pendingRows`，count 由 rows 派生（返回体逐字不变）                                                                                    | `services/workgroup/room.ts` | —         |
| **T15** | **REST**：新增 `GET /api/workgroup-tasks/pending`（D5）                                                                                                                | `routes/workgroupTasks.ts`   | ← T14     |
| **T16** | 工作组七工具（描述须标注「是否推进任务」）                                                                                                                             | `mcp/tools.ts`               | ← T15     |
| **T17** | fusion 五工具                                                                                                                                                          | `mcp/tools.ts`               | —         |
| **T18** | `promote_memory`（三态 discriminatedUnion）                                                                                                                            | `mcp/tools.ts`               | —         |
| **T19** | `list_pending_gates` 扩四路 + `Promise.allSettled`（F6）                                                                                                               | `mcp/tools.ts`               | ← T15     |
| **T20** | PR-B 测试：clarify / workgroup / approval / pending-gates 四个测试文件 + 变异实证 ⑦⑧                                                                                   | 测试                         | ← T10–T19 |
| **T21** | e2e：`e2e/rfc329-mcp-gate-surface.spec.ts`                                                                                                                             | e2e                          | ← T20     |
| **T22** | 账本收敛：新工具覆盖的路由从豁免账本移出，`ledger-baselines.json` 基线**下调**                                                                                         | 账本                         | ← T19     |

### 收尾

| #       | 任务                                                                                                                                                                                                     |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T23** | `docs/audit-backlog.md` 销账：第 98 行（clarify defer 半边）标 ✅ 并注明 RFC-329；第 97 行（收敛工具只覆盖 CRUD）**保持 ⏳** 但补一句「人工门那部分已由 RFC-329 以具名工具补齐，剩余为三类资源域运维面」 |
| **T24** | `design/plan.md` RFC 索引追加一行；`STATE.md` 顶部「进行中 RFC」→ 完工后移入已完成表                                                                                                                     |
| **T25** | `docs/dev-gotchas.md`：沉淀「MCP 表可以声明一条不存在的路由且无人发现」这条通用坑（A1），以及全域守卫的存在与用法                                                                                        |

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

逐条对应 `proposal.md §8` 的 AC，每条填**证据**（测试文件:用例名 / 实测输出）。

| AC    | 内容                                                                             | 证据 |
| ----- | -------------------------------------------------------------------------------- | ---- |
| AC-1  | `describe_resource(kind:'repos')` 不再宣称 get；note 说明 confirm 取值来源       | 待填 |
| AC-2  | `list_task_alerts` → `list_repair_options` → `repair_alert` 全链走通，不经网页端 | 待填 |
| AC-3  | `launch_task` 的 `ref` / `collaboratorUserIds` 可纯由 MCP 解析                   | 待填 |
| AC-4  | batch-import → 查进度 → 重试失败行                                               | 待填 |
| AC-5  | `answer_clarify` 描述状态码为 409，且有防漂移断言                                | 待填 |
| AC-6  | `defer` 三参数可用，两条互斥拒绝分支在 MCP 通道原样生效                          | 待填 |
| AC-7  | `directive` 在快 / 控两通道都生效，stop 回写节点开关且可读回                     | 待填 |
| AC-8  | 看板六工具就位，`reassign` 路由已改 `allow`                                      | 待填 |
| AC-9  | 工作组七工具 + 新端点；双 actor 行集合一致                                       | 待填 |
| AC-10 | fusion 五工具 + `promote_memory`                                                 | 待填 |
| AC-11 | `list_pending_gates` 四键，前两键 golden lock                                    | 待填 |
| AC-12 | 守卫覆盖全部 440 条路由，四向判定 + A1 负向 fixture                              | 待填 |
| AC-13 | 豁免账本逐组带理由并登记高水位                                                   | 待填 |
| AC-14 | 变异实证 ①–⑧ 全部实跑并确认转红                                                  | 待填 |

## 5. 显式登记的「本 RFC 不解决」

写在这里，避免被后来者误读为已收口：

1. **`GET /api/cached-repos/imports/:batchId` 与 `.../rows/:rowId/retry` 的门未收紧**
   （`docs/audit-backlog.md:88`：token-only，任何持凭据者可读 / 可重试他人批次）。
   本 RFC 只把**已经对令牌开放**的能力如实暴露为工具，**不认可也不加固**这个门。
   收紧属能力收缩，须另行按 CLAUDE.md §7 呈用户逐项确认。
2. **三类（资源域运维面）**：skills 内容面 11 条、workflows validate、四类 rename、
   copy、refresh、mcps probe + runtime-test 9 条、`GET .../acl` 读面、
   `scheduled-tasks run-now`、memory archive / unarchive、`POST /api/fusions`。
   全部在豁免账本 `not-in-scope` 组里，等后续 RFC。
3. **四类（新产品域）**：`/api/code`、`/api/intent-sessions`、`/api/digital-employee*`、
   `/api/event-center`、`/api/integrations`、`/api/webhook-*` 共 ~200 条。
   同上入账本，**本 RFC 只让它们可见、不给工具**。
4. **RFC-294 W4-A 的 operation catalog** 未建。工具与路由仍是两份声明，靠守卫钉一致。
