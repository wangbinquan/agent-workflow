# RFC-254 设计门（双路并行，2026-08-04）

对抗式设计门，评审对象为本 RFC 三件套（提交 `144c00f4`，**无代码 diff**，故按路径直接读盘评审，
天然不受 `docs/dev-gotchas.md:110`「共享树并发 diff 吞掉 review」影响）。

**两条独立路径**（RFC-240/253 先例）：

- **Codex**（companion `task`，措辞为中性的「技术契约一致性评审」以避开 RFC-253 第一轮实现门撞上的 provider 安全过滤）：判定**不通过**，7 条事实错误 + **6 × P0** + 8 × P1 + 2 × P2。评审基线 `2ac60ef9`（含并发 session 的 RFC-255 WIP，未触碰）+ opencode checkout `cb562b2c`。
- **独立子代理**（全新上下文、对抗式 prompt）：判定**不通过**，8 条事实错误 + 1 × P0 + 7 × P1 + 7 × P2。

两路在核心问题上高度一致（下表标 ★ 者为两路独立命中），交叉验证可信度最高。
**逐条实读源码核实后：属实 24 条，驳回 1 条（附证据），计数类订正 8 条。**

---

## 0. 两路一致命中（★，可信度最高）

| # | finding | 核实结果 |
|---|---|---|
| ★1 | **AC-11 名不副实**：编译 e2e 件用 `--define=AW_E2E_UNVERIFIED_OPENCODE=true`（`build-binary.ts:312`）⇒ `markProductionOpencodeCommand` 直接 return 不打标（`util/opencode.ts:40-41`）⇒ driver 走 legacy argv 分支（`driver.ts:112-119`）⇒ **e2e 永远到不了 verified 计划**，且 `rfc224-e2e-compiled-seam.test.ts:28` 正锁着这条隔离 | 属实。AC-11「CI 用编译 stub 测 verified 全链路」按现有缝**不可实现** |
| ★2 | **D10 shutdown 认证不可用**：`.daemon.info` 只有 `{pid,host,port,url,startedAt}`（`daemonInfo.ts:15-21`、`start.ts:895-903`），**没有 token**；且 bootstrap 后 daemon token 被拒（`session.ts:171`）、`tokenAccess:'never'` 明确阻止令牌调用（`registry.ts:164`）、admin 身份仍需会话、主服务还可能绑非 loopback（`start.ts:531`） | 属实。我写的「读 .daemon.info url + 本地 token」= 凭空 |
| ★3 | **D11 askpass 迁移丢 host 绑定**：现 helper 带 host 匹配（`gitCredential.ts:23-41`，impl-gate P0-2 明写「防恶意 submodule remote 收割 PAT」）；我只承诺「一次性文件生命周期 + redact 不变」，**未列 host-bind 为迁移义务** ⇒ 照文档实现即安全回归。且 `credential.helper` 是**追加**语义、本仓 daemon 侧 git 有意不隔离 system/global 配置（`gitHardening.ts:21`），Git for Windows 默认启用 GCM ⇒ 会抢答/弹窗 | 属实 |
| ★4 | **平台站点清单名不副实**（三类都漏）：PATH 冒号拼接实为 **7 处**（漏 `scriptDepsEnv.ts:199` 直接决定 AC-19、`runtime/opencode/models.ts:64`、`runtime/mcpTestExecutionMaterial.ts:203`）；`startsWith(root+'/')` 漏 `pluginInstaller.ts:563`（GC 判定 ⇒ win32 **误删被引用的插件 generation**）与 `systemAgentRun.ts:208`（`assertSafeSeedPath` ⇒ win32 **拒绝一切合法 seed 路径**）；kill 清单错 2 漏 4 | 属实。**后两处是真实功能破坏，不只是清单不全** |
| ★5 | **遗漏子系统**：备份/恢复/归档（`util/archive.ts:5-6` 注释自认「the only shipped targets」+ backup/restore/rawDbSnapshot/worktreeBackup 四消费方 + `start.ts:600` 定时备份）、SCIP indexer（`deep/indexers.ts:102,122`）、记忆蒸馏、定时任务——三份文档零提及 | 属实，违反我自己写的 D20 |
| ★6 | **§8.4 守卫清单不全**：漏 `rfc224-source-guard.test.ts:191,205-207`（读四 workflow + 精确断言 `opencodeInstallTargets(ci)===['latest','latest']`）、`e2e-sqlite-fixture-lock-contention.test.ts`（整条锁的对象就是 `runSqlite` 的 sqlite3 CLI busy_timeout，D15 迁走后失去对象）。Codex 另点名 `e2e-shell-stub-argv-contract.test.ts:60`、`rfc205-git-credential.test.ts:45`、`rfc208-boot-and-external-timeouts.test.ts:120`、`rfc227-source-guard.test.ts:51`（还保护 `verifiedManifest.ts`） | 属实，共漏 6 条 |
| ★7 | **AC 可证伪性系统性不足**：AC-1/2/4 依赖实施者维护的 grep 清单，而**清单本身已错** ⇒ 实现与测试共享同一个错误 oracle（本仓 RFC-247 犯过三次的同型错误） | 属实 |
| ★8 | **D13 无注入缝**：`verifiedPlan.ts` **零** platform 输入，且被 `rfc233-containment-source-guard.test.ts:38-48` 禁读 `process.platform`（`rfc227-source-guard.test.ts:51` 另保护 `verifiedManifest.ts`） | 属实 |

---

## 1. P0（全部属实，全部需改设计）

### P0-A（子代理独有）· 受控 PATH 无 git ⇒ 核心工作流不成立

`hermetic.ts:547` POSIX 侧是 `/usr/bin:/bin`，而 `git` 就在 `/usr/bin/git` ⇒ **POSIX agent 的 git 是白拿的**。
我给 win32 设计的表（`System32` / `SystemRoot` / `Wbem` / `WindowsPowerShell\v1.0`）**不含任何 git 目录**
⇒ agent 进程内 `git status/diff/commit` 全部 `'git' is not recognized`，Code→Audit→Fix 主线直接断。
连带 opencode 自己的 `gitbash()` 靠 `which("git")`（opencode `core/src/shell.ts:126`）也失败。
**AC-11/AC-14 都测不到**（AC-14 测的是 daemon 侧 git argv，不是 agent 进程内 git 可达性）。

### P0-B（Codex）· verified 生产链路的 POSIX 资产远不止 `config.shell`

我的 D13 只处理了 `shell` 键。实际 win32 上会在**构造/启动阶段**失败的还有：

- `verifiedPlan.ts:99,528` 无条件读 `process.env.HOME`，缺失即拒绝（Windows 原生常只有 `USERPROFILE`）；
- `verifiedPlan.ts:724` 仍物化 seal 内 sh wrapper；
- `verifiedSystemPlan.ts:170`、`verifiedMcpTestPlan.ts:220` 写 `/bin/false`；
- 多条 snapshot 目标丢 `.exe` 后缀（`verifiedPlan.ts:440`、`verifiedSystemPlan.ts:140`、`verifiedMcpTestPlan.ts:172`）。

⇒ 需要一套**完整的 win32 verified artifact layout**，而不是只改 business plan 的一个键。

### P0-C（Codex）· verified store/identity 的信任证明依赖 POSIX mode / inode / `O_NOFOLLOW`

D19 只处理了 `binarySnapshot`。实际散布在：`verifiedManifest.ts:309`、`controlProtocol.ts:185`、
`storeHygiene.ts:328`、`sealedInputs.ts:196,265`、`sourceGuard.ts:125`（exact `0600`/`0500`、`dev`/`ino`、`O_NOFOLLOW`）。
Windows 上这些值**既可能拒绝合法文件，也可能给出错误的安全证明**（NTFS 经 Node 的 `ino` 不稳定；
mode 位无意义；`O_NOFOLLOW` 不覆盖 reparse point）。
⇒ 需要**单一的跨平台 verified-storage 信任原语**（Windows 侧核对 owner/DACL、reparse point、文件 identity、安全打开语义）。

### P0-D（Codex）· **Job Object 不是可延后项，它是 v1 正确性的必要条件** ⚠️ 改变用户决策前提

`verifiedLauncher.ts:206` 以**进程组**为所有权单位；`:928` `stopServer` 只在 child settled **且 group 不存活**后才认为已停；
`:1237` 随即标记 reaped、清理并**释放 SQLite store 供复用**。
我的 D9 把 win32 的 `isGroupAlive` 降级为单 PID 探测、并自认「taskkill 是枚举式、有竞态窗口」
⇒ **会在后代仍持有 store 时错误宣称已回收并释放复用** = 数据损坏面，不是纵深防御问题。

**这与 D1「v1 不做 provider」的用户决策不冲突**（Job Object 用于**进程生命周期治理**，不是 containment 隔离），
但它**改变了 D9 的技术前提**：用户批准 D1 时我的表述是「进程树杀灭用 Windows 原生机制做对」，
而正确的「做对」就是 Job Object kill-on-close + 基于 Job 的存活证明，不是 taskkill 枚举。**须向用户明示**。

### P0-E（Codex）· AC-11 的编译 stub 缝（同 ★1）

需要**专门的 test-only verified protocol stub seam**（仍过 snapshot / manifest / identity / launcher / HTTP session 路径），
不能把现有 unverified artifact 改个名当 AC-11 证据。

### P0-F（Codex）· 本地 MCP 的产品策略、实现路径、AC 三者互相矛盾

- `model-child-netless-v1` **不是** failClosed profile（`containmentCoordinator.ts:28`）⇒ warn/off 下**降级直跑**而非失败（provider 为 `none` 时 `sealedSubprocess.ts:1218` 直接执行子命令）。我 design §5.5 写的「按既有判定失败」**不成立**。
- 但 `sealedSubprocess.ts:928` 又**无条件**物化 `#!/bin/sh` wrapper ⇒ Windows 上在运行前就因 shell 资产失败。我 proposal §6 AC-15 写的「原生 exe 正常」同样**不成立**。
- 两句自相矛盾，且 AC-15 只覆盖 `.cmd` 拒绝 + 远端 MCP，漏了原生 exe 的 inventory probe / 交互 runtime test / 业务 session 三条入口。

⇒ 需要产品决策：要么新增 failClosed profile 明确阻断本地 MCP，要么允许 warn/off 无隔离执行并实现 **Windows 原生 direct-child materialization**。

---

## 2. 事实错误（全部核实，1 条驳回）

| # | 文档断言 | 实际 | 处置 |
|---|---|---|---|
| F1 | §0「每次 admission 落 `['platform-unsupported','required-capability-missing']`」 | 只对 **warn + 普通 profile** 成立。`off` 普通 profile 返回 `[]`（`containmentCoordinator.ts:688,731`）；failClosed 在 `off` 下多一条 `containment-mode-off`（`:783`） | 改；AC-7 的 warn 子句可保留 |
| F2 | `cli/start.ts:175-178` 是 soft-startup 注释 | 实际在 `:217`（`:175-178` 是 Git 版本门） | 订正 |
| F3 | `/dev/null` 锚点 `util/opencode-models.ts:88` | 实为 `services/runtime/opencode/models.ts:88`；`util/opencode-models.ts` 是**另一个真实文件**，其组杀在 `:55,:76`（`:150` 是普通 `proc.kill`） | 订正（两个文件都要改，我把它们混成了一个） |
| F4 | 内联 `process.kill(-pid)`「13 个站点」 | **13 个文件 / 22 处调用**，扣两处 supervisor 自杀（`sealedSubprocess.ts:348` **与 `fffCapability.ts:516`**，我只列了前者）后 **20 处需迁移**。且 `containedSpawn.ts:178` 与 `cli/sandbox.ts:62` **已走权威 / 根本不是组杀** | 订正（工作量写错） |
| F5 | 「全部生产 spawn 29 处」 | 治理面 **28**：26 个 `Bun.spawn/spawnSync` + `pluginInstaller.ts:600`（node child_process）+ `deep/runner.ts:20`（注入式默认 spawn）。29 无法从源码复现 | 改为「以守卫实测为准」，不写死计数 |
| F6 | PATH 冒号拼接 4 处 / `startsWith(root+'/')` 4 处 / env 大小写 5 处 | 分别为 **7 / 6 / 7** 处（见 ★4；env 另漏 `runtime/opencode/spawn.ts:197`、`claudeCode/spawn.ts:380`；`DANGEROUS_ENV_NAME` 已带 `/i`，plan T2 对黑名单是冗余表述） | 订正 |
| F7 | 视觉基线「48 场景」 | 两个 spec 明示 **31 + 9 = 40 个场景**（`visual-regression.spec.ts:42`、`rfc250-visual-states.spec.ts:21`），文件系统每平台 **46 个 PNG**（部分场景多截图） | 订正为「40 场景 / 46 张」 |
| F8 | proposal AC-22 引用 `design §9.5` | 清单在 **§8.4** | 订正 |
| F9 | design §8.4「backend shard `--shard=` 出现次数 2→3」 | 当前的 `2` 是**两种 YAML 命令文本**的出现次数，不是 OS 腿数（`root-test-entrypoint.test.ts:205`） | 订正 |
| F10 | opencode 锚点 `script/build.ts:100-112` / bunfs `:127` | win32 target 从 `:102` 起；bunfs 根在 **`:161`** | 订正 |
| F11 | 「opencode serve 纯 TCP loopback」 | 默认 hostname 是 `127.0.0.1`，但 config/mDNS 路径允许 `0.0.0.0`（`cli/network.ts:12,62`、`server/server.ts:117`）——「纯 loopback」是我们**配置出来的**，不是源码保证 | 改措辞 |
| F12 | opencode 版本「v1.18.4」 | `package.json` 确为 1.18.4，但该 commit 无对应 tag ⇒ 应同时记 commit SHA `cb562b2c` | 补 |
| **F13** | **「官方口径：可原生跑，推荐 WSL」** | **驳回。** 依据确凿存在：`packages/web/src/content/docs/windows-wsl.mdx:8`「While OpenCode can run directly on Windows, we recommend using WSL...」+ `index.mdx:93-95`「Recommended: Use WSL」。Codex 只查了 `README.md` 就断言「checkout 内没有源码依据」 | **不改**，补精确锚点 |

**另有两条我自查确证、两路评审都没提的**：

- **F14**：D6/R5 称 pin 的 Bun 无 windows 交叉目标 ⇒ **错**。本机实测 `bun build --compile --target=bun-windows-x64` 与 `--target=bun-windows-arm64` 均成功产出合法 PE32+（x86-64 / Aarch64）。坚持 windows runner 原生构建的真实理由是**仓库既定的不交叉编译方针 + 构建冒烟要真的执行产物**，不是工具链缺失；R5（arm64）因此是政策问题而非能力问题。
- **F15**：windows-2025 runner 预装 Python 3.12.10 / Node 22.23.1 / Git 2.55（Git Bash 在 `C:\Program Files\Git\bin\bash.exe`），但**不预装 sqlite3 CLI** ⇒ D15 从「顺手清理」升级为**硬性前提**；且 runner 上还有 MSYS2 的第二个 `bash.exe`（`C:\msys64\usr\bin\bash.exe`，不在 PATH）⇒「从 git 推导、绝不裸 `which('bash')`」又多一条理由。

---

## 3. P1（全部属实）

1. **守卫形态必须改**（★7 的处置）：AC-1/2/3 的守卫要写成**全仓禁形态负向扫描 + 显式豁免注释白名单**，不是按 design 表逐站点 grep；否则实现与测试共享同一份错误清单。计数一律由守卫实测产出，不写死在文档里。
2. **D16 stub 合并缺行为等价保护**：现有 stub 副作用差异巨大（`stub-opencode.sh:20` version/nonce/workgroup/inventory 分支、`stub-opencode-clarify-inline.sh:33` round/session 状态、`stub-opencode-commit.sh:26` 按 prompt 判角色并写 `e2e-change.txt`、`stub-opencode-workflow-matrix.sh` prompt 断言/上传/重试退出码/timeout、`intent-workflow-opencode.sh` 先写变体 env 再 exec）。⇒ **实现前冻结逐文件契约**（mode/version/argv/env/stdout/stderr/exit/sleep/副作用/对应 spec），删旧 stub 前在 POSIX 跑**差分 golden transcript**；不得让实现者事后填同一张表当验收 oracle。
3. **D14 守卫落点不足**：verified prompt 不走 argv 判断正确（`verifiedManifest.ts:369` argv 只有 manifest 路径、`verifiedPlan.ts:759` + `verifiedLauncher.ts:822` 走 HTTP body），但守卫只接 legacy + `containedSpawn` 不够，须落在**每个 process-creation authority（含 `runGit`、doctor、archive、indexer）**；序列化须与 Bun/libuv 的 Windows quoting 规则一致并计入 executable、NUL、`windowsVerbatimArguments`；**边界测试必须用真实 Windows 子进程**，不能让手写 serializer 与单测共享同一错误算法。
4. **D11 需完整可执行契约**：`credential.helper=!…` 是 shell snippet 且追加 `get/store/erase`、字段走 stdin（`gitcredentials.7:338,378,455`）⇒ 隐藏子命令必须解析 operation + stdin 协议，只在精确 host/path 的 `get` 返回，`store/erase` 静默成功；接线处先 `-c credential.helper=` 置空再追加；路径 quoting 需覆盖空格/单引号/反斜杠；真机须测递归 submodule + host mismatch + 含空格安装路径。
5. **AC 逐条重写**（★7）：每个 AC 要有**独立于实现算法的 observable oracle**；无法自动化的项明确要求原始日志/产物证据（真机记录至少含机器版本、命令、产物 hash、原始结果）。AC-3 的 mock argv 只证明调了 taskkill，不证明后代被回收也不证明 store 未提前释放；AC-16 在 proposal 是验收项但真机表写「若机器有凭据」（`plan.md:111`）⇒ 要么给凭据 fixture 要么明确改成条件项；AC-20 的 build 与 harness 共享同一后缀 helper ⇒ 可能一起错，须实际编译并执行 `.exe`；D14 完全没有独立 AC/追踪行。

## 4. P2

1. **helper API 与「三平台注入测试」自相矛盾**：`NULL_DEVICE` 常量与无 platform 参数的 `pathListJoin`/`isLexicallyInside`/`platformSpawnOptions` 会绑定测试机当前 OS ⇒ Linux CI 无法真实执行 win32 分支。改为接 `platform` 参数或导出以 platform 为参数的纯 factory，生产入口再冻结当前平台。
2. **Windows 仓库可检出性边界**：D18 只讲 MAX_PATH。含保留设备名（`con`/`aux`/`nul`…）、尾随点/空格、仅大小写不同的路径在 NTFS 上仍会让 `git worktree add` 直接失败，当前只归一成 `worktree-add-failed`（`util/git.ts:945`）⇒ 落档为平台兼容限制 + 定向错误分类，不得把 `core.longpaths=true` 写成全部 checkout 兼容性的解决方案。
3. `OPENCODE_CONFIG_CONTENT` 单 env var 在 win32 的尺寸行为未讨论（受控 config 可超 32KiB，`driver.ts:220` 仅 warn）⇒ windows CI 加一条「大 config env 注入」回归。
4. `mcpProbe.ts:443-449` 走 SDK 的 `StdioClientTransport`（node child_process 系），不是本仓 `Bun.spawn` ⇒ D17 拦截应落在 `command[0]` 预检层，机制描述须校正。
5. opencode 已有 `OPENCODE_GIT_BASH_PATH`（`core/src/shell.ts:125`）⇒ §7.1 自造 `AW_GIT_BASH_PATH` 时应说明两者关系（同名转发或说明为何不）。
6. SCIP indexer 的 `.cmd` 死角（`deep/indexers.ts:122` 裸 `Bun.spawn`）+ `deep/runner.ts:36` 超时只 kill 直接进程 ⇒ 静默降级为 `build-failed/timeout`，属 D20 应列的可见降级。
7. 前端 `launch-repo-source.ts:245` 的 `Math.max(lastIndexOf('/'), lastIndexOf(':'))` 对 `C:\dev\repo` 形态会切出错误 basename（未确证该输入面是否可达）。

---

## 5. 结论与对本 RFC 的影响

**两路判定均为不通过，findings 除 F13 外全部属实。** 主体框架（L1–L8 分层、containment 判定零改动、
D13/D14/D17/D19/D20 原则、对 opencode/multica 的行为引证）经两路核实**大多站得住**；
问题集中在三处，且都在**最难、最安全敏感的核心**：

1. **verified 执行链路的 Windows 形态被我严重低估**（P0-B + P0-C + P0-F）——不是「不写一个 shell 键」，
   而是 artifact layout、信任原语、子进程物化三层都要设计。
2. **进程治理的正确性门槛比我写的高**（P0-D）——Job Object 是 v1 必需，taskkill 枚举不足以支撑
   store 回收证明。**这改变了用户批准 D1 时的技术前提，必须回报用户。**
3. **「全量清单」名不副实**（★4 + ★7）——而且清单错误会直接传导成实现缺陷与假绿测试，
   处置是把守卫改成全仓负向扫描、计数由守卫产出。

**本 RFC 据此整体修订后重新请批；修订前不进入实现。**
