# RFC-324 资源授权分档（只读 / 可编辑）—— plan

## 1. 状态

- 当前：**Implementation Complete / 待发布与 hosted CI**
- 研究基线：`main@d50ac65f2`（2026-08-25）；实现在同一棵共享树上完成
- 实现许可：**已取得**（2026-08-25 用户回复「批准」）
- 澄清：用户三轮裁定 D1～D15（见 `proposal.md §5`）
- 共享树：本仓多 session 并发（同期有 RFC-325 在改前端 Select），提交一律按路径精确
  `git add` + `git commit -- <paths>`；`test-results/` 是并发 session 的 Playwright 产物，不动它

## 2. 任务分解

### Phase A —— 判据内核与数据模型（其余全部 Phase 的前置）

- [x] **RFC-324-T1** migration `0209_rfc324_grant_levels.sql`：`resource_grants.level TEXT NOT NULL
DEFAULT 'read'`、`scheduled_tasks.acl_revision INTEGER NOT NULL DEFAULT 0`。零 CHECK 变更
      （`resource_type` / `role` 值域扩展是纯类型层，design §2.1）。
- [x] **RFC-324-T2** shared 契约：`ResourceGrantLevelSchema` / `ResourceAccessSchema` /
      `GRANT_RESOURCE_TYPES` / `GrantResourceType`；`ResourceAclSchema.grants + canEdit`、
      `UpdateResourceAclBodySchema.grants`、`TaskCollaboratorRoleSchema += 'observer'`、
      `TaskMembersSchema.members + canOperate`、`UpdateTaskMembersBodySchema.members`。
- [x] **RFC-324-T3** 新建 `packages/backend/src/services/resourceAccessPolicy.ts`（纯函数，零 Drizzle
      import）：`resolveResourceAccess` / `canViewAccess` / `canEditAccess` / `canGovernAccess` /
      `assertNameUnchangedForEditor`。**同批交付 T-EQ 等价性测试**（design §13）。
- [x] **RFC-324-T4** `services/resourceAcl.ts` IO 层：grant 读取改返 `Map<string, ResourceGrantLevel>`；
      新增 `canEditResource(InTx)` / `requireResourceEdit` / `resolveResourceAccessFor`；
      `isResourceOwner → canGovernResource`、`requireResourceOwner → requireResourceGovern` 全仓改名；
      403 码分流为 `resource-read-only` / `resource-govern-owner-only`。
- [x] **RFC-324-T5** `getResourceAcl` / `updateResourceAcl`：`grants` 全量替换写入 `level`、
      owner 转移时前任 owner 落 `read`、响应补 `canEdit`；CAS 与 `afterWriteInTx` 形状不变。

### Phase B —— 13 类资源写门分流（依赖 A）

按 design §4 的分类表逐条改，**改完后全仓不得残留 `requireResourceOwner` 旧名**（改名本身由类型系统兜底）。

- [x] **RFC-324-T6** agent（`routes/agents.ts:272,301,429`）+ workflow
      （`services/workflow.ts:1008-1051`，preflight 与 in-tx 两处）。
- [x] **RFC-324-T7** skill：`routes/skills.ts:229,302,372,406,494` + `services/skill-zip.ts:427,547` + `services/skillVersion.ts` 的 owner 围栏注释与参数语义对齐（`saveSkillWithToken` 的
      `existing.ownerUserId` 是"授权时看到的 owner"，不是"actor 即 owner"，改档位后语义不变但注释要更新）。
- [x] **RFC-324-T8** mcp（`routes/mcps.ts:381,417,455`）+ plugin（`routes/plugins.ts:51-58` 的
      `loadFreshOwned` 拆成 `loadFreshEditable` / `loadFreshGovernable`，`:244` 归 editable）。
- [x] **RFC-324-T9** workgroup（`routes/workgroups.ts:195,215,250` + `services/workgroups.ts:857`）+ capability_template（`routes/capabilityTemplates.ts:160,204,244`）。
- [x] **RFC-324-T10** 五类研发配置资源（`routes/developmentConfig.ts:267-284` helper 拆两版）+ employee_definition（`routes/digitalEmployees.ts:100-107` helper 拆两版，**publish 归 edit**，D8）。
- [x] **RFC-324-T11** 名字不变校验接入全部内容写路由（事务内对 in-tx `cur.name` 比对，design §5）；
      `services/fusion.ts:567,1228` 与 `services/memory.ts:816` 改走 `canEditResource`（D9）。

### Phase C —— 任务与定时任务（依赖 A，与 B 可并行）

- [x] **RFC-324-T12** `services/taskCollab.ts`：新增 `hasActingMembership`，`requireTaskMember` 改走它；
      新增 `requireTaskOperator`；成员写入 dedupe（同 user 单行、取高档），读取取高档。
- [x] **RFC-324-T13** 任务操作面接入：`routes/tasks.ts` 的 cancel `:400` / resume `:778` /
      diagnose `:736` / clear-recovery-suspension `:713` / change-narrative POST `:523` 追加
      `requireTaskOperator`；`getTaskMembers` / `updateTaskMembers` 走新 wire。
- [x] **RFC-324-T14** 定时任务：`resolveScheduleAccess`（design §7.2）；读面接入任意档 grant，
      写面（改 cron / 启停 / 立即运行）改 edit 门，删除保持 govern。
- [x] **RFC-324-T15** 新增 `GET/PUT /api/scheduled-tasks/:id/acl`（`scheduled-tasks:read` /
      `scheduled-tasks:update`，`tokenAccess: 'never'`，走 `acl_revision` CAS，响应不含 visibility）。

### Phase D —— 前端（依赖 A 的 wire；T17 必须与 T5 同批上线，否则面板保存 payload 不匹配）

- [x] **RFC-324-T16** `hooks/useResourceAccess.ts`：复用 `GET {base}/acl` 与 `AclPanel` 同一 query key；
      daemon-token 模式返回 `canEdit: true`（现状语义）。
- [x] **RFC-324-T17** `components/AclPanel.tsx`：逐行档位 `<Segmented>`（复用既有原语，禁止自写 radio 组）、
      新加成员默认只读、管理员行提示、执行面资源的可编辑风险提示。
- [x] **RFC-324-T18** 7 个单资源详情页只读态（agents / skills / mcps / plugins / workgroups /
      code.config.detail / code.policies.$id）：`canUpdate = 权限点 ∧ canEdit`、
      `canDelete = 权限点 ∧ canManage`，底下所有 `canUpdate &&` 分支（表单 disabled、
      保存/删除/改名入口）一并收敛。**`digital-employees.$typeRef` 不在其列\*\*：它是类型页、
      不对应单一 ACL 行，见 design §14 X9。
- [x] **RFC-324-T19** `routes/workflows.edit.tsx` 只读态：画布三 flag 关闭、Inspector 只读、
      **自动保存整条禁用**（`healLoadedDefinition` 首发写必须不发出）、另存为副本入口。
- [x] **RFC-324-T20** 错误码 i18n（`resource-read-only` / `resource-govern-owner-only` /
      `resource-rename-owner-only`，中英各一条）+ `workflows.edit.tsx:1400` 的 `isWorkflowAccessLoss`
      把 403 从"访问丢失"分支剥离。
- [x] **RFC-324-T21** 任务成员面板：观察者 / 协作者两档 + `canOperate` 驱动的操作按钮禁用。

### Phase E —— 测试与收口

- [x] **RFC-324-T22** 后端测试：`rfc324-access-policy-equivalence`（872 断言的穷举等价性）、
      `rfc324-grant-level-matrix`、`rfc324-task-observer`、`rfc324-scheduled-task-acl`、
      `rfc324-memory-editor-grant`、`rfc324-acl-wire-contract` 六个新文件（45 例），
      外加 `rfc317-config-resource-write-gate` 补的 5 条 write 档用例与架构守卫新增的 2 条规则。
      与 design §13 表的出入：改名拒绝与 wire 契约合并进 `rfc324-acl-wire-contract` /
      `rfc324-grant-level-matrix`；bypass 不变由等价性穷举覆盖（比单独一个文件更强）。
- [x] **RFC-324-T23** 前端测试：`rfc324-acl-panel-levels.test.tsx`（档位控件 + hook 的乐观/严格
      双语义，8 例）、`rfc324-editor-readonly-source-lock.test.ts`（编辑器三处接缝的源码锁，5 例）。
- [x] **RFC-324-T24** `e2e/rfc324-graded-grants.spec.ts`：只读态 + 零自动保存 + 升档/降档两个方向
      的不刷新收敛。**做的过程中发现 AC-15 原本不成立**，补了 `resource-acl.changed` 控制帧这条
      缺失的通道（design §12），并被 e2e 逼出两处修正——`useResourceAccess` 不再与 `AclPanel`
      共享 query key（design §10.1）、权限面板入口不跟着 `canUpdate` 收紧（design §14 X10）。
- [x] **RFC-324-T25** 文档收口：`design/plan.md` RFC 索引登记；`STATE.md` 顶部进行中 → 完工后移入已完成表；
      `docs/audit-backlog.md:108` 与 `:489-499` 两条**标记为已修并注明本 RFC**（不删除历史记录）。
- [ ] **RFC-324-T26** Codex 实现门（declare done 前）+ push 后按 exact SHA 盯 CI 到绿 —— **待做**。

## 3. 依赖图

```
T1 ─┐
T2 ─┼─► T3 ─► T4 ─► T5 ─┬─► T6…T11 (Phase B)
    │                    ├─► T12…T15 (Phase C)
    │                    └─► T16 ─► T17 ─┬─► T18 / T19 / T21
    │                                     └─► T20
    └─────────────────────────────────────────► T22…T24 ─► T25 ─► T26
```

## 4. 提交批次建议

本仓只在 `main` 上开发、不建分支不开 PR（CLAUDE.md 硬规则），因此"PR 拆分"落为**提交批次**。
wire 是破坏性变更，**批次 1 必须前后端同批**，否则 main 上会出现前端保存 payload 与后端 schema 不匹配的窗口。

| 批次   | 内容                                                                | 判据                               |
| ------ | ------------------------------------------------------------------- | ---------------------------------- |
| 批次 1 | Phase A + T17（面板 payload 跟随）+ T22 的 T-EQ / wire 两个测试文件 | 迁移前后判定零变化；面板能保存两档 |
| 批次 2 | Phase B + 对应矩阵测试                                              | 13 类写门分流全绿                  |
| 批次 3 | Phase C + 任务 / 定时任务测试                                       | observer 与定时任务两档全绿        |
| 批次 4 | Phase D 剩余（T16/T18/T19/T20/T21）+ 前端测试 + e2e                 | 只读态与文案分流全绿               |
| 批次 5 | T25 文档 + T26 实现门与 CI 收口                                     | exact SHA CI 全绿                  |

每批 push 后立刻按自己的 exact SHA 查 CI，红了当批修或 revert 自己那笔（CLAUDE.md §Test-with-every-change）。

## 5. 验收清单（对账实际交付）

- [x] **AC-1 / AC-16** —— `rfc324-access-policy-equivalence.test.ts`：72 组合 × 4 条断言的穷举，
      把旧 `isVisibleRow` / `isResourceOwner` 逐字誊为 oracle 对拍。bypass 分支在每一组合里都被
      对拍到，因此不需要单独的 bypass 文件（比原计划更强）。
- [x] **AC-2 / AC-3** —— `rfc324-grant-level-matrix.test.ts`（agent / workflow 两种结构）+ `rfc317-config-resource-write-gate.test.ts` 新增的 5 类研发配置 write 档用例。
- [x] **AC-4** —— `rfc324-grant-level-matrix.test.ts` 的 workflow 改名组（含「改名被拒时同一 body
      里的内容也一起回滚」）。
- [x] **AC-5 / AC-6** —— `rfc324-acl-wire-contract.test.ts`。
- [x] **AC-7 / AC-8** —— `rfc324-task-observer.test.ts`。
- [x] **AC-9 / AC-10** —— `rfc324-scheduled-task-acl.test.ts`。
- [x] **AC-11** —— `rfc324-memory-editor-grant.test.ts`。
- [x] **AC-12** —— `rfc324-acl-panel-levels.test.tsx`。
- [x] **AC-13** —— `rfc324-editor-readonly-source-lock.test.ts`（编辑器三处接缝）+ `rfc324-acl-panel-levels.test.tsx` 的 hook 语义组。详情页只读态由类型系统保证
      （`canUpdate` 是那些页面所有写入口的唯一开关），未单独写渲染测试。
- [x] **AC-14** —— 三条错误码的中英文案随 T20 落地；工作流编辑器的 403 分流由源码锁覆盖。
- [x] **AC-15** —— `e2e/rfc324-graded-grants.spec.ts`（升档与降档两个方向都不刷新页面）+ `rfc212-revalidation-behavior.test.ts` 的发帧两条。
- [x] **AC-17** —— 既有 `rfc099-*` / `rfc170-*` / `rfc223-*` / `rfc203` / `rfc271` / `rfc282` /
      `rfc317` / `fusion` / `task-collab` 等套件按 wire 变更更新后全绿。

## 6. 风险与工作量

| 项              | 评估                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 后端改动面      | 判据内核 2 文件 + 约 25 处写门站点（design §4 已逐条列出锚点），改名由类型系统兜底，风险低                                 |
| wire 破坏性变更 | 三个端点（两个 `tokenAccess: 'never'`），影响面限本仓前端；批次 1 前后端同批可控                                           |
| 前端只读态      | 8 个详情页 + 1 个编辑器，是本 RFC 工作量最大的一块；`workflows.edit.tsx` 的自动保存链路最需小心                            |
| 迁移风险        | 两条 `ADD COLUMN ... DEFAULT`，SQLite 原生支持、不重建表；存量语义零变化                                                   |
| 最大不确定性    | `workflows.edit.tsx` 的 `healLoadedDefinition` 自动保存链路是否有第二条触发路径——实现时须实测"只读打开编辑器，零 PUT 请求" |

## 7. 未完成项与去向

- **`digital-employees.$typeRef` 的逐卡只读态**（design §14 X9）：后端写门已按档位生效，缺的只是
  该页面的视觉只读态。它是**员工类型**页、一页对多行 ACL 资源，`useResourceAccess` 的「一页一资源」
  形状套不上，需要逐卡判定——留给数字员工侧的下一个 RFC。

## 8. e2e 逼出来的三件事（写在这里，因为它们都不是设计时能想到的）

1. **AC-15 原本不成立。** 设计里写「`resource-acl-changed` 重校验一到就同时收敛」——查过才知道
   RFC-212 的重扫只回答「这条连接还能不能留着」，对**降档**（仍然看得见）什么也不做。补了
   `resource-acl.changed` 控制帧（design §12）。**没有 e2e 就不会发现**：所有单测都在链条的一端。
2. **共享 query key 是错的耦合。** `useResourceAccess` 原本复用 `AclPanel` 的 `['acl', …]` 省一次
   请求；帧到达 owner 自己的浏览器时把面板的编辑态快照打成 `fetching`，绊倒它的管理会话守卫，
   owner 每次保存权限弹窗都不关闭。
3. **收紧 `canUpdate` 会连坐权限面板入口。** 第一版把 ACL 入口也挂在收紧后的 `canUpdate` 上，
   被授权者从此看不到自己是以什么档位被授权的——`rfc099-ownership-acl` 的既有 e2e 当场变红。
