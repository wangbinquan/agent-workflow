# RFC-197 — Agent `agent.md` 导入体验重构：产品提案

> 状态：Done（2026-07-15，用户批准后已完成实现与本地验收）
> 关联：[技术设计](./design.md) · [实施计划](./plan.md) ·
> [RFC-018 agent.md 导入](../RFC-018-agent-md-import/proposal.md) ·
> [RFC-035 UX 一致性](../RFC-035-ux-consistency/proposal.md) ·
> [RFC-194 代理端口编辑器](../RFC-194-agent-port-editor-ux/proposal.md) ·
> [RFC-196 Skill 导入体验](../RFC-196-skill-import-ux/proposal.md) ·
> [RFC-198 全局 UX 一致性](../RFC-198-global-ui-ux-consistency/proposal.md)

## 1. 背景

RFC-018 已让 `/agents/new` 支持上传或粘贴 `agent.md`，RFC-035 又把弹窗外壳迁到了共享
`Dialog`。但弹窗内部仍是第一版工具型界面：上传态直接露出浏览器原生文件框，粘贴态是一块很高的原生
textarea，解析按钮、提示语和三列表格挤在同一视觉层级，用户很难快速回答三个关键问题：

1. 我现在导入的是哪个来源？
2. 哪些内容会进入表单的哪个分区？
3. 点击应用后是否已经创建 Agent？

2026-07-15 用真实页面验证了这不是单纯的审美问题：

- 在 390×844 视口，弹窗没有水平滚动，但「字段 / 值 / 去向」三列表格被压成窄列，长值与去向反复换行，
  属于“技术上不溢出、实际不可扫读”的假响应式；
- 上传态只有原生文件控件和大片空白，既没有拖放入口，也没有文件摘要、替换和读取失败反馈；
- 粘贴态的 14 行 textarea 占据首屏大半，`解析` 与“仍需创建”的关键提示被压在一行；
- 当前预览只列出 name、description、permission、端口、role、extra 与 body，却漏掉 parser 已经会应用的
  `runtime / dependsOn / mcp / plugins`。用户会在看不到这些字段的情况下覆盖草稿，属于 UX 正确性缺口；
- `Apply` 后弹窗立即消失，没有稳定结果状态；用户容易把“写入本地草稿”误解为“Agent 已创建”；
- 文件读取异常没有捕获，上传读取期间关闭 / 重开还可能让迟到结果污染下一次导入会话。

用户要求 Agent 导入按 RFC-196 的同样方式优化。因此本 RFC 复用其“选择来源 → 检查内容 → 稳定结果”的任务
结构和公共原语，但保留 Agent 导入的本质差异：Skill 的最后一步会提交后端，Agent 的最后一步只写入当前
`AgentForm` 草稿，仍需用户点击页面的「创建」。

## 2. 目标

### 2.1 做

- 把弹窗改成三个互斥阶段：
  1. **选择来源**：上传 `.md/.markdown` 或粘贴文本；
  2. **检查内容**：按 AgentForm 的 Basics / Prompt / Ports / Resources / Advanced 分组预览；
  3. **已填入草稿**：稳定说明写入了多少项、涉及哪些分区，以及“尚未创建”。
- 上传复用 RFC-196 新增的公共 `FileDropzone`，提供拖放、选择、替换、移除、文件名 / 大小摘要与错误反馈。
- 粘贴复用共享 `TextArea monospace`；上传与粘贴各自保存输入，切换来源不再互相串内容。
- 预览覆盖 parser 当前所有一等输出：
  - Basics：`name / description / runtime`；
  - Prompt：`bodyMd`；
  - Ports：`inputs / outputs / outputKinds / outputWrapperPortNames`；
  - Resources：`dependsOn / mcp / plugins`；
  - Advanced：`role / permission / frontmatterExtra`。
- 值预览从“统一截断 60 字符”改成类型化摘要：正文显示字节数、行数和摘录；数组 / map 显示数量和关键名称；
  extra key 逐项可见，长内容可折行且保留完整 `title` 或展开文本。
- 用共享 `Card / StatusChip / ErrorBanner / EmptyState` 表达识别项、非阻断 warning、覆盖影响、阻断错误和空结果；
  删除三列表格及私有 warning / overwrite chrome。
- 保持 RFC-194 的 orphan sidecar 阻断规则；提示提供“返回端口分区修复”的明确行动。
- 只有存在可应用项、且没有 blocking warning / orphan conflict 时，主按钮才可用；空解析结果不再允许无效应用。
- `填入草稿` 后不立即把结果吞掉：弹窗进入结果阶段；用户可返回表单完成创建，或重新导入。
- 完整处理文件读取失败和迟到异步结果；关闭 / 换来源 / 重开后旧读取不得覆盖新会话。
- 明确焦点合同：打开聚焦来源控件，进入 review / result 聚焦阶段标题，关闭恢复到导入按钮。
- 1280px light/dark 与 390×844 三阶段均可扫读、无水平溢出；footer 始终可达。

### 2.2 不做

- 不修改 `parseAgentMarkdown` 的字段解析、warning 文本协议、deprecated 字段规则或 YAML 依赖。
- 不修改 `mergeAgentImport` 的覆盖语义：有值字段覆盖、`frontmatterExtra` 浅合并、未出现字段保留。
- 不增加逐字段勾选、冲突决策矩阵或撤销栈；Agent 导入仍是一次显式覆盖草稿的动作。
- 不把入口扩到 `/agents/$name`；编辑现有 Agent 的破坏性导入仍不开放。
- 不做批量 Agent 导入、目录扫描、导出、远程 URL 导入。
- 不增加 backend route、DB / schema / ACL / migration，也不自动调用 `POST /api/agents`。
- 不给文件新增行为不兼容的大小上限或 Web Worker；本轮仅校验扩展名并捕获读取错误。
- 不修改 AgentForm 五个分区本身的字段编辑体验。

## 3. 用户故事

### U1 — 上传文件

用户打开新建 Agent，点击「导入 agent.md」，默认看到一个清晰的拖放区。选择
`security-reviewer.md` 后能看到文件名和大小；点击「检查内容」后进入分组预览，frontmatter 没写 name 时仍按
RFC-018 用文件名 `security-reviewer` 填充。

### U2 — 粘贴文本

用户切到「粘贴文本」，在共享等宽 textarea 中粘贴内容。切回上传再切回来，粘贴内容仍在；两种来源不会把
上传文件正文偷偷灌进彼此。点击检查后，只解析当前选中的来源。

### U3 — 看清全部去向

文件同时声明 `runtime / dependsOn / mcp / plugins / outputs / permission`。review 中分别出现 Basics、Resources、
Ports、Advanced 卡片，每项都能看出将进入哪个表单分区；不再存在“会覆盖但预览未展示”的字段。

### U4 — 看清覆盖影响

用户已经改过 description、runtime 和 prompt。review 顶部显示“将替换 3 个已编辑字段”，列出字段名；主按钮
文案同时显示本次填入项数。用户仍可返回修改来源或取消，不增加第二层 confirm。

### U5 — 阻断与修复

YAML 失败时显示共享错误条并禁用填入；非阻断 shape warning 单独列在提示卡里。若命中 RFC-194 orphan sidecar
冲突，错误条说明具体映射，并提供返回 Ports 分区修复的行动。

### U6 — 稳定结果

用户点击「填入草稿」后，看到“已填入 9 项，涉及 5 个分区；Agent 尚未创建”的结果页。点击「查看并完成表单」
回到 AgentForm；点击「重新导入」则清空本次会话并回到来源选择。无论哪种方式，都不会自动保存或发后端请求。

### U7 — 手机端

在 390×844 上，来源 tabs、dropzone / textarea、分组卡和 footer 纵向排布。字段名与值上下堆叠，长 JSON、路径、
warning 可断行；用户无需横向滚动，也不会看到三列被压成碎片。

## 4. 验收标准

1. 弹窗具有 select / review / result 三阶段；每次只渲染一个阶段，返回会保留本次来源，重新导入会彻底重置。
2. Upload 使用 `FileDropzone`，Paste 使用 `TextArea monospace`，外壳继续使用共享 `Dialog`，来源继续使用共享
   `TabBar`；业务组件不得再渲染原生 file input / textarea / table。
3. 一份包含 parser 全部一等字段的 fixture，在 review 中恰好路由到五个 AgentForm 分区；
   `runtime / dependsOn / mcp / plugins` 有显式回归断言。
4. `frontmatterExtra` 每个 key 可见；body 显示字节数、行数和非空摘录；长数组 / map / 文本在 390px 不溢出。
5. YAML blocking warning、orphan sidecar conflict、非阻断 warning、覆盖影响、空结果五种状态有独立视觉与测试；
   前两者和空结果都禁用「填入草稿」。
6. Apply 仍只调用一次 `onApply(result)`，不自动创建 Agent；成功后进入 result 而非立即关闭，并明确“尚未创建”。
7. 上传读取 reject、读取过程中关闭、关闭后迟到 resolve、换文件后旧 resolve 四条路径均无未处理 rejection或旧状态回灌。
8. Dialog 关闭后焦点回到 `agent-import-open`；阶段切换后的标题可被读屏立即感知。
9. `/agents/$name` 继续没有导入入口；RFC-194 端口门禁和 Create 按钮阻断链零退化。
10. 1280×800 light/dark 与 390×844 真浏览器通过 axe、键盘、几何断言；document / dialog / preview 均无水平溢出。
11. `bun run typecheck`、`bun run test`、frontend 全量、lint、format、binary smoke 与 SHA 对应 CI 全绿。

## 5. 产品决策

### D1 — 同样的任务结构，不假装是同一种提交

复用 RFC-196 的三阶段、FileDropzone、卡片化 review 和稳定 result；但结果标题必须是“已填入草稿”，不能使用
“导入成功 / 已创建”造成后端已保存的错觉。

### D2 — 按表单分区组织，而不是按 frontmatter 原始顺序

用户下一步是在 AgentForm 里检查和补齐内容，分区就是最有用的信息架构。原始 YAML 顺序不作为 review 主结构；
字段名仍保留，确保高级用户能对照源文件。

### D3 — 不做逐字段选择

Agent 导入从 RFC-018 起就是用户主动覆盖草稿，且未提交前仍可人工修改。增加十几个 checkbox 会显著放大认知负担，
又无法替代最终表单校验。本轮用明确覆盖提示和分组预览解决知情问题，保持 merge wire 不变。

### D4 — Apply 后留在结果阶段

瞬时 toast 无法可靠解释“已写草稿但未创建”，立即关闭又是现有误解来源。稳定结果页同时提供返回表单与重新导入；
关闭 result 只关闭弹窗，不回滚已经写入的草稿。

### D5 — 不新增文件大小上限

RFC-018 明确未限制 Agent Markdown 大小，shared schema 的 `bodyMd` 也没有对应上限。为 UX 重构新增 1 MiB / 2 MiB
硬门会成为未经请求的兼容性变更。本 RFC 仅做 `.md/.markdown` 扩展名早反馈、读取异常收口与迟到结果隔离；若未来
需要性能上限，应以 parser / save 契约为依据单独决策。

## 6. 风险与缓解

| 风险                               | 缓解                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| 分组预览再次漏字段                 | 抽出单一 `describeAgentImport` 纯函数；full-surface fixture 锁五分区与所有 parser 一等输出     |
| Apply 后仍开着弹窗让人误以为未生效 | 按钮改名「填入草稿」；result 明示已写入且不可用 Cancel 语义，只提供查看 / 重新导入 / 关闭      |
| 文件读取迟到污染重开会话           | 单调 generation token；close、replace、reset 都使旧 token 失效，resolve/reject 先核对 token    |
| 390px 卡片仍被长 JSON 撑宽         | 所有 flex/grid 边界 `min-width:0`，value `overflow-wrap:anywhere`，窄屏 label/value 纵向       |
| 覆盖提示与实际 merge 漂移          | 继续复用 `fieldsOverwrittenByImport`；不在 JSX 重写覆盖判定                                    |
| 新 result 行为影响既有测试         | 明确更新“Apply 后关闭”旧断言为“Apply 一次 → result → 用户关闭”，路由 merge/Create 阻断测试保留 |

## 7. 交付边界

预计只触及 frontend 与 RFC 文档：`AgentImportDialog`、一个纯预览 helper、`agents.new` 的 trigger / callback、
zh/en i18n、feature CSS、现有单元 / 集成 / e2e 测试及源码守卫。shared parser、backend、数据库与 API wire 均不改。
