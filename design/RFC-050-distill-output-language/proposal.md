# RFC-050 — Distiller 输出语言可配置（产品视角）

## 背景

`aw-memory-distiller` 当前把候选记忆的 `title` / `bodyMd` **硬编码用英文输出**
（`packages/backend/src/services/memoryDistiller.ts:66-69` 注释 + L112 prompt 正文
`written in plain English (regardless of source language)`）。

最初锁英文的理由：

> 记忆体最终会被注入到下游 agent 的 system prompt；若 prompt 主体英文
> 而注入块中文，会出现「中文记忆注入到英文 agent prompt」的语言错配，
> 影响下游 agent 的稳定性。

实际部署中发现这条假设并不总成立：

- 国内场景里 admin 通过 Memory 审批队列**阅读**候选记忆，英文正文增加
  审阅成本、降低批准准确率（admin 倾向于"看不懂就先放着"）。
- 大量被审阅的 source event（clarify Q&A / review 评论 / task feedback）
  本身就是中文；让 distiller 在中文上下文中产出英文摘要，需要它先翻译
  再泛化，**反而降低**了候选记忆的措辞精度。
- 下游 agent 的系统 prompt 语言并非全英文——平台允许用户在 agent.md
  里写中文 system prompt，"全英文记忆 + 中文 prompt"同样是错配的另一种
  形态。

## 目标

- admin 可在 Settings 里**独立**控制 distiller 输出语言，缺省维持英文以
  保证存量行为字节级不变。
- 切换后立刻对**后续新提炼**的候选记忆生效（不回填存量、不重写已落库的
  candidate / approved 记忆）。
- 候选记忆的 `title` `[category:xxx]` 前缀**语言不变**（永远小写英文
  kebab，由 `memory-distiller.test.ts` grep 守卫锁定），只有前缀之后的
  人类可读部分以及 `bodyMd` 跟随设置语言。
- 设置项与前台 UI 语言（`config.language`）**解耦**——admin 可能自己
  用英文界面工作，但希望团队的记忆库以中文沉淀（或反之）。

## 非目标

- **不**自动检测 source event 语言、不按比例混合输出。一个批次内所有
  候选要么全中文要么全英文，由设置决定。
- **不**回填 / 翻译已批准 / 已驳回 / 已归档的存量记忆。RFC-045 仍是手工
  改记忆的唯一入口。
- **不**修改 distiller system prompt 的指令部分（categories / 拒绝规则 /
  envelope 形态保持英文）——只调整"最终输出文本语言"那一个变量。指令
  保持英文的好处：所有 prompt 工程改动仍走源码 review（CLAUDE.md L62），
  diff 可读、grep 可查；语言切换只影响一段简短的"输出语言指示语"。
- **不**新增"per-scope 语言"或"per-source-event 语言"维度。如果未来需要
  混合策略再起新 RFC。

## 用户故事

- **US-1**：admin 在 Settings → Memory 区块看到新选项 `Distill output
  language`，下拉 `Auto (English, default)` / `Chinese (zh-CN)` /
  `English (en-US)`。切到中文并保存后，下一批 distill job 跑出的候选
  记忆 `bodyMd` 全部是中文，`title` 的 `[category:xxx]` 前缀仍是
  `[category:invariant]` 这类小写英文，前缀之后的标题人类可读部分变成
  中文。
- **US-2**：admin 在审批队列里看到既有英文存量候选 + 新中文候选并存。
  鼠标悬停 / 行内提示可知该候选生成时的语言设置（落到 distill job 行
  上）——便于排查"为什么这条还是英文"。
- **US-3**：admin 切回英文设置后，下一批 distill job 又回到英文输出，
  与 RFC-041 原始行为字节级一致；存量中文候选不被翻译回去。
- **US-4**：开发者读 `memoryDistiller.ts` 时，看到 prompt 指令体仍是
  英文 + 一段明确的"输出语言指示语"占位（由设置渲染填充），改 prompt
  时不需要维护两套全文。

## 验收标准

- Settings PATCH 接受新字段 `memoryDistillLang: 'zh-CN' | 'en-US' |
  undefined`（缺省 = `'en-US'` 字节级保持现有行为）；非法值返回 422。
- `runDistill` 把当前 `memoryDistillLang` 透传到 prompt 装配器；user
  prompt 末尾追加一段简短的"以 X 语言输出"指示语（中文 / 英文两套
  固定字符串）；system prompt 主体**字节级不变**。
- `memory_distill_jobs` 行落库时记录本次使用的语言（新 nullable 列
  `output_lang`），supersede 路径 / retry 路径继承同一行的设置。
- distill 详情页（RFC-043）的 `user_prompt_md` 列天然展示"输出语言
  指示语"那一行；新增一行 "Output language: zh-CN" 在 header 区显示
  本次 job 的语言设置（pure read of 新列）。
- 审批队列 / All 列表 / scope 详情：候选行不强制翻译展示，但在 tag /
  meta 区域附加 lang chip（`zh-CN` / `en-US`），便于 admin 一眼分辨。
- 关闭开关后行为字节级回到 RFC-041 baseline：grep 守卫锁
  `memoryDistiller.ts` 的英文 prompt 主体 + 默认设置下 user prompt
  尾部的指示语必须是英文版本。
- 测试覆盖：见 design.md §测试策略。

## 与既有 RFC 的关系

- **RFC-041**（平台长期记忆）— 本 RFC 修订其"distiller 输出始终英文"
  的隐式契约；显式标注 RFC-041 §G 的语言段被本 RFC 取代。
- **RFC-043**（distill job 详情页）— 复用其 `user_prompt_md` 展示链路，
  新增一行 `output_lang` 元数据展示。
- **RFC-044**（distiller source context）— 正交；本 RFC 不动 loader，
  只动 prompt 末尾指示语。
- **RFC-045**（手工创建 / 编辑记忆）— 互补：本 RFC 控制"新产出语言"，
  RFC-045 是"存量补救"的唯一通道；不引入自动翻译。
- **RFC-025**（Settings 语言切换）— 复用 `LanguageSchema` 枚举，但
  字段独立（`memoryDistillLang` 与 `language` 解耦）。
