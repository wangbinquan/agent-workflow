# Codex Adversarial Review

Target: branch diff against b1ac247a
Verdict: needs-attention

NO-SHIP：白名单当前虽为空，但“硬失败”仍可被豁免；几何守卫在负 room、动态挂载、DOM churn 和 transform 下会假绿，静态守卫也可直接绕过。环内移还引入了未验证的对比度与强制色风险。

Findings:
- [high] 负 room 被直接跳过，已知被裁边反而不会上报 (e2e/focus-ring-clip.spec.ts:382-397)
  触发路径：可见控件在嵌套滚动容器内因负 margin、定位或部分滚动越过裁剪边超过 0.5px。此时 `room < 0` 已表示控件及其焦点环越界，但第 396 行在违规判定前跳过该边。自检甚至构造 `room.bottom === -1` 后只期待 `left/top`，把漏报固化成正确结果。结果是最贴近裁剪边的真实问题可以在“0 clipped”下通过。
  Recommendation: 实际聚焦并 `scrollIntoView` 后区分完全离屏元素与部分可见元素；对部分可见且 `room < ink` 的边一律报错。修改 overhang 自检，使 bottom 也必须被检出，并补嵌套滚动容器用例。
- [high] 一次性标记加伪类强制无法覆盖动态挂载和 portal，节点消失也只打印日志 (e2e/focus-ring-clip.spec.ts:593-634)
  `tag()` 只在扫描前执行一次，随后仅调用 `CSS.forcePseudoState`；它不会触发 React `onFocus`。例如 `UserPicker.tsx:151-161` 聚焦后才挂载 portal，`MultiSelect.tsx:282-295` 同样如此，因此后挂载的搜索框、选项按钮和其裁剪容器根本不进入候选集。扫描过程中 React 重建节点时，第 631-633 行只输出日志；只要同一 surface 还有一个控件存活，`measured > 0` 覆盖门仍会绿。
  Recommendation: 先真实调用 `focus()` 触发组件状态，再用 CDP 强制 `:focus-visible`；等待渲染后反复重新标记直到候选集稳定。节点消失必须重试或失败，并按 surface/state 校验预期控件身份和数量，而非仅校验非零。
- [high] 静态守卫并非设计要求的全表扫描，新类和分拆级联均可绕过 (packages/frontend/tests/focus-ring-inset.test.ts:190-203)
  守卫只检查选择器文本包含 `SCROLL_FLUSH` 中既有类名的规则；新增 `.new-full-width:focus`、已明确承认的 `.form-field input:focus` 或原生 CSS nesting 会被完全排除。即使包含 `.form-input`，更高优先级规则 `.scope .form-input:focus { outline-offset: 0 }` 也会因该规则体没有本地 `outline` 而跳过检查，浏览器却会与基础 outline 级联成外扩环。这与 design.md 要求的“所有焦点规则扫描 + 固有尺寸白名单”相反。
  Recommendation: 使用 PostCSS/Lightning CSS AST 解析选择器、嵌套和声明，按目标元素及级联优先级计算有效焦点样式；改成全表扫描、仅显式允许 intrinsic controls。加入新类、后代选择器、分拆级联、native nesting 和 4px outline 配 2px inset token 的变异测试。
- [high] 低透明度 inset 环不满足 Focus Appearance，forced-colors 下还会消失 (packages/frontend/src/styles.css:550-555)
  Select 使用 20% accent 的 2px inset shadow 并 `outline:none`；按当前主题 token 合成后，与控件底色的对比分别约为 1.33:1（浅色）和 1.51:1（深色）。`clarify-custom-input` 的 25% 版本也只有约 1.45:1/1.72:1。剩余实色边框仅 1px。[WCAG 2.4.13（AAA）](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html)要求相当于 2px 周长且变化对比至少 3:1，并明确说明 2px 内移环通常需增至 3px；这里达标面积不足。更严重的是 [W3C C40](https://www.w3.org/WAI/WCAG22/Techniques/css/C40)警告不要用 `outline:none` 加单独 box-shadow，而 [CSS Color Adjustment](https://drafts.csswg.org/css-color-adjust-1/)规定 forced-colors 中 box-shadow 计算为 `none`，当前强制色媒体规则也未覆盖这些控件。
  Recommendation: 改为至少 3px、实色且达到 3:1 的 inset 指示，或采用双层高对比方案；保留透明 outline 作为 forced-colors 回退，并在 `forced-colors: active` 下使用系统色。为浅色、深色及 Playwright forced-colors 增加可达性测试。
- [high] 所谓硬失败仍保留可让任意违规通过的 KNOWN_CLIPS 通道 (e2e/focus-ring-clip.spec.ts:953-959)
  Map 当前确实为空，但 `record()` 仍会静默丢弃命中 `KNOWN_CLIPS` 的违规，且没有断言 Map 必须为空；reason 值也从未校验。新增一条 key 即可重新变绿，失败文案甚至仍指导添加豁免。这不符合 proposal G4“清空后取消豁免机制、任何违规一律红”，因此实现仍停留在可恢复白名单阶段。
  Recommendation: 删除 `KNOWN_CLIPS`、过滤和 stale-waiver 分支，让所有 finding 无条件进入 blocking。若未来确需例外，应通过单独 RFC 变更守卫，而不是保留常驻逃生口。
- [medium] transform 后的矩形与未缩放的 ring 宽度处于不同坐标系 (e2e/focus-ring-clip.spec.ts:312-358)
  `getBoundingClientRect()` 得到应用祖先 transform 后的矩形，但 `outlineWidth`、`outlineOffset` 和 shadow 长度直接取未缩放的 computed CSS px。按 [W3C CSSOM View](https://www.w3.org/TR/cssom-view/) 的矩形定义可推断：在工作流编辑器允许的 `maxZoom={2}`（`WorkflowCanvas.tsx:2316-2318`）下，2px 环可绘成约 4 个视觉像素，而审计仍拿 2 与视觉 room 比较；节点或 badge 靠近 viewport 边缘时可假阴。当前 sweep 只测默认 fitView，没有 transform 自检。
  Recommendation: 把 ink 与 room 归一到同一坐标系，或用变换矩阵换算每边实际绘制宽度；新增 scale(2)、缩小、旋转及 transform 内嵌裁剪容器的自检，并扫工作流最小/最大 zoom 状态。
- [medium] 已知未覆盖的详情页仍被勾为 AC1 完成并标记 RFC Done (design/RFC-206-focus-ring-clip-elimination/plan.md:212-216)
  计划明确登记 `clarify.detail`、`skills.detail`、`mcps.detail`、`plugins.detail`、`scheduled.$id`、`fusions.detail` 未进入 ROUTES；其中 `/clarify/{id}` 的焦点样式正是本 RFC 修改面，源码注释也承认两道守卫曾同时漏掉它。但同一计划第 315 行勾选 AC1，STATE.md:5 又声明 T0-T8 全交付；第 292-299 行还承认目标 CI e2e 被跳过。实现门补跑 recipe（第 287-289 行）也只 cherry-pick 最初三个提交，会漏掉 T5、T6、8d95377e 等核心收口。
  Recommendation: 为每个披露的详情页建立 fixture，并把 route/state/dialog/tab 作为带预期控件身份或最小数量的必达清单；更新补跑 recipe 为完整 RFC-206 提交集。在完整实现门和目标 SHA CI 实际执行通过前，将 AC1/AC7 与 RFC 状态恢复为未完成。

Next steps:
- 先修复负 room、动态候选集、DOM churn 与 transform 坐标系，并为每条假阴增加反向自检。
- 将静态守卫改为 AST 驱动的全表扫描，同时删除 KNOWN_CLIPS 豁免机制。
- 重新设计 inset 焦点指示的对比度和 forced-colors 回退并补自动化测试。
- 补齐详情页及交互状态覆盖后，在完整 RFC-206 提交集和目标 SHA 上重跑实现门、Playwright 与 CI。

Codex session ID: 019f8779-e2a5-7283-a1f2-d28003ccf18b
Resume in Codex: codex resume 019f8779-e2a5-7283-a1f2-d28003ccf18b
