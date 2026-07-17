# RFC-203 错误呈现统一层（design）

> 先读 `proposal.md`。锚点核对于 2026-07-17 HEAD（`25065cf0`）；数据来自同日全量盘点（399 构造码 / 21 已映射 / 247 details 点 / 84 校验 issue 码）。

## 0. 现状事实（盘点结论）

1. **单一真源已存在但能力不足**：`describeApiError`（`packages/frontend/src/i18n/index.ts:54-63`）只做 `errors.<code>` 查表 + `fallback: <原文>` 拼接；不读 `ApiError.details`、不传插值、对非 ApiError 走 `err.message`。
2. **ApiError 归一缺口**：`api/client.ts` 的 `extractErrorBody`（:87-119）处理扁平/嵌套/HTTP 兜底三形状，但 fetch 抛的 `TypeError`（:51）不经归一直接冒泡（「Failed to fetch」直出根因）；WS upgrade 拒绝是嵌套体 + 纯文本 426。
3. **三个手写样板**（统一层要收敛的语义）：
   - `TaskQuestionList.tsx:107-116` `DISPATCH_ERROR_KEYS`：code→局部 key 覆盖 + `details.nodeId` 插值（:208-214）；
   - `workflows.edit.tsx:871-894`：code 判定 + details 结构解析渲染为 ErrorBanner 的 action（RFC-202 先例）;
   - `RecoverySection.tsx:61-65` `describeRecoveryKind`：key-shadows-code + 缺键回退裸 code。
4. **分叉**：6 处字节级相同私有 `describeError`（Onboarding:199 / NodeDetailDrawer:615 / BatchImportDialog:473 / FilesPicker:191 / settings:1983 / workflows.edit:1132）；22 处裸 `.error-box`（workgroup 面 8 处、home 面 3 处最密集）。
5. **failureCode 管线断头**：`FAILURE_CODES` 7 值（`shared/schemas/task.ts:703-723`）；runner 8 个写入点；`NodeRunSchema`（:769-908）无该字段、`getTaskNodeRuns`（`task.ts:3039-3118`）不映射、前端 grep 零命中。
6. **errorSummary 展示面**（RFC-201 后行号）：`tasks.detail.tsx:601-611`（横幅 summary+`<pre>` message）、`:934-937`（meta 表）、`tasks.tsx:320-326`（列表）、`NodeDetailDrawer.tsx:428-431`、`DynamicWorkflowPanel.tsx:183-184`。
7. **词条真源**：`zh-CN.ts` 顶层 `errors:`（@6417，`Record<string,string>`——加码不需要动 interface）31 键；5 个孤儿键（skill-source-\*）。Tier-2 wire 码 ~13；Tier-3 校验 issue 码 84（`workflow.validator.ts`，前端零映射）。
8. **details 9 形状 247 点**：`{issues}`×86、`{stderr}`×15、权限对×7、OCC 版本对×7、`{availableRefs}`×4、`{referencedBy}`×4、`{scheduledTaskIds}`×4、`{taskIds}`×2、其余定位单键。
9. **非统一体**：`tasks.ts:308`、`plantuml.ts:31/36/39`、`ws/server.ts:93/100/121/134`（嵌套）+ `:149`（纯文本 426）。

## 1. 架构

```
                    ┌────────────────────────────────────────┐
  ApiError/TypeError│  resolveApiError(err, opts?)           │ i18n/errors.ts (新)
  /unknown ────────▶│  1. normalize: TypeError→network-      │
                    │     unreachable; 非ApiError→wrap       │
                    │  2. 局部覆盖: opts.overrides[code]     │
                    │  3. L1 精确: errors.<code>             │
                    │  4. L2 域级: errors.domain.<prefix>    │
                    │  5. L3 全局: errors.fallback（不拼原文）│
                    │  → { title, hint?, raw?, details }     │
                    └────────────────────────────────────────┘
                                     │
                    ┌────────────────▼───────────────────────┐
                    │  <ErrorBanner error={e} overrides={}>  │
                    │  title 行 + hint 行                     │
                    │  + <ErrorDetails details={e.details}>  │ 已知形状富渲染
                    │  + raw 原文 <details> 折叠              │
                    └────────────────────────────────────────┘
```

### T1 解析器 `resolveApiError`（新文件 `src/i18n/errors.ts`）

- 返回 `ResolvedApiError { title: string; hint?: string; raw?: string; code?: string; details?: unknown }`。
- **归一**：`TypeError`（fetch 网络错）→ 合成 code `network-unreachable`；非 Error/未知 → `String(err)` 作 raw + L3。`extractErrorBody`（client.ts）同步收编 WS 嵌套 `{error:{code,message}}`（现有防御分支保留）。
- **查表顺序**：`opts.overrides?.[code]`（调用方局部覆盖，吸收 DISPATCH_ERROR_KEYS 语义）→ `errors.<code>`→ `errors.domain.<domainOf(code)>` → `errors.fallback`。`domainOf` 是纯函数：code 前缀 → 19 域之一（`repo|git|worktree|iso|path|snapshot|working-branch|batch|...`→`repo` 等；映射表与测试同源）。
- **插值**：词条统一走 i18next 插值；`resolveApiError` 把 `details` 里的**白名单标量**（count/name/ref/nodeId…）注入插值上下文（防注入：只取 string/number，长度截断）。
- **hint 词条对**：约定 `errors.<code>` 为标题、`errors.<code>__hint` 为下一步指引（可缺省）——避免为 hint 另开 interface 结构。
- `describeApiError` 保留为 `resolveApiError(err).title`（+ raw 时拼接维持兼容？**不**——改为纯 title，存量断言按新契约更新；盘点显示依赖拼接行为的只有测试）。
- **key-shadows-code helper**：`labelForCode(t, keyPrefix, code)`（describeRecoveryKind 语义提为公共函数），RecoverySection / StuckTaskBanner 迁移。

### T2 ErrorBanner 富渲染

- `ErrorBanner` props 增 `overrides?: Record<string,string>`；内部改用 `resolveApiError`。
- 新子组件 `ErrorDetails`（`components/ErrorDetails.tsx`）：按形状渲染——
  - `{issues: ZodIssue[]}` → 前 N 条 `path: message` 列表（N=5，超出计数）；
  - `{issues: WorkflowValidationIssue[]}` → issue.code 走 T4 的校验词条层；
  - `{referencedBy}` / `{scheduledTaskIds|visibleScheduled+hiddenCount}` / `{taskIds}` → 名单/计数行（RFC-202 workflows.edit 的实现迁入此处并删除局部版）；
  - `{availableRefs}` → 「可用分支：a、b、c」；
  - `{expectedVersion,currentVersion}` → 「本地 vX / 服务器 vY，请刷新」；
  - `{stderr}` / raw → `<details>` 折叠 `<pre>`（等宽、截断 4KB）。
  - 未知形状：不渲染（安全跳过）。
- 22 处裸 `.error-box` 分两批迁 ErrorBanner（workgroup 面 8 处 + home 面 3 处优先，其余 11 处随批）；迁移以「视觉零回归」为准（error-box class 由 ErrorBanner 透传保留）。

### T3 词条分层（`zh-CN.ts` / `en-US.ts` 顶层 errors 表，Record 类型免动 interface）

- **L1 精确 ≥150 码**：按域批量，优先级 = 用户可触发频度：task(19) + task-question(23) + clarify(19) + review(17) + workflow(23) + upload(12) + schedule(7) + runtime(15) + mcp(10) + plugin(12) + agent(14) + skill(28) 全量精确；repo/git 域 68 码取用户可触发子集（clone/ref/url/worktree-missing/push 类 ~25）精确、其余走域兜底；auth 域 33 取登录/权限/改密 ~12 精确。文案铁律：一句「发生了什么」（用户语言）+ 可选 `__hint`「下一步」。
- **L2 域级 19 条**：`errors.domain.repo` =「仓库操作失败」等；`resolveApiError` 兜底时 title=域模板，raw=英文原文进折叠。
- **L3**：`fallback` 改「请求失败」（原文不再拼进标题）。
- **Tier-2 wire 码**（route-not-found/oidc-\*/opencode-models-failed/resume-failed/ws 四码）全部 L1。
- **Tier-3 校验 issue 码**：新表 `validation.<issueCode>`（同为 Record）：常见 ~40 精确（wrapper-_/edge-_/input-_/prompt-template-_/clarify-no-iteration-cap…），其余走前缀族兜底 `validation.family.<prefix>`；校验面板（workflows.edit ValidationPanel）与 ErrorDetails 的 issues 分支共用一个 `describeValidationIssue(t, issue)` helper。
- 清理 5 个孤儿键；**词条完整性测试**：zh/en 键集 diff 为空 + L2 19 域齐全。

### T4 failureCode 端到端 + errorSummary 影射

- shared：`NodeRunSchema` 增 `failureCode: FailureCodeSchema.nullable().optional()`；backend `getTaskNodeRuns` 映射该列（一行）。
- 前端：`lib/task-failure.ts` 新纯函数 `describeTaskFailure({failureCode, errorSummary, errorMessage}, t)` →
  1. failureCode 命中 → `tasks.failure.<code>`（7 值全映射，含下一步：恢复/重试指引）；
  2. errorSummary 命中影射表 `tasks.failure.summary.<token>`（≥12 已知令牌：snapshot-lost / snapshot-invalid / live-child-survived / child-unkillable / node-timeout 前缀 / scheduler error / scheduler stalled 前缀 / daemon-restart / orphan-reconcile / canceled by user / exited with code 前缀 / worktree creation failed 前缀——前缀类用 startsWith 匹配）；
  3. 兜底：域模板「任务执行失败」+ 原文折叠。
- 消费面改造：`tasks.detail.tsx:601-611` 横幅（title=映射文案，summary/message 原文全部进折叠）、`tasks.tsx:320-326` 列表红字（title 短形）、`NodeDetailDrawer.tsx:428-431`、`DynamicWorkflowPanel.tsx:183-184`、meta 表 `:934-937`。
- **不改**后端 errorSummary 写入（机器协议保持；`task-wizard.ts:338` 有对英文前缀的逻辑依赖，动写入面风险大——影射只在展示层）。

### T5 分叉清零

- 6 处私有 `describeError` → `resolveApiError`（注意语义差：私有版输出 `code: message`——迁移后 title 本地化 + raw 折叠，消费点如 BatchImportDialog 的行内 message 列改 `resolveApiError(e).title`）。
- `DISPATCH_ERROR_KEYS` 改传 `overrides` 给统一层（词条不动，删除局部查表分支）；describeRecoveryKind → `labelForCode`。
- 源码锁：`grep 'function describeError'` 前端 0 命中；`.error-box` 直拼白名单锁。

### T6 非统一错误体收敛（backend）

- `tasks.ts:308` → `ValidationError('task-filter-invalid', ...)`（就近复用现有码）；
- `plantuml.ts:31/36/39` → DomainError 家族（`plantuml-source-too-large`/`plantuml-source-required` 进 L1 词条）；`:58` 的 200 判别式联合**不动**（源码注释声明故意）；
- `ws/server.ts` 四处 → 统一体 `{ok:false, code, message}`（消费方只有浏览器 devtools 与前端 WS 错误路径，前端 `extractErrorBody` 的嵌套防御分支保留一版本期兼容）；`:149` 纯文本 426 → 统一体。

## 2. 失败模式

- 词条缺失/漂移：L2 域兜底保证任何新码不裸奔英文；完整性测试锁 zh/en 同构。
- details 形状变化：ErrorDetails 对未知形状安全跳过（不炸不渲染），已知形状各有单测。
- 插值注入：details 值只取白名单标量并截断；不把用户可控长文本插入标题。
- 兼容：describeApiError 契约变化（不再拼原文）——盘点显示无逻辑依赖（唯一逻辑依赖 `task-wizard.ts:338` 在 backend，读的是 errorSummary 非本函数）；受影响的是文案断言类测试，按新契约更新并在 PR 说明。

## 3. 测试策略

**shared/前端单元**：resolveApiError 三级降级/归一/插值/覆盖（≥12 用例）；domainOf 全域映射表测试；ErrorDetails 6 形状 + 未知形状；describeTaskFailure 三级 + 前缀令牌；describeValidationIssue 精确/族兜底；词条完整性（zh/en diff、19 域齐、孤儿键零）。
**迁移回归**：BatchImportDialog / NodeDetailDrawer / settings / workflows.edit / FilesPicker / Onboarding 各一条断言新文案形态；TaskQuestionList overrides 语义保持（details.nodeId 插值用例照旧）。
**backend 路由**：tasks.ts/plantuml/ws 统一体形状测试。
**failureCode**：getTaskNodeRuns 透出 + schema 兼容（旧行 null）；横幅优先级（failureCode > summary 影射 > 兜底）。
**源码锁**：私有 describeError 零命中；error-box 白名单；`errors.fallback` 不再拼接原文。
**门槛**：全量 typecheck/lint/test/format + 前端 vitest + binary smoke（shared schema 变更）。

## 4. 兼容性

- API 无破坏（NodeRunSchema 加可选字段；错误体只收敛不改字段名）。
- 无 DB migration。
- 视觉基线：错误态不在 visual-regression 基线页的默认截图路径上（错误横幅需注入故障才出现）；`settings.png` 等基线页正常态不受词条影响——文案改动集中在 errors 表（仅错误态可见）。**例外排查**：迁移 `.error-box` 涉及 home 三处 role="alert" 空态错误行，确认其不在基线截图状态内（基线是正常数据态）。
