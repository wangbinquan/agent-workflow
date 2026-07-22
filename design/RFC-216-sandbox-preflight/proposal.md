# RFC-216 沙箱环境自检 CLI（`agent-workflow sandbox`）

> 状态：Draft
> 承接 [RFC-205 运行时沙箱](../RFC-205-runtime-sandbox/proposal.md)。把 RFC-205
> `design.md:145`「bwrap 缺失的发行版需手工安装（**文档给出指引**）」里的"指引"
> 从静态文档升级为**发行版感知、复用真实探测器的只读 CLI**。

## 1. 背景

RFC-205 落地了运行时 FS 沙箱：macOS 用系统自带的 `sandbox-exec`（Seatbelt），
Linux 用 `bwrap`（bubblewrap，需安装且允许非特权 user namespaces）。探测**以真实
试跑为准**（`services/sandbox/probe.ts:32`——存在 ≠ 可用）。机制不可用时的现状：

- Settings→Runtime 徽章显示「沙箱不可用」（黄，`SandboxCard.tsx:86`）；
- `warn` 档（默认）降级裸跑 + 每任务一条 `sandbox-degraded` 告警（`runner.ts:884`）；
- `enforce` 档启动任务直接 409 `sandbox-unavailable`，错误串里塞了一句
  「install bubblewrap」（`task.ts:1327`）。

但用户在 Linux 上遇到「沙箱不可用」时，"怎么修"只散落在两处：① 那句 409 错误串；
② `docs/sandbox.md` 的静态说明。用户仍要自己判断是「没装 bwrap」还是「userns 被
禁」（两种失败形态在 `probe.ts:56-61` 分得很清，但没暴露给操作者）、自己查对应发行版
的安装命令、自己记得**装完要重启 daemon**（探测是开机缓存的，`probe.ts:67`）。

这套判断本可以由二进制自己做——它已经内置了真实探测器。

## 2. 目标

- **G1**：新增独立子命令 `agent-workflow sandbox`，一条命令给出完整自检报告——
  当前机制 / 是否可用 / 为什么不可用 / **精确修复命令** / 是否需重启 daemon。
- **G2**：复用 RFC-205 的真实探测器 `probeSandboxMechanism`，**不另写一套探测**；
  报告结论与 daemon / Settings 徽章**同源**（同一 `SandboxStatus`）。
- **G3**：报告**包管理器感知**——`Bun.which` 按 apt>dnf>pacman>apk>zypper 取 **PATH 首
  命中**，打印对应安装命令并**如实标注「检测到 PATH 上的包管理器」**（不谎称匹配发行版，
  决策 C）；区分「未装 bwrap」（打印安装命令）与「已安装但试跑失败」（先给 stderr 证据，
  sysctl 仅作**有条件**排障方向、非确诊 userns），而不是一句笼统的 "install bubblewrap"。
- **G4（安全红线）**：命令**只读**——只探测、只打印。二进制自身**绝不以 root 改动
  系统**（不跑包管理器、不改 sysctl、**不写任何文件**——连读配置都走只读
  `readConfig`，缺文件也不建目录/不落默认 config，见 design §2/§6）。需要 root 的命令由它
  **打印**、由操作者执行。命令本身**无需 sudo、无需 daemon 在跑**。
- **G5**：可脚本化——**默认**：机制可用或 `mode=off` 退出 0，`mode≠off` 且不可用退出
  1；**`--require-available` 严格档**：机制真不可用即非零（含 off），供 CI/provisioning
  「必须真有沙箱」的门禁用。既不误绿、也不惩罚主动关沙箱的人（决策 A）。

## 3. 非目标

- **不做自动安装 / 自动改 sysctl**（用户 2026-07-22 明确拍板「独立 sandbox 命令 +
  只检测 + 打印，不动手」）。二进制永不以 root 变更主机——这也与 RFC-205「探测不安装」
  的既有 stance 一致，本 RFC 是其**强化**而非反转。
- 不做交互式 TUI；纯打印。
- **不新增任何运行时行为**——不碰 daemon 的探测缓存、不碰 launch 门（`task.ts:1318`）、
  不碰 warn 降级、不碰 status API / Settings。只是给既有 `SandboxStatus` 换一个操作者
  友好的呈现面。
- 不根治受限容器（无 `CAP_SYS_ADMIN` / userns 被容器策略禁）的「装了也起不来」——那
  超出主机层能力，报告会**诚实提示**「维持 warn/off 或在容器边界隔离」。

## 4. 用户故事

1. 我在没装 bwrap 的 Ubuntu 服务器上升级到本版本，Settings 显示「沙箱不可用」。我跑
   `agent-workflow sandbox`：机制=bwrap、不可用、原因=未找到 bwrap、修复=
   `sudo apt-get install -y bubblewrap`、装完重启 daemon。照做后再跑一次显示 ✅。
2. 我装了 bwrap 但仍不可用。`agent-workflow sandbox` 报告「已安装但试跑失败（exit N）」+
   stderr 摘要，并**有条件**提示「若确为非特权 userns 受限（容器常见），可尝试以下 sysctl
   （扩大全机攻击面、自行权衡）」，同时说明受限容器可能无解、可退回 warn/off。
3. 我在 macOS 上好奇沙箱状态。`agent-workflow sandbox` 显示 ✅ seatbelt、随系统自带、
   无需安装。
4. 我写机器初始化脚本，想在 CI / provisioning 里断言沙箱**实际生效**：
   `agent-workflow sandbox --require-available` 退出码 0 即通过（mode=off 或机制不可用都会
   非零、不会误绿——见决策 A）。

## 5. 验收标准

- **AC-1**：macOS 打印 `seatbelt` + 真实试跑得出的可用性；可用时退出 0。
- **AC-2**：Linux **`Bun.which('bwrap')`→null（未装）** → 报告注明「PATH 上未找到
  bwrap」+ 打印检测到的包管理器安装命令、**如实标注「检测到 PATH 上的包管理器：X」**
  （不谎称匹配发行版，决策 C）；未知包管理器回退通用指引；`mode≠off` 时退出 1。
- **AC-3（P1#2/P1-3）**：Linux **`Bun.which('bwrap')`→路径但探测非零且非超时** → 报告注明
  「已安装但试跑失败（exit N）」+ **先给 stderr 摘要证据**，sysctl 仅作**有条件**建议（「若
  确为 userns 受限」+ 安全提示，非无条件断言「userns 被禁」）；**不**打印安装命令；`mode≠off`
  时退出 1。真实 `exit 124`（`diag.kind==='exit' && exitCode===124`）不得被当成超时；只有
  `diag.kind==='timeout'` 才算超时。
- **AC-4（+ P2#2-r3）**：任一不可用（未装 / 装了坏 / timeout / spawn-error）且 `mode≠off` →
  报告含「装完 / 改完后需**重启 daemon** 生效（探测开机缓存）」；**表驱动断言**锁此提示在各
  不可用态 × warn/enforce **必现**、available/off **不现**，删提示的变异必红。
- **AC-5**：`sandboxMode=off` → 报告注明「config 已关闭沙箱」，**默认**退出 0。
- **AC-5b（决策 A，P1#1）**：退出码走 design §5 **单一真值表**。`--require-available`
  = **`mode≠off && 机制可用`** 才退 0——**off 即便机制可用也退非零**（off ⇒ 沙箱未实际
  生效）；默认档 off 恒退 0（含探测 throw/timeout）。探测异常（`Bun.spawn` 抛 / 超时 /
  config 损坏）**一律归 unavailable 走真值表**，不越过 renderer 崩到 exit 1、必出报告。
  子进程测试锁 `off+available`/`off+timeout`/`off+throw` 三交叉格。
- **AC-5c（决策 D，P1#3-r4）**：`configReadable=false`（config 损坏）→ 默认与严格档**均
  exit 2**（`configReadable` 与 `mechanismAvailable` **两轴独立**，绝不篡改 `available`——机制
  状态照实展示）；报告注「config 不可读（<err>），无法确定生效 sandboxMode」。
- **AC-6（只读断言，P1-1 + P1-2 + P1#1-r3）**：命令全程**不写任何文件**（含缺 config 不建
  目录/不落默认；读**已存在** config 也不回写）、**不执行任何禁令命令**（包管理器/sysctl/
  shell/sudo）。守卫①静态——`guidance.ts`/`cli/sandbox.ts` 禁 child_process/`Bun.$`/
  `execSync`/`spawnSync`/fs 写，`Bun.spawn` 仅在 `boundedSpawn` 内且只作 `probeSandboxMechanism`
  实参（调用点守卫）；②子进程**拆场景**（合法探测本就执行 bwrap，不能笼统"零执行"）——
  **A 未装 bwrap**→断言印出安装命令 + 禁令零执行 + 零写入；**B 装了坏**（假 bwrap 记 argv 后
  非零退出、不写禁令 sentinel）→断言**无**安装命令 + 探测 argv 精确白名单 + 禁令零执行 + 零
  写入；**macOS**——探针执行**绝对路径** `/usr/bin/sandbox-exec`（PATH 假程序不被调），故
  macOS argv 靠 **ProbeSpawnFn 单测层**锁、子进程只验零禁令/零写入（**禁止**为测试把绝对路径
  改 PATH 查找）。每场景把 **`HOME`/`AGENT_WORKFLOW_HOME`/`cwd`/`TMPDIR`/`XDG_CONFIG_HOME`/
  `XDG_CACHE_HOME`** 全指向受监控子目录逐目录快照（堵 cwd/tmp/XDG 逃逸）+ **底层 spawn seam
  记录全部 argv** 断言只出现 bwrap/seatbelt 白名单 + **cwd 写 / tmp 写 / 绝对路径 shell** 三个
  必红变异。**不用**匹配打印字符串的文本 grep。
- **AC-7**：报告结论与 `probeSandboxMechanism` 同源（仅经其 `spawnFn` 形参注入
  `boundedSpawn`），不另写探测。
- **AC-8（决策 B，P1-5）**：`doctor` 增加一条只读沙箱检查项；`ok = !(enforce &&
  不可用)`——仅 enforce+不可用判 fail，warn/off/可用 informational；测试覆盖整个
  `doctorCommand` 退出码的 mode×available 矩阵（warn+不可用**不**撞红 doctor）。
- **AC-9**：`help` / usage 列出 `sandbox` 子命令；子进程级测试锁 `<bin> sandbox` /
  `--help` 的 stdout/exitCode（把 `exit(ok?0:1)` 改恒 0 必红）。
- **AC-10（P2-2 + P1#4-r2 + P1#3-r3）**：机制探测有界——`boundedSpawn` **复用
  `killProcessTree`**（detached 进程组 SIGKILL，非可忽略 SIGTERM），**超时路径 + `finally`
  无条件**两处组杀（收「父先退 + 孙进程」泄漏，仿 `opencode.ts:142-154`）；超时 →
  `diag.kind==='timeout'` → 报告「探测超时」+ 退出 1。两个 fixture（仿 `rfc208`/`rfc135`）：
  ①假 bwrap 忽略 SIGTERM + 派生 marker 孙进程 → 有限返回 + 零 survivor；②假 bwrap fork
  marker 孙进程后**立即非零退出**（不触发 timeout）→ finally 组杀 → 零 survivor（漏 finally
  reap 必红）。**boundedSpawn 整生命周期归一（P2#1-r4）**：启动抛 / `proc.exited` reject /
  stderr reader reject **一律 catch → `diag.kind='error'`/unavailable、永不外泄**；stderr 用
  **流式 capped reader**（固定字节上限、非全缓冲，防 OOM）；故障注入测试（exited reject / stream
  reject / 超大 stderr）锁之。
- **AC-11（argv fail-closed，P2#1）**：`sandboxCommand` 用精确 allowlist 解析 argv；未知
  flag（含 `--require-availble` 拼错）/ 未知 positional / 缺值 → 写 stderr + **退出 2**，
  **绝不静默回退默认档**（否则 CI 拼错严格 flag 会在 off 下误退 0）。`--help` 优先。
