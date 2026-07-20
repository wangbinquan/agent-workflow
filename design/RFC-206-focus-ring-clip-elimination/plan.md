# RFC-206 · 任务分解

> 产品视角见 [proposal.md](./proposal.md)，技术设计见 [design.md](./design.md)。

## PR 拆分

| PR   | 任务               | 主题                                               |
| ---- | ------------------ | -------------------------------------------------- |
| PR-1 | T0（已落）、T1、T2 | 守卫上线 + 基线白名单（**止血**）                  |
| PR-2 | T3、T4             | 高影响面存量修复（全站 TabBar / 面板 / a11y 硬伤） |
| PR-3 | T5、T6             | 长尾容器清零                                       |
| PR-4 | T7、T8             | 白名单清空 → 转硬失败 + 收口                       |

各 PR 之间**严格串行**：白名单是 PR-2/3 的输入，必须先由 PR-1 产出。

---

## T0 · `.form-input` 族 inset 化（**已完成，未提交**）

用户报告的两处直接修复，作为本 RFC 的既成前提。

- 新增 token `--focus-ring-offset-inset: calc(-1 * var(--focus-ring-width))`。
- `.form-input:focus`、`.user-picker .chips-input__row:focus-within` → `outline-offset` 用该 token。
- `.select__trigger:focus-visible`、`.clarify-custom-input:focus` 的 spread `box-shadow` → 加 `inset`。
- `.agent-form__panel` 补左右/下内边距（为其中**外扩环**的 `<Switch>` checkbox）。
- 新增 `packages/frontend/tests/focus-ring-inset.test.ts`（含表级 banned-pattern 守卫 + 变异测试已验证）。
- 更新 `workgroup-room-composer-outline-clip.test.ts` 中断言旧前置条件的那条 case。

**状态**：代码已写、四门全绿（typecheck / lint / 4937 前端用例 / format）、明暗双主题像素验证通过。**尚未 commit**，等本 RFC 批准后随 PR-1 一起提交。

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

---

## T6 · 已有补丁的补齐与归位

- `.review-detail__layout` —— 只有 `padding-right: 14px`，左/上/下为 0。
- `.page--editor > .form-grid` —— `padding-inline: 2px` 不够 4px 外扩环，且纵轴无保护。
- `.task-detail__pane` —— 仅 `> .workgroup-room` 受保护，其它 pane 子项裸奔。
- 复查四处历史补丁：失效的删（连同源码锁），仍有用的补注释说明「为谁保留」（design.md §5、验收标准 AC6）。

**依赖**：T2，以及 **T5'**——前三条都在尚未覆盖的面上，必须先让几何审计能走到那里，否则是在凭静态推测改代码（正是本 RFC 要根除的做法）。四处历史补丁的注释归位已在 T0/T3 完成。

---

## T7 · 白名单清空 → 转硬失败

- 确认 `KNOWN_CLIPS` 为空。
- 移除豁免机制本身（或保留空 Map + 一条「新增条目需 RFC 说明」的注释锁）。
- 静态层同步转硬失败。

**状态：已完成（提前到 PR-2）。** T3+T4 一次清空 37 条基线，故白名单**现在就是空的**，审计已处于**硬失败**模式：任何新增裁剪立即红。保留空 `Map` + 注释说明「新增条目＝声称某个被裁的焦点环可接受，需 RFC-206 修订并写明为谁豁免」，并指向两条正解（贴边由构造决定 → 环内移；容器缺空间 → `--focus-ring-gutter`）。

**验收**：AC5、AC4。

**依赖**：T3–T6 全部完成。

---

## T8 · 收口

- STATE.md 翻 Done + `design/plan.md` RFC 索引状态更新。
- Codex **实现门** review（按 `feedback_codex_review_after_changes`，与设计门相互独立）。
- 四门 + Playwright + 单二进制 smoke 全绿。

**依赖**：T7。

---

## 验收清单

- [ ] AC1 几何审计遍历全部主要路由/弹窗，失败信息含元素/容器/边/差值
- [ ] AC2 变异测试：`.form-input:focus` offset 改回 `0` ⇒ 审计红
- [ ] AC3 静态层全表扫描，新增满宽控件外扩环立刻红
- [ ] AC4 两个白名单均有陈旧条目检测
- [ ] AC5 白名单清空、转硬失败
- [ ] AC6 四处历史补丁去留明确，无无主补丁
- [ ] AC7 typecheck / lint / test / format:check + Playwright chromium + binary smoke 全绿

## 存量清单

> 由 T2 产出后回填此处。当前 §T3–T6 中列出的条目来自**静态审计**（子代理全表扫描 + 本机实测四条），仅作规模估计与批次划分依据，**不作为工单事实来源**。
