# RFC-187 技术设计

> 读法：先读 `proposal.md`。本文按 PR 分组给出每项的**契约 · 数据流 · 耦合点 · 失败模式 · 测试**。所有 file:line 以 2026-07-14 `main`（RFC-186 落地后）为准。

## 全局约束

- **单一事实源**：沿用 `workgroupRunner.ts`（引擎）/ `workgroupWake.ts`（唤醒决策纯函数）/ `workgroupContext.ts`（prompt 渲染）/ `scheduler.ts`（真实 host hook）四分工，不新建平行模块。
- **纯函数优先**：每个引擎行为改动先落一个可断言纯函数（如 `deriveLeaderClarifyPark` / `detectZeroDeltaDone` / `countLogicalRounds`），在引擎里 wire，再补集成/e2e。
- **零 migration 优先**：本 RFC 除 §4-4（conflict-human iso 保留策略，可能需一列）外，尽量不加表/列；TRAP-1 走 schema 校验码扩展（无 DB）。

---

## PR-1 — 探针实锤三项（P0/P1）

### §1.1 F3｜leader 反问 park 对引擎可见（AC-1，头等）

**实测根因（探针 B）**：`state.hostRuns` 只装载 `[WG_LEADER_NODE_ID, WG_MEMBER_NODE_ID]` 两类 run（`workgroupRunner.ts:448`），**根本不含 `__wg_clarify__` run**；而 `leaderParked`（`:765`）却去 `hostRuns` 里找 `nodeId===__wg_leader__ && status==='awaiting_human'`——leader 轮永远 `done`（clarify 被拆到独立 `__wg_clarify__` 行 park，`clarify.ts:166-177`），所以该谓词**恒 false，是死代码**。后果：引擎每轮都以为 leader 空闲 → 重唤 → leader 重发 clarify → 拆新 `__wg_clarify__` park……10 轮撞 `maxRounds` failed，**人从没被 park 到、N 个 clarify session 全孤儿**。

**契约（新纯函数）**：
```ts
// workgroupRunner.ts（或 workgroupWake.ts 侧的纯输入）
// 一个 open __wg_clarify__ awaiting_human run，其 parentNodeRunId 指向某个 leader run
//  ⇒ leader 被反问阻塞。member 反问（parent=member run）由 assignment.awaiting_human
//  既有路径处理，不在此。
function deriveLeaderClarifyPark(
  clarifyRuns: Array<{ status: string; parentNodeRunId: string | null }>,
  leaderRunIds: Set<string>,
): boolean
```

**数据流改动**：
1. `loadDbState` 的 `inArray(nodeRuns.nodeId, [...])` 增列 `WG_CLARIFY_NODE_ID`（`:448`），把 clarify run 纳入 state（新增 `state.clarifyRuns` 或复用 `hostRuns` 并在消费方按 nodeId 分流——**优先独立字段**，避免 `countRoundsUsed`/`retryIndex` 等既有 `hostRuns` 消费方误把 clarify 行算进 leader/member 轮）。
2. `leaderParked`（`:765`）改为 `deriveLeaderClarifyPark(state.clarifyRuns, leaderRunIdSet)`。
3. **唤醒决策**：`leaderParked===true` 时——① `wakeInput.inFlight.leaderRunning=true`（既有，`:774`，防重唤 leader）；② `decideWorkgroupOutcome` 需在此返回一个**新 park 原因** `leader-clarify`（区别于 `leader-idle`，见 §5 F8），映射到任务 `awaiting_human`（`workgroupRunner.ts:871-881` 的 detail.message）。
4. **答后续跑**：既有 clarify-answer rerun 路径（`:1106-1109` assignment awaiting_human→running；leader 侧走 `adoptable` clarify-answer 重导 `:734`）已能在答复后重驱 leader；需验证 leader clarify 的 answer 触发 `kickResume`/adoption（复用 RFC-181 A2 的 clarify session 恢复；本项**不新建**恢复机制，只接通检测 + park 出口）。

**耦合点 / 失败模式**：
- 与 §5 F8（park 原因枚举）同改一处 `WakeOutcome` 类型，合并落地。
- **风险 R1（中）**：clarify run 的 `parentNodeRunId` 是否稳定指向 leader run？`clarify.ts:173` 写 `parentNodeRunId ?? null`——须确认 host clarify 派发处（`scheduler.ts` runHostNode 的 clarify 分支）传的是 leader run id。若传 null，退回用 `clarify_sessions.sourceAgentNodeId === '__wg_leader__'` 关联（多一次 join，但语义确定）。**设计门须核实此链**。
- **风险 R2（中）**：autonomous 组的 leader clarify——RFC-181 已「硬压制」自治组的 clarify（`clarify-suppressed` 软驳回，不建 session）。故 F3 park 出口**只对非自治组生效**；自治组根本不该有 open leader clarify（若有=RFC-181 回归）。设计须在 `deriveLeaderClarifyPark` 或其 wire 处 assert：`park && autonomous` 组合应为空（加一条不变式测试）。

**测试**：
- 纯函数 `deriveLeaderClarifyPark` golden：leader-parent clarify→true；member-parent clarify→false；done clarify→false；空→false。
- 真实 e2e（`scenario-opencode`）：非自治 leader_worker 组，脚本化 leader 首轮发 `<workflow-clarify>`，断言任务 `awaiting_human` reason=`leader-clarify` 且 `__wg_leader__` run 数 = 1（**非**膨胀到 maxRounds）；再脚本化答复 → leader 续跑 → done。
- 源码锁：`loadDbState` inArray 含 `WG_CLARIFY_NODE_ID`；`leaderParked` 不再文本匹配 `status === 'awaiting_human'` 于 `hostRuns`。

### §1.2 §3-7｜maxRounds 触顶优雅收尾（AC-2）

**实测根因（探针 C）**：`maxRounds:1` 组，leader 第 1 轮派单、worker 产出 `hello.txt`，但聚合需第 2 轮 → `roundsUsed>=maxRounds` → `wake.capExceeded`（`workgroupWake.ts:243`）→ `decideWorkgroupOutcome` 返回 `{kind:'failed', reason:'max-rounds'}` → 任务 `failed`，**hello.txt 已在 canonical 却被判失败**。

**契约**：`capExceeded` 时不无脑 failed——引入「最后一轮 wrap-up」：
- 若存在**已完成但未聚合的 assignment**（`status==='done'` 有产出）或 canonical 有 delta → 给 leader **一次**强制 wrap-up 轮（prompt 指令：「已达轮数上限，请立即 `wg_decision done` 收尾聚合，不要再派新活」），该轮**不计入** maxRounds（借 §3-3 的 rerunCause 豁免）。wrap-up 后：declaredDone→按 gate 走 `done`/`awaiting_review`。
- 若 leader wrap-up 仍不 declare done（顽固）或纯空转无产出 → 退回 `failed`（reason 细分 `max-rounds-no-output`）或 park `awaiting_human`（reason `max-rounds-needs-human`），**但产出已在 worktree，用户 `GET /diff` 可见**。

**数据流**：`decideWorkgroupOutcome`（`workgroupWake.ts`）新增 `{kind:'wrap-up'}` outcome；`workgroupRunner.ts:801` switch 增 case：postMessage 强制收尾指令 + 驱一轮 leader（豁免计数）。

**失败模式 / 风险**：
- **R3（中）**：wrap-up 轮本身可能再撞信封手滑 → 走 `WG_PROTOCOL_RETRIES` 重试（不额外计数）；重试耗尽仍失败 → `max-rounds-no-output` failed（此时确已尽力）。
- **R4（低）**：free_collab 的 cap 语义不同（数成员轮）——本项**只改 leader_worker**；fc 的 cap→failed 暂留（非目标，fc 收敛单列）。

**测试**：`maxRounds:1` + 单派单 e2e 断言任务 ∈ {done, awaiting_review}（**非** failed）且 canonical 含 `hello.txt`；纯函数 `decideWorkgroupOutcome` golden 增 wrap-up 分支。

### §1.3 §4 新发现｜零 delta done 显式信号（AC-3）

**实测根因（探针 A）**：leader fan-out 两 writer，均按 leader brief 里的**绝对路径**写进 **leader 自己的 iso**（`iso/{task}/{leaderRunId}/shared.txt`）；两成员**自己的 iso 全空** → `mergeBackNodeIso` 合并零 → canonical 空；但 leader `wg_decision done` → 任务 `done`。**静默零交付**，无任何护栏。

**契约（纯函数 + 收尾挂钩）**：
```ts
// 在 lw done 收尾处（workgroupRunner.ts:808 case 'done'）
function detectZeroDeltaDone(
  canonicalDiffStat: { filesChanged: number },
  assignments: Array<{ status: string; claimsOutput: boolean }>,
): { suspect: boolean; doneAssignments: number }
```
- `done` 且 canonical `filesChanged===0` 且存在 `status==='done'` 的 assignment → `suspect=true`。
- 落**显式信号**：任务 `errorSummary`（或新 `warningSummary` 字段，避免污染 error 语义——**优先复用现有 `errorSummary` 但前缀 `[warn]`**，零 migration）+ 房间 system decision 消息「⚠️ N 个成员报告完成但 canonical 无改动，产出可能未合并（检查成员是否写到了 worktree 外）」。**不改变** done 状态（不误伤真·无文件类任务，如纯审计组）——只告警。

**耦合点**：需在收尾时拿到 canonical diff stat。`GET /api/tasks/:id/diff` 已有累积 diff 计算逻辑（`services` 层），抽出 diffStat 供引擎收尾复用；若成本高，退化为「git diff --stat base..HEAD 的 filesChanged 计数」。

**协议侧收敛（配套，降低触发率）**：`renderWgProtocolBlock`（`workgroupContext.ts`）的 fan-out/brief 指引加一句：「brief 里指定文件用**相对仓库根**路径，绝不写绝对路径——每个成员在自己的工作副本里执行」。这是探针 A 根因（leader baked 绝对路径）的 prompt 级缓解。

**风险 R5（中）**：纯审计 / 纯 review 组**本就该**零 delta done（无 producer 或 producer 只读）——`detectZeroDeltaDone` 必须 gate 在「存在 done 且**非只读** assignment」上，否则对合法只读组误报。用 assignment 对应 agent 的 `readonly` 判定。

**测试**：`detectZeroDeltaDone` golden（有 done 非只读 assignment + 零 delta→suspect；只读组→不报；有 delta→不报）；e2e 复现探针 A 形状（脚本化成员写 worktree 外）断言 done 但带 warn 信号。

---

## PR-2 — P1 硬化

### §2.1 §3-3｜协议重试不膨胀 maxRounds（AC-4）

**根因**：`countRoundsUsed`（`workgroupRunner.ts:545-553`）数**所有** `__wg_leader__` run（除 `canceled`/`rerunCause==='wg-gate'`）；而协议重试每 attempt 铸一个新 leader run（`:1146-1152`，`retryIndex` 递增）。RFC-186 把 `WG_PROTOCOL_RETRIES` 1→3 后，**一个逻辑轮最多铸 4 个 leader run，全计入 maxRounds**——直接把 §3-3 放大 2×→4×。

**契约**：协议重试铸的 leader run 打专用 `rerunCause`（如 `wg-protocol-retry`），`countRoundsUsed` 在排除集加它：
```ts
r.nodeId === WG_LEADER_NODE_ID
  && r.status !== 'canceled'
  && r.rerunCause !== 'wg-gate'
  && r.rerunCause !== 'wg-protocol-retry'   // ← 新增：同一逻辑轮的重试不重复计数
```
- 铸 run 处（`:1146-1152`）在 `attempt>0` 时把 cause 设为 `wg-protocol-retry`（`attempt===0` 保持 `wg-leader-round`）。member 侧同理（`:1364-1375`，但 member 轮计数在 fc 才用，`:552`）。

**耦合**：`rerunCause` 是既有枚举（RFC-145/098）——需在枚举加 `wg-protocol-retry` 值 + mint 门 `isClarifyRerunCause` 等分类器确认不误纳（它不是 clarify 血统）。**风险 R6（中）**：rerunCause 枚举扩展要过 RFC-183 的 `clarifyDispositionFor` 穷举分类器（never 锁）——新 cause 须显式归类为「非 clarify 技术延续」。

**测试**：纯函数 `countRoundsUsed` 锁：1 base + 3 retry leader run = 1 逻辑轮；枚举扩展过分类器 golden。

### §2.2 §4-2/3｜fan-out 重叠写逐路径救回 + merge agent 出 writeSem（AC-5）

> 注：探针 A 因绝对路径**没走到**真·git 合并冲突路径（写到了 iso 外）。§4-2/3 仍是**代码确认**的隐患（`nodeIsolation.ts:295-322` whole-repo 粒度丢输者、`scheduler.ts:963-976` merge agent 持 writeSem），本 PR 按审计修，e2e 需构造成员写**自己 iso** 的同文件冲突来真实覆盖。

- **§4-2 逐路径救回**：`mergeBackNodeIso` 冲突时，不再整个 delta 丢弃/park——干净路径（无冲突）正常 3-way 落地，仅冲突路径 park + 结构化 note「丢了 N 文件：[...]」。契约：`mergeBackNodeIso` 返回 `{ merged: string[]; conflicted: string[] }` 而非全或无。
- **§4-3 merge agent 出 writeSem**：merge agent 子进程（LLM 解冲突）当前在 `writeSem` 内跑（`scheduler.ts:963-976`）→ 冻结全任务兄弟 merge-back + 新 iso 创建（`:674` createNodeIso 也持 writeSem）。改为：merge agent 在**锁外**算出解，仅最终 `materialize`（写 canonical）时短暂夺 `writeSem`。
- **风险 R7（高）**：这是本 RFC 最深的改动，触 `nodeIsolation.ts` 合并核心 + `taskWriteLocks.ts` 锁语义。须保「合并原子性」（materialize 期间持锁）不破，且 merge agent 锁外跑时**看到的 canonical 可能已被兄弟 materialize 改变** → 需 re-check/重算（乐观锁式）。**设计门重点对抗审查此项**；若风险过高，PR-2 可只做 §4-2（逐路径救回）+ 把 §4-3 降级 PR-3。

**测试**：`mergeBackNodeIso` 返回结构单测（干净+冲突混合）；e2e 两成员各在自己 iso 写同文件不同行→断言干净路径落地、冲突路径 park + note；writeSem 不被 merge agent 长持（源码锁 + 时序断言）。

### §2.3 TRAP-1｜启动就绪护栏（AC-6）

**根因**：`workgroupLaunchReadiness`（`shared/schemas/workgroup.ts:270-284`）仅查 `no-agent-member`/`leader-missing`；一个只有只读 producer / leader-only 的花名册照样绿灯 → leader 正确判 BLOCKED → 引擎当协议问题 failed。

**契约**：`workgroupLaunchReadiness` 增码：
- `no-producer`：leader_worker 组无任何**非 leader、非只读**可派成员。
- `no-non-leader-worker`：花名册仅 leader（无 worker）。
- free_collab：至少 2 个非只读成员，否则 `fc-insufficient-writers`。
- 级别：**warning**（不硬阻启动，用户可能有意）——前端 banner 同源渲染（`workgroups.ts:340-350` create 校验 + 启动 readiness + 房间 banner 三处同一 readiness 函数）。

**测试**：`workgroupLaunchReadiness` golden 三态（只读组→no-producer；leader-only→no-non-leader-worker；健康组→ok）。

### §2.4 F8｜park 原因区分 idle vs 待答（AC-7）

随 §1.1 F3 一起：`WakeOutcome` 的 `awaiting_human` reason 从 `'leader-idle'|'clarify-or-delivery'` 扩为含 `'leader-clarify'`。`workgroupWake.ts:245-267` 的 `humanPending`/park 决策：leader-clarify park（来自 F3 检测）→ reason `leader-clarify`；真空转（无 clarify、无 assignment、autonomous nudge 耗尽）→ `leader-idle`。遥测/房间显示正确原因（`workgroupRunner.ts:874-880` detail）。

---

## PR-3 — P2 潜伏

### §3.1 §4-4｜conflict-human 行不孤儿化 iso（AC-8）
工作组冲突后 `finally` 恒 `discardNodeIso`（`scheduler.ts:1001-1008`）+ `deleteIsoRefs`（`nodeIsolation.ts:397-414`）→ restart 时 `replayConflictHumanResolutions` 探不到 base/node commit（已 GC）→ throw → `runTask` catch → resume 时 failTask 整任务。修：工作组 conflict-human 行比照 DAG `keepIso`（`scheduler.ts:3578`）保留 iso/refs 至解决；或显式 abandon 并把 node_run/assignment 状态对齐（消除 node_run `done` vs assignment `failed` 背离）。**可能需一列**记录「iso 保留至人工解决」——评估后定。

### §3.2 §4-6｜同波 fan-out 共享 base 快照（AC-9）
`createNodeIso`（`scheduler.ts:674-683`）被 globalSem 排队 → 不同成员 fork 自不同时刻的 canonical → 合并 base 非确定。修：同一 leader 派单波内的成员共享单次 base 快照（派发时刻 pin 一个 canonical commit，波内成员都 fork 自它）。

### §3.3 F2 残留｜消息驱动任何可恢复态（AC-10）
`workgroupTasks.ts:452`（消息）/`deliver`/config-PATCH 的 `kickResume` 仅在 `awaiting_human` 触发；给 `interrupted`/`running`(卡) 任务发消息建 dispatched assignment 却不驱动。PR-2/RFC-186 已让 interrupted 在**重启时**auto-resume，但**非重启**的 live interrupted/idle 仍黑洞。修：kickResume 放宽到任何可恢复态（`interrupted`/`awaiting_human`），走 `resumeTask` 服务绕 builtin-403。

### §3.4 TRAP-3｜Playwright 断言收紧（AC-11）
`e2e/task-wizard.spec.ts:159` `expect(['done','failed'])` → 禁 `failed` 当过；`stub-opencode.sh:63` 固定 `<port name="answer">` 非 wg 信封 → 加 wg-aware 分支产合法 `<workflow-output><port name="wg_assignments">...`。

### §3.5 §3-2｜continue-no-dispatch 收口（AC-12）
leader emit `continue` 不带 assignments：autonomous 已走 nudge（`workgroupWake.ts:264-266`，RFC-180，**已覆盖**）；非自治须带阻塞说明或 park。本项主要是**非自治**路径 + 一条源码锁确认 autonomous nudge 不回归。低优先。

---

## §6 测试策略总表（哪些必写）

| AC | 纯函数预言 | 真实 e2e | 源码锁 |
|---|---|---|---|
| F3 (AC-1) | `deriveLeaderClarifyPark` golden | 非自治 leader clarify→awaiting_human→答→done，轮数=1 | loadDbState 含 CLARIFY；leaderParked 非死代码 |
| §3-7 (AC-2) | `decideWorkgroupOutcome` wrap-up 分支 | maxRounds:1→非 failed + canonical 有产出 | — |
| §4 零delta (AC-3) | `detectZeroDeltaDone` golden（含只读 gate）| 成员写 worktree 外→done+warn | 协议块相对路径指引文本锁 |
| §3-3 (AC-4) | `countRoundsUsed`：1base+3retry=1轮 | — | rerunCause 枚举过分类器 |
| §4-2/3 (AC-5) | `mergeBackNodeIso` 返回 {merged,conflicted} | 两成员同文件冲突→逐路径救回+note | merge agent 不长持 writeSem |
| TRAP-1 (AC-6) | `workgroupLaunchReadiness` 三态 | — | create/launch/banner 同源 |
| F8 (AC-7) | reason 枚举 golden | （随 F3）| — |
| §4-4/4-6/F2/TRAP-3/§3-2 | 各自纯函数/锁 | 按需 | 是 |

**铁律**：PR-1 三锤（F3/§3-7/§4零delta）**必须**各有一条真实子进程 e2e（`scenario-opencode` 脚本化），把探针实测锁进 CI——否则重演「测试全绿而生产真炸」。

## §7 风险汇总

| 风险 | 项 | 级别 | 缓解 |
|---|---|---|---|
| R1 clarify parent 链不稳 | F3 | 中 | 设计门核实 `parentNodeRunId`；退回 `sourceAgentNodeId` join |
| R2 autonomous 不该有 leader clarify | F3 | 中 | 不变式测试 assert park&&autonomous 为空 |
| R3 wrap-up 轮再手滑 | §3-7 | 中 | 走 WG_PROTOCOL_RETRIES，耗尽才 failed |
| R4 fc cap 语义不同 | §3-7 | 低 | 只改 lw，fc 单列 |
| R5 只读组合法零 delta | §4 | 中 | gate 在非只读 done assignment |
| R6 rerunCause 枚举漂移 | §3-3 | 中 | 过 clarifyDispositionFor never 锁 |
| R7 merge agent 出锁改合并核心 | §4-3 | **高** | 设计门重点对抗；必要时降级 PR-3 |

## §8 PR 拆分

- **PR-1**（AC-1/2/3）：F3 反问收口 + §3-7 优雅收尾 + §4 零 delta 信号。探针实锤三项，最高优先。
- **PR-2**（AC-4/5/6/7）：§3-3 计数 + §4-2/3 fan-out 合并 + TRAP-1 护栏 + F8 标注。
- **PR-3**（AC-8/9/10/11/12）：§4-4 iso 保留 + §4-6 共享 base + F2 残留 + TRAP-3 + §3-2。

每 PR 独立可交付、独立过五门 + CI。PR 间无强依赖（F8 随 PR-1 的 WakeOutcome 改动落，故与 F3 同 PR-1 更省）。

## §9 Codex 设计门（2026-07-14，NOT APPROVE→折入）

Codex 对本 RFC 出 4 P0 + 6 P1/P2。核对源码后分三档处理：

**已符合（本实现从 RFC 文本正确偏离，Codex 确认）**：
- P0-2：F3 park bit 独立于 `leaderRunning`（非折入）——否则 `decideWorkgroupOutcome` 首判 running 令 `leader-clarify` 不可达。本实现即独立 `leaderClarifyParked`，Codex 判「正确形状」。
- P1-6（口径）：canonical diff 用「worktree 对 base」含 uncommitted+untracked（`worktreeFilesChanged`），非 RFC 文本误写的 `base..HEAD`。
- P2-11：done 告警走**房间 system message**（非 `errorSummary`，避免混入失败诊断面）。
- P1-5/P1-10：`agent.readonly` 已被 RFC-130 删 → zero-delta 改 gate 在 done-assignment 数（承认启发式）；counted wrap-up 使 T2 **不**依赖 T4。

**PR-1 已折入**：
- **P0-1**：F3 关联键从 `__wg_clarify__` run 的 `shardKey===null` 改为 **clarify SESSION**（`sourceAgentNodeId===__wg_leader__` 且 open）——run 在 session 之前非事务铸出，崩在其间的孤儿 run 会被 run-only 判据永久 park；session 判据证明「可回答」且崩溃自愈。
- **P0-3**：grace wrap-up 轮补**禁派活**（新 assignment 被 DROP 非报错，好让 done 决策仍落地）+ **强制收尾 prompt**（wrapUp 经 wake item.reason 透传进 `driveLeaderTurn`）。counted one-shot 本已 durable（`roundsUsed` 由 DB 派生）。

**改 PR-2/3 范围**：
- **P0-4 / T5b（R7 高危）**：merge agent 出 `writeSem` 若沿用「重 snapshot 后直接 materialize」会覆盖锁外落地的兄弟改动。正解＝两阶段 pin（首冲突钉 `oursAtConflict`、重夺锁后 `merge(base=oursAtConflict, ours=currentCanonical, theirs=resolvedTree)`，human-resume 已有此算法）+ 冲突重现/重试上限/多 repo 原子边界 + 并发/重启测试。**T5b 从 PR-2/3 拆出，另立独立 RFC；PR-2 保 merge agent 在 `writeSem` 内**，只做 T5a。
- **P1-9 / T5a**：逐路径 salvage 不能只改返回类型——需定义安全 partial tree 构造、partial materialize 前后崩溃的幂等重放、单一 `merge_state` 表达剩余冲突；且先修 human-replay 把「无 resolve-iso 的已干净 repo」误判 unresolved 的恢复契约。
- **P1-8 / T4（§3-3）**：① 耦合对象写错——不是 `clarifyDispositionFor`（管 `ClarifyChannelDirective`），而是 `isClarifyRerunCause` + `RerunCause` enum 真值表；② fc 的 member retry 也须排除（不能只改 leader 分支）；③ 更深：clarify-answer host 首返「envelope 合法但 wg JSON 畸形」会经 `clarifyRerunLedger` 老化掉 Q&A，后续 protocol retry 拿不到答案——专用 cause 不够，须显式携带回答上下文。
- **P1-7（F3 恢复缝，归 PR-3 对账）**：稳态 answer→adoption 已通，但两个崩溃窗：① answer 事务提交后、`resumeTask` 接管前 daemon 退出 → pending clarify-answer run 被 reap 成 interrupted，但任务仍 `awaiting_human`（auto-resume 不扫、adoption 只认 pending）→ wedge；② autonomous 配置事务内提交、open-session dismissal 事务外 → 崩在其间留「autonomous+open clarify」。R2 不能只 assert impossible，须 engine-entry/boot reconciliation + crash test。
- **P1-5 尾 / T6（TRAP-1）**：`no-producer` 同样无数据源（readonly 已删、assignment 无 `claimsFileOutput`）——**去掉 `no-producer`**，只保结构性可查的 `no-non-leader-worker` / `leader-missing`；或显式加持久 assignment 级 `expectsWorktreeChanges` 契约（更大改动，另议）。
- **P1-6 尾（zero-delta 多 repo）**：现 hook 仅查 `task.worktreePath`（repo 0）——多 repo 应逐 `state.repos` 的 baseCommit 计数去重。

**PR 排序修正**：T7（F8）已归 PR-1（随 F3 的 WakeOutcome 落）；T5b 独立延期；余 PR-2/3 按上述范围调整。
