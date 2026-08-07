# RFC-270 · 脚本 / 代码平台调用节点与配置页的越权面收口

> 产品视角。技术设计见 [`design.md`](./design.md)，任务分解见 [`plan.md`](./plan.md)。

## 1. 背景

用户 2026-08-08 实报五条越权行为，全部围绕两类**特权节点**（RFC-253 脚本节点 / RFC-269 代码平台调用节点）与**系统配置页**：

1. 普通用户可以创建脚本节点和代码平台调用节点；
2. 普通用户可以查看这两类节点的详细信息；
3. 普通用户可以通过代码平台调用节点详情里的「配置」按钮跳到配置页；
4. 普通用户可以直接打开配置页，并看到完整的配置分区侧边栏；
5. 只要工作流里有一个脚本节点，这个工作流对普通用户就变成「权限异常」。

### 1.1 这不是「漏写权限判断」，是三处设计取舍叠加出来的

平台**已经有**正确的权限点，也**已经有**正确的后端强制：

- `scripts:author`（`packages/shared/src/schemas/permission.ts:193`）与 `code-host-calls:author`（同文件 `:202`）都在 `SYSTEM_DOMAIN_POINTS`（`:248` / `:251`，永不上 PAT）与 `MANAGER_EXTRA`（`:402` / `:405`）里登记，`ROLE_PERMISSIONS.user` 不含二者；
- 后端把门放在**两个持久化原语**上而不是路由上（`services/scriptAuthorGate.ts:1-17` 写明了理由）：`prepareWorkflowSave`（`services/workflow.ts:383` / `:395`）与 `insertWorkflowInTx`（`:805` / `:808`）。任何内部调用方都绕不过去。

真正的问题是**前台没有对齐这条边界**，而且是三处**当初有意为之**的取舍：

| # | 现状 | 出处 |
|---|---|---|
| ① | `buildPalette()` 根本没有 permission 形参，`script` / `code-host-call` 是无条件表项 | `packages/frontend/src/components/canvas/nodePalette.ts:394-398`、`:214-236`；`packages/frontend/tests/palette.test.ts:168-169` 把「两个分区无条件存在」锁成了期望 |
| ② | Inspector 采「**只读 + 横幅**」而不是「不可见」，并把它写成设计意图 | `inspector/ScriptEdit.tsx:11-15`（「you may look, you may not change」，AC-30）、`inspector/CodeHostCallEdit.tsx:14-17` |
| ③ | 配置页藏的是**入口不是页面**：只有齿轮按钮判 `settings:read` | `components/shell/AppShell.tsx:316-320`；`routes/settings.tsx:67-72` 无 `beforeLoad`、`sectionGroups`（`:260-340`）是零过滤的硬编码字面量 |

②③ 还各有一层放大：

- **②的放大** —— 后端读路径对**会话通道**完全不脱敏。`tokenRedaction.ts:41` 写死 `shouldRedactFor = source === 'pat'`，理由是「浏览器里本来就能打开 MCP 编辑器的人，藏这几个字节没有意义」。这条推理在 RFC-247 的语境下成立，在有了 `scripts:author` 之后不再成立：脚本正文、`env`、依赖、代码平台调用的 path / body / params **原样出现在 `GET /api/workflows/:id` 的响应里**，任何能看见该工作流的用户 devtools 一开就有。同样的字节还随 `tasks.workflowSnapshot` 出现在每个任务详情里（`routes/tasks.ts` 七处 `serializeTaskFor`），并且**比工作流本身活得更久**。
- **③的放大** —— `lib/nav.ts:15-20` 明确写了 `adminOnly` 的约定是「过滤只发生在 ShellNavigation，非 admin 直接输入 URL 时**页面自身再守卫**」。`/settings` 从来没拿到那个自守卫。

### 1.2 第 5 条「权限异常」的完整链路

这是**一条 bug 链**，不是权限设计问题：

1. 编辑器 1s 防抖自动保存 → `PUT /api/workflows/:id`；
2. 敏感投影变了且无权限 → `scriptAuthorGate.ts:84` 抛 `ForbiddenError('script-author-forbidden')` → HTTP 403；
3. `hooks/useWorkflowEditorDraft.ts:1017-1031` 的 `failureFromError` 把 `ApiError.code` **整个丢掉**（`WorkflowDraftFailure` 类型里压根没有 `code` 字段，`lib/workflow-editor-draft.ts:73-77`）；
4. `lib/workflow-editor-draft.ts:599-601` 把 `403 || 404` 一律判成终态 `inaccessible`；
5. 于是用户看到「**无法继续访问此工作流 / 此工作流可能已删除或权限已变化**」（`i18n/zh-CN.ts:8845-8846`），并被给到四个全都无效的出口：重试访问（永远再 403）、另存为副本（走 `insertWorkflowInTx` 且 `previous` 为空，`workflow.ts:805`，必 403）、导出 YAML、返回列表。

更糟的是**触发它的动作可能只是拖了一下节点**：`WorkflowCanvas.tsx:2752-2760` 的 drag-stop 会按几何重算 wrapper 归属并改写 `wrapper.nodeIds`，而 wrapper 传递归属正在敏感投影里（`packages/shared/src/workflowNodeAncestry.ts:54-85`）。这与 `scriptAuthorGate.ts:14-15` 自己写下的承诺——「无权限的作者仍然可以移动脚本节点、改名、编辑同一工作流的无关部分」——**直接矛盾**。

## 2. 目标

- **G1** 无 `scripts:author` / `code-host-calls:author` 的用户，在 palette 里**能看到但拖不出**对应节点，且有明确的原因提示。
- **G2** 这两类节点的**敏感内容**（脚本正文 / `env` / 依赖；代码平台调用的 `params` / `request.path` / `request.body` / `request.query`）对无权限用户在**服务端就不下发**，前台 Inspector 与 Preview 呈现「无权限查看」占位。
- **G3** 代码平台调用 Inspector 里的「管理连接 ↗」按钮对无 `settings:read` 的用户不渲染。
- **G4** 无 `settings:read` 的用户访问 `/settings` 在**路由层**被重定向，看不到配置页外壳与分区侧边栏。
- **G5** 无权限用户编辑含特权节点的工作流**不再莫名其妙 403**：节点自身字段由服务端回填、结构性改动在前台被挡住；万一仍触发，UI 给出**准确且可操作**的提示，而不是「工作流可能已删除」。

## 3. 非目标

- **不新增权限点**。查看与创作共用同一个点（`scripts:author` / `code-host-calls:author`），权限目录计数保持 67。
- **不改角色矩阵**。admin + manager 仍持有两点，`user` 基线不动。
- **不改后端两个 author gate 的判据**。投影定义、比较方式、错误码全部原样保留；本 RFC 只在门**之前**加一步回填，并让前台不再制造无谓的越门尝试。
- **不动 PAT 通道的既有脱敏**（`tokenRedaction.ts` 的 `source === 'pat'` 分支照旧），本 RFC 是在其**旁边**加一条按权限的镜头，不是替换。
- **不改工作流 / 任务的可见性与启动权限**。含脚本节点的工作流对有权限查看它的用户仍然可见、可启动（`taskLaunchGate.ts:30-60` 不动）。
- **不做 `/settings` 的分区级细粒度权限**（比如「让 manager 只看某几个分区」）。当前 `settings:read` 只有 admin 持有，整页守卫即可；分区级留给未来真有该需求时再开 RFC。

## 4. 用户故事

- **US-1**（普通用户 / 编辑器）我在画布左侧看到「脚本」「集成」分区是灰的，鼠标悬停告诉我「需要 `scripts:author` 权限」，我不会先拖出来再在保存时被打回。
- **US-2**（普通用户 / 编辑器）我点开别人做好的脚本节点，看到的是「你没有查看此节点详情的权限」，而不是完整的脚本正文；我用 devtools 看网络响应，拿到的也只是 `***`。
- **US-3**（普通用户 / 编辑器）我在含脚本节点的工作流里挪动别的节点、改标题、连别的线，自动保存正常绿灯，**不会**弹「无法继续访问此工作流」。
- **US-4**（普通用户 / 编辑器）我试图删除脚本节点或改它的入边，UI 直接不让我做，并告诉我原因；不会让我做完再在保存时整个工作流变砖。
- **US-5**（普通用户 / 任意页面）我把 `/settings` 地址粘进浏览器，被直接送回首页，看不到配置页的任何一帧。
- **US-6**（admin / manager）以上一切对我毫无变化：palette 正常、Inspector 正常可编辑、配置页正常打开。

## 5. 能力影响清单（CLAUDE.md 规则 7 强制）

本 RFC 属于**能力收缩型**——以权限边界为由关闭既有能力。以下逐项列出被关闭的能力、受影响人群与后果，作为 breaking change 呈用户确认。**每一条都必须有对应测试**（见 `design.md §7`）。

| # | 被关闭的既有能力 | 受影响人群 | 关闭后 | 补偿 / 逃生路径 |
|---|---|---|---|---|
| **C1** | 从 palette 拖出 `script` 节点 | 无 `scripts:author` 的用户（`user` 角色全体） | 条目置灰、拖拽与点击均不生效 | 提示文案指明所需权限；admin / manager 不受影响 |
| **C2** | 从 palette 拖出 `code-host-call` 节点 | 无 `code-host-calls:author` 的用户 | 同上 | 同上 |
| **C3** | 在 Inspector 里**查看**脚本正文 / `env` / 依赖 | 无 `scripts:author` 的用户 | 换成「无权限查看」占位 | **这是对 RFC-253 AC-30 的显式改判**——原设计「只读 + 横幅」是有意的诚实呈现，现按用户判定改为不可见。RFC-253 文档同步加改判记录 |
| **C4** | 在 Inspector 里**查看**代码平台调用的 params / path / body | 无 `code-host-calls:author` 的用户 | 同上 | 同上（RFC-269 同步记档） |
| **C5** | 通过 `GET /api/workflows/:id`、`GET /api/workflows`、`GET /api/tasks/:id`、YAML 导出拿到上述字段的明文 | 同 C3 / C4 | 返回 `***` | **副作用**：无权限用户导出的 YAML 含 `***`，再导入会造出坏脚本——但导入走 `insertWorkflowInTx` 的门（`workflow.ts:805`），无权限者必 403；admin 导入这种 YAML 会得到 `***` 正文，与 PAT 通道既有风险同形，写进 `docs/dev-gotchas.md` |
| **C6** | 在画布上拖动 / 删除特权节点，或改它的入边 | 同 C3 / C4 | 节点不可拖、不可删，入边不可增删 | 这些操作**原本也会**在保存时 403（只是报错报错了），现在改为**当场不让做**并给出原因 |
| **C7** | 非 admin 打开 `/settings`（哪怕只是看到外壳与分区列表） | 所有非 admin（含 manager——`MANAGER_DENIED_PERMISSIONS` 显式拒了 `settings:read`，`permission.ts:445-454`） | `beforeLoad` 重定向到 `/` | 无。原本进去也只有一条 403 错误横幅，无功能损失 |
| **C8** | 代码平台调用 Inspector 里的「管理连接 ↗」入口 | 无 `settings:read` 的用户 | 不渲染 | 无。原本点进去也是 403 |

**明确不收缩的能力**（防止过度收紧）：含特权节点的工作流对无权限用户**仍然可见、可启动、可改标题 / 改别的节点 / 改布局**；节点仍出现在画布上并显示卡片摘要（provider / action / 语言 / 依赖数 / 网络与只读标记），使图仍然可读；端口与连线拓扑不隐藏，否则整张图无法理解也无法编辑。

## 6. 验收标准

### 权限门（后端）

- **AC-1** `GET /api/workflows/:id`：无 `scripts:author` 的会话用户拿到的脚本节点，`script` / `env` 值 / `dependencies[]` 全部为 `***`；有权限者拿到明文。
- **AC-2** 同上，无 `code-host-calls:author` 者拿到的代码平台调用节点，`params` 值 / `request.path` / `request.body` / `request.query` 值全部为 `***`。
- **AC-3** 脱敏**不破坏结构**：`language` / `network` / `readonly` / `outputs` / `provider` / `action` / `request.method` / `allowDestructive` / `timeoutMs` 原样保留，脱敏后的定义仍能通过 `ScriptNodeSchema` / `CodeHostCallNodeSchema` 严格解析。
- **AC-4** `GET /api/workflows`（列表）、`POST /api/workflows`、`POST /api/workflows/:id/copy`、`PUT /api/workflows/:id` 的回执、`POST /api/workflows/import`、`GET /api/workflows/:id/export`、以及全部 `serializeTaskFor` 出口（`tasks.workflowSnapshot`）同样按镜头脱敏。
- **AC-5** PAT 通道的既有脱敏叠加生效且不回退：PAT 读脚本 `env` 仍是 `***`（RFC-247 / RFC-253 T28 的既有断言不变）。
- **AC-6** 无 `scripts:author` 的用户把脱敏定义原样 PUT 回来（只改了别的节点），服务端从库里回填被脱敏字段后再过门 → **200**，且库里脚本正文一个字节没变。
- **AC-7** 无权限用户**新增**特权节点 / **删除**特权节点 / 改它的入边或 wrapper 归属 → 仍然 403，错误码仍是 `script-author-forbidden` / `code-host-author-forbidden`。
- **AC-8** 回填只对**被脱敏的镜头**生效：有权限的作者提交 `***` 字面量会被原样写入（不做魔法还原），否则「把脚本正文改成 `***`」这个合法编辑会被静默吞掉。

### 前台

- **AC-9** 无 `scripts:author` 时 palette「脚本」分区条目 `aria-disabled="true"`、点击不新增节点、`dragstart` 被阻止；有权限时一切照旧。
- **AC-10** 无 `code-host-calls:author` 时「集成」分区同上。
- **AC-11** 无权限时 `ScriptEdit` / `CodeHostCallEdit` 渲染「无权限查看」占位，**不渲染任何**脚本正文 / env / 依赖 / params / path / body 控件；Inspector 的 Preview 页签同样不泄露这些字段。
- **AC-12** 无 `settings:read` 时代码平台调用 Inspector 不渲染 `data-testid="code-host-manage-connections"` 链接。
- **AC-13** 无 `settings:read` 的用户导航到 `/settings`（含带 `?tab=` 的深链）被重定向到 `/`；admin 正常进入。
- **AC-14** 画布上特权节点对无权限用户 `draggable=false`、不可删除；连到它 / 从它连出的边不可新建或删除。
- **AC-15** 无权限用户在含脚本节点的工作流里**移动别的节点**并触发自动保存 → 状态回到 `clean`，不出现 `inaccessible` 横幅。
- **AC-16** 保存真的返回 `script-author-forbidden` / `code-host-author-forbidden` 时，UI **不再**显示「此工作流可能已删除或权限已变化」，而是显示专属文案（说明需要哪个权限、草稿仍在、可撤销该步），且**不进入** `inaccessible` 终态。

## 7. 度量与回归防护

- 后端：`scriptAuthorGate` / `codeHostAuthorGate` 现有测试全绿不变（`packages/backend/tests/rfc253-script-author-gate.test.ts`、`rfc269-code-host-authoring.test.ts`）。
- 权限目录计数保持 **67**（`packages/shared/tests/permission.test.ts`）。
- `packages/frontend/tests/palette.test.ts:168-169` 的「两个分区无条件存在」断言需**显式改判**为「分区存在但按权限置灰」，并在测试里写明改判理由。
- 新增测试清单见 `design.md §7`。
