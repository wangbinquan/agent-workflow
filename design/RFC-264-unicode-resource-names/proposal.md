# RFC-264 · 工作流 / 工作组名称支持中文（人类可读名）

状态：Done（2026-08-07，用户批准后实现）
作者：本 session（用户提出：「工作组、工作流名称要能支持中文」）
关联：[RFC-164](../RFC-164-workgroup/proposal.md)（工作组资源本体与 `WORKGROUP_NAME_RE`）、[RFC-223](../RFC-223-multi-tenant-resource-identity/proposal.md)（引用 ID 化）、[RFC-231](../RFC-231-private-by-default-and-resource-copy/proposal.md)（`nextResourceCopyName`）、[RFC-243](../RFC-243-unified-executor/proposal.md)（`call-workflow` / `call-workgroup` 按名字选目标）、[RFC-199](../RFC-199-workflow-editor-zero-guidance-ux/proposal.md)（本地草稿导出文件名）

## 1. 背景

工作流与工作组的名称今天**只能是小写 ASCII slug**。唯一事实源是一条正则：

- `packages/shared/src/schemas/workgroup.ts:63` —— `WORKGROUP_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/`
- `packages/shared/src/schemas/workflow.ts:360` —— `WORKFLOW_NAME_RE = WORKGROUP_NAME_RE`（**同一对象别名**，`packages/frontend/tests/workflows-pages.test.tsx:235` 锁死不许漂移）

这条规则是 2026-07-10「命名统一」时把工作流对齐到工作组定的（`packages/shared/src/schemas/workflow.ts:351-359` 注释），当时的理由是"工作组名是 slug"。但本仓的主语言是中文，用户给工作流 / 工作组起的名字天然是中文——「代码审计流水线」「发版前质量门」——今天只能写成 `code-audit-pipeline`，在 `/workflows`、`/workgroups`、任务列表、启动向导、画布 call 节点里全程以英文 slug 示人，跟中文界面割裂。

**为什么现在可以放宽**：名称从来不是 URL / 路径 / 分支名的一部分——

| 面 | 用的是什么 | 锚点 |
| --- | --- | --- |
| REST 路径 | ULID（`/api/workflows/:id`、`/api/workgroups/:id`） | `packages/backend/src/routes/workflows.ts:106`、`routes/workgroups.ts:82` |
| 前端路由 | ULID（`/workflows/$id`、`/workgroups/$id`） | `packages/frontend/src/routes/workflows.edit.tsx`、`workgroups.detail.tsx` |
| 导出响应头 | ULID（`content-disposition: attachment; filename="<id>.yaml"`） | `packages/backend/src/routes/workflows.ts:411` |
| worktree / 分支 | `repo-slug` + task ULID | `packages/backend/src/util/git.ts:941,969` |
| 内建行识别 | `builtin` 列，**不是**名字 | `packages/backend/src/services/systemResources.ts:45-48` |

也就是说，放宽字符集不会撞上任何路径安全、URL 编码或 git 引用格式的约束。

**名字仍然承担的两件事**（本 RFC 必须照顾到，不是废弃项）：

1. **工作组名在 owner 命名空间内唯一** —— `packages/backend/src/db/schema.ts:578-583` 的 `workgroups_owner_name_unique` 建在 `(COALESCE(owner_user_id,''), name)` 上（工作流表**没有**这个索引，重名合法）。
2. **跨任务调用按名字选目标** —— `packages/shared/src/schemas/workflow.ts:801-803` 明写 `workflowName` 是 AUTHORITATIVE selector、`workflowId` 只是"stripped from YAML exports"的解析缓存；`call-workgroup` 同构（`:819-829`）。RFC-223 的 ID 化打的是**工作组成员 → 代理**那条边（`schemas/workgroup.ts:103-114`），并没有把名字从选择器位置撤下来。

## 2. 目标

- **G1**：工作流与工作组的名称支持中文，以及中英混排、大写字母、常见标点与空格——「代码审计流水线」「审计 Pipeline v2」「Code Review（重构专用）」都能直接用。
- **G2**：存量零破坏。今天库里的每一个名字在新规则下继续合法，无迁移、无回填、无双读。
- **G3**：派生物保留中文——副本名是「代码审计流水线-copy」而不是退化的 `workflow-copy`；YAML 下载得到「代码审计流水线.yaml」而不是 `workflow.yaml`。
- **G4**：选择器里两个候选**看起来一样**时能分辨——同一下拉内 `名字 · owner` 撞车的候选各自追加 ID 后 6 位（用户拍板）。
- **G5**：AI 意图生成（`/intent`）用中文描述需求时，产出的工作流 / 工作组名也是中文（代理 / 技能 / MCP / 插件仍强制 slug）。

## 3. 非目标

- **代理 / 技能 / MCP / 插件 / 运行时改名规则**（用户拍板：只放宽工作流 + 工作组）。它们的名字有真实的外部约束：代理名进受控 opencode 配置的 agent 键、技能名**就是**磁盘目录名（`~/.agent-workflow/skills/{name}/files/`）、MCP / 插件名进 MCP server 键。这几类保持 `^[a-z0-9][a-z0-9_-]*$`。
- **把名字从选择器位置换成 ID**（即让 `call-workflow` / `call-workgroup` 改用 `workflowId` 作权威选择器）。那是 RFC-243 的设计决定（durable / rename-tolerant / YAML-portable），本 RFC 不动；G4 的 ID 后缀是**显示层**消歧，不改选择语义。
- **全角 / 半角折叠（NFKC）**。NFKC 会把「代码审计（重构）」的全角括号折成半角、把「Ａ」折成「A」，是对用户输入的实质改写，副作用远超收益。本 RFC 只做 NFC（对纯汉字是恒等变换）。
- **简繁转换、同形字检测、Unicode 混淆脚本（confusables）检测**。看起来像的名字靠 G4 的 ID 后缀在选择器里分辨，不做字形层判重。
- **列表页展示改造**。`/workflows`、`/workgroups` 列表已有 owner 与描述列，不追加 ID 后缀（只改选择器）。
- **名称长度上限调整**。仍是 128，但计量单位从 UTF-16 编码单元改成**码点**（`u` flag 下正则量词按码点计数）——纯汉字即 128 字，128 个 emoji 也不再被旧的 `.max(128)` 误判为超长。

## 4. 用户故事

1. **中文起名**：用户在 `/workflows` 点「创建工作流」，名称填「代码审计流水线」，直接创建成功；列表、任务列表的「工作流」列、画布标题、任务详情全程显示中文名。
2. **中英混排**：另一个工作流叫「审计 Pipeline v2」——空格、大写、数字混排都合法；把它保存后再打开，名字一个字节不变。
3. **改名**：用户把存量的 `code-audit-flow` 在编辑器的重命名弹窗里改成「代码审计流程」，保存成功；引用它的 `call-workflow` 节点在画布下拉里也显示新中文名。
4. **复制**：复制「代码审计流水线」得到「代码审计流水线-copy」，再复制得到「代码审计流水线-copy-2」；导出 YAML 下载下来是「代码审计流水线.yaml」。
5. **重名消歧**：同一个用户手里有两个都叫「代码审计」的工作流（工作流允许重名），启动向导的下拉里分别显示「代码审计 · alice · #7K3M2Q」「代码审计 · alice · #B9XZ04」，能选中想要的那个；只有一个「代码审计」时下拉里不显示任何 ID 后缀。
6. **AI 生成**：用户在 `/intent` 里说「帮我做一个代码审计工作流」，AI 产出的工作流名是「代码审计工作流」，而它顺带创建的代理仍叫 `code-auditor`。
7. **手滑保护**：用户粘贴进来的名字带了首尾空格或全角空格，保存后自动归一成「代码审计」；但粘进一段带换行的多行文本会被明确拒绝，而不是被静默拼成一行。

## 5. 行为变更清单（breaking-ish，逐条呈用户确认）

本 RFC 主体是**能力放宽**，但有三处**既有行为会变**，按 CLAUDE.md「能力影响清单」的精神逐条列出：

| 编号 | 变更 | 影响面 | 判断 |
| --- | --- | --- | --- |
| B-1 | 名称在**创建 / 改名 / YAML 导入**时会被归一化（NFC → 各类空白统一成半角空格 → 连续空格折叠 → 去首尾空白），而不是原样存 | 所有新名字 | 采纳。归一是幂等的、只动空白与等价码点；且今天名字若带首尾空格，`deleteConfirm.ts:60` 的逐字节比对会让它**永远删不掉**（UI 会 trim 用户输入），归一化顺带修掉这个死角 |
| B-2 | 2026-07-10 之前遗留的自由格式工作流名（含连续空格 / 首尾空格的那些）在**下次保存时会被静默归一一次**，等于被改名 | 仅限极少数上古工作流 | 采纳。归一前后渲染完全相同；不归一它们就继续处在 B-1 说的"删不掉"状态 |
| B-3 | 工作组名称输入框上的原生 HTML `pattern` 属性被移除（`workgroups.detail.tsx:997,1030`），校验完全交给 JS + 内联 i18n 错误 | 工作组新建 / 重命名 / 复制弹窗 | 采纳。原生 `pattern` 校验的是**未归一化的原始输入**，与服务端校验**归一化后**的值判据不同，会出现"前端红、后端会接受"的假报错；且它的浏览器气泡文案不走 i18n。留一套判据比留两套好 |

**不变的**：存量所有名字继续合法（老规则要求首字符 `[a-z0-9]`，新规则是它的超集），零迁移；工作组 owner 内唯一约束不变；`call-workflow` / `call-workgroup` 的名字选择语义不变；代理 / 技能 / MCP / 插件 / 运行时命名规则一个字不动。

## 6. 验收标准

| 编号 | 验收点 |
| --- | --- |
| AC-1 | 工作流与工作组都能以「代码审计流水线」「审计 Pipeline v2」「Code Review（重构专用）」创建成功；存量 `my-workflow` 形态继续合法 |
| AC-2 | 以下输入被拒绝并给出 i18n 错误：空名、纯空白、>128 字符、以 `_` 开头（`__workgroup_host__` 形态保留给框架内建）、含换行 / 制表符 / 零宽字符 / RTL override / 孤立代理项 |
| AC-3 | 归一化生效且幂等：`"代码审计 "` → `"代码审计"`；`"审计　Pipeline"`（全角空格）→ `"审计 Pipeline"`；`"审计  流程"`（双空格）→ `"审计 流程"`；对纯汉字名 NFC 是恒等 |
| AC-4 | `WORKFLOW_NAME_RE` 与 `WORKGROUP_NAME_RE` 仍是**同一个对象**（既有别名锁不许漂移的测试继续绿） |
| AC-5 | 存量 grandfather 不变：未改动的名字照常保存（含 2026-07-10 前的自由格式名）；只有**改动过的**名字才走新校验（`assertChangedWorkflowName` 语义保持） |
| AC-6 | 工作组的 owner 内唯一仍然生效：同一 owner 建两个「代码审计组」→ 409 冲突；不同 owner 各建一个 → 都成功 |
| AC-7 | 复制中文名工作流 / 工作组得到「<原名>-copy」「<原名>-copy-2」；含 emoji（代理对）的名字截断到 128 上限时**不会切碎代理对** |
| AC-8 | YAML 导出下载文件名保留中文（「代码审计流水线.yaml」）；本地草稿导出为「代码审计流水线-unsaved.yaml」；文件名里的 `/ \ : * ? " < > |` 与控制字符被替换 |
| AC-9 | YAML 导入接受中文 `name`；非法 `name` 仍以 `workflow-name-invalid` 422 拒绝，错误文案描述新规则（不再说"必须 `[a-z0-9]` 开头"） |
| AC-10 | 五处选择器（启动向导 / call-workflow / call-workgroup / 起手模板 / webhook 触发目标）在候选 `名字 · owner` 撞车时各自追加 ID 后 6 位；不撞车时**不追加** |
| AC-11 | `/intent` 提示词允许工作流 / 工作组用中文名，代理 / 技能 / MCP / 插件仍强制 `^[a-z0-9][a-z0-9_-]*$`；生成的中文名能通过 changeset 校验落库 |
| AC-12 | 两个 locale 的名称 hint 与 `nameInvalid` 文案已更新且工作流 / 工作组逐字一致（既有 parity 测试继续绿）；不再出现"小写"「URL 安全」等过时措辞 |
| AC-13 | e2e：在 UI 里用中文名建工作流 → 改名 → 启动任务，任务详情与列表全程显示中文名 |
