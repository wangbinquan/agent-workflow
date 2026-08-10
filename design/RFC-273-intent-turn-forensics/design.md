# RFC-273 · 技术设计

状态：Done（2026-08-10）。本文定义 evidence、scratch disposition 和 UI wire；不改变 changeset 正式上限。

## 1. 当前锚点

| 事实             | 当前源码                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------- |
| stdout drain/cap | `packages/backend/src/services/systemAgentRun.ts`：event text 超 cap 后整段不追加且无标志 |
| scratch 删除     | 同文件 finally：`result.status==='ok'` 即删除，早于 Intent envelope parse                 |
| envelope failure | `packages/backend/src/services/intent/turnEngine.ts`：missing 只写 `{code}`               |
| run metadata     | 同文件 `runMeta`：runtime/model/duration/exit/status/可选 stderr/resultError              |
| turn persistence | `intent_turns.content_json/run_meta_json/scratch_retained`，无需新列                      |
| retention config | `intentBuilderScratchRetentionHours`，默认 24 小时、最大 14 天                            |
| GC               | `services/intent/maintenance.ts#sweepIntentScratch` 与 `cli/start.ts` hourly owner        |
| UI               | `routes/intent.detail.tsx` error card 只显示 code + retry，Session tree 独立存在          |

## 2. Runtime evidence contract

### 2.1 Types

在 runtime-neutral types 定义：

```ts
type TerminalResultObservation = 'success' | 'error' | 'not-observed'

interface SystemAgentOutputEvidence {
  assistantTextSeen: boolean
  observedAssistantTextBytes: number
  retainedAssistantTextBytes: number
  eventTextCapHit: boolean
  unparsedStdoutSeen: boolean
  lastNormalizedEventKind: NormalizedEventKind | null
  lastRuntimeEventType: string | null
  terminalResult: TerminalResultObservation
}
```

`SystemAgentRunResult` 新增必填 `outputEvidence`。所有 early fail 使用全零 evidence，测试 mock 必须
显式给值；不让 optional 铺满调用点后永远得不到可靠回答。

### 2.2 Driver hooks

`RuntimeDriver` 新增可选纯函数：

```ts
observeSystemEvent?(line: string): {
  runtimeEventType: string | null
  terminalResult: 'success' | 'error' | null
}
```

实现复用同一个 JSON parse helper，不能在 `parseEvent`、terminal error 和 evidence 三处复制 dialect。
Claude：`assistant/user/system/result`，result 的 `is_error` 决定终态。OpenCode/direct codec：输出
record 的 closed type，最后 idle/step-finish 映射 success；无可证明终态则 null。

type 只接受 `[A-Za-z0-9._-]{1,64}`，其余置 null。hook 不返回 text/错误详情。

### 2.3 Counting

每条 parsed event：

1. `lastNormalizedEventKind=ev.kind`；
2. hook 有安全 type 时更新 last type；
3. `ev.text` 非空 ⇒ assistantTextSeen=true，observed 加完整 UTF-8 bytes；
4. 旧拼接条件不变：整段放得下才 append/增加 retained，否则 capHit=true；
5. observed/retained 使用 `saturatingAdd`，上限 `Number.MAX_SAFE_INTEGER`。

unparsed stdout 维持现有事件写入，同时只设 `unparsedStdoutSeen=true`；不能把任意日志行算成
assistant text。终态观察采用最后非 null verdict；error 不会被后续 success 覆盖。

## 3. Intent classification

纯函数：

```ts
classifyMissingEnvelope(evidence): MissingEnvelopeReason
```

判序：

1. capHit 或 observed > retained ⇒ `output-cap-hit`；
2. !assistantTextSeen ⇒ `no-assistant-text`；
3. terminalResult != not-observed ⇒ `terminal-without-envelope`；
4. assistantTextSeen ⇒ `assistant-stopped-without-envelope`；
5. unknown。

settle 内容：

```json
{
  "code": "intent-envelope-missing",
  "reason": "no-assistant-text"
}
```

evidence 完整对象只写 `runMeta.outputEvidence`，content 不复制数字。runMeta 无论 stderr 是否为空均
包含 evidence 和 `scratchRetentionHours`（仅在 retained 时）。DTO 仍是 record，无 DB migration。

## 4. Scratch two-phase disposition

### 4.1 Ownership

`runSystemAgent` 的通用 cleanup/reap barrier 继续负责 child/plan cleanup；Intent 通过现有
`retainScratchOnSuccess:true` 请求把成功 scratch 暂留。返回后只有 turnEngine 可决定目录去留。

新增 runtime-neutral helper：

```ts
releaseSystemAgentScratch({scratchDir, expectedParent, expectedName}):
  {removed: boolean; reason?: 'unsafe-path'|'remove-failed'}
```

它要求 absolute canonical parent、leaf == turnId、child 精确在 parent 下一层且无 NUL；失败不递归
删除任何别处。禁止在 turnEngine 裸 `rmSync(result.scratchDir)`。

### 4.2 Disposition table

| outcome                                                                            | keep?                                         |
| ---------------------------------------------------------------------------------- | --------------------------------------------- |
| questions parsed                                                                   | no                                            |
| changeset 通过正式 envelope/changeset schema，后续 draft/business validation error | no                                            |
| envelope missing/malformed                                                         | yes                                           |
| changeset/questions exclusivity violation                                          | yes                                           |
| changeset JSON unparseable / formal schema 或 bound error                          | yes                                           |
| run non-ok                                                                         | existing yes                                  |
| context superseded/cancel                                                          | no extra retention beyond existing run result |

调用 `settle` 前完成 disposition，传入最终 `scratchRetained`。安全删除失败时保留并 warn，但不把一个
有效 questions/changeset 改成 error；runMeta 记录 `scratchReleaseFailed:true`。

### 4.3 GC

daemon boot 在 recover orphan turns 后立即跑一次 sweep，随后维持 hourly。sweep 仍只按目录 mtime +
turn terminal/unknown 判定；running 永不删。日志只写 turnId leaf，不写完整路径。

## 5. Budget single source

定义共享于 doc renderer 与测试的常量：

```ts
INTENT_TURN_GUIDANCE = {
  maxOps: 8,
  maxWorkflowNodesCreatedOrReplaced: 6,
  targetChangesetBytes: 256 * 1024,
}
```

`buildIntentDoc` 渲染“Single-turn delivery budget”。workflow node 计数说明覆盖 create/update payload
中的完整 definition nodes；依赖资源 ops 仍计入 maxOps。明确“如果用户最终目标更大，提交可验证
slice，summary 列 remaining work，下一轮继续”。

server validation 不读取该常量；正式 schema 继续 64/2 MiB。反向测试必须证明 guidance 常量没有
渗入 parser limit。

## 6. UI

新增纯 mapper `intentFailureDiagnostic(turn, t)`：

- 按 code/reason 选本地化标题和建议；
- 从 `runMeta.outputEvidence` 做窄 schema safeParse，legacy/malformed 直接忽略；
- 显示 `observed / retained` 格式化字节、last kind/type、terminal result；
- `scratchRetained===true`（需 DTO 暴露；当前 row 已有但 route 未投影）显示保留期；
- raw stderr/resultError 仍只在现有 Session 诊断面，不在卡片重复。

shared `IntentTurnDto` 增 `scratchRetained:boolean`，route 直投影；legacy 数据默认 false。

## 7. 测试策略

- `systemAgentRun`：无 text、多 text、恰到 cap、跨 cap、terminal success/error、unparsed 行、early fail；
- driver observer：Claude/OpenCode 真实 fixture dialect，type 注入/超长拒绝；
- turnEngine：四 reason、stderr 空仍 evidence、每个 protocol disposition；
- scratch helper：traversal、symlink leaf、wrong parent、删除失败、成功；
- maintenance：boot sweep、running fence、retention edge；
- doc：常量值/拆批文案/历史和 nonce 不受影响；parser 反向大合法 case；
- frontend：zh/en 四 reason、legacy evidence、byte formatting、scratch notice、retry 保留。

## 8. 迁移与回滚

无 DB migration。新字段都在 JSON/DTO：旧 daemon 不认识新 runMeta 也不会改业务结果；新 UI 对旧行
缺 evidence 降级。回滚二进制后已保留 scratch 仍由同一目录/retention GC 清理。若 rollback 版本
route 不投影 `scratchRetained`，只少 UI 提示，不影响磁盘回收。
