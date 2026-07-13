# RFC-170 · 任务分解

状态：Draft（待独立走完设计门 + 用户批准后实现）。本仓 main 直推，每批自带测试、过全量门禁（typecheck/lint/test/format:check/frontend vitest/build:binary 冒烟 + migration 后 `upgrade-rolling` 计数锁 bump）。

> 依赖关系：RFC-170 **在 RFC-169 落地之后**实施。**基线澄清**：169 的 skills 保存/读取仍是**现状 double-PUT LWW**（169 只做了 SKILL.md 守卫+探针+前端 reseed，未碰保存协议）；本 RFC 从 double-PUT 基线**新建** combined-save + 单 fenced read + 复合 token CAS，且**与快照权威 + rename 原子发布同批落地**（slim 复审第四轮定案：CAS 叠非原子发布不安全，二者不可分批）。

> **设计门第 1 轮（2026-07-13）折入 plan 的结构变更**：① creation reservation（原 T12 创建部分）**上移进批次 B**（G1-6：批次 B 已开写协议+快照权威，create 仍直写共享 live 会把并发请求内容铸成权威，reservation 不可与写协议分批）；② migration 扩为 **9 ALTER + `skill_operations` 专表 + `skills.reservation_state`**（G1-2/3：持久 journal/replacing/reservation/orphaned + DELETE tombstone）；③ 新增 **lazy v1 backfill 版本写（第 13 类 mutation）+ legacy-无快照迁移分支**（G1-4）；④ 读路径快照权威改 GET/fusion/runtime 三处（G1-1，进批次 B 不可达门内）。

## 批次 A —— token codec 纯地基（不面向消费者，可独立部署）

- **RFC-170-T2** 复合 token 编解码纯函数（`skillId+contentVersion+metaRevision` ⇄ 不透明串）+ 单测（已实现：`services/skillToken.ts`+`tests/skill-token.test.ts`，10 测试绿）。**批次 A 仅 codec——migration 上移与批次 B 同批**（G1-2：migration 现含 reservation/journal 状态，与写协议同 schema 面，不再是「纯地基」；避免存量 schema 与未生效协议脱节）。（T1 migration + T3 读接口透传均移入批次 B——F2/G1-1：token 读/schema 状态不能在快照权威+reservation 保护生效前面向消费者。）

## 批次 B —— **快照权威 + 版本写 OCC + 运行时隔离 + 分叉前置门（可独立部署的安全单元）**

> **F2 定案：批次 B 必须自成一个安全部署单元**——新写协议/token 读、运行时 quarantine 终检、存量分叉 fail-closed 前置门都必须在此批同时生效，否则独立部署 A/B 会返回「带 token 的残缺内容」、让 quarantined skill 继续被任务注入、或在完整迁移 UI 到来前静默覆盖存量分叉。完整迁移决策 **UI** 可后置（批次 C），但**读写路由 / 恢复覆盖 / runtime staging 在全部保护生效前一律不可达**；每批次可部署测试。

- **RFC-170-T7**（先落）发布改临时目录 + rename 原子换入（跨 OS 两步交换）；`commitSkillVersion` 重写为快照权威 + 在线失败即修即隔离 + 启动恢复从快照重建 + degraded 隔离拒写；**存量分叉 fail-closed 前置门**（未迁移 + live≠快照 → 读返回快照/不签 token、写拒绝、恢复绝不覆盖 existing-but-different live——现 `skillVersion.ts:527-534` 拒覆盖行为对此收紧为显式 pending 态）；崩溃/kill-restart 注入测试。
- **RFC-170-T1**（同批地基）migration ×1（**精确清单以 design.md §10 为准：17 ALTER + 2 CREATE TABLE + partial-unique index + 3 backfill UPDATE**——六表 `acl_revision` + `fusions.precondition_token` + `skills` 八新列〔`meta_revision`/`migration_marker`/`reservation_state`/`version_state`/`authority_kind`/`source_state`/`origin_source_id`/`authority_owner_user_id`〕 + `skill_sources` 两列〔`lifecycle_state`/`deleted_at`〕）**+ 专表 `skill_operations`**（**五 kind** reserve/replace/migrate/delete/**version-write** 的 phase/路径/指纹/generation/owner，boot 幂等续跑）**+ 专表 `skill_operation_locks`**（双 skillId 互斥 PK 锁，G5-3）；journal 89→90 计数锁 bump；`--> statement-breakpoint` 分隔。**移入批次 B**——schema 状态与快照权威+reservation 保护同批生效，避免存量 schema 脱节。
- **RFC-170-T3**（依赖 T7）读接口回带复合 token（combined detail-read + file/tree GET）+ double-read fence；**读路径快照权威（G1-1）**——detail content/file·tree GET/fusion base/runtime stage 内容种子取 token 指向快照、不读 live，签 token/注入前 live identity hash 校验（漂移→pending/quarantine）；**token 读在 T7 保护生效前不面向消费者**。**前端复合 token 单一持有者（G5-P3/G6-P2，非「透传」）**：QueryClient 该 skill detail 结果即 token 权威源、每个成功版本写响应原子替换该缓存条目、restore/ZIP reseed draft baseline；补 **file→save / restore→save / ZIP→detail 三条连续操作不自冲突** 前端测试。**shared `Skill` 暴露 `authorityKind`（`'managed'|'source-external'|'hand-external'`，G5-P2/G6-P1）**：`schemas/skill.ts` wire 加字段、`skill-capabilities.ts` 按三态派生 `canEditDescription/canDelete/canTransferOwner`，锁三态 capability 表测试。
- **RFC-170-T4a**（同批，G1-4）`ensureInitialSkillVersion` lazy v1 backfill 纳入 mutation inventory 第 13 类（特判：仅 content_version 未初始化才允许、成功签首 token）+ **legacy managed 无快照迁移分支**（有 live 无 skill_versions=合法待 backfill 非损坏，一次性采纳为 v1）。
- **RFC-170-T6b**（同批，G1-6）**creation reservation 上移入批次 B**：create/ZIP-create 改 reservation 行先行（`reservation_state='reserving'` 对读者不可见）→ 专属 staging → 仅 owner 原子发布（rename staging→canonical）+ 置 ready → 失败清自己 staging+行。`getSkill`/list/scheduler 过滤非 ready。
- **RFC-170-T4**（依赖 T7）**从 double-PUT 基线新建 combined-save**（单请求 + 单 fenced detail-read + `loadVisibleSkill`+`requireResourceOwner` + wire 契约 409/422 提交前/5xx 提交不确定）+ file PUT / file DELETE / restore 换复合 token 校验、`commitSkillVersion` 回带新 token、最终事务内重读 ACL；**端点在 T7 保护生效前不可达**。
- **RFC-170-T5** ZIP overwrite 纳为版本写（依赖 T7）。
- **RFC-170-T6** fusion 审批：发起持久化 token、批准同事务 CAS + legacy row fail-closed（依赖 T7）；**reject/re-run stale-token 拒绝（G5-P4/G6-P3）**——re-run 在**创建 workDir / startTask 之前**比较持久化 row token 与当前权威 token，stale 时**零副作用 409**（提示重新发起融合，不以「最新 live baseline + 旧 baseVersion」重跑产误导 diff、不拖到最终 approval 才 409；现 `fusion.ts:839-846` reject 直接以 current live 建 baseline，须前移比较）。
- **RFC-170-T9**（同批）quarantine 双检查点：pre-spawn 解析层 + skillId/generation 随 ResolvedSkill 传 stageSkills 终检（含 Claude 路径）；两 runtime 拒注入测试——**运行时隔离必须与写协议同批，否则 quarantined skill 仍被注入**。
- **RFC-170-T-BSAFE**（G2-6/G3-6 修正——批次 B 安全部署单元实际闭合）：以下四项从批次 C **上移入批次 B**（否则 B 单独部署仍有确定破口）：① DELETE tombstone 操作锁（原 T12）；② conflict-replace 可回滚交换+journal（原 T11，**G7-P3 验收：managed occupier 备份整个 `skills/{name}` root〔含 `versions/` 版本历史〕到 root 外 op-scoped backup、swap 成功后统一清、锁持到 done——不止 rename `files`**）；③ 旧 metadata `PUT /skills/:name` **与旧 content `PUT /skills/:name/content` 同时 410**（原 T13，G3-3 补 content）；④ snapshot ingestion symlink reject + **external file/tree GET realpath containment（G3-1 安全）**（原 T13）。批次 C 只留完整迁移决策 UI + degraded external adoption + source 生命周期 + ACL 前端管线。
- **RFC-170-T-BOOT**（G3-5/**G7-P2 增量开放**）：boot = ops-recovery → source reconcile → **开 HTTP**，snapshot 重验**挂在 HTTP 之后后台**逐 managed skill 跑（content_version 行/目录 + hash 匹配 + 无 symlink + SKILL.md 合法）→ 通过入内存 `bootVerifiedSet`、失败 CAS `'quarantined'`；**detail/list/runtime/token-writer/scheduler 统一 gate 于本 boot `bootVerifiedSet` 命中**（未验不可见/不可注入）；存量一律先 `'snapshot-unverified'`、首采纳深验通过才 `'snapshot-authoritative'`。**不设全量 barrier**（合法巨树延迟可用而非 quarantine/阻塞启动）；补「首验后离线损坏→下次 boot 抓住不签 token」+「未验 skill 不可注入」测试。

## 批次 C —— 存量迁移决策 UI + source 生命周期 + ACL（reservation 已移批次 B）

> **G6-P5 去重**：`skill_operations` 核心状态机（replace 可回滚交换 / DELETE tombstone 锁 / 旧双 PUT 410 / symlink reject+containment）**唯一实现任务在批次 B 的 T-BSAFE**——批次 C 的 T11/T12/T13 对这些项**只做 UI/source/ACL 后置适配与验收，不重复实现**（下列各条已标注哪部分是「B 已实现、此处仅接线/测试」）。

- **RFC-170-T10** 存量分叉**完整迁移决策**（多代候选无条件捕获/隔离快照/journal/各 phase kill-restart + 前端待迁移 UI 二选一）——**在批次 B 的 fail-closed 前置门之上**补完整决策流。
- **RFC-170-T10b**（G7-2，§7a）**degraded external adoption 状态机**：legacy external（一切 hand-external + owner≠registrar 的 source-external）`source_state='degraded'` 期间从 list/detail/runtime/write **fail-closed**（仅露「待 adoption」元信息）；owner/admin 显式 adoption（带 `expectedSkillId` OCC，状态转换+ACL 复核+provenance 写同事务）二选一——**转 managed**（捕获当前树为平台快照走 §3 ingestion、断开 externalPath、`authority_kind='managed'`）或 **rebind**（`authority_owner_user_id=actor`、保持 external）；补 **A import→transfer B→upgrade→B 必须 adoption 才可用** 回归 + 「degraded 不可注入 runtime」测试。**批次 B 只 gate（degraded fail-closed），adoption 出口 UI/服务在 C**。
- **RFC-170-T11**（**核心状态机已在 T-BSAFE 实现，此处仅前端验收**）conflict-replace 可回滚交换 + replace journal + replacing 世代互斥的**前端冲突对话框接线 + 集成验收**（三类 occupier 子机、双锁、整-root 备份的行为已由 B 落地，C 不重复实现）。
- **RFC-170-T12** **DELETE 核心 tombstone 状态机已在 T-BSAFE（①）实现**；此处只做 **source 生命周期**（reconcileSource user/system 拆分、逐 child ACL、actorless 仅 owner=registrar 目录消失；description 写回同事务 bump metaRevision，G1-5）+ DELETE 前端接线验收。（创建 reservation 已移批次 B、DELETE 状态机已在 B。）
- **RFC-170-T13** ACL PUT `aclRevision` 六资源 CAS（共享 resourceAcl 服务，**GET 单同步只读事务/revision double-read** 防混合快照 + `prevOwner`/grants 在 CAS 同事务快照内算，G1-9）+ **被引用用户 active 校验并入 CAS 同事务（G5-P5/G6-P4）**——owner/grantee 存在+active 用 `.get`/`.all` 在 CAS `dbTxSync` 内校验（现 `resourceAcl.ts:261-276` 事务外 await→用户可在预读与 CAS 间被 disable 仍成 owner/grantee），失败整事务 rollback+422；补「active 预读后 disable、CAS 前恢复 → 整体 422 rollback」测试 + **snapshot ingestion symlink 策略**（commitSkillVersion 采集遇 symlink 一律 reject、存量含 symlink live 首采纳判 quarantine，G1-7；realpath/inode SKILL.md 守卫已在 RFC-169）+ 旧 `PUT /skills/:name` metadata-only 改 **410 Gone**（G1-5）。
  - **前端 ACL revision 管线全链（G3-8/G7-3，六类资源同步，缺则六类 ACL PUT 全 400）**：shared `ResourceAcl` 加 `aclRevision`（`schemas/resourceAcl.ts` 现只有 owner/visibility/userIds）；PUT body 加 `expectedResourceId`+`expectedAclRevision`；`AclPanel` 从 GET 持有 revision、PUT 成功后原子推进、**409 保留草稿并提示 reload**；补 transfer 与普通 grant/visibility 两条前端测试。**六类资源（agents/skills/mcps/plugins/workflows/workgroups）复用同一 `AclPanel`、一次改全受益**。
  - **`authorityKind` 在 ACL 面消费（G7-3）**：`AclPanel` 依 skill `authorityKind` **对 external（`source-external`/`hand-external`）禁 owner transfer**（§8：external 内容由原 registrar/importer 控制，transfer 后「owner 才可改」成假承诺；grant/visibility 仍可改）；补 external transfer **服务端拒绝** + 前端控件禁用两测试。

## 批次 E —— 收尾

- **RFC-170-T14** 封闭 mutation inventory 源码锁 + 全量测试矩阵㉖–㊲ 逐条 + grep 复核。
- **RFC-170-T15** 归档：`design/plan.md` 索引置 Done、`STATE.md` 已完成表加行。

## 验收清单（对 proposal §5 逐条）

- [ ] 复合 token 全链（ABA/仅元数据/缺 token/连续保存）
- [ ] 6+6 封闭 inventory + 全写入口 ACL 屏障
- [ ] 快照权威 + 崩溃恢复 + 各 phase kill/restart
- [ ] quarantine 全链（含运行时注入两 runtime）
- [ ] 存量升级不丢 + 多代候选 + 逐字节一致
- [ ] source 生命周期 ACL
- [ ] ACL aclRevision 六资源
- [ ] 创建 reservation
- [ ] migration ×1 + journal 锁 bump + 门禁绿
