# RFC-130 Design —— 每节点隔离 worktree + 串行合并回收；删除 readonly

> 状态：Draft　配套：`proposal.md` / `plan.md`
> 本文所有 file:line 均为核对过的现网代码位置。

## 0. 术语

| 术语 | 含义 |
|---|---|
| **主树 / canonical worktree** | 任务既有的那个（多仓则每仓一个）git worktree（`~/.agent-workflow/worktrees/{slug}/{task-id}`）。累积任务的未提交改动，是 resume / 输出 / git wrapper diff / auto commit&push / 最终产物的**唯一事实源**（不变量 I-1）。 |
| **隔离树 / isolated worktree** | 每个 node run 派发时新建的临时 `git worktree`，起点 = 派发时刻主树全量状态。opencode 以它为 cwd 并行运行。用完即弃。 |
| **隔离起点快照 / base-snapshot** | 派发时刻主树全量状态（HEAD + 已跟踪改动 + untracked）的一个 commit 对象（pin 防 gc）。隔离树从它 checkout；合并回收时作三路合并的 base。 |
| **合并回收 / merge-back** | node run 成功后，在写锁下把「隔离终态 vs base-snapshot 的 delta」三路合并回主树。 |
| **合并 agent** | 新内置 framework agent，三路合并出真冲突时被派发去解冲突（仿 commit-push）。 |

## 1. 根因（详见 proposal §1）

DAG 并行已在（`scheduler.ts:711` 完成驱动 frontier），但可写节点被**每任务一把、罩住整个 agent 运行**的写锁 `writeSem`（`taskWriteLocks.ts` + `scheduler.ts:1960/4061/4351`）串成一次一个——因为所有节点共用一个主树，并发写互相覆盖、git wrapper diff 快照（`scheduler.ts:4588/4675`）被污染。`readonly` 的唯一价值是让「不写盘」的 agent 跳过写锁真并行。

## 2. 新执行模型总览

**每个 node run 的三段式**（锁序见 §7）：

```
① 快照-派发（持 writeSem，毫秒级）
    base = snapshotFullState(主树)          // 含 untracked，pin 防 gc
    git worktree add --detach <iso> base    // 隔离树
   释放 writeSem
② 运行（持 globalSem，分钟级；不持 writeSem）
    runNode(cwd = 隔离树)                     // opencode 并行跑
   释放 globalSem
③ 合并回收（持 writeSem，毫秒级；冲突时含合并 agent）
    node_tree = snapshotFullState(隔离树)
    canon_tree = snapshotFullState(主树)     // 可能已被兄弟节点推进
    merged = merge-tree(base, canon_tree, node_tree)   // 内存三路合并
    if 干净:  materialize(主树, merged)
    else:     合并 agent 解（§6）→ materialize 或 awaiting_human
   释放 writeSem
   弃隔离树（worktree remove + 删 pin ref）
```

**关键**：writeSem 只罩 ①③ 两个**毫秒级**窗口，不再罩住 ② 的多分钟 agent 运行。于是并行度从「可写节点 1」提升到「受 `globalSem`（默认 4）约束的 DAG 并行」。合并回收在**同一把 writeSem 上串行** → 主树的读（快照 base / canon）与写（materialize）互斥，不会撕裂。

**为什么并发正确**：兄弟节点各在自己隔离树写，物理隔离（AC-2）；合并回收串行且以内存三路合并计算，主树永不处于半合并态（§6 冲突也不落半成品，除 awaiting_human 兜底）。第一个完成的兄弟合并回收时主树 == 它的 base（未动过）→ 干净应用；后续兄弟的 base 落后于主树 → 真三路合并，重叠才冲突。

## 3. 数据模型变更

### 3.1 删除 `agents.readonly`

- migration `00NN_rfc130_drop_agent_readonly.sql`：SQLite 12 步表重建删列（照 `0057_rfc115_drop_agent_params.sql` 模板；`readonly` 是 `agents` 表 `schema.ts:27`）。**pre-drop fail-loud 守卫**非必需（删只读列不丢关键语义），但迁移注释标明。
- `AgentSchema`/`CreateAgentSchema`（`shared/schemas/agent.ts:98/165`）、`InventoryAgentSchema`（`shared/inventory.ts:44/138`）删字段。
- 旧 `agent.md` / 导入含 `readonly:` 键 → 降级路由进 `frontmatterExtra`（不丢不报，同 RFC-115 处理旧 `model:` 键；`services/agent.ts` 解析处）。AC-16。

### 3.2 `node_runs` 新增隔离记账列（migration `00NN+1`，纯 ADD COLUMN）

| 列 | 类型 | 用途 |
|---|---|---|
| `iso_worktree_path` | text nullable | 该 run 隔离树绝对路径；成功弃后置空。resume / GC 据此清孤立隔离树。 |
| `iso_base_snapshot` | text nullable | base-snapshot sha（单仓）。合并回收 base；也是重试/回滚的「弃隔离树后从主树重新分叉」不依赖项。 |
| `iso_base_snapshot_repos_json` | text nullable | 多仓：`{worktreeDirName: sha}`。 |
| `merge_state` | text nullable | `null`（未到合并）/`merged`/`conflict-resolving`/`conflict-human`。resume 幂等据此。 |

> 复用既有 `pre_snapshot`/`pre_snapshot_repos_json`？**不复用**——语义不同：`pre_snapshot` = 主树回滚点（`git stash create`，**不含 untracked**）；`iso_base_snapshot` = 隔离树起点（**含 untracked** 的全量快照）。混用会把「回滚主树」和「隔离起点」两个正交概念耦合（RFC-092/098 的回滚仍读 `pre_snapshot`，但新模型下**失败节点不再写主树**，故顶层回滚基本退化，见 §11）。

## 4. 隔离树生命周期

### 4.1 全量快照原语（新增 `util/git.ts`）

`gitStashSnapshot`（git.ts:883）= `git stash create`，**不含 untracked** —— 不能直接当隔离起点（AC-2 要含 untracked）。新增：

```ts
// snapshotFullState: 用临时 index 把「HEAD + 所有已跟踪改动 + 所有 untracked」
// 写成一个 commit 对象，不触碰真 index / worktree / HEAD。pin 防 gc。
export async function snapshotFullState(
  worktreePath: string, opts?: { pinRef?: string; log?: Logger },
): Promise<string> {
  const idx = <tmp index path>
  await runGit(worktreePath, ['read-tree', 'HEAD'], { env: { GIT_INDEX_FILE: idx } })
  await runGit(worktreePath, ['add', '-A'],        { env: { GIT_INDEX_FILE: idx } }) // 含 untracked
  const tree = (await runGit(worktreePath, ['write-tree'], { env: { GIT_INDEX_FILE: idx } })).stdout.trim()
  const sha  = (await runGit(worktreePath, ['commit-tree', tree, '-p', 'HEAD', '-m', 'aw-snapshot'])).stdout.trim()
  if (opts?.pinRef) await runGit(worktreePath, ['update-ref', opts.pinRef, sha])
  return sha
}
```

> 与既有 `gitStashSnapshot` 并存（后者仍服务 RFC-092/098 主树回滚，语义不变、零改动）。

### 4.2 创建隔离树

- 路径：`{任务 worktree 容器}/iso/{node-run-id}`（单仓）；多仓 `.../iso/{node-run-id}/{worktreeDirName}`。写 `iso_worktree_path`。
- 命令：`git worktree add --detach <iso-path> <base-sha>`（复用 `createWorktree` 的 `overrideWorktreePath` 分支思路，git.ts:332；base 是全量快照 commit，detach）。base 的 former-untracked 文件在隔离树里表现为**已跟踪**（无碍：agent 不关心；diff/合并按 tree 算）。
- pin：`iso_base_snapshot` 同时 `update-ref refs/agent-workflow/iso/{taskId}/{nodeRunId}`，防 base commit 被 gc（照 `snapshotRefName` 惯例，git.ts:818）。

### 4.3 cwd 切换

`runNode` 的 `worktreePath`（`runner.ts:117`）与 `templateMeta.repos[].worktreePath`（:120-141）从主树改指**隔离树**。`{{__repo_path__}}` 等模板变量、agent 的 `git diff`、envelope 文件端口路径都自然落隔离树。

## 5. 合并回收（merge-back）

### 5.1 时机与锁

node run 成功（`result.kind==='ok'`）后，在 `runOneNode` 内、**释放 globalSem 之后**、返回之前，持 writeSem 执行（§7 锁序）。

### 5.2 三路合并机制

三个 tree（都经 §4.1 全量快照，含 untracked）：
- `base` = `iso_base_snapshot`（派发时主树）
- `ours` = `canon_tree` = 主树**现态**（可能被兄弟节点推进）
- `theirs` = `node_tree` = 隔离树终态

```
merged, conflicts = git merge-tree --write-tree --merge-base=<base> <ours(canon_tree)> <theirs(node_tree)>
```

`git merge-tree --write-tree`（git ≥ 2.38）**纯内存**产出合并树 OID + 冲突路径列表，**不触碰主树**。

- **无冲突** → 把 `merged` 落地进主树工作区（materialize，§5.3），主树得到并集改动（未提交，I-2）。
- **有冲突** → §6。

**git 版本门**：daemon 启动已探测 git 版本（`services/gitVersion.ts`）。本特性要求 git ≥ 2.38；低于则 daemon 启动拒绝（同「低于文档最低版本拒启」既有策略）。决策 D7。

### 5.3 materialize（把合并树落地为主树未提交改动）

```
git -C 主树 read-tree <merged>          // 更新 index 到合并树
git -C 主树 checkout-index -f -a         // 写工作区文件
git -C 主树 clean -fd -- <被 merged 删除但工作区残留的路径>   // 精确删，见下
```

- 主树 HEAD 不动 → `git diff HEAD`（= `gitDiffSnapshot` 从 base commit，git.ts:543）仍显示全部累积改动，含新增（former-untracked）。I-2 保持。
- **删除处理**：合并树里被删的文件需从工作区移除；用合并树与主树现态的 diff 精确 `rm`，不裸 `clean -fd`（避免误删无关 untracked）。
- former-untracked → 经 read-tree 变**已暂存**：仍属「未提交」（I-2 成立）；`gitDiffSnapshot`（比对 base commit ↔ 工作区）与 auto commit&push（`git add -A`）都不受影响。决策 D8 记此**良性偏移**。

### 5.4 干净快路径 & 空 delta

- **干净应用**：第一个完成的兄弟合并回收时 `ours == base`（主树自派发未动）→ merge-tree 必无冲突、materialize == 直接落 `theirs`。线性工作流恒走此路（AC-17 零回归）。
- **空 delta**：非写节点 `node_tree == base` → merged == ours → materialize no-op。删了 readonly 后「不写盘」节点靠此免真合并（仅付隔离树创建/销毁成本，§性能）。

## 6. 冲突 → 合并 agent → awaiting_human

### 6.1 内置合并 agent

新 `services/mergeAgent.ts`，仿 `buildCommitAgent`（commitPush.ts:29）：

```ts
export const MERGE_AGENT_NAME = 'aw-merge-resolver'
export function buildMergeAgent(): Agent {
  return { id: '__merge_agent__', name: MERGE_AGENT_NAME,
    description: 'Framework built-in: resolve git merge conflicts (RFC-130).',
    outputs: ['resolution'], syncOutputsOnIterate: true, permission: {},
    skills: [], dependsOn: [], mcp: [], plugins: [], frontmatterExtra: {},
    bodyMd: '<解冲突 system prompt：cwd 内文件带 <<<<<<< 冲突标记，逐个解、保留双方意图、输出无标记的完整文件>',
    schemaVersion: 1, createdAt: Date.now(), updatedAt: Date.now() }  // 无 readonly（已删）；runtime 由调度器解析冻结
}
```

- 运行时：`resolveInternalAgentRuntime(db, { runtimeName: opts.mergeAgentRuntime, deprecatedModel: opts.mergeAgentModel, defaultRuntime })`（runtimeRegistry.ts:204），配置字段 `mergeAgentRuntime`/`mergeAgentModel`（config.ts，仿 `commitPushRuntime`）。
- 派发：`runNode`，作为**子 node_run**（`parentNodeRunId = 冲突节点 run`，`cause='merge-resolve'`，keyed `merge:{nodeId}:{iter}`，仿 commit-push child，scheduler.ts:1074）。

### 6.2 流程（持 writeSem 全程，冲突罕见）

```
merge-tree 出冲突 conflicts[]：
  ① git worktree add --detach <resolve-iso> <merged(带冲突标记的合并树)>   // 解冲突工作区
  ② runNode(合并 agent, cwd=<resolve-iso>, 绕 globalSem〔§7 防死锁〕)
  ③ 成功判定 = resolve-iso 工作区无残留冲突标记（grep '^<<<<<<< ' / '^>>>>>>> ' / '^=======$'）
       且进程正常收尾
  ④ 判定通过 → resolved_tree = snapshotFullState(resolve-iso) → materialize(主树, resolved_tree)
     判定失败（残留标记 / 进程失败耗尽重试）→ §6.3
  ⑤ 弃 resolve-iso
```

- 全程持 writeSem：主树在解冲突期间**不被其他合并回收/快照插入**（merge-tree 是内存态，主树自始至终是 `ours`，故 resolved 可直接落主树）。代价 = 罕见冲突期间其他节点的**合并回收/新派发快照**排队（**运行中的 agent 不受影响**，它们不持锁）。决策 D5 记此延迟权衡 + 后续可拆「解冲突专用锁」精化。
- **合并 agent 绕 globalSem**（§7）：否则「我持 writeSem 等 globalSem，兄弟持 globalSem 等 writeSem」成环 → 死锁。合并 agent 罕见、框架内部，放行不计入 `globalSem`。

### 6.3 awaiting_human 兜底

合并 agent 也解不了：
- 把**带冲突标记的合并树** materialize 进主树（让人能在主树看到 `<<<<<<<` 冲突、手工解），`merge_state='conflict-human'`。
- 冲突节点 run → `park-human`（`nextNodeRunStatus` pending/running→`awaiting_human`，shared/lifecycle.ts:124）；任务 `trySetTaskStatus(running→awaiting_human)`（scheduler.ts:526）。
- **resume**（`resumeTask`→`resumeKick`，task.ts:1232）：人工已解（无残留标记）→ 从合并点继续（该节点 merge_state 置 `merged`、标 done、放行下游）；仍有标记 → 再次 awaiting_human。检测在 resume 的 scheduler 首 tick 做（读 `merge_state='conflict-human'` 的节点 → 校验主树无残留标记）。
- **框架自检、不依赖 agent 自报**：成功/失败判定一律由框架 grep 残留标记决定（合并 agent 只管产出，不发 clarify）。决策 D6。

## 7. writeSem 语义改写 + 锁序

### 7.1 改写

三处 `agent.readonly ? null : await writeSem.acquire()`（scheduler.ts:1960 单节点 / 4061 fanout shard / 4351 aggregator）**全删**。writeSem 不再罩 agent 运行，改为在 `runOneNode`（及 fanout/agg 对应体）内部**两段短持有**：
- 段①快照-派发：`writeSem.run(() => { base=snapshotFullState(主树); worktree add iso })`
- 段③合并回收：`writeSem.run(() => { merge-tree; materialize | 合并 agent })`

`releaseWrite` 不再是整函数生命周期，改为两个 `writeSem.run(...)` 短临界区（复用 `Semaphore.run`，见 scheduler.ts:4542/4588 既有用法）。

### 7.2 锁序与死锁分析（新写进 `taskWriteLocks.ts` 模块注释）

单节点一次运行的持锁时间线：
```
[writeSem 段①] → 释放 → [globalSem 段②] → 释放 → [writeSem 段③ (+合并 agent 绕 globalSem)] → 释放
```

- **writeSem 与 globalSem 从不同时持有**（段①释放后才取 globalSem；段②释放 globalSem 后才取段③ writeSem）——唯一例外是段③冲突时合并 agent 需一个「跑 opencode」的额度。
- **合并 agent 绕 globalSem** → 段③持 writeSem 期间不等 globalSem → 不与「持 globalSem 等 writeSem 的兄弟」成环。**无 writeSem↔globalSem 环**。
- 与既有 **question-write 锁（B）**（taskWriteLocks.ts:36）关系：本 RFC 只动主写锁 A（`getTaskWriteSem`），B 不碰；既有「A ≻ B、仅 submit 内嵌套」不变。
- `subprocessSem`（fanout）：段②内取（fanout shard），与 writeSem 同样「不与段③ writeSem 同持」。

### 7.3 并发模型结果

`globalSem`（默认 `maxConcurrentNodes=4`）成为**真并行上限**（对所有节点，不再区分读写）。writeSem 退化为「主树读写的短临界区串行器」。不新增用户配置（沿用 `maxConcurrentNodes`，proposal 非目标）。

## 8. wrapper 交互（AC-10/11/12）

### 8.1 wrapper-git

- pre/post 快照仍取**主树**（`runGitWrapperNode`，scheduler.ts:4588/4675，在 writeSem.run 内），`git_diff` = post−pre。
- 内部节点各自隔离 + 合并回主树；wrapper 内所有内部节点完成后（`runScope` await 全部），所有合并回收已落主树 → post 快照含内部改动**全集** → `git_diff` 与串行等价（I-4/AC-10）。
- pre 必须在任一内部节点段①快照之前取（内部节点 base ⊇ wrapper pre）；post 在全部合并回收后取。二者都在 writeSem 上，与内部合并回收互斥 → 一致。

### 8.2 wrapper-loop

- 每迭代进入内部 scope，内部节点隔离 + 合并进主树；跨迭代状态经主树文件（v1 无跨迭代反馈端口，proposal 模型不变）。
- `git in loop`（git 在 loop 内）= 每迭代取一次 pre/post，末迭代 diff 为输出；`loop in git` = loop 外 git 取一次 pre、全循环后 post = 全循环总 diff。隔离不改这两个取点，只把内部写从「串行落主树」换成「并行落隔离树→串行合并回主树」，净累积一致（AC-11）。

### 8.3 wrapper-fanout（最高风险子案）

- 可写 shard（`dispatchFanoutShard`，scheduler.ts:4056）各自隔离树并行跑（受 `subprocessSem`）；合并回主树串行（writeSem）。不同 shard 通常改不同文件（per-file/per-dir 分片）→ 合并干净；同文件重叠 → 走 §6。
- **value-hash replay**（RFC-098 B3，scheduler.ts:3906）：replay 的 shard 不 spawn、不建隔离树、不合并回收——其上次改动已在主树（上次 run 的合并回收落过）。replay 复用旧 node_run，天然跳过段①③。
- **shard rerun（value 变）**：新 run 隔离 base = 主树现态（含**本 shard 上次**已落改动）；合并回收 delta = 新态 vs base。**风险**：上次 shard 改动仍在主树、rerun 又叠新改动 = 语义应「替换本 shard 贡献」而非叠加。v1 处理：rerun 前对**本 shard 上次改动**做定向撤销（读上次 run 的 delta 反向 apply）后再建隔离 base——**此子案单独硬化 + 测试锁**（plan T-fanout）。决策 D9 标为最高风险、最后交付、加 shard-rerun 等价性回归测试。
- aggregator（scheduler.ts:4347）同单节点：隔离 + 合并。

## 9. 多仓（RFC-066，AC-13）

- 隔离**逐仓**：一个 node run 为它涉及的每个仓建一个隔离子树（`iso_worktree_path` 容器下按 `worktreeDirName`），base 快照逐仓（`iso_base_snapshot_repos_json`）。
- 合并回收逐仓独立（一仓冲突走 §6、不影响他仓的干净合并）。
- 复用既有多仓 `state.repos` 线程（scheduler.ts:304-335）与多仓 pre-snapshot 惯例（:2188-2217）的结构。

## 10. 失败 / 重试 / resume / 恢复

### 10.1 失败零污染（I-5，比现状更干净）

合并回收**只在成功后**发生 → 失败 / canceled 的 node run **从不写主树**。于是：
- 顶层单节点重试：**弃失败隔离树**（`removeWorktree` + 删 pin ref）→ 段①从**当前主树**重新快照分叉新隔离树。**无需回滚主树**（主树没被污染）。RFC-092/098 的「rollback 主树到 pre_snapshot」在新模型下对**已隔离节点**退化为 no-op（主树本就干净）。
- `pre_snapshot` 回滚路径（nodeRollback.ts、task.ts resume）**保留但基本空转**（防御：万一有非隔离写入路径）；`rollbackNodeRunWorktrees`（nodeRollback.ts:76）签名不改。决策 D10：保留回滚代码作纵深防御，不删。

### 10.2 resume（`resumeKick`，task.ts:1304）

- 选重跑目标 `selectResumeRollbackTargets`（task.ts:443，最新 failed/interrupted）不变。
- 新增：resume 首 tick 清理**孤立隔离树**（`iso_worktree_path` 非空但 run 非 running 的行 → `removeWorktree`）+ 处理 `merge_state='conflict-human'`（§6.3）。
- preflight（RFC-108 T6，`worktreePreflight`）：新模型下 pre_snapshot 多为空，preflight 基本放行；隔离 base pin ref 若被 gc（罕见）→ 该 run 重跑从当前主树重新分叉，不 fail-closed（区别于 pre_snapshot 丢失的 `snapshot-lost` 升级：隔离 base 丢失不致命，因主树未依赖它回滚）。决策 D11。

### 10.3 daemon 重启（interrupted）

孤立隔离树由 §10.2 resume 清理 + §12 GC 兜底。`node_runs.iso_worktree_path` 是清理索引。

## 11. auto commit&push（RFC-075，特殊路径不变）

`maybeRunCommitPush`（scheduler.ts:1017）是 `commitpush:` 合成路径，**直接在主树**上 `git status`/`git add -A`/commit/push、自持 writeSem（:1161）。它**不走**隔离/合并回收（它要提交的正是主树累积的全部改动）。改动仅：`buildCommitAgent`（commitPush.ts:29）去 `readonly:true` 字段（随 §3.1 schema 删列）。commit agent 的 child run 逻辑不变。

## 12. GC（隔离树清理，`services/gc.ts`）

- 既有 `runWorktreeGc`（gc.ts:36）清终态任务的主树 + `deleteSnapshotRefs`。
- 新增：扫 `node_runs.iso_worktree_path` 非空的孤立隔离树（run 终态 / 任务终态）→ `removeWorktree` + 删 `refs/agent-workflow/iso/{taskId}/*`。运行期正常路径段③已即时弃，GC 是兜底（崩溃/重启残留）。
- 复用既有每小时 ticker（gc.ts:114）。

## 13. readonly 删除全清单（AC-15）

| 层 | 文件:行 | 动作 |
|---|---|---|
| DB | schema.ts:27 + migration | 删 `agents.readonly` 列 |
| schema | shared/schemas/agent.ts:98,165；shared/inventory.ts:44,138 | 删字段 + normalizer |
| 调度 | scheduler.ts:1960,4061,4351 | 删写锁三元（改 §7 短临界） |
| 调度 | scheduler.ts:2049,2164 | 回滚/pre-snapshot 的 `!agent.readonly` 门 → 见 §10.1（改为「隔离节点恒不回滚主树」） |
| runner | runner.ts:848,1691 | 删注入 `options.readonly` |
| claude | runtime/claudeCode/spawn.ts:60,87 | 删 `CLAUDE_READONLY_DISALLOWED_TOOLS` + 门禁（软沙箱能力消失，proposal 已声明） |
| 内置 | commitPush.ts:36 | 删 `readonly:true`（随 schema） |
| transcoder | opencode-plugin/transcoder.ts:48 | 删 readonly 派生（改恒 false/删分支） |
| 前端 | AgentForm.tsx:35,180；DependencyTree.tsx:125；DependencyTreePreview/NodeDependencyTreeSection | 删开关 + chip |
| i18n | en-US.ts:1696；zh-CN.ts:4126 | 删 `fieldReadonly*`；`dependencyTree.readonly/writes` |
| 测试 | reviews-detail-readonly-source / dependency-tree-build / agent-import-merge 等 | 更新（去 readonly 断言） |

## 14. 失败模式

| 场景 | 处理 |
|---|---|
| 隔离树 `worktree add` 失败（磁盘满/路径冲突） | node run fail，错误 `iso-worktree-add-failed`；不污染主树 |
| base pin ref 被 gc（隔离运行超长 + 激进 gc） | 合并回收时 `gitCommitExists(base)` 假 → 回退：以主树现态为 base 直接应用隔离 delta（退化为二路，风险自担并告警）或 fail node（决策 D11 取告警+二路） |
| merge-tree git<2.38 | daemon 启动即拒（§5.2 版本门） |
| 合并 agent 输出仍带标记 | §6.3 awaiting_human |
| materialize 中途崩溃 | 主树可能半写；resume 首 tick 检测 `merge_state='conflict-resolving'` 的 run → 重做合并回收（幂等：从 iso/主树重算 merge-tree） |
| 多仓一仓合并 agent 失败 | 整任务 awaiting_human（保守；不做部分推进） |

## 15. 测试策略（每改动带测试，见 plan 验收清单）

- **纯 oracle（首选可断言面）**：抽 `mergeBackPlan(base,ours,theirs) → {clean|conflict, paths}` 的纯包装（薄封装 git，或对 fixture 仓做真 git 断言）；`isolationNeeded(node)` 恒 true 的锁；`residualConflictMarkers(text)` 纯函数（grep 标记）。
- **集成（真 git fixture 仓）**：
  - 两并发写节点改不同文件 → 主树含并集、无冲突（AC-5）。
  - 改同文件不重叠 hunk → 自动并（AC-5）。
  - 改同一行 → 合并 agent（mock 成功）→ 主树解（AC-7）；mock 失败 → awaiting_human（AC-8）。
  - 失败节点零污染主树（AC-6）。
  - wrapper-git 并行 vs 串行 `git_diff` 等价（AC-10）。
  - fanout shard 并行 + shard-rerun 等价性（AC-12 + §8.3 D9）。
  - 多仓逐仓隔离/冲突隔离（AC-13）。
  - 单节点重试从当前主树重分叉（AC-14）；resume 清孤立隔离树。
- **并发窗口断言**：两节点运行时间窗重叠（AC-1）——用 mock runNode 记录 start/end 时间戳断言 overlap（现有 `scheduler-boundary-*` 测试有 mock runNode 惯例）。
- **源码文本锁（兜底）**：`scheduler.ts` 不再出现 `agent.readonly`；`writeSem.acquire()` 不再罩整个 runNode（锁「段①段③ 两短临界」形态）。
- **回归**：线性工作流最终产物逐字等价（AC-17）；readonly grep 全清（AC-15）。

## 16. 决策记录

- **D1** 隔离粒度 = per-node-run（每重试/rerun 独立隔离树），对齐 node_runs。
- **D2** 隔离起点 = **全量快照（含 untracked）**，新增 `snapshotFullState`（临时 index），不复用 `gitStashSnapshot`（后者漏 untracked）。
- **D3** 合并机制 = `git merge-tree --write-tree`（内存三路、主树永不半合并），materialize=read-tree+checkout-index，保「未提交」模型。
- **D4** 合并回收在**释放 globalSem 之后**、持 writeSem 的短临界区做。
- **D5** 冲突解全程持 writeSem（罕见），换主树一致性 + 免优化 lock；后续可拆解冲突专用锁。
- **D6** 合并成功/失败由框架 grep 残留标记判定，不依赖合并 agent 自报（不发 clarify）。
- **D7** 要求 git ≥ 2.38（merge-tree --write-tree），daemon 启动版本门。
- **D8** former-untracked 经合并回收变已暂存 = 良性（仍「未提交」，diff/commit&push 不受影响）。
- **D9** fanout shard-rerun 等价性是最高风险子案，末位交付 + 定向撤销上次 shard delta + 专项回归。
- **D10** 保留 RFC-092/098 主树回滚代码作纵深防御（新模型下对隔离节点空转），不删。
- **D11** 隔离 base pin 丢失不致命（主树不依赖它回滚）：告警 + 退化二路应用；区别于 pre_snapshot 丢失的 `snapshot-lost` 升级。
- **D12** 合并 agent 绕 `globalSem`（防 writeSem↔globalSem 死锁）。
- **D13** readonly 彻底删（含 claude 软沙箱），旧 `readonly:` 键降级进 frontmatterExtra。

## 17. 性能与后续

- **成本**：每 node run 一次 `worktree add`（checkout）+ 两次全量快照 + 一次 merge-tree。大仓 / 高扇出（如 50 shard）成本显著。
- **v1 取正确性优先，一律隔离**。后续优化（不在本 RFC）：
  - **免隔离快路径**：按 agent permission 证明「不写盘」（edit=deny ∧ bash=deny）→ 免建隔离树、共享只读快照视图（**不复活 readonly 手填标记**，纯 permission 自动推导、对用户不可见）。
  - 隔离树 checkout 用 `--no-checkout` + 按需 sparse。
  - base 快照对「主树自上次快照未变」复用同一 sha。
