# RFC-254 · Windows 原生执行支持 —— 任务分解

> 决策（D1–D24）见 `proposal.md §5`；技术细节与锚点见 `design.md`；设计门记档见 [`design-gate-2026-08-04.md`](./design-gate-2026-08-04.md)。
> 本 RFC 体量大，按 **8 个 PR** 切分（CLAUDE.md 允许在 plan 里声明拆分）；全部直接在 `main` 小步提交，每批过全套门禁。
>
> **设计门后新增 PR-0（信任原语）并把 Job Object 提进 PR-1**——二者是其余全部 win32 工作的地基。
> **计数一律不写死**：任务里出现的站点是已知起点，全量以负向扫描守卫实测为准（D23）。
> Windows 真实行为测试自带 `platform !== 'win32'` gate，在 PR-1…5 期间随代码落地（POSIX 腿 dormant），PR-6b 矩阵翻开后激活并登记 skip 配额。

## 切片拓扑

```
PR-0 存储信任原语(D22) ─► PR-1 地基+进程治理(含 Job Object) ─┬─► PR-2 verified 链路+收口 ─┬─► PR-5 构建发行 ─► PR-6a e2e 基建(POSIX 先行) ─► PR-6b 矩阵翻开+基线 ─► PR-7 收尾
                                                            ├─► PR-3 git                │
                                                            ├─► PR-4 脚本节点            │
                                                            └─► PR-4b 遗漏子系统(D24) ───┘
```

## PR-0 · verified 存储信任原语（D22 / AC-30）—— 其余 win32 工作的地基

- **T0a** 抽出跨平台信任原语模块：三条断言（私有性 / 非链接 / 文件身份）各含 POSIX 实现（保持现语义逐字节不变）与 win32 实现（owner+DACL / reparse point / `FileIndex`+`VolumeSerialNumber`），经 Bun FFI 调 advapi32+kernel32。
- **T0b** 把现有散点改为调用该原语：`verifiedManifest.ts:309`、`controlProtocol.ts:185`、`storeHygiene.ts:328`、`sealedInputs.ts:196,265`、`sourceGuard.ts:125`、`binarySnapshot.ts:190-191`（负向扫描守卫证明无遗漏的 exact-mode / `dev`+`ino` / `O_NOFOLLOW` 残留）。
- **T0c** 正反用例 + **变异实证**（win32 分支改成无条件 `true` 必须变红）；POSIX 零漂移断言。
- **T0d** 若实现期证明 DACL 路径不可行 ⇒ **立即停下来报用户**，按 D22 走「显式阻断 win32 verified」而不是静默降级。

## PR-1 · L1 地基 + L2 进程治理（含 Job Object）

- **T1** `util/platformExec.ts`：`NULL_DEVICE` / `pathListJoin` / `isLexicallyInside` / `platformSpawnOptions`——**均接 `platform` 参数**（设计门 P2-1：无参会绑定测试机 OS，Linux CI 执行不到 win32 分支），生产入口再冻结当前平台。**先写负向扫描守卫、再按守卫产出的清单改**（D23），design §2.1 的表只是已知起点；豁免站点逐条加 posix-by-contract 注释。
- **T2** `shared/platformEnv.ts` env 大小写折叠单点；接入 `sealedSubprocess.ts:18` 白名单（**黑名单 `:19-20` 已带 `/i`，无需改**）、`runtime/opencode/spawn.ts:190` **与 `:197` 两处** delete、`claudeCode/spawn.ts:125-147` **与 `:380`**、`shared/runtimeConfigDir.ts:43-53`、`hermetic.ts:89-108` 转发去重（顺序显式化）。全量由守卫产出。
- **T3** `assertArgvWithinPlatformLimit`（AC-29）：win32 按 Bun/libuv 的 Windows quoting 规则序列化（计入 executable、NUL、`windowsVerbatimArguments`）对 32767 校验；**接入每个 process-creation authority**（legacy `opencode run`、`containedSpawn`、`runGit`、doctor、archive、indexer），不只前两个；显式失败文案；**边界用真实 Windows 子进程实测**，不得让 serializer 与单测共享同一算法。
- **T4** 杀树单一权威（**设计门 P0-D 后重写**）：`util/process.ts` 的 win32 实现建立在 **Job Object**（`CreateJobObjectW` / `AssignProcessToJobObject` / `SetInformationJobObject` 设 `KILL_ON_JOB_CLOSE` / `QueryInformationJobObject` 查活动进程数），经 Bun FFI 调 kernel32（上游 `packages/tui/src/terminal-win32.ts` 同形先例，不引第三方原生依赖）；`taskkill /T /F` 仅作 Job 不可用的回退且**回退状态进 receipt、不支撑 store 回收证明**；`isGroupAlive` 泛化为 `isOwnedTreeAlive`。**spawn→assign 竞态窗口**实现期真机实测定档（`CREATE_SUSPENDED` 或接受窗口并在 receipt 标注）。
- **T4b** 内联组杀迁移到权威：**13 个文件 / 22 处调用，扣 2 处 supervisor 自杀（`sealedSubprocess.ts:348` 与 `fffCapability.ts:516`）后 20 处**；`containedSpawn.ts:178` 与 `cli/sandbox.ts:62` **不在清单**（前者已走权威、后者不是组杀）。精确集合以守卫产出为准。既有逐字锁 `rfc208-boot-and-external-timeouts.test.ts:120` 同步改写。
- **T5** 全部生产 spawn 合入 `platformSpawnOptions()`——**站点集合由守卫产出**（当前实测治理面 28：26 个 `Bun.spawn/spawnSync` + `pluginInstaller.ts:600` 的 node child_process + `deep/runner.ts:20` 的注入式默认 spawn；初稿写的 29 无法从源码复现）。
- **T6** 孤儿回收/boot reaper/`isProcessAlive` 接权威；`orphans.ts:188-190` win32 例外注释 + D20 登记。
- **T7** **独立 loopback control listener**（不挂业务 app、不复用业务认证）+ 每次启动重生成的 shutdown nonce（落私有 control 文件，按 PR-0 原语保护，进秘密清单）+ `cli/stop.ts` win32 走 nonce→轮询→关 Job 回退（超时须明确输出「非优雅关停」）；POSIX 路径零改动断言。AC-32。
- **T8** 单实例锁 win32 用例（重复 start / stale 回收）；`agentLaunchReservation.ts:9` 措辞修正。
- **T9** 本 PR 测试：设计 §12 第 1 层纯函数全套（含变异实证）+ 第 2 层 POSIX 零漂移断言 + win32-gated 真实行为用例（dormant）。

## PR-2 · L3 收口 + L4 verified 链路（本 RFC 最大的一块）

- **T10** guidance win32 分支（zh/en）+ `task.ts:1868-1875` 409 文案 capability-driven 化（guidance 单一来源）+ `cli/sandbox.ts` / `cli/doctor.ts` win32 输出（D19 的 mode 检查跳过并明示）。
- **T11** `binarySnapshot` 的 win32 复核走 PR-0 原语（不是「跳过 mode」）；`.cmd/.bat` 拒绝（D17 前置：`resolveWindowsCommand` 助手落地，拦截落在 `command[0]` 预检层）。
- **T11b** **win32 verified artifact layout**（P0-B / AC-13b）：`verifiedPlan.ts:99,528` 的 `process.env.HOME` 改平台感知 home 解析；`verifiedPlan.ts:440`、`verifiedSystemPlan.ts:140`、`verifiedMcpTestPlan.ts:172` 保 `.exe` 后缀；`verifiedSystemPlan.ts:170`、`verifiedMcpTestPlan.ts:220` 的 `/bin/false` 换 win32 等价禁用命令（实测定档）。
- **T11c** **平台事实的注入缝**（★8）：平台与其派生的执行形态约定冻结进准入计划，由 composition root 填充；计划核零 `process.platform`，`rfc233-containment-source-guard.test.ts:38-48` 与 `rfc227-source-guard.test.ts:51` 继续绿且**更强**（win32 语义可在任意 OS 注入直测）。
- **T12** `buildHermeticServerEnv` win32 形态（design §5.2 键表）+「无意外继承键」对照断言（oracle = 子进程实际 environ）。**含 P0-A：受控 PATH 必须含解析并冻结的 git 目录**，验收 oracle 是 agent 进程内真实 `git --version` 成功（AC-13c）。
- **T13** 受控 config win32 不写 `shell` 键；`executionIdentity.ts:191-193` 平台分支断言；provider 路径 win32 不可达性测试（注入平台）。
- **T14** D17 接入：`mcpProbe` 在 `command[0]` 预检层对 `.cmd/.bat` 定向拒绝 + 文案（注意它走 SDK 的 `StdioClientTransport` 而非本仓 `Bun.spawn`）；`pluginInstaller` npm shim 解包（唯一自动解包点）。
- **T14b** **本地 MCP wrapperless direct-child materialization**（D21 / AC-31）：win32 上不物化 sh wrapper，直接以 `{cmd,cwd,env}` 执行；三条入口（inventory probe / 交互 runtime test / 业务 session）各自验收；无隔离事实进事件与 D20 清单。
- **T15** claude-code runtime win32 缝核对（credentials 路径 / uid 分支 / netless 降级）+ 冒烟用例。
- **T16** i18n 双语全量 + 相关覆盖棘轮更新（`i18n-key-resolution`、parity、guidance 快照）。
- **T17** AC-9 守卫：两条 Windows provider contract test 保持绿的显式回归（放进本 PR 的必跑集）。

## PR-3 · L5 git

- **T18** NUL 站点切换（`util/git.ts:1447,1948` + env 3 处）。
- **T19** `hardenedGitLeadingArgs` win32 追加 `-c core.longpaths=true` + 硬化既有 8 用例的 win32 腿。
- **T20** 凭据子命令化（D11，**六条义务见 design §6**）：`__git-credential` 子命令须解析 **operation + stdin 协议**（只在精确 host 的 `get` 返回，`store`/`erase` 静默成功）；**host 绑定是硬性迁移义务**（impl-gate P0-2 的防恶意 submodule 收割）；接线 `-c credential.helper= -c credential.helper=!<quoted>`（**先置空**，否则 GCM 抢答）；路径 quoting 覆盖空格/单引号/反斜杠；一次性文件与 redact 链路不变；既有锁 `rfc205-git-credential.test.ts:45` 同步改写。回归必测：递归 submodule 拿不到凭据 / host mismatch / 含空格安装路径（CI windows + 真机双档）。
- **T21** doctor 增 ssh/git 前置探测提示；README 前置清单。

## PR-4 · L6 脚本节点

- **T22** 解释器平台候选表（python3→python→py；bash 走 git 推导 + 显式覆盖入口；**WSL bash 规避断言**）；探测迁 `containedSpawn`（偿还 `scriptRun.ts:75` 裸 spawn 债，audit-backlog 消项）。
- **T23** 运行 env win32 分支（USERPROFILE/TEMP/TMP/PATH/透传键/`PYTHONUTF8=1`）+ `SCRIPT_RESERVED_ENV_KEYS` 扩表（大小写折叠沿用）+ `PYTHONPATH` 剔除防线平台化回归。
- **T24** 依赖预装：pip 改 `<python> -m pip`（三平台）；npm 走 D17；win32 无 containment 的事件呈现。
- **T25** bash 缺失失败文案（win32 特化）+ 前端 Inspector hint + i18n。

## PR-4b · D24 遗漏子系统（AC-33）

- **T25b** 备份/恢复/归档：`util/archive.ts` 的 tar 在 win32 探测 + bsdtar 方言实测（`--exclude` 形态、长路径、"file changed as we read it" 重试）+ doctor 项 + README 前置；**备份→恢复往返**进 win32 验收。
- **T25c** SCIP indexer：`deep/indexers.ts:102,122` 接 D17 解析 + `windowsHide` + 杀树权威；`deep/runner.ts:36` 超时改走权威；**静默降级改为可见**（事件 + D20 清单）。
- **T25d** 记忆蒸馏 / 定时任务：随 PR-1/PR-2 修好后补 win32 验收（distill + resume；定时启动 + 恢复）。

## PR-5 · L7 构建发行

- **T26** `build-binary.ts`：win32→windows 映射 + `.exe`；`e2e/harness.ts` 同步；`rfc224-e2e-compiled-seam` 锁更新；embed lowercase 冲突断言。
- **T27** release.yml windows-latest 腿（`shell: bash` 显式化 + glob 兼容 `.exe`）；README 下载/前置指引；`root-test-entrypoint` bun 版本钉锁随新腿更新。

## PR-6a · L8 e2e 基建（POSIX 先行全绿）

- **T28a** **先冻结逐文件行为契约**（设计门 P1-5，**这是 T28 的前置而非产物**）：对 12 个 stub 逐个记录 mode / version / argv / env / stdout / stderr / exit / sleep / state·log·worktree 副作用 / 对应 spec，落成本节末尾的表。**契约冻结后才允许写实现**——不得让实现者事后填表当验收 oracle。同时验证 `AW_STUB_MODE` 的送达通道与粒度（per-daemon 是否够用；是否依赖「e2e 永远 legacy」前提）。
- **T28b** 单一参数化 TS stub + `build:binary:e2e` 编译产出；删旧 stub 前在 POSIX 上跑**新旧差分 golden transcript**；`e2e-shell-stub-argv-contract.test.ts:60` 同步改写。POSIX e2e 全量绿后才删旧 stub。
- **T29** `e2e/command.ts` `runSqlite` → bun:sqlite（显式 busy_timeout < 命令超时）；`root-test-entrypoint.test.ts:346-347` 锁更新。
- **T30** ci.yml `build-binary` smoke 段跨平台化（`/usr/bin/true`→自身无害子命令、`cwd:"/"`/`startsWith("/")`→path 判据、显式 `shell: bash`）——先在 POSIX 双腿验证等价。

## PR-6b · 矩阵翻开 + 基线

- **T31** ci.yml 四矩阵 job 加 `windows-latest`；backend windows 腿 opencode 全局安装验证（**注意 `rfc224-source-guard.test.ts:205` 精确断言 `opencodeInstallTargets(ci)===['latest','latest']`，加独立安装步会红**）；`root-test-entrypoint` 与 design §8.4 全表逐条更新 + 变异实证。
- **T32** win32-gated 测试激活；POSIX-only skip 全量登记 `ALLOWED_SKIP_COUNTS`（每条带理由注释）；`REQUIRED_GATE_ACTIVATIONS` 如有新 `RUN_*` 同步。
- **T33** visual workflow windows 腿 + 第三套基线 **46 张 / 40 场景**（option-A：先红→artifact→人工审阅提交）；权威腿保持 ubuntu 注释明示。
- **T34** e2e-webkit-nightly windows 腿。
- **T35** 全矩阵收敛：连续 3 个 main push 的 windows 腿零未登记红（flaky 按 dev-gotchas 纪律处置，不「重跑就过」）。

## PR-7 · 收尾

- **T36** `docs/sandbox.md` D20 降级清单落档 + `docs/OPENCODE_CONFIG.md` 维护清单更新；`docs/audit-backlog.md` 登记：DPAPI、Job Object/AppContainer provider RFC、windows-arm64、`.cmd` shim 自动解包、win32 系统代理孤儿缝。
- **T37** `design/plan.md` RFC 索引状态更新 + `STATE.md` 收尾条目。
- **T38** 真机验收执行与记录（下表），发现项回修或登记。

## AC → 测试追踪表

| AC | 载体（计划文件名 / 既有套件） |
|---|---|
| AC-1/2 | `platform-exec.test.ts`、`platform-env-folding.test.ts`（纯函数 + 站点接线 grep 守卫 + 变异实证） |
| AC-3/4 | `process-kill-authority.test.ts`（argv 构造纯测 + POSIX 零漂移）+ win32 CI `windows-process-governance.test.ts`；AC-4 弹窗=真机项 |
| AC-5 | `daemon-shutdown-endpoint.test.ts` + win32 CI stop 端到端 |
| AC-6 | `lock` 既有套件 + win32 用例 |
| AC-7 | 既有 containment 判定套件（win32 平台注入腿）+ guidance/409 快照 |
| AC-8 | RFC-253 failClosed 既有锁的 win32 注入腿 |
| AC-9 | `rfc233-containment-coordinator.test.ts:206-274`、`rfc227-containment-provider.test.ts:63-105`（不许改语义） |
| AC-10 | guidance/doctor/sandbox CLI win32 渲染快照（双语） |
| AC-11 | win32 CI 编译 stub verified 链路 spec + 真机真 opencode（AC-28 表） |
| AC-12/13 | `hermetic-env-win32.test.ts` 键集快照 + `executionIdentity` 平台分支用例 |
| AC-14 | git 套件 win32 腿（NUL/longpaths/worktree/stash）+ `git-credential-subcommand.test.ts` |
| AC-15 | `mcpProbe` `.cmd` 拒绝用例 + 远端 MCP 既有套件 |
| AC-16 | claude-code win32 冒烟（CI）+ 真机项 |
| AC-17/18 | `script-interpreter-win32.test.ts`（候选链/WSL 规避/假 alias 淘汰）+ env 形态快照 + `PYTHONUTF8` 端到端（win32 CI 跑真 python） |
| AC-19 | deps 安装 win32 CI 用例 + 事件呈现断言 |
| AC-20/21 | `build-binary` 后缀锁 + release workflow 锁（`rfc224-e2e-compiled-seam` 更新态） |
| AC-22 | `root-test-entrypoint` 全量更新态 + 四腿 CI 绿（exact-SHA 查证） |
| AC-23 | e2e windows 四 shard 绿 + stub 迁移对照表全勾 + sqlite fixture 新锁 |
| AC-24 | visual windows 腿绿 + 48 png 提交记录 |
| AC-25 | `test-suite-policy` 更新态（配额逐条理由） |
| AC-26 | i18n 守卫套件 |
| AC-27 | docs diff + audit-backlog 条目 |
| AC-29 | `argv-platform-limit.test.ts`（纯计算）+ **win32 CI 真实子进程边界用例**（超限/贴边各一） |
| AC-30 | `verified-storage-trust.test.ts`（三断言正反例 + 变异实证）；win32 CI 的 reparse point / 他人可写 DACL 拒绝用例 |
| AC-31 | win32 CI 三入口各一条（inventory probe / runtime test / 业务 session）跑真实原生 exe MCP |
| AC-32 | `shutdown-nonce.test.ts`（重生成 / 旧 nonce 被拒 / 退出即失效）+ win32 CI stop 端到端 |
| AC-33 | win32 CI：备份→恢复往返、SCIP 成功与 timeout 两路、distill+resume、定时启动+恢复 |
| AC-13b/c | `verified-plan-win32-layout.test.ts`（注入平台）+ **agent 进程内 `git --version` 真实执行**（win32 CI） |
| AC-3b | 「父退出孙仍在」场景：断言不判可回收（摘掉 Job 改回单 pid 必须变红） |
| AC-28 | 真机记录（下表）落 `design/RFC-254-*/acceptance-real-machine.md` |

## 真机验收清单（D4 / AC-28，Windows x64）

1. 下载/复制 `agent-workflow-windows-x86_64.exe` → `start`：daemon 起、前端可开、doctor 输出如实（无隔离说明 + 前置探测）。
2. 导入 HTTPS 远端仓（含凭据）→ 凭据子命令链生效、URL redact 正常。
3. 跑一条 Code→Audit→Fix 工作流（真 opencode.exe，管理员选定）：seal、受控 config、直接 API、envelope、worktree diff 全链路。
4. 脚本节点三语言各一：python（py launcher 机器）、node、bash（Git for Windows 自装路径变体）；断网档拒绝呈现。
5. claude-code runtime 冒烟（若机器有凭据）。
6. `stop`：优雅关停 30s 语义、锁释放、重启后 interrupted 恢复。
7. 运行全程无 console 弹窗风暴；任务取消后无残留进程（任务管理器核对）。
8. 深路径仓（>260 字符路径）checkout + 构建。
9. （可选）arm64 机器上 x64 产物 Prism 冒烟。

## 实现进度（2026-08-04，滚动更新）

**已交付并推送**（每批各带回归测试 + 变异实证，逐条见 git log）：

| 任务 | commit | 要点 |
|---|---|---|
| T1 | `01c6f67e` | 平台执行原语 + **全仓负向扫描守卫**（D23）。守卫立刻证明手写清单不可信：`${root}/` 前缀 我写 4 / 评审 6 / 实扫 **10**；PATH 4 / 7 / **10**。迁移的 4 处含两处真实功能破坏（插件 GC 误删、seed 路径全拒） |
| T0a | `7b6e039f` | 文件信任原语（私有性 / 非链接 / 同一对象），win32 显式 `platform-unsupported` 失败而非静默跳过 |
| T18 | `f3cb3f8d` | git 的 NUL 空设备（5 处）+ win32 `core.longpaths` |
| T0a 续 | `2185a7e3` | storeHygiene 接原语 + **文件身份**负向扫描规则 |
| T0b | `f870746d` | 六个 verified 存储文件的身份栅栏全部收拢；typecheck 逼出 bigint stat 表示差异 |
| T12 | `82920ad2` | 受控 PATH 的 win32 形态 + **设计门 P0-A**（受控 PATH 必须含 git，否则主线工作流不成立） |
| T2 | `1728b779` | env 键大小写折叠单点（D12），AC-2 的 oracle 是**子进程实际 environ** |
| T22/T23 | `74373d66` | 脚本节点 win32：bash 只从 git 推导（**绝不**裸 `which('bash')`——那是 WSL 启动器）、python 候选链、私有 profile/temp、`PYTHONUTF8` |
| T4/T5/T26/T27 | `e3081c73` | **Job Object**（P0-D，v1 必需）+ 全部生产 spawn 的 `windowsHide` + 产物 `.exe` 与 release 矩阵 + **定向 Windows CI job** |
| — | `7e8d1305` | 真实 Windows CI 首跑抓到的三条，逐条修（见下） |
| T11b | `fd99a0be` | verified artifact layout 的 win32 形态（P0-B）：`USERPROFILE`、禁用命令、`.exe` 后缀 |
| T11c | `9c22bfde` | 平台事实经注入；守卫当场抓住我第一版直接读 `process.platform` |
| T14b | `f082770b` | 本地 MCP wrapperless 物化（P0-F/D21）；**不用 `.cmd`**——cmd.exe 会重新分词 |
| T13 | `12110b8d` | 受控 config 在 win32 不写 `shell` 键，**缺席本身是身份的一部分**；另附 Windows 真机验证脚本 |
| T29 | `86ebbf2d` | e2e fixture SQL 改 `bun:sqlite`——**硬前提**（windows runner 无 sqlite3 CLI），顺带消掉一个真实 flake 的成因 |
| T25b | `cc4dadea` | 归档链路的 Windows 前提。核实后风险面比预想小得多：**macOS 的 `tar` 就是 bsdtar/libarchive**，与 Windows 自带同一实现 ⇒ 方言已被 macOS CI 腿覆盖，只需补「tar 缺失」的显式检查 |
| T28b（骨架 / basic / commit） | `1141f82d` | 编译式 stub 的骨架与**差分验证机制**：同一 argv+env 同时跑新旧，逐字节比对 stdout / exit / 副作用。一个产物含全部 mode——`bun build --compile` 内嵌整个 Bun 运行时（真机实测 123.9 MiB），一 mode 一二进制每次 CI 要一 GB 以上 |
| T28b（intent / slow） | `ab7a575c` | `intent-workflow-opencode.sh` **不单独成 mode**——差分证明它就是同一 mode 加一个变量。slow 保留 shell 的「秒」粒度睡眠（原文整数除法，500ms 等于不睡），改成真毫秒会悄悄改掉所有既有 spec 的时序 |
| T28b（三个 clarify） | `56954531` | 轮次驱动 ⇒ 先把比对升级成**调用序列**（每侧独立 state 目录，比对整段 transcript + 状态文件 + 日志 + cwd 副作用），单次调用只能验证第 1 轮。stderr 升级为逐字节。发现两条：intent 原件**没有** prompt 钩子（我第一版夹带了）；`tr -c` 折叠粒度**取决于 locale**，shell 原件与自己都不一致 ⇒ 改按码点折叠并写明 |
| T28b（workflow-matrix） | `80448bd2` | 最后一个 shell stub：24 个分支、8 个各有含义的退出码。顺带修 dispatch 没 await——sleeping 的 mode 只是靠 pending timer 撑住事件循环 |
| **e2e 加载期回归修复** + T28b 接线 | `6e9e1450` | **T29 把四个 e2e shard 打挂了四个提交**：Playwright 在 **Node** 上加载 spec，解不了 `bun:` ⇒ 加载期就死、且报成 "No tests found"。Bun 的 SQLite 保留但挪进子进程；顺带删掉一处 `writefile()` 绕行（sqlite3 CLI 的扩展函数，换引擎时静默丢了）并补 `querySqlite`。harness 从「传路径」改成「声明 mode」 |
| T28b（删旧件） | `35bd4c5a` | 删 12 个原件前把它们的**实际可观测行为录成 golden**（129 个用例），比对改为回放录音——证明链留在仓库里，且**在 Windows 上也能跑**。argv 契约门跟随迁到 mode，途中发现三个 TS 系 mode 各自留着 `argv.slice().join(' ')`（即 `$*` 折叠的 TS 版），改掉并加源码规则 |
| T28b（Windows 腿） | `931b971e` | golden 回放接上 windows-platform 作业；修两处会让 POSIX 录音在 Windows 上必然对不上的路径归一（状态文件 key 的分隔符、遮蔽没盖 cwd） |
| T29 锁 + T30 | `2ad40f56` | 源码锁跟随进程边界（并**反过来**禁止父侧再 import `bun:sqlite`）；build-binary 冒烟段三处 POSIX 前提跨平台化，改后把 CI 那段脚本抽出在本机验证等价 |
| T28b（遥测矩阵） | `769a1057` | RFC-224 的版本遥测矩阵按 mode 枚举，覆盖面从 8 个 .sh 扩到 11 个 mode |
| T36 | `71da93c2` | Windows 四条未决项登记（无 containment provider / 缺 DPAPI / `.cmd` 不自动解包 / 系统代理孤儿缝）+ `sandbox.md`「尚无发行二进制」订正 + `OPENCODE_CONFIG.md` 维护清单 |
| — | `78b7205f` | 两条 e2e 红的**逐格构建实证归因**（均非本 RFC）：`focus-ring-clip` 本就不绿（4 个），被 `01d3e541` 推到 108；`rfc250-workflow-camera` 在 `6e9e1450` 上通过 ⇒ 归并发画布改动 |
| **P0 修复** | `a486b79c` / `29ed4880` | **Job Object 的 `ActiveProcesses` 偏移读错字段** —— 见下 |
| — | `ba54c779` | golden 回放在 Windows 上被 **8.3 短路径**打穿（子进程记录的 cwd 是 `C:\Users\RUNNER~1\...`，遮蔽表里是长路径）⇒ 追加一层按临时目录**名字**的遮蔽（前缀是我们自己定的，与 OS 拼法无关），并用 windows-latest 上实际写出的那行字符串在 macOS 上直接验证 |

**x64 Windows CI 腿第一次真正执行 Job Object 就抓到一条 P0**：
`ACTIVE_PROCESSES_OFFSET` 原本写成 `48 - 4 - 8 - 8 - 8` = **20**，是从结构大小
**倒着减**推出来的；按 Win32 正向排布 `ActiveProcesses` 在 **40**，20 落在
`ThisPeriodTotalUserTime` 中间、对刚起的进程恒为 0。它喂的是
`isProcessTreeAlive` ⇒ runtime store 能否回收（RFC-224），读成 0 = 「树已死」=
**后代还持有 store 时就把 store 释放给别人复用**，正是设计门 P0-D 要防的数据损坏。

**为什么此前三道关都没拦住**：macOS 根本没有这条 FFI 路径；ARM64 真机上 Bun 构建
禁用 TinyCC、`dlopen` 直接抛，走的是降级分支；代码审查看不出来，因为**错误的 FFI
偏移不会抛异常，它只会从另一个字段返回一个看着合理的数**。修法因此不止改数：偏移
逐字段正向写出并导出，测试用「按字段大小正向累加」独立推导后比对，四处变异（原始
的 20 / 差四字节的 36 / LimitFlags / extended 结构大小）全部能变红。这条是「定向
Windows 作业」这个决定本身的最大一次回报。

**Windows CI 首跑的价值（`e3081c73`）**——一次抓到三件事，全是我这边的问题：
① **Job Object 的 FFI 在真实内核上一次成功**（最重要的正面结论：函数声明、
结构体偏移、标志常量全对，这是 macOS 上无论如何证明不了的）；
② 但我把**测试进程自己的 pid** adopt 进了 `KILL_ON_JOB_CLOSE` 的 job，
句柄一关就杀掉测试运行本身；
③ **守卫自己带着它要抓的那个缺陷**——`relative()` 在 Windows 上产出反斜杠，
而豁免表全用 `/` 写，扫描器在 Windows 上一条都匹配不上。

**过程中发现并单独修掉的三条既有缺陷**（均非本 RFC 引入）：`memory-distill-scheduler`
与 `rfc224-fff-capability` 的墙钟时序 flake（两次，第二次是我第一版修复轮询了错误的
谓词）、以及 verified 存储的 TOCTOU 栅栏**零行为覆盖**（已补逻辑 + 接线覆盖，行为覆盖
登记 audit-backlog）。

**实现门（2026-08-04，两路独立子代理对抗式评审）**：Codex 的 `review` 在主干开发
下会把并发 session 的提交一起圈进 diff（实测它在读 rfc257 的文件），故改用仓库
认可的替代路径（RFC-240 先例），按本轮**确切改动面**切两个子代理。共报 25 条，
绝大多数附变异验证，逐条核实后**全部折入**（`227c2086` / `ed1ee666`）。分四类：

1. **接线诚实性**：`adoptSpawnedProcessTree` 零生产调用方，而文件头断言 P0-D 保证
   已生效。实际是**安全但降级**（`null` = 判不了 = 调用方必须当不可回收 ⇒ 防护在，
   强保证不在）。已订正文件头 + 登记 backlog（含接线后语义变化的提醒）。
2. **能变绿的假断言**三条：`terminate()` 丢返回值且 `liveCount()` 在 closed 时短路
   ⇒ 事后断言读的是自己刚设的布尔量；harness 把 `AW_STUB_MODE` 放在 `extraEnv`
   之前 ⇒ 可被静默覆盖（注释写着相反的话）；`toContain('timeout: …')` 被同文件
   另一处满足。
3. **移植保真度**四条真差异（输入都可达）：`batch of N` 从最后一处匹配变第一处、
   上传检查交错导致**退出码**变化、`iteration=007` 经 Number 往返改掉了文件名、
   空白串 ASK_SHARDS 把「抑制提问」翻成「提问」（两种信封类型）。
4. **比对机制自身有假**：「唯一证明会等」的用例不记时长（删掉 sleep 全绿只是快了
   20 秒）；`slow` 唯一睡眠用例是被整数除法抹平的 500ms、而生产驱动 15000/20000；
   副作用只比存在与否；inventory 两侧先 parse 再比、于是名为「compact, not pretty」
   的用例看不见 pretty；三个 TS 出身的 mode 没有一条用例到达发射分支（两条用例名
   还与实际录到的不符）；删掉一条用例不会红。

golden 按流程从**原件**重录，回放 151/151；九处修复各有变异实证，唯一没有测试的
是 `Bun.write` → `writeFileSync`（17 字节恒落盘、8 MiB 恒不落盘，均实测，依据写进
注释而不是假装有红）。

**T28b 的一条方法论**（值得复用）：删掉一份「参照实现」之前先把它的行为录成
golden，否则差分证明会随旧实现一起消失。配套三条断言缺一不可——重录必须跑**旧
实现**（因此只在还有旧实现的 checkout 里能重录，不是给回归开绿灯的口子）、缺
golden 直接报错、以及「每个 mode 都有 golden、每个 golden 都有 mode」的双向核对。
意外收获是录音**在旧实现跑不起来的平台上照样回放**：shell stub 在 Windows 上不
能执行，它的录音能。

**未完成且需要 Windows 环境才能验证的**：T4/T4b（Job Object，需 FFI 实测）、
T7（shutdown control listener）、T11b/T11c（verified artifact layout + 注入缝）、
T14b（本地 MCP wrapperless 物化）、T31–T35（CI 矩阵与视觉基线）、
T25c–T25d（D24 剩余子系统）。

## T31–T34 · Windows 勘测实测结论（2026-08-05）

翻矩阵之前先测量，而不是照着 403 个含 POSIX 构造的文件盲扫。两个非门禁勘测作业
落在 `.github/workflows/windows-survey.yml`（`cancel-in-progress: false`——第一次
尝试被我自己的下一次推送砍掉了：90 分钟的非门禁作业放在会取消的并发组里基本跑不完）。

**e2e：270 条里 213 通过、45 skip、7 失败、2 flaky。** 比预期好得多，直接原因是
T28b 已经把九个 shell stub 拿掉了。7 条逐条归因：

| 用例 | 根因 | 归属 |
|---|---|---|
| `workflow-matrix` output kinds | **路径分隔符** | 本 RFC，已修 `c345d948` |
| `business-workflow-scenarios` 文档批处理 | **路径分隔符** | 同上 |
| `workgroup-matrix` ×2 | 同形 `toBe` 断言，疑同源 | 待重跑确认 |
| `mcp-runtime-playground` | locator 不可见 | 待查 |
| `focus-ring-clip` | **POSIX 上也红**（既有缺陷，`01d3e541` 把它从 4 推到 100+） | 非本 RFC |
| `rfc250-workflow-camera` | **POSIX 上也红**（并发画布改动） | 非本 RFC |
| `intent-builder` a11y（flaky） | 既有对比度缺陷（RFC-027 起） | 非本 RFC，已登记 |

**路径分隔符那条是本轮最有价值的发现，而且是生产缺陷不是测试格式问题**：
`envelope.ts` 与 `portArtifacts.ts` 的 `relative()` 在 Windows 上返回反斜杠，而那个
值会**落库成端口内容、插进下游节点的 prompt 交给模型、被工作流逻辑匹配**——同一个
工作流在不同宿主上产出不同的数据，分歧一路走到模型输入里。收进单点
`toPortableRelativePath()`。

**T31 的前置已就位**：四个矩阵 job 的每个 `run` 步骤显式声明 `shell: bash`
（Windows 默认 pwsh；POSIX 侧行为等价——唯一差别是 `pipefail`，而这些步骤无管道），
并加了棘轮：矩阵 job 里不声明 shell 的步骤直接红。

**后端全量的首次 Windows 实测（2026-08-05）**：勘测**跑满 90 分钟被超时终止**，
这本身就是 T31 的第一条数据——**这套在 Windows 上跑不完**（POSIX 上约 17 分钟）。
主因是它大量 spawn 子进程，而 Windows 的进程创建慢得多。矩阵腿要么给远大于 90 分
钟的预算，要么按现有 4 分片继续切细。

截至超时已产出 **386 条失败**，按 describe 聚类的前几名（同族多半共根因）：

| 条数 | describe |
|---|---|
| 21 | RFC-224 sealed model-reachable subprocess boundary |
| 16 | RFC-224 OpenCode account hygiene |
| 15 | RFC-224 launcher lifecycle and direct protocol ordering |
| 14 | updateRuntime / deleteRuntime guards（RFC-112） |
| 10 | runSystemAgent |
| 9 | RFC-224 verified business-plan owner barrier / FFF capability proof |
| 9 | RFC-014 iterate sibling cascade |
| 8 | /api/plugins install path（PATH 注入的 fake npm） |

**已处理的第一簇（RFC-112，21 条）**：根因**不是**预判的「自写假二进制」——是夹具
写死 `binaryPath: '/opt/my-cc'` 这类 POSIX 字面量。陷阱在于它在 Windows 上不是被当
成相对路径拒绝：`isAbsolute('/opt/x')` 为 true（前导斜杠即绝对、落在当前驱动器），
它顺利通过绝对检查、再栽在规范性回环上（`resolve` 得 `D:\opt\x`），而报出的诊断
指向 traversal——唯一没错的那件事。**生产校验器本身是对的**，真 Windows 路径规范
且被接受；不可移植的是夹具。已加 `canonicalBinaryPath()` 并全量转换 16 个文件
（`030d7f6d` / `24ef0e27`），另记下两类**不得转换**的：必须是真二进制的
（`/bin/echo`）、以及故意畸形的负向字面量——两者都被它们自己的测试当场抓住。

**第二轮 e2e 勘测（含路径修复）：216 通过 / 5 失败**（首轮 213 / 7）。路径修复清掉了
`workflow-matrix output kinds` 与 `business-workflow-scenarios`，`mcp-runtime-playground`
退为 flaky。剩下两条 Windows 特有的 workgroup-matrix，根因是 **CRLF**：stub 写进
`...gate rejection\n`、读回来是 `...\r\n`。中间只经过 git——Git for Windows 默认
`core.autocrlf=true`。**框架的 worktree 不是开发者的 checkout**：agent 往里写字节、
框架提交并重新物化、那些字节再作为端口值 / diff / 模型读到的内容离开。已在
`hardenedGitLeadingArgs` 钉死 `core.autocrlf=false` + `core.eol=lf`（`c8e01df6`）。
修完后 e2e 侧应只剩三条**在 POSIX 上也红**的既有问题。

**第三轮（含 CRLF 修复）：216 通过 / 3 失败 / 4 flaky。** 两条 workgroup-matrix 消失，
确认 CRLF 是它们的根因。三条剩余里**两条在 POSIX 上也红**（`focus-ring-clip`、
`rfc250-workflow-camera`，均已实证归属他人改动），所以 **Windows 特有的 e2e 失败已从
首轮的 5 条降到 1 条**（`ux-consistency:1142` Skill ZIP，待查）。

三轮的轨迹：213/7 → 216/5 → 216/3。**T33/T34 的技术阻塞基本清除**——剩下的是把
最后一条查掉、把 4 条 flaky 定性，然后接腿并生成 46 张 win32 基线。

**第四轮：219 通过 / 2 失败 / 2 flaky —— Windows 特有的 e2e 失败已归零。**
两条失败正是 `focus-ring-clip` 与 `rfc250-workflow-camera`，**在 POSIX 上同样红**、
已逐格构建实证归属他人提交并记入 audit-backlog。四轮轨迹：
**213/7 → 216/5 → 216/3 → 219/2**，每一步都由一次测量驱动：

| 修的东西 | 性质 |
|---|---|
| 端口相对路径的分隔符 | **生产缺陷** |
| git `autocrlf` / `eol` | **生产缺陷** |
| 取色断言与主题应用赛跑 | 测试同步 |
| 三处 `networkidle`（常驻 WS ⇒ 网络永不 idle） | 测试同步 |

**接腿的前置条件已清楚**：ci.yml 的 `e2e` job `needs: build-binary`，而后者的
RFC-224 supervisor 冒烟驱动的是 **bwrap**（Linux 概念）且载荷是 `/usr/bin/true`
——两者在 Windows 上都不存在。所以加 windows 腿要先给那一步做平台闸门，且要先决定
那两条**他人负责的既有红**怎么处理（等作者修 / 暂时排除 / 接受红腿）——这是个需要
拍板的点，不是技术障碍。

## T31（e2e 链）· 完成，Windows 五条腿全绿（2026-08-05）

CI run 30961487674：`build-binary (windows-latest)` 与四个 `Playwright e2e` 分片
**全部 success**。同一 run 里仅有的两条红在 **POSIX** 腿上，正是 `focus-ring-clip`
与 `rfc250-workflow-camera` 这两条既有问题。

**只翻 e2e 这条链**（`build-binary` + `e2e`）；`test-backend` / `test-frontend` 保持
两腿，直到后端那 386 条完成分类——先翻会让 main 对所有人变红。

途中一条值得记的判断错误：**排除只排掉第一条，第二条就顶上来**。首次门禁跑出来
shard 3 仍红，查下来 `--grep-invert` 执行正常，红的是同文件的另一条；POSIX 上实测
确认那三条同源于一个画布缺陷，原先只是被「首条失败后同文件其余不再运行」掩盖着。
于是两条排除做成**两种形状**——`focus-ring-clip` 按标题（一条坏六条好，实测其余全过）、
`rfc250-workflow-camera` 按文件（三条同源，如实计为 3）——并让棘轮要求每条**声明自己
被允许移除多少条**，按 Playwright 的真实匹配语义（文件路径 + 标题都算）核对。

**下一簇的线索（RFC-224，70+ 条）**：`rfc224-sealed-subprocess.test.ts` 用
`providerId: 'linux-bwrap'` + `/usr/bin/bwrap`，是 **Linux 专属**的能力证明；
Windows 上的失败形态是「12 秒等不到 supervisor 的 ACK 写入」。12 秒已相当宽裕，
所以**必须先分清「慢」还是「根本没起来」**再决定是加 `skipIf` 登记还是修——
supervisor 是真被 spawn 的（编译产物的隐藏子命令），不是纯注入。这一步需要在
Windows 上单独查，不该照着猜下结论。

原始聚类集中在 **RFC-224 verified 执行链路**与**运行时解析 / 插件安装**两簇，与前文
「27 个单测自写 `#!/bin/sh` 假二进制」的预判吻合：`opencodePath` 在生产侧是**单个
字符串**，Windows 上必须指向真可执行文件，而这些测试写的是 shell 脚本。这是 T32
分类的第一批，且**需要一个设计决定**（给测试提供真 .exe / 改用别的 seam / 登记
skip），不是机械替换。

**旧的估算口径（2026-08-04 订正）**：此前写的「约 8600 条会同时变红」把**全套
总数**当成了受影响数，不成立。实测口径：1023 个测试文件里 **403 个**（39%）至少含
一处 POSIX 专有构造，涉及约 3500 条声明——且这是**上限**，一个文件里出现一次
`/tmp/` 不代表它每条用例都会红。**爆炸半径以文件计**：共享 `beforeAll` 里挂一行会
带走整个文件的用例，所以「403 个文件各错一行」在报表上呈现为数千条红。把
`windows-latest` 直接加进四个矩阵，仍会一次性暴露那 403 个文件——这正是当初把
Windows 验证拆成独立定向作业的原因（见 `.github/workflows/windows-platform.yml`
头部）。T31/T32 的实质工作量是**逐条分类**（真缺陷 / 需 win32 分支 / 合理 skip 并
按 `ALLOWED_SKIP_COUNTS` 逐条登记理由），勘测产物就是那份清单的输入。T33 的 46 张
win32 视觉基线现在**不再被阻塞**——e2e 已能在 Windows 上跑，剩的是把那几条真失败
清零后接腿。当前定向作业已覆盖：平台原语七套 + golden
回放 + argv 契约 + Node 兼容守门 + shared 套件 + typecheck + 单二进制与 stub 的
构建冒烟 + doctor。

## T32 分类结果（2026-08-05，Windows 11 真机实测）

用 Parallels 上的 Windows 11 虚拟机（`10.211.55.3`）跑后端全量，把「386 条失败」的
估算换成了**逐条实测**。首要发现是：**当初那份勘测清单里有相当比例是取样器的假阳性**
——VM 上是 T29 之前的旧快照（`.sh` 老 stub 还在、编译版 stub 源没同步过去），
17 条 stub argv 失败全部出自此，与 Windows 无关。清干净重跑后剩 **约 32 条**。

**「慢还是根本没起来」这个悬案已结**：两者都不是。RFC-224 那簇在 Windows 上是
**秒级失败**（`bindReadOnly` 的 zod 校验、进程组语义），不是超时；12 秒预算从来
不是瓶颈。本机基线也佐证：整个文件 26 条 1.58 秒跑完。

已处理（含各自的正/反向验证）：

- **B 类·POSIX provider 专属（29 条）** —— 断言的**主语**就是 POSIX 隔离机制
  （root-owned bwrap 命名空间试探、supervisor 的进程组归属与 PGID 信号阶梯、
  bwrap bind/mask 投影、macOS Seatbelt profile 文本）。RFC-254 v1 明确不给 Windows
  任何 provider，这些路径在该平台上**不是没测，是不存在**。判据抽成单一事实源
  `packages/backend/tests/fixtures/platformScope.ts`，逐条登记进
  `ALLOWED_SKIP_COUNTS`。**不可达本身有正面断言**：`rfc205-sandbox-probe-wrap.test.ts`
  注入 `'win32'` 断言 mechanism 为 null、unavailable，且它在每个平台都跑。
  实测：macOS 40 pass / 0 skip；Windows 11 pass / 29 skip / 0 fail。
- **env 消毒的平台分歧（1 条）** —— 不是缺陷，是 T2 的直接后果，因此**两个平台的
  答案都断言**而不是跳过一个。Windows 环境变量名大小写不敏感，`lower` 与 `LOWER`
  本就是同一个变量，折叠后放行不构成额外暴露。
- **两处真实生产缺陷** —— 见 `docs/audit-backlog.md`「Windows 真机勘测发现的两处
  生产缺陷」：仓库缓存目录名把整条源路径编进去导致 `git clone` 报
  `fatal: '$GIT_DIR' too big`（已修，且刻意不动哈希以免存量缓存重键）；
  `spawn('npm')` 撞 `.cmd` 垫片使插件安装在 Windows 上整体不可用（未修，需独立改动，
  且**不得**用 `shell: true`）。
- **测试设施的可移植性缺陷（1 条）** —— `test-suite-policy.test.ts` 用宿主分隔符拼
  清单 key，Windows 上**每一条**都对不上，报表呈现为「整份已审阅清单同时缺失且多余」。

### 第二轮：C / D 类修完，A 类定性订正（同日）

**C 类原先那 5 条是环境假阳性**——是 VM 上 `bun install` 之前 `zod` 缺失导致整文件
加载失败，与 Windows 无关。重装依赖并**比对文件哈希确认树与 HEAD 一致**后重跑，真正
的 C/D 类如下，均已修并在两平台验证：

| 失败 | 真因 | 处理 |
|---|---|---|
| `api-contract-coverage` | `f.split('/')` 手写取 basename，Windows 上整条路径成了文件名，守卫报「零个已知盲点」 | 改用 `basename()` |
| 调用图 `ref` | `relative()` 返回宿主拼写，而 ref 是**可移植标识符**：输入 `/`、输出 `\`，自己产出的 ref 喂不回自己 | **生产修复**（`expandService.ts`）+ 变异证明 |
| `toPortableRelativePath` | 无条件替换 `\`，而 POSIX 上它是**合法文件名字符**，会悄悄指向另一个路径 | 加平台判据；同时改进 T31 既有调用点 |
| `auth-token` / `daemon-start` | 断言 0o600，但 Windows 上 `chmod` 是 no-op、`stat` 恒报 0o666 | 走既有 `statMetadataIsAuthoritative`，两平台各断言其真值 |
| `git-noninteractive-env` | 对 `process.env` 展开结果取 `.PATH`（真实键是 `Path`） | 用 shared 折叠取值器；**已查证生产侧无缺陷**（两处写 PATH 的地方都从 `{}` 干净构建，无重复键隐患） |
| `agent-multi-grep-guard` | 扫三个 `src/` 树，本机 107ms、Windows 超 5s（≈47×，逐文件实时扫描） | 按实测给显式预算 |
| `bwrap 诊断` | POSIX provider 专属 | 守 describe + 登记棘轮 |

**A 类比原估计大，且原先的归类有一条是错的**：`fusion-engine.test.ts` 两条报的是
「取消后应为 canceled，实得 failed」，看着像取消语义在 Windows 上不同——实际是紧邻
日志里的 `runtime-spawn-failed`（`stub-opencode.sh` → `EFTYPE`）让任务先以 `failed`
收场。**该「取消语义缺陷」判断已证伪**。A 类正解与判据见
`docs/audit-backlog.md`「A 类：后端测试自写 `#!/bin/sh` 假二进制」。

**EBUSY 一类未解**：两步尝试都被证伪（Bun 不实现 Node 的 `rmSync` 重试选项；显式重试
确实在跑但一秒不够），说明句柄在 `close()` 后仍存活。下一步是查「谁还开着」而不是
继续加预算——见 backlog 同名条目。

剩余待办（已定性，未修）：

| 类 | 条数 | 处理方式 |
|---|---|---|
| A `.sh` 假二进制夹具（`opencode-models` 9 + `fusion-engine` 2 + …） | ~11 | 同 T29：编译一个跨平台 stub，行为由数据文件选择 |
| EBUSY 拆卸（`db` / `cli` / `gettask-multi-repo`） | ~6 | 先定位句柄持有者 |
| `agent.plugins`（`spawn('npm')` 撞 `.cmd` 垫片） | 4 | 生产缺陷，需独立改动且不得用 `shell: true` |

**取样器本身的教训**（已同步 `docs/dev-gotchas.md` 的候选）：拿一台真机做勘测时，
**先证明树与 HEAD 一致**再信它的失败清单；两次全量并发写同一个输出文件会得到
无法归属的混合结果；wipe 掉 `packages/` 会连 workspace 内的 `node_modules` 一起带走，
表现为 `Cannot find package 'zod'` 这种与改动无关的加载失败。

## 交付前必过清单

- [ ] `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿（每 PR）。
- [ ] 单二进制 smoke（`build:binary`）+ `build:binary:e2e`（涉及 shared-export / stub 改动的 PR 必跑）。
- [ ] 每 PR 推后按 **exact SHA** 查 CI（含新 windows 腿后四腿全绿）。
- [ ] source-lock 更新的每一条做变异实证（改坏 → 红 → 恢复）。
- [ ] Codex 设计门（RFC 批准前）与实现门（declare done 前）各一次，findings 逐条核实折入；分离 worktree 从 pin 跑。
- [ ] `STATE.md` / `design/plan.md` 索引同步；真机记录落档。

## T28a · stub 行为契约（冻结于 2026-08-04，实现前）

> 设计门 P1-5 明确要求：这张表是**实现的输入**，不是实现完之后回填的产物——
> 让实现者事后填表当验收 oracle，等于实现与测试共用同一个前提。

**为什么必须合并成一个产物**：每个 `bun build --compile` 产物都内嵌完整 Bun
运行时（实测单二进制 123.9 MiB）。12 个 stub 各编一个 ≈ 1.2 GB，CI 每次都要
构建与上传——所以「单一参数化 stub + `AW_STUB_MODE` 选行为」不是审美偏好，
是可行性前提。

### 全部 12 个 stub 共有的骨架（迁移时必须逐条保持）

1. **两种 CLI 模式**：`--version|-v|version` 打印一行版本串后 `exit 0`；
   `run` 进入正常路径；其余一律 stderr 报错 + **`exit 2`**。
2. **prompt 是 `--` 之后的唯一位置参**（不是 `$*`）。这条被
   `e2e-shell-stub-argv-contract.test.ts` 锁死：读 `$*` 会把所有 flag 折进
   prompt，从而对 argv 布局回归**失明**。
3. **`AW_STUB_PROMPT_OUT`** 若已设置，把解析出的 prompt **逐字**写入该文件
   —— 契约测试据此断言 stub 解析到的是真 prompt 而非某个 flag。
4. **RFC-200 nonce 回显**：从 prompt 里 `nonce="..."` 取**最后一个**，写回
   响应信封；取不到时各 stub 有自己的降级分支。
5. 输出形态：`--format json` 的事件流，daemon 侧拼接 `part.text`。

### 逐 stub 差异（这才是合并的风险面）

| 旧 stub | 建议 mode | 独有行为（**迁移时最易丢的**） | 覆盖 spec |
|---|---|---|---|
| `stub-opencode.sh` | `basic` | 固定单端口 `answer`；版本串**故意非 semver**（telemetry 归一化用例） | 基础任务链 |
| `stub-opencode-commit.sh` | `commit` | **按 prompt 判角色**：提到 `commit_message` → 发提交信息且不写盘；否则**弄脏工作树**触发 diff 驱动提交 | RFC-075 自动提交推送 |
| `stub-opencode-clarify.sh` | `clarify` | **轮次驱动**：按 `$CLARIFY_STUB_STATE` 计数文件 + (agent, shard_key) 决定发问还是收尾 | RFC-023 反问 |
| `stub-opencode-clarify-inline.sh` | `clarify-inline` | **总是先发 `session.created` 事件**（runner 要捕获 sessionId）；轮次状态按 key 分档 | RFC-026 同 session 反问 |
| `stub-opencode-cross-clarify.sh` | `cross-clarify` | 只按 (agent, 调用次数) 决策，**不锁定轮次顺序**——RFC-162 改成重跑提问者后仍要工作 | RFC-056 跨节点反问 |
| `stub-opencode-intent.sh` | `intent` | intent 协议信封（`summary` + `changeset` 双端口，含一条建 agent 的 op）；额外的 **`exit 3`** 分支 | RFC-234 intent |
| `intent-workflow-opencode.sh` | `intent-workflow` | **先写变体环境变量再 exec 上一个**；名字**刻意排除**在版本遥测矩阵之外 | intent 工作流草稿 |
| `stub-opencode-slow.sh` | `slow` | 可控 **sleep**（撑住 running 状态好 SIGKILL daemon）；失败 / 无信封 / 非零退出三条路径；写 `AW_INVENTORY_OUT` | 崩溃恢复、任务生命周期 |
| `stub-opencode-workflow-matrix.sh` | `workflow-matrix` | 按 prompt 里的 `MATRIX_*` marker 选分支；prompt 断言、上传、**重试退出码**、timeout；`exit 10` | 工作流矩阵 |
| `stub-opencode-business-workflows.ts` | `business-workflows` | 已是 TS（423 行），业务工作流全链路 | 业务工作流 |
| `stub-opencode-business-workgroups.ts` | `business-workgroups` | 已是 TS（239 行） | 业务工作组 |
| `stub-opencode-workgroup-matrix.ts` | `workgroup-matrix` | 已是 TS（347 行） | 工作组矩阵 |

### 实现前必须先回答的两个问题（设计门 P2-2）

- **`AW_STUB_MODE` 怎么送达**：stub 由 daemon spawn，legacy 路径继承 daemon
  env 可行——但这依赖「e2e 永远走 legacy」这一前提（见 P0-5：编译 e2e 件按
  构造走 legacy 分支）。若将来给 e2e 开 verified，受控 env 白名单会**剥掉**
  这个变量。
- **粒度**：`AW_STUB_MODE` 是 per-daemon 的。若某个 spec 需要**同一次运行里
  不同节点用不同 stub 行为**，这个机制不够——需要按 agent 名或 prompt marker
  二级分派（`workflow-matrix` 已经是这个形态，可作范本）。

### 交付顺序（不得跳步）

1. 冻结本表（**已完成**）。
2. 实现单一 TS stub，逐 mode 对照本表。
3. **POSIX 上跑新旧差分 golden transcript**——同一 spec、同一输入，比对新旧
   stub 的 stdout/exit/副作用逐字节一致。
4. POSIX e2e 全量绿之后，才删旧 stub。
5. 最后接 Windows 腿。
