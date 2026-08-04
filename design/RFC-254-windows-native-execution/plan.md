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

**过程中发现并单独修掉的三条既有缺陷**（均非本 RFC 引入）：`memory-distill-scheduler`
与 `rfc224-fff-capability` 的墙钟时序 flake（两次，第二次是我第一版修复轮询了错误的
谓词）、以及 verified 存储的 TOCTOU 栅栏**零行为覆盖**（已补逻辑 + 接线覆盖，行为覆盖
登记 audit-backlog）。

**未完成且需要 Windows 环境才能验证的**：T4/T4b（Job Object，需 FFI 实测）、
T7（shutdown control listener）、T11b/T11c（verified artifact layout + 注入缝）、
T14b（本地 MCP wrapperless 物化）、T28/T29（e2e stub 编译化 + sqlite fixture）、
T31–T35（CI 矩阵与视觉基线）、T25b–T25d（D24 四子系统）。

## 交付前必过清单

- [ ] `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿（每 PR）。
- [ ] 单二进制 smoke（`build:binary`）+ `build:binary:e2e`（涉及 shared-export / stub 改动的 PR 必跑）。
- [ ] 每 PR 推后按 **exact SHA** 查 CI（含新 windows 腿后四腿全绿）。
- [ ] source-lock 更新的每一条做变异实证（改坏 → 红 → 恢复）。
- [ ] Codex 设计门（RFC 批准前）与实现门（declare done 前）各一次，findings 逐条核实折入；分离 worktree 从 pin 跑。
- [ ] `STATE.md` / `design/plan.md` 索引同步；真机记录落档。

## stub 迁移对照表（T28 维护，初始为空）

| 旧 stub | mode 名 | 覆盖 spec | 状态 |
|---|---|---|---|
| （实现期逐行填写） | | | |
