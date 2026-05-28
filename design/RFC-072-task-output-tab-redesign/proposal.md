# RFC-072 Task Detail "Outputs" Tab Redesign — Proposal（产品视角）

> 编号说明：RFC-071 已被并行进行中的「工作目录文件下载」占用
> （`design/RFC-071-worktree-file-download/`，另一贡献者，Draft 未实现），故本 RFC 取 072。
> 两者的"下载工作目录文件"机制同源（同一 `/api/worktree-files/:taskId/*` 端点 + blob fetch +
> basename），应共用同一套下载原语而非各写一份——见 design.md §3.1「与 RFC-071 协调」。

## 背景

任务详情页（`packages/frontend/src/routes/tasks.detail.tsx`）的 **Outputs** tab 由 `TaskOutputPanel`
（P-2-11，`components/TaskOutputPanel.tsx`）渲染：把工作流声明的每个 output port 解析成一张卡片，
铺成 `repeat(auto-fill, minmax(280px,1fr))` 网格，卡片正文 `<pre>` 被 `max-height: 240px` 截高。

现场使用中暴露三个问题：

1. **框太小、不好读**：每个输出挤在一张 240px 高的小卡片里，长输出（典型的 review / audit 报告、
   markdown 文档）要在卡内反复滚动，多个输出又横向铺开，无法专注看单条。RFC-065 刚给隔壁
   **工作目录** tab 落地了"左列表 + 右详情"两栏布局（`WorktreeFilesPanel`），阅读体验明显更好；
   用户希望 Outputs tab 对齐这套布局。
2. **复制按钮失效**：卡片右上角的「复制」按钮点了不复制。根因是 `navigator.clipboard.writeText`
   在**非安全上下文**（daemon 经局域网 `http://host:port` 访问，既非 HTTPS 也非 localhost）下
   `navigator.clipboard` 为 `undefined`，`handleCopy` 里 `navigator.clipboard.writeText(...)`
   直接抛 `TypeError` 而静默失败（`TaskOutputPanel.tsx:70`）。
3. **文件类输出无法下载**：当 output port 的 kind 是文件类（`markdown_file` ≡ `path<md>`，或任意
   `path<ext>`，RFC-005 / RFC-060）时，框架在 `node_run_outputs.content` 里存的是**工作目录相对
   路径**而非文件内容（`services/envelope.ts:18` resolvePortContent 语义）。当前面板把这串路径当
   纯文本显示，用户既看不到文件内容、也无法取走文件。用户希望：**输出是文件时给一个下载按钮，
   点击下载该文件**。

## 目标（Goals）

- **G1 两栏布局**：Outputs tab 改为左列表（声明的 output port 列表，可点选）+ 右详情（选中端口的
  完整值，撑满 pane 高度），与 RFC-065 **工作目录** tab 的视觉 / 交互一致。
- **G2 修复复制**：「复制」按钮在安全与非安全上下文下都能把选中输出的文本写入剪贴板；不可用时
  有可见反馈，不再静默失败。
- **G3 文件下载**：当选中 output port 的 kind 解析为单文件路径（`path<ext>`，含 `markdown_file`
  别名）时，详情区出现「下载」按钮，点击后通过 daemon 已鉴权通道取回工作目录中的该文件并触发
  浏览器下载（文件名取路径 basename）。

## 非目标（Non-Goals）

- **不改 output 解析 / envelope 协议 / 工作流定义**：output port 的声明、绑定、`outputKinds`
  契约一律不动；本 RFC 只改"已落库的输出怎么展示 / 取用"。
- **不做文件内预览渲染**：详情区对文件类输出展示其相对路径文本 + 下载按钮即可，不在 Outputs tab
  内联渲染 markdown / 图片（要看内容可去 **工作目录** tab）。v1 不做 syntax highlight。
- **不支持 `list<path<...>>` 多文件批量下载**：v1 仅对单文件 `path<ext>` 出下载按钮；列表类路径
  输出按纯文本显示（多行路径），多文件下载留作后续增强。
- **不新增下载专用后端路由**：复用既有 `GET /api/worktree-files/:taskId/*`（RFC-005 PR-B T13）
  原始文件流路由，不为下载单独造路由 / 不加 `Content-Disposition`。
- **不改其它 tab**、不动权限模型、不动 WS。

## 用户故事

- **US-1**：作为查看 Code→Audit→Fix 结果的用户，我打开任务的 Outputs tab，左侧看到所有声明的
  输出端口，点其中一个，右侧用足够大的区域展示它的完整内容，长文不再被 240px 卡死。
- **US-2**：作为通过局域网 IP 访问 daemon 的用户，我点「复制」能把当前输出复制到剪贴板，粘贴到别处
  可用；即便浏览器禁用了异步剪贴板 API 也能 work（回退到 execCommand）。
- **US-3**：作为运行了产出文件型输出（如 agent 写出一份 `report.md` 并以 `markdown_file` 端口返回
  其路径）的用户，我在该输出的详情区看到「下载」按钮，点击后浏览器直接下载到 `report.md`。

## 验收标准（Acceptance Criteria）

- **AC-1**：Outputs tab 渲染为两栏；左栏列出全部声明 output port（端口名 + 来源 `nodeId.portName`
  绑定），点选高亮；右栏展示选中端口详情。首次进入默认选中第一个端口。
- **AC-2**：右栏详情区高度撑满 pane（不再有 240px 截高），长输出在详情区内滚动。
- **AC-3**：未产出（来源节点尚无 done run / 无对应端口值）显示 pending 占位；空字符串值显示
  `(empty)` 占位——沿用现有语义。
- **AC-4**：「复制」按钮在 `navigator.clipboard` 可用时走异步 API；不可用时回退 `document.execCommand('copy')`；
  复制成功后按钮短暂显示「已复制」。值为 null（pending）时按钮禁用。
- **AC-5**：当且仅当选中端口的 kind 解析为单文件路径（`path<ext>` / `markdown_file`）且值为非空
  单行路径时，详情区出现「下载」按钮；其它 kind（`string` / `markdown` / `signal` / `list<...>`）
  无下载按钮。
- **AC-6**：点击「下载」从 `/api/worktree-files/:taskId/<relPath>` 取回文件（带鉴权），触发浏览器
  下载，下载文件名为相对路径的 basename。文件不存在 / 取回失败时给可见错误提示，不静默失败。
- **AC-7**：单仓 / 多仓（RFC-066）任务行为一致——下载相对路径相对于 `task.worktreePath`（多仓父
  目录），与既有 worktree-files 路由语义一致。
- **AC-8**：视觉与 `/agents`、`/workflows`、**工作目录** tab 对齐：按钮走 `.btn .btn--sm`，空 /
  pending 走既有 `muted` / `EmptyState` 风格，不落原生自写 chrome（CLAUDE.md 前端统一原则）。
- **AC-9**：旧任务（升级前产生、`node_run_outputs.kind` 为 NULL 的行）展示为纯文本、无下载按钮，
  不报错（向后兼容）。
- **AC-10**：每条改动随附测试（shared schema / backend 持久化 + 迁移 / frontend 纯函数 + 组件 +
  源码守门），三件 gate（`bun run typecheck && bun run test && bun run format:check`）+ lint 全绿。
