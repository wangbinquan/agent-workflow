# RFC-441 技术设计

路径缩写：`S` = `packages/backend/src`，`T` = `packages/backend/tests`。以 RFC-440 收尾后的源码（`260f676aa`）为准。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：platform：
  - `S/platform/operations/apiDocs.ts`：从 operation catalog 派生文档；
  - `S/platform/http/plantuml.ts`：HTTP 渲染代理；
  - `S/platform/configuration/mcpSurface.ts`：配置缺省规则。
- **承担的演进**：W4 B / D 第七步。import `services/` 的路由 18 → 15；`mcp/` 不再 import `services/`，入站适配器里只剩 `routes/` 还有 legacy 依赖。
- **不新增** DAG 之外的边、R1 边与 R2 边：
  - 三个新文件只 import `@agent-workflow/shared`、`node:zlib`、`@/util/timeoutSignal`（util 是最底层）与
    `@/platform/operations/catalog`；
  - platform 不 import 模块（RFC-376 G5 不变）。
- **留下的债**：其余 15 个路由的 `services/` 依赖；`routes/registry`、`routes/resourceAcl` 归位 platform。
- **偏离项**：无。外部入口开关的归属与 legacy 归属表不同（表里是 resource-catalog），理由见 proposal §6 第 1 条。

## 1. 文件去向

| 原文件                     | 新位置                                   | 说明                                             |
| -------------------------- | ---------------------------------------- | ------------------------------------------------ |
| `S/services/apiDocs.ts`    | `S/platform/operations/apiDocs.ts`       | 原样搬迁                                         |
| `S/services/plantuml.ts`   | `S/platform/http/plantuml.ts`            | 原样搬迁                                         |
| `S/services/mcpSurface.ts` | `S/platform/configuration/mcpSurface.ts` | 原样搬迁；删去零调用的 `tokenAuditRetentionDays` |

## 2. 连接（只改 import，调用不变）

- `routes/docs.ts`：`buildApiDocs` / `clientSnippets` / `wellKnownMcp` 与 `isMcpSurfaceEnabled`；文件头注释里的路径一并改。
- `routes/auth.ts`、`mcp/server.ts`：`isMcpSurfaceEnabled`。
- `routes/plantuml.ts`：`PLANTUML_SOURCE_MAX` / `hostOf` / `renderPlantuml`。

## 3. 守卫与用例

- **改 import 的用例**：`rfc247-api-docs`、`rfc208-boot-and-external-timeouts`、`plantuml-proxy`；`rfc344-operation-catalog`
  读源码的一处改读新位置。
- **架构报告**：legacy 归属表删去三个 `services/` 文件（platform 下的新文件按前缀归 platform）。
- **新用例** `T/rfc441-platform-helpers-out-of-services.test.ts`：
  - 原文件不存在，新文件就位；`tokenAuditRetentionDays` 不再导出；
  - 源码里没有文件 import 三个旧路径（census 的 AST 提取，别名与相对路径都认，带负对照）；
  - 三个新文件不 import 模块与 legacy 目标前缀（`services/`、`routes/`、`ws/`、`mcp/`）；
  - `auth`、`docs`、`plantuml` 三个路由与 `mcp/`、`ws/` 下的文件不 import `services/`；
  - 开关的缺省与判定：未设置为开，显式 `false` 为关。
- **行为由既有用例覆盖**：RFC-247 API 文档与 `/.well-known/mcp`（含开关关闭时的文档体）、MCP 拒绝与令牌签发拒绝、PlantUML 代理
  （编码、回退链、错误 SVG 早停、超时）。

## 4. 账本与计数（实测为准）

- `architecture/commons-debt.json`、`architecture/guard-manifest.json`：不变。
- `architecture/counts.json`：`legacy-horizontal-files`、`legacy-service-implementations` 只降不升，不改。
- e2e 注释里的旧路径改指新位置，行号不变（`mcpSurface.ts` 的 1–21 改为 1–20）。`docs/audit-backlog.md` 是历史记录，不改。

## 5. 失败模式

- **漏改引用**：tsc 与新用例的「旧路径零引用」双重兜底。
- **注释行号漂移**：三个文件原样搬迁，只有 `mcpSurface.ts` 末尾删 5 行，e2e 注释同步改范围。

## 6. 测试策略

全部实现与用例写完后集中验证一次：

- 静态检查（`tsc`、eslint 两套配置、prettier）；
- 全量 SQLite；
- 导出仓库（含 PostgreSQL 真库）跑全部架构测试、受影响用例、路由错误码棘轮、API 合同覆盖与测试套件策略；
- P0 变异 lane。
