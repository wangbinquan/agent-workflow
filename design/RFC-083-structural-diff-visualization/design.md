# RFC-083 — 技术设计

> 读序：先读 [proposal.md](./proposal.md)。本文件是技术权威，与 proposal 冲突以 proposal 的产品意图为准、与现有 `design/design.md` 冲突以现有设计为准（本 RFC 不推翻既有约束）。

## 0. 调研结论（为何是这套引擎）

经 9-agent 调研（graphify / difftastic / GumTree / sem / universal-ctags / SCIP / tree-sitter，及本仓抓取/展示/构建管线）得出：

- **基线引擎 = `web-tree-sitter`（WASM）+ 每语言抽取 query + 移植 graphify 的 `graph_diff` 集合差分**。理由：唯一同时满足 (a) 产出"方法 foo 新增 / 字段 x 删除"级**结构化变更集**（difftastic/diffsitter 只是终端着色器，无结构化 changeset；GumTree 需 JVM、edit-script 是泛节点动作非命名符号），(b) 架构无关、随 `bun build --compile` 干净跨编译（native `.node` / ctags / sem 都引回每平台二进制矩阵），(c) **对编译不过的中间态也能解析**（agent 改到一半的常态）。
- **深度引擎 = 可选外部 SCIP 索引器**：精确跨文件引用 → 影响面 + C++/Scala 一等公民。每语言一个外部二进制（`scip-typescript` / `scip-python` / `scip-go` / `scip-clang` / `scip-java`〔含 Scala，经 build-tool〕/ `rust-analyzer ... scip`），守护进程按 PATH / settings 探测，**与现状 opencode / git 同为外部运行时依赖**。需要项目可编译；不可用即回退基线。
- **graphify 本身不作运行时依赖**（它是 Python RAG 知识图谱、git hook 还会丢弃旧图）；只移植它 ~80 行 `graph_diff` 集合算法与 `EXTRACTED / INFERRED / AMBIGUOUS` 置信轴。
- **ctags / sem 作为测试 oracle**（在 CI 用其 JSON 校验我们的抽取正确性），不进生产分发。

### 8 语言基线现实（必须如实呈现给用户）

| 语言 | tree-sitter 文法 | 基线抽取（类/方法/字段/import） | 等级 |
| --- | --- | --- | --- |
| Python | ● | ● | 一等（基线即可） |
| Go | ● | ●（tags 富含 import/const/var） | 一等（基线即可） |
| TypeScript | ● | ●（读 tsconfig `paths` 分 internal/external） | 一等（基线即可） |
| JavaScript | ● | ●（ESM import 检测历史偏弱，需验证） | 一等（基线即可） |
| Java | ● | ◐ 官方 tags 略 enum/field/import → **自写 query** | 一等（基线 + 自写 query） |
| Rust | ● | ◐ 官方 tags 略 `use`/field → **自写 query**，`use` 关联 Cargo.toml | 一等（基线 + 自写 query） |
| C++ | ● 文法可解析 | ○ 无 field/`#include`；预处理器盲、模板/宏有损 | **基线 best-effort / 深度模式一等** |
| Scala | ◐ tags 自 v0.24.0 起 | ◐ 浅解析，Scala-3 `given`/`enum`/嵌套不稳 | **基线 best-effort / 深度模式一等** |

C++/Scala 的"一等公民"由**深度模式**（scip-clang 需 `compile_commands.json`；scip-java 经 build-tool 覆盖 Scala）兑现；基线对它们只做 best-effort 并在 UI 文件级标注。

## 1. 总体架构

```
                       ┌───────────────────────────────────────────────┐
 (fromRef, toRef,      │  StructuralDiffService                          │
  worktreePath,   ───▶ │                                                 │
  scope)               │  1. 选 ref（见 §4）→ 变更文件清单（parseDiff）    │
                       │  2. baseline:                                   │
                       │     每文件 git show <from>:p / 读 worktree:p      │
                       │     → tree-sitter 解析 old/new → 符号图          │
                       │     → graphDiff(old,new) → SymbolChange[]        │
                       │     + manifest set-diff + import 边 → DepChange[] │
                       │  3. deep（可选 / 按需 / 可编译时）:               │
                       │     SCIP 索引器跑 worktree → 解析 SCIP →          │
                       │     跨文件引用图 → 反查被改符号调用点 → Impact[]   │
                       │     失败 → engine='baseline'，标 degraded         │
                       │  4. 组装 StructuralDiff artifact → 存 DB（基线，   │
                       │     完成时 eager）/ 缓存（深度，worktree 存活期）   │
                       └───────────────────────────────────────────────┘
                                          │
                       GET /api/tasks/:id/structural-diff?scope=...&mode=...
                                          │
                       Frontend: 结构视图（摘要卡片 + 折叠结构树 + 依赖面板
                                 + 影响面 + 可选 xyflow 图）
```

两层，**基线永远可用且确定**，**深度可选且尽力**。基线产物在节点 / 任务**完成时 eager 计算并落 DB**（因 `services/gc.ts` 会在终态任务过阈值后删 worktree、`git gc` 还可能裁剪 stash 对象，懒计算会在 GC 后失效）。深度产物**按需**计算（需活 worktree + 可编译），缓存但不强持久。

## 2. 共享数据模型（`packages/shared/src/schemas/structuralDiff.ts`，zod）

> 关键约束：`graphDiff` 纯算法与基础类型放**无依赖叶子模块**，barrel（`shared/src/index.ts`）只重导出类型 / 纯函数，**不得把任何注册表耦合模块拉进初始化环**（RFC-079 二进制 smoke 模块初始化环教训：`bun run build:binary` 必跑）。

```ts
// 符号节点
type SymbolKind =
  | 'file' | 'module' | 'namespace'
  | 'class' | 'interface' | 'trait' | 'struct' | 'enum' | 'object'
  | 'function' | 'method' | 'constructor'
  | 'field' | 'property' | 'constant'
  | 'import'
type Confidence = 'extracted' | 'inferred' | 'ambiguous'   // 移植自 graphify

interface SymbolNode {
  id: string                 // 稳定 id = `${filePath}#${qualifiedName}:${kind}`
  kind: SymbolKind
  name: string
  qualifiedName: string      // 含作用域链，如 `OrderService.charge`
  signature?: string         // 归一化签名（用于 modify 判定）
  lang: LangId
  filePath: string
  range?: { startLine: number; endLine: number }
  parentId?: string          // 容器（class 之于 method）
  confidence: Confidence
  degraded?: boolean         // best-effort 文件里的符号
}

type ChangeType = 'added' | 'removed' | 'modified' | 'renamed' | 'moved'
interface SymbolChange {
  changeType: ChangeType
  kind: SymbolKind
  before?: SymbolNode
  after?: SymbolNode
  signatureChanged?: boolean
  bodyChanged?: boolean          // body-hash 不同
  renamedFrom?: string           // renamed/moved 时
  hunkAnchor?: { filePath: string; startLine: number; endLine: number } // 跳文本 diff
}

interface SymbolEdge {           // contains/calls/imports/inherits/implements/references
  from: string; to: string
  kind: 'contains' | 'calls' | 'imports' | 'inherits' | 'implements' | 'references'
  confidence: Confidence
  changeType?: 'added' | 'removed'
}

type Ecosystem = 'cargo'|'go'|'npm'|'maven'|'gradle'|'sbt'|'pip'|'poetry'|'cmake'|'vcpkg'|'conan'
interface DependencyChange {
  ecosystem: Ecosystem
  packageName: string
  changeType: 'added' | 'removed' | 'updated'
  versionBefore?: string; versionAfter?: string
  viaManifest: boolean           // manifest/lock set-diff 命中
  viaImport: boolean             // 源码新增 import 命中
  manifestPath?: string
}

interface ImpactItem {           // 深度模式：被改符号的反向引用
  changedSymbolId: string
  callers: Array<{ symbolId?: string; filePath: string; range: { startLine: number; endLine: number } }>
  confidence: Confidence
}

type Engine = 'baseline' | 'deep'
type AnalysisStatus = 'ok' | 'partial' | 'pruned' | 'failed'
interface FileStructuralDiff {
  filePath: string
  lang: LangId | 'unknown'
  status: 'ok' | 'degraded' | 'skipped-binary' | 'skipped-oversized' | 'unsupported' | 'parse-error'
  changes: SymbolChange[]
  edges: SymbolEdge[]
}
interface StructuralDiff {       // 顶层 artifact
  scope: 'task' | 'node' | 'wrapper'
  taskId: string
  nodeRunId?: string
  fromRef: string; toRef: string
  engine: Engine
  status: AnalysisStatus
  degradedReason?: string        // 'indexer-missing' | 'build-failed' | 'timeout' | 'snapshot-pruned' | ...
  files: FileStructuralDiff[]
  dependencyChanges: DependencyChange[]
  impact: ImpactItem[]           // deep 才非空
  summary: StructuralDiffSummary // 派生计数（供摘要卡片）
}
```

`graphDiff(oldGraph, newGraph): SymbolChange[]` 纯函数：identity tuple = `(kind, qualifiedName, normalizedSignature)`。new∖old=added、old∖new=removed、both 但 body-hash / signature 异=modified。**重命名感知**用 sem 三阶：① 精确 id 匹配 → ② 结构 body-hash 跨改名匹配 → ③ 名称模糊（>阈值）→ renamed/moved，否则退化为 add+remove。

## 3. 基线引擎（in-binary）

### 3.1 语言注册表与 WASM 加载

`services/structuralDiff/lang/registry.ts`：扩展名 → `{ langId, grammarWasm, extractionQuery, importQuery }`。grammar `.wasm` 来自一个固定 npm 包（如 `tree-sitter-wasms` / `@vscode/tree-sitter-wasm`），放 `packages/backend/grammars/`，**经 build-binary 内嵌**（见 §6）。`web-tree-sitter` 初始化一次、grammar 懒加载并缓存（`Map<LangId, Language>`）。

### 3.2 每文件流程

1. 复用 `util/diffSplit.ts parseDiff` / `DiffViewer splitByFile` 拿变更文件 + hunk 锚点。
2. 跳过：二进制（diff `Binary files` / `--binary` 标记）、超大（沿用既有 sharding 体积上限）、生成物（`*.min.js`、`*.pb.go`、`vendor/`、lockfile 仅进依赖层不进结构层）。
3. old blob：`git -C <repo> show <fromRef>:<path>`（worktree 仍在；GC 后基线已 eager 存好，不再现算）。new blob：worktree 读盘 / `git show <toRef>:<path>`。
4. tree-sitter 解析 old/new → 跑抽取 query → 构符号图（嵌套由语法树容器关系给出 parentId）。Java/Rust 用自写 query 补 field/import；C++/Scala 用现成 tags（best-effort，符号标 `degraded`）。
5. `graphDiff` → `SymbolChange[]`；每个 change 关联 hunkAnchor（落在该符号 range 的 hunk）。

### 3.3 依赖层（静态、全在基线）

- **Manifest set-diff**：对变更集中命中的 manifest/lock，两侧各解析出"声明依赖集"，差分得 added/removed/updated。每生态一个纯解析器：`cargo`（TOML `[dependencies]` + Cargo.lock）、`go`（go.mod require）、`npm`（package.json deps+devDeps，lock 可选）、`maven`（pom.xml `<dependencies>`）、`gradle`（build.gradle(.kts) `implementation/api` 行，best-effort 正则）、`sbt`（build.sbt `libraryDependencies`，best-effort）、`pip`（requirements.txt / pyproject `[project].dependencies` / poetry）、`cmake`/`vcpkg`/`conan`（CMakeLists `find_package` / vcpkg.json / conanfile，best-effort）。
- **Import 边**：源码新增 `import`/`#include`/`use`/`require` → 分类 internal（命中项目内文件 / tsconfig paths）/ stdlib / external。
- **关联**：新 import 解析到新 manifest 依赖 = 最高置信"本次引入对 X 的依赖"（`viaManifest && viaImport`）。

## 4. 取 ref（三粒度）与产物生命周期（耦合 `node_runs` / `tasks` / `gc`）

| scope | fromRef | toRef | 说明 / 缺口 |
| --- | --- | --- | --- |
| task | `tasks.base_commit` | worktree 当前（含未跟踪） | 复用 `worktreeDiff` 输入，零新增抓取 |
| node | `node_runs.pre_snapshot`（该写节点前的 stash sha） | 下一个写节点的 `pre_snapshot`，末写节点则 worktree 现态 | **三缺口须标注**：① 纯 stash 树略未跟踪文件；② readonly 节点 `pre_snapshot` 为 NULL（正确地无贡献）；③ worktree-GC + `git gc` 后 stash 对象可能被裁 → `status='pruned'` |
| wrapper | git-wrapper "首个内层节点前"快照 | "末个内层节点后"快照 | wrapper 的 `git_diff` 已表征此区间，复用其端点 commit |

**生命周期**：基线 artifact 在**节点完成 / 任务完成时 eager 计算 → 落 DB**（survives GC）。深度 artifact **按需**（前端 `mode=deep` 或显式触发），需活 worktree + 可编译，算完缓存（可落临时 / 内存 LRU），不保证持久。`NodeRunSchema` 增派生只读标志 `hasStructuralSnapshot` / `isWriteNode`，让前端在调用前就知道哪些行能给"按节点"视图。

**存储**：新表 `structural_diffs`（drizzle migration）：
`id, task_id, node_run_id(nullable), scope, engine, from_ref, to_ref, status, result_json(text), created_at`，唯一键 `(task_id, scope, node_run_id, engine)`。result_json 即 `StructuralDiff`。基线行 eager 写；深度行按需 upsert。

## 5. 深度引擎（optional / external SCIP）

- **发现**：复用 runtime 管理范式——按 PATH 探测 `scip-*` / `rust-analyzer`，settings 可覆盖绝对路径；启动期 / 首次用时探版本。缺失 → `degradedReason='indexer-missing'`。
- **运行**：在活 worktree 跑对应索引器产出 SCIP index（protobuf）。带**超时 + 资源上限**（复用 1Hz resource-limit 范式）。编译失败 / 超时 → `degradedReason='build-failed'|'timeout'` → **回退基线**。
- **解析 SCIP**：读 protobuf（`@sourcegraph/scip` 或自带 .proto 生成的轻 reader，见 OQ-2），取 occurrences + symbol roles（definition / reference）→ 跨文件引用图。
- **影响面**：对基线判定为 modified/removed 的符号，在引用图反查 definition 的所有 reference（排除 def 自身）→ `ImpactItem.callers`。置信 = SCIP 精确（`extracted`）。
- **C++/Scala 一等公民**：scip-clang（需 `compile_commands.json`，无则尝试 `bear` / CMake export，缺则 degraded）、scip-java（`--build-tool` 覆盖 Scala）。文档明确工具链前置。
- **回退**：任何深度失败都不影响基线产物；前端横幅标注"已用基线（影响面不可用）"。

## 6. 单二进制内嵌（耦合 `scripts/build-binary.ts` / `embed.generated.ts`）

复用既有 embed 表范式（`FRONTEND_FILES` / `MIGRATION_FILES` / `PLUGIN_FILES` 均 `import … with { type: 'file' }` → 运行期 `/$bunfs/...`）：

- 新增 `GRAMMAR_FILES: Record<LangId, string>`（+ `web-tree-sitter` 的 `tree-sitter.wasm` runtime）。`build-binary.ts` 的 `writeGenerated()` 增 walk `packages/backend/grammars/*.wasm` 段。
- dev 期 stub 走文件系统读 `grammars/`；嵌入期 `IS_EMBEDDED` 走 bunfs。`util/paths.ts` 加 grammar 解析。
- **smoke 必跑**：`bun run build:binary` 在 push 前验证 grammar 可加载（RFC-079 教训：模块初始化环 / 资源路径只在 compile 暴露）。

## 7. 后端面（services / routes，耦合 `server.ts`）

- `services/structuralDiff/`：`index.ts`(编排) / `baseline.ts` / `deep.ts` / `graphDiff.ts`(纯叶子) / `lang/*`（registry + queries） / `deps/*`（每生态解析器，纯） / `refSelect.ts`（纯，三粒度取 ref） / `store.ts`（DB 读写）。
- `routes/structuralDiff.ts` `mountStructuralDiffRoutes(app)`，`server.ts` 挂载 + `resourcePermissionGate`：
  - `GET /api/tasks/:id/structural-diff?scope=task|wrapper&mode=baseline|deep`
  - `GET /api/tasks/:id/node-runs/:nodeRunId/structural-diff?mode=...`（挂在既有 per-node `/stdout`/`/events` 旁）
  - `POST /api/tasks/:id/structural-diff/deep`（按需触发深度，返回 job / 直返）
- WS：复用既有 task WS（`useTaskSync`）做 artifact 就绪 invalidation，不新建订阅通道。
- eager 计算 hook：在 runner 节点完成 / 任务终态处调用 `store.upsertBaseline(...)`（不阻塞主流程，失败仅 warn）。

## 8. 前端面（耦合 `routes/tasks.detail.tsx` / `lib/task-detail-tabs.ts` / 公共组件）

**落点**（本 RFC 即"产品行为变更"，**允许**改 spec-pinned `TAB_ORDER`，并在此登记理由）：新增 **`worktree-structure` 标签**，紧随 `worktree-diff` 之后。标签内含**粒度选择器**（`Select`：任务 / 各写节点 / 各 git-wrapper）+ **引擎切换**（`.segmented`：基线 ↔ 深度，深度不可用置灰 + tooltip）。同时在 `worktree-diff` 文本 diff 与本视图间互链（点结构符号→跳对应 hunk，反之 hunk→符号）。

> 备选（OQ-3）：不加标签，改为在 `worktree-diff` pane 内放 `文本 ↔ 结构` 分段切换，复用同一 `diff` query、不动 `TAB_ORDER`。默认取"新标签"以承载三粒度 + 深度切换的信息量。

**新公共组件族**（`components/structure/`，遵守前台统一原则、起 `.structure` 命名空间 + i18n key）：
- `StructuralDiffView.tsx`（容器：粒度 / 引擎选择 + 加载 / 错误 / 空 / 降级横幅，复用 `LoadingState`/`ErrorBanner`/`EmptyState`/`Select`/`.segmented`）。
- `StructuralSummaryCards.tsx`（顶部摘要：文件 / 类 / 方法 / 字段 / 依赖的 +~− 计数，纯聚合自 `summary`）。
- `StructuralTree.tsx`（左变更文件列表〔仿 `WorktreeDiffPanel` 左 tab 习语〕+ 右折叠结构树，符号带 `+/~/−` 徽标、复用 `.diff__add`/`.diff__del` 配色；点符号跳 hunk；degraded 文件挂"不完整"chip）。
- `DependencyChangesPanel.tsx`（依赖增 / 改 / 删 + via-manifest/via-import 标）。
- `ImpactPanel.tsx`（深度：被改符号 → 调用点列表 + 跳转）。
- **可选** `StructuralGraph.tsx`（只读关系图：符号节点 + 调用 / 继承 / import 边、置信着色）。v1 可作 PR-F 选交付（见 plan）。

**渲染选型原则（重要）**：本功能**大部分视图不是"图"**——摘要卡片 / 结构树 / 依赖列表 / 影响列表都是**层级树 / 列表**，一律用**普通 DOM**渲染（可访问性、点击跳转、滚动、与 `WorktreeDiffPanel` 风格一致都优于节点图），承载 ~90% 的"看懂改了啥"。**唯一真正是图的**是符号关系 / 影响子图：
- **v1 渲染 = `xyflow` + 布局引擎（`elkjs` 分层 / `dagre`）**：复用已在仓的 `@xyflow/react`（观感与 workflow 画布一致、点节点→跳代码交互强），但**不复用** 80KB 编辑耦合的 `WorkflowCanvas`，仅借渲染壳；xyflow 无内置自动布局，故配 elkjs/dagre 补上。
- **规模纪律先于渲染器选择**：图**默认收窄到"被改符号 + 1 跳邻居（调用方 / 被调用方）"**，节点数压到数十；任何渲染器在全量代码图下都会糊，收窄是设计纪律不是渲染器能力。
- **升级路径（增量，不改 v1 架构）**：出现"大规模依赖 / 调用网络（全仓级）"真实需求 → 换 **Cytoscape.js**（canvas，fcose/dagre，扛数千节点）；想要标准 UML 类图表达 → 补 **Mermaid `classDiagram` 导出**（声明式、便宜，但交互弱，仅作导出）。

## 9. 失败模式（must handle，逐条有测试）

| 场景 | 行为 |
| --- | --- |
| 文件二进制 / 超大 / 生成物 | 跳过该文件，`status='skipped-*'`，不入结构计数 |
| 不支持的语言 / 扩展名 | 文件 `status='unsupported'`，仍列在文件清单 |
| 单文件 tree-sitter 解析错 | 该文件 `status='parse-error'`，**不**牵连其它文件 / 整体 |
| C++/Scala 基线 | `status='degraded'` + 符号 `degraded=true` + UI 文件级横幅 |
| 深度索引器缺失 / 编译失败 / 超时 | 回退基线，顶层 `engine='baseline'` + `degradedReason` + UI 横幅 |
| node scope 未跟踪文件缺失 | 标注"未跟踪文件未纳入" |
| worktree / 快照 GC 后 | 基线已 eager 落库则正常返回；否则 `status='pruned'`（仿既有 410 `task-worktree-missing`） |
| readonly 节点请求 node scope | 空结构（正确）+ 提示 |

## 10. 与现有模块耦合点（清单）

`util/diffSplit.ts`(parseDiff 复用) · `util/git.ts`(show blob / 快照) · `db/schema.ts`(+ `structural_diffs` 表, `node_runs` 派生标志) · `services/runner.ts`/`task.ts`(eager hook) · `services/gc.ts`(GC 前提) · `server.ts`(挂载) · `scripts/build-binary.ts`+`embed.generated.ts`+`util/paths.ts`(grammar 内嵌) · `shared/src/index.ts`(barrel, 防初始化环) · `routes/tasks.ts`(既有 /diff 邻接) · `frontend routes/tasks.detail.tsx`+`lib/task-detail-tabs.ts`(标签) · 公共组件库 · `i18n/zh-CN.ts`/`en-US.ts` · `useTaskSync`(WS invalidation)。

## 11. 逻辑细节：静态先行、AI 后置（用户决策）

- **v1（静态确定性）**：每个 modified 符号给"签名变化（before→after）+ body 是否变 + tree-edit 粗粒度（如『+N 条语句 / 改了条件』）+ 新增 import 边 + 直达 hunk"。100% 可复现，零 token，作为可信审计信号。
- **后置（可选 AI）**：复用既有 agent-node 机制，对选中符号生成"此方法现在超时会重试"式自然语言，**显式标注「AI 生成、可能不准」**，独立开关、不进默认确定性产物（graphify 教训：引入 LLM 即失可复现性）。本 RFC v1 只留 hook 与 schema 余量（`SymbolChange.detail?`），不实现 AI。

## 12. 测试策略（test-with-every-change，纯函数优先）

**纯函数 / 数据预言（首选可断言面）**：
- `graphDiff`：identity / rename / move / 仅 body 变 / 仅签名变 各一组 before-after 符号图 → 期望 changeset。
- 每语言抽取：`fixtures/structural/<lang>/{before,after}` 文件对 → 期望 `SymbolChange[]`（8 语言各覆盖 class/method/field 增改删；C++/Scala 锁 best-effort 期望含 degraded）。
- 每生态 manifest 解析器：手造 before/after manifest → 期望 `DependencyChange[]`（新增 / 删除 / 升级 + viaManifest）。
- import 抽取 + internal/stdlib/external 分类。
- `refSelect`：三粒度 (fromRef,toRef) + 缺口标注（readonly→空、pruned、未跟踪）。
- 深度影响面：用一份固定 SCIP fixture（不真跑索引器）→ 反查调用点正确。

**源码文本兜底断言**：grammar embed 表存在；**禁止** native `node-tree-sitter` import（只许 `web-tree-sitter`）；`graphDiff.ts` 不得 import 注册表耦合模块（防初始化环）。

**后端集成**：对一个 fixture worktree，三个 endpoint 返回期望 artifact；深度不可用→自动回退基线路径。

**前端**：`StructuralTree` 按 changeType 渲染徽标（role/class 断言）；`StructuralSummaryCards` 计数聚合；粒度 / 引擎选择器交互；降级横幅出现条件。

**门槛**：`bun run typecheck && bun run test && bun run format:check` 全绿 + `bun run build:binary` smoke（grammar 内嵌）+ CI（双 OS + Playwright）。按 [feedback_post_commit_ci_check] 推后即查。

**本地验证清单（CI 无法覆盖——CI 不装 scip-* 索引器）**：以下唯一不能在 CI 验证的是"真索引器产出 `.scip`"；解析/精确 impact/发现/回退全部用 fixture（`encodeScipFixture` 在测试里造）+ 注入 stub spawn 测过。装好对应索引器后本地核对：
1. 装一个自洽索引器（`scip-typescript`/`scip-python`/`scip-go`/`rust-analyzer scip`），对一个真小项目 worktree 调 `?mode=deep`，确认 `engine='deep'` + ImpactPanel 精确调用方。
2. 未装/编译不过/超时三种情况确认 UI 出"深度回退基线"横幅、`engine='baseline'`、不报 500。
3. C++/Scala 需 `compile_commands.json` / build-tool；agent 中间态常编译不过→预期回退基线（属正常）。
4. 索引器版本升级后 SCIP moniker 方案可能漂移——以同一 `parseScip` 重跑步骤 1 核对。
5. 关系图(PR-F)/方法体行变更(#6)在 dev server 上目测：树↔图切换、+N/−M 显示。

## 13. Open Questions（实现期决断，非阻塞批准）

- **OQ-1 grammar 来源包**：`tree-sitter-wasms` vs `@vscode/tree-sitter-wasm` vs 各 grammar 官方 wasm —— 取覆盖 8 语言且维护活跃者；体积评估（预计内嵌 ~8–12MB）。
- **OQ-2 SCIP 解析**：引 `@sourcegraph/scip` 还是自带 `.proto` 生成轻 reader（避免重依赖）。
- **OQ-3 落点**：新 `worktree-structure` 标签（默认）vs `worktree-diff` 内分段切换。
- **OQ-4 关系图视图**：v1 交付（PR-F）还是首个 follow-up。影响面用"调用点列表"已满足验收，图视图是增强。**渲染选型已定**（见 §8 渲染选型原则）：主视图 DOM；可选图视图 v1=`xyflow`+`elkjs`（收窄到"被改符号 + 1 跳邻居"子图），规模 / UML 需求触发再上 Cytoscape.js / Mermaid classDiagram 导出。待定的只是"PR-F 是否进 v1"。
- **OQ-5 深度触发**：自动（worktree 活时后台预跑）vs 纯按需点击。默认纯按需（避免每节点都构建项目，呼应用户"深度尽力 / 不强制"）。
- **OQ-6 artifact 存储**：独立 `structural_diffs` 表（默认）vs 复用 `node_runs` JSON 列。独立表利于 task/wrapper scope 与缓存治理。
