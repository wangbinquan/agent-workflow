# RFC-171 任务分解

- 依赖：RFC-164 / RFC-168 已 Done；复用 RFC-169 `.split*` 公共 CSS（已落地稳定）。
- 规模：纯前端、零后端、零 migration。**单 PR**（`feat(frontend): RFC-171 工作组详情页 split 皮肤对齐`）。
- 设计门：Codex 第一轮 10 findings 全折（见 design.md §9），下列任务已并入处置。
- 门禁（push 前，遵循 feedback_prepush_gate_includes_lint / feedback_post_commit_ci_check）：`bun run typecheck && bun run lint && bun run test && bun run format:check` + `bun run build:binary` smoke；push 后查 GitHub Actions。

## 任务

### RFC-171-T1 · CSS split 皮肤 + 高度链 + keep-list 清理
- `styles.css` 新增/调整：
  - **高度链闭合**（Codex#4）：顶部 `DetailHeaderActions`（含可能错误行）+ readiness `flex-shrink:0`；`.split{flex:1;min-height:0}`；右栏 `.workgroup-panel{flex:1;min-height:0;overflow-y:auto}` 撑满 `.split__detail`。
  - **左栏三段**（Codex#1）：`.workgroup-rail__head`（成员·N，muted）+ `.workgroup-config-entry` 在 `.split__cards` **之上**固定（`flex-shrink:0`）；`.split__cards{flex:1;overflow:auto}` 只装成员卡；`.workgroup-rail__add` 在其下固定。
  - `.workgroup-config-entry`（`<button>` 归一：width/text-align/font/cursor，其余复用 `.split-card`）。
  - `.workgroup-mcard`（**`position:relative`**——stretched hit-area 前提，Codex#3）+ `--agent/--human:not(.is-selected)` 类型描边（从 `:not(.card--highlighted)` 迁）+ `--human.is-selected` 琥珀底；`.workgroup-mrail`（竖列 gap + list-reset）。**复用** `.workgroup-card__open`（`::after` hit-area、focus 轮廓）不动。
- **清理**：只删 `.page--studio` / `.workgroup-studio*`（详情页独占）。**keep-list（禁删，Codex#9）**：`.workgroup-cards__actions`（WorkgroupTaskConfigDialog）、`.workgroup-card__open`、WorkgroupMemberCards 仍引用的 `.workgroup-card*`。删任一规则前 grep 全仓零消费者（feedback_grep_locks_before_push）。
- 依赖：无。

### RFC-171-T2 · 页面布局重排（`workgroups.detail.tsx`）
- `.page--studio`+`.workgroup-studio` → `.page--split`+`.split`（`aside.split__list` + `section.split__detail`）。
- 左栏固定头：`.workgroup-rail__head`（成员·N，Codex#6）+ 配置条目（`workgroup-config-entry`，`changePanel({kind:'config'})`，`is-selected=effectivePanel.kind==='config'`，`⚙` `aria-hidden`）。
- 左栏滚动区 `.split__cards`：`<WorkgroupMemberGallery/>`。**保留 blank-area-deselect**（Codex#2）：onClick 从 `.workgroup-studio__main` 重定向到此容器，语义/守卫保留；命中判定 selector `.workgroup-card`→`[data-member-key]`（R2 Nit A，卡根改 `.workgroup-mcard` 后必须同步，否则点卡误取消选中）。
- 左栏固定尾 `.workgroup-rail__add`：两个添加按钮（从 `__main-head` 移来，testid/dynamic 隐藏人类逻辑不变）。
- 右栏 `.split__detail` 放 `<WorkgroupContextPanel/>`（props 不变）。
- **不动**任何 mutation / 选择状态机 / 焦点 / rename Dialog / DetailHeaderActions / readiness。
- 依赖：T1。

### RFC-171-T3 · 成员卡片换 `.split-card` 卡面（`WorkgroupMemberGallery.tsx`）
- Props 不变。`ul.workgroup-cards`（网格）→ `ul.workgroup-mrail`（竖列）；`<li data-member-key>` 保留。
- 卡容器 `<Card>` → `<div className="split-card workgroup-mcard workgroup-mcard--{type}{ is-selected}">`；标题按钮 `.workgroup-card__open`（hit-area/aria/focus/testid）**逐字保留**。
- 卡面：`.split-card__subtitle`=引用；**保留 roleDesc**（紧凑 muted 行，Codex#6）；`.split-card__badges`=类型 chip + leader 徽标 + 「N 端口」计数徽标（`capabilityCardModel` 只取计数）；悬空 agent 警示（F6）。空态保留。
- 移除逐端口名 chips（`PortsRow`/`AgentCardSummary` 精简为计数）。
- 依赖：T1。

### RFC-171-T4 · 右编辑区撑满（`WorkgroupContextPanel.tsx`）
- 仅根容器视觉：`.workgroup-panel` `flex:1;min-height:0` 撑满宽栏（Codex#4）；`id`/testid/head/body/三态/焦点/Esc/MemberBody 内容身份键**一行不动**。
- 依赖：T1。

### RFC-171-T5 · i18n
- `i18n/zh-CN.ts` + `en-US.ts`：新增 `workgroups.portsCountBadge_one`/`_other`（双语复数，Codex#10）。配置条目复用 `panelConfigTitle`；成员计数复用 `sectionMembers`+数字。
- 依赖：无。

### RFC-171-T6 · 测试（随 T2-T4 落地）
- 更新 `tests/workgroup-studio-panel.test.tsx`（实际 **17** 用例，Codex#8 勘误）布局锚点：三态 / blank-deselect 承载元素 / add 按钮位置 / 能力摘要改计数徽标 + roleDesc 仍在（行为意图不变）。
- **补** `tests/workgroups-pages.test.tsx`（其详情页部分覆盖 gallery/panel + `WorkgroupMemberGallery` import 源锁 + 双语 key，Codex#8）同步更新。
- 新增（优先真实 DOM 断言，源码锚点仅兜底，Codex#8）：配置条目在 `.split__cards` 之外固定 + 默认选中 + config↔member↔add 互斥；**整卡点击机制**——CSS 源锁（`.workgroup-mcard{position:relative}`+`.workgroup-card__open::after{position:absolute;inset:0}`）+ 真实按钮行为测试（点 `workgroup-card-open-*` 选中），像素命中留 e2e（R2 Nit B——happy-dom `css:false` 不命中 `::after`）；添加按钮在左栏固定尾；窄卡端口计数徽标（0/1/多，复数）+ roleDesc；**F-171-5 实证冻结**（成员 PUT 在途点配置条目→停原 member/草稿不丢/条目未选中/settle 后可切，按 P1 模式，Codex#7）；split 源级锚点（含 `.split`、不含 `workgroup-studio`）兜底。
- **task-config 回归**（Codex#9）：跑 `workgroup-task-config.test.tsx` 确认 mid-run 弹窗未受 CSS 清理波及。
- 依赖：T2-T4。

### RFC-171-T7 · 门禁 + 视觉自查 + 归档
- typecheck/lint/test/format + build smoke 全绿；push 后查 CI。
- 明暗双主题 + 窄屏 + 多错误行最小 repro / dev 核验（feedback_frontend_visual_verify_repro）；确认无需刷新视觉基线（design §6.3）。
- `design/plan.md` RFC 索引 RFC-171 翻 Done + 本 plan 落地记录；`STATE.md` 顶部「进行中 RFC」→ 已完成。
- 依赖：T1-T6。

## 验收清单（对应 proposal AC）

- [ ] AC1 `.split` 双栏、源码无 `.workgroup-studio`/`.page--studio`（T1/T2 + T6 真实 DOM + 源锁）
- [ ] AC2 配置条目在固定头区（不随成员滚动）+ 默认选中 + 右侧显 `WorkgroupForm`（T1/T2/T6）
- [ ] AC3 config↔member↔add 互斥选中、testid 齐（T2/T3/T6）
- [ ] AC4 添加按钮在左栏固定尾、dynamic 隐藏人类（T2/T6）
- [ ] AC5 成员窄卡 `.split-card`+`.workgroup-mcard` 卡面 + roleDesc + 类型/leader/端口计数徽标 + 整卡点击（T3/T6）
- [ ] AC5b 端口计数走 `_one/_other` 复数、0 不渲染（T5/T6）
- [ ] AC6 RFC-168 行为测试继续绿（含 blank-deselect）（T6）
- [ ] AC7 新增测试全覆盖（含 F-171-5 实证冻结）（T6）
- [ ] AC8 门禁 + build smoke + task-config 回归 + CI 绿（T7）
- [ ] AC9 明暗 + 窄屏 + 多错误行视觉自查（T7）

## PR 拆分

单 PR。commit message：`feat(frontend): RFC-171 工作组详情页 split 皮肤对齐——左成员卡片列 + 右编辑区`。

## 落地记录（2026-07-13 · 已实现）

T1–T7 全部完成，AC1–AC9 逐条通过：
- **T1 CSS**：`.page--split > *:not(.split){flex-shrink:0}` + rail 三段（`.workgroup-rail__head`/`.workgroup-config-entry` 固定头、`.split__cards` 滚动、`.workgroup-rail__add` 固定尾）+ `.workgroup-mcard*`（`position:relative` 保 hit-area、类型 accent 用 `.split-card.` 前缀压过 `.split-card.is-selected`、选中-human 琥珀底）+ `.workgroup-mrail` + `.workgroup-panel{flex:1}`；只删 `.page--studio`/`.workgroup-studio*` + dead `.workgroup-card*`（grep 零消费者）+ 960px @media；keep-list `.workgroup-cards__actions`/`.workgroup-card__open`/`.workgroup-card__ref` 保留。
- **T2** `workgroups.detail.tsx`：`.page--split`+`.split` 双栏，配置条目在滚动区外真固定，blank-deselect selector → `[data-member-key]`（R2 Nit A），添加按钮移左栏固定尾；状态机/mutation/焦点/rename 全不动。
- **T3** `WorkgroupMemberGallery`：`<div.split-card.workgroup-mcard--{type}>` 卡面（保 `.workgroup-card__open` hit-area + aria + testid）、逐端口 chips → `AgentPortsBadge` 计数徽标、roleDesc/类型/leader/悬空警示保留。
- **T4** `.workgroup-panel{flex:1}` 撑满（CSS-only，JSX 不动）。
- **T5** i18n `portsCountBadge_one/_other` 双语复数。
- **T6** 更新 studio-panel 测试布局锚点 + 新增 6 用例（配置条目固定/互斥/1-port 单数/0-port 无/F-171-5 实证冻结/split+hit-area 源锁）；`workgroups-pages.test.tsx` 源锁自然通过无需改。
- **门禁全绿**：typecheck exit=0 · lint exit=0 · 全量前端 vitest **480 文件 3584 测试全通过** · format:check 干净 · build:binary smoke ok。**视觉核验**：明暗桌面 + 820px 窄屏三态截图确认（选中-human 琥珀底+蓝环特异性生效、配置条目固定不滚、窄屏单列降级、无横向溢出）。

**⚠️ 提交竞态说明**：实现期一并发 session 在同一批文件跑「name/description 统一重命名」重构并 `git add -A; commit`，把本 RFC 的实现代码（`WorkgroupMemberGallery`/`styles.css`/`workgroups.detail.tsx`/`i18n`/`workgroup-studio-panel.test.tsx`）**扫入其 commit `ddb822c3`（feat(frontend): 名称/描述编辑统一到「重命名」弹窗）并推送 origin/main**（[feedback_shared_index_commit_race] 竞态；代码未丢、正确、CI 在 origin/main 上跑）。本 RFC 三件套 + 索引/STATE 登记单独提交，代码归属指向 `ddb822c3`。
