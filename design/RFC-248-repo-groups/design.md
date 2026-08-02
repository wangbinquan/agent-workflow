# RFC-248 — 仓库组 · 技术设计

> 配套 `proposal.md`（决策 D1–D21）与 `plan.md`（任务分解 T1–T33）。
> 所有 git 行为断言均在 **git 2.50.1（Apple Git-155）** 上跑过真实命令，脚本见 §3.6。

## 1. 概念模型

```
RepoGroup                      一个可命名、可复用的执行空间定义
 └── RepoGroupMember[]         有序成员列表（member_index）
      ├── kind='repo'   → cachedRepoId + ref + subdir
      └── kind='group'  → childGroupId          （递归，深度 ≤ 5）
      共有：mountPath（'' = 挂根）, readonly

           ── 启动时 flatten() ──▶

PlannedRepo[]                  展平后的物化计划（总数 ≤ 32）
 { cachedRepoId, ref, subdir, mountPath, readonly, viaGroups[], branchSuffix }

           ── materialize() ──▶

task_repos 行 × N              一行一个 git worktree
```

三个层次的关键区别：

- **RepoGroupMember** 是**定义**：`mountPath` 相对于**它所在的那个组**。
- **PlannedRepo** 是**展平结果**：`mountPath` 相对于**任务根**（`cwd`），由外层
  路径逐层前缀拼接而成。
- **task_repos** 是**快照**（D8）：启动后组再改也不影响它。

### 1.1 展平算法

```
flatten(group, prefix='', inheritedReadonly=false, depth=0, chain=[]):
  if depth > MAX_GROUP_DEPTH(5): throw repo-group-depth-exceeded
  if group.id in chain:          throw repo-group-cycle          # D18 环检测
  for m in group.members ordered by member_index:
    mount = joinMount(prefix, m.mountPath)                        # 见 §1.2
    ro    = inheritedReadonly || m.readonly                       # D20 并集
    if m.kind == 'repo':
      emit PlannedRepo{ m.cachedRepoId, m.ref, m.subdir, mount, ro,
                        viaGroups: chain + [group.id] }
    else:
      flatten(load(m.childGroupId), mount, ro, depth+1, chain+[group.id])
  if emitted.length > MAX_FLAT_REPOS(32): throw repo-group-too-many-repos
```

环检测用 `chain`（**当前递归路径**）而非全局 visited 集：同一个内层组被两个不同
的外层成员各引用一次是**合法**的（会被展平两次，落到两个不同挂载点），只有出现在
自己的祖先链里才是环。

### 1.2 挂载路径代数

```
joinMount(prefix, own):
  if own == '':  return prefix          # 内层组的"根成员"落在外层给它的挂点上
  if prefix == '': return normalize(own)
  return normalize(prefix + '/' + own)
```

`normalize` 规则（建组期校验 + 展平期再跑一次）：

| 规则 | 拒绝原因码 |
| --- | --- |
| 必须是相对路径（不以 `/` 开头，无 Windows 盘符） | `mount-path-absolute` |
| 任一段不得为 `.` 或 `..` | `mount-path-traversal` |
| 不得含 `\r` `\n` `\\` | `mount-path-unsafe-char` |
| 折叠重复 `/`、去尾 `/`；折叠后不得为空（除非本来就是 `''`） | `mount-path-empty` |
| 展平结果里**不得重复**（精确相等） | `mount-path-duplicate` |
| 展平结果里**至多一个** `''` | `mount-path-multiple-roots` |

**刻意不校验的**：一个挂载点是另一个的前缀（`''` 与 `vendor/b`、`a` 与
`a/vendor/c`）——这正是嵌套，是本 RFC 的目的。

### 1.3 包含关系与排除计划

展平后按挂载路径构造一棵树，用于两件事：**建 worktree 的顺序** 与 **每个仓要排除
哪些路径**。

```
containerOf(p):  挂载路径集合中，p 的最长严格前缀（按路径段边界匹配），无则 null
directChildren(p): { c | containerOf(c) == p }
```

- `''`（挂根）是所有其它挂载点的容器。没有仓挂根时，容器为 `null` 的挂载点直接
  落在任务根这个**普通目录**下，无需任何排除。
- **仓 P 的排除清单** = `directChildren(P)` 中每个 `c` 相对 P 的路径
  （`c.slice(P.length + 1)`，P 为 `''` 时就是 `c`），外加多仓任务里的
  `.agent-workflow-inputs`（仅当 P 挂根，D12）。
- 只排除**直接**子节点即可：`vendor/b` 被 `''` 排除后，`vendor/b/sub/c` 已经在被
  排除的子树里，外层看不到；但 `vendor/b` 这个仓自己仍要排除 `sub/c`。

## 2. 数据模型

### 2.1 新表

```sql
CREATE TABLE repo_groups (
  id                 TEXT PRIMARY KEY,             -- ULID
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  version            INTEGER NOT NULL DEFAULT 1,   -- PUT 时自增
  created_by_user_id TEXT,                         -- 审计展示用，NOT 一个 ACL owner
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  schema_version     INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX idx_repo_groups_name_ci ON repo_groups (lower(name));

CREATE TABLE repo_group_members (
  group_id       TEXT NOT NULL REFERENCES repo_groups(id) ON DELETE CASCADE,
  member_index   INTEGER NOT NULL,
  kind           TEXT NOT NULL,                    -- 'repo' | 'group'
  cached_repo_id TEXT REFERENCES cached_repos(id), -- kind='repo'
  ref            TEXT NOT NULL DEFAULT '',         -- '' = 该仓默认分支（D6）
  subdir         TEXT NOT NULL DEFAULT '',         -- '' = 整仓；否则 sparse（D17）
  child_group_id TEXT REFERENCES repo_groups(id),  -- kind='group'
  mount_path     TEXT NOT NULL DEFAULT '',         -- '' = 挂根（D2）
  readonly       INTEGER NOT NULL DEFAULT 0,       -- D11
  PRIMARY KEY (group_id, member_index),
  CHECK (kind IN ('repo','group')),
  CHECK (
    (kind = 'repo'  AND cached_repo_id IS NOT NULL AND child_group_id IS NULL) OR
    (kind = 'group' AND child_group_id IS NOT NULL AND cached_repo_id IS NULL)
  ),
  CHECK (kind = 'repo' OR (ref = '' AND subdir = ''))   -- 组成员不带 ref/subdir（D19）
);
CREATE INDEX idx_rgm_cached_repo  ON repo_group_members (cached_repo_id);
CREATE INDEX idx_rgm_child_group  ON repo_group_members (child_group_id);
```

`cached_repo_id` / `child_group_id` 上**不加** `ON DELETE CASCADE`：删除走
`services/repoGroup.ts` 的显式守卫（D13），静默级联会让组悄悄变形。

### 2.2 既有表改动

```sql
ALTER TABLE tasks      ADD COLUMN repo_group_id   TEXT;     -- 溯源 + 记忆注入（D4/D8）
ALTER TABLE tasks      ADD COLUMN repo_group_name TEXT;     -- 组名快照（设计门 G5）
-- 名字快照的作用：组被删除后任务详情的 chip 仍能渲染名字，而不是退化成悬空 id。
-- 与 D8「启动时快照」一致；task_repos 本就是快照，删组不影响在跑任务的布局。

ALTER TABLE task_repos ADD COLUMN mount_path       TEXT NOT NULL DEFAULT '';
ALTER TABLE task_repos ADD COLUMN subdir           TEXT NOT NULL DEFAULT '';
ALTER TABLE task_repos ADD COLUMN readonly         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_repos ADD COLUMN gitignore_commit TEXT;    -- D1 预置 commit sha
UPDATE task_repos SET mount_path = worktree_dir_name;       -- 存量平铺 = basename 即挂载路径
-- 随后重建 task_repos 去掉 worktree_dir_name（bun:sqlite 无 in-place DROP COLUMN，
-- 沿用 0035 / 0041 / 0057 的建新表 + INSERT SELECT + RENAME 套路）
```

`memories` 表重建以扩 CHECK：

```sql
CHECK (scope_type IN ('agent','workflow','repo','repo_group','global'))
```

**先例必须取 `0117_rfc223_fusion_provenance.sql:119-190`，不是 0048。**
`memories` 带两条自引用 FK（`supersedes_id` / `superseded_by_id` →
`memories.id`）；0117 的注释明确指出，把 `__new_memories` rename 成
`memories` 时 SQLite 是否重写这两条自引用**依赖 `legacy_alter_table` 模式**，
而 daemon 迁移期跑在 `foreign_keys=OFF`、直连 migrator 与测试跑在 `ON`。
因此必须用 0117 的顺序：`RENAME TO __old_memories` → `CREATE TABLE memories`
（直接建最终名）→ `INSERT SELECT` → `DROP __old_memories` → 重建 4 个索引。
列清单以 0117 的 **24 列**为准（0048 那版缺 `fused_into_skill_id`）。

`(scope_type='global' AND scope_id IS NULL) OR (scope_type<>'global' AND scope_id IS NOT NULL)`
这条不变——`repo_group` 属于「非 global」一侧。

### 2.3 shared schema

```ts
// packages/shared/src/schemas/repoGroup.ts（新增）
export const MAX_GROUP_DEPTH = 5
export const MAX_FLAT_REPOS = 32          // 取代 MULTI_REPO_MAX=8 的语义

export const RepoGroupMemberSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('repo'),
    cachedRepoId: z.string().min(1).optional(),
    repoUrl: z.string().min(1).optional(),   // D7：不在缓存里则导入后回填 id
    ref: z.string().default(''),
    subdir: z.string().default(''),
    mountPath: z.string().default(''),
    readonly: z.boolean().default(false),
  }).refine(v => (v.cachedRepoId === undefined) !== (v.repoUrl === undefined),
            { message: 'cachedRepoId ⊕ repoUrl' }),
  z.object({
    kind: z.literal('group'),
    childGroupId: z.string().min(1),
    mountPath: z.string().default(''),
    readonly: z.boolean().default(false),
  }),
])

export const PlannedRepoSchema = z.object({
  cachedRepoId: z.string(),
  repoUrlRedacted: z.string(),            // 出网只给脱敏形态（RFC-204）
  ref: z.string(),
  subdir: z.string(),
  mountPath: z.string(),
  readonly: z.boolean(),
  viaGroups: z.array(z.object({ id: z.string(), name: z.string() })),
})
```

`MemoryScopeSchema`（`shared/src/schemas/memory.ts:7`）扩为
`z.enum(['agent','workflow','repo','repo_group','global'])`。

`StartTaskSchema`（`shared/src/schemas/task.ts:569`）：删 `repos`，加
`repoGroupId: z.string().min(1).optional()`；三态互斥的 superRefine 在既有
`start-task-source-conflict` 分支里扩一条。`StartWorkgroupTaskSchema`
（`shared/src/schemas/workgroup.ts:597`）同步。

`PERMISSIONS`（`shared/src/schemas/permission.ts:108`）新增 `'repos:update'`，
并改掉第 22 行与第 108 行「no PUT/PATCH route exists in the repos domain」的注释
——本 RFC 引入了 `PUT /api/repo-groups/:id`，那条断言不再成立。

**同时必须加进 `MANAGER_EXTRA`**（`schemas/permission.ts:344-350`）。repos 域
**不在** ACL 模型里，它的能力完全靠那张手工表授予（表上方的注释就写着
「Repos are out of the ACL model, so the repos points are plain points here」）；
漏了这一步，manager 能建组却对 `PUT` 拿 403，也无法给 PAT 授权（设计门 G4）。

### 2.3a 启动入口契约迁移表（设计门 G1）

`repos[]` 的断代必须**同时**覆盖下面每一行，漏一行就留一个「静默在错误工作区
启动」的洞。实现期逐行核对并打勾：

| # | 入口 | 现状 | 目标 |
| --- | --- | --- | --- |
| 1 | `StartTaskSchema`（`schemas/task.ts:569`） | `repos[]` | `repoGroupId` |
| 2 | `StartAgentTaskSchema`（`schemas/task.ts:1267`） | `repos[]` | `repoGroupId` |
| 3 | `StartWorkgroupTaskSchema`（`schemas/workgroup.ts:597`） | `repos[]` | `repoGroupId` |
| 4 | scheduled payload 各档（`schemas/scheduledTask.ts`，agent 档继承 #2） | 继承 | 跟随 #1–#3 |
| 5 | `LaunchSpaceFields` + `applySpaceFields`（`schemas/task.ts:701-715`） | 只透传 `repos` | 透传 `repoGroupId` |
| 6 | REST：JSON 与 multipart 两条启动路径 | — | 两条都过退役键守卫 |
| 7 | MCP `launch_task` 工具（`backend/src/mcp/tools.ts`） | 无 `repoGroupId` | 加参数 + 去 `repos` |
| 8 | e2e fixture / 测试夹具 | `repos[]` | `repoGroupId` |

**退役键守卫**（`RETIRED_START_TASK_KEYS`，`schemas/task.ts:730`）当前是
`['repoPath','baseBranch','fetchBeforeLaunch']`，**没有顶层 `repos`**。
StartTask 用的是非 strict zod，所以删字段后旧客户端传 `repos` 会被**静默剥除**
并成功启动在错误工作区。因此：

- 顶层 `'repos'` **加进** `RETIRED_START_TASK_KEYS`；
- `rejectRetiredStartTaskKeys` 里把 `repos` 当数组遍历查行内退役键的那段
  （`schemas/task.ts:738-747`）**删除**——顶层已硬拒，那段不可达；
- 守卫必须在**任何 schema parse 之前**执行，且三个启动面都要确认接上
  （实现期逐面核实，不假设已接）。

## 3. Git 机制

### 3.1 排除与预置 commit（D1）

对每个**有直接子节点**的仓 P，在它的 worktree 建好之后、子节点 worktree 建立
之前：

```
1. 读 <P>/.gitignore（不存在视作空）
2. 计算待加规则 = directChildren(P) 相对 P 的路径，各写成 "/<rel>/"
   （多仓任务且 P 挂根时追加 "/.agent-workflow-inputs/"）
3. 过滤掉已存在的规则行（精确字符串匹配）→ 幂等
4. 若过滤后为空 → 跳过，base_commit 仍取 worktree 当前 HEAD（无空 commit）
5. 否则：追加一个带说明的区块 → git add .gitignore
   → git -c user.name=<RFC-067 身份> -c user.email=<…> commit
        -m "chore(agent-workflow): exclude nested repo mounts"
6. task_repos.gitignore_commit = 新 commit sha
   task_repos.base_commit      = 新 commit sha
```

写入的区块形态（便于人识别与幂等匹配）：

```gitignore

# >>> agent-workflow: nested repo mounts (task <taskId>) >>>
/vendor/b/
/third_party/c/
/.agent-workflow-inputs/
# <<< agent-workflow: nested repo mounts <<<
```

**为什么必须是 commit 而不是工作区改动**：实测 `M .gitignore` 会出现在每一份
审计 diff 里，并被 `git add -A`（`services/commitPushRunner.ts:244`）提交推送到
远端；而 ignore 规则**只作用于未跟踪文件**，没有办法让 `.gitignore` 忽略自己的
修改。把它做成 `base_commit` 之前的一笔，审计 diff（`base_commit..工作树`）就
彻底干净。

**幂等的必要性**：RFC-075 的 `workingBranch` 允许复用一条真实开发分支，同一条
分支上跑多个任务时不能累积多个相同 commit。

### 3.2 sparse checkout（D17）

```
git -C <mirror> worktree add --no-checkout <mountAbs> -b <branch> <baseCommit>
git -C <mountAbs> sparse-checkout set --no-cone '/<subdir>/'
git -C <mountAbs> checkout
```

实测（§3.6 E5/E6）：

- 模式文件落在 `$GIT_DIR/info/sparse-checkout`，是 **per-worktree** 的——同一
  镜像的其它任务 worktree 完全不受影响。
- 非 cone 模式下挂点里**只有** `<subdir>/`；cone 模式会连带检出仓根级文件。
- `status` 干净，`add -A` / `diff` 对已检出子树行为正常；未检出路径带
  `skip-worktree` 位，不会被误报为删除。

`subdir` 为空时**完全不碰** sparse 配置（保 baseline）。

### 3.3 分支命名（D14）

```
sameRepoOccurrences = planned.filter(p => p.cachedRepoId === cur.cachedRepoId)
n = 该仓在 planned 里的第几次出现（1-based，按 repo_index）
branch = n === 1 ? `agent-workflow/${taskId}` : `agent-workflow/${taskId}-${n}`
```

`workingBranch`（RFC-075）被指定时同理加后缀，否则同源仓的第二个 worktree 会撞
`fatal: '<branch>' is already checked out`。

### 3.4 与子模块（RFC-034 / RFC-210）的叠加

- 每个成员独立跑 `submodule update --init`，失败只影响该成员（沿用
  `services/task.ts:1333` 的 per-repo 警告路径）。
- **sparse 成员**：只对已检出子树内的子模块初始化。未检出路径下的子模块跳过，
  在 `task_repos.submodule_init_error` 记 `skipped-by-sparse:<path>`。理由是
  未检出路径下的 gitlink 带 `skip-worktree`，`submodule update` 本就不会去动它，
  显式记录避免下游误判成失败。
- **嵌套成员**：外层仓的 `.gitmodules` 与我们造的挂载点互不相干（挂载点被
  `.gitignore` 排除，不会被识别为子模块）。但**若外层仓自己在该路径上就有一个
  子模块**，`git worktree add` 会撞上已存在的非空目录 → 走失败模式 F3。

### 3.5 只读成员（D11）

| 环节 | 只读成员的行为 |
| --- | --- |
| worktree 物化 | 与可写成员完全一致（要 checkout 出来给 agent 读） |
| `.gitignore` 预置 commit | **照做**（D21）——只影响这个一次性 worktree |
| `gitStashSnapshot` / `pre_snapshot_repos_json` | **跳过**（不写条目） |
| resume / retry 回滚 | **跳过** |
| `wrapper-git` 的 `git_diff` | **不参与** |
| `GET /api/tasks/:id/diff` / 结构化 diff | **不参与** |
| RFC-075 自动提交推送 | **跳过** |
| 任务进入终态时 | 跑一次 `git status --porcelain`；非空 ⇒ 落一条任务级告警事件 `repo-group-readonly-dirty`，带挂载路径与变更文件数（截断到前 20 条）。**不改任务状态**。 |

### 3.6 实测脚本

```bash
# E1/E2 —— 嵌套 worktree 在外层的可见性与 add -A 的后果
git -C outer worktree add "$W" -b wt1
git -C inner worktree add "$W/vendor/innerlib" -b wt1
git -C "$W" status --short          # → ?? vendor/
git -C "$W" add -A                  # → warning: adding embedded git repository
                                    #   A  vendor/innerlib        （坏 gitlink）

# E3 —— info/exclude 是 common-dir 级的
echo '/vendor/innerlib/' > outer/.git/worktrees/wt/info/exclude   # 无效
echo '/vendor/innerlib/' > outer/.git/info/exclude                # 生效，但会
                                                                  # 影响同镜像所有 worktree

# E4 —— per-worktree excludesFile 可行且不泄漏（本 RFC 未采用，备查）
git -C outer config extensions.worktreeConfig true
git -C "$W" config --worktree core.excludesFile "$W_GITDIR/aw-exclude"

# E5/E6 —— sparse 是 per-worktree 的，非 cone 能只留子目录
git -C docs worktree add --no-checkout "$M" -b b1
git -C "$M" sparse-checkout set --no-cone '/guides/'
git -C "$M" checkout
ls -A "$M"                          # → guides            （只有它）
git -C "$M" status --short          # → （空）
git -C docs worktree add "$M2" -b b2 && ls -A "$M2"   # → api guides README.md（不受影响）

# E7 —— worktree add 到已存在目录
git -C docs worktree add "$NONEMPTY" -b b3   # → fatal: '<path>' already exists
git -C docs worktree add "$EMPTYDIR"  -b b4  # → 成功
```

### 3.7 端到端物化原型（E8）

`design/RFC-248-repo-groups/materialize-prototype.sh` 是本节全部机制拼在一起的
**可复跑**原型，布局刻意覆盖每一种成员形态：

```
''              → app          可写，挂根
vendor/sdk      → sdk          只读，嵌在 app 工作树里
vendor/sdk/ext  → ext          可写，三层嵌套（嵌在 sdk 里）
site/docs       → docs@guides  可写，sparse 子目录挂载，嵌在 app 里
compare/main    → app（第二份）可写，同仓复用 → 分支带序号
```

跑出来的关键断言（`bash design/RFC-248-repo-groups/materialize-prototype.sh`）：

```
物化后各仓 status          ：全部干净（5/5）
sparse 挂点内容            ：只有 guides
<root> app   diff          ：tracked=[src/main.ts] untracked=[newfile.md]
                             ← 不含 .gitignore / vendor/sdk / site/docs /
                               compare/main / .agent-workflow-inputs
vendor/sdk(ro) diff        ：tracked=[lib/sdk.ts]   ← 可独立检出以发告警
vendor/sdk/ext diff        ：tracked=[ext/plug.ts]  ← 三层嵌套不串味
site/docs      diff        ：tracked=[guides/g1.md]
add -A（仅可写仓）          ：各自只暂存自己的文件，零 embedded-repo 告警
幂等复检                    ：规则已存在 → 跳过 commit
分支名                      ：agent-workflow/T01HZZ / agent-workflow/T01HZZ-2
```

PR-3 的集成测试（design §10.2）应当是这份原型的 TypeScript 化，**逐条断言同一批
不变量**。

## 4. 启动流水线

### 4.1 入口与形态判定

`services/task.ts` 的 `resolveRepoSpecs`（今天把 legacy 单仓字段与 `repos[]`
折叠成统一数组）改为三态分派：

```
scratch                       → 既有 scratch 路径，不变
单仓（repoUrl ⊕ cachedRepoId）→ PlannedRepo × 1，mountPath='', subdir='', readonly=false
repoGroupId                   → loadGroup → flatten → PlannedRepo[]
```

**单成员且挂根**（无论来自单仓直启还是只含一个根成员的组）走
`materializeSingleRepo`，路径 `~/.agent-workflow/worktrees/{repoSlug}/{taskId}`，
与今天字节级一致（AC-10）。其余走 `materializeGroupSpace`，根路径
`~/.agent-workflow/worktrees/group/{taskId}`。

> `worktrees/multi/` 命名空间退役。**不**做目录迁移——存量任务的
> `tasks.worktree_path` 是绝对路径存量值，继续指向老目录即可；GC 按
> `worktree_path` 删，天然覆盖。

### 4.2 物化顺序

```
planned = flatten(group)                       # §1.1
planned.sort(by mountPath 段数升序, 同深度按 member 展平序)
assignBranchSuffixes(planned)                  # §3.3
mkdirSync(taskRoot)  除非有成员挂根            # 挂根时由 worktree add 自己建

for depth in 0..maxDepth:                      # 逐层
  同层成员可并发（互不包含），层间串行
  for p in planned where depth(p) == depth:
    ensureParentDirs(taskRoot + p.mountPath)
    createWorktree(p)                          # sparse 见 §3.2
    registerCleanupLease(p)                    # 立即登记，晚于它的失败也能回收
  for p in planned where depth(p) == depth and directChildren(p).length > 0:
    writeGitignorePresetCommit(p)              # §3.1，必须在建子层之前
```

层间串行 + 「先写排除再建子层」这两条顺序约束是硬的：子层 worktree 一旦落进
父层工作树，父层的 `git add .gitignore` 就会把它当未跟踪目录一起吞（E2）。

### 4.3 失败与回收

沿用 `createMaterializedSpaceCleanup` / `cleanupMaterializedSpaceLease`
（`services/task.ts:1279`）。新增点：

- 预置 commit 失败时该仓的 worktree 已登记 lease，整体回滚照常。
- **回收按挂载深度倒序**（内层先删）。实测（E9）表明正序也不会坏账——
  `git worktree remove --force <outer>` 会连带删掉内层目录，内层镜像的注册被
  git 标成 `prunable`，随后对已消失路径再跑 `worktree remove --force`
  **仍返回 0** 并把注册表清干净，`cleanupCreatedWorktree`
  （`util/git.ts:616`）的 `exitCode !== 0` 判据不会误报失败。但倒序不依赖这条
  自愈行为，且让「删除失败」这件事仍然可归因到具体某个仓，所以**倒序是要求，
  不是优化**。集成测试要同时锁住两种顺序都不留悬空注册。

### 4.4 `base_commit` 与 `baseRef` 的分离

引入预置 commit 后，`task_repos.base_commit` 不再等于「base 分支的 tip」。两个
消费者要区别对待：

| 消费者 | 用哪个 |
| --- | --- |
| 审计 diff / 结构化 diff / `wrapper-git` 快照基线 | `base_commit`（= 预置 commit，干净） |
| RFC-075 提交信息生成里的 `baseRef` 文案、PR 基线描述 | `base_branch`（分支名，不变） |
| `rollbackToSnapshot` / `pre_snapshot` | 与 `base_commit` 无关，走 stash sha，不变 |

`task_repos.gitignore_commit` 单独存一列，便于「这一笔到底是不是平台造的」在
排查与 UI 上一眼可判，也让「预置 commit 的父提交才是真 base tip」可推导。

## 5. 失败模式

| 码 | 触发 | HTTP | 处置 |
| --- | --- | --- | --- |
| `repo-group-name-conflict` | 组名（大小写不敏感）已存在 | 409 | — |
| `mount-path-*`（§1.2 六种） | 挂载路径非法 | 422 | 带成员下标 |
| `repo-group-cycle` | 组引用成环 | 422 | 带环路径 `[A → B → A]` |
| `repo-group-depth-exceeded` | 展平深度 > 5 | 422 | 带超深的链 |
| `repo-group-too-many-repos` | 展平后 > 32 | 422 | 带实际数量 |
| `repo-group-member-not-found` | 引用的仓 / 组不存在 | 422 | — |
| `repo-group-has-references` | 删组时被别的组引用 | 409 | 列出引用者；`force=1` 摘除 |
| `cached-repo-has-group-references` | 删仓时被组引用 | 409 | 与既有 `CachedRepoHasReferencesError` 并列返回 |
| `repo-group-mount-occupied` | **F3**：`git worktree add` 撞上外层仓自身已有内容（E7） | 422（启动期） | 带 `mountPath` + 占用它的仓的挂载路径 |
| `repo-group-ref-not-found` | 某成员的 ref 在其仓里不存在 | 422 | 复用 `repo-ref-not-found` 的 `availableRefs` 形态，带 `mountPath` |
| `repo-group-sparse-empty` | sparse 模式检出后目录为空（`subdir` 在该 ref 上不存在） | 422 | 带 `mountPath` + `subdir` |

F3 的判定**必须在启动期**，不能在建组期——外层仓在不同 ref 上有没有那个路径是会
变的。建组期只做静态校验（§1.2），运行期做占用校验。

## 6. 标签、diff 与分片

### 6.1 规范 key（D15）

`services/repoLabels.ts` 重写：

```ts
/** 规范 key = 挂载路径；挂根为 ''。线上/展示形态用 '.' 表示根。 */
export function repoKey(r: { mountPath: string }): string { return r.mountPath }
export function repoKeyWire(r: { mountPath: string }): string {
  return r.mountPath === '' ? '.' : r.mountPath
}
export function parseRepoKeyWire(s: string): string { return s === '.' ? '' : s }
```

删除 `sanitizeLabel`（把 `/` 换成 `-`）与 basename + 数字后缀 uniquing——挂载
路径已在建组期校验唯一且安全（无 CR/LF/反斜杠），再 sanitize 反而会把 `apps/web`
毁成 `apps-web`。`.` 不可能与真实挂载路径冲突（`normalize` 拒绝 `.` 段）。

调用点：`services/worktreeFileContent.ts:151`、`services/changeNarrative.ts:124`、
`services/task.ts:3941`、`services/structuralDiff/service.ts:147,238`。

**已核实这些调用点只把标签当标识符用**（`Map` 键、结构化前缀、
`?repo=` 查询参数），**从不**拿它当文件系统路径组件，所以带 `/` 的挂载路径不会
在任何一处被当成目录层级展开。两个连带契约点：

- `worktreeFileContent.ts:145-155` 的 `?repo=` 参数值现在是挂载路径，前端必须
  `encodeURIComponent`；根仓传 `.`。查不到时的 404 码
  `file-content-repo-not-found` 不变。
- `structuralDiff/service.ts:239` 的 `perRepoNodeRuns(rows, repo.worktreeDirName)`
  是 `worktreeDirName` 的又一个消费者，随 T26 一并迁到 `mountPath`。

### 6.2 文本 diff 拼接

`services/task.ts:3946` 的 `# === Repo: ${label} ===` 改用 `repoKeyWire`。
**单仓任务（挂根单成员）不产生任何分段头**——与今天字节级一致（AC-23）。
只读成员整段不出现（D11）。

前端 `components/DiffViewer.tsx:89` 的 `REPO_MARKER` 正则不变（`(.+)` 已经能吃
带 `/` 的 key），但把捕获到的字符串过 `parseRepoKeyWire`。

### 6.3 结构化 diff 与文本 diff 的关联

`lib/changeReview.ts` 今天靠「label + `/` + 仓内路径」拆分。挂载路径本身含 `/`，
所以拆分改为**按已知 key 集合做最长前缀匹配**：

```ts
function splitRepoPrefix(fullPath: string, keys: readonly string[]): [string, string] {
  // keys 已按长度降序；'' 永远最后（兜底）
  for (const k of keys) {
    if (k === '') return ['', fullPath]
    if (fullPath === k) return [k, '']
    if (fullPath.startsWith(k + '/')) return [k, fullPath.slice(k.length + 1)]
  }
  return ['', fullPath]
}
```

key 集合从任务的 `task_repos` 派生，前后端同源（后端在**文本 diff 与结构化
diff 两类响应里都**带上 `repoKeys: string[]`，前端不自己猜）。

#### 结构化 diff 的根成员必须不加前缀（设计门 G3）

现状的不变量是「**加前缀 ⟺ 多仓**」：

- 单仓走 `structuralDiff/service.ts:95-118` 的**早分支**，直接
  `computeFromWorktree`，**完全不加前缀**（`src/a.ts`），与文本 diff 单仓
  无分段头的形态一致；
- 多仓走 `service.ts:147-172` → `mergeStructuralDiffs`
  （`assemble.ts:224-252`），而 `prefixPath = (label, fp) => \`${label}/${fp}\``
  （`assemble.ts:147`）是**无条件**的。

把根成员的 key `''` 直接塞进现有 assembler 会产出 `/src/a.ts`（用 wire 形态
`.` 则是 `./src/a.ts`），**两者都不等于**文本 diff 的 `src/a.ts`；
`frontend/src/lib/changeReview.ts:168-180` 靠路径逐字符相等来 join 两侧，
于是根仓的符号、严重度、文件内容与导航会**静默脱节**。

修法：`prefixPath` 改为

```ts
const prefixPath = (label: string, fp: string): string => (label === '' ? fp : `${label}/${fp}`)
```

`assemble.ts:140-146` 的注释列出了 7 类必须同步前缀的嵌入路径（file path、
symbol id/parentId、edge 端点、impact refs、classEdge 端点/成员、card id、
hunkAnchor），**全部经由 `prefixPath` 与 `prefixIdPath`**，所以改这两个函数
即可覆盖。改后：

- 单仓（根成员 + 计数 1）继续走早分支 → **baseline 字节级不变**；
- 组任务里根成员无前缀、其余成员前缀 = 挂载路径 → 与文本 diff **逐字符相等**。

**为什么最长前缀匹配按构造无歧义**（这条要配专门的回归测试）：容器仓永远
不可能产出落在某个挂载点前缀下的路径——挂载点在启动期就被证明在容器仓里不存在
（E7 占用校验：`git worktree add` 到已存在非空目录直接 fatal ⇒
`repo-group-mount-occupied`），之后又被 `.gitignore` 预置 commit 排除。
所以「根仓的 `src/a.ts`」与「挂在 `src` 的成员的 `a.ts`」不可能同时存在。

**被否决的替代方案**：设计门建议「给结构化实体加独立 `repoKey` 字段、彻底
不用字符串前缀承载身份」。未采纳——字符串前缀是 RFC-089/239/240/241 与前端
join 的既有承重结构，替换是跨四个 RFC 的大重构，而上面那条构造性不变量已经
消除了歧义。深层关切（身份不该编码进字符串）如实登记进
`docs/audit-backlog.md`，留给未来的结构化 diff 重构 RFC。

### 6.4 `wrapper-git` 多仓（D9）

`services/scheduler.ts:558` 的 `multi-repo-wrapper-git-unsupported` 删除。包裹器
的前后快照改为遍历 `state.repos.filter(r => !r.readonly)`：

```
enter: for each writable repo → snapshot(repo, 'base')
exit:  for each writable repo → diff(repo, baseSnapshot)
       git_diff = 非空段按 repo_index 顺序拼接，每段前置 `# === Repo: <keyWire> ===`
```

单个可写仓时不加分段头（与 §6.2 同规则），因此**单仓工作流的 `git_diff` 端口
内容字节级不变**。

### 6.5 扇出分片带仓前缀（D15 / AC-20）

`util/diffSplit.ts` 的 `parseDiff` / `splitDiffPerFile` / `splitDiffPerNFiles` /
`splitDiffPerDirectory` 增加一个可选的「当前仓 key」游标：解析时遇到
`# === Repo: X ===` 行就切换游标，产出的 `shard_key` = `join(key, 仓内路径)`
（key 为 `''` 时就是仓内路径本身）。`per-directory` 的目录键同样带前缀，所以
两个仓里的同名目录不会被合并成一个分片。

## 7. 记忆（D4）

`services/memoryInject.ts`：

- `InjectableSet.byScope` 加 `repoGroup: InjectableMemoryRow[]`。
- `loadInjectableMemories` 入参加 `repoGroupId: string | null` 与
  `repoIds: string[]`（**复数**——组启动时有 N 个成员仓）。第 146 行的
  `eq(memories.scopeId, opts.repoId)` 改 `inArray(memories.scopeId, opts.repoIds)`。
- `resolveInjectScope`（第 385 行）从 `tasks.repo_group_id` 取组 id，从
  `task_repos.cached_repo_id`（去重，含只读成员）取仓 id 数组。
- 预算：`ScopeBudget` 加 `repoGroup` 档，与其余四档一样**独立裁剪**（现有实现
  就是 per-scope 独立，不存在跨档抢额度）。成员仓的 N 份 repo 记忆共用既有
  `budget.repo` 档，按 `createdAt DESC` 统一排序后裁剪。
- 单仓直启时 `repoGroupId = null` ⇒ 组记忆不注入（D4 / AC-28）。

`services/memory.ts` 的可见性/管理判定（第 743 / 758 / 807 行）把
`'repo_group'` 与 `'repo'` `'global'` 归为同一类：全员可读、仅 admin 可管
（AC-29）。

**删组时的记忆生命周期（设计门 G5）**。上面那三处对 repo/global 是**在加载
资源行之前就 return true**，fail-closed 分支只覆盖 agent/workflow。所以
`repo_group` 一旦并进这一档，删组就会留下**仍可列出、仍会被注入**的孤儿记忆
（`tasks.repo_group_id` 还留着旧 id，注入照样命中）。处置：

```
deleteRepoGroup(id) 事务内：
  1. 校验引用（其它组引用它 → 409，除非 force）
  2. UPDATE memories SET status='archived'
       WHERE scope_type='repo_group' AND scope_id=:id AND status<>'archived'
     → 返回受影响条数
  3. DELETE FROM repo_group_members WHERE group_id=:id （或 force 时的摘除）
  4. DELETE FROM repo_groups WHERE id=:id
```

用 `archived` 而不是硬删：保住用户知识，且 `memoryInject` 本就按
`status='approved'` 过滤（`memoryInject.ts:155`），注入立即停止。DELETE 响应体
带 `archivedMemories: number`，前端确认弹窗在删除前先调 `GET /:id` 拿到该计数
并显示。

前端 `components/memory/MemoryFormFields.tsx:132` 的 `SCOPE_OPTIONS` 加第 5 档，
`scopeIdOptions` 加 `repoGroups` 数据源。

## 8. HTTP 契约

全部经 `registerRoute`（RFC-247 路由元数据层）声明。

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/repo-groups` | `repos:read` | 列表（含成员数、展平仓数） |
| POST | `/api/repo-groups` | `repos:create` | 建组；成员 URL 未缓存时同步导入 |
| GET | `/api/repo-groups/:id` | `repos:read` | 详情（成员原始定义，URL 脱敏） |
| GET | `/api/repo-groups/:id/layout` | `repos:read` | 展平预览（`PlannedRepo[]` + 总数 + 深度） |
| PUT | `/api/repo-groups/:id` | `repos:update` | 全量替换成员，`version` 自增 |
| DELETE | `/api/repo-groups/:id` | `repos:delete` | `?force=1` 摘除引用；PAT 走 type-to-confirm（回显组名） |

所有响应里的仓 URL 只出 `urlRedacted`（RFC-204）。`POST` / `PUT` 接受
`repoUrl`，服务端 resolve 后只回 id + 脱敏 URL。

`DELETE /api/cached-repos/:id`（`routes/cached-repos.ts:72`）的 409 详情体扩一个
`referencingGroups: [{ id, name }]` 字段。

## 9. 前端

### 9.1 `/repos` 页

在 `routes/repos.tsx` 现有 `OperationsToolbar` + `TableViewport` 骨架之上，用
既有 `<Segmented>` 加「远端仓库 | 仓库组」两档（RFC-150 的分段 tabbar 模式，
与 RFC-246 的四业务视图并存：分段在外、业务视图在内）。

### 9.2 组编辑器

一个 `<Dialog>`（`components/Dialog.tsx`）承载：

- 名称 / 描述 → `<Field>` + `<TextInput>` / `<TextArea>`
- 成员表格，每行：
  - 类型 → `<Segmented>`（仓库 / 仓库组）
  - 目标 → `<Select>`（已导入仓 / 已有组）+ 一个「粘 URL」`<TextInput>`（D7）
  - 挂载路径 → `<TextInput>`（placeholder `留空 = 挂在根目录`）
  - ref / 子目录 → `<TextInput>`（`kind='group'` 时禁用）
  - 只读 → `<Switch>`
  - 删除 → `.btn.btn--sm.btn--danger`
- 右侧实时**布局预览树**（调 `/layout`，debounce 400ms），显示展平结果、总仓数、
  只读标记、`viaGroups` 来源链；校验错误就地红字。

**不新造任何 modal chrome / 表单原语 / 下拉**——违反 CLAUDE.md 的前台统一风格
强制原则。布局预览树若需新组件，作为公共 `components/repos/RepoLayoutTree.tsx`
落地（任务详情 header 也要复用它）。

### 9.3 启动表单（D10）

`routes/tasks.new.tsx` 的「执行空间」段：

- 一个 `<Select>`，选项 = 远端仓库 ∪ 仓库组，各带 `[仓库]` / `[组]` 前缀标签。
- 下方保留「或：粘一个新的仓库 URL」`<TextInput>` 与「临时空间」开关。
- `components/launch/RepoSourceList.tsx`（+/− 多行容器）**删除**；
  `RepoSourceRow.tsx` 退化为单仓的 URL + ref 两个字段（供 URL 直启用）。
- 选中组时下方展开只读的布局预览（复用 `RepoLayoutTree`）+ 「共 N 个仓库」提示。
- `multiRepoBlockedReason`（`tasks.new.tsx:803`）的 wrapper-git / upload 两个门
  **删除**。

### 9.4 任务详情

header 的多仓 chip 改为「组名 + N 个仓库」，展开是 `RepoLayoutTree`（只读态，
带每仓 ref 与只读标记）。非组启动的多仓任务（存量）继续显示「N repos」。
只读成员被改动时，在 header 下方出一条既有 `<ErrorBanner variant="warning">`
形态的提示。

## 10. 测试策略

按 CLAUDE.md「测试随每次改动落地」，下列是**必写**清单。

### 10.1 纯函数（首选可断言面）

| 文件 | 锁什么 |
| --- | --- |
| `repo-group-flatten.test.ts` | `flatten()`：嵌套前缀拼接、只读并集（D20）、同组被两处引用不算环、自引用/互引用成环、深度 6 拒绝、展平 33 拒绝、内层根成员落到外层挂点 |
| `repo-group-mount-path.test.ts` | `normalize` 六条规则 × 边界；重复挂载点；多个根；`''` 与 `vendor/b` 共存**合法** |
| `repo-group-containment.test.ts` | `containerOf` / `directChildren`：路径段边界匹配（`a/bc` 不是 `a/b` 的子）、三层嵌套只排直接子、无根仓时容器为 null |
| `repo-group-branch-suffix.test.ts` | 同仓出现 1/2/3 次的分支名；与 `workingBranch` 叠加 |
| `repo-labels.test.ts`（改写） | `repoKey` / `repoKeyWire` / `parseRepoKeyWire`；**回归**：`apps/web` 不得被 sanitize 成 `apps-web` |
| `diff-split-repo-prefix.test.ts` | `# === Repo: X ===` 游标切换；`per-file` / `per-N` / `per-directory` 三种分片的 key 前缀；根仓（`.`）无前缀 |
| `gitignore-preset-block.test.ts` | 区块生成、幂等过滤、全部已存在 ⇒ 返回「无需 commit」 |

### 10.2 集成（真 git）

| 场景 | 断言 |
| --- | --- |
| 挂根 + 嵌套 | 外层 `git status` 干净；`add -A` 不吞内层；内层自己的 diff 正常 |
| 三层嵌套 | 每层只排直接子；最内层改动出现在最内层的 diff 段里 |
| sparse 成员 | 挂点下只有 `subdir`；`status` 干净；改动进 diff |
| sparse + 子目录不存在 | `repo-group-sparse-empty` |
| 挂载点被外层内容占用 | `repo-group-mount-occupied`，且**已建的 worktree 全部回收** |
| 同仓两份不同 ref | 两个 worktree 分支名不同，两段 diff 互不串 |
| 只读成员 | 无 `pre_snapshot` 条目；不进 `git_diff`；不被 `commitPush` 触碰；改动后出告警事件 |
| 预置 commit 幂等 | 同一 `workingBranch` 连跑两个任务，第二个不新增 commit |
| 单成员挂根 | worktree 路径 / `tasks.*` 列 / diff 输出与单仓 baseline **字节级相同** |

### 10.3 契约与断代

- `StartTaskSchema` 拒绝 `repos[]`（存在即 422，不静默忽略）。
- 三态互斥矩阵穷举：`{scratch, 单仓, group}` 的 7 种非法组合各一条。
- 存量带 `repos[]` 的定时任务 payload ⇒ `migrationNeeded=true` 且详情可读。
- 路由元数据 ratchet：6 条新路由全部有 `permissions` 声明（未声明启动即失败，
  RFC-247 已有的守卫自动覆盖）。
- 权限目录 ratchet：`repos:update` 出现在矩阵 UI 的「仓库」行且可被 PAT 勾选。

### 10.4 前端

- 组编辑器：新增/删除成员行、校验红字、布局预览随输入更新。
- 启动选择器：混排列表渲染两类条目并带类型标签；选组后展示布局预览。
- `DiffViewer` 分段：带 `/` 的 key 正确分组；`.` 映射回根仓。
- **源代码层文本断言**（兜底，参照 CLAUDE.md 的 `selectionOnDrag` 先例）：
  - `RepoSourceList.tsx` 不再存在；
  - `tasks.new.tsx` 里不得出现 `multiRepoBlockedReason`；
  - `repoLabels.ts` 里不得出现 `sanitizeLabel`。

## 11. 明确的未决 / 待用户确认

1. **上传目录的口径**（AC-18）：本设计定为「多仓任务强制 `<taskRoot>/
   .agent-workflow-inputs/<def.targetDir>`，单仓任务保持
   `<worktree>/<def.targetDir>` 不变」。这样既满足 D12 又不破坏单仓 baseline，
   但代价是同一个工作流在单仓与多仓下上传物落点不同。若用户希望**永远**走固定
   目录（更一致，但改变单仓既有行为），实现前需要改这一条。
2. **`repo_groups.created_by_user_id` 只作审计展示**，不参与任何鉴权判定
   （D5 定了无 per-resource ACL）。若未来要给组加归属，属于新 RFC。
