# RFC-178 — 技术设计

> 行号锚点基于 2026-07-14 的工作树（含 RFC-170 在途改动），实现期可能漂移；以符号名为准、实现前 grep 复核。

## §1 删除清单（按文件）

### §1.1 后端整文件删除

| 文件 | 说明 |
|---|---|
| `packages/backend/src/services/skill-source.ts` | RFC-017 父目录功能全部：`discoverSkillsInDir` / `listSkillSources*` / `getSkillSource*` / `filterVisibleSkillSources` / `createSkillSource` / `updateSkillSource` / `deleteSkillSource`（级联删子 skill）/ `rescanSkillSource` / `replaceSourceConflict`（RFC-102）/ `reconcileAllSources` / `reconcileSource` + 全部 helper。 |
| `packages/backend/src/routes/skill-sources.ts` | 6 端点：`GET /api/skill-sources`、`POST /api/skill-sources`、`PATCH /:id`、`DELETE /:id`、`POST /:id/rescan`、`POST /:id/conflicts/replace`。 |

### §1.2 后端 `services/skill.ts`（去 external 分支 / 死函数）

- **删整函数**（移除 external 后无 managed 可达调用方）：
  - `importExternalSkill`（hand-external 创建）。
  - `updateSkill`（唯一调用方是 `saveSkillWithToken` 的 external 分支；含 `source-external` 元数据只读子守卫 `skill-source-external-metadata-readonly`）。
  - `ensureSkillIsWritable`（managed 直接 return；两个 external 子分支 `skill-source-readonly`/`skill-external-readonly`）——删函数后其调用点（`writeSkillContent`/`saveSkillWithToken`/`writeSkillFile`/`deleteSkillFile`）去掉该调用。
  - `removeSkillRowAndFiles`（两个调用方 `deleteSkill` external else + `replaceSourceConflict` 都随之消失；managed 删除走 `deleteManagedSkillOp`）。
- **删分支**：
  - `skillRoot`：删 external 分支（`return skill.externalPath`），只留 managed。
  - `skillReadRoot`：删 `if (sourceKind !== 'managed') return live` 短路，直接走 managed 快照读。
  - `deleteSkill`：删 external `else`（`removeSkillRowAndFiles`），只留 managed `deleteManagedSkillOp`。
  - `saveSkillWithToken`：删 `if (skill.sourceKind === 'external')` 整块（拒 bodyMd + desc→updateSkill），只留 managed funnel。
  - `listSkills`：删开头 `reconcileAllSources(db)` 调用（含 dynamic import）。
- **保留（external 动机但对 managed 安全）**：`readSkillContent`/`readSkillFile` 里的 `realpathInside` 符号链接防护——continue 保护 managed skill 内可能的符号链接，注释更新为「防 SKILL.md/support 文件符号链接逃逸」。
- **`rowToSkill`**：去掉 `externalPath`/`sourceId`/`authorityKind` 投影（这些列被 drop）；`sourceKind` 恒 `'managed'`。

### §1.3 后端其它服务

- `cli/start.ts`：删 boot 期「步骤 5c」`reconcileAllSources` 块（`const { reconcileAllSources } = await import('@/services/skill-source'); await reconcileAllSources(db)` + 其 try/catch，约 :294-305）——删 `skill-source.ts`（T1）后该动态 import 悬空会 typecheck 红。**保留**相邻 :311 `reconcileSkillLiveFiles`（managed 版本、来自 `skillVersion`，非 external）。
- `routes/skills.ts`：删 `POST /api/skills/import-external`（含 `ImportExternalSkillSchema` import + handler）。
- `services/skill-zip.ts`：`computeConflictView` 删 external 分支（`existing.sourceKind === 'external' → conflict:'external'`）；`commitSkillZipBuffer` 删 `skill-external-cannot-overwrite` 分支。ZIP 创建 managed 的核心不动。
- `services/skillBootVerify.ts`：`isSkillAvailableThisBoot` 删 external 分支（`sourceState` 判定）+ 去 `SkillAvailabilityRow.sourceState` 字段；`isSkillInjectableThisBoot` 删 external `return true` 分支。managed 快照重验分支保留。
- `services/resourceAcl.ts`：删 `skill-external-transfer-blocked` 守卫（`type==='skill' && ownerChange && authority_kind!=='managed'` 拒 owner-transfer）。通用六资源 ACL + `aclRevision` CAS 保留。
- `services/scheduler.ts` `resolveSkills`：删 `else if (row.sourceKind === 'external' && row.externalPath !== null)` 分支。managed 分支（含 `isSkillInjectableThisBoot` 门）+ `project` 回退保留（见 §3）。
- `services/skillVersion.ts` / `services/fusion.ts`：`if (sourceKind !== 'managed')` 守卫在删除后恒不触发——**保留为廉价防御**（注释标注 external 已移除、此守卫现恒 managed）；不强删，避免误伤 managed 语义。
- `services/skillOperations.ts` + `skillOpRecovery.ts` + `skillOpRegistry`/driver：从 TS `kind` 枚举移除 `replace` + `adopt-managed`；删对应 recovery handler / spine（`skillOpRecovery` 的 adopt-managed phase spine、driver 的 handler 行）。保留 `reserve`/`migrate`/`delete`/`version-write`（全 managed，见 §4）。

### §1.4 shared（`packages/shared/src/schemas/skill.ts`）

- 删：`ImportExternalSkillSchema`、`SkillAuthorityKindSchema`、全部 skill-sources schema（`SkillSourceSchema`/`SkillSkipReasonSchema`/`SkillSkipReportSchema`/`SkillSourceWithStatsSchema`/`CreateSkillSourceSchema`/`UpdateSkillSourceSchema`/`RegisterSkillSourceResponseSchema`/`RescanSkillSourceResponseSchema`/`ReplaceSourceConflictSchema`/`ReplaceSourceConflictResponseSchema` + 导出类型）。
- 改：`SkillSourceKindSchema` 收窄为 `z.enum(['managed'])`；`SkillSchema` 去 `authorityKind`/`externalPath`/`sourceId` 字段；ZIP `SkillZipCandidateConflictSchema` 去 `'external'` 枚举成员（+ `conflict`/`canOverwrite` 字段随 §1.3 ZIP 收敛）。
- 保留：`SkillNameSchema`/`CreateManagedSkillSchema`/content/file/save/ZIP 核心 schema。

### §1.5 schema.ts（Drizzle 定义，与迁移同批）

- 删 `skillSources` 表定义（`skill_sources`）。
- `skills` 表删列：`externalPath`、`sourceId`（+ `sourceIdx` index 定义）、`authorityKind`、`sourceState`、`originSourceId`、`authorityOwnerUserId`。
- `skills.sourceKind` 枚举收窄 `enum: ['managed']`（DB 列保留、CHECK 保持超集，见 §2 说明）。
- **保留 `skills.migrationMarker`**：它属于 RFC-170 managed `migrate` op（legacy 分叉 → v1 backfill），非 external 专属；drop 会破坏 RFC-170 剩余 managed 工作。
- `skillOperations.kind` TS 枚举收窄为 `['reserve','migrate','delete','version-write']`（DB CHECK 不重建，见 §4）。

### §1.6 前端

| 文件 | 动作 |
|---|---|
| `components/SkillSourcesCard.tsx` | 整文件删（`canReplaceConflict`/`BlockerBanner`/`describeError`）；去 `skills.tsx` 的 import + 在 `SkillsEmptyPane` 的挂载。 |
| `lib/skill-capabilities.ts` | 整文件删（三态 authority 能力表塌缩为 managed-only）；`skills.detail.tsx` 改为内联 managed 恒 true 能力（或直接去掉 gating）。 |
| `routes/skills.new.tsx` | `Tab` 收窄 `'managed' \| 'zip'`；删 `external`/`folder` tab、`create` 的 import-external else 分支、`registerFolder` mutation、`RegisterSourceResponse`、folder/externalPath 表单 Field、`EMPTY_FORM` 的 `externalPath`/`folderPath`/`folderLabel`、disabled/header 分支。 |
| `routes/skills.detail.tsx` | 删 external 分支：chip/label/`externalPath` 展示、`descHintExternal`、描述 `disabled={!canEditDescription}`、正文 readonly `<pre>`、per-authority save payload 拆分、`canTransferOwner` gate、save-disable gate。页面（managed 编辑/文件/版本/fusion）保留。 |
| `routes/skills.tsx` | 卡片 `chip--${sourceKind}` / `tabManaged:tabExternal` 徽标收敛为 managed（或去徽标）。 |
| `components/skills/ImportZipPanel.tsx` | 保留；去 `invalidateQueries(['skill-sources'])`、去 `isExternalConflict` 死显示分支。 |
| i18n `en-US.ts` / `zh-CN.ts`（值 + `Resources` 类型） | 删 external 键（`tabExternal`/`fieldExternalPath*`/`externalPathPlaceholder`/`descHintExternal`）+ source 键块（`tabFolder`/`field Folder*`/`createFolderButton`/`sources*`/`source*`）+ `errors.skill-source-*`。保留 `zip*`（含仅措辞提及 external 的 `zipConflictExternal`——如该分支彻底移除则一并删该键）。 |
| `router.tsx` / nav | 无 `/skills/sources` 路由、无 nav 链接，无需改。 |

## §2 迁移设计（`0092_rfc178_remove_external_source_skills.sql`）

风格同 `0089_rfc167_drop_dynamic_workflow_spaces.sql`（forward-drop、append-only、头部注释说明），多语句用 `--> statement-breakpoint` 分隔（见 [migration statement-breakpoint 规则]）。

**语句顺序（关键）**：引用清理必须在删外部行**之前**（子查询依赖 `skills` 里还存在的 external 行）。

```sql
-- RFC-178 (2026-07-14) — 收敛 skills 为 managed-only：删除「外部 skill」
-- (hand-external, import-external) 与「父目录 skill」(source-external, skill_sources
-- / RFC-017) 两套功能。外部 skill 的磁盘文件在用户自己的目录里，本迁移只删 DB
-- 索引行，不触碰磁盘。forward-drop：新库创建后即删（表 external 行恒空）；存量 dev
-- 库删除既有 external 行 + skill_sources + 相关列。取代 RFC-170 的 external 部分。

-- 步骤 1：清理 agents.skills[] 里指向被删外部 skill 的悬空引用。
--   只剔除「确实是 external skill 的名字」——保留指向 repo-local project skill
--   (DB 无行) 的合法引用。必须先于步骤 3 的 DELETE 执行。
UPDATE `agents`
SET `skills` = (
  SELECT json_group_array(value)
  FROM json_each(`agents`.`skills`)
  WHERE value NOT IN (SELECT `name` FROM `skills` WHERE `source_kind` = 'external')
)
WHERE EXISTS (
  SELECT 1 FROM json_each(`agents`.`skills`)
  WHERE value IN (SELECT `name` FROM `skills` WHERE `source_kind` = 'external')
);
--> statement-breakpoint

-- 步骤 2：删父目录表（其子 skill 行在步骤 3 一并删）。
DROP TABLE IF EXISTS `skill_sources`;
--> statement-breakpoint

-- 步骤 3：删所有 external skill 行（hand-external + source-external）。
DELETE FROM `skills` WHERE `source_kind` = 'external';
--> statement-breakpoint

-- 步骤 4：删 external/source 专属列。source_id 有 index，先删 index。
DROP INDEX IF EXISTS `skills_source_id_idx`;
--> statement-breakpoint
ALTER TABLE `skills` DROP COLUMN `source_id`;
--> statement-breakpoint
ALTER TABLE `skills` DROP COLUMN `external_path`;
--> statement-breakpoint
ALTER TABLE `skills` DROP COLUMN `authority_kind`;
--> statement-breakpoint
ALTER TABLE `skills` DROP COLUMN `source_state`;
--> statement-breakpoint
ALTER TABLE `skills` DROP COLUMN `origin_source_id`;
--> statement-breakpoint
ALTER TABLE `skills` DROP COLUMN `authority_owner_user_id`;
--> statement-breakpoint

-- 步骤 5：清理被删外部 skill 的 ACL 授权行（resource_grants 无 FK 到 skills，
--   须显式清）。resource_id 存 skill.id（ULID）；外部行已在步骤 3 删，此处删
--   指向已消失 skill id 的 skill 授权（同名重建的 managed skill 是新 ULID，不会继承）。
DELETE FROM `resource_grants`
WHERE `resource_type` = 'skill'
  AND `resource_id` NOT IN (SELECT `id` FROM `skills`);
```

**设计说明**：

- **外键在迁移期 OFF**：迁移在 `PRAGMA foreign_keys=OFF` 下跑（`db/client.ts` RFC-115 决策，`foreign_key_check` 仅 WARN 不 throw），故步骤 2 `DROP TABLE skill_sources` 先于步骤 3 删其子行不报 FK 错；`skill_versions.skill_name`（FK→`skills.name`，`ON DELETE CASCADE`）在步骤 3 DELETE 时自动清（外部 skill 通常无版本快照，cascade 无论如何正确）。全 9 语句在 SQLite 3.51 实测通过、终态 `skills` 列 = `id,name,source_kind`。
- **引用清理为何 load-bearing**：`workflow.validator.ts` 校验 `agent.skills` 都能解析到已知 skill（`skillNames = new Set(ctx.skills.map(s=>s.name))`）；若留悬空外部名，删除后工作流校验会失败——故步骤 1 的清理不是「锦上添花」而是正确性必需。`fusions.skill_name`（弱 by-name、无 FK）不会悬空：`createFusion`（fusion.ts:423）硬拒非 managed，故无外部 fusion 行。

- **`source_kind` 列保留、CHECK 不重建**：drop external 行后该列恒 `'managed'`。SQLite 无法就地改 CHECK 约束（需整表 rebuild）；`CHECK(source_kind IN ('managed','external'))` 作为超集对只含 `'managed'` 的数据无害。为「收紧一个死枚举值」去 rebuild `skills` 表不划算（且 RFC-170 快照/op 机制强依赖该表）。TS 侧枚举收窄到 `['managed']` 即可（TS 比 DB 严格无妨）。
- **`migration_marker` 保留**：属 RFC-170 managed `migrate` op，非 external。
- **`json_group_array` 正确性**：`json_each(agents.skills)` 是相关子查询、引用当前行；空数组 → `json_group_array` over 0 行返回 `'[]'`；顺序 / 字符串类型保留。`agents.skills` NOT NULL default `'[]'`，无 NULL 风险。这是全仓首个 JSON-surgery 迁移，由 §7 专门测试穷举锁定。
- **DROP COLUMN 支持**：Bun 内置 SQLite ≥3.35 支持 `ALTER TABLE DROP COLUMN`；仓内已有 9 处先例（0057/0058/0072/0073/0078 等 drop-feature 迁移）。被 index 引用的列（`source_id`）先 `DROP INDEX`。
- **schema.ts 同批**：Drizzle `select()` 只投影已声明列；schema.ts 删列必须与本迁移**同一提交/批次**落地，否则 `select` 读不存在列会炸（见 §8 落地顺序）。

## §3 运行时注入变更

- `services/scheduler.ts` `resolveSkills`：三分支（managed / external / project）→ 两分支。
  - `row` 不存在 → `{ name, sourceKind: 'project' }`（**保留**：opencode 从 cwd 自发现 repo-local skill）。
  - `row.sourceKind === 'managed'` → boot 注入门 + `{ managed, sourcePath }`（**保留**）。
  - external 分支（**删**）。
- `services/runtime/stageSkills.ts`：
  - `StagedSkill.sourceKind` 收窄 `'managed' | 'project'`。
  - loop 体：`project` 仍 `continue`；`sourcePath === undefined` 仍 warn+skip；删 `else { symlinkSync(...) }` external 分支——留下只有 managed 走 `cpSync`。`symlinkSync` import 若无其它用途一并删。
  - 头部注释更新（去 `external → symlinkSync` 行）。
- `services/runtime/types.ts`：`ResolvedSkill.sourceKind` 收窄 `'managed' | 'project'`；**同时收窄根类型别名 `export type SkillSource = 'managed' | 'project'`（:39，经 `runner.ts:89` 再导出）**，以及 `stageSkills.ts:29` 的内联 `StagedSkill.sourceKind`——三处一起，避免残留 `'external'` 成员。
- 两 caller（`runtime/opencode/driver.ts`、`runtime/claudeCode/config.ts`）无需改（`stageSkills` 签名不变）。

## §4 op-kind 收敛

`skill_operations.kind` 当前枚举 `['reserve','replace','migrate','delete','version-write','adopt-managed']`：

| kind | 归属 | 动作 |
|---|---|---|
| `reserve` | managed 创建（含 ZIP） | 保留 |
| `migrate` | managed legacy 分叉 → v1 backfill | 保留（RFC-170 待建，非 external） |
| `delete` | managed 崩溃安全删除 | 保留 |
| `version-write` | managed 版本写 | 保留 |
| `replace` | 仅 source 名冲突替换（`replaceSourceConflict`） | **删** |
| `adopt-managed` | external degraded → managed 两阶段采纳 | **删** |

- TS `enum` 收窄为四值；删 `skillOpRecovery` 的 `adopt-managed` phase spine + driver handler + 相关测试断言。
- DB CHECK 约束**不重建**（同 §2 理由：为死枚举 rebuild 崩溃恢复表不划算；删除后无代码产生这两个 kind，遗留 DB 行也不可能存在——它们从未在生产创建过）。
- `preconditionJson` 列注释里「§7a adopt-managed full precondition」措辞更新（cosmetic）。

## §5 与 RFC-170 的耦合（取代 external 部分）

managed 主干**完整保留**，external/source 部分被本 RFC 取代：

| RFC-170 机制 | 归属 | 状态 | 本 RFC |
|---|---|---|---|
| 快照权威 + op-scoped 原子发布（`skillReadRoot`/`swapInStaged`/`versions/v<n>`） | managed | 已落地 | **保留** |
| `skill_operations` 状态机 + `skill_operation_locks` | managed | 已落地 | **保留**（去 replace/adopt-managed kind） |
| reserve / delete / version-write op | managed | 已落地 | **保留** |
| `migrate` op（legacy managed → v1） | managed | 待建 | **保留**（RFC-170 继续） |
| 复合 token CAS（skillId+contentVersion+metaRevision）/ T6 fusion token | managed | 已落地 | **保留** |
| 六资源 `aclRevision` CAS | 共享 | 已落地 | **保留** |
| T-BOOT `bootVerifiedSet` / quarantine（managed 分支） | managed | 已落地 | **保留** |
| `authority_kind` 三态 + 能力派生 | external | 已落地 | **删**（塌缩 managed） |
| `source-external` 元数据只读 / external combined-save 只读 | external | 已落地 | **删** |
| external owner-transfer 阻断（`skill-external-transfer-blocked`） | external | 已落地 | **删** |
| Codex F1 authority 分类（import=hand / reconcile=source） | external/source | 已落地 | **删** |
| degraded-external fail-closed（`isSkillAvailableThisBoot` external 分支） | external | 已落地 | **删**（managed 分支留） |
| migration 0090 的 external/source 列 + backfill | external/source | 已落地 | **0092 drop** |
| replace op（三 occupier 子机 / journal / 双锁）完整版 | source | 待建（仅 managed-occupier-delete 落地） | **取消** |
| adopt-managed / rebind op | external | 待建 | **取消** |
| T9b external descriptor-relative no-follow 捕获 | external | 待建 | **取消** |
| 批次 C source 生命周期 ACL（reconcileSource user/system 拆分 / tombstone / per-child ACL / `source_revision` CAS） | source | 待建 | **取消** |
| 前端 adoption UI | external | 待建 | **取消** |

RFC-170 索引条目追加一句：「external/source 部分（§7/§7a/§8 授权三态、source 生命周期、replace/adopt/rebind、T9b）由 RFC-178 取代；本 RFC 剩余仅 managed 范围（migrate op 等）。」

## §6 失败模式 / 边角

1. **迁移中途 kill**：单条 SQL 语句在 drizzle 事务里执行；forward-drop 幂等（`DROP TABLE IF EXISTS` / `DROP INDEX IF EXISTS`）。若在步骤 1（引用清理）后、步骤 3（DELETE）前 kill，重启重跑：步骤 1 的 UPDATE 幂等（外部名已被剔则 EXISTS 守卫短路），步骤 3 重跑仍删剩余 external。`ALTER ... DROP COLUMN` 若列已删，drizzle 迁移不会重复执行同一 idx（已应用记录），无重跑风险。
2. **project skill 引用**：agent 引用一个 DB 无行的名字（repo-local skill）——引用清理子查询 `source_kind='external'` 不含它，保留；运行时 `resolveSkills` 仍 `project` 回退。**这是本迁移最关键的不误删点**，§7 专测。
3. **同名 external + 之后重建 managed**：external 行被删后，用户可用同名新建 managed（name unique 约束此时无冲突）。agent 若曾引用该名，引用已被步骤 1 剔除——不会「自动指向」新 managed（符合硬删语义；用户需显式重加引用）。
4. **fusion 指向 external**：`fusion.ts` 守卫 `sourceKind !== 'managed'` 拒非 managed，故不存在指向 external 的 fusion，无需清理。
5. **运行中任务的 worktree**：运行时按 DB 行 resolve；external 行删除后不再注入，managed 不受影响；已 staged 的旧 worktree 文件不回收（与现状一致）。
6. **DROP COLUMN 在旧 SQLite**：目标 Bun 版本 SQLite ≥3.35（已由现有 9 处 DROP COLUMN 迁移在 CI 验证）。

## §7 测试策略

> **权威清单以 grep 为准（不靠手列，见 [grep locks before push]）**。实现期先跑：
> `grep -rlE "import-external|skill-source|skill_sources|source-external|hand-external|externalPath|sourceKind: ?'external|authorityKind|replaceSourceConflict|adopt-managed|'external'|reconcileAllSources|SkillSourcesCard|skillCapabilities|fieldFolder|tabExternal|tabFolder" packages/backend/tests packages/frontend/tests`
> **命中的每个文件都要处理**；下列分类是当前快照，非穷举。**⚠️ vitest 陷阱**：前端测试跑在 vitest，本地 `bun test`（后端 only）**不覆盖**——`page-hint-removal`/`fuse-dialog-entry`/`import-zip-panel`/`skill-*-card`/`skill-capabilities` 等前端文件必须 `bun run test`（前端）+ CI 才见红（见 [frontend i18n batch] / [CI test scope]）。

- **删除（external/source-only，随功能整体删）**：后端 `skill-source-cascade-delete` / `skill-source-conflict-replace` / `skill-source-discover` / `skill-source-http` / `skill-source-reconcile` / `skill-source-runner-zero-touch` / `skill-source-write-guard` / `skills-list-lazy-scan` / `rfc103-skill-sources-acl` / `skill-replace-op` / `rfc170-skill-transfer-block`；前端 `skill-sources-card` / `skill-folder-tab` / `skill-capabilities`。
- **编辑（mixed，含设计门第 1 轮补齐的 7 个漏项 P1-1）**：
  - 后端：`skills.test.ts`（去 import-external / externalPath / PUT→410）、`skill-combined-save`（去 external 只读分支）、`fusion-engine`（去 import-external ABA setup）、`skill-operations` / `skill-op-recovery`〔+ 若存在 `-driver`〕（去 replace/adopt-managed）、`contracts/registry`（去 import-external + skill-sources 行）、`contracts/harness`（去 externalPath）、`skill-zip-commit`（去 external-conflict 交叉）、**`scheduler-depends-closure`（`:59` `db.insert(skills).values({…externalPath:null})` → 去该列，schema drop 后 typecheck 红）**、**`skill-boot-verify`（`:99-136` `isSkillAvailableThisBoot({sourceKind:'external',sourceState})` → 去 external 分支用例 + `sourceState` 字段）**、**`rfc154-runtime-config-dir`（`:423` ResolvedSkill mock `sourceKind:'external'` → 收窄）**、**`rfc099-migration-0045` / `rfc099-resource-routes`（若含 skill-source ACL 装置——grep 复核、按需去）**。
  - **`migration-0090-rfc170`（P2-4：非「值同步」而是 RESTRUCTURE）**：该测试第一个 `describe` 用 `createInMemoryDb(MIGRATIONS)`＝全 HEAD（含 0092），其「skills 获得 8 身份/生命周期列」(`:55-68`，其中 4 列被 0092 drop)、「skill_sources 获得 …」(`:71-77`，整表被 drop) 断言会失败——须**冻结在 ≤0090**（改用第二块那种「只 apply ≤0090 手工 exec」模式）或删除这些断言，不能原地改值。
  - 前端：`page-hint-removal`（**`:139` 源码文本锁 `toMatch(/managedPath \?\? meta\.data\??\.externalPath/)` → 随 `skills.detail.tsx` 去 externalPath 行更新此锚**）、`fuse-dialog-entry`（`:127` mock skill `sourceKind:'external'` → 收窄）、`import-zip-panel`（`:176` candidate `conflict:'external'` → 去）、`skill-zip-import-helpers`（`:21/43/65/169/215` `conflict:'external'` → 去）、`skills-detail-save-channels`（去 external 通道）、`skills-split-page`（去 skill-source/externalPath）、`rfc099-acl-components`（去 2 条 external-transfer 用例、留 12 managed/shared）、`i18n-phase-a`（若锁已删 i18n 键 → 更新）。
  - **模糊命中（grep 副作用，实现期逐一复核、多半不动）**：`call-graph-*` / `callgraph-*` / `call-chain` / `sequence`（多半匹配 `agent.skills` 或无关 `sourceKind`）。
- **新增回归**：
  - `migration-0092-rfc178.test.ts`：**引用清理穷举**——agent `[ext, managed, project]` → `[managed, project]`；全 ext → `[]`；无 ext 引用的 agent 不变；`skills WHERE source_kind='external'` 删空；`skill_sources` 表 drop；6 列 drop（pragma table_info 断言）；**私有外部 skill 的 `resource_grants` 行被清（P2-3）**；新库无残留。
  - managed skill CRUD 冒烟（新建 / 编辑 / 文件 / 版本 / 删除）不变（可能已有——复用锁定）。
  - `stageSkills` managed-only + project skip（可能已有，去 external 断言）。
- **计数锁**：`upgrade-rolling.test.ts` `expect(HEAD_TOTAL_MIGRATIONS).toBe(91)` → `92` + 新注释行「RFC-178 bumped to 92 with 0092_rfc178_remove_external_source_skills」+ 修正 stale 标题（`90` → 实际数）。
- **门槛**：五门（typecheck/lint/后端 test/前端 test/format:check）+ 单二进制 build smoke + Playwright e2e 全绿。

## §8 落地顺序 / 多人协调

1. **前置（实现前）**：确认/落定 working tree 里 RFC-170 在途未提交的 skill 改动（`skill.ts`/`skills.ts`/`skills.detail.tsx`/`skill-combined-save.test.ts`/`skills.test.ts` + 前端测试）——提交或确认可弃，取得干净基线。多人树：**绝不覆盖他人 RFC-170 改动**，冲突同函数同行则先问用户（见 [multi-person 规则]）。
2. **批次 A（去 external 读者，schema/DB 不动）**：shared schema 收窄 + 后端服务/路由 external 分支与死函数删除 + 前端删除 + 测试删/改。此时 `skills` 表列仍在但无人读（`rowToSkill` 已不投影）。五门绿。
3. **批次 B（原子：迁移 + schema.ts 列删）**：`0092` 迁移 + schema.ts drop 表/列/收窄枚举 + `rowToSkill` 定稿 + 迁移测试 + `migration-0090` companion + 计数锁 91→92。schema.ts 与迁移**同批**（避免 select 读已删列）。五门 + build smoke + e2e 绿。
4. **批次 C（op-kind 收敛 + 文档）**：`skillOperations`/recovery drop replace/adopt-managed + STATE.md / plan.md RFC 索引 / RFC-170 索引标注 superseded。
5. migration 号实现期取最新空号（≥0092，与并发 RFC-170 协调）；每批次 push 后立即查 CI（见 [post-commit CI check]）。

## §9 设计门评审记录

**第 1 轮（2026-07-14，独立对抗式评审，migration SQL 在 Bun/SQLite 3.51 实测）——NEEDS-ATTENTION：0 P0 / 2 P1 / 2 P2 / 1 nit，全部折入正文**：

- **核心设计判 sound（实测验证）**：① `json_group_array` over 0 行＝`'[]'` 非 NULL（`agents.skills` NOT NULL 成立）；实跑 RFC 的 UPDATE：`[extX,mY,pZ]`→`["mY","pZ"]`、`[extX,extW]`→`[]`、无外部引用不动、JSON 顺序保留。② 全 9 语句在 FK-OFF（`client.ts` RFC-115）下顺序执行成功、终态 `skills` 列＝`id,name,source_kind`；`DROP INDEX` 先于 `DROP COLUMN source_id` 正确；SQLite 3.51 允许 drop FK-源列。③ 无 managed 主干路径读被 drop 列（`isSkillAvailableThisBoot` managed 分支只读 reservation/version_state；`resolveSkills` managed 读 `managedPath`）。④ `updateSkill`/`removeSkillRowAndFiles`/`ensureSkillIsWritable` 确无 managed 可达调用方。⑤ `replace`/`adopt-managed` op 无任何 `beginOperation` 生产者（死枚举，DB CHECK 留作无害超集）。⑥ `HEAD_TOTAL_MIGRATIONS` 91→92 正确（0013 是编号 gap，91 个 `.sql`、下一空号 0092；RFC-170=已提交 0090、RFC-175=0091、并发 RFC-177 不加 `.sql`）。⑦ stageSkills/resolveSkills 的 `project` 分支保留、external 是唯一 external ResolvedSkill 生产者。⑧ `migration_marker` 确为 managed 预留（零读者）。
- **P1-1（折入 §7）**：测试清单不完整——`page-hint-removal`(:139 源码文本锁)/`scheduler-depends-closure`(:59 externalPath 插入)/`import-zip-panel`(:176)/`skill-boot-verify`(:99-136)/`fuse-dialog-entry`(:127)/`skill-zip-import-helpers`(:21…)/`rfc154-runtime-config-dir`(:423) 7 个漏项 + vitest/CI-only 陷阱 → §7 改为「grep 权威 + 命名漏项 + vitest 警示」。
- **P1-2（折入 §1.3 / plan T3）**：`cli/start.ts:294-305` boot 期 `reconcileAllSources` 漏在清单 → 删 skill-source.ts 会致悬空 import typecheck 红 → 补入。
- **P2-3（折入 §2 步骤 5）**：`resource_grants`（无 FK 到 skills）硬删后遗留外部 skill 授权行 → 加 `DELETE FROM resource_grants WHERE resource_type='skill' AND resource_id NOT IN (SELECT id FROM skills)`（ULID-keyed，无 ACL 泄漏但补全「引用清理」目标）。
- **P2-4（折入 §7）**：`migration-0090-rfc170` 非值同步而须 RESTRUCTURE（断言冻结 ≤0090 或删）。
- **nit-5（折入 §3）**：收窄根类型别名 `SkillSource`（types.ts:39）+ runner.ts:89 再导出，非仅两派生字段。

**第 2 轮（Codex `exec` 独立复核，best-effort）——wedge，未跑成**：`codex exec` 在本仓共享运行时卡在「Reading additional input from stdin…」阻塞（与 RFC-173/176 同款 shared-runtime wedge，见 [codex review plugin]），已 kill。设计门以**第 1 轮独立对抗评审**（已 empirically 实测 migration SQL、0 P0、全 findings 折入）+ 实现期五门（typecheck/lint/后端 test/前端 vitest/format）+ build smoke + CI + 实现门为准。实现落地后可再试 Codex 实现门（若仍 wedge 同此处理）。
