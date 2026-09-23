# RFC-369 node_run 旧代作废改由读侧推导（根治同任务并发铸 run 的 PG 序列化冲突）

**状态**：**Draft（2026-09-23）**——待设计门与用户批准
**来源**：`docs/audit-backlog.md`「PostgreSQL 的 40001 仍会逃逸到调用方：`rfc359-w4-d19c` /
`rfc185-leader-fanout` 工作组回合在 CI 上间歇红」条目（2026-09-15 首撞，2026-09-23 钉到语句级）
**母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md)（落在 task-execution context）

---

## 1. 背景

每铸一条 `node_runs`（新一代执行），`nodeRunMintParticipant.ts:86-125` 都在**同一个事务里**先
范围读「同一帧的旧代」，再把旧代及其子 run 的 `merge_state` 从 `isolating / pending-merge /
conflict-human` 改成 `abandoned`，然后才 insert。这是 RFC-144 为修「过期 delta 被重放进主树」
而引入的「铸行即取代」。

PostgreSQL 上这一步在 SERIALIZABLE 事务里执行。那次范围读走 `idx_node_runs_task`，PG 的 SSI 谓词锁
按**索引页**加，同一任务的不同节点的行落在同一批页上——于是**同一任务里任意两次并发铸 run 几乎必然
互判读写依赖**，其一被中止重放：

- 本地实验（2026-09-23，`log_statement=all`）：工作组领队与成员回合并发铸 run，每次运行撞 1–2 次；
  **把那次范围读去掉，5 次运行的冲突从 8 次降到 0 次**。
- CI 更慢（带 coverage），窗口里连撞 10 次以上，把平台的 10 次重放全部用光，错误抛给调用方：
  工作组回合报「internal error」、这一轮作废重来。`rfc359-w4-d19c` 与 `rfc185-leader-fanout:901`
  两条用例因此在 CI 上间歇红（非本地可复现）。
- 这不是工作组特有的：扇出节点、wrapper 分片、并发成员等**所有同任务并发铸造**都走同一段代码。

连带暴露出第二个缺陷：**工作组一轮内部报错重来时，重试预算被重置**。`executeHostTurn`
（`workgroupTurnsDriver.ts:521`）的协议预算与瞬态故障预算都是内存计数；一轮因内部错误作废后，驱动把
仍是 pending 的 run 当崩溃恢复重新接管，拿到一份全新的预算。CI 上那次：抛错前 2 次 + 重来后 4 次 =
6 次调用，超出「重试有上限」（期望 4 次）。只要内部错误反复出现，重试次数就没有上限。

## 2. 目标

- **G1** 铸 run 的事务里不再有同帧范围读：同任务的并发铸造不再因 SSI 页级谓词锁互相中止（嵌套帧里
  按主键点读容器行的那一步保留，工作组宿主 run 不涉及，设计门 r2 P3-6）。
- **G2** 「旧代作废」的全部既有保证**逐条保留**（RFC-144 修掉的那条缺陷不得回来）：
  - 入口重放（`replayPendingMerges` / `replayConflictHumanResolutions`）不重放被取代的旧代；
  - 仍在运行的旧代不能再把过期 delta 合并进主树（今天靠 `abandoned` 终态让状态机迁移非法）。
- **G3** 工作组一轮在 host 执行过程中遇到**内部错误**（铸 run / 账本提交等抛错）时，**按这一轮失败
  收场**（与 host 失败、重试耗尽同一出口），不再被驱动当作崩溃恢复自动重来——重来会拿到一份全新的
  内存预算，使「重试有上限」失效（用户 2026-09-23 裁决；备选「账本血缘计数」因需定义跨重来的回合
  身份、改动面大而未采纳）。**完整版**（用户 2026-09-23 裁决，设计门 r2 之后）：已铸出却没执行完的孤儿
  run 同一笔提交终结为 failed、不再被采纳；开跑提交未落库时按卡片实际状态落 failed；领队补房间消息。
  G3 **不能**让两条间歇红用例变绿（残余冲突下它们会以新形态红），AC-6 完全依赖 G1。
- **G4** 调度器接管 pending 行时跳过同帧已被取代的较老行、新铸一行，避免收紧后必定白跑的一轮
  （用户 2026-09-23 裁决）。

## 3. 非目标

- 不改 PG 序列化重放的次数与退避（`postgresqlSerializationRetry.ts`）。
- 不改工作组回合的并发形态（领队 / 成员仍并发）。
- 不改 frontier、wrapper 复活、回滚选择器——它们本来只看每帧最新一行（盘点见 design §2）。
- 不改 `abandoned` 的其余 4 个写入点（discard-writes、工作组合并冲突、fanout 分片 / 聚合冲突），
  它们走状态机 CAS，与铸造无关。
- 按用户 2026-08-26 明令，只做功能正确性。

## 4. 用户可见变化

1. **（收紧，用户 2026-09-23 裁决接受）同帧已有更新一代时，旧代的产物一律不合并。** 今天只在新一代
   铸出**那一刻**、对**当时**处于 `isolating / pending-merge / conflict-human` 的旧代生效；当时
   `merge_state` 还是 NULL（或 merged 之外的其他值）的旧代之后仍可进入隔离并合并。改为读侧推导后，
   只要同帧存在更新一代，旧代走到 `mark-pending-merge` 就被拦下、它这一次的活作废。可能走到的情形：
   - 调度器接管同帧**较老**的 pending 行（`resolveSchedulerRunRow.ts:86` 取第一个 pending），而同帧
     已有更新的 retry 占位行（`taskRouteOperations.ts:2300`，status=failed）；
   - ULID 不严格单调：先 `ulid()` 后提交的行（如工作组 `workgroupTurnsDriver.ts:545`）可能 id 更小、
     提交更晚——今天不会被取代，推导后立即被视为旧代；
   - 存量库里未被 0076 / 铸造 abandon 的遗留行，在入口重放时按新判据被排除。
   语义上这是更安全的方向（新一代存在即以新一代为准），但属于行为收紧，逐条加测试锁定。第一种情形由
   G4 直接规避（调度器不再采纳这类行）；其余情形的后果是「这一次执行跑完后在合并前被拦、节点失败，
   下次恢复重新铸行」，AC-7 断言端到端能跑通、不卡死。
2. **工作组一轮遇到内部错误时，按这一轮失败收场**（G3）：房间里出现与 host 失败同形的系统消息，
   成员卡片 / 消息轮按既有失败出口处理（开跑前出错时按卡片实际状态落 failed），已铸出的孤儿 run 被
   终结为 failed，不再自动重来；领队内部错误时房间里补一条内部错误消息、任务失败（与今天结局相同）。
   G1 修掉冲突源后，这类内部错误应极少出现。
3. `merge_state` 本就不出 API / 前端（`shared/src/lifecycle.ts:494-497`）。库里的差别：被取代的旧代
   不再在铸造那一刻变成 `abandoned`，而是在下一次被迁移尝试或入口重放读到时才收成 `abandoned`。

## 5. 用户故事

- 作为工作组任务的发起人，我希望领队和多个成员并发工作时不会因为数据库内部冲突报「internal error」、
  白白多跑 agent。
- 作为维护者，我希望 CI 上不再出现这类只在 PG、只在慢机器上出现的间歇红。

## 6. 验收标准

- **AC-1**：`nodeRunMintParticipant` 的铸造事务里不再有对 `node_runs` 的同帧范围读与 abandon 写
  （源码锁 + 行为锁）。
- **AC-2**：本地 PG 上复跑 `rfc185-leader-fanout:901` 的场景 20 次，服务端记录的序列化冲突为 0
  （对照：改前 5 次运行 8 次）；CI 的 PG 臂在该用例里统计序列化重放次数并断言为 0。
- **AC-3**：RFC-144 的行为锁全部仍然成立，改为「按推导判定」后重写而**判据不放宽**：
  - 旧代停在 `pending-merge` / `conflict-human`，新一代已铸出 ⇒ 入口重放不重放它、canonical 不出现
    它的产物（`rfc144-stale-replay-regression` 场景 A/B/C）；
  - 被取代的旧代（及其子 run），只要当前 `merge_state` 处于 `isolating / pending-merge /
    conflict-human`，再发任何非 `abandon` 迁移（`begin-isolation` 自环、`mark-pending-merge`、
    `mark-merged`、`park-conflict-human`…）⇒ 非法迁移，合并不会发生；`merge_state` 为 NULL 的旧代
    的 `NULL → isolating` 放行，在随后的 `mark-pending-merge` 处被拦（碰 canonical 之前）；
  - 子 run 随父：父行被取代即子行被取代，**与父行自身的 merge_state 无关**（扇出 wrapper 父行常为
    NULL / merged）；
  - 按 shard 收口：`shard=B` 的新一代只取代 shard B 的旧代，兄弟 shard 不受波及；null shard 的新一代
    取代该节点全部旧代（`rfc172-dispatch-shard` 的两条）；
  - 不同 nodeId / iteration / 帧（container）互不波及。
- **AC-4**：被推导为已取代的行，在被迁移尝试或入口重放读到时收成 `abandoned` 并**确实落库**
  （迁移路径的非法迁移在事务提交之后才抛出），且该收尾不影响调用方结果。
- **AC-5**：工作组一轮在 host 执行中遇到内部错误（注入点：首次开跑提交失败〔卡为 dispatched / open /
  awaiting_human〕、重试铸 run 事务失败、铸造成功后执行前抛错、`runHost` 在 assembly 前抛错），这一轮
  按失败收场、出现失败系统消息、孤儿 run 被终结且不再执行；成员总调用次数 ≤ 按卡尝试预算计的上限
  （free_collab 下失败卡按既有规则重开属卡自身预算，双引擎确定性用例）。
- **AC-8**：调度器遇到同帧已被取代的较老 pending 行时不采纳它、把它终结为 canceled、新铸一行，任务
  最终跑通；最新 pending 行、兄弟 shard、另一帧、既有「铸 pending 再调度」路径的采纳行为不变。
- **AC-7**：§4 第 1 条的三种收紧情形各有一条测试锁定期望行为。
- **AC-6**：两条原本间歇红的用例（`rfc359-w4-d19c` 成员瞬态重试耗尽、`rfc185-leader-fanout:901`）
  在 CI 上连续绿；`docs/audit-backlog.md` 对应条目改为已修。

## 7. 能力影响清单

- **旧代在新一代铸出之后才进入隔离、仍可合并**——收紧为不可合并（§4 第 1 条，用户 2026-09-23 逐项确认）。
- **工作组一轮内部错误后自动重来**——改为按这一轮失败收场（§4 第 2 条，用户 2026-09-23 确认）。
- **调度器采纳同帧较老的 pending 行**——已被取代的不再采纳，改为新铸（G4，用户 2026-09-23 确认）。
- 其余均为实现方式变化，外部行为不变。
