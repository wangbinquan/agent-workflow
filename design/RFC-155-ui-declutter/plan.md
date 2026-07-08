# RFC-155 · 任务分解

单 RFC 单 PR（本仓 main 直推，按任务分小 commit，前缀 `feat(frontend): RFC-155 …`）。

## 任务

- **RFC-155-T1 `<FormSection>` 公共组件**
  - `components/FormSection.tsx`（折叠 / 非折叠、受控 / 非受控、`summary > h2`）
  - styles.css `.form-section` 命名空间样式（对齐 `.page__section > h2`，token-only）
  - i18n：`agentForm.sectionBasics/sectionPrompt/sectionOutputs/sectionDependencyGraph/sectionResources/sectionAdvanced` 两语种 + 类型声明
  - `tests/FormSection.test.tsx`
  - 依赖：无

- **RFC-155-T2 AgentForm 分节重排**
  - 按 design.md §2.1 归属表重排；删 raw body `form-details` 块 + `rawBodySummary` key；
    去掉依赖树的 `<Field>` 壳 + `fieldDependencyTree` key
  - autoOpen 初值 + 上升沿展开（design.md §2.2）
  - **随行修真 bug**：`agents.detail.tsx` `agentToDraft` 补拷 `role` +
    `outputWrapperPortNames`（设计门 high）+ 回归测试（aggregator draft → 高级节展开、
    map 回显）
  - `tests/agent-form-sections.test.tsx`（新）+ `agent-form-role.test.tsx` 展开适配
  - 验证零适配锁仍绿：AgentForm-outputs-kind / agent-form-mcp-picker /
    dependency-tree-preview / agent-dep-autodetect-button / agent-import-dialog
  - 依赖：T1

- **RFC-155-T3 页头解释小字移除**
  - design.md §3.1 清单 22 处删除（21 处 `page__hint` + memory 页 `muted` 形态；连空壳
    div 简化；settings 段含 hintRestart 共 3 key）
  - i18n key 删除（两 bundle 值 + zh-CN.ts 类型声明；每 key 删前 grep 全仓无二次引用）
  - `plugins-page-wiring.test.ts` / `mcps-page-wiring.test.ts` key 列表收缩
  - `tests/page-hint-removal.test.ts`（新，表驱动按 key 锁 + 保留锚点防过删）
  - 依赖：无（与 T1/T2 并行安全，注意 agents.new/agents.detail 与 T2 同文件、按序提交）

- **RFC-155-T4 验证与交付**
  - `e2e/a11y.spec.ts` 新增 `/agents/new` axe case（设计门 low；表单页不加视觉基线为
    显式决策，见 design.md §5）
  - 视觉对齐自查：dev server + Chrome 截图（agent 编辑页 vs /skills、/settings；light+dark）
  - visual-regression 基线按 README 处理（darwin 本机重生成；其余平台标注过期）
  - `bun run typecheck && bun run lint && bun run test && bun run format:check` + 前端 vitest
  - push 后查 GitHub Actions；Codex impl 门 review
  - 依赖：T1–T3

## 验收清单

见 proposal.md §验收标准；T4 完成后把 RFC 状态改 Done、更新 `design/plan.md` 索引与
`STATE.md`。
