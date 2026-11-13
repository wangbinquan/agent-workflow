# RFC-493 实施计划

依赖：无硬前置；与 S9 共用 `collaboration/infrastructure/review.ts`，串行（S9 当前没有在制的步骤）。按 CLAUDE.md 文首硬规则：先完成全部
实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-493-T1 工作流静态校验迁入 domain**：`legacy/workflow.validator.ts` 的纯函数部分原样迁入 resource-catalog
  `domain/workflowValidator.ts`；加载器一段留在原文件、改取 domain（design D1）。
- **RFC-493-T2 评审的纯规则迁入 domain**：锚点规范化 → `domain/reviewCommentAnchor.ts`，决定策略表 → `domain/reviewDecisionPolicy.ts`，轮次规则 →
  `domain/reviewRounds.ts`；`review.ts` 改取，不再转出 `findAllOccurrences`（design D2～D4）。
- **RFC-493-T3 使用方**：生产 5 个、用例约 50 个的 import 改到新位置；读源码文本的锁随内容改指新文件；架构账本里描述这些位置的文字锚点
  改指（design D5）。
- **RFC-493-T4 用例**：新增 RFC-493 用例并登记 guard-manifest（design §4）。
- **RFC-493-T5 集中验证**：backend `tsc`、eslint；RFC-493 与受影响用例；按 CI 的跑法跑相关文件（与 HEAD 同时 A/B）；全量 SQLite；架构报告
  对照；全仓旧位置扫描（含 `design/` 里的 markdown 链接）。
- **RFC-493-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 清单里每一项只在新的 domain 文件声明一次；旧位置不声明、不转出（含 `findAllOccurrences`）；没有文件从旧位置取
- [x] AC-2 同样输入下校验、锚点规范化、决定策略与轮次分组的结果与此前一致
- [x] AC-3 新文件不取 infrastructure、IO 包与进程全局；跨 context 边、public surface 与计数不升
- [x] AC-4 受影响用例全部通过；exact SHA CI：`489b30bf6` 主 CI run 43508101368 的 70 个 job 全部通过，同一推送按路径触发的
      windows-platform 与 visual-regression-nightly 通过（见 §CI）

## 集中验证（2026-11-13，候选 1～3）

本机全程高负载（10 核；采样到的 1 分钟负载 33～48，主要是本机其他进程）。验证在候选导出仓库里跑：HEAD 的树加候选路径，修复后重新
同步，核对与工作树逐字相同；对照导出仓库与 HEAD 的树相同。验证开始前 `origin/main` 前进到另一会话只改文档的 `13467cea0`（终态维护的
CI 补记，改了 `STATE.md`、RFC-490 的 plan 与 `docs/audit-backlog.md`）；本 RFC 在 `STATE.md` 里只有自己那一行，候选 1、2 与对照都同步到它之上；候选 3 同步时 HEAD 又前进到同一会话只改文档的 `2f65372c8`，
候选 3 与对照都同步到它之上（两次前进都不碰代码，此前的结果沿用）。

集中验证与静态自查查出本 RFC 的问题，都在本 RFC 范围内修正（design §6 细化 2、4）：

1. 静态自查（eslint）：调用闭包的两个选择函数（`pickCallWorkflowRow`、`resolverOverClosure`）写在加载器一段中间、却只有校验本体用，
   按行号切分时留在了原文件（原文件报未使用）；连同注释移入 domain（细化 4）。`review.ts` 留下两个不再用到的 import，删去。
2. 首批：`cross-clarify-validator-rules` 读校验器源码找 11 个规则码，路径按片段拼在原文件上（`'legacy', 'workflow.validator.ts'`），
   内容迁走后 11 条全红；随后按文件名本身（含路径片段）全仓再扫，查出同类的 `multiplicity-prepass-singleton` 与前端
   `rfc203-validation-copy`（读校验器收集全部校验码，迁走后原文件 0 个、断言不少于 60）。三处改指新文件（细化 2）。
3. 首批：本 RFC 用例 ① 的“每个名字只声明一次”过严——resource-catalog 的 application 端口里早有一个同名的不同类型
   `WorkflowValidationCandidate`；改为逐个钉住这一个同名项。
4. 全量：`intent-teaching-registry` 红——intent 的教学登记（生产代码 `intent/domain/teaching/nodeKinds.ts` 的 `VALIDATOR`）把校验器文件记为
   节点字段的读点，用例按它做 AST 正反向核对。登记与用例改指新文件（读点只供这条用例核对，不进提示词）。随后按代码里的字符串字面量
   （AST，排除注释）把全部包、`e2e`、`scripts` 再扫一遍，查出两条迁移后会静默变空的否定锁（`rfc271-impl-gate-fixes`、shared 的
   `wrapper-kind-single-source`），一并改指（细化 2）。

- **静态**：backend `tsc` 0 错（候选 1，`tsconfig` 覆盖 `tests/`）；eslint `--max-warnings 0`：改动的 65 个 backend 文件无告警，候选 2
  改动的三个 backend 用例与一个前端用例、候选 3 改动的三个 backend 文件与一个 shared 用例另跑都无告警；prettier：改动的 TS 与本 RFC 的三件套通过（`architecture/*.json`、`STATE.md` 与
  `docs/` 按约定不跑）。
- **首批**（候选 1，按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，2 个 worker；与对照同时、同样跑法）：274 个文件
  （`tests/architecture/` 全部、本 RFC 改动与改指的用例、文件名含 review / anchor / validator / decision-policy / rounds 的用例、文档对账
  用例）。候选 2,904 条里 2,758 条通过、4 条跳过，对照（少本 RFC 用例）2,898 条里 2,760 条通过、4 条跳过。候选多红的 12 条是上面的 2、3；
  其余两边都红在 PostgreSQL 一侧撞 5 秒、撞用例自带时限或看门狗，逐文件比对只差 ±1～4 条，方向两边都有（候选多：
  `rfc317-transition-table-oracle` 1、`clarify-review-combination-scenarios` 1、`retry-node-no-review-cascade` 2、
  `review-cancel-concurrency` 3、`review-dispatch-cci` 1；对照多：`rfc400` 1、`review-approve-idempotent` 1、`review-dispatch-terminal-state`
  1、`reviews-comment-patch` 2、`rfc193-wrapper-review` 1、`rfc202-empty-review-auto-approve` 1、`rfc370-m2-review-artifacts` 1、
  `rfc372-review-followups` 4；`rfc359-t2c` 各 1）。
- **修复批**（候选 2，同样跑法与对照同时）：本 RFC 用例 6 / 6（最慢一条 2.9 秒，是冷读全部生产文件与用例的那条），`cross-clarify-validator-rules`、
  `multiplicity-prepass-singleton` 与读 guard-manifest 的四个用例全过；首批候选多红的六个文件这一轮两边逐文件只差 ±1 条，方向两边都有
  （`rfc317-transition-table-oracle` 与 `review-dispatch-cci` 两边相同，`review-cancel-concurrency` 对照多 1，`retry-node-no-review-cascade`、
  `rfc359-t2c` 与 `clarify-review-combination-scenarios` 候选多 1），都在 PostgreSQL 一侧撞 5 秒、撞用例自带时限或看门狗。`clarify-review-combination-scenarios` 候选首批红的 S6 一例是撞文件自带的 20 秒看门狗（失败在 20.18 秒，
  看门狗中止全部任务后第二轮评审没出现），这一轮候选通过、对照首批也红同类的 S-RFC074；`retry-node-no-review-cascade` 两边同时各跑
  3 轮，候选红 1 条（撞 5 秒），PostgreSQL 一侧逐条耗时两边相当（平均 5.32 秒对 5.21 秒，含钩子）。这几处走的代码本 RFC 只改了
  import，不归本 RFC（候选的绿不作通过依据）。前端 `rfc203-validation-copy`（vitest）候选与对照各 7 / 7（候选读到 domain 文件的 131 个
  校验码）。
- **全量 SQLite**（导出仓库逐文件跑，每个文件独立的 HOME 与 TMP、`--isolate`、`AW_TEST_PROVIDERS=sqlite`、单条 60 秒，用例自带时限的照旧）：
  清单按耗时从慢到快排；最重的 46 个文件在候选 1 上以 2 个 worker 跑完后由本会话中止（首批 A/B 结束、负载降下来，改用 4 个 worker），
  余下 2,891 个在候选 2 上跑；那 46 个文件不含候选 2 改动的用例。合计 2,937 个文件、2,925 个通过（23,873 条通过、127 条按环境跳过）；
  其余 12 个：
  - 本 RFC 的问题 1 个：`intent-teaching-registry`（上面 4），候选 3 上通过。
  - 发布账本一条（`rfc321-repository-publication-ratchet`）：导出仓库没有真实历史，对照同样红。
  - 撞用例自带时限、内部等待或看门狗的 10 个：三个报告类用例（`rfc294-architecture-preflight` 180 / 60 秒、
    `rfc370-committed-architecture-source` 150 秒、`rfc376-report` 300 秒）；`rfc363-preparation-process-recovery` 进程恢复的检查点 30 秒；
    `rfc400`、`rfc300`、`rfc354-nested-frames-closure`、`rfc363-workspace-content`、`rfc321-repository-publication-system-mock-e2e` 各一条
    30 秒；`rfc167` 的 `settleTask` 5 秒。
  - 与对照同时、同样跑法 A/B（候选 3，各 3 个 worker）：7 个两边都红、逐个耗时相近（发布账本那条在内），`intent-teaching-registry` 与
    `rfc271-impl-gate-fixes` 两边都过；`rfc363-preparation-process-recovery` 候选两次红在不同的阶段（全量 `working-branch-prepared-before-cas`、
    A/B `cleanup-after-remove`，都是 30 秒的检查点没等到），两边同时各跑 3 轮都 7 / 7。这个用例不经过校验器与评审，走的是
    source-control 的工作区准备与崩溃恢复，不归本 RFC（候选的绿不作通过依据）。
  - 三个报告类用例各做一份只放宽时限的副本（全部时限 → 1,500 秒）在候选 3 上同时跑：`rfc294-architecture-preflight` 14 / 14（最慢 697 秒）、
    `rfc370-committed-architecture-source` 2 / 2（505 秒）、`rfc376-report` 16 / 16（879 秒）；跑完删除副本。
  - shared 的 `wrapper-kind-single-source` 候选与对照各 3 / 3。
- **架构报告**（`scripts/architecture-report.ts`，候选 1 与对照各出一份）：60 项实测都在 `counts.json` 的 `max` 内且与对照逐项相同；
  生产文件 4,086 → 4,090（四个新的 domain 文件）；跨 context import 7,503 → 7,504（删 1 增 2：加载器文件取 `@/util/hash` 的那条随
  哈希函数进了 domain，domain 新取 `@/util/hash` 与 `@/util/errors` 各 1 条，都是 RFC-294 允许 domain 取的工具）；变更入口清单里
  `createWorkflowValidationTargets` 换了路径（没有账本钉它）；`composition-control-flow-resource-catalog` 92 条不变（两处只换行号）。
- **全仓旧位置扫描**：迁出的名字在生产与用例里都不再从旧位置取（本 RFC 用例 ③ 全量扫描）；读两个旧文件源码的锁按文件名本身（含
  路径片段，`packages/frontend` 与 `e2e` 在内）扫过，见上面 2；e2e 与其余用例里提到旧位置的只剩注释（历史记录）。
  `windows-platform.yml` 的路径过滤登记着 `review.ts`，那一组是人工门生命周期的两条用例（`rfc333-human-gate-source-locks`、
  `rfc359-w4-d25-adapters`），读的是留在 `review.ts` 的门代码；迁出的纯规则与 Windows 无关，不加新文件。`design/` 里指向两个旧文件的
  markdown 链接文件仍在，链接有效。

## CI（AC-4）

- `489b30bf6`（实现，父提交是另一会话只改文档的 `2f65372c8`）：exact SHA 主 CI run 43508101368 的 70 个 job 全部通过。同一推送按路径触发的
  windows-platform run 43508101508（本 RFC 改了它路径过滤里登记的 `review.ts`，Windows 上跑人工门生命周期的两条用例）与
  visual-regression-nightly run 43508101206 也通过。
- 本 RFC 的落档提交 `e9d2400cd`（只改文档）：主 CI run 43473583663 里 Playwright e2e（macos-latest shard 3/4）没分到 runner 被取消（GitHub 注记
  「The job was not acquired by Runner of type hosted even after multiple attempts」，macOS arm64 容量受限，一步都没跑），「CI required」随之红，
  其余 job 通过；不归本 RFC，后继 `489b30bf6` 的主 CI 全部通过。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。查出一处并已修正（design §6 细化 4：调用闭包的两个选择函数起初留在了原文件），其余逐项与 HEAD
比对未发现行为差别，结论 PASS：

- **工作流静态校验**：切分由脚本按行号与 AST 做，并逐段核对：原文件的头注、第 128～171 行的两个输入类型与第 453 行起的纯函数部分逐字
  出现在 `domain/workflowValidator.ts`，加载器一段（第 173～451 行）逐字留在原文件；随后移入的 `pickCallWorkflowRow`、`resolverOverClosure`
  连同注释逐字移动。函数体与注释没有改动，只有 import 按两边实际用到的名字重新生成（prettier 只改了 import 的折行）。
  `validateWorkflowById` 取的 `validateWorkflowDefinition`、`withValidationOverlays` 就是迁入 domain 的同一组函数。backend `tsc` 0 错，
  每个引用都解析到唯一的声明（RFC-493 用例 ① 钉住每个名字只声明一次）。
- **评审的纯规则**：三个新文件里除头注与 import 外的每一段都逐字出现在原 `review.ts`；`review.ts` 只删掉迁出的语句、加上从三个新文件
  取名字的 import、删掉两个不再用到的 import（`findAllOccurrences`、`ReviewAnchorFailure`）。随整段迁出的分节标题一起走，
  “Decision (approve / reject / iterate).”留在原处（design §6 细化 3）。`findAllOccurrences` 不再从 `review.ts` 转出，两个用例改取
  shared，取到的是同一个函数。
- **使用方**：54 个文件的 import 由脚本按名字拆分（迁出的名字改取新位置，留在旧位置的照旧），别名与相对写法保持原样；动态 import 的
  一处（`rfc148`）手改。读源码的锁改指新文件，断言不变。
- **插件禁用码的发射点清单**（`PLUGIN_DISABLED_SITES`）改指新文件：生产里只有运行时启动自检读 `DISABLED_RESOURCE_POLICY` 的条目与
  `why`，不读 `sites`，没有可见变化。
- **intent 教学登记的读点**（`nodeKinds.ts` 的 `VALIDATOR`）改指新文件：`readPoint` 只由 `intent-teaching-registry` 核对，生产代码不读、
  不进提示词，没有可见变化。
- **public 与装配**：public 不变；生产里取迁出名字的只有 resource-catalog 的两个 composition 与三个 infrastructure 文件，都只改 import
  位置；collaboration 生产侧只有 `review.ts` 自己用这些规则。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-493 纯逻辑归位——工作流静态校验与评审的锚点、决定策略迁出 infrastructure（RFC-294 S13）`。走私有 index、按路径
清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
