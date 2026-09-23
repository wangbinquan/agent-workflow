# RFC-369 任务分解

**状态**：**In Progress（2026-09-23 用户批准实施）**——刀 1（T1–T5、T8）已落，刀 2（T6）待做
**读法**：先 [proposal.md](./proposal.md) 再 [design.md](./design.md)。

---

## 1. 子任务

| # | 任务 | 产出 | 依赖 |
| --- | --- | --- | --- |
| **T1** | 取代判据 | `task-execution/domain/nodeRunSupersession.ts`（纯函数）+ `infrastructure/nodeRunSupersession.ts`（SQL 谓词）+ 单测与双引擎对拍 | — |
| **T2** | merge 状态机围栏 | `mergeStateLifecyclePersistence.transition` / `tryTransition` 迁移前判取代 ⇒ 收成 abandoned 并按终态计算（design §4.2） | T1 |
| **T3** | 入口重放排除已取代 | `nodeExecution.list` 加 `excludeSuperseded`；两段重放带上并收尾 abandoned（design §4.3） | T1 |
| **T4** | 铸造去掉范围读与 abandon | `nodeRunMintParticipant` 与 W47 阶段序列收缩；`ABANDONABLE_MERGE_STATES` 死值 `conflict-agent` 删除 | T2, T3 |
| **T5** | RFC-144 / 172 / 326 / 349 / 359 相关测试按新语义改写（判据不放宽）+ 冲突回归锁 | 见 design §6 | T4 |
| **T6** | 工作组内部错误即判失败（完整版） | `executeHostTurn` 抛错转 `failed`（带 `started` / `orphanRunIds`）；TE 宿主账本新增 `fail-host-run`；调用方按卡实际状态落 failed；领队补消息（design §4.4）+ AC-5 全部注入点用例 | — |
| **T8** | 调度器跳过已被取代的 pending 行 | `resolveSchedulerRunRow` 用 §3 纯函数过滤（design §4.5）+ AC-8 用例 | T1 |
| **T7** | 收口 | 架构普查重采；`docs/audit-backlog.md` 条目改已修；`design/plan.md` 索引与 `STATE.md` | T1–T6 |

## 2. PR 拆分

单 RFC 两刀，每刀 CI 绿：
- **刀 1（T1–T5）**：取代改为读侧推导。**T2/T3/T4 同一个 commit**——否则共享 main 上会有一段时间既不在
  铸造时 abandon、读侧也不判，RFC-144 的缺陷回来。
- T8 随刀 1（依赖 T1 的纯函数）。
- **刀 2（T6）**：工作组内部错误即判失败。与刀 1 独立。
- 然后 T7 与实现门。

## 3. 验收清单

- [x] AC-1 铸造事务里无 node_runs 范围读 / abandon 写（源码锁 + 行为锁）
- [ ] AC-2 本地 PG 复跑冲突为 0
- [x] AC-3 RFC-144 / 172 行为锁改写后全绿、判据不放宽（变异验证）
- [x] AC-4 读到即收尾 abandoned
- [ ] AC-5 三个注入点：内部错误按这一轮失败收场、不自动重来（双引擎）
- [x] AC-7 收紧三情形各一条测试
- [x] AC-8 调度器跳过已被取代的 pending 行
- [ ] AC-6 两条间歇红用例 CI 连续绿、backlog 条目改已修

## 附录：盘点来源

design §2 的逐条 file:line 来自 2026-09-23 的只读盘点（本 session），要点：
入口重放 `executionMergeRecovery.ts:59-143, 154-214`；状态机 `shared/src/lifecycle.ts:504-700`；
live CAS `isolatedAgentRun.ts:157-192, 237-258, 376-395, 473-484`；只看最新行的读者
`dagFrontier.ts:133-172, 414-450`、`wrapperMechanics.ts:545-632, 1609-1655`、`gitStrategy.ts:54-58`；
其余 abandon 写点 `nodeMechanics.ts:691-699, 738-745`、`wrapperMechanics.ts:936-941, 1429-1434`；
锁铸造语义的测试 `rfc144-merge-state-cas.test.ts:335-420`、`rfc144-stale-replay-regression.test.ts:206, 253-313, 726, 744`、
`rfc172-dispatch-shard.test.ts:699-747`、`rfc326-tx-primitives-equivalence.test.ts:256`、
`rfc349-task-transaction-participants.test.ts:158`、`rfc359-t1-task-execution-atoms.test.ts:146`、
`rfc359-w47-node-run-mint-program.test.ts:17, 363-427`、`rfc144-merge-state-blind-write-inventory.test.ts:36-140`。

## 设计门 r1（2026-09-23，Claude 子代理，只审功能）

**FAIL** → 3 P1 / 5 P2 / 若干 P3，处置：

| finding | 处置 |
| --- | --- |
| P1-1/P1-2/P1-3 账本计数跨回合累计、少算一格、内部错误重入路径未定 | **用户裁决改方向**：G3 改为「内部错误即判这一轮失败」（design §4.4），不再按账本计数；原 T6 的 `failureCode` 字段与 harness 回写一并取消 |
| P2-1 事务内先写 abandoned 再抛会被回滚 | design §4.2：事务内返回「已取代」、提交后在事务外抛；复用同一处 `.update` |
| P2-2 推导比今天更严 | **用户裁决接受收紧**：proposal §4 第 1 条逐条列出三种情形 + AC-7 |
| P2-3 子行判据的父行状态歧义 | design §3(b)：只看父行结构，与父行 merge_state 无关；测试补一格 |
| P2-4 多出的 `S.parent IS NULL` | 删去，保持与铸造字面等价 |
| P2-5 缺关键用例 | design §6 补齐（收紧三情形、abandoned 落库、父行状态无关、三个注入点、子行闭包变异） |
| P3 事务隔离级别写错、AC-3 与 §4.2 矛盾、failure_code 写入点 | 更正 §4.2 表述；AC-3 改写（NULL → isolating 放行，在 mark-pending-merge 拦）；failure_code 依据随 G3 改方向不再需要 |

## 设计门 r2（2026-09-23，Claude 子代理，只审功能）

**FAIL** → 2 P1（均在 G3）/ 5 P2 / 8 P3。§3/§4.2/§4.3 基本成立。处置：

| finding | 处置 |
| --- | --- |
| P1-1 开跑提交回滚后失败出口 `from:'running'` CAS 不中，照旧自动重来 | **用户裁决完整做 G3**：失败结果带 `started`；未开跑时按卡实际状态落 failed（open 卡两步）——design §4.4 第 3 条 |
| P1-2 孤儿 pending run 被再次采纳，host 再跑 | 新增宿主账本操作 `fail-host-run`，同一笔提交终结孤儿 run（复用 `setNodeRunStatusTx`，不新增直写）——§4.4 第 2 条；AC-5 加「同一 / 下一 drive 不再采纳」 |
| P2-1 AC-5 第 3 注入点无实现点 | 注入点改为「铸造成功后执行前抛错」「runHost 在 assembly 前抛错」；写明 runHost 返回后只剩纯函数，不会误判 |
| P2-2 领队少了房间消息 | §4.4 第 4 条补 `internalDriveError` 消息 |
| P2-3 收成 abandoned 时带上 extra 会覆写 iso 列 | §4.2 只写 mergeState；加断言 |
| P2-4 收紧情形 1 是白跑一轮 + 节点失败 | **用户裁决**：新增 G4 / §4.5 调度器跳过已被取代的 pending 行；AC-7 改断言端到端跑通 |
| P2-5 缺用例、G3 修不绿两条间歇红 | §6 / AC-5 补齐；写明 AC-6 完全依赖 G1，AC-2 样本量 20 次 + CI 统计 |
| P3 | (b) 只下探一层；EXISTS 只用在 SELECT；`transition` 断言非复用帧；G1 措辞收窄（容器主键点读保留）；runId 铸造后立刻记下；转换范围含 runHost 在 assembly 前的抛错 |

## 设计门 r3（2026-09-23，Claude 子代理，只审功能；只审 §4.4 / §4.5）

**PASS-WITH-FINDINGS** → 0 P1 / 6 P2 / 6 P3，全部为实现细节，已回写 design：

| finding | 处置 |
| --- | --- |
| P2-1 `setNodeRunStatusTx` 遇终态会抛、不是空操作 | 参与者先点读，只有 pending 才 CAS（§4.4 第 2 条） |
| P2-2 卡片 CAS 不中会把孤儿终结一起回滚 | 孤儿终结单独先提交一笔（§4.4 第 2 条） |
| P2-3 open 卡两步落 failed 不 bump 会无界循环 | `bumpAttempt: true`；running 批次卡 `running→failed`（§4.4 第 3 条） |
| P2-4 正常返回 failed 但仍 pending 的 run 漏在孤儿之外 | 孤儿 = 本次铸出 / 采纳、库里仍 pending 的全部 run；生产既有的两个普通失败出口留 pending 的问题登记 backlog（§4.4 第 1 条） |
| P2-5 注入手段与断言缺口、「不自动重来」措辞 | §6 写明注入接缝、adopted 变体、上限按卡尝试预算计；AC-5 改写 |
| P2-6 被跳过的旧 pending 行永远 pending | 同一步终结为 canceled（§4.5）；AC-8 断言 |
| P3-1…P3-6 | 类型守卫与参与者显式分支；failureCode 为 NULL；终结后广播；领队 internal 分支先发消息再返回并写明两处差别；§4.5 跨帧取行、比较集合传全部 rows、containerRunId undefined 按 NULL；AC-8 反向用例 |


## 刀 1 落地记录（2026-09-23）

- **T1** 判据：`task-execution/domain/nodeRunSupersession.ts`（纯函数）+ `infrastructure/nodeRunSupersession.ts`（SQL 谓词，
  只用在 SELECT）。
- **T2** 围栏：`mergeStateLifecyclePersistence.transition` 在事务内判取代 ⇒ 同一处 `.update` 收成 abandoned（不带 extra）并提交，
  提交后在事务外抛 `IllegalMergeStateTransition`；在外层事务帧里调用直接拒绝。
- **T3** 入口重放：`nodeExecution.list({ excludeSuperseded })`；两段重放先把被排除的行 `tryTransition(abandon)` 收尾。
- **T4** 铸造：`nodeRunMintProgram` 只剩 scope / lineage 解析与 insert；`readPriorRows` 参数、`ABANDONABLE_MERGE_STATES`
  （含死值 `conflict-agent`）删除；blind-write 白名单去掉铸造那一处。
- **T8** 调度器：`resolveSchedulerRunRow` 用 `supersededPendingRows`（比较集合 = 全部 rows、带帧维度）跳过已被取代的 pending 行，
  同一步 `cancel-by-supersede` 终结为 canceled 并广播，没有可采纳的行就走既有新铸路径。
- **T5** 测试：`rfc369-node-run-supersession.test.ts`（纯函数逐格、SQL/纯函数双引擎对拍、AC-2 并发铸造无重放、AC-4、
  excludeSuperseded、AC-7、AC-8 及反向）；共享断言面 `tests/helpers/nodeRunSupersession.ts`；RFC-144 / 172 / 326 / 349 /
  359-t1 / W47 / 287-t8 按新语义改写，判据集合不变。rfc144-cas 的 P1-2 格夹具补了 shardKey：同帧、null shard、id 更大的
  子行按 §3(a) 本就取代父行（改前铸出这样一行同样会废父行），生产子行不会是这种形状。
- **变异验证**：换回改前的铸造参与者 ⇒ AC-1 源码锁、AC-2（PG 上事务体被重放）、RFC-144 / 349 / W47 共 11 条红；SQL 去掉
  shard 收口 ⇒ 对拍与 rfc172 红；关掉围栏 ⇒ AC-4 / AC-7 / rfc144-cas 共 8 条红。
