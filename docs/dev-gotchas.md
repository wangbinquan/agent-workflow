# 开发踩坑与经验（多人协作）

> 跨 RFC 反复踩到的**通用**陷阱与规律，从历次交付中沉淀。RFC-**专属**的实现细节看各 `design/RFC-XXX/design.md`；本文件只收对**任何**贡献者都有用的可复用经验。CLAUDE.md 是强制规则，本文件是「见到 X 多半是 Y」的实战 tips。

> ## ⚠️ 作废通知（2026-08-23，用户明令）：本文件多条 tips 的**处方**已失效
>
> `CLAUDE.md` §工作准则新增硬规则：**只在 `main` 上开发——不建分支、不用
> `git worktree`（开发用途）、不用 `git stash`，且本地 `main` 必须时刻与
> `origin/main` 同步、不得落后**。
>
> 本文件里凡是把「`git worktree add` 开一棵只含自己改动的干净树」「`git stash` /
> `git stash -u` / `stash push -- <path>`」写成**定式 / 首选做法**的段落（§测试 / CI
> 的隔离门禁、§git 多人协作的对照实验与「在别的 base 上做提交」、impl-gate 的
> `commit-tree` + 分离 worktree 跑法等），其**处方部分一律作废**，不得再照做。
>
> 这些条目**保留**的价值在于它们记录的**危害本身**——共享树上的红有三种来源
> （自己的改动 / 他人未提交的改动 / 正在被编辑的中间态）、门禁结果无法归因、
> 并发 diff 吞掉 review——这些依然真实。**替代处置**（在主树上做）：
>
> - **要判「这条红是不是我的」**：不要造隔离树。先按 exact SHA 查 `origin/main` 上
>   该守卫的既有 CI 结果确认它本来是绿的，再在主树上**单跑那几个守卫测试**拿到确切
>   失败断言与其点名的路径；失败集合里指向他人路径 / 他人 RFC 命名空间的，不是你的。
> - **要在干净基线上验证**：把改动提交上去，让 **CI** 在干净 checkout 上跑——CI 绿是
>   最省事也最权威的证据（本仓 CI 只在 `push to main` 触发，而我们本来就直推 main）。
> - **要限定 Codex review 范围**：按路径告诉它只看自己改过的文件，读 findings 时剔除
>   指向他人路径的条目。
> - **要避免误提交别人的东西**：按路径精确 `git add <file>`，提交前
>   `git diff HEAD -- <file>` 逐 hunk 认领；**绝不**用 stash 去「隔离」别人的改动
>   （历史上已实测吞掉过对方 261 行）。
>
> 判据很简单：**读到本文件任何一条让你 `git worktree add` 或 `git stash` 的建议，
> 一律不执行**。产品自身的 worktree 能力（任务隔离 `~/.agent-workflow/worktrees/`、
> git wrapper 快照）不在此列——那是被开发的功能，与开发流程无关。

> ## ⚠️ 作废通知（2026-08-24，用户明令）：`gate:local` 不再是提交前置条件
>
> `CLAUDE.md` §Test-with-every-change 的「运行门槛」已改为：**本地不跑门禁，直接提交，让 GitHub
> Actions 跑**。原因是本仓多 session 并发共用一棵工作树，本地全量门禁 8–10 分钟、吃满 CPU、还带
> 跨 worktree 单实例锁，互相挤占把提交吞吐压到极低。
>
> 因此本文件下面凡是把「push 前跑一遍 `gate:local` / 跑到全绿再推 / 先 `git add -N` 再跑门禁 /
> 推之前补跑 `RUN_GIT_NETWORK=1 …`」写成**定式**的段落，其**处方部分作废**——不必为了推代码去跑它们。
>
> 这些条目**保留**的价值在于它们记录的**失败模式**依然真实，只是暴露点从「本地门禁」挪到了 CI：
> `git ls-files` 型守卫看不见 untracked 文件、e2e / gitleaks / system-mock / `RUN_GIT_NETWORK`
> 用例本来就不在本地覆盖面内、贴着 5s 超时的用例在负载下假红、`| tail` 吞掉退出码……**读它们的正确
> 姿势是「CI 红成这样时，多半是这个原因」**，而不是「所以我推之前要先在本地跑一遍」。
>
> 相应地，**push 之后的责任变重**：按自己的确切 sha 查 CI、盯到绿为止，红了立刻补一提或 revert
> 自己那笔——`main` 是全员共用的主干。`bun run gate:local` / `bun run test:backend:serial` 仍是
> 复现 CI 红、排查顺序依赖的**诊断入口**。

## 测试 / CI

- **事务测试的故障注入用 SQLite 触发器，不用模块 mock**（2026-08-25 实测，RFC-326 PR-A）：本仓测试零 `mock.module`（bun 的模块 mock 是**全进程**生效，会污染同进程后跑的其它文件），而「事务中途失败 ⇒ 六表整体回滚」这种断言又必须在**事务内的某个指定写点**引爆。做法：`db.$client.exec("CREATE TRIGGER inject BEFORE UPDATE OF status ON node_runs FOR EACH ROW WHEN NEW.status = 'done' BEGIN SELECT RAISE(ABORT, 'injected'); END")`——触发器只对那张表那个写点生效，抛在同一个 `dbTxSync` 里，正好落在「归档之后、提交之前」；`DROP TRIGGER` 后重放同一请求，还能顺手证明「失败可修复」。同一手法能把**提交后的 best-effort 写入**（蒸馏入队 `memory_distill_jobs`）打断而一行生产代码不碰。数「到底开了几个事务」用 `tests/helpers/statementRecorder.ts`：drizzle bun-sqlite 的事务走 `exec`，录到的就是裸 `BEGIN DEFERRED` / `COMMIT` / `ROLLBACK`，按位置还能断言「某条 insert 在 COMMIT 之后」。
  - 判据：想验证的是「哪个写点之后失败」就在**那个写点的下一条语句**上挂触发器；触发器挂在读语句上无效（`SELECT` 不触发）。
- **`rfc247-route-registry` 与 `rfc317-route-contract-oracle` 不能放进同一个 `bun test` 进程**（2026-08-25 实撞）：registry 用例向全局 route-meta registry 挂了一条 `GET /api/__registry_fixture_public__`，它每个 case 前 `resetRouteMetaRegistry()`，但**最后一个 case 留下的挂载活到进程结束**；oracle 扫的是同一个全局 registry，于是多出一条「无契约端点」假红（`+ "GET /api/__registry_fixture_public__"`）。CI 分片碰巧把两者分开，本地按关键词批量跑（`bun test rfc247 rfc317`）就会撞。判定同族假红的定式同上一条「单跑绿 + 改动面无关」：oracle 单独跑即绿。
- **计划里打了勾却没有一条测试 / e2e 引用它的能力，就当它不存在**（RFC-326 实测，2026-08-25）：RFC-247 plan T18「人工门工具完整面（… `submit_review` 逐文档评论+通过打回）」自 2026-08 起一直是 `[x]`，而 `mcp/tools.ts` 里只有三个门工具、`submit_review` 只送决策，三个门工具在 tests / e2e 里零引用——评论那一半从未落地，还带着一个把 `iterate` 当决策值的枚举（REST 只认 `iterated`，iterate 经 MCP 根本打不通）。这不是某个人的疏忽，是「勾」这个动作本身没有机器判据。定式：**声明「某个面完整」的地方必须有一条从代码两边各自派生、两向相等的守卫**（本仓例：`tests/architecture/rfc326-review-tool-route-guard.test.ts` 用 `mountReviewRoutes` 填的注册表 ⟷ 每个工具真实分发到的路径），豁免名单显式入账；打勾的 plan 条目要么指向那条守卫，要么指向一条会红的测试。
- **单条语句的 CAS 不要为「统一形状」套一层事务**（RFC-326 PR-A 推红实撞，2026-08-25）：把 `transitionNodeRunStatus` 改成 `dbTxSync(...)` 包装同步版，看起来只是形状统一，实际给每次状态转移多了一对 BEGIN/COMMIT；`runner.test.ts` 用「下一个事务失败一次」的代理模拟 SQLITE_BUSY 时，先咬到的是这层多余事务而不是租约事务——本地限定套件全绿、CI 分片红。判据：一条 `UPDATE … WHERE … RETURNING` 本身原子，包装层只该复用同一段代码（把连接当作同步面传进去），不该开事务；测试里凡是「计数 / 拦截事务」的桩都在提醒你这层语义。
- **stub 的 `<port>` 内容会被信封解析器去掉尾部换行**（RFC-326 e2e 实测）：e2e 把 stub 常量与 `get_review` 的 `currentBody` 逐字比较时红了一行——只差最后一个 `\n`。比较正文用 `trimEnd()`；偏移断言不受影响（只有尾部被裁）。顺带：`review-doc` stub 模式（`packages/system-mocks/src/runtime/mode-review-doc.ts`）会把提示词协议块里**声明的每个端口**都填成同一份文档，新 e2e 要评审一份「有标题 / 行内代码 / 重复词 / 代码块 / HTML 注释」的真文档时直接用它，别再造夹具。
- **react-markdown 的 hast `position` 不是处处都有**（RFC-326 D5 实测，2026-08-25）：段落 / 标题 / 行内代码（区间**含反引号**、值不含）/ 转义 / 实体 / 表格 / 列表项文本都带源文偏移；**围栏代码的文字、KaTeX 输出、GitHub alert 的首段、硬换行、脚注引用**没有。按源偏移高亮时这些节点各走各的回退（代码块交给 shiki `decorations`，公式一律不高亮，alert 首段在相邻两个带位置片段之间做窗口文本匹配），而且 shiki 4 对**交叉**的 decorations 直接抛 `intersect`——先切成互不交叉的原子段再喂。

- **门禁在跑的时候别在同一台机器上另跑 `bun test`——有 5s 硬超时的用例会成批假红**（2026-08-20 实撞三次）：同一轮里先后收到 `rfc098-process-governance`、`scheduler-clarify-dispatch`、`rfc193-port-artifacts`（archive-at-emit）的红，**三条单跑全绿**，且失败耗时都是 ~5.2s——正好压在那些用例的 5s 超时上。成因是 backend 四分片本来就吃满 CPU，我又在共享树里并行跑单文件测试。
  - 判据：失败耗时高度一致且贴着某个硬超时 + 改动面与该用例无关 + 单跑绿 ⇒ 资源竞争，不是回归。**但别就此放行**：先单跑确认，再看这一轮门禁里有没有同族的真红被淹没（RFC-304 PR-2 那条「并发红与自己的红同时出现」是同一个坑的另一半）。
  - 定式：门禁跑起来之后就等它，要验证别的用例就等门禁结束，或者把它放进另一台机器/另一棵树并接受它同样会互相抢。

- **CI 上的 5s 假红不是「别人抢 CPU」，是这条用例本来就该有自己的预算**（2026-09-02 一轮里咬到三条）：上一条讲的是「门禁在跑时别在同一台机器上另跑测试」——那是**本地**能躲开的竞争。CI 躲不开：backend 四分片就是设计成并行的，e2e 另有多腿同跑。于是**任何做真实 I/O 的用例只要贴着 bun 默认的 5s 上限，就会周期性假红**。一轮里咬到的三条，失败耗时全部是 5.0～5.1s，而且本机单跑都在 1.4～2.5s：
  - `rfc213-restore`（tar+gzip 打包 → 解包 → swap → 迁移，整份文件每条都在做）；
  - `rfc210-subrepo-snapshot-rollback` 的 `.gitmodules` 短路那条（要真的 `git init/add/commit` 造一个仓）；
  - `rfc310-employee-case-runtime` 的 WorkStart 那条（一条用例近 1900 行，建库 + 写 FS + 多播 + 投影回读）。
  - **处置**：给它一个**说得出理由的显式预算**（整份文件都是这个形状就 `setDefaultTimeout(30_000)`，只有一条就 `test(name, fn, 30_000)`），并在注释里写清「这是预算不是性能门」+ 那次红的 run id。本仓早就有这个惯例（同文件里嵌套回滚那条写着 90_000），只是新用例容易漏。
  - **不要**把它当成「重跑就过了」：判据仍是先单跑确认、再看同轮有没有真红被淹。真正的性能门要另立判据（例：RFC-210「零 submodule argv」是靠**源码锁**断言 `existsSync` 先于 `runGit`，不是靠墙钟），这样加预算就不会把门一起放松。

- **本仓有三个包，`bun test` 跑的是「当前目录那一个」——改了 `packages/shared` 就必须单独跑它**（2026-08-25 实撞，RFC-324）：改动同时动了 shared 的 schema（资源 ACL 与任务成员的 wire）与 backend / frontend 的消费方。我跑了 backend 的相关子集（全绿）和 frontend 全量 6807（全绿）就推了，**CI 上 8 个 backend shard 全红 + Lint 腿红**——Lint 腿里跑的是 `@agent-workflow/shared` 的 2245 条，其中 4 条断言的正是我改掉的那两个 schema。
  - 为什么容易漏：`bun test <路径>` 在仓根跑会按路径过滤，看起来「跑过了」；而 shared 的测试在 `packages/shared/tests/` 下、由 CI 的 **Lint + Typecheck + Format + Shared + system mock** 那条腿执行，跟 backend 四分片不是同一个 job，名字里也没有 "test"，扫 job 名的时候最容易划过去。
  - 定式：**改了 `packages/shared/src/schemas/` 下的任何文件就同时跑 `cd packages/shared && bun test`**。更一般地——推之前问一句「这次改动跨了几个包？我是不是每个包都跑了？」三个包各有各的 runner（backend/shared 是 `bun test`，frontend 是 `vitest`）。
  - 同一批还暴露了第二种漏法：**改了公共判据的名字或错误码，要 grep 的不只是生产代码**。`requireResourceOwner → requireResourceGovern` 在生产代码里零残留了，但**测试**里还有三类引用活着——按旧名断言的架构守卫（`requireOwnedEmployee`）、按旧错误码断言的行为测试（`code: 'forbidden'` 被分流成 `resource-read-only` / `resource-govern-owner-only`）、以及**账本类守卫**（新增的 allowlist 要入 `ledger-baselines.json`、新增的源码锁要入 `guard-manifest.json`、新增的端点要进 `tests/contracts/registry.ts`）。这三类都不会被 `tsc` 抓到，只会在 CI 上红。
- **常规 CI 的 e2e 腿跑的是「PR 档」，`@nightly` 那批只在 `e2e-full-nightly` 里跑——`CI` 全绿 ≠ e2e 全绿**（2026-08-25 实撞，RFC-324）：`.github/workflows/e2e-full-nightly.yml` 头注释白纸黑字——PR / push 的 `e2e` job 带 `--grep-invert '@nightly'`，P2/P3 用例只在那条腿跑。我盯着 `CI` 那个 run 逐格修到只剩一格别人的红，以为收工了；`e2e-full-nightly` 里躺着 4 条红，其中 3 条是我的真回归（一个只读被授权者点不开的 ACL 弹窗，两份用旧 wire PUT 成员的 spec）。
  - **两个坑叠在一起**：①它只有 `schedule`（06:00 UTC）+ `workflow_dispatch`，**没有 push 触发**，所以一条回归最长能潜伏近 24 小时；②潜伏完暴露时，run 的 `headSha` 是「06:00 那一刻 main 恰好在哪」，**多半挂在别人的 commit 上**（归因规矩见本文件 §归属那条：`event=schedule` 的 nightly 不可按 commit 归因）。
  - 定式：**改动碰了任何 e2e 覆盖的用户面，收工前手动 `workflow_dispatch` 跑一次 `e2e-full-nightly`**，别等第二天；看它的红时**按失败用例碰的是谁改的面来归因**，不看 headSha——我这次 4 条里 3 条是我的、1 条是并发 session 的，靠的全是读失败内容。
- **起真进程做验收时,失败信息必须同时打印 stderr——只读 stdout 会让崩溃「无因可查」**（2026-08-19 实撞）：`tests/cli.test.ts` 的 `waitForReady` 只读 daemon 的 stdout，于是 CI 上一次「daemon exited before ready」的报错里，只有到「pre-migration backup written」为止的正常日志，**真正的错误一个字都没有**（它写在 stderr）；本地又复现不出来，等于线索归零。判据：**任何 `Bun.spawn` + 等待就绪的测试助手，失败路径都要把 stderr 一并附上**——正常路径不需要它，恰恰是失败路径唯一需要它。修法见该文件 `waitForReady` 的第三个参数（后台异步读 stderr、失败时拼进 message）。
- **本地门禁对「本批新增的文件」可能整批假绿——用 `git ls-files` 枚举源码的守卫看不见 untracked 文件**（2026-08-19 实测，RFC-311 T19）：`tests/route-error-code-coverage.test.ts` 这类守卫先 `git ls-files -- 'src/routes/*.ts'` 再扫描，而**未跟踪的新文件不在输出里**。我连跑三轮 `gate:local` 全绿，`git commit` 之后 CI 立刻红在「新错误码没有测试点名」——同一台机器、同一份代码，差别只是文件从 untracked 变成 tracked。同类枚举式守卫（端点↔契约注册表、卡片计数、AST ratchet…）都吃这一口。
  - 定式：**新增文件的批次，跑门禁前先 `git add -N <新文件>`**（intent-to-add，只登记路径不入暂存内容），让所有 `git ls-files` 类扫描立刻看见它们；批次全绿再正常 `git add` 提交。
  - 判据：本地绿、推上去红，且红的那条守卫「按文件枚举」——先查它怎么列文件，而不是先怀疑环境差异。
  - **同族的另外两种空洞绿**（2026-08-19 同日各自实测，一并记在这里免得分散）：①**平铺枚举**——`readdirSync(dir)` 不递归，今天目录恰好没有子目录时最危险：第一个建子目录的人不会收到任何信号，守卫当场变瞎（e2e↔端点注册表守卫实测，反事实 fixture 放子目录后修改前直接放行）；②**不失败关闭**——目录挪走 / 后缀改名 / 匹配写法变化后循环空转，而测试是绿的，必须补「扫到的东西不少于 N」这类下界，最强的形式是**与权威清单做集合相等**（`settings-scope-coverage.test.ts` 断言扫到的 scope 集合 === `SETTINGS_CONFIG_SCOPE_IDS` 的键集合，某个 tab 挪去别的文件立刻红）。
  - 通则：**任何靠「自己去列一遍」建立结论的守卫，都要先证明它列全了**——枚举面本身必须有断言，否则「没找到违规」和「没找到东西」在结果上同形。本仓早有先例把这句写进注释（S-14 棘轮的「防止扫描器失效导致全文件 0 命中的空洞绿」），但新写的守卫仍反复漏。
  - 定式：写完任何静态清单 / 扫描型守卫，问三句——**枚举得到 untracked 吗？递归吗？扫到 0 个会红吗？** 三句过完再按老规矩把真实事故的形态注回去做变异检验；**变异用的 fixture 放 scratchpad，别往共享树里塞故意的红**（见 §git/多人协作）。
- **分离 worktree 里用 `ln -s` 借 node_modules，会让「跨包解析」类的用例假红（2026-08-17 实测）**：
  为了绕开他人在共享树上的在途改动，我 `git worktree add` 了一份只含自己改动的树，node_modules
  用软链指回主树。3/4 分片绿，第 4 片红在 `rfc199-…-ratchet`：它用 TS compiler program 找语义
  来源，期望里的两个文件都在 `packages/shared`——因为 `@agent-workflow/shared` 顺着软链解析回
  **主树路径**，`relative(REPO_ROOT, …)` 算出来的相对路径对不上，于是被过滤掉了。
  定式：分离 worktree 要么**老老实实 `bun install`**，要么只信「不跨 workspace 包」的用例。
  判据：假红集中在「用 compiler program / import.meta / 相对路径反查文件清单」的那类棘轮，
  且缺的正好是别的 workspace 包里的文件 ⇒ 先怀疑 node_modules 的解析路径，别改棘轮清单。
  另注：`gate:local` 有**跨 worktree 的单实例锁**，同机另一个 worktree 在跑就直接拒绝——
  多人（多 agent）并发时这是特性不是故障，等它跑完即可。

- **本地跑过 Playwright 之后再跑 `gate:local`，backend 会红在四条毫不相干的用例上（2026-08-17 实测）**：
  症状是 `error: Test leaked 1 entry into its working directory (…): - test-results`，
  然后随机四条 backend 用例 `(fail)`——它们只是恰好是「第一个发现工作目录多了个条目」的那几条。
  真因：Playwright 失败时会在**仓库根**写 `test-results/`（gitignore 了，但目录还在），
  而 `packages/backend/tests/setup.ts` 的工作目录泄漏守卫会把它算成本次测试泄漏出来的。
  定式：**跑完 e2e、跑 gate 之前先 `rm -rf test-results`**（本仓的典型顺序正好是
  build:binary:e2e → playwright → gate:local，天然踩得到）。判据：backend 红的那几条彼此
  毫无关系、且报错里出现 `Test leaked` 与一个你没写过的目录名 ⇒ 先看仓库根有没有工具残留，
  别去读那几条用例。

- **`bun run gate:local | tail -40` 的退出码是 `tail` 的，永远是 0——门禁红了你也看到「exit 0」（2026-08-17 实测，红代码直接进了主干）**：
  管道的退出码取**最后一个**命令。把门禁/typecheck/lint 接到 `tail` / `head` / `grep` 后面看输出，
  等于把它们的成败**丢掉**：后台跑一条 `bun run gate:local 2>&1 | tail -40`，通知里回报 `exit code 0`，
  实际 backend typecheck 是红的，那条改动照样 commit + push 上了 main。
  定式：**要退出码就别接管道**——`bun run gate:local > gate.log 2>&1`，事后再 `tail` 看日志；
  非要接管道就 `set -o pipefail` 或显式读 `${PIPESTATUS[0]}`。
  判据：一条本该跑好几分钟的门禁「秒回 exit 0」、或输出文件是 0 字节而退出码是 0 ⇒ 就是这个坑。
  **更隐蔽的第二形态：门禁根本没跑，也是 exit 0**（2026-08-20 又踩一次，同一个坑）——`gate:local` 有
  跨 worktree 的单实例锁，同机另一棵树在跑时它**立刻返回 2**（`scripts/local-gate.ts` 的
  `runLocalGate` 捕获 `LocalGateAlreadyRunningError` 后 `return 2`），那个 2 同样被 `tail` 吞成 0。
  与「门禁红了」相比它更难发现：唯一线索是日志里一行 `[gate] LocalGateAlreadyRunningError: …`，
  夹在 `bun install` 的输出后面像条噪声，而**没有任何测试结果**——正因为一条都没跑。
  所以上面那条判据要连着用：**既看退出码，也看日志里到底有没有跑出测试计数**。

- **在「状态写库」与「读者能看到」之间插一次网络调用，就是给所有等这个状态的人开了一个窗口（2026-08-17 实测，本地 328 全绿、CI 三个分片红）**：
  给轮次终局加了一步「更新 MR 上的回执」，顺手放在了工作项状态转移**之前**。本地
  `--workers=1` 全绿，CI 一分片 4 worker 就红：用例等「轮次 endedAt 非空」然后断言
  「工作项是 awaiting」——两次写之间多了一个 code-host 往返，于是「轮次结束了、工作项
  还没动」这个中间态被读到了。
  定式：**先把人看得到的状态写完，再去做对外 IO**（发评论 / 发通知 / 调 API）。判据：
  你要插入的调用会跨进程/跨网络，而它后面还有一次本地状态写 ⇒ 换个位置。
  配套：那条用例本身也犯了本节开头那条「等的条件比断言的条件弱」——已改成等它真正
  断言的那个状态。两件事都要修：改顺序是对的，但只改顺序等于让下一次抖动重新赢。

- **「并发化」修不了「总量就是超预算」——超时的两种成因要分清（2026-08-16/17 连红两次，都是我）**：
  一条用例要跑 12 次 `git check-ref-format`（每次一个进程）。串行 5002ms / 默认 5000ms ⇒ 红。
  我以为是「串行浪费」，改成 `Promise.all` 并发；**下一次 macOS 分片仍红，5000.74ms**。
  真因不是顺序而是**总量**：四个 backend 分片抢一台 runner 时，12 次进程创建本身就要五秒开外。
  判据：先分清超时是①**竞态**（结果随时机变）还是②**工作量**（结果恒定，只是慢）。
  ①才不许抬 timeout（抬了只是把红推到更忙的机器上）；②抬 timeout 是**正解**——断言一个字没弱，
  该跑的还是全跑。看断言里有没有时间语义即可区分：`check-ref-format` 接受与否与快慢无关 ⇒ ②。

- **接线之前先确认「下一层做得到吗」——两次实测，都只有 e2e 抓得住（2026-08-17）**：
  ①「总览零调用方」⇒ 接上 ⇒ e2e 红：mr-review 早就在用另一个标记维护总览，我加的是第二条。
  ②「回执零调用方」⇒ 接上、14 条单测全绿 ⇒ e2e 里回执**从未到达**：shared 的 action 目录
  `comment.create` 只支持 MR（GitLab binding 是 `merge_requests/{mr}/notes`），**没有 issue
  版本**，在 issue 上发评论这件事平台根本做不到；GitHub 恰好能（issue/PR 同端点），这种
  provider 不对称最容易让半残功能看起来像完成了。
  两次的共同形状：**符号级判断对、产品级判断错**，而单测永远抓不到——它测的是模块，模块
  一直是对的。定式：接一条「对外输出」之前，先用真事件跑一条端到端，或者至少把它依赖的
  下层能力（action / 端点 / 权限）逐个确认一遍。判据：你要接的东西最终会变成一次
  HTTP 调用 ⇒ 先确认那个调用**存在且支持这个对象类型**（MR？issue？pipeline？）。
  收尾纪律：确认做不到时，**把接线撤掉**，别留一条只会记 warning 然后返回的调用——
  那比没接更糟，它看起来像做完了。

- **任务表里的 ✅ 也会说谎——收尾前按「零生产引用」重扫一遍自己的账（RFC-304 关闭时实测，两行 ✅ 是假的）**：
  RFC-304 的任务表里 T63（框架发布 revision/canary/回退）与 T64（模板上游四态）都标着
  ✅，实际 `domain/frameworkRelease.ts` / `domain/templateUpstream.ts` **零生产导入**——
  域层写完了、单测绿了、没有路由没有界面，从没有任何生产代码调用过。当初记 ✅ 的判据是
  「模块和用例都在」，而那不等于「这一项做完了」。
  定式：**RFC 收尾/关闭前，对该 RFC 新增的 domain 模块做一次「除定义文件外零生产引用」
  普查**，对不上的行要么补接线、要么改状态并写明归宿——别让一个 ✅ 把「还没接上」封存进
  历史。判据：一个模块只被自己的单测导入 ⇒ 它承诺的那件事在产品里没发生。

- **「这个函数零调用方」≠「这个产品承诺没兑现」（2026-08-17 实测，差点把噪音当修复推上去）**：
  查出 `mrVoice.updateSummary` 全仓零调用方，据此判定「MR 上从未出现过 bot 总览评论」并接线；
  接完 e2e 立刻红——`POST /notes` 从 1 变 3。真相是 **mr-review 早就在维护一条总览**，走的是
  另一个标记（`<!-- aw-review-overview -->`）和另一条路径（`publishReview.renderOverview`），
  承诺**早已兑现**；我加的是第二条互相竞争的总览，等于亲手制造那条规则要防的噪音。
  定式：符号级的「零调用方」只是**线索**，下结论前必须回答「这件事在产品面上到底发生没有」
  ——换个词再 grep 一遍（marker / 正文关键字 / 路由），或直接跑一条端到端场景看真实产物。
  判据：你要接的东西**是产品对外可见的一次输出**（评论 / 通知 / 邮件 / 文件）⇒ 接线前先确认
  现在到底有没有这条输出，别只看有没有人调你手上这个函数。

- **`mock.module` 是**进程级**的，而 backend 分片一个进程跑几百个文件——在 A 文件里 mock 一个模块，B 文件跟着中招（2026-08-17 实测，十四条无关用例集体转红）**：
  给新写的用例换掉 `codeHostAdapter`，本文件 7 条全绿，跑全量时 `rfc304-code-host-wire-*`
  的十四条 wire-format 用例（另外两个文件）全红——它们拿到的是我的假 adapter。
  bun 的 module registry 没有按文件隔离，`bun test` 的分片又是**一个进程跑一批文件**。
  定式：**依赖注入优先**——给生产函数加一个可选端口参数（`codeHost?: CodeHostPort`），
  用例按参数传假的；`mock.module` 只在「被 mock 的模块全仓只有这一个文件用」时才安全。
  判据：新用例本文件绿、`bun test packages/backend/tests/` 全量红，且红的是你没碰过的文件
  ⇒ 先查自己有没有 `mock.module`。

- **`gate:local` 不跑 Playwright —— 新增 e2e spec 时「本地门禁全绿」不构成任何证据（2026-08-16 实测被 CI 打脸）**：
  门禁只跑 backend / shared / frontend 三条单测 + typecheck/lint/format，**e2e spec 只在 CI 跑**。
  于是「新写一条 e2e + gate:local 全绿 + push」的流程里，那条新用例**一次都没被执行过**就上了主干。
  实测后果：一条自己写出来的 race 在本地从没跑过、CI 上连 retry 一起红。
  定式：**新增/改动 e2e spec 必须本地显式 `bunx playwright test <spec> --project=chromium --workers=1` 跑过**
  （改了后端源码还要先 `bun run build:binary:e2e`），并且**连跑三遍**再 push。
  判据：commit 里有 `e2e/*.spec.ts` 而你只看了 gate:local 的绿 ⇒ 你还没测过它。

- **等的条件比断言的条件弱 = 一条迟早会红的 race（同一次实测）**：
  写法长这样——`waitFor(stages.length > 0)` 然后 `expect(stages.find('classify').status).toBe('done')`。
  第一个阶段一开始跑等待就满足了，而断言的是**后面**那个阶段的终态。它会**一直碰巧赢**，
  直到某次时序变化（本例：给同一个 spec 加了第五条能力）或换台更忙的机器才输。
  定式：**等待条件必须与断言条件同一个**——要断言 `classify` 终态，就等 `classify` 终态，
  别等「有任何阶段」。判据：`waitFor` 里的谓词与 `expect` 的主语不是同一个对象 ⇒ 就是这个坑。
  （修法不是加 timeout、更不是重跑到绿——见本节开头「flaky 不能掩盖红 case」的仓规。）

- **Playwright e2e 跑的是 `dist/` 里的二进制，不是你刚改的源码（2026-08-16 实测，浪费一整轮）**：
  `e2e/harness.ts` 的 `startDaemon()` 启的是 `dist/agent-workflow-e2e-<platform>`。改完
  `packages/backend/src/**` 直接跑 `bunx playwright test`，**跑的还是上一次 build 的行为**——
  症状是「我明明修了，e2e 结果一个字没变」。改一次源码就 `bun run build:binary:e2e` 一次，
  再跑 spec。判据：e2e 的失败输出与改动前**逐字节相同**（连时间戳外的措辞都没变）⇒ 先怀疑
  二进制陈旧，别去怀疑自己的改动没生效。反过来也成立：e2e 绿但你没重新 build，那条绿不作数。

- **单测把「出错的那个东西」当参数递进去，于是永远发现不了它错了（RFC-304 2ter 实测，一次挖出三处）**：
  典型形状是 `f(db, { repoId: task.repoPath })`——`repo_capability_config.repo_id` 存 ULID，
  `task.repoPath` 是文件路径，两者都是 `string`，**类型检查、lint、单测全绿，运行时永远匹配不上**。
  这类缺陷单测天然看不见：单测自己构造那个参数，构造的当然是对的那个。同族还有「起任务时给的是
  scratch 空目录，而阶段要求一个带 `origin` 的 clone」「有 `openRound` 没有 `closeRound`」。
  判据：**一个值跨模块传递、两端各自都有测试、而两端对这个值的"含义"没有类型区分** ⇒ 只有
  端到端（真 daemon + 真 DB + 真调度）才照得出来。能便宜兜的是**源码层断言**（「`repoId: task.repoPath`
  这个写法不许出现」）——弱，但对「类型正确、语义错误」是唯一抓得住的自动化手段。

- **产品明令禁 `file://` 之后，凡「经真实启动路径」的后端单测都要用真 smart-HTTP 远端**：
  现成的是 `packages/backend/tests/helpers/gitHttpRemote.ts`（`startGitHttpRemote()` +
  `remoteUrlFor(dir)`）。reuse-by-id 启动会**逐层**校验：行在不在 → URL 能不能解封（seal 的 key
  必须与该测试里调度器用的同一把）→ scheme 合不合法 → 镜像有没有 `origin`（要剥凭据）→
  `last_fetched_at` 够不够新（旧的按 stale cache 拒）。每一层都是**对的行为、错的夹具**，
  别改生产代码去迁就夹具——那等于把刚立的规则自己拆了。

- **串行 spawn 的用例天生贴着超时线（2026-08-16 实测）**：一条断言确定性的用例
  （`rfc210-submodule-topology` 的 `check-ref-format`）在本地与多数 CI 上稳过，却在一次
  macOS runner 上以 **5002ms / 5000ms** 超时红了——它顺序 spawn 了 12 个子进程，而 backend
  是 4 shard 并行跑，单次 spawn 在负载下涨到几百毫秒就够了。
  判据：**耗时正好压着 timeout** 且断言本身没有时序含义 ⇒ 不是逻辑 bug，但也**不能靠重跑**。
  正解是**去掉边缘性**而不是抬 timeout：互不依赖的子进程用 `Promise.all` 并发，检查一条不少、
  墙钟从 12 轮延迟变成 1 轮。抬 timeout 只是把同一个 race 推给下一台更忙的机器。

- **`git ls-files` 型源码守卫对**未追踪的新文件**是盲的 —— 新增文件的 RFC「本地全绿」不等于 CI 绿**（RFC-269 实例）：`route-error-code-coverage.test.ts`（还有别的同类守卫）用 `git ls-files` 枚举 `src/routes/*.ts` 再扫错误码。新写的 `routes/codeHosts.ts` 在 commit 前是 untracked，`git ls-files` 根本不列它 ⇒ **连跑六次 `gate:local` 全绿**，push 之后 CI 第一次扫到它，两个未被测试点名的错误码当场红。gitleaks 同理（本地门禁压根不跑密钥扫描）。定式：**新增文件的改动，先 `git add -N <新文件>`（intent-to-add，只登记路径不暂存内容）再跑门禁**，让这类守卫看得见；或者提交后立刻补跑一次。判据：本地绿而 CI 红、且红在一个**本次新增**的文件上 ⇒ 先怀疑守卫的枚举源是 git 而不是文件系统。
- **别给「共享工作树里存在、但还没进版本库」的生产代码写测试**（RFC-319 实撞，2026-08-24）：多人并发树上，别人的新文件可能长时间停在 `??` 未追踪状态。你的 e2e 二进制是从**工作树**构建的（含它），CI 是从 **`main`** 构建的（不含它）——于是本机全绿、CI 报 `route-not-found` / `Cannot find module`，而你会先去怀疑平台差异或自己的判据。这是上一条「`git ls-files` 型守卫看不见未追踪文件」的**镜像**。**定式**：给一条端点 / 一个导出写测试之前，先 `git ls-files <实现文件>` 确认它在库里；为空就别写——那是别人的在制品，代提他们的文件违反并发纪律。已经写了就撤回，并把对应账本条目退回缺口状态。
- **测试夹具别长得像真凭据**（同一实例）：`glpat-` / `ghp_` 前缀的假 token 会命中 gitleaks 的 `gitlab-pat` / `generic-api-key` 规则，让 CI 的 Static scans 红。假凭据用中性前缀（`aw-fixture-…`），需要断言尾号时把有意义的尾巴留在后面即可。补充（2026-08-18，RFC-310 实锤三连）：①`idempotencyKey: '...'` / `deliveryKey: '...'` 这类**字段名带 Key 的普通字面量**同样命中 `generic-api-key`——豁免定式是**双保险**：当前行加行内 `// gitleaks:allow`（管未来编辑）+ `.gitleaksignore` 按 fingerprint 钉已推送的历史 commit（`detect` 扫全历史，改当前文件消不掉）；②`.gitleaksignore` 自己的**注释**也别写 `xxxKey: '值'` 完整形态——它进了历史后同样在 diff 扫描里命中规则，得再豁免自己（真实发生，连环两次修复 commit）；③**在仓库根新建通用名文件（`.gitleaksignore` 之类）前先 `git ls-files <名字>` 查存在**——Write 类工具对已存在文件会静默整文件覆盖，本次把仓库既有的 33 行历史豁免全部覆盖删除、CI 反而多红一轮才发现。
  补充（2026-08-24，RFC-319 第四次踩同一坑）：知道这条规则**不等于不会犯**——本地 `gate:local` 不跑密钥扫描，所以写用例时没有任何反馈，要等 push 之后 CI 才红。凡是本次改动里出现了「长得像凭据」的字面量（假 token、密钥、带 `Key`/`Secret`/`Token` 的字段值），提交前自己扫一次，10 秒的事：

  ```sh
  tmp=$(mktemp -d) && curl -fsSL \
    https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_$(uname -s | tr 'A-Z' 'a-z')_arm64.tar.gz \
    | tar -xz -C "$tmp" gitleaks && "$tmp/gitleaks" detect --source . --no-banner --redact
  ```

  注意它扫的是**全部历史**：一旦推上去，改当前文件消不掉，只能按 fingerprint 钉进 `.gitleaksignore`（上面那套定式）。

- **`bun test --randomize` 会打乱同一 describe 内的 test 顺序——journey 式测试的先后步骤必须收在同一个 `test()` 里**（2026-08-18 RFC-310 实锤）：`describe` 里第一个 test launch mission、第二个 test 拿共享 `missionId` 断言下一步，本地裸跑绿、gate 的 shard（强制 `--isolate --randomize`）里第二个先跑 ⇒ `missionId` 是空串、稳定红。定式：跨步骤共享可变状态的用例合并成单个 test；describe 级共享只放**只读**fixture（beforeAll 建好、任何 test 不再推进它）。
- **后台跑门禁时别接 `| tail`（或任何管道）—— 管道的退出码会把门禁的红吞成绿**
  （2026-08-11 实测踩坑）：`bun run gate:local 2>&1 | tail -40` 放后台，收到的完成
  通知是 `exit code 0`，因为 shell 取的是**管道最后一个命令**（`tail`）的退出码，而
  `gate:local` 实际 `exited with code 1`。当时据此以为门禁绿了，差点带着红提交。
  定式：**要么不接管道**（`bun run gate:local > <log> 2>&1`，再单独 `echo "EXIT=$?"`
  写进日志尾），**要么显式 `set -o pipefail`**。判据：后台门禁报绿但你没亲眼看到
  「全绿」摘要行时，一律回日志里 grep `exited with code` / `lane(s) failed` 复核。
- **启动任务的后端测试若不显式给 `appHome`，会往用户真实的 `~/.agent-workflow` 里写**（RFC-287 三轮门实测，真实 home 里已攒下 13 个残留目录才被发现）。`deps.appHome` 缺省回落到 `Paths.root`，而它只认 `AGENT_WORKFLOW_HOME` —— **只有 `scripts/test-backend-sharded.ts` 设这个变量**。于是 `bun run gate:local` 是干净的，而 `bun test <file>` 和 `bun run test:backend:serial`（CLAUDE.md 明写的诊断入口）会真的去克隆、留下 `repos/<hash>-<name>.partial-<ulid>/` 与 `scratch/<ulid>/`，**且无人清理**。`tests/setup.ts` 的泄漏守卫盯的是 cwd，看不到 home。**定式**：凡是会走 `startTask` / `materializeSpace` / `resolveCachedRepo` 的用例，在文件顶层建一个 `mkdtempSync` 的 `TEST_HOME` 并显式传 `appHome`，`afterAll` 删掉。**判据**：写完新的启动类用例后，跑一次 `ls ~/.agent-workflow/repos | wc -l`，前后数字应当不变。
- **`expect(err.message).not.toMatch(/some-error-code/)` 是空断言 —— 错误码在 `.code`，`message` 里一个字都没有**（RFC-287 三轮门实测，两条这样的断言被证明**恒绿**）。本仓的 `DomainError` / `ValidationError` / `ConflictError` 都是 `(code, message, …)` 形态。把实现改成**无条件抛出该错误码**——正是那条测试标题声称要防的回归——用例照样全绿。同源的坑还有正面版：`toMatch(/code|某句英文散文/)` 实际只靠第二个分支命中，于是它锁的不是契约而是**文案**，改个措辞就误红。**定式**：`catch (err) { code = (err as { code?: string }).code ?? (err as Error).message }`，然后 `expect(code).toBe('…')`。
- **反向断言（`not.*`）在「前提不成立」时会静默退化成 no-op，比漏测更危险**（RFC-287 三轮门实测）。例：一条锁「身份登记不得堵在克隆锁后面」的用例，全部预言力都建立在「那个不可路由地址会一直挂到 3s 超时、锁还握着」上。换成一个**快速失败**的远端（ICMP 立刻拒绝 / 走代理 / 被沙箱掐断），克隆在 200ms 就结束——**即便缺陷还在**，耗时断言也只有 1~3ms，照样绿。CI 的网络环境恰恰最容易触发这一支。**定式**：给这类用例加一句**前提复核**断言（`expect(cloneSettled, '前提不成立：锁没被握住，本用例此刻零预言力').toBe(false)`），让前提破裂时红在前提上，而不是伪装成通过。
- **源码锁的正则窗口 `{0,N}` 量到「刚好够用」等于埋定时炸弹**（RFC-287 三轮门实测两条，其一距离正好 400/400）。实测：在被跨越的那段注释里**加一个空格**就红；另一条 547/600，补一行中文注释（≈45 字）即红。而这类锁要防的是「失败码被改名」「钩子没接上」，与两处相距多远毫无关系。**定式**：窗口给 2~3 倍余量，或改用更贴近语义的锚（`summary: 'x'[\s\S]{0,80}message:`）。**判据**：写完 `{0,N}` 后量一下真实距离，比值 >0.8 就放宽。

- **`bun test` 把模块加载期 ENOENT 计「error」不计「fail」**：本地全量出现「N errors」必须**逐个查**——常见根因是源码锁（source-lock 测试）读了已删/搬走的文件。别当噪音略过，CI 会红。
- **`vi.mock('@/components/...')` 路径跟组件搬家**：移动/重命名组件后必 grep 全仓 `vi.mock('@/components/<旧路径>`，否则测试静默失配。
- **cwd 敏感测试**：用相对路径 `readFileSync` 的 source-lock 在 `cwd=packages/backend` 跑会恒红、在仓根 cwd 恒绿（CI 在仓根）。写 source-lock 用 `import.meta`/绝对根，别用相对 cwd。
- **前端测试跑 `vitest` 不是 `bun test`**：根 `bun test` 只跑 backend（bunfig `root=packages/backend/tests`）。改前端/clarify 必须 `bun run --filter @agent-workflow/frontend test` + 相关 Playwright e2e——否则漏检（RFC-132 两层回归漏检事故）。
- **CI path filter 完备性 = 依赖闭包问题**，不是加几个 glob。且**触发 ≠ 真测**：若 live 套件自拼 argv 直接 spawn、绕过生产链（如 `buildBusinessSpawn`），即便触发也测不到 drift、全绿无意义。改 path filter 要沿依赖闭包核算，并确保有一条走生产链的 case。
- **Actions 的 `needs` 是关键路径依赖，不是日志排序工具；matrix job 还是一个整体依赖**：一个 job 若只读 checkout、不消费上游 artifact，就不该为了“界面从上往下好看”去 `needs` 全测试矩阵。2026-08-07 连续 6 次成功主 CI 实测：单测矩阵在 342–417s 已结束，`build-binary` 再串 153–196s、Playwright 再串 231–265s，总墙钟被拉到 746–880s；把独立构建放回 workflow root、只保留真实的 `e2e -> build-binary` artifact 边，按同批耗时关键路径降为约 397–458s，门禁集合逐字不减。但真实 artifact 边也要按消费粒度拆：三 OS 的 `build-binary` 放在同一个 matrix job 时，GitHub 只向下游暴露整个 job 的完成态，Ubuntu/Windows E2E 仍会等最慢或排队最久的 macOS build。run `32807941954` 实测 Windows build 在 04:13:38 已结束，macOS build 到 04:24:27 才结束，七条 E2E 全部到 04:24:29 才启动，而最终关键腿正是 Windows。定式是三个 OS 各一个 build job、各自只接同 OS E2E；公共 steps 用 YAML anchor 保持逐字同源，最后另设一个 `always()` + 逐结果 `success` 判定的稳定汇总 job，既消掉跨 OS barrier，又让分支保护只依赖一个不会随 matrix 展开/改名漂移的终态 context。拓扑要加源码守卫，防后续“为了排序”把瀑布接回来，或新增 job 时漏进汇总门。
- **E2E 分片数是按托管墙钟校准的容量 ratchet，不是永久常量**：分片少会把新增用例全堆回单腿，分片多又会让 macOS/Windows runner 排成波次；只看 YAML 里的 job 数猜不出来。2026-08-25 的两个连续终态 run `32813031397` / `32814714841` 已把 PR 档量到 **621–627 条**：Ubuntu 两片各 310–314 条，最慢 8.0m；Windows 三片各 192–221 条，最慢 8.6m。于是从 2/2/3 只加一档到 Ubuntu/macOS/Windows **3/3/4**（10 job，仍低于旧 4/4/4 的同步 12-job 波次），平台、用例、重试、trace 与失败语义一项不删。这里的安全判据不是“总数看起来差不多”，而是每个 OS 的 matrix 必须完整枚举 `1..M`、命令分母必须同为 `M`，并由源码守卫同时钉死；性能判据则只能看包含该拓扑的 GitHub 终态 run 的 DAG 墙钟，不能拿单腿 CPU 时间冒充整条 CI 变快。
- **`BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`**：跑「验证子进程零写入」的只读测试要关 Bun 自身转译缓存，否则误报写入。
- **`bun audit` 的 flag 是显示层过滤器，不是门禁**（bun 1.3.13）：`--audit-level` / `--ignore` 按 `--help` 原文只影响**打印**；退出码只反映「bun 有没有成功解析出公告」。更糟的是 registry 回 gzip 时 **bun 自己解不开**——把压缩响应体原样倒进 stdout（日志里那堆乱码就是它）、stderr 写 `audit request failed to parse json`、exit 1，而且那段 gzip **尾部截断**（严格 `gunzipSync` 报 `unexpected end of file`，得用 `Z_SYNC_FLUSH` 兜）。后果：CI 的 audit gate 时红时绿取决于 CDN 给不给 gzip，加多少 `--ignore` 都修不好，绿的时候也没在把关。修法是自己解压 + 自己判定（`scripts/audit-gate.ts`），**别再往那条命令上加 flag**。
- **静态分析工具拿错 tsconfig 会「静默失明」而不是报错——绿灯不等于干净**：dependency-cruiser 的 `options.tsConfig.fileName` 原本指向 `tsconfig.base.json`，而 base 里 `paths` 出现 **0 次**（`@/*` 只定义在各 package 自己的 tsconfig）。于是每条 `@/...` import 都 `couldNotResolve` 被**从图里丢掉**，`bun run depcheck` 两年报 0 违规——实测后端 **3365 / 5384 = 62.5%** 的依赖边门禁根本没看见，换对 tsconfig 后立刻暴露 19 条真实违规（18 个 runtime 环 + 1 条 services→routes）。最毒的是绕环最常用的写法 `await import('@/services/…')` 100% 落在这个盲区里，于是「工具 + 约定双保险」实际退化成纯人肉约定。**通用判据：任何吃 tsconfig 的分析器（depcruise / madge / knip / ts-morph 脚本），上线时必须断言"未解析的第一方边 = 0"，并把这条断言做成棘轮**——只统计违规数不统计「我看见了多少」，等于让工具用沉默替你签字。顺带三个实测坑：①`enhancedResolveOptions.alias` 不被 depcruise 的 schema 接受（`must NOT have additional properties`），②它解析 tsconfig 的 `extends` 基准目录不对（传 `packages/backend/tsconfig.json` 会去找 `packages/backend/tsconfig.base.json` 报 TS5083），③临时 tsconfig 放到包目录外必须写**绝对** `include`，否则 tsc 报 TS18003。正解见 `scripts/depcheck.ts`（每 package 各跑一次 + 生成扁平化绝对 baseUrl 的 tsconfig + 配置侧 fail-closed）。2026-08-03 架构审视 A1 / WP-0。
- **排除一条失败前先问「它后面那条会不会顶上来」**：同一个 spec 文件里的用例是**串行**跑的，首条失败之后其余往往报「did not run」——于是一个文件里三条同源的失败，看起来只有一条。把第一条排掉，第二条立刻变成新的失败，**那不是修，是把问题往后挪一格**（RFC-254 T31 实测：排掉 `rfc250-workflow-camera:823` 后 `:831` 当场变红，而且在 POSIX 上同样如此，所以它压根不是平台问题）。判据：排除前先带着排除在**本机**跑一遍那个文件，看剩下的是不是真的绿。顺带，同一批排除里不同条目**可以是不同形状**——一条坏六条好的按标题排、三条同源的按文件排——但每条都要说明为什么，并让棘轮核对它**实际移除了几条**。
- **Playwright 的 `--grep` / `--grep-invert` 同时匹配文件路径和标题**：所以一个看着像文件名的片段会排掉整个文件。实测差别很大——按文件名排那两个 spec 会移除 10 条而不是 2 条，其中 8 条本来是过的。想排一条就写标题，想排整文件就写文件名，别靠猜。

- **允许列表按「文件」排除 vs 按「违规」排除**：上面那条顺带修掉的老写法是 `from.pathNot: ['^…/services/(agent|agentDeps)\\.ts$']`——排除的是**文件**，等于连带放过未来经过该文件的**每一个新环**，而新环恰恰最爱从 `scheduler.ts` / `task.ts` 这种枢纽长出来。换成按 `(规则, 起点, 终点)` 三元组精确匹配后，允许列表还能加一条真棘轮：**条目不再触发就让门禁红**（环拆掉了却留着条目 = 重新开口子）。同一形态适用于任何「已知问题清单」型门禁（`scripts/audit-gate.ts` 的 `IGNORED_ADVISORIES` 已有 `staleIgnores`，可对照）。
- **外链检查红了先分清「链接坏了」还是「网络断了」**：lychee 的 `--accept 200,206,403,429` 只能吸收**有 HTTP 状态码**的噪音；`Network error: Connection reset by peer (os error 104)` 压根没有状态码，任何 `--accept` 都盖不住它。判据是本地 `curl -s -o /dev/null -w '%{http_code}'` 连打三次——全 200 就是 CI 侧瞬时网络，属环境。**处置不是重跑**（CLAUDE.md 禁止「重跑就过」当依据），而是给检查器加 `--max-retries` / `--retry-wait-time` / `--timeout`。2026-08-02 `w3c.github.io` 就这样弄红过一个只改了两个 i18n 文件的 main run。
- **用错 runner 的表现是「挂死」不是报错**：`cd packages/frontend && bun test`（上一条说的那个错法）不会干脆失败，而是刷 `ReferenceError: document is not defined` 后长时间不退——正确的 `bun run --filter @agent-workflow/frontend test` 全量只要 ~60s。**跑套件卡住先怀疑 runner 用错，别当 flaky**（RFC-230 session 因此空等 2h37m）。
- **`长任务 | tail -N` 会让你全程失明**：tail 要等 EOF 才吐字节，后台跑的全量测试在结束前输出文件恒为 0 字节，「没输出」看起来和「还在跑」一模一样。长任务全量落盘再取尾（`> log 2>&1` 后 `tail`）。判断进程死活看 **`ps -o etime=`**，不看输出有没有内容。
- **给「遍历全部源码」型守卫显式的墙钟预算**：这类测试（AST 全树扫描、依赖图、指纹多重集）的成本随仓库增长，而 bun 的默认 5s 是个与它无关的数字。空闲机器 1.6s 看着很安全，四分片并行的共享 runner 上就会超时——报出来是 `timed out after 5000ms`，**不带任何断言信息**，读起来像挂了而不是像慢了。写显式预算并注明「这是墙钟允许量，不是对扫描器变慢的容忍」。
- **断言只打印「违规的名字」= 失败时什么都没说，而且会把人引向错误的子系统**。`expect(blocking.map((v) => v.id)).toEqual([])` 读起来很干净，红的时候只给你 `+ Array [ "color-contrast" ]`：哪个元素、什么前景/背景色、实测多少、要求多少，一个都没有。RFC-254 里这条造成的代价是：**四次 CI 红 + 两版 backlog 记录 + 一个「Windows 渲染差异」的假设**，而真相是一条谁都能复现的 WCAG AA 违规（白字压 `#16a34a` = 3.29:1，要 4.5:1）——把节点与颜色打出来之后**本机第一次跑就红了**。判据：**任何「断言某个集合为空」的守卫，失败消息必须带够定位信息**（元素 / 数值 / 来源），否则它只能告诉你「有问题」，不能告诉你「是什么问题」，而人会拿观察到的巧合（只在某条腿红、时红时绿）去补那个空白，补出来的多半是错的。本仓的 axe 侧已收进 `e2e/axe-blocking.ts` 的 `describeBlocking()`。
- **Windows 的 Bun 上，事件循环空了之后 unref 掉的定时器永远不触发**——两张脸都会咬人：①`Promise.race` 里 unref 的 deadline（`new Promise(r => { t = setTimeout(() => r(false), ms); t.unref() })`）在被 race 的 promise 永不 settle 时，整个 await 冻死，`bun test` 表现为**整个 runner 卡住不换文件**（RFC-254 期间「后端全量卡死在 181/1033」悬案即此，15 行探针可复现，macOS 同用例 22ms 过）；②`AbortSignal.timeout` 内部同为 unref 语义且不给句柄，只 await 它的 abort 一样冻死。**规则：await 依赖的 deadline / sleep 不许 unref，settle 路径上 clear**；fetch 超时用 `util/timeoutSignal.ts`（ref + 显式 cancel），不用 `AbortSignal.timeout`。守卫 `rfc254-no-unref-deadline-guard.test.ts` 双禁两种形态。注意区分：**周期性 GC/interval 的 unref 是对的**（不该把 daemon 钉着不退）、`child.unref` 是另一类（不让僵尸钉住进程）——判据是「有没有 await 依赖它触发」。
- **bun 报表里的每条耗时**含* beforeEach/afterEach*，**而默认 5s 超时只管 test body**——所以别拿报表数字给「哪些测试贴着上限」排序。直接探针实测：3s `beforeEach` + 3s body，报表打印 **6.02s，测试照样 pass**。真实后果两个方向都有：把重活放 `beforeEach` 的文件报表数字很大而风险低（`git-repo-cache` / `clarify-inline-isolated-parity` 在 CPU 打满的 Windows 上报表 5.5–6.0s，两轮都没红）；反过来在 body 里做真 I/O 的文件报表值≈body 值，4947ms 那条就是真的会红（`rfc130-node-isolation`，同负载 3 条超时）。**判据是「body 里做了多少真 I/O」，报表数字只配当粗筛。**
- **上一条的严重版：超时的测试如果「持有一块工作区」，它会把还在跑的东西一起带走，而报错点名的是错的子系统**。bun 判超时后会**回收该测试的子进程**，于是 RFC-254 T32 里出现这条链：在飞的 `git rev-list` 收 SIGTERM（`exited 143`）→ `seedWorktree` 认为基线解析失败并抛错 → `createFusion` 的 `finally` 删掉它仍持有的 fusion work dir → 而**该测试此前已经启动的任务还在被调度**，于是 iso 从一个已被删除的目录上建，报出 `git worktree add (iso): fatal: cannot change to '…'` / `workspace-missing: canonical worktree does not exist` / `TypeError: … 'task.worktreePath'`。**这四行点名的全是 git，真正的主语却是「这个测试文件没声明预算」**——它一度被立成一条「Windows 上 git worktree 坏了」的 P1。**判据**：看到 git 报「路径不存在 / 对象解析不了」，先查同一批日志里有没有 `exited 143` 或 `this test timed out`；有就先修预算再谈缺陷。**预防**：凡是「真的起任务 / 真的建仓 / 真的拉子进程」的用例，文件顶上写 `setDefaultTimeout(60_000)`（先例：`task-start-pre-worktree` / `clarify-review-combination-scenarios` / `fusion-engine`），别让它贴着默认 5s 跑——安静机器上 1.5–3.4s 看着安全，那已经是预算的 30–70%。**又一例（2026-08-25）**：`rfc321-cached-repo-refresh-credential`（Codex 提交时没写预算）body 里 init / commit / bare clone / 经 smart-HTTP 冷 clone / 再 fetch，**绿的时候** Ubuntu 3.4s、macOS 4.0–4.6s，macOS 分片 3 以 5019ms 翻红，随后 `killed 1 dangling process` + afterEach 删夹具 + 被判超时的 body 跑到 `expect` 抛成「Unhandled error between tests」——三行都点名 git。接手 Codex 提交的「真跑 git」测试文件时先看顶上有没有预算。
- **结构守卫必做变异实证**：加 grep/AST 守卫后，改坏源码断言必须看它变红；否则守卫是空的。表级锁（一次锁一类）优于文件级——注释里的字面量也会踩表级锁（RFC-072 事故）。
- **变异实证的还原步骤要用绝对路径，并且**逐字 diff 核对**——`cd ..` 很容易落错目录**（RFC-287 三轮门实撞，三条变异的还原全部静默失败）。写成 `cd packages/backend && bun test … ; cd .. && cp /tmp/x.bak packages/backend/src/…` 时，`cd ..` 从 `packages/backend` 回到的是 **`packages/`** 而不是仓根，于是 `cp` 报 `No such file or directory` ——而这行 `cp` 的失败混在一大段输出里毫不显眼，**变异就留在了生产代码里**。更糟的是下一条变异接着施加，等于叠加。**定式**：备份与还原一律写绝对路径（`R=$(git rev-parse --show-toplevel)` 开头取一次）；还原后不要只 `grep -c` 关键字（改动可能不止一处），直接 `diff <(cat /tmp/x.bak) <file>` 求逐字一致再继续。判据：还原那步的输出里必须有一句明确的「一致」，没有就当没还原。
- **变异实证跑在编译产物上时，还原源码之后必须重新构建**（RFC-319 实撞，2026-08-24）：e2e 的 daemon 是 `bun run build:binary:e2e` 出来的**二进制**，Playwright 不看源码。施加变异 → 构建 → 跑红 → `cp` 还原源码 → **直接再跑**，跑的仍是含变异的那个二进制。症状极具迷惑性：`git diff` 干净、`grep MUTATION` 为 0，用例却红在一条你刚写对的断言上，很容易反过来怀疑判据、甚至去「修」一段本来正确的生产代码。本次是给 `localStorage.removeItem` 打桩抓调用栈，看到清 token 发生在 WS close 处理器里，才认出那是上一轮的变异还在二进制里。**定式**：还原与重新构建写成同一条命令（`cp /tmp/x.bak <file> && bun run build:binary:e2e && bunx playwright test …`），别让「还原」和「重跑」之间存在一个可以忘掉构建的缝。前端改动同理——它也被打包进同一个二进制。
- **做变异实证时别用 `git checkout` 还原「未跟踪文件」**：新写的文件还没进版本库，`git checkout <file>` 报 `did not match any file`——配上顺手加的 `|| true` 就**静默什么也没做**，于是下一轮「restored」跑出来的其实是**带着变异**的结果，你会照着它报一个假的通过。还原用 `cp` 备份（变异前先 `cp x /tmp/x.bak`），并让最后那次「restored」跑出的数字与基线**逐个数字核对**——对不上就是没还原干净。
- **「写了规则 + 单测绿」≠「接上了」**：脱敏/校验这类横切规则，单测测的是**函数**，接线是另一件事。RFC-247 里 `redactMcpRecord` 与 `redactStdout` **各自**都是「定义了、单测了、零调用方」——`GET /api/mcps/:id` 一直原样吐 `config.env`/`oauth.clientSecret`。单测不会红，因为它没在测出口。**收尾必须从 AC/需求反查「谁调它」**（`grep -rn '<fn>' src | grep -v '<定义文件>'`，命中为空即未接线），或把出口写成唯一入口（`serializeXForActor(record, source)`）让调用方无从绕过。
  **成规模地查它**（RFC-304 实测，一次扫出 61 处生产不可达、6 个整文件零导入）：对目标目录每个
  `export function` 走三步——①除定义文件外全仓零引用 ⇒ 候选；②**本文件内**也无人调用（被同文件
  入口调用的只是「为测试而 export」，行为仍可达）；③两条都为零 ⇒ 生产不可达。只做第 ① 步会把
  大批纯函数误报成缺陷，第 ② 步是必须的。判据反过来也成立：写新模块时**接线与实现同一个
  commit**，或至少有一条用例从**入口**（路由 / 调度器 / 启动流程）打进去。
- **上一条的镜像：迁移「只删调用方、不删实现」，残骸会被它自己的测试续命**。RFC-247 T4 把权限门迁到 `registerRoute` 后删的是 `server.ts` 里的**挂载**，`auth/permissions.ts` 那 202 行实现原封留下；此后全仓零生产引用，唯一 import 是 `rfc247-verb-for-route.test.ts` 那条逐行测试——覆盖率报表上它一直是绿的、看起来还像一条权限不变量锁。代价是它**在教育后来人**：文件头断言「server.ts 的手挂网关 still runs alongside 迁移后的路由」（同一时刻 server.ts 明写 GONE），而 `verbForRoute` 悄悄成了「路由 → 权限点」的第二份、无人执行、无人比对的事实源（与真实声明分歧 7 条）。**判据**：迁移收尾时对被替换的模块跑 `rg -n "<导出名>" packages e2e scripts | grep -v "<自身文件>"`，若命中**只剩测试文件**，那不是「还有人用」，是死码 + 假合格证，删。删完补一条「不复辟」ratchet（`tests/route-gate-single-source.test.ts` 是范本）并做变异实证。2026-08-03 架构审视 G0。
- **改符号前先 grep 测试源码锁**：改函数/常量名前全量盘「锁住旧接线的测试」，定向重跑集 = grep 命中集；否则本地绿、CI 红（他人 source-lock 锁了旧名，2026-07-08 三连事故）。
- **`e2e/` 在 workspace typecheck 之外**：删/改 wire 字段能过所有本地门却红 Playwright CI；推前 grep `e2e/` 找该字段（inline response 类型 + 断言都要改）。
- **CI 根 `bun test` 只跑 backend**（bunfig `root=packages/backend/tests`）；shared 测试单独跑且含一个**已知陈旧** `memory-schema` 红（RFC-101 `fused`，在 CI 之外）——忽略它，别「修」他人代码。
- **本机 `protocol.file.allow=always` 掩盖 submodule CI 红**：`file://` submodule 测试本机恒绿、CI 恒红；测试须自注入 `GIT_CONFIG_GLOBAL`，复现用 `GIT_CONFIG_GLOBAL=/dev/null bun test <单文件>`。
- **`sqlite3` CLI 默认 `busy_timeout=0`，直写运行中 daemon 的 DB 必炸**：e2e 用 `sqlite3` 往活着的 daemon 的 `db.sqlite` 里种状态（`e2e/command.ts:runSqlite`，diagnose-repair / lifecycle-diagnose / rfc229 / business-workgroup 都在用）。daemon 侧有 `PRAGMA busy_timeout = 5000`（`db/client.ts`）会等写锁，**CLI 侧不等**——只要 daemon 那一刻在写，fixture 立刻 `Error: stepping, database is locked (5)`，表现为「随机某个 shard 红、重试还红」（nightly e2e-webkit run 30440683412：`diagnose-repair` 的 `afterEach` 清理撞上刚点下去的 repair 写）。**测试进程直连生产 DB 文件一律显式设 busy_timeout**，且要小于命令自身的超时，否则 wedge 时拿到的是 SIGTERM 而不是 SQLite 诊断。注意 WAL 不救这一类：WAL 只解耦读写，写-写仍然互斥。
- **`bun run e2e` 把 spec 跑在 NODE 上，不是 Bun**：Playwright 用它自己的 Node runner 加载 spec **及其全部 import**，所以 `e2e/*.ts` 里出现 `import … from 'bun:sqlite'`（或任何 `Bun.` 全局）不是「某条断言红」，是**加载期整套死**——`Error: Only URLs with a scheme in: file, data, and node are supported by the default ESM loader. Received protocol 'bun:'`，随后 Playwright 打印 **`No tests found`**，读起来像过滤器写错了而不是坏了。RFC-254 T29 就这样让四个 e2e shard 连红四个提交，因为 `bun run test` 到 `git push` 之间没有任何一环会看 e2e 还能不能加载。**要用 Bun 独有能力就放进子进程**（`e2e/fixtures/sqlite-exec.ts` ← `e2e/command.ts` 拉起，SQL 走 stdin），并加一条源码守卫（`rfc254-e2e-node-runtime-guard.test.ts`）。**通用判据**：改了 `e2e/` 下任何被 spec import 的文件，推之前至少跑一条 spec，别只跑 `bun run test`。
- **`writefile()` 不是 SQLite 的函数，是 `sqlite3` CLI 的 fileio 扩展**：把 fixture 的 SQL 从 CLI 换成任何**库**（bun:sqlite / better-sqlite3 / node:sqlite）都会丢掉它，报 `no such function: writefile`。这类「把查询结果写进文件再读回来」的绕行，本身是因为老 helper 只能执行不能查询；换引擎时正解是**补上查询能力**（参数绑定，别拼字符串），把绕行整段删掉，而不是找替代的 writefile。
- **删掉一份「参照实现」之前，先把它的行为录成 golden**：差分测试（新旧同时跑、逐字节比对）只在旧实现还在时才成立，删了旧实现就等于把证明一起删了。做法是先把旧实现在全部用例上的**可观测行为**（stdout / stderr / exit / 状态文件 / 日志 / 副作用）录进仓库，再删旧实现，测试改为回放录音。三条配套断言缺一不可：重录必须跑**旧实现**（所以只在还有旧实现的 checkout 里能重录，不是给回归开绿灯的口子）、缺 golden 直接报错、以及「每个实现都有 golden、每个 golden 都有实现」的双向核对。副作用往往是意外之喜：录音在旧实现跑不起来的平台上照样回放（RFC-254 里 shell stub 在 Windows 上不能执行，但它的录音能）。
- **源码里裸 `0x00` 让 grep/rg 静默跳过整文件**（却过 tsc/prettier/eslint/build/tests）；`file` / `tr -cd '\000'` 检测，改回 `\x00`；守卫 `no-nul-bytes-in-source`（注释里的字面量也会踩）。
  **最常见的引入方式是「拿 NUL 当分隔符」**：`return `${a}\0${b}``拼 Map key 看着很合理（NUL 不会出现在业务字符串里），但它把裸 0x00 写进了源码。正解是`JSON.stringify([a, b])` —— 既没有分隔符问题，也不碰 NUL。**另注意检测姿势**：`grep -q $'\000' file`在 zsh 下退化成空模式、对每个文件都返回真，别拿它当判据；用`tr -cd '\000' < file | wc -c`。
**它为什么总能活到门禁那一步**（2026-08-15 RFC-304 再犯一次，写进本条之后仍然踩）：NUL 当分隔符**功能上完全正确**——键唯一、去重照常、单测全绿；typecheck / lint / prettier 也都不管。把文件 Read 回来同样看不见（渲染成空）。于是从写下到 `no-nul-bytes-in-source`报红之间，**没有任何一个信号是红的**。推论是别指望「自查时会发现」，而是**根本不要写分隔符**：拼键一律`JSON.stringify([...])`。顺带一提这也是唯一能防住「标题里正好含分隔符」的写法——`file="a", title="b"`与`file="a<sep>b", title=""` 在 join 下同键，一条真 finding 会被当成另一条的重复丢掉。

- **「只被 `import type` 引用」的模块在 `bun test` 面前是隐形的**：类型导入在运行期被整段抹掉，所以这类模块**丢了 / 拷漏了 / 改名了，测试照样全绿**——300 个文件、上万条断言，一条都不会红。只有 typecheck 与 depcheck 看得见（后者报「第一方 import 解析不了」）。2026-08-15 实际发生：往隔离工作树拷文件时 `cp -R src/ports/ dest/` 把**目录内容**摊进了上层（macOS 上 `cp -R foo/ bar/` 拷的是 foo 的内容），`ports/` 成了空目录，四个 shard 依然 `0 fail`，是 typecheck 22 条 TS2307 + depcheck 才把它揪出来。两条推论：①**别拿 `bun test` 绿当「文件都到位了」的判据**，隔离树跑门禁必须跑完整门禁（typecheck/depcheck 那两步正是为这种失明存在的）；②往隔离树拷贝时**逐文件拷、不要拷目录**（`git status --porcelain` 列出的目录项要先展开成文件），否则一个静默的路径偏移能让整轮门禁结论失真。

- **「有实现、有测试、没有调用方」是分层架构下最容易累积、且任何测试都照不到的债**（2026-08-15 RFC-304 一次扫出 8 处）：先把 domain/infrastructure 写完测完、再在后续 PR 接线，是很自然的节奏；一旦接线那步漏了，**两半各自都对、测试全绿、功能不存在**。它和「写错了」完全不同——错的代码会红，缺席的接线不会红。RFC-304 里连栽三次（`wantsCapability`、唤醒服务，以及扫描发现的工作项存储 / 钩子执行 / AI 尝试记录 / MR lease / 发布意图 / 批量发布 / 台账对账 / readiness 失效共 8 个模块，全部 src 消费者为 0、测试俱全）。**定式**：每个 PR 收尾扫一次零消费者，别留给下一个 PR 撞见——

  ```bash
  cd packages/backend/src/modules/<ctx>
  for f in */*.ts; do n=$(basename "$f" .ts)
    echo "$(rg -l "from '@/modules/<ctx>/$(dirname $f)/$n'" ../../ | wc -l) $f"
  done | sort -n | head
  ```

  结果为 `0` 的，要么**本 PR 就该接而漏了**，要么必须在 plan 里写明**由哪个 PR 接**；两者都强过让下一个人发现。反过来这也是 code review 的好问题：新加的 domain 模块，谁调用它？

- **`git stash push -- <paths>` 在「没东西可存」时也返回 0，于是 `&& STASHED=1` 会骗你去 pop 别人的 stash**（2026-08-15 真实事故）：共享 checkout 上推送前常写成「先把他人未提改动 stash 起来 → pull --rebase → push → stash pop 还回去」。坑在于 `git stash push -u -m msg -- <paths>` 当所列路径全都干净时只打印 `No local changes to save` 并 **exit 0**——`git stash push ... && STASHED=1` 因此把标志置上了，后面的 `git stash pop` 就去弹了栈顶那个**本来就存在的、别人的** stash。那个 stash 基于很旧的 commit，套到今天的 HEAD 上直接炸出 12 个 `UU` 冲突文件。**判据**：绝不用退出码推断「我建了 stash」，要么 pop 前后比对 `git stash list` 的**条数**，要么用 `REF=$(git stash create)` 拿到确切的 stash ref 再 `git stash apply "$REF"`（`create` 不进栈，天然不会误伤别人的）。**恢复姿势**（本次实测无损）：先把冲突文件与 `git stash show -p stash@{0}` 快照到 scratchpad，再 `git checkout HEAD -- <每个冲突文件>`——冲突文件在 pop 之前必定是干净的（git 遇到脏文件是**拒绝** pop 而不是产生冲突），所以回 HEAD 不会丢别人任何未提交改动；别人的 stash 因为 pop 失败而**原样保留**在栈上。

- **仓内有一批测试「静息就贴着 5000ms」，分片并行下必然间歇翻红**（2026-08-15 实测三例）：bun 默认单测超时 5000ms，而下列测试**在空载机器上单跑**就已逼近它——`rfc131-review-reject-aging-prior-output` 2.6–3.1s、`rfc305-architecture-lock` 的 roles 那条 3.97s、`listWorktreeDir > truncates beyond WORKTREE_DIR_MAX_ENTRIES` ~5.7s（I/O 重）；2026-08-16 又添一例 `scheduler-audit-gap4-loop-exit-out-of-scope-port` 的 snapshot 那条——**空载 1.53s、四分片下 5232ms**（3.4× 竞争膨胀），说明「静息离 5s 还很远」也不安全，判据得看**负载下**的倍率而非空载绝对值；已按本条给它写死 15s。`gate:local` 跑 4 个并行分片，于是它们在**任何**有别的活儿的机器上都会随机超时。**判据**：看到 `(fail)` 先去日志里找 `^ this test timed out after 5000ms`——有这行就是超时不是断言，跟着单跑一次确认；**别**把它当成自己改动的回归去查。**根治**属各自 owner：给这些测试显式 timeout（`test(name, fn, 15_000)`）而不是靠机器够快。

- **别在自己的门禁跑着的时候继续跑重活——你会把自己的门禁跑挂**（2026-08-15 实测两次）：隔离门禁开 4 个并行分片、单片上限 900s，本来就吃满机器；此时再在主树上跑 `bun test` 全量 / `bun run typecheck` / 全仓 `eslint`，分片直接撞 900s 墙被杀，日志里**一条 `(fail)` 都没有**、只有 `1/4 shard(s) failed after 902.0s`，看起来像神秘失败。判据同前：先看有没有 `timed out after` / `FAIL timeout`，再看 `(fail)` 计数是否为 0——两者同时成立就是被饿死的，不是代码问题。**定式**：门禁一旦启动，等待期间只做**不吃 CPU** 的事（读代码、写文件、改文档），把跑测试/typecheck/lint 攒到门禁结束之后。想边等边验证就再开一棵隔离树，别在同一台机器上抢。

- **隔离工作树的「基线」本身可能是红的，先量它再读自己的门禁**：共享 main 上跑隔离门禁的标准姿势是 `git worktree` pin 到某个 commit + 拷自己的文件，好处是红了能归因到自己。但 pin 的那个 commit **是别人刚推的**，它自己可能就带着红——2026-08-15 实测：pin 到 `c6cc4854` 时该 commit 已有两条 RFC-294 public-surface ratchet 红（`modules/identity-access/...`，另一个 session 的），于是我的门禁必然也报这两条，而它们和我的改动毫无关系。**判据**：读自己门禁结果前，先确定 pin 的基线红有哪些——最省的办法不是再跑一遍空白门禁（8 分钟），而是**在主树上单跑那几个守卫测试**拿到确切的失败断言与断言里指名的路径，然后看自己门禁的失败集合是否**恰好等于**它。多出来的才是自己的。反过来，如果图省事直接把「门禁红了」当成自己的问题去改，就会去动别人正在改的文件。

- **并发红噪音要按「路径」过滤，不能按「关键词」过滤**：共享 main 上别人的门禁红是常态，于是很自然会写成 `bun run typecheck | grep -viE "i18n|rfc257|webhook"` 把它们滤掉再看自己的。这个过滤器是按**别人的关键词**写的，不是按**「不是我改的文件」**写的——只要自己新写的文件名恰好不含那些词，自己的错误就一起被滤没了（2026-08-04 实际发生：我因此把一条 TS2769 推上了 main）。正确姿势是先 `git diff --name-only`（含未提交与本轮已提交的路径）拿到自己的路径集，再按路径判归属；宁可多看几行别人的红，也不要用关键词把自己的红一起吞掉。

- **后台跑门禁：task「completed (exit code 0)」≠ 门禁绿**（2026-08-12 实撞）：`bun run gate:local > log 2>&1; echo "exit: $?"` 的尾随 echo 让后台命令**恒以 0 收尾**，完成通知因此永远是 exit 0——判绿唯一依据是日志里的 `[gate] all local gates passed` 行（或逐车道 summary + `(fail)` 计数为 0）。且 **push 必须是读完门禁结果之后的独立命令**：把 `git push` 预链在 `fetch && merge-base && push` 里与门禁 grep 并排发出，grep 打不出预期行时 push 照样执行（实测一个批次就这样在未完成核对时上了 main，幸系满载假红、CI 洁净房复核绿）。定式：后台门禁命令**不接尾随 echo**（让真实 exit 传导给 task 状态），push 单独一条、在人工读过日志 summary 之后。
- **门禁窗口内，本 session 自己也不要在主树跑重测试**（2026-08-12 实撞）：pinned worktree 门禁跑到一半，本 session 在主树并发跑了 69 文件的家族扫——backend 两个分片 900s 撞墙 SIGKILL、14 文件 5000ms 家族假红。既有条目讲的是「别的 session 写文件污染门禁」，这条的教训是**满载饥饿不分敌我**：门禁在跑时本 session 只做轻 I/O（读码/写文档/起草），重测试排队等门禁收尾；多 session 各自跑门禁请用 SendMessage 约时间片串行（2026-08-12 起三 session 实践有效）。
  **「轻 I/O」不包括只读子代理**（2026-08-13 复撞）：两个只读评审 agent（全仓 rg + 大量 Read，不跑任何测试）与门禁并行，就把 backend shard-3 的 `scheduler-default-retries` 顶穿 5000ms——报头是 `timed out after 5000ms`，紧随一条 `ENOENT: argv.log` 的**级联假红**（mock runtime 还没来得及写文件），看起来像真 bug。判据仍是隔离复跑（该文件单跑 6.3s 全绿）+ 失败形态是超时而非断言。定式：**门禁窗口内子代理数 = 0**，评审/测绘代理与门禁二选一排队。
  **⚠️ 归因订正（同日晚，实测推翻上面这条的完整性）**：同一批用例在**完全干净**的
  窗口里仍然红。追下去真因是**用例自身的墙钟就是擦边的**——`scheduler-default-retries`
  每条 scenario 要**串行 spawn N 个真实子进程**（N = 1 + retries），bun 默认 5s 对
  N≥4 本就不够；`scheduler-clarify-dispatch` 的 clarify-no-channel 例同理（实测
  5335ms）。**并发只是把它推过线，不是根因。** 更阴的是**级联**：同一个 describe
  共享 harness 与 argv 日志，第一条超时后的残留写入会把后一条的断言带偏（期望
  failed 收到 done），于是一个根因表现成两三条看似无关的红。
  ⇒ **「隔离复跑绿」不等于「环境噪音」**：还要看失败形态是不是超时、以及同文件里
  有没有更早的超时把状态搅了。正解是按上面「显式墙钟预算」那条给这类**要真跑子
  进程**的用例写预算，而不是指望等窗口干净。

- **`bun test` 全绿 ≠ 类型对**（2026-08-16 实撞）。给共享测试 harness 的构造函数加了个字段却忘了加进它的 `interface`，33 条用例全绿、`tsc` 红。bun 跑测试时不做类型检查，所以**测试绿只证明运行时行为，证明不了类型面**——这正是门禁把 typecheck 单列一条车道而不是让它跟着测试走的原因。改完 harness / fixture 的**形状**（不只是值）时，跑一次 `bunx tsc --noEmit` 再说。

- **给共享 harness 加东西，别让不需要它的用例陪着付钱**（同日，自伤后自修）。我给一张 8 类资源的 ACL 矩阵加了第五个用户，只有其中 1 类用得上，但它建在 `beforeEach` 里——`createUser` 会**故意慢速**哈希密码，于是另外 7 类 × 33 条用例全在为一条用例付这笔钱。高负载下随即出现一次与本改动无关的用例超时红。**没拿「重跑九次都绿」当通过依据**（含三次 `--isolate --randomize`）：能消掉的时序面就消掉。**定式**：往共享 fixture 里加**慢**操作（密码哈希、子进程、文件系统、网络桩）时按需构造，别无条件建。

## 慢查询日志会把「进程被冻住」栽赃给一条无辜 SQL（RFC-322 实测，2026-08-24）

生产报「每隔一段时间全站冻结约 30 秒、随后自行恢复」，现场证据是：

```
[db-slow] 32648ms: select "id", "workspace_pruning_at" from "tasks" where (…)
```

**别顺着「慢查询」查下去先。** 那条 SQL 同库实测 **10ms**、走索引 `idx_tasks_status_workgroup`、
`tasks` 表只有 346 行 / 3MB；外部进程以 1Hz 打同一条 SQL 连测 14 分钟，零次超过 300ms。

原因是 daemon 只有一条 bun:sqlite **同步**连接，`instrumentSlowStatements` 量的是**语句墙钟**。
进程被饿死 / 阻塞在 IO 时，整段停顿会被算到当时正好在执行的那条语句头上——它只是恰好在
计时窗口里，不是它慢。

**判别办法**（RFC-322 起 `[db-slow]` 自带）：看 cpu 字段。

- `[db-slow] 120ms (cpu 118ms)` ⇒ 语句真的在算，去查计划 / 索引 / 数据量；
- `[db-slow] 32648ms (cpu 12ms)` ⇒ 进程在等，**与这条 SQL 无关**，去查谁占住了事件循环。

排查顺序（本次实际用到的，从便宜到贵）：

1. 拿那条 SQL 直接打真库量一次 + `explain query plan`；再 `select count(*)` 看表规模。
   十行以内就能证伪「查询慢」这个前提。
2. 起一个外部进程按同频打同一条 SQL。外部快、daemon 慢 ⇒ 是进程级停顿，不是 DB/磁盘。
3. 再去找谁占住了事件循环：同刻引爆的维护任务（见 `services/daemonCadence.ts` 的
   `MAINTENANCE_PHASE`）、同步 `Bun.spawnSync` fork 风暴（`util/process.ts`）、
   主线程上的 `VACUUM` / `wal_checkpoint(TRUNCATE)`。

顺带一条**架构规律**：周期性循环只登记「多久跑一次」而不登记「什么时候跑」，等价于把它们
全约在同一秒。本仓曾有 14 个 hourly 维护循环在 boot 的同一秒内装配、零抖动，一小时后首尾
相接地执行。新增周期循环时一并想清相位，别只填周期。

**推论（同一 RFC 实测踩到，2026-08-25）：墙钟类断言要按 CI 的噪声下限设计，本机安静时的
余量不是余量。** 上面那个 cpu 判据本身要写测试，做法是用 `Atomics.wait` 造一段「睡而不烧
CPU」的停顿，断言 `cpuMs < ms/4`。本机实测 60ms 停顿只记到 **0.03ms** CPU，看着稳如老狗；
推上去 CI（ubuntu runner）直接红：**`cpuMs=22` vs 阈值 15**。

原因是 `process.cpuUsage()` 统计的是**整个进程所有线程**的 CPU——bun 自带二十来个线程，
JIT / GC / 首次 `getrusage` 的固定成本全会落进那 60ms 的测量窗口。本机安静、CI 繁忙，同一
段代码的噪声能差三个数量级。

处置的方向是**把信噪比做够，而不是把判据调松到没意义**：①先做一次不记账的预热调用，把
固定成本挪出测量窗口；②窗口从 60ms 放到 300ms，让残余噪声摊薄；③判据放到 `ms/2` 并**补
一条绝对差**（`ms - cpuMs > 100`）——比值再好看也不能只差几毫秒。定阈值时按两种噪声模型
各算一遍（固定成本 / 按比例占空比），两种都留足余量再推。

## zsh 里 `path=` 会当场毁掉 `PATH`（2026-08-25 实撞，正好撞在上面那套 commit-tree 姿势里）

zsh 把 `path` 绑定成 `PATH` 的**数组视图**（`cdpath` / `fpath` / `manpath` 同理）。于是一句再普通不过的循环变量赋值：

```
for pair in "a:b" "c:d"; do
  path="${pair%%:*}"      # ← 这一行把 $PATH 换成了 "a"
  ...
done
```

**当场把 PATH 打成一个不存在的目录**，同一次调用里后续的 `git` / `python3` / `tail` 全部
`command not found`。它没有任何报错前兆——赋值成功，只是环境没了。实撞形态：一个用
`git hash-object` + `git update-index` 精确提交多个文件的循环，第一轮就把 PATH 毁掉，
后面每条 git 命令静默失败，脚本却照常 `echo "committed"`，看上去像是提交成功了
（实际 `git update-ref` 根本没跑）。

定式：

1. **循环 / 临时变量别叫 `path`**（也别叫 `cdpath`/`fpath`/`manpath`/`status`——
   `status` 是 zsh 只读的 `$?` 别名，赋值会直接报 `read-only variable`，那次至少还报了错）。
   用 `target` / `dst` / `p_` 之类。
2. 需要局部变量时写在函数里并 `local`：`local target="$1"` 与全局特殊变量无关。
3. 脚本里做了一串命令后，**别只看最后一句的 echo**——它可能是 shell 内建、在 PATH 毁掉之后
   照样打印。判据取实际结果（这里是 `git log --oneline -1` 有没有变），不是脚本自己的口播。

## ANSI 色码会让「自己拼的 grep 检查」恒不匹配（2026-08-24 一天内踩两次）

工具带色输出时，`[warn]` 实际是 `[\e[33mwarn\e[39m]`、`fixture failed` 实际是 `\e[0m\e[31mfixture failed\e[0m`。于是两类东西会静默失效：

1. **自拼的门禁检查**。`bunx prettier --check "packages/**/*.ts" | grep "^\[warn\]" || echo "format clean"` —— `grep` 恒不匹配，`||` 兜底触发，打印一句「format clean」。**匹配不到 ≠ 没问题**：它和「真的没问题」打印同一句话。定式：**跑仓库自己的脚本并判退出码**（`bun run format:check` / `bun run lint`），不要自己拼管道；非要过滤就先 `sed 's/\x1b\[[0-9;]*m//g'` 剥色。实撞：`b67fb839c` 带着两个未格式化文件上了 main，本地那条自拼检查报「clean」（修复 `35814bd40`）。

2. **断言子进程输出的测试**。`console.error('x')` 在 `FORCE_COLOR` 生效时会被裹上 ANSI，子串断言当场碎。Claude Code 会设 `FORCE_COLOR=3` 并传给子进程，于是「本地红、裸终端绿」——典型的「重跑就过了」形状。写测试固件时用 `process.stderr.write(...)` 这类**不上色**的写法。实撞：`test-command-helper.test.ts`（修复 `8d9a24013`）。

顺带：`ps aux | grep -c "[b]un"` 这类自拼判断同理——它数的是恰好匹配的行，进程名一变就静默失真。能用退出码就别数行。

## 画布用例：`boundingBox()` 稳定 ≠ 这个点能被命中（xyflow v12，2026-08-25 实测）

xyflow v12 在节点被 ResizeObserver 测量出来之前，把它渲染成 `visibility: hidden`；而
**`fitView` 会把已经渲染好的节点重新打回未测量态**。本仓的相机控件（`workflow-camera-overview`
等）走的正是 fitView，所以「点一下概览再去量坐标」这条极常见的写法自带一扇窗口。

窗口里两件事同时成立，且方向相反：

- `locator.boundingBox()` **照样返回坐标**——`visibility: hidden` 的元素仍占布局；
- `document.elementFromPoint(x, y)` **会跳过**隐藏元素，Playwright 的可操作性判定同理。

于是「轮询到几何不再变化」的稳定器会 settle 在一个**永远命中不到**的点上，随后的
`mouse.down()` 从空点起手，报出来的却是下游那句「`data-connect-preview` 没变成 `new`」/
「边没连出来」——离病因十万八千里。机器越忙窗口越长，所以它表现为**只在 CI 上间歇红**，
本地怎么跑都绿（实撞：CI run 32756812144 的 macOS 分片，首跑与 retry 各红一次；trace 里
命中那一帧两个节点都是 `visibility: hidden`，此前 60 多帧一直是 `visible`）。

定式两条：

1. **稳定器要同时等「可见」与「几何不动」**，可见性不满足就把稳定计数清零重数——等的是
   「测量完成」，不是「坐标不动了」。`await locator.isVisible()` 已经把 `visibility: hidden`
   与空盒子都算进去了（`visibility` 会继承，祖先隐藏时后代的计算样式也是 hidden，所以查把手
   本身就够，不用去查它的节点祖先）。
2. **命中断言必须报出拦截者**。`expect(hitOk).toBe(true)` 失败时只打印一个 `false`，
   「浮层挡住」与「节点被打回未测量态」在这条信息上完全同形，只能去翻 trace 才分得开。
   照 `e2e/canvas-controls.ts` 的 `clickCanvasControl` 那样，把实际命中的元素描述进断言消息。

范例落在 `e2e/rfc253-script-node.spec.ts` 的 `stableCenter` 与它下面那条命中探针。

## 「写了两行库、回执长得对」≠ 这件事在跑（RFC-309 实测，2026-08-17）

新增一个**发起入口**（把某件已有的工作从新的门开始）时，本仓的实测规律是：照着既有入口
抄「开单」那几行**永远不够**，而缺的部分**不会报错**——回执正确、列表里也看得见，就是不动。
RFC-309 的 `POST /api/code/rounds` 一次踩满三层：

1. **开单 ≠ 起任务**。`openRound` 只写 `code_work_rounds`；原入口在同一口气里还做了
   `noteWorkItemEvent(scheduler-take)` + `startCodeRoundTask` + `attachRoundTask`。
   **判据**：照抄前先 `grep -n "<开单函数>" src` 把**每一个**既有调用点从头读到尾，数清楚
   它后面还跟了几件事；只抄第一件是本仓最高频的「两半正确、中间没接线」。
2. **状态机没有你这个事件**。`scheduler-take` 只接受 `queued`，而新开的工作项是 `idle`——
   原入口靠 `external-signal` 先推一格。借用它就是在说谎（没有任何外部信号），正解是给
   状态机**加一个如实命名的事件**，顺便把「运行中再发一次」定义成拒绝而不是排队。
   加事件的额外好处：穷尽 switch 会逼所有消费者显式处理。
3. **下游要的是「冻结的上游上下文」，你这条路没有**。调度器那支的判据是
   `state.triggerContext !== null`，于是新入口的轮次整支不进、每个阶段拒绝；更隐蔽的是
   两个**写死**的字段（`input: null` / `origin: {kind:'issue', 两个 false}`），让它对着
   一份就躺在轮次里的正文回答「这是引用、我取不到」，并用「请改从平台提交」拒绝一个
   正是从平台提交的请求。**定式**：把 webhook 形状的字段袋抽成中性类型（本仓是
   `CodeContextFields`，`event_type` 可选），两个入口共用；**绝不**为了过类型而伪造一个
   从未发生的托管事件——那个假事件会被下游每一个消费者当真。

配套：**新入口的回执要带「可打开的东西」**（本仓是 `taskId`）。只回 roundId 的回执，在
接线断掉时和接线正常时**长得一模一样**——这正是它值得写进用例的原因（用一个克隆不了的
仓库断言「确实尝试了启动」：拿到仓库类错误 = 接线在，拿到 201 = 断了）。

## 三方合并记「新基线」：记成合并后的本地行，第二次才暴露（RFC-309 实测）

给「从上游更新」写基线时最自然的写法是把合并后的**本地**行整个记为新基线。第一次看起来
完全正确；**第二次**读时，被有意保留的字段基线 = 我方值、上游仍是他方值 ⇒ 判成「上游改了、
我方没改」⇒ 反过来劝你撤销刚保护住的改动。基线是**共同祖先**，只能往上游走；**唯独仍在
冲突的字段保留旧基线**，否则一次合并就把没人裁决过的分歧按上游意见静默了结。版本号同理：
只有冲突清零才推进。另：应用了零个字段的合并要写成**彻底 no-op**（连 `updatedAt` 都不动），
否则下游会因为一次什么都没做的操作集体显示「有更新」。**判据**：任何三方合并都要写一条
「合并 → 再读一次」的用例；只断言合并结果的用例对这个 bug 完全免疫。

## 闭合集合（closed set）扩宽：编译器点出的每一处都要问「这真是同一个问题吗」

RFC-304 往 `ACL_RESOURCE_TYPES` 加两型（能力模板的部门层 / 小组层）时的实测，2026-08-16。

- **先查那个枚举在 SQL 里到底有没有 CHECK**。`resource_grants.resource_type` 在 Drizzle 里标了 `enum`，但迁移里就是裸 `text NOT NULL`——**闭合集合只活在类型系统里，扩它零迁移**。反例是 `tasks` 的 `CHECK`：SQLite 改 CHECK 只能整表重建，同一个 RFC 里为此绕过一次（见 `design/RFC-304-…/plan.md` PR-6 遗留项）。**判据**：`grep -h "CREATE TABLE.*<表名>" -A 20 packages/backend/db/migrations/*.sql`。

- **扩宽后编译器报的每一处，都要先问「这三个问题是不是同一个问题」**。这次报了 12 处，全部是**三个不同问题此前被同一个类型回答**（因为答案恰好相同）：哪些类型有行级 ACL / 哪些能进配置包 / 哪些能被 Intent 会话创建。第一个把它们区分开的类型一到，「恰好相同」就结束了。正解是把它们**命名成三个类型**（`AclResourceType` / `BundleResourceType` / `IntentResourceType`），而不是给新类型补上它根本不支持的机制。

- **其中会藏真缺陷，而且恰恰藏在「更宽」和 `as` 里**。两个实例：
  - `resourcePackage/parse.ts` 用**更宽**的 schema 校验包 manifest 的 root，于是一个声明了不可打包类型为根的包**能解析通过**，到下游才带着更差的报错失败；
  - `cli/package.ts` 写的是 `flags.get('type') as AclResourceType`，随后那次 `includes` 检查早已被断言废掉——**对用户输入做断言，等于把随后的校验变成装饰**。改成在类型化清单上 `find`，真正收窄。
    两者在两个集合还相等时**都不可见**，与「union 少一支」同形：不是错，是**够不着**。

- **权限点与路由必须同批落地——这是结构性的，不是约定**。RFC-247 的启动自检会遍历 `ROUTE_BACKED_POINTS`，任何没有 `RouteMeta` 引用的点位让 daemon **拒绝启动**。这次先加了 8 个点、路由还没写，于是**全仓 20 条测试失败全是这一条拒绝**（凡是 `createApp` 的用例都挂）——症状离原因很远，但只要想到「刚加过点位」就一步到位。反向同理：删路由不删点位一样起不来。

## 本机 bun 低于 `package.json` 的 `engines.bun` 会伪造出「产品 bug」（RFC-349 实测，2026-09-02）

`package.json` 写着 `"bun": ">=1.4.0"`，CI 四条 workflow 也都 `bun-version: '1.4.0'`；本机
若停在 1.3.13，跑出来的红**可能根本不存在于 CI**。实撞：RFC-349 的外置 PostgreSQL 取证跑
在本机稳定出 44 次 `SET TRANSACTION ISOLATION LEVEL must be called before any query`，
按 daemon 日志一路查到「连接被 `reserve()` 交出来时还没干净」，最后用一段**不依赖本仓的
20 行 Bun.SQL 复现**定死：同一段代码在 1.3.13 上 144 次失败 / 42k 次迭代，在 1.4.0 上
**0 次**。是 Bun 的连接池 bug，1.4.0 已修。

- 排查任何「只在本机复现」的运行时怪象前，先 `bun --version` 对一眼 `engines.bun`。
- 不确定时把可疑行为剥成**不 import 本仓任何东西**的最小脚本，再拿两个 bun 版本各跑一遍；
  下载一个临时 bun 到 scratchpad 就行（`https://github.com/oven-sh/bun/releases/download/
bun-v<ver>/bun-darwin-aarch64.zip`），不必动本机工具链。
- 编译产物同理：`bun run build:binary:e2e` 用的是**当前** bun，本机版本不对 = 你测的不是
  CI 会跑的那个二进制。

## 临时探针在工作树里时不要跑 census（RFC-349 实测，2026-09-02）

`scripts/architecture-census.ts` 扫的是**工作树**，不是 HEAD。带着临时 `console.log` 探针
跑一次 census，写出的 `sourceDigest` 就绑在探针版源码上；把探针删掉再提交，committed 的
`architecture/*.json` 与 committed 源码对不上，RFC-294 N1b「seven canonical manifests are
exact generated projections」在 CI 上红，而本地（探针还在时）是绿的。顺序固定为：
**先把所有临时改动去干净 → 再跑 census → 再提交**。

同一段还有一条：**census 的生成物不要进 `prettier --write` 批处理**。它们必须与生成器逐字
相等，被 prettier 重排一次就红（实撞的是 `design/RFC-294-…/status.md`，A2 投影守卫）。

## 对 CI 不检查的共享 md 跑 `prettier --write`，会把别人的行全变成 diff（2026-09-03 实撞）

CI 的 `format:check` 只覆盖 `packages/**/*.{ts,tsx,json,md}` 加 `format:check:repo-ui` 那张**点名清单**
（`package.json:17-18`）——`design/**`、`STATE.md`、`docs/**`、`scripts/depcheck.ts` **都不在覆盖面内**，
所以仓里本来就存在没被 prettier 格式化过的共享 md（实测 `design/RFC-294-…/review-2026-08-30.md` 在 HEAD
上就不是 prettier 干净的）。在这类文件上顺手跑 `prettier --write`，它会把**整张 markdown 表按新的最大列宽
重排**：只加了一行，`design/RFC-294-…/plan.md` 的 §3.2 表就多出 19 行「别人那些行被重新 padding」的删改，
在多人共享工作树上这既违反「只提交自己改过的行」，也让 reviewer 无法一眼看出真实改动。

判据与做法：

1. **动共享 md 前先问「CI 查不查它」**：不查就**不要**跑 `prettier --write`，手工对齐既有风格即可。
2. 真要保持 prettier 干净（比如该文件在 HEAD 上本来就是干净的），**让自己新增的表格行不超过现有最宽的那一格**
   ——列宽不变，prettier 就只碰你自己那行。实测把新增行压短之后，diff 从「42 增 19 删」变成「26 增 0 删」。
3. 提交前 `git diff --stat` 看一眼：**纯新增的文档批不该出现删除行**，出现了基本就是格式重排。
4. markdown 表格单元格里出现 `|`（例如把三个路径缩写成 `a|b|c`），prettier 会把它当列分隔符、把那一行撑成
   多列并顺手改坏整张表的分隔行。表格里写路径就分开写，别用 `|` 缩写。

## Bun `rmSync` 在只读目录上给的 errno 因平台而异，按码白名单分流必漏（2026-09-02 实测）

`rmSync(dir, { recursive: true, force: true })` 删不动一棵含 `0o500`（`dr-x------`）目录的树
——unlink 一个文件要的是**父目录**的写位，不是文件自己的。它报出来的错有两点误导人：

- **路径永远是你传进去的顶层**（`rm '.../opencode-stores'`），不是真正卡住的那一层，日志里
  看不出是哪个子目录挡的；
- **errno 因平台 / 版本而异**：本机 macOS（Bun 1.3.13）报 `EACCES`（unlink 当场被父目录拒），
  CI 的 macos-latest runner 报 `ENOTEMPTY`（unlink 被拒 → 文件还在 → 随后的 rmdir 落空）。
  实撞：`cleanupRetiredStores` 按 `EACCES` / `EPERM` 分流去补写位重试，本机全绿、CI backend
  shard 1（macOS）当场红。

**判据用事实、不要用 errno**：先做补救动作（这里是给树里的目录补 owner 写位），按「补到了
几个」决定是重试还是把原错误原样抛出去。凡是「同一件事在不同平台给不同码」的场合（rmdir 的
`ENOTEMPTY` / `EEXIST` 是 POSIX 明文允许二选一的），错误码白名单都是错的形状。

## 架构账本的联动点：动一次代码要同步 8 处（RFC-329 实测，2026-08-26 连推红六轮）

一次 PR 里加了**一个守卫文件 + 一条账本条目**，主干连红四轮，每轮暴露一个此前不知道的
联动点。四轮全部是同一类失败：**改了 X 就必须同步 Y，而 Y 只有 CI 会告诉你**。

按撞到的顺序列全（新增守卫 / 账本 / 路由、**以及任何改了行数的编辑**，逐条过一遍，别等 CI）：

| #   | 改了什么                                                                                 | 必须同步                                                                          | 不同步的表现                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 新 RFC 同时有 AC 列表和证据表                                                            | `tests/rfc-index-status-drift.test.ts` 的 `AC_EVIDENCE_GAP`                       | 「AC 证据索引的缺口逐字相等」红。**缺口为 0 也必须登记**——它按「measured 与台账逐字相等」判定，漏登记 = 台账少一个键                                                                                                                                                                                                                                                                              |
| 2   | 新增守卫测试文件                                                                         | `architecture/guard-manifest.json` 的 `guards[]`                                  | 「清单与磁盘逐条相等」红。字段值不是随便填：`assertsAbsence` / `negativeFixture` / `corpusScanner` 都由 `census.ts` 从源码**检测**出来，账本要与检测结果相等                                                                                                                                                                                                                                      |
| 3   | 新增/修改任何 `.ts` 源码                                                                 | 全部 12 份 `architecture/*.json` 的 `sourceDigest`                                | RFC-294 N1b「seven canonical manifests are exact generated projections」红。这是**全局**digest（`allUnits` 路径+内容），12 处共用一个值                                                                                                                                                                                                                                                           |
| 4   | 改了 `architecture/{commons-manifest,commons-debt,guard-manifest,ledger-baselines}.json` | 这四份的 `provenance`                                                             | RFC-294 N1a「carries content-addressed provenance reachable from HEAD」红。**一笔提交即可**（2026-08-30 review §A3 起）：`contentDigest` 必须等于当前 payload 的 digest，`currentSnapshotSha` 必须是 HEAD 历史上可达的 40 位 SHA（语义是「生成器对照的已提交祖先」，直接用 `--snapshot-sha HEAD`）；此前「`git show <sha>:<path>` 与当前文件 byte-equal、内容先落一笔再回填 sha」的两笔协议已作废 |
| 5   | 往 `ledger-baselines.json` 加条目                                                        | 条目**位置**                                                                      | N1b 红。`projectGovernanceArtifacts` 投影成「非-N1-spec（原序）+ `n1LedgerSpecs`（末尾）」，而 `toEqual` 对数组顺序敏感。append 到最末尾会落在四条 `rfc294-*` spec 之后                                                                                                                                                                                                                           |
| 6   | 改了任何生产 `.ts` 文件                                                                  | `architecture/module-symbol-owners.json` 里**该文件每个符号**的 `signatureDigest` | N1b 红。改一个函数体就会让 `$file` 与它所在的那几个 top-level 符号的签名全变                                                                                                                                                                                                                                                                                                                      |
| 7   | **新增一条路由**（`registerRoute`）                                                      | `packages/backend/tests/contracts/registry.ts` 的 `ENDPOINTS`                     | RFC-317 T52「运行期预言」+ `api-contract-coverage` 双红。RFC-329 PR-B 实撞：加了 `GET /api/workgroup-tasks/pending` 忘了登记，backend shard 2/4 双 OS 红                                                                                                                                                                                                                                          |
| 8   | **任何让文件行数变化的改动**（含**纯加注释**）                                           | `architecture/background-jobs.json` 的 `ambientWiringEntries`                     | N1b 红。ambient wiring 把每个 `registerRoute` 记成 `...#registerRoute:<line>`，行号进 id。RFC-329 PR-B 实撞：给一条路由加 7 行注释，后面每条的行号全挪                                                                                                                                                                                                                                            |

### `bun run architecture:write` 在多人共享工作树上**不能跑**

它读**磁盘**，不是 HEAD。本仓常态是工作树里躺着别人未提交的生产代码，于是跑一次它就会：

- 把别人的在制品写进共享清单——RFC-329 实测一次生成里 89 条内容有变的条目**83 条属于并发
  session**，另有 223 条是他们的新增文件；
- 把别人引起的 baseline **上涨**写进 `ledger-baselines.json`（实测 842→870、859→928、
  17083→…）。账本只许降，涨要写 `allowGrowth` 并点名 RFC——替别人涨等于帮他们绕过高水位。

**先把污染面收窄**（2026-09-02 源码对账）：真正会被工作树脏文件影响的只有
`packages/{backend,shared,frontend}/src/**/*.{c,m}ts{,x}`（`census.ts` 的 `walkTsFiles` /
`packageSrcUnits`）、`sourceDigest` 额外吃的 `.dependency-cruiser.cjs` 与 `scripts/depcheck.ts`，
外加 `packages/backend/tests/architecture/rfc294-canonical-manifests.test.ts`——只有它被
`upsertCanonicalGuard` 从磁盘现采（连行数一起写进 `guard-manifest.json`）。四份 governance
artifact 的其余部分是**已提交种子 + 投影**（`readSeedJson`）。也就是说别人的在制品若全落在
`tests/`（除上面那一个）/ `docs/` / `design/` / `e2e/` / 未追踪的新测试里，**直接在真实仓库跑
生成器是安全的**，不必绕。判据一行：

```bash
git status --porcelain -- packages/backend/src packages/shared/src packages/frontend/src \
  .dependency-cruiser.cjs scripts/depcheck.ts \
  packages/backend/tests/architecture/rfc294-canonical-manifests.test.ts
# 空 → 直接 `bun run architecture:write --snapshot-sha HEAD`；非空 → 走下面的导出树
```

**替代做法（RFC-329 实测可行）**：

1. `sourceDigest`（第 3 条）：**可以本地算准，不必等 CI**（2026-08-26 修正——原先以为只能从
   CI 反读）。它的输入面只有 `packages/{backend,shared,frontend}/src/**/*.{c,m}ts{,x}`
   （`census.ts` 的 `walkTsFiles` / `packageSrcUnits`）加 `.dependency-cruiser.cjs` 与
   `scripts/depcheck.ts` 两个 extraPaths——**`tests/` 不在其中**。所以用 `git ls-tree` +
   `git show HEAD:` 取内容（而不是读磁盘）就得到干净树的 units：别人未追踪的在制品不在
   ls-tree 里，别人对已追踪文件的未提交改动被 HEAD 版本盖掉。算法就是
   ``digest(sorted(`${path}\0${digest(text)}`).join('\n'))``，`digest` = `sha256:` + hex。

   ```bash
   # 干净树的 sourceDigest（在脏工作树上也算得准）
   bun -e '
   import { createHash } from "node:crypto"; import { execFileSync } from "node:child_process"
   const d = (t) => `sha256:${createHash("sha256").update(t).digest("hex")}`
   const show = (p) => execFileSync("git", ["show", `HEAD:${p}`], { encoding: "utf8", maxBuffer: 6e7 })
   const files = execFileSync("git", ["ls-files", "packages/backend/src", "packages/shared/src", "packages/frontend/src"],
     { encoding: "utf8" }).split("\n").filter((p) => /\.[cm]?tsx?$/.test(p))
   const parts = files.sort().map((p) => `${p}\0${d(show(p))}`)
   for (const e of [".dependency-cruiser.cjs", "scripts/depcheck.ts"]) { try { parts.push(`${e}\0${d(show(e))}`) } catch {} }
   console.log(d(parts.sort().join("\n")))'
   ```

   **务必先自验一次**：拿一个已知答案的历史 commit（某次 N1b 红时 CI 给过 Expected 的那个）
   用 `git ls-tree -r --name-only <ref>` + `git show <ref>:` 复算，对上了再用。RFC-329 就是
   这么验的（在 `7131812a4` 上复算 = CI 的 `5d55ae91…`，逐字节相等）。第二个交叉信号：
   units 数应当等于 `module-symbol-owners.json` 的 `denominator.productionFiles`。

2. `signatureDigest`（第 6 条）：**可以本地算**——它只依赖单文件内容，不受别人的在制品影响。
   跑生成器 → 按 `id` 精确挑出**只属于自己改过的文件**的条目 → 逐字段应用到 HEAD 版本 →
   其余全部 `git checkout --` 回退。RFC-329 用这法子把 89+223 条里的 6 条摘了出来，
   最终 diff 6 增 6 减。
3. 跑生成器前先 `cp` 一份 HEAD 版本到 scratchpad，跑完对着它做「只取自己那几条」的合并；
   **不要**直接 `git add architecture/`。
4. **整套账本都要重生成时：把 HEAD 导出成一棵干净树、让生成器读它**（2026-09-02 实测；比
   第 1、2 条的手工挑条目省事，且零污染）。`git archive <ref> | tar -x -C <scratchpad>/tree`
   产出的是**导出**不是 worktree（没有 `.git`、提交不了，不违反「不建 worktree」）。再把
   `scripts/architecture-census.ts` 复制到 scratchpad 改两处：`REPO_ROOT` 取 `process.argv[2]`、
   三个相对 `import` 改成**真实仓库的绝对路径**（否则直接在导出树里跑会
   `Cannot find module '@agent-workflow/shared'` —— 工作区包靠真实仓库的解析上下文）。
   然后 `bun run <scratchpad>/census-driver.ts <scratchpad>/tree --write`，产物落在导出树里，
   跟工作树里别人的在制品完全不相干。
   - **自验**：生成物的 `sourceDigest` 必须等于第 1 条用 git 算出来的值——两条独立路径对上
     才算数（本次两边都是 `4ceb50e1…`）。
   - **一处残留耦合**：`rfc294Canonical.ts` 静态 import 了
     `src/modules/task-execution/domain/codeHostRecovery.ts`，这一份读的是**真实工作树**；
     该文件被别人改脏时这条路子不干净，用之前先确认它等于 HEAD。
   - **provenance 要另外补**：导出树不是 git 仓库，driver 跑不了 `--snapshot-sha`
     （`fullSha()` 走的是 `git rev-parse`，cwd 落在导出树里必然失败），而上表第 4 条那四份
     governance artifact 的 `provenance.contentDigest` 是**去掉 provenance 后的 payload 摘要**
     （`withArtifactProvenance` / `artifactContentDigest`）。产物拷回真实仓库后，要在真实仓库
     里把 provenance 重钉一次，否则 N1a「content-addressed provenance」红。
   - **省掉那道手工重钉：把真仓库的 `.git` 软链进导出树**（2026-09-02 实测）。链好之后
     `fullSha()` 的 `git rev-parse` 就能用，可以直接在导出树里跑
     `bun run architecture:write --snapshot-sha HEAD`，census 与四份 provenance 一次做完。
     **代价**：那棵树从此共享真实仓库的 HEAD / index，只能在里面跑生成器与只读 git 命令；
     任何 `checkout` / `add` / `commit` / `reset` 都会作用在**真实仓库**上。
   - **导出的必须是「你要推的那个 commit 本身」**（`git archive <commit>`），不要「archive HEAD
     + 逐个从工作树拷自己改过的文件」。2026-09-02 实撞（`d335ea0fa`）：拷贝发生在把
     `cli/start.ts` 重放成干净版**之前**，于是账本采的是含并发 session 未提改动的磁盘版
     （3456 行）、提交的却是重放版（3460 行）——账本里三处
     `ambient:…start.ts#registerAfterCommitEventPump` 全部差 4 行（记 2540、需要 2544），
     `sourceDigest` 也对不上，推上去当场 N1b 红。**采样源与提交内容是两个东西**，只有从提交
     本身导出才恒等；推之前再自验一遍（导出目标 commit 整体重跑、与 committed 逐字节比）就
     能在推之前拦住。
   - 同一套姿势还能用来**判定账本到底同步了没有**：把 tip 导出来整体重跑一次，与 committed
     的 `architecture/*.json` + `status.md` 逐字节比。2026-09-02 就是这么确认「并发 session
     的重生成已经把我的改动一起收进去了、我不必再提一笔」的——他们的生成器读的是含我已提交
     源码的磁盘，产物天然覆盖我那部分。

### 改 artifact 的 `entries` 别忘了同文件的 `denominator`

`module-symbol-owners.json` 与 `background-jobs.json` 各自带一个 `denominator` 块，里面的
`symbolsIncludingFileRoots` / `ambientWiring` 必须等于对应数组的长度。只改数组不改它，N1b 会
红在一个**看起来与你的改动无关的地方**（diff 里只显示 denominator 那一行差 1）。

`ledger-baselines.json` 里还有各自的 baseline 条目，**那是第三处**。所以加一个 top-level 符号
要同时改：entries 数组、该文件的 denominator、ledger baseline（若上涨还要写 `allowGrowth`）。

### `sourceDigest` 的算-提-推竞态：必须在 `merge --ff-only` **之后**算

这是本仓直推 main 工作流下的结构性竞态，和算法对不对无关：

```
算 sourceDigest        ← 基于此刻的 HEAD
git commit
git fetch && git merge --ff-only   ← 把别人刚推的源码改动拉了进来
git push                            ← 推上去的 commit 已含它们，你的 digest 当场作废
```

RFC-329 实撞：算完之后 merge 进了并发 session 的四个前端文件（Select.tsx / MultiSelect.tsx /
UserPicker.tsx / usePopoverPosition.ts），N1b 因此红，而本地怎么看都是对的。

**正确顺序**：`git fetch && git merge --ff-only origin/main` → **算 digest** → 改 artifact →
commit → repin provenance → **立刻 push**。推之前再 `git fetch` 确认 `HEAD~n == origin/main`，
不等就说明又有人推了，digest 要重算。中间不要插入任何耗时操作（跑测试、写文档），
窗口越短越好。

### 别人改了代码没同步 artifact 时，能不能代做

判据是**这部分账本会不会被并发在制品污染**，不是"是不是我的改动"。

RFC-329 实测：并发 session 改了前端代码却没更新 `module-symbol-owners.json`（缺 1 条符号 +
19 条过期 signatureDigest），而工作树里另一个 session 的 RFC-328 在制品**全在 backend**——
所以生成器输出的**前端部分不受污染**，可以整组机械同步。反过来，backend 的符号账本在那种
工作树上就不能代做，只能同步自己改过的文件。

同步前先逐文件核对一次（`current=4939 / generator=4940`，差异全落在前端），并在 commit
message 里写明「这一段是替谁补的、为什么能安全代做」。

### `docs/` 不在 format 门里，别对它跑 prettier

`format:check` 的范围是 `packages/**/*.{ts,tsx,json,md}` 加上几个具名文件（见 package.json），
**`docs/` 不在其中**——仓里的 `docs/*.md` 因此本来就不是 prettier-clean 的。

对它跑一次 `prettier --write` 会把别人写的斜体（`*x*` → `_x_`）、列表标记（`+ ` → `- `）和
表格列宽大面积改写：RFC-329 实测在 `audit-backlog.md` 上是 **50 删 53 增，而真实内容改动只有 3 条**。
那种 diff 里没人看得出你到底改了什么，也违反「完全不动别人的产物」。

**改 `docs/` 只改内容，不跑 prettier。** 提交前用 `git diff -w` 自查：忽略空白后的增删行数
应当和你的实际改动条数对得上；对不上就说明你顺手改了别人的东西。

### `git commit -- <目录>` 与裸 commit 在共享树上等价

CLAUDE.md 警告过裸 `git commit` 会提交整个暂存区。**加了 pathspec 也挡不住，只要 pathspec
是目录**：`git commit -- architecture/` 提交的是该目录下的全部改动。RFC-329 就这样把并发
session 未提交的两个 e2e 覆盖账本推上了主干，当场引发 T16 红
（`rfc319-e2e-endpoint-coverage: 源码 66 vs 基线 96`——artifact 提了一半，配套基线还在对方手里）。

**pathspec 必须精确到文件**：`git commit -- a.json b.json`。撤回误提时，把对方的在制品内容
先 `cp` 到 scratchpad，`git checkout <误提前的commit> -- <files>` 恢复并提交，再把备份原样
写回工作树——这样对方的磁盘内容一个字节没变，只是重新显示为 M。

## git / 多人协作（共享工作树）

- **`git commit -- <路径>` 提交的是「工作树」内容，不是 index —— 你精心 `git add` 的那一版会被静默忽略**（2026-08-25 实撞，同一个坑连着把 main 弄红两次）。
  本仓强制「提交时带 pathspec」（`git commit -m … -- <你的路径>`），理由是共享 index 里躺着别人 `git add` 过的在制品，裸 `git commit` 会把它们一起发布。这条规则是对的，但它有一个**反方向**的后果，文档此前没写：
  带 pathspec 的提交会**重新从工作树读取**这些路径，`git add` / `git update-index` 的结果对它们不起作用。实证（30 秒可复跑）：

  ```
  git init -q . && printf 'base\n' > f.txt && git add f.txt && git commit -qm base
  printf 'WORKTREE-VERSION\n' > f.txt
  SHA=$(printf 'INDEX-VERSION\n' | git hash-object -w --stdin)
  git update-index --cacheinfo 100644,$SHA,f.txt
  git show :f.txt            # => INDEX-VERSION
  git commit -qm x -- f.txt
  git show HEAD:f.txt        # => WORKTREE-VERSION   ← index 那版没了
  ```

  **后果**：对一个**双方同改的文件**，`git commit -- <file>` 必然把对方**未提交的工作树改动**一起发布——这正是「不要替别人发布半批」想避免的事，而 pathspec 纪律本身挡不住它。
  实撞两次、症状相同：一份基线文件里躺着并发 session 尚未落地的降幅，我两次都以为自己只提了自己那一处（第二次甚至先用 `hash-object` + `update-index` 造好了只含自己 hunk 的 blob，并 `git show :<path>` 验过），提交后 main 两次红在同一条棘轮上——因为**那两步对带 pathspec 的提交毫无作用**。

  **可用的定式**（本仓禁 `stash`、禁分支、禁开发用 worktree，所以选项有限）：
  1. **能不碰就不碰**：把自己的改动挪到别的文件 / 别的行，让混文件根本不进 pathspec。
  2. **首选：临时索引 + `commit-tree`，全程不碰工作树**（由并发 session 提供，2026-08-25）。共享 index 与共享工作树是两个独立的污染源，这个姿势同时绕开两者：

     ```
     export GIT_INDEX_FILE=$(mktemp -u)          # 自己的私有索引，不动共享 index
     git read-tree HEAD                           # 以 HEAD 为底
     SHA=$(git hash-object -w /path/to/my-version.json)
     git update-index --add --cacheinfo 100644,$SHA,<path>   # 只塞自己那几个 blob
     TREE=$(git write-tree)
     COMMIT=$(git commit-tree $TREE -p HEAD -F msg.txt)
     git update-ref HEAD $COMMIT
     unset GIT_INDEX_FILE
     ```

     零副作用：对方的工作树改动一个字节没动过，也没有任何时间窗口。

     **但它有一个必须补的收尾动作**（2026-08-25 实撞，被并发 session 当面点出来）：
     `update-ref` 只挪了 HEAD，**共享 index 还停在旧 HEAD 的那份快照上**。于是从此刻起，
     别人在这棵共享树上跑 `git status` 会看到你刚提交的每一个新文件被标成
     **`D`（已暂存的删除）**，两份账本 / STATE.md 之类被你改过的文件也显示成「暂存了一版旧内容」。
     这不只是看着吓人：本仓的裸 `git commit` 提交的是**整个暂存区**，任何人手滑一次
     就会把你刚上库的文件**从 main 上删掉**——正是 CLAUDE.md 里那条「提交必须带 pathspec」
     反过来的那一面。连提 5 笔之后，我的 9 个新 spec 文件在别人眼里全是待删状态。

     收尾一句就够，**只动自己提交的那几个路径**（别用不带 pathspec 的 `git reset`，
     那会把别人真正暂存着的东西一起冲掉——实撞当时 `design/plan.md` 上就正躺着并发
     session 暂存的 RFC-323 行）：

     ```
     git reset -q HEAD -- <这次提交的每一个路径…>   # 把共享 index 里这几项刷成新 HEAD
     git diff --cached --name-status                # 复验：只应剩别人自己暂存的东西
     ```

     判据同上一条：**`git diff --cached` 是这套姿势唯一验得出 index 漂移的地方**，
     提交后顺手看一眼，别等别人来提醒。

  3. **兜底：写入 → 提交 → 写回**。把「只含自己 hunk」的版本写进工作树，`git commit -- <file>`，然后**立刻把对方那版原样写回**，并 `cmp` 验证字节相等。缺点是有一个毫秒级窗口——期间对方写同一文件就会被覆盖，所以能用第 2 条就别用它。**提交前后各留一份对方版本的副本**，写回失败就人工比对。
  4. **提交后必须复验**：`git show HEAD:<file>` 看落下去的到底是哪一版。`git diff --cached --stat` **验不出这件事**——它看的是 index，而 index 恰恰是被忽略的那一半。这一步是上面两次事故都缺的那一步。

- **在共享工作树上「顺带提交别人半批改动」：本地绿证明不了 main 绿，因为你本地一直有他们尚未提交的另一半**（2026-08-23 实撞，我把 main 弄红了）。场景是并发开发的常态：我改了一个跨模块契约（RFC-317 T31），编译器要求另一个 context 的公共类型跟着改——而那个文件工作树里已经混着并行 session 在制的 `allowedEffectKinds` 一批改动。不带上它，main 上类型不通；带上它，就等于替对方发布了半批。我选了带上，并在 commit message 里写清「附带保留」，然后**只跑了自己改动所在的那几个面 + 全仓 typecheck**——全绿。推上去 CI 立刻红在 `Lint + Typecheck + Format` 那一格：`rfc310-digital-employee-authoring.test.ts` 调用那个被改签名的函数时少了一个新增实参。那个文件对方**也**改好了，就在我工作树里躺着，只是我没提。于是本地 typecheck 从头到尾都是绿的，而 main 从来没绿过。
  **为什么本地绿骗过了所有常规检查**：`bun run typecheck` 跑的是**工作树**，工作树 = 我的改动 + 对方已提交的 + 对方**未提交**的。CI 跑的是 checkout = 我的改动 + 对方已提交的。两者的差集正是「对方未提交的那部分」，而它恰好补全了我这次携带的半批。**这个差集在本地任何命令下都不可见**——`git status` 只告诉你有文件在改，不会告诉你「你刚提交的那个签名有 7 个调用点，其中 1 个的修复还在未提交区」。
  **可执行的判据**（比「小心一点」有用）：改了任何**被跨文件引用的签名 / 类型 / 导出**之后，提交前跑一次
  `git grep -l '<被改的符号>' -- packages | xargs -I{} sh -c 'git diff --quiet HEAD -- {} || echo "未提交: {}"'`
  ——凡是引用了该符号**且**处于未提交状态的文件，要么一并提交，要么就说明你这次改动在 main 上不完整。**只跑 typecheck 是发现不了的**，因为它看的是工作树。
  **第二条**：commit message 里写「附带保留了别人的 X」时，要连带回答「X 的全部引用点是不是都在这次提交里」。携带半批比不携带更危险——不携带只是编译不过（立刻可见），携带一半是**你本地永远绿、别人的 CI 永远红**。
- **混合文件可以一起提，但要先确认它引用的符号是否也在别人未提交的改动里**（2026-08-19 实撞，与上一条同源）：我按仓规把一个双方同改的路由文件整份提交，里面带着对方新加的路由——而它 `import` 的函数定义在**另一个尚未提交的文件**里。于是主干只拿到了「引用」没拿到「定义」，`bun build --compile` 在 CI 两个 job 上直接失败（`No matching export … for import`）。**本地全程绿**：工作树里有对方未提交的那一半，构建看不出缺口，只有干净 checkout 才暴露。
  - 判据：提交混合文件前，对其中**不属于自己**的新增引用（import / 新符号）扫一眼——`rg -n "export.*<符号>" ` 看定义在哪个文件，那个文件在不在本次提交里。
  - 「同一文件混改一起提」这条规则的前提是**那份改动自洽**；跨文件的定义-引用对被拆开时，规则本身不保护你。
  - **人眼扫一遍不够——同一批提交里它漏了第二处**（同日续撞）：第一处 `previewMissionAdmission` 修好推上去，CI 下一格又红在同一形态的另一处（路由里对方新写的 `automation.drive(...)`，定义在未提交的 `composition.ts` + **未追踪**的 `missionDriver.ts`）。一次一处地被 CI 教，等于每处付一轮 20 分钟。
  - **机械判据（首选，采纳自并发 session 的建议）**：把**即将推的那棵树**做成一个临时 commit，开分离 worktree pin 上去，在里面跑 typecheck / build——干净 checkout 天然只有你提的那部分，缺定义当场全部报出来，一轮问完。这与本仓已有的「共享树上过门禁要用 pin 到自己 commit 的分离 worktree」是同一条定式的延伸；本地绿只说明**你的工作树**里那半份未提交的改动补上了缺口。
    ```sh
    export GIT_INDEX_FILE=/tmp/idx; git read-tree HEAD; git add -- <本次要提的路径…>
    T=$(git write-tree); unset GIT_INDEX_FILE; C=$(git commit-tree "$T" -p HEAD -m tmp)
    git worktree add --detach /tmp/wt "$C"
    cd /tmp/wt && bun install --frozen-lockfile   # 1546 包约 1 秒，别图省事软链（见下）
    # 再跑 typecheck / lint / format / depcheck / bun build / 目标测试
    ```
  - **别用「软链主树 node_modules」省掉那 1 秒**：workspace 包（`node_modules/@agent-workflow/shared` 等）会被链回**主树**路径，于是任何按「仓库根的相对路径」判定的检查全部误报——实测 `depcheck` 报出一条根本不存在的 `no-circular`（路径长成 `../../../../../../../Users/…`，匹配不上 `KNOWN_VIOLATIONS`），`rfc199-workflow-validation-context-ratchet` 报「少了两个 shared 源文件」。两条都是假红，且**看起来非常像真回归**，排查代价远超那 1 秒。**软链且连 `bun install` 一起省掉时，症状会伪装成「仓库被破坏」**（2026-08-19 又撞一次）：本仓依赖实际装在 `packages/*/node_modules`（顶层只有 24 项；`zod` 是 `packages/shared/node_modules/zod` → `node_modules/.bun/zod@3.25.76` 的软链），只软链顶层等于各包一个都没有，于是 typecheck 一片 `TS2307: Cannot find module 'zod' / 'jose' / 'protobufjs'`、frontend 直接 `exit code 127`。我当场误判成「谁把 node_modules 清了」，还差点在共享主仓上做多余的修复动作。**判别式（一条命令，先跑它再谈别的）**：`ls -d packages/*/node_modules | wc -l`——是 `0` 就是**你自己这棵树没装**，不是仓库坏了；主仓那边同一条命令应当是 `4`。
  - **但真正的正解是第三条路：别把那个文件带上去**（事后由 RFC-310 session 指出，我当时只想到"补完"和"让主干红着"两条）。「补齐缺失定义」是止血，代价是**你替一份没人验过的代码盖了章**——这次补完的 300 多行，事后追作者才发现在线的那位并不是它的作者，全仓 `git log -S` 显示那些符号的**首次出现就是我的 commit**，于是没有任何人能说清它跑没跑过门禁。遇到这种情形，宁可自己那部分晚提一轮：先把该文件从本次提交里摘掉、找到作者、由他连同定义一起提。
  - **补齐缺失定义 > 从主干删掉对方的引用**（当第三条路走不通、主干已经红着时的次优解）：后者要求提交一个与工作树不同的 blob（对方的行还在树上），操作面危险且等于替对方决定；前者只是把定义-引用对重新合拢，语义零改动。提完必须通报，并在 commit message 里写明「这些行非本人所写、未经其作者门禁」。
- **共享树上永远用 `git commit -- <paths>`；裸 `git commit -m` 提交的是整个索引，会静默带走别人 `git add` 过的文件**（2026-08-19 实撞，一手教训）：我用 `git add <我的三个文件> && git commit -m …` 提一批 prettier 修复，结果 commit stat 里出现 **9 个文件**——多出来的 6 个是并发 session 已 `git add`、尚未 commit 的在制改动（五个弹窗 + 一个测试文件），连同他们**还没跑完全量门禁**的状态一起上了主干。
  - 机理：`git add` 只是往索引里放东西，`git commit` 提的是**索引全部内容**，不是「我刚 add 的那些」。共享树上索引是共用的，所以别人 add 过什么，你就替他提什么。**全程没有任何提示**。
  - 症状与判据：提交后 `git show --stat HEAD` 里出现自己没碰过的文件——所以**每次 commit 后都要看一眼 stat 的文件数**是否等于自己的预期（本仓已有的「共享树全树操作」条讲的是 `git add -A` 之害，这条是它的孪生形态：即使精确 `git add`，commit 仍是全索引）。
  - 定式：**`git commit -- <path1> <path2> …`**（pathspec 形式）只提指定路径、不动索引里其余部分；提交信息照旧只描述自己的改动。
  - 事后处置：**不要为署名去 revert**。内容如果逐字正确，revert + 重提只是在共享主干上多一轮冲突面和多一轮 CI，功能零收益；正确做法是立刻通报对方（他们可能正等着自己的门禁结果决定推不推），由代码作者决定向前修还是补文档说明。
- **建 pin worktree 时用 `-p HEAD` / `HEAD~` 这类相对引用，可能把别人尚未推送的中间态一起
  钉进来（2026-08-20 并发 session 实撞）**。共享树上 `HEAD` 未必等于 `origin/main`——另一个
  session 刚提了两个还没推的 commit 时，`-p HEAD` 建出来的"基线"里就混进了他的在制品，
  于是 pin 树里报出的红（那次是 `nodeRuns` 插入缺 `createdAt` 的 typecheck 错）既不属于你、
  也不属于主干。**判据**：建 pin 之前先
  `git rev-list --left-right --count HEAD...origin/main`，两侧都为 0 才说明 HEAD 就是主干。
  **更稳的做法是根本不用相对引用**：`git worktree add --detach <显式 SHA>`——你要验哪个
  commit 就写哪个，它不随任何人的 HEAD 漂移（本仓 RFC-313 那几轮门禁与 A/B 归属都用这种
  写法，没撞上这个坑）。
  - **`origin/main` 这个引用本身也可能是过去式——pin 之前必须先 `git fetch`**（同日，我在同一堵墙上撞了**两次**）。两次症状一模一样：隔离门禁报出一条红，而那条红**早就被主干修好了**，只是我 pin 到了它之前。第一次是 i18n 的字面 markdown（`bb88bf9d` 已修），第二次更深——被我 pin 掉的正是并发 session 刚落的**同族测试修复**（`43d48949`），于是我"发现"的回归其实是自己把时钟拨回去造出来的。完整写法是先 fetch、再把 SHA 落成变量：
    ```sh
    git fetch origin main -q
    BASE=$(git rev-parse origin/main)          # fetch 之后再落，别用 HEAD
    git read-tree "$BASE"; git commit-tree "$T" -p "$BASE" -m tmp
    ```
  - **这类红最贵的地方是它伪装成正经工作**：它看起来像新破损，第一反应是"顺手修掉"——真去修就等于把已修好的东西又改一遍，还可能覆盖掉别人的正解。**动手前先问一句"它是不是已经被修过"**，一行命令可判：
    ```sh
    git log --oneline <你pin的SHA>..origin/main -- <报红的文件>
    ```
    有输出就说明主干上有人动过它，先读那几笔再决定，别先动手。（判据由并发 session 提出，我两次实撞都能被它拦住。）
- **共享树上的 typecheck / 测试结果不是任何 SHA 的属性，是别人键盘的瞬时快照**（2026-08-14 双向实撞，两个 session 各栽一次）。同事在共享树上跑 typecheck 想判「main 红不红」，撞到的那条错误 40 秒后自己消失了——因为我当时正在实时改那一行。共享树上的红有**三种**来源：你的改动、他人的未提交改动、以及**正在被编辑的中间态**；第三种会自愈，最能骗人。**判据**：要判某条 SHA 红不红，只能在 pin 到它的**干净 checkout**（分离 worktree 或 CI）上跑；CI 绿本身就是最省事的权威证据。
- **在共享树上做「这条红是不是我的」对照实验，必须把**全部**未提交改动一起隔离，不能只 stash 你认得的那几个文件**（同一天，我犯的那半）。我用 `git stash push -- <我改过的文件>` 跑了一次 typecheck，红还在，据此判定「与我无关」并给同事发了归属信——错的：树上还留着**他**未提交的另一个文件，那才是真来源，所以两次跑的其实是**同一个污染态**，根本不是对照。用一个没控住变量的对照下归属结论比不做更糟，因为它给你虚假的确信。**定式**：要么 `git stash -u` 全隔离后再跑，要么直接开 pin 到目标 SHA 的干净 worktree（首选，零风险）。
- **对共享索引类文档（`docs/audit-backlog.md` / `STATE.md` / `design/plan.md`）做 `git add <整个文件>`，会把他人**正在编辑中**的半成品推上 main**（2026-08-14 实撞，后果比「带走别人已完成的改动」重一档）。我只想往 backlog 追加一段，`git add docs/audit-backlog.md` 就把第三个 session 的五条 RFC-247 收口记录一并带走了。**真正的危害不是内容混在一起**（仓规允许混提），而是那几条写的是「**已修**」而对应代码**还在对方工作树里没提交**——于是 main 上的文档声称三件事已修，实现却不在 main 上，任何人读文档都会被误导。**定式**：动共享索引前先 `git status --porcelain <该文件>`，若它已被改动，要么先确认那些改动是你自己的，要么改用 `git add -p` 只挑自己的 hunk（这类文件通常是纯追加，挑 hunk 很干净），要么等对方提交后再追加。**判据**：`git diff --cached <该文件> | grep -c "^-"`——纯追加应当是 0；非 0 就说明你动了别人的行。**但这条判据只对「纯追加」型文件成立**（2026-08-19 补）：`design/plan.md` 是**就地改行**的表格，自己改一行必然产生删除，于是该计数恒非 0、给不出信号。就地改行型换成 `git diff --cached --numstat <该文件>`，**删除数应当等于你自己编辑过的行数**，多出来的就是别人的。（别用 `grep -c "^-[^-]"` 这类手写模式：本仓文档大量以 `- ` 起头的条目，diff 里长成 `-- xxx`，会被该模式连同 `---` 文件头一起漏掉——实测恒为 0。`--numstat` 不受行首字符影响。）本次我改 RFC-312 一行、numstat 删除数为 2，多出来那条正是并发 session 尚未提交的 RFC-313 行——而它是 `Draft → Done（实现落主干）` 的状态翻转，主干于是声称了一件 `origin/main` 上根本没有的实现（无 `decideRetryShape`、无对应测试）。**状态翻转比一般失真更该拦**：接手 session 读索引会据此跳过工作。
- **共享索引文件要按「错了会怎样」分档，不能一律套「混改一起提」**（2026-08-19，由并发 session 提出、双方各自实测确认）。同一个机制（`git add` 整份共享文件必然裹进他人在制内容）在不同文件上后果差一个数量级：
  - **文档类**（`STATE.md` / `design/plan.md` / `docs/audit-backlog.md`）：错了是**信息失真**，可事后追一笔改回。仓规「同一文件混改一起提」在这里成立。
  - **`packages/backend/db/migrations/meta/_journal.json`：不适用那条规则**。它更像 lock 文件——journal 里多一条条目而对应 `NNNN_*.sql` 还在别人工作树里**未追踪**，主干上的 daemon **直接起不来**，而且是在别人的机器与 CI 上炸。它只能与**自己那份 .sql 原子地同一笔提**，绝不能因为「顺手混提」把他人的条目带上去。
  - **判据（动迁移前必查）**：`jq '.entries | length' packages/backend/db/migrations/meta/_journal.json` 与 `git show HEAD:packages/backend/db/migrations/meta/_journal.json | jq '.entries | length'` 是否相等；不等就说明树上有未落地的 journal 条目，此时**编号取「届时主干末条 +1」**而不是照抄本地末条，且提交时只带自己的两个文件。
  - **机理（读过源码，不是推测）**：`drizzle-orm/migrator.cjs` 的 `readMigrationFiles` 逐条 `readFileSync(<tag>.sql)`，缺文件直接 `throw new Error("No file … found")`。它跑在**每一次 `openDb`** 上，所以后果不是「某个功能坏了」而是 daemon 与几千条 DB 测试同时红。
  - **迁移文件在共享树里是「已上线」状态，不是草稿**：`bun run dev`（`packages/backend/package.json`）**不设 `AGENT_WORKFLOW_HOME`**，直接打真实 `~/.agent-workflow`。只要用户在你迭代迁移期间起过一次 dev，你那版草稿就已经写进他的真实库了。**定式**：自己跑一切带迁移的东西都显式 `AGENT_WORKFLOW_HOME=~/aw-<slug>`；迁移一旦落到共享树就当它已发布，改内容要按「再补一条」而不是「改回去」。
  - **改了已应用的迁移：drizzle 自己不会重跑，但本仓的 admission preflight 会当场拒绝启动**。两层要分清，别只读上游源码就下结论——我犯过这个错，见下。上游 `drizzle-orm/sqlite-core/dialect.cjs:672-687` 判定是否执行只比 `Number(lastDbMigration.created_at) < migration.folderMillis`，**`hash` 只写不比**，所以改内容不会触发重跑；但本仓在其之上另有一道 `stage: 'migration-history-preflight'`（`db/client.ts:184` → `db/schemaAdmission.ts`），**逐条比对已应用迁移的 hash**，不符即 `refusing to start`（报文出处 `schemaAdmission.ts:584`，`cli/start.ts:203`）。所以真实后果是**下次启动直接起不来——响亮、可见、可修**，不是静默分叉。处置规程见下文 RFC-309 0174 那条（备份 → 比物理差异 → 照规范文件原样重放 → 最后才改那一行记账 hash）。
  - **`LEGACY_MIGRATION_HASHES`（`schemaAdmission.ts:51`）是 RFC-278 给生产库历史字节的封闭白名单，恰好 8 条，绝不是"hash 不参与判定"的证据**——我实测本机 186 条里 8 条哈希不符而系统照常运行，据此推出「hash 只写不比」，**是错的**：那 8 个 tag（0052/0069/0084/0085/0095/0107/0125/0139）与白名单**逐个对上**，它们跑得好是因为被**显式豁免**（豁免判定在 `:221`）。**教训有两条**：①观测到「异常存在且无后果」时，先找有没有一条**显式豁免**在兜着，再去推翻机制；②只读上游依赖源码不够，本仓常在其上加自己的门。**并且千万别把本机草稿 hash 塞进那个白名单让它闭嘴**——那会把一次可修的启动失败变成永久的、被制度化的库-代码分叉。
- **别对 `STATE.md` / `docs/**`/`design/**` 跑 prettier——它们不在 format 门里，"顺手格式化"等于替别人改内容**（2026-08-19 实撞，并发 session 独立复核确认；与上一条同族）。我习惯性 `prettier --write STATE.md`，它把 RFC-310 段落里一行以 `+` 开头的正文当成列表项归一成 `-` 并缩进后续行——**一次重排 22 行我根本没打算碰的第三方段落**，混在我的 diff 里提上去就是「谁也没要求、谁也看不懂」的噪音。
  - **判据要看扩展名白名单，不是目录前缀**（这条是被并发 session 当场纠错纠出来的——我先是把判据说成「看目录」，于是自己推出「`packages/frontend/src/styles.css` 在门里」的**错误**结论）。`package.json` 里 `format` / `format:check` 覆盖的是 `packages/**/*.{ts,tsx,json,md}`——白名单里**没有 `css`**；`format:check:repo-ui` 那串也只有 `package.json` / `playwright.config.ts` / `e2e/**/*.{ts,md}` / `.github/workflows/*` / 两个 scripts。
    所以 **`.css` 与 `STATE.md` / `docs/**`/`design/**` 是同一档**：CI 的 format 门根本不看它们。这个方向的错比反过来更该纠——「以为门禁要求」会让下一个人放心地对 `styles.css` 跑 `--write`，而那正是本条记录的坑。
  - **`gate:local` 跑在工作树上，因此会看见未追踪文件；CI 看不见——两者不一致本身就是个坑**。我留在树上的临时探针 `packages/backend/probe-mission-plan.ts` 会让门禁在 format 上红而 CI 一路全绿（症状离原因很远，容易误判成自己刚改的东西）。
    **处置不是「记得 rm」，是换跑法**：过门禁一律在上文那个 `commit-tree` 物化出的分离 worktree 里跑。那棵树是从 **git 对象**建出来的，**结构上只含被追踪内容**——别人的未追踪文件与你自己没打算提的东西都不在里面，因此这个坑天然不可达。并发 session 实测佐证：它按此跑法过了六轮门禁，`probe-mission-plan.ts` **一次都没出现过**，而同期我的工作树门禁被它红着。
    附带收益有两条：①门禁看到的就是 **CI 将要看到的那份 checkout**；②共享树上他人的半成品不会污染你的结果——**红了就一定是你的**。
    **但它有代价，而且这个代价一旦普及就没人兜着了**：物化树门禁回答的是「我要推的这份内容，CI 会不会绿」，它**不再回答「这棵共享树健康吗」**——这是两个问题。本次那个探针之所以被发现，纯粹是因为**还有人在工作树上跑门禁**；等所有人都换成物化树，这条发现渠道就关闭了。（我自己正是在物化树里过的门禁，全绿，因此**看不见**自己留下的垃圾，只在别人的工作树门禁里现形。）
    **配套判据（成本极低，别省）**：提交前额外看一眼 `git status --porcelain | grep '^??'`——**只确认没有你自己的临时产物遗留**（`rm` 因 cwd 漂移变成空操作是实际发生过的形态；同族的还有忘了 `git worktree remove` 的门禁树），不去清理别人的东西，因此与仓规「他人未追踪文件不要主动 add」不冲突。
  - 已经跑了怎么办：别手改回去（容易改出第三种形态）。把 `git diff <file>` 存成 patch，只截出**不属于本次工作**的那个 hunk，`git apply -R` 反向撤掉即可，其余改动原样保留。
  - **把 format / lint 的红「归给某个 commit」时，判据必须查 HEAD 的 blob，不能查工作树**（2026-08-20 实撞，并发 session 当场纠错）。我看见 `bun run format:check` 点名一个**已 tracked** 的文件，就按 `git log -1 -- <path>` 把红归给了那个 commit 并通报「主干 format 门红了」。实际上主干那份一直合格，不合格的是**别人当时正在写、尚未提交**的工作树版本（该文件彼时 `git status` 是 ` M`、37 增 9 删）。
    ```sh
    git show <sha>:<path> | npx prettier --check --stdin-filepath <path>   # 用 --stdin-filepath 让配置解析与门禁一致
    ```
    工作树版只回答「我现在能不能过门禁」，**回答不了「主干是不是坏的」**——这正是上一条「`gate:local` 看工作树、CI 看 HEAD」的归因侧推论。
    **为什么这条错比一般误判重**：它给出的修法（`prettier --write <path>` 然后 `git add <path>` 提上去）会把别人**在制的半成品**一起推上主干，而对已 tracked 且 ` M` 的文件，`git add <path>` 看起来无比正常——与上文「共享索引文档整份 add」是同一族，只是换到了代码文件上。**我这次的漏判还有第二层**：我确实跑了 `git status --porcelain <path>`，但它当时返回空，我据此写下「工作树干净」；对方开始编辑是在这之后。**单次 `git status` 是一个瞬时快照，不是一段时间内的事实**——共享树上要拿它当判据，就得在做出结论的那一刻重取一次。
  - **归属未追踪文件时按内容判，不要按时间/位置相邻判**（同日第二次实撞）。工作树上出现一个未追踪探针 `packages/backend/zz-probe.ts`（让 format 门红），我看到「刚有并发 session 说自己跑过探针 + 时间戳相近」就把它归给了对方。对方用**内容**反驳：那文件导入 `buildOverview` / `recordStatements`，是另一条 RFC 的形态；他们的探针是 `.test.ts`、导入完全不同的符号、且建在分离 worktree 里从未落主树。**共享树上「谁最近做过类似的事」不是判据**——同一时段常有三四个 session 在做类似的事。判据是打开文件看它 import 什么、路径前缀从哪出发。
    这条与上面两条同源，合起来是一件事的三个面：**归因必须落在可复跑的证据上（HEAD 的 blob / 文件内容 / 当场重取的状态），不能落在情境上（时间相近、位置相邻、谁刚说过什么）**。
- **实现别在工作树里停留太久——长事务本身就是可被误伤的暴露面**（2026-08-14，与上一条配对的另一半，由被误伤的那个 session 提出）。这次事故里「我 `git add` 整个共享文档」是**直接**原因，但「对方的实现 + 它的 backlog 销账在工作树里放了很久」是让那个窗口存在的原因。两条纪律性质不同、缺一不可：只有前者，遇到下一个不看 `git status` 的写入方照样中招；只有后者，长事务照样留窗口。**定式**：把「实现 + 它的文档销账」攒成同一个 commit 再离开编辑态，别让文档先落、代码后落。
- **接到跨 session 关于远端状态的断言，先自己 `git fetch` 核一遍再据此决策**（同一天，双向各救了一次）。我把「已 push」当成既成事实通报出去，实际那次 push **根本没执行**（动作排在门禁之后，我却按已完成叙述）；对方两次 fetch 才发现不对。反过来他们的转述也被独立复核纠正过一次。**判据**：凡涉及「远端有什么」的话，说之前先 `git rev-parse origin/main`，听之后先 `git fetch && git merge-base --is-ancestor <sha> origin/main`。这条与「推理出错」不同——它是把没做的事报告成做了，对协作方的伤害是让他们基于一个不存在的状态决策。
- **别用「我没写过所以是别人的」做归属排除法——「别人」可能不止一个**（同一天，我连续两次判错）。先 `ListAgents` 看清本机到底有几个 session：这次是三个（我 / 4f / 88），我却按两个在推理，于是把 88 的东西两次判给了 4f。共享工作树 + 共用 git identity 的组合下，排除法失效，只能靠改动内容与时间线正面认领。
- **归属只能靠内容，不能靠情境——`git log --format='%an'` 在本仓零区分度**（2026-08-19/20，一天之内同一形态**四次**，方向各异）。本仓所有 session 共用 `WangBinquan` 这一个 author 身份，所以"作者是谁"根本不是判据；`--format='%an'` 看起来像证据，其实是常量。今天四例，每一例都是拿情境当证据：
  - 我按 **commit 相邻性**把 webkit e2e 的红归给刚落的虚拟化改动（真因是滚动哨兵与 tail 按钮抢同一份状态，与相邻无关）;
  - 并发 session 按 **commit 相邻性**把 nightly 的红归错（`event=schedule` 的 nightly 本就不可按 commit 归因，本文件另有一条）;
  - 我按 **grep 到编号**判定某 RFC 的索引行已上主干——命中的其实是**我自己**写在别处正文里的那句「未提交 RFC-3xx WIP 不计 landed」（互相引用编号的索引文件里，`grep <编号>` 天然假阳性，必须用**唯一的路径 slug** 或 `git show HEAD:file | diff - localfile`）;
  - 我按 **commit message 的第一人称**（「我自己把它钉失效了」）+「对方跟我讲过这个话题」两下一凑，把一笔 commit 判给了并发 session——它其实是第三个 session 的。
  - **可用的只有两样**：commit 的**内容**（改了哪些文件、符号首次出现在哪——`git log -S <符号> --reverse` 很硬），或者**直接问当事人**。`ListAgents` 先看清本机有几个 session；"我没写过所以是他"在三方以上必然失效。
  - **代价不对称**：归属判错不只是记错账——它会让被误指的人去查一段根本不存在的因果，而真作者不知道自己该修。所以宁可说"我还没定位到归属"，也不要给一个似然归属。
- **不要对 `docs/` 跑 `prettier --write`**：门禁的 format 面只覆盖 `packages/**/*.{ts,tsx,json,md}`，`docs/` 不在其中。对它跑格式化会把**他人未提交段落**整体重新折行，制造一大片与内容无关的 diff，还会掩盖真正的改动。
- **中文排版一致性（全半角标点、中英文间距）没有任何自动化保障——`prettier` 覆盖与否都一样**，它不把半角逗号改成全角，中英文标点混用不在它职责内。所以**别指望把 `docs/**` 加进 format glob 来解决**（2026-08-15 并发 session 复核纠正：原先的写法会让下一个人去改 prettier 配置然后发现没用）。这类问题**门禁全绿、行为零影响、复制粘贴也不报错**，是最容易被作者与复核方双方默契跳过的一类——只能靠人复核。实撞：本轮两笔文档新增 13 行里，代码块外紧跟中文的半角标点 **39 处\*\*（逗号 34 + 冒号 5），全角 0 处，作者整轮无自觉。
  - **要批量修就按反引号切段、只改代码块外**，且只改紧跟中文字符之后的半角标点。全文件 `sed` 会把 `STUB_INTENT_DELAY_MS: '900'` / `gh api "…"` 里的半角一起转掉，**从观感问题升级成「照着抄必然报错」的真 bug，而全角冒号肉眼几乎看不出来**。改完专门校验几处代码块原样保留。

- **别 stash 别人的目录——要在远端头上做一笔干净提交，就开分离 worktree**（2026-08-14 实撞，同一天同一棵树的第三次同族事故）。我为了把一笔修复做在 `origin/main` 头上，`git stash push -- <他人的 RFC 目录>` 再 pop，结果**吞掉了对方正在改的 261 行**（一整轮设计门的修复），而我判成「与已提交内容重合」。判错的两步都值得记：
  ① `git stash show --stat` 显示 261 行时我仍判成「重合」——**看了规模还判错**，所以「先看 `--stat`」这条不够；
  ② `git stash pop` 打印了 **`The stash entry is kept in case you need it again`** ——那句就是「没干净应用」的信号，我当噪音略过了。此时工作树里的「无差异」**不代表内容在**，而代表**内容还在 stash 里没出来**。
  **定式**：需要在别的 base 上做提交时，`git worktree add --detach <tmp> <base>`，在那儿改、提交、推，主树一根手指都不碰。真要 stash，只 stash **你自己**的路径；pop 后必须确认没有 "entry is kept"，并抽查对方文件的关键词还在。
- **三次事故的共同点：「我只动了自己的东西」这个直觉在共享树上不成立**——无论**读**（判归属：只 stash 自己认得的文件去做对照，结论是错的）、**写**（`git add <path>` 带走同一文件里他人的 hunk）、还是**挪**（stash 他人目录吞掉在改的工作）。三条防线各自都有漏，只有「自己的工作要么立刻整体进暂存区、要么根本别落到共享树」能同时堵住。
- **本仓多个 session 常共用同一个 git identity**，`git log --author` / commit trailer **无法**区分归属；只能靠改动内容与时间线。判别人的锅之前先 `git show <sha> --stat` 看它到底动了哪些文件。

- **共享树里 `git add <自己路径>` 之后不能裸 `git commit`**——不带 pathspec 的 commit 提交的是**整个 index**,他人已暂存（`git status` 里 `D `/`M ` 首列有字母）的改动会连坐进你的 commit。2026-08-06 真实发生：sibling 暂存的 **12 个 RFC-255 文件删除**（-2901 行）被卷进一个探测修复 commit，靠秒级 `git reset --soft HEAD~1` 挽回。定式：多人树上**一律 `git commit -m … -- <路径列表>`**（pathspec commit 只取列出的路径，他人暂存原样留在 index）；已经卷入且 HEAD 还没被别人接上时，`reset --soft` + pathspec 重提；commit 后**必看 `git show --stat HEAD` 的文件数**是否等于自己的路径数。
  **但 pathspec 只解决"别的文件"，解决不了"同一文件里别人的行"**——pathspec commit 提交的是列出路径的**工作树内容**：你编辑过的文件若同时躺着他人未提交的编辑（跨文件重构的半截，如删掉 types.ts 里的字段而消费方还没一起提交），会原样进你的 commit 并把 main 推红（同日第二口坑：`ListModelsOpts` 两个 RFC-255 字段被卷走，5 处 TS 错、已推送才发现）。定式：提交共享热点文件前 `git diff HEAD -- <file>` **逐 hunk 认领**，认不出来源的 hunk 一律先问；隔离 worktree 的 typecheck 若红在**别人姓名空间**（RFC-NNN 字段/文件），第一怀疑对象就是自己 commit 捕获了半截并行重构，而不是"别人本来就红"。
  **这条同样适用于 `design/plan.md` / `STATE.md` 这类共享索引**，且症状更隐蔽——2026-08-07 一次 RFC-263 提交同时卷走三处并发 RFC-264 半截：①`TriggersPanel.tsx` 里的 `buildResourceOptionLabels` 调用（定义文件没跟着走 ⇒ TS2724 连锁打红 frontend/backend/e2e 全部 job）；②同文件里 `targetLabels.get(id) ?? name` 一行（rfc223 身份守卫多出一条未登记 finding）；③`design/plan.md` 的 RFC-264 索引条目（其 `design/RFC-264-*/` 目录仍未提交 ⇒ **Markdown link check (design/) 死链红**）。**索引文件天然是所有并发 RFC 的交汇点，一个人写条目、一个人写目录，落档与提交之间必有窗口**。定式：提交 `design/plan.md` / `STATE.md` 前一律 `git diff HEAD -- <file>` 看清每一条条目是不是自己的；已经卷入且 HEAD 被别人接上、无法 `reset --soft` 时，按 `4931ea6d` 先例做**只在 index 里的回退**（`git hash-object -w` + `git update-index --cacheinfo` + **不带 pathspec 的** `git commit`），工作树里他们的副本一个字符都别动。
  **但 index-only 定式本身在并发 session 下不安全（2026-08-08 实撞）**：`.git/index` 是**仓库级共享状态**，不是你这个 session 的私有暂存。`git update-index` 与随后那条 `git commit` 之间的窗口里，另一个 session 只要跑了自己的 `git add` + `git commit`，**提交下去的是你放进 index 的 blob**——实测结果是对方的 commit（`ef756e9e`）带走了我构造的 STATE.md 版本，把**他们自己**刚写的 RFC-271「进行中」条目挤掉了，而我的 `git commit` 只看到 "no changes added to commit"。两边都以为自己提交成功，实际各丢一半（对方随后靠 `aa035f9c` 手工补回）。所以：**把 hash-object/update-index 与 commit 视为必须原子的一对**，中间不要插入任何耗时命令（尤其别在中间跑测试或网络调用）；做完立刻 `git log -1` + `git show HEAD:<file> | grep` **双向**验证（自己的行进去了没、别人的行有没有被自己挤掉），别只看 `git status` 干净就当成功。共享索引文件宁可用「先 `git pull --rebase`、再直接编辑、再普通 `git add`」的短窗口路径，index-only 只留给真正无法 `reset --soft` 的补救场景。
  **反向同样成立：你写到一半的代码会被别人的 commit 带走，且后果是「main 上出现一个自己不自洽的 commit」**（2026-08-12 实撞，RFC-291 批② × RFC-284 批 B/T7）。当时 RFC-291 的面 C 刚改完 `dumpBuilder.ts` + `turnEngine.ts`、参数定义所在的 `intentDoc.ts` 还没写完，并发 session 的 `git add` 精确列了自己的路径**却仍然命中这两个文件**（它那批 hash 收口正好也改它们），于是 `turnEngine.ts` 里的 `unavailableMountNote:` 传参进了对方 commit，而定义它的 `IntentDocInput` 字段留在工作树——该 commit 单独 checkout 必 typecheck 红。**这类红不会在提交者的门禁里出现**（他在自己的 worktree 里 cp 的是「当时的工作树」，半成品是自洽的那一份），只有别人 checkout 那个 sha 才会炸。定式：①**编辑共享热点文件时把「能编译的最小单元」尽快落一个 commit**，别让「定义在 A、消费在 B」的中间态在工作树里过夜；②发现自己的半成品被带走时，第一动作是看**对方推了没**——没推就立刻 SendMessage 请对方持住、自己补齐使 HEAD 自洽后再推（CI 只跑 HEAD，不单独跑中间 commit，这样就不会红）；推了也不必 revert，紧随一个补齐 commit 即可；③**不要去 rebase 或改写别人的 commit** 来「摘回」自己的代码。

- **「只 `git add` 自己确实改过的文件」不构成防线——他人的 hunk 可能就住在**同一个文件**里**（2026-08-14 实撞，与上一条同族但防线不同）。上一条讲的是「对方 add 自己的路径却正好也改了那两个文件」；这次的形态更隐蔽：我按纪律**只列了自己碰过的三个路径**，其中 `cli/start.ts` 是我为了加一行计时日志而合法编辑的，而队友未提交的 `retryRepoPrep` 调用**恰好也在这个文件里** ⇒ `git add packages/backend/src/cli/start.ts` 把它一并暂存推走。它配套的 `autoResume.ts`（字段定义那一半）不在我的路径列表里，于是 **main 上出现「调用方用了 `retryRepoPrep`、类型里没有这个字段」的 TS2353**，quality 车道全红、挡住所有人。
  **两个额外的坑**：①`git log -S <符号>` 会把它**归属给携带者**（这里指向我的 commit），而那两行不是我写的——排查归属时别停在这一步；②`git diff <file>`（工作区 vs index）在 add 之后是**空的**，看不出你刚刚暂存了什么，必须看 `git diff --staged`。
  **定式**：共享树上 `git add` 之后、`commit` 之前，**一律 `git diff --staged` 逐 hunk 扫一遍**，确认每个 hunk 都是自己的；文件里混了他人改动时用 `git add -p` 只挑自己的 hunk。判据比「看文件列表」硬：`git diff --cached --stat` 的**行数**应当与你自己的改动量对得上，对不上就说明带了别人的。
  **善后姿势（实测有效）**：发现自己带走了他人半截时，**别手工 revert 那几行**——那会把 main 推进「字段在、消费者不在」这种可构建但语义更误导的中间态。正确动作是立刻 SendMessage 告知对方「main 因此红了、缺的那一半在你手上」，由**对方把完整的另一半推上来**补齐（本次即如此收场：对方门禁绿后推 `3030d36e`，main 自动恢复）。

- **跨文件的改动别让它在共享工作树里裸奔——要么一起进暂存区，要么先别落到工作树**（2026-08-14 实撞，与上一条是同一次事故的两半）。上一条讲**写**的一侧：`git add <path>` 会带走该文件里所有人的改动。这一条讲**留**的一侧：我把一个跨 `cli/start.ts`（调用方）与 `services/autoResume.ts`（新字段）的改动在工作树里放了十几分钟才提交，于是同事那次 `git add cli/start.ts` 只带走了半截——main 上出现「调用方用了 `retryRepoPrep`，而选项类型里没有这个字段」，**typecheck 红、所有人被挡**。两条纪律缺一不可：只有写侧那条，遇到下一个不复核暂存区的人仍会中招；只有留侧那条，长事务照样存在窗口。**定式**：改动一旦跨文件，改完立刻 `git add` 全部相关文件（哪怕还不提交），或者干脆在分离 worktree 里改完再整体搬过来。
  **善后姿势**：被带走半截时**不要**手工 revert 对方 commit 里属于你的那几行——那会造出「字段在、消费者不在」或反过来的更误导状态。正解是你把完整的那一笔推上去，缺口自然闭合。
- **`gh api` 的 `head_sha` 只认全 SHA，短 SHA 返回空集而不是报错**（同日两次实撞）：`?head_sha=3030d36e` 的 jq 取值是字面 `null`，于是轮询脚本里 `[ -z "$S" ]` 那种兜底判断**永不触发**，看上去在正常轮询、实际一直在查一个不存在的 commit。**定式**：一律 `$(git rev-parse <ref>)` 取全 SHA；轮询的成功判据写成 `case "$S" in completed*)`，别用「非空」。
- **`gate:local` 跑在被并发 session 实时写入的工作树上 ⇒ 红得像 flaky，且不可归属**（2026-08-09 实测）。现场：本轮改动只有**一个前端测试 + 一份 md**，`gate:local` 却报 backend 3/4 分片红 + quality 两条红，其中包括 `RFC-223 T15 指纹棘轮` 与提交者本人刚写的 AC-12 fence 用例；十分钟后**单跑这些文件全绿**，因为并发 session 那时已经把那批文件写完了。原因很直白：门禁跑满 10 分钟，而另一个 session 在这 10 分钟里持续保存 `services/bundle/*.ts`、`resourcePackage/*.ts`——**门禁读到的是一个跨文件重构写到一半的快照**（`refs.ts` 已引新符号、`bundle.ts` 还没导出，诸如此类）。
  **危害在归属**：这种红与真 flaky **观测完全一样**（重跑就过），于是极易被当噪音略过，而仓规明令「绝不允许『重跑就过了』作为通过依据」——一旦养成重跑习惯，真回归也会被同一个动作放过。
  **定式**：共享树上做完改动要过门禁时，别在主工作树跑，改用 **pin 到自己 commit 的分离 worktree**（与 Codex review 那条同一个理由、同一个姿势）：`git worktree add --detach <wt> <yoursha>` → 把自己**尚未提交**的文件 `cp` 进去 → `bun install --frozen-lockfile` → 在 wt 里跑 `gate:local`。这样门禁看到的是「干净 HEAD + 只有你的改动」，红了就一定是你的。
  **判别（来不及重跑时）**：先 `git status --porcelain` 看有没有你没动过的 ` M` 文件，再 `ls -lT` 看它们的 mtime 是不是落在门禁运行窗口内——是，就基本可以判定为并发写入窗口，**但仍要在干净 worktree 复跑确认**，不能就此放行。
  **边界补充（2026-08-15，RFC-304 T19）**：定式说「把自己**尚未提交**的文件 `cp` 进去」，但没说**这些文件可能已经不纯**——若某个文件同时被并发 session 改过，你 cp 的是**混合体**。现场：把 `i18n/{zh-CN,en-US}.ts` cp 进隔离树时一并带进了对方的改动，它 import 一个我没 cp 的未追踪新文件，于是隔离树 `Cannot find module`，所有引用 i18n 的前端测试整片崩——**看起来像自己的改动炸了前端**。补依赖闭包也不行：拉进对方的 `shared/*.ts` 后 backend 四个消费方立刻红，**跨包重构无法部分拉取**。结论：**同一文件被并发改过时，自己那部分改动在对方提交前无法独立验证**——把它剥离出去（存 patch）、只提交能独立验证的部分，别为了「一起提交」而放弃可归属的门禁。

  **实证补强（2026-08-15，RFC-304 PR-2）**：上面那句「仍要复跑确认」不是形式主义——**并发红与自己的红会同时出现在同一次门禁里**。现场：主树 typecheck 报五条，前四条在 `auth/actor.ts`/`patStore.ts`/`cli/user.ts`/`apiDocs.ts`（并发 session 正在重构权限类型），mtime 也全落在门禁窗口内，两个判据都指向「并发噪音」；**而第五条是自己的**，被前四条淹没在按文件排序的输出里。在分离 worktree 复跑立刻暴露。另一半教训：那条错是**测试文件的类型错误**（`toContain(code)` 的 `code` 声明成 `string`，与字面量联合重载不匹配），而 `bun test` 对该文件 **17 pass 全绿**——它不做类型检查。**测试跑绿 ≠ 类型正确，测试文件同样要过 typecheck**。

- **并发 session 跑 Playwright ⇒ 仓根多出 `test-results/` ⇒ backend 的「工作目录泄漏」守卫把红扣到随机一条无辜测试头上**（2026-08-09 实测）。`packages/backend/tests/setup.ts:97-102` 在每条测试前后对比 **cwd（= 共享仓根）** 的目录条目，多出来就抛
  `Test leaked N entries into its working directory`。而 `test-results/` 是 Playwright 的输出目录、**被 `.gitignore` 覆盖**，所以 `git status --porcelain` 完全看不见它——上一条的「查没动过的 ` M` 文件」判别法在这里失效。实测一次 `gate:local` 里两条毫不相干的红（`worktree-files-service > listWorktreeDir 截断` 与 `rfc187-merge-salvage > mergeBackNodeIso 冲突 repo`）根因同一个：另一个 session 在那十几分钟里跑了 e2e。**识别特征**：①报错正文是 leak 守卫而不是业务断言；②泄漏条目名与被点名的测试毫无关系（`test-results` / `playwright-report` / `.last-run.json`）；③单跑该文件全绿。**定式**：先看报错里的**泄漏条目名**再谈归属——名字不属于你改的子系统就别去改那条测试；同期做 e2e 的 session 会持续复现，pin worktree 跑门禁可彻底规避（worktree 有自己的 cwd）。

- **全部工作直接在 `main`**，不开分支/PR；push main 即触发 CI。
- **提交只用一步 `git commit -- <精确路径>`**，别 `git add` 后再 commit——并发 session 的 commit 会把你 staged 的卷进它（2026-06-24 事故；2026-08-06 复犯：webhook 模板变量 chips 的 10 文件 add 后隔了几轮工具调用才 commit，被 RFC-254 session 的 `6a771fdb` 整体卷走，message 未及该功能——add 与 commit 之间任何 await 都是暴露窗口，untracked 先 add 后**立刻**同一条命令串里 commit）。untracked 新文件须先 `git add <精确路径>`，用**显式正向清单**（污染大时别 `git add packages/`）。
- **绝不 `git commit --amend`**：HEAD 可能已是并发 session 的 commit，amend 会重写他们的（defd9958 覆 94436c9f）。后续=新 pathspec commit；恢复=reflog + `reset --soft`（非 `--hard`）。
- **绝不删他人的行/文件/未追踪文件**即便在破 CI；停下先问。`git checkout --` 回滚只对 tracked 有效，且会连带丢本 session 对该 tracked 文件的未提交改动。
- **pathspec commit 后自验**：`git show HEAD:<file> | grep <新符号>`——共享树竞态会让 i18n 值块/新键在提交时丢失，形成「本地绿 CI 红裸 key」。
- **共享树迁移号冲突**：并发 session 各加 `migrations/`，号会撞。`_journal.json` 必须接在**已提交**的最后一条之后连续。他人的迁移未提交时，你排不了下一号——等他提交，或另立时把自己的暂存进 `design/RFC-XXX/deferred-*/`（RFC-223 与 RFC-225 撞 0114 的处理）。
- **共享树 RFC 编号也会撞**（与迁移号同族）：并发 session 各自 `design/RFC-NNN-*/` 落档，号会重。2026-08-07 实例：RFC-263 落档时另一 session 同日占走 264，而 263 的 proposal 已把拆出去的后续工作写成「另立 RFC-264」——写的时候 `design/plan.md` 索引里还没有 264 那行（对方先建目录后写索引）。定式：分配号前 `ls -d design/RFC-2*/` 看**磁盘**，不能只信 `plan.md` 索引；**引用尚未落档的未来 RFC 时不写具体号**（写「另立独立 RFC」），非写不可就落档前再 `ls` 一次并在文里注明跳号原因。
- **双引号 `git commit -m` / `gh --body` 里的 backtick / `$()` / `&&` 会命令替换**并静默改坏消息；用单引号 heredoc + `-F`。
- **协作者 commit gate 会 `git stash -u`**：未提交工作中途「消失」时 `git stash apply`（含 untracked）恢复。
- **混合文件提交前查交叉依赖**：`git commit -- <混了他人 hunk 的文件>` 前，确认并发 hunk 不引用**其他未提交文件**的符号、且无 HEAD 测试锁了旧接线；写完测试后重跑 `typecheck`（`bun test` 跳 tsc，RFC-161 事故）。
- **子代理完成通知非终态**：子代理可能继续推翻出 v2；`git add` 它的文件前必查 untracked import，否则提交半截（`87ac52d3` 事故）。
- **`design/` 与 `STATE.md` 在 prettier 作用域外**：在那跑 `prettier --write` 会 reflow 他人表格行、坏 markdown 转义（`next_run_at`→`next*run_at`）、剥掉 blockquote 续行的 `> `；**只手改**。实测代价：一次顺手格式化把 `design/plan.md` 整张 RFC 索引表重排成 ~500 行 diff（全是别人 RFC 的行）（RFC-247 复犯）。改完 `git diff --stat` 对一眼行数是否与改动量相称。

- **zsh 不对未加引号的变量做分词**：`P="a.ts b.ts"; git commit -- $P` 会把整串当**一个** pathspec，报 `did not match any files`（bash 下反而"能用"，于是这类脚本在两个 shell 间行为不一致）。本仓强制按路径精确提交，路径一多就用 `git add --pathspec-from-file=<file>` / `git commit --pathspec-from-file=<file>`，一行一条，彻底绕开分词。**另注意**：`git add --pathspec-from-file` 对**已删除**的路径会失败（磁盘上没有该文件）——删除由 `git rm` 暂存即可，`git commit --pathspec-from-file` 认得它。

- **`git pull --rebase` 会重放别人「已 commit 但未 push」的本地提交，把它们的 sha 换掉**（2026-08-12 实测）：共享 checkout 上 `main` 是**所有人共用的一条本地分支**，别人 commit 完还没来得及 push 的那几分钟里，你一个 pull --rebase 就把它的 commit 重放到新 base 上——内容逐字节不变，但 **sha 变了**。后果有两层：①对方按旧 sha 挂的 exact-SHA CI 看护、pin worktree、`git show <sha>` 全部指向一个不再位于 main 上的对象；②你若紧接着 `git worktree add --detach <新HEAD>` 跑门禁，**pin 的 base 是一个远端还不存在的 sha**，门禁结论在别人看来无法复现（实测：一次批次的 pin base 有几分钟处于未发布态，直到原作者补推才闭合）。定式：pull --rebase 之后先 `git log --oneline @{u}..HEAD` 看清「本地领先的这些 commit 里有几条不是我的」，有别人的就**立刻知会对方 sha 已变**，并让对方决定由谁推；自己起 pin 门禁前确认 base 已在远端（`git branch -r --contains <sha>` 非空）。
- **pin 门禁的「Export not found」/ 别人姓名空间的 TS 红 = 夹带检测器，第一动作是对账、不是修 import**（2026-08-12 二撞，RFC-284 批 D/E × RFC-292）：收口/横切批次天然横穿并发热点（daemonCadence 一行改动散布 10 文件，`fusion.ts`/`orphanReconcile.ts` 正被并发 RFC 改写），pathspec add 前没逐 hunk 认领，把对方引用尚未提交符号的半截卷进 commit——钉住 worktree 门禁 daemon 模块加载即「Export not found」红，**在推送前**抓住（对比第一撞是上了 main 才由 CI 抓）。pin 门禁的第二用途就是反向抓「我卷走了别人的半截」。**修复定式（限 HEAD 是自己未推送的 commit，先 `git log -1` 验明）**：以父版本为底手术重建该文件（`git show <sha>^:<file>` + 只重放自己的行）→ `git commit --amend`（此场景不违反「绝不 amend」——那条禁令针对『HEAD 可能是别人的』，且注意上一条：amend 期间别人一个 pull --rebase 仍可能先把你的旧 sha 重放走）→ 对方 hunks 原样放回工作树不提交。动作化：凡收口/横切批次，开工第一步 `git status --porcelain` 列热点面；add 前对每个已列文件 `git diff HEAD -- <file>` 逐 hunk 认领——「我只改了一行」的文件恰恰最可能藏别人的 hunks。

- **同一物理 checkout 跑两个并发 session 时，`git add <整个文件>` 会把对方在该文件里的「半截改动」连同你的提交推上 main——而且本地一切全绿、只有 CI 炸**（2026-08-18 RFC-311 PR-1 实撞）：我提交 `cli/start.ts`（只想带自己的 openDb 参数）时，文件里还有并发 RFC-310 session 加的 `import { buildDevelopmentMrFactsDeps }`，其**导出**还在对方工作树没提交。本地 typecheck / gate 全绿（工作树里导出存在），CI 的单二进制 build 直接 `No matching export` 红。同日对方也以同样方式让 `user-permissions` 前端测试红（权限目录改了一半）。**判据**：本地绿 + CI 在你没改过的链路上红 ⇒ 第一嫌疑是「共享树半截依赖」，`git show HEAD:<file> | grep <符号>` 对比工作树即可实锤。**定式**：提交前对每个要 add 的**代码**文件跑 `git diff HEAD -- <file>` 逐 hunk 认领（共享索引文件的既有定式同样适用于代码文件）；发现对方 hunk 时优先等对方提交或只挑自己的 hunk（`git add -p`）。
- **`bun run gate:local` 的 format/lint 车道存在缓存性漏报，收口不能只信它**（2026-08-18 两连撞）：PR-1 的 gate 全绿，CI 的 `prettier --check` 却红了 5 个文件；补完格式后下一轮 CI 又红出 gate 没报的 `no-unused-vars`。两次都是「gate 期间文件处于被本地格式化钩子/缓存遮蔽的状态」。**定式**：push 前对**本次改动的文件清单**显式跑一遍 `bunx prettier --check <files>` 和 `bunx eslint <files> --max-warnings 0`，几秒钟，能挡住这两类「本地绿 CI 红」。

## 新增配置键（RFC-313 实测，2026-08-20）

- **`ConfigSchema` 是全必填**。新增一个 required-with-default 的键时，**存量
  `~/.agent-workflow/config.json` 里没有它**——之所以升级后 daemon 仍能启动，靠的是
  `config/index.ts` 的 `mergeDefaults(raw)` 在 `safeParse` **之前**回填 `DEFAULT_CONFIG`。
  这条顺序是所有升级用户的启动前提，改动它等于让全体升级者的 daemon 拒启动。加键时
  一并补两样：①`packages/shared/tests/fixtures/config-versions/*.json` 两个 fixture
  （否则 `compat-config-versions` 立刻红）；②一条**直接构造缺该键的存量文件**、断言
  回填生效的用例（fixture 补齐后就不再覆盖这条性质了，别让它裸奔）。
- 别忘了 `packages/frontend/src/lib/settings-drafts.ts` 的**最小写入白名单**：漏登记的键
  在保存时被静默丢掉——表单看着改了、点了保存、零报错，值没落盘。
- **两个相乘的旋钮要各自算总账**。RFC-313 的 attempt 上限是
  `(1+defaultNodeRetries)×(1+sessionRestartBudget)`：两项边界（50 / 10）单看都不离谱，
  乘起来 561，会撞上 `schedulerAssembly.ts` 的 `ASSEMBLY_MAX_ATTEMPTS=100` 保险丝——
  而那条保险丝的报错写的是「spec bug」，用它去接住一个**配置选择**只会把运维引到
  错误方向排查。正解是让导出上限的函数**自钳**到一个显著低于保险丝的天花板，使保险丝
  在任何配置组合下不可达，并用一条测试锁住两个常量的大小关系。

## 迁移（Drizzle + bun:sqlite）

- **SQLite 的 partial index「蕴含判断」不认 `col = 'x'` ⊂ `col IN ('x','y')`**（2026-08-18 RFC-311 实测）：给 `node_runs` 建 `WHERE status IN ('pending','running')` 的 partial 索引后，`WHERE status = 'running'` 的查询**不会**用它（EXPLAIN 仍 SCAN）——SQLite 只认查询谓词与索引 WHERE **字面等价**或非常有限的蕴含形式。partial 索引想被命中，查询侧谓词要与索引 WHERE 写成同一字面（`= 'pending'` 对 `WHERE decision='pending'` ✓）；谓词形态多样的列（等值/IN 混用）老实建普通复合索引。每个新索引配一条 `EXPLAIN QUERY PLAN` 断言（`rfc311-perf-foundation.test.ts` 模式，先例 `migration-0128-…`），别靠肉眼确信。

- **性能改动的验收必须在有量级的库上跑「整轮墙钟」——单测能证明没改坏语义，证明不了没改坏代价**（2026-08-19 RFC-311 G3 实测）：给归档器的增量扫描按 id 分窗，本意是把一条 1190ms 的 `GROUP BY`（10M 事件库、单连接同步 daemon ⇒ 整站冻结这么久）拆成短语句。单条确实降到 76ms、6 条单测全绿——**但整轮从 6 秒劣化到 260 秒（43×）**。根因是同一个 `node_run` 会横跨多个窗口，而循环里对每个候选都发一条「问总量」的 count，分窗把这件事重复了几十倍；小库上重复几十次仍是毫秒，**单测永远照不出来**。
  - 判据：凡是**改变语句条数或循环结构**的性能改动（分窗 / 分批 / 拆语句 / 加缓存层），代价函数可能从 O(1) 变成 O(窗口数)。看的是**整轮墙钟**，不是单条语句时长——「单条变短」这个直觉在这里是错的。
  - 正解形状（本例）：每窗只取**候选集**（`SELECT DISTINCT`），总量用分块的**一条**分组语句问完，再加一条「一轮最多考察多少候选」的预算。改完整轮 6.1 秒、全轮只剩 1 条超阈值语句。
  - 复跑入口在 `design/RFC-311-*/bench-results.md` §复跑清单（`perf-seed.ts` 93 秒建库 + `perf-bench.ts --only`）。**基准数字进文档时必须标注「在多大规模的库上、什么时候测的」**——否则半年后有人拿它当现状会误判。
- **keyset 分页的断点必须写成行值比较 `(a, id) < (?, ?)`,不能写展开式 `a < ? OR (a = ? AND id < ?)`**（2026-08-18 RFC-311 十万任务基准库实测）：展开式在**绑定参数**下让 SQLite 选 `MULTI-INDEX OR` 并回落 `USE TEMP B-TREE FOR ORDER BY`——把全部候选行物化排序一遍（实测 `/api/tasks/page` 首页 30ms、翻页 **197ms**；改行值后 41ms）。**最阴的地方:用字面量跑 `EXPLAIN QUERY PLAN` 复现不出来**——字面量下 SQLite 反而选对索引走有序 seek,只有把常量换成 `?` 占位符才看得到 MULTI-INDEX OR + TEMP B-TREE。定式:①断点一律行值形式;②plan 断言**必须用 `?` 占位符**写(先例 `rfc311-task-page-fastpath.test.ts` 的「no TEMP B-TREE」条),另配一条源码层守卫防止有人改回展开式;③排序键与索引列序、DESC/ASC 要对齐,否则同样落临时 B 树。
- **`when` 接合成轴**（上条 +86400000），别用真实 `Date.now()`——否则 drizzle 对既有安装静默跳过，之后每查 `no such column`，从零建库看不见。
- **手写多语句要 `--> statement-breakpoint`**（精确这个字面量，仓库迁移器只认它），否则只应用第一条。
- **加迁移必 bump `upgrade-rolling.test.ts` 的 journal-count 锁**（N→N+1）；1 个本地 bun-test 红别当 flaky，先定位 `(fail)`。
- **已应用的迁移被追改，drizzle 永不重放** → daemon 健康但起任务 500 `no-such-column`；要补 ALTER 用**新迁移**别追改旧的、别删记账行。RFC-275 admission 上线后症状前移：`bun dev` 直接 `migration-history-preflight … hash differs (<库里> != <文件>)` 拒启，vite 永远停在 `waiting for daemon to publish .daemon.info`。
  - **追改如果确实是「等价改写」，正解是补回执别名，不是回滚**（2026-09-02 实撞：0111 把 `json_group_array(x ORDER BY y)` 换成有序子查询，好让语句在 SQLite < 3.44 上也能解析）：字节一改，**所有既有库**（本机 dev + 生产）当场 `migration-history-preflight` 拒启，而 **CI 全绿**——CI 每次都从空库建链、永远拿不到旧回执，这类事故天生是 CI 盲区，只能靠人在 `bun dev` 上撞出来。补法四件套：①旧字节的 sha256 加进 `schemaAdmission.ts` 的 `LEGACY_MIGRATION_HASHES`；②`rfc278-legacy-schema-reconciliation.test.ts` 的 `LEDGER_SIZE` N→N+1（账本大小是显式锁，不改就红）；③旧字节原样存进 `tests/fixtures/shipped-migrations/<tag>.sql`，让「别名 == 旧字节的 sha256」可复核；④补一条「新旧两版落下同样的行」的等价断言——**这条才是允许别名存在的判据**，不等价就说明它不是改写，该老老实实走一条新的前向迁移。反过来，改迁移的人自己要记住：动已发布的 `.sql` 字节 = 必须同时交付这四件，否则你推的是一颗只在别人机器上炸的雷。
- **「追改」也包括开发期改自己那条还没提交的迁移——本机 dev DB 已经吃过草稿版**（2026-08-17，RFC-309 0174 实证）：草稿 0174 在真实 `~/.agent-workflow` 上跑过一次，随后作者修掉了「rebuild `code_findings` 时漏抄 0165 加的 4 列」再提交，于是本机既有**对不上的记账 hash**、又有**任何迁移链都产不出的物理表**（缺 `resolved_at`/`code_changed_at`/`resolved_round_id`/`code_changed_round_id`，且 cid 顺序偏移连带 `idx_code_findings_seen` 不一致）。**别急着重建库**（这类 dev home 往往攒着上百个 task / workflow）：①用 `schemaAdmission.ts` 的 `readExpectedMigrationChain` + `collectPhysicalSchemaManifest` + `diffPhysicalSchema`，把「migrations 目录裁到库里已应用的最后一条」replay 进 `:memory:` 再和真库对，先分清「只是 hash 错」还是「物理 schema 真的不同」；②物理有差就照**规范文件里那几条语句原样重放**（含 `__new_*` 建表 + RENAME，别自己手写 `ALTER ADD COLUMN`——admission 连 cid 顺序和 CREATE 文本都比）；③最后才把该条记账 hash 改成规范文件的 sha256（`LEGACY_MIGRATION_HASHES` 是给生产库历史字节的白名单，**不要**往里塞本机草稿 hash）；④动手前 `cp db.sqlite db.sqlite.bak-pre-<slug>-<ts>`。根因侧：带迁移的未定稿代码一律先 `AGENT_WORKFLOW_HOME=~/aw-<slug>` 跑（见下文 dev-env 条）。
  - **索引的创建顺序也在物理比对范围内**（2026-08-28，RFC-338 0216 实证）：`schemaAdmission.ts` 的 `collectPhysicalSchemaManifest` 把 `PRAGMA index_list` 的 `seq` 一并纳入 manifest，而 `seq` 反映的是建索引的先后。所以按上面②「原样重放缺失语句」补了两个索引、hash 也改对之后，`bun dev` 仍会在 `physical-schema` 阶段报**该表所有位置错位的索引** `differs`（文本一模一样的老索引也报，只有位置没变的那条不报）。处置：把该表除已在正确位置之外的索引全部 `DROP`，再**严格按规范文件里的语句顺序**重建。
- **加任何 `tasks` 列会破「冻结旧迁移」的测试**（drizzle INSERT emit 所有 HEAD 列 → `no column named …`）；fixture 用显式列 raw SQL 修。
- **推 `migrations/`/`_journal.json` 前跑完整 backend `bun test`**（不只迁移子集）——journal↔files 失配（含并发 orphan 条目）级联数千 DB 测试红而子集绿。
- **脚本改 `_journal.json`（python `json.dump` 等）产物不带末尾换行，CI Format 必红**（2026-08-18 RFC-311 0181 实撞）：prettier 的 push-前检查覆盖 `packages/**/*.json`。定式合并成一句：**加一条迁移 = 四件套**——`NNNN_*.sql` + journal 条目 + `upgrade-rolling.test.ts` 计数锁 N→N+1 + **对 journal 跑一次 prettier**；四件里漏任何一件都各有一个必红的门（journal↔files 失配 / bun-test 红 / Format 红）。
- **表达式唯一索引**（如 `COALESCE(owner,'')`,name）用 `PRAGMA index_list`/`index_xinfo`/`sqlite_master` 验证，**不能**用 `table_info`。
- **`file:…?immutable=1` 在 Linux 抛**（macOS 可）；checkpoint+close 后 `-wal/-shm` 仍在，plain `{readonly:true}` 足够。
- **跨平台的沙箱缺陷可以在本平台被确定性证伪/证实——只要 policy 是纯函数**（RFC-251 实证）：`services/sandbox/policy.ts` 的 `computeSandboxPolicy` / `renderBwrapArgs` 明确是 pure（no fs access），所以「Linux 上会生成什么 bwrap argv」在 macOS 上就能算出来。把 argv 按顺序还原成挂载表（`--tmpfs DEST` / `--bind SRC DEST` / `--ro-bind SRC DEST`，**最深的挂载点决定可见性**），就能对任意路径回答「在命名空间里看不看得见」。定式：**永远同时断言一个「应该可见」的对照路径**（如 `appHome/repos`），否则「全都不可见」的建模 bug 会伪装成真实缺陷。别因为「手上没有 Linux」就把这类问题降级成推断。
- **从闭集枚举里删一个值 ≠ 可以删——存量行还在，而严格 schema 会炸整页**（RFC-251 Codex 实现门 P1）：像 `failure_code` 这种「无迁移的普通 TEXT + 应用层 `z.enum`」列，删掉一个码之后，升级前写入该码的**任一**历史行都会让读取端 `.parse()` 失败；如果读取端是**整页/整列表**一次 parse（本仓 `useTaskOperationsPage.ts` 就是），后果是**整页打不开**，而不是那一行降级显示。定式：把**发射域**与**读取域**拆开——可产生的闭集里删掉，另立一个 `LEGACY_*` 只读常量并入解析用的 union，配套保留 i18n 文案（改成「历史失败」语气），并加一条「退役码不可产生但仍可解析」的回归锁。凡是「删枚举值」的改动都要先问：这个值有没有可能已经躺在用户的 DB 里？

## opencode / runtime

- **opencode 行为以本地源码为准、不靠记忆**：进程启动/CLI 参数/`OPENCODE_*`/退出码/agent·skill 加载顺序/输出 XML——遇到就 grep/read 本地 opencode（路径在贡献者本地）。
- **RFC / design 里对 opencode 行为的既有断言，接手时必须对当前源码复核一遍**（RFC-251 事故）：RFC-224 用三条 opencode 行为论断关掉了两个已完工功能（RFC-022 `dependsOn`、RFC-031 plugins）。半个月后按 v1.18.4 源码逐条核，**两条与源码不符、一条系误读**——①V2 插件路径遵守 `OPENCODE_PURE`（`plugin/index.ts:177`），②未知 subagent 直接 fail 而非静默回退默认 agent（`tool/task.ts:131-134`），③`bypassAgentCheck` 跳过的是**权限询问**而非身份校验（`:119-129`）。教训有三层：**(a)** 写进 design 的 opencode 断言会被后续 session 当既成事实继承，必须带 `file:line`，且接手时重新验证（上游会变，你的理解也可能一开始就错）；**(b)** 因外部行为而**关掉产品功能**的决定，判据必须是可复跑的源码引用，不能是"读下来觉得不安全"；**(c)** 那两条拒绝在后端**从来没有测试覆盖**（只有 shared 码表枚举），删掉它们时全套 backend 测试依然全绿——**禁用型分支和正向功能一样需要测试**，否则它是活是死都没人知道。**(d)** 以安全为由**关能力**时，能力影响清单必须作为 breaking change **呈用户逐项确认**，不能只在 design 里自我论证——RFC-224 静默切断了自定义 baseURL provider（生产部署全部 `execution-identity-auth-invalid`），11 天后用户生产炸机才被发现（→ RFC-255 受控恢复）；「哪些部署今天在用什么」不是评审员能替用户回答的问题（此条已升格为 `CLAUDE.md` RFC workflow 第 7 条硬规则）。
- **密封模型枚举 ≠ opencode 目录全集（RFC-255 实测，1.18.8）**：枚举跑在零凭据环境里（`OPENCODE_AUTH_CONTENT='{}'`），而目录 provider 必须经 env/auth 触发 `mergeProvider` 才会进 `providers`（`provider/provider.ts:1517-1541`）⇒ **输出只有免费档 `opencode/*` 七行**，anthropic / openai / azure 等一个都不出现。任何「拿枚举结果当 provider 全集」的判断（典型：校验用户自定义 id 是否与内置冲突）都因此**必然放行**内置 id。而 config 段与目录 id 同名不是新建 provider，是**把目录整体改指你的端点**（`:1583-1590` 合并 + `:1428/:1450` 继承 ⇒ 实测 18 个 anthropic 模型全挂到网关 url）。正解是**静态保留 id 快照 + canary 探针**（注入 `{provider:{<id>:{models:{__canary__:{}}}}}`，输出多于一个模型即说明存在目录继承）。
- **枚举/受控 config 的 `PATH` 只有 `/usr/bin:/bin`——测试桩别写 `node`**（RFC-255 实测）：`models.ts` 的密封 env 硬编码该 PATH，用 node 写的 stub 会以 `exit 127: node: command not found` 失败，且这**正是**真实 fork 二进制会遇到的约束。桩脚本用 `/bin/sh` + grep/sed 即可。
- **`OPENCODE_PURE=1` 会静默清空用户选中的插件**：`plugin/index.ts:177` 是 `flags.pure ? [] : (cfg.plugin_origins ?? [])`——发了 `config.plugin` 却仍带 PURE，结果是**没有报错、没有日志**，opencode 就是不加载。它与 `OPENCODE_DISABLE_DEFAULT_PLUGINS`（`:166`，只关内置 `internalPlugins`）是两个独立轴，别混。定式：这类"两个开关必须一致否则静默失效"的地方，让其中一个**从另一个派生**而不是分别传参（`buildHermeticServerEnv` 从受控 config 的 `plugin` 键推 PURE），再补一条显式断言。
- **拼 permission 记录时，平台强制规则必须「追加在末尾」，不能「就地覆盖」**（RFC-251 Codex 实现门 P1）：OpenCode 把 permission 对象按**键序**生成规则、再用 `findLast` 取最后匹配项（`permission/index.ts:28-34`）。而 JS 里**给已存在的键重新赋值不会移动它**——所以 `{...userPermission}` 之后再 `permission.task = 'deny'`，那条 deny 仍留在用户原来的位置；用户只要在后面写一个 `"*": "allow"`，`findLast` 就选中通配符，平台的 deny **形同虚设**。定式：先**丢弃**用户对平台管控键的覆盖（一张显式 key 集合），再把平台值 append 到末尾；用户其它键原样保留在前。判据测试要断言「受控键的下标 > 用户 `*` 的下标」，光比对最终值看不出这个 bug。
- **opencode 的 `external_directory` 只能按\*\*目录\*\*放行，放行不了单个文件**（RFC-281 业务误伤检视实测）：它的判定 pattern 是 `path.join(dirname(target), '*')`（`tool/external-directory.ts:28-33` @1.18.4），即读 `~/.gitconfig` 时拿去匹配的是 `$HOME/*`。所以往 permission 里写一条精确的 `"/Users/me/.gitconfig": "allow"` **永远匹配不上**（wire 里规则是对的，判定时用的 key 不是它）；要让它生效只能放行 `$HOME/*` —— 那等于把 `.ssh`、`.aws` 一起放行，代价不可接受。**推论**：任何「只放行某几个机器级配置文件」的需求在 opencode 侧做不到，只能整目录放行或不放行；本仓的选择是不放行（agent 读不到 `~/.gitconfig` 这类诊断配置，属已接受的误伤，见 `docs/OPENCODE_CONFIG.md` §6.1）。
- **跨层（顶层 config ↔ agent 条目）的键序不可控，平台规则必须落在「要约束的那个条目自己的 map」里**（RFC-281 T1 实测，1.18.16）：上一条讲的是同一个 map 内的键序，跨层是另一回事。实测两组相反结果——**M1** 顶层 `permission.external_directory:{"*":"deny"}` + agent 条目 `permission:{"*":"allow"}` ⇒ 条目的通配**溶解**顶层 deny（越界放行）；**M2** 顶层同 deny + 条目 `external_directory:{"<dir>/*":"allow"}` ⇒ 条目白名单**没生效**（仍被拒）。两者方向相反 ⇒ 合并后谁在前不可预测。定式：**要约束业务 agent，就把规则写进每个业务 agent 条目自己的 permission 里**（并按上一条追加到作者键之后）；顶层 `config.permission` 只用来覆盖**没有平台条目**的对象（opencode 原生 `general`/`explore` 子代理吃 defaults + 全局，够不着条目级注入）。
- **给工具发 `'allow'` 等于 pattern `*`——要限定目标就得发 pattern 映射**（同门 P1）：`task: 'allow'` 会让模型委派给**任意** `subagent_type`，而 opencode 的**内置** agent（`general`/`explore`/`build`/`plan`…）始终在注册表里、不受我们 config 控制，各自带默认的写/shell 面 ⇒ 一个自身禁了 bash 的 root 能借 `general` 拿回能力。正确形态是 `{ '*': 'deny', <每个允许的目标>: 'allow' }`（`*` 在前，具体名在后，靠 `findLast` 让具体名赢）。同理适用于任何「按名字挑目标」的工具权限。
- **子代理的最终 permission = `merge(agent.permission, session.permission)` 且 `findLast` 后者赢**（`session/llm.ts:149-151`，`Permission.merge` 就是 `flat()`）。`agent/subagent-permissions.ts:21-23` 会把**父 session** 的 deny 规则（外加 `external_directory`）并进子 session。**注意区分两个 permission 面**：平台那条长长的工具 deny 尾巴（read/edit/write/grep/glob/…）在**受控配置的 agent 条目**里，而**不在 session 上**——平台建 session 只传 `ROOT_SESSION_PERMISSION_RULES` 三条（`question`/`plan_enter`/`plan_exit` 全 deny，`directApiSchemas.ts:73-77`）。所以继承下去的只有这三条无害 deny，子代理条目自带的 `bash: allow` 等仍然生效。推论有二：①子代理条目**必须自带完整 permission**（它不从父 agent 条目继承任何东西，什么都不声明就什么都没有）；②**若哪天往 root session permission 里加工具级 deny，会连坐所有子代理**，且表现为「模型干不动活」而非报错——要加只能加在 agent 条目上。
- **OpenCode 的 SSE 工具快照是单行 JSON，line budget 不能小于 event budget**：`message.part.updated` 会在 completed tool state 里重复输出和 metadata，读一个被 shell 截断的大文件就能产生约 76 KiB 的合法单行事件。若 parser 默认 `maxLineBytes=64 KiB`、但 `maxEventBytes=1 MiB`，实际效果是更小的隐藏硬上限：Agent 第一轮工具调用成功、第二轮前稳定报 `execution-identity-stream-failed`，进程重试也无法自愈。默认 line/event/buffer 三个 ceiling 要相容；自定义小预算仍可用于拒绝/单测。
- **verified business plan 的 `PATH` 是能力白名单，不是 daemon `PATH` 的继承品**：只写 `/usr/bin:/bin` 会让 Agent 里的 `bun test` 在已安装 Bun 的机器上仍报 `bun: command not found`。需要 Bun 时，从 daemon 实际解析到的 binary 做 bytes snapshot/freeze，再把 run-scoped seal 目录显式加入 model shell 与 local MCP 的同一份 `PATH` 和只读 bind；不能暴露用户 home 目录，也不能只修 shell 忘了 MCP。
- **run-scoped toolchain 绝对路径不是跨节点断言**：fanout 每个 Agent 都有独立 run id，因此 `/.../<node-run-id>/opencode-identity-seal/toolchain/bun` 只对本次进程有效。跨分片/重跑要比较 version、binary SHA-256、`toolchain/bun` 相对后缀与命令退出码；把另一个分片的绝对路径当当前路径会产生假失败。
- **inline `OPENCODE_CONFIG_CONTENT` 并非最高优先级**（本机 v1.18.4 实证）：其后仍合并 active-org/managed/MDM/`mode`/`OPENCODE_PERMISSION` 覆盖同名 agent；`disable`/`mode:subagent` 还能让 `--agent` 回退默认。CLAUDE.md「Resolved open questions」的旧断言错误，执行身份完整性见 **RFC-224**。
- **opencode 严格 yargs 拒 `-` 开头裸位置参** → prompt 必须放 `--` 之后（`buildCommand`）。
- **1.18 移除 `--dangerously-skip-permissions` 改 `--auto`**：按探测版本选拼写（`resolveAutoApproveFlag`）；失败形态=stderr 纯 usage + exit1；垃圾版本串须 `extractVersion` 归一化。
- **OpenCode 是可选 runtime，不是 daemon boot gate（RFC-226）**：启动不得解析/执行 `opencode --version`，`/health.opencodeVersion` 为 null；版本门后移到 runtime status/Test/models/doctor 与实际使用，不合格 runtime 自身失败，daemon/其它 runtime 继续可用。
- **改 opencode argv 契约要同步两类桩**：TS fixtures **和** 6 个 `e2e/fixtures/*.sh` shell 桩（golden 只覆 TS）。跨 spec `code 3`/<1s/首 agent-node 红 = 桩契约失配。
- **系统代理（非任务链）的 spawn 走统一装配**（RFC-282 更新；本条原文教的 `markProductionOpencodeCommand` / `legacyTestPath` / `rfc224-source-reachability.test.ts` 三者已被 RFC-276 删除）：新系统代理不要手搭 spawn——构造 `AgentSpawnContext`（persona-only = `injection: { mcps: [] }`、省略 `taskMounts`）调 `driver.buildAgentSpawn`，mock 二进制经 `binaryOverride`（数组头，presence 即关凭据桥）注入；对拍/示例见 `runtimeSmoke.ts` 与 `rfc282-b1a-unified-spawn-parity.test.ts`
- **macOS 下用 `mkdtemp(tmpdir())` 喂 `AGENT_WORKFLOW_HOME`/store 根会撞 verified 链路的反符号链接防线**：`/var`→`/private/var` 是符号链接，hermetic 布局的 `ensurePrivateDirectory` 逐级 lstat fail-closed（`execution-identity-store-unsafe`）。写真机/live 测试先 `realpath` 规范化（identity-preflight 套件的 `canonicalTmp` 即此意）；生产 `~/.agent-workflow` 无此问题。
- **VM 的 `C:\aw` 是非 git overlay，会陈旧，掩盖「当前代码」的 win32 bug**：真机验收把仓库 scp/同步进 `C:\aw`（非 git），若只同步改动文件，**新增文件（如 RFC-256 的 `machineConfig.ts`）不会自动到位**，于是 VM 上跑的其实是「你手上这份产品代码 + VM 上那份陈旧的其余文件」的混合体。RFC-254 T31 实例：早先「完整 verified plan 真机 5/5 pass」跑的是 VM 上**旧的 `verifiedPlan.ts`**（无 RFC-256 的 line-989），故没碰到 bug#4；是 x64 `windows-platform` CI 腿（**fresh `actions/checkout`**）才暴露 store-unsafe。判据/纪律：①**改到 verified 核心后，把牵连到的当前文件全 scp 到 VM**（连同其 import 的新文件），别信「VM 上那份」；②**`windows-platform` CI 腿（干净 checkout）才是 win32 的权威信号**，VM probe 是快速迭代/交互诊断用，不能替代 CI；③import 报 `Cannot find module './X'` 于 VM = VM 缺了新文件，先补齐再下结论；④**`git archive HEAD | tar -x` 只「增/覆盖」不「删」**——main 上被删除的文件（如 `CustomProviderCard.tsx` 被 RFC-256 revert 删掉）**仍残留在 VM overlay**，源码扫描类测试（AST 指纹 / 结构守卫）会把这个幽灵文件当现存源扫进去而假红；判据是「本地当前源 POSIX 跑绿、VM 红且红在一个本地 HEAD 已不存在的文件」⇒ 从 VM 删掉该幽灵文件（或整树重新 clone）再判。
- **Windows 上 `fs.constants.O_NOFOLLOW === undefined`（Bun 实测），`flags | undefined = flags`，故 O_NOFOLLOW 静默变 no-op**：任何 `openSync(p, O_RDONLY | O_NOFOLLOW)` 的「不跟随最终 symlink」防护在 win32 直接消失，靠它接 `ELOOP` 的 TOCTOU 兜底永不触发（`worktreeFileContent.ts:openContainedFile` 即此，task#12）。判据：凡以 O_NOFOLLOW 防 realpath-后-open 换链的地方，win32 需改用**句柄身份复核**（open 后 `fstat` 的 dev/ino 与 open 前 `lstat` 比对，`fileTrust.assertSameFileIdentityForHost`，RFC-254 T40a 令 win32 dev/ino 权威）补上。realpath containment 主闸不受影响（静态越界与 `..` 仍拦）。
- **Windows 上 `fs.realpathSync`（JS 版）不展开 8.3 短名，`realpathSync.native` 才展开**：`realpathSync('C:\\OPENCO~1\\VERYLO~1\\repo')` 原样返回短名（且 `resolve(p)===p` 为真，即「词法规范」），而 `realpathSync.native` 走 `GetFinalPathNameByHandle` 返回长名 `C:\\OpenCodeTemp\\verylongdirname12345\\repo`。**GitHub windows-latest 的 `os.tmpdir()` 正是 8.3 短名**（`C:\\Users\\RUNNER~1\\...`，用户名 `runneradmin`>8 字符）。后果：测试若 `mkdtemp(tmpdir())` 建仓、`git init` 用短名路径、再 `realpathSync` 拿「规范」路径去和 **git 输出**（`--git-common-dir` / `worktree list` 恒返回长名）比对，短↔长不一致会踩 `netlessProjection` 的 canonicality/containment 判定 → `execution-identity-source-changed`（本机 ARM64 tmpdir 非短名故绿、x64 runner 红——RFC-254 T31 windows-platform 腿实测，真机短名探针复现）。**定式**：凡测试要把 tmpdir 路径喂给「随后又被 git 读回」的逻辑，用 `realpathSync.native(mkdtempSync(...))` 统一到长名（`rfc254-verified-plan-win32.test.ts` 的 `longTemp`）。**生产免疫**：worktree 根出自 `os.homedir()`（长名）；但若未来 admin 把 appHome 配在短名目录下，`netlessProjection` 的 `realpath`（fs/promises 版，同样不展开短名）会和 git 长名输出打架——记 `docs/audit-backlog.md` 的纵深健壮性项。
- **对 opencode 内置资产钉「单一字节 digest」= 给自己埋版本炸弹**：`PINNED_BUILTIN_SKILL` 曾钉死内置 skill 正文 digest，opencode 1.18.8 重写该正文（name/description/location 逐字未变）→ 生产 `verifyPinnedSkillInventory` 对该版本**每次 verified 运行**都 `execution-identity-skill-mismatch`（夜跑 `opencode latest` 腿先于用户拦到）。与 RFC-227 版本中立冲突。正解：身份字段仍逐字精确，正文改为**已审阅发行版 digest 白名单**（未知正文仍 fail-closed，新增条目=人工 diff 过）。判据：`latest` 腿红而钉版腿绿 ⇒ 上游漂移，不是本次改动。
- **有界-spawn 定式**：`killProcessTree`（`process.kill(-pid)` 组杀）+ `detached:true` + 超时 SIGKILL + **finally 无条件组杀**（收 fork-then-exit 孙进程）+ 流式 capped reader（防 stderr 洪泛 OOM）。现 4+ 处（opencode/models/git/sandbox）= dedup 候选。
- **沙箱边界规则一旦有第二份副本，必然漂移成漏洞**：RFC-242 T5 在 claude 侧私抄了一份 opencode 的 git 投影，漏掉三道检查里的全部三道，结果是**可写 allow-back 逃逸**（下一条）。写第二个运行时的同类逻辑时，默认动作是**提取共用模块**、把两边语义差做成显式参数（如 `undescribableRepo: 'fail-closed' | 'skip-projection'`），不是复制后微调。判据：凡「攻击者可影响的路径 → manifest 里的可写子树」这类规则，全仓必须只有一份实现（现为 `services/runtime/netlessProjection.ts`）。
- **`git rev-parse --git-common-dir` 的答案来自工作区内可写的 `.git` 指针，不是可信输入**：`<worktree>/.git` 是普通文件，agent（以及被围栏的 MCP 子进程本身）可写；改成 `gitdir: <任意其它仓>/.git` 后 git **如实报告**那个目录（git 2.50.1 实测，目标只需含 `HEAD`+`objects/`+`refs/`）。把它当可写投影 = 把 daemon 身份的 hook 目录送给模型。防线只有一条：common dir 落在 worktree 之外时，用 `git worktree list --porcelain` 验证**该 worktree 确实注册在那个 common dir 里**（`assertRegisteredGitWorktree`）。附带：git 会自行规范化指针里的 symlink，故「报告路径 realpath ≠ 自身」是纵深防御而非活漏洞。
- **重入型 run 目录里的私有子目录必须 `lstat` 拒链接**：inline-clarify 复用同一 `runRoot`，上一轮的模型可控子进程对 scratch 有写权限，可把 `home`/`tmp` 换成 symlink；`mkdir(...,{recursive:true})` 会**接受**已存在的链接、`realpath` 忠实跟随，于是下一轮把外部目录当 HOME 写进 manifest 并授予可写。定式：逐级非递归 `mkdir` + `lstat` 拒 symlink/非目录 + 全路径 `realpath === self`（`ensurePrivateNetlessDirectory`）。
- **`Bun.which('./x/y')` 按 daemon 的 cwd 解析，不是按你想要的 cwd**：含斜杠的相对 token 交给 `Bun.which` 要么返回 null、要么命中安装目录里的同名无关文件。用户配置里的相对命令必须显式 `resolve(<预期 cwd>, token)`，PATH 查找只留给**裸名字**。
- **围栏子进程的 PATH 还要能找到 shebang 解释器**：`npx` realpath 到 `.../npm/bin/npx-cli.js`（`#!/usr/bin/env node`）而同目录**没有** `node` → 围栏内 `exit 127`。只把命令自身的 dirname 加进 PATH 不够，要解析 `#!` 链把解释器目录也加进去（已在 `/usr/bin:/bin` 里的解释器不必重复投影）。**更要命的是它的失败形态**：claude 报 `mcp_servers:[{status:"failed"}]`、工具表缺失，而节点照常 `is_error:false` 成功——**安全围栏导致的能力丢失必须做成节点级显式失败**，否则没人会发现。
- **一个能力往往有「工具」和「发现源」两个独立开关，只修一个等于没修**（claude skills，2026-08-04 + 2026-08-09 连续两次）：`skill:'allow'` 翻成 `--tools …,Skill` 只给了**工具**；技能实体还要 CLI 去扫 `$CLAUDE_CONFIG_DIR/skills`，而那次扫描被 `--setting-sources` 单独把着（`""` ⇒ `Tg("userSettings")` false ⇒ 整个目录不 readdir）。第一次修掉 `--disable-slash-commands` 后所有人都以为好了，**技能依然一个都进不去**，直到用户在生产报「找不到 skill」。判据与定式：**凡为收窄安全面加的 flag，逐个去二进制/源码里查它到底关掉了什么**（`--disable-slash-commands` 的 help 原文是 "Disable all skills"，`--setting-sources` 的文案只字未提技能发现），别信自己代码里的注释；**修完必须拿真机跑一次「能力真的在」的正向验证**——本次用的是把 API 指向死回环端口、只读 `system/init` 事件的 `skills[]`/`plugins[]` 数组，零 token 就能对照三种 flag 形态。
- **运行日志里的「注入情况」必须是真实注入，不能是「我们选中了什么」**（2026-08-09 实测）：claude 的 spawn 诊断长期打 `pluginCount`/`pluginNames`，而 claude **根本没有插件面** —— 日志说注入了 N 个，进程装载 0 个。运维看这条线做判断，它撒谎比不打更糟。opencode 侧 RFC-256 的 `machineConfigIgnoredPlugins` 是正确姿势（注释原话：「report the count so that limit is visible in the run log instead of looking like a silent no-op」）。定式：**诊断字段与 fail-closed 校验用同一份派生**（本仓现为 `SpawnPlan.declaredCapabilities`），一份数据既进日志又进校验，构造上不可能互相矛盾；被忽略的东西按 `xxxIgnored*` 命名如实报出来，别复用听起来像「已注入」的名字。
- **两个运行时对同一份 agent 定义的语义必须逐条对照，别假设对称**（三次事故同一根因）：`skill:'allow'`→claude 要额外的发现源、`task:'allow'`→opencode 由闭包**自动**开而 claude 要用户手写、纯 deny 声明→opencode 是「除此之外全开」而 claude 是「一个都不开」。新增 / 修改任一运行时的注入面时，把 `agent.*` 的每个字段在两边各走一遍「收集 → 注入 → **运行时真的能用**」，第三段最容易缺，而且缺了永远是静默的。判据：能不能从运行时自己的启动清单（claude 的 `system/init` 给 `tools`/`agents`/`skills`/`mcp_servers`，opencode 走 verified inventory）把它证出来——RFC-280 把这一步做成了框架级常规：`services/execution/startupVerification.ts` 对每次 spawn 的声明注入清单 × runtime 启动清单做差集，业务节点落持久告警、MCP 测试台 fail-closed，见下条。
- **「注入了」和「运行时真的加载了」是两件事，第三段缺失永远静默——必须框架级验证，别靠 agent 口头反馈**（RFC-280，起于两起同症状不同根因的「agent 找不到 MCP」故障：一是 RFC-276 前的 launcher 身份门残留拦掉了 opencode 本体，二是 agent 根本没引用那个 MCP）。教训分三层：①**盘点先于动手**——当时 spawn 层有 5 条平行链路（业务 runner / 系统 agent systemAgentRun / MCP 测试台 / 冒烟探针 / 记忆蒸馏器）、MCP×4·agent 定义×6·skill×3 套平行注入转换、`parseStartupInventory` 是零消费方的死代码；没有全盘点会把局部补丁打在错误的层。②**注入转换收敛为单一实现**（`services/execution/agentInjection.ts`）+ 每次 spawn 产 `DeclaredManifest`（含 disabled 跳过 / dropped 参数 / 无法观测面），run 后与 runtime 启动清单差集 → `node_runs.startup_verification_json`：业务节点持久告警不 fail、测试台 fail-closed（`mcp-test-mcp-unusable` / 观测源缺失即 `mcp-test-verification-unavailable`，绝不 fail-open）。③**进程可靠性收敛为单点**——5 条链路的 spawn/stdin/timeout/TERM→KILL/reap/drain 全归 `managedProcess`（`agentProcess.ts` 适配）。收编 runner 时踩过一个隐性契约坑：runner 的 stdout 回调**会抛**（runtime-lease 声明 / session-id 变更守卫 / DB 错误），旧 `settlePump` 捕获置 `streamPumpFailed` 而不传播——曾把 managedProcess 对应的 `onPumpError`+`allSettled` drain 当投机性回退，结果 rfc026/042/056/210 因 rejection 逃逸成异常全红。判据：**收编「久经考验的自建进程管理」前，先把它捕获但不外抛的每一个 try 找出来**（`grep 'catch' + 'startKill\|streamPumpFailed'`），那些静默容错往往是必需语义而非冗余。fail-closed 首跑还抓到自家 real-e2e mock 的 init 缺 `mcp_servers`——这正是该语义要抓的「号称连上却拿不出启动证据」，是信号不是噪声。
- **放开一个发现源，就要重新审计那条路径上的全部加载语义**：`--setting-sources user` 让技能目录重新被扫，**同时**让 CLI 把带 `.claude-plugin/plugin.json` 的技能目录当**插件**加载（`<name>@skills-dir`，可带 hooks/agents/mcpServers ⇒ 任意命令执行）。此前不炸只是因为 `""` 顺手把两者一起关了——**「碰巧安全」在你修好隔壁的 bug 那一刻就到期了**。定式：安全性来自某个开关的**副作用**时，把它写成显式防线（这里是 `stageSkills` 按 basename 精确剔除 `.claude-plugin`）并单独加测试，别让它继续搭便车。
- **拆掉一个平台注入面时，必须同时改依赖它的\*\*读取面\*\*——带 fallback 的读取面尤其危险，默认部署会替你把 bug 藏住**（2026-08-12 实测，claude 子代理转写捕获）：RFC-111 写捕获时平台把每次运行密封进私有 `CLAUDE_CONFIG_DIR=<runRoot>/.claude`，于是捕获按 `<runRoot>/<leaf>` 找 `projects/`，再挂一条硬编码 `~/.claude` 兜底「以防 claude 以后改行为」。RFC-276 把密封拆了（`claudeCode/spawn.ts` 的 `assembleClaudeEnv` 不再写任何 config-dir env，子进程继承 daemon 的），**没人回头改捕获**：主候选从此指向一个谁都不会写的目录，兜底反而成了唯一生效路径。后果是默认机器（没导出 `CLAUDE_CONFIG_DIR`、home 就是 `~/.claude`）一切正常、**看不出任何问题**，而导出了该变量或换了 fork 配置根的部署，每条子代理转写都被丢弃，唯一信号是一行 `claude-subagent-capture-session-dir-not-found` warn。判据与定式：①**注入面 RFC 的验收清单里要有一条「谁在读这个位置」**（`grep` 该路径/env 的全部消费方，写面和读面同一批改）；②**兜底候选会掩盖主候选失效**——凡「主 + fallback」的定位逻辑，必须有一条测试锁住主候选**单独**能命中，否则主候选烂掉时全套测试仍绿；③读运行时私有目录要按**运行时自己的解析规则**推导，别用宿主的：`os.homedir()` 在 Bun 里只认进程启动时的 `$HOME`（实测 mid-process 改 `process.env.HOME` 不生效），而被拉起的 Node CLI 是**动态**读 `$HOME`/`%USERPROFILE%` 的——两者在改过 HOME 的 daemon 下会指向不同目录（现由 `claudeCode/sessionCapture.ts` 的 `spawnHome`/`claudeUserConfigRoots` 统一，锚 `runtime-claude-capture.test.ts` 底部回归块）。
- **bwrap `--setenv NAME VALUE` 把密钥写进世界可读的 `/proc/<pid>/cmdline`**：bwrap 无 `--clearenv` 时把**自己的** environ 原样交给子进程，所以正确做法是把 env 交给 bwrap **进程**（`Bun.spawn({env})`），argv 里一个字节都不放。同理，任何「把密钥移出 argv」的声明都要顺着链路查到底——remote MCP 的 header 曾在 claude 的 `--mcp-config` inline JSON 里（进 `/proc/<pid>/cmdline`），RFC-280 §7.1 已把业务/系统 agent/测试台三条 claude 路径统一改为写 `0600` 文件传路径，该 audit-backlog 条目关闭。

- **opencode 作为 MCP **客户端**的三条实测行为（RFC-247 设计期读源码确认，写服务端必须知道）**：
  ① `packages/opencode/src/mcp/catalog.ts:53-67` 调工具时传 `{ resetTimeoutOnProgress: true, onprogress: () => {} }`，源码注释明写「SDK 只有这个 hook 存在时才发 progress token，从而启用超时重置」⇒ **每条 progress notification 都会重置客户端超时**，长驻工具只要心跳频率高于客户端超时就能一直挂着；
  ② `mcp/index.ts:38` `DEFAULT_TIMEOUT = 30_000`——**`packages/core/src/v1/config/mcp.ts` 的 schema 注解写「默认 5000」是过期文案**，以代码为准；同一个 `timeout` 既做连接超时（`:286`）又做请求超时（`:662-664`）；
  ③ `core/src/v1/config/mcp.ts:44-60` 的 `Remote.oauth` **不显式设 `false` 就默认开启 OAuth 自动探测**，opencode 会对你的端点发起 discovery。给用户的远程 MCP 配置片段**必须带 `oauth: false`**，否则第一次连接就走错路径。
  另：`catalog.ts:47` 会**强制**给你的 `inputSchema` 加 `additionalProperties: false`（入参 schema 必须闭合）；`:69-75` 在 `isError` 时把 text content 拼起来 throw（错误文本必须自解释且**不得含密钥**）。

## 工作流提示与人工重跑

- **框架已经组合好的 prompt 不是用户模板，不能再跑一次 `{{token}}` 展开**：工作组回合和动态工作流编排器会先把 goal、charter、消息与结果围栏成完整 prompt；若随后仍走普通 Workflow `promptTemplate` 替换器，用户数据里的任意 `{{literal}}` 会被当成不存在的端口并静默删掉。渲染入口必须显式区分 author template 与 framework-composed prompt，后者原样保留；附加工作组协议块前也要强制建立空行段落边界，防止 `</aw-input>## ...` 粘连。
- **“显示完成门”与“持久门状态”必须是同一个 CAS 事实**：Free-collab 的机械收敛没有 Leader `wg_decision(done)` 帮它做 `idle → declared`；若只创建 holder/系统消息再尝试 `declared → awaiting_confirmation`，UI 看似等待批准，数据库仍是 `idle`，confirm API 必然拒绝。任何共享 gate helper 都要先建立调用模式缺失的前置状态，再开门。
- **有界重试结束必须消费触发它的旧输入**：Leader 的 clarify-forbidden 重试耗尽后若不推进 member cursor，wake oracle 会立刻拿同一旧消息再次唤醒，完全绕过 idle-nudge 上限并瞬间烧完 `maxRounds`。`drop-and-continue` 不是空 `return`；先提交 cursor/attempt 等进度事实，才允许调度器决定下一次唤醒。
- **尾部指令只能引用本轮实际可见的上下文**：Clarify Q&A 在成功产出后会按代际淘汰；评审驳回重跑若尾部仍写“use the answers above”，Agent 会因为上方根本没有答案而再次反问，继而触发 clarify-forbidden。提示拼装必须从同一个 `answersVisible` 判据同时决定 Q&A 块与 STOP 尾句；不可见时改为从 Prior Output / resumed session 恢复已定选择并直接完成。
- **乱码先走评审闭环，不做无条件转码**：provider 可能直接返回“äº¤ä»”一类已经双重编码的原文，数据库与前端只是在如实展示。review 应退回并要求 Agent 丢弃乱码 Prior Output、重新读取 UTF-8 source 生成；自动 latin1→UTF-8 会误改本来合法的文本。

## 构建 / 后端 wire

- **单二进制 smoke（`bun run build:binary`）会抓 typecheck/`bun:test` 抓不到的模块初始化循环**；推 shared-export 改动前先跑（RFC-079 事故）。
- **`buildLaunchBody`/`buildLaunchBodyMultiRepo` 白名单 `POST /api/tasks` 字段并丢弃 extras**：加进 `launchCommon` ≠ 上线——必须在 helper 里 stamp（共享 `stampLaunchExtras`）；launch 测试只断言 source-spread（根因），别被绿测试骗过。
- **wrapper 私有 canonical 不是 worktree 锁的例外**：同一任务的 wrapper 与顶层 sibling 会并发启动，但它们的 `git worktree add/remove` 都改同一个仓库的 `.git/worktrees` 注册表；wrapper 新建必须与普通 Agent 共用任务级 `writeSem` 的短窗口。裸创建会在 Linux coverage / 高负载下留下半初始化 `commondir`，表现为随机 `isolated worktree setup failed`，而不是业务节点失败。
- **后台清扫 loop 写 node_run / task 前必须过「活跃驱动门」`isTaskActive`**（先例 `lifecycleRepair/helpers.ts` `schedulerLivenessGate`）。RFC-230 事故：周期孤儿回收器是唯一绕过这道门的后台写者，且判活口径是 `pid === null ⇒ 进程已消失`——而 wrapper（git/loop/fanout）记账行**永不写 pid**（`pid` 全仓唯一写点在 `runner.ts` spawn 之后），于是内层跑超 60s 宽限期的 wrapper 被误判成孤儿翻 `interrupted`，收尾撞终态守卫→整任务 `scheduler error` 失败，还顺带伪造出 S3「任务在跑但节点全终态」卡死现场。**通用规律：新增一类 run / 行时先问「它的活性证据从哪来」**——没有进程 ≠ 已经死了，容器类行的活性委派给内层行，最终才落到真实进程或真实驱动；证据缺席一律判活（误收=打断活任务，漏收=残骸多活到开机清扫，代价不对称）。
- **注入式判据 = 真实判据零覆盖**：`isGone`/`probe` 这类注入 seam 让生产口径永远走不到测试里（`design/test-guard-audit-2026-07-21/01-gaps.md` 的 `B2-lifecycle-1`/`M1-lcov-4` 记过、RFC-230 兑现）。注入的是**探针**（pid 是否活）而非**判据**（这行是否该被判死）——判据必须有直测。
- **settings 里的一个数字要真正生效，得穿过三段漏斗，少一段就是「保存了但没用」的假门**：①`resolveLaunchRuntimeConfig`（config.json → `StartTaskDeps`）、②`runtimeConfigOpts`（deps → `RunTaskOptions`，start/resume/retry 三处 kick 共用）、③RFC-243 的 `buildChildDeps`（父调度器 opts → 子任务 deps）。**同一形状的漏接线已经犯过三次**：RFC-108 的 `defaultPerNodeTimeoutMs`（节点根本没有超时上限）、RFC-103 的 `maxConcurrentNodes`（生产恒走默认 4）、RFC-266 的 `multiProcessSubprocessConcurrency`（扇出并发恒为 4，且**前端有输入框、schema 有字段、调度器有消费点**，三头都在、中间全断，所以从任何单点看都像接好了）。判据：加 config 键时**先写「三段都出现」的源码锚点断言**再写实现（`rfc103-launch-config-passthrough.test.ts` 是现成的落点）；review 别只看「调度器读没读」。
- **同一漏斗的第四次事故，形态变了：漏的不是数字，是「服务对象」**（RFC-269，2026-08-10 实机验收挖出）。`CodeHostConnectionsService` 只在 `mountCodeHostRoutes` 里就地构造，**全仓没有任何生产路径把它注进调度器**：`buildStartTaskDeps` 没有、`StartTaskDeps` 连字段都没声明、`buildChildDeps` 也没有。于是 `code-host-call` 节点在**任何**真实任务里恒定 `code-host-not-configured`，与「管理员根本没配」完全同形——实测连接已配好、设置页「测试连接」返回 ok，节点照样失败。**两个放大因素**：①兄弟参数（`maxConcurrentCodeHostCalls` / `codeHostRequestTimeoutMs`）都老老实实穿过了三段漏斗，从代码上看这一族「显然接好了」；②整套 RFC-269 单测全绿，因为它们都直接调 `executeCodeHostCall` 并**自己注入** connection，没有一条断言走「从磁盘取凭据」那一段。**判据升级**：漏斗断言不能只覆盖标量配置键——凡是节点执行要用的**依赖对象**（凭据服务、探针、外呼客户端）同样要有「不注入时也能拿到」的直测；`opts.x?.foo() ?? null` 这种写法一旦 `x` 恒为 undefined，读起来像「自跳过」，实际是「功能整条没接」。本次修法是收成**一个**懒解析点（`resolveCodeHostConnectionsFromKeyFile`，注入优先、只读密钥文件不创建），而不是去补第十五处展开点。
- **daemon 级单例 + resize-on-read 的限流器，漏传参数不是「保持原值」而是「倒灌默认值」**：`getNodePoolSemaphore(db, kind, opts.x ?? 4)` 在每次 `runTask` 都会把共享实例 resize 成传进来的值，于是**任何**没带上该键的 runTask 调用方（RFC-266 差点漏掉的 `buildChildDeps`）都会把管理员配置的上限静默改回默认——影响的是**整个 daemon**，不只是那一个任务。凡是「读的时候顺便 resize 共享对象」的设计，都要把「所有调用方都必须带值」写成测试，而不是靠 `?? 默认值` 兜底。
- **deps 链字段改名必须枚举全部承载类型——spread 透传会把留旧名的键静默丢在边界外**（RFC-282 C1 实测，2026-08-12）：把 `RunTaskOptions.opencodeCmd` 改名 `binaryOverride` 时漏了上游 `StartTaskDeps`/`FusionDeps`/daemon auto-resume deps 三个载体，而 task.ts 的透传写法是 `...(deps.opencodeCmd ? { opencodeCmd: deps.opencodeCmd } : {})`——**spread 进目标类型不触发 excess property check**，tsc 全绿、键在 RunTaskOptions 门口静默蒸发，表现为 mock 二进制失联、测试任务走真 opencode 超时 failed。三段漏斗族的第五形态：前四次是「键没接」，这次是「键改名后旧名残段照跑」。判据：改名 deps 字段时 `grep -rn "旧名"` 必须清零到只剩围栏内合法使用，**顶层载体类型改名后让 tsc 把全部断链显形**（错误驱动清零），且靠真子进程 e2e（mock 头必须真被 spawn）兜底——纯 mock 单测抓不到这层。
- **「改了设置不生效」多半不是没接线，而是只在启动时读**：共享限流器支持热 resize（`util/semaphore.ts` 增容会 drain 排队者、缩容不抢占），但 RFC-266 之前唯一的 resize 调用方是 `runTask` ⇒ 新值要等下一个任务启动才套上，没有新任务就永远不生效。定式：daemon 级可变配置在 `PUT /api/config` 里就地生效（`routes/config.ts` 已有 RFC-233 `setMode` 的线性化点先例，写在 `applyConfigPatch` **之后**，写盘失败不得留下"已按新值放行"的既成事实）；per-task 的实例要热生效则必须先有 daemon 级注册表（`taskFanoutPools.ts`，生命周期照抄 `taskWriteLocks.ts` 的「gc 只许 runTask finally 调 + idle 守卫」，否则删了再建会把一个池裂成两个、任务以双倍并发跑）。

## Codex review（本仓工作流的一部分）

> 强制门时机与坑；companion 的**本机调用路径**属个人配置，不在此。

- **两个门**：写完 RFC 请批前（**设计门**）+ 改完代码 declare done 前（**实现门**），每次修 findings。这是 CI 之外的额外门（RFC-101 抓过 7 个真问题）。
- **共享树上从分离 worktree 跑**：并发 session 的 diff 会**吞掉**你的 review（你的代码出 0 findings）；从 pin 到你 commit 的分离 worktree 跑，并 grep job log 证明这不是空洞通过。
- **rescue job 会僵尸**（status=running 但 result=no-job-found、rollout mtime 冻结、0% CPU）；从 `~/.codex/sessions` 的 rollout jsonl 里抢救 pre-stall finding 独立复核；分离 job 无自动通知，须 bg 轮询 status。
- **分离 worktree 里必须真跑 `bun install`，`cp -R node_modules` 是无效捷径**（2026-08-08 实测）：`git worktree add` 不带任何 node_modules，而 cp 过去的那份**丢掉 bun 的 workspace link**（`@agent-workflow/shared` 直接 "Cannot find module"），手工补 symlink 又会卡在下一层（`Cannot find package 'zod'`，嵌套依赖同样没跟着走）。症状是 Codex 想验证结论时 `bun test` exit 1，于是**整轮 review 退化成纯代码阅读**——它照样报 finding，但少了自证环节，而你从 companion 日志里只看得到一行 "Command failed"，很容易漏掉自己的 review 弱了一档。定式：worktree 建好后立刻 `bun install --frozen-lockfile`（约 1.2s，本仓 1542 包），跑一个测试文件确认绿，再启 review。

- **主干开发下 Codex 的 `review` 圈不出「你的」改动**：它按 `--base` 算 diff，而共享 main 上那个区间里必然混着并发 session 的提交——实测它会跑去读别人 RFC 的文件并对着那些代码出 findings。分离 worktree 解决的是「工作树里的未提交改动」，解决不了「区间里的他人提交」。当本轮改动跨了别人的提交，改用**独立子代理**评审并把**确切文件清单**写进 prompt（RFC-240 先例，`docs/dev-gotchas.md` 的 Codex 段已列为备选）；顺带把「忽略 rfc257/webhook 之类他人关键词」也写进 prompt，否则子代理也会去查别人的代码。
  **但先试最省事的一招：把 `--base` 钉到你这条提交的直接父提交**（`git rev-parse <yoursha>^`），区间里就只剩你一个提交，根本不需要子代理。2026-08-08 实测踩过一次反例：图省事拿「上一次审过的点」当 base，区间里混进并发 session 的两笔 RFC-271 提交（design.md 被整份重写），**报回来的 9 条 P1/P2 全部指向 `design/RFC-271-*/design.md`，与本轮改动零交集**——不是没找到问题，是把整轮算力花在别人的文件上，自己的改动一条没审。**识别信号**：findings 的 file 路径**集体**落在你没碰过的目录。所以启动 review 前先 `git diff --name-only <base> HEAD` 扫一眼，确认列出来的就是你自己的文件清单。
- **`afterEach` 报的错常常不是真因，先往上找 `hook timed out`**（RFC-287 T14 实测，差点去追一个不存在的类型 bug）。症状：`afterEach` 抛 `TypeError: path must be a string`（`rmSync(undefined)`）。真因是同一个 test 的 **`beforeEach` 超时**了——bun:test 会在失败行下方单独打一行 `a beforeEach/afterEach hook timed out for this test`，但主错误栈指向的是清理钩子。前置钩子超时 ⇒ 变量从未赋值 ⇒ 清理钩子拿到 undefined 才抛。**判据**：清理钩子里出现「值是 undefined」类错误时，别信那个栈；先搜 `hook timed out`。顺带一条写法建议：夹具清理里对路径变量判空（`if (x !== undefined) rmSync(x)`），这样前置失败时报的才是真因。
- **`gate:local` 全绿 ≠ CI 会绿：有一批测试被环境开关门控，本地门禁一个都不跑**（RFC-287 T14 二轮实测，被这条坑了一次 CI 往返）。`describe.skipIf(!RUN_GIT_NETWORK)` 目前挡着 4 个后端套件（`git-repo-cache-submodule` / `worktree-submodule-init` / 两个 `mcp-probe-*-integration`），CI 会设这个变量、本地不会。症状极具迷惑性：固定快照门禁 backend 10198 全绿，推上去 CI 的 ubuntu 与 macOS **同一分片双双红**（双 OS 同红本身就说明是确定性失败而非环境抖动）。**判据**：改动若触及 git 远端 / 子模块 / MCP 探针这些「需要真网络或真 git 协议」的面，推之前补跑一次 `RUN_GIT_NETWORK=1 bun test <那几个文件>`；用 `grep -rln "skipIf(!RUN_GIT_NETWORK" tests/` 把清单取全，别凭记忆。同理还有 `skipIf(process.platform …)` 的 17 处平台门控——那些只能靠 CI 的双 OS 矩阵兜。
- **多路评审要刻意错开「看什么」，而不是只切范围**（RFC-287 T14 两轮实证）。第一轮我按半场切了两路 Codex——范围不同，但**视角相同：都在看 diff**。结果两路**同时漏掉**一条 P0 安全问题：G7 把空 `worktreePath` 从罕见终态变成每个准备中任务的正常状态，`resolve('')` 返回进程 cwd 于是「任务还没有工作树」被当成「工作树 = daemon 的工作目录」——那段代码**一行没改**，不在 diff 里，看 diff 的评审天然看不见。第二轮我另起两路刻意错开的视角，产出立刻不同：**「不在 diff 里的连带面」**（先列出本轮放宽了取值范围的值，再反查所有消费方）挖出 2 条 P0；**「测试有效性」**（对每条新断言做变异，问「实现变得更正确时它会不会红」）挖出 5 条零预言力断言，其中一条是「重试 X = 重跑 X」把实现换成裸 `return` 仍全绿。**判据**：切多路时先问「这几路会不会因为同一个盲区一起漏」；至少留一路不看 diff、一路专审测试本身。
  - **为什么自查补不上这一课——自查用的还是当初得出结论的那套视角**（2026-08-15 两个并发 session 互相纠错四次后归纳）。四次里**被纠正的一方每次都处在「已经复查过、并且确信自己对」的状态**：一方判定 e2e 失败机制时套用了首次的形态去解释 retry1（两次机制其实不同），另一方写「文档格式没门禁保障」时假设「没被 prettier 覆盖」就是原因（实际覆盖了也没用，prettier 不管全半角）。**问题不在谁不够仔细，在于复查时复用的正是产生那个结论的视角——同一套视角查一百遍也翻不出来，换一双眼睛一眼就看见。** 所以「我再仔细看一遍」不是这类错误的解药，**换视角**才是；这也是上面那条要求刻意错开视角、而不是要求评审更认真的原因。人与人之间的交叉纠错和多路评审是同一个机制在不同尺度上生效。
- **后台跑 `codex exec` 必须 `< /dev/null`，否则永久卡在读 stdin**（2026-08-19 实撞，RFC-312 设计门第二轮白等 50 分钟）。`codex exec [PROMPT]` 除了位置参数还会读 stdin（有管道就把它当 `<stdin>` 块附加到提示词后面）；在「Bash `run_in_background:true` 里跑前台 `--wait`」这个本仓推荐姿势下，stdin 是一条**永不 EOF** 的管道，于是它一直等。**症状与已知的两种僵尸都不同**：进程活着、0% CPU、**日志只有一行 `Reading additional input from stdin...`**（banner / workdir / session id 一个都没打）、`~/.codex/sessions` 下**没有属于它的 rollout**——因为线程压根没起。判据：日志停在那一行且无 rollout ⇒ 是 stdin 卡死，不是模型慢，等再久也不会动。**定式**：后台起 review 一律写成 `codex exec … < /dev/null > out.log 2>&1`；起完立刻 `grep "session id" out.log` 确认 banner 出来了再去等。同一条命令加上 `< /dev/null` 后 secs 级就打出 banner。
- **多路 Codex 门必须串行启动，起完一路要核实 job 真的注册上了**（RFC-287 T14 第二轮实测）。同一 workspace 的 job 列表存在 `~/.claude/plugins/data/codex-openai-codex/state/<ws>/state.json` 的 `jobs` 数组里，是**读-改-写**。并行起两路 rescue agent 时后写的会把先写的那条覆盖掉，随后 jobs 目录被重建成空——两个 job **一个都没跑**。最坑的是它**不报错**：两路 agent 都正常返回「Codex Task started as task-xxx」，你以为在跑，实际等到超时才发现。定式：起一路 → `cat state.json` 确认 `jobs` 里有它 → 再起下一路；轮询脚本里加「job 文件消失」的分支，别只判 `status != running`（文件没了时那个判断恒真，会误报成"完成"）。
- **Codex 的 job registry 按 `workspaceRoot` 分目录——从分离 worktree 起的 job 不在主仓那个目录里**（RFC-287 三轮门实测，差点误判成「重启没注册上」）。路径是 `~/.claude/plugins/data/codex-openai-codex/state/<workspace-slug>/jobs/`，而 slug 由 workspaceRoot 派生：主仓是 `agent-workflow-<hash>`，pin 到 `scratchpad/gate-r3d` 的 worktree 就变成 `gate-r3d-<hash>`。而本仓的强制定式恰恰是**从分离 worktree 跑 review**，所以这是常态不是例外。症状：agent 报「started as task-xxx」，你去主仓那个 jobs 目录一看文件不存在，正要判它是上文那条「并发覆盖导致 job 丢失」。**判据**：先 `find ~/.claude/plugins/data/codex-openai-codex -name "*<jobid>*"` 全局找一遍，确认真不存在再下结论；轮询脚本里的 `$D` 也要按你实际的 workspaceRoot 取，别写死主仓那个。

- **Codex job 的 `status` 会谎报 `running`——进程早就没了**（RFC-287 三轮门实测，白等 92 分钟）。已知的僵尸形态是「进程还在、0% CPU、rollout 冻结」；这次是**进程直接消失**，而 `jobs/<id>.json` 里仍写着 `status: "running"`，轮询脚本按状态判就会一直等下去。**判据（两条同时看）**：①`ps -p <json 里的 pid>` 有没有这个进程；②`ls -l <id>.log` 的 mtime 距今多久。进程没了 + 日志冻结十几分钟以上 = 死了。日志里能看到它死前读到哪一步——本次是死在读代码阶段，**零 findings**，没有可抢救的产出。**处置**：把 job 文件的 status 改成 `failed` 免得后续轮询继续被骗，重启**一次**；再死就如实报「Codex 不可用」并改用自己的独立子代理顶上，别三连重试（本段上文已有此定式）。

- **对抗式评审的 prompt 要求「给出能复现的具体输入」**，否则拿回来的是一堆看着有理、核实起来全是空的猜测。加一句「构造不出具体失败输入的就丢掉」，findings 的信噪比会完全不同——本轮两路 25 条里绝大多数自带变异验证，逐条核实后全部属实。

- **多轮门之后必须专切一路查「用户拍板漂移」，而且要对着当前文档/代码查、不能对 diff**（RFC-304 三轮设计门实测，第三轮专开这一路查出 **7 条**）。现象：一份 RFC 连过三轮门、改掉约 60 条 findings 之后，正文里有若干行为**已经不是用户当初拍板的那个形状**了——例如用户拍板「重复检视先 resolve 掉上轮未解决的线程」，为修一个反馈丢失的 bug 被改成「持续存在的保持未解决」；用户拍板「bot 提的 MR 默认同样受监管」，为压噪音被改成「机器 push 默认不触发」。**为什么前几轮都没查出来**：①**每一笔单看都是正确的技术修复**，diff 上呈现为「修了个 bug」，没有任何一行写着「我改了你的决定」；②改判往往**分散在好几笔里**，看单次 diff 永远看不出累积效果；③**动机是对的**，所以没有任何内部信号提示你越界了——你不是在偷懒或走捷径，是在认真解决问题时顺手把地基挪了一格，靠自律发现不了。**判据**：把「用户已拍板清单」（本仓的形态是 RFC proposal 里的拍板记录表）逐条拿出来，对**当前正文**核对"这条现在还成立吗"，而不是回看任何一次 diff。**处置**：查出来的一律**原样登记待用户重新拍板**（RFC-304 的做法是新开一节 `§6bis-B`，逐条写明"你原来拍板的 / 现在设计成了什么 / 为什么会漂 / 我的建议"），**一条都不自己拿主意**——修复动机再正当也不构成改判授权。**与「CI 判定饿死」的区别值得记**：那类是资源竞争，代价是时间且**一定会暴露**（被顶的人查一次就看见 cancelled）；这类是权限僭越，代价是用户对系统的判断被悄悄换掉，而且**天然不暴露**，等暴露时连追溯哪一条是何时被改的都很难。**共同的根**是同一个假边界：「我只动了自己那部分」——真实边界不是「谁写的」，是**「谁的判断在依赖它」**。
  - **筛子是「用户能感知的行为变了吗」，不是「我加了新机制吗」**（RFC-304 同轮实测：13 个新机制里按此筛只有 7 个构成漂移，Codex 替作者剔掉了 6 个）。`closing` 态、发布临界区、`noop` 这类**只是维护既有可感知语义**的实现细节不算漂移——把它们报上去会让清单失去信号，用户逐条重新拍板的成本白付。报之前先问：**用户点开界面能看出区别吗**——「实现复杂度上去了、用户看到的东西一模一样」的一律不报。**剔假阳性与找真阳性是同一件事的两半，只写一半这条规则就不成立**：没有筛子，执行方式必然退化成「把新机制全列给用户重新拍板」，让用户白付几次成本之后这一路就会被当成形式主义废掉。**一条只报真阳性的规则才活得下来。**
  - **哪类 RFC 更容易中招，决定了这一路该切多重**：**重构型**（如 RFC-287）验收标准本身就是「契约逐字保持」，拍板项多是**做不做**的开关，开关状态一眼可验;**产品行为型**（如 RFC-304）拍板项是**怎么判**的语义，而语义恰恰是修 bug 时最容易顺手调整的东西。RFC-304 那 7 条**全部**落在「怎么判」上（先 resolve 还是保持未解决、默认监管还是默认跳过），一条都不在「做不做」上——不是巧合。产品行为型 RFC 请把这一路当**必切**。
  - **查完是干净的也值得查——「干净」不是默认状态，是查过才知道的结论**。RFC-287 五轮门 90 个修复、9 条用户拍板，照此法逐条对当前代码，9/9 在位（连「未被选中的候选方案」都记在代码注释里）。作者全程自认为每个歧义都问过用户，但那是**信念**不是**证据**,逐条对完才变成证据。不写这一条，规则会退化成「出过事的人才查」，而它真正的价值是把「要不要查」从判断力问题变成流程问题——谁都能照着做。

## impl-gate（Codex 实现门）经验规律

历次 impl-gate 沉淀出的「finding 类型 → 风险」规律，接手评审/修复时按此预期：

- **「这条 AC 一条测试都没有」本身就是最高价值的线索——补上第一条用例，它经常当场就红**（RFC-287 三轮门实测两次）。按 AC 逐条对账时，比「测试写得好不好」更该先问的是「**这条 AC 有没有被测过**」。本轮 AC-14（取消/停机/删除在准备窗口内生效）零覆盖，写第一条用例立刻红：git 子进程确实被打断了，但准备段把中止当成普通 git 失败、抢先把任务 CAS 成 `failed`，用户点了取消却得到「失败」。AC-15 只有一处顺带断言，补锁时发现真正危险的那个写点（`lifecycle.ts` 的惰性补墓碑）纯靠一个**巧合级前置条件**避开。**定式**：实现门里单开一路做「AC × 测试」的矩阵对账，格子空着的优先补——补出来的红比在已覆盖面上加断言值钱一个量级。

- **生产逻辑 / 平台 / 基础设施类 finding 几乎都是子系统级**，且**易引入比原 bug 更严重的 regression、常需 revert + defer 到专门 RFC**。典型：
  - **固定字节阈值几乎总错**——page size、平台 ARG_MAX（macOS ~1MiB 非 256KiB、Linux `MAX_ARG_STRLEN=32×页大小`）都是**运行时量**（E2BIG spawn guard 四轮后 revert，defer 到平台感知 RFC）。
  - **任何 spawn 前新增的同步/阻塞探测都可能升级成 daemon 级死锁**（node_run 已占 semaphore、abort 要 spawn 后才注册、并发首 spawn 缺 single-flight）→ 必须 **bounded + cancelable + single-flight**（opencode 版本探测 revert 事故）。
- **测试 / 回归防线 / 重构类 finding 多能一~多轮干净闭环**（RFC-210 G7、e2e 桩契约、单源 dedup）。
- **守卫强化类介于两者**：**实质加固能落地**，但「完整正确」常是子系统——**源码文本守卫的防漂移正则 ratchet 是无底洞**（receiver 语法/空白/注释变体穷不尽），完整闭合 defer 到「守卫 AST 化」RFC，但精确 occurrence 锁 + 表驱动变体锁的实质加固可保留。
- **「测试加固」类 finding 可能实为生产竞态子系统**：给 fire-and-forget 链加 settle seam 时，Codex 常揭示这不是补测试、而是暴露原设计的 [high] 并发 bug（RFC-212 WS 授权握手期不重跑 gate + 无 pass generation → 被移除成员仍收 stdout）；「不能仅延期测试」。

- **进程级注册表 + 测试夹具 = 只在共享进程下才炸的碰撞**：`bun test` 的项目脚本带 `--isolate`，每个文件独立进程；**手敲 `bun test`（不带 flag）则全部文件共享一个进程**。RFC-247 的路由元数据注册表是模块级单例（它描述「本仓有哪些路由」这一静态事实），于是一个测试夹具若拿**生产路径**当例子（当时用了 `/api/whoami`），共享进程下就会和真实声明撞成「同路径不同契约」并抛错——而带 `--isolate` 跑永远绿。**夹具一律用合成路径**（`/api/__x_fixture__`），别借生产路径当例子；另外**本地复现 CI 请用 `bun run test` 而不是 `bun test`**，两者的进程模型不同。
- **但 `bun run test` 是 `backend && shared && frontend` 的 `&&` 串联——前一个包一红，后面的包一次都不跑**，而 CI 的 job 是并行的、会把三个包的红全报出来。于是本地「只有 1 条红」很可能是假象：修完那条再推，CI 照样红在你从没跑到的包上（RFC-266 实测：shared 的 fixture 红短路掉了 frontend，前端那条 i18n 守卫红只能等 CI 才暴露，多推了一次红）。**判据：本地出现任何红并修复后，别只重跑失败的那个文件——至少把被短路掉的下游包各自单跑一遍**（`bun run test:shared` / `bun run test:frontend`），或者拿 `;` 而不是 `&&` 串一遍。
- **i18n 文案里不许出现字面 `**`**（`onboarding-guide.test.tsx` 的 RFC-211 守卫全量遍历 zh/en 两棵树）：这些字符串大多进的是纯文本组件，`**强调**`会原样显示成星号。写 hint / 说明文案时用「」或直接不强调；只有`apiDocs.\*`（`api-docs-markdown.ts`拼成 markdown 过`Prose`）是白名单，且 `title`/`subtitle` 仍被排除在外。

- **改「不变量」时，真正危险的代码往往不在 diff 里**（RFC-287 G7 实测，双路实现门都没抓到）。G7 把「有任务行就有工作树」改成「准备完成后才有」，于是空 `worktreePath` 从罕见终态变成了**每个**准备中任务的正常状态。`util/safePath.checkLexicalThenRealpath` 一行没改，但它的输入分布彻底变了——而 `resolve('')` 返回的是**当前进程的 cwd**，实测 `existsInsideRoot('', 'package.json')` 返回 true、`readInsideRoot` 真能读出来，等于「任务还没有工作树」被当成了「工作树 = daemon 的工作目录」。两路实现门都在看 diff，所以都漏了。**判据**：凡是改动**放宽了某个值的取值范围**（新增空值/新增中间态/延长某状态的存活窗口），就必须去查**所有消费该值的既有代码**，而不是只审自己改的行；这类复核的产出常常不在 diff 里。空值守卫要放在**共用底座**上（`checkLexicalThenRealpath` 同时喂 exists 与 read 两个消费方，只堵一个必漏另一个）。
- **新增路由文件时，`gate:local` 看不见它的错误码——必须先 `git add` 再跑门禁**（2026-08-16
  实撞，CI 红在已推的 commit 上）：`route-error-code-coverage` 的**两侧**（被扫的
  `routes/*.ts` 与命名错误码的测试语料）都只取 **git-tracked** 文件。这是刻意的（见该文件
  头注：本仓工作树常带着别人未提的路由文件，基线随人而变的守卫比没有守卫更糟），代价是
  **全新的路由 + 全新的测试在 `git add` 之前对门禁双双隐形**：本地全绿，一提交 CI 立刻红。
  判据：CI 报 `no NEW error code ships without a test that names it` 而本地同一测试是绿的。
  **定式：新建 `routes/*.ts` 或其测试后，先 `git add`，再跑 `gate:local`。**
  顺带一条：错误码别写成 `` `code-${x}` `` 模板串——扫描器只认字面量，会**默认漏测**；
  而且事后没人 grep 得到 `code-unknown-binding` 是从哪儿抛的。
- **点开抽屉/弹层之后，点它里面的东西之前，必须有同步点**（2026-08-16 CI 实测）：
  `rfc253-script-node` 里「点画布节点 → 点抽屉里的 Events 页签」中间没有任何等待，CI
  shard 满载时抽屉尚未挂载，Playwright 对着**还不存在**的页签重试满 15s。报头是
  `locator.click: Timeout 15000ms exceeded`，读起来像「页签点不动」，实际是「它还没出生」
  ——两者的修法完全不同，前者会让人去查 CSS/pointer-events，白花时间。判据：click 超时
  且紧跟着一条对该容器内元素的 `element(s) not found`。修法是加**真同步点**
  （`await expect(page.locator('.inspector')).toBeVisible()`），不是加 timeout。
  注意 `gate:local` 不跑 e2e，这类只在 CI 现形。
- **CI-only 的 e2e 竞态多半是「重渲染把元素从 DOM 摘下来」**，修法是加真同步点而不是 sleep 或加 timeout（RFC-287 T14 顺手修的 intent-builder；同文件此前已有两次同类修复 `e82d04e3` / `c3146c36`）。症状是 Playwright 的 `element is not stable` → `element was detached from the DOM, retrying` 后超时，且**本地永远复现不了**——本地机器快，重渲染在点击之前就结束了。**判据**：先看那次点击前面有没有「会触发列表/面板重渲染」的动作（关闭下拉、提交表单、切 tab），有就 `await expect(<重渲染后才会出现的东西>).toBeVisible()` 作为同步点。加 `timeout` 只是把偶发变稀，不解决问题。
- **本地跑 e2e 前必须重建二进制，否则你测的是旧代码**（RFC-287 T14 实测，真被误导了一轮）。`e2e/harness.ts` 起的是 `dist/agent-workflow-e2e-<plat>-<arch>`——**构建产物**，不是当前源码。改完生产代码直接 `bunx playwright test` 会拿旧二进制跑，症状极具迷惑性：我据此得到一条「`repo-groups-new` 匹配到 2 个元素」的红，源码里那个 testid 明明只有一处，差点去追一个不存在的 UI 重复；重建后同一批 5/5 全绿。**判据**：跑 e2e 前先 `bun run build && bun run build:binary:e2e`；看到「源码与现象对不上」的 e2e 红，第一件事是查 `ls -la dist/` 的时间戳与你上次改动的先后。
- **测试可能把缺陷「锁成契约」——改行为前先问这条断言锁的是意图还是现状**（RFC-287 T14 实测）。G7 的目标之一是「启动接口不再同步阻塞到工作树就绪」，而当时那条用例测的正是 `await startTask(...)` 的**阻塞时长**；只要它在，任何人把启动改成异步都会看到红，然后很自然地以为是自己写错了。同一批还有一条自相矛盾的锁：断言锁住本地 `.catch(() => {})`，注释却写着「外层再由骨架统一记 warn」——两者不可能同时成立（本地先吞掉，外层的 warn 永不可达），说明写注释时的**意图**没有落进断言。**判据**：一条断言若在「实现变得更正确」时会红，它锁的就是现状而非意图，必须改测法；注释与断言互相矛盾时，必有一方是错的，别默认断言对。
- **「按 RFC 编号选测试」会漏掉不含该编号的锁**（RFC-287 T14 再次实测；与本节前面那条「用 `grep -rl` 按被改文件选」是同一件事的两面）。本轮针对性跑了 20 个「含 startTask/deferRepoPreparation」的文件全绿，完整门禁却抓出 2 条——`tasks.test.ts`（HTTP 路由面）与 `rfc103-launch-config-passthrough.test.ts`（kick 计数锁）都不含 `rfc287` 字样，也不含我选的关键词。**判据**：改动落在热路径（`startTask` / `runTask` / 路由）时，针对性跑连带面只能当**快速反馈**，不能替代完整门禁；`gate:local` 的红才是判据。
- **按计数断言的锁是「强制登记」机制，它红了通常说明你该登记而不是该改锁**（RFC-287 T14）。`rfc103-launch-config-passthrough` 断言 `...runtimeConfigOpts(` 恰好出现 N 次；新增一处调度器点火站点就会把它打红。这不是脆弱——RFC-108 / RFC-103 / RFC-266 三次「管理员配置对某条路径不生效」的静默断线，正是因为新增 kick 时没人想起要透传配置。**判据**：计数锁红了先确认新增站点是否**应该**纳入该不变量，是则连同理由一起把计数加一，别改成正则模糊匹配把强制力弄没。

## 新增 NodeKind（RFC-253 实测）

- **「加一个 NodeKind 要改几处」不要靠人肉清点——让编译器数**。仓内目前有 **8 处**穷尽点，`satisfies Record<NodeKind,…>` / `never` 守卫会逐个把你逼红：`shared/node-kind-behavior.ts`、`shared/nodePorts.ts`、`shared/workflow-node-references.ts`、`backend/services/runLiveness.ts`（`livenessSourceOfKind` 的 `never` 分支）、`frontend/canvas/WorkflowCanvas.tsx`、`NodeInspector.tsx`、`nodePalette.ts`、`shared/workflowNodeGeometry.ts`（`DEFAULT_NODE_SIZE_BY_KIND` 的 `Record<NodeKind,…>`）。RFC-253 的设计门（外部评审）只列出前 7 处，第 8 处是 typecheck 报出来的——**清单会过期，编译器不会**。
  - **这份清单自己就过期过一次，正好证明上一句**（RFC-317 T66）：第 8 处原本写的是 `canvas/wrapperFit.ts`，而 RFC-302 把 wrapper 几何收进 shared 之后，那个文件变成 107 行的 re-export 垫片，`grep -n "NodeKind\|satisfies\|never"` 一条都命不中——穷尽点搬到了 `shared/workflowNodeGeometry.ts:50`。**清单指着一个空文件时，读者不会怀疑清单，只会以为那处不需要改**；这比少列一处更坏。写这类清单时把「怎么自己数一遍」也写上（本条就是 `grep -rn "satisfies Record<NodeKind" packages/`），让读者有办法当场证伪。
- **但仍有不受类型约束的手写表**：`WorkflowNodePicker.tsx` 的 `categoryTabs` 是手写数组（`categoryLabels` / `categoryCounts` 是 `Record<…>` 会红，tabs 数组不会）⇒ 新分区能通过 typecheck 却在 UI 里**没有页签**。只有组件测试抓得到。新增 palette 分区时记得一并加。
- **新增 palette 分区 / 失败码 / 校验码会触发一批"覆盖棘轮"测试**，它们是设计如此、必须显式更新：`palette.test.ts`（分区 key 与 label 列表）、`palette-icon-coverage.test.ts`（glyph 白名单）、`i18n-phase-b.test.ts`、`workflow-node-picker*.test.ts`（分类计数与 `all` 总数）、`permission.test.ts`（`PERMISSIONS.length` 与 manager/admin 快照）、`rfc203-task-failure.test.ts`（每个 `FAILURE_CODE` 必须有本地化文案，否则降级成 `generic`）、`rfc203-validation-copy.test.ts`（每个 validator code 必须有精确词条）、`rfc224-execution-identity-failure-taxonomy.test.ts`（`FAILURE_CODES` 的组合顺序）。
- **`unmanagedReferenceWarnings` 的引用识别是按键名启发式（`/nodeId$/i` 等）**，对**用户可控键名**的字段会误报：一个叫 `FOO_NODEID` 的普通环境变量就会触发 `action:'abort'` 并卡住复制粘贴。正解是给描述符加 `opaqueFields` 显式声明「此子树是用户数据、按构造不含引用」，而不是让启发式去猜用户起的名字。
- **i18n 的 `zh-CN.ts` 里 `interface Resources` 与 `const zhCN` 是两段**，同一个键名在文件里出现两次。用脚本插入键时 `re.search` 会命中**接口**那一份（在前面），结果是把字符串字面量写进了类型声明。改 i18n 一律分别定位两段，改完 `bun run typecheck` 立刻能看出来。

- **第 9 处穷尽点——`services/intent/intentDoc.ts` 的 "Supported node forms"——自 RFC-348 起受编译器保护**（2026-08-30；此前 2026-08-08 实测它不在代码里、只有 `rfc234-intent-doc.test.ts` 的 NODE_KIND 枚举守卫兜底）。INTENT.md 不再手写任何 kind / 资源类型 / 字段字面量，而是由 `modules/intent/domain/teaching/` 的三张注册表渲染：`nodeKinds.ts` 的 `INTENT_NODE_TEACHING satisfies { [K in NodeKind]: NodeTeachingOf<K> }`（新 kind 编译红；8 种 strict kind 的字段表按 zod schema 键控，新增顶层 / 嵌套 / 变体字段也红；5 种 passthrough kind 的字段以 `types.ts` 的字面量 union 键控并带 `fieldSources` 读点，由 `tests/intent-teaching-registry.test.ts` 用 TypeScript AST 正反向核对），`resourceTypes.ts` 的 `INTENT_RESOURCE_TEACHING satisfies { [K in IntentResourceType]: … }`（intent payload schema 新增字段即红；平台侧 create schema 新增字段由 `reconciliation.ts` 的逐层键比较 + 对象覆盖棘轮在 `tests/intent-teaching-reconciliation.test.ts` 报红），`platformMap.ts` 的 `INTENT_PLATFORM_RESOURCE_MAP satisfies Record<AclResourceType, …>`（新 ACL 类型必须表态 intent-creatable / platform-only）。**所以新增 NodeKind 的第 9 处现在是「给 `INTENT_NODE_TEACHING` 加一条条目」**：`availability`（public / privileged{permission, redactedFields…} / synthesized-only）+ `fields`（每个非基础键一条 `{form, required, note?, mistake?, nested?}` 或 `{omit, why}`）+ `notes` / `mistakes`；passthrough kind 另填 `fieldSources`。红屏证据见 `design/RFC-348-…/verification-report.md`。八个常驻 `// @ts-expect-error` 夹具在 `tests/intent-teaching-exhaustive.test.ts`：想验证机制是否还活着，删掉一条指令跑 `tsc`，应看到 TS1360/TS2741，而不是 TS2578。另一条经验：**validator 读 passthrough 字段一律走 `readString / readNumber / readStringArray / readBindings` helper**，裸 `(node as Record<string, unknown>).x` 不在 AST 反向扫描的语法内，会让一个新读点悄悄逃过登记。

- **第 10–12 处穷尽点，同样不受编译器保护**（RFC-304 加 `code-round` 时实测，2026-08-15）：①`docs/workflow-yaml.md`——每个 kind 一个 `### \`x\`` 小节，**且标题里的英文数字计数**（"the thirteen kinds"）也被断言；②`tests/rfc199-workflow-validation-targets.test.ts`的 emission **计数** ratchet——新增一条`issues.push` 就涨 1；③`tests/fixtures/execution-capability-coverage.ts`——每个 kind 要有**指向真实文件 + 真实锚点文本**的证据条目（锚点文本不存在即红）。三处都只有跑 `gate:local` 才现形，typecheck 与 lint 全绿。
- **更一般的规律：本仓有一层「登记面」，是设计如此的护栏，但只有门禁能发现**。除上面三处外，同一轮还撞到：migration journal 计数（`upgrade-rolling.test.ts`）、`rfc199-workflow-writer-inventory` 的 workflow 写入方 allowlist（新增一处 `db.insert(workflows)` 就要登记）、`rfc301-task-launch-origin-architecture` 的 `startTask` 调用方 allowlist、`docs/env-flags.md`（RFC-284 T26：src 里每个 `AGENT_WORKFLOW_*` / `AW_*` token 都要有记载）。**省时做法**：新增「一个 kind / 一张表 / 一个 env 变量 / 一个 `startTask` 调用方 / 一处 `db.insert(workflows)`」之前，先 `grep -rn "<同类的既有值>" packages/backend/tests docs` 看它在哪些清单里出现过，一次补齐；否则就是「改代码 5 分钟、跑 7 分钟门禁发现漏一处」重复 N 轮。**正面样板**：`RunTaskOptions` 的 `satisfies Record<keyof RunTaskOptions, Disposition>`（RFC-284 T20）是同类护栏里做得最好的——**编译期就红**，不必等门禁。新增此类「每项都要表态」的清单时优先照它做。
- **给「永远绿」的负扫描配反向自检**（RFC-304 T11 实测）：负扫描的特征失败是**扫了个寂寞**——正则写错、目录改名、规则匹配零文件，它会永远绿并被当成证据。故每条负扫描都成对：正向扫真实源码、反向喂一段**故意违规的样本**给**同一个扫描器**且必须报。另配三条：目录存在性断言（改名会让扫描空过）、动态 `await import()` 变体（只查静态 import 会漏掉这个绕过形状）、「注释里提到禁用符号不算违规」（否则规则没法在它适用的地方被解释）。同轮还实证一条：**plan / design 里写的扫描目标可能已经不存在**——RFC-304 plan 要求扫 `SAFE_FORWARD_ENV`，而该符号已随 RFC-276 退役、当前代码零命中。**动手前先 grep 确认扫描目标真的存在**，否则写出来的就是一条永远绿的假护栏。

- **另一类只有门禁看得见的东西是「唯一性锁」，而它的正解通常不是把自己加进白名单**：仓内有一批「某个 idiom 在 `src` 下只准出现在这几个文件」的文本锁（`rfc284-microhelpers.test.ts` T7：`createHash('sha1')` 只准在 `util/hash.ts`，`createHash('sha256')` 只准在多步 builder 族 / raw-digest / 镜像桥那几处；`Math.max(Date.now()` 只准在 `util/time.ts`；`Promise.race([p, new Promise` 只准在 `util/process.ts`）。它报红时看着像「白名单漏登记了我」，**多数情况下它其实在说「你手写了一份已有 helper 的第二种拼法」**——单步 hex 摘要就该走 `sha256Hex`。2026-08-15 RFC-304 实测：我在 domain 里直写 `createHash('sha256')` 被 T7 拦下，正解是改调 `sha256Hex`，而不是往合法集合里加一行。**判据**：先问「这条 idiom 有没有现成 helper」，只有当自己确实属于被豁免的形态（多步 update / 非 hex 输出 / shared 侧无 node:crypto 的镜像桥）才登记，并把属于哪一类写进注释。

## 端口读点的「结算口径」（RFC-306 实测，2026-08-16）

- **凡是「读上游端口当前答案」的地方，行过滤必须是 done ∪ skipped，不能只认 done**。
  RFC-306 起 `node_runs.status='skipped'` 有了真实产生者（分支被关闭的节点）。
  `pickUpstreamSourceRun` / `buildFreshestSettledPerNode`（`services/freshness.ts`）如果继续 done-only，
  picker 会**跳过**那条 skipped 行、往前捞到更早的 done 行，于是下游拿到的是「已被后来的分支决策
  推翻的那一代产物」——症状不是报错，是拿着陈旧内容正常跑完。
  同一口径还决定 freshness：skipped 行若不进 freshest map，消费了它的下游永远判 stale ⇒ 每 tick 重派发（活锁）。
  **判据**：新增任何 `status === 'done'` 的行过滤前，先问「skipped 行落在这个语义里算什么」。

- **端口「没输出」与「输出了空」必须在库里可分**。二者在 RFC-306 之前同形（都是一行 content=''），
  于是任何「按端口决定要不要走下去」的设计都没有可判定的信号。RFC-306 用
  `node_run_outputs.active` 分开，且**默认 1**——默认值选错（默认 0 / 用 NULL 表示未知）会让存量行
  全部变成「未激活」，一次迁移就能让所有历史任务的下游读法改变。

- **给容器边界加字段时，「三层都要」**：子任务产物穿过 `call` 节点要经过
  DB select → `ExecutionOutcome` 值对象 → 父行插入三层，漏任何一层，语义都会在边界处**静默复位**
  （RFC-306 设计门 P1#6 实测：只在最终投影处写了继承，前两层没带，跨任务的分支决策全部复活）。

## iso / merge_state 生命周期（RFC-276 回归实测，2026-08-11）

- **凡是新开 iso 隔离（`persistIsoBase` 盖 `'isolating'`）的执行路径，成功收口时必须把
  `merge_state` 推进到 settled（`{NULL, merged}`），否则整个 scope 永久卡死**。
  `deriveFrontier` 的 D15 门规定：done 行只有 `merge_state ∈ {NULL, merged}` 才算完成——
  一条 done+`isolating` 行既不算完成也不可再派发，任务最终以
  「`scheduler stalled — blocked nodes: X(done: stale-done-in-invocation-dedup)` /
  `no ready nodes in scope`」收场。RFC-276（`70deb522`）把 readonly script 从「原地跑、
  merge_state 恒 NULL」改成「一律建 iso、成功后丢弃不合回」，丢弃路径漏掉 settle，
  用户在 webhook→script 现场撞上（webhook 只是入口；任何真 git 工作区 + readonly script
  都中，非 git 工作区因 passthrough 而幸免——这也是 rfc266 池测试没抓到的原因）。
  修复：`discard-readonly` 事件（isolating → merged，不经 pending-merge——经过它会打开
  「entry replay 把只读写入合回 canonical」的崩溃窗口），在 done 落库**之前**触发，
  保证不存在可观测的 done+未 settle 状态。回归锁：
  `rfc276-readonly-script-stall-regression.test.ts` + `rfc144-merge-state-transition-table.test.ts`。
- 排障捷径：任务报「调度停滞 / no ready nodes in scope」时，先看 `error_summary` 里
  blocked 节点的 `status: reason` 对，再查该 node_run 的 `merge_state` 列——
  `stale-done-in-invocation-dedup` + done 行十有八九是 merge_state 未 settle，
  而不是真正的新鲜度问题。

## 复用既有引擎 / 内核（RFC-271 三轮设计门实测）

RFC-271（多资源批量落地）三轮外部设计门共 39 条 findings，**至少五条同一根因**：自造了仓里
已有且已调试过的机制，而每次自造都恰好踩中那个机制当初为之而生的坑。这不是个人失误，是一类
系统性错误——下面四条是它的可操作形态。

- **多资源批量落地之前，先在仓里找有没有既成的 bundle / pre-stage / commit 内核**。
  RFC-271 初稿自造了「FS 暂存 → DB 事务 → FS 原子入位」，**方向与既有内核相反**，凭空造出
  「DB 已提交、FS 未发布」的不可收敛窗口。既有内核（RFC-234 建的）是
  **FS 先落位但 DB 行不可见 → 一个事务里翻可见**：`stageManagedSkill`（`skill.ts:313`）的
  契约白纸黑字写着「reserve（不可见行 + op 锁）→ 产文件 → 归档 v1，技能在
  `commitSkillReadyInTx` 之前一直 INVISIBLE，抛错即已补偿」，而 `commitSkillReadyInTx`
  （`skill.ts:304`）的存在理由就是「让 apply 事务把**许多** pre-staged 技能与 bundle 其余
  部分**原子地**翻可见」，还支持**预铸 bundle id**（`meta.id`）让同 bundle 引用在 insert 前
  就能解析。自造那条路的代价 `skill-zip.ts:415` 的注释早写清楚了：留下
  `versionState='legacy-unbackfilled'`、无快照，**单测能过但活 daemon 上每次 create 都挂**
  （单测环境里 RFC-170 的可用性门是关的）。

- **泛化一个既有引擎前，先把它的承重不变量列成清单——逐行读实现，不要读注释**。
  `applyChangeset.ts` 实际有 **12 条**承重不变量，而凭注释和函数签名能看见的只有六七条。
  漏掉的那几条恰恰最要命：replay 是 **committed / failed / unsettled 三态**（不是「总是返回
  receipt」）；claim 事务里 **duplicate 查询必须排在业务状态校验之前**（否则已 committed 的
  重放会因为 scope 此后关闭而报错）；journal CAS `prepared→applying` **之后**必须再校验一次
  身份（pre-stage 窗口里外部状态会变）；**DB 提交后任何 tail 异常都不得补偿、不得把 journal
  改 failed**（`committedReceipt !== null` 是错误处理的分水岭，而写 catch 块时把补偿逻辑放
  进去太自然了）。RFC-271 把这份核实过的清单落在
  `design/RFC-271-resource-config-package/invariants.md`，含锚点与原文引用，可作模板。

- **给模型看的 dump 投影 ≠ 可导入投影，别拿来复用**。
  `intentSecretSlots.ts` 的 `projectMcpForDump` 输出 `oauth: '‹redacted›'` 是**字符串**，而
  `McpRemoteConfigSchema` 要求对象或 `false`；它还把 argv 改成 `‹redacted›-arg-N`、删掉整个
  URL query 并追加说明文字。那是**展示**投影（给模型看形状、绝不给值），复用到「要能被导入
  回去」的产物上会同时造成密钥面错配、合法配置丢失、schema 解析失败三种后果。正解是复用它的
  **载体知识**（`SECRET_KEY_RE` / `looksHighEntropy` / URL userinfo 判定）另写一个
  schema-valid 的投影，并**逐 carrier 测试 + 断言脱敏后仍过各自严格 schema**——只断言「与某个
  既有脱敏函数一致」是没用的，那只会把同一份不完整集合锁死。

- **写路径的权限门可能只在路由层，新写路径不会继承它**。`commitMcpUpdateInTx`
  （`mcp.ts:180`）只校验 `expectedConfigHash` **不校验 owner**——owner 门在
  `routes/mcps.ts:375` 的 `requireResourceOwner`。任何绕过该路由的新写路径（批量导入、
  CLI、后台任务）都必须自己补一遍，且要放在**真正写入的那个事务里**（检查与写入之间权属可能
  转移）。判别定式：给内核加写路径前，先 grep 该资源现有路由里 `requireResourceOwner` /
  `assertPrincipalCanWrite` 之类的调用，逐个确认新路径是否覆盖到。

## 权限判据不止一套：审计前先把判据面取全（2026-08-09 实测）

问「有没有绕过权限直接读资源的地方」时，**按单一 ACL 去 grep 会得出大量假阳性**。
本仓的判据是**三套并存、各管一层**：

| 判据                                      | 管什么                                                                                               | 典型入口                                                                          |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **资源 ACL**（`services/resourceAcl.ts`） | 六类资源的**行级** owner / visibility / grant                                                        | `isVisibleRow` / `filterVisibleRows` / `canViewResource` / `requireResourceOwner` |
| **任务成员制**                            | 任务及其派生（评审 / 反问 / 澄清）——RFC-099 明确任务走**独立的成员制私有模型**，没有 visibility 开关 | `requireTaskMember`                                                               |
| **类型级权限点**                          | **全局配置**类（运行时注册表 / 设置），它们不是六类 ACL 资源、没有行级 owner                         | 路由声明 `permissions: ['runtime:read']` / `['settings:write']`                   |

实测数据（RFC-271 收尾审计）：六类资源表共 **106** 个直接 `.from()` 读取点，**全部
在 `services/` 下**（`routes/` 与 scheduler 不直接碰表）；ACL 判据函数 115 个调用点
分布 32 个文件；**没有 SQL 层可见性过滤**，判定全在内存。

「读表却不调 ACL 判据」的 15 个文件逐个归类后**无一是绕过**：

- **委托**给另一个统一判据（3 个）。范例：`webhook/triggerValidation.ts` 自己读
  `workflows.definition` 只为做输入映射的 kind-aware 校验，ACL 由它调的
  `assertScheduledTargetUsable` 全权负责——文件头注释写明「ACL/builtin/upload/
  launch-shape 全复用」。
- **不被 `routes/` import**（7 个：scheduler、五个 `skill*` 运维路径、workgroup 引擎）
  ——执行期与内部运维。符合 RFC-099「启动任务只校验工作流本身可用，**引用闭包隐式
  授权**」：闭包成员在启动那一刻已经授权过，执行中再逐个判反而与冻结语义冲突。
- **用户可达但用另一套判据**（reviews / taskQuestions / clarify 走 `requireTaskMember`；
  runtime / settings 走类型级权限点）。

**审计定式**：先列全判据面再做差集，否则「92 个读取点没有权限校验」这种结论会把
正确的分层误报成漏洞。反过来，真要找绕过，看的是**差集里既不委托、又被 `routes/`
import、又没有第二套判据**的那些。

## 序列化 / 往返（RFC-271 实现门实测，2026-08-08）

实现门在 RFC-271 上抓出 6 条 P1，其中**两条同一根因**：序列化器是对着「我以为的
schema」写的，而喂给它的单测 fixture 是**同一个人手写的 fake row**——形状正好也是那个
错的形状。实现与测试共享同一个错误假设，于是互相印证、全绿通过，而真实导出产出的是空壳。

- **凡「读行 → 产出可移植结构」的代码，fixture 必须来自真实建资源路径，且必须有一条跨实例
  往返**。RFC-271 里 `skills` 表根本没有 `bodyMd` / `frontmatterExtra` 列（内容在
  `managedPath` 的文件系统里），`workgroups` 也没有 `switchesJson` / `membersJson`（开关是
  各自独立的 boolean 列、成员在 `workgroup_members` 表）。两处导出恒为空，**零报错**。
  判别定式：给一个资源写序列化/快照前，先 `rg -n "export const <table> = sqliteTable" -A 40
packages/backend/src/db/schema.ts` 把真实列读一遍，别信自己对形状的记忆；然后写一条
  `建资源 → 导出 → 导入到另一个 DB+appHome → 断言真实行与文件` 的往返（模板见
  `packages/backend/tests/rfc271-roundtrip.test.ts`）。喂 fake row 的单测**不能**替代它。
- **fixture 断言里出现「非默认值」才有意义**。工作组那条用默认开关会让「根本没导出」与
  「导出了恰好等于默认」无法区分——往返 fixture 一律挑非默认值（`maxRounds: 7`、
  `shareOutputs: false`…）。
- **helper 写好了不等于接上了**。同一轮里 `redactArgv` / `redactUrlKeepingShape` /
  `redactPluginSpec` 三个脱敏函数在 shared 里齐全并有单测，`serialize.ts` 一个都没调；
  `convergeResourceBundleApplies` 也只有定义和测试、没有生产调用点。**加一个 helper 时，
  同一个 PR 里 grep 一次它的调用方**（`rg -n "<name>" packages --type ts`）——只出现在自己的
  定义与单测里就是没接上。

- **复合键的分隔符只能有一个定义**。同一轮还栽在：映射表的键在解析端与消费端各拼了一次，
  一侧的「空格」实际敲成了 `U+0000`（编辑器不显示），于是查表永远落空，human 成员被静默
  当成「用户选了不加入」整条剔除，**全程零报错**。同类手滑此前也发生过一次
  （`workflow.validator.ts` 的 `selKey` 被写进真实 NUL 字节，靠 `rg` 报「binary file
  matches」才发现）。定式：**键的拼接抽成一个导出函数**，两端都调它；分隔符用可见字符
  （`#`），不要用空格或不可见控制字符。提交前扫一遍：
  `rg -n $'[\x00-\x08\x0b\x0c\x0e-\x1f]' packages/*/src --binary`。

- **编辑表单的序列化必须「以行内原值为基底、只覆盖 UI 真正拥有的键」，不能「按 kind 重新
  拼一个」**（RFC-268 实现门 P1 实测，缺陷归属 RFC-257）：webhook 触发器向导只渲染 payload
  的一小部分（workflow=`inputs` / agent=`description` / workgroup=`goal`），而 payload schema
  允许更多合法键（agent 端口 `inputs`、`allowClarify`、`maxDurationMs` / `maxTotalTokens`、
  `workingBranch` / `autoCommitPush`）。`payloadOf` 是「按 kind 重拼」，于是任何人在界面上
  **只改一下名字**保存，PUT 就把那些只能经 API 设置的字段整体覆盖掉——**带端口模板的 agent
  触发器会丢光端口值**，全程零报错、零校验失败（新 payload 本身完全合法）。凡「UI 渲染的
  字段 ⊊ schema 允许的字段」的编辑面都有这个洞，PATCH 语义的后端也救不了（前端发的是整
  对象）。定式：Draft 里存一份行内原值（`payloadBase`），序列化 `{...base}` 后只写 UI 拥有
  的键，互斥字段在切换时**显式 delete**（删键，不要留成 `false`——`z.literal(true).optional()`
  这类 schema 会拒）。判据测试：造一个带 UI 不渲染字段的行 → 在 UI 里只改名字保存 →
  断言请求体逐键保留（模板见 `packages/frontend/tests/rfc257-trigger-payload-preserve.test.tsx`）。

- **一个 assert 函数同时承担两类校验时，调用方的 catch 必须按错误类别分流**（RFC-268 实现门
  P2 实测，缺陷归属 RFC-257）：`assertScheduledTargetUsable` 既查目标可用性（缺失 / 不可见 /
  built-in 不可调度）又查渲染后的 payload·输入合法性，而 webhook dispatcher 把它抛出的**全部**
  异常记成 `skipped-owner-invalid`。后果不止是错误信息难看：`skipped-*` 分支按设计不写
  `lastStatus/lastError`、不推进 `consecutiveFailures`，于是**配错的触发器永远触不了熔断**、
  卡片一直挂着上一次的旧状态，而枚举注释里明明写着 `launch-failed` 才是「owner 有效但启动
  失败（payload-invalid）」——**代码与自己的枚举语义矛盾，没有任何测试能靠读注释发现**。
  定式：catch 里按错误类（`ValidationError` vs `NotFound`/`Forbidden`）分流到不同 outcome，
  每类各写一条断言并配**反向锁**（「目标缺失仍是 skipped-\* 且失败水位不动」），否则下一次
  重构很容易把两条并回一条。

## 新写的 e2e spec 不跑一次就等于没写（RFC-310 T140 实测，2026-08-19）

一条 21 个 `getByTestId` 的浏览器旅程 spec 随批次提交、计划里注明「由 hosted CI 收口」。
提交前真跑一次，**头三个 testid 在前端源码里根本不存在**——写它的人从未执行过它。
判据便宜到没有理由不做：`grep -o "getByTestId('[^']*')" <spec> | sort -u` 逐个回 grep
`packages/frontend/src`，注意**动态拼接**的（`data-testid={\`x-${i}\`}`）要按前缀比对，
否则会把存在的报成缺失。

- **「本机跑不了、CI 会替我跑」通常是错的**：同一棵树上 system mock 套件与编译后 daemon +
  Playwright 都能起 listener。把「跑不了」写进计划的后果不是延后验证，是**没人再去验证**。
- **真跑一次的回报是复利**：这次往后走两步就照出一个生产缺陷——`useRef` 当「已卸载」标志位
  只在 cleanup 置 true、**挂载时不复位**，于是 `<StrictMode>` 的 setup→cleanup→setup（同一实例、
  ref 不重建）之后，那个页面永久认为自己已经关闭。单测想复现必须**在 `<StrictMode>` 里渲染**：
  「render → cleanup → render」是新实例、新 ref，写出来是空洞绿（我第一版就是，变异检验当场打脸）。
- **一条从未绿过的 spec 不该直接进 CI**：默认关（env 开关）+ spec 顶部写清首跑账与解除条件 +
  把 skip 登记进 `packages/backend/tests/test-suite-policy.test.ts` 的 `ALLOWED_SKIP_COUNTS`，
  比让主干红着诚实，也比悄悄删掉它诚实。
- **改动既有 spec 的选择器同样要真跑一次，而且「源码层守卫绿了」不能替代它**（2026-08-20 实撞，
  同一天内我自己踩的第二个形态）。我把视觉套件的 settle 锚点从 `a[href="/code"]` 改成
  `a[href="/memory"]`，并加了一条源码守卫「spec 里的锚点 == `NAV_GROUPS` 末行的 `to`」——**守卫
  当场全绿**，因为两边写的都是 `/memory`。但**渲染出来的 href 是 `/memory?tab=all`**（该路由带
  稳定默认搜索参数），精确匹配的 locator 匹配不到任何元素，于是每个场景都干等满 15s 可见性
  超时：下一轮 CI 从 `2 failed` 变成 **`26 failed`**，跑时从 1.5 分钟涨到 8.3 分钟。
  **教训不是「守卫没用」，是守卫锁错了面**：源码层断言只能证明「两处字符串一致」，它**看不见
  DOM**。凡是改选择器/等待条件的，唯一有效的验证是**用真浏览器跑一次**（本机 `bun run
build:binary:e2e` + `bun run test:visual -- --grep '<单个场景>'` 就够，几分钟）。判据也简单：
  看失败是 `toHaveScreenshot` 还是 `toBeVisible` 超时——前者说明等待条件成立、只是像素不同（正常），
  后者说明**选择器根本没匹配上**。
  修法用前缀匹配 `a[href^="/memory"]`，并把「必须是前缀匹配」也写进守卫——否则下一个人会「顺手」
  改回精确匹配，而那一次同样不会被守卫拦下。

## `gate:local` 不跑 system mock 用例（2026-08-19 实撞）

`scripts/local-gate.ts` 的 quality 车道原本是 typecheck / lint / format / depcheck /
shared / frontend，**没有 `test:system-mocks`**，而 CI 的 lint job 一直在跑它。于是
`packages/system-mocks/tests/*` 里的红用例可以在 `gate:local` 全绿的情况下推上主干，
CI 红一格才知道。已把它补进 quality 车道（约 18s），车道断言在
`packages/backend/tests/local-gate-runner.test.ts`。定式：**本地门禁与 CI 的命令集有差集时，
差集里的东西迟早会以「本地全绿 + CI 红」的形式找上门**——发现一处就补一处，别靠记忆绕过。

**同族但更隐蔽的一种：「隔离门禁跑了」≠「跑全了」**（2026-08-20，并发 session 实撞并自己
点破）。在分离 worktree 里过门禁时手动挑车道跑很常见（backend 车道最慢，容易被跳），但
**跳掉哪条车道，就等于那条车道里的全部守卫在这次收口中失效**。那次的巧合值得记住：跳掉的
正是 backend 车道，而他这批新增的性能守卫（`rfc311-perf-guards`）恰恰是**后端测试**——自己
刚立的守卫照不到自己。补跑 backend 全量后又揪出第二条漏网（两个新错误码没被
`route-error-code-coverage` 点名）。**判据**：隔离门禁只要不是完整的 `bun run gate:local`，
就在收口前明确写下「我跳了哪几条、它们各自保护什么」——写不出来就说明不该跳。

## 删端点 / 删能力时，`e2e/` 不在任何本地门禁的覆盖面内（RFC-271 批次 I 实测）

**2026-08-19 复发 + 现已有可执行守卫（RFC-310 PR-10）**：删掉三条 `/api/code`
写路由后本地全绿、CI 的 Playwright 腿红三条（e2e 仍在打 `PUT
/api/code/matrix/:repoId`）。这条教训在本文件里已经写了一年多，仍然复发——
说明「记住它」不管用，得让它在 `gate:local` 里红。现在
`packages/backend/tests/api-contract-coverage.test.ts` 有一条守卫：扫 e2e 里
`${daemon.baseUrl}/api/...` 形态的调用，**连 method 一起**比对契约注册表。

**method 是这条守卫的关键**：本次删的是 `PUT`，而同路径的 `GET` 还在——
只比 path 的版本会把那三条 e2e 全部放行（我第一版就是这样写的，变异检验
当场打脸）。任何「静态清单类」守卫写完都该做一次变异检验：把真实事故的形态
注入进去，看它红不红。不红的守卫等于没有。

**2026-08-20 又一种形态：改「执行策略默认值」同样绕过整个本地门禁（RFC-313 实测）。**
上面那条守卫盯的是 API 契约，而这次一行 API 都没动——只是给执行策略加了个**默认值非 0**
的新旋钮（`sessionRestartBudget: 1`），于是单节点 attempt 上限从 `1+retries` 变成
`(1+retries)×(1+restarts)`。**任何按 attempt 次数 / mock 调用次数断言的用例都会被翻倍**：
本地 `gate:local` 里撞出 5 个 backend 文件（当场修掉），推上去后 CI 的 Playwright 腿又红
4 条——`workflow-matrix` 的「耗尽重试预算」「超时套用到每次重试」、`runtime-scenario-matrix`
的同族两条。**e2e 不在 `gate:local` 覆盖面内，所以本地全绿照不到它们。**

可执行的做法（比"记住"有效）：

- 改动**执行策略默认值**时，先 `grep -rn "defaultNodeRetries" e2e/ packages/*/tests` 把所有
  显式钉住该策略的地方列出来——它们钉住它，正是因为要断言次数；逐处补上新旋钮的中性值
  （这里是 `sessionRestartBudget: 0`），断言一个字都不用动。
- **判据要从机制正推，不要从症状反向归纳**（RFC-313 实测，两次漏网换来的）。我先后用过
  「钉了预算的用例」「钉了预算 + 带时间预算的用例」两版判据，各漏一个，只能等并发 session
  逐个撞出来报回。正解是从机制推：attempt 上限翻倍 ⇒ **凡是会跑满重试的用例耗时都涨**。
  这类文件**既不断言次数、也不钉预算**，任何基于标识符的 grep 在它们身上零命中，
  **唯一可观测信号是耗时**。可执行做法：候选集用**结构性谓词**（会真起任务 = 调
  `runTask|resumeTask|retryNode` 且用 `MOCK_OPENCODE`），在「改动落地前的 SHA」与「当前」
  两棵 pin worktree 上逐个跑、比每文件耗时。RFC-313 用它一次捞出剩余 4 个（1.84x / 1.55x /
  1.46x / 1.09x），其余 41 个在噪声内。
- **风险不是只看倍率，是「倍率 × 距离硬顶的余量」**：上面那个 1.09x 的
  （`rfc131-review-reject-aging`）按倍率会被判成噪声，但它绝对值 4.82s **贴着 5s 单例硬顶**，
  四分片满载下实测就红。两者任一显著就要处置。
- **受影响的不只是「断言次数」的用例，还有带时间预算的用例**（RFC-313 实现门期实撞）。
  `rfc193-port-artifacts` 的 case 3b 一个次数都没断言，但它让一个「永远失败」的节点跑到底、
  并给了 5s 的用例超时；attempt 从 4 变 8 直接撞爆它。更阴的是它**不是稳定红**：第一轮
  隔离门禁里它侥幸跑绿了，下一轮才红。**归属判据用 A/B 而不是重跑**：在改动落地前的
  commit 上开一棵 pin worktree（记得先 `bun install`，否则报的是 `Cannot find package`
  而不是真实结果），同一条用例各跑 3 次：落地前 3/3 绿、落地后 3/3 红，归属就没有争议了。
- 推之前对这类改动**本地实跑一次相关 e2e**：`bun run build:binary:e2e` 后
  `bunx playwright test <spec> --project=chromium -g "<用例名>"`，两分钟的事，比让 CI 替你发现快得多。

`e2e/` **不在任何 package 的 `tsconfig.json` `include` 里**（backend 是
`src|tests|db`，frontend 是 `src|tests|vite/vitest.config`），而 `gate:local`
**不跑 Playwright**。删掉一条路由后，e2e 里对它的调用 **typecheck 看不见、
`gate:local` 全绿**，只有 CI 的 Playwright 腿会红。

⚠️ **lint 是覆盖 e2e 的**（我第一版把它一并写成「看不见」，是错的）：根级脚本
`lint:repo-ui` 跑 `eslint playwright.config.ts "e2e/**/*.ts" scripts/*.ts
--max-warnings=0`。所以**只跑 `bun run --filter <pkg> lint` 会漏掉 e2e**——
改完 e2e 必须跑根级 `bun run lint`（它 = 各 package lint + `lint:repo-ui`）或直接
`bun run lint:repo-ui`。RFC-271 的 e2e 修复第一版就栽在这里：把 YAML 读取移进 helper
后，两个 spec 的 `readFileSync` 成了未使用 import，`--max-warnings 0` 直接红。

RFC-271 批次 I 删了 `POST /api/workflows/import` 与 `GET /api/workflows/:id/export`，
三个 spec 仍在打前者（两个只是拿它当 fixture 装载手段，一个整文件测的就是这个能力），
本地门禁一路绿到 push，CI 才炸。连实现门的「查批次 I 有没有遗留死引用」也只扫了前端
源码，两边都漏了同一处。

**定式**：删任何 HTTP 端点前，扫描面必须包含 `e2e/`：
`grep -rn "<被删路径>" --include="*.ts" --include="*.tsx" . | grep -v node_modules`
（别只 grep `packages/`）。删除对应的守卫测试也应把 e2e 纳入扫描（范例：
`rfc271-capability-removal.test.ts` 的「已下线的端点不得有任何调用方（含 e2e）」）。

顺带两条：

- e2e 只能用**根** `package.json` 的依赖（它在仓库根运行，不属于任何 workspace
  package）。要用 `yaml` 这类库得先加到根 `devDependencies`，否则运行时 resolve 失败
  而本地 typecheck 完全不报（因为根本没检查 e2e）。
- e2e 里装载 fixture 应走**公开 API**，不要 import backend 的服务函数——那会让 e2e
  依赖一条产品上可能已不存在的路径，下次删它时 e2e 又红在与被测行为无关的地方。

## 诊断字符串要穿过好几道截断才到人眼前——补了信息不等于信息到得了（RFC-310 实测，2026-08-20）

现场：windows 那格的 Agent 动作红着，上层能拿到的全部信息是 `opencode exited with code 1`。
补了「非零退出时把 stderr 尾巴拼进 `errorMessage`」之后再跑一轮 CI，拿到手的是——**一截压缩过的
bundle 源码碎片**，真正的 `error: <message>` 一个字都没有。等于白跑一轮。

两道截断各切掉了一半：

1. **尾巴按总字节取尾 ⇒ 单个超长行能把整个窗口占满。** bundle 里的源码行是压缩过的
   **单行几十 KB**；Bun 打印未捕获异常时会把那一行原样吐到 stderr。只按总长度留最后 2KB，留下的
   就全是那一行的尾巴，写在它前面的错因整个被挤出去。**定式**：行式日志的滚动尾巴要**逐行先裁头**
   再拼（`clampTailLine`，保留行首——错因写在前面），一行吃不掉后续行的位置。
2. **下游又按头部截断一次。** `stepFailureDetail` 把 remediation `slice(0, 500)` 才写进
   `blockDetail`；`opencode exited with code 1; stderr tail: ` 这个前缀就占掉 41 字，剩下 459 字正好
   停在源码碎片中间。上游留了 2KB，到人眼前只剩 459 字——**而两处都不知道对方存在**。

**判据**：给失败回执补诊断信息时，从产生点到人看见的那块 UI，把沿途每一处 `slice` / 尾巴 / 列宽
数一遍；只要有两处以上独立截断，就得算一遍「最坏情况下人能看到哪一段」。别只验证「字段里有东西了」。

**顺带一条形状债**：`errorMessage` 的形状是跨层契约。它从 `opencode exited with code N` 变成
`…; stderr tail: …` 之后，`e2e/` 里三处 `toBe('… exited with code N')` 精确等值断言当场全红——
而 `gate:local` 不跑 Playwright，本地是全绿的（主干因此连红四轮，两个并发 session 各排查了一轮
才证明「不是我的」）。改任何会上浮到 UI / 回执的字符串形状前，先
`grep -rn '<旧形状片段>' e2e/ packages/*/tests/`；断言本身也该写成**前缀锁**
（`toMatch(/^… exited with code 23(;|$)/)`）而不是等值，让「后面允许追加诊断」成为契约的一部分。

**判据收一层（三次实撞归纳，2026-08-20）**：「e2e 不在本地门禁覆盖面」已经以三种形态咬过人——
删端点、改执行策略默认值、改错误消息的组成。三者的共同点是**都没动 API、也没动测试**，所以任何
「改了什么就跑什么」的直觉都不会触发去跑 e2e。可操作的判据是：**凡是改动会进入「被断言的字符串
或形状」的，就要跑一次 e2e**。`errorMessage` / `blockDetail` / `failureCode` 这类字段最阴——
实现者眼里是「给人看的日志」，测试眼里是**契约**。

## i18n 的 leaf key 不能带点：页面上看着好好的，门禁里才现形（RFC-310 T121 实测，2026-08-20）

给创建向导的预置步骤名做 i18n 时，我按 capabilityId 起了 key：
`code.employeePlaybook.standardStep['change.implement']`。**页面渲染完全正确**——i18next 的
`ignoreJSONStructure` 会在按 `.` 逐层查找失败之后，再拿整串当扁平 key 试一次，于是取到了值。

红在门禁：`packages/frontend/tests/i18n-batch-extraction.test.ts` 的 bundle 对拍会把两份 bundle
**按点扁平化**，于是它看到的路径是 `…standardStep.change.implement`，在对象里当然找不到那一层，
报「leaf 不是字符串」。

**定式**：i18n 的 leaf key 一律 camelCase、**不含点**；要按带点的标识符（capabilityId、
mediaType、`a.b` 形态的任何 ref）取文案时，在数据侧显式带一个 `nameKey` 字段做映射，别用
标识符本身当 key。**判据**：本地页面对、门禁报「leaf 不是字符串」⇒ 先看那个 key 是不是带点。

## 给模型的 prompt 就是生产代码（RFC-234 intentDoc 实测）

- **prompt 要过实现门，理由和代码一样硬**：2026-08-08 那轮 Codex 实现门报的 7 条里，两条 P1 **都在 doc 里**，不在代码里——INTENT.md 不是文档，是生成模型唯一读到的规格，一句措辞不当等价于一个 API 契约写错。
- **「doc 里有没有这句话」类断言抓不到真正的失败模式**：它锁得住措辞，锁不住**两条各自正确的规则交互后不成立**。实测：修 Codex P1-2 时写下「把 dump 里的 `‹redacted›` 原样回传」，读起来天经地义，实际不可执行——`findNonSentinelSecretCarriers` 无条件拒绝任何含该标记的字符串（`intentSecretSlots.ts:388`），而 dump 正是用它遮蔽，于是照 doc 做的 changeset 在到达权限门**之前**就 `intent-draft-invalid`。正解是**省略整个字段**，走 rehydrate 的「next 缺失 + previous 存在 ⇒ 取库里的值」分支。**只有驱动真实 `applyIntentChangeset` 的行为测试能发现这一类**（`intent-privileged-node-capability.test.ts`）。
- **写给模型的指示要按「可执行」验收，不是按「读着对」**：每加一条 doc 规则，问一遍「模型照这句做，端到端能不能过」。特别小心**嵌套字段**——`env` 是对象、标记在它的**值**上，「省略被遮的 key」有两种读法（丢 `env` 还是丢 `TOKEN`），必须写死是哪一种。
- **doc 里的清单一律从常量派生，别手抄**：动作目录派生自 `CODE_HOST_ACTION_DEFS`（必填字段直接复用校验器读的 `codeHostRequiredFields`，模型照填就撞不上 `code-host-param-missing`），trigger 字段派生自 `WEBHOOK_TEMPLATE_VARS` 并经 `webhookTriggerToken` 生成完整 token，要省略的字段派生自 `SCRIPT_REDACTED_FIELDS` / `CODE_HOST_REDACTED_FIELDS`。手抄的那天注册表一改，doc 就静默过期。
- **doc 承诺的规则要和强制它的代码成对断言**（`intent-doc-validator-contract.test.ts`）：只测 doc 写了什么，validator 一改 doc 就悄悄变错；只测 validator，模型压根不知道规则。两半一起断言，任一边漂移即红。这类缺陷的症状是最难查的那种——**changeset 应用得进去，任务永远起不来**。
- **prompt 只增不减且没有天然背压**，所以给它一条尺寸预算守卫（当前 INTENT.md 全权限约 18 KB，上限设 32 KB）：不是性能要求，是让下一次无节制膨胀出现在 review 里而不是上下文窗口里。
- **给既有的「按名字」引用加「按 handle」的精确形式时，新形式必须是可选叠加——做成必填等于静默废掉 doc 一直教的那条路径**（RFC-291 面 E 实测）：call 节点原本按 `workflowName` 建边（RFC-243 §5.3，dangle-tolerant，launch 时解析、ACL 按名字校验）。面 E 给它加 `workflowRef` 让模型能表达「同名两行里绑的是哪一行」，实现时顺手把 ref 写成必填 ⇒ **RFC-243 那组按名字建边的用例 19 条集体转红**，因为它们在 schema 层就被拒了。而 RFC 自己的 design §7.2 明写着「模型仍可按 name 创建」——是实现没照设计走。**自查**：新字段落地前问一句「doc 里现存的哪几种写法会因此变非法」，答案不是「零种」就得改成可选。
- **doc 里被契约测试锁住的句子不能顺手删，哪怕你写了「更好的那句」**（同上实测）：改 INTENT.md 的名字歧义段时，我用「加 handle 精确绑定」替掉了原来的「Ask the user which one instead of guessing」，`rfc234-intent-doc.test.ts` 立刻红。两条并不互斥——**有 handle 时精确绑定、无 handle 且同名歧义时问用户**，该共存。一般化：doc 段落的每一句都可能是某条测试锁定的契约面，改写前先 `grep` 该句在 tests/ 下的出现；真要替换，得同时给出「原契约在新写法下由谁承担」。

## 子进程与沙箱（RFC-253 实测）

- **`pumpLines` 的行流不能用来还原 stdout**：它 `if (line.length > 0)` 丢空行、也丢尾换行，所以 `a\n\nb\n` 会变成 `a\nb`。对 JSON 事件流无所谓，对「stdout 就是端口值」这类语义是**静默的数据损坏**。需要原文就单独开一条原始字节累加器，与行流分开。
- **`--unshare-net` 不等于无网**：它只隔离 **abstract** unix socket；pathname socket 归 mount namespace 管，而 `--bind / /` 会把 `/run/user/$UID/bus`（D-Bus，可经 systemd 执行命令）和 `/var/run/docker.sock` 一并带进来。真要断网还得 `--tmpfs /run --tmpfs /var/run`，且这仍是 best-effort（根仍是 RW bind）。
- **外层沙箱不是 jail**：Linux `--bind / /` 可写、macOS `(allow default)`，两者只遮 appHome 与几个 crown jewel 文件。任何「进程只能写 X 目录」的断言在写之前先去 `policy.ts` 核一遍。
- **「更严的那个写法」可能把业务全打挂——路径 deny 会连自己的 cwd 一起盖死**（RFC-281 T0 实测，claude 2.1.227 + macOS）：claude sandbox 的 `filesystem.denyWrite` 优先于 cwd 默认可写。cwd 在 `<appHome>/iso/<task>/<run>`、denyWrite 列 `<appHome>`（想挡兄弟任务）⇒ **agent 连 `echo > ./mine.txt` 都 operation not permitted**，等于所有任务写不了自己的工作区；改成只列具体兄弟目录才正常。同源结论：读面用宽 glob deny（`<appHome>/**`）会误伤自己 cwd，且 `permissions.allow` **挖不回**（deny 恒胜）。定式：**给"拒绝面"配路径前，先确认它不是自己 cwd 的祖先**；能靠默认行为达成的（sandbox 默认写=cwd+tmp+allowWrite，本就拒兄弟）就别再叠 deny——加固写法越严，越要有一条"自己还能正常干活"的正向用例。
- **测沙箱写边界别把实验台建在 `/tmp`**（同上实测）：claude sandbox 默认放行系统临时目录，`/private/tmp` 下的"兄弟目录写入"会**成功**，于是「默认写边界挡不住兄弟」的假阳性结论就此诞生。生产 appHome 在 `$HOME` 下 ⇒ **写边界实验必须在 home 下复测**（同一探针换到 `~/.rfc281-lab` 立刻得到相反且正确的结果）。
- **`Bun.spawn` 只在退出后返回，所以 pid 必须在 spawn 瞬间落库**：靠 `await child.exited` 之后再写，daemon 中途被 `kill -9` 就永远拿不到 pid，boot reaper 判 `no-pid`、孤儿进程活到天荒地老。用 `onSpawned` 回执在读取任何输出前写 `pid` + `spawn_binary_path`。
- **`mcpEnvIssues` 显式放行 `PYTHONPATH` / `NODE_OPTIONS`**（对 MCP 子进程合理），复用它去守别的进程时会漏：这两个变量正是「在用户代码第一行之前加载任意模块」的入口。另外「平台键最后覆盖用户键」只对平台**真的会设**的键成立——平台不设时用户值照样存活。要么剔除保留键，要么无条件写入。
- **argv 不过 shell，所以别把 `<` `>` 当 shell 元字符拒掉**：它们是 pip 的合法版本比较符，误拒会给用户一条完全误导的报错。真正该拒的是 flag 前缀、URL/VCS/路径形态与 `;&|\`$()` 这类。
- **Bun 的 `fetch` 错误形态和 Node/undici 完全不同：没有 errno，也没有 `fetch failed`**——实测 Bun 1.3.13/macOS arm64，**连接被拒 / NXDOMAIN / TLS 不匹配三种塌成同一个** `{ name:'Error', code:'ConnectionRefused', message:'Unable to connect. Is the computer able to access the url?' }`（而 `Bun.connect` 又是第三套：`code:'ECONNREFUSED'` + `'Failed to connect'`）。于是任何**照 Node 习惯**写的网络分类器（匹配 `ECONNREFUSED|ENOTFOUND|fetch failed`）在生产里**一条都不命中**，静默掉进 fallback 分支。真实事故（2026-08-07）：`services/mcpProbe.ts:classifyProbeError` 让每个连不上的远程 MCP 报 `internal-error`——而 RFC-030 §6 给这个码的语义是「**框架自己的 bug**」，等于把用户的排查方向整个带偏。同一课其实交过两次学费：RFC-116 的 `runtimeSmoke.ts:NETWORK_SIGNATURES` 早就把 `unable to connect` 收进去了。**判据**：写或审任何错误分类器，先在 Bun 里把真错误 `console.log` 出形状再写正则，别从记忆里写；顺带别猜第三方错误对象的字段名——MCP SDK 的 `SseError`/`StreamableHTTPError`（`client/sse.js:5`）把 HTTP 状态码放在 **`.code`（数字）**、没有 `.status`，message 是 `SSE error: Non-200 status code (401)`（**不含任何 auth 词，且第一个三位数是 200**），一次性废掉「`.status===401`」「message 里同时有 401 和 auth 词」「抓 message 首个三位数当 httpStatus」三种写法。
- **`HTTP_PROXY` 会把「连接被拒」变成代理的 5xx，而 Bun 在进程启动时就缓存了代理 env**：`delete process.env.HTTP_PROXY` 之后再 `fetch` 依旧走代理（实测无效，`{proxy:''}` 也无效），只有 `env -u HTTP_PROXY bun …` 这种**进程启动前**的清理算数。所以「断连应报 connect-failed」这类用例在配了代理的开发机上不可复现——要么 `skipIf` 掉并把理由写进注释（`mcp-probe-http-integration.test.ts` 先例），要么起干净 env 的子进程，别改成宽松断言把它糊过去。
- **Bun 的 HTTP 客户端（fetch 与 node:http 都是）对「快生产者」响应完全不背压——读 128MB 响应、逐 chunk 丢弃，RSS 峰值 680MB/580MB**（2026-08-18 RFC-310 PR-0 实测，本地环回 + node:http mock 流式产出）：消费循环慢一点（写盘/hash/1ms 延迟）也一样，字节先被吞进客户端内部缓冲，峰值≈甚至数倍于响应总量。**大响应（日志/附件/导出）绝不能在 daemon 进程里用 fetch 拉**——正确姿势是子进程下载器直接落盘（`curl -sS --fail -o <file> <url>`，macOS/Linux/Windows 10+ 三平台自带），daemon 只做登记 + `createReadStream` 流式 hash（64KB chunk，内存有界）。判据：任何「fetch 一个可能上百 MB 的 URL」的代码都要先量 RSS 尺度线性度（64MB vs 128MB 两点即可），别只在小 fixture 上看功能对。参考实现：`packages/backend/tests/helpers/rfc310EvidenceSink.ts` 的 `StagedFileRegistrar` + `tests/fixtures/rfc310-stream-probe.ts`。
- **RSS 断言必须在干净子进程里做**（同日同测）：RSS 是进程级指标，分片进程跑了几百个文件后堆基态/GC 时机把「峰值增幅 < N MB」这类断言变成掷骰子——单跑绿、四分片全量红。定式：把被测消费路径放进一个 fixture 脚本（`bun <fixture> ...` 子进程），探针在子进程里自测 peakDelta 并以 JSON 输出，父测试只断言输出。顺带：尺度对比（64MB vs 128MB 的 delta 差）比绝对阈值更能区分「真缓冲」与「分配器噪音」。
- **`Bun.spawn` 的 posix_spawn ENOENT 会冠名 argv[0]，即使真正缺的是 cwd**（2026-08-04 实测：`Bun.spawn({cmd:['/bin/echo'],cwd:'/不存在'})` 报 `ENOENT ... posix_spawn '/bin/echo'`）。沙箱包装下 argv[0] 是 bwrap/sandbox-exec，于是「任务 worktree 目录没了」显示成「bwrap 不存在」，把排查引向完全无辜的对象（真实事故：canonical worktree 指向已清理的 `iso/` 目录）。排查 spawn ENOENT **先查 cwd 再查可执行文件**；平台侧 runner/runtimeSmoke/systemAgentRun 的 spawn catch 已统一过 `util/spawnDiagnostics.ts:explainSpawnEnoent` 翻译，新 spawn 现场照接。另注意 bare 名与绝对路径的报错形态不同（bare 名缺失是 `Executable not found in $PATH`，不带 ENOENT）。

## 跨平台（RFC-254 实测）

- **`mkdirSync(dirname(p), { recursive: true })` 对「裸文件名」是一颗只在 Windows 上炸的雷**（2026-08-20 实撞，RFC-310）：`dirname('a.txt')` 是 `'.'`，而 `mkdirSync('.', { recursive: true })` 在 POSIX 上是 **no-op**、在 Windows 上**抛 `EEXIST: file already exists, mkdir '.'`**。这个写法几乎人人都在用，且在本机、在 CI 的 ubuntu/macos 两格全绿——只有 windows 那格红，症状还只是一个未捕获异常的退出码。**定式**：写之前先判 `dirname` 是不是 `'.'`/`''`，是就别建（本仓的单点是 `packages/system-mocks/src/runtime/mode-development.ts` 的 `parentDirToCreate`）。**回归锁要挑对断言面**：「在临时目录里写个文件不抛异常」这种测试在 POSIX 上用旧代码照样绿——一条在出问题的平台之外永远为真的断言不叫回归防护，要锁的是纯判据（裸文件名 ⇒ 不该有目录要建）。
- **windows runner 慢约 10x ⇒ 前端用例会撞上全局 `asyncUtilTimeout: 5000`，而真因往往是「预算分配」不是「这条慢」**（2026-08-20 实撞，RFC-311）：`tasks-list-children` 的一条用例在 windows 那格红在 `Unable to find [data-testid=…]`、耗时 **8225ms**，ubuntu/macos 同 shard 全绿。看报错像「子行没渲染出来」，但 CI 的 DOM dump 显示根行、展开箭头、`aria-expanded="true"` **全都对**——自动展开确实发生了，只是第二跳的数据没在 5 秒内到。
  - **真因不是它比别人慢，是它把整条链挤进了一份预算**：同文件「手动展开」那条的等待天然分成两段——先 `findByTestId(arrow)` 等根数据（吃一份 5s），click 之后再 `findByTestId(child)` 等子数据（再吃一份 5s）。而「自动展开」这条只有**一次** `findByTestId`，却要用**同一份 5s** 覆盖「根查询 → 识别 context root → 自动展开 → 子查询」整条三跳链。在慢 10x 的机器上只有它撞墙，其余用例（95–272ms）都够用。
  - 判据：**红在「找不到元素」但 DOM dump 里前置状态全对 + 只有 windows 红** ⇒ 先数这条用例用**几次** `findBy*`/`waitFor` 覆盖了**几跳**异步。一次覆盖多跳的就是嫌疑犯。别去改组件。
  - 定式：**确定性锚点与显式预算，两件事缺一不可**。①锚点——先等「请求真的发出去」再等 `client.isFetching() === 0`，既把「等够了吗」从猜变成可判定，又把多跳链拆回多段、与同文件其他用例结构对齐；②预算——锚点本身仍走 `waitFor`，默认吃的就是那 5 秒，不显式抬高则锚点再确定也照样撞同一堵墙。本仓 `testTimeout` 是 30s，多跳用例给 15s 余量即可（`tests/tasks-list-children.test.tsx:SLOW_RUNNER_BUDGET`）。
  - 出处：`packages/frontend/tests/setup.ts` 的 `configure({ asyncUtilTimeout: 5000 })` 管住所有 `findBy*` / `waitFor` 的默认预算，`vitest.config.ts` 的 `testTimeout: 30000` 是外层上限——两个数字要一起看才知道还有多少余量可抬。
- **`node:path` 的默认导出是「宿主口味」，解析别的平台的路径必须显式 `path.win32` / `path.posix`**：在 macOS 上 `dirname('C:\\Program Files\\Git\\cmd\\git.exe')` 返回 `'.'`（它看不见反斜杠分隔符），于是「从 git 推导 bash 路径」「把 git 目录加进受控 PATH」这类逻辑会静默算出垃圾值而不报错。RFC-254 里同一个陷阱在两处独立出现，是**测试**先抓到的（生产代码 typecheck 全绿）。凡是处理「另一个平台的路径字符串」，一律 `win32.dirname` / `win32.join`。
- **Windows 上「存在某个 `bash.exe`」从来不是充分证据**：`System32\bash.exe` 是 **WSL 启动器**，裸 `which('bash')` 找到它会把脚本跑进另一个操作系统、面对另一份文件系统视图；windows-2025 runner 上还额外装着 MSYS2 的第三个 bash。正解是从 `git` 推导（`<root>\cmd\git.exe` → `<root>\bin\bash.exe`，OpenCode 自己就这么做），推不出来就显式失败、不猜路径。
- **POSIX 上「agent 有 git」是白拿的，别的平台不是**：受控 PATH 写 `/usr/bin:/bin` 时 `git` 顺带就在里面，所以从来没人设计过它；Windows 把 git 装在 `C:\Program Files\Git\cmd`，不在任何系统目录下 ⇒ 只用系统目录拼的受控 PATH 会让 agent 的每一次 git 调用都失败。**通用判据**：受控/白名单式 PATH 每加一个平台，都要重新问一遍「这个平台上，我依赖的每个工具分别在哪」，而不是套用另一个平台的目录表。
- **Windows 环境变量名大小写不敏感 ⇒ 精确匹配的黑白名单是安全缺陷而非移植问题**，且方向因表而异：白名单只认 `PATH` 会**丢掉** OS 给的 `Path`（要求全大写的正则还会丢掉 `SystemRoot`，子进程连 winsock 都起不来）；黑名单只认 `NODE_OPTIONS` 会**放行** `Node_Options`。折叠必须收在一个单点上，各表一律走它。**配置校验类**的比较建议无条件折叠（不只 win32）——配置是跨平台流动的数据，在 Linux 上被接受、到 Windows 变成冲突是最难查的形态。

- **`tr -c` 的折叠粒度取决于 locale，不只取决于平台**：同一台 macOS 上 `printf '设计者' | tr -c 'A-Za-z0-9._-' '_'` 在 `LANG=zh_CN.UTF-8` 下折出 **3** 个下划线（按字符），在 `LC_ALL=C` 下折出 **9** 个（按字节）；GNU tr 恒按字节。所以「照抄 shell 的 tr 行为」这个目标本身是不存在的——移植时要**选一个**并写明依据，同时把测试从「逐字节等于 shell」改成断言真正要成立的性质（例如「同一个名字两次必须落到同一个状态文件」）。
- **块注释里出现 `*/` 会提前闭合注释**：把 sed 表达式（`s/.*iteration=\([0-9]*\).*/\1/p`）原样抄进 JSDoc 时，中间的 `.*/` 就是一个 `*/`，报 `SyntaxError: Invalid character` 且指的是注释中间。转义没用（注释里不解析转义），只能改写措辞。

- **框架自己管理的 worktree 不是「开发者的 checkout」——宿主的 git 偏好会改写它写进去的字节**：Git for Windows 默认 `core.autocrlf=true`，checkout 时把 LF 换成 CRLF。对开发者那是便利，对本平台是**数据被改写**：agent 往 worktree 里写字节、框架提交并重新物化、那些字节再作为端口值 / 喂给下一个节点的 diff / 模型读到的文件内容离开。实测形态是一条 e2e 断言看着莫名其妙——写进 `...\n`、读回 `...\r\n`。凡框架代管的仓库操作，`core.autocrlf=false` + `core.eol=lf` 要和 `core.longpaths` / `core.hooksPath` 一样用 `-c` 钉在**唯一那处** leading args 里（第二个注入点就是两份同规则漂移的由来）。**通用判据**：任何「平台写进去、平台再读出来、读出来的东西会流向别处」的存储，都要问一句「中间那层会不会替我改写字节」。
- **注释里讨论某个字面量，会把「数一数它出现几次」的守卫弄假**：本轮撞了两次——`process.kill(pid,'SIGTERM')` 与 `core.autocrlf` 都在注释里被大段解释，于是 `source.match(/…/g).toHaveLength(1)` 数到 2。守卫要先剥注释再计数；而这类计数式断言本身是有价值的（它锁的是「只有一处注入点」），不该因此改成宽松的 `toContain`。
- **`GIT_CONFIG_GLOBAL` 指向宿主 null 设备（win32 `NUL`）会打死 git-for-Windows 的每一条命令**：为隔离全局配置把 `GIT_CONFIG_GLOBAL` 设成「null 设备」是标准手法，但 git-for-Windows 是 MSYS2 构建——它认 POSIX `/dev/null`，**不认 Windows `NUL` 设备当配置路径**（把 `NUL` 当普通文件名去 `access()`，报 `fatal: unable to access 'NUL': Invalid argument`）。于是密封环境里每条 git 都失败，最毒的下游是 opencode 用 git 探测 worktree 失败 → 落 `global` 项目 / worktree=`/` → verified session 的 `path` 不再是 `""` → 身份校验在 `/path` 拒（RFC-254 续三十五，是 Windows verified 路径彻底不可用的元凶，且被上层 `mismatch` 兜底码掩盖）。**判据**：喂给 git 的「空配置路径」一律用 host 无关的 `/dev/null`（`platformExec.ts:GIT_NULL_CONFIG_PATH`，POSIX/win32 通吃），**别**复用宿主 null 设备常量（`nullDevice()`＝win32 `NUL`）——后者只适合 `git diff --no-index -- NUL`（git 对 diff 空侧特判 NUL）与真正的 stdout/stderr 重定向。真机对照实证：`GIT_CONFIG_GLOBAL=NUL` 失败、`/dev/null` 与空文件均成功。
- **win32 上「每次运行新拷一个大 `.exe` 再执行」会与 Defender 实时扫描竞争 → 服务端间歇瞬退，且 exec 层修不干净**：RFC-224/227 每次运行把 175MB 的 opencode 二进制新拷进私有密封目录再 exec；Defender（真机默认 ON）在拷贝落盘瞬间开始扫描并持锁，撞进扫描窗口就死——`Bun.spawn` 有 pid、是**进程瞬退**（exit code **5=ACCESS_DENIED**/段错误、零输出），launcher 见服务端 stdout 流关闭无 listen 行 → `bootstrap-failed`（易误判慢启动/超时）；死在 bootstrap 后半段时其半成品 store 还会连累 post-run scrub 报 `store-unsafe`。**关键教训：这不是单纯的「image-map 那一刻」竞争，exec 层挡不住**——真机实证两条 exec 层手段都不够：①`--version` 预热（先 exec 同一文件把扫描喂饱再跑 serve）②「瞬退即有界重生 spawn」——**组合起来 12 次只到 6 done（~50%）**，因为 Defender 也会在 serve **运行期**（bind socket / 落 store / JIT 新代码路径，都是 `--version` 覆盖不到的访问）把进程杀在**已过 image-map、尚未 listen** 的中段。孤立的 fresh-copy exec 重试探针会 12/12 收敛，但那只证明了 image-map 一层、不代表整条 serve 启动。**判据 + 正解**：Windows 上「写完可执行文件立刻 spawn」间歇 exit 5/段错误＝ AV 扫描窗口，但**别在 launcher 里堆 exec 层重试/预热**（治标、加延迟、脏敏感核心、真机只到 ~50%）；可靠解只有一条——**ops：对密封根目录 / 密封二进制加 Windows Defender 排除**（零代码、彻底，AV-vs-构建产物的标准做法）。曾并列的「②架构：密封二进制按内容摘要缓存复用、让 Defender 只扫一次」**已被真机证伪（RFC-254 T41，见下条）**：Defender 是每次进程加载期拦杀，不因「同一文件扫过一次」放行后续 exec。注：上述 ~50% 是**连发 10+ 次紧循环**的压测值（磁盘持续被 10×175MB 拷/删 + 持续 AV 压力），生产任务间隔拉开（模型调用本身数十秒）后实际失败率应低得多。（RFC-254 续三十五/续三十六记为唯一已知 win32 可靠性缺陷，见 `audit-backlog.md`。）
- **RFC-254 T41 真机证伪「内容寻址缓存能免扫」（ARM64 + opencode 1.18.13 + glm-5.2）**：上一条设想的「②架构：按源 digest 内容寻址、跨 run 复用同一份密封 `.exe`（每次 exec 前 + launcher spawn 前均重哈希＝安全等价）」已完整实现并四门全绿（POSIX 逐字零影响、win32-gated），但**对本缺陷无效**——把**同一份已落盘的缓存 `.exe` 反复 exec**，`serve` 仍 ~⅕–⅓ **零输出秒退**（30s 窗口 8 次探针：5 listen / 3 `EXITED-NO-LISTEN lines=0`；**密封目录 vs 未密封目录 4/5 vs 4/5 完全同率** ⇒ DACL/位置/文件名皆非因，先前「reuse 版 bootstrap-failed ×2 / disable 版 done ×1」实为同一 ~⅓ flaky 的抽样噪声）。即 Defender 在**每次进程加载期**拦杀镜像、**不因「扫过一次」放行后续 exec**，「只扫一次」前提不成立。有界 respawn 重试（4 次/launch）实测 10 launch 9 成，但仍有「连杀一簇」漏网（印证上面 exec 层 ~50% 老结论：retry 不是可靠解）。**结论**：内容寻址缓存**已连同其测试一并撤销**（不解本缺陷、且给 RFC-227 信任核心平添复杂度）；win32 verified 冷启动可靠性的**唯一确定解＝部署侧 Defender 排除**，operator 执行（需管理员）：`Add-MpPreference -ExclusionPath '<appHome / 密封根>'`（可加 `-ExclusionProcess 'opencode.exe'` 作补充）。此项应写进 Windows 部署文档作「装机必备」。

- **bun:sqlite 在 Windows 上于 GC 才释放 OS 文件句柄，不在 `close()`——这是 T31 后端红簇里压倒性的单一根因**（RFC-254 实测约 20+ 测试文件 + 2 个生产缺陷都源于它）。POSIX 上 `close()` 立即还句柄、且 unlink/rename/rm 一个开着的文件也照样成功（保留 inode）；Windows 两条都不成立：句柄要等对象被回收终结器跑了才还，且不能删/改/盖开着的文件。**三种打法**：①测试清理（afterEach/afterAll/finally 删含 `.sqlite` 的临时目录）→ 一律走 `tests/fixtures/tempDir.ts` 的 `removeTempDirSync`（先 `Bun.gc(true)` 再删，win32 内部判据）；②`beforeEach` 重建式的**单文件** `rmSync(dbPath)`、或就地 `cpSync` 覆盖活库 → 前置 `if(process.platform==='win32')Bun.gc(true)`；③被引用（describe 级 `let db`）的句柄 gc 收不掉 → close 后**显式置空解引用**再 gc。关键子结论：**JSC 的 `Bun.gc(true)` 能回收「词法在作用域内但已死」的局部变量**（rfc213/migration 实证 close 后不再用的 `const db` 被收掉），所以局部句柄多数只需一次 gc、无须改写；只有被更长生命周期引用的才要手工解引用。判据：Windows 上任何 `EBUSY: … unlink/rm/rename` 或 `EPERM` 对着一个刚 `close()` 过的 `.sqlite`/`-wal`/`-shm`，先想 GC，不是加时序重试（时间不 gate、GC 才 gate）。**生产面同理**：RFC-213 `swapInDbFile` 换库前、RFC-223 迁移都撞过——换库/删旧库前 `if(win32)Bun.gc(true)` 放掉无引用句柄（`rawCopyDb` 安全拷贝刚开过活库）。
- **Windows 不能 fsync 一个目录 fd（EPERM），openSync 目录本身也可能抛**：POSIX 惯用「rename 后 `openSync(dir,'r')`+`fsyncSync` 落目录项」的耐久优化，在 Windows 上整个抛 EPERM。rename 本就原子，目录 sync 只是掉电加固 ⇒ 一律 best-effort `try{…}catch{}`（本仓 `restore.ts fsyncDir` 是既有范式；RFC-254 补了 `skillMigrateOp.ts` 同款——不修则 RFC-223 技能身份 barrier 每次 boot 就死）。判据：任何对**目录** fd 的 fsync/sync 都要能被平台拒绝而不炸主流程。
- **git-bash 的 GNU tar 把 `C:\…` 当 rsh `host:path`**：Git for Windows 的 tar 在 PATH 里常抢先，`tar -czf C:\x.tgz …` 报 "Cannot connect to C:" 而非文件错。用绝对 `%SystemRoot%\System32\tar.exe`（bsdtar，与 macOS CI 同 libarchive 方言）——本仓 `util/archive.ts:tarBin()` 已封装并 export，测试里要 shell tar 就复用它，别裸 `Bun.spawn(['tar',…])`。
- **测试里的 `file://${winPath}` 是畸形 URL**：`file://C:\repo` 不是合法 file URL，git clone 之类会拒。用 `pathToFileURL(p).href`（得 `file:///C:/repo`）。同理断言 worktree/路径**形状**时用分隔符无关的正则（`/worktrees[\\/][^\\/]+[\\/][^\\/]+$/`），别只认 `/`——生产路径在 Windows 本就是反斜杠、是断言 POSIX 偏置。
- **测试要拿一个「能 spawn、能流式」的假二进制喂给运行时驱动时，别用单文件 shell 包装器、也别用 `bun -e`——用 `[process.execPath, 'run', <mock.ts>]`**：`#!/bin/sh` 包装器 Windows 不能 spawn；`.cmd` 包装器 cmd.exe 会 buffer stdout、流式协议永远收不到（RFC-254 runtime-smoke 实测 6/15）。直接 spawn bun 跑 `.ts` 三平台都原生流式，且 **`bun run <file>` 会把命令头之后驱动追加的 `--flags` 原样当 argv 转给脚本**（脚本忽略即可）；**不能用 `bun -e '<code>'` 替代**——bun 把 `-e` 之后的 `--flags` 当**代码**继续 eval（实测 `bun -e 'console.log(1)' --output-format x` 报 `output is not defined`）。需要「能跑但不说协议」的假二进制时同理：`/bin/echo` 只在 POSIX 存在（Windows 上会误判 spawn-failed），换成 `bun run` 一个只 `console.log` 一行噪声的临时 `.ts`。这就是 RFC-254 的 runtimeSmoke 命令数组缝（`SmokeOptions.binaryPath` 放宽为 `string | readonly string[]`，claude driver `buildSpawn` 补上 opencode 早有的对称缝 `pickRuntimeHead(runtimeBinary, runtimeCmd)`）。
- **当假二进制只能是「配置面单路径」（route/config 收一个路径、命令数组缝够不到）时，Windows 上分「一次性」与「流式」两种命**：①**一次性内容捕获**（如 `opencode models` / `--version`）——`.cmd` 里 sub-spawn `bun run` 会让**孙进程** stdout/stderr 经 cmd.exe 捕获不干净（真机实测 stdout 空、stderr 丢），但 `.cmd` 用 `type <数据文件>` 直接吐**自身** stdout 则干净（LF 保留无 `\r`、stderr 到位、exit code 传对）。规律：**Bun.spawn 能干净捕获 `.cmd` 自身写的 stdout（`@echo`/`type`），捕不干净它子进程写的**——所以把输出放进数据文件、`.cmd` 用 `type` 分发（内容进文件 ⇒ 零 batch 转义，连 `(Claude Code)` 的括号都安全；RFC-254 runtime-routes 即此解）。**这个结论只对 flat spawn 成立**：`detached:true` 在 Windows 上连 `.cmd` 自身的 stdout/stderr pipe 也会丢，表现为 exit 0 + 空输出；版本/枚举探针应仅在 POSIX 开 detached 进程组，Windows 保持 flat spawn，并继续用 `killProcessTree` 的 Job Object / `taskkill /T /F` 超时清理（2026-08-27 `spawnVersionProbe` 回归）。②**流式**——`.cmd` 无论如何 buffer，仍只能走命令数组缝或真 `.exe`；HTTP 路由收单路径又够不到命令数组缝时，该条 `skipIf(win32)`（机制已被命令数组缝的直测覆盖）。
- **TS：`Array.isArray(x)` 不收窄 `readonly T[]`**——它的类型 guard 是 `x is any[]`，而 `readonly T[]` 不可赋给 `any[]`，故**否定分支**里 `x` 仍是原联合类型。判别 `string | readonly string[]` 一律用 `typeof x === 'string'`（RFC-254 runtimeSmoke 缝实测：用 `Array.isArray` 时 `else` 分支的 `readonly string[]` 漏进 `runtimeBinary: string` 直接 typecheck 红）。
- **`process.kill(-pid, …)`（负 PID = POSIX 进程组杀）在 Windows 上是空操作**——Windows 无进程组，负 PID 既不报错也不生效，于是「超时/中止/取消后杀子进程」这类路径在 Windows 上**静默失灵**：子进程还活着，任务结算成 `unreaped`（RFC-254 实测——`systemAgentRun.killGroup` 让系统 agent 在 Windows 上超时后杀不掉、进程泄漏，第 6 个 Windows 生产缺陷）。凡要杀「子进程连同其后代」一律走仓内既有平台感知原语 `util/process.ts:killProcessTree(pid, signal)`（POSIX `process.kill(-pid)` 组杀、Windows `taskkill /T /F` 走树快照，或 spawn 时 adopt 的 Job Object 原子终止），别在新路径手写 `process.kill(-pid)`。判据：`grep 'process.kill(-'` 命中任何要跨平台跑的杀进程路径 = 潜在 Windows 缺陷（`opencode-models.ts` / `sealedSubprocess.ts` / `opencode.ts` 仍有几处，均在 POSIX-only 探测/密封链路，接手前先确认其平台面）。
- **`describe.skipIf(cond)` / `test.skipIf` 里 `describe.skipIf` 仍会 RUN describe 的函数体，只跳过里面的 `test`**——所以 describe 体里**顶层**（不在某个 `test` 内）的调用照样执行、照样抛。RFC-254 实测：给一个 POSIX-sandbox 渲染测试文件加 `describe.skipIf(win32)` 后 win32 上仍报 `1 error`——第二个 describe 体顶层有 `const bwrapArgs = renderNetlessBwrapArgs(...)`（在任何 `test` 之外），skipIf 之下依旧跑、依旧抛。修法：把顶层调用移进各 `test`，或按平台 guard（`const x = process.platform === 'win32' ? [] : render(...)`——反正 test 已 skip、值用不到）。**判据**：`describe.skipIf` 一个文件后若结果里仍见 `error`（区别于 `fail`），去查 describe 体顶层有没有会抛的调用。

## 平台面守卫（RFC-254 实测）

- **守卫规则要锁「被禁形态的字面量」，不要锁「使用它的调用形状」**：RFC-254 的第一版规则写成 `startsWith(\`${x}/\`)`，跑起来当场对**同一个文件里四行之外**的两步式写法失明——`const prefix = \`${ctx.worktreePath}/\``然后`.startsWith(prefix)`。锁调用形状的守卫，换个变量名就绕过；锁 `` `${x}/` `` 这个**路径前缀字面量**本身则绕不过。通用判据：问一句「把这行拆成两句还会不会被抓」，答否就说明锁错了层。
- **手写的「全量站点清单」必然是错的，而且三方会错出三个不同的数**：同一份 RFC 的站点盘点，作者写 4 处、外部评审 A 查出 6 处、负向扫描守卫实际扫出 10 处；PATH 那类同样是 4 / 7 / 10。最毒的是漏项**不是**风格问题——其中两处是真缺陷（插件 GC 会误删仍被引用的 generation；系统代理的 seed 路径校验会拒绝一切合法路径）。**清单驱动的改造 = 实现与测试共享同一个错误前提**，正解是先写「禁形态负向扫描 + 逐条注明理由的豁免表」，让计数由守卫产出，文档里一个数字都不写。
- **豁免表按「(规则, 文件, 匹配文本)」三元组精确匹配，并配陈旧棘轮**（条目不再命中就让门禁红）——与 `scripts/depcheck.ts` 的 `KNOWN_VIOLATIONS` 同形。按**文件**豁免会连带放过该文件未来的每一处新违规，正是这条老写法在 depcheck 里被修掉的原因。
- **扫描器必须自证「它真的看见了代码」**：加一条 sanity 断言（走查到的文件数 > N，且某个已知存在的形态确实被找到）。dependency-cruiser 曾因拿错 tsconfig 静默失明两年、期间一直报 0 违规——绿灯不等于干净。

## 前端

- **「编辑快照」型 query 的 key 不能落在任何 WS 前缀失效面之下**（2026-08-25 实撞，RFC-319 B81）：AclPanel / TaskMembersPanel / useActor 都把「授权仍然有效」定义为 `status === 'success' && fetchStatus === 'idle'`——后台 refetch 期间保留的数据**不算**当前授权（`useActor.ts` `currentActorAtRequest` 的注释就是这条不变量）。于是任何把该 query 打成 fetching 的失效都会被面板当成「失去管理权」：草稿整体重置、Save 先从 DOM 消失再以 disabled 回来、UserPicker 的 `onChange` 走 `if (!sessionIsCurrent()) return` **静默丢弃**刚选的人。TaskMembersPanel 的 key 曾是 `['tasks', id, 'members', rev]`，恰在 `TASK_QUERY_KEYS.detail(id)` 之下——那是 `useTaskSync` 的 reconcileOnOpen 前缀、也是每帧 `task.status / task.done / review.* / clarify.*` 的失效键；任务在跑的那几秒里打开面板必中。症状是「单跑绿、全量跑红」（单跑时任务早已跑完、没有帧），e2e `collab-multi-user.spec.ts`「grants a collaborator」在 Windows 分片上以 `locator.click: Timeout 15000ms`（Save 重渲染成 disabled）/ chip `toBeVisible` 不出现两种面目翻红。
  - 定式：编辑快照走**自己的顶级前缀**（`['task-members', …]`，同 `['acl', …]` 与 `task-questions` / `task-clarify-directives` 的既有出前缀），并在 `task-sync-rules.test.ts` 钉死「规则表发出的任何键都不是它的前缀」；**别**改成「fetching 也算授权」——那是 AclPanel / useActor 层面的设计不变量，不是单个面板的事。`useWebSocket.ts` 里 `resource-acl.changed` 刻意不碰 `['acl', …]` 的那段注释是同一条规则的另一面。
  - 判据：面板类 e2e 出现「Save 灰着 / 选了没落 chip / 按钮 detached 后回来变 disabled」，先查它的 queryKey 前缀有没有被某张 WS 规则表（`hooks/use*Sync.ts` + `reconcileOnOpen`）盖住，再谈时序。
- **弹窗打开后，页头那颗同名按钮"看得见但点不到"——用户点它 = 静默丢弃已填内容**（2026-08-19 用户实报，RFC-310）：症状是「我点击创建，弹窗就消失了，什么都没变化」。真相是 `Dialog` 的遮罩盖满视口，页头那颗**同名**「创建」（打开弹窗用的那颗）只是透过半透明遮罩可见，点下去命中的是遮罩本身 → 走 `closeOnOverlayClick` 默认的 true → `onClose()`，输入被丢弃且**不发任何请求**（判据：库里一行没多，说明根本没走到提交）。手会去够页头那颗，因为用户就是从那儿点开的。
  - 定式：**装着用户输入的弹窗一律 `closeOnOverlayClick={false}`**（本仓既有先例：`AgentPortDialog` / `tasks.new`），ESC / 取消 / × 三条关闭路径保留。纯展示型弹窗不受此限。
  - 回归锁的写法：`fireEvent.mouseDown(document.querySelector('.dialog__overlay'))` 后断言三件事——弹窗仍在、输入值仍在、**没有 POST 发出**（只断言前两条会漏掉"关了但请求发出去了"的另一种坏）。守卫要配正向对照：同一个 Dialog 不传该 prop 时 mousedown **必须**触发 onClose，否则你锁的可能是别的原因。
  - 判据（下次遇到类似"点了没反应"）：先查**那一下到底点在谁身上**。遮罩是全屏的，任何"页面上仍可见的按钮"在弹窗开着时都点不到；症状是「弹窗消失 + 数据零变化 + 无网络请求」时，几乎一定是误触遮罩而不是提交失败。
- **CSS 改动别肉眼跳过**：最小 repro HTML + `python3 -m http.server`（chrome MCP 拒 `file://`）+ chrome 截图 light&dark 验像素再推。
- **视觉基线刷新前先 `build:binary -- --include-e2e`**——**少了这个 flag 就白刷**：e2e harness 跑的是 `dist/agent-workflow-e2e-*`（`e2e/harness.ts:defaultBinaryPath`），而裸 `build:binary` 只产 `dist/agent-workflow-<platform>`。拿旧 e2e 二进制刷出来的是**旧页面**的图，且测试还会「通过」；判据是「删掉 png 重生成后与旧图字节完全相同」（RFC-248 实测踩到）。旧 dist 同样刷出「通过但错误」的图；`-g` 只刷单 scene；linux 基线取 CI artifact 不本地生成；`--update-snapshots` 对已存在 png 静默 no-op，必变 scene 先 `rm`。settings.png 只截默认(runtime) tab——子 tab 内改动无需刷基线。
- **窗口化列表必须常驻 `scrollbar-gutter: stable`，否则 Linux 视觉基线会间歇性红、用户会看到列宽跳动**（2026-08-19 实测，RFC-311）：虚拟列表的总高度是**测量出来的**（`estimateSize` 先给估计值、行测量完再修正），所以「这一刻要不要滚动条」在渲染早期不稳定。经典滚动条（Linux/Windows）一出现就吃掉 ~15px，容器内所有行整体左移；`/repos` 视觉基线因此在同一份代码上红-绿-红交替，差异图表现为**滚动容器外的表头不动、容器内的行内容整体偏移**（这是判据）。**macOS 是 overlay 滚动条、不占布局**，所以本地视觉套件恒绿、永远复现不了——只有 Linux CI 会红。修法是给滚动容器加 `scrollbar-gutter: stable`（`components/VirtualList.tsx` 现行形态，`virtual-list.test.tsx` 锁定），让布局与滚动条出现与否无关；改完 linux 基线要按既有规矩从 CI artifact 取新图。
- **LAN http = 非安全上下文**：`crypto.subtle`/`navigator.clipboard`/`randomUUID` 皆 `undefined`；「保存卡死/复制无效」先敲 `window.isSecureContext`（防线 `lib/sha256.ts`+`lib/clipboard.ts`+守卫）。
- **改 `tasks.status.*` 文案的两把暗锁**：zh 域禁「等待人工」子串（`node-run-duration-no-manual-marker` 守卫按 `JSON.stringify(tasks)` 子串扫）；en `awaiting_human` 被 `e2e/task-lifecycle-states.spec.ts` 锁死 `'Awaiting input'`。
- **`.tabs--segment` 换行兜底只在 `.auth-page` 域**；RFC-219 picker 分类条须横向滚动+箭头（全局化曾双层红）。
- **markdown/结构化文本的管线改动必须锁「渲染级」断言**（`render` + `<table>`/`<input>`/`<h1>` 等 DOM 产物 + 无字面 `|`/`===` 泄漏），不能只锁中间字符串 `includes`：评审页 diff 表格碎裂期间字符串层测试全绿、浏览器已烂（2026-07-30 修复的盲区；正例 `markdown-diff-table-render.test.tsx`）。
- **带 `/g` 的正则严禁做 `.test()`/`.exec()` 成员判定**：`lastIndex` 跨调用残留，同一输入间歇性漏匹配（markdownDiff identical 输入曾产生假 diff）。成员判定用非 global 兄弟正则或 `String.match`；已有 `ANY_MARKER_RE.lastIndex = 0` 手动复位的写法是次选。
- **删 i18n 键别用「缩进+键名」字符串 `replace`**：`"    generate: 'Generate',\n"` 会命中**更深缩进**的同名键（6 空格行天然包含 4 空格模式），把别人域里的键吃掉并粘连成一行。RFC-247 删 `account.generate` 时误删 `intent.journey.generate`，`tsc` 与 i18n parity 全绿（两文件+类型被对称吃掉），只有一条渲染断言变红。改 i18n 一律**带上下文锚定**（前后各一行一起匹配）并 `assert count == 1`，删完 `git diff | grep '^-'` 逐行过一遍。
- **设置页新加字段必须登记 `SETTINGS_CONFIG_SCOPE_KEYS`，否则保存被静默丢弃**（RFC-287 T10 踩过一次、RFC-311 又整批踩了 4 个键：`backupProtectedKeepCount` / `eventStreamRetentionDays` / `webhookTriggerFiresRetentionDays` / `taskArchive`）：该常量是每个设置分区**允许写回**的最小白名单，漏登记的键在 PUT 前被剔掉——界面能改、点保存**没有任何报错**、值不落盘，下次进页面又变回旧值。既有测试全都看不见它：bounds parity 只看边界、card surfaces 只看卡片结构、各 tab 渲染测试只看控件在不在，**没有人看「这个键能不能存下去」**。守卫在 `tests/settings-scope-coverage.test.ts`（扫每个 `useTabState(SETTINGS_CONFIG_SCOPE_IDS.x)` 片段里真实读写的 `state.<key>`，与该 scope 白名单对账）；新加旋钮时顺手加一条「改开关 → 点保存 → 断言 PUT body 带这个键」的用户级断言最保险。
- **`t('缺失.键')` 不报错，直接把 key 当文案渲染**：i18next miss 时返回 key 本身——没有异常、没有 warning，`tsc` 也看不见（键在**类型**里声明了、只是**值**没写，两个 locale 的值块是两处）。测试也抓不到，因为大家都用 testid / role 找按钮。守卫在 `tests/i18n-key-resolution.test.ts`：扫全部 `t('字面量')` 并在两个 locale 里 resolve，同时拒绝解析成对象的键（`t('a.b')` 指到命名空间会渲染 `[object Object]`）。带 `defaultValue` 的豁免；模板字面量键静态不可解，归各组件自己的测试。
- **用 chrome MCP / CDP 调试 xyflow 画布必须把标签页带到前台**：后台标签 `visibilityState==='hidden'` 时 rAF 与 **ResizeObserver 回调完全冻结**——xyflow 节点测量永远回写不到 store（`nodeLookup` 里 `measured:{}`、无 `handleBounds`），EdgeWrapper 对无 handleBounds 的节点**静默 return null**：现象是「节点都在、console 零警告、边一条不画、fitView 不跑」。这**不是代码回归**，前台打开同页面立即正常。2026-08-05 曾据此几乎误判「全站 xyflow 边渲染回归」，最终 `document.visibilityState` + 手动 `store.updateNodeInternals()` 实验才拆穿。判据：怀疑边不渲染时先在页面里跑 `requestAnimationFrame` 计数，0 触发即假象。
- **只读 xyflow 图的 edges 千万别放进 `useEdgesState`**：它只在**首渲染** seed 一次——之后 graph 重算（如边类型 checkbox）新边集**永远进不去**；且 xyflow 会在节点短暂未测量时派发 edge-REMOVAL changes，一旦被 `onEdgesChange` 应用，边被永久清空且无人恢复。只读图一律**非受控**：`edges` 直接传 graph 派生的 memo、不传 `onEdgesChange`（`PackageFlow`/`ClassFlow` 现行形态，`structure-graph-render.test.tsx` 源码级锁定）。受控 nodes（measure→layout 需要 `setNodes`）不受此限。
- **内容高度驱动（auto-height）的 Dialog 里放 xyflow 会得到 0 高画布**：xyflow 根节点 inline `height:100%`，而 Dialog 祖先链全是内容驱动高度，百分比解析不出来 → 图渲染进 0 高 `overflow:hidden` 盒子里，**DOM 全在、视觉全空、无任何报错**。修法不是加 min-height（那只救容器不救百分比子级），是把容器做成 flex column 并让 xyflow 根 `flex:1 1 0%; min-height:0` 从 flex 拿高度（`.structure-graph` 现行形态，`structure-graph-css.test.ts` 锁定）；真正的画布类 Dialog 直接用 `size="full"`（显式 `height: calc(100vh - 48px)`，`dialog-scroll-layout.test.ts` 锁定）。

- **源码里嵌真实 NUL 字节(0x00)会让 grep/ugrep 把整个文件当二进制静默跳过**:AI/脚本生成代码时想写 NUL 分隔符,若落成真实字节而非 \u0000 转义,后果不是编译错——是 grep 对该文件**零输出无警告**,git diff 显示 Binary file,肉眼像文件没改。RFC-258 实现期连中三个文件(scip.ts/snapshot.ts/indexCache.ts),表现为「明明 Edit 成功了 grep 却找不到」。判据:grep 突然对某文件全哑 → python 查 chr(0) in src;修法统一写 \u0000 转义序列。

- **「入口藏了」不等于「页面守住了」**：`AppShell` 的齿轮判 `settings:read`、`UserMenu` 判 `users:read`，看起来 `/settings` 是 admin 专属——但路由本身没有任何 `beforeLoad`，`sectionGroups` 又是零过滤的硬编码字面量，非 admin 敲 URL 就能拿到完整外壳与全部 11 个分区的名字和描述（一张管理面地图）。`lib/nav.ts` 里 `adminOnly` 的注释早就写明「过滤只发生在 ShellNavigation，非 admin 直输 URL 时页面自身再守卫」，只是 `/settings` 从没拿到那个自守卫（RFC-270 修）。**新增任何 admin 页时，入口过滤与页面守卫必须成对落地**；仓内两种守卫姿势都可以——`beforeLoad` 重定向（`routes/settings.tsx`）或组件内 `EmptyState` + `enabled: allowed`（`routes/users.tsx` / `memory.distill-jobs.$jobId.tsx`）。
- **`disabledReason` 这类「早就存在但零调用方」的能力钩子会假装功能已经有了**：`WorkflowNodePickerCatalog` 从一开始就接受 `disabledReason` 并接进了 `aria-disabled` 与置灰样式，只是没有任何调用方传它——读代码像「置灰能力已具备」，实际从未生效。而且它只挡了 click/Enter，**抓手的 `draggable` 是完全独立的第二条创建路径**，只测点击会让置灰变成纯视觉（RFC-270 补）。判据：给一个交互加禁用态时，把该组件里**所有**能产出同一结果的事件入口数一遍（click / keydown / dragstart / paste / 快捷键），每条各写一个用例。
- **把 hook 塞进 `WorkflowCanvas` 之前先想清楚它需不需要 QueryClientProvider**：十来个画布单测直接 `render(<WorkflowCanvas/>)`，没有 provider，裸 `useQuery` 在那里会抛「No QueryClient set」并把整棵树打挂——现象是一口气红七八个与你改动无关的测试文件。仓内既有解法是**provider 容忍**（`useWorkflowRefResolver` 的 `QueryClientContext` + 显式 `QueryObserver`，无 client 时降级），RFC-270 的 `usePrivilegedNodes` 照抄了它。顺带：`usePermission` 以前对 `data.permissions` 缺失会直接抛，现在失败关闭。
- **给 `createRootRoute` 加 context 会波及每一个测试自建 router**：`createRootRouteWithContext<T>()` 让 `context` 变成 `createRouter` 的**必填**项，仓内 12 个测试文件的 `createRouter({ routeTree, history })` 当场编译不过。需要在 `beforeLoad` 里读全局资源时，优先把依赖做成**函数入参**并在路由定义处注入单例（`assertSettingsRouteAccess(appQueryClient)`），既可测又零波及。
- **`redirect()` 抛出来的是一个 `Response`，目标在 `.options.to` 而不是顶层 `.to`**：断言写成 `(thrown as {to?}).to` 会拿到 `undefined`，而 `toEqual({to: undefined})` 对着 `toEqual({to: '/'})` 才会红——写成 `expect(x).toBeDefined()` 之类就直接假绿了。
- **e2e 里对 `<Select>` 按 Enter 之前，先等 listbox 拿到焦点**（2026-08-26 macOS CI 实撞，RFC-330）：`Select` 打开后是在 `setTimeout(0)` 里才把焦点交给列表 / 搜索框，`click()` 一返回就 `keyboard.press('Enter')` 在负载高的 macOS runner 上会抢在这个定时器前面——Enter 落在仍持焦点的 trigger 上，只是再 `setOpen(true)` 一次，列表永远不关（`aria-activedescendant` 已就位也救不了，它不代表焦点）。本地与 ubuntu 恒绿、只有 macOS 红是它的判据。姿势：`await expect(page.locator('[role="listbox"]:focus-within')).toHaveCount(1)` 再按 Enter（`e2e/rfc310-zero-config-onboarding.spec.ts` 的 `chooseActiveSelectOption`）。

## 依赖与审计门

- **跨大版本的扁平 `overrides` 会打破按旧 API 调用的消费者**：审计门报 `brace-expansion` 高危时，把它在根 `overrides` 里一刀切钉成 `5.0.9`，结果 eslint 全线 `TypeError: expand is not a function` —— v1 是 `module.exports = expand`、v5 换了导出形态，而 eslint 依赖链上的 `minimatch@3` 按 v1 调用。**先看公告命中的是不是多条不同大版本的线**（这次是 `<1.1.18` 与 `>=4.0.0 <5.0.9` 两条），是的话扁平 override 必错。
- **多数「传递依赖高危」根本不需要 override，`bun install` 重解析就够**：上例里两条线的 semver 范围（`^1.1.7` / `^5.0.5`）本来就允许补丁版本，旧 lock 只是钉在过期版本上；删掉 override 重装即得 `1.1.18` 与 `5.0.9`，各自留在自己的大版本里，公告两条命中同时消失。**先试重解析，再考虑 override，最后才是 IGNORED_ADVISORIES。**
- **依赖改动后本地 lint 绿不作数**：本机 `node_modules` 带着旧解析的残留，改 `overrides` 后 `bun install` 可能不会重链每一条路径，于是本地 lint 全绿而 CI 的干净安装立刻红。凡是动 `package.json` / lock 的改动，**以 CI 为权威**，别拿本地绿当结论。
- **代码没变而审计门突然红 = 新公告落到既有依赖上**，不是你这次改动引入的。判据：找一个**已经绿过**、且包含同一批依赖的提交（本次是引入 CodeMirror 的那个），确认它当时绿 ⇒ 归属为公告漂移。

## dev-env / daemon

- **本地 backend 并行只能用 `bun run test:backend` 的“完整 shard + 独立命名空间”，不能直接加 `bun test --parallel`**：历史实测后者让多个真实 daemon 争同一单实例 flock，跑满 420s 零结果；2026-08-07 的四 shard 原型给每个进程独立 `AGENT_WORKFLOW_HOME` + `TMPDIR/TMP/TEMP`，仍逐文件 `--isolate --randomize`，1051/1051 文件、9170 测试全绿，墙钟 264s（原串行 1030s）。隐藏的 `AGENT_WORKFLOW_TEST_SHARD_HOME/TMP` 由 preload 在每个隔离文件开头恢复，防某测试删除公开 env 后让下一文件落回用户真实 home。排查顺序依赖时用 `bun run test:backend:serial`；完整 push 门是 `bun run gate:local`，不要自己拼一条少门的快命令。
- **`bun dev` 中编辑 `packages/backend/src/**`触发`--watch` 重启**，race 30s graceful-shutdown flock → daemon 常 **DOWN\*\*（浏览器空白 + 503 + 误导「token 无权限」横幅），非崩溃；重启复活。纯前端编辑不掉。
- **claude-code 运行时直连 Anthropic**：daemon 从普通 shell 起若缺 `HTTP(S)_PROXY` → 403 被 smoke 误报「缺鉴权」；报缺鉴权先查 daemon 代理再查凭据。
- **claude code 在 uid 0 下使用 `bypassPermissions` 可能要求 `IS_SANDBOX==="1"`（精确字符串）**：RFC-276 后该标记由每个 `claude-code` runtime profile 的“Set IS_SANDBOX=1”兼容开关控制，默认关闭；关闭会剥离 daemon 继承值，开启才注入。root 运行且遇到该 CLI 拒绝时显式开启对应 runtime；这个变量只绕过上游 CLI 的容器/root 检查，不启用或证明 OS sandbox。
- **分离 worktree 里 symlink `node_modules`** 会把 `@agent-workflow/*` 解析回污染的 main → 假 typecheck 错；worktree 里 `bun install` 或信 CI。
- **CI 按你自己的确切 sha 查**：共享 main 上并发 push 会 cancel 你的 CI run；看含你 commit 的 superseding commit 的绿，按失败测试的 owning commit 归属。Codex `--base` 跨并发 commit 会把他人 diff 卷进复审——pin 到你的父提交（分离 worktree）隔离。
- **固定 `setTimeout` 等一个「事情会发生」= 墙钟赌博，负载高的 runner 必输**：`memory-distill-scheduler` 的重入用例先关闸、`release()` 后 `await sleep(80)` 再断言 `calls === 2`，对着一个 5ms 间隔的循环。本机连跑 5 次全绿、CI 的 macos shard 上 `Received: 1`（run 30886241395）。**判据是断言的方向**：证明「没有多余发生」（负向）只能靠固定等待，无法轮询；证明「某事已发生」（正向）必须**轮询到条件成立 + 一个宽松 deadline**。写成固定 sleep 的正向断言迟早会在别人的 PR 上红，而且看起来像别人的锅。
  **改轮询时必须轮询「终态可观察量」，不是中间信号**——同一条用例的第一版修复轮询了 `calls` 计数器（它在第二次 spawn **开始**时就自增），结果测试抢在状态写库之前往下走，把一个超时 flake 换成了一个顺序 flake（下一轮 CI 换个断言继续红）。正确的谓词是「两行都 `done`」这种最终结果。**自查方法**：问「我轮询的这个量为真之后，被断言的东西是否已经必然成立」；答否就说明轮询早了。
- **已知 flaky（别当真红）**：`centralized-answer-pane.test.tsx` cross-round digit-key `checked` race（macOS 尤甚，ubuntu 同 shard 绿即判 flaky，`gh run rerun --failed`）；`skills-split-page` escaped-mocks；根 `bun run test` 的 git-network flaky（已 gate 在 `RUN_GIT_NETWORK`）。
- **排查历史 run 别信 `node_runs.started_at`——它是「最后一次 mark-running」不是「首次起跑」**：`runner.ts` 的 `transitionNodeRunStatus(mark-running)` 每次都写 `extra:{startedAt: Date.now()}`，daemon 重启后的恢复重跑会**原地覆写**它，抹掉真实执行窗口。2026-07-27 任务 `…FBGHV4` 的 run `…D7AFVB` 实测：`started_at`=07-30 20:23:05、`finished_at`=20:23:13（读起来像「起跑 8 秒就崩」），但它的 52 条 `node_run_events` 全部落在 **07-27 04:54:06–04:59:25**（17 次 `tool_use`），ULID 内嵌时间戳更证明该行 mint 于 07-27 04:53:55——真相是「07-27 跑了 5 分半被停机 → interrupted 悬挂 3 天 → 07-30 恢复重跑 8 秒失败」。**三个时间源各管一段：ULID=行 mint、`node_run_events.ts`=真实执行窗口、`started_at`=最后一次 mark-running**；判执行时长/是否真正跑过一律以 events 为准（同批未经恢复的行两者只差 0~1s，差值大即恢复过）。
- **本地起验证 daemon 别把 `APP_HOME` 放 `/tmp`（macOS）**：`/tmp` 是 `/private/tmp` 的 symlink，撞 RFC-224 执行身份 store 路径的 no-symlink 判据，**每个**任务都在跑起来前落 `execution-identity-store-unsafe`，且报错不提 symlink、极易误判成权限/配置问题。隔离实例放 `~/aw-<slug>` 之类的真实路径（scratchpad 同理，只要最终 `APP_HOME` 落在 symlink 下就会中）。
- **原型 / 未定稿代码不能拿真实 `~/.agent-workflow` 跑启动路径——daemon 一起来就把 config 与 DB 单向改掉，代码撤回了数据撤不回**（2026-08-13 实测，RFC-296 原型）：一份后来被撤出工作树的 RFC-296 原型在真实 home 上起过一次 daemon，那一次 boot 就做完了三件不可逆的事——把 `config.json` 重写成 v2 形状（`$schema_version: 2` + 新增 `$config_revision`，并把 `scriptEnvTtlDays` 归零、`largeOutputThresholdBytes` 整个丢掉）、应用一条只存在于工作树里的迁移（ledger 记账 `created_at=1788278400029`）、建 5 张表 / 2 个 `node_runs` 触发器 / 6 个列。原型代码撤回后，下一个 session 拿到的现象是 **`bun dev` 直接起不来**：`readConfig` 报 `$schema_version 期望 1 实际 2` + `scriptEnvTtlDays 必须 > 0`（`config/index.ts` 抛 → daemon 退出码 1），而 vite 永远停在 `waiting for daemon to publish .daemon.info`。**报错完全不指向真凶**，只能靠 `~/.agent-workflow/logs/daemon.log` 里那行 `RFC-296 config/credential convergence complete source=v1 generationId=…` 倒查（generationId 与 config 里的 `$config_revision` 同 ULID 前缀，是唯一的关联线索）。三点定式：①带 migration / config 重写的未定稿代码一律先 `AGENT_WORKFLOW_HOME=~/aw-<slug>`（别放 symlink 下，见上条）；②撤回这类代码时**数据侧要一起撤**，否则等于给下一个 session 埋雷；③留在 `__drizzle_migrations` 里的孤儿记账行是二次伤害——正式迁移沿用同一个 `when` 会被 drizzle 静默跳过、换新 `when` 又撞上已存在的表，清理时必须连这行一起删。对账手法：把 `schema.ts` 的 `getTableColumns` 与 `pragma table_info` 逐表对，只多不少才说明是「残留」而非「缺迁移」。
- **改一个 revision 常量做「30 秒就改回去」的变异验证 = 一次不可逆的生产数据写入**（2026-08-23 实撞，RFC-317 变异实证）。上一条讲的是**原型代码**不能拿真实 home 跑；这条是它更阴的变体——代码**不是原型**，是 `origin/main` 上的正式代码，我只把 `modules/digital-employee/.../employeeTypePackage.ts` 里的 `revision: 7` 临时改成 `8` 去证明某条守卫能红，几十秒后就逐字还原了。**但那几十秒里 `bun dev` 的 `--watch` 重启了一次**，于是 21:59:35–55 之间发生了：注册 `development@8` 类型包 1 行 → **自动升级 8 个员工定义**（`type_revision` 7→8、`draft_json` 重写、`published_revision` 各 +1）→ 连带生成 `employee_work_scope_revisions` 8 行 / `employee_job_templates` 11 行 / `employee_job_template_revisions` 11 行 / `employee_tool_registrations` 3 行 / 同名 revisions 3 行 / `employee_definition_revisions` 8 行。代码还原后库里留下 `development@8`，用户下一次操作直接 `请求失败：employee type not found: development@8`。
  **机制（读源码确认，别靠猜）**：dev 的 overlay 是 `packages/backend/src/modules/digital-employee/application/typePackageDraftOverlay.ts` 的 `withTypePackageDraftOverlay`，由 `packages/backend/package.json` 的 `dev` 脚本经 `AGENT_WORKFLOW_DEV_TYPE_PACKAGE_OVERLAY=1` 打开（`cli/start.ts:277-281` 解析成 `'draft-overlay'`）。它**只对「同一 revision、descriptor 漂移」这一种情况在内存里挡**（`overlays.set(key, input); return`）；**revision 号本身变了**就意味着 `persisted === undefined`，直接落到 `store.ensureTypePackage(input)` **写盘**。也就是说这个 overlay 保护的是「你改了内容」，完全不保护「你改了版本号」——而后者恰恰是不可逆的那个。
  **定式**：①**版本号 / 主键 / 标识符类常量的变异验证，一律换隔离 home**（`AGENT_WORKFLOW_HOME=~/aw-<slug>`，别放 symlink 下，见上上条）——判据不是「代码是不是原型」，而是「这个常量会不会成为持久化行的键」；②要证明守卫能红，**优先在测试 fixture / 内存语料里造反例**，别动生产常量；③真撞上了，**先停 daemon 再动手**（不然 `--watch` 会边清边写回），备份 `db.sqlite`+`-wal`+`-shm`，然后按「升级产物带同一个可判别列」做手术回滚（本次判据是 `type_revision = 8`，20:32 的真实用户活动全是 7，分得干干净净）。
  **回滚时的两个真坑**：④**别用 `auto-upgrade-*` 这类前缀当删除判据**——它同时匹配到**更早那次合法升级**（6→7）留下的行，本次据此多删了 9 行 `employee_job_template_revisions` + 3 行 `employee_tool_registration_revisions`，靠「删除行数 ≠ 预期行数」当场发现并从备份补回。**判据必须是本次独有的那一列**（`type_revision=8`），前缀是跨批次共享的。⑤删之前先确认 `pragma foreign_keys`（本库是 **0**）与有没有 FK 指向被删表——都没有就**不会级联**，每张关联表必须显式清，漏一张就留悬空引用。收尾核对手法：把每张带 `type_id`/`type_revision` 的表的 distinct 组合与 `employee_type_packages` 现存集合对一遍，全 ✓ 才算干净。
  **这类事故 CI 结构上看不见**：CI 每次用全新临时库，跑的是「从零建库 + 升级」，永远不会遇到「库里有一个代码里已不存在的版本」。唯一的防线就是别在真实 home 上跑。
- **同一句 `employee type not found: development@N` 有两种成因，别按上一条的事故去套**（2026-08-25 实撞）。上一条讲的是「revision 常量被变异后留下的孤儿行」；这次是**正常升版**的必然后果，库里那一行完全合法：`development@8` 是 08-22 正式发布的修订，`employee_type_packages` 里 @1..@10 十行都在（`ensureTypePackage` 只 insert-if-absent，历史行永不删），而 `#types` 那张**编译期**注册表只装当前 build 的 @10。于是每次内置包升版，都会把上一版的岗位模板 / 工具 / 员工行整体孤儿化——凡是拿 `#runtime(ref)` 做存在性校验的查询都答不出来。**触发面是用户点得到的常规链接**：EmployeeCase 冻结了自己的 typeRef，`employee-cases.$caseId.tsx` 的「查看岗位模板」与 `TaskDigitalEmployeeSourceLink.tsx` 直接生成 `/digital-employees/development@8?view=jobs&jobTemplateId=…`。症状还很有迷惑性——**页头和职责图照常渲染**（`getType` / `getAuthoringManifest` 本来就走 store），只有三个面板 404，看着像「模板丢了」而不像「整版被孤儿化」。
  **通用规律（不限于数字员工）**：一类资源同时存在于**持久化表**和**编译期内存注册表**时，**读路径的存在性校验必须查表，只有写和执行才查注册表**。判据是「这次调用要不要用到只有编译产物才有的东西（codec / parser / validator）」——列几行数据不需要。修复见 `authoringService.ts` 的 `listTools` / `listJobTemplates` / `listEmployeeDefinitions` 改走 `#descriptor()`。
  **顺带一条错误信息纪律**：`#runtime()` 未命中时现在分两种答——库里还在 = 冻结历史，409 `employee-type-revision-not-executable` 并点名本 build 实际执行的修订；库里也没有才是 404。同一句 not-found 同时表达「你写错了」和「这版已成历史」，就是这次多花掉的排查时间。
- **门禁 5000ms 家族翻车前，先 `ps aux | sort -rk3 | head` 看基线——凶手可能根本不是 bun**（2026-08-12 实测）：三 session 约好门禁时间片串行后第三轮仍红，top 抓到基线已被吃掉 4-5 核：`fseventsd` 98.5%（**48 个 worktree ≈ 22 万文件条目**压在 FSEvents 监视面上，绝大多数属早已结束的 session；累计 CPU 3752 分钟）+ **Parallels VM 常驻 94.3%、突发 348%**（RFC-254 的 Windows 验收 VM 忘了挂起）。此基线下 4 分片门禁分片耗时膨胀 ~1.5×（健康 ~420-510s → 664-900s+），5000ms 硬顶家族必然间歇翻车、与并发 session 无关。定式：①跑门禁前看一眼 top，**Windows VM 不用就挂起**；②分片耗时整体 >600s 是「基线被吃」的指纹，先查环境再怀疑代码；③自己 session 的 pin worktree **用完立刻删**（`git worktree remove`），别给 fseventsd 留坟场；存量坟场清理属破坏性操作，呈报用户裁决；④隔离复跑仍是归属判据（每轮失败集**全量枚举**逐文件复跑，枚举命令别接 `head` 截断——同日三次栽在截断上）；⑤**全量跑测输出必须 tee 落盘再截尾**（2026-08-13 实测：全量前端一红、只留了 `| tail -6`，失败用例名随输出丢失，复跑两轮未再现 → 永久无法归属，只能在 backlog 留痕待复发对照）。
- **「CI 绿」与「CI 绿在含你改动的那棵树上」是两件事——祖先关系成立还不够，再抓一两个具体符号**（2026-08-14，由并发 session 示范）。共享 main 上你的 commit 常常是靠「含它的后继 commit 那条绿」来互认的，而那棵树上还混着别人的改动。只验 `git merge-base --is-ancestor` 只能证明**提交在链上**，证明不了**你改的那几行真的进了被测的那棵树**（rebase 冲突解错、他人 revert、`git add` 漏文件都会造成「提交在、内容不在」）。**定式**：认领一条别人 SHA 的绿时，顺手 `git show <绿的那个 sha>:<你改的文件> | grep <你新增的符号>` 抓一两个具体标识符，确认非空绿。
  两个边界条件，缺一条这个核验就会给假阳性：
  ① **抓的符号必须是本次新增的**（新函数 / 新常量 / 新字段 / 新错误码）。抓既有符号等于没抓——它在任何一棵树上都在，包括不含你改动的那棵。
  ② **它只证明「代码进了那棵树」，不证明「CI 执行到了它」**。要覆盖后半截得另想办法：确认本次新增的测试文件名出现在 CI 日志里，或者 CI 上确实有一条会因该改动而红的用例。别把它当成比实际更强的保证。
  同源的坑还有本地版：拿**陈旧 `dist/`** 跑 e2e 会得到一个源码里根本不存在的红/绿（本轮实撞，误导了一整轮），所以本地 e2e 前先 `bun run build && bun run build:binary:e2e`。
- **说「攒着下次一起推」之前先问一句「我确定还有下次吗」——收官前的最后一笔、或 session 末尾，「攒着」在语义上等于「不做」**（2026-08-15 实撞）。「小改动攒着，跟下一笔实质改动一起推」是对的省 CI 姿势（见本节 CI 判定饿死那条），但它有个**没人明说的前提：真的还有下次**。本轮末尾一个纯标点修正被判为「不值得单推」，而建议方隐含假设作者还有后续提交——实际那笔是收官后的最后动作，「下次」= 永不，改动会永久留在仓里不做。**判据**：提出「下次顺手」前先确认对方（或自己）确实还有计划中的提交；不确定就当场做掉，或显式交给一个有后续工作的人。
- **在测试里加同步点，等待时间是从某个隐式时间预算里扣的——加之前先问「扣的是谁的」**（2026-08-15 实撞，`e2e/intent-builder.spec.ts:126`）。`2a286abc` 为治一个重渲染 detach 竞态，在点击前加了 `await expect(dialog.getByText(/…/)).toBeVisible(…)`——**真同步点、不是 sleep,detach 确实治好了**。但那次点击的按钮只在 `props.inFlight` 为真时渲染，而 in-flight 窗口是 stub 靠 `STUB_INTENT_DELAY_MS: '900'` 撑出来的：新加的等待把这 900ms 吃掉一截，于是 CI 慢时窗口在点击前就关了、按钮从 DOM 分支里消失，**用一个竞态换了另一个竞态**。当时 commit 里写「是真同步点而不是 sleep」——这句只对了一半：它不是 sleep,但它消耗的是**另一个隐式预算**,而那个预算当时没人看见。
  - **判据**:这个用例有没有靠某个 stub 延时 / 动画时长 / 轮询间隔撑住一个「窗口期」语义(典型信号：`STUB_*_DELAY_MS`、`inFlight`、`pending`、`streaming` 之类的条件渲染)?有的话，任何新增等待都在花那个预算，必须重算窗口够不够。
  - **正解方向**:窗口期语义不要用「够长的延时」实现，做成**确定性握手**(stub 阻塞到测试显式释放，如 hold-file),这样加多少同步点都不影响。**把延时调大不算修**——只是把偶发变稀，属于本仓禁止的「重跑就过」的变体。
- **同一个人连推两笔也会饿死自己的 CI —— 「查 CI」的前提是那条 CI 还活着**（2026-08-14 实测，上一条的单人版）。上一条讲的是多 session 互相 supersede；这次是**我一个人**在 CI 还没出结果时又推了一笔修复，把 `f6ebe122` → `c4e5da8e` → `3bfc93ed` 三条 run 依次顶没，最后只剩链条末端那一条能判。CLAUDE.md 的「推完立刻查 CI」在这种情况下会失效——你查到的是 `cancelled`，既不是绿也不是红。**定式**：共享 main 上，**前一条 CI 未出 conclusion 前不要推下一笔**；手上的 commit 攒在本地等它。**判据**：push 前先 `gh api "…/actions/runs?head_sha=$(git rev-parse origin/main)" --jq '[.workflow_runs[]|select(.name=="CI")]|.[0].status'`，是 `queued`/`in_progress` 就等。注意非主 CI 的 workflow（`git-protocols-e2e` / `windows-platform` 等）**不会**被 supersede，照常跑完——所以「有几条绿了」不等于主 CI 判定成立。
- **多 session 高频推送会把 main 的 CI 判定「饿死」**（2026-08-12 实测）：四连 supersede 后没有一轮 CI 完整跑完（各轮取消前均无失败，e2e/Windows/binary smoke 全程零判定）——每个人的 exact-SHA 看护都只看到 cancelled。解法是**推送窗口化**：全员持推 10-20 分钟让一轮 run 出 conclusion（实测持推约 10 分钟即拿到全绿），链上各 commit 按「superseding commit 的绿」互认。与门禁时间片是同族问题的远端版。
  - **判据别落在「我这笔风险大不大」，要落在「main 上有没有人正在等判定」**（2026-08-15 二次实撞后与并发 session 共同归纳）。同一天又四连 supersede（`74181b90`→`2ad8c692`→`7e0bfe00`→`64844a32`），顶掉别人的几笔**全是纯文档改动**——正因为「反正不影响测试」，推的人完全没有停一下的理由。**「少推」是不可执行的规则**：谁都觉得自己那笔够小、够安全，于是人人合规而判定面照样被吃光。可执行的版本是把判据换成一个**可查询的外部状态**——就是上一条那个 `gh api …?head_sha=$(git rev-parse origin/main)` 查 CI `status`，`queued`/`in_progress` 就攒在本地等。它对**任何**改动一视同仁，纯文档也不例外。
  - **这件事不可能靠自觉收敛，因为代价完全不对称**：被顶掉的一方付出全部成本（等、重挂轮询、重新归属判定），顶人的一方零成本，且**全程无感**——GitHub 不会告诉你「你刚打断了谁」，`cancelled` 只出现在受害者的查询结果里。缺少反馈回路的行为不会自我修正，所以**必须在 push 前主动查一次**，把那个看不见的状态显式读出来。推送窗口化是发现拥堵后的补救；push 前查 status 是让拥堵不发生。
- **integration-opencode 撞新 runner 镜像红 = 环境非代码（2026-07-30 实锤）**：RFC-227 real-binary 用例在 `requireRootOwnedBwrap` 抛 `provider-parent-unsafe`（bwrap 祖先链逐级 root-owned + 无 group/other-write 判定），只发生在 ubuntu-22.04 镜像 **20260726.241.1**；同一 commit（def3d252）attempt 1 新镜像红、attempt 2 旧镜像 20260720.234.2 绿，且 `sealedSubprocess.ts`/该测试/workflow yml 在窗口内零提交——同代码双镜像对照实锤镜像内 bwrap 路径祖先属主/权限漂移。处置：`gh run rerun` 换镜像可过；根治需失败时打印祖先链逐级 uid/mode 诊断后针对性适配（勿放松判定），撞到新镜像的红先按本条归因、别追代码。

- **视觉回归「N 个失败」≠「N 张要改」——同一 test 内的 `toHaveScreenshot` 是短路的**：首个断言失败即中止该 test，后面的截图**根本不会执行**，因此改完第一张，第二张才在下一轮 CI 浮出来。2026-08-01 连踩三次：`table-edge` 遮住 `tasks.png`、`dynamic-workflow-preview-canvas` 遮住 `dynamic-workflow-preview`，每轮只暴露一张，白推三次。改基线前先 `awk '/^  test\(/{t=$0} /toHaveScreenshot\(/{print t" -> "$0}' e2e/visual-regression.spec.ts` 清点同 test 多截图的位置（当前只有 `/tasks list` 与 `dynamic-workflow preview` 两处），把同组的一次性处理完。
- **视觉回归一轮 CI 只会告诉你一部分要改的图——`test.describe.configure({ mode: 'serial' })` 会让同组后续用例「根本没跑」**（2026-08-20 实撞并两轮验证）。RFC-310 的侧栏新增分组让全站基线一起失效，第一轮 hosted run 结尾是 `25 failed / **7 did not run** / 13 passed`；刷完 25 张后第二轮是 `2 failed / **6 did not run** / 37 passed`。`did not run` 的那些**没有实拍 PNG 可取**，所以「下载 artifact → 逐张审 → 提基线 → 再跑」这条 README 流程在全站级变更下天生是多轮的。
  **机制不是 `maxFailures`**（本仓 `playwright.config.ts` 与视觉 workflow 都没设过它，我第一次记账时想当然写成了它，是错的）：`e2e/rfc250-visual-states.spec.ts:531` 有 `test.describe.configure({ mode: 'serial' })`，组内 9 个用例**一个失败即中止其余**。第二轮里 `task-wizard-dirty-desktop` 失败 → 同组剩下 **6** 个未跑，与报告数字逐字吻合。
  **推论**：serial 组里若有 K 张基线要刷，最坏情况就是 **K 轮 CI**（每轮只暴露一张）。估工期时按组内待刷张数算轮数，别按「首轮报了几个 failed」算。判据：`grep -n "describe.configure" e2e/*.spec.ts` 先看哪些视觉 spec 是 serial 的。

- **视觉基线会在阈值之下无声漂移数周，然后被一次正当的大改动一次性引爆**（2026-08-20 查清，与并发 session 联合排查）。门禁是 `maxDiffPixelRatio: 0.002`——1280×800 上等于**允许 2048 像素**。于是任何改动只要落在这个额度内就**永远不会红**，基线也就永远不会被刷：本次 `homepage` 磁贴的 Agents/Workflows 计数早在 08-17（RFC-307 引入示例数据）就从 1/1 变成了 2/3，但那只有 **255 像素**（两个数字的字形）= 0.025%，于是它带着一张 **07-28** 的基线一路绿到 08-19。直到 RFC-310 给侧栏加了一个导航分组（约 5000 像素）把总量顶过阈值，**三周前那笔早该记账的差异才和新差异一起浮出来**。
  同一次里 `inbox-*`(139/156px)、`workflow-editor-1280-inspector-dark`(117px)、`dynamic-workflow-preview`(469px)、`settings`(1190px) 全是同一形态的陈年欠账；只有 `tasks`(9060px = 0.88%) 自己就超阈值，而它恰好也来自同一个 commit。
  **推论一（归因）**：视觉红的差异**不必然全部来自被怀疑的那次改动**。归因前先看基线图自己有多老——`git log -1 --format='%h %ad' --date=short -- e2e/<spec>-snapshots/<scene>-chromium-linux.png`；基线若比嫌疑窗口还老，**整个搜索区间就是错的**。我们两人一共提了三个假设（跨用例累积播种 / 某 commit 改了 harness 启动参数 / `seedDemoContent` 曾经抛异常），全部错在默认答案落在窗口内。
  **推论二（审图）**：逐张肉眼看很贵且容易漏小块。省事的机械判据是**按 X 轴把差异分成「侧栏内」与「侧栏外」两堆**——侧栏位移是已知预期，侧栏外的才需要解释。（把 PNG 用 `sips -s format bmp` 转成无压缩位图后直接读像素即可，不必引入 PNG 解码依赖；**注意 sips 产出的 BMP 高度为负 = 自上而下行序**，按经典的自下而上翻 Y 会得到上下颠倒的包围盒，而 X 不受影响——这个错很能骗过人。）
  **配套：归因工具与「该不该刷」是两件事**（并发 RFC-311 session 提供了前者，2026-08-20）。在两个 SHA 的干净树上跑同一套、只比失败集合的差（`comm -13` / `comm -23` 两份 `spec.ts:LINE` 清单），能把「基线新旧 / 本机字体 / 机器负载」这些**共模干扰**约掉，用来证明「我这次改动零视觉变化」非常硬。但它**回答不了「这张基线该不该刷」**：阈值下攒的欠账在 ctl 与 mine 两边都红，`comm` 双向都空，按差分是「与本次无关」——而那张基线确实必须刷。**差分管归因，像素分堆 + 阈值账管该刷哪些**，缺一不可。（跑差分时注意：`--max-failures=0` 对 serial 组的中止**无效**，见上一条；能拿到完整集合是因为 `visual-regression.spec.ts` 本身没有 serial 组。）
  **推论三（不要顺手抬阈值）**：这次能发现三周的欠账，正是因为阈值没被抬过。红了先按上面两条分类，别用「改阈值」把可见性一起关掉。
- **`--update-snapshots` 会无条件重写「测试实际通过」的截图**：差异在 `maxDiffPixels`/threshold 内的快照也照写不误，直接 `git add` 会把一堆无谓的基线改动混进 commit。正解是先跑一次**不带** `--update-snapshots` 的 `bun run test:visual` 拿到真实失败清单，再更新、并把不在清单里的 `git checkout --` 还原。筛选时注意 `grep -w` 把连字符当词边界：`dynamic-workflow-preview` 会匹配进 `dynamic-workflow-preview-canvas`，用全名精确比对。
- **本地 `bun run test:visual` 跑的是 `dist/agent-workflow-e2e-*` 预构建二进制（前端嵌在里面），不是当前源码**：改完前端不重新 `bun run build:binary:e2e` 就跑，测的是旧产物——据此做的「撤掉改动前后对照」实验完全无效（两次跑的是同一份旧二进制）。CI 每次从源码构建，所以本地绿/CI 红或反之，先怀疑本地二进制陈旧。
- **共享树有他人半途态时，`build:binary:e2e` 出来的二进制可能 daemon 都起不来——视觉「49 场景全红」是 harness 崩溃不是像素差**（2026-08-18 实撞：对方在制的路由改动让 `createApp` 的 RFC-247 route-metadata 覆盖检查抛错，37 个场景齐红，报错全是 `daemon closed with code 1 … before printing ready line`）。判据：视觉红先看错误文本是像素 diff 还是 harness 起不来；是后者就别读 diff 图了。定式：刷视觉基线一律在**分离 worktree**（pin 到自己 commit）里 build + run——与 Codex review 的 worktree 纪律同源。
- **滚动容器边缘的焦点环被裁：修法是容器的 `scroll-padding`，不是内容的 `padding`、也不是
  条目的 `scroll-margin`**（RFC-304 实测，三次才对）。症状：某条目的**盒子恰好结束在
  scrollport 边缘**，浏览器据此认为它「已完全可见」→ focus 时**根本不滚动** → 外扩的
  focus ring 画进被裁区。因此：①给内容加 `padding-bottom` 不动条目位置，白改；
  ②给条目加 `scroll-margin` 只在**真的发生滚动**时生效，此处不发生，也白改；
  ③正解是给**滚动容器**加 `scroll-padding-block`——它改变「可见」的判定，于是浏览器愿意
  滚那几像素。实测（1280×800，侧栏 scrollH 989 / clientH 800、scrollTop=0）：末条 nav
  项底边 800、room 0 → 加 `scroll-padding-block: var(--focus-ring-gutter)` 后底边 792、
  room 4。
  **注意本地 `focus-ring-clip.spec.ts` 抓不到这一例**（darwin 上加不加都绿，原因未查明），
  但用十几行探针直接量「末条目底边 vs scrollport 底边」可以稳定复现——**守卫跑绿不等于
  没有该缺陷**，怀疑时自己写探针量几何量，别只信守卫。
- **视觉基线的 darwin 侧对「palette 滚动容器底部的新条目」不稳定**：RFC-243 给 node picker 新增 CALLS 分区后，本地 `bun run test:visual` 对 `workflow-editor-1536-three-rail-light` / `1179-palette-light` 时绿时红，diff 图显示**只有 CALLS 两条目**有文字位移重影（约 3.3k~3.8k 像素、ratio 0.01），页面其余部分逐像素一致——底部条目受滚动位置/字体加载时序影响。**ubuntu（CI 权威门）稳定绿**，故未改 spec；再有人在 palette 末尾加分区且撞到同一抖动，正解是截图前显式把 palette 容器 `scrollTop=0` 或对该区域加 mask，而不是抬阈值。

- **只挂 `setInterval` 的后台清理循环 = 在「重启比周期还频繁」的部署上一次都不会执行**（2026-08-21 生产实测，RFC-311 余项）：某生产跑 v0.18.11（**已含**事件归档的字节水位 `765910a3`），`node_run_events` 仍长到 78.6 万行 / 1.72GB。水位算法本身没问题——把开发库按同形放大到 78.6 万行 / 2.6GB 实测，归档器一拍削 20 万行、4 拍收敛到 20 万行 / 389MiB，单拍 1151 条语句里只有 2 条 >50ms。**问题全在装配**：`startEventsArchiver` / `startTaskArchiveSweeper` 都只挂了 `setInterval(1h)`、没有 boot 首拍，而那台 daemon 发版/重启比一小时更勤，于是两个「给库体积封顶」的执行者形同虚设，表只涨不缩。三条定式：
  ① 凡是**给某个无界资源封顶**的周期任务，boot 也要跑一拍（延迟 30s 让迁移/备份/恢复/巡检的开机风暴先过去，见 `services/daemonCadence.ts` 的 `MAINTENANCE_BOOT_FIRST_PASS_DELAY_MS`；纯扫描类如 lifecycle 巡检 5s 即可），并且 `stop()` 要连未触发的首拍一起撤——否则 DB 关掉之后定时器还会去碰它。
  ② 周期循环的配置一律**每拍热读**（`() => loadConfig(Paths.config)`），别读 boot 快照。`startWalCheckpointLoop` 曾经是快照，且 `intervalMs<=0` 时直接返回空 handle、**进程里连 timer 都不存在**：把 `walCheckpointIntervalMs` 从 0 改成 600000 之后不重启 daemon 永远不生效，而现象只是「-wal 照涨」，没有任何日志指向真凶。
  ③ 这类洞**单元测试天然抓不到**——既有用例都直接调 `archiveEvents()` / `runTaskArchiveSweep()`，跳过了装配层。判据必须写在 ticker 上（「boot 后 N ms 内跑了第一拍」「stop() 撤得掉未触发的首拍」「0→N 不重启即生效」），见 `tests/rfc311-maintenance-boot-tick.test.ts`。
  排查同类现象（「某个清理器为什么没生效」）的第一顺位不是算法，是**这个循环有没有机会跑过**：查 daemon 连续在线时长（`grep 'lock acquired' logs/daemon.log`）与该循环自己的 INFO 行是否出现过。

## 跨任务并发（RFC-243 起）

- **跨任务锁序约定：持有任务 A `writeSem` 的临界区不得等待任务 B 的任何锁或终态。** RFC-243 的调用节点是唯一跨任务组合点，靠「writeSem 只在派生/合并两个短窗口持有、等待子任务阶段零锁」满足（`services/callNode` 语义内联在 scheduler 的 `runCallWorkflowNode`）；新增任何跨任务等待路径都要先对这条约定过一遍。
- **call 行的领养禁 mint**：`nodeRunMint` 咽喉的 `abandonSupersededMergeStates` 会把旧世代 iso 连带作废——而 call 行的 iso 是**子任务的 canonical**。恢复/重入一律锚定被派发行原地复位（`setNodeRunStatus allowedFrom:['interrupted']` 逃生舱，wrapper 先例），只有显式 retryNode 才换代（retryNode 会先级联取消该行仍存活的子任务，再 mint 新代）。领养判据看的是「这一代是否已收尾」而非单看 running/interrupted——daemon 关停的收尾会把调用行落 canceled，漏掉它就会重复发起第二个子任务。
- **daemon 关停期绝不把子任务的 `daemon-restart` 中断当成失败**：子任务的 abort 常常先于父任务的 controller 落地（`abortAllActiveTasks` 顺序遍历一张表），所以 `signal.aborted` 不是判据；判据是「子任务 errorSummary=daemon-restart」+ 有界等待父 abort 确认。误判的代价是父任务直接 failed（而非可恢复的 interrupted）、调用行离开领养集、resume 重复发起子任务并让旧子任务成孤儿（RFC-243 实现门实测）。
- **单进程内模拟 daemon 重启的测试**必须等 `activeTasks` 清空再 resume，否则 `resumeTask` 撞 `task-active` —— 那是测试假象；真实重启后该表天然为空。
- **子任务的「删除/回收」都要看两代**：`deleteTask` 双向门（父有活后代 409 / 子的 owning call 行未收尾 409）；`runIsoWorktreeGc` 对 interrupted（可复活）父任务与「call 行引用非终态/interrupted 子任务」的容器都必须跳过——iso 容器里住着子任务的 canonical（设计门 P0-2 的教训）。
- **枚举扩面（新增 NodeKind）踩过的 ratchet 清单**：rfc167 调度分流源码锁、rfc188 装配站点计数、rfc223 身份指纹 multiset、rfc233 containment 注入计数、RFC-048 subagentLiveCapture 转发计数、S-14 非状态写点快照、rfc217 G5 mode 分支棘轮、migration-0041 列数、upgrade-rolling journal 冻结、node-kind 结构不变量（isProcess=agent∪wrapper∪call）。加 kind 后全量跑一遍 backend 按清单逐项登记，别一个个撞。
- **嵌套 git worktree 的四条实测事实（RFC-248，git 2.50.1 上跑过真实命令）**：①`git add -A` 会把嵌套仓**当 gitlink（mode 160000）提交并告警**——RFC-075 自动提交推送用的正是 `add -A`，不处理就推出坏子模块指针；②`.git/info/exclude` 是 **common-dir 级**的，写进去会污染同一镜像的**所有**任务 worktree，per-worktree gitdir 下那份**无效**；③sparse 模式文件 `$GIT_DIR/info/sparse-checkout` 反而**是** per-worktree 的（与 ② 相反，别凭直觉推）；④`worktree add` 到已存在的非空目录直接 fatal ⇒「挂载点被外层仓内容占用」必须做成启动期显式失败。回收顺序**按挂载深度倒序**（git 能自愈——先删外层会把内层标 `prunable`、再删返回 0 且注册表干净，但别依赖它）。
- **`.gitignore` 里的挂载路径必须转义 `* ? [ ]`**：不转义时 `/a[b]/` **既不排除** `a[b]/` **又错误排除** `ab/`——双向都错，且静默（RFC-248 PR-1 实测）。
- **挂载点/路径查重必须与「是否嵌套」判定用同一套折叠规则**：macOS 大小写不敏感，`isUnder` 区分大小写而查重折叠 ⇒ `Vendor` 与 `vendor/sdk` **实际嵌套却被算作兄弟** ⇒ 内层不进排除计划 ⇒ 回到 `add -A` 吞 gitlink。顺带：路径先做 **NFC 归一**（NFD/NFC 同名不同字节），并拒 `U+2028`/`U+2029`（JS 正则的 `^`/`$` 认它们，多行注入）与 NUL。
- **退役一个 wire 字段，光从 schema 里删是不够的**：`StartTaskSchema` 是**非 strict** zod，未知键**静默剥除** ⇒ 老客户端传 `repos:[a,b]` 会「解析成功」并跑在错误的工作区。必须同时进 `RETIRED_START_TASK_KEYS`，由 `rejectRetiredStartTaskKeys` 在**任何 parse 之前**硬拒 422（RFC-165 F1 立的规矩，RFC-248 T32 再次验证）。断代要**逐入口核对**：三个 `Start*Schema` / `LaunchSpaceFields` / scheduled payload / REST JSON **与 multipart 两条** / MCP 工具 / e2e 夹具 / **任务重启**（重启要用冻结快照，不是当前定义）/ **定时任务**（删掉被引用的资源时要禁用引用它的计划，否则留下反复失败的烂账）。
- **删一个「只有自己的测试在用」的导出，先确认它锁的是不是别的东西**：RFC-248 删 `buildLaunchBodyMultiRepo` 时发现三个测试文件引用它，其中两个真正锁的是「extras 字段要透传到 wire」和「反解要能还原」——主题仍然有效，只是载体换了。直接删测试会丢覆盖；正确做法是把主题迁到幸存的构造器上，再补一条「不得复活」的锁。
- **本 RFC 暴露出的两条「早已空转的绿测试」**：`repoPath` 在 RFC-165 退役后，`task-start-pre-worktree` 的「回落到单仓 git 路径」实际只建了个空的多仓容器目录、而断言只查「目录存在」；`rfc107` 的多仓上传用例因旧路径不给同源仓加分支后缀而只物化了一个仓。**给旧路径加显式 422 时，会连带把这类空转测试照出来**——照出来就顺手修成真测，别只把断言改绿。

## 拿真机 / 虚拟机做跨平台勘测时的四个坑（2026-08-05，RFC-254 T32）

用一台真机（本例：Parallels 上的 Windows 11）跑全量来给「另一个平台上有多少条红」
定性，比 CI 快一个数量级——CI 那条腿 90 分钟跑不完、勘测作业排队几小时。但**取样器
本身会骗人**，下面每一条都真实发生过（第 4 条还害得一整条 P1 被记成了产品缺陷）：

1. **先证明树与 HEAD 一致，再信它的失败清单**。旧快照里留着已被删除的测试文件、缺着
   新增的夹具源，于是报出一整簇与被测平台毫无关系的失败（本例 17 条，占当时清单的
   三分之一）。判据要具体：挑一个**本次改动新增**的文件和一个**本次改动删除**的文件，
   各 `Test-Path` 一次；只看目录列表不够。
2. **两次全量并发写同一个输出文件 = 无法归属的混合结果**。第二次跑之前先确认上一次
   真的退出了（`Get-Process bun`），并写到**不同文件名**。看到「失败清单和上一轮一模
   一样」时要警惕，那通常不是稳定复现，是在读同一份旧内容。
3. **wipe 掉 `packages/` 会连 workspace 内的 `node_modules` 一起带走**。bun workspace
   会把一部分依赖装在 `packages/*/node_modules`，删掉整棵树再解包 `git archive` 之后，
   表现为 `Cannot find package 'zod'` 这类**与改动无关**的加载失败，而且是整文件不
   加载、在报表里呈现为 `1 error` 而非 `N fail`。重装一次即可，但要认得出这个形态。
4. **「被 ceiling 杀掉、无 summary」≠「卡死」**。分批 sweep 里给每批设了硬 ceiling，
   输出无汇总行就记 wedge——这个判据把「真慢没跑完」和「真卡死」混为一谈：batch 08
   被记了三轮 wedge，拆开才发现是 rfc210 submodule 簇的真 I/O（单文件实测 **194s**，
   16 个这样的文件挤在一批里，720s 的 ceiling 纯粹不够）。判据要配**输出文件是否持续
   前进**（mtime / 行数）：卡死是「进程活着、输出冻结」，慢是「输出还在长」。真卡死
   的形态见 backlog「unref 的 deadline 定时器」条（那个是 5 分钟零输出、单文件可复现）。
5. **每次开跑之前查一遍 `Get-Process bun`，不是只在两次之间查**（第 2 条只说了后者，
   不够）。实测在取样机上捞出**三个被遗弃的全量跑**，最老的已经跑了近 6 小时，
   **累计 CPU 20803s / 17082s / 1163s**、驻留 0.3–1.7 GB——关键是它们**不是挂住空转，
   是在烧 CPU**，所以「机器看起来没在干活」不成立。
   查的时候连 `CPU` 一起看：`Get-Process bun | Select-Object Id,CPU,StartTime`；
   命令行用 `Get-CimInstance Win32_Process -Filter "Name='bun.exe'"` 取，能看出是谁留下的。
   **但注意别把这条用反**：干净之后不复现，只说明**该缺陷对时延敏感**，不等于没有缺陷。
   RFC-254 T32 就在这里栽过——清干净后 fusion 那条绿了，据此结案为「污染、无缺陷」，
   而**把负载照着造回来（每核压一个 CPU burner）再跑，10 条红全部回来**，真因是那个
   文件从没声明过时间预算。**正确的收尾是「清干净复测 + 造回负载复测」两次都做**。

配套教训一：**ssh 到 Windows 的引号转义不值得斗**。zsh → ssh → cmd → PowerShell 四层
下来，`$_.Line` 这种会被逐层吃掉。稳的做法是**只在远端重定向到文件，把文件取回本地
再过滤**——本地有 grep/sed，且结果可复查。

配套教训四：**用 macOS 的 `tar` 往取样机同步，会带上 `._*` AppleDouble 文件**，vitest 把
它们当测试文件加载并报 `ERROR: Unexpected "\x00"`——一次凭空多出 20 个「失败文件」，而它们
根本不是仓库内容。打包时加 `COPYFILE_DISABLE=1`（或 `--no-mac-metadata`），并且看到
`._` 开头的文件名就该立刻认出是同步工具留下的，不是被测代码的问题。

配套教训三：**`FORCE_COLOR` 会让 `bun run test` 多出一条与你无关的红**。Claude Code
（以及不少现代终端）在环境里设 `FORCE_COLOR=3`，于是被测子进程的 `console.error`
输出带上 ANSI 转义，`test-command-helper.test.ts` 的
`surfaces non-zero exits with bounded stderr` 就会红——期望 `"...: fixture failed"`，
实得 `"...: [0m[31mfixture failed[0m"`。**这条与改动无关也与平台无关**，
CI 不设该变量所以那边是绿的。跑门禁时用 `env -u FORCE_COLOR bun run test` 排除干扰；
别把它算进自己改动的失败数（已登记 backlog，正解是别把控制字符拼进 Error message）。

配套教训二：**别指望 `Start-Process` 把长跑放到后台**。用
`Start-Process -WindowStyle Hidden -RedirectStandardOutput` 起的全量跑，在 ssh 会话结束时
一起没了——实测只留下 28 字节的输出（第一个测试文件名）就断了，看上去像「第一个文件把
runner 打崩了」，而单独跑那个文件是绿的。要么**把 ssh 会话开着**（本地用后台任务持有），
要么用真正脱离会话的机制；不要凭那半截输出去归因。

- **`git mv` 会立刻把 rename 写进 index——之后任何「只想提交别的文件」的 `git commit` 都会把这些 staged renames 一起带走**（RFC-282 实测事故：搬迁中途插入一个 docs-only commit，结果把「文件已搬、import 未改」的破碎中间态推上 main，CI 四路全红一小时）。定式：搬迁类工作开始后到搬迁 commit 落地前，**不要插入任何其它 commit**；确需插入时先 `git status` 核对 staged 区只含目标文件，或 `git stash --staged` 暂存 renames。

- **改 `scripts/depcheck.ts` 的 KNOWN_VIOLATIONS 必须连跑它的元测试（`packages/backend/tests/depcheck-gate.test.ts`），`bun run depcheck` 本体绿≠纪律绿**（RFC-284 批 A 实测事故：22 条新账目 depcheck 40/40 全绿上了 main，CI 双 OS shard-1 确定性红——元测试强制每条 removeWhen >10 字且含 `WP-\d|RFC-\d{3}|独立切片` 标记，11 条短尾「随 X 域下沉。」双双违反）。定式：账本与账本的纪律测试是一对，动其一必跑其二。

- **满载噪音归类时必须把失败清单逐条隔离复跑，不能只隔离「眼熟的那几个」**（同一事故的另一半：钉住 worktree 门禁 4/4 分片超时家族大红里混着上面那条确定性真红，隔离清单按 grep 摘要挑了 5 个「叫得上名字」的文件全绿后整轮判了噪音——真红被淹没直到 CI 抓出。判据：分片日志里 `(fail)` 逐条数满、与隔离清单一一对账，缺一条都不许按噪音收工；两 OS 同分片齐红优先怀疑确定性真红）。

- **commit message 里的反引号会被 shell 命令替换吞掉**（2026-08-13 实撞，且**已静默
  损坏过多条**）：本仓 commit message 惯例大量使用 `` `符号名` `` 标注标识符，而
  `git commit -m "…`Foo`…"` 在双引号里会把反引号当**命令替换**执行——`Foo` 不是命令
  → 报 `command not found` 并把该处替换成**空字符串**，message 里那个标识符就此消失。
  报错混在 git 输出里极易被忽略（`79c39169` 是当场看见的一例，回查 `d64af290`
  发现更早就已无声丢失两个字段名）。**定式**：带反引号的 message 一律写文件再
  `git commit -F <file>`（或用单引号 heredoc 生成文件），**不要**用 `-m "…"`；
  提交后 `git log -1 --format=%B | grep` 抽查一个标识符是否还在。

- **变异实证本身会出错：变异点必须由「被断言的那个正则」定位，不能用「第一个匹配」**
  （2026-08-13 实撞）。给一条源码锁做变异实证时，顺手写 `t.replace(X, Y, 1)` 改第一处
  ——而第一处**不在**被锁的区域里，于是跑出 0 红，差点据此认定「这条锁不生效」并去
  改锁（改松了才是真危险）。正解：先用**断言里那个正则**去 `re.search` 定位，在它的
  命中处做替换，再跑。判据也要跟着变——「变异后必须红」的前提是**变异确实落在断言
  射程内**，否则 0 红只说明变异打偏了，不说明锁没用。

- **上一条的第三种变体：变异跑批的「0 红」可能是跑批脚本自己没跑起来**（2026-08-13
  实撞，同一天第二次）。本仓 shell 是 **zsh**，而 zsh **不对未加引号的参数展开做分词**
  ——把多个测试文件塞进一个变量再写 `bun test $FILES`，bash 会拆成 N 个文件，zsh 却当
  **一个文件名**传进去，bun 找不到它、什么也没跑，管道里自然一条 `fail` 都数不到，跑批
  脚本原样打印「0 红」。同一批里的单文件变异全是红的，越发显得那两条「锁失效」。
  正解三条：① zsh 里要分词写 `${=VAR}`（或干脆把文件名逐个传参）；② 变异实证的判据
  只认**汇总行**（`N pass / N fail`），不要用 `grep -c '^(fail)'` 这类形态锚（多文件输出
  里未必顶格）；③ **凡出现 0 红，先证明"变异跑起来了"再下结论**——最省事的证明是手工
  跑一遍同样的命令，看得到红再回头修脚本。三次翻车的共同教训：0 红的第一嫌疑人永远是
  实证装置本身，不是锁。

- **改一个被广泛扫描的源文件后，「按 RFC 编号挑测试」必然漏面——要按「谁读了这个文件」
  挑**（2026-08-13 实撞）。RFC-287 T8 把 scheduler 的取行前奏收编进 `nodeRunMint`，本地
  按 `rfc287|rfc284|rfc253|scheduler` 选了 691 条测试全绿，推进门禁却红了三条源码锁
  ——它们分别住在 `node-run-mint.test.ts`（RFC-284 的 nextRetryIndex 棘轮）、
  `rfc127-borrow.test.ts`（RFC-132 的 agentOverrideName 锁）、
  `rfc292-trigger-source-locks.test.ts`（冻结上下文相邻锁）里，**文件名与被改动的 RFC
  编号毫无关系**。本仓有大量「A 号 RFC 的锁写在 B 号文件里」的结构守卫，编号选面对它们
  系统性失明。正解是按依赖选：
  grep -rl "services/<改动文件>.ts'" packages/backend/tests/
  `scheduler.ts` 一查就是 91 个文件——那才是真实的连带面。计数型棘轮与「函数体里含
  什么」型的源码锁尤其吃这一刀，因为它们锁的是**文本形态**，任何搬家都会失配。

- **两份 `gate:local` 不能同时跑：它假定独占整机，并发会让一批真起子进程的测试集体超时**
  （2026-08-13 实撞）。门禁的 backend 车道本身就是 4 个并发分片 + quality 车道的 vitest；
  本机再有第二个 session 同时跑门禁，就是 8 分片 + 2 个 vitest，`load average` 冲到 48。
  症状很好认：**每轮失败的集合都不一样**，但耗时全落在 5.5-6.1s 这条带上（bun 默认
  timeout 5000ms），且门禁总时长比上一轮涨两三成。这不是 flaky，也不是被测代码变慢
  ——是那批真起 opencode 子进程的用例本来就贴着 5s，机器一挤就整片翻。
  **判据**（红了先做这一步，再谈修代码）：
  uptime # load average 是不是异常高
  ps -Ao pid,command | grep -E 'bun test --shard|vitest run'
  若看到**不属于自己那次运行**的分片（seed 对不上、cwd 不是自己的 pin worktree），
  就是撞车了：等对方跑完再重跑，别改代码、别加 timeout、更别按「重跑就过」放行。
  反过来，自己跑门禁期间也别在主树跑 `tsc`/`vitest`——同一枚硬币的另一面。
  真正贴线到**无负载下也红**的个别用例（判据：单文件隔离连跑 3 次仍红）才该给显式
  预算，例如 `scheduler-clarify-mid-batch` 那条（真起两个子进程 + 走完重试预算，单跑
  5.4-5.6s，已配 `20_000`）。

- **`git commit --only <路径>` 会连**别人在同一文件里的未完成改动**一起提交——而对方
  引用的新目录多半还没入库，于是你的 commit 立刻带着断链上门禁**（2026-08-13 实撞，
  与 STATE.md 记的 `dacc8280` 索引断链同型）。CLAUDE.md 允许「同一文件混了多人改动一起
  commit」，但那条的前提是**对方的部分自身是自洽的**；当对方正在半途（新 `@/modules/...`
  目录未 `git add`、新列未进 schema），携带就等于替他把断链推上去。
  **判据**：commit 后立刻 `git show --stat HEAD` 对一眼行数——「我只改了 15 行，怎么显示
  122 行」就是它。也可以在提交前 `git diff --stat <路径>` 与自己的改动量比。
  **修法**（未推送时）：`git show HEAD~1:<路径> > <路径>` 取回父版本 → 只叠加自己的改动
  → `git add` + `git commit --amend` → 再把对方的版本按字节 `cp` 回工作树（`md5` 核验
  一致），对方一行不丢。已推送则只能补一个修正 commit，不要 force。

- **在共享工作树上用 `git stash` 做「还原—对比」实验，必须保证还原不会被超时切断**
  （2026-08-13 实撞）。我为了给一批红做归因，stash 掉三个生产文件跑基线，那次跑批撞上
  10 分钟工具超时被杀，**stash 没弹回来**——生产改动凭空消失，若当时直接提交就会丢工作。
  正解：把 `stash push` 与 `stash pop` 放在**同一条不会超时的短命令**里，或干脆别用
  stash——`git show HEAD:<路径> > /tmp/base.ts` 取基线副本做对比，原文件一直不动。
  兜底习惯：任何 stash 之后，下一条命令先 `git stash list` 确认已清空。

- **「变异点要锚对」有个镜像版：断言本身也可能锚错，而且它恒绿、看不出来**
  （2026-08-14 实撞）。写「A 必须出现在 B 之前」这类顺序锁时用了全文
  `indexOf('activeTasks.set(...)')`——而那个字符串在别的函数里还有两处，首个的
  位置永远小于 B，于是断言恒真。连做两轮变异都是 0 红，我一度以为是变异没落地；
  第三轮把真值打印出来才看清：**是断言从一开始就没锁住任何东西**。
  判据与修法：顺序/邻接类断言必须**先把射程限定到那一个函数体**（`indexOf(签名)`
  到下一个顶格 `}`），再在体内取位置；跨函数的全文 `indexOf`/`lastIndexOf` 对
  「同名调用出现多次」的文件天然失效。校验方式也要跟着变——变异后先打印两个
  位置的真值，确认它们的相对关系**确实被翻转**了，再看红不红；否则你验的是一个
  没被改变的条件。

- **共享工作树上「跑完测试立刻提交」比「攒一批再提交」重要得多——别人的
  `git reset --hard` 会吃掉你未提交的一切**（2026-08-14 实撞）。我把 G6 的四处生产
  接线写完、测试全绿，先提交了分类器那半；回头要提另一半时发现**代码不见了**，
  工作树与 HEAD 都查不到。`git reflog` 里只留下一行 `HEAD@{1} reset: moving to HEAD`
  ——并发 session 在同一棵树上做的，事后**看不到被吃掉的内容**（reset 不产生
  dangling blob，未提交的改动直接消失）。
  判据：commit 之后 `git show --stat HEAD` 与预期文件数对不上，或某处代码「明明写过
  却搜不到」，先查 `git reflog | head` 有没有 reset / checkout。
  处置：本仓多人共用一棵工作树，**每完成一个可验证的小步就 commit**（不必 push），
  让改动进入对象库；commit 过的东西 reset --hard 也只是移动 HEAD，`git reflog` +
  `git cherry-pick` 就能捞回来。真要长时间持有未提交改动，先 `git stash push -m`
  或 `cp` 一份到 /tmp。

## 子进程连 system-mock 回环 HTTP 会在部分开发机上超时（RFC-310 实测，2026-08-18）

现象：`startSystemMockSuite()` 起的 mock server（127.0.0.1:随机端口），**同进程 Bun fetch 全通**
（seedCodeHost/snapshot/mrEnsure 正常），但**子进程**（`git clone`、`curl`）打同一 URL 一律超时
0 字节——设 `NO_PROXY` 也救不了（不是代理问题），CI 上无此现象。判定是本机安全策略拦「子进程发起
的回环连接」一类差异。写依赖 mock git smart HTTP 的测试时不要死磕传输层：

- **git 面（clone/push/CAS）改用 mock 服务端的磁盘 bare 仓路径**——`MockCodeHostProject.repoHttpUrl`
  的 `/git/` 后段相对 `realpathSync(tmpdir())` 解析即 `repositoryPath`（file remote 完全等价，push
  后 `syncRefsFromGit` 一样能看到分支）；**API 面（MR ensure/observe）保持真 HTTP**（同进程 fetch 通）。
  样例：`packages/backend/tests/rfc310-pr5-e2e-java.test.ts` 的 `mockRepoDiskPath`。
- 排查此类问题时管道也会骗你：`bun … | tail` / `| head` 在进程未退出前**看不到任何增量输出**（全缓冲），
  会把「挂在 clone」误读成「挂在启动」。后台落文件（`> log 2>&1 &`）再 cat 才是可信的进度面。

## 播种「示例 / 内置」数据（RFC-307 实测，2026-08-17）

装好即有样例是好产品，但**往共享表里播行**牵动的面比想象的宽。四条，全部是跑起来
或 CI 照出来的，读代码读不出来：

- **`builtin: true` 在本仓不是「随产品附带」，是「平台基础设施：列表里隐藏 + 只读」。**
  `excludeBuiltinWorkflows` 把行从所有列表过滤掉，`assertNotBuiltin` 拒绝一切
  修改 / 删除 / 改名 / ACL 变更（**admin 与 `__system__` 也拒**，判据看行不看人）。
  对 fusion 的引擎资源完全正确；从那儿抄给「示例数据」则一次打穿三件事：示例 agent
  根本不出现在任何代理下拉里、示例模板改不动、示例删不掉（于是「可以安全删除」是假话）。
  **想要「公开但可改可删」就不要 builtin**：`ownerUserId` + `visibility: 'public'`。
  注意 `createWorkflow` / `createAgent` 的新建默认是 `private`（RFC-099），public
  此前只能经由 builtin 取得——RFC-307 给 `createWorkflow` 加了可选 `visibility`。
- **新增一行就改变了每个选择器的默认值。** 播一个 `webhook_endpoints` 行 ⇒ 端点下拉
  默认选中它 ⇒ 三个 e2e 分片同时红（`expected "rfc295-picker-endpoint", received
"[demo] sample code host"`）。这不只是测试问题：一个永远收不到投递的端点预选在
  别人接真实 code host 的那块屏上，本身就是陷阱。**先问「这一行到底必须存在吗」**
  ——该例中列无外键、无读路径 join，删掉即可，改测试是治标。
- **「删掉不重播」要靠印记，不能靠判存在。** 判「行还在不在」等于用户删了下次启动
  又长回来，是平台跟用户抬杠。用一个「本安装已提供过」的印记文件（`Paths.demoSeedMarker`），
  且**失败时不写印记**，让下次启动重试而不是留下半套。
- **示例本身要跑得通。** 示例钩子回传 `promptSuffix`，而 `review-shard` 的
  `injectable` 白名单是 `extraContext` ⇒ 运行时必拒。第一个例子跑不通会教错两次
  （一次关于钩子，一次关于「示例能不能信」）。写测试从合同里取白名单去校验示例本身。

## 混合文件一起提交前，先确认**对方那半边引用的东西也在仓库里**（RFC-307 实测，2026-08-17）

仓规允许「同一文件混了多人改动可以一起 commit，只在 message 里写自己的部分」。
但有一类改动一行就打穿全仓构建：`packages/shared/src/index.ts` 里并发 RFC 加的
`export * from './workspaceConvention'`，而 `workspaceConvention.ts` **还未被
`git add`**。本地看不出任何异常（文件就在工作树里），推上去后 CI 上每个依赖 shared
的包都挂在 `Failed to resolve import`——一次 20 个 job 红。

处置：提交共享 barrel / index / 注册表这类**含 `export * from`、`import`、路径引用**
的混合文件前，对别人那几行跑一遍 `git ls-files <被引用文件>`，空输出就说明它还没进
仓库。此时**只移除自己误发的那一行**（对方本地文件原样不动，等作者连同模块一起提），
不要顺手把别人未完成的文件也 `git add` 进来。

## 多处编辑的脚本中途抛错 = 前面几处**一并丢失**（RFC-307 实测）

用一个 python/sed 脚本做 N 处替换时，若第 N 处的 anchor 断言失败而**写文件在最后**，
前 N-1 处全部丢弃。实测后果是「选项声明了、消费点没接上」——即本仓反复出现的
「两半都对、没接上」缺陷类，而且看起来像是自己写漏了。
处置：多处编辑要么**每处独立写盘**，要么在脚本末尾断言「每处都命中」并把失败当红灯
（本次是测试红了才发现）。凡加了新参数 / 新选项，**必须有一条断言它真的改变了行为**，
不能只断言它存在。

## 未激活的页签面板仍然挂载（RFC-169）⇒ `data-testid` 会撞车

`TabPanels` 用 `hidden` 属性藏起未激活面板而**不卸载**（为了保住子组件本地状态）。
后果：同一份组件在多个页签里各渲染一份，DOM 里同名 `data-testid` 有多份，
`getByTestId` 直接报 "found multiple elements"。实测一个 13 步能力在 DOM 里有
**26 张卡片**。处置：给可复用的可视组件加 `testidPrefix`，由调用方命名空间化；
顺带——未激活面板的 query 也照发请求，需要按 `active` 显式 gate，否则打开任意页签
都在替别人取数。

## 大规模删除波：让 `tsc` 给清单，不要用贪婪正则删代码块（RFC-310 PR-10 实测，2026-08-18）

一次删掉 102 个文件 / 2 万行（legacy writer 退役）时，两条做法决定成败：

**① 删除清单由 `tsc --noEmit` 产出，不靠 grep 猜。** 删完生产文件后
`bunx tsc --noEmit 2>&1 | grep -oE "^tests/[a-z0-9-]+\.test\.ts" | sort -u`
就是**精确**的连带清单（88 个 writer 测试一次到位），比「grep 文件名猜哪些测试
是它的」可靠得多——后者必然漏掉间接依赖，而漏掉的那个会在 CI 上红。清单拿到后
再人工分三堆：纯 writer 单测（删）、混合读写（拆）、守卫（见下条）。

**② 删函数/接口块用行边界法，禁止 `[\s\S]*?\n\}\n` 这类贪婪正则。**
`re.sub(r"function foo\([\s\S]*?\n\}\n", ...)` 看起来「删到第一个顶格右括号」，
实际会跨过嵌套结构一路吃到很远——本轮一次误删 776 行（整个页面组件连同
`export const Route` 一起没了，`tsc` 才报出来）。正确做法是按行扫：

```python
a = next(i for i, l in enumerate(lines) if l.startswith('function foo('))
b = a
while lines[b] != '}':      # 顶格闭合行 = 函数结束
    b += 1
del lines[a:b+1]
```

误删后不要试图「再写回去」——`git checkout HEAD -- <file>` 重来一遍最快，
前提是这一波手术**每步都能脚本重放**（所以每步都写成小脚本，而不是手改）。

## 被测对象被删除后，守卫测试有三种正确处置（同上实测）

删 writer 时会连带打红一批**静态守卫**（负向断言、源码文本锁）。它们不是普通
测试，不能无脑删——逐条判：

1. **改指向更强的断言**：原本锁「A 必须经 public 合同调用 B」，A 删了之后
   应该锁「模块 X 对 B 整体零依赖」——收缩后的世界里前者是废话，后者更强。
2. **整删（vacuous 化）**：守卫的全部被测点都随代码消失（例如「15+ 个 code-host
   调用点的 params 命名」在调用点归零后只剩一条 `SITES.length >= 15` 恒红），
   留着只会诱使后人把阈值改成 0——那才是真正的假绿。
3. **登记豁免**：新棘轮扫到的「同名但不同归属」的东西（本轮：capability-templates
   资源自身的 upstream 同步写，与被删的 round writer 无关），在测试里显式
   `exempt` 并写清理由，而不是把正则改松。

配套：删除完成后**补一条退役棘轮**（已删文件不得复活 + 模块内不得再出现写动词 +
权限点不得回到目录），否则「删干净了」只是这一刻的状态，不是不变量。

## 表可以留、写入口必须清零（RFC-310 T105/T108 实测）

退役一个子系统时，「删表」和「删写面」是两个独立决策：

- **写入口一律清零**——包括存储层那些「只剩测试在调用」的 upsert/insert 函数。
  留着一个没有生产调用者的写函数，等于给未来的人留一条把 writer 悄悄接回来的
  路。读面测试需要种数据就**把种子搬进 `tests/helpers/`**（直接写表），生产代码
  里不留入口。
- **表未必要 drop**。判据是「行是否还有审计价值」：运行态数据（锁、重试配额、
  in-flight 意图）可以 drop，产出证据（artifacts、observations）drop 就是不可逆
  的信息销毁。无 writer 的表不再增长，清理更适合走统一的保留期治理而不是一刀
  `DROP TABLE`。裁决写进 plan.md，并**加一条「零生产消费者」棘轮**——重新出现
  消费者是 writer 复活的唯一早期信号。

## 共享工作树上，`git reset --hard` / `git stash pop` 等于删除他人在制工作（2026-08-18 实测，双向各踩一次）

同一 checkout 上多 session 并发时，**所有全树操作都不区分「我的脏改动」和
「别人的脏改动」**。一天之内两个方向各出一次事故：

- **`git stash pop` 弹错条目**：共享树上 `git stash list` 里可能压着别的 session
  几小时前的 WIP。不带参数的 `pop` 弹的是 `stash@{0}`——一次炸出 14 个 `UU`
  冲突。要么别用 stash，要么先 `git stash list` 确认再 `git stash pop stash@{n}`。
- **用 `git reset --hard HEAD` 收场**：它把工作树恢复到 HEAD，**连同别人尚未
  提交的改动一起抹掉**。本次抹掉了对方一处实现门修复+配套测试，症状极隐蔽：
  对方的 commit message 照常描述了那条修复，`git show --stat` 却只有 2 个文件
  而不是 4 个——**内容没了，描述还在**。正确收场是逐文件
  `git checkout --ours/--theirs <冲突文件>`，或 `git checkout HEAD -- <只属于自己的路径>`。

配套的两条自检（互补，一起用）：

1. **commit 后立刻 `git show --stat HEAD`，核对文件数是否等于自己列出的路径数**
   ——少了就是被谁的全树操作吃掉了，多了就是卷进了别人的在制文件。
2. **`git show --stat <自己的 commit> | grep <对方 RFC 关键词>`**——两秒扫一眼，
   比等 gate 红再回溯便宜得多。反向卷入（把对方未提交的半成品带进自己的 commit）
   的典型症状是 typecheck 报「模块声明了 X 但未导出」：测试半边进了提交树、
   `export` 半边还在对方工作树。

**第二种形态：你故意制造的红被别人的门禁撞上（2026-08-19 实测）。** 变异检验
（把真实事故的错值注回去、确认守卫变红）在共享树上会留下一个几十秒的中间态：
产品代码此刻**确实**是坏的。对方恰好在这个窗口跑 `gate:local`，就会拿到一条
「你的文件 lint/format 红」并按归属报给你——两边各浪费一轮排查。

- **做变异检验请挪到分离 worktree**（`git worktree add --detach <tmp> HEAD`），
  共享树上不留故意制造的中间态；同理适用于任何「先弄坏再验证」的手法。
- **收到别人报红时，先问这条红是否可复现**：重跑一次还在，才值得按归属追；
  只出现一次且对方正在编辑该文件，多半撞上的是中间态。

## 前后端各存一份路径常量 + 测试 mock 掉 fetch = 契约漂移无人可见（RFC-310 实测，2026-08-19）

用户报 `no route for /api/code/development-adapters`。根因是五类配置资源的
CRUD 端点由**一个模板函数**（`mountConfigResource(app, deps, { base })`）生成：

- 后端契约注册表按**字面路径**扫描 `routes/*.ts`，看不见计算出来的路径；
- 前端把 base 存在自己的常量表（`CONFIG_KIND_SPECS.apiBase`）里，与后端那份
  没有任何机械联系；
- 页面测试 mock 掉 `fetch`，**用例自己写 URL 匹配**——前后端写成同一个错值时，
  测试照样绿（本次实测：测试里的两处 URL 也是错的，和实现一起错，所以一路绿）。

于是一个前缀写错（adapter 归 integration bounded context，真实前缀是
`/api/integrations/...` 而不是随页面的 `/api/code/...`）就能穿过 typecheck、
lint、单测、`gate:local` 和 CI，直到用户打开页面看到 404。

**判据**：只要「同一个事实在前后端各存一份」，就必须有一条**读对方源码**的对账
测试；`mock` 掉的边界永远不构成契约证明。本仓已有两个同款先例——PR-8 的
`policyFactCatalog`（前端目录静态镜像 + 测试直接 import 后端 domain 对拍）与
本次的 `code-config-api-base.test.ts`（读后端 `mountConfigResource` 的 base
字面量逐条比对）。同样按定式做变异检验：把真实事故的错值注回去，确认变红。

**顺带**：计算路径的端点天然逃过契约注册表。发现这类端点时，要么在注册表里
显式登记（哪怕手写），要么给它补一条别的机械对账——不要只在注释里写一句
「registry 扫不到，故不在此表」就了事（本次就是这么写的，然后事故从这里漏出去）。

**同一天第二次复发后的正解：别再"对账两份常量"，让两边共用一份、并拿真实 app
重放**（2026-08-19）。第二个 bug（`adapter content failed schema: Invalid literal
value, expected 1`）说明漂移不止在**路径**，还在**请求体形状**：前端创建对话框
即兴拼载荷，后端在 create 期 strict parse，两边各自绿着，合起来是坏的。

- 把载荷构造提成 `packages/shared` 的纯函数（本次 `buildDevelopmentConfigCreateBody`
  - `DEVELOPMENT_CONFIG_API_BASE`），**前端调它发请求，后端测试调它打 `createApp`
    起的真实 HTTP app**（真 DB、真路由、真 Zod）。这样漂移不再需要"对账"去发现——
    两边根本没有第二份可漂。
- 判据升级：`mock` 掉的边界不构成契约证明；**读对方源码的对账**是次优解（适用于
  真的不能共用的镜像，如前端不 import 后端包的 fact catalog）；**共用一份 + 真实
  重放**才是首选。
- 断言别停在 201。建完之后用户下一下就是点"发布"，所以发布也要打。本次照打就
  当场照出**另外两个**缺陷：`publishDigitalEmployee` 与 `publishAutomationPolicy`
  都是裸 `schema.parse`，草稿不合法时 ZodError 被兜底成 **500 internal-error**，
  而同族的 action template / verification profile / adapter 都是 `safeParse` + 具名
  422。**规律：同族资源里只要有一个走裸 `.parse`，它就是那个把用户可达的校验失败
  变成 500 的。** 服务层 / 基础设施层抛出的 ZodError 不会自动变成 422——只有路由层
  `parse` 请求体那一处有兜底。
- 判断"这处 `.parse` 该不该改 safeParse"的判据是**数据从哪来**，不是在哪一层：
  解析**平台自己写下的**快照 / 回执 / 已发布 revision，崩了就是内部错误，500 诚实；
  解析**用户手写且写入路径故意宽容**的内容（五类配置资源的 draft 正是如此——
  `revise` 收任意 JSON），那么第一个校验点就是用户点得到的按钮，必须具名 422。
  按这条判据扫全后端的 `.parse(JSON.parse(...))`，命中的就只有上面两处。

**同日第三次复发，形态升级为「测试与实现互相印证的假绿」**（2026-08-19，用户要求
「自己从前台走一遍关键流程」时实撞）。起了独立 home 的 daemon + 内嵌前端逐页操作，
一趟走出两个整页崩溃、一个静默说谎，全部是同一根因的不同长相：

| 现象                                                                   | 前端假设                       | 真实形状                                      |
| ---------------------------------------------------------------------- | ------------------------------ | --------------------------------------------- |
| `/code/assignments` 点「新建指派」白屏 `e.repos.map is not a function` | 四条 useQuery 声明成裸数组     | 列表端点回 `{ items: [...] }`                 |
| 员工详情存草稿后白屏 React error #31                                   | `fallbackTemplateRef` 是字符串 | domain `versionedRef` = `{ id, revision }`    |
| 员工「默认策略」永远显示「—」                                          | `refText` 只认字符串           | 同上（对象 → 静默退化，**不报错，只是说谎**） |

三处的共同结构是**测试与实现一起错**：页面测试 mock 掉 fetch、fixture 照着前端的
错误假设造数据（裸数组、`'id@rev'` 字符串），于是两边互相印证、全绿到用户点开为止。
**这比单纯漏测更难发现——测试越多越像有覆盖。**

- **fixture 必须被生产者的 schema 裁定，不能由消费者的想象来写**。落地方式：前端
  测试直接按相对路径 import 后端 domain schema，对 fixture 跑一次 `safeParse`
  （本仓已有先例：`code-policy-pages.test.tsx` 拿后端 domain 对拍 fact catalog）。
  变异检验：把旧的字符串形态喂进去，schema 会逐字段点名——那正是事故形态。
- **判据表宁可实测、不要启发式**。给「哪些端点回 `{items}`」写扫描器时，第一版
  从后端源码推，结果把 `/api/agents`（真·裸数组）误判成 items 形状，差点让人去
  **改正确的代码**。改成逐条 curl 真实 daemon 建表 + 守卫内常驻一条判据函数自检
  用例（它当场照出判据函数漏掉单行 interface 的洞）。
- **`api.get<T>` 的 T 是给编译器讲的故事**：`api.get` 回 `unknown`，泛型是作者
  自己填的断言，填错了 TypeScript 一声不吭。需要真保障就上运行时 `Schema.parse`
  （RFC-311 的 `/repos`、`/tasks` 走的就是这条路，形状不符当场抛且 mock 造错也红）。
- **实践**：交付一个有 UI 的 RFC，**自己起 daemon 从前台走一遍关键流程**。本轮
  三个缺陷没有一个能被 typecheck / lint / 单测 / e2e / CI 拦住，全部是"点开就见"。
  起法：`AGENT_WORKFLOW_HOME=~/aw-<slug>`（别放 `/tmp` symlink 下）+
  `bun run build && bun run build:binary` 后跑 dist 里的二进制（vite dev 的
  `.daemon.info` 只认默认 home，且端口固定，多人并发时会串到别人的 daemon）。
  首个管理员用 CLI 建（`user create --admin --password`），会话用
  `POST /api/auth/login` 换 token 后以 `#aw_session=<token>` 片段注入前端——
  全程不必在浏览器里手输凭据。

## 「探测端口 → 关闭 → 再绑定」在并发分片下会被抢走（2026-08-19 门禁实撞）

`gate:local` 的 backend 车道跑 **4 个并发 shard**，机器上还常有别的 session 在跑自己的门禁。
凡是走「`net.createServer().listen(0)` 拿到端口号 → `close()` → 再拿这个号去
`Bun.serve({ port })`」的测试，**probe 关闭到重新绑定之间有一个真实窗口**，任何并发进程都
可能先一步占住它。

现场：`packages/backend/tests/rfc269-webhook-code-host-context-e2e.test.ts:105-117`。用例红在
`expect(terminal).toMatchObject({ outcome: { status: 'done' } })`，实际收到
`code-host-http-error: POST /api/v4/projects/…/notes → HTTP 503`。**决定性判据是那个桩对任何
请求都返回 `201`——它根本产不出 503**，所以那个 503 必然来自**占了同一端口的别的服务**。
单跑 3/3 绿，只在分片并发下偶发红。

- **已修（同日）**：那个「Bun 1.3.13 在 macOS 上拒绝 `Bun.serve({ port: 0 })`」的前提
  **实测已不成立**——同版本 bun 上 `Bun.serve({ hostname:'127.0.0.1', port: 0, … })` 正常
  返回分配到的端口。于是两处 `probe → Bun.serve` 站点（`rfc269-webhook-code-host-context-e2e`、
  `rfc238-mcp-runtime-test-real-e2e`）改为**让 Bun 自己要端口、下游读 `server.port`**，
  helper 整个删掉（净 −22 行）：绑定与占用不可分割，窗口从根上消失，4 路并发实跑 0 fail。
- **第三处 `e2e/harness.ts` 不适用**，别照抄上面的改法：它把端口传给**外部编译好的 daemon
  进程**，必须事先定号（进程没法反过来告诉你它绑到了哪）。要根治得让 daemon 自报端口。
- **通用教训（同日两个独立实例，故立为规则）**：**带前提的规避写法，会把「当时某个环境/
  版本的缺陷」固化成永久前提，然后被所有人照抄，而没人再验那句前提。**
  - 实例一（本条）：源码注释「Bun 1.3.13 在 macOS 上拒绝 `Bun.serve({port:0})`」——一条
    `bun -e` 就推翻，代价是一条会随并发度放大的门禁假红。
  - 实例二（RFC-310 session 同日实撞）：计划文档里的「本机受限执行环境起不了 listener，
    由 hosted CI 收口」——真去跑了一次发现同一棵树上 system mock 与编译后 daemon +
    Playwright 都起得来；那句话的直接后果是**两条 e2e spec 写完从未被执行过**，头三个
    testid 在前端根本不存在。
  - **判据**：前提写在注释里还是计划里都一样——**动它之前先花 10 秒实测它还成不成立**。
    代价通常是一条命令，而不验的代价是「所有人绕着一个已经消失的问题写代码」。
  - **这条规则最有说服力的地方**（由实例二的当事人指出）：两次验证的成本都是「跑一次
    **已有的**东西」——一条 `bun -e`、一次已经写好的 mock 套件与 Playwright——**比写下
    那句前提本身还便宜**。所以**不验的理由从来不是成本，是没想到要验**。这也说明它不能
    靠「更自觉一点」来解决，得靠把「验前提」钉进流程：凡引用一句前提来决定**不做**某事
    （不这么写、不在本机跑、不覆盖某条路径），就在同一处写下**你是怎么验的**。
- **排查提示（这条最省时间）**：被抢的那一半才报 `EADDRINUSE`；**先绑成功、而对面连到了别人**
  这一半只会看到「语义离谱的响应码」。所以一旦看到**桩不可能返回的状态码**，先怀疑端口串了，
  别去追业务逻辑。

## mock IdP 重启后所有 OIDC 登录失败：`kid` 不变 + 长寿 JWKS 缓存（2026-08-22 实测）

`bun dev` 的开发登录服务（`packages/system-mocks/src/dev-auth`）第一次跑通后，**重启这个
进程**再点登录，daemon 一律回 `Login failed / The id_token signature or claims could not be
verified`——而同一份代码首次运行完全正常。

- **根因是两边各自合理的缓存对撞**：`OidcMock.create()` **每次启动新生成一对 RSA 密钥**，
  但公钥的 `kid` 是硬编码的 `system-mock-key-1`（`packages/system-mocks/src/oidc/server.ts`）；
  daemon 侧 `getJwksInstance(jwksUri)`（`packages/backend/src/auth/oidc/endpoints.ts`）
  **按 `jwks_uri` 缓存一个 jose `RemoteJWKSet`，生命周期与进程同长**。jose 只在
  「找不到匹配的 kid」时才回源刷新——现在 kid **找得到**，只是密钥换了，于是它拿旧公钥去验新
  签名，永远失败，且 `PATCH /api/oidc/providers/:id`（重存同一 issuer）**清不掉**这个缓存，
  只有重启 daemon 才行。
- **修法（现行）**：让每个 dev-auth 进程用**自己的 issuer 路径**（`/oidc/<8位随机>`），
  于是 `jwks_uri` 与 discovery 缓存键都是新的，daemon 下一次登录自然取到新公钥；provider 行在
  种子阶段被重新指向新 issuer，**已种好的身份挂在 provider 行上、不受影响**。
  回归锁：`packages/system-mocks/tests/dev-auth.test.ts` 的「every process gets its own issuer
  path」（把前缀改回固定 `/oidc` 立刻红）。
- **通用判据**：**换密钥必须换 `kid`**。任何自建/mock 的签名端（IdP、JWT 签发、webhook 签名）
  一旦「密钥随进程重生成、标识符却写死」，对端只要缓存了密钥集就会进入这种「重启才好」的
  伪灵异状态。看到「首次通、重启必挂、重启对端又好了」，先查两边的 key id 与缓存生命周期。

## 给 `bun dev` 加常驻子进程：Ctrl-C 会带走它，父进程被强杀不会（2026-08-22 实测）

`bun run --filter '*' dev` 把各包的 dev 进程放在**同一个前台进程组**里，所以终端 Ctrl-C
（组 SIGINT）能到达每一个——实测 dev-auth 子进程随组退出、端口立刻释放。但这只覆盖了信号
**传得到**的那一半：

- `kill -9` 掉 `bun run --filter '*' dev` 父进程（或父进程自己崩了）→ 子进程**存活并被
  reparent 到 pid 1，端口继续占着**（实测：`54796 1 bun run src/dev-auth/cli.ts` + LISTEN），
  下次 `bun dev` 撞 EADDRINUSE，而占用者是十分钟前自己启动、早已忘掉的进程。
- 关终端窗口发的是 **SIGHUP** 不是 SIGINT，只注册 SIGINT/SIGTERM 的进程正好漏掉这一种。
- `server.close()` **不等于**端口马上释放：浏览器留着的 idle keep-alive 连接会把它吊住到超时。
  必须自己记下活动 socket 并在关闭时 `destroy()`，再加一个「到点硬退」的兜底。

定式（`packages/system-mocks/src/dev-auth/lifecycle.ts` 是现成实现）：常驻 dev 子进程一律
①注册 SIGINT/SIGTERM/**SIGHUP**；②起一个孤儿看门狗——启动时记下 `process.ppid`，之后轮询
「ppid 变了」**或**「原 ppid 用 signal-0 探不到了」，任一成立就自杀（bun 1.3.13 实测两个信号
都可用；启动时 ppid 已经是 1 的 nohup/launchd 场景要跳过，否则会误杀故意 detach 的实例）；
③关闭时销毁存量 socket + 限时硬退；④端口被占时打印**人话补救命令**而不是 EADDRINUSE 栈。
回归锁见 `packages/system-mocks/tests/dev-auth.test.ts` 的 `process lifecycle` 一组（含一条
真起进程、杀父、断言孤儿自退的用例，把看门狗关掉立刻红）。

## `bun dev` 的三个端口互不相关：一个撞了另外两个照起，于是残留叠层、报错越滚越多（2026-08-23 实撞）

`bun run --filter '*' dev` 并发起三个包，各占一个端口：backend 7456、frontend(vite) 5174、
dev-auth 7460。**`--filter` 不做联动**——某个包因 EADDRINUSE `Exited with code 1` 时，另外两个
照常起来并留在前台。于是失败一次的结果不是「没起来」，而是**起来了一半**，下一次再跑就叠上
一层，报错条数每轮增加。

本次实测的形态：用户 14:26 那次 backend 死了（撞更早一个 daemon）、vite+dev-auth 活着；我
14:32 再跑，backend 抢到 7456 起来了、vite+dev-auth 撞上前一次的残留双双退出。**两次的存活
集合正好互补**，页面居然还能用，掩盖了「有两棵半死进程树」这个事实——从终端里看只是「一堆
报错」，看不出报错分别属于哪一次。

- **判据**：报错读不出所属，直接按端口反查属主，不要按日志顺序猜：
  `lsof -nP -sTCP:LISTEN -iTCP:5174 -iTCP:7456 -iTCP:7460`，再 `ps -o ppid= -p <pid>` 把 pid
  归到各自的 `bun dev` 树。`ppid=1` 即孤儿残留（成因见上一条）。
- **清理**：先杀整棵树再重起，别只杀占端口那一个——同树的兄弟还活着，下一轮继续叠。
  按 pid 精确杀；**禁止 `pkill -f bun`**：树上常并行跑着别的 session 的 `test-backend-sharded.ts`
  分片、`mock-gitlab.ts`、opencode serve 等，会被一起误杀（本仓多人并发，见 §git / 多人协作）。
  实在要按模式杀就限定到具体入口：`dev-auth/cli.ts` / `bin/vite` / `--watch src/main.ts`。
- **验收**：三个端口全空再起，起后确认三条 ready 行都在（backend `listening url=`、vite
  `Local:`、dev-auth `ready — open …`）。**只看到「ready」不够**，缺哪条就是那个包又没起。
  backend 的 `/api/health` 返 **401 是正常的**（需 token），别当成故障继续排查。

## 守卫的自证：三条会让「护栏一直绿」的判据陷阱（RFC-317 B1-d / B2-a 实测，2026-08-23）

- **`git cat-file -e <sha>` 证明不了「这个 SHA 在当前历史上」**。它只证明**对象还在本地仓库里**——rebase
  前的那个 commit、被丢弃的 stash、别人 force-push 掉的分支尖端，对象统统还在。本仓 trunk-only + 频繁
  `pull --rebase`，「记进文档 / 账本的 SHA 是 rebase 前的本地 SHA」是常态事故：本人写的守卫初版用
  `cat-file -e` 判，变异回那个从未 push 过的 SHA **照绿**。判可达性必须
  `git merge-base --is-ancestor <sha> HEAD`（或 `… origin/main`）。同一坑的另一面见 §git / 多人协作
  「接到跨 session 关于远端状态的断言」。
- **「守卫导出一个数、清单 import 它来断言」这个形状在本仓不可实施**。清单测试要读到那个导出就得
  `import` 该 **test 文件**，而 import 一个 test 文件会把它的 `describe/test` **重复注册**一遍（前端
  vitest 还会连带拖起 jsdom setup）。想做「守卫的守卫」只有两条路：①守卫在自己文件里断言，清单用
  **AST** 读出那个断言并两向钉死（RFC-317 T13 采用——下限就写在用它的地方，被调低会红）；②把判据抽到
  一个**非 test 模块**（如 `tests/architecture/census.ts`），守卫与清单各自 import 它。写 RFC 时别再把
  ①②之外的形状写进设计。
- **写进文档的纪律不落成机器账本就会退化**。「负扫描必须配反向自检 / 语料非空断言」这条早在本文件
  §测试 / CI 记着（RFC-304 T11），但 2026-08-23 实测：**37 个枚举文件的守卫里只有 14 个真有语料下限**，
  且缺的恰恰是最吃重的几条（`rfc294-architecture-preflight` / `rfc305-architecture-lock` /
  `rfc284-spawn-site-ratchet` / `ux-source-ratchets`）。把 `rfc294` 的扫描根指到一个不存在的目录，它
  6 条测试里 **5 条照绿**。现在由 `packages/backend/tests/architecture/rfc317-guard-corpus-floor.test.ts`
  强制：凡枚举文件的守卫必须断言语料下限，下限两向钉进 `architecture/guard-manifest.json`，**静默调低也红**。

## 写「判据的判据」时，判松比判紧更危险（RFC-317 B2-b 实测，2026-08-23）

给守卫写元判据（「这条守卫有没有负 fixture」「它扫了多少语料」）时，判据本身会犯两个
方向的错，代价**不对称**：

- **判紧**（把合格的判成不合格）：表现是一堆假红，很吵，但当场就被发现。真实伤害是它
  会逼着后来的人**把代码写成判据认得的样子**——本末倒置。实测三版都栽在这里：要求断言
  里语法上出现顶层 matcher 名字，于是 matcher 藏在局部 `probe()` 里、藏在 describe
  作用域 helper 里、藏在 `Object.fromEntries` 外壳下的合格 fixture 全被判成缺失。
- **判松**（把不合格的判成合格）：**没有任何症状**。缺 fixture 的守卫凭空达标，元判据
  自己成了新的假绿源——而它看起来正在工作。实测：只把**顶层**名字算作「语料」，于是
  `const offenders = files.filter((f) => readFileSync(f).includes('function describeError('))`
  里的 `offenders` 被当成「fixture 载体」（初始化式里确实有一段像源码的字面量），
  `expect(offenders).toEqual([])` 这条彻头彻尾的**规则**断言被记成「这条守卫有负 fixture」。
  一次改动让「达标数」从 26 跳到 33，看着像大丰收，实际是判据塌了。

**定式**：①元判据每改一版，把**这一版的错法**固化成 fixture 留在测试里（两个方向都留），
下一版回归会当场红；②「达标数突然变好」要当成可疑信号去抽查具体被判为达标的那几条，
而不是当成进展；③涉及数据来源传播（这个值是不是来自真实语料）的判据要跑到**不动点**，
只看一跳会让 `files → offenders → filtered` 链条后段脱管。

## 负 fixture 里的伪造样本仍然是仓里的真实文本（RFC-317 B2-b 实测，2026-08-23）

给守卫写「把伪造违规喂给自己的 matcher」类 fixture 时，那段伪造样本**是**仓库里的
真实字符，别的源码扫描型守卫照样看得见。实撞：给 `agent-multi-grep-guard` 写 fixture
时样本路径随手写成 `'packages/backend/src/services/scheduler.ts'`，该文件本就调
`readFileSync`，于是同时满足 `rfc287-t1-scheduler-source-lock-inventory` 判据的两支
（读文件 + 点名 scheduler.ts），被判成一条新的「scheduler.ts 源码文本锁」，钉死清单不
再相等、全量门禁转红。

- **正确处置是改 fixture，不是改清单**。那个文件并不锁 scheduler.ts 源码，把它加进清单
  等于让清单开始说谎——而清单说谎正是它存在要防的事。
- **写样本时避开其它守卫的 needle**：文件路径、退役标识符、错误码字面量这类高辨识度
  字符串最容易撞。拿不准就用一个明显与本守卫无关的名字。
- 反过来看这也是钉死清单的价值实证：**一个纯属巧合的字符串**都能让它发现有东西变了。

**另一条同批教训**：脚本按行拼接进去的代码不过 prettier。`bun run format` 修完之后
**必须重算机器账本**——`architecture/guard-manifest.json` 记了每个守卫的 `lines`，重排
会让它漂移。顺序固定为：改代码 → format → 重算账本 → 再跑门禁。

## 棘轮用 `<=` 会留下「免费槽位」（RFC-317 T18 实测，2026-08-23）

「计数只许降」的棘轮写成 `expect(count).toBeLessThanOrEqual(cap)` 时有个反直觉的漏洞：
某个文件**收敛**到低于快照之后，差额就变成了**可复用的免费槽位**——下一个人再把违规
加回来不会红。实测 `rfc217` G5 漏了 3 个（两个文件都已收敛到 0，账本却还许 1 和 2）。

同一条棘轮的另一半漏洞是 `?? Infinity`：给某个目录「不设上限」。「新增的比较必须落在
`strategies/`」是**放置规则**，不等于放进去就不用记账——不记账就没人知道那里长了多少。

**定式**：计数型棘轮一律写 `toEqual`（逐字相等）。增了是新违规，减了是收敛——**两个方向
都要改账本**。「收敛也要改一行」听起来烦，但那一行正是收敛发生过的唯一记录；省掉它，
省下的额度就留给了下一个违规。

## 死豁免是空白许可证，不是多余的一行（RFC-317 T19 实测）

按**文件**记的豁免表（`allowlist.has(rel) ⇒ continue`）里，一旦某文件的违规被清掉而
豁免留着，那一行就从「记录一处已知例外」变成「该文件永久免检」——以后在那个文件里新长
出来的同类违规会被直接跳过，扫描永远报零，而且**不会有任何测试转红**，所以谁都不知道。

实测 `rfc143` 的三条豁免里有两条已经这样了。**定式**：豁免表必须配 stale 检测——每条
豁免都要仍然对应一处真实违规，否则当场红、强制删除。清违规和删豁免必须同批发生。

## 别用正则判定散文，一句断言和它的否定长得一模一样（RFC-317 T20 实测）

想检查「注释里声称存量债已入账」这类约定时，正则找措辞是行不通的：把一条过期声明
**改正**成「……已落地，账本里不再有本规则的条目」之后，那段话仍然命中同一个正则。
断言与其否定共享几乎全部关键词。

**定式**：要机器判定的东西就给它一个**机器标记**（`@ledger KNOWN_VIOLATIONS` 这类），
把散文留给人读。标记与事实双向钉死（有标记必须有条目、有条目必须有标记），两个方向
都能红。顺带一条：从配置文件里取「某声明对应的注释」时按**块边界**取，别用「上下固定
行数」的窗口——规则挨着排，窗口几乎必然串到隔壁那条去（实测误判过一条）。

## 共享工作树的 index 是共用的：裸 `git commit` 会把别人暂存的东西一起提交（2026-08-23 实撞）

精确 `git add <file>` **挡不住**这件事。共享树上别人可能早已 `git add` 过自己的在制品，
而 `git commit` 提交的是**整个暂存区**。实撞经过：我只 `git add` 了 2 个文档文件，裸
`git commit` 把并发 session 暂存着的 **26 个文件**一起提交推上 main。

**后果比"多提交了几个文件"严重得多**：那是一次**跨文件重构的半截**——必填字段
（`planningRoleRef` / `planningSlotRef`）随 `types.ts` 进了 main，而消费它的测试
（早已在 main 上、对方还没改完）编译不过，**当场把 main 推红**。这与本文件既有那条
「pathspec commit 会卷走同文件里别人未提交的行」是同一族，且更粗暴一档。

- **定式**：`git add <你的路径…>` 之后，提交也带 pathspec——`git commit -- <同样的路径…>`。
  pathspec commit 只提交列出的路径，共享 index 里别人暂存的一切与它无关。
- **兜底**：推之前 `git diff --cached --stat` 扫一眼，出现任何你没打算提的路径就停。
- **善后**：真的推上去了，**不要 `git revert`**——revert 会改写工作树，把对方正在编辑的
  在制品从磁盘上抹掉（虽可从你那个 commit 找回，但会打断对方的会话）。对方的内容此时是
  完好的，损害是"被提前提交 + main 可能红"。先判 main 红不红，再找对方协调；本次是对方
  自己补完消费方后推 `511384292` 把 main 修回绿的。

## `gh api ?head_sha=` 必须给**完整 40 位 SHA**，缩写会静默返回空列表（同日实撞）

用缩写 SHA 过滤 `actions/runs` 不会报错，只会返回 `{"workflow_runs": []}`。于是
`until [ "$(gh api …--jq '…|.[0].status')" = "completed" ]; do sleep 60; done` 这种
轮询判据**永远等不到**，后台 shell 空转（本次转了近一小时才被发现）。

这与本文件通篇在讲的是**同一个失效类**：**空结果与"还没就绪"不可分辨**。判据取不到
东西时必须能自陈，不能静默当成"条件未满足"继续等。

- **定式**：`gh api` 按 SHA 过滤一律 `FULL=$(git rev-parse origin/main)`，别用
  `git rev-parse --short` 的输出；轮询循环里加一条"查到的 run 数为 0 就报错退出"，
  别让它无限转。

## 写完任何一条守卫，先问三句：起点面全吗？终点面全吗？subject 是硬编码还是派生？（RFC-317 B11 定式）

RFC-317 一轮下来，**守卫失效最高频的形态不是判据写错，是判据只覆盖了它诞生的那一块**。
它们全都全绿，因为看不见的东西不会让人变红。已实撞的几种：

- **起点面不全**：`guardTestFiles` 初版只扫三个 `tests/` **顶层**目录，理由是「它们都是
  平铺的」——然后本 RFC 把第一个新守卫放进 `tests/architecture/` 子目录，于是两向钉死
  结构上看不见它却全绿。改成递归后另外还捞出一个既有漏网。
- **终点面不全**：`rfc286` F1 点名三个具体 class 名，同类 bug 在别处继续存在而它看不见
  （RFC-317 T61 把判据换成不变量后，同族一次查出**五**族）。
- **subject 硬编码**：判据写死「这四个文件不许出现这几个词」。RFC-317 T66 规则③把它换成
  **派生**（注释里提到的 RFC 在 `design/plan.md` 索引里已经 Done ⇒ 不该再有将来时），
  当场多捞出四处原 findings 没点到的同类。

**定式**：写完任一守卫，逐句自问——①**起点面全吗**（枚举递归吗？包含未跟踪文件吗？
跨包吗？）②**终点面全吗**（是「这三个名字」还是「这一类」？）③**subject 是硬编码还是
派生**（判据的一端是不是活的源码 / 注册表 / 索引？）。三句都过不了的守卫，它保护的只是
写它那天的那个样子。

## 一条需要几十条豁免才能变绿的规则，豁免本身就是新的空白许可证（RFC-317 T66 实测）

新判据第一次跑出几十条命中时，本能反应是「加豁免」。实测两次都证明该收窄判据而不是加
豁免：T61 的死 class 扫描初版 239 个 token 命中（`chip--` 这类插值残片），T66 的「N 类
ACL 资源」初版 **37 处**命中——绝大多数是**别的**花名册（bundle 的六类可打包资源、
RFC-310 的五类配置资源）或根本不是花名册（「新增一类 ACL 资源时」）。

一张几十行的豁免表会立刻退化成**永久免检名单**（见上文「死豁免是空白许可证」），
而且没人再敢删。**定式**：命中数远超预期时先假设**判据太宽**，去找一个更窄但仍然覆盖
真实事故形态的判据面——T66 最终只认「写出了成员的花名册」（`N resource types (a / b / c)`
且成员确实是 ACL 类型），一条豁免都不需要，仍然精确覆盖它要防的那个 bug。

## schema 反射型守卫只看一跳，级联改动它看不见（RFC-317 实测）

「声明了 X 列的表必须在 Y 枚举里」这类反射守卫，判的是**一跳**关系。一次改动如果是
A→B→C 的级联（新表进枚举 ⇒ 枚举驱动的 Record 要补键 ⇒ 补键又要求某个前缀映射表态），
守卫只会在第一跳上说话，后两跳靠 typecheck 或者**根本没人管**。

**定式**：写这类守卫时把「谁消费这个枚举」也列成判据的一部分（RFC-317 B1-c 的
`ACL_PERMISSION_PREFIX` 就是靠 `Record<MountedAclResourceType, …>` 的编译期穷尽把第三跳
逼出来的——那不是守卫做到的，是类型做到的）。判不了的跳数要在守卫注释里写明「本条只
覆盖第一跳」，别让读者以为它覆盖了整条链。

## 默认参数会把安全语义变成 opt-in，而且对三类扫描全隐形（RFC-317 实测）

`function f(x, opts = { strict: false })` 这种写法里，**不传就是最松的那档**。危险在于它
对本仓三类主力扫描**全部隐形**：导入图看不见（没有新边）、AST cast 禁令看不见（没有
cast）、源码文本扫描看不见（调用点根本没写那个词）。于是「这个能力默认关着」这件事
既没有测试、也没有守卫、也不在任何账本上。

**定式**：安全 / 隔离语义的参数**不给默认值**，逼每个调用点显式表态；确需默认时默认取
**最严**的一档，并给「显式放松」的调用点加一条棘轮（放松是可数的，收紧不用记账）。

## `git ls-files` 型守卫看不见未跟踪的新文件——本地快解是先 `git add`（RFC-317 B1-c 实测）

本文件开头已记过这条事故（RFC-311 T19：整批新文件假绿），但没写**本地怎么当场验**：
把新文件 `git add` 进索引之后 `git ls-files` 就能看见它，**不必先提交再验**。RFC-317
B1-c 又踩了一次——新的错误码守卫因为看不见刚写的新测试文件而误报。

顺带：守卫自己的语料枚举**优先用 `readdirSync` 递归**而不是 `git ls-files`，本仓
`census.ts` 的 `packageSrcUnits` 就是为此改的；`git ls-files` 只适合确实要「仓库里跟踪
的文件」这个语义的场合。

## AST 定位路由 handler 必须按 method + path，只按 path 永远取到最后注册的那条（RFC-317 B1-c 实测）

同一个 path 上常有两条路由（GET 列表 / POST 创建、GET 详情 / PUT 更新）。只按 path 匹配
的 AST 断言会**永远**取到最后注册的那条——于是你以为在断言列表 handler 的可见性过滤，
实际看的是创建 handler，而它恒定「工作正常」。

这类「锚错了但恒定错在同一处」的断言**比漏测更坏**：它看起来一直在工作，还会在 review
里被当成已覆盖。**定式**：定位 handler 一律 `method + path` 两个维度，并在断言失败信息
里把实际匹配到的 handler 位置打出来。

## 正则剥注释会吃掉真代码；判「某名字有没有被调用」只能用 AST（RFC-317 B1-a 实测）

想先剥掉注释再匹配调用形态时，非贪婪块注释正则（`/\*[\s\S]*?\*/`）会从**字符串字面量
里的** `/*` 一路吃到下一个 `*/`。实撞：`services/tasks.ts` 中间几百行连同真正的
`canViewResource(` 调用一起被吞掉，导致豁免表 stale 误报。

**定式**：判「这个名字被调用过吗」用 TS AST（`ts.forEachChild` 找 `CallExpression`），
对注释与字符串天然免疫。只需要注释文本本身时用 **TS scanner**（`createScanner(…, false)`
逐 token 取 `SingleLineCommentTrivia` / `MultiLineCommentTrivia`），同样免疫。

## 正向锁也会被一句注释满足，而且比负向锁更隐蔽（RFC-317 B1-a 实测）

本文件记过负向锁的坑（注释里的字面量会踩负向锁）。**正向**锁被注释满足更隐蔽：
`text.includes('requireResourceOwner')` 会被**文档注释里提到这个名字**满足，于是把
import 与调用一起拿掉（事故前的形状）仍然全绿。它不像假红那样吵，也不会让人怀疑——
一条「本该证明某件事已经做了」的断言，变成了「本该做这件事的人提过它」。

**定式**：正向锁同样走 AST 判「被调用过」，别用 `includes`。写完立刻做一次变异：
**把实现拿掉但注释留着**，守卫必须红。

## design 文档里裸写正则会被 CI 的 markdown link check 当成链接（RFC-317 落档实测）

`['"](?:a|b)['"]` 这类片段形如 `[...](...)`，`Markdown link check (design/)` 会真的去
请求 `(?:a|b)` 然后红——而红的原因与提交者本次改动毫无关系。RFC-317 落 `findings.md`
时实撞三处。

**定式**：文档里的正则**一律包进反引号**。这与本文件既有那条「opencode 源码引用写纯
文本、不写 GitHub 外链」同源：`design/**/*.md` 里任何长得像链接的东西都会被真的请求。

## 账本类的数，只信会执行那份数据的程序打印出来的值（RFC-317 T66 实撞）

写 2026-08-12 审计报告的勘误时，我用 `grep -c "rule: '"` 数 `KNOWN_VIOLATIONS`，得到 22，
差点写进文档——真值是 **37**。差额来自两处 `...(ARRAY).map(…)` 展开：**数语法元素只会
数到模板本身**，展开出来的条数在源码里根本不作为字面量出现。`bun run depcheck` 自己会
打印「已接受 37 / 37 条存量违规」。

同一个坑本仓已经付过一次学费——`architecture/ledger-baselines.json` 的
`depcheck-known-violations` 条目在 `why` 里专门写着「静态清点已按源数组长度展开计数」。

**定式**：①要写进文档的账本规模，用**跑起来的程序**取（脚本自己的输出 / `census.ts` 的
清点函数），不要 grep；②写数字的同时把**重数的命令**写在旁边，否则它就只是一个没人会
去核的数（RFC-317 T66 的勘误因此每条都带命令）。

## 订正过期断言时，复述旧措辞会踩到你自己刚写的守卫（RFC-317 T66 实撞）

「把过期断言改对」和「给它立一条源码文本守卫」通常是同一批做的。于是订正说明里那句
「原注释写着 XXX」就成了守卫的新命中——本批实撞：`structuralDiff/service.ts` 的订正里
复述了 `'wrapper' is not yet wired`，规则③当场红。

**定式**：给这类守卫定一条纪律并写进它的头注释——**复述历史措辞必须放进引号**
（本仓用 `「…」` / `"…"`），扫描前先剥引号内文本。这既解决了自伤，也顺带把「哪些是
断言、哪些是引用」变成了机器可分的东西。

配套一条：**归属判定要按注释块，不要按整文件**。规则③初版按整文件取「提到了哪些 RFC」，
于是一个文件里任何一个已 Done 的 RFC 都会让它红；更糟的是**变异自证当场暴露了它**——
把相关 RFC 的状态改成 In Progress 也不能让它变绿，说明派生端根本没起作用。按块归属之后
同一变异立刻通过，判据才真的挂在索引上。

## e2e 里「单次 focus() + 轮询断言」是不可自愈的，顺序一反就永久红（2026-08-24 实撞）

`await el.focus(); await expect(el).toBeFocused()` 看着是个带重试的断言，其实不是：
`focus()` **只发一次**，而 Dialog 的焦点陷阱在打开后**异步**把焦点送到 `initialFocusRef`。
两者顺序一旦反过来，陷阱把焦点收回去就再没有任何东西会重新聚焦目标——15 秒轮询走完只能
报 `Received: inactive`。本机 macOS 连跑 6 次全过、CI 上 ubuntu 分片连红三次（含两次重试）。

**判据**：这类失败**不是抖动**（抖动会时红时绿），是**负载相关的确定性失败**。看到
「本地怎么都过、CI 上稳定红」先怀疑它。

**定式**：不要去赛陷阱，**等它落定**——先 `await expect(<陷阱的 initialFocusRef 目标>)
.toBeFocused()`，再 focus 你要的元素。用例里已经加过的两道等待（「面板可见」）只是把
窗口收窄，不改变竞态本身；判断一道等待有没有用，看它等的是不是**导致竞态的那个动作**。

## CSS：`:has()` 是 (0,2,0)，换成单类修饰符会被后面的基类规则压掉（RFC-317 T62 实撞）

把 `.dialog__overlay:has(> .某特性面板) { padding: 0 }` 重构成由调用方声明的变体时，写成
裸的 `.dialog__overlay--flush`（特异度 **0,1,0**）会被**后面**那条
`@media (max-width: 720px) { .dialog__overlay { padding: var(--space-3) } }`（0,1,0，但更靠后）
压掉——原来的 `:has()` 写法是 **0,2,0**，压得住。窄屏几何当场变，e2e 的画布几何断言红。

**定式**：①用双类 `.dialog__overlay.dialog__overlay--flush` 补回 0,2,0；②变体规则放在
基类规则**之后**；③重构选择器时先算一遍两边的特异度，别只看「语义等价」。

同批第二个坑：**同一个特性可能有不止一个调用点**。`workflows.edit.tsx` 里有两个编辑器
面板 Dialog（palette :1147 与 inspector :1170），我只改了第一个，而 720×800 下渲染的是
第二个。改造共享原语的调用方时用 `grep -n` 数一遍调用点，别凭印象。

## 判「新规则是否覆盖旧规则」要比同一变异下的红绿，不能比判据的措辞（RFC-317 T70 实测）

写了一条「全域」规则之后，很自然会想把它取代的那几条「点名文件」的旧守卫退役掉——
措辞上「全域 ⊇ 三个文件」天经地义。实测**不成立**。

RFC-317 T70 的判法是：**删掉旧守卫，对同一个变异跑新规则**。四组候选里三组一眼可判，
第四组是反直觉的那个：把 `error-text` 重新引入源码，新旧两条都红（看着可以退役）；
但把 `form-error` 放进一个**非 ScriptEdit** 的文件，旧守卫红、**新的全域规则照绿**。
原因是两条判的根本不是同一件事——

- 全域规则判「这个 class 在 CSS 里**有没有定义**」；
- 旧守卫判「这个定义**在这个语境里生效吗**」。

`.script-env-table__row .form-error` 是**嵌套**定义：token 在 CSS 里确实存在，全域规则
因此认为它已定义；可它只在那一个 DOM 语境下生效，别处用仍然是无样式裸文本（原 bug 本体）。
两条规则不是强弱关系，是**正交**。

**定式**：退役任何守卫之前，先构造**旧守卫会红的那个变异**，确认新规则也红。构造不出
变异就说明你还没弄清旧守卫在防什么——那更不该删它。

## 「能力影响清单」与「任务分解」是两份账本，中间没有任何机器判据（RFC-317 T71 实撞）

按仓规，能力收缩型 RFC 的 `proposal.md` 要有**能力影响清单**并逐项呈用户确认；`plan.md` 另有
**任务分解**。这是两份独立的账本，而**没有任何东西保证第二份覆盖了第一份**。

RFC-317 实撞：九条能力影响 C1–C9 用户已逐项确认，其中 **C3**（`POST /api/runtimes/probe` 的
`extraArgs` / `isSandbox` 无能力门）在 `plan.md` 的 70 个任务里**一个都没对应**。收口时拿
findings 的 gid 与任务表对账才发现——在此之前，「52 条 P1/P2 逐条修复」与「C1–C9 各有拒绝
分支覆盖」两条验收标准都在「看起来做完了」的状态下静默不成立。

**为什么没人发现**：两份账本都在仓里、都被 review 过、都读起来很完整。少一条不会让任何
东西变红，也不会在 diff 上显形——**漏写不留痕迹**，这与本文件通篇在讲的失效类是同一个。

**定式**：收口前做一次**两向对账**——①能力影响清单的每一条，在任务表里找得到承接它的任务；
②findings 里每一条 P1/P2 的 gid，在任务表里被引用过。两条都是几分钟的脚本，而它们挡住的是
「验收清单全打勾、实际漏了一条已获批准的能力收缩」。

## 源码扫描守卫的失败信息里那句「改用 X」是经验法则，不是判决（RFC-317 T73 实撞）

`RFC-254 platform surface guard` 抓到 `` `${root}/` `` 时会说「use isLexicallyInside()」。
照做**会引入新 bug**：这条规则按**词法形态**匹配，分不出操作数是**宿主文件系统路径**还是
**URL path / 仓库相对路径**。

实撞：`codeHostEffects.ts` 的两个操作数都来自 URL 解析（`new URL().pathname` 恒 `/` 分隔、
百分号编码；`parseGitUrl` 同理）。`isLexicallyInsideForHost` 会在 Windows 上把 `/` 换成 `\`
并整体小写化——于是两个不同 namespace 的 code-host project 被判成同一个。**守卫是对的
（这个形态确实值得复核），建议是错的。**

**定式**：被这类形态规则抓到时，先回答一个问题——**这两个操作数到底是什么**？
①宿主路径 ⇒ 照建议改；②URL path / 仓库相对路径 / 协议线格式 ⇒ 走守卫的
「posix-by-contract」豁免档并把契约写进 `why`（本仓 `ALLOWANCES` 里这类已有 5 条，
每条都写明「为什么这里 `/` 是唯一可能的分隔符」）。**豁免不是认输，是把不变量写下来。**

## 任务表的「假红」和账本的「假绿」是同一个病，而假红更容易被容忍（RFC-310 接手实测，2026-08-24）

接手另一个 RFC 收尾时，任务表 247 行里 **13 行非 ✅**。逐条对源码核实后：**9 行是假红**——
东西早就做完了，只是没销账。典型如「删除 upgrade-candidates 并补不复辟棘轮」标着 ⏳，而
该端点在 `src` 下零命中、前后端两条反向棘轮都在仓里绿着。

**为什么假红比假绿更容易长期存在**：假绿会让人以为有保护而实际没有，一旦出事就会被追责；
假红只是「没打勾」，看起来无害，于是没人急着修。但它同样让人**回答不了「还剩什么」**——
接手的人要么把已完成的重做一遍，要么按 13 条未完成量出一个错误的工期，要么干脆不敢关闭 RFC。
本次实测：13 条里真正有价值的只有 2 条。

**定式**：

1. **收尾前逐条对源码核实，不读计划里的措辞。** 判据是「能在源码 / 测试里指出兑现物」——
   文件:行号、测试名。指不出来才是真未完成。
2. **回填时把依据一起写下**（本次是一张 9 行的对照表：任务 → 兑现物锚点）。只把 🚧 改成 ✅
   而不留依据，下一个人还得再核一遍。
3. **判「还有没有价值」要单独做，且允许答案是「不做」。** 本次两条判定不做并登记了理由
   （运维 dashboards/alerts：仓内零监控栈、形态取决于部署方；逐态像素快照：收益递减，
   且每加一个视觉场景就多一份要人工审图的基线）。**把「决定不做」写下来，读者才知道它不是被忘了。**

## 收口时给账本上棘轮，比把账本填对更值钱（RFC-310 T112 实测）

RFC-310 的 proposal 有 100 条验收标准，plan 里的「AC → 证据任务」表只有 71 行——缺的 29 条
越靠后越集中（后 8 个批次几乎全缺）。填齐它是一次性的；真正的问题是**往 proposal 加一条 AC
不会让任何地方变红**，所以它一定会再次落后。

**定式**：填账的同批把判据立起来。本次加的是「缺口逐字相等」棘轮——新增 AC 不补证据行 ⇒ 红，
补齐存量缺口 ⇒ 也红（逼你把账一起改小）。

**为什么不写成「缺口必须为零」**：仓内另有 5 个 RFC 共 118 条存量缺口。一次判红只有两个出路——
替别人编证据，或者加一串豁免；后者会变成空白许可证（见本文件对应条目）。**记账 + 只许缩**
是唯一诚实的形态：它锁住已经填好的，同时让别人的债保持可见、可清偿。

## `test-results/` 归 Playwright 所有：往里放采集产物会被别人的一次 e2e 清空（RFC-319 实撞，2026-08-24）

RFC-319 的运行期覆盖账本要在跑 e2e 时采集 daemon 的请求命中，第一版把 journal 写进
`test-results/route-hits/`——看起来很自然，那本来就是「测试产物」目录。

结果：**共享工作树上另一个 session 跑了一次 `bun run e2e`，Playwright 在运行开始时清空
`test-results/`，连我刚采集完、还没来得及入账的 journal 一起端走**。我随后照常跑重播脚本，
读到 0 份 journal，于是账本被写成「462 条端点全都没覆盖 / 60 条路由全都没加载」——
一个看起来很像「覆盖大幅倒退」的假结论，而且它会**通过**所有格式与结构断言。

两条定式：

- **采集类产物不要放在框架拥有的目录下**。Playwright 拥有 `testDir` 的 `outputDir`
  （默认 `test-results/`）并在每次 run 开始时清空它。放 `$CLAUDE_JOB_DIR/tmp/` 或
  workspace 下自建目录。
- **重播/入账脚本必须先断言语料非空**，再决定要不要写盘。这次是人肉发现的（数字太离谱），
  但「离谱」不是判据——脚本自己要有下界。RFC-319 的两条账本守卫现在各带一条
  `journal.files > 0` 与 `entries > 100`，`e2e-full-nightly` 另有「分片数不足就拒绝对账」。

**同族的第三条**：账本重播只能用**全绿**的那次跑。本 RFC 期间有一次全量跑因并发 session
的在制改动红了 2 条 spec，此时 journal 是残缺的——那两条 spec 平时会打到的端点这次没打到。
若直接重播，账本会**变大**（凭空多出一批「未覆盖」），把别人的在制破坏写进我的账本。
正确口径是把 journal 当**正向证据**：观察到被打中的就从账本里删掉，**绝不因为「这次没看到」
而往账本里加**。`e2e-full-nightly` 的 `needs.e2e-full.result != 'success'` 就拒绝对账，
本地重播也照此办理。

## MCP runtime-test 的提示词**不带 RFC-200 信封**：调 `requireOutputOpen` 的 stub 模式在这条路径上会当场 exit 3（RFC-319 B37 实测，2026-08-25）

`packages/system-mocks/src/runtime/skeleton.ts` 的 `requireOutputOpen` / `requireEnvelopeOpen`
在提示词里找不到 `nonce="..."` 就 `process.exit(3)`。工作流执行链的每个提示词都带这个
信封，所以绝大多数 stub 模式从来撞不到；**但 MCP runtime-test 是另一条 feature**
（`services/mcpRuntimeTest.ts` 的 `feature: 'mcp-runtime-test'` + 它自己的 SYSTEM_PROMPT），
提示词里没有信封。于是任何在这条路径上被启用、又调了 `requireOutputOpen` 的模式，
子进程会在**几十毫秒内**退出：

```
turn: status=failed exit_code=3
stderr: stub-opencode-slow: prompt is missing the RFC-200 envelope nonce
```

**为什么这件事很坏**：它不是把用例打红，而是把用例变成一场**赌局**。
`e2e/mcp-acl-session-termination.spec.ts`（RES-28）守的是「撤权要终止**在飞的**
runtime-test 会话」，而撤权那条事务只处理 `status='active'` 的会话——会话只在某个
回合还在飞的时候才是 active。stub 76ms 就死了，于是：本机 ACL 请求赢了竞态 ⇒ 绿；
CI 上慢一点就输 ⇒ 红成 `endReason: session-unusable`（那是回合自然收尾后的形态，
撤权什么都没标到）。**先后两次「修 flaky」都只是在把窗口调宽**（第一次是换
`slow` 模式，第二次是 `STUB_OPENCODE_SLEEP_MS=60000`），因为那个 sleep 排在
`requireOutputOpen` 后面，一次都没执行过。

**判据**：给这条路径写 e2e 时，别用「睡久一点」当前提。用 hold 文件把生命周期
**观测化**——`mode-slow` 现在支持 `STUB_OPENCODE_HOLD_FILE`：stub 起来先落
`<hold>.started`（调用方轮询到它才动手），然后一直挂着直到调用方删文件。
这个块**必须排在 `requireOutputOpen` 之前**，否则在无信封的路径上根本执行不到。
改完的实测证据：turn 变成 `interrupted` / `exit_code=143`（被 SIGTERM 掐断）、
stderr 为空，`--repeat-each=3` 稳定绿——而不是之前的 `failed` / exit 3。

**排查手法记一笔**：这类「本机绿 CI 红」不要靠加 sleep 猜。给 `startDaemon` 传一个
自己拥有的 `home`，跑完直接读 `db.sqlite` 的 `mcp_runtime_test_turns`——
`status` / `duration_ms` / `exit_code` / `stderr_tail` 四个字段一眼就把「进程是被谁
结束的」讲清楚了（16ms/interrupted = 赢了竞态；76ms/failed/exit 3 = stub 自己死的）。

## e2e 用共享工作树的构建验绿，等于**没验**——并发 session 的未提交生产改动会漏进去（2026-08-25 实撞）

`bun run build:binary:e2e` 编的是**工作树**，而 CI 编的是 `origin/main` 的干净 checkout。本仓常年有并发
session 的在制品躺在工作树里（实撞当天 58 个 ` M` + 若干未追踪文件），于是两者差着一整批未提交的生产代码。
后果是**双向**的，两个方向当天都真实发生了：

- **假绿**：用例依赖了**尚未提交**的生产代码。RFC-319 的一份工作组 ACL spec 按「testid 一律源码实读」写了
  `acl-level-*` / write 授权档 / `resource-read-only`，在工作树构建上 5/5 全绿——而 `origin/main` 上
  `AclPanel.tsx` 里 `acl-level-` 出现 **0** 次、`services/resourceAccessPolicy.ts` 根本不存在。真提交上去
  就是 CI 必红。
- **假红**：用例本身没问题，是**别人的**未提交改动把它打红了。同一批的首页/文档 spec 在工作树构建上
  5 失败 / 5 通过，在干净构建上 **10/10 全绿**。照着假红去「修」用例，等于把别人的在制品固化进自己的断言。

**定式：验收一律用「干净 `origin/main` 构建」，工作树构建只用于写用例时的快速反馈。**

```
SANDBOX=$(mktemp -d)
git archive origin/main | tar -x -C "$SANDBOX"
(cd "$SANDBOX" && bun install --frozen-lockfile)   # ← 必须；理由见下一段
(cd "$SANDBOX" && bun run build:binary:e2e)
AGENT_WORKFLOW_E2E_BINARY="$SANDBOX/dist/agent-workflow-e2e-<plat>-<arch>" bunx playwright test <spec…>
```

`git archive` 解出来的是一棵**普通目录**，不是 `git worktree`，不触犯本仓「禁开发用 worktree」那条硬规则：
它没有分支、不接收提交、只读用于构建。

**沙箱的 `node_modules` 绝不能软链回主仓——那会把「干净」当场作废（2026-08-25 实撞，本节配方的第一版就是错的）。**
本仓是 bun workspaces：`packages/*/node_modules/@agent-workflow/*` 是指向**同棵树内** `packages/<name>` 的
workspace 链接。把主仓的 `node_modules` 软链进沙箱，这些链接就会**经软链解析回主仓**，于是沙箱编出来的二进制
是个杂交体——`packages/backend` / `packages/frontend` 是 `origin/main` 的源码，`@agent-workflow/shared`
却是**脏工作树**的。这一层比上面那两个坑更阴，因为 `git status` 干净的目录看起来无可指摘。

实撞的具体形态：当天脏树里躺着别人 RFC-324 改过的 `packages/shared/src/schemas/resourceAcl.ts`，于是那个
「干净」二进制上 `PUT /resources/:type/:id/acl` 用 `{userIds:[…]}` 被 RFC-324 的 zod 判 **422**、用
`{grants:[…]}` 回 **200 且 `aclRevision` 前进**、但回读 `users` **恒为空**——**「给资源授权」整体是一次静默
no-op**。任何「先授权、再验证对方看得见」的用例在它上面要么红、要么假绿，且从测试侧无法绕过。软链的另一个
附带风险同样致命：在软链进去的沙箱里跑 `bun install`，会**写穿软链**改到主仓的 `node_modules`。

判据（跑之前花两秒确认，比事后归因便宜得多）：

```
R=$(readlink -f "$SANDBOX/packages/backend/node_modules/@agent-workflow/shared")
case "$R" in "$SANDBOX"/*) echo "✅ 在沙箱内";; *) echo "❌ 逃出沙箱，重来";; esac
```

省下的那次 `bun install` 不值这个风险——有全局缓存兜着，实测 **991ms / 1546 个包**。

**并行跑用例时还有一层**：多个 agent / session 同时跑 e2e 会争 `dist/` 这一个共享产物——一边在 rebuild、
另一边跑的就是半截构建。把干净构建**复制一份钉住**，各自 `AGENT_WORKFLOW_E2E_BINARY` 指过去即可；但要记住
钉住的那份也必须来自干净树，否则只是把上面那个坑固化了一遍（实撞：第一版钉的副本恰好是 RFC-324 的半程
构建——后端新、内嵌前端旧，打开 ACL 弹窗当场 `undefined.map`，连既有的 `rfc099-ownership-acl.spec.ts`
一起红）。

## e2e 里凡是 `page.route` 拦 API 的，handler 里都不许出现 `route.fetch()`（2026-08-25 实撞并实测定因）

一条本机与 ubuntu 腿都绿的用例在 macOS 腿上稳定红，报的是：

```
Error: "route.fetch: Target page, context or browser has been closed
```

而且**红在 648ms**——不是超时，是竞态。两个事实叠出来的：

**① 前端一次冷加载会给同一个接口打两次请求。** 本仓大量页面是「useQuery 先挂载打一次 → WS 连上后
`reconcileOnOpen` 再 invalidate 补打一次」（例如
`packages/frontend/src/hooks/useClarifyWs.ts:75` → `packages/frontend/src/hooks/useWsInvalidation.ts:117-124`）。
用例的断言只要第一次的响应就满足了，于是**正文结束点可能只比第二个 handler 收尾早几十毫秒**（实测探针：
第二次 callback 收尾在 +399ms，正文结束在 +428ms，余量 **29ms**）。CI 机器忙一点、WS 握手晚一点，
这 29ms 就翻成负数：正文已经结束、拆环境把 page 关了，第二个 handler 还在飞。

**② Route 动词里只有 `fetch()` 会因此抛错。** `playwright-core` 的 `fulfill` / `continue` /
`fallback` / `abort` / 重定向全都包在 `_raceWithTargetClose()` 里，页面关掉时**静默放弃**；只有
`route.fetch()` 走 `_wrapApiCall`，没有这层 race。所以同一个竞态下，红永远落在那一句上——
这也解释了为什么这类红看起来「毫无道理」，以及为什么把 handler 拖慢一点时**报错归属会漂到下一条用例上**。

**两把锁，缺一不可：**

- **锁 A：handler 里不要 `route.fetch()`。** 要回源的真实响应，就在 **Node 侧**用测试自己的 API
  helper 预取好（同一个 daemon、同一个 token、同一条路径，拿到的就是页面本来会拿到的那份），
  handler 里只剩一次 `route.fulfill(注入体)`。顺带把 `page.route('**/api/xxx/**')` 这种通配换成
  **URL 谓词精确匹配**本轮那一条路径，无关请求不再进 handler，`route.fallback()` 分支也一并消失。
- **锁 B：`test.afterEach` 里 `await page.unrouteAll({ behavior: 'wait' })`。** 先摘掉全部 handler，
  再**趁 page 还活着**把已经在跑的等完，拆环境时就不存在「还在飞的 callback」。
  **必须是 `'wait'`，不是 `'ignoreErrors'`**——后者只是把错吞掉，那等于「重跑就过了」。
  同理，用例中途摘注入也要用 `unrouteAll({behavior:'wait'})` 而不是 `unroute()`：后者不等在飞的
  handler，被摘掉的注入可能 fulfill 到重新导航后的**新页面**上。

**怎么确认自己真修掉了而不是碰巧躲过去**：人为把第二次 callback 延后（`await new Promise(r=>setTimeout(r,500))`
塞进 handler）。旧写法下这会**稳定复现**同一条报错、同一个行号；两把锁都上之后应当仍然绿，且那条用例的
耗时会明显变长——那正是锁 B 在等它跑完。

## gitleaks 的 git 模式与文件模式判定不一致——查它的红时别用 `--no-git` 复现（2026-08-25 实测）

CI 跑的是 `gitleaks detect --source . --no-banner --redact --verbose`，即**git 模式**（扫的是
每个提交的 patch，所以 checkout 要全历史）。本机想复现时很自然会顺手加 `--no-git` 只扫工作树，
**那会得到不同的答案**：同一份 `e2e/rfc319-*.spec.ts`，`--no-git` 报 5 条 `generic-api-key`，
而 git 模式扫完 4111 个提交（含引入这些行的那几笔）**一条都不报**。两边都不是 bug，是判定面不同——
按错的那个改，要么白改，要么把真红当成假红。

顺带两个会让人白跑一轮的细节：

- **`-i /dev/null` 不等于「绕过 `.gitleaksignore`」**。`--gitleaks-ignore-path` 期望的是「.gitleaksignore
  文件或含它的目录」，给个字符设备会被静默忽略、退回默认的 `.`，于是你以为在裸跑，其实 ignore 全程生效。
  真要绕过就 `-i "$(mktemp -d)"` 指一个空目录。
- **误报的正解是 `.gitleaksignore`，不是改代码**。git 模式扫的是历史，夹具名一旦入库就永远在那儿，
  事后改名救不了已有的提交（指纹形如 `<commit-sha>:<file>:<rule>:<line>`，与那一笔绑死）。仓库根的
  `.gitleaksignore` 是官方机制，会被自动加载；每加一条写清它是什么，别攒成一张无人认领的清单。

## RFC-319 有三份账本，其中两份**只在夜跑对账**——补完 e2e 只改能力账本会把主干推红（2026-08-25 实撞）

`architecture/` 下三份机器账本问的是三个不同的问题：

| 账本                               | 分子从哪来                                             | 什么时候对账         |
| ---------------------------------- | ------------------------------------------------------ | -------------------- |
| `e2e-capability-ledger.json`（R3） | 人工填 `{file, test}`，守卫验证标题逐字存在            | **本地 / PR 腿都跑** |
| `e2e-endpoint-coverage.json`（R1） | **运行期实测**：daemon 请求日志 → `route-hits/*.jsonl` | **只有夜跑**         |
| `e2e-route-coverage.json`（R2）    | **运行期实测**：浏览器 `framenavigated`                | **只有夜跑**         |

后两份的守卫是 `describe.skipIf(JOURNAL_DIR === null)`——没有 journal 就整段跳过（这本身是对的：
没有语料就不该假装能对账）。**净效果是：你补了一批 e2e、只改了 R3，本地全绿、PR 腿全绿，
然后当晚的 `e2e-full-nightly` 红在「RFC-319 覆盖账本对账」上**，而红的原因是「你的用例覆盖得比账本
记的多」——账本没跟着改小，差额会变成下一个人的免费槽位。

**订正不要靠猜**，把夜跑的实测语料拉下来在本地复现：

```
RUN=$(gh run list --workflow=e2e-full-nightly.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run download "$RUN" --pattern 'route-hits-shard*' --dir journals
mkdir -p route-hits && find journals -name '*.jsonl' -exec cp {} route-hits/ \;
cd packages/backend && AW_E2E_ROUTE_JOURNAL="$PWD/../../route-hits" \
  bun test tests/architecture/rfc319-endpoint-coverage.test.ts tests/architecture/rfc319-route-coverage.test.ts
```

失败输出里的 `- "…"` 就是**可以从账本里删掉**的条目（已被真实打到），`+ "…"` 是**新出现的未覆盖**
（新挂端点没人测）。删完别忘了同步 `architecture/ledger-baselines.json` 里对应的 `baseline` 数字。

**一个时序上的坑**：journal 采自某个具体 SHA，所以它只反映**那时**的覆盖面。刚合进去的那批 spec
要等下一次夜跑才会体现——下次再报一批可降的差额是账本在正常还债，不是新的红。

**别等它红——可以预对账。**「正常还债」在机制上仍然是**一次夜跑红**（R1 的判据是逐条相等，
多覆盖了也红）。要把下一次的红一起消掉：把新合进去的那几份 spec 在本地按同一个开关跑一遍，
生成的 journal 与夜跑那份**并到一个目录里**再对账——并集就是下一次夜跑会测到的命中面。

```
mkdir -p union-hits && cp route-hits/*.jsonl union-hits/
AW_E2E_ROUTE_JOURNAL=$PWD/new-hits bunx playwright test <本批新增的 spec…> --project=chromium
i=0; for f in new-hits/*.jsonl; do i=$((i+1)); cp "$f" "union-hits/local-new-$i-$(basename $f)"; done
cd packages/backend && AW_E2E_ROUTE_JOURNAL="$PWD/../../union-hits" \
  bun test tests/architecture/rfc319-endpoint-coverage.test.ts tests/architecture/rfc319-route-coverage.test.ts
```

实测（2026-08-25，B84）：只按夜跑 journal 对账销掉 6 条（178 → 172），并上 6 份新 spec 的命中后
又销掉 8 条（172 → 164）——后面这 8 条就是不做预对账时下一次夜跑必然报的那一批红。
**残余风险**：本地是 macOS/chromium 单机跑、夜跑是 ubuntu 四分片，理论上可能有命中差异；
真差了下次夜跑会以 `+ "…"` 的形式报出来（比不做预对账多一步，但少一次必然的红）。

## 要证明「置灰的东西真的点不动」，必须 `click({ force: true })`（2026-08-25 实撞）

Playwright 的**可操作性检查**把 `aria-disabled="true"` 的元素判为 not enabled，普通 `click()`
会一直等它变可用、然后超时。于是一条本想断言「这一行灰着、点它没反应」的用例，实际得到的是
**自己造出来的超时**——它可能"红"，但红的原因是 Playwright 拒绝派发点击，而不是产品真的拦住了；
反过来如果用例把超时当成预期，那就更糟：产品哪天把 `if (!rowDisabled)` 那层真实守卫删掉，
`aria-disabled` 还画在那儿，用例照样"通过"。

正确写法是两条断言分开：

```ts
// ① 灰着这件事本身（可及性契约）
await expect(row).toHaveAttribute('aria-disabled', 'true')
// ② 灰着的行**点下去也不生效**（真实守卫）—— 必须 force 才能真的把事件打进去
await row.click({ force: true })
await expect(row).toHaveAttribute('aria-selected', 'false')
```

不加 `force` 时第②条锁不到任何东西；只有 ① 时，「aria-disabled 只是画上去的」这种退化不会红。
两条一起，才能分辨「灰得对」与「灰得只是好看」。

## 变异不咬人有三种成因，只有一种说明用例是假的（RFC-319 B83 实撞，2026-08-25）

抽样变异是本仓 e2e 的核心质量门：注入一个语义变异 → 用例必须红 → 还原 → 必须绿。
但 **NO-BITE 不等于「用例是假的」**，把三种成因分开才知道下一步该做什么：

1. **变异本身语义恒等**（我改的东西根本没改行为）。
   实撞：`FuseDialog.tsx` 的 re-seed effect 依赖数组 `[open, seededMemoryIds, seededSkillId]`
   被我改成 `[open]`，想造出「重开弹窗不跟当前勾选」。**它不咬是因为它没错**——
   `open` 从 false 翻 true 的那一次渲染里，闭包拿到的本来就是**当前**的
   `seededMemoryIds`，多出来的两个依赖只在「开着的时候源变了」才有意义。
   真正会错的那种是让第二次打开**不覆盖**已有选择：
   `setPicked(new Set(...))` → `setPicked((prev) => (prev.size > 0 ? prev : new Set(...)))`。
   **判别法**：写完变异先说清「产品在这个变异下，用户看得见的行为差在哪一步」，
   说不出具体那一步就说明变异是恒等的。

2. **被变异的那条分支在产品里不可达**——它是死防御，用例照不到它天经地义。
   实撞：`MemoryPendingBadge.tsx:26` 的 `items.filter((item) => item.canManage === true)`
   去掉过滤后一条 e2e 都没红。回源查实：候选行只对持 `resource-acl:bypass` 的操作者可见
   （`packages/backend/src/routes/memories.ts:133` 先跑 `dropCandidates`），而**对 bypass
   操作者，每一行都被逐行盖成 `canManage: true`**（`packages/backend/src/services/memory.ts:882-883`
   的短路）。也就是说「看得见但管不了的候选」这一态**在产品里不存在**，那个过滤永远
   删不掉任何行。**判别法**：把变异后本该出现的那个状态用接口/夹具**手工造一次**；
   造不出来就是不可达。造不出来时**不要**为了让变异咬人去改产品，也不要把不可达状态
   写进断言。

3. **用例真的是假的**——它声称守着这行，实际断言恒真。这才是要改用例的那一种。

另外：第 2 种情形下，那条守卫往往**在另一层**已经有人管了。上例的
`countManageableMemoryCandidates` 在 `packages/frontend/tests/memory-admin-gate-role.test.ts:31-42`
既有纯函数单测、又有一条源码文本断言（`toContain('item.canManage === true')`），
我那个变异会把**前端单测**打红，只是打不红 e2e。所以 NO-BITE 之后的第一件事是
`grep` 一下这个符号在别处有没有守卫，别急着给账本记债。

## `docs/**` 不在 CI 的 prettier 扫描面内，别对它跑 `--write`（2026-08-25 实撞）

`package.json` 的 `format:check` 只覆盖 `packages/**`、`package.json`、`playwright.config.ts`、
`e2e/**`、`.github/workflows/*` 与两个 scripts——`docs/**` 与 `design/**` 都在外面。
往 `docs/dev-gotchas.md` 追加一节后顺手跑 `bunx prettier --write docs/*.md`，会把**存量**
内容一起重排（实撞：一张 markdown 表格整体重算列宽 + 若干段落重新折行，20 行删改与本次
改动毫无关系），在多人共享工作树上等于替别人改文件。判别法：改完先看
`git diff --stat`，纯追加应当是「N insertions, 0 deletions」；出现 deletions 就说明
碰了存量。校验 prettier 状态时也注意**把文件拷到仓外再 `--check` 会用默认配置**，
结论不可信（仓内有 `.prettierrc`）。

## `test.use({ reducedMotion })` 在本仓不生效，只有 `page.emulateMedia()` 有用（2026-08-25 实测，带对照）

按 `test.use({ reducedMotion: 'reduce' })` 写的用例，页面里
`window.matchMedia('(prefers-reduced-motion: reduce)').matches` 读出来是 **false**——
也就是 reduced-motion 那条分支**根本没被走到**，用例是恒绿的假保护。

对照实验（同一个 page、同一段 `setContent`）：

| 写法                                                   | matchMedia 结果 |
| ------------------------------------------------------ | --------------- |
| `test.use({ reducedMotion: 'reduce' })`                | `false`         |
| `await page.emulateMedia({ reducedMotion: 'reduce' })` | `true`          |

仓内既有的 5 处（`rfc250-interaction-integrity` / `rfc250-workflow-camera` /
`rfc229-workgroup-message-quotes` / `ux-consistency` / `rfc250-visual-states`）本来就
都用的 `emulateMedia`，所以没有存量假绿；这条是给后来人立的。

**写法**：`emulateMedia` 之后**再加一条常驻断言**，把「媒体特性真的落下去了」本身钉住——
否则哪天换 Playwright 版本或换 project 配置又静默退化成假绿：

```ts
await page.emulateMedia({ reducedMotion: 'reduce' })
const state = await page.evaluate(() => ({
  reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  // …顺便把要断言的那个观测量一起取回来
}))
expect(state.reducedMotion, '浏览器没有报告 reduced-motion ⇒ 这条用例根本没走到那一支').toBe(true)
```

同类推论：任何「靠环境开关才成立」的断言（媒体特性、时区、语言、权限），都要先断言
**开关本身生效了**，再断言产品行为。少了前半句，开关失效时你得到的是一条永远绿的用例。

## 变异工装解析 Playwright 失败清单时，别按「N) 」找——真红会被误报成 NO-BITE（2026-08-25 实撞）

`line` / `list` reporter 的失败摘要**不带序号**：先一行 `4 failed`，再缩进逐条列
`[chromium] › e2e/x.spec.ts:241:1 › 标题`，最后才是 `3 passed (35.8s)`。
按 `^\s*\d+\)\s+\[` 匹配（那是 `--reporter=list` 详细段里失败**详情**的形状）会一条都
扫不到，于是 4 条真红被判成 4 条 **NO-BITE**。

这个方向的错比反过来危险得多：NO-BITE 的标准反应是「这条用例是假的，去改用例」或
「这个分支不可达」，而真相是**用例好好的、工装瞎了**。差一点就把四条真能咬人的用例
判成假绿并去动它们。

两条处置，缺一不可：

1. 匹配放宽成 `^\s*(\d+\)\s+)?\[[a-z]+\]\s+›`，把带序号与不带序号两种形状都收进来；
2. **把变异跑的完整 stdout 落盘**，别只在结果 JSON 里留个几百字的 tail——判定存疑时
   要能回看原文，而不是靠截断的尾巴猜。

判别法（不依赖解析）：拿 `passed` 的条数与文件里的用例总数对一下，对不上就说明有红/未跑，
无论解析器说了什么。

## 更正一条流传的说法：文件级 `test.setTimeout()` **是**生效的（2026-08-25 实测）

有报告称「文件作用域的 `test.setTimeout()` 对本文件不生效，超时预算仍是 config 里的 90s」，
并据此建议去改 `rfc319-task-list-and-filters.spec.ts` / `rfc319-settings-sections.spec.ts`。
实测证伪：一个文件顶层写 `test.setTimeout(3_000)`、用例里睡 6 秒，报的是
`Test timeout of 3000ms exceeded`——**文件级调用确实作用于本文件的用例**。

真正会踩到的是**另一件事**：hook（`beforeAll` / `beforeEach`）有自己独立的超时预算，
`test.setTimeout()` 改不到它。所以「明明设了 240s 却在 90s 断」的现象，先看红在
hook 里还是 test 体里，再决定是 `test.describe.configure({ timeout })` 还是
`test.setTimeout()`。**不要**因为这个现象去删别人文件里本来正确的文件级设置。

## `git diff --cached --stat` 只给行数、不给归属——共享账本文件必须逐 hunk 认领（2026-08-25 实撞，主干红）

CLAUDE.md §提交纪律 要求「推之前 `git diff --cached --stat` 看一眼暂存区，出现任何你
没打算提的路径就停下」。这条挡得住**多出来的文件**，挡不住**同一个文件里多出来的行**。

实撞：我提交 `architecture/ledger-baselines.json`（我要改的是 RFC-319 的 gap 基线），
stat 那行显示 `11 +-`，我把它整个算作自己的改动。实际上里面混着并发 session 尚未提交的
一条 `rfc326-exempt-review-routes`，它点名的守卫文件 `…/rfc326-review-tool-route-guard.test.ts`
在 main 上并不存在——推上去之后清点脚本 ENOENT，RFC-317 T16 两条断言当场红。
同一笔还顺走了 `e2e-capability-ledger.json` 里对方新加的 5 行能力（证据指向一个同样
不在 main 上的 spec 文件），而配套的 `findings.json` 我没提，账本与审计台账条数也对不上。

**根因不在「忘了看」，在「看的东西粒度不够」**，再加一条容易被忽略的机制：
`git commit -- <path>` 提交的是那些路径的**工作树内容**，不是你 `git add` 的那一份。
所以「我只 add 了自己的 hunk」并不能保护你——`git add -p` 的选择会被随后的
`git commit -- <path>` 整个覆盖掉。

**规矩**：凡是**多人共写**的文件（本仓典型是 `architecture/*.json`、
`design/*/plan.md`、`design/*/findings.json`、`docs/*.md`、`STATE.md`），提交前一律

```
git diff --cached -- <file>      # 逐 hunk 读，不是 --stat
```

认领不出来的 hunk 一律先问，别猜。**账本类文件还要多问一句**：我这一笔里新增的条目
所**指向的文件**，在 `origin/main` 上存在吗？账本条目与它点名的文件必须同批落地，
少一个就是一条 ENOENT 型的红，而且红的信息里不会提「谁把它带上来的」。

**误发布别人在制内容之后怎么办**：撤销自己发布的那部分（把文件恢复成对方未提交时的
样子），**不要**替对方把缺的文件一起补提——那是在替别人决定「他的工作可以发布了」。
撤完立刻告诉对方哪几处被撤了、他们重提时要连带哪些文件。

**如果你改用 `commit-tree` 绕开共享 index，记得回头把 index 对齐。**
临时索引（`GIT_INDEX_FILE` + `read-tree HEAD` + `update-index` + `commit-tree` +
`update-ref`）是这棵共享树上最干净的提交姿势——工作树与共享 index 全程不动，别人的
在制品不可能被带走。但它有个**必须收尾的副作用**：HEAD 前进之后，共享 index 对这些
路径仍停在旧内容上，于是 `git status` 里新文件显示成 `D `（暂存删除）、改过的文件显示成
`MM` 且 index 落后于 HEAD。**任何 session 一次裸 `git commit` 就会把它们按旧内容提回去**，
等于当场回退你刚推的东西。收尾一句就够：

```
git reset -q HEAD -- <你刚提交的那些路径>
```

它只把 index 对齐到 HEAD，**不碰工作树**，所以别人未提交的编辑原样保留。
（2026-08-25 实撞：两笔 commit-tree 之后 status 里出现两条 `D  e2e/rfc319-ops-*.spec.ts`。）

## 「固定 sleep 之后直接断言终态」是一枚定时炸弹，忙碌的 runner 上必然响（2026-08-25 主干实撞）

`Backend tests (ubuntu-latest shard 3/4)` 红在
`change-narrative.test.ts` 的「RFC-239 config: deps.runtimeName selects the per-feature
runtime row」，`Expected: "ready" / Received: "generating"`。成因不是产品回归，是那条用例
`await new Promise((r) => setTimeout(r, 80))` 之后就断言异步生成已经落定——80ms 是**在本机
量出来的经验值**，CI runner 一忙就不够。这类红与提交者的改动毫无关系，只会让下一个人先
花时间排除自己。

**修法是轮询到终态，不是把 80 改成 800**（改大只是把炸弹推远，而且让快的时候也白等）：

```ts
async function settleX(id: string): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const s = await getXStatus(id)
    if (s?.status !== 'generating') return // 终态就返回
    if (Date.now() > deadline) throw new Error('10s 内没有落定，仍停在 generating')
    await new Promise((r) => setTimeout(r, 10))
  }
}
```

**怎么证明这个修法真的有效**（别只跑三遍绿就宣布好了——本机快，跑一万遍也绿）：把被等的那段
人为放慢（例如给 `runFn` 加 `await sleep(300)`），然后**同一文件、同一条件**下比新旧两种写法：
实测旧写法 `10 pass / 1 fail`（`Received: undefined`），新写法 `11 pass / 0 fail`。
这条对照才是证据，三次本机绿不是。

顺带一提：`setTimeout` 本身不是罪——用在「模拟被测对象要跑多久」（放在 `runFn` 里）是对的，
罪在「用它替代对终态的等待」。全仓 `packages/backend/tests/` 下还有十来个文件带固定 sleep，
逐个甄别成本不低，但**下次谁的分片红在这类断言上，先照上面的对照实验判一次**，别急着重跑。

## `bun:sqlite` 的 `db.exec()` 对多语句脚本里的约束错误**不抛异常**——夹具会「报成功、种零行」（2026-08-25 实测最小复现）

`e2e/command.ts` 的 `runSqlite`（走 `fixtures/sqlite-exec.ts` 的 `db.exec(sql)`）是全仓 e2e 造数据的
主力。它有一个会静默毁掉整条用例的行为：**一段多语句脚本里只要有一条撞了约束，整个事务回滚、
一行都不落库，而 `exec()` 本身不抛任何异常**，调用方看到的是「成功」。

最小复现（实跑）：

```ts
db.exec(`CREATE TABLE m (id TEXT PRIMARY KEY, trig TEXT REFERENCES m(id) ON DELETE SET NULL);`)
db.exec(`PRAGMA foreign_keys=ON;
BEGIN IMMEDIATE;
INSERT INTO m (id,trig) VALUES ('a',NULL),('b','a'),('c','ghost');
COMMIT;`)
// → exec 没有抛；rows: []   ← 连合法的 a / b 两行也一起没了
```

后果不是「夹具没生效」这么温和：**随后的 UI 断言会红在一个完全错误的原因上**，排查的人会先去怀疑
产品、怀疑选择器、怀疑时序，而真正的原因在几十行之前那句「成功」的夹具里。

**写夹具的纪律**：种完必须**回读自证**（`SELECT` 出来数一下行数 / 关键字段），别信 `runSqlite`
的返回。`e2e/rfc319-workgroup-room-and-delivery.spec.ts` 的 WG-37 有一处按这条写的注释可参考。
**根治建议**（未做，登记在 `docs/audit-backlog.md`）：`fixtures/sqlite-exec.ts` 的 exec 模式改成
逐语句 `prepare/run`，或执行后校验 `changes()`。

## 沙箱重新同步到更新的 `origin/main` 之后，必须**重新 `bun install`**（2026-08-25 实撞）

`docs/dev-gotchas.md` 已有的那条说「clean sandbox 必须在里面自己 `bun install`」，但没说**每次
重新展开之后都要再来一次**。实撞：沙箱按新的 `origin/main` 重新 `git archive | tar -x` 之后，
前端构建红在

```
[vite]: Rollup failed to resolve import "decode-named-character-reference" from
  packages/frontend/src/components/prose/rehypeWrapAnchors.ts
```

——那是并发 session 刚落的一笔带进来的**新依赖**，而沙箱的 `node_modules` 还是上一次装的。

**更阴的是它伪装成什么**：我当时用 `bun run build:binary:e2e 2>&1 | tail -1` 取输出，正好只取到
一行空行，而外层 wrapper 的退出码是 0，于是**构建失败被完全吞掉**；playwright 随后用**上一次的
旧二进制**跑，4 条用例红——看起来像是用例假绿，实际是我在用一个过期的产品跑新用例。
`strings dist/stub-opencode-* | grep <新分支里的字符串>` 一查就现形（0 命中，且产物 mtime 停在上一次）。

两条纪律：①重新展开沙箱之后**无条件** `bun install --frozen-lockfile`；②**构建输出要看退出码，
不要 `| tail -1`**——管道会把退出码换成末段命令的，失败信息又常在中间几十行。

## Playwright 一条用例红之后会**换 worker**，`beforeAll` 重跑、daemon 也换一个（2026-08-26 实撞）

同一个 spec 文件里如果「后面的用例依赖前面用例留下的状态」，那么**第一条红的那一刻，
后续用例赖以存在的夹具会凭空消失**——worker 被丢弃、新 worker 重跑 `beforeAll`、daemon 换了一个。
症状是一条无关的红被放大成一串莫名其妙的连带红，排查的人会去追那些连带红的「根因」，
而真正的根因在最前面那条。

**纪律**：同一 spec 文件里**每条用例都要自带夹具**；不要写「第 3 条用例用第 1 条启动的那个任务」。
另外**不要图省事上 `describe.configure({ mode: 'serial' })`**——它会让第一条红之后其余
`did not run`，变异验证就无法按「红了几条」归因（见本文件「变异工装解析」那节）。

## `git fetch --all` 已经带回指向已取回提交的 tag，`--tags` 只对「不可达的 tag」有意义（2026-08-26 实测）

做变异实证时把 `fetch --all --prune --tags` 里的 `--tags` 拿掉，用例**没红**。别急着判用例假绿——
本地小实验就能定因：

```
origin: git init; commit; (clone) ; 然后 origin 上 git tag v1.0.0
mirror: git fetch --all --prune          # 不带 --tags
        git tag -l   →   v1.0.0          # 已经带回来了
```

`--tags` 影响的只是**不被任何已取回 ref 可达**的 tag（例如指向已被删分支的悬空 tag）。
夹具若不构造那种形态，去掉 `--tags` 就是**语义恒等变异**——属于「NO-BITE 三种成因」的第 1 种。
这条同时是个方法示范：**定因靠十行的本地实验，不靠推测**。

## 新增守卫测试必须同时登记进 `architecture/guard-manifest.json`（否则当场推红 main）

2026-08-26 实撞：往 `packages/frontend/tests/` 加了一个扫源码的守卫，没登记，
**backend 四个分片一起红七条**——RFC-317 的三套棘轮同时开火：

- `rfc317-architecture-ledgers.test.ts` ——「清单与磁盘逐条相等：删守卫 / 改守卫名 /
  **加守卫不登记**，三种都红」；
- `rfc317-guard-corpus-floor.test.ts`（T13）——扫语料的守卫必须自带
  `expect(<语料>.length).toBeGreaterThanOrEqual(N)`，且 N 与清单的 `minCorpusFiles` 两向相等；
- `rfc317-guard-negative-fixture.test.ts`（T14）——「扫语料 + 断言不存在」的守卫必须配负
  fixture：把伪造的违规喂给**扫描用的同一份判据**并断言它报。

**三个容易漏的点**：

1. **红在 backend，锅在 frontend**。守卫扫描面是 `packages/backend/tests` + `packages/frontend/tests`
   两棵树（`rfc317-ledger-highwater.test.ts:231-232`），但跑它的是 backend 分片。加了个前端测试
   却看到 backend 红，第一反应容易归因给别人——先跑
   `cd packages/backend && bun test ./tests/architecture/` 再判。
2. **负 fixture 必须喂「同一份」判据**。判据内联在 `test()` 体里是喂不进去的，得先提到模块顶层 /
   抽成纯函数；各留一份拷贝的话，fixture 证明的只是拷贝还活着——T14 的报错原文就这么写。
   再配一半反向断言（「组件接得住时必须闭嘴」），否则判据退化成恒报也照绿。
3. **`corpusScanner` 是按 AST 自动判定的**，不是自己填的：只要调了 `readdirSync` / `globSync` /
   `guardTestFiles` 等枚举语料的函数（`census.ts:482` 的 `CORPUS_ENUMERATION_CALLEES`）就算，
   躲不掉。清单里 `runner` 按所在包填（前端 36 条全是 `vitest`，后端是 `bun`）。

**动手顺序**：先写守卫 + 语料下限 + 负 fixture → `bun test ./tests/architecture/` 全绿 →
再 append 清单条目（`lines` 按实际行数填）→ 再提交。反过来先提交必然红一轮。

## 共享工作树上「改完账本再去跑测试」有一个窗口，别人会在窗口里覆写你的文件

2026-08-26 实撞，把 `main` 推红一次（RFC-317 T16「条目数与基线逐字相等」）：

1. 我改了 `architecture/e2e-endpoint-coverage.json`（来源 164 → 147）**并同批改了**
   `architecture/ledger-baselines.json` 的 baseline，脚本打印「基线已同步」；
2. 跑测试确认 46 pass 0 fail；
3. 跑了别的、又跑了一遍全量守卫；
4. `commit-mine.py` 提交这三个文件。

结果 committed 出来是「来源 147 / 基线 164」。原因：**②③④ 之间有几分钟窗口**，共享工作树上
另一个 session 覆写了 `ledger-baselines.json`（他们在 pin 自己的 provenance），而
`commit-mine.py` 取的是**工作树内容**，不是我写下去的那一份。测试当时是绿的，因为测试跑在
覆写**之前**——绿本身没有说谎，只是它证明的那份文件已经不是被提交的那份了。

**处置（两条，缺一不可）**：

- **账本 / 生成物这类「多 session 都会写」的文件，改完立刻提交**，别在中间插入长耗时步骤。
  中间要跑全量守卫的话，跑完**回到第 1 步重跑一遍写入**再提交。
- **提交后回读 committed 内容复核**，不要只信提交前的测试：
  ```
  git show HEAD:architecture/ledger-baselines.json | python3 -c '…' # 与来源逐条对数
  ```
  这一步几秒，是唯一能抓住「窗口期被覆写」的判据——提交前的任何检查都抓不到它。

同理适用于 `STATE.md` / `design/plan.md` / `docs/*.md` 等共享索引：那些文件用
「HEAD 内容 + 只有我这几行」的覆盖副本入库（`commit-mine.py` 的 `路径=覆盖文件` 形式），
从根上绕开这个窗口。账本类因为要跟着测试结果走，绕不开，只能靠「立刻提交 + 回读复核」。

## `architecture/ledger-baselines.json` 同时被两套机制盯着：改它之前先知道会踩到谁

2026-08-26 起，这个文件有**两个互相不知道对方存在**的看门人：

1. **RFC-317 的高水位棘轮** —— 要求每条 `baseline` 与来源账本的条目数**逐字相等**，且只许降。
   RFC-319 每落一批 e2e 就必须改它（夜跑的覆盖账本对账是逐条相等断言，来源改小了不同批改基线就必红）。
2. **RFC-294 N1a 的 content-addressed provenance** —— 把这个文件的**内容摘要**也 pin 进了 canonical
   snapshot（`packages/backend/tests/architecture/rfc294Canonical.ts` 的受管文件清单）。

于是「RFC-319 改一次基线」＝「RFC-294 的 pin 失效一次」，需要对方 repin。今晚实际发生过：
`f848bc130`（我改基线）→ `6e5c16be6`（对方 repin）。

**动它之前**：

- 只改**自己那几条**的 `baseline` 与 `why`，**绝不重排 `ledgers` 数组**——数组当前不是按 id 排序的
  （53 条，`ids == sorted(ids)` 为 False），任何重排都会同时打到两套守卫，且 diff 大到无法归因。
- 改完**立刻提交并回读 committed 内容对数**（见上一节的窗口期陷阱）。
- 改完顺手知会 RFC-294 那条线去 repin；对方若把这个文件从 digest pin 里排除，这一步才可以省掉。
- 排查红项时注意区分**内容差异**与**顺序差异**：RFC-294 的 projection 报的 diff 可能只是同一条目
  出现在数组不同位置（`-` 与 `+` 两侧内容逐字相同、位置不同），那与你的数值改动无关。

## 一个文件里塞多个变异时，Playwright 的「did not run」会伪造出 NO-BITE

2026-08-26 实撞：往同一份 8 条用例的 spec 打三个变异，跑完只见「1 failed / 7 did not run」——
后两个变异看上去都没咬人。**实际是三个全咬**：第一条红把 worker 打掉之后，同文件剩下的用例
根本没执行（既有 gotcha「Playwright 在失败后丢弃 worker」的直接后果），于是它们的变异**连
被检验的机会都没有**。

**判据**：报告里出现 `did not run` 就说明这一轮的归因**不完整**，不能据此写 NO-BITE。

**处置**：把每个变异**单独**注入，并用 `-g '<能力 id>'` 只跑它的目标用例——一次一枚、各自成局。
慢一些，但归因是确定的。批量注入仍然适用于**变异分散在不同 spec 文件**的场景（跨文件不会互相
带倒），只有「同一文件多枚」这一种形态必须拆开。

顺带：`mode: 'serial'` 会让这个问题更严重（第一条红之后**整个 describe** 剩余全部 skip），
所以本仓的 RFC-319 spec 一律不加 serial —— 那条约定的另一半理由就在这里。

## `page.waitForRequest` 在**请求刚发出**时就 resolve——别拿它当「写入已完成」（2026-08-26 主干红）

```ts
const req = page.waitForRequest((r) => r.method() === 'POST' && …)
await saveButton.click()
await req                       // ← 这里只保证「请求出门了」
const rows = await api('/api/…') // ← 慢机器上这一读会跑在写入完成之前
expect(rows.find(…)).toBeDefined() // ← 于是断言成「没落库」，而库里几十毫秒后就有了
```

`waitForRequest` 等的是**请求发出**，不是响应回来。只要后面紧跟着「去服务端读一下确认
落库了」，这就是一枚在慢 runner 上必响的定时炸弹——`windows-latest` 分片实测红，**两次
重试都红**（所以它不会被 Playwright 的 retry 掩盖成 flaky，而是直接把主干推红）。

改法是等**响应**，请求体照样拿得到：

```ts
const res = page.waitForResponse((r) => r.request().method() === 'POST' && …)
await saveButton.click()
const done = await res
expect(done.ok(), `POST 以 ${done.status()} 收场：${await done.text()}`).toBe(true)
const body = done.request().postDataJSON()   // 请求体一样能读
```

顺带把「界面显示成功但请求其实失败了」提前一层暴露：不加 `res.ok()` 那条时，POST 被服务端
拒了也只会在后面报「没落库」，把人引向错误的方向。

**本机复现方法**（用来验证修法，而不是靠「重跑就过了」）：给那条请求人为加延迟，旧写法当场红、
新写法绿。

```ts
await page.route('**/employees', async (route) => {
  if (route.request().method() !== 'POST') return route.fallback()
  await new Promise((r) => setTimeout(r, 1500))
  await route.continue()
})
```

判断自己有没有踩：`waitForRequest` 本身没问题——**只有当它后面跨越了「写入完成」这条线**
（紧接着读服务端 / 读库）才是坑。只拿请求体做断言的用法不受影响。

## 同一条纪律对 `design/plan.md` / `STATE.md` 同样成立——文档也会把主干推红（2026-08-26 实撞）

上一节讲的是 `architecture/*.json` 账本。**共享的文档索引是同一个坑，而且更容易松懈**：
`design/plan.md` 的 RFC 索引表、`STATE.md` 的进行中/已完成清单，恰恰是最容易同时被两个
session 改的文件——每个新 RFC 都要往里加一行。

实撞：我提 `design/plan.md`（只想把 RFC-319 的状态改成 Done），按路径提交的工具读的是
**工作树内容**，于是把并发 session 尚未提交的 RFC-328 索引行一并推了上去。而
`design/RFC-328-*/` 目录还是他们的未追踪 WIP，索引里那条相对链接在主干上打不开，
`Markdown link check (design/)` 当场红——**一次纯文档提交把主干推红了**。

两条可操作的结论：

1. **改共享文档索引前先 `git diff HEAD -- <file>` 逐 hunk 认领**，与账本文件同等对待。
   「这只是文档」不是豁免理由：`design/**` 有 lychee 链接检查，`e2e/**.md` 有 prettier 检查，
   两者都会红成必修项（`docs/**` 反而不在 format 检查里，见 `package.json` 的 `format:check*`）。
2. **撤回时用「HEAD 内容 + 只去掉我误提的那行」做覆盖提交，工作树一个字节不动**。
   这样那一行会立刻以「未提交改动」的身份回到工作树，仍在原作者手上，跟着他们的目录
   一起提交即可，不必让人重写——比 `git revert` 整笔或直接删掉他们的行都干净。

连带一条通用规律：**RFC 索引行必须与 RFC 目录同批提交**。先登记后落档在单人工作流里
无害，在共享工作树上就是一颗随时会被别人顺手带走的雷。

## `git archive` 出来的沙箱**不是 git 仓**，`git checkout -- <file>` 在那里静默失败（2026-08-26 实撞，一整轮变异验证作废）

洁净沙箱的标准做法是 `git archive origin/main | tar -x -C $SBX`（见本文件「沙箱重新同步」一节）。
它给的是一棵**没有 `.git` 的普通目录树**。于是变异脚本里这一行：

```sh
perl -pi -e 's/…/…/' $SBX/packages/backend/src/…    # 注入
bun run build:binary:e2e && bunx playwright test …  # 跑
git checkout -- packages/backend/src/…              # ← 还原：fatal，但脚本继续往下走
```

`git checkout` 报 `fatal: not a git repository` 之后**脚本照跑**（除非 `set -e` 且没被管道吃掉），
第一条变异于是一路带进第二条的跑——两条变异叠在一起，第二条的红无法归因，整轮结论作废。

三条纪律：

1. 沙箱里还原用**从源仓重新取那一个文件**：`git -C $REPO show origin/main:$REL > $SBX/$REL`；
2. 还原之后**立刻核对**（`grep -q '<原文特征>' && echo ok || exit 1`），别信「命令跑过了」；
3. 注入之前也核对一次注入确实生效——注入失败 + 还原失败会合谋造出一个「全绿」的假结论。

同一条也适用于主工作树：那里 `git checkout` 能用，但**共享工作树上它会连别人的改动一起还原**，
所以自己备份、按字节还原（`cp` 到临时目录，跑完 `cp` 回来，再 `shasum` 对一遍）更安全。

## 给守卫加语料下限时，`readdirSync` 必须写在**断言所在的作用域**里（2026-08-26 实撞）

`census.ts` 的 `corpusFloor` 沿着**本作用域**把被断言的量追回枚举调用（`readdirSync` 一族）。
隔一层局部 helper 它就追不回来：

```ts
const baselines = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.png'))
test('…', () => {
  expect(baselines(DIR).length).toBeGreaterThanOrEqual(100) // ← corpusFloor 记成「没有下界」
})
```

于是 RFC-317 T13 报「扫语料却没声明语料下限」，而你明明写了。把枚举调用挪进同一个 test：

```ts
test('…', () => {
  const files = readdirSync(resolve(ROOT, DIR)).filter((f) => f.endsWith('.png'))
  expect(files.length).toBeGreaterThanOrEqual(100) // ← 这样才认
})
```

顺带两条同族规则：下界的阈值必须是**数字字面量**（变量不认，`toBeGreaterThan(N)` 记成 `N+1`）；
`guard-manifest.json` 的 `minCorpusFiles` 要填**同一个文件里最大的那个下界**。不确定就直接调
`sourceUnit` + `corpusFloor` / `isCorpusScanner` / `assertsAbsence` / `negativeFixtureAssertions`
问一遍它自己，比照着猜快得多。

## 往 `ledger-baselines.json` 加条目要插在 **RFC-294 N1 spec 段之前**（2026-08-26 实撞）

`rfc294Canonical.ts` 的 `projectGovernanceArtifacts` 会把所有 N1 spec 条目**重排到队尾**
（非 spec 条目保持原相对顺序），然后 N1b 断言「投影 === 磁盘」逐字节相等。所以顺手 `append`
到数组末尾会红在 N1b 上，而报错看起来像「你加的条目内容不对」，其实只是**位置**不对。

插到最后一条非 `rfc294-` 条目之后即可：

```python
rest = [l for l in ledgers if l['id'] not in mine]
anchor = max(i for i, l in enumerate(rest) if not l['id'].startswith('rfc294-'))
ledgers = rest[:anchor + 1] + mine + rest[anchor + 1:]
```

这条与本文件「`ledger-baselines.json` 同时被两套机制盯着」是同一族：改它之前先想清楚会踩到谁。

## WS 驱动的列表刷新一律用 `invalidateQueries`；`resetQueries` 会把用户正在看的那一屏清空（2026-08-26 用户实报）

用户报 `/tasks`：「每次任务状态更新都会刷新整个任务列表，导致任务列表一直在闪」。根因不是
渲染性能，是**刷新姿势**：`useTaskOperationsSync` 收到 WS 帧后只置脏（`refetchType:'none'`），
再由一个 15 秒定时器调 `queryClient.resetQueries` 整表重建（RFC-244 §5.3 的原设计）。

`resetQueries` 的语义是**把查询清回初始态**，不是「重新取一遍」：

- `data` 变 `undefined` ⇒ `isLoading` 翻 true ⇒ 页面里 `{isLoading && <LoadingState/>}` 那一支
  接管，整屏换成转圈；
- `{items.length > 0 ? <List/> : null}` 这类写法会把列表整个**卸载**，`VirtualList` 重挂后
  滚动位置回到顶部，展开着的子分支（同前缀 key 的子查询）也各自塌成 spinner；
- 对 `useInfiniteQuery` 还额外**丢掉已翻的页**，塌回第 1 页（RFC-311 的
  `audit-2026-08-18.md:165` 当时就记下了这一条，但没人把它当缺陷处理）。

`invalidateQueries`（默认 `refetchType: 'active'`）则保留 `data`：后台把已加载的各页重取一遍，
全部到齐后**原子替换**，React 按 key 复用行的 DOM 节点 ⇒ 状态 chip / 耗时就地变，滚动位置、
展开态、翻出来的页全留着。列表面的实时同步要的是后者；`resetQueries` 只适合「换了身份 / 换了
筛选维度，旧数据必须当场作废」的场景。

**测这件事的判据比结论更容易写错**：

- 组件测里如果 mock 的 `fetch` 立即 resolve，「清空 → 重填」会被合并进同一个 React 批次，
  中间那一帧空态**根本不会提交到 DOM**——把实现换回 `resetQueries`，用例照样全绿（2026-08-26
  实测，两条断言当场作废）。mock 必须能**挂住**请求（`hold()` / `release()`），在「请求已发出、
  响应还没回」的那一刻断言，才复现得出用户看到的那一下。
- 有效的判据有两条，都对着用户真正感知的东西：①用 `MutationObserver` 数整表 loading 有没有被
  插入过一次；②更新前给某个**与本次推送无关**的行元素挂一个标记属性，更新后看标记还在不在
  ——整表重建会换掉 DOM 节点，就地更新不会。两条在真浏览器 e2e 里同样成立（本次
  `rfc319-task-list-and-filters.spec.ts` TASK-21 即按此改写，变异实证咬中）。

## 扫文件系统的守卫在共享工作树上会「本地红、CI 绿」——别照着本地的红去改台账（2026-08-26 实撞）

`tests/rfc-index-status-drift.test.ts` 的「AC 证据索引缺口逐字相等」用 `readdirSync('design')`
枚举 RFC 目录，而不是问 git。于是它看见的是**这棵共享工作树里的全部目录**，包括并发 session
还没提交的 `design/RFC-328-…`、`design/RFC-316-…`。后果是两个方向都会骗人：

- **本地红、CI 绿**：别人的未提交 RFC 目录进了 `measured`，台账里当然没有它 ⇒ 本地 `toEqual` 红。
  照着这条红往台账加 `'RFC-328-…': 0`，CI 那边（干净 checkout 看不见这个目录）就会反向红成
  「台账里有、measured 里没有」——一次修出两条红。
- **本地绿、CI 红**：反过来，别人**刚提交**的新 RFC（如 RFC-329）需要在台账登记，而你本地
  可能还没 fetch 到，测试照样绿。

**判据**：动这类台账前，用 **git 跟踪面**重算一遍，而不是信本地目录列表：

```python
tracked = {x.split('/')[1] for x in git('ls-files','design').split() if x.startswith('design/')}
```

两边对不上的条目，先看它是不是别人的未提交产物——是的话本地那条红与你无关，别动台账。
同族的还有「凡是 `readdirSync` / `glob` 语料的守卫」：语料面越接近文件系统，越容易被共享
工作树污染；`git ls-files` 才是与 CI 同构的那一面。

## N1 账本（`rfc294-*`）涨了要**两笔**提交（2026-08-30 review §A3 起；此前是三笔）

`ledger-baselines.json` 里 `rfc294-*` 这几条是 canonical 投影（`n1LedgerSpecs`）逐字生成的；
`projectGovernanceArtifacts` 现在会把 current 文件里同 id 条目上的 `allowGrowth` 原样带进投影，所以
涨账那笔可以同时让 N1b「subset ledgers project into canonical truth」与 RFC-317 T17「只降不升」都绿：

1. **内容笔**：代码 + `bun run architecture:write --snapshot-sha HEAD` 再生成的全部 artifact + 涨账条目上的
   `allowGrowth`（N1 条目也可以直接写在 `ledger-baselines.json` 上，生成器保留它）；
2. **退许可笔**：把 `allowGrowth` 删掉再 `architecture:write --snapshot-sha HEAD` 一次——T17 要求「本 commit 未涨
   就必须删」，所以它必须是**紧接着**的下一笔（两笔一次 `git push`，CI 只评估推送顶端）。

不涨的刷新只要**一笔**：N1a 已不再要求 `git show <currentSnapshotSha>:<path>` 与当前文件 byte-equal（四份治理账本各自
已被更强的判据钉在源码上：commons R1/R2 exact equality、guard-manifest 两向钉死、ledger-baselines「与源码逐字相等」+ T17），
`currentSnapshotSha` 只须是 HEAD 历史上可达的已提交祖先，`contentDigest` 与当前 payload 相等即可。RFC-328 时代的
`b0aa3fadb → cc29ecc6d（normalize）→ 8fa602a5f（pin）` 三笔形状不再需要。

历史记录（2026-08-27，RFC-330 实撞）：当时 N1 条目不接受手写 `allowGrowth`，两个守卫在同一笔里不可能同时绿，只能靠
「内容 / 归一 / repin」三笔并一次 push 消化；这个形状自 2026-08-13 起让 142/1313 个 commit 变成 `chore(architecture)`
refresh/pin，是 review §A3 改协议的直接理由。

## 只有 `owner_user_id` 的表不是权限（RFC-330，2026-08-26）

`employee_tool_registrations` / `employee_job_templates` 自 RFC-310 起带着 `owner_user_id`，看起来
像「有归属」，但它们不在 `ACL_RESOURCE_TYPES` / `ACL_TABLES` 里、也没有 `visibility` 列——kernel
的任何判据都作用不到，那一列只是记录。持有 `digital-employees:update` 的任何账户都能改 / 发布 /
退休别人的工具与模版，还逃过了 `rfc317-acl-column-enrolment-guard`（守卫只对 owner + visibility
**双列**发作）。判「有没有权限控制」的唯一依据是**类型是否在 `ACL_RESOURCE_TYPES` 里且路由接了
`requireResource*` / `filterVisibleRows`**，不是表里有没有 owner 列。

接一类新 ACL 资源要同步的登记点（RFC-330 逐条实撞）：shared `ACL_RESOURCE_TYPES`、schema
`resource_grants.resource_type` 枚举、`ACL_TABLES`、`OWNER_NAME_UNIQUE_PARTITIONS`（有 owner×name
唯一索引的才登记；分区列写在描述符里）、`routes/resourceAcl.ts` 的 `ACL_PERMISSION_PREFIX`、
`rfc099-acl-endpoints-matrix` CASES、`api-contract-coverage` 的精确 `/acl` 清单、`contracts/registry.ts`、
`rfc329McpSurfaceLedger.ts` 叶子（GET `not-in-scope` / PUT `never`）+ `ledger-baselines.json` 的
`allowGrowth`。路由上的成员 / 协作面**别挂类型专属权限点**（`development-missions:*`）——
`rfc317-permission-domain-ownership` 的泄漏账本只减不增，用 `tasks:update` 这类通用点。

## RFC 文档里的 `file:line` 锚点按已提交 blob 取（RFC-330 设计门实撞）

共享工作树里躺着别人的未提交改动时，`sed -n` 读磁盘得到的行号会随他们的在制品漂移
（RFC-330 落档时 `db/schema.ts` / `services/task.ts` 就被 RFC-328 的在制品挪了几十行，
设计门当场判「锚点对不上」）。写进 `design/**/*.md` 的锚点一律 `git show <sha>:<path> | nl -ba |
sed -n 'a,bp'` 取，并在文档头写明基线 sha；复核也用同一条命令。
