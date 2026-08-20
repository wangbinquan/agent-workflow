# RFC-313 技术设计 — 信封重试的会话升级

## 1. 现状锚点（改动前必须成立的事实）

| 事实                                                         | 锚点                                                                                                                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 信封类失败的判定与 `failureCode` 落库                        | `services/runner.ts:1999`（`envelope-missing`）、`:2041`（`envelope-port-malformed`）、`services/envelope.ts:407`（`detectEnvelopeKind`）                                      |
| 哪些失败码可接续                                             | `shared/src/prompt.ts:1189` `FOLLOWUP_POLICY` + `:1209` `followupPolicyForFailure`                                                                                             |
| RFC-042 五条判据                                             | `services/scheduler.ts:1659` `decideEnvelopeFollowup`                                                                                                                          |
| 哪些失败码根本不重试                                         | `services/scheduler.ts:1675` `shouldRetryNodeFailure`（`runtime-result-error` / `processUnreaped`）                                                                            |
| 重试预算                                                     | `services/scheduler.ts:5716` `opts.defaultNodeRetries ?? DEFAULT_PROTOCOL_RETRY_BUDGET`（`shared/src/prompt.ts:1232`，值 3）                                                   |
| attempt 循环骨架（模式 B：一次许可 + 一棵 iso 跨多次 spawn） | `services/schedulerAssembly.ts:205-240`                                                                                                                                        |
| **每轮重试的调用序是契约**（rfc287-t2 钉死）                 | `services/schedulerAssembly.ts:118-126`：`shouldRetry → preAttempt →〔抢占则收场〕→ keepIf →〔不留树时 discardIso + iso.create〕→ onNextAttempt → spawn`                       |
| agent 线三个 hook 的现状实现                                 | `services/scheduler.ts:6556`（`shouldRetry`）、`:6563`（`isoOnRetry.keepIf` = `decideFollowupForRetry`，`:5836`）、`:6584`（`onNextAttempt` = `prepareRetryAttempt`，`:5879`） |
| 接续时的 prompt / 会话 / nonce 处置                          | `services/runner.ts:826-830`（短提示 vs 完整 prompt）、`:935`（resume 槽）、`services/scheduler.ts:5906`（followup 时才把 nonce 抄到新行）                                     |
| 接续时跳过记忆注入与清单                                     | `services/runner.ts:660-663`（`followupMode === undefined` 才注入）、`:653`（`freshAgentRun`）                                                                                 |
| 会话 resume 的落地形态                                       | `services/runtime/opencode/spawn.ts:115-116`（`--session`）、`services/runtime/claudeCode/spawn.ts:220-221`（`--resume`）                                                      |
| 对照线：workgroup 每次 fresh + notice + 双预算               | `services/workgroup/turnExecution.ts:263-292`                                                                                                                                  |

## 2. 目标模型

### 2.1 两个参数、一个公式

```
followupBudget = config.defaultNodeRetries            （默认 3，语义不变：同一会话内最多追问几次）
restartBudget  = config.sessionRestartBudget          （新增，默认 1）

单次 dispatch 的 attempt 硬上限
  totalCap = (1 + followupBudget) × (1 + restartBudget)
  默认      (1 + 3) × (1 + 1) = 8
  关闭时    (1 + 3) × (1 + 0) = 4   ← 逐字等于本 RFC 落地前
```

`shouldRetry` 里的 `maxRetries` 由常量改为 `totalCap - 1`。**这是 attempt 数量的唯一权威**；`followupBudget` / `restartBudget` 决定的是每一次重试**长什么形状**，而不是还能不能再来一次。

**必须点明的后果**：上限是**乘积、与失败种类无关**。升级预算只在真的发生主动升级时被消耗（崩溃不吃它，AC-6），但一个每次都崩溃、因而永远走不到升级的节点，attempt 上限同样从 `1+F` 变成 `(1+F)×(1+R)`——默认即 4→8。这正是 `proposal.md` 成本表里那一行的完整含义。

考虑过、**否决**了「只在真的升级时才追加预算」的动态形式（`k < F + restartsUsed×(1+F)`）：它的意图更贴合本 RFC 的论证，但骨架的调用序是 `shouldRetry`（同步、无 DB）先于 `keepIf`（异步、做形状判定），于是动态式必须靠「链已触顶且尚有升级预算」这类**对下一次判定的预测**来放行，边界行为随即变得反直觉——早期的一次崩溃会从后续接续链的额度里扣走一格（`k` 是全局序号），而改成按会话计数又会让「每次崩溃都重置」退化成无界自旋。一个乘积上限、一处权威，是这里更诚实的取舍。

### 2.2 三态判定（纯函数）

新增一个纯函数，与 `FOLLOWUP_POLICY` 同族放在 `shared/src/prompt.ts`：

```ts
export interface RetryShapeState {
  /** 当前 runtime 会话内已连续发生的接续次数 */
  followupChainLen: number
  /** 已用掉的主动升级次数 */
  restartsUsed: number
}

export type RetryShape =
  | { kind: 'followup'; reason: EnvelopeFollowupReason; failures: PortValidationFailure[] }
  | { kind: 'restart'; reason: EnvelopeFollowupReason }
  | { kind: 'fresh' }

export function decideRetryShape(input: {
  /** RFC-042 既有判定的结果，原样传入——本函数不重新实现那五条判据 */
  followup: EnvelopeFollowupDecision
  state: RetryShapeState
  followupBudget: number
  restartBudget: number
}): { shape: RetryShape; next: RetryShapeState }
```

判定表：

| 输入                                                                                      | shape                  | 树       | 会话     | nonce    | prompt                    | 状态迁移                                |
| ----------------------------------------------------------------------------------------- | ---------------------- | -------- | -------- | -------- | ------------------------- | --------------------------------------- |
| RFC-042 判据全中，且 `followupChainLen < followupBudget`                                  | `followup`             | **留用** | 复用     | 复用     | 短纠错提示                | `chainLen += 1`                         |
| RFC-042 判据全中，`followupChainLen >= followupBudget`，且 `restartsUsed < restartBudget` | `restart`              | 丢弃重建 | **全新** | **新铸** | 完整 prompt + 告知        | `chainLen = 0`、`restartsUsed += 1`     |
| RFC-042 判据落空（崩溃 / 无 session / 无 text / 失败码不在表内）                          | `fresh`                | 丢弃重建 | 全新     | 新铸     | 完整 prompt（**无告知**） | `chainLen = 0`、`restartsUsed` **不变** |
| 判据全中、链触顶、且 `restartsUsed >= restartBudget`                                      | `followup`（防御分支） | 留用     | 复用     | 复用     | 短纠错提示                | `chainLen += 1`                         |

**最后一行的理由**：该状态在硬顶下**不可达**——要到达它至少需要 `(1+F)·R + 1 + F = (1+F)(R+1) = totalCap` 次 attempt，而第 `totalCap` 次的重试判定早已被 `shouldRetry` 拒掉（崩溃只会让它更不可达，因为崩溃消耗 attempt 却不消耗重启预算）。既然不可达，防御分支的取值就以「**绝不静默发放无预算的重启**」为准绳：退回接续（今天的行为）是安全的，而退回 `fresh` 会白送一次不计账的换树换会话。这条分支必须有测试直接构造（绕过硬顶）并断言它退回接续。

**`fresh` 不带告知**是刻意的：崩溃 / 超时 / 无输出的场景里，「上一轮协议失败」这个事实并不成立（模型可能一个字都没产出），告知它反而是误导。告知只属于**主动升级**。

## 3. 契约变更

### 3.1 shared（`packages/shared/src`）

| 变更                                                                                                                                                            | 位置                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 新增 `DEFAULT_SESSION_RESTART_BUDGET = 1`，注释说明它与 `DEFAULT_PROTOCOL_RETRY_BUDGET` 的关系与 §2.1 公式                                                      | `prompt.ts`（紧邻 `:1232`）           |
| 新增 `RetryShapeState` / `RetryShape` / `decideRetryShape`（§2.2）                                                                                              | `prompt.ts`（紧邻 `FOLLOWUP_POLICY`） |
| 新增 `renderSessionRestartNotice(reason: EnvelopeFollowupReason): string`                                                                                       | `prompt.ts`                           |
| `RenderPromptInput` 新增可选 `priorSessionAbandoned?: { reason: EnvelopeFollowupReason }`                                                                       | `prompt.ts:459` 的入参接口            |
| `renderUserPrompt` 在**协议块之后**追加告知段（仅当该字段存在）                                                                                                 | `prompt.ts:459`                       |
| `AppConfig` 新增 `sessionRestartBudget: z.number().int().nonnegative()`，默认 1，`SettingsPatch` 加 `boundedSettingsInteger('sessionRestartBudget').optional()` | `schemas/config.ts:197 / 695 / 776`   |
| 数值边界 `sessionRestartBudget: { min: 0, max: 10 }`                                                                                                            | `settingsNumericBounds.ts:37` 同表    |

告知文案（按 reason 定制，与 `renderEnvelopeFollowupPrompt` 的开场白同源但**不复用**——那份是「在同一个会话里改错」，这份是「新会话，别重蹈覆辙」）。示例（`envelope-missing`）：

```
---
**Note on a previous attempt.** An earlier session was given this exact task and
repeatedly failed to end its reply with the `<workflow-output>` envelope described
above, so it was abandoned and you are starting fresh. Do the work, then close with
the envelope — that closing block is what the framework reads; without it the work
is discarded.
```

文案为框架常量、无用户可控插值，因此不经 `fenceUntrusted`；测试断言其中不含任何来自上一次 attempt 的字节（防止有人日后把 `errorMessage` 拼进来——机器读 `errorMessage` 是 RFC-145 明令禁止的）。

### 3.2 backend 配置管道

`sessionRestartBudget` 沿 `defaultNodeRetries` 的**同一条**管道透传，逐点补齐即可，无新增形状：
`services/launchRuntimeConfig.ts:85 / 112 / 166` → `services/task.ts:469-473 / 1188 / 1260` → `services/fusion.ts:101 / 637 / 1596` → `routes/fusions.ts:40-47` → `services/scheduler.ts:332-335`（`SchedulerOpts`）与 `:441`（键白名单）。

### 3.3 scheduler（`services/scheduler.ts`）

```ts
// 5716 附近
const followupBudget = opts.defaultNodeRetries ?? DEFAULT_PROTOCOL_RETRY_BUDGET
const restartBudget = opts.sessionRestartBudget ?? DEFAULT_SESSION_RESTART_BUDGET
const maxRetries = (1 + followupBudget) * (1 + restartBudget) - 1 // shouldRetry 唯一权威

// 5820 附近新增两个闭包量（与 followupDecision / followupResumeSessionId 并列）
let retryShapeState: RetryShapeState = { followupChainLen: 0, restartsUsed: 0 }
let pendingRestartReason: EnvelopeFollowupReason | undefined
```

`decideFollowupForRetry`（`:5836`）改为：算出既有的 `EnvelopeFollowupDecision` 后交给 `decideRetryShape`，按 shape 落三件事——设置 `followupDecision` / `followupResumeSessionId`（仅 `followup`）、设置 `pendingRestartReason`（仅 `restart`）、返回「是否留树」（仅 `followup` 为真）。**函数签名与返回语义不变**（仍是 `keepIf` 要的 `Promise<boolean>`），骨架的调用序契约因此原样成立。

`prepareRetryAttempt`（`:5879`）在既有 `[rfc042/envelope-followup]` 事件分支旁增加一支：`pendingRestartReason !== undefined` 时写 `[rfc313/session-restart]`，payload `{ rfc: 'RFC-313', reason, abandonedAfterFollowups, restartsUsed, retryAttempt }`（第三个字段记的是**放弃那个会话时的实际链长**——升级的触发条件就是链长追平预算，判定后链计数已归零、事后读不到，故按事实取名）。**新行的 `cause` 仍是 `process-retry`**（用户拍板，见 §5.2 为什么这也是更安全的选择）。既有的「followup 时才把 `envelopeNonce` 抄到新行」（`:5906`）无需改动——`restart` 的 `followupDecision.followup` 为 false，于是自动铸新 nonce。

`runOneAttempt` 只**读** `pendingRestartReason` 并透进 `runNode` 入参。**实现期改进**：让 `decideFollowupForRetry`（即 `keepIf`）成为它的**唯一写者**——每轮开头无条件复位、再按形状赋值。原设计的「读走即清」在 spawn 侧留了一个写点，一旦某轮提前返回就会把上一轮的告知漏进下一轮；单写者从结构上消掉了这个窗口。

### 3.4 runner（`services/runner.ts`）

`RunNodeOpts` 新增可选 `priorSessionAbandonedReason?: EnvelopeFollowupReason`；在 `:864` 的 `renderUserPrompt` 入参里透传成 `priorSessionAbandoned`。**仅此一处**——短提示分支（`followupMode !== undefined`）永远不带它，且两者在 scheduler 侧互斥（`restart` ⇒ `followupDecision.followup === false` ⇒ 不进 followup 分支）。

## 4. 时序（默认配置、纯信封失败场景）

```
k(retry 序) 0      1      2      3          4      5      6      7
attempt     0  →   1  →   2  →   3     →    4  →   5  →   6  →   7        (8 次封顶)
形状        —   接续   接续   接续    升级    接续   接续   接续
会话        A ─────────────────────┘   B ─────────────────────────┘
iso 树      T1 ────────────────────┘   T2 ────────────────────────┘
nonce       N1 ────────────────────┘   N2 ────────────────────────┘
prompt      全   短     短     短    全+告知   短     短     短
记忆/清单   注入  跳过   跳过   跳过   重新注入  跳过   跳过   跳过
chainLen    0    1      2      3      0        1      2      3
restarts    0    0      0      0      1        1      1      1
                                                                  ↓ shouldRetry(7): 7 < 7 false
                                                                  节点 failed
```

`restartBudget = 0` 时该表在 attempt 3 后即止（`maxRetries = 3`），逐格等于今天。

## 5. 与既有机制的交互

### 5.1 RFC-122 `clarifyModeFlip`（`scheduler.ts:6409` 附近）

> **实现门 P1-1 修正（2026-08-20）**：下面这段原判断**漏了一个时序**。`clarifyModeFlip`
> 是在 `runOneAttempt`（spawn）里算的，而升级决策在 `keepIf` 里、**跑在它之前**；链长恰好
> 触顶时升级会先把 `followupDecision` 收回成 false，而 flip 的定义正是
> `followupDecision.followup && …`，于是用户的一次正常 STOP 翻转被执行成升级——丢树 +
> 扣升级预算，正是 AC-8 禁止的。**修法**：`keepIf` 里读一次 `getNodeClarifyDirectiveRow`
> 并与上一次 attempt 观察到的开关值比对；有待处理翻转就把 `suppressRestart` 传给
> `decideRetryShape`，本轮按 `followup` 记账（保树、预算一格未动），升级顺延一轮。
> 判据用「开关变了」而不是重导一遍 `effectiveHasClarifyChannel`——**仓内既有不变量**
> 明写「retry 循环内只有 nodeStopOverride 逐 attempt 变化，所以翻转 ⟺ 开关变化」
> （`scheduler.ts:5822` 注释），复制第二处导出必然漂移。
> STOP 开关翻转会让接续走完整 `renderUserPrompt`，但它**保树、且 `followupDecision.followup` 仍为 true**（`keepIf` 在它之前就返回了 true）。因此 flip **不是**升级：不丢树、不消耗 `restartBudget`、不带告知、`chainLen` 照常 +1。**实现期核实**：本 RFC 对翻转路径是恒等变换（只在 `followupDecision.followup` 为 false 时改变行为），既有 RFC-122 套件即回归锁，见 §8 第 11 条的裁决。

### 5.2 RFC-026 inline clarify resume（`scheduler.ts:6065`）

`decideResumeSessionId` 只在 `isClarifyRerun` 为真时给出 session，而重试行一律 `cause='process-retry'`、不在 gate-2 集合内（`runner.ts:6300` 附近的注释已明写这一不变量）。所以升级那一次的 `effectiveResumeSessionId` 会落到 `undefined` —— **确实是全新会话**。这正是「沿用 `process-retry` 而不新铸 cause」在安全上更优的原因：新增 cause 就得重新论证它是否落进 gate-2 集合，否则可能意外把一个 clarify 会话 resume 进本该干净的重启里。AC-2 用「spawn 参数里无 resume」直接断言这条，不靠推理。

### 5.3 `shouldRetryNodeFailure`（`scheduler.ts:1675`）

`runtime-result-error` 与 `processUnreaped` 在 `shouldRetry` 里就被拒，压根到不了形状判定。语义不变，既有测试保持绿。

### 5.4 崩溃 / 超时

`exitCode !== 0` ⇒ RFC-042 判据落空 ⇒ `fresh` ⇒ 链归零、重启预算不动。这是 AC-6，也是「崩溃不该吃掉聪明重启的机会」这条产品判断的落点。

### 5.5 fanout 分片与 loop

**实现期核实修正**：fanout 的分片与聚合器**不走 agent 线的 attempt 循环**——它们各有一个独立重试循环（`scheduler.ts` `dispatchFanoutShard` / `dispatchFanoutAggregator`），且其文档注释明写 _fanout retries use fresh sessions_，即本来就没有同会话接续，已经是本模型下 `followupBudget = 0` 的退化形态。因此本 RFC **不改动它们**（预算仍单读 `defaultNodeRetries`）。fail-all-after-join 与 loop 触顶语义不变。

### 5.6 `retryNode` 人工重试 / daemon 重启

两者都会重新进入 `runOneNode`，闭包状态自然从零开始——与今天 attempt 计数的语义一致（`retryIndex` 仍持久化并单调递增，8 次 attempt 的 `retry_index` 为 0..7）。**本 RFC 不持久化链长与重启数**：它们只在一次 dispatch 内有意义。

### 5.7 记忆注入 / 清单 / prompt 落盘

均由 `followupMode === undefined` 驱动，升级天然走「重新注入 + 重新物化清单」。零改动。

### 5.8 其它四条线

script（`scheduler.ts:4679`，每次换新树）、workgroup（`turnExecution.ts`，每次 fresh turn + notice）、intent（无 resume、无自动重试）、dw（`DW_MAX_GENERATE_ATTEMPTS`，每次 fresh + notice）——在本模型下均为 `followupBudget = 0` 的退化形态，天然满足。本 RFC 只在共享常量族的注释里写清这层对应关系，**不改它们的代码**（G5 / AC-11）。

## 6. 失败模式

| 失败                                                              | 表现                                                      | 处置                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 升级时 iso 重建失败                                               | `onIsoRecreateFailure`（`scheduler.ts:6565`）已有分支     | 沿用：`iso-recreate-failed` 收场，不新增路径                                                                                                                                                                                                                                                                                                                                                                           |
| 配置给出荒谬值（如 `defaultNodeRetries=50` + `restartBudget=10`） | 乘积 561 远超骨架的 `ASSEMBLY_MAX_ATTEMPTS`（=100）保险丝 | **实现修正**：仅把 `sessionRestartBudget` 上限收在 10 **不足以**挡住（51×11 仍是 561）。因此 `retryAttemptCap` 自身钳到新增的 `RETRY_ATTEMPT_CAP_CEILING`（=64），使该函数成为全函数、任何配置组合都产不出能触发保险丝的上限——保险丝的报错写的是「spec bug」，用它接住一个**配置选择**只会把运维引到错误方向。两常量的大小关系由 `rfc313-session-escalation.test.ts` 直接断言（为此 `ASSEMBLY_MAX_ATTEMPTS` 改为导出） |
| 升级后模型仍不吐信封                                              | 走完会话 B 的接续预算后 `shouldRetry` 拒绝                | 节点 `failed`，`errorMessage` 保持现状语义（人类可读；机器读被 RFC-145 源码守卫禁止）                                                                                                                                                                                                                                                                                                                                  |
| 状态被误改（链长/重启数在某处被重置）                             | 形状判定失真                                              | 纯函数 + `next` 状态返回，调用点只做赋值；单测覆盖状态迁移矩阵                                                                                                                                                                                                                                                                                                                                                         |

## 7. RFC-294 目标架构对齐

- **落位**：`task-execution` bounded context（RFC-294 `proposal.md:134`）的 **NodeExecutor** 层（`:164`）——本 RFC 改的是 agent kind 执行器的重试形状，不触碰 TaskEngine / WrapperRuntime / ExecutionKernel 的边界。
- **本 RFC 承担的演进**：把「重试形状」这条**纯策略**从 `scheduler.ts` 的命令式闭包里**抽成无副作用的纯函数**，放进已被 agent 线与 workgroup 线共读的 policy 家族（`shared/src/prompt.ts` 里 `FOLLOWUP_POLICY` / `followupPolicyForFailure` / `DEFAULT_PROTOCOL_RETRY_BUDGET` 所在处）。这与 RFC-186 当年把 workgroup 的重试判定统一到同一张表是同一个方向：**判据单源、状态留在执行器**。
- **留下的债**：状态适配（两个闭包量 + 三个 hook 的接线）仍寄居在 8000 行的 `scheduler.ts` 里。本 RFC **不做**文件拆分——共享树上大挪移会撞车，且拆分应随 RFC-294 把 NodeExecutor 正式切出来的那一波统一做。此处显式记账，不假装已经对齐。
- **未偏离项**：不新增 facade、不新增 cross-context import、不新增 `routes/` / `services/` 横向耦合。

## 8. 测试策略

纯函数优先（CLAUDE.md「首选可断言面」），其后是最小集成断言。

**纯函数单测（`shared` 侧，新文件 `rfc313-retry-shape.test.ts`）**

1. 状态迁移矩阵：链未触顶 → `followup` 且 `chainLen+1`；触顶且有预算 → `restart` 且 `chainLen=0` / `restartsUsed+1`；判据落空 → `fresh` 且 `chainLen=0` / `restartsUsed` 不变。
2. 防御分支：链触顶 + 重启预算已尽 → 退回 `followup`（**不得**是 `fresh`），并断言 `restartsUsed` 未增长。
3. `restartBudget = 0` → 永不产生 `restart`（关闭开关的纯函数级证明）。
4. `port-validation` 的 `failures` 数组在 `followup` 形状下原样透传、在 `restart` 形状下不出现。
5. 硬顶算术：对 `followupBudget ∈ [0,5] × restartBudget ∈ [0,3]` 全组合，模拟「永远失败」的序列，断言 attempt 总数恰为 `(1+F)(1+R)`。

**prompt 渲染单测（`shared` 侧）** 6. 每个 `EnvelopeFollowupReason` 的告知文案互不相同且非空；不含上一次 attempt 的任何字节（正则断言无 `errorMessage` 形态的插值）。7. `priorSessionAbandoned` 缺省时 `renderUserPrompt` 输出与改动前**逐字节相同**（黄金锁）。

**scheduler 集成（`backend` 侧，新文件 `rfc313-session-escalation.test.ts`）** 8. **实现期记账——「丢树重建」这一项由既有路径承接**：升级把 `keepIf` 返回 false，而「keepIf=false ⇒ `discardIso` + `iso.create()`」是骨架里**早已存在**的那条（崩溃后的 `fresh` 重试走的就是它），其真实工作树语义由 `rfc092-followup-chain-rollback.test.ts`（fresh→followup 保树→fresh 重试回到基线 X）直接锁定。本 RFC 没有新增工作树机制，故不重复搭一套真 git 仓的夹具；集成用例沿用既有 followup 套件的 passthrough 搭台，改证**会话**换没换（native session id 前后不同 + argv 无 resume 参数 + nonce 换新），那才是升级的新语义。

主场景：agent 每次 `exitCode=0` + 有 text + 无信封 → 恰好 8 行 `node_runs`；第 0-3 行同一 `session_id` 与同一 `envelope_nonce`；第 4 行 `envelope_nonce` 不同、spawn 参数里**无** `--session` / `--resume`、iso 路径与前 4 行不同、prompt 含告知段与协议块；第 5-7 行复用会话 B。9. AC-5 关闭开关：`sessionRestartBudget=0` 下 attempt 序列 / session 复用 / iso 处置与现有 RFC-042 测试的期望完全一致（**复用现有测试作为不变量，不修改它们**）。10. AC-6 崩溃：`exitCode≠0` 插在链中 → 链归零、`restartsUsed` 未增长、后续仍能发生一次真升级。11. **实现期裁决**：AC-8（clarify 模式翻转不算升级）不新写集成用例——翻转分支读的是 `followupDecision.followup`，本 RFC 只在它为 false 时改变行为，对翻转路径是恒等变换。既有 RFC-122 套件即回归锁（T9 跑全绿为准），新写一条只会重复它们的搭台。12. AC-9 审计：升级行上恰有一条 `[rfc313/session-restart]` 事件且 payload 字段齐全；非升级行没有。13. **实现期裁决（如实记账）**：记忆注入 / 清单物化**没有**单独立测——它们由 `followupMode === undefined` 这一个既有开关驱动，升级 attempt 与首发 attempt 走的是**逐字相同**的那条分支（本 RFC 一行未改），没有新增可回归面。真正需要证明的是「升级那次确实走了完整渲染路径」，由第 8 条的 prompt 断言直接覆盖（含节点模板正文 + 协议块 + 告知段）。

**源码层兜底断言** 14. `decideRetryShape` 全仓只有一个定义点，且 `scheduler.ts` 里不出现第二处 `restartsUsed +=`（防止有人日后在别处偷偷加预算）。15. 告知段的渲染只经 `renderSessionRestartNotice` 一个出口。

## 9. 可观测性

- 升级行写 `[rfc313/session-restart]`（kind='text' 事件，与 `[rfc042/envelope-followup]` 同形态、同表、同渲染路径），任务详情页事件流即可读。
- 不新增 rerun cause、不新增列、不改 UI 组件（用户拍板）。代价是任务列表页上「接续」与「重启」两种重试行外观相同，仅事件流可区分——已知并接受。

## 10. 兼容性与存量

- **零 migration**。新设置缺省即默认 1。
- 存量部署升级后，未显式配置的节点最坏 attempt 数从 4 变 8（已在 `proposal.md` 成本表逐项呈确认）。
- 已在跑的任务不受影响：形状状态只在一次 dispatch 的闭包内，升级时点之后新起的 attempt 才享受新行为（与 RFC-042 的 R6 同款）。
