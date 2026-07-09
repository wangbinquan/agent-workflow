# RFC-W001 — 任务分解

用户授权直接实现，无需批准。按依赖顺序执行。

## T1: 创建 `tests/helpers/stub-runtime.ts` 跨平台 stub 工具

- 新建 helper 模块，提供 `writeStubOpencode()` / `writeFakeNpm()` / `writeStubScript()`
- POSIX 写 `.sh`，Windows 写 `.cmd` + `.js`
- 包含所有常见 stub 模式：version-only、run-with-envelope、clarify、hang、fail

## T2: 修复 fake-npm.sh 相关测试（~31 fail）

- `agent-plugin-not-found.test.ts`
- `plugin-closure.test.ts`
- `plugin-service.test.ts`
- `plugins-http.test.ts`
- `scheduler-plugin-preload.test.ts`
- `services/pluginInstaller.test.ts`

改用 `writeFakeNpm()` helper，PATH 注入逻辑适配 Windows（`.cmd` 文件在 PATH 中可直接执行）。

## T3: 修复 stub-opencode.sh 相关测试（~200+ fail，最大批次）

所有创建 `stub-opencode.sh` 的测试改用 `writeStubOpencode()` helper。涉及文件：
- `fusion-engine.test.ts`
- `opencode-models.test.ts`
- `rerun-prior-output-e2e.test.ts`
- `review-iterate-*.test.ts`（5个）
- `review-state-machine.test.ts`
- `reviews-iterate-mints-new-run.test.ts`
- `rfc107-url-upload-multipart.test.ts`
- `rfc135-runtimes-status.test.ts`
- `runtime-routes.test.ts`
- `scheduler-commit-push.test.ts`
- `start-task-url.test.ts`
- `task-fetch-before-launch.test.ts`
- `task-start-pre-worktree.test.ts`
- `task-start-working-branch.test.ts`
- `tasks-multipart.test.ts`
- 以及所有 scheduler/runner 集成测试（它们通过 test harness 间接使用 stub）

## T4: 修复 chmod mode 断言（~10 fail）

- `auth-token.test.ts`
- `daemon-start.test.ts`
- `cli.test.ts`

POSIX 保留 mode 断言，Windows 改为 ACL 断言或 skip。

## T5: 修复 symlink 相关测试（~8 fail）

- `rfc103-envelope-symlink-containment.test.ts`
- `rfc107-url-upload-multipart.test.ts`
- `worktree-files-service.test.ts`
- `envelope-parse-md-edge-cases.test.ts`
- `envelope-resolve-port-detailed.test.ts`
- `envelope-resolve-port-md-path.test.ts`
- `security-fuzz.test.ts`

Windows 上 junction 替代 symlink，或 skip 并标注。

## T6: 修复 pgrep 相关测试（~2 fail）

- `rfc135-runtimes-status.test.ts`

Windows 用 wmic/tasklist 替代 pgrep。

## T7: 修复 git 长路径相关测试（~6 fail）

- `cached-repos-http.test.ts`
- `cached-repos-http-batch.test.ts`
- `cached-repos-http-submodule.test.ts`

缩短 tmpdir 前缀 + git clone 加 `core.longPaths=true`。

## T8: 修复其他零散失败

逐个排查修复。

## T9: 更新 CI

- `check-windows` job 改为跑全量 `bun test`
- 验证 Windows CI 全绿

## 执行顺序

T1 → T2 + T4 + T5 + T6 + T7（可并行）→ T3（依赖 T1）→ T8 → T9

---

## 完成状态（2026-07-09）

**T1-T8 全部落地，全量 `bun test` 在 Windows 本地绿。** 跨平台 stub helper（T1）、fake-npm/stub-opencode chmod+symlink+pgrep+长路径适配（T2-T7）、零散修复（T8）均已交付。共 272 文件改动（2065 insertions / 1348 deletions）。

### T8 期间额外修的生产代码 Windows bug（超出原 plan 列表，取证后补修）

- **`commitPushRunner.ts`**：commit 与 `materializeTree` 的 `reset --mixed` 竞态——sibling merge-back 的 reset 会在 commit-agent 的 LLM 消息生成期间 unstage 已暂存变更，导致 `git commit` 空 index 失败。改为 commit 失败时在 writeSem 下 re-stage + 重试一次（RFC-130 §7 短锁纪律，不在 LLM 跨程持锁）。回归锁：`scheduler-commit-push.test.ts`。
- **`envelope.ts` `resolveWorktreePath`**：`relative()` 在 Windows 返回反斜杠路径，污染进 agent prompt / doc_versions。归一化 `.split(sep).join('/')`。回归锁：`envelope-resolve-port-detailed.test.ts` + RFC-005。
- **`claudeCode/sessionCapture.ts` `cwdSlug`**：只替换 `/`，遗留 `\` 与 `C:` -> `join` 产出含 `C:` 的非法中间路径 -> mkdirSync ENOENT。改为 `replace(/[/\:]/g, '-')`（与真实 `~/.claude/projects/` 命名一致）。
- **mock-opencode / 场景 stub argv**：Bun.spawn 在 Windows 截断 argv 中 `\n` 并丢弃其后参数；多行 prompt 必须走 stdin。`buildCommand` 在 win32 把 prompt 从 argv 剥离；mock-opencode `CAPTURE_ARGV_TO` 与各 bespoke gate-mock（rfc092/commit-push/scenario stub）改读 stdin 并按 POSIX 形态重塑 argv。

### S-RFC074 根因（最后一例，最深）

`clarify-review-combination-scenarios.test.ts` 的 S-RFC074（in->A->B->C 分级 demote）持续红，曾被误判为「调度器 deep Windows bug」。真因：**bun:test 默认 per-test 超时 5000ms**，该用例的 demote 级联要重跑 3 个节点（A->B->C），单次 `runTask` 即 ~6s 超时。超时后 bun 在被超时用例的 async body 仍在跑时**就启动下一个用例**（跑其 `beforeEach`），clobber 掉本文件共享的 `let c` 与全局 `process.env.SCENARIO_PLAN_FILE` / `AGENT_WORKFLOW_HOME`——scenario stub 随后读到错误 plan -> demote 失败 -> 任务 `failed`。

证据链：用 `sameCtx = (c === 捕获的 _ctx)` 断言出 `sameCtx=false`（c 被换）；用 appendFileSync 顺序日志抓到 `beforeEach`（freshCtx）在 `await runTask` 期间触发；`--max-concurrency=1` 无效（非并发，是超时驱动）；`--timeout=60000` 立即全绿（17 pass / 0 fail）。

**修复**：S-RFC074 的 `test()` 第三参提至 60_000ms，并加短轮询 `waitForTaskStatus` 兜底「最终 status 落盘晚 runTask 一个 tick」的边角。非生产代码改动——纯测试超时/隔离修复。

### 门禁

- `bun run typecheck`：3 包全绿。
- `bun run format:check`：本机 `core.autocrlf=true` 致全仓 CRLF 假红（CI 用 `.gitattributes eol=lf` 干净 LF checkout 不受影响）；改动文件用 `prettier --check --end-of-line auto` 验证无非-CRLF 格式问题。
- `bun test`（全量，temp `AGENT_WORKFLOW_HOME` 避开真实 MCP probe）：全绿。

### 遗留

- T9（CI `check-windows` 改跑全量 `bun test`）：本地全绿后可推进；需确认 CI windows-latest 上 temp home / MCP probe 隔离策略（本机用 temp `AGENT_WORKFLOW_HOME` 绕开用户真实 MCP server 的 30s probe 超时）。
