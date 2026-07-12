# RFC-170 · 技术设计——skills 存储层与 ACL 一致性加固

状态：Draft。产品视角见 `proposal.md`。本文承接 RFC-169 设计门 R5–R16 累积的完整存储协议（那 12 轮 24 findings 的折法在 169 阶段已逐条推演到收敛边界；本 RFC 独立走自己的设计门 + 用户批准后实现）。

## 0. 结论速览

- **migration ×1**：`fusions` 表加 TEXT 列持久化发起时的完整复合 token（现仅 `skill_name + base_skill_version INTEGER`，`schema.ts:1808-1810`）+ 同一 migration 承载 per-skill 迁移标记；撞 `upgrade-rolling` journal 计数锁需 bump（[reference_migration_bumps_journal_count_test]）。
- **不透明复合前置 token**：后端编码 `skillId + contentVersion + metaRevision`，前端只透传；读侧新增字段向后兼容、写侧必填缺失 400。
- **封闭 mutation inventory = 6 版本写 + 6 身份/生命周期写**（§5），前置三分法：版本写=token+事务内重读 ACL；actorful 身份写=expected skillId+事务内重读 ACL；actorless 例外仅一处=system reconcile 的「owner 未脱离 registrar 的目录客观消失删除」。
- **版本快照唯一权威、live 只是可重建投影**：rename 原子发布、崩溃/在线失败从快照重建、修不好在线 quarantine（含运行时注入）。
- **零新产品语义**：纯后端存储/ACL 服务加固；前端仅少量适配（新 token 透传、409 横幅、待迁移决策 UI）。

## 1. 不透明复合前置 token（V1）

纯 `contentVersion` 不是不可复用世代标识：同名删除重建后版本号从低位重来，旧 `{name, version}` 会与新资源 **ABA 重匹配**；仅改 DB 元数据也不推进文件版本，旧 ZIP decision 照样通过。

- token 由后端编码 `skillId + contentVersion + metaRevision`（不透明字符串，前端只透传）；
- 读接口回带；写侧必填（缺失 400 fail-closed），任一分量不匹配 409；
- `metaRevision` 只涵盖表单/ZIP 可写的 meta 字段——ACL/owner 变更不进 revision、不干扰正文保存（ACL 一致性由 §8 的 `aclRevision` 独立管）。

## 2. 六条版本写 + 单 fenced read + combined-save（V2）

**保存协议入口整体在本 RFC**（RFC-169 slim 复审第四轮定案：基础 contentVersion CAS 叠在现状非原子发布上不安全——5xx 后重载读「新版本号 × 残缺正文」、下次 CAS 反铸更高版本永久回退，必须与本 RFC 的快照权威 + rename 原子发布**同时**落地才安全；169 因此保存/读取沿用现状 double-PUT LWW，把整套保存协议留给本 RFC）。本 RFC 一并落地：**单 fenced detail-read**（一响应回带 `{description, bodyMd, 复合 token}`、`ready` gate/双查询播种退役）+ **combined-save 单请求**（新增路由，`loadVisibleSkill`+`requireResourceOwner`；wire 契约 409/422=提交前可重试、5xx=提交不确定需重载；managed 版本 funnel、external metadata-only）+ **复合 token CAS**，并把 OCC 扩到全部六条版本写：

1. **combined-save**（本 RFC 新增：单请求 + 复合 token CAS，见上；169 沿用现状 double-PUT LWW）；
2. **file PUT**、3. **file DELETE**、4. **restore**——现调 `commitSkillVersion` 均不带 expectedVersion（`skill.ts:381-442`、`skillVersion.ts:472-515`），补 token 校验；
5. **ZIP overwrite**——现直接删写 live 只动 metadata、不推进版本（`skill-zip.ts:251-309,348-381`），纳为版本写：决策阶段读取的版本为 token、经 `commitSkillVersion` 落版本；ZIP 解析响应与 overwrite decision **逐候选携带同一 token**（shared decision schema 增补字段，`schemas/skill.ts:223-258` 现无）；stale 冲突取**候选级失败**（该候选 409、其余照常，避免部分提交后全局 409）；
6. **fusion 审批**——现以 `skillName+baseSkillVersion` 提交、不存 skillId 不复核 owner（`fusion.ts:751-766`）：发起时持久化完整复合 token（migration 的 TEXT 列）、批准**同事务** CAS 状态+token+skillId+actor owner/admin 权限，再提交版本与 memory provenance；存量无 token 的待审批行 fail-closed（提示重发起）。

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

## 5. 封闭 mutation inventory（6 版本写 + 6 身份/生命周期写）

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

`fusions` ADD TEXT 列（发起时完整复合 token）+ per-skill 迁移标记（同一 migration）。撞 journal 计数锁需 bump 标题+断言+注释 N→N+1（[reference_migration_bumps_journal_count_test]），且多语句需 `--> statement-breakpoint`（[reference_migration_statement_breakpoint]）。

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

## 13. 实现期备注（IMPLEMENTATION-NOTE）

- **跨 OS 原子目录交换**：live 是非空目录，POSIX `rename` 不能覆盖非空目标——取「新树写 `files.next-<ulid>` → 旧 live rename 为 `files.old-<ulid>` → 新树 rename 为 `files` → 清理旧目录」的两步交换，或等价符号链接指针方案；语义锁定「任一中间态下启动恢复能收敛到某个完整版本」（实现期实测为准）。
- **ZIP 冲突响应形态**：候选级失败（该候选 409、其余照常），沿现有 per-candidate 结果数组扩展。
- **realpath/inode 身份（V10）**：SKILL.md 基础 case-fold 守卫已在 RFC-169；本 RFC 补符号链接/inode realpath 兜底（已存在目标 realpath === 根主文件亦拒）。
