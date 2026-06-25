# RFC-105 — 任务详情 Markdown 文件预览（独立路由页）+ PlantUML 通用化

状态：Done（commit `90d16f2`；CI run 28149347427 全绿；Codex 双 gate fold）

> 范围：**WP-A** 任务详情 Markdown 预览（纯前端）；**WP-B** PlantUML 后端代理通用化（前后端）。WP-B 由 WP-A 的 PlantUML 验收标准触发——Codex 设计 gate 指出 `/api/config` 仅 admin 可读、非 admin 渲染不出 PlantUML；用户判定「PlantUML 是通用阅读能力、只给 admin 不合理」，选「后端代理渲染」根治，让预览 / 评审界面 / 编辑器预览一起受益。

## 背景

任务详情页有两个会出现 markdown 内容 / 文件的区域：

- **输出**（`outputs` tab → `TaskOutputPanel`）：每个声明的输出端口右侧详情区把端口值放进 `<pre>` 纯文本展示。端口值可能是：
  - 一段**内联 markdown 文本**（`kind = markdown`）；
  - 一个指向 `.md` **文件的工作区相对路径**（`kind = markdown_file` ≡ `path<md>`，或 `path<*>` 且值以 `.md` 结尾）——此时已有一个「下载」按钮。
- **工作目录**（`worktree-files` tab → `WorktreeFilesPanel`）：左侧目录树，右侧把选中文件的内容放进 `<pre>` 纯文本展示。其中会有 `.md` 文件。

这两处目前都只能看到 markdown 的**源码**（`# 标题`、表格管道符、` ```mermaid ` 代码块等），阅读体验差。而平台**评审界面**早已具备完整的 markdown 渲染能力（`components/prose/Prose.tsx`：react-markdown + GFM 表格/任务列表/脚注、mermaid、PlantUML、KaTeX、shiki 代码高亮、标题锚点、外链图标、工作区相对图片解析）。

用户希望：在「输出」「工作目录」里，对 markdown 内容 / `.md` 文件提供一个「预览」按钮，点开后用与评审界面**同一套渲染能力**把它渲染出来；预览为一个**独立界面**，可点击**返回**回到任务详情。

## 目标

1. 在「输出」详情区与「工作目录」文件预览区顶部，对**可渲染为 markdown 的项**增加「预览」按钮：
   - 输出端口：内联 markdown 端口（`kind = markdown`），或值为 `.md` 路径的文件型端口；
   - 工作目录：扩展名为 `.md` / `.markdown` 的文件。
2. 点击「预览」进入一个**独立路由页** `/tasks/$id/preview`，整页用 `Prose`（评审界面同款渲染器）渲染该 markdown，地址可分享、浏览器后退可返回。
3. 页面顶部提供「← 返回」可点击返回任务详情。
4. **（WP-B）PlantUML 通用化**：新增后端代理 `POST /api/plantuml/render`，把 PlantUML 渲染从「admin-only 配置可见」改为「所有登录用户可用」。渲染端点 + authHeader 留在服务端，浏览器只拿 SVG。预览 / 评审界面 / 编辑器预览中的 PlantUML 块对**所有任务成员**生效。

## 非目标

- **不做编辑**：预览是只读渲染，不引入编辑器。
- **不引入评审专属能力**：不带评论 / 选区锚点 / 决策按钮（那些属于 `ReviewDocPane`）。本 RFC 只复用最底层的 `Prose` 渲染原语。
- **WP-A 不改后端**：markdown 预览本身完全复用既有 `GET /api/tasks/:id/worktree-file`（RFC-065，2 MiB 上限 + RFC-103 realpath 包含 + RFC-099 成员鉴权）、`GET /api/tasks/:id/node-runs`（取内联端口值）。无 DB、无 migration。（WP-B 新增一个无状态代理路由 `POST /api/plantuml/render`，同样无 DB、无 migration。）
- **WP-B 不做渲染缓存 / 限流（除源码大小上限外）**：v1 每次渲染都打一次配置端点（与今天浏览器直连行为一致）；服务端 LRU 缓存 / 速率限制留作后续。
- **WP-B 不内置 plantuml.jar**：仍由 admin 在设置里配置渲染端点（kroki 兼容）；代理只是把「谁能用这个端点」从 admin 放开到所有成员，不改「端点从哪来」。端点未配置时，PlantUML 仍退化为源码态（对所有人一致）。
- **不覆盖 `list<...>` 端口**：`list<markdown>` / `list<path<md>>` 是多项集合，沿用既有「下载按钮排除 list」的口径，预览同样排除（非目标，可后续扩展）。
- **不保留返回时的原 tab**：v1「返回」落到任务详情默认页（`workflow-status`）。让任务详情 tab 可深链 / 返回原 tab 涉及给 `/tasks/$id` 路由加 search 参数并改 ~9 处既有跳转点，超出本 RFC 范围，列为后续。
- **不解决 md 文件子目录内的相对图片**：`Prose` 的 `taskId` 图片解析按**工作区根相对**重写（`resolveImageHref`），与评审界面行为一致；位于子目录的 `.md` 引用 `./x.png` 时图片可能断链——沿用现状，不在本 RFC 修。

## 用户故事

- 作为查看任务产物的用户，我在「输出」里看到某端口产出了一份 `report.md`，点「预览」就能看到带标题层级、表格、mermaid 图的渲染结果，而不是一堆源码。
- 作为查看任务产物的用户，我在「工作目录」里点开一个 `.md` 文件，点「预览」就能看到渲染后的文档；看完点「返回」回到任务详情继续浏览其他文件。
- 作为团队成员，我把预览页地址 `/tasks/<id>/preview?path=docs/report.md` 发给同事，对方打开就能看到同样的渲染结果（受后端成员鉴权保护，无权者得到 404/403）。

## 验收标准

1. 「输出」详情区：当选中端口是**内联 markdown**（`kind=markdown` 且值非空）或**值为 `.md` 路径的文件端口**时，详情区顶部出现「预览」按钮；string / signal / 非 `.md` 文件 / `list<...>` / 空值端口**不出现**。
2. 「工作目录」文件预览区：当选中文件扩展名为 `.md` / `.markdown` 且未超限（非 oversized）时，预览区顶部 Download 按钮旁出现「预览」按钮；其他扩展名不出现。
3. 点击「预览」跳转到 `/tasks/$id/preview`，并带上能唯一重建该 markdown 的 search 参数（文件型 → `?path=`；内联端口 → `?runId=&port=`）。
4. 预览页用 `Prose` 渲染（与评审界面同款）：标题锚点、GFM 表格、mermaid、KaTeX、代码高亮、**PlantUML** 对**所有任务成员**均生效（PlantUML 经 WP-B 代理；端点未配置时对所有人统一退化为源码态）。
5. **（WP-B）** PlantUML 渲染走 `POST /api/plantuml/render`：① 普通 `user` 角色（无 `settings:read`）也能渲染；② 渲染端点的 `authHeader` 不出现在任何前端响应 / 网络请求里（只在服务端→渲染端点之间）；③ 端点未配置 → 统一「未配置」提示；④ 源码语法错 → 保留语法错误提示；⑤ 评审界面 / 编辑器预览的 PlantUML 同样对非 admin 生效（同一代理）。
6. 预览页顶部有「← 返回」，点击回到 `/tasks/$id`。
7. 失败 / 边界：加载中显示 Loading；文件超限显示「过大无法预览」+ 下载入口；空内容显示空态；后端 403/404 显示错误并可返回；search 参数缺失 / 自相矛盾显示「无效预览链接」+ 返回。
8. 全链路单测 + 组件测试 + 源码守卫 + 后端代理测试绿；`bun run typecheck && 前端 vitest && 后端 bun test && format:check` 全绿。

## 决策登记

- **D1（预览窗口形态）= 独立路由页**。用户在 2026-06-25 选择「独立路由页」（而非全屏模态浮层）：`/tasks/$id/preview`，地址可分享、浏览器后退可返回，与评审界面同为路由、对称。→ 因此 `Dialog.tsx` 不改（无需新增 full size）。
- **D2（预览范围）= 含内联 markdown 端口**。用户选择在「仅 `.md` 文件」基础上，额外覆盖输出区 `kind=markdown` 的内联端口（值本身即 markdown 文本）。
- **D3（工作目录按钮位置）= 文件预览区顶部**。选中文件后在右侧预览区顶部（Download 旁）出现「预览」，与既有下载按钮风格一致、改动最小。
- **D4（PlantUML 权限）= 后端代理通用化**。2026-06-25 Codex 设计 gate P2 暴露「PlantUML 配置受 `settings:read` 门控、仅 admin 可渲染」；用户判定「PlantUML 是通用阅读能力、只给 admin 不合理」，在「后端代理 / 窄端点暴露 / 维持现状」中选**后端代理渲染**（最安全：authHeader 不出服务端）。→ 衍生 WP-B，并顺带拆除评审/编辑器里现已成死代码的 `/api/config`-for-plantuml 查询与 prop 链。

## 触发

2026-06-25 用户：「在任务详情的工作目录、输出里，如果文件是以 md 后缀，则增加预览按钮，可以预览渲染这个 markdown 文件，渲染能力复用评审界面能力，预览窗口为独立界面，可点击返回。」
