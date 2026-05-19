# RFC-042 — 实施计划

> 配套 [proposal.md](./proposal.md) + [design.md](./design.md)。单 PR、按任务顺序编码 + 配套测试，三件套全绿后提 commit + push + 查 CI。

## 拆分原则

**单 PR 合并**。改动收敛于：1 个 shared 新函数 + 1 个 backend 新纯函数 + 3 处 backend 既有文件改动（runner / scheduler）+ 6 个新测试文件 + 1 个 mock-opencode 钩子追加。一次评审、单 commit `git revert` 即可回退。

零 schema / migration / WS / 前端 / e2e 改动——拆 PR 收益为负。

## 任务列表

按"shared → backend 纯函数 → runner → scheduler → 测试 → 收尾"顺序。

### RFC-042-T1 — shared `renderEnvelopeFollowupPrompt`

- `packages/shared/src/prompt.ts`：末尾追加 `EnvelopeFollowupInput` interface + `renderEnvelopeFollowupPrompt(input)` 函数（按 design.md §3.1.2 文案矩阵实现）。
- `packages/shared/src/index.ts`：barrel re-export 新函数 + 新 type。
- 测试：`packages/shared/tests/envelope-followup-prompt.test.ts` 6 case（按 design.md §5.1）。
- 验证：`bun --filter @agent-workflow/shared test` + `bun run typecheck` 全绿。

### RFC-042-T2 — backend 纯函数 `decideEnvelopeFollowup`

- `packages/backend/src/services/scheduler.ts`：在文件顶部 helper 区（`isFresherNodeRun` 上方或邻近）追加 `PreviousAttemptShape` interface + `EnvelopeFollowupDecision` 类型 + `decideEnvelopeFollowup(prev)` 纯函数（按 design.md §3.3.1）。
- 测试：合并进 `packages/backend/tests/scheduler-envelope-followup-branch.test.ts` 前半部分（design.md §5.2 case 1-8 纯函数判定）。
- 验证：`bun --filter @agent-workflow/backend test scheduler-envelope-followup-branch` 全绿。

### RFC-042-T3 — runner 新入参 + 渲染分支

- `packages/backend/src/services/runner.ts`：
  - `RunNodeOptions` interface 末尾加 `envelopeFollowup?` / `envelopeFollowupReason?` / `envelopeFollowupClarifyDirective?` 三字段（按 design.md §3.2）。
  - `runNode` 内 prompt 渲染分支：当 `opts.envelopeFollowup === true` 时调 `renderEnvelopeFollowupPrompt`，否则照旧 `renderUserPrompt`。
  - inventory 插件加载分支条件改为 `if (isAgentRunKind(inventoryNodeKind) && opts.envelopeFollowup !== true)`。
- 测试：`packages/backend/tests/runner-envelope-followup.test.ts` 4 case（按 design.md §5.3）。
- 验证：`bun --filter @agent-workflow/backend test runner-envelope-followup` 全绿；既有 `runner-resume-session-flag.test.ts` + `runner-retry-with-rollback.test.ts` 零退化。

### RFC-042-T4 — scheduler attempt 循环 followup 分支

- `packages/backend/src/services/scheduler.ts`：
  - 改 line 632 默认：`pickNumber(node, 'retries') ?? 0` → `?? 3`。
  - 改内层 attempt 循环（line 703-896 区间）：按 design.md §3.3.2 加 followup 决策、events 表审计行写入、rollback / pre-snapshot 仅在 NON-followup 路径执行、runNode 调用按是否 followup 切两套入参。
  - **不**改 RFC-026 inline-mode resumeSessionId 路径（保留 `decideResumeSessionId` 调用，followup 路径独立判定不复用它）。
- 测试：合并进 `packages/backend/tests/scheduler-envelope-followup-branch.test.ts` 后半部分（design.md §5.2 case 9-12 集成）+ `scheduler-default-retries.test.ts` 4 case（design.md §5.4）。
- 验证：`bun --filter @agent-workflow/backend test scheduler-` 全绿；现有 `scheduler-clarify-inline.test.ts` / `scheduler-rfc040-wrapper-await.test.ts` / `scheduler-retry-*.test.ts` 零退化。

### RFC-042-T5 — RFC-039 偏向穿透 + events 审计行 + grep 守卫

- 测试：
  - `packages/backend/tests/scheduler-envelope-followup-rfc039.test.ts` 2 case（design.md §5.5）。
  - `packages/backend/tests/node-run-events-followup.test.ts` 1 case（design.md §5.6）。
  - `packages/backend/tests/envelope-followup-source-grep.test.ts` 2 case（design.md §5.7）。
- 验证：全部新加 test 一次过。

### RFC-042-T6 — mock-opencode 钩子追加

- `packages/backend/tests/fixtures/mock-opencode.ts`：加 `MOCK_OPENCODE_EXPECT_FOLLOWUP_ARGV` + `MOCK_OPENCODE_FOLLOWUP_REPLY_FILE` 两个 env 钩子（按 design.md §3.4）。
- 验证：T3 / T4 / T5 的测试依赖这两个钩子；它们一起跑过即说明钩子工作正常。

### RFC-042-T7 — 套件零退化 + 三件套 + 自查

- 跑 `bun run typecheck && bun run test && bun run format:check`，三件套全绿。
- 跑 `bun --filter @agent-workflow/backend test` 套件总数 +20~25（具体随测试 case 落地）。
- 跑 `bun --filter @agent-workflow/shared test` 套件 +6。
- 既有 1411+ backend test + 80+ shared test 零退化。
- 跑 `bun --filter @agent-workflow/backend lint`（如配置存在）/ ESLint 规则零新增违例。

### RFC-042-T8 — STATE.md / design/plan.md 落 Done

- `design/plan.md` 的 "RFC 索引" 表新增 RFC-042 行；状态实现完毕 → In Progress → Done。
- `STATE.md` 顶部 "进行中 RFC" 段在实现期间挂一行；提 PR 后移到"已完成 RFC"区段。
- 不修改 design/proposal.md / design/design.md（本 RFC 不影响顶层产品 / 技术总图）。

### RFC-042-T9 — commit / push / CI

- commit message：`feat(runner): RFC-042 envelope 缺失同 session 追问 + 默认 retries=3`，body 描述 followup 触发条件 + 默认 retries 变更 + 测试增量。Co-Authored-By 行按 CLAUDE.md 模板。
- 按路径精确 `git add`（不用 `git add .`），保护多人 working tree（参考 [feedback_dont_delete_others_code_for_ci]）。
- push 后立刻按 [feedback_post_commit_ci_check] 查 `gh run list --workflow=ci.yml --branch=main -L 1` + watch 直到 conclusion。
- 六 jobs 全绿前不开下一 RFC。

## 验收清单

落 PR 前自查：

- [ ] `bun run typecheck` 全绿
- [ ] `bun run test` 全绿（shared + backend + frontend）
- [ ] `bun run format:check` 全绿
- [ ] `decideEnvelopeFollowup` 8 case 全过
- [ ] `renderEnvelopeFollowupPrompt` 6 case 全过
- [ ] scheduler 集成 8 case 全过（含 followup 成功 / followup 失败降级 / retries=0 不进入 / crash 不进入 / 无 session 不进入 / 无 text 不进入）
- [ ] runner argv `--session <id>` 在 followup 路径正确透传，promptText 不含 inputs
- [ ] 默认 retries=3 fallback 在四种 retries 配置下行为正确
- [ ] RFC-039 `Keep clarifying` 短句在 directive=continue 时进 followup prompt、stop 时不进
- [ ] `[rfc042/envelope-followup]` 审计行在 `node_run_events` 表里写得到
- [ ] 源码层 grep 守卫两条都过
- [ ] 既有 RFC-005 / RFC-014 / RFC-023 / RFC-026 / RFC-039 / RFC-040 测试零退化
- [ ] 多人协作：仅 `git add` 自己 8~10 个文件 + RFC-042 目录 + STATE.md + design/plan.md，绝不动其它 working tree 修改

## 回滚预案

- 单 commit revert 立即生效；followup 分支整体回退，retries 默认回 0。
- 不存在 schema / migration / WS 协议残留。
- 已有 `[rfc042/envelope-followup]` events 行作为字符串保留，不影响 RFC-040 / RFC-027 / RFC-029 等其它 events 消费者。
