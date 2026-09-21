# RFC-367 — 任务分解

单 PR（单批提交到 main），子任务按依赖顺序推进。每个子任务**自带测试**（CLAUDE.md
§Test-with-every-change），测试由 CI 跑绿为准。

## 设计门记录（2026-09-21）

本仓的 Codex 设计门当日**不可用**：`~/.codex/config.toml` 钉的账号模型 `gpt-6-astra` 要求更新版
CLI，本机 `codex-cli 0.147.0` 被 400 顶回（`The 'gpt-6-astra' model requires a newer version of
Codex`），退回 `gpt-5-codex` 又被 ChatGPT 鉴权拒绝。按 `docs/dev-gotchas.md` §Codex 记录的替代
姿势，改用**全新上下文的 Claude general-purpose 子代理**跑同强度对抗评审（只审功能、明令禁止
任何安全类检视、按路径限定只看 RFC-367 三份文档与其引用源码）。

**结论：FAIL（2 P1 / 5 P2 / 7 P3）**，全部 findings 已逐条核实并回写：

| 级别 | finding                                             | 处置                                                                 |
| ---- | --------------------------------------------------- | -------------------------------------------------------------------- |
| P1   | 释放规则会删掉 cleanup 失败时被刻意保留的 scratch    | design §3.1 改为按状态表释放（`spawn-failed` / `unreaped` 保留）       |
| P1   | 每轮独立 scratch 会让 claude-code 的 `--resume` 落空 | design §3 改为整链共用一个 scratch + `retainScratchOnSuccess`          |
| P2   | AC-7「结构上不可能」过强（sink 无上限、eventText 有）| proposal AC-7 改写为「除 `eventTextCapHit` 边界外」                    |
| P2   | 删文件会让 `rfc143` 源码锁 ENOENT 抛错               | T7 增「改写该守卫」                                                    |
| P2   | 提示词有 SHA-256 基线锁                              | T3 增「同批更新 `BASELINE_SHA256`」                                    |
| P2   | 队列最坏阻塞 20h（5 head × 4 轮 × 1h），非 4h        | design §3.2：超时改为整次蒸馏总预算（用户裁决）                        |
| P2   | 全部候选 zod 失败仍是「绿的 0 候选」                 | AC-14：判 job 失败（用户裁决）                                         |
| P3×7 | 常量导出点自相矛盾 / 判定序 / 分类器误用 / 两条行为差遗漏 / T1 漏第三处编译点 / marker 行 NOT NULL / **C1 事实错误** | 逐条改进 design §0/§2.3/§2.5/§2.7/§2.8 与 proposal §4（C1 改为「无能力损失」） |

两条被**推翻的原始前提**（均经源码复核）：①`runSystemAgent` 仍会调
`driver.captureSessionsToSink`，子会话清扫不丢；②`runScratchOrphanGc` 会扫 `<appHome>/scratch`，
distiller scratch 有 GC owner。

## 依赖图

```
T1(shared reason) ─┐
T2(resume 透传)   ─┤
T2b(分类器归位)   ─┼→ T6(runDistill 编排) → T7(端口/装配收缩) → T9(测试迁移) → T10(登记)
T3(提示词)        ─┤                               ↑
T4(解析纯函数)    ─┘                               │
T5(事件 sink) ─────────────────────────────────────┘
T8(会话页 promptText) 独立
```

## 子任务

### RFC-367-T1 — shared 新增 `port-missing` 补问 reason

- `packages/shared/src/prompt.ts` **三处**（设计门 P3-6：初稿只列了两处，漏的那处是编译期硬错）：
  ①`EnvelopeFollowupReason` 增 `'port-missing'`；②`renderEnvelopeFollowupPrompt` 的窄化链 +
  开场白分支 + bullets 分支 + label；③`renderSessionRestartNotice` 的穷尽 switch 必须补
  `case 'port-missing'`，否则 `const exhausted: never = reason` 直接 typecheck 红。
- **不动** `FollowupFailureCode` / `FOLLOWUP_POLICY`。
- 测试：新 reason 的文案断言（含 `<port name=` 字面）；既有 7 个 reason 的文案快照全部不变。

### RFC-367-T2 — `runSystemAgent` 透传 `resumeSessionId`

- `services/systemAgentRun.ts`：`SystemAgentRunOptions.resumeSessionId?: string`，在
  `defaultUnifiedCtx()` 按既有可选字段风格 spread。
- 测试：传/不传两例，断言 `buildSpawn` 收到的 ctx（不传时逐字段与今天相同，保 intent 零影响）。

### RFC-367-T3 — 提示词补齐字面语法

- `modules/memory/domain/distillPrompt.ts`：系统提示词末段改写（design §4.1），业务焦点/类目/
  REJECT 等被 grep 锁定的字面量逐字保留。
- `application/distill/memoryDistiller.ts::buildDistillerUserPrompt`：尾部改用
  `buildProtocolBlock(['candidates'], undefined, envelopeNonce)`（design §4.2）。
- **同批更新 `BASELINE_SHA256`**（设计门 P2-3）：
  `tests/memory-distiller-grep-output-lang-directive.test.ts:62` 锁的是
  `DISTILLER_SYSTEM_PROMPT` 的**整体 SHA-256**，改提示词必红；该测试自己的头注释写明「有意修改
  时同 PR 更新基线」。
- 测试：系统提示词三层嵌套字面 + 「no ``` code fence」grep 守卫；用户提示词含 `Format:` 与
  `</workflow-output>`；既有业务焦点 / 语言指令守卫全绿。

### RFC-367-T2b — `classifyMissingEnvelope` 归位到中立同侧

- 把 `MissingEnvelopeReason` + `classifyMissingEnvelope` 从
  `modules/intent/application/turnEngine.ts` 迁到 `services/systemAgentRun.ts`（design §2.8），
  intent 改 import（零行为变更）。
- 测试：既有 intent 用例全绿；新增该纯函数的五个取值逐一断言（若原处已有则整体搬迁）。

### RFC-367-T4 — `parseDistillerCandidates` 判别式解析

- 新函数替换 `parseDistillerOutput`：删 driver 逐行走查与 `protocol` 入参，改用公共
  `parseEnvelope(envelope, ['candidates'], nonce)`，返回 `DistillerOutputParse`（design §2.3）。
- 新增 `DistillProtocolFailureCode` / `DistillerProtocolError`。
- 测试：八类输入逐一断言；三条畸形 fixture 取自 2026-09-21 生产捕获，文件头写明取证来源
  （job `01M0TTNDPPSW8BYJ74ZFAFJ73N` 等）与「为什么这条测试存在」。

### RFC-367-T5 — 实时事件 sink

- 新 `modules/memory/infrastructure/memoryDistillSessionEventSink.ts`（design §2.5）：
  `append` / `setRootSessionId`（含 root 未知前的缓冲 flush）/ `markTerminal`（写既有
  `DISTILL_CAPTURE_FAILED_KIND` marker）/ promise tail 串行化。
- 测试：缓冲 flush、root 始终缺失时丢弃且不抛、marker 行写入、并发 append 顺序。

### RFC-367-T6 — `runDistill` 迁到 `runSystemAgent` + 补问循环

- `RunDistillOptions`：`spawnFn` → `runFn?: (opts: SystemAgentRunOptions) => Promise<SystemAgentRunResult>`
  （与 intent / change-narrative 同名同形）；保留 `timeoutMs` / `protocol` / `runtimeBinary` /
  `model` / `isSandbox` / `sourceContextBudget` / `envelopeNonce` 既有入参语义不变。
- 实现 design §3 的轮次循环、`reasonFor` 映射（含 malformed 优先于 missing 的判定序）、
  `mapRunStatus`、`detailFor`（`envelope-missing` 才调 `classifyMissingEnvelope`，其余只读
  `eventTextCapHit`）。
- **整条补问链共用一个 `scratchName`**，每轮传 `retainScratchOnSuccess: true`，链终止时按
  design §3.1 的状态表释放（`unreaped` / `spawn-failed` 保留）。
- **总预算**：进门算 `deadline = now + timeoutMs`，每轮传剩余额度（design §3.2）。
- **AC-14**：`rawCandidates.length > 0 && persisted.length === 0` → 抛错让 job 失败，
  `last_error` 带条数与首条拒因。
- `saveSpawnResult` 取 `capturedSessionId` / `exitCode` / `stderrTail`（替代
  `extractFirstSessionIdFromStdout`）。
- 删除 design §2.7 退役清单中属于本文件的符号。
- 测试：L2 编排六组（design §6）。

### RFC-367-T7 — 端口与装配收缩

- `application/ports/distillWorkStore.ts`：删 `captureSession` / `MemoryDistillCaptureInput`，
  加 `eventSinkFor(...)`。
- `infrastructure/memoryDistillWorkStore.ts`：实现 `eventSinkFor`，删对
  `createMemoryDistillSessionCapture` 的接线。
- 删 `infrastructure/memoryDistillSessionCapture.ts`、`services/runtime/opencode/distillSessionCapture.ts`、
  `RuntimeDriver.captureDistillSession`、`DistillSessionCaptureContext/Sink` 类型。
- `services/runtime/index.ts` 的 `DISTILL_CAPTURE_FAILED_KIND` re-export 改为从
  `modules/runtime-management/public/types` 转出（设计门 P3-1）。
- **改写 `tests/rfc143-runtime-driver-capability.test.ts:344-348`**（设计门 P2-2）：它
  `readFileSync` 读被删的文件，删了会 ENOENT **抛错**；改为断言新不变量「memory 模块不再出现
  `captureDistillSession`」。
- 测试：装配面 typecheck + 既有 store 测试迁移；确认 `getJobSessionView` 的 `captureFailed` 仍工作。

### RFC-367-T8 — 会话页保留首个 user turn

- `application/distillQueries.ts::getJobSessionView`：`parseSessionTree({ promptText: <job.userPromptMd> })`
  替代今天的 `promptText: null`（补偿能力影响清单 C2）。
- 测试：有 `user_prompt_md` 的 job，其会话树首条为 user turn。

### RFC-367-T9 — 既有测试迁移

- `memory-distiller.test.ts`、`memory-distill-scheduler.test.ts`、
  `memory-distill-scheduler-output-lang.test.ts`、`memory-distiller-capture-rfc043.test.ts`、
  `memory-distiller-output-lang-directive.test.ts`、`memory-distiller-source-context.test.ts`、
  `distill-session-capture.test.ts`、`rfc349-memory-distill-postgresql-adapter.test.ts`、
  `memory-distill-timeout-config.test.ts`（并发 session 新增）中所有 `spawnFn` 用法改 `runFn`。
- `tests/routes-memory-distill-job-detail.test.ts` 的 `DISTILL_CAPTURE_FAILED_KIND` import 跟随
  T7 的 re-export 变更核对一遍。
- `distill-session-capture.test.ts` 若只覆盖被退役的 SQLite 走查则整体删除，并在 T5 的新测试头
  注释里写明取代关系。
- L3 双库调度器用例（design §6）。
- **并发提醒**：`memory-distill-timeout-config.test.ts` 与 `helpers/memoryDistill.ts` 属并发
  session（`config.memoryDistillTimeoutMs` 那条线）的在制品。实现本 RFC 时以**当时工作树里
  实际存在的文件**为准迁移 seam，不回退、不删除他人改动；`RunDistillOptions.timeoutMs` /
  `DistillTickOptions.timeoutMs` / `MemoryDistillWorkerOptions.timeoutMs` 全部原样保留并继续
  透传给 `runFn`（`SystemAgentRunOptions.timeoutMs`）。

### RFC-367-T9b — 架构账本重生成（提交前置，**受并发制约**）

- 本 RFC 新增两条 ledger 可见的 import 边（`intent/application/turnEngine → services/systemAgentRun#classifyMissingEnvelope`、
  `memory/application/distill/memoryDistiller → services/systemAgentRun`），`architecture/*.json`
  因此必失效——`packages/backend/tests/architecture/rfc294-canonical-manifests.test.ts` 与
  `rfc317-architecture-ledgers.test.ts` 会红。提交前跑 `bun run architecture:write`。
- **硬约束**：账本是「从当前工作树源码可复算的确定性投影」。共享树上只要还有**他人未提交的源码改动**，
  重生成就会把对方的 delta 一起写进账本，而 CI 在干净 checkout 上只看到我这份源码 → 必红。
  因此重生成必须在「工作树里除我之外无未提交源码改动」时做，否则本批一行都不能提交。
  （2026-09-21 实况：并发 session 正在实现 RFC-366，其 WIP 覆盖 memory 模块多文件。）

### RFC-367-T10 — 文档与索引登记

- `design/plan.md` RFC 索引加 RFC-367 行（状态 Draft→实现完成后 Done）。
- `STATE.md` 顶部「进行中 RFC」行；完工后补已完成条目。
- `docs/dev-gotchas.md`：沉淀通用坑——「给模型的协议块必须给完整字面嵌套语法，只给 open tag 会让
  弱模型自造标签名/漏 port」「解析失败只 warn 的路径等于静默丢数据，协议层失败必须能红」。

## 验收清单

- [x] AC-1 提示词字面语法 grep 守卫（T3）
- [x] AC-2 无 port → 不再 markDone（T4+T6+T9-L3）
- [x] AC-3 同会话补问，resume 同 session，≤3 次（T6）
- [x] AC-4 补问成功 → 候选落库 + done（T6+T9-L3）
- [x] AC-5 用尽 → failed + last_error 含 code/轮次 + 退避（T6+T9-L3）
- [x] AC-6 `{"candidates": []}` → done 且不补问（T4+T6）
- [ ] AC-7 解析输入 == 会话页文本（T5+T6+T9-L3）
- [ ] AC-8 claude-code 有事件行（T5+T9-L3）
- [x] AC-9 无 session id → 直接失败（T6）
- [ ] AC-10 历史 done 任务零改写（全程无写历史行的代码路径；T9 断言）
- [x] AC-11 三种生产畸形形态各一条回归用例（T4+T9）
- [x] AC-12 scratch 逐状态释放/保留（T6）
- [ ] T9b 账本重生成后 `architecture/` 守卫全绿（且重生成时树内无他人未提交源码）
- [x] AC-14 全部候选校验失败 → job failed + last_error（T6）
- [ ] AC-13 `last_error` 能区分「格式没写对」与「输出超上限被截断」（T2b+T6）
- [ ] 能力影响清单 C1–C4 经用户逐项确认（本 RFC 批准即视为确认）
- [x] `bunx prettier --check` + `bunx eslint --max-warnings 0` 对本次改动文件（35 个文件全绿）
- [ ] push 后按 exact SHA 盯 CI 至绿

## PR 拆分建议

默认单 PR。若 CI 红且需要缩小归因面，可按 `T1+T2`（共享件，零行为变更）→ `T3+T4+T5`（纯函数/新
文件）→ `T6+T7+T8+T9`（切换 + 退役）拆三批，每批各自绿 CI。
