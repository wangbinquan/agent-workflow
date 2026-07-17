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
- **归一**：`TypeError`（fetch 网络错）→ 合成 code `network-unreachable`；非 Error/未知 → `String(err)` 作 raw + L3。`extractErrorBody`（client.ts）同步收编 WS 嵌套 `{error:{code,message}}`（现有防御分支保留）；【设计门 P2】非 JSON 错误响应（代理 502 纯文本等）读 capped `res.text()`（≤2KB）作 raw 携带——现状 payload=null 把唯一诊断信息丢光。
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
  - 引用清单族【设计门 P1×2 修正】：真实 payload 形状为 `{referencedBy}`（mcp/plugin 删除，值是 agent 名数组）、`{workflows:[{id,name}]}`（agent 被工作流引用）、`{agents:[...]}`（skill 被 agent 引用）、`{scheduledTaskIds}`（agent/workgroup 被定时引用）、`{visibleScheduled+hiddenCount}`（workflow，RFC-202 先例）、`{taskIds}`。**ACL 铁律**：只有 principal-aware 形状（visible[]+hiddenCount）可渲染名单；未脱敏的裸数组形状（referencedBy/scheduledTaskIds/workflows/agents 现状）只渲染**聚合计数**，绝不列名——T6 同批把这些后端抛点改造为 deleteWorkflow 同款可见性过滤形状后才升级为名单渲染（RFC-202 workflows.edit 局部实现迁入此处并删除）；
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
- **Tier-3 校验 issue 码**：新表 `validation.<issueCode>`（同为 Record）：常见 ~40 精确（wrapper-_/edge-_/input-_/prompt-template-_/clarify-no-iteration-cap…），其余走前缀族兜底 `validation.family.<prefix>`；校验面板（workflows.edit ValidationPanel）与 ErrorDetails 的 issues 分支共用一个 `describeValidationIssue(t, issue)` helper。【设计门 P2 修正】`WorkflowValidationIssue` 无结构化插值参数、部分码一码多文案变体（具体端口/kind 值只在英文 message 里）——v1 契约定为**词条=标题行、原始英文 message=同行折叠详情**（不丢定位信息）；给 issue DTO 加 params 属后端 84 抛点改造，列为后续增强不入本 RFC。
- 清理 5 个孤儿键；**词条完整性测试**：zh/en 键集 diff 为空 + L2 19 域齐全。

### T4 failureCode 端到端 + errorSummary 影射

- shared：`NodeRunSchema` 增 `failureCode: FailureCodeSchema.nullable().optional()`；backend `getTaskNodeRuns` 映射该列（一行）。
- **任务级投影（设计门 P1 修正）**：任务列表只有 `TaskSummary`、DynamicWorkflowPanel 只收 errorSummary——单加 NodeRun 字段喂不到这两个点。增确定性 failed-run oracle：`failedNodeFailureCode(runs)` = 按 `failedNodeId`（tasks 表已有）定位失败节点的 freshest top-level run（复用 `pickFreshestRun`）取其 failureCode；`Task`/`TaskSummary` schema 增可选 `failureCode`，`getTask`/`listTasks` 投影；DynamicWorkflowPanel props 增 `failureCode`。
- 前端：`lib/task-failure.ts` 新纯函数 `describeTaskFailure({failureCode, errorSummary, errorMessage}, t)` →
  1. failureCode 命中 → `tasks.failure.<code>`（7 值全映射，含下一步：恢复/重试指引）；
  2. errorSummary 命中影射表 `tasks.failure.summary.<token>`（≥12 已知令牌：snapshot-lost / snapshot-invalid / live-child-survived / child-unkillable / node-timeout 前缀 / scheduler error / scheduler stalled 前缀 / daemon-restart / orphan-reconcile / canceled by user / exited with code 前缀 / worktree creation failed 前缀 / **dw-generate-exhausted**（设计门 P2：接通既有 `workgroups.dw.exhausted` 死词条 + 面板专项测试）——前缀类用 startsWith 匹配）；
  3. 兜底：域模板「任务执行失败」+ 原文折叠。
- 消费面改造：`tasks.detail.tsx:601-611` 横幅（title=映射文案，summary/message 原文全部进折叠）、`tasks.tsx:320-326` 列表红字（title 短形）、`NodeDetailDrawer.tsx:428-431`、`DynamicWorkflowPanel.tsx:183-184`、meta 表 `:934-937`。
- **不改**后端 errorSummary 写入（机器协议保持；`task-wizard.ts:338` 有对英文前缀的逻辑依赖，动写入面风险大——影射只在展示层）。

### T5 分叉清零

- 6 处私有 `describeError` → `resolveApiError`（注意语义差：私有版输出 `code: message`——迁移后 title 本地化 + raw 折叠，消费点如 BatchImportDialog 的行内 message 列改 `resolveApiError(e).title`）。
- 【设计门 P1/P2 补充消费点】`DetailHeaderActions`（agents/skills 删除错误的实际渲染面，现为 string-only describeApiError）改走 ErrorBanner+ErrorDetails，否则引用清单形状永远到不了屏幕；`PlantUmlBlock.proxyRender` 的 catch 分支改经 resolveApiError 再入 buildErrorWithSource。
- `DISPATCH_ERROR_KEYS` 改传 `overrides` 给统一层（词条不动，删除局部查表分支）；describeRecoveryKind → `labelForCode`。
- 源码锁：`grep 'function describeError'` 前端 0 命中；`.error-box` 直拼白名单锁。

### T6 非统一错误体收敛（backend）

- `tasks.ts:308` → `ValidationError('call-target-method-required', ...)`【设计门 P2：该端点缺的是 call-targets 的 methodRef 参数，复用 task-filter-invalid 会给出无关指引】+ L1 词条；
- `plantuml.ts:31/36/39` → DomainError 家族（`plantuml-source-too-large`/`plantuml-source-required` 进 L1 词条）；`:58` 的 200 判别式联合**不动**（源码注释声明故意）；
- `ws/server.ts` 四处 → 统一体 `{ok:false, code, message}`（消费方只有浏览器 devtools 与前端 WS 错误路径，前端 `extractErrorBody` 的嵌套防御分支保留一版本期兼容）；`:149` 纯文本 426 → 统一体。

## 1.9 设计门折入记录（2026-07-17，Codex 4P1+5P2 全折入）

P1：引用清单 ACL 脱敏（未脱敏形状只渲染计数，后端抛点 T6 同批改造）；真实 payload 形状补全（{workflows}/{agents}）+ DetailHeaderActions 接入结构化渲染；failureCode 任务级投影（Task/TaskSummary + failed-run oracle）；PR-1 随行 L2 域模板防中间态诊断回归（见 plan.md）。P2：dw-generate-exhausted 令牌接通死词条；非 JSON body capped 保留；校验词条=标题+原文折叠（issue params 列后续增强）；PlantUmlBlock 接入；call-target-method-required 专用码。

## 1.10 PR-1 实现门折入记录（2026-07-17，Codex P2×4 + 随批收尾）

P2：**网络错误标签移到 fetch 边界**——resolver 按 `instanceof TypeError` 猜测会把应用层 TypeError 伪装成 daemon 离线，改为 api/client.ts `fetchOrNetworkError` 在请求边界抛 `ApiError(0,'network-unreachable')`（AbortError 原样放行），resolver 删除猜测分支；**非 JSON 错误体 capped 流式读取**——`cappedErrorText` 只读 ≤2KiB 即 cancel 流，超大代理错误页不再整体缓冲；**NodeDetailDrawer 只对 failed/exhausted 行本地化**——classifyCanceled 的 'manual' 臂也覆盖 canceled/interrupted，其 errorMessage 非失败令牌，走 describeTaskFailure 会误标「任务执行失败」，改按 status 分流；**dw-reject-exhausted 令牌接通**（workgroupTasks.ts 发射、影射表+zh/en 词条补齐）。随批收尾（fold 完成于仓库搬迁后的接续 session）：tasks.preview port-artifact 预览 queryFn 的裸 fetch 改走导出的 `fetchOrNetworkError`（其失败进 ErrorBanner→resolveApiError，唯一受 TypeError 分支删除影响的消费面；其余裸 fetch 站点为布尔标志/私有错误路径，PlantUmlBlock 留待 T5a 迁移时一并换）；resolver/测试头部过期注释同步；新增 client 边界测试 ×3 + 网络打标源级锁 ×3。

## 1.11 PR-2 落地记录（2026-07-17）

- **L1 全量超额**：302 基础键（12 全量域 + repo×29 / auth×25 子集 + Tier-2 wire 码全数 + http-4xx/5xx 家族）+ 27 个 `__hint`；skill 域含 `skill-quarantined`（SkillQuarantinedError 默认码，盘点漏项）。孤儿 `skill-source-*` ×5 已删。完整性测试锁 zh/en 键集同构 / ≥150 / hint 配对 / 19 域 / 风格铁律 / Tier-2 在位（`rfc203-l1-completeness.test.ts`）。
- **校验词条按 65 码全量精确**（现值；盘点期 84 → RFC 收敛后 65），高于 plan 的 ~40 —— 依「面向代码最合理优先于改动最小」偏好；族兜底 13 条 + 全局兜底防新码。测试直接读 `workflow.validator.ts` 源码提取全部 code 断言零漏（新码上线未配词条会红一条明确指引的测试）。
- **键布局备选**：`validation.issue.<code>` / `validation.family.<prefix>` / `validation.fallback`（design 原文 `validation.<issueCode>` 平铺会让 family 子对象与 `Record<string,string>` 类型冲突；嵌套三段是类型干净的等价变体）。
- **ErrorDetails issues 分支**按 exact/family 命中门控（zod issue 无 validation 词条命中，保持原 path+message 渲染，不误吞）。ValidationPanel 行 = code 徽标 + 本地化标题 + 原文 `<details>` 折叠（复用 `error-details__raw`）。
- **契约性断言更新**（PR 说明）：`repo-clone-failed`/`internal-error`/`workflow-version-conflict` 获得精确词条后，resolver 域兜底测试样例改用 `merge-tree-failed`（内部 plumbing，设计上留域兜底）与合成码；`workflow-import-dialog` 的 409 断言从「拼原文」改为精确词条句子。
- **status-0 回归修复**（随批，CI run 29555048439 rerun 的 e2e 抓到）：fetch 边界打标后，`useWorkflowEditorDraft.failureFromError` 把 `ApiError(status 0)` 误判为 `kind:'http'` 确定性失败，破坏 RFC-199 弱网「结局未知 → offline + reconcile」语义；修为 status 0 归 transport。单测新增真实打标形状注入；`rfc199-save-reliability.spec.ts` 本地 Chromium 5/5 复绿。教训已固化进用例注释：transport-loss 类单测必须用打标形状（ApiError status 0），不能只用裸 TypeError。

## 1.12 PR-2 实现门折入记录（2026-07-17，Codex 1P1+1P2 全折入）

- **P1 wizard 启动失败面升富横幅**：launch 的 `workflow-invalid` 带 `details.issues`（节点/边定位），tasks.new 的 footer `describeApiError` 字符串壳把它们全部丢掉——词条精确化后只剩「工作流内容不合法」一句。改为正文区 `<ErrorBanner>`（与版本冲突横幅同区，同类失败既有先例），issues 经 ErrorDetails→describeValidationIssue 渲染本地化行 + 定位原文；workgroup 分支保留 footer 专用友好文案（`workgroupLaunchErrorMessage`），`wizard-submit-error` testid 两分支互斥复用（既有锚点契约不变）。其余字符串壳面仍按计划归 PR-3 T5。
- **P2 ErrorDetails 校验行定位可及化**：原文（唯一 locator）从 hover-only `title` 属性改为 `error-details__raw` 折叠块（与 ValidationPanel 同构）——title 属性触屏/键盘/读屏都够不到。
- 测试：wizard 422 workflow-invalid 富渲染用例（role=alert + 本地化 issue 行 + 折叠原文可见）；ErrorDetails 校验行折叠块 + `li[title]` 零残留断言。

## 1.13 PR-3 落地记录（2026-07-17）

- **T5a**：6 处字节级相同私有 describeError 全部替换为公共 describeApiError；DetailHeaderActions 错误行升逐通道 ErrorBanner（删除引用清单 details 的屏幕入口，结构不变量「错误恒为 header 兄弟」保持，两处结构锁随迁）；PlantUmlBlock 直连回退链 3 fetch 打标 + 双展示点接 describeApiError；Onboarding 冗余 message prop 收敛。
- **T5b**：22 处裸 error-box 全数迁 ErrorBanner；NoticeBanner/ErrorBanner 最小扩展可选 testid prop（挂 banner 根），7 个既有测试锚点原样保留；home 三处 retry 按钮入 action 槽。全量 4783/4783 零涟漪。
- **T5c**：DISPATCH_ERROR_KEYS 收编为 ErrorBanner overrides（覆盖层胜精确词条保分面文案，raw 进折叠；RFC-133 nodeId→label 富化分支保留——label 查表非 overrides 能表达）；describeRecoveryKind/describeRule 两个 key-shadows-code 副本统一 labelForCode。三源码锁齐位：describeError 零命中 / error-box 白名单=ErrorBanner / fallback 不拼原文（`rfc203-fork-zero-source-lock`）。
- **T6 补課（PR-1 漏项勘误）**：PR-1 只落了「非统一体收敛」半截；本批把 8 个引用拒绝发射点（deleteAgent×3 + renameAgent×3 中的 workflows/dependsOn/schedule、deleteMcp、deletePlugin、deleteSkill、deleteWorkgroup+renameWorkgroup 的 schedule）全部改为 deleteWorkflow 先例的 principal-aware `{visible[]+hiddenCount}`。新公共原语 `resourceAcl.discloseRefsSync/discloseRefs/discloseScheduleRefs`（sync 版供 dbTxSync 守卫块用，grant 集在事务外预取——披露是展示控制而非拒绝判定，陈旧集无害）；service delete/rename 签名线程化 `actor`；finder 拓宽携带 acl 列。测试：`rfc203-refs-acl.test.ts` 三面（agent-in-use 私有工作流不泄名 / mcp-still-referenced 私有代理不泄名 / workgroup-scheduled-referenced 成员私有规则 + admin 全见）+ 存量形状断言 6 处按新契约更新。legacy 裸数组键从这些发射点绝迹（锁在测试里）。
- 门槛：typecheck/lint/format 绿；backend 全量 5797/0 fail；前端全量 4787/4787；binary smoke 过。
- **PR-3 实现门折入（Codex 1P1）**：T6 的 grant 预取（async）在 `existing` 捕获与 dbTxSync 守卫事务之间拉开 yield 窗口——并发同名替换可让事务按 name 动到替身、绕过 `isAgentLaunching(existing.id)` 的 RFC-175 ABA 防护。修复 = deleteAgent/renameAgent 事务首步 identity fence（重读该 name 行、断言 id === existing.id，不匹配抛既有语义码 `agent-id-mismatch`）；顺带把 route 层本就存在的 getAgent→tx 窗口一并关死。bun:sqlite 全同步驱动下进程内交错无法在单测确定性构造，按仓规源级锁兜底（fence ×2 + 位于 grant 预取之后断言，`rfc203-refs-acl`），happy path 无误伤由全部删除/改名行为测试保证。mcp/plugin 的删除本就 id-anchored（`eq(mcps.id, existing.id)` / 整行匹配）不受影响；deleteWorkgroup 的 by-name 窗口为本批之前既有、非本次引入（未扩 scope）。

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
