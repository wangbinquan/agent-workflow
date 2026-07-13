# RFC-170 · 技术设计——skills 存储层与 ACL 一致性加固

状态：Draft。产品视角见 `proposal.md`。本文承接 RFC-169 设计门 R5–R16 累积的完整存储协议（那 12 轮 24 findings 的折法在 169 阶段已逐条推演到收敛边界；本 RFC 独立走自己的设计门 + 用户批准后实现）。

## 0. 结论速览

- **migration ×1**（**精确清单以 §10 为准：17 ALTER + 2 CREATE TABLE〔`skill_operations` 六-kind 状态机 + `skill_operation_locks` 双锁〕 + partial-unique index + 3 backfill UPDATE**；勿再引旧「9 ALTER」）：六类 ACL 资源表 `acl_revision` + `fusions.precondition_token` + `skills` 八新列〔`meta_revision`/`migration_marker`/`reservation_state`/`version_state`/`authority_kind`/`source_state`/`origin_source_id`/`authority_owner_user_id`〕 + `skill_sources` 两列〔`lifecycle_state`/`deleted_at`〕；撞 `upgrade-rolling` journal 计数锁 89→90 bump（[reference_migration_bumps_journal_count_test]）。**全套 token/snapshot/reservation/OCC 语义仅适用 managed skill**（G2-1 三类权威模型：source-backed external=外部 SKILL.md 权威、hand-imported external=DB metadata 权威，二者只受 §7/§7a/§8 保护）。
- **不透明复合前置 token**：后端编码 `skillId + contentVersion + metaRevision`，前端只透传；读侧新增字段向后兼容、写侧必填缺失 400。
- **封闭 mutation inventory = 6 版本写 + 6 身份/生命周期写 + 第 13 类 lazy backfill + 第 14/15 类 adoption（`adopt-managed` FS+DB / `rebind` 纯 DB）**（§5），前置三分法：版本写=token+事务内重读 ACL；actorful 身份写=expected skillId+事务内重读 ACL；actorless 例外仅一处=system reconcile 的「owner 未脱离 registrar 的目录客观消失删除」。
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

**旧写端点必须一并封口（G3-3，批次 B）**：仅让旧 metadata `PUT /api/skills/:name` 410 不够——**旧 content `PUT /api/skills/:name/content`（`routes/skills.ts:179` 调 `writeSkillContent` 无 token）也是绕过 combined-save/token CAS 的 managed 版本写**，必须**同时 410**（或改走同一 token combined-save 内核）；shared schema / 契约 registry / 测试锁同步退役。**external 权威分流（G3-2）**：source-backed external 的 combined-save **拒 metadata write**（外部 SKILL.md 为权威，与「零绕过」一致）；hand-imported external 保留 DB metadata 写（其唯一可写面）。managed 版本 funnel 走 token；「external metadata-only」措辞按此三分收敛。

**前端复合 token 单一持有者（G5-P3，plan T3/T4 契约、非「仅透传」）**：detail 页对某 skill 的复合 token 必须有**唯一 owner**——`QueryClient` 里该 skill 的 detail-read 结果即 token 权威源；**每个成功的版本写响应回带新 token 后，前端原子替换该缓存条目**（file PUT→save 连续操作不得让 save 拿 file-PUT 之前的旧 T1 自冲突 409）；restore/ZIP overwrite 成功同样 reseed detail draft baseline。多 tab 经 `/ws/skills` invalidation 收敛到同一 owner。**这是 §15 已定的前端并发自冲突修复的落点，plan 须写「token 单一持有 + 每写推进 + restore reseed」而非「前端透传」。**

**fusion reject/re-run 的 stale-token 语义（G5-P4，§2 契约、非仅 §15 历史）**：fusion 发起时持久化的复合 token 若在**审批前**被并发写推高（live baseline 已变），re-run/reject 路径**不得**以「最新 live baseline + 旧 baseVersion」重跑（会产出误导 diff、拖到最终 approval 才 409）——发起端 token 与当前权威 token 不符即**发起时拒绝**（409 提示重新发起融合），把冲突前移到发起而非审批尾。plan T6 须含此拒绝语义。

**external 三态 capability 下沉（G5-P2，shared schema + 前端能力，非 §17 appendix）**：shared `Skill` 现仅 `sourceKind/sourceId`（`schemas/skill.ts:19`）、前端 capability 仅辨 managed/external（`skill-capabilities.ts:24`）——无法区分 source-external 与 hand-external 的**不同可写面**（source-external 拒 metadata write + 拒 owner transfer；hand-external 允 metadata write + 拒 owner transfer；managed 全可）。shared `Skill` 须暴露 `authorityKind`（`'managed'|'source-external'|'hand-external'`），前端 capability 按三态派生 description/delete/owner-transfer 控件 enable。plan T13（ACL 前端）+ 版本写前端同批消费。

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

## 5. 封闭 mutation inventory（managed 6 版本写 + 6 身份/生命周期写 + 第 13 类 lazy backfill + 第 14/15 类 adoption）

> **设计门 G1-4/G2-4 补**：第 13 类 = `ensureInitialSkillVersion` 的 **lazy v1 backfill**（GET versions/内容/diff/restore/boot 均可触发，`skillVersion.ts:204-244`）——它是**建立**首 token 的路径，特判：仅 `version_state='legacy-unbackfilled'` 的 managed skill 允许，走 §4 durable candidate 协议（非无条件 cpSync），成功签首 token + 置 `'snapshot-authoritative'`。**下列版本写/身份写全部限定 managed skill**（G2-1：external 两类不套 token/snapshot，只受 §7 source 生命周期 + §8 aclRevision）。

**版本写①–⑥**：见 §2。**身份/生命周期写⑦–⑫**：

- ⑦ **资源级 DELETE**（**G3-7 修正：不 blanket 限 managed**）：现按 name 无前置——旧 `/skills/foo` 页面在 foo 删除重建后能删掉新 skillId 的资源与全部版本历史。**全类型** DELETE 必带详情读取到的 skillId（不匹配 409，防同名 ABA）；managed 走 §6a delete 的 tombstone 协议（rename→trash→DB delete→清 trash）；**hand-imported external** DELETE 亦需 skillId 但无快照、直接删行+解绑；**source-backed external** 直接 DELETE **拒绝**（须走 source detach，否则下次 system reconcile 按 registrar 重建重置 ownership）；
- ⑧ **源冲突 replace**：现先删 occupier（整目录+DB 行，`skill.ts:216-227`）再全源 reconcile（`skill-source.ts:380-389`），中途失败旧毁新未导。改为**可回滚交换 + journal**（§6）；
- ⑨ **迁移决策**：§4，skillId+token+pending+候选指纹 CAS；
- ⑩ **source 生命周期**：§7；
- ⑪ **ACL PUT**：§8；
- ⑫ **技能创建**：§9。

**前置三分法**：版本写=token+最终事务内重读 ACL；actorful 身份写=expected skillId+最终事务内重读 ACL；**actorless 例外仅一处**=system reconcile 的「owner 未脱离 registrar 的目录客观消失」删除分支（skillId CAS、无 ACL）。这是**唯一 mutation inventory**——新增写入口必须先入册。

**第 14/15 类 = degraded external adoption（G8-1，§7a 全文）**：⑭ **`adopt-managed`**——把 degraded external 只读捕获为平台 managed 快照，是**新 FS+DB mutation kind**（`skill_operations` 第六 kind、§6a 有崩溃恢复子机、intent 锁），最终事务重读 ACL + CAS 全前态（`source_state='degraded'`+`expectedSkillId`）；⑮ **`rebind`**——纯 DB 单事务 one-shot CAS（认领内容权威、无 FS 副作用、不入 `skill_operations`），CAS 比全前态非仅 skillId。二者只对 degraded external 开放、owner/admin 显式发起。

## 6. conflict-replace 可回滚交换 + replacing 世代互斥（V6）

- **任何目录移动前先持久化 replace journal**（phase、旧/新 skillId、source kind、路径、备份位置——落 migration 存储面）；
- 预先完整验证候选 → 原 occupier **rename 为可恢复备份**（目录+版本历史保留）→ 单一可恢复状态机完成 DB 身份交换 → **新资源落库可读后**才清理备份与 journal；任一步失败回滚到旧资源完整可用；
- **journal 创建即原子 CAS 资源进入持久 `replacing` 世代**——六条版本写、其余身份写与 lazy recovery 的**最终提交都检查该状态**（replacing 中一律 409），否则「文件写先持 token 完成 staging → replace 落 journal → 文件写最终提交仍见旧 token 有效 → 发布 canonical」会抹掉一个已返回成功的写；
- **boot/lazy 依据 journal 幂等恢复**（否则「备份已 rename、DB swap 未落」时进程死=旧行指向缺失路径、同名 occupier 挡住重导，旧新双不可读）。

## 6a. `skill_operations` 逐 kind 崩溃恢复（G3-4/G4-2/G4-3，设计门第 4 轮后重写）

**恢复正确性的关键前提**：恢复动作是 **(phase, FS 探测) 的纯函数**——`phase` 记录「已 COMMIT 为完成的最后一步」，FS 探测记录「文件系统实际呈现」，二者的间隙（某 FS 步骤已做、其 phase 尚未 COMMIT）由**op-scoped 路径 + 期望指纹**唯一消歧。

**op-scoped 不可碰撞路径（G4-2 核心）**：每个 operation 用**含 `op_id` 的专属路径**，绝不复用泛化名——

- staging：`files.op-<op_id>.staged`（`staging_path` 列记）
- backup：`files.op-<op_id>.backup`（`backup_path` 列记，指纹入 `backup_fingerprint`）
- candidate：`files.op-<op_id>.candidate`（`candidate_path` 列记，指纹入 `candidate_fingerprint`）
- publish：`rename(staged/candidate → files)`（canonical 就是 `files`）
  这样「探测到某目录存在」即可**凭 op_id 归属确认是本 op 所留**（非别的 generation/旧句柄），杜绝「backup exists 但不知是谁的」歧义。

**通用不变量**：① 任何 FS 副作用前，`phase='intent'` 行**已单独 COMMIT**（先意图后 FS）；② 每步 FS 副作用后**单独 COMMIT** 推进 `phase`；③ `phase='db-committed'` 与对 `skills` 的最终 DB 写（swap/delete/version bump）**同一 DB 事务**；④ boot 顺序（**G7-P2 定为增量开放，非全量 barrier——否则合法巨树要么被 per-skill wall 上限误 quarantine、要么无限阻塞 HTTP**）：**operations recovery（快、必须先于 HTTP，崩溃恢复）→ source reconcile → 开 HTTP**；**managed snapshot 完整性重验在开 HTTP 之后后台逐 skill 进行**，初始 `bootVerifiedSet` 为空、随每 managed skill 验证通过而加入。**统一可用性判定 `isSkillAvailableThisBoot(skill)`（G8-2，所有 detail/list/runtime/token-writer/scheduler 入口共用此单一 predicate，按 `authority_kind` 分流——不是「一律要 `bootVerifiedSet`」，否则 external 永无生产者、rebind 出口永久不可用）**：
  - **managed**：`reservation_state='ready'` + `version_state='snapshot-authoritative'` + `bootVerifiedSet.has(skillId+generation)`（内容经本 boot hash 验证）；
  - **external（source-external/hand-external，非 degraded）**：**不走 `bootVerifiedSet`**（外部目录非平台快照、不做启动 hash）——要求 `source_state` 正常（NULL）+ authority/provenance 合法；**安全由 §7b「runtime 每次运行捕获安全私有副本」保证**（G9-2：**非**把 mutable external root 直接 symlink 给 CLI——那样根 `realpath` 挡不住树内逃逸 symlink、且有 check-then-read TOCTOU）；
  - **degraded**：只走独立 metadata/adoption projection，**绝不进入内容读/runtime 注入路径**；
  - **post-boot 新建（reserve/adopt-managed）**：在可信 ingestion 完成 + DB 状态提交后**即时加入**当前 generation 的可用集；quarantine/损坏→立即移除。
  未通过 predicate 的 skill 一律不可见/不可注入/不可签 token；故「HTTP 已开、managed 巨树仍在后台验」安全（巨树 managed 延迟可用、external 立即可用）；⑤ 恢复完成置 `phase='done'`+`active=0`。

**恢复的完备性定理（G5-1/G6-1 核心，取代旧「表外即 quarantine」的枚举脆弱性）**：因不变量①②规定每步 FS 副作用**夹在两次 phase-COMMIT 之间**，崩溃只可能落在「某 phase 已 COMMIT、其后续 FS 步骤未开始 / 进行中 / 已完成但下一 phase 未 COMMIT」。**严格分界线是 `db-committed`（DB 权威写的原子边界），且 `db-committed` 只属前滚侧**：

- **`phase < db-committed`（DB 权威尚未推进）→ 一律 `rollback(op)`**：撤 intent/锁、把 op-scoped backup rename 回原位、删 op-scoped staging/staged-version——**因无任何外部可见权威依赖这些半成品**（reservation 未 ready 不可见、version 未 INSERT 不存在、swap 未提交旧身份仍在），回滚永远安全且更简单。**pre-DB 的「FS 已完成但 phase 未推进」窗一律回滚、不投机前滚**（消除 G6-1 指出的「示例各自二选一」不一致）。
- **`phase ≥ db-committed`（DB 权威已推进）→ 一律 `rollForward(op)`**：从 op-scoped staged-version / `S` / backup 补齐 live publish、置 done、释放 lease/锁——**绝不回滚已提交的 DB 权威**（否则版本历史与 live 永久错配）。

**定理只规定目标后置条件；每 kind 仍须给出完整幂等的 `rollback(op)`/`rollForward(op)` 收敛程序（下表）。** ⑥ impossible-state（→quarantine）**收窄为**：FS 探测与 `phase` 声称的两段合法形态**都不符且无法由 rollback/rollForward 收敛**（例：`db-committed` 已推进世代 N，但 op-scoped staged-version 指纹既不等 N 也无 backup 可复原——权威源丢失）。**关键：op-scoped staging 杜绝「半成品直接落权威路径」**——不可变版本先物化进 `versions/.op-<op_id>.staged`（逐文件 + 目录 fsync、验指纹），**验毕才原子 `rename → versions/v<target>` + fsync parent**，故 `versions/v<target>` **要么不存在（rollback 删 staged 即可）要么完整**，绝无「半成品 `v<target>` 指纹不匹配」被误判 impossible（G6-1 反例消解）。下表逐 kind 为**示例窗**（非穷举——未列窗由上二分律裁决）：

**每 kind 的 (phase × FS 探测) → 唯一动作**（`C`=canonical `files` 存在，`S/B/K`=op-scoped staged/backup/candidate 存在，指纹须匹配列值否则按上「权威源是否尚存」判 rollback/quarantine）：

- **reserve**（skillId 全新、无 occupier；intent 事务插自身 skillId 锁）：intent → fs-staged(`S` 建好) → fs-published(`S` rename→`C`) → db-committed(`reservation_state='ready'`, 同 DB 事务) → done(释放锁)。
  - **phase < db-committed（intent/fs-staged/fs-published，无论 `C`/`S` 探测如何）→ rollback**：删 `C`（若已 rename 出、reservation 未 ready 故不可见、删之无损）、删 `S`、删 reservation 行、撤 intent+锁。**不投机前滚**（G6-1：即便 `C` 已发布，未 ready 无人可见，回滚比前滚更简单一致）。
  - **phase ≥ db-committed → rollForward**：`C` + ready 已在 → 清理 `S` 残留 + done（幂等）；若 ready 已提交但 `C` 缺（不可能除非外部删除）→ 从 `S`（若在）republish 否则 quarantine。
- **replace**（G4-3/**G5-4 修正**：`replaceSourceConflict` 的 replacement **永远来自 source candidate**——reconcile 删 occupier 后插 `authority_kind='source-external'`+`externalPath=候选 source path`〔`skill-source.ts:335,520`〕。故**不存在「发布新 managed canonical」的 replace**；occupier 的 `authority_kind` 只决定**如何清理旧占用者**，replacement 一律是 external DB 行。三类 occupier 子机，**全在 intent 事务对 old+new skillId 各插 `skill_operation_locks` 行**〔§10，PK 双锁〕）：
  - **managed occupier**（有 `skills/{name}` 目录）：intent(+双锁) → fs-staged(**整个 `skills/{name}` root**〔含 `files`+`versions/` 版本历史，P2-6：不止 `files`，否则删 row 级联删版本 DB 行而磁盘 `versions/` 残留孤儿〕rename→**root 外 op-scoped `.replaced/<op_id>.backup`**、指纹入 `backup_fingerprint`) → db-committed(**同事务**：DELETE occupier row + INSERT external row〔`authority_kind='source-external'`, `externalPath=candidate`, `authority_owner_user_id=source.created_by`〕；**不删锁**) → done(清 backup + **DELETE 双锁**)。**不建 `K`、不发布 managed `C`**。
    - **phase < db-committed → rollback**：`rename backup→skills/{name}` 复原完整旧 managed（含版本历史）、撤 intent+锁。
    - **phase ≥ db-committed → rollForward**：external row 已在 → 清 backup+journal + DELETE 双锁 + done（幂等）。**锁在 done 才释放**（G6-2：backup 清理与 new-id 互斥须持续到 FS cleanup 完成，否则 swap 后 backup 未清期间 new-id 的 DELETE 可插第二 op、恢复器互相覆盖）。
  - **source-backed external occupier**（无 `files`、occupier 是 `externalPath` DB 行）：纯 DB、**无 FS 副作用故无 backup cleanup 阶段**——intent(+双锁) → **单事务直接 done**（P2-1：detach 旧 external 行 + 插新 external 行 + **同事务 `phase='done'`+`active=0`+DELETE 双锁**，**不留可观察的 db-committed active 态**，与「锁随 done 释放」不变量一致）。崩在 done 前=无 FS 副作用、撤 intent+锁即回滚；崩后=幂等完成。
  - **hand-imported external occupier**（G5-4 补：无 source parent、`externalPath` 指向用户手选目录）：与 source-backed external 同为纯 DB 子机（单事务 detach 旧 hand-external 行 + 插新 external 行 + done + 释放锁），**但**若新 replacement 来自 source candidate 则新行为 `source-external`、若来自另一手选目录则 `hand-external`+`authority_owner_user_id=actor`。旧 hand-external 目录**不删**（用户资产，非平台所建）。恢复同 source-backed external。
- **migrate**（legacy/分叉首采纳，仅 managed；intent 事务插自身 skillId 锁）：intent → fs-staged(live `files` rename→**`K`〔inode-bearing generation，§4：rename 前打开的旧 fd 仍写此 inode，绝不能删〕**、从 token 快照物化 `C`〔legacy 无旧快照者：`C` 暂缺待决策〕、**另做 immutable decision copy `D`**〔隔离只读快照，供比对/采纳〕) → db-committed(CAS 推进世代 + `version_state`/`migration_marker` + **持久登记 `K` 为下一 generation 候选路径**) → done(**只清 `D`/staging 等不可能再接收写入者，保留 `K`**)。
  - **phase < db-committed（intent/fs-staged，`K`/`C`/`D` 探测任意）→ rollback**：`rename K→files` 复原**升级前的原始 live**（连同旧 fd 后续写入一并保留）、删 `C`/`D`、撤 intent+锁——迁移未提交、原样退回等下次触发（G6-1：不在 pre-DB 投机重建/推进世代）。
  - **phase ≥ db-committed → rollForward（G7-1 关键：不删 `K`）**：世代已 CAS 推进 → 确保 `C` 存在（缺则从 token 快照/`D` 重建）、**把 `K` 持久登记为下一 generation 候选**（§4 多代候选：晚到的旧-fd 编辑成为下代候选、不得清理）、只清 `D`/staging、done。**通用 rollForward 对 migrate 排除「删 `K`」**——`K` 只有在其内容已被无损登记为某 generation 后才可回收，否则违反 proposal「任何时点手工编辑都不丢」。
- **delete**（全类型，G3-3/G3-7；intent 事务插自身 skillId 锁）：intent → fs-staged(**整个 `skills/{name}` root**〔含 `files` + `versions/` 版本历史〕rename→`.trash/<skillId>-<op_id>`) → db-committed(DELETE `skills` 行，同事务) → done(清 trash+释放锁)。
  - **phase < db-committed（intent/fs-staged，trash 存在与否）→ rollback**：若已 rename 到 trash 则 `rename trash→skills/{name}` 复原（含版本历史）、撤 intent+锁——删除未提交、skill 原样保留（G6-1：不前滚补删）。
  - **phase ≥ db-committed → rollForward**：DB 行已删 → 清 trash+journal、done（幂等；此后 root 不再需要）。
  - （source-backed external DELETE 走 detach 非本机；hand-external DELETE 无 trash 目录、纯 DB——两者 intent 亦插锁，pre-DB 回滚=撤 intent+锁、post-DB=幂等完成。）
- **version-write（lease，G4-1 补全；G5-2 补 fusion）**：覆盖 **§2 全六条 managed version writer**——combined-save / file PUT·DELETE / restore / ZIP overwrite / **fusion approval（`fusion.ts:751` `commitSkillVersion`）**——的 staging→DB bump→publish 整周期。**六者由同一 funnel 在 staging 前取 lease、done/回滚后释放**（fusion 完成 DB bump 尚未 publish canonical 时若无 active lease，migrate/delete/replace intent 可移走/删除 skill root、fusion 仍 publish 成功而写入已消失的目录）。intent(建 lease + 插自身 skillId 锁) → fs-staged(从 token 快照建 `S`〔§2/G2-3 非 live〕、施 patch；fusion 的 `S`=融合结果树) → **fs-versioned**(把 `S` 内容 `cpSync` 物化进 **op-scoped `versions/.op-<op_id>.staged`**、**逐文件 fsync + 目录 fsync**、验指纹入 `candidate_fingerprint`，**验毕才原子 `rename → versions/v<target>` + fsync parent**——G6-1：不可变版本目录**要么不存在要么完整**，绝无半成品 `v<target>`；**版本目录是 `skill_versions` INSERT 的前置物**，现实现顺序 `skillVersion.ts:318` 亦先建 versionDir 再 DB) → db-committed(bump `content_version`/`meta_revision` + 插 `skill_versions` 指向 `versions/v<target>`，同事务) → fs-published(`S` rename→`C`) → done(释放 lease+锁)。
  - **phase < db-committed（intent/fs-staged/fs-versioned，DB 未 bump）→ rollback**：删 `versions/.op-<op_id>.staged`、删已原子出现的 `versions/v<target>`（**DB 未 INSERT 故该目录无人引用、删之无损**）、删 `S`、撤 lease+锁——提交前失败=可幂等重试（wire 409/422）。**pre-DB 一律回滚、不投机前滚**（G6-1：消除旧「fs-versioned 可二选一」歧义）。
  - **phase ≥ db-committed（DB 已 bump 到 target_version）→ rollForward**（真实高危窗：DB 提交后崩、live 未发布）：**从 `versions/v<target>/files`（DB 已指向、指纹已录，最可靠源）或 `S`（若在）重建 `C`**、置 done、释放 lease+锁（**绝不回滚已提交版本**）。`versions/v<target>` 指纹须 = `skill_versions.content_hash`，否则权威源丢失→quarantine。
  - lease 期间同 skill 的 delete/replace/其它 version-write intent 因 partial-unique(`active=1`)+`skill_operation_locks`（该 skillId PK）被拒（互斥）。
- **adopt-managed（G8-1/G9-1，degraded external → managed 采纳，仅对 degraded external；子机全文见 §7a）**：intent(+自身 skillId 锁 + **持久化完整 precondition**〔skillId/sourceState/authorityKind/authorityOwner/externalPath/sourceId/originSourceId+source revision〕) → fs-staged(**no-follow 只读捕获**用户 external 树进 op-scoped immutable staging、symlink reject/hash；**绝不 rename 外部目录**) → **fs-captured(稳定性栅栏 `H_before==H_staging==H_after`，不一致=并发编辑→409 回滚)** → fs-versioned(原子物化 `versions/v1`) → db-committed(重读 ACL + CAS **完整前态**〔含 externalPath/sourceId/originSourceId〕：`authority_kind:'managed'`、**`source_kind:'managed'`、`source_id:NULL`、`external_path:NULL`、canonical `managed_path`**、`version_state:'snapshot-authoritative'`、清 `source_state`) → done(清 staging+释放锁)。
  - **phase < db-committed → rollback**：删 staging/`versions/v1`、撤锁——external 仍 degraded（外部目录未动、无损）。
  - **phase ≥ db-committed → rollForward**：确保 `versions/v1`/canonical 在、done。指纹不符→quarantine。（**rebind 出口是纯 DB 单事务 CAS、无 FS 副作用、不入 `skill_operations`**，见 §7a。）

## 7. source 生命周期 ACL（V7）

source 禁用/删除/手动 rescan/懒加载与启动 reconcile 都会删/改 skill 行（`skill-source.ts:275-284,299-320,428-552`；`skill.ts:50-56` 连列表 GET 都触发 reconcile），现只验 source registrar 身份——skill ACL 转移后旧 registrar 仍能删/改新 owner 资源。`reconcileSource` 显式拆 **user(actor) / system 两模式**：

- **(a) 一切用户触发的 source 操作**（remove / disable / **enable**〔false→true 调 reconcile〕 / rescan / **conflict-replace**〔全源 reconcile〕）统一走 user 模式——逐 child 最终事务 CAS skillId+sourceId **并复核 actor 对该 skill 的 owner/admin**；无权限的 child 跳过修改/删除、标 orphaned、结果列明（部分成功报告），不静默越权；
- **(b) system reconcile**（boot/lazy/GET 触发）**逐分支前置**：新资源创建=按 registrar 名义允许；**已有 child 的更新写回**（现同源分支写 description/externalPath/updatedAt，`skill-source.ts:507-517`）须以 registrar 身份复核当前 owner/admin，转移后无权限则跳过写回或标脱离 source；**actorless 例外**=「目录客观消失」删除，且**仅当 skill 当前 owner 仍等于 source registrar**（否则旧 registrar transfer 后删子目录、等 GET reconcile 代删——skillId CAS 防不了定向删除）——已转移 child 目录消失只标 orphaned/degraded，删除走 actorful 资源 DELETE。

## 7a. degraded external 的 fail-closed + adoption 状态机（V7a，G7-2）

§10 把「升级前无法证明内容权威一致」的 legacy external（一切 hand-external + owner≠registrar 的 source-external）标 `source_state='degraded'`，但只标记不定义出口是**半个修复**——若不 gate，runtime loader（`scheduler.ts:6061` 注入 `externalPath`）会继续把权威不明的外部目录喂给任务；若一律 gate，升级后所有 legacy external **永久不可用**。故须定义**明确的 fail-closed 语义 + adoption 出口**：

- **degraded 期间 fail-closed（统一 gate）**：`source_state='degraded'` 的 skill 从 **list/detail 内容读/runtime 注入/一切版本写** 一律拒绝（与未验 snapshot 同款不可见）；仅保留**「degraded 待 adoption」的元信息可见**（让 owner/admin 知道存在并可发起 adoption），不泄露/注入其磁盘内容。
- **adoption 出口（owner/admin 显式、带 `expectedSkillId` OCC）**，二选一——**G8-1：adoption 是新 FS+DB mutation，必须进封闭 inventory + 有崩溃恢复子机，不能只靠 `expectedSkillId`**（它只挡删除重建 ABA、挡不住同 ID 两个 adoption 并发、或 adoption × source reconcile〔`skill-source.ts:507` 可更新 externalPath/删行〕交错）：
  1. **转 managed（推荐默认）= 新 mutation kind `adopt-managed`**（`skill_operations` 第六 kind、§6a 子机、intent 事务插自身 skillId 锁）：**intent 事务持久化完整 adoption precondition**〔`skillId/sourceState/authorityKind/authorityOwner/externalPath/sourceId/originSourceId` + source `lifecycle_state`/revision——绑定「用户确认时看到的确切目录与行前态」〕 → fs-staged(**把 `externalPath` 树只读捕获进 op-scoped immutable staging**：**no-follow 遍历、遇 symlink reject**、hash) → **fs-captured(稳定性栅栏 G9-1：`H_before(source)==H_staging==H_after(source)`，不一致=捕获期间被并发编辑→409 回滚、external 保持 degraded，绝不把「旧 SKILL.md × 新支持文件」混合树铸成 v1)** → fs-versioned(原子物化进 `versions/v1`，同 version-write 的 op-scoped staged→rename 协议) → db-committed(**最终事务重读 ACL + CAS 完整前态**〔含 `externalPath`/`sourceId`/`originSourceId`，非仅 skillId+source_state〕→ **显式同步全部字段**：`authority_kind:'managed'`、**`source_kind:'managed'`、`source_id:NULL`、`external_path:NULL`、canonical `managed_path`**、`version_state:'snapshot-authoritative'`、清 `source_state`；任一前态不符→409) → done(清 staging+释放锁)。崩溃恢复：`phase<db-committed→rollback`（删 staging/version、撤锁，external 仍 degraded）；`≥db-committed→rollForward`（确保 v1/canonical 在、done）。**源是用户不可移动 external 目录，只读捕获、绝不 rename 外部目录**；**转后 `source_kind='managed'`+`source_id=NULL` 使后续 reconcile 不再按 sourceId 选中它、runtime 不再按 external symlink 注入**（G9-1：防「已转 managed 仍被 reconcile 改或按 external 注入」）。
  2. **rebind 内容权威 = 纯 DB 单事务 one-shot CAS**（无 FS 副作用）：CAS 条件 = **完整前态匹配**〔`expectedSkillId` + `source_state='degraded'` + `authority_kind` + `authority_owner_user_id` + **`external_path` + `source_id` + `origin_source_id`**〕——**必须含 `external_path`**（G9-1：现 reconcile 能保持前四字段不变而只改 `externalPath`〔`skill-source.ts:510`〕，漏它则 path-only reconcile 后过期 rebind 仍成功、认领的不是用户确认时的目录）→ 单事务置 `authority_owner_user_id=actor`、清 `source_state`、保持 external + `externalPath` 不变；前态不符→409。**必须比完整前态、非仅 skillId**。
- **adoption 后**：skill 恢复正常可见/可注入；**A→transfer B→upgrade 回归测试**锁定「B 必须显式 adoption 才能用，且转 managed 后与 A 的外部目录无关、rebind 后 provenance=B」。
- **谁能 adoption**：skill 当前 owner 或 admin（与其它 owner-gated 操作一致）；非 owner 只见 degraded 元信息、不能 adoption。

## 7b. external skill 的 runtime 安全捕获（V7b，G9-2 安全）

**问题**：现两 runtime 共用的 `stageSkills` 把整个 external 目录**直接 symlink** 给 CLI（`stageSkills.ts:51,56`）；平台此后不介入 CLI 实际读取——对根做一次 `realpath` **挡不住树内逃逸 symlink**（`{external}/x → /etc/shadow`），预扫整树又有「检查后、CLI 读前被替换」的 TOCTOU；API reader 已有的 containment（G3-1）**不保护 runtime staging**。共享/public external skill 场景下这是真实路径逃逸——被授权/公开读者可借一个内含逃逸 symlink 的 external skill 泄露宿主文件。

**修复**：**external 不套 managed 式 boot hash，但 runtime 必须每次运行捕获「安全私有副本」**再交 CLI，而非 symlink mutable external root——

- **no-follow 遍历** external 树：遇 symlink **一律 reject**（该 skill 本次注入 fail-closed，不静默跳过），或只复制经 containment 验证的常规文件字节；
- 复制到**任务私有、进程只读**的 staging（每次运行新建，非共享可变目录）；
- 复制**完成后再次扫描**确认无逃逸（捕获窗口内的 TOCTOU 由「私有副本一旦定稿即不可被外部替换」消解——CLI 读的是副本不是源）；
- 把**不可变副本**交 CLI；
- **两 runtime（opencode + claude〔`config.ts` best-effort 路径〕）统一走此捕获**，策略拒绝**置于 Claude best-effort catch 之外**（不得被吞成「跳过 skill 继续运行」）。

代价：external 失去「symlink 实时可见」语义、改为「每次运行捕获当次内容」——但这正是共享场景安全的必要取舍（且每运行重捕获仍反映最新内容）。managed skill 不受影响（走快照权威 copyDir，本就无外部 symlink）。

## 8. ACL PUT `aclRevision` 六资源 CAS（V8）

`PUT /api/*/acl` 现「预检后按 stale row 写 owner/grants」（`resourceAcl.ts:46-65`、`services/resourceAcl.ts:259,307-328`，无事务内重读/CAS）：

- 预检后暂停、管理员 transfer、恢复提交把 stale `nextOwner` 写回**夺回所有权**；
- 且 owner 不变的迟到写同样致命——`userIds` 是 full-replace，撤销后的迟到提交可恢复已撤销授权/重新公开资源，expected owner 挡不住；

修复（**共享服务、全六类 ACL 资源含 workgroup 同时受益**）：ACL GET 统一返回、PUT 必带 `expectedResourceId` + **单调 `aclRevision`**，共享服务同一事务内比较并推进 revision、更新 owner/visibility/grants。**GET 授权+装配同事务（G3-9/G2-9）**：row reload + visibility/grant 授权复核 + owner/users/grants/revision 装配全部进同一 `dbTxSync` 只读快照（不止读一致、授权也在同快照复核），`prevOwner`/grants 在 CAS 成功同事务快照内算、不用 route 传入的 stale row。
- **被引用用户 active 校验进 CAS 同事务（G5-P5）**：现 `resourceAcl.ts:261` 在事务**前** `await` 查 nextOwner/grantee 是否 active，之后才进同步事务——用户可在两查之间被 disable 仍成为 owner/grantee。修复：把 owner/grantee 的存在+active 校验用 `.get`/`.all` 挪进 CAS `dbTxSync` 内（`txSync.ts:19` 禁 `await`，故只能同步 driver 查），与 revision CAS、grants full-replace 原子完成；校验失败→整事务 rollback + 422。

- **external skill 禁 owner transfer（G3-2）**：source-backed / hand-imported external 的注入 body 来自可变 externalPath，通用 owner transfer 后原 registrar 仍控内容 →「owner 才可改资源」在 external 成假承诺。故 **skill 类型资源的 ACL PUT 对 external（`authority_kind != 'managed'`）拒绝 owner transfer**（原 registrar/importer 永为内容控制者；grant/visibility 仍可改）；managed skill 与其余五类资源 transfer 不受限。
- **前端 ACL 管线全链（G3-8，plan T13 必含，否则六类 ACL PUT 全 400）**：shared `ResourceAcl` 加 `aclRevision`；PUT body 加 `expectedResourceId`+`expectedAclRevision`；`AclPanel` 从 GET 持有 revision、PUT 成功后原子推进、409 保留草稿并提示 reload；补 transfer 与普通 grant/visibility 两条前端测试。**六类资源同步**（agents/skills/mcps/plugins/workflows/workgroups 的 AclPanel 复用同一组件、一次改全受益）。

## 9. 技能创建 reservation（V9）

managed create 先写共享 `skills/{name}/files` 再插行（`skill.ts:84-118`）、ZIP create 同样（`skill-zip.ts:296-309,348-409`）：两窗口同见名称空闲时，输掉唯一约束的请求已覆盖赢家 live。创建列为独立 mutation 类：**原子保留 name+skillId（DB 行先行）→ 操作专属 staging 目录构建 → 仅 reservation owner 发布（原子换入）→ 失败只清自己 staging**。

## 10. migration

单个 migration 文件（多语句 `--> statement-breakpoint` 分隔，[reference_migration_statement_breakpoint]），**17 ALTER + 2 CREATE TABLE + partial-unique index + 3 backfill UPDATE**（设计门 1–5 轮累计扩定；精确清单见下，勿再引旧「9 ALTER」计数）：

- **六类 ACL 资源表**（agents/skills/mcps/plugins/workflows/workgroups）各 ADD `acl_revision INTEGER NOT NULL DEFAULT 0`（§8 aclRevision CAS）；
- `fusions` ADD `precondition_token TEXT`（发起时完整复合 token；存量行 NULL → 待审批 fail-closed 提示重发起）；
- `skills` ADD `meta_revision INTEGER NOT NULL DEFAULT 0`（§1 metaRevision 单调计数；存量=0 与首 token 一致）；
- `skills` ADD `migration_marker TEXT`（§4 存量分叉终态标记：`NULL`=未评估 / `'migrated'`=live≡快照已确认 / `'pending-decision'`=分叉待迁移决策）；
- `skills` ADD `reservation_state TEXT NOT NULL DEFAULT 'ready'`（G2-5：存量行即 ready 可见，`getSkill`/list/scheduler 过滤非 ready）；
- `skills` ADD `version_state TEXT NOT NULL DEFAULT 'legacy-unbackfilled'`（G2-4/**G3-5 收紧**：`'legacy-unbackfilled'|'snapshot-unverified'|'snapshot-authoritative'|'quarantined'`；本 migration 对**已有 `skill_versions` 行的 managed skill** UPDATE 为 **`'snapshot-unverified'`**〔**不**直接标 authoritative——旧 funnel hash 跳过 symlink，EXISTS 不证明快照可信〕，其余 managed 留 `'legacy-unbackfilled'`；**两层验证（G6-4 关键——durable 采纳态 ≠ 本 boot 完整性）**：
  - **durable 一次性采纳**：`version_state` 记录采纳生命周期（`legacy-unbackfilled`→首次 boot 深验→`snapshot-authoritative`/`quarantined`），这是**一次性**的「首采纳是否可信」门，通过后持久为 authoritative。
  - **每 boot 重验完整性（不可省，G6-4 反例：首验后 snapshot 离线损坏，永久 authoritative 会让下次 boot 仍签 token、用户保存把损坏内容铸成新权威版本）**：**开 HTTP 后后台**对所有 `snapshot-authoritative` 逐 skill 重 hash 校验 current snapshot〔目录存在 + hash 匹配 `content_hash` + 整树无 symlink + SKILL.md 合法〕，通过即加入**内存 `bootVerifiedSet`（boot epoch 作用域，不持久，仅 managed）**；**detail/list/runtime/token-writer/scheduler 统一 gate 于 §invariant④ 的 `isSkillAvailableThisBoot` predicate**（G8-2：managed 要 `bootVerifiedSet` 命中、external 走 `source_state` 合法不入该 set、degraded 只元信息）——managed 未在本 boot 通过者不可见/不可注入/不可签 token（即便 `version_state='snapshot-authoritative'`）；重验**失败（hash 不符/含 symlink）**→CAS `version_state='quarantined'`（真损坏，fail-closed）。`'snapshot-unverified'` 首采纳深验通过才 CAS `'snapshot-authoritative'`，否则 `'quarantined'`/pending；external 行此列忽略。
  - **成本预算（G5-P6/G6-4/G7-P2，增量开放下无 barrier 故无「巨树阻塞启动」）**：因验证在 HTTP 之后后台逐 skill 跑、未验 skill 一律不可见，**合法巨树只是「延迟可用」不被 quarantine 也不阻塞启动**（去掉旧「超 wall 上限即 quarantine」——那会误伤合法大 skill）；仅设**软 wall/字节上限用于「先验小 skill、大 skill 排后」的调度公平**、以及**探测异常（IO error/超硬上限视为损坏）→quarantine**；`bootVerifiedSet` 是内存态、`durable progress` 只表示「本次 boot 已完成该 skill」不跨 boot；未入本 boot set 的 skill 在 `getSkill`/list/scheduler/runtime 一律不可见（G2-5 reservation 过滤同款），绝不以未验状态注入 runtime；
- `skills` ADD **`authority_kind TEXT NOT NULL DEFAULT 'managed' CHECK(authority_kind IN('managed','source-external','hand-external'))`（G3-7 稳定 discriminator；G4-7 修：必带 DEFAULT，否则 SQLite `Cannot add a NOT NULL column with default value NULL` 在非空表直接失败）**——**不再靠 `sourceId != null` 判**（FK `ON DELETE SET NULL` 会把 orphan 误转 hand-external）；migration 加列后**同 migration `UPDATE`** 依现 `sourceKind`+`sourceId` 回填（external 且 sourceId!=null→'source-external'、external 且 sourceId==null→'hand-external'；managed 保 DEFAULT 'managed'）；
- `skills` ADD **`source_state TEXT`（G3-7 持久 per-child source 状态）**：`NULL`=正常 / `'orphaned'`（registrar 无权限跳过的 child）/ `'degraded'`；source 删除时**不再 blanket FK SET NULL**——仍有 transferred child 时 source 行保留/tombstone、child 标 orphaned 但 `authority_kind` 与 `origin_source_id` 不变；
- `skills` ADD `origin_source_id TEXT`（记原 source 归属，即便 sourceId 因 detach 置空亦保 provenance）；
- `skills` ADD **`authority_owner_user_id TEXT`（G5-5/**G6-3 收紧**内容权威 provenance）**：external skill 落谁**实际控制磁盘内容**。通用 ACL 允许 transfer `owner_user_id`，但 external 的内容永远由原 importer/registrar 的 `externalPath` 控制——`authority_owner_user_id` 与 `owner_user_id` 分离，使「A 控内容、B 控 ACL」的失配**可被检测**（§8 external 禁 owner transfer 是**预防**，此列是**升级前已发生失配的事后侦测锚**）。**migration 回填（G6-3 关键：绝不给 hand-external 回填当前 owner，否则伪造「内容控制者=当前 owner」使已 transfer 的 A→B 扫描通过）**：`source-external`←`skill_sources.created_by`（source 有可靠 registrar 记录，可证内容控制者）；**`hand-external`←`NULL`（`legacy-unknown`）并同时标 `source_state='degraded'`**（升级前无 importer provenance、无法证明当前 owner 即内容控制者——一律待 legacy adoption 决策，不猜）；managed 此列 NULL（快照即权威）。**仅新 import（升级后）才可靠写 actor 为 `authority_owner_user_id`**（`skill.ts:163` import 路径补写）；
- **CREATE TABLE `skill_operations`**（G2-2/**G3-4 收紧**两段提交状态机）：`op_id TEXT PK, skill_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN('reserve','replace','migrate','delete','version-write','adopt-managed')), phase TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)), staging_path/backup_path/next_skill_id/candidate_path/candidate_fingerprint/backup_fingerprint/target_version/generation/owner_user_id/created_at`（**G4-1：`version-write` 必须在枚举内否则插 lease 违反 CHECK；`staging_path`/`target_version`/`backup_fingerprint` 为 §6a 探测所需**）；**partial unique index `ON (skill_id) WHERE active=1`**（`skill_id`/`active` NOT NULL 才使 partial unique 成 DB 不变量）；**无 `skills` FK cascade**。**与 `skill_operation_locks` 的关系（G6-2 澄清，非冗余非冲突）**：此 partial-unique 只约束 op **自身 `skill_id`** 至多一条 active 行——它挡不住 replace 的**第二个** id（`next_skill_id`）被别的 op 占用；`skill_operation_locks` 才是**跨 op 的唯一互斥面**（锁全部 affected id）。二者对「op 自身单 id」确有重叠（都保证同 id 无并发 op），但**方向正交**：partial-unique 保证「一个 skill 至多一个 in-flight op 记录」（便于 boot 按 skill 找恢复目标），locks 保证「任一 op 触碰的所有 id 互斥」（含 replace 的 new id）。保留两者：locks 是权威互斥，partial-unique 是 per-skill 恢复索引 + 二次防御。**逐 kind 转移表（G3-4）见 §6a**：每 kind 的 phase 序列 + 每崩溃窗恢复动作明确定义；普通版本写「DB 提交后发布 live」期间须持**覆盖 staging→DB→publish 整周期的 lease（= 该 skill 一条 `kind='version-write'` active 行）**、非只在最终事务查一次。存量资源**不补** `skill_operations` 行。
- **CREATE TABLE `skill_operation_locks`（G5-3/**G6-2 收紧为唯一互斥面**）**：`locked_skill_id TEXT PRIMARY KEY, op_id TEXT NOT NULL, created_at INTEGER NOT NULL`。**为何单独一张表**：`skill_operations` 每行只有一个 `skill_id`，其 partial-unique 无法锁 replace 需要的**第二个**（`next_skill_id`）。**G6-2：此表是所有 op 的唯一 exclusion primitive**——**每个 operation（无论单 ID 的 reserve/migrate/delete/version-write，还是双 ID 的 replace）在 intent 事务内对其全部 affected skillId 各 `INSERT` 一行 lock**（单 ID op 锁 1 行、replace 锁 old+new 2 行）；PK 冲突（任一目标 id 已被别的 active op 锁住）→ 该 op 拒绝（409 busy）。**若只让「双 ID op」插锁则 new id 的单 ID DELETE/version-write 不与 replace 的 new-id 锁冲突**（G6-2 反例：swap 后 backup 未清期间 new-id DELETE 插第二 op、恢复器互相覆盖）——故单 ID op **必须**也走此表。**锁保持到 FS cleanup 完成 + 写 `phase='done'` 的同事务才 `DELETE`**（不在 db-committed 提前释放）。恢复器启动顺序：**先在锁仍持有时恢复所有 active op（rollback/rollForward）、之后才清理孤儿 lock**（对应 op 已 done/不存在的残留行）。这把「锁 old+new」及「所有写互斥」从口头约定变 **DB 约束**（单表 partial-unique 做不到）。

- `skill_sources` ADD **`lifecycle_state TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle_state IN('active','deleting','tombstoned'))` + `deleted_at INTEGER`（G4-6）**：source DELETE 时仍有 transferred child（child owner ≠ `created_by`）→ source 转 `'tombstoned'`（保留行**挡同 path 重注册**、但 list/reconcile **过滤非 active**、UI 不显示），零 child 才真删；FK `source_id` 保留但改 **RESTRICT**（或证明只在零 child 删）——**不再 `ON DELETE SET NULL`**（否则 orphan child 被误分类 hand-external，G3-7）。

**存量失配处理（G4-8/G6-3）**：同 migration 检出两类失配 → 标 `source_state='degraded'` 待人工 legacy adoption：① `authority_kind='source-external'` 且 `owner_user_id != skill_sources.created_by`（有 registrar 记录、可判定的已 transfer 失配）；② **一切 `authority_kind='hand-external'`**（无 importer provenance、`authority_owner_user_id` 回填为 NULL、**无法证明**当前 owner 即内容控制者——G6-3：不能乐观放行，一律 degraded 等 adoption）。升级后新 import 的 hand-external 带可靠 `authority_owner_user_id`、不落此列。

撞 `upgrade-rolling` journal 计数锁 **89→90** bump（标题+断言+注释，[reference_migration_bumps_journal_count_test]）。**注**：token/snapshot/reservation/version_state/skill_operations 全套仅服务 managed skill（G2-1）；`acl_revision` 覆盖全六资源全类型。共 **17 ALTER + 2 CREATE TABLE + 1 partial-unique index + 3 backfill UPDATE**：ALTER = 六表 `acl_revision`(6) + `fusions.precondition_token`(1) + skills 八新列(`meta_revision`/`migration_marker`/`reservation_state`/`version_state`/`authority_kind`/`source_state`/`origin_source_id`/`authority_owner_user_id`=8) + skill_sources 两列(`lifecycle_state`/`deleted_at`=2)；CREATE TABLE = `skill_operations` + `skill_operation_locks`；index = `skill_operations` 上 `(skill_id) WHERE active=1` partial-unique；UPDATE = `authority_kind`/`version_state`/`authority_owner_user_id` 三条回填（第三条为 CASE：`source-external`←`skill_sources.created_by`、`hand-external`←`NULL` 且顺带 `source_state='degraded'`，G6-3）。

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

## 16. 170 独立设计门——第 3 轮（Codex adversarial-review，2026-07-13）

verdict **NOT APPROVED：8 P1 + 5 P2。收敛趋势 10→11→13——findings 不降反升**。原因不是折法退步，而是**每轮 Codex 深入未探过的新面**（external 安全/权威、source discriminator 稳定性、旧 endpoint、前端 ACL 管线），暴露出 **RFC-170 实际范围远大于三件套原始捕获**。核心结论：**当前不可实施；且这不是「再折两轮就收敛」——是范围本身需重新定界**。逐条：

- **G3-1（P1-2，安全）external 文件 GET 的 symlink 越界读**：`readSkillFile` 对 externalPath 只 `safeJoin`（不解析 target symlink，`safePath.ts:9` 明示需调用者 realpath containment），`statSync/readFileSync` 跟随 symlink（`skill.ts:361`）——external skill 内放 `secret -> ~/.ssh/id_rsa`、skill 公开/授权他人 → `GET /file?path=secret` 读到 root 外宿主文件（**跨用户信息泄露**）。G1-7 的 symlink 拒只保护 managed ingestion。**折**：`readSkillFile`（及 file/tree GET）对 external 用 `realpathInside`（`safePath.ts` 已有）做 realpath containment、逃逸即拒。**此为独立于 RFC-170 协议的现存安全漏洞、可单独修。**
- **G3-2（P1-1）external owner transfer 与内容控制者分离**：source-backed/hand-imported external 的注入 body 来自可变 externalPath，§8 通用 owner transfer 后原 registrar 仍控制外部目录内容 → 「owner/admin 才可改资源」在 external 成假承诺。**折**：external **禁止 owner transfer**（原 registrar/importer 永为内容控制者），或 transfer 时原子转 managed snapshot + 解绑 externalPath；本 RFC 取**禁止 external transfer**（最简安全）。source-backed combined-save 亦拒 metadata write（与「SKILL.md 权威」一致，勘 §2「external metadata-only」措辞）。
- **G3-3（P1-3）旧 `/content` PUT 是未入册第 7 条 managed 版本写**：只处理了旧 metadata PUT→410、漏了 `PUT /api/skills/:name/content`（`routes/skills.ts:179` 无 token）→ 部署后可绕 combined-save/token CAS 改 managed SKILL.md。**折**：批次 B **旧 metadata PUT 与旧 content PUT 同时 410**（或 /content 改走同一 token combined-save 内核）+ shared schema/契约 registry/测试锁同步退役。
- **G3-4（P1-4）`skill_operations` 缺逐 kind 转移表 + 约束 + full-cycle lease**：泛化「fs-staged 回滚/fs-published 前滚」不够——reserve/replace/migrate/delete 各有「FS 已变、DB 仍上一 phase」的必然窗（表见 round-3 report），恢复器须逐 kind 识别；`skill_id`/`active` 须 `NOT NULL`+CHECK（否则 partial unique 非 DB 不变量）；普通版本写「DB 提交后发布 live」期间新 delete/replace intent 可提交——写者须持**覆盖 staging→DB→publish 整周期的 lease**、非只在最终事务查一次。
- **G3-5（P1-5）`version_state` EXISTS backfill 会把未验证/含 symlink 旧快照标权威**：旧 funnel hash 跳过 symlink（`skillVersion.ts:99/300`），G1-7 只拒未来 ingestion、不扫已有 `versions/vN/files`。**折**：加 `'snapshot-unverified'` 态（存量 managed 一律先 unverified），**boot 在开放 HTTP/runtime 前**逐 skill 验证（content_version 行/目录存在 + hash 非 NULL 且匹配 + 整树无 symlink + SKILL.md 合法）→ 通过才 CAS `'snapshot-authoritative'`、否则 quarantine/pending。
- **G3-6（P1-6）G2-6 未真正进 plan——批次 B 仍不可独立部署**：§15 说移入 B，但 plan 批次 C 仍留 conflict-replace(T11)/DELETE(T12)/symlink+旧 PUT(T13)。**G2-6 被 refute**。**折**：plan 批次 B **确实**纳入 DELETE tombstone+replace journal+旧 metadata&content PUT 410+symlink reject（本轮已改 plan）。
- **G3-7（P1-7）`sourceId != null` 非稳定 discriminator**：FK `ON DELETE SET NULL`（`schema.ts:310`）——source owner transfer 给 B 后 A 删 source，§7 应「跳过标 orphaned」但 parent 行仍删、FK 把 child.sourceId 置 NULL → G2-1 误分类为 hand-imported external、provenance/orphan 永久丢。**折**：加持久 `authority_kind`/`origin_source_id` + per-child source state 列（非短期 `skill_operations`）；仍有 transferred child 时保留/tombstone source 行。资源 DELETE 不 blanket 限 managed——hand-imported external DELETE 仍需 expectedResourceId 防 ABA、source-backed 直接 DELETE 须拒或定义 detach。
- **G3-8（P1-8）ACL revision 后端要求会让六类资源 ACL PUT 全 400**：现 shared body/`AclPanel` 只发 owner/visibility/userIds（`resourceAcl.ts:56`/`AclPanel.tsx:101`），plan T13 只写共享 service、漏 shared schema `aclRevision`+PUT `expectedAclRevision`+AclPanel token 持有/推进+409 reload+两前端测试 → 按现 plan 实现六类 ACL 编辑全失败。**折**：T13 补全前端 ACL 管线全链。

**范围再定界结论（3 轮设计门）**：3 轮共 34 findings、且 findings 递增（10→11→13）——证明 R5–R16「推演基线」显著低估了 external 安全/权威模型、source discriminator 稳定性、旧 endpoint 封闭、前端 ACL 管线四个维度。**建议**：① 独立安全漏洞（G3-1 symlink 越界读）**可即刻单修**（不依赖协议）；② 其余按新暴露的四维度**重新定界 scope 后再走后续设计门**，而非在原 scope 上继续折——否则每轮仍会挖出新面。**用户 2026-07-13 拍板「继续磨到收敛」。**

## 17. 170 独立设计门——第 4 轮（Codex adversarial-review，2026-07-13）

verdict **NOT APPROVED：8 P1 + 5 P2**。**趋势 10→11→13→13——数量停止上升、scope 边界稳定**（恢复状态机 / external authority-source / boot 验证 / 迁移 / 前端协议五域），但核心协议自身未闭合。**多条折法获判 sound**：G3-3（旧 metadata+content 双 410、repo grep 无第七 managed writer）、G3-7 `authority_kind` 作稳定 discriminator、G3-8 正文 shared schema+AclPanel revision 管线、G3-1 `readSkillFile` 实现（+本轮已补 content/history reader 两处、见 `skill.ts:262`/`skillVersion.ts:424`，`c84ff79f`）。逐条：

- **G4-1（P1）`version-write` lease 不在 CHECK 枚举 + 无自恢复**：§6a 要 `kind='version-write'` 但 §10 CHECK 只列四 kind→插 lease 违反 CHECK；且缺 version-write 的 phase 序列/`staging_path`/`target_version`/前滚回滚（真实窗=DB bump 后才发布 live，崩溃遗留 active lease、boot 不知发布还是回滚、后续写永久 409）。**折（已改 §10）**：`version-write` 入枚举 + `staging_path`/`target_version`/`backup_fingerprint` 列；§6a 补 version-write 行（DB bump 后崩溃→从 `staging_path` 前滚发布，或版本已提交→从 token 快照重建 canonical，完成释放 lease）。
- **G4-2（P1）§6a 未覆盖「FS 成功、phase 未推进」全状态空间**：reserve（canonical 已建 staging 已消 reservation 未 ready）、replace（backup+canonical 并存）、migrate（intent + candidate/live 并存）等组合表未定义唯一动作。**折**：§6a 每 kind 须**穷举 (phase × FS 探测组合) → 唯一动作 + impossible-state quarantine**，路径用 **op-scoped 不可碰撞名**（`files.<op_id>.staged/backup/candidate`）+ expected fingerprint 判定，非仅信「backup exists」。（§6a 完整重写留下一轮前置。）
- **G4-3（P1）replace 状态机与真实 conflict-replace 类型不符 + 换 ID 后锁失效**：真实 occupier 是 source-backed external（`skill-source.ts:507/521`）、无 managed canonical tree 可 rename；且 replace lock 锁旧 `skill_id`、DB swap 后新资源 `next_skill_id` 仍锁旧 ID→针对新 ID 的 delete/version-write 可插另一 active op。**折**：replace 按 occupier `authority_kind` 拆子状态机（external occupier=DB 行 detach+externalPath 换、无目录 rename）；锁改 **name/slot 稳定锁** 或**同时锁 old+new skillId**。
- **G4-4（P1，安全，已修）** G3-1 补漏：content GET（`skill.ts:262`）+ 历史版本内容（`skillVersion.ts:424`）两处 SKILL.md reader 加 realpathInside——**已实现+测试+推送 `c84ff79f`**。
- **G4-5（P1）`snapshot-unverified` boot 验证范围不足**：只验 current、漏历史版本（v3 净 v1 含 symlink 仍经 `/versions/:v/content` 暴露）；且首验后永久 authoritative、离线损坏不重验。**折**：boot **每次**验证所有 current authoritative snapshot；历史版本读**至少对 SKILL.md 做 containment**（本轮已加，`skillVersion.ts:424`）；plan「逐 managed skill」与正文「逐 unverified」口径统一为「每 boot 验 current authoritative + unverified」。
- **G4-6（P1）source tombstone 无可实现父级状态**：`skill_sources` 无 lifecycle/tombstone 列（`schema.ts:153`），list/reconcile 扫全部 enabled parent → source DELETE 只有「真删（FK SET NULL 复活误分类）/留行（仍扫描仍挡重注册）」两坏选。**折（§10 补）**：`skill_sources` ADD `lifecycle_state('active'|'deleting'|'tombstoned')`+`deleted_at`；list/reconcile/重注册按 lifecycle 过滤；仍有 transferred child 时 source 转 tombstoned（保留挡重注册但不再扫描/不显示）、零 child 才真删；FK 保 `source_id` 改 **RESTRICT** 或证明只在零 child 删。
- **G4-7（P1，已修）migration NOT NULL 无 DEFAULT 在非空表直接失败**（`Cannot add a NOT NULL column with default value NULL`）+ 实为 **14 ALTER** 非 9。**折（已改 §10）**：`authority_kind` 带 `DEFAULT 'managed'` + 同 migration UPDATE 回填；`version_state/reservation_state` 同带 DEFAULT + CHECK；`origin_source_id=source_id` 存量 backfill 明确；proposal/plan T1 同步列全 14 ALTER + 三新列 + snapshot-unverified。
- **G4-8（P1）「禁 external transfer」不处理升级前已 transfer 的存量行**（registrar=A、owner=B 失配被冻结）。**折**：migration/首 boot 检出 `authority_kind!='managed'` 且 `owner != skill_sources.created_by` 的行 → 标 `source_state='degraded'`/quarantine 或走 legacy adoption 决策，不静默冻结失配。
- **P2 集**：external authority 分流须贯通 shared `Skill` wire（加 `authorityKind`）+ frontend capability（`canEditDescription/canDelete/canTransferOwner`，`skill-capabilities.ts`）；plan G3-6/G3-8 的 T-BSAFE 与 T11/T12/T13 重复冲突须去重（批次 C 不再重列已上移 B 的项）；G2-7（前端 per-skill token 单持有）/G2-8（fusion re-run stale-token 拒）须从附录进 §2 正文 + plan；ACL PUT 的 user-active validation 仍事务外 await（`resourceAcl.ts:261`）→须并入 CAS 同事务（`.all/.get/.run` 无 await）；boot 验证成本须定预算（skill/历史版本无总数上限、不能 warn-and-continue）。

**收敛判读**：scope 稳定是**正向信号**（不再挖新维度）；剩余=**§6a 完整 phase-probe 矩阵重写 + §10 source lifecycle + 存量失配处理 + P2 正文/plan 去重贯通**——是「深协议闭合」非「范围扩张」。下一轮前置：**重写 §6a（穷举矩阵 + op-scoped 路径 + replace 按 occupier authority）与 §10（source lifecycle）**，再 re-gate 验收是否 findings 开始下降。已即刻单修全部 3 处 symlink 安全漏洞（`c84ff79f`）。

## 18. 170 独立设计门——第 5 轮（Codex adversarial-review，2026-07-13）

verdict **NOT APPROVED：5 P1 + 7 P2**。**趋势 10→11→13→13→12——开始 DROPPING，P1 由 8 降到 5**：重写 §6a（op-scoped 路径 + 先 durable intent 后 FS + 未知态 quarantine + boot recovery 先于 snapshot verify）已获判 **方向正确**；`NOT NULL` 列全带 DEFAULT、`0005` FK 实为 `NO ACTION`（官方迁移无需危险重建、只校准 Drizzle 声明）、journal 89、三处 symlink 代码修复均 **sound**。剩余 5 P1 全在**同一深水区**（§6a 崩溃恢复完备性 + replace 状态机 + 三类 authority），非新维度。逐条（**均已折入正文**）：

- **G5-1（P1）§6a 仍把合法 crash window 当 impossible quarantine + version-write 缺 target-snapshot 物化**：默认 quarantine 安全，但「FS 已完成/intent 已提交而 phase 未推进」是**合法**窗，穷举表漏列即误 quarantine；且 version-write 序列未描述不可变 `versions/vTarget/files` 如何 durable 物化/fsync/探测。**折**：§6a 加**恢复完备性定理**——崩溃只落在两次 phase-COMMIT 间，故 `phase≤db-committed 一律回滚 / ≥db-committed 一律前滚`，per-kind 表降为**示例窗**（未列窗由定理裁决，杜绝「漏列→误 quarantine」）；version-write 加 `fs-versioned` phase（`cpSync`→`versions/v<target>`→fsync→指纹）为 `skill_versions` INSERT 前置物。
- **G5-2（P1）fusion approval 不在 lease 覆盖集**：§2 列 fusion 为第六 managed writer 但 §6a lease 仅列五者→fusion DB bump 未 publish 时无 lease 挡 migrate/delete/replace 移走 root。**折**：§6a version-write lease 明列**六条 writer 同 funnel 取/释 lease**（含 fusion `commitSkillVersion`）。
- **G5-3（P1）`partial unique(skill_id)` 无法双锁 replace 的 old+new**：ops 表每行仅一 `skill_id`，`next_skill_id` 无约束→DB swap 后新 id 可插第二 active op、两恢复器互相覆盖。**折（§10 新表）**：`CREATE TABLE skill_operation_locks(locked_skill_id PK)`——涉两 skillId 的 op 在 intent 事务对每个 id INSERT 一行 lock，PK 冲突→409；把「同事务锁 old+new」从口头约定变 DB 约束。
- **G5-4（P1）managed-occupier replace 子机违反 external authority 模型 + 漏 hand-external occupier**：真实 `replaceSourceConflict` replacement **永远来自 source candidate**（插 `source-external` 行）、从不发布 managed canonical。**折（§6a 重写 replace）**：三类 occupier 子机，replacement 一律 external DB 行；managed occupier=备份旧 `files`→DB swap 为 external→清备份（**不建 K/不发 managed C**）；补 hand-external occupier（纯 DB detach，旧手选目录不删）；全在 intent 事务双锁 old+new。
- **G5-5（P1）升级前已 transfer 的 hand-external 权威失配无法检测**：hand-external 无 source parent、import 只存当前 owner，transfer 后无法知内容仍由原 importer 控制。**折（§10 新列）**：`skills` ADD `authority_owner_user_id`（内容 provenance，与 ACL `owner_user_id` 分离）；升级前无 provenance 的 hand-external「无法证明一致即 degraded 待 adoption」。
- **P2 集（均已折正文）**：migration 三件套计数贯通（§10/plan T1/proposal 统一 **17 ALTER + 2 CREATE + index + 3 UPDATE**、plan 五 kind、proposal `snapshot-unverified`）；`authorityKind` wire/capability 三态下沉 §2；per-skill token 单持有者进 §2；fusion reject-token 发起端拒绝进 §2；ACL user-active 校验并入 CAS `dbTxSync`；boot 验证 fail-closed 成本预算（逐 skill CAS durable progress + 单 skill 上限、未验不可见）进 §10；**G5-P7 历史 reader symlink regression 测试已补**（`skill-file-symlink-containment.test.ts` `getSkillVersionContent` 拒绝用例，本轮新增）。

**收敛判读**：**首次 findings 下降（13→12）、P1 减 3、零 P0（连续两轮）**——设计门进入收敛区。剩余全为「§6a 深协议闭合」的同域打磨，已全部折入正文（非再挖新维度）。本轮判 sound 面（op-scoped/durable-intent/quarantine-unknown/boot-ordering/FK-NO-ACTION/89-journal/三 symlink 修复）不再回炉。下一轮验收：完备性定理 + 双锁表 + 六-writer lease + replace 三子机是否消解 P1 至「仅 P2 打磨」。

## 19. 170 独立设计门——第 6 轮（Codex adversarial-review，2026-07-13）

verdict **NOT APPROVED：P0=0 / P1=4 / P2=6**。**趋势 10→11→13→13→12→10——总量续降、P1 由 5→4**，仍在收敛区。**G5-2（六-writer lease）已闭合、G5-4 replace 主模型 sound、migration 算术贯通 sound、三态 authority 模型 sound、ACL active 校验路径 sound、op-scoped/durable-intent/quarantine 基础 sound、三处 symlink 修复无回归**——均不再回炉。本轮 4 P1 系上轮折法**留有实质反例**（非新维度），已逐条精修入正文：

- **G6-1（P1）二分定理只定方向、正文自相矛盾**：`db-committed` 被同时纳入回滚/前滚两侧；reserve/migrate/delete/version-write 示例各自二选一违反定理；`cpSync` 正物化 `versions/v<target>` 时崩溃是合法 in-progress 却被举作 impossible。**折（已改 §6a）**：严格 `phase < db-committed → rollback` / `≥ db-committed → rollForward`（db-committed 只属前滚侧），**全示例服从同一律**（reserve/migrate/delete/version-write 的 pre-DB 窗一律回滚、不投机前滚，各给完整幂等 `rollback/rollForward`）；不可变版本先物化 `versions/.op-<op_id>.staged`（逐文件+目录 fsync、验指纹）**验毕才原子 rename→`v<target>`**，故 `v<target>` 要么不存在要么完整——半成品反例消解。
- **G6-2（P1）锁表未成唯一互斥面 + replace 在 DB swap 过早释放锁**：§10 只要求双 ID op 插锁→单 ID DELETE/version-write 不与 replace 的 new-id 锁冲突；managed replace 又在 db-committed 事务删锁（与「done 才释放」矛盾）→swap 后 backup 未清期间 new-id DELETE 插第二 op、恢复器互相覆盖。**折（已改 §6a/§10）**：`skill_operation_locks` 成**唯一 exclusion primitive**——**每个 op（单/双 ID）在 intent 事务对全部 affected id 插锁**、PK 冲突 409；**锁保持到 FS cleanup 完成 + `phase='done'` 同事务才释放**；boot 先在锁持有时恢复 active op、之后才清孤儿锁。
- **G6-3（P1）G5-5 仍检测不了升级前已 transfer 的 hand-external**：§10 把 legacy hand-external `authority_owner_user_id` 回填当前 owner→伪造「内容控制者=当前 owner」使 A→transfer→B 扫描通过。**折（已改 §10）**：legacy hand-external provenance 一律 `NULL`（legacy-unknown）**且标 `source_state='degraded'`** 待 adoption，**绝不回填当前 owner**；仅升级后新 import 写可靠 actor；第三条 CASE UPDATE 同时回填 source-external provenance + 标 hand-external degraded（计数仍 3）。
- **G6-4（P1）boot 成本折法重开「authoritative snapshot 离线损坏不再验」旧 P1**：把 `version_state` 当永久 progress「已验不重验」→首验后 snapshot 离线损坏、下次 boot 仍签 token、用户保存铸损坏为新权威版本。**折（已改 §10）**：**durable 采纳态 ≠ 本 boot 完整性**——`version_state` 只是一次性首采纳门；**每 boot 对所有 `snapshot-authoritative` 重 hash 校验 current snapshot 入内存 `bootVerifiedSet`（boot epoch 作用域）**，detail/list/runtime/token-writer 统一 gate 于本 boot 命中，未命中不可见/不可注入/不可签 token；durable progress 只表示「本次 boot 已完成」不跨 boot。
- **P2 集（均已折 plan/正文）**：`authorityKind` wire+三态 capability 归 T3/T13 + capability 表测试；per-skill token 单持有归 T3（file→save/restore→save/ZIP→detail 三测试）；fusion reject stale-token 归 T6（建 workDir/startTask 前比 token、stale 零副作用 409）；ACL user-active 事务化归 T13（active 预读后 disable→CAS 前恢复→整体 422 rollback 测试）；批次 B/C 去重（B 唯一实现、C 仅适配验收）；managed replace 备份**整个 root**〔含 `versions/`〕非仅 `files`（已改 §6a，防级联删版本 DB 行 + 孤儿 `versions/`）。

**收敛判读**：**P1 连降 8→5→4、零 P0 连续三轮、多域封 sound（六-writer lease/replace 主模型/migration 算术/三态 authority/ACL 路径/op 基础/symlink）**——收敛趋势稳固。本轮 4 P1 全是上轮折法的**精度反例**（定理边界/锁生命周期/provenance 回填/boot 重验），已按 gate 给出的精确 `rollback/rollForward`、唯一锁面、NULL provenance、per-boot 重验四折收敛。下轮验收这四精修是否使 P1→仅 P2。

## 20. 170 独立设计门——第 7 轮（Codex adversarial-review，2026-07-13）

verdict **NOT APPROVED：P0=0 / P1=3 / P2=3**。**趋势 10→11→13→13→12→10→6——总量大降（10→6），P1 8→5→4→3、零 P0 连续四轮**，强收敛。**G6-1～G6-4 四核心均判 sound**（二分律主干、staged 版本消半成品、managed replace 竞态已堵、双锁总规则、G6-3 检测分支、G6-4 `bootVerifiedSet` 完整性、ACL 后端协议、migration 算术+三态 authority）——不再回炉。本轮 3 P1 集中在 migrate 候选保全 / legacy external adoption 出口 / ACL plan 落项，已逐条折入：

- **G7-1（P1）migrate rollForward 清掉必须保留的旧句柄 generation**：§4 要求 rename 前打开的旧 fd 仍写原 inode 的目录 `K` 绝不能删（多代候选），但 migrate rollForward 写「清 `K`、done」→旧 fd 后续写入随 inode unlink 永久丢失（违反 proposal「任何时点手工编辑不丢」）。**折（已改 §6a）**：区分 `K`（inode-bearing generation）与 immutable decision copy `D`；`phase≥db-committed` **只把 `K` 持久登记为下一 generation、绝不由通用 rollForward 删除**，只清不可能再收写入的 `D`/staging。
- **G7-2（P1）legacy hand-external 能进 degraded 但无 fail-closed 语义/adoption 出口**：只标记不 gate→runtime 仍注入权威不明外部目录；一律 gate→升级后 legacy external 永久不可用。**折（新增 §7a + plan T10b）**：degraded 期间 list/detail/runtime/write 全 fail-closed（仅露待-adoption 元信息）；owner/admin 显式 adoption（带 `expectedSkillId` OCC、状态转换+ACL 复核+provenance 写同事务）二选一——转 managed（捕获树为平台快照、断开 externalPath）或 rebind（`authority_owner_user_id=actor`）；补 A→transfer B→upgrade→B 必须 adoption 回归。
- **G7-3（P1）plan T13 仍漏 ACL 前端 revision 管线**：§8 正文已明列全链（`ResourceAcl.aclRevision`/`expectedResourceId`+`expectedAclRevision`/AclPanel 持有推进/409 保稿 reload/transfer 测试），但 T13 只有后端 CAS——后端先要 expected 字段则六类 ACL 编辑全 400。**折（已改 plan T13）**：§8 全链逐字落 T13 + `authorityKind` 消费（external 禁 owner transfer）+ 服务端拒绝测试（此项本是 G3-8 的 P1、不能只留正文）。
- **P2 集（均已折）**：纯 DB replace 子机改「单事务直接 done+释放锁」不留 db-committed active 态（§6a）；G6-4 HTTP 时序矛盾**定为增量开放**（ops-recovery→开 HTTP→后台逐 skill 验、严格 `bootVerifiedSet` gate，合法巨树延迟可用非 quarantine/阻塞，改 §invariant④/§10/plan T-BOOT）；B/C 去重收尾（T11/T12 标「B 已实现、C 仅前端/source 适配」、T-BSAFE 加「备份整 root」验收）。

**收敛判读**：**总量 10→6、P1 3、零 P0 连续四轮、G6 四核心全 sound**——已非常接近 APPROVED。本轮 3 P1 系「§4 一致性（migrate 句柄）/ 缺失出口（external adoption）/ plan 落项（ACL 前端）」三类边界补全，非核心状态机返工。下轮验收这三折 + 增量 boot 是否只剩 P2 → APPROVED。

## 21. 170 独立设计门——第 8 轮（Codex adversarial-review，2026-07-13）

verdict **NOT APPROVED：P0=0 / P1=2 / P2=2**。**趋势 10→11→13→13→12→10→6→4——总量续降、P1 8→5→4→3→2、零 P0 连续五轮**，强收敛。**G7-1、G7-3、纯 DB replace、增量 boot 时序三处一致均判 sound**，且 gate **确认「只 migrate 需 K-保全、其余 kind 无同级漏洞」**（reserve/version-write 操作平台私有 staging、delete/replace 本身即销毁/替换语义）。本轮 2 P1 **均是上轮新增 §7a adoption 机制自身的集成缺口**（新机制引入新集成面），已折入：

- **G8-1（P1）「转 managed」是新 FS+DB mutation 却未进封闭 inventory + 五-kind 恢复器**：§7a 只写「走 §3 ingestion」+ `expectedSkillId`，但 `expectedSkillId` 只挡 ABA、挡不住同 ID 两个 adoption 并发或 adoption×source reconcile 交错；且不能复用 migrate（migrate rename 本地 managed live，adoption 源是用户不可移动 external 目录）。**折（§5/§6a/§7a/§10/plan）**：adoption 入册第 14/15 类；**`adopt-managed`=第六 `skill_operations` kind**（只读捕获 external 树进 op-scoped staging〔symlink reject/hash/fsync〕→原子物化 `versions/v1`→最终事务重读 ACL+CAS 全前态〔`source_state='degraded'`+`expectedSkillId`〕→done，崩溃走二分律，绝不 rename 外部目录）；**`rebind`=纯 DB 单事务 CAS 全前态**（非仅 skillId）；T10b 补 phase kill/restart、managed×rebind 并发、adoption×reconcile 交错、symlink reject 测试。
- **G8-2（P1）增量 boot 的全局 `bootVerifiedSet` gate 会永久挡正常 external/rebind**：invariant④ 要求所有入口命中 set，但 §10 只有 managed snapshot 入 set、external `version_state` 被忽略→正常 external 无生产者、rebind 出口永久不可用。**折（invariant④/§10/plan T-BOOT）**：定义**单一 `isSkillAvailableThisBoot` predicate 按 authority_kind 分流**——managed 要 `bootVerifiedSet` 命中、**external 不走 set**（走 `source_state` 合法 + 读/注入时 realpath containment）、degraded 只元信息、post-boot reserve/adopt-managed 提交后即时入集；补正常 source-external/hand-external/rebind 后 external/post-boot create 四条可用性测试。
- **P2（均已折）**：degraded 终端 stage 交错测试精确化（`resolve(normal)→标 degraded→stage`、两 runtime、终端 stage 用同一 predicate、Claude best-effort 不吞策略拒绝）→T10b；§0 残留旧「9 ALTER」→改为「17 ALTER + 2 CREATE + index + 3 UPDATE（详见 §10）」。

**收敛判读**：**总量 10→4、P1 2、零 P0 连续五轮、G6/G7 多核心全 sound**——逼近 APPROVED。本轮 2 P1 是**新增 adoption 机制的集成补全**（入 inventory + 崩溃恢复子机 + 按-authority 可用性 predicate），非核心状态机返工。下轮验收 adopt-managed 子机 + `isSkillAvailableThisBoot` 分流是否只剩 P2 → APPROVED。

## 22. 170 独立设计门——第 9 轮（Codex adversarial-review，2026-07-13）

verdict **NOT APPROVED：P0=0 / P1=2 / P2=2**。**趋势 10→11→13→13→12→10→6→4→4——总量持平 4、P1 持平 2、零 P0 连续六轮**。**adopt-managed 入 §5/§6a/§10 六-kind CHECK、崩溃二分律、rebind 纯 DB 方向、predicate 分流、external 不入 `bootVerifiedSet`、migration 算术均判 sound**。本轮 2 P1 是 adoption/external 的**确定性绑定 + runtime 安全**两处真实缺口（可复现正确性/安全，非实现细节），已折入：

- **G9-1（P1）adoption 未绑定「确定的外部树 + 完整行前态」**：① rebind 的「全前态 CAS」漏 `external_path`——现 reconcile 能保前四字段不变而只改 `externalPath`〔`skill-source.ts:510`〕，path-only reconcile 后过期 rebind 仍成功、认领的不是用户确认的目录；② adopt-managed 最终态只切 `authority_kind`/断 externalPath、漏同步 `source_kind='managed'`/`source_id=NULL`/`managed_path`，转后仍可能被 reconcile 按 sourceId 改或按 external 注入；③「只读捕获→hash staging」只证复制后冻结、不证复制期间外部树稳定，并发编辑得「旧 SKILL.md × 新支持文件」混合树铸成 v1。**折（§6a/§7a）**：intent 持久化完整 precondition；捕获加**稳定性栅栏 `H_before==H_staging==H_after`**（不一致 409 回滚）；最终 CAS 显式匹配完整前态〔含 externalPath/sourceId/originSourceId〕+ 显式写 `source_kind='managed'`/`source_id=NULL`/`external_path=NULL`/`managed_path`；rebind CAS 补 `external_path`。
- **G9-2（P1，安全）external runtime「逐次 realpath containment」现有 symlink 注入实现不了**：`stageSkills` 直接把整个 external 目录 symlink 给 CLI〔`stageSkills.ts:51,56`〕——根 `realpath` 挡不住树内逃逸 symlink、预扫有 check-then-read TOCTOU、API reader containment 不保护 runtime staging；共享/public external skill 借内含逃逸 symlink 泄露宿主文件。**折（新增 §7b + plan T9b）**：external runtime **改每次运行 no-follow 捕获任务私有只读副本**（遇 symlink reject/或复制 containment 验证字节 → 完成后再扫 → 交不可变副本给 CLI），**不再 symlink mutable external root**；两 runtime 统一、策略拒绝置 Claude best-effort catch 外；补 escaping `SKILL.md` + `resolve→替换 symlink→stage` 两 runtime 测试。
- **P2（均已折）**：proposal/plan 残留「五 kind / 6+6 / 9 ALTER」→统一 canonical「六 kind / 6+6+13+14/15 / 17 ALTER」（旧计数标 obsolete）；三处 predicate 由 §invariant④ 单一 truth table 定义、§10/T-BOOT 引用（非重复以防漂移）。

**收敛判读**：**零 P0 连续六轮、G6~G8 全核心 sound、总量稳定 4**——设计主体已成熟稳固。本轮 2 P1 是 adoption 确定性绑定（capture fence + 完整 CAS）与 external runtime 安全捕获两处**边界安全补全**（用既有 double-read fence / no-follow copy 模式，未引入新机制），非核心返工。下轮验收这两折是否清零 P1 → APPROVED。

- **跨 OS 原子目录交换**：live 是非空目录，POSIX `rename` 不能覆盖非空目标——取「新树写 `files.next-<ulid>` → 旧 live rename 为 `files.old-<ulid>` → 新树 rename 为 `files` → 清理旧目录」的两步交换，或等价符号链接指针方案。**恢复后置条件（G1-10 收紧，取代旧「收敛到某个完整版本」）**：boot 一律**从当前 DB token 指向的 `versions/vN/files` 快照重建 `files` canonical、且重建后 hash 必须等于 `skill_versions.content_hash` 否则 quarantine**；`files.old-*`/`files.next-*` 只作清理/诊断，绝不任选一个完整树当权威。
- **ZIP 冲突响应形态**：候选级失败（该候选 409、其余照常），沿现有 per-candidate 结果数组扩展。
- **snapshot ingestion symlink 策略（V10，G1-7 取代旧 realpath/inode 备注）**：SKILL.md 词法 + realpath/dev+inode 守卫**已完整在 RFC-169**（`services/skill.ts` `assertNotSkillMainFile`），本 RFC **不重复**。真正剩余风险=快照采集含 symlink：`commitSkillVersion` 采集快照**遇 symlink 一律 reject**（write 拒绝；迁移首采纳时该 managed skill 判 quarantine 待人工），杜绝「版本快照含 symlink → 外部 target 改变而 hash 不变」。读路径改快照权威后（G2-1 managed）自然不再跟随 live symlink。
