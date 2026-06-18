# RFC-100 — 技术设计

## 0. 关键事实（已对源码核验）

- self-clarify agent 与 cross-clarify questioner **都**在自己的 `__clarify__` 源端口上接线，
  `agentHasClarifyChannel(definition, nodeId)` 对两者**都返回 true**
  （`packages/shared/src/clarify.ts:349`、cross 的自动边见 `buildCrossClarifyAutoEdges` line 718）。
  ⇒ 两者**共用** `renderUserPrompt` 的反问分支，单点改之即可双侧生效。
- scheduler 统一门控：`effectiveHasClarifyChannel = hasClarifyChannel && clarifyContext?.directive !== 'stop'`
  （`scheduler.ts:2241`），再以 `hasClarifyChannel: effectiveHasClarifyChannel` 传给 `runNode`→`renderUserPrompt`
  （`scheduler.ts:2315`）。`buildPromptContext` 对 self 与 cross-questioner **都**写入 `directive`
  （`clarifyRounds.ts:394`）。⇒ "未 stop ⇒ hasClarifyChannel=true；stop ⇒ false" 对两侧成立，无需新增门控。
- runner 当前 envelope 分类（`runner.ts:1070-1192`）：`detectEnvelopeKind` → both/clarify/none/output；
  **output 分支对 `hasClarifyChannel` 一无所知**，反问期间擅自 output 会被接受为 done（缺端口仅 `log.warn`）。
- followup：runner 设 `errorMessage` 前缀 → `decideEnvelopeFollowup`（`scheduler.ts:601`）按前缀映射
  `reason ∈ {envelope-missing, both-present, clarify-malformed, port-validation}` → 回传 runner →
  `renderEnvelopeFollowupPrompt`（`prompt.ts:761`）按 `reason`/`hasClarifyChannel`/`clarifyDirective` 渲染同会话重锚。
- inline 模式（RFC-026）：反问 rerun 用 `--session <prior-id>` 续跑，尾块此前**恒为** `buildClarifyInlineReminder()`
  （`prompt.ts:508`，先于 hasClarifyChannel 判断）。本 RFC 必须重排，使 inline 的 **stop 轮**能首次拿到输出格式（见 §3.2）。

## 1. 设计总则

引入单一状态轴 **clarifyActive**：

```
clarifyActive ≡ (节点接了反问通道) ∧ (用户尚未点"停止反问") ∧ (本轮不是 review reject/iterate 复跑)
             ≡ renderUserPrompt/runNode 收到的 hasClarifyChannel === true   // 即 effectiveHasClarifyChannel
```

- `clarifyActive === true`：**强制反问模式**——只注入反问格式 + 强力指引；运行时拦截 output。
- `clarifyActive === false`（= stop 轮 / 无反问通道 / review 复跑）：注入输出格式；运行时按既有逻辑接受 output。

**scheduler 门控改一处**（实现期发现的真 bug，非纯测试问题）：原设计以为 `effectiveHasClarifyChannel = hasClarifyChannel
&& directive !== 'stop'` 已够；但 **review reject/iterate 复跑**也走反问通道 agent——该复跑要"改产出 v2 回应评审意见"，
若仍被强制 ask-back，其 `<workflow-output>` v2 会被运行时判 `clarify-required` 拒、评审 iterate 永远无法收敛。故加第三个合取项
`&& reviewContext === undefined`（reviewContext 由 `buildReviewPromptContext` 产出，仅 reject/iterate 复跑非空）。
review 复跑 ⇒ clarifyActive=false ⇒ 给输出格式、不拦截 output；agent **仍可**主动 emit `<workflow-clarify>`（runner 接受），
只是不被强制。这是 RFC-100 的必要正确性修复，回归网由 `review-iterate-drops-prior-clarify-history` 等 e2e 锁定。

其余改动集中在 shared 提示词层 + runner 运行时层 + followup 文案。

## 2. 改动清单（按文件）

### 2.1 `packages/shared/src/prompt.ts`（提示词层，self & cross 共用）

**(a) `renderUserPrompt` 尾块选择重排**（line 507-516）：

```ts
let trailing: string
if (input.hasClarifyChannel === true) {
  // clarifyActive：强制反问，只给反问格式 + 强力指引，绝不给 output 格式
  trailing = inlineMode
    ? buildClarifyInlineReminder()          // inline：会话已有强制块，发简短"再问一轮"提醒
    : buildMandatoryClarifyPreamble() + buildClarifyProtocolBlock()
} else {
  // stop 轮 或 无反问通道：给 output 格式
  // 注意：inline 的 stop 轮也走这里——此前各轮从未注入过 output 格式，这里首次完整给出
  trailing = buildProtocolBlock(input.agentOutputs, input.agentOutputKinds)
}
```

要点：`hasClarifyChannel` 判断**前置于** `inlineMode`，使 inline-stop（hasClarifyChannel=false ∧ mode=inline）
落入 else → `buildProtocolBlock`，拿到完整输出格式。inline-continue（hasClarifyChannel=true ∧ mode=inline）走简短提醒。
（其余 body/sections 渲染——含 inline 丢端口、answers 块、External Feedback、Prior Output——**全不动**。）

**(b) 新增 `buildMandatoryClarifyPreamble(): string`**——强制反问 + 富化指引（英文协议块）。要点（最终措辞实现时定稿）：

```
---
**This node is in MANDATORY ASK-BACK (clarify) mode.** The user wired a clarify channel because
they require you to interrogate intent BEFORE doing any work. Your ONLY valid reply this round is a
`<workflow-clarify>` envelope (format below). You may NOT emit `<workflow-output>` — the framework
will reject it and ask you again. You will be allowed to produce final output only after the user
explicitly clicks "Stop clarifying".

Your goal is ZERO guessing. Treat every unstated detail as a blocker you resolve by asking, never by assuming:
- **Investigate first, then ask.** Read the inputs, the repository, referenced files, and prior-round
  answers thoroughly. Use every skill and tool available to gather context yourself. Only ask the human
  about what you genuinely cannot determine on your own — but DO ask about everything in that category.
- **Go deep, not shallow.** Ask precise, consequential questions that pin down real decisions (naming,
  data shapes, API/contract details, UX behavior, edge cases, scope boundaries, acceptance criteria).
  Avoid generic, surface-level questions answerable from the inputs.
- **Pin down every detail before acting.** Do not begin the deliverable until each naming choice,
  technical option, UX decision, unstated constraint, and edge case is explicitly settled by the human.
  "Mostly clear" is not clear enough.
- **Never guess unfamiliar terms.** If you meet any proprietary term, acronym, internal system name,
  file, or convention you do not fully understand, you MUST ask what it means — never infer or invent one.
- **No assumptions, no fabrication, no silent defaults.** If you catch yourself hedging, writing "TBD",
  inventing a constraint the inputs didn't state, choosing between plausible alternatives without a stated
  preference, or rationalizing a "good enough" reading — STOP and turn it into a clarify question instead.
- **Asking back is success, not failure.** The expected, correct outcome of this round is a thorough
  `<workflow-clarify>` envelope. Returning early because you "have enough to start" defeats this node.
```

**(c) `buildClarifyProtocolBlock()` 文案更新**（line 630）——去掉"二选一（output 或 clarify）"框架，改"只反问"：
- 首句改为 `Ask back by emitting exactly one <workflow-clarify> block and nothing else (no <workflow-output> anywhere in the reply).`
- Hard rules 首条由"EITHER output OR clarify，NEVER both/neither"改为
  `Your reply MUST contain exactly one <workflow-clarify> block. Do NOT emit <workflow-output> this round — it will be rejected until the user stops clarifying.`
- 其余（JSON 模板、≤5 题 / 每题 2–4 选项、option 形状、prior-rounds 说明）**保留**。
  （注：cross-questioner 解析时题数不设上限，但本块"≤5"措辞是 self 沿用的软指引、解析器才是执行者——保持现状，不在本 RFC 动 cross 题数语义。）

**(d) `buildProtocolBlock` 去 bi-modal**（line 541-620）：删除 `hasClarifyChannel===true` 整个分支与该形参，
降为 `buildProtocolBlock(agentOutputs, agentOutputKinds?)` 只产输出格式。调用方仅剩 (a) 的 else 分支。

**(e) `buildClarifyInlineReminder()` 强化**（line 681）——现仅用于 inline-continue（stop 已改走 else）：
措辞改为无条件"必须再问一轮"：`...your next reply MUST be another <workflow-clarify> round. This node stays
in mandatory ask-back mode until the user clicks "Stop clarifying"; you cannot finalize output yet...`
（去掉原"either output if unblocked, or clarify"的二选一。）

**(f) `renderClarifyDirectiveTrailer('continue')` 去逃逸**（`clarify.ts:288-294`）——
删除第 3 条"零未决时你可以直接 output"软逃逸；改为：
```
### User directive: KEEP CLARIFYING
- The user clicked "Keep clarifying" — they want another round. This node is in mandatory ask-back
  mode: your next reply MUST be another `<workflow-clarify>` envelope.
- Keep probing every still-unresolved detail. Do not attempt `<workflow-output>` — the framework will
  reject it until the user stops clarifying.
```
`'stop'` trailer **不变**（stop 轮确应产 output，措辞正确，保持字节稳定）。

**(g) `renderEnvelopeFollowupPrompt` 加 `clarify-required` reason**（line 710-844）：
- `EnvelopeFollowupInput.reason` 联合类型加 `'clarify-required'`。
- `hasClarify && reason==='clarify-required'`：opening = "你上一条没有反问（emit 了 output / 没有 clarify 信封）。
  本节点处于强制反问模式，回复必须**只**是一个 `<workflow-clarify>` 信封。"
- hasClarify 分支 bullets 去掉"pinned down 时可 output"行，改"你的回复必须是单个 `<workflow-clarify>`，不要 emit `<workflow-output>`（会被拒）"。
- 既有 `clarifyDirective==='continue'` 强偏置 trailer 保留 / 顺势强化。

### 2.2 `packages/backend/src/services/runner.ts`（运行时拦截）

envelope 分类（line 1070-1108）改为先判 `clarifyActive = opts.hasClarifyChannel === true`：

```ts
const kind = detectEnvelopeKind(accumulatedText)
const clarifyActive = opts.hasClarifyChannel === true
if (clarifyActive && kind !== 'clarify') {
  // 强制反问模式下，唯一合法回复是 <workflow-clarify>。output/both/none 全判违规。
  status = 'failed'
  errorMessage =
    kind === 'output'
      ? 'clarify-required-output-emitted: node is in mandatory ask-back mode; emit <workflow-clarify>, not <workflow-output>'
      : kind === 'both'
        ? 'clarify-required-both-present: node is in mandatory ask-back mode; emit only <workflow-clarify>'
        : 'clarify-required-missing: node is in mandatory ask-back mode; reply must be a <workflow-clarify> envelope'
} else if (kind === 'clarify') {
  ...existing parse → clarifyResult / awaiting_human...   // 不变
} else if (kind === 'both') { ...existing... }            // 仅 !clarifyActive 可达
  else if (kind === 'none') { ...existing... }
  else { ...existing output happy path... }
```

- 统一前缀 `clarify-required`（三种细分仅用于日志可读性），由 scheduler 映射到 reason `'clarify-required'`。
- 导出常量 `CLARIFY_REQUIRED_PREFIX = 'clarify-required'`（runner 产出、scheduler 匹配、测试共用）。
- 非 clarifyActive（stop 轮 / 无通道）分支**逐字不变**，故无反问普通节点零回归。

### 2.3 `packages/backend/src/services/scheduler.ts`（followup 决策）

`decideEnvelopeFollowup`（line 601-628）：
- `EnvelopeFollowupDecision.reason` 联合加 `'clarify-required'`。
- 加分支：`if (m.startsWith(CLARIFY_REQUIRED_PREFIX)) return { followup: true, reason: 'clarify-required', failures: [] }`。
- 其余分支 + `runNode` 透传（`envelopeFollowupReason: followupDecision.reason`，line 2301）**不变**。

`followupClarifyDirective` 已仅在 `effectiveHasClarifyChannel` 为真时取值（line 2261），故 clarify-required followup
天然带 `hasClarifyChannel=true` 进 `renderEnvelopeFollowupPrompt`——文案走强制反问分支。✔

## 3. 关键数据流验证

### 3.1 isolated 模式（self 与 cross-questioner 同）

| 轮次 | directive | effectiveHasClarifyChannel | 注入尾块 | 运行时 |
|---|---|---|---|---|
| 第 1 轮（首跑） | 无 ctx | true | 强制块（preamble+clarify 格式） | output→拒；clarify→awaiting_human |
| 答后 continue | continue | true | 强制块 + answers(continue trailer) | 同上 |
| 答后 stop | stop | **false** | `buildProtocolBlock`（输出格式）+ answers(STOP trailer) | output→接受 done ✔ |

⇒ 强制至少 1 轮反问（用户必须在某轮答题时点 stop 才能放行——符合"人给齐细节才动手"的产品意图）。

### 3.2 inline 模式（RFC-026，self path）

- 第 1 轮永远是 fresh spawn（无 prior session）→ 注入完整强制块；会话内自此有反问格式、**从无输出格式**。
- continue 轮：`hasClarifyChannel=true ∧ mode=inline` → `buildClarifyInlineReminder()`（强化"再问一轮"）。
- **stop 轮**：`hasClarifyChannel=false ∧ mode=inline` → 重排后落 else → `buildProtocolBlock`，**首次**完整注入输出格式
  （连同 answers 的 STOP trailer）。若仍沿用旧"inline 优先"逻辑，会话里根本没有输出格式，Agent 无从产出正确端口——
  这正是重排 §2.1(a) 的必要性。runner 侧 stop 轮 `clarifyActive=false` → output happy path 接受。✔

### 3.3 cross-clarify questioner

questioner 经 `agentHasClarifyChannel=true` 与 self 同径；其 `buildPromptContext(consumerKind:'cross-questioner')`
同样写 `directive`，故 `effectiveHasClarifyChannel` 同样随 stop 翻假。⇒ §3.1 表对 cross-questioner 等价成立。
cross 的"持久 stop"（`hasPersistentStop`，cross-clarify **节点**侧直接 mint done，`scheduler.ts:1572`）不变；
本 RFC 只改 questioner **agent** 的注入与 output 拦截。

## 4. 失败模式与边界

- **顽固 Agent 反问期硬发 output**：被 runner 判 `clarify-required-*` → followup 同会话重锚要求反问 →
  仍不改则按 `maxRetries`（默认 3）耗尽后节点 `failed`。这是**有意**的——好过静默按臆测收尾（用户已确认接受）。
- **反问轮数 vs wrapper-loop maxIterations**：反问轮是 awaiting_human 后 mint 的新 node_run，**不**消耗 loop 迭代预算
  （loop 迭代由 wrapper 调度，反问 rerun 走 clarify-answer 因果），故"强制多轮反问"不会触顶 loop。
- **stop 轮 Agent 反而 emit clarify**（少见违逆）：`clarifyActive=false`，runner 仍按既有 `kind==='clarify'` 建会话→
  awaiting_human。此为**既有**行为，本 RFC 不扩大范围去堵（提示词层 stop 轮已不给 clarify 格式，isolated 下基本不会发生；
  inline 下属罕见违逆）。在 plan 里登记为已知边界。
- **无反问通道的普通节点**：`hasClarifyChannel` 恒 false → 注入 / 运行时逐字走旧路，零回归。

## 5. 测试策略（test-with-every-change）

### 改写的 byte-level / 文本回归基线（说明意图：RFC-100 收紧反问为强制）
- `packages/shared/tests/clarify-baseline-prompt-render.test.ts`：`renderClarifyDirectiveTrailer('continue')`
  3 行新文案（去逃逸）；`'stop'` 不变。
- `packages/shared/tests/clarify-prompt-inline.test.ts`、`prompt-inline-crossclarify-multirepo.test.ts`：
  inline-continue 强化提醒；**新增** inline-stop 走输出格式断言。
- `packages/backend/tests/clarify-prompt-injection.test.ts`、`clarify-prompt-wire-up.test.ts`：
  反问激活尾块**不含** `<workflow-output>` 端口清单；含强制块要点文本。
- `packages/shared/tests/cross-clarify-prompt-rfc056.test.ts`、`packages/backend/tests/cross-clarify-questioner-context.test.ts`：
  cross-questioner 注入与 self 一致（强制块、无输出格式）。
- `packages/backend/tests/protocol.test.ts`、`packages/shared/tests/build-protocol-block-via-handlers.test.ts`：
  `buildProtocolBlock` 降为 2 参、删 bi-modal 分支后的输出格式仍字节稳定（非反问路径）。
- `packages/shared/tests/envelope-followup-prompt.test.ts`、
  `packages/backend/tests/scheduler-envelope-followup-rfc039.test.ts` / `-branch.test.ts`：
  `clarify-required` reason 文案；hasClarify followup bullets 去 output 逃逸。

### 新增用例
- **强制块正向**（shared）：`renderUserPrompt({hasClarifyChannel:true})` 输出含 preamble 全部要点
  （调研 / 用尽 skill / 深入 / 细节敲定前不动手 / 专有词必问 / 零臆测 / 反问即成功），且**断言不含**
  `You MUST end your reply with a \`<workflow-output>\`` 与端口清单示例。
- **stop 给输出格式**（shared）：`hasClarifyChannel:false` + answers(stop) → 含 `<workflow-output>` 格式、不含强制块。
- **runner 拦截**（backend，`runner-clarify-branch.test.ts` 扩展）：clarifyActive + 桩 stdout 为 output →
  `failed` 且 errorMessage 前缀 `clarify-required`；clarifyActive + clarify → awaiting_human（不变）；
  非 clarifyActive + output → done（不变）。
- **followup 决策**（backend）：`decideEnvelopeFollowup({errorMessage:'clarify-required-output-emitted',...})`
  → `{followup:true, reason:'clarify-required'}`。
- **源码层文本兜底**（防 refactor 漂移）：断言 `prompt.ts` 含 `MANDATORY ASK-BACK`、`runner.ts` 含
  `CLARIFY_REQUIRED_PREFIX`、`buildProtocolBlock` 不再出现 `By default, your next reply should be (B)`。

### 门槛
`bun run typecheck && bun run test && bun run format:check` 全绿；推后按 [feedback_post_commit_ci_check] 立即查 CI
（含单二进制 build smoke + Playwright e2e）。

## 6. 兼容性 / 迁移

- 无 DB schema / 迁移改动。无前端改动（复用既有"停止反问"= `directive='stop'`）。
- 行为变更面：**仅**反问通道激活时的注入与运行时——对未挂反问节点的工作流零影响。
- 措辞类回归基线属"有意收紧"，在 test 顶注释链接 RFC-100 + 本 commit，使未来 refactor 一旦改红能看出意图。
