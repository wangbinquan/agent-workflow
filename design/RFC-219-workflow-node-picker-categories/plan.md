# RFC-219 工作流节点选择器分类导航与类型显性化 — plan

状态：In Progress（2026-07-22 用户批准；T1-T6 与本地定向验收完成，T7 待仓库总门和 Linux
权威视觉基线）。依赖：RFC-199（Done）、RFC-150 TabBar（Done）。与进行中的 RFC-217 工作组
重构无耦合；实现只触前端 picker 相关文件。

## PR 拆分

单 PR。改动面小且数据模型、组件、样式和验收互相依赖，不人为拆成中间不可用状态。

## 任务

- [x] **RFC-219-T1 分类单一事实源**：`PaletteSection` 透出 `key`，导出稳定 section order；更新
      palette 单测，锁每个 NodeKind 唯一落入四类之一。
- [x] **RFC-219-T2 纯目录派生层**：新增 `deriveNodePickerCatalog`，实现 stable counts、
      recommended/recent、canonical group、category×query 与 visible count；覆盖 50 Agent/零 Agent/
      stale recent/空结果。
- [x] **RFC-219-T3 分类 UI**：`WorkflowNodePickerCatalog` 接共享 `TabBar` + ARIA panel，只挂 active
      结果 DOM；保留 query、recent、disabled、click/keyboard/drag 行为；行内增加文字类型 chip。
- [x] **RFC-219-T4 i18n 与样式**：中英 key/type 同步；复用 segment tabs、count badge、tight chip，
      增最小 picker 命名空间布局与四类色调；240px/420px/390px 不溢出、不遮挡。
- [x] **RFC-219-T5 组件回归**：扩 `workflow-node-picker.test.tsx`，锁 tab/count/分组/搜索交集/焦点/
      tabpanel/type chip；既有 picker/palette/accessibility 测试全绿。
- [x] **RFC-219-T6 浏览器验收**：50+ Agent fixture 覆盖 1536/1179/390；Wrapper/Human 一次点击直达、
      键盘添加、拖拽、overflow/bounding box、axe；更新定向 visual baseline。
- [ ] **RFC-219-T7 收尾**：跑完整门槛，视觉对齐自查；更新本 RFC 验收勾选、`design/plan.md` 与
      `STATE.md` 状态并记录交付 SHA/CI。

## 依赖关系

```text
T1 → T2 → T3 → T4 → T5 → T6 → T7
```

## 验收清单

- [x] AC-1 50 Agent 时 Wrapper/Human 一次点击直达
- [x] AC-2 全部视图保留推荐/最近并按四类 canonical section 分组
- [x] AC-3 五分类 stable count，分类×搜索组合且 query 不丢
- [x] AC-4 每行非颜色文字 type chip + data-category
- [x] AC-5 onPick/disabled/recent/click/keyboard/drag 语义零回归
- [x] AC-6 零 Agent 分类空状态，其余类型仍可用
- [x] AC-7 TabBar/tabpanel/焦点/键盘/axe 合同通过
- [x] AC-8 1536/1179/390 与 240px rail 无横向溢出、无控件遮挡
- [x] AC-9 中英文词条/type contract 齐全
- [ ] AC-10 typecheck/test/format + 相关 Playwright/visual 全绿

本地 RFC-219 定向门已通过：组件/模型、Playwright 大目录直达与 390px 点击/键盘、axe、四个
Darwin visual 场景（新增场景重复 5 次零像素漂移）。仓库总门当前受共享脏树中的 RFC-217
clarify 重构与本机 WebSocket/进程测试环境失败阻塞；Linux baseline 只能在授权提交并进入 Ubuntu
runner 后权威生成，因此 AC-10/T7 保持未完成。

## 设计批准门

- [x] 用户批准 `proposal.md` / `design.md` / `plan.md`（2026-07-22）
- [x] 批准前未修改 production/test code
