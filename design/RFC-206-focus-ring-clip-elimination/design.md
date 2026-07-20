# RFC-206 · 技术设计

> 产品视角见 [proposal.md](./proposal.md)，任务分解见 [plan.md](./plan.md)。

## 1. 缺陷模型（精确定义）

### 1.1 为什么环会被切

- `outline` **永远**画在 border box 外面。`outline-offset` 只调整起点，非负值时全部落在盒外。CSS 规范里 `outline` 不参与布局，因此不撑开父容器。
- 非 `inset` 的 `box-shadow` 同理：spread + blur + offset 全部画在 border box 外。
- `overflow != visible` 的元素在自己的 **padding box** 处裁剪后代（scroll 容器则是 scrollport）。
- CSS Overflow 规范规定两个轴不能一个 `visible` 一个非 `visible`：**只要设了 `overflow-y: auto`，`overflow-x` 就会计算成 `auto`**，于是纵向滚动区同样横向裁剪。这是 `.dialog__body` 明明只想纵向滚动却切掉输入框左右边的原因。

### 1.2 判定式

对元素 `el` 与其某个裁剪祖先 `c`，在每条边 `s ∈ {top, right, bottom, left}` 上：

```
violation(el, c, s)  ⟺  room(el, c, s) < ink(el, s)
```

- **`ink(el, s)`** —— 焦点指示在 `s` 边画到 border box 外面多少 px：
  - `outline`：`outline-style != none && outline-width > 0` ⇒ `outline-width + outline-offset`（四边相同）。
  - `box-shadow` 每个**非 inset** 图层 `(dx, dy, blur, spread)`：
    - `top = spread + blur - dy`，`bottom = spread + blur + dy`
    - `left = spread + blur - dx`，`right = spread + blur + dx`
  - 多来源取每条边的 **max**。
- **`room(el, c, s)`** —— `el` 的 border box 边到 `c` 的 padding box 边的距离（`c` 的 border box 内缩其 border-width；scroll 容器用 scrollport）。

**关键：必须遍历所有裁剪祖先，不能只看最近的一个。** 最近祖先给够了空间，外层祖先仍可能切。

### 1.3 今日实测数据（浏览器内取得，非推演）

| 现场                                                 | ink | room                 | 结论                        |
| ---------------------------------------------------- | --- | -------------------- | --------------------------- |
| `/repos` 批量导入 textarea ↑ `.dialog__body`         | 2   | `top: 0`             | 上边整条被切                |
| `/agents 高级` JSON textarea ↑ `.split__detail-body` | 2   | `left: 0, right: 0`  | 左右被切                    |
| `/agents 高级` `<Switch>` checkbox ↑ 同上            | 4   | `left: 0`            | 左边被切                    |
| `.tabs__tab` ↑ `.tabs`                               | 4   | `top/bottom/left: 0` | 三边被切（TabBar 全站在用） |

## 2. 双层守卫：各司其职

用户要求「两者都要」。但**两层不应该测同一件事**——静态层测不了真实几何，几何层跑得慢。按各自能力分工：

|      | 静态层（vitest）                                                   | 几何层（Playwright）                  |
| ---- | ------------------------------------------------------------------ | ------------------------------------- |
| 位置 | `packages/frontend/tests/focus-ring-inset.test.ts`（已存在，扩展） | `e2e/focus-ring-clip.spec.ts`（新建） |
| 管   | **集合 A**：焦点环本身不得外扩                                     | **A×B 交叉**：真实布局里有没有被切    |
| 速度 | 秒级，本地 push 前即得反馈                                         | CI 级                                 |
| 判据 | 源码文本（精确，集合小）                                           | 真实几何（无假阳假阴）                |

**为什么静态层不管集合 B（容器 padding）**：那需要枚举 100+ 条 `overflow` 规则并要求每条带 ≥4px padding，会产生一份约 40 条的噪音白名单，而其中绝大多数容器**根本不含可聚焦子元素**（纯文本截断的 `overflow: hidden` 就有 80 条）——假阳性会淹没信号，且假阴性依然存在（padding 够但子元素负 margin 顶出去）。容器这一侧交给几何层用事实判定。

静态层管集合 A 则是高信噪比的：集合小（~36 条）、判据精确、且拦的是**最危险的回归**——有人给满宽控件新写了一个外扩环。

## 3. 几何层设计（`e2e/focus-ring-clip.spec.ts`）

结构照搬 `e2e/a11y.spec.ts`（同为「遍历路由 + 基线白名单 + 陈旧条目检测」形态），复用 `startDaemon()` / `primeAuth()`。

### 3.1 流程

```
for 每条路由 / 每个待测弹窗:
  导航 + 等待稳定锚点
  收集候选 = 可聚焦性判定（§3.1.1，不是一条手写选择器）
  for 每个候选:
    强制 :focus + :focus-visible          ← 见 §3.2
    读 computed style → 算 ink（四边）
    向上遍历所有裁剪祖先 → 算 room（四边）
    room < ink ⇒ 记一条违规
  比对白名单 → 未豁免的违规 ⇒ fail
```

#### 3.1.1 可聚焦性判定（不能用手写选择器清单）

一条 `button, a[href], input, textarea, select, [tabindex]` 的清单**不完整**，会漏出静默盲区。已确认的漏网面：**`<summary>` 原生可键盘聚焦，本仓有 29 处**，分布在 `ErrorDetails` / `AgentForm` / `ValidationPanel` / `StuckTaskBanner` / `TaskDiagnosePanel` / `EdgeInspector` 等，且**公共原语 `FormSection.tsx` 就是 `<details>/<summary>`**——意味着漏掉它等于漏掉所有用该原语的折叠区。它们由 UA 提供焦点环（画在盒外），被容器切了审计却完全看不见。

所以候选集必须用**可聚焦性判定**而非选择器清单：

- 纳入 `summary`（`<details>` 的直接子元素）、`[contenteditable]`、`audio[controls]`/`video[controls]` 等原生可聚焦元素。
- **排除** `disabled`、`inert`（含祖先 inert）、`tabindex="-1"`、`aria-hidden="true"` 子树。
- 兜底自检：把候选集与「实际 Tab 序」抽样比对（挑一条路由做全键盘遍历），数量对不上就说明判定还有漏。

### 3.2 ⚠️ 关键实现约束：`:focus-visible` 会随「交互历史」静默失效

**实测数据（2026-07-20，Playwright 1.60 headless chromium，探针见 §3.2.1）**：

| 场景                                        | `:focus-visible` 匹配 | 计算 outline | ink   |
| ------------------------------------------- | --------------------- | ------------ | ----- |
| 全新页面 + `el.focus()`                     | ✅ true               | `solid`      | 4     |
| **发生过一次真实鼠标点击后** + `el.focus()` | ❌ false              | `none`       | **0** |
| 同页 CDP 强制                               | ✅ true               | `solid`      | 4     |
| 清除强制态后                                | ❌ false              | `none`       | 0     |

`:focus-visible` 是否匹配取决于浏览器的「最近一次输入是键盘还是指针」启发式。**程序化 `.focus()` 本身并不决定结果——页面的交互历史决定。**（`el.focus({ focusVisible: true })` 也不改变这一点；本机真实 Chrome 里因为先前有鼠标点击，实测同样为 `false`。）

**这比「完全测不到」更危险**，因为它是**部分失效**：

- 一条 spec 只要点击过任何东西——导航点链接、点按钮开弹窗，也就是**所有现实中的 e2e 流程**——此后该页面上所有程序化聚焦都测出 `ink = 0`。
- 于是路由 A（进来没点过）出真实数据、路由 B（点开过弹窗）出零覆盖。**总数非零**，所以「它报出了一些违规，说明它在工作」这种朴素自检**会通过**，而实际上大半覆盖面是空的。

今日初版扫描正是踩了这个坑：全站报 0 违规，而 `.tabs__tab` 实际三边被切。

**解法**：用 Chrome DevTools Protocol 强制伪类，使结果与交互历史**无关**、可确定复现。

```ts
const cdp = await page.context().newCDPSession(page)
await cdp.send('DOM.enable')
await cdp.send('CSS.enable')
// nodeId 由 DOM.querySelectorAll / DOM.requestNode 取得
await cdp.send('CSS.forcePseudoState', {
  nodeId,
  forcedPseudoClasses: ['focus', 'focus-visible'],
})
```

**已验证可用**（上表第 3 行）。两条使用纪律：

1. **测完必须清除**——`forcedPseudoClasses: []`。强制态是**按节点持久**的，不清会让后续元素在「祖先仍被强制 focus-within」之类的污染状态下测量。
2. **`nodeId` 会随 DOM 变动失效**——每条路由重新 `DOM.getDocument` 取 root，不要跨导航复用。

**这决定了几何层只能跑 chromium**（CDP 是 Chrome 特有）。与现有配置天然吻合：`playwright.config.ts` 默认 project 就是 chromium，webkit 需 `PLAYWRIGHT_WEBKIT=1` 且只在夜间 cron 跑。spec 顶部用 `test.skip(({ browserName }) => browserName !== 'chromium', ...)` 显式跳过并说明原因。

#### 3.2.1 复现探针

上表由一段 ~25 行的独立脚本产出（`setContent` 一个 `overflow` 容器 + 贴边按钮 → 依次测「新页程序化聚焦 / 真实点击后 / CDP 强制 / 清除强制」）。**T1 实现时应把它固化为 spec 内的第一条 test**——它同时是 §6.3 反向自检的天然载体：一旦哪天 CDP 行为变化或强制失效，这条先红，而不是等整个审计静默退化成空跑。

**AC2 的变异测试就是防止空跑复发的护栏**——把 `.form-input:focus` 的 offset 改回 `0` 必须变红。这条**必须**在 CI 里以某种形式固化（见 §6.3），否则守卫哪天悄悄退化成空跑，没人会知道。

### 3.3 假阳性控制

以下情形必须跳过，否则噪音淹没信号：

1. **滚动出视口的元素** —— 长列表里滚到 scrollport 外的行，其 `room` 天然为负。只测**完全落在 scrollport 内**的元素。
2. **零尺寸 / 不可见** —— `display: none`（keep-mounted 的 `[hidden]` 页签面板）、`visibility: hidden`、`width/height == 0`。
3. **`position: fixed` 后代** —— 脱离了祖先的裁剪链（portal 弹窗、下拉 popover 都是这一类），按其真实包含块判定，不沿用 DOM 祖先链。
4. **`overflow: clip` + `overflow-clip-margin`** —— 后者会外扩裁剪盒，计算 room 时要加上。（注：`overflow-clip-margin` 对 `auto`/`scroll` **无效**，只对 `clip` 生效，不能拿来救滚动容器。）

### 3.4 伪元素环

`.workgroup-card__open::after`、`.gallery-card__stretch::after` 这类「absolute 拉伸覆盖层承载焦点环」的写法必须覆盖，因为其中已确认一处真 bug：`.workgroup-card__open::after` 是 `position: absolute; inset: 0`，装在 `overflow: hidden` 的 `.split-card` 里，**焦点环 100% 不可见**。

JS 拿不到伪元素的几何。处理：`getComputedStyle(el, '::after')` 读样式，若 `position: absolute` 且四个 inset 值均为 0，则其 border box == 宿主的 padding box，据此换算 ink 相对宿主 border box 的外扩量；其它 inset 组合**不猜**，登记为「无法自动判定」并列入人工复核清单。

### 3.5 白名单契约

```ts
// key: `<route>::<control>::<clipper>::<side>::<occurrence>`
const KNOWN_CLIPS = new Map<string, string>() // key -> 理由（必填）
```

- 每条**必须**写理由，照 `a11y.spec.ts` 的 `KNOWN_VIOLATIONS` 惯例。
- **陈旧条目检测**：条目对应的违规已不存在 ⇒ 测试红（防「修好了但白名单没删」）。
- ⚠️ **key 必须带实例身份，不能只用类名**。同一个 `.dialog__body` 下往往有多个 `.btn`，若 key 只到「路由 + 类名 + 容器 + 边」，则：
  - 为**一个**已知违规加的豁免，会顺带豁免**后来新增**的同类被切按钮 —— 守卫在自己最该拦的场景上开了口子；
  - 陈旧条目检测也无法分辨「3 个里修好了 2 个」。

  故 key 追加**同键内出现序号**（DOM 序稳定），并在失败信息里同时打印该实例的 `textContent` 摘要与 box 坐标便于定位。类名仍作为主干（比 nth-child 路径稳），序号只用于消歧。

## 4. 静态层扩展（`focus-ring-inset.test.ts`）

已在今日落地的表级守卫基础上扩展：

- 现状：只覆盖 6 个满宽表单控件类（`FULL_BLEED` 表）。
- 扩展：改为**全表扫描**——`styles.css` 里**任何**焦点态规则若把指示画在盒外，必须命中 `INTRINSIC_CONTROLS` 白名单（`.btn`/`.tabs__tab`/`.nav-item`/`.segmented__option`/`.choice-card`/`.split-card` 等固有尺寸控件）。
- 白名单同样带**陈旧条目检测**。
- 保留今日已验证的健壮性处理：**先剥注释再解析**（`:root` 的注释里引用了 `.tabs__tab--active { … }`，不剥会让 brace 扫描提前截断）；**按选择器合并规则体**（`.form-input:focus` 被写了两处，级联并集才是有效值，分开判会误报）。

## 5. 修法归位：容器补丁的去留

根治后，四处历史容器补丁分两类处置：

- **失效的**（原本只为满宽表单控件而存在）⇒ 删除，连同其源码锁。
- **仍有用的**（容器里还有**外扩环**的固有尺寸控件）⇒ 保留，并在注释里写明「为谁保留」。今日已按此处理 `.dialog__body`（为 `.btn` / `.table-viewport__scroller` 保留）与 `.task-detail__pane > .workgroup-room`（为 `.status-chip--clickable` 等保留）。

为避免各处 `4px` 魔数散落，引入 token：

```css
--focus-ring-gutter: 4px; /* ≥ 最宽外扩环 = width 2px + offset 2px */
```

需要补内边距的容器统一用它，`--focus-ring-offset` 调整时一处生效。

## 6. 失败模式与对策

| 失败模式                                    | 后果                                                                        | 对策                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **审计空跑**（`:focus-visible` 没真正生效） | 全绿但零覆盖，比没有守卫更危险——给人虚假安全感                              | §3.2 CDP 强制伪类；§6.3 反向自检；AC2 变异测试                                    |
| 假阳性过多                                  | 开发者习惯性把条目塞白名单，守卫退化成摆设                                  | §3.3 四类排除；每条白名单强制写理由；陈旧条目检测                                 |
| e2e 时长膨胀                                | PR 反馈变慢                                                                 | 单独 spec + 与现有 shard 矩阵并行；**测量必须逐实例，去重只能在测量之后**（见下） |
| 白名单永久挂账                              | 存量问题事实上被接受                                                        | plan.md 把「清空白名单」列为独立可验收任务；AC5 要求转硬失败                      |
| 选择器不稳导致白名单频繁失配                | 噪音                                                                        | key 用 className 首 token，不用 DOM 路径                                          |
| 只测了默认视口                              | 移动端 `@media` 下的容器（`.md-editor--fill`、`.workgroup-room__side`）漏测 | 至少覆盖 desktop + 一个 ≤720px 断点                                               |

### 6.2 ⚠️ 绝不可在测量前按「类名 + 容器」去重

本设计初稿曾把它写成提速手段，**那是错的，必须显式禁止**：

**裁剪取决于位置，不取决于类名。** 一个滚动列表里的 10 个 `.btn` 类名相同、裁剪容器相同，但只有**最后一个**贴着容器底边、只有它的下边环被切。测量前去重会「代表性地」测中间那个安全实例，然后把整组判为通过——**审计对一个真实被切的环保持全绿**。这与 §3.2 的空跑同属「看起来在工作、实际有洞」，且更隐蔽。

允许的提速方式：**先测量、后折叠输出**（同一 key 的多条违规在报告里合并计数，但每个实例都真的量过），以及跨路由复用 daemon、只对候选集做一次 `getBoundingClientRect` 批量读取（避免逐元素强制重排）。

### 6.2.1 实现期又抓到的两个静默假阴（已修，均已上锁）

T1 实现过程中，靠「不相信绿色、去验证一条具体断言」又挖出两个：

1. **「元素是否完全在滚动视口内」不能整体一刀切。** 初版为排除「滚到视口外」的元素，要求四边都在裁剪盒内才判定。但 `.tabs__tab` 有 `margin-bottom: -1px`（故意压在 `.tabs` 的下边框上），于是 `room.bottom == -1` → 整个裁剪容器被跳过 → **`.tabs` 上真实的 top/left 裁剪（ink 4 vs room 0）被完全隐藏**，审计把全站最常用的页签条报成干净。修正：**逐边判定**，某边 `room < 0` 只跳过该边。修完 `.tabs__tab` 立刻现形（0 → 15 条），且 `/agents/new`、`/skills/new` 两条此前「通过」的路由也暴露为假阴。
2. **Playwright 失败后会重启 worker 进程**，模块级累加状态因此在跑到一半时静默清零。初版把「已见 key」放在模块级 `Set`、再由最后一条 test 做陈旧条目检测——一旦中途有失败，该 Set 只剩重启后的残片，陈旧检测就会**把仍然有效的豁免误报为陈旧**（白名单清空后更会退化成「什么都没验证」）。修正：**整个 sweep 与两条断言收进单一 test**，状态不可能丢；per-route 粒度改在失败信息里按路由分组呈现。

同期还修掉一条**假阳**：伪元素环判定原本把 `box-shadow` 也算作环，于是把 `.form-switch > input::before`（开关的白色圆点，纯装饰投影）误报。改为**伪元素只认 `outline`**——本仓所有真实的伪元素焦点环都用 outline。

### 6.2.2 收口自查抓到的第三个假阴：UA `outline-style: auto` 被低报

`getComputedStyle` 对 Chrome 的默认焦点环**报小了**：报 `auto / width 1px /
offset 0`（即 ink=1），实际**画到盒外约 2px**。用同一个聚焦按钮放进 padding
0..4 的裁剪容器里放大截图实测：padding 0 与 1 **肉眼可见被切**，2 才干净。

后果：一个只有 1px 余量的容器会被判为「放得下」，而环实际被切——正是本 RFC
要消灭的那类静默假阴。修法：`outline-style: auto` 时把 ink 取
`max(reported, 2)`。已加自检 test 锁死（1px 余量的 UA 环按钮**必须**被报出）。

这条重要性在于：**所有没有 app 焦点样式的控件都走 UA 环**（本仓确实存在，如
`.repo-source-tabs__tab`），它们恰恰是最容易被忽略的一类。

### 6.3 反向自检（防空跑）

spec 内置一条自检 test：往页面注入一个**必然被切**的探针（一个 `overflow: hidden` 容器 + 一个贴边的、带外扩环的按钮），断言审计**能报出它**。这条与 AC2 的变异测试互补——变异测试证明「改坏产品代码会红」，反向自检证明「审计引擎本身没瞎」，且它不需要人工改代码，每次 CI 都跑。

## 7. 测试策略

必写用例（对应 CLAUDE.md「测试随每次改动落地」）：

**几何层**

1. 反向自检探针能被检出（§6.3）+ §3.2.1 四场景探针固化为首条 test。
2. 排除逻辑正确：滚动出视口的元素不误报；`[hidden]` 面板不误报；`position: fixed` popover 不误报。
3. 白名单陈旧条目检测能红。
4. 每条路由一条 test（失败信息含元素/容器/边/差值/实例序号）。
5. **候选集含 `<summary>`**（§3.1.1）——造一个被切的 `<details>` 折叠头，断言能检出。
6. **逐实例测量**（§6.2）——造一个列表：中间实例安全、末位实例贴边被切，断言审计**报出末位**。这条直接锁死「测量前去重」这个错误优化。

**静态层**（以下 7 条今日已全部实现并**逐条变异验证确实会红**）7. 全表扫描能找到预期数量的焦点规则（防解析器静默匹配为空的空跑）。8. 变异：`.form-input:focus` offset 改回 `0` ⇒ 红；`.select__trigger` box-shadow 去 `inset` ⇒ 红。9. 变异：把 `outline-offset: 0` 追加到**后一条** `.form-input:focus`（级联赢家）⇒ 红。锁住「读首个声明而非级联最终值」这个假阴。10. 变异：`outline-offset: -1px` 配 `2px` outline（仍外露 1px）⇒ 红。锁住「只要是负数就放行」这个假阴。11. 变异：`box-shadow: 0 0 4px accent`（**只有 blur、无 spread、仅 3 个长度**）⇒ 红。锁住「按长度个数判定是不是环」这个假阴。12. 注释剥离 + 同选择器合并两处健壮性各一条回归。13. 层拆分需 **paren 深度感知**——`color-mix(in srgb, …, …)` 内部的逗号不得被当作层分隔符（朴素 `/,(?![^(]*\))/` 会拆错，实测已踩）。

**修复批次** 8. 每批修复补一条源码锁（容器带 `--focus-ring-gutter`），并在几何层白名单里删掉对应条目——**白名单减少本身就是该批次的验收信号**。

## 8. 与现有模块的耦合点

- `playwright.config.ts` —— 新 spec 自动被 `testMatch` 收录；`workers: 4` 跨文件并行；CI shard 矩阵自动分摊。**不改配置**。
- `e2e/harness.ts` —— 复用 `startDaemon()`；每 spec 独立 daemon + 临时 home，不与其它 spec 共享状态。
- `e2e/a11y.spec.ts` —— 同构（路由遍历 + 白名单 + 陈旧检测）。两者都做路由遍历但**不合并**：axe 是结构性检查、本 spec 是几何检查，合并会让任一方的失败信息被另一方淹没，且 axe 每页跑一次已是 spec 内串行的瓶颈。
- `packages/frontend/src/styles.css` —— 新增 `--focus-ring-gutter`；容器补丁统一改用它。
- **不涉及**后端、shared、DB、migration。纯前端 + e2e。

## 9. 变更记录

- 2026-07-20 v1 —— 初稿。方向与守卫强度由用户拍板（先守卫 → 基线白名单 → 逐条修 → 硬失败；静态 + Playwright 双层）。`.form-input` 族 inset 化已先行落地（见 plan.md T0），作为本 RFC 的既成前提。
- 2026-07-20 v2 —— **Codex 设计门 2×P1 + 4×P2 全部折入**，主题一致：初稿的守卫存在多条**确定性假阴**路径，会让 RFC 的核心承诺（未来的裁剪必被自动发现）落空。
  - P1 白名单 key 只用类名 ⇒ 一条豁免会顺带放行后来新增的同类违规（§3.5，key 加实例序号）。
  - P1 「测量前按类名+容器去重」⇒ 列表末位贴边实例被安全实例代表、真违规全绿（§6.2，**已改为显式禁止**——该错误优化是初稿自己写进去的）。
  - P2 候选集漏 `<summary>`（本仓 29 处，且公共原语 `FormSection` 就是它）⇒ 整类折叠头不可见（§3.1.1）。
  - P2 静态层读**首个**声明而非级联赢家 ⇒ 往后一条 `.form-input:focus` 追加 `outline-offset: 0` 可绕过。
  - P2 「负 offset 即放行」⇒ `-1px` 配 `2px` outline 仍外露 1px。
  - P2 「≥4 个长度才算环」⇒ `0 0 4px` 这类 blur-only 外扩光晕漏判。
    后三条是**已写代码**中的真 bug，已修并各补一条变异测试（§7.9–7.11）；修复过程中另暴露一个自身解析 bug：层拆分未做 paren 深度感知，把 `color-mix(…)` 拆坏（§7.13）。
