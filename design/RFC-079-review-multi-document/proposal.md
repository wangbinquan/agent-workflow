# RFC-079 Proposal —— Review 节点扩展为多文档模式（逐篇采纳 + 检视意见 + 三决策）

> 状态：Draft（2026-06-03）
> Owner：—
> 关联文档：[design.md](./design.md)、[plan.md](./plan.md)
> 首用例：测试领域工作流（测试点设计 → 用例生成几十条 → **逐篇评审 / 采纳子集** → 下游）

## 1. 背景

平台要把工作流扩展到**测试领域**。测试领域的真实形态是：

1. 一个 agent 产出**测试点设计**（一篇 markdown，复用现有 agent markdown 输出，零新增）。
2. 一个 agent 从设计点**生成几十条测试用例**（每条一段 markdown，整体是一个 `list<path<md>>` 端口——每条一个 `.md` 文件）。
3. 人对这几十条**逐篇评审**：可对每篇提**检视意见**（选词锚定 inline 评论，和现有 review 体验一致）、逐篇标**采纳 / 不采纳**，然后做一个整批决策：
   - **同意通过**：采纳的那些用例作为子集走向下游。
   - **迭代**：把每篇的检视意见回灌上游用例生成 agent，重生一批，重开评审。
   - **驳回**：和现有 markdown 驳回一样——回退上游 commit（worktree pre_snapshot）+ 整批重生，重开评审。
4. 只有**采纳**的用例走向下游（例如下游再接 `wrapper-fanout` 逐条生成测试代码）。

### 1.1 为什么是「扩展 review」而不是「新建 curation 节点」

本 RFC 早期草案（commit 前，曾名 `RFC-079-list-curation-gate`）设计了一个独立的 `curation` 新 NodeKind + 两张新表 + 新状态 `awaiting_selection`，刻意避开 review 的副作用。但与用户对齐后**方向反转**：用户要的正是 review 的全套体验作用到多篇文档上——

- **逐篇检视意见** = review 的选词锚定 inline 评论（anchor / 草稿持久化 / 侧栏 scroll-spy）。
- **迭代** = review 的 iterate（评论回灌 `{{__review_comments__}}`、上游重跑、不回滚 worktree）。
- **驳回** = review 的 reject（`{{__review_rejection__}}` + 回退 pre_snapshot + 整批重生）。
- **三决策按钮**、**乐观锁 `reviewIteration`**、**历史版本 / diff**、**待评审收件箱**——全部已存在。

唯一全新的东西只有两点：**每篇文档的「采纳 / 不采纳」选择** 和 **同意时输出采纳子集**。其余 100% 复用。因此把它做成 review 的**多文档运行时模式**（输入端口是 `list<path<md>>` 时自动进入），而非新节点——改动面最小、与现有评审体验天然一致，也直接命中用户「扩展当前 markdown 评审界面变成可评审多文档」的原话。

### 1.2 核心简化（相比早期 curation 草案）

| 维度 | 早期 curation 草案 | 本 RFC（扩展 review） |
|---|---|---|
| NodeKind | 新增 `curation` | **不新增**（review 多文档模式，由 input kind 驱动） |
| 新表 | `selection_sets` + `selection_items` | **零新表**（复用 `doc_versions`，加 3 列） |
| 新状态 | `awaiting_selection` | **复用 `awaiting_review`** |
| schema_version | bump 4 → 5 | **不 bump**（节点定义结构零变化） |
| inline 检视意见 | 无（只整篇 accept/reject） | **复用 review 选词锚定评论** |
| 迭代 / 驳回回灌 | v1 不做 | **复用 review iterate / reject** |

### 1.3 本 RFC 不动哪些地方

- **不动**单文档 review 的任何现有语义：输入是 `markdown` / `path<md>` 时，dispatch / 三决策 / 输出端口 `approved_doc`+`approval_meta` **字节级不变**（`itemIndex IS NULL` 即单文档判据，三新列全 NULL，所有现有查询不受影响）。
- **不动** RFC-014 的「多 sourcePort sibling 评审」机制（`syncOutputsOnIterate` / `{{__sibling_outputs__}}`）——那是「同上游多 markdown 输出端口、各自一个 review 节点」，与本 RFC「单端口 list 输入、一个 review 节点、多 item」**正交**，互不干扰。
- **不动** `review_comments` 表（每篇文档的 inline 评论天然按 `docVersionId` FK 隔离）。
- **不动** `wrapper-fanout`（采纳子集 `accepted:list<path<md>>` 是标准 list 端口，下游 fanout 按路径 shardKey 直接分片）。
- **不动** worktree / GC / events archive；多文档 doc_versions 跟 task 走（已 cascade）。

## 2. 目标

### 2.1 做

1. **Review 多文档模式**：放开 validator 对 review 输入端口的 `list` 限制——当 `inputSource` 上游端口 kind 是 `list<path<md>>`（或 `list<markdown>`）时，review 进入多文档模式。单端口、单 review 节点、N 个 item。
2. **`doc_versions` 加 3 列**（全 nullable、单文档 = NULL、纯 ADD COLUMN 无 rebuild）：
   - `item_index INTEGER`：0-based 篇序（多文档成员），采纳子集按它保序。
   - `selection TEXT{unselected|accepted|not_accepted}`：每篇的采纳选择，与 round 级 `decision` 正交。
   - `item_path TEXT`：list 成员的 worktree 相对路径（稳定 id；采纳子集输出指向 live 文件）。
3. **dispatch 多文档归档**：`dispatchReviewNode` 检测 list 输入 → 拆 N 个路径 → 每篇读盘归档成一个 `doc_version`（共享 `reviewNodeRunId` + `reviewIteration`，各自独立 `versionIndex` 序列），park `awaiting_review`。
4. **逐篇采纳 API**：`PATCH /api/reviews/:nodeRunId/documents/:docVersionId/selection`——标 accepted / not_accepted，乐观更新，不 bump `reviewIteration`，WS `review.selection_changed` 多 tab 同步。
5. **三决策（沿用 review 语义，多文档分支）**：
   - **approve（同意）**：校验全部已标（任一 `unselected` → 409 `review-selection-incomplete`）；采纳子集 = `filter(accepted).sort(itemIndex).map(itemPath)`；写输出端口 `accepted`（kind `list<path<md>>`）= 采纳路径 `\n` join；node_run → done → resumeTask 解锁下游。
   - **iterate（迭代）**：每篇评论 → `decisionReason = renderCommentsForPrompt(...带 File 头)`；聚合该上游全部 iterated 篇的评论（每篇带 `### {itemPath}` 区分）注入 `{{__review_comments__}}`；上游重跑（**不回滚**），bump `reviewIteration`，重开多文档评审。
   - **reject（驳回）**：每篇 `decision='rejected'`、共享 `rejectReason`；`rollbackToSnapshot` 回退上游 worktree（`rollbackFilesOnReject` 默认 true）+ 整批重生，重开评审。
6. **输出端口按模式切换并存**：单文档 → `approved_doc`(markdown)+`approval_meta`；多文档 → `accepted`(`list<path<md>>`)+`approval_meta`（含 `acceptedItemIndices`/`itemCount`）。validator 输出端口推导据 inputSource 上游 kind 二选一。
7. **前端三栏多文档评审面（泛化现有评审页）**：多文档分支挂左栏文档列表（每行 title + 采纳 StatusChip + 未决标记，点选切换右侧），右侧复用 `Prose`+Mermaid+PlantUML 渲染当前篇 + 当前篇 inline 评论；逐篇采纳/不采纳条 + 三决策按钮（approve 全标才可点）。单文档完全走现有双栏路径、零回归。
8. **待评审收件箱标识**：`ReviewSummary` 加 `isMultiDoc`，行内 badge + tooltip「多文档评审」；点进同一 `/reviews/$nodeRunId` 走多文档面。
9. **单轮反馈，多轮靠 wrapper-loop 外包**：每次 iterate/reject 触发一轮上游重生 + 重开评审；要受控多轮把「用例生成 → review」用现有 `wrapper-loop` 包起来（不在 review 内建循环控制器）。

### 2.2 不做

- **不新增 NodeKind / 新表 / 新状态 / 不 bump schema_version**（见 §1.2）。
- **不做**用例内容编辑 / 人工新增用例（v1 只评审 + 逐篇采纳；编辑留后续）。
- **不做** review 内建多轮自动循环（单轮反馈，多轮 wrapper-loop 外包）。
- **不做**端到端测试模板 / 下游测试代码生成示范（v1 仅交付 review 多文档能力 + 单测；下游由用户用现有 agent + fanout 自行编排）。
- **不做** worktree 外部改动 banner（采纳子集输出指向 live 文件，外部改动后下游读改后内容——属 RFC-005 S8 范畴，本 RFC 记一笔设计负债，非阻塞）。
- **不做**结构化字段用例（每篇是整块 markdown；标题取首个 heading）。
- **不动**单文档 review / RFC-014 sibling 评审现有行为。

## 3. 用户故事

**S1（happy path：逐篇采纳 → 同意）**
工作流：`input(需求) → designer(agent, outputs:[{name:'test_points', kind:markdown}]) → caseGen(agent, outputs:[{name:'cases', kind:'list<path<md>>'}]) → reviewCases(review, inputSource=caseGen.cases)`。Launch → designer 产出测试点 → caseGen 生成 28 个 `cases/tc_001.md…tc_028.md`、`cases` 端口 28 行路径 → reviewCases 进 `awaiting_review`（多文档），左栏 28 篇。用户逐篇读（右侧渲染 markdown），采纳 20、不采纳 8。28 篇全标 → 点「同意通过」→ `accepted` 端口 = 20 行路径 → reviewCases done → 下游解锁。

**S2（迭代：检视意见回灌）**
用户读到第 5 篇，选词「应覆盖并发下单」→ 浮出评论框 → 写「缺并发场景，补一条」→ 提交（复用 review 选词锚定）。又在第 12 篇提一条评论。点「迭代」→ 框架把这两篇评论（各带 `### tc_005.md` / `### tc_012.md` 区分头）注入 `{{__review_comments__}}` → caseGen 重跑（不回滚 worktree）产新一批 → reviewCases 重开多文档评审（`reviewIteration` +1）。用户复审新批次。

**S3（驳回：整批回退重生）**
用户读完认为整批方向跑偏 → 点「驳回」→ 填理由「用例粒度太粗，要拆到接口级」→ 框架回退 caseGen 的 worktree 到 pre_snapshot（删掉那批 md）+ caseGen 重跑（`{{__review_rejection__}}` 带理由）→ 新一批 → reviewCases 重开。同现有 markdown 驳回。

**S4（下游 fan-out 自由编排）**
用户在 reviewCases 后接 `wrapper-fanout(shardSource=reviewCases.accepted)` 内含 `testCoder(agent)`。fanout 把 20 条采纳用例按路径 shardKey 切 20 片，每片为该用例生成测试代码。review 节点自身不 fan-out。

**S5（两种生成拓扑都支持）**
拓扑 A：caseGen 单 agent 一次产出 28 条 → `list<path<md>>`。拓扑 B：测试点本身多点，上游 `wrapper-fanout` 按点并行生成、聚合成一个总 `cases` 列表。两种产出的都是一个 `list<path<md>>` 端口，reviewCases 对来源无感，行为一致。

**S6（单文档 review 零回归）**
另一处工作流 `designer → reviewDesign(review, inputSource=designer.design)`，design 是单篇 `markdown`。reviewDesign 完全走现有单文档评审（双栏、approve 输出 `approved_doc`、reject 回退）——本 RFC 对它字节级无影响。

**S7（多 tab 同步）**
开两 tab。A tab 把第 5 篇标「采纳」→ B tab 左栏第 5 行 StatusChip 即时变绿（WS `review.selection_changed`）。A 点同意 → B 顶部状态 awaiting → done、面转只读。

**S8（必须全篇裁决）**
用户标了 26/28 篇就点同意——按钮 disabled，提示「还有 2 篇未裁决」（左栏未决项有标记，J/K 跳下一未决）。补齐后可点。

## 4. 验收标准

### 功能

- **A1（S1 e2e）**：list 输入 → reviewCases 多文档 awaiting_review → 左栏 N 篇 + 右侧渲染 → 逐篇采纳 → 全标同意 → `accepted` 子集 → 下游推进。
- **A2（采纳子集保序）**：采纳 K 篇，`accepted` = 这 K 篇 itemPath、按 itemIndex 保序、`\n` join、不采纳的不出现。
- **A3（迭代评论回灌带文档区分）**：两篇各一条评论 → 上游重跑 prompt 的 `{{__review_comments__}}` 含两个 `### itemPath` 区块、评论不串篇；不回滚 worktree。
- **A4（驳回回退仍生效）**：reject → `rollbackToSnapshot` 被调用 + 上游 mint fresh pending + 整批重生。
- **A5（必须全篇裁决）**：存在 `unselected` → approve 409 `review-selection-incomplete` + 前端按钮 disabled。
- **A6（标题抽取）**：每篇 markdown 首个 `#` 标题 → 左栏行标题；无 heading 回退首行 / 文件名。
- **A7（来源无关）**：单 agent 上游 vs fanout 聚合上游 → 同一多文档评审面。
- **A8（上游重生整批作废）**：caseGen 重跑产新批 → 旧 N 篇 superseded、整批重建 awaiting_review。
- **A9（下游 fanout 衔接）**：`accepted` 接 wrapper-fanout → 分片数 = 采纳条数；空采纳 → 下游空 list 直接 done。
- **A10（收件箱标识）**：多文档评审项带 `isMultiDoc` badge；点进多文档面。
- **A11（多 tab WS）**：逐篇 selection + 三决策跨 tab 实时同步。

### 非功能 / 回归

- **B1** `bun run typecheck && bun run test && bun run format:check` 全绿；push 后查 CI（含 build smoke + Playwright）。
- **B2（关键）单文档 review 零回归**：markdown / path<md> 输入仍走原路径，三新列全 NULL，`approved_doc`/`approval_meta` + 三决策 + 回退 + sibling cascade 字节级不变。RFC-005 / RFC-013 / RFC-014 既有套件全绿。
- **B3** backend tests 至少 +16（migration 1 + dispatch 多文档 3 + approve 子集保序/全标校验 3 + iterate 评论回灌区分 2 + reject 回退 1 + selection PATCH 2 + provenance 整批作废 2 + 单文档零回归 2）。
- **B4** shared/frontend tests 至少 +12（`computeAcceptedSubset` 纯函数 4 + `isMultiDocReviewInput` 判定 2 + DocVersionSchema 向后兼容 2 + 三栏 reducer/门控 2 + 收件箱 badge 2）。
- **B5** 源码兜底断言：`item_index`/`selection`/`item_path` 在 schema.ts；validator 放开 list 的 code；approve 多文档写 `accepted` 端口。

### 回归防护

- **C1** `tests/review-multidoc-single-doc-no-regression.test.ts`：锁定单文档 review 在新列加入后字节级不变（红了说明多文档分支污染了单文档路径）。
- **C2** `tests/review-multidoc-accepted-subset-order.test.ts`：锁定采纳子集保序 + 仅 accepted。
- **C3** `tests/review-multidoc-iterate-comment-attribution.test.ts`：锁定 iterate 回灌每篇评论带 `### itemPath` 区分、不串篇。
- **C4** `tests/review-multidoc-reject-rollback.test.ts`：锁定多文档 reject 仍调 `rollbackToSnapshot`（不被多文档分支绕过）。
