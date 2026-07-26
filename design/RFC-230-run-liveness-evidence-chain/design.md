# RFC-230 技术设计 — Run 活性证据链

## 1. 现状锚点（改动前的事实）

| 事实 | 锚点 |
| --- | --- |
| 周期回收器判活口径：`pid === null` 直接返回「已消失」 | `packages/backend/src/services/orphanReconcile.ts:37-48` |
| 候选查询只按 `status='running' AND started_at < now-grace`，不区分 run 类别 | `orphanReconcile.ts:73-83` |
| 回收后若任务无其它 running/pending 行，任务本身也翻 `interrupted` | `orphanReconcile.ts:101-117` |
| 宽限期默认 60s，生产接线在 daemon 启动处，间隔取 `periodicOrphanReconcileMs`（默认 10min） | `orphanReconcile.ts:139` / `cli/start.ts:681` |
| `pid` 全仓唯一 DB 写入点，且与 `spawn_binary_path` 同一条 update | `runner.ts:1442-1450` |
| agent 行先 mark-running（写 `startedAt`）后 spawn，中间隔着 RFC-224/227 全部准入 | `runner.ts:993-998` |
| wrapper 行 mint 即带 `startedAt`，随后立刻 mark-running，且永不写 pid | `nodeRunMint.ts:233`；`scheduler.ts:4341` / `:4601` / `:6239` |
| wrapper 收尾的终态守卫（本次事故的报错来源） | `lifecycle.ts:172-177`（+ 同构的 `:225-230`）经 `scheduler.ts:4193-4218` `markWrapperTerminal` |
| 异常冒泡到任务级失败 `scheduler error` | `scheduler.ts:662-666` |
| 「有活的调度器时禁止后台改写」的既有先例 | `task.ts:118-125` `isTaskActive` + `lifecycleRepair/helpers.ts:20-28` `schedulerLivenessGate` |
| wrapper 内层节点集合（定义层、纯函数、含环路保护） | `dispatchFrontier.ts:91-105` `wrapperInnerDescendants` |
| fanout 分片 / 聚合子行挂父指针 | `scheduler.ts:5182` / `:4946`（`parentNodeRunId = wrapperRunId`） |
| `parentNodeRunId !== null` 在多处被当作「这是 fan-out 子行」的判据 | `scheduler.ts:1958` / `:3065` / `:5072-5099` |
| 正面样例：autoKill 用 `pid IS NOT NULL` 圈定管辖范围 | `autoKill.ts:63` |
| 误收会伪造的卡死特征 | `stuckTaskDetector.ts:375`（诊断项 S3） |
| 测试盲区：判活函数被注入桩替代，真函数零覆盖 | `tests/rfc108-orphan-reconcile.test.ts:68/82/90/104` |

## 2. 核心抽象：活性是可委派的

**每一类 run 都必须声明自己的活性证据来源；证据可以向下委派，委派链最终必然落到真实进程或真实驱动上。**

```
LivenessEvidence =
  | { kind: 'driver' }                    // 本进程调度器正驱动该任务 —— 最强证据，短路一切
  | { kind: 'process'; pid, binaryPath }  // 该 run 曾 spawn 子进程 —— 由 OS 判活
  | { kind: 'delegated'; innerRunIds }    // 容器行 —— 递归看内层 run 是否有活的
  | { kind: 'none' }                      // 既没 spawn 过、也没有下层 —— 无驱动时即孤儿
```

对应到今天的 run 类别：

| run 类别 | 证据来源 | 说明 |
| --- | --- | --- |
| agent 节点（已 spawn） | `process` | 现有 pid 存活 + 二进制身份比对，逻辑不变 |
| agent 节点（pre-spawn 窗口） | `driver` → 否则 `none` | 有驱动即活；无驱动且从未 spawn ⇒ 孤儿 |
| **定义外 synthetic 行**（commit-push 容器等） | `delegated`（结构规则：有子行即容器） | 分类学覆盖不到它们，结构规则可以（P1-2） |
| wrapper-git / wrapper-loop / wrapper-fanout | `delegated` | 内层 run 即其子依赖 |
| 停泊行（clarify / review park） | 不适用 | 状态是 `awaiting_*`，本就不在候选集内 |
| io-virtual / gate 行 | `driver` → 否则 `none` | 瞬时行，从不 spawn |

**判定顺序（短路）**：`driver` → `process` → `delegated` → `none`（无驱动即孤儿）。

**判据是结构性的，不是分类学的**（设计门 P1-2）：容器身份 = 「这一行有没有子行」∨「定义里它是不是 wrapper」。原因是仓里存在定义中根本不存在的 synthetic 行——commit-push 容器行（`commitPush.ts` 的 `commitPushNodeId`）直接 mint 成 running、自身不持 pid、真进程跑在它另 mint 的 session 子行上（`commitPushRunner.ts:137-149`）。只按 `NodeKind` 分类会把这类行漏成「无法归类」，`NodeKind` 穷尽 switch 也给不出 AC8 承诺的保证——新增一个 `RerunCause` 或 synthetic 角色根本不会让 switch 变红。结构规则天然覆盖它们，也覆盖未来任何新增角色。

### 2.1 为什么 `driver` 排在最前

这是所有权判断，不是活性推测：只要本进程调度器正持有该任务，后台线程就无权对它的任何行下死亡判决。这条规则与 `schedulerLivenessGate`（RFC-097 audit S-23，诊断修复在活调度器面前一律让路）是同一道理，本 RFC 把它推广到周期回收器——**回收器至今是唯一一个绕过这道门的后台写者**。

它同时天然修好了 pre-spawn 窗口：进程还没起、但驱动活着 ⇒ 活；daemon 真死了 ⇒ 进程没有、驱动也没有 ⇒ 孤儿。两个方向都判对，不再依赖宽限期去猜。**宽限期由此从「猜测窗口」降级为纯抖动缓冲**（本 RFC 保留 60s 不动，但它不再是正确性的承重墙）。

### 2.2 递归的终止性

`delegated` 递归沿 wrapper 嵌套向下，深度受工作流定义的嵌套深度限制；`wrapperInnerDescendants` 自带 `visiting` 环路保护（`dispatchFrontier.ts:97`）。解析在单次 tick 内对**已读入内存的行集合**进行，不产生 N+1 查询。

### 2.3 无驱动时不保守判活（设计门 P1-1 修订）

初稿写的是「证据缺席一律判活」。Codex 设计门指出这条与 AC4 直接矛盾，而且更要命：**这类输入是稳定的**——同一 tick 每次得到相同结论，所以不是「晚点回收」，而是 daemon 生命周期内永不回收。采纳，改为：

**所有瞬时空窗都只发生在驱动活着的时候**（wrapper 刚建、loop 两次迭代之间、fanout 分片结束到聚合器起来），而 ① driver 门已经把它们整个罩住。生产侧 `runTask` 只有三个调用点（`task.ts:1849` / `:2353` / `:2943`），**三处都先注册 `activeTasks` 再启动**——所以「无驱动」严格意味着没有任何协程会再推进这一行。此时判活不是保守，是把残骸永久合法化。

于是无驱动路径上不再有「保守判活」：

| 情形 | verdict | reason |
| --- | --- | --- |
| 容器行零下层 | 死 | `empty-delegation` |
| 从未 spawn、无子行 | 死 | `unowned-never-spawned` |
| 下层全终态 | 死 | `inner-all-terminal` |
| 父指针成环那一支 | 不作为活性证据 | `lineage-cycle` |

**唯一残留的保守**：任务快照根本解析不了——那种情况下连分类都做不到，由 `orphanReconcile` 整任务跳过并告警（拒绝判决，而不是判活）。

代价方向仍然守住：误收的代价（打断活任务 + 任务级失败 + 伪造 S3 卡死现场）由 driver 门承担，而不是靠「凡是看不清就判活」这种会永久积累残骸的钝器。

## 3. 内层可达性：走定义层，不动数据模型

「wrapper 的子依赖是谁」有两条现成的路：

- **fanout**：分片行与聚合行在数据层挂着 `parentNodeRunId = wrapperRunId`（`scheduler.ts:5182` / `:4946`）。
- **git / loop**：内层节点当作普通节点跑，行上没有父指针，包含关系只存在于**工作流定义**里（`wrapperInnerDescendants`，纯函数）。

**决策：两条路合并进同一个解析函数，不给 git/loop 内层行补父指针。**

理由不是「省事」，而是补父指针会破坏既有语义：`parentNodeRunId !== null` 在 `scheduler.ts:1958` / `:3065` / `:5072-5099` 被当作「这是 fan-out 子行」的判据，`nodeRunMint.ts` 更把「直接 mint 成 running 的行必须是子行」立成了不变量（否则会进入 `deriveFrontier` 的 in-flight 集并冻结前沿）。给 loop/git 内层行加父指针会一次性改写这些判据的含义，风险远大于收益。定义层的包含关系是**冻结在任务快照里的**，回收器本就能读到，成本为零。

**证据解析不引入迭代窗口。** `wrapperRevivalEvidence` 出于「唤醒」语义需要按迭代窗口过滤，并因此带着一条已记录的 depth-1 盲区（`dispatchFrontier.ts:238-243`）。活性判断不关心新鲜度——**任何一个内层后代当下活着，就是活的证据**，与它属于哪次迭代无关。这样既绕开了那条盲区，语义也更简单。

## 4. 接口契约

### 4.1 新增纯函数（`services/runLiveness.ts`，无 DB / 无 IO）

```ts
export type LivenessEvidence =
  | { kind: 'driver' }
  | { kind: 'process'; pid: number; spawnBinaryPath: string | null }
  | { kind: 'delegated'; innerNodeIds: ReadonlySet<string> }
  | { kind: 'none' }

/** 定义层 NodeKind 的证据来源声明（穷尽 switch）。只覆盖工作流定义里的节点；
 *  定义外的 synthetic 行由 classifyRunLiveness 的结构规则兜底。 */
export function livenessSourceOfKind(kind: NodeKind): 'process' | 'delegated'

/** 一行 run 自身的证据（不含任务级 driver，后者由 resolveRunLiveness 产出）。
 *  判定次序全部是结构性的：
 *    ① 有 pid ⇒ process（与快照是否可解析无关；wrapper 永远没有 pid）
 *    ② 有子行 ∨ 定义里是 wrapper ⇒ delegated（覆盖 commit-push 等 synthetic 容器）
 *    ③ 其余 ⇒ none */
export function classifyRunLiveness(
  row: LivenessRunRow,
  definition: WorkflowDefinition,
  rows?: readonly LivenessRunRow[],
): Exclude<LivenessEvidence, { kind: 'driver' }>

/** 解析证据链。alive=false 才是孤儿；reason 用于审计留痕。 */
export function resolveRunLiveness(args: {
  row: NodeRunRow
  rows: readonly NodeRunRow[]        // 同任务全部行，单次 tick 读入
  definition: WorkflowDefinition
  taskHasDriver: boolean             // isTaskActive(taskId)
  probeProcess: (pid: number, binaryPath: string | null) => boolean
}): { alive: boolean; reason: LivenessReason }
```

`LivenessReason` 为闭集字符串（`driver-attached` / `process-alive` / `process-gone` / `inner-alive` / `inner-all-terminal` / `empty-delegation` / `unowned-never-spawned` / `lineage-cycle`），直接进回收审计事件，让「为什么收 / 为什么不收」可追溯。拆到这个粒度是设计门 P3-1 的要求：运维必须能区分「正常短空窗」与「结构已不可解析」。

### 4.2 回收器接线（`orphanReconcile.ts`）

- 候选查询不变（仍是 `running` + 宽限期），但**逐任务**批量读入该任务全部行与冻结定义，交给 `resolveRunLiveness` 判定。
- 任务级 `interrupted` 翻转（`:101-117`）追加同一道 `driver` 门：活跃任务一律跳过。
- `runProcessGone` 收缩为纯粹的**进程探针**（只在 `kind === 'process'` 分支被调用），不再承担类别判断。旧的 `pid === null ⇒ gone` 语义**删除**（不保留过渡开关——面向代码最合理优于改动最小）。
- 任务快照整体解析失败 ⇒ **整任务跳过 + warn**（拒绝判决，唯一残留的保守）。定义里找不到该节点但快照可解析 ⇒ 走结构规则，不再特殊照顾。
- **每一次回收都记 run 级 `periodic-reap` 审计事件**（带 `nodeRunId` 与 reason）。旧代码只在任务也被翻时记事件，于是「回收了 wrapper、但任务还有 pending 兄弟」这种情况完全无痕（设计门 P2-4）。
- driver 门在**每次写之前再查一遍**：门与 CAS 之间隔着 await，resume 可能在中间重新接管这一行。这不是原子的（完全原子需要任务级 ownership epoch），残余风险记在 §5。

### 4.3 finalize 第二道防线（`scheduler.ts` `markWrapperTerminal`）

即使回收器修好，用户取消与诊断修复仍是**合法**的抢先写者，同样会撞上终态守卫。改为：

- 行已是 `canceled` / `interrupted` ⇒ 不覆盖，按该终态收敛 scope 结果（`canceled` → scope canceled；`interrupted` → scope failed，同样可 resume，而不是假装 `done` 让被打断的工作绿色收场），记 info 日志。
- 其余非法转移（例如已 `done` 却又要写 `failed`）⇒ 维持现状大声抛出。真相不一致必须暴露。

**实现取径**：`markWrapperTerminal` 捕获 CAS 失败后重读状态，可收敛则抛 `WrapperSupersededSignal`，由三个 wrapper 分派点共用的 `runWrapperNode` 外壳统一转成 scope 结果。选这条而不是「让 markWrapperTerminal 返回结果、15 个调用点各判一次」，是因为收尾撞外部终态必须只有**一条出口**——15 个分支里漏改一个就是一次静默回归。抛出前先清 fanout 的 `reuseDisabled` 闸门（留着会永久禁掉该 resume 血脉的 done-shard 复用）。

## 5. 失败模式

| 场景 | 改动前 | 改动后 |
| --- | --- | --- |
| wrapper 内层跑 15 分钟 | 60s 后被收 → 收尾 `scheduler error` 全任务失败 | 驱动在 ⇒ 判活，不受影响（AC1） |
| daemon 活着但 wrapper 失去驱动 | 因「没 pid」被误打误撞收掉 | 因「内层全终态 + 无驱动」被正确收掉（AC2） |
| agent pre-spawn 超 60s | 被收 → 后续 runner 写状态同样撞守卫 | 驱动在 ⇒ 判活（AC4） |
| wrapper 空窗瞬间（驱动在） | 被收 | 判活（AC5） |
| 容器行零下层且无驱动 | 因「没 pid」被收（理由错但结果对） | 因 `empty-delegation` 被收（理由对） |
| commit-push 容器行（synthetic nodeId、无 pid） | 被收（误收；真进程在其 session 子行上） | 由子行判活（AC8 结构规则） |
| daemon 崩溃重启 | 开机清扫全盘翻 interrupted | 不变（本 RFC 不碰开机清扫） |
| 用户取消撞上 wrapper 收尾 | `scheduler error` | 收敛为 `canceled`（AC6） |
| 快照整体解析失败 | 按无 pid 收掉 | 整任务跳过 + warn（拒绝判决） |
| 节点已从定义消失但无子行、无驱动 | 按无 pid 收掉 | `unowned-never-spawned` 收掉（同结果，正确理由） |

**残留的已知边界（均落在「漏收」这一侧，与 §2.3 的代价不对称一致）**：

- daemon 活着、驱动协程还在、但内层真的全部卡死（进程活着却不产出）——不归本机制管，那是 `autoKill` 心跳线的职责（默认关闭，`autoKillStalledChild`）。本 RFC 不扩张到那一侧。
- **driver 门自身的失效模式**：若 `activeTasks` 条目泄漏（驱动协程已死却没走到 `task.ts:1871` / `:2376` / `:2964` 的 finally 清理，例如进程被 SIGSTOP 或事件循环 wedge），该任务的行将被周期回收器永久跳过。兜底是开机清扫——daemon 重启时进程内注册表随进程消失，全部 running 行照常翻 interrupted。选择接受而不是加超时兜底：给驱动所有权加时间窗，等于把刚被根除的「拿时间猜活性」重新引回来。
- 上一代 wrapper 遗留的 `running` 内层行会让当代 wrapper 判活（活性不按迭代 / 代际过滤）。同属漏收，且这类残骸本身就是别处的 bug 信号，不应由本机制掩盖式清理。

## 6. 与既有机制的耦合点

- **开机清扫**（`orphans.ts`）：不动。语义正交——那一刻整进程无驱动，无证据可言。
- **autoKill**：不动，且作为正面样例写进注释交叉引用。
- **诊断修复 S3**（`stuckTaskDetector.ts:375`）：本 RFC 消除的是**被伪造出来的** S3 现场；真实 S3 仍照常检出。需回归确认判据未被削弱。
- **recovery_events**：`periodic-reap` 事件体追加 `reason`，前端诊断面板据此显示「为什么被回收」。事件 kind 不新增。
- **RFC-097 CAS / RFC-053 转移表**：一律不改。本 RFC 只改「谁有资格发起这次写」，不改「这次写合不合法」。

## 7. 测试策略

必写用例（红→绿）：

1. **真判活函数直测**（AC7）：pid 存活 / pid 已死 / pid 被回收复用（二进制不匹配）/ 从未 spawn。**不得注入桩**——这正是今天的盲区。
2. **wrapper 长跑不被收**（AC1）：wrapper 行 `running`、`started_at` 远早于宽限期、内层 agent 行 `running` 且 pid 存活 ⇒ tick 后仍 `running`。三种 wrapper 各一条。
3. **失驱动 wrapper 被收**（AC2）：内层行全终态 + 任务不在活跃注册表 ⇒ tick 后 `interrupted`，审计 reason 为 `inner-all-terminal`。
4. **驱动门**（AC3）：任务在活跃注册表内 ⇒ 行与任务行均不被改写（复用 `__setActiveTaskForTesting`，`task.ts:129`）。
5. **pre-spawn 窗口**（AC4）：无 pid + 无 spawnBinaryPath + 有驱动 ⇒ 活；无驱动 ⇒ 收。
6. **空窗**（AC5）：wrapper 行存在、内层零行 ⇒ 判活，reason 为 `no-evidence-yet`。
7. **嵌套委派**：loop 套 git、git 套 fanout，最内层 agent 活 ⇒ 最外层 wrapper 判活（跨迭代亦然，验证不受迭代窗口影响）。
8. **finalize 抗竞态**（AC6）：wrapper 收尾前把行外部翻成 `canceled` / `interrupted` ⇒ 任务收在该终态且不出现 `scheduler error`；翻成 `done` 后再 finalize `failed` ⇒ 仍抛。
9. **穷尽性守卫**（AC8）：`classifyRunLiveness` 的 NodeKind 穷尽 switch，新增 kind 未声明证据来源 ⇒ typecheck 失败（配一条源码层断言兜底）。
10. **回归防护命名**：测试文件顶部注明「锁定 RFC-230：孤儿回收器不得因『没有 pid』判定 wrapper 死亡」，并链回本 RFC 与事故报错原文。

## 8. 存量数据

本机 DB 无受害行（查过：无 `rerun_cause='wrapper-init'` 的行、无 `error_message='orphan-reconcile'` 的行）。其它环境可能有。

**方案**：提供一次性 fixup 脚本（仿 `scripts/fixup-rfc052-stuck-review.ts` 的范式：先精确校验形状，不符即拒绝触碰 DB），只认「`status='interrupted'` ∧ `error_message='orphan-reconcile'` ∧ `pid IS NULL` ∧ `spawn_binary_path IS NULL`」这一组合。**不写进迁移**——迁移不可回退，而这是一次性运维动作。

## 9. 需用户确认的决策点

| 编号 | 决策 | 本文取值 | 备选 |
| --- | --- | --- | --- |
| D1 | 子依赖关系走哪一层 | 定义层 + 既有父指针合并，零迁移 | 给 loop/git 内层行补父指针（会改写 fan-out 子行判据语义） |
| D2 | 空窗如何处理 | 保守判活 | 引入时间窗 / 用 wrapper 进度标记做二次证据 |
| D3 | finalize 抗竞态是否纳入本 RFC | 纳入（PR-2） | 只修根因，另立条目 |
| D4 | 存量修复形式 | fixup 脚本 | 不修 / 写进迁移 |
| D5 | 宽限期是否调整 | 保留 60s（已非承重墙） | 顺势删除或延长 |


## 10. 设计门修订账（Codex round-1，2026-07-26）

| 编号 | 结论 | 处置 |
| --- | --- | --- |
| P1-1 | `none` 同时表示「保守判活」与「无主孤儿」，AC4 不可实现；且这类输入稳定，等于永久残骸 | **全采纳**。无驱动路径取消保守判活，拆出 `empty-delegation` / `unowned-never-spawned`；唯一残留保守是快照整体不可解析（整任务跳过）。AC4 / AC5 已按此改写 |
| P1-2 | `NodeKind` 穷尽 ≠ run 角色穷尽；commit-push 容器行是现成反例 | **全采纳**。判据改为结构性（有子行 ∨ 定义里是 wrapper 即容器），`NodeKind` switch 降为定义层提示；AC8 改写并加 commit-push 形状回归 |
| P2-1 | 不补父指针的理由成立；但行层面环 / 代际可达性未写进契约 | 采纳可落地部分：row-id `visited` + `lineage-cycle` 明确「环那一支不作为活性证据」写入契约；代际归属仍按不过滤（§5 已知边界），未引入 generation 规则 |
| P2-2 | driver 门不是健康证明也不是原子门（TOCTOU + activeTasks 泄漏） | 部分采纳：每次写前重查 driver，把窗口压到「查完到 CAS」之间；泄漏与完全原子化（ownership epoch）记为 §5 残余，不半场开工 |
| P2-3 | finalize 捕获任意异常再重读状态会吞掉 DB / NotFound 错误 | **全采纳**。只对 `illegal-node-run-transition` / `concurrent-node-run-transition` 收敛，其余原样抛；interrupted → 任务 failed 的映射在三份文档统一 |
| P2-4 | 测试未覆盖生产接线、synthetic 角色、run 级审计 | 全采纳：新增真实 `__setActiveTaskForTesting` 接线用例、commit-push 形状用例、「回收 run 但不翻 task 仍有 nodeRunId 审计」用例、interrupted 的任务级状态断言 |
| P3-1 | reason 过粗；进程身份正向分支未锁 | 全采纳：reason 拆为 8 值；补「pid 活 + binaryPath 匹配」正向探针用例 |

**未采纳 / 留待观察**：`RunRole` 全量穷尽表（P1-2 的建议解）——结构规则已经堵住「新角色被漏成无法归类」这条缝，再叠一张按 `rerunCause` 的分类表会引入第二个事实源，且历史 `rerun_cause=null` 行无法归类。若将来出现「有子行但语义上不该委派」的角色，再立表不迟。
