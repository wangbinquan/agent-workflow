# 开发踩坑与经验（多人协作）

> 跨 RFC 反复踩到的**通用**陷阱与规律，从历次交付中沉淀。RFC-**专属**的实现细节看各 `design/RFC-XXX/design.md`；本文件只收对**任何**贡献者都有用的可复用经验。CLAUDE.md 是强制规则，本文件是「见到 X 多半是 Y」的实战 tips。

## 测试 / CI

- **`bun test` 把模块加载期 ENOENT 计「error」不计「fail」**：本地全量出现「N errors」必须**逐个查**——常见根因是源码锁（source-lock 测试）读了已删/搬走的文件。别当噪音略过，CI 会红。
- **`vi.mock('@/components/...')` 路径跟组件搬家**：移动/重命名组件后必 grep 全仓 `vi.mock('@/components/<旧路径>`，否则测试静默失配。
- **cwd 敏感测试**：用相对路径 `readFileSync` 的 source-lock 在 `cwd=packages/backend` 跑会恒红、在仓根 cwd 恒绿（CI 在仓根）。写 source-lock 用 `import.meta`/绝对根，别用相对 cwd。
- **前端测试跑 `vitest` 不是 `bun test`**：根 `bun test` 只跑 backend（bunfig `root=packages/backend/tests`）。改前端/clarify 必须 `bun run --filter @agent-workflow/frontend test` + 相关 Playwright e2e——否则漏检（RFC-132 两层回归漏检事故）。
- **CI path filter 完备性 = 依赖闭包问题**，不是加几个 glob。且**触发 ≠ 真测**：若 live 套件自拼 argv 直接 spawn、绕过生产链（如 `buildBusinessSpawn`），即便触发也测不到 drift、全绿无意义。改 path filter 要沿依赖闭包核算，并确保有一条走生产链的 case。
- **`BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`**：跑「验证子进程零写入」的只读测试要关 Bun 自身转译缓存，否则误报写入。
- **结构守卫必做变异实证**：加 grep/AST 守卫后，改坏源码断言必须看它变红；否则守卫是空的。表级锁（一次锁一类）优于文件级——注释里的字面量也会踩表级锁（RFC-072 事故）。
- **改符号前先 grep 测试源码锁**：改函数/常量名前全量盘「锁住旧接线的测试」，定向重跑集 = grep 命中集；否则本地绿、CI 红（他人 source-lock 锁了旧名，2026-07-08 三连事故）。
- **`e2e/` 在 workspace typecheck 之外**：删/改 wire 字段能过所有本地门却红 Playwright CI；推前 grep `e2e/` 找该字段（inline response 类型 + 断言都要改）。
- **CI 根 `bun test` 只跑 backend**（bunfig `root=packages/backend/tests`）；shared 测试单独跑且含一个**已知陈旧** `memory-schema` 红（RFC-101 `fused`，在 CI 之外）——忽略它，别「修」他人代码。
- **本机 `protocol.file.allow=always` 掩盖 submodule CI 红**：`file://` submodule 测试本机恒绿、CI 恒红；测试须自注入 `GIT_CONFIG_GLOBAL`，复现用 `GIT_CONFIG_GLOBAL=/dev/null bun test <单文件>`。
- **源码里裸 `0x00` 让 grep/rg 静默跳过整文件**（却过 tsc/prettier/eslint/build/tests）；`file` / `tr -cd '\000'` 检测，改回 `\x00`；守卫 `no-nul-bytes-in-source`（注释里的字面量也会踩）。

## git / 多人协作（共享工作树）

- **全部工作直接在 `main`**，不开分支/PR；push main 即触发 CI。
- **提交只用一步 `git commit -- <精确路径>`**，别 `git add` 后再 commit——并发 session 的 commit 会把你 staged 的卷进它（2026-06-24 事故）。untracked 新文件须先 `git add <精确路径>`，用**显式正向清单**（污染大时别 `git add packages/`）。
- **绝不 `git commit --amend`**：HEAD 可能已是并发 session 的 commit，amend 会重写他们的（defd9958 覆 94436c9f）。后续=新 pathspec commit；恢复=reflog + `reset --soft`（非 `--hard`）。
- **绝不删他人的行/文件/未追踪文件**即便在破 CI；停下先问。`git checkout --` 回滚只对 tracked 有效，且会连带丢本 session 对该 tracked 文件的未提交改动。
- **pathspec commit 后自验**：`git show HEAD:<file> | grep <新符号>`——共享树竞态会让 i18n 值块/新键在提交时丢失，形成「本地绿 CI 红裸 key」。
- **共享树迁移号冲突**：并发 session 各加 `migrations/`，号会撞。`_journal.json` 必须接在**已提交**的最后一条之后连续。他人的迁移未提交时，你排不了下一号——等他提交，或另立时把自己的暂存进 `design/RFC-XXX/deferred-*/`（RFC-223 与 RFC-225 撞 0114 的处理）。
- **双引号 `git commit -m` / `gh --body` 里的 backtick / `$()` / `&&` 会命令替换**并静默改坏消息；用单引号 heredoc + `-F`。
- **协作者 commit gate 会 `git stash -u`**：未提交工作中途「消失」时 `git stash apply`（含 untracked）恢复。
- **混合文件提交前查交叉依赖**：`git commit -- <混了他人 hunk 的文件>` 前，确认并发 hunk 不引用**其他未提交文件**的符号、且无 HEAD 测试锁了旧接线；写完测试后重跑 `typecheck`（`bun test` 跳 tsc，RFC-161 事故）。
- **子代理完成通知非终态**：子代理可能继续推翻出 v2；`git add` 它的文件前必查 untracked import，否则提交半截（`87ac52d3` 事故）。
- **`design/` 与 `STATE.md` 在 prettier 作用域外**：在那跑 `prettier --write` 会 reflow 他人表格行、坏 markdown 转义（`next_run_at`→`next*run_at`）；**只手改**。

## 迁移（Drizzle + bun:sqlite）

- **`when` 接合成轴**（上条 +86400000），别用真实 `Date.now()`——否则 drizzle 对既有安装静默跳过，之后每查 `no such column`，从零建库看不见。
- **手写多语句要 `--> statement-breakpoint`**（精确这个字面量，仓库迁移器只认它），否则只应用第一条。
- **加迁移必 bump `upgrade-rolling.test.ts` 的 journal-count 锁**（N→N+1）；1 个本地 bun-test 红别当 flaky，先定位 `(fail)`。
- **已应用的迁移被追改，drizzle 永不重放** → daemon 健康但起任务 500 `no-such-column`；要补 ALTER 用**新迁移**别追改旧的、别删记账行。
- **加任何 `tasks` 列会破「冻结旧迁移」的测试**（drizzle INSERT emit 所有 HEAD 列 → `no column named …`）；fixture 用显式列 raw SQL 修。
- **推 `migrations/`/`_journal.json` 前跑完整 backend `bun test`**（不只迁移子集）——journal↔files 失配（含并发 orphan 条目）级联数千 DB 测试红而子集绿。
- **表达式唯一索引**（如 `COALESCE(owner,'')`,name）用 `PRAGMA index_list`/`index_xinfo`/`sqlite_master` 验证，**不能**用 `table_info`。
- **`file:…?immutable=1` 在 Linux 抛**（macOS 可）；checkpoint+close 后 `-wal/-shm` 仍在，plain `{readonly:true}` 足够。

## opencode / runtime

- **opencode 行为以本地源码为准、不靠记忆**：进程启动/CLI 参数/`OPENCODE_*`/退出码/agent·skill 加载顺序/输出 XML——遇到就 grep/read 本地 opencode（路径在贡献者本地）。
- **inline `OPENCODE_CONFIG_CONTENT` 并非最高优先级**（本机 v1.18.4 实证）：其后仍合并 active-org/managed/MDM/`mode`/`OPENCODE_PERMISSION` 覆盖同名 agent；`disable`/`mode:subagent` 还能让 `--agent` 回退默认。CLAUDE.md「Resolved open questions」的旧断言错误，执行身份完整性见 **RFC-224**。
- **opencode 严格 yargs 拒 `-` 开头裸位置参** → prompt 必须放 `--` 之后（`buildCommand`）。
- **1.18 移除 `--dangerously-skip-permissions` 改 `--auto`**：按探测版本选拼写（`resolveAutoApproveFlag`）；失败形态=stderr 纯 usage + exit1；垃圾版本串须 `extractVersion` 归一化。
- **改 opencode argv 契约要同步两类桩**：TS fixtures **和** 6 个 `e2e/fixtures/*.sh` shell 桩（golden 只覆 TS）。跨 spec `code 3`/<1s/首 agent-node 红 = 桩契约失配。
- **有界-spawn 定式**：`killProcessTree`（`process.kill(-pid)` 组杀）+ `detached:true` + 超时 SIGKILL + **finally 无条件组杀**（收 fork-then-exit 孙进程）+ 流式 capped reader（防 stderr 洪泛 OOM）。现 4+ 处（opencode/models/git/sandbox）= dedup 候选。

## 构建 / 后端 wire

- **单二进制 smoke（`bun run build:binary`）会抓 typecheck/`bun:test` 抓不到的模块初始化循环**；推 shared-export 改动前先跑（RFC-079 事故）。
- **`buildLaunchBody`/`buildLaunchBodyMultiRepo` 白名单 `POST /api/tasks` 字段并丢弃 extras**：加进 `launchCommon` ≠ 上线——必须在 helper 里 stamp（共享 `stampLaunchExtras`）；launch 测试只断言 source-spread（根因），别被绿测试骗过。

## Codex review（本仓工作流的一部分）

> 强制门时机与坑；companion 的**本机调用路径**属个人配置，不在此。

- **两个门**：写完 RFC 请批前（**设计门**）+ 改完代码 declare done 前（**实现门**），每次修 findings。这是 CI 之外的额外门（RFC-101 抓过 7 个真问题）。
- **共享树上从分离 worktree 跑**：并发 session 的 diff 会**吞掉**你的 review（你的代码出 0 findings）；从 pin 到你 commit 的分离 worktree 跑，并 grep job log 证明这不是空洞通过。
- **rescue job 会僵尸**（status=running 但 result=no-job-found、rollout mtime 冻结、0% CPU）；从 `~/.codex/sessions` 的 rollout jsonl 里抢救 pre-stall finding 独立复核；分离 job 无自动通知，须 bg 轮询 status。

## impl-gate（Codex 实现门）经验规律

历次 impl-gate 沉淀出的「finding 类型 → 风险」规律，接手评审/修复时按此预期：

- **生产逻辑 / 平台 / 基础设施类 finding 几乎都是子系统级**，且**易引入比原 bug 更严重的 regression、常需 revert + defer 到专门 RFC**。典型：
  - **固定字节阈值几乎总错**——page size、平台 ARG_MAX（macOS ~1MiB 非 256KiB、Linux `MAX_ARG_STRLEN=32×页大小`）都是**运行时量**（E2BIG spawn guard 四轮后 revert，defer 到平台感知 RFC）。
  - **任何 spawn 前新增的同步/阻塞探测都可能升级成 daemon 级死锁**（node_run 已占 semaphore、abort 要 spawn 后才注册、并发首 spawn 缺 single-flight）→ 必须 **bounded + cancelable + single-flight**（opencode 版本探测 revert 事故）。
- **测试 / 回归防线 / 重构类 finding 多能一~多轮干净闭环**（RFC-210 G7、e2e 桩契约、单源 dedup）。
- **守卫强化类介于两者**：**实质加固能落地**，但「完整正确」常是子系统——**源码文本守卫的防漂移正则 ratchet 是无底洞**（receiver 语法/空白/注释变体穷不尽），完整闭合 defer 到「守卫 AST 化」RFC，但精确 occurrence 锁 + 表驱动变体锁的实质加固可保留。
- **「测试加固」类 finding 可能实为生产竞态子系统**：给 fire-and-forget 链加 settle seam 时，Codex 常揭示这不是补测试、而是暴露原设计的 [high] 并发 bug（RFC-212 WS 授权握手期不重跑 gate + 无 pass generation → 被移除成员仍收 stdout）；「不能仅延期测试」。

## 前端

- **CSS 改动别肉眼跳过**：最小 repro HTML + `python3 -m http.server`（chrome MCP 拒 `file://`）+ chrome 截图 light&dark 验像素再推。
- **视觉基线刷新前先 `build:binary`**（旧 dist 刷出「通过但错误」的图）；`-g` 只刷单 scene；linux 基线取 CI artifact 不本地生成；`--update-snapshots` 对已存在 png 静默 no-op，必变 scene 先 `rm`。settings.png 只截默认(runtime) tab——子 tab 内改动无需刷基线。
- **LAN http = 非安全上下文**：`crypto.subtle`/`navigator.clipboard`/`randomUUID` 皆 `undefined`；「保存卡死/复制无效」先敲 `window.isSecureContext`（防线 `lib/sha256.ts`+`lib/clipboard.ts`+守卫）。
- **改 `tasks.status.*` 文案的两把暗锁**：zh 域禁「等待人工」子串（`node-run-duration-no-manual-marker` 守卫按 `JSON.stringify(tasks)` 子串扫）；en `awaiting_human` 被 `e2e/task-lifecycle-states.spec.ts` 锁死 `'Awaiting input'`。
- **`.tabs--segment` 换行兜底只在 `.auth-page` 域**；RFC-219 picker 分类条须横向滚动+箭头（全局化曾双层红）。

## dev-env / daemon

- **`bun dev` 中编辑 `packages/backend/src/**` 触发 `--watch` 重启**，race 30s graceful-shutdown flock → daemon 常 **DOWN**（浏览器空白 + 503 + 误导「token 无权限」横幅），非崩溃；重启复活。纯前端编辑不掉。
- **claude-code 运行时直连 Anthropic**：daemon 从普通 shell 起若缺 `HTTP(S)_PROXY` → 403 被 smoke 误报「缺鉴权」；报缺鉴权先查 daemon 代理再查凭据。
- **claude code 在 uid 0 下 bypassPermissions 会 exit(1)** 除非 env `IS_SANDBOX==="1"`（精确字符串）；root 跑 daemon 时每次 claude-code-protocol 启动都需（`buildClaudeSpawn` 已 gate）。
- **分离 worktree 里 symlink `node_modules`** 会把 `@agent-workflow/*` 解析回污染的 main → 假 typecheck 错；worktree 里 `bun install` 或信 CI。
- **CI 按你自己的确切 sha 查**：共享 main 上并发 push 会 cancel 你的 CI run；看含你 commit 的 superseding commit 的绿，按失败测试的 owning commit 归属。Codex `--base` 跨并发 commit 会把他人 diff 卷进复审——pin 到你的父提交（分离 worktree）隔离。
- **已知 flaky（别当真红）**：`centralized-answer-pane.test.tsx` cross-round digit-key `checked` race（macOS 尤甚，ubuntu 同 shard 绿即判 flaky，`gh run rerun --failed`）；`skills-split-page` escaped-mocks；根 `bun run test` 的 git-network flaky（已 gate 在 `RUN_GIT_NETWORK`）。
