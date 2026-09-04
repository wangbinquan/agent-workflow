# RFC-356：残留工作树回收 + Windows 进程树归属接线

- 状态：Draft（2026-09-04 落档 r1；同日设计门两路评审后修订为 **r2**，待用户批准）
- 起因：GitHub issue #13「文件锁导致杀进程失败，重试建不起来导致循环调度停摆」（Windows，v0.18.14）
- 领域：`task-execution`（ExecutionKernel 的 iso 生命周期）+ `source-control`（工作树操作语义）+ `platform`（进程机制）

## 1. 背景：一条必然复现的死链

用户报的现场只有三行：

> 1. 超时杀进程
> 2. iso worktree 删除失败：`failed to delete ... Invalid argument`（Windows 文件锁），留待 GC
> 3. 节点重试尝试重建 iso worktree → `already exists` 失败

按源码逐点对账，这三行是**同一条必然链**，不是偶发：

| 步  | 现场                | 代码                                                                                                                                                                                                                                                              |
| --- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ①   | 节点超时 → 杀进程树 | `services/execution/managedProcess.ts:803` 超时置 `outcome='timeout'` → `escalate()`（`:748`）→ SIGTERM → grace → SIGKILL                                                                                                                                         |
| ②   | 重试判定「换树」    | 超时的 `exitCode ≠ 0`，`decideEnvelopeFollowup`（`nodeMechanics.ts:896`）第二条判据即返回 `followup:false` ⇒ `keepIf` 为假                                                                                                                                        |
| ③   | 先丢弃、再重建      | `schedulerAssembly.ts:229-243`：`await spec.discardIso(handle)` 然后 `handle = await spec.iso.create()`                                                                                                                                                           |
| ④   | 丢弃失败被吞        | `discardNodeIso`（`nodeIsolation.ts:1316-1332`）catch 后只 `log.warn('iso worktree remove failed (leaving for GC)')`；`removeWorktree`（`util/git.ts:2467-2481`）是**一发** `git worktree remove --force`，无重试、无 `prune`、无文件系统兜底                     |
| ⑤   | 重建撞同名目录      | iso 路径 = `{appHome}/iso/{taskId}/{isoKey}`（`nodeIsolation.ts:172`），而 `isoKey` 是**整个重试循环里不变的原始行 id**（RFC-130 D17，`isolatedAgentRun.ts:70-76`）；`createIsolatedWorktree`（`util/git.ts:2657-2668`）是裸 `git worktree add`，对残留目录零处理 |
| ⑥   | 节点永久失败        | `onIsoRecreateFailure` → `iso-recreate-failed`（`nodeMechanics.ts:4727`；脚本线 `:2779`）                                                                                                                                                                         |

本机实测（git 2.50.1）确认第 ⑤ ⑥ 步的判据：

```
git worktree add --detach <非空残留目录>            → fatal: '<path>' already exists   (exit 128)
git worktree add --force --detach <非空残留目录>    → 同样失败（--force 不豁免这条检查）
git worktree add --detach <空目录>                  → 成功
git worktree remove --force <丢了注册项的残留目录>  → fatal: '<path>' is not a working tree
```

最后一行是最要命的：`git worktree remove` 删目录失败时，注册项可能已被删掉，此后**平台唯一的清理手段
`discardNodeIso` 再也清不掉那个目录**——它只会换一种错法失败。

## 2. 「留待 GC」是一句空头支票

warn 文案承诺的兜底在**恰恰需要它的场景里不存在**：iso GC 明确跳过活跃与非终态任务
（`platform/persistence/sqlite/systemWorkspaceGc.ts:976`，模块层同形
`modules/source-control/application/workspaceMaintenance.ts:304-313`）。任务还活着的时候没有任何代码会
去碰那个残留目录，于是它一直挡着同一条路径，直到任务终态。

而 GC 侧其实早有正确姿势——`rm -rf` + `git worktree prune`
（`modules/source-control/infrastructure/nodeWorkspaceMaintenanceFilesystem.ts:65-77`），只是活路径没用上。
任务工作树也早有同形先例：`services/task.ts:5265` 的 `reclaimStalePrepArtifacts`（RFC-287 四轮门）就是
「重跑准备之前，把上一次准备留下的残骸定向清掉」。**iso 这条路上缺的就是同一件事。**

wrapper 上更狠：wrapper iso 按 `wrapperRunId` 派生、跨 resume 稳定。
`wrapperMechanics.ts:1683-1704` 的注释已经写明「没有清理的话任务会在每次 resume 上 wedge」，但它手里
唯一的工具还是 `discardNodeIso`——Windows 上清不掉 ⇒ **每次 resume 都撞，永久 wedge**。这就是标题里的
「循环调度停摆」。

## 3. 第二根因：Windows 的杀树一直是降级档

`adoptSpawnedProcessTree`（`util/process.ts:130`）**在生产代码里一次都没有被调用**——全仓唯一调用点是它
自己的测试 `tests/rfc254-process-tree-ownership.test.ts:90`。因此：

- `ownedTrees` 恒空 ⇒ 每次杀树都落到 `taskkill /pid <pid> /T /F`（`util/process.ts:95-112`）这个**快照枚举**
  分支，走的时候新 fork 的后代直接逃逸；
- `isProcessTreeAlive` 在 Windows 上**恒返回 `null`**（`util/process.ts:155-160`）⇒ 平台没有任何地方能等到
  「树真的死透了」再去删目录。

RFC-254 设计门 P0-D 把 Job Object 定为 v1 必需（`design/RFC-254-windows-native-execution/design.md:118-127`），
代码写完了但接线一直没做；`util/windowsJobObject.ts` 顶部那段「⚠️ NOT WIRED YET」的警告注释在 RFC-276
（commit `70deb522e`）里被删除，**接线却没有补上**。更晚的 `b55feb64a` 的 commit message 还写着
"Windows already owns tree cleanup through Job Object or taskkill"——前半句今天不成立。

逃逸的后代持有 iso 工作树里的句柄（iso 就是子进程的 cwd——agent 线 `nodeMechanics.ts:4499`、
脚本线 `:2921`），正是 §1 第 ② 步里 git 删不掉的直接原因。

## 4. 连带发现（同一区域的 Windows 专属缺陷）

`handleTaskIdOf`（`nodeIsolation.ts:788-793`）用 `isoWorktreePath.split('/')` 从路径里回读 taskId，而路径由
`join()` 生成——**Windows 上是 `\`**，于是 `lastIndexOf('iso')` 恒为 -1、函数恒返回 `'unknown'`。
后果：RFC-210 的 worktree-scoped 池锚点在 Windows 上全部落成 `wt/unknown/{slug}`，不同任务的锚点互相串台，
按 taskId 的清理也永远匹配不上。只影响带子模块的仓，但它就在本 RFC 要动的同一段代码里。

（对照：`isoKeyOf` 用的是 `node:path` 的 `basename()`，平台感知正确。）

## 5. 目标

1. **G1 自愈**：iso 工作树的丢弃→重建路径在残留目录存在时能自行恢复，不再把节点/任务永久钉死。
2. **G2 真杀树**：Windows 上把已经写好的 Job Object 归属接到 spawn 上，让杀树从「快照枚举、后代可逃逸」
   升级为内核级原子终止，并让平台**第一次拥有**权威的「树是否还活着」答案。
3. **G3 说人话的失败**：真的清不掉时，失败消息要能自证——残留在哪、最后一次错误是什么、本机有没有
   Job Object，而不是一句 `iso-recreate-failed`。
4. **G4 一份实现**：iso 与任务工作树共用同一个「残留工作树回收」原语，不留两份。

## 6. 非目标

- **不搬文件**。`util/git.ts` / `util/process.ts` / `services/nodeIsolation.ts` 的物理归位分别属于
  RFC-294 的 W5 / W4-E1 / W9（见 `architecture/module-symbol-owners.json`），各自单独立项，本 RFC 只在
  既有边上加行为。
- **不改重试预算 / 不改 `shouldRetryNodeFailure` 语义 / 不改 D17「同会话续跑留用同一棵树」**。
- **不给干净退出的运行加等待**。本 RFC 的树静默等待只在「我们确实杀过树」的分支上生效（§7 行为变更 ③）。
- **不做安全加固**（CLAUDE.md §工作准则硬规则）。本 RFC 全部条目都是功能正确性。
- **不动产品自身的 worktree 能力语义**（任务隔离工作树、git wrapper 快照）。

## 7. 行为影响清单（breaking / 行为变更，需逐项确认）

本 RFC 不关闭任何既有能力，但有**六条**用户可观察的行为变更，按 §RFC workflow 第 7 条逐条列出。
（r2 修订：① 补上优雅停机的超预算分支，⑤⑥ 是设计门查出后新增的，用户 2026-09-04 已确认接受。）

① **Windows 上 daemon 退出时，在跑的 runtime 子进程会随之被内核杀掉。**
　 Job Object 带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，daemon 进程退出 ⇒ 句柄关闭 ⇒ 整树终止。覆盖两种情形：
　 **(a) 崩溃 / 被强杀**——今天子进程留成孤儿、等下次启动的收割器，之后是当场随 daemon 死；
　 **(b) 优雅停机的超预算幸存者**——`services/shutdown.ts:37` 只 abort 并等预算，`:45-53` 对超预算者
　 仅把任务 CAS 成 `interrupted`，子进程照样活到下次启动被收割；挂上 kill-on-close 后它们也当场死。
　 （预算内正常收场的路径不受影响：那条本来就 SIGTERM→SIGKILL 了子进程。）
　 这与平台既有意图一致（孤儿本就是要收割的），也顺带减少残留句柄，但它是**新的杀伤**，须明示。

② **`iso-recreate-failed` 的失败文案会变**（附残留路径、最后错误、本机 Job Object 可用性）。
　 失败**分类**保持 `iso-recreate-failed` 不变——`iso-setup-failed` / `iso-recreate-failed` 是后端内部字符串，
　 不在 `FAILURE_CODES`（`packages/shared/src/schemas/task.ts:420`）里、前端也没有分支消费（已核），
　 所以只是文案更详细，没有消费方失配风险。

③ **被杀掉的运行，其结束会晚最多 2s**（树静默预算）。触发门是「本次运行调用过 `killTree`」，
　 覆盖超时 / 取消 / 升级，**以及 drain 超时那条绕过 escalate 的直接杀树**；正常退出的运行时序逐字不变。
　 另外带外杀树（`killStaleRunProcessTree` 的四个消费方：resume 前回滚、idle 收割、后台补偿、孤儿收割）
　 每次也会多等最多 2s。

④ **磁盘上可能多出一个清不掉的残留目录**（自愈换新路径的代价）。它在任务终态时由既有 iso GC 一并删除，
　 不新增泄漏面；换来的是任务不再 wedge。
　 （已知边角：GC 的 `removeIsoContainer` 一次 `rm` 整个 `{appHome}/iso/{taskId}`，若那时残留仍被占用，
　 该次删除会失败并连健康的兄弟目录一起留下——逐子目录删除是 GC 自身的形状调整，记债不修。）

⑤ **正常成功退出的运行，其幸存后代也会在收尾时被终止。**（设计门 P1-5，用户已确认接受）
　 `releaseProcessTreeOwnership` 的语义是 `dispose()` = 「停止跟踪**并**停止整棵树」。在
　 `keepExitedOnDrainTimeout === true` 的分支（`managedProcess.ts:893-897`）运行以 `outcome:'exited'`
　 正常返回、而孙进程还活着，收尾的 release 会把它们当场杀掉。**这对 issue #13 是好事**
　 （那正是句柄持有者），但它是一次**成功**运行上的新杀伤，独立于 ①，须单列。

⑥ **`terminate()` 不再顺带关闭 job 句柄**（RFC-254 归属契约的实质修改，用户裁决 D4）。
　 今天 `terminate()` 在 `finally` 里 `CloseHandle` 并把 `liveCount()` 短路成 0，导致杀树那一刻观测面
　 就被销毁——L3 在 Windows 上恒等空转。改后关句柄的唯一出口是 `dispose()`。这不是用户可见行为，
　 但它改的是另一个 RFC 定义的契约，按同一条规则明示。

## 8. 用户故事

- 作为在 Windows 上跑工作流的用户，某个节点超时被杀之后，**重试能正常跑起来**，而不是从此以
  `iso-recreate-failed` 卡死，整条工作流停摆。
- 作为遇到 resume 卡住的用户，任务能从残留的 wrapper iso 上恢复，而不是每次 resume 都撞同一堵墙。
- 作为排障的人，看到失败时能一眼知道**是哪个目录清不掉、谁可能锁着、本机有没有 Job Object**，
  而不是只看到一行 `iso-recreate-failed`。
- 作为 daemon 运维者，Windows 上强杀 daemon 之后**不会再留下一堆在跑的 runtime 孤儿进程**。

## 9. 验收标准

**回收原语（L1）**

- AC-1 目标路径不存在时，回收返回 `absent`，**零 git 进程、零 registry 锁**（r2：不再顺带 prune——
  选键会在每次建树时探测，那一下 prune 会让创建侧变成净回归）。
- AC-2 目标是正常注册的工作树时，回收走 `git worktree remove --force` 一次成功，返回 `removed via git`；
  **常态路径在移除侧不额外起进程、在创建侧只多一次 `existsSync`**（与今天等价）。
- AC-3 `git worktree remove` 失败时，回收退到**退避重试的目录删除**（**在 registry 锁外**，
  锁里只留 `remove` / `prune` 两个 git 子进程）；删成功后 `prune` 掉悬空注册项，返回 `removed via filesystem`。
- AC-4 目录被持续占用、退避预算耗尽时，返回 `blocked`，带最后一次错误与残留路径，**不抛异常**。
- AC-5 「丢了注册项的残留目录」（`git worktree remove` 报 `is not a working tree`）能被回收删掉——
  这是今天平台完全无法自愈的形态。

**iso 生命周期（L4）**

- AC-6 重试换树时，若旧 iso 回收为 `blocked`，则本次创建自动改用**新一代 iso 键**
  （`{原键}-2`、`-3`…）并成功建树，节点继续重试，不再以 `iso-recreate-failed` 收场。
- AC-7 换代后的 iso 路径能被 `isoKeyOf` 回读（`basename`），`resume` / `pending-merge` 重放 / 冲突恢复
  三条路径都定位到**实际存在**的那棵树。
- AC-8 wrapper iso 的 resume 路径同样自愈：残留 wrapper iso 清不掉时换代继续，而不是每次 resume 都 wedge；
  且 `wrapperMechanics.ts:1662` 重建的 handle（**要拿去 merge-back**）指向新树而非那个阻塞目录。
- AC-9 代际预算耗尽（连新路径都建不起来）时，节点仍以 `iso-recreate-failed` 失败，但消息含
  残留路径 + 最后错误 + Job Object 可用性诊断。
- AC-19 **换代之后的 `discardNodeIso` 不抛**：handle 的 DB 身份（`dbNodeRunId`）与物理 iso 键分离，
  effect observer 只吃真实行 id。不满足这条，L4 会在 `schedulerAssembly.ts:234` 的裸 await 上
  抛穿 `runAssembly`，造出一个比 issue #13 更早触发的新 wedge（设计门 P0-1）。

**进程树归属（L2 / L3）**

- AC-10 Windows + Bun 有 FFI 时，spawn 后进程树被 Job Object 接管：`isProcessTreeAlive` 返回真实布尔
  （不再恒 `null`），杀树走 `TerminateJobObject`，且**杀树之后 `liveCount()` 仍在查内核**
  ——今天 `terminate()` 会关句柄并把它短路成 0，观测面在杀树那一刻就没了（设计门 P0-2）。
- AC-11 Windows 无 FFI（ARM64）时保持 `taskkill /T /F` 降级，**不新增平台专属杀树路径**；降级事实在
  daemon 启动时 warn 一次，并出现在 AC-9 的诊断里。
- AC-12 树被杀之后、iso 回收之前，平台会在预算内等待树静默。触发门是「**本次运行调用过 `killTree`**」
  ——覆盖 escalate 路径、**drain 超时那条绕过 escalate 的直接杀树**，以及 `killStaleRunProcessTree`
  的四个带外消费方（设计门 P0-3）；等不到只 warn，不改 `outcome`、不改 `processUnreaped` 语义。
- AC-13 POSIX 行为逐字不变：`adoptSpawnedProcessTree` 在非 win32 返回 false，杀树仍走进程组。

**连带修复 / 统一**

- AC-14 `handleTaskIdOf` 在 Windows（`\`）与 POSIX（`/`）两种路径形状下都能正确回读 taskId，
  不再返回 `'unknown'`。
- AC-15 **目录删除只有一份实现**（`removeDirectoryWithRetry`），iso 侧与
  `services/task.ts` 的 `reclaimStalePrepArtifacts` 共用。
  （r2 收窄：后者删 `{appHome}/worktrees/{slug}/{taskId}` 时手里**没有**该 slug 对应的镜像仓——镜像集合
  要到它自己的步骤 ③ 才解析——所以它用不上带 `repoPath` 的阶梯第 2 档。把 slug→镜像解析提前是正解，
  但属它自身的重构，不折进本 RFC。）
- AC-18 被 abort 掐掉的 `git worktree add` 留下的 stale `refs/heads/<branch>.lock` 能被回收——
  **按 mtime 判龄**（早于 60s 才删，避免抢活着的 git 进程持有的锁）；年轻锁不动。
  仅对持有分支名的调用方生效；iso 走 `--detach`，不受影响。

**证据**

- AC-16 上述每条都有测试；Windows 专属分支由 `.github/workflows/windows-platform.yml` 的真 Windows 腿覆盖。
  **每个 PR 各自**把自己触及的源码与测试文件加进该 workflow 的 `push` / `pull_request` 两份 paths 清单
  （两份必须逐字相同；守卫只检查 push ⊇ pull_request，看不到反向漂移）——不是攒到最后一个 PR，
  否则前两个 PR 落地时 Windows 腿根本不触发。
- AC-17 主 CI 在本 RFC 最终 sha 上 run 级 `conclusion == success`，按 exact SHA 取证。
- **证明力声明**：`blocked` 这一档在 CI 上难以自然触发（需要真有进程持句柄）。AC-3 / AC-4 / AC-6 / AC-9
  在 Windows 腿上**以注入方式证明**，POSIX 上用 chmod 屏障真做；「真机自然复现」**不作为交付判据**。
  这句话写在验收正文里而不是风险附注里，是为了让接手者一眼看到证明力的边界。

## 10. 用户裁决记录（2026-09-04）

| 编号 | 问题                        | 裁决                                                                                                                                                                |
| ---- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1   | 三层都清不掉残留时怎么收场  | **换唯一路径继续跑 + 连新路径都建不起来才带诊断失败**（本 RFC L4 + G3）                                                                                             |
| D2   | ARM64 无 Job Object 怎么办  | **保持 taskkill 降级 + 显式诊断**，不新增平台专属杀树路径                                                                                                           |
| D3   | 回收原语覆盖面              | **统一成一份实现**，iso 与任务工作树共用（r2 收窄至「目录删除」层，见 AC-15）                                                                                       |
| D4   | L3 在 Windows 上空转怎么办  | **完整修**：改 RFC-254 的 `terminate()` / `liveCount()` / `killProcessTreeWin32` 三处，并把 L3 的门放宽到「调用过 `killTree`」+ 给 `killStaleRunProcessTree` 补一跳 |
| D5   | 接线后 release 会杀幸存后代 | **接受，并在 §7⑤ 申报**——那正是 #13 的句柄持有者，也是平台既有意图里要收割的孤儿                                                                                    |

起点是用户「定位下 issue 13 的问题」；定位结论见 §1～§4。用户随后裁决「全做」（三层全上）。
D4 / D5 是设计门查出 3 条 P0 之后补问的（2026-09-04 同日）。

D1 的成本在澄清过程中被**下修**：初判「换唯一路径不通」是错的——`isoKeyOf`
（`nodeMechanics.ts:973`）早已把 iso 键定义为 `basename(持久化的 iso_worktree_path)`（RFC-210 round 6 P2
就是为了让 iso 键和行 id 脱钩才加的），所以带后缀的键天然能回读；只剩三处裸派生需要补齐
（`wrapperMechanics.ts:1662`、`:1694`、`platform/persistence/sqlite/taskLifecycleRepair/options-S1.ts:79`）。
这条更正已写进 design.md §5。
