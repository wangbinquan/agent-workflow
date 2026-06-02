# RFC-076 — 任务分解与 PR 拆分

## 裁决 = stage-slivers（PR-0 立即 / PR-A 低风险 / PR-B 暂缓）

> **三轮评审最终裁决：分期,不整体推 trim-B。** 依据：用户真实 bug 已被 **fix A**（`scheduler.ts:606`，commit `1af4f47`，CI 绿）闭合,trim-B 不修在野 bug、纯架构债清偿；三轮在 loop/fanout/exhausted/multi-repo 挖出的 3 high+5 med 缺陷**全在 PR-B 面**（回归面宽且发散）。PR-0+PR-A 收割了「可断言、零风险」的全部价值；PR-B 的边际收益（删两对账函数 + 内存标志的代码整洁）配不上其边际成本（5–8 天 + 这些缺陷的等价性验证）。

- **PR-0（=T0，立即可做，~1 天，纯收益）**：带外 mint 撕裂态修复（design §3.5）。**即使 PR-B 永不落地也该做**——撕裂窗今天 batch 模型下也存在。
- **PR-A（纯函数，~2 天，零行为变更、低风险）**：`deriveFrontier`+`wrapperHasFreshInnerWork` 纯函数 + 穷举单测；`runScope` 内部改调它,**对账补丁仍在、仍走 batch**。安全的概念债首付。**第一版即须含 HIGH-1（迭代窗）+ HIGH-2（无 exhausted）。**
- **PR-B（race 切换）：Deferred（不是 In Progress、不是 Done）**。go/no-go 触发条件：① 内存快照漂移再次产生在野 bug；或 ② 有富余 ~2 周做 resume/wrapper/fanout/commit&push 等价性验证。开做前须把下方 §2 八条缺陷全部回炉进 design + 复核完整 resumeTask 调用面（critique 指出报告调用面图不全:漏 clarify/reviews/lifecycleRepair 入口,虽结论"无后台自动 resume"侥幸正确）。**G2 约束仍成立**：无 DB 迁移/版本闸门、重启不自动 resume → mid-flight 任务升级后首次 resume 100% 命中 N1,故 PR-B 的 isDispatchable 修正不可分两次发布、必须原子落地。

## T0：带外 mint 撕裂态（前置，G1 修正——光包事务无效）
- **RFC-076-T0**：对 `submitClarifyAnswers`、`submitCrossClarifyAnswers`/`triggerDesignerRerun`、`createClarifySession`/`createCrossClarifySession`（**create 路径也要，N6**）：① 把 yielding 操作（`rollbackToSnapshot`/`getAgent`/非-DB select）**hoist 出事务体**，事务体内只留当 tick resolve 的 DB 写；② **先插 rerun pending、后 flip clarify→done**（belt-and-suspenders）。`review.ts:469` 作正面样板。验收：相关测试全绿；**mutation-guard（G1）= 事务体内留真 yield（`Bun.sleep`）+ yield 期间 fire deriveFrontier，断言不见 done-without-rerun**（不是「拆两 await」式 guard，那覆盖不到 in-body-await）。

## PR-A：trim-B 正确版 `deriveFrontier` + 单测
- **RFC-076-T1**：实现 `deriveFrontier(...) → Frontier`（design §3，**无 `Frontier.exhausted`、不返回 `kind:'exhausted'`,HIGH-2**）。含：`isDispatchable`（**failed/interrupted 返回 true**=resume 信号；exhausted/canceled/running/leaf-awaiting/done∧fresh 返回 false）+ wrapper carve-out 纯谓词 **`wrapperHasFreshInnerWork(wrapperRow, rows, definition)`——必须按 `decodeWrapperProgress(wrapperRow.wrapperProgressJson).iteration` 作 inner 扫描窗（loop 类）/ `wrapperRow.iteration`（git 类），禁止默认 `wrapperRow.iteration`（HIGH-1，否则 clarify-in-loop i≥1 resume 挂死）；递归展开嵌套 inner（G6）** + settles-without-row 加正向证据（N6）+ `dispatchedThisInvocation` 过滤（N3）。`latest=exhausted` 视为终态计入 allSettled（同 done）。纯模块。
- **RFC-076-T2**：`runScope` seed/ready 改调 `deriveFrontier`。验收：「新旧 ready/completed 对**非停泊、非无行叶子**节点一致」（停泊/叶子/failed 语义本就要改对）。
- **RFC-076-T3**：单测 `dispatch-frontier.test.ts`——**F-failed-retryable（failed/interrupted ∈ ready，N1）/ F-exhausted-settled（latest=exhausted ∉ ready 且 ∈ allSettled、runScope 返回 failed 不返回 exhausted，HIGH-2）/ F-park-wrapper-loop-iter≥1（wrapper 行 iteration0、inner pending 在 i≥1 → 经 progress.iteration 扫到 → ∈ready，HIGH-1）/ F-park-wrapper（inner 无 pending→停泊，N2）/ F-dispatched-dedup（N3）/ F-clarify-norow（C1）/ F-park-human·review·crossclarify（leaf C2）/ F-staledone / F-inflight / diamond·边界·环**。`wrapperHasFreshInnerWork` 单测含 nested git∋loop∋clarify + loop-in-git i≥1（G6/MED-5）。**删第一轮断言「failed∉ready」的 F-failed（锁的是 bug）**。
- **验收**：全量 backend + 前端 + e2e 绿；typecheck/lint/format 绿。

## PR-B：`runScope` 切完成事件驱动 + 退役补丁（**Deferred — 暂不实现，go/no-go 见上；下为真做时蓝本 + design-gate**）

**开做前必须先回炉进 design 的 8 条（round-3）**：HIGH-1 wrapper 迭代窗（已入 §3）/ HIGH-2 删 exhausted（已入 §3）/ HIGH-3 staged-demote 测试 triage（改注释留断言、grep 守卫限 `src/`）/ MED-4 fanout failed-resume 重 mint（幂等键去 parentRunId + aggregator 加 status+order）/ MED-5 loop-in-git i≥1（HIGH-1 同根因）/ MED-6 commit&push 内联 await 反噬 US-3（作独立 tracked promise 入 race，或显式声明 autoCommitPush 任务不兑现 US-3）/ MED-7 multi-repo acquireWrite span（提到 repo 循环外 acquire 一次）/ MED-8 I5 措辞与 N1 矛盾（改 design.md I5）。+ 复核完整 resumeTask 调用面（clarify/reviews/lifecycleRepair）。

- **RFC-076-T4**：重写 `runScope` 为 design §4 的 `inFlight` + `Promise.race` + `dispatchedThisInvocation`；终态由 `awaiting*/failed/allSettled` 派生（**无 exhausted**，HIGH-2；删内存标志 `:588-591`）；hoist scopeNodes/upstreamsOf once（N8）；0-progress 兜底（R5）。
- **RFC-076-T5**：物理删 `rescanScopeForNewPendingRows`（`:989`+调用 `:613`/`:713`）+ `recomputeFreshnessAndDemote`（`:939`+调用 `:617`/`:719`）+ barrier（`Promise.all(ready.map` `:657`）。
- **RFC-076-T6**：cancel 改「abort + 立即返回」（R7）；**SIGKILL 升级提为一等**（runner abort/timeout 后超时 `safeKill(SIGKILL)` `:1502` + process-group spawn，修 `:762/773` 仅 SIGTERM，N5）；commit&push **优选锁形**=writeSem 经 `acquireWrite` 回调只包 `add -A`+`diff --cached`（`:170-180`）、释放跑 msg-gen（N4，需扩 `CommitPushParams`）；fanout `dispatchFanoutShard`(`:2618`) 加 **per-shard 幂等 SELECT**（G3）；评估 commit&push 按 nodeRunId 去重（R8）。
- **RFC-076-T7**：集成（design §7，每条硬超时）——**I-resume-remint（runTask→fail→resume→retry_index=max+1+done，断言精确序列，N1/G5）/ I-clarify-resume-in-loop（wrapper-loop 内 clarify resume，N2）/ I-loop-guard（C1/C2）/ I2-concurrent（含前置子任务：给 mock-opencode 加 file-handshake barrier 原语 + 超时清理，G4）/ I-fanout-fail（shard 行不翻倍，G3）/ I-commit-quiescence（钉 add 瞬间被推迟，C4/G7）** + I1 fix A 级联 / I3 并发；保 `scheduler-rfc040-wrapper-await`/`resume-task-idempotent`/`scheduler-clarify-dispatch` 全绿为等价锚。
- **RFC-076-T8**：源码守卫——`rescan`/`recompute` grep 0 命中；`runScope` 含 `Promise.race(`、不含 `Promise.all(ready.map(`、调 `deriveFrontier(`；N7 锁序守卫（writeSem span 内无 `runNode(`/`globalSem.acquire(`、buildCommitAgent 保持 readonly）。**改（非加）** `scheduler-transitive-dispatch-gate.test.ts:183` 字面量锚；先跑 `grep -rln 'rescanScopeForNewPendingRows\|recomputeFreshnessAndDemote\|Promise.all(ready' tests/` 逐文件分类「文本守卫 vs 真断言」登记（L3）。
- **RFC-076-T9**：门禁 + CI（含 e2e 全 shard ×2 OS）全绿。
- **验收**：design §7 全部；**任何既有 clarify/cross-clarify/review/loop/fanout/resume/retry 测试或 e2e 变红 = 行为回归，停下排查，不放宽测试**。

## 依赖

- 依赖 fix A（`computeReadyNodes`/`areTransitiveUpstreamsCompleted` 在 `freshness.ts`，commit `1af4f47`）—— 已落地。
- 与并行 RFC-074 PR-C（lifecycle-repair 等）无源码重叠；working tree 有他人改动时只按路径 `git add` 本 RFC 文件。
- **G2 上线**：PR-B 原子落地（N1/N2 不可分两次发布）；建议上线前确认无后台自动-resume interrupted（核 `stuckTaskDetector`），或等任务 drain 到终态。

## 验收清单（push 前逐项过）

- [ ] T0：mint hoist-await + 重排，**mutation-guard（in-body yield 版）证明必要**
- [ ] `deriveFrontier` 单测全绿（**含 F-failed-retryable / F-exhausted / F-park-wrapper / F-dispatched-dedup** + C1/C2 锁 + wrapperHasFreshInnerWork nested）
- [ ] 集成全绿且无 hang：**I-resume-remint（retry_index 精确序列）/ I-clarify-resume-in-loop / I-loop-guard / I2-concurrent / I-fanout-fail（行不翻倍）/ I-commit-quiescence（add 瞬间）**
- [ ] `scheduler-rfc040-wrapper-await` / `resume-task-idempotent` / `scheduler-clarify-dispatch` 全绿（resume 等价锚）
- [ ] `rescan`/`recompute` grep 0 命中；既有源码守卫已**更新**；N7 锁序守卫在位
- [ ] 全量 backend 零新增失败（基线 8 env-fail 对拍）；前端 + e2e 全 shard ×2 OS 绿
- [ ] typecheck（3 包）+ lint + format 绿；CI 全绿；STATE + RFC 索引（Draft→Done）更新

## 估算

5–8 工作日（T0 mint hoist+重排 ~1 天；trim-B `deriveFrontier`+`wrapperHasFreshInnerWork` 递归+单测 2 天；`runScope` 切换 + SIGKILL + fanout 幂等 + commit&push 锁形 + mock-opencode barrier 原语 + resume/loop-guard 集成 + 等价性排查 2.5–4 天）。核心成本在**resume/retry/wrapper 等价性验证**（N1/N2，最易回归）+ **mock-opencode barrier 原语**（G4，真·新 harness）+ livelock 守卫（R5），不在代码量。比第一轮估算高，因 trim-B 的 resume 正确性面 + 测试基础设施被低估过。

## 单 PR 选项

若选内聚单 PR：按 T1→T9 顺序在一个 commit 落地，commit message `refactor(backend): RFC-076 — completion-driven dispatch frontier (retire batch snapshot + rescan/demote patches)`。代价：diff 大、回滚粒度粗。推荐仍走 2 PR。
