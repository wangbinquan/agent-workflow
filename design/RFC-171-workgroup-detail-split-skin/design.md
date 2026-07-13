# RFC-171 技术设计

> 设计门（Codex，2026-07-13）：第一轮 NEEDS-ATTENTION 10 findings（3H+5M+2L）**全部折叠**（§9 逐条处置）；**第二轮 APPROVE-WITH-NITS**——10 条确认 RESOLVED、无旧问题复开，新增 2 个实现/测试措辞 nit（blank-deselect selector 同步 `.workgroup-card`→`[data-member-key]`；stretched hit-area 不能靠 happy-dom 单测点 subtitle/badge，改 CSS 源锁 + 真实按钮行为测试）亦已折叠（§2.1 注意 / §6.2 / §5 F-171-3）。核心修正：配置条目移出滚动区（真固定）· 保留 blank-area-deselect（不做行为回归）· 保住 stretched hit-area 的 `position:relative` 前提 · CSS 清理明确 keep-list（`.workgroup-cards__actions` 等被运行态复用）· 测试影响面补 `workgroups-pages.test.tsx` + 真实 DOM 断言 · 端口计数走 `_one/_other` 复数。

## 0. 一句话

把 `/workgroups/$name` 详情页从 RFC-168 的「studio 两列（宽成员画廊 + 380px 窄面板）」重排为 RFC-169 的 `.split` 双栏皮肤（窄成员卡片列 + 宽编辑区），**复用 `.split*` 公共 CSS 类**；左栏**固定区**（不随成员滚动）放「⚙ 组配置」条目、成员滚动区放成员卡、底部固定区放「添加成员」按钮；**选择状态机 / 成员写入 / RFC-168 全部行为契约与 Codex 加固保留**（含 blank-area-deselect），改动集中在 JSX 布局 + CSS + 两处控件位置。

## 1. 现状与改造对照

### 1.1 现状（RFC-168）

`routes/workgroups.detail.tsx`：

```
.page.page--wide.page--studio
  <DetailHeaderActions/>            名称 + ACL/保存/删除/重命名/启动（含可选错误行）
  {readiness banner}
  .workgroup-studio (grid 1fr 380px)
    .workgroup-studio__main         宽·成员画廊主区（onClick 空白取消选中——已被测试锁定）
      .workgroup-studio__main-head  「成员」标题 + count + 添加按钮
      <WorkgroupMemberGallery/>     ul.workgroup-cards 网格；卡=<Card.workgroup-card.workgroup-card--{type}>
    <WorkgroupContextPanel/>        窄·380px 右面板（config/member/add 三态）
  {rename Dialog}
```

选择状态 `panel: {kind:'config'|'member'|'add'}` 在页面；`effectivePanel` 处理悬空 member key 塌回 config；三态由 `WorkgroupContextPanel` 渲染。整卡点击靠 `.workgroup-card{position:relative}` + `.workgroup-card__open::after{position:absolute;inset:0}` 的 stretched hit-area（RFC-168 F10）。

### 1.2 目标（RFC-171）

```
.page.page--split
  <DetailHeaderActions/>            名称 + ACL/保存/删除/重命名/启动（含可选错误行）  全宽·flex-shrink:0
  {readiness banner}               flex-shrink:0（不变）
  .split (grid minmax(240px,300px) minmax(0,1fr))     复用 RFC-169 类；flex:1;min-height:0
    aside.split__list               左·成员卡片列
      ── 固定区（不滚）──
      .workgroup-rail__head         「成员 · {count}」小标题
      button.split-card.workgroup-config-entry        「⚙ 组配置」固定条目（在滚动区之外，真固定）
      ── 滚动区 ──
      .split__cards (overflow:auto) 内含 <WorkgroupMemberGallery/>（成员卡竖列 + 空态）；
                                    空白点击取消选中（保留 RFC-168 手势，onClick 重定向到此容器）
      ── 固定区（不滚）──
      .workgroup-rail__add          底部「添加 Agent/人类成员」按钮（flex-shrink:0）
    section.split__detail           右·宽编辑区
      <WorkgroupContextPanel/>      config/member/add 三态（逻辑不变，flex:1 撑满宽栏）
  {rename Dialog}                   （不变）
```

**角色对调**：成员从宽主区变窄左栏；编辑区从窄右面板变宽右栏。左栏结构对齐 agents rail 的「固定头 + 滚动卡区 + 固定尾」（agents = title+search / cards / `+new`；本页 = 「成员·N」+配置条目 / 成员卡 / 添加按钮）。

## 2. 组件级契约

### 2.1 `routes/workgroups.detail.tsx`（页面）

**不变**：全部 query / mutation / 选择状态机 / 焦点与 id-重生成处理——
`useQuery`、config `useDraftFromQuery`、`save`/`membersMut`/`del`/`rename`、`panel`/`focusOn`、`effectivePanel`、
`panelRef`/`groupRef`、`changePanel`（in-flight 冻结）/`applyPanel`/`closePanel`/`onSelectCard`/
`reselectAfterPut`/`findMemberKeyByContent`/`onSaveMember`/`onSetLeader`/`onRemoveMember`/`onAddMember`、
`savedFlash`、readiness、rename Dialog。

**变**（仅 render 树 + CSS 类）：
1. 外层 `.page--wide.page--studio` → `.page--split`；`.workgroup-studio` 块 → `.split` 块。header / readiness / rename Dialog 位置不变。
2. 左栏 `aside.split__list`：
   - **固定头区**（在 `.split__cards` 之外，因此不随成员滚动——Codex#1）：`.workgroup-rail__head` = 「成员 · {group.members.length}」（保留 RFC-168 的成员标题 + 数——Codex#6）；紧接**配置条目**（页面拥有：`onClick={() => changePanel({ kind: 'config' })}`、`is-selected = effectivePanel.kind === 'config'`）。
   - **滚动区** `.split__cards`：`<WorkgroupMemberGallery/>`（成员卡竖列）。**保留 blank-area-deselect**（Codex#2）：`onClick` 从原 `.workgroup-studio__main` 重定向到此滚动容器，命中卡/按钮/链接不处理、命中空白且 `effectivePanel.kind==='member'` 时 `closePanel()`（语义、守卫**逐字保留**）。**注意**（设计门 R2 Nit A）：命中判定里的 `target.closest('.workgroup-card, button, a, input')`（现 workgroups.detail.tsx:451）因卡根类由 `.workgroup-card`→`.workgroup-mcard` 必须同步——改为 `target.closest('[data-member-key], button, a, input')`（`[data-member-key]` 是每张卡 `<li>` 的稳定包裹，比类名更鲁棒），否则点卡不再被吞、会误取消选中。
   - **固定尾区** `.workgroup-rail__add`：两个添加按钮（从 `.workgroup-studio__main-head` 移来；testid `workgroup-add-agent-member`/`workgroup-add-human-member`、onClick、`dynamic_workflow` 隐藏人类成员逻辑全不变）。
3. 右栏 `section.split__detail` 放 `<WorkgroupContextPanel/>`（props 完全不变）。

配置条目 JSX（页面内）：

```tsx
<button
  type="button"
  className={'split-card workgroup-config-entry' + (effectivePanel.kind === 'config' ? ' is-selected' : '')}
  aria-expanded={effectivePanel.kind === 'config'}
  aria-controls="workgroup-context-panel"
  onClick={() => changePanel({ kind: 'config' })}
  data-testid="workgroup-config-entry"
>
  <span className="split-card__name"><span aria-hidden="true">⚙ </span>{t('workgroups.panelConfigTitle')}</span>
</button>
```

> `changePanel` 已在 `membersMut.isPending` 时冻结——点配置条目在成员 PUT 在途时是 no-op（与点成员卡一致），无需额外守卫。装饰性 `⚙` 加 `aria-hidden`（Codex#5）。
> **ARIA 决策**（Codex#5）：沿用 RFC-168 成员按钮既有的 `aria-expanded`+`aria-controls`（面板即被控披露区，成员卡重复点击=collapse 回 config，与 expanded 语义自洽），配置条目同款；**不**改 `aria-pressed`——那是 a11y 语义变更、会偏离刚落地的 RFC-168 契约及其测试断言，超出「纯视觉换皮」范围，如需另立 a11y RFC 统一处理两处。

### 2.2 `components/workgroup/WorkgroupMemberGallery.tsx`

**Props 不变**：`{ group, selectedKey, onSelectCard }`。
**变**：
- 列表容器：`ul.workgroup-cards`（网格）→ `ul.workgroup-mrail`（竖列：`display:flex;flex-direction:column;gap;margin:0;padding:0;list-style:none`——`.split__cards` 的 gap 只作用于直接子元素，嵌套 `<ul>` 需自带竖列 gap 与 list-reset，Codex#3）。每张卡仍包 `<li data-member-key>`（保留供页面 `focusCardButton` 同步查询）。
- 卡容器：不再用 `<Card>`（`.card`+`.card--highlighted`），改 `<div className="split-card workgroup-mcard workgroup-mcard--{agent|human}{ is-selected}">`——`.split-card` 提供基座外观 + 选中态（`.is-selected`），`.workgroup-mcard` 提供 **`position:relative`（stretched hit-area 前提，Codex#3）** + agent/human 类型描边 + 选中-human 琥珀底覆盖（把 RFC-168 `:not(.card--highlighted)` 语义迁到 `:not(.is-selected)`）。
- 标题按钮**逐字保留** `.workgroup-card__open`（stretched `::after` hit-area + `aria-expanded`+`aria-controls`+focus-visible 轮廓 + testid `workgroup-card-open-<alias>`），只是外层从 `.workgroup-card` 换 `.workgroup-mcard`——两者都给 `position:relative`，`::after` 定位不变。
- 卡面内容（Codex#6，保留 RFC-168 可见信息，仅收窄逐端口 chips）：
  - `.split-card__subtitle` = 引用（agent=`agentName`；human=用户名 / userId 兜底），`title=` 全文。
  - **保留 `roleDesc`**：非空时一行紧凑 muted 文本（复用 `.workgroup-card__role` 或 `.split-card__subtitle` 语汇，单行截断）。
  - `.split-card__badges chip-row` = 类型 chip + leader 徽标（`leader_worker`+isLeader，testid `workgroup-leader-badge`）+ **「N 端口」计数徽标**（agent，N=`capabilityCardModel(agent,{promptBudget:0}).inputs.length+outputs.length`，0 不渲染；悬空 agent 显示 `agentMissing` 警示 chip，沿 F6 仅在 `agentsList.loaded` 后）。
- 移除 `PortsRow`/`AgentCardSummary` 的**逐端口名 chips**（完整端口在右栏 `AgentCapabilityCard`）；`capabilityCardModel` 投影改只取计数（仍是唯一结构化投影）。空态保留（testid `workgroup-members-empty`）。

### 2.3 `components/workgroup/WorkgroupContextPanel.tsx`（右编辑区）

**Props / 三态渲染 / 焦点 effect / Esc / MemberBody 内容身份键 / AddBody 完全不变**（RFC-168 Codex 加固核心，一行不动）。
**变**：仅根容器视觉——`.workgroup-panel`（原 380px 固定卡）改为 `flex:1;min-height:0;overflow-y:auto` 撑满 `.split__detail`（Codex#4）。保留 `id="workgroup-context-panel"`、testid、head（title+close）、body。close 按钮 + Esc（F9）保留，与配置条目并存两条回配置路径。

### 2.4 组件边界与「为何不复用 `ResourceSplitPage` 组件本体」

复用 RFC-169 **CSS 类**（`.split`/`.split__list`/`.split__cards`/`.split-card`/`.split-card.is-selected`/`.split__detail`/`.split-card__title|__name|__subtitle|__badges`），满足 CLAUDE.md「优先复用公共 class、禁自写 chrome」。

**不复用 `ResourceSplitPage` 组件本体**：其卡片是路由 `<Link>`（点击=导航到 `/res/$key`），右栏是 `<Outlet/>`；而工作组成员选择是**页内 state**（`panel`），成员 id 每次 full-replace PUT 被后端重生成（services/workgroups.ts §1.2），编进 URL 既不稳也无必要。且工作组详情有**工作组级顶部 header** 位于 `.split` 之上（`ResourceSplitPage` 把 header 放右栏 detail 内）；左栏含非同质的「⚙ 组配置」条目 + 两个添加按钮 + 成员计数头。强行让 4 页共用组件同时支持「路由卡+页内选择卡」「右栏 header+顶部 header」得不偿失。故用 `.split*` 类做工作组专属组合。（未来若抽「左栏 presentational 壳」供两者共用，另立 RFC。）

## 3. CSS（`styles.css`）

复用（不新增）：`.split`/`.split__list`/`.split__cards`/`.split__detail`/`.split-card`/`.split-card.is-selected`/`.split-card__title|__name|__subtitle|__badges`/`.page--split`/`.content:has(.page--split)`/`@media(max-width:1080px)` 降级。

新增 / 调整（小量，均为对现有语言的扩展）：
1. **高度链闭合**（Codex#4）：`.page--split` 已是 `display:flex;flex-direction:column;height:100%`；其上 `DetailHeaderActions`（**含可能的错误行**——不止 header+banner）+ readiness 横幅一律 `flex-shrink:0`；`.split{flex:1;min-height:0}`。右栏 `.workgroup-panel{flex:1;min-height:0;overflow-y:auto}` 撑满 `.split__detail`。以「readiness + 多错误行 + 矮视口 + ≤1080px」验证真实滚动边界。
2. **左栏固定/滚动三段**（Codex#1）：`.split__list` 为 flex column；`.workgroup-rail__head`（成员·N）+ `.workgroup-config-entry` 在 `.split__cards` **之上**（`flex-shrink:0`，真固定不滚）；`.split__cards{flex:1;overflow:auto}` 只装成员卡；`.workgroup-rail__add` 在其**下**（`flex-shrink:0`）。
3. `.workgroup-config-entry`：`<button>` 复用 `.split-card` 外观所需按钮归一——`width:100%;text-align:left;font:inherit;cursor:pointer`（`.split-card` 已给 border/radius/padding/bg/color）。`⚙` 文本符号（`aria-hidden`），不引图标库。
4. `.workgroup-mcard`（Codex#3）：`position:relative`（stretched hit-area 前提）；`.workgroup-mcard--agent:not(.is-selected)` / `--human:not(.is-selected)` 复用 RFC-168 现有 agent/human accent 颜色（从 `:not(.card--highlighted)` 迁来）；`.workgroup-mcard--human.is-selected{background:琥珀}` 保 RFC-168 选中-human 类型底。`.workgroup-card__open`（含 `::after` hit-area、focus-visible 轮廓）**原样保留复用**。
5. `.workgroup-mrail`：成员 `<ul>` 竖列（flex column + gap + list-reset）。
6. `.workgroup-rail__head`：成员计数小标题（muted，`font-sm`）。
7. **CSS 清理与 keep-list**（Codex#9）：**只移除** `.page--studio` / `.workgroup-studio*`（详情页独占布局）。**明确保留**（跨页/运行态复用，禁删）：`.workgroup-cards__actions`（`WorkgroupTaskConfigDialog.tsx:255` 用）、`.workgroup-card__open`（本页复用）、以及 `WorkgroupMemberCards.tsx`（mid-run 弹窗）仍引用的任何 `.workgroup-card*`。移除任一规则前 `grep` 全仓确认零消费者（feedback_grep_locks_before_push）；不做「笼统删 `.workgroup-card*`」。`.workgroup-cards`（原网格 ul）经 grep 确认仅本 gallery 用→改竖列或让位 `.workgroup-mrail`。

明暗双主题：全走既有 CSS 变量（`--panel`/`--border`/`--accent`/`--muted` + agent/human accent），无硬编码色。

## 4. 数据流（不变）

选择：配置条目 / 成员卡 / 添加按钮 → `changePanel(next)`（`membersMut.isPending` 冻结）→ `panel` → `effectivePanel`（悬空 member 塌回 config）→ 右栏按 kind 渲染。空白点击 → `closePanel()`（member 态才生效）。
配置保存：draft + 顶部「保存」→ full-replace PUT（透传当前 members）→ 成功重解析开着的 member（Codex P1）+ `savedFlash`。
成员操作：即时 full-replace PUT（`applyMembers` single-flight）→ 成功写回 fresh row + 按内容重选中（`findMemberKeyByContent`）。
—— 全部沿 RFC-168，本 RFC 零改动。

## 5. 失败模式

- **F-171-1 header + 内滚高度模型**：`.page--split` 顶部叠 header/错误行/banner 后 `.split` 内滚、矮视口不裁剪、右栏 `flex:1` 撑满。缓解：§3.1 显式 `flex-shrink:0`/`flex:1`；实现期最小 repro + dev 核验明暗 + 窄屏 + 多错误行（AC9）。
- **F-171-2 成员窄卡信息密度**：窄卡放不下逐端口 chips。**取舍**：逐端口 chips → 「N 端口」计数徽标 + 右栏能力卡看全；**roleDesc / 类型 / leader / 成员计数均保留**（proposal N7 精确列举）。
- **F-171-3 stretched hit-area 前提**：换容器类若丢 `position:relative` 则整卡点击/焦点轮廓失效。缓解：`.workgroup-mcard{position:relative}` + 复用 `.workgroup-card__open::after`；验证走 CSS 源锁 + 真实按钮行为测试（happy-dom `css:false` 不能命中 `::after`，见 §6.2 R2 Nit B）。
- **F-171-4 CSS 跨页误删**：清理 `.workgroup-*` 误删运行态 `WorkgroupTaskConfigDialog` / mid-run 弹窗仍用的类。缓解：§3.7 keep-list + grep 零消费者门槛 + task-config 回归纳入范围。
- **F-171-5 config 条目与 in-flight**：成员 PUT 在途点配置条目——`changePanel` 冻结使其 no-op。测试须按 P1 模式**实证冻结**（停在原 member、草稿不丢、配置条目未选中，settle 后才可切），而非「无第二次写」空断言（Codex#7）。
- **F-171-6 选中态双 accent 叠加**：`.is-selected` 与 `.workgroup-mcard--{type}` 明暗都需清晰可辨；选中-human 保琥珀底。实现期视觉自查。

## 6. 测试策略

遵循 CLAUDE.md「测试随改动落地」+ 优先 `findByRole` / 真实 DOM 断言（源码文本包含检查易被注释误满足，Codex#8），源级锚点仅兜底。

### 6.1 保留 / 更新既有

**`tests/workgroup-studio-panel.test.tsx`（实际 17 用例，非 19——Codex#8 勘误）**：底层状态机不变，多数行为断言保留，仅更新**布局锚点**（不改意图）：
- 三态切换（config 默认 → 点卡 member → close/toggle/Esc 回 config + **blank-area-deselect 保留**）：blank-click 目标从 `.workgroup-studio__main` 改为新滚动容器；补断言「配置条目默认 `is-selected`」。
- free_collab/dynamic 控件（无 set-leader / 隐藏 add-human）：add 按钮移左栏，按 testid 断言不变。
- 选择存活于 id-重生成（save/add）：不变。
- 能力摘要（F6）：逐端口 chips → 「N 端口」计数徽标——更新断言（验计数徽标 + 悬空警示 + **roleDesc 仍在**；完整端口断言迁到右栏 `AgentCapabilityCard`）。
- config 保存不跳转 / saved 闪烁不撒谎（F2）/ 成员 PUT 失败保草稿（F5）/ mode-transition（F3）/ Codex P1（in-flight 冻结）/ P2（设 leader 不冲草稿）/ remove 焦点交邻卡（F8）：不变。

**`tests/workgroups-pages.test.tsx`（Codex#8 补入）**：其详情页部分直接覆盖 gallery/panel（`workgroup-card-*`/`workgroup-card-open-*`/`workgroup-context-panel`，~L439-508）+ `WorkgroupMemberGallery` import 源锁（L603）+ 双语 key（L588 区）——随布局/卡面变更同步更新。

### 6.2 新增

- **split 皮肤真实 DOM 锚点**（强于源码文本）：详情页渲染出 `.split__list` / `.split__detail`、配置条目在 `.split__cards` **之外**（固定不滚——用真实 DOM 结构断言其非滚动容器子节点，Codex#1/#8）；源码不含 `workgroup-studio`/`page--studio` 作兜底。
- **配置条目**：默认 `is-selected`（testid `workgroup-config-entry`）；点成员卡 → 配置条目失 `is-selected`、成员卡得 `is-selected`（config↔member 互斥）；点回配置条目 → 右栏 `WorkgroupForm`。
- **整卡点击机制**（设计门 R2 Nit B——happy-dom `css:false` 无法命中 `::after` 布局，不能靠单测点 subtitle/badge 验证）：拆为 (a) **CSS 源锁**——`styles.css` 含 `.workgroup-mcard{position:relative}` + `.workgroup-card__open::after{position:absolute;inset:0}`（锁住 stretched hit-area 机制不回退）；(b) **真实按钮行为测试**——点 `workgroup-card-open-<alias>` 按钮选中该成员（happy-dom 可跑）。整卡指针命中的像素级验证留给 e2e/Playwright（若已有工作组详情 e2e 覆盖则纳入，否则文档化为 v1 由 CSS 源锁兜底）。
- **添加按钮在左栏固定尾**：`workgroup-add-agent-member`/`workgroup-add-human-member` 在 `.split__list` 内；dynamic 隐藏人类。config→member→add 三态互斥。
- **成员窄卡**：类型 chip + leader 徽标 + 「N 端口」计数徽标 + roleDesc；human 无端口徽标。
- **F-171-5**（实证冻结，非空断言，Codex#7）：成员 PUT 在途点配置条目 → 停在原 member、草稿不丢、配置条目未 `is-selected`；settle 后可切。
- **blank-area-deselect 保留**：member 态点滚动区空白 → 回 config；点卡/按钮不触发。

### 6.3 门禁与视觉

- `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿（前端测试走 vitest，非 `bun test`——reference_ci_test_scope）。
- 单二进制 build smoke 绿。
- **task-config 回归**（Codex#9）：改 CSS 后跑 `workgroup-task-config.test.tsx` 确认 mid-run 弹窗未受 `.workgroup-*` 清理波及。
- 视觉基线：`/workgroups/$name` 非 e2e 视觉回归基线页（基线=agents/workflows/repos/memory/settings，reference_visual_baseline_settings_default_tab）——预计**无需刷新 workgroups.png**；实现期确认 e2e 是否有工作组详情快照，有则按需处理。
- 明暗双主题 + 窄屏 + 多错误行最小 repro / dev 核验（feedback_frontend_visual_verify_repro）。

## 7. i18n

复用现有：`workgroups.panelConfigTitle`（配置条目）/ `sectionMembers` / `addAgentMember` / `addHumanMember` / `memberTypeAgent|Human` / `leaderBadge` / `agentMissing` / `membersEmpty` / `panelClose` / `panelAria` / `portsIn` / `portsOut`。
新增（zh-CN + en-US 双语，**走 `_one/_other` 复数**——Codex#10）：
- `workgroups.portsCountBadge_one` / `workgroups.portsCountBadge_other`（如 "{{count}} port" / "{{count}} ports"；zh 单形），测试覆盖 count=0（不渲染）/1/多。
（配置条目复用 `panelConfigTitle`；成员计数复用现有 `sectionMembers` + 数字，不新增 key。）

## 8. 影响面清单

- 改：`routes/workgroups.detail.tsx`（布局 render 树 + blank-deselect 承载元素）、`components/workgroup/WorkgroupMemberGallery.tsx`（卡面 + 列表容器）、`components/workgroup/WorkgroupContextPanel.tsx`（根容器 flex:1）、`styles.css`（§3，含只删 `.workgroup-studio*`/`.page--studio` + keep-list）、`i18n/{zh-CN,en-US}.ts`（portsCountBadge 复数）、`tests/workgroup-studio-panel.test.tsx` + `tests/workgroups-pages.test.tsx`（更新 + 新增）。
- **CSS keep-list（禁删）**：`.workgroup-cards__actions`（WorkgroupTaskConfigDialog）、`.workgroup-card__open`（本页复用）、WorkgroupMemberCards 仍引用的 `.workgroup-card*`。
- 不改：`lib/workgroup-form.ts`、所有后端、schema、migration、`WorkgroupForm.tsx`（内容不变，仅从窄面板进宽栏）、`MemberFields.tsx`、`WorkgroupMemberCards.tsx`、`WorkgroupTaskConfigDialog.tsx`（仅确保其 CSS 不被误删）、聊天室 / 任务详情 / 动态 workflow 面板 / 列表页 `workgroups.tsx`。
- 零 migration、零后端、单 PR。

## 9. 设计门处置（Codex 第一轮 10 findings 全折）

| # | 严重度 | Finding | 处置 |
|---|---|---|---|
| 1 | high | 配置条目放 `overflow:auto` 的 `.split__cards` 会随成员滚走，不满足「固定」 | 配置条目 + 成员计数头移到 `.split__cards` **之上**的固定区（`flex-shrink:0`），真固定；成员卡独占滚动区（§1.2/§2.1/§3.2）。加长列表滚动测试（§6.2 真实 DOM 断言配置条目非滚动区子节点）。 |
| 2 | high | 删 blank-area-deselect 是已锁定行为回归（测试 L285 断言 `.workgroup-studio__main`），与「保留 RFC-168 全部行为」矛盾 | **保留该手势**（不做产品变更）：onClick 从 `.workgroup-studio__main` 重定向到新滚动容器，语义/守卫/命中判定逐字保留（§2.1）。撤销原「若测试锁定则更新」措辞；G5/AC6 无需改。 |
| 3 | high | 新卡容器丢 `.workgroup-card{position:relative}` → stretched hit-area 失效；嵌套 `<ul>` 未定义 gap/reset | `.workgroup-mcard{position:relative}` + 复用 `.workgroup-card__open::after`；`.workgroup-mrail` 竖列自带 gap/list-reset（§2.2/§3.4/#3.5）。测试点 subtitle/badge 区命中 + focus 轮廓（§6.2）。 |
| 4 | medium | 右栏 `.workgroup-panel` 无 `flex:1` 撑不满；顶部不止 header+banner（DetailHeaderActions 有错误行） | `.workgroup-panel{flex:1;min-height:0}`；顶部各行 `flex-shrink:0`；以「readiness+多错误+矮视口+≤1080px」验证（§3.1/§5 F-171-1）。 |
| 5 | medium | `aria-expanded` 表达 selection 语义不精确；`⚙` 未 `aria-hidden` | `⚙` 加 `aria-hidden`（采纳）；**保留** RFC-168 既有 `aria-expanded`+`aria-controls` 模型（面板=被控披露区、重复点=collapse，自洽），不改 `aria-pressed`——避免偏离刚落地契约与测试、超出视觉换皮范围，记为显式非目标（§2.1 ARIA 决策）。 |
| 6 | medium | 静默删除 roleDesc + 成员标题/计数 | **保留** roleDesc（卡内紧凑行）+ 成员计数（左栏固定头「成员·N」）；proposal N7 精确列举「仅收窄逐端口 chips」（§2.2/§1.2）。 |
| 7 | medium | F-171-4 是空断言（配置条目本不写，删 guard 也过） | 改按 P1 模式实证冻结（停原 member/草稿不丢/条目未选中/settle 后可切）（§5 F-171-5、§6.2）。 |
| 8 | medium | 测试影响面漏 `workgroups-pages.test.tsx`；用例数 17 非 19；源码含 `.split` 易被注释误满足 | 补第二测试文件入 §6.1/§8；勘误 17；新增改用真实 DOM 断言、源码锚点仅兜底（§6）。 |
| 9 | low | 笼统删 `.workgroup-card*` 会误删运行态仍用的 `.workgroup-cards__actions` | 明确 keep-list（§3.7/§8）+ grep 零消费者门槛 + task-config 回归纳入（§6.3）。只删 `.workgroup-studio*`/`.page--studio`。 |
| 10 | low | 端口计数英文无复数 → "1 ports" | 走 `portsCountBadge_one/_other`（§7），测试 0/1/多（§6.2）。 |
| R2-A | nit | blank-deselect `closest('.workgroup-card,...)` 硬编码旧类，卡根改 `.workgroup-mcard` 后失配 | selector 同步为 `closest('[data-member-key], button, a, input')`（§2.1 注意）。 |
| R2-B | nit | 「点 subtitle/badge 验证 hit-area」在 happy-dom `css:false` 下 `::after` 不可命中 | 改 CSS 源锁（`.workgroup-mcard{position:relative}`+`::after`）+ 真实按钮行为测试，像素命中留 e2e（§6.2 / §5 F-171-3）。 |
