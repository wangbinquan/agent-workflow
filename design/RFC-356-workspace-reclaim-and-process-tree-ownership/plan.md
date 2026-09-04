# RFC-356 任务分解

> **修订 r2（2026-09-04，设计门后）**：任务表按 design.md r2 重排——新增 RFC-254 契约修正（T8）、
> handle 双身份拆分（T14，P0-1）、`killStaleRunProcessTree` 补 quiesce（T10），Windows CI paths 与
> 架构账本改为**每个 PR 各自负责**。r1 的 T1–T16 编号已作废，勿按旧号认领。

## 0. PR 拆分建议

单 RFC 默认单 PR，本 RFC 拆 **3 个 PR**（CLAUDE.md §RFC workflow 第 5 条要求说明理由）：

三层风险档次不同——L1 是纯新增 + 单点替换（低），L2/L3 改所有 Windows 运行的进程生命周期**并修改
RFC-254 的归属契约**（中高，且只有真 Windows CI 腿能证），L4 改 iso 键这条被五个装配点共用的身份轴（中高）。
混成一个 PR 会让 Windows 腿一红就无法归因是「契约改动」「杀树接线」还是「键换代」。三个 PR 依次上 main、各自盯 CI。

| PR   | 任务    | 交付判据                                                                                     |
| ---- | ------- | -------------------------------------------------------------------------------------------- |
| PR-1 | T1–T6   | 回收原语 + iso/resolve-iso/任务工作树/GC 四处接入 + stale ref lock；AC-1～AC-5、AC-15、AC-18 |
| PR-2 | T7–T13  | RFC-254 契约修正 + Job Object 接线 + 树静默（含带外杀树）；AC-10～AC-13                      |
| PR-3 | T14–T19 | handle 双身份 + iso 键代际自愈 + 诊断 + 分隔符修复；AC-6～AC-9、AC-14                        |

## 1. 任务

### PR-1 —— 回收原语（L1）

**RFC-356-T1｜`removeDirectoryWithRetry` 原语**
新建 `packages/backend/src/util/fsReclaim.ts`：退避删除 + `DEFAULT_RECLAIM_DELAYS_MS`
（`[0,50,100,200,400,800,1600]`）。注释必须写清 design §2.1 的三条：Bun 不实现 `rm` 的 `maxRetries`（有实测）、
**退避档没有实测依据、只是廉价第一道**（真正的自愈是 L2+L4）、首次零延迟。
依赖：无。测试：退避档形状（注入假 `rm` 计数/时序）、成功即返回、预算耗尽 `removed:false`。

**RFC-356-T2｜`reclaimWorktreePath` 阶梯**
`util/git.ts` 新增，四档 + 可选 `branchRef`。**锁粒度是本任务的核心判据**：`remove` / `prune` 持
`withWorktreeRegistryLock`，`removeDirectoryWithRetry` **在锁外**；`absent` 档零进程零锁（不 prune）。
`removeWorktree` 原签名/原语义不动。
依赖：T1。测试：四档 outcome 各一（真 git 仓）；**AC-5 孤儿目录**（用例先断言改动前那条死路
——`git worktree remove` 报 `is not a working tree`——再断言回收后同一路径能重新建树）；
「`worktree add` 收空目录、拒非空目录、`--force` 不豁免」钉成回归；**锁外退避的证明**
（阻塞回收期间同仓另一个 `worktree add` 不被阻塞）。

**RFC-356-T3｜iso 侧四处接入 + 多仓规则**
`nodeIsolation.ts:1319`（discard）与 **resolve-iso 三处**（`:1489` / `:1555` / `:1709`）全部换用
`reclaimWorktreePath`——resolve-iso 落在容器内部，删不掉会挡住同代重建，必须一起改。
多仓按 design §2.2 修正 ③：**逐仓走阶梯（各自 `repoPath`），容器最后且只走 `removeDirectoryWithRetry`**。
warn 文案去掉「leaving for GC」。
依赖：T2。测试：`blocked` 不抛；三仓夹具断言逐仓 git 移除、容器最后；文案断言。

**RFC-356-T4｜任务工作树侧 + stale ref lock（AC-15 / AC-18）**
`services/task.ts:5265` `reclaimStalePrepArtifacts`：目录删除改走 **T1 原语**（它拿不到 slug 对应的镜像仓，
用不上阶梯第 2 档——AC-15 已相应收窄为「目录删除只有一份实现」）；新增 stale ref lock 清理
（`{commonGitDir}/refs/heads/{branch}.lock`，**存在且 mtime 早于 `STALE_REF_LOCK_MIN_AGE_MS`=60s 才删**）。
线索与取证见 design §2.4 / `docs/audit-backlog.md:3961`。
依赖：T1、T2。测试：既有 RFC-287 T13 用例保持绿；退避用例；**stale ref lock 按 mtime 清、年轻锁不动**。

**RFC-356-T5｜GC 侧退避 + 补锁**
`nodeWorkspaceMaintenanceFilesystem.ts` 的 `removeIsoContainer` / `removeAgedPath` / scratch 分支
`rm` → `removeDirectoryWithRetry`；顺带把 `:70-74` 那处**不持锁**的 `prune` 收进 registry 锁。
依赖：T1。测试：既有 GC 用例保持绿 + 退避用例 + 持锁断言。

**RFC-356-T6｜PR-1 收口**
`.github/workflows/windows-platform.yml` 的 **push 与 pull_request 两份**清单加
`packages/backend/src/util/fsReclaim.ts` 与 `packages/backend/src/services/nodeIsolation.ts`（逐字同步）；
`bun run architecture:write` 重放。
⚠️ 工作树上有并发 session 的 `architecture/*.json` 与 `docs/*.md` 改动，**逐文件 `git diff` 认领后按路径 add**，
禁止 `git add -A`；`git commit` 必须带 pathspec（CLAUDE.md §Multi-person collaboration）。
依赖：T1–T5。

### PR-2 —— 进程树归属（L2 / L3）

**RFC-356-T7｜RFC-254 归属契约修正**（design §3.2，用户裁决 D4）
`util/windowsJobObject.ts`：`terminate()` 不再 `CloseHandle`、不置 `closed`，只返回 `TerminateJobObject`
真值；`liveCount()` 去掉 `if (closed) return 0` 短路，terminate 后照样查内核；`dispose()` 保持「停止跟踪
**并**停止整棵树」并成为唯一关句柄点。
**没有这一条，L3 在 Windows 上恒等空转**（P0-2）。
依赖：无。测试：真 Job Object 上 terminate → `liveCount()` 仍返回内核值（**仅 Windows CI**）；
POSIX 侧断言接口形状不变。

**RFC-356-T8｜`killProcessTreeWin32` 修正**
保留 `ownedTrees` 项（不在 terminate 后 delete，改由运行收尾释放）；**尊重 `terminate()` 的返回值**
——今天丢弃返回值无条件 `return true`，接线后会让 `managedProcess.killTree`（`:270-277`）跳过
`child.kill()` 兜底（P1-4）。
依赖：T7。测试：注入假 ownership 返回 false ⇒ 不 `return true`（全平台可断）。

**RFC-356-T9｜spawn 接线 + 释放**
`managedProcess.ts:524`（pid 之后、**`await req.onSpawned` 之前**，P2-7）`adoptSpawnedProcessTree(pid)`；
`:917` 前 `releaseProcessTreeOwnership(pid)`；`childUnreaped` 分支**不释放**（design §3.3）。
依赖：T7、T8。测试：源码层断言「接线存在且在 onSpawned 之前」（防再次退化成死代码）；POSIX 逐字不变。

**RFC-356-T10｜`awaitProcessTreeQuiesced` + 触发门 + 带外杀树**
`util/process.ts` 新增三态原语 + `TREE_QUIESCE_BUDGET_MS = 2_000`；win32 无 job ⇒ 立即 `unknown`。
门按 design §4.2 定为「**本次运行调用过 `killTree`**」（在 `managedProcess.killTree` 里置标志，覆盖
escalate 路径**与 drain 超时路径**）；另在 `killStaleRunProcessTree`（`util/process.ts:312`/`:319` 之后、
返回 `'killed'` 之前）补一跳 quiesce，覆盖 `task.ts:4052`（杀完即回滚进树）、`taskIdleTimeout`、
`providerBackground`、`orphans` 四个带外消费方。等不到只 warn，**不改 `outcome` / `processUnreaped`**。
依赖：T7、T9。测试：POSIX 真进程组三态；**正常退出不等**的时序断言；drain 超时路径**要等**的断言；
`killStaleRunProcessTree` 那一跳的注入时序。

**RFC-356-T11｜ARM64 降级告警**
daemon 启动按 `processTreeOwnershipDiagnosis()` warn 一次（`reason==='ffi-unavailable'`）。
依赖：无。测试：诊断三态映射的纯函数断言。

**RFC-356-T12｜PR-2 的 Windows CI paths**
两份清单加 `packages/backend/src/services/execution/managedProcess.ts`（已在）确认 + 新增测试文件名。
依赖：T7–T11。

**RFC-356-T13｜PR-2 架构账本**（r1 漏项，P1-9）
`util/process.ts` 是 commons-manifest 登记的 owner=platform 内核，T10 新增两个导出与生产消费边 ⇒
必须 `bun run architecture:write` 重放，否则守卫打红。
依赖：T7–T12。

### PR-3 —— iso 键代际自愈（L4）+ 诊断

**RFC-356-T14｜`IsoHandle` 双身份拆分**（P0-1，**必须最先做**）
`IsoHandle` 加 `dbNodeRunId`（真实行 id），与既有 `nodeRunId`（物理 iso 键）并列；
`createNodeIso` / `rebuildIsoHandle` 要求两者都传；**凡起 effect observer 一律用 `dbNodeRunId`
（`nodeIsolation.ts:1296`）、凡拼路径/ref/`resourceKeys` 一律用 `nodeRunId`**。
不做这条，L4 一换代，下一次 `discardNodeIso` 的 `beforeAct()`（在 `try` 外，`:1314`）就抛
`task-continuation-stale`，经 `schedulerAssembly.ts:234` 的裸 await 穿出 `runAssembly` ⇒ 节点
`scheduler-node-threw` —— **比 issue #13 更早触发的新 wedge**。
依赖：无。测试：源码层守卫钉死两个身份的分工 + 一条「换代后 discard 不抛」的真跑用例。

**RFC-356-T15｜三处裸派生补齐 + S1 兜底收紧**

- `wrapperMechanics.ts:1662`：改用 `cur = nodeExecution.read(wrapperRunId)`（`:1601`）的 `isoWorktreePath`。
  **顺序约束必须写进注释**：`merged` 再入的 CAS（`:1622-1634`）会把该列写成 `null`，只有 CAS 之前读到的
  `cur` 还留着上一代物理键。该 handle 要拿去 **merge-back**，指错路径是硬故障。
- `wrapperMechanics.ts:1694`：同源，但只做 discard，缺失可容忍。
- `taskLifecycleRepair/options-S1.ts:79`：select 扩到 `{id, isoWorktreePath}`；**兜底判据从
  `existsSync` 收紧为「必须是活的工作树」**（`isGitWorkTree`），否则 legacy/passthrough 行会退回裸派生路径
  ——恰是 L4 已放弃的那个阻塞目录（P2-4）。
  依赖：T14。测试：三条路径在「持久化 basename ≠ 行 id」时定位到实际存在的树；`:1662` 的 merge-back 断言单列。

**RFC-356-T16｜`chooseIsoWorkspaceKey` + `IsoWorkspaceBlockedError`**
`isolatedAgentRun.ts`：锁内逐代选键——**gen 的第一步是 `existsSync(容器路径)` 短路（零进程零锁）**，
只有真有残留才跑回收阶梯；`blocked` 进下一代，`MAX_ISO_KEY_GENERATIONS = 3`（design §5.2 已写明
「脚本线预期会够到这个上限」，不要写成够不到的保险丝）。effect observer 用真实行 id（§5.4①）。
依赖：T2、T14、T15。测试：AC-6 的屏障放在**基键树内部**（子目录 chmod 0500），
放父目录会把新旧两代一起挡住、证不出换代（P2-6）；`isoKeyOf` 回读相等；`check-ref-format` 对 `-2` 合法。

> **措辞更正（实现期）**：r2 把 AC-5 / AC-6 都写成「先红」，**不准确**。
> `reclaimWorktreePath` 与 `chooseIsoWorkspaceKey` 都是**新函数**，它们的用例在改动前根本
> 无法运行，谈不上「红」。全 RFC 里能写成**真红**的只有 **AC-14**（`handleTaskIdOf` 是既有
> 函数、既有缺陷，那条断言在改动前确实失败）。
> AC-5 / AC-6 的「改动前必然失败」是靠**把改动前的死路本身钉成断言**来承载的：用例里先断言
> `git worktree remove` 报 `is not a working tree`、`worktree add` 撞 `already exists` 且
> `--force` 不豁免，再断言新路径把它化解。这比「先红」弱，但它是新函数所能给出的最强形式，
> 不该用更响的词去描述。

**RFC-356-T17｜诊断渲染 + 注释修正**
`onIsoSetupFailure` / `onIsoRecreateFailure` 渲染结构化诊断（残留路径 + 最后错误 + Job Object 可用性）；
分类字符串 `iso-setup-failed` / `iso-recreate-failed` **不变**。
一并改 `schedulerAssembly.ts:231-233` 那条注释——「顺序不可颠倒，否则两棵树同时在盘上」在 L4 之后
变成假话，必须写清为什么合并仍正确（merge-back 走 `handle.repos[].isoWorktreePath`，即新树），
否则下一个读者会把 L4「修」回去（P2-5）。
依赖：T16。测试：消息含三段；分类字符串未变。

**RFC-356-T18｜`handleTaskIdOf` 分隔符修复（AC-14）**
`nodeIsolation.ts:788-793` 改用 `/[\\/]/` 拆分（不是 `path.sep`——`appHome` 与 git 回读路径在 Windows 上
都可能带 `/`）。
依赖：无。测试：纯函数喂 `\` 与 `/` 两种形状（先红）。

**RFC-356-T19｜PR-3 收口**
两份 Windows CI paths 加 `services/isolatedAgentRun.ts`、`services/schedulerAssembly.ts` 与新测试文件；
`architecture:write` 重放；`design/plan.md` RFC 索引状态改 Done；`STATE.md` 收口行；按 exact SHA 取 CI 证据。
依赖：T14–T18。

## 2. 依赖图

```
PR-1   T1 ─┬─ T2 ─┬─ T3 ─┐
           │      ├─ T4 ─┤
           └─ T5 ─┘      └─ T6

PR-2   T7 ─┬─ T8 ─ T9 ─ T10 ─┐
           │                 ├─ T12 ─ T13
           └── T11 ──────────┘

PR-3   T14 ─┬─ T15 ─ T16 ─ T17 ─┐
            │                   ├─ T19
       T18 ─┴───────────────────┘
                  ▲
            (T2 来自 PR-1)
```

## 3. 验收清单

- [x] AC-1 回收：路径不存在 ⇒ `absent`，**零进程零锁**（不 prune）—— `rfc356-workspace-reclaim`「路径不存在 ⇒ absent」
- [x] AC-2 回收：正常工作树一次 `remove` 成功（`attempts:1`）；创建侧常态只多一次 `existsSync` —— `rfc356-iso-key-generations`「容器不存在 ⇒ 第 0 代直接选中，reclaimed=0」
- [x] AC-3 回收：`remove` 失败 ⇒ 锁外退避删除 ⇒ prune ⇒ `removed via filesystem`（含「退避不持 registry 锁」的时序断言）
- [x] AC-4 回收：预算耗尽 ⇒ `blocked`（带残留路径 + 最后错误），不抛 —— POSIX 上以 chmod 屏障真做
- [x] AC-5 回收：注册项已丢的孤儿目录能被清掉 —— 用例先断言 git 自己报 `is not a working tree`，再断言回收后能重新建树
- [x] AC-6 旧 iso `blocked` ⇒ 自动换代到 `-2` 并成功建树 —— 屏障放在**基键树内部**（放父目录会把两代一起挡住、证不出换代）
- [x] AC-7 换代路径能被 `isoKeyOf` 回读；三处裸派生已补齐（wrapper ×2 + options-S1）
- [x] AC-8 wrapper resume 走 CAS **之前**读到的 `cur.isoWorktreePath` 定位物理键；`:1662`（merge-back，硬故障档）与 `:1694`（discard，可容忍）分开注明。⚠️ **未做端到端的 wedge 复现**（需要造一棵真的清不掉的 wrapper iso + 完整 resume），当前证据是定位逻辑 + 顺序约束注释，记在 §5
- [x] AC-9 代际耗尽 ⇒ `IsoWorkspaceBlockedError` 带 baseKey / 代数 / 残留路径 / 最后错误；`describeIsoFailure` 再拼上进程树归属可用性，分类字符串不变
- [x] AC-10 契约已改（terminate 不关句柄、liveCount 不再短路、map 项保留），源码守卫钉死；**真内核验证靠 windows-platform 腿**
- [x] AC-11 降级保持 taskkill，无新增平台专属路径；首次 adopt 打一条 warn，诊断进失败消息
- [x] AC-12 门 = 调用过 `killTree`（三处杀树全过包装，源码守卫钉死）；`killStaleRunProcessTree` 补跳；等不到只 warn
- [x] AC-13 POSIX 行为逐字不变 —— adopt 返 false、杀树仍走进程组；既有 rfc098 / rfc254 / s15 套件全绿
- [x] AC-14 `handleTaskIdOf` 改 `/[\\/]/`，两种形状都认
- [x] AC-15 目录删除收敛到 `removeDirectoryWithRetry` 一份：iso 侧、resolve-iso ×3、任务工作树、GC 四处、partial clone 全部走它
- [x] AC-16 三个 PR 各自同步了两份 paths 清单（fsReclaim / nodeIsolation / isolatedAgentRun / schedulerAssembly / rfc356-\*.test.ts）；`root-test-entrypoint` 的 push ⊇ pull_request 守卫保持绿
- [ ] AC-17 最终 sha 的主 CI run 级 `conclusion == success`（exact SHA 取证）
- [x] AC-18 stale ref lock 按 mtime 回收（60s），年轻锁不动，逃逸段被拒，前缀形式一次收掉 `-2`/`-3`
- [x] AC-19 双身份 handle 落地：observer 吃 `dbNodeRunId`、路径/ref 吃 `nodeRunId`（源码守卫）；合成键缺 DB 身份时 `createNodeIso` 响亮拒绝

**证明力声明**：AC-3 / AC-4 / AC-6 / AC-9 的 `blocked` 档在 Windows CI 上**以注入方式证明**，
POSIX 上用 chmod 屏障真做；「真机自然复现」不作为交付判据。

## 4. 门

- **设计门**：已于 2026-09-04 跑完两路（事实核对 + 对抗攻击），3 条 P0 + 14 条 P1 全部折入，
  改动索引见 design.md §13。只审功能，未做任何安全类检视（CLAUDE.md §工作准则硬规则）。
- **实现门**：三个 PR 全部落地、declare done 之前跑一次，同样只审功能。
- **审查范围限定**：共享工作树上并发 diff 会混进 review，明确告知只看本 RFC 触及的文件清单。

## 5. 风险与已知未决

1. **Windows 真机验证**：`blocked` 档难以自然触发，按 §3 的证明力声明以注入方式交付。
2. **`architecture/*.json` 并发**：工作树上已有 RFC-355 的账本改动，`architecture:write` 会一起重放。
   提交前逐文件 `git diff --cached --stat` 认领，只 add 自己那部分路径，`git commit` 带 pathspec。
3. **T7 改的是 RFC-254 的归属契约**（偏离项 3，用户已裁决 D4）。它同时影响 `dispose()` 的唯一性——
   实现时要确认没有第二处依赖「terminate 会顺带关句柄」的调用方。
4. **T10 给 `killStaleRunProcessTree` 补 quiesce 会拉长带外杀树的时延**（最多 +2s/次）。
   `taskIdleTimeout` 与 `orphans` 是后台节奏，可接受；`task.ts:4052` 在 resume 请求路径上，
   需确认 +2s 不越过调用方的 deadline。
