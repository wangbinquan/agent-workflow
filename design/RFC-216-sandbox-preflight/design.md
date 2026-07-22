# RFC-216 技术设计

> 读序：先读 [proposal.md](./proposal.md)。本文只讲技术契约、复用点、失败模式、
> 测试策略。核心一句话：**纯增量的呈现层 + 一条 doctor 检查，零运行时行为改动。**

## 1. 命令契约

```
agent-workflow sandbox            # 打印自检报告 + 修复指引；退出码见 §5
agent-workflow sandbox --help     # 打印用法
```

- 入口：`main.ts` 加 `case 'sandbox':` → `sandboxCommand(Bun.argv.slice(3))`（返回
  `{ output: string; ok: boolean }`，与既有 `backup`/`restore`/`user` 子命令的
  `{ output, status }` 同型）→ `process.stdout.write(output)` + `process.exit(ok ? 0 : 1)`。
- **不需要 daemon 在跑，不需要 root**（纯只读）。

## 2. 数据流

1. `probeSandboxMechanism(process.platform)` —— 复用 RFC-205 探测器
   （`services/sandbox/probe.ts:32`），真实试跑得 `SandboxStatus {mechanism,
   available, detail}`。**这是进程内新鲜探测**（standalone 进程无 boot cache），回答
   「主机**此刻**是否就绪」——正是"我刚装完了吗"的可执行真相；与 daemon 的
   `getSandboxStatus()`（开机缓存）刻意不同，报告会点明"daemon 需重启才会重新探测"。
2. `sandboxMode` ← `loadConfig(Paths.config).sandboxMode`（文件缺失 / 损坏 → 回退
   默认 `warn`，见 §5）。
3. Linux 且不可用 → `detectPackageManager(has)` 得 `'apt'|'dnf'|'pacman'|'apk'|'zypper'|null`
   （`has` = 谓词「二进制在 PATH」，由 CLI 用 `Bun.which` 注入 → 纯函数可测）。
4. `renderSandboxReport({ platform, status, mode, packageManager })` → `{ text, ok }`
   （**纯函数**，无 fs / spawn / 退出）。
5. CLI 打印 `text`，按 `ok` 决定退出码。

## 3. 模块与复用（严守「抽一次别 fork」）

| 职责 | 落点 | 复用 / 新建 |
| --- | --- | --- |
| 真实探测 | `services/sandbox/probe.ts` `probeSandboxMechanism` | **复用，绝不新写** |
| 纯呈现 + 指引 | **新建** `services/sandbox/guidance.ts` | `renderSandboxReport` / `detectPackageManager` / `installHint(pm)` / `usernsHint()`，纯函数、零副作用 |
| CLI 编排 | **新建** `cli/sandbox.ts` `sandboxCommand()` | 调探测（唯一 spawn）+ `loadConfig` + `detectPackageManager(Bun.which)` + `renderSandboxReport` |
| doctor 检查 | `cli/doctor.ts` 加 `checkSandbox()` | 复用 probe + `installHint`，返回既有 `CheckResult {name,ok,message}` |
| 分发 + help | `main.ts` `case 'sandbox'` + usage 行 | —— |
| 文档 | `docs/sandbox.md` 加「## 自检」节 | —— |

- `guidance.ts` 只依赖 `SandboxStatus` 类型 + `SandboxMode` 类型，不 import 任何有副作用
  的模块 → 单测无需 daemon / fs。
- **不新增** policy / wrapSandbox / status API / Settings 的任何改动。

## 4. 报告文案骨架（示意，最终以实现为准；CLI 走中文，与 doctor/status 输出风格一致）

**macOS 可用：**
```
沙箱机制：seatbelt（macOS sandbox-exec，随系统自带）
状态：✅ 可用（已真实试跑）
当前 sandboxMode：warn
无需安装任何组件。
```

**Linux 未装 bwrap（探测 127）：**
```
沙箱机制：bwrap（Linux bubblewrap）
状态：❌ 不可用 —— 未在 PATH 找到 bwrap
当前 sandboxMode：warn（机制不可用时任务将裸跑并逐任务告警）

修复（检测到 apt）：
  sudo apt-get update && sudo apt-get install -y bubblewrap

装完后需重启 daemon 生效（探测在开机时缓存一次）：
  agent-workflow stop && agent-workflow start
```

**Linux userns 被禁（探测非 127 非零）：**
```
沙箱机制：bwrap（Linux bubblewrap）
状态：❌ 不可用 —— bwrap 试跑退出 N（疑似非特权 user namespaces 被禁）
...
bwrap 已安装但起不来，通常是非特权 user namespaces 被禁。可尝试（⚠️ 放开
会扩大全机攻击面，自行权衡）：
  # Ubuntu 24.04+
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
  # 老 Debian
  sudo sysctl -w kernel.unprivileged_userns_clone=1
  # RHEL 系（若为 0）
  sudo sysctl -w user.max_user_namespaces=15000
受限容器（无 CAP_SYS_ADMIN / 容器策略禁 userns）可能无解——维持 sandboxMode
warn/off，或在容器边界做隔离。
装完后重启 daemon 生效：agent-workflow stop && agent-workflow start
```

**config 关闭：**
```
当前 sandboxMode：off —— 沙箱已由配置关闭，agent 进程不被 FS 沙箱包装。
（如需启用，Settings→Runtime 或 `agent-workflow config set sandboxMode warn`）
```

## 5. 退出码与失败模式

- **退出码**：`available || mode==='off'` → 0；`mode!=='off' && !available` → 1。
- **config 读不出（损坏）**：捕获，按默认 `warn` 继续，报告顶部提示「config 不可读，
  按默认 warn 呈现」。**不因 config 崩掉自检**。
- **探测器 throw**（不应发生——`defaultSpawn` 已 try/catch 成 127）：CLI 捕获，报告
  「探测失败」+ detail，退出 1。
- **未知平台**（非 darwin/linux）：`probeSandboxMechanism` 返回
  `{mechanism:null, available:false, detail:'unsupported platform …'}` → 报告「当前
  平台不支持沙箱」，退出（`mode!=='off'` ? 1 : 0）。
- **未知包管理器**（`detectPackageManager`→null）：回退通用指引
  「用你发行版的包管理器安装 bubblewrap（Debian/Ubuntu: apt-get; Fedora/RHEL: dnf;
  Arch: pacman; Alpine: apk; openSUSE: zypper）」，仍打印。

## 6. 安全红线：只读保证（对应 AC-6）

- `renderSandboxReport` / `installHint` / `usernsHint` / `detectPackageManager` 全是
  纯函数：入参 → 字符串 / 枚举，**无副作用**。
- `sandboxCommand` **唯一允许的 spawn 是沙箱探测**（`probeSandboxMechanism` 内部
  spawn `sandbox-exec`/`bwrap` 套 `/usr/bin/true`|`/bin/true`）。**绝不** spawn 包
  管理器 / sysctl / 任何写命令；`detectPackageManager` 用 `Bun.which`（查 PATH，只读）
  而非执行探测。
- **守卫测试**（§7）：注入 spawn spy，喂各 unavailable 状态跑 `sandboxCommand`，断言
  记录到的 spawn argv 集合 ⊆ 探测命令白名单，且不含 `install`/`sysctl -w`/包管理器名
  的**执行**。把任一"打印指引"误改成"执行指引"→ 该测试必红。

## 7. 测试策略（§CLAUDE.md test-with-every-change）

必写 case：

1. **`guidance.test.ts`（纯函数，首选可断言面）**
   - `renderSandboxReport`：darwin-ok / linux-127+apt / +dnf / +pacman / +apk / +zypper /
     +unknown-pm / linux-userns(非127) / linux-ok / mode=off；断言：机制名、
     ✅/❌、安装命令 vs sysctl 指引的**互斥出现**、「重启 daemon」提示的出现与否、
     `ok` 位与退出码语义。
   - `detectPackageManager`：各单命中 + 多命中优先序（固定：apt>dnf>pacman>apk>zypper）
     + 全 miss→null。
   - `installHint` / `usernsHint`：含关键 token（`bubblewrap` / `sysctl` / 安全提示）。
2. **`sandbox-cli.test.ts`（编排 + 只读守卫）**
   - 注入 spawn spy + 假 config：退出码语义（ok→0 / unavail+warn→1 / off→0）；
   - **只读守卫**：唯一 spawn 是探测（§6），变异必红；
   - config 损坏 → 按 warn 继续不崩。
3. **`doctor` 测试** 补 `checkSandbox` 一例（available / unavailable 各一，注入 spawn）。
4. **`main.ts` 分发**：源码层文本断言 `case 'sandbox'` 存在 + help 文本含 `sandbox`
   （运行时巨型 switch 难直测时的最低兜底，符合 CLAUDE.md）。
5. **build:binary smoke**：新子命令进单二进制后 `<bin> sandbox` 能跑出报告（不回归
   golden argv / 既有子命令）。

## 8. 与 RFC-205 的边界确认

- 不改：`probe.ts`（除被复用）、`policy.ts`、`index.ts`（wrapSandbox）、`task.ts`
  launch 门、`routes/runtimes.ts` status API、`SandboxCard.tsx`、config schema。
- `design/RFC-205-runtime-sandbox/design.md:145` 的"文档给出指引"由本 RFC 的可执行 CLI
  兑现；RFC-205「二进制不自动安装」stance **不变**。
