# Codex Adversarial Review

Target: branch diff against 3756ee9e
Verdict: needs-attention

不应上线：默认预填名会让团队实例后续用户撞全局唯一约束；任务提交失败仍会被捕获阶段 click 提前推进；工作流和工作组两条路线能在核心动作前直接 Done。持久化、键盘和小视口还存在真实退化路径。0104 在当前同步 migrator 下由单事务包裹，未找到可证实的半迁移缺陷，但现有测试只覆盖空库。

Findings:
- [high] 固定且可重放的 my-coder 预填使多用户主流程确定性撞名 (packages/frontend/src/components/tour/tourScript.ts:71-75)
  触发路径：共享实例中已有 `my-coder` 后，下一位用户按默认预填保存。`agents.name` 是全局 UNIQUE（`packages/backend/src/db/schema.ts:24`），服务会返回 `agent-name-in-use`（`packages/backend/src/services/agent.ts:61-64`）；现有 e2e 反而直接预种该 agent，未走真实创建。用户即使改成唯一名，Back 回此步骤也会触发 `SpotlightTour.tsx:260-276` 的 fill effect，再次把任何不同值写回 `my-coder`。结果是后续用户默认路径 409，且恢复输入会被覆盖。
  Recommendation: 每个 actor/tour run 生成并持久化一次抗冲突建议名；仅在输入为空且该步骤从未填充时写入，绝不覆盖非空用户值。增加同实例双用户完整创建以及 Back 后保留用户输入的浏览器测试。
- [high] 捕获阶段 click 在异步提交成功前推进 tour (packages/frontend/src/components/tour/SpotlightTour.tsx:306-314)
  委托监听器在 document capture 阶段一命中选择器就调用 `next()`，早于按钮 React handler 的完成结果。任务 POST 只有成功后才导航（`tasks.new.tsx:849-883`），失败会留在 `/tasks/new` 显示错误；tour 却已进入最终 `/tasks/` 步骤，而前缀匹配又把 `/tasks/new` 当作正确页面，于是用户在失败表单上看到“Watch it run”与 Done。现有 e2e 只覆盖成功提交，无法发现该路径。
  Recommendation: click-advance 只用于同步 UI 动作；创建任务应由 mutation `onSuccess` 或明确的成功事件推进，并用精确任务详情路由判定。补 POST 4xx、网络失败和重试成功的真实浏览器回归。
- [high] 两条宣称手把手完成的路线可在核心动作前直接结束 (packages/frontend/src/components/tour/tourScript.ts:154-197)
  `build-workflow` 的最后一步仅把“选模板、拖节点、连端口、启动”塞进一条无完成条件的说明；`use-workgroup` 的加成员和启动步骤同样没有 click、route 或业务状态判据。Overlay 会立即给这些步骤显示 Next/Done，因此两张入口卡都能在模板未应用、成员未添加、任务未启动时宣告完成。first-task 的 add-port 步骤也可直接 Next，而空 `outputs` 合法。e2e 仅覆盖 first-task 的 tab click 与成功提交，完全没有另外两条 journey。
  Recommendation: 为模板应用、工作流保存/启动、成员数量和工作组任务创建增加可观测的完成判据及独立步骤；若不实现，则把这两项明确降级为页面导览。三条路线都应有从入口到承诺结果的完整 e2e。
- [medium] tour 持久化既不分账户，也不带脚本版本 (packages/frontend/src/components/tour/SpotlightTour.tsx:51-84)
  `aw-tour` 与 `aw-tour-seen` 是 origin 级固定键，状态只有 `tourId + stepIndex`。共享浏览器上用户 A 登出后，用户 B 会恢复 A 的活动步骤且看不到自己的首次邀请；logout 清了查询缓存和草稿，却未清这些键。域校验也无法识别语义漂移：本批早期 first-task 从 7 步插成 9 步，旧的合法 stepIndex 会映射到另一动作并原样通过校验。
  Recommendation: 按实例和 actor ID 命名空间持久化，存稳定 step ID 与 script revision；账户或版本不匹配时清除/迁移活动状态，并在所有登出路径清理。增加同浏览器换账户及旧脚本状态升级测试。
- [medium] 全局方向键仍会与真实 TabBar 同时执行 (packages/frontend/src/components/tour/SpotlightTour.tsx:318-356)
  键盘守卫只排除可编辑元素，不检查 `defaultPrevented`、button、link 或 ARIA widget。真实 `TabBar` 会在 tab 按钮上处理 ArrowLeft/Right 并 `preventDefault()`，事件随后仍到达 window：手动步骤的 ArrowRight 同时推进 tour，ArrowLeft 则无条件回退。尤其 add-port 文案要求返回 Basics 页签，键盘用户执行标准 tab 导航时会把 tour 一并退步。现有测试仅覆盖 input 与 document.body。
  Recommendation: 只在焦点位于 tour 气泡内时响应 tour 快捷键；至少忽略 `defaultPrevented` 及按钮、链接、tab、listbox 等交互目标。用真实 AgentForm/TabBar 增加键盘集成测试。
- [medium] 气泡 clamp 使用虚构的 200px 高度 (packages/frontend/src/components/tour/SpotlightTour.tsx:367-383)
  纵向定位按固定 `BUBBLE_H = 200` 计算，而实际高度随翻译、窄屏、字体缩放和换行变化；缺锚点分支还直接居中。CSS 没有 viewport max-height 或滚动兜底。因此在手机宽度、放大文本或长文案下，实际 footer 可越出视口，即使计算结果声称已 clamp。当前 Playwright 只在 1280×800 桌面视口断言边界。
  Recommendation: 用 bubble 实际 `getBoundingClientRect()` 配合 ResizeObserver/resize 事件定位，并增加 `max-height: calc(100dvh - 16px)` 与内部滚动兜底；覆盖 320/375px、中文及文本缩放浏览器测试。

Next steps:
- 先修固定预填、mutation 成功推进和两条未完成 tour，这三项直接阻断上线。
- 补同实例双用户、提交失败、Back 后输入、真实 TabBar、三条完整 journey 及移动/缩放 e2e。
- 把持久化改为 actor/instance/script-version 隔离，并补登出与升级迁移。
- 为迁移增加 populated 0103 冻结库升级、故障回滚和大表场景；不要用当前空库测试替代既有安装验证。

Codex session ID: 019f8764-a2ac-70b2-96d7-ffa3d2c4212f
Resume in Codex: codex resume 019f8764-a2ac-70b2-96d7-ffa3d2c4212f
