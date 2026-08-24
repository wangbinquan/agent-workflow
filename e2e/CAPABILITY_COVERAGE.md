# Task execution capability protection

> ## ⚠️ 这份文件是**导读**，不是判据（RFC-319）
>
> 下面的每一句「已覆盖」都是**散文**：要验证它，人得回到用例源码去读。RFC-319 的审计
> 逐条读过之后推翻了其中若干条——最典型的三种形态是：
>
> - 断言**恒真**：`rfc099-ownership-acl.spec.ts:188` 用只在弹窗内渲染的 `acl-panel`
>   计数为 0 去断言「陌生人直链进不去」，而那个弹窗从未被打开。
> - 用例**只走到一半**：`workflow-editor.spec.ts` 的「删除工作流」打开确认框、跑 axe、
>   点 Cancel——全仓 e2e 对 `/api/workflows` 曾经**零 DELETE**。
> - 断言**根本不跑**：代理引用完整性告警的唯一浏览器断言被关在
>   `test.skip(!RUN_VISUAL_REGRESSION)` 里，PR CI 的 Playwright 腿从不执行它；
>   而它还用 `page.route` 把被测响应整个换掉，后端计算一行都没跑过。
>
> **权威判据已移交三份机器账本**（都在 `architecture/`，都由 RFC-317 的高水位机制
> 管「只减不增」）：
>
> | 账本                         | 问的问题                                                     | 守卫                               |
> | ---------------------------- | ------------------------------------------------------------ | ---------------------------------- |
> | `e2e-endpoint-coverage.json` | `allRouteMeta()` 声明的端点里，哪些一次都没被任何 e2e 打到   | `rfc319-endpoint-coverage.test.ts` |
> | `e2e-route-coverage.json`    | `router.tsx` 的前端路由里，哪些从未被真实加载过              | `rfc319-route-coverage.test.ts`    |
> | `e2e-capability-ledger.json` | 820 条用户面能力各自被哪条**具名**用例守着（证据须逐字可达） | `rfc319-capability-ledger.test.ts` |
>
> 前两份的分子来自**运行期实测**（`e2e/route-journal.ts` 从 daemon 请求日志采集，
> 由 `e2e-full-nightly` 驱动全量对账），不是静态扫描。第三份把「哪条用例守着哪条能力」
> 从散文变成 `{file, test}`——用例改名或被删就红。
>
> 逐条审计依据：`design/RFC-319-user-facing-e2e-coverage-hardening/findings.md`。
>
> 下文保留，因为它讲清了**分层策略**与**发版前真运行时门**这两件账本表达不了的事。
> 但凡下文与账本冲突，**账本为准**。

This catalog turns durable task behavior into three complementary test layers.
It deliberately separates platform correctness from upstream CLI/provider drift,
so ordinary CI is deterministic while a release candidate can still be tested
against real OpenCode and Claude Code installations.

## Protection layers

| Layer             | Provider/network | What remains real                                                                                                                                    | Entry point                                                                                                                      |
| ----------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Fast contract     | None             | Runtime spawn builders/parsers, validators, scheduler services, rollback/isolation algorithms                                                        | `bun test packages/backend/tests/execution-capability-coverage.test.ts packages/backend/tests/e2e-runtime-scenario-stub.test.ts` |
| Deterministic E2E | None             | Compiled daemon, public HTTP API, SQLite, scheduler, native runtime driver protocol, Git worktrees, subprocesses, retries, human gates, cancellation | `bunx playwright test e2e/runtime-scenario-matrix.spec.ts --project=chromium --workers=1`                                        |
| Live release      | Real model calls | Production binary plus the operator's real OpenCode/Claude Code CLI, credentials, model, streaming and tools                                         | `bun run e2e:release-runtimes`                                                                                                   |

The deterministic stand-in is data-driven and speaks both native transports:
OpenCode receives the production trailing `-- <prompt>` argv and emits its JSON
events; Claude Code receives the production stdin prompt and emits
`stream-json`. It supports output/clarify envelopes, raw missing-envelope text,
terminal errors, process crashes, delay, session IDs, token accounting,
worktree writes, silent clean exits, deterministic barriers, and POSIX
SIGTERM delay/release windows. It never bypasses the daemon or scheduler.

## Exhaustive finite matrices

`packages/backend/tests/execution-capability-coverage.test.ts` derives its
expected sets from the production registries. A new registered element without
named checked-in evidence fails the fast suite.

| Dimension               | Current exhaustive set                                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow node kinds     | All 14: agent, input/output, three wrappers, three human gates, two call nodes, script, code-host call, code-round (synthesized — covered by its rejection) |
| Workflow input kinds    | All 5: text, files, enum, git, upload, including rejection and multipart paths                                                                              |
| Output shapes           | string, markdown, signal, path and list; concrete path/list round-trips include list-string, list-path and list-markdown                                    |
| Workgroup modes         | leader-worker, free-collab and dynamic-workflow                                                                                                             |
| Runtime × workgroup     | 2 × 3: every OpenCode/Claude Code driver runs every workgroup mode through its native transport                                                             |
| Runtime drivers         | OpenCode and Claude Code                                                                                                                                    |
| Runtime × state/fault   | 2 × 7: success, process-crash retry, envelope follow-up, inline clarify resume, missing-session fallback, timeout and cancel                                |
| Runtime × memory prompt | 2 × 1: candidate exclusion, approval boundary, snapshot, and native persona/system-prompt injection                                                         |
| Wrapper parent × child  | 3 × 3: every git/loop/fanout pair is classified as supported, static-rejected or runtime-rejected and has executable evidence                               |

## Named orchestration spines

These product capabilities cross several registries, so they are named
explicitly instead of being treated as incidental coverage from one node kind.

| Capability                        | Deterministic protection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Memory distillation and injection | Both runtime output parsers, source/scope collection, candidate persistence, approval boundary, next-task injection block/snapshot, and actual OpenCode + Claude Code runtime prompts. A candidate is also proved absent before approval.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Webhook ingress                   | GitLab and GitHub delivery flows plus provider/token mismatch, signature, unsupported event, body limit, rate limit, UUID deduplication, interrupted recovery and ordered supersede behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Unified external infrastructure   | `@agent-workflow/system-mocks` supplies runtime, Git smart HTTP, stateful GitLab/GitHub reviews/issues/pipelines + signed webhooks, generic ordered HTTP upstreams, OAuth/OIDC, MCP HTTP/SSE/stdio, npm, PyPI, PlantUML and SCIP. `system-mocks.spec.ts` crosses the compiled-daemon/browser boundaries; package tests use native protocol clients.                                                                                                                                                                                                                                                                                                                                           |
| RFC-310 development missions      | Full mission journey on the system mock (`packages/backend/tests/rfc310-t109-full-journey-e2e.test.ts`): requirement → implement → program verification → durable commit → exact-head CAS push → merge request → three-read facts fence → human review thread → policy-routed feedback repair → second publish round → real threaded reply → external merge → terminal settlement, plus the cutover adopt entry. Everything but the Agent process is real (git remote, verification subprocess, code-host API). Replaces the retired RFC-304 capability-platform browser specs, whose product surface (capability matrix writes, round launch, template detail) was deleted in RFC-310 PR-10. |
| Webhook → Agent                   | Dispatcher → transactional task context → scheduler expansion → first Agent prompt, including an Intent-created workflow and a negative check against root-input flattening.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Webhook → code platform           | Dispatcher → first scheduler read → `code-host-call` parameter expansion → real local HTTP peer; the asserted project/MR path and credential header prove what the platform receives.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Webhook launch targets            | Workflow, standalone Agent and Workgroup launches all create real scratch repositories and retain trigger/fire ownership.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Webhook runtime failures          | Real GitLab HTTP → compiled daemon → delivery/fire/task/node lineage → native OpenCode and Claude drivers; both cover UUID dedup, retry exhaustion, timeout with a genuinely late envelope, stderr-only exit and wrong nonce, while Claude also locks its native terminal-result error.                                                                                                                                                                                                                                                                                                                                                                                                       |
| Webhook MR terminal recovery      | Different-UUID facts on one MR stream serialize and supersede; close/reopen/merge fences stop real OpenCode/Claude children without terminal fire/task, and a leased terminal effect converges after daemon SIGKILL plus same-home restart.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Intent creation                   | Create/modify session, deterministic draft, validation, preview, commit, concrete resource and provenance, plus responsive/a11y paths.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Human-gate daemon replacement     | A real task parks at Clarify, survives a hard daemon replacement, continues to Review, survives a second replacement, then approves to `done` without changing either persisted gate run identity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Child workflow                    | Frozen reference/inputs, child task lineage, output hand-back, Git merge, failure/cancel/retry, loop/git nesting and daemon-restart adoption.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Child workgroup                   | Frozen roster closure, real leader/worker turns in the child task, result anchoring and parent-port hand-back.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

An unrestricted Cartesian product of every field, node count, graph topology,
runtime, workgroup mode and fault timing is infinite. Outside the finite sets
above, the suite uses pairwise and risk-based combinations: fan-in, parallel
writers, conflicting edits, retry rollback, daemon crash/restart, review
reject/approve, self/cross clarification, child workflow/workgroup execution,
fanout concurrency, runtime resource injection and complete business success /
failure / no-human-gate paths. The checked-in evidence mapping is
`packages/backend/tests/fixtures/execution-capability-coverage.ts`.

## Converting a historical task into a permanent scenario

Keep the task's observable contract, not a transcript tied to a model version:

1. Name the agent behavior and add ordered steps to a `ScenarioPlan`.
2. Assert the rendered prompt facts that caused the historical breakpoint.
3. Encode the response as output, clarify, raw text, runtime error, crash,
   delay/barrier or worktree writes.
4. Launch it through the public task API in the appropriate deterministic E2E
   catalog and assert task/node/port/file/session state.
5. If the bug is native-CLI-specific, keep one representative assertion in the
   live release sweep; do not move the whole fault matrix to a billed provider.

The scenario schema is implemented by
`packages/system-mocks/src/runtime/mode-runtime-scenario.ts`. Calls are scoped by
task/node/agent, session-resume mappings preserve internal envelope follow-ups,
and exclusive claim files make step assignment safe under concurrent calls.

## Pre-release real runtime gate

Build the production binary and set an explicit model for every selected
runtime. Native credentials and provider configuration remain the runtime's
normal responsibility.

```sh
bun run build:binary:e2e

export AW_RELEASE_OPENCODE_MODEL='provider/model'
export AW_RELEASE_CLAUDE_CODE_MODEL='model-name'
bun run e2e:release-runtimes
```

Optional controls:

```sh
# Run only one driver.
export AW_RELEASE_RUNTIME_MATRIX='opencode'

# Override PATH names or test a downloaded release binary.
export AW_RELEASE_OPENCODE_BIN='/absolute/path/to/opencode'
export AW_RELEASE_CLAUDE_CODE_BIN='/absolute/path/to/claude'
export AW_RELEASE_BINARY='/absolute/path/to/agent-workflow'
```

The live suite creates a temporary Git repository and isolated
`AGENT_WORKFLOW_HOME`, launches a real tool-using task, verifies an exact file,
output envelope, native session and non-zero token accounting, then deletes the
temporary state. It can incur provider charges and is intentionally skipped by
ordinary CI. Its machine-readable report is
`test-results/release-runtime-report.json`; attachments record product SHA,
binary/runtime versions, model and pass/fail evidence, never credential values.
