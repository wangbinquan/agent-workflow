# RFC-216 技术设计（v3 —— 两轮设计门后定稿，修订账见 §10）

> 读序：先读 [proposal.md](./proposal.md)。核心一句话：**纯增量的呈现层 + 一条
> doctor 检查，零运行时行为改动。** 经 Codex 设计门两轮对抗（v1 5 P1+2 P2 / v2 4 P1+2
> P2），本文 v3 为定稿。

## 1. 命令契约（含 argv fail-closed，P2#1）

```
agent-workflow sandbox                      # 打印自检报告 + 修复指引；退出码见 §5
agent-workflow sandbox --require-available   # 严格档：沙箱未实际生效即非零（CI/provisioning）
agent-workflow sandbox --help                # 打印用法
```

- 入口：`main.ts` 加 `case 'sandbox':` → `sandboxCommand(Bun.argv.slice(3))` →
  `process.stdout.write(output)` + `process.exit(code)`。
- **argv fail-closed**：`sandboxCommand` 用**精确 allowlist** 解析——只认
  `--require-available` 与 `--help`/`-h`；**未知 flag（含 `--require-availble` 拼错）/ 未知
  positional / 缺值** → 写 stderr `unknown option: X` + **退出 2**（沿用 main.ts 对未知
  子命令的 exit 2 约定）。**绝不静默回退默认档**——否则 CI 拼错严格 flag 会在 off 下误退
  0、绕过门禁。`--help` 优先于其他 flag。
- **不需要 daemon 在跑，不需要 root。命令自身只读**（§6）。

## 2. 数据流

1. **读配置（只读，P1-1）**：`readConfig(Paths.config)`（§3，缺文件返 `null`、**任何情况
   都不写盘**）→ `mode = readConfig(...)?.sandboxMode ?? DEFAULT_CONFIG.sandboxMode`。
   **不用 `loadConfig`**（它缺文件即 `saveConfigRaw` 写默认，`config/index.ts:26-30`）。
2. **有界探测 + 诊断（P1#2 + P1#4 + P2-2）**：CLI 造 `boundedSpawn` 传给
   `probeSandboxMechanism(process.platform, boundedSpawn)`（复用 RFC-205 探测器，只经其既有
   `spawnFn` 形参）。`boundedSpawn`：
   - **复用仓内有界-spawn 定式**（`util/opencode.ts:83-109` / `opencode-models.ts:89-99` /
     `git.ts:151-157` 同型）：`Bun.spawn({cmd, stdout:'ignore', stderr:'pipe', detached:true})`
     → 自成进程组；超时 timer 到点调 **`killProcessTree(proc.pid, 'SIGKILL')`**
     （`util/process.ts:32`，`process.kill(-pid)` 杀**整组含孙进程**；**SIGKILL 不 SIGTERM**
     ——TERM 可忽略再 `await exited` 会重挂，这是 opencode.ts 明写的教训）。stderr 读取**不
     绑死 exit 等待**（孙进程可占 pipe 使 EOF 永不来——同 opencode.ts 注释），有界读 + 截断。
   - **返回给探测器**：真实 `exitCode`（number，保持 SandboxStatus 同源判定）。
   - **侧记诊断**：闭包写 `diag: ProbeDiagnostics {exitCode:number, stderrSnippet:string,
     timedOut:boolean}`。**`timedOut` 是独立布尔、不塞进 exit code**——故真实 `exit 124` 与
     超时不再撞码（P1#2）。probe 只调 spawnFn 一次（`probe.ts` darwin/linux 各一次）。
3. **机制缺失判别（P1-3）**：Linux 且不可用时用 `Bun.which('bwrap')`（查 PATH，只读）**硬分**
   「未装」（→null）与「装了但起不来」（→路径）。
4. `renderSandboxReport({ platform, status, diag, mode, requireAvailable, bwrapOnPath,
   packageManager })` → `{ text, exitCode }`（**纯函数**）。渲染优先级：`diag.timedOut` →
   探测超时；否则按 available / bwrapOnPath / mode 分支。
5. `packageManager` ← `detectPackageManager(has)`（`has`=谓词，CLI 用 `Bun.which` 注入）。

## 3. 模块与复用（严守「抽一次别 fork」）

| 职责 | 落点 | 复用 / 新建 |
| --- | --- | --- |
| 真实探测 | `probe.ts` `probeSandboxMechanism`（复用，只经 `spawnFn` 注入） | 复用 |
| 进程组 kill | `util/process.ts` **`killProcessTree`**（复用；`boundedSpawn` 超时路径调它） | 复用 |
| 只读读配置 | `config/index.ts` 抽 **`readConfig(path): Config \| null`**（缺文件 null、**存在也只读不回写**）；`loadConfig = readConfig(path) ?? (saveConfigRaw(DEFAULT); DEFAULT)` —— 既有行为逐字节不变 | 抽公共 + 复用 |
| 纯呈现 + 指引 | **新建** `services/sandbox/guidance.ts`：`renderSandboxReport`/`detectPackageManager`/`installHint`/`usernsHint`；**纯函数、零副作用**（不 import child_process、无 `Bun.spawn`/`Bun.$`/`Bun.which`/fs 写） | 新建纯原语 |
| CLI 编排 | **新建** `cli/sandbox.ts` `sandboxCommand()`：argv 解析 + `boundedSpawn`→probe + `readConfig` + `Bun.which` + render + 退出码 | 新建 |
| doctor 检查 | `cli/doctor.ts` 加 `checkSandbox()`（经 `boundedSpawn` 探测；真值表 §7） | 复用 |
| 分发 + help + 文档 | `main.ts` `case`；`docs/sandbox.md` 自检节 | —— |

> **观察（不在本 RFC 范围）**：有界-spawn 定式现已在 opencode.ts / opencode-models.ts /
> git.ts / 本 RFC 共 4 处，是 dedup 候选（抽 `spawnBounded` 公共 helper）；本 RFC 先复用
> `killProcessTree` 不动那 3 处热路径，抽取另立 RFC。

## 4. 报告文案骨架（示意，最终以实现为准）

**Linux 未装 bwrap（`Bun.which`→null）**：机制/❌未找到 bwrap/mode/「检测到 PATH 上的
包管理器：apt」→ `sudo apt-get install -y bubblewrap` + 重启 daemon 提示。

**Linux 装了但探测非零（`Bun.which`→路径，非超时）**：
```
状态：❌ 不可用 —— bwrap 已安装但试跑失败（exit N）
stderr：<截断摘要>
排障：确认容器/内核是否允许非特权 user namespaces。若确为 userns 受限（容器常见），
下列 sysctl 【可能】有帮助，但会扩大全机攻击面、且这是启发式建议而非确证——请先据上面
stderr 判断再决定：
  # Ubuntu 24.04+ ……（sysctl 列表）
```
—— **不再无条件断言「userns 被禁」**：先给 exitCode+stderr 证据，sysctl 作为**有条件**建议
（P1#2/P1-3）。

**探测超时（`diag.timedOut`）**：❌ 沙箱机制探测超时（>10s，已 SIGKILL 整组回收）+ 排障。

**macOS 可用 / config 关闭**：seatbelt 无需安装 / off 注明「沙箱已关闭」。

## 5. 退出码真值表（P1#1，单一权威表）

`timedOut` / `throw` 归入 `available=false`。设 A=available：

| mode | A | 默认退出码 | `--require-available` 退出码 |
| --- | --- | --- | --- |
| off | true | **0**（沙箱关闭，报告注明） | **1**（off ⇒ 沙箱未实际生效） |
| off | false | **0** | **1** |
| warn/enforce | true | **0** | **0** |
| warn/enforce | false | **1** | **1** |

- **默认**：`exit 0 ⟺ (mode==='off' || available)`。off 一律 0（含 throw/timeout——关了就不
  在意机制）。
- **`--require-available`**：`exit 0 ⟺ (mode!=='off' && available)`。语义=「沙箱**实际会
  包住 agent**」，故 off 即便机制可用也退非零（对齐决策 A 的 preview「off/不可用→非零」）。
- **argv 错误** → exit 2（§1，先于探测）。
- 退出码由**纯函数 `renderSandboxReport` 计算并返回**，`main.ts`/`sandboxCommand` 只透传，
  子进程测试锁死（§8）。

## 6. 只读保证（安全红线，P1-1 + P1-2 + P1#3）

「只读」= 不写任何文件 + 不执行任何**禁令命令**（包管理器/sysctl/shell/sudo）。合法探测**本就
要执行 `bwrap`/`sandbox-exec`**，故守卫必须**区分**「合法探测」与「禁令命令」，不能笼统"零
执行"（v2 该点被证伪）：

1. **`guidance.ts` 纯**（静态守卫）：不 import `node:child_process`、无
   `Bun.spawn`/`Bun.$`/`Bun.which`/`execSync`/`spawnSync`、无 fs 写 API。只回字符串。
2. **`cli/sandbox.ts` 执行边界**（静态守卫）：不 import `node:child_process`、无
   `Bun.$`/`execSync`/`spawnSync`、无 fs 写 API；`Bun.spawn` **只出现在 `boundedSpawn` 定义
   内**，且 `boundedSpawn` **只作为 `probeSandboxMechanism` 的实参**出现（调用点守卫，禁止用
   任意 argv 直接调它）。
3. **子进程 sentinel 行为证明**（比静态硬）：全新临时 HOME，PATH 上放
   - **禁令二进制** `sudo`/`apt-get`/`dnf`/`pacman`/`apk`/`zypper`/`sysctl`/`sh` 各一个假的
     「执行即写 sentinel 文件」→ 断言**每个 sentinel 都未被写**（零禁令执行）；
   - **假 `bwrap`**（Linux）→ 立即非零退出、**不写禁令 sentinel**（模拟"装了但坏"，让探测
     合法执行它）；
   - 断言 ①禁令 sentinel 全未写 ②临时 HOME **零文件/目录写入**（**无 config.json**，P1-1）
     ③报告文本里**确实印出** `apt-get install` 指引（证明"打印≠执行"）。
   另在单测层断言探测 spawn 的 **argv 恰好一次、完整匹配** seatbelt/bwrap 白名单（
   `['/usr/bin/sandbox-exec',...]` / `['bwrap','--bind','/','/','--','/bin/true']`）。

> **不用**会匹配打印字符串的文本 grep（打印串本就含 install/sysctl 字样）。变异（打印→执行、
> 误用 `loadConfig`、boundedSpawn 被挪用执行任意命令）→ 上述某测试必红。

## 7. doctor 检查真值表（决策 B，P1-5）

`checkSandbox()`（经 `boundedSpawn` 探测，不挂起）返回 `CheckResult`，
`ok = !(mode==='enforce' && !available)`：

| mode | available | ok |
| --- | --- | --- |
| 任意 | true | ✅ |
| warn | false | ✅（仅提示：安装指引见 `agent-workflow sandbox`） |
| off | false | ✅（沙箱由配置关闭） |
| enforce | false | ❌（doctor 退 1；所有任务将被 409 拒） |

→ warn 机器缺 bwrap **不撞红** `doctor`/CI；仅真正挡所有任务的 enforce+不可用让
`doctorCommand` 退 1。

## 8. 测试策略

1. **`guidance.test.ts`（纯函数）**：`renderSandboxReport` 各态——含 `diag.timedOut`、
   `bwrapOnPath` 真/假、各包管理器/unknown、mode×available、`requireAvailable` 真/假；断言
   机制名、✅/❌、**安装命令 vs sysctl 互斥**、sysctl 仅在"装了但坏"且有 stderr 证据时出现、
   「PATH 首命中」措辞、`exitCode` 返回值对 §5 真值表**逐格**（含 **off+available**、
   **off+timeout**、**off+throw** 三个交叉格）。`detectPackageManager` 优先序 + 全 miss→null。
2. **`readConfig`（P2#2）**：①缺文件→null 且 home 零变化；②**已存在 partial config**→解析
   补齐嵌套默认、**执行前后文件字节/stat 完全不变**、结果与 `loadConfig` 解析一致；③**损坏
   config**→抛且不写；④`loadConfig` 缺文件仍写默认（回归锁）；⑤调用点守卫：`readConfig`
   代码路径不可达任何 `save*`。
3. **只读守卫（§6）**：静态白名单 + `boundedSpawn` 调用点守卫 + 子进程 sentinel（禁令零执行 +
   零写入 + 印出安装指引 + 探测 argv 精确白名单）。变异必红。
4. **`sandbox-cli` 子进程退出码（P1#1/P2-1）**：真子进程跑 `sandbox`，断言 stdout/stderr/
   **实际 exitCode** 覆盖 §5 全表 + argv fail-closed（`--require-availble` 拼错→exit 2、
   额外 positional→exit 2、`--help --require-available` 优先 help）；把 exit 改恒 0 必红。
5. **有界回收 fixture（P1#4/P2-2，仿 `rfc208-unbounded-git-and-permits.test.ts:64-86`）**：
   假 bwrap **忽略 SIGTERM + 派生带唯一 marker 的孙进程** → 断言命令**有限时间返回**、报告
   「探测超时」、**零 survivor**（marker 进程被 group SIGKILL 收掉）。
6. **`ProbeDiagnostics`**：真实 `exit 124` 不被当超时（`timedOut=false`）；非 userns 的 stderr
   不触发 userns 断言；stderr 洪泛被有界截断。
7. **`doctor` 真值表（§7）**：`checkSandbox` + 整个 `doctorCommand` 退出码四格（enforce+不可用
   →退 1、warn+不可用→不红）。
8. **`main.ts` 分发**：源码文本断言 `case 'sandbox'` + help 含 `sandbox`（兜底）。
9. **build:binary + 双 OS smoke**：`<bin> sandbox`/`--help` 报告与退出码。

## 9. 与 RFC-205 / 既有码的边界

- **不改探测器行为**：`probeSandboxMechanism` 只经既有 `spawnFn` 注入 `boundedSpawn`；daemon
  仍用默认 spawnFn（无超时），零行为变化。
- **复用**：`killProcessTree`（`util/process.ts`）、`probeSandboxMechanism`。
- **改**：`config/index.ts` 抽 `readConfig`（`loadConfig` 逐字节不变，纯增只读变体）——P1-1
  逼出的必要重构。
- 不改：`policy.ts`/`index.ts`（wrapSandbox）/`task.ts` launch 门/status API/`SandboxCard`/
  config schema。RFC-205「二进制不自动安装」stance 不变。

## 10. 设计门修订账

**v1→v2**（第一轮 5 P1+2 P2）：只读被 loadConfig 证伪→readConfig；spawn-spy 可绕过→静态
白名单+sentinel；sysctl 靠猜→Bun.which 分流；off 误绿→决策 A；doctor 语义→决策 B 真值表；
退出码/超时测试补齐。

**v2→v3**（第二轮 4 P1+2 P2，本轮）：

| 编号 | v2 残缺 | v3 修法 |
| --- | --- | --- |
| P1#1 | 退出码表自相矛盾（off+available 严格档误绿；off+throw 两处冲突） | §5 单一权威真值表：严格档=`mode!=='off'&&available`；off 默认恒 0；三交叉格入测 |
| P1#2 | `ProbeSpawnFn` 只回 number，扛不动 stderr/timedOut，哨兵 124 撞真实 124 | §2 `boundedSpawn` 侧记 `ProbeDiagnostics{exitCode,stderrSnippet,timedOut}`；timedOut 独立布尔；sysctl 仅在有证据时印 |
| P1#3 | sentinel 会把合法探测（必执行 bwrap）判红、又漏真安装命令 | §6 重设：禁令二进制各设零调用 sentinel、假 bwrap 不写禁令 sentinel、探测 argv 精确白名单、boundedSpawn 调用点守卫 |
| P1#4 | `kill+await exited` 挡不住忽略 SIGTERM/孙进程泄漏 | §2 复用 `killProcessTree`（detached 组 SIGKILL，仿 opencode.ts/git.ts）；§8-5 fixture 仿 rfc208 断言零 survivor |
| P2#1 | 严格档无 fail-closed argv，拼错静默退化绕过门禁 | §1 精确 allowlist，未知参数 exit 2 先于探测；§8-4 拼错/额外参数测试 |
| P2#2 | readConfig 未锁"读已存在配置时回写"变异 | §8-2 已存在 partial+损坏 config 字节不变 + 嵌套默认 parity + 调用点守卫 |

产品裁定（用户 2026-07-22，不变）：决策 A（off→0 + `--require-available`）/ B（doctor 仅
enforce+不可用 fail）/ C（PATH 首命中 + 如实标注，os-release 列 v1.1）。
