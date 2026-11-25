# RFC-581 技术设计

记号：`S/` = `packages/backend/src/`，`RC/` = resource-catalog 的模块目录。数字取 HEAD `8a0d8516e`。不改行为。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：resource-catalog 的 `inbound/http`；挂载函数经 `RC/composition.ts` 转出。被撤回的 public 声明落进 `application/skills/`、
  `application/plugins/` 与 `application/mcps/`。
- **承担的演进**：`routes/` → 模块 `inbound/` 的第六批；resource-catalog 的 public 面收窄 42 个只被这些路由用的符号。
- **不新增** DAG 之外的边：三个绑定对别的模块只取 identity-access 的授权类型（authority-type-only）。
- **留下的债**：绑定仍用 `routes/` 下的传输工具与 `@/auth/actor`；`agents` 与 `workgroups`。
- **偏离项**：无。

## 1. 文件去向与声明落位

| 原文件                | 新位置                            |
| --------------------- | --------------------------------- |
| `S/routes/mcps.ts`    | `RC/inbound/http/mcpRoutes.ts`    |
| `S/routes/skills.ts`  | `RC/inbound/http/skillRoutes.ts`  |
| `S/routes/plugins.ts` | `RC/inbound/http/pluginRoutes.ts` |

- 文件名取挂载函数名去掉 `mount`。`RC/composition.ts` 转出三个挂载函数；`server.ts` 的三条 import 并进 RFC-580 的那一条，挂载调用与顺序不变。
- 36 个声明逐字移动，形状不变（同 RFC-580 的工具：按 TypeScript 语法树取出声明，按用到的名字生成新文件的 import，清理 public 的 import，改写读者）：
  - `RC/application/skills/operationContracts.ts`（新建）：`SkillOperationDescriptors`（原 `public/operations`）、`SkillFileCommands`、
    `SkillVersionCommands`（原 `public/commands`）、`SkillZipImportParticipant`（原 `public/participants`）与 15 个输入 / 回执 / 提交类型（原 `public/types`）。
  - `RC/application/plugins/operationContracts.ts`（新建）：`PluginOperationDescriptors` 与九个输入 / 回执类型。
  - `RC/application/mcps/diagnosticsContracts.ts`（新建）：`McpDiagnosticsCommands`（原 `public/commands`）、`McpDiagnosticsQueries`（原
    `public/queries`）与五个输入 / 引用类型。
- 移走的技能合同还用到一个只在 public 里局部声明、别处不用的形状 `SkillJsonSubmission`，它随同移进技能合同文件（仍不转出）。
- 6 个转出删去：`McpProbeOperations`、`McpProbeReceipt` 的读者改取 `application/mcps/ports`；`McpRuntimeTest*` 四个的读者改取 `@agent-workflow/shared`。
  同一行里留下的 `McpDiagnosticsTranscript`（共享合同的别名）照旧转出。

## 2. 门、用例与文档

- 架构报告的 `LEGACY_BACKEND_FILE_OWNERS` 删去三行；`counts.json` 的 `legacy-horizontal-files` 上限 74 → 71。
- `rfc552` 的 `public/operations` 账本删去 `SkillOperationDescriptors` 与 `PluginOperationDescriptors`；`rfc305` 的 identity-access 消费者账本里 MCP 路由
  那一条改指新位置；ACL 写门守卫的委托表、`rfc222` 的删除确认清单、`rfc345` 的两张路由表与按路径读源码的用例改指新路径；读 public 文本找被移走
  声明的断言按意图改读落位文件。
- 发布注册表：`mcps` 与 `skillId` 的探测由 RFC-578 补正的 HTTP 面读法兜底，迁移后由它的回归用例确认仍认得出。
- 不改：描述过往迁移的注释；e2e 注释里的源码行号锚点（同 RFC-579 design §2）。
- 新增 `tests/rfc581-resource-catalog-mcp-skill-plugin-routes-into-inbound-boundary.test.ts`，登记 guard-manifest：① 三个旧路径不存在，`src` /
  `tests` / `scripts` 的全部说明符不再解析到它们（带负对照）；② 三个绑定对模块的 import 只取本模块与登记过的别的模块 public（带负对照）；③ public
  文件不再导出这 42 个名字，三个落位文件声明了 36 个；④ `server.ts` 从 composition 取三个挂载函数。

## 3. 检索与撤回的推算

同 RFC-578 design §3；推算在 `8a0d8516e` 的报告上做（RFC-580 的候选），边的角色一起核对。检索按 RFC-579 的教训：不截断、跨行匹配、包括
`packages/frontend/tests` 与 `packages/shared/tests`。

## 4. 失败模式

- **有人在旧路径重建文件或重新取它**：RFC-581 用例 ① 红，`legacy-horizontal-files` 也红。
- **撤回的符号又回到 public**：用例 ③ 红，`unconsumed-public-symbols-resource-catalog` 门也红。
- **绑定多取别的模块**：用例 ② 红。
- **`server.ts` 又从 `@/routes/` 取这些绑定**：用例 ④ 红。

## 5. 取舍（可推翻）

1. **三个一批**：做法与 RFC-580 相同，工具已经可复用。
2. **声明落到用到它们的 application 子目录**：技能、插件、MCP 诊断各一个文件。
3. **转出直接删**：它们的声明本来就在别处（模块的 `application/mcps/ports` 与共享合同），读者改取声明处即可。

## 6. 对 RFC-294 刷新后规则的对账

- **C10**：入站绑定进 owner 模块的 `inbound/http`，装配根经 composition 取。**C11**：resource-catalog 的 public 面收窄 42 个只被本模块用的符号。
  **C12**：RFC-581 用例 ① 覆盖 `src` / `tests` / `scripts` 的全部说明符；② ③ ④ 只读相关文件。**C13**：`legacy-horizontal-files` 74 → 71，其余计数不升。
- **留下的债**：`routes/` 余 23 个；路由传输工具归位；`agents` 与 `workgroups`；task-execution 等族。
