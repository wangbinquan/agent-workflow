# RFC-563 技术设计

落在 resource-catalog（`application/ports` 与两个 infrastructure 文件）与 source-control（一个 infrastructure 文件）；bootstrap、task-execution 与
runtime-management 不改代码。另改两份精确清单、`PUBLIC_SURFACE_DEBT` 的一条记名、`architecture/counts.json` 与新增一个 RFC-563 用例；顺带给
RFC-561 / RFC-562 / RFC-563 三个边界用例的 import 判据补上类型位置的 `import('…')`。数字取 HEAD `b3850ff9a`。不改行为。

## 1. 改动

| 位置                                                                     | 做法                                                                                                                                                                                                 |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| resource-catalog `application/ports/taskAgentMaterialReferences.ts`      | 新增 `TaskAgentResourceContentReference`（`owner: 'resource-catalog'`、`reference`、`version`）、`TaskAgentSkillMaterial`、`TaskAgentPluginMaterial`；`TaskAgentResourceMaterial` 的两个清单改用它们 |
| resource-catalog `infrastructure/local/taskAgentMaterialReferences.ts`   | 发出的引用与材料用上面的类型标注；查找内容的两个方法收“带 `content` 的对象”（按引用对象的身份查，原来就是 WeakMap）                                                                                  |
| resource-catalog `infrastructure/crewstation/crewstationNativePlugin.ts` | 入参写成本模块的形状（声明的 `id / name / options` 与一条任意 owner 的内容引用；owner 不是自己时照旧拒绝）                                                                                           |
| source-control `infrastructure/local/taskAgentWorkspaceContents.ts`      | 读入的引用只要 `reference`；发出的挂载引用是 `{ owner: 'source-control', reference, version: null }`                                                                                                 |

入参一律写得比材料意图宽、出参写得更具体：bootstrap 把它们绑到 task-execution 的 `NativeTaskAgentMaterialReferences` / `NativeTaskAgentWorkspaceContents`、
task-execution 把材料放进意图，都是“更具体的值交给更宽的位置”，不靠方法参数双变。

## 2. 门与用例

- 精确清单：`rfc376-structural-guards` 的 `off-dag-offered-file-context-pairs` 与 `rfc294-review-offered-edge-dag` 的 `OFF_DAG_OFFERED_EDGE_DEBT` 删去 4 条，
  `counts.json` 11 → 7。
- public 类型偏差：`PUBLIC_SURFACE_DEBT` 按“第一个够到该声明的 public 根”记名。意图里的 `Logger` 原先由 resource-catalog 的
  `TaskAgentMaterialReferences`（public）最先够到；它不再点名意图后，同一处偏差改由 runtime-management 自己的 `AgentMaterialCompiler` 根够到——条目
  换成后者，条数不变（56）。
- 新增 `tests/rfc563-content-reference-own-shapes-boundary.test.ts`，登记 guard-manifest：① source-control 全部源码不取 runtime-management，
  resource-catalog 取它的只剩 MCP 诊断的两处与指定 adapter（带负对照）；② 端口文件的导出名单与两个 owner 的形状；③ 编译期断言：材料清单、单条材料、
  本机引用实现、工作区内容与托管插件读取都能与意图 / 本机端口对上。

## 3. 失败模式

- **材料意图改了技能 / 插件 / 引用的形状**：RFC-563 用例的编译期断言与 task-execution 里把材料放进意图的地方报类型错误。
- **两个 owner 重新按名字取 runtime-management**：RFC-563 用例 ① 与两份精确清单同红。

## 4. 取舍（可推翻）

1. **owner 自己声明形状，而不是经 runtime-management 的 required-ports + 指定 adapter 取意图类型**：这些引用与材料是 owner 发出并解释的值，不是
   owner 去实现 runtime-management 的某个端口；它们的对象绑的是 task-execution 的本机端口。形状很小（三个字段的引用、两条材料），自己声明后
   resource-catalog 的 public 也不再把整份意图带进来。
2. **入参写宽、出参写具体**：`plugin(reference)` / `skill(reference)` 只按引用对象的身份查，入参就是“带 `content` 的对象”；托管插件读取在函数体里
   检查 owner，入参的 owner 就写成 `string`。这样结构绑定在严格方向上成立。
3. **MCP 诊断不在本 RFC**：它的端口里是诊断请求（意图的八个字段）、事件接收与用量快照，形状大得多，归属要单独定。

## 5. 对 RFC-294 刷新后规则的对账

- **C10**：形状归发出它的 owner（resource-catalog 的在 `application/ports`，source-control 的是实现文件内部的两个接口）。**C11**：两个 context 的 public
  导出名单不变；resource-catalog 的 `TaskAgentResourceMaterial` 不再够到意图，意图的日志器偏差回到它 owner 的根上。**C12**：RFC-563 用例覆盖两个
  context 的全部源码、形状与结构绑定。**C13**：DAG 外 offered 边 11 → 7，其余计数不升（public 类型偏差仍是 56）；目标 DAG 不变。
- **留下的债**：resource-catalog 的 MCP 诊断两处；其余 5 条 DAG 外 offered 边。
