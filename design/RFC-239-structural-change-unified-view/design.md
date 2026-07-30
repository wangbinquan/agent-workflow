# RFC-239 · 技术设计

> 读法:先 proposal(产品意图与 AC),本文只讲怎么落。引用的现状代码锚点以 2026-07-30 主干为准;RFC-237/238 正在并行演进系统 agent/runtime 层,本 RFC 对其只消费公开函数签名(§8)。

## 0. 总览:改什么、不改什么

**不改**:结构 diff 引擎(tree-sitter/SCIP/语言覆盖/精度)、`StructuralDiff` 既有字段语义、文本 diff 的 1MiB 截断与 `DiffFileBody` 渲染器本体、三粒度与引擎切换的后端行为、`structural-diffs/{taskId}` 落盘机制。

**改**:
- 后端:变更文件枚举加 rename 检测并透传 `renamedFrom`(文件级);新增 change-narrative 读/写端点与落盘;`gitDiffSnapshot` 显式 `--find-renames` 与结构侧对齐。
- shared:`FileStructuralDiff.renamedFrom?` 可选字段;分组模型纯函数;`ChangeNarrative` schema。
- 前端:`worktree-diff` + `worktree-structure` 两页签合并为 `changes`(「结构变更」),新建 `components/changes/` 组件族;`WorktreeDiffPanel` 与 `StructuralDiffView` 页面级壳删除,可复用子组件迁移;图/影响面/调用链/依赖移入按需覆盖层。

## 1. 数据流与接口契约

### 1.1 页签打开时的请求

并行三路(TanStack Query,key 均含 taskId + scope):

1. **文本 diff**(现有):`GET /api/tasks/:id/diff`(多仓响应含 `# === Repo: <name> ===` 分段,`splitByRepo` 解析)。失败 → 全页错误(与现状一致)。
2. **结构 diff**(现有):`GET /api/tasks/:id/structural-diff?scope=&mode=`。失败/慢 → **退化不阻塞**:右栏 diff 照常,左栏退化为无符号计数的文件树 + 顶部横幅「结构分析不可用:{i18n(原因)}」(§6 失败模式)。
3. **AI 导读缓存**(新):`GET /api/tasks/:id/change-narrative?scope=task`。404 → 按钮态。

范围选择器改变 scope 时 1/2 重新拉取(narrative 仅 task scope,§5.4)。非终态任务保持现状的 6s 轮询(1、2 两路)。

### 1.2 前端 join(纯函数,`lib/changeReview.ts`)

```ts
interface ChangeFileEntry {
  filePath: string            // 不含仓前缀的仓内路径
  repoLabel?: string          // 多仓时的仓标签(两侧对齐后统一持有)
  textBlock?: DiffBlock       // 该文件的 unified diff 块(1.1-1)
  textStats?: { added: number; removed: number }   // 从 hunk 行前缀计数
  structural?: FileStructuralDiff                  // 1.1-2 中按路径 join
  renamedFrom?: string        // 文件级(结构侧新字段;纯文本侧 rename 头解析兜底)
  kind: 'code' | 'doc' | 'config' | 'deps' | 'binary' | 'other'
}
```

`ChangeFileEntry` 是**前端内部**的 join 产物(含 UI 层 `FileBlock`,不进 shared);喂给 shared 分组模型前由前端 adapter 压成纯 DTO(§1.3,设计门二轮 P1-1)。

join key 对齐规则:结构侧多仓符号/文件带 `label/` 前缀(RFC-089 `mergeStructuralDiffs`),文本侧按 repo 分段——join 前先把结构侧路径剥前缀、记 `repoLabel`,与文本分段的 repo 名对齐(对不齐的文件保留单侧数据,不丢行)。**canonical label 规则**(设计门二轮 P1-3):现状两侧 fallback 不一致(结构侧 `basename(repoPath)`,文本 marker 侧完整 `repoPath`)且 marker 单行正则可被 CR/LF 标签破坏——后端抽单点 `canonicalRepoLabels(repos)`(**集合级**函数,三轮 P1-N4 修订:sanitize(去 CR/LF/marker 分隔符、空→basename)**之后**在集合内再做一次 `-2/-3` 稳定去重——建仓期去重只保证 sanitize 前唯一,`ab` 与 `a\nb` 会在 sanitize 后撞名串仓),文本 diff 的 `# === Repo: ===` marker 与结构 merge 的 `label/` 前缀**都改用它**;前端仍按名精确 join,对不齐兜底保留单侧 + 左栏该仓组标 degraded 提示。测试:同名仓、sanitize 后撞名、CR/LF/特殊字符标签、两侧 fallback 一致性。`kind` 判定:`deps` = 出现在 `dependencyChanges[].manifestPath` 的文件;`doc` = `.md/.mdx/.rst/.adoc/.txt`;`config` = `.json/.yml/.yaml/.toml/.ini/.env*`(非 deps);`binary` = 文本块标 binary 或结构 `skipped-binary`;`code` = 结构侧有 lang ≠ unknown 或扩展名在 8 语言表;其余 `other`。

### 1.3 分组模型(**shared** 纯函数,前后端共用)

放 `packages/shared/src/changeGroups.ts`(纯叶子,只 import 类型,遵守 RFC-079 无环纪律;后端构造 AI 导读输入时复用同一分组,保证「AI 看到的组」=「用户看到的组」)。

**输入是纯 DTO,不是前端 `ChangeFileEntry`**(设计门二轮 P1-1:前端 entry 含 UI 层 `FileBlock`,不能进 shared):

```ts
interface ChangeGroupEntry {   // shared DTO,前端 adapter / 后端 numstat 链各自组装
  filePath: string
  repoLabel?: string
  kind: 'code' | 'doc' | 'config' | 'deps' | 'binary' | 'other'
  renamedFrom?: string
  pureMove: boolean            // 纯搬移判定由调用方给出(结构侧 changes 空/全 bodyChanged!==true)
  textStats?: { added: number; removed: number }
  symbolCounts?: SummaryLike   // 每文件符号 changeType 计数
  severity: { breaking: number; risky: number }   // 由调用方用 shared classifyBreaking 预计算
}
interface ChangeGroup {
  key: string                // 稳定 key:'repo:<label>/mod:<seg>' | 'docs' | 'config' | 'deps' | 'moves' | 'other'
  title: string              // 展示名(模块段名/固定类别名,i18n 在前端做类别名映射)
  files: ChangeGroupEntry[]
  stats: { files: number; symbolCounts?: SummaryLike; lines: { added: number; removed: number };
           severity: { breaking: number; risky: number }; }
}
buildChangeGroups(entries: ChangeGroupEntry[]): ChangeGroup[]
```

severity 依赖(设计门修订):`classifyBreaking` 自前端 `lib/structureSemantics.ts` **上移至 `packages/shared/src/structureSemantics.ts`**(前端原路径 re-export 兼容,测试随迁)。二轮 P1-1 补充:该函数现运行时依赖 `structureView.diffSignatureTokens` → npm `diff` 包,shared 不引第三方——上移时以 shared 内**零依赖、顺序敏感的词级 LCS diff** `signatureTokensRemoved(before, after)` 替换该判定(三轮 P1-N2 修订:multiset 差对「参数重排/重复 token 换位」不敏感,与旧顺序敏感算法不等价;LCS 与 `diffWordsWithSpace` 的 removed 语义对齐,签名串很短,O(n²) 可忽略),等价性用既有判定矩阵 + 参数重排/重复 token 用例锁住;前端展示用的 token 级签名 diff(`diffSignatureTokens`)留在前端不动。

规则(确定性,全部可单测):
1. 多仓:第一层按 `repoLabel` 分仓,仓内再分组(左栏渲染仓标题行,兑现 RFC-089 遗留 T2)。
2. **moves 组**:`renamedFrom` 存在且(`structural.changes` 为空 或 全部符号 `bodyChanged !== true`)→ 纯搬移;组行呈现「N 个文件重命名/移动」;rename+edit 的文件**不**进 moves,按正常规则归组且概要区标 `原 <oldPath>`。
3. **代码组**:按「模块段」= 文件目录路径剥掉首个 `src`(仅 `src`,保守)后的第一段(无目录 → `根目录`)。组数 > 8 时按权重保前 7、其余并入「其他代码」;代码文件总数 ≤ 4 时全并入单组「代码」。
4. `deps` / `docs` / `config` / `other` 各成组(空组不出现)。
5. 组内文件排序:severity(breaking>risky)→ 行数降序 → 路径;组排序:代码组按行数权重降序 → deps → docs → config → moves → other。
6. 权重条值 = 组 `lines.added+removed` / 全局最大组同值(∈ (0,1])。

### 1.4 hunk ↔ 符号映射(前端纯函数,`lib/hunkSymbolMap.ts`)

输入:单文件的 hunks(old/new 起止行)+ `SymbolChange[]`。

> 设计门修订:hunkAnchor 的 `startLine` 是**符号声明行**——方法声明未改、只有方法体深处改动时,声明行不落在任何 hunk 的行区间内,「用 startLine 找包含它的 hunk」不成立。以下算法改用**区间重叠**。

- `symbolAtLine(side: 'old'|'new', line)`:在 `before.range`(old 侧)或 `after.range`(new 侧)包含该行的符号中取**区间最小**者(最内层);无 → null。
- 概要行 → diff(`hunkForSymbol`),输入域全集显式定义(设计门二轮 P0-1):
  - 选侧:added/modified/renamed/**moved** → after+new 侧;removed → before+old 侧;所选侧节点缺失时用另一侧(moved 缺 after → before+old)。
  - hunk 侧区间:`count === 0 ? 空区间 : [start, start + count − 1]`(纯删 hunk 的 new 侧、纯增 hunk 的 old 侧都是空区间,空区间不参与重叠)。
  - 符号 `range` 缺失、或该文件无 hunk → 返回 null(概要行不渲染跳转,不猜)。
  - 闭区间端点相等视为重叠;跨文件输入(entry.filePath ≠ hunk 文件)直接拒绝(开发期断言)。
  - 命中:取首个重叠 hunk,滚动并高亮重叠行;零重叠 → 退化为「该侧起始行号与符号区间距离最小」的 hunk,距离相等时取行号较小者(稳定 tie-break),只做 hunk 级高亮。
  - 测试锁:「声明未改、体深处改」命中体内 hunk、moved 双侧、纯删/纯增空区间、缺 range null、零重叠 tie-break。
- diff → 概要:每个 hunk 渲染时算 `symbolAtLine(new, hunk.newStart)`(全删 hunk 用 old 侧),在 hunk 头右侧渲染符号名小徽标;diff 滚动容器顶部 `position: sticky` 一条「当前符号」(取视口顶第一个可见 hunk 的 owning symbol),点击 → 左侧概要树高亮并滚动到对应符号行。

### 1.5 已看进度

迁移 `WorktreeDiffPanel` 的 per-file viewed。精确契约(设计门二轮 P1-4):namespace 继续 `lib/diffViewed.ts` 的 `loadViewed/saveViewed(taskId)`(`awf.diffViewed.${taskId}`);**集合值格式逐字沿用旧规则**——由 entry 生成:`renamedFrom ? \`${renamedFrom} → ${filePath}\` : filePath`,多仓再前缀 `${repoLabel}::`。老任务存量 JSON(普通/rename/多仓)三类迁移测试。上卷:组头 `viewed/files`,左栏底部总进度条。Space 键语义保留。

## 2. 前端信息架构

### 2.1 组件树(新增 `components/changes/`)

```
routes/tasks.detail.tsx (pane: tab === 'changes')
└─ ChangeReviewPanel                  // 顶层编排:三路 query + join + 状态
   ├─ ChangeToolbar                   // 范围 Select + 引擎 Segmented(现状迁移)+ 摘要统计行 + [生成 AI 导读] + 下钻入口(图/影响面/调用链/依赖,按可用性)
   ├─ ChangeNarrativeCard             // AI 导读:总述 + 阅读顺序(组句回填进左栏组头);四态:无/生成中/就绪/失败
   ├─ ChangeOverviewSidebar           // 左栏:仓 → 组 → 文件;组头(名称+一句话+权重条+计数+severity 点+组内进度);文件行(basename+±计数+已看勾选);键盘 ↑↓/Home/End/Space;底部总进度
   ├─ ChangeFileDetail                // 右栏:文件头(路径/renamedFrom/degraded chip)
   │   ├─ SymbolOutline               //   概要树:容器→成员嵌套折叠;import 聚合一行;全 added 默认折叠到容器级;行=badge+签名+severity chip+bodyDelta;点击→jump
   │   ├─ DiffFileBody(复用)          //   unified diff + hunk 符号徽标 + sticky 当前符号条
   │   └─ MarkdownDiffView(复用RFC-010)// doc 文件默认渲染视图,Segmented 切「渲染/文本」;
   │                                  //   ⚠ 该组件契约要求完整 left/right 两侧全文,unified patch 不够——
   │                                  //   数据来源见 §3.5 file-at-ref 端点(设计门修订),按需懒加载,
   │                                  //   端点失败 → 自动退回文本 diff 视图 + 提示
   └─ DrilldownOverlay                // 全宽覆盖层(Dialog 变体或 .changes__overlay?→ 必须走公共 Dialog):
       ├─ StructuralGraph(复用)       //   新 prop focusFiles?: string[](聚焦选中组/文件过滤)
       ├─ ImpactPanel(重构)           //   条目可点击 → 关闭覆盖层 + 跳对应文件符号
       ├─ CallChainView(复用)         //   入口条件不变(callChainAvailable)
       └─ DependencyChangesPanel(复用)
```

UI 一致性(CLAUDE.md 强制):覆盖层走公共 `Dialog`(全屏变体已有先例则复用其 class,无则最小扩展 Dialog 支持 `size="full"`);切换控件一律 `Segmented`;下拉 `Select`;空态 `EmptyState`;错误 `ErrorBanner`。新 CSS 命名空间 `.changes__*`,复用既有 diff 配色 token(`--success/--danger/#d99100` 现状)。

### 2.2 删除与拆迁

- 删 `WorktreeDiffPanel.tsx`(树/已看/键盘逻辑并入 `ChangeOverviewSidebar`,`fileTreeRows` 继续复用)与 `StructuralDiffView.tsx` 页面壳(`SignatureDiff`/`ImpactPanel`/`DependencyChangesPanel`/`WalkthroughCard` 中:前三者迁移复用,walkthrough 卡**删除**——其职责被「组头 severity 点 + AI 阅读顺序」替代)。删除优于 deprecate(仓准则);被删组件的锁定测试逐条迁移/更新并注明 RFC-239(§9)。
- `routes/tasks.detail.tsx`:`diffFocusFile` 状态升级为 `changeFocus: { filePath, side?, line? } | null`(带行号);两个旧 pane 分支合一。

### 2.3 tab 注册与 URL 兼容

- `lib/task-detail-tabs.ts`:`TaskDetailTab` 去 `worktree-diff`/`worktree-structure` 加 `changes`;TAB_ORDER 8 → 7;capabilities `changes = worktreeDiff`(diff 可用即可;结构不可用时按 §6 退化)。
- URL 解析处单向映射 `worktree-diff|worktree-structure → changes`(写回 URL 用新值);e2e/单测同步。
- i18n:`tasks.tabChanges = '结构变更'` / en `'Structural changes'`;旧 `tabWorktreeDiff`/`tabWorktreeStructure` key 删除(全仓 grep 清引用)。

### 2.4 降噪规格(概要树)

- import:聚合为一行「导入 +N −M」(默认折叠,点击展开明细);不再参与容器分组排序。
- 全 added 文件(结构侧全部 changes 为 added):概要树默认折叠到容器级——「`class SnakeGame` +12 方法 +8 字段」一行,展开才见成员;`added+safe` 行不渲染 explain 句(消同义反复)。
- 修改类文件:保持成员级展开(现状语义),severity chip/签名 diff/bodyDelta 保留。
- 纯搬移文件:概要区一行「文件自 `<oldPath>` 移动,内容未修改」。
- 全部聚合行必须显示计数,可展开(P3 信任契约)。

## 3. 后端改动

### 3.1 rename 统一(G8/AC-4)

- **新增独立 typed API,不改既有 `string[]` 函数**(设计门二轮 P1-2:`gitChangedFiles`/`gitChangedFilesBetween` 的 `string[]` 返回被 scheduler 等按 blob 路径直接消费,不能改形):`util/git.ts` 新增 `gitChangedEntries(worktree, fromRef)` / `gitChangedEntriesBetween(...)`,返回 `Array<{ path: string; oldPath?: string; status: 'A'|'M'|'D'|'R'|'T' }>`;调用形态 `git diff --name-status -z --find-renames <ref> --`——**`-z` 必用**(NUL 分隔字段,禁 quotepath munging,路径不得 `trim()`,承接仓内 `'\x00'` 转义纪律)。**状态全集处理**(三轮 P1-N3):`T`(typechange)归一为 M 语义消费(读旧读新照常);`U`(unmerged,任务 worktree 理论不该有)→ 该文件标 `parse-error` 级 skip + log,不丢不炸;未来/未知状态字母(如未开 `--find-copies` 不会出现的 `C`)→ 保守按 M 消费 + log,fail-open 到最保守解释;解析器测试覆盖 R/T/U/未知字母。untracked 仍另行枚举、保持 added(git 语义)。结构侧(gitBackend / node / wrapper scope)全部改用新 API。
- `assemble.ts`:readOld 用 `oldPath ?? path` 读旧 blob;产出 `FileStructuralDiff.renamedFrom = oldPath`(shared schema 新增可选字段;落盘老 JSON 无字段照常 zod 解析——二轮核实通过)。符号级 diff 因此天然产出 modified/unchanged 而非 add+remove 两份。
- `util/git.ts gitDiffSnapshot`:tracked `git diff` 显式加 `--find-renames`,与结构侧语义一致(文本 diff 输出 `rename from/to` 头,前端 block 解析器需容忍 rename 头并提取 oldPath 作兜底来源;现状 `--name-only` 仅因 `diff.renames` 默认 true 隐式检测——显式化消除对宿主 git 配置的依赖)。

### 3.2 change-narrative 端点(G7/AC-7)

路由挂 `mountTaskRoutes`(继承任务 gate):

- `GET /api/tasks/:id/change-narrative?scope=task`
  - 200 `{ status:'ready', narrative: ChangeNarrative }` | 200 `{ status:'generating', startedAt }` | 404 `narrative-not-found`
  - 读权限 = 任务可见性,**继承 `mountTaskRoutes` 现状语义**(不可见 actor 现状为 403,设计门二轮 P1-5:不在本 RFC 里单独把任务路由改成 404 同形——那是任务路由全链的独立议题)。
- `POST /api/tasks/:id/change-narrative` body `{ scope:'task' }`
  - 触发权限 = `requireTaskMember` 现状语义:owner / collaborator / **admin**(二轮 P1-5 勘误:既有成员 gate 明确放行非成员 admin,文档此前漏写);普通非成员 403。测试三组:任务不存在 / 普通非成员 / 非成员 admin。
  - 202 `{ status:'generating' }`;**幂等**:daemon 内存 per-task single-flight(Map<taskId, Promise>),已在跑 → 202 返回同一 generating;已 ready 再 POST → 允许重新生成(覆盖写)。
  - 422:scope ≠ task。409:任务无 base commit / 无变更(无可导读内容)。

生成流程(`services/changeNarrative.ts`):
1. 取 task-scope `StructuralDiff`(实时或落盘)+ numstat 行统计(§3.6)→ shared `buildChangeGroups`(§1.3,同构保证)。**实现勘误(PR-1)**:文件全集来自 `gitChangedEntries`(git 枚举,含 docs/config/资源),结构 `diff.files` 只按路径 join 进符号计数/severity——结构工件只含代码+manifest,若以它为全集则非代码组永远缺席,与前端不同构(change-narrative 测试锁定)。
2. `buildNarrativePrompt(task, workflowSnapshot, groups)`(纯函数,可单测):任务名、各节点 `{nodeId, agentName, 节点意图摘要(prompt 首行截断)}`、每组统计 + top-N 符号名清单;总长截断 ~30KB。
3. **runSystemAgent 生产接线按 intent-builder 完整先例**(设计门二轮 P0-5:只传 protocol/model/binary 会让 verified opencode 因缺 containment 直接 `execution-identity-containment-required`,custom claude fork 丢失 config-dir profile)。`changeNarrative` 服务显式依赖注入:`ResolvedRuntime`(含 binary/model/`configDirEnv`/`configDirName`)、daemon 的 `containmentCoordinator`、必要时 branded `opencodeCmd`、以及 `runFn = runSystemAgent`(测试仅替换 `runFn`,**不用** `testOnlyUnverifiedRuntime`)。调用面 = `{ feature:'change-narrative', agentName, systemPrompt, prompt, protocol, runtimeBinary, configDirEnv, configDirName, model, systemPermissionProfile, containmentCoordinator, opencodeCmd?, scratchParent: appHome()/scratch, timeoutMs: 120_000 }`,对照 `intent/turnEngine.ts` 生产调用逐字段核对。permission profile:**PR-1 实现勘误** —— 注册零工具 `narrative-v1` 需要改 runtime driver 能力声明,而那些文件正被并行 RFC-237 修改中;v1 复用既有只读 `intent-read-v1`(cwd 是 scratch 空目录、不挂 task worktree,只读面等价于零披露),`narrative-v1` 收紧待 RFC-237 落地后作为小提交跟进。
4. 输出解析:强制 JSON 输出协议(systemPrompt 要求仅输出 JSON);`ChangeNarrative` zod 宽松解析(未知组 key 丢弃、readingOrder ref 校验存在性、overview 必需);失败 → 不落盘、single-flight 清除、错误缓存 60s 供 GET 返回失败态。
5. 落盘 `appHome()/structural-diffs/{taskId}/narrative-task.json`(与 task.json 同目录,随任务删除链路一并清理;写失败 best-effort 不抛,GET 退 404)。**删除竞态**(设计门修订):生成是异步长任务,期间任务可能被删——写盘前 re-check 任务行存在(DB 一查),写盘后再 check 一次,任务已消失则自删刚写的目录(防止删除链路已清完目录后又被重建留垃圾);不 kill 进行中的生成(浪费但无害,re-check 即可收口),该行为有单测。
6. `inputDigest`:定义与稳定性保证见 §3.6(排除行数/severity,前后端同构可比);前端 digest 不一致时提示「导读基于旧版变更,可重新生成」。

shared schema:
```ts
ChangeNarrative = { version: 1, overview: string,
  groups: Array<{ key: string, summary: string }>,
  readingOrder: Array<{ ref: string /* group key 或 filePath */, why: string }>,
  generatedAt: number, inputDigest: string }
```

### 3.3 空态信号(G8/AC-8)

结构 diff 响应对「0 变更文件」补充可选 `emptyHint`:`'scratch-space' | 'no-changes'`(service 依据 `task.space_kind` 与变更文件数产出;不改既有 409/410/pruned/readonly 语义)。前端按矩阵渲染差异化 `EmptyState`(文案见 proposal AC-8)。

### 3.4 多仓 node 粒度放开(AC-9)

纯前端:`tasks.detail.tsx` 移除 `repoCount === 1` 锁(后端 `getNodeStructuralDiff` 已支持多仓,RFC-089 P3);范围 Select 在多仓任务照常列节点。

### 3.5 file-at-ref 端点(设计门修订:Markdown 渲染视图的数据来源)

`MarkdownDiffView`(RFC-010)契约要求 before/after 两侧**完整全文**(二轮核实:props 即两个完整字符串);现有 API 只有 worktree(after)侧文件读取,unified patch 无法重建全文。新增:

- `GET /api/tasks/:id/file-content?path=<repo 相对路径>&side=base|worktree[&repo=<label>]`
  - **路径取值钉死**(二轮 P0-2):`basePath = renamedFrom ?? filePath`,`worktreePath = filePath`——rename 文件 base 侧必须按旧路径读,否则误判 `exists:false` 退文本视图。
  - **两侧对称的缺失语义**(二轮 P0-2):任一侧文件不存在均返回 200 `{ exists:false }`(worktree 侧不复用现有 404 语义)——纯新增(base 缺)/纯删除(worktree 缺)的 md 都能以空文档一侧正常渲染。
  - **多仓 base**(二轮 P0-2):`repo` 参数选仓后,base 侧读**该仓自己的** `task_repos.base_commit`(不是任务首仓的);测试覆盖非首仓。
  - `worktree` 侧读取用**句柄内检查**(二轮 P0-3,消 symlink TOCTOU):新 `openContainedFile(worktreeRoot, relPath)` —— 打开文件句柄后在**同一句柄**上完成 regular-file(fstat)、containment、size、NUL 检查再读内容,禁止 check-then-reopen;测试 seam 在 containment 检查后交换 symlink,断言拒绝。(现有 `worktreeFiles.ts` 的 check-then-reopen 同型问题属既有代码,记入 `docs/audit-backlog.md`,本 RFC 的新端点不复制该模式,helper 供其后续采用。)
  - 守卫:单文件 ≤ 1.5MB(与结构侧同阈值),超限 413 → 前端退回文本 diff;二进制探测(NUL)→ 415。
  - 权限:任务可见性 gate(与 diff 同级)。
- 前端:仅当用户停留在 doc 文件且选择「渲染视图」时懒加载两侧;任一侧失败 → 自动切回文本 diff + `ErrorBanner` 轻提示。测试:rename 两侧、纯删除、base 缺失、多仓非首仓、超限、二进制、越界路径(含检查后换链)+ 正常渲染。

### 3.6 textStats 的后端来源与 digest 稳定性(设计门修订;二轮 P0-4 重定义)

后端**没有**前端那样的 unified diff 解析链——narrative 输入构造使用 `git diff --numstat -z --find-renames <base> --`(tracked)+ untracked 逐文件 `git diff --no-index --numstat /dev/null <f>`(与 `gitDiffSnapshot` 同样的逐文件模式),得到 per-file `{added, removed}`。前端仍从已拉取的 patch 解析行数(仅作呈现)。`buildChangeGroups` 的 `textStats` 输入**可选**:缺失时权重条退化用符号计数,组仍成立。

**digest 单点计算、随响应下发,前端不重算**(二轮 P0-4:此前「排除行数」仍不成立——组归属本身由行数权重决定(>8 合并),且前端 1MiB 截断会丢整个 doc/config 文件,任何「前端独立重算」都会漂移):

- 后端在结构 diff 响应上新增可选 `contentDigest: string` = sha256(**分组前**的 canonical file manifest:排序后的 `(repoLabel, filePath, oldPath?, 该文件排序后的 (qualifiedName, changeType) 变更清单)` 列表)前 16 位。与分组规则、行数、severity 解耦。三轮 P0-N1 修订:manifest 必须含**符号身份**(qualifiedName 级清单,不只 changeType 计数)——否则「同路径同计数但改的是另一个方法」时 digest 不变,旧导读被误判为最新;「符号身份变 → digest 变」入测试。
- `narrative.inputDigest` = 生成时刻的同一 `contentDigest`(同一后端函数算)。
- 前端只做**两个后端值的相等比较**(当前响应的 `contentDigest` vs 缓存 narrative 的 `inputDigest`),不一致 → 「导读基于旧版变更,可重新生成」。天然同构,无跨端算法对齐负担;测试改为后端 digest 函数的确定性 + 「diff 变化 → digest 变化、无关字段(行数)变化 → digest 不变」。

## 4. 下钻覆盖层与图聚焦

- `StructuralGraph` 增加可选 prop `focusFiles?: ReadonlySet<string>`:构图前过滤 `data.files`(及 classEdges/impact 的两端文件)——聚焦当前组/当前文件;覆盖层工具条提供「全部 / 当前组 / 当前文件」Segmented。构图纯函数 `buildStructureGraph` 不变,过滤在喂入前(纯函数,单测)。
- `ImpactPanel` 重构:每条 caller/target 渲染为按钮,点击 → 关闭覆盖层 + `changeFocus` 跳转到对应文件+行(caller 有 filePath+range)。
- 调用链/依赖面板行为不变,仅挂载位置迁移。

## 5. 细节决策与边界

1. **概要树数据缺失**(结构失败/unsupported/纯文本文件):右栏只渲染 diff 区;文件头显示原因 chip(degraded/parse-error/unsupported 沿用现状 i18n)。
2. **1MiB 截断**:截断横幅保留;被截断丢失 block 的文件在左栏仍出现(结构侧有)但右栏提示「文本 diff 因截断不可用」;跳转落到此类文件时同提示。
3. **binary**:归 `other`/`binary`,右栏「二进制文件,不呈现内容」(现状语义)。
4. **narrative 仅 task scope**:节点粒度的导读无缓存管理价值(retry 会产生新 node_runs),v1 不做;范围切到节点时导读卡隐藏。
5. **性能**:概要树与左栏在 500+ 文件时不虚拟化(与现状一致,列已知限制);join 与分组 memo 化(`useMemo` by query data 引用);`classifyBreaking` 等语义计算下沉到 join 阶段一次性算好(修 RFC-088 的重复计算)。
6. **主题/深色**:全走既有 CSS var;新 class 命名空间 `.changes__*`。

## 6. 失败模式汇总

| 故障 | 行为 |
| --- | --- |
| 结构 API 4xx/5xx/超时 | diff 主线不受阻;左栏退化为纯文件树(basename+±行+已看);横幅「结构分析不可用」 |
| 文本 diff 4xx/5xx | 全页 ErrorBanner(现状) |
| 两路都空 | 空态矩阵(§3.3) |
| narrative 生成失败/超时 | GET 返回失败态;卡片显示错误+重试;不留半成品文件 |
| narrative 落盘失败 | best-effort:本次响应仍返回 narrative(内存),下次 GET 404 → 可重新生成 |
| narrative 生成期间任务被删 | 写盘前后 re-check,任务消失 → 自删残留目录(§3.2-5) |
| daemon 重启时 generating | single-flight 内存态丢失 → GET 回 404/按钮态;用户重触发(不做持久任务队列) |
| file-content 端点失败(超限 413/二进制 415/网络或 5xx) | 渲染视图自动退回文本 diff + 轻提示(§3.5) |
| file-content `{exists:false}` | **不是失败**(三轮 P1-N1 勘误):纯新增/纯删除的正常空侧,以空文档喂 MarkdownDiffView 正常渲染 |
| deep 引擎失败 | 现状回退横幅保留 |

## 7. 安全与权限

- narrative POST:任务成员 gate(owner/collaborator/admin;普通非成员 403;与 retry/cancel 同级)。GET 跟随 `mountTaskRoutes` 现状可见性语义(不可见 403;二轮 P1-5:任务路由的 403→404 同形化是独立议题,不在本 RFC)。
- narrative prompt 不包含代码正文,仅符号名/路径/统计(与结构 diff 同披露面);归属记录不进 prompt(rfc099 纪律,prompt 内容有单测断言不含 user id)。
- runSystemAgent 沿用其既有 containment/scratch 纪律(RFC-233 admission),本 RFC 不新增放权。

## 8. 与并行 RFC 的耦合

- **RFC-237/238**(系统 agent 运行时/意图构建/MCP playground)正在改 `systemAgentRun.ts`/runtime 层:本 RFC 仅调用 `runSystemAgent(opts)` 公开签名 + 复用系统运行时解析入口;实现期以主干当时形态为准,不修改其内部;若签名变更,适配层集中在 `services/changeNarrative.ts` 一处。
- 共享文件(`schema.ts`/`shared/src/index.ts` barrel 等)按多人并发纪律精确增量编辑。

## 9. 测试策略(必写清单)

**shared**
- `changeGroups.test.ts`:归组矩阵(code 模块段/docs/config/deps/moves/other)、`src` 剥离、>8 组合并、≤4 文件单组、多仓分层、排序与权重、rename+edit 不进 moves(`pureMove=false`)、textStats 缺失时权重退化。
- `structure-semantics.test.ts`(随迁 shared):既有 `classifyBreaking` 判定矩阵全量保持 + `signatureTokensRemoved` 与旧 `diffSignatureTokens` 判定的等价用例(P1-1)。
- `change-narrative-schema.test.ts`:宽松解析(坏组 key 丢弃/缺 overview 拒绝/未知字段容忍)。

**backend**
- `structural-diff-rename.test.ts`(真 git fixture):R100 纯重命名 → `renamedFrom` + changes 空;rename+edit → 符号 modified(非 add+remove);跨目录移动;node/wrapper 粒度 `gitChangedFilesBetween -M` 同语义;落盘老 JSON(无 renamedFrom)反序列化兼容。
- `worktree-diff-rename.test.ts`:`gitDiffSnapshot --find-renames` 输出 rename 头;既有 diff 测试回归。
- `change-narrative.test.ts`:POST 幂等 single-flight(并发两次一次生成)、权限三组(任务不存在/普通非成员 403/非成员 admin 放行)、409 无 base/无变更、422 scope、runFn stub 成功 → 落盘 → GET ready、失败 → 不落盘 + 失败态、`contentDigest` 确定性(diff 变 → 变;行数变 → 不变)、**写盘前后任务已删 → 不留残目录**、numstat `-z` 解析(tracked/rename/untracked)、prompt 纯函数快照(含节点意图、不含 user id/代码正文)、runSystemAgent 调用面字段快照(对照 intent-builder 先例,锁 containmentCoordinator/configDir/profile 不缺)。
- `task-file-content.test.ts`(§3.5):base/worktree 两侧正常读、rename 文件 base 按旧路径读、纯删除 worktree `{exists:false}`、多仓非首仓 base_commit、超限 413、二进制 415、symlink/`../` 越界拒绝、**containment 检查后换链(seam)拒绝**、任务不可见 actor 拒绝(沿用现状 gate 语义)。

**frontend**
- `change-review-join.test.ts`:join 对齐(多仓前缀剥离、canonical label 一致、对不齐单侧保留 + degraded 提示)、textStats 计数、kind 判定、DTO adapter(entry → ChangeGroupEntry,severity 预计算)。
- `diff-viewed-migration.test.ts`:普通/rename(`old → new`)/多仓(`repo::`)三类存量 localStorage JSON 无损读写(P1-4)。
- `hunk-symbol-map.test.ts`:内层符号胜出、old/new 侧选择、removed 符号旧侧行、无结构文件 null、**区间重叠定位:「声明未改、方法体深处改动」命中体内 hunk、零重叠退化最近 hunk**。
- `change-review-panel.test.tsx`:双栏渲染 smoke、组头统计与权重条、severity 点、已看迁移(旧 localStorage key 读取)+ Space + 组/总进度、键盘视觉序、URL 旧 tab 重定向、空态矩阵 6 态、结构失败退化横幅、import 聚合行展开、全 added 折叠到容器级、`added+safe` 无 explain 句、renamedFrom 呈现、md 渲染/文本切换、概要↔diff 双向跳转(mock scroll)、下钻入口 gating、图聚焦过滤(`focusFiles`)、影响面条目可点、AI 导读四态 + digest 过期提示。
- 迁移的旧锁定测试:`worktree-diff-panel.test.tsx`、`structure-view.test.tsx`、`task-detail-tabs` 相关——逐条更新至新组件断言,文件头注明「RFC-239 有意变更」;`canvas`/tab 计数类测试(8→7)同步。

**e2e**:任务详情打开「结构变更」smoke(现有 e2e 若引用旧 tab 名,同步迁移)。

## 10. 已知限制(v1 交付时如实呈现)

- `contentDigest` 覆盖结构可见面(代码符号 + 依赖变更):纯文档/配置改动不改变 digest,不触发「导读基于旧版变更」提示(导读主体是代码故事,权衡记录于 PR-1)。
- 大变更(500+ 文件)无虚拟化(与现状持平)。
- untracked 新文件无 rename 检测(git 语义边界)。
- narrative 依赖系统 agent 运行时配置;未配置运行时 → POST 返回明确错误(沿用系统 agent 基建的错误面)。
- 图仍是「改动集 + 1 跳」现状能力,delta 化与大规模引擎升级(Cytoscape)仍在 RFC-083 OQ-4 后续轨道。
