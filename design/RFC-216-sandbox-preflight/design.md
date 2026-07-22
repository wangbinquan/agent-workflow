# RFC-216 技术设计（v4 —— 三轮设计门后定稿，修订账见 §10）

> 读序：先读 [proposal.md](./proposal.md)。核心一句话：**纯增量的呈现层 + 一条
> doctor 检查，零运行时行为改动。** 经 Codex 设计门三轮对抗（v1 5P1+2P2 / v2 4P1+2P2 /
> v3 4P1+2P2），本文 v4。

## 1. 命令契约（含 argv fail-closed，P2#1）

```
agent-workflow sandbox                      # 打印自检报告 + 修复指引；退出码见 §5
agent-workflow sandbox --require-available   # 严格档：沙箱未实际生效即非零（CI/provisioning）
agent-workflow sandbox --help                # 打印用法
```

- 入口：`main.ts` 加 `case 'sandbox':` → `sandboxCommand(Bun.argv.slice(3))` →
  `process.stdout.write(output)` + `process.exit(code)`。
- **argv fail-closed**：精确 allowlist——只认 `--require-available` 与 `--help`/`-h`；
  未知 flag（含 `--require-availble` 拼错）/ 未知 positional / 缺值 → stderr `unknown
  option: X` + **退出 2**（沿用 main.ts 未知子命令 exit 2 约定）。**绝不静默回退默认档**。
  `--help` 优先。
- 不需要 daemon、不需要 root。命令自身只读（§6）。

## 2. 数据流 + 有界探测 + 诊断

1. **读配置（只读，P1-1）**：`readConfig(Paths.config)`（§3）契约——**缺文件返 `null`**、
   **存在且合法返 Config（只读不回写）**、**存在但损坏抛 `Error`**（同 loadConfig 的 parse
   语义）。`sandboxCommand` **显式 try/catch** 包住它（P1#4-round3）：
   - null → `mode = DEFAULT_CONFIG.sandboxMode`（warn）；
   - 抛（损坏）→ 捕获，报告顶部「config 不可读（<err>），按 warn 呈现机制状态」，`mode=warn`
     续跑（不崩、不写盘）。
2. **有界探测 + 诊断（P1#2/#4 两轮）**：CLI 造 `boundedSpawn` 传给
   `probeSandboxMechanism(process.platform, boundedSpawn)`（复用 RFC-205 探测器，只经其既有
   `spawnFn` 形参）。`boundedSpawn(cmd): Promise<number>`：
   - `Bun.spawn({cmd, stdout:'ignore', stderr:'pipe', detached:true})` → 自成进程组
     （仿 `util/opencode.ts:83-154`/`git.ts:151-157`）。
   - **超时**：timer→`killProcessTree(proc.pid, 'SIGKILL')`（`util/process.ts:32`，
     `process.kill(-pid)` 杀整组含孙进程；**SIGKILL 非 SIGTERM**——TERM 可忽略会重挂，
     opencode.ts 明训）；记 `diag={kind:'timeout'}`。
   - **`Bun.spawn` 启动抛异常**（不存在的二进制在本机 Bun 会**抛**、非返 127——已实测；
     `defaultSpawn` 亦 catch→127，`probe.ts:21-27`）：`boundedSpawn` **catch 之**，记
     `diag={kind:'spawn-error', message}`，**返回哨兵 number（127）给探测器**（保证探测器得
     unavailable、不把异常泄漏到 renderer 之外）。**`boundedSpawn` 永不 throw。**
   - **正常退出**：记 `diag={kind:'exit', exitCode, stderrSnippet}`（stderr 有界读 + 截断，
     **不绑死 exit 等待**——孙进程可占 pipe 使 EOF 不来，opencode.ts 注释）；返回真实
     `exitCode`（保 SandboxStatus 同源）。
   - **`finally` 无条件回收（P1#3-round3）**：direct child settle 后，**无条件**再做一次
     best-effort `killProcessTree(proc.pid, 'SIGKILL')`，收掉「父进程先退、留后台孙进程」的
     泄漏（仿 `opencode.ts:142-154` finally 组杀；真实 exitCode 已先取，保留）；清 timer。
   - **`ProbeDiagnostics` = 判别联合**：`{kind:'exit',exitCode:number,stderrSnippet:string} |
     {kind:'timeout'} | {kind:'spawn-error',message:string}`。**`timedOut`/`spawn-error` 是独立
     kind、不塞进 exit code**——故真实 `exit 124` 与超时不撞码。probe 只调 spawnFn 一次。
3. **机制缺失判别（P1-3）**：Linux 且不可用时 `Bun.which('bwrap')`（查 PATH，只读）硬分
   「未装」（→null）/「装了但起不来」（→路径）。
4. `renderSandboxReport({ platform, status, diag, mode, requireAvailable, bwrapOnPath,
   packageManager, configUnreadable })` → `{ text, exitCode }`（**纯函数**）。渲染优先级：
   `diag.kind==='timeout'` → 探测超时；`spawn-error` 且 `bwrapOnPath` false → 视同未装；
   否则按 available / bwrapOnPath / mode。
5. `packageManager` ← `detectPackageManager(has)`（`has`=谓词，CLI 用 `Bun.which` 注入）。

## 3. 模块与复用

| 职责 | 落点 | 复用 / 新建 |
| --- | --- | --- |
| 真实探测 | `probe.ts` `probeSandboxMechanism`（复用，只经 `spawnFn` 注入） | 复用 |
| 进程组 kill | `util/process.ts` **`killProcessTree`**（复用；超时 + finally 两处调用） | 复用 |
| 只读读配置 | `config/index.ts` 抽 **`readConfig(path): Config \| null`**（缺→null、存在→只读解析、损坏→throw）；`loadConfig = existsSync ? readConfig 的解析分支 : (saveConfigRaw(DEFAULT); DEFAULT)` —— 既有行为逐字节不变 | 抽公共 + 复用 |
| 纯呈现 + 指引 | **新建** `services/sandbox/guidance.ts`（纯函数，零副作用） | 新建纯原语 |
| CLI 编排 | **新建** `cli/sandbox.ts` `sandboxCommand()`（argv allowlist + readConfig try/catch + boundedSpawn→probe + Bun.which + render） | 新建 |
| doctor 检查 | `cli/doctor.ts` 加 `checkSandbox()`（经 boundedSpawn；readConfig throw → 降级不 reject；真值表 §7） | 复用 |
| 分发/help/文档 | `main.ts` `case`；`docs/sandbox.md` 自检节 | —— |

> **观察（不在本 RFC 范围）**：有界-spawn 定式现 4 处（opencode.ts/opencode-models.ts/git.ts/
> 本 RFC），dedup 候选；本 RFC 先复用 `killProcessTree`，抽 `spawnBounded` 另立 RFC。

## 4. 报告文案骨架（示意，最终以实现为准）

- **未装 bwrap（`Bun.which`→null，或 spawn-error 且 which→null）**：❌ PATH 未找到 bwrap +
  「检测到 PATH 上的包管理器：apt」+ `apt-get install` + 重启 daemon 提示。
- **装了但探测非零（which→路径，`diag.kind==='exit'` 非零）**：❌ 已安装但试跑失败（exit N）+
  **stderr 摘要证据** + sysctl 作**有条件**建议（「若确为 userns 受限…」+ 安全提示，**非**无
  条件断言 userns）。
- **超时（`diag.kind==='timeout'`）**：❌ 探测超时（>10s，已 SIGKILL 整组回收）+ 排障。
- **config 不可读**：顶部注「config 不可读，按 warn 呈现」+ 上述机制分支。
- macOS 可用 / off：seatbelt 无需安装 / 「沙箱已关闭」。

## 5. 退出码真值表（P1#1，单一权威表）

`timeout` / `spawn-error` / 非零 exit / config 损坏后按 warn —— 一律归 `available=false`
（**探测异常绝不越过 renderer 崩到 main exit 1**；损坏 config 按 warn 走表）。设 A=available：

| mode | A | 默认退出码 | `--require-available` |
| --- | --- | --- | --- |
| off | true | **0** | **1** |
| off | false（含 throw/timeout） | **0** | **1** |
| warn/enforce | true | **0** | **0** |
| warn/enforce | false（含 throw/timeout） | **1** | **1** |

- 默认：`exit 0 ⟺ (mode==='off' || available)`。off 恒 0。
- 严格档：`exit 0 ⟺ (mode!=='off' && available)`。语义=沙箱**实际会包住 agent**（对齐决策 A）。
- argv 错误 → exit 2（§1，先于探测）。
- 退出码由**纯函数 `renderSandboxReport` 计算返回**，`main.ts`/`sandboxCommand` 只透传，子进程
  测试锁死。

## 6. 只读保证（P1-1 + P1-2 + P1#3-r2 + P1#1-r3）

「只读」= 不写任何文件 + 不执行任何**禁令命令**。合法探测**本就要执行 `bwrap`/`sandbox-exec`**，
守卫须**区分合法探测与禁令**（v2/v3 该点两轮被证伪）：

1. **`guidance.ts` 纯**（静态守卫）：不 import child_process、无
   `Bun.spawn`/`Bun.$`/`Bun.which`/`execSync`/`spawnSync`、无 fs 写。
2. **`cli/sandbox.ts` 执行边界**（静态守卫）：不 import child_process、无 `Bun.$`/`execSync`/
   `spawnSync`、无 fs 写；`Bun.spawn` 只在 `boundedSpawn` 内，且 `boundedSpawn` 只作
   `probeSandboxMechanism` 实参（调用点守卫）。
3. **子进程行为证明——拆两个 Linux 场景 + macOS（P1#1-r3）**，每个都把 **`HOME` 与
   `AGENT_WORKFLOW_HOME` 同时**指向受监控临时根（`paths.ts:8-20` 优先用后者，只隔离 HOME 会
   漏）：
   - **场景 A｜未装 bwrap**：PATH 无 bwrap、有会写 sentinel 的假 `apt-get`/`dnf`/…/`sysctl`/
     `sudo`/`sh` → 断言 ①禁令 sentinel 全未写 ②临时根零写入（**无 config.json**）③报告
     **印出** `apt-get install` 指引（打印≠执行）。
   - **场景 B｜装了但坏**：PATH 有**假 bwrap**（把自己被调 argv 写进 marker 文件后非零退出、
     **不写禁令 sentinel**）+ 同上假禁令 → 断言 ①禁令 sentinel 全未写 ②零写入 ③报告
     **不含**安装命令（AC-3）④marker 里探测 argv **精确匹配** `bwrap --bind / / -- /bin/true`。
   - **macOS 场景**：假 `sandbox-exec`（记 argv）+ 假禁令 → 零禁令执行 + 零写入 + 探测 argv
     精确匹配 `/usr/bin/sandbox-exec -p … /usr/bin/true`。

> **不用**匹配打印字符串的文本 grep。变异（打印→执行、误用 `loadConfig`、boundedSpawn 挪用、
> 漏 `AGENT_WORKFLOW_HOME` 隔离）→ 某测试必红。

## 7. doctor 检查真值表（决策 B，P1-5 + P1#4-r3）

`checkSandbox()`（经 `boundedSpawn` 探测，不挂起）返回 `CheckResult`，
`ok = !(mode==='enforce' && !available)`：

| mode | available | ok |
| --- | --- | --- |
| 任意 | true | ✅ |
| warn | false | ✅（提示：安装指引见 `agent-workflow sandbox`） |
| off | false | ✅（沙箱由配置关闭） |
| enforce | false | ❌（doctor 退 1） |

- **损坏 config（P1#4-r3）**：`checkSandbox` **自行 catch `readConfig` 抛**（按 warn 探测 +
  message 注「config 不可读」），**绝不让异常传播**——否则整个 `doctorCommand` 被 main 顶层
  catch 截断、用户看不到完整体检。config 损坏本身由既有 `checkConfig` 报（不重复判死）。

## 8. 测试策略

1. **`guidance.test.ts`（纯函数）**：`renderSandboxReport` 各态含 `diag.kind` 三值、
   `bwrapOnPath`、各包管理器/unknown、mode×available、`requireAvailable`、`configUnreadable`；
   断言机制名、✅/❌、**安装命令 vs sysctl 互斥**、sysctl 仅在 `kind==='exit'` 非零且有 stderr
   时出现、`exitCode` 返回值对 §5 真值表**逐格**（含 **off+available/off+timeout/off+throw**）。
   `detectPackageManager` 优先序 + 全 miss→null。
2. **`readConfig`（P2#2-r2）**：缺→null 零变化；已存在 partial→补齐嵌套默认 + **字节/stat
   不变** + 与 `loadConfig` 解析一致；损坏→throw 且不写；`loadConfig` 缺文件仍写默认（回归锁）；
   调用点守卫（readConfig 不可达 `save*`）。
3. **只读守卫（§6）**：静态白名单 + `boundedSpawn` 调用点守卫 + **三子进程场景**（A 未装 / B
   装了坏 / macOS），每个双 HOME 隔离、禁令零执行、零写入、探测 argv 精确白名单。变异必红。
4. **`sandbox-cli` 子进程退出码（P1#1/P2-1 + P1#2-r3）**：真子进程断言 stdout/stderr/**实际
   exitCode** 覆盖 §5 全表 + argv fail-closed（拼错→exit2、额外 positional→exit2、
   `--help --require-available` 优先 help）+ **spawn 抛异常归一**（假二进制让 Bun.spawn 抛 →
   off→0 / warn→1 / enforce→1 / 严格档→非零，**不崩、有报告**）+ **损坏 config**（sandbox 命令
   降级 warn 呈现、字节不变）。把 exit 改恒 0 必红。
5. **有界回收 fixture（P1#4-r2 + P1#3-r3，仿 `rfc208`/`rfc135:266-281`）**：
   ①假 bwrap 忽略 SIGTERM + 派生 marker 孙进程 → 有限返回 + 报告超时 + 零 survivor；
   ②假 bwrap **fork marker 孙进程后立即非零退出**（不触发 timeout）→ **finally 组杀** → 零
   survivor（漏 finally reap 的实现必红）。
6. **`ProbeDiagnostics`**：真实 `exit 124` 判 `kind==='exit'` 非超时；非 userns stderr 不触发
   userns 断言；stderr 洪泛被有界截断。
7. **`doctor`（§7 + P1#4-r3）**：`checkSandbox` + 整个 `doctorCommand` 退出码四格（enforce+不可用
   →退 1、warn+不可用→不红）+ **损坏 config 下 doctorCommand 不被截断**（checkSandbox 降级、
   仍出完整体检）。
8. **AC-4 重启提示 oracle（P2#2-r3）**：表驱动断言——missing/installed-bad/timeout/spawn-error
   在 warn/enforce 下**必现**「重启 daemon」提示，available/off **不现**；删提示的变异必红。
9. **`main.ts` 分发**：源码文本断言 `case 'sandbox'` + help 含 `sandbox`。
10. **build:binary + 双 OS smoke**：`<bin> sandbox`/`--help` 报告与退出码。

## 9. 与 RFC-205 / 既有码的边界

- 不改探测器行为（只经 `spawnFn` 注入 boundedSpawn；daemon 仍用默认 spawnFn）。
- 复用 `killProcessTree`（util/process.ts）、`probeSandboxMechanism`。
- 改 `config/index.ts` 抽 `readConfig`（loadConfig 逐字节不变）。
- 不改 policy/wrapSandbox/launch 门/status API/SandboxCard/config schema。RFC-205「不自动安装」
  stance 不变。

## 10. 设计门修订账

- **v1→v2**（5P1+2P2）：readConfig（只读）/ 静态白名单+sentinel / Bun.which 分流 / 决策 A /
  决策 B / 退出码+超时测试。
- **v2→v3**（4P1+2P2）：单一退出码真值表 / ProbeDiagnostics / sentinel 重设 / 复用
  killProcessTree / argv fail-closed / readConfig 回写锁。
- **v3→v4**（4P1+2P2，本轮）：

| 编号 | v3 残缺 | v4 修法 |
| --- | --- | --- |
| P1#1-r3 | sentinel 单场景逻辑不可满足 + 只隔离 HOME 漏 AGENT_WORKFLOW_HOME + macOS 无子进程证明 | §6 拆场景 A/B + macOS，双 HOME 隔离，假 bwrap 记 argv 不写禁令 sentinel |
| P1#2-r3 | Bun.spawn 抛异常无诊断态、越 renderer 崩 exit 1、违反 off+throw→0 | §2 ProbeDiagnostics 判别联合 + boundedSpawn catch 归一 unavailable（永不 throw）；§5 异常归表 |
| P1#3-r3 | 只 timeout 组杀漏「父先退+孙进程」 | §2 finally 无条件 killProcessTree（仿 opencode.ts:142-154）；§8-5② fork-then-exit 零 survivor |
| P1#4-r3 | 损坏 config 未定义命令级 catch，会截断 doctor | §2 sandbox 显式 catch 降级；§7 checkSandbox 自 catch 不 reject；§8-4/7 测两命令 |
| P2#1-r3 | proposal G3/故事2/故事4 留反 AC 旧话 | proposal 同步（PATH 首命中 / userns 条件化 / 故事4 用 --require-available） |
| P2#2-r3 | AC-4 重启提示无变异 oracle | §8-8 表驱动断言 + 删提示变异实证 |

产品裁定（用户 2026-07-22，不变）：决策 A / B / C。
