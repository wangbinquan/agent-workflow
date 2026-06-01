# RFC-074 Proposal — Provenance-Based Node Freshness（用消费溯源替代 clarifyIteration 水位）

> 状态：Draft（2026-05-27）
> Owner：—
> 关联文档：[design.md](./design.md)、[plan.md](./plan.md)
> 基线 RFC：[RFC-005 review](../RFC-005-human-review/proposal.md)、[RFC-056 clarify-cross-agent](../RFC-056-clarify-cross-agent/proposal.md)、[RFC-064 unified-clarify-runtime](../RFC-064-unified-clarify-runtime/proposal.md)、[RFC-070 clarify-consumed-by-run](../RFC-070-clarify-consumed-by-run/proposal.md)

## 1. 背景

### 1.1 一句话总结

系统用一个标量计数器 `clarifyIteration`（cci）去编码"DAG 边上的因果关系"——即"下游消费了上游的哪个版本"。标量 counter 无法忠实表达跨多个独立 rerun 源（self-clarify / cross-clarify / review-iterate / process-retry，各自递增节奏不同）的图级因果，于是每加一个 rerun 源、每改一次 counter，就爆一次同形 bug。

本 RFC 把 freshness 判定从"cci 水位比大小"换成 **provenance（消费溯源）**：每个 node_run 记录它消费了上游的哪一个具体 node_run；freshness = "我消费的那个上游 run，是否仍是该上游节点当前最新的 done 行"。这是 [RFC-070](../RFC-070-clarify-consumed-by-run/proposal.md) 把 clarify-Q&A 老化从"counter 比大小"换成"`consumed_by_run_id` 行戳"的**同一招，推广到节点数据流 freshness**。

### 1.2 现状：cci 当版本水位，两层 cascade 维护它

- **Layer A — `cascadeDownstreamFromDesigner`**（`crossClarify.ts:932`）：cross-clarify directive='continue' 完成时 BFS 整张下游图，预 mint 每个下游 pending 行，cci = 新水位。
- **Layer B — `applyClarifyFreshnessInvariant`**（`scheduler.ts:734`）：每次 `runScope` 进入跑 fixed-point，发现下游 cci < 上游 cci 就 mint 新 pending 降级它。

cci 在系统里被三套**互相不一致**的 picker 解读（代码实证）：

| 代码路径 | 排序键 | 用途 |
|---|---|---|
| `isFresherNodeRun`（`scheduler.ts:411`） | `(cci, retryIndex, id)` | scheduler `latestPerNode` + review 选 sourceRun |
| `resolveUpstreamInputs`（`scheduler.ts:3133`） | `(iteration, retryIndex)` —**无 cci** | agent 节点实际读哪行的内容 |
| Layer B freshness（`scheduler.ts:763`） | cci 数值比大小 | 决定 demote |

**一个节点实际"读了"哪行的内容（picker 2），和 freshness 检查认为"最新"的是哪行（picker 1/3），可以是不同的行。** 三套"上游当前版本"的真相源各自漂移——这是 8+ 个 dated patch 的温床。

### 1.3 直接事故

任务 `01KSHVXCH6RQ5F5P64MZ4FZVN6`（DB 复核）：review 节点 `rev_5h9xpz` 在用户 approve v2（cci=6 row）后 18ms，又冒出一行 cci=8 的 awaiting_review，强制用户对**刚批准过的同一份内容**再批一次。

根因链：

1. iterate v1 → 重 mint review row，`row.cci=3`（来自 iterate 时刻的 sourceRun）
2. agent 重跑出 cci=6 内容 → `dispatchReviewNode` reuse 既有 row、创建 docVersion v2，内容来自 cci=6 的 agent run
3. awaiting 期间 self-clarify 让 agent 又跑 cci=6→7→8，每轮 `dispatchReviewNode` reuse v2（不 mint v3）；**v2 的内容文件刷新到 cci=8，但 `row.clarifyIteration` 字段没动、仍是 6**（reuse 分支只 transition status、从不 UPDATE cci）
4. 用户 approve v2（看到的是 cci=8 内容）→ row 转 done，`row.cci` 仍是 6
5. `resumeTask` → `runScope` → Layer B 检查 `rev.cci=6 < agent.cci=8` → 误判 stale → mint cci=8 awaiting_review

**本质是一个反规范化（denormalization）bug**：「评审了哪个版本」存在两个地方——`row.cci`（iterate 时定格=6）和 docVersion 内容来源（refresh 到=8）——两个字段由不同代码路径维护，desync 了。

### 1.4 这不是第一次

从 RFC-056 到 RFC-064、RFC-070，cci / cascade / freshness 这块的 dated patch 已累计 8+ 次（`patch-2026-05-22-downstream-cascade.md` / `patch-2026-05-25-questioner-cascade-cci.md` / RFC-064 §3.4 follow-up / …）。每一次都在修"该读哪个 counter / 该写哪个 counter 当水位 / cci 该 bump 到多少",没一次质疑**用标量 counter 模拟图级因果**这件事本身。RFC-070 已经在 clarify 老化这一支上证明了正解是"记因果行戳、不比 counter"——本 RFC 把同一结论落到节点数据流。

### 1.5 并发模型前提（决定本 RFC 复杂度）

`scheduler.ts:309-311` 的串行模型：`writeSem=1`（非 readonly agent 全任务级串行）+ JS 单事件循环 + SQLite WAL 串行 commit。对"写改动型节点链 + 下游 review"这条线，本 RFC 涉及的所有路径都是顺序执行，不存在两条路径同时写同一行的真并发。因此：

- provenance 记录在唯一的内容读取点（`resolveUpstreamInputs` / review sourceRun），单写者天然一致
- freshness 是**读时纯计算**，无需锁 / CAS

## 2. 目标 / 非目标

### 2.1 目标

- **G1**：freshness 判定从"cci 水位比大小"换成 provenance（consumed-upstream-run-ids）。一个 node_run 是 stale ⟺ 它消费的任一上游 run 不再是该上游节点当前最新的 done 行。
- **G2**：删 `cascadeDownstreamFromDesigner`（Layer A）+ `applyClarifyFreshnessInvariant`（Layer B）+ `isReviewClarifyAlignedWithUpstream`。staleness 改为调度器拓扑遍历时**读时计算**，无 speculative mint。
- **G3**：修复 §1.3 事故——provenance 是单一真相源，review 行记录它实际评审的 sourceRun id，approve 时必然 aligned，不再有"二次评审已批准内容"。
- **G4**：消除三-picker 不一致（§1.2）——"节点读哪行内容"与"freshness 认为哪行最新"统一到同一 picker。
- **G5（Phase 2）**：彻底退役 cci——`isFresherNodeRun` 改纯 ULID id 排序；删 cci-bump max+1 跨参与者机械；DROP `node_runs.clarify_iteration` 列；UI 的「第 N 轮」改由该节点 rerun 行序号派生。lifecycle invariant U1 的 cci 跨尺度比较迁到 RFC-070 consumed-by 戳。
- **G6**：保持 RFC-005 review 合同——**只要上游重新执行，到评审节点就要再评一次，不管之前是否通过**。

### 2.2 非目标

- **不改 review 节点用户契约**（`inputSource` / `rerunnable*` / `rollback*` 字段语义守恒）。
- **不动 RFC-070 clarify 老化的 consumed-by 戳逻辑**——那是 Q&A 行级溯源；本 RFC 是 node_run 级溯源，两者正交同构。Phase 2 让 lifecycleInvariants U1 复用 RFC-070 已有的戳，是收敛不是新增。
- **不改 cross-clarify / clarify rerun 的"mint 上游自身 pending 行"逻辑**——designer / questioner / 源 agent 自己那行 pending 仍由现有 trigger 路径 mint（那是上游侧）。本 RFC 删的是它们**之后**的下游 cascade / freshness 预 mint。
- **不引入 fan-out 分片级 provenance**——wrapper 当原子节点，只在 wrapper 边界记 consumed（决策 D3）。

## 3. 用户故事 / 验收标准

### 3.1 用户故事

**US-1（事故不再复现）**：review awaiting 期间后台跑过若干次 clarify rerun，我 approve 后任务即视为该 review 完成，绝不立刻弹出内容相同的二次评审。

**US-2（上游变了仍要再评 = 合同）**：approve 后上游又因 clarify rerun 产出新内容，review 节点应再开一次评审让我对新内容决策。本 RFC 修的是"approve 已批准内容立刻弹同份内容"，**不是**改变"上游变就再评"的合同。

**US-3（awaiting 期间看到最新内容）**：我在看 review 时上游变了，review 内容应更新到最新版本（mint v(n+1)、supersede 旧版本），我批准的永远是最新内容。

**US-4（多层 DAG 正确传播）**：A → review_R → B → O。A rerun done → R stale 重评；R 重批前 B/O 仍基于 R 最后一个 done 版本（不提前失效）；R 重批 → B stale 重跑 → O 重跑。每层按因果推进。

**US-5（daemon restart resume 不丢不乱）**：daemon 在某节点 done 之后崩溃重启，resume 时 freshness 从 DB 真相重算，stale 节点正确重跑、fresh 节点不重跑。

### 3.2 验收标准（AC）

**AC-1（provenance 不变式）**：任何 node_run `r`，迁移后满足 `∀[upId,consumedId]∈r.consumed: freshestDone(upId).id == consumedId 时 r 视为 fresh`；不存在"r 已 done 且 fresh，但 r 消费的上游 run 已非最新 done"的矛盾态。

**AC-2（事故场景）**：构造 `01KSHVXCH6RQ5F5P64MZ4FZVN6` 真实数据快照（cross-clarify 后 self-clarify 跑 3 轮、最后 approve v2），回放后 approve 后**无 18ms 内 mint 的新 awaiting_review 行**；review 节点最终 top-level row 数符合因果。

**AC-3（US-2 合同）**：approve 后上游再 rerun done → review 节点检出 stale（consumed 旧 ≠ 最新）→ 再开评审。

**AC-4（awaiting refresh）**：awaiting 期间上游 done 出新 run → review mint v(n+1)、v(n) decision='superseded'、v(n) 的 review_comments 作废；前端收到事件切到 v(n+1)。

**AC-5（多层 DAG 传播）**：US-4 链路逐层 stale → 重跑，每个 scheduler pass 推进一层；无 fixed-point mint。

**AC-6（无死行）**：迁移后 + 完整跑完，不存在"mint 了但从未 dispatch"的 pending 死行——行只在实际 dispatch 时 mint。

**AC-7（picker 统一）**：节点读内容的 picker 与 freshness 的 freshestDone picker 是同一个；`resolveUpstreamInputs` 选中的 run 即记入 consumed。

**AC-8（Phase 2 cci 退役）**：`clarifyIteration` / `clarify_iteration` 在 src/ + shared/ + frontend/ 共 0 命中；`node_runs.clarify_iteration` 列已 DROP；`isFresherNodeRun` 仅按 `(retryIndex, id)` 或纯 `id` 排序；UI「第 N 轮」由 row 序号派生且显示与迁移前一致。

**AC-9（crash recovery）**：构造"节点 setNodeRunStatus(done) commit 后进程 kill"，resume 后下游 freshness 从 DB 重算、正确推进。

**AC-10（向后兼容 / 迁移）**：历史 node_runs 无 consumed 字段 → 硬切，null consumed 视为 fresh（不触发重跑）；in-flight task 升级后不冒 spurious 评审。

**AC-11（grep guard）**：`cascadeDownstreamFromDesigner` / `applyClarifyFreshnessInvariant` / `isReviewClarifyAlignedWithUpstream` 在 src/ 0 命中；新增 `isNodeRunFresh` + consumed 记录点 grep 命中。

## 4. 风险 / 反对意见预案

### 4.1 "纯 id 排序真的总能选对最新行吗"（Phase 2 核心风险）

cci-first 排序的唯一理由是"clarify rerun 把 retryIndex 重置成 0 仍要赢过旧 process-retry 行"。而创建更晚的行 ULID id 必然更大——纯 id 排序天然满足。逐一核验各 mint 路径：clarify rerun / cross-clarify rerun / review iterate-reject / 单节点 retry / resume-after-interrupt 全部"创建更晚 = id 更大 = 应赢"。**但这是 hard 风险**，PR-A baseline 必须把 `isFresherNodeRun` 的现有行为逐 case 锁死，PR-C 切 id 排序后全绿才算等价。fan-out 子行 / aggregator 有 parentNodeRunId、被 top-level 过滤排除，不参与。

### 4.2 "cci-order 与 id-order 选出的 freshestDone 会不会不同导致 Phase 1→2 行为漂移"

不会。cci 在所有 mint 路径都随创建单调推进（higher cci ⟺ later created ⟺ higher id）；单节点 retry 不 bump cci 但 retryIndex+1 且 id 更大，两序仍一致。Phase 1（provenance + cci 仍排序）与 Phase 2（provenance + id 排序）选出的 freshestDone 是同一行，provenance 比较结果不变。

### 4.3 "多层传播没了 fixed-point 会不会漏拉齐"

不会。staleness 是读时计算，调度器**每个 batch 后已经 rescan DB**（`rescanScopeForNewPendingRows`）。把"freshness 重算"接进 rescan：一个节点的上游重新 done 后，该节点下个 rescan 即检出 stale → 落回 remaining → 拓扑 ready 后 dispatch。每 pass 推进一层，纯计算无 mint，终止性由"上游版本有限"保证 + safety cap。这正是 US-4 的正确逐层语义（R 重评期间不该提前失效 B/O）。

### 4.4 "全删 cci 波及 24 文件 × 3 package，回归面太大"

确实大。故 3 PR 强序（D7）：PR-A baseline 锁行为零生产改；PR-B 上 provenance + 删 cascade + 修 bug，**cci 列暂留只做排序，本 PR 独立可发**；PR-C 才退役 cci。真正的 bug fix 在 PR-B 落地，PR-C 是纯清理、可缓、出问题易定位（PR-B 稳定后再动）。

### 4.5 "为什么不只修 R2（reuse 同步 row.cci）"

只解决 §1.3 一个症状，留下三-picker 漂移（§1.2）+ 跨节点 counter 比较的 RFC-070 类 bug 潜伏 + 死行堆积。下次任何新 rerun 源复发。provenance 是把"哪个上游版本"从可撒谎的 counter 降级成行级身份记录，结构性关闭整片 bug 出口。

## 5. 范围概要

| 维度 | 变更 |
|---|---|
| Schema | PR-B 加 `node_runs.consumed_upstream_runs_json`；PR-C DROP `node_runs.clarify_iteration` |
| Migration | PR-B：历史行 consumed=null（硬切，null=fresh）；PR-C：12-step rebuild DROP cci 列 |
| 后端 freshness | 删 Layer A/B + review cci-alignment；新增 `isNodeRunFresh` 纯函数 + scheduler `completed` 收紧 + rescan 重算 |
| 后端记录点 | `resolveUpstreamInputs` 返回 consumed run-ids；review 记 sourceRun.id；落到新 node_run |
| 后端 review | awaiting 期间上游变 → mint v(n+1) + supersede v(n) + 作废 v(n) review_comments + broadcast |
| 后端 cci 退役（PR-C） | `isFresherNodeRun` 改 id 排序；删 cci-bump max+1 机械；lifecycleInvariants U1 迁 RFC-070 consumed-by 戳；24 文件清理 |
| shared（PR-C） | `NodeRunSchema` 删 cci 字段；ws / clarify schema 注释与字段清理 |
| 前端（PR-C） | 「第 N 轮」改 row 序号派生；NodeDetailDrawer / SessionTab / node-history / injected-memories-card / rfc026-events 去 cci |
| 前端（PR-B） | review supersede banner +「旧版批注已失效」提示 |
| 测试 | PR-A baseline ≥ 20（含 resolveUpstreamInputs picker baseline）；PR-B provenance + 事故 + review refresh + 多跳 demote + clarify-only + resume 幂等 ≥ 18；PR-C cci 退役 + 身份键替换 + grep guard ≥ 12 |

详细参 [design.md](./design.md) + [plan.md](./plan.md)。

## 6. 与既有 RFC 的关系

- **RFC-005**（review）：改 dispatch 内部实现，保留 approve-后上游变即再评的合同；修 reuse 不同步真相源的 bug。
- **RFC-056**（clarify-cross-agent）：删 §5.2 step 4 sibling cascade BFS，保留 designer/questioner rerun mint 上游自身。
- **RFC-064**（unified-clarify-runtime）：删 `applyClarifyFreshnessInvariant`（RFC-064 Layer B 实现）；Phase 2 退役 RFC-064 统一的 cci 列本身。
- **RFC-070**（clarify-consumed-by-run）：**同构同哲学的姊妹 RFC**。RFC-070 做 Q&A 行级溯源，本 RFC 做 node_run 级溯源。Phase 2 让 lifecycleInvariants U1 的 cci 跨尺度比较复用 RFC-070 已有 consumed-by 戳——两 RFC 在此收敛。
