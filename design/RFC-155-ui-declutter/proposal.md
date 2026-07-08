# RFC-155 · 界面降噪：Agent 配置页分节收纳 + 全站页头解释小字移除

- 状态：Draft
- 发起：用户 2026-07-08「简化 agent 配置页面，现在内容全部平铺在一起太杂了」+ 同日追加「去除每个页面里标题下的那行解释性系统原理小字」
- 三问拍板（AskUserQuestion 2026-07-08）：
  1. 布局方向 = **分节 + 高级折叠**（否决页签 TabBar / 两栏 DetailLayout）；
  2. 折叠收纳 = permission / frontmatterExtra / role+outputWrapperPortNames / syncOutputsOnIterate **以及** skills / mcp / plugins / dependsOn 四个引用 picker 一并收起，**但依赖关系图默认呈现**；
  3. 顺手精简 = 删除 raw 正文折叠区（选中）；「依赖树默认收起」未选（与"图默认呈现"一致）。

## 背景

### A. Agent 配置页（/agents/new、/agents/$name 共用 `AgentForm`）

`AgentForm` 目前把 16+ 个配置项全部平铺在同一个 `form-grid` 里：名称、描述、输出端口、
技能、MCP、插件、依赖 + 自动检测按钮 + 依赖树预览、迭代同步开关、角色（normal/aggregator）、
汇总端口重命名 JSON、运行时、permission JSON、额外 frontmatter JSON、Markdown 正文
（双栏编辑器）、raw 正文折叠区。日常使用最高频的只有名称 / 描述 / 正文 / 输出端口，
其余低频字段与之等权平铺，认知负担大；且底部「裸 markdown（无预览）」折叠区与
MarkdownEditor 左栏（本身就是纯文本 textarea）完全重复，是纯冗余。

### B. 全站页头解释小字

各页面 `page__header` 的 `<h1>` 下普遍带一行 `.page__hint` 静态说明，内容是系统原理科普
（如 agents 页 "Virtual agents; injected per-run via OPENCODE_CONFIG_CONTENT."、settings 页
解释 config.json 落盘路径与 `PUT /api/config`、skills 页解释 managed/external 的目录机制）。
对新用户一次有用，对日常使用是每页都在的视觉噪音；用户明确要求整体去除。

## 目标

- G1：`AgentForm` 按信息架构分层——4 个默认可见分节（基本信息 / 提示词 / 输出 / 依赖关系图）
  + 2 个默认折叠分节（资源与依赖引用 / 高级设置）；编辑已有非空值时对应折叠节自动展开，
  外部注入（YAML 导入、依赖自动检测 apply）使折叠节内容从无到有时同样自动展开。
- G2：删除 `AgentForm` 底部 raw 正文折叠区及其 i18n key。
- G3：移除全部页面**页头静态解释小字**（21 处，见 design.md §删除清单）及对应 i18n key；
  动态状态行 / 数据行（如工作流编辑器的 id·版本·保存状态行、skill 详情的来源 chip + 路径行）
  不属于"解释性系统原理小字"，全部保留。
- G4：分节能力以公共组件 `<FormSection>` 落地（CLAUDE.md 前台统一风格条款），供后续
  skill / memory 等表单页复用。

## 非目标

- 不做页签（`<TabBar>` 公共原语留给 flag-audit RFC-G8，本 RFC 不提前）。
- 不动画布内节点级 agent 编辑（`canvas/inspector/AgentSingleEdit.tsx`）——那是另一个信息
  密度语境。
- 不改任何字段语义、校验规则、API payload、保存流程；`showRuntime` / role 条件字段等
  显隐逻辑原样保留，只挪位置。
- 不动 `/auth` 登录页副标题（独立 landing 页品牌文案，非应用内页头模式）。
- 不动面板 / 对话框内部的功能性 hint（AclPanel、TaskMembersPanel、Onboarding、
  ReviewDecisionInfo 等）与 `<Field hint>` 字段级提示。
- 不清理 `.page__hint` CSS class 本身（保留清单仍在用）。
- 不扩 agent-md 导入协议（`skills:` 仍不在识别键内，落 frontmatterExtra 是既存行为；
  如需一等支持另立 RFC）。

## 用户故事

1. 我新建一个 agent，页面只要求我关注名称、描述、正文提示词、输出端口，一屏内完成主干
   配置；需要挂技能 / MCP / 插件或调 permission 时再展开对应折叠节。
2. 我打开一个已配置了 skills 和 permission 的 agent，「资源与依赖引用」「高级设置」两节
   自动处于展开态，我不会漏看任何已有配置。
3. 我在新建页用「导入」把一份带 `dependsOn` / `mcp` / `plugins` 的 agent YAML 灌进表单，
   资源节自动弹开，导入结果立即可见。（注：`skills:` 不在 agent-md 导入协议的识别键里，
   会按未知键落 frontmatterExtra——既存行为，见 design.md §2.2。）
4. 我编辑一个已保存的 aggregator agent，角色与汇总端口重命名如实回显且高级节自动展开
   （当前 `agentToDraft` 漏拷这两个字段、表单谎报 normal——本 RFC 随行修复）。
5. 我浏览 /agents、/tasks、/settings、/memory 等任何页面，标题下不再有一行讲系统机制的
   小字。

## 验收标准

- [ ] `AgentForm` 分节顺序：基本信息（name/description/runtime）→ 提示词（bodyMd）→
      输出（outputs/outputKinds）→ 依赖关系图（DependencyTreePreview，默认可见）→
      ▸ 资源与依赖引用（skills/mcp/plugins/dependsOn/自动检测，默认折叠）→
      ▸ 高级设置（syncOutputsOnIterate/role/outputWrapperPortNames/permission/
      frontmatterExtra，默认折叠）。
- [ ] 空表单（新建页）两折叠节默认收起；折叠节内任一字段有非默认值时该节初始展开；
      值从无到有的上升沿自动展开（手动收起后不被同值渲染反复弹开）。
- [ ] `agentToDraft` 补拷 `role` + `outputWrapperPortNames`（随行修真 bug）：编辑已保存的
      aggregator agent 时两字段如实回显、高级节初始展开；回归测试锁定。
- [ ] raw 正文折叠区消失，`agentForm.rawBodySummary` key 从两个 bundle + 类型声明删除。
- [ ] design.md §删除清单所列 22 处页头小字全部移除（含 memory 页 `muted` 形态、settings
      的 hintRestart），对应 i18n key（两 bundle + 类型声明）删除，无残留引用；§保留清单
      所列动态行原样保留（`reviews-detail-title-description` 源码锁继续绿）。
- [ ] 新公共组件 `<FormSection>`（含折叠 / 非折叠两形态、a11y、i18n 无关）+ 单测；样式与
      `.page__section > h2` 视觉对齐；`a11y.spec.ts` 新增 `/agents/new` axe case。
- [ ] `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿；
      前端 vitest 全绿；visual-regression 基线按其 README 流程处理（默认 opt-in 门；
      不为表单页新增基线——显式决策见 design.md §5）。
- [ ] 视觉对齐自查：agent 编辑页与 /skills、/settings 等核心页 side-by-side 截图对比
      （light + dark）。
