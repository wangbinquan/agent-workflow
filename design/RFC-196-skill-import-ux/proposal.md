# RFC-196 — Skill ZIP 导入体验重构

> **状态**：Done（2026-07-15，用户批准「ok」后实施）
>
> **触发**：2026-07-15 用户「新建 skill 的导入 skill 界面太丑了，优化下 UX 设计」。
>
> **范围**：以 frontend 为主的交互与视觉重构；保留既有 ZIP parse / commit 协议、冲突权限与 managed-only 模型；无 DB migration。

## 1. 背景与现场证据

当前入口位于 `/skills/new` 的「上传 ZIP」页签，核心仍是 RFC-019 初版的工程型表单：

1. 空态只有浏览器原生文件选择器、一个「解析」按钮和一行 ZIP 结构说明。控件散落在大片空白中，
   没有标题、阶段、拖放区域、文件摘要或下一步预期。
2. 页头在 ZIP 模式仍写「新建技能」，行动却是批量导入；用户无法第一眼判断自己是在手工创建还是
   导入现有 Skill。
3. 选中文件后只显示浏览器原生文件名，不显示大小、是否符合 `.zip`、如何更换；结构要求放在操作
   之后，错误发生前很难被注意。
4. 解析结果使用「技能 / 描述 / 文件数 / 冲突 / 动作」五列表格。右侧 split detail 本就有限，描述、
   冲突说明、Select 与 rename 输入互相抢宽；每个候选的主信息和决策关系也被拆散。
5. rename 仍是私有原生 `<input>`，parse error / archive error / commit error / summary 各自维护一套
   `.zip-import__*` 盒子，没有复用 `Field`、`TextInput`、`ErrorBanner`、`StatusChip`、`Card`、
   `EmptyState`、`LoadingState` 等现有原语。
6. 全成功后页面立即导航到 `/skills`，用户看不到“新建 / 覆盖 / 跳过”结果，也没有「打开已导入
   Skill / 继续导入」的明确下一步；只有部分失败才留在原页看到摘要。
7. 当前 dev 实测：1280×800 下 ZIP 空态只占右栏左上角一小块；390×844 下固定全局 sidebar 后
   `main` 只剩 170px、ZIP panel 只剩 138px，原生文件名已被截断。五列表格在这一宽度没有可用的
   信息层级。当前页面无整页横向 overflow，但“塞进窄栏”不等于可操作。

这不是单纯调圆角或颜色：需要重排任务阶段、候选决策与完成反馈，因此按仓库规则独立立 RFC。

## 2. 目标

1. 把导入过程表达成清晰的 **选择 ZIP → 检查内容并处理冲突 → 查看结果** 三阶段任务。
2. 空态先解释支持什么、包结构是什么，再给唯一主行动；选包后立即提供文件名、大小和更换入口。
3. 让每个候选的名称、描述、文件体量、冲突、警告与导入决策聚合在同一视觉单元内。
4. 保持“冲突默认跳过、只有 owner/admin 可覆盖、任何冲突均可合法改名”的现有安全语义。
5. 成功、部分成功、失败都有稳定结果页；用户能打开成功项、返回列表或开始下一次导入。
6. 复用公共 UI 原语并补齐拖放、键盘、读屏、错误关联与 responsive 行为。
7. 不改 ZIP 结构、后端写入语义、ACL、并发/OCC、版本与存储模型。

## 3. 非目标

- 不增加 GitHub / URL / 粘贴文本 / 单个 `SKILL.md` 等新导入来源。
- 不改 RFC-019 的合法 ZIP 结构；顶层直接文件、缺 `SKILL.md`、非法路径和安全限额仍按现有规则处理。
- 不把 parse 与 commit 合成一个端点，不在后端暂存 ZIP；同一文件仍分别随 parse / commit 请求上传。
- 不增加批量「全部覆盖 / 全部改名」动作，不降低逐候选确认粒度。
- 不修改同名占用、owner 权限、reserve / version-write / boot verify 等 RFC-102/170 语义。
- 不重做手工创建 managed Skill 表单、Skill 详情页或左侧资源卡列表。
- 不重做全局移动导航信息架构；仅在 `/skills/new` 的 `<=720px` 专注任务场景隐藏桌面 sidebar 与
  Skills 列表 rail，并提供页内「返回技能列表」链接。其他路由的 shell 行为不变。
- 不把 ZIP 暂存纳入父草稿 dirty guard；沿 RFC-169 现状保持 keep-mounted、跨页签不丢，离开路由
  仍是 best-effort 本地状态。

## 4. 产品决策

### D1 — 创建模式不变，ZIP 模式改成真正的「导入技能」

- 顶层仍保留「托管 / ZIP 导入」两个 `TabBar` 选项，不把两种完全不同的任务塞进同一表单。
- active tab 为 managed 时页头是「新建技能」，主按钮仍在 header。
- active tab 为 ZIP 时页头改为「导入技能」，增加一句短说明：一次导入一个或多个托管 Skill，
  写入前会先检查结构和同名冲突；header 不出现无关的“创建技能”按钮。
- 页签文案由「上传 ZIP」改为「ZIP 导入」，强调目标而不是传输动作。

### D2 — 三阶段状态机，不把所有状态叠在一个长页面

`ImportZipPanel` 只渲染当前阶段：

1. **select**：选择 / 拖放 ZIP；展示结构示例与限制说明；parse error 留在本阶段，可更换或重试。
2. **review**：展示 archive 级错误、候选摘要、逐项决策与固定行动区；可返回更换 ZIP。
3. **result**：展示 created / updated / skipped / failed 四类结果；不再因 `failed.length===0` 自动跳走。

选中另一文件会原子清掉旧 parse、decision、commit error 与 result，绝不让旧决策套到新包。parse / commit
在途时文件更换、返回、重复提交均禁用。

### D3 — 新增可复用 `FileDropzone` 公共原语

仓库已有 task launch 私有 `UploadPicker`，但没有面向通用表单的单文件 dropzone。本 RFC 新建
`components/FileDropzone.tsx`：

- 隐藏原生 input，以真实 button 触发文件选择；支持拖放、`accept`、disabled、选中文件摘要、清除 / 更换；
- 根区只负责 drop，不把整个容器伪装成按钮，不制造嵌套交互元素；
- drag active、focus-visible、invalid 使用公共 token；状态不只靠颜色；
- API 与文案均为通用 props，不写死 Skill / ZIP，可供后续上传面复用；
- `UploadPicker` 本轮不迁移，避免顺带改变任务启动页视觉与多文件语义。

Skill 调用方只接收扩展名为 `.zip` 的单文件，选中后显示文件名与格式化大小。64 MiB 总包上限通过
shared 常量与 backend 单一事实源对齐；超限在发请求前给就地错误，后端现有校验继续兜底。

### D4 — 五列表格改为响应式候选卡片列表

每个候选复用公共 `Card`，信息顺序固定：

1. header：Skill 名 + `StatusChip`（可导入 / 同名冲突 / 无权限覆盖）；
2. body：描述（空值明确）、文件数 + 总大小、解析 warning；
3. decision：带候选上下文 accessible name 的共享 `Select`；
4. rename 时：共享 `Field + TextInput`，错误与输入通过 `aria-describedby` 关联。

桌面每卡使用 `minmax(0,1fr) + 220px` 的“信息 / 决策”布局；窄栏自动单列，按钮与输入占满可用宽度。
长名称、描述、warning、错误码都可折行或 ellipsis + title，不制造内部横向滚动。

### D5 — 决策安全语义逐字保持，增强摘要而不增加隐式批量动作

- 无冲突默认 `import`，可选 `skip`。
- 有冲突默认 `skip`；`canOverwrite=true` 才出现 `overwrite`；无权限时只可 `skip / rename`。
- rename 继续校验空值、kebab-case、本批目标重名与 DB 占用；existing skills 列表未加载成功时，
  rename 进入“暂不能验证”状态且最终导入禁用，提供重试，不以空集合误判可用。
- review 顶部显示候选 / 冲突 / 无法解析数量；底部行动条实时显示将新建、覆盖、改名、跳过数量。
- `overwrite > 0` 时行动条用 warning 语义明确“将替换 N 个已有 Skill”；最终按钮仍是唯一提交确认，
  不再叠第二个 Dialog。

### D6 — 错误与空态统一，部分可用时不吞掉正确候选

- parse / commit HTTP 失败：共享 `ErrorBanner`，保留文件与决策，允许重试。
- parse response 的 `errors[]`：独立“未通过检查”列表，逐条显示 path / code / message；合法候选仍可继续。
- `rows.length===0`：共享 compact `EmptyState`，主行动是返回更换 ZIP，导入按钮不可达。
- parse / commit 在途：对应区域使用 `LoadingState` / 按钮 pending 文案，并以 `aria-live=polite` 宣告。
- 失败文案不再散落私有红框；颜色、图标、文本三者共同表达状态。

### D7 — 完成页是一次导入的可审计终点

commit 2xx 后始终进入 result：

- 顶部按结果选择 success / warning 状态：全成功、部分成功、全部未写入三种主文案；
- created / updated 项显示为可打开的 `/skills/$name` 链接；skipped / failed 显示原因，failed 保留 code；
- 行数为 0 的分类不渲染空 section，避免噪声；
- CTA 为「继续导入」与「返回技能列表」。继续导入清空文件并把焦点交回选择按钮；
- query cache 在进入 result 前完成 `['skills']` invalidation，左侧列表与成功链接保持一致。

### D8 — 响应式、键盘与读屏合同

- 1280×800：空态不再漂在左上角；review 卡片、摘要、行动条形成一个清楚的任务列。
- 390×844：路由级专注布局移除两个桌面 rail，内容根实测宽 358px；dropzone / 卡片 / Select / rename /
  CTA 全部单列，feature 与 document 均满足 `scrollWidth===clientWidth`，并保留显式返回路径。
- Tab 顺序为：选择/更换文件 → 检查 → 候选决策 → rename → 返回/导入 → 结果链接/CTA。
- drop 不是唯一入口；键盘用户通过真实 button 打开文件选择。
- 每个 action Select、rename 输入、结果链接的 accessible name 均含 Skill 名；错误用 role / describedby 关联。
- `prefers-reduced-motion` 下 drag / success 反馈无位移动画。

### D9 — wire 与存储不变

- 仍调用 `POST /api/skills/import-zip/parse` 与 `/commit`，multipart 字段仍为 `file` / `decisions`。
- `buildDecisionMap`、`availableActionsFor`、`validateRenameTarget` 与 commit response shape 不变；只扩展纯 UI
  view model / summary helper。
- backend 唯一允许的代码改动是复用 shared 的 ZIP limits 常量，数值与行为不变；无 route / DB / ACL 改动。

## 5. 目标形态

### 5.1 选择

```text
导入技能
一次导入一个或多个托管 Skill。写入前会检查结构和同名冲突。

[ 托管 ] [ ZIP 导入 ]

┌──────────────────────────────────────────────┐
│                  ZIP 图标                    │
│        拖放 ZIP 到这里，或选择文件           │
│   支持单个 .zip · 最大 64 MiB                │
│                 [选择 ZIP]                   │
└──────────────────────────────────────────────┘

正确结构
pack.zip / my-skill / SKILL.md
```

### 5.2 检查与决策

```text
pack.zip · 1.8 MiB                              [更换 ZIP]
4 个候选   1 个同名冲突   1 个未通过检查

┌ my-skill ─────────────────────────── 可导入 ┐
│ 生成发布说明 · 6 个文件 · 42 KiB            │
│                                      [导入 ▾]│
└──────────────────────────────────────────────┘

┌ code-review ─────────────────────── 同名冲突 ┐
│ 审查代码改动 · 3 个文件 · 18 KiB             │
│                             [跳过 / 覆盖 / 改名 ▾]
└──────────────────────────────────────────────┘

将新建 2 · 覆盖 1 · 跳过 1       [返回] [导入 3 个 Skill]
```

### 5.3 结果

```text
✓ 导入完成
新建 2 · 更新 1 · 跳过 1 · 失败 0

新建      my-skill →
更新      code-review →
跳过      docs-helper（用户选择跳过）

[继续导入]                              [返回技能列表]
```

## 6. 验收标准

- [x] ZIP tab 页头是「导入技能」并有任务说明；managed tab 与创建按钮行为不变。
- [x] select / review / result 三阶段互斥；换文件清理旧解析、决策、错误与结果。
- [x] 公共 `FileDropzone` 支持 button 选取、drag/drop、disabled、单文件摘要、清除/更换、错误与焦点。
- [x] `.zip` 与 shared 64 MiB 限额前端早反馈；backend 同值兜底，常量不漂移。
- [x] review 不再渲染五列 `<table>`；每个候选用 `Card + StatusChip + Select`，rename 用 `Field + TextInput`。
- [x] import / skip / overwrite / rename 默认与权限矩阵逐字保持；无权用户看不到 overwrite。
- [x] existing skills query 失败时 rename 不会基于空集合假绿，错误可重试。
- [x] archive errors 与合法 candidates 可同时展示；零候选用 EmptyState；HTTP error 保稿可重试。
- [x] commit 2xx 无论是否失败都进入 result，不再自动导航；成功项可打开，继续导入可彻底 reset。
- [x] 1280 light/dark 与 390×844 下无内部水平 overflow；长名称/描述/warning/error 不撑宽。
- [x] 完整键盘流、unique accessible names、aria-live、error describedby 与 focus return 有测试。
- [x] zh/en i18n 对称；既有 ZIP API、ACL、managed 存储与版本回归全绿。

## 7. 与既有 RFC 的关系

- **RFC-019**：保留 ZIP 格式、parse/commit 两阶段 API 与逐候选失败语义，只重做前端任务流。
- **RFC-102**：保留 `canOverwrite` 权限矩阵、默认 skip 与 rename 行为，不把前端置灰当安全边界。
- **RFC-169**：保留 split layout、两 mode keep-mounted 与 ZIP 暂存 best-effort；本 RFC 只重做右栏导入面。
- **RFC-170**：不触碰 ZIP 覆盖 OCC / reservation / version-write；那些存储一致性边界继续由 RFC-170 管理。
- **RFC-178**：skills 仍是 managed-only；导入结果不重新引入 external / source 概念。

## 8. 用户批准门

用户已于 2026-07-15 明确回复「ok」批准 RFC-196；实现、真实浏览器验证与门禁已按本设计完成。
