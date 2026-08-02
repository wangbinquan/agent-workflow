# RFC-248 设计门记录（2026-08-02）

工具：Codex CLI 0.146.0，`adversarial-review --base f6e637dd^`，从 pin 到
`f6e637dd` 的**分离 worktree** 跑（共享树上并发 diff 会吞掉 review，
`docs/dev-gotchas.md` §Codex）。耗时约 13 分钟，全程实读仓内源码
（`task.ts` / `util/git.ts` / `snapshotFullState` / `commitPushRunner.ts` /
`scheduler.ts` / `permission.ts` / `memory.ts` / `structuralDiff/` /
`changeReview.ts` / `schemas/task.ts` / migrations），**不是空洞通过**。

结论：**3 × P1(high) + 2 × P2(medium)，逐条核实后全部属实、全部折入**。
（Codex 收尾语提到「三个 P0」，但 findings 列表里最高只到 P1；以列表为准。）

另有**两条本人并行自查独立命中**的问题，其中一条与 Codex 的 G2 重合
（互相印证），一条 Codex 未提。

---

## G1 [P1] `StartTask.repos[]` 断代面未穷尽，且旧字段会被**静默剥除**

**核实属实。** 三处证据：

- `StartAgentTaskSchema`（`packages/shared/src/schemas/task.ts:1267`）自带
  `repos: z.array(z.unknown()).min(1).max(16).optional()`，
  `StartWorkgroupTaskSchema`（`schemas/workgroup.ts:597`）同形。原 plan T32
  只列了 StartTask / StartWorkgroup，**漏了 agent 面**。
- `RETIRED_START_TASK_KEYS`（`schemas/task.ts:730`）=
  `['repoPath','baseBranch','fetchBeforeLaunch']`，**没有顶层 `repos`**；
  `rejectRetiredStartTaskKeys` 只把 `repos` 当**数组遍历**去查行内退役键。
  StartTask 用的是非 strict zod ⇒ 删掉 `repos` 字段后，旧客户端传 `repos`
  会被**静默剥除**，然后在**错误的工作区**里把任务跑起来并返回 200。
  这与 AC-9 要求的 422 直接矛盾。
- 定时任务 payload（`schemas/scheduledTask.ts` 的 agent 档继承
  `StartAgentTaskSchema`）、`LaunchSpaceFields` / `applySpaceFields`
  （`schemas/task.ts:701-715`）、MCP `launch_task`
  （`backend/src/mcp/tools.ts`）都还只认 `repos`。

**处置（全采纳）**：

1. `RETIRED_START_TASK_KEYS` 增加顶层 `'repos'`，并**删掉**
   `rejectRetiredStartTaskKeys` 里那段把 `repos` 当数组遍历的死代码
   （顶层已硬拒，行内检查不可达）。
2. 建立**启动入口契约迁移表**并逐个落实（写进 design §2.3a）：
   `StartTaskSchema` / `StartAgentTaskSchema` / `StartWorkgroupTaskSchema` /
   全部 scheduled payload 档 / `LaunchSpaceFields` + `applySpaceFields` /
   REST JSON + multipart 两条 / MCP `launch_task` 工具 / e2e fixture。
3. `rejectRetiredStartTaskKeys` 必须在**任何 schema parse 之前**跑，且三个
   启动面都要接上（实现期逐面核实，不假设已接）。
4. plan T32 拆成 **T32a（schema + 退役键守卫）** 与
   **T32b（八个入口逐面迁移 + 契约矩阵测试）**。

## G2 [P1] migration 编号已冲突；memories 重建模板会丢列丢索引

**核实属实，且比 Codex 描述的更动态。** 本 session 启动时最新迁移是
`0129`；写 RFC 期间另一并发 session 连着落了两个 commit
（`f67db859` 16:21、`94c654ad`），其中 `0130_rfc247_audit_snapshot_failed.sql`
已经占号。RFC 里写死的 0130–0132 直接撞车。

memories 重建模板一条 —— **本人自查已独立命中并在门跑完前就修掉了**
（两边独立得出同一结论）：0048 早于 RFC-223，缺 `fused_into_skill_id` 列与
`idx_memories_fused_skill_id` 索引，照抄会静默丢整列溯源数据。权威基线是
`0117_rfc223_fusion_provenance.sql:119-190` 的 24 列 + 4 索引 + 6 CHECK +
2 自引用 FK，且 0117 的 rename-first 顺序是有原因的（自引用 FK 在
`legacy_alter_table` 两种模式下重写行为不同，daemon 迁移期 `foreign_keys=OFF`
而直连 migrator/测试是 `ON`）。

**处置（全采纳）**：

1. RFC 内**不再写死编号**，改为「实现期 `ls packages/backend/db/migrations | tail`
   现取尾号顺延」，并把这一步写进 plan 的必过清单。当前预期 0131/0132/0133。
2. memories 重建以 0117 为唯一基线（已改，见 design §2.2 与 plan T11）。
3. **新增迁移后校验**（Codex 建议，采纳）：同事务内校验行数一致、
   `fused_into_skill_id` 非空计数一致、索引集合一致、`PRAGMA foreign_key_check`
   为空，任一不符即 abort。写成 plan 的 T11b。

## G3 [P1] 根仓的结构化 diff 路径与文本 diff 不一致

**核实属实，且是本 RFC 新引入的缺陷。** 现状不变量是「**加前缀 ⟺ 多仓**」：

- 单仓走 `structuralDiff/service.ts:95-118` 的**早分支**，直接
  `computeFromWorktree`，**完全不加前缀** → `src/a.ts`，与文本 diff（单仓无
  `# === Repo:` 分段头）一致。
- 多仓走 `service.ts:147-172`，每个 part 过 `mergeStructuralDiffs`
  （`assemble.ts:224-252`），而 `prefixPath = (label, fp) => \`${label}/${fp}\``
（`assemble.ts:147`）是**无条件**的。

我的设计把根成员的 key 定为 `''`、wire 形态定为 `.`，塞进现有 assembler 会得到
`/src/a.ts` 或 `./src/a.ts`，**两者都不等于**文本 diff 的 `src/a.ts`；
`frontend/src/lib/changeReview.ts` 靠路径相等来 join 两侧，于是根仓的符号、
严重度、文件内容、导航会**静默脱节**。原 plan T29 没碰 assembler。

**处置（采纳缺陷，部分采纳建议）**：

1. `prefixPath` 改为「`label === ''` 时原样返回 `fp`」。这样：
   单仓（根成员 + 计数 1）走早分支不变 → **baseline 字节级保住**；
   组任务里根成员无前缀、其余成员前缀 = 挂载路径 → **与文本 diff 逐字符相等**。
   `prefixIdPath` / `prefixSymbolId` / `prefixCardId` / `prefixClassEdge` /
   `prefixFile` / `prefixChange` / `prefixImpactItem` 全部经由 `prefixPath`
   与 `prefixIdPath`，**改这两个函数即可覆盖全部嵌入路径**（assemble.ts:140-146
   的注释列了 7 类嵌入点，逐一核对过）。
2. 响应带 `repoKeys: string[]`，前端**不自己猜** key 集合（design §6.3 已有，
   本次补上「结构化 diff 响应同样带」）。
3. **未采纳** Codex「给结构化实体加独立 `repoKey` 字段、彻底不用字符串前缀」
   的重构建议。理由：字符串前缀是 RFC-089/239/240/241 与前端 join 的既有承重
   结构，改成独立字段是跨四个 RFC 的大重构；而本场景下最长前缀匹配
   **按构造无歧义**——挂载点在启动期就被证明在其容器仓里不存在
   （E7 占用校验：`git worktree add` 到已存在非空目录直接 fatal），之后又被
   `.gitignore` 预置 commit 排除，所以容器仓**永远不可能**产出落在某个挂载点
   前缀下的路径。这条不变量写进 design §6.3 并配一条专门的回归测试。
   Codex 的深层关切（身份不该编码进字符串）如实登记进
   `docs/audit-backlog.md`，留给未来的结构化 diff 重构 RFC。

## G4 [P2] 只加 `repos:update` 字面量会让 manager 建得了组、改不了组

**核实属实。** `MANAGER_EXTRA`（`schemas/permission.ts:344-350`）显式列举
`['repos:create','repos:delete','repos:execute','tasks:read:all']`，注释还写明
「Repos are out of the ACL model, so the repos points are plain points here」
——即 repos 域的能力**完全靠这张手工表**授予。新增 `repos:update` 若不进这张
表，manager 建完组对 PUT 拿 403，也无法给 PAT 授权。

**处置（全采纳）**：`repos:update` 同时进 `PERMISSIONS`、`MANAGER_EXTRA` 与
PAT 授权矩阵；补 MCP 的 repo-group 资源映射与 `docs/api` 条目；测试用
admin / manager / 普通用户 / 窄 PAT 四档跑路由级授权矩阵。

## G5 [P2] 「删组后记忆 fail-closed」的断言与现有分支相反

**核实属实，是我 proposal 里的一处事实错误。** AC-30 写「按
`services/memory.ts:745-746` fail-closed 处置」，但那条 fail-closed
**只覆盖 agent/workflow**：`canViewMemory`（`memory.ts:743`）与
`filterVisibleMemories`（`memory.ts:807`）对 `repo`/`global` 都是**在加载资源行
之前就直接 return true**。AC-29 又要求把 `repo_group` 并进 repo/global 这一档
——两条自相矛盾：按 AC-29 扩展后，删组会留下**仍可列出、仍会被注入**的孤儿
记忆（`tasks.repo_group_id` 还留着旧 id，注入照样命中）。

**处置（采纳问题，方案取 Codex 的第一支）**：

1. AC-29 保留（`repo_group` 与 repo/global 同档：全员可读、仅 admin 可管）。
2. **AC-30 重写**：删除组时在**同一事务**里把绑在它上面的记忆置为
   `archived`（不硬删——保住用户知识；`archived` 已被
   `memoryInject` 的 `status='approved'` 过滤排除，注入立即停止）。
   DELETE 响应体与前端确认弹窗回报受影响条数。
3. 新增 `tasks.repo_group_name`（快照列，与 D8 一致），让任务详情的组 chip
   在组被删除后仍能渲染，而不是回退成一个悬空 id。
4. 明确「已有任务用冻结快照」：`task_repos` 本就是快照，删组不影响在跑任务的
   布局；只有**组记忆**停止注入。

---

## 本人自查独立命中（Codex 未提）

- **A1**：嵌套 worktree 的回收顺序。实测（proposal E9）证明 git 会自愈
  ——先删外层会连带删掉内层目录、内层注册被标 `prunable`、再删返回 0 且注册表
  干净，`cleanupCreatedWorktree` 的 `exitCode !== 0` 判据不误报。**不是坏账**，
  但已把「按挂载深度倒序回收」定为要求而非依赖自愈（design §4.3）。
- **A2**：仓标签被消费的三处（`worktreeFileContent.ts:151`、
  `structuralDiff/service.ts:147,238`、`changeNarrative.ts:124`）**只把它当
  标识符**，从不当路径组件展开——所以带 `/` 的挂载路径安全。连带补了两个契约
  点：`?repo=` 查询参数需 `encodeURIComponent`、根仓传 `.`；
  `service.ts:239` 的 `perRepoNodeRuns(rows, repo.worktreeDirName)` 是
  `worktreeDirName` 的又一消费者，随 T26 迁移。

## 端到端物化原型（proposal E8）

`design/RFC-248-repo-groups/materialize-prototype.sh` 把整条 PR-3 流水线
（挂根 + 只读 + 三层嵌套 + sparse + 同仓两份，共 5 个 worktree）跑通并断言：
各仓 status 全干净、diff 互不串味、根仓 diff 不含 `.gitignore` 与任何挂载点、
`git add -A` 零 embedded-repo 告警、分支序号正确、幂等复检通过。
PR-3 的集成测试即为这份原型的 TypeScript 化。

## 复门

按 Codex 的 next-steps 建议，修订后**重跑一次设计门**（记录追加到本文件），
再请用户批准。

---

# 第二轮（同日，审至 `024d843a`）

工具同上，分离 worktree pin 到 `fb04f84e`，**47 分钟**。范围是一轮的三倍：复核
一轮 5 条修法 + 审 PR-1/PR-2 已落地代码 + 我点名的 6 个攻击向量 + 两个 migration。

**判定：needs-attention，不应发版。9 × P1 + 2 × P2。**

先记**已闭合**的：G2 独立验证通过——「0132 与 0117 的 24 列、7 个 CHECK、
2 个自外键和 5 个索引等价；`foreign_keys` × `legacy_alter_table` 四种组合的迁移
探针均通过，TEMP 表也能跨 statement-breakpoint 存活」。这是外部证据，比我自己的
16 条迁移测试更有说服力。

## 已在本轮修掉的代码缺陷（5 条 P1）

| #      | 缺陷                                                                                                                                                                                                                                                                                                      | 修法                                                                                                                                             | 锁                                                                                |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| **H1** | **校验发生在事务提交后**：`createRepoGroup` 先提交组+成员再 `assertFlattenable`，于是返回 422 的请求**仍把非法组持久化**了；`update` 同样先替换成员并自增 version 再校验。且无 OCC，两个并发全量替换静默互相覆盖。                                                                                        | 校验移进 `dbTxSync` 内（抛出即回滚）；`update` 在事务内**重读** version 并支持 `expectedVersion` OCC，冲突回 409 `repo-group-version-conflict`。 | 三条：失败 create 不留记录 / 失败 update 成员与 version 完全不变 / OCC 冲突不覆盖 |
| **H2** | **force 删仓横跨 DB 与 FS**：detach 在 `withUrlLock` **之前**，等锁期间可新建引用；中途崩溃留下「组已改、`cached_repos` 还在」的断链。                                                                                                                                                                    | detach 移进锁内、与删行放进**同一事务**，并在锁内**重查**引用（用启动时快照会漏掉新引用）。                                                      | —                                                                                 |
| **H3** | **含 fused 记忆的组永远删不掉**：删组把所有非 archived 记忆 `UPDATE ... SET status='archived'`，而 0132 的 CHECK 是 `(status='fused') = (fused_into_skill IS NOT NULL)` ⇒ 违反约束、整个删除事务 **500 回滚**。                                                                                           | 引入 `ARCHIVABLE_STATUSES`（不含 `fused`）。fused 本就是终态且被 `memoryInject` 的 `status='approved'` 过滤排除，注入早就停了，不动它是正确的。  | 一条：组里同时有 approved + fused，删组成功、fused 原样保留                       |
| **H6** | 挂载路径校验三个洞：①`isUnder` 区分大小写而查重折叠 ⇒ macOS 上 `Vendor` 与 `vendor/sdk` **实际嵌套**却被排除计划当兄弟 ⇒ 内层不被排除 ⇒ `add -A` 当 gitlink 提交；②允许 U+2028/U+2029（JS 正则的 `^`/`$` 认它们，会打断单行 marker）；③允许把 `.agent-workflow-inputs` 当挂载点，上传物会落进那个成员仓。 | `isUnder` 改折叠比较；控制字符检查改按码点（C0 + DEL + C1 + U+2028/29 + 反斜杠）；保留首段 `.agent-workflow-inputs`。                            | 四条                                                                              |
| **H7** | **展平可指数遍历而绕过上限**：预算只在追加真实 repo 时计，走 group 边不计。`force=1` 删仓会留下空叶子组，深度 5 × 每层 32 条边 ≈ 3400 万次同步递归、产出 0 个 repo，永远撞不到 `MAX_FLAT_REPOS`，daemon 事件循环卡死。                                                                                    | 另设独立**遍历预算**，每访问一个节点就扣。                                                                                                       | 一条：20 宽 × 5 深的零产出菱形图必须立即报错（带耗时上界断言）                    |

## 本轮采纳并改设计的（尚未实现，归 PR-3/PR-4/PR-5）

### H4【P1】`git_diff` 端口契约与设计稿冲突——**设计稿错了**

核实属实且比 Codex 描述的更彻底：`nodePorts.ts:188` 声明
`git_diff` 是 `list<path<*>>`，`scheduler.ts:7834` 注释写明是「newline-joined
file paths」。**它从来不是完整 patch。** 而且 `util/diffSplit.ts` 经查有
**零生产调用方**。

⇒ **design §6.4 的「git_diff = 每仓一段拼接的 patch」是错的**，照它实现会让
wrapper-fanout 把 marker 行和补丁行当成路径。

**已做**：回退 PR-1 里给 `parseDiff` 加的仓 marker 游标与配套测试——那是为一个
现已证伪的设计写的投机代码，且模块本身无人调用。

**新契约（改写 design §6.4/§6.5）**：保持 `list<path>`。wrapper-git 对每个
**可写**成员各跑一次 `gitChangedFiles`，把结果用该成员的 `mountPath` 前缀化后
合并。仓归属建模为 `repoKey + relPath`，**不从文本 marker 或目录深度反推**。
若将来真需要完整 patch，另开一个独立的 `string` 端口，不动 `git_diff`。

### H8【P1】「最长前缀匹配按构造无歧义」的论证**不成立**

一轮我用这条构造性不变量否决了「给结构化实体加独立 `repoKey`」的重构。Codex
给出了反例：**sparse checkout 只控制工作树，不删除索引里的已跟踪路径**。容器仓
可以仍然跟踪 `hidden/dep/file`，而工作树里 `hidden/dep` 不存在——于是
`git worktree add` 到 `hidden/dep` 会成功（E7 的占用校验看的是工作树）。此后
`git rm --cached --sparse` 或 plumbing 操作能让容器产出同一路径的变更，
`splitRepoPrefix` 会无条件把它判给子仓，结构化 diff **静默错归属**。

**处置**：撤回一轮的否决。改为——

1. **运行期 fail-closed**：物化时对每个有子挂载点的容器，在**选定 ref 的 git
   tree 层面**（不是工作树）检查是否有落在任一子挂载前缀下的已跟踪路径；
   有 ⇒ `repo-group-mount-occupied`。这把 E7 从「工作树占用」升级为
   「索引/树占用」，堵住 sparse 那条缝。
2. **显式 `repoKey`**：结构化 diff 实体与 join 携带独立的 `repoKey` 字段，
   不再从路径反推。这条正是一轮登记进 `docs/audit-backlog.md` 的那项——现在它
   从「未来重构」升级为 **PR-4 必做**，backlog 条目相应改写。

### H9【P1】八入口迁移表漏了**重启**与**定时任务**

`taskToLaunchPayload` 会从旧任务重建 `payload.repos`；顶层 `repos` 退役后重启
直接 422。简单改成 `repoGroupId` 又会读**可变的当前组**，组删除后失效——而正确
语义是复用任务自己的**冻结快照**。定时任务持久化整个 StartTask body，删组时也
没有检查或禁用引用它的计划。

**处置**：design §2.3a 的迁移表从 8 行扩到 **10 行**，新增：

- **重启**：服务端按 `sourceTaskId` 用冻结的 `task_repos` 快照重建，
  **不**读当前组定义。
- **定时任务**：删组时在同一事务里检查引用它的计划——默认**阻止删除**并列出，
  `force` 时显式禁用它们（而不是留一堆反复失败的计划）。

### P2-1 plan.md 与真实 schema 漂移

`0132` 已被记忆 scope 占用，删 `worktree_dir_name` 那条得另取号；文档写「4 个
索引 / 6 个 CHECK」，实际是 **5 个索引 / 7 个 CHECK**；`schema.ts` 缺
`lower(name)` 唯一索引、三条 CHECK 与 `child_group_id` 外键——若有人按 ORM
schema 重新生成迁移，这些约束会被抹掉。

**处置**：修正文档计数；`schema.ts` 补注释说明「这些约束由 migration 持有、
drizzle 表达不了」，并加一条 **migration ↔ ORM schema 精确一致性测试**（PR-3）。

### P2-2 MCP `resource_write` 够不着仓库组

`RESOURCE_ROUTES.repos` 只映射 cached-repos 且明确声明没有 update。
**处置**：新增独立 MCP kind `repo-groups`，并把工具 kind 与 `permissionDomain`
**解耦**——kind 是 `repo-groups`，权限域仍是 `repos`。归 PR-4。

## 复门

三条 P1（H4/H8/H9）改的是**尚未实现**的设计，两条 P2 同理。它们落地在 PR-3/PR-4
之后需要**第三轮**设计门；本轮修掉的 5 条代码 P1 已带回归锁。
