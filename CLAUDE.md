# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status

v1 **已发布**：M0–M5 的 81 个 issue 全部完工（`STATE.md` §路线图全局视图：M0 5/5、M1 18/18、M2 16/16、M3 14/14、M4 11/11、M5 12/12），发布产物由 `v*` tag 触发的 workflow 产出。**此后所有产品 / 技术工作一律以 RFC 形式落地**（`design/RFC-NNN-{slug}/`），见 §RFC workflow。

**Read in this order at session start:**

1. `STATE.md` — **session-to-session execution log**. Always read first; tells you what's done, what's next, current caveats.
2. `design/plan.md` — **RFC 索引**（编号 / 标题 / 状态；新 RFC 在此登记）+ 已完工的 M0–M5 路线图存档。**这里已无待认领 issue**，新工作从 RFC 开始。
3. `design/RFC-294-backend-layered-target-architecture/` — 后台**全局目标架构**总纲；新 RFC 的设计必须朝它演进（见 §RFC workflow 第 8 条）。
4. `design/proposal.md` — product spec (authoritative).
5. `design/design.md` — technical design (authoritative).
6. `proposal/init.md` — original Chinese proposal, preserved for history. When it disagrees with `design/*.md`, `design/*.md` wins.
7. `docs/dev-gotchas.md` — 跨 RFC 沉淀的**通用踩坑**（提交纪律 / 迁移 / CI / opencode / impl-gate 经验规律 / 前端 / dev-env）。动手前扫一遍，避免重复踩坑；踩到新的通用坑也补进去（RFC-专属细节仍进各 `design/RFC-XXX/`）。

When a batch of work (RFC tasks, fixes) completes, commit + push and update `STATE.md` so the next session can pick up seamlessly.

`bun install` 装依赖。**质量 / 测试门禁以 GitHub Actions 为准，本地不再要求跑**（2026-08-24
用户明令，详见 §Test-with-every-change 的「运行门槛」）：`bun run gate:local`（完整本地门禁）与
`bun run test`（backend + shared + frontend）保留为**可选的诊断入口**——用于复现 CI 报出的红，
不是提交的前置条件。

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
8. **目标架构对齐（RFC-294 总纲，强制）**：`design/RFC-294-backend-layered-target-architecture/` 定义了后台的**全局目标架构**——feature-first bounded context + 模块内 `domain / application / engine / ports / infrastructure` 分层，执行链固定为 TaskEngine → WrapperRuntime → NodeExecutor → ExecutionKernel，跨模块只依赖 exact `public/{commands,queries,participants,events,types}` 合同，bootstrap 唯一装配。**此后每个新 RFC 都必须考虑向该架构做出架构演进**：
   - 写 `design.md` 前先读 RFC-294 的 `proposal.md §1 摘要裁决 / §3 目标` 与 `design.md`，在设计里写明本次改动落在哪个 bounded context、哪一层，新增代码**按目标架构落位**；
   - 不要再往 `routes/` / `services/` 横向平铺层加新的跨域耦合、facade 或 cross-context 内部 import；顺手能把触及的存量结构朝目标架构挪一步就挪，并在 `design.md` 里写清「本 RFC 承担哪一步演进、留下哪些债」；
   - 确有偏离（必须绕过 kernel、必须新增临时 facade 等）时在 `design.md` 里**逐条列出偏离项与理由并呈用户确认**，不得默默沿用旧形状；
   - RFC-294 本身是总纲、零生产改动：各演进波次仍各自立 RFC 单独获批，新 RFC **不因「对齐 294」就自动取得实现许可**。

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

- **新功能**：实现的同时给所有正向 / 边界 / 错误路径写测试。RFC 的 `design.md §测试策略` 列出哪些 case 必写，**CI** 必须把它们都跑绿才算交付。
- **bug 修复**：先写一个能稳定复现该 bug 的测试用例（红），再写修复（绿）。把"为什么这条测试存在"写进 test 文件顶端的注释（链接 commit / RFC / issue），让未来任何 refactor 一旦把它变红能立刻看出意图。
- **首选可断言面**：抽出纯函数 / 纯数据预言（典型例子见 `affectsDefinition` / `affectsEdgeDefinition` / `selectionSig` / `deriveSelection` / `extractMissingRefs` / `hasConflict`），在用户层面 wire 进去后再写少量集成断言。运行时巨型组件难直接覆盖时，**最低限度也要保留一条源代码层文本断言**作为兜底（例如"`selectionOnDrag` 不得出现在 `WorkflowCanvas.tsx`"）。
- **回归防护命名**：测试文件 / describe 标题应能让人一眼识别它锁的是哪类回归（例如 `canvas-edge-changes.test.ts` 顶部直接写明"locks in EdgeInspector reachability fixes from commit 9b7ba31"）。
- **运行门槛（2026-08-24 变更：本地不跑，直接推，让 CI 跑）**：**不再要求 push 前跑 `bun run gate:local`**——本仓多个 session 并发开发、共用同一棵工作树，本地全量门禁要 8–10 分钟且吃满 CPU，`gate:local` 又带跨 worktree 单实例锁，几个 session 互相挤占后提交吞吐极低；而它看到的还是被别人实时写入的中间态快照，红了也无法归因（见 `docs/dev-gotchas.md`）。**唯一权威门禁是 GitHub Actions**：它在干净 checkout 上跑 typecheck / lint（`--max-warnings 0`，一个 unused import 就双 OS 红，RFC-140 事故）/ format / depcheck / backend 四分片 / shared / frontend / 单二进制 build smoke / Playwright e2e，覆盖面本来就**大于**本地门禁（本地不跑 e2e、不跑 gitleaks、不跑 system-mock 包、`RUN_GIT_NETWORK` 门控的用例也不跑）。
  - **代价由推的人自己兜**：`main` 是全员共用的主干，你推红就是全员红。**push 完立刻按自己的确切 sha 查 CI**（GitHub Actions API；共享 `main` 上并发 push 会取消你的 run，须看含你 commit 的 superseding commit 的绿、按失败测试的 owning commit 归属，详见 `docs/dev-gotchas.md`），**盯到绿为止**：红了立刻修（小改直接补一提），确认一时修不完就 revert 自己那笔，别把红的主干留给下一个人。
  - **本地仍推荐的秒级自查（不抢资源、可选）**：只对**本次改动的文件**跑 `bunx prettier --check <files>` 与 `bunx eslint <files> --max-warnings 0`，以及直接相关的那几个测试文件（`bun test <file>`）。这是建议不是门槛，不做也可以，由 CI 兜底。
  - `bun run gate:local` / `bun run test:backend:serial` 保留为**诊断入口**：CI 红了要在本地复现、或排查单进程顺序依赖时才用，不作为提交前置条件。
- **测试照写不误**：本条只改「在哪里跑」，没改「要不要写」——本节其余各条（新功能正向 / 边界 / 错误路径覆盖、bug 先红后绿、回归防护命名）全部照旧生效，改动仍必须自带测试。
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

- **只在 `main` 上开发：不建分支、不用 worktree、不用 stash（硬规则，无例外，
  用户 2026-08-23 明令）**。四条约束一起生效，缺一条都会退回被禁止的形态：

  1. **不建任何分支**。所有工作直接在 `main` 上提交并推送，也不要开 PR 走流程。
  2. **不用 `git worktree`**（开发用途）。不许 `git worktree add` 出「只含自己
     改动的干净树」来跑门禁 / 过 Codex / 做对照实验。**唯一例外是产品自身的
     worktree 能力**——`~/.agent-workflow/worktrees/{repo-slug}/{task-id}` 的任务
     隔离、git wrapper 的快照，那是被开发的**产品功能**，与本条无关，绝不能因为
     这条规则去改动或删除它们。
  3. **不用 `git stash`**（含 `git stash -u`、`git pull --rebase` 的
     `rebase.autoStash`、以及任何 `stash push -- <path>` 的部分暂存）。
  4. **本地 `main` 必须时刻与 `origin/main` 同步，不得有任何落后**。

  **多人并发下的提交纪律**（本仓工作树同时有多个 session 在改）：

  - 各自开发各自的代码，**只提交自己改过的文件**——按路径精确 `git add <file>`，
    严禁 `git add .` / `git add -A`。
  - **提交时也必须带 pathspec：`git commit -- <你的路径…>`**。只做精确 `git add`
    **挡不住**这件事：共享工作树的 **index 是共用的**，别人可能早已 `git add` 过他们
    的在制品，而裸 `git commit` 提交的是**整个暂存区**，不是你 add 的那几个文件。
    2026-08-23 实撞：我 `git add` 了 2 个文件，裸 `git commit` 把并发 session 暂存着的
    **26 个 RFC-310 在制品文件**一起提交并推上 main；更糟的是那是一次**跨文件重构的
    半截**（必填字段进了 `types.ts`，消费它的测试还没更新），**当场把 main 推红**。
  - **推之前 `git diff --cached --stat` 看一眼暂存区**：出现任何你没打算提的路径就停下。
    这一步成本几秒，是上面那条的兜底。
  - **同一个文件被多人改过时**：允许提交该文件，但前提是**完全不动别人的产物**。
    提交前 `git diff HEAD -- <file>` 逐 hunk 认领，确认自己那部分之外的行原样保留。
  - **绝不回退、绝不改动别人的任何修改**。认不出来源的 hunk 一律先问，不要猜。
    他人的未追踪文件不要主动 `git add`。

  **同步的正确姿势（无 stash 可用时）**：脏树（躺着别人的未提交改动）上
  `git rebase` / `git pull --rebase` 会被 git 直接拒绝（`cannot rebase: You have
  unstaged changes`），而它的 `--autostash` 属于被禁的 stash。因此：

  ```
  git add <只加自己的文件> && git commit      # 先把自己的工作固化
  git fetch origin main
  git merge --ff-only origin/main            # 无本地提交时；这一步脏树也能过
  # 若本地已有提交且远端已前进（ff 失败）：
  git merge origin/main                      # 用 merge，**不要** rebase
  git push origin main                       # 推完立刻按 exact SHA 查 CI
  ```

  推完再 `git fetch` 确认 `git rev-parse HEAD == git rev-parse origin/main`，
  任何时刻都不允许本地落后于远端。

  **为什么不建分支**（三条真实损害）：①并发 session 的 commit 被分支切换「顺走」到
  别人的分支上（曾真实发生）；②CI 只在 `push to main` 与 `PR to main` 触发，待在
  分支上等于**一次 CI 都没跑**；③`main` 持续前进，分支越久越要 rebase，冲突面滚雪球。

  **注意**：Claude Code 的 harness 默认提示「在默认分支上应先切分支」——本仓**显式
  覆盖**该默认，照它做就是违规。本文件此前多处（§Codex review 双门、
  `docs/dev-gotchas.md` 的多条）曾把「开分离 worktree / stash 别人的改动」写成定式，
  **那些写法一律作废**；它们记录的底层危害（共享树上门禁结果无法归因、并发 diff 吞掉
  review）依然真实，处置改为：**在主树上跑，红了按路径归因**——先在 `origin/main`
  的既有 CI 结果上确认该守卫本来是绿的，再判断这条红是不是自己的。
- **面向代码最合理，优于改动最小**：审计给「正解 / 过渡」两案时选正解、backfill 优于双读回退、删除优于 deprecate。别为「快一点」留过渡态。
- **services/ 目录组织轻规则（2026-08-12 审计决策 D18）**：新增服务文件时，若与某前缀家族（**≥5 个文件且互引**）同域，优先落入同名子目录（例：clarify 家族归 `services/clarify/`）；存量平铺文件**不做一次性大迁移**（多人并发树上批量改名必撞车），随各域下一个 RFC 顺带迁入，迁移时留同名 facade 保 import 路径稳定。
- **澄清先行、研究先行，再写 RFC**：用户给设计想法时，先研究仓内既有能力，再反复提问澄清全部细节，**绝不自主假设**；然后才落 RFC 三件套。
- **Codex review 双门**（本仓采用；需 openai-codex 插件）：写完 RFC 请批前（**设计门**）+ 改完代码 declare done 前（**实现门**）各跑一次并修 findings，是 CI 之外的额外门。**在主树上跑**——本仓禁用开发用 worktree（见上条硬规则），旧文档里「pin 到自己 commit 的分离 worktree」的写法已作废。共享树上并发 diff 会混进 review 的问题，改用**按路径限定审查范围**处置：明确告诉 Codex 只看自己改过的那几个文件，并在读 findings 时先剔除指向他人路径的条目。细节见 `docs/dev-gotchas.md`。
- **fan-out 审计要前后端同粒度**：切审计 agent 时前端按后端同粒度切（~50% LOC），且必含一个专门的「公共组件 / 设计系统可抽取项」agent。
- **发版**：push `v*` tag 触发发版 workflow；自定义中文 release note 要等 workflow **完全跑完后**再 edit 进去，否则 `generate_release_notes` 会覆盖。
- **知识沉淀进仓库、不锁在个人 memory**：本仓多人协作，**仓库是唯一事实源**——通用踩坑进 `docs/dev-gotchas.md`、审计未决进 `docs/audit-backlog.md`、强制规则/约定进本文件、RFC 细节进各 `design/RFC-XXX/`。Claude 的个人 memory 只留**因人 / 因机而异**的配置（本机 checkout 路径、语言偏好、个人工具链），凡对他人有用的一律落仓。

## Product vision (from `proposal/init.md`)

The goal is an **orchestration platform that drives multiple agent-CLI runtime processes as collaborating agents**, instead of using a runtime's built-in subagents. The motivation: when many subagents (especially audit-style ones) run inside a single runtime session, the parent session's context grows uncontrollably and model accuracy degrades. By moving inter-agent message passing into a deterministic, framework-level pipeline, each agent process keeps a small, focused context.

（原始提案只写了 `opencode`；平台现已把 **OpenCode 与 Claude Code** 都作为一等 runtime 驱动，产品意图不变——本节所说的「runtime 进程」即所选 runtime 的子进程。）

The canonical workflow it must support is **Code → Audit → Fix**:

1. The framework snapshots the working repo's git commit ID, runs a worker agent (a runtime child process) in that repo, then snapshots the commit ID again. The diff between the two snapshots — including uncommitted changes — is the worker's structured output.
2. That diff is fed into one or more auditor agents. The framework may shard the work and fan out to parallel auditor processes, each producing its own audit result.（分片的**现行**机制见下文 §Multi-process node——是 RFC-103 的 kind-aware list 分片，不是提案原文设想的 per-file / per-N-files diff 文本分片。）
3. Audit results are aggregated (or sharded again) and fed into fixer agents using the same fan-out pattern.

This pattern — record-state → run-agents → diff/aggregate → fan-out — is the core abstraction; specific workflows are user-defined compositions of it.

## Architecture concepts the platform must implement

(Below is a summary; for full detail read `design/proposal.md` and `design/design.md`.)

- **Agent management** — virtual agent names. **DB is source of truth** (frontmatter fields + body markdown stored in DB columns). Selected agents are added to the runtime's ordinary config surface; machine/project config still loads by the runtime's native rules. User-authored permission declarations remain explicit product input.
- **Skill management** — file system is source of truth (whole skill dir under `~/.agent-workflow/skills/{id}/files/`，目录名是技能的 ULID **id** 而非 name；不可变版本快照在同级 `versions/v{contentVersion}/files/`). Selected managed skills are staged into the run config; project skills remain discoverable from the worktree. Skill/plugin resource-type boundaries and content-revision fencing remain enforced.
- **MCP management** — the node's selected MCP closure is added to the runtime config. Local commands and remote endpoints run with their authored environment/network semantics; unrelated machine/project runtime config remains naturally discoverable. Selected plugins and `dependsOn` closure members are still injected through driver-specific native surfaces.
- **Runtime management** — the administrator-selected OpenCode or Claude Code executable runs directly as an ordinary child process in the daemon environment. There is no binary digest/launcher identity gate, private HOME/XDG/store, network fence, or OS sandbox. OpenCode has no exact-version gate; compatibility failures surface as ordinary probe/CLI/protocol errors. A Claude runtime profile may opt in to the upstream `IS_SANDBOX=1` compatibility marker; it is off by default and does not enable an OS sandbox or platform protection.
- **Workflow management** — DB-stored definition (with `$schema_version`, version auto-increment on PUT). YAML import/export with conflict resolution dialog.
- **Workflow editor** — xyflow v12 Dify-style canvas with nodes / edges / wrappers (git, loop). Side bar lists agents (drag to create), wrappers, IO nodes. Right drawer with Edit/Preview tabs. Auto-save (debounce 1s). Multi-tab sync via `/ws/workflows`.
- **Node model** — each node references one agent, plus per-node prompt template (supports `{{port_name}}` + `{{__repo_path__}}` etc.), per-node overrides (model/variant/temperature/retries/timeout). single ↔ multi-process togglable. `readonly` always inherited from agent (not overridable).
- **Output XML envelope** — `<workflow-output><port name="...">...</port></workflow-output>`. Agent declares `outputs: [...]` in frontmatter; framework appends an English protocol block to user prompt to instruct format. Last envelope in stdout wins.
- **Multi-process node** — declares `sourcePort` (typically a git wrapper's `git_diff`, which emits a `list<path<*>>` of changed paths). Sharding is RFC-103 **kind-aware list splitting**（`splitListItems` / `splitMarkdownDocs`，list 逐项一 shard；空源 = 全 outlet 置空 + 直接 done；shardKey 冲突以 `#idx` 后缀消歧）。（早期提案所述 per-file / per-N-files / per-directory 的 diff 文本分片已随 RFC-060 删除 agent-multi 而退役；其残留死代码 `util/diffSplit.ts` 已按 2026-08-12 审计决策 D12 于 RFC-284 中删除，勿复活——见 `design/system-commons-unification-audit-2026-08-12.md` 与 `design/RFC-210-recursive-submodule-isolation/proposal.md`。）Aggregation by shard_key dictionary order. **Failure semantics are fail-all-after-join** — any failed shard fails the whole wrapper, with no partial aggregation and **no auto `errors` port** (the `errors` port and partial tolerance described in `design/proposal.md` are DEFERRED, not implemented in v1; see `design/design.md` §6.3 and the lock in `packages/backend/tests/scheduler-audit-s18-s19-fanout-failure-semantics.test.ts`).
- **Git wrapper** — no inputs, single output `git_diff` (snapshots commit + worktree before first inner node, after last; composes diff incl. untracked).
- **Loop wrapper** — `max_iterations` + `exit_condition` (port-empty / port-equals / port-count-lt). v1 has **no cross-iteration feedback ports**; cross-iter state is via worktree files only. Wrappers nest arbitrarily; `git in loop` = per-iter diff (last-iter wins as output); `loop in git` = full-loop total diff.
- **Process lifecycle** — runtime children are ordinary processes, not isolated tenants. The daemon still records PIDs, bounds output, enforces timeout/cancel, escalates TERM→KILL across the process tree, drains pipes, and repairs interrupted rows after restart. Script `readonly` means disposable worktree plus no merge-back, not filesystem write denial.
- **Resource ACL（RFC-099 / RFC-231）** — 代理/技能/MCP/插件/工作流/工作组六类资源各带单一 `owner_user_id` + `visibility('public'|'private')` + 通用 `resource_grants` 授权表；未授权用户完全不可见（列表过滤、详情 404 与不存在同形）。所有用户可创建，受支持的新建路径统一为创建者 owner + `private` + 零 grants；存量行不回填，框架 built-in 显式保持 `public`，缺失 visibility/SQLite 的 `public` default 只作 legacy/raw-SQL 兼容。启动任务只校验工作流本身可用（引用闭包隐式授权），保存工作流/代理时只校验**新增**引用（`services/resourceRefs.ts`）。任务成员（owner+collaborator）即评审/反问的回答权边界（节点级指派机制已删除）；任务继续走独立的成员制**私有**模型、无 visibility 开关。归属记录（user id + 任务关系角色快照 {owner,user,admin}）只落审计列与 UI，**绝不进入 agent prompt**（rfc099-prompt-isolation 测试双层锁定，approval_meta 端口已剔除 decidedBy）。反问支持服务端逐题协作草稿（last-write-wins + 逐题归属 + 提交冻结）。记忆权限现状（2026-08-12 按源码对账更正，原「repo/global 仍 admin」记载过期）：读面——资源 scope 随绑定资源可见性，repo/repo_group/global 全员可读（`services/memory.ts` canViewMemory；RFC-285 Q4 例外：status='candidate' 的未审蒸馏行仅资源管理员可读，人审发布后回到全员面）；管理面——随 scope 资源写权 + 资源管理员（admin+manager，isResourceAdminRole）全量兜底（canManageMemory）。单一事实源：`services/resourceAcl.ts`。
- **Task lifecycle** — worktree per task at `~/.agent-workflow/worktrees/{repo-slug}/{task-id}`. Base branch chosen at launch time (default repo HEAD). Task status states: `pending / running / done / failed / canceled / interrupted (daemon restart) / awaiting_review / awaiting_human`（RFC-097 勘误：任务级从无 `exhausted`——它只是 node_run 状态〔loop 触顶〕，loop 耗尽时任务以 `failed` 收场）. Writes go through `setTaskStatus`/`trySetTaskStatus` (services/lifecycle.ts, RFC-097 CAS + 转移表；直写被 s14 守卫禁止). Cancel keeps worktree; resume rolls each retried node back to its `pre_snapshot` (git stash hash); single-node retry cascades downstream by default. Retries produce independent `node_runs` keyed by `retry_index`.
- **Daemon** — single Bun process, flock single-instance lock, graceful shutdown 30s, hourly background tasks (events archival, optional worktree GC, resource-limit check at 1Hz).
- **Tech stack** — backend: Bun + Hono + Drizzle + bun:sqlite (WAL/NORMAL) + ULID. Frontend: Vite + React 19 + TanStack Router/Query + xyflow v12 + i18next + **仓内手写公共组件库**（`components/*.tsx` + 单一 `styles.css`；**没有** shadcn / Base UI / Tailwind——早期设想过、最终未引入，新组件按 §Frontend UI consistency 复用或最小扩展既有原语）. Distribution: `bun build` single binary, GitHub Releases（macOS arm64 + Linux x86_64/arm64 + Windows x86_64，见 `README.md` 下载表与 `.github/workflows/release.yml` matrix）.

## Resolved open questions

The original proposal flagged several open questions; the supplemented design docs resolve them:

- **Runtime config coexistence** — the daemon adds the selected agent/MCP/plugin/skill overlay while preserving the runtime's ordinary machine and project discovery. Same-name merge behavior follows the selected runtime. No platform attestation claims that inherited surfaces are absent.
- **Session ownership** — native conversation IDs use neutral DB single-writer leases so concurrent writers are rejected. Runtime binary/config/store provenance is not persisted as a trust identity. RFC-276 migration explicitly ends pre-cutover native sessions rather than pretending they can resume across the storage change.
- **Same-task concurrent writers** — `agent.md` carries `readonly: true/false`; framework serializes writes within a task and parallelizes only readonly nodes.
- **Same-repo cross-task collisions** — every task gets its own `git worktree add` under `~/.agent-workflow/worktrees/{repo-slug}/{task-id}` and runs all its runtime children with that as cwd.

The full current contract and repository code anchors are in `docs/OPENCODE_CONFIG.md` and
`design/RFC-276-runtime-hardening-deprecation/`. RFC-205/216/224/227/233 are historical records,
not current execution guidance.

## opencode 源码自取规则（强制）

opencode 是本平台驱动的 CLI，行为细节须以源码为准、不靠记忆。**遇到以下场景必须主动 grep / 读源码**：

- 任何涉及 opencode 进程启动、CLI 参数、环境变量（`OPENCODE_*`）、退出码、stdout/stderr 协议的判断。
- agent / skill 加载顺序、合并优先级、`.opencode/` 目录扫描规则（典型入口：`packages/opencode/src/config/config.ts`、`packages/opencode/src/agent/`、`packages/opencode/src/skill/`）。
- 输出 XML envelope 格式、tool-use 协议、session 行为。
- 任何 "opencode 是不是支持 X" / "opencode 在 Y 情况下表现如何" 的问题。

读取方式：直接用 Read / Bash(grep|rg) 即可——这是公开源码、纯只读、零副作用。读完在回复里**引用具体文件:行号**，让用户能追溯依据。

**引用一律写成纯文本 `path/to/file.ts:120-148`，禁止写成 GitHub 外链**（2026-08-17 实测）：落进 `design/**/*.md` 的 `https://github.com/…/opencode/blob/<tag>/…#L120-L148` 会被 CI 的「Markdown link check」逐条请求；该仓对 workflow token 解析不到（404），于是**每次 CI 都红一格**，而红的原因与提交者本次改动毫无关系——曾连红三个提交、各自作者都要先花时间排除自己。纯文本引用同样满足上面的可追溯要求（本机 checkout 路径见下），且不依赖任一外部仓库保持公开或 tag 不动。

跨 session 也一样：新接手任务时若 RFC / design 里出现了对 opencode 行为的断言（例如 "opencode 合并 config 时 inline JSON 优先级最高"），上手前先去源码验证一遍再继续，避免基于过期假设写代码。

本机 opencode 源码具体路径由 Claude 从 per-user memory 解析。
