# RFC-188 · 技术设计

> **T1 修订（2026-07-15，实现期勘误——以此节为准）**：逐行核实四站点后，
> §1 原稿的 monolithic `runIsolatedAgent`（一次调用 = iso→runNode→merge）
> 被证伪——**主线的 iso 跨整个重试环共用一个**（`isoKeyRunId` 锚定原始行，
> D17：same-session follow-up 保留 iso，fresh-session 重试 discard+同 key
> 重建，`scheduler.ts:2806/2905-2915`），per-attempt iso 只是 shard/hook 的
> 形状。另两处目录勘误：② shard/aggregator 持 **globalSem+subprocessSem 双**
> 信号量（`:4862-4863/:5264-5265`，原表只记 subprocessSem）；③ merge 抛错
> 处置三态——主线/shard/agg 打 `mark-merge-failed`（D15 声明门），hook
> **不打**、留 pending-merge 走下次入口重放（`:1001-1004` catch-all；这带来
> 「assignment 已判 failed 但 delta 事后被 replay 落地」的潜伏语义，记档移交
> RFC-187 T8 属主决策，本 RFC 行为保持不改）。
>
> **收敛后的原语集**（G2 行为保持下 T1 证明安全的最大公约数）：
> 1. `mergeBackAndSettle` —— snapshot-final→persist-tree→writeSem 内
>    merge+冲突决议→merged/conflict-human 转移；replay 传持久树跳过快照；
>    git 错误**裸抛**（merge-failed 停留在站点 catch，见勘误③）。杀五份拷贝
>    （主线 §段③/shard/aggregator/runHostNode/replayPendingMerges）。
> 2. `createIsoUnderLock` —— writeSem 括起的 createNodeIso 窗口（5 处，含
>    主线重试重建）。
> 3. `persistIsoBase`/`persistIsoNodeTree` 自 scheduler 私有函数搬家为模块
>    导出（全站点+replay 共用）。
> 4. `markMergeFailed` —— 三站点 catch 里的 tryTransitionMergeState 四行。
>
> 原稿 §1 的 iso 生命周期括号（withIsolatedRun/keepIso/信号量注入）**本 PR
> 显式不做**：四站点在信号量集合、keepIso 有无、失败返回形态上差异过大，
> 强行参数化的回调 API 复杂度超过 ~25 行/站点的去重收益，且 finally 纪律
> 不是历次 bug 的来源（merge 块才是）。列入 plan 附录候选。原稿 §1/§2 保留
> 作历史（差异目录仍有效，按上面三处勘误订正）。

## 1. 原语契约

新模块 `packages/backend/src/services/isolatedAgentRun.ts`（不 import
scheduler.ts——沿用 hooks 同款单向依赖，防模块环；scheduler 把 state 里的
信号量/参数注入进来）：

```ts
export interface IsolatedAgentRunCtx {
  db: DbClient
  taskId: string
  appHome: string
  repos: CanonRepo[]                 // state.repos
  globalSem: Semaphore | null        // null = 调用方已持槽/自管（merge agent 直呼场景不经此原语）
  writeSem: TaskWriteSem             // per-task 注册表实例
  log: Logger
  signal?: AbortSignal
  opencodeCmd?: string[]
  defaultRuntime: RuntimeRef
  subagentLiveCapture?: SubagentLiveCapture
}

export interface IsolatedAgentRunReq {
  nodeRunId: string                  // 调用方已 mint（mint 语义留在站点——cause/retryIndex 差异大）
  nodeId: string
  agent: Agent                       // 已投影（hostOutputPorts 的投影责任在调用方，见 §2）
  promptTemplate: string
  inputs: Record<string, string>
  templateMeta: TemplateMeta
  runtime: FrozenRuntimeReq          // resolveFrozenRuntime 入参（原语内部执行冻结）
  injection: PreparedInjection       // prepareNodeRunInjection 结果（站点可能想先失败快照，故入参）
  // —— 差异参数（§2 目录逐行对应）——
  clarify?: ClarifyWiring            // channel/directive/suppressed/context；undefined = 无 clarify 面
  persistDeclaredOutputs?: boolean   // RFC-184，默认 true
  discardWrites?: boolean            // RFC-167 生成 run，默认 false
  timeoutMs?: number
  workgroupProtocolBlock?: string
  promptMode?: PromptMode            // 主线同会话 follow-up 携带；其余站点 undefined
  preRun?: (iso: IsoHandle) => Promise<void>   // shard 重放 undo（undoPriorShardDeltaInIso）挂点
  semaphore?: Semaphore              // 覆盖 globalSem（fanout shard 用 subprocessSem）
}

export interface IsolatedAgentRunOutcome {
  kind: 'done' | 'failed' | 'canceled' | 'clarify'
  outputs: Record<string, string>
  errorMessage?: string
  failureCode?: FailureCode
  clarify?: RunClarifyResult
  sessionId?: string | null
  mergeState: 'merged' | 'conflict-human' | 'abandoned' | null
  salvagedPaths?: string[]           // RFC-187 §4-2 透传
}
```

原语内部固定序列（与今日 #1-#4 一致）：

1. `sem.acquire()`（`semaphore ?? globalSem`；null 则跳过——保留 merge agent
   直呼 runNode 不进原语的 §7 死锁豁免）。
2. `writeSem.run(() => createNodeIso(...))` + `persistIsoBase`。
3. `preRun?.(iso)`（shard undo 挂点，锁外——D9 契约「只碰私有 iso」）。
4. `resolveFrozenRuntime`。
5. `runNode(...)`（携全部差异参数）。
6. 终态分派：canceled/clarify/failed 直接归一化返回（clarify 的 session 建立
   **留在调用方**——leader/member 的 shardKey 代际差异属站点语义，见 §2）。
7. done：`discardWrites` ⇒ `tryTransitionMergeState(abandon)`；否则
   `snapshotNodeIsoFinal → persistIsoNodeTree → writeSem 内 mergeBackNodeIso
   →（冲突）conflictResolver 回调 → transitionMergeState`。
8. finally：`discardNodeIso` + release。

冲突解决以回调注入（`conflictResolver: (conflicts, containerPath) =>
Promise<{allResolved, detail}>`）——实现仍是 scheduler 的
`resolveMergeConflicts`（它要 mint 子 run + 直呼 runNode 绕 globalSem，属
调度侧机制），原语不吸收它，只编排调用时机与 merge_state 转移。

## 2. 站点差异目录（G3 的正文）

| 差异 | runOneNode 主线 | fanout shard | aggregator | runHostNode |
|---|---|---|---|---|
| 信号量 | globalSem | subprocessSem | globalSem | globalSem |
| mint/cause/retryIndex | 站点自管（重试环内） | 站点自管 | 站点自管 | 站点自管 |
| 重试环归属 | 站点（`maxRetries` + followup 决策 + 同会话 resume + iso 保留 D17） | 站点 | 站点 | 站点（`WG_PROTOCOL_RETRIES` 全新 mint） |
| promptMode（同会话 follow-up） | ✅ | ❌ | ❌ | ❌（差异显式化后待产品决策，非本 RFC） |
| clarify 接线 | mandatory/optional/stopped 全谱 | 分片自愿 | ❌ | delegated + 活 oracle + lateSuppress |
| hostOutputPorts 投影 | ❌ | ❌ | ❌ | ✅（投影发生在调用方，原语收 `agent` 已投影版） |
| persistDeclaredOutputs | true | true | true | false（RFC-184） |
| discardWrites | ❌ | ❌ | ❌ | dw 生成 run ✅ |
| preRun undo | ❌ | ✅ D9 | ❌ | ❌ |
| 冲突解决 | resolveMergeConflicts | 同 | 同 | 同 |

「重试环留在站点」是本设计最重要的边界决策：四个站点的重试语义（预算、
同会话 vs 全新、errorNotice 组装）差异大且各有 RFC 锁定；原语只保证「单次
attempt 的装配序列」一份。这样收编后每个站点体量降到 ~50-100 行纯语义代码。

## 3. replayPendingMerges 的处理

replay 没有「执行」阶段（agent 不重跑），只消费序列的 merge-back 后半段。
把后半段独立成第二个导出 `mergeBackAndSettle(ctx, {handle, nodeTrees,
conflictResolver, via})`，原语 §7 与 replay 共用它——五份 merge-back 拷贝
就地消失（这是 wrapper 侧 `mergeBackWrapperIso` 模式在 node 侧的补全）。

## 4. 失败模式

- 原语内任何 throw：与今日一致——各站点的 catch 语义不变（主线落 failed 行、
  runHostNode 返回 failed 结果、shard 记 shard 失败）。原语不吞错。
- 崩溃窗口：与今日逐字节相同（同一序列、同一持锁窗口），pending-merge /
  conflict-human 重放路径不变。
- abort：runNode 内部已消费 signal；原语在 acquire 前加一次快速 aborted 检查
  （与主线现状一致）。

## 5. 与在途/近期 RFC 的耦合

- **RFC-187 §4-2（salvage）**：已在 `mergeBackNodeIso` 内部，原语透传
  `salvagedPaths`，无耦合。
- **T5b 独立 RFC（merge agent 出 writeSem，两阶段 pin）**：本 RFC 落地后
  T5b 只需改 `mergeBackAndSettle` 一处的锁编排——这正是先抽原语的价值；
  两 RFC 顺序 = 188 先行。
- **RFC-189（轮/重试拆分）**：正交（mint 语义留在站点）。

## 6. 测试策略

1. **零语义改动门**：全量既有 backend 套件 + 三条工作组真子进程 e2e +
   `build:binary` smoke 必须不改断言通过（import 路径搬家除外，逐个列在 PR
   描述）。
2. **原语单测**（新 `isolated-agent-run.test.ts`，真临时 git 仓 + mock
   runNode 注入）：AC-4 八分支。
3. **源级锁**（表级 allowlist，禁文件级）：`scheduler.ts` 中
   `createNodeIso(`/`mergeBackNodeIso(` 出现次数 = 原语/replay 允许清单；
   `runHostNode` 体内不得再出现 `resolveFrozenRuntime(`。
4. **行为抽样对照**：迁移前后各跑一次 rfc185 fan-out 端到端（3 单并发）与
   rfc130 crash-replay，断言 node_runs/merge_state 序列逐行相等（golden
   dump 对比，防「测试都过但顺序变了」）。

## 7. 风险

| 风险 | 等级 | 缓解 |
|---|---|---|
| 收编时抄漏某站点一行差异（如 shard 的 pinRef 时机） | 高 | §2 目录先行成文 + 迁移一站点一 commit + golden dump 对照 |
| 锁窗口意外变化（writeSem 内代码增减） | 高 | 原语内锁窗口代码与现拷贝逐字节对齐；rfc098 写锁测试 + 时序断言 |
| 模块环（scheduler ↔ 新模块） | 中 | 新模块零 scheduler import；`build:binary` smoke 必跑（RFC-079 备忘） |
| 与并发 session 的 RFC-187 PR-3 撞文件 | 中 | 实现窗口协调：等 PR-3 余项落定后开工（plan §依赖） |
