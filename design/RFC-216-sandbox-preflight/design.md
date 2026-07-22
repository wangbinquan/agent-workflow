# RFC-216 技术设计（v5 —— 四轮设计门后定稿，修订账见 §10）

> 读序：先读 [proposal.md](./proposal.md)。核心一句话：**纯增量的呈现层 + 一条
> doctor 检查，零运行时行为改动。** 经 Codex 设计门四轮对抗（v1 5P1 / v2 4P1 / v3 4P1 /
> v4 3P1），本文 v5 定稿、进入实现。

## 1. 命令契约（argv fail-closed，P2#1-r2）

```
agent-workflow sandbox                      # 打印自检报告 + 修复指引；退出码见 §5
agent-workflow sandbox --require-available   # 严格档：沙箱未实际生效即非零（CI/provisioning）
agent-workflow sandbox --help                # 打印用法
```

- 入口 `main.ts` `case 'sandbox':` → `sandboxCommand(Bun.argv.slice(3))` → 打印 +
  `process.exit(code)`。
- **argv fail-closed**：精确 allowlist——只认 `--require-available`/`--help`/`-h`；未知
  flag（含拼错）/positional/缺值 → stderr `unknown option` + **exit 2**，绝不静默回退。`--help`
  优先。
- 不需要 daemon、不需要 root。命令自身只读（§6）。

## 2. 数据流 + 两轴 + 有界探测

**两个独立轴（P1#3-r4）**：`mechanismAvailable`（探测得）与 `configReadable`（能否读到
config 从而知道生效 mode）。**绝不用篡改 `SandboxStatus.available` 表达配置错误。**

1. **读配置（只读，P1-1）**：`readConfig(Paths.config)` 契约——缺→`null`、合法→Config（只读
   不回写）、**损坏→抛 `Error`**（同 loadConfig parse 语义）。`sandboxCommand` 显式 try/catch：
   - `null` → `configReadable=true, mode=warn`（默认）；
   - 合法 → `configReadable=true, mode=config.sandboxMode`；
   - 抛 → `configReadable=false`（**不假设 mode**）；仍继续探测机制（available 如实）；报告
     「config 不可读（<err>），无法确定生效 sandboxMode」。**决策 D：`configReadable=false ⇒
     exit 2`**（§5），机制状态照实展示。
2. **有界探测 + 诊断**：CLI 造 `boundedSpawn` 传 `probeSandboxMechanism(platform, boundedSpawn)`
   （复用 RFC-205 探测器，只经其 `spawnFn` 形参）。`boundedSpawn(cmd): Promise<number>`：
   - `Bun.spawn({cmd, stdout:'ignore', stderr:'pipe', detached:true})` 自成进程组（仿
     `util/opencode.ts:83-154`/`git.ts`）。
   - **超时**：timer→`killProcessTree(pid,'SIGKILL')`（`util/process.ts:32`，组杀含孙进程；
     SIGKILL 非可忽略 SIGTERM）；`diag={kind:'timeout'}`。
   - **stderr**：**流式 capped reader**——**固定字节上限**边读边丢弃超限（**不 buffer-all-then-
     slice**，防 OOM，P2#1-r4）；不绑死 exit 等待（孙进程占 pipe 使 EOF 不来）。
   - **整生命周期归一（P1#2-r3 + P2#1-r4）**：`Bun.spawn` **启动抛** / `proc.exited` reject /
     stderr reader reject —— **一律 catch** → `diag={kind:'error',message}` + 返回哨兵 127 给
     探测器（得 unavailable）。**`boundedSpawn` 永不 throw、永不把异常泄漏到 renderer 之外。**
   - **正常退出**：`diag={kind:'exit',exitCode,stderrSnippet}`；返回真实 `exitCode`（同源）。
   - **`finally` 无条件回收（P1#3-r3）**：direct child settle 后**无条件**再
     `killProcessTree(pid,'SIGKILL')`（收「父先退+孙进程」泄漏，仿 `opencode.ts:142-154`；真实
     exitCode 已先取，保留）；清 timer。
   - **`ProbeDiagnostics` 判别联合**：`{kind:'exit',exitCode:number,stderrSnippet:string} |
     {kind:'timeout'} | {kind:'error',message:string}`。timeout/error 独立 kind——真实 `exit
     124` 与超时不撞码。probe 只调 spawnFn 一次。
3. **机制缺失判别（P1-3-r1）**：Linux 不可用时 `Bun.which('bwrap')`（PATH，只读）硬分
   未装（→null）/装了坏（→路径）。
4. `renderSandboxReport({platform,status,diag,mode,requireAvailable,bwrapOnPath,packageManager,
   configReadable}) → {text,exitCode}`（**纯函数**）。
5. `packageManager` ← `detectPackageManager(has)`（`has`=谓词，CLI 用 `Bun.which` 注入）。

## 3. 模块与复用

| 职责 | 落点 | 复用/新建 |
| --- | --- | --- |
| 真实探测 | `probe.ts` `probeSandboxMechanism`（复用，只经 spawnFn 注入） | 复用 |
| 进程组 kill | `util/process.ts` `killProcessTree`（超时 + finally 两处） | 复用 |
| 只读读配置 | `config/index.ts` 抽 `readConfig(path): Config \| null`（缺→null/合法→只读解析/损坏→throw）；`loadConfig` 逐字节不变 | 抽公共+复用 |
| 纯呈现+指引 | 新建 `services/sandbox/guidance.ts`（纯函数零副作用） | 新建 |
| CLI 编排 | 新建 `cli/sandbox.ts` `sandboxCommand()` | 新建 |
| doctor 检查 | `cli/doctor.ts` 加 `checkSandbox()`（经 boundedSpawn；自 catch 不 reject） | 复用 |
| 分发/help/文档 | `main.ts` `case`；`docs/sandbox.md` | —— |

> 观察（不在本 RFC 范围）：有界-spawn 定式现 4 处，dedup 候选，抽公共 helper 另立 RFC。

## 4. 报告文案骨架（示意）

未装（which→null）→ 安装命令 +「PATH 首命中」标注 + 重启提示｜装了坏（`kind==='exit'` 非零）
→ exit N + stderr 证据 + **有条件** sysctl（非确诊 userns）｜超时（`kind==='timeout'`）→ 探测
超时｜探测 error（`kind==='error'`）→ 探测失败 + message｜config 不可读 → 顶部注 + 机制状态｜
macOS/off → seatbelt 无需装 / 沙箱已关闭。

## 5. 退出码真值表（P1#1-r2 + P1#3-r4，含 configReadable 轴）

`timeout`/`error`/非零 exit → `available=false`。**先判 configReadable**：

| configReadable | mode | available | 默认 | `--require-available` |
| --- | --- | --- | --- | --- |
| **false（损坏）** | 未知 | 任意（照实展示） | **2** | **2** |
| true | off | 任意 | **0** | **1** |
| true | warn/enforce | true | **0** | **0** |
| true | warn/enforce | false | **1** | **1** |

- configReadable=false → **exit 2**（决策 D，独立轴，available 不篡改）。
- 否则默认 `0 ⟺ (mode==='off' || available)`；严格档 `0 ⟺ (mode!=='off' && available)`。
- argv 错误 → exit 2（§1，先于探测）。
- 退出码由纯函数 `renderSandboxReport` 计算返回，`main.ts`/`sandboxCommand` 只透传，子进程测试
  锁死。

## 6. 只读保证（P1-1 + P1-2-r1 + P1#1-r3 + P1#1/#2-r4）

「只读」=不写任何文件 + 不执行任何**禁令命令**。合法探测本就执行 `bwrap`/`sandbox-exec`，守卫须
**区分合法探测与禁令**，且**堵死写盘/执行的所有逃逸面**：

1. **`guidance.ts` 纯**（静态守卫）：不 import child_process、无 `Bun.spawn`/`Bun.$`/`Bun.which`/
   `execSync`/`spawnSync`、无 fs 写。
2. **`cli/sandbox.ts` 执行边界**（静态守卫）：不 import child_process、无 `Bun.$`/`execSync`/
   `spawnSync`、无 fs 写；`Bun.spawn` 只在 `boundedSpawn` 内、且 `boundedSpawn` 只作
   `probeSandboxMechanism` 实参（调用点守卫）。
3. **底层 spawn seam 全 argv 记录（P1#2-r4）**：单测经**可注入的 `ProbeSpawnFn`** 记录探测器发出
   的**全部** argv，断言生产模块图只出现**精确** bwrap/seatbelt allowlist
   （`['bwrap','--bind','/','/','--','/bin/true']` / `['/usr/bin/sandbox-exec','-p',…,
   '/usr/bin/true']`），**恰好一次**。macOS argv 就靠这层锁（生产探针执行**绝对路径**
   `/usr/bin/sandbox-exec`，PATH 假程序永不被调，**禁止**为测试把绝对路径改 PATH 查找，P1#1-r4）。
4. **子进程零写入/零禁令场景**（堵 cwd/TMPDIR/XDG 逃逸，P1#2-r4）：全新临时根，**同时**把
   `HOME`、`AGENT_WORKFLOW_HOME`、**`cwd`**、**`TMPDIR`/`TMP`/`TEMP`**、**`XDG_CONFIG_HOME`/
   `XDG_CACHE_HOME`** 指向各自受监控子目录、逐目录快照：
   - **Linux A｜未装 bwrap**（PATH 无 bwrap，禁令桩 `apt-get`/`dnf`/…/`sysctl`/`sudo`/`sh`
     写 sentinel）→ 印安装命令 + 禁令零执行 + 各监控目录零写入。
   - **Linux B｜装了坏**（假 bwrap 把 argv 写进**受监控外**的指定 marker 后非零退出、不写禁令
     sentinel）→ 无安装命令 + 探测 argv 白名单 + 禁令零执行 + 各监控目录零写入。marker 显式
     排除在快照外（或改用 pipe 传 argv）。
   - **macOS**：真实绝对路径探针（无害 `/usr/bin/sandbox-exec … /usr/bin/true`）+ 禁令桩 → 禁令
     零执行 + 各监控目录零写入（argv 由 §6-3 单测层锁）。
   - **必红变异**：cwd 写 / tmp 写 / 绝对路径执行 `/bin/sh` 或 `/usr/bin/sudo`。

> **不用**匹配打印字符串的文本 grep。

## 7. doctor 检查真值表（决策 B + P1#4-r3）

`checkSandbox()`（经 boundedSpawn）返回 `CheckResult`，`ok = !(mode==='enforce' && !available)`：
可用→✅｜warn+不可用→✅（提示）｜off+不可用→✅｜enforce+不可用→❌（doctor 退 1）。

- **损坏 config**：`checkSandbox` **自 catch `readConfig` 抛**（无法知 mode→按 warn 探测 + message
  注「config 不可读」），**绝不让异常传播**截断 `doctorCommand`；config 损坏由既有 `checkConfig`
  判死。（注：exit-2 语义只属 `sandbox` 命令，不改 doctor 的 CheckResult 契约。）

## 8. 测试策略

1. **`guidance.test.ts`（纯函数）**：`renderSandboxReport` 各态含 `diag.kind` 三值 + `bwrapOnPath`
   + 各包管理器/unknown + `configReadable` 真/假 + mode×available + `requireAvailable`；断言机制名、
   ✅/❌、安装命令 vs sysctl 互斥、sysctl 仅 `kind==='exit'` 非零且有 stderr 时出现、`exitCode`
   对 §5 真值表**逐格**（含 `configReadable=false`×{available,unavailable}、off+available/timeout/
   error）。`detectPackageManager` 优先序 + 全 miss→null。
2. **`readConfig`**：缺→null 零变化；已存在 partial→补齐嵌套默认 + **字节/stat 不变** + 与
   `loadConfig` 解析一致；损坏→throw 不写；`loadConfig` 缺文件仍写默认（回归锁）；调用点不可达
   `save*`。
3. **只读守卫（§6）**：静态白名单 + boundedSpawn 调用点守卫 + spawn-seam argv allowlist（含 macOS
   注入）+ 三子进程场景（HOME/AGENT_WORKFLOW_HOME/cwd/TMPDIR/XDG 全隔离逐目录快照）+ 三逃逸变异
   （cwd 写/tmp 写/绝对路径 shell）。
4. **`sandbox-cli` 子进程退出码**：真子进程 stdout/stderr/**exitCode** 覆盖 §5 全表（含
   `configReadable=false→exit2`）+ argv fail-closed（拼错→2/额外→2/`--help --require-available`
   优先 help）+ 损坏 config→exit 2 且机制状态照实、字节不变。exit 改恒 0 必红。
5. **有界回收 fixture（仿 rfc208/rfc135:266-281）**：①忽略 SIGTERM + 孙进程→有限返回+零 survivor；
   ②fork marker 孙进程后**立即非零退出**（不触发 timeout）→ finally 组杀→零 survivor。
6. **boundedSpawn 故障注入（P2#1-r4）**：注入进程适配器令 `exited` reject / stderr reader reject /
   **超大 stderr**（断累计字节 ≤ 上限、流式非全缓冲）→ 一律归 `kind:'error'`/unavailable；
   `doctorCommand` 不被 reject 截断。真实 `exit 124` 判 `kind==='exit'` 非超时。
7. **`doctor`**：`checkSandbox` + `doctorCommand` 退出码四格（enforce+不可用→1、warn+不可用→不红）
   + 损坏 config 下 doctorCommand 不被截断（checkSandbox 降级、仍出完整体检）。
8. **AC-4 重启提示 oracle**：表驱动——missing/装了坏/timeout/error 在 warn/enforce **必现**重启提示、
   available/off **不现**；删提示变异必红。
9. **`main.ts` 分发**：源码文本断言 `case 'sandbox'` + help 含 `sandbox`。
10. **build:binary + 双 OS smoke**。

## 9. 与 RFC-205 / 既有码边界

不改探测器行为（只注入 boundedSpawn）；复用 `killProcessTree`/`probeSandboxMechanism`；改
`config/index.ts` 抽 `readConfig`（loadConfig 逐字节不变）；不改 policy/wrapSandbox/launch 门/status
API/SandboxCard/config schema。RFC-205「不自动安装」不变。

## 10. 设计门修订账

- **v1→v2**（5P1）：readConfig / 静态白名单+sentinel / Bun.which / 决策 A / 决策 B / 退出码+超时测试。
- **v2→v3**（4P1）：单一真值表 / ProbeDiagnostics / sentinel 重设 / 复用 killProcessTree / argv
  fail-closed / readConfig 回写锁。
- **v3→v4**（4P1）：三场景 sentinel+双 HOME / 判别联合+吞异常 / finally 组杀 / 损坏 config 降级 /
  proposal 同步 / AC-4 oracle。
- **v4→v5**（3P1+2P2，本轮）：

| 编号 | v4 残缺 | v5 修法 |
| --- | --- | --- |
| P1#1-r4 | macOS 假 sandbox-exec 走不通（探针绝对路径） | §6-3 macOS argv 靠 ProbeSpawnFn 单测层锁；子进程用真绝对路径探针只验零写/零禁令 |
| P1#2-r4 | 零写 oracle 从 cwd/TMPDIR/XDG/绝对路径执行逃逸 | §6-4 cwd/TMPDIR/XDG 全隔离逐目录快照 + spawn-seam 全 argv allowlist + 三逃逸变异；scenario-B marker 排除快照 |
| P1#3-r4 | 损坏 config 与 available 退出语义互斥 | §2/§5 拆 configReadable/mechanismAvailable 两轴；决策 D：损坏→exit 2、available 不篡改 |
| P2#1-r4 | boundedSpawn 只 catch 启动、无真实内存上界 | §2 整生命周期 catch（exited/stderr reject）归 `kind:'error'` + 流式 capped reader；§8-6 故障注入 |
| P2#2-r4 | proposal AC-3 引用已删 `diag.timedOut` | proposal AC-3 改 `diag.kind==='exit' && exitCode===124` |

产品裁定（用户 2026-07-22）：决策 A / B / C / **D（损坏 config → exit 2、两轴分开）**。
