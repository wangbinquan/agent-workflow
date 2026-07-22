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
  系统**（不跑包管理器、不改 sysctl、不写任何文件）。需要 root 的命令由它**打印**、
  由操作者执行。命令本身**无需 sudo、无需 daemon 在跑**。
- **G5**：可脚本化——可用 / `mode=off` 退出码 0；`mode≠off` 且不可用退出码 1，便于
  provisioning / CI 里 `sudo … && agent-workflow sandbox` 链式确认。

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
- **AC-2**：Linux 未装 bwrap（探测 127）→ 报告注明「未找到 bwrap」+ 打印检测到的
  发行版安装命令；未知包管理器回退到通用 `install bubblewrap`；`mode≠off` 时退出 1。
- **AC-3**：Linux 装了 bwrap 但探测**非 127 非零** → 报告注明「疑似非特权 user
  namespaces 被禁」+ 打印 sysctl 指引 + 安全提示；**不**打印安装命令；`mode≠off`
  时退出 1。
- **AC-4**：任一不可用且 `mode≠off` → 报告含「装完 / 改完后需**重启 daemon** 生效
  （探测开机缓存）」。
- **AC-5**：`sandboxMode=off` → 报告注明「config 已关闭沙箱」，退出 0（不可用也不算
  失败）。
- **AC-6（只读断言）**：命令全程不执行任何包管理器 / sysctl / 写操作。守卫测试注入
  spawn spy，喂 unavailable 状态跑命令，断言 spawn 调用集合 ⊆ {沙箱探测命令}，绝不
  含 `apt|dnf|pacman|apk|zypper|sysctl|install` 的**执行**（这些 token 只允许出现在
  打印的字符串字面量里）。
- **AC-7**：报告结论与 `probeSandboxMechanism` 同源，不另写探测。
- **AC-8**：`doctor` 增加一条只读沙箱检查项，一行呈现机制 / 可用性（复用同一探测与
  指引 hint）。〔可选项：用户可在批准时砍掉，见 plan.md T3。〕
- **AC-9**：`help` / usage 列出 `sandbox` 子命令。
