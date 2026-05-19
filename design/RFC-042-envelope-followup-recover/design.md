# RFC-042 — Envelope Follow-up Recovery · 技术设计

> 配套 [proposal.md](./proposal.md)。本文档锁死接口契约、改动点、失败模式、测试边界。

## 1. 改动范围一览

| 层            | 文件                                                   | 改动                                                                              |
| ------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| shared        | `packages/shared/src/prompt.ts`                        | 新增 `renderEnvelopeFollowupPrompt(input)` + 配套 input 类型（§3.1）              |
| backend       | `packages/backend/src/services/runner.ts`              | 新增 `envelopeFollowup?: boolean` 入参 + 改 prompt 渲染分支（§3.2）               |
| backend       | `packages/backend/src/services/scheduler.ts`           | retry 内层 attempt 循环加 followup 分支判定 + `?? 3` 默认（§3.3）                 |
| backend       | `packages/backend/src/services/scheduler.ts`           | 新增 `decideEnvelopeFollowup(prev, runRow, agentTextCount)` 纯函数判定器          |
| backend tests | 新增 `packages/backend/tests/scheduler-envelope-followup-branch.test.ts`         | scheduler 分支判定 8 case                                                         |
| backend tests | 新增 `packages/backend/tests/runner-envelope-followup.test.ts`         | runner argv / prompt body 4 case                                                  |
| backend tests | 新增 `packages/backend/tests/scheduler-default-retries.test.ts`                  | 默认 retries=3 fallback 4 case                                                    |
| backend tests | 新增 `packages/backend/tests/scheduler-envelope-followup-rfc039.test.ts`         | RFC-039 偏向穿透 2 case                                                           |
| backend tests | 新增 `packages/backend/tests/node-run-events-followup.test.ts`                   | events 表 followup 审计行 1 case                                                  |
| backend tests | 新增 `packages/backend/tests/envelope-followup-source-grep.test.ts`              | 源码层 grep 守卫 2 case                                                           |
| shared tests  | 新增 `packages/shared/tests/envelope-followup-prompt.test.ts`                    | renderEnvelopeFollowupPrompt 单测 6 case                                          |
| mock-opencode | `packages/backend/tests/fixtures/mock-opencode.ts`     | 加 `MOCK_OPENCODE_EXPECT_FOLLOWUP_ARGV` 钩子 + 二轮 reply 钩子（§3.4）            |

**零改动**：DB schema / migration / shared schemas / WS 协议 / 前端任何文件 / e2e / opencode 源码。

## 2. 接口契约

### 2.1 不变

- `RunNodeOptions.resumeSessionId` 仍是 RFC-026 引入的字段，类型 / 语义不动；本 RFC 只是在新场景下复用它。
- `runner.ts` 在 envelope 解析失败时返回 `status='failed' + errorMessage='<文案>'` 的 4 个分支文案不变（同 session 追问的入口是 scheduler 侧识别这些文案，runner 不需要改 errorMessage）。
- `node_runs` 表结构不变：`opencodeSessionId` 列在 RFC-026 已加，仍是判定追问的关键字段；`retry_index` 单调递增语义保留。
- RFC-039 prompt 文案 / RFC-040 wrapper progress / RFC-005 review pipeline / RFC-014 sibling iterate / RFC-023 clarify channel **全部不动**。

### 2.2 变

- `runner.runNode(opts)` 新接受 `opts.envelopeFollowup?: boolean`，默认 `false`。`true` 时 runner 用 `renderEnvelopeFollowupPrompt` 渲染 prompt 而不是 `renderUserPrompt`。
- scheduler 的内层 attempt 循环：在第 N+1 次 attempt 开始之前，调 `decideEnvelopeFollowup` 决定是否同 session 追问；是 → 复用上一行 node_run 的 `opencodeSessionId` + 设 `envelopeFollowup: true` + **跳过 git stash rollback**（同 session 续跑，worktree 文件状态承上一次）；否 → 走现有 rollback + 新 spawn 路径。
- `pickNumber(node, 'retries') ?? 0` 改 `?? 3`。

## 3. 详细改动

### 3.1 shared — `renderEnvelopeFollowupPrompt`

新增导出函数（放在 `packages/shared/src/prompt.ts` 末尾，紧贴 `buildClarifyInlineReminder` 之后）：

```ts
export interface EnvelopeFollowupInput {
  /** RFC-023 clarify channel 是否已挂在本节点（与 RenderPromptInput.hasClarifyChannel 同义）。 */
  hasClarifyChannel: boolean
  /**
   * 当 hasClarifyChannel=true 时，最近一轮 clarify session 的 directive。
   * 'continue' → followup 末尾追加 RFC-039 强偏向短句；
   * 'stop' / undefined → 不追加（stop 在 clarify-rerun 时已经走单独分支，本 RFC 不重写 stop）。
   */
  clarifyDirective?: 'continue' | 'stop'
  /**
   * scheduler 识别的失败原因，用于在文案标题里指认到底哪一类 envelope 错。
   * 'envelope-missing' / 'both-present' / 'clarify-malformed'。
   * 文案分支表见 §3.1.2。
   */
  reason: 'envelope-missing' | 'both-present' | 'clarify-malformed'
}

export function renderEnvelopeFollowupPrompt(input: EnvelopeFollowupInput): string {
  /* 见 §3.1.2 文案矩阵 */
}
```

**为什么和 `renderUserPrompt` 分两个函数**：

- `renderUserPrompt` 负责"完整 user prompt"——template 代入 + ports 自动追加 + RFC-039 / RFC-023 / RFC-026 trailing protocol 全套。
- followup 是同 session 续跑里的"短消息"，**不**应当再次塞 inputs / ports / 协议长文（opencode session 里已经有了），重渲一遍既浪费 token 又有可能让模型在大 payload 上 re-anchor。这点和 RFC-026 inline reminder 一致——单独函数、单独测试、单独不踩 RFC-039 / RFC-023 渲染分支。

#### 3.1.1 关键设计：不带 inputs / ports / template body

`renderEnvelopeFollowupPrompt` 返回的字符串**只含 followup 短指令**：

- 不读 `inputs`、不读 `promptTemplate`、不读 `agentOutputs`、不读 `agentOutputKinds`、不读 `reviewContext` / `clarifyContext`。
- 不再调 `buildProtocolBlock` / `buildClarifyProtocolBlock`。
- 起手统一 `'\n\n---\n'` 分隔符 + Bold 标题 `**Envelope missing — follow-up.**`（便于模型识别这是上下文里独立的新指令而非延续）。

opencode 在 `--session <id>` 续跑下会把 followup 拼接到 session 历史末尾——模型读到的上下文是「完整第一轮 prompt（含 RFC-039 / RFC-023 协议块）→ 第一轮模型 reply（缺 envelope）→ followup 短指令」，已经够下结论。

#### 3.1.2 文案矩阵

按 `(hasClarifyChannel, clarifyDirective, reason)` 三个维度。reason 维度只影响标题开头那一行的 `did not contain ...` 文案细节，主体一致。

**核心结构**（不分支共用）：

```
\n\n---
**Envelope missing — follow-up.** <reason-specific opening line>

- <branch-specific bullet 1>
- <branch-specific bullet 2>
- <hard rule on contains-exactly-one-envelope>
- Do not emit anything after the closing envelope tag.
```

**hasClarifyChannel=false**：

- reason='envelope-missing' 开头：`Your previous reply in this session did not contain a <workflow-output> envelope. The framework cannot parse your result without it.`
- reason='both-present' 不会命中（只有 clarify channel 才可能 both），fallback 走 envelope-missing 开头文案。
- reason='clarify-malformed' 不会命中（同上）。
- bullets：
  - `If you have finished the requested work, end your NEXT reply with a <workflow-output> block using the EXACT format previously specified in this session (the same port list, the same <port name="...">...</port> shape). Do not summarize, do not omit the block.`
  - `If you were not finished, complete the remaining work first, THEN emit the <workflow-output> block. The envelope is mandatory either way.`

**hasClarifyChannel=true**：

- reason='envelope-missing' 开头：`Your previous reply in this session did not contain either a <workflow-output> or a <workflow-clarify> envelope. The framework cannot parse your result without exactly one of them.`
- reason='both-present' 开头：`Your previous reply in this session contained BOTH <workflow-output> AND <workflow-clarify> — the framework requires exactly one. Pick one and re-emit.`
- reason='clarify-malformed' 开头：`Your previous reply in this session contained a <workflow-clarify> envelope but its JSON body could not be parsed. Re-emit a valid <workflow-clarify> body following the format previously specified in this session.`
- bullets：
  - `By default, per the clarify protocol previously stated in this session, your next reply should be (B) <workflow-clarify> — ask back to disambiguate. Emit (A) <workflow-output> directly ONLY when every decision is already pinned down. (RFC-039 bias still applies.)`
  - `If the previous reply was an in-progress draft, finish the work first, then commit to EXACTLY ONE envelope.`
  - `A reply must contain EITHER one <workflow-output> block OR one <workflow-clarify> block — NEVER both, NEVER neither.`

**hasClarifyChannel=true + clarifyDirective='continue'**：在上面 hasClarifyChannel=true 文案之后**再加一段**（与 RFC-039 § continue trailer 风格保持一致，但更短，因为只是 follow-up 提醒）：

```
The user has explicitly clicked "Keep clarifying" — unless every still-unresolved detail has been pinned down by the answers earlier in this session, your reply is REQUIRED to be another <workflow-clarify> envelope. Skipping to <workflow-output> for the sake of brevity is not allowed.
```

**hasClarifyChannel=true + clarifyDirective='stop'**：不追加 continue 短句（stop 路径在 RFC-023 已经走「单次 rerun 不带 clarify protocol」分支，本 RFC 不重写）。

#### 3.1.3 文案锚点（测试用）

- 通用：`Envelope missing — follow-up.`
- has=false：`<workflow-output> block using the EXACT format previously specified`
- has=true：`(B) <workflow-clarify>` + `RFC-039 bias still applies`
- has=true + continue：`The user has explicitly clicked "Keep clarifying"` + `REQUIRED to be another <workflow-clarify>`
- reason='both-present'：`contained BOTH <workflow-output> AND <workflow-clarify>`
- reason='clarify-malformed'：`could not be parsed`

### 3.2 runner — 加 `envelopeFollowup` 入参

`RunNodeOptions` 新字段：

```ts
/**
 * RFC-042: 由 scheduler 在内层 retry attempt 决定走"同 session 追问"时设为 true。
 * 配合 `resumeSessionId`（透传到 `--session <id>`）+ `envelopeFollowupReason` /
 * `envelopeFollowupClarifyDirective`（驱动文案分支）使用。
 *
 * 为 true 时 runner 用 `renderEnvelopeFollowupPrompt` 渲染 prompt（短指令、不带
 * inputs / ports / template body），而不是 `renderUserPrompt`（完整 prompt）。
 * 为 false / undefined 时 runner 行为完全不变。
 */
envelopeFollowup?: boolean
envelopeFollowupReason?: 'envelope-missing' | 'both-present' | 'clarify-malformed'
envelopeFollowupClarifyDirective?: 'continue' | 'stop'
```

runner 内部改 3 处：

1. **prompt 渲染分支**（runner.ts:297 附近）：

   ```ts
   const prompt =
     opts.envelopeFollowup === true
       ? renderEnvelopeFollowupPrompt({
           hasClarifyChannel: opts.hasClarifyChannel === true,
           ...(opts.envelopeFollowupClarifyDirective !== undefined
             ? { clarifyDirective: opts.envelopeFollowupClarifyDirective }
             : {}),
           reason: opts.envelopeFollowupReason ?? 'envelope-missing',
         })
       : renderUserPrompt({
           /* 原 14 行参数完全不变 */
         })
   ```

2. **跳过 inventory 插件挂载**（runner.ts:255-275 附近）：envelopeFollowup=true 时不再 materializeInventoryPlugin（RFC-029 inventory snapshot 在第一次 attempt 已经写过；followup 的目的只是补 envelope，不需要再 dump 一遍 → 节省时间 + 避免 plugin 加载失败概率）。改成 `if (isAgentRunKind(inventoryNodeKind) && opts.envelopeFollowup !== true) { ... }`。

3. **不增加 sessionId 透传特殊处理**：`opts.resumeSessionId !== undefined && opts.resumeSessionId.length > 0` 已经会拼 `--session`（RFC-026），followup 路径靠 scheduler 设 `resumeSessionId` 即可，runner 这边 0 改动。

### 3.3 scheduler — retry 内层循环加 followup 分支

#### 3.3.1 新纯函数 `decideEnvelopeFollowup`

放在 `services/scheduler.ts` 顶部 helper 区（`isFresherNodeRun` 旁），输入只取上一次 attempt 的产物，不做 IO。

```ts
export interface PreviousAttemptShape {
  status: RunFinalStatus | null
  exitCode: number | null
  errorMessage: string | null
  sessionId: string | null
  agentTextCount: number // 上一行 node_runs 的 node_run_events kind='text' 计数
}

export type EnvelopeFollowupDecision =
  | { followup: true; reason: 'envelope-missing' | 'both-present' | 'clarify-malformed' }
  | { followup: false }

export function decideEnvelopeFollowup(prev: PreviousAttemptShape): EnvelopeFollowupDecision {
  if (prev.status !== 'failed') return { followup: false }
  if (prev.exitCode !== 0) return { followup: false }
  if (prev.sessionId === null || prev.sessionId === '') return { followup: false }
  if (prev.agentTextCount === 0) return { followup: false }
  const m = prev.errorMessage ?? ''
  if (m.startsWith('no <workflow-output> envelope found in stdout')) {
    return { followup: true, reason: 'envelope-missing' }
  }
  if (m.startsWith('clarify-and-output-both-present')) {
    return { followup: true, reason: 'both-present' }
  }
  if (m.startsWith('clarify-questions-')) {
    return { followup: true, reason: 'clarify-malformed' }
  }
  return { followup: false }
}
```

**为什么挑成纯函数**：CLAUDE.md "首选可断言面 / 抽出纯函数 / 纯数据预言"；后端的 attempt 循环已经够大，独立的判定器单独测覆盖 8 case 比在集成测里堆 case 便宜。

#### 3.3.2 attempt 循环改动（scheduler.ts:703 附近）

伪代码：

```ts
for (let attempt = retryIndex; attempt <= retryIndex + maxRetries; attempt++) {
  // 决定本轮是否走 followup（仅对 attempt > retryIndex 生效；首次 attempt 永远不是 followup）
  let followupDecision: EnvelopeFollowupDecision = { followup: false }
  if (attempt > retryIndex && lastResult !== null) {
    // 读上一行 node_run_events 的 kind='text' 计数
    const eventsCount = await db
      .select({ c: sql<number>`count(*)` })
      .from(nodeRunEvents)
      .where(and(eq(nodeRunEvents.nodeRunId, nodeRunId), eq(nodeRunEvents.kind, 'text')))
      .get()
    followupDecision = decideEnvelopeFollowup({
      status: lastResult.status,
      exitCode: lastResult.exitCode,
      errorMessage: lastResult.errorMessage ?? null,
      sessionId: lastResult.sessionId ?? null,
      agentTextCount: eventsCount?.c ?? 0,
    })
  }

  // 现有 retryIndex+1 mint 流程不变；但 rollback 仅在 NON-followup 路径执行
  if (attempt > retryIndex) {
    if (!followupDecision.followup) {
      // 现有逻辑：rollback 到 pre_snapshot
      const snap = await readSnapshotForLatestRun(db, taskId, node.id, iteration)
      if (!agent.readonly && snap !== '') {
        await rollbackToSnapshot(task.worktreePath, snap)
      }
    }
    // mint 新 node_run 行（不动现有 mint 调用）
    nodeRunId = await insertNodeRun(...)
    broadcastNodeStatus(taskId, nodeRunId, node.id, 'pending')

    // RFC-042 审计：成功决定走 followup 时记一条 events 行（只在 followup 路径）
    if (followupDecision.followup) {
      await opts.db.insert(nodeRunEvents).values({
        nodeRunId,
        ts: Date.now(),
        kind: 'text',
        payload: `[rfc042/envelope-followup] ${JSON.stringify({
          rfc: 'RFC-042',
          reason: followupDecision.reason,
          retryAttempt: attempt,
        })}`,
      })
    }
  }

  // pre-snapshot 仅在 NON-followup 跑（followup 不修改 worktree，没必要做 stash）
  if (!agent.readonly && !followupDecision.followup) {
    const sha = await gitStashSnapshot(task.worktreePath)
    await db.update(nodeRuns).set({ preSnapshot: sha }).where(eq(nodeRuns.id, nodeRunId))
  }

  // 取本次将要 runNode 的可选 resumeSessionId
  // - followup: 强制取上一行 node_run 的 opencodeSessionId
  // - non-followup: 沿用 RFC-026 decideResumeSessionId 算法
  let envelopeFollowupResume: string | undefined
  if (followupDecision.followup) {
    envelopeFollowupResume = lastResult?.sessionId
  }

  // 计算 clarifyDirective（只在 followup + hasClarifyChannel 时用）
  const followupClarifyDirective =
    followupDecision.followup && effectiveHasClarifyChannel ? clarifyContext?.directive : undefined

  lastResult = await runNode({
    // ... 原参数全部保留
    ...(followupDecision.followup
      ? {
          envelopeFollowup: true as const,
          envelopeFollowupReason: followupDecision.reason,
          ...(followupClarifyDirective !== undefined
            ? { envelopeFollowupClarifyDirective: followupClarifyDirective }
            : {}),
          resumeSessionId: envelopeFollowupResume,
        }
      : { /* 现有 RFC-026 inline-mode 的 resumeSessionId 分支保留 */ }),
  })
}
```

**关键约束**：

- followup 时 `resumeSessionId` 来源**只能**是上一行 node_run 的 sessionId（即 `lastResult.sessionId`），不复用 RFC-026 的 `decideResumeSessionId(sessionMode, sourceSessionId)` 路径。两路 resume 互不混用。
- followup 时**不**修改 worktree（不 rollback、不 pre-snapshot）。如果模型在第一次 attempt 已经写了一半的文件，followup 续跑下文件状态保持原样——这是符合"在同一 session 把上次没做完的事做完"的语义。failed 状态最终若 followup 也没救回来，下一次走 non-followup 分支时再 rollback 一次（rollback 取自 **当前 latest node_run** 的 pre_snapshot，而 followup attempt 没存 pre_snapshot，所以 `readSnapshotForLatestRun` 自然取上一次有 pre_snapshot 的那一行——已是现有行为）。

#### 3.3.3 默认 retries 改 3

唯一改动：`scheduler.ts:632`

```diff
- const maxRetries = pickNumber(node, 'retries') ?? 0
+ const maxRetries = pickNumber(node, 'retries') ?? 3
```

`pickNumber` 在字段不存在 / 不是 number 时返 undefined，`?? 3` fallback；字段显式为 0 / 1 / 5 时按字段值。无须改 shared schema（`retries` 一直是可选 number）。

### 3.4 mock-opencode 钩子（仅测试用）

`packages/backend/tests/fixtures/mock-opencode.ts` 加：

```ts
if (process.env.MOCK_OPENCODE_EXPECT_FOLLOWUP_ARGV !== undefined) {
  appendFileSync(process.env.MOCK_OPENCODE_EXPECT_FOLLOWUP_ARGV, JSON.stringify(process.argv) + '\n')
}
```

测试里：

```ts
process.env.MOCK_OPENCODE_EXPECT_FOLLOWUP_ARGV = join(tmp, 'argv.log')
// 第一次 run 配置成"不发 envelope"；第二次 run 检查 argv 包含 --session <id>
```

并加另一个钩子 `MOCK_OPENCODE_FOLLOWUP_REPLY_FILE` 让第二轮 stub 读不同 reply（便于覆盖 followup 成功 / followup 仍失败两种路径）。

## 4. 失败模式与边界

| 边界                                                                       | 行为                                                                                                                           |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| opencode 在第一次 attempt 直接崩，没 emit `session.created`                | 第二次 attempt 不走 followup（`sessionId === null` 兜底），走全新 session                                                      |
| opencode 第一次 attempt 跑完但 exitCode=137 (SIGKILL)                       | 第二次不走 followup（`exitCode !== 0` 兜底），走全新 session                                                                   |
| opencode 第一次 attempt exitCode=0 但 stdout 全空（agent 一字未出）        | 第二次不走 followup（`agentTextCount === 0` 兜底），走全新 session                                                             |
| 第一次 attempt 成功 done                                                   | 不进入 retry 循环（现有 `break` 不变），无 followup                                                                            |
| `retries=0`（用户显式填）                                                  | attempt 循环只跑 1 次，永远没有 N+1，无 followup                                                                               |
| followup 跑出来仍然没 envelope                                             | followup attempt 完成、`lastResult.status='failed'`，仍是 envelope-missing 类；下一轮再判定，仍可 followup（如果预算还剩）     |
| followup 跑出来 envelope ok                                                | `status='done'`，按现有 `break` 退循环，task 继续                                                                              |
| followup 跑出来 `<workflow-clarify>` 合法（has clarify channel）           | `clarifyResult` 被填回，scheduler 走 awaiting_human 路径，等于 followup 把 reply 拉成 clarify ask——符合预期                    |
| followup 跑出来 exitCode!=0 / 进程崩                                       | 下一轮判定 `decideEnvelopeFollowup` 返 false（exitCode != 0），自然降级全新 session                                            |
| followup 时 worktree 文件有第一次 attempt 留下的脏修改                     | 不 rollback / 不 stash，保留这些修改——opencode 在同 session 看到的就是这个状态，符合"延续工作"语义                             |
| RFC-026 inline-mode clarify rerun（retryIndex=0，新 clarifyIteration）+ envelope 失败 | 第一次 attempt 走 RFC-026 inline resumeSessionId；同一行 node_run 的 retry 内层若再 envelope 失败、且条件满足，照样走 followup 复用同一 session id |
| RFC-040 wrapper-loop / wrapper-git 内层 agent failed                       | RFC-040 处理 `awaiting_*` 上抛，与 retry-failed 不冲突；wrapper 看到 `failed` 仍按 cascade-fail 处理（不变）                   |
| agent 是 `readonly: true`                                                   | followup 路径**也不**做 rollback / pre-snapshot（readonly 现有就跳过）；同 session 续跑仍可走                                  |
| fan-out 多进程子 shard                                                     | 每个子 shard 独立走 retry 循环，followup 决策也独立做（每个 shard 的 sessionId / agentTextCount 都是各自的 node_run 行的）     |

## 5. 测试策略

按 §1 列表 + CLAUDE.md "Test-with-every-change"：

### 5.1 shared `renderEnvelopeFollowupPrompt` 单测（6 case）

`packages/shared/tests/envelope-followup-prompt.test.ts`：

1. has=false + reason=envelope-missing → 含 `Envelope missing — follow-up.` + `<workflow-output> block using the EXACT format previously specified` + 不含 `<workflow-clarify>` 字眼（除 hard rule 行外不应出现）+ 不含 `RFC-039`。
2. has=true + reason=envelope-missing → 含 `(B) <workflow-clarify>` + `RFC-039 bias still applies` + `EITHER one <workflow-output> block OR one <workflow-clarify> block — NEVER both, NEVER neither`。
3. has=true + reason=both-present → 含 `contained BOTH <workflow-output> AND <workflow-clarify>`。
4. has=true + reason=clarify-malformed → 含 `could not be parsed`。
5. has=true + clarifyDirective=continue → 含 `The user has explicitly clicked "Keep clarifying"` + `REQUIRED to be another <workflow-clarify>`。
6. has=true + clarifyDirective=stop → **不**含 `Keep clarifying` 短句，且不含 RFC-023 stop trailer 文案（stop 路径在更早就拦掉了，followup 不重新发明）。

### 5.2 backend `decideEnvelopeFollowup` 单测（8 case）

`packages/backend/tests/scheduler-envelope-followup-branch.test.ts` 前半部分（纯函数判定）：

1. failed + exitCode=0 + sessionId='s1' + text=10 + errMsg='no <workflow-output> envelope found in stdout' → followup=true, reason=envelope-missing
2. failed + exitCode=137 + ... → followup=false（崩溃）
3. failed + exitCode=0 + sessionId=null + ... → followup=false（无 session）
4. failed + exitCode=0 + sessionId='s1' + text=0 → followup=false（无 text）
5. failed + exitCode=0 + sessionId='s1' + text=10 + errMsg='clarify-and-output-both-present: ...' → followup=true, reason=both-present
6. failed + exitCode=0 + sessionId='s1' + text=10 + errMsg='clarify-questions-too-many: 6/5' → followup=true, reason=clarify-malformed
7. failed + exitCode=0 + sessionId='s1' + text=10 + errMsg='opencode exited with code 0' → followup=false（不在识别集合）
8. done + 其它字段任意 → followup=false（status 不是 failed）

后半部分（scheduler 集成）—— mock-opencode 驱动：

9. 第一次 reply 不发 envelope → 第二次 argv 含 `--session <id>` + 第二次 reply 发 envelope → node done。
10. 第一次 reply 不发 envelope + exitCode 强制 1 → 第二次 argv **不**含 `--session`，走全新 session + 第二次 reply 发 envelope → node done。
11. retries=0 + 第一次失败 → node failed（无 followup）。
12. retries=3 + 三次都不发 envelope → node failed（3 次 followup 都没救回来，最后 1 次还能走 followup or 降级 fresh，验最后一次 errorMessage 为 envelope-missing 类）。

### 5.3 backend runner argv / prompt 单测（4 case）

`packages/backend/tests/runner-envelope-followup.test.ts`：

1. envelopeFollowup=true + resumeSessionId='s1' → argv 含 `'--session', 's1'`。
2. envelopeFollowup=true 时，runner promptText 写入 `node_runs.promptText` 列的内容**不**含 `inputs` 任何值、**不**含 promptTemplate body、**含** `Envelope missing — follow-up.`。
3. envelopeFollowup=true 时，runner **不**调 materializeInventoryPlugin（拿 `inlineConfig.plugin` 数组检查不含 inventory）。
4. envelopeFollowup=true + resumeSessionId=undefined → runner 仍跑（不 fail），argv **不**含 `--session`。这种组合不该出现，但要保证 runner 不崩。

### 5.4 backend 默认 retries=3（4 case）

`packages/backend/tests/scheduler-default-retries.test.ts`：

1. workflow 节点定义里**无** `retries` 字段 → scheduler 视作 3。
2. 节点 `retries: 0` → 视作 0。
3. 节点 `retries: 5` → 视作 5。
4. YAML 导入路径：模拟从 YAML 文件读节点（不含 retries），import 落库后 read 出来还是 3。

### 5.5 RFC-039 偏向穿透（2 case）

`packages/backend/tests/scheduler-envelope-followup-rfc039.test.ts`：

1. hasClarifyChannel=true + 最近 clarify session directive=continue + 第一次 reply 漏 envelope → 第二次 attempt 的 promptText 含 `Keep clarifying`。
2. hasClarifyChannel=true + 最近 clarify session directive=stop → followup promptText 不含 `Keep clarifying`。

### 5.6 events 表审计行（1 case）

`packages/backend/tests/node-run-events-followup.test.ts`：

跑通一次 followup 成功路径后，select * from node_run_events where kind='text' and payload like '%[rfc042/envelope-followup]%' → 找到 1 行 + JSON 字段含 `reason` / `retryAttempt`。

### 5.7 源码层 grep 守卫（2 case）

`packages/backend/tests/envelope-followup-source-grep.test.ts`：

1. `scheduler.ts` 不得回退 `pickNumber(node, 'retries') ?? 0`（守 RFC-042 默认）。
2. `prompt.ts` 必须导出 `renderEnvelopeFollowupPrompt`。

### 5.8 既有套件零退化

跑通：

- `clarify-prompt-inline.test.ts` + `clarify-prompt-injection.test.ts`（RFC-026 / RFC-023 / RFC-039 文案）。
- `runner-resume-session-flag.test.ts`（RFC-026 `--session` 透传）。
- `scheduler-clarify-inline.test.ts` + `clarify-fallback.test.ts`（RFC-026 fallback）。
- `scheduler-rfc040-wrapper-await.test.ts`（RFC-040 wrapper 上抛续跑）。
- `runner-retry-with-rollback.test.ts` / `scheduler-retry-on-failed-node.test.ts` 等既有 retry 路径。

预期既有 1411+ backend test 套件 **零退化**。

### 5.9 不新增 e2e

本 RFC 是后端 + shared 改动，前端零变化。Playwright 不覆盖 prompt 文案 / argv 检查。`bun run typecheck && bun run test && bun run format:check` 三件套全绿 + GitHub Actions 六 jobs 全绿即可。

## 6. PR 拆分

**单 PR** 合并：改动收敛于 1 个 shared 函数 + 3 处 backend 改动（runner 入参 + scheduler attempt 循环 + 默认 retries）+ 7 个新测试文件。一次评审、单 commit `git revert` 即可回滚。

commit message 模板：`feat(runner): RFC-042 envelope 缺失同 session 追问 + 默认 retries=3`。

## 7. 回滚方案

- 单 commit revert。
- `?? 3` 改回 `?? 0`，followup 分支整体回退；既有 retry 全新 session 路径完全保留。
- 不存在 schema / migration 残留。
- 任何已经走过 followup 路径的 `node_run_events` `[rfc042/envelope-followup]` 行可留（payload 是字符串，不影响其它消费者）。

## 8. opencode 行为验证

本 RFC 不改 opencode 端协议——`--session <id>` 是 opencode 已有的 CLI flag（`opencode/packages/opencode/src/cli/cmd/run.ts:12,158,338,372,383`），RFC-026 已经验证过透传到 `Session.prompt({ sessionID: args.session, ... })` 的路径稳定。followup attempt 复用同 `--session <id>` 行为与 RFC-026 inline clarify rerun 完全一致——不需要再次 grep opencode 源码。

如未来 opencode 重写 session resume 语义，本 RFC 和 RFC-026 会同时坏；届时统一改一次 runner 的 `--session` 透传即可，followup 分支自身不依赖 opencode 协议细节。

## 9. Follow-up 设计 — markdown_file 路径协议同步进 envelope followup

> 状态：Planned（与 proposal.md §Follow-up 对齐；RFC-042 主体已 Done + merged，本节是后续增量的技术蓝图）。

### 9.1 现状盘点（首轮 vs followup 的 markdown_file 覆盖差）

| 路径                                          | 文件:行                                                | 是否提示 markdown_file 两步协议                                                                          |
| --------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| 首轮 user prompt（renderUserPrompt → buildProtocolBlock） | `packages/shared/src/prompt.ts:383`、`prompt.ts:460`   | ✅ 端口 bullet 渲染成 `(markdown_file — write the file first, then emit only its worktree-relative path)`，`buildMarkdownFilePortGuidance` 追加两步协议长段                  |
| envelope followup prompt（renderEnvelopeFollowupPrompt）  | `packages/shared/src/prompt.ts:589`                    | ❌ 完全不感知 outputKinds；followup 短指令里没有 markdown_file 任何字眼                                  |

**结论**：首轮已覆盖；followup 缺一段同向但更短的提醒。本 follow-up 只补 followup 这一面。

### 9.2 接口契约改动

`EnvelopeFollowupInput`（`prompt.ts:558`）**追加**两个可选字段（向后兼容）：

```ts
export interface EnvelopeFollowupInput {
  // ... 现有 hasClarifyChannel / clarifyDirective / reason 字段不变
  /**
   * 本节点 agent 声明的所有输出 port 名（与首轮 renderUserPrompt 入参的 agentOutputs 同语义）。
   * 仅当 agentOutputKinds 中有 markdown_file 端口时才被读，否则 followup 文案不变。
   * 缺省 → 不渲染 markdown_file 提醒段（向后兼容）。
   */
  agentOutputs?: readonly string[]
  /**
   * 本节点 agent 声明的输出 kinds 字典（与 buildProtocolBlock 同语义、同 AgentOutputKindsMap 类型）。
   * 缺省 → 同上，不渲染 markdown_file 提醒段。
   */
  agentOutputKinds?: AgentOutputKindsMap
}
```

`renderEnvelopeFollowupPrompt` 内部逻辑增量（伪代码）：

```ts
const mdFilePorts =
  input.agentOutputs && input.agentOutputKinds
    ? input.agentOutputs.filter((p) => input.agentOutputKinds![p] === 'markdown_file')
    : []
const mdSegment = mdFilePorts.length > 0 ? buildEnvelopeFollowupMarkdownFileSegment(mdFilePorts) : ''

// 顺序：标题 + opening → 主 bullets → markdown_file 提醒段（如有） → RFC-039 continue 短句（如有）
return `\n\n---\n**Envelope missing — follow-up.** ${opening}\n\n${bullets}${mdSegment}${trailer}`
```

新增内部 helper（不导出）：

```ts
function buildEnvelopeFollowupMarkdownFileSegment(mdFilePorts: string[]): string {
  const list = mdFilePorts.map((p) => `\`${p}\``).join(', ')
  return (
    `\n\n` +
    `**markdown_file ports require a two-step protocol** — for the port(s) ${list} declared \`markdown_file\` on this node:\n` +
    `  1. Write the file to disk first (use a file-writing tool — Write / Edit / shell \`cat > path\` / equivalent) at a stable worktree-relative path inside the current working directory.\n` +
    `  2. Then place ONLY its worktree-relative path inside the matching \`<port>\` tag — no markdown body, no code fences, no placeholder, no leading or trailing whitespace.\n` +
    `Emitting a path without the file behind it will fail the run (the framework reads the file at that path).`
  )
}
```

### 9.3 runner 调用方改动

`packages/backend/src/services/runner.ts` 在 `opts.envelopeFollowup === true` 的 prompt 渲染分支（参考 §3.2 现有改动点）多传两个字段：

```ts
const prompt = renderEnvelopeFollowupPrompt({
  hasClarifyChannel: opts.hasClarifyChannel === true,
  ...(opts.envelopeFollowupClarifyDirective !== undefined
    ? { clarifyDirective: opts.envelopeFollowupClarifyDirective }
    : {}),
  reason: opts.envelopeFollowupReason ?? 'envelope-missing',
  // ↓↓↓ follow-up 增量
  agentOutputs: agent.outputs?.map((o) => o.name),
  agentOutputKinds: buildAgentOutputKindsMap(agent.outputs),
  // ↑↑↑
})
```

`buildAgentOutputKindsMap` 已在 runner 内部用于 `renderUserPrompt`（同源代码，无需新增 helper）。

### 9.4 顺序与互斥

文案最终顺序硬约束（测试断言）：

```
\n\n---
**Envelope missing — follow-up.** {opening}

{bullets}                       ← envelope-missing / both-present / clarify-malformed 三选一文案
{mdSegment}                     ← 仅 agentOutputKinds 含 markdown_file 时插入；空字符串可省略整段
{trailer}                       ← 仅 hasClarifyChannel=true ∧ clarifyDirective=continue 时追加 RFC-039 强偏向短句
```

RFC-039 `Keep clarifying` 短句**始终在最末尾**——避免 markdown_file 段把"REQUIRED to be another `<workflow-clarify>`"挤到中段，让模型读漏。

### 9.5 测试矩阵增量

| 测试文件                                                  | 新增 case 描述                                                                                                                                                                                                                                                            |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/tests/envelope-followup-prompt.test.ts`  | (a) outputs=['s'] + kinds={s:'markdown'} → 文案**不**含 `markdown_file ports require`。(b) outputs=['report','log'] + kinds={report:'markdown_file', log:'string'} → 文案含 `\`report\`` + `markdown_file ports require a two-step protocol` + `worktree-relative path inside the <port> tag`，且**不**含 `\`log\``。(c) has=true + directive=continue + kinds 含 markdown_file → 三段顺序：双 envelope bullets → markdown_file 段 → RFC-039 `Keep clarifying` 短句（用 indexOf 锁顺序）。 |
| `packages/backend/tests/runner-envelope-followup.test.ts` | (d) agent 声明 markdown_file output + envelopeFollowup=true → runner 写入 `node_runs.promptText` 的内容含三个锚点。                                                                                                                                                  |

既有 6 个 shared followup case + 8 case `decideEnvelopeFollowup` + 4 case runner-envelope-followup + 4 case default-retries + 2 case rfc039-bias + 1 case events + 2 case grep → **全部零退化**。

### 9.6 失败模式补充

| 边界                                                          | 行为                                                                                                       |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| agent 完全没声明 outputs（agentOutputs 为空数组）             | mdFilePorts=[] → 不渲染 markdown_file 段。followup 文案与目前 100% 一致。                                  |
| agent 声明 outputs 但 outputKinds 全是 string/markdown        | mdFilePorts=[] → 不渲染。                                                                                  |
| agent 声明 markdown_file output 但 followup 调用方忘传 agentOutputs / agentOutputKinds | 行为退化为"文案与目前一致"——不报错、不抛异常，最坏情况是 followup 没追加 markdown_file 提醒；属于安全降级。 |
| 同一端口在 outputKinds 里被声明成未知值                       | 不命中 markdown_file 过滤；属于上游 schema 守卫问题，本 follow-up 不做防御。                                |

### 9.7 回滚

本 follow-up 与 RFC-042 主体可独立回滚——回退 `renderEnvelopeFollowupPrompt` 入参的两个可选字段 + helper 删除即可。`buildEnvelopeFollowupMarkdownFileSegment` 是内部函数、不导出、零外部消费者。

### 9.8 不在本节做的事

- 不改 `buildProtocolBlock` / `buildMarkdownFilePortGuidance`（首轮已经覆盖）。
- 不把 `markdown-file-empty-path` / `markdown-file-escapes-worktree` / `markdown-file-read-failed` 加入 RFC-042 识别集合（那是 envelope 后下游错误，不属"模型协议错"，应走 RFC-005 全新 session 重试 + 首轮主 prompt 提醒；与本 follow-up 正交）。
- 不动 scheduler 决策器、不动默认 retries、不动 events 审计行 schema。
