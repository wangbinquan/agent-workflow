# RFC-178 — 移除「外部 skill」与「父目录 skill」，skills 收敛为 managed-only

- 状态：Draft（待 Codex 设计门 + 用户批准）
- 作者：本 session
- 日期：2026-07-14
- 相关：取代 [RFC-170](../RFC-170-skills-storage-acl-hardening/proposal.md) 的 external/source 部分（managed 主干独立保留）；承接 RFC-017（skill sources）、RFC-102/RFC-103（source 冲突替换 / source ACL）——两者随本 RFC 一并退场。

---

## 1. 背景

当前 skill 子系统支持三种 skill：

| 种类 | `source_kind` / `authority_kind` | 来源 | 平台是否写 |
|---|---|---|---|
| **managed** | `managed` / `managed` | 平台存储 `~/.agent-workflow/skills/{name}/files/`，DB 索引 | 是（版本化写入） |
| **外部 skill（hand-external）** | `external` / `hand-external` | 用户手动 `POST /api/skills/import-external` 注册的单个目录 | 否（只读，`externalPath` 指向用户目录） |
| **父目录 skill（source-external）** | `external` / `source-external` | 注册一个父目录（`skill_sources` 表，RFC-017），平台扫描其直接子目录、自动导入为子 skill | 否（只读，源目录是权威） |

外部/父目录两套「只读引用外部磁盘」的能力，带来了与 managed 存储模型**不对称的一大片复杂度**：

- **只读授权三态**（`authority_kind` 的 managed / hand-external / source-external）、`source-external` 元数据只读、external owner-transfer 阻断（RFC-170 §8）。
- **父目录生命周期**：惰性 reconcile、扫描错误汇总、名字冲突替换（`replaceSourceConflict`，RFC-102）、级联删除、source ACL（RFC-103）、source 生命周期 tombstone / `source_revision` CAS（RFC-170 §7a）。
- **运行时不对称注入**：managed 走 `cpSync` 拷贝，external 走 `symlink`（`stageSkills`）。
- **RFC-170 为它们新增的大量脚手架列**（`authority_kind` / `source_state` / `origin_source_id` / `authority_owner_user_id` / `migration_marker` + `skill_sources.lifecycle_state`/`deleted_at`/`source_revision`），其中 orphan/adopt/rebind 一整套**几乎从未接线**（`migration_marker` 零读写、`source_state` 仅一个读者）。

产品上，用户决定**收敛 skill 模型为 managed-only**：平台只保留自己版本化管理的 skill，加上 ZIP 批量导入（本质也是创建 managed skill）。外部单目录导入与父目录自动导入两套功能整体退场。

## 2. 目标 / 非目标

### 目标

1. **移除「外部 skill」功能**：删除 `POST /api/skills/import-external` 及其后端服务、前端 tab、i18n、测试。
2. **移除「父目录 skill」功能**：删除 `skill_sources` 表、`/api/skill-sources/*` 全部端点、`services/skill-source.ts` 整个文件、reconcile/discover/cascade/conflict-replace 全链、前端 `SkillSourcesCard` 与 folder tab、RFC-103 source ACL、i18n、测试。
3. **schema 收敛为 managed-only**：DROP `skill_sources` 表 + `skills` 的 external/source 专属列（`external_path`/`source_id`/`authority_kind`/`source_state`/`origin_source_id`/`authority_owner_user_id`）；`source_kind` 退化为只剩 `managed`。
4. **存量数据硬删除 + 引用清理**：迁移删掉全部 external/source skill 行与 `skill_sources` 行；**只**从 `agents.skills[]` 中剔除被删的这些外部 skill 名字（保留指向 repo-local「project」skill 的合法引用）。
5. **保留 managed 主干**：managed 新建、ZIP 导入、managed 的编辑 / 版本历史 / fusion / 运行时注入、RFC-170 的 managed 存储加固（快照权威、op-scoped 原子发布、reserve/delete/version-write/migrate op、六资源 `aclRevision` CAS、T6 fusion token、T-BOOT）**全部不受影响**。
6. **取代 RFC-170 的 external 部分**：显式承接 RFC-170 中所有 external/source 相关工作（已落地的删除、未落地的取消），并在 RFC-170 索引里标注该部分被 RFC-178 superseded。

### 非目标

- **不动 ZIP 导入**：`POST /api/skills/import-zip/{parse,commit}` 创建的是 managed skill，保留；仅移除其内部「目标已是 external → 拒绝覆盖」的死分支。
- **不动 repo-local「project」skill**：opencode 从 worktree cwd 自发现的 `.opencode/skills/` 不是 DB 资源、不在本 RFC 范围。`resolveSkills` 对「DB 无此名」→ `project` 的回退保留。
- **不动 RFC-170 managed 加固**：本 RFC 不改快照权威 / 原子发布 / 版本化 / token / boot 校验等 managed 机制。
- **不做外部→managed 的数据迁移**：用户已拍板硬删（pre-release，删除优于弃用），不把外部 skill 的磁盘内容拷进 managed 存储保留。
- **不重建 `skill_operations` 表**：只从 TS 枚举与代码里移除 `replace`/`adopt-managed` 两个 op kind（删除后无代码再产生它们）；DB CHECK 约束保持宽松（超集无害），避免为死枚举重建崩溃恢复表。

## 3. 用户故事

- **US-1**：作为用户，我在 `/skills/new` 只看到「新建 managed skill」与「ZIP 导入」两种方式；不再有「外部目录导入」「父目录」两个 tab。
- **US-2**：作为用户，我的 skill 列表 / 详情不再出现「External」徽标、「在源目录编辑」只读提示、`externalPath` 展示；所有 skill 都可编辑描述 / 正文 / 文件 / 版本回滚 / fusion。
- **US-3**：作为用户，升级到含本 RFC 的版本后，我此前注册的外部 skill / 父目录源自动消失（DB 行被删；我磁盘上的原目录文件**不被触碰**）；引用过它们的 agent 的 skills 列表里，那些名字被自动清掉，agent 其它 skill 引用（含 repo-local project skill）保持不变。
- **US-4**：作为平台维护者，skill 子系统的授权模型从三态收敛为单态（everything managed），source 生命周期 / reconcile / conflict-replace / source ACL 整块复杂度消失，后续 RFC-170 剩余工作（migrate op 等）只需覆盖 managed。

## 4. 验收标准

1. `POST /api/skills/import-external`、`GET/POST/PATCH/DELETE /api/skill-sources`、`POST /api/skill-sources/:id/{rescan,conflicts/replace}` 全部返回 404（路由不存在）。
2. `services/skill-source.ts`、`routes/skill-sources.ts`、`components/SkillSourcesCard.tsx`、`lib/skill-capabilities.ts`、以及所有 external/source-only 测试文件从源码树消失。
3. 新建 / 列表 / 详情 / 编辑 / 文件树 / 版本 / fusion 对 managed skill 的行为**逐字节不变**（回归测试锁定）。
4. ZIP 导入行为不变（仍创建 managed skill；不再有 external-conflict 分支）。
5. 迁移 `0092_rfc178_*`：
   - 升级已存在含外部/源数据的 dev DB 后：`SELECT count(*) FROM skills WHERE source_kind='external'` = 0；`skill_sources` 表不存在；`skills` 表无 `external_path`/`source_id`/`authority_kind`/`source_state`/`origin_source_id`/`authority_owner_user_id` 列。
   - **引用清理正确性**：一个引用 `[外部X, managed Y, projectZ]` 的 agent，迁移后 `skills` = `["Y","projectZ"]`（外部名被删、project 名保留）；全引用外部的 agent → `[]`。
   - 全新 DB（无外部数据）升级后行为与硬删一致、无残留列 / 表。
6. `resolveSkills` / `stageSkills` 对 managed + project 正常，external 分支已移除；运行时对 managed skill 注入不变。
7. 五门全绿：`bun run typecheck && bun run lint && bun run test`（后端 + 前端）`&& bun run format:check` + 单二进制 build smoke + Playwright e2e。
8. `upgrade-rolling.test.ts` 的 `HEAD_TOTAL_MIGRATIONS` 计数锁 91→92（+ 注释登记 + 修正 stale 标题）。
9. RFC-170 索引条目标注「external/source 部分由 RFC-178 取代」；`design/plan.md` RFC 索引新增 RFC-178 行、`STATE.md` 登记。

## 5. 影响范围（概览，明细见 design.md）

- **后端整文件删**：`services/skill-source.ts`（710 行）、`routes/skill-sources.ts`（6 端点）。
- **后端 external 分支删**：`services/skill.ts`（`importExternalSkill`/`updateSkill`/`ensureSkillIsWritable`/`removeSkillRowAndFiles` 四函数 + `skillRoot`/`skillReadRoot`/`deleteSkill`/`saveSkillWithToken` 分支 + `listSkills` 的 reconcile 调用）、`routes/skills.ts`（import-external 端点）、`skill-zip.ts`、`skillBootVerify.ts`、`resourceAcl.ts`、`scheduler.ts` resolveSkills、`runtime/stageSkills.ts`+`types.ts`、`skillOperations.ts`/recovery（drop `replace`/`adopt-managed`）。
- **shared**：`schemas/skill.ts` 去 `ImportExternalSkillSchema`、全部 skill-sources schema、`SkillAuthorityKindSchema`、`SkillSchema` external 字段；`SkillSourceKindSchema` 收窄 managed-only。
- **schema.ts + 迁移**：DROP 表 + 6 列 + index，narrow 枚举。
- **前端整文件删**：`components/SkillSourcesCard.tsx`、`lib/skill-capabilities.ts`；`skills.new.tsx` 收窄两 tab；`skills.detail.tsx` 去 external 分支；`skills.tsx` 徽标收敛；`ImportZipPanel.tsx` 去死分支；i18n 去 external/source 键。
- **测试**：约 10 后端 + 3 前端整文件删；约 8 mixed 文件编辑；新增迁移 0092 引用清理 + managed 回归测试。

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 与 RFC-170 在途未提交 skill 改动 / 并发提交冲突 | **实现前先落定/确认 working tree 未提交的 RFC-170 skill 改动**（提交或确认可弃）；多人树按精确 pathspec 提交；migration 号实现期取最新空号并与 RFC-170 协调 | 
| 迁移 JSON 引用清理无先例（首个 `json_group_array` 迁移） | 专门迁移测试穷举「外部剥离 + project/managed 保留 + 全外部→[]」；`--> statement-breakpoint` 分隔；引用清理 UPDATE 必须在 DELETE 外部行**之前**执行 |
| DROP COLUMN 在 SQLite 的限制（索引 / 约束） | 先 `DROP INDEX skills_source_id_idx` 再 drop `source_id`；其余为普通列，已有 9 处 DROP COLUMN 迁移先例（含 0089 drop-feature 模板） |
| 悬空 agent 引用误删 project skill | 引用清理**只**剔除被删外部 skill 的确切名字（子查询 `source_kind='external'`），不按「未解析名」黑删——project skill 引用（DB 无行）天然保留 |
| 删除 RFC-170 已落地 external 代码引入回归 | managed 主干独立；每批次五门全绿 + Codex 设计门/实现门；migration-0090 companion 测试同步编辑 |
