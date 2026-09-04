# RFC-356 技术设计

> **修订 r2（2026-09-04，设计门后）**：两路对抗评审报出 3 条 P0 + 14 条 P1，逐条回源码复核后全部折入。
> 本文档的 §2.2 阶梯形状、§3 的 RFC-254 契约改动、§4 的触发门、§5.3 的双身份 handle 都是 r2 才成立的形状；
> r1 的对应写法**已作废**。改动理由逐条记在 §13。

## 0. RFC-294 目标架构对齐

按 CLAUDE.md §RFC workflow 第 8 条，先对账本次改动落在哪个 bounded context / 哪一层。
`architecture/module-symbol-owners.json` 已经给出每个被触及符号的**目标 owner**：

| 符号                                                                                                 | 现居                        | 目标 context / 层                 | removeAfterWave |
| ---------------------------------------------------------------------------------------------------- | --------------------------- | --------------------------------- | --------------- |
| `removeWorktree` / `createIsolatedWorktree`                                                          | `util/git.ts`               | `source-control` / infrastructure | W5              |
| `createNodeIso` / `discardNodeIso` / `isoWorktreePathFor` / `rebuildIsoHandle`                       | `services/nodeIsolation.ts` | `platform` / application          | W9              |
| `killProcessTree` / `adoptSpawnedProcessTree` / `isProcessTreeAlive` / `releaseProcessTreeOwnership` | `util/process.ts`           | `task-execution` / application    | W4-E1           |
| `adoptProcessTree`                                                                                   | `util/windowsJobObject.ts`  | `task-execution` / inbound        | W4-E1           |
| `$file`（`services/execution/managedProcess.ts`）                                                    | `services/`                 | `platform` / application          | W9              |

`util/process.ts` 另在 `architecture/commons-manifest.json` 登记为 **owner=platform** 的
`spawnversionprobe-killprocesstree` 内核（"the platform tree-kill primitive"）。

**本 RFC 承担的演进步**：新增能力**落在各自目标 owner 已经拥有的那个文件里**，不新建横向 facade、
不新增跨 context 内部 import；三层的机制归属与 RFC-294 §G3 第 4 层 ExecutionKernel（"许可、iso、spawn、
retry、merge、settle 所需的机制原语"）、§G2 `source-control`（"repo/…/worktree/submodule … 与 Git 操作语义"）、
`platform`（"runtime/process mechanism"）逐条对应。

**本 RFC 明确不承担、留下的债**：三个文件的物理归位（W5 / W4-E1 / W9）。它们各自的 wave 未获授权，
本 RFC 不因「顺手」而搬——搬动会把 400+ 消费方的 import 一起改，属另一场手术。

**新增文件的落位**：唯一新增文件 `packages/backend/src/util/fsReclaim.ts`（退避目录删除原语）。
放 `util/` 而不是 `platform/` 是**刻意的**：今天 `packages/backend/src/util/**` 里**没有任何文件**
`import '@/platform/...'`（实测 0 命中），而 `util/git.ts` 是它的一等消费方；把它放进 `platform/`
会凭空造出一条 `util → platform` 的新边类，让 `architecture/cross-context-imports.json` 多一条
本 RFC 不打算负责的账。`util/` 今天就是 platform 机制的物理暂居地（`util/process.ts` 即先例），
一并在 W9 归位。

## 1. 现状对账（改之前的确切形状）

```
runAssembly（schedulerAssembly.ts:229-243）
  keepIf 为假
    └─ await spec.discardIso(handle)          ← 裸 await，无 catch（:234）
    │    discardNodeIso 内部：removeWorktree 失败只 warn（nodeIsolation.ts:1327）
    └─ handle = await spec.iso.create()       ← 同一路径裸 worktree add（util/git.ts:2661）
         catch → onIsoRecreateFailure         ← 节点失败（nodeMechanics.ts:4727 / :2779）
```

- iso 路径：`isoWorktreePathFor(appHome, taskId, isoKey, dirName)` = `{appHome}/iso/{taskId}/{isoKey}[/{dir}]`
- iso 键：mainline 与脚本线都用**原始行 id** 贯穿全部 attempt（`nodeMechanics.ts:3857`、`:2682`；D17）
- 子进程 cwd 就是 iso（agent 线 `nodeMechanics.ts:4499`、脚本线 `:2921`）——这是句柄持有者能挡住删除的原因
- 持久化：`persistIsoBase` 把 `handle.containerPath` 写进 `node_runs.iso_worktree_path`
  （`isolatedAgentRun.ts:153`）
- 回读：`isoKeyOf(isoWorktreePath, rowId) = basename(path)`（`nodeMechanics.ts:973`，RFC-210 round 6 P2）
  ——**iso 键与行 id 早已解耦**，这是 L4 能成立的地基
- 三处仍在裸派生（本 RFC 补齐）：`wrapperMechanics.ts:1662`、`:1694`、
  `platform/persistence/sqlite/taskLifecycleRepair/options-S1.ts:79`
  （设计门穷举了 `rebuildIsoHandle` 的 6 个生产调用点、`isoWorktreePathFor` 全部调用点、`resolveIso`、
  GC 容器枚举与 `workspaceBoundary.ts:71-72`，确认**没有第四处**）

## 2. L1 —— 残留工作树回收原语

### 2.1 `removeDirectoryWithRetry`（新文件 `util/fsReclaim.ts`）

```ts
export async function removeDirectoryWithRetry(
  path: string,
  opts?: { delaysMs?: readonly number[]; log?: Logger },
): Promise<{ removed: boolean; attempts: number; lastError?: string }>

/** 默认退避档：0 / 50 / 100 / 200 / 400 / 800 / 1600 ms，共 7 次、总等待 ≈ 3.15s。 */
export const DEFAULT_RECLAIM_DELAYS_MS: readonly number[]
```

两条判据，**一条有实测、一条明确写成没有**（设计门 P1-3 纠正了 r1 的引用反转）：

1. **不能用 `fs.rm` 的 `maxRetries` / `retryDelay`**——RFC-254 已实证 **Bun 不实现** Node 的这两个选项
   （`design/RFC-254-windows-native-execution/plan.md:554`），必须自己写循环。**这条有实测支撑。**
2. **退避档没有实测依据，是保守估计。** r1 曾把 RFC-254 那句「显式重试确实在跑但一秒不够」当成「所以预算
   要 > 1s」——**读反了**：那句的上下文是「两步尝试**都被证伪**」，结论是「去查谁还开着，不要继续加预算」；
   `tests/fixtures/tempDir.ts:62-67` 说得更直白：「NO amount of retry helps (a 2s loop still failed EBUSY)」。
   而且那条实测是 bun:sqlite 句柄场景，与 iso 不同域。**因此退避只当廉价的第一道**：
   真正的自愈来自 L2（消除逃逸后代，减少句柄持有者）与 L4（换代，绕开清不掉的残留）。
   代码注释必须写清这一点，免得后人再拿它当「预算够了就一定能删掉」的依据。
3. **第一次尝试零延迟**：常态一次成功，不给正常路径加时延。

不做 `Bun.gc(true)`：那是测试夹具为 bun:sqlite 句柄准备的（`tests/fixtures/tempDir.ts:68`），
iso 工作树里没有 daemon 自己开着的 sqlite。

### 2.2 `reclaimWorktreePath`（`util/git.ts`，目标 owner source-control/infrastructure）

```ts
export type ReclaimWorktreeOutcome =
  | { kind: 'absent' }
  | { kind: 'removed'; via: 'git' | 'filesystem'; attempts: number }
  | { kind: 'blocked'; residualPath: string; lastError: string; attempts: number }

export async function reclaimWorktreePath(opts: {
  /** 同一 common git dir 的任一工作树——`remove` / `prune` 都从这里发。 */
  repoPath: string
  worktreePath: string
  /** 该工作树占用的分支名（可选）。给了就顺带清它的 stale ref lock，见 2.4。 */
  branchRef?: string
  timeoutMs?: number
  delaysMs?: readonly number[]
  log?: Logger
}): Promise<ReclaimWorktreeOutcome>
```

阶梯（**锁的粒度是 r2 的关键修正**，见下）：

| 档  | 动作                                            | 是否持 registry 锁 | 结果                       |
| --- | ----------------------------------------------- | ------------------ | -------------------------- |
| 1   | `existsSync(worktreePath)` 为假                 | 否（零进程）       | `absent`                   |
| 2   | `git worktree remove --force`（带 `timeoutMs`） | **是**             | 成功 ⇒ `removed via git`   |
| 3   | `removeDirectoryWithRetry`                      | **否**（见下）     | —                          |
| 3b  | 删掉了 ⇒ `git worktree prune`                   | **是**             | `removed via filesystem`   |
| 4   | 仍在                                            | —                  | `blocked`（带残留 + 错误） |

**r2 修正 ①：退避删除必须在 registry 锁外。** `withWorktreeRegistryLock` 按 **common git dir** 归一
（`util/git.ts:847-881` 的 `resolveCommonGitDirKey`），同仓的全部任务 / 分片 / 子任务共用一把。r1 写的
「全程持锁」会让一次阻塞回收把整仓的 registry 锁握满 ~3.15s，L4 最多 4 代 × N 仓叠加就是几十秒，
期间同仓所有兄弟分片的 `worktree add` 全部排队。`removeDirectoryWithRetry` 根本不碰 registry，
锁里只留 `remove` / `prune` 两个 git 子进程。

**r2 修正 ②：`absent` 不再 `prune`。** r1 让第 1 档顺带 prune 一次，而 §5.3 的选键会在**每次建树**时
探测——于是每次正常创建都多一个持锁的 git 进程，AC-2「常态不额外起进程」在创建侧变成净回归。
现在 `absent` 是纯 `existsSync`、零进程零锁；悬空注册项由第 3b 档（真删过东西时）和既有 GC 的 prune 收。

**r2 修正 ③：多仓的容器不走这条阶梯。** `repoCount > 1` 时容器 `{appHome}/iso/{taskId}/{key}` 只是装着
N 棵工作树的普通父目录（`nodeIsolation.ts:172-180`、`:254-258`），对它调本函数会在第 2 档撞
`is not a working tree`、第 3 档 `rm -rf` **绕过 git 把 N 棵树一起删掉**。规则固定为：
**先逐仓走阶梯（各用自己的 `repoPath`），容器最后、且只走 `removeDirectoryWithRetry`。**

`prune` 必须持 registry 锁：不持锁时，另一个任务正在同一 common dir 上 `worktree add` 的半初始化注册项
会被本次 prune 观察到并删掉（`services/task.ts:5330-5336` 记着这条 RFC-287 五轮门实证）。

`removeWorktree` 保留原签名与原语义（抛 `DomainError`）——它还有 GC / 备份 / 多仓拆卸等消费方，
本 RFC 不改它们的失败面；`reclaimWorktreePath` 在其上组合。

### 2.3 消费方

| 调用点                                                                                          | 改动                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discardNodeIso`（`nodeIsolation.ts:1319`）                                                     | `removeWorktree` → `reclaimWorktreePath`；`blocked` 时 warn 文案不再承诺 GC（§6）                                                                                                     |
| **resolve-iso 三处**（`nodeIsolation.ts:1489` / `:1555` / `:1709`）                             | 同样换用 `reclaimWorktreePath`。**必须一起改**：resolve-iso 就落在 iso 容器**内部**（`join(containerPath,'resolve-…')`，`:1484`/`:1620`），删不掉会让容器非空、直接挡住 L4 的同代重建 |
| `chooseIsoWorkspaceKey`（`isolatedAgentRun.ts`）                                                | 建树前按 §5.3 选键                                                                                                                                                                    |
| `reclaimStalePrepArtifacts`（`services/task.ts:5265`）                                          | **只复用 `removeDirectoryWithRetry`**（见下）+ 新增 stale ref lock 清理                                                                                                               |
| GC `removeIsoContainer` / `removeAgedPath` / scratch（`nodeWorkspaceMaintenanceFilesystem.ts`） | `rm` → `removeDirectoryWithRetry`；顺带把 `:70-74` 那处**不持锁**的 `prune` 收进 registry 锁                                                                                          |

**r2 修正 ④（设计门 P1-7）：`reclaimStalePrepArtifacts` 用不上第 2 档。** 它删
`{appHome}/worktrees/{slug}/{taskId}` 时**手里没有该 slug 对应的镜像仓**——镜像集合要到步骤 ③ 才解析
（`task.ts:5296-5310` vs `:5324-5348`），而阶梯第 2 档需要 `repoPath`。所以它只能复用第 1 层原语。
AC-15 因此从「只有一份回收实现」改写为「**目录删除只有一份实现**」（proposal 已同步）。
把 slug→镜像解析提前是可行的正解，但那是 `reclaimStalePrepArtifacts` 自己的重构，不折进本 RFC。

### 2.4 stale ref lock（并发 session 2026-09-04 实测线索）

被 abort 掐掉的 `git worktree add` 会留下 `refs/heads/<branch>.lock`，签名
`fatal: cannot lock ref 'refs/heads/agent-workflow/<task>': Unable to create '….lock': File exists`；
**仓内没有任何生产路径清它**（已验证），于是下一次在同一分支名上建树会一直失败——与 issue #13 **同形**
（残留物挡住重建、且无自愈路径）。完整记录在 `docs/audit-backlog.md:3961`；CI 取证 run `33832413648`
（ubuntu shard 2/4，`tests/rfc303-worktree-abort-cleanup.test.ts`），对方已在用例侧做鲁棒化
（`addWorktreeToleratingStaleRefLock`，commit `bdd48dfcc`），**未碰生产代码**。

处置：`reclaimWorktreePath` 接受可选 `branchRef`，给了就在阶梯末尾检查
`{commonGitDir}/refs/heads/{branchRef}.lock`——**存在且 mtime 早于 `STALE_REF_LOCK_MIN_AGE_MS`（默认 60s）
才删**（活的 git 进程正持有它时不能抢）。**iso 路径不受影响**（`worktree add --detach`，无分支名，
不传 `branchRef`）；真正的消费方是任务工作树侧的 `reclaimStalePrepArtifacts`。

## 3. L2 —— Job Object 接线 + RFC-254 契约修正

### 3.1 接线点

`services/execution/managedProcess.ts:524`（`const pid = ...` 之后）：

```ts
if (pid !== null) adoptSpawnedProcessTree(pid) // win32 且 FFI 可用时才真的做事
```

**必须先于 `await req.onSpawned(...)`**（`:526-539` 是一次 DB 往返）——否则 §3.4 的 spawn→assign 窗口
会从微秒扩成一次落库。

释放点：正常收尾（`:917` 的 return 之前）`releaseProcessTreeOwnership(pid)`。

### 3.2 RFC-254 契约修正（r2 新增，设计门 P0-2 / P1-4）

**没有这一节，L3 在 Windows 上恒等于空转。** 今天的三处实现互相锁死：

- `windowsJobObject.ts:211-225` — `terminate()` 在 `finally` 里 `closed = true; CloseHandle(handle)`；
- `windowsJobObject.ts:227-228` — `liveCount()` 开头 `if (closed) return 0`，**硬编码、不查内核**；
- `util/process.ts:96-99` — `killProcessTreeWin32` 在 `terminate()` 之后**立刻 `ownedTrees.delete(pid)`**。

于是杀树那一刻观测面就被销毁：map 项没了 ⇒ `isProcessTreeAlive` 返 `null` ⇒ L3 立即 `'unknown'`；
就算保住 map 项，`liveCount()` 也因 `closed` 直接返回 0 ⇒ 第一次轮询就 `'dead'`。

本 RFC 改三处（用户 2026-09-04 裁决 D4「完整修」）：

1. **`terminate()` 不再关句柄**——只调 `TerminateJobObject` 并返回其真值；`closed` 不置。
   关句柄的唯一出口是 `dispose()`（语义不变：停止跟踪**并**停止整棵树）。
2. **`liveCount()` 去掉 `closed` 短路**，terminate 之后照样 `QueryInformationJobObject`；
   只有 `dispose()` 之后才返回 0（句柄已关，无从查起）。
3. **`killProcessTreeWin32` 保留 map 项**（改由运行收尾的 release 出表），并**尊重 `terminate()` 的返回值**
   ——今天它丢弃返回值、无条件 `return true`（P1-4）。这在死代码状态下无害，T7 一接线就变活：
   `managedProcess.killTree`（`:270-277`）会据此跳过 `child.kill()` 兜底，把一次失败的 syscall
   当成「肯定死了」——正是 `windowsJobObject.ts` 顶部注释点名要杜绝的那种断言。

### 3.3 `childUnreaped` 分支（r1 的两条理由都不成立）

r1 说「这条分支不释放句柄，以便 `isProcessTreeAlive` 权威判活」。设计门查出两处错：

- `childUnreaped` **只能**由 `reapDeadline` 触发，而它只在 `escalate()` 的 `killTimer` 里 arm
  （`managedProcess.ts:764-768`）——所以走到这里必然已经 `killTree` 过。在 r1 的假设下（terminate 关句柄）
  句柄早已出表，**「泄漏一个句柄」这笔债根本不存在**；
- `isProcessTreeAlive` 全仓**零生产消费方**（只有定义与一条注释；`orphans.ts` 与 `killStaleRunProcessTree`
  用的是单 pid 的 `isProcessAlive`）。

r2 的真实形状（在 §3.2 之后）：`terminate()` 不再关句柄 ⇒ **map 项在整个运行期间都在**。于是

- `childUnreaped` 分支**不 release**（保留 map 项）：后续的带外杀树（`killStaleRunProcessTree` →
  `killProcessTree` → `ownedTrees.get(pid)`，`util/process.ts:312`/`:319`）仍能拿到**原子 job terminate**
  而不是 taskkill 枚举——这是真实且今天就有的消费方；树最终随 daemon 退出而死。
- 代价：每个 unkillable 运行留一个 Win32 句柄到 daemon 结束。这条路径极罕见，记为债（§12）。

### 3.4 已知窗口（沿用 RFC-254 处置，不新造）

`Bun.spawn` 返回时子进程**已经在跑**（`util/windowsJobObject.ts:163` 的 KNOWN WINDOW 注释），
assign 之前的窗口里 fork 出的后代不在 job 里。RFC-254 design.md:127 已把它记录在案，处置是
「接受该窗口，回收证明按 best-effort 标注」。本 RFC 不引入 `CREATE_SUSPENDED`（Bun 不暴露）。
补一条实况：**带 launcher 的路径（`launchNonce !== undefined`）子进程会阻塞等激活帧，窗口实际已关闭**，
§3.4 对那条路径是悲观描述。

### 3.5 ARM64 降级（D2）

`adoptProcessTree` 在 Bun 无 `dlopen` 的构建上返回 `null`（ARM64 实测，RFC-254）。处置：

- `adoptSpawnedProcessTree` 返回 false ⇒ 杀树自动落到 `taskkill /T /F`，**不新增平台专属杀树路径**；
- daemon 启动时按 `processTreeOwnershipDiagnosis()`（`util/windowsJobObject.ts:274-282`）warn 一次；
- 该诊断同时进入 L1 `blocked` 的失败消息（§6）。

## 4. L3 —— 杀树后等待树静默

### 4.1 原语（`util/process.ts`）

```ts
export type TreeQuiesceOutcome = 'dead' | 'alive' | 'unknown'

export async function awaitProcessTreeQuiesced(
  pid: number,
  opts?: { budgetMs?: number; log?: Logger },
): Promise<TreeQuiesceOutcome>

export const TREE_QUIESCE_BUDGET_MS = 2_000
```

- POSIX：轮询 `isProcessTreeAlive`（`process.kill(-pid, 0)`）直到假或预算耗尽。
- win32 + job：轮询 `liveCount() === 0`——**依赖 §3.2 的契约修正才有意义**。
- win32 无 job：`isProcessTreeAlive` 返回 `null` ⇒ **立即返回 `'unknown'`**，绝不空等预算。

### 4.2 触发门（r2 重划，设计门 P0-3）

r1 把门定为「`escalate()` 被调用过」。设计门查出**真正留句柄的两条路都不过 `escalate()`**：

- **drain 超时分支**（`managedProcess.ts:891-895`）直接 `killTree(child,'SIGKILL')`，绕过 `escalate()`。
  而它的触发条件逐字就是「幸存的孙进程把管道写端占着」——正是随后卡住 `git worktree remove` 的那个
  句柄持有者。这条分支已经等满 `max(1000, graceMs)` 且已经杀了树，加 quiesce 对干净运行零成本。
- **带外杀树**：`taskIdleTimeout.ts:47`、`providerBackground.ts:193`、`services/task.ts:4052`、
  `services/orphans.ts` 全部走 `killStaleRunProcessTree` → `killProcessTree`，一次都不经过 `escalate()`。
  其中 `task.ts:4052` 最要命：**杀完紧接着把节点回滚到 `pre_snapshot`**（往刚被杀的树里写 git），
  正是 proposal §2「resume 每次都撞墙」的那条路径；而 `killStaleRunProcessTree` 自己的等待循环
  （`util/process.ts:305-320`）只看 `isProcessAlive(pid)`（直接子进程），根本不看树。

r2 的门：

1. **门改成「本次运行调用过 `killTree`」**——在 `managedProcess.killTree`（`:270`）里置一个本次运行的标志，
   收尾相位据此决定等不等。这样 escalate 路径与 drain 超时路径都被覆盖，干净退出仍逐字不等。
2. **`killStaleRunProcessTree` 内部补一跳**：`killProcessTree(pid,'SIGKILL')` 之后、返回 `'killed'` 之前，
   调一次 `awaitProcessTreeQuiesced`。这样带外杀树的三个消费方（含 `task.ts:4052` 的杀完即回滚）
   一起受益，且不改它的返回值语义（`'killed'` 仍由 `isProcessAlive` 判定，quiesce 只是多等一会）。

等不到只 `log.warn`（带 pid / 预算 / 最后一次 liveCount），**不改 `outcome`、不改 `processUnreaped`**
——`shouldRetryNodeFailure(failureCode, processUnreaped)`（`nodeMechanics.ts:910-923`）的既有语义不动。

## 5. L4 —— iso 键代际（真正的自愈档，D1）

### 5.1 为什么可行

r1 初判「换唯一路径不可行，因为 `rebuildIsoHandle` 纯派生路径」是**错的**：它的调用方传的不是行 id，
而是 `isoKeyOf(持久化的 iso_worktree_path, rowId)`（`executionMergeRecovery.ts:98`、`:183`、
`nodeMechanics.ts:1845`）——RFC-210 round 6 P2 加的。「iso 键 ≠ 行 id」**平台已经支持并在生产使用**。

设计门穷举确认只剩三处裸派生，但 **r1 给 wrapper 那两处写错了取值路径**（P1-1）：
`WrapperRunSnapshot`（`domain/wrapperExecution.ts:14-24`）**没有** `isoWorktreePath` 字段，
`effectiveExisting.isoWorktreePath` 不存在。可用的是同函数 `wrapperMechanics.ts:1601` 已经读到的
`cur = nodeExecution.read(wrapperRunId)`（`NodeExecutionSnapshot` 有该字段，
`ports/nodeExecutionPersistence.ts:55`），**但带一条顺序约束**：`merged` 再入分支的 CAS
（`wrapperMechanics.ts:1622-1634`）会显式把该列写成 `null`，只有 **CAS 之前**读到的 `cur` 还留着
上一代的物理键。`cur` 恰好在 CAS 之前读，可用——这条顺序依赖必须写进代码注释，否则后人挪动读取点就会
静默失效。

两处风险不同档，实现与测试要分开对待：

- `wrapperMechanics.ts:1662` 产出的 handle **要拿去 merge-back**，指错路径是硬故障；
- `:1694` 只做 discard，路径缺失可容忍。

第三处 `taskLifecycleRepair/options-S1.ts:79` 把 select 从 `{id}` 扩到 `{id, isoWorktreePath}` 即可，
**但兜底判据要一起收紧**（P2-4）：`deriveScopeRoot` 今天只判 `existsSync(isoRoot)`，legacy / passthrough 行
仍会退回裸派生路径——恰是 L4 已经放弃的那个阻塞目录。兜底改成「必须是**活的工作树**」（`isGitWorkTree`）
而不只是「存在」。

### 5.2 键的形状

`{基键}-{代}`，代从 2 起：`01JABCDEF…` → `01JABCDEF…-2` → `-3`。

- **必须用 `-` 而不是 `~`**：键会被拼进 git ref `refs/agent-workflow/iso/{taskId}/{key}/{base|node}`
  （`isoRefName`，`util/git.ts:2501`）与池 ref `poolRefName`。实测 `git check-ref-format` 收 `-2`、
  **拒 `~2`**（`~` 是 git ref 保留字符）。
- ULID 是 Crockford base32（大写字母+数字），不含 `-`，`basename` 回读无歧义。
- 与仓内既有约定同形：repo-group 的隔离分支去重后缀就是 `agent-workflow/{taskId}-2`（`task.ts:5337-5340`）。
- `MAX_ISO_KEY_GENERATIONS = 3`（即 `-2`、`-3`、`-4`）。**这不是纯保险丝**（P2-1）：脚本线
  `isoOnRetry: 'always-recreate'`（`nodeMechanics.ts:2775`）每次重试都换树，而 `defaultNodeRetries`
  上限 50（`shared/src/settingsNumericBounds.ts:37`）——在本 RFC 瞄准的病态场景里第 5 次尝试就会耗尽。
  文档与代码注释都必须写明「这个上限预期会被够到，够到就以 §6 的诊断失败收场」，不要假装它够不到。

### 5.3 选键：先短路，再回收

```ts
// isolatedAgentRun.ts，writeSem 锁内
const chosen = await chooseIsoWorkspaceKey({ appHome, taskId, baseKey, canonRepos, log })
if (chosen.kind === 'blocked') throw new IsoWorkspaceBlockedError(chosen)
const effect = createLocalEffectAttemptObserver({
  nodeRunId: args.isoKeyRunId,                        // ← 真实行 id，见 §5.4①
  resourceKeys: [`isolation:${taskId}:${chosen.key}`, ...],
  request: { v: 1, dbNodeRunId: args.isoKeyRunId, isoKey: chosen.key, ... },
})
await effect?.beforeAct()
const handle = await createNodeIso({ ..., isoKey: chosen.key, dbNodeRunId: args.isoKeyRunId })
```

`chooseIsoWorkspaceKey` 对 gen = 0…MAX 逐代：

1. **`existsSync(容器路径)` 为假 ⇒ 直接选中**（r2 修正，设计门 P1-1）。这是压倒性的常态，
   **零 git 进程、零 registry 锁**，与今天逐字等价——AC-2 的「常态不额外起进程」在创建侧也成立。
2. 否则按 §2.2 修正 ③ 的规则回收（逐仓阶梯 + 容器只走退避删除）。全部 `absent`/`removed` ⇒ 选中该代
   （`git worktree add` 接受**空目录**，实测）。
3. 任一 `blocked` ⇒ 进下一代。

> 设计门建议过「完全失败驱动：照常 `worktree add`，撞 `already exists` 才回收换代」。**未采纳**：
> `createNodeIso` 是逐仓循环（`nodeIsolation.ts:250-315`），第 2 个仓失败时第 1 个仓的树已经建好，
> 失败驱动必须先清理半成品再整体换代，反而更复杂。`existsSync` 短路已经把常态成本降到一次系统调用，
> 两者的热路径开销等价。

### 5.4 三条必须遵守的约束

**① effect observer 的 `nodeRunId` 必须是真实行 id。**
`beforeAct()` 会 `readLineage({taskId, intentId, nodeRunId})`（`localEffectObserver.ts:87`），而
sqlite（`sqliteTaskExecutionEffectPersistence.ts:67-73`）与 postgresql（`postgresqlTaskExecutionEffectPersistence.ts:272-278`）
两个实现都明写：给了 `nodeRunId` 但查不到 `node_runs` 行 ⇒ 返回 `null` ⇒ 抛 `task-continuation-stale`。
合成键没有行，会当场把建树打挂。

**② `IsoHandle` 必须同时带两个身份（r2 新增，设计门 P0-1——这是 L4 最危险的一个洞）。**
r1 只给 create 侧做了拆分，**discard 侧漏了**：`discardNodeIso` 自己起 observer 时用的就是
`handle.nodeRunId`（`nodeIsolation.ts:1296`），而 `await effect?.beforeAct()` 在 `try` **之外**
（`:1314`）；调用点 `schedulerAssembly.ts:234` 的 `await spec.discardIso(handle)` 是**裸 await、无 catch**
（对照 `:297` settle 处那次是 `.catch(...)` 包着的）。于是换代之后的下一次丢弃**必然抛**，异常穿出
`runAssembly` ⇒ 节点以 `scheduler-node-threw` 死——**L4 会造出一个比 issue #13 更早触发的新 wedge。**

修法：`IsoHandle` 加 `dbNodeRunId`（真实行 id）与既有 `nodeRunId`（物理 iso 键）并列。
`createNodeIso` / `rebuildIsoHandle` 都要求调用方两个都传（`rebuildIsoHandle` 的调用方今天传
`isoKeyOf(...)` 做物理键，行 id 就在手边）。**凡是起 effect observer 的地方一律用 `dbNodeRunId`；
凡是拼路径 / ref / `resourceKeys` 的地方一律用 `nodeRunId`。** 加一条源码层守卫钉死这条分工。

**③ 选键 / 回收发生在 durable effect fence 之前**（偏离项 1，§10）。

### 5.5 handle 内部的一致性（设计门已逐面复核）

键变了之后仍自洽：`isoRefName` / `isoRefGlob`（`-` 合法）、`poolRefName`
（`refs/agent-workflow/pool/{taskId}/{key}/{slug}`）、`worktreeRefName`（不含键）、effect `resourceKeys`、
DB 列（`prepareRetryAttempt` 在 create 之后调 `persistIsoBase`——`nodeMechanics.ts:4013`、脚本线 `:2801`
——所以新 `-2` 路径确实落到新铸的重试行上，AC-7 的持久化成立）、GC（按容器整删、与键无关）、
resume/replay（三处早已用 `isoKeyOf`）。fanout 分片 / 聚合 / call 子任务各自传自己的行 id 且从 handle
读路径，不受影响。`handleTaskIdOf` 取父段 taskId，不受叶子后缀影响（但自身有分隔符缺陷，§7）。

## 6. 诊断与失败面（G3）

`IsoWorkspaceBlockedError` 携带结构化诊断，由 `onIsoSetupFailure` / `onIsoRecreateFailure` 渲染进
`errorMessage`（分类字符串 `iso-setup-failed` / `iso-recreate-failed` **不变**）：

```
iso-recreate-failed: 无法回收残留的隔离工作树（已尝试 3 代）
  残留: C:\Users\x\.agent-workflow\iso\01J…\01J…-3
  最后错误: git worktree remove failed: fatal: failed to delete '…': Invalid argument
  进程树归属: 不可用（ffi-unavailable）—— 本机 Bun 构建无 FFI，杀树降级为 taskkill 枚举，后代可能逃逸
```

同时把 `discardNodeIso` 那条撒谎的 warn 改掉：`blocked` 且任务仍活跃 ⇒
`iso worktree reclaim blocked (will retry with a new generation)`，**不再写「leaving for GC」**
——iso GC 明确跳过活跃 / 非终态任务（`systemWorkspaceGc.ts:976`、`workspaceMaintenance.ts:304-313`），
那句承诺对活任务从来不成立。

## 7. 连带修复：`handleTaskIdOf` 的路径分隔符

`nodeIsolation.ts:788-793` 用 `isoWorktreePath.split('/')` 从 `join()` 生成的路径回读 taskId，
Windows 上是 `\` ⇒ `lastIndexOf('iso')` 恒 -1 ⇒ 恒返回 `'unknown'`。后果：RFC-210 的 worktree-scoped
池锚点在 Windows 上全部落成 `wt/unknown/{slug}`，跨任务串台、按 taskId 的清理永不匹配。

修法用 `/[\\/]/` 拆分而不是 `path.sep`（P2-3）：路径由 `join` 产生，但 `appHome` 与 git 回读的路径在
Windows 上都可能带 `/`。AC-14 的测试两种形状都要断。

## 8. 失败模式矩阵

| 场景                                   | 今天                                           | 本 RFC 之后                                    |
| -------------------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| POSIX，正常丢弃 / 建树                 | remove 一次成功；add 直接建                    | 逐字不变（`existsSync` 短路 + 阶梯第 2 档）    |
| Windows，句柄短暂占用                  | 一击即弃 ⇒ 残留 ⇒ 重建撞 `already exists` ⇒ 死 | 退避内删掉 ⇒ 正常重建                          |
| Windows，句柄长期占用（AV / 逃逸后代） | **永久** wedge                                 | 换代建新树继续重试；残留留给终态 GC            |
| 注册项已丢的孤儿目录                   | `is not a working tree`，无任何路径能清        | 第 3 档删掉 + prune                            |
| resolve-iso 删不掉                     | 容器非空、无人处置                             | 同阶梯回收；仍失败则换代                       |
| stale `refs/heads/*.lock`              | 同分支名建树永久 `cannot lock ref`             | 阶梯末尾按 mtime 清（仅带 branchRef 的调用方） |
| wrapper iso resume                     | 每次 resume 都撞同一堵墙                       | 回收→（清不掉则）换代→resume 成功              |
| 代际耗尽                               | ——                                             | `iso-recreate-failed` + 结构化诊断             |
| 树杀不死（unkillable）                 | 保留 iso，不重试                               | 不变；额外保留 job 句柄供带外杀树使用          |
| ARM64 无 FFI                           | 静默降级                                       | 行为不变，降级进启动 warn 与失败诊断           |

## 9. 与既有模块的耦合点 / 不新增的边

- `nodeIsolation.ts → util/git.ts`、`managedProcess.ts → util/process.ts`、`task.ts → util/git.ts`、
  `nodeWorkspaceMaintenanceFilesystem.ts → util/git.ts`：**全部是既有边**，新符号走同一条。
- `util/git.ts → util/fsReclaim.ts`：util 层内部新边，无 context 跨越。
- **不新增**任何 `modules/*` → `modules/*` 内部 import、不新增 facade、不新增 `AppDeps` 消费方。
- `architecture/*.json`：**三个 PR 各自**都要跑 `bun run architecture:write`（PR-2 也新增导出与消费边，
  r1 漏了它的账本任务——P1-9）。

## 10. 偏离项（逐条呈用户确认）

1. **回收 / 选键发生在 durable effect fence 之前。**
   r1 给的理由（「每代各起 effect 会撞唯一索引」）**不成立**——`localEffectObserver.ts:129-133` 每次
   `beforeAct()` 都 `nextOperationGeneration(...)` 自增，唯一索引是 `(taskId, operationKey, operationGeneration)`
   （`db/schema.ts:2312-2314`），今天的重试循环本来就在为同一 `(nodeRunId, ordinal)` 反复起
   `isolation-create` effect 且不冲突（P1-10）。**真实理由**：回收不进 durable 账本——它是幂等的路径清理，
   崩在中途没有 receipt 也无妨，下一次尝试会重新派生；且整段在 `writeSem` 内，同一 iso 键不存在并发创建者。
2. **`childUnreaped` 分支不释放 job 句柄**（§3.3），代价是每个 unkillable 运行留一个句柄到 daemon 结束，
   换取后续带外杀树仍能拿到原子 job terminate。
3. **`terminate()` 不再关句柄**（§3.2）——这是对 RFC-254 归属契约的实质修改，`dispose()` 成为唯一关句柄点。
   用户 2026-09-04 裁决 D4「完整修」。
4. **`removeWorktree` 保留原抛错语义**（§2.2），不把全仓消费方一起改成软失败。
5. **不引入 `CREATE_SUSPENDED`**（§3.4），沿用 RFC-254 已记录的 spawn→assign 窗口处置。
6. **`reclaimStalePrepArtifacts` 只复用第 1 层原语**（§2.3 修正 ④），AC-15 相应收窄。

## 11. 测试策略

| 用例                                                              | 断言面                                                              | 平台                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------- |
| `removeDirectoryWithRetry` 退避档形状                             | 导出常量 + 注入假 `rm` 的计数 / 时序                                | 全平台              |
| `reclaimWorktreePath` 四种 outcome                                | 真 git 仓 + 真目录                                                  | 全平台              |
| **AC-5 注册项已丢的孤儿目录**（先红）                             | 真 git：remove 成功后重建目录 ⇒ 回收 ⇒ 再 add 成功                  | 全平台              |
| `worktree add` 空目录成功 / 非空失败                              | 真 git（把实测钉成回归）                                            | 全平台              |
| 退避删除**不持** registry 锁                                      | 注入计时：阻塞回收期间同仓另一个 `worktree add` 不被阻塞            | 全平台              |
| 多仓：容器不走阶梯、逐仓先行                                      | 三仓夹具断言 N 棵树各自被 git 移除、容器最后                        | 全平台              |
| stale ref lock 按 mtime 清、年轻锁不动                            | 真 git 仓造 `.lock` + mtime 操纵                                    | 全平台              |
| **AC-6 换代**（先红：今天必然 `already exists`）                  | 屏障放在**基键树内部**（子目录 chmod 0500），不是父目录（P2-6）     | POSIX 真做          |
| `isoKeyOf` 回读相等 + `check-ref-format` 对 `-2` 合法             | 纯函数 + 真 git                                                     | 全平台              |
| **P0-1 守卫**：observer 用 `dbNodeRunId`、路径/ref 用 `nodeRunId` | 源码层断言 + 一条「换代后 discard 不抛」的真跑用例                  | 全平台              |
| **AC-8 wrapper resume wedge**（r1 缺，P1-11）                     | 造残留 wrapper iso ⇒ resume ⇒ 断言换代且 merge-back handle 指向新树 | 全平台              |
| 三处 `isoKeyOf` 补齐 + S1 兜底要求活工作树                        | 持久化 basename ≠ 行 id 时定位正确                                  | 全平台              |
| `handleTaskIdOf` 分隔符（AC-14，先红）                            | 纯函数喂 `\` 与 `/` 两种形状                                        | 全平台              |
| `adoptSpawnedProcessTree` 已接线                                  | 源码层断言（防再次退化成死代码）+ POSIX 返回 false                  | 全平台              |
| `killProcessTreeWin32` 尊重 `terminate()` 返回值                  | 注入假 ownership 返回 false ⇒ 不 `return true`                      | 全平台              |
| **terminate 后 `liveCount()` 仍查内核**（§3.2 的判据）            | 真 Job Object：terminate → liveCount 归零前非 0                     | **仅 Windows CI**   |
| Job Object 真杀树 / `isProcessTreeAlive` 非 null                  | 真 Windows 内核                                                     | **仅 Windows CI**   |
| `awaitProcessTreeQuiesced` 三态 + 门（killTree 过才等）           | POSIX 真进程组；正常退出**不等**的时序断言                          | 全平台 + Windows 腿 |
| `killStaleRunProcessTree` 补的 quiesce 跳                         | 注入 ownership + 时序                                               | 全平台              |

**证明力的诚实声明（P1-11）**：`blocked` 这一档在 CI 上难以自然触发（需要真有进程持句柄）。
AC-3 / AC-4 / AC-6 / AC-9 在 Windows 腿上**以注入方式证明**，POSIX 上用 chmod 屏障真做；
「真机自然复现」不作为交付判据，这句话写进 AC 正文而不是风险附注。

**先红后绿**：AC-5、AC-6、AC-14 三条今天都能写成红。

**Windows CI paths（P1-8）**：`windows-platform.yml` 两份清单今天缺
`services/nodeIsolation.ts`、`services/isolatedAgentRun.ts`、`services/schedulerAssembly.ts`、
新增的 `util/fsReclaim.ts`。**每个 PR 各自把自己触及的路径加进两份清单**（不是攒到 PR-3），
否则 PR-1 / PR-2 落地时 Windows 腿根本不触发。不加 `modules/task-execution/**`（125 文件、改动频繁，
会让 Windows 腿在无关提交上频繁触发）——代价是那两个 composition 文件的后续改动不重跑 Windows 腿，
记为债（§12）。守卫形态已核：`tests/root-test-entrypoint.test.ts:618-638` 对所有 workflow 检查
push ⊇ pull_request（单向），所以两份必须逐字同步。

## 12. 债

- 三个文件的物理归位（W9 / W5 / W4-E1），本 RFC 不做。
- `childUnreaped` 分支每个运行留一个 Win32 句柄到 daemon 结束（§10②）。
- `isProcessTreeAlive` 仍无生产消费方；`killStaleRunProcessTree` 用单 pid 的 `isProcessAlive` 判「杀掉了」，
  孙进程还活着时会误报——正是 #13 这一类的成因。本 RFC 只在它内部补一跳 quiesce（§4.2），
  **不改它的判定源**，接线属另一场手术。
- `modules/task-execution/composition/**` 不进 Windows CI paths（§11）。
- `reclaimStalePrepArtifacts` 仍走不了阶梯第 2 档（§2.3 修正 ④），slug→镜像解析提前是它自己的重构。
- GC `removeIsoContainer` 一次 `rm` 整个 `{appHome}/iso/{taskId}`，一个被占的残留会让整次删除抛错、
  连健康的兄弟目录一起留下（P2-2）。T5 的退避缓解不了「持有者还活着」的情形；改成逐子目录删除
  是正解，但属 GC 自身的形状调整，记债。

## 13. r1 → r2 改动索引（设计门折入记录）

| 编号  | 门       | 内容                                             | r2 落点            |
| ----- | -------- | ------------------------------------------------ | ------------------ |
| P0-1  | 攻击门   | discard 侧 observer 用合成键会抛穿 `runAssembly` | §5.4②              |
| P0-2  | 攻击门   | L3 在 Windows+job 上空转（terminate 销毁观测面） | §3.2、§4.1         |
| P0-3  | 攻击门   | L3 触发门漏了 drain 超时与带外杀树两条真句柄源   | §4.2               |
| P1-1  | 事实门   | wrapper 侧取 `isoWorktreePath` 的路径写错        | §5.1               |
| P1-2  | 事实门   | 「保留句柄供权威判活」的消费方不存在             | §3.3               |
| P1-3  | 事实门   | 退避预算的引用读反了                             | §2.1               |
| P1-1' | 攻击门   | prune 进热路径 + registry 锁被握满               | §2.2 修正 ①②、§5.3 |
| P1-6  | 攻击门   | 多仓容器回收会 `rm -rf` 绕过 git                 | §2.2 修正 ③        |
| P1-7  | 攻击门   | AC-15 靠 T4 达不成                               | §2.3 修正 ④        |
| P1-10 | 攻击门   | 偏离项 1 的承重理由不成立                        | §10①               |
| P1-11 | 攻击门   | AC-8 无测试、证明力未申明                        | §11                |
| P2-2  | 事实门   | 漏了 resolve-iso 三处同形态调用                  | §2.3               |
| P2-3  | 双门     | 行号锚点偏差                                     | 全文               |
| —     | 并发线索 | stale ref lock 无人清                            | §2.4               |

**未采纳**：事实门 P2-4 称「仓内没有 `FAILURE_CODES` 常量」——不成立，它在
`packages/shared/src/schemas/task.ts:420`（由四个子 union 拼成）。proposal §7② 的原文照旧。
攻击门「完全失败驱动换代」的建议未采纳，理由见 §5.3 引文块。
