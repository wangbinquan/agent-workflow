# RFC-006 Plan — 节点端口呈现重构实施计划

> 状态：Draft（2026-05-15）
> 关联：[proposal.md](./proposal.md)、[design.md](./design.md)
> PR 策略：**单 PR**。范围全在 `packages/frontend/src/components/canvas/nodes/` + `styles.css` + 两个 vitest + 一个 e2e 断言扩展。

## 1. 子任务

### RFC-006-T1：PortHandles 重写 + 节点组件 DOM 调整

**文件**：

- `packages/frontend/src/components/canvas/nodes/PortHandles.tsx` — 重写渲染逻辑
- `packages/frontend/src/components/canvas/nodes/AgentNode.tsx` — 微调（如果 PortHandles 仍是单一组件，AgentNode 不需要改；但若 catch-all 拆为新 prop 暴露给调用方，需要 AgentNode 同步）
- `packages/frontend/src/components/canvas/nodes/InputNode.tsx` — 只输出端口段
- `packages/frontend/src/components/canvas/nodes/OutputNode.tsx` — 只输入端口段
- `packages/frontend/src/components/canvas/nodes/WrapperNodes.tsx` — git 只输出 / loop 双段 + catch-all

**做什么**：

1. PortHandles 内部按 design §3.3 拆 catch-all 与 rows 两段（Fragment 返回）。
2. PortHandles 内部循环渲染 `.canvas-node__port-row` 行，行内含 `<Handle>` + `<span class="canvas-node__port-label" title={port}>{port}</span>`。
3. side=left 与 side=right 用 className `--left` / `--right` 区分；handle 的 `position` prop 仍按 side 选 Left/Right。
4. 不引入新 props（`PortHandlesProps` 签名稳定）；只改实现。
5. 几个调用方的 `<PortHandles side="..." ports=... catchAll=... />` 调用点完全不变。

**Size**：S（实质就是 PortHandles.tsx 50 行重写 + 4 个节点组件 0~5 行微调）

**Deps**：—

**Output**：5 个文件改动；构建 / typecheck 必须保持绿。

### RFC-006-T2：CSS 重写

**文件**：

- `packages/frontend/src/styles.css` — § "Custom canvas nodes" 段（1555-1720 行附近）

**做什么**：

1. **删**：`.canvas-node__ports` / `.canvas-node__ports--left` / `.canvas-node__ports--right` 三段；删 `.canvas-node__port` / `.canvas-node__port--left` / `.canvas-node__port--right`（旧绝对定位规则）。
2. **改**：`.canvas-node__port-label` 去掉 `border`、`background`、外框，加上 `max-width: 140px; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; padding: 0 4px`。
3. **新**：
   - `.canvas-node__port-rows { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }`
   - `.canvas-node__port-rows--left .canvas-node__port-row { justify-content: flex-start; }`
   - `.canvas-node__port-rows--right .canvas-node__port-row { justify-content: flex-end; }`
   - `.canvas-node__port-row { position: relative; height: 22px; display: flex; align-items: center; gap: 6px; }`
   - `.canvas-node__port-rows--left .canvas-node__port-row .react-flow__handle { left: -6px; right: auto; top: 50%; transform: translateY(-50%); }`（带 `!important` 防 xyflow 默认样式覆盖）
   - `.canvas-node__port-rows--right .canvas-node__port-row .react-flow__handle { right: -6px; left: auto; top: 50%; transform: translateY(-50%); }`
   - `.canvas-node__inbound-catchall { position: absolute; left: -6px; top: 0; height: 100%; width: 12px; pointer-events: auto; z-index: 0; }`
   - 内部 catch-all handle 继承既有 `.canvas-node__handle--catchall` 样式（保留该 class，不变）。
4. **保留**：`.canvas-node__handle` 8px dot + accent 色 + 2px panel 描边（含 `!important`）。
5. **保留**：`.canvas-node` `min-width: 200px`（统一改 180→200，宽节点更稳）；删除任何 `min-height`，让 header + rows 自然撑起；status 边框 / loop-body 蓝边 / 选中边 / wrapper dashed border 全保留。
6. **保留**：`.react-flow__edge-interaction { pointer-events: stroke }` 与 catch-all `.canvas-node__handle--catchall` 既有内联规则。

**Size**：S（约 50 行 CSS 替换）

**Deps**：T1（DOM class 名同步）

**Output**：styles.css 一段 diff；视觉 dev server `bun run --filter @agent-workflow/frontend dev` 起来肉眼验。

### RFC-006-T3：单元测试更新 + 新增

**文件**：

- `packages/frontend/tests/canvas-port-handles.test.tsx`（既有，按 design §4.1 更新断言路径 + 新加 6 个 case）
- `packages/frontend/tests/canvas-port-label-not-floating.test.ts`（新增，按 design §4.2 源代码层兜底）

**做什么**：

1. 既有 4 个 catch-all case：把选择器 `.canvas-node__ports--left > [data-handleid]` 改成 `.canvas-node__inbound-catchall > [data-handleid]`；命名 handle 的选择器改成 `.canvas-node__port-row [data-handleid="{port}"]`。
2. 新加 7 个 case（验收 1 / 2 / 3 / 5 / 7 — 见 design §4.1）。
3. 新增源代码兜底文件：fs 读 styles.css 与 PortHandles.tsx，正则锁旧 marker 不再存在 + 新 marker 存在。文件顶部注释链回本 RFC + commit hash（commit 落地后填）。

**Size**：S（~10 个新断言 + 6 个选择器更新）

**Deps**：T1, T2

**Output**：vitest 全绿；新增 1 个测试文件、扩展 1 个测试文件。

### RFC-006-T4：Playwright e2e 扩展

**文件**：

- `e2e/main.spec.ts`

**做什么**：在 task 详情页 `.status-chip` 渲染完后，新加一段 `page.evaluate` 取所有 `.canvas-node__port-label` 的 boundingClientRect 与所属节点矩形比较，断言 label 完全落在节点内（design §4.3 代码片段）。

**Size**：XS（10 行 e2e 断言）

**Deps**：T1, T2

**Output**：`bun run e2e` 本地与 CI 上 chromium 全绿；附带 macOS + Ubuntu 矩阵自动验。

### RFC-006-T5：STATE.md + 文档同步

**文件**：

- `STATE.md` — 顶部"最近更新"行替换为 RFC-006 落地总结；"已完成 RFC"表追加新行
- `design/plan.md` — RFC 索引表新增 RFC-006 行（落档时先 Draft，PR 合并后 Done）

**做什么**：

1. RFC 三件套提交时（不写代码阶段）：`design/plan.md` RFC 索引加 `[RFC-006](...)`/`节点端口呈现重构`/`Draft`；`STATE.md` 顶部加"进行中 RFC"行。
2. 实施 PR 合并时：STATE.md "最近更新" 顶行替换 + "已完成 RFC" 表追加 RFC-006 行（按既有 RFC 行的丰度写一段密度高的关键产出文本）；design/plan.md RFC 索引 RFC-006 状态改 Done。

**Size**：XS

**Deps**：T1-T4 全绿

**Output**：两文件更新；按 CLAUDE.md "RFC workflow §4" 强约束。

## 2. PR 策略

- **PR 1 — RFC 三件套（本批）**：仅含 `design/RFC-006-node-port-ux-cleanup/` 三 md + `design/plan.md` 加索引行 + `STATE.md` 加"进行中 RFC"行。零代码改动。等用户审。
- **PR 2 — 实施**：T1+T2+T3+T4+T5。单 commit 或 squash 合一；commit message 前缀 `feat(canvas): RFC-006 节点端口呈现重构 + 行内布局 + 长名截断`。预计 ~150 行 frontend diff + ~80 行测试 + STATE.md / plan.md。

PR 拆分的判据：本 RFC 改的就是同一个 `PortHandles` + 配套 CSS + 测试，没有任何"先合接口，再合实现"的契约耦合；单 PR 反而对评审最友好（一眼看完前后视觉效果 + DOM + CSS + 测试齐全）。

## 3. 风险 & 应对（执行阶段）

参考 proposal §5，无变化。补一条执行细节：

- **xyflow Handle 位置可能因 CSS specificity 不被覆盖**：T2 写好 CSS 后 `bun run --filter @agent-workflow/frontend dev` 手动打开画布肉眼验 handle 是否在 row 边缘；若偏离，在 `.canvas-node__port-row .react-flow__handle-{left,right}` 规则上加 `!important`（与既有 `.canvas-node__handle` 已用 `!important` 同模式，不破坏现有约定）。

## 4. 验收清单（PR 2 落地前对照）

- [ ] PortHandles 新 DOM 结构按 design §3.1 实现；catch-all 拆为节点直系 sibling。
- [ ] 5 个节点组件调用点不变，typecheck 全绿。
- [ ] CSS 旧 `.canvas-node__port` / `.canvas-node__ports--*` 绝对定位规则全部删除；新 `.canvas-node__port-rows` 行内布局规则全部加。
- [ ] port label `max-width: 140px` + `ellipsis` + `title={port}` 兜底；font / 颜色与既有 muted 文本一致。
- [ ] `canvas-port-handles.test.tsx` 既有 4 case + 新 7 case 全绿。
- [ ] `canvas-port-label-not-floating.test.ts` 新文件落地、源代码层断言锁住。
- [ ] e2e `main.spec.ts` 新增 label-inside-node 断言落地，本地 + CI 全绿。
- [ ] 手工：本地起 dev server，画一个含 input + agent-multi（≥4 outputs）+ output 的 workflow，肉眼验：
  - [ ] 端口名都在节点矩形内，不盖 title / id
  - [ ] 拉一条新边到 fresh agent 仍能落到 catch-all 上（RFC-003 不退化）
  - [ ] 选中节点 / 选中边 / 右键菜单 / 拖拽全部正常
  - [ ] 长端口名（>20 字）显示 ellipsis，hover 出 tooltip
- [ ] `bun run typecheck && bun run test && bun run format:check` 三项全绿
- [ ] Push 后立刻按 [feedback_post_commit_ci_check] 查 GitHub Actions（含 build-binary + Playwright e2e 矩阵），全绿才算交付
- [ ] STATE.md "已完成 RFC" 表加 RFC-006 行（按现有行的密度写关键产出）；"进行中 RFC" 行删掉；"最近更新" 顶行替换为本 RFC 落地总结
- [ ] `design/plan.md` RFC 索引 RFC-006 状态改 Done

## 5. 估时

- T1（PortHandles + 节点组件）：30 min
- T2（CSS）：20 min（含 dev server 肉眼验）
- T3（vitest）：30 min
- T4（e2e）：15 min
- T5（STATE.md / plan.md）：10 min
- Push + CI 验证：5-15 min

总计 ~2 小时单 PR 落地。

## 6. 后续可能的拓展（明确**不在**本 RFC 范围）

- **zoom-out 阈值下 label 折叠为 dot-only**（n8n-style）：若用户反馈 >50% zoom-out 时画布仍信息过密，可开 RFC-007。
- **端口分组**（按 input / output 之外再加分类，如 "control flow" vs "data flow"）：如果未来 NodeKind 增多有需要，独立 RFC。
- **超 12 端口节点的纵向 scroll**：v1 不需要（实际最多 5-6 端口）。
- **handle dot hover 态变化 / 拖拽中变色**：可选打磨，不必走 RFC。
- **暗色主题端口可视性微调**：随暗色主题统一打磨。
