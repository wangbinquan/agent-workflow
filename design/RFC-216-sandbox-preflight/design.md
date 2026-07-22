# RFC-216 技术设计（v2 —— 已过设计门修订，见 §10）

> 读序：先读 [proposal.md](./proposal.md)。核心一句话：**纯增量的呈现层 + 一条
> doctor 检查，零运行时行为改动。** v1 经 Codex 设计门（对抗自审）判 needs-revision
> （5 P1 + 2 P2，其中 P1-1「只读」被现有 `loadConfig` 直接证伪），本文为修订后的 v2。

## 1. 命令契约

```
agent-workflow sandbox                      # 打印自检报告 + 修复指引；退出码见 §5
agent-workflow sandbox --require-available   # 严格档（CI/provisioning）：机制真不可用即非零
agent-workflow sandbox --help                # 打印用法
```

- 入口：`main.ts` 加 `case 'sandbox':` → `sandboxCommand(Bun.argv.slice(3))`（返回
  `{ output: string; ok: boolean }`，与 `backup`/`restore`/`user` 同型）→
  `process.stdout.write(output)` + `process.exit(ok ? 0 : 1)`。
- **不需要 daemon 在跑，不需要 root。命令自身只读——不写任何文件、不执行任何包管理器 /
  sysctl。**

## 2. 数据流

1. **读配置（只读，P1-1 修）**：`readConfig(Paths.config)`（§3 新增，缺文件返回
   `null`、**绝不写盘**）→ `sandboxMode = readConfig(...)?.sandboxMode ??
   DEFAULT_CONFIG.sandboxMode`。**不再用 `loadConfig`**——它在缺文件时会
   `saveConfigRaw` 建目录写默认配置（`config/index.ts:26-30`），破坏只读承诺。
2. **有界探测（P2-2 修）**：`probeSandboxMechanism(process.platform, boundedSpawn)` ——
   复用 RFC-205 探测器（`probe.ts:32`，它本就接受 `spawnFn` 参数），但 CLI 注入
   `boundedSpawn`：带 deadline（默认 10s）+ 超时 `kill`+`await exited` 回收 + 超时返回
   哨兵码（124）。探测器逻辑零改动。得 `SandboxStatus {mechanism, available, detail}`。
   **进程内新鲜探测**（standalone 无 boot cache），回答「主机**此刻**是否就绪」。
3. **机制缺失判别（P1-3 修）**：Linux 且不可用时，用 `Bun.which('bwrap')`（查 PATH，
   **只读**）**硬区分**「未安装」（which→null）与「装了但起不来」（which→路径、探测非
   零）——**不再靠解析 exit 127 或 human `detail`**。
4. `renderSandboxReport({ platform, status, mode, requireAvailable, bwrapOnPath,
   packageManager })` → `{ text, ok }`（**纯函数**，无 fs / spawn / 退出）。
5. `packageManager`（Linux 不可用且未装 bwrap 时）← `detectPackageManager(has)`（`has` =
   谓词「二进制在 PATH」，CLI 用 `Bun.which` 注入 → 纯函数可测）。
6. CLI 打印 `text`，按 `ok` 退出码。

## 3. 模块与复用（严守「抽一次别 fork」）

| 职责 | 落点 | 复用 / 新建 |
| --- | --- | --- |
| 真实探测 | `services/sandbox/probe.ts` `probeSandboxMechanism`（**复用，绝不新写**；只经其 `spawnFn` 形参注入超时） | 复用 |
| **只读读配置** | `config/index.ts` 抽 **`readConfig(path): Config \| null`**（缺文件返回 null、不写）；`loadConfig` 重构为 `readConfig(path) ?? (saveConfigRaw(DEFAULT); return DEFAULT)` —— **既有 `loadConfig` 行为逐字节不变**（写盘语义保留给 daemon 等现有调用方），只多出纯读变体 | 抽公共 + 复用 |
| 纯呈现 + 指引 | **新建** `services/sandbox/guidance.ts` | `renderSandboxReport` / `detectPackageManager` / `installHint(pm)` / `usernsHint()`；**纯函数、零副作用**——不 import `node:child_process`、不调 `Bun.spawn`/`Bun.$`/`Bun.which`、不写 fs（只回字符串 / 枚举） |
| CLI 编排 | **新建** `cli/sandbox.ts` `sandboxCommand()` | 组合：`boundedSpawn`→probe + `readConfig` + `Bun.which` + `detectPackageManager` + `renderSandboxReport` + 打印。**唯一的 `Bun.spawn` 出现在 `boundedSpawn`，且只喂探测 argv**；无 `node:child_process`/`Bun.$`/`execSync`/fs 写 |
| doctor 检查 | `cli/doctor.ts` 加 `checkSandbox()`（复用 probe + `Bun.which` + `installHint`），返回既有 `CheckResult`；真值表见 §7 | 复用 |
| 分发 + help | `main.ts` `case 'sandbox'` + usage 行 | —— |
| 文档 | `docs/sandbox.md` 加「## 自检」节 | —— |

## 4. 报告文案骨架（示意，最终以实现为准；CLI 走中文，与 doctor/status 风格一致）

**Linux 未装 bwrap（`Bun.which`→null）：**
```
沙箱机制：bwrap（Linux bubblewrap）
状态：❌ 不可用 —— PATH 上未找到 bwrap
当前 sandboxMode：warn（机制不可用时任务将裸跑并逐任务告警）
检测到 PATH 上的包管理器：apt        ← 如实标注「PATH 首命中」，不谎称匹配发行版

修复：
  sudo apt-get update && sudo apt-get install -y bubblewrap
装完后需重启 daemon 生效（探测在开机时缓存一次）：
  agent-workflow stop && agent-workflow start
```

**Linux 装了 bwrap 但探测非零（`Bun.which`→路径，探测失败）：**
```
状态：❌ 不可用 —— bwrap 已安装但试跑失败（exit N；stderr: <摘要>）
bwrap 在 PATH 但起不来，最常见是非特权 user namespaces 被禁。可尝试（⚠️ 放开会
扩大全机攻击面，且以下为启发式推断、非确证，自行权衡）：
  # Ubuntu 24.04+
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
  # 老 Debian / RHEL 系……
受限容器（无 CAP_SYS_ADMIN / 容器策略禁 userns）可能无解——维持 sandboxMode
warn/off，或在容器边界隔离。
```

**探测超时（boundedSpawn 命中 deadline）：**
```
状态：❌ 不可用 —— 沙箱机制探测超时（>10s 未返回，已终止）
可能是机制在异常内核/容器环境卡住。维持 warn/off 或排查内核/容器配置。
```

**macOS 可用 / config 关闭**：同 v1（seatbelt 无需安装；off 注明「沙箱已关闭」）。

## 5. 退出码与失败模式

- **退出码（决策 A，P1-4）**：
  - 默认：`available || mode==='off'` → 0；`mode!=='off' && !available` → 1。
  - `--require-available`（CI/provisioning 严格档）：`available` → 0；否则（含 off、
    含不可用）→ 1。**这样默认不惩罚主动关沙箱的人，CI 想「必须真有沙箱」就加 flag。**
- **config 缺失（P1-1）**：`readConfig`→null → 用 `DEFAULT_CONFIG.sandboxMode`（warn），
  **不建目录、不写文件**。
- **config 损坏**（存在但解析失败）：捕获 → 按默认 warn 呈现 + 顶部提示「config 不可读，
  按默认 warn」，**不写盘**。
- **探测 throw**（不应发生——`boundedSpawn`/`defaultSpawn` 已 try/catch）：CLI 捕获，报告
  「探测失败」+ detail，退出 1（`--require-available` 同）。
- **探测挂起（P2-2）**：`boundedSpawn` 命中 deadline → `kill`+`await exited` 回收 →
  哨兵码 124 → 报告「探测超时」，退出 1。
- **未知平台**（非 darwin/linux）：probe 返回 `{mechanism:null, available:false}` → 报告
  「当前平台不支持沙箱」，退出（`mode!=='off' || requireAvailable` ? 1 : 0）。
- **未知包管理器**（Linux 未装 bwrap 且 `detectPackageManager`→null）：回退通用指引
  「用你发行版的包管理器安装 bubblewrap（apt-get / dnf / pacman / apk / zypper）」。

## 6. 只读保证（安全红线，对应 AC-6；P1-1 + P1-2 修）

「只读」= **不写任何文件** + **不执行任何包管理器 / sysctl / 写命令**。v1 的「注入
spawn-spy」被证伪（挡不住直接 `Bun.spawn`/`node:child_process`/fs 写），v2 用**三重**保证：

1. **`guidance.ts` 纯函数**：静态守卫断言它不 import `node:child_process`、不出现
   `Bun.spawn`/`Bun.$`/`Bun.which`/`execSync`/`spawnSync`、不出现 fs 写 API
   （`writeFileSync`/`mkdirSync`/`rmSync`/`renameSync`/`appendFileSync`…）。它只回字符串。
2. **`cli/sandbox.ts` 执行边界**：静态守卫断言不 import `node:child_process`、无 `Bun.$`/
   `execSync`/`spawnSync`、无 fs 写 API；**`Bun.spawn` 至多出现一次且在 `boundedSpawn`
   内**（其入参 argv 仅来自 `probeSandboxMechanism`——RFC-205 复用码，只构造
   sandbox-exec/bwrap+true）。
3. **子进程 sentinel 行为证明**（比静态更硬）：在**全新临时 HOME**、PATH 放**会写
   sentinel 文件的假 `apt`/`bwrap`/`sysctl`**，跑 `agent-workflow sandbox` →
   断言 ①sentinel **从未被写**（没执行任何包管理器/sysctl）②临时 HOME 里**没有
   config.json / 目录被创建**（P1-1 零写入）。把任一「打印」误改成「执行」或误用
   `loadConfig` → 该测试必红。

> 明确**不用**会匹配打印字符串的文本 grep（打印串本就含 `install`/`sysctl` 字样）。

## 7. doctor 检查真值表（决策 B，P1-5）

`checkSandbox()` 返回 `CheckResult {name:'sandbox', ok, message}`，`ok` 定义为
**`!(mode==='enforce' && !available)`**——只有 enforce 且机制不可用才判 fail（镜像
launch 409 门 `task.ts:1318`）：

| mode | available | ok | message |
| --- | --- | --- | --- |
| 任意 | true | ✅ | `seatbelt/bwrap 可用` |
| warn | false | ✅ | `机制不可用（<detail>）；warn 档任务将裸跑，安装指引见 agent-workflow sandbox` |
| off | false | ✅ | `沙箱由配置关闭` |
| enforce | false | ❌ | `enforce 档但机制不可用——所有任务将被拒（409）；见 agent-workflow sandbox` |

→ warn 机器缺 bwrap **不撞红** `doctor` / CI 的 `<bin> doctor` smoke；只有真正会挡所有
任务的 enforce+不可用才让 `doctorCommand` 退 1。checkSandbox 也经 `boundedSpawn` 探测
（不挂起）。

## 8. 测试策略（§CLAUDE.md test-with-every-change）

必写 case（首选纯函数可断言面 + 最低子进程/源码兜底）：

1. **`guidance.test.ts`（纯函数）**：`renderSandboxReport` 各态——darwin-ok /
   linux-未装(bwrapOnPath=false)+apt/+dnf/+pacman/+apk/+zypper/+unknown-pm /
   linux-装了但失败(bwrapOnPath=true) / linux-探测超时 / linux-ok / mode=off /
   `requireAvailable` 各态；断言：机制名、✅/❌、**安装命令 vs sysctl 指引互斥出现**、
   「PATH 首命中」如实措辞、「重启 daemon」提示、`ok` 位对退出码语义（默认 vs
   `--require-available`）。`detectPackageManager`：单命中 / 多命中优先序
   (apt>dnf>pacman>apk>zypper) / 全 miss→null。`installHint`/`usernsHint` 含关键 token。
2. **`config` 只读**：`readConfig` 缺文件→null 且**断言 home 目录零变化**（前后文件树
   快照）；存在→解析；`loadConfig` 缺文件仍写默认（既有行为回归锁）。
3. **只读守卫（§6）**：①静态守卫（`sandbox-cli-readonly-guard.test.ts`）——扫
   `guidance.ts`/`cli/sandbox.ts` 源码禁用清单 + `Bun.spawn` 至多一次；②子进程 sentinel
   测试——假 apt/bwrap/sysctl + 全新 HOME，断言零执行 + 零写入。变异必红。
3. **`sandbox-cli` 编排 + 子进程退出码（P2-1）**：子进程级跑真 `sandbox`（注入假
   PATH/HOME），断言 **stdout / stderr / 实际 exitCode**（ok→0 / unavail+warn→1 /
   off→0 / off+`--require-available`→非零 / 探测超时→1）；把 `main.ts`
   `exit(ok?0:1)` 改恒 0 必红。
4. **探测超时 fixture（P2-2）**：PATH 放**永不退出**的假 bwrap → `boundedSpawn` 超时 →
   报告「探测超时」+ 退出 1（有界，不挂起）。
5. **`doctor` 真值表（§7）**：`checkSandbox` + 整个 `doctorCommand` 退出码，覆盖
   mode×available 四格（尤其 enforce+不可用→doctor 退 1、warn+不可用→doctor 不红）。
6. **`main.ts` 分发**：源码层文本断言 `case 'sandbox'` + help 含 `sandbox`（最低兜底）。
7. **build:binary + 双 OS smoke**：编译后 `<bin> sandbox` / `<bin> sandbox --help` 跑出
   报告与预期退出码，不回归 golden argv / 既有子命令。

## 9. 与 RFC-205 的边界确认

- **不改探测器行为**：`probeSandboxMechanism` 只经其既有 `spawnFn` 形参注入 `boundedSpawn`
  ——探测逻辑、SBPL/bwrap 构造、缓存零改动（daemon 仍用默认 spawnFn，无超时行为变化）。
- **不改**：`policy.ts`、`index.ts`（wrapSandbox）、`task.ts` launch 门、
  `routes/runtimes.ts` status API、`SandboxCard.tsx`、config schema。
- **改**：`config/index.ts` 抽出 `readConfig`（`loadConfig` 行为逐字节不变，纯增只读
  变体）——这是被 P1-1 逼出的必要重构，惠及所有想只读配置的调用方。
- `design/RFC-205-runtime-sandbox/design.md:145`「文档给出指引」由本 RFC 的可执行 CLI
  兑现；RFC-205「二进制不自动安装」stance **不变**。

## 10. 设计门修订账（v1 → v2）

Codex 对抗自审判 needs-revision，7 findings 全部核实属实并修入：

| 编号 | v1 缺陷 | v2 修法 |
| --- | --- | --- |
| P1-1 | `loadConfig` 缺文件即 `saveConfigRaw` 写盘（`config/index.ts:26-30` 已坐实）→ 破「只读」 | §2/§3 抽只读 `readConfig`；§6 子进程测试断言零写入 |
| P1-2 | 注入 spawn-spy 挡不住直接 `Bun.spawn`/fs 写 | §6 改静态 import/调用白名单 + 子进程 sentinel 行为证明 |
| P1-3 | probe 只给 human detail、把非 127 全归 userns，据此打降安全 sysctl 是猜的 | §2 用 `Bun.which` 硬分「未装/装了坏」；§4 sysctl 强 hedge + exitCode/stderr，不确定不打降安全命令 |
| P1-4 | off/不可用仍退 0 → CI 误判就绪 | §5 决策 A：默认 off→0，加 `--require-available` 严格档 |
| P1-5 | doctor 新检查 ok 语义未定义 → 撞红 CI 或漏报 enforce 故障 | §7 决策 B：真值表仅 enforce+不可用判 fail + 全矩阵测 doctorCommand 退出码 |
| P2-1 | 退出码无子进程测试锁、失败矩阵缺项 | §8-3 子进程级 stdout/stderr/exitCode + 双 OS smoke + 补全矩阵 |
| P2-2 | probe 无超时，机制挂起则永久阻塞 | §2/§5 CLI 注入有界 `boundedSpawn`（probe.ts 零改动）+ §8-4 永不退出 fixture |

两个 Question 的产品裁定（用户 2026-07-22）：doctor 仅 enforce+不可用退 1（决策 B）；
「发行版感知」= PATH 首命中 + 如实标注、os-release 列 v1.1（决策 C）。
