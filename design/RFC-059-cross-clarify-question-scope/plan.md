# RFC-059 Plan — 任务分解与 PR 拆分

> 状态：**Ready（2026-05-23，RFC-058 已落地 main，本 plan 按 RFC-058 final API 重刷）**
> 关联文档：[proposal.md](./proposal.md)、[design.md](./design.md)
>
> **2026-05-23 RFC-058 落地后差异（本次刷新已应用）**：
>   - **migration 编号 0031 → 0032**：RFC-058 占用了 `0031_rfc058_clarify_rounds_unify.sql`，本 RFC 用 `0032_rfc059_clarify_rounds_question_scopes.sql`。
>   - **目标表 = 两张**：`cross_clarify_sessions`（legacy，`buildExternalFeedbackContext` 还在读）+ `clarify_rounds`（unified，`buildPromptContext` 反问者分支会读）。RFC-058 是 dual-write 保留双表，本 RFC 同样需要 dual-write 新列。
>   - **DTO 名 `CrossClarifySession` → `ClarifyRound`**：路由/前端已切到 `ClarifyRound`（带 `kind: 'self'|'cross'` 判别符）。`ClarifyRoundSchema.questionScopes` 新增字段；submit body `SubmitClarifyAnswersSchema.questionScopes` 新增字段。仍同步把 `CrossClarifySessionSchema.questionScopes` 保留（dual-write 期还在用）。
>   - **反问者侧入口 = `buildPromptContext({ consumerKind: 'cross-questioner', ... })`**：在 `packages/backend/src/services/clarifyRounds.ts` 内（RFC-058 T13 上线）；遗留的 `buildQuestionerCrossClarifyContext`（`crossClarify.ts:1223`）作为 PR-A baseline 测试锚还在，但**生产无引用**。RFC-059 不读两者的 `question_scopes_json`——反问者侧零改动。
>   - **设计者侧入口 = `buildExternalFeedbackContext`**：仍在 `packages/backend/src/services/crossClarify.ts:1136`、仍读 `cross_clarify_sessions`（RFC-058 没碰这里）。**RFC-059 仅在这一个函数里加 scope 过滤**。
>   - **submit 入口 = `submitCrossClarifyAnswers`**：仍在 `packages/backend/src/services/crossClarify.ts:334`，dual-write 已在线（同事务写两张表，line 397 起）。RFC-059 在该 dual-write 内再追加 `questionScopesJson`。
>   - **shared helper 路径 = `packages/shared/src/clarify.ts`**（不是设计文档里写的 `clarify-cross.ts`，本仓没有该文件；`buildExternalFeedbackBlock` 已经住在 `packages/shared/src/clarify.ts:443`）。新加的 `extractDesignerScopedSubset` / `resolveQuestionScope` / `countDesignerScopedAcrossSources` 一并落到该文件。
>   - **Schema 字段位置**：`ClarifyRoundSchema`（packages/shared/src/schemas/clarify.ts:322）追加 `questionScopes`；为 dual-write 期 `CrossClarifySessionSchema`（同文件 line 238 附近）也追加同字段。

## 1. 子任务编号 & 依赖

| Task ID    | 描述                                                                                                  | Size | Deps                  |
| ---------- | ----------------------------------------------------------------------------------------------------- | ---- | --------------------- |
| RFC-059-T1 | shared schemas + 纯函数（ClarifyQuestionScope / questionScopes 字段 / extractDesignerScopedSubset 等）| S    | —                     |
| RFC-059-T2 | backend migration 0032（cross_clarify_sessions + clarify_rounds 双表 question_scopes_json 列 + drizzle schema 同步）| S    | —（与 T1 可并行）     |
| RFC-059-T3 | backend service submit 分支扩展 + triggerQuestionerContinueRerun helper + dual-write questionScopesJson + 测试 | M    | T1, T2                |
| RFC-059-T4 | backend designer-side prompt 注入过滤（buildExternalFeedbackContext）+ 反问者侧零改动守门 + 测试      | S    | T3                    |
| RFC-059-T5 | REST 路由透传 + 错误码 `cross-clarify-question-scopes-malformed` + 测试                                | S    | T3                    |
| RFC-059-T6 | frontend per-question Segmented + footer hint + submit body 携带 + i18n + 测试                        | M    | T1, T5                |
| RFC-059-T7 | 回归防护守门（C1-C5 5 条）+ STATE.md / plan.md 索引标 Done                                            | S    | T1-T6                 |

总体规模：2M + 5S，估计单人 2.5-3.5 个工作日（反问者侧零改动让 T4 简化为一处过滤 + 守门）。

## 2. 详细任务说明

### RFC-059-T1 — shared schemas + 纯函数

**目标**：把 `ClarifyQuestionScope` 升为合法类型；submit body / `ClarifyRound` DTO 接受新字段；纯函数 `extractDesignerScopedSubset` / `countDesignerScopedAcrossSources` / `resolveQuestionScope` 沉淀到 `packages/shared/src/clarify.ts`（**反问者侧不需要新过滤函数**，因为始终注入全量）。

**子项**：

- `packages/shared/src/schemas/clarify.ts`：
  - 加 `ClarifyQuestionScopeSchema` enum + `CLARIFY_QUESTION_SCOPE_DEFAULT` 常量。
  - `SubmitClarifyAnswersSchema` 加 `questionScopes?: Record<string, ClarifyQuestionScope>`。
  - `ClarifyRoundSchema` 加 `questionScopes: Record<string, ClarifyQuestionScope> | null`（GET `/api/clarify/:nodeRunId` 详情返回；self-clarify 行恒为 null）。
  - `CrossClarifySessionSchema` 同步加 `questionScopes: Record<string, ClarifyQuestionScope> | null` 字段（dual-write 期 legacy DTO 也得有，避免 RFC-058 dual-write helper 类型不一致）。
- `packages/shared/src/clarify.ts`（不是 `clarify-cross.ts`——后者本仓不存在；`buildExternalFeedbackBlock` 已经在此文件）：
  - 加 `resolveQuestionScope(scopes, questionId)` 纯函数。
  - 加 `extractDesignerScopedSubset(questions, answers, scopes)` 纯函数（仅设计者侧用）。
  - 加 `countDesignerScopedAcrossSources(sources)` 纯函数。
  - **不改** `buildExternalFeedbackBlock` 签名（调用方在传 sources 前自行用 extractDesignerScopedSubset 过滤）。
  - **不加** "questioner 侧过滤" helper——反问者继续走 RFC-058 合并后的 `buildPromptContext({ consumerKind: 'cross-questioner', ... })` 全量注入路径。
- `packages/shared/src/index.ts` re-export 新 enum / 新 helper（与 RFC-058 沿用的 barrel 一致）。

**测试**（≥ 5 case，`packages/shared/tests/clarify-question-scope-shared.test.ts`）：

- `ClarifyQuestionScopeSchema` enum 仅接受 'designer'/'questioner'。
- `SubmitClarifyAnswersSchema` 接受 questionScopes 缺省 / 空对象 / 合法对象。
- `ClarifyRoundSchema` 接受 questionScopes null / 合法对象。
- `CrossClarifySessionSchema` 接受 questionScopes null / 合法对象（dual-write 期向后兼容）。
- `resolveQuestionScope` null 输入 → 'designer'；缺 key → 'designer'；有 key → 该值。
- `extractDesignerScopedSubset` 全 designer / 全 questioner / 混合 / 缺 answer 跳过对应题。
- `countDesignerScopedAcrossSources` 多 source 聚合 / 空 / 全 questioner sources。

**验收**：
- `bun run typecheck` 绿。
- 新测试 7+ 通过。
- 既有 RFC-056 / RFC-058 shared 套件零退化（典型 anchor：`packages/shared/tests/cross-clarify-rfc056-shared.test.ts`、`packages/shared/tests/clarify-rounds-schema.test.ts`）。

### RFC-059-T2 — backend migration 0032

**目标**：DB 层 + drizzle schema 加 question_scopes_json 列。**双表都改**——RFC-058 dual-write 期 `cross_clarify_sessions` 和 `clarify_rounds` 同时写入；任一缺列都会让 dual-write 失败。

**子项**：

- `packages/backend/db/migrations/0032_rfc059_clarify_rounds_question_scopes.sql`：
  ```sql
  ALTER TABLE cross_clarify_sessions ADD COLUMN question_scopes_json TEXT;
  ALTER TABLE clarify_rounds ADD COLUMN question_scopes_json TEXT;
  ```
  无 index、无 FK——纯 nullable TEXT 列，NULL 默认。
- `packages/backend/src/db/schema.ts`：
  - `crossClarifySessions` 表加 `questionScopesJson: text('question_scopes_json')` 列。
  - `clarifyRounds` 表同样加 `questionScopesJson: text('question_scopes_json')` 列。
- migration loader 自动按文件名顺序加载，无需手动注册（与 0029、0030、0031 一致）。

**测试**（≥ 3 case，`packages/backend/tests/migration-0032-rfc059-question-scopes.test.ts`）：

- migration 上行：双表都含新列、类型 TEXT、NULL 默认。
- 已存 `cross_clarify_sessions` 行（譬如 RFC-056 happy path 装的）经过 migration 后该列 = NULL，其它列字节级不变。
- 已存 `clarify_rounds` 行（RFC-058 dual-write 写入的）经过 migration 后该列 = NULL，其它列字节级不变。

**验收**：
- `bun run test packages/backend/tests/migration-*` 绿。
- daemon 启动顺序：migration 0032 完成后 invariant CR-1 才注册（与 RFC-058 启动序对齐）。

### RFC-059-T3 — backend service submit 分支 + helper

**目标**：`submitCrossClarifyAnswers` 内部分支按 scope 切；新 `triggerQuestionerContinueRerun` helper 与 stop 版并列；dual-write `questionScopesJson` 同时落到两张表。

**子项**：

- `packages/backend/src/services/crossClarify.ts`：
  - `SubmitCrossClarifyAnswersArgs` 加 `questionScopes?` 字段。
  - `SubmitCrossClarifyAnswersResult.outcome` 加 'questioner-continue-triggered' / 'designer-skipped-all-questioner-scope' 两个枚举值。
  - submit 主路径分支（设计方案见 design.md §4.2 伪码）。
  - **dual-write 扩展**：现有 `db.update(crossClarifySessions).set({...})`（line 380+）与 `db.update(clarifyRounds).set({...})`（line 391+）都追加 `questionScopesJson: scopes === undefined ? null : JSON.stringify(scopes)`。两条 UPDATE 同事务；RFC-058 已有 dual-write helper 沿用。
  - 新函数 `triggerQuestionerContinueRerun({ db, taskId, questionerNodeRunId })`。
  - 抽出 `_cascadeResetAndDispatchQuestioner({ injectStop: boolean })` 内部 helper，让 `triggerQuestionerStopRerun` / `triggerQuestionerContinueRerun` 都委托给它（避免重复）。
  - `evaluateDesignerRerunReadiness` 返回 `sources` 每项追加 `questionScopes` 字段（直接读 `crossClarifySessions.questionScopesJson` 解析）。
  - 新 helper `validateQuestionScopes(scopes, questions)`：校验所有 key 都是合法 questionId、所有 value 都是合法 enum；malformed → throw ValidationError('cross-clarify-question-scopes-malformed', detail)。

**测试**（≥ 9 case，`packages/backend/tests/cross-clarify-question-scope.test.ts`）：

详见 design.md §4.6。额外补 1 case：dual-write 双表 `questionScopesJson` 字节级一致（防御 future 单写漂移）。

**验收**：
- `bun run test packages/backend/tests/cross-clarify*` 全绿。
- `triggerDesignerRerun` / `triggerQuestionerStopRerun` 签名 / 行为字节级不变（既有 RFC-056 service 套件 + RFC-058 dual-write 套件零退化）。

### RFC-059-T4 — designer-side prompt 注入过滤（仅一处改动）

**目标**：designer External Feedback 段按 scope='designer' 过滤；**反问者侧零改动**（无论走遗留 `buildQuestionerCrossClarifyContext` 还是 RFC-058 合并后的 `buildPromptContext({ consumerKind: 'cross-questioner', ... })`，都注入全量 Q&A，与 RFC-056 字节级一致）。

**子项**：

- `packages/backend/src/services/crossClarify.ts` 的 `buildExternalFeedbackContext`（已存在 line 1136）：构造 sources 时调 `extractDesignerScopedSubset(questions, answers, scopes)` 拿到 designer-scoped 子集；传给 `buildExternalFeedbackBlock`。聚合 designer-scoped=0 的 source 跳过不入 sources 列表（防止空 source 进入 External Feedback 块）。
- **反问者侧两条路径都字节级不改**：
  - `packages/backend/src/services/crossClarify.ts:1223` `buildQuestionerCrossClarifyContext`（遗留 PR-A baseline 锚）—— 不读 `questionScopesJson`、不调 `extractDesignerScopedSubset`。
  - `packages/backend/src/services/clarifyRounds.ts:294` `buildPromptContext`（RFC-058 合并入口，生产实际走这里，cross-questioner 分支）—— 同样不读 `questionScopesJson`。RFC-058 既有全量注入路径继续生效——continue / stop 两种 directive 都一样、scope 完全不影响。
- **不**改 `packages/shared/src/clarify.ts` 的 `buildExternalFeedbackBlock` 签名。

**测试**（≥ 3 case，追加到 `packages/backend/tests/cross-clarify-question-scope.test.ts` 或新文件 `packages/backend/tests/cross-clarify-question-scope-prompt.test.ts`）：

- designer External Feedback 仅含 designer-scoped 题（混合 scope case，断言文本不含 questioner-scoped 题文）。
- questioner cascade rerun prompt 含**全量**题与答案（混合 scope case + reject 路径 + scopes=NULL 三种条件下断言注入文本相同；C3 守门）。同时通过 scheduler 的实际 `buildPromptContext` 调用路径断言（不仅是遗留函数）。
- 聚合 designer-scoped=0 的 source 不进入 External Feedback sources 列表（输出 block 为空 / 不包含该 source 子段）。

**验收**：
- 新 prompt 渲染单测全绿。
- C1 字节级守门测试（不传 questionScopes 跑完整 happy path 与 reject 路径 → prompt 文本与 RFC-058 上线时一致——以 main 当前 baseline 为锚）。
- 源代码层 grep 守门（C3 一部分）：
  - `buildQuestionerCrossClarifyContext` 函数体内不出现 `questionScopesJson` / `extractDesignerScopedSubset` 字符串。
  - `buildPromptContext`（packages/backend/src/services/clarifyRounds.ts）函数体内 cross-questioner 分支不出现 `questionScopesJson` / `extractDesignerScopedSubset`（守门反问者侧不引入过滤）。

### RFC-059-T5 — REST 路由 + 错误码

**目标**：POST `/api/clarify/:nodeRunId/answers` 透传 questionScopes；malformed → 400。

**子项**：

- `packages/backend/src/routes/clarify.ts`：
  - 解析 `request.body` 已经在 `SubmitClarifyAnswersSchema` 里支持 questionScopes（T1 完成）。
  - 把它原样传给 `submitCrossClarifyAnswers` 的 args.questionScopes。
  - self-clarify 路径（同文件内 submitClarifyAnswers 调用）**不读** questionScopes（行为字节级不变）。
- 错误码 `cross-clarify-question-scopes-malformed` 映射：HTTP 422（`ValidationError` 约定，proposal §A9 草稿 400 已修正）+ JSON body `{ error: { code, message } }`。
- GET `/api/clarify/:nodeRunId` 详情响应（已经 RFC-058 切到 `getClarifyRoundDetail` 返回 `ClarifyRound`）需要把 `questionScopesJson` 列解析后填入 `ClarifyRound.questionScopes`；NULL → null。

**测试**（≥ 4 case，追加到 `packages/backend/tests/routes-cross-clarify.test.ts` + `packages/backend/tests/routes-clarify.test.ts`）：

详见 design.md §5。新增 1 case：GET 详情 cross-clarify session 返回 `questionScopes` 字段（NULL → null；非空 → 解析后的对象）。

**验收**：
- REST 单测全绿。
- self-clarify 路由测试零退化（`packages/backend/tests/routes-clarify.test.ts` self 分支 byte-for-byte）。

### RFC-059-T6 — frontend per-question Segmented + footer hint + 提交

**目标**：UI 落地 per-question scope 控件 + footer hint 三态 + submit body 携带 + sealed 状态只读 chip + i18n。**注意**：RFC-058 把前端切到了 `ClarifyRound`（带 `kind: 'self'|'cross'` 判别符）；本 RFC 在 `s.kind === 'cross'` 分支内加 UI。

**子项**：

- `packages/frontend/src/routes/clarify.detail.tsx`：
  - 加 `scopes` 本地 state + 初始化 useEffect（`s.kind === 'cross'` + awaiting → 全 designer 默认；sealed → 还原 `s.questionScopes`；`s.kind === 'self'` → 不渲染 scope 控件）。
  - 每题渲染层包一个 `<div className="clarify-question-wrapper">`，里面加 `.clarify-question-scope`：`<Segmented>`（awaiting）/`<span class="status-chip">`（sealed）。
  - footer 加 hint 段，按 scope 分布渲染三种 i18n key。
  - `submitMut.mutationFn` 在 `s.kind === 'cross'` 分支下携带 questionScopes。
- `packages/frontend/src/i18n/zh-CN.ts` / `en-US.ts`：加 8 个新 key（详见 proposal §2.1 第 11 项）。
- `packages/frontend/src/styles.css`：加 `.clarify-question-wrapper` / `.clarify-question-scope` 样式（最小化、贴现有 muted hint 风格）。

**测试**（≥ 6 case + 1 i18n 守门）：

`packages/frontend/tests/cross-clarify-scope-control.test.tsx`（6 case，详见 design.md §7.6）：
- 全部 case 用 `mkRound({ kind: 'cross', ... })` 构造（与 RFC-058 既有 fixture 风格一致）。
- 第 6 个 case 改为：`kind: 'self'` 节点 detail 页 → 不渲染 scope 控件、不传 questionScopes（行为字节级与 RFC-058 上线后一致）。

`packages/frontend/tests/cross-clarify-scope-i18n.test.ts`（1 case，C5 守门）：
- grep 8 个 key 各自存在于 zh-CN.ts / en-US.ts。
- 占位符严格匹配（`{{n}}` / `{{d}}` / `{{q}}` / `{{total}}` 按 proposal §2.1 第 11 项约定）。

**验收**：
- `bun run test packages/frontend/tests/cross-clarify-scope*` 全绿。
- RFC-056 / RFC-058 既有 frontend 套件（clarify-detail-route / clarify-rfc056-detail-route / cross-clarify-ui-bugs / clarify-detail-nodeRunId-switch 等）零退化。
- 浏览器自查（按 RFC-035 ux-consistency 视觉对齐自查）：与 NodeInspector 上 sessionMode Segmented side-by-side 比对，按钮 / 颜色 / spacing 一致。

### RFC-059-T7 — 守门 + 完工记录

**目标**：5 条 C 守门测试落库 + STATE.md / plan.md 索引标 Done + push CI + 6 jobs 全绿。

**子项**：

- 5 条 C 守门测试（C1-C5）落库（细节见 design.md §10 + 各 T 任务测试列表）：
  - C1 `packages/backend/tests/cross-clarify-rfc059-compat.test.ts`：RFC-058 上线后 happy path + reject 路径不传 questionScopes 字节级守门（main 当前 baseline）。
  - C2 `packages/shared/tests/clarify-question-scope-filter.test.ts`：extractDesignerScopedSubset / countDesignerScopedAcrossSources 纯函数。
  - C3 `packages/backend/tests/cross-clarify-questioner-full-injection.test.ts`：反问者侧不过滤——混合 scope / 全 questioner / NULL / reject 四种条件下注入文本均为该 session 全量；含双源代码层 grep（`buildQuestionerCrossClarifyContext` 与 `buildPromptContext` cross-questioner 分支均不出现 questionScopesJson）。
  - C4 `packages/backend/tests/cross-clarify-fast-path-isolation.test.ts`：multi-source 快路径不污染 peer。
  - C5 `packages/frontend/tests/cross-clarify-scope-i18n.test.ts`：i18n cn/en 对齐。
- `STATE.md` 顶部 "进行中 RFC" 行改为 RFC-059 Done 记录 + commit hash + CI run id。
- `design/plan.md` RFC 索引行 Draft → Done。

**验收**：
- `bun run typecheck && bun run test && bun run format:check` 全绿。
- 推 CI 后 6 jobs（Lint+Typecheck+Test × {macos, ubuntu} + Build single-binary × {macos, ubuntu} + Playwright e2e × {macos, ubuntu}）全绿。
- 按 [feedback_post_commit_ci_check] 推完后立刻查 CI 状态。

## 3. PR 拆分建议

按依赖与代码模块切，推荐 **2 PR**：

| PR    | Tasks                  | 主要文件                                                                                       | Commit message 前缀                                                              |
| ----- | ---------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| PR-A  | T1 + T2 + T3 + T4 + T5 | shared/schemas + clarify.ts + migration 0032 + backend services/crossClarify.ts + routes/clarify.ts + backend tests | `feat(backend+shared): RFC-059 cross-clarify per-question scope service + REST + migration 0032` |
| PR-B  | T6 + T7                | frontend routes/clarify.detail.tsx + i18n + styles.css + frontend tests + C 守门 + STATE.md / plan.md 索引收尾 | `feat(frontend): RFC-059 cross-clarify per-question scope UI + C1-C5 守门 + 收官` |

每个 PR 落地约束：

- **每个 PR 三件套全绿**：`bun run typecheck && bun run test && bun run format:check`。
- **PR-A 三件套全绿 + 新增 backend 测试全绿 + migration 0032 单跑通**才能开 PR-B。
- **PR-B 三件套全绿 + 新增 frontend 测试全绿**才能 push。
- **PR-B 推 CI 后等 6 jobs 全绿**才能在 STATE.md 标 Done。
- 按 [feedback_post_commit_ci_check] 推完后立刻查 CI 状态。

**理由**：RFC-059 是纯增量改动、依赖链短（shared → backend → frontend），2 PR 切得合理。PR-A 是 backend + shared 一并（可独立 deploy / 测试不动 UI），PR-B 是 frontend + 收官。如果 PR-A 跑得快可以合并 PR-B 为一个 PR——视实施时 working tree 状态决定。

## 4. 验收清单

完工前逐条核对：

### 功能（对照 proposal.md §A）

- [ ] A1 — 默认全 designer，行为字节级与 RFC-058 上线后 main baseline 一致
- [ ] A2 — 全 questioner-scope → designer 不重跑、outcome='questioner-continue-triggered'
- [ ] A3 — 混合 scope → designer 仅含 designer-scoped Q&A；questioner cascade rerun 含**全量** Q&A（反问者侧不过滤）
- [ ] A3b — questioner cascade rerun 注入文本与"忽略 scope、注入全量"路径字节级一致（C3 守门，覆盖遗留 `buildQuestionerCrossClarifyContext` + 合并后 `buildPromptContext` cross-questioner 分支双入口）
- [ ] A4 — multi-source 单 session 全 questioner → 立刻触发 questioner rerun（不等 peer）
- [ ] A5 — multi-source 聚合 designerCount=0 → designer 不重跑，outcome='designer-skipped-all-questioner-scope'
- [ ] A6 — reject 忽略 scope，行为与 RFC-056 reject 字节级一致
- [ ] A7 — 旧客户端不传 questionScopes → 默认全 designer + question_scopes_json 写 NULL（双表）
- [ ] A8 — 旧 NULL 行回看 chip 渲染为"设计者"
- [ ] A9 — malformed questionScopes → HTTP 422 + 错误码 `cross-clarify-question-scopes-malformed`
- [ ] A10 — self-clarify 路径忽略 questionScopes，零退化
- [ ] A11 — migration 0032 上行可跑（双表都加列）
- [ ] A12 — scope 控件复用公共 `<Segmented>`
- [ ] A13 — footer hint 三种文案精确切换 + cn/en 双语对称
- [ ] A14 — sealed 状态控件只读 chip

### 非功能（对照 proposal.md §B）

- [ ] B1 — bun run typecheck && bun run test && bun run format:check 全绿
- [ ] B2 — RFC-056 / RFC-058 / RFC-023 / RFC-026 / RFC-039 既有套件零退化
- [ ] B3 — backend tests ≥ +12
- [ ] B4 — frontend tests ≥ +6
- [ ] B5 — e2e 不增量（显式声明）
- [ ] B6 — 单二进制构建包体积 / 启动时间不退化

### 回归防护（对照 proposal.md §C）

- [ ] C1 — RFC-058 main baseline happy path + reject byte-level 守门
- [ ] C2 — extractDesignerScopedSubset / countDesignerScopedAcrossSources 纯函数守门
- [ ] C3 — 反问者侧不过滤 + reject 注入全量守门（双入口 grep）
- [ ] C4 — multi-source 快路径不污染 peer 守门
- [ ] C5 — i18n cn/en 对齐守门

### 落地

- [ ] migration 0032 上行可跑 + 单测绿
- [ ] STATE.md 顶部 "进行中 RFC" 改为 Done 记录（commit hash + CI run id）
- [ ] design/plan.md RFC 索引 Draft → Done
- [ ] GitHub Actions 六 jobs 全绿

## 5. 风险缓解（实施层）

详见 proposal.md §7 + design.md §12。本节补 4 条实施层风险：

| 风险                                                          | 缓解                                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| RFC-058 dual-write 期 cross_clarify_sessions / clarify_rounds 任一表漏写 `questionScopesJson` → 读侧 fallback 不到导致行为漂移 | T3 测试增加"双表 questionScopesJson 字节级一致"case；service 层抽 helper `serializeQuestionScopes()` 避免两条写路径分裂；T4 designer 侧只读 cross_clarify_sessions（与历史保持），反问者侧两条入口都不读、漂移影响可控 |
| RFC-056 既有 service 套件因 `evaluateDesignerRerunReadiness` 返回结构变化而退化 | sources 数组每项是**追加**字段（不改 / 不删既有）；TypeScript 编译期能捕获遗漏；ad-hoc 跑全 RFC-056 + RFC-058 套件验证 |
| frontend `<Segmented>` 控件在每题旁横排时撑爆窄屏 / 移动端 | UI 自查 + 必要时给控件 wrapper 加 `flex-wrap`；非关键路径，可在 PR-B follow-up 补 |
| `triggerQuestionerContinueRerun` 与 `triggerQuestionerStopRerun` 抽共享 helper 时引入 cci 继承 bug | 严格继承 RFC-056 patch-2026-05-25 的 questioner cascade no-skip 语义 + cci 继承规则；新增测试覆盖 cci 在两种路径下都正确递增 |

## 6. 实施顺序提示

接手 session 时：

1. 先读 STATE.md 找 RFC-059 进度（顶部 "进行中 RFC" 行 + 已 push commit）。
2. 读 design.md 找最新决策。
3. 读本 plan.md 找下一个 RFC-059-TN 任务。
4. 实现 + 测试 + push + 查 CI（[feedback_post_commit_ci_check]）。
5. 完工后更新 STATE.md（commit hash + CI run id）+ 本 plan.md 验收清单打勾。

新 session 接手时**优先**：

1. 确认 RFC-058 已落 main（`design/plan.md` RFC 索引看到 RFC-058 = Done）。
2. 拉最新 main / rebase 本地分支，避免与 RFC-058 dual-write 路径并发 working tree 冲突。
3. 启动前跑一次完整 `bun run typecheck && bun run test` 确认 baseline 全绿。
