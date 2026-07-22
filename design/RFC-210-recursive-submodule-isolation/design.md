# RFC-210 技术设计：递归 submodule 隔离与自动同步

> **v2** —— 三路对抗设计门（Codex 撞配额，改跑正确性 / 回归 / 前端契约三路自审）折入 **7 P0 + 约 20 条 P1/P2**。
> v1 的三条核心断言被实测证伪，见 §0.2。**接手前必读 §0.2 与 §0.3。**
>
> 所有 git 行为断言均在 **git 2.50.1 (Apple Git-155)** 上用一次性 fixture 实测。
> 脚本：`scratchpad/verify-rfc210{,b,c}.sh`（v1）、`verify-fixes.sh`（P0 解法）、`verify-subsnap.sh`（子仓快照）、审计方 `adv{1..8}.sh`。

## 0. 地基：实测事实与被证伪的断言

### 0.1 成立的事实

| # | 断言 | 证据 |
|---|---|---|
| F1 | linked worktree 的 submodule gitdir = `<repo>/.git/worktrees/<wt>/modules/<sub>`，**独立 objects、无 alternates** | V1：父仓与 iso 各占 12 KB |
| F3 | `git -C <pool> fetch <iso-module-dir> <sha>` 可回写；**本地路径 fetch 非 tip 的历史 sha 也成功** | V4 + 审计 C1/C2/C3 |
| F4 | alternates 建立后，回写池即对所有挂池 worktree 生效，无需逐个 fetch | W2 |
| F5 | 父仓层 `merge-tree` **不递归** submodule；两边都动 gitlink ⟹ `exit=1` + `only supports trivial cases` | W4① |
| F6 | **子仓层**独立跑 `merge-tree` 可自动三路合并 | W4②：`l1-A / l2 / l3-B` |
| F7 | 一边动 gitlink、一边不动 ⟹ 父仓层直接成功，取动的那边 | V5 |
| F8 | gitlink 的显式 checkout **必须在 `submodule update` 之后**（`update` 按 index 走，`reset --mixed` 已把 index gitlink 退回 base） | §3.1 对照表 |
| F9 | 父仓 `ls-files --others --exclude-standard` **永不**列出子仓内的文件 | 审计复测 |
| F11 | **显式写 `objects/info/alternates` 文件对已初始化的 module dir 有效** | X1：池独有对象 `cat-file -t` 命中，父仓 status 正常，fsck 仅 dangling |
| F12 | **双 parent `commit-tree -p <ours> -p <theirs>` 让父仓层 merge-tree 变 trivial** | X3：单 parent `exit=1`，双 parent `exit=0` |
| F13 | 池里建**永久 ref** 可让对象扛住 gc；`update-ref -d` 后再 gc 即消失 | 审计 H3 |
| F14 | 子仓 `snapshotFullState` 同款机制捕获 HEAD+tracked+**untracked**，不碰真 index/HEAD | Y1 |
| F15 | 子仓回滚可撤销平台 commit + 恢复工作区 + 恢复 untracked | Y2：log 3→2，`?? untracked.txt` 复原 |
| F16 | 嵌套层回滚会让**父层 gitlink 变脏**（` M nested`）⟹ 必须自底向上后再修父层 | Y3 |
| F17 | **已 push 的子仓 commit 撤不回**（本地回滚管不到远端） | Y4 |
| F18 | `git worktree remove --force` 会**连 `.git/worktrees/<wt>/modules/<sub>` 一起删** | 审计 A5 |
| F19 | git ≥2.38 按**解析后的传输协议**判定，**相对路径一样被拒**（`fatal: transport 'file' not allowed`） | 审计实测 |

### 0.2 v1 被证伪的三条断言（P0，接手必读）

| v1 断言 | 真相 | 证据 |
|---|---|---|
| 「`submodule update --init --reference <pool>` 建立 alternates」**无条件成立** | **不可依赖，且跨 git 版本不一致**。对**已初始化**的 module dir：git 2.50.1 (Apple Git-155) 是**静默 no-op**（alternates 不出现，exit 0）；CI runner 的 git 则**会**挂上。两种情况都 exit 0，调用方无从分辨。v1 只测了全新 iso 就写成通则 | X1 本机复现 no-op；CI run `29738347309` 两个 OS 上 `existsSync(alternates)` 均为 true（我按本机行为写死断言，被 CI 打红） |
| 「合并结果写进父仓 theirs tree ⟹ 父仓层变 trivial」 | **错**。真正的不变量是 merged sub-commit **必须以 `ours` 为祖先**（与 parent 个数/顺序无关，见 §2.3 的 v3 更正）；现有 `commitTree()`（`util/git.ts:1978`）只接受一个 parent，默认写法（`-p theirs`）100% 退回 `exit=1` | X3 + 二轮审计四组对照 |
| 「`pushObjectsToPool` 回写后对象安全」 | **错**。`git fetch <dir> <sha>` **只写 FETCH_HEAD、不建 ref**，对象在池里**恒不可达**；**默认 `gc`**（两周宽限期，长期 worktree 必然跨过）就会删。删后 canonical 子仓 `bad object HEAD` ⟹ **父仓 `git status` 整体失败** ⟹ `snapshotFullState` 的 `add -A` 崩 ⟹ 全线崩 | 审计 A2/E3/H3 |

### 0.3 v1 未察觉的既有事实（改变设计方向）

| 事实 | 影响 |
|---|---|
| **`pre_snapshot` 机制在 iso 模型下已是死代码**。RFC-130 删除了写入点（`scheduler.ts:3081-3086` 注释："the pre-snapshot … is GONE — the iso model never writes the canonical worktree, so there is nothing to roll back"）；全仓 `gitStashSnapshot` **零调用**，列恒 NULL | §6 的子仓回滚**不得**复活该机制，必须按 iso 模型自己的形状设计 |
| iso 重试语义 = **丢弃 iso + 从当前 canonical 重新分叉**，canonical 从不回滚（`scheduler.ts:2977-2990`, I-5） | iso 内的子仓改动随 iso 丢弃**自然消失**（F18），零成本，无需回滚机制 |
| `rebuildIsoHandle`（`nodeIsolation.ts:210-242`）**没有任何 submodule 字段**，四个调用点（`scheduler.ts:2239/2319/5698/5720`）v1 一个都没列 | crash replay 必须新增子仓通道，否则 replay 静默覆盖（§2.5） |
| `completeHumanResolvedConflict` 只认容器根下的 `resolve-{worktreeDirName\|'repo'}`（`nodeIsolation.ts:705-706`），子仓 resolve-iso 对它不可见 ⟹ 走 `:726-747` 的"无 resolve-iso 就重探"分支 ⟹ 父仓层探测 clean ⟹ **把未解决的 gitlink 当已解决落地** | §4 必须新增子仓 resume 通道（比卡死更糟：错误放行） |
| `COMMIT_PUSH_OUTCOME`（`shared/schemas/task.ts:824-834`）是 zod 枚举，`parseCommitPushJson` 失败即 `commitPush=null`，而 schema 注释明写"non-null 才算 commit 行" | 新 outcome **必须**同步枚举，否则整行 commit-push 从 UI 消失（§12.1） |
| `commitOutcomeKey`（`tasks.detail.tsx:1597-1609`）有 `default:` 兜底 ⟹ typecheck 抓不到新 outcome，会被翻译成"跳过（无变更）" | 主动误导，必须改 switch（§12.1） |
| `materializeTree` 有 **6 个**调用点（`nodeIsolation.ts:386/407/483/647/741/789`），全部**不传** `submoduleMode/Jobs`；`createIsoUnderLock`（`isolatedAgentRun.ts:49-74`）也不传；`mergeBackNodeIso` 签名无配置位 | §10 的配置接线要补 4 层管道，否则 AC-11 达不成 |
| `undoPriorShardDeltaInIso`（`nodeIsolation.ts:441-489`）契约是 **FAIL-OPEN、never destructive**，也调 `materializeTree` | §3 的 fail-loud 会破坏该契约（§3.3） |
| `git submodule status --recursive` 打印的是**工作区 HEAD** 且 `+` 标记与 index 不一致；未初始化子仓**不被 `--recursive` 展开**；路径可含空格 | §1.2 `listSubmodules` 的契约要写清（§1.2） |
| 今天无子仓的仓在 `createNodeIso` 里 spawn **零个** submodule 进程（`existsSync('.gitmodules')` 纯 FS 探针） | §2.1/§5.1 的无条件 `submodule status` 会 +1 进程/节点/仓，AC-12 达不成 ⟹ 必须 `existsSync` 门控（§0.4） |

### 0.4 全局性能门（贯穿全文）

**所有** submodule 相关逻辑的第一道门恒为 `detectSubmodules(path)`（`existsSync('.gitmodules')`，纯 FS，零进程）。
只有它为 true 才允许 spawn 任何 `git submodule *`。这保证 AC-12（无子仓的仓字节级一致、零额外进程）。
`hasDirtySubmoduleContent`（`util/git.ts:1690`）现在无条件跑两条 git，**必须**加同一道门（否则 AC-11 也达不成）。

---

## 1. 共享对象池（G1）

### 1.1 拓扑与生命周期

```
<cache-repo>/.git/modules/<sub>/objects                       ← 共享对象池
  refs/agent-workflow/pool/<taskId>/<nodeRunId>/<subSlug>     ← 节点级瞬时锚
  refs/agent-workflow/wt/<taskId>/<subSlug>                   ← worktree 级长期锚
        ▲ alternates      ▲ alternates      ▲ alternates
 canonical worktree    iso(node A)       iso(node B)
```

**保活 ref 是本节的核心**，不是可选优化：没有它，池的 gc 会删掉 canonical 正在引用的 commit（§0.2 第三条）。

### 1.1.1 ref 名必须 slug 化（v3，二轮审计 P0）

**禁止把 `subPath` 原样拼进 refname**，两个实测的硬失败：

```
update-ref refs/…/TASK1/vendor        → ok
update-ref refs/…/TASK1/vendor/inner  → fatal: 'refs/…/TASK1/vendor' exists;
                                         cannot create '…/vendor/inner'   (exit 128)
update-ref 'refs/…/TASK3/my sub'      → fatal: refusing to update ref with bad name (exit 128)
```

第一条是**任意 ≥2 层嵌套**（G3/AC-4 的核心用例）必中的 D/F 冲突；第二条命中本文档自己承认的"路径可含空格"（§1.2）。
`.lock` 结尾、`~ ^ : ? * [ \`、以 `.` 开头的段同理。

**`subSlug = sha1Hex(subPath).slice(0, 16)`**（不可逆、定长、必过 `check-ref-format`）。
路径原文存在 `iso_submodules_json` 里，ref 只作锚点不作索引。
`update-ref` 失败**不得**降级为 warning——那正是 §0.2 第三条要防的静默失锚。

### 1.1.2 两级 ref 与生命周期（v3）

v2 把 ref 键控成 `(taskId, subPath)` 且"任务终态即删"，二轮审计指出三处致命：
① 同任务两节点改同一子仓时后者**覆盖**前者的锚；
② `discardNodeIso` 是 **node 级**的（`nodeIsolation.ts:522`），任一节点结束就会删掉共用 ref；
③ `worktreeAutoGc` 默认 **false**（`shared/schemas/config.ts:369`），canonical worktree 长期留存——
而本 RFC 的卖点正是让用户在 canonical 里 review 那条未暂存的 gitlink；合并结果是 `commit-tree` 造的
**游离 commit**（`git branch --contains` 为空），任务一终态就删锚 ⟹ 两周后 `bad object HEAD`。

| ref | 键 | 建立 | 删除 |
|---|---|---|---|
| `pool/<taskId>/<nodeRunId>/<subSlug>` | 带 nodeRunId，与 `isoRefName`（`util/git.ts:1662`）同粒度 | 每次 `pushObjectsToPool` | `discardNodeIso`（节点级，安全） |
| `wt/<taskId>/<subSlug>` | 与**引用它的 worktree** 同寿命 | merge-back 推进 gitlink 后 | **worktree 被删时**（GC 删 worktree / 任务 workspace prune），**不是**任务终态 |

> **不要**依赖 FETCH_HEAD：`git fetch <dir> <sha>` 不建 ref，对象恒不可达。
> **path 模式**（§1.3 降级）同样要建 `wt/` 锚——回写目标换成 worktree 私有 module dir，gc 风险一模一样（v2 漏）。

### 1.2 接口

```ts
// services/gitSubmodule.ts —— 新增

export interface SubmoduleEntry {
  /** 相对超级项目根的完整路径，嵌套用 '/' 连接，如 'vendor/inner'。可含空格。 */
  path: string
  /** 该子仓**工作区 HEAD**（注意：不是 index 里的 gitlink，两者在节点动过子仓后必然不同）。 */
  headSha: string
  /** `git submodule status` 的状态标记：' ' 同步 / '+' 与 index 不一致 / '-' 未初始化 / 'U' 冲突。 */
  flag: ' ' | '+' | '-' | 'U'
  /** 路径分段数（`path.split('/').length`）。**仅用于自底向上排序，不是"嵌套层级"** —— */
  /** `vendor/libs/foo` 可能是一级 submodule 但分段数为 3。禁止用它判断"是否顶层"。 */
  pathDepth: number
}

/**
 * 递归列出工作树里的全部 submodule。
 * 实现：`git submodule status --recursive`，逐行解析 `<flag><sha> <path>[ (<desc>)]`。
 * 契约：
 *  - **未初始化（flag='-'）的子仓不会被 --recursive 展开**，其嵌套层不可见 → 返回值只到该层为止。
 *  - 路径可含空格；解析取「首字符=flag，随后 40/64 hex = sha，其余到 ` (` 或行尾 = path」。
 *  - 调用前必须先过 detectSubmodules 门（§0.4）；本函数不自带该门以便复用。
 * 永不 throw；非零退出/空输出 ⟹ []。
 */
export async function listSubmodules(worktreePath: string, opts?: {...}): Promise<SubmoduleEntry[]>

/**
 * 确保某 worktree 的某个 submodule 挂上池：
 *  ① `submodule update --init [--reference <pool>]`（首次 init 时 --reference 生效）
 *  ② **无条件**显式写 `<module-dir>/objects/info/alternates`（F11）—— 覆盖已初始化的情形
 * 幂等；已正确指向则不重写。池不可用（path 模式 / 非 worktree）⟹ 返回 ok:false，调用方降级。
 */
export async function ensureSubmoduleAlternates(
  worktreePath: string, subPath: string, poolDir: string,
): Promise<{ ok: boolean; error: string | null }>

/**
 * 回写对象到池 **并建保活 ref**（两步不可分割，见 §1.1）。
 */
export async function pushObjectsToPool(
  poolDir: string, fromGitDir: string, sha: string, keepRef: string,
): Promise<{ ok: boolean; error: string | null }>
```

> **P1 修正**：v1 的 `syncSubmodules` 只 push **一个** `--reference`，而 git 会把它套用到**每一个** submodule（审计 G1 实测：不相干的 `two` 被绑上 `one` 的池），造成交叉污染。
> 因此 `--reference` **仅**作为首次 init 的加速手段，**正确性由 `ensureSubmoduleAlternates` 逐子仓保证**。

### 1.3 池的定位与 path 模式降级

```ts
/**
 * `git -C <worktree> rev-parse --path-format=absolute --git-common-dir` 得到宿主 .git，
 * 池 = 在**该宿主仓**里对同名子路径解析出的 module dir（不自行拼 modules/x/modules/y，避免布局假设漂移）。
 * 返回 null 的情形：非 git worktree（mock harness）／**path 模式仓**（见下）。
 */
export async function resolveSubmodulePool(worktreePath: string, subPath: string): Promise<string | null>
```

**path 模式（用户本机绝对路径仓）一律不建池**（D11）：宿主是用户自己的仓，池就是用户真实的 `.git/modules/<sub>`，
平台的对象、保活 ref、内部 commit 全会落进去且清不掉。降级为**每 worktree 私有 module dir**（今天的行为），
merge-back 时把对象 fetch 到**目标 worktree 自己的 module dir**（`<repo>/.git/worktrees/<task>/modules/<sub>`），
随该 worktree 删除一并消失。代价是每 worktree 重 clone 一次子仓，只影响本地路径仓。

### 1.4 调用点（含 v1 遗漏的 6 处）

| 点位 | 文件 |
|---|---|
| canonical worktree 创建后 | `util/git.ts:747`（`createWorktree`） |
| iso worktree 创建后 | `util/git.ts:1824`（`createIsolatedWorktree`） |
| **materializeTree 的全部 6 个调用点** | `nodeIsolation.ts:386`(salvage) / `:407`(clean) / `:483`(shard undo) / `:647`(merge agent) / `:741`+`:789`(human resume) |
| wrapper 私有 canonical | `scheduler.ts:5731-5738`（与内层 iso 同池，审计已验证 `--git-common-dir` 对三者返回同一 .git） |

### 1.5 ref 与目录的清理（v1 漏项）

`deleteIsoRefs`（`util/git.ts:2072`）写死 `['base','node']` 两个 ref 且作用在**父仓**，够不到池里的子仓 ref。
且 `runIsoWorktreeGc`（`services/gc.ts:327`）**不调用** `deleteIsoRefs`，`isoRefGlob`（`util/git.ts:1667`）是**死代码**。

本 RFC：
- `deleteIsoRefs` 增 `poolRefs?: Array<{poolDir, ref}>` 参数，由 `discardNodeIso` 从 `iso_submodules_json` 读出路径集后传入。
- **兜底**：`runIsoWorktreeGc` 对终态任务追加一次按前缀的批量删除
  （`git -C <pool> for-each-ref --format='%(refname)' refs/agent-workflow/pool/<taskId>` → `update-ref -d`），
  并顺带激活 `isoRefGlob` 做父仓侧同类清理。没有这一条，池 ref 会随任务数无界增长（池是**跨任务共享**的）。

---

## 2. 递归隔离（G3）

### 2.1 iso 创建：记录每层 base

`createNodeIso`（`nodeIsolation.ts:119-207`）在 `snapshotFullState` 之后，**先过 §0.4 的 `detectSubmodules` 门**，再：

```ts
const subs = await listSubmodules(r.isoWorktreePath)          // 门后才跑
const subBases: Record<string, string> = {}
for (const s of subs) subBases[s.path] = s.headSha
```

`subs` 为空 ⟹ 后续全部短路。结果由 `isolatedAgentRun.persistIsoBase`（`isolatedAgentRun.ts:83-115`）写入——
**不能**在 `nodeIsolation` 里写，该模块契约是"git-only、不查 DB"（`nodeIsolation.ts:127`）。

### 2.1.1 持久化形状（v3，二轮审计 P0）

v2 只说"写 `node_runs.iso_submodules_json`"，**三处错**：

1. **必须是 single/multi 双列**，与既有 iso 列同制——`db/schema.ts:1170-1174` 是
   `isoBaseSnapshot`/`isoBaseSnapshotReposJson`、`isoNodeTree`/`isoNodeTreeReposJson`，
   `persistIsoBase`（`isolatedAgentRun.ts:97-115`）按 `repoCount===1` 分叉写，`scheduler.ts` 读回时同样分叉。
   v2 的扁平 `Record<path, sha>` 在多仓任务里两个仓各有 `vendor` 时**后写覆盖先写**，且 AC-17 的
   fail-closed 读回拿不回仓维度。⟹ 列为 `iso_submodules_json` / `iso_submodules_repos_json`。
2. **必须有 zod schema**（v2 三处分散描述 `subBases` / `poolDir` / `pendingSubResolves`，无单一契约）。
   对照 `COMMIT_PUSH_OUTCOME` 那条"不上 wire 就整行消失"的教训，这里同样需要一个可 parse-fail 的 schema：

```ts
export const IsoSubmodulesSchema = z.object({
  poolDir: z.string().nullable(),                      // null = path 模式降级（§1.3）
  subBases: z.record(z.string(), z.string()),          // subPath → base commit
  subSnapshots: z.record(z.string(), z.object({        // §6 的快照锚，v3 新增
    head: z.string(), snapshot: z.string(), pinRef: z.string(),
  })).optional(),
  pendingSubResolves: z.array(z.string()).optional(),  // §4.1，merge-back 时才写
})
```
3. **`pendingSubResolves` 的写入方要指派**：它在 iso 创建时不可知（冲突集合只有 merge-back 才知道）。
   ⟹ 由 `isolatedAgentRun` 在 merge-back 阶段做一次**增量更新**（与 `persistIsoNodeTree` 同处），
   `nodeIsolation` 只返回集合、不落库。

### 2.1.2 passthrough 的交叉情形（v3）

`persistIsoBase` 在 `passthrough=true`（canonical 不是 git 仓）时**整行不写**（`isolatedAgentRun.ts:107`），
列恒 NULL。而 AC-17 规定"列缺失 + 仓有 `.gitmodules` ⟹ fail-closed 拒绝 replay"。
**两者交叉时以 passthrough 优先**：passthrough 的 canonical 压根不是 git 工作树，不存在子仓，
fail-closed 判据必须先查 `passthrough` 标志再查 `.gitmodules`。

### 2.2 节点跑完、快照前：无条件回写 + 自动提交

替换 RFC-130 D22 的 fail-loud（`nodeIsolation.ts:264-275`）：

```
for each submodule (pathDepth 降序):
  ① 若脏 → git -C <sub> add -A && commit（AW_INTERNAL_GIT_IDENTITY）
  ② **无条件** pushObjectsToPool(pool, subGitDir, <当前 HEAD>, keepRef)
```

> **P1 修正（关键）**：v1 只对"脏"子仓回写。但 agent 完全可能**自己**在子仓 commit（今天 D22 的报错文案
> `nodeIsolation.ts:272` 正是在教它这么做）——此时子仓**干净**，v1 逻辑不回写，而 `discardNodeIso` 的
> `worktree remove --force` 会**连 module dir 一起删**（F18），对象彻底消失、无从补救。
> 故②必须无条件、且必须在 iso 被丢弃**之前**。

### 2.3 merge-back：自底向上递归三路合并

```
for each submodule (pathDepth 降序):
  base   = subBases[path]            （缺失 ⟹ 见 §2.4 的新增/删除分支，不得直接进冲突路径）
  ours   = canonical 该子仓 HEAD
  theirs = iso 该子仓 HEAD
  ├ 三者相等                    ⟹ 跳过
  ├ ours == base                ⟹ 快进到 theirs
  ├ theirs == base              ⟹ 保持 ours
  └ 三者互异                    ⟹ git -C <pool> merge-tree --write-tree --merge-base=<base> <ours> <theirs>
       ├ exit 0  ⟹ commit-tree 出合并 commit：
       │            git -C <pool> commit-tree <mergedTree> -p <ours> -p <theirs> -m 'aw-sub-merge'
       │            回写池 + 更新保活 ref，然后把该 path 的 gitlink 写进父层 theirs tree
       ├ exit 1  ⟹ 真冲突，走 §4
       └ exit >1 ⟹ **致命错误**（如 base 对象不存在 ⟹ `fatal: unable to read tree`），
                    不得当作"冲突"去开 resolve-iso 对一个不存在的状态跑 merge agent
```

> **★ 真正的不变量（v3 更正）**：父仓层能否 trivial 合并，唯一条件是 **`ours` 必须是 merged sub-commit 的祖先**——
> 与 parent 个数、顺序**无关**。二轮审计实测四组：`-p theirs` 单 parent ⟹ **exit 1**；`-p ours` 单 parent ⟹ exit 0；
> `-p ours -p theirs` ⟹ exit 0；`-p theirs -p ours` ⟹ exit 0。
> v2 写的"单 parent（或 theirs 在前）会让父仓层退回 exit=1"是**错误断言**，据此写的
> "单 parent 必 exit=1 的防回归测试"会锁一条**假不变量**（实现者若用 `-p ours` 单 parent，测试反而红）。
> **仍然采用双 parent**，但理由是「保住 theirs 可达、子仓历史不丢」，不是"否则合不了"。
> AC-16 的断言必须写成「**ours 可达性**」：`git -C <pool> merge-base --is-ancestor <ours> <merged>` 为真；
> 防回归用例锁的是 **`-p theirs` 单 parent ⟹ exit 1**（真不变量），不是泛指单 parent。
> 历史形态无害：`git log --graph` 是标准 merge 节点，用户后续 `git merge <theirs>` = Already up to date。

**父层 theirs tree 的重写必须逐层进行**：改完 `vendor/inner` 要先重写 `vendor` 的 tree、在 `vendor` 里
commit-tree 出新 commit，再把它写进最外层的 theirs tree。`git ls-tree -r` **穿不透 gitlink**（P1-4：它是另一个仓的
commit 对象），所以不存在"一次拿到所有层 gitlink"的捷径。

三个**前置条件**（审计 D2/D3 实测，缺任一都会退回 exit=1）：跑父仓层 merge-tree 的那个 worktree
（`nodeIsolation.ts:350` 传的是 `canonWorktreePath`）必须能读到 ours/theirs/merged 三个 sub-commit；
该 submodule 必须已初始化；alternates 必须已挂上。

> **★ v3 新增（二轮审计 P0）：`ours` 未必在池里。**
> 池 = `<cache>/.git/modules/<sub>`，而 canonical 任务 worktree 的子仓 gitdir 是
> `<cache>/.git/worktrees/<task>/modules/<sub>` —— **池看不到那里新造的对象**（实测 `merge-tree` 报
> `fatal: unable to read tree`，exit 128）。而 auto-commit-push 是 **per-node** 触发的
> （`scheduler.ts:1561-1566` 注释："after a top-level node completed"），§5.1 的 `git -C <sub> commit`
> 就落在 canonical 子仓。于是「节点 A 完成 → commit-push 在 canonical 子仓提交 → 节点 B merge-back」时
> `ours ∉ pool`，按 §2.3 的 `exit>1 ⟹ 致命` 判定会**硬失败**。
> **处置**：`pushObjectsToPool` 的调用点不止 iso 侧——**canonical 侧子仓每次产生新 commit 后
> （包括 §5.1 的 commit-push、§3.1 步骤⑤ 之后）也必须回写池并更新 `wt/` 锚**。
> 子仓层 merge-tree 跑之前，对 ours/theirs/base 三者各做一次 `cat-file -e` 可达性 pre-flight，
> 不可达即先回写；仍不可达才判致命。

**flag `'-'`（未初始化）的子仓一律跳过**（v3，二轮审计 P1）：`git -C <sub> add -A` 在该目录不存在时
`fatal: cannot change to '<sub>'`。常见触发是子仓 URL 拉不通 / 用户 deinit / `gitRecurseSubmodules` 曾关过。
在 merge-back 里按"不参与合并、保持 ours"处理。§2.2 / §5.1 的遍历同样要过这道滤网。

### 2.4 拓扑变更分支（v1 缺失）

| 情形 | 处理 |
|---|---|
| iso 新增 submodule（`subBases` 无该 path） | 无 base ⟹ 视作"theirs 新增"：canonical 无该 path 则直接采纳；canonical 也新增了同 path 且 sha 不同 ⟹ 冲突 |
| iso 删除 submodule | 循环按"iso 当前列表"遍历会漏掉它 ⟹ 改为遍历 `union(subBases.keys, iso 当前, canonical 当前)` |
| 路径重命名 | 按删除 + 新增处理（v1 非目标，此处只保证不静默丢） |
| 一边删一边改 | 父仓层是 `CONFLICT (modify/delete)`，会先进 `buildSalvageTree`（`util/git.ts:1908`）——gitlink 不是 tree 条目故**不 fail-closed**，被 revert 成 ours；若 ours 侧不存在则 `materializeTree` 步骤① 会 `rm -rf` 掉 canonical 的该子仓目录。**必须在 salvage 前显式拦截 gitlink 的 modify/delete，转人工** |
| `.gitmodules` 的 url 变更 | `submodule sync` 会把新 url 写进**共享的** `.git/config`（linked worktree 共用 config），对并发 worktree 是全局副作用 ⟹ 仅在 canonical 上跑 sync，iso 上不跑 |
| 无共同祖先 | merge-tree exit=1，正常进冲突路径（审计验证：这一条**不是**问题） |

### 2.5 crash replay 通道（v1 完全缺失，P0）

`rebuildIsoHandle`（`nodeIsolation.ts:210-242`）的 `IsoRepo` 必须新增 `subBases` / `poolDir` 字段，
四个调用点（`scheduler.ts:2239` replay / `:2319` conflict-human resume / `:5698` wrapper 重建 / `:5720` 陈旧清理）
全部改为从 `node_runs.iso_submodules_json` 读回。

**fail-closed**：与 `replayPendingMerges` 已有的 "nodeTrees 缺失即拒绝"（`scheduler.ts:2236-2238`）对等——
若某 node_run 的 `iso_submodules_json` 缺失但其仓 `detectSubmodules` 为真，**拒绝 replay**并标 merge-failed，
而不是退化成父仓层合并（那会静默覆盖，正是本 RFC 要修的 bug）。

**列与 ref 的一致性**：列是值、ref 是对象锚，两者非原子写。以**列**为准；ref 缺失（被 gc）⟹ 按 fail-closed 处理。

---

## 3. merge-back 丢 gitlink 修复（G2）

### 3.1 顺序（实测）

| 步骤 | 当前 | 修复后 |
|---|---|---|
| ①②③ | `read-tree <merged>` → `checkout-index -f -a` → `reset --mixed <taskBaseHead>` | 同左 |
| ④ | `syncSubmodules`（按 index ⟹ 退回 base） | 同左 |
| ⑤ | — | **逐层**按 merged tree 的 gitlink `git -C <sub> checkout --detach <sha>` |

```
当前实现:  vendor HEAD = 9ad004c | 子仓内容 = l1                | status = []
修复顺序:  vendor HEAD = 6d7bbda | 子仓内容 = l1-edited-by-node | status = [ M vendor]  未暂存
```

⑤ 必须在 ④ 之后（F8）。gitlink 清单**逐层递归**取（`ls-tree` 穿不透 gitlink，见 §2.3）。

> **★ 实现时坐实的两条（PR-3）**：
>
> **一、canonical 侧也必须挂 alternates，否则步骤⑤ 直接 `fatal: unable to read tree`。**
> PR-2 只给 iso worktree 挂了池，merge-back 时 canonical 读不到节点的子仓 commit——
> 每个 worktree 拥有**私有** module dir，池对它并不自动可见。这实证了 §0.2 第三条
> "对象共享是 gitlink 修复的前提，不是优化"：顺序改对了但对象不在，照样失败。
> 现在 `captureSubmoduleTopology` 对 iso 与 canonical **两侧**都挂。
>
> **二、merge-back 与回滚的 index 语义相反，不能套用同一条断言。**
> merge-back 后 index 停在 **base**、工作区在 **merged**，两者的差值**就是**那笔未暂存改动
> （RFC-130 D23/D28）。而 §6.2 的回滚要求 index 与工作区**一致**。
> 我一开始把回滚的断言（`ls-files -s` == 子仓 HEAD）写进了 merge-back 测试，红了才反应过来——
> 那条断言实际是在要求"改动被 stage 了"，与设计正好相反。

### 3.2 失败语义（修正 v1 的过度 fail-loud）

| 失败 | 处理 |
|---|---|
| 对象不在目标 module dir | **merge-back 失败**（说明 §2.2 的回写漏了，是真 bug） |
| **canonical 子仓工作区脏** ⟹ `checkout` 报 `local changes would be overwritten` | **不是**致命错误。先对该子仓做 §6 的快照，再 `checkout -f`；快照失败才升级为 merge-back 失败。v1 把它一律 fail-loud，等于把 D22 的阻断挪到更晚更贵的阶段（审计 P2-11） |
| 池被删 / alternates 悬空 | `error: unable to normalize alternate object path`，父仓 status 整体失败 ⟹ merge-back 失败 |

同时修掉 `util/git.ts:1827` / `:2051` 两处**丢弃 `syncSubmodules` 返回值**。

### 3.3 不得破坏 `undoPriorShardDeltaInIso` 的 fail-open 契约（P1）

`undoPriorShardDeltaInIso`（`nodeIsolation.ts:441-489`）也调 `materializeTree`，其契约是 **FAIL-OPEN、never destructive**
（`:441-445`，`rfc130-shard-rerun-undo.test.ts` 逐条 pin）。步骤⑤ 引入的 throw 会让它在
`read-tree`+`checkout-index`+`reset` 执行**之后**抛出，留下半撤销态。

**方案**：`materializeTree` 增 `gitlinkFailureMode?: 'throw' | 'warn'`（默认 `'throw'`），
`undoPriorShardDeltaInIso` 的调用点传 `'warn'`，保持 fail-open。

---

## 4. 子仓冲突处理（G4）

1. 子仓层 merge-tree `exit=0` ⟹ 自动落地（F6：改不同行的常见情形直接过）。
2. `exit=1` ⟹ 在池里 commit-tree 出 ours/theirs，`git worktree add --detach` 开**子仓级 resolve-iso**
   （路径 `<iso-container>/resolve-sub/<subPathSlug>`），复用 `mergeAgent.resolveConflictWithAgent`。
   - 子仓层冲突是**普通文件冲突**，现有五类分类器直接够用。
   - prompt 加一句"你正在解决 submodule `<path>` 内部的冲突"（新变体，不改主 prompt）。
   - **resolve-iso 建好后必须跑 `syncSubmodules`**（`util/git.ts:1823` 注释明写 "worktree add does not populate
     submodule working dirs"）——v1 漏了，会让 merge agent 面对空目录（审计 P2-10）。
3. `exit>1` ⟹ 致命，不进本节。

### 4.1 human resume 通道（v1 缺失，P0）

`completeHumanResolvedConflict`（`nodeIsolation.ts:696-806`）只认 `resolve-{worktreeDirName|'repo'}`，
子仓 resolve-iso 不可见 ⟹ 落到 `:726-747` 的"无 resolve-iso 就对 canonical 重探"分支 ⟹ 父仓层探测 clean ⟹
**把未解决的 gitlink materialize 并判定 resolved**。这比卡死更糟。

**方案**：
- `iso_submodules_json` 增 `pendingSubResolves: string[]`（未解决的子仓路径集）。
- `completeHumanResolvedConflict` 开头：该集非空 ⟹ **先**逐个校验对应的 `resolve-sub/<slug>` 已解决
  （复用 `gatherResolvedStates` / `evaluateResolution`），任一未解决即 fail-closed 返回 unresolved，
  **绝不**走 `:726-747` 的重探分支。
- 子仓 resolve-iso 的清理：`discardNodeIso` 只对 `r.canonWorktreePath` 调 `removeWorktree`（`:508-521`），
  池里的注册项永不清理 ⟹ 追加 `git -C <pool> worktree prune` + 显式 remove。

**★ v3 补：收敛路径（二轮审计 P1）**。v2 只写了"拒绝"没写"通过之后怎么办"，按字面实现会让该 repo
恒 unresolved、任务永久停在 `awaiting_human`——正是 RFC-187 在多仓维度修掉的 wedge 在子仓维度复活。
全部子仓已解决后必须：
① 逐个把 `resolve-sub/<slug>` 的工作树 `write-tree` + `commit-tree`（双 parent，ours 在前）成新 sub-commit；
② 回写池 + 更新 `wt/` 锚；③ **逐层重写**父层 theirs tree（§2.3 同款）；④ 重跑父仓层探测；
⑤ 清空 `pendingSubResolves` 并走既有的 materialize 路径。

**★ v3 补：危害等级更正**。§0.3 说重探分支会"父仓层探测 clean ⟹ 错误放行"——二轮审计实测**不成立**：
两边都动 gitlink 时父仓层 merge-tree 报 `CONFLICT (submodule)` `exit=1`，重探分支拿到
`probe.conflicts.length > 0` 会 push 进 unresolved（`nodeIsolation.ts:726-747`），结果是**卡死**不是放行。
"clean 放行"只在本 RFC 把 merged sub-commit 写进 theirs tree 之后才可能发生。
⟹ **AC-18 的断言必须同时覆盖两件事**："不得错误放行" **且** "必须能收敛"，只锁前者会锁一个当前不存在的行为。

---

## 5. auto-commit-push 递归（G5）

### 5.1 流程

```
① 门：detectSubmodules(worktree) 为假 ⟹ 整段短路，argv 字节级不变（AC-12）
② listSubmodules，pathDepth 降序，对每个有本地新提交或脏内容的子仓：
     a. **先做 §6 的子仓快照**（供 push 前回退）
     b. git -C <sub> checkout -B agent-workflow/{taskId}     ← 子仓恒 detached，必须建分支
     c. git -C <sub> add -A && commit（若还脏）
     d. git -C <sub> push -u origin <branch>:<branch>
        ├ 成功 ⟹ 继续下一个
        └ 失败 ⟹ **回退本仓已做的子仓提交**（§6，仅限尚未 push 的），停止本 repo 的整个 commit-push，
                 outcome = 'commit-local-subrepo-failed'，父仓不 add / 不 commit / 不 push
③ 全部子仓 push 成功后，父仓照常 add -A → commit → push
```

### 5.2 v1 遗漏的四个语义（审计 P1-5）

| 问题 | 决定 |
|---|---|
| **原子性的作用域** | **per-repo，不是任务级**。`scheduler.ts:1598-1603` 是 `for (const repo of state.repos)`，repo A 失败不影响 repo B——与 RFC-066 既有语义一致。文档措辞必须显式限定，否则实现者会误解 |
| **子仓推了、父仓 push 失败** | 远端留下孤儿子仓分支。更糟的是 non-FF 修复路径 `fetch` + `merge --no-edit FETCH_HEAD`（`commitPushRunner.ts:330-354`）——远端父仓若也动过同一 gitlink 会报 `CONFLICT (submodule)` ⟹ `merge --abort` ⟹ `commit-local-failed`，而子仓早已推完。**决定**：父仓 push 进入 non-FF 修复前，先记录"子仓已推"事实到 `subrepos[].pushed`；父仓最终失败时**不回退子仓**（已 push 不可逆，F17），但 UI 明确标出"子仓已推、父仓未推"这一不一致态，并提示重跑任务会复用同名分支 |
| **子仓的 non-FF** | 下一次任务同名分支已存在且历史分叉 ⟹ 子仓 push 也会 non-FF 被拒。v1 的子仓段**没有任何 repair/non-FF 循环**。**决定**：子仓 push 失败先按父仓同款做一次 `fetch` + `merge --no-edit`，仍失败才判 `commit-local-subrepo-failed` |
| **写锁放哪** | `acquireWrite` 只裹 `add -A` + 三个 `diff --cached`，注释明写"Released BEFORE LLM/commit/push"（`commitPushRunner.ts:88-91`）。子仓段放锁外 ⟹ sibling writer 可能正在子仓里写；放锁内 ⟹ 每任务写锁被 N 次网络 push 占住。**决定**：把子仓段拆成两半——**a/b/c（本地写）进锁**，**d（网络 push）出锁**，与父仓既有的锁边界同构 |

`--amend` **不需要**带子仓（amend 只改 message，gitlink 不变）——审计验证通过。

### 5.3 结果结构与 wire（P0）

```ts
// shared/src/schemas/task.ts
export const COMMIT_PUSH_OUTCOME = [...既有四值, 'commit-local-subrepo-failed'] as const   // ★ 必须加
// CommitPushMetaSchema 增：
subrepos: z.array(z.object({
  path: z.string(), fromSha: z.string(), toSha: z.string(),
  committed: z.boolean(), pushed: z.boolean(), error: z.string().nullable(),
})).optional()
```

不加枚举 ⟹ `safeParse` 失败 ⟹ `commitPush=null` ⟹ **整行 commit-push 从 UI 消失**（§0.3）。
不加 `subrepos` 到 schema ⟹ zod strip ⟹ 前端永远拿到 `undefined`。

顺带修 `redactPushError`（`commitPush.ts:306-312`）：只脱 userinfo、不脱 query 凭据，与 shared
`redactGitUrl`（已补 query）不同步 ⟹ 改为委托 `redactGitUrl` 后截断。

---

## 6. 子仓快照与回滚（G10，新增）

> **不复活 `pre_snapshot`**（§0.3：那是 iso 时代的死代码）。本节是独立的、只服务于"平台在 canonical 子仓
> 造 commit"这一新增副作用的最小回退能力。

### 6.1 原语

```ts
/**
 * 对单个子仓做 snapshotFullState 同款快照（临时 index，不碰真 index/HEAD/工作区）。
 * pinRef 必填 —— 快照 commit 是 dangling object，无 ref 则任何 gc 都会销毁它。
 */
export async function snapshotSubmodule(
  subPath: string, pinRef: string,
): Promise<{ head: string; snapshot: string; pinRef: string }>

/** 回滚：reset --hard <head> → read-tree <snap^{tree}> → checkout-index -f -a → reset --mixed <head>，然后删 pinRef。 */
export async function rollbackSubmodule(subPath: string, snap: SubSnapshot): Promise<void>
```

实测（Y1/Y2）：捕获并恢复 tracked + **untracked**，撤销平台 commit（log 3→2），真 index/HEAD 不受快照影响。

### 6.1.1 pinRef 是必填，不是可选（v3，二轮审计 P0）

v2 的签名没有 pinRef，**原样重犯了本 RFC 自己刚为 AC-15 立下的教训**。
既有两个快照原语都带 `opts.pinRef`，且 `util/git.ts:1543-1551` 的注释写死了理由：
"without a ref the stash commit is a dangling object — any `git gc` past gc.pruneExpire … destroys it"。

### 6.1.2 生命周期（v2 完全空白）

| 问题 | v3 答案 |
|---|---|
| **存哪** | `{head, snapshot, pinRef}` 落 `iso_submodules_json.subSnapshots`（§2.1.1）；对象由 pinRef 保活 |
| **何时建** | ① merge-back 步骤⑤ 覆盖脏子仓前（§3.2）；② commit-push 子仓段开始前（§5.1a） |
| **何时用** | 对应失败路径的回退 |
| **何时删** | 回滚成功后立即删 pinRef；正常路径在 `discardNodeIso` / worktree 删除时随 §1.5 的清扫一并删。**不删就是往用户子仓 odb 里无界堆悬空对象**——对 path 模式仓尤其讽刺，D11 的立论正是"不留清不掉的副作用" |
| **崩溃窗口** | 快照后 / 回滚前 daemon 重启：sha 已在 DB 列里，`rebuildIsoHandle`（§2.5）一并读回，不丢 |

### 6.1.3 递归编排（v3，v2 只给了单仓原语）

§6.2 要求"自底向上回滚 + 自顶向下修父层 gitlink"，但 v2 的 T5 只造了两个**单仓**原语，没有编排层。
补一个 `rollbackSubmodulesRecursive(worktreePath, snapshots)`：按 `pathDepth` 降序逐个 `rollbackSubmodule`，
再按升序把每层 gitlink `checkout --detach` 回快照记录的 `head`（消除 Y3 实测的 ` M nested` 残留）。

### 6.2 递归顺序（F16）

嵌套层回滚会让父层 gitlink 变脏（Y3 实测 ` M nested`）⟹ **自底向上回滚，然后自顶向下修一遍父层 gitlink**
（把每层 gitlink checkout 回快照记录的 head）。

> **第二趟保证的是 gitlink 一致性，不是"父仓 status 变空"**（实现时实测确认）。
> 快照捕获的往往**就是脏状态**（子仓有未提交编辑），回滚忠实恢复这份脏，
> 而超级项目对"子仓有未提交内容"永远报 modified。
> ⟹ 正确的验收断言是 `git -C <parent> ls-files -s <sub>` 的 sha == 子仓实际 HEAD；
> 断言 `status --porcelain` 为空等于在断言"回滚把用户的编辑丢了"，方向反了。

### 6.3 覆盖范围与本质限制

| 场景 | 是否可回退 |
|---|---|
| iso 内的子仓改动 | **无需回退**——随 iso 丢弃自然消失（F18 + §0.3 的 iso 重试语义） |
| merge-back 失败 | ✅ 回退 canonical 子仓到 merge 前快照 |
| commit-push 子仓提交但未 push | ✅ |
| **commit-push 子仓已 push** | ❌ **不可逆**（F17：本地回滚管不到远端）。文档明示 + UI 标出 |
| 任务 cancel | 沿用既有语义：cancel **不碰工作区**（`task.ts:2044-2056`），子仓同理不回退 |

### 6.4 path 模式仓（D11）

不建池、不写用户主仓的 `.git/modules/<sub>`；平台的对象/ref/内部 commit 全部落在
`<repo>/.git/worktrees/<task>/modules/<sub>`，随 worktree 删除一并消失。代价：每 worktree 重 clone 子仓。

---

## 7. `git_diff` 子仓路径（G6）

**v1 的手法是错的**（审计 P1-7）：`submodule foreach git status --porcelain` 在 `gitChangedFiles` 被调用的那个
时刻（内层节点已 merge-back、步骤⑤ 已把子仓 checkout 到新 sha）**恒为空**——子仓工作树是干净的。
AC-8 期望的 `vendor/a.ts` 一条都出不来。

**正解：按 gitlink 区间取差集**

```
baselineGitlink = git -C <parent> rev-parse <baseline>:<subPath>
currentGitlink  = git -C <parent>/<subPath> rev-parse HEAD
paths           = git -C <sub> diff --name-only <baselineGitlink> <currentGitlink>   → 加 '<subPath>/' 前缀
```
porcelain 只作为补充，覆盖"子仓有未提交脏内容"这一残余情形。

**★ v3 补三条守卫（二轮审计 P1）**，缺任一都会让 `gitChangedFiles` 抛 `worktree-diff-failed`，
而它同时喂 git_diff 端口、`structuralDiff/gitBackend.ts:41` 与 RFC-098 preDirty ⟹ **三条链路一起 500**：

| 情形 | 现象 | 守卫 |
|---|---|---|
| baseline 里**没有**该 submodule（节点新增） | `fatal: path '<sub>' exists on disk, but not in '<sha>'`，exit 128 | 先 `cat-file -e <baseline>:<sub>`，不存在 ⟹ 该子仓全部文件按"新增"列出 |
| baseline 里该路径是**普通目录**（目录→submodule 转换） | `rev-parse` **exit 0** 但返回 **tree** sha，随后 `diff` 报 `fatal: bad object` | **必须 `cat-file -t` 判类型**（exit code 检测不到） |
| 子仓**未初始化** | 目录为空，`git -C <sub> rev-parse HEAD` 会向上发现**父仓**并返回父仓 HEAD ⟹ 产出一堆垃圾路径 | 先过 `listSubmodules` 的 flag `'-'` 滤网 |

任一守卫触发时**降级为"只列 `<subPath>` 一条"**（今天的行为），不得让整条链路失败。

**跨 RFC 影响**（v1 低估）：`gitChangedFiles` 还喂 `services/structuralDiff/gitBackend.ts:41` 与 RFC-098 的
preDirty 基线（`scheduler.ts:6073-6086`、`services/wrapperProgress.ts:68`）。路径展开是行为变更，
PR-E 的风险等级从"中"上调为"高"，须带这两条链路的回归测试。

---

## 8. 后台定时刷新（G7）

`services/submoduleRefresh.ts`，严格照 `eventsArchive.ts:203-228` 样板（`{stop}` / `let running` 重入保护 /
每 tick `loadConfig()` / 错误只记日志 / tick 首行读 enabled 开关 O(1) 返回）。

- 选仓：`last_auto_refresh_at` 过期 ∧ `last_fetched_at` 在 `onlyRecentDays`（默认 30）内。
- 串行 + `withUrlLock(urlHash)`，与起任务 warm fetch 天然互斥。
- 注册进 `cli/start.ts:443-543`，`shutdown()`（`:600-617`）里 `.stop()`。
- 默认 `enabled: true`，`intervalMs: 6h`。

## 9. `--remote`（G8）

`gitSubmoduleRemote`，默认 **false**。为 true 时 argv 追加 `--remote`。
作用点位**仅**读侧（warm fetch / 手动 refresh / 定时刷新）。**不**作用于 `createWorktree` /
`createIsolatedWorktree` / `materializeTree`——任务执行期基线必须钉死，否则同任务不同节点看到不同子仓版本（D8）。

> **★ v3 更正（二轮审计 P1）：v2 写法下 G8 是个 no-op，用户价值为零。**
> 读侧三个点位全部作用于 **cache repo 自身**（`gitRepoCache.ts:475` / `:781` 都是 `syncSubmodules(row.localPath, …)`），
> 而任务 worktree 由 `git worktree add` 从**已提交的 ref** 派生，随后按 D8 不带 `--remote` ⟹
> 任务看到的永远是分支里记录的 gitlink。净效果只是让 cache repo 自己的工作区多出一条永久 ` M <sub>` 脏状态。
> 而且 AC 体系看不见这个问题——AC-10 只锁 `=false` 时 argv 不变，**没有任何 AC 验证 `=true` 的实际效果**。
>
> **v4 处置（取代 v3 的"在镜像上造提交"）**：把作用点从**读侧**移到**任务 worktree 创建时**。
>
> v3 提过让读侧在 cache repo 上造一条 `chore: bump submodules` 提交，但那会让平台自建镜像与
> 远端分叉，下次 fetch 徒增冲突面。更干净的是：
>
> | 点位 | `--remote` |
> |---|---|
> | `createWorktree`（任务 worktree 刚建好，**执行开始前**） | **带** —— 这是唯一一次，把子仓拉到上游分支最新 |
> | `createIsolatedWorktree` / `materializeTree` / 读侧刷新 | **不带** —— 基线自此钉死 |
>
> 这样任务确实拿到了子仓的上游最新，而同一任务的所有节点看到的仍是同一个版本——
> D8 要防的是"同任务不同节点看到不同子仓版本"，不是"任务不许看到新版本"。v3 把 D8 读窄了。
>
> **AC-23**：`gitSubmoduleRemote=true` 时，上游子仓推进后**新起**的任务 worktree 里子仓内容为新版本，
> 且该任务全程不再变动（用两个节点分别读同一子仓文件来锁"执行期一致"）。

## 10. 配置接线（G9）

### 10.1 schema（已落地，v4 按实现修正）

```ts
gitSubmoduleRemote: z.boolean().optional(),
// 形状对齐 WorktreeGcSchema：enabled 必填，其余 optional、默认在调用点兜。
submoduleAutoRefresh: SubmoduleAutoRefreshSchema.optional(),   // ← 字段本身 optional
// 但 DEFAULT_CONFIG 里有值：submoduleAutoRefresh: { enabled: true }
```

**两条硬约束（实现时各踩了一次）**：

1. **字段必须 `.optional()`**。写成必填会让存量 `config.json` 过不了 `ConfigSchema.safeParse` ⟹
   `loadConfig` 抛错 ⟹ **daemon 升级后拒绝启动**。`packages/shared/tests/compat-config-versions.test.ts`
   的文件头注释把这条列为"a frequent Zod regression footgun"，本 RFC 实现时正好踩中、被它拦下。
2. **同时必须在 `DEFAULT_CONFIG` 里有值**。深合并集是**从 `DEFAULT_CONFIG` 推导**的（见下），
   不给值就进不了集合，也就拿不到前向兼容保护。

`config/index.ts` 的 `mergeDefaults` / `mergePatch` 原本**硬编码**只认
`worktreeAutoGc` / `eventsArchiveThresholds` 两个键。已改为：

```ts
const NESTED_CONFIG_KEYS = new Set(
  Object.entries(DEFAULT_CONFIG)
    .filter(([, v]) => typeof v === 'object' && v !== null && !Array.isArray(v))
    .map(([k]) => k),
)
```

这样任何新嵌套字段**自动**获得两项保护：① 老 config 缺内层字段时被深合并补齐（否则 daemon 起不来）；
② 部分 PATCH 保留兄弟字段（否则 `PATCH {x:{a:1}}` 会静默抹掉 `x.b`）。

> **顺带查明的既有限制（不在本 RFC 范围）**：`ConfigPatchSchema = ConfigSchema.partial()` 是**浅** partial，
> 所以内层字段全必填的嵌套对象（如 `eventsArchiveThresholds`）**本来就**不支持部分 PATCH，会 400。
> `worktreeAutoGc` / `submoduleAutoRefresh` 因内层是 optional 而可以。要统一得改 `ConfigPatchSchema` 的
> 构造方式，属于独立改动。

### 10.2 管道（v4 定稿：不改任何签名）

v2/v3 打算把 config 从调用方一层层传进来，需要动 **4 层**签名：
`createIsoUnderLock` → `createNodeIso` → `mergeBackNodeIso` → `materializeTree`（6 个调用点）。
实测调用图后发现这条路既长又漏：

- `createNodeIso` 有 **2** 个生产调用点，其中 `scheduler.ts:5737`（wrapper 私有 canonical）**绕过**
  `createIsoUnderLock`，只补前者会让 wrapper 路径永远拿不到配置（AC-11 在该路径达不成）。
- `scheduler.ts` 与 `nodeIsolation.ts` **都不 import config**（全仓 grep 零命中）——这正是
  RFC-034 断链的物理成因：没有任何人处在能读配置的位置上。

**改为让 `resolveSubmoduleParams` 自己读配置**：

```ts
// services/gitRepoCache.ts —— 已 import Paths，且 config/index.ts 只依赖
// shared + fs + errors + log，无环风险。
export function resolveSubmoduleParams(inMode?, inJobs?) {
  // 显式传入优先；否则读 settings（RFC-034 声称存在、实际从未接上的那条线）
  const fromDisk = submoduleConfigFromDisk()
  let mode = inMode ?? fromDisk.mode ?? 'auto'
  ...
}
```

一处改动，**5 个生产调用点（`util/git.ts` 3 + `gitRepoCache.ts` 2）全部自动受益**，零签名变更，
`util/git.ts` 仍不直接 import config（它经动态 import 拿 `resolveSubmoduleParams`，避环结构不变）。

两条实现约束：
1. **先 `existsSync` 再 `loadConfig`**。`loadConfig` 在文件缺失时会**写入默认配置**
   （`config/index.ts:26-30`），让一个 git 辅助函数产生写副作用是不可接受的。
2. **配置损坏时静默回退默认**，不得让 git 操作因为 settings 里一个坏字段而失败。

安全性：`gitRecurseSubmodules` 是 optional 且默认不出现在 config.json 里 ⟹ 读出 undefined ⟹
回退 `'auto'` ⟹ 与今天字节级一致。只有用户显式设置才改变行为，这正是 G9 要修的东西。
`resolveSubmoduleParams` 在**测试目录零引用**，没有测试锁住旧签名。

### 10.3 测试口径升级

`repos-submodule-wiring.test.ts:43-50` 现在只断言 shared schema **源码文本**，断链测不出来 ⟹
改为后端 **runGit spy**：`gitRecurseSubmodules='never'` 时不得出现任何 `submodule` argv（AC-11）。

---

## 11. 数据模型

migration **0102**（v2 写的 0100 已被占用——见下方实测；**提交前必须再核一次**）：

```sql
ALTER TABLE cached_repos ADD COLUMN last_auto_refresh_at INTEGER;
--> statement-breakpoint
ALTER TABLE node_runs ADD COLUMN iso_submodules_json TEXT;
--> statement-breakpoint
ALTER TABLE node_runs ADD COLUMN iso_submodules_repos_json TEXT;
```

> **编号现状（2026-07-20 本机实测，v2 的"0100 / journal 99 条"已过期）**：
> `0100_rfc207_task_running_time.sql` **已提交**；`0101_rfc207_directive_shard.sql` 由**并发 session 持有且未提交**
> （`git status` 显示 `??`），`_journal.json` 已被其改成 **101 条**（`M`）而 HEAD 是 100 条。
> `upgrade-rolling.test.ts:230` 现在写的是 **"HEAD journal has 100 entries"**。
> ⟹ 本 RFC 取 **0102**；断言值按**落地时的实际 HEAD 值 +1** 计算，不要照抄本文档的数字。
> 这正是 [Full suite after migration] 记录的事故形状——journal 里混着并发 session 的 orphan 条目，
> 提交时**只 `git add` 自己的 migration 文件**，且必须跑**全量** backend 测试确认 journal↔files 未失配。
> `proposal.md` 的"多人协作"节要把 `_journal.json` 列为**最高危共享文件**（v2 漏列）。

**v1 的坑提示指错了**（审计 P1-4）：加列**不会**触发 `no column named`——所有冻结态插入早已改用显式列名裸 SQL
（`rfc189-wg-round.test.ts:95-98,130` 等）。真正会红的是一条**精确列数算术锁**：
`migration-0041-rfc074-drop-cci.test.ts:160` 的 `expect(cols.length).toBe(cols0040.length - 1 + 7 + 6 + 3 + 1 + 1)`，
需补一项并同步上方注释账本。另需 `upgrade-rolling.test.ts:230` 的 99 → 100（标题+断言+注释三处），
并按既有先例新增 `migration-0100-*.test.ts`（两列的存在性/nullable/类型断言）。

---

## 12. 前端

### 12.1 wire 与 outcome（P0，v1 完全漏了）

- `COMMIT_PUSH_OUTCOME` 加 `commit-local-subrepo-failed`（§5.3）。
- `commitOutcomeKey`（`tasks.detail.tsx:1597-1609`）的 switch 加分支——它有 `default:` 兜底，**typecheck 抓不到**，
  漏改会把"子仓推送失败"显示成"跳过（无变更）"，主动误导。
- `finalize`（`commitPushRunner.ts:174`）只把 `commit-local-failed` 判 failed ⟹ 新 outcome 需一并纳入，
  否则行状态 `done` + 绿色 chip。
- 改 wire 枚举前 grep `e2e/`（e2e 在 workspace typecheck 之外）。

### 12.2 UI

| UI | 方案 |
|---|---|
| Settings 新增 git 分区 | 归入 **`reliability` group**（与 `gc` 同组，对齐 proposal 用户故事 5 的"GC/Git"口径）。**五处登记**（审计 P1-5）：`SETTINGS_CONFIG_SCOPE_IDS`(`settings-drafts.ts:26`) / `SETTINGS_CONFIG_SCOPE_KEYS`(`:37`) / `SECTION_BY_SCOPE`(`:150`) / `createSettingsDraftRegistry` 的 scopes 字面量(`:189`) / `settings.tsx` 的 union+`SETTINGS_TABS`+`configScopeForSettingsTab`+`sectionGroups`。白名单粒度是**顶层 key**，`submoduleAutoRefresh` 整体登记可行 |
| `SubmoduleBadge` | **口径更正**：组件已是四态（`SubmoduleBadge.tsx:22-48`），真正的变更只有 `lastSubmoduleSyncOk === null`（有子仓、从未同步）从 ok 改 **neutral**。同时**收编进 `StatusChip`**（props 实测够用，无需扩展）并删 `.submodule-badge`（`styles.css:10653-10671`，全仓仅 2 个源文件引用） |
| 「上次自动刷新」 | `RelativeTime` + `.scheduled-next__abs` 双行（先例 `routes/scheduled.tsx:185-195`） |
| 子仓结果列表 | 挂 `tasks.detail.tsx:862-878` 的多仓 `<details>` 同构位置；新增公共组件 `<ShaRange>` |
| `<ShaRange>` 契约 | **v1 的"全仓无先例"不准**——现有 3 处 2 种长度（`tasks.detail.tsx:922` / `plugins.detail.tsx:398` 皆 `slice(0,12)`，`McpInventoryPanel.tsx:136` 为 `slice(0,10)` 且带全值 title）。新组件**统一为 12 位**并接管这 3 处；契约定死：`from`/`to` 可为 null（`committed:false` 时无值）→ 渲染 `common.emDash`；箭头 `aria-hidden`；挂全值 `title`；朗读走 i18n 插值 key 而非拼接 |

### 12.3 视觉基线（v1 判断错误）

`settings.png` **必刷**：Settings 页在 1280×800 下**左侧 `PageSectionNav` rail 与页面一起进整页截图**
（`e2e/visual-regression.spec.ts:508-514`），新增 section 改变 rail 条目数，**与新 tab 是否默认无关**。
「子 tab 内部变动不刷基线」管的是 panel 内容，不适用于导航 chrome。`repos.png` 同样必刷。

---

## 13. 失败模式

| 场景 | 处理 | 可观测性 |
|---|---|---|
| 池 gc 删对象 | §1.1 保活 ref 防住；ref 缺失即 fail-closed | merge-back 失败 |
| `--reference` no-op | §1.2 无条件显式写 alternates 兜底 | — |
| 存量仓无 alternates | 首次 merge-back 前由 `ensureSubmoduleAlternates` 补挂（幂等） | — |
| path 模式仓 | 不建池，worktree 私有 module dir（§6.4） | `log.info` 记降级 |
| canonical 子仓脏 | 先快照再 `checkout -f`（§3.2），非致命 | — |
| 子仓 push 失败 | 回退未 push 的子仓提交，父仓不推 | `subrepos[].error` + UI |
| 子仓已 push 但父仓失败 | **不回退**（不可逆），UI 标不一致态 | 同上 |
| 子仓冲突 agent 解不开 | §4.1 fail-closed，任务 `awaiting_human`，canonical 干净 | 现有 UI |
| replay 时 `iso_submodules_json` 缺失 | fail-closed 拒绝 replay（§2.5） | merge-failed |
| 池 ref 无界增长 | §1.5 的 GC 兜底 | — |

## 14. 测试策略

### 14.1 网络门控（v1 的规避方案实测不成立）

git ≥2.38 按**解析后的传输协议**判定，**相对路径一样被拒**（F19）。正解是
**`GIT_CONFIG_GLOBAL` 注入临时 gitconfig 的 `protocol.file.allow=always`**（保存/恢复），
先例：`rfc130-iso-worktree-primitives.test.ts:253-254`（未门控）、`git-repo-cache-submodule.test.ts:73-105`（已门控）。
**AC-3 的红→绿回归测试绝不允许门控**——它锁的是数据丢失。
注意 `test-suite-policy.test.ts:40-58` 的 `ALLOWED_SKIP_COUNTS` 是**精确清单**，新增门控文件必须同步登记。

### 14.2 新增测试

`rfc210-submodule-topology` / `-alternates`（含 **已初始化 module dir 的显式 alternates**）/
**`-materialize-gitlink-regression`（红→绿，AC-3）** / `-pool-gc-survival`（**保活 ref 扛住默认 gc**）/
`-recursive-isolation`（含嵌套 ≥2 层、双 parent 契约、拓扑变更分支）/ `-crash-replay-subrepo` /
`-conflict-resume-subrepo`（**fail-closed，不得错误放行**）/ **`-commitpush-subrepo`（红→绿，AC-6/AC-7）** /
`-subrepo-snapshot-rollback`（含 untracked 恢复、嵌套顺序、已 push 不可逆）/ `-git-diff-subrepo-paths`（gitlink 区间差集）/
`-refresh-loop` / `-config-wiring`（argv spy）/ `-byte-baseline` / `migration-0100-*`。

### 14.3 既有测试更新（v1 漏了一半）

v1 已列 8 个，**补**：`rfc130-crash-replay.test.ts` / `rfc130-shard-rerun-undo.test.ts` /
`rfc130-wrapper-private-canonical.test.ts` / `rfc130-merge-resolve.test.ts` / `rfc130-iso-gc.test.ts` /
`rfc188-isolated-agent-run.test.ts`（`createIsoUnderLock` 签名）/ `worktree-working-branch.test.ts`（**12 处**
`submoduleMode:'never'`）/ `git-repo-cache-submodule.test.ts:136-195`（deps 形状）/ `test-suite-policy.test.ts` /
`settings-drafts.test.ts:27-36`（**精确有序集合断言**）/ `migration-0041-rfc074-drop-cci.test.ts:160`（列数算术）/
`repos-submodule-wiring.test.ts:33-40`（badge testid 文本锁）/ `submodule-badge.test.tsx:44,57`（className 断言）/
`compat-config-versions.test.ts` + `config.test.ts`（DEFAULT_CONFIG）/ `e2e/commit-push.spec.ts:154`。

---

## 15. 决策表

| # | 决策 | 取舍 |
|---|---|---|
| D1 | 一个大 RFC 覆盖 bug 修复 + 新能力 | 用户设计门选定；修复方案与后续能力互为前提 |
| D2 | 递归隔离盖**全部嵌套层** | 用户选定 |
| D3 | alternates 指向共享池，不共用父仓 module dir | 用户选定（共用会让并发节点抢同一 HEAD/index） |
| D4 | 子仓冲突先 merge-tree、解不开再上 merge agent | 用户选定；F6 证明多数情形能自动过 |
| D5 | commit-push 原子性 **per-repo** | 用户选定方向；作用域按 RFC-066 既有语义限定为 per-repo |
| D6 | 默认：递归隔离开、定时刷新开、`--remote` 关 | 用户选定 |
| D7 | D22 fail-loud 退役 | 本 RFC 提供了真正的承载能力 |
| D8 | `--remote` 只作用于读侧 | 任务执行期基线必须钉死 |
| D9 | 子仓结果存 `commit_push_json` JSON 内，但 **outcome 枚举必须上 wire** | 可选诊断数据不加列；但枚举不同步会让整行消失 |
| D10 | `<ShaRange>` 作为新公共组件并**接管既有 3 处** | 统一 12 位截断，避免第 4 种写法 |
| **D11** | **path 模式仓不建池、降级为 worktree 私有 module dir** | 用户拍板"给子仓也做 snapshot/rollback"的意图是**不留清不掉的副作用**；path 模式的池就是用户真实仓，平台对象/ref/commit 会永久落进去。用性能换干净 |
| **D12** | **子仓回滚不复活 `pre_snapshot`** | 该机制在 iso 模型下已是死代码（§0.3）；扩展它等于扩展死代码，且会与 iso 重试语义冲突 |
| **D13** | **`materializeTree` 增 `gitlinkFailureMode`** | 保住 `undoPriorShardDeltaInIso` 的 fail-open 契约 |

---

## 16. 落地后对抗审计发现的 8 条 P0（已修）

八个 PR 全部合入、CI 全绿之后又跑了一轮对抗审计（4 路并行，全部用真 git fixture
实测，不接受纯推理结论）。结果是 **8 条 P0**，其中数条直接否定了本 RFC 的核心承诺。
记在这里而不是悄悄修掉，因为每一条都指向一类**本地测试结构性看不见**的盲区。

| # | 症状 | 根因 | 修复 |
|---|---|---|---|
| A1 | 所有既有安装升级后 0102 被静默跳过，daemon 起得来但每条 `cached_repos` / `node_runs` 查询死于 `no such column` | `_journal.json` 的 `when` 用了真实 `Date.now()`，而本仓 journal 跑在合成的「上一条 +86400000」轴上、早已排到 2026-08；drizzle 只在 `lastDbMigration.created_at < folderMillis` 时应用 | `when` 改为 0101+1day；新增 journal 单调性断言 |
| A2 | 非根层 submodule（`libs/vendor`）的合并结果被静默丢弃，merge-back 仍报 clean | 第⑥步 `ls-tree` 没带 `-r`，根层只看到 `040000 tree libs`，被 `!== 'commit'` 跳过 | `ls-tree -r` |
| A3 | 未初始化 / 拉不通的 gitlink 让**每次** merge-back 抛 `materialize-failed`，且抛在 canonical 已被改写之后 | 未初始化的子仓是**空目录**，`existsSync(subPath)` 恒真；`git -C <空目录> checkout` 向上跑到超级项目 | 判据改 `existsSync(<sub>/.git)` |
| A4 | 仓里有 ≥2 个子仓或任何嵌套时，第一个节点 merge-back 就硬崩（**AC-4 = 100% 不可用**） | `poolDir ??= pool` 只记第一个子仓的池，而池是**每子仓一个** | `poolDirs: Record<subPath, string>`，4 处使用点按路径取 |
| A5 | canonical 子仓里用户**未提交**的修改被 `checkout -f` 静默销毁 | D22 退役的直接代价：旧的 `submodule update` 不带 `--force`，脏子仓只会让 update 失败 | 强推前按 G10 pin 全状态快照到 `refs/agent-workflow/subsnap/`；快照失败则拒绝强推 |
| A6 | 子仓冲突不 park 成 `awaiting_human` 而是 merge-failed，人拿不到恢复路径 | 仓级冲突项 `mergedTree: ''` → `git commit-tree ""` exit 128 → `commitTree` throw，异常穿过 writeSem | 显式识别空树并直接 park，不建 resolve-iso |
| A7 | 被 pin 的子仓被 fast-forward 到 upstream tip 并推出去，pin 销毁 | 子仓 push 非 FF 时照抄父仓的 `fetch` + `merge FETCH_HEAD` 修复 | 子仓不做非 FF 调和，报错交给人 |
| A8 | 未改动、不可推的子仓（只读 vendored 三方库）扣住**整个父仓**的 commit-push，父仓连本地提交都不落 | §5.1② 的「有本地新提交或脏内容」谓词在实现里漏了 | 补谓词：脏 或 HEAD 领先于记录的 gitlink，否则取锁前跳过 |

### 为什么本地测试一条都红不了

四类盲区，值得单独记住：

1. **全部 rfc210-\* 测试只用一个根层 `vendor`**，且永远初始化好。A2 / A3 / A4 三条
   合起来意味着「一个根层子仓」是唯一被覆盖的形状，而它恰好是唯一不出问题的形状。
2. **所有 DB 测试从零建库**。那时 `lastDbMigration` 是 undefined、所有 journal 条目
   无条件应用，A1 结构性不可见；`upgrade-rolling` 的 freeze target 又都停在
   idx 1/13/19，远早于出事那条。
3. **`rfc210-recursive-submodule-merge` 直接调 `mergeBackNodeIso` 且不带 resolver**，
   整条 settle 路径（A6 所在）被绕过。
4. **G10 的 `snapshotSubmodule` / `rollbackSubmodule` 是死代码**——只有测试引用它们，
   测试因此绿得很好看，而生产路径上没有任何 caller。A5 就长在这个缝里。

### 仍未处理

以下为同批审计的 P1/P2，尚未修，按严重度排：G10 的 `rollbackSubmodule` 在
commit-push 失败路径上仍未接线（§6.3 表格声称「可回退」）；`tryAgentResolveSubmodule`
的 `paths` 传的是父仓相对路径而 manifest 是子仓相对，导致 T25 结构性永远
unresolved；嵌套 `rewriteGitlinkInCommit` 往超级项目 tree 写 `vendor/inner` 在 git
层面恒失败；`pendingSubResolves` 没有清空路径，一旦写下非空值 `conflict-human` 行
解不开；`onlyRecentDays` 被 refresh 自身的 `lastFetchedAt` 写入抵消（**已修**，
`900d1ff6`，G7）；`ShaRange`
抽出来了但三处老代码一处没迁；`SubmoduleBadge` 第三/四态可见文案完全相同、只靠
颜色区分（WCAG 1.4.1）。

---

## 17. 实现门（Codex 2026-07-22）4 条 critical 的闭环

报告原文在 `codex-impl-gate-2026-07-22.md`（结论 NO-SHIP：4 critical + 4 high +
1 medium）。本节记录 4 条 critical（对应原 8 条 P0 中未闭环的 A1/A5/新增拓扑/A8）
的修复口径与两条新实测地雷；4 条 high 仍开放（见 §17.3）。

### 17.1 两条实测地雷（修复方案的地基，先于结论记住）

1. **linked worktree 里 `git submodule add` 的 module dir 是 per-worktree 的**：
   落在 `<host>/.git/worktrees/<iso>/modules/<path>`，不是 `<host>/.git/modules/`。
   `git worktree remove --force` 把 admin 目录整个删掉——**新子仓的对象跟着 iso
   一起死**。这坐实了 critical #3 的丢失链，也意味着"共享 modules"假设对新增路
   径完全不成立，必须显式建池回写。
2. **`git submodule status` 只枚举 index 里的 gitlink**：落进 canonical 的新子仓
   是 unstaged delta（`?? newsub/`），status 一行都不打。所有"本仓真实拓扑"的消
   费点（拓扑采集 / publish / commit-push 递归）都不能只靠它——新增
   `listEffectiveSubmodules`（index gitlink ∪ `.gitmodules` 已声明且已挂载）作为
   统一列举器。

### 17.2 修复口径（红→绿测试文件在括号里）

| # | 症状 | 修复 |
|---|---|---|
| critical #1（A1 类） | 子仓 auto-commit / 对象回写失败只 warn ⟹ clean settle ⟹ `discardNodeIso` 删唯一产物；对象回写失败变体在 node ref 清理后被 pool gc 收割 | `publishSubmoduleHeads` 的 status/add/commit/rev-parse/建池/回写/回读校验/wt 锚任一失败**抛错**；merge 侧 worktree 锚失败同样抛错；pool ref **回读精确等于目标 SHA** 才算发布成功；scheduler 主线 merge-back catch 补 `keepIso = true`（iso 可能是唯一副本，保留给人工抢救/重试）（`rfc210-publish-failure-hard-fails.test.ts`） |
| critical #2（A5） | `snapshotFullState` pin 失败仍返 SHA、`snapshotSubmodule` 无声、`checkout -f` 照跑 ⟹ 用户未提交工作被销毁且"快照"gc 一到就没；同 HEAD 二次快照互相覆盖 | `snapshotFullState` 带 `pinRef` 时 `update-ref` 非零**抛 DomainError**（三个 pin 调用点——base/node/subsnap——全部受益）；`snapshotSubmodule` 抛后**回读校验** ref 精确指向 snapshot；subsnap ref 加 `-<pid>-<nonce>` 后缀防覆盖（`rfc210-subsnap-pin-hard-fails.test.ts`） |
| critical #3（新增拓扑，T24 补落地） | 运行中新增的首个/并列/嵌套 submodule 完全绕过池与合并：对象死在 per-worktree module dir，canonical 静默拿空目录；二阶丢失——下一个节点把 unstaged 新子仓读成"theirs 删除"再删掉 | publish 对新路径 `ensureSubmodulePool`（`<hostGitDir>/modules/...` bare 建池）+ 回写 + 节点/worktree 双 ref 锚；`checkoutMergedGitlinks` 带 currentTree 变更判据——**未动的未初始化 gitlink 保持静默跳过**（A3 语义不回退），有变化的走 `attachSubmoduleFromPool`（gitlink 临时注入 index → `submodule init` → url 指池 → `update --checkout` → `sync` 还原 → index 恢复原状，全程 unstaged 契约不破）；iso 创建后 `alignWorktreeGitlinks` 按 base snapshot 对齐并**重采拓扑**（防二阶删除 + 顺带修掉 iso 子仓 stale view）；拓扑随 `persistIsoNodeTree` 重新持久化（crash replay 可见新路径）；`dropNodePoolRefs` 改按 `poolDirs` 遍历（新路径 node ref 不再泄漏）；both-added gitlink 冲突经 poolDirs + ls-tree 160000 探测拦在 salvage 之前（`rfc210-new-submodule-topology.test.ts`，4 例） |
| critical #4（A8 嵌套） | `rev-parse HEAD:vendor/inner` 穿不透 gitlink（实测 exit 128）⟹ clean 预提交的嵌套子仓被判"没动"跳过 ⟹ 父层发布悬空 gitlink | recorded 从**直接父仓**读（最长前缀匹配定位直接父层）；recorded 查不到（新增子仓）按"必须推"处理；commit-push 列举改 `listEffectiveSubmodules`；未动子仓零 ref 语义保持（`rfc210-commitpush-nested-precommitted.test.ts`） |

### 17.3a 复审轮（同日，针对本批修复的 Codex review）

对 4 条 critical 的修复补丁又跑了一轮 Codex review，折出 **4 P1 + 2 P2，全部采纳**：

| # | 发现 | 修复 |
|---|---|---|
| P1 | `listEffectiveSubmodules` 对 agent 可写的 `.gitmodules` 无防护：`path = .` 死循环（实测 120s 超时）、`..`/绝对路径/symlink 可把 git 操作带出任务 worktree | realpath 严格包含判定 + visited 集去环 |
| P1 | attach 用本地路径当 clone url，git ≥2.38.4 默认拒绝 `file` transport——**测试的全局 `protocol.file.allow` 恰好掩蔽了它**（生产必炸） | `submodule update` 加命令级 `-c protocol.file.allow=always`（池是平台自有路径，不放宽用户配置的 url）；新增「无全局 allow」红→绿测试 |
| P1 | 新路径 wt 锚在 publish（锁外）无条件写，两兄弟同加一路径时后发布者可用被拒 sha 覆写获胜者的锚 → 获胜 sha 在 discard 后被 gc | publish 改 **create-only CAS**（存在即让位，本方 sha 由 node ref 兜底）+ merge 锁内把锚重指**实际采纳**的 sha |
| P1 | keepIso 只加在主线——workgroup hook / fanout shard / aggregator 的 `finally` 仍无条件 discard，publish 失败时唯一副本照删 | 三站点补 keep-on-merge-throw（hook 在 rethrow 前置位）；`isolatedAgentRun.ts` 头注的 per-site 纪律同步更新；源码级四站点锁 |
| P2 | attach 的 `submodule sync`（url 还原）失败被吞——子仓可能长期指着池，后续 auto-push 推进池里而父层 gitlink 声称在真远端 | sync 非零即整体失败 |
| P2 | attach 的 index 恢复失败被吞——瞬时 gitlink 滞留 index，破坏 unstaged 契约 | 恢复非零即整体失败（即使 body 成功） |

三轮复审再折出 **1 P1，已采纳**：二轮的"锁内重锚"跑在**父层 merge 判定之前**——并发双加同
路径时，后合并者先把锚改成自己的候选 sha，随后 add/add 冲突把它拒掉，canonical 保住的获胜
sha 反而失去锚（获胜方 node ref 已随 discard 消亡 ⟹ 一次 pool gc 即 `bad object`）。修：重锚
移到 **merge 采纳且 materialize 成功之后**（clean 分支按 merged tree、salvage 分支按 salvage
tree 读实际落地的 gitlink），冲突/失败路径一律不动锚；红→绿测试「a LOSING sibling merge
conflict does not clobber the landed anchor」（败者冲突后锚仍指获胜 sha 且扛 `gc --prune=now`）。

四轮复审再折出 **2 P1，以一个机制统一采纳**：三轮的"merge 后重锚"仍有两个洞——
①解决冲突的两条落地路径（merge agent §6.2④ / human resume §6.3）materialize 采纳的
gitlink 时根本不经过 merge 循环，无人重锚；②materialize 之后再写 ref，一次 ref 失败就把
"已落地的 merge"标成 merge-failed（分裂状态）。统一修法：**新增路径的 wt 锚移交发生在
`discardNodeIso`**（`anchorNewPathsAtDiscard`）——node-scoped pool ref 在 discard 前恒兜底
可达性，discard 时从 canonical 实际挂载状态读真值写锚；锚写不上（用户已把 canonical 子仓
推进到池外 commit、ref 锁、fs 错误）则**保留该路径的 node ref（宁漏不丢）**，绝不抛错制造
分裂。known 路径不需要此机制：子仓层 merge commit 以 `-p ours -p theirs` 双 parent 保住两
个 lineage 的可达性（§2.3 不变量），锚前移不会造成丢失。publish 侧 create-only CAS 保留作
为兜底。红→绿：ns7 改锁 discard 移交、ns9 增补"弃置败者不污染锚"、新增 leak-not-lose 例
（用户推进后 discard 保留 node ref 且 merged commit 扛 `gc --prune=now`）。

五轮复审（对四轮补丁）再折出 **1 P1 + 1 P2，全采纳**：①discard 时的锚移交跑在任务写锁**外**
——读 canonical head 与写 ref 之间，兄弟节点可落地并锚定更新的 sha，迟到的无条件写会把锚拨回
陈值 ⟹ 改 **ref CAS**（`update-ref <ref> <new> <expected-old>`，'' = 必须不存在；任何过期写
CAS 必败转 keep，收敛交给幸存的 discarder——败者 CAS 失败即保 node ref，宁漏不丢，无锁而正
确）；②`replayPendingMerges` / `replayConflictHumanResolutions` 成功落地后从不 discard（原始
执行已崩溃或 keepIso 停驻）⟹ node pool ref 永久泄漏、新路径锚永不移交 ⟹ 两站点在 merged /
resolution-landed 后补 `discardNodeIso(handle)`（顺带闭合 workgroup hook keep-on-throw 后的
replay 生命周期）。源码级锁：CAS 形状 + 两 replay 站点 discard。

六轮复审（对五轮补丁）再折出 **1 P1 + 1 P2，全采纳**，并附带一次性能回归修复：
①P1：CAS 仍可与 known-path 合并交错**倒拨锚**——n2 的 in-merge 锚写（B）落在 materialize 之
前，n1 的 discard 以 B 为 expected-old 读到未落地的 canonical（A）即可把锚拨回 A；B 落地后
n2 视该路径为 known 不再移交，node ref 一掉 B 就裸奔（祖先性只保旧不保新）。修：discard 的
锚移交 + node ref 清理挂**任务写锁**（`discardNodeIso` 增可选 `writeSem`，九个调度器站点全
传；锁内无合并可交错，CAS 保留作跨 discard 兜底；测试/GC 无锁调用保持 CAS-only）。
②P2：replay 用 **retry 行 id** 重建 iso 物理身份——process-retry 的物理键是原始行 id
（D17），`rebuildIsoHandle(nodeRunId: r.id)` 指向不存在的 worktree/ref 命名空间，discard 打
空、原 iso+refs 泄漏；顺带这也是 human-resolve replay 的 resolve-iso containerPath 既有错位。
修：`isoKeyOf(r.isoWorktreePath, r.id)` 从持久化路径 basename 还原物理键（两 replay 站点）。
③性能：iso 创建对齐 pass 在慢 CI 机上把两个无显式 timeout 的既有 merge-back 测试推过 5s 默
认预算（macOS shard 实测 5002ms 超时）——`checkoutMergedGitlinks` 对 **unchanged gitlink 整层
跳过**（O(changed) 而非 O(submodules)），对齐无改动时跳过二次采拓扑；两测试补 120s 显式
timeout。源码级锁：单行 discard 全带 writeSem 的计数棘轮 + isoKeyOf 接线。

### 17.3 仍开放（本批不动）

实现门的 4 条 high：递归 push 未冻结 SHA 图（写锁外网络窗口 + 崩溃重入
`skipped-empty` 不补推）；嵌套三路合并在错误仓重写 + `pendingSubResolves` 卡死
（= §16 尾表的 T25 双条目）；`materializeTree` 步骤①-⑤先改写 canonical 后验证的
原子性；0102 中间坏版本新装库的重复 DDL（取决于 `0fde0910`→`6bad778c` 之间是否
有真实安装，Codex Question #1）。另有 Question #2（`force=1` 删除 cached repo 的
borrower preflight）与 #3（path-mode `isPathMode` 死契约，RFC-165 后建议删除）。
