# RFC-254 · Windows 原生执行支持

状态：Draft（待设计门 + 用户批准）
日期：2026-08-04
关联：RFC-205 / RFC-227 §5.3 / RFC-233（containment 接缝）、RFC-224（执行身份）、RFC-253（脚本节点）、RFC-252（安全定调）

## 1. 背景

平台目前只支持 macOS + Linux（`README.md:194` 明写 "Windows release binaries are not shipped yet"）。用户要求：**让本平台支持 Windows 执行**——即 Windows 原生（win32 单二进制 `.exe` daemon），不是 WSL 文档化。

研究结论支持可行性（详细锚点见 `design.md §0`）：

- **opencode 是 Windows 一等公民**（本机 checkout `cb562b2c` = v1.18.4 源码实证）：官方发 Azure 签名的 windows x64/arm64/x64-baseline 二进制，CI 在 windows-2025 跑 unit+e2e；shell 工具无需 POSIX shell（默认 `pwsh → powershell → git-bash → cmd.exe`）；`opencode serve` 走 TCP（默认 `127.0.0.1`，纯 loopback 是我们配置出来的、非源码保证）；`OPENCODE_CONFIG_CONTENT` 注入链在 Windows 同形；配置目录走 XDG-in-USERPROFILE 语义。
- **本仓准入核心为 Windows 留好了缝**：RFC-227 §5.3 明文预留 Job Object/AppContainer provider 义务；注入 `windows-appcontainer-v1` / `windows-job-object-fixture` 的两条 contract test 今天就是绿的。
- **参考仓 multica 已在 Windows 真实驱动 opencode**，坑与解法现成：npm `.cmd` shim 截断 argv → 解析原生 exe 直接 spawn；无进程组 → `taskkill /T /F`；隐藏 console 防弹窗风暴。

真正的移植工作面集中在：①**进程生命周期治理**（POSIX 的进程组语义是 store 回收证明的基础，Windows 需 Job Object 提供等价物）；②**verified 执行链路的 Windows 形态**（artifact layout + 存储信任原语 + 子进程物化三层）；③containment 无 provider 时的行为收口；④一批确定性平台差异（`/dev/null`、PATH 分隔符、env 键大小写、路径长度、命令行长度上限）；⑤构建/发行/CI（单二进制不做交叉编译，矩阵被 source-lock 测试逐字锁定）；⑥脚本节点解释器（`python3`/`bash` 在 Windows 无同名命令）；⑦一批初稿遗漏的子系统（备份/归档、SCIP 索引、记忆蒸馏、定时任务）。

> **2026-08-04 双路设计门后修订**（记档 [`design-gate-2026-08-04.md`](./design-gate-2026-08-04.md)）：Codex 与独立子代理**均判定不通过**（6+1 条 P0），逐条实读源码核实后除 1 条外全部属实并已折入。其中 **②与①的深度被初稿严重低估**：verified 链路不是「不写一个 shell 键」而是三层都要设计；进程治理不是「taskkill 就够」而是 Job Object 为正确性必需。**这改变了 D9 的技术前提**（D1「不做隔离 provider」不受影响）。

## 2. 目标

1. **Windows x64 原生 daemon**：`agent-workflow-windows-x86_64.exe` 单二进制，`start / stop / doctor / sandbox` 等 CLI 子命令全部可用，daemon 生命周期（单实例锁、优雅关停、小时级后台任务、孤儿回收）在 Windows 语义下正确。
2. **任务执行全链路**：opencode verified 驱动（seal + 受控 config + 直接 API + session 归属）、git worktree 物化、输出 envelope、fanout/wrapper、评审/反问在 Windows 上端到端可用（无隔离档位，见 D1）。含三块设计门补入的必要工作：**win32 verified artifact layout**、**跨平台存储信任原语**（替代散点跳过 POSIX mode 检查）、**受控 PATH 含 git**（否则 agent 进程内无 git，主线工作流不成立）。
3. **进程生命周期正确性**：Job Object 提供「进程树」在 Windows 的权威归属与存活证明，使 runtime store 的回收/复用判定在 Windows 上与 POSIX 同样可靠。
4. **脚本执行节点**（RFC-253）在 Windows 可用：python/node 原生，bash 依赖 Git for Windows（D3）；断网/只读档按既有 failClosed 语义显式拒绝。
5. **CI / 发行一步到位全矩阵**（D2）：release 加 windows x64 产物；`ci.yml` 的 test-backend / test-frontend / build-binary / e2e 四个矩阵 job 全部加 windows；视觉基线第三套（win32）；相关 source-lock 测试同步更新。
6. **诚实的无隔离呈现**：Windows 上 `warn`/`off` 可跑并如实标注未隔离；`enforce` 与 failClosed profile 显式拒绝，文案 capability-driven（不硬编码 OS 补救话术）。

## 3. 非目标

- **Windows containment 隔离 provider**（AppContainer / 受限令牌 / WFP 网络围栏，以及把 Job Object 注册成 containment provider 以主张 `descendantLifetimeBound=strong`）——后续独立 RFC；本 RFC 只保证准入接缝按 RFC-227 §5.3 契约保持可插（两条既有 contract test 不许退化）。**注意区分**：本 RFC **确实要实现 Job Object**，但只用于进程生命周期治理（杀树 + 存活证明），不注册 provider、不主张 containment 能力、不改准入判定（D9）。
- **powershell 脚本类型**（脚本节点第四语言）——产品面扩张，另立 RFC。
- **windows-arm64 原生产物**——开放项（见 §7 R5）；x64 产物经 Prism 仿真覆盖 arm64 用户。
- **WSL 支持文档化**——WSL 走既有 Linux 产物，不属本 RFC 交付。
- **DPAPI 级秘密加密**——登记 audit-backlog。（**注意：Windows ACL 断言不再是非目标**——设计门 P0-C 证明 verified 存储的信任证明必须有 win32 实现，否则 receipt 说「已验证」而实际零验证；见 D22。）
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
| D6 | 产物只发 **windows x64**（`agent-workflow-windows-x86_64.exe`）；arm64 登记开放项 | 本仓单二进制**有意不做交叉编译**（`scripts/build-binary.ts:17-19`），且构建冒烟要真的**执行**产物（交叉产物在构建机上跑不了）。**订正**：pin 的 Bun 1.3.13 **完全支持**交叉编译到 `bun-windows-x64` 与 `bun-windows-arm64`（本机实测均产出合法 PE32+），所以 arm64 缺席是**政策问题不是能力问题**；x64 产物在 arm64 Windows 经 Prism 仿真可用。 |
| D7 | `appHome` 保持 `~/.agent-workflow`（即 `%USERPROFILE%\.agent-workflow`），不迁 `%LOCALAPPDATA%` | 与 opencode 的 XDG-in-USERPROFILE 先例一致（`%USERPROFILE%\.config\opencode`）；`AGENT_WORKFLOW_HOME` 可覆盖；避免三平台布局分叉。 |
| D8 | `sandboxMode` 语义与默认值（`warn`）在 Windows **不变** | RFC-252 用户定调「做安全不能把功能限制住」；warn 档每任务一条 sandbox-degraded 告警的既有机制在 Windows 自动生效，呈现如实。enforce 的 409 文案改为 capability-driven（删掉硬编码的 macOS/Linux 补救话术，`task.ts:1872`）。 |
| D9 | 进程治理选型（**设计门 P0-D 后修订**）：**Job Object + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`** 作为「进程组」的 Windows 对应物，经 Bun FFI 调 kernel32；`taskkill /T /F` 仅作 Job 不可用时的回退（回退状态进 receipt，**不支撑 store 回收证明**）；命令行查询用 `Get-CimInstance Win32_Process`（pid-reuse 防护）；`Bun.spawn` 在 win32 传 `windowsHide: true`、保留 `detached: true` | **初稿的「taskkill 枚举 + 单 pid 判活」被证伪**：`verifiedLauncher.ts:206,928,1237` 以进程组为所有权单位，group 不存活 ⇒ 标记 reaped ⇒ **释放 SQLite store 供复用**；单 pid 判活会在后代仍持有 store 时错误释放 = 数据损坏。Job Object 提供原子 kill-on-close + 权威存活计数，是正确性必需，不是纵深防御。上游 opencode 已有 Bun FFI 调 kernel32 先例（`packages/tui/src/terminal-win32.ts`），不引第三方原生依赖。**注意：这是进程生命周期治理，不是 containment 隔离，与 D1 不冲突。** |
| D10 | `agent-workflow stop` 在 win32 走 **独立 loopback control listener**（不挂业务 app、不复用业务认证），认证用**每次启动随机生成、退出即失效的 shutdown nonce**（落私有 control 文件，进秘密清单）；POSIX 保持 SIGTERM | Windows 上 `process.kill(pid,'SIGTERM')` 等于 TerminateProcess 强杀，30s graceful 预算完全失效（`cli/stop.ts:46`）。**初稿的「读 `.daemon.info` 的 token」被证伪**（设计门 P0-4）：该文件只有 `{pid,host,port,url,startedAt}`（`daemonInfo.ts:15-21`），且 bootstrap 后 daemon token 被拒（`auth/session.ts:171`）、`tokenAccess:'never'` 阻止令牌调用、admin 仍需会话、主服务还可能绑非 loopback（`start.ts:531`）。HTTP 传输没问题，错的是复用业务路由与业务认证。 |
| D11 | git askpass helper 从 POSIX sh 脚本改为**平台自身二进制的隐藏子命令**（`verifiedSelfCommand` 模式），三平台单实现。**迁移义务含 host 绑定、credential-helper stdin 协议、接线处先置空 helper 列表**（design §6 列全六条） | `services/gitCredential.ts:23-41` 现为 `#!/bin/sh` + sed/printf，Windows 无 shebang；「面向代码最合理，优于改动最小」——消灭而非分叉 POSIX 依赖。**设计门 ★3**：现 helper 带 host 匹配（impl-gate P0-2：防恶意 submodule remote 收割 PAT），初稿未列为迁移义务 ⇒ 照初稿实现即安全回归；且 `credential.helper` 是追加语义 + Git for Windows 默认启用 GCM ⇒ 不置空会被抢答。 |
| D12 | 受控 env 的 Windows 形态：白名单补系统必需键（`SystemRoot`/`COMSPEC`/`PATHEXT`/`TEMP`/`TMP`/`USERPROFILE`…）；私有 HOME 重定向 = `USERPROFILE` + `XDG_*`；PATH 用 `;` 拼受控目录；**env 键比较一律经平台感知的大小写折叠单点** | Windows env 键大小写不敏感，现有 `Set.has` / `delete env[k]` / `/^[A-Z]/` 精确匹配存在**安全语义**漏洞面（如 `SAFE_ENV_NAME` 全大写要求会把 `Path` 静默丢弃）；opencode 在 win32 依赖 `USERPROFILE`（`os.homedir()`）与 `xdg-basedir`（任意平台认 `XDG_*`），私有化路径照常成立。 |
| D13 | `/dev/null`→`NUL`、PATH 分隔符、`dirname` 等经**新的平台常量/纯函数单点**收口，不散落三元表达式 | e2e 已有正确范式（`e2e/command.ts:25`）；散落写法必然漂移。 |
| D14 | argv 长度守卫改**平台感知**：win32 按整条命令行序列化后长度对 32767 上限校验；POSIX 维持现状 | impl-gate 经验规律「固定字节阈值几乎总错」；`MAX_OPENCODE_PROMPT_BYTES=120KiB`（`runtime/opencode/spawn.ts:69-73`）只对 legacy argv 路径有意义，verified 路径 prompt 走直接 API 的 HTTP body 不受影响——守卫只需覆盖真正走 argv 的路径。 |
| D15 | e2e 的 `sqlite3` CLI 依赖替换为 **bun:sqlite 内联脚本**（显式 busy_timeout），全平台统一 | **硬性前提**：windows-2025 runner 镜像**确认不预装 sqlite3 CLI**（已查 runner-images 清单），不改则 windows e2e 腿必红。顺带消掉一个系统依赖与 dev-gotchas 里的 busy_timeout 坑面。相关 source-lock 同步改：`root-test-entrypoint.test.ts:346-347` **与 `e2e-sqlite-fixture-lock-contention.test.ts`**（后者整条锁的对象就是 sqlite3 CLI 的 busy_timeout，须改写为新形态的等价锁而非删除）。 |
| D16 | e2e 的 9 个 `#!/bin/sh` stub 统一迁为 **单一参数化 TS stub + `bun build --compile` 编译为原生可执行**（`build:binary:e2e` 顺带产出），三平台同一形态 | Windows 无 shebang；`.cmd` shim 有 CreateProcess 不直接可执 + argv 重整形坑（multica 实证）；编译成真实可执行文件让 runtime 选择器/seal 的「单可执行文件」约束在三平台同构成立。 |
| D17 | Windows 命令解析单点：新增 resolve 助手处理 `.exe/.cmd/.bat` 与 `PATHEXT`，`.cmd/.bat` **拒绝直接 spawn**并给出定向报错（引导用户填原生可执行路径），MCP/探测/解释器共用 | multica 的 `.cmd` shim argv 截断教训；Bun.spawn 不做 cross-spawn 式 shim 处理。 |
| D18 | git 硬化前缀在 win32 追加 `-c core.longpaths=true`；worktree 深路径风险另登记 | Git for Windows 默认 260 上限会让深仓 checkout 失败；`~/.agent-workflow/worktrees/{slug}/{taskId}` 天然加深路径。 |
| D19 | doctor / token / secret.key / db 的 POSIX mode 检查在 win32 **跳过并如实报告**「依赖 USERPROFILE ACL」；不伪造等价保护 | 与 `binarySnapshot.ts` 既有 win32 跳过模式一致（`:85,176,183,228`）；DPAPI 加固进 audit-backlog。 |
| D20 | 每一处「Windows 上语义降级/缺失」必须**可见**：doctor 输出、Settings 状态、docs/sandbox.md 逐条列出（seal 无只读位、秘密文件无 mode、MCP 子孙清理弱、opencode FFF 默认关…） | 与 RFC-253 F1/F2 同类教训：能力缺失若不可见，就会被当成已交付。 |

### 5.3 设计门后新增决策（D21–D24，批准时一并确认）

| # | 决策 | 理由 |
|---|---|---|
| D21 | **win32 本地 stdio MCP：允许在 warn/off 下无隔离执行，并实现原生 direct-child materialization**（wrapperless：直接以 `{cmd,cwd,env}` 执行，不经 sh wrapper）。不新增 failClosed profile 去阻断它 | 设计门 P0-F 证明初稿两句话都错：`model-child-netless-v1` **不是** failClosed（`containmentCoordinator.ts:28-79`），provider 为 `none` 时 `sealedSubprocess.ts:1218` **直接执行**——所以现状是「无隔离直跑」不是「失败」；但 `:928-942` 又**无条件**物化 `#!/bin/sh` wrapper ⇒ Windows 上跑之前就挂。选 (a) 而非 (b)「阻断」是因为后者会让**装了本地 MCP 的 agent 在 Windows 上完全不能跑**，与 D1「不做 provider 但功能可用」直接冲突 |
| D22 | **抽出单一跨平台 verified-storage 信任原语**（私有性 / 非链接 / 文件身份三条断言各有平台内实现：POSIX 用 mode+lstat+dev/ino，win32 用 owner+DACL / reparse point / `FileIndex`+`VolumeSerialNumber`）。**禁止**继续用「win32 跳过 mode 检查」式散点降级 | 设计门 P0-C：POSIX 语义散布在 `verifiedManifest.ts:309`、`controlProtocol.ts:185`、`storeHygiene.ts:328`、`sealedInputs.ts:196,265`、`sourceGuard.ts:125`、`binarySnapshot.ts:190-191`；在 Windows 上这些值既可能拒绝合法文件、也可能给出**错误的安全证明**。散点跳过 = receipt 说「已验证」而实际零验证（RFC-253 F1 同型教训）。**若实现期证明 DACL 路径不可行，正确处置是显式阻断 win32 verified 并作为产品级 blocker，不是静默降级** |
| D23 | **平台面守卫一律是「全仓禁形态负向扫描 + 显式豁免注释白名单」**；站点计数由守卫实测产出并作棘轮，**RFC 文档不写死数字** | 设计门 ★4+★7：初稿三类「全量清单」全部名不副实（PATH 4→7、`startsWith` 4→6、kill 站点错 2 漏 4），且漏项里有两处是**真实功能破坏**（`pluginInstaller.ts:563` 的 GC 误删、`systemAgentRun.ts:208` 的 seed 全拒）。按人工清单驱动实现 = 实现与测试共享同一个错误 oracle |
| D24 | **初稿遗漏的四个子系统纳入范围**：备份/恢复/归档（`util/archive.ts` 的 tar）、结构化 diff 的 SCIP indexer、记忆蒸馏、定时任务 | 设计门 ★5：三份文档零提及，而它们在 Windows 上都会坏（tar 方言/缺失、`.cmd` shim 致 indexer 静默降级、distiller 继承 runtime 全部问题）。放着不管违反本 RFC 自己写的 D20「语义缺失必须可见」 |

## 6. 验收标准

> **可证伪性总则（设计门 ★7 定，逐条适用于下列全部 AC）**：每个 AC 必须有**独立于实现算法的 observable oracle**。
> 具体三条：①平台面覆盖率由**全仓负向扫描守卫**证明，不由「实施者维护的清单」证明（D23）；
> ②凡是「我们自己算」的（argv 序列化、受控 env 组装）必须用**真实子进程观察到的结果**验证，不能用同一份算法自证；
> ③无法自动化的项要求**原始证据**（真机记录须含机器版本、命令、产物 hash、原始输出），不接受「记录存在」当通过。

### 地基与进程治理

- AC-1 **全仓负向扫描守卫**（D23）对裸 `/dev/null`、`':'` PATH 拼接、`lastIndexOf('/')` 取目录、`startsWith(root+'/')` 四类形态**零命中**（posix-by-contract 站点经带注释的显式豁免白名单承认）；守卫本身做变异实证（新加一处违规形态必须变红）。**明确包含**初稿漏掉且属真实功能破坏的两处：`pluginInstaller.ts:563`（GC 引用判定，win32 会误删被引用的插件 generation）、`systemAgentRun.ts:208`（`assertSafeSeedPath`，win32 会拒绝一切合法 seed 路径）。
- AC-2 env 键比较（白名单、保留键、delete）全部经过大小写折叠单点，由负向扫描守卫证明无遗漏；win32 下 `Path`/`Temp`/`UserProfile` 等混合大小写键得到与全大写同等处理。**验证 oracle 是子进程实际看到的 environ**，不是我们组装出的对象。
- AC-3 `killProcessTree` / stale-run 清理 / 孤儿回收在 win32 走 **Job Object** 路径；pid-reuse 防护用 `Get-CimInstance` 命令行判据；POSIX 行为逐字节不变（既有测试全绿）。**oracle 必须是真实进程行为而非 mock argv**：起一个会 fork 孙进程的树 → 触发回收 → 断言**孙进程确实消失**（轮询 pid 列表），以及 store 在树消失前**不被释放**。
- AC-3b `isOwnedTreeAlive` 是 store 回收的唯一合法证据：构造「父退出但孙仍在」场景，断言 win32 上**不会**被判定为可回收（这是 P0-D 的直接回归锁；摘掉 Job 改回单 pid 判活必须变红）。
- AC-4 win32 上所有生产 spawn 传 `windowsHide: true`（负向扫描守卫证明无遗漏，不依赖人工计数）；真机核验长任务运行期间无 console 弹窗风暴（D4 真机项，须附截图/录屏）。
- AC-5 `agent-workflow stop` 在 win32 经 HTTP shutdown 通道触发优雅关停（30s 预算生效、锁释放、`.daemon.info` 清理）；POSIX 路径不变。CI windows 上有端到端 stop 测试。
- AC-6 单实例锁在 win32 正确（重复 start 拒绝、stale 锁按存活探测回收）。

### Containment 收口（无 provider）

- AC-7 win32 上 `warn` 档：任务可跑、每任务恰一条 sandbox-degraded 告警、admission receipt 的 reasonCodes 为 `['platform-unsupported','required-capability-missing']`；`enforce`：启动 409 + 运行期 admit 拒绝，文案不再硬编码 OS 补救话术；`off`：按既有语义。
- AC-8 脚本节点 `network:'deny'` / `readonly:true` 在 win32 三种模式下都按 failClosed 拒绝，失败码与文案沿用 RFC-253 既有体系；作者在前端能看到明确原因。
- AC-9 RFC-227/233 的 Windows provider contract tests（`rfc233-containment-coordinator.test.ts:206-274`、`rfc227-containment-provider.test.ts:63-105`）保持绿——本 RFC 不得让未来 provider 接入变难。
- AC-10 `agent-workflow sandbox` / `doctor` / Settings Sandbox 卡片在 win32 输出如实的「无可用隔离机制」状态与指引（i18n 双语）。

### opencode 运行链路

- AC-11 win32 上 verified 路径端到端：管理员选定 `opencode.exe` → seal（digest 复验 + D22 信任原语的 win32 断言）→ 受控 config 下发 → 直接 API 创建/恢复 session → envelope 解析入库。**证明途径改口径**（设计门 ★1/P0-5：现有编译 e2e 件用 `AW_E2E_UNVERIFIED_OPENCODE=true` 编译 ⇒ `markProductionOpencodeCommand` 永不打标 ⇒ driver 必走 legacy 分支 ⇒ **e2e 结构上到不了 verified**，且 `rfc224-e2e-compiled-seam.test.ts:28` 正锁着这条隔离）：①后端套件的**组件级** verified 覆盖（win32 腿）；②**新增 test-only verified protocol stub seam**，仍过 snapshot/manifest/identity/launcher/HTTP session 全路径；③真机用真 opencode 跑通业务工作流。**不得**把现有 unverified artifact 改名当 AC-11 证据。
- AC-12 受控 env 的 win32 形态正确：`USERPROFILE`+`XDG_*` 指向私有 store；`SystemRoot` 等系统必需键在白名单内；`PATH` 为 `;` 拼接的受控目录；对照断言「不含 daemon 继承的用户级意外键」。
- AC-13 受控 config 在 win32 不写 seal 内 `sh` 的 `shell` 键（opencode 走自身 `pwsh → … → cmd` 链）；执行身份断言按平台分支且有测试。**平台事实经准入计划注入**（不得在受守卫的计划核里读 `process.platform`），且 win32 语义可在任意 OS 上被注入直测。
- AC-13b win32 verified artifact layout 完整（设计门 P0-B）：home 解析认 `USERPROFILE`、snapshot 目标**保 `.exe` 后缀**、system/MCP 计划的禁用命令有 win32 等价物（不是 `/bin/false`）、无 sh wrapper 依赖。每条各有回归锁。
- AC-13c 受控 PATH **含解析并冻结的 git 目录**（设计门 P0-A）：oracle 是 **agent 进程内真实执行 `git --version` 成功**，不是断言 PATH 字符串含某子串；且断言受控 env 未因此泄漏用户 PATH 其余部分或 home。
- AC-14 git 全链路在 win32 可用：clone/fetch/worktree add/stash 快照/diff（含 `NUL` 替代 `/dev/null` 的两处 argv）、askpass 子命令化后的 HTTPS 凭据注入、`core.longpaths` 前缀生效；git 硬化（hooksPath/fsmonitor/ext-diff）行为不变并有 win32 腿测试。
- AC-15 MCP：远端 MCP 在 win32 与 POSIX 同形；`.cmd/.bat` 在 **`command[0]` 预检层**（不是 spawn 包装层——`mcpProbe` 走 SDK 的 `StdioClientTransport`）给出定向拒绝与指引（D17）；**原生 exe 在三条入口各自验收**：inventory probe / 交互 runtime test / 业务 session（D21 的 wrapperless direct-child materialization 必须在这三条上都成立）。
- AC-16 claude-code runtime 在 win32 的 warn 档冒烟通过（credentials.json 路径读取、spawn、netless 面按 provider 缺失自然跳过）。**本条为条件项**：真机档需要 claude 凭据，无凭据时以 CI 的 stub 冒烟结果交付并在验收记录中明确标注为条件项（设计门 P1-8）。

### 脚本节点

- AC-17 python 探测链 `python3 → python → py` 在 win32 生效且探测结果入事件；node 不变；bash 走 Git Bash 探测（含显式配置入口），探测不到时启动期显式失败、失败码可区分「解释器缺失」。
- AC-18 脚本运行 env 的 win32 形态：`USERPROFILE`/`TEMP`/`TMP` 指向 run 私有目录，保留键表补 win32 系统键（`SystemRoot`/`COMSPEC`/`PATHEXT` 等，含大小写折叠）；`PYTHONPATH` 剔除防线在 win32 同样生效（回归测试）。
- AC-19 依赖预装（pip `--target` / npm `--prefix`）在 win32 可用；无 containment 的事实在事件/文档如实呈现（与 D20 一致）。

### 设计门补入（D21–D24）

- AC-29 **argv 长度守卫**（D14，初稿完全没有独立 AC）：守卫落在**每个 process-creation authority**（含 `runGit`、doctor、archive、indexer），不只是 legacy opencode 与 `containedSpawn`；序列化规则与 Bun/libuv 的 Windows quoting 一致并计入 executable、NUL、`windowsVerbatimArguments`。**边界必须用真实 Windows 子进程实测**（手写 serializer 与单测共享同一算法即无效验证）。
- AC-30 **verified 存储信任原语**（D22）：三条断言（私有性 / 非链接 / 文件身份）各有 win32 实现与正反用例——reparse point（junction/symlink）被拒、他人可写的 DACL 被拒、合法文件通过；`dev`/`ino` 不再用于 win32。**变异实证**：把 win32 分支改成无条件 `true`，相关用例必须变红。
- AC-31 **本地 MCP wrapperless 物化**（D21）：win32 上本地 stdio MCP 在三条入口（inventory probe / 交互 runtime test / 业务 session）均能以原生 exe 真实跑通；无隔离事实在事件与 D20 清单如实呈现。
- AC-32 **shutdown nonce**（D10 修订）：control 文件按 D22 原语保护、每次启动重生成、daemon 退出即失效；用旧 nonce 调用被拒；该秘密进 §10 清单与 doctor 呈现。
- AC-33 **D24 四个子系统在 win32 端到端可用且降级可见**：备份→恢复往返、SCIP 索引成功与 timeout 两路（失败不得静默降级为 `build-failed`）、记忆蒸馏 distill/resume、定时任务的定时启动与恢复。

### 构建 / 发行 / CI

- AC-20 `bun run build:binary` 在 win32 产出 `dist\agent-workflow-windows-x86_64.exe`（含 `.exe` 后缀、平台名映射 `win32→windows`）；`build:binary:e2e` 同步产出 e2e 件与编译 stub。**oracle 是实际编译并执行该 `.exe`**——build 与 harness 共享同一后缀 helper，只断言字符串会让两边一起错（设计门 P1-8）。
- AC-21 release.yml 矩阵加 windows；产物上传/命名与 README 下载指引更新（Windows 无需 `chmod +x`）。
- AC-22 ci.yml 四个矩阵 job 全部加 windows 并全绿；build smoke 段跨平台化（POSIX-only 构造清除或平台分支）；受影响的 source-lock 测试逐条更新且仍然锁得住（完整清单见 design §8.4，设计门补入了 `rfc224-source-guard` / `e2e-sqlite-fixture-lock-contention` / `e2e-shell-stub-argv-contract` / `rfc205-git-credential` / `rfc208-boot-and-external-timeouts` / `rfc227-source-guard` 六条）。
- AC-23 e2e 在 windows：stub 编译形态落地、`sqlite3` CLI 依赖移除（bun:sqlite + busy_timeout）、harness 关停走 win 分支；四 shard 全绿。
- AC-24 视觉基线第三套（`*-chromium-win32.png`，**40 个场景 / 46 张 PNG**——设计门 F7 订正）按 README option-A 流程生成并提交；视觉 job 的 windows 腿接入（权威 hosted 判定仍为 ubuntu，win32 为第三套基线比对）。
- AC-25 新增/修改的 Windows-gated skip 全部登记进 `ALLOWED_SKIP_COUNTS`；`REQUIRED_GATE_ACTIVATIONS` 若新增 `RUN_*` 开关须同步 CI 激活 marker。

### 呈现与文档

- AC-26 i18n 双语补齐全部新增文案（guidance、409、doctor、脚本节点解释器失败提示等）；`i18n-key-resolution` 与 parity 守卫绿。
- AC-27 `docs/sandbox.md`、`docs/OPENCODE_CONFIG.md`、README 的平台矩阵与「Windows 已知降级清单」（D20）落档；audit-backlog 登记 DPAPI、arm64、Job Object provider RFC 三条。
- AC-28 真机验收清单（plan §真机）逐项核验并记录：安装→启动→导仓→跑工作流→脚本节点三语言→stop→重启恢复→console 无弹窗→长路径仓。

## 7. 风险与后续

| # | 风险 | 处置 |
|---|---|---|
| R1 | **Windows 上业务 agent 零隔离**（连 warn 档的 bwrap/seatbelt 都没有），失陷 agent 即 daemon 用户权限 | D1 用户知情决策；UI/docs 如实呈现（D8/D20）；AppContainer/WFP provider 作为已预埋接缝的后续 RFC，在 audit-backlog 登记。（本 RFC 的 Job Object 只治理进程生命周期，不提供隔离。） |
| R0 | **范围较初稿显著变大**：设计门证明 verified 链路要动三层（artifact layout / 信任原语 / 子进程物化）+ Job Object 进 v1 | 这是「诚实的范围」而非新增需求——初稿的小范围是低估的产物。若用户希望缩范围，唯一可讨论的切法是**分两个 RFC**：先交付 daemon+CLI+构建发行+脚本节点（不含 verified agent 执行），再交付 verified 执行链路；但那样第一阶段**跑不了 agent 任务**，产品价值有限。**建议维持单 RFC、按 PR 分批**。 |
| R2 | 后端 8k+ 测试在 windows 全量绿化的长尾（POSIX 专属用例逐个 gate、时序差异 flaky） | plan 按「先 windows job 进矩阵但允许分批 gate 登记 → 收敛到零未登记红」推进；skip 配额表逐条 review 防滥用。 |
| R3 | MAX_PATH 260：深仓 + worktree 前缀导致 checkout/构建失败 | D18 `core.longpaths` + 文档建议启用系统 LongPathsEnabled；真机用深路径仓核验（AC-28）；仍失败的场景如实报错。 |
| R4 | Windows runner 的 CI 时长/排队显著增加 | 矩阵并行 + 既有 15/20min timeout 审视；如超时按 job 精细拆分（plan 预留）。 |
| R5 | windows-arm64 原生产物缺失 | 开放项：Bun pin 升到含 `bun-windows-arm64` 的版本并验证后，或 hosted windows-11-arm runner 原生构建可行后，追加 release 腿（独立小改动，不阻塞本 RFC）。 |
| R6 | opencode 上游 Windows 弱项（PTY、FFF 默认关、MCP 子孙清理 no-op）影响体验 | 如实呈现（D20），不代修；孤儿回收兜底由平台侧 taskkill 树杀灭承担。 |
| R7 | e2e stub 编译化改变既有 POSIX e2e 行为 | stub 迁移逐 spec 对照（plan 列表），POSIX 腿先行全绿再接 windows 腿。 |
