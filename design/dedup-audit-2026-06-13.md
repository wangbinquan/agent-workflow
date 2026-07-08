# 重复实现审计 & 公共化改造建议（2026-06-13）

> 目标：盘点前台 / 后台 / 跨层「同一能力写了多份」的地方，给出可落地的公共化（commonization）路线。
> 本文是**调研产物**，不含代码改动。任何非平凡重构按 `CLAUDE.md` 规则需先立 RFC 再实现。

## 0. 怎么读这份文档

- 先看 **§2 一句话结论** 和 **§3 已经"咬人"的重复**（漂移已经变成潜在 bug，优先级最高）。
- **§4** 按主题给出公共化机会，每条都带 `落点（建议的公共模块）`。
- **§5** 给出建议的 RFC 拆分顺序。
- **附录 A** 是全部 68 项确认重复的总表；**附录 B** 是**经核验排除的"伪重复"——请勿盲目合并**（多为有意的非对称设计）。

## 1. 方法与口径

- 用 11 个并行扫描 agent 覆盖全仓（后端 routes / git+fanout / clarify+review / memory+session / mcp+plugin+skill / lifecycle+util+auth；前端 路由页 / picker+表单 / hooks+ws+draft / 展示组件+lib；跨层 shared）。
- 86 个原始候选 → 合并去重为 75 个簇 → 每簇派一个**对抗式核验 agent**逐一打开源码确认（默认判"不是重复"，只有代码真重叠且能共用才算）。
- 结果：**68 项确认重复**、**4 项核验排除**（伪重复）、3 个前端骨架簇核验进程掉线（已人工补验，均为真重复，并入 §4.7）。
- 评分口径：
  - **严重度** high/medium/low —— "继续重复"的危害（已漂移成 bug > 一致性/维护负担 > 纯整洁）。
  - **工作量** S/M/L。
  - **RFC** —— 是否触碰行为/线上契约（需走 RFC）；纯机械等价提取（behavior-preserving）不需要。

## 2. 一句话结论

公共原语其实大多**已经存在**，问题是**调用方绕过它各写一份**：后端有 `resourceAcl.ts` / `taskCollab.ts` / `util/errors.ts` / `util/safePath.ts` / `util/redact.ts` / `shared/lifecycle.ts`，前端有 `ErrorBanner` / `describeApiError` / `Form` / `Select` / `Segmented`。最高价值的改造不是"造新轮子"，而是 **把散落的手写副本收敛回既有原语，并把缺位的纯逻辑下沉到 `shared/`**。其中 9 处副本**已经发生真实漂移**（见 §3），应作为第一批修复——它们既是 bug 修复，也是公共化的最佳论据。

## 3. 已经"咬人"的重复——漂移即 bug（先修这批）

这些不是"看起来像"，而是多份副本**今天就已经不一致**，构成潜在 bug / 安全 / 数据问题：

1. **`prior-done-generation-node-run-order`**（cross-layer, high）——"已完成 clarify generation 计数/排序"被写了 3 份且各用**不同的 scope-key**：
   - `services/scheduler.ts:4633` `priorDoneGenerationsForRun` 按 `(taskId,nodeId,iteration,shardKey)`，**漏 reviewIteration**；
   - `frontend/lib/node-history.ts:53` `clarifyRoundForRun` 按 `(nodeId,iteration,reviewIteration)`，**漏 shardKey**；
   - `frontend/lib/injected-memories-card.ts:105` `findFirstAttemptSibling` 两个维度都带。
   三处注释都自称"mirror priorDoneGenerationsForRun"，但**对 review 节点 / fan-out 节点会算出不同的 round**——chip 显示、调度 `clarifyGeneration`、memoryInject 锚点可能彼此不一致。ULID 排序的 tiebreak 还把 `freshness.ts` 的 `isFresherNodeRun` 手抄了一遍。
   → **落点**：`packages/shared/src/nodeRunOrder.ts`（先定 canonical scope，再让三处共用）。**RFC**。

2. **`clarify-rounds-dual-write`**（backend, medium）——self/cross 各写一份 `clarify_rounds` 的 insert/update。cross 路径 `crossClarify.ts:261` **硬编码 `truncationWarningsJson: null`**，而 cross 信封确实会产生截断警告（`:269` 记日志后丢弃）。RFC-058 删除 legacy 表后，cross 的截断警告将**彻底丢失**（self 路径 `clarify.ts:232` 是保留的）。
   → **落点**：`services/clarifyRounds.ts` 加 `insertClarifyRound/updateClarifyRoundAnswered` 两个 mapper。

3. **`git-url-credential-redaction`**（backend, medium）——`commitPush.ts:248` `redactPushError` 只覆盖 `scheme://user@host` 这一种 userinfo，**漏掉 `Authorization: Bearer` / `token=` / `password=`**，而 `util/redact.ts:52` `redactSensitiveString` 是它的超集。git push stderr 真实会回显这些 → **凭据泄漏到落库的报错里**。
   → **落点**：把 `redactPushError` 改成 `redactSensitiveString` 的薄包装（保留 600 截断契约）。

4. **`worktree-path-containment-check`**（backend, medium）——路径围栏写了 3 份：`util/safePath.ts`、`services/worktreeFiles.ts`、以及 image-proxy 路由 `routes/worktree-files.ts:57`。**第三份漏掉了反斜杠拒绝 + realpath/符号链接逃逸检查** → 路径穿越安全缝。
   → **落点**：`util/safePath.ts` 加一个容忍空 root 的 `safeJoinAllowRoot`，三处共用。

5. **`zod-parse-or-throw-422`**（backend, medium）——422 校验失败被写了 ~39 处，且有**三种 detail 形状**（`{issues}` / `.format()` 树 / 无 detail）。`routes/agents.ts:204` 的 closure-preview **校验失败时 `c.json(...)` 漏传 status → 返回 HTTP 200**（客户端区分不了成功/失败）。
   → **落点**：`util/errors.ts` 加 `parseOrThrow`（统一为多数派 `{issues}`）。**RFC**（会统一 wire shape）。

6. **`resolve-opencode-cmd-and-best-effort-resume`**（backend, medium）——`resolveOpencodeCmd` 3 份（`tasks.ts:72` 那份**漏了 `configPath===''` guard**）；"best-effort resume" 块 3 份，且**都没传 `subagentLiveCapture`**（只有真正的 /resume 路由传了）——RFC-048 能力在这些路径上缺失。
   → **落点**：`util/opencode.ts` 导出 `resolveOpencodeCmd`；`services/task.ts` 加 `resumeTaskBestEffort`。**RFC**。

7. **`opencode-event-extraction`**（backend, medium）——`runner.ts:1713` `extractTextFromEvent` 与 `memoryDistiller.ts:792` `extractEventText` 自称 lockstep，但后者是超集（多 3 种事件形状）；sessionID 抽取两份**guard 不一致**（runner 无 `length>0`，会 latch 空串）。
   → **落点**：`services/opencodeEvents.ts` 收口两个 predicate。

8. **`frontend-describe-error-helper` + `inline-error-box-bypasses-errorbanner`**（frontend, medium）——`describeError` 被**逐字复制 10 份**，且与 canonical `describeApiError`（`i18n/index.ts:54`，会查 `errors.<code>` i18n）行为不同：于是 **同一个后端错误，agents/mcps/plugins 页显示翻译句子、repos/tasks/skills/settings 页显示裸 `code: message`**。另有 ~40 处 inline `<div className="error-box">` 绕过 `ErrorBanner`（`⚠` 前缀有的有有的没有）。
   → **落点**：删掉 10 份 `describeError` 一律走 `describeApiError`；inline error-box 一律走 `ErrorBanner`。**RFC**（user-visible 文案变化）。

9. **`idb-draft-store-facade`**（frontend, medium）——`lib/clarify/draftStore.ts` 与 `lib/review/draftStore.ts` 对**同一个 IndexedDB 库 `agent-workflow-drafts` 用了不同的 version（2 vs 1）**和两个独立 dbPromise 单例 → 两条连接 / 升级 footgun。
   → **落点**：`lib/idbKv.ts` 一个 `createIdbStore<V>()`，单连接 + 单 version + store 注册表。

## 4. 按主题的公共化机会

### 4.1 后端 · 任务可见性 / 成员闸门（ACL）

`taskCollab.ts` 已有 `canViewTask` / `requireTaskMember` 这两个纯闸门，但"加载 task → 调闸门 → 抛错"的包装在各路由各写一份，**404/403 契约已漂移**（owning task 缺失时 reviews 抛 `task-not-found`、clarify 静默返回；tasks 为防存在性泄漏静默、taskFeedback 先抛 404）。

- **`task-visibility-and-member-gate`**（8 站, M, RFC）——`reviews.ts:55/81`、`clarify.ts:62/98`、`taskFeedback.ts:48`、`tasks.ts:552`、`ws/server.ts:237` → `taskCollab.ts` 加 `requireTaskVisible / requireTaskVisibleByTaskId / requireTaskMemberByTaskId`（缺失策略参数化）。
- **`task-visibility-list-filter`**（4 站, S）——`reviews.ts:105` `filterVisibleByTask` 与 `clarify.ts:123` `filterRoundsByTaskVisibility` **逐字相同** → 提到 `taskCollab.ts`，对齐 `resourceAcl.filterVisibleRows` 的形态。
- **`pending-count-badge-endpoint`**（4 站, S）——两个 pending-count handler 仅绑定函数不同，依赖上面那个 filter。
- **`load-visible-resource-or-404`**（7 站, S）——5 类 ACL 资源的 "load+acl+404" → `resourceAcl.ts` 泛型 loader（保留各资源 code）。
- **`memory-scope-acl-resolution`**（5 站, S）、**`permission-check-or-403`**（3 站, S）、**`acl-owner-visibility-list-badge`**（前端 6 站, S，→ `ResourceOwnerBadges.tsx`）。

### 4.2 后端 · 错误 / 校验 / 响应信封

- **`zod-parse-or-throw-422`**（见 §3.5）。
- **`api-error-envelope-shape`**（3 站, M, RFC）——`shared/schemas/apiError.ts` 自己注释说它"hand-mirror 后端 ErrorPayload"，两端都不 import 它；已有路由（`agents.ts:204/213`、`oidc-auth.ts:29/33`、`oidc.ts:61`、`tasks.ts:321`）发出不合规 body。→ 让 shared schema 成为单一事实源，后端 `util/errors.ts` 与前端 `api/client.ts` 都消费它。
- **`safe-json-body-parse`**（16 站, S）——12 份**逐字相同**的 `safeJson(req)` → `util/httpBody.ts`（注意：`mcpProbeStore`/`oidcProviders`/`rowTo*` 那族是**另一类**，签名/fallback 不同，**不要并进来**）。
- 低优快赢：**`ws-error-response-builder`**(4)、**`json-column-to-object-fallback`**(4)、**`row-to-resource-parse-validate`**(6, → `services/resourceRow.ts`)。

### 4.3 后端 · opencode / git 运行时

- **`resolve-opencode-cmd-and-best-effort-resume`**（见 §3.6）、**`opencode-event-extraction`**（见 §3.7）、**`git-url-credential-redaction`**（见 §3.3）、**`worktree-path-containment-check`**（见 §3.4）。
- **`mcp-plugin-closure-twins`**（5 站, S）——`mcpClosure` 与 `pluginClosure` 的依赖闭包遍历近似 → `services/resourceClosure.ts` 泛型 `collectClosureNames<T>`。
- **`opencode-session-capture-orchestration`**（5 站, M, RFC）——两条 one-shot capture 路径可收口（poller 生命周期相反，**保留不动**）。
- 低优：**`git-spawn-capture-boilerplate`**(4, → `util/git.ts`)、**`dispatch-opencode-node-scaffold`**(3)、**`unified-diff-per-file-splitter`**(3, → `shared/diffSplit.ts`)、**`wrapper-fanout-outlet-rename`**(2)、**`wrapper-progress-decode`**(2)。

### 4.4 后端 · 生命周期 / 状态集合 / 后台 ticker

- **`task-terminal-status-set`**（4 站, S）——terminal-status 集合写了 4 份；`gc.ts:23` 是裸字面量**没有 `satisfies readonly TaskStatus[]` 守卫** → TASK_STATUS 改动时 GC 会静默漏处理。→ `shared/lifecycle.ts` 加带守卫的 `TERMINAL_TASK_STATUSES`（前端 `tasks.detail.tsx` 的 `isTerminal` 也并进来）。
- **`is-wrapper-kind-predicate`**（13 站, M）——`{wrapper-git, wrapper-loop, wrapper-fanout}` 这个集合存在 3 种形态（`dispatchFrontier.ts` 的 Set、`coordProjection.ts` 的私有函数、~9 处 inline 三元 OR），连 `scheduler.ts` 自己 import 了 `WRAPPER_KINDS` 还在别处手写。→ `shared/node-kind-behavior.ts` 加 `isWrapperKind`，后端 Set 从它派生。
- 低优：**`self-throttling-background-ticker`**(5, → `util/ticker.ts`)、**`settle-task-terminal`**(4)、**`node-status-broadcast-frame`**(4)、**`process-group-kill`**(3)。

### 4.5 后端 · clarify / review 流程

- **`clarify-rounds-dual-write`**（见 §3.2）。
- **`legacy-clarify-prompt-context`**（6 站, M, RFC）——`buildClarifyPromptContext` + 私有 reader + `computeRemaining` 是**死代码**（生产只走 `clarifyRounds.buildPromptContext`），可删；难点在迁移 ~10 个仍引用它的测试。
- 低优：**`parse-question-scopes-json`**(4)、**`compute-remaining-loop-counter`**(2)。

### 4.6 前端 · 错误渲染统一

见 §3.8。这是**面最广**的一类（~50 站），收敛到 `ErrorBanner` + `describeApiError` 后顺带统一 `⚠` 与 i18n。建议作为一个独立前端 RFC（含 `home/SectionError`、`inventory` 空态等小同族）。

### 4.7 前端 · 页面骨架 & 公共组件复用（直接对应 `CLAUDE.md` 前台统一风格条款）

- **`resource-list-page-scaffold`**（人工补验）——`components/ResourceList.tsx` 是 `P-1-17` 占位实现、**全仓无人 import**；10 个 list 路由各手写 `page__header + loading(muted) + error-box + empty + 列表`。→ 要么把 `ResourceList` 补成真正的 DataTable+状态壳并全量采用，要么删掉它，二选一别留孤儿。
  **更正（RFC-151）**：`ResourceList.tsx` 已删除（flag-audit §8 决策④落地），「去留」裁决作废；`.data-table`（11 路由）即事实标准与抽取基线。
- **`resource-create-page-scaffold`** / **`resource-detail-edit-scaffold`**（7 站, M）——4 个 detail 页 header action cluster（`AclDialogButton + Save + ConfirmButton 删除`）结构一致 → 抽 `DetailHeaderActions.tsx`（注意 skills 是双 query/双 mutation，别强塞进一个 hook）。
- **`inline-muted-loading-bypasses-loadingstate`**（人工补验，26 处 inline `common.loading`）——绕过 `LoadingState`（19 处已用）→ 收敛。
- **`segmented-vs-chip-radio`**（6 站, M）——`McpFields.tsx` 用了**原生 radio / 自写 chip-row**，**违反 `CLAUDE.md` 前台统一风格**（应走 `.segmented` / `Select`）→ 必须改。
- **`list-multiselect-picker`**（4 站, M）——5 个 picker（Agent/Mcp/Plugin/Skill/User）共享"带搜索的多选列表" → 抽 `ListPicker`。
- **`chips-input-reimplemented-in-outputseditor`**（2 站）——`OutputsEditor` 重写了 `ChipsInput` 逻辑。
- **`inbox-by-task-list`**（11 站, M）、**`memory-dialog-scope-options-footer`**（12 站, S）、**`memory-edit-dialog-mount-block`**（4 站, S）、**`homepage-task-list-and-section-error`**（5 站, S）、**`inventory-table-empty-state`**（5 站, S）、**`vertical-tablist-file-tree`**（3 站, S）。

### 4.8 前端 · draft / IndexedDB / 状态

- **`idb-draft-store-facade`**（见 §3.9）。
- 低优：**`module-emitter-external-store`**(2)、**`api-client-request-flow`**(4)、**`immutable-field-set-helper`**(3)、**`resource-form-state-validation-lib`**(6)、**`tagged-prefix-event-parser`**(2)、**`markdown-plugin-chain`**(2)。

### 4.9 跨层 · 应当下沉到 `shared/` 的纯逻辑

这些是"前端和后端各算一遍同一个纯函数"，最适合进 `shared/`：

- **`dedupe-preserving-order`**（7 站, S, → `shared/strings.ts`）。
- **`timestamp-latency-formatters`** / **`relative-time-ago-formatter`**（前端 5+2 站, → `frontend/lib/format.ts`；纯展示，不必进 shared）。
- **`create-hash-hex-oneliners`**(4) / **`sha256-token-hash`**(2)（→ 后端 `util/hash.ts`）。
- **`frontmatter-parser-and-helpers`**(3) / **`agent-md-name-array-field`**(3)（`util/frontmatter` vs `shared/agent-md`/`skill-md`）。
- **`bearer-token-extraction-timing-safe`**(4) / **`secret-file-read-or-generate`**(2) / **`find-agents-referencing-reverse-scan`**(5) / **`memory-tags-json-parse`**(3) / **`inflight-dedup-and-captured-subprocess`**(4) / **`parse-session-tree-adapter`**(4) / **`require-path-query-validator`**(2)。

## 5. 建议的 RFC 拆分与落地顺序

> 原则：先修"漂移即 bug"（既消 bug 又证明公共化必要性），再做"收敛回既有原语"，最后做"骨架级"大改。每个 RFC 按 `Test-with-every-change` 先补红线测试（多为源码层文本断言 + 纯函数断言）。

1. **RFC-A · 后端 ACL 闸门收口**（§4.1）——`taskCollab` 加 `require*`/`filterVisibleByTask`，统一 404/403 契约。中等，触契约 → RFC。
2. **RFC-B · 后端错误 & 校验信封**（§4.2）——`parseOrThrow` + `httpBody` + `apiError` 单一事实源，顺手修 `agents.ts:204` 的 200 bug。
3. **RFC-C · opencode/git 运行时收口**（§4.3）——`resolveOpencodeCmd` / `resumeTaskBestEffort`（补 `subagentLiveCapture`）/ `redactPushError` 包装 / `safeJoinAllowRoot` / `opencodeEvents`。修 3 个潜在 bug。
4. **RFC-D · node-run 排序 & generation 计数单一事实源**（§3.1）——`shared/nodeRunOrder.ts`，先定 canonical scope。**行为敏感，最需慎重**。
5. **RFC-E · 前端错误渲染统一**（§4.6）——`ErrorBanner` + `describeApiError` 全量收敛。
6. **RFC-F · 前端页面骨架 & 组件复用**（§4.7）——`DetailHeaderActions` / `ListPicker` / `ResourceList` 去留决策 / `LoadingState` 收敛 / `McpFields` 改用 `.segmented`。
7. **零散快赢（不必单独 RFC，可随手 PR + 测试）**：§4.4 的状态集合下沉、§4.9 的纯逻辑下沉、`is-wrapper-kind`、`safe-json-body`、`legacy-clarify` 死代码删除等机械等价提取。

## 附录 A：全部 68 项确认重复

（按 严重度→工作量→站点数 排序；"落点"为核验 agent 给出的建议公共模块，最终以 RFC 设计为准）

| # | id | 层 | 严重度 | 工作量 | RFC | 站点数 | 建议落点 |
|---|----|----|-------|--------|-----|--------|----------|
| 1 | `prior-done-generation-node-run-order` | cross-layer | high | M | Y | 5 | `packages/shared/src/nodeRunOrder.ts` |
| 2 | `inline-error-box-bypasses-errorbanner` | frontend | medium | L | Y | 12 | `packages/frontend/src/i18n/index.ts` |
| 3 | `frontend-describe-error-helper` | frontend | medium | M | Y | 14 |  |
| 4 | `is-wrapper-kind-predicate` | cross-layer | medium | M | - | 13 | `packages/shared/src/node-kind-behavior.ts` |
| 5 | `zod-parse-or-throw-422` | backend | medium | M | Y | 12 | `packages/backend/src/util/errors.ts` |
| 6 | `task-visibility-and-member-gate` | backend | medium | M | Y | 8 | `packages/backend/src/services/taskCollab.ts` |
| 7 | `resolve-opencode-cmd-and-best-effort-resume` | backend | medium | M | Y | 8 | `packages/backend/src/util/opencode.ts` |
| 8 | `clarify-rounds-dual-write` | backend | medium | M | - | 8 | `packages/backend/src/services/clarifyRounds.ts` |
| 9 | `resource-detail-edit-scaffold` | frontend | medium | M | - | 7 | `packages/frontend/src/components/DetailHeaderActions.ts` |
| 10 | `legacy-clarify-prompt-context` | backend | medium | M | Y | 6 | `packages/backend/src/services/clarify.ts` |
| 11 | `idb-draft-store-facade` | frontend | medium | M | - | 5 | `packages/frontend/src/lib/idbKv.ts` |
| 12 | `worktree-path-containment-check` | backend | medium | M | - | 3 | `packages/backend/src/util/safePath.ts` |
| 13 | `api-error-envelope-shape` | cross-layer | medium | M | Y | 3 | `packages/shared/src/schemas/apiError.ts` |
| 14 | `task-visibility-list-filter` | backend | medium | S | - | 4 | `packages/backend/src/services/taskCollab.ts` |
| 15 | `pending-count-badge-endpoint` | backend | medium | S | - | 4 | `packages/backend/src/services/taskCollab.ts` |
| 16 | `opencode-event-extraction` | backend | medium | S | - | 4 | `packages/backend/src/services/opencodeEvents.ts` |
| 17 | `task-terminal-status-set` | cross-layer | medium | S | - | 4 | `packages/shared/src/lifecycle.ts` |
| 18 | `git-url-credential-redaction` | backend | medium | S | - | 3 | `packages/backend/src/services/commitPush.ts` |
| 19 | `inbox-by-task-list` | frontend | low | M | Y | 11 | `packages/frontend/src/components/InboxByTask.ts` |
| 20 | `row-to-resource-parse-validate` | backend | low | M | - | 6 | `packages/backend/src/services/resourceRow.ts` |
| 21 | `segmented-vs-chip-radio` | frontend | low | M | - | 6 | `packages/frontend/src/components/Segmented.ts` |
| 22 | `opencode-session-capture-orchestration` | backend | low | M | Y | 5 |  |
| 23 | `list-multiselect-picker` | frontend | low | M | - | 4 | `packages/frontend/src/components/ListPicker.ts` |
| 24 | `frontmatter-parser-and-helpers` | cross-layer | low | M | - | 3 | `packages/shared/src/frontmatter.ts` |
| 25 | `dispatch-opencode-node-scaffold` | backend | low | M | Y | 3 | `packages/backend/src/services/runner-opts.ts` |
| 26 | `unified-diff-per-file-splitter` | cross-layer | low | M | Y | 3 | `packages/shared/src/diffSplit.ts` |
| 27 | `chips-input-reimplemented-in-outputseditor` | frontend | low | M | - | 2 | `packages/frontend/src/lib/useTokenInput.ts` |
| 28 | `safe-json-body-parse` | backend | low | S | - | 16 | `packages/backend/src/util/httpBody.ts` |
| 29 | `memory-dialog-scope-options-footer` | frontend | low | S | - | 12 | `packages/frontend/src/components/Dialog.ts` |
| 30 | `load-visible-resource-or-404` | backend | low | S | - | 7 | `packages/backend/src/services/resourceAcl.ts` |
| 31 | `dedupe-preserving-order` | cross-layer | low | S | - | 7 | `packages/shared/src/strings.ts` |
| 32 | `acl-owner-visibility-list-badge` | frontend | low | S | - | 6 | `packages/frontend/src/components/ResourceOwnerBadges.ts` |
| 33 | `resource-form-state-validation-lib` | frontend | low | S | - | 6 | `packages/frontend/src/lib/form-validation.ts` |
| 34 | `memory-scope-acl-resolution` | backend | low | S | - | 5 | `packages/backend/src/services/memory.ts` |
| 35 | `mcp-plugin-closure-twins` | backend | low | S | - | 5 | `packages/backend/src/services/resourceClosure.ts` |
| 36 | `find-agents-referencing-reverse-scan` | backend | low | S | - | 5 | `packages/backend/src/services/agentRefs.ts` |
| 37 | `self-throttling-background-ticker` | backend | low | S | - | 5 | `packages/backend/src/util/ticker.ts` |
| 38 | `homepage-task-list-and-section-error` | frontend | low | S | - | 5 | `packages/frontend/src/components/home/SectionError.ts` |
| 39 | `inventory-table-empty-state` | frontend | low | S | - | 5 |  |
| 40 | `timestamp-latency-formatters` | frontend | low | S | - | 5 | `packages/frontend/src/lib/format.ts` |
| 41 | `git-spawn-capture-boilerplate` | backend | low | S | - | 4 | `packages/backend/src/util/git.ts` |
| 42 | `create-hash-hex-oneliners` | backend | low | S | - | 4 | `packages/backend/src/util/hash.ts` |
| 43 | `parse-question-scopes-json` | backend | low | S | - | 4 | `packages/shared/src/clarify.ts` |
| 44 | `parse-session-tree-adapter` | backend | low | S | - | 4 | `packages/shared/src/sessionView.ts` |
| 45 | `inflight-dedup-and-captured-subprocess` | backend | low | S | - | 4 | `packages/backend/src/util/inflight.ts` |
| 46 | `bearer-token-extraction-timing-safe` | backend | low | S | - | 4 | `packages/backend/src/auth/httpToken.ts` |
| 47 | `json-column-to-object-fallback` | backend | low | S | - | 4 | `packages/backend/src/util/json.ts` |
| 48 | `ws-error-response-builder` | backend | low | S | - | 4 |  |
| 49 | `node-status-broadcast-frame` | backend | low | S | - | 4 | `packages/backend/src/ws/broadcaster.ts` |
| 50 | `settle-task-terminal` | backend | low | S | - | 4 |  |
| 51 | `api-client-request-flow` | frontend | low | S | - | 4 | `packages/frontend/src/api/client.ts` |
| 52 | `memory-edit-dialog-mount-block` | frontend | low | S | - | 4 | `packages/frontend/src/hooks/useMemoryEditDialog.ts` |
| 53 | `memory-tags-json-parse` | backend | low | S | - | 3 | `packages/backend/src/services/memory.ts` |
| 54 | `agent-md-name-array-field` | shared | low | S | - | 3 | `packages/shared/src/agent-md.ts` |
| 55 | `permission-check-or-403` | backend | low | S | - | 3 | `packages/backend/src/auth/permissions.ts` |
| 56 | `process-group-kill` | backend | low | S | - | 3 | `packages/backend/src/util/process.ts` |
| 57 | `immutable-field-set-helper` | frontend | low | S | - | 3 | `packages/frontend/src/lib/usePatch.ts` |
| 58 | `vertical-tablist-file-tree` | frontend | low | S | - | 3 | `packages/frontend/src/lib/useTablistKeyNav.ts` |
| 59 | `require-path-query-validator` | backend | low | S | - | 2 | `packages/backend/src/routes/_helpers.ts` |
| 60 | `wrapper-fanout-outlet-rename` | backend | low | S | - | 2 | `packages/shared/src/wrapperFanout.ts` |
| 61 | `wrapper-progress-decode` | backend | low | S | - | 2 | `packages/backend/src/services/structuralDiff/service.ts` |
| 62 | `compute-remaining-loop-counter` | backend | low | S | - | 2 | `packages/shared/src/clarify.ts` |
| 63 | `sha256-token-hash` | backend | low | S | - | 2 | `packages/backend/src/auth/tokenHash.ts` |
| 64 | `secret-file-read-or-generate` | backend | low | S | - | 2 | `packages/backend/src/util/secretFile.ts` |
| 65 | `tagged-prefix-event-parser` | frontend | low | S | - | 2 | `packages/frontend/src/lib/taggedEvent.ts` |
| 66 | `module-emitter-external-store` | frontend | low | S | - | 2 | `packages/frontend/src/lib/externalStore.ts` |
| 67 | `markdown-plugin-chain` | frontend | low | S | - | 2 | `packages/frontend/src/components/prose/plugins.ts` |
| 68 | `relative-time-ago-formatter` | frontend | low | S | - | 2 | `packages/frontend/src/lib/relative-time.ts` |

## 附录 B：经核验排除的「伪重复」（请勿盲目合并）

这些被对抗式核验判为**不是可合并的重复**——多数是有意的非对称设计，强行合并反而引入回归：

- **`shardkey-dictionary-order-sort`** — Verdict: NOT a real duplication worth commonizing as framed. Cluster overstates it (one scheduler site, not two) and the sorts work on different key domains across two independent shard pipelines. The only genuine nugget is comparator-algorithm drift (localeCo
- **`collaborative-per-item-draft-attribution`** — Verdict: NOT a real duplication. The 'same concurrent-edit-while-parked pattern' framing is superficial — the resemblance is at the lifecycle level (member edits a parked awaiting_* node, broadcast over the task channel) but the implementations share no code a
- **`detail-layout-split-pane`** — Verified: DetailLayout has exactly one consumer (memory.distill-jobs.$jobId.tsx:96), confirming the cluster's 'only distill-jobs adopted it' observation. But the premise that tasks.detail and reviews.detail 'still render bespoke split-pane layouts' that Detail
- **`ws-hook-subscribe-parse-invalidate`** — Verdict: NOT a real commonizable duplication. What looks like 6 copies of one body is 6 hooks sharing only the useQueryClient+useWebSocket scaffold (already the shared primitive — useWebSocket.ts owns transport, reconnect, JSON-parse) wrapped around six genuin
