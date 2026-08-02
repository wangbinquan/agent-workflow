# RFC-248 — 仓库组（Repo Groups）

> 状态：**Draft**（等用户批准；批准前不改生产代码）
> 提出日期：2026-08-02

## 背景

今天平台的「执行空间」只有两种形态：

- **单个远端仓库**（RFC-024 / RFC-165）——`cwd` = 该仓的 git worktree，
  路径 `~/.agent-workflow/worktrees/{repoSlug}/{taskId}`。
- **N 个远端仓库平铺**（RFC-066）——启动表单点「+ 增加仓库」手填若干行，
  `cwd` 升级为父目录 `~/.agent-workflow/worktrees/multi/{taskId}`，每个仓按
  `basename` 平铺成一个子目录（冲突自动加 `-2` / `-3` 后缀）。

RFC-066 的多仓有三条硬伤，导致它在真实编排里几乎用不起来：

1. **布局不可控**。目录名由 `basename(repoPath)` 决定（`services/task.ts:1290`
   `resolveMultiRepoDirName`），用户既不能指定 `apps/web` 这种层级，更不能把
   一个仓放进另一个仓的工作树里——而「主仓 + `vendor/sdk` 依赖仓」恰恰是最常见
   的跨仓形态。
2. **一次性**。多仓组合每次启动都要重填，没有可复用、可命名、可共享的实体；
   定时任务 / 工作组 / 重新启动都各自复制一份。
3. **主链路被禁**。多仓任务禁止 `wrapper-git`（`services/task.ts:1567`
   `multi-repo-wrapper-git-unsupported`）和 multipart 上传输入
   （`services/task.ts:1579`）。而 `wrapper-git` 是 Code → Audit → Fix 这条
   平台核心抽象的产出口——等于「多仓」和「平台的核心用法」互斥。

同时，长期记忆（RFC-041）的 `repo` scope 绑的是**单个** `cached_repos.id`
（`services/memoryInject.ts:385-395`），无法表达「关于这几个仓**一起**怎么干活」
的知识——而跨仓协作恰恰是最需要沉淀经验的地方。

本 RFC 引入 **仓库组**：一个可命名、可复用、可绑定记忆的一等实体，声明
「哪几个仓 + 各自 checkout 什么 + 在运行目录里怎么摆」。

## 目标

- **仓库组是持久实体**：名字 + 成员列表 + 每个成员的挂载路径 / ref / 子目录 /
  只读标记。管理界面落在 `/repos` 页的分段切换里（「远端仓库 | 仓库组」）。
- **完全自由的目录编排**：
  - 至多一个成员可以挂在**根**（`cwd` 本身就是该仓的 worktree）；
  - 其余成员挂在任意相对路径，**包括另一个成员的工作树内部**（真嵌套）；
  - 成员可以只挂**仓内某个子目录**（sparse checkout）；
  - 组可以**包含另一个组**，启动时递归展平。
- **启动时选择**：启动表单的「执行空间」选择器里，远端仓库与仓库组**混排在同一个
  列表**、各带类型标签；用户体感就是「从列表里选一个」。旁边保留「粘一个新 URL
  直启」与「临时空间（scratch）」两条既有入口。
- **记忆可绑定到组**：`memories.scope_type` 增加第 5 种 `repo_group`。用组启动的
  任务注入「组记忆」+「组内每个成员仓自己的 repo 记忆」。
- **解禁核心链路**：多仓任务支持 `wrapper-git`（`git_diff` = 全组拼接）与
  multipart 上传输入。
- **取代手填多仓**：`StartTask.repos[]` 数组从 wire 上删除，改为 `repoGroupId`。

## 非目标

- **不**给仓库组做 per-resource ACL。它与 `cached_repos` 同类：受 `repos:*`
  权限点治理，不进 RFC-099/231 的 owner + visibility + grants 体系。
  （唯一的权限目录变化见「影响范围」：必须新增 `repos:update` 点。）
- **不**支持挂载点重映射。选定的子目录挂载语义是 **sparse checkout**——挂点仍是
  仓根，只是只有那个子目录落盘（决策 D17）。不做符号链接式的路径重写。
- **不**支持成员之间的路径重叠 / 同一路径挂两个仓。
- **不**给组做 YAML 导入导出（工作流有，组 v1 不做）。
- **不**给组做版本漂移提示。启动时快照，改组不影响在跑任务，也不提示「组已更新」。
- **不**在文件系统层面强制只读。`readonly` 是框架语义（不进 diff、不提交），
  物理上 agent 仍改得掉，改了给告警（决策 D11）。
- **不**保留 `StartTask.repos[]`。存量定时任务里的多仓 payload 会失效
  （沿用 `services/scheduledTasks.ts:137` 既有的 `migrationNeeded` /
  `migrationError` 降级展示路径）。

## 决策清单

用户在七轮反问里逐条拍板，全部固化如下。**实现期不得偏离，要改先改这张表。**

| 编号 | 决策 | 备选与否决理由 |
| --- | --- | --- |
| **D1** | 嵌套时外层仓看不见内层仓，靠**改外层工作树的 `.gitignore`**，并把这笔改动做成**平台预置 commit**，`task_repos.base_commit` 指向它。 | 否决「未提交的工作区改动」（实测 `M .gitignore` 会进每一份审计 diff 并被 `git add -A` 推到远端）；否决 per-worktree `core.excludesFile`（用户要可见可解释）。`.git/info/exclude` **实测不可用**——它是 common-dir 级的，会泄漏到同镜像的其它任务 worktree。 |
| **D2** | 至多一个成员可挂在**根**。单成员挂根 = 今天的单仓行为（`cwd` = 该仓 worktree），**字节级保 baseline**。 | 否决「cwd 永远是非仓库父目录」——会让单仓任务凭空多一层目录。 |
| **D3** | 仓库组**取代**手填多仓。wire 上删掉 `repos[]`，改 `repoGroupId`。 | 否决并存 / 保留数组：两个入口都要维护布局逻辑。 |
| **D4** | 新增 `repo_group` 记忆 scope；用组启动 ⇒ 注入组记忆 **+** 各成员仓的 repo 记忆。 | 否决「写入时展开成 N 条 repo 记忆」——组成员变化后记忆不跟随，且无法表达"关于这个组合本身"的知识。 |
| **D5** | 权限复用 `repos:*`，授权矩阵**不新增行**。 | 否决独立 `repo-groups:*`：用户明确「仓库组和仓库模型一致，单仓也是一类特殊的多仓」。 |
| **D6** | ref（分支 / tag / commit）存在**组定义里**，启动时**不可改**。 | 否决「启动可覆盖」「每次现填」——组要的是可复现。 |
| **D7** | 建组时既能从已导入的远端仓库列表里选，**也能直接粘 URL**（不在列表则自动导入）。 | — |
| **D8** | 组定义变更 ⇒ **启动时快照**进 `task_repos`，不记版本号、不做漂移提示。 | 否决「快照 + 版本提示」「纯引用」。 |
| **D9** | `wrapper-git` 支持多仓：`git_diff` = 每个**可写**成员一段、带仓标头拼接。 | 否决「只算挂根的主仓」（嵌套仓改动静默丢失）、「继续禁用」（组就用不了主链路）。 |
| **D10** | 启动选择器里仓库与组**混排一个列表**，保留 URL 直启与 scratch。 | — |
| **D11** | 成员可标 `readonly`：不快照、不进 `git_diff`、不自动提交推送；**被改动时任务详情告警**，不失败也不丢弃。 | 否决「标记任务失败」（一个误建的临时文件就能搞垮整任务）、「静默丢弃」（难排查）、「文件系统层面 r-x」（与子模块同步 / 清理 / GC 打架）。 |
| **D12** | multipart 上传输入落到 `cwd` 根下的固定目录，解除多仓禁令。 | 否决「继续禁用」「让用户指定落到哪个仓」（上传物会变成那个仓的未跟踪改动，进审计 diff 与自动提交）。 |
| **D13** | 删除被组引用的远端仓库 ⇒ 409 拦截并列出引用它的组；`force=1` 时把该成员从组里摘掉。 | 与现有「被 N 个任务引用」拦截同形（`routes/cached-repos.ts:104`）。 |
| **D14** | 同一个仓可在组里出现多次（不同挂载点 / 不同 ref / 不同子目录）；worktree 分支名带序号区分。 | 今天所有仓共用 `agent-workflow/{taskId}`，同源仓出现两次会直接冲突。 |
| **D15** | 仓的标签 = **挂载路径**。diff 分段头 / 结构化 diff id 前缀 / 扇出分片 `shard_key` 全用它。 | 否决「组内短名」（agent 拿到的标签与磁盘路径对不上）、「继续 basename + 数字后缀」（嵌套下彻底丢失方位）。 |
| **D16** | 管理界面放 `/repos` 页的分段切换。 | 否决独立页（RFC-032/155 一直在收敛导航）、否决单列表混排（两类的列差异太大）。 |
| **D17** | 子目录挂载 = **sparse checkout**，挂点 = 仓根，只有选定子目录落盘（非 cone 模式，连仓根级文件都不检出）。 | 否决符号链接式真重映射：git 报的是仓内路径，要在 diff / 结构化 diff / 分片 / 审阅定位 / 文件树 / 沙箱路径白名单**全链**做双向重写，还多一层 symlink 越界面。 |
| **D18** | 组可包含组，启动时递归展平；**嵌套深度 ≤ 5**，**展平后总仓数 ≤ 32**（可配置）。 | 上限按展平后算，因为真正的成本是「要建多少个 worktree」。 |
| **D19** | 内层组成员的 ref 完全听内层组自己的，外层不可覆盖。 | 否决外层覆盖表（内层增删成员后覆盖表会悬空）。 |
| **D20** | 只读标记取**并集**：外层把内层组整体标只读 ⇒ 内层全部只读；外层不标时内层成员按自己的标记。 | 否决「外层可上可下」——会静默推翻内层组作者的「这个仓别改」意图。 |
| **D21** | 只读成员的工作树里嵌了别的成员时，**同样**造 `.gitignore` 预置 commit（一视同仁）。只读成员不推送，该 commit 只存在于本次一次性 worktree。 | 否决「只读成员不碰」——agent 在它里面 `git status` 会看到一堆 `?? vendor/…`。 |

## 实测依据

下列 git 行为是本 RFC 的地基，**全部在 git 2.50.1 上跑过真实命令**（脚本见
`design/RFC-248-repo-groups/design.md §3.6`）：

| # | 结论 | 证据 |
| --- | --- | --- |
| E1 | 嵌套 worktree 在外层仓里显示为**一个未跟踪目录** `?? vendor/`，`ls-files --others` 不会递归进去。 | 与 `util/git.ts:1358` 对子模块的既有观察一致。 |
| E2 | `git add -A` 会把嵌套仓**当作 gitlink 加入索引**并告警 `adding embedded git repository`。RFC-075 自动提交推送正是 `add -A`（`services/commitPushRunner.ts:244`），不处理就会推出一个坏的子模块指针。 | 实测输出 `A vendor/innerlib`。 |
| E3 | `.git/info/exclude` 是 **common-dir 级**的，写进去会影响同镜像的**所有**任务 worktree；per-worktree gitdir 下的 `info/exclude` **无效**。 | 两处都试过，只有 common 那份生效。 |
| E4 | `extensions.worktreeConfig=true` + `git config --worktree core.excludesFile` 可以做到 per-worktree 排除且**不泄漏**。 | 本 RFC 未采用（D1 选了 `.gitignore`），但记录下来供未来参考。RFC-067 当年否决 worktree config 的理由是「父仓不是我们的」（`services/task.ts:1925-1936`）——RFC-165 砍掉本地路径启动后，父仓永远是平台自己的 `~/.agent-workflow/repos/{slug}` 镜像，该理由已不成立。 |
| E5 | sparse checkout 的模式文件 `$GIT_DIR/info/sparse-checkout` 是 **per-worktree** 的，同镜像的其它 worktree 不受影响。 | 第三个 worktree 仍完整检出。 |
| E6 | 非 cone 模式（`git sparse-checkout set --no-cone '/guides/'`）能做到挂点下**只有** `guides/`；cone 模式会连带检出仓根级文件（`README.md` / `LICENSE`）。两种下 `status` 都干净、diff 正常。 | 决定 D17 采用非 cone。 |
| E7 | `git worktree add` 到**已存在且非空**的目录 → `fatal: '<path>' already exists`；到**已存在的空目录** → 成功。 | 决定「挂载点被外层仓内容占用」必须是启动期显式失败（见 design §5 失败模式 F3）。 |
| E9 | **嵌套 worktree 的回收顺序不会坏账**：先删外层会连带删掉内层目录，内层镜像的注册被 git 标 `prunable`；随后对已消失路径跑 `git worktree remove --force` **仍返回 0** 并清干净注册表（`cleanupCreatedWorktree` 的 `exitCode !== 0` 判据不误报）。倒序（内层先删）同样干净。 | 据此把「按挂载深度倒序回收」定为**要求**而非依赖自愈（design §4.3）。 |
| E8 | **整条物化流水线的端到端原型跑通**：5 个 worktree（挂根 app + 只读 `vendor/sdk` + 三层嵌套 `vendor/sdk/ext` + sparse `site/docs` + 同仓第二份 `compare/main`）物化后 `status` **全部干净**；worker 改动后每个仓的 diff **只含自己的**改动；根仓 diff 里既没有 `.gitignore`（它在 `base_commit` 里）也没有任何嵌套挂载点与上传目录；对可写仓跑 `git add -A` **零** `adding embedded git repository` 告警；只读仓的脏改动能被独立检出供告警；分支名 `…/{taskId}` 与 `…/{taskId}-2` 正确分化；幂等复检通过。 | 脚本 `design/RFC-248-repo-groups/materialize-prototype.sh`，可直接 `bash` 复跑。这条同时证明 E2 那个坏 gitlink 风险被 D1 方案彻底消除。 |

## 用户故事

1. **主仓 + 只读依赖仓**。用户建一个组「web + sdk」：`web` 挂根，`sdk` 挂
   `vendor/sdk` 并标只读。启动后 agent 的 `cwd` 就是 web 的工作树，`vendor/sdk`
   里是 sdk 的完整代码可供查阅；审计 diff 里只有 web 的改动；自动提交推送只推
   web。agent 若误改了 `vendor/sdk`，任务详情出现一条「只读仓 `vendor/sdk` 被改动」
   的告警，改动不进 diff、不被推送。
2. **前后端 + 共享库三仓平铺**。组「全栈」把 `frontend` / `backend` / `shared`
   挂在 `frontend` / `backend` / `shared` 三个子路径，`cwd` 是不属于任何仓的父
   目录。这正是今天 RFC-066 的多仓形态，只是现在可命名、可复用。
3. **只要文档仓的一个子目录**。组里加 `docs` 仓、子目录 `guides/`、挂到
   `site/docs`。磁盘上 `site/docs/` 是 docs 仓的根，里面**只有** `guides/`
   落盘（`api/` `internal/` `README.md` 都不下载）。
4. **组套组**。组「平台底座」= `core` + `proto`；组「订单域」引用「平台底座」
   并整体挂到 `base/`，再加自己的 `orders` 仓挂根。启动时递归展平成 3 个仓。
5. **同一个仓摆两份做对照**。组里加两次 `api` 仓：一次 ref `main` 挂
   `compare/main`，一次 ref `release/8.0` 挂 `compare/release`。两个 worktree
   的分支名分别是 `agent-workflow/{taskId}` 和 `agent-workflow/{taskId}-2`。
6. **组记忆**。「全栈」组上沉淀了「改 shared 的类型后必须同时跑 frontend 与
   backend 的 typecheck」。用该组启动的任何任务都会注入这条，外加 frontend /
   backend / shared 三个仓各自的 repo 记忆。用户单独选 `frontend` 仓启动时
   **不**注入组记忆。
7. **删仓被拦**。用户想删 `shared` 的远端缓存，收到 409「被 2 个仓库组引用：
   全栈 / 订单域」。勾选强制删除后，`shared` 从这两个组里被摘掉。

## 验收标准

### 组管理

1. ✅ `POST /api/repo-groups` 创建组：名字（全局唯一，大小写不敏感）、描述、
   成员数组。成员两种 `kind`：`repo`（`cachedRepoId` / `ref` / `subdir`）与
   `group`（`childGroupId`）；两种都带 `mountPath` 与 `readonly`。
2. ✅ 建组时成员可给 `repoUrl` 而非 `cachedRepoId`；URL 不在缓存里则同步导入
   （复用 `services/gitRepoCache.ts` 的 resolve 路径）并回填 id。
3. ✅ `PUT /api/repo-groups/:id` 全量替换成员列表，`version` 自增。
4. ✅ 校验（建组与改组都跑，失败 422）：
   - 挂载路径：相对路径、无 `..`、无绝对路径、无 CR/LF/反斜杠、规范化后不得为
     `.`；组内**不得重复**；至多一个成员 `mountPath === ''`。
   - 组引用：不得自引用、不得成环（DFS 检测）、展平深度 ≤ 5、展平后仓数 ≤ 32。
   - 子目录：相对路径、无 `..`、非空时以目录形态解释。
5. ✅ `GET /api/repo-groups/:id/layout` 返回**展平后**的布局预览：每行
   `{ mountPath, repoUrl(脱敏), ref, subdir, readonly, viaGroups: [...] }`，
   按建 worktree 的顺序（挂载深度升序）排列。
6. ✅ `DELETE /api/repo-groups/:id`：被别的组引用时 409 并列出引用者；
   `force=1` 时把引用它的成员行删掉。PAT 删除走 RFC-247 的
   `assertTokenDeleteConfirm`（回显组名）。
7. ✅ `DELETE /api/cached-repos/:id` 增加「被 N 个仓库组引用」拦截，与既有的
   「被 N 个任务引用」并列；`force=1` 时把该仓从所有组里摘掉。
8. ✅ 权限：读走 `repos:read`，建走 `repos:create`，改走**新增的**
   `repos:update`，删走 `repos:delete`。授权矩阵 UI 的「仓库」行不新增列以外
   的任何变化。

### 启动与运行时

9. ✅ `StartTaskSchema` 删除 `repos[]`，新增 `repoGroupId`。三种执行空间形态
   **互斥**：`scratch` / 单仓（`repoUrl` ⊕ `cachedRepoId`，可带 `ref`）/
   `repoGroupId`。同时给多个 → 422 `start-task-source-conflict`。
10. ✅ 展平后**恰好一个成员且挂根**时，走**单仓代码路径**：
    `tasks.worktree_path = ~/.agent-workflow/worktrees/{repoSlug}/{taskId}`，
    目录布局 / `tasks.*` 列 / cwd 传递与今天**字节级一致**。
11. ✅ 展平后多个成员时：`tasks.worktree_path =
    ~/.agent-workflow/worktrees/group/{taskId}`；若有成员挂根，该目录**就是**
    那个仓的 worktree；否则是普通父目录。
12. ✅ 每个成员在 `task_repos` 落一行，携带 `mount_path` / `subdir` /
    `readonly` / `gitignore_commit`。`repo_index` 按挂载深度升序（外层在前）。
13. ✅ 内含其它成员的仓（不论是否只读）在启动期得到一个 `.gitignore` 预置
    commit：追加该仓工作树内所有**直接**嵌套挂载点（以及有仓挂根时的上传目录）
    的排除行，用 RFC-067 的任务 git 身份提交，`task_repos.base_commit` 指向它。
    规则已存在时**幂等跳过**，不产生空 commit。
14. ✅ `subdir` 非空的成员用 `git worktree add --no-checkout` +
    `git sparse-checkout set --no-cone '/<subdir>/'` + `git checkout` 物化。
15. ✅ 同一 `cached_repo_id` 在展平结果里出现多次时，第 1 个用
    `agent-workflow/{taskId}`，第 n 个用 `agent-workflow/{taskId}-{n}`。
16. ✅ 挂载点被外层仓自身内容占用（`git worktree add` 报 `already exists`）→
    启动失败 `repo-group-mount-occupied`，错误体带 `mountPath` 与占用它的仓。
17. ✅ `wrapper-git` 在多仓下**可用**：包裹器对每个**可写**成员各做前后快照，
    `git_diff` = 每仓一段、首行 `# === Repo: <挂载路径> ===`（挂根的仓用 `.`），
    空 diff 的仓整段略过。`multi-repo-wrapper-git-unsupported` 删除。
18. ✅ multipart 上传输入在多仓任务里落到 `<taskRoot>/.agent-workflow-inputs/
    <def.targetDir>`；单仓任务保持今天的 `<worktree>/<def.targetDir>` 不变。
    `multi-repo-upload-unsupported` 删除。
19. ✅ 只读成员：不写 `pre_snapshot`、resume 时不回滚、不进 `git_diff` /
    `GET /api/tasks/:id/diff` / 结构化 diff、不参与自动提交推送。任务收尾时
    检测到其工作树 dirty ⇒ 任务详情出现一条告警（不改任务状态）。
20. ✅ 扇出分片的 `shard_key` 带挂载路径前缀（`vendor/b/lib/bar.rs`；挂根的仓
    无前缀，就是 `src/foo.ts`）。

### 标签与展示

21. ✅ 仓的规范 key = 挂载路径，挂根为 `''`；在 diff 分段头 / 结构化 diff id
    前缀 / 前端分组 里的线上形态是 `.`。`services/repoLabels.ts` 的
    `sanitizeLabel`（把 `/` 换成 `-`）与 basename + 数字后缀逻辑**删除**——
    挂载路径已经在建组期校验过唯一与安全。
22. ✅ 文本 diff 与结构化 diff 用同一个 key 关联；前端
    `components/DiffViewer.tsx:89` 的 `REPO_MARKER` 与
    `lib/changeReview.ts` 的 `label/` 拆分改为「按已知 key 集合做最长前缀匹配」，
    key 集合由后端在两类 diff 响应里都带上的 `repoKeys: string[]` 提供，
    前端**不自己猜**。
22b. ✅ **结构化 diff 的根成员不加前缀**：`structuralDiff/assemble.ts:147` 的
    `prefixPath` 改为「`label === ''` 时原样返回」。
    〔设计门 G3：现状不变量是「加前缀 ⟺ 多仓」——单仓走
    `structuralDiff/service.ts:95-118` 的早分支完全不加前缀，多仓才过
    `mergeStructuralDiffs`，而 `prefixPath` 是**无条件**拼 `${label}/`。
    把根成员的 key `''` 塞进去会得到 `/src/a.ts`（或 wire 形态的 `./src/a.ts`），
    两者都不等于文本 diff 的 `src/a.ts`，前端 `changeReview.ts` 靠路径相等
    join 两侧，根仓的符号 / 严重度 / 文件内容 / 导航会**静默脱节**。
    改这一处即可覆盖 `assemble.ts:140-146` 注释列出的全部 7 类嵌入路径
    （它们都经由 `prefixPath` 与 `prefixIdPath`）。〕
23. ✅ 单仓任务（挂根单成员）的 diff 输出**不带**任何 `# === Repo:` 分段头，
    与今天字节级一致。
24. ✅ 任务详情 header 显示组名 chip + 可展开的布局树（挂载路径 / ref / 只读
    标记）。非组启动的任务不出现该 chip。
25. ✅ `/repos` 页新增「仓库组」分段，复用现有搜索 / 筛选工具条与表格骨架；
    组编辑器复用 `Dialog` / `Field` / `TextInput` / `Select` / `Switch` /
    `ChipsInput` 等既有公共组件，**不新造 modal chrome / 表单原语**。

### 记忆

26. ✅ `memories.scope_type` 增加 `repo_group`（migration 重建 `memories` 表以
    改 CHECK 约束，参照 0048 的先例）；`scope_id` = `repo_groups.id`。
27. ✅ 用组启动的任务，注入 = 组记忆（独立 scope 预算档）+ 组内每个成员仓的
    repo 记忆（共用既有 `budget.repo` 档）。
28. ✅ 单个仓库直启的任务**不**注入它所属任何组的记忆。
29. ✅ 组记忆的读/管理权限沿用 `repo` scope 的规则（全员可读、仅 admin 可管，
    `services/memory.ts:743,758`）。
30. ✅ **删除组时，在同一事务里把绑在它上面的记忆置为 `archived`**，DELETE
    响应体与前端确认弹窗回报受影响条数。
    〔设计门 G5 修正：初稿写「按 `services/memory.ts:745-746` fail-closed
    处置」是**事实错误**——那条 fail-closed 只覆盖 agent/workflow；
    `canViewMemory`（`memory.ts:743`）与 `filterVisibleMemories`
    （`memory.ts:807`）对 repo/global **在加载资源行之前就 return true**。
    按 AC-29 把 `repo_group` 并进那一档后，删组会留下仍可列出、仍会被注入的
    孤儿记忆。改用 `archived` 而非硬删：保住用户知识，同时
    `memoryInject` 的 `status='approved'` 过滤让注入立即停止。〕
30b. ✅ `tasks` 携带 `repo_group_name` 快照列（与 D8 一致），组被删除后任务详情
    的组 chip 仍能渲染名字，而不是退化成一个悬空 id。`task_repos` 本就是快照，
    删组**不影响**在跑任务的布局；停的只有组记忆注入。

### 模板变量

31. ✅ `{{__repo_path__}}` / `{{__base_branch__}}` 继续指 `repos[0]`
    （= 挂载深度最浅、同深度按 `repo_index`）。
32. ✅ `{{__repo_names__}}` 语义从 basename 改为**挂载路径**（挂根为 `.`）；
    `{{__repos__}}`（绝对 worktree 路径）与 `{{__repo_count__}}` 不变；
    新增 `{{__repo_group__}}`（组名；非组启动时为空串）。

### 断代

33. ✅ `repos[]` 从**全部八个启动入口**删除，不留 deprecated 别名——
    `StartTaskSchema` / `StartAgentTaskSchema`（`schemas/task.ts:1267`）/
    `StartWorkgroupTaskSchema`（`schemas/workgroup.ts:597`）/ 全部 scheduled
    payload 档 / `LaunchSpaceFields` + `applySpaceFields` / REST JSON + multipart
    两条 / MCP `launch_task` 工具 / e2e fixture。契约迁移表见 design §2.3a。
33b. ✅ **顶层 `repos` 进 `RETIRED_START_TASK_KEYS`**（`schemas/task.ts:730`），
    在任何 schema parse **之前**硬拒 422。
    〔设计门 G1：StartTask 用的是**非 strict zod**，删掉字段后旧客户端传
    `repos` 会被**静默剥除**，然后在错误的工作区里把任务跑起来并返回 200——
    与 AC-9 要求的 422 直接矛盾。同时删掉 `rejectRetiredStartTaskKeys` 里把
    `repos` 当数组遍历查行内退役键的那段死代码（顶层已硬拒，不可达）。
    三个启动面都要确认接上了这个守卫，不假设已接。〕
34. ✅ 授权矩阵与角色表同步：`repos:update` 同时进 `PERMISSIONS`、
    **`MANAGER_EXTRA`**（`schemas/permission.ts:344-350`）与 PAT 授权矩阵。
    〔设计门 G4：repos 域不在 ACL 模型里，能力**完全靠那张手工表**授予；
    不加进去，manager 建完组对 PUT 拿 403 且无法给 PAT 授权。〕
    连带补 MCP 的 repo-group 资源映射与 `docs/api` 条目；测试用
    admin / manager / 普通用户 / 窄 PAT 四档跑路由级授权矩阵。
35. ✅ 存量定时任务里带 `repos[]` 的 payload 变为不可解析，走
    `services/scheduledTasks.ts:137` 既有的 `migrationNeeded` / `migrationError`
    降级路径展示，不静默吞掉、也不尝试自动迁移。
36. ✅ 存量多仓任务（`task_repos.worktree_dir_name` 平铺行）的详情页 / diff /
    结构化 diff 仍可正常渲染：migration 把 `worktree_dir_name` backfill 进
    `mount_path` 后删除旧列。

## 影响范围

- **数据库**：新表 `repo_groups` / `repo_group_members`；`task_repos` 新增
  `mount_path` / `subdir` / `readonly` / `gitignore_commit` 并删除
  `worktree_dir_name`；`tasks` 新增 `repo_group_id`；`memories` 重建以扩
  `scope_type` CHECK。预计 2 个 migration（编号提交前 grep 防撞，当前最新为
  `0129_rfc247_pat_purpose_and_audit.sql`）。
- **shared**：新增 `repoGroup.ts` schema 家族；`StartTaskSchema` /
  `StartWorkgroupTaskSchema` 删 `repos[]` 加 `repoGroupId`；
  `MemoryScopeSchema` 加 `repo_group`；`PERMISSIONS` 加 `repos:update`
  （连带改掉 `permission.ts:22,108` 那两处「no PUT/PATCH route exists」的注释）；
  `MULTI_REPO_MAX` 语义改为「展平后上限」并抬到 32。
- **后端**：新增 `services/repoGroup.ts`（CRUD + 展平 + 校验）、
  `routes/repoGroups.ts`；`services/task.ts` 的 materialize 分支重写为按布局树
  建 worktree + 预置 commit + sparse；`util/git.ts` 增加 sparse 与预置 commit
  两个原语；`services/repoLabels.ts` 改为挂载路径 key；`services/scheduler.ts`
  的 `wrapper-git` 臂扩到多仓；`util/diffSplit.ts` 的分片带仓前缀；
  `services/memoryInject.ts` 加 `repoGroup` 档；`services/gitRepoCache.ts` 的
  删除守卫加组引用；`services/commitPushRunner.ts` 跳过只读成员。
- **前端**：`/repos` 页加分段 + 组列表 + 组编辑器（含布局树编辑）；
  `tasks.new.tsx` 的执行空间选择器改为混排列表并删掉 `RepoSourceList` 的
  「+ 增加仓库」多行；任务详情 header 加组 chip 与布局树；`DiffViewer` /
  `changeReview` 的 key 解析改最长前缀匹配；记忆表单的 scope 分段加第 5 档。
- **文档**：`docs/api` 页随路由元数据自动更新；`docs/dev-gotchas.md` 补
  「嵌套 worktree 的三条 git 事实」（E1–E4）。

## 风险与回退

| 风险 | 缓解 |
| --- | --- |
| `.gitignore` 预置 commit 会出现在用户的远端工作分支上（RFC-075 开启时）。 | 用户已知情拍板（D1）。commit message 带 `chore(agent-workflow):` 前缀且**幂等**（规则已存在则不提交），复用同一工作分支不会累积多个 commit。 |
| 预置 commit 改变了 `base_commit` 的含义（不再是 base 分支的 tip）。 | 这正是它干净的原因——审计 diff 相对它计算。但 RFC-075 的 `baseRef`（用于生成提交信息与 PR 基线）需要显式区分「基线 commit」与「base 分支 tip」，design §4.4 单独处理。 |
| sparse checkout 与子模块递归（RFC-034/210）叠加行为未知。 | design §3.4 定 v1 语义：sparse 成员的子模块初始化只作用于已检出的子树；未检出路径下的子模块跳过并在 `task_repos.submodule_init_error` 记录原因。需要专门的集成测试。 |
| 组套组递归展平可能造出用户没预期的巨大布局。 | 深度 ≤ 5 + 展平 ≤ 32 双重上限；`GET /layout` 预览在建组与启动两处都展示展平结果与总数。 |
| 删掉 `repos[]` 会打断存量定时任务。 | 用户已授权断代（D3）。走既有降级展示路径而非静默失败；`STATE.md` 与 release note 显式记录。 |
| 标签从 basename 改成挂载路径，会让存量任务的历史审阅锚点错位。 | migration 把 `worktree_dir_name` 原样 backfill 进 `mount_path`（存量平铺任务的挂载路径**就是**它的 basename），历史锚点不变。 |
| 只读成员被改动的检测要在每次任务收尾跑一遍 `git status`。 | 只对标了 `readonly` 的成员跑，且只在任务进入终态时跑一次；成本与现有的 dirty 检测同级。 |
| 一次启动要建到 32 个 worktree，耗时与磁盘显著上升。 | 上限可配置；`GET /layout` 预览显示总数；建 worktree 按深度分层，同层可并发（design §4.2）。 |

## 与其它 RFC 的关系

- **RFC-066**（多仓启动）：本 RFC **取代**其 wire 形态与布局算法，保留其
  `task_repos` 表与 per-repo rollback 骨架。`resolveMultiRepoDirName` 与
  `worktrees/multi/` 命名空间退役。
- **RFC-024 / RFC-033 / RFC-204**（远端仓缓存 / 批量导入 / 凭证封存）：组成员是
  `cached_repos` 的引用，凭证、脱敏、刷新、批量导入全部原样复用。
- **RFC-034 / RFC-210**（子模块递归 / 隔离）：每个成员独立初始化子模块；与
  sparse 的叠加语义见 design §3.4。
- **RFC-041 / RFC-046**（长期记忆 / 注入快照）：新增第 5 种 scope，注入快照结构
  相应扩一档。
- **RFC-075**（自动提交推送）：跳过只读成员；`baseRef` 与预置 commit 的关系见
  design §4.4。
- **RFC-089 / RFC-239 / RFC-240**（结构化 diff 多仓 / 统一视图）：仓 key 从
  basename 改为挂载路径，两侧同源于 `services/repoLabels.ts`。
- **RFC-099 / RFC-231**（资源 ACL / 私有默认）：仓库组**不**进这套体系（D5）。
- **RFC-165**（统一任务创建）：执行空间选择器改造落在它建立的 `tasks.new.tsx`
  骨架上。
- **RFC-247**（路由元数据 / 授权矩阵）：新路由按 `registerRoute` 声明权限点；
  新增 `repos:update` 是本 RFC 对其权限目录的唯一改动。
