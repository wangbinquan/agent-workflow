# RFC-058 Proposal — Clarify Sessions 合表重构（Clarify Sessions Unification）

> 状态：Draft（2026-05-23）
> Owner：—
> 关联文档：[design.md](./design.md)、[plan.md](./plan.md)
> 基线 RFC：[RFC-023 agent-clarify](../RFC-023-agent-clarify/proposal.md)、[RFC-026 clarify-inline-session](../RFC-026-clarify-inline-session/proposal.md)、[RFC-039 clarify-ask-bias](../RFC-039-clarify-ask-bias/proposal.md)、[RFC-053 lifecycle hardening](../RFC-053-node-run-lifecycle-hardening/proposal.md)、[RFC-056 clarify-cross-agent](../RFC-056-clarify-cross-agent/proposal.md)（含 patch-2026-05-22..25）
> 后置 RFC：[RFC-059 cross-clarify per-question scope](../RFC-059-cross-clarify-question-scope/proposal.md)（Blocked-by-RFC-058）

## 1. 背景

RFC-023 self-clarify + RFC-056 cross-clarify 在 DB / service / 类型层都是**完全平行的两套**：

| 维度 | self-clarify | cross-clarify |
|---|---|---|
| DB 表 | `clarify_sessions` | `cross_clarify_sessions` |
| service | `services/clarify.ts` | `services/crossClarify.ts` |
| prompt 注入 | `buildClarifyPromptContext` | `buildQuestionerCrossClarifyContext` / `buildExternalFeedbackContext` |
| 持久化字段（核心）| questions_json / answers_json / status / directive / iteration / created_at / answered_at | 同样 5+ 字段、不同列名细节 |
| 前端 wire DTO | `ClarifySession` | `CrossClarifySession` |
| 前端列表 entry | `ClarifySessionSummary` | `CrossClarifySessionSummary` |
| `/api/clarify` 路由 dispatch | 按 NodeKind 分支 | 同一路由、内部分支 |

历史成因合理——RFC-023 先落 self-clarify，RFC-056 设计时为了**不动 RFC-023 既有套件 / 不冒生产数据风险**，选了"平行新表 + 平行 service"路径（明示在 RFC-056 §1.2 不动 RFC-023）。但代价开始显现：

- **2026-05-22 RFC-056 §6 update mode patch**：引入"已 baked into prior output 的 Q&A 不再注入 designer prompt"规则（`historyCutoffClarifyIteration`）；其代码注释 `scheduler.ts:1347-1371` 自己写："this block generalises [aging] to every rerun trigger"——但实际只 wired 到 `buildClarifyPromptContext`，**`buildQuestionerCrossClarifyContext` 没接 cutoff**，cross-clarify 反问者侧的 Q&A 在重跑时仍然全量注入历史，违反 GENERAL 规则。
- **Per-question scope（RFC-059 草稿）**：需要在两套 service + 两套 schema + 两套前端 DTO 上分别落地，相同的 `extractDesignerScopedSubset` / scope 字段几乎要写两遍。
- **未来任何新 Q&A 维度**（譬如基于 timestamp 的精细老化 / 反问者级 audit log / inbox 跨表统计）都会被迫双写——任何一个 RFC 漏写一边都会复发上面的 aging gap 类 bug。
- `scheduler.ts:1347` 注释自承 GENERAL 规则、但代码物理上没 GENERAL 入口；下一个开发者读到这条规则要靠注释而不是函数名。

**关键约束**：本平台**还未上生产**，DB 里的 RFC-056 cross-clarify 数据均为开发期 / 测试期数据，无需考虑历史数据迁移的兼容性 / 滚动升级。这是做合表重构的最佳窗口；上生产后再做风险数倍上升。

## 1.1 为什么现在做

- 还未上生产 + 用户明示"现在还没上生产，不用担心历史数据问题"——一次性 drop 旧表 + 新建新表的硬切方案可行。
- RFC-059 per-question scope 即将落地，若先做 scope 再合表，相同 scope 字段要重写一次；先合表再做 scope，scope 字段只写一次。
- RFC-056 patch chain（2026-05-22 / 23 / 24 / 25）已稳定，cci 继承 / cascade clarify-only / freshness invariant 等关键 bug 都进了 main——重构前的"baseline 锁住行为"工作能基于稳定主干、不被实时 patch 干扰。
- 不做的代价：未来每加一种 Q&A 消费维度都要在两套 service 之间正确镜像一次；rate of漏写 = O(N) where N = "未来新 Q&A 维度数"。

## 1.2 不动哪些地方

- **不动** `<workflow-clarify>` envelope JSON schema：agent 输出协议 / questions 字段 / options 数量上限 / 互斥 envelope 错误码全部保持。
- **不动** NodeKind：`clarify` / `clarify-cross-agent` 两类节点继续并存、拓扑契约不变。
- **不动** workflow `$schema_version`：scope 是 runtime 数据、不进 workflow definition；本 RFC 也不引入新节点形态。
- **不动** RFC-039 ask-bias preamble / STOP CLARIFYING anchor 文案：reject 路径、submit 路径 prompt trailer 字节级保留。
- **不动** RFC-053 lifecycle 转移函数 / `transitionNodeRunStatus` / `setNodeRunStatus` / 7+1 条 invariant 规则（含 RFC-056 CR-1 abandoned 升级）。
- **不动** RFC-014 sibling cascade / RFC-042 in-attempt retry / RFC-026 inline session fallback 三套路径主体——它们与 clarify schema 解耦、本 RFC 仅在 service 入口处合并、调用 cascade helper 的语义保持。
- **不动** 任何**产品行为**——本 RFC 是纯重构。唯一新增的行为是反问者侧 GENERAL aging 规则的补齐（fix gap）；其余 RFC-023 + RFC-056 + patch chain 的 60-80 条用户可观察行为**字节级守恒**。
- **不动** per-question scope 特性——本 RFC 显式将该特性推迟到 RFC-059，待本 RFC 落地后在合并后的统一地基上做。
- **不动** REST 路由路径名（`/api/clarify` 系列），仅响应 body shape 切单一 ClarifyRound + kind 字段。
- **不动** WS event 名（`clarify.created` / `cross-clarify.*` 等），暂保留两套并存——本 RFC 只合并存储 + service 层；event 合并留给 follow-up（前端 invalidation 习惯按 self / cross 分支，强行合并 event 会过度扩大改动面）。

## 2. 目标

### 2.1 做

1. **新表 `clarify_rounds`**：合并 `clarify_sessions` + `cross_clarify_sessions` 的字段，统一存储 self-clarify 与 cross-clarify 两类 Q&A 轮次。字段集详见 [design.md §2](./design.md)；核心：`kind: 'self' | 'cross'` discriminator + `asking_node_id` / `intermediary_node_id` / `target_consumer_node_id` 三个 nullable / kind-conditional 字段映射两种语义。

2. **migration 0031（硬切）**：
   - 建 `clarify_rounds` 表 + 索引。
   - `INSERT INTO clarify_rounds SELECT ... FROM clarify_sessions WITH kind='self', field mapping ...`。
   - `INSERT INTO clarify_rounds SELECT ... FROM cross_clarify_sessions WITH kind='cross', field mapping ...`。
   - 校验行数：`(SELECT COUNT(*) FROM clarify_sessions) + (SELECT COUNT(*) FROM cross_clarify_sessions) === (SELECT COUNT(*) FROM clarify_rounds)`。
   - `DROP TABLE clarify_sessions; DROP TABLE cross_clarify_sessions`。
   - migration test 覆盖：空库 / 仅 self 行 / 仅 cross 行 / 两类混合 / 字段值字节级映射。

3. **shared 类型重命名**：`ClarifySession` → `ClarifyRound`（kind='self'）、`CrossClarifySession` → `ClarifyRound`（kind='cross'）。两个 Summary 类型也合并为 `ClarifyRoundSummary`。`ClarifyInboxEntry` discriminated union 简化为 `ClarifyRound` 自带 `kind`。原命名在 RFC-058 落地后**完全消失**——前端 routes / hooks / fixture 共 ~12 处一并更新。

4. **service 合并**：`services/clarify.ts` + `services/crossClarify.ts` → 单一 `services/clarify.ts`（旧 cross 模块 delete）。公共原语抽出：
   - `computeHistoryCutoff(args)`：所有 Q&A 注入路径的唯一 cutoff 计算入口；接受 `iterationField: 'clarifyIteration' | 'crossClarifyIteration'` 参数支持两种 cci 维度。
   - `applyAgingCutoff(rows, cutoff)`：纯函数，把 `rows.filter(r => r.iteration >= cutoff)` 提到一处。
   - `buildPromptContext(args)`：合并 `buildClarifyPromptContext` + `buildQuestionerCrossClarifyContext` 内部分支 by kind；外部调用者 scheduler.ts 不再分两条路径。
   - `submitClarifyAnswers(args)`：合并 `submitClarifyAnswers`（self）+ `submitCrossClarifyAnswers`（cross）；按 kind 分支处理 directive='continue' / 'stop' 与 designer rerun / questioner cascade 等下游动作。

5. **GENERAL aging 规则单一入口 + 反问者侧两个 RFC-056 缺口一并修复**：scheduler.ts:1347-1405 那段 inline cutoff 计算逻辑搬到 `computeHistoryCutoff` 函数体内；scheduler 调用变成 1 行 `const cutoff = await computeHistoryCutoff({...})`。两种 kind（self / cross）都从这一入口取 cutoff——**两个 RFC-056 缺口作为合并的自然结果一并修复**：
   - **缺口 1（aging gap）**：`buildQuestionerCrossClarifyContext` 不接 cutoff → cross-clarify 反问者 cci > 0 cascade rerun 仍全量塞历史 Q&A（违反 scheduler.ts:1347 自承"GENERAL rule"）。
   - **缺口 2（wrapper-loop loop_iter gap）**：`buildQuestionerCrossClarifyContext` WHERE 缺 `loop_iter` 过滤 → wrapper-loop 内 iter ≥ 2 反问者会看到上 iter 的 Q&A（违反 RFC-056 design.md §5 文档"Q&A 历史每 iter 复位（按 loop_iter 维度隔离）"）。
   两处都在新 `buildPromptContext` 内统一处理：cutoff 由 `computeHistoryCutoff` 提供、`loop_iter` 由 caller 传入并加入 WHERE。**不能再"忘记接"——因为只有一处入口**。

6. **wire 单一 shape**：`/api/clarify` GET 返回 `ClarifyRound[]`（含 kind）；POST `/api/clarify/:nodeRunId/answers` 接受单一 `SubmitClarifyAnswers` body。前端 `clarify.tsx` / `clarify.detail.tsx` 重写按 `entry.kind` 分支，删掉 `ClarifyInboxEntry` discriminated union 包装。

7. **baseline 测试加固（PR-A，PR-B 前置必须）**：把 RFC-023 self-clarify + RFC-056 cross-clarify + 4 个 RFC-056 patch 当前真实行为**全部字节级 / 行为级锁住**：
   - envelope 解析（self / cross 两路径、问题数 5 vs 1+、互斥 envelope）
   - session 创建（self 单源 + agent-multi shard / cross 单源 / 多源 / loop_iter / iteration 累计）
   - submit / reject（directive、ifMatchIteration、reject 跨轮持久 / abandoned 升级）
   - prompt 注入（self multi-round + inline + cutoff + directive trailer / cross designer External Feedback + Prior Output + Update Directive / cross questioner 全量历史注入 / ask-bias preamble）
   - 状态机（awaiting_human → answered / abandoned / canceled、cci 继承、cascade reset、freshness invariant）
   - REST / WS（mixed inbox、self/cross chip、4 个 cross-clarify WS event、self clarify.* event）
   - RFC-056 4 个 patch 各自 lock 的行为
   - 估计 ≥ 60 case，分布：shared 8 + backend 45 + frontend 7。

8. **PR-B 回归判据**：PR-A 的 60+ case 在 PR-B 重构完成后**零字节 diff**（除明确允许的"反问者侧 aging gap 修复" 1-2 case 由 fail 变 pass）。任何意外退化的 case 触发返工。

9. **前端 routes / hooks / fixture 更新**：~12 处 callsite 切到 `ClarifyRound` + `kind` 单 shape；测试 fixture 同步刷新。

10. **STATE.md / design/plan.md 索引** 完工后标 Done；本 RFC 与 RFC-059 索引行链接互通。

### 2.2 不做

- **不做** per-question scope 特性（推迟到 RFC-059，在合并后的地基上做）。本 RFC 完工后 RFC-059 可立即起 PR。
- **不做** 任何**产品行为**变更——所有 RFC-023 / RFC-056 用户可观察行为字节级守恒（唯一例外：反问者侧 aging gap 修复——这是 fix，不是新行为）。
- **不做** WS event 合并：`clarify.created` / `clarify.answered` / `cross-clarify.created` 等保留，前端 invalidation 路径按既有 channel 订阅；未来若有诉求合并，单独 RFC。
- **不做** agent-multi 在 cross-clarify 路径的支持（RFC-056 v1 限定 agent-single 的约束保留）。
- **不做** 引入 `kind='both'` 或新 NodeKind——本 RFC 是表与 service 的合并，不是节点拓扑变更。
- **不做** RFC-053 invariant 改动；CR-1 abandoned 升级在合并表上自然适配（查询条件改 `WHERE kind='cross' AND ...`）。
- **不做** wrapper-loop / RFC-014 cascade / RFC-026 inline / RFC-039 ask-bias / RFC-042 in-attempt retry 各自主体路径改动。
- **不做** YAML 导入 / 导出携带 clarify_rounds 数据（与 RFC-056 一致，clarify session 数据绑 task runtime）。
- **不做** 滚动升级 / 双写双读期：硬切方案（drop 旧表 + insert into 新表）一次到位。理由：未上生产、`bun install` 重新 migrate 即可。

## 3. 用户故事

> 全部用户故事的核心断言：**用户视角行为与 RFC-058 上线前完全一致，且对应 prompt / API / UI 输出字节级守恒**。仅 S6 的 cross-clarify 反问者侧 aging gap 修复是新引入的、可观察的行为差异。

**S1（self-clarify happy path，byte-level 守恒）**

`input → agent A → review`。Agent A 第一轮跑出 `<workflow-clarify>` envelope 3 题 → 进 awaiting_human → 用户答题 + submit → A 第二轮重跑、prompt 含 `## Clarify Q&A` + `## Self Clarify Q&A`（与 RFC-058 上线前**字节完全一致**） → A 跑出 `<workflow-output>` → review approve → task done。

**S2（cross-clarify happy path，byte-level 守恒）**

`input → designer → questioner → review`。questioner 跑出 cross-clarify envelope → 进 cross-clarify 节点 awaiting_human → 用户 submit → designer 重跑（prompt 含 `## External Feedback` + `## Prior Output (to be updated)` + `## Update Directive`，与 RFC-058 上线前**字节完全一致**）→ cascade questioner → questioner 第二轮 output → review approve → task done。

**S3（cross-clarify reject 持久，byte-level 守恒）**

用户 reject → directive='stop' 持久 → questioner cascade rerun prompt 含 `## User directive: STOP CLARIFYING` + 全量历史 Q&A（与 RFC-058 上线前**字节完全一致**）。后续 cross-clarify 节点 cascade reset 时仍走持久 stop 跳过 awaiting_human。

**S4（multi-source designer rerun，byte-level 守恒）**

2 个 cross-clarify 节点指向同一 designer，submit 第一个后 banner 提示等待、submit 第二个后触发 designer 一次重跑、External Feedback 含两 source 字典序子段（与 RFC-058 上线前**字节完全一致**）。

**S5（wrapper-loop 部分持久，byte-level 守恒）**

loop iter 1 reject → iter 2 questioner 仍带 STOP CLARIFYING；iter 2 起始时 Q&A 历史按 loop_iter 复位、cross_clarify_iteration 重计——所有边界条件与 RFC-058 上线前**字节完全一致**。

**S6（反问者侧 aging gap 修复，新可观察行为）**

工作流 `input → designer → questioner → cross(cross-clarify) → review`，cross-clarify 已经经历过一轮（cci=1）反问 + submit + designer rerun + questioner rerun（cci=1）成功 output → review 点 iterate → cascade reset 触达 questioner（cci=2 新行）。

- **RFC-058 上线前**：questioner cci=2 prompt 含**iteration=0 那轮的全部 Q&A**（即 cci=1 时已经消化进 output 的内容被重新塞回）→ 浪费 token + 可能让反问者重复 review 已 resolved 决策。
- **RFC-058 上线后**：questioner cci=2 prompt 不再含 iteration=0 那轮的 Q&A（被 `computeHistoryCutoff` 过滤）。这是 scheduler.ts:1347 注释 "GENERAL rule" 本就应该生效的行为，被本 RFC 补齐。

C 守门测试 `cross-clarify-questioner-aging.test.ts` 锁定此行为。

**S6b（wrapper-loop loop_iter 复位修复，新可观察行为）**

工作流 `input → wrapper-loop[ designer → questioner → cross(cross-clarify) ](max_iterations=3) → review`。loop iter 1：questioner 反问 → 人 submit Q&A1 → designer rerun → questioner rerun → output。loop iter 1 结束。loop iter 2 开始：questioner 重新跑（cci 重新计、loop_iter=2）。

- **RFC-058 上线前**：iter 2 反问者 prompt 含 iter 1 的全部 Q&A1（违反 RFC-056 design §5 "Q&A 历史每 iter 复位"）→ 反问者错误地基于 iter 1 决策做 iter 2 判断。
- **RFC-058 上线后**：iter 2 反问者 prompt 不含 iter 1 的 Q&A1（合并后 `buildPromptContext` WHERE 含 `loop_iter` 过滤）。每 iter 反问者从 0 Q&A 开始。

C 守门测试 `cross-clarify-loop-iter-isolation.test.ts` 锁定此行为。

**S7（前端 inbox 切单 shape，byte-level 守恒）**

用户访问 `/clarify` 列表 → 看到 mixed self + cross 摘要、chip 标识、点击进详情页 → 路由按 `entry.kind` 分支渲染（与 RFC-058 上线前 UI 视觉完全一致）。底层 wire 已从两 shape 切换为单 `ClarifyRound`、但用户感知零差异。

**S8（migration 0031 硬切验证）**

新建任意 task → 触发 self-clarify + cross-clarify 各一轮 → 关 daemon → 强制重跑 migration 0031 → 旧表 drop / 新表 insert → 启 daemon → 所有 inbox / 详情 / submit / agent rerun 行为字节级一致。

## 4. 验收标准

### 功能

- **A1（self-clarify byte-level）**：RFC-023 完整 happy path 在 PR-B 后 prompt / API / UI 输出字节级与 PR-A baseline 一致。
- **A2（cross-clarify byte-level）**：RFC-056 完整 happy path 同样字节级一致。
- **A3（cross-clarify reject byte-level）**：RFC-056 reject 路径字节级一致。
- **A4（multi-source byte-level）**：多源 designer rerun External Feedback 拼接字节级一致。
- **A5（wrapper-loop byte-level）**：loop iter Q&A 复位 / reject 持久行为字节级一致。
- **A6（反问者侧 aging gap 修复）**：cross-clarify 反问者 cci=N+1 cascade rerun prompt 不再含 cci < N 已被消化轮的 Q&A；C 守门测试断言。
- **A6b（wrapper-loop loop_iter 复位修复）**：wrapper-loop 内 iter ≥ 2 反问者 prompt 不再含 iter < current 的 Q&A；C 守门测试断言。
- **A7（migration 0031 硬切）**：迁移上行 + 验证脚本 + 旧表 drop 单测全绿。
- **A8（service 合并）**：`services/crossClarify.ts` 删除；`services/clarify.ts` 接管两类 kind；`buildPromptContext` 内部按 kind 分支。
- **A9（aging GENERAL 单一入口）**：源代码层 grep 守门：`computeHistoryCutoff` 在 `scheduler.ts` / `services/clarify.ts` 调用计数 ≥ 1；旧 inline 实现 grep 不到。
- **A10（前端单 wire shape）**：源代码层守门：`ClarifySession` / `CrossClarifySession` / `ClarifyInboxEntry` / `CrossClarifySessionSummary` 等旧类型名 grep 不到（除 RFC-059 占位文档外）；新 `ClarifyRound` / `ClarifyRoundSummary` 在前端 routes / hooks 共 ≥ 10 处引用。
- **A11（前端 12 处 callsite）**：路由 `clarify.tsx` / `clarify.detail.tsx` + hooks `useClarifyWs.ts` / fixture 共 12 处全部切单 shape；vitest 套件全绿。
- **A12（PR-A baseline 全绿 + PR-B 零回归）**：PR-A 60+ case 在 PR-B 后字节级 diff = 0（A6 1-2 case 例外、由 fail 变 pass）。
- **A13（RFC-053 invariant 适配）**：CR-1 abandoned 升级 invariant 在新表 `clarify_rounds WHERE kind='cross'` 上仍正确扫；测试覆盖。
- **A14（WS event 不动）**：`clarify.created` / `cross-clarify.*` 4+ event 名保留；前端订阅 / invalidation 路径零改动。
- **A15（per-question scope 隔离）**：RFC-059 占位目录 `design/RFC-059-cross-clarify-question-scope/` 完整存在；其 proposal.md 顶部 Blocked-by-RFC-058 banner 与时间戳正确。

### 非功能

- **B1** `bun run typecheck && bun run test && bun run format:check` 全绿。
- **B2** PR-A baseline tests 60+ case 在 PR-A 单独跑全绿；PR-B 后字节级 diff = 0。
- **B3** 整体 backend tests ≥ +50（PR-A baseline 45 + PR-B 新增 aging C 守门 + migration 0031 + service 合并断言 5+）；shared ≥ +8（baseline + 类型重命名）。
- **B4** 整体 frontend tests ≥ +7（PR-A baseline 7 + 0 新增——前端不引入新组件、仅 callsite 切换）。
- **B5** Playwright e2e 不增量：已有 RFC-056 `cross-clarify.spec.ts` + RFC-023 self-clarify e2e（如存在）继续守门；PR-B 后保持全绿。
- **B6** 单二进制构建包体积下降（旧 cross 模块 + 旧表 schema 删后预估净 -50KB）；启动时间不退化。

### 回归防护

- **C1（self-clarify byte-level 字节守门，面向用户层）**：`packages/backend/tests/clarify-rfc058-bytelevel.test.ts`——构造 RFC-023 完整 happy + reject + multi-round + inline + cutoff + ask-bias 各场景，**字节级守门面向用户层** = prompt 文本 / REST response body / WS event payload / 面向用户 error code 与 message。**行为级守门** = console.log 内容 / 内部函数 var 名 / SQL 查询顺序（结果集相同即可）/ 内部 TypeScript 实现细节——允许 PR-B refactor 微调，不进字节 diff 范围。
- **C2（cross-clarify byte-level 字节守门，面向用户层）**：`packages/backend/tests/cross-clarify-rfc058-bytelevel.test.ts`——构造 RFC-056 完整 happy + reject + multi-source + wrapper-loop + abandoned + 4 个 RFC-056 patch 各场景，与 C1 同分层规则：面向用户层字节级、内部行为级允许微调。
- **C3（反问者侧 aging gap 修复）**：`packages/backend/tests/cross-clarify-questioner-aging.test.ts`——构造 cci=1 done + outputs / cci=2 cascade rerun 场景，断言 cci=2 prompt 不含 cci < 1 轮的 Q&A；幂等性扫描两次行为一致。
- **C4（aging 单一入口 grep 守门）**：`packages/backend/tests/aging-single-source.test.ts`——源代码层 grep：`computeHistoryCutoff` 在 `services/clarify.ts` / `scheduler.ts` 调用 ≥ 1 次；旧 inline 模式 grep 不到（`historyCutoffClarifyIteration =` 在 scheduler.ts 不再 inline 计算）。
- **C5（migration 0031 hard-cut 守门）**：`packages/backend/tests/migration-0031-clarify-rounds.test.ts`——空库 / self only / cross only / mixed 四类 case + 行数校验 + 字段映射断言 + 旧表 drop 确认 + **DB CHECK 约束违反 case**（kind='self' + status='abandoned' INSERT 抛错；kind='cross' + status='canceled' INSERT 抛错）。
- **C6（wrapper-loop loop_iter 隔离修复）**：`packages/backend/tests/cross-clarify-loop-iter-isolation.test.ts`——wrapper-loop 内构造 iter 1 反问 + submit + 完成、iter 2 反问者 cascade rerun → 断言 iter 2 prompt 不含 iter 1 的 Q&A；与 RFC-056 设计文档 §5 "Q&A 历史每 iter 复位" 承诺一致。

## 5. 关键技术选型理由

1. **合表 vs 保持两表 + 共享 helper**：选**合表**。理由：用户明示"现在还没上生产、不用担心历史数据问题" + 共享 helper 方案仍要长期维护两份 schema / 两份 service / 两份前端 DTO 的镜像同步、长期复杂度成本仍在。合表一次到位、永久消除双写镜像。
2. **新表名 `clarify_rounds` vs 保留 `clarify_sessions`**：选**新名**（用户决定）。理由："rounds" 与 "iteration / Round N" 语义对仗、强调单条 = 一轮反问问答；保留旧名会偷偷扩展旧表语义、git blame 易混淆。
3. **wire 单 shape vs facade 维持两 DTO**：选**单 shape `ClarifyRound + kind`**（用户决定）。理由：彻底统一、未来 RFC-059 per-question scope 只对接一个 shape；前端 12 处 callsite 改动有测试守门、风险可控。
4. **硬切 migration vs 双写双读期**：选**硬切**。理由：未上生产、不存在用户态 / 滚动升级压力；硬切代码量小、回滚清晰（revert migration commit）。
5. **PR 拆分：baseline 先 + 重构后 vs 一锅炖**：选**两 PR 强序**。理由：PR-A baseline 单独 push CI 全绿 + 用户验证再启 PR-B；PR-B 任何意外退化能从 PR-A 锁住的 case 立刻发现 + 定位精准（diff 限定在重构范围）。同 RFC-053 PR-A 加固后再重构的成功模式。
6. **per-question scope 同步做 vs 分 RFC-059**：选**分**（用户决定）。理由：RFC-058 范围越收敛越好、重构 PR 混新特性容易掩盖回归 + 评审更长；RFC-059 在合并后的单 service / 单 wire 上做、改动量预估反而更小（之前两边镜像现在只一边）。
7. **WS event 是否同步合并**：选**不合并**。理由：前端 invalidation 路径按既有 channel 订阅、event 名是公开契约、合并会扩大改动面 + 影响监控 / 调试工具。未来若有合并诉求单独 RFC（譬如统一 `clarify.round.created`）。

## 6. 与其它 RFC 的关系

- **RFC-023 self-clarify**：本 RFC 把 `clarify_sessions` 表合并入 `clarify_rounds`、`buildClarifyPromptContext` 合并入 `buildPromptContext`。**所有用户可观察行为字节级守恒**（PR-A 60+ case 锁定）；类型 `ClarifySession` → `ClarifyRound` 重命名、前端 callsite 更新。
- **RFC-026 inline session mode**：sessionMode 字段从原 `clarify_sessions` 列保留迁移到 `clarify_rounds.session_mode`；inline fallback / `inline-clarify-fallback-to-isolated` warning code 字节级保留。
- **RFC-039 ask-bias preamble + STOP CLARIFYING**：anchor 文案、appendTrailer 路径字节级保留；trailer 在 `buildPromptContext` 内按 kind / directive 分支调用，与旧路径一致。
- **RFC-053 lifecycle hardening + CR-1 invariant**：abandoned 升级 invariant 查询条件从 `cross_clarify_sessions` 改 `clarify_rounds WHERE kind='cross'`；其余 invariant R1/R2/C1/T1/T2/T3/U1 与 clarify schema 无关、零改动。
- **RFC-056 cross-clarify + 4 patch**：本 RFC 的直接重构对象。所有 cross-clarify 功能（cross_clarify_iteration / cascade clarify-only / freshness invariant / cci 继承 / multi-source aggregation / abandoned / wrapper-loop partial persistence）的当前行为全部进 PR-A baseline 锁住。**唯一行为变更**：cross-clarify questioner cascade rerun aging gap 修复（C3 守门）。
- **RFC-014 sibling cascade**：cascade reset 走同一 helper、调用形态不变；本 RFC 只重构调用者一侧（合并 service）。
- **RFC-042 in-attempt retry**：cci 继承机制（patch-2026-05-24 引入的 `inheritedCrossClarifyIteration` → `insertNodeRun` inherit 参数）保留；retry 路径字节级守恒。
- **RFC-059 per-question scope**：本 RFC 的直接后置者。RFC-059 占位文档在本 RFC 落地前不进入实施；落地后 RFC-059 在合并后的单一 service + 单 wire shape 上做、改动量比并行表方案小。

## 7. 风险

| 风险 | 评估 | 缓解 |
|---|---|---|
| PR-A baseline 没覆盖到某个 RFC-056 patch 隐含行为 → PR-B 退化但 PR-A 没抓到 | 中：4 个 patch 都涉及微妙 cci / cascade / clarify-only 行为 | 逐 patch 抽 1-2 case 入 baseline；PR-B push 时跑全 baseline + RFC-056 既有套件双重防护 |
| migration 0031 硬切后某行字段映射写错（譬如 cross 行 `loop_iter` 漏写） | 中：手写 INSERT 映射易疏忽 | migration test 5 case 覆盖每类字段；行数 + 抽样字段断言 |
| 前端 12 处 callsite 改动遗漏 1 处 → TypeScript 编译过、运行时 undefined access | 低：TS strict 模式 + 旧类型名删除后引用立即报错 | 删除 `ClarifySession` / `CrossClarifySession` 类型 export 后 typecheck 不绿即不能 merge；vitest 全跑 |
| RFC-053 CR-1 invariant 查询条件改完后扫描行为变化 | 低：查询语义不变，仅表名 / WHERE 字段改 | C5 守门 + RFC-053 invariant 既有套件零退化 |
| 反问者侧 aging gap 修复后某真实工作流意外 prompt 变短 → agent 行为变化 | 低：aging 只丢"已 baked into prior output"的 Q&A、prior output 本身仍在 prompt 里、信息无损 | C3 守门覆盖 + S6 故事文档清晰阐述 |
| `services/crossClarify.ts` 删除时漏删某个 export 被外部引用 | 低：grep 守门 + typecheck | 删除前 grep `from.*services/crossClarify` 应只有内部引用；删除后跑全套 |
| WS event 名保留但内部 broadcaster 函数合并出错 → event 字段缺失 | 低：broadcaster 函数签名变化 typescript 立刻报错 | broadcaster 单测覆盖 4+ event 字段完整性 |
| RFC-059 在 RFC-058 落地前误开 PR | 极低：banner 明确 + 索引 Blocked-by 标识 | 占位 banner + STATE.md / 索引双重提示 |

## 8. 后续可能的延展（v1 不做）

- WS event 合并：`clarify.round.*` 统一 schema、前端按 kind 字段分发 invalidation。
- agent-multi 在 cross-clarify 路径的支持（patch RFC-056 v1 限制）。
- clarify_rounds 表上加 timestamp 维度精细 aging（譬如"X 分钟前的 Q&A 视为过期"）。
- inbox 跨 kind 聚合统计 / 用户级 audit log。
- per-question scope（RFC-059）落地。
