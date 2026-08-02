# RFC-248 — 仓库组 · 任务分解

> 配套 `proposal.md`（决策 D1–D21、验收 AC-1…AC-36）与 `design.md`（§1–§11）。
> 单 RFC / **5 个 PR 按层切**。每个 PR 自带测试、自己跑绿四件套
> （`typecheck` / `lint --max-warnings 0` / `test` / `format:check`），
> push 后按 **exact SHA** 查 CI。

## 交付记录（滚动更新）

| PR         | 状态 | commit                  | 摘要                                                                                                                   |
| ---------- | ---- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| RFC 三件套 | ✅   | `f6e637dd`              | proposal / design / plan + 索引登记                                                                                    |
| 设计门一轮 | ✅   | `eb4f6194`              | 3×P1 + 2×P2 全部核实并折入，记档 `design-gate-2026-08-02.md`                                                           |
| **PR-1**   | ✅   | `fb04f84e` + `6d78cff0` | T1–T9 纯逻辑地基 + 三个实证缺陷加固                                                                                    |
| **PR-2a**  | ✅   | `fcfbfdc9`              | T10/T11/T11b/T12 两个 migration + drizzle 定义 + 16 条迁移测试                                                         |
| **PR-2b**  | ✅   | `d04854c5`              | T13/T14/T15/T16/T17 服务层 + 六条路由 + 权限点 + 记忆第五档 + 18 条服务测试                                            |
| 设计门二轮 | ✅   | 见下                    | **9×P1 + 2×P2，判定 needs-attention**；5 条代码 P1 已修并带锁，4 条改设计的归 PR-3/PR-4；G2 由外部迁移探针独立验证通过 |
| **PR-3**   | ✅   | `8dd8b6e8`…`fa6c1d6d`   | T19/T19b/T19c/T20/T21/T22/T24/T27 + 权限守卫；尾巴 T23半/T25/T26半 未做                                                |
| **PR-4**   | ✅   | 见 PR-4/5 合并 commit   | T28/T28b/T29/T29b/T30/T30b/T30c/T31/T32a/T32b/T33/T34 + T26 全量（旧多仓分支删除）                                     |
| **PR-5a**  | ✅   | 同上                    | 启动选择器（仓库/组同列）· 任务详情组 chip + 只读 chip + 挂载路径 · 记忆表单第五档 · changeReview `repoKey` · e2e 重写 |
| **PR-5b**  | ⬜   | —                       | `/repos` 分段控件 · `RepoGroupEditor` 弹窗 · `RepoLayoutTree` 公共组件（组的**管理界面**，启动/消费面已可用）          |

实现期相对设计稿的**偏离**（均已回写文档）：

- `mount-path-empty` 错误码不可达 ⇒ 删除（PR-1）。
- `assertMountPathSet` 的根计数先于重复检查（更可操作的报错）。
- T7 的旧 `canonicalRepoLabels` 删除推迟到 T29（`mount_path` 列要 PR-2 才存在，
  PR-1 删了就编译不过）。
- 新增三条设计稿没写的加固：gitignore 元字符转义、大小写不敏感挂载点碰撞、
  Unicode NFC + NUL（PR-1 加固批，均有实测/红绿证据）。
- 新增一条 PR-2b 发现的真 bug 修复：读路径 `resolveRepoGroupLayout` 让
  `RepoGroupLayoutError` 逃到 route 层会渲染成 500 而非 422。
- **设计门二轮回退**：PR-1 给 `util/diffSplit.ts` 加的仓 marker 游标**已删**
  ——`git_diff` 端口是 `list<path<*>>` 不是 patch（`nodePorts.ts:188`），且该
  模块零生产调用方，那段是为已证伪设计写的投机代码。
- **设计门二轮新增 5 条代码修复**（H1 事务内校验 + OCC、H2 删仓原子性、
  H3 fused 记忆、H6 三个校验洞、H7 遍历预算），详见 `design-gate-2026-08-02.md`。
- **P2-1 修正**：`memories` 是 **5 个索引 / 7 个 CHECK**（初稿写 4/6）；
  删 `worktree_dir_name` 的迁移**不再预留 0132**（已被记忆 scope 占用），
  实现期现取尾号。

### PR-4/5a 实现期偏离（均为「面向代码最合理」的择优，非缩水）

- **`sourceTaskId` 是第 4 种启动来源**（设计 §2.3a #9）。设计只说「服务端按
  `sourceTaskId` 用冻结快照重建」，实现把它落成 `StartTaskSchema` 的一等来源
  字段（与 scratch / 单仓 / 组四选一、两两互斥），`loadFrozenLayout` 把
  `task_repos` 行还原成与 `resolveRepoGroupLayout` **同构**的 `PlannedRepo[]`，
  于是复用同一条物化管线、零分叉。缺 `cached_repo_id` 的存量行显式 422
  （脱敏 URL clone 会带 `***` 认证失败），不静默少物化一个仓。
- **T30c 把 MCP 的 kind 与权限域解耦**。`repo-groups` 成为独立的工具寻址单位，
  但写权限沿用 `repos:*`——给账号页的令牌矩阵加一行 `repo-groups:*` 只会让用户
  面对一个无从理解的勾。RFC-247 的漂移锁相应从「相等」放宽成「覆盖」，并新增
  一条反向守卫：矩阵外的 kind 必须显式声明权限域，且那个域真实存在。
- **#10 删组 × 定时任务**：`LIKE '%"repoGroupId":"<id>"%'` 粗筛后**逐条
  JSON.parse 复核**——只靠子串会把「组 id 出现在某条提示词里」误判成引用，
  用户会遇到一个永远删不掉也解释不清的组。已禁用的计划不算引用。
- **向导的 remote 空间锁成单行**（`maxCount={1}`，加行按钮下线）。留着加行会让
  用户拼出一个 builder 只取首行的空间——那是 RFC-165 F1 那类静默降级。
- **删除优于 deprecate**：`buildLaunchBodyMultiRepo`（只产出退役的 `repos[]`）、
  `StartTaskRepoSchema` / `StartTaskRepo`（只服务于该数组项）、
  `multiRepoBlockedReason` 与 `hasWrapperGitNode`（多仓 + wrapper-git 现在受
  支持）全部删除，各自留下「不得复活」的锁。
- **T41 修掉一个随嵌套布局诞生的真 bug**：`changeReview` 的 structural-only 分支
  按第一个路径段反推仓归属，`vendor/sdk` 会被切成 `vendor`（标签与相对路径同时
  错，静默）。改读后端显式的 `repoKey`，无该字段的存量数据回落旧行为。
- **两条测试因本 RFC 暴露出「早已空转」**，一并修成真测：
  `task-start-pre-worktree` 的「回落到单仓 git 路径」自 RFC-165 退役 `repoPath`
  起就只建了个空的多仓容器目录还断言「目录存在」；`rfc107` 的 D12 用例原本
  因旧路径不给同源仓加分支后缀而只物化了一个仓，现在经组路径真跑两份。

## PR 划分

| PR       | 范围                                                                                     | 依赖 | 大致体量 |
| -------- | ---------------------------------------------------------------------------------------- | ---- | -------- |
| **PR-1** | 纯逻辑地基：shared schema、展平/校验/包含关系/标签/分片的纯函数 + 全套单测               | —    | 中       |
| **PR-2** | 持久层与 CRUD：2 个 migration、`services/repoGroup.ts`、`routes/repoGroups.ts`、删仓守卫 | PR-1 | 中       |
| **PR-3** | 运行时物化：布局建 worktree、`.gitignore` 预置 commit、sparse、只读语义、失败回收        | PR-2 | **大**   |
| **PR-4** | 消费面：`wrapper-git` 多仓、diff/结构化 diff/分片、上传解禁、记忆第 5 档、模板变量       | PR-3 | 大       |
| **PR-5** | 前端：`/repos` 分段 + 组编辑器 + 布局树、启动选择器改造、任务详情、记忆表单              | PR-4 | 大       |

断代改动（删 `repos[]`）横跨 PR-2（shared/后端）与 PR-5（前端）。为避免中间态
编译不过，**`StartTaskSchema` 的字段删除放在 PR-4**，前端在 PR-5 同批跟上；
PR-2/PR-3 期间 `repoGroupId` 与 `repos[]` 并存但前端不产出后者。

---

## PR-1 — 纯逻辑地基

- **T1** `packages/shared/src/schemas/repoGroup.ts`：`RepoGroupMemberSchema`
  （discriminated union）、`RepoGroupSchema`、`PlannedRepoSchema`、
  `CreateRepoGroupSchema` / `UpdateRepoGroupSchema` / `RepoGroupLayoutResponseSchema`、
  `MAX_GROUP_DEPTH=5` / `MAX_FLAT_REPOS=32`。导出进 `shared/src/index.ts`。
- **T2** 挂载路径规范化与校验（design §1.2）：`normalizeMountPath` +
  六种错误码。纯函数，零依赖。
- **T3** 展平（design §1.1）：`flattenRepoGroup(loadGroup, rootId)`——链式环检测、
  深度上限、只读并集、前缀拼接、展平上限。以**注入式 loader** 接受组数据，便于
  单测不碰 DB。
- **T4** 包含关系（design §1.3）：`containerOf` / `directChildren` /
  `exclusionPlanFor`（按路径段边界匹配，不是字符串 `startsWith`）。
- **T5** 分支后缀（design §3.3）：`assignBranchSuffixes(planned, taskId, workingBranch?)`。
- **T6** `.gitignore` 区块（design §3.1）：`buildGitignoreBlock(existing, rules, taskId)`
  → `{ nextContent, added: string[] }`，`added` 为空表示无需 commit（幂等）。
- **T7** `packages/backend/src/services/repoLabels.ts` **纯新增**
  `canonicalRepoKeys` / `canonicalRepoKeysWire`；`repoKeyWire` /
  `parseRepoKeyWire` / `splitRepoPrefix`（最长前缀匹配）落在 shared 的
  `repoGroupLayout.ts` 里（前端布局树与后端物化共用）。
  ⚠ **旧的 `canonicalRepoLabels` + `sanitizeLabel` 在本 PR 不删**——它有 5 个
  调用点，而 `mount_path` 列要到 PR-2 的 migration 才存在，本 PR 删了就编译不过、
  PR-1 无法独立跑绿。删除归 **T29**（调用点迁移时一并做），
  T44 的源码层文本断言（`repoLabels.ts` 不得出现 `sanitizeLabel`）也在那时才生效。
  这不是留过渡态——同一个 RFC 内的 PR 序列，终态无重复。
- **T8** `packages/backend/src/util/diffSplit.ts`：三个 split 函数加仓 key 游标，
  `shard_key` 带挂载路径前缀（design §6.5）。
- **T9** 测试：`repo-group-flatten` / `repo-group-mount-path` /
  `repo-group-containment` / `repo-group-branch-suffix` / `gitignore-preset-block` /
  `repo-labels`（改写）/ `diff-split-repo-prefix`。清单见 design §10.1。
  **`repo-labels.test.ts` 必须带一条显式回归**：`apps/web` 不得被压成 `apps-web`。

**验收**：AC-4（校验规则）、AC-21（key 语义）、AC-20（分片前缀）的纯函数部分全绿。

---

## PR-2 — 持久层与 CRUD

- **T10** migration `<下一个可用号>_rfc248_repo_groups.sql`：建 `repo_groups` /
  `repo_group_members`（含 CHECK 与索引，design §2.1）；`tasks` 加
  `repo_group_id` + `repo_group_name`（设计门 G5 的组名快照）；`task_repos` 加
  `mount_path` / `subdir` / `readonly` / `gitignore_commit` 并 backfill
  `mount_path = worktree_dir_name`。
  ⚠ **编号在实现期现取，RFC 里不写死**（设计门 G2）：本 RFC 落档时最新是
  `0129`，写文档这段时间里另一并发 session 已经落了
  `0130_rfc247_audit_snapshot_failed.sql`。动手前先
  `ls packages/backend/db/migrations | tail -3` 取尾号顺延，**每个 PR 提交前
  再核一次**。
- **T11** migration `<下一个可用号>_rfc248_memory_repo_group_scope.sql`：重建 `memories`
  表以扩 CHECK 到 `('agent','workflow','repo','repo_group','global')`。
  **权威先例是 `0117_rfc223_fusion_provenance.sql:119-190`，不是 0048。**
  0117 的注释写明了原因：`memories` 带两条**自引用 FK**
  （`supersedes_id` / `superseded_by_id` → `memories.id`），把
  `__new_memories` rename 成 `memories` 时 SQLite 是否重写这两条自引用
  **依赖 `legacy_alter_table` 模式**，而 daemon 迁移期是 `foreign_keys=OFF`、
  直连 migrator / 测试是 `ON`，两种模式结果不同。正确套路：**先
  `ALTER TABLE memories RENAME TO __old_memories`，再直接
  `CREATE TABLE memories`（最终名），INSERT SELECT，DROP `__old_memories`，
  重建 4 个索引**。
  **列清单以 `0117:129-152` 的 24 列为准**——0048 那版**没有**
  `fused_into_skill_id`（它是 RFC-223 后加的），照抄 0048 会静默丢掉整列溯源
  数据。0117 的 6 条 CHECK 与 2 条自引用 FK 原样保留，只改 `scope_type` 那一条。
- **T11b** 迁移后校验（设计门 G2 采纳建议）：`memories` 重建的**同一事务**内
  校验「行数一致 / `fused_into_skill_id` 非空计数一致 / 索引集合一致 /
  `PRAGMA foreign_key_check` 为空」，任一不符即 abort。写成迁移末尾的断言语句 +
  一条迁移单测（造带 fused 溯源的行，跑迁移，断言整列未丢）。
- **T12** `packages/backend/src/db/schema.ts`：两张新表的 drizzle 定义 +
  三张既有表的列增删。
- **T13** `services/repoGroup.ts`：`listRepoGroups` / `getRepoGroup` /
  `createRepoGroup` / `updateRepoGroup`（version 自增）/ `deleteRepoGroup`
  （引用守卫 + `force` + **同事务归档组记忆**，设计门 G5）/
  `resolveRepoGroupLayout`（DB loader + T3 展平）。
  URL→id 的成员导入复用 `services/gitRepoCache.ts` 的 resolve（D7）。
  `getRepoGroup` 响应带 `boundMemories: number` 供确认弹窗显示；
  `deleteRepoGroup` 响应带 `archivedMemories: number`。
- **T14** `routes/repoGroups.ts`：design §8 的 6 条路由，全部 `registerRoute`
  声明权限点；DELETE 的 PAT 分支走 `assertTokenDeleteConfirm`（回显组名）。
  挂进 `server.ts`。
- **T15** `shared/src/schemas/permission.ts` 加 `'repos:update'` **并同时加进
  `MANAGER_EXTRA`（第 344-350 行）**——repos 域不在 ACL 模型里，能力完全靠那张
  手工表授予，漏了 manager 就「建得了组、改不了组」且无法给 PAT 授权
  （设计门 G4）。**同时改掉**第 22 行与第 108 行「no PUT/PATCH route exists」
  的注释（它们现在是错的）。测试用 **admin / manager / 普通用户 / 窄 PAT
  四档**跑路由级授权矩阵。
- **T16** `services/gitRepoCache.ts` 的 `deleteCachedRepo` 加「被 N 个组引用」
  守卫；409 详情体加 `referencingGroups`；`force=1` 时删掉引用行（D13）。
- **T17** `shared/src/schemas/memory.ts` 的 `MemoryScopeSchema` 加
  `'repo_group'`；`services/memory.ts` 第 743 / 758 / 807 行把它并进
  `repo`/`global` 的「全员可读、仅 admin 可管」分支（AC-29）。
- **T18** 测试：CRUD 全路径、名字唯一（大小写不敏感）、6 类校验 422、组引用与仓
  引用两种 409 + force、layout 端点、权限点 ratchet（未声明权限的路由启动即失败
  由 RFC-247 既有守卫覆盖，这里补一条「6 条新路由都在目录里」的断言）。

**验收**：AC-1…AC-8、AC-26、AC-29。

---

## PR-3 — 运行时物化

- **T19b**（设计门二轮 H8）**占用校验升级到 tree 层面**：对每个有子挂载点的
  容器，在**选定 ref 的 git tree**（`git ls-tree -r --name-only <ref>`）而不是
  工作树上检查是否存在落在任一子挂载前缀下的已跟踪路径；有 ⇒
  `repo-group-mount-occupied`。sparse checkout 只控制工作树、不删索引里的
  已跟踪路径，只看工作树会漏掉这类冲突。
- **T19c**（设计门二轮 P2-1）**migration ↔ ORM schema 一致性测试**：
  `schema.ts` 表达不了 `lower(name)` 表达式唯一索引、三条 CHECK 与
  `child_group_id` 外键——若有人按 ORM schema 重新生成迁移，这些约束会被静默
  抹掉。加一条从 `sqlite_master` 读真实 DDL 并断言其存在的测试，
  并在 `schema.ts` 就地注释说明「这些约束由 migration 持有」。
- **T19** `util/git.ts` 新增两个原语：
  - `createSparseWorktree(opts)`：`worktree add --no-checkout` +
    `sparse-checkout set --no-cone` + `checkout`（design §3.2）；
  - `commitGitignorePreset(opts)`：T6 的区块写入 + `add .gitignore` + 带
    RFC-067 身份的 commit，返回 `{ commitSha | null }`（null = 幂等跳过）。
- **T20** `services/task.ts` 的 `resolveRepoSpecs` 改三态分派（design §4.1）；
  单成员挂根走 `materializeSingleRepo`，**字节级保 baseline**。
- **T21** `materializeGroupSpace`（取代 `materializeMultiRepoWorktrees`）：
  排序 → 逐层建 worktree → 层内可并发 → 建完一层先写该层的预置 commit 再建下层
  （design §4.2 的硬顺序约束）。`worktrees/group/{taskId}` 根；有成员挂根时根
  目录由 `worktree add` 自己创建。
- **T22** 失败模式：`repo-group-mount-occupied`（E7 的 `already exists` 归一）、
  `repo-group-ref-not-found`（复用 `availableRefs` 形态、带 `mountPath`）、
  `repo-group-sparse-empty`。每条都要有「已建的 worktree 全部回收」的断言。
- **T23** 只读语义（design §3.5）：`gitStashSnapshot` / `pre_snapshot_repos_json`
  跳过只读成员；resume 回滚跳过；任务终态跑一次 dirty 检测并落
  `repo-group-readonly-dirty` 告警事件。
- **T24** `services/commitPushRunner.ts` 调用侧（`services/scheduler.ts:1825`
  的 per-repo 循环）过滤只读成员。
- **T25** 子模块叠加（design §3.4）：sparse 成员的未检出路径下子模块记
  `skipped-by-sparse:<path>`，不算失败。
- **T26** `resolveMultiRepoDirName` 与 `worktrees/multi/` 命名空间删除；
  `task_repos.worktree_dir_name` 列在本 PR 的收尾 migration
  `0132_rfc248_drop_worktree_dir_name.sql` 里通过建新表方式移除
  （bun:sqlite 无 in-place DROP COLUMN，沿用 0035/0041/0057 套路）。
- **T27** 集成测试（真 git，design §10.2 九个场景全覆盖）。**单成员挂根的字节级
  baseline 比对是必过项**——worktree 路径、`tasks.*` 列值、diff 输出三处。

**验收**：AC-10…AC-16、AC-19。

---

## PR-4 — 消费面

- **T28** `wrapper-git` 多仓（design §6.4，**已按设计门二轮 H4 改写**）：
  删两处 `multi-repo-wrapper-git-unsupported`；包裹器对每个**可写**成员各跑
  `gitChangedFiles`，结果用该成员 `mountPath` 前缀化后合并成
  **`list<path>`**（**不是** patch——`nodePorts.ts:188` 的端口类型就是
  `list<path<*>>`）。单可写仓时前缀为空 ⇒ 输出字节级不变。
- **T28b**（设计门二轮 H8）结构化 diff 实体与 join **显式携带 `repoKey`**，
  不再从路径最长前缀反推归属；运行期发现前缀冲突 **fail closed**。
  字符串前缀在展示与文本 diff join 上保留。
- **T30b**（设计门二轮 H9）**重启与定时任务**两个入口（design §2.3a 第 9/10 行）：
  重启按 `sourceTaskId` 用冻结的 `task_repos` 快照重建，**不读当前组**；
  删组时同事务检查引用它的计划任务，默认阻止删除并列出，`force` 时显式禁用。
- **T30c**（设计门二轮 P2-2）MCP 新增独立 kind `repo-groups`，并把工具 kind 与
  `permissionDomain` **解耦**（kind = `repo-groups`，权限域仍是 `repos`）；
  映射六条路由与请求 schema，加资源表/权限/服务路由的漂移测试。
- **T28 旧稿删除** —— 原「git_diff = 每仓一段拼接 patch」的写法作废。
  删
  `multi-repo-wrapper-git-unsupported`（`services/task.ts:1567` +
  `services/scheduler.ts:558`）；包裹器遍历可写成员；`git_diff` 拼接；
  **单可写仓时不加分段头**（字节级保 baseline）。
- **T29** diff 消费面：`services/task.ts:3941-3946` 的拼接改 `repoKeyWire`；
  **文本 diff 与结构化 diff 两类响应都**带 `repoKeys: string[]`；
  `services/structuralDiff/service.ts:147,238` 与
  `services/changeNarrative.ts:124` 换 key 源。
- **T29b**（设计门 G3，**原计划遗漏**）`structuralDiff/assemble.ts:147` 的
  `prefixPath` 改为 `label === '' ? fp : \`${label}/${fp}\``，让根成员不加前缀。
现状不变量是「加前缀 ⟺ 多仓」（单仓走 `service.ts:95-118`早分支完全不加
前缀），不改这一处，组任务里根仓会产出`/src/a.ts`，与文本 diff 的
`src/a.ts`对不上，前端`changeReview.ts:168-180`的 join 静默脱节。`assemble.ts:140-146`注释列的 7 类嵌入路径全部经由`prefixPath`/`prefixIdPath`，改这两个函数即可覆盖。
  **必写测试**：①单仓结构化路径与今天字节级相同；②组任务里根仓路径无前缀、
  嵌套仓路径 = 挂载路径前缀；③文本 diff 与结构化 diff 的路径集合逐字符相等；
  ④「容器仓不可能产出落在挂载点前缀下的路径」这条构造性不变量的回归锁。
- **T30** 上传解禁（D12 / AC-18）：删 `multi-repo-upload-unsupported`
  （`services/task.ts:1579,1651`、`routes/tasks.ts:1302`、
  `services/agentLaunch.ts:458`）；多仓时 `applyUploadsToWorktree` 的
  `worktreePath` 改任务根、`targetDir` 前置 `.agent-workflow-inputs/`；
  该目录进挂根仓的排除清单。**design §11.1 是本条的待确认点**——若用户改口径，
  只改这一个 T。
- **T31** 记忆注入（design §7）：`byScope.repoGroup` 档、`repoIds` 复数化
  （`eq` → `inArray`）、`resolveInjectScope` 从 `tasks.repo_group_id` +
  `task_repos.cached_repo_id[]` 取值、`ScopeBudget` 加档。RFC-046 的注入快照
  结构相应扩一档（**存量快照要能容忍缺档**，否则老任务的 replay 会炸）。
- **T32a** schema + 退役键守卫：`StartTaskSchema` / `StartAgentTaskSchema`
  （`schemas/task.ts:1267`）/ `StartWorkgroupTaskSchema`
  （`schemas/workgroup.ts:597`）删 `repos[]` 加 `repoGroupId`；三态互斥
  superRefine；`MULTI_REPO_MAX` 退役、语义迁到 `MAX_FLAT_REPOS`。
  **顶层 `'repos'` 加进 `RETIRED_START_TASK_KEYS`**（`schemas/task.ts:730`）
  并删掉 `rejectRetiredStartTaskKeys` 里那段把 `repos` 当数组遍历的死代码
  （设计门 G1——StartTask 是非 strict zod，不硬拒就会**静默剥除**并在错误
  工作区成功启动，与 AC-9 的 422 直接矛盾）。
- **T32b** 八个入口逐面迁移（design §2.3a 的契约迁移表，**逐行打勾**）：
  三个 schema + 全部 scheduled payload 档 + `LaunchSpaceFields` /
  `applySpaceFields`（`schemas/task.ts:701-715`）+ REST JSON 与 multipart
  两条 + MCP `launch_task`（`backend/src/mcp/tools.ts`）+ e2e fixture。
  **逐面核实退役键守卫真的接上了**（不假设）。定时任务存量 payload 的降级
  展示验证（AC-35）。契约矩阵测试：每个入口各一条「传 `repos` → 422」。
- **T33** 模板变量（AC-31/32）：`{{__repo_names__}}` 改挂载路径、新增
  `{{__repo_group__}}`；`shared/src/prompt.ts` + `services/scheduler.ts` 的
  `templateMeta`。
- **T34** 测试：`wrapper-git` 多仓端到端（含只读仓不出现在 `git_diff`）、
  分片 key、diff 分段、上传落点、记忆注入四种组合（单仓 / 组 / 组内成员仓有
  repo 记忆 / 单仓不注入组记忆）、三态互斥 7 种非法组合、模板变量渲染。

**验收**：AC-9、AC-17、AC-18、AC-20、AC-22、AC-23、AC-27、AC-28、AC-31…AC-35。

---

## PR-5 — 前端

- **T35** `components/repos/RepoLayoutTree.tsx`（**公共组件**，组编辑器与任务
  详情共用）：展平布局的树形展示，带挂载路径 / ref / 子目录 / 只读标记 /
  `viaGroups` 来源链。
- **T36** `components/repos/RepoGroupEditor.tsx`：`<Dialog>` + `<Field>` +
  `<TextInput>` / `<TextArea>` / `<Select>` / `<Switch>` / `<Segmented>`
  组合；右侧实时布局预览（debounce 400ms 调 `/layout`）。
  **禁止**新造 modal chrome / 表单原语 / 原生 `<select>`（CLAUDE.md 强制条款）。
- **T37** `routes/repos.tsx` 加「远端仓库 | 仓库组」`<Segmented>` 分段，组列表
  复用现有工具条与 `TableViewport`。
- **T38** `routes/tasks.new.tsx` 执行空间改造：混排 `<Select>`、删
  `RepoSourceList.tsx`、`RepoSourceRow.tsx` 退化为单仓、删
  `multiRepoBlockedReason` 及其 banner、选组后展示只读布局预览。
- **T39** 任务详情 header：组名 chip + `RepoLayoutTree`；只读成员被改动的
  `<ErrorBanner variant="warning">` 提示。
- **T40** `DiffViewer.tsx:89` 的 marker 过 `parseRepoKeyWire`；
  `lib/changeReview.ts` 的拆分改最长前缀匹配（key 集合来自后端 `repoKeys`）。
- **T41** `components/memory/MemoryFormFields.tsx:132` 的 `SCOPE_OPTIONS` 加第
  5 档 + `repoGroups` 数据源；`MemoryByScopeBrowser` / `MemoryScopedList` 同步。
- **T42** i18n：zh-CN / en 对称补齐（预估 ~45 个 key）。**必过**「t() 键必须能
  解析」的全库守卫。
- **T43** 视觉对齐自查：把组列表 / 组编辑器 / 启动选择器与 `/agents`
  `/workflows` `/memory` `/settings` side-by-side 比对（按钮高度、圆角、
  spacing、字号）。390px 与 1280px 两档真实浏览器各看一遍。
- **T44** 测试：design §10.4 全部，含三条**源代码层文本断言**兜底
  （`RepoSourceList.tsx` 不存在 / `tasks.new.tsx` 无 `multiRepoBlockedReason` /
  `repoLabels.ts` 无 `sanitizeLabel`）。
- **T45** Playwright e2e：建组（含嵌套组与 sparse 成员）→ 用组启动 → 任务详情
  看布局树 → diff 分段正确。

**验收**：AC-24、AC-25、AC-36 及全部前端面。

---

## 交付前必过清单

- [ ] `bun run typecheck && bun run lint && bun run test && bun run format:check`
      全绿（lint 是 `--max-warnings 0`，一个 unused import 就双 OS 红）
- [ ] 单二进制 build smoke + Playwright e2e
- [ ] push 后按**自己的确切 sha** 查 GitHub Actions（共享 `main` 上并发 push
      会取消你的 run，须看含你 commit 的 superseding commit 的绿）
- [x] **设计门第一轮**（2026-08-02，记档
      [`design-gate-2026-08-02.md`](./design-gate-2026-08-02.md)）：Codex 0.146.0
      对抗式评审，分离 worktree pin 到 `f6e637dd`，13 分钟全程实读源码。
      **3 × P1 + 2 × P2，逐条核实后全部属实、全部折入**（G1 断代面 + 静默剥除、
      G2 迁移编号撞车 + memories 重建丢列、G3 根仓结构化路径不一致、
      G4 manager 权限、G5 删组孤儿记忆）。另有本人自查独立命中 2 条（A1/A2）。
- [ ] **设计门第二轮**（修订后复跑，Codex next-steps 要求）
- [ ] **实现门**：declare done 前再跑一次 Codex review 并修 findings
- [ ] `design/plan.md` 的 RFC 索引状态改 Done；`STATE.md` 已完成表加一行
- [ ] `docs/dev-gotchas.md` 补「嵌套 worktree 的 git 事实」（proposal E1–E4）

## 已知的跨 RFC 撞车点

- **migration 编号（已发生一次真实撞车）**：RFC 落档时最新是 `0129`，写文档
  期间另一并发 session 落了 `f67db859`（含
  `0130_rfc247_audit_snapshot_failed.sql`）与 `94c654ad`。因此本 RFC**不写死
  编号**——每个 PR 动手前与提交前各跑一次
  `ls packages/backend/db/migrations | tail -3` 取尾号顺延。
- **`task_repos` 表**：RFC-243 的父子任务链也读它。T26 的建表重命名要确认
  RFC-243 的读取点在新列名上（`mount_path`）已同步。
- **`tasks.new.tsx`**：RFC-165/218 的向导骨架与 RFC-234/235 的意图构建入口都在
  这个文件里。T38 只动「执行空间」那一段，不碰步骤机。
