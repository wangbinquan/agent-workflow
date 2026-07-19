# RFC-200 — 任务分解

## 依赖图

```
T1 (nonce infra: 列+迁移+runner 生成/持久化/透传)
     └─> T2 (emit tag 单源 + 协议文案 nonce 化)
     └─> T3 (envelope.ts parse 全 API nonce 化)   ← T2/T3 可并行,均依赖 T1 的 RenderPromptInput.envelopeNonce 字段
T4 (promptFencing.ts 原语 + 消毒 + 协议 note)      ← 独立,可先落(纯函数,无依赖)
     └─> T5 (fence 接线各点 emit 侧)                ← 依赖 T4 + T1(nonce)
T6 (golden 重生成 + 集成/迁移/e2e 测试 + 二进制 smoke)  ← 依赖 T2/T3/T5 全部落地
T7 (frontend PromptPreview 占位 nonce)             ← 依赖 T2
```

## 子任务

- **RFC-200-T1 — nonce 基座**
  - 迁移 `node_runs.envelope_nonce TEXT`（单 statement + `--> statement-breakpoint`）；`_journal.json` +1。
  - `RenderPromptInput.envelopeNonce?: string`（shared）。
  - runner：`runNode` 生成 `crypto.randomBytes(8).toString('hex')`、持久化列、透传 `renderUserPrompt` 与 `envelope.ts` 调用；followup / resume 复用同 run 已存 nonce。
  - 测试：列存在 + 生成非空 + resume 复用 + 迁移全套后端 `bun test`（防 journal↔files 不匹配级联,见既有约定）。

- **RFC-200-T2 — emit tag 单源 + 协议 nonce**
  - `envelopeOpenTag(nonce?)`/`clarifyOpenTag(nonce?)`；`CLARIFY_FORMAT_EXAMPLE`→`clarifyFormatExample(nonce?)`。
  - 改 `buildProtocolBlock`/`buildClarifyProtocolBlock`/`buildOptionalDualProtocolBlock`/`renderEnvelopeFollowupPrompt` + workgroup `ENVELOPE_RULES`/`WG_CLARIFY_BLOCK`。
  - 内置 agent body（orchestrator/merge/fusion）文案改为「shape specified in your user prompt」。
  - 测试：nonce 有值渲染带属性;nonce 空字节回退。

- **RFC-200-T3 — parse nonce 化**
  - `envelope.ts` 所有 EMIT/PARSE 正则与函数（`detectEnvelopeKind`/`extractLastEnvelope`/`extractClarifyEnvelopeBody`/`parseEnvelope`）加 `nonce?`;`envelopeRe(nonce?)` 工厂。
  - 调用方（runner）传 nonce。
  - 测试：§8-1/§8-2 全套(伪造 bare 回显不被采信 + last-wins 同 nonce 内)。

- **RFC-200-T4 — 围栏原语**（可最先落,纯函数）
  - `promptFencing.ts`：`fenceUntrusted`、`AW_INPUT_PROTOCOL_NOTE`、闭合剥离、行首中和、单行化。nonce 空退化。
  - 测试：§8-3 全套。

- **RFC-200-T5 — fence 接线**
  - 按 design §4.2 表逐点改造;`renderUserPrompt` 注入一次 `AW_INPUT_PROTOCOL_NOTE`。
  - 结构块按 §4.3 策略(整包 vs 单行化)。
  - 测试：§8-4 源码锁 + §8-5 集成。

- **RFC-200-T6 — golden/集成/迁移/e2e**
  - 确定性 nonce 注入路径(测试传固定值);重生成 golden,人工 diff。
  - `rfc099-prompt-isolation` 保持绿。
  - e2e：注入含裸信封的仓库文件的 Code→Audit→Fix;二进制 smoke。

- **RFC-200-T7 — frontend**
  - PromptPreview 传占位 nonce(`PREVIEW`);vitest 断言预览含属性。

## PR 拆分建议

- **PR-A**：T1 + T4（基座 + 纯原语,低耦合,先合）。
- **PR-B**：T2 + T3（emit/parse nonce,配套 golden 局部重生成）。
- **PR-C**：T5 + T7（fence 接线 + 前端）。
- **PR-D**：T6（e2e/二进制/最终 golden 收口）。
- 每个 PR 自带其测试跑绿;commit 前缀 `feat(prompt): RFC-200 …`。

## 验收清单

- [x] `node_runs.envelope_nonce` 迁移 + journal +1；新 run 持久化随机 nonce，resume/followup 复用。
- [x] 新 run 信封带 nonce；bare/错 nonce 被解析忽略（单测锁）。
- [x] 回显伪造 bare 信封不改判（真实 runner / Playwright e2e 实证）。
- [x] §4.2 各不可信点全部经 `fenceUntrusted`；源码锁断言无裸拼接，并补齐 `commitPush` / `memoryDistiller` 两条旁路。
- [x] 围栏内 `</aw-input>` / `## Your assignment` / 内嵌信封均无法逃逸（单测）。
- [x] nonce 空全 API 字节等价旧行为（在途 run 兼容）。
- [x] golden 重生成后人工 diff 仅 nonce + 围栏差异。
- [x] `rfc099-prompt-isolation` 绿（身份隔离不回归）。
- [ ] `bun run typecheck && bun run test && bun run format:check` 全绿 + 二进制 smoke + Playwright e2e 绿;push 后按 SHA 查 CI。

## 实现记录（2026-07-19）

- 基座：`0c4ebcce`（T4 围栏/消毒原语）、`e149bd40`（T1 nonce 迁移与持久化）。
- 完整接线：`cc25c302`（T2/T3/T5/T6/T7），覆盖通用/review/prior/clarify/memory/workgroup/fusion/orchestrator/merge prompt、runner emit/parse/followup、PromptPreview，以及最初清单外的 commit-message 与 memory-distiller 内部 agent 旁路。
- RFC-200 自有门禁全绿：backend 聚焦回归 `117 pass / 0 fail`、shared `24 pass / 0 fail`、frontend PromptPreview `6 pass / 0 fail`、workspace typecheck、backend lint、变更文件 format/diff-check、commit-push Chromium e2e `1 pass / 0 fail`；此前完整 backend 基线 `5841 pass / 22 skip / 0 fail`，完整 Playwright 基线 `118 pass / 22 skip`。
- 当前共享工作树的最终全量门仍未勾选：并行 RFC-199 修改使最新 backend 全量剩 1 个稳定 source-lock 红项（另 1 个 registry 竞态定向复跑已绿）、shared 全量剩 1 个 wrapper-git 契约红项，完整 Playwright 剩 4 个 RFC-199 失败；这些文件不属于 RFC-200，未越界修改。尚未 push，因此没有 exact-SHA CI 结果。

## 与并发工作的边界

- 本 RFC 与 **RFC-199（workflow editor zero-guidance UX）** 无范围重叠(前者动 prompt 组装/解析,后者动画布 UX)。但二者都在共享工作树并发落地,提交须精确 pathspec、单步 `git commit -- <paths>`,不扫入对方改动(见 CLAUDE.md 多人协作原则)。
- RFC 索引(`design/plan.md`)与 `STATE.md` 的登记行在**提交时**再加,避免与 RFC-199 对这两个共享索引的并发编辑发生工作树竞争。
