# RFC-006 Design — 节点端口呈现重构

> 状态：Draft（2026-05-15）
> 关联：[proposal.md](./proposal.md)、[plan.md](./plan.md)
> 关联 RFC：[RFC-003](../RFC-003-canvas-input-port-wiring/proposal.md)（catch-all inbound handle）、[RFC-004](../RFC-004-input-port-contract/proposal.md)（input 节点端口契约）。本 RFC 不变更两者的语义，只重构同一层的视觉呈现。

## 1. 目标范围

仅影响 `packages/frontend/src/components/canvas/nodes/` 下的 5 个文件 + `packages/frontend/src/styles.css` 一段：

- `PortHandles.tsx` — 渲染层重写
- `AgentNode.tsx` / `InputNode.tsx` / `OutputNode.tsx` / `WrapperNodes.tsx` — 调整组件内 DOM 结构以容纳新 PortHandles
- `styles.css` § "Custom canvas nodes" 段（1555-1720 行附近） — CSS 重写
- `types.ts` — 不改

**零改动**：后端 / runner / scheduler / DB / API / YAML / NodeInspector / EdgeInspector / WorkflowCanvas 主组件 / palette / sidebar / ContextMenu / i18n bundle / Edge 渲染。

## 2. 现状分析

### 2.1 现行 DOM 结构（来自 `AgentNode` + `PortHandles`）

```
.canvas-node                                ← position: relative
  .canvas-node__header                      ← 节点 body 内容
    .canvas-node__kind                      ← "agent" / "🔀 agent-multi"
    .canvas-node__title                     ← agent name
  .canvas-node__id                          ← node id (mono font)
  .canvas-node__ports.canvas-node__ports--left   ← position: absolute; left: -6px; width: 12px; top:0; bottom:0
    <Handle catchall />                     ← 12px wide invisible strip, z-index 0
    .canvas-node__port.canvas-node__port--left   ← position: absolute; left: 0; top: {5..95}%
      <Handle />                            ← 8px dot
      .canvas-node__port-label              ← bordered chip; flex-direction: row → 从 dot 往右扩
  .canvas-node__ports.canvas-node__ports--right  ← position: absolute; right: -6px
    .canvas-node__port.canvas-node__port--right
      <Handle />
      .canvas-node__port-label              ← flex-direction: row-reverse → 从 dot 往左扩
```

### 2.2 为什么 label 会盖 body

- `.canvas-node__ports--left` 的 `left: -6px` 使其外缘从节点边再往外突 6px；strip 宽 12px，因此 strip 占据节点 `[-6px, +6px]` 区间。
- 内部 `.canvas-node__port` 用 `flex-direction: row`：handle 是 row 第一项（左边 dot），label 是第二项（**右边**文字）。Strip 的内容流右边 = 节点 `+6px..`，所以 label 文字向节点中心方向延伸，**覆盖 body**。
- right side 完全对称：`.canvas-node__ports--right { right: -6px }` + `flex-direction: row-reverse` → 文字向左、向节点中心、覆盖 body。

简单说：**dot 是钉对了边缘，但 label 装错了方向**——它应该向**节点外侧**或者**节点 body 内部 row 内的可见区域**展开，而不是向节点中心展开撞 body。当前撞 body 是必然结果。

### 2.3 等距 5%..95% 的副作用

`PortHandles` 在多端口情况下用 `top: 5 + step * i` 等距铺布，节点高度由 header + id 自然撑起约 64px。两 outputs 时第一项 top=5%（节点顶端，与 `.canvas-node__kind` 同高）、第二项 top=95%（节点底部）。**自然把第一个 label 顶到 kind 字段的行高度**——这是用户截图里"端口名压标题"的另一半成因。

## 3. 新设计

### 3.1 新 DOM 结构

```
.canvas-node                                    ← position: relative（不变）
  .canvas-node__header                          ← 不变
    .canvas-node__kind
    .canvas-node__title
  .canvas-node__id                              ← 不变
  .canvas-node__port-rows                       ← 新增容器：display: flex; flex-direction: column; gap: 4px; margin-top: 8px
    .canvas-node__port-row                      ← 一行端口；position: relative; height: 22px; display: flex; align-items: center
      .canvas-node__port-row--left              ← justify-content: flex-start
        <Handle id={p} position=Left type=target /> ← 钉到 row left:-6px（CSS override）
        .canvas-node__port-label                ← 行内 label；max-width: 140px; ellipsis; title=p
      .canvas-node__port-row--right             ← justify-content: flex-end
        .canvas-node__port-label
        <Handle id={p} position=Right type=source /> ← 钉到 row right:-6px
  .canvas-node__inbound-catchall                ← 不变：position: absolute; left:-6px; top:0; height:100%; width:12px; z-index 0
    <Handle id="__inbound__" />                 ← 全节点高的隐形 inbound 接收带（RFC-003）
```

关键点：

- **左右两侧的 port 用同一个垂直 stack**——不像旧版分两个绝对定位 strip。左侧端口排在上半段、右侧排在下半段（按 row 的子组件区分），或交错排（按出现顺序自然分组）。**v1 决定按"输入行块在前、输出行块在后"两段渲染**，与读图习惯一致（左进右出 → 上输入、下输出）。在 agent / wrapper-loop 节点上两段都存在；input / wrapper-git 节点只有输出段；output 节点只有输入段。
- **每行 row 高度固定 22px**：足够容纳 8px handle dot + 11px font label，外加 6-8px padding，整体落在 22px。
- **Handle 钉到 row 边缘**：xyflow `<Handle>` 默认 `position: absolute`，定位锚为 nearest `position: relative` 祖先。把 `.canvas-node__port-row` 设为 `position: relative`，然后在 CSS 里强制：
  ```css
  .canvas-node__port-row .react-flow__handle-left {
    left: -6px;
    top: 50%;
    transform: translateY(-50%);
  }
  .canvas-node__port-row .react-flow__handle-right {
    right: -6px;
    top: 50%;
    transform: translateY(-50%);
  }
  ```
  由于 row 横向铺满 body 宽度，handle 的视觉位置就落在节点 body 边缘 ± 6px，与现状一致。
- **catch-all 不变**：依然作为 `.canvas-node` 直系 sibling 渲染，全节点高的 12px 隐形带，z-index 0 < row 内具名 handle 的 z-index 1。本 RFC 不改它。

### 3.2 PortHandles 组件签名变化

```tsx
interface Props {
  side: 'left' | 'right' // 保留：调用方决定是上半段（input）还是下半段（output）
  ports: string[]
  catchAll?: { id: string } // 保留：只 side='left' 时被尊重
}
```

签名**不变**，调用方代码（AgentNode / InputNode / OutputNode / WrapperNodes）都不动。内部渲染按新 DOM 结构产出。

`AgentNode` 现在调用 `<PortHandles side="left" />` 和 `<PortHandles side="right" />`；新实现下，两个 PortHandles 在 DOM 上是上下相邻的两个 `.canvas-node__port-rows` 容器（外加左侧那个 catch-all sibling）。

如果之前 PortHandles 用 `position: absolute` 把整个 strip 浮在节点外侧，新 PortHandles 改回正常文档流（让父节点高度自然撑起）。

### 3.3 catch-all 渲染时机

旧实现：catch-all `<Handle>` 是 `.canvas-node__ports--left` 的第一个子元素，与具名端口的 strip 共享同一个绝对定位容器。

新实现：catch-all 拆出来，作为 PortHandles 的旁路 DOM 元素：

```tsx
return (
  <>
    {showCatchAll && (
      <div className="canvas-node__inbound-catchall">
        <Handle type="target" position={Position.Left} id={catchAll!.id} aria-hidden />
      </div>
    )}
    <div className={`canvas-node__port-rows canvas-node__port-rows--${side}`}>
      {ports.map(p => <Row .../>)}
    </div>
  </>
)
```

注意 `<>` 是 Fragment，PortHandles 自身不再有外层 wrapper div。`AgentNode` 串两个 PortHandles → 一个 catch-all div + 一个 input rows div + 一个 output rows div，由 `.canvas-node` 顺序排布。

### 3.4 长名截断

```css
.canvas-node__port-label {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--muted);
  padding: 0 4px;
  /* 去掉旧 chip 的 border + background — body 内部本身就有视觉边界 */
}
```

`title={port}` 在每个 `<span>` 上挂上原始 port name，鼠标 hover 时浏览器原生 tooltip 浮出。无需引入 Radix Tooltip / 自研 floating UI。

140px 阈值的选择：5%-tile 长 port name 实测约 18 字符 → 11px monospace × 0.6 字宽 ≈ 130px；140px 留 buffer。超 140px 截断后能识别前缀（多数 port name 前缀已经够唯一）。

### 3.5 xyflow 集成

- **节点高度变化通知 xyflow**：xyflow 内部用 `ResizeObserver` 监听节点 DOM，多端口让节点更高，xyflow 会自动重算 edge 起止点。Handle 位置改变（id 不变）也会被同观察捕获。**无需手动调用 `useUpdateNodeInternals`** —— 测试时若发现连边偏移再加。
- **Handle id / type / position 不变**：现存 workflow 的 edges 完全兼容，xyflow 按 id 匹配。
- **selection / drag / connect 行为**：CSS 不动 `.canvas-node` 的 `cursor` 与 xyflow 注入的 `react-flow__node` class，drag handle 默认整个节点可拖；新增 row 不带 `nodrag` class，不影响拖拽。需要确认：在 row 内部用 mousedown 是否会被 xyflow 当作起边——`<Handle>` 自带 `nodrag` 行为，xyflow 在 Handle dot 上才起边、在 row 别处就拖节点，符合预期。

### 3.6 节点 min-width / min-height 调整

旧值：`.canvas-node { min-width: 180px }`、`.canvas-node--wrapper { min-width: 200px }`。

新值：保持 `min-width: 200px`（统一）、删除任何固定 `min-height`（让 header + rows 自然撑高）。`min-width: 200px = 12px (right handle 突出) + 140px label max + 24px padding + 12px left handle 突出 + buffer`。

### 3.7 与现有模块的耦合点

| 模块                          | 耦合                                      | 影响                                                                                                                                                                                                                                                  |
| ----------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RFC-003 catch-all             | catch-all DOM 拆出 PortHandles 内层       | 渲染条件 / id 不变；既有 `canvas-port-handles.test.tsx` 4 个 catch-all case 仍生效，但选择器从 `.canvas-node__ports--left > .react-flow__handle` 变成 `.canvas-node__inbound-catchall > .react-flow__handle`。需要更新断言路径，注释保留 RFC-003 出处 |
| RFC-004 input 节点端口契约    | inputKey 的 port name 仍以 label 形式渲染 | 完全兼容，无额外改动                                                                                                                                                                                                                                  |
| EdgeInspector                 | 边端口名 source/target.portName           | 不动，与 PortHandles 渲染无关                                                                                                                                                                                                                         |
| NodeInspector                 | 通过 onChange 改 outputPorts              | 端口数变化触发 React 重渲，xyflow ResizeObserver 自动跟进，无 staleness                                                                                                                                                                               |
| WorkflowCanvas.handleConnect  | 连边时读 Handle id                        | id 不变，照常工作                                                                                                                                                                                                                                     |
| tasks.detail TaskStatusCanvas | 复用 WorkflowCanvas read-only             | 自动受益，无改动                                                                                                                                                                                                                                      |

### 3.8 失败模式 & 应对

| 失败模式                                                | 检测                                                           | 应对                                                                                   |
| ------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Handle CSS 被 xyflow 默认样式覆盖导致 dot 不在 row 边缘 | 渲染断言 `getBoundingClientRect()` of handle vs row right edge | 用 `!important` 强压（参考现状 `.canvas-node__handle { background: ... !important }`） |
| 8 端口节点行高累加超过 200px                            | 多端口快照测试                                                 | min-height 不设，自然支持；如果未来 12+ 端口出现，开 RFC-007 引入 scroll               |
| 已存 workflow 加载后边连不上 Handle                     | playwright 现有 `main.spec.ts` 路径                            | id 不变，理论不存在；e2e 兜底                                                          |
| 长名截断让两个 port 看起来相同（前缀相同时）            | hover tooltip 仍能区分                                         | 接受；用户改名是 NodeInspector 的事                                                    |
| catch-all 与第一行 input row 视觉重叠                   | DOM 渲染 + 视觉对比                                            | catch-all 完全透明、绝对定位，不占文档流；与 row 不冲突                                |

## 4. 测试策略

按 CLAUDE.md "Test-with-every-change" 强约束，所有新 / 改测试用例随 PR 一并落地：

### 4.1 单元测试（vitest + JSDOM）

**扩展** `packages/frontend/src/components/canvas/nodes/tests/canvas-port-handles.test.tsx`（如该文件不存在按现工程结构落在 `packages/frontend/tests/`）：

1. **`label is inside node DOM`**（新加）：渲染 `AgentNode` with `inputPorts=['x']` + `outputPorts=['y']`，断言两个 `.canvas-node__port-label` 都能用 `.canvas-node`.contains() 命中；断言它们的 `closest('.canvas-node__port-rows')` 不为 null。
2. **`label not overlapping header (document order)`**（新加）：同上节点，断言 label DOM `compareDocumentPosition(header)` 返回 `DOCUMENT_POSITION_PRECEDING`，即 label 在 header **之后**渲染（行内布局保证 z-index 不冲突）。
3. **`long port name truncated with title`**（新加）：渲染 `outputPorts=['code_review_findings_summary']`，断言 `<span>` 元素 `getAttribute('title') === 'code_review_findings_summary'`，且 `getComputedStyle(...).textOverflow === 'ellipsis'`。
4. **`catch-all preserved at left edge`**（RFC-003 回归改写）：渲染 AgentNode，断言 `.canvas-node__inbound-catchall` 存在且包含一个 `<Handle id="__inbound__" />`，且该元素仍在 `.canvas-node` 内但**不在** `.canvas-node__port-rows` 内（DOM 拆分正确）。
5. **`named handle takes priority over catch-all (z-index)`**（RFC-003 回归）：断言 row 内 handle 的 `getComputedStyle.zIndex >= '1'`，catch-all 的 `zIndex === '0'`。
6. **`node height scales with port count`**（新加）：渲染两个相同 AgentNode 但 outputs 数量 1 vs 6，断言后者 `offsetHeight > 前者 + 5 * 22`（5 行高差）。注意 JSDOM 不真正布局，必要时 fallback 到断言"6 个 `.canvas-node__port-row` 都被渲染"。
7. **`right-side handle stays on right`**（新加）：渲染 output port 节点，断言对应 row 的 className 含 `canvas-node__port-row--right`；左侧同理。

### 4.2 集成 / 源代码层兜底测试

**新增** `packages/frontend/tests/canvas-port-label-not-floating.test.ts`：按 [feedback_post_commit_ci_check] 强调的"运行时巨型组件难直接覆盖时，最低限度也要保留一条源代码层文本断言"模式，文件顶部注释：

```ts
// Locks in RFC-006 visual fix: port labels must live INSIDE the node body
// (.canvas-node), not on an absolutely-positioned strip that overflows
// onto the node body. If a future refactor reintroduces the old
// `position: absolute; left: -6px` strip-of-chips layout, this test will
// fail. Link: design/RFC-006-node-port-ux-cleanup/design.md
```

断言：

- 读 `packages/frontend/src/styles.css`，正则匹配 `.canvas-node__port {`-block 与 `.canvas-node__ports--left { left: -6px`-block，**任一存在即失败**（说明旧布局没拆掉）。
- 读 `packages/frontend/src/components/canvas/nodes/PortHandles.tsx`，断言其中包含 `canvas-node__port-rows` 字串（说明新结构存在）；断言其中**不**包含 `flex-direction: row-reverse` 字串（旧布局 marker）。
- 这条测试运行时不依赖 React / xyflow，纯 fs 读 + 正则；CI 上 ms 级跑。

### 4.3 Playwright e2e

**扩展** `e2e/main.spec.ts`：现有 happy-path 是 input → agent_1 → output 三节点跑通。新加一步——在 task 详情页 (`/tasks/{id}`) 加载完成后：

```ts
const overflowing = await page.evaluate(() => {
  const labels = document.querySelectorAll('.canvas-node__port-label')
  const out: { port: string; ok: boolean }[] = []
  for (const l of labels) {
    const node = l.closest('.canvas-node')
    if (!node) {
      out.push({ port: l.textContent ?? '?', ok: false })
      continue
    }
    const lr = l.getBoundingClientRect()
    const nr = node.getBoundingClientRect()
    out.push({ port: l.textContent ?? '?', ok: lr.left >= nr.left && lr.right <= nr.right })
  }
  return out
})
expect(overflowing.every((x) => x.ok)).toBe(true)
```

这条断言**直接量住**"label 视觉边界落在节点矩形内"，是验收标准 #1 / #6 的真实回归保护。

### 4.4 既有测试保持绿

- `canvas-port-handles.test.tsx` 既有 4 个 catch-all + 1 个 side=right 不渲染 case 全保持绿（断言路径有更新）。
- `canvas-connect.test.ts` 10 case 全保持绿（id 不变，连边语义不变）。
- `canvas-edge-inspector.test.tsx` / `canvas-missing-refs.test.ts` 不受影响。
- backend 全套 / e2e happy-path 全保持绿。

### 4.5 验证门槛

按 CLAUDE.md：`bun run typecheck && bun run test && bun run format:check` 三项必须全绿；GitHub Actions 同样跑这三项 + build-binary + Playwright e2e。Push 后立刻按 [feedback_post_commit_ci_check] 查 CI 状态。

## 5. 兼容性 / 迁移

- **零数据迁移**：纯渲染层改动，不涉及 DB / YAML / API / workflow definition。
- **零 i18n 改动**：端口名从未走 i18n（用户字面值），label 渲染逻辑不需要翻译。
- **selectors 失效风险**：用户外部脚本 / 测试如果用了 `.canvas-node__port` 选择器会失效。**项目内自有测试均同步更新**（4.1 / 4.2 已列）。外部第三方扩展按"扩展自带向后兼容义务"原则不保。CHANGELOG 在 STATE.md 已完成 RFC 表对应行注明 CSS class breaking。

## 6. 不需要 RFC 之外讨论的事

- 节点配色 / 状态色：完全保留 `data-status` 现行调色板。
- Wrapper 节点的 "N inner nodes" 文案：完全保留。
- ContextMenu / 拖拽 / 复制粘贴 / 选区行为：完全保留。
- xyflow 版本：v12，不动。
- 与 RFC-005（人工评审节点）的关系：RFC-005 引入的 review 节点也会用同一 `PortHandles`，本 RFC 完成后 review 节点自动享受新布局，无需 RFC-005 单独再做端口 UX。
