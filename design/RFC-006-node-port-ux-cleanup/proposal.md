# RFC-006 Proposal — 节点端口呈现重构：消除标签遮挡 + 行内布局 + 长名截断

> 状态：Draft（2026-05-15）
> Owner：—
> 关联文档：[design.md](./design.md)、[plan.md](./plan.md)

## 1. 背景

当前 workflow 编辑器与 task 详情画布共用 `WorkflowCanvas` + `PortHandles`。`PortHandles` 把每个端口名字（`<span class="canvas-node__port-label">`）渲染成一个**绝对定位的小标签**，挂在节点边缘的 12px 宽竖条上（`left: -6px` 或 `right: -6px`），再以 `5%..95%` 等分的 `top: %` 散布在节点整个高度上。代码位置 `packages/frontend/src/components/canvas/nodes/PortHandles.tsx:21-55` + `packages/frontend/src/styles.css:1643-1693`。

实际效果有三类直接可见的丑：

1. **标签反向溢出，盖住节点内容**：left side 的 `.canvas-node__port` 是 `position: absolute; left: 0; flex-direction: row`，handle 在前、label 在后，标签从节点左边 `-6px` 开始向右铺开，会**覆盖**节点 `header / nodeId`；right side 同样以 `right: 0; flex-direction: row-reverse` 从右边 `-6px` 反着铺，长名时直接糊上 `title`。这是这次工单里用户说的"输入输出名字把节点信息都盖住了"的精确成因。
2. **多端口时纵向乱**：等距 `5%..95%` 让 4 端口的节点把 label 顶到与 `header` 同高度的位置，与 title 文字直接重叠。agent-multi 节点天然多 outputs（每个 shard 一条 + `errors`），重灾区。
3. **长名失控**：端口名是 agent frontmatter 的 `outputs` 项 / port name，业务里经常出现 `code_review_findings`、`design_doc_markdown`、`pre_iteration_summary` 这种 20+ 字符的 snake_case 名，没有截断也没有 tooltip，直接把相邻节点的视觉空间挤掉。

业界 xyflow 上的成熟做法（Dify / Langflow / ComfyUI 均验证过）是把端口做成**节点 body 内部的行**：handle dot 钉在 body 边缘，label 与 dot 同一行、文字方向朝节点中心、超长用 `text-overflow: ellipsis` + `title` 兜底。节点高度自然随端口数量增长，永远不会反向溢出去盖标题。n8n 走极端只在 hover 时显示文字，对我们 1 屏多节点的编排场景不够直观；Dify 风格信息密度刚好。

### 1.1 为什么是现在

- v1 81/81 全部 Done + RFC-001~004 把"功能性"洞补完之后，编辑器进入打磨周期；这是用户在 canvas 上一打开第一眼就看到的视觉问题，挡视觉验收。
- 与 RFC-003 的 catch-all 左侧 inbound handle、RFC-004 的 input 端口契约同区域，趁热把同一 layer 的 UX 一次性清干净，避免后面再来动 `PortHandles` 时撞坑。
- 不阻塞任何后续 RFC（RFC-005 的人工评审节点也用 `PortHandles`，越早收口越好）。

### 1.2 本 RFC 不动哪些地方

- **不动**节点种类（NodeKind 仍是 input / output / agent-single / agent-multi / wrapper-git / wrapper-loop 六类，外加 RFC-005 在审的 review 第七类——本 RFC 的 PortHandles 重构会自动覆盖 review 节点）。
- **不动**端口语义、连边语义、`source.portName` / `target.portName` 契约、RFC-003 catch-all 行为、RFC-004 input 端口契约。**只改渲染层**。
- **不动**后端 / scheduler / runner / DB schema / YAML / 任何 API 契约。
- **不动**边（edge）样式、edge label 渲染、palette、sidebar、NodeInspector、ContextMenu。
- **不引入**新的 NodeKind、新的 prop、新的 DB 列、新的 i18n key（端口名沿用 frontmatter 自动写入，不需要翻译）。
- **不做** auto-layout、不做 mini-map 重设计、不做 dark-mode 调色板再过、不做缩放阈值下的"端口折叠"模式。这些都是独立 RFC 的料。

## 2. 目标

### 2.1 做

1. **行内化端口标签**：把 `<span class="canvas-node__port-label">` 从"绝对定位浮在节点外缘"改为"节点 body 内部、按端口数量横向排成一行的 flex row"。Label 朝节点中心、handle dot 钉在 row 的外侧边缘。
2. **节点高度随端口数自适应**：删掉 `5%..95%` 等距铺布，改成行高固定（≈22px）的纵向 stack；节点 `min-height` 由 header + rows 自然决定，N 个端口就 N 行；不依赖节点显式高度。
3. **长名截断 + tooltip 兜底**：label 上 `max-width: 140px` + `text-overflow: ellipsis` + `overflow: hidden` + `title={port}` 原生 tooltip。鼠标移上去看完整名，不用打开 NodeInspector。
4. **保留 RFC-003 catch-all**：左侧 12px 宽 z-index 0 的隐形 inbound 接收带继续存在；命名 handle z-index 1 优先命中。catch-all 不与新行内布局位置冲突——它仍然占节点左边缘的"竖条"，不参与 rows flow。
5. **任务详情画布同步受益**：因为 task 详情走的就是同一份 `WorkflowCanvas` + `PortHandles`（`packages/frontend/src/routes/tasks.detail.tsx:309-323`），无需额外改动，渲染层一次修两个面。
6. **回归测试落档**：扩 `tests/canvas-port-handles.test.tsx`，外加一条源代码层兜底断言（按 [feedback_post_commit_ci_check] 的 fallback 模式）锁住"`.canvas-node__port-label` 不得位于 `.canvas-node` 节点 DOM 之外"。

### 2.2 不做（明确划出去）

- 不引入 zoom-out 阈值下的"label 折叠为 hover-only"模式（n8n 风格）。先做基础修复，需要时再开 RFC-007。
- 不重画 handle dot 的形状 / 配色 / hover 态变化。当前 8px 圆 + accent 色 + 2px panel 描边保留，仅调位置。
- 不动 wrapper-git / wrapper-loop 的"内部节点 N 个"提示文案与 i18n key。
- 不动 NodeInspector 内端口编辑 UI（已经是规范表单，不溢出）。
- 不重写 `EdgeInspector` / 不改 edge 在画布上的渲染（edge label / 颜色 / arrow head 一律不动）。
- 不针对超过 8 个端口的 agent-multi 做"折叠 + scroll"——v1 里实际端口数都在 4 以内（per-file / per-N-files / per-directory + 父节点 `errors`），8 行内的纵向堆叠绰绰有余。如果后续真出现超 12 端口的节点，再开 RFC。

## 3. 用户故事

### 3.1 编排作者：在画布上一眼能看清

> 我拖出一个 agent-multi 节点（per-file sharding），它默认有 `code_review_findings` + `errors` 两个 output port。当前画布上这两个 label 一上一下从节点右边缘 **覆盖在节点 title 上**，标题 `Code Auditor` 被吃掉一半。我想要 label 整齐排在节点 body 内部、不盖标题、超长自动截断显示 `code_review_fin…`，鼠标停一下能看完整名。

### 3.2 任务观察者：在 task 详情画布上看跑批进度

> 任务详情用 read-only 模式渲染同一画布，N 个节点边缘的标签在不同 zoom 下相互压字、压跑批状态边框颜色（绿 / 红 / 黄）。我希望状态色框完整可见，标签不再溢出节点边界。

### 3.3 设计师 / 用户：导出 / 截屏 / 演示

> 我想把工作流截图贴在评审文档里，当前截图节点外面挂着一圈乱飞的小标签，看起来非常不专业。我希望节点是一个 self-contained 的矩形，所有端口名字都在矩形内部，截屏出去就像 Dify / Langflow 那种规整的卡片。

## 4. 验收标准

每条都写成可在 CI 中跑绿 / 跑红的断言：

1. **端口标签 DOM 必须位于节点矩形内部**：vitest + JSDOM 渲染 `AgentNode` 含 3 输入 + 4 输出，断言每个 `.canvas-node__port-label` 的 `parentElement` 链上能找到包含该 label 的 `.canvas-node`，且 `.canvas-node__port-label` 元素的 `offsetParent` 不是 `.canvas-node__ports--*` 的旧绝对定位 strip。
2. **header 不被遮**：同一渲染输出里，`getComputedStyle(.canvas-node__header).zIndex` 与 label 的 z-index 行为下，label DOM 不与 header DOM 在文档流上重叠（行内布局保证此条天然成立——用 `compareDocumentPosition` 断言 label 节点出现在 header 节点**之后**）。
3. **长名截断**：渲染一个 `outputPorts=['code_review_findings_summary']` 的节点，断言对应 `<span>` 元素带 `class*="port-label"`，其内联或计算后样式含 `text-overflow: ellipsis`（用 `getComputedStyle(...).textOverflow === 'ellipsis'`）且 `title` 属性等于原始 port name。
4. **catch-all 仍可命中**：复用 `tests/canvas-port-handles.test.tsx` 既有 4 个 catch-all case 全部保持绿（RFC-003 验收回归）。
5. **多端口高度自适应**：渲染含 6 outputs 的 agent-multi，断言节点 DOM `clientHeight` ≥ header 高 + 6×22px（保证每行可读）；同样的节点改为 1 output 时 `clientHeight` < 第一种情况（说明高度真的随端口数量缩放，不是固定 200px+）。
6. **任务详情画布同样修好**：playwright e2e（在现有 `e2e/main.spec.ts` 里加一条断言）跑通任务详情打开后 `.canvas-node__port-label` 全部在所属 `.canvas-node` 边界内，使用 `page.evaluate` 比较 `getBoundingClientRect`。
7. **源代码层兜底**：新增 `tests/canvas-port-label-not-floating.test.ts`（fs.read + 正则），锁住 `styles.css` 里 `.canvas-node__port` 不再含 `position: absolute`、`.canvas-node__ports--{left,right}` 不再以 `left: -6px / right: -6px` 把整条 strip 推到节点外侧。文件顶部注释链回本 RFC + commit hash，未来 refactor 一旦把它弄红能立刻看出意图。
8. **三件套全绿**：`bun run typecheck && bun run test && bun run format:check` 全过；`feedback_post_commit_ci_check` 推 push 后 GitHub Actions（含 build-binary + playwright e2e）落地绿。

## 5. 风险与回滚

- **风险 1：xyflow `<Handle>` 在新 DOM 结构下定位偏移**。xyflow `<Handle>` 用 `getBoundingClientRect` 计算 edge 起止点；只要 Handle DOM 实际渲染在 row 的视觉边缘位置上，连边就准。design.md §3 给出 row 用 `position: relative` + Handle 绝对定位到 row 右/左侧 `-6px` 的具体 CSS；并强制在节点端口数量变化时调用 `useUpdateNodeInternals(nodeId)` 通知 xyflow 重算（已有节点改 outputs 数量时也需要）。
- **风险 2：现有 edges 渲染断开**。Handle 的 `id` 属性不变（仍是 port name），xyflow 用 id 而非位置匹配，所以已存的 workflow 边不会断。回归用 `tests/canvas-port-handles.test.tsx` 已有 catch-all + named handle 联流断言覆盖。
- **风险 3：节点更大占地导致旧布局拥挤**。本 RFC 不改 auto-layout（仍是用户手动摆），节点变高一点点（每端口 ~22px）属于可接受改动；如果出现 4+ 个端口节点跨进相邻边，让用户手动移开即可。
- **回滚**：本 RFC 单 PR，纯 frontend 渲染层。出问题直接 `git revert` 即恢复旧布局；任何 workflow / task 数据完全不受影响。

## 6. 工业参考

- **Dify**（xyflow v12 同栈）：节点行内端口 + 钉边缘 handle + 长名 ellipsis 是其标准卡片样式，确认与本 RFC 拟采用方案 1:1。
- **Langflow**：同样 xyflow + 行内 label，handle 用稍大点的圆形（10px）方便拖拽。
- **ComfyUI**：节点 body 内部按 input/output 分两栏，handle 钉边缘，label 朝中心；与本 RFC 思路一致，但 ComfyUI 把 label 与 input 控件混排，超出本 RFC 范围。
- **n8n**：极简 dot-only，hover 才显字；信息密度太低，本 RFC 拒绝。
- **xyflow 官方 examples**："Custom Node" / "Node with Multiple Handles" / "Stress Test" 三个例子均演示 row-inside-body 的 handle 渲染，与本 RFC 方案路径一致。
