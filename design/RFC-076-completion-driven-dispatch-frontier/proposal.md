# RFC-076 — 完成事件驱动的派发前沿（退役 batch 快照 + 边界对账补丁）

> 状态：Draft（等用户批准后进入实现）
> 关系：RFC-074（provenance freshness）的后续结构性重构；承接 RFC-074 follow-up「传递闭包派发门控」（commit `1af4f47`，本仓称 fix A）的 fix B。

## 1. 背景

`runScope`（`packages/backend/src/services/scheduler.ts:526`）当前是 **snapshot-batch + barrier + 事后对账** 模型：

1. 用内存里的 `completed` / `remaining` 集合，一次性算出当前 batch 的 `ready`（fix A 后为传递闭包 `computeReadyNodes`）。
2. `await Promise.all(ready.map(runOneNode))` —— **整批栅栏**，等所有节点跑完。
3. 批次结束后用两个补丁把内存集合**和 DB 真相重新对账**：
   - `rescanScopeForNewPendingRows`（`:989`）—— 把带外 mint 的新 `pending` 行（clarify / cross-clarify 答复触发）从 `completed` 拉回 `remaining`。
   - `recomputeFreshnessAndDemote`（`:939`）—— 把「上游已推进」的 stale-done 节点从 `completed` demote 回 `remaining`，**一跳 / 批**。

**根因家族**：调度状态（`completed` / `remaining` / `latestPerNode`）是**可变内存快照**，与 DB 里的 `node_runs` 真相**随时会漂移**——任何「带外写」（人答 clarify、cross-clarify 触发上游重跑、review iterate mint、daemon 重启重建）都会让快照过时，于是只能在 batch 边界用 `rescan` / `recompute` 去**事后追平**。这一模型已经累积出一整类同源 bug：

- **fix A（task 01KT1HDYV6RA8EJGY5BSE20MH9）**：上游 designer 带外重跑与孙节点 questioner 进了同一 batch，questioner 踩着 stale 评审批准抢跑；`recompute` 的 demote 排在 barrier 之后，晚于派发。
- **RFC-023 bug 13**（`:702-714` 注释）：人答 clarify mid-execution 后 mint 的 pending 行被内存快照漏掉，靠 `rescanScopeForNewPendingRows` 补救。
- **stall-guard rescan**（`:603-623`）：`ready` 空时再扫一遍 DB 才能解除「假死锁」。

fix A 把**派发判据**改成了传递闭包、堵住了正确性漏洞，但它仍活在这个 batch + 对账模型里——病灶（快照漂移 + 一跳/批的事后追平 + barrier）只是被又一道护栏挡住，没有被移除。

## 2. 目标

把 `runScope` 从「snapshot-batch + barrier + 事后对账」改为 **完成事件驱动 + 每 tick 从 DB 重导可派发前沿（dispatchable frontier）**：

1. **单一真相源**：每个调度 tick 直接从 `node_runs`（按 scope + iteration）重新派生 `completed`（latest 行 `done ∧ isNodeRunFresh`）与 `remaining`，不再维护可变内存快照。派发前沿 = 传递闭包就绪（复用 fix A 的 `computeReadyNodes` / `areTransitiveUpstreamsCompleted`）。
2. **完成事件驱动**：启动当前所有就绪且未在飞的节点，`await` **第一个完成的节点**（而非整批栅栏），完成后回到 tick 顶部重导前沿。无 batch barrier。
3. **退役两个对账补丁**：`rescanScopeForNewPendingRows` 与 `recomputeFreshnessAndDemote` 删除——带外 mint 由下一 tick 的 DB 重读**自然纳入**；多跳 demote 由「每 tick 重导 `completed`」**一次到位**（不再一跳/批）。
4. **退役 seed 与循环体的二元性**：当前 seed（`:540-578`）一次性建 `completed`，循环里再增量 mutate；B 把 seed 融进 tick——seed 即「第一次 tick 的 DB 派生」。

净效果：fix A 所在的那一整类「内存前沿漂移于 DB provenance」bug 从**结构上消失**，护栏（rescan / recompute / stall-guard 的双重扫描）随之删除而非堆叠。

## 3. 非目标

- **不改 freshness 语义**：`isNodeRunFresh` / `consumed_upstream_runs_json` / provenance 口径（RFC-074）原样保留；`computeReadyNodes` / `areTransitiveUpstreamsCompleted`（fix A）原样复用。
- **不改任何 mint 逻辑**：review awaiting refresh、clarify / cross-clarify rerun mint、review iterate、retry 谱系——全部不动（它们继续往 `node_runs` 写行，B 只改「读与派发」侧）。
- **不改 DB schema / 无 migration**：纯运行时重构。
- **不改 worktree / git / 进程隔离 / readonly 串并行 / retry 回滚 / cancel 语义**：写串行、readonly 并行、`pre_snapshot` 回滚、graceful cancel 全部保持。
- **不改 wrapper（git / loop）/ fanout 的语义**：它们经 `runScope` 递归（`:2132` / `:2999`）自动继承新模型；本 RFC 不碰 fanout 的分片 / 聚合逻辑本身。
- **零产品行为变更**：对用户可观察行为（任务状态机、评审/澄清时机、输出）必须**字节级等价**；这是一次内部调度重构，所有现有单测 / e2e 保持绿是硬验收。

## 4. 用户故事 / 行为不变量（B 必须保持，且更稳地保持）

- **US-1（fix A 合同）**：上游节点重跑后，其下游必须等到中间评审**重新通过**才派发——孙节点不得踩失效批准抢跑。B 通过「每 tick 从 DB 重导 + 传递闭包」保持，且不再依赖 barrier 后的 demote 时机。
- **US-2**：人答 clarify / cross-clarify 后 mint 的重跑行，必须在**下一调度动作**就被纳入，而非苦等当前 batch 里最慢节点跑完（barrier）才被 `rescan` 看见。
- **US-3**：同一 scope 内多个 readonly 节点并行、writer 串行的并发约束不变；慢节点不阻塞已就绪的其它分支进入飞行。
- **US-4**：daemon 重启后 resume 等价——因为前沿纯从 DB 派生，重启即「从当前 tick 重新派生」，无需特殊重建路径。
- **US-5**：`awaiting_human` / `awaiting_review` / `failed` / `canceled` 的冒泡优先级（canceled > awaiting_human > awaiting_review > failed > ok）与对用户的呈现不变。

## 5. 验收标准（详细 case 见 design §测试策略）

1. 抽出的纯函数 `deriveFrontier`（DB 行 + scope + upstreamsOf + iteration → `{completed, ready, awaiting, terminalOutcome}`）有穷举单测：带外 pending mint 即时纳入 / 多跳 stale 一次性 demote / settled-fresh / diamond / scope 边界 / 环防御。
2. fix A 的 incident（A→designer 重跑 → R→评审 → C→下游）在 mock-opencode 集成测试里复跑：C 必须等 R 重过才派发——且**不依赖 barrier 时机**（B 下 C 根本不会与 designer 重跑同 tick 就绪）。
3. `rescanScopeForNewPendingRows` 与 `recomputeFreshnessAndDemote` 被物理删除，grep 0 命中（源码守卫）；`Promise.all(ready.map(...))` 的 batch barrier 被「await 首个完成」取代（源码守卫）。
4. **全量回归绿**：`bun test`（backend 全量，排除既有环境失败）+ 前端 + Playwright e2e 全 4 shard ×2 OS 全绿；clarify / cross-clarify / review / loop / wrapper / fanout 既有套件零行为回归。
5. typecheck（3 包）+ lint + format 四件套绿；CI（含 e2e）全绿。

## 6. 澄清结论（经三轮 2026-06-02 评审定稿 → 裁决 = stage-slivers）

**最终裁决：stage-slivers**——PR-0(=T0 撕裂态,立即) + PR-A(纯函数 deriveFrontier,低风险) 可做；**PR-B(race 切换) 暂缓 Deferred**（理由:用户真实 bug 已被 fix A `scheduler.ts:606`/commit `1af4f47` 闭合,trim-B 不修在野 bug;三轮挖出的缺陷全在 PR-B 面、回归面宽且发散）。下方 trim-B 是 PR-B 真做时的骨架蓝本（否决 do-less/hybrid/novel）,**当前不实现 PR-B**。

**架构骨架（trim-B,PR-B 蓝本）**：保留 race + 删两对账 + 每-tick 派生；纠正过度删改（N1 failed/interrupted 可派发 / N2 wrapper carve-out / N3 dispatchedThisInvocation / HIGH-1 wrapper 迭代窗 / HIGH-2 无 exhausted / G1 事务非原子→写顺序）。

- **Q1 await 粒度** → **定：start-all-ready + await-any-completion**（US-3 最自然实现）。
- **Q2 `recompute`/`rescan` 去留** → **定：物理删除**（前提是 trim-B 谓词补齐）。每 tick 重导 `completed` 即一次性多跳 demote，强于旧一跳/批。
- **Q3 PR 拆分** → **定：2 PR 强序，PR-A 的 `deriveFrontier` 从第一版就是 trim-B 正确版**（含 N1 failed/interrupted 可派发 + N2 wrapper carve-out + N3 dispatchedThisInvocation），非同口径搬运。前置 **T0**：带外 mint 撕裂态修复（hoist await 出事务，**光包 `db.transaction` 无效**——bun:sqlite 同步事务首个 await 即 COMMIT，G1）。
- **Q4 DB 每 tick 重读** → **定：先不优化**；真正风险是撕裂态读一致性（R6），由 T0 解决，非开销。
- **G2 上线约束（新增硬约束）**：无 DB 迁移 / 无版本闸门 / daemon 重启不自动 resume → mid-flight 任务升级后 resume 即 100% 命中 N1，**N1/N2 修正不可分两次发布，PR-B 原子落地**。

> **两轮评审结论**：第一轮锁 C1-C4 + Gap1-8；第二轮**推翻第一轮对 C2/C3 的修法**——`isDispatchable` 排除 `failed`/`interrupted`/wrapper-`awaiting_*` 会击穿 resume/retry/daemon-restart（N1/N2），且「包事务」对 yielding body 无效（G1）；裁决 trim-B（N1 failed 可派发 + N2 wrapper carve-out + N3 per-invocation 去重）。全部并入 design.md。完整报告：`tasks/wepe4l768.output`（round1）+ `tasks/wm68qm7xf.output`（round2 trim-B/N1-N8/G1-G7）。
