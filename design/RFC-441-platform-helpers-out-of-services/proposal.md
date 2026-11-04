# RFC-441 API 文档、PlantUML 渲染与外部入口开关归 platform（RFC-294 W4 B / D 第七步）

- **状态**：In Progress（2026-11-04）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.1 W4 B / D
- **前序**：[RFC-440](../RFC-440-transport-helpers-out-of-services/proposal.md)（删除确认、删除快照与 token 读视图离开 services/）
- **落位**：platform：`platform/operations`（API 文档）、`platform/http`（PlantUML 渲染代理）、`platform/configuration`（外部入口开关）。

## 1. 背景

RFC-440 之后，B / D 退出门余下「入站适配器不 import `services/`」：`routes/` 18 个文件与 `mcp/server.ts`。其中三个路由与
`mcp/server.ts` 只差三个小的平台性助手：

- `services/apiDocs.ts`（263 行）：从 operation catalog 派生 `/api/docs` 与 `/.well-known/mcp` 的文档体。只被 `routes/docs.ts` 引用，
  归属表登记为 platform。
- `services/plantuml.ts`（189 行）：`/api/plantuml/render` 的服务端渲染代理（编码 + kroki / picoweb 回退链）。只被
  `routes/plantuml.ts` 引用，归属表登记为 platform。
- `services/mcpSurface.ts`（25 行）：RFC-247 D10 的外部入口总开关读取（`mcpSurfaceEnabled` 缺省为开）。引用方是 `routes/auth.ts`
  （签发令牌前检查）、`routes/docs.ts` 与 `mcp/server.ts`。同文件的 `tokenAuditRetentionDays` 在生产里零调用：唯一的读方
  `platform/background/maintenanceService.ts` 直接写 `config.tokenAuditRetentionDays ?? 90`。

## 2. 目标

- **G1**：`services/apiDocs.ts` → `platform/operations/apiDocs.ts`，与它派生自的 operation catalog 同处；原样搬迁。
- **G2**：`services/plantuml.ts` → `platform/http/plantuml.ts`；原样搬迁。
- **G3**：`services/mcpSurface.ts` → `platform/configuration/mcpSurface.ts`；删去零调用的 `tokenAuditRetentionDays`，其余原样。
- **G4 行为不变**：文档体、渲染代理的回退链与错误、开关的缺省与判定全部不变。
- **G5 不留 facade**：原 3 个文件删除，所有引用改到新位置。

## 3. 非目标

- 其余 15 个路由的 `services/` 依赖（source-control、identity-access OIDC、resource-catalog、任务相关路由，各自另立）。
- `routes/registry`、`routes/resourceAcl` 归位 platform。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：三个 `services/` 文件不再存在，源码里没有对它们的 import；新文件不 import 模块，也不 import legacy 目标前缀
  （`services/`、`routes/`、`ws/`、`mcp/`）。
- **AC-2**：计数按实测更新，其余结构门不回退：
  - import `services/` 的路由 18 → 15（`auth`、`docs`、`plantuml`）；
  - `mcp/` 与 `ws/` 不再 import `services/`，入站适配器里只剩 `routes/`；
  - `services/` 文件 229 → 226。
- **AC-3**：API 文档、`/.well-known/mcp`、PlantUML 渲染代理、外部入口开关（MCP 拒绝与令牌签发拒绝）的用例全部通过。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **外部入口开关归 platform，而不是归属表登记的 resource-catalog**：
   - 它只是一个配置字段的缺省规则（`mcpSurfaceEnabled ?? true`），不带 resource-catalog 的状态或语义；
   - 消费方是三个入站适配器（MCP、签发令牌、文档）；放进 resource-catalog 就得经 public 暴露给 legacy 路由与 `mcp/`，
     而 platform 是它们都能直接依赖、又不新增边的唯一一层；
   - `platform/configuration` 正是「配置值规则」所在（`configurationValues.ts` 的说明：各适配器共用同一套缺省）。
     归属表随文件迁出而删去该行（platform 下的文件按前缀归 platform）。
2. **删除 `tokenAuditRetentionDays`，不改为让维护服务调用它**：
   - 生产里只有维护服务一个读方，它与相邻的其他作业一样就地写缺省（`?? 24`、`?? 90`）；
   - 唯一读方的就地缺省就是单一事实源，多一层间接没有第二个消费者。
3. **PlantUML 代理放 `platform/http`**：它支撑一个 HTTP 端点，是出站代理加编码器，不涉及业务状态；不为一个文件新开 platform 子目录。
4. **e2e 注释里的 `file:line` 引用只改路径**：三个文件原样搬迁，行号保持有效（`mcpSurface.ts` 删去末尾 5 行，引用的 1–21 行改为 1–20）。
