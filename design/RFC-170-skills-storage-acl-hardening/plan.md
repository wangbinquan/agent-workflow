# RFC-170 · 任务分解

状态：Draft（待独立走完设计门 + 用户批准后实现）。本仓 main 直推，每批自带测试、过全量门禁（typecheck/lint/test/format:check/frontend vitest/build:binary 冒烟 + migration 后 `upgrade-rolling` 计数锁 bump）。

> 依赖关系：RFC-170 **在 RFC-169 落地之后**实施。**基线澄清**：169 的 skills 保存/读取仍是**现状 double-PUT LWW**（169 只做了 SKILL.md 守卫+探针+前端 reseed，未碰保存协议）；本 RFC 从 double-PUT 基线**新建** combined-save + 单 fenced read + 复合 token CAS，且**与快照权威 + rename 原子发布同批落地**（slim 复审第四轮定案：CAS 叠非原子发布不安全，二者不可分批）。

> **设计门第 1 轮（2026-07-13）折入 plan 的结构变更**：① creation reservation（原 T12 创建部分）**上移进批次 B**（G1-6：批次 B 已开写协议+快照权威，create 仍直写共享 live 会把并发请求内容铸成权威，reservation 不可与写协议分批）；② migration 扩为 **9 ALTER + `skill_operations` 专表 + `skills.reservation_state`**（G1-2/3：持久 journal/replacing/reservation/orphaned + DELETE tombstone）；③ 新增 **lazy v1 backfill 版本写（第 13 类 mutation）+ legacy-无快照迁移分支**（G1-4）；④ 读路径快照权威改 GET/fusion/runtime 三处（G1-1，进批次 B 不可达门内）。

## 批次 A —— token codec 纯地基（不面向消费者，可独立部署）

- **RFC-170-T2** 复合 token 编解码纯函数（`skillId+contentVersion+metaRevision` ⇄ 不透明串）+ 单测（已实现：`services/skillToken.ts`+`tests/skill-token.test.ts`，10 测试绿）。**批次 A 仅 codec——migration 上移与批次 B 同批**（G1-2：migration 现含 reservation/journal 状态，与写协议同 schema 面，不再是「纯地基」；避免存量 schema 与未生效协议脱节）。（T1 migration + T3 读接口透传均移入批次 B——F2/G1-1：token 读/schema 状态不能在快照权威+reservation 保护生效前面向消费者。）

## 批次 B —— **快照权威 + 版本写 OCC + 运行时隔离 + 分叉前置门（可独立部署的安全单元）**

> **F2 定案：批次 B 必须自成一个安全部署单元**——新写协议/token 读、运行时 quarantine 终检、存量分叉 fail-closed 前置门都必须在此批同时生效，否则独立部署 A/B 会返回「带 token 的残缺内容」、让 quarantined skill 继续被任务注入、或在完整迁移 UI 到来前静默覆盖存量分叉。完整迁移决策 **UI** 可后置（批次 C），但**读写路由 / 恢复覆盖 / runtime staging 在全部保护生效前一律不可达**；每批次可部署测试。

- **RFC-170-T7**（先落）发布改临时目录 + rename 原子换入（跨 OS 两步交换）；`commitSkillVersion` 重写为快照权威 + 在线失败即修即隔离 + 启动恢复从快照重建 + degraded 隔离拒写；**存量分叉 fail-closed 前置门**（未迁移 + live≠快照 → 读返回快照/不签 token、写拒绝、恢复绝不覆盖 existing-but-different live——现 `skillVersion.ts:527-534` 拒覆盖行为对此收紧为显式 pending 态）；崩溃/kill-restart 注入测试。
- **RFC-170-T1**（同批地基）migration ×1（9 ALTER：六表 `acl_revision` + `fusions.precondition_token` + `skills.meta_revision` + `skills.migration_marker`）**+ 专表 `skill_operations`**（reserve/replace/migrate/delete 的 phase/路径/指纹/generation/owner，boot 幂等续跑）**+ `skills.reservation_state`**（G1-2/3）；journal 89→90 计数锁 bump；`--> statement-breakpoint` 分隔。**移入批次 B**——schema 状态与快照权威+reservation 保护同批生效，避免存量 schema 脱节。
- **RFC-170-T3**（依赖 T7）读接口回带复合 token（combined detail-read + file/tree GET）+ double-read fence + 前端透传；**读路径快照权威（G1-1）**——detail content/file·tree GET/fusion base/runtime stage 内容种子取 token 指向快照、不读 live，签 token/注入前 live identity hash 校验（漂移→pending/quarantine）；**token 读在 T7 保护生效前不面向消费者**。
- **RFC-170-T4a**（同批，G1-4）`ensureInitialSkillVersion` lazy v1 backfill 纳入 mutation inventory 第 13 类（特判：仅 content_version 未初始化才允许、成功签首 token）+ **legacy managed 无快照迁移分支**（有 live 无 skill_versions=合法待 backfill 非损坏，一次性采纳为 v1）。
- **RFC-170-T6b**（同批，G1-6）**creation reservation 上移入批次 B**：create/ZIP-create 改 reservation 行先行（`reservation_state='reserving'` 对读者不可见）→ 专属 staging → 仅 owner 原子发布（rename staging→canonical）+ 置 ready → 失败清自己 staging+行。`getSkill`/list/scheduler 过滤非 ready。
- **RFC-170-T4**（依赖 T7）**从 double-PUT 基线新建 combined-save**（单请求 + 单 fenced detail-read + `loadVisibleSkill`+`requireResourceOwner` + wire 契约 409/422 提交前/5xx 提交不确定）+ file PUT / file DELETE / restore 换复合 token 校验、`commitSkillVersion` 回带新 token、最终事务内重读 ACL；**端点在 T7 保护生效前不可达**。
- **RFC-170-T5** ZIP overwrite 纳为版本写（依赖 T7）。
- **RFC-170-T6** fusion 审批：发起持久化 token、批准同事务 CAS + legacy row fail-closed（依赖 T7）。
- **RFC-170-T9**（同批）quarantine 双检查点：pre-spawn 解析层 + skillId/generation 随 ResolvedSkill 传 stageSkills 终检（含 Claude 路径）；两 runtime 拒注入测试——**运行时隔离必须与写协议同批，否则 quarantined skill 仍被注入**。
- **RFC-170-T-BSAFE**（G2-6/G3-6 修正——批次 B 安全部署单元实际闭合）：以下四项从批次 C **上移入批次 B**（否则 B 单独部署仍有确定破口）：① DELETE tombstone 操作锁（原 T12）；② conflict-replace 可回滚交换+journal（原 T11）；③ 旧 metadata `PUT /skills/:name` **与旧 content `PUT /skills/:name/content` 同时 410**（原 T13，G3-3 补 content）；④ snapshot ingestion symlink reject + **external file/tree GET realpath containment（G3-1 安全）**（原 T13）。批次 C 只留完整迁移决策 UI + source 生命周期 + ACL 前端管线。
- **RFC-170-T-BOOT**（G3-5）boot 在开放 HTTP/runtime 前逐 managed skill 验证快照（content_version 行/目录 + hash 匹配 + 无 symlink + SKILL.md 合法）→ CAS `'snapshot-authoritative'` 否则 quarantine；存量一律先 `'snapshot-unverified'`。

## 批次 C —— 存量迁移决策 UI + source 生命周期 + ACL（reservation 已移批次 B）

- **RFC-170-T10** 存量分叉**完整迁移决策**（多代候选无条件捕获/隔离快照/journal/各 phase kill-restart + 前端待迁移 UI 二选一）——**在批次 B 的 fail-closed 前置门之上**补完整决策流。
- **RFC-170-T11** conflict-replace 可回滚交换 + replace journal + replacing 世代互斥（一切最终提交检查）。
- **RFC-170-T12** 资源级 DELETE（**tombstone/journal 三段**：rename→`.trash/{skillId}-{ulid}` → DB delete → 清 trash，boot 依 `skill_operations` 幂等续，快照始终可从 token 重建，G1-3）+ source 生命周期（reconcileSource user/system 拆分、逐 child ACL、actorless 仅 owner=registrar 目录消失；description 写回同事务 bump metaRevision，G1-5）。（创建 reservation 已移批次 B。）
- **RFC-170-T13** ACL PUT `aclRevision` 六资源 CAS（共享 resourceAcl 服务，**GET 单同步只读事务/revision double-read** 防混合快照 + `prevOwner`/grants 在 CAS 同事务快照内算，G1-9）+ **snapshot ingestion symlink 策略**（commitSkillVersion 采集遇 symlink 一律 reject、存量含 symlink live 首采纳判 quarantine，G1-7；realpath/inode SKILL.md 守卫已在 RFC-169）+ 旧 `PUT /skills/:name` metadata-only 改 **410 Gone**（G1-5）。

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
