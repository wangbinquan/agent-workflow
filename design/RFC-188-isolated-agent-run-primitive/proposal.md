# RFC-188 · 抽取「一次隔离 agent 执行」单原语（runIsolatedAgent）

状态：Draft（待 Codex 设计门 + 用户批准）
日期：2026-07-14
来源：调度执行架构全面审视（2026-07-14，五路并行深读 + 主线精读）

## 1. 背景

平台的执行基元层（`runNode` / `mintNodeRun` / `nodeIsolation` / `mergeAgent` /
lifecycle 三态机）已收口为单一实现，但把这些积木**串成一次完整隔离执行**的
「装配序列」——

```
prepareNodeRunInjection → globalSem.acquire → writeSem 内 createNodeIso
→ persistIsoBase → resolveFrozenRuntime → runNode
→ snapshotNodeIsoFinal → persistIsoNodeTree → writeSem 内 mergeBackNodeIso
→（冲突）resolveMergeConflicts → transitionMergeState → finally discardNodeIso + release
```

——被**手抄了 5 处**（scheduler.ts 内）：

| # | 站点 | 锚点（2026-07-14） | 备注 |
|---|------|----------|------|
| 1 | `runOneNode` agent 主线 | `scheduler.ts:2784-3595` | 含重试环、clarify 代际、review 上下文 |
| 2 | fanout shard | `scheduler.ts:4826-5031` | subprocessSem、shard 重放 undo |
| 3 | fanout aggregator | `scheduler.ts:5206-5406` | |
| 4 | workgroup `runHostNode` | `scheduler.ts:656-1013` | 头注释自认 "copied from the fanout-shard dispatch path" |
| 5 | wrapper（git/loop iso） | `scheduler.ts:5635-5707` | wrapper 侧已有 `mergeBackWrapperIso` 半收口 |

其中 node 级 merge-back 片段（`snapshotNodeIsoFinal → mergeBackNodeIso →
resolveMergeConflicts → mark-merged/park-conflict-human`）在 `runHostNode`、
`replayPendingMerges`、`runOneNode` §段③、`dispatchFanoutShard`、
`dispatchFanoutAggregator` 五处逐字排列，而 wrapper 版早已抽出共享
helper——「抽一次」只做了一半。

## 2. 问题（为什么现在做）

1. **漂移已成事实、且反复变成生产 bug**：RFC-184（host 输出投影 F42SE）、
   RFC-187 三探针（F3/§3-7/§4）全部是「workgroup 语义透过复制的装配序列泄漏」；
   RFC-186 前的工作组重试自建（绕开 `FOLLOWUP_POLICY`）直接造成「10 任务 0 done」。
   每次演进（merge_state 七值化、frozen runtime、RFC-187 §4-2 逐路径救回）都要
   人肉改 4-5 处，漏一处即静默漂移。
2. **workgroup 侧已知落后主线**：`runHostNode` 这份拷贝**没有**主线的同会话
   follow-up（`followupResumeSessionId` + iso 保留 D17）——工作组协议重试每次
   全新 mint + 全新 iso，**丢弃上一轮工作树写入**。抽原语后此差异要么显式
   参数化、要么消除。
3. **审视结论定级**：这是全仓「该抽未抽」头号目标（hotspot 备忘「freshest-run /
   端口推导」同类缝的调度侧对应物）。

## 3. 目标

- G1：新增单一原语 `runIsolatedAgent()`，收编上表 #1-#4 四个 agent 站点的装配
  序列（wrapper #5 的 iso 生命周期已走 `createOrRebuildWrapperIso`/
  `mergeBackWrapperIso`，仅将其 node 级片段对齐，不强并）。
- G2：**行为保持（byte-level 语义等价）**——本 RFC 是纯重构，五门 + 既有全部
  测试锁 + 真子进程 e2e 必须零改动通过（测试文件仅允许因导出符号搬家而改
  import）。
- G3：站点差异全部**显式参数化**（见 design §2 差异目录），不允许在原语内部
  留 if-workgroup 之类的隐式分支旗标（flag-audit 教训）。
- G4：源码级禁令收口：`createNodeIso` / `mergeBackNodeIso` /
  `resolveMergeConflicts` 在 scheduler.ts 的直接调用点只允许出现在原语与
  replay 两处（表级 allowlist 锁，禁文件级泛匹配）。

## 4. 非目标

- 不改重试语义（工作组是否补同会话 follow-up = 独立产品决策，本 RFC 只把
  差异变成显式参数，默认保持现状）。
- 不动 merge agent 的 writeSem 持锁语义（T5b 已拆独立 RFC——Codex P0-4
  两阶段 pin 方案，见 RFC-187 design §8）。
- 不动 wrapper resume-to-running 三连样板与 `markWrapperTerminal` 20 对广播
  配对（列为后续候选，见 plan §附录）。
- 不动 deriveFrontier / deriveWakeSet 两个调度大脑。

## 5. 用户故事

- 作为平台开发者，我给「一次隔离执行」加一个新阶段（例如快照校验），只改
  一个函数，四条执行路径同时受益，不再逐站点巡检。
- 作为 reviewer，我审 workgroup 的执行行为时，能从原语的参数表一眼看出它与
  主线的**全部**差异（今天要靠逐行 diff 两段 300+ 行的函数）。

## 6. 验收标准

- AC-1：`runIsolatedAgent` 落地，#1-#4 四站点全部改为调用原语；scheduler.ts
  内不再存在重复的装配序列（源级锁）。
- AC-2：全部既有测试（含 rfc130/rfc164/rfc185/rfc186/rfc187 真子进程 e2e）
  零语义改动通过；`bun run build:binary` smoke 通过（模块环备忘）。
- AC-3：差异目录（design §2）中每行差异在原语签名上可见（参数/回调），无
  隐式模式旗标。
- AC-4：新增原语单测覆盖：正常 / iso 失败 / runNode 失败 / merge 冲突可解 /
  冲突不可解 / discardWrites / persistDeclaredOutputs=false / 取消。
