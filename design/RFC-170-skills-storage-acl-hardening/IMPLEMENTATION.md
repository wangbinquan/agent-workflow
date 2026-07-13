# RFC-170 批次 B 实现指引（IMPLEMENTATION）

> 本文把「设计门收敛的 design.md/plan.md」翻译成**可执行的接线计划**：已落地的四层
> 底座 API、每个具体 op 改写哪个现有函数 / 与谁纠缠 / recovery 形态、以及推荐执行
> 顺序。承接 2026-07-13 会话（设计门 10 轮收敛 + 用户批准实现 + 底座四层 CI 绿）。

## 0. 已落地的底座四层（32 测试、CI 绿 `97428109`）

| 模块 | 关键导出 | 用途 |
|---|---|---|
| `db/migrations/0090` + `db/schema.ts` | skills 8 列 / skill_sources 3 列 / fusions token / 六表 acl_revision / `skill_operations` / `skill_operation_locks` | schema 地基（dormant） |
| `services/skillOperations.ts` | `beginOperation(tx,spec)→opId` · `advancePhase(tx,opId,phase,patch?)` · `finishOperation(tx,opId)` · `abandonOperation(tx,opId)` · `acquireOpLocks/releaseOpLocks` · `getActiveOp/listActiveOps` · `gcOrphanLocks` · types `SkillOpKind`/`SkillOpPhase`/`BeginOperationSpec` | §6a 状态机 primitive（全部接 `DbTxSync` 组合） |
| `services/skillFsPublish.ts` | `opStagedDir/opBackupDir/opCandidateDir/opScopedDir` · `swapInStaged(filesDir,opId)→{hadPrevious}` · `restoreFromBackup(filesDir,opId)` · `cleanupOpDirs(filesDir,opId)` | §6a/§13 op-scoped 原子 publish（纯 FS leaf） |
| `services/skillOpRecovery.ts` | `SKILL_OP_PHASE_SEQUENCES` · `recoveryDirection(kind,phase)→'noop'\|'rollback'\|'rollforward'\|'quarantine'` | §6a 恢复完备性纯 oracle |

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

| kind | 改写/新增 | 现有入口 | 纠缠 | rollback | rollForward |
|---|---|---|---|---|---|
| **version-write**（T7 核心） | 重写 `commitSkillVersion`（`skillVersion.ts:273`，现「先删后拷」非原子） | file PUT/DELETE·restore·ZIP·fusion·combined-save 六 writer 全走它 | **reserve 依赖它建 v1**；先做 | 删 staged + `versions/.op-<id>.staged`/已现的 `versions/v<target>`（DB 未 bump 故无引用）；撤 lease+锁 | 从 `versions/v<target>` 或 staged 重建 `files`（swapInStaged）；置 done | 
| **reserve**（T6b） | 改 `createManagedSkill`（`skill.ts:86`）+ ZIP create（`skill-zip.ts`） | POST /skills、ZIP import | 依赖 version-write 建 v1 | 删 reserving skills 行 + staged + 撤锁 | 补 `reservation_state='ready'` + done | 
| **delete**（T-BSAFE①） | 改资源 DELETE（`skill.ts` deleteSkill） | DELETE /skills/:name | backup=`.trash/<skillId>-<opId>`（非 op-scoped-adjacent，recovery 用 `op.backupPath`） | rename trash→skills root、撤锁 | 清 trash、done | 
| **replace**（T-BSAFE②） | 改 `replaceSourceConflict`（`skill-source.ts:335`） | 冲突 replace 决策 | 三子机（managed/source-ext/hand-ext occupier）；managed occupier 备份**整个 root** | rename backup→root（含 versions/）、撤双锁 | 清 backup、done | 
| **migrate**（T10） | 新增（legacy 分叉首采纳，现无此路径） | 迁移决策 UI | backup=`K`（inode-bearing，**不删**，登记为下代 generation，G7-1） | rename K→files 复原原始 live | 确保 C、登记 K 为候选、清 D、done | 
| **adopt-managed**（T10b） | 新增两阶段 capture→confirm→commit（现无 adoption） | degraded external adoption | 阶段 A capture 用 §7b descriptor-relative no-follow；INSERT skill_versions(v1) | 删 candidate/versions/v1、撤锁（external 仍 degraded） | 确保 v1/canonical、done | 

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

## 7. 其余（依赖顺序，批次 B 收尾 + 批次 C）
snapshot 权威读（readSkillContent 从 versions/v<cur> 非 live——**与 T-BOOT quarantine/
drift-check 耦合**，非独立单元）· T9 quarantine 注入门（stageSkills 前查 version_state，
**注意 scheduler 协作者 WIP**）· T9b external descriptor-relative 捕获（需 openat/
O_NOFOLLOW，Bun/Node 不足则 native helper 或 fail-closed）· 旧 PUT/:name+PUT/content
→410（T-BSAFE③，**与 external combined-save 后端支持耦合**）· T-BOOT
`isSkillAvailableThisBoot` predicate + bootVerifiedSet + 后台重验 · migrate（T10）·
adopt-managed（T10b，两阶段 capture→confirm）· 批次 C（source lifecycle reconcile 拆
user/system、migration 决策 UI、adoption UI）。**注**：external file/tree GET realpath
containment 已由 `realpathInside`（readSkillContent/readSkillFile）落地（T-BSAFE④）；
T6 fusion 审批 token 已落（§6c）。
