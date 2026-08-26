# RFC-330 数字员工域授权面补齐 —— plan（v7，功能核心版）

## 1. 状态

- 当前：**v7 已批准（2026-08-26）→ 已实现**；T1～T21 单批落地，CI 按 exact SHA 盯绿
- 研究基线：`main@da777913a`（2026-08-26；本 RFC 取迁移 0211）
- 澄清：用户 2026-08-26 六轮（`proposal.md §5` D1～D4、D16～D23、D17′）；D5～D9、D11～D14 为按先例的默认裁定，随本 RFC 呈批
- 能力影响：`proposal.md §6` I1～I19 须逐项确认；§4 给 I↔T 对照
- 共享树：并发 session 仍在工作树里改前端 / 架构文件；提交一律按路径精确 `git add` + `git commit -- <paths>`，共享索引文件只加自己的行
- PR 形态：**单个原子 PR**；实现门按 `CLAUDE.md` §工作准则「双门不审安全」跑，只审功能自洽与拍板漂移

## 2. 任务分解

### Phase A —— 数据模型与内核登记（其余 Phase 的前置）

- [x] **RFC-330-T1** 迁移 `0211_rfc330_employee_authoring_acl.sql`（design §2.1：三列 + `json_valid` 回填 + 模版分区索引 + `employee_case_members`）+ drizzle schema + `_journal.json`。
      **同批 `rfc330-migration-backfill.test.ts`。**
- [x] **RFC-330-T2** shared：`ACL_RESOURCE_TYPES` += 两项；`MembersSchema`（含 `canManage` / `canOperate`）+ `CaseMembersSchema` / `UpdateMembersBodySchema`（含 `ownerUserId?`；
      `TaskMembersSchema` wire 不变）；`TasksListWsMessageSchema` += `employee-case.members.changed`；核对 / 补齐 `canEditAccess` / `canGovernAccess` 导出。
- [x] **RFC-330-T3** kernel：`resource_grants` 枚举、`ACL_TABLES`、`OWNER_NAME_UNIQUE_TYPES` → `OWNER_NAME_UNIQUE_PARTITIONS`（design §3.5，含 `employee_definition`，D-①）、
      转移预检 / in-tx select 按分区扩展、`ACL_PERMISSION_PREFIX`；新增 `loadGrantLevelsForUser` + `projectVisibleRowsWithAccess`（§3.4）。**同批 `rfc223-owner-transfer.test.ts` 分区用例。**
- [x] **RFC-330-T4** 模块记录与视图：`ToolDraftRecord` / `JobTemplateRecord` 带列；`toTool` / `toJobTemplate` / `createTool` / `createJobTemplate` / `updateToolValidation` 同步；
      平台工具投影 `builtin: true`；三个 View += `visibility` / `ownerUserId`；窄查询 `getToolAccessRow` / `getToolAclMountRow` / `getJobTemplateAccessRow` /
      `getJobTemplateAclMountRow` / `getCaseAccessRow` / `getCaseMemberRole`（§3.3）。
- [x] **RFC-330-T5** 自动升级（D18′ / §3.6）：successor 建行带 source 的 `ownerUserId` / `visibility`；grants 不复制；重入与命名沿用今天。**同批 `rfc310-type-package-auto-upgrade.test.ts` 的 RFC-330 用例（D18′ 继承 + D17′ 命名）。**

### Phase B —— 工具 / 模版路由（依赖 A）

- [x] **RFC-330-T6** 工具路由：`loadVisibleTool` / `requireEditableTool` / `requireGovernableTool`；`GET :toolId` → view、`POST` → private 默认 + `name`、`PUT` → edit +
      显示名围栏、`validate` / `publish` → edit、`retire` → govern；列表走 `projectVisibleRowsWithAccess`。
- [x] **RFC-330-T7** 模版路由：`loadVisibleJobTemplate` / `requireEditableJobTemplate`；`POST` → private 默认、`PUT` → edit + 名字围栏、`publish` → edit；列表走 `projectVisibleRowsWithAccess`；
      三个员工列表同样改走 `projectVisibleRowsWithAccess`。
- [x] **RFC-330-T8** `mountAclEndpoints` ×2 + `contracts/registry.ts` + `api-contract-coverage` 精确清单 + `rfc099-acl-endpoints-matrix` 两行。**同批 `rfc330-tool-template-acl-matrix.test.ts`。**

### Phase C —— 案例侧（依赖 A；与 B 可并行）

- [x] **RFC-330-T9** 成员命令与查询：从 `updateTaskMembers` 抽出共用 normalization helper（last-wins / active / 非系统 / owner 不进行 / 前任降 collaborator）；store
      `updateCaseMembers`（含 owner 转移，D20，`db.transaction`）/ `getCaseMembers`；`decodePolicyUpgradePreviewToken` 共用（§6.5）。
- [x] **RFC-330-T10** 路由：`loadVisibleCase` / `requireCaseOperator` / `requireCaseOwner`；`GET /:id` → view；`resume` / `terminate` / `preview` / `apply` → operator；
      `GET/PUT /members`（GET `digital-employees:read` allow；PUT `development-missions:interact` never）。**同批 `rfc330-employee-case-access.test.ts`。**
- [x] **RFC-330-T11** WS：`employee-case.members.changed` 帧 + `EmployeeCaseMembersChangedAudienceContext` + registry 分支（`ws/registry.ts:520,671` 旁）+ 前端案例页 hook 失效。

### Phase D —— 顺手修（独立，可最先落）

- [x] **RFC-330-T12** D-②：`developmentConfig.ts:635` → `requireEditable` + `assertNameUnchangedForEditor`；`rfc317-config-resource-write-gate.test.ts` 加三态。（D-① 并入 T3。）

### Phase E —— 前端（依赖 A/B/C 的 wire；同一 PR 内落地）

- [x] **RFC-330-T13** `components/digital-employees/types.ts` 三类型 += `visibility` / `access` / `ownerUserId`；判定 helper 走 shared（§7.1）。
- [x] **RFC-330-T14** 工具卡与编辑弹窗：按钮门 + 只读徽标 + 显示名 `disabled`；模版卡与编辑弹窗：同上 + owner 徽标（`ResourceBadges`）+ 空态文案（I4）。
- [x] **RFC-330-T15** 员工卡：编辑 / 配置职责门、名字 `disabled`、新建任务保持对 `read` 可用、owner 徽标；三类卡片「权限」入口对所有可见者渲染 → `<Dialog>` + `<AclPanel>`（§7.3）；
      `hooks/useWebSocket.ts:198-203` 失效三前缀（§7.4）。
- [x] **RFC-330-T16** 案例页：`TaskMembersPanel` / `TaskMembersDialogButton` 抽 `MembersPanelAdapter`（`resourceId` / `membersUrl` / `queryKey` / `responseId` / `invalidateKeys`；
      默认 = 任务行为；面板每次打开重取判定（`refetchOnMount: 'always'`））；案例适配器；案例页 header 成员入口（含转移）；恢复按钮 = 权限点 ∧ `members.canOperate`（§7.5）。
- [x] **RFC-330-T17** i18n：`digitalEmployee` 错误域 + `employee-` 前缀；新码中英文案；空态文案。**同批前端四个测试文件（design §10）。**

### Phase F —— e2e、登记、文档、门

- [x] **RFC-330-T18** `e2e/rfc330-digital-employee-acl.spec.ts`（design §10 旅程，含转移，必须打到 6 条新路由）。
- [x] **RFC-330-T19** 登记（design §3.1-B）：`rfc329McpSurfaceLedger.ts` 6 条叶子 + `EXEMPT_REASONS['/api/digital-employee-tools']`；`e2e-capability-ledger.json` 新 DE 行；
      `commons-manifest.json` `claimAudit` 计数；`bun run architecture:write` 刷新 canonical manifests，涨的账本具名 `allowGrowth`。
- [x] **RFC-330-T20** 文档：`docs/audit-backlog.md` 关闭 B91-2、记两条功能缺口（design §12 DEBT）；RFC-324 `design.md §14 X9` 标「由 RFC-330 关闭」；
      `docs/dev-gotchas.md` 补两条（只有 `owner_user_id` 的表不是权限 / 锚点按 `git show <sha>:path` 取）；`design/plan.md` 索引状态 → Done；`STATE.md` 已完成表加行。
- [x] **RFC-330-T21** 实现门：Codex 对抗评审（按路径限定本 RFC 改过的文件；`< /dev/null` 后台跑；核实 banner；**prompt 明写「安全相关一律不审、不提 findings」**），
      findings 分「纯实现我改 / 涉设计方向问用户」两堆；最后做一次「用户拍板漂移」专查（D1～D4、D17′、D18′、D19～D23 逐条对当前正文）。

## 3. 验收清单（AC → 证据；落地时逐行填）

| AC    | 证据                                                                                                                                                                                                             | 状态 |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| AC-1  | `rfc330-migration-backfill.test.ts`                                                                                                                                                                              | ✅   |
| AC-2  | `rfc330-tool-template-acl-matrix.test.ts`                                                                                                                                                                        | ✅   |
| AC-3  | 同上                                                                                                                                                                                                             | ✅   |
| AC-4  | 同上                                                                                                                                                                                                             | ✅   |
| AC-5  | `rfc330-migration-backfill.test.ts` + `rfc223-owner-transfer.test.ts`                                                                                                                                            | ✅   |
| AC-6  | `rfc099-acl-endpoints-matrix.test.ts` + `rfc330-tool-template-acl-matrix.test.ts`                                                                                                                                | ✅   |
| AC-7  | `rfc310-type-package-auto-upgrade.test.ts`（RFC-330 D18′ 用例：private / public / null-owner 三类源的 owner + visibility 继承、grants 为空）+ 同文件的 D17′ 命名用例（同 owner 同名才加后缀、异 owner 保持原名） | ✅   |
| AC-8  | `rfc330-employee-case-access.test.ts`                                                                                                                                                                            | ✅   |
| AC-9  | 同上                                                                                                                                                                                                             | ✅   |
| AC-10 | 同上                                                                                                                                                                                                             | ✅   |
| AC-11 | `rfc330-employee-case-access.test.ts`（转移 + 前任降级 + WS 受众）+ e2e 旅程转移段（admin → bob，bob 不刷新拿到管理控件）                                                                                        | ✅   |
| AC-12 | `rfc330-type-page-access-gating.test.ts`（cardControls 四档 + 三类卡片接线 + 深链三态分流）                                                                                                                      | ✅   |
| AC-13 | `rfc330-type-page-access-gating.test.ts`（含深链分流源码断言）+ `useWebSocket` 失效前缀 + e2e 升降档段                                                                                                           | ✅   |
| AC-14 | `rfc330-case-members-panel.test.tsx` + `task-members-manage-loss.test.tsx`（任务页零改动）+ e2e 成员 / 转移段；恢复按钮 = 权限点 ∧ `canOperate === true`（源码断言）                                             | ✅   |
| AC-15 | `rfc330-forbidden-copy.test.ts`                                                                                                                                                                                  | ✅   |
| AC-16 | `rfc317-config-resource-write-gate.test.ts`（write 档保存合法 playbook → 200 且落库；改名 403；read 档 403）                                                                                                     | ✅   |
| AC-17 | 两个 rfc330 矩阵的 bypass 行                                                                                                                                                                                     | ✅   |
| AC-18 | `api-contract-coverage` / `contracts/registry` / `rfc329-mcp-surface-guard` / nightly endpoint / `rfc317-ledger-highwater`                                                                                       | ✅   |

## 4. 能力影响 ↔ 任务

| I   | T                | I   | T                              |
| --- | ---------------- | --- | ------------------------------ |
| I1  | T6, T8           | I11 | T8, T15                        |
| I2  | T6               | I12 | T1, T2, T9, T10, T11, T16, T18 |
| I3  | T7, T8           | I13 | T2, T9, T10, T16, T18          |
| I4  | T6, T7, T14      | I14 | T2, T4, T8, T10, T11, T13      |
| I5  | T6, T7           | I15 | T1, T3, T14                    |
| I6  | T6, T7, T14, T15 | I16 | T12                            |
| I7  | T6               | I17 | T3                             |
| I8  | T10              | I18 | T5                             |
| I9  | T10              | I19 | T17                            |
| I10 | T14, T15         |     |                                |

未出现在表中的任务为内部（T19 登记、T20 文档、T21 门）。

## 5. 设计门 / 实现门记录

- 设计门第一轮～第五轮（2026-08-26，Codex `gpt-5.6-sol`）：r1 2/13/3；r2 3/9/2（→ D17′）；r3 1/9/2；r4 1/8/2（→ D20）；r5 0/7/1。功能类结论保留在 v7，安全 / 守卫 / 记账类随 D21 退出。
- 设计门第六轮：已启动、按 D21 / D23 中止，结果不采信。
- v7 起不再跑设计门（D23）。
- 实现门第一轮：2026-08-26 Codex `gpt-5.6-sol`，按路径限定本 RFC 改动文件、prompt 明写「只审功能；安全相关一律不审、不提」→ 0 P0 / 5 P1 / 2 P2，全部 pure-implementation：自动升级同名查找未按 owner 分区（D17′）、`/acl` 404 码带下划线、模版深链绕过档位、D17′ 后前端无 owner 区分、恢复按钮未严格 ∧ `canOperate`、新码缺精确文案、证据表虚标——全部修复并补测试。
- 实现门第二轮（闭合审计）：01 / 02 / 04 / 05 closed，03 / 06 / 07 partial + 新 1 P1（深链在权限点未就绪时被消费）/ 1 P2（文案测试经 fallback）→ 全部修复：深链三态 `requestedJobTemplateDecision`、文案测试读原始语言资源、AC-7 三类源、AC-12 证据路径、AC-16 断言 200 + 落库。
- 实现门第三轮：略——第二轮 findings 全部为纯实现项且已逐条修复并补测试；CI（干净 checkout 全量门禁 + e2e）为最终门。
