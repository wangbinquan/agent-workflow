# RFC-210 任务分解（v2）

> **v2**：三路对抗设计门折入 7 P0 + 约 20 条 P1/P2。**PR 顺序相对 v1 已重排**——v1 的
> "PR-B(gitlink 修复) 可先上线" 被证伪：步骤⑤ 依赖的是**对象回写**（T14），不是 alternates（T5）。
> 详见 `design.md` §0.2 / §0.3。编号规则 `RFC-210-T{n}`。

## 1. 任务清单

### PR-1 地基：池原语 + 配置管道 + migration（无用户可见行为变更）

> **进度（2026-07-20）：PR-1 全部 13 项已实现**。T1-T7 已上 main 且 CI 绿（`b9fdecd6` + `e447fb58`）；
> T8/T9/T10/T11/T11b/T12/T13 待提交。
>
> **T9 的实现比本计划写的简单得多**：原计划要打通 4 层签名，实测调用图后改为
> **让 `resolveSubmoduleParams` 自己读配置**——一处改动，5 个生产调用点全部自动受益，零签名变更。
> 详见 design.md §10.2。（顺带查明 RFC-034 断链的物理成因：`scheduler.ts` 与 `nodeIsolation.ts`
> **都不 import config**，没有任何人处在能传配置的位置上。）
>
> **实现中回写设计的三处修正**：① `--reference` 的行为**跨 git 版本不一致**（本机 no-op、CI 会挂上），
> 断言必须版本无关；② `submoduleAutoRefresh` 写成必填会让存量 config 解析失败、daemon 拒绝启动，
> 必须 `.optional()` **且** `DEFAULT_CONFIG` 有值（后者才让它进深合并集）；
> ③ `--remote`（G8）的作用点从读侧改到 `createWorktree`，否则对任务是 no-op。
>
> **实测踩中的既有测试锁**（审计精确预测过）：`migration-0041-rfc074-drop-cci.test.ts` 的
> **列数算术锁**——加两列 ⟹ `Expected: 47 / Received: 49`，症状是列数不等而**不是** `no column named`
> （后者早被前人用显式列名裸 SQL 填平了）。全量 backend 5985 条里只有它一条红。

| ID | 任务 | 落点 | 依赖 |
|---|---|---|---|
| **T1** | `listSubmodules`：`submodule status --recursive` 解析。契约写清——返回**工作区 HEAD**（非 index gitlink）、`flag` 四态、未初始化子仓不被展开、路径可含空格、`pathDepth` 仅用于排序**不可**当"层级"判据 | `services/gitSubmodule.ts` | — |
| **T2** | `resolveSubmodulePool`：走 `rev-parse --git-common-dir` + 在宿主仓解析同名子路径（不自行拼 `modules/x/modules/y`）；**path 模式返回 null**（D11） | 同上 | T1 |
| **T3** | `ensureSubmoduleAlternates`：`--init [--reference]` + **无条件显式写 `objects/info/alternates`**（`--reference` 对已初始化 module dir 是 no-op）；**逐子仓**调用（单个 `--reference` 会被 git 套用到全部子仓） | 同上 | T2 |
| **T4** | `pushObjectsToPool`：`fetch` + **紧跟 `update-ref refs/agent-workflow/pool/<taskId>/<subPath>`**（两步不可分割——无 ref 则默认 gc 会删） | 同上 | T2 |
| **T5** | `snapshotSubmodule` / `rollbackSubmodule`（G10 原语）：临时 index + `write-tree` + `commit-tree`；回滚 `reset --hard` → `read-tree` → `checkout-index -f -a` → `reset --mixed` | 同上 | — |
| **T6** | **全局性能门**：所有 submodule 逻辑第一道门恒为 `detectSubmodules`（`existsSync`，零进程）；`hasDirtySubmoduleContent`（`util/git.ts:1690`）补同一道门 | `util/git.ts`、`gitSubmodule.ts` | — |
| **T7** | `SubmoduleSyncOptions` 增 `remote?`；argv 未传时**逐字节不变** | `gitSubmodule.ts:55-98` | — |
| **T8** | config schema 三项新字段（统一 `.optional()`，真实默认在 `resolveSubmoduleParams` 兜）+ **`mergeDefaults`/`mergePatch` 认新嵌套字段**（不改则将来加字段会让 daemon 起不来、且部分 PATCH 400） | `shared/schemas/config.ts:216-232`、`backend/config/index.ts:104-152` | — |
| **T9** | 配置管道打通 **4 层**：`createIsoUnderLock`(`isolatedAgentRun.ts:49-74`) → `createNodeIso` → `mergeBackNodeIso`(签名加配置位) → `materializeTree` **6 个调用点**（`nodeIsolation.ts:386/407/483/647/741/789`）。**`util/git.ts` 不自取 config**（静态 import `@/config` 有 binary 模块环前科） | 多处 | T8 |
| **T10** | migration **0102**（v2 的 0100 已被占用；`0101` 由并发 session 持有未提交）**三列**：`cached_repos.last_auto_refresh_at` + `node_runs.iso_submodules_json` + `node_runs.iso_submodules_repos_json`（single/multi 双列制，与既有 iso 列同构），带 `--> statement-breakpoint`。**落地前必须再核编号** | `packages/backend/db/migrations/` | — |
| **T11** | 同步 `upgrade-rolling.test.ts:230`（现值 **100**，按落地时实际 HEAD 值 +1，别照抄文档数字）+ **`migration-0041-rfc074-drop-cci.test.ts:160` 的 node_runs 列数算术锁**（加两列 ⟹ 补两项 + 注释账本）+ 新增 `migration-0102-*.test.ts`。**跑全量 backend 测试**防 journal↔files 失配；提交时只 `git add` 自己的 migration 文件 | 既有 + 新 | T10 |
| **T11b** | `IsoSubmodulesSchema` zod 定义（design §2.1.1）+ `persistIsoBase` 的 single/multi 分叉写入 + `pendingSubResolves` 的 merge-back 阶段增量更新方指派 | `shared/schemas/`、`isolatedAgentRun.ts:97-115` | T10 |
| **T12** | 测试：`rfc210-submodule-topology` / `-alternates`（**含已初始化 module dir 补挂 + 逐子仓不交叉污染**）/ `-pool-gc-survival`（**保活 ref 扛默认 gc**）/ `-config-wiring`（argv spy，AC-11）/ `-byte-baseline`（AC-10/12） | `packages/backend/tests/` | T1-T9 |
| **T13** | 更新 `git-submodule.test.ts` argv 矩阵、`git-repo-cache-submodule.test.ts:136-195`（deps 形状）、`worktree-working-branch.test.ts`（**12 处** `submoduleMode:'never'`）、`compat-config-versions.test.ts` + `config.test.ts`（DEFAULT_CONFIG） | 既有 | T7,T8 |

### PR-2 iso 子仓回写 + 快照（gitlink 修复的前提）

> **实现锚点（2026-07-20 读码确认，行号随并发提交会漂，按符号找）**：
> - `IsoRepo`（`nodeIsolation.ts:43-66`）需加 `subBases: Record<string,string>` + `poolDir: string | null`。
>   **必须挂在 handle 上**而不是现用现查——`nodeIsolation` 的模块契约是 git-only 不查 DB（`:127`），
>   而 `mergeBackNodeIso` 正是在那里需要 subBases。
> - `rebuildIsoHandle`（`:210-241`）按同样两个字段扩参，四个调用点全改（T26）。
> - D22 fail-loud 在 `snapshotNodeIsoFinal` 里（`:263-277`），T16 删的就是这段。
> - `mergeBackNodeIso` 的每仓循环（`:343-414`）结构是
>   `ours = snapshotFullState(canon)` → `mergeTreeInMemory(base, ours, theirs)` → 冲突则 salvage、否则 materialize。
>   T23 的子仓层合并插在 `mergeTreeInMemory` **之前**，并把结果 gitlink 写进 `theirs` tree。
> - `persistIsoBase`（`isolatedAgentRun.ts:83-115`）是 single/multi 分叉的样板，
>   `iso_submodules_json` / `_repos_json` 照抄它的 `repoCount === 1` 分支形状。
>   注意它在 `passthrough` 时**整行不写**（`:89`），AC-17 的 fail-closed 判据要先查 passthrough。

| ID | 任务 | 落点 | 依赖 |
|---|---|---|---|
| **T14** | iso 创建记录每层 base（`subBases`）；由 `persistIsoBase` 写 `iso_submodules_json`（**不能**在 `nodeIsolation` 写——该模块契约是 git-only 不查 DB） | `nodeIsolation.ts:119-207`、`isolatedAgentRun.ts:83-115` | T1,T10 |
| **T15** | 终态快照前：**无条件** `pushObjectsToPool`（不只对"脏"子仓——agent 可能自己提交，此时子仓干净而 `worktree remove --force` 会连 module dir 一起删）+ 脏则自动 commit | `nodeIsolation.ts:249-286` | T4,T14 |
| **T16** | *(v3 移入 PR-3，见下)* | — | — |
| **T17** | 测试：`rfc210-subrepo-snapshot-rollback`（untracked 恢复 / 嵌套顺序 / pinRef 扛 gc / 快照落 DB 后崩溃可恢复）。**注**：「已 push 不可逆」的用例移到 PR-5 的 T34——PR-2 阶段 commit-push 子仓通道尚不存在，此处测不了 | 新 | T5,T15 |
| **T17b** | `rollbackSubmodulesRecursive` 编排层（自底向上回滚 + 自顶向下修父层 gitlink，design §6.1.3）——v2 只造了单仓原语，没有编排任务 | `services/gitSubmodule.ts` | T5 |
| **T17c** | **D11 降级通道**（v2 只判定不实现）：`poolDir === null` 时 `pushObjectsToPool` 回写到**目标 worktree 私有 module dir** 并建 `wt/` 锚；否则 T15 的"无条件回写"在 path 模式下是 no-op ⟹ 步骤⑤ 必然 `checkout` 失败 ⟹ 按 §3.2 判致命，path 模式**永久硬失败** | `gitSubmodule.ts`、`nodeIsolation.ts` | T2,T4 |

### PR-3 merge-back gitlink 修复（红→绿）

| ID | 任务 | 落点 | 依赖 |
|---|---|---|---|
| **T16**（v3 从 PR-2 移入） | 删除 D22 fail-loud（`nodeIsolation.ts:264-275`）；`hasDirtySubmoduleContent` 降级为探针。**必须与 T19 同 PR**——单独上线会拆掉唯一止损网而修复未到，用户从"显式报错"退化为"静默丢"，覆盖面还从"agent 自己提交"扩大到"所有脏子仓" | `nodeIsolation.ts`、`util/git.ts:1690` | T15 |
| **T16b** | 更新 `rfc130-iso-worktree-primitives.test.ts:242-260`（D22 探针语义） | 既有 | T16 |
| **T18** | **先写红**：`rfc210-materialize-gitlink-regression.test.ts`（design §3.1 对照表） | 新 | T15 |
| **T19** | `materializeTree` 追加步骤⑤：**逐层递归**取 gitlink（`ls-tree -r` 穿不透 gitlink）→ `checkout --detach`；**必须在 `syncSubmodules` 之后** | `util/git.ts:2009-2052` | T18 |
| **T20** | 失败语义分级（修 v1 的过度 fail-loud）：**canonical 子仓脏**先走 T5 快照再 `checkout -f`，非致命；对象缺失才致命。同时修 `util/git.ts:1827`/`:2051` 丢弃返回值 | 同上 | T19,T5 |
| **T21** | `materializeTree` 增 `gitlinkFailureMode?: 'throw'\|'warn'`；`undoPriorShardDeltaInIso` 调用点传 `'warn'` 以保住其 **FAIL-OPEN、never destructive** 契约 | `util/git.ts`、`nodeIsolation.ts:483` | T19 |
| **T22** | 更新 `rfc130-shard-rerun-undo.test.ts`（fail-open 仍成立） | 既有 | T21 |

### PR-4 递归合并 + 冲突 + replay/resume

| ID | 任务 | 落点 | 依赖 |
|---|---|---|---|
| **T23** | 子仓层递归三路合并（design §2.3 的分支表）；**双 parent** `commit-tree -p <ours> -p <theirs>`（ours 在前）；扩展 `commitTree()`（`util/git.ts:1978`，现只收一个 parent）；父层 tree **逐层重写** | `nodeIsolation.ts:336-414`、`util/git.ts` | T15 |
| **T24** | 拓扑变更分支：新增/删除/重命名 submodule、`.gitmodules` url 变更（sync 只在 canonical 跑）、**gitlink 的 modify/delete 必须在 `buildSalvageTree` 前拦截**（否则被 revert 成 ours 后 `materializeTree` 会 `rm -rf` 掉该子仓目录）；`exit>1` 与 `exit=1` 分流（前者致命，不得开 resolve-iso） | 同上 | T23 |
| **T25** | 子仓级 resolve-iso：`worktree add` 后**必须跑 `syncSubmodules`**（v1 漏；worktree add 不填充子仓工作区，merge agent 会面对空目录）；merge agent prompt 变体 | `mergeAgent.ts`、`nodeIsolation.ts:577-594` | T23 |
| **T26** | **crash replay 通道**：`IsoRepo`/`rebuildIsoHandle` 增 `subBases`/`poolDir`，**4 个调用点**（`scheduler.ts:2239/2319/5698/5720`）全部改；列缺失但仓有 `.gitmodules` ⟹ **fail-closed 拒绝 replay** | `nodeIsolation.ts:210-242`、`scheduler.ts` | T14 |
| **T27** | **human resume 通道**：`iso_submodules_json` 增 `pendingSubResolves`；`completeHumanResolvedConflict` 开头校验子仓已解决，**绝不**走 `:726-747` 重探分支（会把未解决 gitlink 当已解决放行） | `nodeIsolation.ts:696-806` | T25 |
| **T28** | ref/目录清理：`deleteIsoRefs` 增池 ref 参数；`runIsoWorktreeGc` 追加按前缀批量删池 ref（**兜底**，池是跨任务共享的）+ 激活死代码 `isoRefGlob`；子仓 resolve-iso 的 `worktree prune` | `util/git.ts:2072`、`services/gc.ts:327` | T23,T25 |
| **T29** | 测试：`rfc210-recursive-isolation`（嵌套≥2 层 / 双 parent 契约 / **单 parent 必 exit=1 的防回归** / 拓扑变更）、`-crash-replay-subrepo`、`-conflict-resume-subrepo`（fail-closed）；更新 `rfc130-crash-replay` / `-merge-resolve` / `-wrapper-private-canonical` / `-iso-gc` / `rfc188-isolated-agent-run`（`createIsoUnderLock` 签名） | 新 + 既有 | T23-T28 |

### PR-5 auto-commit-push 递归 + wire

| ID | 任务 | 落点 | 依赖 |
|---|---|---|---|
| **T30** | 子仓段：`checkout -B` → commit → push；**锁边界**：本地写进 `acquireWrite`、网络 push 出锁（与父仓既有边界同构）；子仓 push 失败先做一次 `fetch`+`merge --no-edit` 再判失败 | `commitPushRunner.ts:194-290` | T1,T5 |
| **T31** | 原子性**限定为 per-repo**（`scheduler.ts:1598` 是 per-repo 循环，与 RFC-066 一致）；失败时回退**未 push** 的子仓提交；已 push 则不回退并标不一致态 | 同上 | T30 |
| **T32** | **wire（P0）**：`COMMIT_PUSH_OUTCOME` 加 `commit-local-subrepo-failed`（不加 ⟹ `safeParse` 失败 ⟹ `commitPush=null` ⟹ **整行从 UI 消失**）；`CommitPushMetaSchema` 加 `subrepos[]`（不加 ⟹ zod strip）；`finalize`（`commitPushRunner.ts:174`）判 failed | `shared/schemas/task.ts:824-859`、`commitPushRunner.ts` | T31 |
| **T33** | 修 `redactPushError`（`commitPush.ts:306-312`）委托 `redactGitUrl`，消除 query 凭据漏脱 | `commitPush.ts` | — |
| **T34** | 测试：`rfc210-commitpush-subrepo`（AC-6/AC-7 红→绿 / detached 建分支 / non-FF / 锁边界 / 脱敏 / **子仓已推+父仓失败的不一致态**）；grep `e2e/` 确认 `commit-push.spec.ts:154` 不受影响 | 新 + 既有 | T30-T33 |

### PR-6 `git_diff` 子仓路径

| ID | 任务 | 落点 | 依赖 |
|---|---|---|---|
| **T35** | **改用 gitlink 区间差集**（v1 的 `submodule foreach porcelain` 在该时刻恒为空——子仓已被步骤⑤ checkout 干净）：`diff --name-only <baselineGitlink> <currentGitlink>` + 前缀 | `util/git.ts:1252-1292` | T19 |
| **T36** | 回归：`gitChangedFiles` 还喂 `structuralDiff/gitBackend.ts:41` 与 RFC-098 preDirty（`scheduler.ts:6073-6086`、`wrapperProgress.ts:68`）——**风险从中上调为高**，须带这两条链路测试 | 同上 | T35 |
| **T37** | 测试：`rfc210-git-diff-subrepo-paths`；确认 `wrapper-git-list-path` / `rfc098-git-predirty-diff` 不回归 | 新 + 既有 | T35,T36 |

### PR-7 定时刷新 + `--remote`

| ID | 任务 | 落点 | 依赖 |
|---|---|---|---|
| **T38** | `services/submoduleRefresh.ts`，照 `eventsArchive.ts:203-228` 样板 | 新 | T8,T10 |
| **T39** | 选仓查询 + 逐仓 `withUrlLock` | 同上 + `gitRepoCache.ts` | T38 |
| **T40** | 注册 `cli/start.ts:443-543` + `shutdown()`(`:600-617`) 停止 | `cli/start.ts` | T38 |
| **T41** | `--remote` **仅**读侧接线（任务执行期三点位显式不传，D8） | `gitRepoCache.ts`、`submoduleRefresh.ts` | T7 |
| **T42** | 测试：`rfc210-refresh-loop`；`--remote` 作用域断言并入 `-config-wiring` | 新 + T12 | T38-T41 |

### PR-8 前端

| ID | 任务 | 落点 | 依赖 |
|---|---|---|---|
| **T43** | Settings 新增 git 分区，归 **`reliability` group**（与 gc 同组）。**五处登记**：`SETTINGS_CONFIG_SCOPE_IDS`(`settings-drafts.ts:26`) / `_KEYS`(`:37`) / `SECTION_BY_SCOPE`(`:150`) / registry scopes 字面量(`:189`) / `settings.tsx` union+`SETTINGS_TABS`+`configScopeForSettingsTab`+`sectionGroups` | `routes/settings.tsx`、`lib/settings-drafts.ts` | T8 |
| **T44** | `commitOutcomeKey`（`tasks.detail.tsx:1597-1609`）加分支——**有 `default:` 兜底，typecheck 抓不到**，漏改会把"子仓推送失败"显示成"跳过（无变更）" | `routes/tasks.detail.tsx` | T32 |
| **T45** | `SubmoduleBadge` **收编进 `StatusChip`**（props 实测够用）+ 删 `.submodule-badge`（`styles.css:10653-10671`）。**口径更正**：组件已是四态，真正变更只有 `lastSubmoduleSyncOk===null` 从 ok 改 **neutral** | `components/repos/SubmoduleBadge.tsx`、`styles.css` | — |
| **T46** | `/repos` 增"上次自动刷新"列（`RelativeTime` + `.scheduled-next__abs`） | `routes/repos.tsx` | T10 |
| **T47** | 新公共组件 `<ShaRange>`：统一 **12 位**截断并**接管既有 3 处**（`tasks.detail.tsx:922` / `plugins.detail.tsx:398` / `McpInventoryPanel.tsx:136`）；契约：null → `common.emDash`、箭头 `aria-hidden`、挂全值 `title`、朗读走 i18n 插值 | 新文件 + 3 处调用方 | — |
| **T48** | 任务详情子仓结果列表（挂多仓 `<details>` 同构位置） | `routes/tasks.detail.tsx:862-878` | T32,T47 |
| **T49** | i18n：zh 类型+值两处、en 值；`settingsForm.<key>`+`<key>Hint` 配对 | `i18n/*.ts` | T43-T48 |
| **T50** | 前端测试：`settings-drafts.test.ts:27-36`（**精确有序集合断言**，v1 漏列）、`repos-submodule-wiring.test.ts:33-40`+`:43-50`、`submodule-badge.test.tsx:44,57`（className 断言）、`task-detail-multi-repo-header.test.ts`、新增 `ShaRange` 单测 | 既有 + 新 | T43-T49 |
| **T51** | e2e 视觉基线：**`settings.png` 必刷**（`PageSectionNav` rail 与页面一起进整页截图，与新 tab 是否默认**无关**——v1 判断错误）；`repos.png` 必刷 | `e2e/visual-regression.spec.ts` | T43,T45,T46 |

## 2. 依赖图（关键路径已重排）

```
T8(config) ─► T9(4 层管道) ────────────────────────────────┐
T1,T2 ─► T3(alternates) ─┐                                 │
              T4(池+保活ref) ─┐                            │
T5(快照原语) ─┐             │                              │
T6(性能门) ───┴─────────────┴─► [PR-1] ─► T14 ─► T15(回写) ─┼─► T18(红) ─► T19 ─► T20/T21 ─► [PR-3]
T10(migration) ─► T11 ──────────┘          │  [PR-2]       │                 │
                                           ├─► T23(双parent/逐层) ─► T24/T25 ─┤
                                           │      T26(replay) T27(resume) T28(GC)  [PR-4]
                                           ├─► T30 ─► T31 ─► T32(wire) ─► T34   [PR-5]
                                           └─► T35 ─► T36 ─► T37               [PR-6]
T38 ─► T39 ─► T40, T41 ─► T42  [PR-7]
T32,T47 ─► T43…T51             [PR-8]
```

**关键路径**：`T1/T2 → T3/T4 → T14 → T15 → T18 → T19`。
**v1 的错误**：把 T18/T19 排在 T15 之前。步骤⑤ 的 `checkout <sha>` 要求对象在目标 module dir 可达，
而 alternates 只让 iso 读**池里已有**的对象；节点新提交的 commit 必须靠 **T15 的回写**才可见。
PR-3 单独上线会让每个"agent 在子仓提交过"的节点从静默丢数据变成**硬失败**。

## 3. PR 拆分

| PR | 内容 | 可独立上线 | 风险 |
|---|---|---|---|
| **PR-1** | T1-T13 地基 | ✅ 无用户可见行为变更（argv 字节基线锁死） | **中**（v3 上调：含 T9 改 `mergeBackNodeIso` 签名 + 6 个 `materializeTree` 调用点，全在 RFC-130 合并核心；T10/T11 是 journal 事故形状；T6 改 `hasDirtySubmoduleContent` 的 D22 门语义。「无用户可见行为变更」≠ 低风险） |
| **PR-2** | T14/T15/T17/T17b/T17c 回写 + 快照 | ✅ | 中 |
| **PR-3** | **T16/T16b** + T18-T22 gitlink 修复 | ✅ **止血，必须在 PR-2 之后** | 中（动 `materializeTree` 热区，6 个调用点）。**T16 已从 PR-2 移入本 PR**——删 D22 网必须与步骤⑤ 同批上线 |
| **PR-4** | T23-T29 递归合并 + replay/resume | ✅ | **高**——动 RFC-130 合并核心 + 两条恢复路径，需 `rfc130-*` 全套回归 |
| **PR-5** | T30-T34 commit-push 递归 | ✅ | **高**（v3 上调：真实 push + 在用户子仓建分支 + 「已 push 不可逆」+ 锁边界重排，而 `acquireWrite` 的 release 位置是 `commitPushRunner.ts:88-91` 的明文契约） |
| **PR-6** | T35-T37 `git_diff` 路径 | ✅ | **高**（影响 structuralDiff 与 RFC-098 preDirty 两条链路） |
| **PR-7** | T38-T42 定时刷新 + remote | ✅ | **中**（v3 上调：默认开的后台网络循环，且它周期性对**持有池的那个 cache repo** 跑 `fetch`，而 `fetch` 会触发 `gc --auto` ⟹ 定时刷新 × 保活 ref × 池 gc 的三方交互必须在 §8 补分析） |
| **PR-8** | T43-T51 前端 | 依赖 PR-5 的 wire | 低 |

**顺序**：1 → 2 → 3 → 4 → 5 → 6 → 7 → 8。

## 4. 验收清单

对应 proposal.md 的 AC-1…AC-22：

- [ ] AC-1 alternates 到位（**含已初始化 module dir 补挂 + 逐子仓不交叉污染**）、`objects/pack` 为空
- [ ] AC-2 iso 子仓提交后共享池可见，canonical 无需额外 fetch
- [ ] AC-3 **gitlink 回归测试先红后绿**（未暂存区语义）
- [ ] AC-4 ≥2 层嵌套穿透（**逐层递归展开**，非 `ls-tree -r`）
- [ ] AC-5 同子仓不同行自动合并 / 同行走 agent / 解不开 `awaiting_human` 且 canonical 干净
- [ ] AC-6 子仓 push 失败 ⟹ 父仓不推 + `commit-local-subrepo-failed`（**per-repo 作用域**）
- [ ] AC-7 子仓脏不再 `skipped-empty`
- [ ] AC-8 `git_diff` 吐 `<sub>/<file>`（**gitlink 区间差集**）
- [ ] AC-9 刷新循环合样板并正确注册/停止
- [ ] AC-10 `gitSubmoduleRemote=false` argv 字节级一致
- [ ] AC-11 `never` ⟹ **argv spy 零 submodule 进程**（含 `hasDirtySubmoduleContent`）
- [ ] AC-12 无 `.gitmodules` 的仓**零额外 git 进程**
- [ ] AC-13 前端复用公共原语，无自写 chrome
- [ ] AC-14 四门全绿 + 单二进制 smoke + e2e
- [ ] AC-15 **保活 ref 扛住默认 gc**
- [ ] AC-16 **双 parent**（单 parent 必 exit=1 的防回归测试）
- [ ] AC-17 crash replay 子仓通道 + fail-closed
- [ ] AC-18 human resume **fail-closed**，不错误放行
- [ ] AC-19 outcome 枚举 + `commitOutcomeKey` 分支 + `finalize` 判 failed
- [ ] AC-20 子仓快照恢复 untracked、嵌套顺序收敛、已 push 不可逆有测试
- [ ] AC-21 path 模式仓不污染用户主仓
- [ ] AC-22 配置 4 层管道 + `mergeDefaults`/`mergePatch`
- [ ] `test-suite-policy.test.ts` 的 `ALLOWED_SKIP_COUNTS` 已同步（新增门控文件必须登记）
- [ ] 设计门（三路对抗自审 v2）+ 实现门 Codex review findings 清零或显式豁免
- [ ] `design/plan.md` 状态改 Done；`STATE.md` 移出进行中并加已完成行
