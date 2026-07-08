# RFC-156 — 「系统 Agent」设置页签(内置 framework agent 运行时 + 运行配置统一收纳)

状态:Draft

## 背景

平台内部驱动着一组**内置 framework agent**(RFC-117 称「内部 framework agent」),它们不是用户业务 agent,而是平台自身完成某类系统职责时临时拉起的 opencode / claude 进程。后端已用**同一个** `resolveInternalAgentRuntime()`(`services/runtimeRegistry.ts:272`)统一解析它们各自选定的 runtime profile(留空则继承全局 `defaultRuntime`)。

当前共有 4 个:

| 内置 agent | 运行时字段(config) | 专属运行配置 | 现配置入口 |
|---|---|---|---|
| **提交推送** commit-push(RFC-075) | `commitPushRuntime` | `commitPushMaxRepairRetries`、`commitPushDiffMaxBytes` | 「限额」页签 |
| **记忆提取** distiller(RFC-041) | `memoryDistillRuntime` | `memoryDistillLang`(输出语言) | 「记忆」页签 |
| **合并冲突解决** merge(RFC-130) | `mergeAgentRuntime` | —(仅运行时) | ⚠️ **完全没有 UI,只能改配置文件** |
| **技能融合** aw-skill-merger(RFC-101) | 它是真实 agent 行,runtime 走 `/agents` 编辑(RFC-117 D7) | 走 `/agents` | `/agents` 页面 |

### 问题

1. **同构配置散落两处**:提交推送块在「限额」、记忆块在「记忆」——两者本质是同一模式(选一个 runtime profile + 若干本 agent 专属参数),却分踞两个语义无关的页签。用户在配置心智上要跨页签找同一类东西。
2. **限额/记忆两页签被稀释**:「限额」页里 commit-push 三项与真正的执行限额(并发、超时、token 上限、日志级别)混在一起;「记忆」页则整页只有 distiller 的运行时 + 语言两项,却占了一个顶级页签。
3. **merge agent 无入口**:RFC-130 引入了合并冲突解决 agent,但它的运行时(`mergeAgentRuntime`)从未获得 UI——用户只能手改 config 文件才能给它选运行时。这是一个既有能力缺口。
4. **配置字段真实缺口**:`ConfigPatchSchema` 只为 `commitPushRuntime` / `memoryDistillRuntime` 扩展了 `.nullable()`(供 RuntimeSelect 的「继承」选项发 `null` 清除覆盖),**漏了 `mergeAgentRuntime`**——即使给 merge agent 加了 UI,「继承(全局默认)」选项也会被 schema 拒。

## 目标

1. 新增顶级设置页签 **「系统 Agent」**,把上述内置 framework agent 的**运行时 + 各自的运行配置**统一收纳到一处,每个 agent 一节(section)自成一个「运行时 + 全部运行配置」的完整卡片。
2. **补齐 merge agent 的运行时选择器**(此前无 UI),并修复 `ConfigPatchSchema` 让其「继承」选项能清除覆盖。
3. **技能融合 agent** 因是真实 agent 行(runtime 在 agent 行上、非 config 字段),在新页签放一张**内联运行时选择器**卡片,`onChange` 直接发 **runtime-only** `PATCH /api/agents/aw-skill-merger`(后端 RFC-117 `isRuntimeOnlyAgentPatch` 窄例外放行),从而与其它三卡形态统一——四卡都是「一个运行时选择器」。单一事实源仍是 agent 行(不新增 config 字段、不产生第二条写全字段的路径)。
   - **顺带兑现 RFC-117 D7 前端半截**:D7 只做了后端 runtime-only 窄例外,但前端唯一入口 `agents.detail.tsx` 保存发的是**整份 draft**(`{...rest, runtime}`,约 10 键),落到 builtin 行必 403 `builtin-readonly`——即经 `/agents` 详情页编辑内置 merger 的 runtime **当前根本保存不了**(D7 注释预告的「settings picker」此前不存在)。本 RFC 的融合卡就是那个 picker,以 runtime-only PATCH 真正打通该能力,无需改详情页。
4. 迁移后:
   - 「限额」页签只保留真正的执行限额(并发/超时/token/大输出阈值/日志级别),不再混 commit-push。
   - 「记忆」页签**整体移除**(其仅有的 distiller 运行时 + 输出语言两项随卡片搬入新页签;当前无其它记忆 UI 项)。
5. 全程复用现有公共原语(`RuntimeSelect` / `Field` / `NumberInput` / `Select` / `.form-section` / `SectionForm` / `TabBar`),不新造 chrome / 不落原生元素。

## 非目标

- **不改后端 agent 派发/解析逻辑**:`resolveInternalAgentRuntime` 及三处 scheduler 派发、distiller/commit/merge 的 spawn 全不动。本 RFC 只搬前端 + 补 `ConfigPatchSchema` 空值扩展。
- **不给融合 agent 新增 config 字段**:它的运行时仍写在 builtin agent 行上(RFC-117 D7 决策不变);融合卡是那唯一入口的 runtime-only 写路径,不新增全字段写路径、不改 `agents.detail.tsx`。
- **不物理删除已废弃 model 字段**(`memoryDistillModel` / `commitPushModel` / `mergeAgentModel`):本 RFC 只在运行时选择器交互时把它们置 null(D6,让「继承」诚实),schema 层的字段声明与删除留独立清理 RFC。
- **不动全局 `defaultRuntime`**:它继续留在「运行时」页签(RuntimeList),是这些内置 agent 留空时的继承来源,概念上属于运行时注册表而非「谁用哪个运行时」。
- **不引入新的内置 agent**,不改各 agent 的 prompt / 输出协议。
- **不清理已废弃的 model 字段**(`memoryDistillModel` / `commitPushModel` / `mergeAgentModel`):它们已是 RFC-117 的过渡回退、UI 早已不展示,物理删除是独立后续清理。

## 用户故事

- **US-1(集中配置)**:作为平台管理员,我想在一个地方一次看清并配置所有「平台自己会拉起的 agent」分别用什么运行时——打开「系统 Agent」页签即可,提交推送 / 记忆提取 / 合并冲突解决三张卡片一目了然,不必在「限额」「记忆」两个语义无关的页签间来回找。
- **US-2(给 merge agent 选运行时)**:此前我只能改配置文件才能让合并冲突解决用便宜的 opencode 模型;现在「系统 Agent」页签里合并冲突解决卡片有一个运行时选择器,留空即继承全局默认。
- **US-3(融合选引擎)**:我在「系统 Agent」页签看到技能融合卡片,点「在 /agents 编辑」跳到 `aw-skill-merger` 详情页选运行时——与 RFC-117 D7 既定入口一致,不产生第二套控件。
- **US-4(限额页更纯)**:我打开「限额」只看到执行限额本身(并发/超时/token/日志),不再被 commit-push 的三项干扰。

## 验收标准

1. 设置页出现新顶级页签「系统 Agent」;「记忆」页签消失;「限额」页签不再含 commit-push 任何字段,只剩执行限额项。
2. 「系统 Agent」页签含 4 节:
   - **提交推送**:runtime 选择器(`commitPushRuntime`)+ `commitPushMaxRepairRetries` + `commitPushDiffMaxBytes`。
   - **记忆提取**:runtime 选择器(`memoryDistillRuntime`)+ 输出语言(`memoryDistillLang`,含 Default / English / 简体中文 三选项,testid 不变)。
   - **合并冲突解决**:runtime 选择器(`mergeAgentRuntime`),支持「继承(全局默认)」清除覆盖。
   - **技能融合**:内联 runtime 选择器;当前值由 `GET /api/agents/aw-skill-merger` 载入,与其余三卡**共用同一个 Save 按钮**统一保存——点保存时若 fusion runtime 确有变更才发 runtime-only `PUT /api/agents/aw-skill-merger`(选「继承」发 `{runtime:null}` 清 pin),未改则不发冗余 PATCH。

> **界面收尾(用户 2026-07-08 实现期反馈,三条)**:①原设计融合卡「即时保存」→ 改为四卡**单一 Save** 统一保存(消除「保存按钮下方还挂一张卡」的割裂与「Save 到底存哪些」的歧义);②每个内置 agent 用共享 `<Card>` 原语(RFC-124)包成**独立带边框卡片**,四块清晰区隔、不再糊成一片;③Save 按钮恒在四卡下方收尾。
3. 三个 config 型 runtime 选择器的「继承(全局默认)」选项都能发 `null` 清除覆盖并被 `ConfigPatchSchema` 接受(含新修的 `mergeAgentRuntime`);选定 profile 时发对应 runtime 名。任一 config 型选择器交互时同时把配对的 legacy `*Model` 置 null(D6),使「继承」在残留 legacy model 的旧配置上也真正回退到全局默认。
4. 所有控件复用现有公共原语,视觉与其它设置页签一致;新页签同样有统一 Save 按钮 + saved 反馈(沿用 `SectionForm`)。
5. i18n 两语种(zh-CN / en-US)新增页签标题 + 各节标题/说明 + merge 运行时 label + 融合卡片文案,键在两侧对齐。
6. 门禁全绿(`typecheck && lint && test && format:check` + `build:binary` smoke + Playwright e2e);既有 `settings-commit-push` / `settings-memory-distill-lang` / i18n 锁按迁移更新且跑绿;新增「系统 Agent」页签回归锁 + `mergeAgentRuntime` 空值扩展回归锁。
7. Codex 设计门 / 实现门 findings 全 fold。

## 决策(D1–D5)

| # | 决策点 | 选择 | 理由 |
|---|---|---|---|
| **D1** | 覆盖范围 | **四个全含**(commit / distiller / merge / fusion) | 用户拍板;merge 正好补 UI 缺口,fusion 以跳转形态纳入。 |
| **D2** | 搬迁粒度 | **每个 agent 一节,自带运行时 + 全部运行配置** | 贴合用户描述「运行时和对应的运行配置」;记忆输出语言归入 distiller 卡。 |
| **D3** | 记忆页签处置 | **整体移除**(distiller 运行时 + 语言搬入新页签;当前无其它记忆 UI) | 移除后无 UI 项丢失;未来记忆 JSON-only 项若需 UI 再议归属。 |
| **D4** | 融合 agent 形态 | **卡内内联 runtime 选择器**,与 config 三卡**共用单一 Save**,变更时才发 runtime-only `PUT /api/agents/aw-skill-merger` | 用户拍板(改:原「跳转」目标因 D7 前端半截未接线而 403);四卡形态统一;写路径仍是 agent 行、runtime-only,不引入全字段第二写路径。实现期又据用户反馈从「即时保存」并入单一 Save(见上方界面收尾)。 |
| **D5** | 页签命名 | **系统 Agent** | 用户拍板;强调这些是平台自身驱动、非用户业务的 agent。 |
| **D6** | 「继承」与 legacy model | runtime 选择器交互时**一并把配对 `*Model` 置 null**(commit/distill/merge 三者) | Codex 设计门 P2:`resolveInternalAgentRuntime` 顺序 runtimeName→deprecatedModel→defaultRuntime,只删 runtime 会落到残留 legacy model 而非全局默认;RFC-117 D2 早判 model 归 profile,legacy model 永不该再被查——顺带修 commit/distiller 既有同款 quirk + 渐进清理旧配置。 |
