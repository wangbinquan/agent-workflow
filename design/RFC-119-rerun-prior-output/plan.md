# RFC-119 任务分解

单 PR：改动内聚（共享渲染 + scheduler 注入 + runner 透传），无 DB migration，无前端。commit 前缀：`feat(backend): RFC-119 重跑时回灌上一次输出并提示更新/重新生成`。

## 子任务

### RFC-119-T1 共享层：统一常量 + 字段 + 渲染分支
- `packages/shared/src/clarify.ts`：`CROSS_CLARIFY_PRIOR_OUTPUT_BLOCK_TITLE`/`CROSS_CLARIFY_UPDATE_DIRECTIVE_BLOCK_TITLE`/`CROSS_CLARIFY_UPDATE_DIRECTIVE_TEXT` **改名去前缀**为中性 `PRIOR_OUTPUT_BLOCK_TITLE`/`UPDATE_DIRECTIVE_BLOCK_TITLE`/`UPDATE_DIRECTIVE_TEXT`，标题值改 `to update or regenerate`、directive 换中性文案（design §3.1，D4）。
- `packages/shared/src/prompt.ts`：`RenderPromptInput` 加 `priorOutputUpdate?: PriorOutputUpdateContext` + 导出类型；xcc 渲染处改用新常量名；在 xcc 段落之后插入泛化渲染分支（design §3.3），门控：block 非空 ∧ 非 xcc 占用 ∧ 非 inlineMode ∧ 非 hasClarifyChannel。
- `packages/shared/src/index.ts`：re-export 改名后的常量/新类型（删旧 `CROSS_CLARIFY_*` 导出）。
- 依赖：无。

### RFC-119-T2 后端：helper + cross-clarify 重构 + 泛化计算 + runner 透传
- `scheduler.ts`：新增 `composePriorOutputBlock`（含 `onlyPorts` 限定，D10）+ `freshestPriorRunWithOutput`（design §3.4）。
- `scheduler.ts`：cross-clarify 块（2345-2356）改调 `composePriorOutputBlock`（不传 onlyPorts；块 byte-identical，design §3.5）。
- `scheduler.ts`：在 `effectiveHasClarifyChannel` 已知之后计算 `priorOutputUpdate`（design §3.6），review-iterate 时按 `reviewContext.iterateTargetPort` 传 `onlyPorts`（D10），并透传进 `runNode({...})`。
- `runner.ts`：`RunNodeOptions` 加 `priorOutputUpdate?`；非-followup 的 `renderUserPrompt` 调用透传（design §3.7）。
- 依赖：T1（类型/常量）。

### RFC-119-T3 测试
- `packages/shared/tests/rerun-prior-output.test.ts`（design §6.1）。
- `packages/backend/tests/rerun-prior-output-injection.test.ts`（design §6.3，含 D10 互补去重 + 文件端口路径）。
- 源码文本回归断言（design §6.4）。
- **更新 cross-clarify 既有测试**到统一中性措辞 + 新常量名（design §6.2，D4）：`cross-clarify-update-mode.test.ts`、`cross-clarify-update-mode-injection.test.ts` 及其它引用旧常量/旧文案处。
- 依赖：T1、T2。

### RFC-119-T4 门禁 + 落档收尾
- `bun run typecheck && bun run test && bun run format:check` 全绿；`bun run build:binary` smoke 无环。
- Codex 设计 gate（落档后、实现前）+ 实现 gate（改完）各一次，findings 全 fold（记进 design §8 若产生）。
- 更新 `design/plan.md` RFC 索引状态 Draft→In Progress→Done；`STATE.md` 顶部「进行中 RFC」行 + 完工后已完成表加行。
- push 后查 CI（[feedback_post_commit_ci_check]）。

## 验收清单（对齐 proposal AC）
- [ ] AC-1 评审 reject/iterate 重跑注入（含 canceled 旧行产物）
- [ ] AC-2 手动重试/级联/恢复/反问满足前提注入、不满足不注入
- [ ] AC-3 首次运行不注入
- [ ] AC-4 循环下一迭代不注入
- [ ] AC-5 同会话续跑（inline/followup）不注入
- [ ] AC-6 强制反问态不注入
- [ ] AC-7 cross-clarify 统一中性指令（块本身不变、测试更新）、不重复注入
- [ ] AC-8 全端口空不注入
- [ ] AC-9 零 migration、三门禁全绿、smoke 无环
- [ ] D10 review-iterate 只示目标端口、reject/非评审示全部

## 风险与缓解
- **R1 误改 `priorDoneGenerationsForRun`**：T2 只**新增** `freshestPriorRunWithOutput`，绝不动前者；§6.4 源码断言锁 done-only。
- **R2 cross-clarify 回归**：T2 重构 byte-identical + §6.2 既有测试全绿验证。
- **R3 续跑/反问误注入**：双层门控（scheduler + prompt）+ §6.1/§6.4 断言。
- **R4 多人树**：仅触 scheduler.ts/runner.ts/prompt.ts/clarify.ts；按路径精确 `git commit -- <paths>`，不碰协作者 RFC-117/118 未提改动（[feedback_shared_index_commit_race]/[feedback_dont_delete_others_code_for_ci]）。
