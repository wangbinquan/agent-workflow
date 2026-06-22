# RFC-101 记忆→技能融合 — design

> 技术设计（权威）。产品意图见 `proposal.md`。所有对现有代码的断言均已对照源码核实，路径见正文。
> 实现期对 opencode/任务生命周期的任何新断言须再对照源码（CLAUDE.md 强制）。

## 0. 设计原则

- **两个正交能力、强序落地**：能力 A（通用技能版本化）是地基，能力 B（融合）建于其上。A 可独立先行上库（见 plan.md PR-A）。
- **引擎全复用**：融合的"跑 agent + 反问 + 捕获 diff"完全复用 task / scheduler / runner / git-wrapper / clarify（RFC-023/056/058/100）/ 输出信封；新代码集中在"产品级编排（fusions）+ 版本化漏斗 + 临时仓播种 + 批准闸 + UI"。
- **单一事实源**：技能内容写入只有一个漏斗 `commitSkillVersion`；记忆状态机的 `fused` 转移只在 `services/memory.ts` 集中。
- **不变式优先**：`fused` ⟺ 其知识在技能当前版本中（D11）。版本快照不可变（仿 `doc_versions`）。

---

## 1. 架构总览

```
                    ┌──────────────────────────── 能力 B：fusion ───────────────────────────┐
 前端  /memory ──┐  │  POST /api/fusions ─▶ services/fusion.ts                               │
       /skills ──┤  │      createFusion: 校验 ACL → 播种临时仓 → startTask(preCreatedWorktree)│
 /fusions/:id ───┘  │                                   │                                     │
                    │                          引擎任务（workflow=__skill_fusion__）          │
                    │        scheduler ─▶ runner ─▶ opencode(skill-merger)  ←▶ /clarify        │
                    │                                   │ git-wrapper 捕获 git_diff            │
                    │              引擎任务 done ─hook─▶ fusion=awaiting_approval               │
                    │  POST /api/fusions/:id/approve ─▶ applyFusion ─┐                          │
                    │  POST /api/fusions/:id/reject  ─▶ 新迭代任务    │                          │
                    └────────────────────────────────────────────────┼──────────────────────────┘
                                                                       ▼
                    ┌──────────────────────── 能力 A：versioning ──────────────────────────┐
                    │  services/skillVersion.ts                                            │
                    │   commitSkillVersion(name, produceFiles, {source, author, summary})  │
                    │     ← 编辑器写路径(writeSkillContent/writeSkillFile/deleteSkillFile)  │
                    │     ← createManagedSkill (初始 v1)                                    │
                    │     ← applyFusion (source='fusion')                                   │
                    │     ← restoreSkillVersion (source='restore')                          │
                    │   磁盘：~/.agent-workflow/skills/{name}/versions/v{n}/files/          │
                    │   DB：skills.version + skill_versions 行                              │
                    └───────────────────────────────────────────────────────────────────────┘
```

---

## 2. 数据模型

### 2.1 `skills` 增列（能力 A）

`packages/backend/src/db/schema.ts`（现 skills 定义 227–256；**无内容 version**，`schema_version` 是迁移版本，勿混用）。

新增一列：

```ts
// skills table
contentVersion: integer('content_version').notNull().default(1),
```

> 命名用 `content_version` 而非 `version`，避免与既有 `schema_version` 概念混淆（评审可改名）。下文简称"技能版本"。

迁移：纯加列（无 CHECK 变更）可用 `ALTER TABLE skills ADD COLUMN content_version INTEGER NOT NULL DEFAULT 1;`。**数据回填**见 §3.4（为每个既有技能存档 v1）。

### 2.2 `skill_versions` 新表（能力 A，仿 `doc_versions` 673–747）

```ts
export const skillVersions = sqliteTable(
  'skill_versions',
  {
    id: text('id').primaryKey(), // ULID
    skillName: text('skill_name')
      .notNull()
      .references(() => skills.name, { onDelete: 'cascade' }),
    versionIndex: integer('version_index').notNull(), // 1-based；= 该快照对应的 skills.content_version
    filesPath: text('files_path').notNull(), // 相对 appHome：skills/{name}/versions/v{n}/files
    source: text('source', {
      enum: ['initial', 'editor', 'fusion', 'restore'],
    }).notNull(),
    summary: text('summary'), // 变更摘要（融合=agent changelog；编辑器=可空；restore=自动文案）
    fusionId: text('fusion_id'), // source='fusion' 时指向 fusions.id（弱引用，不级联）
    restoredFromVersion: integer('restored_from_version'), // source='restore' 时来源版本号
    authorUserId: text('author_user_id'), // 触发者 user id 或 '__system__'
    contentHash: text('content_hash'), // sha256(规范化 files/ 清单)，用于跳过空写 / 完整性
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    skillIdx: uniqueIndex('uq_skill_versions_skill_v').on(t.skillName, t.versionIndex),
    createdIdx: index('idx_skill_versions_created').on(t.createdAt),
  }),
)
```

`(skill_name, version_index)` 唯一，杜绝并发双写同版号。

### 2.3 `memories` 增 `fused` 状态 + 溯源列（能力 B）

现状态枚举 `['candidate','approved','archived','superseded','rejected']`（schema.ts 11–12 + migration 0023 CHECK）。SQLite **不能** ALTER CHECK，须**整表重建迁移**（模板：`db/migrations/0035_rfc064_unify_clarify_iteration.sql`）。新表加列：

```ts
// memories table
status: text('status', {
  enum: ['candidate','approved','archived','superseded','rejected','fused'],   // + 'fused'
}).notNull(),
fusedIntoSkill: text('fused_into_skill'),                 // 技能 name
fusedIntoSkillVersion: integer('fused_into_skill_version'),// 吸收它的技能版本号
fusedAt: integer('fused_at'),
fusedByUserId: text('fused_by_user_id'),
fusedFusionId: text('fused_fusion_id'),                   // 指向 fusions.id（审计）
```

CHECK 收紧（与 0023 不变式并存）：

```sql
CHECK (status IN ('candidate','approved','archived','superseded','rejected','fused'))
CHECK ((status = 'fused') = (fused_into_skill IS NOT NULL))  -- fused ⟺ 溯源非空
```

重建时**务必重建全部既有索引**（`idx_memories_scope_status` 等，schema.ts 1261–1295 / 0023）。

**注入零改动**：`services/memoryInject.ts`（110–165）四个 scope 查询全部 `eq(memories.status,'approved')`，`fused` 天然被排除——保留一条源码文本断言锁死（§9）。

### 2.4 `fusions` 新表（能力 B，产品级编排实体）

```ts
export const fusions = sqliteTable(
  'fusions',
  {
    id: text('id').primaryKey(), // ULID
    skillName: text('skill_name')
      .notNull()
      .references(() => skills.name, { onDelete: 'cascade' }),
    baseSkillVersion: integer('base_skill_version').notNull(), // 发起时技能版本（OCC 基准）
    memoryIdsJson: text('memory_ids_json').notNull(), // string[] 选取的记忆 id（快照）
    intent: text('intent').notNull().default(''), // 融合者意图说明
    status: text('status', {
      enum: ['running', 'awaiting_approval', 'applying', 'done', 'rejected', 'canceled', 'failed'],
    })
      .notNull()
      .default('running'),
    iteration: integer('iteration').notNull().default(1),
    currentTaskId: text('current_task_id'), // 当前迭代的引擎任务 id（弱引用）
    proposedWorktreePath: text('proposed_worktree_path'), // awaiting_approval 时暂存的 proposed 工作树
    proposedDiff: text('proposed_diff'), // 当前 vs proposed 的 git_diff（用于展示）
    incorporatedMemoryIdsJson: text('incorporated_memory_ids_json'), // agent 报告已吸收
    skippedJson: text('skipped_json'), // [{memoryId, reason}]
    changelog: text('changelog'), // agent 变更摘要
    appliedSkillVersion: integer('applied_skill_version'), // 批准后写入的新版本号
    ownerUserId: text('owner_user_id').notNull(),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch()*1000)`),
    decidedByUserId: text('decided_by_user_id'),
    decidedAt: integer('decided_at'),
    decisionReason: text('decision_reason'), // 退回反馈 / 取消原因
    error: text('error'),
  },
  (t) => ({
    skillIdx: index('idx_fusions_skill').on(t.skillName),
    statusIdx: index('idx_fusions_status').on(t.status),
  }),
)
```

**融合状态机**（集中在 `services/fusion.ts`，纯函数 `fusionTransition()` 守卫）：

```
running ─▶ awaiting_approval ─▶ applying ─▶ done
   │              │                  └─(失败)─▶ failed
   │              ├─(reject+feedback)─▶ running  (iteration++)
   │              └─(cancel)─▶ canceled
   ├─(引擎任务 failed/interrupted 终态)─▶ failed
   └─(cancel)─▶ canceled
```

### 2.5 内置 agent / workflow（能力 B，数据而非 schema）

- **`__skill_merger__`**：系统拥有（`owner_user_id='__system__'`，RFC-099）的 **managed agent**，`readonly:false`。其 body 内嵌技能写作规范（D6，详见 §6）。`outputs`：见 §5 输出契约。
- **`__skill_fusion__`**：系统拥有的 **workflow**，定义 = `git-wrapper [ skill-merger 节点（接 self-clarify 节点，RFC-100 mandatory 开启）]`，输出绑定 git-wrapper 的 `git_diff` + skill-merger 的结构化端口。

**播种**：daemon 启动时**幂等** upsert（已存在则按版本校验是否需更新 body/定义）。须核实平台既有 system 资源播种钩子（RFC-075 内置 commit agent、RFC-050 memory distiller 有先例；RFC-099 提供 `__system__` owner）——plan.md 列为 T-B0 验证项。

---

## 3. 能力 A：通用技能版本化

### 3.1 磁盘布局

```
~/.agent-workflow/skills/{name}/
  files/                      ← 当前 live 内容（opencode 注入源；runner.prepareSkills cpSync 它）
    SKILL.md  references/ ...
  versions/
    v1/files/ ...             ← 不可变快照（内容与某时刻 files/ 逐字节一致）
    v2/files/ ...
```

不变式：成功写入后 `files/` 内容 == `versions/v{content_version}/files/`。`versions/` 只追加、不可变。

### 3.2 统一漏斗 `commitSkillVersion`（新 `services/skillVersion.ts`）

```ts
interface CommitOpts {
  source: 'initial' | 'editor' | 'fusion' | 'restore'
  authorUserId: string
  summary?: string
  fusionId?: string
  restoredFromVersion?: number
  expectedVersion?: number // OCC：调用方期望的当前版本；不符则 ConflictError
}
// produce: 把"新内容"写进给定临时 stagingDir（仅 files/ 子树）。漏斗负责其余。
async function commitSkillVersion(
  db,
  name: string,
  produce: (stagingDir: string) => Promise<void>,
  opts: CommitOpts,
): Promise<SkillVersion>
```

**执行顺序**（磁盘非事务，故定序 + 启动期对账，仿 `doc_versions` 先落盘再写行）：

1. 读当前 `skills.content_version = N`；若 `opts.expectedVersion!=null && !=N` → `ConflictError('skill-version-conflict')`。
2. `produce(staging)` 生成新内容到临时 staging（漏斗保证 staging 仅含 files/ 子树、剔除任何脚手架）。计算 `contentHash`；若与 v{N} 相同且 source∈{editor} → 空写短路（不升版，返回当前版）。
3. 落盘归档：把 staging 复制到 `versions/v{N+1}/files/`（不可变）。
4. **DB 事务**（`dbTxSync`，RFC-093）：`skills.content_version=N+1` + 插入 `skill_versions(N+1,...)` + （融合场景）调用方在**同一事务**内附带 `fuseMemories(...)`（见 §4.5）。提交。
5. 同步 live：`files/` ← `versions/v{N+1}/files/`（先清后拷，原子目录替换：写临时目录再 rename）。
6. WS 广播 `skill.version.created`。

**崩溃恢复**：若步 5 前崩溃 → DB 说 N+1 但 `files/` 还是 N 内容。daemon 启动期对账器 `reconcileSkillLiveFiles()`：对每个技能比对 `files/` 内容 hash 与 `versions/v{content_version}`，不符则从快照重铸 `files/`（幂等、无害）。步 3 的孤儿快照（DB 未提交）由对账器据 `skill_versions` 行清理。

### 3.3 写路径漏斗化（全部经 `commitSkillVersion`）

核实的写入入口（`services/skill.ts`）：`createManagedSkill`(83–122)、`writeSkillContent`(242–282)、`writeSkillFile`(343–360)、`deleteSkillFile`(362–394)。改造：

- `createManagedSkill` → 写盘后 `commitSkillVersion(name, produce=写初始SKILL.md, {source:'initial'})` 落 v1。
- `writeSkillContent` / `writeSkillFile` / `deleteSkillFile` → 把"对 live `files/` 的就地修改"重构为"基于当前 `files/` 拷贝到 staging、施加修改、`commitSkillVersion({source:'editor'})`"。`updateSkill`（仅改 description 元数据，168–177）**不**升版（无内容变更）。

源码文本断言（§9）锁死：`SKILL.md`/支撑文件的 `writeFileSync` 不得出现在 `commitSkillVersion` 之外。

### 3.4 迁移回填

迁移后对每个既有 managed 技能：建 `versions/v1/files/` = 当前 `files/` 拷贝 + 插 `skill_versions(v1, source='initial', author='__system__')`，`content_version` 默认已是 1。external 技能无 `files/` 归属（只读），不建版本。回填在迁移脚本或首启 `reconcile` 中完成（幂等）。

### 3.5 历史 / 对比 / 回退 API

- `GET /api/skills/:name/versions` → `SkillVersion[]`（倒序）。
- `GET /api/skills/:name/versions/:v/content` → 该版 SKILL.md 解析 + 文件树（只读）。
- `GET /api/skills/:name/versions/diff?from=a&to=b` → 多文件 unified diff（后端 `git diff --no-index` 或复用 diff 库；前端 DiffViewer 已支持多文件，`splitByFile`）。
- `POST /api/skills/:name/versions/:v/restore` → **回退**（见 §3.6）。

### 3.6 回退 + 解融合（D10/D11）

```ts
async function restoreSkillVersion(db, name, targetVersion N, actor): Promise<SkillVersion> {
  // OCC：以当前 content_version 为 expectedVersion
  // produce = 把 versions/vN/files 拷进 staging
  // 在 commitSkillVersion 的同一 DB 事务内附带 unfuseMemoriesAbove(name, N, actor)
}
```

**解融合预言（纯函数，重点测试）**：

```ts
// 给定该技能全部 fused 记忆与回退目标 N，返回须解融合的记忆 id。
function memoriesToUnfuseOnRestore(fused: { id; fusedIntoSkillVersion }[], N): string[] {
  return fused.filter((m) => m.fusedIntoSkillVersion > N).map((m) => m.id)
}
```

解融合 = `status: fused→approved` + 清空溯源列（同事务）。回退 UI 先调一个 dry-run 接口（或复用 `GET versions` + 前端计算）展示"将解融合 X 条"，确认后才 POST。回退生成新版（source='restore', restoredFromVersion=N），**永不**就地改历史。

---

## 4. 能力 B：融合引擎

### 4.1 发起 `createFusion`

`POST /api/fusions`，body：`{ skillName, memoryIds: string[], intent: string, modelOverride?: ... }`。

1. **ACL（D13/D14）**：actor 对 `skillName`（managed）有写权限；对每个 `memoryId` 有 `memory:read`+可见 **且** can-manage（`canManageMemory`，memory.ts 657–667）。任一不满足 → 422，列出违例 id。
2. 校验记忆均为 `approved`（非 approved 拒绝）；技能为 managed（external→422）。
3. **播种临时仓**（D16）：`fusionWorkDir = appHome/fusions/{fusionId}/work`；拷 `skills/{skillName}/files/` 到该目录根；`git init` + 配置非交互身份（复用 `util/git.ts` 非交互 env）+ `git add -A && git commit -m baseline`（baseline commit）。**记忆与意图不入工作树**（避免污染 diff/sync-back）——经 prompt 注入（§5）。
4. 建 `fusions` 行（status=running, iteration=1, baseSkillVersion=技能当前版）。
5. **启动引擎任务**：`startTask({ workflowId: __skill_fusion__, name: "fuse→{skill}", preCreatedWorktree: {taskId, worktreePath: fusionWorkDir, branch, baseCommit}, inputsBinding: {记忆+意图} , collaborators })`。`preCreatedWorktree` 绕过 `createWorktree`（核实：`util/git.ts createWorktree` 仅在无预建时跑 `git worktree add`；scheduler/runner 只认 `worktreePath`，runner.ts cwd=worktreePath）。`currentTaskId` 回填。

> 核实结论（探查）：任务 schema 要求 repoPath/repoUrl，但 `preCreatedWorktree`（RFC-020）后门可直接喂已建 worktree，scheduler/runner/git-wrapper 在"任意 git 目录 + 一个 baseline commit"上均正常工作（`runGit` 即 `git -C cwd …`；`gitDiffSnapshot` 用 `git diff <commit>` + `git ls-files --others`）。**实现期须核实 `startTask` 在 preCreatedWorktree 模式下对 repoPath 字段的最小必填集**，必要时塞 `repoPath=fusionWorkDir`（它本身就是个 git 仓）以同时满足 schema 与运行时——列为 T-B1 首要验证项。

### 4.2 引擎任务执行

工作流 `__skill_fusion__` = `git-wrapper [ skill-merger（self-clarify, RFC-100 mandatory） ]`。

- skill-merger cwd = `fusionWorkDir`（= 技能文件）。prompt 注入记忆正文 + 意图 + "文件在工作目录、按规范就地改、仅最终轮改文件"。
- **强制反问**（D7）：RFC-100 在 clarify 通道激活期只许 `<workflow-clarify>`；融合者经 `/clarify` 回答（任务 awaiting_human，逐题协作草稿/归属 RFC-099 全复用）。
- 融合者点"停止反问"（`directive='stop'`）那一轮：agent 编辑 `files/`（D17：仅此轮改文件）并 emit `<workflow-output>`（端口见 §5）。
- git-wrapper 在内层节点完成后捕获 baseline→工作树全目录 diff（含未跟踪），产出 `git_diff`。

### 4.3 引擎任务完成钩子 → awaiting_approval

引擎任务转 `done` 时（监听任务生命周期/WS，或在 scheduler 完成回调挂钩——T-B3 定接入点），`onEngineTaskSettled(fusionId)`：

- 任务 `done` 且解析出 git-wrapper `git_diff` + skill-merger 端口：
  - 校验 `incorporated ⊆ memoryIds`（D12）；越界 → 截断+WARN 记入 fusion.error 提示。
  - fusion：`status=awaiting_approval`，`proposedWorktreePath=fusionWorkDir`，`proposedDiff=git_diff`，回填 incorporated/skipped/changelog。
- 任务 `failed`/`canceled`/`interrupted` 终态 → fusion `failed`（技能与记忆**零改动**）。WS `fusion.updated`。

> 引擎任务 `done` 后其 worktree 保留（任务 done/cancel 均保留 worktree），故 `proposedWorktreePath` 在批准前可靠存活。融合 done/failed/canceled 后由 worktree GC 或 fusion 清理回收。

### 4.4 批准 / 退回

- `POST /api/fusions/:id/approve`（仅任务成员，D15）：fusion `awaiting_approval→applying`，调 `applyFusion`（§4.5）；成功→`done`，失败→`failed`（+error，技能不改）。
- `POST /api/fusions/:id/reject`，body `{ feedback }`：`awaiting_approval→running`，`iteration++`，**新引擎任务**：`fusionWorkDir2` 由**上一版 proposed 工作树**播种（`git init`+baseline=上次产物），feedback 经 prompt 注入（agent 在上次基础上修订），反问可再触发。旧任务 worktree 在新迭代播种后可回收。
- `POST /api/fusions/:id/cancel`：任意非终态 → `canceled`；若有在跑引擎任务，连带 `TaskStop`。

### 4.5 应用 `applyFusion`（原子）

```ts
async function applyFusion(db, fusion, actor) {
  // 1. 复检 ACL（技能写 + 每条已吸收记忆 can-manage）
  // 2. OCC：技能当前版本必须 == fusion.baseSkillVersion（期间无人改过该技能）；否则 ConflictError → fusion=failed，提示"技能已变更，请基于最新重跑"
  // 3. produce = 把 proposedWorktreePath 的内容（剔除任何脚手架；本设计脚手架不入工作树，故=整树）拷进 staging
  // 4. commitSkillVersion(skillName, produce, {source:'fusion', author, summary=changelog, fusionId, expectedVersion: baseSkillVersion})
  //    —— 其内层 DB 事务中【附带】fuseMemories(incorporatedIds, skillName, newVersion, actor, fusionId)
  // 5. fusion: status=done, appliedSkillVersion=newVersion
}
```

`fuseMemories`（`services/memory.ts` 新增，复用 `transitionStatus` 风格守卫）：把 incorporated 记忆 `approved→fused` + 写溯源列；要求各为 approved（期间被 archive/supersede 的 → 跳过并在 fusion.error 记录，不阻断其余）。整步在一个 `dbTxSync` 内（版本升 + 版本行 + 记忆 fused 同生共死）。

---

## 5. skill-merger 输出契约（信封）

`envelope.ts`（139–157）解析 `<workflow-output>` 末个为准、`<port>` 提取。skill-merger `outputs`：

| 端口                      | 含义                                                        |
| ------------------------- | ----------------------------------------------------------- |
| `changelog`               | markdown 变更摘要（用于批准面板 + skill_versions.summary）  |
| `incorporated_memory_ids` | 换行/JSON 分隔的已吸收记忆 id 列表                          |
| `skipped`                 | JSON：`[{memoryId, reason}]` 跳过项（重复/冲突未采纳/无关） |

实际文件改动由 agent 直接写工作树（git-wrapper 的 `git_diff` 捕获），**不**走端口。校验：`incorporated ∪ skipped(.memoryId)` ⊆ `fusion.memoryIds`；`incorporated ∩ skipped = ∅`。

---

## 6. 内置 skill-merger agent body（D6，写作规范内嵌）

依探查到的 skill-creator（`~/.claude/plugins/.../skill-creator`）+ skill-development 规范蒸馏要点，写进 agent body（要点，非逐字搬运，自包含、不依赖 Claude Code 插件）：

- **frontmatter 契约**：保 `name` 与目录名一致；`description` 用第三人称、含"何时用 + 做什么"且适度"pushy"（含触发短语）。
- **正文风格**：祈使句、客观指令；SKILL.md 正文 < 500 行（~1500–2000 词），超则**渐进披露**：把细节下沉到 `references/`，正文给清晰指针 + 目录。
- **支撑文件**：`references/`（详尽模式/边界）、`examples/`（可运行示例）、`scripts/`（工具）。
- **融合纪律**：去重、调和矛盾（矛盾必反问，不擅自取舍）、保留技能既有有效内容、被采纳记忆的知识须在产物中可定位；最终轮才落盘；产出后填 changelog/incorporated/skipped。

agent body 随平台版本化（属系统 managed agent，可在 `/agents` 编辑）。

---

## 7. 接口契约汇总

**REST**（`packages/backend/src/routes/fusions.ts` 新增 + 扩 `routes/skills.ts`）

| 方法 | 路径                                    | 权限                     | 说明                                         |
| ---- | --------------------------------------- | ------------------------ | -------------------------------------------- |
| POST | `/api/fusions`                          | 技能写 + 记忆 can-manage | 发起融合                                     |
| GET  | `/api/fusions`                          | 任务可见性               | 列表（按 skill/status 过滤）                 |
| GET  | `/api/fusions/:id`                      | 任务成员                 | 详情（含 proposedDiff/incorporated/skipped） |
| POST | `/api/fusions/:id/approve`              | 任务成员                 | 批准应用                                     |
| POST | `/api/fusions/:id/reject`               | 任务成员                 | 退回 + 反馈，重跑                            |
| POST | `/api/fusions/:id/cancel`               | 任务成员                 | 取消                                         |
| GET  | `/api/skills/:name/versions`            | 技能可见                 | 版本历史                                     |
| GET  | `/api/skills/:name/versions/:v/content` | 技能可见                 | 某版内容                                     |
| GET  | `/api/skills/:name/versions/diff`       | 技能可见                 | 两版 diff                                    |
| POST | `/api/skills/:name/versions/:v/restore` | 技能写                   | 回退（+解融合）                              |

**WS**：`/ws/skills`（或复用现有技能频道，T-A4 定）广播 `skill.version.created` / `skill.restored`；`/ws/fusions`（或复用 `/ws/workflows`）广播 `fusion.created|updated|awaiting_approval|done|rejected|failed`。前端据此 invalidate（复用 `useMemoryWs`/`useWebSocket` 模式，禁止新造一套）。

**shared schemas**（`packages/shared/src/schemas/`）：`skill.ts` 加 `contentVersion`；新 `skillVersion.ts`；`memory.ts` 状态枚举 +`fused` + 溯源字段；新 `fusion.ts`（Fusion / FusionStatus / 发起/批准/退回 请求 / skill-merger 输出端口 schema）。**枚举触点**（探查清单）：`shared/schemas/memory.ts` MemoryStatusSchema、frontend i18n、MemoryRow EDITABLE_STATUSES、各 memory 列表/过滤组件——逐处加 `fused`。

---

## 8. 与现有模块耦合点 / 失败模式 / 边界

| 项                                      | 处理                                                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 临时仓 vs 注册仓                        | 经 `preCreatedWorktree` 后门；不改任务启动 schema（T-B1 核实 repoPath 最小必填）                                     |
| 并发融合同一技能                        | 各自 baseSkillVersion；先 apply 者升版，后者 apply 时 OCC 失败 → fusion failed，提示重跑                             |
| 融合期间编辑器改了该技能                | 同上 OCC 兜住（apply 时版本不符即失败）                                                                              |
| 选中记忆在 apply 前被 archive/supersede | `fuseMemories` 跳过非 approved 项 + 记入 error；不阻断其余                                                           |
| 技能在融合期被删                        | 引擎任务/apply 检测 → fusion failed                                                                                  |
| 融合在跑时对该技能发起回退              | 回退走 OCC + 二者互斥（apply/restore 都用 commitSkillVersion 的 expectedVersion）；后者失败提示                      |
| daemon 重启打断引擎任务                 | 任务→interrupted（既有），fusion 钩子置 failed；融合者重发起                                                         |
| 二进制支撑文件 diff                     | DiffViewer/后端对二进制跳过展示并注记（对齐多进程节点二进制处理惯例）                                                |
| 选取记忆过多/过大                       | 发起时软上限（条数 + 合计字节）并 warn；超限拒绝                                                                     |
| 脚手架污染                              | 本设计记忆/意图**不入工作树**（走 prompt），proposed 整树即技能内容；sync-back 全树，无需 strip                      |
| Prompt 隔离                             | 融合归属（user id / 任务角色）**绝不进 agent prompt**（对齐 RFC-099 双层防护）；agent 只见记忆正文 + 意图 + 技能文件 |

---

## 9. 测试策略（CLAUDE.md：随改动落测）

**纯函数 / 数据预言（首选可断言面，重点覆盖）**

- `memoriesToUnfuseOnRestore(fused, N)`：回退解融合选择（含 = N / > N / 多融合版边界）。
- `fusionTransition(from, event)`：融合状态机合法/非法转移全表。
- 记忆状态机：`fused` 终态——不可被 promote/edit/archive；只能经 restore 解融合回 approved（守卫红/绿）。
- `incorporated ⊆ selected` 与 `incorporated ∩ skipped = ∅` 校验。
- ACL 谓词：`canLaunchFusion` / `canApproveFusion` / `canFuseMemory(memory, actor)`（跨 scope × owner/admin 矩阵）。
- 版本号 + 归档相对路径构造 `skillVersionRelativePath(name, n)`；`contentHash` 空写短路。
- skill-merger 输出端口解析（信封）。

**集成（复用既有任务测试 harness / opencode mock）**

- 端到端融合：发起 → 1 轮反问 → 最终轮改文件（mock runner 产出 diff + 端口）→ awaiting_approval → approve → 技能升版 + 已吸收记忆 fused + files/ 更新 + 被跳过记忆仍 approved（全在一事务）。
- 退回并反馈 → iteration2 由上版 proposed 播种 + feedback 注入 → 二次 approve。
- 回退端到端：含解融合（> N 的记忆回 approved，≤ N 保持 fused）。
- 临时仓播种：真实本地 git（`git init`+baseline+diff），按既有 git 测试惯例（本地可跑，无需 `RUN_GIT_NETWORK`）。
- 编辑器 Save 现在升版（既有技能编辑测试更新为断言版本+1+历史行）。

**源码文本断言（兜底回归锁）**

- `memoryInject.ts` 四查询恒含 `status,'approved'`，永不取 `fused`。
- `SKILL.md`/支撑文件 `writeFileSync` 不出现在 `commitSkillVersion` 之外（写路径唯一漏斗）。
- 融合 prompt 构造不引用 fusion 归属/ user id 字段（prompt 隔离，仿 RFC-099 锁）。

**迁移测试**

- memories 重建迁移：CHECK 接受 `fused`、拒绝非法；新列可空；既有索引在重建后仍在；幂等重跑同构。
- skills 加列 + skill_versions 建表 + v1 回填：既有技能迁移后 `content_version=1` 且有 v1 历史行 + 磁盘 `versions/v1/files`。

**门禁**：`bun run typecheck && bun run test && bun run format:check` 三包全绿；单二进制 build smoke（防模块初始化环，RFC-079 教训：本 RFC 新增 shared 导出较多，push 前必跑 `bun run build:binary`）；Playwright e2e（融合发起→批准、回退）。

---

## 10. 风险与待验证项（OQ）

- **OQ-1（首要）**：`startTask` 在 `preCreatedWorktree` 模式下对 `repoPath/repoUrl` 的最小必填集——是否可仅靠预建 worktree（worktree 本身是 git 仓）满足 schema 与多仓归一化（`normalizeStartTaskRepos`）。若强制要求注册仓，退路是把 `fusionWorkDir` 当 `repoPath` 直传（它是合法 git 仓）。落地前 T-B1 实测。
- **OQ-2**：系统资源（agent/workflow）的幂等播种钩子接入点与版本校验（RFC-075/RFC-050 先例）。T-B0。
- **OQ-3**：引擎任务 `done` → fusion 钩子的最干净接入点（scheduler 完成回调 vs 监听任务状态 WS）。T-B3。
- **OQ-4**：批准面板"当前 vs proposed"diff 的来源——直接用 git-wrapper `git_diff`（baseline=技能旧内容，故 diff 即"旧→proposed"，语义正好）即可，无需额外 `git diff --no-index`。落地确认 git-wrapper 输出可直接喂 DiffViewer 的 `splitByFile`。
- **OQ-5**：`content_version` 命名是否与 `schema_version` 混淆——评审可定名（如 `version`）。
- **OQ-6（Codex 复审 P2 #4，已知 v1 限制）**：restore 解融合只处理"融合版本 > target"的记忆；若先 restore 到低版（解融合某记忆）再 restore 回该融合版，因解融合时已清空溯源，无法自动**重新**融合 → 该记忆停留 approved 但其知识已回到技能 = 轻度重复注入（非数据丢失）。完整修法：在 `skill_versions` 记录每个融合版本吸收的 memory ids，restore 时据 target 版本的集合重新融合。v1 暂以代码注释 + 本条记录，后续 RFC 补。
- **Codex 复审已修（commit 见 STATE.md）**：P1 ZIP 覆盖被启动对账误clobber → 对账器改为"仅当 live 整体丢失才从快照恢复，绝不覆盖存在但不同的 live"（消除数据丢失；ZIP 覆盖未升版属 P2 历史完整性缺口，记入 follow-up）；P2 私有技能存在性泄漏（createFusion 补 `canViewResource`→404）；P2 退回重跑 diff 基线错（改 baseline=当前技能、上版 proposal 作 working 覆盖）；P2 清单漏选记忆（reconcile 校验 selected−incorporated−skipped 非空即 fail）；P2 取消 awaiting_human 融合任务遗留（CAS terminalize）；P2 FuseDialog 预选不刷新（open 时 useEffect 重置）。
