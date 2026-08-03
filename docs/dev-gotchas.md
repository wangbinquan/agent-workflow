# 开发踩坑与经验（多人协作）

> 跨 RFC 反复踩到的**通用**陷阱与规律，从历次交付中沉淀。RFC-**专属**的实现细节看各 `design/RFC-XXX/design.md`；本文件只收对**任何**贡献者都有用的可复用经验。CLAUDE.md 是强制规则，本文件是「见到 X 多半是 Y」的实战 tips。

## 测试 / CI

- **`bun test` 把模块加载期 ENOENT 计「error」不计「fail」**：本地全量出现「N errors」必须**逐个查**——常见根因是源码锁（source-lock 测试）读了已删/搬走的文件。别当噪音略过，CI 会红。
- **`vi.mock('@/components/...')` 路径跟组件搬家**：移动/重命名组件后必 grep 全仓 `vi.mock('@/components/<旧路径>`，否则测试静默失配。
- **cwd 敏感测试**：用相对路径 `readFileSync` 的 source-lock 在 `cwd=packages/backend` 跑会恒红、在仓根 cwd 恒绿（CI 在仓根）。写 source-lock 用 `import.meta`/绝对根，别用相对 cwd。
- **前端测试跑 `vitest` 不是 `bun test`**：根 `bun test` 只跑 backend（bunfig `root=packages/backend/tests`）。改前端/clarify 必须 `bun run --filter @agent-workflow/frontend test` + 相关 Playwright e2e——否则漏检（RFC-132 两层回归漏检事故）。
- **CI path filter 完备性 = 依赖闭包问题**，不是加几个 glob。且**触发 ≠ 真测**：若 live 套件自拼 argv 直接 spawn、绕过生产链（如 `buildBusinessSpawn`），即便触发也测不到 drift、全绿无意义。改 path filter 要沿依赖闭包核算，并确保有一条走生产链的 case。
- **`BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`**：跑「验证子进程零写入」的只读测试要关 Bun 自身转译缓存，否则误报写入。
- **`bun audit` 的 flag 是显示层过滤器，不是门禁**（bun 1.3.13）：`--audit-level` / `--ignore` 按 `--help` 原文只影响**打印**；退出码只反映「bun 有没有成功解析出公告」。更糟的是 registry 回 gzip 时 **bun 自己解不开**——把压缩响应体原样倒进 stdout（日志里那堆乱码就是它）、stderr 写 `audit request failed to parse json`、exit 1，而且那段 gzip **尾部截断**（严格 `gunzipSync` 报 `unexpected end of file`，得用 `Z_SYNC_FLUSH` 兜）。后果：CI 的 audit gate 时红时绿取决于 CDN 给不给 gzip，加多少 `--ignore` 都修不好，绿的时候也没在把关。修法是自己解压 + 自己判定（`scripts/audit-gate.ts`），**别再往那条命令上加 flag**。
- **静态分析工具拿错 tsconfig 会「静默失明」而不是报错——绿灯不等于干净**：dependency-cruiser 的 `options.tsConfig.fileName` 原本指向 `tsconfig.base.json`，而 base 里 `paths` 出现 **0 次**（`@/*` 只定义在各 package 自己的 tsconfig）。于是每条 `@/...` import 都 `couldNotResolve` 被**从图里丢掉**，`bun run depcheck` 两年报 0 违规——实测后端 **3365 / 5384 = 62.5%** 的依赖边门禁根本没看见，换对 tsconfig 后立刻暴露 19 条真实违规（18 个 runtime 环 + 1 条 services→routes）。最毒的是绕环最常用的写法 `await import('@/services/…')` 100% 落在这个盲区里，于是「工具 + 约定双保险」实际退化成纯人肉约定。**通用判据：任何吃 tsconfig 的分析器（depcruise / madge / knip / ts-morph 脚本），上线时必须断言"未解析的第一方边 = 0"，并把这条断言做成棘轮**——只统计违规数不统计「我看见了多少」，等于让工具用沉默替你签字。顺带三个实测坑：①`enhancedResolveOptions.alias` 不被 depcruise 的 schema 接受（`must NOT have additional properties`），②它解析 tsconfig 的 `extends` 基准目录不对（传 `packages/backend/tsconfig.json` 会去找 `packages/backend/tsconfig.base.json` 报 TS5083），③临时 tsconfig 放到包目录外必须写**绝对** `include`，否则 tsc 报 TS18003。正解见 `scripts/depcheck.ts`（每 package 各跑一次 + 生成扁平化绝对 baseUrl 的 tsconfig + 配置侧 fail-closed）。2026-08-03 架构审视 A1 / WP-0。
- **允许列表按「文件」排除 vs 按「违规」排除**：上面那条顺带修掉的老写法是 `from.pathNot: ['^…/services/(agent|agentDeps)\\.ts$']`——排除的是**文件**，等于连带放过未来经过该文件的**每一个新环**，而新环恰恰最爱从 `scheduler.ts` / `task.ts` 这种枢纽长出来。换成按 `(规则, 起点, 终点)` 三元组精确匹配后，允许列表还能加一条真棘轮：**条目不再触发就让门禁红**（环拆掉了却留着条目 = 重新开口子）。同一形态适用于任何「已知问题清单」型门禁（`scripts/audit-gate.ts` 的 `IGNORED_ADVISORIES` 已有 `staleIgnores`，可对照）。
- **外链检查红了先分清「链接坏了」还是「网络断了」**：lychee 的 `--accept 200,206,403,429` 只能吸收**有 HTTP 状态码**的噪音；`Network error: Connection reset by peer (os error 104)` 压根没有状态码，任何 `--accept` 都盖不住它。判据是本地 `curl -s -o /dev/null -w '%{http_code}'` 连打三次——全 200 就是 CI 侧瞬时网络，属环境。**处置不是重跑**（CLAUDE.md 禁止「重跑就过」当依据），而是给检查器加 `--max-retries` / `--retry-wait-time` / `--timeout`。2026-08-02 `w3c.github.io` 就这样弄红过一个只改了两个 i18n 文件的 main run。
- **用错 runner 的表现是「挂死」不是报错**：`cd packages/frontend && bun test`（上一条说的那个错法）不会干脆失败，而是刷 `ReferenceError: document is not defined` 后长时间不退——正确的 `bun run --filter @agent-workflow/frontend test` 全量只要 ~60s。**跑套件卡住先怀疑 runner 用错，别当 flaky**（RFC-230 session 因此空等 2h37m）。
- **`长任务 | tail -N` 会让你全程失明**：tail 要等 EOF 才吐字节，后台跑的全量测试在结束前输出文件恒为 0 字节，「没输出」看起来和「还在跑」一模一样。长任务全量落盘再取尾（`> log 2>&1` 后 `tail`）。判断进程死活看 **`ps -o etime=`**，不看输出有没有内容。
- **结构守卫必做变异实证**：加 grep/AST 守卫后，改坏源码断言必须看它变红；否则守卫是空的。表级锁（一次锁一类）优于文件级——注释里的字面量也会踩表级锁（RFC-072 事故）。
- **「写了规则 + 单测绿」≠「接上了」**：脱敏/校验这类横切规则，单测测的是**函数**，接线是另一件事。RFC-247 里 `redactMcpRecord` 与 `redactStdout` **各自**都是「定义了、单测了、零调用方」——`GET /api/mcps/:id` 一直原样吐 `config.env`/`oauth.clientSecret`。单测不会红，因为它没在测出口。**收尾必须从 AC/需求反查「谁调它」**（`grep -rn '<fn>' src | grep -v '<定义文件>'`，命中为空即未接线），或把出口写成唯一入口（`serializeXForActor(record, source)`）让调用方无从绕过。
- **上一条的镜像：迁移「只删调用方、不删实现」，残骸会被它自己的测试续命**。RFC-247 T4 把权限门迁到 `registerRoute` 后删的是 `server.ts` 里的**挂载**，`auth/permissions.ts` 那 202 行实现原封留下；此后全仓零生产引用，唯一 import 是 `rfc247-verb-for-route.test.ts` 那条逐行测试——覆盖率报表上它一直是绿的、看起来还像一条权限不变量锁。代价是它**在教育后来人**：文件头断言「server.ts 的手挂网关 still runs alongside 迁移后的路由」（同一时刻 server.ts 明写 GONE），而 `verbForRoute` 悄悄成了「路由 → 权限点」的第二份、无人执行、无人比对的事实源（与真实声明分歧 7 条）。**判据**：迁移收尾时对被替换的模块跑 `rg -n "<导出名>" packages e2e scripts | grep -v "<自身文件>"`，若命中**只剩测试文件**，那不是「还有人用」，是死码 + 假合格证，删。删完补一条「不复辟」ratchet（`tests/route-gate-single-source.test.ts` 是范本）并做变异实证。2026-08-03 架构审视 G0。
- **改符号前先 grep 测试源码锁**：改函数/常量名前全量盘「锁住旧接线的测试」，定向重跑集 = grep 命中集；否则本地绿、CI 红（他人 source-lock 锁了旧名，2026-07-08 三连事故）。
- **`e2e/` 在 workspace typecheck 之外**：删/改 wire 字段能过所有本地门却红 Playwright CI；推前 grep `e2e/` 找该字段（inline response 类型 + 断言都要改）。
- **CI 根 `bun test` 只跑 backend**（bunfig `root=packages/backend/tests`）；shared 测试单独跑且含一个**已知陈旧** `memory-schema` 红（RFC-101 `fused`，在 CI 之外）——忽略它，别「修」他人代码。
- **本机 `protocol.file.allow=always` 掩盖 submodule CI 红**：`file://` submodule 测试本机恒绿、CI 恒红；测试须自注入 `GIT_CONFIG_GLOBAL`，复现用 `GIT_CONFIG_GLOBAL=/dev/null bun test <单文件>`。
- **`sqlite3` CLI 默认 `busy_timeout=0`，直写运行中 daemon 的 DB 必炸**：e2e 用 `sqlite3` 往活着的 daemon 的 `db.sqlite` 里种状态（`e2e/command.ts:runSqlite`，diagnose-repair / lifecycle-diagnose / rfc229 / business-workgroup 都在用）。daemon 侧有 `PRAGMA busy_timeout = 5000`（`db/client.ts`）会等写锁，**CLI 侧不等**——只要 daemon 那一刻在写，fixture 立刻 `Error: stepping, database is locked (5)`，表现为「随机某个 shard 红、重试还红」（nightly e2e-webkit run 30440683412：`diagnose-repair` 的 `afterEach` 清理撞上刚点下去的 repair 写）。**测试进程直连生产 DB 文件一律显式设 busy_timeout**，且要小于命令自身的超时，否则 wedge 时拿到的是 SIGTERM 而不是 SQLite 诊断。注意 WAL 不救这一类：WAL 只解耦读写，写-写仍然互斥。
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
- **`design/` 与 `STATE.md` 在 prettier 作用域外**：在那跑 `prettier --write` 会 reflow 他人表格行、坏 markdown 转义（`next_run_at`→`next*run_at`）、剥掉 blockquote 续行的 `> `；**只手改**。实测代价：一次顺手格式化把 `design/plan.md` 整张 RFC 索引表重排成 ~500 行 diff（全是别人 RFC 的行）（RFC-247 复犯）。改完 `git diff --stat` 对一眼行数是否与改动量相称。

## 迁移（Drizzle + bun:sqlite）

- **`when` 接合成轴**（上条 +86400000），别用真实 `Date.now()`——否则 drizzle 对既有安装静默跳过，之后每查 `no such column`，从零建库看不见。
- **手写多语句要 `--> statement-breakpoint`**（精确这个字面量，仓库迁移器只认它），否则只应用第一条。
- **加迁移必 bump `upgrade-rolling.test.ts` 的 journal-count 锁**（N→N+1）；1 个本地 bun-test 红别当 flaky，先定位 `(fail)`。
- **已应用的迁移被追改，drizzle 永不重放** → daemon 健康但起任务 500 `no-such-column`；要补 ALTER 用**新迁移**别追改旧的、别删记账行。
- **加任何 `tasks` 列会破「冻结旧迁移」的测试**（drizzle INSERT emit 所有 HEAD 列 → `no column named …`）；fixture 用显式列 raw SQL 修。
- **推 `migrations/`/`_journal.json` 前跑完整 backend `bun test`**（不只迁移子集）——journal↔files 失配（含并发 orphan 条目）级联数千 DB 测试红而子集绿。
- **表达式唯一索引**（如 `COALESCE(owner,'')`,name）用 `PRAGMA index_list`/`index_xinfo`/`sqlite_master` 验证，**不能**用 `table_info`。
- **`file:…?immutable=1` 在 Linux 抛**（macOS 可）；checkpoint+close 后 `-wal/-shm` 仍在，plain `{readonly:true}` 足够。
- **跨平台的沙箱缺陷可以在本平台被确定性证伪/证实——只要 policy 是纯函数**（RFC-251 实证）：`services/sandbox/policy.ts` 的 `computeSandboxPolicy` / `renderBwrapArgs` 明确是 pure（no fs access），所以「Linux 上会生成什么 bwrap argv」在 macOS 上就能算出来。把 argv 按顺序还原成挂载表（`--tmpfs DEST` / `--bind SRC DEST` / `--ro-bind SRC DEST`，**最深的挂载点决定可见性**），就能对任意路径回答「在命名空间里看不看得见」。定式：**永远同时断言一个「应该可见」的对照路径**（如 `appHome/repos`），否则「全都不可见」的建模 bug 会伪装成真实缺陷。别因为「手上没有 Linux」就把这类问题降级成推断。
- **从闭集枚举里删一个值 ≠ 可以删——存量行还在，而严格 schema 会炸整页**（RFC-251 Codex 实现门 P1）：像 `failure_code` 这种「无迁移的普通 TEXT + 应用层 `z.enum`」列，删掉一个码之后，升级前写入该码的**任一**历史行都会让读取端 `.parse()` 失败；如果读取端是**整页/整列表**一次 parse（本仓 `useTaskOperationsPage.ts` 就是），后果是**整页打不开**，而不是那一行降级显示。定式：把**发射域**与**读取域**拆开——可产生的闭集里删掉，另立一个 `LEGACY_*` 只读常量并入解析用的 union，配套保留 i18n 文案（改成「历史失败」语气），并加一条「退役码不可产生但仍可解析」的回归锁。凡是「删枚举值」的改动都要先问：这个值有没有可能已经躺在用户的 DB 里？

## opencode / runtime

- **opencode 行为以本地源码为准、不靠记忆**：进程启动/CLI 参数/`OPENCODE_*`/退出码/agent·skill 加载顺序/输出 XML——遇到就 grep/read 本地 opencode（路径在贡献者本地）。
- **RFC / design 里对 opencode 行为的既有断言，接手时必须对当前源码复核一遍**（RFC-251 事故）：RFC-224 用三条 opencode 行为论断关掉了两个已完工功能（RFC-022 `dependsOn`、RFC-031 plugins）。半个月后按 v1.18.4 源码逐条核，**两条与源码不符、一条系误读**——①V2 插件路径遵守 `OPENCODE_PURE`（`plugin/index.ts:177`），②未知 subagent 直接 fail 而非静默回退默认 agent（`tool/task.ts:131-134`），③`bypassAgentCheck` 跳过的是**权限询问**而非身份校验（`:119-129`）。教训有三层：**(a)** 写进 design 的 opencode 断言会被后续 session 当既成事实继承，必须带 `file:line`，且接手时重新验证（上游会变，你的理解也可能一开始就错）；**(b)** 因外部行为而**关掉产品功能**的决定，判据必须是可复跑的源码引用，不能是"读下来觉得不安全"；**(c)** 那两条拒绝在后端**从来没有测试覆盖**（只有 shared 码表枚举），删掉它们时全套 backend 测试依然全绿——**禁用型分支和正向功能一样需要测试**，否则它是活是死都没人知道。
- **`OPENCODE_PURE=1` 会静默清空用户选中的插件**：`plugin/index.ts:177` 是 `flags.pure ? [] : (cfg.plugin_origins ?? [])`——发了 `config.plugin` 却仍带 PURE，结果是**没有报错、没有日志**，opencode 就是不加载。它与 `OPENCODE_DISABLE_DEFAULT_PLUGINS`（`:166`，只关内置 `internalPlugins`）是两个独立轴，别混。定式：这类"两个开关必须一致否则静默失效"的地方，让其中一个**从另一个派生**而不是分别传参（`buildHermeticServerEnv` 从受控 config 的 `plugin` 键推 PURE），再补一条显式断言。
- **拼 permission 记录时，平台强制规则必须「追加在末尾」，不能「就地覆盖」**（RFC-251 Codex 实现门 P1）：OpenCode 把 permission 对象按**键序**生成规则、再用 `findLast` 取最后匹配项（`permission/index.ts:28-34`）。而 JS 里**给已存在的键重新赋值不会移动它**——所以 `{...userPermission}` 之后再 `permission.task = 'deny'`，那条 deny 仍留在用户原来的位置；用户只要在后面写一个 `"*": "allow"`，`findLast` 就选中通配符，平台的 deny **形同虚设**。定式：先**丢弃**用户对平台管控键的覆盖（一张显式 key 集合），再把平台值 append 到末尾；用户其它键原样保留在前。判据测试要断言「受控键的下标 > 用户 `*` 的下标」，光比对最终值看不出这个 bug。
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
- **系统代理（非任务链）的 spawn 也必须走「烙印命令」seam**：e2e 二进制里 `markProductionOpencodeCommand` 编译为 no-op，业务路径靠「命令数组未 brand → legacy 测试 spawn」通过 shell 桩；系统路径若只拿 `runtimeBinary: string` 会在 e2e 里进 verified 计划直接 `execution-identity-auth-invalid`（verified 计划要 `opencode serve`+attest，shell 桩不会说 HTTP）。新系统代理一律传 `opencodeCmd: markProductionOpencodeCommand([binaryPath])`（生产 brand→verified 不变；e2e/unit 未 brand→legacy），见 `driver.ts buildSpawn` 的 `legacyTestPath` 与 rfc224-source-reachability 锁（RFC-234 事故）。
- **macOS 下用 `mkdtemp(tmpdir())` 喂 `AGENT_WORKFLOW_HOME`/store 根会撞 verified 链路的反符号链接防线**：`/var`→`/private/var` 是符号链接，hermetic 布局的 `ensurePrivateDirectory` 逐级 lstat fail-closed（`execution-identity-store-unsafe`）。写真机/live 测试先 `realpath` 规范化（identity-preflight 套件的 `canonicalTmp` 即此意）；生产 `~/.agent-workflow` 无此问题。
- **对 opencode 内置资产钉「单一字节 digest」= 给自己埋版本炸弹**：`PINNED_BUILTIN_SKILL` 曾钉死内置 skill 正文 digest，opencode 1.18.8 重写该正文（name/description/location 逐字未变）→ 生产 `verifyPinnedSkillInventory` 对该版本**每次 verified 运行**都 `execution-identity-skill-mismatch`（夜跑 `opencode latest` 腿先于用户拦到）。与 RFC-227 版本中立冲突。正解：身份字段仍逐字精确，正文改为**已审阅发行版 digest 白名单**（未知正文仍 fail-closed，新增条目=人工 diff 过）。判据：`latest` 腿红而钉版腿绿 ⇒ 上游漂移，不是本次改动。
- **有界-spawn 定式**：`killProcessTree`（`process.kill(-pid)` 组杀）+ `detached:true` + 超时 SIGKILL + **finally 无条件组杀**（收 fork-then-exit 孙进程）+ 流式 capped reader（防 stderr 洪泛 OOM）。现 4+ 处（opencode/models/git/sandbox）= dedup 候选。
- **沙箱边界规则一旦有第二份副本，必然漂移成漏洞**：RFC-242 T5 在 claude 侧私抄了一份 opencode 的 git 投影，漏掉三道检查里的全部三道，结果是**可写 allow-back 逃逸**（下一条）。写第二个运行时的同类逻辑时，默认动作是**提取共用模块**、把两边语义差做成显式参数（如 `undescribableRepo: 'fail-closed' | 'skip-projection'`），不是复制后微调。判据：凡「攻击者可影响的路径 → manifest 里的可写子树」这类规则，全仓必须只有一份实现（现为 `services/runtime/netlessProjection.ts`）。
- **`git rev-parse --git-common-dir` 的答案来自工作区内可写的 `.git` 指针，不是可信输入**：`<worktree>/.git` 是普通文件，agent（以及被围栏的 MCP 子进程本身）可写；改成 `gitdir: <任意其它仓>/.git` 后 git **如实报告**那个目录（git 2.50.1 实测，目标只需含 `HEAD`+`objects/`+`refs/`）。把它当可写投影 = 把 daemon 身份的 hook 目录送给模型。防线只有一条：common dir 落在 worktree 之外时，用 `git worktree list --porcelain` 验证**该 worktree 确实注册在那个 common dir 里**（`assertRegisteredGitWorktree`）。附带：git 会自行规范化指针里的 symlink，故「报告路径 realpath ≠ 自身」是纵深防御而非活漏洞。
- **重入型 run 目录里的私有子目录必须 `lstat` 拒链接**：inline-clarify 复用同一 `runRoot`，上一轮的模型可控子进程对 scratch 有写权限，可把 `home`/`tmp` 换成 symlink；`mkdir(...,{recursive:true})` 会**接受**已存在的链接、`realpath` 忠实跟随，于是下一轮把外部目录当 HOME 写进 manifest 并授予可写。定式：逐级非递归 `mkdir` + `lstat` 拒 symlink/非目录 + 全路径 `realpath === self`（`ensurePrivateNetlessDirectory`）。
- **`Bun.which('./x/y')` 按 daemon 的 cwd 解析，不是按你想要的 cwd**：含斜杠的相对 token 交给 `Bun.which` 要么返回 null、要么命中安装目录里的同名无关文件。用户配置里的相对命令必须显式 `resolve(<预期 cwd>, token)`，PATH 查找只留给**裸名字**。
- **围栏子进程的 PATH 还要能找到 shebang 解释器**：`npx` realpath 到 `.../npm/bin/npx-cli.js`（`#!/usr/bin/env node`）而同目录**没有** `node` → 围栏内 `exit 127`。只把命令自身的 dirname 加进 PATH 不够，要解析 `#!` 链把解释器目录也加进去（已在 `/usr/bin:/bin` 里的解释器不必重复投影）。**更要命的是它的失败形态**：claude 报 `mcp_servers:[{status:"failed"}]`、工具表缺失，而节点照常 `is_error:false` 成功——**安全围栏导致的能力丢失必须做成节点级显式失败**，否则没人会发现。
- **bwrap `--setenv NAME VALUE` 把密钥写进世界可读的 `/proc/<pid>/cmdline`**：bwrap 无 `--clearenv` 时把**自己的** environ 原样交给子进程，所以正确做法是把 env 交给 bwrap **进程**（`Bun.spawn({env})`），argv 里一个字节都不放。同理，任何「把密钥移出 argv」的声明都要顺着链路查到底（remote MCP 的 header 仍在 claude 的 `--mcp-config` inline JSON 里，见 audit-backlog）。

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

- **进程级注册表 + 测试夹具 = 只在共享进程下才炸的碰撞**：`bun test` 的项目脚本带 `--isolate`，每个文件独立进程；**手敲 `bun test`（不带 flag）则全部文件共享一个进程**。RFC-247 的路由元数据注册表是模块级单例（它描述「本仓有哪些路由」这一静态事实），于是一个测试夹具若拿**生产路径**当例子（当时用了 `/api/whoami`），共享进程下就会和真实声明撞成「同路径不同契约」并抛错——而带 `--isolate` 跑永远绿。**夹具一律用合成路径**（`/api/__x_fixture__`），别借生产路径当例子；另外**本地复现 CI 请用 `bun run test` 而不是 `bun test`**，两者的进程模型不同。

## 新增 NodeKind（RFC-253 实测）

- **「加一个 NodeKind 要改几处」不要靠人肉清点——让编译器数**。仓内目前有 **8 处**穷尽点，`satisfies Record<NodeKind,…>` / `never` 守卫会逐个把你逼红：`shared/node-kind-behavior.ts`、`shared/nodePorts.ts`、`shared/workflow-node-references.ts`、`backend/services/runLiveness.ts`（`livenessSourceOfKind` 的 `never` 分支）、`frontend/canvas/WorkflowCanvas.tsx`、`NodeInspector.tsx`、`nodePalette.ts`、`canvas/wrapperFit.ts`。RFC-253 的设计门（外部评审）只列出前 7 处，第 8 处是 typecheck 报出来的——**清单会过期，编译器不会**。
- **但仍有不受类型约束的手写表**：`WorkflowNodePicker.tsx` 的 `categoryTabs` 是手写数组（`categoryLabels` / `categoryCounts` 是 `Record<…>` 会红，tabs 数组不会）⇒ 新分区能通过 typecheck 却在 UI 里**没有页签**。只有组件测试抓得到。新增 palette 分区时记得一并加。
- **新增 palette 分区 / 失败码 / 校验码会触发一批"覆盖棘轮"测试**，它们是设计如此、必须显式更新：`palette.test.ts`（分区 key 与 label 列表）、`palette-icon-coverage.test.ts`（glyph 白名单）、`i18n-phase-b.test.ts`、`workflow-node-picker*.test.ts`（分类计数与 `all` 总数）、`permission.test.ts`（`PERMISSIONS.length` 与 manager/admin 快照）、`rfc203-task-failure.test.ts`（每个 `FAILURE_CODE` 必须有本地化文案，否则降级成 `generic`）、`rfc203-validation-copy.test.ts`（每个 validator code 必须有精确词条）、`rfc224-execution-identity-failure-taxonomy.test.ts`（`FAILURE_CODES` 的组合顺序）。
- **`unmanagedReferenceWarnings` 的引用识别是按键名启发式（`/nodeId$/i` 等）**，对**用户可控键名**的字段会误报：一个叫 `FOO_NODEID` 的普通环境变量就会触发 `action:'abort'` 并卡住复制粘贴。正解是给描述符加 `opaqueFields` 显式声明「此子树是用户数据、按构造不含引用」，而不是让启发式去猜用户起的名字。
- **i18n 的 `zh-CN.ts` 里 `interface Resources` 与 `const zhCN` 是两段**，同一个键名在文件里出现两次。用脚本插入键时 `re.search` 会命中**接口**那一份（在前面），结果是把字符串字面量写进了类型声明。改 i18n 一律分别定位两段，改完 `bun run typecheck` 立刻能看出来。

## 子进程与沙箱（RFC-253 实测）

- **`pumpLines` 的行流不能用来还原 stdout**：它 `if (line.length > 0)` 丢空行、也丢尾换行，所以 `a\n\nb\n` 会变成 `a\nb`。对 JSON 事件流无所谓，对「stdout 就是端口值」这类语义是**静默的数据损坏**。需要原文就单独开一条原始字节累加器，与行流分开。
- **`--unshare-net` 不等于无网**：它只隔离 **abstract** unix socket；pathname socket 归 mount namespace 管，而 `--bind / /` 会把 `/run/user/$UID/bus`（D-Bus，可经 systemd 执行命令）和 `/var/run/docker.sock` 一并带进来。真要断网还得 `--tmpfs /run --tmpfs /var/run`，且这仍是 best-effort（根仍是 RW bind）。
- **外层沙箱不是 jail**：Linux `--bind / /` 可写、macOS `(allow default)`，两者只遮 appHome 与几个 crown jewel 文件。任何「进程只能写 X 目录」的断言在写之前先去 `policy.ts` 核一遍。
- **`Bun.spawn` 只在退出后返回，所以 pid 必须在 spawn 瞬间落库**：靠 `await child.exited` 之后再写，daemon 中途被 `kill -9` 就永远拿不到 pid，boot reaper 判 `no-pid`、孤儿进程活到天荒地老。用 `onSpawned` 回执在读取任何输出前写 `pid` + `spawn_binary_path`。
- **`mcpEnvIssues` 显式放行 `PYTHONPATH` / `NODE_OPTIONS`**（对 MCP 子进程合理），复用它去守别的进程时会漏：这两个变量正是「在用户代码第一行之前加载任意模块」的入口。另外「平台键最后覆盖用户键」只对平台**真的会设**的键成立——平台不设时用户值照样存活。要么剔除保留键，要么无条件写入。
- **argv 不过 shell，所以别把 `<` `>` 当 shell 元字符拒掉**：它们是 pip 的合法版本比较符，误拒会给用户一条完全误导的报错。真正该拒的是 flag 前缀、URL/VCS/路径形态与 `;&|\`$()` 这类。

## 前端

- **CSS 改动别肉眼跳过**：最小 repro HTML + `python3 -m http.server`（chrome MCP 拒 `file://`）+ chrome 截图 light&dark 验像素再推。
- **视觉基线刷新前先 `build:binary -- --include-e2e`**——**少了这个 flag 就白刷**：e2e harness 跑的是 `dist/agent-workflow-e2e-*`（`e2e/harness.ts:defaultBinaryPath`），而裸 `build:binary` 只产 `dist/agent-workflow-<platform>`。拿旧 e2e 二进制刷出来的是**旧页面**的图，且测试还会「通过」；判据是「删掉 png 重生成后与旧图字节完全相同」（RFC-248 实测踩到）。旧 dist 同样刷出「通过但错误」的图；`-g` 只刷单 scene；linux 基线取 CI artifact 不本地生成；`--update-snapshots` 对已存在 png 静默 no-op，必变 scene 先 `rm`。settings.png 只截默认(runtime) tab——子 tab 内改动无需刷基线。
- **LAN http = 非安全上下文**：`crypto.subtle`/`navigator.clipboard`/`randomUUID` 皆 `undefined`；「保存卡死/复制无效」先敲 `window.isSecureContext`（防线 `lib/sha256.ts`+`lib/clipboard.ts`+守卫）。
- **改 `tasks.status.*` 文案的两把暗锁**：zh 域禁「等待人工」子串（`node-run-duration-no-manual-marker` 守卫按 `JSON.stringify(tasks)` 子串扫）；en `awaiting_human` 被 `e2e/task-lifecycle-states.spec.ts` 锁死 `'Awaiting input'`。
- **`.tabs--segment` 换行兜底只在 `.auth-page` 域**；RFC-219 picker 分类条须横向滚动+箭头（全局化曾双层红）。
- **markdown/结构化文本的管线改动必须锁「渲染级」断言**（`render` + `<table>`/`<input>`/`<h1>` 等 DOM 产物 + 无字面 `|`/`===` 泄漏），不能只锁中间字符串 `includes`：评审页 diff 表格碎裂期间字符串层测试全绿、浏览器已烂（2026-07-30 修复的盲区；正例 `markdown-diff-table-render.test.tsx`）。
- **带 `/g` 的正则严禁做 `.test()`/`.exec()` 成员判定**：`lastIndex` 跨调用残留，同一输入间歇性漏匹配（markdownDiff identical 输入曾产生假 diff）。成员判定用非 global 兄弟正则或 `String.match`；已有 `ANY_MARKER_RE.lastIndex = 0` 手动复位的写法是次选。
- **删 i18n 键别用「缩进+键名」字符串 `replace`**：`"    generate: 'Generate',\n"` 会命中**更深缩进**的同名键（6 空格行天然包含 4 空格模式），把别人域里的键吃掉并粘连成一行。RFC-247 删 `account.generate` 时误删 `intent.journey.generate`，`tsc` 与 i18n parity 全绿（两文件+类型被对称吃掉），只有一条渲染断言变红。改 i18n 一律**带上下文锚定**（前后各一行一起匹配）并 `assert count == 1`，删完 `git diff | grep '^-'` 逐行过一遍。
- **`t('缺失.键')` 不报错，直接把 key 当文案渲染**：i18next miss 时返回 key 本身——没有异常、没有 warning，`tsc` 也看不见（键在**类型**里声明了、只是**值**没写，两个 locale 的值块是两处）。测试也抓不到，因为大家都用 testid / role 找按钮。守卫在 `tests/i18n-key-resolution.test.ts`：扫全部 `t('字面量')` 并在两个 locale 里 resolve，同时拒绝解析成对象的键（`t('a.b')` 指到命名空间会渲染 `[object Object]`）。带 `defaultValue` 的豁免；模板字面量键静态不可解，归各组件自己的测试。

## 依赖与审计门

- **跨大版本的扁平 `overrides` 会打破按旧 API 调用的消费者**：审计门报 `brace-expansion` 高危时，把它在根 `overrides` 里一刀切钉成 `5.0.9`，结果 eslint 全线 `TypeError: expand is not a function` —— v1 是 `module.exports = expand`、v5 换了导出形态，而 eslint 依赖链上的 `minimatch@3` 按 v1 调用。**先看公告命中的是不是多条不同大版本的线**（这次是 `<1.1.18` 与 `>=4.0.0 <5.0.9` 两条），是的话扁平 override 必错。
- **多数「传递依赖高危」根本不需要 override，`bun install` 重解析就够**：上例里两条线的 semver 范围（`^1.1.7` / `^5.0.5`）本来就允许补丁版本，旧 lock 只是钉在过期版本上；删掉 override 重装即得 `1.1.18` 与 `5.0.9`，各自留在自己的大版本里，公告两条命中同时消失。**先试重解析，再考虑 override，最后才是 IGNORED_ADVISORIES。**
- **依赖改动后本地 lint 绿不作数**：本机 `node_modules` 带着旧解析的残留，改 `overrides` 后 `bun install` 可能不会重链每一条路径，于是本地 lint 全绿而 CI 的干净安装立刻红。凡是动 `package.json` / lock 的改动，**以 CI 为权威**，别拿本地绿当结论。
- **代码没变而审计门突然红 = 新公告落到既有依赖上**，不是你这次改动引入的。判据：找一个**已经绿过**、且包含同一批依赖的提交（本次是引入 CodeMirror 的那个），确认它当时绿 ⇒ 归属为公告漂移。

## dev-env / daemon

- **`bun dev` 中编辑 `packages/backend/src/**`触发`--watch` 重启**，race 30s graceful-shutdown flock → daemon 常 **DOWN\*\*（浏览器空白 + 503 + 误导「token 无权限」横幅），非崩溃；重启复活。纯前端编辑不掉。
- **claude-code 运行时直连 Anthropic**：daemon 从普通 shell 起若缺 `HTTP(S)_PROXY` → 403 被 smoke 误报「缺鉴权」；报缺鉴权先查 daemon 代理再查凭据。
- **claude code 在 uid 0 下 bypassPermissions 会 exit(1)** 除非 env `IS_SANDBOX==="1"`（精确字符串）；root 跑 daemon 时每次 claude-code-protocol 启动都需（`buildClaudeSpawn` 已 gate；2026-07-31 起 intent 受控分支同样 uid-0 主动注入——继承值仍剥离，2.1.220 二进制实证两处 gate 均 bypass-only，注入是容器形态下的诚实断言 + 前向防御）。
- **分离 worktree 里 symlink `node_modules`** 会把 `@agent-workflow/*` 解析回污染的 main → 假 typecheck 错；worktree 里 `bun install` 或信 CI。
- **CI 按你自己的确切 sha 查**：共享 main 上并发 push 会 cancel 你的 CI run；看含你 commit 的 superseding commit 的绿，按失败测试的 owning commit 归属。Codex `--base` 跨并发 commit 会把他人 diff 卷进复审——pin 到你的父提交（分离 worktree）隔离。
- **已知 flaky（别当真红）**：`centralized-answer-pane.test.tsx` cross-round digit-key `checked` race（macOS 尤甚，ubuntu 同 shard 绿即判 flaky，`gh run rerun --failed`）；`skills-split-page` escaped-mocks；根 `bun run test` 的 git-network flaky（已 gate 在 `RUN_GIT_NETWORK`）。
- **排查历史 run 别信 `node_runs.started_at`——它是「最后一次 mark-running」不是「首次起跑」**：`runner.ts` 的 `transitionNodeRunStatus(mark-running)` 每次都写 `extra:{startedAt: Date.now()}`，daemon 重启后的恢复重跑会**原地覆写**它，抹掉真实执行窗口。2026-07-27 任务 `…FBGHV4` 的 run `…D7AFVB` 实测：`started_at`=07-30 20:23:05、`finished_at`=20:23:13（读起来像「起跑 8 秒就崩」），但它的 52 条 `node_run_events` 全部落在 **07-27 04:54:06–04:59:25**（17 次 `tool_use`），ULID 内嵌时间戳更证明该行 mint 于 07-27 04:53:55——真相是「07-27 跑了 5 分半被停机 → interrupted 悬挂 3 天 → 07-30 恢复重跑 8 秒失败」。**三个时间源各管一段：ULID=行 mint、`node_run_events.ts`=真实执行窗口、`started_at`=最后一次 mark-running**；判执行时长/是否真正跑过一律以 events 为准（同批未经恢复的行两者只差 0~1s，差值大即恢复过）。
- **本地起验证 daemon 别把 `APP_HOME` 放 `/tmp`（macOS）**：`/tmp` 是 `/private/tmp` 的 symlink，撞 RFC-224 执行身份 store 路径的 no-symlink 判据，**每个**任务都在跑起来前落 `execution-identity-store-unsafe`，且报错不提 symlink、极易误判成权限/配置问题。隔离实例放 `~/aw-<slug>` 之类的真实路径（scratchpad 同理，只要最终 `APP_HOME` 落在 symlink 下就会中）。
- **integration-opencode 撞新 runner 镜像红 = 环境非代码（2026-07-30 实锤）**：RFC-227 real-binary 用例在 `requireRootOwnedBwrap` 抛 `provider-parent-unsafe`（bwrap 祖先链逐级 root-owned + 无 group/other-write 判定），只发生在 ubuntu-22.04 镜像 **20260726.241.1**；同一 commit（def3d252）attempt 1 新镜像红、attempt 2 旧镜像 20260720.234.2 绿，且 `sealedSubprocess.ts`/该测试/workflow yml 在窗口内零提交——同代码双镜像对照实锤镜像内 bwrap 路径祖先属主/权限漂移。处置：`gh run rerun` 换镜像可过；根治需失败时打印祖先链逐级 uid/mode 诊断后针对性适配（勿放松判定），撞到新镜像的红先按本条归因、别追代码。

- **视觉回归「N 个失败」≠「N 张要改」——同一 test 内的 `toHaveScreenshot` 是短路的**：首个断言失败即中止该 test，后面的截图**根本不会执行**，因此改完第一张，第二张才在下一轮 CI 浮出来。2026-08-01 连踩三次：`table-edge` 遮住 `tasks.png`、`dynamic-workflow-preview-canvas` 遮住 `dynamic-workflow-preview`，每轮只暴露一张，白推三次。改基线前先 `awk '/^  test\(/{t=$0} /toHaveScreenshot\(/{print t" -> "$0}' e2e/visual-regression.spec.ts` 清点同 test 多截图的位置（当前只有 `/tasks list` 与 `dynamic-workflow preview` 两处），把同组的一次性处理完。
- **`--update-snapshots` 会无条件重写「测试实际通过」的截图**：差异在 `maxDiffPixels`/threshold 内的快照也照写不误，直接 `git add` 会把一堆无谓的基线改动混进 commit。正解是先跑一次**不带** `--update-snapshots` 的 `bun run test:visual` 拿到真实失败清单，再更新、并把不在清单里的 `git checkout --` 还原。筛选时注意 `grep -w` 把连字符当词边界：`dynamic-workflow-preview` 会匹配进 `dynamic-workflow-preview-canvas`，用全名精确比对。
- **本地 `bun run test:visual` 跑的是 `dist/agent-workflow-e2e-*` 预构建二进制（前端嵌在里面），不是当前源码**：改完前端不重新 `bun run build:binary:e2e` 就跑，测的是旧产物——据此做的「撤掉改动前后对照」实验完全无效（两次跑的是同一份旧二进制）。CI 每次从源码构建，所以本地绿/CI 红或反之，先怀疑本地二进制陈旧。
- **视觉基线的 darwin 侧对「palette 滚动容器底部的新条目」不稳定**：RFC-243 给 node picker 新增 CALLS 分区后，本地 `bun run test:visual` 对 `workflow-editor-1536-three-rail-light` / `1179-palette-light` 时绿时红，diff 图显示**只有 CALLS 两条目**有文字位移重影（约 3.3k~3.8k 像素、ratio 0.01），页面其余部分逐像素一致——底部条目受滚动位置/字体加载时序影响。**ubuntu（CI 权威门）稳定绿**，故未改 spec；再有人在 palette 末尾加分区且撞到同一抖动，正解是截图前显式把 palette 容器 `scrollTop=0` 或对该区域加 mask，而不是抬阈值。

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
