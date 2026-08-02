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
