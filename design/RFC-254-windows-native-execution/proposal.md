# RFC-254 · Windows 原生执行支持

状态：Draft（待设计门 + 用户批准）
日期：2026-08-04
关联：RFC-205 / RFC-227 §5.3 / RFC-233（containment 接缝）、RFC-224（执行身份）、RFC-253（脚本节点）、RFC-252（安全定调）

## 1. 背景

平台目前只支持 macOS + Linux（`README.md:194` 明写 "Windows release binaries are not shipped yet"）。用户要求：**让本平台支持 Windows 执行**——即 Windows 原生（win32 单二进制 `.exe` daemon），不是 WSL 文档化。

研究结论支持可行性（详细锚点见 `design.md §0`）：

- **opencode 是 Windows 一等公民**（本机 v1.18.4 源码实证）：官方发 Azure 签名的 windows x64/arm64/x64-baseline 二进制，CI 在 windows-2025 跑 unit+e2e；shell 工具无需 POSIX shell（默认 `pwsh → powershell → git-bash → cmd.exe`）；`opencode serve` 纯 TCP loopback；`OPENCODE_CONFIG_CONTENT` 注入链在 Windows 同形；配置目录走 XDG-in-USERPROFILE 语义。
- **本仓准入核心为 Windows 留好了缝**：RFC-227 §5.3 明文预留 Job Object/AppContainer provider 义务；注入 `windows-appcontainer-v1` / `windows-job-object-fixture` 的两条 contract test 今天就是绿的。
- **参考仓 multica 已在 Windows 真实驱动 opencode**，坑与解法现成：npm `.cmd` shim 截断 argv → 解析原生 exe 直接 spawn；无进程组 → `taskkill /T /F`；隐藏 console 防弹窗风暴。

真正的移植工作面集中在：①进程组/信号/`ps` 依赖（POSIX 语义遍布 14 个文件）；②containment 无 provider 时的行为收口；③一批确定性平台差异（`/dev/null`、PATH 分隔符、env 键大小写、路径长度、命令行长度上限）；④构建/发行/CI（单二进制不做交叉编译，矩阵被 source-lock 测试逐字锁定）；⑤脚本节点解释器（`python3`/`bash` 在 Windows 无同名命令）。

## 2. 目标

1. **Windows x64 原生 daemon**：`agent-workflow-windows-x86_64.exe` 单二进制，`start / stop / doctor / sandbox` 等 CLI 子命令全部可用，daemon 生命周期（单实例锁、优雅关停、小时级后台任务、孤儿回收）在 Windows 语义下正确。
2. **任务执行全链路**：opencode verified 驱动（seal + 受控 config + 直接 API + session 归属）、git worktree 物化、输出 envelope、fanout/wrapper、评审/反问在 Windows 上端到端可用（无隔离档位，见 D1）。
3. **脚本执行节点**（RFC-253）在 Windows 可用：python/node 原生，bash 依赖 Git for Windows（D3）；断网/只读档按既有 failClosed 语义显式拒绝。
4. **CI / 发行一步到位全矩阵**（D2）：release 加 windows x64 产物；`ci.yml` 的 test-backend / test-frontend / build-binary / e2e 四个矩阵 job 全部加 windows；视觉基线第三套（win32）；相关 source-lock 测试同步更新。
5. **诚实的无隔离呈现**：Windows 上 `warn`/`off` 可跑并如实标注未隔离；`enforce` 与 failClosed profile 显式拒绝，文案 capability-driven（不硬编码 OS 补救话术）。

## 3. 非目标

- **Windows 隔离 provider**（Job Object / AppContainer / WFP 网络围栏）——后续独立 RFC；本 RFC 只保证准入接缝按 RFC-227 §5.3 契约保持可插（两条既有 contract test 不许退化）。
- **powershell 脚本类型**（脚本节点第四语言）——产品面扩张，另立 RFC。
- **windows-arm64 原生产物**——开放项（见 §7 R5）；x64 产物经 Prism 仿真覆盖 arm64 用户。
- **WSL 支持文档化**——WSL 走既有 Linux 产物，不属本 RFC 交付。
- **DPAPI / Windows ACL 级秘密文件加固**——v1 依赖 `%USERPROFILE%` 默认 ACL，登记 audit-backlog。
- **opencode 自身在 Windows 的弱项修复**（PTY、FFF 默认关闭、MCP 子孙清理 no-op 等）——上游行为，如实呈现不代修。

## 4. 用户故事

- 作为 Windows 用户，我从 Releases 下载 `agent-workflow-windows-x86_64.exe`，`.\agent-workflow.exe start` 即可打开前端，导入远端仓库、配置 agent、跑通 Code → Audit → Fix 工作流，与 macOS/Linux 同构。
- 作为 Windows 用户，我在 Settings → Sandbox 看到「当前平台无可用隔离机制」的如实状态；默认 `warn` 档任务照常运行并带降级告警；我切到 `enforce` 后任务启动被明确拒绝并说明原因。
- 作为工作流作者，我的 python/node 脚本节点在 Windows 装机上直接可用；bash 脚本节点在装了 Git for Windows 的机器上可用，未装时启动期收到明确的失败信息（而非跑一半神秘报错）。
- 作为贡献者，我推 main 后 CI 会在 windows-latest 上跑构建冒烟、后端/前端测试与 e2e，Windows 回归和 macOS/Linux 一样被门禁拦住。

## 5. 决策清单

### 5.1 用户拍板（2026-08-04 澄清，逐条）

| # | 决策 | 内容 |
|---|---|---|
| D1 | 隔离档位 | **v1 不做 Windows 隔离 provider**。warn/off 可跑、UI 如实标注未隔离；enforce 与脚本节点断网/只读档（failClosed）显式拒绝。进程树杀灭/孤儿回收用 Windows 原生机制做对（这部分无论如何都要做）。完整 Job Object + AppContainer 留后续独立 RFC，接缝按 RFC-227 §5.3 预埋。 |
| D2 | CI/发行 | **一步到位全矩阵**：release.yml 加 windows x64；ci.yml 四个矩阵 job（test-backend / test-frontend / build-binary / e2e）全部加 windows；刷第三套 win32 视觉基线。POSIX 专属用例按既有 skip 配额机制登记。 |
| D3 | 脚本节点 | **python/node 原生 + bash 靠 Git Bash**：python 探测链扩展（`python3 → python → py`）；bash 依赖 Git for Windows 的 `bash.exe`（自动探测 + 可显式指定），探测不到时该节点启动期显式失败；node 不变。 |
| D4 | 验收环境 | **有 Windows x64 真机**。plan 的验收清单区分「CI windows runner 可证明」与「真机人工核验」两档（Git Bash 探测、console 弹窗、长路径、Prism 等归后者）。 |

### 5.2 设计推导决策（批准时一并确认）

| # | 决策 | 理由 |
|---|---|---|
| D5 | 范围 = Windows **原生**（win32 daemon `.exe`） | 用户原话「支持 windows 执行」；WSL 今天走 Linux 产物已可用，不构成交付。 |
| D6 | 产物只发 **windows x64**（`agent-workflow-windows-x86_64.exe`）；arm64 登记开放项 | 本仓单二进制**有意不做交叉编译**（`scripts/build-binary.ts:17-19`）；Bun 1.3.14 的 `bun-windows-arm64` 交叉目标上游存在（opencode `script/build.ts` 实用），但本仓 pin 1.3.13 且 native bun-on-win-arm64 工具链未证；x64 产物在 arm64 Windows 经 Prism 仿真可用。 |
| D7 | `appHome` 保持 `~/.agent-workflow`（即 `%USERPROFILE%\.agent-workflow`），不迁 `%LOCALAPPDATA%` | 与 opencode 的 XDG-in-USERPROFILE 先例一致（`%USERPROFILE%\.config\opencode`）；`AGENT_WORKFLOW_HOME` 可覆盖；避免三平台布局分叉。 |
| D8 | `sandboxMode` 语义与默认值（`warn`）在 Windows **不变** | RFC-252 用户定调「做安全不能把功能限制住」；warn 档每任务一条 sandbox-degraded 告警的既有机制在 Windows 自动生效，呈现如实。enforce 的 409 文案改为 capability-driven（删掉硬编码的 macOS/Linux 补救话术，`task.ts:1872`）。 |
| D9 | 进程治理选型：**`taskkill /pid <pid> /T /F`** 杀树 + **PowerShell `Get-CimInstance Win32_Process`** 查命令行（pid-reuse 防护）；`Bun.spawn` 在 win32 传 `windowsHide: true`、保留 `detached: true` | 与 opencode（`cross-spawn-spawner.ts:297-305`）、multica（`proc_windows.go`）同模式；Bun 1.3.13 原生支持 `detached`（win32 = UV_PROCESS_DETACHED）与 `windowsHide`（`bun-types/bun.d.ts:6688-6701,6878`）。`ps` 与负 pid 组杀不可用；`wmic` 已从新 Windows 移除。Job Object 原子杀树留 provider RFC。 |
| D10 | `agent-workflow stop` 在 win32 走 **HTTP shutdown 通道**（loopback + `.daemon.info` 的 url/token，新增管理端点），POSIX 保持 SIGTERM | Windows 上 `process.kill(pid,'SIGTERM')` 等于 TerminateProcess 强杀，30s graceful 预算完全失效（`cli/stop.ts:46`）。 |
| D11 | git askpass helper 从 POSIX sh 脚本改为**平台自身二进制的隐藏子命令**（`verifiedSelfCommand` 模式），三平台单实现 | `services/gitCredential.ts:23-41` 现为 `#!/bin/sh` + sed/printf，Windows 无 shebang；「面向代码最合理，优于改动最小」——消灭而非分叉 POSIX 依赖。 |
| D12 | 受控 env 的 Windows 形态：白名单补系统必需键（`SystemRoot`/`COMSPEC`/`PATHEXT`/`TEMP`/`TMP`/`USERPROFILE`…）；私有 HOME 重定向 = `USERPROFILE` + `XDG_*`；PATH 用 `;` 拼受控目录；**env 键比较一律经平台感知的大小写折叠单点** | Windows env 键大小写不敏感，现有 `Set.has` / `delete env[k]` / `/^[A-Z]/` 精确匹配存在**安全语义**漏洞面（如 `SAFE_ENV_NAME` 全大写要求会把 `Path` 静默丢弃）；opencode 在 win32 依赖 `USERPROFILE`（`os.homedir()`）与 `xdg-basedir`（任意平台认 `XDG_*`），私有化路径照常成立。 |
| D13 | `/dev/null`→`NUL`、PATH 分隔符、`dirname` 等经**新的平台常量/纯函数单点**收口，不散落三元表达式 | e2e 已有正确范式（`e2e/command.ts:25`）；散落写法必然漂移。 |
| D14 | argv 长度守卫改**平台感知**：win32 按整条命令行序列化后长度对 32767 上限校验；POSIX 维持现状 | impl-gate 经验规律「固定字节阈值几乎总错」；`MAX_OPENCODE_PROMPT_BYTES=120KiB`（`runtime/opencode/spawn.ts:69-73`）只对 legacy argv 路径有意义，verified 路径 prompt 走直接 API 的 HTTP body 不受影响——守卫只需覆盖真正走 argv 的路径。 |
| D15 | e2e 的 `sqlite3` CLI 依赖替换为 **bun:sqlite 内联脚本**（显式 busy_timeout），全平台统一 | windows runner 无预装 sqlite3 保证；顺带消掉一个系统依赖与 dev-gotchas 里的 busy_timeout 坑面。相关 source-lock（`root-test-entrypoint.test.ts:346-347`）同步改。 |
| D16 | e2e 的 9 个 `#!/bin/sh` stub 统一迁为 **单一参数化 TS stub + `bun build --compile` 编译为原生可执行**（`build:binary:e2e` 顺带产出），三平台同一形态 | Windows 无 shebang；`.cmd` shim 有 CreateProcess 不直接可执 + argv 重整形坑（multica 实证）；编译成真实可执行文件让 runtime 选择器/seal 的「单可执行文件」约束在三平台同构成立。 |
| D17 | Windows 命令解析单点：新增 resolve 助手处理 `.exe/.cmd/.bat` 与 `PATHEXT`，`.cmd/.bat` **拒绝直接 spawn**并给出定向报错（引导用户填原生可执行路径），MCP/探测/解释器共用 | multica 的 `.cmd` shim argv 截断教训；Bun.spawn 不做 cross-spawn 式 shim 处理。 |
| D18 | git 硬化前缀在 win32 追加 `-c core.longpaths=true`；worktree 深路径风险另登记 | Git for Windows 默认 260 上限会让深仓 checkout 失败；`~/.agent-workflow/worktrees/{slug}/{taskId}` 天然加深路径。 |
| D19 | doctor / token / secret.key / db 的 POSIX mode 检查在 win32 **跳过并如实报告**「依赖 USERPROFILE ACL」；不伪造等价保护 | 与 `binarySnapshot.ts` 既有 win32 跳过模式一致（`:85,176,183,228`）；DPAPI 加固进 audit-backlog。 |
| D20 | 每一处「Windows 上语义降级/缺失」必须**可见**：doctor 输出、Settings 状态、docs/sandbox.md 逐条列出（seal 无只读位、秘密文件无 mode、MCP 子孙清理弱、opencode FFF 默认关…） | 与 RFC-253 F1/F2 同类教训：能力缺失若不可见，就会被当成已交付。 |

## 6. 验收标准

### 地基与进程治理

- AC-1 全仓不再有裸的 `/dev/null` / `':'` PATH 拼接 / `lastIndexOf('/')` 取目录用于**本地文件系统路径**的站点（git 输出解析等 posix-by-contract 场景豁免并注释）；平台单点 util 有正/反向测试。
- AC-2 env 键比较（白名单、黑名单、保留键、delete）全部经过大小写折叠单点；win32 下 `Path`/`Temp`/`UserProfile` 等混合大小写键得到与全大写同等处理；有专项测试（三平台可跑，win32 语义用注入平台参数直测）。
- AC-3 `killProcessTree` / stale-run 清理 / 孤儿回收在 win32 走 `taskkill /T /F` 路径；pid-reuse 防护在 win32 用 `Get-CimInstance` 命令行判据；POSIX 行为逐字节不变（既有测试全绿）。
- AC-4 win32 上所有生产 spawn 传 `windowsHide: true`；真机核验长任务运行期间无 console 弹窗风暴（D4 真机项）。
- AC-5 `agent-workflow stop` 在 win32 经 HTTP shutdown 通道触发优雅关停（30s 预算生效、锁释放、`.daemon.info` 清理）；POSIX 路径不变。CI windows 上有端到端 stop 测试。
- AC-6 单实例锁在 win32 正确（重复 start 拒绝、stale 锁按存活探测回收）。

### Containment 收口（无 provider）

- AC-7 win32 上 `warn` 档：任务可跑、每任务恰一条 sandbox-degraded 告警、admission receipt 的 reasonCodes 为 `['platform-unsupported','required-capability-missing']`；`enforce`：启动 409 + 运行期 admit 拒绝，文案不再硬编码 OS 补救话术；`off`：按既有语义。
- AC-8 脚本节点 `network:'deny'` / `readonly:true` 在 win32 三种模式下都按 failClosed 拒绝，失败码与文案沿用 RFC-253 既有体系；作者在前端能看到明确原因。
- AC-9 RFC-227/233 的 Windows provider contract tests（`rfc233-containment-coordinator.test.ts:206-274`、`rfc227-containment-provider.test.ts:63-105`）保持绿——本 RFC 不得让未来 provider 接入变难。
- AC-10 `agent-workflow sandbox` / `doctor` / Settings Sandbox 卡片在 win32 输出如实的「无可用隔离机制」状态与指引（i18n 双语）。

### opencode 运行链路

- AC-11 win32 上 verified 路径端到端：管理员选定 `opencode.exe` → seal（digest 复验；mode 位检查按既有 win32 跳过）→ 受控 config 下发 → 直接 API 创建/恢复 session → envelope 解析入库。CI windows 用编译 stub 全链路测试；真机用真 opencode 至少跑通一次业务工作流（D4）。
- AC-12 受控 env 的 win32 形态正确：`USERPROFILE`+`XDG_*` 指向私有 store；`SystemRoot` 等系统必需键在白名单内；`PATH` 为 `;` 拼接的受控目录；对照断言「不含 daemon 继承的用户级意外键」。
- AC-13 受控 config 在 win32 不写 seal 内 `sh` 的 `shell` 键（opencode 走自身 `pwsh → … → cmd` 链）；执行身份断言按平台分支且有测试。
- AC-14 git 全链路在 win32 可用：clone/fetch/worktree add/stash 快照/diff（含 `NUL` 替代 `/dev/null` 的两处 argv）、askpass 子命令化后的 HTTPS 凭据注入、`core.longpaths` 前缀生效；git 硬化（hooksPath/fsmonitor/ext-diff）行为不变并有 win32 腿测试。
- AC-15 MCP：远端 MCP 在 win32 与 POSIX 同形；本地 stdio MCP / 探测在 win32 对 `.cmd/.bat` 给出定向拒绝与指引（D17），原生 exe 正常。
- AC-16 claude-code runtime 在 win32 的 warn 档冒烟通过（credentials.json 路径读取、spawn、netless 面按 provider 缺失自然跳过）；真机核验（D4）。

### 脚本节点

- AC-17 python 探测链 `python3 → python → py` 在 win32 生效且探测结果入事件；node 不变；bash 走 Git Bash 探测（含显式配置入口），探测不到时启动期显式失败、失败码可区分「解释器缺失」。
- AC-18 脚本运行 env 的 win32 形态：`USERPROFILE`/`TEMP`/`TMP` 指向 run 私有目录，保留键表补 win32 系统键（`SystemRoot`/`COMSPEC`/`PATHEXT` 等，含大小写折叠）；`PYTHONPATH` 剔除防线在 win32 同样生效（回归测试）。
- AC-19 依赖预装（pip `--target` / npm `--prefix`）在 win32 可用；无 containment 的事实在事件/文档如实呈现（与 D20 一致）。

### 构建 / 发行 / CI

- AC-20 `bun run build:binary` 在 win32 产出 `dist\agent-workflow-windows-x86_64.exe`（含 `.exe` 后缀、平台名映射 `win32→windows`）；`build:binary:e2e` 同步产出 e2e 件与编译 stub；`e2e/harness.ts` 的后缀逻辑与之同步（两处一致性有测试锁）。
- AC-21 release.yml 矩阵加 windows；产物上传/命名与 README 下载指引更新（Windows 无需 `chmod +x`）。
- AC-22 ci.yml 四个矩阵 job 全部加 windows 并全绿；build smoke 段跨平台化（POSIX-only 构造清除或平台分支）；受影响的 source-lock 测试（`root-test-entrypoint` / `rfc224-e2e-compiled-seam` / `test-suite-policy` 等，完整清单见 design §9.5）逐条更新且仍然锁得住。
- AC-23 e2e 在 windows：stub 编译形态落地、`sqlite3` CLI 依赖移除（bun:sqlite + busy_timeout）、harness 关停走 win 分支；四 shard 全绿。
- AC-24 视觉基线第三套（`*-chromium-win32.png`，当前 48 场景）按 README option-A 流程生成并提交；视觉 job 的 windows 腿接入（权威 hosted 判定仍为 ubuntu，win32 为第三套基线比对）。
- AC-25 新增/修改的 Windows-gated skip 全部登记进 `ALLOWED_SKIP_COUNTS`；`REQUIRED_GATE_ACTIVATIONS` 若新增 `RUN_*` 开关须同步 CI 激活 marker。

### 呈现与文档

- AC-26 i18n 双语补齐全部新增文案（guidance、409、doctor、脚本节点解释器失败提示等）；`i18n-key-resolution` 与 parity 守卫绿。
- AC-27 `docs/sandbox.md`、`docs/OPENCODE_CONFIG.md`、README 的平台矩阵与「Windows 已知降级清单」（D20）落档；audit-backlog 登记 DPAPI、arm64、Job Object provider RFC 三条。
- AC-28 真机验收清单（plan §真机）逐项核验并记录：安装→启动→导仓→跑工作流→脚本节点三语言→stop→重启恢复→console 无弹窗→长路径仓。

## 7. 风险与后续

| # | 风险 | 处置 |
|---|---|---|
| R1 | **Windows 上业务 agent 零隔离**（连 warn 档的 bwrap/seatbelt 都没有），失陷 agent 即 daemon 用户权限 | D1 用户知情决策；UI/docs 如实呈现（D8/D20）；Job Object+AppContainer provider 作为已预埋接缝的后续 RFC，在 audit-backlog 登记。 |
| R2 | 后端 8k+ 测试在 windows 全量绿化的长尾（POSIX 专属用例逐个 gate、时序差异 flaky） | plan 按「先 windows job 进矩阵但允许分批 gate 登记 → 收敛到零未登记红」推进；skip 配额表逐条 review 防滥用。 |
| R3 | MAX_PATH 260：深仓 + worktree 前缀导致 checkout/构建失败 | D18 `core.longpaths` + 文档建议启用系统 LongPathsEnabled；真机用深路径仓核验（AC-28）；仍失败的场景如实报错。 |
| R4 | Windows runner 的 CI 时长/排队显著增加 | 矩阵并行 + 既有 15/20min timeout 审视；如超时按 job 精细拆分（plan 预留）。 |
| R5 | windows-arm64 原生产物缺失 | 开放项：Bun pin 升到含 `bun-windows-arm64` 的版本并验证后，或 hosted windows-11-arm runner 原生构建可行后，追加 release 腿（独立小改动，不阻塞本 RFC）。 |
| R6 | opencode 上游 Windows 弱项（PTY、FFF 默认关、MCP 子孙清理 no-op）影响体验 | 如实呈现（D20），不代修；孤儿回收兜底由平台侧 taskkill 树杀灭承担。 |
| R7 | e2e stub 编译化改变既有 POSIX e2e 行为 | stub 迁移逐 spec 对照（plan 列表），POSIX 腿先行全绿再接 windows 腿。 |
