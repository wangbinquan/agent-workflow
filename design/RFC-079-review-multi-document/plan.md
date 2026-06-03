# RFC-079 Plan —— Review 多文档模式任务分解

> 状态：Draft（2026-06-03）
> 关联：[proposal.md](./proposal.md)、[design.md](./design.md)
> PR 拆分建议：**2 PR 强序**（先后端运行时地基、后端先于前端可独立验证）。
> PR-A = shared + DB + 运行时（API 可跑通 S1）；PR-B = 前端三栏多文档面 + 收件箱 + WS。

---

## 任务分解

### PR-A —— 数据模型 + 运行时（后端闭环）

- **RFC-079-T1**（DB + shared schema）：`doc_versions` 加 `item_index` / `selection` / `item_path` 3 列 + `idx_doc_versions_review_item` 索引（`schema.ts:597-642`）；`bun run db:generate` 出 ADD COLUMN migration。`schemas/review.ts` 的 `DocVersionSchema`(:144) 加 3 可选字段、`ReviewSummarySchema`(:266) 加 `isMultiDoc?`、新增 `SetDocumentSelectionSchema`、`ReviewDetailSchema`(:291) 加可选 `documents[]`。
  - 依赖：无。测试：migration 建列 + index；DocVersionSchema 向后兼容（单文档行 parse）；B5 源码断言列名存在。
- **RFC-079-T2**（shared 纯函数）：`computeAcceptedSubset(docVersions)`（保序+仅 accepted+join）、`isMultiDocReviewInput(kind)`（list inner markdownish）、`extractDocTitle(body, path)`（首 heading/首行/文件名）。`outputKinds/list.ts:34` 把 `splitListItems` 加 `export`。
  - 依赖：T1。测试：C2 子集保序、§3 判定、A6 标题、splitListItems export。
- **RFC-079-T3**（validator 放开 list + 输出端口推导）：`workflow.validator.ts:765` 放开 `review-input-list-kind-not-supported`——list inner∈{path<md>,markdown} 放行、否则 `review-input-list-item-not-markdown`；`:290` review 输出端口据 inputSource 上游 kind 推导（list→`accepted:list<path<md>>`+`approval_meta`，否则 `approved_doc`+`approval_meta`）。
  - 依赖：T2。测试：list 合法连边通过、非 markdown inner 报错、单文档输出端口不变、多文档输出端口 `accepted`。
- **RFC-079-T4**（dispatch 多文档归档）：`dispatchReviewNode`(:341) 按上游 kind 分叉；新 `dispatchReviewNodeMultiDoc`——splitListItems → 逐篇读盘 + 归档 N 个 doc_version；**改 `createDocVersion`(:613) versionIndex 计算键加 itemIndex 维度**；bodyPath 加 `item_{i}` 段；空 list park 空 round；awaiting-refresh 重建循环 N 篇。
  - 依赖：T2/T3。测试：list→N 行 doc_version、versionIndex 各自 v1、空 list、上游重生整批 superseded+重建（A8）；**C1 单文档零回归**（markdown/path<md> 仍单值、三列 NULL）。
- **RFC-079-T5**（submit 三分支 + selection PATCH）：`submitReviewDecision`(:1152) 判模式分叉、多文档去 `.limit(1)`；approve（全标校验 409、子集保序、写 `accepted`、approval_meta、done+resumeTask）；iterate（逐篇 commentsJson、`buildReviewPromptContext`(:1677) 聚合 iterated 篇 join 带 `### itemPath`、不回滚、bump reviewIteration）；reject（沿用 rollbackToSnapshot+整批重生）。新端点 `PATCH /api/reviews/:nodeRunId/documents/:docVersionId/selection`（`routes/reviews.ts:147` 旁）。
  - 依赖：T4。测试：A2(C2) 子集、A5 全标 409、A3(C3) iterate 区分回灌、A4(C4) reject 回退、selection PATCH 落列+awaiting 校验+不 bump iteration。
- **RFC-079-T6**（回归锁单测）：`review-multidoc-single-doc-no-regression`(C1)、`review-multidoc-accepted-subset-order`(C2)、`review-multidoc-iterate-comment-attribution`(C3)、`review-multidoc-reject-rollback`(C4)；顶部注释链回本 RFC。
  - 依赖：T4/T5。

### PR-B —— 前端三栏多文档面 + 收件箱 + WS（依赖 PR-A 合并 + CI 绿）

- **RFC-079-T7**（多文档三栏页）：`reviews.detail.tsx` 加多文档分支（判 `documents`）：左栏 `components/review/ReviewDocumentList.tsx`（title+StatusChip+未决标记+J/K）、`selectedDocId`(URL `?doc=`) 切换右侧 Prose 渲染当前篇+当前篇 inline 评论（选词 popover guard 仅当前篇、scroll-spy reset）、逐篇采纳条、approve 全标门控。单文档双栏零回归。
  - 依赖：PR-A。测试：三栏 reducer、approve disabled、J/K、源码断言（公共组件、三栏仅多文档分支）。
- **RFC-079-T8**（收件箱标识 + 后端 isMultiDoc）：`reviews.tsx` 行内 `isMultiDoc` badge + tooltip；后端 `ReviewSummary` 推导 `COUNT(item_index NOT NULL)>0`。
  - 依赖：PR-A、T7。测试：A10 badge（findByRole）。
- **RFC-079-T9**（WS + i18n + 快捷键）：`schemas/ws.ts` 加 `review.selection_changed`；`useTaskSync` invalidate 分支；`review.created` payload 加 `itemCount`；多文档相关 i18n（zh+en）；快捷键 A 采纳 / R 不采纳 / J/K / Ctrl+Enter。
  - 依赖：T7。测试：A11 WS 同步（hook 单测）。
- **RFC-079-T10**（e2e，可选）：`e2e/review-multidoc.spec.ts` 覆盖 S1。时间紧可延后，但 B3/B4 单测必齐。

---

## 依赖图

```
T1 ─ T2 ─ T3 ─ T4 ─ T5 ─ T6           (PR-A 完)
                      │
PR-A ─ T7 ─┬─ T8                       (PR-B)
           └─ T9 ─ (T10 可选)
```

## PR 拆分

- **PR-A**：T1–T6。commit 前缀 `feat(backend): RFC-079 review 多文档模式 —— doc_versions 列 + 运行时三分支 + validator`。后端闭环（API 可跑通 S1）。push 后查 CI。
- **PR-B**：T7–T10。commit 前缀 `feat(frontend): RFC-079 多文档评审三栏面 + 收件箱标识 + WS`。依赖 PR-A 合并且 CI 绿再起。

> 单 RFC 默认单 PR，但本 RFC「后端先于前端可独立验证」适合 2 PR 强序（与 RFC-058/064 同模式）。若评审认为体量可控可合单 PR——以实际 diff 大小定，起 PR 时说明。

## 风险 / 决策门（详见 design §8）

- **必查 1**：`createDocVersion` versionIndex 计算键加 itemIndex（漏则 versionIndex 污染）。
- **必查 2**：`submitReviewDecision` 多文档去 `.limit(1)`（漏则只决策一篇、task 卡死）。
- **必查 3**：selection PATCH 不 bump `reviewIteration`（走独立端点）。
- **必查 4**：awaiting-refresh 后循环重建 N 篇（漏则丢文档）。
- **必查 5**：provenance 仍单 list 上游 run，consumedJson 语义不变（勿与 review-in-fanout 混淆）。
- **必查 6/7/8**：空 list park 空 round；selection 列单文档 NULL；iterate 分支不误调 rollback。

## 验收清单（合并前逐条勾）

- [ ] A1 S1 e2e（或 API 链路）：list 输入 → 多文档 awaiting_review → 逐篇采纳 → 全标同意 → `accepted` 子集 → 下游推进。
- [ ] A2/C2 采纳子集保序 + 仅 accepted + `\n` join。
- [ ] A3/C3 iterate 评论回灌带 `### itemPath` 区分、不串篇、不回滚。
- [ ] A4/C4 reject 仍 `rollbackToSnapshot` + 整批重生。
- [ ] A5 必须全篇裁决（unselected→409 + 前端 disabled）。
- [ ] A6 标题抽取三级回退。
- [ ] A7 来源无关（单 agent vs fanout 同一面）。
- [ ] A8 上游重生整批 superseded + 重建。
- [ ] A9 空采纳 / 空 list → 下游 fanout 空 list done。
- [ ] A10 收件箱 isMultiDoc badge。
- [ ] A11 多 tab WS 同步。
- [ ] **B2/C1 单文档 review 零回归**（RFC-005/013/014 套件全绿 + 字节级断言）。
- [ ] B1 `typecheck && test && format:check` 全绿；CI（build smoke + e2e）绿。
- [ ] B3 backend +≥16、B4 shared/frontend +≥12、B5 源码兜底断言。
- [ ] STATE.md「进行中 RFC」→ Done；plan.md RFC 索引 Draft→Done。
