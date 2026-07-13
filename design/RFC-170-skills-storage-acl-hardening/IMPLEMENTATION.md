# RFC-170 批次 B 实现指引（IMPLEMENTATION）

> 本文把「设计门收敛的 design.md/plan.md」翻译成**可执行的接线计划**：已落地的四层
> 底座 API、每个具体 op 改写哪个现有函数 / 与谁纠缠 / recovery 形态、以及推荐执行
> 顺序。承接 2026-07-13 会话（设计门 10 轮收敛 + 用户批准实现 + 底座四层 CI 绿）。

## 0. 已落地的底座四层（32 测试、CI 绿 `97428109`）

| 模块                                  | 关键导出                                                                                                                                                                                                                                                                     | 用途                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `db/migrations/0090` + `db/schema.ts` | skills 8 列 / skill_sources 3 列 / fusions token / 六表 acl_revision / `skill_operations` / `skill_operation_locks`                                                                                                                                                          | schema 地基（dormant）                         |
| `services/skillOperations.ts`         | `beginOperation(tx,spec)→opId` · `advancePhase(tx,opId,phase,patch?)` · `finishOperation(tx,opId)` · `abandonOperation(tx,opId)` · `acquireOpLocks/releaseOpLocks` · `getActiveOp/listActiveOps` · `gcOrphanLocks` · types `SkillOpKind`/`SkillOpPhase`/`BeginOperationSpec` | §6a 状态机 primitive（全部接 `DbTxSync` 组合） |
| `services/skillFsPublish.ts`          | `opStagedDir/opBackupDir/opCandidateDir/opScopedDir` · `swapInStaged(filesDir,opId)→{hadPrevious}` · `restoreFromBackup(filesDir,opId)` · `cleanupOpDirs(filesDir,opId)`                                                                                                     | §6a/§13 op-scoped 原子 publish（纯 FS leaf）   |
| `services/skillOpRecovery.ts`         | `SKILL_OP_PHASE_SEQUENCES` · `recoveryDirection(kind,phase)→'noop'\|'rollback'\|'rollforward'\|'quarantine'`                                                                                                                                                                 | §6a 恢复完备性纯 oracle                        |

**标准 op 生命周期**（每个具体 op 都是这个骨架）：

```
dbTxSync: beginOperation(intent + 取锁 [+ 前置 DB 行如 reserving])   // §6a ①
  <FS 步 1>; dbTxSync: advancePhase('fs-staged'/'fs-captured'/...)     // §6a ②
  <FS 步 2>; dbTxSync: advancePhase('fs-versioned'/...)
dbTxSync: { 权威 DB 写(swap/delete/bump+INSERT); advancePhase('db-committed') }  // §6a ③ 同事务
  <FS publish 步(swapInStaged)>                                        // 仅 db-committed 之后的 kind
dbTxSync: finishOperation(done + 释放锁); cleanupOpDirs                // §6a ⑤
// throw 处理：phase<db-committed → dbTxSync(abandonOperation)+restoreFromBackup+cleanupOpDirs
//            phase≥db-committed → 不回滚，前滚补完（同 recovery 的 rollForward）
```

## 1. 每个具体 op 的接线映射

| kind                         | 改写/新增                                                                | 现有入口                                                          | 纠缠                                                                                   | rollback                                                                                               | rollForward                                                             |
| ---------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| **version-write**（T7 核心） | 重写 `commitSkillVersion`（`skillVersion.ts:273`，现「先删后拷」非原子） | file PUT/DELETE·restore·ZIP·fusion·combined-save 六 writer 全走它 | **reserve 依赖它建 v1**；先做                                                          | 删 staged + `versions/.op-<id>.staged`/已现的 `versions/v<target>`（DB 未 bump 故无引用）；撤 lease+锁 | 从 `versions/v<target>` 或 staged 重建 `files`（swapInStaged）；置 done |
| **reserve**（T6b）           | 改 `createManagedSkill`（`skill.ts:86`）+ ZIP create（`skill-zip.ts`）   | POST /skills、ZIP import                                          | 依赖 version-write 建 v1                                                               | 删 reserving skills 行 + staged + 撤锁                                                                 | 补 `reservation_state='ready'` + done                                   |
| **delete**（T-BSAFE①）       | 改资源 DELETE（`skill.ts` deleteSkill）                                  | DELETE /skills/:name                                              | backup=`.trash/<skillId>-<opId>`（非 op-scoped-adjacent，recovery 用 `op.backupPath`） | rename trash→skills root、撤锁                                                                         | 清 trash、done                                                          |
| **replace**（T-BSAFE②）      | 改 `replaceSourceConflict`（`skill-source.ts:335`）                      | 冲突 replace 决策                                                 | 三子机（managed/source-ext/hand-ext occupier）；managed occupier 备份**整个 root**     | rename backup→root（含 versions/）、撤双锁                                                             | 清 backup、done                                                         |
| **migrate**（T10）           | 新增（legacy 分叉首采纳，现无此路径）                                    | 迁移决策 UI                                                       | backup=`K`（inode-bearing，**不删**，登记为下代 generation，G7-1）                     | rename K→files 复原原始 live                                                                           | 确保 C、登记 K 为候选、清 D、done                                       |
| **adopt-managed**（T10b）    | 新增两阶段 capture→confirm→commit（现无 adoption）                       | degraded external adoption                                        | 阶段 A capture 用 §7b descriptor-relative no-follow；INSERT skill_versions(v1)         | 删 candidate/versions/v1、撤锁（external 仍 degraded）                                                 | 确保 v1/canonical、done                                                 |

## 2. Recovery driver（T-BOOT）= 依赖注入 dispatcher

每个 op 模块导出自己的 `{ recoverFs(op,fsOpts): void; recoverDb(tx,op): void }` **按 direction 分**
（rollback / rollForward 各一），注册进 registry `Record<SkillOpKind, RecoveryHandlers>`。driver：

```
recoverSkillOperations(db, fsOpts):
  for op of listActiveOps(db):
    dir = recoveryDirection(op.kind, op.phase)
    if dir=='quarantine': dbTxSync(mark skill version_state='quarantined'〔managed〕 + abandonOperation)  // 通用、现可实现
    elif dir=='rollback':  registry[op.kind].rollback.recoverFs(op,fsOpts); dbTxSync{ registry[..].recoverDb(tx,op); abandonOperation(tx,op.opId) }
    elif dir=='rollforward': registry[op.kind].rollForward.recoverFs(op,fsOpts); dbTxSync{ registry[..].recoverDb(tx,op); finishOperation(tx,op.opId) }
  dbTxSync(gcOrphanLocks)   // 必须在所有 active op 恢复之后（§6a 次序）
  // 挂 start.ts：ops-recovery 在 DB@170 之后、开 HTTP@341 之前（§invariant④）
```

**关键**：driver 自身逻辑（dispatch + quarantine + gcOrphanLocks 次序）可先用**合成 handler**
（spy）完整测试；per-kind handler 随各 op 落地填充（与 forward 同模块，保证 forward↔recovery 一致）。

## 3. 推荐执行顺序（依赖驱动）

1. **version-write（T7）**——最核心 + reserve 依赖它；重写 commitSkillVersion 为「op-scoped
   staged→versions/v<target> 原子物化→db-committed bump+INSERT→swapInStaged publish→done」，
   六 writer funnel 取 lease。**务必保持现有六 writer 调用方语义**（大量集成测试锁）。
2. **reserve（T6b）**——接 createManagedSkill + ZIP create，复用 1 的 v1 建立。
3. **delete + replace（T-BSAFE）**——DELETE tombstone + 冲突 replace 三子机 + 旧端点 410 + symlink reject。
4. **recovery driver（T-BOOT）**——registry + driver + 挂 start.ts + 合成/真实 handler 测试。
5. **migrate（T10）+ adopt-managed（T10b）**——新增路径（additive，低回归）；adopt 需 §7b 捕获。
6. **读路径复合 token（T3）+ combined-save（T4）**——detail 单 fenced read + token CAS。
7. **quarantine 双检查点（T9）+ external 安全捕获（T9b）**——运行时注入 gate + descriptor-relative。
8. **ACL aclRevision CAS 全链（T13）**——共享 resourceAcl + 前端 AclPanel revision 管线 + user-active 事务化。
9. **前端**——skills detail token 单持有 + authorityKind 三态 capability + adoption UI。

每步：**先写红测试→实现→绿**，`bun run typecheck && lint && test && format:check`，触及现有六 writer /
create / delete 后跑全后端 5200+ 回归；触及 shared export 跑 `build:binary` smoke（[reference_binary_build_module_cycle]）。
多人树按精确 pathspec 提交、勿碰他人 `scheduler.ts`（RFC-172）WIP。

## 4. 不变量速查（实现时勿违反）

- `dbTxSync` 内**禁 await**、用 `.all/.get/.run`；CAS 靠 read-then-check 或 WHERE 前态（drizzle `.run()` 无 changes）。
- 锁**活到 phase='done'**（非 db-committed）——backup 清理与 new-id 互斥须持续（G6-2）。
- 纯 DB op（source-ext/hand-ext replace、rebind）**单事务直接 done**、不留可观察 db-committed active 态（P2-1）。
- adopt-managed **提交对象是已捕获 candidate**（非源再读）；migrate **绝不删 K**（旧 fd 仍写，G7-1）。
- external runtime **不 symlink mutable root**、每运行 descriptor-relative no-follow 捕获私有副本（G10-2）；实现不了 **fail-closed**。
- boot：managed 走 `bootVerifiedSet`（每 boot 重 hash）、external 走 `source_state` 合法（不入 set）、degraded 只元信息（G8-2 `isSkillAvailableThisBoot`）。

## 5. 已落地进度（2026-07-12/13 session，全部 CI/full-suite 验证）

批次 B 19 实现 commit：① migration 0090 · ② skillOperations · ③ skillFsPublish ·
④ skillOpRecovery oracle · ⑤ **T7 增量①**（commitSkillVersion 原子发布）· ⑥ **T13
后端** ACL aclRevision CAS · ⑦ skillOpRecoveryDriver + boot 接线 · ⑧ **delete op** ·
⑨ **T13 前端**（AclPanel revision 管线）· ⑩ **reserve op** · ⑪ **T3** 读路径复合
token · ⑫ **T4 后端** combined-save 端点 · ⑬ **T7 增量②**（commitSkillVersion 包
version-write op，lease + 崩溃恢复）· ⑭ **replace op**（conflict-replace managed
占位者改走崩溃安全 delete op）· ⑮ **T4 前端**（受管技能保存改单次原子 POST /save，
token OCC；external/legacy 保留双 PUT）· ⑯ **T3 authorityKind wire + §8 G3-2 transfer
阻断**（三态权威上 wire + updateResourceAcl 事务内拒 external owner transfer）· ⑰
**三态 capability 落 UI**（source-external 描述只读 + external 隐藏 owner 转移，
AclPanel 加 canTransferOwner 可选 prop）· ⑱ **§8 G3-2 source-external 元数据写只读后端
enforcement**（updateSkill 拒 source-external description 写，闭环前端只读）· ⑲ **T6
fusion 审批复合 token CAS**（createFusion 持久 token，approve/reject 前 CAS，ABA 安全 +
零副作用 stale 拒绝 + legacy fail-closed）。

**已完备**：三具体 op（delete/reserve/version-write）+ replace 占位者路径 + 完整崩溃
恢复机制（driver + registry + boot）+ T13 ACL CAS 全链（后端+前端）+ T3/T4 保存协议
**端到端**（读回带 token → 前端单持有 → combined-save token OCC → 409 refetch）+
**§8 external authority 三态全链**（authorityKind wire → 前端 capability 三态 →
owner-transfer 阻断〔后端 403 + 前端隐藏〕→ source-external 元数据只读〔后端 403 +
前端 disabled〕）+ **T6 fusion 审批复合 token**（发起持久化 + approve/reject CAS，防
delete-recreate ABA / 并发编辑，approve+reject 双零副作用、legacy fail-closed）。

## 6. T4 保存协议端到端（已落，⑪⑫⑮）——契约锁定

- **T3 读**（118b7828）：readSkillContent 回带复合 token（base64url[skillId,
  contentVersion, metaRevision]）——detail read 单 fenced snapshot。
- **T4 后端**（08e8d080）：POST /api/skills/:name/save = decode+skillTokenMatches
  → 不匹配 ConflictError(409) → writeSkillContent → **re-read 回带新鲜 token**。
- **T4 前端**（c0948df0）：managed+token → 单 POST /save（token OCC，成功 setQueryData
  独占新 token、409 onError 失效 content query 拉新鲜 token）；external/无 token
  → 保留 RFC-169 双 PUT LWW 向后兼容。combinedSave.error 纳入 header errors 数组。
- **锁定测试**：skill-read-token · skill-combined-save（后端）· skills-detail-save-
  channels 新增 T4 describe（单 POST 带 expectedToken/零 PUT · 409 浮现+refetch）。

## 6b. §8 external authority 三态全链（已落，⑯⑰⑱）——契约锁定

- **wire**（a60b2b0d）：shared SkillSchema 加可选 `authorityKind`；backend
  `rowToSkill` 从存量 `authority_kind` 列上 wire（migration 0090 已回填全行）。
- **capability 三态**（a60b2b0d/1d24bc45）：`skill-capabilities.ts` signature 从
  sourceKind 改 authorityKind；`authorityKindOf` 兼容 pre-RFC-170 仅带 sourceKind 载荷；
  表 = managed{全可} / source-external{content✗ desc✗ del✓ transfer✗} / hand-external
  {content✗ desc✓ del✓ transfer✗}。
- **owner transfer 阻断 G3-2**（a60b2b0d 后端 + 1d24bc45 前端）：updateResourceAcl 对
  skill 且 nextOwner≠prevOwner 且 authority_kind≠managed → 事务内 ForbiddenError(403,
  skill-external-transfer-blocked)；前端 AclPanel 加可选 canTransferOwner 经
  DetailHeaderActions.acl 透传，external 隐藏转移控件。
- **source-external 元数据只读 G3-2**（871fc74a）：updateSkill 拒 source-external
  description 写（403, skill-source-external-metadata-readonly；reconcile 走 db.update
  直写不经此路径）；前端描述 input disabled。
- **锁定测试**：rfc170-skill-transfer-block（transfer 403+metadata 403，11 测试）·
  skill-capabilities（三态表 + authorityKindOf 兜底）· rfc099-acl-components
  （canTransferOwner=false 隐藏/默认显示）· skills-detail-save-channels（三态描述 gate）。

## 6c. T6 fusion 审批复合 token（已落，⑲）——契约锁定

- **skill.ts `getSkillPreconditionToken(db,name)`**（43ad7d7f）：DB-only 复合 token
  （复用 T3 codec，仅取 reservationState='ready' 行），fusion 用于 ABA/漂移检测。
- **createFusion**：insert 持久化 `preconditionToken`（发起时快照目标技能权威）。
- **approveFusion**：`setFusionStatus('applying')` **前** `assertFusionSkillUnchanged`
  ——token 漂移即 ConflictError 早退（**零副作用**、保留 awaiting_approval，不再转
  applying 后失败置 failed）；commitSkillVersion 的 `expectedVersion` OCC 保留为第二层。
- **rejectFusion**：创建 workDir/startTask **前**同款检查——漂移 re-run 会以当前 live
  重建 baseline 误导 diff（G5-P4），故前移拒绝（零副作用、iteration/task 不变）。
- **legacy fail-closed**：`preconditionToken=null`（升级前发起）approve/reject 均 409。
  **关键**：fusion 按 skillName 关联，token 的 skillId 分量防 delete→recreate ABA
  （baseSkillVersion 单维漏判）。
- **锁定测试**：fusion-engine 新增 T6 describe（持久 token · legacy null approve
  fail-closed · drifted reject 零副作用 · happy path 仍 approve+fuse）+ 更新旧 OCC 测试。

## 6d. Codex 对抗式审计修复轮（⑳，6 findings）——§8+T6 的真实漏洞修复

Codex adversarial-review 在已推送的 §8+T6 上抓到 6 个真漏洞（5 high + 1 med），全部修复：

- **F1（high）新 external import 落 authorityKind='managed'**（列默认）→ transfer 阻断/
  元数据只读/capability 全被绕过。修：`importExternalSkill` 写 `hand-external` +
  `authorityOwnerUserId=importer`；source reconcile insert 写 `source-external` +
  `authorityOwnerUserId=source.createdBy` + `originSourceId`。**真构造器**回归测试。
- **F2（high）updateSkill 名义 TOCTOU + 从不 bump metaRevision**→ 元数据 token OCC 失效。
  修：改 `dbTxSync` 内按 immutable id 复核 authority + `metaRevision+1` 同事务；空 patch
  no-op。测：元数据写后 token 漂移。
- **F3（high）createFusion 在 seed+startTask 之后才取 token**→ delete-recreate 窗口把旧
  提案配新 token。修：token 捕获前移到副作用之前。
- **F4（high）approve 非原子**（token/status/owner 分离校验 + 无条件 applying + 仅
  baseSkillVersion fence + 并发 failFusion 覆盖 done）。修：`claimFusionDecision` 原子
  CAS（status + token 同事务）+ commitSkillVersion 加 `expectedSkillId/expectedMetaRevision`
  **事务内**复合 fence + approve/reject **decision 时复核当前 skill 属主**（managed transfer
  不漂移 token）。
- **F5（high）reject 在 stale 检查后仍建 workDir/task**。修：原子 claim（status+token）
  前移到所有副作用之前、`currentTaskId=null` 让 reconcile 跳过、失败 failFusion。
- **F6（med）source-external Save 仍发 saveMeta（403）**。修：只 enqueue 可写通道、
  无可写通道时 Save disabled。测：source-external 零写请求 + Save 禁用。

**锁定测试**：rfc170-skill-transfer-block（真 importExternalSkill hand-external + transfer
403 + metaRevision 漂移）· fusion-engine（并发 approve/reject 序列化不双写/不覆盖 done +
属主复核 source lock）· skills-detail-save-channels（source-external 零写 + Save 禁用）。

## 6e. Codex 再审复核（㉑，fix 的 fix）——§8 判定「局部正确」，fusion 4 深层窗口

对 fix 提交（816db980）再跑一轮 adversarial-review：§8 authority 写入 / updateSkill
immutable-id CAS / 同步 claim / commitSkillVersion 事务内复合 fence / 前端通道 gate 均
判**局部正确**。fusion 决策协议另发现 4 个 high 窗口——**已修 2 个明确属本次改动的**：

- **F8（已修）属主复核与写入分离**：`claimFusionDecision` 加 `actor` 参、事务内读
  `skills.ownerUserId` 复核 `isAdminActor || ownerUserId===actor.id`——managed transfer 不
  漂移 token，故属主授权与状态转移**同事务**（pre-claim `requireCurrentSkillWritable` 保留
  为 fast-fail）。source lock。
- **F10-null（已修）**：createFusion 捕获 token 后、任何副作用前，`preconditionToken===null`
  → NotFoundError（技能已消失/未发布，永远无法判定的 fusion 不建 workDir/task）。source lock。

**F7/F9/F10-full——用户批准 inline 实现（㉒㉓㉔，全落）**：

- **F7（已修，㉒ a9a73980）reconcile/cancel/attach 全 writer generation-CAS**：新增
  `casFusionStatus(db,id,fromStatuses,to,{expectCurrentTaskId,extra})`——按 (status,
  currentTaskId) 条件更新（dbTxSync 原子）。reconcile 所有终态写键在读到的 taskId、cancel
  CAS from ['running','awaiting_approval']（排除 applying）、reject attach CAS on (running,
  currentTaskId=null) 输了回滚投机 task、approve done/fail CAS from ['applying']；删旧无条件
  setFusionStatus/failFusion。
- **F9（已修，㉓ 606d096b）决策 half-state 崩溃恢复**：`recoverFusionDecisions(db)`——
  'applying' 若有携本 fusionId 的 skill_versions 行则 roll forward done、否则 roll back
  failed；'running'+currentTaskId=null → failed。挂 start.ts 5b5（skill-op recovery 后、
  HTTP 前）。
- **F10-full（已修，㉔ 28011121）种子绑定不可变快照**：`fusionSeedDir(appHome,name,token)`——
  seed 取 token 指向的 `versions/v<contentVersion>/files`（不可变、无需锁）、legacy 回退 live；
  createFusion + reject 均用。测试：篡改 live 后 worktree 仍含快照 body。

**结论**：fusion 决策协议加固全落（F4/F5/F7/F8/F9/F10 + F10-null，用户批准 inline），
第三轮 re-review 待验。§8 三态 + T6 token 保护均净正向。

## 6f. 快照权威读地基（㉕ 10544aed）——用户 #2 首件

`skillReadRoot(skill, opts)`：managed 读当前版本不可变快照 `versions/v<contentVersion>/files`
（存在则）、legacy 无快照回退 live、external 读 externalPath 不变。`readSkillContent` 改走它
——torn/half-published live 不再污染读、body 恒与 token 的 contentVersion 一致。测试：篡改
live SKILL.md 后 readSkillContent 仍返回 v1 快照 body。**完整 G1-1（签 token/注入前 live
identity hash 校验 → drift 隔离）随 T-BOOT bootVerifiedSet/quarantine 落地**。

## 6h. T-BOOT 核心机制（已落，㉖㉗㉘）——用户 #2 主体

`services/skillBootVerify.ts` 三增量落地：

- **增量①（b9938652）地基**：`bootVerifiedSet`（内存、boot-epoch、仅 managed）+
  `isSkillAvailableThisBoot`（§invariant④/G8-2 单谓词，**未激活返 true→测试/pre-boot 零
  破坏**）+ `verifyManagedSnapshot`（re-hash 对 content_hash + SKILL.md 存在→通过入集/不符
  CAS quarantined）+ `runBootSnapshotReverify`（逐 managed 重验、snapshot-unverified 首采纳
  升 authoritative、无全量 barrier）。破环：hashDir/collectFiles/NUL 抽 leaf `skillHash.ts`。
  commitSkillVersion 置 version_state='snapshot-authoritative' + publish 后 markSkillBootVerified
  （刚写即本 boot 已验、post-boot create/edit 即时可用）。
- **增量②（3c4fcf98）gate + boot 接线**：getSkill/listSkills 过滤加谓词（未验/quarantined
  managed 隐藏）；start.ts 7b 开 HTTP 后后台跑 runBootSnapshotReverify（deferred、best-effort、
  无 barrier）。
- **增量③（e5af9466）T9 注入门**：`isSkillInjectableThisBoot({id,sourceKind})`（leaf 可调）+
  `SkillQuarantinedError`（409、不可吞）；scheduler `resolveSkills` managed 分支拒未验/
  quarantined（**pre-spawn 解析层终检**）——绕过 getSkill 直查表的注入路径补齐。

测试：skill-boot-verify（新建即 authoritative+verified · gate 默认 inactive · 激活后
getSkill/list 隐藏 quarantined · 篡改 hash→quarantined · reverify 验好隔坏 · isSkillInjectable
分流 + resolver source lock）。binary smoke 无模块环。

**增量④（eea7d35b）readSkillFile/listSkillFiles 也走 skillReadRoot**（文件浏览树 + 单文件
读快照权威；写仍 live→commit）。**增量⑤（ecdb0813）T4a legacy backfill**：ensureInitialSkillVersion
lazy v1 除写快照外置 version_state='snapshot-authoritative'+markVerified；start.ts 7b 在
reverify 前逐 legacy-unbackfilled managed 跑之——防升级后 legacy skill 被 gate 隐藏。

## 6i. T-BSAFE③ 保存协议单漏斗收口（已落，㉙）——旧 PUT→410 + external combined-save

设计 §2/G3-3/G3-2 定案：**combined-save（`POST /skills/:name/save`）是全部 skill 的唯一保存
漏斗**，旧 metadata `PUT /skills/:name` 与旧 content `PUT /skills/:name/content`（无 token、绕
版本 funnel/OCC）**双双 410 Gone**。

- **后端**：`GoneError`（`util/errors.ts`、410、复用 `errorHandler` 的 `DomainError.status`）；
  两路由改 `throw new GoneError('skill-endpoint-gone', ...)`（仍注册→410 非 404，契约 registry
  不变）；`routes/skills.ts` 移除 now-unused `updateSkill`/`writeSkillContent`/`UpdateSkillSchema`/
  `UpdateSkillContentSchema` import（max-warnings 0）。
- **saveSkillWithToken external 分支**：token 校验（skillId+contentVersion+metaRevision、ABA
  防御）后按 `sourceKind==='external'` 分流——**bodyMd patch → 409 `skill-external-readonly`**
  （external 正文盘上权威、只读）；**description → `updateSkill`**（hand-external 写 DB / source-external
  经 in-tx authority CAS 403）。`ensureSkillIsWritable` 前移进 managed 分支。
- **updateSkill 原子 fence**：新增可选 `expectedSkillId`+`expectedMetaRevision`，在**同事务**内
  re-check `cur.metaRevision` + 绑定不可变 skillId——补上 saveSkillWithToken 外层 token 校验与
  updateSkill 写之间的 TOCTOU 窗（并发 description 编辑不再 LWW 覆盖；delete→recreate 同名不再
  改到新 skill）。

**Codex 对抗审计修复轮（㉙-fix，NO-SHIP→3 findings）**：

- **F1（high，已修）最终写未在事务内复核完整 token**：`saveSkillWithToken` 外层 `skillTokenMatches`
  只是**预检**，与最终写之间隔 `await`（Bun 单线程仍在 await 点让出）——并发保存/delete-recreate
  可在窗口内漂移、被 LWW 覆盖或 ABA 改到别的 skill。**关键**：`commitSkillVersion` 早已具备 in-tx
  复合 fence（F4：expectedSkillId+expectedVersion+expectedMetaRevision，与版本 bump 同事务），只是
  combined-save 路径**没喂值**。修：`writeSkillContent` 加可选 `expected` 参数透传三字段；managed
  分支喂 `decoded` token；external 分支给 `updateSkill` 传 `expectedSkillId`。锁：skill-combined-save
  新增 managed 陈旧 contentVersion→409 / delete-recreate 陈旧 skillId→409 / external expectedSkillId
  失配→409 三条（直接命中 in-tx fence）。
- **F2（high，已修）前端 token 未绑定同一草稿快照**：description 来自独立 metadata GET、token 来自
  content GET，拼接保存可让陈旧 description 骑新 token 静默回滚并发编辑。修（设计 §2「双查询播种
  退役」+ §267 SKILL.md description 权威）：`useDraftFromQuery` base 从 `meta.data` 改 `content.data`，
  description+body 双双 seed 自**同一 fenced content 读**（`SkillContent.description` 即 SKILL.md
  frontmatter 权威、与 token 同响应）。锁：save-channels 新增「meta 陈旧 description 不随 token 上
  wire、保存送 content 权威 description」回归。
- **F3（medium，未修，转下方大单元）+ F2b（409 dirty-draft 冲突重载 UX）**：file `PUT/DELETE
/:name/file` / restore / ZIP overwrite 仍是无 token 的版本写入口（`SkillFileTree` 直调）——属设计
  §2「OCC 扩到全部六条版本写」+ G2-7「前端每 skill canonical token store」，与 F2b 的冲突显式
  reload 流程**耦合成一个更大的前端+多写面单元**，独立立项。

**Codex 再审复核（㉙-fix-2，NO-SHIP→F1/F2 各留一深层，已修；未重报 F3/F2b）**：

- **F1b（high，已修）no-op 旁路**：`commitSkillVersion` 的「同内容 editor Save 不进历史」短路在
  复合 fence **之前**返回（`skillVersion.ts:345-352`）——await 窗口内 delete-recreate 且新资源正文
  字节相同时命中 no-op，完全不比 stale skillId，把替代资源 row/token 回给旧请求。修：抽 `assertCompositePrecondition(tx,name,commit)` 单一 helper，**no-op 返回前**与 db-committed tx **两处**都调。锁：
  skill-combined-save 新增「同内容 + 陈旧 skillId → 409（no-op 也被 fence）」（前一条 ABA 测试写变更
  内容、跳过 no-op，故漏检）。
- **F2b-desc（high，已修）hand-external DB description 被回滚**：F2 统一从 `content.description` 播种，
  但 hand-external 权威是 **DB `skills.description`**（磁盘 SKILL.md 是外部、非我方可写），而
  `readSkillContent` 一直回磁盘 frontmatter——DB-only 改 description 后读回磁盘旧值、Save 携新 token
  写回 DB 即静默丢失。修：`readSkillContent` 按 authority 取 description——managed/source-external 用
  frontmatter，hand-external（`authorityKind==='hand-external'`，legacy 由 external+无 sourceId 派生）
  用 `skill.description`（DB）。锁：hand-external「磁盘≠DB 时读回 DB」+「description save 不被后续读
  回滚」两条。

**Codex 三审（㉙-fix-3，APPROVE F1b + F2b 分流正确 → 再抓一条 read 内非原子）**：

- **F2b-read（high，已修）readSkillContent description 与 token metaRevision 非同代**：`skill.description`
  经 `getSkill` 取、`metaRevision` 另一次可让出的查询取——中间并发 description 保存提交则响应＝旧
  description + 新 token，客户端下次保存过 OCC 静默覆盖回旧值（F2 同类、落在后端读）。且 `metaRow`
  缺失回退 `?? 0` 会造一个指向已消失代的假 token。修：description+metaRevision **同一行快照一次查**
  （按不可变 id）、行消失即 409（不回退 0）；hand-external description 取自该同一快照。锁：hand-external
  「description 与 token metaRevision 同代推进」（解 token 断言 metaRevision +1 与 description 同步）。

**Codex 四审（㉙-fix-4，F2b-read APPROVE-closed → 两条转独立单元/被 RFC-178 覆盖）**：本轮确认
F2b-read 闭合（description+metaRevision 同一 id-快照、行消失 409）。余两条**不在 T-BSAFE③（410+
combined-save funnel）边界内**，均未在本增量修：

- **[high] 最终 OCC 事务未重校 owner（skillVersion.ts commitSkillVersion）**：路由层 `requireResourceOwner`
  预检后、写事务内只重读 id/contentVersion/metaRevision，不重读 owner——请求等待期 owner transfer
  后旧 owner 恢复仍过 fence、成撤权后写。**属跨全六写入口（file/restore/ZIP/fusion/combined-save）
  的 in-tx ACL 原子性**（设计 §318「所有 mutation 最终事务加检」已列），且**非本增量引入**（T4
  combined-save 与所有 writer 都沿用路由级 ACL）。**funnel 侧机制已落（㉚，`skillVersion.ts` 独立
  commit）**：`SkillVersionCommitOpts` 加 `expectedOwnerUserId`（授权时的 owner），`assertCompositePrecondition`
  于版本 bump 同事务重读 `skills.ownerUserId`、drift（transfer）即 409（no-op 短路也走同一 helper 故一并
  fenced）；owner-drift 语义对 admin 保守（owner 变即 409 reload，安全）。因 `skillVersion.ts` 不在
  RFC-178 触及面、且此改仅动该文件 + 新测试文件，**与协作者 RFC-178 零冲突**。**六写入口喂
  `expectedOwnerUserId` 的接线仍延后**（saveSkillWithToken/file/ZIP 在被 RFC-178 重写的 `skill.ts`，
  restore/fusion 在 clean 文件但先随 funnel 机制落）→ 待 RFC-178 落地后接线，机制先就位（同 F4 fence
  先落后喂的模式）。
- **[medium] external combined-save 静默丢 frontmatterExtra（skill.ts external 分支）**：external 分支只
  拒 bodyMd、忽略 frontmatterExtra，hand-external 的 extra-only 请求 200 却零落盘。**真实但落在并行
  RFC-178（移除外部/父目录 skill，当前 Draft + 协作者未提代码）的删除路径**——修「external 拒 extra」
  与 RFC-178「删 external」同函数同段直接冲突，按多人协作「冲突优先调和」**不单方面改**；随 RFC-178
  落地时 external 分支整体移除即自然消解（若 RFC-178 撤销保留 external，则补「external 拒 extra 或
  独立 description-only 契约」）。

- **前端**：`skills.detail.tsx` 删 saveMeta/saveContent 双 PUT mutation，handleSave 统一走
  combinedSave（managed 送 {description,bodyMd}；hand-external 送 {description}；source-external
  无可写→no-op）；ErrorBanner 收敛到 `[combinedSave.error, del.error]`；`skill-md-protected`
  文案改指 `POST /save`。
- **测试锁迁移**（设计 §2「测试锁同步退役」）：skills.test.ts（PUT /content→410 + combined-save
  写回 + PUT /:name→410 + external body 拒/desc 收）；skill-combined-save.test.ts（+external：
  desc-only 成功推进 token · bodyMd 拒 · stale token 409 OCC）；前端 skills-detail-save-channels
  （双 PUT 契约整体迁到单漏斗，保留 DetailHeaderActions errors 数组 + navigate-once 意图）·
  edit-routes-navigate-on-save（源级锁迁到 combinedSave 单 mutation）· skills-split-page（mock
  加 token + POST /save handler）。全绿：typecheck/lint/format/binary-smoke/前端全套 + 后端定向。

## 7. 其余（依赖顺序）

**T-BOOT 收尾（核心 §6h 已落，含 detail/list/runtime gate + 快照读 readSkillContent/File/
listFiles + T4a legacy backfill + reverify + T9 注入门）**，余为增强：token-writer gate
（getSkillPreconditionTokenById 也查 injectable——现 createFusion/readSkillContent 经已 gate
的 getSkill 已隐式覆盖）· fusion-base 读走 skillReadRoot · 每 sign/inject 级 live drift 校验
（boot 级重验已落，per-op 为增强，且 readSkillContent 已读快照使 live drift 基本不适用）·
大树验证公平调度（小 skill 先、软 wall）·

**批次 B/C 剩余（大/耦合/需 UI 的独立单元）**：**canonical token store + 全六写 OCC**（§2/G2-7

- ㉙-fix F3/F2b：file `PUT/DELETE /:name/file` / restore / ZIP overwrite 加复合 token OCC + 前端
  每 skill 单一 canonical token store〔SkillFileTree/restore/save 共享、逐次原子更新〕+ 409 冲突显式
  reload 流程）· **version-write in-tx ACL 重校**（㉙-fix-4 [high]：设计 §318——**funnel 侧 owner-drift
  机制已落 ㉚ + combined-save 主路径接线已落 ㉛ + file PUT/DELETE·restore 接线已落 ㉜〔各 route 传
  existing.ownerUserId〕。**fusion approve 已由 `claimFusionDecision` 原子 owner CAS 自保护（F8），无需
  commitSkillVersion owner-fence**；`createManagedSkill`=create 无 owner-transfer 竞态；**仅 ZIP overwrite
  一路待接（罕见、skill-zip.ts 不直调 commitSkillVersion，待其写路径明确后补）**）· T9b external descriptor-relative 捕获（需
  openat/O_NOFOLLOW，Bun/Node 不足则 native helper 或 fail-closed）· migrate（T10）· adopt-managed
  （T10b，两阶段 capture→confirm）· 批次 C（source lifecycle reconcile 拆 user/system、migration
  决策 UI、adoption UI）· F12 统一 task-cancel 原语 + clarify 子状态清理（task 层、部分既存）。
  **注\*\*：旧 PUT/:name+PUT/content→410 + external combined-save 已落（T-BSAFE③，§6i）；external
  file/tree GET realpath containment 已由 `realpathInside` 落地（T-BSAFE④）；T6 fusion 审批 token

* F7–F12 加固已落（§6c/§6e）；快照权威读全读路径已落（§6f/§6h）。
