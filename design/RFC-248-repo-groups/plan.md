# RFC-248 — 仓库组 · 任务分解

> 配套 `proposal.md`（决策 D1–D21、验收 AC-1…AC-36）与 `design.md`（§1–§11）。
> 单 RFC / **5 个 PR 按层切**。每个 PR 自带测试、自己跑绿四件套
> （`typecheck` / `lint --max-warnings 0` / `test` / `format:check`），
> push 后按 **exact SHA** 查 CI。

## PR 划分

| PR | 范围 | 依赖 | 大致体量 |
| --- | --- | --- | --- |
| **PR-1** | 纯逻辑地基：shared schema、展平/校验/包含关系/标签/分片的纯函数 + 全套单测 | — | 中 |
| **PR-2** | 持久层与 CRUD：2 个 migration、`services/repoGroup.ts`、`routes/repoGroups.ts`、删仓守卫 | PR-1 | 中 |
| **PR-3** | 运行时物化：布局建 worktree、`.gitignore` 预置 commit、sparse、只读语义、失败回收 | PR-2 | **大** |
| **PR-4** | 消费面：`wrapper-git` 多仓、diff/结构化 diff/分片、上传解禁、记忆第 5 档、模板变量 | PR-3 | 大 |
| **PR-5** | 前端：`/repos` 分段 + 组编辑器 + 布局树、启动选择器改造、任务详情、记忆表单 | PR-4 | 大 |

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
- **T7** 重写 `packages/backend/src/services/repoLabels.ts`：`repoKey` /
  `repoKeyWire` / `parseRepoKeyWire` / `splitRepoPrefix`（最长前缀匹配）。
  **删除** `sanitizeLabel` 与 basename+数字后缀 uniquing。
- **T8** `packages/backend/src/util/diffSplit.ts`：三个 split 函数加仓 key 游标，
  `shard_key` 带挂载路径前缀（design §6.5）。
- **T9** 测试：`repo-group-flatten` / `repo-group-mount-path` /
  `repo-group-containment` / `repo-group-branch-suffix` / `gitignore-preset-block` /
  `repo-labels`（改写）/ `diff-split-repo-prefix`。清单见 design §10.1。
  **`repo-labels.test.ts` 必须带一条显式回归**：`apps/web` 不得被压成 `apps-web`。

**验收**：AC-4（校验规则）、AC-21（key 语义）、AC-20（分片前缀）的纯函数部分全绿。

---

## PR-2 — 持久层与 CRUD

- **T10** migration `0130_rfc248_repo_groups.sql`：建 `repo_groups` /
  `repo_group_members`（含 CHECK 与索引，design §2.1）；`tasks` 加
  `repo_group_id`；`task_repos` 加 `mount_path` / `subdir` / `readonly` /
  `gitignore_commit` 并 backfill `mount_path = worktree_dir_name`。
  **提交前 grep 编号防撞**（当前最新 `0129`）。
- **T11** migration `0131_rfc248_memory_repo_group_scope.sql`：重建 `memories`
  表以扩 CHECK 到 `('agent','workflow','repo','repo_group','global')`。照抄
  `0048_rfc101_fusion.sql` 的建新表 + INSERT SELECT + 索引重建套路，
  **列清单逐列核对**（漏列 = 静默丢数据）。
- **T12** `packages/backend/src/db/schema.ts`：两张新表的 drizzle 定义 +
  三张既有表的列增删。
- **T13** `services/repoGroup.ts`：`listRepoGroups` / `getRepoGroup` /
  `createRepoGroup` / `updateRepoGroup`（version 自增）/ `deleteRepoGroup`
  （引用守卫 + `force`）/ `resolveRepoGroupLayout`（DB loader + T3 展平）。
  URL→id 的成员导入复用 `services/gitRepoCache.ts` 的 resolve（D7）。
- **T14** `routes/repoGroups.ts`：design §8 的 6 条路由，全部 `registerRoute`
  声明权限点；DELETE 的 PAT 分支走 `assertTokenDeleteConfirm`（回显组名）。
  挂进 `server.ts`。
- **T15** `shared/src/schemas/permission.ts` 加 `'repos:update'`；**同时改掉**
  第 22 行与第 108 行「no PUT/PATCH route exists」的注释（它们现在是错的）。
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

- **T28** `wrapper-git` 多仓（design §6.4）：删
  `multi-repo-wrapper-git-unsupported`（`services/task.ts:1567` +
  `services/scheduler.ts:558`）；包裹器遍历可写成员；`git_diff` 拼接；
  **单可写仓时不加分段头**（字节级保 baseline）。
- **T29** diff 消费面：`services/task.ts:3941-3946` 的拼接改 `repoKeyWire`；
  diff 响应带 `repoKeys: string[]`；`services/structuralDiff/service.ts:147,238`
  与 `services/changeNarrative.ts:124` 换 key 源。
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
- **T32** `StartTaskSchema` / `StartWorkgroupTaskSchema` 删 `repos[]` 加
  `repoGroupId`；三态互斥 superRefine；`MULTI_REPO_MAX` 退役、语义迁到
  `MAX_FLAT_REPOS`。定时任务存量 payload 的降级展示验证（AC-35）。
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
- [ ] **设计门**：RFC 请批前跑一次 Codex review 并修 findings（本文件落档后、
      用户批准前）
- [ ] **实现门**：declare done 前再跑一次 Codex review 并修 findings
- [ ] `design/plan.md` 的 RFC 索引状态改 Done；`STATE.md` 已完成表加一行
- [ ] `docs/dev-gotchas.md` 补「嵌套 worktree 的 git 事实」（proposal E1–E4）

## 已知的跨 RFC 撞车点

- **migration 编号**：本 RFC 占 `0130` / `0131` / `0132`。若有并行 RFC 也在排队，
  提交前 `ls packages/backend/db/migrations | tail` 复核并顺延。
- **`task_repos` 表**：RFC-243 的父子任务链也读它。T26 的建表重命名要确认
  RFC-243 的读取点在新列名上（`mount_path`）已同步。
- **`tasks.new.tsx`**：RFC-165/218 的向导骨架与 RFC-234/235 的意图构建入口都在
  这个文件里。T38 只动「执行空间」那一段，不碰步骤机。
