# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status

This repo is **mid-implementation** (M1 in progress; ~9/18 of M1 done as of last commit).

**Read in this order at session start:**

1. `STATE.md` — **session-to-session execution log**. Always read first; tells you what's done, what's next, current caveats.
2. `design/plan.md` — 81-issue roadmap (M0–M5). Pick next issue from here once you know the state.
3. `design/proposal.md` — product spec (authoritative).
4. `design/design.md` — technical design (authoritative).
5. `proposal/init.md` — original Chinese proposal, preserved for history. When it disagrees with `design/*.md`, `design/*.md` wins.

When a batch of issues completes, commit + push and update `STATE.md` so the next session can pick up seamlessly.

`bun install` then `bun test` to verify dev environment works.

## RFC workflow（新增 / 修改前的强制流程）

任何超出 `design/plan.md` 已列 issue 范围的**新功能、非平凡重构、产品行为变更**，必须先走 RFC，再写代码：

1. **落档**：在 `design/RFC-NNN-{slug}/` 子目录下创建三件套
   - `proposal.md` —— 产品视角：背景、目标 / 非目标、用户故事、验收标准
   - `design.md` —— 技术设计：接口契约、数据流、与现有模块的耦合点、失败模式、测试策略
   - `plan.md` —— 任务分解：编号子任务（`RFC-NNN-T1...`）、依赖、PR 拆分建议、验收清单
2. **编号**：递增分配，从 `RFC-001` 起；在 `design/plan.md` 的 "RFC 索引" 表里登记新条目（标题 + 状态：Draft / In Progress / Done / Superseded）。
3. **用户确认**：RFC 写完后必须用 `ExitPlanMode` 或显式询问得到用户批准，才能进入实现阶段。**不要边写 RFC 边改代码**。
4. **STATE.md 同步**：RFC 落档同时在 `STATE.md` 顶部追加一行"进行中 RFC"指向新目录。RFC 完工后把状态改为 Done 并在 `STATE.md` 已完成 issue 表里加一行（与 P-X-XX 同等级）。
5. **PR**：单个 RFC 默认对应单个 PR，commit message 前缀写明 `feat(scope): RFC-NNN 标题`；如确实需要拆分，在 `plan.md` 里说明并分别立 PR。
6. **不走 RFC 的例外**：拼写 / 单行 bug 修复、纯重命名、依赖升级、文档增删、测试补充、CI 微调。这些可以直接改 + 提交。

新 session 接手 RFC 时也按 `proposal → design → plan` 顺序读，规则与 `design/*.md` 一致。

## Multi-person collaboration（并发改动保留原则）

本仓常有多人并发开发——session 启动时 working tree 里可能已经有他人未提的修改 / 未追踪文件（典型场景：另一个 RFC 正在并行落地）。提交本人工作时必须遵守：

- **绝不删除别人的代码**：包括别人改过的行、新增的文件、`design/plan.md` / `STATE.md` 等共享索引里别人加的条目、`package.json` / lock 文件里别人加的依赖。如果不确定某段改动是不是自己的，宁可保留也不要删。
- **同一文件混了多人改动可以一起 commit**：不要为"剥离他人改动"去手动改回原内容再恢复——那种操作既危险又容易留脏。直接 `git add` 整个文件、在 commit message 里写清自己改动的范围即可，他人的部分作为附带保留。
- **新文件按归属处理**：自己的新文件正常 `git add`；他人留下的未追踪文件**不要主动加进暂存区**，让对方自己提。`git add .` / `git add -A` 这种全量加法在多人 working tree 下慎用，优先按路径精确 `git add`。
- **commit message 只描述自己的改动**：即便文件里包含了别人合并进来的零散行，commit 摘要 / body 也只写本次工作的内容；不要替别人写描述。
- **冲突优先调和**：如发现工作树里他人改动与本次工作有真实冲突（同一函数同一行），停下来先问用户，不要单方面覆盖。

## Test-with-every-change（测试用例随每次需求 / 修复落地）

**任何代码改动落 commit 之前必须带上对应的测试用例**——既包含新功能的正向覆盖，也包含 bug 修复的回归防护。
没有"先实现、之后补测试"这一档；测试用例是改动本身的一部分。

- **新功能**：实现的同时给所有正向 / 边界 / 错误路径写测试。RFC 的 `design.md §测试策略` 列出哪些 case 必写，PR 必须把它们都跑绿才算交付。
- **bug 修复**：先写一个能稳定复现该 bug 的测试用例（红），再写修复（绿）。把"为什么这条测试存在"写进 test 文件顶端的注释（链接 commit / RFC / issue），让未来任何 refactor 一旦把它变红能立刻看出意图。
- **首选可断言面**：抽出纯函数 / 纯数据预言（典型例子见 `affectsDefinition` / `affectsEdgeDefinition` / `selectionSig` / `deriveSelection` / `extractMissingRefs` / `hasConflict`），在用户层面 wire 进去后再写少量集成断言。运行时巨型组件难直接覆盖时，**最低限度也要保留一条源代码层文本断言**作为兜底（例如"`selectionOnDrag` 不得出现在 `WorkflowCanvas.tsx`"）。
- **回归防护命名**：测试文件 / describe 标题应能让人一眼识别它锁的是哪类回归（例如 `canvas-edge-changes.test.ts` 顶部直接写明"locks in EdgeInspector reachability fixes from commit 9b7ba31"）。
- **运行门槛**：`bun run typecheck && bun run test && bun run format:check` 必须全绿才能 push。GitHub Actions 同样会跑这三项 + 单二进制 build smoke + Playwright e2e；按 [feedback_post_commit_ci_check] 推完后立刻查 CI 状态。
- **flaky 不能掩盖红 case**：发现某测试间歇性失败，先确认是不是真 bug；如果确属环境 / 时序，要么修测试（首选 `findByRole` / class 选择器去掉 i18n race），要么显式用注释标记并开 issue，**绝不允许"重跑就过了"作为通过依据**。
- **不写测试的极少数例外**：纯文档 / 注释改动、依赖版本号 bump（且 lock 文件锁住了 minor）、CI 配置微调、prettier 自动 format。**任何触及生产代码或测试代码的改动都没有这个豁免**。

## Product vision (from `proposal/init.md`)

The goal is an **orchestration platform that drives multiple `opencode` CLI processes as collaborating agents**, instead of using opencode's built-in subagents. The motivation: when many subagents (especially audit-style ones) run inside a single opencode session, the parent session's context grows uncontrollably and model accuracy degrades. By moving inter-agent message passing into a deterministic, framework-level pipeline, each agent process keeps a small, focused context.

The canonical workflow it must support is **Code → Audit → Fix**:

1. The framework snapshots the working repo's git commit ID, runs a worker agent (an opencode process) in that repo, then snapshots the commit ID again. The diff between the two snapshots — including uncommitted changes — is the worker's structured output.
2. That diff is fed into one or more auditor agents. The framework may shard the diff (per-file, N-files-per-shard, etc.) and fan out to parallel auditor processes, each producing its own audit result.
3. Audit results are aggregated (or sharded again) and fed into fixer agents using the same fan-out pattern.

This pattern — record-state → run-agents → diff/aggregate → fan-out — is the core abstraction; specific workflows are user-defined compositions of it.

## Architecture concepts the platform must implement

(Below is a summary; for full detail read `design/proposal.md` and `design/design.md`.)

- **Agent management** — virtual agent names. **DB is source of truth** (frontmatter fields + body markdown stored in DB columns). Per-run injection via `OPENCODE_CONFIG_CONTENT` inline JSON (highest precedence in opencode merge order).
- **Skill management** — file system is source of truth (whole skill dir under `~/.agent-workflow/skills/{name}/files/`). DB only indexes name → path. Per-run injection: `managed` skill copyDir into `OPENCODE_CONFIG_DIR/skills/{name}/`, `external` skill symlink, repo-local `.opencode/skills/` left for opencode self-discovery.
- **Runtime management** — local opencode binary discovered via PATH (settings can override absolute path). Daemon probes version on startup; refuses to start below documented minimum.
- **Workflow management** — DB-stored definition (with `$schema_version`, version auto-increment on PUT). YAML import/export with conflict resolution dialog.
- **Workflow editor** — xyflow v12 Dify-style canvas with nodes / edges / wrappers (git, loop). Side bar lists agents (drag to create), wrappers, IO nodes. Right drawer with Edit/Preview tabs. Auto-save (debounce 1s). Multi-tab sync via `/ws/workflows`.
- **Node model** — each node references one agent, plus per-node prompt template (supports `{{port_name}}` + `{{__repo_path__}}` etc.), per-node overrides (model/variant/temperature/retries/timeout). single ↔ multi-process togglable. `readonly` always inherited from agent (not overridable).
- **Output XML envelope** — `<workflow-output><port name="...">...</port></workflow-output>`. Agent declares `outputs: [...]` in frontmatter; framework appends an English protocol block to user prompt to instruct format. Last envelope in stdout wins.
- **Multi-process node** — declares `sourcePort` (typically a git wrapper's `git_diff`). Built-in shardings: per-file / per-N-files / per-directory. Renames = 1 shard; binary files skipped (note appended); empty diff = direct done. Aggregation by shard_key dictionary order. Auto `errors` port on parent.
- **Git wrapper** — no inputs, single output `git_diff` (snapshots commit + worktree before first inner node, after last; composes diff incl. untracked).
- **Loop wrapper** — `max_iterations` + `exit_condition` (port-empty / port-equals / port-count-lt). v1 has **no cross-iteration feedback ports**; cross-iter state is via worktree files only. Wrappers nest arbitrarily; `git in loop` = per-iter diff (last-iter wins as output); `loop in git` = full-loop total diff.
- **Process isolation** — see "Resolved open questions" below.
- **Task lifecycle** — worktree per task at `~/.agent-workflow/worktrees/{repo-slug}/{task-id}`. Base branch chosen at launch time (default repo HEAD). Status states: `pending / running / done / failed / canceled / interrupted (daemon restart) / exhausted (loop max)`. Cancel keeps worktree; resume rolls each retried node back to its `pre_snapshot` (git stash hash); single-node retry cascades downstream by default. Retries produce independent `node_runs` keyed by `retry_index`.
- **Daemon** — single Bun process, flock single-instance lock, graceful shutdown 30s, hourly background tasks (events archival, optional worktree GC, resource-limit check at 1Hz).
- **Tech stack** — backend: Bun + Hono + Drizzle + bun:sqlite (WAL/NORMAL) + ULID. Frontend: Vite + React 19 + TanStack Router/Query + xyflow v12 + shadcn (Base UI) + i18next. Distribution: `bun build` single binary, GitHub Releases (macOS + Linux).

## Resolved open questions

The original proposal flagged several open questions; the supplemented design docs resolve them:

- **Concurrent injection conflict** (`.opencode/agents/`, `.opencode/skills/` collisions across opencode processes) — solved with **two** opencode env vars and **no** `OPENCODE_DISABLE_*` flags:
  - `OPENCODE_CONFIG_CONTENT` — inline JSON of the agent definition. opencode merges this AFTER all directory scans (config.ts:641), so the platform's agent always wins, even against same-name agents in repo `.opencode/` or `~/.opencode/`.
  - `OPENCODE_CONFIG_DIR=~/.agent-workflow/runs/{task}/{node}/.opencode/` — per-process private dir for platform-managed skills.
  - Crucially, repo-local `.opencode/skills/` (business skills the user wants the agent to use) and `~/.opencode/` (auth baseline) and `~/.claude/skills` etc. all continue to load normally. cwd remains the user's worktree so git diff works naturally.
- **Same-task concurrent writers** — `agent.md` carries `readonly: true/false`; framework serializes writes within a task and parallelizes only readonly nodes.
- **Same-repo cross-task collisions** — every task gets its own `git worktree add` under `~/.agent-workflow/worktrees/{repo-slug}/{task-id}` and runs all its opencode children with that as cwd.

Re-validate against the local opencode source before changing any of these mechanisms.

## Reference repositories

The proposal directs Claude to consult two external reference repos when designing or making technical decisions:

- **`multica`** — an existing multi-agent orchestration framework that already implements **agent management, skill management, runtime management, and task management**; prefer borrowing patterns from it over reinventing.
- **`opencode`** — the opencode source. Authoritative for runtime behavior: how an opencode process is launched, how it loads `.opencode/agents` / `.opencode/skills`, and the standardized agent output XML.

When the proposal and these repos disagree, the repos are authoritative for runtime behavior; the proposal is authoritative for product intent.

The local checkout paths for these repos on each contributor's machine are not in this file — Claude looks them up in its per-user memory.

## opencode 源码自取规则（强制）

opencode 是本平台驱动的 CLI，行为细节须以源码为准、不靠记忆。**遇到以下场景必须主动 grep / 读源码**：

- 任何涉及 opencode 进程启动、CLI 参数、环境变量（`OPENCODE_*`）、退出码、stdout/stderr 协议的判断。
- agent / skill 加载顺序、合并优先级、`.opencode/` 目录扫描规则（典型入口：`packages/opencode/src/config/config.ts`、`packages/opencode/src/agent/`、`packages/opencode/src/skill/`）。
- 输出 XML envelope 格式、tool-use 协议、session 行为。
- 任何 "opencode 是不是支持 X" / "opencode 在 Y 情况下表现如何" 的问题。

读取方式：直接用 Read / Bash(grep|rg) 即可——这是公开源码、纯只读、零副作用。读完在回复里**引用具体文件:行号**，让用户能追溯依据。

跨 session 也一样：新接手任务时若 RFC / design 里出现了对 opencode 行为的断言（例如 "opencode 合并 config 时 inline JSON 优先级最高"），上手前先去源码验证一遍再继续，避免基于过期假设写代码。

本机 opencode 源码具体路径由 Claude 从 per-user memory 解析。
