# RFC-254 · Windows 原生执行支持 —— 任务分解

> 决策（D1–D20）见 `proposal.md §5`；技术细节与锚点见 `design.md`。
> 本 RFC 体量大，按 **7 个 PR** 切分（CLAUDE.md 允许在 plan 里声明拆分）；全部直接在 `main` 小步提交，每批过全套门禁。
> Windows 真实行为测试自带 `platform !== 'win32'` gate，在 PR-1…5 期间随代码落地（POSIX 腿 dormant），PR-6b 矩阵翻开后激活并登记 skip 配额。

## 切片拓扑

```
PR-1 地基+进程治理 ──┬─► PR-2 收口+opencode 链路 ──┬─► PR-5 构建发行 ─► PR-6a e2e 基建(POSIX 先行) ─► PR-6b 矩阵翻开+基线 ─► PR-7 收尾
                     ├─► PR-3 git                  ┘
                     └─► PR-4 脚本节点
```

## PR-1 · L1 地基 + L2 进程治理

- **T1** `util/platformExec.ts`：`NULL_DEVICE` / `pathListJoin` / `isLexicallyInside` / `platformSpawnOptions`；替换 design §2.1 表中全部站点（豁免站点加 posix-by-contract 注释）。
- **T2** `shared/platformEnv.ts` env 大小写折叠单点；接入 `sealedSubprocess.ts:18` 白/黑名单、`runtime/opencode/spawn.ts:190` delete、`claudeCode/spawn.ts:125-147`、`shared/runtimeConfigDir.ts:43-53`、`hermetic.ts:89-108` 转发去重（顺序显式化）。
- **T3** `assertArgvWithinPlatformLimit`：win32 序列化长度 vs 32767；接入 legacy `opencode run` 拼装与 `containedSpawn`；显式失败文案。
- **T4** 杀树单一权威：`util/process.ts` 扩 win32 分支（taskkill / Get-CimInstance / 存活探测）；**13 个内联 `process.kill(-pid)` 站点全部迁移**（`sealedSubprocess.ts:346` supervisor 自杀除外，注释豁免）；升级序列 win32 收敛。
- **T5** 全部生产 spawn 合入 `platformSpawnOptions()`（29 站点，机械 + 计数守卫）。
- **T6** 孤儿回收/boot reaper/`isProcessAlive` 接权威；`orphans.ts:188-190` win32 例外注释 + D20 登记。
- **T7** `POST /api/daemon/shutdown`（RouteMeta：admin + `tokenAccess:'never'`）+ `cli/stop.ts` win32 HTTP→轮询→taskkill 回退；POSIX 路径零改动断言。
- **T8** 单实例锁 win32 用例（重复 start / stale 回收）；`agentLaunchReservation.ts:9` 措辞修正。
- **T9** 本 PR 测试：设计 §12 第 1 层纯函数全套（含变异实证）+ 第 2 层 POSIX 零漂移断言 + win32-gated 真实行为用例（dormant）。

## PR-2 · L3 收口 + L4 opencode 链路

- **T10** guidance win32 分支（zh/en）+ `task.ts:1868-1875` 409 文案 capability-driven 化（guidance 单一来源）+ `cli/sandbox.ts` / `cli/doctor.ts` win32 输出（D19 的 mode 检查跳过并明示）。
- **T11** `binarySnapshot.ts:190-191` win32 复核条件改 `digest+size+mtime`；`.cmd/.bat` 拒绝（D17 前置：`resolveWindowsCommand` 助手落地）。
- **T12** `buildHermeticServerEnv` win32 形态（design §5.2 键表）+「无意外继承键」对照断言。
- **T13** 受控 config win32 不写 `shell` 键；`executionIdentity.ts:191-193` 平台分支断言；provider 路径 win32 不可达性测试（注入平台）。
- **T14** D17 接入：`mcpProbe` 对 `.cmd/.bat` 定向拒绝 + 文案；`pluginInstaller` npm shim 解包（唯一自动解包点）。
- **T15** claude-code runtime win32 缝核对（credentials 路径 / uid 分支 / netless 降级）+ 冒烟用例。
- **T16** i18n 双语全量 + 相关覆盖棘轮更新（`i18n-key-resolution`、parity、guidance 快照）。
- **T17** AC-9 守卫：两条 Windows provider contract test 保持绿的显式回归（放进本 PR 的必跑集）。

## PR-3 · L5 git

- **T18** NUL 站点切换（`util/git.ts:1447,1948` + env 3 处）。
- **T19** `hardenedGitLeadingArgs` win32 追加 `-c core.longpaths=true` + 硬化既有 8 用例的 win32 腿。
- **T20** 凭据子命令化（D11）：`__git-credential` 隐藏子命令 + `-c credential.helper=!…` 引号形态；三平台统一切换；一次性文件/redact 链路不变的回归；**引号规则专项验证用例**（CI windows + 真机双档，design §13.3 的回退方案预案注释）。
- **T21** doctor 增 ssh/git 前置探测提示；README 前置清单。

## PR-4 · L6 脚本节点

- **T22** 解释器平台候选表（python3→python→py；bash 走 git 推导 + 显式覆盖入口；**WSL bash 规避断言**）；探测迁 `containedSpawn`（偿还 `scriptRun.ts:75` 裸 spawn 债，audit-backlog 消项）。
- **T23** 运行 env win32 分支（USERPROFILE/TEMP/TMP/PATH/透传键/`PYTHONUTF8=1`）+ `SCRIPT_RESERVED_ENV_KEYS` 扩表（大小写折叠沿用）+ `PYTHONPATH` 剔除防线平台化回归。
- **T24** 依赖预装：pip 改 `<python> -m pip`（三平台）；npm 走 D17；win32 无 containment 的事件呈现。
- **T25** bash 缺失失败文案（win32 特化）+ 前端 Inspector hint + i18n。

## PR-5 · L7 构建发行

- **T26** `build-binary.ts`：win32→windows 映射 + `.exe`；`e2e/harness.ts` 同步；`rfc224-e2e-compiled-seam` 锁更新；embed lowercase 冲突断言。
- **T27** release.yml windows-latest 腿（`shell: bash` 显式化 + glob 兼容 `.exe`）；README 下载/前置指引；`root-test-entrypoint` bun 版本钉锁随新腿更新。

## PR-6a · L8 e2e 基建（POSIX 先行全绿）

- **T28** 单一参数化 TS stub（`AW_STUB_MODE` 模式枚举 = 既有 12 个 stub 行为）+ `build:binary:e2e` 编译产出；**逐 spec 迁移对照表**（9 个 `.sh` + 3 个 `.ts` → mode 名，migration 表放本节末尾维护）；POSIX e2e 全量绿后删除旧 stub。
- **T29** `e2e/command.ts` `runSqlite` → bun:sqlite（显式 busy_timeout < 命令超时）；`root-test-entrypoint.test.ts:346-347` 锁更新。
- **T30** ci.yml `build-binary` smoke 段跨平台化（`/usr/bin/true`→自身无害子命令、`cwd:"/"`/`startsWith("/")`→path 判据、显式 `shell: bash`）——先在 POSIX 双腿验证等价。

## PR-6b · 矩阵翻开 + 基线

- **T31** ci.yml 四矩阵 job 加 `windows-latest`；backend windows 腿 opencode 全局安装验证；`root-test-entrypoint` 矩阵逐字锁全量更新（design §8.4 表）。
- **T32** win32-gated 测试激活；POSIX-only skip 全量登记 `ALLOWED_SKIP_COUNTS`（每条带理由注释）；`REQUIRED_GATE_ACTIVATIONS` 如有新 `RUN_*` 同步。
- **T33** visual workflow windows 腿 + 第三套基线 48 张（option-A：先红→artifact→人工审阅提交）；权威腿保持 ubuntu 注释明示。
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
