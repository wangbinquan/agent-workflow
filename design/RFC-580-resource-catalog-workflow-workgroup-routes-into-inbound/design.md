# RFC-580 技术设计

记号：`S/` = `packages/backend/src/`，`RC/` = resource-catalog 的模块目录。数字取 HEAD `ad64ba6e5`。不改行为。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：resource-catalog 的 `inbound/http`（本 RFC 新建）；挂载函数经 `RC/composition.ts` 转出。被撤回的 public 声明按用途落进
  `application/workflows/`、`application/workgroups/` 与 `domain/`。
- **承担的演进**：`routes/` → 模块 `inbound/` 的第五批；resource-catalog 的 public 面收窄 22 个只被这些路由用的声明。
- **不新增** DAG 之外的边：三个绑定对别的模块只取 identity-access 的授权类型（资源包路由，authority-type-only）。`workgroups` 因此暂留（proposal §1）。
- **留下的债**：绑定仍用 `routes/registry`、`routes/operationRoute`、`routes/operationAuthority`、`routes/resourceAcl` 与 `@/auth/actor`，随传输工具归位
  另立；`workgroups` 与代理、MCP、技能、插件四个路由等 resource-catalog → task-execution 那条边的决定。
- **偏离项**：无。

## 1. 文件去向与声明落位

| 原文件                         | 新位置                                     |
| ------------------------------ | ------------------------------------------ |
| `S/routes/workflows.ts`        | `RC/inbound/http/workflowRoutes.ts`        |
| `S/routes/workgroupTasks.ts`   | `RC/inbound/http/workgroupTaskRoutes.ts`   |
| `S/routes/resourcePackages.ts` | `RC/inbound/http/resourcePackageRoutes.ts` |

- 文件名取挂载函数名去掉 `mount` / `register`。`RC/composition.ts` 转出三个挂载函数；`server.ts` 的三条 import 合为一条从那里取，挂载调用与顺序不变。
- 22 个声明（按 RFC-578 design §3 的口径算到不动点）逐字移动，形状不变：
  - `RC/application/workflows/operationContracts.ts`（新建）：`WorkflowOperationDescriptors`（原 `public/operations`）与工作流的四个输入、两个回执
    （原 `public/types`）。
  - `RC/application/workgroups/taskRoomContracts.ts`（新建）：`WorkgroupTaskRoomModule`（原 `public/operations`）、`WorkgroupTaskRoomCommands`（原
    `public/commands`）、`WorkgroupTaskRoomQueries`（原 `public/queries`）与 11 个提交 / 回执类型（原 `public/types`）。
  - `PackageResourceKind`：`RC/domain/resourceKinds.ts` 本来就有一份相同的声明（`= BundleResourceType`），public 里那份删去，读者改取 domain；public
    里仍在的 `PackageResourceRef` 的类型参数改按共享合同 `BundleResourceType` 约束（与原来等价）。
- 移走的工作流合同还用到两个原本只在 public 文件里局部声明的形状：`ResourceAclOperationDescriptors`（每个受 ACL 管的资源的描述合同都扩展它）与
  `JsonBodySubmission`（封闭的 JSON 请求体）。两者改为就地 `export`，新文件从 public 取；留在 public 的描述合同与输入类型照旧用它们，它们因此有
  类型消费者，不算未消费。
- 新文件的 import 按声明里用到的名字生成；public 文件删去声明后清掉不再用的 import；本模块与用例里经 public 取这些名字的读者改取新位置（工具按
  TypeScript 语法树改写，再过 prettier）。

## 2. 门、用例与文档

- 架构报告的 `LEGACY_BACKEND_FILE_OWNERS` 删去三行；`counts.json` 的 `legacy-horizontal-files` 上限 77 → 74。
- `rfc552` 的 `public/operations` 账本删去 `WorkflowOperationDescriptors` 与 `WorkgroupTaskRoomModule`、登记 `ResourceAclOperationDescriptors`；`rfc305` 的
  identity-access 消费者账本里资源包路由那一条改指新位置；ACL 写门守卫的委托表、`rfc345` 的两张路由表（改成相对 `src` 的路径）与按路径读源码的用例
  改指新路径；`rfc345` 里读 public 文件找房间封套、模块合同与工作流删除回执的三处断言改读落位文件，并断言 public 里不再有它们；直接 import 旧路径的
  用例由搬迁脚本改说明符。
- 发布注册表：三个路由都不是它的探测对象，不用改。
- 不改：描述过往迁移的注释；e2e 注释里的源码行号锚点（同 RFC-579 design §2）。
- 新增 `tests/rfc580-resource-catalog-workflow-workgroup-routes-into-inbound-boundary.test.ts`，登记 guard-manifest：① 三个旧路径不存在，`src` /
  `tests` / `scripts` 的全部说明符不再解析到它们（带负对照）；② 三个绑定对模块的 import 只取本模块（别名只到本模块 public，相对路径只到本模块
  application / domain / public）与登记过的别的模块 public（带负对照）；③ 四个 public 文件不再导出这 22 个名字，三个落位文件声明了它们；④ `server.ts`
  从 composition 取三个挂载函数。

## 3. 检索与撤回的推算

同 RFC-578 design §3；推算在 `58ab43d1f` 的报告上做，按路由逐个与成组推算。推算里“绑定的依赖都在 DAG 里”的判断要看边的**角色**：取别的模块的
offered public 要有 offered-consumption 边，只有 required-implementation 不算（第一次实施时没看角色，`workgroups` 因此被带进来，集中验证时撞上
`rfc294-review-offered-edge-dag`）。检索按 RFC-579 的教训不截断输出、另搜按名字拼的路径与 `packages/frontend/tests`。

## 4. 失败模式

- **有人在旧路径重建文件或重新取它**：RFC-580 用例 ① 红，`legacy-horizontal-files` 也红。
- **撤回的声明又回到 public**：用例 ③ 红，`unconsumed-public-symbols-resource-catalog` 门也红。
- **绑定多取别的模块**：用例 ② 红；取 task-execution 的 offered public 时 `rfc294-review-offered-edge-dag` 也红。
- **`server.ts` 又从 `@/routes/` 取这些绑定**：用例 ④ 红。

## 5. 取舍（可推翻）

1. **resource-catalog 分批**：一次迁八个要动 86 个声明；本批三个、内聚，推算也容易核对。
2. **`workgroups` 暂留**（proposal §1）：补 DAG 边、改 consumer-owned 端口或换落位都是总纲层面的决定，不在本 RFC 里自作主张。
3. **两个共用形状就地转出，不另起内部文件**：第一次实施时把它们挪进 `application/catalogOperationParts.ts`，`rfc345-provider-neutral-classic-facades`
   不许 `public/operations` 取 application，于是改为就地 `export`——它们本来就是 public 里留着的合同的组成部分。
4. **声明落到用到它们的 application 子目录**：工作流与任务房间各一个文件，与已有的 `application/workflows/`、`application/workgroups/` 放在一起。

## 6. 对 RFC-294 刷新后规则的对账

- **C10**：入站绑定进 owner 模块的 `inbound/http`，装配根经 composition 取。**C11**：resource-catalog 的 public 面收窄 22 个只被本模块用的声明。
  **C12**：RFC-580 用例 ① 覆盖 `src` / `tests` / `scripts` 的全部说明符；② ③ ④ 只读相关文件。**C13**：`legacy-horizontal-files` 77 → 74，其余计数不升。
- **留下的债**：`routes/` 余 26 个；路由传输工具归位；`workgroups` 与代理、MCP、技能、插件的路由（等 resource-catalog → task-execution 那条边的决定）；
  task-execution 等族。
