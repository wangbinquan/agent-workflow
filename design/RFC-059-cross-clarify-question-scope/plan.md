# RFC-059 Plan — 任务分解与 PR 拆分

> 状态：**Draft（Blocked-by-RFC-058，2026-05-23）**
> 关联文档：[proposal.md](./proposal.md)、[design.md](./design.md)

> RFC-058 落地前本 plan 不进入实现。落地后开工前需逐条对照 RFC-058 final API（重命名 / 合并 service / 单 wire shape）刷新本文的子任务描述与测试文件名（譬如 `cross-clarify-question-scope.test.ts` 可能改名为 `clarify-question-scope.test.ts`、`buildQuestionerCrossClarifyContext` 调用点改为合并后的入口）。

## 1. 子任务编号 & 依赖

| Task ID    | 描述                                                                                                  | Size | Deps                  |
| ---------- | ----------------------------------------------------------------------------------------------------- | ---- | --------------------- |
| RFC-058-T1 | shared schemas + 纯函数（ClarifyQuestionScope / questionScopes 字段 / extractDesignerScopedSubset 等）| S    | —                     |
| RFC-058-T2 | backend migration 0031（cross_clarify_sessions.question_scopes_json 列 + drizzle schema 同步）       | S    | —（与 T1 可并行）     |
| RFC-058-T3 | backend service submit 分支扩展 + triggerQuestionerContinueRerun helper + 测试                        | M    | T1, T2                |
| RFC-058-T4 | backend designer-side prompt 注入过滤（buildExternalFeedbackContext）+ 守门反问者侧零改动 + 测试      | S    | T3                    |
| RFC-058-T5 | REST 路由透传 + 错误码 `cross-clarify-question-scopes-malformed` + 测试                                | S    | T3                    |
| RFC-058-T6 | frontend per-question Segmented + footer hint + submit body 携带 + i18n + 测试                        | M    | T1, T5                |
| RFC-058-T7 | 回归防护守门（C1-C5 5 条）+ STATE.md / plan.md 索引标 Done                                            | S    | T1-T6                 |

总体规模：2M + 5S，估计单人 2.5-3.5 个工作日（反问者侧零改动让 T4 简化为一处过滤 + 守门）。

## 2. 详细任务说明

### RFC-058-T1 — shared schemas + 纯函数

**目标**：把 `ClarifyQuestionScope` 升为合法类型；submit body / session DTO 接受新字段；纯函数 extractDesignerScopedSubset / countDesignerScopedAcrossSources / resolveQuestionScope 沉淀（**反问者侧不需要新过滤函数**，因为始终注入全量）。

**子项**：

- `packages/shared/src/schemas/clarify.ts`：
  - 加 `ClarifyQuestionScopeSchema` enum + `CLARIFY_QUESTION_SCOPE_DEFAULT` 常量。
  - `SubmitClarifyAnswersSchema` 加 `questionScopes?: Record<string, ClarifyQuestionScope>`。
  - `CrossClarifySessionSchema` 加 `questionScopes: Record<string, ClarifyQuestionScope> | null`（GET 详情返回）。
- `packages/shared/src/clarify-cross.ts`：
  - 加 `resolveQuestionScope(scopes, questionId)` 纯函数。
  - 加 `extractDesignerScopedSubset(questions, answers, scopes)` 纯函数（仅设计者侧用）。
  - 加 `countDesignerScopedAcrossSources(sources)` 纯函数。
  - **不改** `buildExternalFeedbackBlock` 签名（调用方在传 sources 前自行用 extractDesignerScopedSubset 过滤）。
  - **不加** "questioner 侧过滤" helper——反问者继续走 RFC-056 既有 `buildQuestionerCrossClarifyContext` 全量注入路径。

**测试**（≥ 5 case，`packages/shared/tests/cross-clarify-rfc058-shared.test.ts`）：

- `ClarifyQuestionScopeSchema` enum 仅接受 'designer'/'questioner'。
- `SubmitClarifyAnswersSchema` 接受 questionScopes 缺省 / 空对象 / 合法对象。
- `CrossClarifySessionSchema` 接受 questionScopes null / 合法对象。
- `resolveQuestionScope` null 输入 → 'designer'；缺 key → 'designer'；有 key → 该值。
- `extractDesignerScopedSubset` 全 designer / 全 questioner / 混合 / 缺 answer 跳过对应题。
- `countDesignerScopedAcrossSources` 多 source 聚合 / 空 / 全 questioner sources。

**验收**：
- `bun run typecheck` 绿。
- 新测试 6+ 通过。
- 既有 RFC-056 shared 套件零退化（`packages/shared/tests/cross-clarify-rfc056-shared.test.ts` byte-for-byte）。

### RFC-058-T2 — backend migration 0031

**目标**：DB 层 + drizzle schema 加 question_scopes_json 列。

**子项**：

- `packages/backend/src/db/migrations/0031-cross-clarify-question-scopes.ts`：
  ```sql
  ALTER TABLE cross_clarify_sessions ADD COLUMN question_scopes_json TEXT;
  ```
- `packages/backend/src/db/schema.ts`：drizzle schema `crossClarifySessions` 表加 `questionScopesJson: text('question_scopes_json')` 列。
- migration loader 注册 0031（与 0030 同样写法）。

**测试**（≥ 2 case，`packages/backend/tests/migration-0031-rfc058-question-scopes.test.ts`）：

- migration 上行：表存在新列 + 类型 TEXT + NULL 默认。
- 已存 cross_clarify_sessions 行新列 = NULL；其它列字节级不变。

**验收**：
- `bun run test packages/backend/tests/migration-*` 绿。
- daemon 启动顺序：migration 0031 完成后 invariant CR-1 才注册（design.md §10 注意点）。

### RFC-058-T3 — backend service submit 分支 + helper

**目标**：`submitCrossClarifyAnswers` 内部分支按 scope 切；新 `triggerQuestionerContinueRerun` helper 与 stop 版并列。

**子项**：

- `packages/backend/src/services/crossClarify.ts`：
  - `SubmitCrossClarifyAnswersArgs` 加 `questionScopes?` 字段。
  - `SubmitCrossClarifyAnswersResult.outcome` 加 'questioner-continue-triggered' / 'designer-skipped-all-questioner-scope' 两个枚举值。
  - submit 主路径分支（设计方案见 design.md §4.2 伪码）。
  - 新函数 `triggerQuestionerContinueRerun({ db, taskId, questionerNodeRunId })`。
  - 抽出 `_cascadeResetAndDispatchQuestioner({ injectStop: boolean })` 内部 helper，让 `triggerQuestionerStopRerun` / `triggerQuestionerContinueRerun` 都委托给它（避免重复）。
  - `evaluateDesignerRerunReadiness` 返回 `sources` 每项追加 `questionScopes` 字段（从 DB 直接读 questionScopesJson 解析）。
  - 新 helper `validateQuestionScopes(scopes, questions)`：校验所有 key 都是合法 questionId、所有 value 都是合法 enum；malformed → throw ValidationError('cross-clarify-question-scopes-malformed', detail)。
- `packages/backend/src/services/crossClarify.ts` 写入路径（`db.update(crossClarifySessions).set({...})`）追加 `questionScopesJson: scopes === undefined ? null : JSON.stringify(scopes)`。

**测试**（≥ 8 case，`packages/backend/tests/cross-clarify-question-scope.test.ts`）：

详见 design.md §4.6。

**验收**：
- `bun run test packages/backend/tests/cross-clarify*` 全绿。
- `triggerDesignerRerun` / `triggerQuestionerStopRerun` 签名 / 行为字节级不变（既有 RFC-056 service 套件零退化）。

### RFC-058-T4 — designer-side prompt 注入过滤（仅一处改动）

**目标**：designer External Feedback 段按 scope='designer' 过滤；**反问者侧零改动**（始终注入全量 Q&A，与 RFC-056 字节级一致）。

**子项**：

- `packages/backend/src/services/crossClarify.ts` 的 `buildExternalFeedbackContext`（或等价函数）：构造 sources 时调 `extractDesignerScopedSubset(questions, answers, scopes)` 拿到 designer-scoped 子集；传给 `buildExternalFeedbackBlock`。聚合 designer-scoped=0 的 source 跳过不入 sources 列表（防止空 source 进入 External Feedback 块）。
- **反问者侧 `buildQuestionerCrossClarifyContext` 字节级不改**：不读 `questionScopesJson` 列、不调 `extractDesignerScopedSubset`。RFC-056 既有全量注入路径继续生效——continue / stop 两种 directive 都一样、scope 完全不影响。
- **不**改 `shared/clarify-cross.ts` 的 `buildExternalFeedbackBlock` 签名。

**测试**（≥ 3 case，追加到 `packages/backend/tests/cross-clarify-question-scope.test.ts` 或新文件）：

- designer External Feedback 仅含 designer-scoped 题（混合 scope case，断言文本不含 questioner-scoped 题文）。
- questioner cascade rerun prompt 含**全量**题与答案（混合 scope case + reject 路径 + scopes=NULL 三种条件下断言注入文本相同；C3 守门）。
- 聚合 designer-scoped=0 的 source 不进入 External Feedback sources 列表（输出 block 为空 / 不包含该 source 子段）。

**验收**：
- 新 prompt 渲染单测全绿。
- C1 字节级守门测试（不传 questionScopes 跑完整 happy path 与 reject 路径 → prompt 文本与 RFC-056 上线时一致）。
- 源代码层 grep 守门：`buildQuestionerCrossClarifyContext` 函数体内不出现 `questionScopesJson` / `extractDesignerScopedSubset` 字符串。

### RFC-058-T5 — REST 路由 + 错误码

**目标**：POST `/api/clarify/:nodeRunId/answers` 透传 questionScopes；malformed → 400。

**子项**：

- `packages/backend/src/routes/clarify.ts`：
  - 解析 `request.body` 已经在 `SubmitClarifyAnswersSchema` 里支持 questionScopes（T1 完成）。
  - 把它原样传给 `submitCrossClarifyAnswers` 的 args.questionScopes。
  - self-clarify 路径**不读** questionScopes（行为字节级不变）。
- 错误码 `cross-clarify-question-scopes-malformed` 映射：HTTP 400 + JSON body `{ error: { code, message } }`。

**测试**（≥ 3 case，追加到 `packages/backend/tests/routes-cross-clarify.test.ts`）：

详见 design.md §5。

**验收**：
- REST 单测全绿。
- self-clarify 路由测试零退化（`packages/backend/tests/clarify-service.test.ts` byte-for-byte）。

### RFC-058-T6 — frontend per-question Segmented + footer hint + 提交

**目标**：UI 落地 per-question scope 控件 + footer hint 三态 + submit body 携带 + sealed 状态只读 chip + i18n。

**子项**：

- `packages/frontend/src/routes/clarify.detail.tsx`：
  - 加 `scopes` 本地 state + 初始化 useEffect（cross-clarify + awaiting → 全 designer 默认；sealed → 还原 session.questionScopes；self-clarify → 不渲染）。
  - 每题渲染层包一个 `<div className="clarify-question-wrapper">`，里面加 `.clarify-question-scope`：`<Segmented>`（awaiting）/`<span class="status-chip">`（sealed）。
  - footer 加 hint 段，按 scope 分布渲染三种 i18n key。
  - `submitMut.mutationFn` 在 cross-clarify 路径下携带 questionScopes。
- `packages/frontend/src/i18n/zh-CN.ts` / `en-US.ts`：加 6 个新 key（详见 proposal §2.1 第 12 项）。
- `packages/frontend/src/styles.css`：加 `.clarify-question-wrapper` / `.clarify-question-scope` 样式（最小化、贴现有 muted hint 风格）。

**测试**（≥ 6 case + 1 i18n 守门）：

`packages/frontend/tests/cross-clarify-scope-control.test.tsx`（6 case，详见 design.md §7.6）。

`packages/frontend/tests/cross-clarify-scope-i18n.test.ts`（1 case，C5 守门）：
- grep 6 个 key 各自存在于 zh-CN.ts / en-US.ts。
- 占位符严格匹配（`{{n}}` / `{{d}}` / `{{q}}`）。

**验收**：
- `bun run test packages/frontend/tests/cross-clarify-scope*` 全绿。
- RFC-056 既有 frontend 套件（clarify-rfc056-detail-route / cross-clarify-ui-bugs 等）零退化。
- 浏览器自查（按 RFC-035 ux-consistency 视觉对齐自查）：与 NodeInspector 上 sessionMode Segmented side-by-side 比对，按钮 / 颜色 / spacing 一致。

### RFC-058-T7 — 守门 + 完工记录

**目标**：5 条 C 守门测试落库 + STATE.md / plan.md 索引标 Done + push CI + 6 jobs 全绿。

**子项**：

- 5 条 C 守门测试（C1-C5）落库（细节见 design.md §10 + 各 T 任务测试列表）：
  - C1 `packages/backend/tests/cross-clarify-rfc058-compat.test.ts`：RFC-056 happy path + reject 路径不传 questionScopes 字节级守门。
  - C2 `packages/shared/tests/cross-clarify-scope-filter.test.ts`：extractDesignerScopedSubset / countDesignerScopedAcrossSources 纯函数。
  - C3 `packages/backend/tests/cross-clarify-questioner-full-injection.test.ts`：反问者侧不过滤——混合 scope / 全 questioner / NULL / reject 四种条件下注入文本均为该 session 全量；含源代码层 grep（`buildQuestionerCrossClarifyContext` 不出现 questionScopesJson）。
  - C4 `packages/backend/tests/cross-clarify-fast-path-isolation.test.ts`：multi-source 快路径不污染 peer。
  - C5 `packages/frontend/tests/cross-clarify-scope-i18n.test.ts`：i18n cn/en 对齐。
- `STATE.md` 顶部 "进行中 RFC" 行改为 RFC-058 Done 记录 + commit hash + CI run id。
- `design/plan.md` RFC 索引行 Draft → Done。

**验收**：
- `bun run typecheck && bun run test && bun run format:check` 全绿。
- 推 CI 后 6 jobs（Lint+Typecheck+Test × {macos, ubuntu} + Build single-binary × {macos, ubuntu} + Playwright e2e × {macos, ubuntu}）全绿。
- 按 [feedback_post_commit_ci_check] 推完后立刻查 CI 状态。

## 3. PR 拆分建议

按依赖与代码模块切，推荐 **2 PR**：

| PR    | Tasks                  | 主要文件                                                                                       | Commit message 前缀                                                              |
| ----- | ---------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| PR-A  | T1 + T2 + T3 + T4 + T5 | shared/schemas + clarify-cross.ts + migration 0031 + backend services/crossClarify.ts + routes/clarify.ts + backend tests | `feat(backend+shared): RFC-058 cross-clarify per-question scope service + REST + migration 0031` |
| PR-B  | T6 + T7                | frontend routes/clarify.detail.tsx + i18n + styles.css + frontend tests + C 守门 + STATE.md / plan.md 索引收尾 | `feat(frontend): RFC-058 cross-clarify per-question scope UI + C1-C5 守门 + 收官` |

每个 PR 落地约束：

- **每个 PR 三件套全绿**：`bun run typecheck && bun run test && bun run format:check`。
- **PR-A 三件套全绿 + 新增 backend 测试全绿 + migration 0031 单跑通**才能开 PR-B。
- **PR-B 三件套全绿 + 新增 frontend 测试全绿**才能 push。
- **PR-B 推 CI 后等 6 jobs 全绿**才能在 STATE.md 标 Done。
- 按 [feedback_post_commit_ci_check] 推完后立刻查 CI 状态。

**理由**：RFC-058 是纯增量改动、依赖链短（shared → backend → frontend），2 PR 切得合理。PR-A 是 backend + shared 一并（可独立 deploy / 测试不动 UI），PR-B 是 frontend + 收官。如果 PR-A 跑得快可以合并 PR-B 为一个 PR——视实施时 working tree 状态决定。

## 4. 验收清单

完工前逐条核对：

### 功能（对照 proposal.md §A）

- [ ] A1 — 默认全 designer，行为字节级与 RFC-056 一致
- [ ] A2 — 全 questioner-scope → designer 不重跑、outcome='questioner-continue-triggered'
- [ ] A3 — 混合 scope → designer 仅含 designer-scoped Q&A；questioner cascade rerun 含**全量** Q&A（反问者侧不过滤）
- [ ] A3b — questioner cascade rerun 注入文本与"忽略 scope、注入全量"路径字节级一致（C3 守门）
- [ ] A4 — multi-source 单 session 全 questioner → 立刻触发 questioner rerun（不等 peer）
- [ ] A5 — multi-source 聚合 designerCount=0 → designer 不重跑，outcome='designer-skipped-all-questioner-scope'
- [ ] A6 — reject 忽略 scope，行为与 RFC-056 reject 字节级一致
- [ ] A7 — 旧客户端不传 questionScopes → 默认全 designer + question_scopes_json 写 NULL
- [ ] A8 — 旧 NULL 行回看 chip 渲染为"设计者"
- [ ] A9 — malformed questionScopes → HTTP 400 + 错误码 `cross-clarify-question-scopes-malformed`
- [ ] A10 — self-clarify 路径忽略 questionScopes，零退化
- [ ] A11 — migration 0031 上行可跑
- [ ] A12 — scope 控件复用公共 `<Segmented>`
- [ ] A13 — footer hint 三种文案精确切换 + cn/en 双语对称
- [ ] A14 — sealed 状态控件只读 chip

### 非功能（对照 proposal.md §B）

- [ ] B1 — bun run typecheck && bun run test && bun run format:check 全绿
- [ ] B2 — RFC-056 / RFC-023 / RFC-026 / RFC-039 既有套件零退化
- [ ] B3 — backend tests ≥ +12
- [ ] B4 — frontend tests ≥ +6
- [ ] B5 — e2e 不增量（显式声明）
- [ ] B6 — 单二进制构建包体积 / 启动时间不退化

### 回归防护（对照 proposal.md §C）

- [ ] C1 — RFC-056 happy path + reject byte-level 守门
- [ ] C2 — extractDesignerScopedSubset / countDesignerScopedAcrossSources 纯函数守门
- [ ] C3 — 反问者侧不过滤 + reject 注入全量守门
- [ ] C4 — multi-source 快路径不污染 peer 守门
- [ ] C5 — i18n cn/en 对齐守门

### 落地

- [ ] migration 0031 上行可跑 + 单测绿
- [ ] STATE.md 顶部 "进行中 RFC" 改为 Done 记录（commit hash + CI run id）
- [ ] design/plan.md RFC 索引 Draft → Done
- [ ] GitHub Actions 六 jobs 全绿

## 5. 风险缓解（实施层）

详见 proposal.md §7 + design.md §12。本节补 3 条实施层风险：

| 风险                                                          | 缓解                                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| RFC-056 既有 service 套件因 `evaluateDesignerRerunReadiness` 返回结构变化而退化 | sources 数组每项是**追加**字段（不改 / 不删既有）；TypeScript 编译期能捕获遗漏；ad-hoc 跑全 RFC-056 套件验证 |
| frontend `<Segmented>` 控件在每题旁横排时撑爆窄屏 / 移动端 | UI 自查 + 必要时给控件 wrapper 加 `flex-wrap`；非关键路径，可在 PR-B follow-up 补 |
| `triggerQuestionerContinueRerun` 与 `triggerQuestionerStopRerun` 抽共享 helper 时引入 cci 继承 bug | 严格继承 RFC-056 patch-2026-05-25 的 questioner cascade no-skip 语义 + cci 继承规则；新增测试覆盖 cci 在两种路径下都正确递增 |

## 6. 实施顺序提示

接手 session 时：

1. 先读 STATE.md 找 RFC-058 进度（顶部 "进行中 RFC" 行 + 已 push commit）。
2. 读 design.md 找最新决策。
3. 读本 plan.md 找下一个 T-N 任务。
4. 实现 + 测试 + push + 查 CI（[feedback_post_commit_ci_check]）。
5. 完工后更新 STATE.md（commit hash + CI run id）+ 本 plan.md 验收清单打勾。

新 session 接手时**优先**：

1. 确认 RFC-056 patch-2026-05-25 已合入主线（feature 依赖该 patch 的 questioner cascade no-skip 行为）。
2. 拉最新 main / rebase 本地分支，避免与 RFC-056 patch 并发 working tree 冲突。
3. 启动前跑一次完整 `bun run test` 确认 baseline 全绿。
