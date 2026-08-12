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
6. `docs/dev-gotchas.md` — 跨 RFC 沉淀的**通用踩坑**（提交纪律 / 迁移 / CI / opencode / impl-gate 经验规律 / 前端 / dev-env）。动手前扫一遍，避免重复踩坑；踩到新的通用坑也补进去（RFC-专属细节仍进各 `design/RFC-XXX/`）。

When a batch of issues completes, commit + push and update `STATE.md` so the next session can pick up seamlessly.

`bun install` then `bun run gate:local` to run the complete local quality/test gate. For a
tests-only pass, `bun run test` verifies backend, shared, and frontend.

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
7. **能力收缩型 RFC 的附加门槛（RFC-224 事故沉淀）**：凡以安全 / 隔离 / 密封为由**关闭或收缩既有能力**（含「新路径不再继承旧路径的能力」）的 RFC：
   - `proposal.md` 必须含**「能力影响清单」**章节：逐项列出被关闭的既有能力与受影响的部署形态，作为 breaking change **呈用户逐项确认**——不得以「安全默认」名义静默移除（RFC-224 曾静默切断自定义 provider 网关部署，生产无预警全挂，事后只能以 RFC-251 / RFC-255 逐个受控恢复）；
   - 每条禁用 / 拒绝分支**必须有测试覆盖**（禁用分支与正向功能同等对待，见 `docs/dev-gotchas.md` 对应教训）；
   - 关闭判据必须是可复跑的外部源码引用（`file:line`），接手复核规则同 `docs/dev-gotchas.md` §「RFC / design 里对 opencode 行为的既有断言」。

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
- **运行门槛**：`bun run gate:local` 必须全绿才能 push。它把 backend 与 quality 两条车道并发：backend 保留 `--isolate --randomize`，拆成 4 个各自拥有独立 home/tmp 的完整串行 shard；quality 依次跑 typecheck / lint / format / depcheck / shared / frontend。`bun run test:backend:serial` 是复现单进程顺序问题的诊断入口，不能替代完整门禁。lint 是 `--max-warnings 0`——一个 unused import 就双 OS 红（RFC-140 事故）。GitHub Actions 同样会跑这些检查 + 单二进制 build smoke + Playwright e2e。**推完立刻查 CI**：用 GitHub Actions API 按**自己的确切 sha** 查——共享 `main` 上并发 push 会取消你的 run，须看含你 commit 的 superseding commit 的绿、按失败测试的 owning commit 归属（详见 `docs/dev-gotchas.md`）。
- **flaky 不能掩盖红 case**：发现某测试间歇性失败，先确认是不是真 bug；如果确属环境 / 时序，要么修测试（首选 `findByRole` / class 选择器去掉 i18n race），要么显式用注释标记并开 issue，**绝不允许"重跑就过了"作为通过依据**。
- **不写测试的极少数例外**：纯文档 / 注释改动、依赖版本号 bump（且 lock 文件锁住了 minor）、CI 配置微调、prettier 自动 format。**任何触及生产代码或测试代码的改动都没有这个豁免**。

## Frontend UI consistency（前台界面统一风格强制原则）

任何新增/改动的前台界面——新按钮、新弹窗、新表单、新列表行、新页签、新空状态、新页面 header
——必须**优先复用既有公共组件 / 样式 class**，**禁止**为了"快一点"而落原生 HTML 元素 / 自写一套
chrome / 自写一套 CSS。整个系统的视觉与交互风格要保持一致，新功能不能成为视觉孤岛。

**已存在的公共组件**（持续增加；写代码前先在 `packages/frontend/src/components/` 下扫一遍，
不在这里写名字以免清单过时——以源码实际为准）：

- **Dialog** (`components/Dialog.tsx`) — 所有 modal / overlay 必走这一个：自带 overlay + portal +
  focus trap + ESC + outside-click + a11y。提供 `footer` 槽位放 Save / Cancel。**禁止**新写
  `.xxx__overlay` / `.xxx__panel` 之类的 modal chrome。
- **Form primitives** (`components/Form.tsx`) — `<Field>` (label + hint + 必填 \*) /
  `<TextInput>` / `<NumberInput>` / `<TextArea>`（含 `monospace`）/ `<Switch>`。表单字段一律
  走这套，**禁止**直接落 `<input className="form-input">` 或自写 border / focus ring。
- **Select** (`components/Select.tsx`) — RFC-036 自带 popover 的下拉，键盘 / a11y 完整。**禁止**
  在弹窗内直接落原生 `<select>`，原生弹层无法和周围 UI 风格对齐。
- **ChipsInput** (`components/ChipsInput.tsx`) — 标签 / 字符串数组输入：Enter / 逗号 commit +
  Backspace 删除 + dedup + validator。**禁止**自写"chip 输入 + × 删除"逻辑。
- **`.segmented`** (`styles.css`) — 2-N 个短选项的分段控件（同 LanguageSwitch / NodeInspector
  clarify sessionMode）。短列表互斥选择走这条，**禁止**自写 radio 按钮组。
- **页面骨架**：`.page` / `.page__header` / `.page__header--row` / `.page__actions` /
  `.page__section`；行级行动按钮 `.btn .btn--sm` / `.btn--primary` / `.btn--danger` /
  `.btn--xs`；状态 chip 走 `<StatusChip>` / `<TaskStatusChip>` 等既有组件。
- **错误 / 空 / 加载状态**：`<ErrorBanner>` / `<EmptyState>` / `<LoadingState>`，**禁止**写
  `<div className="error-box">…</div>` 自己拼。
- **WS 订阅**：先看 `hooks/useMemoryWs.ts` / `useWebSocket.ts` 等既有 hook，复用它们的
  invalidation 模式，不要新建一套。

**操作规程**：

1. 开工前用 `find packages/frontend/src/components -name "*.tsx" | head -50` +
   `grep -rn "className=\"<候选 class 前缀>" packages/frontend/src/styles.css`
   先看清现有库存，**有就用现有的**。
2. 若现有公共组件**确实不够用**（缺一两个 prop 比如 `disabled` / `data-testid`），优先**最小
   扩展**它（加可选 prop、向后兼容），让所有调用方一起受益；**不要**在你的功能里 fork 一份
   或绕开。如 RFC-045 给 `TextArea` 加 `disabled` + `data-testid`、给 `ChipsInput` 加
   `testidPrefix` 即范例。
3. 真的需要全新一类组件（共享库里完全没有），按"新增公共组件"对待：放在
   `components/<Name>.tsx`、起 i18n key 体系、给 `.<name>` 命名空间样式、加单测，并把它当公共
   原语供后续复用。新组件的初版**就**要考虑被别人复用的形态，不是私有助手函数式塞在路由里。
4. 写完后做一次"视觉对齐自查"：把新页面截图（或本地起 dev server 看），与 `/agents`、
   `/workflows`、`/repos`、`/memory`、`/settings` 等核心页 side-by-side 比一下——按钮高度 /
   圆角 / spacing / 颜色 / 字号是否一致；如有偏差，先想"是不是应该贴公共 class"，再考虑加自有
   CSS。
5. 不复用、直接落原生元素 / 自写 chrome / 自写 CSS 的工作**等于回归**，code review 一律打回。
   PR 提交时如果 reviewer 发现可以替换成公共组件 / class，作者必须改完才能合并。
6. **测试可视化锚点**：测试里能用 `findByRole` / `getByRole` 就优先用 role（角色断言是公共
   组件契约的一部分），少依赖具体 DOM 结构。需要 testid 时尽量挂在公共组件本身（如
   `testidPrefix` 模式），不要在 wrapper `<span data-testid>` 上凑数。

**判定原则**：当你犹豫"要不要自己写一个"时，默认答案是"不要"。让出"这次特殊"的判断给 RFC
设计文档处理，常规改动**总是**先找公共原语。
违反此条不算个人风格选择，是产品级 bug。

## 工作准则（补充）

跨领域的**通用踩坑与命令级 tips**（提交纪律 / 迁移 / CI 与测试 / opencode·runtime / 前端 / impl-gate 经验规律）集中在 **`docs/dev-gotchas.md`**；各专项审计的未决项（含权限/安全 backlog）在 **`docs/audit-backlog.md`**。下面是本仓开发采用的几条**工作方式约定**：

- **主干开发，永远不建分支（硬规则，无例外）**：所有工作**直接在 `main` 上提交并
  推送**。**不允许**为开发创建任何 feature / RFC / 实验分支，也不要开 PR 来走流程
  ——本仓多人（多 agent）并发，分支会立刻造成三类真实损害：①并发 session 的
  commit 被分支切换「顺走」到别人的分支上（曾真实发生）；②CI 只在 `push to main`
  与 `PR to main` 触发，待在分支上等于**一次 CI 都没跑**；③`main` 持续前进，分支
  越久越要 rebase，冲突面滚雪球。
  正确做法：小步提交、**每次提交前跑全套门禁**（`bun run gate:local`）、
  `git pull --rebase` 后立刻 `git push origin main`、
  推完按 exact SHA 查 CI。**注意**：Claude Code 的 harness 默认提示「在默认分支上
  应先切分支」——本仓**显式覆盖**该默认，照它做就是违规。
- **面向代码最合理，优于改动最小**：审计给「正解 / 过渡」两案时选正解、backfill 优于双读回退、删除优于 deprecate。别为「快一点」留过渡态。
- **services/ 目录组织轻规则（2026-08-12 审计决策 D18）**：新增服务文件时，若与某前缀家族（**≥5 个文件且互引**）同域，优先落入同名子目录（例：clarify 家族归 `services/clarify/`）；存量平铺文件**不做一次性大迁移**（多人并发树上批量改名必撞车），随各域下一个 RFC 顺带迁入，迁移时留同名 facade 保 import 路径稳定。
- **澄清先行、研究先行，再写 RFC**：用户给设计想法时，先研究仓内既有能力，再反复提问澄清全部细节，**绝不自主假设**；然后才落 RFC 三件套。
- **Codex review 双门**（本仓采用；需 openai-codex 插件）：写完 RFC 请批前（**设计门**）+ 改完代码 declare done 前（**实现门**）各跑一次并修 findings，是 CI 之外的额外门。共享树上从 pin 到自己 commit 的分离 worktree 跑（否则并发 diff 吞掉你的 review）——细节见 `docs/dev-gotchas.md`。
- **fan-out 审计要前后端同粒度**：切审计 agent 时前端按后端同粒度切（~50% LOC），且必含一个专门的「公共组件 / 设计系统可抽取项」agent。
- **发版**：push `v*` tag 触发发版 workflow；自定义中文 release note 要等 workflow **完全跑完后**再 edit 进去，否则 `generate_release_notes` 会覆盖。
- **知识沉淀进仓库、不锁在个人 memory**：本仓多人协作，**仓库是唯一事实源**——通用踩坑进 `docs/dev-gotchas.md`、审计未决进 `docs/audit-backlog.md`、强制规则/约定进本文件、RFC 细节进各 `design/RFC-XXX/`。Claude 的个人 memory 只留**因人 / 因机而异**的配置（本机 checkout 路径、语言偏好、个人工具链），凡对他人有用的一律落仓。

## Product vision (from `proposal/init.md`)

The goal is an **orchestration platform that drives multiple `opencode` CLI processes as collaborating agents**, instead of using opencode's built-in subagents. The motivation: when many subagents (especially audit-style ones) run inside a single opencode session, the parent session's context grows uncontrollably and model accuracy degrades. By moving inter-agent message passing into a deterministic, framework-level pipeline, each agent process keeps a small, focused context.

The canonical workflow it must support is **Code → Audit → Fix**:

1. The framework snapshots the working repo's git commit ID, runs a worker agent (an opencode process) in that repo, then snapshots the commit ID again. The diff between the two snapshots — including uncommitted changes — is the worker's structured output.
2. That diff is fed into one or more auditor agents. The framework may shard the diff (per-file, N-files-per-shard, etc.) and fan out to parallel auditor processes, each producing its own audit result.
3. Audit results are aggregated (or sharded again) and fed into fixer agents using the same fan-out pattern.

This pattern — record-state → run-agents → diff/aggregate → fan-out — is the core abstraction; specific workflows are user-defined compositions of it.

## Architecture concepts the platform must implement

(Below is a summary; for full detail read `design/proposal.md` and `design/design.md`.)

- **Agent management** — virtual agent names. **DB is source of truth** (frontmatter fields + body markdown stored in DB columns). Selected agents are added to the runtime's ordinary config surface; machine/project config still loads by the runtime's native rules. User-authored permission declarations remain explicit product input.
- **Skill management** — file system is source of truth (whole skill dir under `~/.agent-workflow/skills/{name}/files/`). Selected managed skills are staged into the run config; project skills remain discoverable from the worktree. Skill/plugin resource-type boundaries and content-revision fencing remain enforced.
- **MCP management** — the node's selected MCP closure is added to the runtime config. Local commands and remote endpoints run with their authored environment/network semantics; unrelated machine/project runtime config remains naturally discoverable. Selected plugins and `dependsOn` closure members are still injected through driver-specific native surfaces.
- **Runtime management** — the administrator-selected OpenCode or Claude Code executable runs directly as an ordinary child process in the daemon environment. There is no binary digest/launcher identity gate, private HOME/XDG/store, network fence, or OS sandbox. OpenCode has no exact-version gate; compatibility failures surface as ordinary probe/CLI/protocol errors. A Claude runtime profile may opt in to the upstream `IS_SANDBOX=1` compatibility marker; it is off by default and does not enable an OS sandbox or platform protection.
- **Workflow management** — DB-stored definition (with `$schema_version`, version auto-increment on PUT). YAML import/export with conflict resolution dialog.
- **Workflow editor** — xyflow v12 Dify-style canvas with nodes / edges / wrappers (git, loop). Side bar lists agents (drag to create), wrappers, IO nodes. Right drawer with Edit/Preview tabs. Auto-save (debounce 1s). Multi-tab sync via `/ws/workflows`.
- **Node model** — each node references one agent, plus per-node prompt template (supports `{{port_name}}` + `{{__repo_path__}}` etc.), per-node overrides (model/variant/temperature/retries/timeout). single ↔ multi-process togglable. `readonly` always inherited from agent (not overridable).
- **Output XML envelope** — `<workflow-output><port name="...">...</port></workflow-output>`. Agent declares `outputs: [...]` in frontmatter; framework appends an English protocol block to user prompt to instruct format. Last envelope in stdout wins.
- **Multi-process node** — declares `sourcePort` (typically a git wrapper's `git_diff`, which emits a `list<path<*>>` of changed paths). Sharding is RFC-103 **kind-aware list splitting**（`splitListItems` / `splitMarkdownDocs`，list 逐项一 shard；空源 = 全 outlet 置空 + 直接 done；shardKey 冲突以 `#idx` 后缀消歧）。（早期提案所述 per-file / per-N-files / per-directory 的 diff 文本分片已随 RFC-060 删除 agent-multi 而退役；残留死代码 `util/diffSplit.ts` 按 2026-08-12 审计决策 D12 随 RFC-284 移除——见 `design/system-commons-unification-audit-2026-08-12.md`。）Aggregation by shard_key dictionary order. **Failure semantics are fail-all-after-join** — any failed shard fails the whole wrapper, with no partial aggregation and **no auto `errors` port** (the `errors` port and partial tolerance described in `design/proposal.md` are DEFERRED, not implemented in v1; see `design/design.md` §6.3 and the lock in `packages/backend/tests/scheduler-audit-s18-s19-fanout-failure-semantics.test.ts`).
- **Git wrapper** — no inputs, single output `git_diff` (snapshots commit + worktree before first inner node, after last; composes diff incl. untracked).
- **Loop wrapper** — `max_iterations` + `exit_condition` (port-empty / port-equals / port-count-lt). v1 has **no cross-iteration feedback ports**; cross-iter state is via worktree files only. Wrappers nest arbitrarily; `git in loop` = per-iter diff (last-iter wins as output); `loop in git` = full-loop total diff.
- **Process lifecycle** — runtime children are ordinary processes, not isolated tenants. The daemon still records PIDs, bounds output, enforces timeout/cancel, escalates TERM→KILL across the process tree, drains pipes, and repairs interrupted rows after restart. Script `readonly` means disposable worktree plus no merge-back, not filesystem write denial.
- **Resource ACL（RFC-099 / RFC-231）** — 代理/技能/MCP/插件/工作流/工作组六类资源各带单一 `owner_user_id` + `visibility('public'|'private')` + 通用 `resource_grants` 授权表；未授权用户完全不可见（列表过滤、详情 404 与不存在同形）。所有用户可创建，受支持的新建路径统一为创建者 owner + `private` + 零 grants；存量行不回填，框架 built-in 显式保持 `public`，缺失 visibility/SQLite 的 `public` default 只作 legacy/raw-SQL 兼容。启动任务只校验工作流本身可用（引用闭包隐式授权），保存工作流/代理时只校验**新增**引用（`services/resourceRefs.ts`）。任务成员（owner+collaborator）即评审/反问的回答权边界（节点级指派机制已删除）；任务继续走独立的成员制**私有**模型、无 visibility 开关。归属记录（user id + 任务关系角色快照 {owner,user,admin}）只落审计列与 UI，**绝不进入 agent prompt**（rfc099-prompt-isolation 测试双层锁定，approval_meta 端口已剔除 decidedBy）。反问支持服务端逐题协作草稿（last-write-wins + 逐题归属 + 提交冻结）。记忆权限现状（2026-08-12 按源码对账更正，原「repo/global 仍 admin」记载过期）：读面——资源 scope 随绑定资源可见性，repo/repo_group/global 全员可读（`services/memory.ts` canViewMemory；RFC-285 Q4 例外：status='candidate' 的未审蒸馏行仅资源管理员可读，人审发布后回到全员面）；管理面——随 scope 资源写权 + 资源管理员（admin+manager，isResourceAdminRole）全量兜底（canManageMemory）。单一事实源：`services/resourceAcl.ts`。
- **Task lifecycle** — worktree per task at `~/.agent-workflow/worktrees/{repo-slug}/{task-id}`. Base branch chosen at launch time (default repo HEAD). Task status states: `pending / running / done / failed / canceled / interrupted (daemon restart) / awaiting_review / awaiting_human`（RFC-097 勘误：任务级从无 `exhausted`——它只是 node_run 状态〔loop 触顶〕，loop 耗尽时任务以 `failed` 收场）. Writes go through `setTaskStatus`/`trySetTaskStatus` (services/lifecycle.ts, RFC-097 CAS + 转移表；直写被 s14 守卫禁止). Cancel keeps worktree; resume rolls each retried node back to its `pre_snapshot` (git stash hash); single-node retry cascades downstream by default. Retries produce independent `node_runs` keyed by `retry_index`.
- **Daemon** — single Bun process, flock single-instance lock, graceful shutdown 30s, hourly background tasks (events archival, optional worktree GC, resource-limit check at 1Hz).
- **Tech stack** — backend: Bun + Hono + Drizzle + bun:sqlite (WAL/NORMAL) + ULID. Frontend: Vite + React 19 + TanStack Router/Query + xyflow v12 + shadcn (Base UI) + i18next. Distribution: `bun build` single binary, GitHub Releases (macOS + Linux).

## Resolved open questions

The original proposal flagged several open questions; the supplemented design docs resolve them:

- **Runtime config coexistence** — the daemon adds the selected agent/MCP/plugin/skill overlay while preserving the runtime's ordinary machine and project discovery. Same-name merge behavior follows the selected runtime. No platform attestation claims that inherited surfaces are absent.
- **Session ownership** — native conversation IDs use neutral DB single-writer leases so concurrent writers are rejected. Runtime binary/config/store provenance is not persisted as a trust identity. RFC-276 migration explicitly ends pre-cutover native sessions rather than pretending they can resume across the storage change.
- **Same-task concurrent writers** — `agent.md` carries `readonly: true/false`; framework serializes writes within a task and parallelizes only readonly nodes.
- **Same-repo cross-task collisions** — every task gets its own `git worktree add` under `~/.agent-workflow/worktrees/{repo-slug}/{task-id}` and runs all its opencode children with that as cwd.

The full current contract and repository code anchors are in `docs/OPENCODE_CONFIG.md` and
`design/RFC-276-runtime-hardening-deprecation/`. RFC-205/216/224/227/233 are historical records,
not current execution guidance.

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
