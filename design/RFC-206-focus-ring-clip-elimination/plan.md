# RFC-206 · 任务分解

> 产品视角见 [proposal.md](./proposal.md)，技术设计见 [design.md](./design.md)。

## PR 拆分

> **实际交付情况**（与下表原计划有出入，出入原因写在各任务的「状态」段里）：

| PR | 任务 | commit | 主题 |
| --- | --- | --- | --- |
| PR-1 | T0、T1、T2 | `72dd7572` (+`9306a143` skip 白名单登记) | 守卫上线 + 37 条基线（**止血**） |
| PR-2 | T3、T4、**T7** | `588591b0` | 存量清零 → 白名单归空、**提前转硬失败** |
| PR-3 | T5'（第一批） | `077b99fe` | 覆盖工作流编辑器 + 任务详情，**+274 条**清零 |
| PR-4 | T5'（第二批）、T6、T8 | `1b99caea` | 覆盖评审详情 / 聊天室 / 弹窗，**+11 条**；T6 由实测收敛为无动作；收口 |

原计划的 **T5「长尾容器批量清零」被作废**（几何审计对那份静态清单一条也没报），
**T7 提前到 PR-2** 达成（T3+T4 一次清空了整份基线）。各 PR 严格串行：白名单是
后续批次的输入。

---

## T0 · `.form-input` 族 inset 化（**已交付**）

用户报告的两处直接修复，作为本 RFC 的既成前提。

- 新增 token `--focus-ring-offset-inset: calc(-1 * var(--focus-ring-width))`。
- `.form-input:focus`、`.user-picker .chips-input__row:focus-within` → `outline-offset` 用该 token。
- `.select__trigger:focus-visible`、`.clarify-custom-input:focus` 的 spread `box-shadow` → 加 `inset`。
- `.agent-form__panel` 补左右/下内边距（为其中**外扩环**的 `<Switch>` checkbox）。
- 新增 `packages/frontend/tests/focus-ring-inset.test.ts`（含表级 banned-pattern 守卫 + 变异测试已验证）。
- 更新 `workgroup-room-composer-outline-clip.test.ts` 中断言旧前置条件的那条 case。

**状态：已交付**（随 PR-1 `72dd7572` 提交）。四门全绿、明暗双主题像素验证通过。注：其中 `.agent-form__panel` 的内边距在 T3 被收敛掉了——gutter 上移到共享的 `.split__detail-body`，因为前者只覆盖 agent 表单，裸用 `.split__detail-body` 的 `/skills/new`、`/mcps/new`、`/plugins/new` 正是因此才漏掉。

**依赖**：无。

---

## T1 · 几何审计 spec（守卫核心）

新建 `e2e/focus-ring-clip.spec.ts`。

- CDP `CSS.forcePseudoState` 强制 `focus` + `focus-visible`，测完清除（design.md §3.2——**这是整个 RFC 最容易做错的一步**）。⚠️ `:focus-visible` 是否匹配取决于页面的**交互历史**：全新页面上程序化 `.focus()` 能匹配，但**只要发生过一次真实鼠标点击**（即所有现实 e2e 流程）此后就恒为 `false`、ink 归零。因此天真实现会**部分空跑**——总数非零、朴素自检照样通过，实际大半覆盖面为空。已用独立探针实测四种场景确认（design.md §3.2 表）。
- 把探针固化为 spec 内第一条 test（design.md §3.2.1）。
- 实现 `ink()`（outline + 逐图层 box-shadow 四边分量）与 `room()`（遍历**所有**裁剪祖先，padding box / scrollport）。
- **可聚焦性判定**而非手写选择器清单——必须含 `<summary>`（本仓 29 处，公共原语 `FormSection` 即是），排除 `disabled`/`inert`/`aria-hidden` 子树（design.md §3.1.1）。
- **逐实例测量**：⚠️ 绝不可在测量前按「类名 + 容器」去重——列表末位贴边实例会被中间的安全实例代表掉，真违规全绿（design.md §6.2）。去重只能发生在测量之后的报告折叠阶段。
- 四类假阳性排除（design.md §3.3）。
- 伪元素环处理（design.md §3.4）。
- **反向自检探针**（design.md §6.3）——防审计引擎退化成空跑。
- `test.skip` 非 chromium 并注明原因。
- 覆盖：全部主要路由 + 主要弹窗 + desktop/≤720px 两个视口。

**验收**：反向自检能检出人造违规；排除逻辑三条用例通过；失败信息含元素/容器/边/差值 px。

**依赖**：T0。

**状态：已完成**（`e2e/focus-ring-clip.spec.ts`）。4 条引擎自检 + 1 条全量 sweep 全绿。实现期又抓到两个静默假阴与一个假阳，均已修并上锁，详见 design.md §6.2.1：逐边判定（整体「是否完全在视口内」会因 `.tabs__tab` 的 `margin-bottom:-1px` 隐藏 `.tabs` 的真实裁剪）、单 test 收敛（Playwright 失败后重启 worker 会清空模块级累加、使陈旧检测误报）、伪元素只认 `outline`（否则开关圆点的装饰投影误报）。

---

## T2 · 基线白名单（止血完成）

- 跑 T1 的审计，把**全部**存量违规导出为 `KNOWN_CLIPS`，每条写理由 + 归属批次（T3/T4/T5/T6）。
- key 形如 `<route>::<control>::<clipper>::<side>::<occurrence>`——⚠️ **必须带实例序号**，否则一条豁免会顺带放行后来新增的同类被切控件，陈旧检测也分不清「3 个里修好 2 个」（design.md §3.5）。
- 实现陈旧条目检测。
- 把清单同步进本文件 §「存量清单」小节，作为后续批次的工单来源。

**验收**：CI 全绿（存量全在白名单里）；新增任何违规立刻红（用反向自检证明）。**此刻起不再有新的复发。**

**依赖**：T1。

**状态：已完成**。基线 **37 条**，全部来自 **4 个根因**（下表即 T3 的工单）。`RFC206_DUMP_BASELINE=1` 可机械重生成，无需手抄。双向变异验证：删一条豁免 ⇒ 该裁剪立刻被报；加一条假豁免 ⇒ 被判 stale。

| 数量 | 控件                             | 裁剪容器              | 根因                                                            |
| ---- | -------------------------------- | --------------------- | --------------------------------------------------------------- |
| 18   | `.segmented__option`             | `.page-filter`        | `overflow-x:auto` 无 padding；`.segmented` 只给 2px，环要 4px   |
| 15   | `.tabs__tab`                     | `.tabs`               | **TabBar，全站在用**；`overflow-x:auto` + `padding:0` vs 4px 环 |
| 2    | `input`（`.form-switch` 复选框） | `.split__detail-body` | 裸 `.split__detail-body` 无 gutter，控件贴 x=0                  |
| 2    | `.segmented__option`             | `.split__detail-body` | 同上                                                            |

值得注意：`/repos` 批量导入弹窗与 `/agents` 高级页签（用户最初报的两处）**已通过**——T0 的 inset 化在真实浏览器里得到端到端验证。

---

## T3 · 全站级容器修复

按实测影响面排序，最高优先：

- `.tabs`（`overflow-x: auto`, `padding: 0`）—— **TabBar 全站在用**，页签焦点环上/下/左三边被切。已实测。
- `.split__detail-body`（`overflow: auto`，零 padding）—— agent/skill/mcp/plugin 详情与新建页共用。已实测。
- `.page-filter` → `.segmented__option`（2px room vs 4px ring）。

统一改用 `--focus-ring-gutter`（design.md §5）。

**验收**：这三条从白名单删除后审计仍绿；补源码锁。

**依赖**：T2。

**状态：已完成**，但**修法与本任务初稿不同**——实施时改用了更彻底的一招。

`.tabs`（`overflow-x:auto`）与 `.page-filter`（同）是**故意做成可横向滚动**的，因此其子元素**天生贴着裁剪边**，与满宽表单控件是同一类处境。给这类容器补 padding 只是又一次 O(容器数)；正确做法是把**环**内移：

- `.tabs__tab` / `.segmented__option` 从共享 `:where(.btn, …)` 外扩规则中**移出**，改用 `--focus-ring-offset-inset`。一次覆盖 35/37 条违规，**零布局改动、零溢出风险**（补 padding 反而要动 `.tabs` 的 `border-bottom` 与 `.tabs__tab` 的 `margin-bottom:-1px` 对齐关系）。
- 剩余 2 条（`.form-switch` 复选框，外扩环、贴 x=0）走容器 gutter：新 token `--focus-ring-gutter: 4px` 加到 **`.split__detail-body`**，而不是 T0 时的 `.agent-form__panel`——后者只覆盖 agent 表单，裸 `.split__detail-body` 的 `/skills/new`、`/mcps/new`、`/plugins/new` 正是因此才漏掉。T0 的 `.agent-form__panel` 特例随之收敛为只留 `padding-top`。

由此得出本 RFC 的**判据**（已写入 `focus-ring-inset.test.ts` 的 `SCROLL_FLUSH` 表）：**「贴边是否由构造决定」**——满宽表单控件、页签条、分段筛选条都是，改环；`.btn` / `.nav-item` / `.sidebar__link` / `.dialog__close` 不是，保持外扩环 + 容器 gutter。

明暗双主题截图复验：环四边完整。

---

## T4 · a11y 硬伤：焦点环 100% 不可见

- `.workgroup-card__open::after` —— `position: absolute; inset: 0` 装在 `overflow: hidden` 的 `.split-card` 里，`outline-offset: 2px` 起点就在裁剪盒外，**整圈焦点环完全不可见**。修法参照同文件已 inset 化的 `.split-card:focus-visible`（`outline-offset: -2px`）。
- 顺带核对 `.gallery-card__stretch::after`（已是 inset，确认无回归）。

**验收**：键盘 Tab 到工作组成员卡时焦点环可见；审计对应条目从白名单删除。

**依赖**：T2。（与 T3 无耦合，可并行）

**状态：已完成**。`.workgroup-card__open:focus-visible::after` 改 `--focus-ring-offset-inset`。`.gallery-card__stretch::after` 复查确认本就是 inset，无回归。

⚠️ 注意：这条**几何审计并未报出**——因为白名单基线是在有数据的路由上采的，而工作组成员卡需要 fixture 才渲染（见 T5）。它是静态审计发现、人工复核确认的。这正说明**两层守卫互补**：几何层判得准但只看得见它走到的页面。

---

## T5 · 零 padding 列表滚动容器批量清零

`.workgroup-room__runlog`、`.files-picker__list`、`.upload-picker__list`、`.events-list`、`.fusion-picker`、`.workflow-node-picker__groups`、`.worktree-diff__tablist`、`.structure__tablist`、`.worktree-files-panel__tree-body`、`.review-multidoc__list`、`.task-outputs-panel__list`、`.agent-import__section`、`.inventory-section__body` 等。

**注意**：逐条以审计输出为准，不照抄本清单——本清单来自静态审计，其中部分容器可能实际不含可聚焦子元素（假阳）。**以 T2 的实测白名单为唯一工单来源。**

**依赖**：T2。

**状态：作废（无事可做），改立 T5'。** T3 的环内移一次清掉 35/37 条，剩 2 条由 `.split__detail-body` gutter 解决；几何审计对上表**一条也没报**。这验证了 design.md §2 的判断——静态审计的容器清单里，大部分要么根本不含外扩环的可聚焦子元素，要么已有足够 padding。**按清单逐个补 padding 会是纯粹的无用改动。**

### T5' · 扩大审计覆盖面（真正的剩余工作）

当前审计走的是列表页 / new 页 + agent 详情五个页签 + 批量导入弹窗。**需要 fixture 才渲染的重面尚未覆盖**，因此「0 违规」的结论只在已覆盖面上成立：

- 任务详情（含 worktree diff / 输出面板 / 反问面板）
- 工作组房间（`.workgroup-room__runlog`、成员卡——T4 那条硬伤就藏在这里，是静态审计而非几何审计发现的）
- 评审详情（`.review-detail__layout` 只有 `padding-right`）
- 工作流编辑器（`.inspector`、`.editor-sidebar`、节点选择器）
- 记忆蒸馏 / 融合等次级弹窗

做法：照 `a11y.spec.ts` 的 seed 套路补 fixture，把这些面加进 `ROUTES` / 弹窗用例。**每加一面都可能带出新违规，属预期**。

**状态：第一批已完成（工作流编辑器 + 任务详情）。**

新 fixture：seed 一个 workflow + 一个跑到终态的 task，覆盖 `/workflows/{id}`（编辑器，含选中节点后才挂载的右侧 inspector）与 `/tasks/{id}` 的 **9 个 `?tab=`**（任务详情走 `PageSectionNav` + `?tab=` 查询参，不是 `role=tab` 的 TabBar；且输出面板自带一组**不可见**的 `[role="tab"]`，点它只会超时——必须按 URL 驱动）。

**一加覆盖就报出 274 条**，来自 12 个根因——这正好证实了此前「0 违规只在已覆盖面上成立」的保留意见。已全部清零：

| 数量 | 控件 | 容器 | 处置 |
| --- | --- | --- | --- |
| 100 | `.page-section-nav__group-trigger` | `.page-section-nav__group-triggers` | 环内移 |
| 60 | `.page-section-nav__leaf` | `.page-section-nav__active-group-leaves` | 环内移 |
| 40 | `.react-flow__controls-button` | `.react-flow__panel` | 容器 gutter |
| 42 | `.btn` / `.data-table__link` | `.page--task-detail`（`overflow:hidden` 无 padding） | 容器 gutter |
| 12 | `.btn` | `.page--editor > .page__header > .page__actions`（原 `2px` 是按 2px 输入框环定的，按钮是 4px） | 容器 gutter |
| 6 | `.btn` / `.task-outputs-panel__option` | `.task-detail__pane`、`.task-outputs-panel__*` | gutter + 环内移 |

三个 nav / option 控件**此前根本没有 app 焦点样式**，用的是 UA 默认环（同样画在盒外、同样被切）。纳入共享 inset 组既修了裁剪，也把它们拉回设计系统的焦点样式。

明暗验证：任务详情与编辑器截图复核，4px gutter 视觉上不可察觉。

**第二批已完成（评审详情 + 工作组房间 + 次级弹窗）。** 新 fixture：一个停在
`awaiting_review` 的任务（评审节点的 `inputSource` 必须是 `markdown` kind 的
输出端口，且入边端口名是 `__review_input__` 而非 `input`）、一个工作组任务
（走 `POST /api/workgroups/:name/tasks`，body 是 `{name, goal}`，**不是**
`/api/tasks` + `workgroupId`），以及三个弹窗。又报出 **11 条**，全部清零：

| 数量 | 控件 | 容器 | 处置 |
| --- | --- | --- | --- |
| 7 | `.btn` / `.link`（评审决策按钮、任务回链） | `.page--review-detail`（`overflow:hidden` 无 padding） | 容器 gutter |
| 4 | `.workgroup-room__runlog-row` | `.workgroup-room__runlog`（`overflow-y:auto`、`padding:0`） | 环内移（四边全被切） |

**顺带用实测否掉了一个静态推测**：T6 一直挂着「`.review-detail__layout` 只有
`padding-right: 14px`，左/上/下为 0」这条待办——真实几何显示**它没问题**，
真正的裁剪者是外层的 `.page--review-detail`。这正是本 RFC 坚持「让几何说话、
不照静态清单改代码」的价值。

### ⚠️ 覆盖门（本批新增的关键防线）

本批一开始「0 违规」是**假的**——两个新 fixture 静默失败了（工作组任务和评审
任务的 API 契约都用错），审计对这两个面**一个控件都没量**，却和「干净」长得
一模一样。为此新增**覆盖门**：审计记录每个面实际测量了多少个可聚焦控件，并
硬性要求 10 个关键面非零；三个弹窗的触发按钮找不到时也从静默 `continue` 改成
**直接失败**（`/agents`、`/skills` 头部根本没有 import 按钮，原写法一直在空跑，
正是被这道门抓出来的）。

### 窄视口（≤720px）补齐

design.md §6 的失败模式表早就写了「只测了默认视口 ⇒ 移动端 `@media` 下的容器漏测」，
T1 也把「desktop / ≤720px 两个视口」写进了任务，但**第一版实现漏了**——直到收口自查
才发现 spec 里连一次 `setViewportSize` 都没有。`styles.css` 有一整套
`@media (max-width: 720px)` 规制会换掉容器（`.md-editor--fill` 变成无 padding 的
`overflow-y:auto`、`.workgroup-room__side` 反转成 `overflow: visible`、tasks 工具栏的
`.segmented` 自己变成滚动盒、`.page--split` 长出移动端返回键），等于有半套响应式 CSS
从没被审计过。

现已补上：6 条代表性路由 + 任务详情在 720×900 下重扫一遍，**0 违规**（覆盖门确认
确实测到了控件，不是空跑）。踩到一个实现细节：这段必须放在 `cdp.detach()` **之前**，
否则 CDP 会话已关闭、`sweep()` 直接抛 `Target page, context or browser has been closed`。

覆盖面现状：21 条列表/新建路由 + agent 详情 5 页签 + 工作流编辑器（含 inspector）
+ 任务详情 9 个 `?tab=` + 评审详情 + 工作组聊天室 + 3 个弹窗 + **≤720px 窄视口重扫**。

---

## T6 · 已有补丁的补齐与归位

- `.review-detail__layout` —— 只有 `padding-right: 14px`，左/上/下为 0。
- `.page--editor > .form-grid` —— `padding-inline: 2px` 不够 4px 外扩环，且纵轴无保护。
- `.task-detail__pane` —— 仅 `> .workgroup-room` 受保护，其它 pane 子项裸奔。
- 复查四处历史补丁：失效的删（连同源码锁），仍有用的补注释说明「为谁保留」（design.md §5、验收标准 AC6）。

**依赖**：T2，以及 **T5'**——必须先让几何审计能走到那里，否则是在凭静态推测改代码（正是本 RFC 要根除的做法）。

**状态：部分完成。** T5' 第一批覆盖上来后，`.page--editor > .page__header > .page__actions`（2px → gutter）与 `.task-detail__pane`（此前只有 `> .workgroup-room` 受保护）**已由实测驱动修掉**，不是照静态清单猜的。四处历史补丁的注释归位已在 T0/T3 完成。

**已由实测收敛**（T5' 两批覆盖上来之后）：

- `.review-detail__layout`（`padding-right: 14px`）—— **实测无问题，不改**。真正的裁剪者是外层 `.page--review-detail`，已补 gutter。这条静态推测被证伪，正是本 RFC 的方法论价值。
- `.page--editor > .form-grid`（`padding-inline: 2px`）—— 编辑器面已进审计（`/workflows/{id}` + 选中节点），**未报违规**，说明 2px 对实际住在里面的控件够用（满宽表单控件的环已内移）。**不改**。
- `.task-detail__pane`、`.page--editor > .page__header > .page__actions` —— 已在 T5' 第一批由实测驱动修掉。
- 四处历史补丁的注释归位已在 T0/T3 完成。

**结论：T6 无剩余动作。** 原清单里其余条目要么被环内移一并解决，要么经实测确认本就不违规。

---

## T7 · 白名单清空 → 转硬失败

- 确认 `KNOWN_CLIPS` 为空。
- 移除豁免机制本身（或保留空 Map + 一条「新增条目需 RFC 说明」的注释锁）。
- 静态层同步转硬失败。

**状态：已完成（提前到 PR-2）。** T3+T4 一次清空 37 条基线，故白名单**现在就是空的**，审计已处于**硬失败**模式：任何新增裁剪立即红。保留空 `Map` + 注释说明「新增条目＝声称某个被裁的焦点环可接受，需 RFC-206 修订并写明为谁豁免」，并指向两条正解（贴边由构造决定 → 环内移；容器缺空间 → `--focus-ring-gutter`）。

**验收**：AC5、AC4。

**依赖**：T3–T6 全部完成。

---

## T8 · 收口（进行中）

**已做**：STATE.md 与 `design/plan.md` RFC 索引状态翻新（Draft → In Progress，列明已交付/剩余）。

**替代已做**：Codex 不可用期间改用**独立对抗审查**（另起一个上下文、只给我这份
累计 diff + 设计意图，专问「两道守卫能不能在真有裁剪时静默通过」）。这不能顶替
Codex 门，但比什么都不做强，发现项与处置记在下方。

**未做（外部阻塞）**：**实现门 Codex review 没跑成**。两次尝试：第一次 `Turn failed / Reviewer failed to output a response`；第二次明确报 `You've hit your usage limit … try again at Jul 25th, 2026 12:03 PM`。**配额恢复后必须补跑**——按 `feedback_codex_review_after_changes`，设计门与实现门是两道独立的门，设计门过了不代表实现门可以省。补跑方法（共享树必须隔离，否则会被并发 session 的 diff 淹没）：

```
git worktree add --detach <wt> b1ac247a
cd <wt> && git cherry-pick 72dd7572 588591b0 9306a143
node <codex-companion> review --wait --base b1ac247a --scope branch
```

**CI 上仍未跑过（不是本 RFC 能控制的）**：连续三轮 CI（`f8ea36c2` / `3033f4ec` / `66937ae4`）的 `Playwright e2e` 与 `Build single-binary (smoke)` 都被 **skip**——它们 gate 在 backend 分片之后，而 backend 一直红在并发 session 的提交上（依次为 `7ee8df92` RFC-207 漏改三个测试文件、`b9fdecd6` RFC-210 的 `rfc210-alternates`）。逐条 bisect 确认与本 RFC 无关。

**替代验证（已做，可复现）**：在 `origin/main` 的**干净 detached worktree** 里
`bun install --frozen-lockfile` + `bun run build` + `bun run build:binary`（走
CI 同一条产物链，smoke 通过），再跑 `focus-ring-clip.spec.ts` —— **5/5 绿**
（4 条引擎自检 + 全量 sweep，空白名单 + 覆盖门）。这与 CI 会做的事等价，唯一
差别是 runner 环境。等 backend 转绿后仍应确认该 spec 在 CI 里**真的执行过**
而不是又被 skip。

---

## T8 原始清单

- STATE.md 翻 Done + `design/plan.md` RFC 索引状态更新。
- Codex **实现门** review（按 `feedback_codex_review_after_changes`，与设计门相互独立）。
- 四门 + Playwright + 单二进制 smoke 全绿。

**依赖**：T7。

---

## 验收清单

- [x] AC1 几何审计遍历全部主要路由/弹窗，失败信息含元素/容器/边/差值/实例序号
- [x] AC2 变异测试：`.form-input:focus` offset 改回 `0` ⇒ 审计红（另加两条：级联赢家、blur-only 光晕）
- [x] AC3 静态层全表扫描，新增 scroll-flush 控件外扩环立刻红
- [x] AC4 白名单陈旧条目检测（几何层双向变异验证过）
- [x] AC5 白名单清空、已转硬失败
- [x] AC6 四处历史补丁去留明确：`.dialog__body` / `.task-detail__pane>.workgroup-room` 保留并注明「为谁保留」；`.agent-form__panel` 特例收敛回 `padding-top`；`.page--editor > .form-grid` 经实测确认无需改动
- [x] AC7 typecheck / lint / frontend 4987 / format:check + Playwright chromium 5/5 + binary smoke 全绿
- [x] **附加**：覆盖门——每个面必须实测到非零控件数，防 fixture 静默失效导致的假绿

## 存量清单

> 由 T2 产出后回填此处。当前 §T3–T6 中列出的条目来自**静态审计**（子代理全表扫描 + 本机实测四条），仅作规模估计与批次划分依据，**不作为工单事实来源**。
