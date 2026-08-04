# RFC-254 · Windows 原生执行支持 —— 技术设计

> 决策编号（D1–D20）见 `proposal.md §5`。本文锚点均以仓库当前 HEAD（2026-08-04）为准；opencode 锚点以本机 checkout v1.18.4（`packages/opencode/package.json:3`）为准。

## 0. 既有锚点（研究结论索引）

**准入核心（不动）**：

- Profile 注册表 `containmentCoordinator.ts:28-79`（`runner-filesystem-v1` / `model-child-netless-v1` / `outer-readonly-v1` / `outer-netless-v1`，后两者 `failClosed`）；能力词表 `:232-243`；reason codes 含 `platform-unsupported`（`:92`）。
- 无 provider 平台的现状行为（win32 已验证路径）：`probeSandboxMechanism` → `{mechanism:null}`（`sandbox/probe.ts:72`）；组装根 else→null（`containmentComposition.ts:35`）；daemon **正常启动**（`cli/start.ts:175-178` "Startup always remains soft"）；每次 admission 落 `['platform-unsupported','required-capability-missing']`；`warn`=degraded 放行 + 每任务一条 `sandbox-degraded` 告警（`runner.ts:1406-1419`）；`enforce`=blocked（任务启动 409 `sandbox-unavailable`，`task.ts:1866-1875`）；failClosed profile 三模式全拒（`containmentCoordinator.ts:687,793-800`）。**这套语义就是 D1 要的，本 RFC 只做呈现收口，不改判定。**
- Windows provider 接缝（保持绿）：`registerNetlessSubprocessProvider`（`sealedSubprocess.ts:80-98`）；contract tests `rfc233-containment-coordinator.test.ts:206-274`（`windows-appcontainer-v1`）、`rfc227-containment-provider.test.ts:63-105`（`windows-job-object-fixture`）。RFC-227 §5.3（design.md:271-286）列明未来 provider 义务。

**opencode（上游事实，均为 v1.18.4 源码）**：

- Windows 一等公民：`script/build.ts:100-112` 三个 win32 target、`:127` bunfs 根 `B:/~BUN/root/`、publish workflow Azure 签名（`.github/workflows/publish.yml:120-163`）；CI windows-2025（`test.yml:28-34,83-92`）。
- shell 无需 POSIX：`core/src/shell.ts:98-106` 候选 `pwsh → powershell → gitbash → COMSPEC/cmd.exe`；`:119` `select()` 兜底 `win()[0]`；gitbash 从 `which("git")` 推 `../../bin/bash.exe`（`:123-130`），**不裸找 `bash`**（避开 System32 的 WSL 启动器）。
- 配置目录 = XDG-in-USERPROFILE：`core/src/global.ts:1-31` + `xdg-basedir@5`（无平台特化）→ `XDG_*` 环境变量在 **任意平台**都被认；`os.homedir()` 在 win32 读 `USERPROFILE`。`OPENCODE_CONFIG_CONTENT` 合并顺位与 POSIX 同形（`config/config.ts:361-534`）。
- `serve` 纯 TCP loopback（`server/server.ts:117-214`），无 unix socket。
- 进程终止：win32 走 `taskkill /pid <pid> /T /F`（`cross-spawn-spawner.ts:297-305`、`util/process.ts:147-156`）；**MCP 子孙清理在 win32 是 no-op**（`mcp/index.ts:419-421`）。
- 已知弱项：FFF 在 win32 默认关（`flag.ts:34`）；PTY/自身 worktree 端点/snapshot 测试在 win32 skip；官方口径「可原生跑，推荐 WSL」。

**Bun（本仓 pin 1.3.13）**：`Bun.spawn` 支持 `detached`（win32 = UV_PROCESS_DETACHED）、`windowsHide`、`windowsVerbatimArguments`（`bun-types/bun.d.ts:6688-6701,6878-6883`）。

**multica（参考仓实战）**：`.cmd` shim 会截断 argv → 解析原生 exe 直接 spawn（`server/pkg/agent/opencode.go:396-418`）；Windows 无进程组 → `TerminateProcess`/taskkill；隐藏 console 防弹窗风暴（`proc_windows.go`，CREATE_NEW_CONSOLE + HideWindow，upstream issue #1521）。

**本仓工作面**（四份研究报告的收敛，详见各节）：spawn 咽喉 4 处（`sandbox/index.ts:100/146`、`runner.ts:1490`、`execution/containedSpawn.ts:221`、`util/git.ts:138`）+ 25 处外围 spawn；进程组/信号 14 文件；env 大小写语义；`/dev/null`×5、PATH `:` 拼接×4、`lastIndexOf('/')`×1、`startsWith(root+'/')`×4；CI 被 source-lock 逐字锁定。

## 1. 分层与原则

```
L1 跨平台地基     平台常量/纯函数单点：NULL_DEVICE、PATH delimiter、env 大小写折叠、argv 限长
L2 进程治理       spawn 选项、杀树、pid-reuse 防护、孤儿回收、优雅关停、单实例锁
L3 containment 收口  无 provider 的诚实呈现（判定零改动）
L4 opencode 链路   seal / 受控 env / shell / 身份断言 / MCP / 插件 / claude-code
L5 git            NUL、longpaths、凭据子命令化
L6 脚本节点       解释器探测链 / env / PATH / 失败呈现
L7 构建发行       build-binary / release / README
L8 CI 全矩阵      四 job + e2e stub 编译化 + sqlite fixture + 视觉第三套 + source-lock
```

原则：

1. **平台判断收口在少数单点**。containment 子系统维持「源内禁读 `process.platform`、走注入参数」的既有约束（`rfc233-containment-source-guard.test.ts:47`）；新增平台分支优先落在已有注入缝（probe/composition/doctor/start 均已接受 `platform` 参数）。
2. **语义缺失必须可见**（D20）。Windows 上做不到的保护一律「跳过 + 呈现」，绝不静默视同已保护（RFC-253 F1/F2 教训）。
3. **单实现优于双分叉**。能消灭 POSIX 依赖的（askpass 脚本、e2e sh stub、sqlite CLI）就统一成跨平台单实现，而不是每处维护两套（D11/D15/D16）。

## 2. L1 · 跨平台地基

### 2.1 平台执行常量与助手（新 `packages/backend/src/util/platformExec.ts`）

```ts
export const NULL_DEVICE: string                       // win32 'NUL'，否则 '/dev/null'
export function pathListJoin(dirs: string[]): string   // 用 node:path 的 delimiter
export function isLexicallyInside(root: string, p: string): boolean  // sep 感知，替换 startsWith(`${root}/`)
export function platformSpawnOptions(): { windowsHide?: true }        // win32 恒 windowsHide
```

替换站点（全量）：

| 类别 | 站点 |
|---|---|
| `/dev/null` → `NULL_DEVICE` | `util/git.ts:1447,1948`（`git diff --no-index`）；`hermetic.ts:569`、`util/opencode-models.ts:88` 的 `GIT_CONFIG_GLOBAL`（`fffCapability.ts:345` 为 Linux provider 专属路径，常量化但行为不变） |
| PATH `:` 拼接 → `pathListJoin` | `services/scriptRun.ts:159`；`hermetic.ts:545` 与 `verifiedPlan.ts:153`、`claudeCode/netlessMcp.ts:60` 的 `FIXED_NETLESS_PATH`（后两处 provider 专属，win32 不可达，仍统一） |
| `lastIndexOf('/')` → `dirname()` | `services/scriptRun.ts:158` |
| `startsWith(root+'/')` → `isLexicallyInside` | `verifiedPlan.ts:425,554`、`verifiedSystemPlan.ts:133`、`verifiedLauncher.ts:480` |
| 豁免（posix-by-contract，加注释不改） | git 输出解析（`util/git.ts:789,796,1610,2782`、`util/diffSplit.ts:143-145`——git 在 win32 也输出 `/`）；embed URL 路径（`scripts/build-binary.ts:131,162,171,181` 已显式 posix 归一） |

`util/safePath.ts:25-33` 拒反斜杠相对路径的前瞻防线**保持**（它守的是跨机器传输的 repo-relative 路径，语义仍然正确）。

### 2.2 env 键大小写折叠单点（新 shared 纯函数 + 全站点接入）

Windows 的进程环境块键**大小写不敏感**；本仓现有精确匹配存在安全语义漏洞面：

- `SAFE_ENV_NAME` 要求全大写（`sealedSubprocess.ts:18`）→ win32 下 `Path`/`Temp` 被静默丢弃；
- `buildOpencodeEnv` 的 `delete env.OPENCODE_PERMISSION`（`runtime/opencode/spawn.ts:190`）删不掉 `OpenCode_Permission` 形态的键；
- `CLAUDE_INTERNAL_ENV_MARKERS` Set 精确匹配（`claudeCode/spawn.ts:125-147`）同理；
- `RESERVED_SPAWN_ENV`（`shared/runtimeConfigDir.ts:43-53`）同理；
- 唯一做对的先例：`shared/scriptNode.ts` 保留键用 `key.toUpperCase()` 比较（`:449-491`）。

设计：`packages/shared/src/platformEnv.ts` 提供

```ts
export function canonicalEnvKey(key: string, platform: NodeJS.Platform): string  // win32 → toUpperCase，否则原样
export function envRecordDelete(env, keys, platform)   // 折叠匹配删除（返回新对象）
export function envRecordHas / envRecordGet(...)
```

接入点：上列 5 处 + `hermetic.ts:89-108` `SAFE_FORWARD_ENV` 转发循环（win32 下大小写重复的 proxy 键折叠去重，**后写覆盖前写的顺序显式固定**）。受控 env 因「从零构建」天然收敛，接入折叠后不存在混合大小写冲突。

测试：平台参数直测（win32 语义在任何 OS 上可跑）；每个接入点一条「混合大小写键在 win32 被命中/被删」的回归；POSIX 语义逐字节不变（大小写敏感平台折叠函数为恒等）。

### 2.3 argv 长度守卫平台化（D14）

Windows `CreateProcess` 的命令行是**单一 UTF-16 字符串，总长 ≤ 32767**；POSIX 限制是单元素 128KiB（Linux `MAX_ARG_STRLEN`）与总量 `ARG_MAX`。现状 `MAX_OPENCODE_PROMPT_BYTES = 120*1024`（`runtime/opencode/spawn.ts:69-73`）只按 POSIX 单元素上限设计。

- verified 生产路径 prompt 走直接 API HTTP body，**不受 argv 限制**——不动。
- 真正走 argv 的路径（legacy/test `opencode run` 拼装、`containedSpawn` 的脚本 argv、git argv）：新纯函数 `assertArgvWithinPlatformLimit(argv, platform)`，win32 按「引号转义后序列化长度对 32767」计算，POSIX 维持现有判据。纯计算、无阻塞探测（impl-gate 经验：spawn 前不得新增阻塞探测）。
- 超限失败必须带明确码/文案，不允许晦涩的 spawn ENOMEM/EINVAL。

## 3. L2 · 进程治理

### 3.1 杀树单一权威（`util/process.ts` 扩展 + 全站点归一）

现状：`killProcessTree(pid, sig)` = `process.kill(-pid, sig)`（`util/process.ts:32-45`），且 **13 个文件在各自内联同样的 `process.kill(-pid)`**（`runner.ts:2688-2701`、`containedSpawn.ts:178-186`、`memoryDistiller.ts:987`、`runtimeSmoke.ts:99`、`verifiedLauncher.ts:218-241`、`opencodeStoreRecovery.ts:118`、`util/git.ts:179-181`、`util/opencode.ts:159-166`、`util/opencode-models.ts:146`、`cli/sandbox.ts:60-67` 等）。

设计：

1. `util/process.ts` 成为**唯一**杀树/存活探测权威：
   - `killProcessTree(pid, sig)`：POSIX 行为不变；win32 → `Bun.spawnSync(['taskkill','/pid',String(pid),'/T','/F'], {windowsHide:true, timeout})`，sig 参数在 win32 无差别（TERM/KILL 均为强杀——与 opencode `cross-spawn-spawner.ts:297-305`、multica `proc_windows.go` 同模式）。失败回退 `process.kill(pid)`（单进程 TerminateProcess）。
   - `isGroupAlive(pid)`：POSIX `process.kill(-pid,0)`；win32 用单 pid 存活探测（组概念不存在，语义降级注释明示）。
   - `pidCommandLine(pid)`（替换 `pidCommandLooksLikeAgentChild`/`pidCommandContainsBinary` 的 `ps -p` 内核，`util/process.ts:59-85`）：POSIX 保持 `ps`；win32 → `powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=<n>').CommandLine"`，bounded timeout；`wmic` 不用（新 Windows 已移除）、`tasklist` 不用（无命令行列）。
2. **内联组杀全部迁移到该权威**（机械重构 + 逐站点回归锁）。唯一例外：`sealedSubprocess.ts:346-354` `killCurrentProcessGroup`（bwrap supervisor 自杀，Linux provider 专属路径，win32 不可达，不动）。
3. SIGTERM→grace→SIGKILL 升级序列（`util/process.ts:111-153`、`containedSpawn.ts:286-297`）在 win32 收敛为「一次 taskkill /T /F + 存活复查」；grace 预算语义仅在 POSIX 有意义，win32 文档明示（子进程无优雅终止——上游 opencode 同样如此）。

已知限制（登记 D20 清单）：taskkill 是**枚举式**杀树，存在竞态窗口（fork-then-exit 孙进程可漏）；原子 kill-on-close 需要 Job Object，属后续 provider RFC。兜底是既有的周期孤儿回收 + 启动回收。

### 3.2 spawn 选项

- 全部生产 spawn（29 处，含 4 个咽喉）合入 `platformSpawnOptions()`：win32 加 `windowsHide: true`（防 console 弹窗风暴，multica #1521 教训）。
- `detached: true` 维持传递：Bun win32 = UV_PROCESS_DETACHED（子进程可脱离存活；`bun-types/bun.d.ts:6688-6695`）。孤儿治理不依赖它（依赖 pid 落库 + taskkill 树杀）。
- `onSpawned` pid 立即落库契约（RFC-253，`containedSpawn.ts:246-259`）平台无关，保持。

### 3.3 孤儿回收与启动回收

- 周期回收与 boot reaper（`services/orphans.ts`、`cli/start.ts:333-360`）：判活/杀灭改走 §3.1 权威后自动获得 win32 语义；pid-reuse 防护换 `pidCommandLine` 判据。
- `orphans.ts:188-190` 的「系统 spawn 由 bwrap `--die-with-parent` 契约覆盖」证明在 win32 不成立（无 provider）→ win32 上 daemon 硬杀后**短命系统代理进程可能残活**：如实登记（D20 + audit-backlog），v1 不引入平台级子进程注册表（代价/收益不成比）。
- `isProcessAlive`（`util/process.ts:12-21`，`process.kill(pid,0)`）在 win32 可用（Node/Bun 映射 OpenProcess；EPERM 视为存活）；补 win32 CI 用例。

### 3.4 优雅关停与 stop（D10）

- daemon 内：`process.on('SIGINT')` 在 win32 可用（Ctrl+C）；`SIGTERM` 挂钩保留（win32 收不到，无害）。
- 新增 loopback 管理端点 `POST /api/daemon/shutdown`：走 RFC-247 `registerRoute` 元数据（admin 身份 + `tokenAccess:'never'`，双向穷尽自检会强制登记）；触发既有 `gracefulShutdown(db,30_000)` 序列（`cli/start.ts:819-900`）。
- `cli/stop.ts`：win32 → 读 `.daemon.info` url + 本地 token → POST shutdown → 轮询退出（预算 35s）→ 超时 fallback `taskkill /T /F`；POSIX 路径逐字节不变（SIGTERM）。
- e2e harness 关停（`e2e/harness.ts:445-479` SIGTERM→SIGKILL）：win32 分支走 stop 命令或 taskkill；daemon 优雅关停语义由专门 stop 测试覆盖，不靠 harness teardown 证明。

### 3.5 单实例锁

`util/lock.ts` 的 O_EXCL PID 文件设计已跨平台（`:1-4` 注释明示无 flock 依赖）；stale 判活走 §3.3。win32 CI 补「重复 start 拒绝 / stale 锁回收」两用例。`agentLaunchReservation.ts:9` 的过时 "flock-guarded" 措辞顺带修正。

## 4. L3 · containment 收口（判定零改动）

**不改**：coordinator 判定、profile 表、reason codes、`warn` 降级/`enforce` 拒绝/failClosed 语义——win32 现状行为即 D1 目标语义（见 §0）。`containmentMechanismForPlatform` 的 else→null 就是诚实答案。

**改呈现**：

| 站点 | 现状 | 改为 |
|---|---|---|
| `services/sandbox/guidance.ts:146-162,222` | 非 darwin/linux 输出 `不支持的平台 ${platform}` | win32 专属分支：说明「当前平台无内置隔离机制；任务在 warn/off 档不隔离运行；enforce 与脚本节点断网/只读档不可用」+ 指向 docs/sandbox.md 降级清单（i18n 双语） |
| `services/task.ts:1868-1875` 409 文案 | 硬编码 "macOS: sandbox-exec…; Linux: install bubblewrap" | capability-driven：从 guidance 模块取平台补救话术单一来源，win32 给「无 provider 可装，需降级 sandboxMode 或等待 Windows provider」 |
| `cli/sandbox.ts:227-281` | linux 才有包管理器提示 | win32 分支输出与 guidance 同源的说明 |
| `cli/doctor.ts:126-170` | `${mechanism ?? 'sandbox'}` 空洞输出 | win32 明示「无隔离机制（by design，见 RFC-254）」+ D20 降级清单摘要 |
| Settings SandboxCard | 机制名插值已开放（`chipUnavailable` 分支存在） | 仅补 i18n 文案核对，无结构改动 |

**守卫**：AC-9 两条 provider contract test 保持绿；`rfc233-containment-source-guard` 的 `process.platform` 禁令继续成立（新增平台分支全部走注入参数）。

## 5. L4 · opencode 运行链路

### 5.1 runtime binary seal（`services/runtime/binarySnapshot.ts`）

已有 win32 守卫：exec 位判定跳过（`:84-86`）、目录/快照 mode 校验跳过（`:176,183,228`）。补齐：

- `:190-191` 的 `dev`/`ino` TOCTOU 复核条件在 win32 改为 `digest + size + mtimeMs`（NTFS 经 Node 的 number 型 `ino` 不可靠）；digest 复验（`:184,195`）是主防线，保持。
- `.exe` 解析：`resolveSingleExecutable`（`:95-127`）拒含分隔符 PATH token 的规则不变；win32 下 `Bun.which` 认 `PATHEXT`，管理员填 `opencode` 或绝对 `opencode.exe` 均可。**`.cmd`/`.bat` 一律拒绝**（D17）：报错指引用户填原生 exe（npm 安装场景给出 `opencode-windows-x64` 包内真身路径提示；multica 的 shim 自动解析留作后续改进）。
- seal 在 win32 无只读位保护 → doctor + docs 明示（D20）；digest 复验兜底 TOCTOU。

### 5.2 受控 env 的 win32 形态（`hermetic.ts:528-571` 平台分支）

从零构建的白名单 env，win32 版：

| 键 | 值 |
|---|---|
| `USERPROFILE`、`HOME`、`HOMEDRIVE`+`HOMEPATH` | 私有 store home（`os.homedir()` 读 `USERPROFILE`；`HOME` 供 git-bash/移植工具；三者一致） |
| `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_CACHE_HOME` / `XDG_STATE_HOME` | 私有 store 子目录（opencode 的 `xdg-basedir` 任意平台优先认 env，`global.ts:1-31`——**私有化机制与 POSIX 完全同构**） |
| `TEMP`、`TMP`（替代 `TMPDIR`） | 私有 tmp |
| `PATH` | `pathListJoin([sealToolchainDir, %SystemRoot%\System32, %SystemRoot%, %SystemRoot%\System32\Wbem, %SystemRoot%\System32\WindowsPowerShell\v1.0])`——最后一项让 opencode 的 `powershell` 候选可达 |
| `SystemRoot`、`windir`、`SystemDrive`、`COMSPEC`、`PATHEXT` | 从 daemon env 透传（winsock/cmd 初始化依赖；`PATHEXT` 给显式默认值） |
| `OPENCODE_*` 组 | 与 POSIX 同形（`OPENCODE_CONFIG_CONTENT` 等） |
| `GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=NULL_DEVICE` | 同 POSIX（NUL） |

`SAFE_FORWARD_ENV` 转发（`:89-108`）经 §2.2 折叠。对照断言：受控 env 不含 daemon 继承的任何未列键（现有断言模式扩展到 win32 键集）。

### 5.3 shell 键与身份断言（D13 关联）

POSIX verified 计划把 `config.shell` 指向 seal 内 `sh` wrapper（`verifiedPlan.ts:530,741`）——那是 **netless provider 边界**的一部分。win32 无 provider：

- 受控 config **不写 `shell` 键** → opencode 走自身 `pwsh → powershell → gitbash → cmd` 链（`shell.ts:119`），ShellPrompt 会向模型说明当前 shell 方言（`tool/shell/prompt.ts:43-70`）。
- `executionIdentity.ts:191-193` 的 `config.shell === join(sealRoot,'shell','sh')` 断言改为平台分支：POSIX 不变；win32 断言 `shell` 键**不存在**（受控 config 是闭合构造，缺席即是身份的一部分）。
- netless wrapper 物化（`sealedSubprocess.ts:928-942` `#!/bin/sh`）、`SEATBELT_NETLESS_*`、FFF 探针全部是 provider 路径，win32 按 `childProvider:'none'` 天然不可达（`verifiedPlanCore.ts:112-119` null 分支、`verifiedManifest.ts:260-273` 非 linux-bwrap 禁 FFF 证明——**零改动**，但补一条 win32 注入平台的「不可达性」测试）。

### 5.4 直接 API / session / envelope

协议层（SSE 解析、行泵、envelope、session 归属、resume owner 比对）全部是字节/HTTP 语义，无平台面。win32 腿跑既有 32 个 RFC-224/227/251 套件中平台无关子集 + 编译 stub 的端到端（§8.2）。

### 5.5 MCP / 插件 / claude-code

- **远端 MCP**：HTTP，无平台面。
- **本地 stdio MCP**（探测 `services/mcpProbe.ts` 与 legacy 运行路径）：win32 上用户配置 `npx …` 会解析到 `npx.cmd`——CreateProcess 不直接执行 `.cmd`，且 shim 有 argv 重整形风险（multica 实证）。D17 解析助手：`resolveWindowsCommand(token)` 处理 `PATHEXT`；命中 `.cmd/.bat` → **定向拒绝**，报错文案给出改法（填原生 exe / `node <真身.js>`）。verified 路径的本地 MCP 本就走 provider 边界，win32 无 provider 时按既有「本地 MCP 需要 containment」判定失败——如实（D20）。
- **插件**：`pluginInstaller.ts:600` 以 `node:child_process` spawn `npm`——win32 经 D17 解析（`npm.cmd` → `node npm-cli.js` 直呼真身，唯一自动解包 shim 的地方，因为 npm 是我们自己的受控调用而非用户输入）；插件运行在 opencode server 进程内，win32 与 POSIX 同样不受 containment（RFC-251 已知代价，D20 清单沿用）。
- **claude-code runtime**：`claudeCode/config.ts:59` darwin→Keychain、else→`~/.claude/.credentials.json`（win32 = `%USERPROFILE%\.claude\...`，正确）；`spawn.ts:162-169` `getuid` 在 win32 为 undefined 自然走非 root 分支；netless MCP 面 provider 缺失自然降级。win32 冒烟（CI stub + 真机真 CLI，AC-16）。

## 6. L5 · git

- **NUL**：§2.1 两处 argv + env 处。
- **longpaths（D18）**：`gitHardening.ts` 的 `hardenedGitLeadingArgs`（`:94-101`）win32 追加 `-c core.longpaths=true`；README/doctor 建议系统级 `LongPathsEnabled`。硬化既有语义（hooksPath 空目录 + `core.fsmonitor=false` + `--no-ext-diff`）平台无关；`ensureGitHooksVoidDir` 的 `chmod 0o500`（`:52-56`）win32 no-op——空目录防 hook 的主机制仍成立，写保护缺失进 D20 清单。
- **凭据（D11）**：`services/gitCredential.ts` 的 `#!/bin/sh` askpass helper（`:23-41`）替换为平台自身二进制隐藏子命令（`verifiedSelfCommand` 模式，`sealedSubprocess.ts:108-115` 先例）：`agent-workflow __git-credential` 读一次性凭据文件（0600/私有目录语义按平台）。接线形态取 `-c credential.helper=!…` 引号形式（gitconfig 值经 git 的 sh 引用规则，可正确携带含空格的 exe 路径；`GIT_ASKPASS` 直连含空格路径在 win32 的引用行为不可靠）。**三平台统一切换到该单实现**；一次性文件生命周期、redact 链路不变。此处引用规则是实现期重点验证项（CI windows + 真机，plan T 列出）。
- **ssh**：`GIT_SSH_COMMAND` 假定 `ssh` 在 PATH（`util/git.ts:32-44`）——Windows 10+ 自带 OpenSSH 客户端；doctor 增探测提示。
- **worktree/stash/submodule**：git 输出 posix 分隔符（含 win32），解析零改动；临时 index 用 `join(tmpdir(),…)` 已可移植。
- **`sqlite3`/`git` CLI 前置**：README 平台前置清单（git 必装；bash 可选；ssh 可选）。

## 7. L6 · 脚本节点（RFC-253 平台化，D3）

### 7.1 解释器解析（`services/scriptRun.ts:41-100` 重构为平台候选表）

| 语言 | POSIX（现状不变） | win32 |
|---|---|---|
| python | `python3` | 候选链 `python3 → python → py`，逐个 `--version` 探测（App Execution Alias 假 python 的探测会非零退出自然淘汰）；探测经 `containedSpawn`（顺带偿还 `:75` 裸 spawn 技术债——audit-backlog 已登记项） |
| node | `node` | `node`（PATHEXT 由 `Bun.which` 处理） |
| bash | `bash` | **从 `Bun.which('git')` 推 `<git>/../../bin/bash.exe`**（opencode `shell.ts:123-130` 同构；**绝不**裸 `which('bash')`——System32 的 `bash.exe` 是 WSL 启动器，会把脚本静默跑进另一个操作系统）+ 显式覆盖入口（设置项 `scriptBashPath` 或 env `AW_GIT_BASH_PATH`，择一，plan 定）；探测不到 → 启动期失败，失败码复用 RFC-253 解释器缺失码，文案 win32 特化（「安装 Git for Windows 或显式指定 bash 路径」） |

探测结果（版本、路径）入 node_run 事件（现状机制）。

### 7.2 运行 env（`scriptRun.ts:155-170` 平台分支 + 保留键表扩展）

- win32：`USERPROFILE`/`HOME`/`HOMEDRIVE`+`HOMEPATH` → run 私有 home；`TEMP`/`TMP` → run 私有 tmp；`PATH` = `pathListJoin([interpreterDir, System32, SystemRoot, Wbem, WindowsPowerShell\v1.0])`；透传 `SystemRoot`/`SystemDrive`/`COMSPEC`/`PATHEXT`；**`PYTHONUTF8=1`**（Windows Python 默认 legacy code page，会破坏「stdout 即端口值」的 UTF-8 契约）。
- `SCRIPT_RESERVED_ENV_KEYS`（`shared/scriptNode.ts:449-491`，已大小写折叠）追加：`USERPROFILE`、`HOMEDRIVE`、`HOMEPATH`、`APPDATA`、`LOCALAPPDATA`、`SYSTEMROOT`、`SYSTEMDRIVE`、`WINDIR`、`COMSPEC`、`PATHEXT`、`PYTHONUTF8`。`PYTHONPATH` 剔除防线（STATE.md 记录的实测缺陷①）在 win32 同样生效，回归锁平台参数化。
- `network:'deny'` / `readonly:true`：failClosed 语义在 win32 天然拒绝（§0），前端作者可见原因沿用 RFC-253 文案体系 + guidance 指引（AC-8）。

### 7.3 依赖预装（`services/scriptDepsEnv.ts`）

- pip 改 `<resolvedPython> -m pip`（避开 `pip.exe` 路径/多版本歧义，三平台统一）；npm 经 D17 解析真身。
- 安装器 containment：win32 无 provider → 与业务 spawn 同为未隔离（第二轮实现门修的「安装器必须进 containment」在有 provider 平台继续成立；win32 的缺失进 D20 清单与事件呈现）。

## 8. L7/L8 · 构建、发行、CI

### 8.1 build-binary（`scripts/build-binary.ts`）

- `platformSuffix`（`:76-80`）：`win32 → 'windows'`，产物 `agent-workflow-windows-x86_64.exe`（含 e2e 件同后缀）；`e2e/harness.ts:95-104` 同步（一致性由 `rfc224-e2e-compiled-seam.test.ts:35,42` 的模板字符串锁看住，更新之）。
- 产物 smoke `run([outfile,'version'])`（`:328`）win32 直接可执（`.exe`）。
- embed 生成的 `safeIdent`/URL 键已 posix 归一（`:131,162,171,181`）；构建期追加「lowercase 冲突检测」断言（大小写不敏感 FS 防线，一次性纯检查）。
- **不做交叉编译**方针不变（`:17-19`）；windows 产物由 windows runner 原生构建。arm64 见 proposal R5。

### 8.2 e2e stub 编译化（D16）

- 现状：9 个 `#!/bin/sh` stub + 3 个 `#!/usr/bin/env bun` `.ts` stub（`e2e/fixtures/`；harness 校验 `stub-opencode.sh` 可执行，`e2e/harness.ts:357-360`）。
- 设计：合并为**单一参数化 TS stub**（行为由 `AW_STUB_MODE=<mode>` 选择，模式集合 = 既有 9+3 个行为的枚举），`build:binary:e2e` 顺带 `bun build --compile` 出 `dist/stub-opencode-<platform后缀>[.exe]`。收益：①win32 无 shebang 问题；②「runtime 可执行文件」约束三平台同构（seal/选择器不需要例外）；③stub 行为集中一处可测。
- 迁移法：逐 spec 对照表（plan 列 12 个 stub → mode 映射），**POSIX 腿先切换并全绿**，再接 windows 腿（proposal R7）。
- `e2e/command.ts` 已有 win32 范式（`GCM_INTERACTIVE`/`NUL`，`:20-29`）保持；`runSqlite`（`:32-40`，`execFileSync('sqlite3')`）替换为 bun:sqlite 内联执行（显式 `PRAGMA busy_timeout`，小于命令超时——dev-gotchas:26 的坑一并收口），同步改 `root-test-entrypoint.test.ts:346-347` 源码锁。

### 8.3 workflow 改动

- **release.yml**：matrix 加 `windows-latest`（`:80-83`）；上传步（`:106-114` `find|head`）显式 `shell: bash`（windows runner 自带 git-bash）+ glob 兼容 `.exe`；README 下载指引更新（无 `chmod +x`）。
- **ci.yml**：
  - 四个矩阵 job（`test-backend:77-78`、`test-frontend:181-182`、`build-binary:405`、`e2e:740-741`）os 列表加 `windows-latest`；bash 语法步骤显式 `shell: bash`。
  - `build-binary` 的 ~250 行 smoke（`:441-694`）去 POSIX 化：`/usr/bin/true` → 用被测二进制自身的无害子命令；`cwd:"/"` / `startsWith("/")` → `node:path` 平台判据；`mktemp`/`chmod +x` → bash 内可用（git-bash）但对 `.exe` 的 chmod 变 no-op（保留无害）。
  - backend windows 腿的 opencode 全局安装步（`:99-107`）验证 `bun install -g` 在 windows runner 的产物可执行性（plan 实测项）。
  - `perf` / `scans` / `docs` / `lint` 保持 ubuntu 单腿（非矩阵 job，与平台无关或明确单平台门）。
- **visual**（`visual-regression-nightly.yml`）：加 windows-latest 腿，比对第三套 `*-chromium-win32.png`（48 场景）；**权威判定仍是 ubuntu-24.04 腿**（基线漂移控制不变，`:83-85`）；首刷流程按 `e2e/visual-regression.README.md:80-102` option-A（先红 → 下 artifact → 审阅提交）。
- **e2e-webkit-nightly**：矩阵加 windows（Playwright WebKit 支持 win32）；若首月 flaky 超阈值按 dev-gotchas flaky 纪律显式登记处理（不静默摘腿）。
- **integration-opencode**（bwrap 专属）与 **git-protocols**（docker）保持 Linux，rationale 注释进 workflow 头。

### 8.4 source-lock / 配额更新清单（改矩阵必红，逐条同步）

| 锁 | 内容 |
|---|---|
| `root-test-entrypoint.test.ts:215-231` | 四个 job 的 `os:` 逐字断言 → 更新为三 OS 列表；shard/`--shard=` 出现次数（backend 2→3 腿） |
| `root-test-entrypoint.test.ts:372-394` | job 名集合 + timeout map（如拆 job 需同步） |
| `root-test-entrypoint.test.ts:146-161` | 新增 workflow 腿的 `bun-version` 钉必须等于 `packageManager` |
| `root-test-entrypoint.test.ts:181-189` | backend shard `run:` 命令逐字锁（新增 `shell: bash` 声明时同步） |
| `root-test-entrypoint.test.ts:346-347` | `sqlite3` fixture 锁 → bun:sqlite 新形态 |
| `rfc224-e2e-compiled-seam.test.ts:32-66` | 产物名模板（`.exe` 后缀）、artifact glob、release 不含 `build:binary:e2e` |
| `test-suite-policy.test.ts:43-83` | `ALLOWED_SKIP_COUNTS`：全部新增 win32-gated skip 登记（每条带理由注释） |
| `test-suite-policy.test.ts:105-131` | 新增 `RUN_*` 开关（如有）须落 CI 激活 marker |
| `rfc233-containment-source-guard.test.ts:47` | containment 源内 `process.platform` 禁令——新分支走注入缝，锁本身不动 |
| `rfc227-source-guard.test.ts:75-76` | provider id 字面量断言——不动（win32 不加 provider） |

## 9. 前端与 i18n

- 无布局/组件改动（SandboxCard、StatusChip、guidance 呈现全部走既有结构）；新增文案全部 `zh-CN`/`en-US` 双语（`i18n-key-resolution` + parity 守卫覆盖）。
- 脚本节点 Inspector 对 bash 类型追加平台提示文案（仅文档性 hint，不改交互）。
- 视觉第三套基线属 CI 产物，前端零改动预期（若 win32 渲染出真实差异按基线流程审阅）。

## 10. 安全考量（D20 降级清单——唯一事实源，docs/sandbox.md 引用）

win32 v1 相对 POSIX 的语义降级，全部「跳过 + 呈现」，登记如下：

1. **零隔离**：业务 agent / 系统 agent / 脚本 / 安装器均以 daemon 用户权限直跑（= POSIX 把 sandboxMode 设 off/warn 且无机制可用）；enforce 与 failClosed 档拒绝执行。
2. **seal 无只读位**：digest 复验仍在（TOCTOU 主防线），文件系统级防篡改缺失。
3. **秘密文件无 POSIX mode**：token / secret.key / db.sqlite / 一次性凭据依赖 `%USERPROFILE%` 默认 ACL；doctor 的 mode 检查（`cli/doctor.ts:420-421`）win32 跳过并明示（D19）；DPAPI 加固 → audit-backlog。
4. **git 硬化的写保护弱化**：hooksPath 空目录仍防 hook 执行，但目录本身可写（chmod no-op）。
5. **杀树非原子**：taskkill 枚举竞态；Job Object 待 provider RFC。
6. **daemon 硬杀后系统代理进程可能残活**（§3.3）。
7. **上游弱项**：opencode 在 win32 的 MCP 子孙清理 no-op、FFF 默认关闭。
8. **env 大小写折叠是新增安全面**：所有黑白名单经 §2.2 单点，混合大小写绕过在三平台测试锁定。

## 11. 失败模式

| 场景 | 行为 |
|---|---|
| win32 + enforce 启动任务 | 409 `sandbox-unavailable`，capability-driven 文案（§4） |
| win32 + 脚本节点断网/只读档 | 启动期 fail-closed，失败码沿用 RFC-253 体系 |
| bash 脚本节点且无 Git for Windows | 解释器探测失败 → 节点启动期显式失败 + 平台化文案（§7.1） |
| 用户配置 `.cmd/.bat`（MCP 命令 / runtime 二进制） | D17 定向拒绝 + 改法指引，绝不静默走 shim |
| argv 超 win32 32767 上限（legacy/脚本路径） | §2.3 守卫显式失败，不允许晦涩 spawn 错误 |
| taskkill 失败（权限/已退出） | 单进程 kill 回退 + 存活复查 + 既有孤儿回收兜底 |
| stop 的 HTTP 通道不可达（daemon 未监听/端口占用） | 超时后 taskkill /T 强杀 + 明确输出「非优雅关停」 |
| 深路径仓 checkout 失败（longpaths 后仍超限） | git 原生报错透传 + doctor/README 的 LongPathsEnabled 指引 |
| `python` 命中 MS Store 假 alias | `--version` 探测非零退出 → 自动落到下一候选 `py` |

## 12. 测试策略

按 CLAUDE.md test-with-every-change，每个 PR 自带用例；分四层：

1. **纯函数直测（任意 OS 可跑，平台以参数注入）**：`platformExec` 常量/助手正反例；env 折叠（混合大小写命中/删除/转发去重 + POSIX 恒等）；argv 限长计算（win32 序列化长度边界）；taskkill/Get-CimInstance argv 构造；解释器候选表（含 WSL bash 规避断言：win32 分支绝不产生 `System32\bash.exe` 候选）；hermetic env win32 形态（键集全量快照 + 「不含意外继承键」对照）；guidance win32 渲染。**每条新守卫做变异实证**（改坏源码看红）。
2. **既有回归零漂移**：POSIX 行为逐字节不变的断言（杀树权威迁移后既有 kill 相关套件全绿；受控 env POSIX 快照不变；`verifiedPlan` 身份断言 POSIX 分支不变）。
3. **windows CI 真实行为**（跑在 windows-latest 腿）：spawn/杀树/孤儿回收/锁/stop 端到端；git clone→worktree→stash→diff（NUL、longpaths）；凭据子命令注入链；脚本节点三语言真实执行（runner 预装 python/node/git-bash）；编译 stub 的 opencode verified 链路；`bun install -g opencode-ai` 产物可执行性。POSIX-only 用例 skip 登记进配额表（§8.4）。
4. **e2e / 视觉**：windows 四 shard；第三套基线 48 张（option-A 流程）；webkit nightly windows 腿。
5. **真机验收**（D4，AC-28）：CI 无法证明的项——console 无弹窗、Prism 下 x64 产物、真 opencode/claude CLI 业务工作流、长路径仓、Git Bash 探测在非 runner 环境（用户自装 Git for Windows 路径变体）。清单见 plan。

## 13. 开放问题

1. **windows-arm64 产物**（proposal R5）：Bun pin ≥1.3.14 后验证 `bun-windows-arm64`（opencode 实用先例）或 hosted `windows-11-arm` 原生构建（仓库 PUBLIC，runner 可用）；独立小改动。
2. **DPAPI 秘密加固**、**Job Object + AppContainer provider**：各自独立 RFC；本 RFC 交付的接缝义务 = AC-9 两条 contract test + §0 注册面不回退。
3. **credential.helper 引号规则**在 git-for-windows 各版本的一致性：实现期 CI+真机双验证（§6）；若发现不可靠，回退方案是 no-space 私有路径的 `.exe` 副本 + `GIT_ASKPASS`（设计已预留讨论，plan T 标注）。
4. **`.cmd` shim 自动解包**（对 runtime 二进制选择的体验优化，multica 模式）：v1 拒绝 + 指引，后续小改进。
