# RFC-210 递归 submodule 隔离与自动同步

> 状态：Draft **v2**（待用户批准）——三路对抗设计门折入 **7 P0 + 约 20 条 P1/P2**，v1 的三条核心技术断言被实测证伪，详见 `design.md` §0.2 / §0.3。新增 G10（子仓快照与回滚，用户 2026-07-20 拍板）。
> 关联：RFC-034（`services/gitSubmodule.ts` 全链路 submodule 物化）；RFC-130（节点 worktree 隔离，D22 把 submodule 脏内容登记为已知限制）；RFC-075（`services/commitPush.ts` / `commitPushRunner.ts` auto-commit-push）；RFC-024 / RFC-033（`services/gitRepoCache.ts` cold clone / warm fetch / 批量导入）；RFC-060 PR-E（`git_diff` 端口改为 `list<path<*>>`）；RFC-204（凭据封存，本 RFC 的子仓 push 沿用其脱敏口径）。

## 背景

平台从 RFC-034 起就宣称"含 submodule 的仓开箱即用"。**读**这一侧确实做到了：cold clone / warm fetch / 手动 refresh / `createWorktree` / `createIsolatedWorktree` / `materializeTree` 六个点位都会跑
`git submodule sync --recursive` + `git submodule update --init --recursive`。

但**写**这一侧从未接通。本 RFC 立项前用真 git（2.50.1）在一次性 fixture 上逐条复现，确认了**三处静默数据丢失**——都不报错、不写日志、不翻任务状态：

### ① merge-back 吞掉节点在 submodule 里的提交

`materializeTree`（`packages/backend/src/util/git.ts:2009-2052`）的步骤顺序是
`read-tree <merged>` → `checkout-index -f -a` → `reset --mixed <taskBaseHead>` → `syncSubmodules`。
`checkout-index` 不写 gitlink，而 `reset --mixed` 已把 index 里的 gitlink 退回 base，最后的
`submodule update` 按 **index**（即 base）重新 checkout 子仓工作区：

```
merged tree gitlink = 6d7bbda（节点在子仓的提交）
  after read-tree        → index gitlink = 6d7bbda
  after checkout-index   → vendor HEAD  = 9ad004c   ← 不写 gitlink
  after reset --mixed    → index gitlink = 9ad004c
  after submodule update → vendor HEAD  = 9ad004c
  canonical git status   : ''                       ← 节点改动彻底消失
```

这直接推翻 `design/RFC-130-node-worktree-isolation/proposal.md:62` 的断言"submodule 内**已提交**的改动照常随 gitlink 走"。
`syncSubmodules` 的返回值在 `util/git.ts:1827` 与 `:2051` 两处都被丢弃，所以连一条 warning 都没有。

### ② iso worktree 的 submodule 是独立 clone，子仓提交出不去

linked worktree **不共享**父仓的 submodule git dir——iso 的子仓 gitdir 是
`<repo>/.git/worktrees/<iso>/modules/<sub>`，有自己完整的 `objects/`，无 alternates。后果有二：

- **性能**：每建一个 iso worktree 就整份重新 clone 每个 submodule。节点数 × submodule 大小。
- **正确性**：节点在子仓提交的 commit 只存在于该 iso 的 module dir。canonical 与后续 iso 都取不到，
  `git fetch` 报 `fatal: remote error: upload-pack: not our ref`，而 `snapshotFullState` 此时会把
  gitlink **静默记成 module dir 的旧 HEAD**，不报错。

这两点让 ① 无法被单独修复：即便把 `materializeTree` 的顺序改对，目标 worktree 的 module dir 里
根本没有那个 commit 对象，`git checkout <sha>` 会直接 `fatal: unable to read tree`（已实测）。

### ③ auto-commit-push 在带 submodule 的仓上两种坏行为

`commitPush.ts` / `commitPushRunner.ts` 全文零 `submodule`，也没有 detached-HEAD 检测。实测：

| 情形 | 父仓 `status --porcelain` | `add -A` 后 `diff --cached --numstat` | 结果 |
|---|---|---|---|
| agent 改了子仓工作区、未在子仓提交 | ` M sub`（**非空 → 脏检查门放行**） | **空** | `filesChanged===0` ⟹ `skipped-empty`，改动静默不提交，连 commit session 都不起 |
| agent 在子仓提交（子仓恒为 detached HEAD） | ` M sub` | `1 1 sub`（只有 gitlink） | 父仓提交并 push 出一个指向"只存在于本地子仓、不在任何分支上"的 commit ⟹ **远端 gitlink 悬空**，别人 clone 下来 `submodule update` 必失败 |

### ④ RFC-034 的配置项是死的

`gitRecurseSubmodules` / `gitSubmoduleJobs` 在 `packages/shared/src/schemas/config.ts:226,232` 有 schema，
但**没有任何生产代码读 `config.gitRecurseSubmodules`**——实际行为恒为 `auto` / `jobs=4`，硬编码在
`resolveSubmoduleParams`（`services/gitRepoCache.ts:259-273`）。前端零 UI、未登记进
`SETTINGS_CONFIG_SCOPE_KEYS`（`lib/settings-drafts.ts:37-73`）。
唯一"锁"它的测试 `packages/frontend/tests/repos-submodule-wiring.test.ts:43-50` 只断言 **shared schema 的源码文本**，
所以断链测不出来。`util/git.ts:416` 还留着一句注释宣称 "Caller (services/task.ts startTask) wires this
through from settings.gitRecurseSubmodules"——该接线从未存在。

### ⑤ 三个从未做过的能力

- **子仓改动进产物链路**：`git_diff` 端口（RFC-060 PR-E 后是 `list<path<*>>`）对 submodule 只吐一条
  目录路径 `sub`，占一个分片，下游 agent 拿到的是个目录而不是变更文件清单。
- **后台定时刷新**：全仓 13 个 daemon 级 `setInterval`（`cli/start.ts:443-543`）里没有任何 repo /
  submodule 刷新循环。URL 仓只在起任务 warm fetch 或用户手点 Refresh 时更新。
- **子仓跟上游最新**：`gitSubmodule.ts:82` 是 `submodule update --init --recursive`，只 checkout
  父仓记录的 commit，没有 `--remote` 语义。

## 目标

**G1 — 共享对象池（②的正解，也是①的前提）**
以 cached repo 的 `<repo>/.git/modules/<sub>` 为**共享对象池**，canonical worktree 与每个 iso worktree
的 submodule module dir 全部通过 `objects/info/alternates` 指向它。节点在 iso 子仓提交后，merge-back 前
把新 commit 回写共享池，canonical 与后续 iso **立即可见**。

> **v2 两处关键修正**（设计门实测证伪 v1）：
> ① `submodule update --reference` **只对首次 init 生效**，对已初始化的 module dir 是静默 no-op ⟹
> 必须**无条件显式写 `objects/info/alternates` 文件**兜底（含存量仓的补挂）。
> ② `git fetch <dir> <sha>` **只写 FETCH_HEAD 不建 ref**，对象在池里恒不可达，**默认 `gc` 就会删** ⟹
> 回写必须紧跟一个与 task 同寿命的**保活 ref**。缺这一条，池 gc 后 canonical 子仓 `bad object HEAD`，
> 父仓 `git status` 整体失败，全线崩。
> **path 模式（用户本机路径仓）一律不建池**（D11）——池就是用户真实的 `.git/modules/<sub>`，
> 平台的对象/ref/commit 会永久落进去且清不掉；降级为每 worktree 私有 module dir。

**G2 — 修复 merge-back 丢 gitlink（①）**
`materializeTree` 在 `submodule update` **之后**追加一步：按 merged tree 里的 gitlink 逐个
`git -C <sub> checkout --detach <sha>`。顺序至关重要——放在 `submodule update` 之前会被它按 index 拉回 base。
修复后 gitlink 变化落在**未暂存**区，符合 RFC-130 D23/D28 的既有语义。

**G3 — 递归隔离（全部嵌套层）**
每个 submodule（任意嵌套深度）作为独立隔离子树参与三路合并：iso 创建时记录每层子仓的 base commit，
终态快照时记录每层子仓的 node commit，merge-back 时**在子仓层独立跑 `git merge-tree --write-tree`**。
git 原生**不会**替我们递归（实测：父仓层 merge-tree 遇到两边都动的 gitlink 直接 `exit=1` 并提示
`Recursive merging with submodules currently only supports trivial cases`），必须自己实现这一层。
RFC-130 D22 的 `submodule-dirty-content` fail-loud 随之**退役**——脏内容由平台在 iso 内自动提交后纳入合并。

> **v2 三处关键修正**：① 子仓合并结果必须用**双 parent** `commit-tree -p <ours> -p <theirs>`（ours 在前）——
> git 要求 merged sub-commit 以 ours 为祖先，单 parent 会让父仓层 100% 退回 `exit=1`（实测）；现有
> `commitTree()` 只接受一个 parent，需扩展。② `git ls-tree -r` **穿不透 gitlink**，不存在"一次拿到所有层"的
> 捷径，父层 tree 必须**逐层重写**。③ 回写对象必须**无条件**（不只对"脏"子仓）——agent 可能自己在子仓提交，
> 此时子仓干净，而丢弃 iso 时 `worktree remove --force` 会连 module dir 一起删，对象将永久丢失。

**G4 — 子仓冲突处理**
子仓层 merge-tree 干净 ⟹ 自动合并落地（实测：两节点改同一文件不同行可自动合成 `l1-A / l2 / l3-B`）。
真冲突 ⟹ 开一个**子仓级 resolve-iso**交给现有 merge agent，复用 `services/mergeAgent.ts` 已有的
`CONFLICT (submodule)` 分类与判定；解不开则整任务 `awaiting_human`（与父仓层现状一致）。

**G5 — auto-commit-push 递归到子仓，原子性优先（③）**
自底向上：先在每个子仓（最深层优先）建同名工作分支、commit、push；**全部子仓 push 成功后**父仓才
bump gitlink 并 push。任一子仓 push 失败 ⟹ 父仓**不推**该变更（本地提交保留），记
`commit-local-subrepo-failed`，UI 标警。保证远端 gitlink 永远可解析。
同时修掉"子仓脏但父仓 `diff --cached` 空 ⟹ `skipped-empty`"这条静默跳过。

**G6 — 子仓改动进 `git_diff` 端口**
`gitChangedFiles` 对 submodule 路径展开为 `<sub>/<file>` 形式的真实变更清单（递归），
让分片粒度与父仓文件一致，下游 audit / fix agent 能真正看到子仓改了哪些文件。

**G7 — 后台定时刷新（默认开）**
新增 daemon 级循环，按既有样板（`eventsArchive.ts:203-228` 的 `{ stop }` + 重入保护 + 每 tick
`loadConfig()`）对缓存仓跑 `fetch` + submodule sync/update。默认周期 6h，只刷**最近被任务引用过**的仓。

**G8 — `--remote` 跟随上游（默认关）**
新增 `gitSubmoduleRemote` 开关，开启后 submodule 同步走 `update --remote`（拉子仓上游分支最新并
bump gitlink）而非 checkout 父仓记录的 commit。默认关闭——它会让任务基线随上游漂移，损害可重现性。

**G9 — 接通 RFC-034 断链（④）**
`gitRecurseSubmodules` / `gitSubmoduleJobs` 真正从 config 读到 `resolveSubmoduleParams`，
并在 settings 暴露 UI（登记进 `SETTINGS_CONFIG_SCOPE_KEYS`）。补一条**行为级**测试取代现有的源码文本断言。

**G10 — 子仓快照与回滚（v2 新增，用户 2026-07-20 拍板）**
本 RFC 让平台首次在**用户的子仓里造 commit**，必须配套最小回退能力，四条防线：

| 场景 | 处理 |
|---|---|
| iso 内的子仓改动 | **无需回退**——随 iso 丢弃自然消失（`worktree remove --force` 实测连 module dir 一起删） |
| merge-back 失败 / canonical 子仓被 checkout 覆盖前 | 子仓快照（`snapshotFullState` 同款：临时 index，捕获 tracked + **untracked**，不碰真 index/HEAD），可完整回退 |
| commit-push 子仓已提交但未 push | 可回退（撤销平台 commit + 恢复工作区 + 恢复 untracked，均已实测） |
| commit-push 子仓**已 push** | **不可逆**（本地回滚管不到远端）——文档明示 + UI 标出"子仓已推、父仓未推"的不一致态 |

> **重要**：**不复活 `pre_snapshot` 机制**（D12）。RFC-130 已删除其写入点（`scheduler.ts:3081-3086`：
> "the pre-snapshot … is GONE — the iso model never writes the canonical worktree, so there is nothing to
> roll back"），全仓 `gitStashSnapshot` 零调用、列恒 NULL。扩展它等于扩展死代码，且与 iso 重试语义冲突。
> 嵌套层回滚会让父层 gitlink 变脏（实测），故顺序是**自底向上回滚、再自顶向下修一遍父层 gitlink**。

## 非目标

- **不**支持 `.gitmodules` **本身的语义合并**：它按普通文本文件走三路合并。
  （**v3 更正**：submodule 的新增 / 删除 / 重命名在隔离树间的处理**是目标**，见 `design.md` §2.4 的分支表——
  v2 把它写进非目标，与 design/plan 直接冲突。两个节点一个加一个删同名 submodule ⟹ 走冲突路径交人工。）
- **不**做子仓的凭据独立管理：子仓 push 沿用父仓 git 进程的 credential helper / SSH agent，与 RFC-024/RFC-204
  对父仓的处理完全对齐；平台不为子仓存 token、不注入 `user:pass`。
- **不**支持子仓 push 到与父仓不同的 remote 名：一律 `origin`（与 `commitPushRunner.ts:119` 现状一致）。
- **不**做 submodule 级的 webhook / 事件订阅：同步只在 cold clone / warm fetch / worktree 创建 /
  iso 创建 / merge-back / 新增的定时循环这几个点位触发。
- **不**引入 shallow / partial clone（`--depth` / `--shallow-submodules`）：与 RFC-024 对齐。
- **不**做 per-repo 的 submodule 策略覆盖（"这个仓递归、那个不递归"）：v1 仅全局 settings。
- **不**改 `git_diff` 端口的 kind（仍是 `list<path<*>>`）：只让它多吐子仓内的真实路径。
- **不**复活 `util/diffSplit.ts`：它自 RFC-060 PR-E 起已无生产消费者，本 RFC 不新增消费者。
- **不**支持 Windows：与项目当前 macOS + Linux 分发对齐。

## 用户故事

1. **子仓改动不再丢**——用户跑 Code→Audit→Fix 工作流，writer 节点在 `vendor/` 子仓里改了三个文件。
   平台在 iso 内自动以内部身份提交子仓，gitlink 推进，merge-back 后 canonical 的 `git status` 显示
   ` M vendor`（未暂存），auditor 节点从 `git_diff` 端口拿到 `vendor/a.ts` / `vendor/b.ts` / `vendor/c.ts`
   三条路径，分片后逐个审计。**今天这三个文件对整条链路完全不可见。**

2. **并发节点改同一子仓能合**——两个 readonly=false 节点分别改 `vendor/a.txt` 的第 1 行和第 3 行。
   子仓层 merge-tree 自动三路合并成同时含两处改动的树，父仓 gitlink 指向合并结果。
   今天：第二个节点的 merge-back 会把第一个节点的子仓提交整个覆盖掉（gitlink 静默回退）。

3. **远端 gitlink 不再悬空**——`autoCommitPush` 开启，writer 改了父仓与子仓。平台先把子仓推到
   `agent-workflow/{taskId}` 分支，成功后才推父仓的 gitlink bump。同事 clone 下来
   `git submodule update --init --recursive` 能正常拉到。子仓无写权限时，父仓的 gitlink 变更**不推**，
   任务详情页明确标出"子仓 `vendor` 推送失败：Permission denied"。

4. **缓存仓自动保鲜**——用户一周没起任务，缓存仓与子仓仍被后台每 6 小时刷新一次；`/repos` 行上能看到
   "上次自动刷新 2 小时前"。今天必须手点 Refresh 或起任务才会动。

5. **逃生开关可用**——用户的子仓走私有协议拉不通，在 Settings → GC/Git 分区把 `gitRecurseSubmodules`
   切到 `never`，全链路退回 RFC-024 现状。**今天切了不生效**（配置断链）。

## 验收标准

- **AC-1**（G1）iso worktree 与 canonical worktree 的 submodule module dir 均含
  `objects/info/alternates` 指向 `<repo>/.git/modules/<sub>/objects`，且 `objects/pack` 为空（零拷贝）。
  **含已初始化 module dir 的补挂路径**（`--reference` 对其是 no-op，必须靠显式写文件），
  以及**每个子仓各挂各的池**（单个 `--reference` 会被 git 套用到全部子仓，造成交叉污染）。
- **AC-2**（G1）节点在 iso 子仓提交后，merge-back 前该 commit 已在共享池；canonical 无需额外 fetch 即可
  `cat-file -t` 到它。
- **AC-3**（G2）红→绿回归：造一个"节点在子仓提交"的 fixture，修复前 canonical `git status` 为空、
  子仓内容为旧值；修复后 vendor HEAD == 节点提交、内容为新值、`git diff --name-only` 含 `vendor`、
  `git diff --cached --name-only` 为空。
- **AC-4**（G3）任意嵌套深度（≥2 层）的 submodule 改动都能穿过 iso → merge-back 到达 canonical。
- **AC-5**（G4）两节点改同一子仓不同行 ⟹ 自动合并，两处改动都在；改同一行 ⟹ 走 merge agent；
  agent 解不开 ⟹ 任务 `awaiting_human`，canonical 保持干净（不写冲突标记）。
- **AC-6**（G5）子仓 push 失败 ⟹ 父仓的 gitlink 变更不推送，node_run outcome 为
  `commit-local-subrepo-failed`，任务状态不翻（与现有 commit-push 永不翻任务状态一致）。
- **AC-7**（G5）"子仓脏、父仓 `diff --cached` 空"不再产出 `skipped-empty`。
- **AC-8**（G6）`git_diff` 端口对子仓变更吐出 `<sub>/<file>` 形式的路径，分片数 == 变更文件数。
- **AC-9**（G7）定时刷新循环遵守既有样板：`{ stop }` 句柄、重入保护、每 tick `loadConfig()`、
  错误只记日志不抛、注册在 `cli/start.ts` 的 tickers 段并在 `shutdown()` 里停。
- **AC-10**（G8）`gitSubmoduleRemote=false`（默认）时**不新增任何 submodule 相关 git 进程**，
  既有 argv 逐字节不变。（措辞不能写成"全链路 argv 字节级一致"——`hasDirtySubmoduleContent` 加门后
  会**减少** argv，与"一致"冲突。）
- **AC-23**（G8）`gitSubmoduleRemote=true` 时，上游子仓推进后**新起的任务 worktree 里子仓内容为新版本**。
  没有这一条，G8 就是个无效开关：读侧三个点位只作用于 cache repo 自身，而任务 worktree 从已提交的 ref 派生，
  按 D8 不带 `--remote` ⟹ 任务永远看不到新版本（见 `design.md` §9 的 v3 更正）。
- **AC-11**（G9）`gitRecurseSubmodules='never'` 时，全链路不再 spawn 任何 submodule 相关 git 进程——
  用 **runGit spy 断言 argv**，而非源码文本断言。
- **AC-12** 无 `.gitmodules` 的仓（绝大多数）全链路 git argv 与本 RFC 前字节级一致，**零额外 git 进程**。
  今天 `createNodeIso` 对这类仓 spawn 零个 submodule 进程（`existsSync` 纯 FS 探针），所以**所有**新增
  submodule 逻辑的第一道门必须是 `detectSubmodules`；`hasDirtySubmoduleContent` 现在无条件跑两条 git，也要加同一道门。
- **AC-15**（G1）**保活 ref 让回写的对象扛住默认 `gc`**（不只是 `--prune=now`）——`git fetch <dir> <sha>` 只写
  FETCH_HEAD 不建 ref，无保活 ref 时对象恒不可达、两周宽限期后被删，canonical 子仓随即 `bad object HEAD`。
- **AC-16**（G3）子仓合并结果满足 **`git merge-base --is-ancestor <ours> <merged>`**，父仓层 merge-tree 随之 `exit=0`。
  防回归用例锁的是 **`-p theirs` 单 parent ⟹ `exit=1`**（真不变量）。
  ⚠️ **不要**写成"单 parent 必 exit=1"——实测 `-p ours` 单 parent 也是 `exit=0`，那是**假不变量**，
  会在实现者选用单 ours parent 时误红（v2 的原始措辞正是如此）。
- **AC-17**（G3）crash replay：`rebuildIsoHandle` 能从 `iso_submodules_json` 读回子仓 base；
  该列缺失但仓有 `.gitmodules` 时 **fail-closed 拒绝 replay**，不得退化成父仓层合并（会静默覆盖）。
- **AC-18**（G4）子仓冲突未解时 `completeHumanResolvedConflict` **fail-closed**——
  绝不走"无 resolve-iso 就对 canonical 重探"分支把未解决的 gitlink 当已解决放行。
- **AC-19**（G5）`commit-local-subrepo-failed` 已加入 `COMMIT_PUSH_OUTCOME` 枚举、
  `commitOutcomeKey` 有专属分支、`finalize` 判 failed。缺任一：整行 commit-push 从 UI 消失，
  或被显示成"跳过（无变更）"。
- **AC-20**（G10）子仓快照可恢复 tracked + untracked 并撤销平台 commit；嵌套场景按
  "自底向上回滚 + 自顶向下修父层 gitlink" 收敛；**已 push 的不可逆**这条有显式测试与 UI 提示。
- **AC-21**（D11）path 模式仓不在用户主仓的 `.git/modules/<sub>` 里留下任何对象 / ref / commit。
- **AC-22** 配置管道打通全部 4 层（`createIsoUnderLock` / `mergeBackNodeIso` / `materializeTree` 6 个调用点 /
  `util/git.ts` 不自取 config），且 `config/index.ts` 的 `mergeDefaults` + `mergePatch` 已认新嵌套字段。
- **AC-13** 前端：Settings 新增 git 配置组（复用 `Field` / `Select` / `NumberInput` / `Switch`）；
  `/repos` 的 `SubmoduleBadge` 扩到四态并**收编进 `StatusChip`**（弃用自写的 `.submodule-badge` class）；
  任务详情渲染每个子仓的提交/推送结果。
- **AC-14** `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿；
  单二进制 build smoke 通过；Playwright e2e 通过（含 `repos.png` / `settings.png` 视觉基线按需刷新）。

## 与现有模块的关系

| 模块 | 改动 |
|---|---|
| `services/gitSubmodule.ts` | 扩为 submodule 拓扑与合并的单一事实源。**接口以 `design.md` §1.2 为准**（v2 此处列的 `linkSubmoduleAlternates` / `commitDirtySubmodules` / `mergeSubmoduleTrees` 是 v1 遗留命名）：`listSubmodules` / `resolveSubmodulePool` / `ensureSubmoduleAlternates` / `pushObjectsToPool` / `snapshotSubmodule` / `rollbackSubmodule` / `rollbackSubmodulesRecursive`；`syncSubmodules` 增 `remote?`。**`--reference` 仅作首次 init 加速**，正确性靠**逐子仓**的 `ensureSubmoduleAlternates`（单个 `--reference` 会被 git 套用到全部子仓，造成交叉污染） |
| `util/git.ts` | `materializeTree` 追加 gitlink checkout 步（G2）；`createIsolatedWorktree` 传 `--reference`（G1）；`hasDirtySubmoduleContent` 从"门"降级为"探针"；`gitChangedFiles` 递归展开子仓路径（G6） |
| `services/nodeIsolation.ts` | 删 D22 fail-loud（`:264-275`）；`snapshotNodeIsoFinal` 前先自动提交子仓；`mergeBackNodeIso` 增子仓层递归合并 |
| `services/mergeAgent.ts` | 复用现有 `submodule` 冲突分类；新增子仓级 resolve-iso 的 prompt 变体 |
| `services/commitPush.ts` / `commitPushRunner.ts` | 递归子仓提交/推送 + 原子性门（G5）；新增 outcome `commit-local-subrepo-failed` |
| `services/gitRepoCache.ts` | `resolveSubmoduleParams` 真正读 config（G9）；新增 `listReposForPeriodicRefresh` |
| `services/submoduleRefresh.ts`（新） | G7 的 daemon 循环 |
| `cli/start.ts` | 注册 + 停止新循环 |
| `shared/schemas/config.ts` | 新增 `gitSubmoduleRemote` / `submoduleAutoRefresh{enabled,intervalMs,onlyRecentDays}` |
| `db/schema.ts` + migration **0102** | `cached_repos` 增 `last_auto_refresh_at`；**`node_runs` 增 `iso_submodules_json` + `iso_submodules_repos_json`**（single/multi 双列制，与既有 iso 列同构——v2 误写成单列会让多仓任务串仓）；`node_runs.commit_push_json` 增子仓结果数组（JSON 内，无需新列）。**编号 0100/0101 已被占用，落地前必须再核** |
| 前端 | Settings git 分区、`SubmoduleBadge` 收编进 `StatusChip`、任务详情子仓结果列表 |
| `services/scheduler.ts` | **有改动**（v2 误写"零改动"）：`rebuildIsoHandle` 的 4 个调用点（replay / conflict-human resume / wrapper 重建 / 陈旧清理）+ wrapper 私有 canonical 的 `createNodeIso` 直调点（它**绕过** `createIsoUnderLock`，配置管道要单独打通，否则 AC-11 在 wrapper 路径达不成） |

## 失败模式回顾

| 场景 | 处理 |
|---|---|
| 共享池不存在（path 模式本地仓、用户自己 `git clone` 的仓） | `--reference` 失败即降级为独立 clone（现状），记 warning，不阻断 |
| `--reference` 后共享池被删（用户删缓存仓） | git 的 alternates 悬空会让对象读失败；GC 侧禁止在有活跃任务引用时删缓存仓（沿用 `referencingTaskCount` 门） |
| 子仓 detached HEAD 下 commit | 正是常态；平台在子仓显式建 `agent-workflow/{taskId}` 分支再提交（G5） |
| 子仓无写权限 | push 失败 ⟹ 父仓不推 gitlink（G5 原子性），本地提交保留，UI 标警 |
| 子仓层 merge-tree 冲突 + merge agent 解不开 | 整任务 `awaiting_human`，canonical 保持干净——与父仓层现状一致 |
| 嵌套 N 层且中间层冲突 | 自底向上逐层合并；某层未解决则其上所有层都停在该层，任务 `awaiting_human` |
| submodule 数量极多（数十个） | `--jobs` 并发（沿用 `gitSubmoduleJobs`）；隔离树数量 = 子仓总数，`iso` GC 沿用 `services/gc.ts` 既有清理 |
| 定时刷新与起任务 warm fetch 撞车 | 复用 `withUrlLock(urlHash)`（`gitRepoCache.ts` 既有），天然串行 |
| 定时刷新拉挂网络 | 只记日志 + 写 `last_submodule_sync_error`，绝不翻任何任务状态 |
| `--remote` 开启后 gitlink 漂移 | 默认关；开启时在任务事件里显式记录每个子仓被 bump 到哪个 commit，保留可追溯性 |
| git < 2.38 | 已有 boot gate（`cli/start.ts:120-132`）硬拦；本 RFC 不放宽 |
| `gitRecurseSubmodules='never'` | 全链路短路，包括新增的定时刷新与递归隔离（AC-11 用 argv spy 锁死） |

## 多人协作

工作树里有并发 session 的 workgroup 改动（`services/workgroupLifecycle.ts` / `workgroupRunner.ts` /
`routes/workgroupTasks.ts` 及两个未追踪的新 service）。本 RFC 的代码改动与之**零文件交叠**。
需留意的共享文件有四处，一律**按行追加、不替换**：
1. **`packages/backend/db/migrations/meta/_journal.json`** —— **最高危**（v2 漏列）。2026-07-20 实测：
   `0100_rfc207_task_running_time.sql` 已提交，**`0101_rfc207_directive_shard.sql` 由并发 session 持有且未提交**
   （`git status` 显示 `??`），journal 已被其改成 101 条（`M`）而 HEAD 是 100 条。
   ⟹ 本 RFC 取 **0102**；提交时**只 `git add` 自己的 migration 文件**，绝不 `git add -A`；
   落地前跑**全量** backend 测试确认 journal↔files 未失配（这正是 [Full suite after migration] 记录的事故形状）。
2. `design/plan.md`（RFC 索引表尾）
3. `STATE.md`（顶部进行中列表）
4. `shared/schemas/config.ts`（在 RFC-034 字段紧邻位置追加）

`upgrade-rolling.test.ts:230` 的断言现值是 **"HEAD journal has 100 entries"**，
落地时按**实际 HEAD 值 +1** 改（标题 + 断言 + 注释三处），不要照抄本文档的数字。
