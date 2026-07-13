# RFC-178 — 任务分解

单 RFC → 按批次在 `main` 上顺序提交（本仓 main-only、无 PR 分支）。每批次五门全绿方可 push。任务编号 `RFC-178-Tn`。

## 前置：T0 基线协调（实现前，非代码）

- **T0**：确认/落定 working tree 里 RFC-170 在途未提交的 skill 改动（`packages/backend/src/services/skill.ts`、`routes/skills.ts`、`util/errors.ts`、`tests/skill-combined-save.test.ts`、`tests/skills.test.ts`、`design/RFC-170-.../IMPLEMENTATION.md`、`packages/frontend/src/routes/skills.detail.tsx` + 3 前端测试）。提交（若属本工作流可提）或与用户确认可弃，取得干净基线。**绝不覆盖他人改动**。
  - 依赖：无。产出：干净 skill 基线 + 已知并发点清单。

## 批次 A — 去 external 读者（DB/schema.ts 不动，全绿）

- **T1**：删 `services/skill-source.ts` 整文件。
- **T2**：删 `routes/skill-sources.ts` 整文件；`server.ts` 去 `mountSkillSourceRoutes` import + 调用 + `/api/skill-sources(/*)` 的 `resourcePermissionGate`。
- **T3**：`services/skill.ts` 去 external：删 `importExternalSkill`/`updateSkill`/`ensureSkillIsWritable`/`removeSkillRowAndFiles` 四函数 + 其调用点；删 `skillRoot`/`skillReadRoot`/`deleteSkill`/`saveSkillWithToken` 的 external 分支；删 `listSkills` 的 `reconcileAllSources` 调用；`rowToSkill` 去 external 投影（保留列读取到批次 B 再清）。保留 `realpathInside` 防护（注释更新）。**同批**：`cli/start.ts` 删 boot 期 `reconcileAllSources` 块（:294-305，删 skill-source.ts 后悬空 import；保留相邻 `reconcileSkillLiveFiles`）。
- **T4**：`routes/skills.ts` 删 `POST /api/skills/import-external`。
- **T5**：`services/skill-zip.ts` 去 external-conflict 分支（`computeConflictView` + `commitSkillZipBuffer`）。
- **T6**：`services/skillBootVerify.ts` 去 external 分支（`isSkillAvailableThisBoot` + `isSkillInjectableThisBoot` + `sourceState` 字段）。
- **T7**：`services/resourceAcl.ts` 去 `skill-external-transfer-blocked` 守卫。
- **T8**：`services/scheduler.ts` `resolveSkills` 去 external 分支（留 managed + project）。
- **T9**：`runtime/stageSkills.ts`（去 symlink else + `symlinkSync` import + 头注释 + `StagedSkill.sourceKind` 收窄）+ `runtime/types.ts`（`ResolvedSkill.sourceKind` 收窄）。
- **T10**：shared `schemas/skill.ts`：删 `ImportExternalSkillSchema`/`SkillAuthorityKindSchema`/全部 skill-sources schema + 类型；收窄 `SkillSourceKindSchema`→`['managed']`；`SkillSchema` 去 external 字段；ZIP conflict 枚举去 `'external'`。
- **T11**：前端删除：`components/SkillSourcesCard.tsx`（+ `skills.tsx` 挂载）、`lib/skill-capabilities.ts`（+ `skills.detail.tsx` 内联 managed 能力）。
- **T12**：前端 `routes/skills.new.tsx` 收窄两 tab（去 external/folder tab + mutation + 表单 + `EMPTY_FORM` 字段）。
- **T13**：前端 `routes/skills.detail.tsx` 去 external 分支；`routes/skills.tsx` 徽标收敛；`components/skills/ImportZipPanel.tsx` 去 `['skill-sources']` invalidation + 死 external-conflict 显示。
- **T14**：i18n `en-US.ts` / `zh-CN.ts`（值 + `Resources` 类型）删 external + source 键块 + `errors.skill-source-*`（保留 `zip*`）。
- **T15**：测试删/改（external/source-only 删；mixed 改）——**以 design §7 的 grep 权威清单为准（含 7 个漏项：`page-hint-removal`/`scheduler-depends-closure`/`import-zip-panel`/`skill-boot-verify`/`fuse-dialog-entry`/`skill-zip-import-helpers`/`rfc154-runtime-config-dir`）**。⚠️ 必须跑**前端 vitest**（`bun run test`）——本地后端 `bun test` 不覆盖前端红。`migration-0090` 是 RESTRUCTURE 见 T19。

> 依赖：T1–T15 属同批（互相牵连的编译单元）；一次或少数几次提交落地，每次五门绿。`skills` DB 列此时仍在但无读者。

## 批次 B — 迁移 + schema.ts 列删（原子，全绿）

- **T16**：写 `packages/backend/db/migrations/0092_rfc178_remove_external_source_skills.sql`（实现期取最新空号，与 RFC-170 协调）——引用清理 UPDATE → `DROP TABLE skill_sources` → `DELETE external 行` → `DROP INDEX` + 6× `DROP COLUMN` → `DELETE resource_grants`（孤儿 skill 授权，P2-3），`--> statement-breakpoint` 分隔（见 design §2）。更新 `_journal.json`（drizzle-kit 或手写一致）。
- **T17**：`schema.ts` 同批：删 `skillSources` 表；`skills` 删 6 列 + `sourceIdx`；`sourceKind` 枚举收窄；保留 `migrationMarker`。`rowToSkill` 定稿（`sourceKind` 恒 `'managed'`）。
- **T18**：`tests/migration-0092-rfc178.test.ts`（引用清理穷举 + drop 断言 + 新库无残留，design §7）。
- **T19**：**RESTRUCTURE** `tests/migration-0090-rfc170.test.ts`（P2-4，非值同步）——其第一个 describe 用全 HEAD DB（含 0092），断言「skills 获 8 列 / skill_sources 获 3 列」中被 0092 drop 的部分会失败；改为**冻结在 ≤0090**（手工 exec ≤0090 迁移，仿该文件第二块模式）或删除这些断言。
- **T20**：`tests/upgrade-rolling.test.ts` 计数锁 `HEAD_TOTAL_MIGRATIONS` 91→92 + 注释行 + 修 stale 标题。

> 依赖：批次 A 完成（无 external 列读者）。schema.ts（T17）与迁移（T16）必须同提交。跑 build:binary smoke（防模块环）+ e2e。

## 批次 C — op-kind 收敛 + 文档登记

- **T21**：`services/skillOperations.ts` + `skillOpRecovery.ts` + registry/driver：TS `kind` 枚举去 `replace`/`adopt-managed`；删 recovery handler/spine；改相关测试（`skill-operations`/`skill-op-recovery`/`-driver`）。`schema.ts` `skillOperations.kind` TS 枚举同步收窄（DB CHECK 不重建，design §4）。
- **T22**：文档——`STATE.md` 顶部「进行中 RFC」→ Done + 已完成表加行；`design/plan.md` RFC 索引加 RFC-178 行；RFC-170 索引条目追加「external/source 部分由 RFC-178 取代」；本 RFC `proposal/design/plan` 状态改 Done。

> 依赖：批次 A/B。

## 验收清单

- [x] `import-external` / `skill-sources/*` 端点 404（路由删除）。
- [x] `skill-source.ts` / `skill-sources.ts` / `SkillSourcesCard.tsx` / `skill-capabilities.ts` + external/source-only 测试从树中消失。
- [x] managed skill 新建/列表/详情/编辑/文件/版本/fusion/运行时注入行为不变（回归绿）。
- [x] ZIP 导入不变（无 external-conflict 分支）。
- [x] 迁移 0092：存量 external 行删空、`skill_sources` drop、6 列 drop；引用清理正确（external 剔除 / managed+project 保留 / 全 external→`[]`）；新库无残留（migration-0092 test 穷举）。
- [x] `resolveSkills` / `stageSkills` managed+project 正常、无 external 分支。
- [x] 五门 + build:binary smoke 全绿（detached worktree 干净 typecheck + build smoke）；CI 待查。
- [x] `upgrade-rolling` 计数锁 91→92。
- [ ] RFC-170 索引标注 superseded；plan.md 索引 + STATE.md 登记（本批 docs）。
- [x] 设计门独立对抗评审（migration SQL 实测）0 P0 全折（Codex `exec` 实现门 wedge，同设计门回退）。

## 交付状态（2026-07-14）

- **批次 A**（去 external 读者，DB 不动）：`bd9e76ce`——48 文件、+181/−4179；后端整删 skill-source/skill-sources + skill.ts 四死函数 + external 分支，前端整删 SkillSourcesCard/skill-capabilities + tab 收窄，shared schema 收窄，11 后端 + 3 前端测试删 + mixed 编辑。
- **批次 B**（migration 0092 + schema.ts drop）：`d1f24aaf`（rebase 后 `dc5bc189`）——json_group_array 引用清理 + DELETE + DROP INDEX/COLUMN×6 + DROP TABLE + resource_grants 清理（FK-ON 安全序）；schema.ts 去 6 列 + narrow enum；migration-0092 test + migration-0090 RESTRUCTURE + 计数锁。
- **批次 C**（op-kind）：`b613aa63`——SkillOpKind/schema enum 去 replace/adopt-managed + phase-seq + 防御守卫；双-id 锁/precondition 列 dormant 保留。
- 已推 origin/main（`dc5bc189`；批次 C 待推）。**取代 RFC-170 §7/§7a/§8 external/source**（已落地删 + 待建取消；managed 主干独立保留）。多人共享树：全程精确 pathspec，未含并发 RFC-179/180 workgroup/i18n/styles 未提交改动；批次 A/B 被并发 push 连带上远端。

## 不做（转其它/明确排除）

- 外部→managed 数据保留迁移（用户拍板硬删）。
- 重建 `skills` / `skill_operations` 表以收紧 CHECK（超集无害，不划算）。
- RFC-170 managed 剩余工作（migrate op 等）——RFC-170 继续。
- repo-local project skill 自发现——不在范围。
