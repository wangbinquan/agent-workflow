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
- **G3**：报告**发行版感知**——检测包管理器（apt / dnf / pacman / apk / zypper），
  打印**匹配当前发行版**的安装命令；区分「未装 bwrap」（打印安装命令）与「userns
  被禁」（打印 sysctl 指引 + 安全提示），而不是一句笼统的 "install bubblewrap"。
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
2. 我装了 bwrap 但仍不可用。`agent-workflow sandbox` 识别出这是 userns 被禁（探测非
   127 非零），打印对应 sysctl 命令 + 一句「这会扩大全机攻击面，自行权衡」，并提示
   受限容器场景可能无解、可退回 warn/off。
3. 我在 macOS 上好奇沙箱状态。`agent-workflow sandbox` 显示 ✅ seatbelt、随系统自带、
   无需安装。
4. 我写机器初始化脚本，想在 CI / provisioning 里断言沙箱就绪：
   `agent-workflow sandbox` 退出码 0 即通过。

## 5. 验收标准

- **AC-1**：macOS 打印 `seatbelt` + 真实试跑得出的可用性；可用时退出 0。
- **AC-2**：Linux **`Bun.which('bwrap')`→null（未装）** → 报告注明「PATH 上未找到
  bwrap」+ 打印检测到的包管理器安装命令、**如实标注「检测到 PATH 上的包管理器：X」**
  （不谎称匹配发行版，决策 C）；未知包管理器回退通用指引；`mode≠off` 时退出 1。
- **AC-3（P1#2/P1-3）**：Linux **`Bun.which('bwrap')`→路径但探测非零且非超时** → 报告注明
  「已安装但试跑失败（exit N）」+ **先给 stderr 摘要证据**，sysctl 仅作**有条件**建议（「若
  确为 userns 受限」+ 安全提示，非无条件断言「userns 被禁」）；**不**打印安装命令；`mode≠off`
  时退出 1。真实 `exit 124` 不得被当成超时（`diag.timedOut` 独立布尔判定）。
- **AC-4**：任一不可用且 `mode≠off` → 报告含「装完 / 改完后需**重启 daemon** 生效
  （探测开机缓存）」。
- **AC-5**：`sandboxMode=off` → 报告注明「config 已关闭沙箱」，**默认**退出 0。
- **AC-5b（决策 A，P1#1）**：退出码走 design §5 **单一真值表**。`--require-available`
  = **`mode≠off && 机制可用`** 才退 0——**off 即便机制可用也退非零**（off ⇒ 沙箱未实际
  生效）；默认档 off 恒退 0（含探测 throw/timeout）。子进程测试锁
  `off+available`/`off+timeout`/`off+throw` 三交叉格。
- **AC-6（只读断言，P1-1 + P1-2 + P1#3）**：命令全程**不写任何文件**（含缺 config 不建
  目录/不落默认；读**已存在** config 也不回写）、**不执行任何禁令命令**（包管理器/sysctl/
  shell/sudo）。守卫**区分合法探测与禁令**（合法探测本就执行 bwrap，不能笼统"零执行"）：
  ①静态——`guidance.ts`/`cli/sandbox.ts` 禁 child_process/`Bun.$`/`execSync`/`spawnSync`/fs
  写，`Bun.spawn` 仅在 `boundedSpawn` 内且它只作 `probeSandboxMechanism` 实参（调用点守卫）；
  ②子进程 sentinel——全新 HOME，PATH 放**禁令二进制**（apt-get/dnf/pacman/apk/zypper/sudo/
  sysctl/sh 各写 sentinel）+ 假 bwrap（不写禁令 sentinel），断言禁令 sentinel **全未写** +
  HOME 零写入（无 config.json）+ 报告**印出**安装指引 + 探测 argv 精确白名单一次。**不用**
  匹配打印字符串的文本 grep。
- **AC-7**：报告结论与 `probeSandboxMechanism` 同源（仅经其 `spawnFn` 形参注入
  `boundedSpawn`），不另写探测。
- **AC-8（决策 B，P1-5）**：`doctor` 增加一条只读沙箱检查项；`ok = !(enforce &&
  不可用)`——仅 enforce+不可用判 fail，warn/off/可用 informational；测试覆盖整个
  `doctorCommand` 退出码的 mode×available 矩阵（warn+不可用**不**撞红 doctor）。
- **AC-9**：`help` / usage 列出 `sandbox` 子命令；子进程级测试锁 `<bin> sandbox` /
  `--help` 的 stdout/exitCode（把 `exit(ok?0:1)` 改恒 0 必红）。
- **AC-10（P2-2 + P1#4）**：机制探测有界——`boundedSpawn` **复用 `killProcessTree`**
  （detached 进程组 SIGKILL，非可忽略的 SIGTERM）；超时 → `diag.timedOut` → 报告「探测超时」
  + 退出 1。fixture 仿 `rfc208-unbounded-git-and-permits`：假 bwrap **忽略 SIGTERM + 派生带
  marker 孙进程** → 断言**有限时间返回** + **零 survivor**。
- **AC-11（argv fail-closed，P2#1）**：`sandboxCommand` 用精确 allowlist 解析 argv；未知
  flag（含 `--require-availble` 拼错）/ 未知 positional / 缺值 → 写 stderr + **退出 2**，
  **绝不静默回退默认档**（否则 CI 拼错严格 flag 会在 off 下误退 0）。`--help` 优先。
