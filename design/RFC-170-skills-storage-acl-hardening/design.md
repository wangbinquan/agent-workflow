# RFC-170 · 技术设计——skills 存储层与 ACL 一致性加固

状态：Draft。产品视角见 `proposal.md`。本文承接 RFC-169 设计门 R5–R16 累积的完整存储协议（那 12 轮 24 findings 的折法在 169 阶段已逐条推演到收敛边界；本 RFC 独立走自己的设计门 + 用户批准后实现）。

## 0. 结论速览

- **migration ×1**（详见 §10；设计门第 1–2 轮扩定）：**9 ALTER**（六类 ACL 资源表各 `acl_revision INTEGER NOT NULL DEFAULT 0` + `fusions.precondition_token TEXT` + `skills.meta_revision INTEGER NOT NULL DEFAULT 0` + `skills.migration_marker`）**+ `skills.reservation_state TEXT NOT NULL DEFAULT 'ready'`（G2-5 存量即 ready）+ `skills.version_state`（G2-4，存量 managed backfill 'legacy-unbackfilled'）+ 专表 `skill_operations`（G2-2 两段提交状态机：op_id/kind/phase/active partial-unique/backup/candidate/generation）**；撞 `upgrade-rolling` journal 计数锁 89→90 bump（[reference_migration_bumps_journal_count_test]）。**全套 token/snapshot/reservation/OCC 语义仅适用 managed skill**（G2-1 三类权威模型：source-backed external=外部 SKILL.md 权威、hand-imported external=DB metadata 权威，二者只受 §7/§8 保护）。
- **不透明复合前置 token**：后端编码 `skillId + contentVersion + metaRevision`，前端只透传；读侧新增字段向后兼容、写侧必填缺失 400。
- **封闭 mutation inventory = 6 版本写 + 6 身份/生命周期写**（§5），前置三分法：版本写=token+事务内重读 ACL；actorful 身份写=expected skillId+事务内重读 ACL；actorless 例外仅一处=system reconcile 的「owner 未脱离 registrar 的目录客观消失删除」。
- **版本快照唯一权威、live 只是可重建投影**：rename 原子发布、崩溃/在线失败从快照重建、修不好在线 quarantine（含运行时注入）。
- **读语义有意收敛（G1-1 勘误，非「零新产品语义」）**：读路径从「`files/` live 为真值源」收敛到「version snapshot 为唯一真值源、live 是可重建投影」——detail content / file·tree GET / fusion base / runtime stage 一律取 token 指向的快照内容；这是**有意的一致性语义变更**，用户可见差异仅在「带外直接改 live 文件」这一非受支持路径（此前会被读到，现改为进「待迁移决策」或 quarantine）。其余纯后端存储/ACL 加固；前端少量适配（token 透传、409 横幅、待迁移决策 UI）。

## 1. 不透明复合前置 token（V1）

纯 `contentVersion` 不是不可复用世代标识：同名删除重建后版本号从低位重来，旧 `{name, version}` 会与新资源 **ABA 重匹配**；仅改 DB 元数据也不推进文件版本，旧 ZIP decision 照样通过。

- token 由后端编码 `skillId + contentVersion + metaRevision`（不透明字符串，前端只透传）；
- 读接口回带；写侧必填（缺失 400 fail-closed），任一分量不匹配 409；
- `metaRevision` 只涵盖表单/ZIP 可写的 meta 字段——ACL/owner 变更不进 revision、不干扰正文保存（ACL 一致性由 §8 的 `aclRevision` 独立管）。
- **metaRevision 派生（设计门定案，2026-07-13）**：新增 `skills.meta_revision INTEGER NOT NULL DEFAULT 0` 列（migration ×1 同批），由后端在**写表单/ZIP 可写 meta 字段**（当前仅 `description`；未来若表单加字段一并纳入）的同一事务内 `+1`；`contentVersion`/`ownerUserId`/`visibility`/`sourceKind`/路径 等**不**触发 bump。选**单调计数列**而非「meta 内容哈希」：① 计数与 `contentVersion` 同形（都在 skills 行、同事务推进、崩溃恢复语义一致）；② 哈希无法区分「A→B→A 改回原值」的中间态，计数可；③ 前端只透传不透视，列的不透明性由 token 编码保证。**取值锚点**：token 编码时取 `skills.content_version` 与 `skills.meta_revision` 两列快照；CAS 校验在最终写事务内对同两列 `SELECT ... FOR` 比较（bun:sqlite 无行锁，用 `UPDATE ... WHERE content_version=? AND meta_revision=?` 的影响行数=0 判 409）。
- **line-number 校准（2026-07-13 对当前源码复核）**：`commitSkillVersion` 现在 `skillVersion.ts:272`（先 `rmSync(versionDir)`+`cpSync(staging→versionDir)`〔:318-320〕再 `rmSync(filesDir)`+cpSync 回 live——V3 非原子成立）；`approveFusion` 存 `skillName`+`baseSkillVersion: skill.contentVersion`〔`fusion.ts:495-496`〕不存 skillId——V1/V2 成立；`updateResourceAcl`〔`resourceAcl.ts:252`〕`requireResourceOwner`→直写无 CAS——V8 成立；`deleteSkill(db,opts,name)`〔`skill.ts:197`〕按 name 无 skillId——V7 成立；SKILL.md 词法+realpath/inode 守卫已在 RFC-169〔`services/skill.ts` `assertNotSkillMainFile`〕落地，V10 仅剩需预置 symlink 的间接身份边角。

## 2. 六条版本写 + 单 fenced read + combined-save（V2）

**保存协议入口整体在本 RFC**（RFC-169 slim 复审第四轮定案：基础 contentVersion CAS 叠在现状非原子发布上不安全——5xx 后重载读「新版本号 × 残缺正文」、下次 CAS 反铸更高版本永久回退，必须与本 RFC 的快照权威 + rename 原子发布**同时**落地才安全；169 因此保存/读取沿用现状 double-PUT LWW，把整套保存协议留给本 RFC）。本 RFC 一并落地：**单 fenced detail-read**（一响应回带 `{description, bodyMd, 复合 token}`、`ready` gate/双查询播种退役）+ **combined-save 单请求**（新增路由，`loadVisibleSkill`+`requireResourceOwner`；wire 契约 409/422=提交前可重试、5xx=提交不确定需重载；managed 版本 funnel、external metadata-only）+ **复合 token CAS**，并把 OCC 扩到全部六条版本写：

1. **combined-save**（本 RFC 新增：单请求 + 复合 token CAS，见上；169 沿用现状 double-PUT LWW）；
2. **file PUT**、3. **file DELETE**、4. **restore**——现调 `commitSkillVersion` 均不带 expectedVersion（`skill.ts:381-442`、`skillVersion.ts:472-515`），补 token 校验；
3. **ZIP overwrite**——现直接删写 live 只动 metadata、不推进版本（`skill-zip.ts:251-309,348-381`），纳为版本写：决策阶段读取的版本为 token、经 `commitSkillVersion` 落版本；ZIP 解析响应与 overwrite decision **逐候选携带同一 token**（shared decision schema 增补字段，`schemas/skill.ts:223-258` 现无）；stale 冲突取**候选级失败**（该候选 409、其余照常，避免部分提交后全局 409）；
4. **fusion 审批**——现以 `skillName+baseSkillVersion` 提交、不存 skillId 不复核 owner（`fusion.ts:751-766`）：发起时持久化完整复合 token（migration 的 TEXT 列）、批准**同事务** CAS 状态+token+skillId+actor owner/admin 权限，再提交版本与 memory provenance；存量无 token 的待审批行 fail-closed（提示重发起）。

**读一致性（double-read fence）**：读文件与读版本之间可被并发写插入——读路由「读版本→读内容→复核版本未变，变则重试一次再不一致 503」，杜绝「旧 live × 新 token」错配。

## 3. 版本快照唯一权威 + 原子发布 + 崩溃恢复 + quarantine（V3/V4）

`commitSkillVersion` 现「先 DB/版本快照、后 `rmSync(live)` + 递归 `cpSync`」——磁盘满/中途崩溃留「token=N、live 半棵树」的稳定错配。修正为**版本快照唯一权威、live 只是可重建投影**：

1. **发布原子化**：新树先写临时目录、`rename` 原子换入（跨 OS 落地见 §13）；
2. **在线失败即修即隔离**：DB 已提交后换入失败**不能只回 5xx 等重启**（daemon 存活期「token=N、live=N-1」double-read 识别不了）——失败当场同步从快照重建 live；重建也失败 → 该 skill **立即在线 quarantine**（读/写一律 fail-closed 503/409）；
3. **quarantine 盖住运行时注入**：`scheduler.resolveSkills` 直读 managedPath、两 runtime 从 live stage（Claude 还是 best-effort）——只拦 API 不够。**双检查点**：pre-spawn 技能解析层按 skillId 判 quarantine + skillId/generation 随 `ResolvedSkill` 传到共享 `stageSkills`、于 cpSync/symlink 前最后校验（`prepareNodeRunInjection`〔`scheduler.ts:5981`〕→ semaphore/隔离区/runtime 解析长窗口 → `stageSkills`〔`stageSkills.ts:51-57`〕之间 quarantine 落下时已生成的 ResolvedSkill 不会再查，故必须传到最终 stage）；命中即任务启动 fail-closed；
4. **启动恢复**：检测到不一致时**从 token 指向的版本快照重建 live**（绝不从不一致 live 生成版本）；快照亦损 → degraded 隔离拒写、不吞错放行（现 `skillVersion.ts:536-552`/`cli/start.ts:276-286` 逐 skill 吞错启动对此收紧）。

## 4. 存量分叉待迁移 + 多代候选（V5）

升级前的 live 分叉可能是**合法用户内容**（旧 ZIP overwrite 不推进版本、既有「fs 为真值源」契约下的手工编辑；现恢复器正因此不覆盖 existing-but-different live，`skillVersion.ts:527-534`），自动重建会**静默回滚**。首次发现「未迁移标记 + live≠快照」时**不自动覆盖**：

- 进入「待迁移决策」态：**普通内容读取返回快照且不签发写 token**（读 live 配 T(N) 就是协议禁止的稳定错配、缓存 token 决策后可重放复活被丢弃分叉）、live 走**专门预览接口**（不签发 token）、写一律拒绝；
- UI 二选一：「采纳当前文件树生成新版本」/「恢复到最近版本快照」；
- **决策绑定不可变候选（线性化点=决策前无条件原子捕获）**：SQLite 事务冻结不了外部文件系统，对 mutable live 复核 hash 只是 check-before-use（复核后、复制前手工写仍插入）；且 rename 只改路径不构成不可变（rename 前打开的旧 fd 仍写同 inode）。协议：决策固定序列「持久化 phase journal → **无条件** rename 当前 live 为候选目录 → 从快照重建 live → **复制出隔离快照**（copy 后 fsync，比较/提交只对副本）→ 在隔离快照上比较基线」；
- **多代候选状态机**：捕获后对新 live 的手工编辑（L1）不能靠「migrated 后再检测」接住——决策发布/落标记前同一原子步骤比较，已分叉先把隔离快照登记为**下一代持久候选**、保持 pending（本次决策照常完成但**不落 migrated**），仅无未捕获分叉才标 migrated；原候选目录保留追踪为「可能仍被旧句柄修改的 generation」不清理；
- 决策提交同事务复核 skillId+token+pending+候选指纹，通过则原子 CAS 推进新世代（旧 token 必 409、相反决策并发只成其一）；各 phase kill/restart 幂等续跑。

## 5. 封闭 mutation inventory（managed 6 版本写 + 6 身份/生命周期写 + 第 13 类 lazy backfill）

> **设计门 G1-4/G2-4 补**：第 13 类 = `ensureInitialSkillVersion` 的 **lazy v1 backfill**（GET versions/内容/diff/restore/boot 均可触发，`skillVersion.ts:204-244`）——它是**建立**首 token 的路径，特判：仅 `version_state='legacy-unbackfilled'` 的 managed skill 允许，走 §4 durable candidate 协议（非无条件 cpSync），成功签首 token + 置 `'snapshot-authoritative'`。**下列版本写/身份写全部限定 managed skill**（G2-1：external 两类不套 token/snapshot，只受 §7 source 生命周期 + §8 aclRevision）。

**版本写①–⑥**：见 §2。**身份/生命周期写⑦–⑫**：

- ⑦ **资源级 DELETE**：现按 name 无前置——旧 `/skills/foo` 页面在 foo 删除重建后能删掉新 skillId 的资源与全部版本历史。DELETE 必带详情读取到的 skillId，不匹配 409；
- ⑧ **源冲突 replace**：现先删 occupier（整目录+DB 行，`skill.ts:216-227`）再全源 reconcile（`skill-source.ts:380-389`），中途失败旧毁新未导。改为**可回滚交换 + journal**（§6）；
- ⑨ **迁移决策**：§4，skillId+token+pending+候选指纹 CAS；
- ⑩ **source 生命周期**：§7；
- ⑪ **ACL PUT**：§8；
- ⑫ **技能创建**：§9。

**前置三分法**：版本写=token+最终事务内重读 ACL；actorful 身份写=expected skillId+最终事务内重读 ACL；**actorless 例外仅一处**=system reconcile 的「owner 未脱离 registrar 的目录客观消失」删除分支（skillId CAS、无 ACL）。这是**唯一 mutation inventory**——新增写入口必须先入册。

## 6. conflict-replace 可回滚交换 + replacing 世代互斥（V6）

- **任何目录移动前先持久化 replace journal**（phase、旧/新 skillId、source kind、路径、备份位置——落 migration 存储面）；
- 预先完整验证候选 → 原 occupier **rename 为可恢复备份**（目录+版本历史保留）→ 单一可恢复状态机完成 DB 身份交换 → **新资源落库可读后**才清理备份与 journal；任一步失败回滚到旧资源完整可用；
- **journal 创建即原子 CAS 资源进入持久 `replacing` 世代**——六条版本写、其余身份写与 lazy recovery 的**最终提交都检查该状态**（replacing 中一律 409），否则「文件写先持 token 完成 staging → replace 落 journal → 文件写最终提交仍见旧 token 有效 → 发布 canonical」会抹掉一个已返回成功的写；
- **boot/lazy 依据 journal 幂等恢复**（否则「备份已 rename、DB swap 未落」时进程死=旧行指向缺失路径、同名 occupier 挡住重导，旧新双不可读）。

## 7. source 生命周期 ACL（V7）

source 禁用/删除/手动 rescan/懒加载与启动 reconcile 都会删/改 skill 行（`skill-source.ts:275-284,299-320,428-552`；`skill.ts:50-56` 连列表 GET 都触发 reconcile），现只验 source registrar 身份——skill ACL 转移后旧 registrar 仍能删/改新 owner 资源。`reconcileSource` 显式拆 **user(actor) / system 两模式**：

- **(a) 一切用户触发的 source 操作**（remove / disable / **enable**〔false→true 调 reconcile〕 / rescan / **conflict-replace**〔全源 reconcile〕）统一走 user 模式——逐 child 最终事务 CAS skillId+sourceId **并复核 actor 对该 skill 的 owner/admin**；无权限的 child 跳过修改/删除、标 orphaned、结果列明（部分成功报告），不静默越权；
- **(b) system reconcile**（boot/lazy/GET 触发）**逐分支前置**：新资源创建=按 registrar 名义允许；**已有 child 的更新写回**（现同源分支写 description/externalPath/updatedAt，`skill-source.ts:507-517`）须以 registrar 身份复核当前 owner/admin，转移后无权限则跳过写回或标脱离 source；**actorless 例外**=「目录客观消失」删除，且**仅当 skill 当前 owner 仍等于 source registrar**（否则旧 registrar transfer 后删子目录、等 GET reconcile 代删——skillId CAS 防不了定向删除）——已转移 child 目录消失只标 orphaned/degraded，删除走 actorful 资源 DELETE。

## 8. ACL PUT `aclRevision` 六资源 CAS（V8）

`PUT /api/*/acl` 现「预检后按 stale row 写 owner/grants」（`resourceAcl.ts:46-65`、`services/resourceAcl.ts:259,307-328`，无事务内重读/CAS）：

- 预检后暂停、管理员 transfer、恢复提交把 stale `nextOwner` 写回**夺回所有权**；
- 且 owner 不变的迟到写同样致命——`userIds` 是 full-replace，撤销后的迟到提交可恢复已撤销授权/重新公开资源，expected owner 挡不住；

修复（**共享服务、全六类 ACL 资源含 workgroup 同时受益**）：ACL GET 统一返回、PUT 必带 `expectedResourceId` + **单调 `aclRevision`**，共享服务同一事务内比较并推进 revision、更新 owner/visibility/grants。

## 9. 技能创建 reservation（V9）

managed create 先写共享 `skills/{name}/files` 再插行（`skill.ts:84-118`）、ZIP create 同样（`skill-zip.ts:296-309,348-409`）：两窗口同见名称空闲时，输掉唯一约束的请求已覆盖赢家 live。创建列为独立 mutation 类：**原子保留 name+skillId（DB 行先行）→ 操作专属 staging 目录构建 → 仅 reservation owner 发布（原子换入）→ 失败只清自己 staging**。

## 10. migration

单个 migration 文件（多语句 `--> statement-breakpoint` 分隔，[reference_migration_statement_breakpoint]），**9 ALTER + 1 CREATE TABLE**（设计门第 1–2 轮扩定）：

- **六类 ACL 资源表**（agents/skills/mcps/plugins/workflows/workgroups）各 ADD `acl_revision INTEGER NOT NULL DEFAULT 0`（§8 aclRevision CAS）；
- `fusions` ADD `precondition_token TEXT`（发起时完整复合 token；存量行 NULL → 待审批 fail-closed 提示重发起）；
- `skills` ADD `meta_revision INTEGER NOT NULL DEFAULT 0`（§1 metaRevision 单调计数；存量=0 与首 token 一致）；
- `skills` ADD `migration_marker TEXT`（§4 存量分叉终态标记：`NULL`=未评估 / `'migrated'`=live≡快照已确认 / `'pending-decision'`=分叉待迁移决策）；
- `skills` ADD `reservation_state TEXT NOT NULL DEFAULT 'ready'`（G2-5：存量行即 ready 可见，`getSkill`/list/scheduler 过滤非 ready）；
- `skills` ADD `version_state TEXT NOT NULL DEFAULT 'legacy-unbackfilled'`（G2-4：`'legacy-unbackfilled'|'snapshot-authoritative'|'quarantined'`；本 migration 对**已有 `skill_versions` 行的 managed skill** UPDATE 为 `'snapshot-authoritative'`，其余 managed 留 `'legacy-unbackfilled'` 待首采纳；external 行此列语义不适用/忽略）；
- **CREATE TABLE `skill_operations`**（G2-2 两段提交状态机）：`op_id TEXT PK, skill_id TEXT, kind TEXT('reserve'|'replace'|'migrate'|'delete'), phase TEXT('intent'|'fs-staged'|'fs-published'|'db-committed'|'done'), active INTEGER, backup_path/next_skill_id/candidate_path/candidate_fingerprint/generation/owner_user_id/created_at`；**partial unique index `ON (skill_id) WHERE active=1`**（同 skill 单活动操作）；**无 `skills` FK cascade**（DELETE 不得清它）。存量资源**不补** `skill_operations` 行（只记新协议活动操作）。

撞 `upgrade-rolling` journal 计数锁 **89→90** bump（标题+断言+注释，[reference_migration_bumps_journal_count_test]）。**注**：token/snapshot/reservation/version_state/skill_operations 全套仅服务 managed skill（G2-1）；`acl_revision` 覆盖全六资源全类型。

## 11. 测试矩阵（承接 169 的 ㉖–㊲）

- ㉖单 fenced read 无 meta×content 错配 + 连续保存均成功 + 并发改描述 CAS 409；
- ㉗跨窗口文件写/删/restore 版本栅栏 409；
- ㉙双向+世代 OCC：ZIP×四类写双向 + ZIP×ZIP + 同名删除重建 ABA + 仅元数据 + 缺 token 400；
- ㉚崩溃/异常注入（rename 前/复制中/cpSync 抛错 + 各 phase kill/restart）→ 快照重建 + 旧 token 409；rename 失败 daemon 存活→在线重建/quarantine；快照亦损→degraded；旧 ZIP overwrite 升级不丢；候选捕获后手工改→L1 下代候选可采纳+逐字节一致+恢复留档；resolve→quarantine→stage 交错拒；两 runtime 拒注入；
- ㉜fusion OCC：ABA/仅元数据/owner 变更同事务屏障 + 重启 token 有效 + legacy row fail-closed；
- ㉞身份级 DELETE：同名重建后 DELETE 必拒（skillId）+ 版本历史无损 + 全写入口「预检→transfer→提交」屏障；
- ㉟source 生命周期：remove/disable/enable/rescan/replace 对无权限 child 跳过标 orphaned + system reconcile 目录消失+owner=registrar 才删 + owner-transfer 后磁盘元数据不写回 + conflict-replace 三注入点×各 phase kill-restart×三类 occupier 旧新必有其一完整；
- ㊱ACL PUT：同 owner 迟到 grant/visibility 写必拒（aclRevision）+ transfer + 删除重建 ABA + workgroup 路径；rename 前开 fd 比较后写→晚到编辑进追踪 generation 不丢；
- ㊲创建 reservation：create×create / create×ZIP / create×system-reconcile 只 reservation owner 发布 + replacing 世代互斥（journal 落地后一切最终提交 409）。

## 12. 设计门记录（承接 RFC-169 R5–R16）

本 RFC 的协议是 RFC-169 设计门 R5–R16（Codex adversarial-review，2026-07-11）逐轮推演的产物——12 轮、24 findings（high/medium），每轮针对上一轮折法的洞，收敛趋势 3→3→2→3→3→4→3→2→2→3→3→4（findings 数）。关键里程碑：

- **R5–R7**：contentVersion CAS 需绑正文快照 + PUT 回带新版本；文件域全域 OCC；发布方向修正为「快照唯一权威」（否决「固化 live」防半棵树成权威）。
- **R8–R10**：在线失败即修即隔离；复合 token 挡 ABA；接受 migration ×1（撤销零 migration，正确优于最小）；combined-save 唯一规范。
- **R11–R13**：全部写路径最终事务内重读 ACL；单 fenced detail-read；封闭 mutation inventory；source 生命周期入册；不可变候选捕获。
- **R14–R16**：多代候选状态机（无条件原子捕获线性化）；conflict-replace 可回滚交换 + replacing 世代互斥；ACL PUT aclRevision 六资源；创建 reservation；fd 级冻结（隔离快照）。

**本 RFC 独立走自己的设计门**：以上折法是 169 阶段的推演基线，170 立项后需对照当前源码重新验证一遍（部分行号可能已随并发 RFC 漂移），并跑满血 Codex 设计门直到 approve，再请用户批准实现。RFC-169 UI 域自 R2 起四轮收敛、R5 后零发现——这也印证了拆分的正确性：UI 与存储是两个正交的收敛域。

## 14. 170 独立设计门——第 1 轮（Codex adversarial-review，2026-07-13）

verdict **NOT APPROVED：7 P1 + 3 P2**。全部采纳，逐条折入下方；折法待第 2 轮复审。核心教训：R5–R16 的「推演基线」在**读路径权威边界、遗漏写入口、崩溃持久状态**三处不闭合——对照当前源码才暴露。

### G1-1（P1-1）快照权威只在 DB 版本上闭合、live 内容漂移仍被签成权威

**洞**：double-read fence（§2/design.md:32）只复核 `content_version` 未变；但同 generation 内 live 被本地编辑器/其他进程改成 B（DB 版本不动、无 quarantine）时，detail GET（`skill.ts:252-272`/`326-380`）、fusion base（`fusion.ts:448-454`/`844-846`）、runtime stage（`scheduler.ts:5998-6017`→`stageSkills.ts:33-57`）都读 live，会把 B 签成 `T(id,N,M)` 权威、后续铸成 N+1 或直接注入。且与现权威产品文档「`files/` 是真值源」（proposal.md:59-69）矛盾——**「零新产品语义」声明作废**：snapshot 权威**本身就是**一次产品语义变更，必须显式承认。
**折**：① §3 升级为**读路径快照权威**——detail content GET / file·tree GET / fusion base / runtime stage 的**内容种子一律取 token 指向的 version snapshot**（不再读 live）；live 降为「可重建投影 + 写 staging 的工作区」，非读源。② 签 token / 注入前对 live 做**snapshot identity 校验**（对 live 树做与 §3 同款 hash，与 token 版本快照 hash 比对）：不一致 = 存量分叉（进 §4 pending 决策）或在线漂移（即修即隔离/quarantine），**绝不签 token 也绝不注入漂移内容**。③ proposal §非目标改口：删「零新产品语义」，改为「读语义从『live 为真值源』收敛到『version snapshot 为唯一真值源、live 是投影』——这是有意的一致性语义变更，用户可见行为差异仅在『带外直接改 live 文件』这一非受支持路径」。

### G1-2（P1-2）migration 未承载设计要求的持久 journal / replacing / reservation / orphaned 状态

**洞**：多代候选 phase/路径/指纹/generation（§4）、replace journal + 持久 `replacing` 世代（§6）、creation reservation owner/ready（§9）、per-child orphaned/degraded（§7）都要求**持久化**，但 migration 只列 fusion token + `meta_revision` + 三值 marker + 六表 `acl_revision`；`skills` 行无 operation phase / reservation readiness / candidate path / replacing owner（`schema.ts:301-330`）。且 reservation 复用普通 `skills` 行不安全——`getSkill` 视任何行可读（`skill.ts:63-66`）、scheduler 立即 stage（`scheduler.ts:6005-6017`）。fd-after-rename 的下一代候选无 durable transition，字节可能物理存在却永不可采纳。
**折**：migration 扩为**新增专表 `skill_operations`**（`skill_id, kind('reserve'|'replace'|'migrate'), phase, backup_path, next_skill_id, candidate_path, candidate_fingerprint, generation, owner_user_id, created_at`，boot/lazy 依此幂等前滚/回滚）+ `skills` 加 `reservation_state('ready'|'reserving'|NULL)`（`getSkill`/list/scheduler 一律**过滤非 ready**，reservation 期间对读者不可见）+ §4 候选与 replacing 落 `skill_operations` 行、`migration_marker` 只做「已确认 live≡快照」终态标记。fd 问题：候选 generation 在 `skill_operations` 持久追踪，**boot 时对每个未清理候选目录重新 hash → 若较上次记录指纹变化则登记为下一代 pending 候选**（late-fd 写入不丢、可最终采纳或留档），清理仅在「无变化且已被更高代取代」时。

### G1-3（P1-3）资源 DELETE 有摧毁唯一权威快照的崩溃点（数据丢失）

**洞**：现顺序 `rmSync(skills/{name})`（含 live + 全部 `versions/` 快照，`skillVersion.ts:46-57`）→ await DELETE DB 行（`skill.ts:218-229`）。步 2 后、步 3 前崩溃 → DB 仍指 N、live 与唯一权威快照全消失 → boot 只能 degraded，实质数据丢失。§ DELETE 只加 skillId + ACL 重读，无崩溃协议。
**折**：DELETE 改**tombstone/journal 三段**：① 同事务写 `skill_operations` kind='delete' phase + 把 `skills/{name}` **rename 到 `skills/.trash/{skillId}-{ulid}`**（原子、不删数据）；② DELETE DB 行；③ 清理 trash + journal 行。任一步崩溃 boot 依 journal 幂等续：phase<DB-delete 且 trash 在 → 可回滚（rename 回）或前滚（补 DB delete + 清 trash），**快照在 trash 中始终可从 token 重建**，无丢失窗口。

### G1-4（P1-4）封闭 inventory 遗漏 GET/boot 可触发的 lazy v1 版本写 + 缺 legacy-无快照迁移分支

**洞**：`ensureInitialSkillVersion`（`skillVersion.ts:204-244`）把 mutable live 复制成 v1 + 更新 `content_version` + 插 `skill_versions`，由版本列表/内容/diff/restore/boot recovery 触发（`skillVersion.ts:365-450`/`536-552`、`routes/skills.ts:238-255`）——是 RFC-101 有意的 rolling-upgrade lazy backfill（`0047_...sql:16-19`）。它绕过 pending-candidate/token/ACL/replacing 检查直接把 live 铸权威；若一律判「无快照=损坏」则合法 legacy skill 被永久 quarantine。
**折**：① `ensureInitialSkillVersion` **纳入 mutation inventory 第 13 类「lazy backfill 版本写」**，走与 §2 版本写同款事务闭合（token 不适用——它是**建立**首 token 的路径，故特判：仅当 `content_version` 尚未初始化才允许，成功即签发首 token）。② 新增**显式迁移分支「legacy managed skill 无 snapshot」**：首次遇到「managed + 有 live + 无任何 `skill_versions` 行」→ 视为合法待 backfill（非损坏），把当前 live 作为 v1 快照**一次性**采纳（记 `migration_marker='migrated'`），此后 live 漂移才进 §4 pending。boot recovery 的「snapshot 缺失」判损坏收紧为「有 `skill_versions` 行但对应快照目录缺失/损坏」。

### G1-5（P1-5）description 双权威未闭合、metaRevision writer 集合不完整

**洞**：`description` 同存 `skills.description`（`schema.ts:304-307`）与快照 SKILL.md。restore 全量复制旧快照却不 `setDescription`（`skillVersion.ts:484-514`）、fusion 全量替换 SKILL.md 不 setDescription（`fusion.ts:751-775`）、source reconcile 直接更新 DB description（`skill-source.ts:507-518`）、旧 `PUT /skills/:name` 仍是独立公开 writer（`routes/skills.ts:152-163`）。→ restore 把 SKILL.md 的 D2 恢复成 D1 但 DB 仍 D2、metaRevision 未推进，combined read 用 DB 返「D2+v1 body」、后续保存静默把 D1 改回 D2。
**折**：① **确立 SKILL.md frontmatter 的 `description` 为唯一权威、`skills.description` 降为派生投影**——所有改 SKILL.md 的路径（combined-save / restore / fusion / migrate-adopt / ZIP overwrite）在**同事务**内从新 SKILL.md 解析 description 回写 `skills.description` **并 bump `meta_revision`**（restore/fusion 因内容整体替换、meta 视为变更故 bump）。② source reconcile 写 description 亦 bump（它是 registrar 身份的合法 meta 写）。③ 旧 `PUT /skills/:name`（metadata-only）**改 410 Gone**（前端 RFC-169 已走 double-PUT，将随本 RFC combined-save 迁移；保留旧端点=开着一个绕过 token CAS 的 meta writer）。metaRevision writer 集合 = {combined-save, restore, fusion approve, migrate-adopt, ZIP overwrite, source reconcile}，全部同事务 bump，**封闭**。

### G1-6（P1-6）批次 B 非安全独立部署单元——creation reservation 必须并入 B

**洞**：reservation 在批次 C（plan.md:22-27），但批次 B 已宣布 snapshot 权威 + 开放新写协议（plan.md:12-20）。现 create 仍「await 名称预检 → 直写共享 canonical live → await 插行 → initial commit」（`skill.ts:86-130`），ZIP create 同（`skill-zip.ts:296-309`/`348-409`）：A/B 同见名空闲 → A 写 live=A、B 覆盖 live=B、A 赢 unique insert → A 的 initial commit 把 **B 的内容**铸成 A 的权威 v1（且 B insert 在 try 之前失败、cleanup 都不执行，`skill.ts:108-134`）。批次 A（schema + 纯 codec）单独部署无泄漏（T3 token 读仍在 B）。
**折**：plan.md **把 creation reservation（T12 的创建部分）上移进批次 B**（与快照权威 + 版本写协议同批不可分割）——create/ZIP-create 改「reservation 行先行（`reservation_state='reserving'`，对读者不可见）→ 操作专属 staging 构建 → 仅 reservation owner 原子发布（rename staging→canonical）+ 置 ready → 失败只清自己 staging + reservation 行」。批次 A 维持「schema + 纯 codec」纯地基定性。

### G1-7（P1-7）V10 realpath/inode 已在 169 落地、真正剩余风险是 snapshot ingestion 的 symlink 策略

**洞**：§13 说本 RFC 补「realpath/inode 等于主文件则拒」，但 169 已完整做了 realpath + dev+ino（`skill.ts:470-513`）——fold 与源码不匹配。真实剩余：live 预置 `SKILL.md`→外部 mutable 文件的 symlink，snapshot 遍历/hash 跳过 symlink（`skillVersion.ts:84-106`）、树复制无 reject/deref 规则（`skillVersion.ts:300-320`）、内容读却跟随 symlink（`skill.ts:259-265`）→ 外部 target 改变后版本/hash 不变但 GET/runtime 内容变，可成读取/注入泄漏。
**折**：§13 删「realpath/inode（169 已做）」，改为**定义 snapshot ingestion 的 symlink 策略**：`commitSkillVersion` 采集快照时**遇 symlink 一律 reject**（write 拒绝、迁移采纳时该 skill 进 quarantine 待人工），杜绝「版本快照含 symlink」；已存量含 symlink 的 live 在首次快照采纳时判 quarantine。读路径改快照权威后（G1-1）自然不再跟随 live symlink。

### G1-8（P2-1）quarantine 终检需权威查询 + Claude fail-closed 精确定义（best-effort catch 之外）

**洞**：`ResolvedSkill` 只有 name/kind/path（`runtime/types.ts:41-46`）、`stageSkills` 无 DB/registry 参数；且 per-skill copy 在 try/catch 内、Claude `bestEffort=true` 吞异常继续 spawn（`stageSkills.ts:51-63`、`claudeCode/config.ts:31-39`）。若把 quarantine check 放现有 try 内，`resolve→quarantine→Claude stage` 只记 warning、任务继续启动。
**折**：① `ResolvedSkill` 加 `skillId` + `generation`（pre-spawn 解析层填）；`stageSkills` 加 `db`/registry 参数，**stage 前对每个 skill 用 skillId 同步查权威**（当前 canonical 是否仍是该 skillId/generation + 是否 quarantined）。② 该终检 + identity 校验放在 **best-effort catch 之外**（用专用不可吞的 `SkillQuarantinedError`，Claude 路径也 fail-closed 拒启动），best-effort 仅覆盖「真实拷贝 IO 抖动」而非「权威/隔离判定」。

### G1-9（P2-2）ACL GET 可返回从未存在的混合快照（owner R × grants R+1）

**洞**：route 先 await 加载 row、service 再分别 await grants/users（`routes/resourceAcl.ts:36-43`、`resourceAcl.ts:212-243`）。并发 PUT 提交 owner=B/grants=G2/rev=R+1 时，GET 可读到旧 owner A/rev R + 新 grants G2。不致越权写（下次 PUT 的 R 会 409），但 UI 收到不存在过的状态。
**折**：`getResourceAcl` 改**单同步只读事务**（`dbTxSync`）一次读 row+grants+revision，或 revision double-read（读前后 revision 一致才返回）。`updateResourceAcl` 的 `prevOwner` 与当前 grants 必须在 **CAS 成功的同一事务快照内**计算，不再用 route 传入的 stale `row`（`resourceAcl.ts` auto-append previous owner 逻辑同步收进事务）。

### G1-10（P2-3）§13 恢复后置条件「某个完整版本」弱于 snapshot 权威

**洞**：§3 要求恢复 token 指向的快照，§13 只锁「收敛到某个完整版本」。若 DB 已提交 N+1、旧 live rename 为 `files.old-*`、新树未 rename 就崩溃，boot 按 §13 选完整的 old=N → DB=N+1，版本 double-read 稳定通过 → 返回/注入「内容 N × token N+1」。
**折**：§13 恢复后置条件收紧为**「canonical 精确等于当前 DB token 指向、且 hash 校验通过的 version snapshot」**；`files.old-*`/`files.next-*` 只作清理/诊断材料，**boot 一律从 token 指向的 snapshot 重建 canonical**（绝不任选一个完整树），重建后 hash 必须匹配否则 quarantine。

**migration 规模勘误（结论表 #9）**：所称「四列」实为 **9 个 ALTER**（六表各一 `acl_revision` + fusion `precondition_token` + `skills.meta_revision` + `skills.migration_marker`）+ 本轮新增 **`skill_operations` 专表 + `skills.reservation_state`**；仍是单 migration 文件（多 `--> statement-breakpoint`），journal 89→90、`upgrade-rolling.test.ts` 计数锁 bump。`precondition_token` NULL / meta·acl default 0 / marker NULL 默认值方向正确（存量 fusion 行无 token → fail-closed 提示重发起；存量 skill meta_revision=0 与首 token 一致）。

**第 1 轮采纳后待复审的新增面**：读路径快照权威（G1-1）改动 GET/fusion/runtime 三处大接口 + 产品语义声明；`skill_operations` 状态机（G1-2/3）的 boot 幂等续跑正确性；metaRevision writer 全事务 bump（G1-5）与 combined-save 的交互；reservation 上移批次 B（G1-6）后批次 B 的可部署性再确认。**下一轮 Codex 设计门针对这些折法再攻。**

## 15. 170 独立设计门——第 2 轮（Codex adversarial-review，2026-07-13）

verdict **NOT APPROVED：6 P1 + 5 P2**。方向确认变好——**G1-7（symlink reject）/G1-8（fail-closed 位置）/G1-10（精确恢复 token 快照）核心折法已 sound**；G1-5 managed writer 集可闭合。但第 1 轮折法在**跨 FS/DB 崩溃原子性、external 全类型权威、写 staging 权威源、存量行迁移 backfill**四处暴露新洞。逐条折入。

### G2-1（P1-6，最根本）「全 skill 以 snapshot 为唯一权威」破坏 external skill——必须按类型拆权威模型

**洞**：现有产品契约（proposal.md:65）三类权威不同——managed=平台复制目录、external=用户目录为真值 runtime symlink、project=runtime 自发现；版本 funnel 明确拒 external（`skillVersion.ts:281`）、stage 对 external 建 symlink（`stageSkills.ts:52`）、UI 允许改 external description 但禁改其 SKILL.md/body/files（`skill-capabilities.ts:24`）。G1-1/G1-5 无条件覆盖 external → external 直接失去技能或被固定到不存在的 snapshot。
**折（三类权威模型，本 RFC 全篇据此重写）**：

- **managed**：version snapshot 唯一权威、`skills.description` 为投影、走 token/OCC/quarantine/snapshot generation 全套（本 RFC 主体）；
- **source-backed external**（`sourceId != null`）：**外部 SKILL.md 为权威**、reconcile 更新 DB 投影；本 RFC 只给它 **source 生命周期 ACL（§7）+ ACL aclRevision（§8）**，**不**套 token/snapshot/quarantine（它没有 platform 版本快照）；runtime 继续 symlink 外部 live path；
- **hand-imported external**（`sourceId == null`）：**继续 DB metadata 权威**（description 可改、body/files 只读），本 RFC 不改其读写语义、只受 aclRevision 保护。
  所有 §1–§6/§9 的 token/snapshot/reservation/OCC 语句**限定词补「managed」**；§7/§8 覆盖全类型。runtime stage 对 external 仍走 live external path、**不进** managed quarantine/generation 检查（G1-8 的终检按 kind 分流）。

### G2-2（P1-1）`skill_operations`+rename 非跨 FS/DB 原子——须「先 COMMIT durable intent，再做 FS side effect」+ 真状态机

**洞**：「同事务写 journal + `renameSync`」无跨 SQLite/FS 原子性——journal 写在 SQLite 事务内、rename 是 FS 副作用；序列「写 journal → rename 成功 → COMMIT 前崩溃 → SQLite 回滚、目录已移动 → 重启无 journal、DB 指向已消失 canonical」。且 `kind` 只列 reserve|replace|migrate 却又写 delete（`design.md:136/140`），无 operation id/active 唯一约束/phase 枚举/转移表；并发未闭合（restore 持 N 完成 staging、DELETE 落 journal 移根目录、restore 最终事务只检 token/ACL 未检 active operation → restore 返回成功但结果已被删）。`dbTxSync` 只保同步 DB 事务（`txSync.ts:31`）。
**折（两段提交 + 资源锁 + 封闭最终检查）**：

1. **阶段 1 单独 COMMIT durable intent**：`skill_operations` 行（`op_id ULID PK, skill_id, kind('reserve'|'replace'|'migrate'|'delete'), phase(枚举: 'intent'|'fs-staged'|'fs-published'|'db-committed'|'done'), active(bool), backup_path, next_skill_id, candidate_path, candidate_fingerprint, generation, owner_user_id, created_at`；**partial unique index `WHERE active=1` on `skill_id`**——同一 skill 同时仅一活动操作）先 COMMIT，**再**做任何 FS side effect；
2. **所有 mutation 的最终事务**除 token/ACL CAS 外，**加检「该 skill 无其他 active operation」**（否则 409/冲突）——restore/save/file 写/fusion 全部入此检查，杜绝 restore×delete 交错；
3. FS 副作用（rename/cpSync）后推进 `phase`（每步一次单独 DB COMMIT），**DB-delete 与 phase='db-committed' 同一 DB 事务**；
4. `skill_operations` **不得**被 `skills` 行 DELETE 的 cascade 清掉（无外键 cascade / 显式保留）；
5. **boot 先恢复 operations**（依 phase 幂等前滚/回滚：`fs-staged` 未 published→回滚 rename、`fs-published` 未 db-committed→前滚补 DB）**再**跑现有 source reconcile（`start.ts:263` 顺序前置），否则 reconcile 会在半完成态上误删/误导。

### G2-3（P1-5）G1-1 只修读源、未修写 staging 权威——managed delta 写须从 snapshot 建独占 staging

**洞**：版本 funnel 从 live 预填 staging（`skillVersion.ts:301`）；「先 hash live」是 check-then-copy：hash 后、cpSync 前/中带外改 live → commit 把带外内容连自身 patch 铸 N+1。且「只比 live 与当前 snapshot」不够——两者都被带外改成 B、相等仍会签 token。
**折**：managed delta 写（combined-save/file PUT·DELETE/restore/ZIP overwrite）一律**从 token 指向的 `versions/vN/files` 建独占 staging**（不读 live）、在 staging 上施 patch；**复制后把 staging 基线 hash 与 DB `skill_versions.content_hash` 比对**（权威比对，非 live）。live hash **仅**作漂移检测器（触发 pending/quarantine），**不**承担写线性化或注入正确性。

### G2-4（P1-2）`content_version` 无「未初始化」态——须显式 `version_state`，legacy 首采纳走 durable candidate 协议

**洞**：`skills.content_version NOT NULL DEFAULT 1`（`schema.ts:323`）、RFC-101 对旧行不 backfill 只 lazy 建 v1（`0047_...sql:16`）——「仅 content_version 未初始化才允许」无法区分「合法 legacy（live 有、无 skill_versions）」与「损坏（skill_versions 丢、live 恰在）」；且一次 `cpSync(live→v1)` 不接 §4 candidate 捕获，复制中带外编辑 → 混合快照被标 migrated。
**折**：migration 给 `skills` 加 **`version_state('legacy-unbackfilled'|'snapshot-authoritative'|'quarantined')`**——存量 managed 行 backfill 为 `'legacy-unbackfilled'`（有 skill_versions 的则 `'snapshot-authoritative'`）；legacy 首采纳**走 §4 durable rename→candidate→从 live 建隔离快照→hash→原子 CAS 推进**（与存量分叉同协议，非无条件 cpSync），成功置 `'snapshot-authoritative'`；无法证明为 legacy 的「无 skill_versions 且 version_state 缺失/不符」判 quarantine，不无条件铸权威。

### G2-5（P1-3）`reservation_state` 无存量 backfill——升级会隐藏全部技能

**洞**：`ready|reserving|NULL` + 「get/list/scheduler 过滤非 ready」，但 migration 未定默认/backfill → 存量行升级为 NULL → 从 `/api/skills`、detail、workflow validation、scheduler injection 全部消失。
**折**：`reservation_state` 用 **`NOT NULL DEFAULT 'ready'`**（存量行即 ready 可见）；`skill_operations` **不**需为存量补行（只记新协议活动操作）。

### G2-6（P1-4）批次 B 仍不可独立部署——DELETE 锁/replace journal/旧 PUT→410/symlink reject 必须与 B 同批

**洞**：这四项后端保护留在批次 C，则 B 单独部署仍有确定破口：旧 DELETE 继续 `rmSync` 整根目录（`skill.ts:218`）摧毁唯一快照、source replace 继续破坏性删除后 reconcile（`skill-source.ts:380`）、旧 `PUT /skills/:name` 不 bump metaRevision 改投影使已签 token 继续通过（`routes/skills.ts:152`）、B 的 legacy 首采纳可能在 C 的 symlink reject 前把 symlink 树铸权威（`skillVersion.ts:99` hash 跳过 symlink）。
**折**：plan **把 DELETE tombstone 操作锁、source conflict-replace journal、旧 metadata PUT→410、symlink ingestion reject 全部移入批次 B**（与快照权威+写协议+reservation 同批不可分割）；**完整迁移决策 UI 可留 C**。批次 B 定性更新为「managed 存储安全内核」完整闭合。

### G2-7（P2-1）前端缺 per-skill token 单一持有者——连续 file 写+save 会自冲突 409

**洞**：detail/file-tree/history 独立 query/cache，file PUT 成功只刷 tree/file 不更新 detail token（`SkillFileTree.tsx:70`）→ file PUT 把 T1→T2 后同页 combined-save 仍带 T1 → 自冲突 409，违反验收「连续保存 token 逐次推进不误 409」。
**折**：前端**每 skill 一个 canonical token store**（query cache 单一持有）；file/save/restore 每次成功**原子更新该 token**；SKILL.md 被 restore 改动→重播种 draft；support-file 写因 SKILL.md 受保护、可安全把现有 content draft rebase 到新 token。（此为 combined read/save 前端适配的一部分，写进 §2 前端契约。）

### G2-8（P2-2）fusion reject/re-run 的 token rebase 语义未定义

**洞**：reject/rerun 用「当前 live」作新 diff baseline 却不更新 `baseSkillVersion`（`fusion.ts:839/889`）。改读 snapshot 后二选一必须定死：① token 已 stale=拒 re-run 要求新建 fusion；② 显式 rebase=更新 token + 定义 prior proposal 与新 snapshot 的三方合并。不能「旧整树 proposal 覆盖最新 snapshot 仅更新 token」（吞并发修改）、也不能「取最新 snapshot 保留旧 token」（下一轮 approval 必 409）。
**折**：本 RFC 取**①拒绝语义**（最简正确）——base snapshot 变更后 reject/re-run 检出 token stale 即拒，提示「基线已变，请新建 fusion」；三方合并 rebase 超本 RFC，留后续。

### G2-9（P2-3）G1-9 修混合快照、未关 ACL GET 授权 TOCTOU

**折**：`getResourceAcl` 的 **row reload + visibility/grant 授权复核 + owner/users/grants/revision 装配全部进同一 `dbTxSync` 快照**（不止读一致、授权也在同快照复核），杜绝「route 放行→并发改 private 撤 grant→service 读新 grants→已撤权用户收到成员信息」。

### G2-10（P2-4）全树 identity hash 热路径成本无预算

**折**：① 全量 hash **只在 commit/采纳与 boot 恢复**做；detail/tree/file GET **不**每次全树 hash（读 snapshot 本身即权威、无需 hash）；runtime stage 终检**只验复制出的 snapshot staging 与 DB `content_hash` 一致**（不重扫 live）；② live 漂移扫描改 **boot + 每 generation 一次**（非每请求）；③ file PUT 补与 ZIP 等价的技能总大小/文件数上限（写进 §2）。

### G2-11（P2-5）§14/§15 必须同步回正文/proposal/plan（非纯措辞——否则实现出错误恢复器）

**折（本轮同批执行）**：§0/§10「四列」→「9 ALTER + `skill_operations` 表 + `skills.reservation_state`+`version_state`」；§5 inventory 6+6→**6+6+第 13 类 lazy backfill**（且全部限定 managed）；§13 删「realpath/inode（169 已做）」「恢复到某个完整版本」两处过时合同（已被 G1-7/G1-10 取代）；proposal 验收 migration 描述更新；plan 批次 C 标题去「创建」。

### G1/G2 逐项状态

G1-7/G1-8/G1-10 **sound（核心）**；G1-5 **managed 侧 sound**（external 侧并入 G2-1）；G1-9 **并入 G2-9**；G1-1 **读源 sound、写 staging+external+前端 token 并入 G2-1/3/7**；G1-2/G1-3 **重写为 G2-2**；G1-4 **重写为 G2-4**；G1-6 **并入 G2-6**。

**第 2 轮采纳后待复审**：三类权威模型（G2-1）与现有 external 读写/injection 全链是否真解耦；两段提交+active-operation 唯一约束（G2-2）的 boot 幂等对每崩溃 phase 是否闭合；staging-from-snapshot（G2-3）与 fusion/ZIP 的交互；`version_state` 迁移（G2-4）与并发 lazy backfill；批次 B「managed 存储安全内核」（G2-6）再确认可部署性。**下一轮 Codex 再攻。**

## 13. 实现期备注（IMPLEMENTATION-NOTE）

- **跨 OS 原子目录交换**：live 是非空目录，POSIX `rename` 不能覆盖非空目标——取「新树写 `files.next-<ulid>` → 旧 live rename 为 `files.old-<ulid>` → 新树 rename 为 `files` → 清理旧目录」的两步交换，或等价符号链接指针方案。**恢复后置条件（G1-10 收紧，取代旧「收敛到某个完整版本」）**：boot 一律**从当前 DB token 指向的 `versions/vN/files` 快照重建 `files` canonical、且重建后 hash 必须等于 `skill_versions.content_hash` 否则 quarantine**；`files.old-*`/`files.next-*` 只作清理/诊断，绝不任选一个完整树当权威。
- **ZIP 冲突响应形态**：候选级失败（该候选 409、其余照常），沿现有 per-candidate 结果数组扩展。
- **snapshot ingestion symlink 策略（V10，G1-7 取代旧 realpath/inode 备注）**：SKILL.md 词法 + realpath/dev+inode 守卫**已完整在 RFC-169**（`services/skill.ts` `assertNotSkillMainFile`），本 RFC **不重复**。真正剩余风险=快照采集含 symlink：`commitSkillVersion` 采集快照**遇 symlink 一律 reject**（write 拒绝；迁移首采纳时该 managed skill 判 quarantine 待人工），杜绝「版本快照含 symlink → 外部 target 改变而 hash 不变」。读路径改快照权威后（G2-1 managed）自然不再跟随 live symlink。
