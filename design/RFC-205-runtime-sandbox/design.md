# RFC-205 — 技术设计（运行时沙箱）

- 状态：Draft（2026-07-22；随 proposal 一并起草）
- 前置调研：全部锚点经源码核实（下引 file:line 为 2026-07-22 HEAD）。

## 1. 现状锚点（实现依据）

- **spawn 单点**：所有业务/系统 agent CLI 都经 `runner.ts:837-852` 的一次
  `Bun.spawn({ cmd, cwd: worktreePath, env, detached: true })`；argv/env 由 driver 的
  `buildBusinessSpawn` 产出 `SpawnPlan{cmd,env,stdin}`（`runtime/types.ts:122-134`）。
  另两处系统代理 spawn：`memoryDistiller.ts:962`（可注入 `spawnFn`）、`runtimeSmoke.ts:165`。
- **env 组装**：`opencode/spawn.ts:168-206`、`claudeCode/spawn.ts:124-152` —— `...process.env`
  全继承 + `PWD=worktree` + per-run config dir；claude 凭据桥把 `.credentials.json`(0600) 写进
  runDir（`claudeCode/config.ts:31-85`）——即 **agent 干活所需的模型凭据在放行区内**，不受本设计影响。
- **路径 SSOT**：`util/paths.ts`（root/db/secret.key/backups/worktrees/runs/skills/plugins/logs/
  token/config…）；镜像位于 `repos/{hash}-{slug}`（`gitRepoCache.ts:383-384`）；run 私有目录
  `runs/{taskId}/{nodeRunId}/`（`runner.ts:428`）。
- **要挡的秘密（威胁清单 A1-A5 的落盘点）**：`secret.key`（0600，`secretBox.ts:33`）、
  `db.sqlite`（**无 chmod**，`db/client.ts:49`）、`backups/`、镜像 `.git/config` 明文 origin
  （clone 直接用带凭据 URL，`gitRepoCache.ts:576-584`；warm fetch 靠 origin，`:444`）、
  其它任务的 worktrees/runs。
- **桩契约红线**：golden argv 锁（`runtime-opencode-golden.test.ts:28-144`）、shell 桩按
  `argv[1]` 分派（`e2e/fixtures/stub-opencode.sh:20-35`）、`spawnBinaryPath = cmd[0]`
  （`runner.ts:898`）、version-registry key=head[0]（`opencode/driver.ts:188`）。
  ⇒ **包装必须发生在 SpawnPlan 之后、Bun.spawn 之前**，且 `plan.cmd` 原值继续喂
  `spawnBinaryPath`/registry；driver 层 buildSpawn 输出零变化（golden 不动）。
- **告警复用**：`lifecycle_alerts`（`schema.ts:2098-2115`，rule 为自由 TEXT——新 rule
  **零 migration**）+ WS `broadcastAlert`（`start.ts:628-643`）。
- **探测/暴露模式**：软探测模板（claude probe `start.ts:202-218`）；
  `GET /api/runtimes/status`（`routes/runtimes.ts:121-154`）+ Settings→Runtime 卡片
  （`RuntimeList.tsx`）。
- **uid 现状**：全仓唯一 uid 感知 = `claudeSandboxEnv`（`claudeCode/spawn.ts:77-79`）。

## 2. 设计决策

- **D1 包装点 = `runner.ts` 的 Bun.spawn 边界**（以及 `memoryDistiller` / `runtimeSmoke`
  两处系统代理 spawn）。`SpawnPlan` 不变；spawn 时
  `cmd = wrapSandbox(plan.cmd, sandboxCtx)`。`sandboxCtx` 由 daemon 装配并**显式传入**
  （runner opts 新可选字段）；**不传 = 不包装** —— 全部既有单测/e2e/golden 桩零触碰
  （它们从不装配 sandboxCtx），生产 `start.ts` 统一装配。
- **D2 机制**：
  - macOS：`sandbox-exec -p <SBPL profile> <cmd…>`。sandbox-exec 为 exec 型（pid 不变、
    进程组不变），`detached:true` 的组杀（`runner.ts` killTree 负 pid）语义不受影响；
    profile 按进程树继承，孙进程同受限。
  - Linux：`bwrap --die-with-parent --bind / / --dev /dev --tmpfs <appHome>
    --bind <repos> <repos> --bind <task worktree> … --bind <runDir> … -- <cmd…>`
    （repos 读写见 D3 Q4；skills 不放行见 D3 Q5）。白名单语义：`--tmpfs appHome` 整体遮蔽平台目录，再
    bind 回放行子路径；`/` 与 `$HOME` 其余部分保持可写直通（模型 auth 刷新、/tmp 等
    照常）。bwrap 与目标进程同处 detached 进程组，组杀兼容；**不** `--unshare-pid`
    （保持既有 kill/reap 语义,进程侧信道遮蔽列为非目标）。
  - 机制探测不到 → 按 D5 模式降级。
- **D3 策略单一事实源**：`services/sandbox/policy.ts` 纯函数
  `computeSandboxPolicy({appHome, taskWorktrees, runDir, mirrorsDir, skillsDir}) →
  { denySubtrees[], denyFiles[], allowSubtrees[] }`：
  - deny：`secret.key`、`db.sqlite`+`-wal`/`-shm`、`token`、`config.json`、`backups/`、
    `logs/`、`.restore-pending*`、`.daemon.*`、`worktrees/`（整树）、`runs/`（整树）、
    `plugins/`、`snapshots/`。
  - allow（在 deny 树内放行）：**本任务全部 worktree 目录**（多 repo 任务 = 多条）、本
    run 目录 `runs/{task}/{node}/`、`repos/`（**读写**——设计门自审 Q4：worktree 的
    gitdir/index 落在镜像 `.git/worktrees/<id>/`，commit 还要写 `.git/objects` 与 refs，
    只读会让 AC-2 的 git commit 直接瘫痪；凭据保护靠 G1「不落盘」而非 FS 只读，清洗后
    镜像 config 已无秘密，agent 可写 config 仅剩捣乱面、接受）。
  - `skills/` **不放行**（设计门自审 Q5：受管技能在 spawn 前已 copyDir 进 runDir，
    external 技能已被 RFC-178 移除，agent 运行期对源目录零依赖——deny 缩小攻击面）。
  - 两个渲染器：`renderSeatbeltProfile(policy)`（SBPL：`(version 1)(allow default)` +
    `deny file-read* file-write*` per subpath/literal，**路径做 SBPL 字符串转义**）与
    `renderBwrapArgs(policy)`。渲染器只消费 policy —— 平台差异不外溢。
- **D4 G1 origin 凭据下盘**（独立于沙箱、无条件生效）：
  1. `cloneRepo` 成功后立即 `git remote set-url origin <urlRedacted>`
     （redacted 值既有，`gitRepoCache.ts:631-647` 行内）。
  2. warm fetch / pull base 等**网络 git** 改走 `runGitAuthed(localPath, args, plainUrl)`：
     凭据写入 `appHome/.gitcred-<ulid>`（0600、用完即删——该路径在沙箱 deny 区，agent
     不可读），`GIT_ASKPASS=<内部 helper>` + `AW_GIT_CRED_FILE=<path>` 注入 env；argv 与
     env 均不含明文凭据（Linux `/proc/<pid>/environ` 同 uid 可读——凭据只在 0600 文件）。
     helper 为平台自带的小脚本（写入 `appHome/libexec/git-askpass.sh`，daemon 启动确保存在）。
  3. **存量镜像一次性清洗**：warm 路径命中时检测 origin URL 含 userinfo（`://…@`）→
     `set-url` 为 redacted（幂等；下次 fetch 走 askpass）。
  4. 非网络 git（status/diff/worktree add）零变化——不需要凭据。
- **D5 模式与探测**：config 新键 `sandboxMode: 'enforce'|'warn'|'off'`（default `'warn'`）。
  `services/sandbox/probe.ts`：`probeSandboxMechanism()`（darwin：`/usr/bin/sandbox-exec`
  存在 + **试跑** `sandbox-exec -p '(version 1)(allow default)' /usr/bin/true`；linux：
  **试跑** `bwrap --bind / / -- /bin/true` —— 设计门自审 Q3：二进制存在 ≠ 可用，
  无特权 userns 被禁的发行版/容器里 bwrap 装了也起不来，探测必须以真实一跑为准）；
  daemon 启动探测一次并缓存（`start.ts` soft-probe 模板）。语义：
  - `off` → 永不包装。
  - `warn` + 可用 → 包装；`warn` + 不可用 → 裸跑 + 每任务一条 `lifecycle_alerts`
    （rule=`sandbox-degraded`, severity=warn, detail 含 mechanism/nodeRunId）+ WS 广播。
  - `enforce` + 可用 → 包装；`enforce` + 不可用 → **launch 拒绝**（任务创建即失败，
    DomainError `sandbox-unavailable`，错误信息给出安装指引）。
- **D6 可观测**：`GET /api/runtimes/status` 响应加顶层 `sandbox: { mode, mechanism:
  'seatbelt'|'bwrap'|null, available: boolean }`；前端 Settings→Runtime 头部一枚
  `StatusChip`（可用=ok / warn 降级 / off=muted）+ i18n 双语。**AC-7 追溯**＝
  spawn 时 log（含 nodeRunId、sandboxed true/false）+ 降级 alert（detail 含首个受影响
  nodeRunId）；不加 node_runs 列（零 migration——版本闸/冻结 fixture/journal 连锁全免；
  若后续需要列级审计另立小 RFC）。
- **D7 失败模式**：profile 语法错/机制拒绝执行 → spawn 立败，走既有
  `runtime-spawn-failed`（`runner.ts:793-816/856-881`）显式失败，绝不静默裸跑；
  enforce 拒绝发生在 launch 层（用户立即可见），不产生 node_run。
- **D8 与既有测试的相容性**（红线复核）：driver buildSpawn 输出不变（golden ✓）；
  shell 桩 argv 契约不变（e2e 不装配 sandboxCtx ✓）；`spawnBinaryPath`/version-registry
  继续读 `plan.cmd[0]`（✓）；`claudeSandboxEnv`（IS_SANDBOX）与本设计正交（claude 自身
  权限 gate，保留）。

- **D9 顺手硬化**：`openDb` create 后对 `db.sqlite` best-effort `chmod 0600`（评审
  实录：secret.key 0600 而 db 继承 umask——同 uid 威胁下无差别，但对「同机他用户」
  这层免费边界没理由不上）。

## 3. 模块布局

```
services/sandbox/policy.ts   — SandboxPolicy 计算 + renderSeatbeltProfile + renderBwrapArgs（纯函数）
services/sandbox/probe.ts    — 机制探测（缓存）+ SandboxStatus
services/sandbox/index.ts    — wrapSandbox(cmd, ctx) + buildSandboxCtx(config, probe, task 路径)
services/gitRepoCache.ts     — D4：clone 后 set-url、runGitAuthed、存量清洗
runner.ts / memoryDistiller.ts / runtimeSmoke.ts — spawn 接线（可选 ctx）
shared config schema         — sandboxMode 键
routes/runtimes.ts           — status 响应 sandbox 字段
frontend RuntimeTab          — 状态 chip + i18n
docs/disaster-recovery.md 之外新增 docs/sandbox.md（或并入 runtime 文档）
```

## 4. 测试策略（必写清单）

1. **policy 纯函数**：deny/allow 集完整性（威胁清单逐项有对应 deny；本任务 worktree/
   runDir/repos/skills 在 allow）；多 repo 任务多 worktree;路径含空格/引号的 SBPL 转义；
   bwrap args 顺序（tmpfs 先、bind 后——后者优先生效）。
2. **wrapSandbox**：ctx 缺省=原样返回（零包装——既有测试相容性的直接锁）;darwin/linux
   argv 头形态；`plan.cmd` 不被就地修改（防 spawnBinaryPath 污染）。
3. **probe**:二进制缺失→unavailable；探测缓存（同进程二次调用零 spawn——注入 spawnFn 计数）。
4. **模式语义**：warn+unavailable → 裸跑 + alert 恰一条/任务（去重）;enforce+unavailable →
   launch 拒绝（DomainError 码）;off → 永不包装（golden 锁:wrap 调用零次）。
5. **G1**:clone 后镜像 `.git/config` 全文无凭据（file:// fixture + 伪凭据 URL 断言）;
   `runGitAuthed` 的 env 含 GIT_ASKPASS 且 argv/env 无明文凭据;凭据文件 0600 且用后删除;
   存量含凭据 origin 被幂等清洗;非网络 git 路径零变化(源码锁)。
6. **gated 集成**（探测到机制才跑,CI ubuntu 无 bwrap 自动 skip）：真 sandbox-exec 包
   `/bin/cat`：读 `secret.key`/`db.sqlite` 失败、读本任务 worktree/镜像对象库成功;真
   bwrap 同型(Linux 本地/自托管 runner)。
7. **回归红线**：golden/argv 桩全量照跑;`rfc143-business-spawn`、shell 桩契约测试零改动。

## 5. 已知限制（v1 明示）

- 不遮进程侧信道（ps/environ——凭据已不入 argv/env，残余面为路径名等低敏信息）。
- `off`/降级模式下与现状等同（威胁未消除,仅可见）。
- 不隔离网络;不隔离 daemon 自身;Windows 不支持（平台无 Windows 发行）。
- bwrap 缺失的 Linux 发行版需手工安装（文档给出指引;enforce 档位将拒绝启动任务）。
