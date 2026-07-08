# RFC-windows — 技术设计

> 阻塞点全景见 §2（13 类，带 file:line，2026-07-07 快照，落地前逐项复核）；平台原语收口见 §3；文件系统与路径见 §4；敏感文件 ACL 见 §5；wsl-opencode driver 见 §6（核心）；MCP/indexers/备份见 §7；构建与 CI 见 §8；失败模式 §9；测试策略 §10。

## 1. 设计原则

1. **平台分支单源**：所有 `process.platform === 'win32'` 判别只许出现在 `util/platform.ts` 与 `runtime/wsl-opencode/` driver 内部。业务层（runner/scheduler/routes/services）调平台原语函数，永不自己判平台——违者按回归打回（与 RFC-143 旁路清零同款纪律）。
2. **外部约束封装在 driver 边界**：opencode 不支持原生 Windows 这一事实，封装在 `wsl-opencode` driver 内；业务层只见 `getRuntimeDriver(runtime)`，与 RFC-143 收口后的调用形态完全一致。
3. **行为等价，不重写**：POSIX 路径的 kill/stop/lock/symlink/file:// 行为被既有 golden/单测锁死。Windows 适配是「同一语义换个平台机制」，不是行为变更。POSIX 分支 byte-for-byte 保留。
4. **安全不降级**：chmod 在 Windows 是 no-op 这类「静默失效」是安全回归的高危区——必须用 ACL 等价闭合，且配实证测试，不能靠「测试在 Windows 跑绿」掩盖。
5. **opencode 行为以源码为准**：`wsl` 透传 env、路径映射、stdout JSON 事件流是否丢帧等，必须在 PR-3 用真实 opencode 验证（CLAUDE.md 强制），不靠记忆。

## 2. 阻塞点全景（取证结果）

| 类                      | 现状（file:line）                                                                                              | Windows 问题                                                                     | 收口去向                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------- |
| **进程组/kill**         | `util/process.ts:32` `process.kill(-pid,sig)`；`runner.ts:924` `detached:true`；`opencode.ts:86` 探针 detached | POSIX `setsid()` 进程组在 Windows 不存在；负 pid group-kill 无效                 | §3.1 Job Object             |
| **信号语义**            | `cli/stop.ts:46` `SIGTERM`；`runner.ts:1240` `SIGTERM→SIGKILL`；`start.ts:515` handler                         | Windows 无 SIGTERM；`process.kill(pid)`=硬杀，无优雅停机                         | §3.2 优雅停机双通道         |
| **`ps` 命令指纹**       | `util/process.ts:61,79` `ps -p <pid> -o command=`                                                              | `ps` 不在 Windows；陈旧 PID 复用门失效                                           | §3.3 wmic/CIM 分流          |
| **单实例锁**            | `util/lock.ts:53` `openSync('wx')` O_EXCL PID 文件                                                             | ✅ 已跨平台（注释明说 no flock dependency）                                      | 无需改                      |
| **symlink**             | `runner.ts:1596` external skill `symlinkSync(dir)`；`claudeCode/config.ts:60`                                  | Windows 软链需开发者模式/管理员                                                  | §4.1 junction/copy          |
| **file:// plugin spec** | `runner.ts:549,1752` `` `file://${pluginPath}` ``；`pluginInstaller.ts:230` `new URL(spec).pathname`           | `C:\…` → `file://C:\…` 畸形；pathname=`/C:/…` 需 fileURLToPath                   | §4.2 pathToFileURL 全局统一 |
| **home/路径**           | `util/paths.ts:appHome()` `homedir()+'.agent-workflow'`；`skill-source.ts:647` `~/`                            | 基本可用；但 Windows MAX_PATH=260 对深 worktree 是真风险                         | §4.3 长路径                 |
| **tar 备份**            | `services/backup.ts:152` `Bun.spawn(['tar','-czf',...])`                                                       | Win10 1803+ 自带 bsdtar 但靠不住                                                 | §7.2 tar 探测+降级          |
| **chmod 600**           | `auth/secretBox.ts:24`、`auth/token.ts:29`、`pluginInstaller.ts:181` mode 0o700                                | Windows 无 unix mode → 敏感文件实际未隔离=安全回归                               | §5 ACL 闭合                 |
| **MCP stdio env**       | `mcpProbe.ts:367` `['PATH','HOME','LANG']`                                                                     | Windows 无 `HOME`（是 USERPROFILE）；`npx`/`uvx` 是 `.cmd` shim                  | §7.1 env 白名单扩充         |
| **opencode spawn**      | `opencode/spawn.ts` `['opencode','run',...]`；`PWD` 注入                                                       | npm 全局 opencode 在 Windows 是 `opencode.cmd` shim；opencode 不原生支持 Windows | §6 wsl-opencode driver      |
| **SCIP indexers**       | `structuralDiff/deep/indexers.ts:37` scip-ts/py/go、rust-analyzer、scip-clang/java                             | 外部二进制，多数有 Windows 构建，scip-clang 可能没有                             | §7.3 可选降级               |
| **构建/CI**             | `scripts/build-binary.ts` `--target=bun`；现仅 macos/linux matrix                                              | 需加 `bun-windows-x64` target + `windows-latest` matrix                          | §8                          |
| **shell**               | 全后端 spawn 均用 argv 数组、无 `sh -c`                                                                        | ✅ 最干净的一点，几乎不用动                                                      | 无需改                      |

## 3. 平台原语收口（`util/platform.ts`，业务层无感）

新建 `util/platform.ts` 为**唯一**平台分支出口。`util/process.ts` 的现有导出（`isProcessAlive`/`killProcessTree`/`pidCommand*`/`killStaleRunProcessTree`）改为委托 `platform.ts` 的平台分流实现；签名不变，调用点零改动。

### 3.1 进程树 kill — `taskkill /T /F`（v1）→ Job Object（未来硬化）

Windows 无进程组/`setsid`。**v1 实现**用 `taskkill /T /F /PID <pid>`——`/T` 递归杀整个进程树，是最接近 group-kill 的零依赖机制（无 N-API addon）。已落地于 `util/platform.ts` `killProcessTree` Windows 分支，POSIX 分支 byte-for-byte 保留 `process.kill(-pid)` + 单 pid fallback。

> **设计偏差（已记录）**：原设计 §3.1 写的是 Job Object（`CreateJobObject` + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，spawn 时挂子进程进 Job、关句柄收全树含脱离的孙子）。实现时评估：Job Object 需 Win32 API 经 N-API addon 暴露，引入 native 依赖与构建复杂度，而 `taskkill /T /F` 对 v1 的常见场景（opencode 子进程 + 其 MCP/shell-tool 直系后代）已足够。**Job Object 留作未来硬化**——针对「孙子进程脱离 `/T` 树」的极端场景（如 docker MCP daemon 自行 detach）。`detached: true` 在 Windows 分支暂保留（不阻断 taskkill），等 Job Object 落地时再评估改为不 detached。

落地范围（PR-1）：`util/process.ts` 三原语委托 `util/platform.ts`；`runner.ts` `killTree` 委托 `killProcessTree`；`util/opencode.ts` + `runtime/claudeCode/probe.ts` 探针超时的 group-kill 也委托。POSIX 全路径 byte-for-byte 不变。

### 3.2 优雅停机 — 双通道

Windows 无 SIGTERM，`process.kill(pid)` 是 TerminateProcess（硬杀）。优雅停机改走双通道：

1. **`CTRL_BREAK_EVENT` / console ctrl**：daemon 自身注册 `process.on('SIGBREAK')`（Windows console ctrl-break 映射）+ 既有 `SIGINT`（Windows 下 ctrl-c 仍触发）。POSIX 的 `SIGTERM` handler 在 Windows 改挂 `SIGBREAK`。
2. **`agent-workflow stop`**（`cli/stop.ts:46`）：Windows 分支不再 `process.kill(pid,'SIGTERM')`，改为 HTTP `POST /api/shutdown`（既有 Hono server 加一个本地 token 守卫的端点，token 从 `Paths.daemonInfo` 读）。daemon 收到后走既有 `shutdown()` 路径（abort 所有任务 AbortController、关 DB、释放锁）。
3. **SIGTERM→SIGKILL 升级**（`runner.ts:1240`）：Windows 分支改为「HTTP 通知优雅停 → bounded 等待 → Job Object 硬杀」三级，语义等价。POSIX 保留 SIGTERM→SIGKILL byte-for-byte。

### 3.3 PID 命令指纹 — wmic/CIM

`pidCommandLooksLikeAgentChild`/`pidCommandContainsBinary`（`util/process.ts:59-85`）现用 `ps -p <pid> -o command=`。Windows 分支改用：

- 优先 `wmic process where ProcessId=<pid> get CommandLine`（兼容性好，Win7+ 都有）；wmic 在新 Win11 被弃用但仍可用。
- 兜底 PowerShell `Get-CimInstance Win32_Process -Filter "ProcessId=<pid>" | Select CommandLine`。
- 字符串匹配逻辑（`/opencode|bun/i` regex、`includes(binaryPath)`）不变，只换取命令行的机制。

`isProcessAlive(pid)`（`util/process.ts:14` `process.kill(pid,0)`）✅ 已跨平台，不动。

## 4. 文件系统与路径

### 4.1 symlink — junction/copy

`runner.ts:1596` / `claudeCode/config.ts:60` 的 external skill `symlinkSync(target, dst, 'dir')`：

- Windows 分支改 `fs.symlinkSync(target, dst, 'junction')`——**目录 junction 不需开发者模式/管理员**（与 dir symlink 不同）。
- 文件型 external skill（罕见）降级为 copy（external skill 本就是只读引用，与 managed skill 的 copy 路径同源，代价可接受）。
- POSIX 分支保留 `'dir'` symlink。
- 收口到 `util/platform.ts` 的 `linkSkillDir(target, dst)` 单函数，两调用点改调它。

`upload.ts` 的 symlink-traversal 安全检查（`realpathInside`/`lstat`）✅ 在 Windows 仍工作（lstat 可用），不动；但 PR-2 补一条「Windows 上 symlink-based repo 攻击行为等价」的回归测试。

### 4.2 file:// — pathToFileURL 全局统一

`runner.ts:549,1752` 的 `` `file://${pluginPath}` `` 字符串拼接在 Windows 产 `file://C:\…`（畸形）；`pluginInstaller.ts:230` `new URL(spec).pathname` 在 Windows 产 `/C:/…`（反解错）。

- **全局统一**用 `node:url`：拼用 `pathToFileURL(pluginPath).href`，反解用 `fileURLToPath(url)`。
- 这是跨平台正确写法，**POSIX 行为等价**（`pathToFileURL('/x/y')`→`file:///x/y`，与现状字符串拼接结果一致），可全平台统一、删掉分支。
- 改动点：`runner.ts:549,1752,1822,1824`、`pluginInstaller.ts:229-230`。

### 4.3 长路径 — MAX_PATH

Windows 默认 MAX_PATH=260；worktree 根 `~/.agent-workflow/worktrees/{slug}/{task-id}` + 深嵌套仓库文件易触上限：

1. `agent-workflow doctor` 加「LongPathsEnabled 注册表项」检查，未启用则提示（不强制阻断——用 `\\?\` 前缀兜底）。
2. 二进制 manifest 加 `longPathAware: true`（`scripts/build-binary.ts` 配 Bun compile 选项或单独 `.manifest` 文件）。
3. 对超长路径 fallback `\\?\` 前缀（`util/platform.ts` 的 `toLongPath(p)`）。

### 4.4 home 目录

`appHome()`（`util/paths.ts`）维持 `homedir()+'/.agent-workflow'`（Windows 下 `C:\Users\<u>\.agent-workflow`，可接受，与 POSIX 跨机一致）；`AGENT_WORKFLOW_HOME` 覆盖已支持。**不强行改 `%APPDATA%`**——会破坏跨平台一致体验。`skill-source.ts:647` 的 `~/` 扩展走 `homedir()` ✅ 已可用。`claudeCode/config.ts:102` 的 `~/.claude/.credentials.json` 在 Windows 下读 `C:\Users\<u>\.claude`（claude-code 在 Windows 的存储位置），PR-3 用真实 claude-code 验证。

## 5. 敏感文件 ACL（安全等价闭合）

Windows 无 unix mode，`chmod 600` 是 no-op——`secret.key`（OIDC client_secret 密封密钥）/`token`（daemon token）在 Windows 实际全可读，**这是安全回归，必须修**。

新建 `util/fs-perms.ts`：

```ts
/** Secure a sensitive file/dir to current-user-only (chmod 600 / icacls). */
export function secureFile(p: string): void
/** Secure a dir to current-user-only (chmod 700 / icacls). */
export function secureDir(p: string): void
```

- POSIX 分支：`chmodSync(p, 0o600)` / `0o700`（现状行为）。
- Windows 分支：`icacls <p> /inheritance:r /grant:r "${USER}:R"`（文件）/`":(OI)(CI)F"`（目录，含继承）。当前用户从 `os.userInfo().username` 或 `process.env.USERNAME` 取。
- 调用点：`auth/secretBox.ts:24,33`、`auth/token.ts:29,39`、`pluginInstaller.ts:181` 改调 `secureFile`/`secureDir`。
- **实证测试**：Windows 上用 `icacls <p>` dump ACL，断言只有当前用户、无 `Everyone`/`Users` 组——不能只看文件能写。

## 6. 原生 opencode on Windows（策略 D，已实测可行）

**核心结论**：opencode 是 Node CLI（npm `opencode-ai`），原生 Windows 可直接 spawn。2026-07-08 实测（opencode-ai 1.15.5 全局装于 Windows）：`opencode run "..." --format json --thinking --dangerously-skip-permissions` 完整跑通——Bun 解析 `opencode.cmd` shim → 调 LLM（阿里云 glm-5.2）→ 返回 `pong` → stdout 吐完整 JSON 事件流（`step_start`/`text`/`step_finish`，正是平台 `parseEvent` 的格式）→ 干净退出。

**因此：不建新 driver、不走 WSL、不依赖 RFC-143。** 现有 `runtime/opencode/` driver（`buildOpencodeSpawn` → `['opencode','run',...]` + `OPENCODE_CONFIG_DIR`/`CONTENT` env + cwd=worktree）在 Windows 上直接可用。PR-3 收窄为「验证现有 driver 在 Windows 跑通 + 修小坑 + 文档」。

### 6.1 现有 driver 在 Windows 的复用点

| driver 能力                                                                                                                       | Windows 复用情况                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `buildCommand` argv（`['opencode','run',prompt,'--agent',name,'--format','json','--thinking','--dangerously-skip-permissions']`） | ✅ 原样可用（实测）                                                                                              |
| `buildOpencodeEnv`（`PWD`/`OPENCODE_CONFIG_DIR`/`CONTENT`/`OPENCODE_AW_INVENTORY_OUT`/`GIT_*`）                                   | ✅ env 透传跨平台；`PWD` 在 Windows 仍设为 worktree                                                              |
| `Bun.spawn({cmd, cwd: worktreePath, detached: true, ...})`                                                                        | ✅ `.cmd` shim 由 Bun PATHEXT 解析（实测 `opencode --version` exit 0）；`detached: true` 在 Windows 创建新进程组 |
| `parseEvent`（stdout JSON 行解析）                                                                                                | ✅ 实测 stdout JSON 事件流（`step_start`/`text`/`step_finish`）与 POSIX 一致                                     |
| `probe`（`opencode --version`）                                                                                                   | ✅ 实测 exit 0、解析版本号                                                                                       |
| inventory plugin `file://` 注入                                                                                                   | ✅ PR-2 已修 `file://` 跨平台（`toFileUrl`）                                                                     |
| external skill symlink 注入                                                                                                       | ✅ PR-2 已修（`linkSkillDir` junction）                                                                          |

### 6.2 PR-3 需验证/修的小坑

实测只跑了**裸 `opencode run`**（直接命令行）。PR-3 需验证 daemon 的**完整 runNode 路径**（`buildOpencodeSpawn` 组装的 env + cwd + `materializeInventoryPlugin` + skill 注入 + memory 注入）在 Windows 端到端工作。可能的坑：

- **`opencode.cmd` shim 层**：Bun 解析已工作，但 shim 经 `cmd.exe` 包装时 stdout 可能带 CRLF。若 pump 解析 JSON 行遇 CRLF，在 driver 的 line-reader 里剥 `\r`（与 claude-code transcript 的 CRLF 规整同款）。
- **`--session` resume（RFC-026 clarify-inline）**：Windows 下 opencode session 存储路径 + resume 行为需实测。
- **inventory plugin 的 `.mjs` 加载**：`materializeInventoryPlugin` 拷 `.mjs` 到 per-run dir + `file://` 注入——PR-2 已修 `file://`，PR-3 验证 opencode 在 Windows 能 load 这个 plugin。
- **captureSessions**（opencode SQLite BFS，`sessionCapture.ts`）：Windows 下 opencode 的 SQLite 路径需确认；`resolveOpencodeDbPath` 可能需 Windows 分支。

这些是「实测驱动」的清单，非预设改动——能跑通就不改，碰到再修。

### 6.3 runtime 默认解析

Windows 上默认 runtime 仍是 **`opencode`**（与 POSIX 同），无需特殊解析。`runtimeRegistry` 默认逻辑不动——这是策略 D 比 WSL 简单的关键：同一个 driver、同一个 runtime kind、同一个默认解析。

### 6.4 doctor opencode 检查

`doctor` 的 opencode 检查（`probeOpencode` → `opencode --version`）在 Windows 上**已工作**（实测 exit 0、解析 1.15.5）。PR-1/2/5 的 doctor 已加 long-path/ACL 检查。**无 WSL 检查**——策略 D 不需要 WSL。

## 7. MCP / indexers / 备份（降级路径）

### 7.1 MCP stdio env

`mcpProbe.ts:367` `MINIMAL_INHERITED_ENV_KEYS = ['PATH','HOME','LANG']`：Windows 加 `USERPROFILE`/`HOMEDRIVE`+`HOMEPATH`/`PATHEXT`/`SystemRoot`/`ComSpec`。对 `HOME` 做「opencode/MCP 若依赖 HOME 则映射成 USERPROFILE」的兼容注入（`util/platform.ts` 的 `normalizeEnvForPlatform(env)`）。`npx`/`uvx` 类 `.cmd` shim 由 Bun spawn 的 PATHEXT 解析处理（PR-4 用真实 MCP server 验证）。

### 7.2 tar 备份

`services/backup.ts:152` `Bun.spawn(['tar','-czf',...])`：Windows 探测 `tar.exe`（Win10 1803+ 自带 bsdtar，`which('tar')`）；可用则直接用（argv 不变）；不可用降级为 Node `zlib`+`tar`(npm) 纯 JS，或 `powershell -Command 'Compress-Archive …'`（产物 `.zip` 而非 `.tar.gz`，文档标注）。优先用系统 tar。

### 7.3 SCIP indexers

`structuralDiff/deep/indexers.ts:37` 的六个 indexer（scip-typescript/python/go、rust-analyzer、scip-clang、scip-java）保持可选——`probeIndexer` 已是「缺失即 `available:false`、不抛」。Windows 上 scip-clang 等若无构建，结构化 diff 自动降级为文本 diff，不阻塞主流程。文档列明各 indexer 的 Windows 可得性；不改代码。

## 8. 构建与 CI（PR-5 已落地）

- `scripts/build-binary.ts`：`platformSuffix()` 加 `win32→windows` + `binaryExtension()`（`.exe`）；本地实证产出 `agent-workflow-windows-x86_64.exe` 124.4 MiB，`version` smoke 绿。
- `.github/workflows/ci.yml`：`build-binary` matrix 加 `windows-latest`（Windows leg 不装 native opencode——`version`/`doctor` smoke 不需）+ 新 `check-windows` job（typecheck/lint/format+RFC-windows 平台层测试，不全量 bun test——等 PR-3 闭环）+ `.gitattributes` 强制 LF。
- `.github/workflows/release.yml`：build matrix 加 `windows-latest`（产 `.exe` 上 GitHub Releases）。
- README Requirements + Windows setup 小节（PR-5 已落地；PR-3 收尾把「经 WSL」措辞改回「原生 opencode」）。

## 9. 失败模式

- **ACL 静默失效**：chmod no-op 易被「Windows 测试跑绿」掩盖——必须有 `icacls` dump 断言 ACL 的实证测试（§5，PR-2 已落地）。
- **`.cmd` shim 编码**：opencode 经 `opencode.cmd` → `cmd.exe` 包装，stdout 可能带 CRLF。pump 的 line-reader 剥 `\r`（PR-3 验证，必要时加规整）。
- **binary 模块环**：`util/platform.ts` 被 shared 引用——每 PR 必跑 `build:binary` smoke（memory `reference_binary_build_module_cycle`）。
- **MAX_PATH**：未启用长路径时深 worktree 失败——doctor 检查 + `\\?\` 兜底（PR-2 已落地）；不阻断启动但 doctor 标注。
- **Job Object 句柄泄漏**：v1 用 `taskkill /T /F`（无 Job Object），无句柄泄漏风险；Job Object 硬化列未来。

## 10. 测试策略

### 保护网（POSIX，保持绿 / 按需同步）

- `runtime-opencode-golden.test.ts` — opencode 业务 spawn byte-for-byte，**POSIX 路径必须逐字绿**（Windows 不触碰 POSIX argv/env）。
- `lock.test.ts` / `process.test.ts` — 锁与 kill 既有单测（PR-1 已同步）。
- `runner-inventory-integration.test.ts` — inventory 注入/回读。
- `pluginInstaller` / `backup` / `mcpProbe` 现有单测——POSIX 分支不回归（PR-2/4 已实证）。

### 新增（本 RFC 验收锁）

1. **平台原语单测**（PR-1 已落地）：`killProcessTree` taskkill；`pidCommand*` wmic；优雅停机 HTTP `/shutdown`。
2. **file:// 跨平台往返**（PR-2 已落地）：`toFileUrl`/`fromFileUrl` 在 `C:\…` 与 `/x/y` 下等价。
3. **ACL 实证测试**（PR-2 已落地）：`secureFile`/`secureDir` 后 `icacls` dump 断言。
4. **原生 opencode Windows 集成测试**（PR-3）：用 `buildOpencodeSpawn` 组装的 env + cwd + 真实 opencode 跑一条 `runNode`，断言 stdout JSON 事件流完整到达 pump（`step_start`/`text`/`step_finish`）。标 `@requiresOpencode`，无 opencode 环境跳过。
5. **业务层零平台散落源码文本锁**：`rg -n "process\.platform\s*===\s*'win32'" packages/backend/src`（排除 `util/platform.ts` + tests）零命中。
6. **doctor Windows 检查**（PR-2/5 已落地）：opencode/git/long-path/ACL 各项单测。

### 门禁

typecheck×3 / lint / format / 后端 bun test 全量 / 前端 vitest / **binary smoke（必跑，模块环）** / Playwright e2e（Windows）/ CI Windows matrix；Codex 设计门（本文档）+ 实现门（每 PR）。

### 平台标注约定

Windows-only 测试用 `describe.skip`（POSIX CI 跳过）+ CI Windows matrix 跑；真实 opencode 的集成测试标 `@requiresOpencode`，无 opencode 环境跳过而非红。
